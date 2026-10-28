import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { ScreenBox } from "../ui/LiquidGlassLogoReveal";
import { useAdeWordmarkSrc } from "../ui/AdeWordmark";
import { Z_LAYERS } from "../ui/zLayers";

/**
 * The after-update arrival: the ADE logo flies from where the boot splash left
 * it into the "What's new" header while the window opens around it. With no
 * splash just before (ADE opened to a screen without one, or the update record
 * came late) it rises in the middle of the window first, then flies.
 *
 * Coming from the splash, a veil in the page colour holds the splash's
 * backdrop for a moment and dissolves, so the app and the dimmed window come
 * up behind the logo instead of cutting in.
 *
 * The logo and veil mount first, in the frame the splash goes; the window
 * mounts a frame later (`useArrivalDialogReady`), while the logo still holds.
 * Mounting both at once made that one frame ~50ms. The flight measures where
 * it lands only once the window is there.
 *
 * One `<img>` and one veil on their own layers, moved with transform and
 * opacity: they run on the compositor and are gone after about a second.
 */

/** How long the logo holds still before it flies, so the eye finds it first. */
const HOLD_MS = 240;
/** The rise in the middle, when there is no splash to come from. */
const RISE_MS = 300;
/** The flight itself, from the hold to the header. */
const FLY_MS = 900;

/**
 * False for the frame the arrival starts in, then true: the caller mounts the
 * window once this turns true, so the splash's last frame and the window's
 * first never share one frame.
 */
export function useArrivalDialogReady(arrives: boolean): boolean {
  const [ready, setReady] = useState(!arrives);
  useEffect(() => {
    if (ready) return undefined;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setReady(true));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [ready]);
  return ready;
}

export function WhatsNewLogoFlight({
  from,
  target,
  targetReady,
  onLanded,
}: {
  /** The wordmark's box in the splash that just went, or null to rise in the middle. */
  from: ScreenBox | null;
  /** The header wordmark the flight ends on. */
  target: RefObject<HTMLElement | null>;
  /** Whether the window (and so `target`) is on screen yet. */
  targetReady: boolean;
  onLanded: () => void;
}) {
  const src = useAdeWordmarkSrc();
  const ref = useRef<HTMLImageElement>(null);
  const veilRef = useRef<HTMLDivElement>(null);
  const landedRef = useRef(onLanded);
  landedRef.current = onLanded;
  const startRef = useRef<ScreenBox | null>(null);
  const mountedAtRef = useRef(0);

  // Before the first paint: the logo sits where the splash left it, or rises in the middle.
  useLayoutEffect(() => {
    const img = ref.current;
    if (!img) return undefined;
    const start = from ?? risingStart();
    startRef.current = start;
    mountedAtRef.current = performance.now();
    img.style.left = `${start.left}px`;
    img.style.top = `${start.top}px`;
    img.style.width = `${start.width}px`;
    img.style.height = `${start.height}px`;
    const rise = from
      ? null
      : img.animate(
          // The origin is the top left, so the shrink is moved back to the middle.
          [{ opacity: 0, transform: "translate(7%, 7%) scale(0.86)" }, { opacity: 1, transform: "none" }],
          { duration: RISE_MS, easing: "cubic-bezier(0.16, 1, 0.3, 1)", fill: "backwards" },
        );
    const veil = veilRef.current?.animate(
      [{ opacity: 1 }, { opacity: 1, offset: 0.15 }, { opacity: 0 }],
      { duration: 620, easing: "ease-out", fill: "forwards" },
    );
    return () => {
      rise?.cancel();
      veil?.cancel();
    };
    // The arrival runs once, from the box it mounted with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Once the window is up: read where the header mark is, and fly there. The
  // dialog's portal fills in a commit after it mounts, so the mark can take a
  // frame or two to exist.
  useLayoutEffect(() => {
    if (!targetReady) return undefined;
    let flight: Animation | null = null;
    let frame = 0;
    let tries = 0;
    const fly = () => {
      const img = ref.current;
      const goal = target.current;
      const start = startRef.current;
      if (!img || !start) return landedRef.current();
      if (!goal) {
        if (++tries > 30) return landedRef.current();
        frame = requestAnimationFrame(fly);
        return;
      }
      // The panel's entrance scales it; read where the mark lands without it.
      const panel = goal.closest<HTMLElement>(".ade-dialog-panel");
      const entrance = panel?.style.animation ?? "";
      if (panel) panel.style.animation = "none";
      const end = goal.getBoundingClientRect();
      if (panel) panel.style.animation = entrance;
      if (end.width === 0) return landedRef.current();
      const scale = end.width / start.width;
      const hold = (from ? HOLD_MS : RISE_MS + HOLD_MS / 2) - (performance.now() - mountedAtRef.current);
      flight = img.animate(
        [
          { transform: "none" },
          { transform: `translate(${end.left - start.left}px, ${end.top - start.top}px) scale(${scale})` },
        ],
        { duration: FLY_MS, delay: Math.max(0, hold), easing: "cubic-bezier(0.7, 0, 0.18, 1)", fill: "forwards" },
      );
      flight.onfinish = () => landedRef.current();
    };
    fly();
    return () => {
      cancelAnimationFrame(frame);
      flight?.cancel();
    };
    // As above: one flight, to where the mark was when the window came up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetReady]);

  return createPortal(
    <>
      {from ? (
        <div ref={veilRef} aria-hidden className="ade-whats-new-veil" style={{ zIndex: Z_LAYERS.nestedDialog - 1 }} />
      ) : null}
      <img
        ref={ref}
        src={src}
        alt=""
        aria-hidden
        draggable={false}
        className="ade-whats-new-flight"
        style={{ zIndex: Z_LAYERS.nestedDialog }}
      />
    </>,
    document.body,
  );
}

/** Where the logo rises in with no splash to come from: the middle of the window, splash-sized. */
function risingStart(): ScreenBox {
  const width = Math.min(300, window.innerWidth * 0.36);
  // The wordmark picture is 1012 x 493.
  const height = (width * 493) / 1012;
  return {
    left: (window.innerWidth - width) / 2,
    top: (window.innerHeight - height) / 2,
    width,
    height,
  };
}
