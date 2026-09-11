import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from "react";
import {
  clampBrowserViewBounds,
  isBrowserOverlayCandidate,
  isBrowserOverlayCandidateVisible,
  rectIntersection,
  UNDERLAY_FADE_MS,
  type BrowserViewRect,
} from "./browserViewGeometry";
import {
  ADE_BROWSER_VIEW_OCCLUSION_END_EVENT,
  ADE_BROWSER_VIEW_OCCLUSION_START_EVENT,
  ADE_WORK_SIDEBAR_BROWSER_RESIZE_END_EVENT,
  ADE_WORK_SIDEBAR_BROWSER_RESIZE_START_EVENT,
} from "../../../lib/workSidebarBrowserResize";
import type { BrowserFrame } from "./browserPanelTypes";

/**
 * Where the native browser view goes, and when it is allowed to be seen.
 *
 * A `WebContentsView` is composited ON TOP of this renderer, so the panel does
 * not "contain" the page — it measures a DOM frame and tells the main process
 * to put the view there, then hides it again for anything that must paint over
 * it. That is three interlocking machines: bounds measurement, a suppression
 * count driven by splitter drags and popovers, and a frozen-frame underlay so
 * a menu never opens over a black rectangle. None of them render anything, all
 * of them are ref-driven, and together they were the largest non-render
 * responsibility inside a 4,500-line component.
 *
 * The hook owns no product state: every decision it makes is handed in as a
 * ref or a callback, so a caller can be tested without a compositor and this
 * can be read without one.
 */

export type BrowserBounds = BrowserFrame & {
  visible: boolean;
  /** The letterbox fit factor, forwarded to CDP's device-metrics `scale`. */
  scale: number;
};

const BOUNDS_SETTLE_MS = 1_200;
const BOUNDS_SETTLE_MIN_FRAME_MS = 32;
/** How long forced bounds keep flowing after a drag ends, in ms. */
const BOUNDS_DRAG_SETTLE_MS = 400;
/** A snapshot older than this is repainted before the next menu opens. */
const UNDERLAY_MAX_AGE_MS = 20_000;
const OVERLAY_MOTION_EVENTS = ["animationend", "animationiteration", "animationstart", "transitioncancel", "transitionend", "transitionrun", "transitionstart"] as const;
const OVERLAY_CANDIDATE_SELECTOR = [
  '[role="alertdialog"]',
  '[role="dialog"]',
  '[role="listbox"]',
  '[role="menu"]',
  '[role="tooltip"]',
  '[aria-modal="true"]',
  "[data-radix-popper-content-wrapper]",
  "[data-radix-dialog-content]",
  "[data-radix-menu-content]",
  "[data-radix-popover-content]",
  "[data-radix-select-content]",
  "[data-side][data-align]",
  ".fixed",
  ".absolute",
  ".sticky",
  '[style*="position"]',
].join(",");

function boundsEqual(a: BrowserBounds | null, b: BrowserBounds): boolean {
  return Boolean(
    a
    && a.x === b.x
    && a.y === b.y
    && a.width === b.width
    && a.height === b.height
    && a.visible === b.visible
    && a.scale === b.scale,
  );
}

/**
 * Where the native view goes, in window pixels.
 *
 * `container` is the pane's content box: the frame's own rect is what it was
 * laid out at, which lags a pointer-driven resize by a frame or two, so the
 * measurement is trimmed to the box that actually clips it before it crosses
 * the bridge. Without that the page keeps its old width and paints over the
 * chat and the window edge for the length of the drag.
 */
