import { useSyncExternalStore } from "react";

/**
 * Where the live browser pages are, so the bottom-right notices know when one
 * sits under their corner.
 *
 * A browser page is a native view drawn above the whole renderer, so a card
 * drawn in the renderer's corner either hides behind it or makes the page
 * freeze (the occlusion pass swaps the page for a still frame while anything
 * overlaps it). A card that stays up for minutes then froze the page for
 * minutes. When a page covers the corner, `ToastViewport` draws the same cards
 * in the notice layer instead (`noticeLayer.ts`): a small see-through window
 * in the same corner, above the page, so the cards stay where they always are
 * and the page stays live around them.
 *
 * Every browser panel publishes its live page rect here, in CSS pixels, from
 * `useNativeBrowserViewBounds` while the page is meant to be on screen.
 */

export type CornerNoticeRect = { left: number; top: number; right: number; bottom: number };

type Listener = () => void;

let pages: ReadonlyMap<string, CornerNoticeRect> = new Map();
const listeners = new Set<Listener>();

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getPages = () => pages;

function rectsEqual(a: CornerNoticeRect | undefined, b: CornerNoticeRect | null): boolean {
  if (!a || !b) return !a && !b;
  return a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
}

/** A browser panel says where its live page is, or that it has none on screen. */
export function publishBrowserPageRect(pageId: string, rect: CornerNoticeRect | null): void {
  if (rectsEqual(pages.get(pageId), rect)) return;
  const next = new Map(pages);
  if (rect) next.set(pageId, rect);
  else next.delete(pageId);
  pages = next;
  for (const listener of Array.from(listeners)) listener();
}

export function useBrowserPageRects(): ReadonlyMap<string, CornerNoticeRect> {
  return useSyncExternalStore(subscribe, getPages, getPages);
}

function overlaps(a: CornerNoticeRect, b: CornerNoticeRect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/** The page that covers the notice corner, if any. The first one wins. */
export function browserPageCoveringCorner(
  rects: ReadonlyMap<string, CornerNoticeRect>,
  corner: CornerNoticeRect,
): string | null {
  for (const [pageId, rect] of rects) {
    if (overlaps(rect, corner)) return pageId;
  }
  return null;
}
