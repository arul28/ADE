/**
 * Hosted-web stand-in for Electron `webFrame` zoom.
 *
 * Desktop zoom shrinks the CSS-pixel viewport, so layout reflows and
 * overflow/pointer math stay in one coordinate space. A bare `body { zoom }`
 * does not: `height: 100%` is multiplied by the zoom factor, html's
 * `overflow: hidden` crops the extra, session cards and the chat column clip,
 * and `position: fixed` menus that mix `window.innerHeight` with a zoomed
 * `getBoundingClientRect()` jump to the top of the window.
 *
 * Inverse-size the body first so after zoom it occupies exactly one viewport,
 * matching Electron. Applied from the web adapter only — the desktop preload
 * still drives `webFrame.setZoomLevel`.
 */

type ZoomStyle = CSSStyleDeclaration & { zoom?: string };

let appliedFactor = 1;
let resizeInstalled = false;
let onResize: (() => void) | null = null;

function paintHostedWebZoom(): void {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  const body = document.body;
  if (!body) return;
  const factor = appliedFactor;
  const bodyStyle = body.style as ZoomStyle;
  try {
    document.documentElement.style.setProperty("--ade-web-zoom-factor", String(factor));
    const htmlStyle = document.documentElement.style;
    const root = document.getElementById("root");
    // Percentage-height children (AppShell `h-full`, #root) need a definite
    // containing block. Vite's index.html does not set one; webclient.html
    // does. Pin both so 100vh-based chrome cannot outgrow the inverse box.
    htmlStyle.height = "100%";
    htmlStyle.overflow = "hidden";
    if (root) {
      root.style.height = "100%";
      root.style.minHeight = "100%";
      root.style.width = "100%";
      root.style.overflow = "hidden";
    }
    if (factor === 1) {
      // Display 90% is factor 1. Vite's index.html does not give body a
      // definite height, so clearing the box would leave AppShell's `h-full`
      // with no containing block. Keep 100% (identity zoom) and only drop zoom.
      bodyStyle.zoom = "";
      bodyStyle.width = "100%";
      bodyStyle.height = "100%";
      bodyStyle.minWidth = "100%";
      bodyStyle.minHeight = "100%";
      return;
    }
    const width = window.innerWidth / factor;
    const height = window.innerHeight / factor;
    bodyStyle.zoom = String(factor);
    bodyStyle.width = `${width}px`;
    bodyStyle.height = `${height}px`;
    // webclient.html sets min-height: 100% on body, which would otherwise
    // force the pre-zoom box back to the viewport and re-clip after zoom.
    bodyStyle.minWidth = `${width}px`;
    bodyStyle.minHeight = `${height}px`;
  } catch {
    // A display preference must never take the adapter down — this also runs
    // during install, where the document may be a partial stub.
  }
}

function ensureResizeListener(): void {
  if (resizeInstalled || typeof window === "undefined") return;
  if (typeof window.addEventListener !== "function") return;
  try {
    onResize = () => paintHostedWebZoom();
    window.addEventListener("resize", onResize);
    window.visualViewport?.addEventListener("resize", onResize);
    resizeInstalled = true;
  } catch {
    onResize = null;
  }
}

/**
 * Apply the hosted-web zoom factor (1 = 100% CSS pixels). Safe to call
 * repeatedly; a single resize listener keeps the inverse box in sync with
 * the viewport.
 */
export function applyHostedWebZoom(factor: number): void {
  const safe = Number.isFinite(factor) && factor > 0 ? factor : 1;
  appliedFactor = safe;
  ensureResizeListener();
  paintHostedWebZoom();
}

/**
 * A length taken from a rect (screen pixels) as layout pixels, the unit of
 * `scrollTop`, `offsetHeight`, `clientHeight` and the stored row heights. Under
 * hosted-web body zoom a rect is `appliedFactor` times its layout size; at
 * factor 1, and in Electron, this is the identity. Reads the stored factor, so
 * it costs no layout and is cheap to call per row.
 */
export function toLayoutPx(rectPx: number): number {
  return rectPx / appliedFactor;
}

