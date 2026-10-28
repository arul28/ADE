import type {
  AppleDeviceDeleteArgs,
  AppleDeviceDeleteInstalledArgs,
  AppleDeviceDetachArgs,
  AppleDevicePromoteArgs,
  AppleDevicePromoteResult,
  AppleLaneDevice,
  IosSimulatorEventPayload,
  IosSimulatorShutdownArgs,
  IosSimulatorShutdownResult,
} from "../../../shared/types";
import type { IosDeviceHub } from "./iosDeviceHub";
import { AppleDeviceAttachedNotDeletableError } from "./appleDeviceErrors";
import { AdeExpectedError } from "../../../shared/expectedError";
import { APPLE_LANE_DEVICE_BUSY_CODE, isAdeOwnedLaneDevice } from "../../../shared/types/iosSimulator";
import type { LaneDeviceRegistry } from "./laneDeviceRegistry";

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
  /**
   * What the lane's device is busy with right now, as a phrase ("streaming
   * to the pane", "recording"), or null when nothing would break if it
   * stopped being the lane's device. `chatSessionId` is the caller: its own
   * lease is not a reason to refuse it. The Apple service always passes it;
   * without it only the stream is checked.
   */
  laneDeviceBusyReason?: (runtime: R, device: AppleLaneDevice, chatSessionId: string | null) => string | null;
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
  const detachStep = async (
    runtime: R,
    agentCaller: boolean | null | undefined,
    keep = false,
  ): Promise<AppleLaneDevice | null> => {
    const by = agentCaller === true ? "agent" : "user";
    const detached = await deps.laneDevices.deviceDetach({ laneId: runtime.key, by, ...(keep ? { keep: true } : {}) });
    if (!detached) return null;
    // After the binding is gone, so the `released` event this sends is read
    // against a registry that already says the lane has no device.
    await releaseLaneHold(detached);
    // `by` names the kind of caller, so a lane that lost its device can be
    // traced to the pane or to an agent.
    deps.logger.info("apple.lane_device_detached_by_request", { laneId: detached.laneId, udid: detached.udid, by });
    return detached;
  };

  /**
   * Refuse a device that is not the one the caller displayed.
   *
   * A UI reads a device, then acts on the LANE; between the two the lane's
   * device can change. A caller that names a udid gets the same read-act safety
   * the lane queue already gives a single operation. Callers that name none
   * (the CLI, the pane) keep the lane-scoped default.
   */
  const assertExpectedDevice = (device: AppleLaneDevice, expectedUdid: string | null | undefined): void => {
    const wanted = expectedUdid?.trim();
    if (wanted && wanted !== device.udid) {
      throw new Error(
        `APPLE_DEVICE_CHANGED: this lane's device is now ${device.udid}, not ${wanted}. Re-read the device and try again.`,
      );
    }
  };

  /**
   * Give up the lane's device and keep the simulator installed.
   *
   * The off card's "Choose another device": the lane goes back to the picker
   * and nothing is deleted now. The simulator keeps its power
   * state and shows up in the picker as a free device. `deviceDelete` is the
   * verb that removes an ADE device. An ADE device that no lane picks again is
   * a leftover, and the cleanup pass deletes it after its grace period.
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
      const laneDevice = deps.laneDevices.get(runtime.key);
      if (!laneDevice) return null;
      assertExpectedDevice(laneDevice, detachArgs.udid);
      deps.assertSessionOwner(runtime, detachArgs);
      return detachStep(runtime, detachArgs.agentCaller, detachArgs.keep === true);
    });
  };

  /**
   * Give up the lane's device for good. An ADE device is deleted (the registry
   * powers it off first); an attached device is only detached, and only with
   * `force`, because ADE never deletes a simulator it did not create.
   *
   * Same single-owner rule as `deviceDetach`. `force` does not step around
   * it: it only says "detach an attached device". Everything is decided in
   * the lane's queue, from one read of the binding, so a `deviceStart` already
   * in flight cannot claim the session or change the device between the check
   * and the teardown. The standalone attach and create verbs are not queued,
   * so the registry delete names the udid read here and does nothing when the
   * lane holds another device by then.
   */
  const deviceDelete = async (deleteArgs: AppleDeviceDeleteArgs = {}): Promise<void> => {
    const runtime = deps.requireLaneScope(deleteArgs);
    await deps.serializeDeviceLifecycle(runtime, async () => {
      // `device-delete --device <udid|name>` naming one of the lane's extra devices.
      const extra = deps.laneDevices.findExtra(runtime.key, deleteArgs.udid ?? null);
      if (extra) {
        // The same single-owner rule as the lane's own device: a chat that does
        // not hold the lane's devices cannot delete one out from under it.
        deps.assertSessionOwner(runtime, { chatSessionId: deleteArgs.chatSessionId, ignoreOwnership: deleteArgs.ignoreOwnership });
        await deps.laneDevices.deviceDeleteExtra({ laneId: extra.laneId, udid: extra.udid });
        deps.invalidateDeviceList();
        deps.invalidateStatus(runtime);
        return;
      }
      const laneDevice = deps.laneDevices.get(runtime.key);
      if (!laneDevice) return;
      assertExpectedDevice(laneDevice, deleteArgs.udid);
      deps.assertSessionOwner(runtime, { chatSessionId: deleteArgs.chatSessionId, ignoreOwnership: deleteArgs.ignoreOwnership });
      if (laneDevice.origin === "attached") {
        // Refused before the stream stops, so the owner keeps a working view.
        if (!deleteArgs.force) throw new AppleDeviceAttachedNotDeletableError(laneDevice);
        await detachStep(runtime, deleteArgs.agentCaller);
        return;
      }
      // Whatever was driving it stops first: deleting a simulator out from
      // under a running stream leaves the reader waiting on bytes that never come.
      await deps.shutdown({ laneId: runtime.laneId, chatSessionId: deleteArgs.chatSessionId, ignoreOwnership: true })
        .catch(() => undefined);
      await deps.laneDevices.deviceDelete({ laneId: runtime.key, udid: laneDevice.udid });
      deps.invalidateStatus(runtime);
      // The lane's binding changed ("Choose another device"): every surface
      // that shows the lane's device re-reads now rather than on its next poll.
      deps.emit({ type: "apple.device.state", laneId: runtime.key, udid: laneDevice.udid, phase: "released" });
    });
  };

  /**
   * One of the lane's extra devices becomes the lane's own device.
   *
   * An extra cannot stream, record, launch a build or run tests; this is the
   * way to show the user a device that already has the build and the
   * sign-in, without making a new one. In the lane's queue, so a start or
   * stop cannot interleave. Refused while the old device is in use, before
   * anything changes. The old device stays installed: an ADE device becomes
   * an extra in the promoted one's slot (the extra limit is unchanged, and
   * the cleanup pass would delete a detached ADE device), and an attached
   * simulator is detached back to the user.
   */
  const devicePromote = async (promoteArgs: AppleDevicePromoteArgs): Promise<AppleDevicePromoteResult> => {
    deps.assertDarwin();
    const runtime = deps.requireLaneScope(promoteArgs);
    const wanted = promoteArgs.device?.trim();
    if (!wanted) {
      throw new AdeExpectedError("device-promote needs --device <udid|name> of one of this lane's extra devices.", "user");
    }
    return deps.serializeDeviceLifecycle(runtime, async () => {
      const current = deps.laneDevices.get(runtime.key);
      const extra = deps.laneDevices.findExtra(runtime.key, wanted);
      if (!extra) {
        // Already the lane's device: the state the caller asked for.
        if (current && (current.udid === wanted || current.name.toLowerCase() === wanted.toLowerCase())) {
          return { device: current, previous: null, previousKeptAs: null };
        }
        throw new AdeExpectedError(
          `${wanted} is not one of this lane's extra devices. ade apple device-list --text lists the lane's devices.`,
          "user",
        );
      }
      if (current) {
        const busy = deps.laneDeviceBusyReason
          ? deps.laneDeviceBusyReason(runtime, current, promoteArgs.chatSessionId ?? null)
          : runtime.streamStatus.running && runtime.streamStatus.deviceUdid === current.udid
            ? "streaming its live view"
            : null;
        if (busy) {
          throw new AdeExpectedError(
            `${APPLE_LANE_DEVICE_BUSY_CODE}: the lane's device ${current.name} is ${busy}, so it cannot hand over to `
            + `${extra.name} now. Finish or stop that first (stream-stop, record-stop, or wait for the test or the lease), `
            + "then run device-promote again.",
            "user",
          );
        }
        deps.assertSessionOwner(runtime, {
          chatSessionId: promoteArgs.chatSessionId,
          ignoreOwnership: promoteArgs.ignoreOwnership,
        });
      }
      let previousKeptAs: AppleDevicePromoteResult["previousKeptAs"] = null;
      if (current && !isAdeOwnedLaneDevice(current.origin)) {
        // The user's simulator: it goes back to them, still installed.
        await detachStep(runtime, promoteArgs.agentCaller);
        previousKeptAs = "detached";
      } else if (current) {
        // The claim, the hub session and anything else on the old device go;
        // its power is left alone, and it stays the lane's as an extra.
        await releaseLaneHold(current);
        previousKeptAs = "extra";
      }
      const swapped = deps.laneDevices.promoteExtra({ laneId: runtime.key, udid: extra.udid });
      if (!swapped) {
        throw new AdeExpectedError(`${extra.name} stopped being one of this lane's extra devices. Run device-list and try again.`, "user");
      }
      deps.invalidateDeviceList();
      deps.invalidateStatus(runtime);
      deps.emit({ type: "apple.device.state", laneId: runtime.key, udid: swapped.device.udid, phase: "released" });
      deps.logger.info("apple.lane_device_promoted", {
        laneId: runtime.key,
        udid: swapped.device.udid,
        previousUdid: current?.udid ?? null,
        previousKeptAs,
        by: promoteArgs.agentCaller === true ? "agent" : "user",
      });
      return { device: swapped.device, previous: current ?? null, previousKeptAs };
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

  return { releaseLaneHold, releaseUnlanedHolds, deviceDetach, devicePromote, deviceDelete, deviceDeleteInstalled };
}
