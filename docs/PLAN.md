# Milestone 0 Plan — Two Takes, Two Portfolios

Status: draft for review · 2026-10-19

Two X posts in → two independently built, hypothetical long-only portfolios →
one fair, common-window historical comparison with an overlap analysis.

This document records the decisions made so far, the data contracts, the
deterministic rules, and the Milestone 1 build order. Anything marked
**open** is not decided.

---

## 1. Decisions

| Area | Decision | Basis |
| --- | --- | --- |
| Repo | Standalone. Patterns copied from `takes-classifier`, no shared package. | Classifier's matching/stance logic doesn't apply; its schema/cache patterns do. |
| Stack | pnpm, TypeScript, zod. Pipeline library + CLI harness first; Next.js app later in this repo. | Matches existing Takes tooling. |
| Instruments | US-listed equities, ETFs and ADRs. Long-only. **No leveraged or inverse funds.** | Supertake's default builder is buy-only; one observed take held SOXS, likely user-steered. |
| Builder target | Calibrated against the output of Supertake's public take-to-portfolio builder (no affiliation): named buckets, ~3–21 positions, integer-looking weights, some cash. | 7 portfolios observed in its Practice Mode. |
| Weighting | LLM assigns a **conviction tier** per position, a **concentration style**, and a **cash level**; a deterministic rule produces weights. | Reproducible, auditable, less room for hindsight in weights. |
| Ambiguity | No chat. Thesis stage emits 1–3 candidate interpretations as data; default is the broadest reading. Alternates are shown as labeled sensitivity, never as a swap after seeing returns. | Supertake's "Build it now" picked the broadest reading in both observed cases. The post author is not present to answer questions. |
| Relationship | Three separate dimensions: **thesis alignment** (about the opinions), **portfolio co-movement** (raw ex-ante return correlation primary; residual ρ and β secondary), **holdings overlap** (a fact). They need not agree; mismatches are findings. No verbal strength labels; a direction is stated only when the 95% interval excludes zero. | §5. Revised 2026-10-19 after the first real-data result. |
| Time gap | Any gap allowed; flag a carried-forward thesis when posts are > 30 days apart; with a common window < 20 trading days, report everything that needs no outcome prices (readings, overlap, co-movement before the posts) and hold back returns until it reaches 20. | |
| Cash return | 0%. T-bill exposure, when wanted, is an explicit holding (e.g. SGOV). | Cash = uninvested brokerage balance. |

## 2. Pipeline

```
fixture / X post ──▶ ingest ──▶ analyze thesis ──▶ build draft ──▶ weight (deterministic)
     (×2, independent)            (LLM)            (LLM)            │
                                                                    ▼
                                                     FREEZE run record (hash, model, prompt version)
                                                                    │
                       prices loaded only after this point ─────────┘
                                                                    ▼
                                         backtest A, backtest B (common window)
                                                                    ▼
                                         compare: overlap, correlation, performance, narrative
```

Independence rules:

- Side A and side B are separate calls with no shared context. The model never sees the other post.
- The relationship analysis runs only after both portfolios are frozen.
- The interpretation prompt gets the post text, its date, and bounded context. It does **not** get the author's handle or name, since that invites recall of the author's later positions.
- Test: swapping input order must produce identical frozen portfolios (given pinned cache entries).

## 3. Data contracts

Sketches, to be written as zod schemas. Field order is load-bearing for LLM
output: reasoning fields come before verdicts (see `takes-classifier` StanceResult).

### 3.1 Post input

```ts
PostInput {
  post_id: string                 // snowflake ID, canonical
  url: string                     // canonical https://x.com/<handle>/status/<id>
  author_handle: string
  author_name?: string
  text: string                    // full text
  created_at: string              // ISO; derived from snowflake ID
  context?: { kind: "parent" | "quoted"; post_id: string; text: string }[]
  provenance: {
    source: "fixture_manual" | "oembed" | "x_api"
    text_verified: boolean        // false for manual paste; oEmbed truncates long posts
    retrieved_at: string
    raw?: unknown
  }
}
```

`created_at` comes from the ID: `(id >> 22) + 1288834974657` ms. Checked
against one post's `created_at` (2026-09-28T14:03:11Z). It needs a unit test
across several IDs.

### 3.2 Thesis analysis (LLM)

