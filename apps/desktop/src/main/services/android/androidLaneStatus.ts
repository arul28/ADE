import type {
  AndroidAppCrash,
  AndroidAvd,
  AndroidLaneDeviceStatus,
  AndroidLaneExtraStatus,
  AndroidPowerOffRecord,
  AndroidRunningEmulator,
  AndroidSdkStatus,
} from "../../../shared/types/androidEmulator";
import { readAndroidAvd } from "./androidAvds";
import type { AndroidDiscoveredEmulator } from "./androidEmulatorProcess";
import type { AndroidLaneState as LaneState } from "./androidEmulatorServiceDeps";
import type { AndroidLaneDeviceRepo } from "./androidLaneRelease";
import { androidSdkPaths } from "./androidSdk";

/*
 * The lane's status as `getStatus` reads it: its device, the AVD, the state
 * the service and the running emulator say, the last failure, and its extra
 * devices. Split out of `androidEmulatorService.ts`.
 *
 * Node built-ins and relative imports only, so it runs under `tsx`.
 */

export function createAndroidLaneStatus(ctx: {
  laneDevices: AndroidLaneDeviceRepo;
  platform: NodeJS.Platform;
  peekLane: (laneId: string) => LaneState | undefined;
  readSdk: () => Promise<AndroidSdkStatus>;
  runningFor: (avdName: string) => AndroidDiscoveredEmulator | null;
  asRunning: (adbPath: string | null, emulator: AndroidDiscoveredEmulator) => Promise<AndroidRunningEmulator>;
  crashWatch: {
    ensure: (laneId: string, device: { serial: string; adbPath: string }) => void;
    latest: (laneId: string) => AndroidAppCrash | null;
  };
  /** The pin and the idle limit (`androidEmulatorUse.ts`). */
  laneStatusFields: (avdName: string, startedByAde: boolean | null) => Pick<AndroidLaneDeviceStatus, "keepRunning" | "idleStopMinutes">;
  poweredOffRecord: (laneId: string) => AndroidPowerOffRecord | null;
  extraStatuses: (laneId: string, sdk: AndroidSdkStatus) => Promise<AndroidLaneExtraStatus[]>;
}) {
  return async (laneId: string, sdk?: AndroidSdkStatus | null): Promise<AndroidLaneDeviceStatus> => {
    const state = ctx.peekLane(laneId) ?? null;
    const device = ctx.laneDevices.get(laneId);
    const error = state?.error ?? null;
    // The SDK is read only when the lane holds a device: a lane with none is the common read.
    const hasExtras = ctx.laneDevices.extras(laneId).length > 0;
    if (!device) {
      const bare: AndroidLaneDeviceStatus = { laneId, device: null, avd: null, state: state?.transient ?? "none", error };
      return hasExtras ? { ...bare, extras: await ctx.extraStatuses(laneId, sdk ?? await ctx.readSdk()) } : bare;
    }
    const sdkStatus = sdk ?? await ctx.readSdk();
    const adbPath = sdkStatus.root ? androidSdkPaths(sdkStatus.root, ctx.platform).adb : null;
    const emulator = ctx.runningFor(device.avdName);
    // A lane that is still booting is not asked for `sys.boot_completed`: the
    // boot wait already asks, and the answer is "starting" either way.
    const running = emulator
      ? state?.transient === "starting"
        ? { ...emulator, startedByAde: true, booted: false }
        : await ctx.asRunning(adbPath, emulator)
      : null;
    const avd = sdkStatus.avdHome ? readAndroidAvd(sdkStatus.avdHome, device.avdName, { running: running ? [running] : [] }) : null;
    const avdWithRunning: AndroidAvd | null = avd ? { ...avd, running } : null;
    const derived: AndroidLaneDeviceStatus["state"] = state?.transient
      ?? (running ? (running.booted ? "booted" : "starting") : error ? "crashed" : "off");
    // A booted emulator is watched for crashes of the lane's app, once.
    if (derived === "booted" && running && adbPath) ctx.crashWatch.ensure(laneId, { serial: running.serial, adbPath });
    return {
      laneId,
      device,
      avd: avdWithRunning,
      state: derived,
      error: derived === "crashed" || derived === "off" ? error : null,
      appCrash: derived === "booted" ? ctx.crashWatch.latest(laneId) : null,
      ...ctx.laneStatusFields(device.avdName, running?.startedByAde ?? null),
      // Parity: "ADE powered it off after 21 min idle", until the next start.
      poweredOff: derived === "off" ? ctx.poweredOffRecord(laneId) : null,
      ...(hasExtras ? { extras: await ctx.extraStatuses(laneId, sdkStatus) } : {}),
    };
  };
}
