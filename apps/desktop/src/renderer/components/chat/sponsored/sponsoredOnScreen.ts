import { useSyncExternalStore } from "react";

/**
 * At most one sponsored card on screen (Gravity's rule, and ours): the first
 * chat pane that has one to show holds the place; every other pane shows
 * none until it lets go. The prompt box reads it too, so no ADE upgrade
 * button stands beside a sponsored card.
 */

let holder: string | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Takes the one place for `slotId`; true when it holds it. */
export function holdSponsoredPlace(slotId: string): boolean {
  if (holder === slotId) return true;
  if (holder !== null) return false;
  holder = slotId;
  emit();
  return true;
}

export function releaseSponsoredPlace(slotId: string): void {
  if (holder !== slotId) return;
  holder = null;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Who holds the place now (null: no sponsored card on screen). */
export function useSponsoredPlaceHolder(): string | null {
  return useSyncExternalStore(subscribe, () => holder, () => null);
}

/** Whether a sponsored card is on screen anywhere in this window. */
export function useSponsoredCardOnScreen(): boolean {
  return useSponsoredPlaceHolder() !== null;
}
