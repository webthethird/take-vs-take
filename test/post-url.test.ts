import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MIN_SNOWFLAKE_ID,
  SNOWFLAKE_EPOCH_MS,
  parsePostUrl,
  parsePostUrlPair,
  snowflakeTimestamp,
} from "../src/lib/post-url.js";

const ID = "2104572633027080443";
const NOW = new Date("2026-10-19T00:00:00Z");

function ok<T>(r: { ok: true; value: T } | { ok: false; message: string }): T {
  if (!r.ok) assert.fail(r.message);
  return r.value;
}

describe("parsePostUrl: accepted variants", () => {
  const variants = [
    `https://x.com/example_user/status/${ID}`,
    `https://twitter.com/example_user/status/${ID}`,
    `https://www.x.com/example_user/status/${ID}`,
    `https://mobile.twitter.com/example_user/status/${ID}`,
    `http://x.com/example_user/status/${ID}`,
    `x.com/example_user/status/${ID}`,
    `  https://x.com/example_user/status/${ID}  `,
    `https://x.com/example_user/status/${ID}?s=20&t=abcdef`,
    `https://x.com/example_user/status/${ID}#reply`,
    `https://x.com/example_user/status/${ID}/`,
    `https://x.com/example_user/status/${ID}/photo/1`,
    `https://x.com/example_user/status/${ID}/analytics`,
    `https://twitter.com/example_user/statuses/${ID}`,
    `https://X.COM/example_user/status/${ID}`,
  ];
  for (const v of variants) {
    it(JSON.stringify(v), () => {
      const p = ok(parsePostUrl(v));
      assert.equal(p.postId, ID);
      assert.equal(p.handle, "example_user");
      assert.equal(p.canonicalUrl, `https://x.com/example_user/status/${ID}`);
    });
  }

  it("handle-less /i/status and /i/web/status", () => {
    for (const v of [`https://x.com/i/status/${ID}`, `https://twitter.com/i/web/status/${ID}`]) {
      const p = ok(parsePostUrl(v));
      assert.equal(p.postId, ID);
      assert.equal(p.handle, null);
      assert.equal(p.canonicalUrl, `https://x.com/i/status/${ID}`);
    }
  });

  it("preserves handle case for display; identity is the ID", () => {
    const p = ok(parsePostUrl(`https://x.com/ExAmPlE_uSeR/status/${ID}`));
    assert.equal(p.handle, "ExAmPlE_uSeR");
    assert.equal(p.postId, ID);
  });

  it("normalises leading zeros in the ID", () => {
    assert.equal(ok(parsePostUrl(`https://x.com/a/status/000${ID}`)).postId, ID);
  });
});

describe("parsePostUrl: rejected inputs", () => {
  const cases: [string, string][] = [
    ["", "empty"],
    ["   ", "empty"],
    ["not a url at all", "not_a_url"],
    [`ftp://x.com/a/status/${ID}`, "not_a_url"],
    [`https://fxtwitter.com/a/status/${ID}`, "unsupported_host"],
    [`https://vxtwitter.com/a/status/${ID}`, "unsupported_host"],
    [`https://x.com.evil.example/a/status/${ID}`, "unsupported_host"],
    [`https://evilx.com/a/status/${ID}`, "unsupported_host"],
    ["https://x.com/example_user", "not_a_status_url"],
    ["https://x.com/home", "not_a_status_url"],
    ["https://x.com/search?q=status", "not_a_status_url"],
    ["https://x.com/i/lists/123", "not_a_status_url"],
    [`https://x.com/bad-handle!/status/${ID}`, "invalid_handle"],
    [`https://x.com/waytoolonghandle16/status/${ID}`, "invalid_handle"],
    ["https://x.com/a/status/", "invalid_post_id"],
    ["https://x.com/a/status/12abc", "invalid_post_id"],
    ["https://x.com/a/status/0", "invalid_post_id"],
    ["https://x.com/a/status/18446744073709551616", "invalid_post_id"], // 2^64
  ];
  for (const [input, error] of cases) {
    it(`${JSON.stringify(input)} -> ${error}`, () => {
      const r = parsePostUrl(input);
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.error, error);
    });
  }
});

describe("snowflakeTimestamp", () => {
  it("matches X's own created_at for a known post", () => {
    // created_at from X for this post: 2026-09-28T14:03:11.000Z (second precision).
    const t = ok(snowflakeTimestamp(ID, NOW));
    assert.equal(t.toISOString(), "2026-09-28T14:03:11.439Z");
  });

  it("round-trips constructed IDs at ms precision", () => {
    for (const iso of ["2012-01-01T00:00:00.000Z", "2020-03-16T13:30:00.123Z", "2026-10-18T19:59:59.999Z"]) {
      const ms = BigInt(Date.parse(iso));
      // Low 22 bits (worker/sequence) are arbitrary and must not affect the time.
      for (const low of [0n, 1n, (1n << 22n) - 1n]) {
        const id = (((ms - SNOWFLAKE_EPOCH_MS) << 22n) | low).toString();
        assert.equal(ok(snowflakeTimestamp(id, NOW)).toISOString(), iso);
      }
    }
  });

  it("refuses pre-snowflake IDs rather than returning a 2010 date", () => {
    for (const id of ["20", (MIN_SNOWFLAKE_ID - 1n).toString()]) {
      const r = snowflakeTimestamp(id, NOW);
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.error, "pre_snowflake");
    }
  });

  it("rejects IDs that decode to the future", () => {
    const future = (((BigInt(NOW.getTime()) + 60_000n - SNOWFLAKE_EPOCH_MS) << 22n)).toString();
    const r = snowflakeTimestamp(future, NOW);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, "future_timestamp");
  });

  it("rejects non-numeric IDs", () => {
    const r = snowflakeTimestamp("12a", NOW);
    assert.equal(r.ok, false);
  });
});

describe("parsePostUrlPair", () => {
  const other = "2106035941835944199";

  it("accepts two different posts", () => {
    const [a, b] = ok(parsePostUrlPair(`x.com/example_user/status/${ID}`, `https://x.com/example_user/status/${other}`));
    assert.equal(a.postId, ID);
    assert.equal(b.postId, other);
  });

  it("rejects the same post written two different ways", () => {
    const r = parsePostUrlPair(`https://twitter.com/EXAMPLE_USER/status/${ID}?s=20`, `https://x.com/i/status/${ID}`);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error, "same_post");
      assert.equal(r.side, "both");
    }
  });

  it("reports which side failed", () => {
    const ra = parsePostUrlPair("https://x.com/home", `https://x.com/a/status/${ID}`);
    assert.equal(ra.ok, false);
    if (!ra.ok) assert.equal(ra.side, "a");
    const rb = parsePostUrlPair(`https://x.com/a/status/${ID}`, "nope nope");
    assert.equal(rb.ok, false);
    if (!rb.ok) assert.equal(rb.side, "b");
  });
});
