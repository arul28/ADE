import type { WebContents } from "electron";
import type { Logger } from "../logging/logger";

export function normalizeBrowserUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) throw new Error("Browser URL is required.");
  // "C:\x", "C:/x" and "\\server\share" have no scheme, so they would parse as
  // https://c/x and https://server/share: a silent navigation to a made-up host.
  if (/^[a-zA-Z]:[\\/]/.test(trimmed) || /^\\\\/.test(trimmed) || /^file:\\/i.test(trimmed)) {
    throw new Error("Local file paths are not supported in the ADE browser. Use an http:// or https:// URL.");
  }

  const localhostLike = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::|\/|$)/i.test(trimmed);
  const hasScheme = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed) || /^about:/i.test(trimmed);
  let candidate: string;
  if (localhostLike) {
    candidate = `http://${trimmed}`;
  } else if (hasScheme) {
    candidate = trimmed;
  } else {
    candidate = `https://${trimmed}`;
  }

  const parsed = new URL(candidate);
  if (parsed.protocol === "about:") {
    if (parsed.href === "about:blank") return parsed.href;
    throw new Error("Only about:blank browser navigation is supported.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported browser URL protocol: ${parsed.protocol}`);
  }
  return parsed.href;
}

export function isAllowedNavigationUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === "about:") return parsed.href.startsWith("about:blank");
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** What a log line may say about a URL: its origin, never its path or query. */
export function urlForBrowserLog(value: string): string | null {
  const url = value.trim();
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.origin;
    if (parsed.protocol === "about:") return parsed.href === "about:blank" ? parsed.href : "about:";
    return parsed.protocol;
  } catch {
    return null;
  }
}

/** Chromium's ERR_ABORTED: a load superseded, redirected or turned into a download. */
const NET_ERR_ABORTED = -3;

/**
 * How long a navigation waits for the page to finish loading before it answers
 * with the tab as it is. Under the 60 s IPC budget with room for the approval
 * prompt (15 s) and setup before it.
 */
const BROWSER_LOAD_WAIT_BUDGET_MS = 20_000;

/**
 * The Chromium net error code in a `loadURL` rejection, which Electron words
 * "ERR_ABORTED (-3) loading '…'". Null for anything else (a destroyed tab, a
 * bad argument), so the caller can tell a load failure from a broken call.
 */
function loadErrorCodeOf(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error);
  const match = /^ERR_[A-Z0-9_]+ \((-\d+)\) loading /.exec(message);
  return match ? Number(match[1]) : null;
}

/**
 * Loads a URL in a tab for a caller that wants an answer, not a wait.
 *
 * `loadURL` settles only when the page has finished loading, and rejects for
 * any main-frame load that does not finish, including ones that are not
 * failures. So `load`:
 * - throws for a URL the browser does not open, and for a rejection with no
 *   Chromium net code (a destroyed tab, a bad argument);
 * - returns after `BROWSER_LOAD_WAIT_BUDGET_MS` with the load still running (a
 *   hung resource, a dev server that accepts and never answers). Without this
 *   the caller held on until the 60 s IPC timeout;
 * - returns quietly for ERR_ABORTED (a newer navigation, a redirect, a
 *   download), unless the agent guard caused it (`noteHeldForApproval`): then
 *   the page did not move and the caller is told why;
 * - returns for any other net error (DNS, a refused localhost). The
 *   did-fail-load listener has recorded it on the tab, so the caller reads the
 *   tab's status instead of catching a rejected call.
 *
 * `onLoadSettled` runs whenever the tab's status may have changed under the
 * caller.
 */
export function createUrlLoader(deps: { logger: () => Logger | null; onLoadSettled: () => void }): {
  load: (wc: WebContents, url: string) => Promise<void>;
  /** The agent guard cancelled this tab's navigation to `origin`, pending the user's approval. */
  noteHeldForApproval: (wc: WebContents, origin: string) => void;
} {
  const heldForApproval = new WeakMap<WebContents, string>();
  const load = async (wc: WebContents, url: string): Promise<void> => {
    if (!isAllowedNavigationUrl(url)) {
      throw new Error(`Unsupported browser URL: ${urlForBrowserLog(url) ?? "not a valid URL"}`);
    }
    heldForApproval.delete(wc);
    const loading = wc.loadURL(url);
    let budgetTimer: NodeJS.Timeout | null = null;
    const budgetElapsed = new Promise<"budget">((resolve) => {
      budgetTimer = setTimeout(() => resolve("budget"), BROWSER_LOAD_WAIT_BUDGET_MS);
      budgetTimer.unref?.();
    });
    try {
      const outcome = await Promise.race([loading.then(() => "loaded" as const), budgetElapsed]);
      if (outcome === "budget") {
        deps.logger()?.warn("built_in_browser.load_still_running", {
          origin: urlForBrowserLog(url),
          waitedMs: BROWSER_LOAD_WAIT_BUDGET_MS,
        });
        // The late outcome is the tab's business now; it must not become an
        // unhandled rejection.
        loading.catch(() => undefined).finally(() => deps.onLoadSettled());
        deps.onLoadSettled();
      }
    } catch (error) {
      const errorCode = loadErrorCodeOf(error);
      if (errorCode == null) throw error;
      if (errorCode === NET_ERR_ABORTED) {
        const heldOrigin = heldForApproval.get(wc);
        if (heldOrigin !== undefined) {
          heldForApproval.delete(wc);
          throw new Error(`Navigation to ${heldOrigin} was stopped: it needs your approval before an agent can open it.`);
        }
        deps.logger()?.debug("built_in_browser.load_aborted", { errorCode, origin: urlForBrowserLog(url) });
        return;
      }
      deps.logger()?.warn("built_in_browser.load_failed", { errorCode, origin: urlForBrowserLog(url) });
      deps.onLoadSettled();
    } finally {
      if (budgetTimer) clearTimeout(budgetTimer);
    }
  };
  return { load, noteHeldForApproval: (wc, origin) => { heldForApproval.set(wc, origin); } };
}
