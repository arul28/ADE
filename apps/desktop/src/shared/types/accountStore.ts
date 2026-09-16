/** A successful account-store result or an ordinary unavailable answer. */
export type AccountStoreResult<T> =
  | { ok: true; value: T }
  | { ok: false; unavailable: true; message: string };
