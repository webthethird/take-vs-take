// Daily price access: the source interface, a fixture source for tests, an
// on-disk cache, and the look-ahead gate. Provider clients (tiingo.ts) sit
// underneath; the backtest only ever sees a PriceSource.
//
// Compose outermost-first as  gate(cache(provider)).  The gate must wrap the
// cache, or cached post-cutoff bars would bypass it.

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { err, type Result } from "./result.js";
import { tickerKey } from "./ticker.js";

export const PriceBar = z.object({
  /// Trading day, YYYY-MM-DD (US market calendar date).
  date: z.iso.date(),
  close: z.number().positive(),
  /// Split- and dividend-adjusted close. Rebased by the provider whenever a
  /// later corporate action occurs, so adjClose values from different fetches
  /// must never be mixed in one series; ratios within one fetch are stable.
  adjClose: z.number().positive(),
  /// Cash dividend with this date as ex-date; 0 on most days.
  divCash: z.number().nonnegative(),
  /// Split ratio effective this date; 1 on most days.
  splitFactor: z.number().positive(),
});
export type PriceBar = z.infer<typeof PriceBar>;

export const PriceSeries = z.object({
  ticker: z.string(),
  source: z.string(),
  start: z.iso.date(),
  end: z.iso.date(),
  fetched_at: z.iso.datetime(),
  bars: z.array(PriceBar),
});
export type PriceSeries = z.infer<typeof PriceSeries>;

export type PriceError =
  | "invalid_request"
  | "not_found" // unknown, or delisted and dropped by the provider — indistinguishable
  | "unauthorized"
  | "rate_limited"
  | "budget_exceeded" // our own per-process request cap, not the provider's
  | "network"
  | "bad_response"
  | "look_ahead";

