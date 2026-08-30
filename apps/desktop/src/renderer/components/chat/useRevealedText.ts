import { useCallback, useEffect, useRef, useState } from "react";

import {
  beginReveal,
  completeReveal,
  isTextRevealEnabled,
  readTextRevealHorizonMs,
  retargetReveal,
  stepReveal,
  type RevealState,
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
  // Visibility lives in a ref, not state: a tab switch or a scroll must not
  // re-render the row, it only has to stop the loop.
  const visibleRef = useRef(true);
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
    stateRef.current = previous === null
      ? beginReveal(text, { instant: true })
      : retargetReveal(previous, text);
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
    if (!visibleRef.current) return;
    const frame = (now: number) => {
      const state = stateRef.current;
      if (!state || !visibleRef.current) {
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
  }, [horizonMs, rerender]);

  // Observers: bound once per (enabled) row, not per delta.
  useEffect(() => {
    if (!enabled) return;
    const applyVisibility = (visible: boolean) => {
      if (visible === visibleRef.current) return;
      visibleRef.current = visible;
      if (visible) start();
      else flush();
    };
    const onDocumentVisibility = () => {
      applyVisibility(document.visibilityState !== "hidden");
    };

    visibleRef.current = document.visibilityState !== "hidden";
    document.addEventListener("visibilitychange", onDocumentVisibility);

    let observer: IntersectionObserver | null = null;
    const host = hostRef.current;
    if (host && typeof IntersectionObserver !== "undefined") {
      observer = new IntersectionObserver((entries) => {
        const entry = entries[entries.length - 1];
        if (!entry) return;
        applyVisibility(entry.isIntersecting && document.visibilityState !== "hidden");
      });
      observer.observe(host);
    }

    return () => {
      document.removeEventListener("visibilitychange", onDocumentVisibility);
      observer?.disconnect();
      stop();
    };
  }, [enabled, flush, hostRef, start, stop]);

  // Each store delta widens the backlog; make sure a loop is running for it.
  useEffect(() => {
    if (!enabled) {
      stop();
      return;
    }
    start();
  }, [enabled, start, stop, text]);

  // Leaving the paced role (turn done, a newer row took the tail) must snap to
  // the full text — never leave a truncated message on screen.
  useEffect(() => {
    if (!enabled) return;
    return () => {
      const state = stateRef.current;
      if (state) stateRef.current = completeReveal(state);
    };
  }, [enabled]);

  const state = stateRef.current;
  if (!enabled || !state) return text.length;
  return Math.min(state.revealed, text.length);
}
