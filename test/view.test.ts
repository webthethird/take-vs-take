import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BacktestResult } from "../src/lib/backtest.js";
import type { ComparisonReport } from "../src/lib/compare.js";
import { reportView, weekly } from "../src/server/view.js";

// Two full weeks plus a Monday: Mon 2026-07-13 .. Mon 2026-07-27.
const calendar = ["2026-07-13", "2026-07-14", "2026-07-15", "2026-07-16", "2026-07-17", "2026-07-20", "2026-07-21", "2026-07-22", "2026-07-23", "2026-07-24", "2026-07-27"];
const window = { cutoff: "2026-07-10T08:29:33.028Z", entry: "2026-07-13", end: "2026-07-27", calendar };
const bt = (v: number): BacktestResult => ({
  version: "bt-v1",
  window,
  notional: 10_000,
  values: calendar.map((date, i) => ({ date, value: v + i })),
  holdings: [{ ticker: "XOM", weight: 1, endValue: v + 2, return: 0.0002 }],
  metrics: { cumulativeReturn: 0.0002, maxDrawdown: 0, annualizedVolatility: null, tradingDays: 10 },
  flags: [],
});
const side = (label: "A" | "B", tickers: string[], weights = tickers.map(() => 90 / tickers.length)) => ({
  label,
  portfolio: { positions: tickers.map((ticker, i) => ({ ticker, weight: weights[i]! })) },
});
const report = (a: string[], b: string[]) =>
  ({
    comparison_id: "c",
    sides: [side("A", a), side("B", b)],
    window: { ...window, carriedForward: true, gapDays: 13 },
    backtests: { a: bt(10_000), b: bt(20_000), benchmark: bt(30_000) },
  }) as unknown as ComparisonReport;

describe("reportView", () => {
  it("charts a side only when it holds at least two securities, and never the benchmark", () => {
    const v = reportView(report(["XOM", "CVX"], ["TAN"]));
    assert.deepEqual(
      v.backtests!.a.chart!.map((p) => p.date),
      ["2026-07-13", "2026-07-17", "2026-07-24", "2026-07-27"],
    );
    assert.equal(v.backtests!.b.chart, null, "one security plus cash is that security's price path");
    assert.equal(v.backtests!.benchmark.chart, null);
    assert.deepEqual(v.backtests!.b.metrics, report([], []).backtests!.b.metrics);
  });

  it("doesn't chart a portfolio one holding dominates (over 80% of invested weight)", () => {
    const r = (w: number[]) =>
      reportView({ ...report([], []), sides: [side("A", ["TSLA", "UFO"], w), side("B", ["X", "Y"])] } as unknown as ComparisonReport).backtests!.a.chart;
    assert.equal(r([75, 15]), null, "75 of 90 is 83%");
    assert.ok(r([72, 18]), "72 of 90 is exactly 80%");
    assert.ok(r([67.5, 22.5]));
  });

  it("never sends the trading calendar, per-holding values or daily series", () => {
    const wire = JSON.stringify(reportView(report(["XOM", "CVX"], ["TAN", "ICLN"])));
    assert.doesNotMatch(wire, /"values"|"holdings"|"calendar"|endValue/);
    // Daily points that aren't a week's last trading day stay on the server.
    assert.doesNotMatch(wire, /2026-07-14|2026-07-21/);
    assert.match(wire, /2026-07-17/);
  });

  it("passes a report without backtests through", () => {
    const v = reportView({ ...report(["A1", "A2"], ["B1", "B2"]), backtests: null, window: null });
    assert.equal(v.backtests, null);
    assert.equal(v.window, null);
  });
});

describe("weekly", () => {
  it("keeps the first day, each week's last trading day, and the final day", () => {
    const pts = (ds: string[]) => ds.map((date) => ({ date, value: 1 }));
    // A Friday holiday: Thursday ends that week.
    assert.deepEqual(
      weekly(pts(["2026-07-01", "2026-07-02", "2026-07-06", "2026-07-07"])).map((p) => p.date),
      ["2026-07-01", "2026-07-02", "2026-07-07"],
    );
    assert.deepEqual(weekly(pts(["2026-07-01"])).map((p) => p.date), ["2026-07-01"]);
    assert.deepEqual(weekly([]), []);
  });
});
