import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { z } from "zod";
import { VOICE_SYSTEM } from "../src/lib/interpret.js";
import {
  EXPIRING_DIR,
  costUsd,
  ledgerTotal,
  structuredCall,
  sweepLlmCache,
  worstCaseUsd,
  type LlmConfig,
  type ModelRequest,
  type ModelResponse,
  type Transport,
} from "../src/lib/llm.js";

const close = (a: number, b: number, tol = 1e-12) => assert.ok(Math.abs(a - b) < tol, `expected ${b}, got ${a}`);

export function scripted(responses: (Partial<ModelResponse> | Error)[]): Transport & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    async call(req) {
      requests.push(structuredClone({ ...req, outputSchema: undefined as never }));
      const next = responses.shift();
      if (next === undefined) throw new Error("scripted transport: no more responses");
      if (next instanceof Error) throw next;
      return {
        id: `msg_${requests.length}`,
        model: req.model,
        stopReason: "end_turn",
        refusalCategory: null,
        parsed: null,
        content: [{ type: "text", text: "{}", citations: null }] as ModelResponse["content"],
        usage: { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        ...next,
      };
    },
  };
}

/// Routes voice-classification calls to their own script (default: every
/// post states its own view), so pipeline tests keep their response order
/// and request counts. Voice requests are recorded separately.
export function withVoice<T extends Transport & { requests: ModelRequest[] }>(
  main: T,
  voices: unknown[] = [],
): Transport & { requests: ModelRequest[]; voiceRequests: ModelRequest[] } {
  const voiceRequests: ModelRequest[] = [];
  return {
    requests: main.requests,
    voiceRequests,
    async call(req) {
      if (req.system !== VOICE_SYSTEM) return main.call(req);
      voiceRequests.push(structuredClone({ ...req, outputSchema: undefined as never }));
      const parsed = voices.length > 0 ? voices.shift() : { voice: "own_view", commentary: null, reason: "States a view." };
      if (parsed instanceof Error) throw parsed;
      return {
        id: `msg_voice_${voiceRequests.length}`,
        model: req.model,
        stopReason: "end_turn",
        refusalCategory: null,
        parsed,
        content: [{ type: "text", text: "{}", citations: null }] as ModelResponse["content"],
        usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      };
    },
  };
}

const Schema = z.object({ answer: z.string() });
const spec = { promptVersion: "test-v1", system: "sys", messages: [{ role: "user" as const, content: "hi" }], schema: Schema, maxTokens: 1000 };

const dirs: string[] = [];
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
async function config(transport: Transport, budgetUsd = 5): Promise<LlmConfig> {
  const d = await mkdtemp(join(tmpdir(), "tvt-llm-"));
  dirs.push(d);
  return { transport, budgetUsd, cacheDir: join(d, "cache"), ledgerPath: join(d, "ledger.jsonl"), now: () => new Date("2026-10-19T12:00:00Z") };
}

