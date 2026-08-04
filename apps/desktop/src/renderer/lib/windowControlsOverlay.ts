/**
 * Windows title-bar (Window Controls Overlay) geometry.
 *
 * The Windows window is created with `titleBarStyle: "hidden"` +
 * `titleBarOverlay` (see `src/main/windowAppearance.ts`), so Chromium draws the
 * native minimize/maximize/close buttons on top of the renderer at the trailing
 * edge and exposes their geometry through the Window Controls Overlay API.
 *
 * This is the Windows twin of `shellHeaderInsetPx()` in `./zoom`: macOS reserves
 * space at the *start* of the title bar for the traffic lights, Windows must
 * reserve space at the *end* for the caption buttons. Both hazards are the same
 * shape — the OS draws chrome at a fixed physical size that does not follow the
 * renderer's zoom factor — so a static CSS-pixel reservation drifts: it wastes
 * space when zoomed in and lets the caption buttons swallow ADE's own controls
 * when zoomed out.
 *
 * Rather than guess, read the real overlay rect. `getTitlebarAreaRect()` returns
 * the part of the title bar still owned by the page, in CSS pixels, so the
 * caption-button width is simply what is left over at the trailing edge.
 */

import { rendererPlatformAttribute } from "./platform";
import { DEFAULT_ZOOM, zoomFactorForDisplay } from "./zoom";

/**
 * Deliberately not `--shell-header-padding-end`: `data-theme` is set on <html>,
 * <body>, and the shell wrapper, so each of those re-declares the padding
 * tokens and would shadow a value inherited from <html>. See the platform-inset
 * block in index.css.
 */
export const SHELL_HEADER_INSET_END_PROPERTY = "--shell-header-inset-end";

/**
 * Caption-button clearance used before the overlay reports real geometry (and
 * on any Chromium that does not expose the API). Windows draws three 46 DIP
 * caption buttons, so 138 DIP is the true default width.
 */
export const WINDOWS_CAPTION_FALLBACK_PX = 138;

/** Breathing room between the last ADE control and the first caption button. */
export const WINDOWS_CAPTION_GUTTER_PX = 8;

/**
 * Title-bar padding when no caption buttons are overlaid (non-Windows, or
 * Windows in fullscreen where the overlay hides). Matches the CSS default.
 */
export const SHELL_HEADER_INSET_END_BASE_PX = 14;

type TitlebarAreaRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type WindowControlsOverlayLike = {
  visible: boolean;
  getTitlebarAreaRect: () => TitlebarAreaRect;
  addEventListener?: (type: "geometrychange", listener: () => void) => void;
  removeEventListener?: (type: "geometrychange", listener: () => void) => void;
};

export type CaptionInsetArgs = {
  overlay: WindowControlsOverlayLike | null | undefined;
  viewportWidth: number;
};

/**
 * CSS px to reserve at the end of the title bar so the Windows caption buttons
 * never cover ADE's trailing controls (feedback reporter, help menu, zoom).
 *
 * The overlay rect is the page-owned slice of the title bar, so the reserved
 * width is `viewport - (rect.x + rect.width)` — whatever the caption buttons
 * occupy at the trailing edge, at the current zoom and DPI — plus a small
 * gutter. When the overlay is hidden (fullscreen) nothing needs reserving.
 *
 * Returns `null` for "ask again in a frame". `innerWidth` and the overlay rect
 * are updated by different parts of the browser and are briefly inconsistent
 * mid-resize: the viewport narrows while the rect still describes the old,
 * wider window, which makes the trailing edge look like zero. Taking that at
 * face value would mean "no caption buttons here" and drop the reservation to
 * nothing — the observed failure is the whole control cluster jumping back
 * under the caption buttons after a resize. An unusable answer is better left
 * unanswered; the caller keeps the last good value until the geometry settles.
 */
export function windowsCaptionInsetPx(args: CaptionInsetArgs): number | null {
  const { overlay, viewportWidth } = args;
  const fallback = WINDOWS_CAPTION_FALLBACK_PX + WINDOWS_CAPTION_GUTTER_PX;
  if (!overlay || typeof overlay.getTitlebarAreaRect !== "function") {
    return fallback;
  }
  // Fullscreen genuinely hides the caption buttons, and that is a settled
  // state rather than a transient one, so it is safe to reclaim the space.
  if (!overlay.visible) return SHELL_HEADER_INSET_END_BASE_PX;

  let rect: TitlebarAreaRect;
  try {
    rect = overlay.getTitlebarAreaRect();
  } catch {
    return fallback;
  }
  if (!rect || !Number.isFinite(rect.width) || !Number.isFinite(rect.x)) {
    return fallback;
  }
  // A zero-width rect means the overlay is present but not laid out yet; the
  // fallback is closer to the truth than "reserve the whole window".
  if (rect.width <= 0) return fallback;
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return fallback;

  const trailing = viewportWidth - (rect.x + rect.width);
  if (!Number.isFinite(trailing) || trailing <= 0) return null;
  return Math.round(trailing) + WINDOWS_CAPTION_GUTTER_PX;
}

