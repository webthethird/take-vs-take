/// Canonical ticker spelling. Share classes are written BRK.B, BRK-B or BRK/B
/// depending on the source; all three are one holding. The dash form is also
/// Tiingo's symbol format (verified: BRK-B resolves, BRK.B is 404), so this
/// doubles as the Tiingo mapping.
export function tickerKey(ticker: string): string {
  return ticker.trim().toUpperCase().replace(/[./]/g, "-");
}
