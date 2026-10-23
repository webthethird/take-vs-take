import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  ANALYZE_MEDIA_PROMPT_VERSION,
  ANALYZE_MEDIA_SYSTEM,
  ANALYZE_SYSTEM,
  DRAFT_NAMED_PROMPT_VERSION,
  DRAFT_NAMED_SYSTEM,
  DRAFT_SYSTEM,
  MAX_REPAIRS,
  analysisProblems,
  analyzeThesis,
  draftPortfolio,
  priceTickerCheck,
  VOICE_SYSTEM,
  classifyVoice,
  renderPost,
  voiceProblems,
  type TickerCheck,
} from "../src/lib/interpret.js";
import type { LlmConfig } from "../src/lib/llm.js";
import { LookAheadGate, fixtureSource, type PriceBar, type PriceSource } from "../src/lib/prices.js";
import { err } from "../src/lib/result.js";
import { ThesisInput, type PortfolioDraft, type ThesisAnalysis } from "../src/lib/schema.js";
import { scripted } from "./llm.test.js";

const input = ThesisInput.parse({
  text: "Rail freight is the cheapest way to play the reshoring boom. Buy the railroads.",
  created_at: "2026-07-10T14:00:00Z",
  synthetic: true,
});

const goodAnalysis: ThesisAnalysis = {
  evidence: ["Rail freight is the cheapest way to play the reshoring boom", "Buy the railroads."],
  economic_claim: "Reshoring will raise US freight volumes, and railroads are an undervalued way to own that.",
  direction: "bullish",
  subjects: ["US railroads", "reshoring"],
  targets: [],
  horizon: null,
  missing: ["which railroads", "time horizon"],
  interpretations: [{ id: "i1", label: "US Class I railroads", expression: "Own the major US railroads.", author_stated: true, gap_note: "Picks specific railroads." }],
  default_interpretation: "i1",
  status: "investable",
  status_reason: "A clear bullish claim on an investable sector.",
};

const draft = (positions: [string, "core" | "supporting" | "satellite"][], extra: Partial<PortfolioDraft> = {}): PortfolioDraft => ({
  interpretation_id: "whatever-the-model-said",
  title: "Reshoring Rails",
  long_only_note: "",
  exclusions: [],
  concentration: "concentrated",
  cash_level: "standard",
  cash_reason: "buffer",
  buckets: [{ name: "Rail", rationale: "" }],
  positions: positions.map(([ticker, tier]) => ({ ticker, tier, role: "railroad", bucket: "Rail", rationale: "" })),
  ...extra,
});

const dirs: string[] = [];
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
async function cfgWith(responses: unknown[]) {
  const t = scripted(responses.map((parsed) => ({ parsed })));
  const d = await mkdtemp(join(tmpdir(), "tvt-int-"));
  dirs.push(d);
  const cfg: LlmConfig = { transport: t, budgetUsd: 5, cacheDir: join(d, "c"), ledgerPath: join(d, "l.jsonl") };
  return { cfg, t };
}

const allValid: TickerCheck = async (ts) => ts.map((ticker) => ({ ticker, problem: null }));

describe("analysisProblems", () => {
  it("accepts verbatim evidence, tolerating quote and whitespace variants", () => {
    const curly = ThesisInput.parse({ ...input, text: "It’s   the “cheapest” way." });
    assert.deepEqual(analysisProblems({ ...goodAnalysis, evidence: ["It's the \"cheapest\" way."] }, curly), []);
  });

  it("flags paraphrased evidence", () => {
    const p = analysisProblems({ ...goodAnalysis, evidence: ["Railroads are the cheapest reshoring play"] }, input);
    assert.match(p.join(), /not a verbatim quote/);
  });

  it("enforces interpretation rules for investable posts", () => {
    assert.match(analysisProblems({ ...goodAnalysis, interpretations: [] }, input).join(), /1 to 3/);
    assert.match(analysisProblems({ ...goodAnalysis, default_interpretation: "i9" }, input).join(), /default_interpretation/);
    const dup = { ...goodAnalysis, interpretations: [goodAnalysis.interpretations[0]!, goodAnalysis.interpretations[0]!] };
    assert.match(analysisProblems(dup, input).join(), /unique/);
  });

  it("an abstaining post may not carry interpretations", () => {
    const p = analysisProblems({ ...goodAnalysis, status: "not_investable", evidence: [] }, input);
    assert.match(p.join(), /must have no interpretations/);
    assert.match(p.join(), /null default_interpretation/);
  });
});

