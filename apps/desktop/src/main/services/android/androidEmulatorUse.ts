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
 * The calls that count as using the lane's emulator: driving it, streaming,
 * installing, capturing, recording, reading its log, a lease. Each one moves
 * the emulator's idle clock, and while one is in flight (a Gradle build, a
 * test run, a lease wait) the emulator counts as busy. Status reads do not:
 * a pane that only looks must not keep an emulator alive forever.
 */
export const ANDROID_USE_METHODS = [
  "start",
  "startStream",
  "sendTouch",
  "tap",
  "swipe",
  "sendKey",
  "sendText",
  "rotate",
  "screenshot",
  "installApp",
  "launchApp",
  "terminateApp",
  "uninstallApp",
  "openUrl",
  "longPress",
  "drag",
  "scroll",
  "getScreenSnapshot",
  "findElement",
  "tapElement",
  "fillElement",
  "waitForElement",
  "assertVisible",
  "readLog",
  "recordStart",
  "recordStop",
  "captureProofBundle",
  "deviceLease",
  "setLocation",
  "setAppearance",
  "setPermission",
  "setDeviceSetting",
  "setPosture",
  "runInstrumentationTests",
] as const satisfies readonly LaneMethodName<AndroidEmulatorServiceApi>[];

/** A lane's use is passed to the lifecycle at most this often; the lifecycle writes the file once a minute. */
const LANE_TOUCH_EVERY_MS = 15_000;

/** The methods of `S` whose one argument names a lane. */
export type LaneMethodName<S> = {
  [K in keyof S]-?: S[K] extends (args: infer A) => unknown ? (A extends { laneId: string } ? K : never) : never;
}[keyof S];

/**
 * `service` with each of `methods` wrapped: `onUse(laneId)` runs as a call
 * starts, and the function it returns once the call settles (sync, async,
 * thrown). A call without a lane goes straight through. A new object; the
 * service itself is not changed.
 */
export function withUseTracking<S extends object, K extends LaneMethodName<S>>(
  service: S,
  methods: readonly K[],
  hooks: { onUse: (laneId: string) => () => void },
): S {
  const tracked: S = { ...service };
  for (const name of methods) {
    const original = service[name] as unknown as (args: { laneId?: unknown } | null) => unknown;
    if (typeof original !== "function") continue;
    const wrapped = (args: { laneId?: unknown } | null) => {
      const laneId = typeof args?.laneId === "string" ? args.laneId.trim() : "";
      if (!laneId) return original.call(service, args);
      const done = hooks.onUse(laneId);
      let result: unknown;
      try {
        result = original.call(service, args);
      } catch (error) {
        done();
        throw error;
      }
      if (result && typeof (result as Promise<unknown>).then === "function") return (result as Promise<unknown>).finally(done);
      done();
      return result;
    };
    (tracked as Record<K, unknown>)[name] = wrapped;
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
  /** In use for what the service itself tracks: a boot or stop, a stream, a recording, a lease. */
  busyHere: (laneId: string) => boolean;
  /** The running emulator of this AVD when ADE started it, else null. */
  ownedRunning: (avdName: string) => AndroidDiscoveredEmulator | null;
  /** The running emulators ADE started for this project (its state file). */
  startedHere: () => AndroidDiscoveredEmulator[];
  /** The adb and the guest RAM to record for an emulator taken in. */
  describe: (avdName: string) => { adbPath: string | null; guestRamMb: number | null };
  serialize: <T>(laneId: string, step: () => Promise<T>) => Promise<T>;
  /** Stops the lane's emulator as idle and says so; the caller holds the lane's queue. */
  stopIdleLocked: (laneId: string, device: AndroidLaneDevice) => Promise<void>;
  onAutoStopped?: () => void;
};

export function createAndroidEmulatorUse(deps: AndroidEmulatorUseDeps) {
  const { lifecycle, logger } = deps;
  /** Calls in flight that count as use, by lane (`ANDROID_USE_METHODS`). */
  const useInFlight = new Map<string, number>();
  const laneTouchThrottle = createPerKeyThrottle(LANE_TOUCH_EVERY_MS, () => deps.now().getTime());

  /** The lane's emulator in use here now: a boot or stop, a stream, a recording, a lease, a call in flight. */
  const laneBusy = (laneId: string): boolean => deps.busyHere(laneId) || (useInFlight.get(laneId) ?? 0) > 0;

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
    const holds = () => {
      const device = deps.laneDevices.get(laneId);
      return device && sameAvdName(device.avdName, record.avdName) && deps.ownedRunning(device.avdName) ? device : null;
    };
    if (deps.isDisposed() || !holds()) return "not_found";
    return deps.serialize(laneId, async (): Promise<AndroidIdleStopAnswer> => {
      const device = holds();
      if (!device) return "not_found";
      const current = lifecycle?.recordFor(record.avdName) ?? null;
      if (current && (current.pinned || current.owner.brainPid !== record.owner.brainPid)) return "kept";
      const lastHere = lifecycle?.lastUsedHereMs(record.avdName) ?? null;
      if (laneBusy(laneId) || (lastHere !== null && deps.now().getTime() - lastHere < idleMs)) return "busy";
      await deps.stopIdleLocked(laneId, device);
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
      void lifecycle.recordBooted({ avdName: emulator.avdName, consolePort: emulator.consolePort, pid: emulator.pid }).catch(() => undefined);
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

    /** "Keep running" on or off for a running emulator ADE started. */
    setKeepRunning(laneId: string, avdName: string, keepRunning: boolean): void {
      if (!lifecycle) return;
      if (!lifecycle.recordFor(avdName)) adoptUnrecordedEmulators();
      if (lifecycle.setPinned(avdName, keepRunning)) logger?.info("android.keep_running_set", { laneId, avdName, keepRunning });
    },

    /** The service, with each use call moving its lane's idle clock and keeping it busy while it runs. */
    track<S extends AndroidEmulatorServiceApi>(service: S): S {
      if (!lifecycle) return service;
      // A copy of every property of `service`, so the cast back is exact.
      return withUseTracking<AndroidEmulatorServiceApi, (typeof ANDROID_USE_METHODS)[number]>(service, ANDROID_USE_METHODS, {
        onUse: (laneId) => {
          touchLane(laneId);
          useInFlight.set(laneId, (useInFlight.get(laneId) ?? 0) + 1);
          return () => {
            const left = (useInFlight.get(laneId) ?? 1) - 1;
            if (left > 0) useInFlight.set(laneId, left);
            else useInFlight.delete(laneId);
          };
        },
      }) as S;
    },

    /** Leaves the lifecycle: a sweep never asks a service that is going away. */
    dispose(): void {
      unregister?.();
    },
  };
}
