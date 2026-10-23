// Official X API post lookup: the exact posts a user linked, plus the post
// each one quotes or replies to. Nothing else: no search, no threads, no
// replies (CLAUDE.md §5A).
//
// Two requests per comparison at most:
//   1. GET /2/tweets?ids=A,B with media and author expansions;
//   2. the posts those quote or reply to, by ID, for their full text and
//      media (an expansion of the first request carries neither reliably).
// Context stops at one level: a quoted post's own quote isn't fetched.
//
// Billing (docs.x.com pricing, checked 2026-10-22): $0.005 per post and
// $0.010 per user returned, deduplicated per UTC day. The developer
// console's spending limit is the hard cap.
//
// Responses are cached under .cache/x for at most 30 days (the use case
// declared to X), then deleted; see XCache.

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { snowflakeTimestamp } from "./post-url.js";
import { err, type Result } from "./result.js";
import { PostInput, type PostContext, type PostLink, type PostMedia } from "./schema.js";

export const X_API = "https://api.x.com/2/tweets";
export const X_CACHE_MAX_AGE_DAYS = 30;
const DAY_MS = 86_400_000;

/// When anything derived from these posts must be gone: 30 days after the
/// earliest X fetch among them. Null if none came from X.
export function xExpiry(posts: { provenance: { source: string; retrieved_at: string } }[]): Date | null {
  const t = posts.filter((p) => p.provenance.source === "x_api").map((p) => Date.parse(p.provenance.retrieved_at));
  return t.length ? new Date(Math.min(...t) + X_CACHE_MAX_AGE_DAYS * DAY_MS) : null;
}
/// Longest we wait on a 429 before giving up; X's reset can be 15 minutes.
const MAX_RATE_LIMIT_WAIT_MS = 30_000;
const TIMEOUT_MS = 15_000;

const FIELDS = new URLSearchParams({
  "post.fields": "created_at,text,note_post,referenced_posts,attachments,entities,author_id",
  expansions: "attachments.media_keys,author_id",
  "media.fields": "type,url,preview_image_url,alt_text",
  "user.fields": "username,name",
}).toString();

export type XError = "not_found" | "not_authorized" | "unsupported" | "auth" | "rate_limited" | "api_error" | "network" | "invalid_response";

// ── Response shape (only the parts we read) ──────────────────────────────

type XUrlEntity = { url: string; expanded_url?: string; unwound_url?: string; title?: string; description?: string; media_key?: string };
type XPost = {
  id: string;
  text: string;
  created_at?: string;
  author_id?: string;
  note_post?: { text: string; entities?: { urls?: XUrlEntity[] } };
  entities?: { urls?: XUrlEntity[] };
  attachments?: { media_keys?: string[] };
  referenced_posts?: { id: string; type: "quoted" | "replied_to" | "retweeted" }[];
};
type XMedia = { media_key: string; type: "photo" | "video" | "animated_gif"; url?: string; preview_image_url?: string; alt_text?: string };
type XUser = { id: string; username: string; name?: string };
type XProblem = { value?: string; resource_id?: string; title?: string; detail?: string; type?: string };
export type XResponse = {
  data?: XPost[];
  includes?: { media?: XMedia[]; users?: XUser[] };
  errors?: XProblem[];
};

// ── Cache ────────────────────────────────────────────────────────────────

/// Raw lookup responses, one file per request (the sorted ID list). An entry
/// older than 30 days is never served, and every lookup deletes expired
/// entries, so nothing outlives the limit by more than the gap between runs.
export class XCache {
  constructor(
    private readonly dir: string,
    private readonly now: () => Date = () => new Date(),
    private readonly maxAgeDays = X_CACHE_MAX_AGE_DAYS,
  ) {}

  private path(ids: string[]): string {
    const h = createHash("sha256").update([...ids].sort().join(",")).digest("hex").slice(0, 16);
    return join(this.dir, `${h}.json`);
  }

  private fresh(fetchedAt: string): boolean {
    return this.now().getTime() - Date.parse(fetchedAt) < this.maxAgeDays * DAY_MS;
  }

  async get(ids: string[]): Promise<XLookup | null> {
    try {
      const e = JSON.parse(await readFile(this.path(ids), "utf8")) as { fetched_at: string; response: XResponse };
      return this.fresh(e.fetched_at) ? { response: e.response, fetched_at: e.fetched_at } : null;
    } catch {
      return null;
    }
  }

  async put(ids: string[], response: XResponse): Promise<void> {
    const path = this.path(ids);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ fetched_at: this.now().toISOString(), ids: [...ids].sort(), response }));
    await rename(tmp, path);
  }

  /// Delete every expired entry, including ones nobody asks for again.
  async sweep(): Promise<number> {
    let removed = 0;
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return 0;
    }
    for (const f of files.filter((x) => x.endsWith(".json"))) {
      const path = join(this.dir, f);
      try {
        const e = JSON.parse(await readFile(path, "utf8")) as { fetched_at?: string };
        if (e.fetched_at && this.fresh(e.fetched_at)) continue;
      } catch {
        // Unreadable: delete it too.
      }
      await rm(path, { force: true });
      removed++;
    }
    return removed;
  }
}

