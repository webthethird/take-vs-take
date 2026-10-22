"use client";
// Client component: runs in the browser. It only talks to /api/compare and
// imports types (erased at build) from the pipeline, never its code.

import { useState } from "react";
import type { CompareEvent, PostView, ReportView } from "../lib/api.js";
import type { FidelityResult, FrozenRun, Stage } from "../lib/compare.js";
import type { FidelityLink, SharedDrivers } from "../lib/schema.js";
import { authorNamed } from "../lib/readings.js";
import { tickerKey } from "../lib/ticker.js";
import type { DemoPair } from "../server/posts.js";
import { PerformanceChart } from "./chart.js";

const COLORS = { A: "#2563eb", B: "#d97706", SPY: "#6b7280" };

const STAGES: { key: string; label: string }[] = [
  { key: "analyze:A", label: "Read post A" },
  { key: "draft:A", label: "Build portfolio A" },
  { key: "analyze:B", label: "Read post B" },
  { key: "draft:B", label: "Build portfolio B" },
  { key: "frozen", label: "Freeze both portfolios" },
  { key: "align", label: "Compare the opinions" },
  { key: "drivers", label: "Compare what the holdings are exposed to" },
  { key: "fidelity:A", label: "Check portfolio A against its post" },
  { key: "fidelity:B", label: "Check portfolio B against its post" },
  { key: "prices", label: "Load prices" },
  { key: "backtest", label: "Backtest and compare" },
];
// Server messages carry UTC ISO timestamps; show them in the viewer's time.
const localTimes = (m: string) =>
  m.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, (t) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
const stageKey = (s: Stage) => ("side" in s ? `${s.stage}:${s.side}` : s.stage);

type Result = Extract<CompareEvent, { type: "result" }>;