const VIEWPORT_LENGTH_RE = /(-?(?:\d+\.?\d*|\.\d+))([dsl]?v(?:h|w|min|max|b|i))\b/g;

/**
 * A CSS length with every viewport unit (`100vh`, `100dvh`, `50vw`, ...)
 * divided by the hosted-web body zoom, so an overlay sized from the viewport
 * still fits the window once `body { zoom }` scales it again. Electron sets no
 * `--ade-web-zoom-factor`, so there the division is by 1 and the computed value
 * is unchanged. A length that already reads the factor is left alone.
 */
export function zoomCompensatedLength(value: string): string {
  if (value.includes("--ade-web-zoom-factor")) return value;
  return value.replace(VIEWPORT_LENGTH_RE, "calc($1$2 / var(--ade-web-zoom-factor, 1))");
}

const VIEWPORT_SIZED_KEYS = ["width", "minWidth", "maxWidth", "height", "minHeight", "maxHeight"] as const;

/**
 * `style` with `zoomCompensatedLength` applied to its size properties. Returns
 * the same object when nothing changes, so a memoized style stays stable.
 */
export function zoomCompensatedSizeStyle<T extends Partial<Record<(typeof VIEWPORT_SIZED_KEYS)[number], unknown>>>(
  style: T | undefined,
): T | undefined {
  if (!style) return style;
  let next: T | null = null;
  for (const key of VIEWPORT_SIZED_KEYS) {
    const value = style[key];
    if (typeof value !== "string") continue;
    const compensated = zoomCompensatedLength(value);
    if (compensated === value) continue;
    next ??= { ...style };
    (next as Record<string, unknown>)[key] = compensated;
  }
  return next ?? style;
}

/** Test seam. */
export function __resetHostedWebZoomForTests(): void {
  if (
    typeof window !== "undefined"
    && onResize
    && typeof window.removeEventListener === "function"
  ) {
    try {
      window.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("resize", onResize);
    } catch {
      // Adapter tests stub `window` without the EventTarget methods.
    }
  }
  onResize = null;
  resizeInstalled = false;
  appliedFactor = 1;
  if (typeof document === "undefined") return;
  const bodyStyle = document.body?.style as ZoomStyle | undefined;
  if (bodyStyle) {
    bodyStyle.zoom = "";
    bodyStyle.width = "";
    bodyStyle.height = "";
    bodyStyle.minWidth = "";
    bodyStyle.minHeight = "";
  }
  document.documentElement?.style.removeProperty("--ade-web-zoom-factor");
  document.documentElement.style.height = "";
  document.documentElement.style.overflow = "";
  const root = document.getElementById("root");
  if (root) {
    root.style.height = "";
    root.style.minHeight = "";
    root.style.width = "";
    root.style.overflow = "";
  }
}

/**
 * The CSS zoom between an element's layout pixels and the rects it reports:
 * 1 in Electron, the hosted-web factor under `body { zoom }`. Rects come back
 * zoomed, but a `left`/`top` written into a style is zoomed again, so divide a
 * measured rect by this before it becomes a style value.
 */
export function cssZoomOf(el: HTMLElement | null = typeof document === "undefined" ? null : document.body): number {
  if (!el || !el.offsetWidth) return 1;
  const zoom = el.getBoundingClientRect().width / el.offsetWidth;
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}

/**
 * The frame a `position: fixed` element's `left`/`top` are written in, and how
 * it maps a rect measured on screen into that frame. The containing block is the
 * viewport unless an ancestor creates one (a transform, filter, perspective,
 * backdrop-filter, `contain`, or `will-change` for those). Then it is that
 * ancestor's box, and its own scale per axis (its transform, times the body
 * zoom) is the screen-pixels-per-style-pixel ratio on x and y separately, so
 * `scale(0.5, 0.75)` places both axes. Both are 1 in Electron.
 */
export type FixedFrame = { originX: number; originY: number; scaleX: number; scaleY: number };

function isSet(value: string | null | undefined): boolean {
  return Boolean(value) && value !== "none";
}