export interface PriceSource {
  readonly name: string;
  /// Bars with start <= date <= end, inclusive.
  daily(ticker: string, start: string, end: string): Promise<Result<PriceSeries, PriceError>>;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function validateRange(start: string, end: string): Result<null, "invalid_request"> {
  if (!ISO_DATE.test(start) || Number.isNaN(Date.parse(start))) return err("invalid_request", `Bad start date: ${start}`);
  if (!ISO_DATE.test(end) || Number.isNaN(Date.parse(end))) return err("invalid_request", `Bad end date: ${end}`);
  if (start > end) return err("invalid_request", `start ${start} is after end ${end}`);
  return { ok: true, value: null };
}

/// Structural checks every source's output must pass: strictly increasing
/// unique dates, all inside the requested range. Catches provider bugs and
/// our own parsing bugs before they reach arithmetic.
export function checkBars(bars: PriceBar[], start: string, end: string): string | null {
  for (let i = 0; i < bars.length; i++) {
    const d = bars[i]!.date;
    if (d < start || d > end) return `bar ${d} outside requested range ${start}..${end}`;
    if (i > 0 && d <= bars[i - 1]!.date) return `bars not strictly increasing at ${d}`;
  }
  return null;
}

/// US/Eastern calendar date of an instant. The market closes at 16:00 ET, so
/// "which trading day has a post already happened by" is an ET question.
export function etDate(instant: Date): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

// ── Fixture source ───────────────────────────────────────────────────────

/// In-memory bars for tests. Keyed by canonical ticker. The default fetch
/// time is after every test range, so cachedSource treats entries as complete.
export function fixtureSource(
  data: Record<string, PriceBar[]>,
  fetchedAt = "2027-01-01T00:00:00.000Z",
): PriceSource & { calls: number } {
  const byKey = new Map(Object.entries(data).map(([t, bars]) => [tickerKey(t), bars]));
  const src = {
    name: "fixture",
    calls: 0,
    async daily(ticker: string, start: string, end: string): Promise<Result<PriceSeries, PriceError>> {
      src.calls++;
      const range = validateRange(start, end);
      if (!range.ok) return range;
      const key = tickerKey(ticker);
      const bars = byKey.get(key);
      if (!bars) return err("not_found", `No fixture for ${key}`);
      return {
        ok: true,
        value: { ticker: key, source: "fixture", start, end, fetched_at: fetchedAt, bars: bars.filter((b) => b.date >= start && b.date <= end) },
      };
    },
  };
  return src;
}

// ── On-disk cache ────────────────────────────────────────────────────────
//
// Cached per exact (source, ticker, start, end). Ranges are never spliced
// together: adjClose is rebased between fetches, so a series stitched from
// two fetches could carry a fake jump at the seam.
//
// A cached series is a pinned input, not a convenience: rerunning a pinned
// comparison must read the same bars. The one exception: an entry fetched on
// or before its own end date (ET) may be missing that day's close, so it is
// treated as a miss and refetched; once fetched after the end date, it is
// served as is. Pass refresh to re-fetch regardless.
//
// Used only on a plan whose terms allow storing data (see tiingo.ts):
// Tiingo's Starter plan forbids it (Terms 1.6(a)).

export function cachedSource(inner: PriceSource, dir: string, opts: { refresh?: boolean } = {}): PriceSource & { hits: number; misses: number } {
  const pathFor = (ticker: string, start: string, end: string) => {
    const key = tickerKey(ticker);
    // Hash guards against any ticker character a filesystem would mind.
    const safe = key.replace(/[^A-Z0-9-]/g, "_");
    const h = createHash("sha256").update(`${inner.name}\u0000${key}\u0000${start}\u0000${end}`).digest("hex").slice(0, 12);
    return join(dir, inner.name, safe, `${start}_${end}_${h}.json`);
  };

  const src = {
    name: inner.name,
    hits: 0,
    misses: 0,
    async daily(ticker: string, start: string, end: string): Promise<Result<PriceSeries, PriceError>> {
      const range = validateRange(start, end);
      if (!range.ok) return range;
      const path = pathFor(ticker, start, end);

      if (!opts.refresh) {
        try {
          const parsed = PriceSeries.safeParse(JSON.parse(await readFile(path, "utf8")));
          if (parsed.success && etDate(new Date(parsed.data.fetched_at)) > end) {
            src.hits++;
            return { ok: true, value: parsed.data };
          }
          // Shape drifted from the schema, or possibly incomplete: treat as
          // a miss and overwrite.
        } catch {
          // Missing or unreadable: miss.
        }
      }

      src.misses++;
      const r = await inner.daily(ticker, start, end);
      // Errors are not cached: a 404 or outage today may not be one tomorrow.
      if (r.ok) {
        await mkdir(dirname(path), { recursive: true });
        // Atomic: a kill mid-write can't leave a truncated file to be read later.
        const tmp = `${path}.${process.pid}.tmp`;
        await writeFile(tmp, JSON.stringify(r.value));
        await rename(tmp, path);
      }
      return r;
    },
  };
  return src;
}

// ── Look-ahead gate ──────────────────────────────────────────────────────
//
// Until the portfolios are frozen, nothing on or after the cutoff's ET date
// may be read: that's outcome data. Conservative by a few hours on purpose: a
// post at 18:00 ET happened after that day's close, but the whole day is still
// blocked, since nothing before freezing needs it.
//
// This enforces pipeline order against accidents, not against a determined
// caller — anyone can construct an ungated source. Its job is to make "the
// interpretation step read the backtest window" fail loudly instead of
// silently.

export type FrozenRunRef = { run_id: string; frozen_at: string };

export class LookAheadGate implements PriceSource {
  readonly name: string;
  readonly blockedFrom: string;
  private unlockedBy: FrozenRunRef[] | null = null;

  constructor(
    private readonly inner: PriceSource,
    cutoff: Date,
  ) {
    this.name = inner.name;
    this.blockedFrom = etDate(cutoff);
  }

  get unlocked(): boolean {
    return this.unlockedBy !== null;
  }

  /// Open the gate once both portfolios are frozen. Requires at least one run
  /// record; every run must already have been frozen.
  unlock(runs: FrozenRunRef[], now: Date = new Date()): Result<null, "invalid_request"> {
    if (runs.length === 0) return err("invalid_request", "unlock requires the frozen run records");
    for (const r of runs) {
      if (!r.run_id) return err("invalid_request", "frozen run has an empty run_id");
      const t = Date.parse(r.frozen_at);
      if (Number.isNaN(t) || t > now.getTime()) {
        return err("invalid_request", `run ${r.run_id} has no valid past frozen_at (${r.frozen_at})`);
      }
    }
    this.unlockedBy = runs;
    return { ok: true, value: null };
  }

  async daily(ticker: string, start: string, end: string): Promise<Result<PriceSeries, PriceError>> {
    if (!this.unlockedBy && end >= this.blockedFrom) {
      return err(
        "look_ahead",
        `Prices on or after ${this.blockedFrom} (the cutoff date) are outcome data and stay blocked until portfolios are frozen; requested through ${end}.`,
      );
    }
    const r = await this.inner.daily(ticker, start, end);
    if (!r.ok || this.unlockedBy) return r;
    // Belt and braces: never pass a post-cutoff bar through, whatever the
    // inner source returned.
    return { ok: true, value: { ...r.value, bars: r.value.bars.filter((b) => b.date < this.blockedFrom) } };
  }
}
