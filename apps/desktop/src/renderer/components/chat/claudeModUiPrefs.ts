import { useSyncExternalStore } from "react";

/** Two choices a person makes about mod UI, kept in this window's storage. */
const PREFIX = "ade.chat.claudeModUi.";
const COLLAPSED = "collapsed";
const OFFER_DISMISSED = "promptDismissed";

// Same "1"/"0" encoding as `shared/persistedFlag`, kept local on purpose: the
// bundler places that helper in the diff viewer's chunk, so importing it here
// made every chat open load the whole diff viewer (~255 KB) for two flags.
function readPersistedFlag(prefix: string, key: string): boolean {
  try {
    return window.localStorage.getItem(`${prefix}${key}`) === "1";
  } catch {
    return false;
  }
}

function writePersistedFlag(prefix: string, key: string, value: boolean): void {
  try {
    window.localStorage.setItem(`${prefix}${key}`, value ? "1" : "0");
  } catch {
    // A blocked storage write is not worth failing the toggle over.
  }
}

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether the mod dock is folded down to its header: one choice for every chat. */
export function useClaudeModUiCollapsed(): boolean {
  return useSyncExternalStore(subscribe, () => readPersistedFlag(PREFIX, COLLAPSED), () => false);
}

export function setClaudeModUiCollapsed(value: boolean): void {
  writePersistedFlag(PREFIX, COLLAPSED, value);
  for (const listener of listeners) listener();
}

/** The offer to turn mod UI on is made once; closing it ends it for good. */
export function isClaudeModsOfferDismissed(): boolean {
  return readPersistedFlag(PREFIX, OFFER_DISMISSED);
}

export function dismissClaudeModsOffer(): void {
  writePersistedFlag(PREFIX, OFFER_DISMISSED, true);
}
