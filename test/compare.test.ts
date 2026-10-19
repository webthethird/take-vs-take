import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { compare, findings, type ComparisonReport } from "../src/lib/compare.js";
import type { LlmConfig } from "../src/lib/llm.js";
import { fixtureSource, type PriceBar, type PriceSource } from "../src/lib/prices.js";
import { PostInput, type PortfolioDraft, type ThesisAlignment, type ThesisAnalysis } from "../src/lib/schema.js";
import { scripted } from "./llm.test.js";

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
["RA", "RB", "RC", "RD", "TA", "TB", "TC", "TD"].forEach((t, i) => (data[t] = walk(100 + i, i < 4 ? 1.2 : -0.5, market)));

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

const dirs: string[] = [];
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function setup(responses: unknown[], source?: PriceSource) {
  const d = await mkdtemp(join(tmpdir(), "tvt-cmp-"));
  dirs.push(d);
  const t = scripted(responses.map((parsed) => ({ parsed })));
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
  return { t, reads, deps: { llm, prices, outDir: join(d, "out"), end: "2026-10-16", now: () => new Date("2026-10-19T12:00:00Z") } };
}

const happy = [
  analysis("rails", "Buy the railroads."),
  draft(["RA", "RB", "RC", "RD"]),
  analysis("trucks", "Buy the truckers."),
  draft(["TA", "TB", "TC", "TD"]),
  alignment,
];

describe("compare", () => {
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

  it("an abstaining side stops before any outcome is read", async () => {
    const abstain: ThesisAnalysis = { ...analysis("none", "Buy the truckers."), interpretations: [], default_interpretation: null, status: "not_investable", status_reason: "A joke." };
    const { deps, reads, t } = await setup([analysis("rails", "Buy the railroads."), draft(["RA", "RB", "RC", "RD"]), abstain, alignment]);
    const r = await compare(deps, postA, postB);
    assert.ok(r.ok, !r.ok ? r.message : "");
    if (!r.ok) return;
    assert.equal(r.value.sides[1]!.portfolio, null);
    assert.equal(r.value.backtests, null);
    assert.ok(r.value.findings.some((f) => f.kind === "abstention"));
    assert.ok(reads.every((x) => x.end < "2026-07-16"));
    assert.equal(t.requests.length, 4); // no draft for B
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

  it("names shared holdings between opposing opinions", () => {
    const f = findings(base({
      alignment: { value: { relationship: "partly_conflicting" } as ThesisAlignment, cost_usd: 0, cached: true },
      holdings_overlap: { overlap: 0.2, shared: [{ ticker: "MSFT", shareA: 0.2, shareB: 0.3 }] },
    }));
    assert.ok(f.some((x) => x.kind === "shared_holdings" && /MSFT/.test(x.text)));
  });
});
