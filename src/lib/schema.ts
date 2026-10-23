import { z } from "zod";

// Data contracts. See docs/PLAN.md §3. Analysis and run-record schemas land
// with their stages.

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

/// An image the model is shown. A video or GIF is represented by its
/// preview frame only, and labeled so.
export const PostMedia = z.object({
  from: z.enum(["post", "parent", "quoted"]),
  kind: z.enum(["photo", "video_preview", "gif_preview"]),
  url: z.url(),
  alt_text: z.string().nullable(),
});
export type PostMedia = z.infer<typeof PostMedia>;

/// A link in a post, with X's preview metadata when it has any. The linked
/// page itself is never fetched (it may have changed since the post).
export const PostLink = z.object({
  from: z.enum(["post", "parent", "quoted"]),
  url: z.string(),
  title: z.string().nullable(),
  description: z.string().nullable(),
});
export type PostLink = z.infer<typeof PostLink>;

export const PostInput = z.object({
  post_id: z.string().regex(/^[0-9]+$/),
  url: z.url(),
  author_handle: z.string().regex(/^[A-Za-z0-9_]{1,15}$/),
  author_name: z.string().optional(),
  text: z.string().min(1),
  /// Always derived from the snowflake ID, never from user input.
  created_at: z.iso.datetime(),
  context: z.array(PostContext).default([]),
  /// Media or links in the post that the model is NOT shown (fixtures).
  attachments: z.array(z.enum(["image", "video", "link"])).default([]),
  /// Shown to the model (posts fetched from X).
  media: z.array(PostMedia).default([]),
  links: z.array(PostLink).default([]),
  /// A post this one quotes or replies to that couldn't be retrieved
  /// (deleted, private or withheld).
  unavailable_context: z.array(z.enum(["parent", "quoted"])).default([]),
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
  attachments: z.array(z.enum(["image", "video", "link"])).default([]),
  retrieved_at: z.iso.datetime({ offset: true }),
  note: z.string().optional(),
});
export type ManualFixture = z.infer<typeof ManualFixture>;

// ── Portfolio draft (LLM output) ─────────────────────────────────────────
//
// The model chooses discrete labels only — style, cash level, a tier per
// position. It never emits a weight; src/lib/weights.ts computes those.

/// "named" is only for readings built from what the author named (see
/// weights.ts NAMED); code rejects it for any other reading.
export const Concentration = z.enum(["concentrated", "balanced", "diversified", "named"]);
export type Concentration = z.infer<typeof Concentration>;

export const CashLevel = z.enum(["buffer", "standard", "defensive", "majority"]);
export type CashLevel = z.infer<typeof CashLevel>;

export const Tier = z.enum(["core", "supporting", "satellite"]);
export type Tier = z.infer<typeof Tier>;

export const DraftPosition = z.object({
  ticker: z.string().min(1),
  role: z.string().describe("2–4 words, e.g. 'Waymo owner'."),
  bucket: z.string(),
  rationale: z.string(),
  tier: Tier,
});
export type DraftPosition = z.infer<typeof DraftPosition>;

export const PortfolioDraft = z.object({
  interpretation_id: z.string(),
  title: z.string(),
  long_only_note: z.string(),
  exclusions: z.array(z.string()),
  concentration: Concentration,
  cash_level: CashLevel,
  cash_reason: z.string(),
  buckets: z.array(z.object({ name: z.string(), rationale: z.string() })),
  positions: z.array(DraftPosition),
});
export type PortfolioDraft = z.infer<typeof PortfolioDraft>;

// ── Thesis interpretation (LLM input/output) ─────────────────────────────

/// Everything the interpretation model sees about one post. Deliberately has
/// no author field: withholding identity is enforced by the type, not by
/// remembering to leave it out of a prompt (an author's name invites recall of
/// their later positions).
export const ThesisInput = z.object({
  text: z.string().min(1),
  created_at: z.iso.datetime(),
  context: z.array(z.object({ kind: z.enum(["parent", "quoted"]), text: z.string() })).default([]),
  /// Media or links the post includes but the model can't see.
  attachments: z.array(z.enum(["image", "video", "link"])).default([]),
  /// Images and links the model is shown, and context it was denied.
  media: z.array(PostMedia).default([]),
  links: z.array(PostLink).default([]),
  unavailable_context: z.array(z.enum(["parent", "quoted"])).default([]),
  /// True for hand-written development posts, never shown as real.
  synthetic: z.boolean().default(false),
});
export type ThesisInput = z.infer<typeof ThesisInput>;

export const ThesisStatus = z.enum(["investable", "not_investable", "insufficient_context"]);
export type ThesisStatus = z.infer<typeof ThesisStatus>;

