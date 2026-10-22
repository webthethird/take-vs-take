// Post -> thesis analysis -> portfolio draft -> weighted portfolio.
//
// Two model calls per post, each schema-validated and then checked by code:
//   analyze: is there an investable claim, and what are its readings?
//   draft:   one reading -> labeled portfolio (style, cash level, tiers).
// Code then computes weights (weights.ts) and checks every ticker against
// price data from before the post. Anything code rejects goes back to the
// model as a follow-up turn, at most MAX_REPAIRS times, then fails visibly.
//
// Independence: each call sees one post only, and ThesisInput has no author
// field. Nothing here can see the other side of a comparison.

import type Anthropic from "@anthropic-ai/sdk";
import { etDate, type PriceSource } from "./prices.js";
import { err, type Result } from "./result.js";
import {
  PortfolioDraft,
  ThesisAnalysis,
  type ThesisInput,
} from "./schema.js";
import { tickerKey } from "./ticker.js";
import { authorNamed } from "./readings.js";
import { CASH, NAMED, STYLE, TIER_POINTS, weightPortfolio, type Portfolio } from "./weights.js";
import { structuredCall, type CallResult, type LlmConfig, type LlmError } from "./llm.js";
import type { z } from "zod";

export const ANALYZE_PROMPT_VERSION = "analyze-v2";
export const DRAFT_PROMPT_VERSION = "draft-v1";
/// Author-named readings: the same prompt plus the "named" style. A separate
/// version, so inferred readings keep their exact prompt and cached drafts.
export const DRAFT_NAMED_PROMPT_VERSION = "draft-named-v2";
export const MAX_REPAIRS = 2;

// ── Prompts ──────────────────────────────────────────────────────────────

export const ANALYZE_SYSTEM = `You read one social-media post and decide whether it contains an investable thesis, then describe the ways it could be expressed as a long-only portfolio of US-listed stocks and ETFs.

This is research into how public opinions translate into hypothetical portfolios. Nothing is traded; your output is shown to readers as an AI interpretation, clearly separated from what the post's author actually said. Faithfulness to the post matters more than anything else.

You see only the post's text, its date, and sometimes the post it replies to or quotes. You are deliberately not told who wrote it. If the post includes an image, video or link, you are told that it exists but not what it shows; interpret the text alone and say so in "missing" when the attachment probably matters.

Interpret the post as of its date. Don't bring in what happened afterwards, and don't favor readings because of how the assets involved later performed.

## Status

- investable: the post makes a claim about companies, sectors, asset classes or economic conditions that some set of US-listed stocks or ETFs could reasonably express.
- not_investable: no economic claim — jokes, greetings, moral or political views without an economic consequence the post asserts, personal anecdotes, pure vibes, questions that take no position. Do not stretch a non-economic opinion into an investment view.
- insufficient_context: the post seems to make a claim, but its meaning depends on content you can't see (a bare "this" about an image, a reply whose parent you weren't given).

When the status is not investable, return empty interpretations and a null default_interpretation.

## Evidence

Quote the words that carry the claim exactly as written, as complete phrases. Never paraphrase inside "evidence", never join separate passages, and never use ellipses. Code checks every quote against the post.

## Targets

List the US-listed companies or funds the post itself takes a stance on, with that stance: "Microsoft is wasting money on AI" makes MSFT negative; "Long $NVDA" makes NVDA positive. Include a company the post names or unmistakably refers to, even without a ticker. Don't list companies only you connect to the claim, and don't list private companies. This records what the author said, independent of any portfolio built later.

## Interpretations

Give 1 to 3 genuinely different readings. Portfolios can only buy, so:
- A bullish claim usually maps to owning what it is bullish on.
- A bearish claim cannot short anything. Express it by owning what should hold up or gain if the claim is right: competitors, substitutes, beneficiaries, or defensive assets. Each of those is an inference the author did not make; set author_stated to false and say plainly in gap_note what you added.
- If no long position could faithfully express the claim, say so in the status_reason and use not_investable rather than inventing one.

Choose as default the broadest reading that still covers the post's main claim, unless the post clearly means one specific reading.`;

