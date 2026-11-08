import type {
  AndroidEmulatorEvent,
  AndroidEmulatorServiceApi,
  AndroidLaneDevice,
  AndroidLaneDeviceStatus,
} from "../../../shared/types/androidEmulator";
import type { Logger } from "../logging/logger";
import { getErrorMessage } from "../shared/utils";
import { requireLaneId } from "./androidEmulatorErrors";
import type { AndroidStartOptions, createAndroidEmulatorLifecycle } from "./androidEmulatorLifecycle";
import type { AndroidLaneState as LaneState } from "./androidEmulatorServiceDeps";
import { requireLaneDeviceNamed, type AndroidLaneExtras } from "./androidLaneExtras";
import type { AndroidLaneDeviceRepo } from "./androidLaneRelease";

/*
 * `start`, `stop` and `releaseDevice` with their `device`: to one of the
 * lane's extras (`androidLaneExtras.ts`), else to the lane's own device on the
 * lane's queue. Also `stopForLane`, the lane archive's stop of every device
 * the lane holds. Split out of `androidEmulatorService.ts`.
 *
 * A promote swaps the lane's device, so each call waits for a promote in
 * progress before it reads which device `device` names. A call that named the
 * lane's own device checks again in the lane's queue that the lane still
 * holds it: a device-detach never deletes an AVD the caller did not name.
 *
 * Node built-ins and relative imports only, so it runs under `tsx`.
 */

type Lifecycle = ReturnType<typeof createAndroidEmulatorLifecycle>;
type Verbs = Pick<AndroidEmulatorServiceApi, "start" | "stop" | "releaseDevice" | "stopForLane">;

export function createAndroidDeviceRouter(ctx: {
  laneDevices: AndroidLaneDeviceRepo;
  extras: AndroidLaneExtras;
  /** Waits until no promote runs on the lane (`androidDevicePromote.ts`). */
  settled: (laneId: string) => Promise<void>;
  serialize: <T>(key: string, step: () => Promise<T>) => Promise<T>;
  laneState: (laneId: string) => LaneState;
  assertLive: () => void;
  assertWorkCopyLive: (laneId: string) => void;
  avdHome: () => string | null;
  /** A chat's work copy has no device until its first start asks for one. The caller holds the lane's queue. */
  ensureDeviceLocked: (laneId: string) => Promise<void>;
  startLocked: Lifecycle["startLocked"];
  stopLocked: Lifecycle["stopLocked"];
  interruptBoot: Lifecycle["interruptBoot"];
  /** The SDK's adb; throws without one. */
  adbPath: () => Promise<string>;
  stopLaneStream: (state: LaneState) => Promise<void>;
  laneStatus: (laneId: string) => Promise<AndroidLaneDeviceStatus>;
  emitDeviceState: (laneId: string) => Promise<AndroidLaneDeviceStatus>;
  /** The lane's own device goes (`androidDeviceInventory.ts`). */
  releaseLaneDevice: Verbs["releaseDevice"];
  abortBoot: Lifecycle["abortBoot"];
  /** The service keeps state for this lane. */
  hasLane: (laneId: string) => boolean;
  forgetLane: (laneId: string) => void;
  emit: (event: AndroidEmulatorEvent) => void;
  logger: Logger | null;
}): Verbs {
  const { extras, serialize } = ctx;

  /** The extra `device` names after any promote in progress, or null for the lane's own device. */
  const target = async (laneId: string, device: string | null | undefined): Promise<AndroidLaneDevice | null> => {
    await ctx.settled(laneId);
    return extras.resolveTarget(laneId, device);
  };

  return {
    async start(args) {
      ctx.assertLive();
      const laneId = requireLaneId(args.laneId);
      const options: AndroidStartOptions = {
        force: args.force === true,
        restartAdb: args.restartAdb === true,
        chatSessionId: args.chatSessionId ?? null,
      };
      // `start --device <extra>`: that extra boots beside the lane's device, on its own queue.
      const extra = await target(laneId, args.device);
      if (extra) {
        ctx.assertWorkCopyLive(laneId);
        await extras.start(laneId, extra, options);
        return ctx.laneStatus(laneId);
      }
      return serialize(laneId, async () => {
        ctx.assertWorkCopyLive(laneId);
        await ctx.ensureDeviceLocked(laneId);
        requireLaneDeviceNamed(ctx.laneDevices, laneId, args.device, ctx.avdHome());
        return ctx.startLocked(ctx.laneState(laneId), options);
      });
    },

    async stop(args) {
      const laneId = requireLaneId(args.laneId);
      const extra = await target(laneId, args.device);
      if (extra) {
        await extras.stop(laneId, extra);
        return ctx.laneStatus(laneId);
      }
      const state = ctx.laneState(laneId);
      await ctx.interruptBoot(state, ctx.adbPath);
      return serialize(laneId, async () => {
        requireLaneDeviceNamed(ctx.laneDevices, laneId, args.device, ctx.avdHome());
        state.stopRequested = false;
        const device = ctx.laneDevices.get(laneId);
        if (device) await ctx.stopLocked(state, device, { refuseForeign: true, reason: "user" });
        else await ctx.stopLaneStream(state);
        state.error = null;
        return ctx.emitDeviceState(laneId);
      });
    },

    /* `device-detach --device <extra>`: that extra goes (deleted unless `deleteCreated` is false); the lane keeps its device. */
    async releaseDevice(args) {
      const laneId = requireLaneId(args.laneId);
      const extra = await target(laneId, args.device);
      if (!extra) return ctx.releaseLaneDevice(args);
      return serialize(laneId, async () => ({
        ...(await extras.release(laneId, extra, { deleteCreated: args.deleteCreated !== false })),
        extra: true,
      }));
    },

    /** The lane was archived: its device and its extras stop; the lane release deletes them after. */
    async stopForLane(laneId) {
      const id = laneId?.trim();
      if (!id) return;
      const hadState = ctx.hasLane(id);
      const state = ctx.laneState(id);
      if (state.transient === "starting") {
        await ctx.abortBoot(state, () => ctx.adbPath().catch(() => null));
      }
      let hadDevice = false;
      await serialize(id, async () => {
        state.stopRequested = false;
        const device = ctx.laneDevices.get(id);
        hadDevice = device !== null;
        if (device) await ctx.stopLocked(state, device, { refuseForeign: false, reason: "lane_released" });
        else await ctx.stopLaneStream(state);
      }).catch((error: unknown) => {
        ctx.logger?.warn("android.stop_for_lane_failed", { laneId: id, error: getErrorMessage(error) });
      });
      await extras.stopAll(id);
      ctx.forgetLane(id);
      if (hadDevice || hadState) ctx.emit({ type: "android.device.state", laneId: id, state: hadDevice ? "off" : "none" });
    },
  };
}
