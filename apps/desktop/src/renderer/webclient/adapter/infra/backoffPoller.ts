import { isPageHidden, observePageVisibility } from "./pageVisibility";

export type BackoffPollerOptions = {
  /** Interval while the watched state keeps changing, and after any reset. */
  baseMs: number;
  /** Ceiling the interval backs off to while the state stays unchanged. */
  maxMs: number;
  /** Polls only run while this returns true. Checked before every read and schedule. */
  isActive: () => boolean;
  /** One host read. Resolves to whether the watched state changed; a rejection keeps the cadence. */
  read: () => Promise<boolean>;
};

export type BackoffPoller = {
  /** Begins polling. `immediate` reads now instead of after the base delay. */
  start(options?: { immediate?: boolean }): void;
  /** Stops polling and forgets the backoff. */
  stop(): void;
  /** Reads now and restarts the cadence at the base delay (an explicit user action). */
  kick(): void;
  /** Restarts the cadence at the base delay. A pending timer moves to the base delay. */
  resetBackoff(): void;
};

/**
 * Polls a host read on a backoff: the first three unchanged reads stay at
 * `baseMs`, then the interval doubles up to `maxMs`. A change or a reset
 * restarts it. A hidden page pauses the poll, and becoming visible reads at once.
 */
export function createBackoffPoller(options: BackoffPollerOptions): BackoffPoller {
  const { baseMs, maxMs, isActive, read } = options;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let unchangedReads = 0;
  let stopVisibility: (() => void) | null = null;

  const delayMs = (): number =>
    unchangedReads < 3 ? baseMs : Math.min(maxMs, baseMs * 2 ** (unchangedReads - 2));

  const clearTimer = (): void => {
    if (timer != null) clearTimeout(timer);
    timer = null;
  };

  const canPoll = (): boolean => running && isActive() && !isPageHidden();

  const schedule = (): void => {
    if (timer != null || inFlight || !canPoll()) return;
    timer = setTimeout(() => {
      timer = null;
      void poll();
    }, delayMs());
  };

  const poll = async (): Promise<void> => {
    if (inFlight || !canPoll()) return;
    inFlight = true;
    try {
      const changed = await read();
      unchangedReads = changed ? 0 : unchangedReads + 1;
    } catch {
      // A failed read keeps the current cadence; the next tick tries again.
    } finally {
      inFlight = false;
      schedule();
    }
  };

  /** Reads now and restarts the cadence. A read already in flight finishes and schedules the next one. */
  const kick = (): void => {
    unchangedReads = 0;
    if (inFlight) return;
    clearTimer();
    void poll();
  };

  return {
    start(startOptions) {
      if (running) return;
      running = true;
      stopVisibility = observePageVisibility({ onHidden: clearTimer, onVisible: kick });
      if (startOptions?.immediate) kick();
      else schedule();
    },
    stop() {
      running = false;
      clearTimer();
      stopVisibility?.();
      stopVisibility = null;
      unchangedReads = 0;
    },
    kick,
    resetBackoff() {
      unchangedReads = 0;
      if (timer == null) return;
      clearTimer();
      schedule();
    },
  };
}