function draftSystem(): string {
  const styles = Object.entries(STYLE)
    .map(([k, v]) => `- ${k}: ${v.min}–${v.max} positions, at most ${v.cap}% in any one name`)
    .join("\n");
  const cash = Object.entries(CASH)
    .map(([k, v]) => `- ${k}: ${v}% cash`)
    .join("\n");
  const pts = Object.entries(TIER_POINTS)
    .map(([k, v]) => `${k} = ${v}`)
    .join(", ");
  return `You turn one interpretation of a social-media post into a hypothetical long-only portfolio. Nothing is traded. Readers see the portfolio as an AI interpretation of the post, so every holding must follow from the interpretation you are given, and the rationale must say how.

## What you can hold

US-listed common stocks, ADRs and ordinary ETFs that were listed and trading on the post's date. No leveraged or inverse funds, no options, no crypto or crypto-linked products, no bonds except through ordinary ETFs (e.g. short-term Treasury ETFs). Use the ticker as listed on its US exchange; for share classes write the class with a dash (BRK-B).

Choose holdings for how faithfully they express the interpretation, never for how they performed. Don't add a popular name the interpretation doesn't call for.

## What you choose, and how weights follow

You never write weights. You choose:

1. A concentration style:
${styles}

2. A cash level, with a one-sentence reason:
${cash}

3. Named buckets (themes), each with a rationale, and positions in them. Every bucket needs at least one position.

4. A conviction tier for each position (points: ${pts}).

Code then sets weights: the invested share (100% minus cash) is split in proportion to tier points, so every name in a tier gets the same weight. A draft is rejected if any name would exceed its style's cap. Check before answering: weight of a top-tier name = invested% × its points ÷ total points across all positions. If it's over the cap, add positions, choose more cash, or move names down a tier.

## Explaining it

- title: a short name for the portfolio.
- long_only_note: if the post's view is bearish or otherwise can't be bought directly, explain in one or two sentences how this portfolio expresses it with long positions only. Otherwise leave it empty.
- exclusions: things the interpretation deliberately avoids (e.g. "no chipmakers").
- Each position gets a 2–4 word role and a rationale tying it to the interpretation.`;
}

export const DRAFT_SYSTEM = draftSystem();

export const DRAFT_NAMED_SYSTEM = `${DRAFT_SYSTEM}

## This reading uses what the author named

The interpretation you're given is built from securities the post itself names, so one more concentration style is available, and usually fits best:
- named: ${NAMED.min}–${NAMED.max} positions, at most ${NAMED.capShare * 100}% of the invested share in any one name.

Hold the named securities as core. A portfolio needs at least ${NAMED.min} positions, so if the post names only one investable security, add one more position in a lower tier, chosen in this order:
1. A stand-in for something else the post names or claims that can't be bought directly, such as a listed fund holding a private company the post names. Say in its rationale that it is a stand-in.
2. Otherwise, a broad fund for the named security's own sector, so the second position adds as little new exposure as possible.

Never add something the post argues against, dismisses or treats as competition. Don't add a fund whose main exposure is unrelated to the post just because it happens to hold the named stock.`;

function renderPost(input: ThesisInput): string {
  const d = new Date(input.created_at);
  const parts = [`<post_date>${etDate(d)} (${d.toISOString().slice(11, 16)} UTC)</post_date>`];
  for (const c of input.context) parts.push(`<${c.kind}_post>\n${c.text}\n</${c.kind}_post>`);
  parts.push(`<post>\n${input.text}\n</post>`);
  if (input.attachments.length > 0) {
    parts.push(`<attachments_not_shown>${input.attachments.join(", ")}</attachments_not_shown>`);
  }
  return parts.join("\n\n");
}

// ── Repair loop ──────────────────────────────────────────────────────────

export type Attempt = CallResult<unknown>["meta"] & { problems: string[] };

type RepairOutcome<T> = { value: T; attempts: Attempt[] };
type RepairError = LlmError | "invalid_after_repair";

