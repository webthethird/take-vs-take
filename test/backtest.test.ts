import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MIN_WINDOW_DAYS,
  backtest,
  benchmarkBacktest,
  commonWindow,
  metrics,
  rawTotalReturn,
  type Holding,
  type Window,
} from "../src/lib/backtest.js";
import type { PriceBar, PriceSeries } from "../src/lib/prices.js";

// Synthetic data only. Real provider data stays out of the repo (Tiingo's
// free tier is licensed for personal use, not redistribution).

const D = ["2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05", "2026-03-06"]; // Mon–Fri

function bars(dates: string[], closes: number[], adj?: number[], extra: Partial<PriceBar>[] = []): PriceBar[] {
  return dates.map((date, i) => ({
    date,
    close: closes[i]!,
    adjClose: (adj ?? closes)[i]!,
    divCash: 0,
    splitFactor: 1,
    ...extra[i],
  }));
}

function series(ticker: string, b: PriceBar[]): PriceSeries {
  return { ticker, source: "fixture", start: b[0]!.date, end: b.at(-1)!.date, fetched_at: "2026-01-01T00:00:00.000Z", bars: b };
}

function win(calendar = D): Window {
  return { cutoff: "2026-02-27T15:00:00.000Z", entry: calendar[0]!, end: calendar.at(-1)!, calendar };
}

function run(holdings: Holding[], cashWeight: number, prices: PriceSeries[], window = win()) {
  const r = backtest({ holdings, cashWeight, prices, window });
  if (!r.ok) assert.fail(`${r.error}: ${r.message}`);
  return r.value;
}

const close = (a: number, b: number, msg = "") => assert.ok(Math.abs(a - b) < 1e-9, `${msg} expected ${b}, got ${a}`);

describe("valuation", () => {
  it("50/50: one asset doubles, one is flat -> +50%", () => {
    const r = run(
      [{ ticker: "UP", weight: 50 }, { ticker: "FLAT", weight: 50 }],
      0,
      [series("UP", bars(D, [10, 12, 14, 16, 20])), series("FLAT", bars(D, [5, 5, 5, 5, 5]))],
    );
    // 5,000 × 2 + 5,000 × 1 = 15,000
    close(r.values.at(-1)!.value, 15_000);
    close(r.metrics.cumulativeReturn, 0.5);
    assert.deepEqual(r.flags, []);
  });

  it("cash earns nothing: 90% asset +10%, 10% cash -> +9%", () => {
    const r = run([{ ticker: "A", weight: 90 }], 10, [series("A", bars(D, [100, 101, 105, 108, 110]))]);
    // 9,000 × 1.1 + 1,000 = 10,900
    close(r.values.at(-1)!.value, 10_900);
    close(r.metrics.cumulativeReturn, 0.09);
  });

  it("values every calendar day and starts at the notional", () => {
    const r = run([{ ticker: "A", weight: 100 }], 0, [series("A", bars(D, [100, 110, 99, 120, 108]))]);
    assert.deepEqual(r.values.map((v) => v.date), D);
    assert.deepEqual(r.values.map((v) => Math.round(v.value * 1e6) / 1e6), [10_000, 11_000, 9_900, 12_000, 10_800]);
  });

  it("a 2:1 split is not a 50% loss", () => {
    // Raw close halves on the split day; adjClose is continuous.
    const b = bars(D, [100, 102, 51, 52, 53], [50, 51, 51, 52, 53], [{}, {}, { splitFactor: 2 }]);
    const r = run([{ ticker: "S", weight: 100 }], 0, [series("S", b)]);
    // adjClose 53 / 50 = 1.06
    close(r.metrics.cumulativeReturn, 0.06);
    assert.deepEqual(r.flags, []); // our raw computation agrees with adjClose
  });

  it("a dividend counts as return: price drops by the dividend, total return flat", () => {
    // $2 dividend, ex-date day 3: close 100 -> 98, holder also gets 2.
    const b = bars(D, [100, 100, 98, 98, 98], [98, 98, 98, 98, 98], [{}, {}, { divCash: 2 }]);
    const r = run([{ ticker: "DIV", weight: 100 }], 0, [series("DIV", b)]);
    close(r.metrics.cumulativeReturn, 0);
    assert.deepEqual(r.flags, []);
  });

  it("flags a provider adjClose that ignores a split", () => {
    // Broken provider data: adjClose equals raw close across a 2:1 split.
    const b = bars(D, [100, 102, 51, 52, 53], undefined, [{}, {}, { splitFactor: 2 }]);
    const r = run([{ ticker: "S", weight: 100 }], 0, [series("S", b)]);
    const f = r.flags.find((x) => x.kind === "adjustment_mismatch");
    assert.ok(f, "expected adjustment_mismatch");
    if (f?.kind === "adjustment_mismatch") {
      close(f.adjReturn, -0.47); // 53/100 − 1: the fake loss
      close(f.rawReturn, 0.06);
    }
  });

  it("ignores bars before entry and after end", () => {
    const wider = ["2026-02-27", ...D, "2026-03-09"];
    const r = run([{ ticker: "A", weight: 100 }], 0, [series("A", bars(wider, [1, 100, 100, 100, 100, 110, 1000]))]);
    close(r.metrics.cumulativeReturn, 0.1);
  });

  it("holding order changes nothing", () => {
    const prices = [series("A", bars(D, [1, 2, 3, 4, 5])), series("B", bars(D, [5, 4, 3, 2, 1]))];
    const x = run([{ ticker: "A", weight: 60 }, { ticker: "B", weight: 40 }], 0, prices);
    const y = run([{ ticker: "B", weight: 40 }, { ticker: "A", weight: 60 }], 0, [...prices].reverse());
    assert.deepEqual(x, y);
  });

  it("matches the benchmark run of the same series", () => {
    const s = series("SPY", bars(D, [100, 99, 101, 103, 102]));
    const r = benchmarkBacktest(s, win());
    assert.ok(r.ok);
    if (r.ok) close(r.value.metrics.cumulativeReturn, 0.02);
  });
});

