import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CashLevel, Concentration, PortfolioDraft, Tier } from "../src/lib/schema.js";
import {
  CASH,
  STYLE,
  TIER_POINTS,
  displayTotal,
  round1,
  tickerKey,
  tierWeights,
  weightPortfolio,
  type Portfolio,
} from "../src/lib/weights.js";

const EPS = 1e-9;

function draft(
  concentration: Concentration,
  cash_level: CashLevel,
  tiers: Tier[],
  buckets = ["Main"],
): PortfolioDraft {
  return {
    interpretation_id: "i1",
    title: "Test",
    long_only_note: "",
    exclusions: [],
    concentration,
    cash_level,
    cash_reason: "test",
    buckets: buckets.map((name) => ({ name, rationale: "" })),
    positions: tiers.map((tier, i) => ({
      ticker: `T${i}`,
      role: "r",
      bucket: buckets[i % buckets.length]!,
      rationale: "",
      tier,
    })),
  };
}

function repeat(spec: [Tier, number][]): Tier[] {
  return spec.flatMap(([t, n]) => Array<Tier>(n).fill(t));
}

function ok(d: PortfolioDraft): Portfolio {
  const r = weightPortfolio(d);
  if (!r.ok) assert.fail(`${r.error}: ${r.message}`);
  return r.value;
}

function close(actual: number | undefined, expected: number, msg?: string) {
  assert.ok(actual !== undefined && Math.abs(actual - expected) < EPS, `${msg ?? ""} expected ${expected}, got ${actual}`);
}

// ── Worked examples from docs/PLAN.md §4 ────────────────────────────────

describe("worked examples", () => {
  it("diversified, standard cash: 4 core / 6 supporting / 8 satellite", () => {
    const p = ok(draft("diversified", "standard", repeat([["core", 4], ["supporting", 6], ["satellite", 8]])));
    // 90% invested over 4·3 + 6·2 + 8·1 = 32 points -> 2.8125 per point.
    close(p.tier_weights.core, 8.4375);
    close(p.tier_weights.supporting, 5.625);
    close(p.tier_weights.satellite, 2.8125);
    assert.equal(p.cash_weight, 10);
  });

  it("cap would bind: concentrated, buffer cash, 2 core / 2 satellite -> rejected", () => {
    // Core would be 3 · 95/8 = 35.625 > 25. Clipping to 25 would leave
    // satellites at 22.5 — a 1.1:1 split for a draft that said 3:1.
    const r = weightPortfolio(draft("concentrated", "buffer", repeat([["core", 2], ["satellite", 2]])));
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.error, "cap_exceeded");
      assert.match(r.message, /35\.6%/);
    }
  });

  it("barbell: concentrated, majority cash, 2 core / 1 satellite", () => {
    const p = ok(draft("concentrated", "majority", repeat([["core", 2], ["satellite", 1]])));
    close(p.tier_weights.core, (3 * 55) / 7);
    close(p.tier_weights.satellite, 55 / 7);
    assert.equal(p.cash_weight, 45);
  });

  it("infeasible: concentrated, buffer cash, 3 core", () => {
    const r = weightPortfolio(draft("concentrated", "buffer", repeat([["core", 3]])));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, "infeasible");
  });

  it("single tier is equal weight", () => {
    const p = ok(draft("balanced", "standard", repeat([["core", 10]])));
    close(p.tier_weights.core, 9);
  });
});

