import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";

import { Z_LAYERS } from "../../ui/zLayers";
import { AppSuggestionCard, useVisibleAppSuggestion } from "../../ui/notice/AppSuggestionStack";
import { TOAST_MOTION_PROPS, ToastStack } from "./ToastStack";
import { useToasts } from "./toastStore";
import {
  browserPageCoveringCorner,
  useBrowserPageRects,
  type CornerNoticeRect,
} from "./cornerNoticeDock";
import { closeNoticeLayer, openNoticeLayer, type NoticeLayer } from "./noticeLayer";

/** Distance from the content area's bottom and right edges. */
export const TOAST_VIEWPORT_INSET_PX = 12;
/** Space between stacked cards. */
export const TOAST_VIEWPORT_GAP_PX = 8;
const MAX_WIDTH_PX = 380;
/** The corner a card claims even before one is measured: one short card. */
const CORNER_MIN_HEIGHT_PX = 96;
const NO_SLOTS: ReadonlyArray<{ key: string; node: ReactNode }> = [];

/** The box the stack occupies in the corner, from its positioned parent. */
function cornerBox(parent: HTMLElement, stackHeight: number): CornerNoticeRect {
  const rect = parent.getBoundingClientRect();
  const right = rect.right - TOAST_VIEWPORT_INSET_PX;
  const bottom = rect.bottom - TOAST_VIEWPORT_INSET_PX;
  const width = Math.min(MAX_WIDTH_PX, Math.max(0, rect.width - TOAST_VIEWPORT_INSET_PX * 2));
  return { left: right - width, top: bottom - Math.max(CORNER_MIN_HEIGHT_PX, stackHeight), right, bottom };
}

/**
 * Which browser page, if any, sits where the stack would be.
 *
 * Re-measured when a page moves, the window resizes, or the stack grows; the
 * parent is `main`, so a page anywhere else (the docked chat, another pane)
 * never moves the corner.
 */