```ts
ThesisAnalysis {
  evidence: string[]              // verbatim spans from the post
  economic_claim: string          // what is claimed, in plain words
  direction: "bullish" | "bearish" | "mixed" | "descriptive" | "unclear"
  horizon?: string                // only if stated
  missing: string[]               // what the post leaves unspecified
  interpretations: {
    id: string
    label: string                 // "Cheap stocks AI left behind"
    expression: string            // how the claim becomes long positions
    author_stated: boolean        // false when beneficiaries are AI-inferred
    gap_note: string              // what the AI adds beyond the post
  }[]                             // 1–3
  default_interpretation: string  // the broadest reading, per stated rule
  status: "investable" | "not_investable" | "insufficient_context"
  status_reason: string
}
```

`not_investable` means the post makes no economic claim, e.g. a joke, a moral
view, or vibes. `insufficient_context` means it can't be understood without
context we don't have, e.g. a bare "this" reply.

### 3.3 Portfolio draft (LLM) → Portfolio (deterministic)

```ts
PortfolioDraft {
  interpretation_id: string
  title: string
  long_only_note: string          // how a bearish view became longs, if it did
  exclusions: string[]            // "no chipmakers"
  concentration: "concentrated" | "balanced" | "diversified"
  cash_level: "buffer" | "standard" | "defensive" | "majority"
  cash_reason: string
  buckets: { name: string; rationale: string }[]
  positions: {
    ticker: string
    role: string                  // 2–4 words, "Waymo owner"
    bucket: string
    rationale: string
    tier: "core" | "supporting" | "satellite"
  }[]
}
```

The LLM never emits a weight. `Portfolio` is the draft plus computed
`weight` per position, computed `bucket_weight`, `cash_weight`, and the
validation results.

### 3.4 Frozen run record

```ts
FrozenRun {
  run_id: string
  input_hash: string              // hash of PostInput fields the model saw
  model: string                   // exact model ID
  prompt_version: string
  analysis: ThesisAnalysis
  draft: PortfolioDraft
  portfolio: Portfolio
  frozen_at: string
}
```

Written before any price is loaded for the backtest window. Reruns read the
pinned record. A new run with a different model or prompt gets a new `run_id`
and never overwrites the old one.

## 4. Weighting rule

### Parameters

| | Positions | Per-name cap |
| --- | --- | --- |
| concentrated | 3–8 | 25% |
| balanced | 8–15 | 15% |
| diversified | 15–25 | 12% |

| Cash level | Cash |
| --- | --- |
| buffer | 5% |
| standard | 10% |
| defensive | 25% |
| majority | 45% |

Tier points: core 3, supporting 2, satellite 1. All three tables are
**provisional**. They're calibrated to 7 observed Supertake portfolios, mostly at
bucket level, so expect to tune.

### Algorithm

1. Validate: position count is within the style's range; no duplicate tickers (share-class spellings normalised); bucket names unique; every position's bucket exists; no empty buckets.
2. `invested = 100 − cash`.
3. Reject as `infeasible` if `n × cap < invested`: even equal weights breach the cap.
4. Per-point unit `u = invested / Σ points`; tier weight `w_t = points_t × u`.
5. Reject as `cap_exceeded` if the top tier's weight exceeds the cap.
6. Bucket weight = sum of its positions.

**The cap is a validity bound, not an adjustment.** Tier weights are always in
exact 3:2:1 ratio. Rejections never get fixed up silently: raising cash,
relaxing the cap or re-tiering would each change the model's interpretation.
The error messages say what the model could change, for a retry.

*Revision (2026-10-19):* the first version clipped the top tier to the cap and
re-split the excess among the tiers below. That erased conviction: concentrated
style, buffer cash, 1 core / 2 supporting / 1 satellite came out 25 / 25 / 25 / 20.
Even a single clip distorts the ratios; 2 core / 2 satellite came out 25 / 22.5,
which is 1.1:1 for a draft that said 3:1.

Cost of the strict rule: if tiers were assigned at random, the cap would reject
about 44–52% of concentrated drafts at buffer/standard cash, about 16–21% of
balanced drafts, and none of the diversified ones. That's a simulation, not LLM
behavior. Measure the real rejection and retry rates at step 7 before tuning
the tables.

**Weights are exact rationals, not rounded.** The backtest uses exact weights.
Display rounds each tier weight to one decimal, the same for every name in the tier,
and footnotes that the displayed total can differ from 100 by rounding.

