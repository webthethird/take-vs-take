// Moving-block bootstrap intervals for raw and residual correlation.
//
// A diagnostic, not part of the pipeline: it checks whether the Fisher
// interval's independence assumption is costing us anything on real data
// (src/cli/ci-check.ts). Days are resampled in blocks of consecutive days,
// with A, B and the benchmark kept together, so short-range dependence and
// the cross-section survive the resampling. The residual interval re-fits
// each side's β in every resample.
//
// Known weakness: a percentile bootstrap undercovers at small n. On the
// 26-day comparison windows it came out narrower than Fisher, so it must
// not be used to state a direction on short windows.
//
// Deterministic for a given seed. Pure; no I/O.

import { pearson, regress, type Interval } from "./overlap.js";

export type BootstrapOptions = { block: number; samples?: number; seed?: number };

export const DEFAULT_SAMPLES = 2000;
export const DEFAULT_SEED = 42;

export function blockBootstrapIntervals(
  ra: number[],
  rb: number[],
  rm: number[],
  { block, samples = DEFAULT_SAMPLES, seed = DEFAULT_SEED }: BootstrapOptions,
): { raw: Interval | null; residual: Interval | null } {
  const n = ra.length;
  if (rb.length !== n || rm.length !== n) throw new Error("Series must be the same length.");
  if (!Number.isInteger(block) || block < 1) throw new Error(`Block length must be a positive integer, got ${block}.`);
  if (n < 4) return { raw: null, residual: null };

  const rand = mulberry32(seed);
  const raw: number[] = [];
  const residual: number[] = [];
  const idx = new Array<number>(n);
  for (let k = 0; k < samples; k++) {
    // Circular blocks: a block starting near the end wraps to the start, so
    // every day is equally likely to be drawn.
    for (let i = 0; i < n; ) {
      const start = Math.floor(rand() * n);
      for (let j = 0; j < block && i < n; j++) idx[i++] = (start + j) % n;
    }
    const a = idx.map((i) => ra[i]!);
    const b = idx.map((i) => rb[i]!);
    const m = idx.map((i) => rm[i]!);
    const r = pearson(a, b);
    if (r !== null) raw.push(r);
    const q = pearson(regress(a, m).residuals, regress(b, m).residuals);
    if (q !== null && Number.isFinite(q)) residual.push(q);
  }
  return { raw: percentile95(raw, samples), residual: percentile95(residual, samples) };
}

/// 2.5th and 97.5th percentiles. Null if too many resamples were degenerate
/// (a constant series) for the tails to mean anything.
function percentile95(xs: number[], samples: number): Interval | null {
  if (xs.length < samples * 0.95) return null;
  xs.sort((x, y) => x - y);
  return [xs[Math.floor(0.025 * xs.length)]!, xs[Math.ceil(0.975 * xs.length) - 1]!];
}

/// Small seeded PRNG (mulberry32): reproducible, not cryptographic.
export function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