describe("analyzeThesis", () => {
  it("passes the post date and text, and nothing about the author", async () => {
    const { cfg, t } = await cfgWith([goodAnalysis]);
    const r = await analyzeThesis(cfg, input);
    assert.ok(r.ok, !r.ok ? r.message : "");
    const sent = JSON.stringify(t.requests[0]!.messages);
    assert.match(sent, /2026-07-10/);
    assert.match(sent, /Buy the railroads/);
    // ThesisInput has no author field, so there is nothing to leak; guard the
    // prompt text too.
    assert.doesNotMatch(t.requests[0]!.system + sent, /author_handle|@[A-Za-z0-9_]+/);
  });

  it("repairs a rejected answer in an append-only follow-up", async () => {
    const bad = { ...goodAnalysis, evidence: ["a paraphrase that isn't in the post"] };
    const { cfg, t } = await cfgWith([bad, goodAnalysis]);
    const r = await analyzeThesis(cfg, input);
    assert.ok(r.ok, !r.ok ? r.message : "");
    assert.equal(r.attempts.length, 2);
    assert.equal(r.attempts[0]!.problems.length, 1);
    const second = t.requests[1]!.messages;
    assert.equal(second.length, 3);
    assert.equal(second[1]!.role, "assistant");
    assert.match(JSON.stringify(second[2]), /not a verbatim quote/);
    // The first turn is unchanged in the follow-up.
    assert.deepEqual(second[0], t.requests[0]!.messages[0]);
  });

  it(`fails visibly after ${MAX_REPAIRS} repairs`, async () => {
    const bad = { ...goodAnalysis, evidence: ["never in the post"] };
    const { cfg, t } = await cfgWith([bad, bad, bad, bad]);
    const r = await analyzeThesis(cfg, input);
    assert.ok(!r.ok && r.error === "invalid_after_repair");
    assert.equal(t.requests.length, MAX_REPAIRS + 1);
    assert.equal(r.attempts.length, MAX_REPAIRS + 1);
  });

  it("returns an abstention as a result, not an error", async () => {
    const abstain: ThesisAnalysis = { ...goodAnalysis, evidence: [], interpretations: [], default_interpretation: null, status: "not_investable", status_reason: "A joke." };
    const { cfg } = await cfgWith([abstain]);
    const r = await analyzeThesis(cfg, input);
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.value.analysis.status, "not_investable");
  });
});

