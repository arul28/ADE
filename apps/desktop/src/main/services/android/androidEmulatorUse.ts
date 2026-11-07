import type { AndroidEmulatorServiceApi, AndroidLaneDevice } from "../../../shared/types/androidEmulator";
import type { Logger } from "../logging/logger";
import { getErrorMessage } from "../shared/utils";
import { createPerKeyThrottle } from "../device/deviceMaintenance";
import { sameAvdName } from "./androidAvds";
import type { AndroidDiscoveredEmulator } from "./androidEmulatorProcess";
import type { AndroidEmulatorOwnerRecord, AndroidEmulatorStopReason } from "./androidEmulatorOwners";
import type { AndroidEmulatorLifecycle, AndroidIdleStopAnswer } from "./androidEmulatorSweep";
import type { AndroidLaneDeviceRepo } from "./androidLaneRelease";

/*
 * One project's Android service, as the brain's emulator lifecycle sees it
 * (`androidEmulatorSweep.ts`): which calls count as using a lane's emulator,
 * when it is busy, the idle stop through the lane's queue, the pin, and the
 * emulators ADE started before the machine's owner file existed.
 *
 * Node built-ins and relative imports only, so it runs under `tsx`.
 */

/**
 * The calls that do NOT count as using the lane's emulator. Every other call
 * that names a lane does: driving it (taps, keys, text, Inspect, a relaunch),
 * streaming, installing, capturing, recording, reading its log or its
 * screen, a lease, a fold, a test run, so a method added later counts by
 * default. Each one moves the emulator's idle clock, and while one is in
 * flight (a Gradle build, a test run, a lease wait) the emulator counts as
 * busy. The reads a pane or the mini player polls do not, or an open window
 * would keep an emulator up forever; a viewer's stream counts by itself
 * while someone holds it. Nor do the stops, the pin and the cleanup pass.
 */
export const ANDROID_NOT_USE_METHODS: ReadonlySet<string> = new Set([
  "getStatus", "listDevices", "getStreamStatus", "deviceLeaseStatus", "recordList", "getAutoRecord",
  "getMachinePreferences", "getSdkSetupPlan", "getSdkInstallState", "listSystemImages", "deviceCleanup",
  "stop", "stopForLane", "releaseDevice", "dispose", "onEvent", "releaseIfOwnedBy", "streamRemoteBitrateKbpsCap",
  "setKeepRunning",
]);

/** A lane's use is passed to the lifecycle at most this often; the lifecycle writes the file once a minute. */
const LANE_TOUCH_EVERY_MS = 15_000;

/**
 * `service` with each of `methods` wrapped: `onUse(laneId)` runs as a call
 * starts, and the function it returns once the call settles (sync, async,
 * thrown). A call whose first argument names no lane goes straight through.
 * A new object; the service itself is not changed.
 */
export function withUseTracking<S extends object>(
  service: S,
  methods: readonly (keyof S & string)[],
  hooks: { onUse: (laneId: string) => () => void },
): S {
  const tracked: S = { ...service };
  for (const name of methods) {
    const original = service[name] as unknown as (args: unknown, ...rest: unknown[]) => unknown;
    if (typeof original !== "function") continue;
    const wrapped = (args: unknown, ...rest: unknown[]) => {
      const named = args && typeof args === "object" ? (args as { laneId?: unknown }).laneId : undefined;
      const laneId = typeof named === "string" ? named.trim() : "";
      if (!laneId) return original.call(service, args, ...rest);
      const done = hooks.onUse(laneId);
      let result: unknown;
      try {
        result = original.call(service, args, ...rest);
      } catch (error) {
        done();
        throw error;
      }
      if (result && typeof (result as Promise<unknown>).then === "function") return (result as Promise<unknown>).finally(done);
      done();
      return result;
    };
    (tracked as Record<string, unknown>)[name] = wrapped;
  }
  return tracked;
}

export type AndroidEmulatorUseDeps = {
  lifecycle: AndroidEmulatorLifecycle | null;
  laneDevices: AndroidLaneDeviceRepo;
  projectRoot: string | null;
  logger: Logger | null;
  now: () => Date;
  isDisposed: () => boolean;
  /** In use for what the service itself tracks: a boot or stop, a stream someone holds, a recording, a lease. */
  busyHere: (laneId: string) => boolean;
  /** One of the lane's extra devices is in use here now (its boot, its stop, an install or a launch on it). */
  extraBusy: (laneId: string, avdName: string) => boolean;
  /**
   * Asked on the device's queue just before an idle stop: the device (the
   * lane's own, or an extra) shows use ADE's calls do not (input from adb or
   * Android Studio, `dumpsys power`; or another brain's or tool's scrcpy
   * viewer). Null when it shows none or cannot say.
   */
  usedOnDevice: (device: AndroidLaneDevice, idleMs: number) => Promise<"device_input" | "other_viewer" | null>;
  /** The running emulator of this AVD when ADE started it, else null. */
  ownedRunning: (avdName: string) => AndroidDiscoveredEmulator | null;
  /** The running emulators ADE started for this project (its state file). */
  startedHere: () => AndroidDiscoveredEmulator[];
  /** The adb and the guest RAM to record for an emulator taken in. */
  describe: (avdName: string) => { adbPath: string | null; guestRamMb: number | null };
  serialize: <T>(laneId: string, step: () => Promise<T>) => Promise<T>;
  /** Stops the lane's emulator as idle and says so (`poweredOff`); the caller holds the lane's queue. */
  stopIdleLocked: (laneId: string, device: AndroidLaneDevice, idleMinutes: number) => Promise<void>;
  /**
   * Stops one of the lane's extras as idle, on the extra's own queue
   * (`androidLaneExtras.ts`), and says so. `check` runs there just before the
   * stop; its answer leaves the extra running.
   */
  stopIdleExtra: (
    laneId: string,
    extra: AndroidLaneDevice,
    idleMinutes: number,
    check: () => Promise<AndroidIdleStopAnswer | null>,
  ) => Promise<AndroidIdleStopAnswer>;
  onAutoStopped?: () => void;
};

