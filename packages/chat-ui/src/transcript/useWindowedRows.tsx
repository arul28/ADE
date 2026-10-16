/**
 * Windowing for the transcript: past `threshold` rows, only the rows in view
 * plus `overscan` rows either side are mounted, with spacers standing in for
 * the rest.
 *
 * Row heights are measured as rows mount (ResizeObserver) and estimated until
 * then. No dependency: it is a prefix sum and two binary searches. Where there
 * is no layout to measure (no ResizeObserver, a zero-height container, server
 * rendering) every row renders.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";

/** Distance from the bottom, in px, that still counts as "at the bottom". */
const BOTTOM_THRESHOLD_PX = 32;
/** Height assumed for a row before it is measured, until an average exists. */
const ESTIMATED_ROW_HEIGHT_PX = 72;

/** First index whose value is greater than `target` in an ascending array. */
function upperBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (values[mid]! <= target) low = mid + 1;
    else high = mid;
  }
  return low;
}

export type WindowedRows<Row> = {
  /** The rows to mount: all of `visible`, or the window of it. */
  rendered: readonly Row[];
  /** Height of the spacer standing in for the unmounted rows above. */
  topSpacer: number;
  /** Height of the spacer standing in for the unmounted rows below. */
  bottomSpacer: number;
  /** Attach to the scroll container. */
  scrollRef: MutableRefObject<HTMLDivElement | null>;
  /**
   * True while the reader is at the bottom. Updated by `onScroll`; the window
   * is laid out from the bottom while it holds, so a row that just streamed
   * in is mounted before the caller scrolls to it.
   */
  pinnedRef: MutableRefObject<boolean>;
  /** Call from the scroll container's scroll handler. */
  onScroll: () => void;
  /** Observe each mounted row's wrapper (with `data-row-key`) while mounted. */
  observer: ResizeObserver | null;
  /**
   * The row start offsets the window was computed from, or null when not
   * windowed. Changes whenever the layout does, so it is a dependency for
   * effects that must run after the window moves.
   */
  offsets: readonly number[] | null;
};

export function useWindowedRows<Row extends { key: string }>(
  visible: readonly Row[],
  { threshold, overscan }: { threshold: number; overscan: number },
): WindowedRows<Row> {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  /** The scroll container's scrollTop and height, as last rendered against. */
  const [viewport, setViewport] = useState({ top: 0, height: 0 });
  /** Measured row heights by row key. Survives rows leaving the window. */
  const heightsRef = useRef(new Map<string, number>());
  /** Bumped (once per frame at most) when a measured height changes. */
  const [measureVersion, setMeasureVersion] = useState(0);
  const gapRef = useRef(0);
  const frameRef = useRef<number | null>(null);

  // Every task queued before the frame runs is kept. One slot would drop a
  // height measurement that arrives while a scroll frame is pending, and the
  // spacers would keep the old estimates.
  const frameTasksRef = useRef(new Set<() => void>());
  const scheduleFrame = useCallback((task: () => void) => {
    frameTasksRef.current.add(task);
    if (frameRef.current !== null) return;
    const run = () => {
      frameRef.current = null;
      const tasks = [...frameTasksRef.current];
      frameTasksRef.current.clear();
      for (const next of tasks) next();
    };
    frameRef.current =
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame(run)
        : (setTimeout(run, 16) as unknown as number);
  }, []);

  const readViewport = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    setViewport((current) =>
      current.top === node.scrollTop && current.height === node.clientHeight
        ? current
        : { top: node.scrollTop, height: node.clientHeight },
    );
  }, []);

  const onScroll = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    pinnedRef.current = distance <= BOTTOM_THRESHOLD_PX;
    scheduleFrame(readViewport);
  }, [readViewport, scheduleFrame]);

  const observer = useMemo(() => {
    if (typeof ResizeObserver === "undefined") return null;
    return new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const target = entry.target as HTMLElement;
        if (target === scrollRef.current) {
          changed = true;
          continue;
        }
        const key = target.dataset.rowKey;
        if (!key) continue;
        const height = target.offsetHeight;
        if (heightsRef.current.get(key) !== height) {
          heightsRef.current.set(key, height);
          changed = true;
        }
      }
      if (changed) {
        scheduleFrame(() => {
          readViewport();
          setMeasureVersion((value) => value + 1);
        });
      }
    });
  }, [readViewport, scheduleFrame]);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) {
      const gap = Number.parseFloat(getComputedStyle(node).rowGap);
      gapRef.current = Number.isFinite(gap) ? gap : 0;
      observer?.observe(node);
      readViewport();
    }
    return () => {
      observer?.disconnect();
      if (frameRef.current !== null) {
        if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(frameRef.current);
        else clearTimeout(frameRef.current);
        frameRef.current = null;
      }
      frameTasksRef.current.clear();
    };
  }, [readViewport, observer]);

  const windowed = observer !== null && viewport.height > 0 && visible.length > threshold;

  /**
   * `offsets[i]` is where row i starts, measured from the first row, each row
   * contributing its height plus the container's gap. Estimated rows use the
   * mean of the measured ones.
   */
  const offsets = useMemo(() => {
    if (!windowed) return null;
    let measuredTotal = 0;
    let measuredCount = 0;
    for (const row of visible) {
      const height = heightsRef.current.get(row.key);
      if (height !== undefined) {
        measuredTotal += height;
        measuredCount += 1;
      }
    }
    const estimate = measuredCount ? measuredTotal / measuredCount : ESTIMATED_ROW_HEIGHT_PX;
    const gap = gapRef.current;
    const result = new Array<number>(visible.length + 1);
    result[0] = 0;
    for (let index = 0; index < visible.length; index += 1) {
      const height = heightsRef.current.get(visible[index]!.key) ?? estimate;
      result[index + 1] = result[index]! + height + gap;
    }
    return result;
    // `measureVersion` is the signal that `heightsRef` changed.
  }, [windowed, visible, measureVersion]);

  let start = 0;
  let end = visible.length - 1;
  if (offsets) {
    const total = offsets[visible.length]!;
    // Pinned: lay the window out from the bottom, so a row that just streamed
    // in is mounted before the caller's scroll-to-bottom runs.
    const top = pinnedRef.current ? Math.max(0, total - viewport.height) : viewport.top;
    const first = Math.max(0, upperBound(offsets, top) - 1);
    const last = Math.min(visible.length - 1, upperBound(offsets, top + viewport.height) - 1);
    start = Math.max(0, first - overscan);
    end = Math.min(visible.length - 1, last + overscan);
  }
  const gap = gapRef.current;
  const topSpacer = offsets && start > 0 ? Math.max(0, offsets[start]! - gap) : 0;
  const bottomSpacer =
    offsets && end < visible.length - 1
      ? Math.max(0, offsets[visible.length]! - offsets[end + 1]! - gap)
      : 0;
  const rendered = offsets ? visible.slice(start, end + 1) : visible;

  return { rendered, topSpacer, bottomSpacer, scrollRef, pinnedRef, onScroll, observer, offsets };
}

/**
 * The measured wrapper around one row. Observed while mounted and released on
 * unmount, so rows that scroll out of the window are not held by the observer.
 */
export function RowSlot({
  rowKey,
  observer,
  children,
}: {
  rowKey: string;
  observer: ResizeObserver | null;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || !observer) return;
    observer.observe(node);
    return () => observer.unobserve(node);
  }, [observer]);
  return (
    <div ref={ref} className="adechat-row-slot" data-row-key={rowKey}>
      {children}
    </div>
  );
}
