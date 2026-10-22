// How two portfolios relate, numerically. Spec: docs/PLAN.md §5.
//
//   holdingsOverlap   — a plain fact: Σ min(wA, wB) over invested weight.
//   exAnteCorrelation — portfolio co-movement, estimated from the year BEFORE
//                       the posts. Raw ρ is primary; residual ρ (after
//                       regressing each side on SPY) and β are explanatory.
//   realizedCorrelation — the same, over the backtest window. An outcome,
//                       and labeled as one.
//
// None of this measures whether the *opinions* agree. Thesis alignment is a
// separate, LLM-judged dimension (PLAN.md §5.1); co-movement and alignment can
// disagree, and that mismatch is a finding, not an error.
//
// Why raw is primary: market exposure is part of a portfolio's economic
// character. On real data (PLAN.md §5.4) oil vs clean energy was −0.16 raw but
// +0.03 residual, because oil moved against the market that year. Residual
// removed exactly the opposition worth showing.
//
// Pure functions over fetched series; no I/O.

import type { BacktestResult } from "./backtest.js";
import { etDate, type PriceSeries } from "./prices.js";
import { err, type Result } from "./result.js";
import { tickerKey } from "./ticker.js";

export const OVERLAP_VERSION = "overlap-v1";
export const ESTIMATION_DAYS = 252;
/// A holding needs actual bars on this share of estimation days to be used.
export const MIN_HOLDING_COVERAGE = 0.9;
/// ...and the usable holdings must carry this share of invested weight.
export const MIN_WEIGHT_COVERAGE = 0.9;
/// Below this annualized volatility a side has too little market exposure
/// for its correlation to mean anything (e.g. mostly T-bills). Provisional.
export const MIN_ANNUAL_VOL = 0.03;
/// Below this annualized residual volatility a side is the benchmark in
/// disguise; its residual is noise and residual correlation is undefined.
export const MIN_RESIDUAL_VOL = 0.01;
const ANNUALIZE = Math.sqrt(252);

export type Holding = { ticker: string; weight: number };
export type Side = { holdings: Holding[]; cashWeight: number };

// ── Holdings overlap ─────────────────────────────────────────────────────

export type HoldingsOverlap = {
  /// Σ min of invested-weight shares, in [0, 1]. Cash is excluded on both
  /// sides, so the same stocks at different cash levels overlap fully.
  overlap: number;
  shared: { ticker: string; shareA: number; shareB: number }[];
};

export function holdingsOverlap(a: Side, b: Side): HoldingsOverlap {
  const shares = (s: Side) => {
    const total = s.holdings.reduce((x, h) => x + h.weight, 0);
    const m = new Map<string, number>();
    for (const h of s.holdings) {
      const k = tickerKey(h.ticker);
      m.set(k, (m.get(k) ?? 0) + h.weight / total);
    }
    return m;
  };
  const sa = shares(a);
  const sb = shares(b);
  const shared = [...sa.keys()]
    .filter((k) => sb.has(k))
    .sort()
    .map((k) => ({ ticker: k, shareA: sa.get(k)!, shareB: sb.get(k)! }));
  return { overlap: shared.reduce((x, s) => x + Math.min(s.shareA, s.shareB), 0), shared };
}

// ── Statistics ───────────────────────────────────────────────────────────

function mean(x: number[]): number {
  return x.reduce((s, v) => s + v, 0) / x.length;
}

function sampleStd(x: number[]): number {
  const m = mean(x);
  return Math.sqrt(x.reduce((s, v) => s + (v - m) ** 2, 0) / (x.length - 1));
}