describe("missing data", () => {
  it("carries the last value through a gap and flags it", () => {
    const gappy = bars([D[0]!, D[1]!, D[3]!, D[4]!], [100, 110, 120, 130]); // no bar on D[2]
    const r = run([{ ticker: "G", weight: 100 }], 0, [series("G", gappy)]);
    close(r.values[2]!.value, 11_000); // carried from D[1]
    assert.deepEqual(r.flags, [{ kind: "gap", ticker: "G", date: D[2] }]);
    close(r.metrics.cumulativeReturn, 0.3);
  });

  it("freezes a series that stops early and flags possible delisting", () => {
    const ended = bars(D.slice(0, 3), [100, 90, 80]);
    const r = run([{ ticker: "X", weight: 50 }, { ticker: "Y", weight: 50 }], 0, [series("X", ended), series("Y", bars(D, [1, 1, 1, 1, 1]))]);
    close(r.values.at(-1)!.value, 4_000 + 5_000);
    assert.deepEqual(r.flags, [{ kind: "series_ended", ticker: "X", lastDate: D[2] }]);
  });

  it("fails when a holding has no entry-day price, rather than dropping it", () => {
    const late = bars(D.slice(1), [100, 100, 100, 100]);
    const r = backtest({ holdings: [{ ticker: "L", weight: 100 }], cashWeight: 0, prices: [series("L", late)], window: win() });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, "no_entry_price");
  });

  it("fails when a holding has no series at all", () => {
    const r = backtest({ holdings: [{ ticker: "NOPE", weight: 100 }], cashWeight: 0, prices: [], window: win() });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, "missing_series");
  });

  it("flags bars on non-trading days", () => {
    const withSat = bars([D[0]!, "2026-03-07"], [100, 100]);
    const r = run([{ ticker: "W", weight: 100 }], 0, [series("W", withSat)], win([D[0]!, "2026-03-09"]));
    assert.ok(r.flags.some((f) => f.kind === "off_calendar" && f.date === "2026-03-07"));
  });
});

describe("portfolio validation", () => {
  const prices = [series("A", bars(D, [1, 1, 1, 1, 1])), series("B", bars(D, [1, 1, 1, 1, 1]))];
  const bad: [string, Holding[], number][] = [
    ["sum under 100", [{ ticker: "A", weight: 50 }], 10],
    ["sum over 100", [{ ticker: "A", weight: 95 }], 10],
    ["zero weight", [{ ticker: "A", weight: 0 }, { ticker: "B", weight: 100 }], 0],
    ["negative cash", [{ ticker: "A", weight: 110 }], -10],
    ["duplicate spellings", [{ ticker: "A", weight: 50 }, { ticker: "a", weight: 50 }], 0],
  ];
  for (const [name, holdings, cash] of bad) {
    it(`rejects ${name}`, () => {
      const r = backtest({ holdings, cashWeight: cash, prices, window: win() });
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.error, "invalid_portfolio");
    });
  }

  it("accepts tier weights that only sum to 100 within float tolerance", () => {
    // 55/7 × 3 × 2 + 55/7 + 45 — the barbell from weights.ts.
    const w = 55 / 7;
    const r = backtest({
      holdings: [{ ticker: "A", weight: 3 * w }, { ticker: "B", weight: 3 * w }, { ticker: "C", weight: w }],
      cashWeight: 45,
      prices: [...prices, series("C", bars(D, [1, 1, 1, 1, 1]))],
      window: win(),
    });
    assert.ok(r.ok, !r.ok ? r.message : "");
  });
});

