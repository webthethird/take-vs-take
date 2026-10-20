// Where posts come from while X retrieval isn't enabled: the saved fixtures.
// A URL resolves only if a fixture for that exact post exists, so the UI
// can't send arbitrary text to the model (or spend on it).

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fixtureToPostInput } from "../lib/fixture.js";
import { parsePostUrlPair } from "../lib/post-url.js";
import { err, type Result } from "../lib/result.js";
import type { PostInput } from "../lib/schema.js";

export const FIXTURE_DIR = "fixtures/private";
export const CANDIDATES = "fixtures/candidates.md";

export type DemoPair = { id: string; subject: string; category: string; a_url: string; b_url: string; a_label: string; b_label: string };

/// Pairs from the pre-registered candidates file whose posts are saved
/// locally. Labels are the developer's, written before any analysis.
export async function listDemoPairs(root = "."): Promise<DemoPair[]> {
  let md: string;
  let files: string[];
  try {
    md = await readFile(join(root, CANDIDATES), "utf8");
    files = await readdir(join(root, FIXTURE_DIR));
  } catch {
    return [];
  }
  const out: DemoPair[] = [];
  for (const section of md.split(/^## /m).slice(1)) {
    const id = section.split("\n", 1)[0]!.trim();
    const field = (k: string) => section.match(new RegExp(`^- ${k}: (.*)$`, "m"))?.[1]?.trim() ?? "";
    if (!/^pair-\d+$/.test(id) || !files.includes(`${id}-a.json`) || !files.includes(`${id}-b.json`)) continue;
    out.push({ id, subject: field("subject"), category: field("category"), a_url: field("a_url"), b_url: field("b_url"), a_label: field("a_label"), b_label: field("b_label") });
  }
  return out;
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
