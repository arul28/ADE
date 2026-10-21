import { fixedFrameOf, fixedRect, fixedViewport } from "../../../lib/webZoom";
import { ONBOARDING_ANCHOR_ATTR } from "../../../onboarding/onboardingProgress";

/**
 * Geometry the onboarding overlays share (the guided tour and the contextual
 * hints): finding a marked control that is really on screen, reading its box
 * in the overlay's own pixels, and placing a card beside it.
 */

export type Box = { left: number; top: number; width: number; height: number };
export type Frame = Box & { vw: number; vh: number };

export const VIEWPORT_MARGIN = 8;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function hasOpenModal(): boolean {
  return document.querySelector('[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]') != null;
}

/** On screen, not zero-sized, and not clipped or covered: its centre hit-tests to itself. */
export function isAnchorVisible(node: HTMLElement): boolean {
  const rect = node.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return false;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= vw || rect.top >= vh) return false;
  const hit = document.elementFromPoint(
    clamp(rect.left + rect.width / 2, 1, vw - 1),
    clamp(rect.top + rect.height / 2, 1, vh - 1),
  );
  if (!hit) return false;
  return node === hit || node.contains(hit) || hit.closest("[data-onboarding-hint-layer]") != null;
}

/** The first on-screen control marked with `id`. */
export function findVisibleAnchor(id: string): HTMLElement | null {
  for (const node of document.querySelectorAll<HTMLElement>(`[${ONBOARDING_ANCHOR_ATTR}="${id}"]`)) {
    if (isAnchorVisible(node)) return node;
  }
  return null;
}

/** Laid out with a size: not inside a hidden tab, a collapsed pane or `display: none`. */
export function hasBox(node: Element): boolean {
  const rect = node.getBoundingClientRect();
  return rect.width >= 1 && rect.height >= 1;
}

/** Whether a control marked `id` is laid out anywhere on the page (hidden tabs stay mounted at zero size). */
export function anchorShown(id: string): boolean {
  for (const node of document.querySelectorAll(`[${ONBOARDING_ANCHOR_ATTR}="${id}"]`)) {
    if (hasBox(node)) return true;
  }
  return false;
}

/** Whether `node` lies outside the window or outside a scrolling or clipping ancestor. */
function isClippedAway(node: HTMLElement): boolean {
  const rect = node.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return true;
  for (let parent = node.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
    const style = window.getComputedStyle(parent);
    if (style.overflowX === "visible" && style.overflowY === "visible") continue;
    const box = parent.getBoundingClientRect();
    if (x < box.left || x > box.right || y < box.top || y > box.bottom) return true;
  }
  return false;
}

/**
 * A control marked with one of `ids` that is on this page, laid out and not
 * hidden, yet out of view: past the window's edge, or clipped by a scrolling
 * row (a tab bar too narrow for its tabs). Covered controls do not count: a
 * page behind another one is not "out of view", it is elsewhere.
 */
export function findOutOfViewAnchor(ids: readonly string[]): HTMLElement | null {
  for (const id of ids) {
    for (const node of document.querySelectorAll<HTMLElement>(`[${ONBOARDING_ANCHOR_ATTR}="${id}"]`)) {
      if (!hasBox(node)) continue;
      if (typeof node.checkVisibility === "function" && !node.checkVisibility({ visibilityProperty: true })) continue;
      if (isClippedAway(node)) return node;
    }
  }
  return null;
}

/**
 * The box a ring goes around. Usually the anchor's own; an anchor marked
 * `data-onboarding-anchor-fit="content"` (a row that stretches past its
 * controls) uses the union of its visible children instead.
 */
function anchorRect(anchor: HTMLElement): DOMRect {
  const own = anchor.getBoundingClientRect();
  if (anchor.getAttribute("data-onboarding-anchor-fit") !== "content") return own;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const child of Array.from(anchor.children)) {
    const rect = child.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;
    left = Math.min(left, rect.left);
    top = Math.min(top, rect.top);
    right = Math.max(right, Math.min(rect.right, own.right));
    bottom = Math.max(bottom, rect.bottom);
  }
  if (!Number.isFinite(left)) return own;
  return new DOMRect(left, top, right - left, bottom - top);
}

/**
 * The anchor's box in the overlay's own style pixels. The hosted web client
 * zooms <body>, so a screen rect is mapped into that space; in Electron the
 * frame is the identity.
 */
export function readFrame(anchor: HTMLElement): Frame {
  const frame = fixedFrameOf(null);
  const rect = fixedRect(frame, anchorRect(anchor));
  const viewport = fixedViewport(frame);
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    vw: viewport.width,
    vh: viewport.height,
  };
}

export function sameFrame(a: Frame, b: Frame): boolean {
  return a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height && a.vw === b.vw && a.vh === b.vh;
}

/** The anchor's own corner radius, so a ring is rounded like the control. */
export function anchorRadius(anchor: HTMLElement): number {
  const parsed = Number.parseFloat(window.getComputedStyle(anchor).borderTopLeftRadius);
  return Number.isFinite(parsed) ? parsed : 6;
}

export function prefersReducedMotion(): boolean {
  if (document.documentElement.dataset.motion === "reduced") return true;
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export type CardSide = "above" | "below" | "right" | "left";

/**
 * Where a card of `width` × `height` goes beside `ring`: the first side in
 * `order` it fits on, clamped inside the window. A card above or below a
 * small control centres on it; above or below a wide one starts at its left
 * edge.
 */
export function placeCard(
  ring: Box,
  size: { width: number; height: number },
  viewport: { vw: number; vh: number },
  order: readonly CardSide[],
  gap: number,
): { x: number; y: number; side: CardSide } {
  const { width: w, height: h } = size;
  const { vw, vh } = viewport;
  const right = ring.left + ring.width;
  const bottom = ring.top + ring.height;
  const alignX = ring.width > w ? ring.left : ring.left + ring.width / 2 - w / 2;
  const alignY = ring.top + ring.height / 2 - h / 2;
  const sides: Record<CardSide, { x: number; y: number; fits: boolean }> = {
    right: { x: right + gap, y: alignY, fits: right + gap + w <= vw - VIEWPORT_MARGIN },
    below: { x: alignX, y: bottom + gap, fits: bottom + gap + h <= vh - VIEWPORT_MARGIN },
    left: { x: ring.left - gap - w, y: alignY, fits: ring.left - gap - w >= VIEWPORT_MARGIN },
    above: { x: alignX, y: ring.top - gap - h, fits: ring.top - gap - h >= VIEWPORT_MARGIN },
  };
  const side = order.find((candidate) => sides[candidate].fits) ?? order[0]!;
  const pick = sides[side];
  return {
    x: clamp(pick.x, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, vw - w - VIEWPORT_MARGIN)),
    y: clamp(pick.y, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, vh - h - VIEWPORT_MARGIN)),
    side,
  };
}

export function translate(x: number, y: number): string {
  return `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
}
