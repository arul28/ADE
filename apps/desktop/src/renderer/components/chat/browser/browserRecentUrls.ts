import {
  isRedactedBuiltInBrowserQueryParam,
} from "../../../../shared/types/builtInBrowser";
import { isLoopbackHostname } from "../../../../shared/remoteLoopbackUrl";

/**
 * The launchpad's "Recently used" list.
 *
 * A browser that forgets every page the moment its last tab closes makes the
 * empty state a dead end — the local-server group only ever knows about ports
 * this machine is serving right now, which is nothing at all for a staging URL
 * or a PR preview. So the pane keeps the last few pages it actually loaded.
 *
 * Storage is `localStorage` rather than the app store or the browser service:
 * this is a per-window convenience with no agent semantics, nothing else reads
 * it, and a missing or failed read must degrade to "no recents" rather than to
 * a broken pane. Every entry point is total — bad JSON, a quota error and a
 * renderer with no `localStorage` at all are the same answer.
 *
 * Because the store is plaintext and its rows are RENDERED on the empty state,
 * `sanitizeBrowserRecentUrl` below is the gate every write passes: it drops the
 * query and the fragment, refuses anything that carried a credential in either,
 * and refuses the ephemeral loopback ports a remote tunnel forwards through.
 */

export type BrowserRecentUrl = {
  url: string;
  /** The page's own title, when it had one by the time it settled. */
  title: string | null;
  /** Epoch ms, so the newest is first without re-sorting on read. */
  visitedAt: number;
};

/** t3code's `PREVIEW_RECENT_URL_LIMIT`, and for the same reason: a list, not a history. */
export const BROWSER_RECENT_URL_LIMIT = 10;

const STORAGE_PREFIX = "ade.browser.recentUrls";

/**
 * Recents are scoped the way tabs are.
 *
 * A project's browser and the personal-chat browser are separate tab
 * collections, so their histories must not bleed into each other — opening the
 * personal browser should not offer the pages a work lane was looking at.
 */
export function browserRecentUrlsKey(scope: string | null | undefined): string {
  const trimmed = (scope ?? "").trim();
  return trimmed ? `${STORAGE_PREFIX}:${trimmed}` : STORAGE_PREFIX;
}

function readStorage(): Storage | null {
  try {
    return window.localStorage ?? null;
  } catch {
    // A renderer with storage disabled simply has no recents.
    return null;
  }
}

/**
 * Above this, a loopback port was handed out by the OS rather than chosen.
 *
 * A chat pinned to another machine reaches that machine's `localhost:3000`
 * through an ephemeral TCP forward, so the browser really loads something like
 * `http://127.0.0.1:52413`. That origin dies with the transport, and the OS is
 * free to hand the same number to an unrelated local server tomorrow — so
 * remembering it would offer a one-click destination that is, at best, not the
 * page it claims to be. A tunneled tab records the tunnel's remote-origin
 * display URL instead (the panel already shows that URL everywhere); when the
 * mapping is unknown the raw forward origin reaches here and is refused.
 *
 * A dev server the human actually chose — 3000, 5173, 8080 — is well below
 * this, so ordinary local browsing is unaffected.
 */
export const EPHEMERAL_LOOPBACK_PORT_MIN = 32_768;

function carriesCredential(params: URLSearchParams): boolean {
  for (const name of params.keys()) {
    if (isRedactedBuiltInBrowserQueryParam(name)) return true;
  }
  return false;
}

/**
 * The URL this list may keep, or `null` when it may keep nothing.
 *
 * Refuses, in order: anything that is not a navigable http(s) URL; anything
 * whose query OR fragment names a credential parameter (an IdP callback's
 * `?code=`, an implicit-flow `#access_token=`, a magic link's `?token=`); and
 * any loopback URL on an ephemeral port. What survives is stored as
 * `origin + pathname` — the query and the fragment are dropped even when they
 * look innocent, because a list of visited pages does not need them and a
 * per-site parameter this list has never heard of is exactly the one that
 * turns out to be a session id.
 */