describe("pricing", () => {
  it("costs each token class at its own rate", () => {
    // Opus 5.5: $4 in, $20 out, $5 cache write, $0.20 cache read per MTok.
    const c = costUsd("claude-opus-5-5", { input_tokens: 1e6, output_tokens: 1e6, cache_creation_input_tokens: 1e6, cache_read_input_tokens: 1e6 });
    close(c, 4 + 20 + 5 + 0.2);
  });

  it("prices an unknown served model conservatively", () => {
    const u = { input_tokens: 1e6, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    assert.ok(costUsd("some-fallback-model", u) >= costUsd("claude-opus-5-5", u));
  });

  it("worst case assumes every allowed output token and uncached input", () => {
    // 2,000 chars -> 1,000 tokens at the cache-write rate ($5) + 16,000 × $20.
    close(worstCaseUsd("claude-opus-5-5", 2000, 16_000), (1000 * 5 + 16_000 * 20) / 1e6);
  });
});

describe("structuredCall", () => {
  it("returns the parsed value and records spend in the ledger", async () => {
    const t = scripted([{ parsed: { answer: "yes" } }]);
    const cfg = await config(t);
    const r = await structuredCall(cfg, spec);
    assert.ok(r.ok, !r.ok ? r.message : "");
    if (!r.ok) return;
    assert.equal(r.value.value.answer, "yes");
    assert.equal(r.value.meta.cached, false);
    close(r.value.meta.cost_usd, (1000 * 4 + 500 * 20) / 1e6);
    close(await ledgerTotal(cfg.ledgerPath), r.value.meta.cost_usd);
    assert.equal(t.requests[0]!.effort, "medium");
    assert.equal(t.requests[0]!.model, "claude-opus-5-5");
  });

  it("serves a repeat from cache: no call, no cost, no ledger entry", async () => {
    const t = scripted([{ parsed: { answer: "yes" } }]);
    const cfg = await config(t);
    await structuredCall(cfg, spec);
    const before = await ledgerTotal(cfg.ledgerPath);
    const r = await structuredCall(cfg, spec);
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.value.meta.cached, true);
      assert.equal(r.value.meta.cost_usd, 0);
    }
    assert.equal(t.requests.length, 1);
    assert.equal(await ledgerTotal(cfg.ledgerPath), before);
  });

  it("a nonce draws a new sample; the same nonce replays it", async () => {
    const t = scripted([{ parsed: { answer: "a" } }, { parsed: { answer: "b" } }]);
    const cfg = await config(t);
    await structuredCall(cfg, spec);
    const b = await structuredCall(cfg, { ...spec, nonce: "run-2" });
    const b2 = await structuredCall(cfg, { ...spec, nonce: "run-2" });
    assert.equal(t.requests.length, 2);
    if (b.ok && b2.ok) assert.equal(b2.value.value.answer, "b");
  });

  it("any change to the prompt is a cache miss", async () => {
    const t = scripted([{ parsed: { answer: "a" } }, { parsed: { answer: "b" } }, { parsed: { answer: "c" } }]);
    const cfg = await config(t);
    await structuredCall(cfg, spec);
    await structuredCall(cfg, { ...spec, system: "sys2" });
    await structuredCall(cfg, { ...spec, promptVersion: "test-v2" });
    assert.equal(t.requests.length, 3);
  });

  it("refuses before calling when the budget can't cover the worst case", async () => {
    const t = scripted([{ parsed: { answer: "yes" } }]);
    const cfg = await config(t, 0.01); // worst case for 1,000 output tokens is $0.02
    const r = await structuredCall(cfg, spec);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, "budget_exceeded");
    assert.equal(t.requests.length, 0);
  });

  it("counts images in the worst case: a URL is short, the image isn't", async () => {
    const image = { type: "image" as const, source: { type: "url" as const, url: "https://pbs.twimg.com/media/a.jpg" } };
    const withImages = { ...spec, messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }, image, image, image, image] }] };
    // Text only: ~$0.02 worst case, under $0.05. Four images add 24,000 tokens at $5/MTok.
    const ok = await structuredCall(await config(scripted([{ parsed: { answer: "yes" } }]), 0.05), spec);
    assert.ok(ok.ok);
    const t = scripted([{ parsed: { answer: "yes" } }]);
    const r = await structuredCall(await config(t, 0.05), withImages);
    assert.equal(!r.ok && r.error, "budget_exceeded");
    assert.equal(t.requests.length, 0);
  });

  it("the budget is cumulative across processes via the ledger", async () => {
    const t = scripted([{ parsed: { answer: "yes" } }]);
    const cfg = await config(t, 5);
    await writeFile(cfg.ledgerPath, JSON.stringify({ cost_usd: 4.99 }) + "\n");
    const r = await structuredCall(cfg, spec);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, "budget_exceeded");
  });

  it("a corrupt ledger stops calls rather than under-counting spend", async () => {
    const cfg = await config(scripted([{ parsed: { answer: "yes" } }]));
    await writeFile(cfg.ledgerPath, "{not json\n");
    await assert.rejects(structuredCall(cfg, spec), /Corrupt LLM ledger/);
  });

  it("a refusal is an error, is charged, and is not cached", async () => {
    const t = scripted([{ stopReason: "refusal", refusalCategory: "cyber" }, { parsed: { answer: "yes" } }]);
    const cfg = await config(t);
    const r = await structuredCall(cfg, spec);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error, "refused");
      assert.match(r.message, /cyber/);
    }
    assert.ok((await ledgerTotal(cfg.ledgerPath)) > 0);
    assert.ok((await structuredCall(cfg, spec)).ok);
    assert.equal(t.requests.length, 2);
  });

  it("truncation and schema mismatch are distinct errors", async () => {
    const cfg = await config(scripted([{ stopReason: "max_tokens" }, { parsed: { wrong: 1 } }]));
    const a = await structuredCall(cfg, spec);
    const b = await structuredCall(cfg, spec);
    assert.ok(!a.ok && a.error === "truncated");
    assert.ok(!b.ok && b.error === "parse_failed");
  });

  it("a transport failure is api_error and costs nothing", async () => {
    const cfg = await config(scripted([new Error("connection reset")]));
    const r = await structuredCall(cfg, spec);
    assert.ok(!r.ok && r.error === "api_error");
    assert.equal(await ledgerTotal(cfg.ledgerPath), 0);
  });

  it("records the served model when a fallback ran", async () => {
    const t = scripted([{ parsed: { answer: "yes" }, model: "claude-opus-5" }]);
    const cfg = await config(t);
    const r = await structuredCall(cfg, spec);
    assert.ok(r.ok);
    if (r.ok) {
      assert.equal(r.value.meta.model_served, "claude-opus-5");
      // Priced as the model that served it. claude-opus-5 isn't in the table,
      // so the conservative rate applies: more than Opus 5.5 would cost.
      const u = { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
      close(r.value.meta.cost_usd, costUsd("claude-opus-5", u));
      assert.ok(r.value.meta.cost_usd > costUsd("claude-opus-5-5", u));
    }
    const line = JSON.parse((await readFile(cfg.ledgerPath, "utf8")).trim());
    assert.equal(line.model_requested, "claude-opus-5-5");
    assert.equal(line.model_served, "claude-opus-5");
  });
});

