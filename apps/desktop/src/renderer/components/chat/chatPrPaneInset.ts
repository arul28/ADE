import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

/**
 * Measured VIEWPORT-space bottom edge (px) of the floating PR pane card, or
 * `null` when no PR pane is floating over the transcript.
 *
 * Why an edge and not a height: the pane is positioned against the chat surface
 * (`absolute top-3`) while the minimap rail is positioned against the
 * message-list root, which sits below the chat header and the sync hairline.
 * Publishing a height would force the consumer to bridge those two origins with
 * a constant — one that duplicates the pane's `top-3` and is wrong by the height
 * of any chrome between them. Viewport space is the one frame both boxes can be
 * measured in, so the consumer just subtracts its own rect.
 *
 * Why context and not a prop: the floating PR pane and the message list are
 * SIBLINGS mounted from different branches of `AgentChatPane`. Threading the
 * value down as a prop would have to pass through the memoized
 * `AgentChatMessageList`, so every PR-pane resize frame would re-render the
 * whole transcript. Context keeps the fan-out to the single consumer that
 * actually needs the number (the minimap rail).
 */
export const ChatPrPaneInsetContext = createContext<number | null>(null);

/** Read the floating PR pane's viewport-space bottom; `null` when none is floating. */
export function useChatPrPaneInset(): number | null {
  return useContext(ChatPrPaneInsetContext);
}

/**
 * Sub-pixel churn (zoom, backdrop-filter reflow, fractional layout) would
 * otherwise publish a new context value on frames where nothing visibly moved.
 */
const PR_PANE_BOTTOM_DEADBAND_PX = 1;
/**
 * How far up the offset-parent chain to watch for layout shifts. The card's own
 * offset parent is its animation wrapper (which moves with it and so carries no
 * signal); the chat surface that actually positions it sits one level above.
 * Two is enough today, with one spare level of slack for future chrome.
 */
const PR_PANE_OFFSET_ANCESTOR_DEPTH = 3;

export type ChatPrPaneInsetObserver = {
  /**
   * Ref callback for the floating PR pane card element. Attaching starts a
   * `ResizeObserver`; detaching (`null`) disconnects it and reports `null`.
   */
  ref: (node: HTMLElement | null) => void;
  /**
   * Latest measured viewport-space bottom edge, or `null` while nothing is
   * attached. Feed this straight into `ChatPrPaneInsetContext.Provider value=`.
   */
  bottomViewportPx: number | null;
};

/**
 * Measure the floating PR pane so the minimap rail can re-centre in the space
 * that is actually left below it.
 *
 * Why `ResizeObserver` rather than the alternatives:
 * - CSS-only (e.g. a sibling flex/grid track) cannot work, because the rail has
 *   to both re-centre in the REMAINING band and go fully inert when that band
 *   is too short — both decisions happen in JS and need the number.
 * - A fixed reserve cannot work either: the pane's height is content-driven
 *   (~260px showing PR details vs ~430px showing the create form), so any
 *   constant is wrong in one of the two states.
 * - It is not hidden polling: `ResizeObserver` fires only on real size changes,
 *   and the 1px deadband keeps it from re-rendering on measurement noise.
 */
export function usePrPaneInsetObserver(): ChatPrPaneInsetObserver {
  const [bottomViewportPx, setBottomViewportPx] = useState<number | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const nodeRef = useRef<HTMLElement | null>(null);
  // Mirrors `bottomViewportPx` so the deadband can compare without re-creating
  // the observer callback on every measured change.
  const bottomRef = useRef<number | null>(null);

  const report = useCallback((next: number | null) => {
    const current = bottomRef.current;
    if (next === null) {
      if (current === null) return;
      bottomRef.current = null;
      setBottomViewportPx(null);
      return;
    }
    if (!Number.isFinite(next)) return;
    if (current !== null && Math.abs(next - current) < PR_PANE_BOTTOM_DEADBAND_PX) return;
    bottomRef.current = next;
    setBottomViewportPx(next);
  }, []);

  // `getBoundingClientRect()` is already border-box, which is what the rail has
  // to clear: the card has a 1px border and the rail offsets from its outer edge.
  const measure = useCallback(() => {
    const node = nodeRef.current;
    report(node ? node.getBoundingClientRect().bottom : null);
  }, [report]);

  const ref = useCallback(
    (node: HTMLElement | null) => {
      // Re-attach must never leave the previous observer running.
      observerRef.current?.disconnect();
      observerRef.current = null;
      nodeRef.current = node;
      if (!node) {
        report(null);
        return;
      }
      // Seed synchronously so the rail is inset on the first painted frame
      // instead of jumping once the first observer callback lands.
      measure();
      if (typeof ResizeObserver === "undefined") return;
      const observer = new ResizeObserver(() => measure());
      observer.observe(node);
      // A viewport-space edge has to survive the card MOVING, not just resizing:
      // a banner mounting above the chat surface slides the card down without
      // ever changing its own size, and a `ResizeObserver` on the card alone
      // would never fire.
      //
      // Observing only `node.offsetParent` is NOT enough. The card's offset
      // parent is the framer-motion wrapper immediately above it, which is
      // itself absolutely positioned and stretches with the card — so it
      // resizes in lockstep and carries no new signal. The element that
      // actually defines where the card sits is the chat surface further up.
      // Walk a bounded slice of the offset-parent chain and observe each, so a
      // height change anywhere in it re-measures the card's edge.
      let ancestor: Element | null = node.offsetParent;
      for (let depth = 0; ancestor instanceof Element && depth < PR_PANE_OFFSET_ANCESTOR_DEPTH; depth += 1) {
        observer.observe(ancestor);
        ancestor = ancestor instanceof HTMLElement ? ancestor.offsetParent : null;
      }
      observerRef.current = observer;
    },
    [measure, report],
  );

  useEffect(
    () => () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      nodeRef.current = null;
    },
    [],
  );

  return { ref, bottomViewportPx };
}
