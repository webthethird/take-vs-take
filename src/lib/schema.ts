import { z } from "zod";

// Data contracts. See docs/PLAN.md §3. Only the ingestion-side schemas exist so
// far; analysis, portfolio and run-record schemas land with their stages.

export const PostSource = z.enum([
  "fixture_manual", // text pasted by a person; not fetched from X
  "oembed", // publish.twitter.com/oembed — truncates long posts
  "x_api", // official X API post lookup
]);
export type PostSource = z.infer<typeof PostSource>;

export const PostContext = z.object({
  kind: z.enum(["parent", "quoted"]),
  post_id: z.string().regex(/^[0-9]+$/),
  text: z.string(),
});
export type PostContext = z.infer<typeof PostContext>;

export const PostInput = z.object({
  post_id: z.string().regex(/^[0-9]+$/),
  url: z.url(),
  author_handle: z.string().regex(/^[A-Za-z0-9_]{1,15}$/),
  author_name: z.string().optional(),
  text: z.string().min(1),
  /// Always derived from the snowflake ID, never from user input.
  created_at: z.iso.datetime(),
  context: z.array(PostContext).default([]),
  provenance: z.object({
    source: PostSource,
    /// True only when the full text came from an authoritative fetch. A
    /// manual paste or a truncated oEmbed body is false.
    text_verified: z.boolean(),
    retrieved_at: z.iso.datetime(),
    note: z.string().optional(),
    raw: z.unknown().optional(),
  }),
});
export type PostInput = z.infer<typeof PostInput>;

/// What a person writes by hand to create an offline fixture. Deliberately
/// smaller than PostInput: the ID and timestamp are derived from the URL, so a
/// fixture cannot carry a timestamp that disagrees with its own post.
export const ManualFixture = z.object({
  url: z.string(),
  author_handle: z.string(),
  author_name: z.string().optional(),
  text: z.string().min(1),
  /// Optional cross-check only. If present it must agree with the snowflake
  /// timestamp; a mismatch means the text was copied from a different post.
  created_at: z.iso.datetime({ offset: true }).optional(),
  context: z.array(PostContext).default([]),
  retrieved_at: z.iso.datetime({ offset: true }),
  note: z.string().optional(),
});
export type ManualFixture = z.infer<typeof ManualFixture>;
