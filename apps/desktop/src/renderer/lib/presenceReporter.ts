export type PresenceReporterOptions = {
  /** One report carrying the latest state. A rejection counts as a failure. */
  send: () => Promise<void>;
  /** Whether the page is visible; picks the heartbeat cadence. */
  isVisible: () => boolean;
  visibleIntervalMs: number;
  hiddenIntervalMs: number;
  /** Ceiling for the failure backoff, which doubles the cadence per failure. */
  maxBackoffMs: number;
  /** Event-driven requests inside this window go out as one report. */
  coalesceMs: number;
};

export type PresenceReporter = {
  /** Reports now and starts the heartbeat. */
  start(): void;
  /** Stops the heartbeat and drops anything pending. */
  stop(): void;
  /** Something changed: report soon, merged with any other change in the window. */
  request(): void;
  /** The cadence changed (visibility): move the pending heartbeat to it. */
  reschedule(): void;
};

/**
 * A heartbeat that reports state, plus event-driven reports between beats.
 *
 * Presence is how other devices learn this machine is being watched, so it
 * reports on a timer and on every focus, blur and visibility change. Those
 * events flap several times inside one window switch, and on a bad network
 * each report fails, so two rules keep it cheap:
 *
 * - Requests inside `coalesceMs` merge into one report, and a request while a
 *   report is in flight sends once more when it lands. The report reads the
 *   latest state when it goes out, so nothing is lost by merging.
 * - After a failure, the heartbeat backs off (doubling, up to `maxBackoffMs`)
 *   and events stop jumping the queue; the next beat carries the latest state.
 *   One success restores the normal cadence.
 */
export function createPresenceReporter(options: PresenceReporterOptions): PresenceReporter {
  let running = false;
  let inFlight = false;
  let pending = false;
  let consecutiveFailures = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let coalesceTimer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const nextDelayMs = (): number => {
    const base = options.isVisible() ? options.visibleIntervalMs : options.hiddenIntervalMs;
    if (consecutiveFailures === 0) return base;
    return Math.min(options.maxBackoffMs, base * 2 ** Math.min(consecutiveFailures, 8));
  };

  const schedule = (): void => {
    clearTimer();
    if (!running) return;
    timer = setTimeout(() => {
      timer = null;
      void report();
    }, nextDelayMs());
  };

  const report = async (): Promise<void> => {
    if (!running) return;
    if (inFlight) {
      pending = true;
      return;
    }
    inFlight = true;
    pending = false;
    clearTimer();
    try {
      await options.send();
      consecutiveFailures = 0;
    } catch {
      // Nobody waits on presence; the backed-off heartbeat retries it.
      consecutiveFailures += 1;
      pending = false;
    } finally {
      inFlight = false;
    }
    if (pending && consecutiveFailures === 0) {
      void report();
      return;
    }
    schedule();
  };

  return {
    start() {
      if (running) return;
      running = true;
      void report();
    },
    stop() {
      running = false;
      pending = false;
      clearTimer();
      if (coalesceTimer !== null) clearTimeout(coalesceTimer);
      coalesceTimer = null;
    },
    request() {
      if (!running || consecutiveFailures > 0 || coalesceTimer !== null) return;
      coalesceTimer = setTimeout(() => {
        coalesceTimer = null;
        void report();
      }, options.coalesceMs);
    },
    reschedule() {
      if (running && !inFlight) schedule();
    },
  };
}