/**
 * Rotation or skew turns a rect into the bounding box of a tilted box, which
 * per-axis ratios cannot undo. Browsers report a computed transform as
 * `matrix()` or `matrix3d()`; b and c are the off-diagonal terms, zero for any
 * combination of translate and scale.
 */
function isRotatedOrSkewed(transform: string | null | undefined): boolean {
  const match = /^matrix(3d)?\((.*)\)$/.exec(transform ?? "");
  if (!match) return false;
  const values = match[2].split(",").map((value) => parseFloat(value));
  const b = values[1] ?? 0;
  const c = (match[1] ? values[4] : values[2]) ?? 0;
  return Math.abs(b) > 1e-9 || Math.abs(c) > 1e-9;
}

/** Screen size over layout size on one axis: the zoom, or 1 when unmeasurable. */
function axisZoom(rectSize: number, layoutSize: number): number {
  if (!layoutSize) return 1;
  const zoom = rectSize / layoutSize;
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}

function createsContainingBlock(el: HTMLElement): boolean {
  const style = getComputedStyle(el);
  if (isSet(style.transform) || isSet(style.perspective) || isSet(style.filter)) return true;
  if (isSet(style.backdropFilter)) return true;
  if (/paint|layout|strict|content/.test(style.contain ?? "")) return true;
  return /transform|perspective|filter/.test(style.willChange ?? "");
}

let warnedRotatedContainingBlock = false;

/**
 * The frame for a fixed child rendered inside `parent`. Pass null for the viewport
 * frame (a child of `body`), which is the common case.
 *
 * A containing block that is rotated or skewed (or sits in one) falls back to
 * the viewport frame. A bounding box cannot place a fixed child there, so
 * the child lands off by the tilt. That is a known limit, not a silent one:
 * dev builds warn once.
 */
export function fixedFrameOf(parent: Element | null): FixedFrame {
  if (typeof document !== "undefined" && typeof getComputedStyle === "function") {
    for (let el = parent; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
      if (el instanceof HTMLElement && createsContainingBlock(el)) return containingBlockFrame(el);
    }
  }
  return viewportFrame();
}

function viewportFrame(): FixedFrame {
  const zoom = cssZoomOf();
  return { originX: 0, originY: 0, scaleX: zoom, scaleY: zoom };
}

function containingBlockFrame(el: HTMLElement): FixedFrame {
  for (let node: HTMLElement | null = el; node && node !== document.body; node = node.parentElement) {
    if (!isRotatedOrSkewed(getComputedStyle(node).transform)) continue;
    if (import.meta.env.DEV && !warnedRotatedContainingBlock) {
      warnedRotatedContainingBlock = true;
      console.warn("[webZoom] fixed placement under a rotated or skewed containing block falls back to the viewport frame");
    }
    return viewportFrame();
  }
  const box = el.getBoundingClientRect();
  return {
    originX: box.left,
    originY: box.top,
    scaleX: axisZoom(box.width, el.offsetWidth),
    scaleY: axisZoom(box.height, el.offsetHeight),
  };
}

type RectLike = { left: number; top: number; width: number; height: number };

/** A screen rect as the `left`/`top`/`width`/… of a fixed child in `frame`. */
export function fixedRect(frame: FixedFrame, rect: RectLike) {
  const left = (rect.left - frame.originX) / frame.scaleX;
  const top = (rect.top - frame.originY) / frame.scaleY;
  const width = rect.width / frame.scaleX;
  const height = rect.height / frame.scaleY;
  return { left, top, right: left + width, bottom: top + height, width, height };
}

/**
 * A screen point (a pointer's `clientX`/`clientY`, or a rect edge) as the
 * `left`/`top` of a fixed child in `frame`. Pointer coordinates are viewport
 * pixels, the same space as rects, so they convert the same way.
 */
export function fixedPoint(frame: FixedFrame, x: number, y: number): { left: number; top: number } {
  const point = fixedRect(frame, { left: x, top: y, width: 0, height: 0 });
  return { left: point.left, top: point.top };
}

/** The viewport (the window's inner size) in the style space of `frame`. */
export function fixedViewport(frame: FixedFrame) {
  return fixedRect(frame, { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight });
}
