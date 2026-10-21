// What the browser receives. Tiingo's terms (1.6(c)) let us share summary
// results derived from its data, but not anything that displays its data or
// lets a viewer rebuild it. Tiingo confirmed by email (2026-10-21) that
// summary metrics, and portfolio-value charts for portfolios of two or more
// holdings, qualify. So the page gets summary metrics, plus a weekly value
// series for each side that holds at least two securities with none above
// 80% of invested weight. A one-security portfolio (with or without cash) is
// that security's price path rescaled, so it's never charted, and neither is
// the SPY benchmark.

import type { ChartPoint, ReportView } from "../lib/api.js";
import type { BacktestResult } from "../lib/backtest.js";
import type { ComparisonReport } from "../lib/compare.js";

export const MIN_CHARTED_HOLDINGS = 2;
/// Tiingo approved charts of "blended" holdings. A portfolio whose largest
/// holding is most of it is close to that one security's price path, so it
/// isn't charted either (our reading of "blended", matching NAMED.capShare).
export const MAX_CHARTED_SHARE = 0.8;

export function reportView(r: ComparisonReport): ReportView {
  const { backtests, window, ...rest } = r;
  const chart = (label: "A" | "B", bt: BacktestResult): ChartPoint[] | null => {
    const p = r.sides.find((s) => s.label === label)?.portfolio;
    const held = p?.positions.filter((x) => x.weight > 0) ?? [];
    const invested = held.reduce((s, x) => s + x.weight, 0);
    const blended = held.length >= MIN_CHARTED_HOLDINGS && held.every((x) => x.weight <= MAX_CHARTED_SHARE * invested + 1e-9);
    return blended ? weekly(bt.values) : null;
  };
  return {
    ...rest,
    window: window && { cutoff: window.cutoff, entry: window.entry, end: window.end, carriedForward: window.carriedForward, gapDays: window.gapDays },
    backtests: backtests && {
      a: { metrics: backtests.a.metrics, chart: chart("A", backtests.a) },
      b: { metrics: backtests.b.metrics, chart: chart("B", backtests.b) },
      benchmark: { metrics: backtests.benchmark.metrics, chart: null },
    },
  };
}

/// The first day, then the last trading day of each Monday-to-Sunday week
/// (so the window's final day is always included). Coarser than daily, so a
/// chart reveals less about the prices behind it.
export function weekly(values: ChartPoint[]): ChartPoint[] {
  const week = (date: string) => {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  };
  return values.filter((v, i) => i === 0 || i === values.length - 1 || week(v.date) !== week(values[i + 1]!.date));
}