// Field order is load-bearing: structured output is generated in schema
// order, so evidence and reasoning come before the status verdict.
export const ThesisAnalysis = z.object({
  evidence: z
    .array(z.string())
    .describe("Verbatim quotes from the post that carry its claim. Copy exactly; never paraphrase. Empty if there is no claim."),
  economic_claim: z.string().describe("What the post claims, in plain words, without adding anything the post doesn't say."),
  direction: z.enum(["bullish", "bearish", "mixed", "descriptive", "unclear"]),
  subjects: z.array(z.string()).describe("Companies, sectors, asset classes or macro factors the claim is about."),
  targets: z
    .array(
      z.object({
        ticker: z.string().describe("US ticker as listed, share classes with a dash (BRK-B)."),
        stance: z.enum(["positive", "negative"]),
      }),
    )
    .describe(
      "US-listed companies or funds the post itself is positive or negative about, named or unmistakably referred to (\"Microsoft\" -> MSFT). Only the post's own stance, never your inferences. Empty if none.",
    ),
  horizon: z.string().nullable().describe("Time horizon only if the post states or clearly implies one; otherwise null."),
  missing: z.array(z.string()).describe("What the post leaves unspecified that an investor would need to know."),
  interpretations: z
    .array(
      z.object({
        id: z.string().describe("Short id: i1, i2, i3."),
        label: z.string().describe("A few words, e.g. 'Cheap stocks AI left behind'."),
        expression: z.string().describe("How this reading becomes long-only positions."),
        author_stated: z.boolean().describe("True only if the post itself names what to own (or clearly implies it). False when the beneficiaries are inferred."),
        gap_note: z.string().describe("What this reading adds beyond what the post says."),
      }),
    )
    .describe("1 to 3 distinct readings if investable; empty otherwise."),
  default_interpretation: z
    .string()
    .nullable()
    .describe("Id of the reading to build by default: the broadest one that covers the post's main claim. Null if not investable."),
  status: ThesisStatus,
  status_reason: z.string().describe("One or two sentences explaining the status."),
});
export type ThesisAnalysis = z.infer<typeof ThesisAnalysis>;

// ── Voice (LLM, per post, before drafting) ───────────────────────────────

/// Whose view a post states. News relays are common (and a product direction
/// elsewhere), so they aren't abstained on; they're labeled, so a reader
/// never mistakes the AI's reading of a headline for the poster's opinion.
export const PostVoice = z.object({
  voice: z
    .enum(["own_view", "news_with_commentary", "news_only"])
    .describe(
      "own_view: the poster argues or states their own view. news_with_commentary: the post reports news and adds the poster's own reading of it. news_only: the post reports news, prices or someone else's statement and adds no view of its own.",
    ),
  commentary: z
    .string()
    .nullable()
    .describe("For news_with_commentary only: the poster's own reading, quoted verbatim from the post as one continuous passage. Null otherwise."),
  reason: z.string().describe("One sentence on why."),
});
export type PostVoice = z.infer<typeof PostVoice>;

// ── Thesis alignment (LLM, after both portfolios are frozen) ─────────────
//
// About the opinions, not the portfolios. Must not cite correlation or
// returns; see docs/PLAN.md §5.1. Used at step 8.

export const ThesisAlignment = z.object({
  a_claim: z.string(),
  b_claim: z.string(),
  shared_subjects: z.array(z.string()),
  reasoning: z.string().describe("How the two claims bear on each other, grounded in what each post says."),
  relationship: z.enum(["opposing", "partly_conflicting", "compatible", "similar", "unrelated", "unknown"]),
  confidence: z.enum(["low", "medium", "high"]),
});
export type ThesisAlignment = z.infer<typeof ThesisAlignment>;

/// The model's reading of what two frozen portfolios are economically exposed
/// to, made before any prices are loaded. A prediction to set beside the
/// measured co-movement, not an explanation fitted to it.
export const SharedDrivers = z.object({
  shared: z
    .array(
      z.object({
        driver: z.string().describe("An economic factor both portfolios depend on, e.g. 'AI data-center chip demand'."),
        a: z.string().describe("Which of A's holdings carry it, and how."),
        b: z.string().describe("Which of B's holdings carry it, and how."),
      }),
    )
    .describe("Empty if they share no meaningful driver."),
  differences: z
    .array(
      z.object({
        driver: z.string().describe("An economic factor only one portfolio depends on, or that they're exposed to in opposite ways."),
        a: z.string().describe("A's exposure to it, or 'none'."),
        b: z.string().describe("B's exposure to it, or 'none'."),
      }),
    )
    .describe("The differences that matter most, not every one."),
  expected_daily_co_movement: z
    .enum(["together", "apart", "no_clear_relationship"])
    .describe("How you expect the two portfolios' daily returns to relate in ordinary market conditions."),
  summary: z.string().describe("One or two plain sentences: what the portfolios have in common economically, and where they really differ."),
  confidence: z.enum(["low", "medium", "high"]),
});
export type SharedDrivers = z.infer<typeof SharedDrivers>;

/// How each holding relates to what its post actually said, read after
/// freezing and before prices, one side at a time.
export const FidelityLink = z.enum(["named", "direct", "proxy", "added"]);
export type FidelityLink = z.infer<typeof FidelityLink>;

export const Fidelity = z.object({
  holdings: z.array(
    z.object({
      ticker: z.string(),
      link: FidelityLink.describe(
        "named: the post names this company or security. direct: not named, but owning it expresses the claim itself with little else attached. proxy: stands in for something the claim is about that can't be owned or wasn't specified, and moves for other reasons too. added: exposure the claim doesn't call for.",
      ),
      stands_for: z.string().describe("For a proxy, what it stands in for, e.g. 'SpaceX (private)'. Empty otherwise."),
      note: z.string().describe("One short sentence on the fit."),
    }),
  ),
  not_investable: z
    .array(z.object({ part: z.string().describe("A part of the post's claim."), why: z.string().describe("Why no listed security expresses it directly.") }))
    .describe("Parts of the claim the portfolio can only approximate or leave out. Empty if none."),
  summary: z.string().describe("One plain sentence on how faithfully the portfolio expresses the post."),
});
export type Fidelity = z.infer<typeof Fidelity>;
