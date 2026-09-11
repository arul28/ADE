/**
 * Where the native browser view goes, in pure arithmetic.
 *
 * A `WebContentsView` is a rectangle the compositor puts on top of the
 * renderer, so the panel has to hand the main process exact pixels — and the
 * three things that can go wrong (a device larger than the pane, a rect that
 * lags a splitter drag, a caption that lies about the fit) are all decided
 * here rather than inside a component that also owns twenty other concerns.
 */

export type BrowserViewFrame = {
  left: number;
  top: number;
  width: number;
  height: number;
  /**
   * 1 when the device fits the stage, else how much of it the frame shows.
   *
   * A landscape phone in a 578px pane cannot be honoured at 1:1, and the old
   * behaviour — clamp width, keep height — cropped the page at the pane's right
   * edge with nothing on screen admitting it. The frame is shrunk on both axes
   * instead, so the whole device is visible and the caption can say `fit 82%`.
   */
  scale: number;
};

type BrowserViewBox = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

/**
 * Where the native view sits inside its stage.
 *
 * With no emulation it fills the stage inset by the host's hairline, so the
 * rounded frame masks the (rectangular) native view. With a CSS size it is that
 * size exactly, centred — until the device is bigger than the stage, when the
 * whole frame is scaled down uniformly rather than cropped on one axis.
 */
export function browserLetterboxFrame(
  stage: { width: number; height: number },
  emulation: { width?: number | null; height?: number | null } | null | undefined,
  inset = 1,
): BrowserViewFrame {
  const availableWidth = Math.max(0, Math.round(stage.width) - inset * 2);
  const availableHeight = Math.max(0, Math.round(stage.height) - inset * 2);
  const cssWidth = emulation?.width && emulation.width > 0 ? Math.round(emulation.width) : null;
  const cssHeight = emulation?.height && emulation.height > 0 ? Math.round(emulation.height) : null;
  if (cssWidth == null || cssHeight == null) {
    return { left: inset, top: inset, width: availableWidth, height: availableHeight, scale: 1 };
  }
  const scale = Math.min(1, availableWidth / cssWidth, availableHeight / cssHeight);
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 0;
  const width = Math.min(availableWidth, Math.round(cssWidth * safeScale));
  const height = Math.min(availableHeight, Math.round(cssHeight * safeScale));
  return {
    left: inset + Math.floor((availableWidth - width) / 2),
    top: inset + Math.floor((availableHeight - height) / 2),
    width,
    height,
    scale: safeScale,
  };
}

/**
 * Trim a measured rect to the box that actually clips it.
 *
 * The renderer measures the frame's own rect, which stays at its laid-out size
 * for a frame or two after a drag; without this the main process is handed a
 * width the pane no longer has and the page paints over the window edge.
 */
export function clampBrowserViewBounds(
  frame: { x: number; y: number; width: number; height: number },
  box: BrowserViewBox,
): { x: number; y: number; width: number; height: number } {
  const left = Math.max(Math.round(frame.x), Math.round(box.left));
  const top = Math.max(Math.round(frame.y), Math.round(box.top));
  const right = Math.min(Math.round(frame.x + frame.width), Math.round(box.right));
  const bottom = Math.min(Math.round(frame.y + frame.height), Math.round(box.bottom));
  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

/**
 * The mono caption under a letterboxed view: `393 × 852`, and `393 × 852 · fit
 * 82%` when the pane was too small to show the device at 1:1.
 *
 * The numbers are always the CSS pixels the page is laid out at — the fit is
 * about this pane, not about the device, so it is an aside rather than a
 * different size.
 */
export function emulationCaption(
  emulation: { width?: number | null; height?: number | null } | null | undefined,
  scale?: number | null,
): string | null {
  if (!emulation?.width || !emulation.height) return null;
  const size = `${Math.round(emulation.width)} × ${Math.round(emulation.height)}`;
  if (typeof scale !== "number" || !Number.isFinite(scale) || scale <= 0 || scale >= 0.995) return size;
  return `${size} · fit ${Math.round(scale * 100)}%`;
}

/** Fade-out for the snapshot underlay once the live view is back, in ms. */
export const UNDERLAY_FADE_MS = 120;

/** The half of a `DOMRect` that is arithmetic rather than layout. */
export type BrowserViewRect = {
  bottom: number;
  height: number;
  left: number;
  right: number;
  top: number;
  width: number;
};

/**
 * The overlapping part of two rects, or null when they do not overlap.
 *
 * Zero-area contact is not an overlap: two panes that share an edge, or a
 * collapsed popover sitting exactly on the surface's boundary, must not count
 * as something painting over the native view — hiding the view for them would
 * blank the page for a rectangle nobody can see.
 */
export function rectIntersection(a: BrowserViewRect, b: BrowserViewRect): BrowserViewRect | null {
  const left = Math.max(a.left, b.left);
  const right = Math.min(a.right, b.right);
  const top = Math.max(a.top, b.top);
  const bottom = Math.min(a.bottom, b.bottom);
  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0) return null;
  return { bottom, height, left, right, top, width };
}