describe("metrics", () => {
  it("max drawdown is peak to trough", () => {
    close(metrics([100, 120, 90, 110]).maxDrawdown, 0.25); // 90 / 120
    close(metrics([100, 110, 120]).maxDrawdown, 0);
    close(metrics([100, 50, 200, 100]).maxDrawdown, 0.5); // the later, larger peak counts
  });

  it("annualised volatility is the sample stdev of daily returns × √252", () => {
    // Daily returns +10%, −10%: mean 0, sample variance 0.02, stdev √0.02.
    const m = metrics([100, 110, 99]);
    close(m.annualizedVolatility!, Math.sqrt(0.02) * Math.sqrt(252));
    assert.equal(m.tradingDays, 2);
  });

  it("volatility is null with fewer than two returns", () => {
    assert.equal(metrics([100, 101]).annualizedVolatility, null);
    assert.equal(metrics([100]).annualizedVolatility, null);
  });
});

describe("rawTotalReturn", () => {
  it("reinvests dividends at the ex-date close and applies split factors", () => {
    const b = bars(["d1", "d2", "d3"] as string[], [100, 49, 50], undefined, [{}, { splitFactor: 2, divCash: 0 }, { divCash: 1 }]);
    // (49·2)/100 = 0.98; (50 + 1)/49 ≈ 1.040816; product ≈ 1.02
    close(rawTotalReturn(b), 0.98 * (51 / 49));
  });
});

describe("commonWindow", () => {
  // 25 weekdays from Mon 2026-03-02 (no holidays in range).
  const days: string[] = [];
  for (let d = new Date("2026-03-02T12:00:00Z"); days.length < 25; d.setUTCDate(d.getUTCDate() + 1)) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) days.push(d.toISOString().slice(0, 10));
  }
  const bench = bars(days, days.map(() => 100));

  it("uses the later post as cutoff and enters the next trading day", () => {
    // B is later: Mon 2026-03-02 10:03 ET. Never enter on the post's own day.
    const r = commonWindow({ createdA: "2026-02-20T15:00:00Z", createdB: "2026-03-02T15:03:00Z", benchmark: bench });
    assert.ok(r.ok, !r.ok ? r.message : "");
    if (!r.ok) return;
    assert.equal(r.value.cutoff, "2026-03-02T15:03:00.000Z");
    assert.equal(r.value.entry, "2026-03-03");
    assert.equal(r.value.end, days.at(-1));
  });

  it("is symmetric in A and B", () => {
    const x = commonWindow({ createdA: "2026-02-20T15:00:00Z", createdB: "2026-03-02T15:03:00Z", benchmark: bench });
    const y = commonWindow({ createdA: "2026-03-02T15:03:00Z", createdB: "2026-02-20T15:00:00Z", benchmark: bench });
    assert.deepEqual(x, y);
  });

  it("a Friday-evening post enters Monday; a weekend post enters Monday", () => {
    // Fri 2026-02-27 23:00 ET = Sat 04:00 UTC: its ET date is still Friday.
    for (const t of ["2026-02-28T04:00:00Z", "2026-03-01T17:00:00Z"]) {
      const r = commonWindow({ createdA: t, createdB: "2026-02-01T00:00:00Z", benchmark: bench });
      assert.ok(r.ok);
      if (r.ok) assert.equal(r.value.entry, "2026-03-02");
    }
  });

  it("uses the ET date near midnight: 23:30 ET Monday enters Tuesday", () => {
    const r = commonWindow({ createdA: "2026-03-03T04:30:00Z", createdB: "2026-02-01T00:00:00Z", benchmark: bench });
    if (r.ok) assert.equal(r.value.entry, "2026-03-03");
    else assert.fail(r.message);
  });

  it(`requires at least ${MIN_WINDOW_DAYS} trading days after entry`, () => {
    // Entry days[0], end days[20]: exactly 20 returns -> ok. End days[19] -> too short.
    const pre = "2026-02-27T21:00:00Z"; // Fri 16:00 ET
    assert.ok(commonWindow({ createdA: pre, createdB: pre, benchmark: bench, end: days[20] }).ok);
    const r = commonWindow({ createdA: pre, createdB: pre, benchmark: bench, end: days[19] });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, "window_too_short");
  });

  it("no trading day after the cutoff -> no_entry_day", () => {
    const r = commonWindow({ createdA: "2026-12-01T00:00:00Z", createdB: "2026-01-01T00:00:00Z", benchmark: bench });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, "no_entry_day");
  });

  it("flags a thesis carried forward more than 30 days", () => {
    const near = commonWindow({ createdA: "2026-02-01T00:00:00Z", createdB: "2026-02-27T21:00:00Z", benchmark: bench });
    const far = commonWindow({ createdA: "2026-01-01T00:00:00Z", createdB: "2026-02-27T21:00:00Z", benchmark: bench });
    assert.ok(near.ok && far.ok);
    if (near.ok && far.ok) {
      assert.equal(near.value.carriedForward, false);
      assert.equal(far.value.carriedForward, true);
    }
  });
});