describe("draftPortfolio", () => {
  it("weights an accepted draft and sets the interpretation id itself", async () => {
    // 90% over 3+3+2+2+1+1 = 12 points: core 22.5, supporting 15, satellite 7.5.
    const d = draft([["UNP", "core"], ["CSX", "core"], ["NSC", "supporting"], ["CP", "supporting"], ["CNI", "satellite"], ["WAB", "satellite"]]);
    const { cfg, t } = await cfgWith([d]);
    const r = await draftPortfolio(cfg, input, goodAnalysis, "i1", allValid);
    assert.ok(r.ok, !r.ok ? r.message : "");
    if (!r.ok) return;
    assert.equal(t.requests.length, 1);
    assert.equal(r.value.draft.interpretation_id, "i1");
    assert.equal(r.value.portfolio.interpretation_id, "i1");
    assert.equal(r.value.portfolio.tier_weights.core, 22.5);
    assert.equal(r.value.portfolio.tier_weights.supporting, 15);
    assert.equal(r.value.portfolio.tier_weights.satellite, 7.5);
  });

  it("sends a cap breach back for repair with the code's message", async () => {
    const tooConcentrated = draft([["UNP", "core"], ["CSX", "satellite"], ["NSC", "satellite"], ["CP", "satellite"]]); // core 90×3/6 = 45%
    const fixed = draft([["UNP", "core"], ["CSX", "core"], ["NSC", "core"], ["CP", "core"]]); // 22.5% each
    const { cfg, t } = await cfgWith([tooConcentrated, fixed]);
    const r = await draftPortfolio(cfg, input, goodAnalysis, "i1", allValid);
    assert.ok(r.ok, !r.ok ? r.message : "");
    assert.match(JSON.stringify(t.requests[1]!.messages.at(-1)), /over the 25% cap/);
  });

  it("sends an unknown ticker back for replacement", async () => {
    const check: TickerCheck = async (ts) => ts.map((ticker) => ({ ticker, problem: ticker === "FAKE" ? "no price data" : null }));
    const withFake = draft([["UNP", "core"], ["CSX", "core"], ["NSC", "core"], ["FAKE", "core"]]);
    const fixed = draft([["UNP", "core"], ["CSX", "core"], ["NSC", "core"], ["CP", "core"]]);
    const { cfg, t } = await cfgWith([withFake, fixed]);
    const r = await draftPortfolio(cfg, input, goodAnalysis, "i1", check);
    assert.ok(r.ok);
    assert.match(JSON.stringify(t.requests[1]!.messages.at(-1)), /FAKE: no price data/);
  });

  it("an unavailable check (quota, network) ends the draft without a repair turn", async () => {
    const check: TickerCheck = async (ts) => ts.map((ticker) => ({ ticker, problem: null, unavailable: ticker === "CSX" ? "rate_limited: quota" : undefined }));
    const { cfg, t } = await cfgWith([draft([["UNP", "core"], ["CSX", "core"], ["NSC", "core"], ["CP", "core"]])]);
    const r = await draftPortfolio(cfg, input, goodAnalysis, "i1", check);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error, "ticker_check_unavailable");
      assert.match(r.message, /CSX.*rate_limited/);
    }
    assert.equal(t.requests.length, 1); // the model was never told to replace CSX
    assert.equal(r.attempts.length, 1); // its cost is still reported
  });

  it("drafts author-named readings with their own prompt, which offers the named style", async () => {
    const two = draft([["UNP", "core"], ["CSX", "satellite"]], { concentration: "named" });
    const { cfg, t } = await cfgWith([two]);
    const named: ThesisAnalysis = { ...goodAnalysis, targets: [{ ticker: "UNP", stance: "positive" }] };
    const r = await draftPortfolio(cfg, input, named, "i1", allValid);
    assert.ok(r.ok, !r.ok ? r.message : "");
    if (!r.ok) return;
    assert.equal(t.requests[0]!.system, DRAFT_NAMED_SYSTEM);
    assert.equal(r.value.attempts[0]!.prompt_version, DRAFT_NAMED_PROMPT_VERSION);
    assert.deepEqual(r.value.portfolio.positions.map((p) => p.weight), [67.5, 22.5]);
  });

  it("treats author_stated without a positive target as inferred", async () => {
    // goodAnalysis: author_stated true, but the post names no ticker.
    const { cfg, t } = await cfgWith([draft([["UNP", "core"], ["CSX", "core"], ["NSC", "core"], ["CP", "core"]])]);
    assert.ok((await draftPortfolio(cfg, input, goodAnalysis, "i1", allValid)).ok);
    assert.equal(t.requests[0]!.system, DRAFT_SYSTEM);
  });

  it("keeps inferred readings on the original prompt and refuses them the named style", async () => {
    const inferred: ThesisAnalysis = { ...goodAnalysis, interpretations: [{ ...goodAnalysis.interpretations[0]!, author_stated: false }] };
    const two = draft([["UNP", "core"], ["CSX", "satellite"]], { concentration: "named" });
    const fixed = draft([["UNP", "core"], ["CSX", "core"], ["NSC", "core"], ["CP", "core"]]);
    const { cfg, t } = await cfgWith([two, fixed]);
    const r = await draftPortfolio(cfg, input, inferred, "i1", allValid);
    assert.ok(r.ok, !r.ok ? r.message : "");
    assert.equal(t.requests[0]!.system, DRAFT_SYSTEM);
    assert.doesNotMatch(DRAFT_SYSTEM, /named:/);
    assert.match(JSON.stringify(t.requests[1]!.messages.at(-1)), /only for readings built from what the author named/);
  });

  it("won't draft for an abstaining analysis or an unknown interpretation", async () => {
    const { cfg, t } = await cfgWith([]);
    const abstain = { ...goodAnalysis, status: "not_investable" as const };
    assert.ok(!(await draftPortfolio(cfg, input, abstain, "i1", allValid)).ok);
    assert.ok(!(await draftPortfolio(cfg, input, goodAnalysis, "i9", allValid)).ok);
    assert.equal(t.requests.length, 0);
  });

  it("the prompt states the same constraints the code enforces", () => {
    assert.match(DRAFT_SYSTEM, /concentrated: 3–8 positions, at most 25%/);
    assert.match(DRAFT_SYSTEM, /balanced: 8–15 positions, at most 15%/);
    assert.match(DRAFT_SYSTEM, /majority: 45% cash/);
    assert.match(DRAFT_SYSTEM, /core = 3, supporting = 2, satellite = 1/);
  });
});

