// One structured model call: budget check -> cache -> API -> ledger.
//
// Every real call is appended to a persistent ledger, and LLM_BUDGET_USD caps
// the ledger's total, not one process. Before each call the worst case (all
// input uncached, every allowed output token used) is added to recorded spend;
// if that would exceed the budget, the call is refused rather than made.
//
// Responses are cached by a hash of everything that could change the output
// (model, prompt version, system prompt, messages, effort, max_tokens, nonce).
// A cached response is a pinned input: replaying a run reads the same output
// and costs nothing. Pass a nonce to draw an independent sample (the
// self-consistency baseline) — it is cached under its own key.

import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { err, type Result } from "./result.js";

export const DEFAULT_MODEL = "claude-opus-5-5";

/// $/MTok. From the official models overview, checked 2026-10-19. Cache
/// reads are 5% of input on Opus 5.5 / Sonnet 5.5 and 10% on Haiku 5.5 (same
/// page); cache writes at 1.25x input are the documented 5-minute TTL rate.
export const PRICING: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};
/// Used when a fallback serves the request with a model not in the table, so
/// unknown pricing can only over-count spend, never under-count it.
const UNKNOWN_MODEL_PRICING = { input: 10, output: 50, cacheRead: 10, cacheWrite: 12.5 };

export type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
};

export function costUsd(model: string, u: Usage): number {
  const p = PRICING[model] ?? UNKNOWN_MODEL_PRICING;
  return (
    (u.input_tokens * p.input +
      u.output_tokens * p.output +
      u.cache_creation_input_tokens * p.cacheWrite +
      u.cache_read_input_tokens * p.cacheRead) /
    1e6
  );
}

/// Upper bound on one call's cost. Input tokens are over-estimated at one per
/// two characters (English runs ~4 characters per token; the current tokenizer
/// uses up to ~1.35x more tokens than older ones).
export function worstCaseUsd(model: string, inputChars: number, maxTokens: number, images = 0): number {
  const p = PRICING[model] ?? UNKNOWN_MODEL_PRICING;
  const input = Math.ceil(inputChars / 2) + images * IMAGE_TOKENS_WORST;
  return (input * Math.max(p.input, p.cacheWrite) + maxTokens * p.output) / 1e6;
}

/// An image costs tokens by its pixel area after the API downsizes it; its
/// URL in the request says nothing about that. A generous per-image bound
/// keeps a call with images from slipping under the budget check.
export const IMAGE_TOKENS_WORST = 6_000;

function countImages(messages: Anthropic.Beta.BetaMessageParam[]): number {
  return messages.reduce((n, m) => n + (typeof m.content === "string" ? 0 : m.content.filter((b) => b.type === "image").length), 0);
}

// ── Transport: the seam tests replace ────────────────────────────────────

export type ModelRequest = {
  model: string;
  system: string;
  messages: Anthropic.Beta.BetaMessageParam[];
  outputSchema: z.ZodType;
  maxTokens: number;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
};

export type ModelResponse = {
  id: string;
  /// The model that actually served the request; differs from the requested
  /// one when a server-side fallback ran.
  model: string;
  stopReason: string | null;
  refusalCategory: string | null;
  parsed: unknown;
  /// Full content, thinking blocks included. Must be passed back unchanged
  /// in a follow-up turn.
  content: Anthropic.Beta.BetaContentBlock[];
  usage: Usage;
};

export interface Transport {
  call(req: ModelRequest): Promise<ModelResponse>;
}

/// The real API. Server-side fallbacks are on ("default" routes by refusal
/// category), as recommended for Opus 5.5; the served model is recorded.
export function anthropicTransport(client = new Anthropic()): Transport {
  return {
    async call(req) {
      const r = await client.beta.messages.parse({
        model: req.model,
        max_tokens: req.maxTokens,
        // Stable system prompt first, cached; per-call content in messages.
        system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
        messages: req.messages,
        output_config: { format: zodOutputFormat(req.outputSchema), effort: req.effort },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      });
      const details = r.stop_details as { category?: string | null } | null | undefined;
      return {
        id: r.id,
        model: r.model,
        stopReason: r.stop_reason,
        refusalCategory: r.stop_reason === "refusal" ? (details?.category ?? null) : null,
        parsed: r.parsed_output,
        content: r.content,
        usage: {
          input_tokens: r.usage.input_tokens,
          output_tokens: r.usage.output_tokens,
          cache_creation_input_tokens: r.usage.cache_creation_input_tokens ?? 0,
          cache_read_input_tokens: r.usage.cache_read_input_tokens ?? 0,
        },
      };
    },
  };
}