*Revision from the earlier discussion:* I proposed integer weights via largest
remainder. Working an example showed the flaw: 4 core / 6 supporting / 8
satellite at 90% invested gives exact weights 8.4375 / 5.625 / 2.8125.
Largest remainder then hands out the 12 leftover points so that four
supporting names show 6% and two show 5%, even though they're in the same tier
and logically identical. "Every name in a tier has the same weight" is the
invariant worth keeping. Largest remainder would still be the right tool if we
ever need integer display; it just breaks that invariant.

### Worked examples (become unit tests)

| Case | Input | Expected |
| --- | --- | --- |
| Diversified, standard cash | 4 core, 6 supp, 8 sat; cash 10 | core 8.4375, supp 5.625, sat 2.8125; sum 90 |
| Cap would bind | concentrated, buffer cash; 2 core, 2 sat | u = 95/8 → core 35.6 > 25 → reject `cap_exceeded` |
| Flattening case | concentrated, buffer; 1 core, 2 supp, 1 sat | core 35.6 > 25 → reject; same draft at majority cash → 20.625 / 13.75 / 6.875 |
| Exactly at cap | concentrated, defensive; 3 core | 25 each, accepted |
| Barbell | concentrated, majority cash; 2 core, 1 sat | u = 55/7 → core 23.57, sat 7.86; no cap binds |
| Infeasible | concentrated, buffer cash; 3 core | 3 × 25 = 75 < 95 → reject `infeasible` |
| Single tier | balanced, 10 core | equal weight |

Property tests: weights sum to `invested` within 1e-9, cash ≥ 5, every
weight > 0 and ≤ cap, same tier → same weight, and exact point ratios between
tiers. Rejection codes are checked against an independent computation.

## 5. Relationship analysis

Three dimensions, each answering a different question. They are computed and
shown separately, and they need not agree.

| Dimension | Question | Source |
| --- | --- | --- |
| **Thesis alignment** | Do the original opinions support, contradict, or ignore each other? | LLM, after both portfolios are frozen |
| **Portfolio co-movement** | Have these hypothetical portfolios historically moved together? | Price data, ex-ante |
| **Holdings overlap** | Do they own the same things? | Arithmetic on weights |

**A correlation coefficient is not a measure of agreement between opinions.**
Two authors can disagree completely while their portfolios co-move: both
long-only, both riding the market, or the same assets reached from opposite
reasoning. Two compatible theses can also produce portfolios that move apart.
Those mismatches are among the most interesting findings this product can
show, and the comparison should point them out rather than smooth them over.

### 5.1 Thesis alignment

An LLM label on the two *theses*: opposing / partly conflicting / compatible
/ similar / unrelated / unknown, with a short source-grounded explanation.
- It runs only after both portfolios are frozen. It sees both posts and their analyses, but **not the portfolios** and never prices. *Revised 2026-10-19:* seeing the holdings could pull the label toward the holdings, and then a mismatch between thesis alignment and co-movement would no longer be independent evidence.
- Labels are provisional (schema: `ThesisAlignment`).
- It never cites ρ as evidence for or against agreement.

### 5.2 Portfolio co-movement

**Primary: raw ex-ante return correlation.** Market exposure is part of a
portfolio's economic character, so it isn't removed from the headline.

- Estimation window: the 252 daily returns ending on the last trading day **before the cutoff's ET date**, the same boundary as the LookAheadGate. (Revised from "the day before entry", which with T+1 entry would include the post day.)
- Portfolio daily return = Σ w_i · r_i, using constant weights over the estimation window (daily-rebalanced to target).
- Cash doesn't change correlation (scaling a return series doesn't change ρ); it changes β and volatility.

**Secondary, explanatory:**
- **Market betas:** each side's β to SPY.
- **Residual correlation:** `corr(ε_A, ε_B)` after `r_p = α + β·r_SPY + ε` on each side. It answers "beyond the overall market, do these move together?"
- **When raw and residual disagree, explain it.** For example: "these portfolios move in opposite directions mostly because one tends to fall when the market rises." Don't pick one silently.

**Realized correlation** over the backtest window uses the same statistics. It is an outcome, labeled as one.

