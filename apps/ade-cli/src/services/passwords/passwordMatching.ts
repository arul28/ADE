/**
 * Passwords: which saved logins belong to the page in front of you.
 *
 * Two sites match when they share a registrable domain: a login saved for
 * `github.com` still fills on `gist.github.com`, and one saved for
 * `accounts.google.com` fills on `google.com`. They never match across
 * domains: `github.com.evil.io`, `githubb.com`, `github.com.br` and a punycode
 * lookalike are different sites. The registrable domain comes from the public
 * suffix list (`tldts`), private suffixes included, so `alice.github.io` never
 * shares a login with `bob.github.io`.
 *
 * An IP address or `localhost` is its own site and also has to agree on the
 * port: two dev servers on one machine are two different logins.
 *
 * Only `https` is a site. An `http://` origin is refused everywhere except
 * `localhost`, `*.localhost`, `127.0.0.1` and `[::1]`, which browsers treat as
 * secure contexts anyway.
 */
import { isLoopbackHost } from "../../../../desktop/src/shared/passwordFillTarget";
import { getDomain } from "tldts";

export type NormalizedLoginOrigin = {
  /** Scheme, host and non-default port, lowercased: `https://login.github.com`. */
  origin: string;
  /** The host without its port, punycoded: `login.github.com`. */
  host: string;
  /** The registrable domain: `github.com`. An IP or `localhost` is its own site. */
  site: string;
};

/** The public suffix list's private section too: `a.github.io` never shares with `b.github.io`. */
const TLD_OPTIONS = { allowPrivateDomains: true } as const;
const SCHEME = /^([a-z][a-z0-9+.-]*):(?:\/\/)?/i;
const BARE_IPV6 = /^(?:[0-9a-f]{0,4}:){2,}[0-9a-f:.]*$/i;
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/**
 * Read one saved URL, pasted host or export entry as a site, or null when it
 * cannot be one. Bare hosts are read as `https`. Default ports are dropped,
 * international names are punycoded, and the port of a local origin is kept
 * because it names the app.
 */
export function normalizeLoginOrigin(input: string): NormalizedLoginOrigin | null {
  if (typeof input !== "string") return null;
  const raw = input.trim();
  if (!raw) return null;
  const urlText = toUrlText(raw);
  if (!urlText) return null;
  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const hostname = url.hostname.toLowerCase();
  const host = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (!host) return null;
  if (url.protocol === "http:" && !isLocalHost(host)) return null;
  return { origin: url.origin, host, site: registrableSite(host) };
}

/**
 * The logins to offer for `pageUrl`, exact host first and then the rest of the
 * page's registrable domain, keeping the caller's order within each group.
 * Items whose origins are unreadable are ignored.
 */
export function matchLoginsForOrigin<T extends { origins: string[] }>(items: T[], pageUrl: string): T[] {
  const page = normalizeLoginOrigin(pageUrl);
  if (!page) return [];
  const ranked: Array<{ item: T; rank: number; index: number }> = [];
  items.forEach((item, index) => {
    let rank = Number.POSITIVE_INFINITY;
    for (const origin of item.origins ?? []) {
      const saved = normalizeLoginOrigin(origin);
      if (!saved || saved.site !== page.site) continue;
      // A local site is one app on one port, not every app on the machine.
      if (isLocalSite(saved.host) && saved.origin !== page.origin) continue;
      rank = Math.min(rank, saved.host === page.host ? 0 : 1);
    }
    if (rank !== Number.POSITIVE_INFINITY) ranked.push({ item, rank, index });
  });
  ranked.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return ranked.map((entry) => entry.item);
}

/** The string handed to `new URL`, with the bare-host and bare-IPv6 forms filled in. */
function toUrlText(raw: string): string | null {
  if (raw.startsWith("//")) return `https:${raw}`;
  if (BARE_IPV6.test(raw)) return `${raw === "::1" ? "http" : "https"}://[${raw}]`;
  const scheme = SCHEME.exec(raw);
  if (!scheme) return `https://${raw}`;
  // "localhost:3000" and "example.com:8443" read as schemes; they are host:port.
  const rest = raw.slice(scheme[0].length);
  if (!scheme[0].endsWith("//") && /^\d+(?:[/?#]|$)/.test(rest)) return `https://${raw}`;
  return raw;
}

function registrableSite(host: string): string {
  return getDomain(host, TLD_OPTIONS) ?? host;
}

const isLocalHost = isLoopbackHost;

/** A local name or an IP address: its port is part of which app it is. */
function isLocalSite(host: string): boolean {
  return isLocalHost(host) || IPV4.test(host) || host.includes(":");
}
