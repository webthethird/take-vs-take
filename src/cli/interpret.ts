// Run thesis analysis (and optionally a portfolio draft) on fixture files.
// Development tool: one post at a time, never two sides together.
//
//   pnpm interpret fixtures/synthetic/*.json
//   pnpm interpret --draft fixtures/synthetic/syn-02-bearish-sector.json
//   pnpm interpret --nonce s2 fixtures/synthetic/syn-01-bullish-single.json
//
// Real calls cost money and are capped by LLM_BUDGET_USD across all runs
// (see src/lib/llm.ts). Cached results replay for free.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { z } from "zod";
import { analyzeThesis, draftPortfolio, priceTickerCheck, type Attempt } from "../lib/interpret.js";
import { anthropicTransport, ledgerTotal, type LlmConfig } from "../lib/llm.js";
import { LookAheadGate, cachedSource } from "../lib/prices.js";
import { ThesisInput } from "../lib/schema.js";
import { tiingoSource } from "../lib/tiingo.js";
import { round1 } from "../lib/weights.js";

const Fixture = z.object({
  id: z.string(),
  expect_status: z.string().optional(),
  input: ThesisInput,
});

const args = process.argv.slice(2);
const draft = args.includes("--draft");
const nonceIdx = args.indexOf("--nonce");
const nonce = nonceIdx >= 0 ? args[nonceIdx + 1] : undefined;
const files = args.filter((a, i) => !a.startsWith("--") && !(nonceIdx >= 0 && i === nonceIdx + 1));
if (files.length === 0) {
  console.error("usage: pnpm interpret [--draft] [--nonce <id>] <fixture.json>...");
  process.exit(2);
}

try {
  process.loadEnvFile(".env");
} catch {
  // Reported below if the key is missing.
}
const budget = Number(process.env.LLM_BUDGET_USD);
if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set (.env)");
if (!Number.isFinite(budget) || budget <= 0) throw new Error("LLM_BUDGET_USD must be a positive number (.env)");

const cfg: LlmConfig = {
  transport: anthropicTransport(),
  budgetUsd: budget,
  cacheDir: ".cache/llm",
  ledgerPath: ".cache/llm-ledger.jsonl",
};
const tiingo = tiingoSource({ token: process.env.TIINGO_API_TOKEN ?? "" });
const prices = cachedSource(tiingo, ".cache/prices");

const spentBefore = await ledgerTotal(cfg.ledgerPath);
const cost = (as: Attempt[]) => as.reduce((s, a) => s + a.cost_usd, 0);
const describe = (as: Attempt[]) =>
  as.map((a, i) => `#${i + 1} ${a.cached ? "cached" : `$${a.cost_usd.toFixed(4)} (in ${a.usage.input_tokens} + cache write ${a.usage.cache_creation_input_tokens} + cache read ${a.usage.cache_read_input_tokens}, out ${a.usage.output_tokens}, ${a.model_served})`}${a.problems.length ? ` rejected: ${a.problems.join(" | ")}` : ""}`).join("\n    ");

await mkdir(".cache/runs", { recursive: true });

for (const file of files) {
  const fx = Fixture.parse(JSON.parse(await readFile(file, "utf8")));
  console.log(`\n== ${fx.id}${fx.input.synthetic ? " (SYNTHETIC)" : ""}`);

  const a = await analyzeThesis(cfg, fx.input, { nonce });
  console.log(`  analyze: ${a.attempts.length} attempt(s), $${cost(a.attempts).toFixed(4)}\n    ${describe(a.attempts)}`);
  if (!a.ok) {
    console.log(`  FAILED ${a.error}: ${a.message}`);
    continue;
  }
  const an = a.value.analysis;
  const match = fx.expect_status ? (an.status === fx.expect_status ? "matches expected" : `EXPECTED ${fx.expect_status}`) : "";
  console.log(`  status: ${an.status} ${match}\n  reason: ${an.status_reason}`);
  console.log(`  claim: ${an.economic_claim}  [${an.direction}]`);
  for (const i of an.interpretations) {
    console.log(`  ${i.id === an.default_interpretation ? "*" : " "} ${i.id} ${i.label}${i.author_stated ? "" : " (inferred)"} — ${i.expression}\n       gap: ${i.gap_note}`);
  }

  const record: Record<string, unknown> = { fixture: basename(file), nonce: nonce ?? null, analysis: a.value };
  if (draft && an.status === "investable" && an.default_interpretation) {
    const gate = new LookAheadGate(prices, new Date(fx.input.created_at));
    const d = await draftPortfolio(cfg, fx.input, an, an.default_interpretation, priceTickerCheck(gate, new Date(fx.input.created_at)), { nonce });
    console.log(`  draft: ${d.attempts.length} attempt(s), $${cost(d.attempts).toFixed(4)}, Tiingo requests so far ${tiingo.requests}\n    ${describe(d.attempts)}`);
    if (!d.ok) {
      console.log(`  DRAFT FAILED ${d.error}: ${d.message}`);
    } else {
      const p = d.value.portfolio;
      console.log(`  "${p.title}" — ${p.concentration}, ${p.positions.length} positions, cash ${p.cash_weight}% (${p.cash_reason})`);
      if (p.long_only_note) console.log(`  long-only: ${p.long_only_note}`);
      if (p.exclusions.length) console.log(`  excludes: ${p.exclusions.join("; ")}`);
      for (const b of p.buckets) {
        console.log(`   [${round1(b.weight)}%] ${b.name}`);
        for (const pos of p.positions.filter((x) => x.bucket === b.name)) {
          console.log(`      ${pos.ticker.padEnd(6)} ${round1(pos.weight).toString().padStart(5)}%  ${pos.tier.padEnd(10)} ${pos.role}`);
        }
      }
      record.draft = d.value;
    }
  }
  const out = `.cache/runs/${fx.id}${nonce ? `-${nonce}` : ""}.json`;
  await writeFile(out, JSON.stringify(record, null, 2));
}

const spentAfter = await ledgerTotal(cfg.ledgerPath);
console.log(`\nLLM spend this run $${(spentAfter - spentBefore).toFixed(4)}; recorded total $${spentAfter.toFixed(4)} of $${budget.toFixed(2)} budget.`);
