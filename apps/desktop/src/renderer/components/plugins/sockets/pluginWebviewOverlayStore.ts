import { useSyncExternalStore } from "react";

import type { PluginSurfaceContext } from "../../../../shared/plugins/context";

/**
 * The single plugin webview overlay the app may have open.
 *
 * A renderer-only store on the same pattern as `toastStore`, because the one
 * caller — `pluginActionDispatch.ts` — is a plain function, not a component: a
 * plugin button anywhere (a toolbar, a composer, a chat header, a row menu) can
 * finish by asking to open its own `webview` surface as a focused overlay, and
 * that request has to reach a host mounted once in `AppShell` without threading a
 * handle through every button.
 *
 * Single instance on purpose. One renderer process per open guest is the whole
 * reason the webview tier is expensive (`PluginWebviewHost.tsx`), so a second
 * open REPLACES the first rather than stacking — the user summoned a new page,
 * and two full-container overlays fighting for the screen is never what they
 * meant. The overlay is dismissible and fills its frame, so it needs no size
 * protocol and no instance cap beyond this one.
 */

export type PluginWebviewOverlayRequest = {
  /** Bumped on every open, so the host remounts even for the same surface. */
  token: number;
  pluginId: string;
  /** A `webview` surface of that plugin. Resolved to a page by the host. */
  surfaceId: string;
  /**
   * The subject the button sat on — which chat, lane or PR. Host-known and
   * injected into the page unforgeably; null for a surface-only button.
   */
  subject: PluginSurfaceContext | null;
  /** The optional plugin-authored pointer from the `openWebview` verb. */
  pointer?: Record<string, unknown>;
};

let current: PluginWebviewOverlayRequest | null = null;
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

function getSnapshot(): PluginWebviewOverlayRequest | null {
  return current;
}

/**
 * Open (or replace) the plugin webview overlay. Returns the request token.
 *
 * The caller has already checked that `surfaceId` names a real surface of the
 * plugin; the host resolves it to a page or its fallback panel and closes itself
 * if the plugin goes away while it is open.
 */
export function openPluginWebviewOverlay(
  request: Omit<PluginWebviewOverlayRequest, "token">,
): number {
  const token = nextToken;
  nextToken += 1;
  current = { ...request, token };
  emit();
  return token;
}

/** Close the overlay if one is open. A no-op when none is. */
export function closePluginWebviewOverlay(): void {
  if (!current) return;
  current = null;
  emit();
}

/** Subscribe a component to the current overlay request. */
export function usePluginWebviewOverlay(): PluginWebviewOverlayRequest | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
