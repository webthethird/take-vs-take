// Self-consistency for one pair: build each side N times and report how
// often the results agree.
//
//   pnpm consistency [--samples 5] fixtures/private/pair-01-a.json fixtures/private/pair-01-b.json
//
// Sample 0 replays the plain `pnpm compare` run from cache. Each further
// sample is new model calls (analysis + draft) per side, capped by
// LLM_BUDGET_USD. Tiingo requests are capped by the shared hourly quota;
// after a limit, rerun later and completed samples replay for free.

import { selfConsistency, DEFAULT_SAMPLES, type ConsistencyReport } from "../lib/consistency.js";
import { loadFixture } from "../lib/fixture.js";
import { anthropicTransport, ledgerTotal } from "../lib/llm.js";
import { tiingoFromEnv } from "../lib/tiingo.js";
import { pinnedWindowEnd } from "../server/posts.js";
import { round1 } from "../lib/weights.js";
import { authorNamed } from "../lib/readings.js";

const args = process.argv.slice(2);
const nIdx = args.indexOf("--samples");
const n = nIdx >= 0 ? Number(args[nIdx + 1]) : DEFAULT_SAMPLES;
const files = args.filter((a, i) => !a.startsWith("--") && !(nIdx >= 0 && i === nIdx + 1));
const [fa, fb] = files;
if (!fa || !fb || files.length !== 2) {
  console.error("usage: pnpm consistency [--samples N] <fixtureA.json> <fixtureB.json>");
  process.exit(2);
}
try {
  process.loadEnvFile(".env");
} catch {
  // Checked below.
}
const budget = Number(process.env.LLM_BUDGET_USD);
if (!process.env.ANTHROPIC_API_KEY || !(budget > 0)) throw new Error("Set ANTHROPIC_API_KEY and LLM_BUDGET_USD in .env");

const a = await loadFixture(fa);
const b = await loadFixture(fb);
if (!a.ok) throw new Error(`${fa}: ${a.message}`);
if (!b.ok) throw new Error(`${fb}: ${b.message}`);

const ledgerPath = ".cache/llm-ledger.jsonl";
const spentBefore = await ledgerTotal(ledgerPath);
const { tiingo, prices, persist } = tiingoFromEnv();
// An example pair's pinned end date, so its numbers don't drift.
const pin = await pinnedWindowEnd(a.value.post_id, b.value.post_id);
if (!pin.ok) throw new Error(pin.message);
const r = await selfConsistency(
  {
    llm: { transport: anthropicTransport(), budgetUsd: budget, cacheDir: ".cache/llm", ledgerPath },
    prices,
    outDir: ".cache/runs",
    persistReport: persist,
    ...(pin.value ? { end: pin.value } : {}),
  },
  a.value,
  b.value,
  n,
);
const spent = (await ledgerTotal(ledgerPath)) - spentBefore;
if (!r.ok) {
  console.error(`FAILED ${r.error}: ${r.message}\n(LLM spend this run: $${spent.toFixed(4)}; Tiingo requests: ${tiingo.requests}.)`);
  process.exit(1);
}
print(r.value);
console.log(`\nLLM spend this run: $${spent.toFixed(4)}. Tiingo requests: ${tiingo.requests}. Saved: .cache/runs/consistency-${r.value.comparison_id}/${persist ? "report.json" : "samples.json"}`);

function pct(x: number): string {
  return `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
}

function print(rep: ConsistencyReport) {
  const w = rep.window;
  console.log(`\n=== Self-consistency, ${rep.n} samples per side (comparison ${rep.comparison_id})${w ? `  window ${w.entry} -> ${w.end}` : ""}`);
  for (const c of rep.caveats) console.log(`  ! ${c}`);

  for (const label of ["A", "B"] as const) {
    console.log(`\n--- Post ${label} samples`);
    for (const s of rep.samples.filter((x) => x.side === label)) {
      const head = `  #${s.sample}`;
      if (!s.run) {
        console.log(`${head} FAILED ${s.error}`);
        continue;
      }
      const an = s.run.analysis;
      const p = s.run.portfolio;
      if (!p) {
        console.log(`${head} ${an.status}: ${an.status_reason}`);
        continue;
      }
      const i = an.interpretations.find((x) => x.id === an.default_interpretation);
      const conflict = s.stance_conflicts.length ? ` [CONTRADICTS POST: ${s.stance_conflicts.join(", ")}]` : "";
      const ret = s.metrics ? `${pct(s.metrics.cumulativeReturn)}` : `n/a (${s.metrics_error})`;
      const holdings = s.same_portfolio_as !== null ? `same portfolio as #${s.same_portfolio_as}` : `${p.positions.map((x) => `${x.ticker} ${round1(x.weight)}`).join(", ")}, cash ${p.cash_weight}`;
      console.log(`${head} "${i?.label}"${i && authorNamed(an, i) ? "" : " (inferred)"}${conflict}  ${ret}\n       ${holdings}`);
    }
    const sm = rep.summary[label];
    const ov = sm.holdings_overlap;
    console.log(`  built ${sm.built} of ${sm.samples}; ${sm.distinct_portfolios} distinct portfolio(s)`);
    if (ov) console.log(`  between this side's samples: holdings overlap mean ${(ov.mean * 100).toFixed(0)}% (${(ov.min * 100).toFixed(0)}–${(ov.max * 100).toFixed(0)}%)${sm.ex_ante_raw ? `, raw ρ ${sm.ex_ante_raw.min.toFixed(2)} to ${sm.ex_ante_raw.max.toFixed(2)}` : ""}`);
  }

  const b = rep.summary.between;
  if (b.pairs > 0) {
    console.log(`\n--- Between sides (${b.pairs} pairings, ex-ante, from the year before the posts)`);
    if (b.ex_ante_raw) console.log(`  raw ρ ${b.ex_ante_raw.min.toFixed(2)} to ${b.ex_ante_raw.max.toFixed(2)}`);
    if (b.holdings_overlap) console.log(`  holdings overlap mean ${(b.holdings_overlap.mean * 100).toFixed(0)}% (max ${(b.holdings_overlap.max * 100).toFixed(0)}%)`);
    console.log(`  grid (raw direction; rows A samples, columns B samples):`);
    const as = [...new Set(rep.between.map((p) => p.a))];
    const bs = [...new Set(rep.between.map((p) => p.b))];
    const sym = { together: "+", apart: "−", no_clear_relationship: "·" } as const;
    console.log(`        ${bs.map((x) => `B#${x}`.padStart(8)).join("")}`);
    for (const ai of as) {
      const cells = bs.map((bi) => {
        const p = rep.between.find((x) => x.a === ai && x.b === bi)!;
        return `${p.direction ? sym[p.direction] : "?"} ${p.ex_ante_raw?.toFixed(2) ?? "n/a"}`.padStart(8);
      });
      console.log(`    A#${ai} ${cells.join("")}`);
    }
    console.log(`  (+ together, − apart, · no clear relationship)`);
  }

  if (rep.findings.length) {
    console.log(`\n--- Findings`);
    for (const f of rep.findings) console.log(`  * ${f}`);
  }
}