export function sanitizeBrowserRecentUrl(value: string | null | undefined): string | null {
  const text = (value ?? "").trim();
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (carriesCredential(url.searchParams)) return null;
  // Implicit-flow tokens live in the fragment, which `searchParams` never sees.
  if (url.hash.length > 1 && carriesCredential(new URLSearchParams(url.hash.slice(1)))) {
    return null;
  }
  if (isLoopbackHostname(url.hostname)) {
    const port = Number(url.port);
    if (Number.isInteger(port) && port >= EPHEMERAL_LOOPBACK_PORT_MIN) return null;
  }
  return `${url.origin}${url.pathname}`;
}

function isRecent(value: unknown): value is BrowserRecentUrl {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.url === "string" && record.url.length > 0;
}

export function parseBrowserRecentUrls(raw: string | null | undefined): BrowserRecentUrl[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const entries: BrowserRecentUrl[] = [];
  for (const value of parsed) {
    if (!isRecent(value) || seen.has(value.url)) continue;
    seen.add(value.url);
    entries.push({
      url: value.url,
      title: typeof value.title === "string" && value.title.trim() ? value.title : null,
      visitedAt: typeof value.visitedAt === "number" && Number.isFinite(value.visitedAt)
        ? value.visitedAt
        : 0,
    });
    if (entries.length >= BROWSER_RECENT_URL_LIMIT) break;
  }
  return entries;
}

/**
 * Put `entry` at the front, de-duplicated by URL and capped.
 *
 * Pure so the cap and the de-duplication can be proven without a DOM: the
 * "reloading the same page ten times fills the list" bug is exactly the kind
 * that only shows up on the tenth reload.
 */
export function withBrowserRecentUrl(
  entries: readonly BrowserRecentUrl[],
  entry: BrowserRecentUrl,
): BrowserRecentUrl[] {
  const rest = entries.filter((item) => item.url !== entry.url);
  return [entry, ...rest].slice(0, BROWSER_RECENT_URL_LIMIT);
}

export function readBrowserRecentUrls(scope: string | null | undefined): BrowserRecentUrl[] {
  const storage = readStorage();
  if (!storage) return [];
  try {
    return parseBrowserRecentUrls(storage.getItem(browserRecentUrlsKey(scope)));
  } catch {
    return [];
  }
}

function writeRecents(scope: string | null | undefined, entries: BrowserRecentUrl[]): void {
  const storage = readStorage();
  if (!storage) return;
  try {
    storage.setItem(browserRecentUrlsKey(scope), JSON.stringify(entries));
  } catch {
    // A full or blocked store still leaves the in-memory list correct for this
    // session, which is the half that the launchpad renders.
  }
}

/**
 * Record a visit and hand back the list the launchpad should now show.
 *
 * A URL `sanitizeBrowserRecentUrl` refuses is not an error: the list is simply
 * returned unchanged, so a sign-in callback leaves no trace and the row before
 * it stays where it was.
 */
export function rememberBrowserRecentUrl(
  scope: string | null | undefined,
  entry: BrowserRecentUrl,
): BrowserRecentUrl[] {
  const current = readBrowserRecentUrls(scope);
  const url = sanitizeBrowserRecentUrl(entry.url);
  if (!url) return current;
  const next = withBrowserRecentUrl(current, { ...entry, url });
  writeRecents(scope, next);
  return next;
}

export function forgetBrowserRecentUrl(
  scope: string | null | undefined,
  url: string,
): BrowserRecentUrl[] {
  const next = readBrowserRecentUrls(scope).filter((entry) => entry.url !== url);
  writeRecents(scope, next);
  return next;
}

/** Drop the whole list for a scope — the group's "Clear" action. */
export function clearBrowserRecentUrls(scope: string | null | undefined): BrowserRecentUrl[] {
  const storage = readStorage();
  if (storage) {
    try {
      storage.removeItem(browserRecentUrlsKey(scope));
    } catch {
      // See `writeRecents`.
    }
  }
  return [];
}
