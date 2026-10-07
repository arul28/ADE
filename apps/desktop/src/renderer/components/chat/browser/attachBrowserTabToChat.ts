import type { BuiltInBrowserContextItem, BuiltInBrowserTab } from "../../../../shared/types/builtInBrowser";
import type { AgentChatPaneComposerHandle } from "../AgentChatPane";

type AttachableTab = Pick<BuiltInBrowserTab, "id" | "url" | "title" | "isLaunchpad">;

/**
 * A whole browser tab as one badge in a chat composer.
 *
 * The id is the tab's own, so the composer keeps one badge per tab: attaching
 * the same tab again (after it navigated, or from a second entry point) replaces
 * its badge instead of adding another. The agent gets the tab id, URL and title,
 * which is what it needs to read and drive that tab with `ade browser`.
 *
 * Null for a tab with nothing loaded (a launchpad, a blank tab).
 */
export function browserTabContextItem(tab: AttachableTab): BuiltInBrowserContextItem | null {
  if (tab.isLaunchpad || !tab.url) return null;
  const title = tab.title?.trim() || null;
  const frame = { x: 0, y: 0, width: 0, height: 0 };
  return {
    kind: "built_in_browser_element",
    id: `built-in-browser-tab:${tab.id}`,
    provider: "cdp",
    componentId: "page",
    url: tab.url,
    title,
    sourceFile: null,
    sourceLine: null,
    frame,
    pixelFrame: frame,
    screenshotDataUrl: null,
    selectedAt: new Date().toISOString(),
    metadata: {
      browserContextPacketVersion: 1,
      contextSurface: "built_in_browser",
      label: `Page: ${title ?? tab.url}`,
      url: tab.url,
      title,
      tabId: tab.id,
      selectionExplanation:
        `The user attached this whole browser tab (tab ${tab.id}), not one element. `
        + "It is open in ADE's browser in front of them: read and drive that tab with "
        + "`ade browser` (pass this tab id) so they can watch it happen.",
    },
  };
}

/**
 * Attach a browser tab to a chat composer as a badge. The one entry point for
 * "this tab, in this chat": the Browser tab's "Ask agent" button calls it, and
 * a tab's "Attach to chat" menu item should too. Returns false when the tab has
 * nothing to attach.
 */
export function attachBrowserTabToComposer(
  composer: Pick<AgentChatPaneComposerHandle, "addBuiltInBrowserContext">,
  tab: AttachableTab,
): boolean {
  const item = browserTabContextItem(tab);
  if (!item) return false;
  composer.addBuiltInBrowserContext(item);
  return true;
}
