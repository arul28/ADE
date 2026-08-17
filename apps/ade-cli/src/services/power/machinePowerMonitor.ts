/**
 * The brain's own view of this machine's power and sleep state.
 *
 * The account-directory publisher lives in the brain, which is a plain Node
 * process with no Electron and therefore no `powerMonitor`. Its universal
 * signal is the heartbeat gap: a tick that arrives minutes late proves the
 * machine was suspended, on macOS, Windows, and Linux alike.
 *
 * A host that DOES have a precise suspend signal — the Electron main process,
 * or any future platform hook — announces it through `noteAnnouncedSuspend()`
 * before the machine goes dark. That announcement is what lets a phone say
 * "Asleep" with confidence instead of inferring it from silence, so the two
 * paths are kept distinct on the wire: `announced` on the emitted event says
 * which one produced it.
 */

import {
  toMachinePowerRecord,
  type MachinePower,
  type MachinePowerPublication,
  type MachineSleepState,
} from "../../../../desktop/src/shared/types/power";
import { readMachinePower, type MachinePowerReaderDeps } from "./machinePowerReader";
import { createSuspendGapDetector, type SuspendGapDetector } from "./suspendGapDetector";

/**
 * How often the battery/AC reading is refreshed.
 *
 * A minute is far finer than a battery percentage moves and far coarser than
 * the process spawn it costs on macOS and Windows. Wall-power transitions are
 * caught by the same poll rather than by a second mechanism, so unplugging a
 * laptop is reflected within one interval.
 */
export const MACHINE_POWER_POLL_MS = 60_000;

export type MachinePowerEvent =
  | { kind: "suspend"; at: number; announced: boolean }
  | {
    kind: "resume";
    at: number;
    /** How long the machine was out, when we can tell. */
    gapMs: number | null;
    announced: boolean;
  }
  | { kind: "power-change"; at: number; power: MachinePower };

/**
 * A read/subscribe view of one machine's power, with no lifecycle on it.
 *
 * Consumers — the account-directory publisher, the chat service — read and
 * subscribe; they never start or stop the thing they are reading, because in
 * the brain they are all looking at ONE shared monitor and a consumer that
 * disposed it would take power tracking away from the others. Starting and
 * stopping belongs to `MachinePowerMonitor`, which is the owned object.
 */
export type MachinePowerSource = {
  getPower(): MachinePower | null;
  getSleepState(): MachineSleepState;
  /** Epoch ms at which `getSleepState()` last changed. */
  getSleepStateAt(): number;
  /** Milliseconds the machine was suspended for, from the last resume. */
  getSuspendGapMs(): number | null;
  subscribe(listener: (event: MachinePowerEvent) => void): () => void;
};

export type MachinePowerMonitorOptions = {
  now?: () => number;
  pollMs?: number;
  readPower?: (deps?: MachinePowerReaderDeps) => Promise<MachinePower | null>;
  createGapDetector?: (onGap: (gapMs: number) => void) => SuspendGapDetector;
};

export type MachinePowerMonitor = MachinePowerSource & {
  start(): void;
  dispose(): void;
  /**
   * Force a battery/AC read now. Used at startup and by tests. Resolves to the
   * state now held, which on an unreadable machine is whatever was last known —
   * possibly null.
   */
  refreshPower(): Promise<MachinePower | null>;
  /** A host with a precise pre-suspend hook says so here. */
  noteAnnouncedSuspend(): void;
  /** …and pairs it with this on the way back. */
  noteAnnouncedResume(): void;
  /** Everything the heartbeat publishes about power, in wire shape. */
  getPublication(): MachinePowerPublication;
};

