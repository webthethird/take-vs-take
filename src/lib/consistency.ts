// Self-consistency: is one run's headline a stable result, or a draw?
//
// Each side is built N times from scratch (analysis + default draft), each
// with its own nonce so the model is sampled afresh. The prompt is identical
// across samples; the nonce only changes the cache key. Sample 0 has no
// nonce: it is the same run compare() produces, replayed from cache.
//
// The same discipline as compare() (docs/PLAN.md §5.5, §7): every sample is
// frozen to disk before the LookAheadGate is unlocked.
//
// What it measures:
//   within a side:   how much the side's samples agree with each other
//                    (holdings overlap, ex-ante raw ρ between samples).
//   between sides:   every A-sample x B-sample pairing, so the headline
//                    direction becomes a count instead of one draw.
// Alternate readings and thesis alignment are not sampled (cost).

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKTEST_VERSION, backtest, benchmarkBacktest, commonWindow, type BacktestResult, type WindowResult } from "./backtest.js";
import { BENCHMARK, MODEL_TRAINING_CUTOFF, buildSide, freeze, stanceConflicts, type CompareDeps, type FrozenRun } from "./compare.js";
import { ANALYZE_PROMPT_VERSION, DRAFT_PROMPT_VERSION } from "./interpret.js";
import { OVERLAP_VERSION, coMovementDirection, exAnteCorrelation, holdingsOverlap, type CoMovement } from "./overlap.js";
import { LookAheadGate, etDate, type PriceSeries } from "./prices.js";
import { err, type Result } from "./result.js";
import type { PostInput } from "./schema.js";
import { WEIGHT_RULE_VERSION, type Portfolio } from "./weights.js";

export const CONSISTENCY_VERSION = "sc-v1";
export const DEFAULT_SAMPLES = 5;
export const MAX_SAMPLES = 10;

/// Sample 0 is the plain run (no nonce), so it replays compare()'s cache.
export const sampleNonce = (k: number): string | undefined => (k === 0 ? undefined : `sc-${k}`);

/// Failures that say nothing about the model: stop, so a rerun can resume
/// from cache. Anything else (refusal, truncation, invalid after repair) is
/// a property of the model's behaviour and is recorded as that sample's
/// outcome.
const INFRASTRUCTURE = new Set(["budget_exceeded", "api_error", "ticker_check_unavailable"]);

export type Sample = {
  side: "A" | "B";
  sample: number;
  nonce: string | null;
  run: FrozenRun | null;
  /// Set when the model failed to produce a usable result for this sample.
  error: string | null;
  /// Equal to an earlier sample's index when the portfolio is identical.
  same_portfolio_as: number | null;
  stance_conflicts: string[];
  /// Outcome over the common window; filled only after unlocking.
  metrics: BacktestResult["metrics"] | null;
  metrics_error: string | null;
};

export type SamplePair = {
  a: number;
  b: number;
  holdings_overlap: number;
  ex_ante_raw: number | null;
  ex_ante_raw_ci95: [number, number] | null;
  direction: CoMovement | null;
  ex_ante_residual: number | null;
  residual_direction: CoMovement | null;
  error: string | null;
};

export type SideSummary = {
  samples: number;
  statuses: Record<string, number>;
  failed: number;
  built: number;
  distinct_portfolios: number;
  /// Default reading label per built sample, counted.
  readings: Record<string, number>;
  /// Pairwise between this side's built samples.
  holdings_overlap: { mean: number; min: number; max: number } | null;
  ex_ante_raw: { min: number; max: number } | null;
};

export type ConsistencySummary = {
  A: SideSummary;
  B: SideSummary;
  between: {
    pairs: number;
    direction: Record<CoMovement | "unavailable", number>;
    residual_direction: Record<CoMovement | "unavailable", number>;
    ex_ante_raw: { min: number; max: number } | null;
    holdings_overlap: { mean: number; min: number; max: number } | null;
    headline: CoMovement | null;
  };
};

