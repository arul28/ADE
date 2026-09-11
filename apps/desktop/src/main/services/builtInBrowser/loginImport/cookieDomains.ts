/**
 * Turning a jar into the picker's domain list, and back into the subset the
 * human selected.
 *
 * The picker exists because "import Chrome" is not a decision anyone can make
 * responsibly: a cookie jar is every identity the person holds. Aggregating to
 * domains first, with counts, is what makes the consent specific.
 *
 * @module loginImport/cookieDomains
 */
import type { BrowserLoginImportDomain } from "../../../../shared/types/builtInBrowserLoginImport";
import { bareHost, isExpired, type ImportedCookie } from "./cookieDatabase";

/** The host a cookie is listed under in the picker. */
export function displayDomain(cookie: ImportedCookie): string {
  if (cookie.domain) return bareHost(cookie.domain);
  try {
    return new URL(cookie.url).hostname;
  } catch {
    return bareHost(cookie.url);
  }
}

/**
 * Groups a jar by host, counting what would be imported and what would not.
 *
 * Already-expired cookies are counted separately and never offered: importing
 * one writes a row Chromium deletes on the next sweep, and inflating the count
 * with them would make the picker lie about what the human is getting.
 */
export function aggregateCookieDomains(
  cookies: readonly ImportedCookie[],
  nowSeconds: number,
): BrowserLoginImportDomain[] {
  const byDomain = new Map<string, BrowserLoginImportDomain>();
  for (const cookie of cookies) {
    const domain = displayDomain(cookie);
    if (!domain) continue;
    const entry = byDomain.get(domain)
      ?? { domain, cookieCount: 0, expiredCount: 0, sessionCookieCount: 0 };
    if (isExpired(cookie, nowSeconds)) {
      entry.expiredCount += 1;
    } else {
      entry.cookieCount += 1;
      if (cookie.expirationDate === undefined) entry.sessionCookieCount += 1;
    }
    byDomain.set(domain, entry);
  }
  return [...byDomain.values()]
    // Most cookies first — the sites the person is actually signed into — then
    // alphabetically so the list is stable between reads.
    .sort((left, right) =>
      right.cookieCount - left.cookieCount || left.domain.localeCompare(right.domain));
}

/**
 * The cookies a selection covers: not expired, and on one of the chosen hosts.
 *
 * Selection matches the picker's own labels exactly. It is deliberately not a
 * suffix match: choosing `example.com` must not silently drag in
 * `login.example.com`, which the person did not tick.
 */
export function selectCookiesForDomains(
  cookies: readonly ImportedCookie[],
  domains: readonly string[],
  nowSeconds: number,
): ImportedCookie[] {
  const wanted = new Set(domains.map((domain) => domain.trim().toLowerCase()).filter(Boolean));
  if (wanted.size === 0) return [];
  return cookies.filter(
    (cookie) => !isExpired(cookie, nowSeconds) && wanted.has(displayDomain(cookie).toLowerCase()),
  );
}