/// Call, validate, and on problems append the model's own turn plus a
/// follow-up listing what code rejected. Conversation is append-only: the
/// assistant content (thinking blocks included) is passed back unchanged.
async function callWithRepair<S extends z.ZodType>(
  cfg: LlmConfig,
  base: { promptVersion: string; system: string; schema: S; nonce?: string },
  firstUser: string,
  validate: (v: z.infer<S>) => Promise<string[]>,
): Promise<Result<RepairOutcome<z.infer<S>>, RepairError> & { attempts: Attempt[] }> {
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: firstUser }];
  const attempts: Attempt[] = [];
  for (let round = 0; ; round++) {
    const r = await structuredCall(cfg, { ...base, messages: [...messages] });
    if (!r.ok) return { ...r, attempts };
    const problems = await validate(r.value.value);
    attempts.push({ ...r.value.meta, problems });
    if (problems.length === 0) return { ok: true, value: { value: r.value.value, attempts }, attempts };
    if (round >= MAX_REPAIRS) {
      return { ok: false, error: "invalid_after_repair", message: `Still invalid after ${MAX_REPAIRS} repairs: ${problems.join(" | ")}`, attempts };
    }
    messages.push({ role: "assistant", content: r.value.content });
    messages.push({
      role: "user",
      content: `Your answer could not be accepted:\n${problems.map((p) => `- ${p}`).join("\n")}\n\nReturn a complete corrected answer. Keep everything that was fine.`,
    });
  }
}

// ── Analyze ──────────────────────────────────────────────────────────────

