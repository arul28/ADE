/**
 * The size the person's Browser pane settled at, per tab (`lastPanelRect`).
 *
 * The pane reports every frame of its own animation, so keeping each rect kept
 * whatever frame came last: a pane that closes shrinks through a dozen widths
 * on the way to nothing, and the tab was then parked at that last sliver (57 px
 * wide, measured). A rect counts once the tab has stayed on screen at that
 * size for `PANEL_RECT_SETTLE_MS`; a pane that hides, or keeps moving, before
 * then leaves the previous settled size standing.
 */

import type { Rectangle } from "electron";
import type { BrowserTabState } from "./builtInBrowserService";

export const PANEL_RECT_SETTLE_MS = 300;

export function createPanelRectSettler(deps: {
  /** The tab is still the one on screen, at exactly `rect`'s size. */
  isStillShownAt: (tab: BrowserTabState, rect: Rectangle) => boolean;
}) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const cancel = (tabId: string): void => {
    const handle = timers.get(tabId);
    if (handle == null) return;
    clearTimeout(handle);
    timers.delete(tabId);
  };

  /** The pane drew `tab` at `rect`; keep it once the pane stops there. */
  const note = (tab: BrowserTabState, rect: Rectangle): void => {
    cancel(tab.id);
    const settled = tab.lastPanelRect;
    if (settled && settled.width === rect.width && settled.height === rect.height) return;
    const handle = setTimeout(() => {
      timers.delete(tab.id);
      if (!deps.isStillShownAt(tab, rect)) return;
      tab.lastPanelRect = { ...rect };
    }, PANEL_RECT_SETTLE_MS);
    handle.unref?.();
    timers.set(tab.id, handle);
  };

  const dispose = (): void => {
    for (const handle of timers.values()) clearTimeout(handle);
    timers.clear();
  };

  return { note, cancel, dispose };
}
