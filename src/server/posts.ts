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
import type { XError } from "../lib/x.js";

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

/// The candidate pair made of these two posts, in either order, if any.
async function findCandidate(postIdA: string, postIdB: string, root: string): Promise<{ pair: DemoPair; aId: string | null } | undefined> {
  const id = (u: string) => {
    const r = parsePostUrl(u);
    return r.ok ? r.value.postId : null;
  };
  const want = [postIdA, postIdB].sort().join(",");
  for (const pair of await readCandidates(root)) {
    const ids = [id(pair.a_url), id(pair.b_url)];
    if ([...ids].sort().join(",") === want) return { pair, aId: ids[0]! };
  }
  return undefined;
}

/// One fixed order per pair of posts, so pasting the links swapped gives the
/// same comparison (and replays its cached model calls) instead of a new,
/// paid one. A candidate pair keeps its pre-registered A/B order; any other
/// pair puts the earlier post first (post IDs grow with time). Each side is
/// still built independently, so order changes only the labels.
export async function canonicalOrder<T extends { post_id: string }>(a: T, b: T, root = "."): Promise<{ posts: [T, T]; swapped: boolean }> {
  const found = await findCandidate(a.post_id, b.post_id, root);
  const swapped = found ? found.aId === b.post_id : BigInt(b.post_id) < BigInt(a.post_id);
  return { posts: swapped ? [b, a] : [a, b], swapped };
}

/// The pinned end date for two posts, if they are a candidate pair (in
/// either order). Null means no pin: the window runs through the latest
/// prices. A pin that isn't a real past date is an error, never ignored, so
/// a typo can't silently turn a pinned example back into a rolling one.
export async function pinnedWindowEnd(postIdA: string, postIdB: string, root = ".", now = new Date()): Promise<Result<string | null, "invalid_window_end">> {
  const pair = (await findCandidate(postIdA, postIdB, root))?.pair;
  if (!pair?.window_end) return { ok: true, value: null };
  const d = pair.window_end;
  const ms = Date.parse(`${d}T00:00:00Z`);
  // Date.parse rolls 2026-02-30 over to March; the round trip catches it.
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === d;
  if (!valid) return err("invalid_window_end", `${pair.id}: window_end "${d}" isn't a YYYY-MM-DD date.`);
  if (d >= etDate(now)) return err("invalid_window_end", `${pair.id}: window_end ${d} isn't in the past; pin a completed trading day.`);
  return { ok: true, value: d };
}

export type ResolveError = "invalid_url" | "same_post" | "not_available" | "not_found" | "not_authorized" | "unsupported" | "x_unavailable";

/// Fetches posts from X by ID, in the order asked (src/lib/x.ts fetchPosts).
export type FetchFromX = (ids: string[]) => Promise<Result<PostInput[], XError> & { index?: number }>;

/// A saved fixture wins (free, and its results are pinned); any other post
/// is fetched from X when fetching is enabled.
export async function resolvePosts(
  a: string,
  b: string,
  root = ".",
  fetchFromX?: FetchFromX,
): Promise<Result<[PostInput, PostInput], ResolveError> & { side?: "a" | "b" | "both" }> {
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
  const side = (i: number) => (i === 0 ? "a" : "b") as "a" | "b";
  const missing = pair.value.map((p, i) => ({ id: p.postId, i })).filter((m) => !byId.has(m.id));
  if (missing.length > 0) {
    if (!fetchFromX) {
      return { ...err("not_available", "This post isn't saved locally, and fetching from X isn't enabled. Use one of the example pairs."), side: missing.length === 2 ? "both" : side(missing[0]!.i) };
    }
    const r = await fetchFromX(missing.map((m) => m.id));
    if (!r.ok) {
      const code: ResolveError = r.error === "not_found" || r.error === "not_authorized" || r.error === "unsupported" ? r.error : "x_unavailable";
      const where = r.index !== undefined ? side(missing[r.index]!.i) : missing.length === 2 ? "both" : side(missing[0]!.i);
      return { ...err(code, r.message), side: where };
    }
    r.value.forEach((p, k) => byId.set(missing[k]!.id, p));
  }
  const posts = pair.value.map((p) => byId.get(p.postId)!);
  return { ok: true, value: [posts[0]!, posts[1]!] };
}
