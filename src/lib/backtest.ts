// Buy-and-hold backtest over a common window. Spec: docs/PLAN.md §6.
//
// Pure functions over already-fetched price series: no I/O, no clock, no
// randomness. Given the same inputs, the same output, byte for byte.
//
// Conventions:
//   - Market calendar = the benchmark's trading days (SPY trades every NYSE
//     session).
//   - Entry = close of the first trading day strictly after the cutoff's ET
//     date. Never the post's own day, whatever the time: that avoids needing
//     an early-close calendar (13:00 ET half days), and it matches the
//     LookAheadGate, which blocks that whole day.
//   - Holdings are valued by adjClose ratio from entry (split- and
//     dividend-adjusted, i.e. total return with dividends reinvested). Ratios
//     are only taken within one fetched series; see prices.ts on rebasing.
//   - Cash returns 0%. No rebalancing, fees, slippage or taxes. Fractional
//     shares are implicit in value-based accounting.
//   - Missing data is flagged, never silently fixed: a mid-window gap carries
//     the last value forward; a series that stops early is frozen at its last
//     value (possible delisting). A holding with no entry-day price fails the
//     whole backtest rather than being dropped or replaced.

import { etDate, type PriceBar, type PriceSeries } from "./prices.js";
import { err, type Result } from "./result.js";
import { tickerKey } from "./ticker.js";

export const BACKTEST_VERSION = "bh-v1";
export const DEFAULT_NOTIONAL = 10_000;
export const MIN_WINDOW_DAYS = 20;
export const CARRIED_FORWARD_DAYS = 30;
const TRADING_DAYS_PER_YEAR = 252;
/// Relative tolerance between the provider's adjClose return and our own
/// close/dividend/split computation. Observed agreement on real data: ~1e-13.
const ADJUSTMENT_TOLERANCE = 1e-6;
const WEIGHT_EPS = 1e-6;

export type Holding = { ticker: string; weight: number };

export type BacktestInput = {
  /// Percent weights; holdings plus cash must sum to 100.
  holdings: Holding[];
  cashWeight: number;
  /// Series for every holding, covering at least entry..end.
  prices: PriceSeries[];
  window: Window;
  notional?: number;
};

export type Window = {
  /// The later of the two post times.
  cutoff: string;
  /// First trading day strictly after the cutoff's ET date.
  entry: string;
  /// Last trading day, the same for both sides.
  end: string;
  /// Trading days entry..end inclusive, from the benchmark.
  calendar: string[];
};

export type Flag =
  | { kind: "gap"; ticker: string; date: string }
  | { kind: "series_ended"; ticker: string; lastDate: string }
  | { kind: "adjustment_mismatch"; ticker: string; adjReturn: number; rawReturn: number }
  | { kind: "off_calendar"; ticker: string; date: string };

export type Metrics = {
  /// Fractions, not percent: 0.05 = 5%.
  cumulativeReturn: number;
  maxDrawdown: number;
  /// Null with fewer than two daily returns.
  annualizedVolatility: number | null;
  tradingDays: number;
};

export type BacktestResult = {
  version: string;
  window: Window;
  notional: number;
  values: { date: string; value: number }[];
  holdings: { ticker: string; weight: number; endValue: number; return: number }[];
  metrics: Metrics;
  flags: Flag[];
};

export type BacktestError =
  | "invalid_portfolio"
  | "missing_series"
  | "no_entry_price"
  | "no_entry_day"
  | "window_too_short";

// ── Window ───────────────────────────────────────────────────────────────

export type WindowInput = {
  createdA: string;
  createdB: string;
  /// The benchmark's bars: the market calendar.
  benchmark: PriceBar[];
  /// Last trading day to include. Defaults to the benchmark's last bar.
  end?: string;
};

export type WindowResult = Window & {
  /// The older post's thesis is being evaluated as of the later post's date.
  carriedForward: boolean;
  gapDays: number;
};

export function commonWindow(w: WindowInput): Result<WindowResult, "no_entry_day" | "window_too_short"> {
  const a = Date.parse(w.createdA);
  const b = Date.parse(w.createdB);
  const cutoff = new Date(Math.max(a, b));
  const cutoffDay = etDate(cutoff);
  const end = w.end ?? w.benchmark.at(-1)?.date;
  const calendar = w.benchmark.map((x) => x.date).filter((d) => d > cutoffDay && end !== undefined && d <= end);
  const entry = calendar[0];
  if (entry === undefined || end === undefined) {
    return err("no_entry_day", `No trading day after ${cutoffDay} (the cutoff's ET date) through ${end ?? "the data's end"}.`);
  }
  // Trading days counts daily returns, i.e. days after entry.
  const tradingDays = calendar.length - 1;
  if (tradingDays < MIN_WINDOW_DAYS) {
    return err(
      "window_too_short",
      `Common window ${entry}..${calendar.at(-1)} has ${tradingDays} trading days after entry; at least ${MIN_WINDOW_DAYS} are required.`,
    );
  }
  const gapDays = Math.abs(a - b) / 86_400_000;
  return {
    ok: true,
    value: {
      cutoff: cutoff.toISOString(),
      entry,
      end: calendar.at(-1)!,
      calendar,
      carriedForward: gapDays > CARRIED_FORWARD_DAYS,
      gapDays,
    },
  };
}

// ── Backtest ─────────────────────────────────────────────────────────────