**No verbal strength labels** ("strong", "weak", "opposed"). Each ρ carries an
approximate 95% interval from the Fisher transform, `tanh(atanh ρ ± 1.96/√(n−3))`.
A direction ("tend to move together / apart") is stated only when the interval
excludes zero. Otherwise: "no clear relationship". The interval assumes
independent daily returns, which real returns are not (volatility clusters,
tails are fat). A moving-block bootstrap check on the evaluation pairs found
this costs nothing over the 252-day estimation window (§10 item 9); it is still
a minimum bar for stating a direction, not a precise uncertainty. No thresholds
beyond this until there's data to calibrate them.

### 5.3 Holdings overlap

A plain fact: `Σ_i min(wA_i, wB_i)` over invested-weight shares (cash
excluded), plus the list of shared tickers.

### 5.4 First real-data result

2026-10-19, 252 days ending 2026-10-16, each side 90% invested:

| Pair | Holdings overlap | Raw ρ | Residual ρ | β A / β B |
| --- | --- | --- | --- | --- |
| Oil (XOM, CVX, COP) vs clean energy (ICLN, ENPH, FSLR) | 0 | −0.16 | +0.03 | −0.58 / 1.83 |
| NVDA vs AMD | 0 | +0.51 | +0.20 | 1.70 / 2.89 |
| NVDA vs XOM | 0 | −0.23 | −0.02 | 1.70 / −0.60 |

The oil vs clean-energy hypothesis (raw positive, residual negative) was
**wrong**; the observed pattern is the reverse. In this window oil was the
anti-market trade: each oil name had a negative β (−0.60 to −0.68,
independently recomputed). So the opposition shows up *through* the market
factor, and regressing on SPY removes it. Approximate standard error of ρ at
n = 252 is about 0.06, so a residual of +0.03 is indistinguishable from zero.
One year and three pairs: this is a counterexample, not a calibration. It is
why raw ρ, not residual, is the primary co-movement metric.

### 5.5 Guards and self-consistency

Guards:
- **Coverage:** a name lacking ≥ 90% of the estimation window is excluded from the estimate. If less than 90% of invested weight remains covered → "insufficient history".
- **Low exposure:** if a side's annualized volatility over the estimation window falls below a floor (provisional: 3%), show "minimal market exposure" instead of ρ.

**Interpretation sensitivity.** Every reading of each post (up to 3) is
drafted before freezing and frozen with the default; the default stays the
headline. Each A-reading × B-reading pairing gets holdings overlap and
ex-ante co-movement. A finding is stated only when *definite* opposite
directions (together and apart) both occur; "no clear relationship" under
one reading is not evidence of a different relationship. A reading that
fails to draft or backtest is reported with its error, never dropped.

**Self-consistency baseline.** Build each take N = 5 times from fresh calls,
not the cache. Report:
- mean pairwise holdings overlap, raw ρ and residual ρ within side A;
- the same within side B;
- the same between A and B.

The A-vs-B numbers are only interpreted relative to the within-side numbers.
Reference point from Supertake: two builds of the same Tesla take had 0.72
holdings overlap (Σmin over invested) and 0.86 weight cosine.

The headline portfolio is the first pinned run. Whether a consensus portfolio
should replace it (names in ≥ k of N runs) is **open**.

## 6. Backtest conventions

- **Cutoff:** `max(createdA, createdB)`, plus any context retrieved later.
- **Entry:** the close of the first trading day strictly **after the cutoff's ET date**. Never the post's own day, whatever the time. *Revised 2026-10-19:* the earlier rule ("first close after the cutoff time") needs an early-close calendar to be correct, since half days close at 13:00 ET, and a post at 14:00 on a half day would otherwise be bought at a price set before it existed. The T+1 rule needs no calendar and matches the LookAheadGate, which blocks the whole cutoff day. Cost: up to one trading day of lost window.
- **Market calendar:** the benchmark's (SPY's) trading days.
- **Prices:** adjusted close (split + dividend adjusted, total return).
- **Policy:** buy-and-hold from frozen weights; weights drift; no rebalancing. Notional $10,000; fractional shares; no fees, slippage or taxes (declared).
- **Cash:** 0% return.
- **Benchmark:** SPY, same window.
- **End:** latest available close, the same for both sides.
- **Metrics:** cumulative return, max drawdown, annualized volatility, return vs. SPY. No Sharpe on windows under 6 months.
- **Missing data:** a symbol without a price on the entry date fails validation. A mid-window gap carries the last price forward and is flagged. Delisting mid-window is flagged and the value is frozen at the last price. Holdings are never silently replaced.
- **Adjustment cross-check:** every holding's adjClose return is compared against an independent close + dividend + split computation, and a mismatch is flagged. Verified on real data: SPY dividends and NVDA's 10:1 split (2024-06-10) agree to ~1e-13. Unverified: a split and a dividend on the same day.
- **Real provider data is not committed.** Tests use synthetic fixtures, because Tiingo's free tier is licensed for personal use, not redistribution.
- **Carried forward:** if the posts are more than 30 days apart, the older thesis is labeled "interpreted as of the later post's date".

