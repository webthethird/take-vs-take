import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { tiingoSource } from "../src/lib/tiingo.js";

const TOKEN = "test-token-0123456789abcdef";

// Shape copied from a live response (SPY, 2026-09-25), trimmed to used fields
// plus a couple we ignore.
function tbar(date: string, close: number, extra: Record<string, number> = {}) {
  return { date: `${date}T00:00:00.000Z`, close, open: close, volume: 1000, adjClose: close, divCash: 0, splitFactor: 1, ...extra };
}

type Call = { url: string; init: RequestInit | undefined };

function mockFetch(responses: (Response | Error)[]) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    if (next === undefined) throw new Error("mockFetch: no more responses");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { fn, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const noSleep = { sleep: async () => {} };

function src(responses: (Response | Error)[], opts: Partial<Parameters<typeof tiingoSource>[0]> = {}) {
  const m = mockFetch(responses);
  const s = tiingoSource({ token: TOKEN, fetch: m.fn, now: () => new Date("2026-10-19T12:00:00Z"), ...noSleep, ...opts });
  return { s, calls: m.calls };
}

describe("tiingoSource: success", () => {
  it("parses bars, strips the time, and records provenance", async () => {
    const { s } = src([json([tbar("2026-09-25", 771.35), tbar("2026-09-28", 765.61, { divCash: 1.5 })])]);
    const r = await s.daily("SPY", "2026-09-25", "2026-09-28");
    assert.ok(r.ok, !r.ok ? r.message : "");
    if (!r.ok) return;
    assert.deepEqual(r.value.bars, [
      { date: "2026-09-25", close: 771.35, adjClose: 771.35, divCash: 0, splitFactor: 1 },
      { date: "2026-09-28", close: 765.61, adjClose: 765.61, divCash: 1.5, splitFactor: 1 },
    ]);
    assert.equal(r.value.source, "tiingo");
    assert.equal(r.value.fetched_at, "2026-10-19T12:00:00.000Z");
  });

  it("maps share classes to Tiingo's dash form and keeps the token out of the URL", async () => {
    const { s, calls } = src([json([])]);
    await s.daily("brk.b", "2026-09-25", "2026-09-28");
    assert.equal(calls[0]!.url, "https://api.tiingo.com/tiingo/daily/BRK-B/prices?startDate=2026-09-25&endDate=2026-09-28");
    assert.ok(!calls[0]!.url.includes(TOKEN));
    assert.equal((calls[0]!.init!.headers as Record<string, string>).Authorization, `Token ${TOKEN}`);
  });

  it("accepts an empty range (e.g. a weekend)", async () => {
    const { s } = src([json([])]);
    const r = await s.daily("SPY", "2026-09-26", "2026-09-27");
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.value.bars.length, 0);
  });
});

