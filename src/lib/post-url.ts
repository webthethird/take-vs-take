// X post URL parsing and snowflake timestamp decoding.
//
// Two rules shape this file:
//   1. Never guess a post. A URL either names exactly one status ID or it is
//      rejected with a reason. No fuzzy matching, no lookups.
//   2. The post ID is the identity. Handles are mutable and case-insensitive,
//      so they are kept for display and canonical links but never used to
//      decide whether two inputs are the same post.

/// Hosts that serve the same status pages. Mirror/embed-fixer domains
/// (fxtwitter, vxtwitter, nitter, ...) are deliberately not accepted: they are
/// third-party services, not X.
const ACCEPTED_HOSTS = new Set([
  "x.com",
  "www.x.com",
  "mobile.x.com",
  "twitter.com",
  "www.twitter.com",
  "mobile.twitter.com",
]);

/// X handles: 1–15 of [A-Za-z0-9_].
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const DIGITS = /^[0-9]+$/;

/// Twitter's snowflake epoch, 2010-11-04T01:42:54.657Z, in ms.
export const SNOWFLAKE_EPOCH_MS = 1288834974657n;

/// IDs below this predate snowflake IDs (sequential IDs, pre Nov 2010), so no
/// timestamp can be derived from them. Inferred from the published rollout;
/// the first snowflake IDs were around 2.97e10. Posts this old are outside any
/// window we would backtest, so refusing to decode them costs nothing.
export const MIN_SNOWFLAKE_ID = 30_000_000_000n;

const MAX_UINT64 = (1n << 64n) - 1n;

export type ParsedPostUrl = {
  postId: string;
  /// As written in the URL. Null for /i/status/<id> and /i/web/status/<id>.
  handle: string | null;
  canonicalUrl: string;
};

export type PostUrlError =
  | "empty"
  | "not_a_url"
  | "unsupported_host"
  | "not_a_status_url"
  | "invalid_handle"
  | "invalid_post_id";

export type Result<T, E extends string> =
  | { ok: true; value: T }
  | { ok: false; error: E; message: string };

function fail<E extends string>(error: E, message: string): { ok: false; error: E; message: string } {
  return { ok: false, error, message };
}

export function parsePostUrl(input: string): Result<ParsedPostUrl, PostUrlError> {
  const trimmed = input.trim();
  if (trimmed === "") return fail("empty", "No URL given.");

  // People paste "x.com/user/status/123" without a scheme. Accept that, but
  // nothing looser.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return fail("not_a_url", `Not a URL: ${trimmed}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return fail("not_a_url", `Unsupported scheme: ${url.protocol}`);
  }

  const host = url.hostname.toLowerCase();
  if (!ACCEPTED_HOSTS.has(host)) {
    return fail("unsupported_host", `Not an X/Twitter URL: ${host}`);
  }

  // Query strings (?s=20&t=...) and fragments never change which post a URL
  // names, so they are ignored by construction: only the path is read.
  const segments = url.pathname.split("/").filter((s) => s !== "");

  let handle: string | null;
  let idSegment: string | undefined;

  if (segments[0] === "i" && segments[1] === "status") {
    // /i/status/<id>
    handle = null;
    idSegment = segments[2];
  } else if (segments[0] === "i" && segments[1] === "web" && segments[2] === "status") {
    // /i/web/status/<id>
    handle = null;
    idSegment = segments[3];
  } else if (segments[1] === "status" || segments[1] === "statuses") {
    // /<handle>/status/<id>[/photo/1 | /video/1 | /analytics ...]
    // Trailing segments address media or views of the same post.
    const h = segments[0]!;
    if (!HANDLE.test(h)) return fail("invalid_handle", `Invalid handle: ${h}`);
    handle = h;
    idSegment = segments[2];
  } else {
    return fail("not_a_status_url", "URL does not point to a single post (expected /<handle>/status/<id>).");
  }

  if (idSegment === undefined || !DIGITS.test(idSegment)) {
    return fail("invalid_post_id", `Missing or non-numeric post ID in ${url.pathname}`);
  }
  const id = BigInt(idSegment);
  if (id === 0n || id > MAX_UINT64) {
    return fail("invalid_post_id", `Post ID out of range: ${idSegment}`);
  }

  // Normalise away leading zeros so "00123" and "123" are the same post.
  const postId = id.toString();
  const canonicalUrl = handle
    ? `https://x.com/${handle}/status/${postId}`
    : `https://x.com/i/status/${postId}`;

  return { ok: true, value: { postId, handle, canonicalUrl } };
}

export type SnowflakeError = "invalid_post_id" | "pre_snowflake" | "future_timestamp";

/// Creation time encoded in a snowflake post ID: the top 42 bits are ms since
/// SNOWFLAKE_EPOCH_MS. This is exact to the millisecond and needs no API call.
///
/// `now` exists for tests. An ID that decodes to the future is not a real post.
export function snowflakeTimestamp(
  postId: string,
  now: Date = new Date(),
): Result<Date, SnowflakeError> {
  if (!DIGITS.test(postId)) return fail("invalid_post_id", `Non-numeric post ID: ${postId}`);
  const id = BigInt(postId);
  if (id > MAX_UINT64) return fail("invalid_post_id", `Post ID out of range: ${postId}`);
  if (id < MIN_SNOWFLAKE_ID) {
    return fail("pre_snowflake", `Post ID ${postId} predates snowflake IDs; its timestamp must come from another source.`);
  }
  const ms = Number((id >> 22n) + SNOWFLAKE_EPOCH_MS);
  if (ms > now.getTime()) {
    return fail("future_timestamp", `Post ID ${postId} decodes to ${new Date(ms).toISOString()}, which is in the future.`);
  }
  return { ok: true, value: new Date(ms) };
}

export type PairError = PostUrlError | "same_post";

export type PairResult =
  | { ok: true; value: [ParsedPostUrl, ParsedPostUrl] }
  | { ok: false; error: PairError; message: string; side: "a" | "b" | "both" };

/// Parse the two comparison inputs. Each side is parsed independently; the
/// only cross-field rule is that they must be different posts.
export function parsePostUrlPair(a: string, b: string): PairResult {
  const pa = parsePostUrl(a);
  if (!pa.ok) return { ...pa, side: "a" };
  const pb = parsePostUrl(b);
  if (!pb.ok) return { ...pb, side: "b" };
  if (pa.value.postId === pb.value.postId) {
    return {
      ok: false,
      error: "same_post",
      message: "Both fields point to the same post. Choose two different posts.",
      side: "both",
    };
  }
  return { ok: true, value: [pa.value, pb.value] };
}
