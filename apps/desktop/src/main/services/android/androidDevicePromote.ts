import type {
  AndroidDevicePromoteArgs,
  AndroidDevicePromoteResult,
  AndroidDeviceTargetArgs,
  AndroidEmulatorEvent,
  AndroidLaneDevice,
  AndroidLaneDeviceStatus,
  AndroidTargetDevice,
} from "../../../shared/types/androidEmulator";
import type { Logger } from "../logging/logger";
import type { BootedDevice } from "./androidDeviceShell";
import { AndroidEmulatorFailure, requireLaneId } from "./androidEmulatorErrors";
import type { createAndroidEmulatorLifecycle } from "./androidEmulatorLifecycle";
import type { AdeStartedEmulators, AndroidDiscoveredEmulator } from "./androidEmulatorProcess";
import type { AndroidEmulatorServiceDeps, AndroidLaneState as LaneState } from "./androidEmulatorServiceDeps";
import { androidExtraKey, namesAndroidDevice, type AndroidLaneExtras } from "./androidLaneExtras";

/*
 * `devicePromote`: one of the lane's extra devices becomes the lane's own
 * device, split out of `androidEmulatorService.ts`. Also the jobs a promote
 * must not cut through: an install or a launch on the lane's device or one
 * of its extras (`onLaneOrExtra`), and a test run (`runTests`).
 *
 * A promote runs in the lane's queue, so no start, stop, create or release
 * of the lane can interleave. While it runs, an install or a launch for the
 * lane (on its device or one of its extras) waits until it ends (`settled`),
 * as a start waits behind the lane's queue, so no job lands on the old
 * device and then opens on the new one.
 *
 * Node built-ins and relative imports only, so it runs under `tsx`.
 */

type Lifecycle = ReturnType<typeof createAndroidEmulatorLifecycle>;

export type AndroidDevicePromoteContext = {
  deps: Pick<AndroidEmulatorServiceDeps, "laneDevices" | "captureAnalytics">;
  logger: Logger | null;
  extras: AndroidLaneExtras;
  /** The project's started-emulators file and the extras' own: a promote moves a running emulator between them. */
  registry: AdeStartedEmulators;
  extraRegistry: AdeStartedEmulators;
  peekLane: (laneId: string) => LaneState | undefined;
  laneState: (laneId: string) => LaneState;
  serialize: <T>(key: string, step: () => Promise<T>) => Promise<T>;
  assertLive: () => void;
  assertWorkCopyLive: (laneId: string) => void;
  avdHome: () => string | null;
  runningFor: (avdName: string) => AndroidDiscoveredEmulator | null;
  laneStatus: (laneId: string) => Promise<AndroidLaneDeviceStatus>;
  emitDeviceState: (laneId: string) => Promise<AndroidLaneDeviceStatus>;
  emit: (event: AndroidEmulatorEvent) => void;
  stopLocked: Lifecycle["stopLocked"];
  adoptLaunch: Lifecycle["adoptLaunch"];
  crashWatch: { stop: (laneId: string) => void };
  stopLaneStream: (state: LaneState) => Promise<void>;
  /** `held`: a viewer or a recording holds the lane's stream. */
  laneStreams: { held: (laneId: string) => boolean };
  agent: {
    isRecording: (laneId: string) => boolean;
    otherLeaseHolder: (laneId: string, chatSessionId: string | null) => string | null;
    beforeRelease: (laneId: string) => Promise<void>;
    invalidateUi: (laneId: string) => void;
    recordings: { forgetScreenSize: (laneId: string) => void };
    onDeviceBooted: (laneId: string) => void;
  };
  /** `started`: a new device under a key, so its power-off record goes (`androidLaneMaintenance.ts`). */
  maintenance: { started: (key: string) => void };
  /** The machine lifecycle's idle clock, by AVD name. */
  touch: (avdName: string) => void;
};

function busyFailure(message: string): AndroidEmulatorFailure {
  return new AndroidEmulatorFailure("ANDROID_LANE_DEVICE_BUSY", message);
}

