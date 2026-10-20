// The wire format between the API route and the page. Types only, so the
// browser bundle imports nothing from the server-side pipeline.

import type { BacktestResult, WindowResult } from "./backtest.js";
import type { ComparisonReport, Stage } from "./compare.js";

/// A ComparisonReport with only summary metrics from the backtests: no daily
/// values, per-holding values or trading calendar (see server/view.ts).
export type ReportView = Omit<ComparisonReport, "backtests" | "window"> & {
  window: Omit<WindowResult, "calendar"> | null;
  backtests: Record<"a" | "b" | "benchmark", Pick<BacktestResult, "metrics">> | null;
};

export type PostView = { text: string; author_name: string | null; text_verified: boolean };

/// The route streams one JSON object per line (NDJSON): stages as they
/// start, then exactly one `result` or `error`.
export type CompareEvent =
  | { type: "stage"; stage: Stage }
  | { type: "result"; report: ReportView; posts: { A: PostView; B: PostView } }
  | { type: "error"; error: string; message: string; side?: "a" | "b" | "both" };
