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

const MAX_CAUSE_DEPTH = 8;

/** errno (`ECONNRESET`), undici (`UND_ERR_SOCKET`) or Node (`ERR_SSL_…`) codes. */
const TRANSPORT_CODE_PATTERN = /^(?:E[A-Z0-9]+|UND_ERR_[A-Z0-9_]+|ERR_[A-Z0-9_]+)$/;
/** Electron's `net` module names the failure in its message: `net::ERR_INTERNET_DISCONNECTED`. */
const CHROMIUM_NET_ERROR_PATTERN = /\bnet::(ERR_[A-Z0-9_]+)\b/;

function codeOf(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const code = (value as { code?: unknown }).code;
  if (typeof code === "string" && TRANSPORT_CODE_PATTERN.test(code.trim())) return code.trim();
  const message = (value as { message?: unknown }).message;
  if (typeof message === "string") {
    const match = CHROMIUM_NET_ERROR_PATTERN.exec(message);
    if (match) return match[1] ?? null;
  }
  return null;
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