export function backtest(input: BacktestInput): Result<BacktestResult, BacktestError> {
  const notional = input.notional ?? DEFAULT_NOTIONAL;
  const { window } = input;
  const { calendar, entry } = window;

  const invalid = validatePortfolio(input.holdings, input.cashWeight);
  if (invalid) return err("invalid_portfolio", invalid);
  if (calendar.length === 0 || calendar[0] !== entry) {
    return err("no_entry_day", "Window calendar must start at the entry date.");
  }

  const byTicker = new Map(input.prices.map((s) => [tickerKey(s.ticker), s]));
  const flags: Flag[] = [];
  const onCalendar = new Set(calendar);

  // Per holding: index of value relative to entry, one entry per calendar day.
  const paths: { ticker: string; weight: number; rel: number[] }[] = [];

  // Sorted by ticker so flag order and output order don't depend on input order.
  const holdings = [...input.holdings].sort((x, y) => (tickerKey(x.ticker) < tickerKey(y.ticker) ? -1 : 1));

  for (const h of holdings) {
    const key = tickerKey(h.ticker);
    const series = byTicker.get(key);
    if (!series) return err("missing_series", `No price series for ${key}.`);

    const inWindow = series.bars.filter((b) => b.date >= entry && b.date <= window.end);
    for (const b of inWindow) if (!onCalendar.has(b.date)) flags.push({ kind: "off_calendar", ticker: key, date: b.date });
    const byDate = new Map(inWindow.map((b) => [b.date, b]));

    const entryBar = byDate.get(entry);
    if (!entryBar) return err("no_entry_price", `${key} has no price on the entry date ${entry}.`);

    const lastDate = inWindow.at(-1)!.date;
    const rel: number[] = [];
    let last = entryBar;
    for (const d of calendar) {
      const bar = byDate.get(d);
      if (bar) {
        last = bar;
      } else if (d < lastDate) {
        flags.push({ kind: "gap", ticker: key, date: d });
      }
      rel.push(last.adjClose / entryBar.adjClose);
    }
    if (lastDate < window.end) flags.push({ kind: "series_ended", ticker: key, lastDate });

    // Cross-check the provider's adjustment against our own arithmetic.
    const raw = rawTotalReturn(inWindow);
    const adj = last.adjClose / entryBar.adjClose;
    if (Math.abs(raw / adj - 1) > ADJUSTMENT_TOLERANCE) {
      flags.push({ kind: "adjustment_mismatch", ticker: key, adjReturn: adj - 1, rawReturn: raw - 1 });
    }

    paths.push({ ticker: key, weight: h.weight, rel });
  }

  const cash = (notional * input.cashWeight) / 100;
  const values = calendar.map((date, t) => ({
    date,
    value: cash + paths.reduce((s, p) => s + (notional * p.weight * p.rel[t]!) / 100, 0),
  }));

  return {
    ok: true,
    value: {
      version: BACKTEST_VERSION,
      window: { cutoff: window.cutoff, entry: window.entry, end: window.end, calendar: window.calendar },
      notional,
      values,
      holdings: paths.map((p) => {
        const r = p.rel.at(-1)!;
        return { ticker: p.ticker, weight: p.weight, endValue: (notional * p.weight * r) / 100, return: r - 1 };
      }),
      metrics: metrics(values.map((v) => v.value)),
      flags,
    },
  };
}

/// Benchmark as a 100% position, valued the same way as any holding.
export function benchmarkBacktest(series: PriceSeries, window: Window, notional = DEFAULT_NOTIONAL) {
  return backtest({ holdings: [{ ticker: series.ticker, weight: 100 }], cashWeight: 0, prices: [series], window, notional });
}

function validatePortfolio(holdings: Holding[], cashWeight: number): string | null {
  if (!(cashWeight >= 0)) return `Cash weight must be >= 0, got ${cashWeight}.`;
  const seen = new Set<string>();
  let sum = cashWeight;
  for (const h of holdings) {
    const k = tickerKey(h.ticker);
    if (seen.has(k)) return `Duplicate holding ${k}.`;
    seen.add(k);
    if (!(h.weight > 0)) return `${k} weight must be > 0, got ${h.weight}.`;
    sum += h.weight;
  }
  if (Math.abs(sum - 100) > WEIGHT_EPS) return `Weights plus cash sum to ${sum}, not 100.`;
  return null;
}

// ── Arithmetic ───────────────────────────────────────────────────────────

/// Total return over consecutive bars from raw close, dividends and splits,
/// independent of the provider's adjClose. A dividend is reinvested at the
/// ex-date close; a split of factor k means k new shares per old share.
/// Verified against Tiingo adjClose on SPY (dividends) and NVDA (10:1 split,
/// 2024-06-10): agreement ~1e-13. Unverified: a split and a dividend on the
/// same day (is divCash per old or new share?). If that case is wrong here, the
/// backtest's adjustment_mismatch flag will say so.
export function rawTotalReturn(bars: PriceBar[]): number {
  let g = 1;
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1]!;
    const cur = bars[i]!;
    g *= (cur.close * cur.splitFactor + cur.divCash) / prev.close;
  }
  return g;
}

export function metrics(values: number[]): Metrics {
  const first = values[0]!;
  const lastV = values.at(-1)!;
  let peak = first;
  let mdd = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    const dd = 1 - v / peak;
    if (dd > mdd) mdd = dd;
  }
  const rets: number[] = [];
  for (let i = 1; i < values.length; i++) rets.push(values[i]! / values[i - 1]! - 1);
  let vol: number | null = null;
  if (rets.length >= 2) {
    const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
    const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
    vol = Math.sqrt(variance) * Math.sqrt(TRADING_DAYS_PER_YEAR);
  }
  return { cumulativeReturn: lastV / first - 1, maxDrawdown: mdd, annualizedVolatility: vol, tradingDays: values.length - 1 };
}