export function Comparer({ pairs }: { pairs: DemoPair[] }) {
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [busy, setBusy] = useState(false);
  const [stages, setStages] = useState<string[]>([]);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<{ message: string; side?: string } | null>(null);

  async function run(urlA = a, urlB = b, latest = false) {
    setBusy(true);
    setStages([]);
    setResult(null);
    setError(null);
    try {
      const res = await fetch("/api/compare", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ a: urlA, b: urlB, ...(latest ? { latest } : {}) }) });
      if (!res.ok || !res.body) {
        const e = (await res.json().catch(() => null)) as CompareEvent | null;
        setError(e?.type === "error" ? { message: e.message, side: e.side } : { message: `Request failed (${res.status}).` });
        return;
      }
      // Read the NDJSON stream line by line as it arrives.
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const ev = JSON.parse(buf.slice(0, nl)) as CompareEvent;
          buf = buf.slice(nl + 1);
          if (ev.type === "stage") setStages((s) => [...s, stageKey(ev.stage)]);
          else if (ev.type === "result") setResult(ev);
          else setError({ message: ev.message, side: ev.side });
        }
      }
    } catch (e) {
      setError({ message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="inputs">
        {pairs.length > 0 && (
          <div className="examples">
            <span>Examples:</span>
            {pairs.map((p) => (
              <button
                key={p.id}
                type="button"
                disabled={busy}
                title={`${p.a_label} vs. ${p.b_label}`}
                onClick={() => {
                  setA(p.a_url);
                  setB(p.b_url);
                  void run(p.a_url, p.b_url);
                }}
              >
                {p.subject}
              </button>
            ))}
          </div>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
        >
          <label className={error?.side === "a" || error?.side === "both" ? "bad" : ""}>
            First take (X URL)
            <input value={a} onChange={(e) => setA(e.target.value)} placeholder="https://x.com/…/status/…" disabled={busy} />
          </label>
          <label className={error?.side === "b" || error?.side === "both" ? "bad" : ""}>
            Second take (X URL)
            <input value={b} onChange={(e) => setB(e.target.value)} placeholder="https://x.com/…/status/…" disabled={busy} />
          </label>
          <button type="submit" disabled={busy || !a || !b}>
            {busy ? "Comparing…" : "Compare"}
          </button>
        </form>
        {error && <p className="error">{localTimes(error.message)}</p>}
        {result?.pinned_end && !busy && (
          <p className="pinned">
            This example runs through {result.pinned_end}, a fixed date, so its numbers stay the same between runs.{" "}
            <button type="button" onClick={() => void run(a, b, true)}>
              Rerun with prices through today
            </button>
          </p>
        )}
        {(busy || (stages.length > 0 && !result)) && (
          <ol className="stages">
            {STAGES.filter((s) => stages.includes(s.key) || busy).map((s) => {
              const i = stages.indexOf(s.key);
              // The last stage reached is the one in progress, or the one that failed.
              const last = i === stages.length - 1;
              const state = i < 0 ? "todo" : last && busy ? "doing" : last && error ? "failed" : "done";
              return (
                <li key={s.key} className={state}>
                  {s.label}
                </li>
              );
            })}
          </ol>
        )}
      </section>
      {result && <Report report={result.report} posts={result.posts} />}
    </>
  );
}

// ── Report ───────────────────────────────────────────────────────────────

const pct = (x: number, digits = 1) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(digits)}%`;
const words = (s: string) => s.replace(/_/g, " ");
const round1 = (x: number) => Math.round(x * 10 + 1e-9) / 10;

function Report({ report, posts }: { report: ReportView; posts: { A: PostView; B: PostView } }) {
  const [sa, sb] = report.sides as [FrozenRun, FrozenRun];
  const bt = report.backtests;
  return (
    <div className="report">
      <Summary report={report} />

      <section className="caveats">
        {report.caveats.map((c) => (
          <p key={c}>{c}</p>
        ))}
      </section>

      <Comparison report={report} />

      {bt && report.window && (
        <section>
          <h2>Hypothetical performance</h2>
          <p className="muted">
            $10,000 each, bought at the close on {report.window.entry} (the first trading day after the later post) and held to {report.window.end}. Dividends
            reinvested, cash earns 0%, no fees. An outcome over one period, not a verdict on either opinion.
          </p>
          <PerformanceChart
            series={(
              [
                ["A", bt.a.chart],
                ["B", bt.b.chart],
              ] as const
            ).flatMap(([name, values]) => (values ? [{ name, color: COLORS[name], values }] : []))}
          />
          {(["A", "B"] as const)
            .filter((name) => !bt[name === "A" ? "a" : "b"].chart)
            .map((name) => (
              <p key={name} className="muted small">
                {name} isn&apos;t charted: it holds a single security, or one holding is over 80% of it, so its value line would be close to that
                security&apos;s price history, which the data license doesn&apos;t allow showing. Its summary figures are below.
              </p>
            ))}
          <p className="muted small">Weekly points. SPY is not charted for the same reason; its figures are in the table.</p>
          <table className="metrics">
            <thead>
              <tr>
                <th />
                <th>Return</th>
                <th>Max drawdown</th>
                <th>Volatility (annualized)</th>
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ["A", bt.a],
                  ["B", bt.b],
                  ["SPY", bt.benchmark],
                ] as const
              ).map(([name, r]) => (
                <tr key={name}>
                  <td>
                    <i className="dot" style={{ background: COLORS[name] }} /> {name}
                  </td>
                  <td>{pct(r.metrics.cumulativeReturn)}</td>
                  <td>{(r.metrics.maxDrawdown * 100).toFixed(1)}%</td>
                  <td>{r.metrics.annualizedVolatility === null ? "n/a" : `${(r.metrics.annualizedVolatility * 100).toFixed(1)}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <details className="full">
        <summary>Both posts and portfolios in full</summary>
        <section className="sides">
          <SideCard side={sa} post={posts.A} color={COLORS.A} ret={bt?.a.metrics.cumulativeReturn} fidelity={report.fidelity?.A ?? null} />
          <SideCard side={sb} post={posts.B} color={COLORS.B} ret={bt?.b.metrics.cumulativeReturn} fidelity={report.fidelity?.B ?? null} />
        </section>
      </details>

      <footer className="muted">
        <p>
          Data sourced by <a href="https://www.tiingo.com">Tiingo</a>. Shown: summary figures, and weekly portfolio values for portfolios of two or more holdings. No prices.
        </p>
        Comparison {report.comparison_id} · model cost ${report.llm_cost_usd.toFixed(2)} (0 when replayed from cache) · versions{" "}
        {Object.entries(report.versions)
          .map(([k, v]) => `${k} ${v}`)
          .join(", ")}
      </footer>
    </div>
  );
}