function measureNativeBrowserBounds(
  element: HTMLElement,
  container?: HTMLElement | null,
): Omit<BrowserBounds, "scale"> {
  const rect = element.getBoundingClientRect();
  let zoomFactor = 1;
  try {
    const factor = window.ade.zoom.getFactor();
    if (Number.isFinite(factor) && factor > 0) zoomFactor = factor;
  } catch {
    // Browser bounds still work at Electron's default zoom.
  }
  const style = window.getComputedStyle(element);
  const containerRect = container?.isConnected ? container.getBoundingClientRect() : null;
  const clamped = clampBrowserViewBounds(
    { x: rect.left + window.scrollX, y: rect.top + window.scrollY, width: rect.width, height: rect.height },
    {
      left: containerRect ? containerRect.left + window.scrollX : 0,
      top: containerRect ? containerRect.top + window.scrollY : 0,
      right: Math.min(
        containerRect ? containerRect.right + window.scrollX : Number.POSITIVE_INFINITY,
        window.innerWidth + window.scrollX,
      ),
      bottom: Math.min(
        containerRect ? containerRect.bottom + window.scrollY : Number.POSITIVE_INFINITY,
        window.innerHeight + window.scrollY,
      ),
    },
  );
  const visible = (
    element.isConnected
    && style.display !== "none"
    && style.visibility !== "hidden"
    && clamped.width >= 16
    && clamped.height >= 16
  );
  return {
    x: Math.max(0, Math.round(clamped.x * zoomFactor)),
    y: Math.max(0, Math.round(clamped.y * zoomFactor)),
    width: Math.max(0, Math.round(clamped.width * zoomFactor)),
    height: Math.max(0, Math.round(clamped.height * zoomFactor)),
    visible,
  };
}

/** The popover libraries' own content boxes, which are always overlays. */
const OVERLAY_CONTENT_SELECTOR = "[data-radix-popper-content-wrapper], [data-radix-dialog-content], [data-radix-menu-content], [data-radix-popover-content], [data-radix-select-content], [data-side][data-align]";

/**
 * Read the overlay decision's inputs off a live element.
 *
 * The only part of this that touches the DOM: a computed style, four
 * attributes and a rect. The decision itself is `isBrowserOverlayCandidate` in
 * `browserViewGeometry`, so it can be tested without a compositor.
 *
 * The style-only rejects run first and short-circuit, because the remaining
 * reads are the expensive ones: `getBoundingClientRect` forces a layout flush
 * and `matches` walks a twelve-clause selector, and this runs over every
 * candidate in the document on every animation and transition event. An
 * invisible candidate never reaches either.
 */
function readBrowserOverlayCandidate(element: HTMLElement): boolean {
  const style = window.getComputedStyle(element);
  const visibility = {
    pointerEvents: style.pointerEvents,
    display: style.display,
    visibility: style.visibility,
    opacity: style.opacity,
    hidden: element.hidden,
    ariaHidden: element.getAttribute("aria-hidden") === "true",
  };
  if (!isBrowserOverlayCandidateVisible(visibility)) return false;
  return isBrowserOverlayCandidate({
    ...visibility,
    rect: element.getBoundingClientRect(),
    role: element.getAttribute("role"),
    position: style.position,
    ariaModal: element.getAttribute("aria-modal") === "true",
    matchesOverlaySelector: element.matches(OVERLAY_CONTENT_SELECTOR),
  });
}

function overlayCandidateOwnsPoint(element: HTMLElement, x: number, y: number): boolean {
  if (typeof document.elementFromPoint !== "function") return true;
  const topElement = document.elementFromPoint(x, y);
  return topElement === element || (topElement != null && element.contains(topElement));
}

function overlayCandidatePaintsOverSurface(element: HTMLElement, surfaceRect: BrowserViewRect): boolean {
  const overlap = rectIntersection(surfaceRect, element.getBoundingClientRect());
  if (!overlap) return false;
  const points = [
    [overlap.left + overlap.width / 2, overlap.top + overlap.height / 2],
    [overlap.left + 1, overlap.top + 1],
    [overlap.right - 1, overlap.top + 1],
    [overlap.left + 1, overlap.bottom - 1],
    [overlap.right - 1, overlap.bottom - 1],
  ];
  return points.some(([x, y]) => overlayCandidateOwnsPoint(element, x, y));
}

function collectBrowserOverlayCandidates(surface: HTMLElement): HTMLElement[] {
  return Array.from(document.body.querySelectorAll<HTMLElement>(OVERLAY_CANDIDATE_SELECTOR)).filter((element) => {
    if (element === surface || surface.contains(element) || element.contains(surface)) return false;
    return readBrowserOverlayCandidate(element);
  });
}

function browserSurfaceHasExternalOverlay(surface: HTMLElement): boolean {
  if (!surface.isConnected || !document.body) return false;
  const surfaceRect = surface.getBoundingClientRect();
  if (surfaceRect.width < 4 || surfaceRect.height < 4) return false;
  for (const element of collectBrowserOverlayCandidates(surface)) {
    if (overlayCandidatePaintsOverSurface(element, surfaceRect)) return true;
  }
  return false;
}

