import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { backtest, type Window } from "../src/lib/backtest.js";
import {
  ESTIMATION_DAYS,
  correlationStats,
  exAnteCorrelation,
  holdingsOverlap,
  pearson,
  realizedCorrelation,
  regress,
  type Side,
} from "../src/lib/overlap.js";
import type { PriceSeries } from "../src/lib/prices.js";

const close = (a: number | null | undefined, b: number, tol = 1e-9, msg = "") =>
  assert.ok(a != null && Math.abs(a - b) < tol, `${msg} expected ${b}, got ${a}`);

// Deterministic pseudo-random returns (seeded), so tests reproduce exactly.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
  };
}
function noise(seed: number, n: number, scale: number): number[] {
  const r = rng(seed);
  return Array.from({ length: n }, () => r() * scale);
}

// Trading-day calendar: weekdays from 2025-01-02.
function weekdays(n: number, from = "2025-01-02"): string[] {
  const out: string[] = [];
  for (let d = new Date(`${from}T12:00:00Z`); out.length < n; d.setUTCDate(d.getUTCDate() + 1)) {
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/// A price series from daily returns, starting at 100.
function fromReturns(ticker: string, dates: string[], rets: number[]): PriceSeries {
  let p = 100;
  const bars = dates.map((date, i) => {
    if (i > 0) p *= 1 + rets[i - 1]!;
    return { date, close: p, adjClose: p, divCash: 0, splitFactor: 1 };
  });
  return { ticker, source: "fixture", start: dates[0]!, end: dates.at(-1)!, fetched_at: "2026-01-01T00:00:00.000Z", bars };
}

const side = (holdings: [string, number][], cashWeight = 0): Side => ({
  holdings: holdings.map(([ticker, weight]) => ({ ticker, weight })),
  cashWeight,
});

describe("holdingsOverlap", () => {
  it("identical holdings -> 1; disjoint -> 0", () => {
    close(holdingsOverlap(side([["A", 50], ["B", 40]], 10), side([["A", 50], ["B", 40]], 10)).overlap, 1);
    close(holdingsOverlap(side([["A", 90]], 10), side([["B", 90]], 10)).overlap, 0);
  });

  it("partial overlap on invested shares", () => {
    // A: X 50/90, Y 40/90. B: X 30/90, Z 60/90. Shared X: min(5/9, 1/3) = 1/3.
    const r = holdingsOverlap(side([["X", 50], ["Y", 40]], 10), side([["X", 30], ["Z", 60]], 10));
    close(r.overlap, 1 / 3);
    assert.deepEqual(r.shared.map((s) => s.ticker), ["X"]);
  });

  it("cash doesn't count: same stocks at 10% and 45% cash overlap fully", () => {
    close(holdingsOverlap(side([["A", 45], ["B", 45]], 10), side([["A", 27.5], ["B", 27.5]], 45)).overlap, 1);
  });

  it("matches share-class spellings", () => {
    close(holdingsOverlap(side([["BRK.B", 100]]), side([["brk-b", 100]])).overlap, 1);
  });
});

describe("pearson / regress", () => {
  it("perfect, inverse, and undefined correlation", () => {
    close(pearson([1, 2, 3, 4], [2, 4, 6, 8]), 1);
    close(pearson([1, 2, 3, 4], [8, 6, 4, 2]), -1);
    assert.equal(pearson([1, 2, 3], [5, 5, 5]), null);
  });

  it("known value", () => {
    // x = 1..5, y = [2, 4, 5, 4, 5]: Sxy = 6, Sxx = 10, Syy = 6 -> r = 6 / √60 ≈ 0.7746
    close(pearson([1, 2, 3, 4, 5], [2, 4, 5, 4, 5]), 6 / Math.sqrt(60), 1e-12);
  });

  it("recovers α and β exactly from a noiseless line", () => {
    const x = [0.01, -0.02, 0.005, 0.03, -0.01];
    const { alpha, beta, residuals } = regress(x.map((v) => 0.001 + 1.5 * v), x);
    close(alpha, 0.001, 1e-12);
    close(beta, 1.5, 1e-12);
    for (const e of residuals) close(e, 0, 1e-12);
  });
});

describe("correlationStats", () => {
  const n = 252;
  const m = noise(1, n, 0.02); // market
  const e = noise(2, n, 0.02); // a shared factor, independent of market

  it("market adjustment can flip the sign — the oil vs clean-energy shape", () => {
    // Both sides carry the market; one is long factor e, the other short it.
    const ra = m.map((v, i) => v + e[i]!);
    const rb = m.map((v, i) => v - e[i]!);
    const s = correlationStats(ra, rb, m);
    // Raw: cov = var(m) − var(e) ≈ 0 for equal scales; check it's far from −1.
    assert.ok(s.raw! > -0.5, `raw ${s.raw}`);
    // Residual: exactly ±e minus small fitted terms -> strongly negative.
    assert.ok(s.residual! < -0.95, `residual ${s.residual}`);
  });

  it("identical bets: raw and residual both 1", () => {
    const r = m.map((v, i) => v + e[i]!);
    const s = correlationStats(r, r, m);
    close(s.raw, 1);
    close(s.residual, 1);
  });

  it("scaling one side (cash) leaves ρ unchanged but scales β and vol", () => {
    const r = m.map((v, i) => 1.2 * v + e[i]!);
    const full = correlationStats(r, m.map((v, i) => v - e[i]!), m);
    const halfCash = correlationStats(r.map((v) => 0.55 * v), m.map((v, i) => v - e[i]!), m);
    close(halfCash.raw, full.raw!, 1e-12);
    close(halfCash.residual, full.residual!, 1e-12);
    close(halfCash.a.beta, 0.55 * full.a.beta, 1e-12);
    close(halfCash.a.annualVol, 0.55 * full.a.annualVol, 1e-12);
  });

  it("guards: a near-riskless side gets no correlation", () => {
    const tbill = Array.from({ length: n }, (_, i) => 0.00016 + (i % 2 ? 1e-6 : -1e-6));
    const s = correlationStats(tbill, m.map((v, i) => v + e[i]!), m);
    assert.equal(s.raw, null);
    assert.equal(s.residual, null);
    assert.match(s.notes.join(" "), /minimal market exposure/);
  });

  it("guards: a benchmark clone has no residual correlation", () => {
    const s = correlationStats(m.map((v) => 2 * v), m.map((v, i) => v + e[i]!), m);
    assert.ok(s.raw !== null);
    assert.equal(s.residual, null);
    close(s.a.beta, 2, 1e-12);
    assert.match(s.notes.join(" "), /tracks the benchmark/);
  });
});

describe("exAnteCorrelation", () => {
  const N = ESTIMATION_DAYS + 1;
  // 40 extra days after the window, which must never be read.
  const dates = weekdays(N + 40, "2025-01-02");
  const preDates = dates.slice(0, N);
  const cutoffDay = dates[N]!; // first date not allowed
  const cutoff = `${cutoffDay}T15:00:00Z`; // 10/11:00 ET on that day
  const T = dates.length - 1;

  const m = noise(11, T, 0.02);
  const f = noise(12, T, 0.02);
  const spy = fromReturns("SPY", dates, m);
  const oil = fromReturns("OIL", dates, m.map((v, i) => v + f[i]!));
  const solar = fromReturns("SOLAR", dates, m.map((v, i) => v - f[i]!));

  it("estimates from the year before the cutoff only", () => {
    const r = exAnteCorrelation({ a: side([["OIL", 90]], 10), b: side([["SOLAR", 90]], 10), prices: [oil, solar], benchmark: spy, cutoff });
    assert.ok(r.ok, !r.ok ? r.message : "");
    if (!r.ok) return;
    assert.equal(r.value.window.start, preDates[0]);
    assert.equal(r.value.window.end, preDates.at(-1));
    assert.equal(r.value.days, ESTIMATION_DAYS);
    assert.ok(r.value.residual! < -0.95, `residual ${r.value.residual}`);
  });

  it("uses exactly the last 252 returns when more history exists", () => {
    // Prepend 60 earlier days whose returns are wildly different; they must
    // fall outside the window and change nothing.
    const early = weekdays(61, "2024-09-23").filter((d) => d < dates[0]!);
    const extend = (s: PriceSeries, scale: number): PriceSeries => {
      let p = s.bars[0]!.adjClose;
      const pre = [...early].reverse().map((date, i) => {
        p /= 1 + (i % 2 ? scale : -scale);
        return { date, close: p, adjClose: p, divCash: 0, splitFactor: 1 };
      }).reverse();
      return { ...s, bars: [...pre, ...s.bars] };
    };
    const args = { a: side([["OIL", 90]], 10), b: side([["SOLAR", 90]], 10), cutoff };
    const base = exAnteCorrelation({ ...args, prices: [oil, solar], benchmark: spy });
    const longer = exAnteCorrelation({ ...args, prices: [extend(oil, 0.2), extend(solar, -0.2)], benchmark: extend(spy, 0.01) });
    assert.ok(base.ok && longer.ok);
    if (base.ok && longer.ok) {
      assert.equal(longer.value.window.start, preDates[0]);
      assert.deepEqual(longer.value, base.value);
    }
  });

  it("post-cutoff prices have no effect", () => {
    const wild = (s: PriceSeries): PriceSeries => ({
      ...s,
      bars: s.bars.map((b) => (b.date >= cutoffDay ? { ...b, adjClose: b.adjClose * 1000 } : b)),
    });
    const args = { a: side([["OIL", 90]], 10), b: side([["SOLAR", 90]], 10), cutoff };
    const x = exAnteCorrelation({ ...args, prices: [oil, solar], benchmark: spy });
    const y = exAnteCorrelation({ ...args, prices: [wild(oil), wild(solar)], benchmark: wild(spy) });
    assert.deepEqual(x, y);
  });

  it("is symmetric in A and B", () => {
    const x = exAnteCorrelation({ a: side([["OIL", 90]], 10), b: side([["SOLAR", 90]], 10), prices: [oil, solar], benchmark: spy, cutoff });
    const y = exAnteCorrelation({ a: side([["SOLAR", 90]], 10), b: side([["OIL", 90]], 10), prices: [oil, solar], benchmark: spy, cutoff });
    assert.ok(x.ok && y.ok);
    if (x.ok && y.ok) {
      close(x.value.raw, y.value.raw!, 1e-12);
      close(x.value.residual, y.value.residual!, 1e-12);
    }
  });

  it("excludes a holding with short history and renormalises", () => {
    // NEW listed partway through the window: ~50% coverage.
    const young: PriceSeries = { ...oil, ticker: "NEW", bars: oil.bars.slice(Math.floor(N / 2)) };
    const r = exAnteCorrelation({
      a: side([["OIL", 85], ["NEW", 5]], 10),
      b: side([["SOLAR", 90]], 10),
      prices: [oil, solar, young],
      benchmark: spy,
      cutoff,
    });
    assert.ok(r.ok, !r.ok ? r.message : "");
    if (!r.ok) return;
    assert.deepEqual(r.value.excluded.map((x) => x.ticker), ["NEW"]);
    close(r.value.coverage.a, 85 / 90);
    // Renormalised to full invested exposure: same β as OIL at 90%.
    const ref = exAnteCorrelation({ a: side([["OIL", 90]], 10), b: side([["SOLAR", 90]], 10), prices: [oil, solar], benchmark: spy, cutoff });
    if (ref.ok) close(r.value.a.beta, ref.value.a.beta, 1e-12);
  });

  it("refuses when too little invested weight has history", () => {
    const young: PriceSeries = { ...oil, ticker: "NEW", bars: oil.bars.slice(Math.floor(N / 2)) };
    const r = exAnteCorrelation({
      a: side([["OIL", 70], ["NEW", 20]], 10),
      b: side([["SOLAR", 90]], 10),
      prices: [oil, solar, young],
      benchmark: spy,
      cutoff,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, "insufficient_history");
  });

  it("refuses when the benchmark lacks a full year before the cutoff", () => {
    const r = exAnteCorrelation({
      a: side([["OIL", 90]], 10),
      b: side([["SOLAR", 90]], 10),
      prices: [oil, solar],
      benchmark: spy,
      cutoff: `${dates[100]}T15:00:00Z`,
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, "insufficient_history");
  });

  it("missing series is an error, not an exclusion", () => {
    const r = exAnteCorrelation({ a: side([["OIL", 90]], 10), b: side([["NOPE", 90]], 10), prices: [oil], benchmark: spy, cutoff });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, "missing_series");
  });

  it("a one-day gap is carried, not excluded", () => {
    const gappy: PriceSeries = { ...solar, bars: solar.bars.filter((b) => b.date !== preDates[100]) };
    const r = exAnteCorrelation({ a: side([["OIL", 90]], 10), b: side([["SOLAR", 90]], 10), prices: [oil, gappy], benchmark: spy, cutoff });
    const ref = exAnteCorrelation({ a: side([["OIL", 90]], 10), b: side([["SOLAR", 90]], 10), prices: [oil, solar], benchmark: spy, cutoff });
    assert.ok(r.ok && ref.ok);
    if (r.ok && ref.ok) {
      assert.deepEqual(r.value.excluded, []);
      // 252/253 bars present: above the 90% bar, so SOLAR stays in and carries full weight.
      close(r.value.coverage.b, 1);
      // One carried day turns two returns into (0, double). Measured: a perfect
      // -1 moves to about -0.975. A wrong gap fill (e.g. a near-zero price)
      // would wreck the estimate, which this tolerance still catches.
      close(r.value.residual, ref.value.residual!, 0.05);
    }
  });
});

describe("realizedCorrelation", () => {
  const dates = weekdays(30);
  const m = noise(21, 29, 0.02);
  const f = noise(22, 29, 0.02);
  const series = [
    fromReturns("SPY", dates, m),
    fromReturns("OIL", dates, m.map((v, i) => v + f[i]!)),
    fromReturns("SOLAR", dates, m.map((v, i) => v - f[i]!)),
  ];
  const window: Window = { cutoff: "2024-12-31T00:00:00Z", entry: dates[0]!, end: dates.at(-1)!, calendar: dates };
  const bt = (t: string) => {
    const r = backtest({ holdings: [{ ticker: t, weight: 100 }], cashWeight: 0, prices: series, window });
    if (!r.ok) assert.fail(r.message);
    return r.value;
  };

  it("uses the backtest value paths", () => {
    const r = realizedCorrelation(bt("OIL"), bt("SOLAR"), bt("SPY"));
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.value.days, 29);
      assert.ok(r.value.residual! < -0.9, `residual ${r.value.residual}`);
    }
  });

  it("refuses misaligned backtests", () => {
    const short: Window = { ...window, end: dates[20]!, calendar: dates.slice(0, 21) };
    const b = backtest({ holdings: [{ ticker: "SOLAR", weight: 100 }], cashWeight: 0, prices: series, window: short });
    assert.ok(b.ok);
    if (b.ok) assert.equal(realizedCorrelation(bt("OIL"), b.value, bt("SPY")).ok, false);
  });
});
