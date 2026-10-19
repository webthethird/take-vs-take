// Two posts -> two frozen portfolios -> one common-window comparison.
//
// Order is the point (docs/PLAN.md §2, §7):
//   1. Each side is analyzed and drafted on its own: one post per call, no
//      author, and tickers checked only against prices from before the posts.
//   2. Both portfolios are frozen to disk, then thesis alignment runs.
//   3. Only then is the LookAheadGate unlocked and outcome prices read.
// A side that abstains (not investable / insufficient context) stays an
// abstention; nothing downstream invents a portfolio for it.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BACKTEST_VERSION,
  backtest,
  benchmarkBacktest,
  commonWindow,
  type BacktestResult,
  type WindowResult,
} from "./backtest.js";
import { toThesisInput } from "./fixture.js";
import {
  ANALYZE_PROMPT_VERSION,
  DRAFT_PROMPT_VERSION,
  analyzeThesis,
  draftPortfolio,
  priceTickerCheck,
  type Attempt,
} from "./interpret.js";
import { structuredCall, type LlmConfig } from "./llm.js";
import {
  OVERLAP_VERSION,
  coMovementDirection,
  exAnteCorrelation,
  holdingsOverlap,
  realizedCorrelation,
  type CoMovement,
  type CorrelationStats,
  type ExAnteResult,
} from "./overlap.js";
import { LookAheadGate, etDate, type PriceSeries, type PriceSource } from "./prices.js";
import { err, type Result } from "./result.js";
import { ThesisAlignment, type PostInput, type ThesisAnalysis } from "./schema.js";
import { WEIGHT_RULE_VERSION, type Portfolio } from "./weights.js";

export const BENCHMARK = "SPY";
/// All current Claude models (models overview page, checked 2026-10-19).
export const MODEL_TRAINING_CUTOFF = "2026-06-30";
export const ALIGN_PROMPT_VERSION = "align-v1";

// ── Thesis alignment ─────────────────────────────────────────────────────

export const ALIGN_SYSTEM = `You compare two social-media posts and judge how their opinions relate: whether they support each other, contradict each other, or are about different things.

You see each post's text, its date, and an analysis of its economic claim. You are not told who wrote either post, and you do not see any portfolios, prices or returns. Judge the opinions, not any investment built from them.

- opposing: if one is right, the other is substantially wrong.
- partly_conflicting: they disagree on part of the claim and agree or are silent on the rest.
- compatible: different claims that can both be true and neither undermines the other.
- similar: largely the same view.
- unrelated: about different subjects with no bearing on each other.
- unknown: one or both posts are too unclear to judge.

Two posts about the same companies can still be compatible, and two posts that sound hostile can be about different things. Ground your reasoning in what each post actually says; don't attribute views the posts don't state.`;

function renderForAlignment(label: "A" | "B", post: PostInput, analysis: ThesisAnalysis): string {
  return `<post_${label}>
<date>${etDate(new Date(post.created_at))}</date>
<text>
${post.text}
</text>
<analysis>${JSON.stringify({ status: analysis.status, economic_claim: analysis.economic_claim, direction: analysis.direction, subjects: analysis.subjects })}</analysis>
</post_${label}>`;
}

// ── Records ──────────────────────────────────────────────────────────────

export type Side = {
  label: "A" | "B";
  post: Pick<PostInput, "post_id" | "url" | "author_handle" | "created_at" | "attachments" | "provenance">;
  analysis: ThesisAnalysis;
  portfolio: Portfolio | null;
  attempts: Attempt[];
};

export type FrozenRun = Side & {
  run_id: string;
  frozen_at: string;
  versions: { analyze: string; draft: string; weights: string; model: string };
};

export type Finding = { kind: string; text: string };

