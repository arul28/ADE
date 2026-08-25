/**
 * Universal sleep detection: a timer that should have fired 15 seconds ago and
 * fires four minutes late means the machine was suspended in between.
 *
 * This is the fallback that gives every environment sleep detection with zero
 * platform code — Linux (which has no Electron app at all), a headless brain on
 * any OS, and any host whose native suspend event was missed. Deliberately kept
 * free of Node and Electron imports so the desktop main process and the brain
 * can share one implementation and tests can drive it with a fake clock.
 */

/** How often the detector checks whether wall-clock time matches elapsed time. */
export const SUSPEND_GAP_TICK_MS = 15_000;

/**
 * Excess delay that counts as a suspend rather than a busy machine.
 *
 * This is measured on top of the tick interval, so a 15-second tick must arrive
 * 60+ seconds late. Event-loop stalls of that size do happen under extreme
 * load, but they are indistinguishable from a short sleep in every way that
 * matters to a user: nothing was running either way. Lower thresholds start
 * reporting "your machine slept" during heavy builds, which is worse than
 * missing a 45-second nap.
 */
export const SUSPEND_GAP_THRESHOLD_MS = 60_000;

export type SuspendGapDetectorOptions = {
  /** Called once per detected gap, with how long the machine was out. */
  onGap: (gapMs: number) => void;
  tickMs?: number;
  thresholdMs?: number;
  now?: () => number;
  setTimer?: (handler: () => void, delayMs: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

export type SuspendGapDetector = {
  start(): void;
  stop(): void;
  /** Last detected gap in ms, or null if this process has not missed a tick. */
  getLastGapMs(): number | null;
  /**
   * Run one check immediately. The timer calls this; tests and hosts that
   * already have a wake signal (an Electron `resume`, a foregrounded window)
   * can call it directly to close the gap without waiting for the next tick.
   */
  check(): void;
};

export function createSuspendGapDetector(
  options: SuspendGapDetectorOptions,
): SuspendGapDetector {
  const tickMs = Math.max(1_000, Math.floor(options.tickMs ?? SUSPEND_GAP_TICK_MS));
  const thresholdMs = Math.max(1_000, Math.floor(options.thresholdMs ?? SUSPEND_GAP_THRESHOLD_MS));
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer
    ?? ((handler: () => void, delayMs: number) => {
      const handle = setTimeout(handler, delayMs);
      // Never hold a CLI process open for a sleep check.
      (handle as { unref?: () => void }).unref?.();
      return handle;
    });
  const clearTimer = options.clearTimer
    ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let timer: unknown = null;
  let expectedAt: number | null = null;
  let lastGapMs: number | null = null;

  const arm = (): void => {
    expectedAt = now() + tickMs;
    timer = setTimer(() => {
      timer = null;
      check();
    }, tickMs);
  };

  const check = (): void => {
    if (expectedAt === null) return;
    const overdueBy = now() - expectedAt;
    const running = timer !== null;
    if (running) {
      // An out-of-band check that arrived before the timer was due proves
      // nothing; leave the armed timer alone.
      if (overdueBy < thresholdMs) return;
      clearTimer(timer);
      timer = null;
    }
    if (overdueBy >= thresholdMs) {
      // Report the whole absence, not just the overshoot: the machine was out
      // from the moment the tick was due until now, plus the interval it was
      // sleeping through.
      lastGapMs = overdueBy + tickMs;
      options.onGap(lastGapMs);
    }
    arm();
  };

  return {
    start(): void {
      if (timer !== null) return;
      arm();
    },
    stop(): void {
      if (timer !== null) clearTimer(timer);
      timer = null;
      expectedAt = null;
    },
    getLastGapMs(): number | null {
      return lastGapMs;
    },
    check,
  };
}
