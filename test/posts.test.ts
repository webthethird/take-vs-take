import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { canonicalOrder, listDemoPairs, pinnedWindowEnd, resolvePosts, type FetchFromX } from "../src/server/posts.js";
import { err } from "../src/lib/result.js";
import type { PostInput } from "../src/lib/schema.js";

const A = "2077459480963616779";
const B = "2099566262431203737";
const C = "2078118055087931511";
const NOW = new Date("2026-10-22T15:00:00Z");

async function root(pairs: { id: string; a: string; b: string; end?: string }[], fixtures: string[] = []) {
  const d = await mkdtemp(join(tmpdir(), "tvt-posts-"));
  await mkdir(join(d, "fixtures/private"), { recursive: true });
  const md = pairs
    .map((p) => `## ${p.id}\n\n- subject: S\n- a_url: https://x.com/u/status/${p.a}?s=20\n- b_url: https://x.com/v/status/${p.b}\n${p.end === undefined ? "" : `- window_end: ${p.end}\n`}`)
    .join("\n");
  await writeFile(join(d, "fixtures/candidates.md"), `# Candidates\n\n${md}`);
  for (const f of fixtures) await writeFile(join(d, "fixtures/private", f), "{}");
  return d;
}

describe("pinnedWindowEnd", () => {
  it("finds a pair's pin by post IDs, in either order", async () => {
    const d = await root([{ id: "pair-01", a: A, b: B, end: "2026-10-21" }]);
    assert.deepEqual(await pinnedWindowEnd(A, B, d, NOW), { ok: true, value: "2026-10-21" });
    assert.deepEqual(await pinnedWindowEnd(B, A, d, NOW), { ok: true, value: "2026-10-21" });
  });

  it("reads post-hoc pairs too", async () => {
    const d = await root([{ id: "posthoc-01", a: A, b: B, end: "2026-10-21" }]);
    assert.deepEqual(await pinnedWindowEnd(B, A, d, NOW), { ok: true, value: "2026-10-21" });
  });

  it("is null for a pair with no pin, or posts that aren't a candidate pair", async () => {
    const d = await root([
      { id: "pair-01", a: A, b: B, end: "" },
      { id: "pair-02", a: A, b: C },
    ]);
    assert.deepEqual(await pinnedWindowEnd(A, B, d, NOW), { ok: true, value: null });
    assert.deepEqual(await pinnedWindowEnd(A, C, d, NOW), { ok: true, value: null });
    assert.deepEqual(await pinnedWindowEnd(B, C, d, NOW), { ok: true, value: null });
    assert.deepEqual(await pinnedWindowEnd(A, B, join(d, "missing"), NOW), { ok: true, value: null });
  });

  it("rejects a pin that isn't a real, completed date instead of ignoring it", async () => {
    for (const end of ["2026-10-2", "21 Oct 2026", "2026-02-30", "2026-13-01", "2026-10-22", "2026-11-01"]) {
      const d = await root([{ id: "pair-01", a: A, b: B, end }]);
      const r = await pinnedWindowEnd(A, B, d, NOW);
      assert.equal(r.ok, false, end);
      if (!r.ok) assert.equal(r.error, "invalid_window_end");
    }
  });
});

describe("listDemoPairs", () => {
  it("lists only pairs whose two fixtures exist, with their pins", async () => {
    const d = await root(
      [
        { id: "pair-01", a: A, b: B, end: "2026-10-21" },
        { id: "pair-02", a: A, b: C },
      ],
      ["pair-01-a.json", "pair-01-b.json", "pair-02-a.json"],
    );
    const pairs = await listDemoPairs(d);
    assert.deepEqual(pairs.map((p) => [p.id, p.window_end]), [["pair-01", "2026-10-21"]]);
  });
});

describe("canonicalOrder", () => {
  const post = (post_id: string) => ({ post_id });
  const ids = (r: { posts: { post_id: string }[] }) => r.posts.map((p) => p.post_id);

  it("keeps a candidate pair's A/B order whichever way the posts arrive", async () => {
    // B (2099...) is later than A (2077...): the pre-registered order wins, not time.
    const d = await root([{ id: "pair-01", a: B, b: A }]);
    assert.deepEqual(ids(await canonicalOrder(post(B), post(A), d)), [B, A]);
    const r = await canonicalOrder(post(A), post(B), d);
    assert.deepEqual(ids(r), [B, A]);
    assert.equal(r.swapped, true);
  });

  it("puts the earlier post first for any other pair, comparing IDs as numbers", async () => {
    const d = await root([]);
    assert.deepEqual(await canonicalOrder(post(A), post(C), d), { posts: [post(A), post(C)], swapped: false });
    assert.deepEqual(await canonicalOrder(post(C), post(A), d), { posts: [post(A), post(C)], swapped: true });
    // As strings "999" > "1000"; as IDs it's earlier.
    assert.deepEqual(ids(await canonicalOrder(post("1000"), post("999"), d)), ["999", "1000"]);
  });
});

describe("resolvePosts", () => {
  const fixture = (id: string) => ({ url: `https://x.com/saved/status/${id}`, author_handle: "saved", text: "Saved text.", retrieved_at: "2026-10-19T00:00:00Z" });
  const fetched = (id: string) =>
    ({ post_id: id, url: `https://x.com/live/status/${id}`, author_handle: "live", text: "Fetched text.", created_at: "2026-09-01T00:00:00.000Z", context: [], attachments: [], media: [], links: [], unavailable_context: [], provenance: { source: "x_api", text_verified: true, retrieved_at: "2026-10-22T00:00:00.000Z" } }) as PostInput;

  it("uses a saved fixture when there is one and fetches only the other post", async () => {
    const d = await root([]);
    await writeFile(join(d, "fixtures/private/one.json"), JSON.stringify(fixture(A)));
    const asked: string[][] = [];
    const fetchFromX: FetchFromX = async (ids) => {
      asked.push(ids);
      return { ok: true, value: ids.map(fetched) };
    };
    const r = await resolvePosts(`https://x.com/u/status/${A}`, `https://x.com/u/status/${B}`, d, fetchFromX);
    assert.ok(r.ok);
    assert.deepEqual(asked, [[B]]);
    if (r.ok) assert.deepEqual(r.value.map((p) => p.provenance.source), ["fixture_manual", "x_api"]);
  });

  it("without X fetching, a post that isn't saved is unavailable", async () => {
    const r = await resolvePosts(`https://x.com/u/status/${A}`, `https://x.com/u/status/${B}`, await root([]));
    assert.equal(!r.ok && r.error, "not_available");
    if (!r.ok) assert.equal(r.side, "both");
  });

  it("points an X failure at the side it belongs to", async () => {
    const d = await root([]);
    const fetchFromX: FetchFromX = async () => ({ ...err("not_found", "deleted"), index: 1 });
    const r = await resolvePosts(`https://x.com/u/status/${A}`, `https://x.com/u/status/${B}`, d, fetchFromX);
    assert.equal(!r.ok && r.error, "not_found");
    if (!r.ok) assert.equal(r.side, "b");
    const down: FetchFromX = async () => err("network", "unreachable");
    const r2 = await resolvePosts(`https://x.com/u/status/${A}`, `https://x.com/u/status/${B}`, d, down);
    assert.equal(!r2.ok && r2.error, "x_unavailable");
    if (!r2.ok) assert.equal(r2.side, "both");
  });
});
