// The wire format between the API route and the page. Types only, so the
// browser bundle imports nothing from the server-side pipeline.

import type { BacktestResult, WindowResult } from "./backtest.js";
import type { ComparisonReport, Stage } from "./compare.js";

export type ChartPoint = { date: string; value: number };

/// A ComparisonReport with summary metrics from the backtests, and a weekly
/// value series only for a portfolio of two or more holdings (never the
/// benchmark). No per-holding values or trading calendar (see server/view.ts).
export type ReportView = Omit<ComparisonReport, "backtests" | "window"> & {
  window: Omit<WindowResult, "calendar"> | null;
  backtests: Record<"a" | "b" | "benchmark", Pick<BacktestResult, "metrics"> & { chart: ChartPoint[] | null }> | null;
};

/// What the page shows of a post: sent with the result, never saved. `shown`
/// lists what the model saw besides the text.
export type PostView = {
  text: string;
  author_name: string | null;
  text_verified: boolean;
  /// When the post was fetched from X; null for a saved fixture.
  fetched_at: string | null;
  context: { kind: "parent" | "quoted"; text: string }[];
  shown: { images: number; video_previews: number; links: number; unavailable: ("parent" | "quoted")[] };
};

/// The route streams one JSON object per line (NDJSON): stages as they
/// start, then exactly one `result` or `error`.
export type CompareEvent =
  | { type: "stage"; stage: Stage }
  /// pinned_end: the fixed end date this example ran through, or null when
  /// it ran through the latest prices. swapped: the server put the posts in
  /// the pair's fixed order, the reverse of how they were entered.
  | { type: "result"; report: ReportView; posts: { A: PostView; B: PostView }; pinned_end: string | null; swapped: boolean }
  | { type: "error"; error: string; message: string; side?: "a" | "b" | "both" };