describe("tiingoSource: errors", () => {
  const cases: [string, Response, string][] = [
    ["404", json({ detail: "Not found." }, 404), "not_found"],
    ["401", json({ detail: "Invalid token." }, 401), "unauthorized"],
    ["403", json({}, 403), "unauthorized"],
    ["400", json({ detail: "Error: startDate cannot be after endDate" }, 400), "invalid_request"],
    ["418", json({}, 418), "network"],
  ];
  for (const [name, res, error] of cases) {
    it(`HTTP ${name} -> ${error}, no retry`, async () => {
      const { s, calls } = src([res]);
      const r = await s.daily("SPY", "2026-09-25", "2026-09-28");
      assert.equal(r.ok, false);
      if (!r.ok) {
        assert.equal(r.error, error);
        assert.ok(!r.message.includes(TOKEN));
      }
      assert.equal(calls.length, 1);
    });
  }

  it("400 surfaces Tiingo's detail message", async () => {
    const { s } = src([json({ detail: "Error: startDate cannot be after endDate" }, 400)]);
    const r = await s.daily("SPY", "2026-09-25", "2026-09-28");
    if (!r.ok) assert.match(r.message, /startDate cannot be after endDate/);
  });

  it("429 is not retried: the quota is spent", async () => {
    const { s, calls } = src([json({}, 429), json([])]);
    const r = await s.daily("SPY", "2026-09-25", "2026-09-28");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, "rate_limited");
    assert.equal(calls.length, 1);
  });

  it("retries 5xx with backoff, then succeeds", async () => {
    const sleeps: number[] = [];
    const { s, calls } = src([json({}, 503), json({}, 502), json([tbar("2026-09-25", 1)])], {
      sleep: async (ms) => void sleeps.push(ms),
    });
    const r = await s.daily("SPY", "2026-09-25", "2026-09-28");
    assert.ok(r.ok);
    assert.equal(calls.length, 3);
    assert.deepEqual(sleeps, [500, 1000]);
  });

  it("gives up after retries on persistent network failure", async () => {
    const timeout = Object.assign(new Error("aborted"), { name: "TimeoutError" });
    const { s, calls } = src([timeout, timeout, timeout, json([])]);
    const r = await s.daily("SPY", "2026-09-25", "2026-09-28");
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error, "network");
      assert.match(r.message, /TimeoutError/);
    }
    assert.equal(calls.length, 3);
  });

  it("returns 5xx as network once retries are exhausted", async () => {
    const { s, calls } = src([json({}, 500), json({}, 500), json({}, 500)]);
    const r = await s.daily("SPY", "2026-09-25", "2026-09-28");
    if (!r.ok) assert.equal(r.error, "network");
    assert.equal(calls.length, 3);
  });
});

describe("tiingoSource: response validation", () => {
  const bad: [string, unknown][] = [
    ["not an array", { detail: "x" }],
    ["missing adjClose", [{ date: "2026-09-25T00:00:00.000Z", close: 1, divCash: 0, splitFactor: 1 }]],
    ["zero price", [tbar("2026-09-25", 0)]],
    ["negative dividend", [tbar("2026-09-25", 1, { divCash: -1 })]],
    ["bar outside range", [tbar("2026-09-24", 1)]],
    ["unordered bars", [tbar("2026-09-28", 1), tbar("2026-09-25", 1)]],
  ];
  for (const [name, body] of bad) {
    it(`${name} -> bad_response`, async () => {
      const { s } = src([json(body)]);
      const r = await s.daily("SPY", "2026-09-25", "2026-09-28");
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.error, "bad_response");
    });
  }

  it("non-JSON body -> bad_response", async () => {
    const { s } = src([new Response("<html>oops</html>", { status: 200 })]);
    const r = await s.daily("SPY", "2026-09-25", "2026-09-28");
    if (!r.ok) assert.equal(r.error, "bad_response");
    else assert.fail("expected failure");
  });
});

describe("tiingoSource: limits and input", () => {
  it("enforces the per-process request cap before calling fetch", async () => {
    const { s, calls } = src([json([]), json([]), json([])], { maxRequests: 2 });
    await s.daily("SPY", "2026-09-25", "2026-09-28");
    await s.daily("QQQ", "2026-09-25", "2026-09-28");
    const r = await s.daily("IWM", "2026-09-25", "2026-09-28");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, "budget_exceeded");
    assert.equal(calls.length, 2);
  });

  it("retries count against the cap", async () => {
    const { s, calls } = src([json({}, 500), json({}, 500), json([])], { maxRequests: 2 });
    const r = await s.daily("SPY", "2026-09-25", "2026-09-28");
    if (!r.ok) assert.equal(r.error, "budget_exceeded");
    else assert.fail("expected failure");
    assert.equal(calls.length, 2);
  });

  it("rejects bad dates and tickers without a request", async () => {
    const { s, calls } = src([]);
    assert.equal((await s.daily("SPY", "2026-09-28", "2026-09-25")).ok, false);
    assert.equal((await s.daily("SPY", "yesterday", "2026-09-25")).ok, false);
    assert.equal((await s.daily("SP Y", "2026-09-25", "2026-09-28")).ok, false);
    assert.equal((await s.daily("../etc", "2026-09-25", "2026-09-28")).ok, false);
    assert.equal(calls.length, 0);
  });

  it("refuses to construct without a token", () => {
    assert.throws(() => tiingoSource({ token: "" }), /TIINGO_API_TOKEN/);
  });
});
