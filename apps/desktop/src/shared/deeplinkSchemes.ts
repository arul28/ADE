/**
 * The custom link schemes (`daex://`, and `ade://` accepted forever) and the
 * helpers that recognize or rewrite them. Imports only `./brand`, so the
 * preload bundle and other light modules can use it without pulling in the
 * full link parser (`./deeplinks`, which re-exports everything here).
 */
import { BRAND } from "./brand";

/** The scheme every link minted here uses (`BRAND.LINK_SCHEME_FOR_NEW_LINKS`: `daex`). */
export const ADE_DEEPLINK_SCHEME: string = BRAND.LINK_SCHEME_FOR_NEW_LINKS;
/**
 * Every scheme an inbound link may use: `ade://` (accepted forever) and
 * `daex://`. The desktop registers each with the OS; every parser accepts each.
 */
export const ADE_DEEPLINK_SCHEMES: readonly string[] = BRAND.LINK_SCHEMES;
/** Regex source for either scheme name, with no `:` and no flags: `(?:ade|daex)`. */
export const ADE_DEEPLINK_SCHEME_SOURCE = `(?:${ADE_DEEPLINK_SCHEMES.join("|")})`;
/**
 * Regex source for the start of a custom-scheme link (`ade://` or `daex://`),
 * for callers that find links in text. Case-insensitive callers add the `i` flag.
 */
export const ADE_DEEPLINK_URL_PREFIX_SOURCE = `${ADE_DEEPLINK_SCHEME_SOURCE}:\\/\\/`;
const ADE_DEEPLINK_URL_PREFIX_RE = new RegExp(`^${ADE_DEEPLINK_URL_PREFIX_SOURCE}`, "i");

/** True for `ade`, `daex`, `ade:` or `daex:` (a URL's `protocol`), any case. */
export function isAdeDeeplinkScheme(schemeOrProtocol: string | null | undefined): boolean {
  if (typeof schemeOrProtocol !== "string") return false;
  const scheme = schemeOrProtocol.trim().toLowerCase().replace(/:$/, "");
  return ADE_DEEPLINK_SCHEMES.includes(scheme);
}

/** True when the text starts with `ade://` or `daex://` (any case). */
export function hasAdeDeeplinkScheme(rawUrl: string): boolean {
  return ADE_DEEPLINK_URL_PREFIX_RE.test(rawUrl);
}

/**
 * The same custom-scheme link written with {@link ADE_DEEPLINK_SCHEME}, for a
 * link this machine passes on to another (a phone, a notification): an
 * `ade://` link goes out as `daex://`. Any other text is returned as is.
 */
export function withNewLinkScheme(rawUrl: string): string {
  const match = ADE_DEEPLINK_URL_PREFIX_RE.exec(rawUrl);
  return match ? `${ADE_DEEPLINK_SCHEME}://${rawUrl.slice(match[0].length)}` : rawUrl;
}
