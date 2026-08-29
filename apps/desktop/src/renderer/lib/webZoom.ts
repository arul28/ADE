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
  resizeInstalled = true;
  onResize = () => paintHostedWebZoom();
  window.addEventListener("resize", onResize);
  window.visualViewport?.addEventListener("resize", onResize);
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

/** Test seam. */
export function __resetHostedWebZoomForTests(): void {
  if (typeof window !== "undefined" && onResize) {
    window.removeEventListener("resize", onResize);
    window.visualViewport?.removeEventListener("resize", onResize);
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
