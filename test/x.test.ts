import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { XCache, cleanText, fetchPosts, xClient, type XResponse } from "../src/lib/x.js";

// Shapes follow real responses (2026-10-22); all text is synthetic.
const MAIN = "2099000000000000001";
const QUOTED = "2098000000000000002";
const PARENT = "2097000000000000003";
const OTHER = "2099000000000000004";

const user = { id: "u1", username: "someone", name: "Some One" };
const userB = { id: "u2", username: "other_user", name: "Other" };

function respond(bodies: XResponse[], status: number[] = []) {
  const calls: string[] = [];
  const fetch = (async (url: string | URL | Request) => {
    calls.push(String(url));
    const i = calls.length - 1;
    const s = status[i] ?? 200;
    return new Response(JSON.stringify(bodies[Math.min(i, bodies.length - 1)] ?? {}), { status: s, headers: s === 429 ? { "x-rate-limit-reset": String(Math.floor(Date.now() / 1000) + 1) } : {} });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}
const noSleep = async () => {};

const mainPost: XResponse = {
  data: [
    {
      id: MAIN,
      author_id: "u1",
      text: "Short version… https://t.co/media1 https://t.co/quote1",
      note_post: {
        text: "Copper &amp; power are the bottleneck for data centers. Source: https://t.co/link1 https://t.co/media1 https://t.co/quote1",
        entities: {
          urls: [
            { url: "https://t.co/link1", expanded_url: "https://example.com/report", title: "A report", description: "On power demand" },
            { url: "https://t.co/media1", expanded_url: `https://x.com/someone/status/${MAIN}/photo/1`, media_key: "3_m1" },
            { url: "https://t.co/quote1", expanded_url: `https://twitter.com/x/status/${QUOTED}` },
          ],
        },
      },
      attachments: { media_keys: ["3_m1"] },
      referenced_posts: [
        { id: QUOTED, type: "quoted" },
        { id: PARENT, type: "replied_to" },
      ],
    },
  ],
  includes: { media: [{ media_key: "3_m1", type: "photo", url: "https://pbs.twimg.com/media/m1.jpg" }], users: [user] },
};
const refs: XResponse = {
  data: [
    { id: QUOTED, author_id: "u9", text: "Quoted take with a video https://t.co/v", entities: { urls: [{ url: "https://t.co/v", expanded_url: `https://x.com/q/status/${QUOTED}/video/1`, media_key: "13_v1" }] }, attachments: { media_keys: ["13_v1"] } },
  ],
  includes: { media: [{ media_key: "13_v1", type: "video", preview_image_url: "https://pbs.twimg.com/thumb/v1.jpg" }] },
  errors: [{ value: PARENT, type: "https://api.twitter.com/2/problems/resource-not-found", detail: "Could not find" }],
};

describe("fetchPosts", () => {
  it("maps a long post with media, a quote and a missing parent", async () => {
    const { fetch, calls } = respond([mainPost, refs]);
    const r = await fetchPosts(xClient({ token: "t", fetch, sleep: noSleep }), [MAIN], () => new Date("2026-10-22T00:00:00Z"));
    assert.ok(r.ok, !r.ok ? r.message : "");
    if (!r.ok) return;
    const p = r.value[0]!;
    assert.equal(calls.length, 2, "the post, then what it references");
    assert.match(calls[1]!, new RegExp(`ids=${PARENT},${QUOTED}&`));
    assert.equal(p.text, "Copper & power are the bottleneck for data centers. Source: https://example.com/report");
    assert.equal(p.url, `https://x.com/someone/status/${MAIN}`);
    assert.equal(p.author_name, "Some One");
    assert.deepEqual(p.context, [{ kind: "quoted", post_id: QUOTED, text: "Quoted take with a video" }]);
    assert.deepEqual(p.unavailable_context, ["parent"]);
    assert.deepEqual(
      p.media.map((m) => [m.from, m.kind, m.url]),
      [
        ["post", "photo", "https://pbs.twimg.com/media/m1.jpg"],
        ["quoted", "video_preview", "https://pbs.twimg.com/thumb/v1.jpg"],
      ],
    );
    assert.deepEqual(p.links, [{ from: "post", url: "https://example.com/report", title: "A report", description: "On power demand" }]);
    assert.equal(p.provenance.source, "x_api");
    assert.equal(p.provenance.text_verified, true);
    // The timestamp comes from the ID, not the response.
    assert.equal(p.created_at.slice(0, 4), "2026");
  });

  it("returns posts in the order asked and skips the second request when nothing is referenced", async () => {
    const body: XResponse = {
      data: [
        { id: OTHER, author_id: "u2", text: "B" },
        { id: MAIN, author_id: "u1", text: "A" },
      ],
      includes: { users: [user, userB] },
    };
    const { fetch, calls } = respond([body]);
    const r = await fetchPosts(xClient({ token: "t", fetch, sleep: noSleep }), [MAIN, OTHER]);
    assert.ok(r.ok);
    if (r.ok) assert.deepEqual(r.value.map((p) => p.text), ["A", "B"]);
    assert.equal(calls.length, 1);
  });

  it("says which post failed, and why", async () => {
    const cases: [XResponse, string][] = [
      [{ errors: [{ value: MAIN, type: "https://api.twitter.com/2/problems/resource-not-found" }] }, "not_found"],
      [{ errors: [{ resource_id: MAIN, type: "https://api.twitter.com/2/problems/not-authorized-for-resource" }] }, "not_authorized"],
      [{ data: [{ id: MAIN, author_id: "u1", text: "RT", referenced_posts: [{ id: QUOTED, type: "retweeted" }] }], includes: { users: [user] } }, "unsupported"],
    ];
    for (const [body, error] of cases) {
      const r = await fetchPosts(xClient({ token: "t", fetch: respond([body]).fetch, sleep: noSleep }), [OTHER, MAIN].slice(1));
      assert.equal(r.ok, false);
      if (!r.ok) {
        assert.equal(r.error, error);
        assert.equal(r.index, 0);
      }
    }
  });
});

describe("xClient", () => {
  it("retries a rate limit that resets soon, then succeeds", async () => {
    const { fetch, calls } = respond([{}, { data: [] }], [429, 200]);
    const r = await xClient({ token: "t", fetch, sleep: noSleep }).lookup([MAIN]);
    assert.ok(r.ok);
    assert.equal(calls.length, 2);
  });

  it("fails clearly on bad credentials and on a refused payment", async () => {
    const auth = await xClient({ token: "t", fetch: respond([{}], [401]).fetch, sleep: noSleep }).lookup([MAIN]);
    assert.equal(!auth.ok && auth.error, "auth");
    const paid = await xClient({ token: "t", fetch: respond([{}], [402]).fetch, sleep: noSleep }).lookup([MAIN]);
    assert.equal(!paid.ok && paid.error, "api_error");
    if (!paid.ok) assert.match(paid.message, /402/);
  });

  it("sends the token only in the Authorization header", async () => {
    let seen: { url: string; auth: string | null } | null = null;
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen = { url: String(url), auth: new Headers(init?.headers).get("authorization") };
      return new Response("{}");
    }) as typeof globalThis.fetch;
    await xClient({ token: "secret-token", fetch }).lookup([MAIN]);
    assert.equal(seen!.auth, "Bearer secret-token");
    assert.doesNotMatch(seen!.url, /secret-token/);
  });
});