Fixture-level tests should be checkable by hand: a 2-asset portfolio with a
known split, a known dividend, and a gap.

## 7. Look-ahead and leakage

- Freeze before any backtest-window price is loaded (§3.4). Enforce it in code: the price loader refuses dates ≥ entry until a frozen run ID is supplied.
- Universe validation uses only data on or before the entry date.
- **Pretraining leakage can't be prompted away.** The cleanest cases are posts dated after the interpretation model's training cutoff, at the cost of short windows; today that means roughly 3 months. Older posts are allowed but labeled. Verify the chosen model's cutoff before relying on this.
- Withhold author identity from the interpretation prompt (§2).
- Case selection: write the criteria for choosing example pairs before looking at returns, and keep every attempted pair in the repo, including failures.

## 8. Data access (researched 2026-10-19)

**X posts**
- *Official API:* pay-per-use, $0.005 per post read, deduplicated within a 24h UTC window, self-set spend cap, optional auto-recharge (keep off). No free tier found. Source: docs.x.com pricing page. The developer agreement (storage and display rules) returned HTTP 402 and is **unread**.
- *oEmbed* (`publish.twitter.com/oembed`): works without auth, tested live. It returns author, URL, and text as HTML, but truncates long posts and gives a day-only date. Documented for embedding; use as a data source is a gray area.
- *Snowflake ID:* the exact creation timestamp, for free.
- An undocumented syndication endpoint exists and returns full JSON. **Not used.**
- Milestone 1 plan: manually pasted text (`text_verified: false`), timestamp from the ID, oEmbed as a cross-check. Milestone 2: official API behind a hard spend cap, pending approval.

**Prices**
- *Tiingo free:* 50 req/hr, 1,000/day, 500 symbols/month, 30+ years. Returns adjClose (CRSP method), divCash, splitFactor. License: "internal use only… your own personal use". Fine for Milestone 1 local development. **Not cleared for a public demo.**
- *Massive (Polygon) free:* 5 calls/min, 2 years of history; individual terms are personal/non-business and bar "derivative works". Weaker than Tiingo.
- *Tiingo, verified live 2026-10-19:* unknown symbols return 404. Delisted coverage is **partial**: TWTR is retained (through 2022-10-28), but SIVB is 404, so a 404 can't distinguish "never existed" from "delisted and dropped". Share classes use a dash (BRK-B; BRK.B is 404). `adjClose` total return matched an independent close + dividend + split computation for SPY (Jun–Oct 2026, dividends) and NVDA (10:1 split, 2024-06-10) to ~1e-13. `splitFactor` is the new-shares-per-old ratio on the split date.
- Massive delisted coverage: unverified.
- Public-demo licensing is **open**; decide by Milestone 3.

**LLM** (verified 2026-10-19 against the official models page and the installed SDK, `@anthropic-ai/sdk` 0.135.0)
- Model: `claude-opus-5-5` at `medium` effort, with server-side fallbacks (`fallbacks: "default"`). The served model is recorded on every call.
- **All current Claude models have a June 2026 training cutoff,** so the model doesn't change the pretraining-hindsight question; post dates do (§7).
- Structured output: `beta.messages.parse` + `zodOutputFormat`; the stable system prompt is prompt-cached.
- **Budget:** `LLM_BUDGET_USD` caps the *cumulative* ledger (`.cache/llm-ledger.jsonl`), not one process. Each call is refused if recorded spend plus its worst case would exceed the cap.
- **Measured costs** (8 real calls on synthetic posts, $0.15 total):
  - analysis: $0.004–0.023 per call; the first call writes the ~2.2k-token system prompt to cache;
  - draft: $0.037–0.042 per call;
  - every call was accepted on the first attempt, with no repairs.
