import { useEffect, useRef, useState } from "react";

/**
 * The captured thumbnail flying into the composer.
 *
 * Two frames, no animation library: start big and centred, end small over the
 * composer, with a CSS transition between them. Mounted only when the user has
 * NOT asked for reduced motion — `GlobalCaptureGestureHost` makes that call, so
 * this component is free to assume motion is wanted.
 *
 * `pointer-events: none` throughout: the thumbnail passes over the transcript
 * and the composer, and a 300ms overlay that eats a click would be worse than
 * no animation at all.
 */

const FLIGHT_MS = 420;

/**
 * Where the thumbnail lands: the composer shell if one is mounted, otherwise
 * the bottom centre of the viewport. `[data-chat-composer-mode]` is the
 * composer's own stable attribute — the fallback matters because the capture
 * can land before the CTO tab has finished mounting its composer.
 */
function composerTarget(): { x: number; y: number } {
  const composer = document.querySelector<HTMLElement>("[data-chat-composer-mode]");
  if (composer) {
    const rect = composer.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      return { x: rect.left + 32, y: rect.top + rect.height / 2 };
    }
  }
  return { x: window.innerWidth / 2, y: window.innerHeight - 80 };
}

export function CaptureFlyIn({
  dataUrl,
  onDone,
}: {
  dataUrl: string;
  onDone: () => void;
}) {
  const [landed, setLanded] = useState(false);
  const targetRef = useRef(composerTarget());

  useEffect(() => {
    // Two rAFs, not one: the first frame has to paint the start state or the
    // browser collapses both into the end state and nothing appears to move.
    const cleanup: Array<() => void> = [];
    const first = requestAnimationFrame(() => {
      const second = requestAnimationFrame(() => setLanded(true));
      cleanup.push(() => cancelAnimationFrame(second));
    });
    cleanup.push(() => cancelAnimationFrame(first));
    const timer = window.setTimeout(onDone, FLIGHT_MS + 80);
    return () => {
      cleanup.forEach((fn) => fn());
      window.clearTimeout(timer);
    };
  }, [onDone]);

  const target = targetRef.current;
  const startWidth = Math.min(360, window.innerWidth * 0.4);

  return (
    <img
      src={dataUrl}
      alt=""
      aria-hidden="true"
      data-capture-fly-in
      style={{
        position: "fixed",
        left: 0,
        top: 0,
        width: startWidth,
        maxHeight: "40vh",
        objectFit: "cover",
        borderRadius: 10,
        pointerEvents: "none",
        zIndex: 2147483001,
        boxShadow: "0 24px 64px rgba(0,0,0,0.35)",
        transformOrigin: "top left",
        transform: landed
          ? `translate(${target.x - 18}px, ${target.y - 18}px) scale(0.08)`
          : `translate(${window.innerWidth / 2 - startWidth / 2}px, ${window.innerHeight / 2 - startWidth / 3}px) scale(1)`,
        opacity: landed ? 0 : 1,
        transition: `transform ${FLIGHT_MS}ms cubic-bezier(0.4, 0, 0.2, 1), opacity ${FLIGHT_MS}ms ease-in`,
      }}
    />
  );
}
