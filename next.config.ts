import type { NextConfig } from "next";

const config: NextConfig = {
  // Don't let `next dev` append its agent-rules block to CLAUDE.md, which is
  // the developer's private, gitignored brief.
  agentRules: false,
};

export default config;
