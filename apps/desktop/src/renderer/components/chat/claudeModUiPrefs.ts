import { useSyncExternalStore } from "react";
import { readPersistedFlag, writePersistedFlag } from "../shared/persistedFlag";

/** Two choices a person makes about mod UI, kept in this window's storage. */
const PREFIX = "ade.chat.claudeModUi.";
const COLLAPSED = "collapsed";
const OFFER_DISMISSED = "promptDismissed";

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