export type NativeBrowserViewBoundsOptions = {
  /** The pane's content box; the view is clipped to it mid-drag. */
  surfaceRef: MutableRefObject<HTMLDivElement | null>;
  /** The box the letterboxed frame is centred in. */
  stageRef: MutableRefObject<HTMLDivElement | null>;
  /** The DOM frame the view is positioned onto, letterbox included. */
  viewportRef: MutableRefObject<HTMLDivElement | null>;
  /** The whole panel, used as the clip box when there is no surface. */
  panelRef: MutableRefObject<HTMLDivElement | null>;
  /** How much the letterbox had to shrink the device to fit. */
  viewScaleRef: MutableRefObject<number>;
  /** The screenshot-crop overlay owns the surface; no live view under it. */
  captureModeRef: MutableRefObject<boolean>;
  /** The launchpad owns the surface; a view over it is a page nobody can see. */
  launchpadVisibleRef: MutableRefObject<boolean>;
  /** True once the browser namespace exists in this renderer. */
  enabled: boolean;
  setBounds: (bounds: BrowserBounds) => Promise<void>;
  stopInspect: () => Promise<void>;
  /** A data URL for the frozen frame, or null when the page refused. */
  captureFrame: () => Promise<string | null>;
  onError: (message: string) => void;
};

export type NativeBrowserViewBounds = {
  /** Re-measure and push. `force` re-sends even when nothing moved. */
  reportBounds: (visibleOverride?: boolean, options?: { force?: boolean }) => void;
  /** Take the view off screen and stop inspect, e.g. for a screenshot crop. */
  hideNativeBrowserView: () => Promise<void>;
  /** Warm the frozen frame so the next menu opens instantly. */
  refreshUnderlaySnapshot: () => Promise<void>;
  /** The frozen frame the panel paints while the live view is hidden. */
  underlay: { dataUrl: string; visible: boolean } | null;
};

