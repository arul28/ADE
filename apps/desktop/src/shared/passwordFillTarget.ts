/**
 * The one rule for "may Passwords fill (or offer to save) a login on this
 * page?": an https page, or plain http only on this computer's own names
 * (localhost, *.localhost, 127.0.0.1, ::1). No credentials in the URL.
 *
 * The brain's site matcher (`passwordMatching.ts`), the agent's sign-in, the
 * person's key button and "Save to Passwords?" all ask this, so they never
 * disagree about a page.
 */

/** A loopback host name, with or without the brackets `URL` puts around IPv6. */
export function isLoopbackHost(host: string): boolean {
  const bare = host.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  return bare === "localhost" || bare.endsWith(".localhost") || bare === "127.0.0.1" || bare === "::1";
}

/** The page's origin and host when Passwords may act on it, else null. */
export function passwordFillTarget(pageUrl: string): { origin: string; host: string } | null {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) return null;
  return { origin: url.origin, host: url.hostname.toLowerCase() };
}
