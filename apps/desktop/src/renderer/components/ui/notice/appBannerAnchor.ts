import { useLayoutEffect, useState, useSyncExternalStore } from "react";

/**
 * Where app banners draw. With a project open, the active project's content
 * column registers an anchor at its top, so banners start to the right of the
 * project sidebar and the sidebar stays where it is. With no anchor (welcome,
 * machine pages, standalone Settings) `AppBannerHost` draws in place, across
 * the window under the top bar.
 *
 * Anchors stack: the newest registration wins, and removing it falls back to
 * the one before. A project switch registers the new column and removes the
 * old one in the same commit, whichever React runs first.
 */

let anchors: HTMLElement[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function registerAppBannerAnchor(element: HTMLElement): () => void {
  anchors = [...anchors.filter((entry) => entry !== element), element];
  emit();
  return () => {
    const next = anchors.filter((entry) => entry !== element);
    if (next.length === anchors.length) return;
    anchors = next;
    emit();
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getAnchor(): HTMLElement | null {
  return anchors[anchors.length - 1] ?? null;
}

/** The element app banners portal into, or null to draw in place. */
export function useAppBannerAnchor(): HTMLElement | null {
  return useSyncExternalStore(subscribe, getAnchor, () => null);
}

/** Ref callback for a banner anchor; it registers only while `active`. */
export function useAppBannerAnchorRef(active: boolean): (element: HTMLElement | null) => void {
  const [element, setElement] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!active || !element) return;
    return registerAppBannerAnchor(element);
  }, [active, element]);
  return setElement;
}
