/**
 * The code of the project tabs (Lanes, Files, PRs, CTO) loads before the
 * person opens them, but not during launch.
 *
 * `App.tsx` registers one loader for each tab path. A tab button calls
 * `preloadRoute` when the pointer moves onto it or it gets focus, so its code
 * loads before the press. `scheduleQuietRoutePreload` loads all of them
 * after the person stops using the window for a short time, so a keyboard
 * switch (Mod+2) also finds its code loaded.
 */

type RoutePreloader = () => Promise<unknown>;

const preloaders = new Map<string, RoutePreloader>();

/** Register the loader of the page at `path` (for example "/lanes"). */
export function registerRoutePreload(path: string, preload: RoutePreloader): void {
  preloaders.set(path, preload);
}

/**
 * Start to load the page at `path`. A page that has no loader, or that
 * already loaded, costs nothing. A failure is ignored here: the tab loads its
 * page again when it opens, and shows that failure there.
 */
export function preloadRoute(path: string): void {
  const preload = preloaders.get(path);
  if (!preload) return;
  try {
    void preload().catch(() => undefined);
  } catch {
    // The loader threw before it returned a promise; the tab tries again.
  }
}

/** The quiet time after the last input before the tab pages load. */
export const ROUTE_PRELOAD_QUIET_MS = 2_000;
/** With no input at all, the tab pages load this long after the schedule starts. */
export const ROUTE_PRELOAD_NO_INPUT_MS = 10_000;

type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

const INPUT_EVENTS = ["pointerdown", "keydown", "wheel"] as const;

/**
 * Run `preload` once the window has been quiet for `ROUTE_PRELOAD_QUIET_MS`
 * after the person's last pointer press, key press or scroll. With no input,
 * it runs `ROUTE_PRELOAD_NO_INPUT_MS` after this call. In both cases it waits
 * for an idle frame. Only the first input moves the timer; later inputs only
 * record their time, so typing costs nothing. Returns a function that cancels
 * it.
 */
export function scheduleQuietRoutePreload(preload: () => void): () => void {
  const idleWindow = window as IdleWindow;
  const startedAt = Date.now();
  let lastInputAt: number | null = null;
  let timer: number | null = null;
  let idleHandle: number | null = null;
  let done = false;

  const setTimer = (delayMs: number) => {
    if (timer != null) window.clearTimeout(timer);
    timer = window.setTimeout(check, Math.max(0, delayMs));
  };
  const onInput = () => {
    const first = lastInputAt == null;
    lastInputAt = Date.now();
    // The first input ends the no-input wait: the quiet time after it decides.
    if (first && idleHandle == null) setTimer(ROUTE_PRELOAD_QUIET_MS);
  };
  const removeListeners = () => {
    for (const type of INPUT_EVENTS) window.removeEventListener(type, onInput, true);
  };
  const run = () => {
    if (done) return;
    done = true;
    removeListeners();
    preload();
  };
  /** The time still to wait before the pages may load, or 0. */
  const waitLeft = (): number => {
    const now = Date.now();
    return lastInputAt == null
      ? startedAt + ROUTE_PRELOAD_NO_INPUT_MS - now
      : lastInputAt + ROUTE_PRELOAD_QUIET_MS - now;
  };
  function check(): void {
    timer = null;
    if (done) return;
    const left = waitLeft();
    if (left > 0) {
      setTimer(left);
      return;
    }
    if (typeof idleWindow.requestIdleCallback !== "function") {
      run();
      return;
    }
    idleHandle = idleWindow.requestIdleCallback(() => {
      idleHandle = null;
      // An input while the frame was busy starts the quiet time again.
      if (waitLeft() > 0) {
        check();
        return;
      }
      run();
    }, { timeout: ROUTE_PRELOAD_QUIET_MS });
  }

  for (const type of INPUT_EVENTS) window.addEventListener(type, onInput, { capture: true, passive: true });
  setTimer(ROUTE_PRELOAD_NO_INPUT_MS);

  return () => {
    done = true;
    removeListeners();
    if (timer != null) window.clearTimeout(timer);
    if (idleHandle != null) idleWindow.cancelIdleCallback?.(idleHandle);
  };
}