/// The answer first: each post's claim, what stands out, and the headline
/// numbers. Everything here is repeated, with its method, further down.
function Summary({ report }: { report: ReportView }) {
  const sides = report.sides as [FrozenRun, FrozenRun];
  const bt = report.backtests;
  const h = report.holdings_overlap;
  const cm = report.co_movement;
  const al = report.alignment?.value;
  return (
    <section className="summary">
      <div className="claims">
        {sides.map((s) => (
          <div key={s.label} className="claim" style={{ borderLeftColor: COLORS[s.label] }}>
            <p className="small">
              <strong style={{ color: COLORS[s.label] }}>Post {s.label}</strong>{" "}
              <a href={s.post.url} target="_blank" rel="noreferrer">
                @{s.post.author_handle}
              </a>
              <span className="muted"> · {s.post.created_at.slice(0, 10)}</span>
            </p>
            <p>
              <span className={`tag ${s.analysis.direction}`}>{s.analysis.direction}</span> {s.analysis.economic_claim}
            </p>
            {!s.portfolio && <p className="muted small">No portfolio: {words(s.analysis.status)}.</p>}
            {s.portfolio && <FidelityLine f={report.fidelity?.[s.label] ?? null} />}
          </div>
        ))}
      </div>
      {report.findings.length > 0 && (
        <ul className="findings">
          {report.findings.map((f) => (
            <li key={f.text}>{f.text}</li>
          ))}
        </ul>
      )}
      {report.drivers && (
        <p className="drivers-summary">
          <span className="tag">
            AI reading of the holdings{report.drivers.expectations.length > 1 ? ` (1 of ${report.drivers.expectations.length})` : ""}
          </span>{" "}
          {report.drivers.value.summary}
        </p>
      )}
      <dl className="headline">
        {al && (
          <div>
            <dt>Opinions</dt>
            <dd>{words(al.relationship)}</dd>
          </div>
        )}
        {h && (
          <div>
            <dt>Direct ticker overlap</dt>
            <dd>{Math.round(h.overlap * 100)}%</dd>
          </div>
        )}
        {cm?.ex_ante_direction && (
          <div>
            <dt>Daily moves, year before</dt>
            <dd>
              {words(cm.ex_ante_direction)}
              {cm.ex_ante?.raw != null && <span className="muted"> ({cm.ex_ante.raw.toFixed(2)})</span>}
            </dd>
          </div>
        )}
        {bt && report.window && (
          <div>
            <dt>
              Return, {report.window.entry} to {report.window.end}
            </dt>
            <dd>
              <span style={{ color: COLORS.A }}>A {pct(bt.a.metrics.cumulativeReturn)}</span> ·{" "}
              <span style={{ color: COLORS.B }}>B {pct(bt.b.metrics.cumulativeReturn)}</span> ·{" "}
              <span className="muted">SPY {pct(bt.benchmark.metrics.cumulativeReturn)}</span>
            </dd>
          </div>
        )}
      </dl>
    </section>
  );
}

const LINKS: { key: FidelityLink; label: string; title: string }[] = [
  { key: "named", label: "named in the post", title: "The post names this company or security." },
  { key: "direct", label: "direct", title: "Not named, but it expresses the claim itself with little else attached." },
  { key: "proxy", label: "stand-in", title: "Stands in for something the claim is about that can't be owned or wasn't specified; carries other exposures too." },
  { key: "added", label: "added", title: "Exposure the claim doesn't call for." },
];

/// How the invested weight splits by fidelity label, and what the portfolio
/// can only approximate. The labels are the model's; the percentages are sums.
function FidelityLine({ f }: { f: FidelityResult | null }) {
  if (!f) return <p className="muted small">Fidelity labels unavailable.</p>;
  const parts = LINKS.filter((l) => f.shares[l.key] > 0).map((l) => `${Math.round(f.shares[l.key] * 100)}% ${l.label}`);
  return (
    <div className="fidelity small">
      <p>
        <span className="tag">AI check against the post</span> Invested weight: {parts.join(" · ")}. {f.value.summary}
      </p>
      {f.value.not_investable.length > 0 && (
        <p className="muted">
          Can&apos;t be owned directly: {f.value.not_investable.map((x) => `${x.part} (${x.why})`).join("; ")}
        </p>
      )}
    </div>
  );
}

