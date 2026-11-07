import fs from "node:fs";
import path from "node:path";
import {
  ANDROID_LANE_EXTRA_DEVICE_LIMIT,
  ANDROID_LANE_EXTRA_DEVICE_MAX,
  type AndroidEmulatorError,
  type AndroidEmulatorEvent,
  type AndroidLaneDevice,
  type AndroidLaneExtraStatus,
  type AndroidPowerOffRecord,
  type AndroidRunningEmulator,
  type AndroidSdkStatus,
} from "../../../shared/types/androidEmulator";
import { androidAvdDisplayName } from "../../../shared/androidDevicePresentation";
import { captureProblem } from "../../../shared/sentry/capture";
import type { Logger } from "../logging/logger";
import { getErrorMessage } from "../shared/utils";
import { readAndroidAvd, sameAvdName } from "./androidAvds";
import type { BootedDevice } from "./androidDeviceShell";
import { AndroidEmulatorFailure } from "./androidEmulatorErrors";
import {
  launchAndroidEmulator,
  stopAndroidLaunch,
  waitForAndroidBoot,
  type AndroidDiscoveredEmulator,
  type AndroidEmulatorLaunch,
} from "./androidEmulatorProcess";
import { ANDROID_BOOT_TIMEOUT_MS, type AndroidEmulatorServiceDeps } from "./androidEmulatorServiceDeps";
import type { openStartedEmulators } from "./androidHandedOffEmulators";
import { releaseAndroidLaneExtras } from "./androidLaneRelease";
import { reserveAndroidMemoryForStart } from "./androidMemoryGuard";
import { androidSdkPaths, type AndroidEnv, type ReadyAndroidSdk } from "./androidSdk";

/*
 * A lane's EXTRA devices (`device-create --extra`), beside its own one, as
 * Apple's lanes hold extra simulators.
 *
 * Rules it keeps:
 * - An extra is an AVD ADE made. ADE deletes it with the lane, and only when
 *   its `config.ini` still carries ADE's marker.
 * - Every start of an extra goes through the RAM guard
 *   (`reserveAndroidMemoryForStart`), the same as the lane's device.
 * - An extra has no stream, recording, lease, crash pin or tests: those are
 *   the lane device's. It boots, stops, takes an install or a launch, and can
 *   become the lane device (`devicePromote`, in the service).
 * - Start and stop of one extra run one at a time on that extra's own queue,
 *   so a boot of an extra never holds up the lane device. A stop during a
 *   start ends the boot at once, as for the lane device.
 * - ADE stops only an extra emulator it started. Its launch is in the same
 *   started-emulators file as the lane device's, so a brain restart re-adopts it.
 *
 * Node built-ins and relative imports only, so it runs under `tsx`.
 */

/** The queue and maintenance key of one extra: the lane, then the AVD name. */
export function androidExtraKey(laneId: string, avdName: string): string {
  return `${laneId}\u0000extra:${avdName.toLowerCase()}`;
}

/** `ADE_ANDROID_LANE_EXTRA_DEVICES`: how many extras a lane may hold (default 2, at most 8). */
export function androidLaneExtraLimit(env: AndroidEnv): number {
  const raw = Number(env.ADE_ANDROID_LANE_EXTRA_DEVICES?.trim());
  if (!Number.isFinite(raw) || raw < 1) return ANDROID_LANE_EXTRA_DEVICE_LIMIT;
  return Math.min(ANDROID_LANE_EXTRA_DEVICE_MAX, Math.floor(raw));
}

/** One extra's state in this process. */
type ExtraState = {
  laneId: string;
  avdName: string;
  transient: "starting" | "stopping" | null;
  error: AndroidEmulatorError | null;
  /** The emulator this process launched for it, while it runs. */
  launch: AndroidEmulatorLaunch | null;
  stopRequested: boolean;
  launchStop: Promise<void> | null;
  /** Installs and launches in flight on it. */
  jobs: number;
};

