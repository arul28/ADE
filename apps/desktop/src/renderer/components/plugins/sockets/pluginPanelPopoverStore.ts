import { useSyncExternalStore } from "react";

/**
 * The single plugin panel quick view the app may have anchored on screen.
 *
 * A renderer-only store on the same pattern as `pluginPromptStore` and
 * `pluginWebviewOverlayStore`, and for the same reason: the caller is a plain
 * function. `runPluginSocketAction` is not a component and holds no ref to the
 * button that was pressed, so the request reaches a host mounted once in
 * `AppShell` rather than being threaded through every control that can dispatch
 * an action.
 *
 * ## One at a time, and a second press closes it
 *
 * The cap is not a resource limit — a panel is cheap. It is what makes the
 * control read as a toggle. A top-bar button that opened a second copy of its
 * own quick view on the second press would be a button whose meaning depends on
 * a state the reader cannot see, and stacking two anchored cards over one
 * another has no reading at all.
 *
 * So {@link openPluginPanelPopover} closes rather than reopens when the request
 * names the same origin — the same plugin and the same panel the standing
 * popover was OPENED with. The origin is held separately from the panel on
 * screen because a popover navigates: a reader who followed a row into a
 * detail panel and pressed the button again means "put this away", not "go back
 * to the first panel".
 */

/** Where the control sat when it was pressed, in viewport coordinates. */
export type PluginPanelPopoverAnchor = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PluginPanelPopoverRequest = {
  /** Bumped on every open, so the host remounts for a second quick view. */
  token: number;
  pluginId: string;
  /** The panel drawn right now. Changes as the reader navigates inside. */
  panelId: string;
  /**
   * The panel the press opened, which is what a second press is compared
   * against. Never changes for the life of one popover.
   */
  originPanelId: string;
  /** The render context, from the `{navigate}` that opened or moved it. */
  context: Record<string, unknown> | null;
  /** Null when the press had no locatable control; the card then centres. */
  anchor: PluginPanelPopoverAnchor | null;
};

let current: PluginPanelPopoverRequest | null = null;
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

function getSnapshot(): PluginPanelPopoverRequest | null {
  return current;
}

/**
 * Open the quick view, or close the one this press is asking about again.
 *
 * Returns the request token, or `0` when the press toggled a standing popover
 * shut. The caller does nothing with either; the number is there so a test can
 * tell the two outcomes apart without reading the store back.
 */
export function openPluginPanelPopover(request: {
  pluginId: string;
  panelId: string;
  context: Record<string, unknown> | null;
  anchor: PluginPanelPopoverAnchor | null;
}): number {
  if (
    current
    && current.pluginId === request.pluginId
    && current.originPanelId === request.panelId
  ) {
    current = null;
    emit();
    return 0;
  }
  const token = nextToken;
  nextToken += 1;
  current = {
    token,
    pluginId: request.pluginId,
    panelId: request.panelId,
    originPanelId: request.panelId,
    context: request.context,
    anchor: request.anchor,
  };
  emit();
  return token;
}

/**
 * Move the open quick view to another panel of the same plugin.
 *
 * The inside-the-popover half of `{navigate}`: a row that opens a detail panel
 * keeps the reader in the card they opened rather than throwing them out to a
 * tab. A no-op when nothing is open, and when the request names a different
 * plugin — a popover is one plugin's, and a cross-plugin move has no anchor to
 * stay attached to.
 *
 * The token is deliberately NOT bumped: this is the same quick view showing a
 * different page, so the host keeps its mount and its position.
 */
export function navigatePluginPanelPopover(request: {
  pluginId: string;
  panelId: string;
  context: Record<string, unknown> | null;
}): boolean {
  if (!current || current.pluginId !== request.pluginId) return false;
  current = { ...current, panelId: request.panelId, context: request.context };
  emit();
  return true;
}

/** Take the quick view down. A no-op when none is open. */
export function closePluginPanelPopover(token?: number): void {
  if (!current) return;
  if (token !== undefined && current.token !== token) return;
  current = null;
  emit();
}

/** Subscribe a component to the open quick view. */
export function usePluginPanelPopover(): PluginPanelPopoverRequest | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** The open quick view, for a caller that is not a component. */
export function getPluginPanelPopover(): PluginPanelPopoverRequest | null {
  return current;
}