export type ConsistencyReport = {
  comparison_id: string;
  created_at: string;
  versions: Record<string, string>;
  n: number;
  window: WindowResult | null;
  caveats: string[];
  samples: Sample[];
  within: { A: SamplePair[]; B: SamplePair[] };
  between: SamplePair[];
  summary: ConsistencySummary;
  findings: string[];
  llm_cost_usd: number;
};

export type ConsistencyError = "invalid_request" | "aborted" | "freeze_error" | "price_error" | "window_error";

const shift = (d: string, days: number) => new Date(Date.parse(`${d}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const side = (p: Portfolio) => ({ holdings: p.positions.map((x) => ({ ticker: x.ticker, weight: x.weight })), cashWeight: p.cash_weight });
const portfolioKey = (p: Portfolio) => JSON.stringify([p.cash_weight, [...p.positions].map((x) => [x.ticker, x.weight]).sort()]);

export async function selfConsistency(deps: CompareDeps, postA: PostInput, postB: PostInput, n = DEFAULT_SAMPLES): Promise<Result<ConsistencyReport, ConsistencyError>> {
  if (!Number.isInteger(n) || n < 2 || n > MAX_SAMPLES) return err("invalid_request", `Samples must be an integer from 2 to ${MAX_SAMPLES}.`);
  const now = deps.now ?? (() => new Date());
  const cutoff = new Date(Math.max(Date.parse(postA.created_at), Date.parse(postB.created_at)));
  const gate = new LookAheadGate(deps.prices, cutoff);
  const comparison_id = createHash("sha256").update(`${postA.post_id}|${postB.post_id}`).digest("hex").slice(0, 12);
  const dir = join(deps.outDir, `consistency-${comparison_id}`);
  await mkdir(dir, { recursive: true });

  // 1. Every sample of each side, independently. Alternates off: this
  //    measures the headline's stability, not the readings'.
  const sampleDeps = { ...deps, alternates: false };
  const samples: Sample[] = [];
  let llm_cost_usd = 0;
  for (const [label, post] of [["A", postA], ["B", postB]] as const) {
    for (let k = 0; k < n; k++) {
      const nonce = sampleNonce(k);
      const s = await buildSide(sampleDeps, gate, label, post, { nonce });
      const attempts = s.ok ? s.value.attempts : s.attempts;
      llm_cost_usd += attempts.reduce((t, a) => t + a.cost_usd, 0);
      if (!s.ok && INFRASTRUCTURE.has(s.cause)) {
        return err("aborted", `${s.message} (completed samples are cached; rerunning resumes)`);
      }
      const base = { side: label, sample: k, nonce: nonce ?? null, same_portfolio_as: null, stance_conflicts: [], metrics: null, metrics_error: null };
      if (!s.ok) {
        samples.push({ ...base, run: null, error: `${s.cause}: ${s.message}` });
        continue;
      }
      const run = freeze(s.value, now());
      const p = run.portfolio;
      const first = p && samples.find((x) => x.side === label && x.run?.portfolio && portfolioKey(x.run.portfolio) === portfolioKey(p));
      samples.push({ ...base, run, error: null, same_portfolio_as: first ? first.sample : null, stance_conflicts: p ? stanceConflicts(run.analysis, p) : [] });
    }
  }

  // 2. Freeze every sample before any outcome is read.
  try {
    await writeFile(join(dir, "samples.json"), JSON.stringify(samples, null, 2));
  } catch (e) {
    return err("freeze_error", `Could not write samples: ${(e as Error).message}`);
  }

  const caveats = [
    "Hypothetical, AI-generated interpretations of public posts. The authors did not choose, hold or endorse these portfolios. Not investment advice.",
    "Each sample is an independent run of the same prompts. Agreement between samples is consistency, not correctness: a model can be consistently wrong.",
  ];
  const report: ConsistencyReport = {
    comparison_id,
    created_at: now().toISOString(),
    versions: { consistency: CONSISTENCY_VERSION, analyze: ANALYZE_PROMPT_VERSION, draft: DRAFT_PROMPT_VERSION, weights: WEIGHT_RULE_VERSION, backtest: BACKTEST_VERSION, overlap: OVERLAP_VERSION },
    n,
    window: null,
    caveats,
    samples,
    within: { A: [], B: [] },
    between: [],
    summary: summarize(n, samples, { A: [], B: [] }, []),
    findings: [],
    llm_cost_usd,
  };
  const built = (label: "A" | "B") => samples.filter((s) => s.side === label && s.run?.portfolio);
  if (built("A").length === 0 || built("B").length === 0) {
    report.findings = consistencyFindings(report);
    if (deps.persistReport) await writeReport(dir, report);
    return { ok: true, value: report };
  }

  // 3. Unlock, then read outcomes.
  const runs = samples.flatMap((s) => (s.run ? [{ run_id: s.run.run_id, frozen_at: s.run.frozen_at }] : []));
  const u = gate.unlock(runs, now());
  if (!u.ok) return err("freeze_error", u.message);

  const cutoffDay = etDate(cutoff);
  const start = shift(cutoffDay, -400);
  const end = deps.end ?? etDate(now());
  const tickers = [...new Set(samples.flatMap((s) => s.run?.portfolio?.positions.map((x) => x.ticker) ?? []))].sort();
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
  if (w.value.carriedForward) caveats.push(`The posts are ${Math.round(w.value.gapDays)} days apart. The earlier thesis is evaluated as of the later post's date.`);
  const earliest = etDate(new Date(Math.min(Date.parse(postA.created_at), Date.parse(postB.created_at))));
  if (earliest <= MODEL_TRAINING_CUTOFF) caveats.push(`At least one post predates the interpretation model's training cutoff (${MODEL_TRAINING_CUTOFF}).`);
  const bm = benchmarkBacktest(bench, w.value);
  if (!bm.ok) return err("price_error", `Benchmark: ${bm.message}`);

  for (const s of samples) {
    if (!s.run?.portfolio) continue;
    const b = backtest({ ...side(s.run.portfolio), prices: series, window: w.value });
    s.metrics = b.ok ? b.value.metrics : null;
    s.metrics_error = b.ok ? null : `${b.error}: ${b.message}`;
  }

  const pair = (x: Sample, y: Sample): SamplePair => {
    const pa = side(x.run!.portfolio!);
    const pb = side(y.run!.portfolio!);
    const ex = exAnteCorrelation({ a: pa, b: pb, prices: series, benchmark: bench, cutoff: cutoff.toISOString() });
    return {
      a: x.sample,
      b: y.sample,
      holdings_overlap: holdingsOverlap(pa, pb).overlap,
      ex_ante_raw: ex.ok ? ex.value.raw : null,
      ex_ante_raw_ci95: ex.ok ? ex.value.rawCi95 : null,
      direction: ex.ok && ex.value.rawCi95 ? coMovementDirection(ex.value.rawCi95) : null,
      ex_ante_residual: ex.ok ? ex.value.residual : null,
      residual_direction: ex.ok && ex.value.residualCi95 ? coMovementDirection(ex.value.residualCi95) : null,
      error: ex.ok ? null : ex.message,
    };
  };
  for (const label of ["A", "B"] as const) {
    const xs = built(label);
    for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) report.within[label].push(pair(xs[i]!, xs[j]!));
  }
  for (const x of built("A")) for (const y of built("B")) report.between.push(pair(x, y));

  report.summary = summarize(n, samples, report.within, report.between);
  report.findings = consistencyFindings(report);
  // Derived from prices: saved only when the plan allows (see compare()).
  if (deps.persistReport) await writeReport(dir, report);
  return { ok: true, value: report };
}