export type AndroidLaneExtrasDeps = {
  deps: Pick<AndroidEmulatorServiceDeps, "laneDevices" | "dataDir" | "captureAnalytics" | "handOffOnDispose" | "bootTimeoutMs">;
  env: AndroidEnv;
  platform: NodeJS.Platform;
  logger: Logger | null;
  registry: ReturnType<typeof openStartedEmulators>;
  discoveryDirs: readonly string[];
  bootedSeen: Set<string>;
  home: string;
  emit: (event: AndroidEmulatorEvent) => void;
  runningFor: (avdName: string) => AndroidDiscoveredEmulator | null;
  ownsEmulator: (emulator: AndroidDiscoveredEmulator) => boolean;
  asRunning: (adbPath: string | null, emulator: AndroidDiscoveredEmulator) => Promise<AndroidRunningEmulator>;
  bootedNow: (adbPath: string | null, emulator: AndroidDiscoveredEmulator) => Promise<boolean>;
  requireSdk: (needs: { emulator: boolean }) => Promise<ReadyAndroidSdk>;
  stopEmulator: (emulator: AndroidDiscoveredEmulator, adbPath: string, launcherPid?: number | null) => Promise<unknown>;
  serialize: <T>(key: string, step: () => Promise<T>) => Promise<T>;
  isDisposed: () => boolean;
  /** The idle clock (`androidLaneMaintenance.ts`), keyed by `androidExtraKey`. */
  touch: (key: string) => void;
  started: (key: string) => void;
  poweredOffRecord: (key: string) => AndroidPowerOffRecord | null;
};

