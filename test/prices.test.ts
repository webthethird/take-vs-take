import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  LookAheadGate,
  cachedSource,
  checkBars,
  etDate,
  fixtureSource,
  validateRange,
  type PriceBar,
  type PriceSource,
} from "../src/lib/prices.js";

function bar(date: string, close = 100): PriceBar {
  return { date, close, adjClose: close, divCash: 0, splitFactor: 1 };
}

const SPY = ["2026-09-24", "2026-09-25", "2026-09-28", "2026-09-29", "2026-09-30"].map((d, i) => bar(d, 100 + i));

describe("etDate", () => {
  it("converts to the US/Eastern calendar date", () => {
    // 14:03 UTC is 10:03 EDT, same day.
    assert.equal(etDate(new Date("2026-09-28T14:03:11Z")), "2026-09-28");
    // 02:00 UTC on the 29th is 22:00 EDT on the 28th.
    assert.equal(etDate(new Date("2026-09-29T02:00:00Z")), "2026-09-28");
  });

  it("handles the spring-forward boundary (2026-03-08, EST -> EDT)", () => {
    assert.equal(etDate(new Date("2026-03-08T04:59:59Z")), "2026-03-07"); // 23:59:59 EST
    assert.equal(etDate(new Date("2026-03-08T05:00:00Z")), "2026-03-08"); // 00:00 EST
  });

  it("handles the fall-back boundary (2026-11-01, EDT -> EST)", () => {
    assert.equal(etDate(new Date("2026-11-01T03:59:59Z")), "2026-10-31"); // 23:59:59 EDT
    assert.equal(etDate(new Date("2026-11-01T04:00:00Z")), "2026-11-01"); // 00:00 EDT
  });
});

describe("validateRange / checkBars", () => {
  it("rejects malformed and inverted ranges", () => {
    assert.equal(validateRange("2026-09-01", "2026-09-30").ok, true);
    assert.equal(validateRange("2026-09-01", "2026-09-01").ok, true);
    assert.equal(validateRange("2026-9-1", "2026-09-30").ok, false);
    assert.equal(validateRange("2026-09-30", "2026-09-01").ok, false);
    assert.equal(validateRange("2026-13-01", "2026-13-02").ok, false);
  });

  it("flags out-of-range, duplicate and unordered bars", () => {
    assert.equal(checkBars(SPY, "2026-09-24", "2026-09-30"), null);
    assert.match(checkBars(SPY, "2026-09-25", "2026-09-30")!, /outside/);
    assert.match(checkBars([bar("2026-09-25"), bar("2026-09-25")], "2026-09-01", "2026-09-30")!, /increasing/);
    assert.match(checkBars([bar("2026-09-26"), bar("2026-09-25")], "2026-09-01", "2026-09-30")!, /increasing/);
  });
});

describe("fixtureSource", () => {
  it("filters to the inclusive range and resolves share-class spellings", async () => {
    const src = fixtureSource({ SPY, "BRK-B": SPY });
    const r = await src.daily("spy", "2026-09-25", "2026-09-29");
    assert.ok(r.ok);
    if (r.ok) assert.deepEqual(r.value.bars.map((b) => b.date), ["2026-09-25", "2026-09-28", "2026-09-29"]);
    assert.ok((await src.daily("BRK.B", "2026-09-24", "2026-09-30")).ok);
  });

  it("returns not_found for unknown tickers", async () => {
    const r = await fixtureSource({ SPY }).daily("QQQ", "2026-09-24", "2026-09-30");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, "not_found");
  });
});

