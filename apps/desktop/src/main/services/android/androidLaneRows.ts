import type { AndroidEmulatorEvent, AndroidLaneDevice, AndroidLaneDeviceStatus, AndroidPowerOffRecord } from "../../../shared/types/androidEmulator";
import type { Logger } from "../logging/logger";
import { sameAvdName } from "./androidAvds";
import type { AndroidEmulatorStopReason } from "./androidEmulatorOwners";
import type { AndroidLaneState as LaneState } from "./androidEmulatorServiceDeps";
import { androidExtraKey, type AndroidLaneExtras } from "./androidLaneExtras";
import { ANDROID_CAME_INTO_USE, type AndroidLaneMaintenanceDeps } from "./androidLaneMaintenance";
import type { AndroidLaneDeviceRepo } from "./androidLaneRelease";

/*
 * How the cleanup pass (`androidLaneMaintenance.ts`) reaches one lane row:
 * the lane's own device, on the lane's queue, or one of its extras, on the
 * extra's own queue; and the machine sweep's idle stop of the lane's own
 * device. Split out of `androidEmulatorService.ts`; the service spreads the
 * hooks into the maintenance deps.
 *
 * Node built-ins and relative imports only, so it runs under `tsx`.
 */

/** The maintenance deps that act on one row. */
export type AndroidLaneRowHooks = Pick<AndroidLaneMaintenanceDeps, "keyOf" | "endLane" | "forgetRow" | "isBusy" | "powerOff">;

export function createAndroidLaneRows(ctx: {
  laneDevices: AndroidLaneDeviceRepo;
  extras: AndroidLaneExtras;
  logger: Logger | null;
  serialize: <T>(key: string, step: () => Promise<T>) => Promise<T>;
  laneState: (laneId: string) => LaneState;
  /** The device is in use here now (`androidEmulatorUse.ts`, `deviceBusy`). */
  deviceBusy: (device: AndroidLaneDevice) => boolean;
  /** A lane ended: its extras, then its own device. The caller holds the lane's queue. */
  endLaneLocked: (device: AndroidLaneDevice) => Promise<object>;
  stopLocked: (state: LaneState, device: AndroidLaneDevice, options: { refuseForeign: boolean; reason: AndroidEmulatorStopReason }) => Promise<void>;
  emitDeviceState: (laneId: string) => Promise<AndroidLaneDeviceStatus>;
  emit: (event: AndroidEmulatorEvent) => void;
  /** The power-off record the lane's status shows (`androidLaneMaintenance.ts`). */
  notePoweredOff: (key: string, record: Omit<AndroidPowerOffRecord, "at">) => void;
}): {
  /** The maintenance deps that act on one row; the service spreads them. */
  maintenance: AndroidLaneRowHooks;
  /** The machine sweep's idle stop of the lane's own device (`androidEmulatorUse.ts`). The caller holds the lane's queue. */
  stopIdleLocked: (laneId: string, device: AndroidLaneDevice, idleMinutes: number) => Promise<void>;
} {
  const { laneDevices, extras, logger, serialize } = ctx;

  /** The lane's own device, on the lane's queue: released when its lane ended. */
  const endLaneDevice = async (device: AndroidLaneDevice): Promise<void> => {
    await serialize(device.laneId, async () => {
      const current = laneDevices.get(device.laneId);
      if (!current || !sameAvdName(current.avdName, device.avdName)) return;
      const result = await ctx.endLaneLocked(current);
      logger?.info("android.cleanup.released", { laneId: device.laneId, avdName: device.avdName, ...result });
    });
    ctx.emit({ type: "android.device.state", laneId: device.laneId, state: "none" });
  };

  /** `--power-off-idle` of the lane's own device, on the lane's queue; `stillIdle` is asked there, and false throws. */
  const powerOffLaneDevice = async (device: AndroidLaneDevice, stillIdle: () => boolean): Promise<boolean> => {
    const laneId = device.laneId;
    const stopped = await serialize(laneId, async () => {
      const state = ctx.laneState(laneId);
      if (!stillIdle()) throw new Error(ANDROID_CAME_INTO_USE);
      const current = laneDevices.get(laneId);
      if (!current || !sameAvdName(current.avdName, device.avdName)) return false;
      await ctx.stopLocked(state, current, { refuseForeign: false, reason: "cleanup" });
      state.error = null;
      return true;
    });
    if (stopped) await ctx.emitDeviceState(laneId);
    return stopped;
  };

  const stopIdleLocked = async (laneId: string, device: AndroidLaneDevice, idleMinutes: number): Promise<void> => {
    const state = ctx.laneState(laneId);
    await ctx.stopLocked(state, device, { refuseForeign: false, reason: "idle" });
    state.error = null;
    // The lane keeps its device; its status says ADE powered it off, until the next start.
    ctx.notePoweredOff(laneId, { reason: "idle", idleMinutes });
    await ctx.emitDeviceState(laneId);
    ctx.emit({ type: "android.inventory.changed" });
  };

  const maintenance: AndroidLaneRowHooks = {
    keyOf: (device) => (device.extra === true ? androidExtraKey(device.laneId, device.avdName) : device.laneId),
    endLane: async (device) => {
      if (device.extra !== true) return endLaneDevice(device);
      await serialize(device.laneId, () => extras.release(device.laneId, device));
      logger?.info("android.cleanup.released_extra", { laneId: device.laneId, avdName: device.avdName });
    },
    forgetRow: (device) => {
      if (device.extra === true) laneDevices.forgetExtra(device.laneId, device.avdName);
      else laneDevices.forget(device.laneId, device.avdName);
      logger?.info("android.cleanup.forgot_row", { laneId: device.laneId, avdName: device.avdName });
    },
    isBusy: (device) => ctx.deviceBusy(device),
    powerOff: (device, guard) => (device.extra === true
      ? extras.powerOffIdle(device.laneId, device, guard.stillIdle)
      : powerOffLaneDevice(device, guard.stillIdle)),
  };
  return { maintenance, stopIdleLocked };
}
