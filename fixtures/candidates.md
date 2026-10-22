# Candidate post pairs

The working list of X post pairs for evaluation and the demo. Each pair has a
`## pair-NN` heading followed by `- key: value` lines, so the pipeline can read
this file directly. Fill in the blanks; leave a field empty rather than
guessing.

**Don't paste post text here.** The text goes into per-post fixtures, created
separately, because oEmbed truncates long posts and the text needs its own
provenance. This file holds links, your labels, and why each pair was chosen.

## Selection criteria

Recorded 2026-10-19, **before any of these pairs has been analyzed or backtested.**
The git history of this file timestamps the criteria and each pair's addition.

1. **Don't look at what the mentioned stocks did after the posts** while choosing. A pair is chosen for its arguments, never its outcome.
2. **Two intelligent, defensible positions,** not one thoughtful argument against an obviously exaggerated one.
3. **Dates:**
   - **Preferred: July 2026 or later.** The whole comparison window then falls after the interpretation model's training cutoff (June 2026, all current Claude models), so pretraining hindsight is ruled out by construction. The window is shorter (about 3 months as of today).
   - **Allowed: March–June 2026.** A longer window, but the model may have learned part of what happened next. Results are labeled "window overlaps model training data".
   - **Earlier than March 2026:** only with a stated reason.
4. **Assign the category before analysis** (opposing / related / unrelated / negative control). Don't move a pair between categories after seeing results.
5. **Keep every attempted pair,** including ones that fail, abstain or look boring. Rejected candidates go in the log at the bottom with the reason.
6. Each post should stand on its own text. If its meaning depends on a chart, link or parent post, note it under `depends_on`.

Fields per pair:
- `category`: opposing | related | unrelated | negative_control
- `subject`: short topic name
- `a_url`, `b_url`: the status links, pasted as-is (tracking query strings are fine)
- `a_label`, `b_label`: your one-line summary. **For organizing only; never shown to the model.**
- `a_depends_on`, `b_depends_on`: media/link/parent context the text relies on, or `none`
- `found_via`: how you found it (e.g. X Advanced Search query)
- `window_end`: the last day the backtest runs through, fixed so the pair's numbers don't drift between runs (YYYY-MM-DD, a completed trading day). Moving it later is a deliberate, logged edit. Empty means through the latest prices. The UI can still rerun through today on request.
- `why`: why this pair is worth testing
- `notes`

The post date is **not** a field: it is computed from the post ID and can't be wrong.

---

## pair-01

- category: opposing
- subject: AI infrastructure
- a_url: https://x.com/edzitron/status/2073083956950388894?s=20
- a_label: AI is a bubble
- a_depends_on: chart image + link (not visible to the model)
- b_url: https://x.com/oguzerkan/status/2077671967671357765?s=20
- b_label: AI spending will keep accelerating
- b_depends_on: chart image; long post, oEmbed truncates it
- found_via: (developer, X)
- window_end: 2026-10-21
- why: Broad but investable disagreement.
- notes: Checked 2026-10-19: A is 2026-07-03, B is 2026-07-16, both after the model's training cutoff. B's text is narrower than its label: it argues a shift to cheaper models moves margins from AI labs to cloud providers (bullish for AI infrastructure). A argues the hyperscalers' AI returns are meager and masked by their other businesses. Both are about hyperscalers, reached from opposite directions.

## pair-02

- category: opposing
- subject: Oil vs. renewables
- a_url: https://x.com/Electroversenet/status/2086905424452743230?s=20
- a_label: Fossil fuels will dominate for decades
- a_depends_on: chart image; long post, oEmbed truncates it
- b_url: https://x.com/Jason/status/2082206441717264739?s=20
- b_label: Clean energy will displace them
- b_depends_on: a t.co link (content unknown)
- found_via:
- window_end: 2026-10-21
- why: Intuitively opposing economic exposures. Our first real-data check showed oil moving against the market in Oct 2025–Oct 2026, a good test of the co-movement explanation.
- notes: Checked 2026-10-19: A 2026-08-10, B 2026-07-28, both after the training cutoff. A cites data; B states its view with less supporting argument in the text itself.

## pair-03

- category: opposing
- subject: Nvidia's moat
- a_url: https://x.com/MilkRoadAI/status/2085115395850264656?s=20
- a_label: Nvidia's moat will persist
- a_depends_on: chart image (key numbers restated in the text); ends with a paid-newsletter promotion
- b_url: https://x.com/tokenbender/status/2079284390451147148?s=20
- b_label: Nvidia's moat is eroding (AMD, Huawei)
- b_depends_on: none; long post, oEmbed truncates it
- found_via:
- window_end: 2026-10-21
- why: Directly opposing views on Nvidia's moat. Bearish side tests long-only translation (Huawei isn't US-listed).
- notes: Recategorized related -> opposing on 2026-10-19, before any analysis: the replacement A makes this a direct disagreement. Original A (@tunguz) rejected; see log. A 2026-08-05, B 2026-07-20.

