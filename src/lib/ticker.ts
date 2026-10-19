/// Canonical ticker spelling. Share classes are written BRK.B, BRK-B or BRK/B
/// depending on the source; all three are one holding. The dash form is also
/// Tiingo's symbol format (verified: BRK-B resolves, BRK.B is 404), so this
/// doubles as the Tiingo mapping.
export function tickerKey(ticker: string): string {
  return ticker.trim().toUpperCase().replace(/[./]/g, "-");
}

/// Share classes of one company, mapped to one key. Small on purpose: only
/// pairs where both classes trade in the US and both commonly appear.
const SAME_COMPANY: Record<string, string> = {
  GOOG: "GOOGL",
  "BRK-A": "BRK-B",
  FOX: "FOXA",
  NWS: "NWSA",
};

/// One key per company, for "is this the same company?" questions.
export function companyKey(ticker: string): string {
  const k = tickerKey(ticker);
  return SAME_COMPANY[k] ?? k;
}
