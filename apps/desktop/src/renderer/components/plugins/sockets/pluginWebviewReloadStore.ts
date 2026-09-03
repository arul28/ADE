import { useSyncExternalStore } from "react";

import type { PluginWebviewReloadEvent } from "../../../../shared/plugins/webviewBridge";

/**
 * The bytes each plugin's pages are currently loading, as `version:revision`.
 *
 * Main sends {@link PluginWebviewReloadEvent} to every window when a plugin's
 * install directory moves. The renderer's job is to make every guest of that
 * plugin load again — and, per the bridge contract, by RECREATING the element
 * rather than calling `reload()` on it: the point is a fresh origin load of the
 * new files, and a `reload()` re-runs whatever the guest already fetched.
 *
 * The mechanism is a key. `PluginWebviewHost` folds this string into the effect
 * that builds its guest, so a new value tears the old element down and puts a
 * new one up, wherever that guest happens to be drawn — the tab, a pane, the
 * overlay, a popover — without any of those hosts knowing a reload happened.
 *
 * `revision` is why `version` alone is not the key: `ade plugin dev` re-copies
 * a source tree over the installed one without moving the version, and a dev
 * loop that does not repaint the page is the whole reason a plugin author
 * reaches for Try again.
 */

const keys = new Map<string, string>();
const listeners = new Set<() => void>();

/**
 * The key for a plugin whose bytes have not moved in this app run.
 *
 * A constant rather than the plugin's installed version. Nothing has changed
 * yet, so any stable string does the job, and reading the version here would
 * mean the host had two sources for the same fact.
 */
const INITIAL_KEY = "initial";

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Record a reload. Returns the new key, which is what every guest re-keys on. */
export function applyPluginWebviewReload(event: PluginWebviewReloadEvent): string {
  const key = `${event.version}:${event.revision}`;
  if (keys.get(event.pluginId) === key) return key;
  keys.set(event.pluginId, key);
  emit();
  return key;
}

/** The current key for one plugin. `INITIAL_KEY` until its bytes first move. */
export function pluginWebviewReloadKey(pluginId: string): string {
  return keys.get(pluginId) ?? INITIAL_KEY;
}

/**
 * Subscribe a guest to its plugin's reload key.
 *
 * The whole map is the subscription and one plugin's key is the snapshot, which
 * is deliberate: reloads are rare, the map is tiny, and per-plugin subscriber
 * sets would be bookkeeping with nothing to show for it. A guest of another
 * plugin re-reads the same string and re-renders nothing.
 */
export function usePluginWebviewReloadKey(pluginId: string): string {
  return useSyncExternalStore(
    subscribe,
    () => pluginWebviewReloadKey(pluginId),
    () => INITIAL_KEY,
  );
}

/** Test seam: forget every recorded reload. */
export function resetPluginWebviewReloads(): void {
  keys.clear();
  emit();
}
