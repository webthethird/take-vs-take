// What the browser receives. Tiingo's terms (1.6(c)) let us share summary
// results derived from its data (returns, drawdowns, correlations), but not
// anything that displays its data or lets a viewer rebuild it, such as a
// daily value series. So the page gets summary metrics only: the daily
// series and per-holding values stay on the server and are discarded.

import type { ReportView } from "../lib/api.js";
import type { ComparisonReport } from "../lib/compare.js";

export function reportView(r: ComparisonReport): ReportView {
  const { backtests, window, ...rest } = r;
  return {
    ...rest,
    window: window && { cutoff: window.cutoff, entry: window.entry, end: window.end, carriedForward: window.carriedForward, gapDays: window.gapDays },
    backtests: backtests && {
      a: { metrics: backtests.a.metrics },
      b: { metrics: backtests.b.metrics },
      benchmark: { metrics: backtests.benchmark.metrics },
    },
  };
}