## pair-04

- category: opposing
- subject: Tesla vs. traditional automakers
- a_url: https://x.com/niccruzpatane/status/2090599312312922214?s=20
- a_label: You cannot be bullish enough on Tesla (and SpaceX)
- a_depends_on: chart image + link
- b_url: https://x.com/CoinvoTrading/status/2081439407190474806?s=20
- b_label: Tesla is overvalued; Chinese robotaxis will win
- b_depends_on: image; oEmbed truncates it
- found_via: B: X search for Tesla-bear posts in the poster's own voice
- window_end: 2026-10-21
- why: Two interpretations of automotive disruption. A bearish-on-Tesla reading tests long-only translation (Supertake's own builder turned "Tesla is overvalued" into long rivals, including NVDA and GOOGL).
- notes: B replaced and relabeled 2026-10-19, before any analysis (was 'Legacy manufacturers are undervalued'; no own-voice legacy-auto bull found). A 2026-08-21, B 2026-07-26. A includes SpaceX, which may not be investable. B's figures are the author's assertions, not checked. B's framing is promotional but it makes two substantive arguments.

## pair-05

- category: opposing
- subject: Software and AI
- a_url: https://x.com/yongfook/status/2091794287310815593?s=20
- a_label: AI will destroy SaaS margins
- a_depends_on: none
- b_url: https://x.com/KyleReidhead/status/2088974078862619075?s=20
- b_label: AI will expand SaaS profitability
- b_depends_on: chart image + link; last third is a paid-newsletter promotion and a holdings disclosure
- found_via:
- window_end: 2026-10-21
- why: Competing theses with potentially surprising portfolio overlap.
- notes: Checked 2026-10-19: A 2026-08-24, B 2026-08-16. A says AI doesn't replace CRM; B names Salesforce and ServiceNow, so overlapping holdings from opposite views are possible. B's promotion stays in the text (verbatim rule); don't feature B in a public demo without deciding that separately.

## pair-06

- category: unrelated
- subject: Control: independent theses
- a_url: https://x.com/IncomeSharks/status/2077459480963616779
- a_label: long $HOOD
- a_depends_on:
- b_url: https://x.com/jablamsky/status/2099566262431203737
- b_label: long $META
- b_depends_on:
- found_via:
- window_end: 2026-10-21
- why: Does the system report independence as independence, not as disagreement?
- expected_relationship: none
- expected co-movement: none
- notes:

## pair-07

- category: negative_control
- subject: Control: at least one uninvestable post
- a_url: https://x.com/realMAG1775/status/2099646554344743107
- a_label: e.g. a joke, a moral or social opinion, or vague vibes
- a_depends_on:
- b_url: https://x.com/srvc76/status/2099641452825346389
- b_label: any ordinary investable take
- b_depends_on:
- found_via:
- window_end: 2026-10-21
- why: The system must abstain on the uninvestable side instead of inventing tickers.
- notes:

## pair-08

- category: related
- subject: Inputs to AI data centers
- a_url: https://x.com/ekwufinance/status/2078118055087931511
- a_label: bullish on copper as an input to data center buildouts
- a_depends_on: chart image (copper relative to the S&P); the text states the claim without it
- b_url: https://x.com/srvc76/status/2099641452825346389
- b_label: bullish on electricity generation as input to data centers
- b_depends_on: chart image; the text states the claim without it
- found_via:
- window_end: 2026-10-21
- why: Replaces the related slot pair-03 used to fill. Tests different holdings with potentially similar exposures, and claims that can both be true.
- expected_relationship: opinions are similarly bullish about data center inputs
- expected_co_movement: no clear relationship, because the investments will be in very different industries
- notes: Added 2026-10-22. A is 2026-07-17, B is 2026-09-14: both after the model's training cutoff, 59 days apart (exercises the carried-forward caveat). Window from 2026-09-15 is short (~26 trading days as of today). B's full text opens with Moody's generation estimates but its own view is narrower: bullish on battery storage ("a Golden Age of Battery Storage. While market valuations disagree."). Fixtures written from full text pasted by the developer; oEmbed truncates both.

---

## Rejected candidates

Pairs considered and dropped, and why. Keep these: they document the selection.

| Date | Subject | URLs | Reason |
| --- | --- | --- | --- |
| 2026-10-19 | Nvidia's moat (pair-03 A) | https://x.com/tunguz/status/2070324208702464005 | Posted 2026-06-26, before the model's training cutoff; a reply ("way dumber than that") whose meaning depends on an unseen post; doesn't say what the moat is. |
| 2026-10-19 | Tesla vs. legacy (pair-04 B) | https://x.com/DeItaone/status/2081661171631874354 | A news headline relaying Jefferies' upgrade of GM, not the poster's own opinion; interpreting it would misattribute the thesis. |
