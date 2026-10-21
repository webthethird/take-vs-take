import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { compare } from "../src/lib/compare.js";
import { consistencyFindings, sampleNonce, selfConsistency, type ConsistencyReport } from "../src/lib/consistency.js";
import type { LlmConfig, ModelResponse } from "../src/lib/llm.js";
import { fixtureSource, type PriceBar, type PriceSource } from "../src/lib/prices.js";
import { PostInput, type PortfolioDraft, type ThesisAlignment, type ThesisAnalysis } from "../src/lib/schema.js";
import { scripted } from "./llm.test.js";

// Same synthetic world as compare.test.ts: R* ride the market (β 1.2),
// T* lean against it (β -0.5), F* sit in between.
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

const analysis = (label: string, quote: string): ThesisAnalysis => ({
  evidence: [quote],
  economic_claim: label,
  direction: "bullish",
  subjects: [label],
  targets: [],
  horizon: null,
  missing: [],
  interpretations: [{ id: "i1", label, expression: label, author_stated: true, gap_note: "" }],
  default_interpretation: "i1",
  status: "investable",
  status_reason: "clear",
});
const abstain = (quote: string): ThesisAnalysis => ({ ...analysis("none", quote), interpretations: [], default_interpretation: null, status: "not_investable", status_reason: "A joke." });
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
const alignment: ThesisAlignment = { a_claim: "rails", b_claim: "trucks", shared_subjects: [], reasoning: "r", relationship: "opposing", confidence: "medium" };

const A = analysis("rails", "Buy the railroads.");
const B = analysis("trucks", "Buy the truckers.");
const RAILS = draft(["RA", "RB", "RC", "RD"]);
const TRUCKS = draft(["TA", "TB", "TC", "TD"]);
const MIXED = draft(["FA", "FB", "FC", "FD"]);

const dirs: string[] = [];
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function setup(responses: (Partial<ModelResponse> | Error)[]) {
  const d = await mkdtemp(join(tmpdir(), "tvt-sc-"));
  dirs.push(d);
  const t = scripted(responses);
  const llm: LlmConfig = { transport: t, budgetUsd: 5, cacheDir: join(d, "llm"), ledgerPath: join(d, "ledger.jsonl") };
  const reads: { ticker: string; end: string }[] = [];
  const base = fixtureSource(data);
  const out = join(d, "out");
  const prices: PriceSource = {
    name: "spy",
    async daily(ticker, start, end) {
      reads.push({ ticker, end });
      // The invariant: outcomes are read only after every sample is frozen.
      if (end >= "2026-07-16") {
        const { readdir } = await import("node:fs/promises");
        // (A plain compare() run in the same dir is checked in compare.test.ts.)
        const sub = (await readdir(out)).find((x) => x.startsWith("consistency-"));
        if (sub) await access(join(out, sub, "samples.json"));
      }
      return base.daily(ticker, start, end);
    },
  };
  return { t, reads, deps: { llm, prices, outDir: out, end: "2026-10-16", now: () => new Date("2026-10-19T12:00:00Z") } };
}
const ok = (parsed: unknown) => ({ parsed });

