// POST /api/compare  { a: "<X url>", b: "<X url>", latest?: true }
//
// An example pair runs through its pinned end date (window_end in
// fixtures/candidates.md) unless `latest` asks for prices through today.
//
// Runs the whole pipeline on the server and streams progress as NDJSON.
// This file only ever runs in Node on the server: API keys stay here.
//
// Guards, because this endpoint spends money:
//   - same-origin only: a page on another site can't make your browser call it;
//   - JSON only (a cross-site JSON POST needs a CORS preflight we never grant);
//   - a post resolves from a saved fixture, or by fetching that exact post
//     from X (only when X_BEARER_TOKEN is set), so no visitor-supplied text
//     ever reaches the model;
//   - one run at a time, taken before any X fetch, so two requests can't
//     both spend or both pass the budget check;
//   - paid runs are limited per visitor and in total per day (limits.ts):
//     the first billable request of a run charges it, so cached replays are
//     always free and a refused run has spent nothing;
//   - the LLM budget and Tiingo quota still apply inside compare().

import { z } from "zod";
import type { CompareEvent, PostView } from "../../../lib/api.js";
import type { PostInput } from "../../../lib/schema.js";
import { compare } from "../../../lib/compare.js";
import { realDeps, xFromEnv } from "../../../server/deps.js";
import { RunLimiter, limitsFromEnv, refusalMessage, spendGate, visitorId } from "../../../server/limits.js";
import { canonicalOrder, pinnedWindowEnd, resolvePosts } from "../../../server/posts.js";
import { reportView } from "../../../server/view.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ a: z.string().max(500), b: z.string().max(500), latest: z.boolean().optional() });

let running = false;
const limiter = new RunLimiter(".cache/run-limits.json", limitsFromEnv());

const json = (status: number, e: Extract<CompareEvent, { type: "error" }>) => Response.json(e, { status });

export async function POST(req: Request): Promise<Response> {
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (!origin || !host || new URL(origin).host !== host) {
    return json(403, { type: "error", error: "forbidden", message: "Cross-origin requests are not allowed." });
  }
  if (!req.headers.get("content-type")?.startsWith("application/json")) {
    return json(415, { type: "error", error: "unsupported", message: "Send JSON." });
  }
  const body = Body.safeParse(await req.json().catch(() => null));
  if (!body.success) return json(400, { type: "error", error: "invalid_request", message: "Expected { a, b } post URLs." });

  if (running) return json(409, { type: "error", error: "busy", message: "A comparison is already running. Try again when it finishes." });
  running = true;
  // Released here on any early return; otherwise by the stream when it ends.
  const fail = (status: number, e: Extract<CompareEvent, { type: "error" }>) => {
    running = false;
    return json(status, e);
  };

  const gate = spendGate(limiter, visitorId(req.headers, process.env.VISITOR_IP_HEADER));
  let a, b, swapped, pin, deps;
  try {
    const posts = await resolvePosts(body.data.a, body.data.b, ".", xFromEnv(gate.charge));
    if (gate.refusal) {
      running = false;
      return Response.json({ type: "error", error: "rate_limited", message: refusalMessage(gate.refusal) } satisfies CompareEvent, {
        status: 429,
        headers: gate.refusal.retry_at ? { "retry-after": String(Math.max(1, Math.ceil((Date.parse(gate.refusal.retry_at) - Date.now()) / 1000))) } : {},
      });
    }
    if (!posts.ok) return fail(posts.error === "x_unavailable" ? 502 : 400, { type: "error", error: posts.error, message: posts.message, side: posts.side });
    // One order per pair, so swapped links replay the cached comparison.
    ({ posts: [a, b], swapped } = await canonicalOrder(posts.value[0], posts.value[1]));
    pin = body.data.latest ? { ok: true as const, value: null } : await pinnedWindowEnd(a.post_id, b.post_id);
    if (!pin.ok) return fail(500, { type: "error", error: "config", message: pin.message });
    deps = realDeps(pin.value ? { end: pin.value } : {});
    deps.deps.llm = { ...deps.deps.llm, beforeSpend: gate.charge };
  } catch (e) {
    return fail(500, { type: "error", error: "config", message: (e as Error).message });
  }
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: CompareEvent) => controller.enqueue(enc.encode(JSON.stringify(e) + "\n"));
      try {
        const r = await compare({ ...deps.deps, onStage: (stage) => send({ type: "stage", stage }) }, a, b);
        // A refused run is reported as such, even when compare() carried on
        // without the refused step (alignment, drivers and fidelity are
        // optional): a partial report would hide why it's partial.
        if (gate.refusal) {
          send({ type: "error", error: "rate_limited", message: refusalMessage(gate.refusal) });
        } else if (r.ok) {
          const view = (p: PostInput): PostView => ({
            text: p.text,
            author_name: p.author_name ?? null,
            text_verified: p.provenance.text_verified,
            context: p.context.map((c) => ({ kind: c.kind, text: c.text })),
            shown: {
              images: p.media.filter((m) => m.kind === "photo").length,
              video_previews: p.media.filter((m) => m.kind !== "photo").length,
              links: p.links.length,
              unavailable: p.unavailable_context,
            },
          });
          send({ type: "result", report: reportView(r.value), posts: { A: view(a), B: view(b) }, pinned_end: pin.value, swapped });
        } else {
          send({ type: "error", error: r.error, message: r.message });
        }
      } catch (e) {
        send({ type: "error", error: "internal", message: (e as Error).message });
      } finally {
        running = false;
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}
