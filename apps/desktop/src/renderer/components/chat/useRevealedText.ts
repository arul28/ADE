import { useCallback, useEffect, useRef, useState } from "react";

import {
  advanceSplitScan,
  beginReveal,
  completeReveal,
  isTextRevealEnabled,
  readTextRevealHorizonMs,
  retargetReveal,
  splitRevealed,
  stepReveal,
  type RevealState,
  type SplitScanState,
} from "./textReveal";

/**
 * rAF binding for the paced text reveal.
 *
 * Everything interesting lives in `textReveal.ts`; this hook only decides when
 * a frame loop may run and re-renders its caller when the revealed length
 * moves. It is meant to be called from a LEAF component that renders nothing
 * but the assistant markdown, so a 60 Hz reveal re-renders one small subtree
 * and never the transcript, the row list, or any derivation above it.
 *
 * The loop runs only while ALL of these hold:
 *   - the caller says this row is the trailing streaming row (`paced`),
 *   - pacing is enabled (horizon > 0 and `Intl.Segmenter` exists),
 *   - the document is visible,
 *   - the row's own element intersects the viewport.
 *
 * Any of them dropping reveals everything immediately and stops the loop, so
 * background grid tiles, hidden windows and scrolled-away rows keep the cheap
 * paint-on-arrival behavior they have today.
 */
export function useRevealedLength(
  text: string,
  paced: boolean,
  hostRef: { current: HTMLElement | null },
): number {
  const horizonMs = readTextRevealHorizonMs();
  const enabled = paced && isTextRevealEnabled(horizonMs);

  const stateRef = useRef<RevealState | null>(null);
  const rafRef = useRef<number | null>(null);
  // Visibility lives in refs, not state: a tab switch or a scroll must not
  // re-render the row, it only has to stop the loop. The two inputs are kept
  // apart because they are observed by two independent sources that each report
  // only their own axis — folding them into one boolean would let a tab-back
  // (`visibilitychange`) claim the row is on screen when it is scrolled away,
  // and the IntersectionObserver would not fire again to correct it.
  const documentVisibleRef = useRef(true);
  const intersectingRef = useRef(true);
  const isVisible = useCallback(
    () => documentVisibleRef.current && intersectingRef.current,
    [],
  );
  const [, bumpTick] = useState(0);
  const rerender = useCallback(() => {
    bumpTick((tick) => tick + 1);
  }, []);

  // Retargeting happens during render so the length returned by this commit
  // always describes the text this commit is rendering. `stateRef` is the
  // source of truth; the tick state exists only to schedule frames' repaints.
  if (!enabled) {
    stateRef.current = null;
  } else {
    const previous = stateRef.current;
    // First sight is whole: a row that mounts already-complete (history,
    // virtualization remount, backfill, a finished message) paints everything
    // at once. Only growth observed after mount is paced.
    const next = previous === null
      ? beginReveal(text, { instant: true })
      : retargetReveal(previous, text);
    // An invisible row paints on arrival. Visibility must gate the *backlog*,
    // not just the frame loop: a scrolled-away or backgrounded row that only
    // stopped its loop would sit on a stale prefix, and the first sight after
    // scrolling back would show a truncated message that then types out the
    // whole accumulated backlog. Completing here means first sight is always
    // the full current text, and it costs nothing — no frame is scheduled.
    stateRef.current = isVisible() ? next : completeReveal(next);
  }

  const stop = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const flush = useCallback(() => {
    stop();
    const state = stateRef.current;
    if (!state || state.revealed >= state.target.length) return;
    stateRef.current = completeReveal(state);
    rerender();
  }, [rerender, stop]);

  const start = useCallback(() => {
    if (rafRef.current !== null) return;
    if (!isVisible()) return;
    const frame = (now: number) => {
      const state = stateRef.current;
      if (!state || !isVisible()) {
        rafRef.current = null;
        return;
      }
      const next = stepReveal(state, now, horizonMs);
      stateRef.current = next;
      if (next.revealed !== state.revealed) rerender();
      if (next.revealed >= next.target.length) {
        // Caught up — stop until more text arrives. An idle streaming row
        // costs nothing.
        rafRef.current = null;
        return;
      }
      rafRef.current = requestAnimationFrame(frame);
    };
    const state = stateRef.current;
    if (!state || state.revealed >= state.target.length) return;
    rafRef.current = requestAnimationFrame(frame);
  }, [horizonMs, isVisible, rerender]);

  // Observers: bound once per (enabled) row, not per delta.
  useEffect(() => {
    if (!enabled) return;
    // Each source updates only its own axis; the loop runs when both agree.
    const applyVisibility = () => {
      if (isVisible()) start();
      else flush();
    };
    const onDocumentVisibility = () => {
      const documentVisible = document.visibilityState !== "hidden";
      if (documentVisible === documentVisibleRef.current) return;
      documentVisibleRef.current = documentVisible;
      applyVisibility();
    };

    documentVisibleRef.current = document.visibilityState !== "hidden";
    document.addEventListener("visibilitychange", onDocumentVisibility);

    let observer: IntersectionObserver | null = null;
    const host = hostRef.current;
    if (host && typeof IntersectionObserver !== "undefined") {
      observer = new IntersectionObserver((entries) => {
        const entry = entries[entries.length - 1];
        if (!entry) return;
        if (entry.isIntersecting === intersectingRef.current) return;
        intersectingRef.current = entry.isIntersecting;
        applyVisibility();
      });
      observer.observe(host);
    }

    return () => {
      document.removeEventListener("visibilitychange", onDocumentVisibility);
      observer?.disconnect();
      stop();
    };
  }, [enabled, flush, hostRef, isVisible, start, stop]);

  // Each store delta widens the backlog; make sure a loop is running for it.
  useEffect(() => {
    if (!enabled) {
      stop();
      return;
    }
    start();
  }, [enabled, start, stop, text]);

  const state = stateRef.current;
  // Unpaced rows — including a row that just lost the paced role (turn done, a
  // newer row took the tail) — read the full text, so leaving the role can
  // never leave a truncated message on screen.
  if (!enabled || !state) return text.length;
  return Math.min(state.revealed, text.length);
}

/**
 * Split the text a paced row is rendering into its settled prefix (whole
 * markdown blocks that will not change again) and the growing tail.
 *
 * The revealed prefix only grows, so each frame rescans just the characters
 * that arrived since the last one, and the settled string keeps its identity
 * while the cut point does not move — which is what lets the settled body's
 * memo bail out instead of reparsing the whole message every frame.
 */
export function useSplitRevealed(
  text: string,
  revealedLength: number,
): { settled: string; tail: string } {
  const cacheRef = useRef<{ scan: SplitScanState; settled: string } | null>(null);
  if (revealedLength >= text.length) {
    cacheRef.current = null;
    return { settled: text, tail: "" };
  }
  const previous = cacheRef.current;
  // The cached scan is only reusable when it stopped at or before the point we
  // now need, and its settled string still matches the cut it recorded.
  const resumable = previous
    && previous.scan.scannedTo <= revealedLength
    && previous.settled.length === previous.scan.settledEnd
    ? previous.scan
    : null;
  const scan = advanceSplitScan(resumable, text, revealedLength);
  const parts = splitRevealed(text, revealedLength, scan);
  // Identity reuse: an unmoved cut point must yield the very same string.
  const settled = previous && previous.settled.length === scan.settledEnd
    ? previous.settled
    : parts.settled;
  cacheRef.current = { scan, settled };
  return { settled, tail: parts.tail };
}
