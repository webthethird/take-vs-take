// Deterministic weighting: PortfolioDraft (labels) -> Portfolio (weights).
// Spec: docs/PLAN.md §4.
//
// The model picks a concentration style, a cash level and a tier per
// position. Everything numeric happens here, so the same draft always yields
// the same weights and a reviewer can check them by hand.
//
// Two invariants:
//   - Every name in a tier gets the same weight. Weights are therefore left
//     unrounded (float64); rounding is a display concern, applied per tier.
//   - Tier weights are always in exact 3:2:1 point ratio. The per-name cap is
//     a validity bound, not an adjustment: a draft whose top tier would exceed
//     it is rejected. Clipping to the cap and re-splitting the excess was the
//     first design, and it erased the conviction the model expressed — e.g.
//     core 25% vs satellite 22.5% for a draft that said 3:1.

import type { CashLevel, Concentration, DraftPosition, PortfolioDraft, Tier } from "./schema.js";
import type { Result } from "./result.js";
import { tickerKey } from "./ticker.js";

export { tickerKey } from "./ticker.js";

/// Recorded in every frozen run so a later change to any table below can't
/// silently reinterpret an old result.
export const WEIGHT_RULE_VERSION = "tiers-v2";

// All three tables are provisional: fitted to 7 observed Supertake
// portfolios, mostly at bucket level.

export const STYLE: Record<Exclude<Concentration, "named">, { min: number; max: number; cap: number }> = {
  concentrated: { min: 3, max: 8, cap: 25 },
  balanced: { min: 8, max: 15, cap: 15 },
  diversified: { min: 15, max: 25, cap: 12 },
};

/// For readings built from what the author named (developer's decision,
/// 2026-10-21): as concentrated as the post, but never one holding, so the
/// portfolio can still be charted under the data license. The cap is a share
/// of invested weight, matching the chart rule in server/view.ts. With 3:2:1
/// tiers, two holdings split at most 75/25, so the cap can only bind if the
/// tier ratios ever change.
export const NAMED = { min: 2, max: 8, capShare: 0.8 };

/// Style bounds with the cap in percentage points of the whole portfolio.
export function styleBounds(c: Concentration, invested: number): { min: number; max: number; cap: number } {
  return c === "named" ? { min: NAMED.min, max: NAMED.max, cap: NAMED.capShare * invested } : STYLE[c];
}

export const CASH: Record<CashLevel, number> = {
  buffer: 5,
  standard: 10,
  defensive: 25,
  majority: 45,
};

export const TIER_POINTS: Record<Tier, number> = {
  core: 3,
  supporting: 2,
  satellite: 1,
};

const TIERS_DESC: Tier[] = ["core", "supporting", "satellite"];

/// Float tolerance for sum and cap checks. Weights are percentages, so 1e-9
/// is far below anything that could matter.
const EPS = 1e-9;

export type WeightedPosition = DraftPosition & { weight: number };

export type Portfolio = Omit<PortfolioDraft, "positions" | "buckets"> & {
  rule_version: string;
  cash_weight: number;
  invested_weight: number;
  cap: number;
  /// Weight per name in each tier present. Absent tiers are omitted.
  tier_weights: Partial<Record<Tier, number>>;
  positions: WeightedPosition[];
  buckets: { name: string; rationale: string; weight: number }[];
};

export type WeightError =
  | "count_out_of_range"
  | "duplicate_ticker"
  | "duplicate_bucket"
  | "unknown_bucket"
  | "empty_bucket"
  /// Even equal weights would breach the cap: needs more positions or cash.
  | "infeasible"
  /// The top tier would breach the cap; re-tiering could also fix it.
  | "cap_exceeded";

function fail(error: WeightError, message: string): { ok: false; error: WeightError; message: string } {
  return { ok: false, error, message };
}

/// Per-name weight for each tier, given counts: weight ∝ tier points. Pure
/// arithmetic, exposed for tests and for anyone checking a portfolio by hand.
/// Does not apply the cap; see weightPortfolio.
export function tierWeights(
  counts: Partial<Record<Tier, number>>,
  invested: number,
): Partial<Record<Tier, number>> {
  const present = TIERS_DESC.filter((t) => (counts[t] ?? 0) > 0);
  const points = present.reduce((s, t) => s + counts[t]! * TIER_POINTS[t], 0);
  const weights: Partial<Record<Tier, number>> = {};
  for (const t of present) weights[t] = (TIER_POINTS[t] * invested) / points;
  return weights;
}