export function createAndroidDevicePromote(ctx: AndroidDevicePromoteContext) {
  const { deps, extras, logger } = ctx;
  /** Installs and launches in flight on each lane's own device. */
  const laneJobs = new Map<string, number>();
  /** Instrumentation test runs in progress on each lane's own device, counted: one call never clears another's. */
  const testsRunning = new Map<string, number>();
  /** The promote that runs now on each lane, from the start of its step in the lane's queue to its end. */
  const promoting = new Map<string, Promise<unknown>>();

  /**
   * What the lane's own device is busy with, as a phrase, or null when
   * nothing would break if it stopped being the lane's device. The caller's
   * own lease (`chatSessionId`) is no reason to refuse it.
   */
  const laneBusyReason = (laneId: string, chatSessionId: string | null): string | null => {
    const state = ctx.peekLane(laneId);
    if (state?.transient === "starting") return "starting";
    if (state?.transient === "stopping") return "stopping";
    // Before the stream: a recording holds the stream too, and "recording" is the answer a caller can act on.
    if (ctx.agent.isRecording(laneId)) return "recording";
    if (ctx.laneStreams.held(laneId)) return "streaming its live view";
    if ((testsRunning.get(laneId) ?? 0) > 0) return "running tests";
    if (laneJobs.has(laneId)) return "installing or launching an app";
    const holder = ctx.agent.otherLeaseHolder(laneId, chatSessionId);
    return holder ? `leased to ${holder}` : null;
  };

  const refuseLaneBusy = (current: AndroidLaneDevice, extra: AndroidLaneDevice, busy: string): never => {
    throw busyFailure(
      `the lane's device ${current.avdName} is ${busy}, so it cannot hand over to ${extra.avdName} now. `
        + "Finish or stop that first (close the live view, record-stop, wait for the test or the install, or have the lease's "
        + "holder run ade android lease release --token <t>), then run device-promote again.",
    );
  };

  /** The extra is busy (its boot, its stop, an install on it): the promote is refused. */
  const refuseExtraBusy = (extra: AndroidLaneDevice): void => {
    const busy = extras.busyReason(extra.laneId, extra.avdName);
    if (busy) {
      throw busyFailure(`${extra.avdName} is ${busy}, so it cannot become the lane's device now. Wait for that to finish, then run device-promote again.`);
    }
  };

  /** Waits until no promote runs on the lane. A job then counts itself before its first await. */
  const settled = async (laneId: string): Promise<void> => {
    for (let running = promoting.get(laneId); running; running = promoting.get(laneId)) {
      await running.catch(() => undefined);
    }
  };

  /** Runs `job` with the lane counted in `counts` meanwhile; the count starts before the first await. */
  const counted = async <T>(counts: Map<string, number>, laneId: string, job: () => Promise<T>): Promise<T> => {
    counts.set(laneId, (counts.get(laneId) ?? 0) + 1);
    try {
      return await job();
    } finally {
      const left = (counts.get(laneId) ?? 1) - 1;
      if (left > 0) counts.set(laneId, left);
      else counts.delete(laneId);
    }
  };

  /**
   * An install or a launch: on one of the lane's extras when `device` names
   * one (booted first when off), else on the lane's device, counted as in use.
   * A promote in progress swaps the lane's device: the job waits for it, then
   * names its device again. Both counts start before the next await.
   */
  const onLaneOrExtra = async <T extends object>(
    args: AndroidDeviceTargetArgs,
    onLane: () => Promise<T>,
    onExtra: (laneId: string, booted: () => Promise<BootedDevice>) => Promise<T>,
  ): Promise<T & { device?: AndroidTargetDevice }> => {
    const laneId = requireLaneId(args.laneId);
    // With no promote, the count below starts in this tick.
    if (promoting.has(laneId)) await settled(laneId);
    const extra = extras.resolveTarget(laneId, args.device);
    if (extra) {
      const result = await extras.runJob(laneId, extra, (booted) => onExtra(laneId, booted), { chatSessionId: args.chatSessionId ?? null });
      return { ...result, device: { avdName: extra.avdName, extra: true } };
    }
    const result = await counted(laneJobs, laneId, onLane);
    const own = args.device ? deps.laneDevices.get(laneId) : null;
    return own ? { ...result, device: { avdName: own.avdName, extra: false } } : result;
  };

  /** A test run on the lane's own device: a promote is refused while it runs. */
  const runTests = <T>(laneId: string, run: () => Promise<T>): Promise<T> =>
    (laneId ? counted(testsRunning, laneId, run) : run());

  /**
   * The swap, once nothing uses either device. The caller holds the lane's
   * queue and the extra's. The old device is kept: an AVD ADE made becomes an
   * extra in the promoted one's place (its emulator keeps running), and the
   * user's own AVD is released back to them (what ADE installed comes off,
   * ADE's emulator stops, nothing is deleted).
   */
  const swapLocked = async (
    laneId: string,
    current: AndroidLaneDevice | null,
    extra: AndroidLaneDevice,
    chatSessionId: string | null,
  ): Promise<AndroidDevicePromoteResult> => {
    const state = ctx.laneState(laneId);
    let previousKeptAs: AndroidDevicePromoteResult["previousKeptAs"] = null;
    if (current) {
      /**
       * Each await gives a viewer, a recording or a lease time to come. A late
       * refusal leaves the lane's device as it was: its status read arms the
       * crash watch again, and a stream starts again when a viewer asks.
       */
      const checkStillFree = async () => {
        const busy = laneBusyReason(laneId, chatSessionId);
        if (!busy) return;
        await ctx.laneStatus(laneId);
        refuseLaneBusy(current, extra, busy);
      };
      ctx.crashWatch.stop(laneId);
      // A stream no viewer holds may still run on the old device.
      await ctx.stopLaneStream(state);
      // Before anything comes off the device.
      await checkStillFree();
      // Ends the lane's recording (none runs: checked above), and on the
      // user's own AVD takes off what ADE installed, while it still runs.
      await ctx.agent.beforeRelease(laneId);
      await checkStillFree();
      if (current.origin === "attached") {
        await ctx.stopLocked(state, current, { refuseForeign: false, reason: "released" });
        deps.laneDevices.forget(laneId, current.avdName);
        previousKeptAs = "detached";
      } else {
        // Keeps running as an extra; the extras module watches its exit now.
        extras.adoptLaunch(laneId, current.avdName, state.launch);
        state.launch = null;
        previousKeptAs = "extra";
      }
    }
    // The swap. The promoted row leaves the extras before it becomes the
    // lane's row, so no read sees one AVD held twice.
    deps.laneDevices.forgetExtra(laneId, extra.avdName);
    const device: AndroidLaneDevice = {
      laneId,
      avdName: extra.avdName,
      origin: "created",
      profileId: extra.profileId,
      systemImage: extra.systemImage,
      createdAt: extra.createdAt,
      adeInstalledPackages: [],
    };
    deps.laneDevices.set(device);
    // Each running emulator moves to the started-emulators file of what it is
    // now, so an older ADE, which reads only the project's file, sees the
    // lane's device as held and never sees the extra.
    ctx.extraRegistry.moveTo(ctx.registry, extra.avdName);
    if (current && previousKeptAs === "extra") {
      deps.laneDevices.setExtra({ ...current, adeInstalledPackages: [], extra: true });
      ctx.registry.moveTo(ctx.extraRegistry, current.avdName);
      // The old device's idle clock and power-off record start over as an extra's.
      ctx.maintenance.started(androidExtraKey(laneId, current.avdName));
      ctx.touch(current.avdName);
    }
    ctx.adoptLaunch(state, device, extras.takeLaunch(laneId, extra.avdName));
    state.stopRequested = false;
    // A new device under the lane: the idle clock, the UI tree, the
    // screen size and the per-boot setup all start over.
    ctx.maintenance.started(laneId);
    ctx.touch(device.avdName);
    ctx.agent.invalidateUi(laneId);
    ctx.agent.recordings.forgetScreenSize(laneId);
    ctx.agent.onDeviceBooted(laneId);
    logger?.info("android.lane_device_promoted", {
      laneId,
      avdName: device.avdName,
      previousAvdName: current?.avdName ?? null,
      previousKeptAs,
      by: chatSessionId ? "agent" : "user",
    });
    deps.captureAnalytics?.("device_promoted");
    ctx.emit({ type: "android.inventory.changed" });
    if (current && previousKeptAs === "extra") {
      const keptRunning = ctx.runningFor(current.avdName) !== null;
      ctx.emit({ type: "android.extra.state", laneId, avdName: current.avdName, state: keptRunning ? "booted" : "off" });
    }
    const lane = await ctx.emitDeviceState(laneId);
    return { device, previous: current ?? null, previousKeptAs, lane };
  };

  /**
   * One of the lane's extras becomes the lane's own device. In the lane's
   * queue and the extra's. Refused while either device is in use, before
   * anything changes; the extra is checked before its queue is entered, so a
   * promote never waits silently behind the extra's boot.
   */
  const promote = (args: AndroidDevicePromoteArgs): Promise<AndroidDevicePromoteResult> => {
    ctx.assertLive();
    const laneId = requireLaneId(args?.laneId);
    const wanted = typeof args?.device === "string" ? args.device.trim() : "";
    if (!wanted) throw new Error("device-promote needs --device <avd> of one of this lane's extra devices.");
    const chatSessionId = typeof args.chatSessionId === "string" ? args.chatSessionId.trim() || null : null;
    return ctx.serialize(laneId, () => {
      const run = (async (): Promise<AndroidDevicePromoteResult> => {
        ctx.assertWorkCopyLive(laneId);
        const avdHome = ctx.avdHome();
        const current = deps.laneDevices.get(laneId);
        const extra = extras.find(laneId, wanted, avdHome);
        if (!extra) {
          // Already the lane's device: the state the caller asked for.
          if (current && namesAndroidDevice(current, wanted, avdHome)) {
            return { device: current, previous: null, previousKeptAs: null, lane: await ctx.laneStatus(laneId) };
          }
          throw new AndroidEmulatorFailure(
            "ANDROID_DEVICE_NOT_LANE_OWNED",
            `${wanted} is not one of this lane's extra devices. ade android status --text lists the lane's devices.`,
          );
        }
        refuseExtraBusy(extra);
        const busy = current ? laneBusyReason(laneId, chatSessionId) : null;
        if (current && busy) refuseLaneBusy(current, extra, busy);
        return ctx.serialize(androidExtraKey(laneId, extra.avdName), async () => {
          // Again in the extra's queue: a release or a start may have come first.
          extras.requireHeld(laneId, extra.avdName);
          refuseExtraBusy(extra);
          return swapLocked(laneId, current, extra, chatSessionId);
        });
      })();
      promoting.set(laneId, run);
      return run.finally(() => {
        if (promoting.get(laneId) === run) promoting.delete(laneId);
      });
    });
  };

  return { promote, settled, onLaneOrExtra, runTests };
}

export type AndroidDevicePromote = ReturnType<typeof createAndroidDevicePromote>;