describe("cachedSource", () => {
  const dirs: string[] = [];
  const freshDir = async () => {
    const d = await mkdtemp(join(tmpdir(), "tvt-cache-"));
    dirs.push(d);
    return d;
  };
  after(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it("fetches once, then serves the pinned series", async () => {
    const inner = fixtureSource({ SPY });
    const cache = cachedSource(inner, await freshDir());
    const a = await cache.daily("SPY", "2026-09-24", "2026-09-30");
    const b = await cache.daily("SPY", "2026-09-24", "2026-09-30");
    assert.equal(inner.calls, 1);
    assert.equal(cache.hits, 1);
    assert.deepEqual(a, b);
  });

  it("serves the cached series even if the provider's data changes", async () => {
    // Pinning is the point: a rerun must read the same bars.
    const dir = await freshDir();
    await cachedSource(fixtureSource({ SPY }), dir).daily("SPY", "2026-09-24", "2026-09-30");
    const changed = fixtureSource({ SPY: SPY.map((b) => ({ ...b, adjClose: b.adjClose * 0.99 })) });
    const r = await cachedSource(changed, dir).daily("SPY", "2026-09-24", "2026-09-30");
    assert.equal(changed.calls, 0);
    if (r.ok) assert.equal(r.value.bars[0]!.adjClose, 100);
  });

  it("refetches an entry fetched on or before its own end date (ET), which may lack that day's close", async () => {
    const dir = await freshDir();
    // 2026-09-30 20:30 ET: the end date itself, after the close but perhaps before the data landed.
    await cachedSource(fixtureSource({ SPY }, "2026-10-01T00:30:00.000Z"), dir).daily("SPY", "2026-09-24", "2026-09-30");
    const next = fixtureSource({ SPY }, "2026-10-01T14:00:00.000Z");
    const cache = cachedSource(next, dir);
    await cache.daily("SPY", "2026-09-24", "2026-09-30");
    assert.equal(next.calls, 1, "fetched on the end date: a miss");
    const later = fixtureSource({ SPY });
    await cachedSource(later, dir).daily("SPY", "2026-09-24", "2026-09-30");
    assert.equal(later.calls, 0, "fetched the day after: served from cache");
  });

  it("keys on the exact range; never splices", async () => {
    const inner = fixtureSource({ SPY });
    const cache = cachedSource(inner, await freshDir());
    await cache.daily("SPY", "2026-09-24", "2026-09-30");
    await cache.daily("SPY", "2026-09-25", "2026-09-30");
    assert.equal(inner.calls, 2);
  });

  it("refresh re-fetches", async () => {
    const dir = await freshDir();
    const inner = fixtureSource({ SPY });
    await cachedSource(inner, dir).daily("SPY", "2026-09-24", "2026-09-30");
    await cachedSource(inner, dir, { refresh: true }).daily("SPY", "2026-09-24", "2026-09-30");
    assert.equal(inner.calls, 2);
  });

  it("does not cache errors", async () => {
    const inner = fixtureSource({ SPY });
    const cache = cachedSource(inner, await freshDir());
    await cache.daily("QQQ", "2026-09-24", "2026-09-30");
    await cache.daily("QQQ", "2026-09-24", "2026-09-30");
    assert.equal(inner.calls, 2);
  });

  it("treats a corrupt cache file as a miss and leaves no temp files", async () => {
    const dir = await freshDir();
    const inner = fixtureSource({ SPY });
    await cachedSource(inner, dir).daily("SPY", "2026-09-24", "2026-09-30");
    const sub = join(dir, "fixture", "SPY");
    const [file] = await readdir(sub);
    await writeFile(join(sub, file!), "{not json");
    const r = await cachedSource(inner, dir).daily("SPY", "2026-09-24", "2026-09-30");
    assert.ok(r.ok);
    assert.equal(inner.calls, 2);
    assert.deepEqual((await readdir(sub)).filter((f) => f.endsWith(".tmp")), []);
  });
});

describe("LookAheadGate", () => {
  const cutoff = new Date("2026-09-28T14:03:11Z"); // 10:03 ET, Monday

  it("blocks any range reaching the cutoff's ET date", async () => {
    const gate = new LookAheadGate(fixtureSource({ SPY }), cutoff);
    assert.equal(gate.blockedFrom, "2026-09-28");
    const r = await gate.daily("SPY", "2026-09-24", "2026-09-28");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, "look_ahead");
  });

  it("allows ranges ending before the cutoff date", async () => {
    const gate = new LookAheadGate(fixtureSource({ SPY }), cutoff);
    const r = await gate.daily("SPY", "2026-09-24", "2026-09-27");
    assert.ok(r.ok);
    if (r.ok) assert.deepEqual(r.value.bars.map((b) => b.date), ["2026-09-24", "2026-09-25"]);
  });

  it("uses the ET date: a 22:00 ET post blocks its own day, not the next", async () => {
    const gate = new LookAheadGate(fixtureSource({ SPY }), new Date("2026-09-29T02:00:00Z"));
    assert.equal(gate.blockedFrom, "2026-09-28");
  });

  it("drops post-cutoff bars even if the inner source returns them", async () => {
    const leaky: PriceSource = {
      name: "leaky",
      async daily(ticker, start, end) {
        return { ok: true, value: { ticker, source: "leaky", start, end, fetched_at: "2026-01-01T00:00:00.000Z", bars: SPY } };
      },
    };
    const r = await new LookAheadGate(leaky, cutoff).daily("SPY", "2026-09-24", "2026-09-27");
    assert.ok(r.ok);
    if (r.ok) assert.ok(r.value.bars.every((b) => b.date < "2026-09-28"));
  });

  it("wraps the cache: cached post-cutoff data can't leak", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tvt-gate-"));
    try {
      const cache = cachedSource(fixtureSource({ SPY }), dir);
      await cache.daily("SPY", "2026-09-24", "2026-09-30"); // warm with outcome data
      const r = await new LookAheadGate(cache, cutoff).daily("SPY", "2026-09-24", "2026-09-30");
      assert.equal(r.ok, false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("unlock requires frozen runs with past frozen_at", () => {
    const now = new Date("2026-10-19T12:00:00Z");
    const gate = new LookAheadGate(fixtureSource({ SPY }), cutoff);
    assert.equal(gate.unlock([], now).ok, false);
    assert.equal(gate.unlock([{ run_id: "", frozen_at: "2026-10-19T11:00:00Z" }], now).ok, false);
    assert.equal(gate.unlock([{ run_id: "a", frozen_at: "not a date" }], now).ok, false);
    assert.equal(gate.unlock([{ run_id: "a", frozen_at: "2026-10-19T13:00:00Z" }], now).ok, false);
    assert.equal(gate.unlocked, false);
  });

  it("passes everything through once unlocked", async () => {
    const gate = new LookAheadGate(fixtureSource({ SPY }), cutoff);
    const u = gate.unlock(
      [{ run_id: "a", frozen_at: "2026-10-19T11:00:00Z" }, { run_id: "b", frozen_at: "2026-10-19T11:00:01Z" }],
      new Date("2026-10-19T12:00:00Z"),
    );
    assert.ok(u.ok);
    const r = await gate.daily("SPY", "2026-09-24", "2026-09-30");
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.value.bars.length, 5);
  });
});