/**
 * The vertical half of the same problem, and the one the overlay rect cannot
 * answer: `titleBarOverlay` is declared in the main process in DIP, so the
 * caption strip does not follow renderer zoom or the ADE theme the way the
 * header underneath it does. Left alone it overhangs into the tab strip when
 * zoomed out — clicks in the overhang go to the OS, not to ADE — and stays
 * near-black on the light theme.
 *
 * Zoom and theme change independently and neither call site knows the other's
 * value, so the last of each is held here and both are pushed every time.
 * macOS is excluded outright: the OS lays out and recolours the traffic lights
 * itself, and a second source of truth would only fight it.
 */
export type TitleBarOverlayTheme = "dark" | "light";

let overlayTheme: TitleBarOverlayTheme = "dark";
let overlayDisplayZoom = DEFAULT_ZOOM;

export function syncWindowsTitleBarOverlay(
  next: { theme?: TitleBarOverlayTheme; displayZoom?: number } = {},
): void {
  if (next.theme) overlayTheme = next.theme;
  if (typeof next.displayZoom === "number" && Number.isFinite(next.displayZoom)) {
    overlayDisplayZoom = next.displayZoom;
  }
  if (rendererPlatformAttribute() !== "win32") return;
  if (typeof window === "undefined") return;
  const setOverlay = window.ade?.zoom?.setTitleBarOverlay;
  if (typeof setOverlay !== "function") return;
  void Promise.resolve(
    setOverlay({
      theme: overlayTheme,
      zoomFactor: zoomFactorForDisplay(overlayDisplayZoom),
    }),
  ).catch(() => {});
}

function readOverlay(): WindowControlsOverlayLike | null {
  if (typeof navigator === "undefined") return null;
  const overlay = (navigator as Navigator & {
    windowControlsOverlay?: WindowControlsOverlayLike;
  }).windowControlsOverlay;
  return overlay ?? null;
}

/**
 * Push the live caption-button clearance into `--shell-header-inset-end`.
 * No-op where there is no overlay to dodge, or while the geometry is mid-flight
 * (see `windowsCaptionInsetPx`). Returns whether a value was written.
 */
export function applyWindowsCaptionInset(): boolean {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return false;
  }
  const overlay = readOverlay();
  if (!overlay) return false;
  const inset = windowsCaptionInsetPx({
    overlay,
    viewportWidth: window.innerWidth,
  });
  if (inset == null) return false;
  document.documentElement.style.setProperty(
    SHELL_HEADER_INSET_END_PROPERTY,
    `${inset}px`,
  );
  return true;
}

/**
 * Apply the clearance now and keep it in sync. `geometrychange` covers
 * maximize/restore and fullscreen; `resize` covers renderer zoom changes, which
 * alter how many CSS pixels the fixed-DIP caption buttons occupy.
 *
 * Each trigger retries on the next few frames rather than reading once: the
 * viewport and the overlay rect settle independently, and the first read after
 * a resize is often the inconsistent one.
 */
export function trackWindowsCaptionInset(): () => void {
  if (typeof window === "undefined") return () => {};
  const overlay = readOverlay();
  if (!overlay) return () => {};

  const RETRY_FRAMES = 6;
  let frame: number | null = null;
  const cancelFrame = () => {
    if (frame != null) window.cancelAnimationFrame(frame);
    frame = null;
  };
  const settle = (remaining: number) => {
    cancelFrame();
    if (remaining <= 0) return;
    frame = window.requestAnimationFrame(() => {
      frame = null;
      // Keep re-reading even after a successful write: a resize produces a run
      // of intermediate geometries and only the last one is the real answer.
      applyWindowsCaptionInset();
      settle(remaining - 1);
    });
  };
  const update = () => {
    applyWindowsCaptionInset();
    settle(RETRY_FRAMES);
  };
  update();

  overlay.addEventListener?.("geometrychange", update);
  window.addEventListener("resize", update);
  return () => {
    cancelFrame();
    overlay.removeEventListener?.("geometrychange", update);
    window.removeEventListener("resize", update);
  };
}
