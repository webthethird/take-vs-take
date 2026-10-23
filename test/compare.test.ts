import assert from "node:assert/strict";
import { access, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { DRIVERS_SYSTEM, FIDELITY_SYSTEM, compare, fidelityShares, findings, pickDefault, type ComparisonReport } from "../src/lib/compare.js";
import { authorNamed } from "../src/lib/readings.js";
import type { Portfolio } from "../src/lib/weights.js";
import type { LlmConfig } from "../src/lib/llm.js";
import { fixtureSource, type PriceBar, type PriceSource } from "../src/lib/prices.js";
import { PostInput, type Fidelity, type PortfolioDraft, type SharedDrivers, type ThesisAlignment, type ThesisAnalysis } from "../src/lib/schema.js";
import { scripted, withVoice } from "./llm.test.js";

// ── Synthetic world ──────────────────────────────────────────────────────

const days: string[] = [];
for (let d = new Date("2025-05-01T12:00:00Z"); d < new Date("2026-10-17T12:00:00Z"); d.setUTCDate(d.getUTCDate() + 1)) {
  if (d.getUTCDay() % 6 !== 0) days.push(d.toISOString().slice(0, 10));
}
function walk(seed: number, beta: number, market: number[]): PriceBar[] {
  let a = seed;
  let p = 100;
  return days.map((date, i) => {
    a = (a * 48271) % 2147483647;
    if (i > 0) p *= 1 + beta * market[i - 1]! + (a / 2147483647 - 0.5) * 0.02;
    return { date, close: p, adjClose: p, divCash: 0, splitFactor: 1 };
  });
}
const market = (() => {
  let a = 7;
  return days.map(() => ((a = (a * 48271) % 2147483647) / 2147483647 - 0.5) * 0.02);
})();
const data: Record<string, PriceBar[]> = { SPY: walk(1, 1, market) };
["RA", "RB", "RC", "RD", "TA", "TB", "TC", "TD", "FA", "FB", "FC", "FD"].forEach((t, i) => (data[t] = walk(100 + i, i < 4 ? 1.2 : i < 8 ? -0.5 : 0.8, market)));

const post = (id: string, handle: string, created_at: string, text: string) =>
  PostInput.parse({
    post_id: id,
    url: `https://x.com/${handle}/status/${id}`,
    author_handle: handle,
    text,
    created_at,
    provenance: { source: "fixture_manual", text_verified: false, retrieved_at: "2026-10-19T00:00:00.000Z" },
  });
const postA = post("2073083956950388894", "alice_author", "2026-07-03T16:38:26.031Z", "Rails will win the reshoring boom. Buy the railroads.");
const postB = post("2077671967671357765", "bob_author", "2026-07-16T08:29:33.028Z", "Trucking will win the reshoring boom. Buy the truckers.");

const analysis = (claim: string, quote: string): ThesisAnalysis => ({
  evidence: [quote],
  economic_claim: claim,
  direction: "bullish",
  subjects: [claim],
  targets: [],
  horizon: null,
  missing: [],
  interpretations: [{ id: "i1", label: claim, expression: claim, author_stated: true, gap_note: "" }],
  default_interpretation: "i1",
  status: "investable",
  status_reason: "clear",
});
const draft = (tickers: string[]): PortfolioDraft => ({
  interpretation_id: "x",
  title: "t",
  long_only_note: "",
  exclusions: [],
  concentration: "concentrated",
  cash_level: "standard",
  cash_reason: "r",
  buckets: [{ name: "B", rationale: "" }],
  positions: tickers.map((ticker) => ({ ticker, role: "r", bucket: "B", rationale: "", tier: "core" as const })),
});
const alignment: ThesisAlignment = { a_claim: "rails", b_claim: "trucks", shared_subjects: ["reshoring"], reasoning: "They back rival modes.", relationship: "opposing", confidence: "medium" };
const drivers: SharedDrivers = {
  shared: [{ driver: "US freight volumes", a: "railroads haul it", b: "truckers haul it" }],
  differences: [{ driver: "diesel prices", a: "minor cost", b: "major cost" }],
  expected_daily_co_movement: "together",
  summary: "Both are bets on US freight volumes; they differ on which mode wins.",
  confidence: "medium",
};

const fid = (tickers: string[]): Fidelity => ({
  holdings: tickers.map((ticker, i) => ({ ticker, link: i === 0 ? "named" : "direct", stands_for: "", note: "" })),
  not_investable: [],
  summary: "Close to the post.",
});
const fidA = fid(["RA", "RB", "RC", "RD"]);
const fidB = fid(["TA", "TB", "TC", "TD"]);

const dirs: string[] = [];
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function setup(responses: unknown[], source?: PriceSource, voices: unknown[] = []) {
  const d = await mkdtemp(join(tmpdir(), "tvt-cmp-"));
  dirs.push(d);
  const t = withVoice(scripted(responses.map((parsed) => ({ parsed }))), voices);
  const llm: LlmConfig = { transport: t, budgetUsd: 5, cacheDir: join(d, "llm"), ledgerPath: join(d, "ledger.jsonl") };
  const reads: { ticker: string; start: string; end: string }[] = [];
  const base = source ?? fixtureSource(data);
  const prices: PriceSource = {
    name: "spy",
    async daily(ticker, start, end) {
      reads.push({ ticker, start, end });
      // The invariant: outcome prices are only read once both sides are frozen.
      if (end >= "2026-07-16") {
        const dir = join(d, "out");
        const { readdir } = await import("node:fs/promises");
        const sub = (await readdir(dir))[0]!;
        await access(join(dir, sub, "frozen-a.json"));
        await access(join(dir, sub, "frozen-b.json"));
      }
      return base.daily(ticker, start, end);
    },
  };
  // One drivers sample keeps the scripted response lists short; sampling has its own tests.
  return { t, reads, deps: { llm, prices, outDir: join(d, "out"), end: "2026-10-16", now: () => new Date("2026-10-19T12:00:00Z"), driversSamples: 1 } };
}

const happy = [
  analysis("rails", "Buy the railroads."),
  draft(["RA", "RB", "RC", "RD"]),
  analysis("trucks", "Buy the truckers."),
  draft(["TA", "TB", "TC", "TD"]),
  alignment,
  drivers,
  fidA,
  fidB,
];

describe("compare", () => {
  it("caches calls carrying X-fetched content in the expiring cache, and only those", async () => {
    const { deps } = await setup(happy);
    const fromX = { ...postB, provenance: { source: "x_api" as const, text_verified: true, retrieved_at: "2026-10-19T00:00:00.000Z" } };
    const r = await compare(deps, postA, fromX);
    assert.ok(r.ok, !r.ok ? r.message : "");
    const files = async (d: string) => (await readdir(d)).filter((f) => f.endsWith(".json"));
    // A (a saved fixture): analysis, voice, draft, fidelity. B and everything joint: those four, alignment, drivers.
    assert.equal((await files(deps.llm.cacheDir)).length, 4);
    assert.equal((await files(join(deps.llm.cacheDir, "expiring"))).length, 6);
  });

  it("runs the full pipeline: freeze first, then outcomes", async () => {
    const { deps, reads } = await setup(happy);
    const r = await compare(deps, postA, postB);
    assert.ok(r.ok, !r.ok ? r.message : "");
    if (!r.ok) return;
    const rep = r.value;
    assert.equal(rep.sides.length, 2);
    assert.ok(rep.sides.every((s) => s.run_id.length === 16 && s.portfolio));
    assert.equal(rep.window!.entry, "2026-07-17");
    assert.equal(rep.window!.cutoff, "2026-07-16T08:29:33.028Z");
    assert.ok(rep.backtests && rep.co_movement?.ex_ante);
    // Both backtests share one window.
    assert.equal(rep.backtests.a.window.entry, rep.backtests.b.window.entry);
    assert.equal(rep.backtests.a.window.end, rep.backtests.b.window.end);
    // Pre-freeze reads (ticker checks) never reached the cutoff day.
    const preFreeze = reads.filter((x) => x.end < "2026-07-16");
    assert.ok(preFreeze.length >= 8);
    assert.ok(rep.caveats.some((c) => /postdate the interpretation model's training cutoff/.test(c)));
    // deps.end is a pin: reads stop there, and the report says so.
    assert.ok(reads.every((x) => x.end <= "2026-10-16"));
    assert.ok(rep.caveats.some((c) => c.startsWith(`Results run through ${rep.window!.end}, the end date fixed for this pair`)));
  });

  it("by default stores nothing derived from prices: only the frozen runs", async () => {
    const { deps } = await setup(happy);
    const r = await compare(deps, postA, postB);
    assert.ok(r.ok && r.value.backtests);
    const files = await readdir(deps.outDir, { recursive: true });
    assert.deepEqual(files.filter((f) => f.endsWith(".json")).map((f) => f.split(/[\\/]/).pop()).sort(), ["frozen-a.json", "frozen-b.json"]);
    for (const f of files.filter((f) => f.endsWith(".json"))) {
      assert.doesNotMatch(await readFile(join(deps.outDir, f), "utf8"), /adjClose|cumulativeReturn|"values"/);
    }
  });

  it("saves the report when the price plan allows it", async () => {
    const { deps } = await setup(happy);
    const r = await compare({ ...deps, persistReport: true }, postA, postB);
    assert.ok(r.ok);
    const files = await readdir(deps.outDir, { recursive: true });
    const report = files.find((f) => f.endsWith("report.json"));
    assert.ok(report, files.join(", "));
    assert.equal(JSON.parse(await readFile(join(deps.outDir, report), "utf8")).comparison_id, r.value.comparison_id);
  });

  it("reports stages in pipeline order", async () => {
    const { deps } = await setup(happy);
    const stages: string[] = [];
    await compare({ ...deps, onStage: (s) => stages.push("side" in s ? `${s.stage}:${s.side}` : s.stage) }, postA, postB);
    assert.deepEqual(stages, ["analyze:A", "voice:A", "draft:A", "analyze:B", "voice:B", "draft:B", "frozen", "align", "drivers", "fidelity:A", "fidelity:B", "prices", "backtest"]);
  });

  it("alignment sees both posts but no authors and no portfolios", async () => {
    const { deps, t } = await setup(happy);
    await compare(deps, postA, postB);
    const req = t.requests[4]!;
    const sent = req.system + JSON.stringify(req.messages);
    assert.match(sent, /Buy the railroads/);
    assert.match(sent, /Buy the truckers/);
    assert.doesNotMatch(sent, /alice_author|bob_author|x\.com/);
    assert.doesNotMatch(sent, /"RA"|"TA"|\bRA\b|\bTA\b/);
  });

  it("each side's calls never see the other post", async () => {
    const { deps, t } = await setup(happy);
    await compare(deps, postA, postB);
    for (const i of [0, 1]) assert.doesNotMatch(JSON.stringify(t.requests[i]!.messages), /truckers/);
    for (const i of [2, 3]) assert.doesNotMatch(JSON.stringify(t.requests[i]!.messages), /railroads/);
  });

  it("reads shared drivers after freezing, before prices, from holdings alone", async () => {
    const { deps, t, reads } = await setup(happy);
    const transport = deps.llm.transport;
    let readsAtDrivers = -1;
    const r = await compare(
      {
        ...deps,
        llm: {
          ...deps.llm,
          transport: {
            async call(req) {
              if (req.system === DRIVERS_SYSTEM) {
                readsAtDrivers = reads.length;
                const sub = (await readdir(deps.outDir))[0]!;
                await access(join(deps.outDir, sub, "frozen-b.json"));
              }
              return transport.call(req);
            },
          },
        },
      },
      postA,
      postB,
    );
    assert.ok(r.ok, !r.ok ? r.message : "");
    if (!r.ok) return;
    // No outcome price had been read when the drivers call was made.
    assert.ok(readsAtDrivers >= 0);
    assert.ok(reads.slice(0, readsAtDrivers).every((x) => x.end < "2026-07-16"));
    const msg = JSON.stringify(t.requests.find((q) => q.system === DRIVERS_SYSTEM)!.messages);
    assert.match(msg, /RA .*TA/);
    assert.doesNotMatch(msg, /alice_author|bob_author|2026-0/);
    assert.deepEqual(r.value.drivers?.value, drivers);
    assert.equal(r.value.versions.drivers, "drivers-v1");
    assert.ok(r.value.findings.some((f) => f.kind === "drivers_expected" || f.kind === "drivers_unexpected"));
  });

  it("samples the drivers reading several times with identical prompts, showing a majority sample", async () => {
    const say = (e: SharedDrivers["expected_daily_co_movement"]) => ({ ...drivers, expected_daily_co_movement: e, summary: e });
    const { deps, t } = await setup([...happy.slice(0, -3), say("no_clear_relationship"), say("together"), say("together"), fidA, fidB]);
    const r = await compare({ ...deps, driversSamples: 3 }, postA, postB);
    assert.ok(r.ok, !r.ok ? r.message : "");
    if (!r.ok) return;
    const calls = t.requests.filter((q) => q.system === DRIVERS_SYSTEM);
    assert.equal(calls.length, 3);
    assert.ok(calls.every((q) => JSON.stringify(q.messages) === JSON.stringify(calls[0]!.messages)));
    assert.deepEqual(r.value.drivers!.expectations, ["no_clear_relationship", "together", "together"]);
    assert.equal(r.value.drivers!.shown, 1);
    assert.equal(r.value.drivers!.value.summary, "together");
  });

  it("keeps the samples that succeed and notes the ones that don't", async () => {
    const { deps } = await setup([...happy.slice(0, -3), drivers, { unexpected: true }, drivers, fidA, fidB]);
    const r = await compare({ ...deps, driversSamples: 3 }, postA, postB);
    assert.ok(r.ok, !r.ok ? r.message : "");
    if (!r.ok) return;
    assert.deepEqual(r.value.drivers!.expectations, ["together", "together"]);
    assert.ok(r.value.caveats.some((c) => /Shared-drivers reading: 1 of 3 samples failed/.test(c)));
  });

  it("carries on with a caveat when the drivers call fails", async () => {
    // An output that doesn't match the schema, standing in for any model failure.
    const { deps } = await setup([...happy.slice(0, -3), { unexpected: true }, fidA, fidB]);
    const r = await compare(deps, postA, postB);
    assert.ok(r.ok, !r.ok ? r.message : "");
    if (!r.ok) return;
    assert.equal(r.value.drivers, null);
    assert.ok(r.value.backtests);
    assert.ok(r.value.caveats.some((c) => /Shared-drivers reading: 1 of 1 samples failed/.test(c)));
  });

  it("an abstaining side stops before any outcome is read", async () => {
    const abstain: ThesisAnalysis = { ...analysis("none", "Buy the truckers."), interpretations: [], default_interpretation: null, status: "not_investable", status_reason: "A joke." };
    const { deps, reads, t } = await setup([analysis("rails", "Buy the railroads."), draft(["RA", "RB", "RC", "RD"]), abstain, alignment, fidA]);
    const r = await compare(deps, postA, postB);
    assert.ok(r.ok, !r.ok ? r.message : "");
    if (!r.ok) return;
    assert.equal(r.value.sides[1]!.portfolio, null);
    assert.equal(r.value.backtests, null);
    assert.ok(r.value.findings.some((f) => f.kind === "abstention"));
    assert.ok(reads.every((x) => x.end < "2026-07-16"));
    assert.equal(t.requests.length, 5); // no draft, drivers or fidelity call for B
  });

  it("is order-independent: swapping A and B swaps the sides, same portfolios", async () => {
    const x = await setup(happy);
    const y = await setup([happy[2], happy[3], happy[0], happy[1], happy[4]]);
    const rx = await compare(x.deps, postA, postB);
    const ry = await compare(y.deps, postB, postA);
    assert.ok(rx.ok && ry.ok);
    if (rx.ok && ry.ok) {
      assert.deepEqual(rx.value.sides[0]!.portfolio, ry.value.sides[1]!.portfolio);
      assert.equal(rx.value.window!.entry, ry.value.window!.entry);
      assert.equal(rx.value.co_movement!.ex_ante!.raw!.toFixed(12), ry.value.co_movement!.ex_ante!.raw!.toFixed(12));
    }
  });
});

describe("findings", () => {
  const base = (over: Partial<ComparisonReport>): ComparisonReport =>
    ({ alignment: null, holdings_overlap: null, co_movement: null, ...over }) as ComparisonReport;
  const cm = (raw: [number, number], res: [number, number]) =>
    ({ ex_ante: { rawCi95: raw, residualCi95: res, a: { beta: 1.1 }, b: { beta: -0.6 } }, ex_ante_direction: raw[0] > 0 ? "together" : raw[1] < 0 ? "apart" : "no_clear_relationship" }) as unknown as ComparisonReport["co_movement"];

  it("flags opposing opinions whose portfolios move together", () => {
    const f = findings(base({ alignment: { value: { relationship: "opposing" } as ThesisAlignment, cost_usd: 0, cached: true }, co_movement: cm([0.2, 0.4], [0.1, 0.3]) }));
    assert.ok(f.some((x) => x.kind === "mismatch"));
  });

  it("says nothing about co-movement when the interval includes zero", () => {
    const f = findings(base({ alignment: { value: { relationship: "opposing" } as ThesisAlignment, cost_usd: 0, cached: true }, co_movement: cm([-0.05, 0.1], [-0.05, 0.1]) }));
    assert.deepEqual(f, []);
  });

  it("explains when market exposure carries the relationship", () => {
    const f = findings(base({ co_movement: cm([-0.3, -0.1], [-0.1, 0.1]) }));
    assert.ok(f.some((x) => x.kind === "market_explains" && /betas 1\.10 and -0\.60/.test(x.text)));
  });

  it("sets how the drivers readings split beside the measured direction", () => {
    const withDrivers = (...e: SharedDrivers["expected_daily_co_movement"][]) => ({ drivers: { value: drivers, expectations: e, shown: 0, cost_usd: 0, cached: true } });
    const together = cm([0.2, 0.4], [0.1, 0.3]);
    const one = findings(base({ ...withDrivers("together"), co_movement: together }));
    assert.ok(one.some((x) => x.kind === "drivers_expected" && /one AI reading expected their daily moves to line up; in the year before the posts, they lined up/.test(x.text)));
    const all = findings(base({ ...withDrivers("together", "together", "together"), co_movement: together }));
    assert.ok(all.some((x) => x.kind === "drivers_expected" && /3 separate AI readings: 3 expected their daily moves to line up\. In the year before the posts, they lined up\./.test(x.text)));
    const mixed = findings(base({ ...withDrivers("no_clear_relationship", "together", "together"), co_movement: together }));
    assert.ok(mixed.some((x) => x.kind === "drivers_mixed" && /2 expected their daily moves to line up, 1 expected their daily moves to show no clear relationship/.test(x.text)));
    const none = findings(base({ ...withDrivers("together", "together"), co_movement: cm([-0.05, 0.1], [-0.05, 0.1]) }));
    assert.ok(none.some((x) => x.kind === "drivers_unexpected" && /they showed no clear relationship/.test(x.text)));
    assert.ok(!findings(base({ co_movement: together })).some((x) => x.kind.startsWith("drivers")));
  });

  it("names shared holdings between opposing opinions", () => {
    const f = findings(base({
      alignment: { value: { relationship: "partly_conflicting" } as ThesisAlignment, cost_usd: 0, cached: true },
      holdings_overlap: { overlap: 0.2, shared: [{ ticker: "MSFT", shareA: 0.2, shareB: 0.3 }] },
    }));
    assert.ok(f.some((x) => x.kind === "shared_holdings" && /MSFT/.test(x.text)));
  });
});

describe("compare: alternate readings", () => {
  const twoReadings: ThesisAnalysis = {
    ...analysis("rails", "Buy the railroads."),
    interpretations: [
      { id: "i1", label: "Railroads", expression: "own railroads", author_stated: true, gap_note: "" },
      { id: "i2", label: "Freight broadly", expression: "own trucking too", author_stated: false, gap_note: "adds trucking" },
    ],
  };

  it("drafts and freezes every reading before outcomes, and reports sensitivity", async () => {
    // A: i1 = rails, i2 = the same trucks B holds. B: trucks.
    const { deps, t } = await setup([twoReadings, draft(["RA", "RB", "RC", "RD"]), draft(["TA", "TB", "TC", "TD"]), analysis("trucks", "Buy the truckers."), draft(["TA", "TB", "TC", "TD"]), alignment, drivers, fidA, fidB]);
    const r = await compare({ ...deps, alternates: true }, postA, postB);
    assert.ok(r.ok, !r.ok ? r.message : "");
    if (!r.ok) return;
    assert.equal(t.requests.length, 9);
    const a = r.value.sides[0]!;
    assert.equal(a.alternates.length, 1);
    assert.equal(a.alternates[0]!.interpretation_id, "i2");
    // The headline is still the default reading.
    assert.deepEqual(a.portfolio!.positions.map((p) => p.ticker), ["RA", "RB", "RC", "RD"]);
    const s = r.value.sensitivity!;
    assert.equal(s.readings.length, 3);
    assert.equal(s.pairs.length, 2);
    const headline = s.pairs.find((p) => p.is_headline)!;
    const alt = s.pairs.find((p) => !p.is_headline)!;
    assert.equal(headline.a, "i1");
    assert.equal(headline.holdings_overlap, 0);
    assert.equal(alt.holdings_overlap, 1);
    assert.equal(alt.ex_ante_direction, "together");
    assert.ok(r.value.findings.some((f) => f.kind === "interpretation_sensitive_holdings" && /TA/.test(f.text)));
    // Headline numbers are the same as they'd be without alternates.
    assert.equal(r.value.co_movement!.ex_ante!.raw, headline.ex_ante_raw);
  });

  it("an alternate holding tickers no other portfolio holds is fetched and backtested", async () => {
    const { deps, reads } = await setup([twoReadings, draft(["RA", "RB", "RC", "RD"]), draft(["FA", "FB", "FC", "FD"]), analysis("trucks", "Buy the truckers."), draft(["TA", "TB", "TC", "TD"]), alignment, drivers, fidA, fidB]);
    const r = await compare({ ...deps, alternates: true }, postA, postB);
    assert.ok(r.ok, !r.ok ? r.message : "");
    if (!r.ok) return;
    assert.ok(reads.some((x) => x.ticker === "FA" && x.end >= "2026-07-16"));
    const alt = r.value.sensitivity!.readings.find((x) => x.interpretation_id === "i2")!;
    assert.ok(alt.metrics, alt.error ?? "");
    assert.equal(r.value.sensitivity!.pairs.find((p) => !p.is_headline)!.error, null);
  });

  it("the frozen run id covers the alternates", async () => {
    const x = await setup([twoReadings, draft(["RA", "RB", "RC", "RD"]), draft(["FA", "FB", "FC", "FD"]), analysis("trucks", "Buy the truckers."), draft(["TA", "TB", "TC", "TD"]), alignment, drivers, fidA, fidB]);
    const y = await setup([twoReadings, draft(["RA", "RB", "RC", "RD"]), draft(["TA", "TB", "TC", "TD"]), analysis("trucks", "Buy the truckers."), draft(["TA", "TB", "TC", "TD"]), alignment, drivers, fidA, fidB]);
    const rx = await compare({ ...x.deps, alternates: true }, postA, postB);
    const ry = await compare({ ...y.deps, alternates: true }, postA, postB);
    assert.ok(rx.ok && ry.ok);
    if (rx.ok && ry.ok) {
      assert.deepEqual(rx.value.sides[0]!.portfolio, ry.value.sides[0]!.portfolio);
      assert.notEqual(rx.value.sides[0]!.run_id, ry.value.sides[0]!.run_id);
    }
  });

  it("a failed alternate is recorded, not fatal", async () => {
    const tooBig = draft(["RA", "RB"]); // 2 positions: under the concentrated minimum of 3
    const { deps } = await setup([twoReadings, draft(["RA", "RB", "RC", "RD"]), tooBig, tooBig, tooBig, analysis("trucks", "Buy the truckers."), draft(["TA", "TB", "TC", "TD"]), alignment, drivers, fidA, fidB]);
    const r = await compare({ ...deps, alternates: true }, postA, postB);
    assert.ok(r.ok, !r.ok ? r.message : "");
    if (!r.ok) return;
    const alt = r.value.sides[0]!.alternates[0]!;
    assert.equal(alt.portfolio, null);
    assert.match(alt.error!, /invalid_after_repair/);
    assert.equal(r.value.sensitivity!.pairs.length, 1);
  });

  it("alternates are off by default", async () => {
    const { deps, t } = await setup([twoReadings, draft(["RA", "RB", "RC", "RD"]), analysis("trucks", "Buy the truckers."), draft(["TA", "TB", "TC", "TD"]), alignment, drivers, fidA, fidB]);
    const r = await compare(deps, postA, postB);
    assert.ok(r.ok, !r.ok ? r.message : "");
    assert.equal(t.requests.length, 8);
    if (r.ok) assert.deepEqual(r.value.sides[0]!.alternates, []);
  });

  it("flags when the co-movement direction depends on the reading", () => {
    const rep = {
      sides: [
        { label: "A", analysis: { interpretations: [{ id: "i1", label: "Rails" }, { id: "i2", label: "Freight" }] } },
        { label: "B", analysis: { interpretations: [{ id: "i1", label: "Trucks" }] } },
      ],
      alignment: null, holdings_overlap: null, co_movement: null,
      sensitivity: {
        readings: [],
        pairs: [
          { a: "i1", b: "i1", is_headline: true, shared: [], ex_ante_direction: "apart" },
          { a: "i2", b: "i1", is_headline: false, shared: [], ex_ante_direction: "together" },
        ],
      },
    } as unknown as ComparisonReport;
    const f = findings(rep);
    const s = f.find((x) => x.kind === "interpretation_sensitive");
    assert.ok(s);
    // B has one reading, so A's reading alone determines the direction.
    assert.match(s!.text, /depends on how post A is read, whatever the reading of B: "Rails" -> apart; "Freight" -> together/);
  });

  it("lists every pairing when neither side's reading alone decides", () => {
    const rep = {
      sides: [
        { label: "A", analysis: { interpretations: [{ id: "i1", label: "A1" }, { id: "i2", label: "A2" }] } },
        { label: "B", analysis: { interpretations: [{ id: "i1", label: "B1" }, { id: "i2", label: "B2" }] } },
      ],
      alignment: null, holdings_overlap: null, co_movement: null,
      sensitivity: { readings: [], pairs: [
        { a: "i1", b: "i1", is_headline: true, shared: [], ex_ante_direction: "together" },
        { a: "i1", b: "i2", is_headline: false, shared: [], ex_ante_direction: "apart" },
        { a: "i2", b: "i1", is_headline: false, shared: [], ex_ante_direction: "apart" },
        { a: "i2", b: "i2", is_headline: false, shared: [], ex_ante_direction: "together" },
      ] },
    } as unknown as ComparisonReport;
    const s = findings(rep).find((x) => x.kind === "interpretation_sensitive")!;
    assert.match(s.text, /depends on how the posts are read: A as "A1" with B as "B1" -> together; A as "A1" with B as "B2" -> apart/);
  });

  it("no sensitivity finding when every pairing agrees or is unclear", () => {
    const rep = {
      sides: [], alignment: null, holdings_overlap: null, co_movement: null,
      sensitivity: { readings: [], pairs: [
        { a: "i1", b: "i1", is_headline: true, shared: [], ex_ante_direction: "together" },
        { a: "i2", b: "i1", is_headline: false, shared: [], ex_ante_direction: "together" },
        { a: "i3", b: "i1", is_headline: false, shared: [], ex_ante_direction: "no_clear_relationship" },
      ] },
    } as unknown as ComparisonReport;
    assert.deepEqual(findings(rep).filter((x) => x.kind.startsWith("interpretation")), []);
  });
});

describe("stance conflicts", () => {
  const bearish: ThesisAnalysis = {
    ...analysis("AI capex is wasted", "Buy the railroads."),
    direction: "bearish",
    targets: [
      { ticker: "MSFT", stance: "negative" },
      { ticker: "GOOG", stance: "negative" },
      { ticker: "NVDA", stance: "positive" },
    ],
  };
  const holding = (tickers: string[]) =>
    ({ positions: tickers.map((ticker) => ({ ticker, weight: 10 })), cash_weight: 10 }) as unknown as import("../src/lib/weights.js").Portfolio;

  it("flags holdings the post is negative about, treating share classes as one company", async () => {
    const { stanceConflicts } = await import("../src/lib/compare.js");
    assert.deepEqual(stanceConflicts(bearish, holding(["MSFT", "GOOGL", "NVDA", "XLP"])), ["GOOGL", "MSFT"]);
    assert.deepEqual(stanceConflicts(bearish, holding(["XLP", "NVDA"])), []);
  });

  it("states the conflict as a finding, headline or alternative", () => {
    const rep = {
      sides: [
        {
          label: "A",
          analysis: { ...bearish, interpretations: [{ id: "i1", label: "Outside AI" }, { id: "i3", label: "Core businesses" }], default_interpretation: "i1" },
          portfolio: holding(["XLP"]),
          alternates: [{ interpretation_id: "i3", portfolio: holding(["MSFT", "GOOGL", "AMZN"]), error: null }],
        },
      ],
      alignment: null, holdings_overlap: null, co_movement: null, sensitivity: null,
    } as unknown as ComparisonReport;
    const f = findings(rep).filter((x) => x.kind === "stance_conflict");
    assert.equal(f.length, 1);
    assert.match(f[0]!.text, /An alternative reading of post A \("Core businesses"\) holds GOOGL, MSFT, which the post itself is negative about/);
  });

  it("the real pipeline carries conflicts on each reading", async () => {
    const twoBear: ThesisAnalysis = {
      ...bearish,
      interpretations: [
        { id: "i1", label: "Rails", expression: "rails", author_stated: false, gap_note: "" },
        { id: "i2", label: "Core businesses", expression: "own them anyway", author_stated: false, gap_note: "" },
      ],
    };
    data.MSFT = data.FA!;
    const { deps } = await setup([twoBear, draft(["RA", "RB", "RC", "RD"]), draft(["MSFT", "FB", "FC", "FD"]), analysis("trucks", "Buy the truckers."), draft(["TA", "TB", "TC", "TD"]), alignment, drivers, fidA, fidB]);
    const r = await compare({ ...deps, alternates: true }, postA, postB);
    assert.ok(r.ok, !r.ok ? r.message : "");
    if (!r.ok) return;
    const alt = r.value.sensitivity!.readings.find((x) => x.side === "A" && x.interpretation_id === "i2")!;
    assert.deepEqual(alt.stance_conflicts, ["MSFT"]);
    assert.ok(r.value.findings.some((f) => f.kind === "stance_conflict"));
  });
});

describe("default reading", () => {
  const reading = (id: string, author_stated: boolean) => ({ id, label: id, expression: id, author_stated, gap_note: "" });
  const named = [{ ticker: "RA", stance: "positive" as const }];
  const an = (def: string | null, ...rs: ReturnType<typeof reading>[]): ThesisAnalysis => ({ ...analysis("x", "x"), targets: named, interpretations: rs, default_interpretation: def });

  it("prefers a reading built from what the author named", () => {
    assert.equal(pickDefault(an("i1", reading("i1", false), reading("i2", true))), "i2");
    assert.equal(pickDefault(an("i2", reading("i1", true), reading("i2", true))), "i2", "the model's pick stands when it's author-named");
    assert.equal(pickDefault(an("i1", reading("i1", false), reading("i2", false))), "i1", "no author-named reading: the model's pick");
    assert.equal(pickDefault({ ...an(null), status: "not_investable" }), null);
  });

  it("doesn't count a reading as author-named unless the post is positive about a ticker", () => {
    const loose = an("i1", reading("i1", false), reading("i2", true));
    assert.equal(pickDefault({ ...loose, targets: [] }), "i1", "author_stated alone, no targets");
    assert.equal(pickDefault({ ...loose, targets: [{ ticker: "MOH", stance: "negative" }] }), "i1", "only a negative target");
    assert.equal(authorNamed({ targets: [{ ticker: "HOOD", stance: "positive" }] }, { author_stated: false }), false);
  });

  it("drafts the author-named reading and records the model's pick", async () => {
    const broad: ThesisAnalysis = { ...analysis("rails", "Buy the railroads."), targets: named, interpretations: [reading("i1", false), reading("i2", true)], default_interpretation: "i1" };
    const { deps, t } = await setup([broad, draft(["RA", "RB", "RC", "RD"]), analysis("trucks", "Buy the truckers."), draft(["TA", "TB", "TC", "TD"]), alignment, drivers, fidA, fidB]);
    const r = await compare(deps, postA, postB);
    assert.ok(r.ok, !r.ok ? r.message : "");
    if (!r.ok) return;
    const a = r.value.sides[0]!;
    assert.equal(a.analysis.default_interpretation, "i2");
    assert.equal(a.model_default, "i1");
    assert.equal(a.portfolio!.interpretation_id, "i2");
    assert.match(t.requests[1]!.messages[0]!.content as string, /<interpretation_to_build>\s*\{\s*"id": "i2"/);
    assert.equal(r.value.sides[1]!.model_default, null);
  });

  it("a post that only reports news never counts as the author naming what to own", async () => {
    const broad: ThesisAnalysis = { ...analysis("rails", "Buy the railroads."), targets: named, interpretations: [reading("i1", false), reading("i2", true)], default_interpretation: "i1" };
    const news = { voice: "news_only", commentary: null, reason: "A headline." };
    const { deps, t } = await setup([broad, draft(["RA", "RB", "RC", "RD"]), analysis("trucks", "Buy the truckers."), draft(["TA", "TB", "TC", "TD"]), alignment, drivers, fidA, fidB], undefined, [news]);
    const r = await compare(deps, postA, postB);
    assert.ok(r.ok, !r.ok ? r.message : "");
    if (!r.ok) return;
    const a = r.value.sides[0]!;
    // The model's own default stands, and the draft uses the ordinary prompt.
    assert.equal(a.analysis.default_interpretation, "i1");
    assert.equal(a.model_default, null);
    assert.equal(a.versions.draft, "draft-v1");
    assert.deepEqual(a.voice, news);
    assert.ok(r.value.caveats.some((c) => c.startsWith("Post A reports news without a view of its own.")));
    assert.ok(!r.value.caveats.some((c) => c.startsWith("Post B reports news")));
    assert.equal(t.voiceRequests.length, 2, "each side classified once");
  });

  it("names the poster's commentary on news, and carries on with a caveat when classification fails", async () => {
    const commented = { voice: "news_with_commentary", commentary: "Buy the truckers.", reason: "Headline plus a view." };
    const { deps } = await setup(happy, undefined, [new Error("overloaded"), commented]);
    const r = await compare(deps, postA, postB);
    assert.ok(r.ok, !r.ok ? r.message : "");
    if (!r.ok) return;
    assert.equal(r.value.sides[0]!.voice, null);
    assert.ok(r.value.caveats.some((c) => /^Whether post A states the poster's own view couldn't be determined/.test(c)));
    assert.ok(r.value.caveats.some((c) => c.includes('adds the poster\'s own reading ("Buy the truckers.")')));
  });
});

describe("fidelity", () => {
  const p = { positions: [{ ticker: "BRK-B", weight: 60 }, { ticker: "UFO", weight: 30 }], cash_weight: 10 } as unknown as Portfolio;
  const label = (ticker: string, link: "named" | "direct" | "proxy" | "added") => ({ ticker, link, stands_for: "", note: "" });

  it("turns labels into shares of invested weight, matching share-class spellings", () => {
    const r = fidelityShares({ holdings: [label("BRK.B", "named"), label("UFO", "proxy")], not_investable: [], summary: "" }, p);
    assert.ok(r.ok);
    assert.deepEqual(r.value, { named: 60 / 90, direct: 0, proxy: 30 / 90, added: 0 });
  });

  it("ignores a label for the cash line", () => {
    const r = fidelityShares({ holdings: [label("BRK-B", "named"), label("UFO", "proxy"), label("Cash", "added")], not_investable: [], summary: "" }, p);
    assert.ok(r.ok && r.value.added === 0);
  });

  it("rejects labels that don't cover each holding exactly once", () => {
    const f = (...h: ReturnType<typeof label>[]) => fidelityShares({ holdings: h, not_investable: [], summary: "" }, p);
    const missing = f(label("BRK-B", "named"));
    assert.ok(!missing.ok && /No label for UFO/.test(missing.message));
    const dup = f(label("BRK-B", "named"), label("BRK.B", "named"), label("UFO", "proxy"));
    assert.ok(!dup.ok && /twice/.test(dup.message));
    const extra = f(label("BRK-B", "named"), label("UFO", "proxy"), label("SPCX", "proxy"));
    assert.ok(!extra.ok && /doesn't hold/.test(extra.message));
  });

  it("labels each side alone, after freezing and before outcome prices", async () => {
    const { deps, t, reads } = await setup(happy);
    const transport = deps.llm.transport;
    const readsAt: number[] = [];
    const r = await compare(
      { ...deps, llm: { ...deps.llm, transport: { async call(req) { if (req.system === FIDELITY_SYSTEM) readsAt.push(reads.length); return transport.call(req); } } } },
      postA,
      postB,
    );
    assert.ok(r.ok, !r.ok ? r.message : "");
    if (!r.ok) return;
    assert.equal(readsAt.length, 2);
    for (const n of readsAt) assert.ok(reads.slice(0, n).every((x) => x.end < "2026-07-16"));
    const [qa, qb] = t.requests.filter((q) => q.system === FIDELITY_SYSTEM).map((q) => JSON.stringify(q.messages));
    assert.match(qa!, /railroads/);
    assert.doesNotMatch(qa!, /truckers|TA /);
    assert.doesNotMatch(qb!, /railroads|RA /);
    assert.deepEqual(r.value.fidelity.A!.shares, { named: 0.25, direct: 0.75, proxy: 0, added: 0 });
  });

  it("reports mismatched labels as a caveat, not a failure", async () => {
    const { deps } = await setup([...happy.slice(0, -2), fid(["RA", "RB"]), fidB]);
    const r = await compare(deps, postA, postB);
    assert.ok(r.ok, !r.ok ? r.message : "");
    if (!r.ok) return;
    assert.equal(r.value.fidelity.A, null);
    assert.ok(r.value.fidelity.B);
    assert.ok(r.value.caveats.some((c) => /Fidelity labels for A unavailable: No label for RC, RD/.test(c)));
    assert.ok(r.value.llm_cost_usd > 0);
  });
});