/** The ARIA roles that always mean "this paints over the page". */
const OVERLAY_ROLES = new Set(["alertdialog", "dialog", "listbox", "menu", "tooltip"]);

/**
 * Everything the overlay predicate needs, read off the DOM by its caller.
 *
 * The hook does the `getComputedStyle` and attribute reads; the decision they
 * feed is arithmetic and string comparison, so it lives here where it can be
 * exercised without a compositor.
 */
export type BrowserOverlayCandidate = BrowserOverlayCandidateVisibility & {
  /** The candidate's own box; only its size decides candidacy. */
  rect: Pick<BrowserViewRect, "height" | "width">;
  /** `role` attribute, or null when it has none. */
  role: string | null;
  /** Computed `position`. */
  position: string;
  /** `aria-modal="true"`. */
  ariaModal: boolean;
  /** Matched one of the popover-library content selectors. */
  matchesOverlaySelector: boolean;
};

/**
 * The subset that can disqualify a candidate without measuring it.
 *
 * Split out so the caller can reject on the computed style alone: a
 * `display:none` popover never needs its rect read, and a forced layout per
 * candidate is exactly what the occlusion pass cannot afford when it runs on
 * every animation and transition event.
 */
export type BrowserOverlayCandidateVisibility = {
  /** Computed `pointer-events`. */
  pointerEvents: string;
  /** Computed `display`. */
  display: string;
  /** Computed `visibility`. */
  visibility: string;
  /** Computed `opacity`, as the string the computed style reports. */
  opacity: string;
  /** The `hidden` property. */
  hidden: boolean;
  /** `aria-hidden="true"`. */
  ariaHidden: boolean;
};

/** Is this candidate visible and clickable enough to occlude anything? */
export function isBrowserOverlayCandidateVisible(candidate: BrowserOverlayCandidateVisibility): boolean {
  return !(
    candidate.display === "none"
    || candidate.visibility === "hidden"
    || candidate.opacity === "0"
    || candidate.pointerEvents === "none"
    || candidate.hidden
    || candidate.ariaHidden
  );
}

/**
 * Could this element be painting over the native browser view?
 *
 * Deliberately generous: a false positive costs one frozen frame, a false
 * negative shows a menu over a black rectangle. Anything invisible or
 * click-through is excluded first, then anything smaller than a few pixels,
 * and what remains qualifies by role, by modality, by being a popover
 * library's content box, or simply by being taken out of flow.
 */
export function isBrowserOverlayCandidate(candidate: BrowserOverlayCandidate): boolean {
  if (!isBrowserOverlayCandidateVisible(candidate)) return false;
  if (candidate.rect.width < 4 || candidate.rect.height < 4) return false;
  if (candidate.role && OVERLAY_ROLES.has(candidate.role)) return true;
  if (candidate.ariaModal) return true;
  if (candidate.matchesOverlaySelector) return true;
  return (
    candidate.position === "fixed"
    || candidate.position === "absolute"
    || candidate.position === "sticky"
  );
}