export type ComparisonReport = {
  comparison_id: string;
  created_at: string;
  versions: Record<string, string>;
  sides: FrozenRun[];
  alignment: { value: ThesisAlignment; cost_usd: number; cached: boolean } | null;
  window: WindowResult | null;
  /// Labels the reader must see next to any result.
  caveats: string[];
  backtests: { a: BacktestResult; b: BacktestResult; benchmark: BacktestResult } | null;
  holdings_overlap: ReturnType<typeof holdingsOverlap> | null;
  co_movement: {
    ex_ante: ExAnteResult | null;
    ex_ante_error: string | null;
    ex_ante_direction: CoMovement | null;
    realized: CorrelationStats | null;
    realized_direction: CoMovement | null;
  } | null;
  findings: Finding[];
  llm_cost_usd: number;
};

export type CompareError = "analysis_failed" | "draft_failed" | "price_error" | "window_error" | "freeze_error";

export type CompareDeps = {
  llm: LlmConfig;
  /// Raw (cached) price source. compare() wraps it in its own gate.
  prices: PriceSource;
  outDir: string;
  now?: () => Date;
  /// Last trading day to evaluate through; defaults to the benchmark's latest.
  end?: string;
};

const shift = (d: string, days: number) => new Date(Date.parse(`${d}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

// ── Pipeline ─────────────────────────────────────────────────────────────

async function buildSide(deps: CompareDeps, gate: LookAheadGate, label: "A" | "B", post: PostInput): Promise<Result<Side, CompareError>> {
  const input = toThesisInput(post);
  const a = await analyzeThesis(deps.llm, input);
  if (!a.ok) return err("analysis_failed", `Side ${label}: ${a.error}: ${a.message}`);
  const analysis = a.value.analysis;
  const keep = { post_id: post.post_id, url: post.url, author_handle: post.author_handle, created_at: post.created_at, attachments: post.attachments, provenance: post.provenance };
  if (analysis.status !== "investable" || !analysis.default_interpretation) {
    return { ok: true, value: { label, post: keep, analysis, portfolio: null, attempts: a.attempts } };
  }
  const asOf = new Date(post.created_at);
  const d = await draftPortfolio(deps.llm, input, analysis, analysis.default_interpretation, priceTickerCheck(gate, asOf));
  if (!d.ok) return err("draft_failed", `Side ${label}: ${d.error}: ${d.message}`);
  return { ok: true, value: { label, post: keep, analysis, portfolio: d.value.portfolio, attempts: [...a.attempts, ...d.attempts] } };
}

function freeze(side: Side, now: Date): FrozenRun {
  const versions = {
    analyze: ANALYZE_PROMPT_VERSION,
    draft: DRAFT_PROMPT_VERSION,
    weights: WEIGHT_RULE_VERSION,
    model: side.attempts[0]?.model_requested ?? "unknown",
  };
  const body = { post_id: side.post.post_id, analysis: side.analysis, portfolio: side.portfolio, versions };
  const run_id = createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 16);
  return { ...side, run_id, frozen_at: now.toISOString(), versions };
}

export async function compare(deps: CompareDeps, postA: PostInput, postB: PostInput): Promise<Result<ComparisonReport, CompareError>> {
  const now = deps.now ?? (() => new Date());
  const cutoff = new Date(Math.max(Date.parse(postA.created_at), Date.parse(postB.created_at)));
  const gate = new LookAheadGate(deps.prices, cutoff);
  const comparison_id = createHash("sha256").update(`${postA.post_id}|${postB.post_id}`).digest("hex").slice(0, 12);
  const dir = join(deps.outDir, `compare-${comparison_id}`);
  await mkdir(dir, { recursive: true });

  // 1. Independent sides. Sequential, but neither sees the other.
  const sides: Side[] = [];
  for (const [label, post] of [["A", postA], ["B", postB]] as const) {
    const s = await buildSide(deps, gate, label, post);
    if (!s.ok) return s;
    sides.push(s.value);
  }

  // 2. Freeze to disk before anything else.
  const frozen = sides.map((s) => freeze(s, now()));
  try {
    for (const f of frozen) await writeFile(join(dir, `frozen-${f.label.toLowerCase()}.json`), JSON.stringify(f, null, 2));
  } catch (e) {
    return err("freeze_error", `Could not write frozen runs: ${(e as Error).message}`);
  }
  const [fa, fb] = frozen as [FrozenRun, FrozenRun];

  // Thesis alignment: after freezing, about the opinions only.
  let alignment: ComparisonReport["alignment"] = null;
  const al = await structuredCall(deps.llm, {
    promptVersion: ALIGN_PROMPT_VERSION,
    system: ALIGN_SYSTEM,
    schema: ThesisAlignment,
    messages: [{ role: "user", content: `${renderForAlignment("A", postA, fa.analysis)}\n\n${renderForAlignment("B", postB, fb.analysis)}` }],
  });
  if (al.ok) alignment = { value: al.value.value, cost_usd: al.value.meta.cost_usd, cached: al.value.meta.cached };

  const llm_cost_usd = [...fa.attempts, ...fb.attempts].reduce((s, x) => s + x.cost_usd, 0) + (alignment?.cost_usd ?? 0);
  const caveats: string[] = [
    "Hypothetical, AI-generated interpretations of public posts. The authors did not choose, hold or endorse these portfolios. Not investment advice.",
  ];
  const report: ComparisonReport = {
    comparison_id,
    created_at: now().toISOString(),
    versions: { analyze: ANALYZE_PROMPT_VERSION, draft: DRAFT_PROMPT_VERSION, align: ALIGN_PROMPT_VERSION, weights: WEIGHT_RULE_VERSION, backtest: BACKTEST_VERSION, overlap: OVERLAP_VERSION },
    sides: frozen,
    alignment,
    window: null,
    caveats,
    backtests: null,
    holdings_overlap: null,
    co_movement: null,
    findings: [],
    llm_cost_usd,
  };
  if (!al.ok) caveats.push(`Thesis alignment unavailable: ${al.message}`);

  const abstained = frozen.filter((f) => f.portfolio === null);
  if (abstained.length > 0) {
    for (const f of abstained) {
      report.findings.push({ kind: "abstention", text: `Post ${f.label} was judged ${f.analysis.status.replace("_", " ")}: ${f.analysis.status_reason} No portfolio was built for it.` });
    }
    await writeFile(join(dir, "report.json"), JSON.stringify(report, null, 2));
    return { ok: true, value: report };
  }
  const pa = fa.portfolio!;
  const pb = fb.portfolio!;

  // 3. Unlock, then read outcomes.
  const u = gate.unlock(frozen.map((f) => ({ run_id: f.run_id, frozen_at: f.frozen_at })), now());
  if (!u.ok) return err("freeze_error", u.message);

  const cutoffDay = etDate(cutoff);
  const start = shift(cutoffDay, -400);
  const end = deps.end ?? etDate(now());
  const tickers = [...new Set([...pa.positions, ...pb.positions].map((p) => p.ticker))].sort();
  const series: PriceSeries[] = [];
  for (const t of [BENCHMARK, ...tickers]) {
    const r = await gate.daily(t, start, end);
    if (!r.ok) return err("price_error", `${t}: ${r.error}: ${r.message}`);
    series.push(r.value);
  }
  const bench = series[0]!;

  const w = commonWindow({ createdA: postA.created_at, createdB: postB.created_at, benchmark: bench.bars });
  if (!w.ok) return err("window_error", w.message);
  report.window = w.value;
  if (w.value.carriedForward) {
    caveats.push(`The posts are ${Math.round(w.value.gapDays)} days apart. The earlier thesis is evaluated as of the later post's date; its author made no new call then.`);
  }
  const earliest = etDate(new Date(Math.min(Date.parse(postA.created_at), Date.parse(postB.created_at))));
  if (earliest <= MODEL_TRAINING_CUTOFF) {
    caveats.push(`At least one post predates the interpretation model's training cutoff (${MODEL_TRAINING_CUTOFF}); the model may know part of what happened next.`);
  } else {
    caveats.push(`Both posts postdate the interpretation model's training cutoff (${MODEL_TRAINING_CUTOFF}), so the model could not have learned the outcome window during training.`);
  }

  const side = (p: Portfolio) => ({ holdings: p.positions.map((x) => ({ ticker: x.ticker, weight: x.weight })), cashWeight: p.cash_weight });
  const bt = (p: Portfolio) => backtest({ ...side(p), prices: series, window: w.value });
  const ba = bt(pa);
  const bb = bt(pb);
  const bm = benchmarkBacktest(bench, w.value);
  if (!ba.ok) return err("price_error", `Backtest A: ${ba.message}`);
  if (!bb.ok) return err("price_error", `Backtest B: ${bb.message}`);
  if (!bm.ok) return err("price_error", `Benchmark: ${bm.message}`);
  report.backtests = { a: ba.value, b: bb.value, benchmark: bm.value };
  for (const [label, r] of [["A", ba.value], ["B", bb.value]] as const) {
    for (const f of r.flags) caveats.push(`Portfolio ${label} data flag: ${JSON.stringify(f)}`);
  }

  report.holdings_overlap = holdingsOverlap(side(pa), side(pb));
  const ex = exAnteCorrelation({ a: side(pa), b: side(pb), prices: series, benchmark: bench, cutoff: cutoff.toISOString() });
  const re = realizedCorrelation(ba.value, bb.value, bm.value);
  report.co_movement = {
    ex_ante: ex.ok ? ex.value : null,
    ex_ante_error: ex.ok ? null : ex.message,
    ex_ante_direction: ex.ok && ex.value.rawCi95 ? coMovementDirection(ex.value.rawCi95) : null,
    realized: re.ok ? re.value : null,
    realized_direction: re.ok && re.value.rawCi95 ? coMovementDirection(re.value.rawCi95) : null,
  };
  report.findings = findings(report);
  await writeFile(join(dir, "report.json"), JSON.stringify(report, null, 2));
  return { ok: true, value: report };
}

