import type { AndroidEmulatorEvent, AndroidLaneDevice, AndroidLaneDeviceStatus } from "../../../shared/types/androidEmulator";
import type { Logger } from "../logging/logger";
import { sameAvdName } from "./androidAvds";
import type { AndroidEmulatorStopReason } from "./androidEmulatorOwners";
import type { AndroidLaneState as LaneState } from "./androidEmulatorServiceDeps";
import { androidExtraKey, type AndroidLaneExtras } from "./androidLaneExtras";
import type { AndroidLaneDeviceRepo } from "./androidLaneRelease";

/*
 * How the cleanup pass (`androidLaneMaintenance.ts`) reaches one lane row:
 * the lane's own device, on the lane's queue, or one of its extras, on the
 * extra's own queue. Split out of `androidEmulatorService.ts`.
 *
 * Node built-ins and relative imports only, so it runs under `tsx`.
 */

export type AndroidLaneRowOps = {
  /** The row's power-off record key: the lane id, or the extra's key. */
  key: string;
  /** The row's lane ended: release it by the normal rules. */
  endLane: () => Promise<void>;
  /** Its AVD is gone from disk: drop the row. */
  forgetRow: () => void;
  isBusy: () => boolean;
  /** `--power-off-idle`: stop it on its queue; `stillIdle` is asked there, and false throws. */
  powerOff: (stillIdle: () => boolean) => Promise<boolean>;
};

export function createAndroidLaneRows(ctx: {
  laneDevices: AndroidLaneDeviceRepo;
  extras: AndroidLaneExtras;
  logger: Logger | null;
  serialize: <T>(key: string, step: () => Promise<T>) => Promise<T>;
  laneState: (laneId: string) => LaneState;
  /** The lane's emulator in use here now (`androidEmulatorUse.ts`). */
  laneBusy: (laneId: string) => boolean;
  /** A lane ended: its extras, then its own device. The caller holds the lane's queue. */
  endLaneLocked: (device: AndroidLaneDevice) => Promise<object>;
  stopLocked: (state: LaneState, device: AndroidLaneDevice, options: { refuseForeign: boolean; reason?: AndroidEmulatorStopReason }) => Promise<void>;
  emitDeviceState: (laneId: string) => Promise<AndroidLaneDeviceStatus>;
  emit: (event: AndroidEmulatorEvent) => void;
}): (device: AndroidLaneDevice) => AndroidLaneRowOps {
  const { laneDevices, extras, logger, serialize } = ctx;

  const extraOps = (device: AndroidLaneDevice): AndroidLaneRowOps => ({
    key: androidExtraKey(device.laneId, device.avdName),
    endLane: async () => {
      await serialize(device.laneId, () => extras.release(device.laneId, device));
      logger?.info("android.cleanup.released_extra", { laneId: device.laneId, avdName: device.avdName });
    },
    forgetRow: () => laneDevices.forgetExtra(device.laneId, device.avdName),
    isBusy: () => ctx.laneBusy(device.laneId) || extras.busyReason(device.laneId, device.avdName) !== null,
    powerOff: (stillIdle) => extras.powerOffIdle(device.laneId, device, stillIdle),
  });

  const laneOps = (device: AndroidLaneDevice): AndroidLaneRowOps => ({
    key: device.laneId,
    endLane: async () => {
      await serialize(device.laneId, async () => {
        const current = laneDevices.get(device.laneId);
        if (!current || !sameAvdName(current.avdName, device.avdName)) return;
        const result = await ctx.endLaneLocked(current);
        logger?.info("android.cleanup.released", { laneId: device.laneId, avdName: device.avdName, ...result });
      });
      ctx.emit({ type: "android.device.state", laneId: device.laneId, state: "none" });
    },
    forgetRow: () => laneDevices.forget(device.laneId, device.avdName),
    isBusy: () => ctx.laneBusy(device.laneId),
    powerOff: async (stillIdle) => {
      const laneId = device.laneId;
      const stopped = await serialize(laneId, async () => {
        const state = ctx.laneState(laneId);
        // Something started using it (a lease, a test run, a call) or the person pinned it while the pass waited.
        if (!stillIdle()) throw new Error("The emulator came into use or was pinned, so ADE left it running.");
        const current = laneDevices.get(laneId);
        if (!current || !sameAvdName(current.avdName, device.avdName)) return false;
        await ctx.stopLocked(state, current, { refuseForeign: false, reason: "cleanup" });
        state.error = null;
        return true;
      });
      if (stopped) await ctx.emitDeviceState(laneId);
      return stopped;
    },
  });

  return (device) => (device.extra === true ? extraOps(device) : laneOps(device));
}
