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
- found_via:
- why: Broad but investable disagreement.
- notes: Checked 2026-10-19: A is 2026-07-03, B is 2026-07-16, both after the model's training cutoff. B's text is narrower than its label: it argues a shift to cheaper models moves margins from AI labs to cloud providers (bullish for AI infrastructure). A argues the hyperscalers' AI returns are meager and masked by their other businesses. Both are about hyperscalers, reached from opposite directions.

## pair-02

- category: opposing
- subject: Oil vs. renewables
- a_url:
- a_label: Fossil fuels will dominate for decades
- a_depends_on:
- b_url:
- b_label: Clean energy will displace them
- b_depends_on:
- found_via:
- why: Intuitively opposing economic exposures. Our first real-data check showed oil moving against the market in Oct 2025–Oct 2026, a good test of the co-movement explanation.
- notes:

## pair-03

- category: related
- subject: Nvidia vs. AMD
- a_url:
- a_label: Nvidia's moat will persist
- a_depends_on:
- b_url:
- b_label: AMD will take significant share
- b_depends_on:
- found_via:
- why: Different holdings, potentially similar exposures. Tests holdings overlap vs. co-movement.
- notes:

## pair-04

- category: opposing
- subject: Tesla vs. traditional automakers
- a_url:
- a_label: Tesla's valuation is justified
- a_depends_on:
- b_url:
- b_label: Legacy manufacturers are undervalued
- b_depends_on:
- found_via:
- why: Two interpretations of automotive disruption. A bearish-on-Tesla reading tests long-only translation (Supertake's own builder turned "Tesla is overvalued" into long rivals, including NVDA and GOOGL).
- notes:

## pair-05

- category: opposing
- subject: Software and AI
- a_url:
- a_label: AI will destroy SaaS margins
- a_depends_on:
- b_url:
- b_label: AI will expand SaaS profitability
- b_depends_on:
- found_via:
- why: Competing theses with potentially surprising portfolio overlap.
- notes:

## pair-06

- category: unrelated
- subject: Control: independent theses
- a_url:
- a_label: e.g. oil demand will grow
- a_depends_on:
- b_url:
- b_label: e.g. cybersecurity spending will accelerate
- b_depends_on:
- found_via:
- why: Does the system report independence as independence, not as disagreement?
- notes:

## pair-07

- category: negative_control
- subject: Control: at least one uninvestable post
- a_url:
- a_label: e.g. a joke, a moral or social opinion, or vague vibes
- a_depends_on:
- b_url:
- b_label: any ordinary investable take
- b_depends_on:
- found_via:
- why: The system must abstain on the uninvestable side instead of inventing tickers.
- notes:

---

## Rejected candidates

Pairs considered and dropped, and why. Keep these: they document the selection.

| Date | Subject | URLs | Reason |
| --- | --- | --- | --- |
