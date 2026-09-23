import type {
  AppleDeviceDeleteArgs,
  AppleDeviceDeleteInstalledArgs,
  AppleDeviceDetachArgs,
  AppleLaneDevice,
  IosSimulatorEventPayload,
  IosSimulatorShutdownArgs,
  IosSimulatorShutdownResult,
} from "../../../shared/types";
import type { IosDeviceHub } from "./iosDeviceHub";
import { AppleDeviceAttachedNotDeletableError, type LaneDeviceRegistry } from "./laneDeviceRegistry";

/**
 * A lane giving up its device: detach, delete, a takeover, and the picker's
 * delete of a simulator no lane holds.
 *
 * The registry owns the binding and knows nothing about streams, chat claims
 * or hub sessions; the Apple service owns those and knows nothing about which
 * verb is tearing them down. These verbs sit between the two, so each one
 * tears down the same things in the same order.
 */

/** The slice of a lane's runtime these verbs read. */
export type LifecycleLaneRuntime = {
  key: string;
  laneId: string | null;
  streamStatus: { running: boolean; deviceUdid: string | null };
  hub: IosDeviceHub | null;
};

type LaneScope = { laneId?: string | null; chatSessionId?: string | null; projectRoot?: string | null };

export type LaneDeviceLifecycleDeps<R extends LifecycleLaneRuntime> = {
  laneDevices: LaneDeviceRegistry;
  /** The runtime for a lane id, or null when the lane has none yet. */
  runtimeForLane: (laneId: string) => R | null;
  allRuntimes: () => R[];
  resolveRuntime: (scope: LaneScope) => R;
  /** `resolveRuntime`, refusing a caller that names no lane. */
  requireLaneScope: (scope: LaneScope) => R;
  /** Runs a step with no other `deviceStart`, `deviceStop`, `deviceDetach` or `deviceDelete` on the lane. */
  serializeDeviceLifecycle: <T>(runtime: R, step: () => Promise<T>) => Promise<T>;
  assertDarwin: () => void;
  /**
   * `shutdown`'s single-owner rule, without the teardown: throws when another
   * chat owns the lane's session and the caller passed neither `force` nor
   * `ignoreOwnership`.
   */
  assertSessionOwner: (
    runtime: R,
    caller: { chatSessionId?: string | null; force?: boolean | null; ignoreOwnership?: boolean | null },
  ) => void;
  shutdown: (args: IosSimulatorShutdownArgs) => Promise<IosSimulatorShutdownResult>;
  stopRuntimeStream: (runtime: R) => Promise<unknown>;
  /** Best effort and never throws. */
  stopDeviceRecording: (udid: string, reason: "device-off" | "released") => Promise<void>;
  invalidateStatus: (runtime: R) => void;
  invalidateDeviceList: () => void;
  emit: (payload: IosSimulatorEventPayload) => void;
  logger: {
    info: (event: string, data?: Record<string, unknown>) => void;
    debug: (event: string, data?: Record<string, unknown>) => void;
  };
};

