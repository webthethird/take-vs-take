// Whether a reading counts as built from what the author named. The model's
// author_stated flag alone proved too loose: its definition ("names what to
// own, or clearly implies it") let "battery storage companies" and "copper"
// through, though neither post named a security. So a reading also needs at
// least one ticker the post is positive about (analysis.targets). The flag is
// kept as the model wrote it; this is the rule the pipeline acts on.
//
// A post that only reports news never counts: the companies a headline names
// are the news, not the poster's choice of what to own.

import type { PostVoice, ThesisAnalysis } from "./schema.js";

export function authorNamed(
  analysis: Pick<ThesisAnalysis, "targets">,
  reading: { author_stated: boolean },
  voice?: Pick<PostVoice, "voice"> | null,
): boolean {
  if (voice?.voice === "news_only") return false;
  return reading.author_stated && analysis.targets.some((t) => t.stance === "positive");
}
