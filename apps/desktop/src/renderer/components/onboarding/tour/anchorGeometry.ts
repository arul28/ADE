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

/** Laid out and not hidden by `visibility` or a closed `<details>`, though maybe scrolled or clipped away. */
export function isRendered(node: HTMLElement): boolean {
  if (!hasBox(node)) return false;
  return typeof node.checkVisibility !== "function" || node.checkVisibility({ visibilityProperty: true });
}

/** The nearest ancestor of `node` (below `<body>`) that scrolls or clips its content. */
export function clippingAncestor(node: Element): HTMLElement | null {
  for (let parent = node.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
    const style = window.getComputedStyle(parent);
    if (style.overflowX !== "visible" || style.overflowY !== "visible") return parent;
  }
  return null;
}

/** Whether `node` lies outside the window or outside a scrolling or clipping ancestor. */
function isClippedAway(node: HTMLElement): boolean {
  const rect = node.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return true;
  for (let parent = clippingAncestor(node); parent; parent = clippingAncestor(parent)) {
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
      if (isRendered(node) && isClippedAway(node)) return node;
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
 * edge. When no side fits, it takes `order`'s first and says so (`fitted`).
 */
export function placeCard(
  ring: Box,
  size: { width: number; height: number },
  viewport: { vw: number; vh: number },
  order: readonly CardSide[],
  gap: number,
): { x: number; y: number; side: CardSide; fitted: boolean } {
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
  const fitting = order.find((candidate) => sides[candidate].fits);
  const side = fitting ?? order[0]!;
  const pick = sides[side];
  return {
    x: clamp(pick.x, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, vw - w - VIEWPORT_MARGIN)),
    y: clamp(pick.y, VIEWPORT_MARGIN, Math.max(VIEWPORT_MARGIN, vh - h - VIEWPORT_MARGIN)),
    side,
    fitted: fitting != null,
  };
}

export function translate(x: number, y: number): string {
  return `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
}

type AnchorFollow = {
  /** Runs `onFrame` again at the next frame (coalesced with any already due). */
  schedule: () => void;
  dispose: () => void;
};

/**
 * Keeps an overlay on `node` (a ring, a card, a label): runs `onFrame` now,
 * then at most once a frame whenever something may have moved the control:
 * its own size or that of anything in `observe` (the card), a window resize,
 * any scroll. `settleMs` also runs it every frame for that long first, for a
 * page still animating in (which moves its controls with no event);
 * `fallbackMs` re-measures that often for moves nothing reports (never while
 * the window is hidden). `onFrame` writes styles directly, not React state,
 * and returns early when nothing moved.
 */
export function followAnchor(
  node: Element,
  onFrame: () => void,
  options: { settleMs?: number; fallbackMs?: number; observe?: readonly (Element | null | undefined)[] } = {},
): AnchorFollow {
  let raf = 0;
  let settleRaf = 0;
  const run = () => {
    raf = 0;
    onFrame();
  };
  const schedule = () => {
    if (!raf) raf = window.requestAnimationFrame(run);
  };
  onFrame();
  if (options.settleMs) {
    const settleUntil = performance.now() + options.settleMs;
    const settle = () => {
      onFrame();
      settleRaf = performance.now() < settleUntil ? window.requestAnimationFrame(settle) : 0;
    };
    settleRaf = window.requestAnimationFrame(settle);
  }
  const observer = new ResizeObserver(schedule);
  observer.observe(node);
  for (const extra of options.observe ?? []) {
    if (extra) observer.observe(extra);
  }
  window.addEventListener("resize", schedule, { passive: true });
  window.addEventListener("scroll", schedule, { capture: true, passive: true });
  const fallback = options.fallbackMs
    ? window.setInterval(() => {
      if (!document.hidden) schedule();
    }, options.fallbackMs)
    : 0;
  return {
    schedule,
    dispose: () => {
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, { capture: true });
      if (fallback) window.clearInterval(fallback);
      if (raf) window.cancelAnimationFrame(raf);
      if (settleRaf) window.cancelAnimationFrame(settleRaf);
    },
  };
}

/**
 * "Let the page settle first": a candidate (a control that just appeared)
 * counts once it has been the same one for `ms`. `wait` answers how long is
 * left, 0 once it has held (and starts over for the next candidate).
 */
export function createSettle<T>(ms: number): { wait: (candidate: T, now: number) => number; reset: () => void } {
  let pending: { candidate: T; since: number } | null = null;
  return {
    wait(candidate, now) {
      if (!pending || pending.candidate !== candidate) pending = { candidate, since: now };
      const left = ms - (now - pending.since);
      if (left > 0) return left;
      pending = null;
      return 0;
    },
    reset() {
      pending = null;
    },
  };
}