export function createAndroidEmulatorUse(deps: AndroidEmulatorUseDeps) {
  const { lifecycle, logger } = deps;
  /** Calls in flight that count as use, by lane (every lane call but `ANDROID_NOT_USE_METHODS`). */
  const useInFlight = new Map<string, number>();
  const laneTouchThrottle = createPerKeyThrottle(LANE_TOUCH_EVERY_MS, () => deps.now().getTime());

  /** The lane's emulator in use here now: a boot or stop, a stream, a recording, a lease, a call in flight. */
  const laneBusy = (laneId: string): boolean => deps.busyHere(laneId) || (useInFlight.get(laneId) ?? 0) > 0;

  /** Minutes since the AVD's emulator was used: this process's own clock, else the owner file's. */
  const idleMinutesFor = (avdName: string, record: AndroidEmulatorOwnerRecord | null = lifecycle?.recordFor(avdName) ?? null): number => {
    const fileMs = record ? Date.parse(record.lastUsedAt) : Number.NaN;
    const lastMs = Math.max(lifecycle?.lastUsedHereMs(avdName) ?? Number.NEGATIVE_INFINITY, Number.isFinite(fileMs) ? fileMs : Number.NEGATIVE_INFINITY);
    return Number.isFinite(lastMs) ? Math.max(0, Math.round((deps.now().getTime() - lastMs) / 60_000)) : 0;
  };

  /** Something used the lane's emulator: move its idle clock. Throttled; never throws. */
  const touchLane = (laneId: string): void => {
    if (!lifecycle || !laneTouchThrottle.take(laneId)) return;
    try {
      const device = deps.laneDevices.get(laneId);
      if (device) lifecycle.touch(device.avdName);
    } catch (error) {
      logger?.debug("android.touch_failed", { laneId, error: getErrorMessage(error) });
    }
  };

  /**
   * The sweep found one of this service's emulators idle: stop it through the
   * lane's queue, unless it was used, pinned or taken over since the sweep looked.
   */
  const stopIdleEmulator = async (record: AndroidEmulatorOwnerRecord, idleMs: number): Promise<AndroidIdleStopAnswer> => {
    const laneId = record.laneId;
    /** The lane's own device or one of its extras, when it is this record's AVD and ADE runs it. */
    const holds = (): AndroidLaneDevice | null => {
      const own = deps.laneDevices.get(laneId);
      const device = own && sameAvdName(own.avdName, record.avdName)
        ? own
        : deps.laneDevices.extras(laneId).find((extra) => sameAvdName(extra.avdName, record.avdName)) ?? null;
      return device && deps.ownedRunning(device.avdName) ? device : null;
    };
    /** Null when the stop may go ahead; asked on the device's queue. */
    const check = async (device: AndroidLaneDevice): Promise<AndroidIdleStopAnswer | null> => {
      const current = lifecycle?.recordFor(record.avdName) ?? null;
      if (current && (current.pinned || current.owner.brainPid !== record.owner.brainPid)) return "kept";
      const lastHere = lifecycle?.lastUsedHereMs(record.avdName) ?? null;
      if (laneBusy(laneId) || (device.extra === true && deps.extraBusy(laneId, device.avdName))) return "busy";
      if (lastHere !== null && deps.now().getTime() - lastHere < idleMs) return "busy";
      // Use ADE's calls cannot see. "busy" moves the idle clock to now.
      const used = await deps.usedOnDevice(device, idleMs);
      if (used) {
        logger?.info("android.idle_stop_skipped", { laneId, avdName: record.avdName, reason: used, extra: device.extra === true });
        return "busy";
      }
      return null;
    };
    const held = deps.isDisposed() ? null : holds();
    if (!held) return "not_found";
    if (held.extra === true) {
      const current = lifecycle?.recordFor(record.avdName) ?? null;
      return deps.stopIdleExtra(laneId, held, idleMinutesFor(record.avdName, current ?? record), () => check(held));
    }
    return deps.serialize(laneId, async (): Promise<AndroidIdleStopAnswer> => {
      const device = holds();
      if (!device || device.extra === true) return "not_found";
      const early = await check(device);
      if (early) return early;
      const current = lifecycle?.recordFor(record.avdName) ?? null;
      await deps.stopIdleLocked(laneId, device, idleMinutesFor(record.avdName, current ?? record));
      return "stopped";
    });
  };

  /**
   * Emulators ADE started before the machine's owner file existed (an
   * upgrade with emulators running) are taken in as they run, with a fresh
   * idle clock, so they stop when idle like any other.
   */
  const adoptUnrecordedEmulators = (): void => {
    if (!lifecycle) return;
    for (const emulator of deps.startedHere()) {
      if (lifecycle.recordFor(emulator.avdName)) continue;
      const laneId = deps.laneDevices.holder(emulator.avdName);
      if (!laneId) continue;
      const described = deps.describe(emulator.avdName);
      lifecycle.recordLaunch({
        avdName: emulator.avdName,
        consolePort: emulator.consolePort,
        launcherPid: emulator.pid,
        pid: emulator.pid,
        adbPath: described.adbPath,
        laneId,
        projectRoot: deps.projectRoot,
        chatSessionId: null,
        guestRamMb: described.guestRamMb,
        costMb: 0,
      });
      void lifecycle.recordBooted({ avdName: emulator.avdName, consolePort: emulator.consolePort, pid: emulator.pid }).catch((error: unknown) => {
        // Without its owner record the emulator is never idle-stopped or cleaned up.
        logger?.warn("android.owner_record_failed", { avdName: emulator.avdName, error: getErrorMessage(error) });
      });
      logger?.info("android.emulator_taken_in", { laneId, avdName: emulator.avdName, serial: emulator.serial });
    }
  };

  const unregister = lifecycle?.register({
    projectRoot: deps.projectRoot,
    isBusy: laneBusy,
    stopIdle: stopIdleEmulator,
    onAutoStopped: deps.onAutoStopped,
    logger,
  }) ?? null;

  return {
    adoptUnrecordedEmulators,

    /**
     * One emulator ADE started stopped: its machine-wide owner record goes and
     * the stop is logged once, with why (`android.emulator_stopped`).
     */
    noteStopped(emulator: Pick<AndroidDiscoveredEmulator, "avdName" | "consolePort">, reason: AndroidEmulatorStopReason, laneId: string | null): void {
      if (lifecycle) {
        lifecycle.noteStopped({ avdName: emulator.avdName, consolePort: emulator.consolePort, reason, laneId });
        return;
      }
      logger?.info("android.emulator_stopped", { reason, avdName: emulator.avdName, consolePort: emulator.consolePort, laneId });
    },

    /** The status's pin and idle limit; only an emulator ADE started is ever stopped by ADE, so only it has a pin. */
    laneStatusFields(avdName: string, startedByAde: boolean | null): { keepRunning?: boolean | null; idleStopMinutes?: number | null } {
      if (!lifecycle) return {};
      return {
        keepRunning: startedByAde ? lifecycle.recordFor(avdName)?.pinned ?? false : null,
        idleStopMinutes: lifecycle.idleMs > 0 ? Math.round(lifecycle.idleMs / 60_000) : null,
      };
    },

    /** In use here now (`busyHere`, or a use call in flight): the cleanup pass's power-off leaves it alone. */
    laneBusy,
    /** The person pinned the AVD's running emulator ("Keep running"). */
    isPinned(avdName: string): boolean {
      return lifecycle?.recordFor(avdName)?.pinned === true;
    },
    idleMinutes: (avdName: string): number => idleMinutesFor(avdName),
    /** The idle limit in minutes; 0 when the idle stop is off or there is no lifecycle. */
    idleStopMinutes(): number {
      return lifecycle && lifecycle.idleMs > 0 ? Math.round(lifecycle.idleMs / 60_000) : 0;
    },

    /** "Keep running" on or off for a running emulator ADE started. */
    setKeepRunning(laneId: string, avdName: string, keepRunning: boolean): void {
      if (!lifecycle) return;
      if (!lifecycle.recordFor(avdName)) adoptUnrecordedEmulators();
      if (lifecycle.setPinned(avdName, keepRunning)) logger?.info("android.keep_running_set", { laneId, avdName, keepRunning });
    },

    /**
     * The service, with each use call (every lane call but `ANDROID_NOT_USE_METHODS`)
     * moving its lane's idle clock and keeping it busy while it runs.
     */
    track<S extends AndroidEmulatorServiceApi>(service: S): S {
      const methods = (Object.keys(service) as (keyof S & string)[]).filter((name) =>
        typeof service[name] === "function" && !ANDROID_NOT_USE_METHODS.has(name));
      // A copy of every property of `service`, so the cast back is exact.
      return withUseTracking(service, methods, {
        onUse: (laneId) => {
          touchLane(laneId);
          useInFlight.set(laneId, (useInFlight.get(laneId) ?? 0) + 1);
          return () => {
            const left = (useInFlight.get(laneId) ?? 1) - 1;
            if (left > 0) useInFlight.set(laneId, left);
            else useInFlight.delete(laneId);
          };
        },
      });
    },

    /** Leaves the lifecycle: a sweep never asks a service that is going away. */
    dispose(): void {
      unregister?.();
    },
  };
}
