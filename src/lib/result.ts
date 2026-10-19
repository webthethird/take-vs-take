export type Result<T, E extends string> =
  | { ok: true; value: T }
  | { ok: false; error: E; message: string };

export function err<E extends string>(error: E, message: string): { ok: false; error: E; message: string } {
  return { ok: false, error, message };
}