export function createLaneDeviceLifecycle<R extends LifecycleLaneRuntime>(deps: LaneDeviceLifecycleDeps<R>) {
  const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

  /**
   * End a lane's hold on its device and leave the simulator's power alone.
   *
   * Shared by a takeover and by `deviceDetach`. The recording, the stream,
   * the chat claim and the hub device session all go; the simulator keeps
   * running, because the next owner (another lane, or the picker's next
   * choice) may want it as it stands.
   */
  const releaseLaneHold = async (device: AppleLaneDevice): Promise<void> => {
    // The old lane's recording ends with its hold on the device. Left
    // running, it would record the new lane's work under the old lane, and
    // the new lane's `record-start` would be refused.
    await deps.stopDeviceRecording(device.udid, "released");
    const runtime = deps.runtimeForLane(device.laneId);
    if (!runtime) return;
    await deps.shutdown({ laneId: runtime.laneId, ignoreOwnership: true }).catch((error: unknown) => {
      deps.logger.debug("apple.lane_release_shutdown_failed", {
        laneId: device.laneId,
        udid: device.udid,
        error: errorText(error),
      });
    });
    if (runtime.hub?.getDeviceSession()?.deviceUdid === device.udid) {
      await runtime.hub.closeDevice({
        deviceUdid: device.udid,
        chatSessionId: null,
        ignoreOwnership: true,
        // Powering it off here would hand the next owner a dead simulator.
        shutdownDevice: false,
      }).catch((error: unknown) => {
        deps.logger.debug("apple.lane_release_close_device_failed", {
          laneId: device.laneId,
          udid: device.udid,
          error: errorText(error),
        });
      });
    }
    deps.invalidateStatus(runtime);
    // `released`, not `stopped`: the device is still running, it is just not
    // this lane's any more, and this lane has to re-list to find that out.
    deps.emit({ type: "apple.device.state", laneId: device.laneId, udid: device.udid, phase: "released" });
  };

  /**
   * The body of a detach, for a caller already in the lane's queue: forget
   * the binding, then release the lane's hold. Null when the lane had no device.
   */
  const detachStep = async (runtime: R): Promise<AppleLaneDevice | null> => {
    const detached = await deps.laneDevices.deviceDetach({ laneId: runtime.key });
    if (!detached) return null;
    // After the binding is gone, so the `released` event this sends is read
    // against a registry that already says the lane has no device.
    await releaseLaneHold(detached);
    deps.logger.info("apple.lane_device_detached_by_request", { laneId: detached.laneId, udid: detached.udid });
    return detached;
  };

  /**
   * Give up the lane's device and keep the simulator installed.
   *
   * The off card's "Choose another device": the lane goes back to the picker
   * and nothing is deleted, clone or attached. The simulator keeps its power
   * state and shows up in the picker as a free device. `deviceDelete` is the
   * verb that removes a clone.
   *
   * Same single-owner rule as `deviceStop`: a chat cannot detach a device
   * another chat is driving unless it passes `force` or `ignoreOwnership`.
   * Checked before anything changes, so a refused detach leaves the owner's
   * session running. Queued with `deviceStart` and `deviceStop`, so a start
   * already in flight cannot bind or boot the device again behind the detach.
   */
  const deviceDetach = async (detachArgs: AppleDeviceDetachArgs = {}): Promise<AppleLaneDevice | null> => {
    const runtime = deps.requireLaneScope(detachArgs);
    return deps.serializeDeviceLifecycle(runtime, async () => {
      if (!deps.laneDevices.get(runtime.key)) return null;
      deps.assertSessionOwner(runtime, detachArgs);
      return detachStep(runtime);
    });
  };

  /**
   * Give up the lane's device for good. A clone is deleted (the registry
   * powers it off first); an attached device is only detached, and only with
   * `force`, because ADE never deletes a simulator it did not create.
   *
   * Same single-owner rule as `deviceDetach`. `force` does not step around
   * it: it only says "detach an attached device". Everything is decided in
   * the lane's queue, from one read of the binding, so a start already in
   * flight cannot claim the session or change the device between the check
   * and the teardown.
   */
  const deviceDelete = async (deleteArgs: AppleDeviceDeleteArgs = {}): Promise<void> => {
    const runtime = deps.requireLaneScope(deleteArgs);
    await deps.serializeDeviceLifecycle(runtime, async () => {
      const laneDevice = deps.laneDevices.get(runtime.key);
      if (!laneDevice) return;
      deps.assertSessionOwner(runtime, { chatSessionId: deleteArgs.chatSessionId, ignoreOwnership: deleteArgs.ignoreOwnership });
      if (laneDevice.origin === "attached") {
        // Refused before the stream stops, so the owner keeps a working view.
        if (!deleteArgs.force) throw new AppleDeviceAttachedNotDeletableError(laneDevice);
        await detachStep(runtime);
        return;
      }
      // Whatever was driving it stops first: deleting a simulator out from
      // under a running stream leaves the reader waiting on bytes that never come.
      await deps.shutdown({ laneId: runtime.laneId, chatSessionId: deleteArgs.chatSessionId, ignoreOwnership: true })
        .catch(() => undefined);
      await deps.laneDevices.deviceDelete({ laneId: runtime.key });
      deps.invalidateStatus(runtime);
      // The lane's binding changed ("Choose another device"): every surface
      // that shows the lane's device re-reads now rather than on its next poll.
      deps.emit({ type: "apple.device.state", laneId: runtime.key, udid: laneDevice.udid, phase: "released" });
    });
  };

  /**
   * Stop every stream and hub device session reading a device no lane holds.
   *
   * `resolveRuntime` can hand an un-laned caller a runtime for any simulator,
   * so a device the picker may delete can still have a reader. Left alone, it
   * waits on a deleted device.
   */
  const releaseUnlanedHolds = async (udid: string): Promise<void> => {
    for (const runtime of deps.allRuntimes()) {
      if (runtime.streamStatus.running && runtime.streamStatus.deviceUdid === udid) {
        await deps.stopRuntimeStream(runtime);
      }
      if (runtime.hub?.getDeviceSession()?.deviceUdid === udid) {
        await runtime.hub.closeDevice({
          deviceUdid: udid,
          chatSessionId: null,
          ignoreOwnership: true,
          // The registry powers it off before the delete.
          shutdownDevice: false,
        }).catch((error: unknown) => {
          deps.logger.debug("apple.delete_installed_close_device_failed", { udid, error: errorText(error) });
        });
      }
    }
  };

  /**
   * Remove an installed simulator by udid — the picker's per-device menu.
   *
   * No `requireLaneScope`: the target is named outright and the registry's own
   * guard is the one that matters (it refuses any device a lane holds). Asking
   * for a lane scope here would only say which lane is doing the tidying.
   */
  const deviceDeleteInstalled = async (deleteArgs: AppleDeviceDeleteInstalledArgs): Promise<void> => {
    deps.assertDarwin();
    if (deleteArgs?.confirmedByUser !== true) {
      // The check stays as a second guard behind the RPC gate that keeps this
      // verb for user clients. The message does not coach a caller past it:
      // deleting a simulator is the user's call, made in the picker.
      throw new Error(
        "Deleting an installed simulator is the user's call. Ask them to delete it from the Apple Development device picker (the ⋯ menu on the device), which confirms it by name.",
      );
    }
    const runtime = deps.resolveRuntime(deleteArgs);
    const udid = deleteArgs.udid?.trim() ?? "";
    // A device a lane holds is refused by the registry below. Nothing is torn
    // down for it first, so a refused delete changes nothing. The registry's
    // power-off stops the recording and resets the helper session.
    if (udid && !deps.laneDevices.list().some((device) => device.udid === udid)) {
      await releaseUnlanedHolds(udid);
    }
    await deps.laneDevices.deviceDeleteInstalled({ udid: deleteArgs.udid });
    deps.invalidateDeviceList();
    deps.invalidateStatus(runtime);
  };

  return { releaseLaneHold, deviceDetach, deviceDelete, deviceDeleteInstalled };
}