export function useNativeBrowserViewBounds({
  surfaceRef,
  stageRef,
  viewportRef,
  panelRef,
  viewScaleRef,
  captureModeRef,
  launchpadVisibleRef,
  enabled,
  setBounds,
  stopInspect,
  captureFrame,
  onError,
}: NativeBrowserViewBoundsOptions): NativeBrowserViewBounds {
  const latestBoundsRef = useRef<BrowserBounds | null>(null);
  /*
    Suppression is ref-only on purpose: every reader runs outside the render
    closure, so mirroring it into state re-rendered the panel on every menu
    open for nobody's benefit.
  */
  const browserInputSuppressedRef = useRef(false);
  const browserOverlayOccludedRef = useRef(false);
  const browserViewSuppressionCountRef = useRef(0);
  /**
   * The frozen frame shown while a menu covers the browser.
   *
   * A WebContentsView paints above the renderer, so every popover has to hide
   * it — which used to leave a black rectangle behind the menu. The last frame
   * is captured, painted at the view's exact bounds, and only then is the live
   * view hidden, so the page appears to stay put underneath the menu.
   */
  const [underlay, setUnderlay] = useState<{ dataUrl: string; visible: boolean } | null>(null);
  const underlaySnapshotRef = useRef<{ dataUrl: string; capturedAt: number } | null>(null);
  const underlayCaptureRef = useRef<Promise<void> | null>(null);
  const underlayFadeTimerRef = useRef<number | null>(null);

  const reportBounds = useCallback((visibleOverride?: boolean, options?: { force?: boolean }) => {
    const surface = surfaceRef.current;
    const element = viewportRef.current ?? surface;
    if (!enabled || !element) return;
    const measured = measureNativeBrowserBounds(element, element === surface ? panelRef.current : surface);
    const next: BrowserBounds = {
      ...measured,
      // How much the letterbox had to shrink to fit. Main turns this into CDP's
      // device-metrics `scale`, so a device larger than the pane is drawn
      // smaller rather than cropped at the pane's edge.
      scale: viewScaleRef.current,
      visible: visibleOverride ?? (
        !browserInputSuppressedRef.current
        && !browserOverlayOccludedRef.current
        && !captureModeRef.current
        // The view is composited above this renderer, so a launchpad under a
        // still-visible view would be a page nobody can see or click.
        && !launchpadVisibleRef.current
        && measured.visible
      ),
    };
    // A dropped or rejected `setBounds` would otherwise be cached as applied and
    // never retried, so a drag re-sends unconditionally.
    if (!options?.force && boundsEqual(latestBoundsRef.current, next)) return;
    latestBoundsRef.current = next;
    setBounds(next).catch((error: unknown) => {
      onError(error instanceof Error ? error.message : String(error));
    });
  }, [enabled, launchpadVisibleRef, captureModeRef, onError, panelRef, setBounds, surfaceRef, viewScaleRef, viewportRef]);

  const hideNativeBrowserView = useCallback(async () => {
    if (!enabled) return;
    const last = latestBoundsRef.current;
    const hidden = {
      x: last?.x ?? 0,
      y: last?.y ?? 0,
      width: last?.width ?? 0,
      height: last?.height ?? 0,
      visible: false,
      scale: last?.scale ?? 1,
    };
    latestBoundsRef.current = hidden;
    await stopInspect().catch(() => {});
    await setBounds(hidden).catch(() => {});
  }, [enabled, setBounds, stopInspect]);

  /**
   * Capture the frame the underlay paints, without touching the UI.
   *
   * Kept warm after a page settles so the common case — open a menu on a page
   * that finished loading a moment ago — repaints instantly rather than after
   * an IPC round trip the human would see as a black flash.
   */
  const refreshUnderlaySnapshot = useCallback((): Promise<void> => {
    if (!enabled || captureModeRef.current) return Promise.resolve();
    if (underlayCaptureRef.current) return underlayCaptureRef.current;
    const pending = captureFrame()
      .then((dataUrl) => {
        if (!dataUrl) return;
        underlaySnapshotRef.current = { dataUrl, capturedAt: Date.now() };
        setUnderlay((current) => (current ? { dataUrl, visible: current.visible } : current));
      })
      .catch(() => {
        // A page that refuses a capture just falls back to the last frame, or
        // to the pane background — never to an error the human did not cause.
      })
      .finally(() => {
        underlayCaptureRef.current = null;
      });
    underlayCaptureRef.current = pending;
    return pending;
  }, [captureFrame, captureModeRef, enabled]);

  /**
   * Freeze the current frame, then let the caller hide the live view.
   *
   * With a cached frame this is synchronous, which is what keeps a menu open
   * feeling instant. Without one the caller must WAIT: hiding first removes the
   * view from the window, and the capture that was already in flight then runs
   * against a detached view — it throws, falls through to the CDP screenshot
   * path, and attaches a debugger once per menu open. Returns a promise the
   * cold path awaits and the warm path ignores.
   */
  const showUnderlay = useCallback((): Promise<void> => {
    if (underlayFadeTimerRef.current != null) {
      window.clearTimeout(underlayFadeTimerRef.current);
      underlayFadeTimerRef.current = null;
    }
    const cached = underlaySnapshotRef.current;
    if (cached) setUnderlay({ dataUrl: cached.dataUrl, visible: true });
    if (cached && Date.now() - cached.capturedAt <= UNDERLAY_MAX_AGE_MS) return Promise.resolve();
    return refreshUnderlaySnapshot().then(() => {
      const fresh = underlaySnapshotRef.current;
      if (!fresh) return;
      if (!browserOverlayOccludedRef.current && !browserInputSuppressedRef.current) return;
      setUnderlay({ dataUrl: fresh.dataUrl, visible: true });
    });
  }, [refreshUnderlaySnapshot]);

  const hideUnderlay = useCallback(() => {
    if (underlayFadeTimerRef.current != null) {
      window.clearTimeout(underlayFadeTimerRef.current);
      underlayFadeTimerRef.current = null;
    }
    setUnderlay((current) => (current ? { ...current, visible: false } : current));
    underlayFadeTimerRef.current = window.setTimeout(() => {
      underlayFadeTimerRef.current = null;
      setUnderlay(null);
    }, UNDERLAY_FADE_MS + 20);
  }, []);

  useEffect(() => () => {
    if (underlayFadeTimerRef.current != null) window.clearTimeout(underlayFadeTimerRef.current);
  }, []);

  useEffect(() => {
    let restoreFrame: number | null = null;
    let dragFrame: number | null = null;
    let dragUntil = 0;
    let lastDragReportAt = 0;
    const cancelRestoreFrame = () => {
      if (restoreFrame == null) return;
      window.cancelAnimationFrame(restoreFrame);
      restoreFrame = null;
    };
    const cancelDragFrame = () => {
      if (dragFrame == null) return;
      window.cancelAnimationFrame(dragFrame);
      dragFrame = null;
    };
    /**
     * Keep pushing bounds for as long as the splitter is moving.
     *
     * The settle loop only ran after the drag ended, so a pane dragged narrow
     * left the view at its old width for the whole gesture — and if the final
     * update was ever coalesced away it stayed there.
     */
    const pumpDragBounds = () => {
      const tick = () => {
        dragFrame = null;
        // Wall-clock rather than the frame timestamp: the throttle is about how
        // often the main process is asked to move a view, not about frames.
        const now = window.performance.now();
        if (now - lastDragReportAt >= BOUNDS_SETTLE_MIN_FRAME_MS) {
          lastDragReportAt = now;
          reportBounds(undefined, { force: true });
        }
        if (browserViewSuppressionCountRef.current > 0 || now < dragUntil) {
          dragFrame = window.requestAnimationFrame(tick);
        }
      };
      if (dragFrame == null) dragFrame = window.requestAnimationFrame(tick);
    };
    const suppressInput = () => {
      cancelRestoreFrame();
      browserViewSuppressionCountRef.current += 1;
      browserInputSuppressedRef.current = true;
      // Warm frame: hide now. Cold: hide only once the capture has landed, so
      // it is not taken against a view that has already left the window.
      const frozen = showUnderlay();
      if (underlaySnapshotRef.current) {
        reportBounds(false);
      } else {
        void frozen.then(() => {
          if (!browserInputSuppressedRef.current) return;
          reportBounds(false);
        });
      }
      pumpDragBounds();
    };
    const restoreInput = () => {
      browserViewSuppressionCountRef.current = Math.max(0, browserViewSuppressionCountRef.current - 1);
      if (browserViewSuppressionCountRef.current > 0) return;
      browserInputSuppressedRef.current = false;
      cancelRestoreFrame();
      // Bounds land first, then the frozen frame fades: swapping the order
      // would show one frame of the stale geometry.
      dragUntil = window.performance.now() + BOUNDS_DRAG_SETTLE_MS;
      pumpDragBounds();
      restoreFrame = window.requestAnimationFrame(() => {
        restoreFrame = null;
        reportBounds(undefined, { force: true });
        if (!browserOverlayOccludedRef.current) hideUnderlay();
      });
    };
    window.addEventListener(ADE_WORK_SIDEBAR_BROWSER_RESIZE_START_EVENT, suppressInput);
    window.addEventListener(ADE_WORK_SIDEBAR_BROWSER_RESIZE_END_EVENT, restoreInput);
    window.addEventListener(ADE_BROWSER_VIEW_OCCLUSION_START_EVENT, suppressInput);
    window.addEventListener(ADE_BROWSER_VIEW_OCCLUSION_END_EVENT, restoreInput);
    return () => {
      window.removeEventListener(ADE_WORK_SIDEBAR_BROWSER_RESIZE_START_EVENT, suppressInput);
      window.removeEventListener(ADE_WORK_SIDEBAR_BROWSER_RESIZE_END_EVENT, restoreInput);
      window.removeEventListener(ADE_BROWSER_VIEW_OCCLUSION_START_EVENT, suppressInput);
      window.removeEventListener(ADE_BROWSER_VIEW_OCCLUSION_END_EVENT, restoreInput);
      cancelRestoreFrame();
      cancelDragFrame();
    };
  }, [hideUnderlay, reportBounds, showUnderlay]);

  useEffect(() => {
    const element = surfaceRef.current;
    if (!element || typeof MutationObserver === "undefined") return undefined;
    let animationFrame: number | null = null;
    const cancelFrame = () => {
      if (animationFrame == null) return;
      window.cancelAnimationFrame(animationFrame);
      animationFrame = null;
    };
    const setOverlayOccluded = (next: boolean) => {
      if (browserOverlayOccludedRef.current === next) return;
      browserOverlayOccludedRef.current = next;
      // Paint the frozen frame before the live view goes, and only drop it once
      // the live view is back — otherwise the menu opens over a black hole.
      if (!next) {
        reportBounds(undefined, { force: true });
        if (!browserInputSuppressedRef.current) hideUnderlay();
        return;
      }
      const frozen = showUnderlay();
      if (underlaySnapshotRef.current) {
        reportBounds(false, { force: true });
        return;
      }
      void frozen.then(() => {
        if (!browserOverlayOccludedRef.current) return;
        reportBounds(false, { force: true });
      });
    };
    const checkForOverlay = () => {
      animationFrame = null;
      setOverlayOccluded(browserSurfaceHasExternalOverlay(element));
      refreshObservedOverlays();
    };
    const scheduleCheck = () => {
      if (animationFrame != null) return;
      animationFrame = window.requestAnimationFrame(checkForOverlay);
    };
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleCheck);
    const observedOverlays = new Set<HTMLElement>();
    const refreshObservedOverlays = () => {
      if (!resizeObserver || !document.body) return;
      const nextOverlays = new Set(collectBrowserOverlayCandidates(element));
      for (const overlay of observedOverlays) {
        if (nextOverlays.has(overlay)) continue;
        resizeObserver.unobserve(overlay);
        observedOverlays.delete(overlay);
      }
      for (const overlay of nextOverlays) {
        if (observedOverlays.has(overlay)) continue;
        resizeObserver.observe(overlay);
        observedOverlays.add(overlay);
      }
    };
    const observer = new MutationObserver(scheduleCheck);
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ["aria-hidden", "aria-modal", "class", "data-state", "hidden", "role", "style"],
      childList: true,
      subtree: true,
    });
    scheduleCheck();
    window.addEventListener("resize", scheduleCheck);
    window.addEventListener("scroll", scheduleCheck, true);
    for (const eventName of OVERLAY_MOTION_EVENTS) {
      document.addEventListener(eventName, scheduleCheck, true);
    }
    return () => {
      observer.disconnect();
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleCheck);
      window.removeEventListener("scroll", scheduleCheck, true);
      for (const eventName of OVERLAY_MOTION_EVENTS) {
        document.removeEventListener(eventName, scheduleCheck, true);
      }
      cancelFrame();
      browserOverlayOccludedRef.current = false;
    };
  }, [hideUnderlay, reportBounds, showUnderlay, surfaceRef]);

  useLayoutEffect(() => {
    const element = surfaceRef.current;
    if (!element) return undefined;
    let animationFrame: number | null = null;
    let settleFrame: number | null = null;
    let settleUntil = 0;
    let lastSettleReportAt = 0;
    const scheduleReport = () => {
      if (animationFrame != null) return;
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = null;
        reportBounds();
      });
    };
    const scheduleSettledReport = () => {
      scheduleReport();
      settleUntil = window.performance.now() + BOUNDS_SETTLE_MS;
      if (settleFrame != null) return;
      const tick = (now: number) => {
        settleFrame = null;
        if (now - lastSettleReportAt >= BOUNDS_SETTLE_MIN_FRAME_MS) {
          lastSettleReportAt = now;
          reportBounds();
        }
        if (now < settleUntil) {
          settleFrame = window.requestAnimationFrame(tick);
        }
      };
      settleFrame = window.requestAnimationFrame(tick);
    };
    const handleSubtreeTransition = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && element.contains(target)) scheduleSettledReport();
    };
    scheduleSettledReport();
    const observer = new ResizeObserver(scheduleSettledReport);
    observer.observe(element);
    // The letterbox frame resizes without the surface changing size, and the
    // pane changes size without the surface having settled yet — both have to
    // re-position the view.
    for (const extra of [viewportRef.current, stageRef.current, panelRef.current]) {
      if (extra && extra !== element) observer.observe(extra);
    }
    window.addEventListener("resize", scheduleSettledReport);
    element.addEventListener("transitionend", handleSubtreeTransition);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", scheduleSettledReport);
      element.removeEventListener("transitionend", handleSubtreeTransition);
      if (animationFrame != null) window.cancelAnimationFrame(animationFrame);
      if (settleFrame != null) window.cancelAnimationFrame(settleFrame);
      const last = latestBoundsRef.current;
      if (enabled && last) {
        void stopInspect().catch(() => {});
        latestBoundsRef.current = { ...last, visible: false };
        void setBounds({ ...last, visible: false }).catch(() => {});
      }
    };
  }, [enabled, reportBounds, setBounds, stopInspect, surfaceRef, panelRef, stageRef, viewportRef]);
  return { reportBounds, hideNativeBrowserView, refreshUnderlaySnapshot, underlay };
}
