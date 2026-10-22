import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { blockBootstrapIntervals, mulberry32 } from "../src/lib/bootstrap.js";
import { fisherInterval, pearson } from "../src/lib/overlap.js";

/// Independent daily returns: market m, and A, B each loading on m plus a
/// shared factor f, so both raw and residual correlation are positive.
function series(n: number, seed: number) {
  const rand = mulberry32(seed);
  const normal = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const rm: number[] = [];
  const ra: number[] = [];
  const rb: number[] = [];
  for (let i = 0; i < n; i++) {
    const m = 0.01 * normal();
    const f = 0.01 * normal();
    rm.push(m);
    ra.push(m + f + 0.01 * normal());
    rb.push(0.5 * m + f + 0.01 * normal());
  }
  return { ra, rb, rm };
}

describe("blockBootstrapIntervals", () => {
  it("is deterministic for a seed and changes with it", () => {
    const { ra, rb, rm } = series(100, 1);
    const x = blockBootstrapIntervals(ra, rb, rm, { block: 5, samples: 500 });
    assert.deepEqual(blockBootstrapIntervals(ra, rb, rm, { block: 5, samples: 500 }), x);
    assert.notDeepEqual(blockBootstrapIntervals(ra, rb, rm, { block: 5, samples: 500, seed: 7 }), x);
  });

  it("brackets the sample ρ and roughly matches Fisher on independent data", () => {
    const { ra, rb, rm } = series(252, 2);
    const r = pearson(ra, rb)!;
    const f = fisherInterval(r, 252)!;
    for (const block of [1, 5, 20]) {
      const b = blockBootstrapIntervals(ra, rb, rm, { block });
      assert.ok(b.raw && b.raw[0] < r && r < b.raw[1]);
      assert.ok(Math.abs(b.raw[0] - f[0]) < 0.06 && Math.abs(b.raw[1] - f[1]) < 0.06, `block ${block}: ${b.raw} vs ${f}`);
      assert.ok(b.residual && b.residual[0] > 0, "the shared factor survives removing the market");
    }
  });

  it("gives the point for a perfect correlation", () => {
    const { ra, rm } = series(50, 3);
    const b = blockBootstrapIntervals(ra, ra.map((v) => 2 * v), rm, { block: 5, samples: 200 });
    assert.ok(b.raw && Math.abs(b.raw[0] - 1) < 1e-12 && Math.abs(b.raw[1] - 1) < 1e-12);
  });

  it("returns null for too few days or a constant series, and rejects bad input", () => {
    const { ra, rb, rm } = series(3, 4);
    assert.deepEqual(blockBootstrapIntervals(ra, rb, rm, { block: 1 }), { raw: null, residual: null });
    const s = series(30, 5);
    assert.equal(blockBootstrapIntervals(s.ra, s.ra.map(() => 0), s.rm, { block: 5, samples: 200 }).raw, null);
    assert.throws(() => blockBootstrapIntervals(s.ra, s.rb, s.rm, { block: 0 }), /positive integer/);
    assert.throws(() => blockBootstrapIntervals(s.ra, s.rb.slice(1), s.rm, { block: 5 }), /same length/);
  });
});
