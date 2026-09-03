import { useSyncExternalStore } from "react";

import type { PluginSurfaceContext } from "../../../../shared/plugins/context";

/**
 * The single anchored plugin page the app may have open — a socket popover or a
 * composer picker.
 *
 * Two placements, one store, because they are the same object wearing different
 * anchors: a card holding one plugin guest, open one at a time, dismissed by
 * Escape, by a click outside, or by the page itself calling `surface.close`.
 * What separates them is where the card points and what finishes it — a popover
 * is read and dismissed, a picker ends when the page attaches something to the
 * composer — and neither of those differences needs a second store.
 *
 * ## One at a time, and why the cap is not negotiable here
 *
 * A guest is a whole renderer process (`PluginWebviewHost.tsx`). The panel
 * popover caps itself at one for a reading reason; this one caps itself at one
 * for that reason AND a resource one, so a second open REPLACES the first
 * rather than stacking. Replacing destroys the outgoing guest, which is the
 * page-tier memory rule: the plugin's state lives in its collections, never in
 * a guest the host is keeping alive off screen.
 *
 * ## A second press of the same control closes
 *
 * Same rule as `pluginPanelPopoverStore`, and for the same reason: a top-bar
 * button whose second press opened a second copy of its own page would be a
 * control whose meaning depends on state the reader cannot see. Compared on the
 * plugin AND the surface, which together are what the press names.
 */

/** Where the control sat when it was pressed, in viewport coordinates. */
export type PluginWebviewPopoverAnchor = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** The two anchored placements. Maps onto `PluginWebviewPlacement`. */
export type PluginWebviewPopoverKind = "popover" | "composer-picker";

export type PluginWebviewPopoverRequest = {
  /** Bumped on every open, so the host remounts even for the same surface. */
  token: number;
  pluginId: string;
  /** A `webview` surface of that plugin. Resolved to a page by the host. */
  surfaceId: string;
  kind: PluginWebviewPopoverKind;
  /**
   * The subject the control sat on — which chat, lane or PR. Host-known and
   * injected into the page unforgeably; null for a surface-only control.
   */
  subject: PluginSurfaceContext | null;
  /** The optional plugin-authored pointer from the `openWebview` verb. */
  pointer?: Record<string, unknown>;
  /** Null when the press had no locatable control; the card then centres. */
  anchor: PluginWebviewPopoverAnchor | null;
};

let current: PluginWebviewPopoverRequest | null = null;
let nextToken = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): PluginWebviewPopoverRequest | null {
  return current;
}

/**
 * Open the anchored page, or close the one this press is asking about again.
 *
 * Returns the request token, or `0` when the press toggled a standing card
 * shut. The caller does nothing with either; the number is there so a test can
 * tell the two outcomes apart without reading the store back.
 */
export function openPluginWebviewPopover(
  request: Omit<PluginWebviewPopoverRequest, "token">,
): number {
  if (
    current
    && current.pluginId === request.pluginId
    && current.surfaceId === request.surfaceId
  ) {
    current = null;
    emit();
    return 0;
  }
  const token = nextToken;
  nextToken += 1;
  current = { ...request, token };
  emit();
  return token;
}

/**
 * Take the card down. A no-op when none is open, and when `token` names a card
 * a newer open has already replaced.
 */
export function closePluginWebviewPopover(token?: number): void {
  if (!current) return;
  if (token !== undefined && current.token !== token) return;
  current = null;
  emit();
}

/** Subscribe a component to the open card. */
export function usePluginWebviewPopover(): PluginWebviewPopoverRequest | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** The open card, for a caller that is not a component. */
export function getPluginWebviewPopover(): PluginWebviewPopoverRequest | null {
  return current;
}

/** Test seam: forget whatever is open. */
export function resetPluginWebviewPopover(): void {
  current = null;
  nextToken = 1;
  emit();
}
