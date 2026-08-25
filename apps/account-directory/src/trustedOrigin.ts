/**
 * What this Worker will accept as a trusted origin, decided once.
 *
 * Three call sites had grown their own near-identical copy of this: the push
 * relay base URL, the hosted web client's CORS origin, and the diagnostics
 * route's "is this a drive-by browser upload" exemption. They agreed by
 * coincidence, not by construction, and the next edit to any one of them would
 * have made a request trusted on one route and refused on another.
 */

/**
 * The three spellings of "this machine".
 *
 * `URL.hostname` keeps the brackets on an IPv6 literal, so `[::1]` is the form
 * that actually shows up here — not `::1`.
 */
export function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

export type TrustedHttpsOriginOptions = {
  /**
   * Require the caller to have written a bare origin and nothing else.
   *
   * A CORS allow-list is compared against `Origin`, which is always bare, so a
   * configured value carrying a path is a misconfiguration worth refusing
   * rather than silently truncating. A base URL that gets a path appended to it
   * is not: there the origin is what the caller meant, whatever else it wrote.
   */
  requireExactOrigin?: boolean;
};

/**
 * The origin of `raw`, or null when `raw` is not something to trust.
 *
 * HTTPS only, with one exception: loopback over plain HTTP, because a local
 * `wrangler dev` run has no certificate and refusing it would mean the
 * development path could never exercise these routes at all.
 *
 * Credentials, a query, and a fragment are all refused outright rather than
 * dropped. Each of them means the configured value is not the thing the author
 * thought it was, and a Worker that quietly discards half of a setting is how a
 * deployment ends up trusting an origin nobody chose.
 */
export function trustedHttpsOrigin(
  raw: string | null | undefined,
  options: TrustedHttpsOriginOptions = {},
): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    const loopback = isLoopbackHostname(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    if (options.requireExactOrigin && url.origin !== trimmed) return null;
    return url.origin;
  } catch {
    return null;
  }
}
