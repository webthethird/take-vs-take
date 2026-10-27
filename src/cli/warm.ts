// Run every example pair once, so visitors replay them from cache instead
// of paying for them (and using up the run limits) on first click.
//
//   pnpm warm [pair-01 posthoc-01 ...]
//
// Run it on the server after a deploy, after any prompt change, and within
// 30 days of the last run: posts fetched from X, and model calls carrying
// them, are deleted after 30 days. Posts resolve as the web page resolves
// them (POST_SOURCE=x fetches every post from X). Spend is capped by
// LLM_BUDGET_USD; pairs already cached cost nothing.

import { compare } from "../lib/compare.js";
import { preferXFromEnv, realDeps, xFromEnv } from "../server/deps.js";
import { canonicalOrder, pinnedWindowEnd, readCandidates, resolvePosts } from "../server/posts.js";

try {
  process.loadEnvFile(".env");
} catch {
  // realDeps reports what's missing.
}
const only = process.argv.slice(2);
const pairs = (await readCandidates(".")).filter((p) => only.length === 0 || only.includes(p.id));
if (only.length && pairs.length !== only.length) throw new Error(`Unknown pair id in: ${only.join(", ")}`);
const preferX = preferXFromEnv();
console.log(`${pairs.length} pairs; posts from ${preferX ? "X" : "saved fixtures, else X"}.`);

let total = 0;
let failed = 0;
for (const pair of pairs) {
  const posts = await resolvePosts(pair.a_url, pair.b_url, ".", xFromEnv(), { preferX });
  if (!posts.ok) {
    failed++;
    console.log(`${pair.id}: posts unavailable (${posts.error}, side ${posts.side}): ${posts.message}`);
    continue;
  }
  const { posts: [a, b] } = await canonicalOrder(posts.value[0], posts.value[1]);
  const pin = await pinnedWindowEnd(a.post_id, b.post_id);
  if (!pin.ok) throw new Error(pin.message);
  const { deps } = realDeps(pin.value ? { end: pin.value } : {});
  const r = await compare(deps, a, b);
  if (!r.ok) {
    failed++;
    console.log(`${pair.id}: ${r.error}: ${r.message}`);
    continue;
  }
  total += r.value.llm_cost_usd;
  const holdings = r.value.sides.map((s) => `${s.label} ${s.portfolio ? s.portfolio.positions.map((p) => p.ticker).join(" ") : `(${s.analysis.status})`}`);
  console.log(`${pair.id}: $${r.value.llm_cost_usd.toFixed(4)}  ${holdings.join("  |  ")}`);
}
console.log(`\nModel spend: $${total.toFixed(4)}. ${failed ? `${failed} pair(s) failed.` : "Every pair is now cached."}`);
process.exitCode = failed ? 1 : 0;
