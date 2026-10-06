import { useEffect, useRef, useState } from "react";

/**
 * When a scene's frame should be up: on (or about to come on) screen, held for
 * a beat, and only once the reader stops scrolling it.
 */

/** On screen this long before a frame mounts: a fast scroll past mounts nothing. */
const SCENE_ACTIVATE_DWELL_MS = 120;
/** Off screen this long before a frame unmounts back to its still. */
const SCENE_DEACTIVATE_LINGER_MS = 4_000;
/** How far outside the transcript's viewport counts as "about to be on screen". */
const SCENE_ACTIVATE_MARGIN = "240px 0px";
/**
 * Scrolling must have paused this long before a frame mounts. A reader moving
 * through a transcript sees stills; frames load where they stop. Measured: a
 * steady scroll through six scenes cost the scene process 12% of a core in
 * mounts when frames loaded as they passed.
 */
const SCENE_SCROLL_QUIET_MS = 150;

/** The nearest ancestor that scrolls, or null for the viewport. */
function scrollParentOf(element: HTMLElement): HTMLElement | null {
  for (let el = element.parentElement; el && el !== document.body; el = el.parentElement) {
    const style = window.getComputedStyle(el);
    if (/(auto|scroll|overlay)/.test(`${style.overflowY} ${style.overflowX}`)) return el;
  }
  return null;
}

/**
 * True while the element is on screen or about to be, with a dwell before it
 * turns true and a linger before it turns false. A parked surface
 * (`content-visibility: hidden`) reads as off screen.
 *
 * `ignoreScroll` drops the scroll-pause gate: while a turn streams, the
 * transcript pins itself to the bottom on every delta, so "the reader stopped
 * scrolling" never comes, and the scene the agent just drew must still appear.
 */
export function useSceneOnScreen(
  target: React.RefObject<HTMLElement | null>,
  enabled: boolean,
  options: { ignoreScroll?: boolean } = {},
): boolean {
  const [onScreen, setOnScreen] = useState(false);
  const ignoreScrollRef = useRef(Boolean(options.ignoreScroll));
  ignoreScrollRef.current = Boolean(options.ignoreScroll);
  useEffect(() => {
    const element = target.current;
    if (!enabled || !element) return;
    if (typeof IntersectionObserver !== "function") {
      // No way to tell (an old test host): behave as if always visible.
      setOnScreen(true);
      return;
    }
    let timer: number | null = null;
    const clear = () => { if (timer !== null) { window.clearTimeout(timer); timer = null; } };
    // Only scrolling that moves THIS element counts: a terminal streaming
    // output elsewhere in the window scrolls constantly and must not hold
    // scenes back.
    let lastScrollAt = 0;
    const onScroll = (event: Event) => {
      const scrolled = event.target;
      if (scrolled === document || (scrolled instanceof Node && scrolled.contains(element))) lastScrollAt = performance.now();
    };
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    // Mount only once scrolling has paused; keep checking until it has.
    const activateWhenQuiet = () => {
      const sinceScroll = performance.now() - lastScrollAt;
      if (!ignoreScrollRef.current && sinceScroll < SCENE_SCROLL_QUIET_MS) {
        timer = window.setTimeout(activateWhenQuiet, SCENE_SCROLL_QUIET_MS - sinceScroll);
        return;
      }
      timer = null;
      setOnScreen(true);
    };
    // Rooted at the transcript's own scroller: a margin on the viewport root
    // is clipped by that scroller and would prefetch nothing.
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.some((entry) => entry.isIntersecting);
      clear();
      timer = visible
        ? window.setTimeout(activateWhenQuiet, SCENE_ACTIVATE_DWELL_MS)
        : window.setTimeout(() => { timer = null; setOnScreen(false); }, SCENE_DEACTIVATE_LINGER_MS);
    }, { root: scrollParentOf(element), rootMargin: SCENE_ACTIVATE_MARGIN, threshold: 0 });
    observer.observe(element);
    return () => {
      clear();
      window.removeEventListener("scroll", onScroll, true);
      observer.disconnect();
    };
  }, [target, enabled]);
  return onScreen;
}
