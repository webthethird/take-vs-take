import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fixtureToPostInput } from "../src/lib/fixture.js";

const NOW = new Date("2026-10-19T00:00:00Z");

const base = {
  url: "https://twitter.com/example_user/status/2104572633027080443?s=20",
  author_handle: "example_user",
  author_name: "Example User",
  text: "Example post text.",
  retrieved_at: "2026-10-19T00:00:00Z",
};

describe("fixtureToPostInput", () => {
  it("derives ID, canonical URL and timestamp; marks text unverified", () => {
    const r = fixtureToPostInput(base, NOW);
    assert.ok(r.ok, !r.ok ? r.message : "");
    if (!r.ok) return;
    assert.equal(r.value.post_id, "2104572633027080443");
    assert.equal(r.value.url, "https://x.com/example_user/status/2104572633027080443");
    assert.equal(r.value.created_at, "2026-09-28T14:03:11.439Z");
    assert.equal(r.value.provenance.source, "fixture_manual");
    assert.equal(r.value.provenance.text_verified, false);
    assert.deepEqual(r.value.context, []);
  });

  it("accepts a created_at cross-check at minute precision in local time", () => {
    // 10:03 EDT == 14:03 UTC, as the X UI would display it.
    const r = fixtureToPostInput({ ...base, created_at: "2026-09-28T10:03:00-04:00" }, NOW);
    assert.ok(r.ok, !r.ok ? r.message : "");
  });

  it("rejects a created_at that disagrees with the post ID", () => {
    const r = fixtureToPostInput({ ...base, created_at: "2026-09-28T15:03:00Z" }, NOW);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, "created_at_mismatch");
  });

  it("rejects an author_handle that disagrees with the URL", () => {
    const r = fixtureToPostInput({ ...base, author_handle: "someoneelse" }, NOW);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, "handle_mismatch");
  });

  it("compares handles case-insensitively", () => {
    const r = fixtureToPostInput({ ...base, author_handle: "Example_User" }, NOW);
    assert.ok(r.ok);
  });

  it("rejects a fixture with no text", () => {
    const r = fixtureToPostInput({ ...base, text: "" }, NOW);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, "invalid_fixture");
  });

  it("rejects a non-status URL", () => {
    const r = fixtureToPostInput({ ...base, url: "https://x.com/example_user" }, NOW);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, "invalid_url");
  });

  it("rejects a pre-snowflake post rather than inventing a timestamp", () => {
    const r = fixtureToPostInput({ ...base, url: "https://twitter.com/jack/status/20", author_handle: "jack" }, NOW);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, "no_timestamp");
  });
});

describe("toThesisInput", () => {
  it("passes text, date, context and attachments; drops author, URL and provenance", async () => {
    const { toThesisInput } = await import("../src/lib/fixture.js");
    const r = fixtureToPostInput({ ...base, attachments: ["image", "link"] }, NOW);
    assert.ok(r.ok);
    if (!r.ok) return;
    const t = toThesisInput(r.value);
    assert.deepEqual(Object.keys(t).sort(), ["attachments", "context", "created_at", "links", "media", "synthetic", "text", "unavailable_context"]);
    assert.deepEqual(t.attachments, ["image", "link"]);
    assert.doesNotMatch(JSON.stringify(t), /example_user|Example_User|x\.com/);
  });
});
