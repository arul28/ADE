/**
 * One set of rules for "what did the human mean by this string" and "what part
 * of this URL answers *where am I*".
 *
 * These two questions were answered in six places — the link router, the
 * omnibox, the clipboard chip, the tab pill, the URL overlay and the Work tools
 * status line — with regexes copied between them and tails that had quietly
 * drifted apart, so the same tab could read `example.com` in one surface and
 * `www.example.com/x` in another. The predicates live here once and the callers
 * differ only by an option.
 */

/** `mailto:`, `ade://`, `https://` — anything that already names a scheme. */
const SCHEME_RE = /^[a-zA-Z][a-zA-Z\d+.-]*:/;
const HTTP_SCHEME_RE = /^https?:/i;
/** `localhost`, `127.0.0.1` or `[::1]`, with an optional port. */
const LOOPBACK_AUTHORITY_RE = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i;
/** "Something with a dot in it" — enough for a typed omnibox. */
const LOOSE_BARE_HOST_RE = /^[^\s/]+\.[^\s]+/;
/**
 * Dot-separated labels, an optional port, and then a `/` or the end of the
 * string — nothing trailing.
 *
 * Used where the input was not typed at us. Clipboard text is arbitrary, and
 * the loose rule accepts a trailing dot (`release.notes.`) or any junk after
 * the host (`example.com?q=1`) as a hostname worth offering. It is not a TLD
 * check: `v1.2` satisfies both rules.
 */
const STRICT_BARE_HOST_RE = /^[^/\s.]+(\.[^/\s.]+)+(?::\d+)?(?:\/|$)/;

export function hasScheme(value: string): boolean {
  return SCHEME_RE.test(value);
}

export function hasHttpScheme(value: string): boolean {
  return HTTP_SCHEME_RE.test(value);
}

export function isLoopbackAuthority(value: string): boolean {
  return LOOPBACK_AUTHORITY_RE.test(value);
}

export function looksLikeBareHost(value: string, rule: "loose" | "strict" = "loose"): boolean {
  return rule === "strict" ? STRICT_BARE_HOST_RE.test(value) : LOOSE_BARE_HOST_RE.test(value);
}

export type BrowserUrlCompletionOptions = {
  /**
   * What to do with a string that is not a URL at all.
   *
   * `"search"` is the omnibox (type words, get a search), `"passthrough"` is the
   * link router (an `ade://` deeplink must survive untouched for its own
   * handler), and `"none"` is every surface that would rather offer nothing
   * than offer a guess.
   */
  fallback: "search" | "passthrough" | "none";
  /**
   * Which existing schemes count as "already complete". `"http"` lets a
   * `file:`/`ftp:` string fall through to the host rules instead of being
   * handed on as-is.
   */
  scheme?: "any" | "http";
  hostRule?: "loose" | "strict";
};

/**
 * Turn what somebody typed, pasted or clicked into a URL, or null.
 *
 * Loopback completes to `http://` because a dev server is not on TLS, and every
 * other bare host to `https://` because everything else is.
 */
export function completeBrowserUrl(
  input: string | null | undefined,
  options: BrowserUrlCompletionOptions,
): string | null {
  const trimmed = (input ?? "").trim();
  if (!trimmed) return null;
  const schemeRule = options.scheme ?? "any";
  const alreadyComplete = schemeRule === "http" ? hasHttpScheme(trimmed) : hasScheme(trimmed);
  if (alreadyComplete) return trimmed;
  if (isLoopbackAuthority(trimmed)) return `http://${trimmed}`;
  if (looksLikeBareHost(trimmed, options.hostRule)) return `https://${trimmed}`;
  if (options.fallback === "search") {
    return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
  }
  return options.fallback === "passthrough" ? trimmed : null;
}

export type BrowserHostLabelOptions = {
  /** `www.example.com` → `example.com`. On everywhere a human reads the host. */
  stripWww?: boolean;
  /** Append the path, so `/docs` survives into a one-line status. */
  includePath?: boolean;
  /** Return the raw input rather than null when it does not parse. */
  fallbackToRaw?: boolean;
};

/** The host a person would name this page by, or null. */
export function browserHostLabel(
  url: string | null | undefined,
  options: BrowserHostLabelOptions = {},
): string | null {
  const value = (url ?? "").trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    const host = options.stripWww === false ? parsed.host : parsed.host.replace(/^www\./i, "");
    if (!host) return null;
    if (!options.includePath) return host;
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    return `${host}${path}`;
  } catch {
    return options.fallbackToRaw ? value : null;
  }
}

export type BrowserUrlDisplay = {
  /** Emphasised: the part that says which site you are on. */
  host: string;
  /** Dimmed: path, query and hash. Empty for a bare origin. */
  rest: string;
};

/**
 * Split a URL the way Arc and Zen show it — host bright, path faded — so a long
 * URL still answers "where am I?" at a glance in a 300px pane.
 */
export function splitBrowserUrlForDisplay(
  url: string | null | undefined,
): BrowserUrlDisplay | null {
  const value = (url ?? "").trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    const host = parsed.host.replace(/^www\./i, "");
    if (!host) return null;
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    return { host, rest: `${path}${parsed.search}${parsed.hash}` };
  } catch {
    return null;
  }
}

export type BrowserUrlLockKind = "secure" | "insecure" | "none";

/**
 * Which glyph the URL field shows. Loopback is `insecure` like any other http
 * origin — the lock is about the transport, and mislabelling a dev server as
 * safe teaches the wrong reflex on the day it is not loopback.
 */
export function urlLockKind(url: string | null | undefined): BrowserUrlLockKind {
  const value = (url ?? "").trim();
  if (!value) return "none";
  if (/^https:/i.test(value)) return "secure";
  if (/^http:/i.test(value)) return "insecure";
  return "none";
}

/** A clipboard string worth offering as "Paste a link", or null. */
export function clipboardUrlCandidate(text: string | null | undefined): string | null {
  const value = (text ?? "").trim();
  // Clipboard text is arbitrary: a sentence, a diff, a whole file. Reject the
  // obviously-not-a-URL shapes before the host rules ever see them.
  if (!value || /\s/.test(value) || value.length > 2_048) return null;
  const completed = completeBrowserUrl(value, {
    fallback: "none",
    scheme: "http",
    hostRule: "strict",
  });
  if (!completed) return null;
  try {
    return new URL(completed).host ? completed : null;
  } catch {
    return null;
  }
}

/** Origin of a page URL, or null for `about:blank` and non-http schemes. */
export function browserUrlOrigin(value: string | null | undefined): string | null {
  const text = (value ?? "").trim();
  if (!text || text === "about:blank") return null;
  try {
    const parsed = new URL(text);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}