// ── Edge cases ──────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("a weight exactly at the cap is allowed", () => {
    // concentrated, defensive: 75% invested, 3 core × 25 = 75.
    const p = ok(draft("concentrated", "defensive", repeat([["core", 3]])));
    close(p.tier_weights.core, 25);
  });

  it("rejects the tier-flattening case from the design discussion", () => {
    // concentrated, buffer, 1 core / 2 supporting / 1 satellite. The old
    // clip-and-redistribute rule gave 25 / 25 / 25 / 20.
    const r = weightPortfolio(draft("concentrated", "buffer", repeat([["core", 1], ["supporting", 2], ["satellite", 1]])));
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, "cap_exceeded");
  });

  it("the same draft with more cash is accepted with exact ratios", () => {
    // Majority cash: 55 over 8 points -> core 20.625, supporting 13.75, satellite 6.875.
    const p = ok(draft("concentrated", "majority", repeat([["core", 1], ["supporting", 2], ["satellite", 1]])));
    close(p.tier_weights.core, 20.625);
    close(p.tier_weights.supporting, 13.75);
    close(p.tier_weights.satellite, 6.875);
  });

  it("an only-satellite top tier is checked against the cap too", () => {
    // Concentrated, buffer, 4 satellites: 23.75 each, under 25.
    const p = ok(draft("concentrated", "buffer", repeat([["satellite", 4]])));
    close(p.tier_weights.satellite, 23.75);
  });

  it("tiers with no positions are omitted, not zero", () => {
    const p = ok(draft("balanced", "standard", repeat([["core", 5], ["satellite", 5]])));
    assert.equal("supporting" in p.tier_weights, false);
  });

  it("bucket weight is the sum of its positions", () => {
    const p = ok(draft("balanced", "standard", repeat([["core", 4], ["supporting", 3], ["satellite", 3]]), ["A", "B"]));
    for (const b of p.buckets) {
      const sum = p.positions.filter((x) => x.bucket === b.name).reduce((s, x) => s + x.weight, 0);
      close(b.weight, sum, b.name);
    }
    close(p.buckets.reduce((s, b) => s + b.weight, 0), 90);
  });

  it("position order does not change any ticker's weight", () => {
    const d = draft("diversified", "standard", repeat([["core", 3], ["supporting", 7], ["satellite", 8]]));
    const reversed = { ...d, positions: [...d.positions].reverse() };
    const a = new Map(ok(d).positions.map((p) => [p.ticker, p.weight]));
    const b = new Map(ok(reversed).positions.map((p) => [p.ticker, p.weight]));
    assert.deepEqual(a, b);
  });
});

// ── Draft validation ────────────────────────────────────────────────────

describe("validation", () => {
  it("rejects a position count outside the style's range", () => {
    for (const [c, n] of [["concentrated", 2], ["concentrated", 9], ["balanced", 7], ["diversified", 26]] as const) {
      const r = weightPortfolio(draft(c, "standard", repeat([["core", n]])));
      assert.equal(r.ok, false, `${c} with ${n}`);
      if (!r.ok) assert.equal(r.error, "count_out_of_range");
    }
  });

  it("rejects duplicate tickers across share-class spellings", () => {
    const d = draft("concentrated", "standard", repeat([["core", 4]]));
    d.positions[0]!.ticker = "BRK.B";
    d.positions[1]!.ticker = "brk-b";
    const r = weightPortfolio(d);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, "duplicate_ticker");
  });

  it("tickerKey normalises case, whitespace and class separators", () => {
    assert.equal(tickerKey(" brk.b "), "BRK-B");
    assert.equal(tickerKey("BRK/B"), "BRK-B");
    assert.notEqual(tickerKey("GOOG"), tickerKey("GOOGL"));
  });

  it("rejects a position in an undeclared bucket", () => {
    const d = draft("concentrated", "standard", repeat([["core", 4]]));
    d.positions[0]!.bucket = "Nope";
    const r = weightPortfolio(d);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, "unknown_bucket");
  });

  it("rejects an empty bucket", () => {
    const d = draft("concentrated", "standard", repeat([["core", 4]]));
    d.buckets.push({ name: "Empty", rationale: "" });
    const r = weightPortfolio(d);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, "empty_bucket");
  });

  it("rejects a duplicate bucket name", () => {
    const d = draft("concentrated", "standard", repeat([["core", 4]]));
    d.buckets.push({ name: "Main", rationale: "" });
    const r = weightPortfolio(d);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error, "duplicate_bucket");
  });
});