- A full comparison (2 analyses + 2 drafts + alignment) should therefore cost about $0.15, and the N = 5 self-consistency baseline about $0.75. Both are estimates from these measurements, not measured end to end.

## 9. Milestone 1 build order

Each step ends with tests passing.

1. **Scaffold:** pnpm and TS config, a zod schema module, a test runner. `typecheck` and `test` scripts.
2. **Post input:** URL parsing and canonicalization (x.com / twitter.com / mobile, query strings), snowflake timestamp, fixture loader. Tests: URL variants, invalid URLs, timestamp decoding.
3. **Weighting rule** (§4), pure functions. Unit and property tests. No LLM involved.
4. **Price adapter:** Tiingo client, on-disk cache, a fixture adapter for tests, and the freeze guard (§7).
5. **Backtest engine** (§6), pure functions over price series. Hand-checkable fixtures.
6. **Overlap metrics** (§5), pure functions. Tests: identical portfolios (ρ = 1), disjoint-but-correlated, synthetic anti-correlated, all-low-vol guard, coverage guard.
7. **Thesis analysis + draft:** prompts, schemas, cache with prompt-version namespacing, budget cap. Negative fixtures: a joke, a moral claim, a context-dependent reply.
8. **CLI:** `compare <fixtureA> <fixtureB>` → frozen runs → backtest → a JSON report plus a minimal HTML render.
9. **Self-consistency:** `--runs 5`.

Steps 2–6 need no LLM and no network, beyond a one-time cached price pull.

**Acceptance:** the same pinned fixtures give a byte-identical report with no
network access, and an uninvestable fixture produces no portfolio.

## 10. Open

1. Example post pair(s): the developer is collecting candidates. Write the selection criteria first.
2. Interpretation model choice and eval design.
3. Consensus portfolio vs. pinned first run as the headline.
4. ~~Whether alternate-interpretation sensitivity ships in Milestone 1.~~ Done 2026-10-19: every reading is drafted and frozen before outcomes; the report grids all A-reading × B-reading pairings. On pair-01 the co-movement direction depended entirely on how post A was read (together / apart / together with shared MSFT, AMZN). Cost: about $0.04 per alternate draft.
5. Calibrating the tier, style and cash tables against more Supertake observations, ideally with per-name weights.
6. X developer agreement terms for storing and displaying post text.
7. Price-data licensing for a public demo.
8. Thesis-alignment label set and its eval: how to check the LLM's alignment judgments against human judgment.
9. ~~Whether the Fisher interval needs a correction for autocorrelated or heteroskedastic returns (e.g. a block bootstrap) before public use.~~ Checked 2026-10-22, no correction: `pnpm ci-check` compares Fisher with a circular moving-block bootstrap (blocks of 1, 5, 10 and 20 days; A, B and SPY resampled together; β re-fit per resample; 2,000 resamples) on the 7 evaluation pairs that produced portfolios. Over the 252-day ex-ante window, 0 of 56 bootstrap intervals (raw and residual) changed the direction; endpoints moved by at most about 0.04. Lag-1 autocorrelation of the A×B return products was −0.10 to 0.01, except 0.25 on the SaaS pair, whose intervals still matched. On the 26–67-day realized windows, 5 of 28 disagreed, and in 4 the bootstrap was the *more* confident (on 26 days it turned pair-06's "no clear relationship" into "together"): a percentile bootstrap undercovers at small n, so it is no fix there. Limits: one market year (2025–26), no crash-like regime; rerun the check after adding pairs from a different period.
10. **Default interpretation breadth.** The prompt asks for the broadest reading that covers the main claim; on the bearish synthetic post the model chose a narrower one ("money-center banks" over a mix). Supertake's "Build it now" chose the mix. Evaluate on real pairs before tuning.
11. **ETF look-through for holdings overlap.** A draft can hold both ITB and its constituents (DHI, LEN, PHM); across sides, ITB vs. DHI counts as zero overlap. Co-movement captures it; holdings overlap doesn't.
13. **Presentation of combined findings.** On the first real pair, "opinions conflict but portfolios move together" and "together raw, apart beyond the market" are both true and read as contradictory side by side; the second explains the first. The report should present them as one story.
12. **Tiingo's hourly limit** (50/hour on the free tier) is the throughput bottleneck: a draft checks every ticker (6–11 requests so far), and the backtest window needs another request per ticker. Throttle or pace before running the self-consistency baseline.