function SideCard({ side, post, color, ret, fidelity }: { side: FrozenRun; post: PostView; color: string; ret?: number; fidelity: FidelityResult | null }) {
  const an = side.analysis;
  const reading = an.interpretations.find((i) => i.id === an.default_interpretation);
  const p = side.portfolio;
  return (
    <article className="side" style={{ borderTopColor: color }}>
      <header>
        <h2 style={{ color }}>Post {side.label}</h2>
        <a href={side.post.url} target="_blank" rel="noreferrer">
          @{side.post.author_handle}
        </a>
        <span className="muted"> · {side.post.created_at.slice(0, 10)}</span>
      </header>
      <blockquote>{post.text}</blockquote>
      {!post.text_verified && <p className="muted small">Saved copy of the post, not fetched from X.</p>}
      {side.post.attachments.length > 0 && <p className="muted small">The post includes {side.post.attachments.join(" and ")} the model could not see.</p>}

      <h3>What the post claims</h3>
      <p>
        <span className={`tag ${an.direction}`}>{an.direction}</span> {an.economic_claim}
      </p>

      {!p && (
        <div className="abstain">
          <strong>No portfolio: {words(an.status)}.</strong> {an.status_reason}
        </div>
      )}

      {p && reading && (
        <>
          <h3>How it was turned into a portfolio</h3>
          <p>
            <strong>{reading.label}</strong> <span className="tag">{authorNamed(an, reading) ? "the post names these" : "AI-inferred"}</span>
          </p>
          {reading.gap_note && <p className="muted small">Beyond the post: {reading.gap_note}</p>}
          {side.model_default && (
            <p className="muted small">
              The model preferred a broader reading, &ldquo;{an.interpretations.find((i) => i.id === side.model_default)?.label}&rdquo;. Readings built
              from what the author named come first here, even when they cover less of the claim.
            </p>
          )}
          {p.long_only_note && <p className="muted small">Long-only: {p.long_only_note}</p>}
          <table className="holdings">
            <tbody>
              {p.buckets.map((bk) => (
                <BucketRows key={bk.name} bucket={bk} positions={p.positions.filter((x) => x.bucket === bk.name)} fidelity={fidelity} />
              ))}
              <tr className="cash">
                <td>Cash</td>
                <td className="muted small">{p.cash_reason}</td>
                <td>{p.cash_weight}%</td>
              </tr>
            </tbody>
          </table>
          {ret !== undefined && (
            <p className="small">
              Hypothetical return over the window: <strong>{pct(ret)}</strong>
            </p>
          )}
        </>
      )}
    </article>
  );
}

function BucketRows({
  bucket,
  positions,
  fidelity,
}: {
  bucket: { name: string; weight: number };
  positions: { ticker: string; weight: number; role: string }[];
  fidelity: FidelityResult | null;
}) {
  const labelOf = (t: string) => fidelity?.value.holdings.find((h) => tickerKey(h.ticker) === tickerKey(t));
  return (
    <>
      <tr className="bucket">
        <td colSpan={2}>{bucket.name}</td>
        <td>{round1(bucket.weight)}%</td>
      </tr>
      {positions.map((x) => (
        <tr key={x.ticker}>
          <td className="ticker">{x.ticker}</td>
          <td className="muted small">
            {x.role}
            {(() => {
              const l = labelOf(x.ticker);
              const meta = l && LINKS.find((k) => k.key === l.link);
              return meta ? (
                <>
                  {" "}
                  <span className={`tag link-${l.link}`} title={`${meta.title} ${l.note}`}>
                    {meta.label}
                    {l.stands_for ? `: ${l.stands_for}` : ""}
                  </span>
                </>
              ) : null;
            })()}
          </td>
          <td>{round1(x.weight)}%</td>
        </tr>
      ))}
    </>
  );
}