// ── Properties over random drafts ───────────────────────────────────────
//
// Seeded so a failure reproduces. Covers every style × cash level and the
// full position-count range, including the infeasible corner.

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("properties", () => {
  it("holds for 5,000 random drafts", () => {
    const rand = mulberry32(20261019);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
    const styles = [...Object.keys(STYLE), "named"] as Concentration[];
    const cashLevels = Object.keys(CASH) as CashLevel[];
    const tiers = Object.keys(TIER_POINTS) as Tier[];
    let feasible = 0;
    let infeasible = 0;
    let capExceeded = 0;

    for (let i = 0; i < 5000; i++) {
      const style = pick(styles);
      const cash = pick(cashLevels);
      const invested = 100 - CASH[cash];
      // Restated here rather than read from NAMED, so the test checks the rule.
      const { min, max, cap } = style === "named" ? { min: 2, max: 8, cap: 0.8 * invested } : STYLE[style];
      const n = min + Math.floor(rand() * (max - min + 1));
      const d = draft(style, cash, Array.from({ length: n }, () => pick(tiers)), ["A", "B", "C"].slice(0, Math.min(3, n)));
      const r = weightPortfolio(d);
      const label = `#${i} ${style}/${cash}/n=${n}`;

      // Expected outcome, computed independently of the implementation.
      if (n * cap < invested) {
        assert.equal(r.ok, false, label);
        if (!r.ok) assert.equal(r.error, "infeasible", label);
        infeasible++;
        continue;
      }
      const totalPoints = d.positions.reduce((s, x) => s + TIER_POINTS[x.tier], 0);
      const topPoints = Math.max(...d.positions.map((x) => TIER_POINTS[x.tier]));
      if ((topPoints * invested) / totalPoints > cap + EPS) {
        assert.equal(r.ok, false, label);
        if (!r.ok) assert.equal(r.error, "cap_exceeded", label);
        capExceeded++;
        continue;
      }
      if (!r.ok) assert.fail(`${label}: ${r.message}`);
      const p = r.value;
      feasible++;

      const sum = p.positions.reduce((s, x) => s + x.weight, 0);
      assert.ok(Math.abs(sum - invested) < EPS, `${label} sum ${sum}`);
      assert.ok(Math.abs(sum + p.cash_weight - 100) < EPS, label);
      assert.ok(p.cash_weight >= 5, label);
      for (const x of p.positions) {
        assert.ok(x.weight > 0, `${label} ${x.ticker} weight ${x.weight}`);
        assert.ok(x.weight <= cap + EPS, `${label} ${x.ticker} over cap`);
        assert.equal(x.weight, p.tier_weights[x.tier], `${label} same tier, same weight`);
      }
      // Higher conviction never weighs less.
      const present = (["core", "supporting", "satellite"] as Tier[]).filter((t) => p.tier_weights[t] !== undefined);
      for (let j = 1; j < present.length; j++) {
        assert.ok(p.tier_weights[present[j - 1]!]! >= p.tier_weights[present[j]!]! - EPS, `${label} monotone`);
      }
      // Every accepted portfolio keeps exact point ratios between tiers.
      for (let j = 1; j < present.length; j++) {
        const [hi, lo] = [present[j - 1]!, present[j]!];
        const ratio = p.tier_weights[hi]! / p.tier_weights[lo]!;
        assert.ok(Math.abs(ratio - TIER_POINTS[hi] / TIER_POINTS[lo]) < 1e-9, `${label} ratio`);
      }
    }
    // Guard against a generator that silently stops exercising a branch.
    assert.ok(
      feasible > 1000 && infeasible > 50 && capExceeded > 50,
      `feasible=${feasible} infeasible=${infeasible} cap_exceeded=${capExceeded}`,
    );
  });
});

describe("tierWeights", () => {
  it("splits invested weight in point ratio and ignores the cap", () => {
    const w = tierWeights({ core: 1, satellite: 1 }, 100);
    close(w.core, 75);
    close(w.satellite, 25);
    assert.equal("supporting" in w, false);
  });
});

// ── Display ─────────────────────────────────────────────────────────────

describe("display", () => {
  it("round1 rounds half away from zero despite binary representation", () => {
    // Computed the way tierWeights computes a weight: points × (remaining /
    // total points). Exactly 1.05, but stored as 1.0499999999999998, so a
    // plain Math.round(x * 10) gives 1.0. The current tables never produce
    // this case (searched exhaustively); it guards against future table changes.
    assert.equal(round1(3 * (7 / 20)), 1.1);
    assert.equal(round1(2.85), 2.9);
    assert.equal(round1(2.8125), 2.8);
    assert.equal(round1(8.4375), 8.4);
    assert.equal(round1(5.625), 5.6);
    assert.equal(round1(0.05), 0.1);
  });

  it("displayTotal exposes rounding drift for the UI to footnote", () => {
    // 4 × 8.4 + 6 × 5.6 + 8 × 2.8 + 10 = 99.6
    const p = ok(draft("diversified", "standard", repeat([["core", 4], ["supporting", 6], ["satellite", 8]])));
    assert.equal(displayTotal(p), 99.6);
  });

  it("displayTotal is 100 when nothing needs rounding", () => {
    const p = ok(draft("balanced", "standard", repeat([["core", 10]])));
    assert.equal(displayTotal(p), 100);
  });
});

describe("named style", () => {
  it("allows two holdings, capped at 80% of invested weight", () => {
    const r = weightPortfolio(draft("named", "standard", repeat([["core", 1], ["satellite", 1]]), ["A"]));
    assert.ok(r.ok, !r.ok ? r.message : "");
    if (!r.ok) return;
    assert.deepEqual(r.value.positions.map((p) => p.weight), [67.5, 22.5]);
    assert.equal(r.value.cap, 72);
  });

  it("never allows a single holding", () => {
    const r = weightPortfolio(draft("named", "standard", repeat([["core", 1]]), ["A"]));
    assert.ok(!r.ok && r.error === "count_out_of_range");
  });
});
