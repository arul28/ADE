/**
 * The pieces the lane devices' background upkeep shares: the Apple
 * simulators' cleanup and idle power-off (`ios/laneDeviceMaintenance.ts`) and
 * the Android emulators' sweep (`android/androidEmulatorSweep.ts`).
 *
 * Both run a few jobs on timers that never keep a process alive, read an
 * idle limit in minutes from the environment, and record "the device was
 * used" at most once a minute however many taps arrive.
 */

/** An idle limit in minutes from `env[name]`; `0` turns the idle stop off, anything unreadable keeps the default. */
export function deviceIdleMsFromEnv(env: NodeJS.ProcessEnv, name: string, defaultMs: number): number {
  const raw = env[name]?.trim();
  if (!raw) return defaultMs;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes < 0) return defaultMs;
  return minutes * 60_000;
}

export type DeviceMaintenanceJob = {
  /** One run this long after start. */
  firstMs?: number;
  /** Then a run every this long (counted from start). */
  everyMs?: number;
  run: () => Promise<unknown>;
};

/**
 * Starts the jobs; the answer stops them. Every timer is unref'd, so upkeep
 * is never the reason a process stays alive, and a job that throws is
 * reported and runs again on its next tick.
 */
export function startDeviceMaintenanceTimers(
  jobs: readonly DeviceMaintenanceJob[],
  onError: (error: unknown) => void,
): () => void {
  const handles: NodeJS.Timeout[] = [];
  const fire = (job: DeviceMaintenanceJob) => () => {
    void job.run().catch(onError);
  };
  for (const job of jobs) {
    for (const [ms, repeat] of [[job.firstMs, false], [job.everyMs, true]] as const) {
      if (ms == null || ms <= 0) continue;
      const handle = (repeat ? setInterval : setTimeout)(fire(job), ms);
      handle.unref?.();
      handles.push(handle);
    }
  }
  return () => {
    for (const handle of handles.splice(0)) {
      clearTimeout(handle);
      clearInterval(handle);
    }
  };
}

/**
 * True at most once per `intervalMs` for each key: a device touched on every
 * tap writes its "last used" once a minute, not once a tap.
 */
export function createPerKeyThrottle(intervalMs: number, now: () => number = Date.now) {
  const last = new Map<string, number>();
  return {
    take(key: string): boolean {
      const at = now();
      if (at - (last.get(key) ?? Number.NEGATIVE_INFINITY) < intervalMs) return false;
      last.set(key, at);
      return true;
    },
    forget(key: string): void {
      last.delete(key);
    },
  };
}