describe("priceTickerCheck", () => {
  const days = (from: string, n: number) => {
    const out: string[] = [];
    for (let d = new Date(`${from}T12:00:00Z`); out.length < n; d.setUTCDate(d.getUTCDate() + 1)) {
      if (d.getUTCDay() % 6 !== 0) out.push(d.toISOString().slice(0, 10));
    }
    return out;
  };
  const bars = (ds: string[]): PriceBar[] => ds.map((date) => ({ date, close: 10, adjClose: 10, divCash: 0, splitFactor: 1 }));
  const live = bars(days("2026-01-02", 130)); // through early July
  const stale = bars(days("2026-01-02", 60)); // stops in March
  const post = new Date("2026-07-10T14:00:00Z");

  it("accepts trading tickers, rejects unknown and stale ones", async () => {
    const check = priceTickerCheck(fixtureSource({ UNP: live, OLD: stale }), post);
    const r = await check(["UNP", "OLD", "NOPE", "unp"]);
    assert.deepEqual(
      r.map((x) => [x.ticker, x.problem === null]),
      [["UNP", true], ["OLD", false], ["NOPE", false]],
    );
  });

  it("reports quota and network failures as unavailable, not as bad tickers, and stops", async () => {
    const calls: string[] = [];
    const flaky: PriceSource = {
      name: "flaky",
      async daily(ticker) {
        calls.push(ticker);
        return ticker === "UNP" ? fixtureSource({ UNP: live }).daily("UNP", "2025-06-05", "2026-07-09") : err("rate_limited", "quota");
      },
    };
    const r = await priceTickerCheck(flaky, post)(["UNP", "CSX", "NSC"]);
    assert.deepEqual(r, [
      { ticker: "UNP", problem: null },
      { ticker: "CSX", problem: null, unavailable: "rate_limited: quota" },
    ]);
    assert.deepEqual(calls, ["UNP", "CSX"]);
  });

  it("a malformed ticker is the model's to fix, not an outage", async () => {
    const strict: PriceSource = { name: "strict", daily: async () => err("invalid_request", "bad ticker") };
    const r = await priceTickerCheck(strict, post)(["BRK B"]);
    assert.equal(r[0]!.unavailable, undefined);
    assert.match(r[0]!.problem!, /not a valid ticker/);
  });

  it("works through the LookAheadGate before anything is frozen", async () => {
    const gate = new LookAheadGate(fixtureSource({ UNP: live }), post);
    const r = await priceTickerCheck(gate, post)(["UNP"]);
    assert.equal(r[0]!.problem, null);
  });
});

describe("analysisProblems: targets", () => {
  it("rejects malformed and duplicate targets", () => {
    const p = analysisProblems({ ...goodAnalysis, targets: [{ ticker: "Microsoft Corp", stance: "negative" }, { ticker: "unp", stance: "positive" }, { ticker: "UNP", stance: "positive" }] }, input);
    assert.match(p.join(), /"Microsoft Corp" is not a ticker/);
    assert.match(p.join(), /UNP is listed twice/);
  });
});