// ── Client ───────────────────────────────────────────────────────────────

/// A lookup response, and when it was fetched from X if it came from the
/// cache (null: fetched just now). The 30-day clock starts at the fetch, not
/// at the cache hit.
export type XLookup = { response: XResponse; fetched_at: string | null };

export type XClient = {
  lookup(ids: string[]): Promise<Result<XLookup, XError>>;
  /// HTTP requests actually sent (cache hits excluded).
  requests: number;
};

export function xClient(opts: {
  token: string;
  cache?: XCache;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /// One JSON line per request sent, for auditing spend.
  logPath?: string;
}): XClient {
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const client: XClient = {
    requests: 0,
    async lookup(ids) {
      if (ids.length === 0) return { ok: true, value: { response: {}, fetched_at: null } };
      if (opts.cache) {
        await opts.cache.sweep();
        const hit = await opts.cache.get(ids);
        if (hit) return { ok: true, value: hit };
      }
      const url = `${X_API}?ids=${[...ids].sort().join(",")}&${FIELDS}`;
      for (let attempt = 0; ; attempt++) {
        let res: Response;
        try {
          client.requests++;
          res = await doFetch(url, { headers: { authorization: `Bearer ${opts.token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
        } catch (e) {
          if (attempt < 2) continue;
          return err("network", `X API unreachable: ${(e as Error).message}`);
        }
        if (opts.logPath) {
          await mkdir(dirname(opts.logPath), { recursive: true });
          await appendFile(opts.logPath, JSON.stringify({ ts: new Date().toISOString(), ids, status: res.status }) + "\n");
        }
        if (res.status === 429) {
          const reset = Number(res.headers.get("x-rate-limit-reset")) * 1000;
          const wait = Number.isFinite(reset) && reset > 0 ? reset - Date.now() : 5_000;
          if (attempt < 2 && wait <= MAX_RATE_LIMIT_WAIT_MS) {
            await sleep(Math.max(wait, 1_000));
            continue;
          }
          return err("rate_limited", `X API rate limit reached; it resets at ${Number.isFinite(reset) && reset > 0 ? new Date(reset).toISOString() : "an unknown time"}.`);
        }
        if (res.status >= 500 && attempt < 2) {
          await sleep(1_000 * 2 ** attempt);
          continue;
        }
        if (res.status === 401 || res.status === 403) {
          return err("auth", `X API refused the credentials (${res.status}). Check X_BEARER_TOKEN and the app's access.`);
        }
        if (!res.ok) {
          // 402 and similar: out of credits or over the spending limit.
          const body = await res.text().catch(() => "");
          return err("api_error", `X API returned ${res.status}${body ? `: ${body.slice(0, 300)}` : ""}`);
        }
        let body: XResponse;
        try {
          body = (await res.json()) as XResponse;
        } catch {
          return err("invalid_response", "X API returned a body that isn't JSON.");
        }
        if (opts.cache) await opts.cache.put(ids, body);
        return { ok: true, value: { response: body, fetched_at: null } };
      }
    },
  };
  return client;
}

// ── Mapping to PostInput ─────────────────────────────────────────────────

/// Fetch posts by ID, each with the post it quotes or replies to. Returns
/// them in the order asked, or the first post that can't be used.
export async function fetchPosts(
  client: XClient,
  ids: string[],
  now: () => Date = () => new Date(),
): Promise<Result<PostInput[], XError> & { index?: number }> {
  const mainLookup = await client.lookup(ids);
  if (!mainLookup.ok) return mainLookup;
  const main = { value: mainLookup.value.response };
  const posts = new Map((main.value.data ?? []).map((p) => [p.id, p]));

  for (const [index, id] of ids.entries()) {
    const p = posts.get(id);
    if (!p) return { ...problemFor(id, main.value.errors), index };
    if (p.referenced_posts?.some((r) => r.type === "retweeted")) {
      return { ...err("unsupported", "This link is a repost. Paste the link to the original post instead."), index };
    }
  }

  const refIds = [...new Set(ids.flatMap((id) => (posts.get(id)!.referenced_posts ?? []).map((r) => r.id)))].filter((r) => !posts.has(r));
  const refsLookup = await client.lookup(refIds);
  if (!refsLookup.ok) return refsLookup;
  const refs = { value: refsLookup.value.response };
  const refPosts = new Map((refs.value.data ?? []).map((p) => [p.id, p]));
  const media = new Map([...(main.value.includes?.media ?? []), ...(refs.value.includes?.media ?? [])].map((m) => [m.media_key, m]));
  const users = new Map((main.value.includes?.users ?? []).map((u) => [u.id, u]));
  // The earliest fetch whose content the post carries: anything kept from it
  // (saved runs, model-cache entries) expires 30 days after that.
  const fetchedAt = [mainLookup.value.fetched_at, refsLookup.value.fetched_at, now().toISOString()].filter((t): t is string => t !== null);
  const retrieved_at = new Date(Math.min(...fetchedAt.map(Date.parse))).toISOString();

  const out: PostInput[] = [];
  for (const [index, id] of ids.entries()) {
    const p = posts.get(id)!;
    const user = p.author_id ? users.get(p.author_id) : undefined;
    if (!user) return { ...err("invalid_response", `X returned post ${id} without its author.`), index };
    const ts = snowflakeTimestamp(id);
    if (!ts.ok) return { ...err("invalid_response", ts.message), index };

    const context: PostContext[] = [];
    const unavailable: ("parent" | "quoted")[] = [];
    const postMedia: PostMedia[] = mediaFor(p, "post", media);
    const links: PostLink[] = linksFor(p, "post");
    for (const r of p.referenced_posts ?? []) {
      const kind = r.type === "quoted" ? "quoted" : "parent";
      const ref = posts.get(r.id) ?? refPosts.get(r.id);
      if (!ref) {
        unavailable.push(kind);
        continue;
      }
      context.push({ kind, post_id: ref.id, text: cleanText(ref) });
      postMedia.push(...mediaFor(ref, kind, media));
      links.push(...linksFor(ref, kind));
    }

    const parsed = PostInput.safeParse({
      post_id: id,
      url: `https://x.com/${user.username}/status/${id}`,
      author_handle: user.username,
      author_name: user.name,
      text: cleanText(p),
      created_at: ts.value.toISOString(),
      context,
      media: postMedia,
      links,
      unavailable_context: unavailable,
      provenance: { source: "x_api", text_verified: true, retrieved_at },
    });
    if (!parsed.success) return { ...err("invalid_response", `Post ${id}: ${parsed.error.message}`), index };
    out.push(parsed.data);
  }
  return { ok: true, value: out };
}

function problemFor(id: string, errors: XProblem[] = []): { ok: false; error: XError; message: string } {
  const e = errors.find((x) => x.value === id || x.resource_id === id);
  const type = e?.type ?? "";
  if (type.endsWith("/resource-not-found")) return err("not_found", "This post doesn't exist or was deleted.");
  if (type.endsWith("/not-authorized-for-resource")) return err("not_authorized", "This post is private, protected or from a suspended account.");
  return err("invalid_response", `X returned no post ${id}${e?.detail ? `: ${e.detail}` : "."}`);
}

/// The full text (long posts carry it in note_post), with entities decoded.
/// t.co links to the post's own media or to the post it quotes are dropped,
/// as X's own display hides them; other links are expanded.
export function cleanText(p: XPost): string {
  const text = p.note_post?.text ?? p.text;
  const urls = p.note_post?.entities?.urls ?? p.entities?.urls ?? [];
  const quoted = new Set((p.referenced_posts ?? []).map((r) => r.id));
  let out = text;
  for (const u of urls) {
    const target = u.unwound_url ?? u.expanded_url ?? u.url;
    const hide = u.media_key !== undefined || [...quoted].some((id) => new RegExp(`/status(?:es)?/${id}(?:\\D|$)`).test(target));
    out = out.split(u.url).join(hide ? "" : target);
  }
  return decodeEntities(out).replace(/[ \t]+$/gm, "").trim();
}

function decodeEntities(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function mediaFor(p: XPost, from: PostMedia["from"], media: Map<string, XMedia>): PostMedia[] {
  const out: PostMedia[] = [];
  for (const key of p.attachments?.media_keys ?? []) {
    const m = media.get(key);
    const url = m?.type === "photo" ? m.url : m?.preview_image_url;
    if (!m || !url) continue;
    out.push({ from, kind: m.type === "photo" ? "photo" : m.type === "video" ? "video_preview" : "gif_preview", url, alt_text: m.alt_text ?? null });
  }
  return out;
}

function linksFor(p: XPost, from: PostLink["from"]): PostLink[] {
  const quoted = new Set((p.referenced_posts ?? []).map((r) => r.id));
  return (p.note_post?.entities?.urls ?? p.entities?.urls ?? [])
    .filter((u) => u.media_key === undefined)
    .map((u) => ({ u, target: u.unwound_url ?? u.expanded_url ?? u.url }))
    .filter(({ target }) => ![...quoted].some((id) => new RegExp(`/status(?:es)?/${id}(?:\\D|$)`).test(target)))
    .map(({ u, target }) => ({ from, url: target, title: u.title ?? null, description: u.description ?? null }));
}