describe("selfConsistency", () => {
  it("samples each side independently, freezes all, then compares every pairing", async () => {
    // A: rails, rails (identical), mixed. B: trucks x3.
    const { deps, reads, t } = await setup([A, RAILS, A, RAILS, A, MIXED, B, TRUCKS, B, TRUCKS, B, TRUCKS].map(ok));
    const r = await selfConsistency(deps, postA, postB, 3);
    assert.ok(r.ok, !r.ok ? r.message : "");
    if (!r.ok) return;
    const rep = r.value;
    assert.equal(rep.samples.length, 6);
    assert.deepEqual(rep.samples.map((s) => s.nonce), [null, "sc-1", "sc-2", null, "sc-1", "sc-2"]);
    assert.deepEqual(rep.samples.map((s) => s.same_portfolio_as), [null, 0, null, null, 0, 0]);
    assert.equal(rep.summary.A.distinct_portfolios, 2);
    assert.equal(rep.summary.B.distinct_portfolios, 1);
    assert.equal(rep.within.A.length, 3);
    assert.equal(rep.within.B.length, 3);
    assert.equal(rep.between.length, 9);
    // Identical samples overlap fully; rails vs mixed not at all.
    assert.equal(rep.within.A.find((p) => p.a === 0 && p.b === 1)!.holdings_overlap, 1);
    assert.equal(rep.within.A.find((p) => p.a === 0 && p.b === 2)!.holdings_overlap, 0);
    assert.ok(rep.samples.every((s) => s.metrics));
    assert.equal(rep.summary.between.direction.apart + rep.summary.between.direction.together + rep.summary.between.direction.no_clear_relationship + rep.summary.between.direction.unavailable, 9);
    assert.ok(rep.findings.some((f) => /Post B produced the same portfolio in all 3/.test(f)));
    assert.ok(rep.findings.some((f) => /across all 9 sample pairings/.test(f)));
    // Pre-freeze reads never reached the cutoff day.
    assert.ok(reads.some((x) => x.end < "2026-07-16"));
    assert.equal(t.requests.length, 12);
  });

  it("stores only the frozen samples, nothing derived from prices", async () => {
    const { deps } = await setup([A, RAILS, A, RAILS, B, TRUCKS, B, TRUCKS].map(ok));
    const r = await selfConsistency(deps, postA, postB, 2);
    assert.ok(r.ok && r.value.between.length === 4);
    const { readdir, readFile } = await import("node:fs/promises");
    const files = (await readdir(deps.outDir, { recursive: true })).filter((f) => f.endsWith(".json"));
    assert.ok(files.length > 0);
    assert.ok(files.every((f) => !/report/.test(f)), files.join(", "));
    for (const f of files) assert.doesNotMatch(await readFile(join(deps.outDir, f), "utf8"), /adjClose|cumulativeReturn|"values"|ex_ante/);
  });

  it("saves the report when the price plan allows it", async () => {
    const { deps } = await setup([A, RAILS, A, RAILS, B, TRUCKS, B, TRUCKS].map(ok));
    const r = await selfConsistency({ ...deps, persistReport: true }, postA, postB, 2);
    assert.ok(r.ok);
    const { readdir } = await import("node:fs/promises");
    assert.ok((await readdir(deps.outDir, { recursive: true })).some((f) => f.endsWith("report.json")));
  });

  it("samples differ only by cache key: the model sees identical prompts", async () => {
    const { deps, t } = await setup([A, RAILS, A, RAILS, B, TRUCKS, B, TRUCKS].map(ok));
    await selfConsistency(deps, postA, postB, 2);
    assert.deepEqual(t.requests[0], t.requests[2]);
    assert.deepEqual(t.requests[1], t.requests[3]);
    // And never the other post.
    for (const i of [0, 1, 2, 3]) assert.doesNotMatch(JSON.stringify(t.requests[i]!.messages), /truckers/);
  });

  it("drafts only the default reading of each sample", async () => {
    const twoReadings: ThesisAnalysis = { ...A, interpretations: [...A.interpretations, { id: "i2", label: "other", expression: "other", author_stated: false, gap_note: "" }] };
    const { deps, t } = await setup([twoReadings, RAILS, twoReadings, RAILS, B, TRUCKS, B, TRUCKS].map(ok));
    const r = await selfConsistency(deps, postA, postB, 2);
    assert.ok(r.ok, !r.ok ? r.message : "");
    assert.equal(t.requests.length, 8);
    if (r.ok) assert.ok(r.value.samples.every((s) => s.error === null && s.run!.alternates.length === 0));
  });

  it("sample 0 replays the plain compare() run from cache", async () => {
    const { deps, t } = await setup([A, RAILS, B, TRUCKS, alignment, A, RAILS, B, TRUCKS].map(ok));
    assert.ok((await compare({ ...deps, alternates: false }, postA, postB)).ok);
    assert.equal(t.requests.length, 5);
    const r = await selfConsistency(deps, postA, postB, 2);
    assert.ok(r.ok, !r.ok ? r.message : "");
    assert.equal(t.requests.length, 9); // only samples 1 of each side are new
  });

  it("records a model failure as that sample's outcome and carries on", async () => {
    const refusal = { stopReason: "refusal" as const, parsed: null };
    const { deps } = await setup([ok(A), ok(RAILS), refusal, ok(B), ok(TRUCKS), ok(B), ok(TRUCKS)]);
    const r = await selfConsistency(deps, postA, postB, 2);
    assert.ok(r.ok, !r.ok ? r.message : "");
    if (!r.ok) return;
    const failed = r.value.samples.find((s) => s.side === "A" && s.sample === 1)!;
    assert.equal(failed.run, null);
    assert.match(failed.error!, /^refused/);
    assert.equal(r.value.summary.A.failed, 1);
    assert.equal(r.value.between.length, 2);
    assert.ok(r.value.findings.some((f) => /Post A: 1 of 2 samples produced no usable result/.test(f)));
  });

  it("aborts on an infrastructure failure instead of counting it as a sample", async () => {
    const { deps, reads } = await setup([ok(A), ok(RAILS), new Error("connection reset")]);
    const r = await selfConsistency(deps, postA, postB, 2);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error, "aborted");
      assert.match(r.message, /api_error|connection reset/);
    }
    assert.ok(reads.every((x) => x.end < "2026-07-16"));
  });

  it("counts abstentions as a judgment, and reports disagreement about investability", async () => {
    const { deps } = await setup([A, RAILS, abstain("Buy the railroads."), B, TRUCKS, B, TRUCKS].map(ok));
    const r = await selfConsistency(deps, postA, postB, 2);
    assert.ok(r.ok, !r.ok ? r.message : "");
    if (!r.ok) return;
    assert.deepEqual(r.value.summary.A.statuses, { investable: 1, not_investable: 1 });
    assert.equal(r.value.summary.A.failed, 0);
    assert.ok(r.value.findings.some((f) => /Post A was not judged the same way every time: investable in 1, not investable in 1 of 2/.test(f)));
  });

  it("reads no outcome when every sample of a side abstains", async () => {
    const { deps, reads } = await setup([A, RAILS, A, RAILS, abstain("Buy the truckers."), abstain("Buy the truckers.")].map(ok));
    const r = await selfConsistency(deps, postA, postB, 2);
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.value.between.length, 0);
    assert.ok(reads.every((x) => x.end < "2026-07-16"));
  });

  it("rejects a sample count outside 2..10", async () => {
    const { deps, t } = await setup([]);
    for (const n of [1, 11, 2.5]) assert.equal((await selfConsistency(deps, postA, postB, n)).ok, false);
    assert.equal(t.requests.length, 0);
  });

  it("sample 0 has no nonce; later samples are numbered", () => {
    assert.equal(sampleNonce(0), undefined);
    assert.equal(sampleNonce(3), "sc-3");
  });
});