/// Deterministic, conservative statements about where the dimensions
/// disagree. No LLM: these are the claims most at risk of overstatement.
export function findings(r: ComparisonReport): Finding[] {
  const out: Finding[] = [];
  const rel = r.alignment?.value.relationship;
  const dir = r.co_movement?.ex_ante_direction;
  const ex = r.co_movement?.ex_ante;
  const opposed = rel === "opposing" || rel === "partly_conflicting";
  const agreeing = rel === "similar" || rel === "compatible";

  if (opposed && dir === "together") {
    out.push({ kind: "mismatch", text: "The opinions conflict, but the portfolios built from them have historically tended to move together." });
  }
  if (agreeing && dir === "apart") {
    out.push({ kind: "mismatch", text: "The opinions are compatible, but the portfolios built from them have historically tended to move apart." });
  }
  if (opposed && r.holdings_overlap && r.holdings_overlap.shared.length > 0) {
    out.push({ kind: "shared_holdings", text: `The opinions conflict, yet both portfolios hold ${r.holdings_overlap.shared.map((s) => s.ticker).join(", ")}.` });
  }
  if (ex && ex.rawCi95 && ex.residualCi95) {
    const raw = coMovementDirection(ex.rawCi95);
    const res = coMovementDirection(ex.residualCi95);
    if (raw !== res) {
      out.push({
        kind: "market_explains",
        text: `Raw co-movement is "${raw.replace(/_/g, " ")}" but "${res.replace(/_/g, " ")}" after removing each portfolio's market exposure (betas ${ex.a.beta.toFixed(2)} and ${ex.b.beta.toFixed(2)}): much of the relationship runs through how each portfolio rides the overall market.`,
      });
    }
  }
  return out;
}