// ── Ledger ───────────────────────────────────────────────────────────────

export type LedgerEntry = {
  ts: string;
  request_id: string;
  model_requested: string;
  model_served: string;
  prompt_version: string;
  stop_reason: string | null;
  usage: Usage;
  cost_usd: number;
};

export async function ledgerTotal(path: string): Promise<number> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return 0;
  }
  let total = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    // A corrupt line must not make spend look smaller than it was.
    let e: LedgerEntry;
    try {
      e = JSON.parse(line) as LedgerEntry;
    } catch {
      throw new Error(`Corrupt LLM ledger line in ${path}; refusing to guess recorded spend.`);
    }
    total += e.cost_usd;
  }
  return total;
}

// ── Structured call ──────────────────────────────────────────────────────

export type LlmConfig = {
  transport: Transport;
  budgetUsd: number;
  cacheDir: string;
  ledgerPath: string;
  model?: string;
  now?: () => Date;
  /// Cache entries written under this config expire at this time and are
  /// then deleted. Set for calls carrying content fetched from X, which may
  /// be kept only 30 days from its fetch (see xExpiry). Unset, entries never
  /// expire.
  cacheExpiresAt?: Date;
  /// Asked before each billable call (never for a cache hit). A message
  /// refuses the call: a public endpoint's per-visitor limit.
  beforeSpend?: () => Promise<string | null>;
};

export type CallSpec<S extends z.ZodType> = {
  promptVersion: string;
  system: string;
  messages: Anthropic.Beta.BetaMessageParam[];
  schema: S;
  maxTokens?: number;
  effort?: ModelRequest["effort"];
  /// Distinct nonces draw independent samples; each is cached separately.
  nonce?: string;
};

export type CallResult<T> = {
  value: T;
  content: Anthropic.Beta.BetaContentBlock[];
  meta: {
    cached: boolean;
    request_id: string;
    model_requested: string;
    model_served: string;
    prompt_version: string;
    cache_key: string;
    usage: Usage;
    cost_usd: number;
  };
};

export type LlmError = "budget_exceeded" | "rate_limited" | "refused" | "truncated" | "parse_failed" | "api_error";

type CacheEntry = { response: ModelResponse; created_at: string; model_requested: string; prompt_version: string; expires_at?: string };

/// Expiring entries live in their own subdirectory, so the sweep reads only
/// those, not the whole cache.
export const EXPIRING_DIR = "expiring";
/// Last sweep per cache directory, so a long-running server still sweeps
/// daily without rereading the directory on every call.
const lastSweep = new Map<string, number>();

/// Delete expired entries. structuredCall runs it at most once a day per
/// cache directory; callable directly too.
export async function sweepLlmCache(cacheDir: string, now: Date = new Date()): Promise<number> {
  const dir = join(cacheDir, EXPIRING_DIR);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const f of files.filter((x) => x.endsWith(".json"))) {
    const path = join(dir, f);
    try {
      const e = JSON.parse(await readFile(path, "utf8")) as CacheEntry;
      if (e.expires_at && Date.parse(e.expires_at) > now.getTime()) continue;
    } catch {
      // Unreadable: delete it too.
    }
    await rm(path, { force: true });
    removed++;
  }
  return removed;
}

