import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BacktestResult } from "../src/lib/backtest.js";
import type { ComparisonReport } from "../src/lib/compare.js";
import { reportView } from "../src/server/view.js";

const window = { cutoff: "2026-07-16T08:29:33.028Z", entry: "2026-07-17", end: "2026-07-21", calendar: ["2026-07-17", "2026-07-20", "2026-07-21"] };
const bt = (v: number): BacktestResult => ({
  version: "bt-v1",
  window,
  notional: 10_000,
  values: window.calendar.map((date, i) => ({ date, value: v + i })),
  holdings: [{ ticker: "XOM", weight: 1, endValue: v + 2, return: 0.0002 }],
  metrics: { cumulativeReturn: 0.0002, maxDrawdown: 0, annualizedVolatility: null, tradingDays: 2 },
  flags: [],
});
const report = {
  comparison_id: "c",
  window: { ...window, carriedForward: true, gapDays: 13 },
  backtests: { a: bt(10_000), b: bt(10_001), benchmark: bt(10_002) },
} as unknown as ComparisonReport;

describe("reportView", () => {
  it("keeps summary metrics and drops every daily series and per-holding value", () => {
    const v = reportView(report);
    assert.deepEqual(v.backtests!.a, { metrics: report.backtests!.a.metrics });
    assert.deepEqual(v.window, { cutoff: window.cutoff, entry: window.entry, end: window.end, carriedForward: true, gapDays: 13 });
    const wire = JSON.stringify(v);
    assert.doesNotMatch(wire, /"values"|"holdings"|"calendar"|endValue|2026-07-20/);
  });

  it("passes a report without backtests through", () => {
    const v = reportView({ ...report, backtests: null, window: null });
    assert.equal(v.backtests, null);
    assert.equal(v.window, null);
  });
});