async function writeReport(dir: string, report: ConsistencyReport) {
  await writeFile(join(dir, "report.json"), JSON.stringify(report, null, 2));
}

function range(xs: number[]) {
  return xs.length ? { min: Math.min(...xs), max: Math.max(...xs) } : null;
}
function spread(xs: number[]) {
  return xs.length ? { mean: xs.reduce((s, x) => s + x, 0) / xs.length, ...range(xs)! } : null;
}
function count<K extends string>(keys: K[], init: Record<K, number>): Record<K, number> {
  const out = { ...init };
  for (const k of keys) out[k] = (out[k] ?? 0) + 1;
  return out;
}

export function summarize(n: number, samples: Sample[], within: { A: SamplePair[]; B: SamplePair[] }, between: SamplePair[]): ConsistencySummary {
  const sideSummary = (label: "A" | "B"): SideSummary => {
    const xs = samples.filter((s) => s.side === label);
    const built = xs.filter((s) => s.run?.portfolio);
    return {
      samples: n,
      statuses: count(xs.flatMap((s) => (s.run ? [s.run.analysis.status] : [])), {} as Record<string, number>),
      failed: xs.filter((s) => s.error).length,
      built: built.length,
      distinct_portfolios: built.filter((s) => s.same_portfolio_as === null).length,
      readings: count(
        built.map((s) => s.run!.analysis.interpretations.find((i) => i.id === s.run!.analysis.default_interpretation)?.label ?? "?"),
        {} as Record<string, number>,
      ),
      holdings_overlap: spread(within[label].map((p) => p.holdings_overlap)),
      ex_ante_raw: range(within[label].flatMap((p) => (p.ex_ante_raw === null ? [] : [p.ex_ante_raw]))),
    };
  };
  const zero = { together: 0, apart: 0, no_clear_relationship: 0, unavailable: 0 };
  return {
    A: sideSummary("A"),
    B: sideSummary("B"),
    between: {
      pairs: between.length,
      direction: count(between.map((p) => p.direction ?? "unavailable"), zero),
      residual_direction: count(between.map((p) => p.residual_direction ?? "unavailable"), zero),
      ex_ante_raw: range(between.flatMap((p) => (p.ex_ante_raw === null ? [] : [p.ex_ante_raw]))),
      holdings_overlap: spread(between.map((p) => p.holdings_overlap)),
      headline: between.find((p) => p.a === 0 && p.b === 0)?.direction ?? null,
    },
  };
}

