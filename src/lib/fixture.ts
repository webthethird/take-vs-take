// Offline fixtures: hand-written post records that stand in for X retrieval.
//
// A fixture is a claim by a person ("this URL says this text"), so loading one
// checks every part that can be checked without a network call and marks the
// rest unverified. It never fills in anything it can't derive.

import { readFile } from "node:fs/promises";
import { parsePostUrl, snowflakeTimestamp, type Result } from "./post-url.js";
import { ManualFixture, PostInput } from "./schema.js";

/// Manual created_at values come from the X UI, which shows minutes in local
/// time. A minute of tolerance accepts that precision and nothing looser.
export const CREATED_AT_TOLERANCE_MS = 60_000;

export type FixtureError =
  | "invalid_fixture"
  | "invalid_url"
  | "no_timestamp"
  | "handle_mismatch"
  | "created_at_mismatch";

export function fixtureToPostInput(
  raw: unknown,
  now: Date = new Date(),
): Result<PostInput, FixtureError> {
  const parsed = ManualFixture.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: "invalid_fixture", message: parsed.error.message };
  }
  const f = parsed.data;

  const url = parsePostUrl(f.url);
  if (!url.ok) return { ok: false, error: "invalid_url", message: url.message };

  // Catches text pasted from the wrong post. Handles are case-insensitive.
  if (url.value.handle && url.value.handle.toLowerCase() !== f.author_handle.toLowerCase()) {
    return {
      ok: false,
      error: "handle_mismatch",
      message: `URL handle @${url.value.handle} does not match author_handle @${f.author_handle}.`,
    };
  }

  const ts = snowflakeTimestamp(url.value.postId, now);
  if (!ts.ok) return { ok: false, error: "no_timestamp", message: ts.message };

  if (f.created_at !== undefined) {
    const claimed = new Date(f.created_at).getTime();
    const delta = Math.abs(claimed - ts.value.getTime());
    if (delta > CREATED_AT_TOLERANCE_MS) {
      return {
        ok: false,
        error: "created_at_mismatch",
        message: `created_at ${f.created_at} differs from the post ID's timestamp ${ts.value.toISOString()} by ${Math.round(delta / 1000)}s.`,
      };
    }
  }

  const post = PostInput.parse({
    post_id: url.value.postId,
    url: url.value.canonicalUrl,
    author_handle: f.author_handle,
    author_name: f.author_name,
    text: f.text,
    created_at: ts.value.toISOString(),
    context: f.context,
    provenance: {
      source: "fixture_manual",
      text_verified: false,
      retrieved_at: new Date(f.retrieved_at).toISOString(),
      note: f.note,
    },
  });
  return { ok: true, value: post };
}

export async function loadFixture(path: string): Promise<Result<PostInput, FixtureError>> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    return { ok: false, error: "invalid_fixture", message: `${path}: ${(e as Error).message}` };
  }
  return fixtureToPostInput(raw);
}
