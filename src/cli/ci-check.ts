// Check the Fisher interval against a moving-block bootstrap on every saved
// comparison. The pipeline states a co-movement direction only when the
// Fisher 95% interval excludes zero; Fisher assumes independent days, so this
// asks whether that assumption changes any stated direction on real data.
//
//   pnpm ci-check
//
// Reads .cache/runs/compare-*/report.json (saved only when TIINGO_PLAN allows
// storing results) and refetches each pair's pre-post prices through the
// usual source. No model calls. Tiingo requests on the first run only, on a
// plan that caches prices.

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { blockBootstrapIntervals } from "../lib/bootstrap.js";
import type { ComparisonReport } from "../lib/compare.js";
import { coMovementDirection, exAnteReturns, fisherInterval, pearson, regress, type Interval } from "../lib/overlap.js";
import { etDate, type PriceSeries } from "../lib/prices.js";
import { sweepRuns } from "../lib/runs.js";
import { tiingoFromEnv } from "../lib/tiingo.js";

const BLOCKS = [1, 5, 10, 20];
const RUNS = ".cache/runs";

try {
  process.loadEnvFile(".env");
} catch {
  // Fall through: tiingoFromEnv reports the missing token.
}
const { prices, tiingo } = tiingoFromEnv();
const shift = (d: string, days: number) => new Date(Date.parse(`${d}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const dir = (ci: Interval | null) => (ci ? coMovementDirection(ci) : null);
const fmt = (ci: Interval | null) => (ci ? `[${ci[0].toFixed(2)}, ${ci[1].toFixed(2)}] ${dir(ci)}` : "n/a");
const returns = (v: number[]) => v.slice(1).map((x, i) => x / v[i]! - 1);

// Kept apart in the summary: the pipeline states its direction from the
// ex-ante window; realized windows are short and shown for reference only.
const tally = { "ex-ante": { compared: 0, disagree: [] as string[] }, realized: { compared: 0, disagree: [] as string[] } };
const check = (label: string, r: number | null, n: number, ra: number[], rb: number[], rm: number[], which: "raw" | "residual") => {
  if (r === null) return;
  const fisher = fisherInterval(r, n);
  console.log(`  ${label} ${which.padEnd(8)} ρ ${r.toFixed(2)}  Fisher ${fmt(fisher)}`);
  for (const block of BLOCKS) {
    const b = blockBootstrapIntervals(ra, rb, rm, { block })[which];
    console.log(`  ${" ".repeat(label.length)} ${" ".repeat(8)} block ${String(block).padStart(2)}  ${fmt(b)}`);
    const t = tally[label.startsWith("ex-ante") ? "ex-ante" : "realized"];
    t.compared++;
    if (dir(b) !== dir(fisher)) t.disagree.push(`${label} ${which}, block ${block}: Fisher ${dir(fisher)}, bootstrap ${dir(b)}`);
  }
};

// Expired runs of X posts aren't read, and are deleted.
await sweepRuns(RUNS);
let runs: string[];
try {
  runs = (await readdir(RUNS)).filter((d) => d.startsWith("compare-")).sort();
} catch {
  runs = [];
}
let pairs = 0;
for (const run of runs) {
  let report: ComparisonReport;
  try {
    report = JSON.parse(await readFile(join(RUNS, run, "report.json"), "utf8"));
  } catch {
    continue;
  }
  const [A, B] = report.sides;
  if (!A?.portfolio || !B?.portfolio) continue;
  pairs++;
  console.log(`\n${run}  @${A.post.author_handle} vs @${B.post.author_handle}`);

  const cutoff = new Date(Math.max(Date.parse(A.post.created_at), Date.parse(B.post.created_at))).toISOString();
  const cutoffDay = etDate(new Date(cutoff));
  const tickers = [...new Set(["SPY", ...[A, B].flatMap((s) => s.portfolio!.positions.map((p) => p.ticker))])];
  const series: PriceSeries[] = [];
  for (const t of tickers) {
    const r = await prices.daily(t, shift(cutoffDay, -400), cutoffDay);
    if (!r.ok) {
      console.error(`  ${t}: ${r.error}: ${r.message}`);
      process.exit(1);
    }
    series.push(r.value);
  }
  const side = (p: NonNullable<typeof A.portfolio>) => ({ holdings: p.positions.map((x) => ({ ticker: x.ticker, weight: x.weight })), cashWeight: p.cash_weight });
  const ex = exAnteReturns({ a: side(A.portfolio), b: side(B.portfolio), prices: series, benchmark: series[0]!, cutoff });
  if (!ex.ok) {
    console.log(`  ex-ante: ${ex.message}`);
  } else {
    const { ra, rb, rm } = ex.value;
    check("ex-ante ", pearson(ra, rb), ra.length, ra, rb, rm, "raw");
    check("ex-ante ", pearson(regress(ra, rm).residuals, regress(rb, rm).residuals), ra.length, ra, rb, rm, "residual");
  }

  const bt = report.backtests;
  if (bt) {
    const [xa, xb, xm] = [bt.a, bt.b, bt.benchmark].map((r) => returns(r.values.map((v) => v.value))) as [number[], number[], number[]];
    check(`realized (${xa.length} days)`, pearson(xa, xb), xa.length, xa, xb, xm, "raw");
  }
}

if (pairs === 0) {
  console.log(`No saved comparisons with two portfolios under ${RUNS}. Run \`pnpm compare\` on a plan that stores reports.`);
  process.exit(0);
}
console.log(`\n${pairs} pairs, ${tiingo.requests} Tiingo requests.`);
for (const [name, t] of Object.entries(tally)) {
  console.log(`${name}: ${t.disagree.length} of ${t.compared} bootstrap intervals disagree with Fisher on the direction.`);
  for (const d of t.disagree) console.log(`  ${d}`);
}