export function createAndroidLaneExtras(ctx: AndroidLaneExtrasDeps) {
  const { deps, env, platform, logger, registry, discoveryDirs, bootedSeen, emit } = ctx;
  const repo = deps.laneDevices;
  const bootTimeoutMs = Math.max(deps.bootTimeoutMs ?? ANDROID_BOOT_TIMEOUT_MS, 120_000);
  const states = new Map<string, ExtraState>();

  const stateOf = (laneId: string, avdName: string): ExtraState => {
    const key = androidExtraKey(laneId, avdName);
    let state = states.get(key);
    if (!state) {
      state = { laneId, avdName, transient: null, error: null, launch: null, stopRequested: false, launchStop: null, jobs: 0 };
      states.set(key, state);
    }
    return state;
  };
  const peek = (laneId: string, avdName: string): ExtraState | null => states.get(androidExtraKey(laneId, avdName)) ?? null;

  const emitState = (laneId: string, avdName: string, state: AndroidLaneExtraStatus["state"] | "none") =>
    emit({ type: "android.extra.state", laneId, avdName, state });

  /**
   * The lane's extra that `wanted` names: its AVD name, or the name a person
   * reads (`Galaxy S25`), both compared without case. Null when none matches.
   */
  const find = (laneId: string, wanted: string | null | undefined, avdHome: string | null = null): AndroidLaneDevice | null => {
    const asked = wanted?.trim();
    if (!asked) return null;
    const extras = repo.extras(laneId);
    const byName = extras.find((extra) => sameAvdName(extra.avdName, asked));
    if (byName) return byName;
    const shown = (extra: AndroidLaneDevice): string[] => {
      const avd = avdHome ? readAndroidAvd(avdHome, extra.avdName) : null;
      return [avd?.displayName ?? null, androidAvdDisplayName(extra.avdName)].filter((name): name is string => Boolean(name));
    };
    const matches = extras.filter((extra) => shown(extra).some((name) => sameAvdName(name, asked)));
    return matches.length === 1 ? matches[0]! : null;
  };

  /** The extras of a lane as `status` reads them. One discovery read per call; adb only for an unseen boot. */
  const statuses = async (laneId: string, sdk: AndroidSdkStatus): Promise<AndroidLaneExtraStatus[]> => {
    const extras = repo.extras(laneId);
    if (extras.length === 0) return [];
    const adbPath = sdk.root ? androidSdkPaths(sdk.root, platform).adb : null;
    return Promise.all(extras.map(async (device): Promise<AndroidLaneExtraStatus> => {
      const state = peek(laneId, device.avdName);
      const emulator = ctx.runningFor(device.avdName);
      const running = emulator
        ? state?.transient === "starting"
          ? { ...emulator, startedByAde: true, booted: false }
          : await ctx.asRunning(adbPath, emulator)
        : null;
      const avd = sdk.avdHome ? readAndroidAvd(sdk.avdHome, device.avdName, { running: running ? [running] : [] }) : null;
      const error = state?.error ?? null;
      const derived: AndroidLaneExtraStatus["state"] = state?.transient
        ?? (running ? (running.booted ? "booted" : "starting") : error ? "crashed" : "off");
      return {
        device,
        avd: avd ? { ...avd, running } : null,
        state: derived,
        error: derived === "crashed" || derived === "off" ? error : null,
        poweredOff: derived === "off" ? ctx.poweredOffRecord(androidExtraKey(laneId, device.avdName)) : null,
      };
    }));
  };

  const stopLaunch = (launch: AndroidEmulatorLaunch, adbPath: string): Promise<void> =>
    stopAndroidLaunch(launch, { adbPath, registry, discoveryDirs, logger });

  /** Watches an extra emulator this process launched, so one that dies after its boot reads as crashed. */
  const watchExit = (state: ExtraState, launch: AndroidEmulatorLaunch) => {
    void launch.exit.then((info) => {
      if (state.launch !== launch || state.transient !== null || state.stopRequested || ctx.isDisposed()) return;
      state.launch = null;
      const how = info.error ?? (info.signal ? `signal ${info.signal}` : `code ${info.code}`);
      state.error = {
        code: "ANDROID_EMULATOR_EXITED",
        message: `The emulator for ${androidAvdDisplayName(launch.avdName)} exited (${how}).`,
        logPath: launch.logPath,
      };
      logger?.warn("android.extra_emulator_exited", { laneId: state.laneId, avdName: launch.avdName, how });
      emitState(state.laneId, state.avdName, "crashed");
    });
  };

  /** The launch and the boot wait of one extra. The caller holds the extra's queue and reserved its memory. */
  const bootLocked = async (state: ExtraState, ready: ReadyAndroidSdk, restartAdb: boolean): Promise<void> => {
    const { laneId, avdName } = state;
    const logPath = path.join(deps.dataDir, "logs", `${avdName}.log`);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, "");
    state.error = null;
    state.stopRequested = false;
    state.launchStop = null;
    state.transient = "starting";
    emitState(laneId, avdName, "starting");
    let launch: AndroidEmulatorLaunch | null = null;
    try {
      launch = await launchAndroidEmulator({
        emulatorPath: ready.emulatorPath,
        sdkRoot: ready.root,
        avdHome: ready.avdHome,
        avdName,
        logPath,
        // Every extra is an AVD ADE made, as the lane device it may become.
        snapshot: "cold",
        registry,
        discoveryDirs,
        env,
        detached: deps.handOffOnDispose === true,
      });
      state.launch = launch;
      if (state.stopRequested) throw new AndroidEmulatorFailure("ANDROID_NOT_RUNNING", "The emulator was stopped while it was starting.");
      const startedAt = Date.now();
      const boot = await waitForAndroidBoot(launch, {
        adbPath: ready.adbPath,
        timeoutMs: bootTimeoutMs,
        registry,
        discoveryDirs,
        restartAdb: restartAdb ? "always" : "auto",
        onAdbRestarted: (otherDevices) => {
          logger?.warn("android.adb_server_restarted", { laneId, avdName, extra: true, reason: "unauthorized", otherDevices, asked: restartAdb });
          deps.captureAnalytics?.("adb_restarted");
        },
      });
      if (state.stopRequested) throw new AndroidEmulatorFailure("ANDROID_NOT_RUNNING", "The emulator was stopped while it was starting.");
      bootedSeen.add(`${launch.serial}:${boot.pid}`);
      logger?.info("android.extra_emulator_booted", {
        laneId,
        avdName,
        serial: launch.serial,
        waitForDeviceMs: boot.waitForDeviceMs,
        bootCompletedMs: boot.bootCompletedMs,
        totalMs: Date.now() - startedAt,
        adbRestarted: boot.adbRestarted,
      });
      deps.captureAnalytics?.("device_booted");
      state.transient = null;
      ctx.started(androidExtraKey(laneId, avdName));
      watchExit(state, launch);
      emitState(laneId, avdName, "booted");
    } catch (error) {
      const stoppedByUser = state.stopRequested;
      if (launch) {
        state.transient = "stopping";
        const ending = state.launchStop ?? (launch.exited() ? Promise.resolve() : stopLaunch(launch, ready.adbPath));
        await ending.catch((stopError: unknown) => {
          logger?.warn("android.extra_failed_boot_stop_failed", { laneId, avdName, error: getErrorMessage(stopError) });
        });
      }
      state.transient = null;
      state.launchStop = null;
      if (state.launch === launch) state.launch = null;
      if (stoppedByUser) {
        state.error = null;
        emitState(laneId, avdName, "off");
        throw new AndroidEmulatorFailure("ANDROID_NOT_RUNNING", "The emulator was stopped while it was starting.");
      }
      const failure = error instanceof AndroidEmulatorFailure
        ? error
        : new AndroidEmulatorFailure(
          "ANDROID_EMULATOR_EXITED",
          `The emulator for ${androidAvdDisplayName(avdName)} did not start: ${getErrorMessage(error)}`,
          logPath,
        );
      state.error = failure.toAndroidEmulatorError();
      const elapsedMs = launch ? Date.now() - launch.startedAt : null;
      logger?.warn("android.extra_emulator_start_failed", { laneId, avdName, code: failure.code, error: failure.message, elapsedMs });
      captureProblem("Android emulator did not boot", {
        tags: { area: "android", code: failure.code, extra: "true" },
        extra: { elapsedMs },
        fingerprint: ["android", "boot_failed", failure.code],
        handled: true,
      });
      deps.captureAnalytics?.("boot_failed");
      emitState(laneId, avdName, "crashed");
      throw failure;
    }
  };

  /**
   * Boots one extra (no-op when it runs). Through the RAM guard: `force`
   * starts it past a refusal, as `start --force` does for the lane device.
   */
  const start = (laneId: string, extra: AndroidLaneDevice, options: { force?: boolean; restartAdb?: boolean } = {}): Promise<void> =>
    ctx.serialize(androidExtraKey(laneId, extra.avdName), async () => {
      // Again in the queue: a promote or a release may have taken it meanwhile.
      if (!repo.extras(laneId).some((row) => sameAvdName(row.avdName, extra.avdName))) {
        throw new AndroidEmulatorFailure("ANDROID_DEVICE_NOT_LANE_OWNED", `${extra.avdName} is not one of this lane's extra devices any more.`);
      }
      const ready = await ctx.requireSdk({ emulator: true });
      if (!ready.sdk.acceleration.usable) {
        throw new AndroidEmulatorFailure(
          "ANDROID_NO_ACCELERATION",
          ready.sdk.acceleration.detail ?? "Hardware acceleration is not available, so the emulator cannot run here.",
        );
      }
      const avd = readAndroidAvd(ready.avdHome, extra.avdName);
      if (!avd) throw new AndroidEmulatorFailure("ANDROID_AVD_NOT_FOUND", `The extra device ${extra.avdName} is no longer on this machine.`);
      ctx.touch(androidExtraKey(laneId, extra.avdName));
      if (ctx.runningFor(extra.avdName)) return;
      const force = options.force === true;
      const reservation = await reserveAndroidMemoryForStart({ laneId, avd, force, platform, logger });
      try {
        await bootLocked(stateOf(laneId, extra.avdName), ready, options.restartAdb === true);
        if (force) deps.captureAnalytics?.("start_forced");
      } finally {
        reservation.release();
      }
    });

  /** Ends a boot in progress of one extra: the failing start then reads `stopRequested`. */
  const abortBoot = async (state: ExtraState, adbPath: () => Promise<string | null>): Promise<void> => {
    state.stopRequested = true;
    if (state.launch && !state.launchStop) {
      const resolved = await adbPath();
      if (resolved && state.launch && !state.launchStop) state.launchStop = stopLaunch(state.launch, resolved);
    }
    await state.launchStop?.catch((error: unknown) => {
      logger?.warn("android.extra_launch_stop_failed", { laneId: state.laneId, avdName: state.avdName, error: getErrorMessage(error) });
    });
  };

  /** Stops one extra if ADE started it. The caller holds the extra's queue. */
  const stopLocked = async (state: ExtraState, options: { refuseForeign: boolean }): Promise<void> => {
    const emulator = ctx.runningFor(state.avdName);
    if (!emulator) {
      state.launch = null;
      return;
    }
    if (!ctx.ownsEmulator(emulator)) {
      if (!options.refuseForeign) return;
      throw new AndroidEmulatorFailure(
        "ANDROID_AVD_RUNNING",
        `${state.avdName} was started outside ADE, so ADE leaves it running. Close it where it was started.`,
      );
    }
    const { adbPath } = await ctx.requireSdk({ emulator: false });
    state.transient = "stopping";
    emitState(state.laneId, state.avdName, "stopping");
    try {
      await ctx.stopEmulator(emulator, adbPath, state.launch?.consolePort === emulator.consolePort ? state.launch.launcherPid : null);
      bootedSeen.delete(`${emulator.serial}:${emulator.pid}`);
      state.launch = null;
      state.error = null;
    } finally {
      state.transient = null;
    }
  };

  /** Stops one extra. A stop during its start does not wait behind the boot: it ends it now. */
  const stop = async (laneId: string, extra: AndroidLaneDevice, options: { refuseForeign?: boolean } = {}): Promise<void> => {
    const state = stateOf(laneId, extra.avdName);
    if (state.transient === "starting") {
      state.transient = "stopping";
      emitState(laneId, extra.avdName, "stopping");
      await abortBoot(state, async () => (await ctx.requireSdk({ emulator: false }).catch(() => null))?.adbPath ?? null);
    }
    await ctx.serialize(androidExtraKey(laneId, extra.avdName), async () => {
      state.stopRequested = false;
      await stopLocked(state, { refuseForeign: options.refuseForeign !== false });
      state.error = null;
    });
    emitState(laneId, extra.avdName, "off");
  };

  /**
   * The lane gives up one extra: its emulator stops, then the AVD is deleted
   * (`deleteCreated` false keeps it on disk as a free AVD) and the row goes.
   */
  const release = async (
    laneId: string,
    extra: AndroidLaneDevice,
    options: { deleteCreated?: boolean } = {},
  ): Promise<{ released: boolean; deletedAvd: string | null }> => {
    // Gone already (a promote, another release): nothing to do.
    if (!repo.extras(laneId).some((row) => sameAvdName(row.avdName, extra.avdName))) return { released: false, deletedAvd: null };
    await stop(laneId, extra, { refuseForeign: false });
    const result = await releaseAndroidLaneExtras(laneId, repo, {
      env,
      platform,
      home: ctx.home,
      discoveryDirs,
      logger,
      avdName: extra.avdName,
      ...(options.deleteCreated === undefined ? {} : { deleteCreated: options.deleteCreated }),
    });
    if (!result.released.some((name) => sameAvdName(name, extra.avdName))) {
      const reason = result.kept.find((entry) => sameAvdName(entry.avdName, extra.avdName))?.reason;
      throw new AndroidEmulatorFailure("ANDROID_AVD_RUNNING", reason ?? `${extra.avdName} could not be released.`);
    }
    states.delete(androidExtraKey(laneId, extra.avdName));
    logger?.info("android.extra_device_released", { laneId, avdName: extra.avdName, deleted: result.deleted.length > 0 });
    emit({ type: "android.inventory.changed" });
    emitState(laneId, extra.avdName, "none");
    return { released: true, deletedAvd: result.deleted[0] ?? null };
  };

  /**
   * A lane ended: every extra it holds stops and is released by the normal
   * rules. A failure is logged and the next extra goes on; a running extra
   * that could not stop keeps its row for the next pass.
   */
  const endLane = async (laneId: string): Promise<void> => {
    for (const extra of repo.extras(laneId)) {
      await release(laneId, extra).catch((error: unknown) => {
        logger?.warn("android.extra_device_end_failed", { laneId, avdName: extra.avdName, error: getErrorMessage(error) });
      });
    }
  };

  /** Stops every extra of a lane and keeps the rows (lane archive: the release deletes them after). */
  const stopAll = async (laneId: string): Promise<void> => {
    for (const extra of repo.extras(laneId)) {
      await stop(laneId, extra, { refuseForeign: false }).catch((error: unknown) => {
        logger?.warn("android.extra_device_stop_failed", { laneId, avdName: extra.avdName, error: getErrorMessage(error) });
      });
    }
  };

  /** The extra's booted emulator, or `ANDROID_NOT_RUNNING`. */
  const requireBooted = async (laneId: string, extra: AndroidLaneDevice): Promise<BootedDevice> => {
    const { adbPath } = await ctx.requireSdk({ emulator: false });
    const emulator = ctx.runningFor(extra.avdName);
    if (!emulator || peek(laneId, extra.avdName)?.transient === "starting" || !(await ctx.bootedNow(adbPath, emulator))) {
      throw new AndroidEmulatorFailure("ANDROID_NOT_RUNNING", `The extra device ${extra.avdName} is not running. Start it first: ade android start --device ${extra.avdName}`);
    }
    return { serial: emulator.serial, adbPath };
  };

  /**
   * Runs an install or a launch on one extra: boots it first when it is off
   * (through the RAM guard, no `force`), and counts it as in use meanwhile,
   * so a promote, a release or the idle timer does not take it away.
   */
  const runJob = async <T>(laneId: string, extra: AndroidLaneDevice, job: (booted: () => Promise<BootedDevice>) => Promise<T>): Promise<T> => {
    const state = stateOf(laneId, extra.avdName);
    state.jobs += 1;
    ctx.touch(androidExtraKey(laneId, extra.avdName));
    try {
      if (!ctx.runningFor(extra.avdName) || state.transient === "starting") await start(laneId, extra);
      return await job(() => requireBooted(laneId, extra));
    } finally {
      state.jobs -= 1;
      ctx.touch(androidExtraKey(laneId, extra.avdName));
    }
  };

  /**
   * The idle timer stops one extra, in its queue. `stillIdle` is asked there,
   * just before the stop. Answers false when it is not an extra any more.
   */
  const powerOffIdle = async (laneId: string, extra: AndroidLaneDevice, stillIdle: () => boolean): Promise<boolean> => {
    const stopped = await ctx.serialize(androidExtraKey(laneId, extra.avdName), async () => {
      if (!stillIdle()) throw new Error("The emulator came into use, so ADE left it running.");
      if (!repo.extras(laneId).some((row) => sameAvdName(row.avdName, extra.avdName))) return false;
      const state = stateOf(laneId, extra.avdName);
      await stopLocked(state, { refuseForeign: false });
      state.error = null;
      return true;
    });
    if (stopped) emitState(laneId, extra.avdName, "off");
    return stopped;
  };

  /** What the extra is busy with, as a phrase, or null. */
  const busyReason = (laneId: string, avdName: string): string | null => {
    const state = peek(laneId, avdName);
    if (!state) return null;
    if (state.transient === "starting") return "starting";
    if (state.transient === "stopping") return "stopping";
    if (state.jobs > 0) return "installing or launching an app";
    return null;
  };

  /** Promote: the extra's launch (when this process made it) moves to the lane state, and its state goes. */
  const takeLaunch = (laneId: string, avdName: string): AndroidEmulatorLaunch | null => {
    const key = androidExtraKey(laneId, avdName);
    const state = states.get(key) ?? null;
    const launch = state?.launch ?? null;
    // The old state's exit watch must not read the lane device's exit as an extra's crash.
    if (state) state.launch = null;
    states.delete(key);
    return launch;
  };

  /** Promote: the lane's old device, now an extra, keeps its running emulator and the watch on it. */
  const adoptLaunch = (laneId: string, avdName: string, launch: AndroidEmulatorLaunch | null): void => {
    const state = stateOf(laneId, avdName);
    state.error = null;
    state.launch = launch;
    if (launch) watchExit(state, launch);
  };

  return {
    find,
    statuses,
    start,
    stop,
    release,
    endLane,
    stopAll,
    requireBooted,
    runJob,
    powerOffIdle,
    busyReason,
    takeLaunch,
    adoptLaunch,
    /** The extras' emulators this process launched (the owned check and the dispose stop). */
    launches: (): AndroidEmulatorLaunch[] => [...states.values()].flatMap((state) => (state.launch ? [state.launch] : [])),
    /** Ends every extra boot in progress (the service's dispose). */
    async abortAll(adbPath: string): Promise<void> {
      await Promise.all([...states.values()].filter((state) => state.transient === "starting" && state.launch)
        .map((state) => abortBoot(state, async () => adbPath)));
    },
    clear: (): void => states.clear(),
  };
}

export type AndroidLaneExtras = ReturnType<typeof createAndroidLaneExtras>;
