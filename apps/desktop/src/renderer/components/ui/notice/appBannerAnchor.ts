import { useLayoutEffect, useState, useSyncExternalStore } from "react";

/**
 * Where app banners draw. The active project's content column registers an
 * anchor at its top, so banners start to the right of the project sidebar and
 * the sidebar stays where it is. With no anchor (welcome, machine pages,
 * standalone Settings) `AppBannerHost` draws in place, across the window under
 * the top bar.
 *
 * Only one project is active at a time. On a project switch React may register
 * the new column before or after it removes the old one, so a removal clears
 * the anchor only while it still holds that column.
 */

let anchor: HTMLElement | null = null;
const listeners = new Set<() => void>();

function setAnchor(next: HTMLElement | null): void {
  if (anchor === next) return;
  anchor = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getAnchor(): HTMLElement | null {
  return anchor;
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
    setAnchor(element);
    return () => {
      if (anchor === element) setAnchor(null);
    };
  }, [active, element]);
  return setElement;
}
