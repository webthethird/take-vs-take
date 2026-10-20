// The real dependencies (Anthropic with its on-disk cache, Tiingo uncached), built in one
// place for the API route. Keys are read from the server's environment
// only; nothing here is ever sent to the browser.

import type { CompareDeps } from "../lib/compare.js";
import { anthropicTransport } from "../lib/llm.js";
import { tiingoSource } from "../lib/tiingo.js";

export function realDeps(extra: Partial<CompareDeps> = {}): { deps: CompareDeps; tiingo: ReturnType<typeof tiingoSource> } {
  const budget = Number(process.env.LLM_BUDGET_USD);
  if (!process.env.ANTHROPIC_API_KEY || !(budget > 0)) throw new Error("Server is missing ANTHROPIC_API_KEY or LLM_BUDGET_USD.");
  if (!process.env.TIINGO_API_TOKEN) throw new Error("Server is missing TIINGO_API_TOKEN.");
  const tiingo = tiingoSource({ token: process.env.TIINGO_API_TOKEN, requestLog: ".cache/tiingo-requests.log", maxRequests: 45 });
  return {
    tiingo,
    deps: {
      llm: { transport: anthropicTransport(), budgetUsd: budget, cacheDir: ".cache/llm", ledgerPath: ".cache/llm-ledger.jsonl" },
      // Not cached: Tiingo's Starter terms forbid storing its data (1.6(a)).
      prices: tiingo,
      outDir: ".cache/runs",
      ...extra,
    },
  };
}