function useCoveringBrowserPage(
  viewportRef: React.RefObject<HTMLDivElement | null>,
  stackHeight: number,
): string | null {
  const pages = useBrowserPageRects();
  const [windowSize, setWindowSize] = useState(0);
  useEffect(() => {
    const onResize = () => setWindowSize((value) => value + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const [covering, setCovering] = useState<string | null>(null);
  useLayoutEffect(() => {
    const parent = viewportRef.current?.parentElement;
    if (!parent || pages.size === 0) {
      setCovering(null);
      return;
    }
    setCovering(browserPageCoveringCorner(pages, cornerBox(parent, stackHeight)));
  }, [pages, stackHeight, viewportRef, windowSize]);
  return covering;
}

/** Room around the cards inside the layer, so their shadows are not cut off. */
const LAYER_SHADOW_PX = 16;

function zoomFactor(): number {
  try {
    const factor = window.ade?.zoom?.getFactor?.();
    return typeof factor === "number" && Number.isFinite(factor) && factor > 0 ? factor : 1;
  } catch {
    return 1;
  }
}

/**
 * Draw the cards in the notice layer while `wanted`, and keep the layer over
 * the corner: its box follows the cards' height, the corner's parent (sidebar
 * and window changes) and the zoom. Returns the layer's card host, or null to
 * draw in the corner as usual (not wanted, or there is no layer to open).
 */
function useNoticeLayerHost(
  wanted: boolean,
  viewportRef: React.RefObject<HTMLDivElement | null>,
  onHeight: (height: number) => void,
): HTMLElement | null {
  const [layer, setLayer] = useState<NoticeLayer | null>(null);
  useEffect(() => {
    if (wanted && (!layer || layer.window.closed)) setLayer(openNoticeLayer());
  }, [layer, wanted]);
  useEffect(() => () => closeNoticeLayer(), []);

  const onHeightRef = useRef(onHeight);
  onHeightRef.current = onHeight;
  const scheduleRef = useRef<(() => void) | null>(null);
  // The stack re-renders whenever a card comes or goes; re-measure then too.
  useLayoutEffect(() => {
    scheduleRef.current?.();
  });
  useLayoutEffect(() => {
    const parent = viewportRef.current?.parentElement;
    const place = window.ade?.noticeLayer?.place;
    if (!layer || !place) return undefined;
    if (!wanted || !parent) {
      void place(null);
      return undefined;
    }
    const { host } = layer;
    let frame = 0;
    let last = "";
    const update = () => {
      frame = 0;
      if (layer.window.closed) return;
      const box = parent.getBoundingClientRect();
      const cardsWidth = Math.min(MAX_WIDTH_PX, Math.max(0, box.width - TOAST_VIEWPORT_INSET_PX * 2));
      const cardsHeight = Math.ceil(host.getBoundingClientRect().height);
      host.style.left = `${LAYER_SHADOW_PX}px`;
      host.style.right = `${TOAST_VIEWPORT_INSET_PX}px`;
      host.style.bottom = `${TOAST_VIEWPORT_INSET_PX}px`;
      host.style.gap = `${TOAST_VIEWPORT_GAP_PX}px`;
      if (cardsHeight > 0) onHeightRef.current(cardsHeight);
      const width = cardsWidth + LAYER_SHADOW_PX + TOAST_VIEWPORT_INSET_PX;
      const height = cardsHeight + LAYER_SHADOW_PX + TOAST_VIEWPORT_INSET_PX;
      const zoom = zoomFactor();
      const rect = cardsHeight > 0 && cardsWidth > 0
        ? {
          x: Math.round((box.right - width) * zoom),
          y: Math.round((box.bottom - height) * zoom),
          width: Math.round(width * zoom),
          height: Math.round(height * zoom),
        }
        : null;
      const key = JSON.stringify(rect);
      if (key === last) return;
      last = key;
      void place(rect);
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    update();
    scheduleRef.current = schedule;
    // A card's own size changes come from the layer's ResizeObserver, which
    // must be the layer realm's to be notified. A hidden window reports no
    // resizes at all, so cards arriving while it is hidden are caught by a
    // mutation observer (and by every render, below) instead.
    const LayerResizeObserver = (layer.window as Window & typeof globalThis).ResizeObserver;
    const hostObserver = LayerResizeObserver ? new LayerResizeObserver(schedule) : null;
    hostObserver?.observe(host);
    const contentObserver = new MutationObserver(schedule);
    contentObserver.observe(host, { childList: true, subtree: true, characterData: true });
    const parentObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    parentObserver?.observe(parent);
    window.addEventListener("resize", schedule);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      scheduleRef.current = null;
      hostObserver?.disconnect();
      contentObserver.disconnect();
      parentObserver?.disconnect();
      window.removeEventListener("resize", schedule);
      void place(null);
    };
  }, [layer, viewportRef, wanted]);

  if (layer && layer.window.closed) return null;
  return wanted && layer ? layer.host : null;
}

/**
 * The one bottom-right notice corner. It owns placement for everything that
 * floats there — position, width, gap, stacking layer, pointer handling and
 * order — so no toast-like surface positions itself.
 *
 * Always mounted (so exit animations can play) and `pointer-events: none`, so
 * the empty corner never swallows clicks; every card re-enables its own.
 *
 * Order, top to bottom: store toasts (oldest first), then the one situational
 * suggestion (`useAppBanner(..., { placement: "suggestion" })`), which stays
 * put while toasts come and go above it, then the live panels in `slots`
 * order (the ADE Cloud lane changes, then the Launches panel, which sits
 * closest to the corner).
 *
 * When a live browser page covers the corner, the same stack is drawn in the
 * notice layer instead (`noticeLayer`): a see-through window over this same
 * corner, above the page. The cards stay exactly where they always are, and
 * the page around them stays live (drawn here, they would freeze it).
 */
export function ToastViewport({
  slots = NO_SLOTS,
}: {
  /** Live panels, top to bottom; a null node is not drawn. */
  slots?: ReadonlyArray<{ key: string; node: ReactNode }>;
}) {
  const suggestion = useVisibleAppSuggestion();
  const toasts = useToasts();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [stackHeight, setStackHeight] = useState(0);
  const coveringPage = useCoveringBrowserPage(viewportRef, stackHeight);
  const liveSlots = useMemo(() => slots.filter((panel) => panel.node != null), [slots]);
  const count = toasts.length + (suggestion ? 1 : 0) + liveSlots.length;

  // Open the layer only once there is something to show; once open, keep
  // drawing there while the page covers the corner, so a card's exit
  // animation plays out above the page instead of jumping back under it.
  const [layerUsed, setLayerUsed] = useState(false);
  const wantsLayer = coveringPage != null && (count > 0 || layerUsed);
  useEffect(() => {
    if (wantsLayer && count > 0) setLayerUsed(true);
  }, [count, wantsLayer]);
  const layerHost = useNoticeLayerHost(wantsLayer, viewportRef, setStackHeight);

  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => {
      // Only the corner's own height counts; while the cards are in the layer
      // the corner is empty and the layer reports their height instead.
      if (element.childElementCount > 0) setStackHeight(Math.round(element.getBoundingClientRect().height));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const content = (
    <>
      <ToastStack />
      <AnimatePresence initial={false}>
        {suggestion ? (
          <motion.div key={`suggestion:${suggestion.id}`} {...TOAST_MOTION_PROPS}>
            <AppSuggestionCard entry={suggestion} />
          </motion.div>
        ) : null}
      </AnimatePresence>
      <AnimatePresence initial={false}>
        {liveSlots.map((panel) => (
          <motion.div key={panel.key} {...TOAST_MOTION_PROPS}>
            {panel.node}
          </motion.div>
        ))}
      </AnimatePresence>
    </>
  );

  return (
    <div
      ref={viewportRef}
      data-testid="toast-viewport"
      data-ade-toast-viewport=""
      data-in-notice-layer={layerHost ? "" : undefined}
      style={{
        position: "absolute",
        right: TOAST_VIEWPORT_INSET_PX,
        bottom: TOAST_VIEWPORT_INSET_PX,
        zIndex: Z_LAYERS.toast,
        width: `min(${MAX_WIDTH_PX}px, calc(100% - ${TOAST_VIEWPORT_INSET_PX * 2}px))`,
        display: "flex",
        flexDirection: "column",
        justifyContent: "flex-end",
        gap: TOAST_VIEWPORT_GAP_PX,
        pointerEvents: "none",
      }}
    >
      {layerHost ? createPortal(content, layerHost) : content}
    </div>
  );
}
