import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { AppControlScreencastFrame } from "../../../shared/types";
import type { LiveFrameDims } from "./appControlFrameGeometry";

/**
 * The App Control panel's live-frame transport, on its own.
 *
 * A screencast at 30+ fps cannot go through React state — the panel would
 * re-render thirty times a second to swap one `src`. So frames are stashed on a
 * ref and one `requestAnimationFrame` paints the freshest onto the `<img>`
 * directly; React sees exactly two renders per session (the first frame, and
 * the loss of it). That machinery is eight refs, a raf pump, a health tick and
 * three pieces of state, none of which the rest of the panel reads — which is
 * why it lives here instead of interleaved with the panel's twenty other
 * effects.
 *
 * Deliberately NOT its own `appControl.onEvent` subscription: the panel's
 * single subscription also drives status, trace and the session reset, and the
 * ordering between "a frame arrived" and "the session stopped" is load-bearing
 * for the disconnect UI. The panel keeps the subscription and calls
 * {@link AppControlLiveFrame.onFrame} / {@link AppControlLiveFrame.reset}.
 */
export type AppControlLiveFrame = {
  /** True once a frame has arrived; the panel swaps the static shot for the live one. */
  active: boolean;
  /** The first frame, so the `<img>` has a `src` before the raf pump takes over. */
  initialSrc: string | null;
  /**
   * The last frame painted before the session went away, kept so a DROPPED
   * session can show it dimmed behind Reconnect rather than blanking.
   */
  staleSrc: string | null;
  /** Metrics of the frame currently on screen, for the geometry helpers. */
  dimsRef: RefObject<LiveFrameDims | null>;
  /** Milliseconds since the last frame, or null when nothing is live. */
  ageMs: number | null;
  /** Feed one screencast frame. Frames for another CDP target are dropped. */
  onFrame: (frame: AppControlScreencastFrame, activeTargetId: string | null) => void;
  /** The session went away: keep the last frame as the stale one, drop the rest. */
  reset: () => void;
  /** A reattach: drop everything including the stale frame. */
  clear: () => void;
};

/** Past this with no frame the feed is presumed wedged rather than idle. */
export const APP_CONTROL_FRAME_STALE_MS = 4_000;

export function useAppControlLiveFrame(
  imageRef: RefObject<HTMLImageElement | null>,
): AppControlLiveFrame {
  const [active, setActive] = useState(false);
  const [initialSrc, setInitialSrc] = useState<string | null>(null);
  const [staleSrc, setStaleSrc] = useState<string | null>(null);
  /** A slow tick so "no frames for 4s" becomes visible without a per-frame render. */
  const [healthTick, setHealthTick] = useState(0);

  const dimsRef = useRef<LiveFrameDims | null>(null);
  const activeRef = useRef(false);
  const srcRef = useRef<string | null>(null);
  const pendingSrcRef = useRef<string | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastAtRef = useRef<number | null>(null);

  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setInterval(() => setHealthTick((value) => value + 1), 2_000);
    return () => window.clearInterval(timer);
  }, [active]);

  // The pump must not outlive the panel: an unmount mid-frame would otherwise
  // leave one scheduled callback writing into a detached `<img>`.
  useEffect(() => () => {
    if (rafRef.current != null) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const onFrame = useCallback((frame: AppControlScreencastFrame, activeTargetId: string | null) => {
    if (frame.cdpTargetId !== activeTargetId) return;
    const src = `data:${frame.mimeType};base64,${frame.data}`;
    srcRef.current = src;
    lastAtRef.current = Date.now();
    if (!activeRef.current) setInitialSrc(src);
    // Hot path: stash the latest data URL and let one rAF paint the freshest.
    pendingSrcRef.current = src;
    if (frame.width > 0 && frame.height > 0) {
      dimsRef.current = {
        width: frame.width,
        height: frame.height,
        viewportWidth: frame.viewportWidth && frame.viewportWidth > 0
          ? frame.viewportWidth
          : Math.round(frame.width / (frame.scale || 1)),
        viewportHeight: frame.viewportHeight && frame.viewportHeight > 0
          ? frame.viewportHeight
          : Math.round(frame.height / (frame.scale || 1)),
        scale: frame.scale || frame.scaleX || 1,
        scaleX: frame.scaleX || frame.scale || 1,
        scaleY: frame.scaleY || frame.scale || 1,
      };
    }
    if (rafRef.current == null) {
      rafRef.current = window.requestAnimationFrame(() => {
        rafRef.current = null;
        const next = pendingSrcRef.current;
        pendingSrcRef.current = null;
        if (next && imageRef.current) imageRef.current.src = next;
      });
    }
    // Flip to "live" once, on the first frame: one React render swaps the
    // static screenshot out for the live `<img>`.
    setActive((current) => {
      if (current) return current;
      activeRef.current = true;
      setStaleSrc(null);
      return true;
    });
  }, [imageRef]);

  const reset = useCallback(() => {
    // Keep the last painted frame so a dropped session can show it dimmed
    // behind Reconnect instead of blanking to an empty pane.
    setStaleSrc(srcRef.current);
    setActive(false);
    setInitialSrc(null);
    activeRef.current = false;
    dimsRef.current = null;
    lastAtRef.current = null;
    srcRef.current = null;
    pendingSrcRef.current = null;
  }, []);

  const clear = useCallback(() => {
    setStaleSrc(null);
    setActive(false);
    setInitialSrc(null);
    activeRef.current = false;
    dimsRef.current = null;
    lastAtRef.current = null;
    srcRef.current = null;
    pendingSrcRef.current = null;
  }, []);

  // `healthTick` is read only to re-evaluate this on the 2s beat; the age comes
  // from the ref the frame handler writes.
  void healthTick;
  const ageMs = active && lastAtRef.current != null ? Date.now() - lastAtRef.current : null;

  return { active, initialSrc, staleSrc, dimsRef, ageMs, onFrame, reset, clear };
}
