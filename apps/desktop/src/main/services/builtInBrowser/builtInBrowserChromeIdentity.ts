/**
 * The ADE browser introduces itself to sites the way Chrome does.
 *
 * Electron's default User-Agent names the app and Electron
 * (`… ade-desktop/1.2.3 Chrome/152… Electron/44… Safari/537.36`), and because
 * the embedder overrides the UA, Chromium also stops sending the UA client
 * hints (`Sec-CH-UA*`) that every real Chrome sends on a secure request. Sites
 * that sniff for an embedded browser read either signal as "not a supported
 * browser": Google's account pages send you to `/not-supported`, Teams to its
 * error page. One clean identity for the whole profile fixes every such site
 * at once, instead of a per-site list that only grew after each report.
 *
 * The page sees the same identity from JavaScript: `browserMedia.ts` (the tab
 * preload) adds the Google Chrome brand to `navigator.userAgentData`, so the
 * header and the script never disagree — a mismatch between the two is itself
 * an automation tell.
 *
 * ADE's own app window keeps its own UA; only browser-tab sessions get this.
 */

/** Chromium 152's GREASE brand, as its `navigator.userAgentData.brands` reports it. */
const CHROMIUM_GREASE_BRAND = "Not?A_Brand";

/** Strip every token Chrome would not send: Electron's and the app's own name. */
export function chromeUserAgent(userAgent: string): string {
  return userAgent
    .replace(/ Electron\/\S+/g, "")
    // Electron inserts `<app name>/<version>` between the engine and `Chrome/`.
    .replace(/(\(KHTML, like Gecko\))((?: [^\s()/]+\/[^\s()]+)+?)(?= Chrome\/)/, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** The Chromium build this Electron ships, e.g. "152.0.7977.169". */
export function chromiumFullVersion(): string {
  return typeof process.versions.chrome === "string" && process.versions.chrome
    ? process.versions.chrome
    : "0.0.0.0";
}

/** `Sec-CH-UA-Platform` for this OS, quoted as Chrome sends it. */
export function clientHintPlatform(platform: NodeJS.Platform = process.platform): string {
  if (platform === "darwin") return "\"macOS\"";
  if (platform === "win32") return "\"Windows\"";
  if (platform === "linux") return "\"Linux\"";
  return "\"Unknown\"";
}

/**
 * The brand list Chrome sends, in Chrome's order: the GREASE brand, then
 * Chromium, then Google Chrome. `fullVersion` decides whether entries carry the
 * major version (`Sec-CH-UA`) or the full one (`…-Full-Version-List`).
 */
export function chromeBrandHeader(version: string, fullVersion = false): string {
  const value = fullVersion ? version : version.split(".")[0] ?? version;
  const grease = fullVersion ? "24.0.0.0" : "24";
  // The GREASE brand is spelled exactly as this Chromium spells it in
  // `navigator.userAgentData`, so the header and the script agree.
  return `"${CHROMIUM_GREASE_BRAND}";v="${grease}", "Chromium";v="${value}", "Google Chrome";v="${value}"`;
}

/** Hints only go to secure contexts, as in Chrome. */
function isSecureContextUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" || parsed.protocol === "wss:") return true;
    if (parsed.protocol !== "http:" && parsed.protocol !== "ws:") return false;
    const host = parsed.hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

function headerName(headers: Record<string, string>, lower: string): string | undefined {
  return Object.keys(headers).find((key) => key.toLowerCase() === lower);
}

/**
 * One request's headers, rewritten to Chrome's identity.
 *
 * - The UA loses any Electron or app token (a CDP device preset sets its own
 *   UA and is left alone, because it already carries no such token). A
 *   request whose UA is not Chrome's at all (a Safari device preset) is not
 *   touched.
 * - A Sec-CH-UA that is present gains the Google Chrome brand; one that is
 *   missing on a secure request is added with the low-entropy trio Chrome
 *   always sends (`Sec-CH-UA`, `-Mobile`, `-Platform`). A mobile device preset
 *   sends its own hints through CDP and is not touched.
 *
 * Returns null when nothing changed, so the caller can pass the request
 * through without copying its headers.
 */
export function withChromeIdentityHeaders(
  requestHeaders: Record<string, string>,
  url: string,
  options: { version?: string; platform?: NodeJS.Platform } = {},
): Record<string, string> | null {
  const version = options.version ?? chromiumFullVersion();
  let next: Record<string, string> | null = null;
  const edit = () => (next ??= { ...requestHeaders });

  const uaKey = headerName(requestHeaders, "user-agent");
  // A device preset that is not Chrome (the iPhone and iPad ones are Safari)
  // sends its own identity through CDP, with no Chrome hints on purpose:
  // adding Chrome's brand would contradict it.
  if (uaKey && !/ Chrome\//.test(requestHeaders[uaKey]!)) return null;
  if (uaKey) {
    const cleaned = chromeUserAgent(requestHeaders[uaKey]!);
    if (cleaned !== requestHeaders[uaKey]) edit()[uaKey] = cleaned;
  }

  const hintKey = headerName(requestHeaders, "sec-ch-ua");
  if (hintKey) {
    const current = requestHeaders[hintKey]!;
    if (!/"Google Chrome"/.test(current)) edit()[hintKey] = chromeBrandHeader(version);
    const fullKey = headerName(requestHeaders, "sec-ch-ua-full-version-list");
    if (fullKey && !/"Google Chrome"/.test(requestHeaders[fullKey]!)) {
      edit()[fullKey] = chromeBrandHeader(version, true);
    }
  } else if (isSecureContextUrl(url)) {
    const target = edit();
    target["sec-ch-ua"] = chromeBrandHeader(version);
    if (!headerName(requestHeaders, "sec-ch-ua-mobile")) target["sec-ch-ua-mobile"] = "?0";
    if (!headerName(requestHeaders, "sec-ch-ua-platform")) {
      target["sec-ch-ua-platform"] = clientHintPlatform(options.platform);
    }
  }
  return next;
}
