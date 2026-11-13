import { useSyncExternalStore } from "react";

/**
 * Where the live browser pages are, so the notice corner can avoid them.
 *
 * A browser page is a native view drawn above the whole renderer, so a card
 * drawn over one either hides behind it or makes the page freeze (the
 * occlusion pass swaps the page for a still frame while anything overlaps it).
 * A card that stays up for minutes then froze the page for minutes. So
 * `ToastViewport` puts the stack in a corner no page covers (`pickNoticeCorner`),
 * or holds it until one is free.
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

/** Where the notice stack goes: a bottom corner of the content area, or held. */
export type NoticeCorner = "right" | "left" | "held";

/**
 * The first bottom corner of the content area that no live browser page
 * covers: the right (where notices always sit), else the left (over the
 * sidebar, when it is open and the browser does not reach it). With both
 * covered (an expanded browser, a collapsed sidebar, the Browser tab) the
 * stack is held until one frees up.
 *
 * `area` is the content area in CSS pixels; `height` is the stack's last
 * measured height (a short card is assumed before one is measured).
 */
export function pickNoticeCorner(
  rects: ReadonlyMap<string, CornerNoticeRect>,
  area: { left: number; right: number; bottom: number; inset: number; width: number; height: number },
): NoticeCorner {
  if (rects.size === 0) return "right";
  const top = area.bottom - area.inset - Math.max(CORNER_MIN_HEIGHT_PX, area.height);
  const bottom = area.bottom - area.inset;
  const right = { left: area.right - area.inset - area.width, right: area.right - area.inset, top, bottom };
  if (!coveredByAny(rects, right)) return "right";
  const left = { left: area.left + area.inset, right: area.left + area.inset + area.width, top, bottom };
  if (!coveredByAny(rects, left)) return "left";
  return "held";
}

/** The corner a stack claims before it is measured: one short card. */
const CORNER_MIN_HEIGHT_PX = 96;

function coveredByAny(rects: ReadonlyMap<string, CornerNoticeRect>, box: CornerNoticeRect): boolean {
  for (const rect of rects.values()) {
    if (overlaps(rect, box)) return true;
  }
  return false;
}
