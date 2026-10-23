import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { sweepRuns } from "../src/lib/runs.js";

const post = (source: string, retrieved_at: string) => ({ post: { post_id: "1", provenance: { source, text_verified: true, retrieved_at } } });

describe("sweepRuns", () => {
  it("deletes records of X posts 30 days after the earliest fetch, and keeps fixture runs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tvt-runs-"));
    const write = async (rel: string, body: unknown) => {
      await mkdir(join(dir, rel, ".."), { recursive: true });
      await writeFile(join(dir, rel), typeof body === "string" ? body : JSON.stringify(body));
    };
    await write("compare-old/frozen-a.json", post("fixture_manual", "2026-01-01T00:00:00Z"));
    await write("compare-old/frozen-b.json", post("x_api", "2026-09-01T00:00:00Z"));
    // A report holds both sides; the older fetch sets its clock.
    await write("compare-old/report.json", { sides: [post("x_api", "2026-10-20T00:00:00Z"), post("x_api", "2026-09-01T00:00:00Z")] });
    await write("compare-new/frozen-a.json", post("x_api", "2026-10-20T00:00:00Z"));
    await write("compare-fixture/frozen-a.json", post("fixture_manual", "2026-01-01T00:00:00Z"));
    await write("compare-junk/frozen-a.json", "{");
    await write("syn-01.json", { input: { text: "synthetic" } });

    assert.equal(await sweepRuns(dir, new Date("2026-09-30T23:59:59Z")), 1, "only the unreadable one before day 30");
    assert.equal(await sweepRuns(dir, new Date("2026-10-01T00:00:00Z")), 2);
    assert.deepEqual((await readdir(dir)).sort(), ["compare-fixture", "compare-new", "compare-old", "syn-01.json"]);
    assert.deepEqual(await readdir(join(dir, "compare-old")), ["frozen-a.json"], "the fixture side stays; it quotes no X content");
  });

  it("does nothing when there's no runs folder", async () => {
    assert.equal(await sweepRuns(join(tmpdir(), "tvt-runs-missing-" + Date.now())), 0);
  });
});
