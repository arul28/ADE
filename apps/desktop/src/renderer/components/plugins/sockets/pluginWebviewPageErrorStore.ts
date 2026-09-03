import React from "react";

import type { PluginWebviewPageError } from "../../../../shared/plugins/webviewBridge";

/**
 * The last failure each live page reported about itself.
 *
 * ## Why a store rather than a prop
 *
 * The report arrives at the WINDOW — main relays it, because main is what
 * knows which guest sent it — and the card is drawn by the component that put
 * that guest on screen. Those two are nowhere near each other in the tree, and
 * the only thing they share is the `guestKey`. A store keyed on it is the
 * shortest honest path between them.
 *
 * ## Why only the last one
 *
 * A page that throws on every render throws many times. The card says one
 * thing — this page is broken, here is what it said, try again — and a list of
 * forty identical sentences says the same thing worse. The full sequence is
 * kept where it belongs: the plugin's own log, which `ade plugin doctor` reads
 * and counts.
 *
 * Cleared when the reader presses Reload, so a page that comes back healthy
 * stops being described as broken.
 */

type Listener = () => void;

const errors = new Map<string, PluginWebviewPageError>();
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // One subscriber throwing must not strand the others.
    }
  }
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Record one report. Returns false when the guest key is unusable. */
export function recordPluginWebviewPageError(
  guestKey: string,
  error: PluginWebviewPageError,
): boolean {
  if (!guestKey) return false;
  const current = errors.get(guestKey);
  if (current && current.kind === error.kind && current.message === error.message) return true;
  errors.set(guestKey, error);
  emit();
  return true;
}

/** Forget a guest's report — on reload, and when the guest goes away. */
export function clearPluginWebviewPageError(guestKey: string | null): void {
  if (!guestKey) return;
  if (!errors.delete(guestKey)) return;
  emit();
}

export function getPluginWebviewPageError(guestKey: string | null): PluginWebviewPageError | null {
  if (!guestKey) return null;
  return errors.get(guestKey) ?? null;
}

/** Test seam. */
export function resetPluginWebviewPageErrors(): void {
  errors.clear();
  emit();
}

/** Subscribe a page host to its own guest's last report. */
export function usePluginWebviewPageError(guestKey: string | null): PluginWebviewPageError | null {
  return React.useSyncExternalStore(
    subscribe,
    () => getPluginWebviewPageError(guestKey),
  );
}
