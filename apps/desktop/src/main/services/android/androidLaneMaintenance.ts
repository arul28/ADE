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
 * Parity with Apple's `laneDeviceMaintenance.ts`: the cleanup pass that keeps
 * lane devices from piling up, `deviceCleanup`, and the "ADE powered it off"
 * record the lane's status shows.
 *
 * - The cleanup pass: release the devices of lanes that ended, stop
 *   emulators ADE started that no lane holds (an emulator handed off by an
 *   earlier brain whose lane is gone is one of them; the service's own
 *   orphan stop, the same one its start-up reconcile uses), and drop lane
 *   rows whose AVD is gone from disk. One minute after it is armed, then
 *   every 15 minutes.
 * - The idle stop is not here: the brain's machine-wide sweep owns it
 *   (`androidEmulatorSweep.ts`, through `androidEmulatorUse.ts`), so one
 *   clock, one limit and the "Keep running" pin decide every idle stop, across
 *   brains. This module records what that stop did (`notePoweredOff`) until
 *   the lane's next start, and keeps the on-demand power-off of
 *   `deviceCleanup --power-off-idle`, which honors the pin and leaves an
 *   emulator in use alone.
 *
 * A lane's extra devices (`device-create --extra`) are rows here too, with
 * `extra` set. Each has its own power-off record, keyed by `keyOf` (the lane
 * id for the lane's own device). A lane that ended gives its extras back
 * with its device, and the on-demand power-off covers an idle extra too.
 *
 * The pass does not run for a project that does not use Android. Every
 * project's brain builds this service, so its timers are armed only while
 * there is something to keep: a lane holds an Android device or an emulator
 * ADE started runs. `refresh` checks this again. The service calls it after
 * each lifecycle event, and each pass calls it when it ends, so the timers
 * stop when the last device goes.
 *
 * Never touched: an emulator ADE did not start. AVDs ADE made that no lane
 * holds are only listed: their marker does not name the project, and a
 * release may keep one on purpose.
 *
 * Node built-ins and relative imports only, so it runs under `tsx`.
 */

const CLEANUP_FIRST_MS = 60_000;
const CLEANUP_TICK_MS = 15 * 60_000;

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

/**
 * Use of a booted device that ADE's calls do not see, asked just before an
 * idle stop: input from outside ADE (adb, Android Studio) in the idle limit,
 * or a scrcpy server while this brain streams none (another brain on the
 * same project, the dev app beside the installed one, or another tool shows
 * the screen). Null when it shows none or cannot say; a failed read is no use.
 */
export async function readUseOnDevice(
  booted: BootedDevice,
  options: { idleMs: number; ownStream: boolean; signal: AbortSignal; logger: Logger | null; laneId: string },
): Promise<"device_input" | "other_viewer" | null> {
  const deviceIdle = await readDeviceIdleMs(booted, options.signal).catch(() => null);
  if (deviceIdle !== null && deviceIdle < options.idleMs) return "device_input";
  if (options.ownStream) return null;
  const viewer = await readOtherScrcpyViewer(booted, options.signal).catch((error: unknown) => {
    options.logger?.warn("android.idle_viewer_check_failed", { laneId: options.laneId, error: getErrorMessage(error) });
    return false;
  });
  return viewer ? "other_viewer" : null;
}

export type AndroidLaneMaintenanceDeps = {
  /** Every lane device row and every extra row (`extra: true`). */
  listRows: () => AndroidLaneDevice[];
  /** The power-off record's key for a row: the lane id for the lane's own device, one key per extra. */
  keyOf: (device: AndroidLaneDevice) => string;
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
  /** The service's orphan stop (reason `orphan`), shared with its start-up reconcile. */
  stopOrphan: (emulator: AndroidDiscoveredEmulator) => Promise<void>;
  forgetRow: (device: AndroidLaneDevice) => void;
  /** This device is in use here now (`androidEmulatorUse.ts`: a stream held, a recording, a lease, a call in flight; an extra's boot or job). */
  isBusy: (device: AndroidLaneDevice) => boolean;
  /** The person pinned the AVD's running emulator ("Keep running"). */
  isPinned: (avdName: string) => boolean;
  /** Minutes since the AVD's emulator was last used, as the machine lifecycle counts it. */
  idleMinutes: (avdName: string) => number;
  /** The machine lifecycle's idle limit in minutes; 0 = the idle stop is off. */
  idleStopMinutes: () => number;
  /**
   * Stops the lane's emulator on its queue, by the service's own stop.
   * `stillIdle` is asked again on the queue, just before the stop: a lease,
   * a test run, a call or the pin may have come while the pass waited.
   * Answers false when it left the emulator running.
   */
  powerOff: (device: AndroidLaneDevice, guard: { stillIdle: () => boolean }) => Promise<boolean>;
  onChanged: () => void;
  now?: () => number;
  logger: Logger | null;
};

export function createAndroidLaneMaintenance(deps: AndroidLaneMaintenanceDeps) {
  const now = deps.now ?? (() => Date.now());
  const poweredOff = new Map<string, AndroidPowerOffRecord>();
  /** The cleanup pass's first run and its repeat, while armed. */
  const cleanupTimers: NodeJS.Timeout[] = [];
  let running: Promise<AndroidDeviceCleanupResult> | null = null;
  let started = false;
  let stopped = false;

  /** The lane's ADE-started emulator that is up, or null. */
  const candidate = (device: AndroidLaneDevice): AndroidDiscoveredEmulator | null => {
    const emulator = deps.runningFor(device.avdName);
    return emulator && deps.ownsEmulator(emulator) ? emulator : null;
  };

  /**
   * `--power-off-idle`: powers off each ADE-started emulator that nothing
   * uses now, whatever its idle time, except one the person pinned.
   */
  const powerOffNow = async (options: { onlyLaneId?: string | null; dryRun?: boolean } = {}) => {
    const done: AndroidDeviceCleanupResult["poweredOff"] = [];
    const errors: AndroidDeviceCleanupResult["errors"] = [];
    for (const device of deps.listRows()) {
      if (stopped) break;
      if (options.onlyLaneId && device.laneId !== options.onlyLaneId) continue;
      if (!candidate(device)) continue;
      if (deps.isBusy(device) || deps.isPinned(device.avdName)) continue;
      const idleMinutes = deps.idleMinutes(device.avdName);
      if (options.dryRun) {
        done.push({ laneId: device.laneId, avdName: device.avdName, idleMinutes });
        continue;
      }
      try {
        const stillIdle = () => !deps.isBusy(device) && !deps.isPinned(device.avdName);
        if (!(await deps.powerOff(device, { stillIdle }))) continue;
        notePoweredOff(deps.keyOf(device), { reason: "cleanup", idleMinutes });
        done.push({ laneId: device.laneId, avdName: device.avdName, idleMinutes });
      } catch (error) {
        errors.push({ avdName: device.avdName, message: getErrorMessage(error) });
        deps.logger?.warn("android.lane_device_power_off_failed", { laneId: device.laneId, avdName: device.avdName, error: getErrorMessage(error) });
      }
    }
    if (done.length && !options.dryRun) deps.onChanged();
    return { poweredOff: done, errors };
  };

  /**
   * ADE powered a device off by itself (the idle stop, or `--power-off-idle`):
   * the status says so until the next start. `key` is a lane id, or an extra's key.
   */
  const notePoweredOff = (key: string, record: Omit<AndroidPowerOffRecord, "at">): void => {
    poweredOff.set(key, { at: new Date(now()).toISOString(), ...record });
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
      idlePowerOffMinutes: deps.idleStopMinutes(),
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
        // An ended lane's extras go with it; an extra whose AVD is gone is forgotten like a lane row.
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
      const idle = await powerOffNow({ onlyLaneId, dryRun });
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
  const wanted = (): boolean =>
    deps.listRows().length > 0 || deps.discovered().some((emulator) => deps.ownsEmulator(emulator));

  /**
   * Arms the timers that have work and stops the ones that have none. Cheap
   * (the lane rows and the emulator discovery files), so the service calls it
   * on each lifecycle event. Never throws.
   */
  const refresh = (): void => {
    if (!started || stopped) return;
    let want: boolean;
    try {
      want = wanted();
    } catch (error) {
      deps.logger?.warn("android.lane_device_maintenance_check_failed", { error: getErrorMessage(error) });
      return;
    }
    const before = cleanupTimers.length > 0;
    if (want && cleanupTimers.length === 0) {
      cleanupTimers.push(schedule(CLEANUP_FIRST_MS, () => runCleanup(), false), schedule(CLEANUP_TICK_MS, () => runCleanup(), true));
    } else if (!want && cleanupTimers.length > 0) {
      for (const handle of cleanupTimers.splice(0)) {
        clearTimeout(handle);
        clearInterval(handle);
      }
    }
    if (before !== want) deps.logger?.info("android.lane_device_maintenance_armed", { cleanup: want });
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
  };

  return {
    /** Why ADE last powered a device off (a lane id, or an extra's key), until it starts again. */
    poweredOffRecord: (key: string): AndroidPowerOffRecord | null => poweredOff.get(key) ?? null,
    notePoweredOff,
    /** A device started: the power-off is no longer the news. */
    started: (key: string): void => {
      poweredOff.delete(key);
    },
    runCleanup,
    refresh,
    start,
    stop,
  };
}

export type AndroidLaneMaintenance = ReturnType<typeof createAndroidLaneMaintenance>;
