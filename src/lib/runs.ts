// Retention for saved runs (.cache/runs). A frozen run or report quotes its
// posts (evidence, commentary), so one built from posts fetched from X is
// deleted 30 days after the earliest of those fetches, like the X responses
// themselves. Runs built only from fixtures are kept.

import { readFile, readdir, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { xExpiry } from "./x.js";

type Provenance = { source: string; retrieved_at: string };

/// Every post provenance in a saved record, wherever the record's shape puts
/// it (a frozen run's `post`, a report's `sides[].post`, ...), so a new
/// record type can't slip past the sweep.
function provenances(v: unknown, out: Provenance[] = []): Provenance[] {
  if (Array.isArray(v)) for (const x of v) provenances(x, out);
  else if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.source === "string" && typeof o.retrieved_at === "string") out.push(o as Provenance);
    for (const x of Object.values(o)) provenances(x, out);
  }
  return out;
}

/// Delete expired records under `dir`, and any run folder left empty.
/// Unreadable records are deleted too: one may be a half-written file
/// carrying X content. Returns the number of records deleted.
export async function sweepRuns(dir: string, now: Date = new Date()): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(dir, { recursive: true });
  } catch {
    return 0;
  }
  let removed = 0;
  const touched = new Set<string>();
  for (const rel of entries.filter((f) => f.endsWith(".json"))) {
    const path = join(dir, rel);
    try {
      const expires = xExpiry(provenances(JSON.parse(await readFile(path, "utf8"))).map((provenance) => ({ provenance })));
      if (!expires || expires.getTime() > now.getTime()) continue;
    } catch {
      // Unreadable: delete it too.
    }
    await rm(path, { force: true });
    removed++;
    if (rel.includes("/")) touched.add(join(dir, rel.slice(0, rel.lastIndexOf("/"))));
  }
  for (const d of touched) await rmdir(d).catch(() => {}); // only if now empty
  return removed;
}
