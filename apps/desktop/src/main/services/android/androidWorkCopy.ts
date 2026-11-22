import type { AndroidAvd, AndroidEmulatorEvent, AndroidLaneDevice } from "../../../shared/types/androidEmulator";
import type { Logger } from "../logging/logger";
import { getErrorMessage } from "../shared/utils";
import {
  findRemoteWorkCopyForLane,
  isRemoteWorkLaneId,
  onRemoteWorkCopyReleased,
  registerRemoteWorkDeviceCheck,
  remoteWorkLaneState,
} from "../remoteWork/remoteWorkCopyService";
import { readAdeAvdLaneId, sameAvdName } from "./androidAvds";
import { AndroidEmulatorFailure } from "./androidEmulatorErrors";
import type { AndroidDiscoveredEmulator } from "./androidEmulatorProcess";
import type { AndroidLaneState as LaneState } from "./androidEmulatorServiceDeps";
import type { AndroidLaneDeviceRepo } from "./androidLaneRelease";

/*
 * The lanes the Android service serves: this project's lanes, and chats on
 * other machines that stand in for a lane with their work copy here
 * (`remote-work-…`, as in the Apple service). The copy is the lane's folder,
 * and the lane lives as long as the copy.
 *
 * Node built-ins and relative imports only, so it runs under `tsx`.
 */

export function createAndroidLaneScope(input: {
  /** Where chats on other machines keep their work copies; without it a `remote-work-…` lane is refused. */
  projectRoot?: string | null;
  resolveLaneWorktreePath?: (laneId: string) => string | null;
  laneDevices: Pick<AndroidLaneDeviceRepo, "laneState">;
}) {
  const projectRoot = input.projectRoot?.trim() || null;

  /** The work copy a `remote-work-…` lane names here, while it exists. */
  const workCopyPath = (laneId: string): string | null =>
    projectRoot ? findRemoteWorkCopyForLane(projectRoot, laneId)?.path ?? null : null;

  return {
    /** The folder a lane's files stay in: its worktree, or a chat's work copy. */
    laneRoot: (laneId: string): string | null =>
      isRemoteWorkLaneId(laneId) ? workCopyPath(laneId) : input.resolveLaneWorktreePath?.(laneId) ?? null,

    /** Whether the lane still exists; null when this service cannot tell. */
    laneLiveness: (laneId: string): "active" | "archived" | "missing" | null => {
      if (isRemoteWorkLaneId(laneId)) {
        const state = projectRoot ? remoteWorkLaneState(projectRoot, laneId) : "unknown";
        return state === "unknown" ? null : state === "live" ? "active" : "missing";
      }
      return input.laneDevices.laneState?.(laneId) ?? null;
    },

    /** A chat's work copy that is gone (or that this service cannot see) has no device here. */
    assertWorkCopyLive: (laneId: string): void => {
      if (!isRemoteWorkLaneId(laneId) || workCopyPath(laneId)) return;
      throw new AndroidEmulatorFailure(
        "ANDROID_NOT_RUNNING",
        projectRoot
          ? "This chat has no copy of its code on this machine, so it has no Android device here. `ade android start --machine` makes the copy and its device."
          : "This ADE cannot find work copies of chats on other machines, so it has no Android device for one.",
      );
    },

    /** Calls `listener` with the lane id of each work copy deleted here. */
    onWorkCopyReleased: (listener: (laneId: string) => void): (() => void) =>
      projectRoot ? onRemoteWorkCopyReleased(projectRoot, listener) : () => undefined,

    /**
     * Tells the work-copy cleanups whether a copy's emulator is in use, so an
     * idle or low-disk sweep keeps the copy (and its device) while it is.
     */
    registerWorkCopyDeviceCheck: (deviceInUse: (laneId: string) => boolean): (() => void) =>
      projectRoot ? registerRemoteWorkDeviceCheck(projectRoot, deviceInUse) : () => undefined,
  };
}

/**
 * The AVD a chat's work copy borrows, or null to make a new one. Only an ADE
 * AVD made for a lane of this project is borrowed: one made for a lane this
 * project cannot see may be another project's lane's. The user's own AVDs are
 * never taken: this lane table cannot see a lane of another project that
 * holds one, and a run can rewrite the AVD's snapshot. Free means no lane
 * here holds it and it does not run outside ADE; stopped ones come before
 * running ones.
 */
