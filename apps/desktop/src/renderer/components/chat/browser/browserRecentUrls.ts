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

/** Record a visit and hand back the list the launchpad should now show. */
export function rememberBrowserRecentUrl(
  scope: string | null | undefined,
  entry: BrowserRecentUrl,
): BrowserRecentUrl[] {
  const next = withBrowserRecentUrl(readBrowserRecentUrls(scope), entry);
  const storage = readStorage();
  if (storage) {
    try {
      storage.setItem(browserRecentUrlsKey(scope), JSON.stringify(next));
    } catch {
      // A full or blocked store still leaves the in-memory list correct for
      // this session, which is the half that the launchpad renders.
    }
  }
  return next;
}

export function forgetBrowserRecentUrl(
  scope: string | null | undefined,
  url: string,
): BrowserRecentUrl[] {
  const next = readBrowserRecentUrls(scope).filter((entry) => entry.url !== url);
  const storage = readStorage();
  if (storage) {
    try {
      storage.setItem(browserRecentUrlsKey(scope), JSON.stringify(next));
    } catch {
      // See `rememberBrowserRecentUrl`.
    }
  }
  return next;
}
