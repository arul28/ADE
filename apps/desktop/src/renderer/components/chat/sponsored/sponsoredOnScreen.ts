import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * At most one sponsored card on screen (Gravity's rule, and ours): the first
 * card on screen, an ad under a reply or an agent's Sponsored pick, holds the
 * place; every other one shows none, or folds, until it lets go. The prompt
 * box reads it too, so no ADE upgrade button stands beside a sponsored card.
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

/** Whether `ref`'s element has at least `threshold` of itself on screen. */
export function useOnScreen(ref: React.RefObject<HTMLElement | null>, threshold: number, active: boolean): boolean {
  const [onScreen, setOnScreen] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!active || !element || typeof IntersectionObserver === "undefined") {
      setOnScreen(false);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (entry) setOnScreen(entry.isIntersecting && entry.intersectionRatio >= threshold);
      },
      { threshold: [0, threshold] },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, threshold, active]);
  return onScreen;
}