function Comparison({ report }: { report: ReportView }) {
  const al = report.alignment?.value;
  const h = report.holdings_overlap;
  const cm = report.co_movement;
  const ex = cm?.ex_ante;
  const bt = report.backtests;
  const ci = (c: [number, number] | null) => (c ? `95% interval ${c[0].toFixed(2)} to ${c[1].toFixed(2)}` : "");
  const explain = (d: string | null | undefined) =>
    d === "together" ? "tended to rise and fall together" : d === "apart" ? "tended to move in opposite directions" : "showed no clear relationship (the interval includes zero)";
  if (!al && !h && !cm) return null;
  return (
    <section>
      <h2>How the two takes relate</h2>
      <p className="muted">Three separate questions. They don't have to agree, and when they don't, that's the interesting part.</p>
      <div className="facts">
        <div className="fact">
          <h3>Do the opinions agree?</h3>
          {al ? (
            <>
              <p className="big">{words(al.relationship)}</p>
              <p className="small">{al.reasoning}</p>
              <p className="muted small">Judged by the model from the two posts alone ({al.confidence} confidence). It never saw the portfolios or prices.</p>
            </>
          ) : (
            <p className="muted">Unavailable.</p>
          )}
        </div>
        <div className="fact">
          <h3>Do they hold the same tickers?</h3>
          {h ? (
            <>
              <p className="big">{Math.round(h.overlap * 100)}%</p>
              <p className="small">direct ticker overlap</p>
              <p className="small">{h.shared.length ? `Both hold ${h.shared.map((s) => s.ticker).join(", ")}.` : "No tickers in common."}</p>
              <p className="muted small">
                Share of invested weight in the same tickers (the smaller weight of each shared ticker, summed). A fund counts as one ticker, so if one
                side holds a fund that owns the other side&apos;s stocks, that shared exposure isn&apos;t counted here. The next card measures shared
                exposure from how the portfolios actually behaved.
              </p>
            </>
          ) : (
            <p className="muted">Not computed: a side has no portfolio.</p>
          )}
        </div>
        <div className="fact">
          <h3>Do their daily moves line up?</h3>
          {ex && ex.raw !== null ? (
            <>
              <p className="big">{words(cm!.ex_ante_direction ?? "unavailable")}</p>
              {bt && (
                <p className="small">
                  This is separate from where they ended up (over the window, A {pct(bt.a.metrics.cumulativeReturn)} and B{" "}
                  {pct(bt.b.metrics.cumulativeReturn)}): portfolios whose daily moves line up can still drift far apart.
                </p>
              )}
              <p className="small">
                In the year before the posts, the two portfolios' daily returns {explain(cm!.ex_ante_direction)}: correlation {ex.raw.toFixed(2)}, {ci(ex.rawCi95)}.
              </p>
              {ex.residual !== null && (
                <p className="small">
                  Beyond the overall market (betas {ex.a.beta.toFixed(2)} and {ex.b.beta.toFixed(2)}): correlation {ex.residual.toFixed(2)}, {ci(ex.residualCi95)}.
                </p>
              )}
              {cm!.realized && cm!.realized.raw !== null && (
                <p className="muted small">
                  Over the comparison window itself ({cm!.realized.days} trading days): correlation {cm!.realized.raw.toFixed(2)}, {ci(cm!.realized.rawCi95)}:{" "}
                  {words(cm!.realized_direction ?? "n/a")}. Shown for reference; it uses the outcome period.
                </p>
              )}
            </>
          ) : (
            <p className="muted">{cm?.ex_ante_error ?? "Not computed: a side has no portfolio."}</p>
          )}
        </div>
      </div>
      {report.drivers && <Drivers d={report.drivers.value} expectations={report.drivers.expectations} />}
    </section>
  );
}

const EXPECT = { together: "line up", apart: "move in opposite directions", no_clear_relationship: "show no clear relationship" } as const;

function Drivers({ d, expectations }: { d: SharedDrivers; expectations: SharedDrivers["expected_daily_co_movement"][] }) {
  const n = expectations.length;
  const split = (Object.keys(EXPECT) as (keyof typeof EXPECT)[])
    .map((e) => [e, expectations.filter((x) => x === e).length] as const)
    .filter(([, c]) => c > 0)
    .map(([e, c]) => `${c} expected their daily moves to ${EXPECT[e]}`)
    .join(", ");
  return (
    <div className="fact drivers">
      <h3>What are they exposed to?</h3>
      <p>{d.summary}</p>
      {d.shared.length > 0 && (
        <table className="exposures">
          <thead>
            <tr>
              <th>Shared driver</th>
              <th style={{ color: COLORS.A }}>A</th>
              <th style={{ color: COLORS.B }}>B</th>
            </tr>
          </thead>
          <tbody>
            {d.shared.map((x) => (
              <tr key={x.driver}>
                <td>{x.driver}</td>
                <td>{x.a}</td>
                <td>{x.b}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {d.differences.length > 0 && (
        <table className="exposures">
          <thead>
            <tr>
              <th>Where they differ</th>
              <th style={{ color: COLORS.A }}>A</th>
              <th style={{ color: COLORS.B }}>B</th>
            </tr>
          </thead>
          <tbody>
            {d.differences.map((x) => (
              <tr key={x.driver}>
                <td>{x.driver}</td>
                <td>{x.a}</td>
                <td>{x.b}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted small">
        The model&apos;s reading of the two portfolios ({d.confidence} confidence), made after both were frozen and before any prices were loaded.{" "}
        {n > 1
          ? `It was asked ${n} times with the identical prompt: ${split}. Shown: the first reading with the most common answer.`
          : `It expected their daily moves to ${EXPECT[d.expected_daily_co_movement]}.`}{" "}
        Compare that with the measured result above. An interpretation, not data.
      </p>
    </div>
  );
}
