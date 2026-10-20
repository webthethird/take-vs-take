// POST /api/compare  { a: "<X url>", b: "<X url>" }
//
// Runs the whole pipeline on the server and streams progress as NDJSON.
// This file only ever runs in Node on the server: API keys stay here.
//
// Guards, because this endpoint spends money:
//   - same-origin only: a page on another site can't make your browser call it;
//   - JSON only (a cross-site JSON POST needs a CORS preflight we never grant);
//   - only posts saved as fixtures resolve, so arbitrary text never reaches
//     the model;
//   - one run at a time, so two runs can't both pass the budget check;
//   - the LLM budget and Tiingo quota still apply inside compare().

import { z } from "zod";
import type { CompareEvent } from "../../../lib/api.js";
import { compare } from "../../../lib/compare.js";
import { realDeps } from "../../../server/deps.js";
import { resolvePosts } from "../../../server/posts.js";
import { reportView } from "../../../server/view.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const Body = z.object({ a: z.string().max(500), b: z.string().max(500) });

let running = false;

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

  const posts = await resolvePosts(body.data.a, body.data.b);
  if (!posts.ok) return json(400, { type: "error", error: posts.error, message: posts.message, side: posts.side });
  if (running) return json(409, { type: "error", error: "busy", message: "A comparison is already running. Try again when it finishes." });

  let deps;
  try {
    deps = realDeps();
  } catch (e) {
    return json(500, { type: "error", error: "config", message: (e as Error).message });
  }

  running = true;
  const [a, b] = posts.value;
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: CompareEvent) => controller.enqueue(enc.encode(JSON.stringify(e) + "\n"));
      try {
        const r = await compare({ ...deps.deps, onStage: (stage) => send({ type: "stage", stage }) }, a, b);
        if (r.ok) {
          const view = (p: typeof a) => ({ text: p.text, author_name: p.author_name ?? null, text_verified: p.provenance.text_verified });
          send({ type: "result", report: reportView(r.value), posts: { A: view(a), B: view(b) } });
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
