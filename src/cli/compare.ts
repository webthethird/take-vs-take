// Compare two posts end to end and print the result.
//
//   pnpm compare [--alternates] fixtures/private/pair-01-a.json fixtures/private/pair-01-b.json
//
// --alternates also drafts every non-default reading (sensitivity; costs more).
//
// Writes the frozen runs under .cache/runs/compare-<id>/, plus report.json
// when TIINGO_PLAN allows storing price-derived results. Real model calls are
// capped by LLM_BUDGET_USD and cached, so a rerun after a limit doesn't pay
// again. Prices are cached only on a plan that allows it; Tiingo requests
// count against a shared hourly quota.

import { compare, type ComparisonReport } from "../lib/compare.js";
import { loadFixture } from "../lib/fixture.js";
import { anthropicTransport } from "../lib/llm.js";
import { tiingoFromEnv } from "../lib/tiingo.js";
import { round1 } from "../lib/weights.js";
import { authorNamed } from "../lib/readings.js";

const args = process.argv.slice(2);
const alternates = args.includes("--alternates");
const files = args.filter((a) => !a.startsWith("--"));
const [fa, fb] = files;
if (!fa || !fb || files.length !== 2) {
  console.error("usage: pnpm compare [--alternates] <fixtureA.json> <fixtureB.json>");
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

const { tiingo, prices, persist } = tiingoFromEnv();
const r = await compare(
  {
    llm: { transport: anthropicTransport(), budgetUsd: budget, cacheDir: ".cache/llm", ledgerPath: ".cache/llm-ledger.jsonl" },
    prices,
    outDir: ".cache/runs",
    persistReport: persist,
    alternates,
  },
  a.value,
  b.value,
);
if (!r.ok) {
  console.error(`FAILED ${r.error}: ${r.message}\n(Tiingo requests this run: ${tiingo.requests}. Completed LLM steps are cached; rerunning doesn't pay for them again.)`);
  process.exit(1);
}
print(r.value);
console.log(`\nTiingo requests this run: ${tiingo.requests}. Saved: .cache/runs/compare-${r.value.comparison_id}/${persist ? "report.json" : " (frozen runs only)"}`);

function pct(x: number): string {
  return `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
}

function print(rep: ComparisonReport) {
  const w = rep.window;
  console.log(`\n=== Comparison ${rep.comparison_id}${w ? `  window ${w.entry} -> ${w.end} (${w.calendar.length - 1} trading days)` : ""}`);
  for (const c of rep.caveats) console.log(`  ! ${c}`);

  for (const s of rep.sides) {
    const an = s.analysis;
    const interp = an.interpretations.find((i) => i.id === an.default_interpretation);
    console.log(`\n--- Post ${s.label}: @${s.post.author_handle}, ${s.post.created_at.slice(0, 10)}  ${s.post.url}`);
    console.log(`  status: ${an.status}  [${an.direction}]  ${an.status_reason}`);
    console.log(`  claim: ${an.economic_claim}`);
    if (an.targets.length) console.log(`  post's own targets: ${an.targets.map((t) => `${t.ticker} ${t.stance === "negative" ? "−" : "+"}`).join(", ")}`);
    if (interp) console.log(`  built: "${interp.label}"${authorNamed(an, interp) ? " (author named these)" : " (AI-inferred)"}. Gap: ${interp.gap_note}`);
    const others = an.interpretations.filter((i) => i.id !== an.default_interpretation);
    if (others.length) console.log(`  other readings not built: ${others.map((i) => i.label).join("; ")}`);
    const p = s.portfolio;
    if (!p) continue;
    console.log(`  portfolio "${p.title}": ${p.concentration}, ${p.positions.length} positions, cash ${p.cash_weight}%`);
    if (p.long_only_note) console.log(`  long-only: ${p.long_only_note}`);
    if (p.exclusions.length) console.log(`  excludes: ${p.exclusions.join("; ")}`);
    for (const bk of p.buckets) {
      const names = p.positions.filter((x) => x.bucket === bk.name).map((x) => `${x.ticker} ${round1(x.weight)}%`);
      console.log(`    [${round1(bk.weight)}%] ${bk.name}: ${names.join(", ")}`);
    }
  }

  if (rep.alignment) {
    const al = rep.alignment.value;
    console.log(`\n--- Thesis alignment: ${al.relationship} (${al.confidence} confidence)\n  ${al.reasoning}`);
  }

  if (rep.backtests) {
    const row = (name: string, m: { cumulativeReturn: number; maxDrawdown: number; annualizedVolatility: number | null }) =>
      console.log(`  ${name.padEnd(10)} ${pct(m.cumulativeReturn).padStart(8)}   max drawdown ${(m.maxDrawdown * 100).toFixed(1).padStart(5)}%   vol ${m.annualizedVolatility === null ? "n/a" : (m.annualizedVolatility * 100).toFixed(1) + "%"}`);
    console.log(`\n--- Hypothetical performance, $10,000 each, buy and hold (an outcome, not a verdict on either opinion)`);
    row("A", rep.backtests.a.metrics);
    row("B", rep.backtests.b.metrics);
    row("SPY", rep.backtests.benchmark.metrics);
  }

  if (rep.holdings_overlap) {
    const h = rep.holdings_overlap;
    console.log(`\n--- Holdings overlap: ${(h.overlap * 100).toFixed(0)}% of invested weight${h.shared.length ? ` (shared: ${h.shared.map((x) => x.ticker).join(", ")})` : ""}`);
  }
  const cm = rep.co_movement;
  if (cm) {
    const ci = (c: [number, number] | null) => (c ? `[${c[0].toFixed(2)}, ${c[1].toFixed(2)}]` : "");
    const ex = cm.ex_ante;
    console.log(`--- Co-movement, estimated from the year before the posts`);
    if (ex) {
      console.log(`  raw ρ ${ex.raw?.toFixed(2) ?? "n/a"} ${ci(ex.rawCi95)} -> ${cm.ex_ante_direction?.replace(/_/g, " ") ?? "n/a"}`);
      console.log(`  residual ρ (beyond the market) ${ex.residual?.toFixed(2) ?? "n/a"} ${ci(ex.residualCi95)}; betas A ${ex.a.beta.toFixed(2)}, B ${ex.b.beta.toFixed(2)}`);
      for (const n of ex.notes) console.log(`  note: ${n}`);
      if (ex.excluded.length) console.log(`  excluded for short history: ${ex.excluded.map((x) => `${x.side.toUpperCase()}:${x.ticker}`).join(", ")}`);
    } else {
      console.log(`  unavailable: ${cm.ex_ante_error}`);
    }
    if (cm.realized) console.log(`  realized over the window (outcome): raw ρ ${cm.realized.raw?.toFixed(2) ?? "n/a"} ${ci(cm.realized.rawCi95)} -> ${cm.realized_direction?.replace(/_/g, " ") ?? "n/a"}`);
  }

  const sens = rep.sensitivity;
  if (sens && sens.pairs.length > 1) {
    console.log(`\n--- Sensitivity to interpretation (every reading was drafted and frozen before outcomes)`);
    for (const rd of sens.readings) {
      const m = rd.metrics;
      const conflict = rd.stance_conflicts?.length ? ` [CONTRADICTS POST: holds ${rd.stance_conflicts.join(", ")}]` : "";
      console.log(`  ${rd.side}:${rd.interpretation_id}${rd.is_default ? "*" : " "} ${rd.label}${rd.author_stated ? "" : " (inferred)"}${conflict}: ${m ? `${pct(m.cumulativeReturn)}, vol ${m.annualizedVolatility === null ? "n/a" : (m.annualizedVolatility * 100).toFixed(1) + "%"}` : `not backtested (${rd.error})`}`);
    }
    for (const s of rep.sides) {
      for (const alt of s.alternates.filter((x) => !x.portfolio)) console.log(`  ${s.label}:${alt.interpretation_id}  draft failed: ${alt.error}`);
    }
    for (const p of sens.pairs) {
      const ci = p.ex_ante_raw_ci95 ? ` [${p.ex_ante_raw_ci95[0].toFixed(2)}, ${p.ex_ante_raw_ci95[1].toFixed(2)}]` : "";
      console.log(`  A:${p.a} x B:${p.b}${p.is_headline ? " (headline)" : ""}  overlap ${(p.holdings_overlap * 100).toFixed(0)}%${p.shared.length ? ` (${p.shared.join(", ")})` : ""}  raw ρ ${p.ex_ante_raw?.toFixed(2) ?? "n/a"}${ci} -> ${p.ex_ante_direction?.replace(/_/g, " ") ?? p.error}`);
    }
    for (const s of rep.sides) {
      for (const alt of s.alternates) {
        if (!alt.portfolio) continue;
        const names = alt.portfolio.positions.map((x) => `${x.ticker} ${round1(x.weight)}%`).join(", ");
        console.log(`  ${s.label}:${alt.interpretation_id} "${alt.portfolio.title}": ${names}, cash ${alt.portfolio.cash_weight}%`);
      }
    }
  }

  if (rep.findings.length) {
    console.log(`\n--- Findings`);
    for (const f of rep.findings) console.log(`  * ${f.text}`);
  }
  console.log(`\nLLM cost for this comparison: $${rep.llm_cost_usd.toFixed(4)}`);
}