describe("consistencyFindings", () => {
  const rep = (direction: Record<string, number>, headline: string | null): ConsistencyReport =>
    ({
      summary: {
        A: { samples: 5, statuses: { investable: 5 }, failed: 0, built: 5, distinct_portfolios: 4 },
        B: { samples: 5, statuses: { investable: 5 }, failed: 0, built: 5, distinct_portfolios: 5 },
        between: { pairs: 25, direction: { together: 0, apart: 0, no_clear_relationship: 0, unavailable: 0, ...direction }, residual_direction: { together: 0, apart: 25, no_clear_relationship: 0, unavailable: 0 }, headline },
      },
    }) as unknown as ConsistencyReport;

  it("flags mixed definite directions as unreliable", () => {
    const f = consistencyFindings(rep({ together: 6, apart: 4, no_clear_relationship: 15 }, "no_clear_relationship"));
    assert.ok(f.some((x) => /together in 6, apart in 4, no clear relationship in 15/.test(x)));
    assert.ok(f.some((x) => /not reliable/.test(x)));
    assert.ok(!f.some((x) => /plain run/.test(x))); // the headline is the most common result
  });

  it("says when the plain run's label isn't the most common one", () => {
    const f = consistencyFindings(rep({ together: 3, no_clear_relationship: 22 }, "together"));
    assert.ok(f.some((x) => /plain run .* says "together", which is not the most common/.test(x)));
    assert.ok(!f.some((x) => /not reliable/.test(x))); // "unclear" isn't a contrary direction
  });

  it("stays quiet about reliability when every pairing agrees", () => {
    const f = consistencyFindings(rep({ apart: 25 }, "apart"));
    assert.deepEqual(f, ["Raw co-movement across all 25 sample pairings: apart in 25.", "Residual co-movement (beyond the market) across the same pairings: apart in 25."]);
  });
});
