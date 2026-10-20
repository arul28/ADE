import { useEffect, type RefObject } from "react";

/** Wheel input is ignored until this time, so a jump is not undone by trackpad momentum. */
let jumpUntil = 0;

/** Scroll to `top` and keep the wheel from pulling the page back while it moves. */
export function jumpTo(top: number): void {
  jumpUntil = performance.now() + 1200;
  window.dispatchEvent(new Event("ade-story-jump"));
  window.scrollTo({ top, behavior: "smooth" });
}

/**
 * Wheel scrolling for a pinned scroll story: the page glides to where the
 * wheel points, and one gesture cannot pass the next resting point. A hard
 * flick (or a trackpad's momentum) therefore stops at the next step of the
 * story; the next gesture goes on from there. Outside the section, and at its
 * two ends, the wheel scrolls the page as usual.
 *
 * `rests` are offsets in px from the section's top. Keyboard, scrollbar and
 * touch scrolling are left alone.
 */
export function useStepScroll(sectionRef: RefObject<HTMLElement | null>, rests: number[], enabled = true): void {
  useEffect(() => {
    const section = sectionRef.current;
    if (!enabled || !section) return;
    /** A pause longer than this ends a gesture. */
    const GESTURE_GAP_MS = 140;
    /** Holding the wheel this long at a resting point lets the gesture carry on past it. */
    const PASS_AFTER_MS = 260;
    let heldSince: number | null = null;
    let target: number | null = null;
    let lastWheelAt = 0;
    let gestureFrom = 0;
    let frame: number | null = null;

    const range = () => {
      const top = section.getBoundingClientRect().top + window.scrollY;
      const end = top + section.offsetHeight - window.innerHeight;
      return { top, end, stops: [top, ...rests.map((r) => top + r), end].sort((a, b) => a - b) };
    };

    const glide = () => {
      frame = null;
      if (target == null) return;
      const now = window.scrollY;
      const gap = target - now;
      if (Math.abs(gap) < 0.6) {
        window.scrollTo(0, target);
        target = null;
        return;
      }
      window.scrollTo(0, now + gap * 0.2);
      frame = window.requestAnimationFrame(glide);
    };

    const onJump = () => {
      target = null;
      if (frame != null) window.cancelAnimationFrame(frame);
      frame = null;
    };

    const onWheel = (event: WheelEvent) => {
      if (performance.now() < jumpUntil) {
        event.preventDefault();
        return;
      }
      if (event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      const { top, end, stops } = range();
      const from = target ?? window.scrollY;
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight : 1);
      // Outside the section, or leaving it through one of its ends: the page's own scroll.
      if (from < top - 1 || from > end + 1) return;
      if ((delta > 0 && from >= end - 1) || (delta < 0 && from <= top + 1)) {
        target = null;
        return;
      }
      event.preventDefault();
      const now = performance.now();
      if (now - lastWheelAt > GESTURE_GAP_MS) {
        gestureFrom = from;
        heldSince = null;
      }
      lastWheelAt = now;
      // A gesture that keeps pushing at a resting point goes on after a short pause there.
      const atStop = stops.some((stop) => Math.abs(stop - from) < 2 && Math.abs(stop - gestureFrom) > 1);
      if (atStop) {
        heldSince ??= now;
        if (now - heldSince > PASS_AFTER_MS) {
          gestureFrom = from;
          heldSince = null;
        }
      }
      const limit = delta > 0
        ? stops.find((stop) => stop > gestureFrom + 1) ?? end
        : [...stops].reverse().find((stop) => stop < gestureFrom - 1) ?? top;
      const next = from + delta;
      target = delta > 0 ? Math.min(next, limit) : Math.max(next, limit);
      if (frame == null) frame = window.requestAnimationFrame(glide);
    };

    window.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("ade-story-jump", onJump);
    return () => {
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("ade-story-jump", onJump);
      if (frame != null) window.cancelAnimationFrame(frame);
    };
  }, [enabled, rests, sectionRef]);
}
