import type { BrainMemoryPressureSample } from "./brainLoopWatchdog";

/**
 * A planned restart for a brain that is holding too much memory.
 *
 * This is a mitigation, not a fix. It exists because a leaked runtime grows an
 * idle brain by megabytes a minute, and a restart of an idle brain costs the
 * user nothing while an out-of-memory kill costs them everything. It never
 * interrupts work: an active brain simply keeps its memory, and the deferral is
 * logged so a diagnostic report shows the mitigation declining to fire rather
 * than silently doing nothing.
 *
 * Restarting goes through the service manager, exactly as the freshness monitor
 * does, rather than exiting and trusting the supervisor. All three supervisors
 * do restart on a clean exit -- launchd `KeepAlive`, systemd `Restart=always`,
 * the Windows supervisor loop -- but a brain started by hand from a terminal
 * has no supervisor at all, and exiting there would take ADE away from a
 * developer who never asked for a restart.
 */

/** How long to wait for the brain to be free before giving up on this run. */
export const DEFAULT_BRAIN_MEMORY_RESTART_WAIT_MS = 30 * 60_000;

/** How often the wait re-checks. */
export const DEFAULT_BRAIN_MEMORY_RESTART_POLL_MS = 30_000;

/**
 * The one sentence that explains this restart to whoever reads the log.
 *
 * Spelled out rather than assembled, because the whole point is that a restart
 * in the log is not evidence of a crash and must not be read as one.
 */
export const BRAIN_MEMORY_RESTART_REASON =
  "planned restart: memory stayed above the limit while the brain was idle. "
  + "This is a mitigation for a known runtime leak, not a crash.";

export type BrainMemoryRestartLogger = {
  warn: (event: string, fields: Record<string, unknown>) => void;
};

export type BrainMemoryRestartGuardOptions = {
  /**
   * Whether the brain is free to restart: no chat turn, no agent run, nothing
   * the user would lose. Never overridden, at any memory figure.
   */
  isIdle: () => boolean | Promise<boolean>;
  /**
   * Whether the brain is also unattached -- no client on the socket. A weaker
   * signal than `isIdle`, because a desktop app holds a connection open all
   * day and reconnects after a restart without noticing. Waited for, then
   * proceeded past.
   */
  isQuiet?: () => boolean | Promise<boolean>;
  restart: () => void | Promise<void>;
  logger: BrainMemoryRestartLogger;
  maxQuietWaitMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export type BrainMemoryRestartGuard = {
  /** Consider one reported pressure sample. Safe to call more than once. */
  handle: (sample: BrainMemoryPressureSample) => Promise<void>;
  /** Stop waiting; the brain is going away for another reason. */
  stop: () => void;
};

export function createBrainMemoryRestartGuard(
  options: BrainMemoryRestartGuardOptions,
): BrainMemoryRestartGuard {
  const now = options.now ?? Date.now;
  const pollMs = Math.max(1, options.pollMs ?? DEFAULT_BRAIN_MEMORY_RESTART_POLL_MS);
  const maxQuietWaitMs = Math.max(0, options.maxQuietWaitMs ?? DEFAULT_BRAIN_MEMORY_RESTART_WAIT_MS);
  const sleep = options.sleep ?? (async (ms: number) => {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  });

  let stopped = false;
  let inFlight = false;
  // One restart per process. After it succeeds this brain is on its way out,
  // and a second attempt could only race the handover.
  let restarted = false;

  const handle = async (sample: BrainMemoryPressureSample): Promise<void> => {
    if (stopped || inFlight || restarted) return;
    inFlight = true;
    try {
      const deadline = now() + maxQuietWaitMs;
      let idle = await options.isIdle();
      let quiet = options.isQuiet ? await options.isQuiet() : true;
      while (!stopped && (!idle || !quiet) && now() < deadline) {
        await sleep(Math.min(pollMs, Math.max(1, deadline - now())));
        idle = await options.isIdle();
        quiet = options.isQuiet ? await options.isQuiet() : true;
      }
      if (stopped) return;
      if (!idle) {
        // Someone is using this brain. Their work outweighs the leak. The
        // watchdog re-reports the same run on its repeat cadence -- about an
        // hour -- so the deferral is a skip, not the end of the mitigation.
        options.logger.warn("brain.memory_restart_deferred", {
          ...sample,
          waitedMs: maxQuietWaitMs,
          reason: "the brain was busy for the whole wait, so the restart was skipped",
        });
        return;
      }
      options.logger.warn("brain.memory_restart", {
        ...sample,
        attached: !quiet,
        reason: BRAIN_MEMORY_RESTART_REASON,
      });
      await options.restart();
      restarted = true;
    } catch (error) {
      // A failed handover leaves this brain running with the memory it had.
      // That is the status quo, not a new failure, so it is reported and the
      // guard re-arms: `restarted` stays false, and the watchdog's repeat
      // cadence brings the same pressure run back in about an hour.
      options.logger.warn("brain.memory_restart_failed", {
        ...sample,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      inFlight = false;
    }
  };

  return {
    handle,
    stop(): void {
      stopped = true;
    },
  };
}