describe("expiring cache entries", () => {
  it("replays an expiring entry until it expires, then pays again and deletes the old one", async () => {
    const t = scripted([{ parsed: { answer: "first" } }, { parsed: { answer: "second" } }]);
    const base = await config(t);
    let now = new Date("2026-10-01T00:00:00Z");
    const cfg = { ...base, cacheExpiresAt: new Date("2026-10-31T00:00:00Z"), now: () => now };
    assert.ok((await structuredCall(cfg, spec)).ok);
    assert.equal((await readdir(join(cfg.cacheDir, EXPIRING_DIR))).length, 1);

    now = new Date("2026-10-30T23:00:00Z");
    const replay = await structuredCall(cfg, spec);
    assert.ok(replay.ok && replay.value.meta.cached && replay.value.value.answer === "first");

    now = new Date("2026-10-31T00:00:01Z");
    const fresh = await structuredCall(cfg, spec);
    assert.ok(fresh.ok && !fresh.value.meta.cached && fresh.value.value.answer === "second");
    assert.equal(t.requests.length, 2);
  });

  it("the sweep deletes expired entries only, and never touches non-expiring ones", async () => {
    const t = scripted([{ parsed: { answer: "x" } }, { parsed: { answer: "y" } }]);
    const base = await config(t);
    await structuredCall({ ...base, now: () => new Date("2026-01-01T00:00:00Z") }, spec);
    await structuredCall({ ...base, cacheExpiresAt: new Date("2026-01-31T00:00:00Z"), now: () => new Date("2026-01-01T00:00:00Z") }, { ...spec, system: "other" });
    assert.equal(await sweepLlmCache(base.cacheDir, new Date("2026-01-15T00:00:00Z")), 0);
    assert.equal(await sweepLlmCache(base.cacheDir, new Date("2026-02-01T00:00:00Z")), 1);
    assert.deepEqual(await readdir(join(base.cacheDir, EXPIRING_DIR)), []);
    // The plain entry is still there and still replays.
    const again = await structuredCall({ ...base, now: () => new Date("2027-01-01T00:00:00Z") }, spec);
    assert.ok(again.ok && again.value.meta.cached);
  });
});

describe("beforeSpend", () => {
  it("is asked before a billable call, refuses it without calling the model, and is never asked on a cache hit", async () => {
    const t = scripted([{ parsed: { answer: "x" } }]);
    const base = await config(t);
    let asked = 0;
    const refused = await structuredCall({ ...base, beforeSpend: async () => (asked++, "limit reached") }, spec);
    assert.ok(!refused.ok && refused.error === "rate_limited" && refused.message === "limit reached");
    assert.equal(t.requests.length, 0);
    assert.ok((await structuredCall({ ...base, beforeSpend: async () => (asked++, null) }, spec)).ok);
    assert.equal(t.requests.length, 1);
    const hit = await structuredCall({ ...base, beforeSpend: async () => (asked++, "limit reached") }, spec);
    assert.ok(hit.ok && hit.value.meta.cached);
    assert.equal(asked, 2);
  });
});
