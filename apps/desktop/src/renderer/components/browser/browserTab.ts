import { navigateUrlInAdeBrowser } from "../../lib/openExternal";
import { isWebClientMode } from "../../lib/webClientMode";
import { useAppStore } from "../../state/appStore";

/** The machine-level Browser top tab. Not a project surface. */
export const BROWSER_TAB_ROUTE = "/browser";

/** The keybinding that opens it, with the default it falls back to. */
export const BROWSER_TAB_KEYBINDING = { id: "shell.browser.open", fallback: "Mod+Shift+B" } as const;

export function isBrowserTabRoute(pathname: string): boolean {
  return pathname === BROWSER_TAB_ROUTE || pathname.startsWith(`${BROWSER_TAB_ROUTE}/`);
}

/**
 * The Browser tab needs the desktop's own browser: the hosted web client has
 * no `WebContentsView` to show, so it offers no Browser tab at all.
 */
export function browserTabAvailable(): boolean {
  return !isWebClientMode() && Boolean(window.ade?.builtInBrowser);
}

/**
 * Show `url` in a new tab of the Browser top tab.
 *
 * The Browser tab shows the `personal` tab collection, so the page opens there:
 * the same tabs a project-less chat's agent sees. Failures stay in ADE (no
 * surprise system-browser window); `onFailure` reports them.
 */
export function openUrlInBrowserTab(
  url: string,
  navigate: (path: string) => void,
  onFailure?: () => void,
): void {
  useAppStore.getState().setBrowserTabOpen(true);
  navigate(BROWSER_TAB_ROUTE);
  navigateUrlInAdeBrowser(url, { newTab: true, tabCollection: "personal" }, {
    fallbackToExternal: false,
    onFailure,
  });
}

/**
 * Show a project-less chat beside the browser tab it drives: the Browser tab
 * opens with that chat in its dock, and the tab the chat holds comes to the
 * front. The Chats page uses this for a chat that is browsing, so a chat and
 * its page are one jump apart from either side.
 */
export async function openChatInBrowserTab(
  chatSessionId: string,
  targetKey: string,
  navigate: (path: string) => void,
): Promise<void> {
  const store = useAppStore.getState();
  store.setBrowserTabOpen(true);
  store.setBrowserDock({ open: true, chat: { targetKey, sessionId: chatSessionId } });
  navigate(BROWSER_TAB_ROUTE);
  const api = window.ade?.builtInBrowser;
  if (!api) return;
  const status = await api.getStatus({ tabCollection: "personal" });
  const held = status.tabs.find((tab) => tab.ownerChatSessionId === chatSessionId);
  // A person's switch: it brings the tab forward without touching the lease.
  if (held && held.id !== status.activeTabId) {
    await api.switchTab({ tabCollection: "personal", tabId: held.id });
  }
}

/**
 * Bring one of the Browser tab's own tabs to the front: the Browser top tab
 * opens on it. Now Playing uses this for a tab that is playing media.
 */
export async function showTabInBrowserTab(tabId: string, navigate: (path: string) => void): Promise<void> {
  useAppStore.getState().setBrowserTabOpen(true);
  navigate(BROWSER_TAB_ROUTE);
  await window.ade?.builtInBrowser?.switchTab({ tabCollection: "personal", tabId }).catch(() => undefined);
}