describe("posts with images and links", () => {
  const withMedia = ThesisInput.parse({
    ...input,
    context: [{ kind: "quoted", text: "Freight volumes hit a record." }],
    media: [
      { from: "post", kind: "photo", url: "https://pbs.twimg.com/media/a.jpg", alt_text: "Chart of rail carloads" },
      { from: "quoted", kind: "video_preview", url: "https://pbs.twimg.com/thumb/b.jpg", alt_text: null },
    ],
    links: [{ from: "post", url: "https://example.com/rail", title: "Rail report", description: null }],
    unavailable_context: ["parent"],
  });

  it("renders a text-only post to exactly the string it always has, so cached results stay valid", () => {
    assert.equal(renderPost(input), `<post_date>2026-07-10 (14:00 UTC)</post_date>\n\n<post>\n${input.text}\n</post>`);
  });

  it("text-only posts keep the original prompt; posts with media get their own version", async () => {
    const plain = await cfgWith([goodAnalysis]);
    await analyzeThesis(plain.cfg, input);
    assert.equal(plain.t.requests[0]!.system, ANALYZE_SYSTEM);
    assert.equal(typeof plain.t.requests[0]!.messages[0]!.content, "string");

    const media = await cfgWith([goodAnalysis]);
    const r = await analyzeThesis(media.cfg, withMedia);
    assert.ok(r.ok, !r.ok ? r.message : "");
    assert.equal(media.t.requests[0]!.system, ANALYZE_MEDIA_SYSTEM);
    assert.equal(r.attempts[0]!.prompt_version, ANALYZE_MEDIA_PROMPT_VERSION);
    assert.notEqual(ANALYZE_MEDIA_SYSTEM, ANALYZE_SYSTEM);
    assert.match(ANALYZE_MEDIA_SYSTEM, /one preview frame/);
    assert.doesNotMatch(ANALYZE_MEDIA_SYSTEM, /told that it exists/);
  });

  it("sends the text first, then each image after a label saying whose it is", () => {
    const blocks = renderPost(withMedia);
    assert.ok(Array.isArray(blocks));
    const [text, ...rest] = blocks;
    assert.equal(text!.type, "text");
    const t = (text as { text: string }).text;
    assert.match(t, /<quoted_post>\nFreight volumes hit a record.\n<\/quoted_post>/);
    assert.match(t, /<parent_post_unavailable>/);
    assert.match(t, /<links_not_opened>\n- in the post: https:\/\/example.com\/rail \| title: Rail report\n/);
    assert.deepEqual(
      rest.map((b) => (b.type === "image" ? (b.source as { url: string }).url : (b as { text: string }).text)),
      [
        '<image n="1">An image attached to the post. Alt text: Chart of rail carloads</image>',
        "https://pbs.twimg.com/media/a.jpg",
        '<image n="2">A preview frame of a video (not watched) attached to the quoted post.</image>',
        "https://pbs.twimg.com/thumb/b.jpg",
      ],
    );
  });

  it("the draft sees the same images, with its instructions in the text before them", async () => {
    const { cfg, t } = await cfgWith([draft([["UNP", "core"], ["CSX", "core"], ["NSC", "core"], ["CP", "core"]])]);
    const r = await draftPortfolio(cfg, withMedia, goodAnalysis, "i1", allValid);
    assert.ok(r.ok, !r.ok ? r.message : "");
    const content = t.requests[0]!.messages[0]!.content;
    assert.ok(Array.isArray(content));
    assert.match((content[0] as { text: string }).text, /<interpretation_to_build>/);
    assert.equal(content.filter((b) => b.type === "image").length, 2);
  });
});

describe("classifyVoice", () => {
  const v = (voice: string, commentary: string | null) => ({ voice, commentary, reason: "" }) as Parameters<typeof voiceProblems>[0];

  it("requires commentary, quoted verbatim, exactly when the post adds a view to news", () => {
    assert.deepEqual(voiceProblems(v("own_view", null), input), []);
    assert.deepEqual(voiceProblems(v("news_only", null), input), []);
    assert.deepEqual(voiceProblems(v("news_with_commentary", "Buy the railroads."), input), []);
    assert.equal(voiceProblems(v("news_with_commentary", null), input).length, 1);
    assert.match(voiceProblems(v("news_with_commentary", "Sell the railroads."), input)[0]!, /not a verbatim passage/);
    assert.equal(voiceProblems(v("news_only", "Buy the railroads."), input).length, 1);
  });

  it("sends the text only, never the images", async () => {
    const { cfg, t } = await cfgWith([{ voice: "own_view", commentary: null, reason: "States a view." }]);
    const withImage = ThesisInput.parse({ ...input, media: [{ from: "post", kind: "photo", url: "https://pbs.twimg.com/media/a.jpg", alt_text: null }] });
    const r = await classifyVoice(cfg, withImage);
    assert.ok(r.ok, !r.ok ? r.message : "");
    assert.equal(t.requests[0]!.system, VOICE_SYSTEM);
    assert.equal(typeof t.requests[0]!.messages[0]!.content, "string");
  });
});
