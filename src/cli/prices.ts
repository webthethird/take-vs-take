// Fetch one ticker's daily bars and print a summary. Nothing is stored.
// A probe for checking the provider by hand; the pipeline goes through the
// LookAheadGate, this tool deliberately doesn't.
//
//   pnpm prices SPY 2026-09-25 2026-10-02
//   pnpm prices BRK.B 2026-01-01 2026-03-31

import { tiingoSource } from "../lib/tiingo.js";

const args = process.argv.slice(2);
const [ticker, start, end] = args.filter((a) => !a.startsWith("--"));
if (!ticker || !start || !end) {
  console.error("usage: pnpm prices <TICKER> <YYYY-MM-DD start> <YYYY-MM-DD end>");
  process.exit(2);
}

try {
  process.loadEnvFile(".env");
} catch {
  // Fall through: tiingoSource reports the missing token.
}

const tiingo = tiingoSource({ token: process.env.TIINGO_API_TOKEN ?? "" });
const r = await tiingo.daily(ticker, start, end);

if (!r.ok) {
  console.error(`${r.error}: ${r.message}`);
  process.exit(1);
}

const { bars } = r.value;
const first = bars[0];
const last = bars.at(-1);
console.log(`${r.value.ticker}  ${start}..${end}  ${bars.length} bars  source=${r.value.source}  fetched_at=${r.value.fetched_at}`);
console.log(`Tiingo requests this run: ${tiingo.requests}`);
if (first && last) {
  console.log(`first ${first.date} close=${first.close} adjClose=${first.adjClose}`);
  console.log(`last  ${last.date} close=${last.close} adjClose=${last.adjClose}`);
}
for (const b of bars) {
  if (b.divCash > 0) console.log(`dividend ${b.date}: ${b.divCash}`);
  if (b.splitFactor !== 1) console.log(`split    ${b.date}: ${b.splitFactor}`);
}
