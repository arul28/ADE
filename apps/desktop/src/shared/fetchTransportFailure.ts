/**
 * Reading a `fetch()` that never got an HTTP answer.
 *
 * undici rejects every transport failure with the same `TypeError: fetch
 * failed` and keeps the reason (`ECONNRESET`, `ENOTFOUND`, a TLS handshake cut
 * short, `UND_ERR_CONNECT_TIMEOUT`) only in its `cause` chain. That chain does
 * not survive JSON-RPC or Electron IPC, so a caller that rethrows the raw error
 * hands the user, and the logs, nothing but "fetch failed". These helpers pull
 * the reason out while the chain is still attached, so the boundary can say
 * which network failure it was.
 */

import { isErrnoLikeCode } from "./codedError";

const MAX_CAUSE_DEPTH = 8;

/** An errno or Node code (see `isErrnoLikeCode`), or one of undici's own `UND_ERR_*`. */
function codeOf(value: object): string | null {
  const code = (value as { code?: unknown }).code;
  if (typeof code !== "string") return null;
  const trimmed = code.trim();
  return isErrnoLikeCode(trimmed) || /^UND_ERR_[A-Z0-9_]+$/.test(trimmed) ? trimmed : null;
}

/**
 * The first transport code anywhere under `error` (itself, its `cause` chain,
 * and an AggregateError's members), or null. Bounded, so a cyclic or huge chain
 * cannot loop.
 */
export function fetchTransportFailureCode(error: unknown): string | null {
  const seen = new Set<unknown>();
  const pending: unknown[] = [error];
  while (pending.length > 0 && seen.size < MAX_CAUSE_DEPTH) {
    const next = pending.shift();
    if (!next || typeof next !== "object" || seen.has(next)) continue;
    seen.add(next);
    const code = codeOf(next);
    if (code) return code;
    pending.push((next as { cause?: unknown }).cause);
    const errors = (next as { errors?: unknown }).errors;
    if (Array.isArray(errors)) pending.push(...errors.slice(0, MAX_CAUSE_DEPTH));
  }
  return null;
}

/**
 * Whether `error` is a request that never reached an HTTP answer: undici's
 * `fetch failed`, or anything whose chain carries a transport code. Aborts and
 * timeouts are the caller's own decision and are not included; callers that
 * set a deadline know when it fired.
 */
export function isFetchTransportFailure(error: unknown): boolean {
  if (error instanceof TypeError && error.message === "fetch failed") return true;
  return fetchTransportFailureCode(error) !== null;
}
