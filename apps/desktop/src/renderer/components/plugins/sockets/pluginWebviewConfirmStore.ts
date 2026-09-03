import { useSyncExternalStore } from "react";

import type { PluginWebviewConfirm } from "../../../../shared/plugins/webviewBridge";

/**
 * The one yes/no question a plugin page may have standing.
 *
 * `ui.confirm` is the only relay verb with no existing host UI behind it. A
 * prompt reuses `pluginPromptStore`, a toast reuses `toastStore`, settings and
 * the composer reuse their own appliers — but ADE has no general confirm
 * dialog, and inventing one inside the prompt store would have given that store
 * two shapes and every reader a discriminator to check.
 *
 * So this is its own store, on the same pattern as the others: a plain function
 * (the relay's IPC callback) has to put something on screen and a host mounted
 * once in `AppShell` draws it.
 *
 * ## The answer is always delivered
 *
 * `settle` is called exactly once, whichever way the question ends — confirmed,
 * cancelled, dismissed with Escape, or replaced by a second question. The page
 * is holding a promise on the other end of it, and main will hold that promise
 * for ten minutes before it times out. A question that could be dismissed
 * without settling would be ten minutes of a page that looks frozen.
 *
 * A replacement settles the outgoing question `false`, which is the reading a
 * reader would give it: they never said yes.
 */
export type PluginWebviewConfirmRequest = {
  /** Bumped on every open, so the host remounts for a second question. */
  token: number;
  pluginId: string;
  /** The plugin's display name, for the attribution line. */
  displayName: string;
  confirm: PluginWebviewConfirm;
  /** Called exactly once with the reader's answer. */
  settle: (confirmed: boolean) => void;
};

let current: PluginWebviewConfirmRequest | null = null;
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

function getSnapshot(): PluginWebviewConfirmRequest | null {
  return current;
}

/** Ask the reader a plugin page's question. Returns the request token. */
export function openPluginWebviewConfirm(
  request: Omit<PluginWebviewConfirmRequest, "token">,
): number {
  const replaced = current;
  const token = nextToken;
  nextToken += 1;
  current = { ...request, token };
  emit();
  // After the swap, so a `settle` that opens something of its own finds the new
  // question already standing rather than being overwritten by this one.
  replaced?.settle(false);
  return token;
}

/**
 * Answer and close. A no-op when nothing is open, and when `token` names a
 * question a newer one has already replaced.
 */
export function settlePluginWebviewConfirm(confirmed: boolean, token?: number): void {
  const request = current;
  if (!request) return;
  if (token !== undefined && request.token !== token) return;
  current = null;
  emit();
  request.settle(confirmed);
}

/** Subscribe a component to the standing question. */
export function usePluginWebviewConfirm(): PluginWebviewConfirmRequest | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** The standing question, for a caller that is not a component. */
export function getPluginWebviewConfirm(): PluginWebviewConfirmRequest | null {
  return current;
}

/** Test seam: cancel and forget whatever is open. */
export function resetPluginWebviewConfirm(): void {
  const request = current;
  current = null;
  nextToken = 1;
  emit();
  request?.settle(false);
}