/// Plain counts, deterministic. The point is to replace a single label with
/// a frequency, and to say when one run's label would have misled.
export function consistencyFindings(r: ConsistencyReport): string[] {
  const out: string[] = [];
  const words = (d: string) => d.replace(/_/g, " ");
  for (const label of ["A", "B"] as const) {
    const s = r.summary[label];
    const statuses = Object.entries(s.statuses);
    if (statuses.length > 1) {
      out.push(`Post ${label} was not judged the same way every time: ${statuses.map(([k, v]) => `${words(k)} in ${v}`).join(", ")} of ${s.samples} samples.`);
    }
    if (s.failed > 0) out.push(`Post ${label}: ${s.failed} of ${s.samples} samples produced no usable result.`);
    if (s.built >= 2 && s.distinct_portfolios === 1) out.push(`Post ${label} produced the same portfolio in all ${s.built} built samples.`);
  }
  const b = r.summary.between;
  if (b.pairs > 0) {
    const d = b.direction;
    const parts = (["together", "apart", "no_clear_relationship", "unavailable"] as const).filter((k) => d[k] > 0).map((k) => `${words(k)} in ${d[k]}`);
    out.push(`Raw co-movement across all ${b.pairs} sample pairings: ${parts.join(", ")}.`);
    if (d.together > 0 && d.apart > 0) {
      out.push("Some pairings move together and others apart: a single run's co-movement label for these posts is not reliable.");
    }
    const top = Math.max(d.together, d.apart, d.no_clear_relationship);
    if (b.headline && d[b.headline] < top) {
      out.push(`The plain run (sample 0 x sample 0) says "${words(b.headline)}", which is not the most common result across samples.`);
    }
    const rd = b.residual_direction;
    const rparts = (["together", "apart", "no_clear_relationship", "unavailable"] as const).filter((k) => rd[k] > 0).map((k) => `${words(k)} in ${rd[k]}`);
    out.push(`Residual co-movement (beyond the market) across the same pairings: ${rparts.join(", ")}.`);
  }
  return out;
}
