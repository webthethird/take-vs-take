// A dependency-free SVG line chart: value of $10,000 over the common window,
// one weekly point per series (see server/view.ts for what may be charted).

type Series = { name: string; color: string; values: { date: string; value: number }[] };

const W = 720;
const H = 260;
const PAD = { left: 56, right: 12, top: 12, bottom: 28 };

export function PerformanceChart({ series }: { series: Series[] }) {
  const all = series.flatMap((s) => s.values.map((v) => v.value));
  // Series share one window, so they share dates; x is by position.
  const dates = series[0]?.values.map((v) => v.date) ?? [];
  if (all.length === 0 || dates.length < 2) return null;
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const span = hi - lo || 1;
  const x = (i: number) => PAD.left + (i / (dates.length - 1)) * (W - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + (1 - (v - lo) / span) * (H - PAD.top - PAD.bottom);
  const ticks = [lo, (lo + hi) / 2, hi];
  const start = series[0]!.values[0]!.value;

  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Weekly value of each hypothetical portfolio over the common window">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} className="grid" />
            <text x={PAD.left - 6} y={y(t) + 4} textAnchor="end" className="axis">
              ${Math.round(t).toLocaleString()}
            </text>
          </g>
        ))}
        {lo < start && start < hi && <line x1={PAD.left} x2={W - PAD.right} y1={y(start)} y2={y(start)} className="baseline" />}
        <text x={PAD.left} y={H - 8} className="axis">
          {dates[0]}
        </text>
        <text x={W - PAD.right} y={H - 8} textAnchor="end" className="axis">
          {dates.at(-1)}
        </text>
        {series.map((s) => (
          <polyline
            key={s.name}
            fill="none"
            stroke={s.color}
            strokeWidth={2.25}
            points={s.values.map((v, i) => `${x(i).toFixed(1)},${y(v.value).toFixed(1)}`).join(" ")}
          />
        ))}
      </svg>
      <figcaption>
        {series.map((s) => (
          <span key={s.name} className="legend">
            <i style={{ background: s.color }} /> {s.name}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}
