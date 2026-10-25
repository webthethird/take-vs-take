# Take vs. Take

Two X posts in, two hypothetical portfolios out, compared fairly.

Each post is read on its own and translated into a long-only paper portfolio
(or an explicit abstention, when the post isn't investable). Only after both
portfolios are frozen does the app load prices and compare them: whether the
opinions agree, whether the portfolios hold the same tickers, whether their
daily returns move together, what drives them, how faithfully each portfolio
follows its post, and how each did against SPY over the same window.

The point is the comparison. Rhetorically opposed posts can imply portfolios
that move together, and similar-sounding posts can imply very different risk.
Those mismatches are reported as findings, not hidden.

> **Not investment advice.** Every portfolio here is an AI-generated,
> hypothetical interpretation of a public post. The posts' authors did not
> pick, hold or endorse these allocations, and the backtested returns say
> nothing about whether an author was right.
>
> **No affiliation.** This is an independent project. It is not affiliated
> with or endorsed by Supertake, X, Tiingo or Anthropic. Some weighting
> defaults were calibrated against observed output from Supertake's public
> take-to-portfolio builder; see `docs/PLAN.md`.

## How it works

```
post A ─▶ analyze ─▶ draft ─▶ weight ─┐
                                      ├─▶ FREEZE ─▶ align opinions, shared drivers, fidelity
post B ─▶ analyze ─▶ draft ─▶ weight ─┘                    │
                                         prices unlocked only here
                                                           ▼
                                  backtest A, B, SPY ─▶ co-movement ─▶ findings
```

- **Independence.** Each side is analyzed and drafted without seeing the
  other. No prompt asks for an "opposing" portfolio. Each pair of posts has
  one fixed order (an example's own A/B, otherwise the earlier post first),
  so entering the links either way gives the same, cached comparison.
- **Abstention.** Jokes, moral views and vague takes return
  `not_investable` with a reason instead of tickers.
- **Deterministic weights.** The model picks holdings, a conviction tier for
  each, a concentration style and a cash level; a fixed, versioned rule
  (`src/lib/weights.ts`) turns those into weights.
- **No look-ahead in construction.** Price access goes through a gate that
  opens only after both portfolios are frozen with their model and prompt
  versions. This does not remove hindsight the model may have learned in
  pretraining; pairs posted after the model's training cutoff avoid that.
- **Common window.** Both portfolios enter at the close of the first trading
  day after the later post's date (US Eastern) and are held to the same end
  date (buy and hold, adjusted closes, uninvested cash returns 0%). A thesis
  carried forward from an older post is flagged. Example pairs run through a
  pinned end date (`window_end` in `fixtures/candidates.md`), so their
  numbers don't change between runs; the page can rerun one through today.
- **Co-movement.** Daily-return correlation over the year *before* the posts
  (raw, and beyond market exposure), with a 95% interval. A direction is
  stated only when the interval excludes zero.
- **Model readings are labeled as such.** The shared-drivers prediction is
  sampled three times and the split is shown; fidelity labels each holding as
  named by the post, a direct expression, a stand-in, or an addition.

`docs/PLAN.md` records the design decisions, data contracts and open
questions in more detail. `fixtures/candidates.md` lists the evaluation pairs
with selection criteria written before any of them was analyzed.

## Running it

Developed on Node 26 with pnpm.

```sh
pnpm install
cp .env.example .env   # then fill in the keys; see the comments in the file
pnpm test
pnpm dev               # http://127.0.0.1:3000
```

You need a [Tiingo](https://www.tiingo.com) token for prices and an
[Anthropic API](https://console.anthropic.com) key for the model calls.
`LLM_BUDGET_USD` caps model spend per process; results are cached, so reruns
replay for free. A new pair has cost well under $1 in model calls so far.

New comparisons from the web page are limited to 3 per visitor and 30 for
all visitors combined in any 24 hours (`RUN_LIMIT_PER_VISITOR`,
`RUN_LIMIT_TOTAL`). Only runs that make a paid request count, and the check
happens just before that request, so a refused run has spent nothing and a
fully cached replay is never refused. Set `VISITOR_IP_HEADER` to the
client-address header your host sets (e.g. `x-real-ip`); until then every
visitor shares one limit. A prompt change makes cached examples miss the
cache, so rerun them before deploying, or the first visitors pay for them.

**Posts.** A link resolves to a saved fixture if there is one, otherwise
it's fetched from the X API when `X_BEARER_TOKEN` is set. A fetch looks up
only the linked posts and the posts they quote or reply to (one level),
with their images, video preview frames and link previews; the model sees
those images, but never opens linked pages, which may have changed since the
post. Everything kept from an X fetch is deleted 30 days after that fetch:
the API responses (`.cache/x`), model responses for calls that carried X
content (`.cache/llm/expiring`), and saved comparisons that include an X
post (`.cache/runs`). A rerun after that pays again. Deletion happens when
the app next runs, so a copy can outlive its 30 days by however long the
app sits idle.

Fixtures are hand-written JSON in `fixtures/private/` (gitignored, since
post text belongs to its author). The model is told about their
attachments but not shown them:

```json
{
  "url": "https://x.com/<handle>/status/<id>",
  "author_handle": "<handle>",
  "text": "Full post text, verbatim.",
  "attachments": ["image"],
  "retrieved_at": "2026-10-19T00:00:00Z"
}
```

The post time is derived from the status ID. The web UI lists pairs from
`fixtures/candidates.md` whose two fixtures exist, as
`fixtures/private/pair-NN-a.json` and `pair-NN-b.json`. From the command line:

```sh
pnpm compare fixtures/private/pair-01-a.json fixtures/private/pair-01-b.json
pnpm interpret fixtures/synthetic/*.json    # one post at a time, synthetic examples
pnpm ci-check                               # Fisher vs. block-bootstrap intervals on saved comparisons
```

### Tiingo plan

Set `TIINGO_PLAN` to match your subscription. On `starter`, Tiingo's terms
forbid storing its data or results derived from it, so nothing is cached and
no report is saved. `power` allows caching. The UI charts only portfolios of
two or more holdings with none above 80% of invested weight, and never charts
SPY or a single security, so the page doesn't redistribute a price series.
Price data is sourced by Tiingo.

## Limitations

- Retrospective backtests over short windows (weeks to a few months for
  post-cutoff pairs). Returns describe one hypothetical implementation over
  one period.
- The correlation interval (Fisher) assumes independent daily returns. A
  block-bootstrap check on the evaluation pairs agreed with it on every
  stated direction (`pnpm ci-check`; details in `docs/PLAN.md` §10), but that
  covers one market year, without a crash. Directions over the short
  comparison windows are shown for reference only.
- Holdings overlap compares tickers only; an ETF and its constituents count
  as no overlap (co-movement still captures it).
- Model readings vary from run to run, and the evaluation pairs were also
  used to tune the prompts, so they are not a held-out test.

## License

[MIT](LICENSE)
