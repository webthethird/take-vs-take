// Tiingo end-of-day prices.
//
// Free "Starter" tier: 50 requests/hour, 1,000/day, 500 unique symbols/month,
// licensed for personal/internal use only. Behaviour verified live on
// 2026-10-19: unknown symbols return 404 {"detail":"Not found."}; some delisted
// symbols are kept (TWTR, through 2022-10-28) and some are not (SIVB is 404);
// share classes use a dash (BRK-B).
//
// The token travels in the Authorization header, never in the URL, so it can't
// leak through logged URLs or error messages.

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { checkBars, validateRange, type PriceError, type PriceSeries, type PriceSource } from "./prices.js";
import { err, type Result } from "./result.js";
import { tickerKey } from "./ticker.js";

const BASE = "https://api.tiingo.com";

const TiingoBar = z.object({
  date: z.string(), // "2026-09-25T00:00:00.000Z"
  close: z.number(),
  adjClose: z.number(),
  divCash: z.number(),
  splitFactor: z.number(),
});

export type TiingoOptions = {
  token: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  timeoutMs?: number;
  /// Retries for network errors, timeouts and 5xx only. A 429 is never
  /// retried: on the free tier it means the hourly quota is spent, and
  /// hammering won't refill it.
  retries?: number;
  /// Per-process ceiling, kept below the 50/hour quota so a buggy loop
  /// fails locally instead of locking the account out for an hour.
  maxRequests?: number;
  /// Persistent log of request times, shared by every process. With it, the
  /// free tier's hourly and daily quotas are enforced locally: a request that
  /// would exceed them fails with a retry-after time instead of being sent.
  requestLog?: string;
  hourlyLimit?: number;
  dailyLimit?: number;
};

/// Requests in the last hour and day, from the shared log, and when the
/// oldest request in the hour ages out.
async function quotaState(path: string, now: Date) {
  let lines: string[] = [];
  try {
    lines = (await readFile(path, "utf8")).split("\n").filter(Boolean);
  } catch {
    // No log yet.
  }
  const t = now.getTime();
  const times = lines.map((l) => Date.parse(l)).filter((x) => !Number.isNaN(x));
  const hour = times.filter((x) => x > t - 3_600_000).sort((a, b) => a - b);
  const day = times.filter((x) => x > t - 86_400_000).length;
  return { hour: hour.length, day, hourFreesAt: hour[0] !== undefined ? new Date(hour[0] + 3_600_000) : now };
}

export function tiingoSource(opts: TiingoOptions): PriceSource & { requests: number } {
  if (!opts.token) throw new Error("tiingoSource: missing token (set TIINGO_API_TOKEN in .env)");
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => new Date());
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const retries = opts.retries ?? 2;
  const maxRequests = opts.maxRequests ?? 40;
  // Below Tiingo's 50/hour and 1,000/day to leave room for manual probes.
  const hourlyLimit = opts.hourlyLimit ?? 45;
  const dailyLimit = opts.dailyLimit ?? 950;

  const src = {
    name: "tiingo",
    requests: 0,
    async daily(ticker: string, start: string, end: string): Promise<Result<PriceSeries, PriceError>> {
      const range = validateRange(start, end);
      if (!range.ok) return range;
      const symbol = tickerKey(ticker);
      // Alphanumeric runs joined by single dashes (SPY, BRK-B). Rejects
      // anything a normalised path or junk input could turn into, e.g. "---ETC".
      if (symbol.length > 12 || !/^[A-Z0-9]+(-[A-Z0-9]+)*$/.test(symbol)) {
        return err("invalid_request", `Unsupported ticker: ${ticker}`);
      }

      const url = `${BASE}/tiingo/daily/${encodeURIComponent(symbol)}/prices?startDate=${start}&endDate=${end}`;

      for (let attempt = 0; ; attempt++) {
        if (src.requests >= maxRequests) {
          return err("budget_exceeded", `Reached this process's cap of ${maxRequests} Tiingo requests.`);
        }
        if (opts.requestLog) {
          const q = await quotaState(opts.requestLog, now());
          if (q.hour >= hourlyLimit) {
            return err("rate_limited", `Local Tiingo quota: ${q.hour} requests in the last hour (limit ${hourlyLimit}). Retry after ${q.hourFreesAt.toISOString()}; cached data is unaffected.`);
          }
          if (q.day >= dailyLimit) {
            return err("rate_limited", `Local Tiingo quota: ${q.day} requests in the last 24 hours (limit ${dailyLimit}).`);
          }
          await mkdir(dirname(opts.requestLog), { recursive: true });
          await appendFile(opts.requestLog, now().toISOString() + "\n");
        }
        src.requests++;

        let res: Response;
        try {
          res = await doFetch(url, {
            headers: { Authorization: `Token ${opts.token}`, "Content-Type": "application/json" },
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (e) {
          if (attempt < retries) {
            await sleep(500 * 2 ** attempt);
            continue;
          }
          return err("network", `Tiingo request for ${symbol} failed: ${(e as Error).name}`);
        }

        if (res.status >= 500 && attempt < retries) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        if (res.status === 404) return err("not_found", `Tiingo has no daily prices for ${symbol} (unknown, or delisted and not retained).`);
        if (res.status === 401 || res.status === 403) return err("unauthorized", "Tiingo rejected the API token.");
        if (res.status === 429) return err("rate_limited", "Tiingo rate limit reached (free tier: 50/hour, 1,000/day).");
        if (res.status === 400) {
          return err("invalid_request", `Tiingo rejected the request for ${symbol}: ${await detail(res)}`);
        }
        if (!res.ok) return err("network", `Tiingo returned HTTP ${res.status} for ${symbol}.`);

        let body: unknown;
        try {
          body = await res.json();
        } catch {
          return err("bad_response", `Tiingo returned non-JSON for ${symbol}.`);
        }
        const parsed = z.array(TiingoBar).safeParse(body);
        if (!parsed.success) return err("bad_response", `Unexpected Tiingo response shape for ${symbol}: ${parsed.error.message}`);

        const bars = parsed.data.map((b) => ({
          date: b.date.slice(0, 10),
          close: b.close,
          adjClose: b.adjClose,
          divCash: b.divCash,
          splitFactor: b.splitFactor,
        }));
        for (const b of bars) {
          if (!(b.close > 0 && b.adjClose > 0 && b.splitFactor > 0 && b.divCash >= 0)) {
            return err("bad_response", `Implausible bar for ${symbol} on ${b.date}.`);
          }
        }
        const problem = checkBars(bars, start, end);
        if (problem) return err("bad_response", `Tiingo ${symbol}: ${problem}`);

        return { ok: true, value: { ticker: symbol, source: "tiingo", start, end, fetched_at: now().toISOString(), bars } };
      }
    },
  };
  return src;
}

async function detail(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { detail?: unknown };
    return typeof j.detail === "string" ? j.detail : `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}