export function pickWorkCopyAvd(
  avds: readonly AndroidAvd[],
  running: readonly AndroidDiscoveredEmulator[],
  lanes: Pick<AndroidLaneDeviceRepo, "holder" | "laneState"> & { owns: (emulator: AndroidDiscoveredEmulator) => boolean },
): AndroidAvd | null {
  const runningAvd = (avd: AndroidAvd) => running.find((emulator) => sameAvdName(emulator.avdName, avd.name)) ?? null;
  const madeForThisProject = (avd: AndroidAvd): boolean => {
    const madeFor = readAdeAvdLaneId(avd);
    if (!madeFor || isRemoteWorkLaneId(madeFor)) return false;
    const liveness = lanes.laneState?.(madeFor) ?? null;
    return liveness === "active" || liveness === "archived";
  };
  const rank = (avd: AndroidAvd): number => (runningAvd(avd) ? 1 : 0);
  const free = avds
    .filter((avd) => {
      if (!avd.adeCreated || !madeForThisProject(avd)) return false;
      if (lanes.holder(avd.name) !== null) return false;
      const emulator = runningAvd(avd);
      return !emulator || lanes.owns(emulator);
    })
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  return free[0] ?? null;
}

/**
 * The service's watch on chats' work copies here. A copy that was deleted
 * gives its device and its extras back, on the lane's queue. A copy whose
 * emulator is in use (starting, stopping, streaming, or running for its lane,
 * an extra included) is kept through the idle and low-disk cleanups. The
 * answer ends both.
 */
export function watchAndroidWorkCopyDevices(ctx: {
  laneDevices: Pick<AndroidLaneDeviceRepo, "get" | "extras">;
  isDisposed: () => boolean;
  laneLiveness: (laneId: string) => "active" | "archived" | "missing" | null;
  serialize: <T>(key: string, step: () => Promise<T>) => Promise<T>;
  peekLane: (laneId: string) => LaneState | undefined;
  runningFor: (avdName: string) => AndroidDiscoveredEmulator | null;
  /** The extras of a lane with no device of its own go. The caller holds the lane's queue. */
  endExtrasLocked: (laneId: string) => Promise<void>;
  /** The lane's extras, then its own device, go. The caller holds the lane's queue. */
  endLaneLocked: (device: AndroidLaneDevice) => Promise<object>;
  onWorkCopyReleased: (listener: (laneId: string) => void) => () => void;
  registerWorkCopyDeviceCheck: (check: (laneId: string) => boolean) => () => void;
  emit: (event: AndroidEmulatorEvent) => void;
  logger: Logger | null;
}): () => void {
  const { laneDevices } = ctx;
  const offReleased = ctx.onWorkCopyReleased((laneId) => {
    if (ctx.isDisposed() || (!laneDevices.get(laneId) && laneDevices.extras(laneId).length === 0)) return;
    void ctx.serialize(laneId, async () => {
      // A new copy for the same chat may have come back while this waited,
      // and an unreadable copy list is not proof that the copy is gone.
      if (ctx.laneLiveness(laneId) !== "missing") return;
      const device = laneDevices.get(laneId);
      if (!device) {
        await ctx.endExtrasLocked(laneId);
        return;
      }
      const result = await ctx.endLaneLocked(device);
      ctx.logger?.info("android.work_copy_released", { laneId, avdName: device.avdName, ...result });
      ctx.emit({ type: "android.inventory.changed" });
      ctx.emit({ type: "android.device.state", laneId, state: "none" });
    }).catch((error: unknown) => {
      ctx.logger?.warn("android.work_copy_release_failed", { laneId, error: getErrorMessage(error) });
    });
  });
  const offCheck = ctx.registerWorkCopyDeviceCheck((laneId) => {
    if (ctx.isDisposed() || !isRemoteWorkLaneId(laneId)) return false;
    const state = ctx.peekLane(laneId);
    if (state?.transient || state?.launch || state?.streamSerial) return true;
    const device = laneDevices.get(laneId);
    if (device && ctx.runningFor(device.avdName)) return true;
    return laneDevices.extras(laneId).some((extra) => ctx.runningFor(extra.avdName) !== null);
  });
  return () => {
    offReleased();
    offCheck();
  };
}