export function weightPortfolio(draft: PortfolioDraft): Result<Portfolio, WeightError> {
  const cash = CASH[draft.cash_level];
  const invested = 100 - cash;
  const style = styleBounds(draft.concentration, invested);
  const n = draft.positions.length;

  if (n < style.min || n > style.max) {
    return fail(
      "count_out_of_range",
      `${draft.concentration} portfolios hold ${style.min}–${style.max} positions; draft has ${n}.`,
    );
  }

  const seenTickers = new Map<string, string>();
  for (const p of draft.positions) {
    const k = tickerKey(p.ticker);
    const prev = seenTickers.get(k);
    if (prev !== undefined) return fail("duplicate_ticker", `${p.ticker} duplicates ${prev}.`);
    seenTickers.set(k, p.ticker);
  }

  const bucketNames = new Set<string>();
  for (const b of draft.buckets) {
    if (bucketNames.has(b.name)) return fail("duplicate_bucket", `Bucket "${b.name}" is declared twice.`);
    bucketNames.add(b.name);
  }
  for (const p of draft.positions) {
    if (!bucketNames.has(p.bucket)) {
      return fail("unknown_bucket", `${p.ticker} is in undeclared bucket "${p.bucket}".`);
    }
  }
  for (const b of draft.buckets) {
    if (!draft.positions.some((p) => p.bucket === b.name)) {
      return fail("empty_bucket", `Bucket "${b.name}" has no positions.`);
    }
  }

  const counts: Partial<Record<Tier, number>> = {};
  for (const p of draft.positions) counts[p.tier] = (counts[p.tier] ?? 0) + 1;

  // Both rejections are deliberate. Raising cash, relaxing the cap or
  // re-tiering would silently change the interpretation the model chose; the
  // messages say what the model could change instead.
  if (n * style.cap < invested - EPS) {
    return fail(
      "infeasible",
      `${n} positions capped at ${round1(style.cap)}% hold at most ${round1(n * style.cap)}%, but ${invested}% must be invested. ` +
        `Add positions or choose a higher cash level.`,
    );
  }
  const tw = tierWeights(counts, invested);
  const top = TIERS_DESC.find((t) => tw[t] !== undefined)!;
  if (tw[top]! > style.cap + EPS) {
    return fail(
      "cap_exceeded",
      `Each ${top} position would weigh ${round1(tw[top]!)}%, over the ${round1(style.cap)}% cap for ${draft.concentration} portfolios. ` +
        `Add positions, choose a higher cash level, or move some ${top} names to a lower tier.`,
    );
  }

  const positions = draft.positions.map((p) => ({ ...p, weight: tw[p.tier]! }));
  const buckets = draft.buckets.map((b) => ({
    ...b,
    weight: positions.filter((p) => p.bucket === b.name).reduce((s, p) => s + p.weight, 0),
  }));

  const { positions: _p, buckets: _b, ...rest } = draft;
  return {
    ok: true,
    value: {
      ...rest,
      rule_version: WEIGHT_RULE_VERSION,
      cash_weight: cash,
      invested_weight: invested,
      cap: style.cap,
      tier_weights: tw,
      positions,
      buckets,
    },
  };
}

// ── Display ──────────────────────────────────────────────────────────────

/// One decimal, half away from zero. The epsilon nudge keeps values like
/// 2.85 (stored as 2.8499999…) from rounding down.
export function round1(x: number): number {
  return Math.sign(x) * Math.round(Math.abs(x) * 10 + 1e-9) / 10;
}

/// Total of the weights as displayed (each position at its tier's rounded
/// weight, plus cash). When this isn't 100 the UI must footnote it.
export function displayTotal(p: Portfolio): number {
  const invested = p.positions.reduce((s, pos) => s + round1(p.tier_weights[pos.tier]!), 0);
  return round1(invested + p.cash_weight);
}