/// Pearson correlation; null when either series is constant.
export function pearson(x: number[], y: number[]): number | null {
  if (x.length !== y.length || x.length < 2) throw new Error("pearson: need two equal-length series of length >= 2");
  const mx = mean(x);
  const my = mean(y);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < x.length; i++) {
    const dx = x[i]! - mx;
    const dy = y[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

/// OLS of y on x: y = α + βx + ε.
export function regress(y: number[], x: number[]): { alpha: number; beta: number; residuals: number[] } {
  const mx = mean(x);
  const my = mean(y);
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < x.length; i++) {
    sxy += (x[i]! - mx) * (y[i]! - my);
    sxx += (x[i]! - mx) ** 2;
  }
  const beta = sxy / sxx;
  const alpha = my - beta * mx;
  return { alpha, beta, residuals: y.map((v, i) => v - alpha - beta * x[i]!) };
}

export type SideStats = {
  /// Of the actual portfolio, cash included (cash scales β and vol, not ρ).
  beta: number;
  annualVol: number;
  residualAnnualVol: number;
};

export type Interval = [low: number, high: number];

export type CorrelationStats = {
  raw: number | null;
  rawCi95: Interval | null;
  residual: number | null;
  residualCi95: Interval | null;
  a: SideStats;
  b: SideStats;
  days: number;
  /// Why raw or residual is null, if either is.
  notes: string[];
};

/// Correlations of two aligned daily return series, raw and after removing
/// each side's benchmark beta. Applies the low-exposure guards.
export function correlationStats(ra: number[], rb: number[], rm: number[]): CorrelationStats {
  const side = (r: number[]) => {
    const reg = regress(r, rm);
    return { reg, stats: { beta: reg.beta, annualVol: sampleStd(r) * ANNUALIZE, residualAnnualVol: sampleStd(reg.residuals) * ANNUALIZE } };
  };
  const A = side(ra);
  const B = side(rb);
  const notes: string[] = [];

  let raw = pearson(ra, rb);
  let residual = pearson(A.reg.residuals, B.reg.residuals);
  for (const [name, s] of [["A", A.stats], ["B", B.stats]] as const) {
    if (s.annualVol < MIN_ANNUAL_VOL) {
      notes.push(`Side ${name} has minimal market exposure (annualized volatility ${(s.annualVol * 100).toFixed(2)}%).`);
      raw = null;
      residual = null;
    } else if (s.residualAnnualVol < MIN_RESIDUAL_VOL) {
      notes.push(`Side ${name} tracks the benchmark almost exactly (residual volatility ${(s.residualAnnualVol * 100).toFixed(2)}%); residual correlation is undefined.`);
      residual = null;
    }
  }
  if (raw === null && notes.length === 0) notes.push("A return series is constant.");
  const n = ra.length;
  return {
    raw,
    rawCi95: raw === null ? null : fisherInterval(raw, n),
    residual,
    residualCi95: residual === null ? null : fisherInterval(residual, n),
    a: A.stats,
    b: B.stats,
    days: n,
    notes,
  };
}

/// Approximate 95% interval for a Pearson ρ via the Fisher transform:
/// tanh(atanh ρ ± 1.96 / √(n − 3)). Assumes independent observations, which
/// daily returns are not (volatility clusters, tails are fat). Checked
/// against a moving-block bootstrap on the evaluation pairs (`pnpm ci-check`,
/// docs/PLAN.md §10 item 9): over the 252-day estimation window the two
/// agreed on every direction. Not checked in a crash-like regime.
/// Null when n < 4, where the formula is undefined.
export function fisherInterval(r: number, n: number): Interval | null {
  if (n < 4) return null;
  // atanh(±1) is infinite; a perfect correlation's interval is the point.
  if (Math.abs(r) >= 1) return [r, r];
  const z = Math.atanh(r);
  const h = 1.96 / Math.sqrt(n - 3);
  return [Math.tanh(z - h), Math.tanh(z + h)];
}

export type CoMovement = "together" | "apart" | "no_clear_relationship";

/// The only wording the comparison may use for co-movement. Deliberately has
/// no strength levels: a direction is stated only when the interval excludes
/// zero, and there's no calibrated basis yet for "strong" or "weak".
export function coMovementDirection(ci: Interval): CoMovement {
  if (ci[0] > 0) return "together";
  if (ci[1] < 0) return "apart";
  return "no_clear_relationship";
}

// ── Ex-ante ──────────────────────────────────────────────────────────────

export type ExAnteInput = {
  a: Side;
  b: Side;
  /// Series for every holding on both sides, covering the estimation window.
  prices: PriceSeries[];
  benchmark: PriceSeries;
  /// The later post's time. The window ends on the last trading day before
  /// its ET date, so nothing on or after the posts is used.
  cutoff: string;
};

export type ExAnteResult = CorrelationStats & {
  version: string;
  window: { start: string; end: string };
  coverage: { a: number; b: number };
  excluded: { side: "a" | "b"; ticker: string; coverage: number }[];
};

export type ExAnteError = "insufficient_history" | "missing_series";

export type ExAnteReturns = {
  /// Daily returns of A, B and the benchmark over the estimation window.
  ra: number[];
  rb: number[];
  rm: number[];
  window: ExAnteResult["window"];
  coverage: ExAnteResult["coverage"];
  excluded: ExAnteResult["excluded"];
};

export function exAnteCorrelation(input: ExAnteInput): Result<ExAnteResult, ExAnteError> {
  const r = exAnteReturns(input);
  if (!r.ok) return r;
  const { ra, rb, rm, ...rest } = r.value;
  return { ok: true, value: { version: OVERLAP_VERSION, ...correlationStats(ra, rb, rm), ...rest } };
}

/// The aligned daily return series exAnteCorrelation works on. Exported for
/// diagnostics (src/cli/ci-check.ts) that need the series, not just ρ.
export function exAnteReturns(input: ExAnteInput): Result<ExAnteReturns, ExAnteError> {
  const before = etDate(new Date(input.cutoff));
  const benchBars = input.benchmark.bars.filter((b) => b.date < before);
  if (benchBars.length < ESTIMATION_DAYS + 1) {
    return err("insufficient_history", `Benchmark has ${benchBars.length} trading days before ${before}; ${ESTIMATION_DAYS + 1} needed.`);
  }
  const window = benchBars.slice(-(ESTIMATION_DAYS + 1));
  const calendar = window.map((b) => b.date);
  const rm = returns(window.map((b) => b.adjClose));

  const byTicker = new Map(input.prices.map((s) => [tickerKey(s.ticker), s]));
  const excluded: ExAnteResult["excluded"] = [];

  const sideReturns = (side: Side, label: "a" | "b"): Result<{ r: number[]; coverage: number }, ExAnteError> => {
    const invested = side.holdings.reduce((s, h) => s + h.weight, 0);
    let usedWeight = 0;
    const r = new Array<number>(ESTIMATION_DAYS).fill(0);
    for (const h of [...side.holdings].sort((x, y) => (tickerKey(x.ticker) < tickerKey(y.ticker) ? -1 : 1))) {
      const key = tickerKey(h.ticker);
      const s = byTicker.get(key);
      if (!s) return err("missing_series", `No price series for ${key}.`);
      const path = alignedPrices(s, calendar);
      if (path.coverage < MIN_HOLDING_COVERAGE) {
        excluded.push({ side: label, ticker: key, coverage: path.coverage });
        continue;
      }
      usedWeight += h.weight;
      const hr = returns(path.prices);
      // Weights as fractions of the whole portfolio, so cash (0% return)
      // shows up in β and volatility. Excluded holdings are scaled back in
      // below by renormalising to the full invested weight.
      for (let t = 0; t < r.length; t++) r[t]! += (h.weight / 100) * hr[t]!;
    }
    const coverage = invested > 0 ? usedWeight / invested : 0;
    if (coverage < MIN_WEIGHT_COVERAGE) {
      return err(
        "insufficient_history",
        `Side ${label.toUpperCase()}: only ${(coverage * 100).toFixed(0)}% of invested weight has ${ESTIMATION_DAYS} days of history before the posts.`,
      );
    }
    const scale = invested / usedWeight;
    return { ok: true, value: { r: r.map((v) => v * scale), coverage } };
  };

  const A = sideReturns(input.a, "a");
  if (!A.ok) return A;
  const B = sideReturns(input.b, "b");
  if (!B.ok) return B;

  return {
    ok: true,
    value: {
      ra: A.value.r,
      rb: B.value.r,
      rm,
      window: { start: calendar[0]!, end: calendar.at(-1)! },
      coverage: { a: A.value.coverage, b: B.value.coverage },
      excluded,
    },
  };
}

/// adjClose on each calendar day, carrying the last bar forward over gaps;
/// days before a holding's first bar repeat its first price (return 0).
/// Coverage = share of calendar days with an actual bar.
function alignedPrices(s: PriceSeries, calendar: string[]): { prices: number[]; coverage: number } {
  const byDate = new Map(s.bars.map((b) => [b.date, b.adjClose]));
  const firstHit = calendar.find((d) => byDate.has(d));
  let last = firstHit !== undefined ? byDate.get(firstHit)! : 1;
  let hits = 0;
  const prices = calendar.map((d) => {
    const p = byDate.get(d);
    if (p !== undefined) {
      hits++;
      last = p;
    }
    return last;
  });
  return { prices, coverage: hits / calendar.length };
}

function returns(prices: number[]): number[] {
  const r: number[] = [];
  for (let i = 1; i < prices.length; i++) r.push(prices[i]! / prices[i - 1]! - 1);
  return r;
}

// ── Realized ─────────────────────────────────────────────────────────────

/// Correlation of the two buy-and-hold value paths over the backtest window,
/// against the benchmark's path. An outcome: show it labeled as such, never
/// as a property of the theses.
export function realizedCorrelation(a: BacktestResult, b: BacktestResult, benchmark: BacktestResult): Result<CorrelationStats, "misaligned"> {
  const dates = (r: BacktestResult) => r.values.map((v) => v.date).join(",");
  if (dates(a) !== dates(b) || dates(a) !== dates(benchmark)) {
    return err("misaligned", "Backtests must cover the same trading days.");
  }
  const r = (x: BacktestResult) => returns(x.values.map((v) => v.value));
  return { ok: true, value: correlationStats(r(a), r(b), r(benchmark)) };
}
