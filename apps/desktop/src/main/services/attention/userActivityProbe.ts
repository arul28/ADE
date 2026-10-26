/**
 * Whether the person is using this computer right now, from the OS input
 * clock. Activity presence carries it so the phone stays quiet while they sit
 * at a computer that can alert them itself, and buzzes once they walk away.
 *
 * "Active" is input in the last two minutes with the screen unlocked and the
 * machine awake. The answer is `null` (unknown, the relay keeps its timed
 * hold) until the idle clock has been seen to move: a platform that cannot
 * read it (some Linux/Wayland sessions) reports 0 forever, and taking that at
 * face value would keep the phone quiet for good.
 */

/** Input within this window counts as "at the computer". */
export const USER_ACTIVE_IDLE_THRESHOLD_SECONDS = 120;

export type PowerMonitorLike = {
  getSystemIdleTime(): number;
  getSystemIdleState(idleThresholdSeconds: number): "active" | "idle" | "locked" | "unknown";
  on(event: "suspend" | "resume" | "lock-screen" | "unlock-screen", listener: () => void): unknown;
};

export type UserActivityProbe = {
  /** `true` in use, `false` idle/locked/asleep, `null` unknown. */
  read(): boolean | null;
};

export function createUserActivityProbe(args: {
  powerMonitor: PowerMonitorLike | null | undefined;
  /** The person left (lock, sleep): tell other devices now, not on the next beat. */
  onAway?: () => void;
  /** The person is back (unlock, wake). */
  onBack?: () => void;
  /** A failed OS read; the read repeats every heartbeat, so it is reported once. */
  onError?: (what: "subscribe" | "read", error: unknown) => void;
}): UserActivityProbe {
  const monitor = args.powerMonitor;
  if (!monitor) return { read: () => null };
  let away = false;
  let idleClockMoved = false;
  let readErrorReported = false;
  const leave = () => {
    if (away) return;
    away = true;
    args.onAway?.();
  };
  const back = () => {
    if (!away) return;
    away = false;
    args.onBack?.();
  };
  try {
    monitor.on("suspend", leave);
    monitor.on("lock-screen", leave);
    monitor.on("resume", back);
    monitor.on("unlock-screen", back);
  } catch (error) {
    // Without the events the clock still answers on the next heartbeat.
    args.onError?.("subscribe", error);
  }
  return {
    read() {
      if (away) return false;
      try {
        if (!idleClockMoved) {
          if (monitor.getSystemIdleTime() <= 0) return null;
          idleClockMoved = true;
        }
        const state = monitor.getSystemIdleState(USER_ACTIVE_IDLE_THRESHOLD_SECONDS);
        if (state === "active") return true;
        if (state === "idle" || state === "locked") return false;
        return null;
      } catch (error) {
        if (!readErrorReported) {
          readErrorReported = true;
          args.onError?.("read", error);
        }
        return null;
      }
    },
  };
}