export async function structuredCall<S extends z.ZodType>(
  cfg: LlmConfig,
  spec: CallSpec<S>,
): Promise<Result<CallResult<z.infer<S>>, LlmError>> {
  const model = cfg.model ?? DEFAULT_MODEL;
  const maxTokens = spec.maxTokens ?? 16_000;
  const effort = spec.effort ?? "medium";
  const now = cfg.now ?? (() => new Date());

  const key = createHash("sha256")
    .update(JSON.stringify([model, spec.promptVersion, spec.system, spec.messages, effort, maxTokens, spec.nonce ?? null]))
    .digest("hex");
  const expiring = cfg.cacheExpiresAt !== undefined;
  const cachePath = expiring ? join(cfg.cacheDir, EXPIRING_DIR, `${key}.json`) : join(cfg.cacheDir, `${key}.json`);
  if (expiring && now().getTime() - (lastSweep.get(cfg.cacheDir) ?? -Infinity) >= 86_400_000) {
    lastSweep.set(cfg.cacheDir, now().getTime());
    await sweepLlmCache(cfg.cacheDir, now());
  }

  const finish = (resp: ModelResponse, cached: boolean, cost: number): Result<CallResult<z.infer<S>>, LlmError> => {
    if (resp.stopReason === "refusal") {
      return err("refused", `The model declined (category: ${resp.refusalCategory ?? "none"}).`);
    }
    if (resp.stopReason === "max_tokens") return err("truncated", `Output hit max_tokens (${maxTokens}).`);
    const parsed = spec.schema.safeParse(resp.parsed);
    if (!parsed.success) return err("parse_failed", `Output did not match the schema: ${parsed.error.message}`);
    return {
      ok: true,
      value: {
        value: parsed.data,
        content: resp.content,
        meta: {
          cached,
          request_id: resp.id,
          model_requested: model,
          model_served: resp.model,
          prompt_version: spec.promptVersion,
          cache_key: key,
          usage: resp.usage,
          cost_usd: cost,
        },
      },
    };
  };

  try {
    const hit = JSON.parse(await readFile(cachePath, "utf8")) as CacheEntry;
    if (!hit.expires_at || Date.parse(hit.expires_at) > now().getTime()) return finish(hit.response, true, 0);
    await rm(cachePath, { force: true });
  } catch {
    // Miss.
  }

  const inputChars = spec.system.length + JSON.stringify(spec.messages).length;
  const spent = await ledgerTotal(cfg.ledgerPath);
  const worst = worstCaseUsd(model, inputChars, maxTokens, countImages(spec.messages));
  if (spent + worst > cfg.budgetUsd) {
    return err(
      "budget_exceeded",
      `LLM budget $${cfg.budgetUsd.toFixed(2)}: $${spent.toFixed(4)} recorded, and this call could cost up to $${worst.toFixed(4)}.`,
    );
  }

  const refused = await cfg.beforeSpend?.();
  if (refused) return err("rate_limited", refused);

  let resp: ModelResponse;
  try {
    resp = await cfg.transport.call({ model, system: spec.system, messages: spec.messages, outputSchema: spec.schema, maxTokens, effort });
  } catch (e) {
    // The SDK has already retried 429/5xx/connection errors (2 retries).
    const status = e instanceof Anthropic.APIError ? ` (HTTP ${e.status})` : "";
    return err("api_error", `Model call failed${status}: ${(e as Error).message}`);
  }

  // Record spend before anything else can fail: the money is spent either way.
  const cost = costUsd(resp.model, resp.usage);
  const entry: LedgerEntry = {
    ts: now().toISOString(),
    request_id: resp.id,
    model_requested: model,
    model_served: resp.model,
    prompt_version: spec.promptVersion,
    stop_reason: resp.stopReason,
    usage: resp.usage,
    cost_usd: cost,
  };
  await mkdir(dirname(cfg.ledgerPath), { recursive: true });
  await appendFile(cfg.ledgerPath, JSON.stringify(entry) + "\n");

  // Only complete, parseable responses are cached; a refusal or truncation
  // today should be retried, not replayed.
  const result = finish(resp, false, cost);
  if (result.ok) {
    await mkdir(dirname(cachePath), { recursive: true });
    const tmp = `${cachePath}.${process.pid}.tmp`;
    const record: CacheEntry = {
      response: resp,
      created_at: now().toISOString(),
      model_requested: model,
      prompt_version: spec.promptVersion,
      ...(expiring ? { expires_at: cfg.cacheExpiresAt!.toISOString() } : {}),
    };
    await writeFile(tmp, JSON.stringify(record));
    await rename(tmp, cachePath);
  }
  return result;
}
