/** A successful account-store result or a typed write outcome. */
export type AccountStoreResult<T> =
  | { ok: true; value: T }
  | { ok: false; unavailable: true; message: string }
  | { ok: false; rejected: true; message: string };
