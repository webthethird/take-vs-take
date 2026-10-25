// Limits on paid runs, for a public endpoint. A run is "paid" once it
// sends its first billable request (a model call or an X lookup); replays
// served entirely from cache are free and never limited, so the prepared
// examples always work.
//
// Two limits over a rolling 24 hours: per visitor, and for all visitors
// combined. The combined one is the real ceiling: a visitor who rotates
// addresses gets past the first but not the second.
//
// State is a small JSON file, so a restart doesn't reset the counts. It
// holds salted hashes of visitor addresses, never the addresses, and only
// the last 24 hours. Callers serialize runs (the route's one-at-a-time
// lock), so read-modify-write here doesn't race.

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const WINDOW_MS = 86_400_000;

/// Every visitor shares this bucket when no trusted header identifies them.
export const SHARED_VISITOR = "shared";

export type Limits = { perVisitor: number; total: number };

/// retry_at: when the oldest counted run leaves the window; null for a
/// limit of 0 (paid runs switched off).
export type Refusal = { scope: "visitor" | "total"; limit: number; retry_at: string | null };

type State = { salt: string; runs: { v: string; t: string }[] };

export class RunLimiter {
  constructor(
    private readonly path: string,
    private readonly limits: Limits,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async load(): Promise<State> {
    try {
      const s = JSON.parse(await readFile(this.path, "utf8")) as State;
      if (typeof s.salt === "string" && Array.isArray(s.runs)) return s;
    } catch {
      // Missing or unreadable: start over.
    }
    return { salt: randomBytes(16).toString("hex"), runs: [] };
  }

  /// Count one paid run for this visitor, or refuse it and say when the
  /// oldest counted run leaves the window.
  async take(visitor: string): Promise<Refusal | null> {
    const s = await this.load();
    const now = this.now().getTime();
    s.runs = s.runs.filter((r) => now - Date.parse(r.t) < WINDOW_MS);
    const v = createHash("sha256").update(`${s.salt}|${visitor}`).digest("hex").slice(0, 16);
    const mine = s.runs.filter((r) => r.v === v);
    const refuse = (scope: Refusal["scope"], limit: number, oldest: { t: string } | undefined): Refusal => ({
      scope,
      limit,
      retry_at: oldest ? new Date(Date.parse(oldest.t) + WINDOW_MS).toISOString() : null,
    });
    // runs is in time order, so [length - limit] is the one that must expire.
    if (mine.length >= this.limits.perVisitor) return refuse("visitor", this.limits.perVisitor, mine[mine.length - this.limits.perVisitor]);
    if (s.runs.length >= this.limits.total) return refuse("total", this.limits.total, s.runs[s.runs.length - this.limits.total]);
    s.runs.push({ v, t: new Date(now).toISOString() });
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(s));
    await rename(tmp, this.path);
    return null;
  }
}

/// A run's gate: the first billable request charges the run; later ones in
/// the same run pass. A refused charge is remembered, so the route can
/// report it instead of whatever error the refused request turned into.
export function spendGate(limiter: RunLimiter, visitor: string) {
  let charged = false;
  const gate = {
    refusal: null as Refusal | null,
    /// Null to proceed; otherwise a message for the refused request.
    async charge(): Promise<string | null> {
      if (charged) return null;
      if (gate.refusal) return refusalMessage(gate.refusal);
      gate.refusal = await limiter.take(visitor);
      if (gate.refusal) return refusalMessage(gate.refusal);
      charged = true;
      return null;
    },
  };
  return gate;
}

export function refusalMessage(r: Refusal): string {
  const replay = "Comparisons this demo has already run still replay.";
  if (r.retry_at === null) return `New comparisons are switched off on this demo. ${replay}`;
  const who = r.scope === "visitor" ? "from your connection" : "across all visitors";
  return `This demo allows ${r.limit} new comparisons a day ${who}, and that's used up. Try again after ${r.retry_at}. ${replay}`;
}

/// Who's asking, by the client address in a header the deployment's proxy
/// sets and visitors can't forge (VISITOR_IP_HEADER, e.g. x-real-ip). With
/// no header configured, or a request missing it, everyone shares one
/// bucket: forging headers never buys extra runs.
export function visitorId(headers: Headers, header: string | undefined): string {
  if (!header) return SHARED_VISITOR;
  // A list (x-forwarded-for style): the last entry is the one our own proxy
  // appended; earlier ones came from the client.
  const ip = headers.get(header)?.split(",").pop()?.trim().toLowerCase();
  if (!ip || ip.length > 64) return SHARED_VISITOR;
  return ip.includes(":") ? ipv6Prefix(ip) : ip;
}

/// One IPv6 holder typically controls a whole /64, so that's one visitor.
export function ipv6Prefix(ip: string): string {
  const addr = ip.replace(/^\[|\]$/g, "").split("%")[0]!;
  const [head, tail] = addr.split("::") as [string, string | undefined];
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

export function limitsFromEnv(): Limits {
  const n = (v: string | undefined, d: number) => (v && Number.isInteger(Number(v)) && Number(v) >= 0 ? Number(v) : d);
  return { perVisitor: n(process.env.RUN_LIMIT_PER_VISITOR, 3), total: n(process.env.RUN_LIMIT_TOTAL, 30) };
}
