import type {
  AndroidDeviceCleanupArgs,
  AndroidDeviceCleanupResult,
  AndroidLaneDevice,
  AndroidPowerOffRecord,
} from "../../../shared/types/androidEmulator";
import type { Logger } from "../logging/logger";
import { getErrorMessage } from "../shared/utils";
import { runDeviceScript, type BootedDevice } from "./androidDeviceShell";
import type { AndroidDiscoveredEmulator } from "./androidEmulatorProcess";

/*
 * Parity with Apple's `laneDeviceMaintenance.ts`: the two background jobs
 * that keep lane emulators from piling up, and `deviceCleanup`.
 *
 * - The cleanup pass: release the devices of lanes that ended, stop
 *   emulators ADE started that no lane holds (an emulator handed off by an
 *   earlier brain whose lane is gone is one of them), and drop lane rows whose
 *   AVD is gone from disk. One minute after it is armed, then every 15 minutes.
 * - Idle power-off: an emulator ADE started for an AVD ADE made, that nothing
 *   has used for `idleMs` (30 minutes), is stopped. A booted emulator holds
 *   2 to 4 GB of RAM. Starting it again takes seconds from its snapshot.
 *
 * Neither job runs for a project that does not use Android. Every project's
 * brain builds this service, so the timers are armed only while there is
 * something to keep: the cleanup pass while a lane holds an Android device
 * or an emulator ADE started runs, the idle pass while such an emulator runs
 * for an AVD ADE made. `refresh` checks this again. The service calls it
 * after each lifecycle event, and each pass calls it when it ends, so the
 * timers stop when the last device goes.
 *
 * "Used" is any agent or viewer call on the lane, a running stream (a viewer
 * or a recording), a lease, a lifecycle step or a test run in progress, and
 * input from outside ADE as far as the device shows it (`dumpsys power`
 * reports the last user activity, which every input injection moves).
 * The service's own start counts as use, so a brain restart (the hand-off,
 * `handOffOnDispose`) never reads as idle time.
 *
 * Never touched: an emulator ADE did not start, and an AVD the lane attached
 * (the user's own; another tool may drive it where ADE cannot see). AVDs ADE
 * made that no lane holds are only listed: their marker does not name the
 * project, and a release may keep one on purpose.
 *
 * Node built-ins and relative imports only, so it runs under `tsx`.
 */

const DEFAULT_IDLE_MS = 30 * 60_000;
const IDLE_TICK_MAX_MS = 5 * 60_000;
const IDLE_TICK_MIN_MS = 15_000;
const CLEANUP_FIRST_MS = 60_000;
const CLEANUP_TICK_MS = 15 * 60_000;

/** `ADE_ANDROID_IDLE_POWER_OFF_MINUTES`: minutes, `0` turns idle power-off off (Apple's `ADE_APPLE_IDLE_POWER_OFF_MINUTES`). */
export function androidIdlePowerOffMs(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): number {
  const raw = env.ADE_ANDROID_IDLE_POWER_OFF_MINUTES?.trim();
  if (!raw) return DEFAULT_IDLE_MS;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes < 0) return DEFAULT_IDLE_MS;
  return minutes * 60_000;
}

/**
 * `dumpsys power` and `/proc/uptime`: how many ms ago the device saw user
 * activity, or null when it does not say. `mLastUserActivityTime=` is in
 * uptime ms; `uptime=` is the device's uptime in seconds.
 */
export function parseDeviceIdleMs(text: string): number | null {
  const last = /mLastUserActivityTime=(\d+)/u.exec(text);
  const uptime = /uptime=(\d+(?:\.\d+)?)/u.exec(text);
  if (!last || !uptime) return null;
  const idle = Number(uptime[1]) * 1000 - Number(last[1]);
  return Number.isFinite(idle) && idle >= 0 ? idle : null;
}

/** How many ms ago the device saw user activity (`parseDeviceIdleMs`): one device shell. */
export async function readDeviceIdleMs(booted: BootedDevice, signal: AbortSignal): Promise<number | null> {
  const result = await runDeviceScript(
    booted,
    "dumpsys power | grep -m1 -oE 'mLastUserActivityTime=[0-9]+'; echo \"uptime=$(cut -d' ' -f1 /proc/uptime)\"",
    { timeoutMs: 10_000, signal },
  );
  return parseDeviceIdleMs(result.stdout);
}