export function createMachinePowerMonitor(
  options: MachinePowerMonitorOptions = {},
): MachinePowerMonitor {
  const now = options.now ?? Date.now;
  const pollMs = Math.max(5_000, Math.floor(options.pollMs ?? MACHINE_POWER_POLL_MS));
  const readPower = options.readPower ?? readMachinePower;

  const listeners = new Set<(event: MachinePowerEvent) => void>();
  let power: MachinePower | null = null;
  let sleepState: MachineSleepState = "awake";
  let sleepStateAt = now();
  let suspendGapMs: number | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let started = false;
  let disposed = false;

  const emit = (event: MachinePowerEvent): void => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // A consumer that throws must not take down power tracking for the
        // rest of them, or for the heartbeat.
      }
    }
  };

  const setSleepState = (next: MachineSleepState, at: number): boolean => {
    if (sleepState === next) return false;
    sleepState = next;
    sleepStateAt = at;
    return true;
  };

  /**
   * When the host announced THIS sleep, in epoch ms.
   *
   * The gap detector's `getLastGapMs()` is the last gap it ever measured, not
   * the last sleep that happened: a 40-second nap that never clears the 60s
   * threshold leaves last night's four-hour gap sitting there, and reporting it
   * would write "paused 4h" into the transcript for a 40-second nap. An
   * announced sleep knows its own start, so it uses that instead.
   */
  let announcedSuspendAt: number | null = null;

  const enterSuspend = (announced: boolean): void => {
    if (disposed) return;
    const at = now();
    const transitioned = setSleepState("asleep", at);
    if (announced) {
      // Both stamps are re-anchored even when the state did not change, and
      // that is the point. An announced suspend arriving while we still believe
      // we are asleep means the previous sleep's resume never reached us; the
      // sleep starting NOW is the one everything downstream must measure. Left
      // alone, the old stamp makes the next resume report "paused 6h" for a
      // two-minute nap, and leaves the state looking permanently fresh to
      // anything that age-bounds it.
      announcedSuspendAt = at;
      sleepStateAt = at;
    }
    if (!transitioned) return;
    emit({ kind: "suspend", at, announced });
  };

  const leaveSuspend = (announced: boolean, gapMs: number | null): void => {
    if (disposed) return;
    const at = now();
    announcedSuspendAt = null;
    suspendGapMs = gapMs;
    // A resume is worth announcing even when no suspend was observed: the gap
    // detector only ever learns about the sleep on the way out of it.
    setSleepState("awake", at);
    emit({ kind: "resume", at, gapMs, announced });
    void refreshPower();
  };

  /**
   * Set while an announced resume is draining the detector, so the gap it
   * finds is attributed to that announcement instead of racing it with a
   * second, inferred resume for the same sleep.
   */
  let resolvingAnnouncedResume = false;
  const onGap = (gapMs: number): void => {
    if (resolvingAnnouncedResume) return;
    leaveSuspend(false, gapMs);
  };
  const gapDetector = options.createGapDetector
    ? options.createGapDetector(onGap)
    : createSuspendGapDetector({ now, onGap });

  const refreshPower = async (): Promise<MachinePower | null> => {
    const next = await readPower();
    if (disposed) return next ?? power;
    if (next === null) {
      // A read that failed knows nothing, so it overwrites nothing. Replacing a
      // real reading with the reader's old "on external power" default was how
      // one `pmset` timeout republished a laptop on battery as plugged in.
      return power;
    }
    const changed = JSON.stringify(power) !== JSON.stringify(next);
    power = next;
    if (changed) emit({ kind: "power-change", at: now(), power: next });
    return next;
  };

  const schedulePoll = (): void => {
    if (!started || disposed || pollTimer) return;
    pollTimer = setTimeout(() => {
      pollTimer = null;
      void refreshPower().finally(schedulePoll);
    }, pollMs);
    pollTimer.unref?.();
  };

  return {
    start(): void {
      if (started || disposed) return;
      started = true;
      gapDetector.start();
      void refreshPower().finally(schedulePoll);
    },

    dispose(): void {
      disposed = true;
      started = false;
      gapDetector.stop();
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = null;
      listeners.clear();
    },

    getPower: () => power,
    getSleepState: () => sleepState,
    getSleepStateAt: () => sleepStateAt,
    getSuspendGapMs: () => suspendGapMs,

    getPublication(): MachinePowerPublication {
      return {
        power: toMachinePowerRecord(power),
        sleepState,
        sleepStateAt,
      };
    },

    subscribe(listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    noteAnnouncedSuspend(): void {
      enterSuspend(true);
    },

    noteAnnouncedResume(): void {
      const suspendedAt = announcedSuspendAt;
      const wasAsleep = sleepState === "asleep";
      const gapBefore = gapDetector.getLastGapMs();
      // Drain the detector first: its timer would otherwise report this same
      // wake seconds later as a second, inferred resume.
      resolvingAnnouncedResume = true;
      try {
        gapDetector.check();
      } finally {
        resolvingAnnouncedResume = false;
      }
      const detectedGap = gapDetector.getLastGapMs();
      if (!wasAsleep && suspendedAt === null && detectedGap === gapBefore) {
        // Nothing to wake from: no suspend outstanding, and the detector found
        // no new gap. Reporting one anyway would replay the LAST gap this
        // process ever measured as if it had just happened — which is exactly
        // what a retried resume hop would do on its second delivery.
        return;
      }
      // This sleep's own stamp is the only measurement that belongs to it. The
      // detector is the fallback for a wake nobody announced the start of.
      const gapMs = suspendedAt === null
        ? detectedGap
        : Math.max(0, now() - suspendedAt);
      leaveSuspend(true, gapMs);
    },

    refreshPower,
  };
}
