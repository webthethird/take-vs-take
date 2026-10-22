// Where posts come from while X retrieval isn't enabled: the saved fixtures.
// A URL resolves only if a fixture for that exact post exists, so the UI
// can't send arbitrary text to the model (or spend on it).

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fixtureToPostInput } from "../lib/fixture.js";
import { parsePostUrl, parsePostUrlPair } from "../lib/post-url.js";
import { etDate } from "../lib/prices.js";
import { err, type Result } from "../lib/result.js";
import type { PostInput } from "../lib/schema.js";

export const FIXTURE_DIR = "fixtures/private";
export const CANDIDATES = "fixtures/candidates.md";

export type DemoPair = {
  id: string;
  subject: string;
  category: string;
  a_url: string;
  b_url: string;
  a_label: string;
  b_label: string;
  /// Last day the backtest runs through, fixed so the example's numbers
  /// don't drift between runs. Empty means through the latest prices.
  window_end: string;
};

/// Every pair in the pre-registered candidates file, whether or not its
/// posts are saved locally.
export async function readCandidates(root = "."): Promise<DemoPair[]> {
  let md: string;
  try {
    md = await readFile(join(root, CANDIDATES), "utf8");
  } catch {
    return [];
  }
  const out: DemoPair[] = [];
  for (const section of md.split(/^## /m).slice(1)) {
    const id = section.split("\n", 1)[0]!.trim();
    const field = (k: string) => section.match(new RegExp(`^- ${k}: (.*)$`, "m"))?.[1]?.trim() ?? "";
    if (!/^pair-\d+$/.test(id)) continue;
    out.push({
      id,
      subject: field("subject"),
      category: field("category"),
      a_url: field("a_url"),
      b_url: field("b_url"),
      a_label: field("a_label"),
      b_label: field("b_label"),
      window_end: field("window_end"),
    });
  }
  return out;
}

/// Pairs from the pre-registered candidates file whose posts are saved
/// locally. Labels are the developer's, written before any analysis.
export async function listDemoPairs(root = "."): Promise<DemoPair[]> {
  let files: string[];
  try {
    files = await readdir(join(root, FIXTURE_DIR));
  } catch {
    return [];
  }
  return (await readCandidates(root)).filter((p) => files.includes(`${p.id}-a.json`) && files.includes(`${p.id}-b.json`));
}

/// The pinned end date for two posts, if they are a candidate pair (in
/// either order). Null means no pin: the window runs through the latest
/// prices. A pin that isn't a real past date is an error, never ignored, so
/// a typo can't silently turn a pinned example back into a rolling one.
export async function pinnedWindowEnd(postIdA: string, postIdB: string, root = ".", now = new Date()): Promise<Result<string | null, "invalid_window_end">> {
  const ids = (p: DemoPair) => [p.a_url, p.b_url].map((u) => {
    const r = parsePostUrl(u);
    return r.ok ? r.value.postId : null;
  });
  const want = [postIdA, postIdB].sort().join(",");
  const pair = (await readCandidates(root)).find((p) => ids(p).sort().join(",") === want);
  if (!pair?.window_end) return { ok: true, value: null };
  const d = pair.window_end;
  const ms = Date.parse(`${d}T00:00:00Z`);
  // Date.parse rolls 2026-02-30 over to March; the round trip catches it.
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === d;
  if (!valid) return err("invalid_window_end", `${pair.id}: window_end "${d}" isn't a YYYY-MM-DD date.`);
  if (d >= etDate(now)) return err("invalid_window_end", `${pair.id}: window_end ${d} isn't in the past; pin a completed trading day.`);
  return { ok: true, value: d };
}

export type ResolveError = "invalid_url" | "same_post" | "not_available";

export async function resolvePosts(a: string, b: string, root = "."): Promise<Result<[PostInput, PostInput], ResolveError> & { side?: "a" | "b" | "both" }> {
  const pair = parsePostUrlPair(a, b);
  if (!pair.ok) return { ...err(pair.error === "same_post" ? "same_post" : "invalid_url", pair.message), side: pair.side };

  const byId = new Map<string, PostInput>();
  for (const f of await readdir(join(root, FIXTURE_DIR)).catch(() => [] as string[])) {
    if (!f.endsWith(".json")) continue;
    try {
      const p = fixtureToPostInput(JSON.parse(await readFile(join(root, FIXTURE_DIR, f), "utf8")));
      if (p.ok) byId.set(p.value.post_id, p.value);
    } catch {
      // An unreadable fixture just isn't available.
    }
  }
  const posts: PostInput[] = [];
  for (const [i, p] of pair.value.entries()) {
    const found = byId.get(p.postId);
    if (!found) {
      return { ...err("not_available", "This post isn't saved locally, and fetching from X isn't enabled yet. Use one of the example pairs."), side: i === 0 ? "a" : "b" };
    }
    posts.push(found);
  }
  return { ok: true, value: [posts[0]!, posts[1]!] };
}