/** A scrcpy server runs on the device (any brain's or tool's viewer): one device shell. */
export async function readOtherScrcpyViewer(booted: BootedDevice, signal: AbortSignal): Promise<boolean> {
  const result = await runDeviceScript(
    booted,
    // `[S]` keeps the pattern from matching this shell's own command line.
    "pgrep -f 'com[.]genymobile[.]scrcpy[.][S]erver' >/dev/null 2>&1 && echo scrcpy=1 || echo scrcpy=0",
    { timeoutMs: 10_000, signal },
  );
  return /scrcpy=1/u.test(result.stdout);
}

export type AndroidLaneMaintenanceDeps = {
  listRows: () => AndroidLaneDevice[];
  /** `active`, `archived`, `missing`, or null when it cannot be told (never act on null). */
  laneLiveness: (laneId: string) => "active" | "archived" | "missing" | null;
  discovered: () => AndroidDiscoveredEmulator[];
  /** ADE started this emulator (the state file, or this process). */
  ownsEmulator: (emulator: AndroidDiscoveredEmulator) => boolean;
  holder: (avdName: string) => string | null;
  runningFor: (avdName: string) => AndroidDiscoveredEmulator | null;
  /** The AVD folder, or null without an SDK. */
  avdHome: () => string | null;
  /** The AVD's files are on disk. Only asked when `avdHome` answers. */
  avdExists: (avdHome: string, avdName: string) => boolean;
  /** ADE-made AVDs on disk with the lane their marker names. */
  adeAvds: () => Promise<Array<{ avdName: string; markerLaneId: string | null }>>;
  /** Releases an ended lane's device on its queue (`endLaneLocked`). */
  endLane: (device: AndroidLaneDevice) => Promise<void>;
  stopOrphan: (emulator: AndroidDiscoveredEmulator) => Promise<void>;
  forgetRow: (device: AndroidLaneDevice) => void;
  /** Something in this process uses the lane's device now. */
  isBusy: (laneId: string) => boolean;
  /** How long ago the device saw input, from the device; null when it cannot say. */
  deviceIdleMs: (laneId: string) => Promise<number | null>;
  /**
   * Stops the lane's emulator on its queue, by the service's own stop.
   * `stillIdle` is asked again on the queue, just before the stop: a lease,
   * a test run or a call may have come while the pass waited. Answers false
   * when it left the emulator running on purpose (another viewer).
   */
  powerOff: (device: AndroidLaneDevice, guard: { stillIdle: () => boolean }) => Promise<boolean>;
  onChanged: () => void;
  idleMs?: number;
  now?: () => number;
  logger: Logger | null;
};

