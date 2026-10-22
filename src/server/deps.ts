// The real dependencies (Anthropic with its on-disk cache, Tiingo per plan), built in one
// place for the API route. Keys are read from the server's environment
// only; nothing here is ever sent to the browser.

import type { CompareDeps } from "../lib/compare.js";
import { anthropicTransport } from "../lib/llm.js";
import { tiingoFromEnv } from "../lib/tiingo.js";
import { XCache, fetchPosts, xClient } from "../lib/x.js";
import type { FetchFromX } from "./posts.js";

export function realDeps(extra: Partial<CompareDeps> = {}): { deps: CompareDeps; tiingo: ReturnType<typeof tiingoFromEnv>["tiingo"] } {
  const budget = Number(process.env.LLM_BUDGET_USD);
  if (!process.env.ANTHROPIC_API_KEY || !(budget > 0)) throw new Error("Server is missing ANTHROPIC_API_KEY or LLM_BUDGET_USD.");
  if (!process.env.TIINGO_API_TOKEN) throw new Error("Server is missing TIINGO_API_TOKEN.");
  const { tiingo, prices, persist } = tiingoFromEnv();
  return {
    tiingo,
    deps: {
      llm: { transport: anthropicTransport(), budgetUsd: budget, cacheDir: ".cache/llm", ledgerPath: ".cache/llm-ledger.jsonl" },
      // Cached and saved only on a plan whose terms allow it (Power).
      prices,
      persistReport: persist,
      outDir: ".cache/runs",
      ...extra,
    },
  };
}

/// Fetching posts from X, if X_BEARER_TOKEN is set; otherwise only saved
/// fixtures resolve. Responses are cached under .cache/x for 30 days.
export function xFromEnv(): FetchFromX | undefined {
  const token = process.env.X_BEARER_TOKEN;
  if (!token) return undefined;
  const client = xClient({ token, cache: new XCache(".cache/x"), logPath: ".cache/x-requests.jsonl" });
  return (ids) => fetchPosts(client, ids);
}