describe("beforeRequest", () => {
  it("refuses a lookup before sending it, and isn't asked for a cache hit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tvt-x-"));
    const cache = new XCache(dir);
    const { fetch, calls } = respond([{ data: [] }]);
    let allow = false;
    let asked = 0;
    const client = xClient({ token: "t", fetch, cache, sleep: noSleep, beforeRequest: async () => (asked++, allow ? null : "limit reached") });
    const refused = await client.lookup([MAIN]);
    assert.ok(!refused.ok && refused.error === "rate_limited" && refused.message === "limit reached");
    assert.equal(calls.length, 0);
    allow = true;
    assert.ok((await client.lookup([MAIN])).ok);
    allow = false;
    assert.ok((await client.lookup([MAIN])).ok, "cached: no gate");
    assert.deepEqual([calls.length, asked], [1, 2]);
  });
});

describe("XCache", () => {
  it("serves a fresh entry, then stops serving and deletes it after 30 days", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tvt-x-"));
    let now = new Date("2026-10-01T00:00:00Z");
    const cache = new XCache(dir, () => now);
    const { fetch, calls } = respond([{ data: [] }]);
    const client = xClient({ token: "t", fetch, cache, sleep: noSleep });
    await client.lookup([MAIN, OTHER]);
    await client.lookup([OTHER, MAIN]);
    assert.equal(calls.length, 1, "same IDs in any order: one request");

    now = new Date("2026-10-30T23:00:00Z");
    assert.ok(await cache.get([MAIN, OTHER]), "29 days: still served");
    now = new Date("2026-10-31T00:00:01Z");
    assert.equal(await cache.get([MAIN, OTHER]), null, "30 days: never served");
    assert.equal(await cache.sweep(), 1);
    assert.deepEqual(await readdir(dir), []);
  });

  it("dates a post from a cache hit by its original fetch, so the 30-day clock doesn't restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tvt-x-"));
    let now = new Date("2026-10-01T00:00:00Z");
    const cache = new XCache(dir, () => now);
    const body: XResponse = { data: [{ id: MAIN, author_id: "u1", text: "A" }], includes: { users: [user] } };
    const client = xClient({ token: "t", fetch: respond([body]).fetch, cache, sleep: noSleep });
    now = new Date("2026-10-01T00:00:00Z");
    await fetchPosts(client, [MAIN], () => now);
    now = new Date("2026-10-20T00:00:00Z");
    const r = await fetchPosts(client, [MAIN], () => now);
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.value[0]!.provenance.retrieved_at, "2026-10-01T00:00:00.000Z");
  });

  it("sweeps expired and unreadable entries nobody asks for again", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tvt-x-"));
    await writeFile(join(dir, "old.json"), JSON.stringify({ fetched_at: "2026-01-01T00:00:00Z", response: {} }));
    await writeFile(join(dir, "junk.json"), "{");
    await writeFile(join(dir, "new.json"), JSON.stringify({ fetched_at: "2026-10-20T00:00:00Z", response: {} }));
    const cache = new XCache(dir, () => new Date("2026-10-22T00:00:00Z"));
    // Any lookup sweeps first.
    await xClient({ token: "t", fetch: respond([{}]).fetch, cache }).lookup([MAIN]);
    const left = (await readdir(dir)).sort();
    assert.ok(!left.includes("old.json") && !left.includes("junk.json") && left.includes("new.json"));
    assert.ok(JSON.parse(await readFile(join(dir, "new.json"), "utf8")));
  });
});

describe("cleanText", () => {
  it("keeps the short text when there's no long version, and decodes entities", () => {
    assert.equal(cleanText({ id: MAIN, text: "a &lt; b &amp;&amp; c &gt; d" }), "a < b && c > d");
  });
});