export function createAndroidLaneMaintenance(deps: AndroidLaneMaintenanceDeps) {
  const now = deps.now ?? (() => Date.now());
  const idleMs = deps.idleMs ?? androidIdlePowerOffMs();
  const startedAt = now();
  const lastUse = new Map<string, number>();
  const poweredOff = new Map<string, AndroidPowerOffRecord>();
  /** The cleanup pass's first run and its repeat, while armed. */
  const cleanupTimers: NodeJS.Timeout[] = [];
  /** The idle pass's repeat, while armed. */
  let idleTimer: NodeJS.Timeout | null = null;
  let running: Promise<AndroidDeviceCleanupResult> | null = null;
  let started = false;
  let stopped = false;

  /** Something used the lane's device: restart its idle clock, and forget an old power-off. */
  const touch = (laneId: string): void => {
    if (!laneId) return;
    lastUse.set(laneId, now());
  };

  const idleFor = (laneId: string): number => now() - Math.max(lastUse.get(laneId) ?? 0, startedAt);

  /** The lane's ADE-made, ADE-started emulator that is up, or null. */
  const candidate = (device: AndroidLaneDevice): AndroidDiscoveredEmulator | null => {
    if (device.origin !== "created") return null;
    const emulator = deps.runningFor(device.avdName);
    return emulator && deps.ownsEmulator(emulator) ? emulator : null;
  };

  const runIdlePass = async (options: { force?: boolean; onlyLaneId?: string | null; dryRun?: boolean } = {}) => {
    const done: AndroidDeviceCleanupResult["poweredOff"] = [];
    const errors: AndroidDeviceCleanupResult["errors"] = [];
    if (!options.force && idleMs <= 0) return { poweredOff: done, errors };
    for (const device of deps.listRows()) {
      if (stopped) break;
      if (options.onlyLaneId && device.laneId !== options.onlyLaneId) continue;
      if (!candidate(device)) continue;
      if (deps.isBusy(device.laneId)) {
        touch(device.laneId);
        continue;
      }
      const adeIdle = idleFor(device.laneId);
      if (!options.force && adeIdle < idleMs) continue;
      // Input from outside ADE (adb, Android Studio) shows on the device.
      const deviceIdle = await deps.deviceIdleMs(device.laneId).catch(() => null);
      const idle = deviceIdle === null ? adeIdle : Math.min(adeIdle, deviceIdle);
      if (!options.force && idle < idleMs) {
        // Seen as used: restart ADE's own clock at the device's last input.
        lastUse.set(device.laneId, now() - idle);
        continue;
      }
      const idleMinutes = Math.round(idle / 60_000);
      if (options.dryRun) {
        done.push({ laneId: device.laneId, avdName: device.avdName, idleMinutes });
        continue;
      }
      try {
        const usedAt = lastUse.get(device.laneId) ?? 0;
        const stillIdle = () => !deps.isBusy(device.laneId) && (lastUse.get(device.laneId) ?? 0) <= usedAt;
        if (!(await deps.powerOff(device, { stillIdle }))) continue;
        poweredOff.set(device.laneId, { at: new Date(now()).toISOString(), reason: options.force ? "cleanup" : "idle", idleMinutes });
        done.push({ laneId: device.laneId, avdName: device.avdName, idleMinutes });
        deps.logger?.info("android.lane_device_idle_powered_off", { laneId: device.laneId, avdName: device.avdName, idleMinutes, reason: options.force ? "cleanup" : "idle" });
      } catch (error) {
        errors.push({ avdName: device.avdName, message: getErrorMessage(error) });
        deps.logger?.warn("android.lane_device_idle_power_off_failed", { laneId: device.laneId, avdName: device.avdName, error: getErrorMessage(error) });
      }
    }
    if (done.length && !options.dryRun) deps.onChanged();
    return { poweredOff: done, errors };
  };

  /** The reconcile half of the pass. `dryRun` reports and changes nothing. */
  const reconcile = async (dryRun: boolean): Promise<AndroidDeviceCleanupResult> => {
    const result: AndroidDeviceCleanupResult = {
      dryRun,
      released: [],
      stoppedOrphans: [],
      forgottenRows: [],
      poweredOff: [],
      unheld: [],
      errors: [],
      idlePowerOffMinutes: Math.round(idleMs / 60_000),
    };
    const rows = deps.listRows();
    // A lane that is gone (or archived) gives its device back. Unknown liveness is left alone.
    for (const device of rows) {
      const liveness = deps.laneLiveness(device.laneId);
      if (liveness === null || liveness === "active") continue;
      if (dryRun) {
        result.released.push({ laneId: device.laneId, avdName: device.avdName });
        continue;
      }
      try {
        await deps.endLane(device);
        result.released.push({ laneId: device.laneId, avdName: device.avdName });
      } catch (error) {
        result.errors.push({ avdName: device.avdName, message: getErrorMessage(error) });
      }
    }
    // An emulator ADE started that no lane holds (a hand-off whose lane is gone).
    for (const emulator of deps.discovered()) {
      if (!deps.ownsEmulator(emulator) || deps.holder(emulator.avdName) !== null) continue;
      if (dryRun) {
        result.stoppedOrphans.push({ serial: emulator.serial, avdName: emulator.avdName });
        continue;
      }
      try {
        await deps.stopOrphan(emulator);
        result.stoppedOrphans.push({ serial: emulator.serial, avdName: emulator.avdName });
      } catch (error) {
        result.errors.push({ avdName: emulator.avdName, message: getErrorMessage(error) });
      }
    }
    // A row whose AVD is gone from disk and is not running. Without an AVD
    // folder (no SDK, a drive not mounted) nothing is forgotten.
    const avdHome = deps.avdHome();
    if (avdHome) {
      for (const device of deps.listRows()) {
        if (deps.runningFor(device.avdName) || deps.avdExists(avdHome, device.avdName)) continue;
        if (result.released.some((entry) => entry.laneId === device.laneId)) continue;
        result.forgottenRows.push({ laneId: device.laneId, avdName: device.avdName });
        if (!dryRun) deps.forgetRow(device);
      }
    }
    try {
      for (const avd of await deps.adeAvds()) {
        if (deps.holder(avd.avdName) === null) result.unheld.push(avd);
      }
    } catch (error) {
      result.errors.push({ avdName: null, message: `The AVD list could not be read: ${getErrorMessage(error)}` });
    }
    const changed = result.released.length + result.stoppedOrphans.length + result.forgottenRows.length > 0;
    if (changed && !dryRun) {
      deps.logger?.info("android.lane_device_cleanup", {
        released: result.released.length,
        stoppedOrphans: result.stoppedOrphans.length,
        forgottenRows: result.forgottenRows.length,
      });
      deps.onChanged();
    }
    return result;
  };

  /**
   * The cleanup pass. One at a time: a second caller shares the pass in
   * flight. A dry run never shares (it must not wait on, or start, a real one).
   * A requested power-off runs after the reconcile.
   */
  const runCleanup = async (args: AndroidDeviceCleanupArgs = {}): Promise<AndroidDeviceCleanupResult> => {
    const dryRun = args.dryRun === true;
    let result: AndroidDeviceCleanupResult;
    if (dryRun) {
      result = await reconcile(true);
    } else {
      const pass = running ?? reconcile(false).finally(() => {
        running = null;
      });
      running = pass;
      const shared = await pass;
      result = { ...shared, poweredOff: [...shared.poweredOff], errors: [...shared.errors] };
    }
    if (args.powerOffIdle) {
      // An agent powers off its own lane's emulator, never another lane's.
      const onlyLaneId = args.agentCaller ? args.laneId?.trim() || "\u0000no-lane" : null;
      const idle = await runIdlePass({ force: true, onlyLaneId, dryRun });
      result.poweredOff.push(...idle.poweredOff);
      result.errors.push(...idle.errors);
    }
    return result;
  };

  /** A timer that runs one pass, logs a failure, then checks again whether the timers are still needed. */
  const schedule = (ms: number, job: () => Promise<unknown>, repeat: boolean): NodeJS.Timeout => {
    const handle = (repeat ? setInterval : setTimeout)(() => {
      void job()
        .catch((error: unknown) => {
          deps.logger?.warn("android.lane_device_maintenance_failed", { error: getErrorMessage(error) });
        })
        .finally(() => refresh());
    }, ms);
    // Never the reason a process stays alive.
    handle.unref?.();
    return handle;
  };

  /** What the timers have to keep now: lane rows, and emulators ADE started. */
  const wanted = (): { cleanup: boolean; idle: boolean } => {
    const rows = deps.listRows();
    const ownedRunning = rows.length > 0 ? false : deps.discovered().some((emulator) => deps.ownsEmulator(emulator));
    return {
      cleanup: rows.length > 0 || ownedRunning,
      idle: idleMs > 0 && rows.some((device) => candidate(device) !== null),
    };
  };

  /**
   * Arms the timers that have work and stops the ones that have none. Cheap
   * (the lane rows and the emulator discovery files), so the service calls it
   * on each lifecycle event. Never throws.
   */
  const refresh = (): void => {
    if (!started || stopped) return;
    let want: { cleanup: boolean; idle: boolean };
    try {
      want = wanted();
    } catch (error) {
      deps.logger?.warn("android.lane_device_maintenance_check_failed", { error: getErrorMessage(error) });
      return;
    }
    const before = { cleanup: cleanupTimers.length > 0, idle: idleTimer !== null };
    if (want.cleanup && cleanupTimers.length === 0) {
      cleanupTimers.push(schedule(CLEANUP_FIRST_MS, () => runCleanup(), false), schedule(CLEANUP_TICK_MS, () => runCleanup(), true));
    } else if (!want.cleanup && cleanupTimers.length > 0) {
      for (const handle of cleanupTimers.splice(0)) {
        clearTimeout(handle);
        clearInterval(handle);
      }
    }
    if (want.idle && idleTimer === null) {
      const tick = Math.min(IDLE_TICK_MAX_MS, Math.max(IDLE_TICK_MIN_MS, Math.round(idleMs / 4)));
      idleTimer = schedule(tick, () => runIdlePass(), true);
    } else if (!want.idle && idleTimer !== null) {
      clearInterval(idleTimer);
      idleTimer = null;
    }
    if (before.cleanup !== want.cleanup || before.idle !== want.idle) {
      deps.logger?.info("android.lane_device_maintenance_armed", { cleanup: want.cleanup, idle: want.idle });
    }
  };

  /** Lets `refresh` arm the timers. The service calls it after its start-up reconcile. */
  const start = (): void => {
    if (started || stopped) return;
    started = true;
    refresh();
  };

  const stop = (): void => {
    stopped = true;
    for (const handle of cleanupTimers.splice(0)) {
      clearTimeout(handle);
      clearInterval(handle);
    }
    if (idleTimer !== null) clearInterval(idleTimer);
    idleTimer = null;
  };

  return {
    touch,
    /** Why ADE last powered the lane's emulator off, until it starts again. */
    poweredOffRecord: (laneId: string): AndroidPowerOffRecord | null => poweredOff.get(laneId) ?? null,
    /** The lane's emulator started: the power-off is no longer the news, and the idle clock restarts. */
    started: (laneId: string): void => {
      poweredOff.delete(laneId);
      touch(laneId);
    },
    runIdlePass,
    runCleanup,
    refresh,
    start,
    stop,
  };
}

export type AndroidLaneMaintenance = ReturnType<typeof createAndroidLaneMaintenance>;