/// Normalise for verbatim checks: curly quotes, dashes and whitespace vary
/// between copies of the same text; nothing else may.
function norm(s: string): string {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

export function analysisProblems(a: ThesisAnalysis, input: ThesisInput): string[] {
  const problems: string[] = [];
  const source = norm([input.text, ...input.context.map((c) => c.text)].join("\n"));
  for (const q of a.evidence) {
    if (!source.includes(norm(q))) problems.push(`Evidence is not a verbatim quote from the post: "${q}"`);
  }
  const seen = new Set<string>();
  for (const t of a.targets) {
    const k = tickerKey(t.ticker);
    if (!/^[A-Z0-9]+(-[A-Z0-9]+)*$/.test(k)) problems.push(`Target "${t.ticker}" is not a ticker.`);
    if (seen.has(k)) problems.push(`Target ${k} is listed twice.`);
    seen.add(k);
  }
  if (a.status === "investable") {
    if (a.evidence.length === 0) problems.push("An investable status needs at least one evidence quote.");
    if (a.interpretations.length < 1 || a.interpretations.length > 3) {
      problems.push(`An investable post needs 1 to 3 interpretations; got ${a.interpretations.length}.`);
    }
    const ids = a.interpretations.map((i) => i.id);
    if (new Set(ids).size !== ids.length) problems.push("Interpretation ids must be unique.");
    if (a.default_interpretation === null || !ids.includes(a.default_interpretation)) {
      problems.push(`default_interpretation must be one of: ${ids.join(", ")}.`);
    }
  } else {
    if (a.interpretations.length > 0) problems.push(`A ${a.status} post must have no interpretations.`);
    if (a.default_interpretation !== null) problems.push(`A ${a.status} post must have a null default_interpretation.`);
  }
  return problems;
}

export type AnalysisRun = { analysis: ThesisAnalysis; attempts: Attempt[] };

export async function analyzeThesis(
  cfg: LlmConfig,
  input: ThesisInput,
  opts: { nonce?: string } = {},
): Promise<Result<AnalysisRun, RepairError> & { attempts: Attempt[] }> {
  const r = await callWithRepair(
    cfg,
    { promptVersion: ANALYZE_PROMPT_VERSION, system: ANALYZE_SYSTEM, schema: ThesisAnalysis, nonce: opts.nonce },
    renderPost(input),
    async (a) => analysisProblems(a, input),
  );
  if (!r.ok) return r;
  return { ok: true, value: { analysis: r.value.value, attempts: r.value.attempts }, attempts: r.attempts };
}

// ── Draft ────────────────────────────────────────────────────────────────

/// `problem` is the model's to fix (unknown or stale ticker). `unavailable`
/// means we couldn't check (quota, network): that is never the model's
/// fault, so it must not be sent back as "replace this ticker", which would
/// spend money and bias the draft away from valid tickers.
export type TickerCheck = (tickers: string[]) => Promise<{ ticker: string; problem: string | null; unavailable?: string }[]>;

/// A ticker is valid if it has prices in the 10 calendar days before the post
/// (i.e. it was trading then). Reads only pre-post data, so it's safe to run
/// through the LookAheadGate before anything is frozen.
export function priceTickerCheck(source: PriceSource, asOf: Date): TickerCheck {
  const day = etDate(asOf);
  const shift = (d: string, days: number) => new Date(Date.parse(`${d}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
  // A wide window, so the same cached series also serves the year-long
  // ex-ante estimate later without another request.
  const start = shift(day, -400);
  const end = shift(day, -1);
  const recent = shift(day, -10);
  return async (tickers) => {
    const out: Awaited<ReturnType<TickerCheck>> = [];
    // Sequential on purpose: the price provider is rate-limited.
    for (const t of [...new Set(tickers.map(tickerKey))]) {
      const r = await source.daily(t, start, end);
      if (!r.ok && r.error === "not_found") {
        out.push({ ticker: t, problem: "no price data (unknown ticker, or delisted)" });
      } else if (!r.ok && r.error === "invalid_request") {
        out.push({ ticker: t, problem: `not a valid ticker: ${r.message}` });
      } else if (!r.ok) {
        // Stop: further requests would fail the same way and spend quota.
        out.push({ ticker: t, problem: null, unavailable: `${r.error}: ${r.message}` });
        break;
      } else if (!r.value.bars.some((b) => b.date >= recent)) {
        out.push({ ticker: t, problem: `not trading in the 10 days before ${day}` });
      } else {
        out.push({ ticker: t, problem: null });
      }
    }
    return out;
  };
}

export type DraftRun = { draft: PortfolioDraft; portfolio: Portfolio; attempts: Attempt[] };

export async function draftPortfolio(
  cfg: LlmConfig,
  input: ThesisInput,
  analysis: ThesisAnalysis,
  interpretationId: string,
  checkTickers: TickerCheck,
  opts: { nonce?: string } = {},
): Promise<Result<DraftRun, RepairError | "invalid_request" | "ticker_check_unavailable"> & { attempts: Attempt[] }> {
  const interp = analysis.interpretations.find((i) => i.id === interpretationId);
  if (analysis.status !== "investable" || !interp) {
    return { ...err("invalid_request", `No investable interpretation "${interpretationId}" to draft.`), attempts: [] };
  }

  const named = authorNamed(analysis, interp);
  const user = [
    renderPost(input),
    `<analysis>\n${JSON.stringify({ economic_claim: analysis.economic_claim, direction: analysis.direction, subjects: analysis.subjects, horizon: analysis.horizon, missing: analysis.missing }, null, 2)}\n</analysis>`,
    `<interpretation_to_build>\n${JSON.stringify(interp, null, 2)}\n</interpretation_to_build>`,
  ].join("\n\n");

  let weighted: Portfolio | null = null;
  let unavailable: string | null = null;
  const r = await callWithRepair(
    cfg,
    named
      ? { promptVersion: DRAFT_NAMED_PROMPT_VERSION, system: DRAFT_NAMED_SYSTEM, schema: PortfolioDraft, nonce: opts.nonce }
      : { promptVersion: DRAFT_PROMPT_VERSION, system: DRAFT_SYSTEM, schema: PortfolioDraft, nonce: opts.nonce },
    user,
    async (d) => {
      // The id is ours to set, not the model's.
      const draft = { ...d, interpretation_id: interpretationId };
      const problems: string[] = [];
      if (draft.concentration === "named" && !named) {
        problems.push('The "named" style is only for readings built from what the author named. Choose concentrated, balanced or diversified.');
      }
      const w = weightPortfolio(draft);
      if (!w.ok) problems.push(w.message);
      for (const c of await checkTickers(draft.positions.map((p) => p.ticker))) {
        if (c.unavailable) {
          unavailable = `Ticker check for ${c.ticker} failed (${c.unavailable}); rerun later. The model's answer is cached.`;
          weighted = null;
          return []; // end the loop without a repair turn
        }
        if (c.problem) problems.push(`${c.ticker}: ${c.problem}. Replace it.`);
      }
      weighted = w.ok && problems.length === 0 ? w.value : null;
      return problems;
    },
  );
  if (!r.ok) return r;
  if (unavailable) return { ...err("ticker_check_unavailable", unavailable), attempts: r.attempts };
  return {
    ok: true,
    value: { draft: { ...r.value.value, interpretation_id: interpretationId }, portfolio: weighted!, attempts: r.value.attempts },
    attempts: r.attempts,
  };
}
