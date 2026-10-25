import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { RunLimiter, SHARED_VISITOR, ipv6Prefix, spendGate, visitorId } from "../src/server/limits.js";

const at = (iso: string) => () => new Date(iso);
const tmp = async () => join(await mkdtemp(join(tmpdir(), "tvt-limits-")), "limits.json");

describe("RunLimiter", () => {
  it("allows a visitor 3 runs in 24 hours, then says when the next one frees up", async () => {
    const path = await tmp();
    let now = "2026-10-25T10:00:00Z";
    const l = new RunLimiter(path, { perVisitor: 3, total: 30 }, () => new Date(now));
    for (const t of ["10:00", "11:00", "12:00"]) {
      now = `2026-10-25T${t}:00Z`;
      assert.equal(await l.take("1.2.3.4"), null);
    }
    assert.deepEqual(await l.take("1.2.3.4"), { scope: "visitor", limit: 3, retry_at: "2026-10-26T10:00:00.000Z" });
    assert.equal(await l.take("5.6.7.8"), null, "another visitor is unaffected");
    now = "2026-10-26T10:00:00Z";
    assert.equal(await l.take("1.2.3.4"), null, "the oldest run has left the window");
  });

  it("caps all visitors combined", async () => {
    const l = new RunLimiter(await tmp(), { perVisitor: 3, total: 2 }, at("2026-10-25T10:00:00Z"));
    assert.equal(await l.take("a"), null);
    assert.equal(await l.take("b"), null);
    assert.equal((await l.take("c"))?.scope, "total");
  });

  it("survives a restart, and stores no addresses", async () => {
    const path = await tmp();
    await new RunLimiter(path, { perVisitor: 1, total: 30 }, at("2026-10-25T10:00:00Z")).take("203.0.113.9");
    const again = new RunLimiter(path, { perVisitor: 1, total: 30 }, at("2026-10-25T11:00:00Z"));
    assert.equal((await again.take("203.0.113.9"))?.scope, "visitor");
    assert.doesNotMatch(await readFile(path, "utf8"), /203\.0\.113\.9/);
  });

  it("a limit of 0 refuses every paid run", async () => {
    const l = new RunLimiter(await tmp(), { perVisitor: 0, total: 30 }, at("2026-10-25T10:00:00Z"));
    assert.deepEqual(await l.take("a"), { scope: "visitor", limit: 0, retry_at: null });
  });
});

describe("spendGate", () => {
  it("charges a run once, on its first billable request", async () => {
    const path = await tmp();
    const l = new RunLimiter(path, { perVisitor: 2, total: 30 }, at("2026-10-25T10:00:00Z"));
    const run1 = spendGate(l, "v");
    assert.equal(await run1.charge(), null);
    assert.equal(await run1.charge(), null);
    assert.equal(await run1.charge(), null);
    assert.equal(await spendGate(l, "v").charge(), null, "second run");
    const run3 = spendGate(l, "v");
    assert.match((await run3.charge()) ?? "", /2 new comparisons a day from your connection.*2026-10-26T10:00:00.000Z/);
    assert.equal(run3.refusal?.scope, "visitor");
    assert.match((await run3.charge()) ?? "", /used up/, "stays refused for the rest of the run");
  });
});

describe("visitorId", () => {
  const h = (o: Record<string, string>) => new Headers(o);
  it("shares one bucket unless a trusted header is configured and present", () => {
    assert.equal(visitorId(h({ "x-real-ip": "1.2.3.4" }), undefined), SHARED_VISITOR, "not configured: headers are ignored");
    assert.equal(visitorId(h({}), "x-real-ip"), SHARED_VISITOR);
    assert.equal(visitorId(h({ "x-real-ip": "1.2.3.4" }), "x-real-ip"), "1.2.3.4");
  });

  it("takes the proxy's own entry from a list, not the client-supplied ones", () => {
    assert.equal(visitorId(h({ "x-forwarded-for": "6.6.6.6, 1.2.3.4" }), "x-forwarded-for"), "1.2.3.4");
  });

  it("treats an IPv6 /64 as one visitor", () => {
    assert.equal(visitorId(h({ "x-real-ip": "2001:DB8:0:1::5" }), "x-real-ip"), "2001:db8:0:1::/64");
    assert.equal(ipv6Prefix("2001:db8::1"), "2001:db8:0:0::/64");
    assert.equal(ipv6Prefix("2001:0db8:0000:0001:ffff:0:0:1"), "2001:db8:0:1::/64");
    assert.equal(ipv6Prefix("::1"), "0:0:0:0::/64");
    assert.equal(ipv6Prefix("[2001:db8:1:2::9]"), "2001:db8:1:2::/64");
  });
});
