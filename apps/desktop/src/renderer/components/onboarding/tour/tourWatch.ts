import { ONBOARDING_ANCHOR_ATTR } from "../../../onboarding/onboardingProgress";

/**
 * Wakes the onboarding overlays (the tour and the hints) when the page may
 * have changed, instead of polling: a DOM change (a page, a menu or a dialog
 * mounting, an anchor appearing), a resize, a scroll, a click or a key, or
 * the window coming back into view. Calls are coalesced: `check` runs at most
 * once per `minIntervalMs`, a beat after the burst that woke it, and never
 * while the window is hidden. `check` may ask for one more run after a delay
 * (a control settling, a step pausing) through `scheduleCheck`.
 *
 * The observer skips `style` on purpose: animations rewrite inline styles
 * every frame, and a frame-rate wake-up is what this replaces. `check` runs
 * at the start of a frame, so the layout it reads (a control's box, a hit
 * test) is the one that frame computes anyway, not an extra one forced in
 * the middle of a streaming chat's updates.
 */

const WATCHED_ATTRIBUTES = [
  ONBOARDING_ANCHOR_ATTR,
  "aria-modal",
  "aria-hidden",
  "aria-expanded",
  "hidden",
  "open",
  "class",
  "data-state",
];

function isOverlayMutation(record: MutationRecord): boolean {
  const target = record.target instanceof Element ? record.target : record.target.parentElement;
  return target?.closest("[data-onboarding-hint-layer]") != null;
}

export type TourWatch = {
  /** Runs `check` after `delayMs` (or the next coalesced slot), unless a run is already due sooner. */
  scheduleCheck: (delayMs?: number) => void;
  dispose: () => void;
};

export function watchTourDom(check: () => void, options: { minIntervalMs: number; settleMs?: number }): TourWatch {
  const settleMs = options.settleMs ?? 90;
  let timer: number | null = null;
  let frame = 0;
  let dueAt = Infinity;
  let lastRunAt = -Infinity;
  let disposed = false;

  const runInFrame = () => {
    frame = 0;
    if (disposed || document.hidden) return;
    lastRunAt = performance.now();
    check();
  };
  const run = () => {
    timer = null;
    dueAt = Infinity;
    if (disposed || document.hidden || frame) return;
    frame = window.requestAnimationFrame(runInFrame);
  };

  const scheduleCheck = (delayMs = settleMs) => {
    if (disposed) return;
    const now = performance.now();
    const at = Math.max(now + delayMs, lastRunAt + options.minIntervalMs);
    if (timer != null && dueAt <= at) return;
    if (timer != null) window.clearTimeout(timer);
    dueAt = at;
    timer = window.setTimeout(run, Math.max(0, at - now));
  };

  const wake = () => scheduleCheck();
  // The overlays' own changes (a card mounting) are not news.
  const observer = new MutationObserver((records) => {
    if (records.every(isOverlayMutation)) return;
    scheduleCheck();
  });
  // The whole document, not just <body>: a theme or layout class on <html>
  // and a stylesheet arriving in <head> move controls too.
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: WATCHED_ATTRIBUTES,
  });
  const onVisibility = () => {
    if (!document.hidden) scheduleCheck(0);
  };
  window.addEventListener("resize", wake, { passive: true });
  window.addEventListener("scroll", wake, { capture: true, passive: true });
  document.addEventListener("click", wake, true);
  document.addEventListener("keyup", wake, true);
  document.addEventListener("visibilitychange", onVisibility);
  scheduleCheck(0);

  return {
    scheduleCheck,
    dispose: () => {
      disposed = true;
      if (timer != null) window.clearTimeout(timer);
      if (frame) window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", wake);
      window.removeEventListener("scroll", wake, { capture: true });
      document.removeEventListener("click", wake, true);
      document.removeEventListener("keyup", wake, true);
      document.removeEventListener("visibilitychange", onVisibility);
    },
  };
}
