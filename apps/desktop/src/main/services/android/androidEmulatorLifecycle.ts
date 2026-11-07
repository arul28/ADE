import fs from "node:fs";
import path from "node:path";
import type { AndroidEmulatorEvent, AndroidLaneDevice, AndroidLaneDeviceStatus, AndroidSdkStatus } from "../../../shared/types/androidEmulator";
import type { Logger } from "../logging/logger";
import { getErrorMessage } from "../shared/utils";
import { readAndroidAvd } from "./androidAvds";
import type { createAndroidCrashWatch } from "./androidCrashWatch";
import { AndroidEmulatorFailure } from "./androidEmulatorErrors";
import {
  launchAndroidEmulator,
  stopAndroidEmulator,
  stopAndroidLaunch,
  waitForAndroidBoot,
  type AndroidDiscoveredEmulator,
  type AndroidEmulatorLaunch,
} from "./androidEmulatorProcess";
import { ANDROID_BOOT_TIMEOUT_MS, type AndroidEmulatorServiceDeps, type AndroidLaneState as LaneState } from "./androidEmulatorServiceDeps";
import type { openStartedEmulators } from "./androidHandedOffEmulators";
import { reserveAndroidMemoryForStart } from "./androidMemoryGuard";
import type { AndroidEnv, ReadyAndroidSdk } from "./androidSdk";

/*
 * The start and the stop of a lane's emulator, split out of
 * `androidEmulatorService.ts`: the launch, the boot wait, a stop during the
 * boot, and the watch for an emulator that dies after its boot.
 *
 * The service calls `startLocked` and `stopLocked` from the lane's queue
 * (`serialize`), and `abortBoot` from a stop that does not wait behind the
 * boot. This module keeps no state of its own: the lane state, the started
 * emulators file and the booted set belong to the service.
 *
 * Node built-ins and relative imports only, so it runs under `tsx`.
 */

export type AndroidEmulatorLifecycleContext = {
  deps: Pick<AndroidEmulatorServiceDeps, "laneDevices" | "dataDir" | "captureAnalytics" | "handOffOnDispose" | "bootTimeoutMs">;
  env: AndroidEnv;
  platform: NodeJS.Platform;
  logger: Logger | null;
  registry: ReturnType<typeof openStartedEmulators>;
  discoveryDirs: readonly string[];
  /** `serial:pid` of emulators seen booted (the service's set). */
  bootedSeen: Set<string>;
  crashWatch: ReturnType<typeof createAndroidCrashWatch>;
  emit: (event: AndroidEmulatorEvent) => void;
  runningFor: (avdName: string) => AndroidDiscoveredEmulator | null;
  ownsEmulator: (emulator: AndroidDiscoveredEmulator) => boolean;
  requireSdk: (needs: { emulator: boolean }) => Promise<ReadyAndroidSdk>;
  laneStatus: (laneId: string, sdk?: AndroidSdkStatus | null) => Promise<AndroidLaneDeviceStatus>;
  emitDeviceState: (laneId: string) => Promise<AndroidLaneDeviceStatus>;
  stopLaneStream: (state: LaneState) => Promise<void>;
  isDisposed: () => boolean;
  /**
   * The emulator finished its boot: the idle timers and the agent suite learn
   * it. Called only after a boot, so it may use parts the service makes later.
   */
  onBooted: (laneId: string) => void;
};

export function createAndroidEmulatorLifecycle(ctx: AndroidEmulatorLifecycleContext) {
  const {
    deps, env, platform, logger, registry, discoveryDirs, bootedSeen, crashWatch,
    emit, runningFor, ownsEmulator, requireSdk, laneStatus, emitDeviceState, stopLaneStream, isDisposed, onBooted,
  } = ctx;
  const bootTimeoutMs = Math.max(deps.bootTimeoutMs ?? ANDROID_BOOT_TIMEOUT_MS, 120_000);

  /* ---------- stop ---------- */

  /** Stops one running emulator ADE started; the stop forgets it in the state file. */
  const stopEmulator = (emulator: AndroidDiscoveredEmulator, adbPath: string, launcherPid: number | null = null) =>
    stopAndroidEmulator({
      adbPath,
      serial: emulator.serial,
      consolePort: emulator.consolePort,
      avdName: emulator.avdName,
      pid: emulator.pid,
      launcherPid,
      registry,
      discoveryDirs,
    });

  /** Stops an emulator this process launched, at any point of its boot. */
  const stopLaunch = (launch: AndroidEmulatorLaunch, adbPath: string): Promise<void> =>
    stopAndroidLaunch(launch, { adbPath, registry, discoveryDirs, logger });

  /**
   * Ends the lane's boot in progress: the failing start then reads
   * `stopRequested`. Starts the stop of the booting emulator unless one runs;
   * `adbPath` is asked for only then, and a null one starts none. A failed
   * stop is logged, never thrown.
   */
  const abortBoot = async (state: LaneState, adbPath: () => Promise<string | null>): Promise<void> => {
    state.stopRequested = true;
    if (state.launch && !state.launchStop) {
      const resolved = await adbPath();
      if (resolved && state.launch && !state.launchStop) state.launchStop = stopLaunch(state.launch, resolved);
    }
    await state.launchStop?.catch((error: unknown) => {
      logger?.warn("android.launch_stop_failed", { laneId: state.laneId, error: getErrorMessage(error) });
    });
  };

  /** Stops the lane's emulator if ADE started it. The caller holds the lane's queue. */
  const stopLocked = async (state: LaneState, device: AndroidLaneDevice, options: { refuseForeign: boolean }): Promise<void> => {
    crashWatch.stop(state.laneId);
    const emulator = runningFor(device.avdName);
    if (!emulator) {
      await stopLaneStream(state);
      state.launch = null;
      return;
    }
    if (!ownsEmulator(emulator)) {
      if (!options.refuseForeign) return;
      throw new AndroidEmulatorFailure(
        "ANDROID_AVD_RUNNING",
        `${device.avdName} was started outside ADE, so ADE leaves it running. Close it where it was started.`,
      );
    }
    const { adbPath } = await requireSdk({ emulator: false });
    state.transient = "stopping";
    emit({ type: "android.device.state", laneId: state.laneId, state: "stopping" });
    try {
      await stopLaneStream(state);
      await stopEmulator(emulator, adbPath, state.launch?.consolePort === emulator.consolePort ? state.launch.launcherPid : null);
      bootedSeen.delete(`${emulator.serial}:${emulator.pid}`);
      state.launch = null;
      state.error = null;
    } finally {
      state.transient = null;
    }
  };

  /* ---------- start ---------- */

  /** Watches an emulator ADE launched, so one that dies after its boot reads as crashed. */
  const watchExit = (state: LaneState, launch: AndroidEmulatorLaunch) => {
    void launch.exit.then(async (info) => {
      if (state.launch !== launch || state.transient !== null || state.stopRequested || isDisposed()) return;
      state.launch = null;
      const how = info.error ?? (info.signal ? `signal ${info.signal}` : `code ${info.code}`);
      state.error = {
        code: "ANDROID_EMULATOR_EXITED",
        message: `The emulator for ${launch.avdName} exited (${how}).`,
        logPath: launch.logPath,
      };
      logger?.warn("android.emulator_exited", { laneId: state.laneId, avdName: launch.avdName, how });
      crashWatch.stop(state.laneId);
      await stopLaneStream(state);
      emit({ type: "android.device.state", laneId: state.laneId, state: "crashed" });
    });
  };

  const startLocked = async (state: LaneState, options: { force?: boolean } = {}): Promise<AndroidLaneDeviceStatus> => {
    const laneId = state.laneId;
    // The machine first: a lane without a device on a machine that can't run one needs the machine's answer.
    const ready = await requireSdk({ emulator: true });
    const device = deps.laneDevices.get(laneId);
    if (!device) {
      throw new AndroidEmulatorFailure("ANDROID_AVD_NOT_FOUND", "This lane has no Android device. Create or attach one first.");
    }
    if (!ready.sdk.acceleration.usable) {
      throw new AndroidEmulatorFailure(
        "ANDROID_NO_ACCELERATION",
        ready.sdk.acceleration.detail ?? "Hardware acceleration is not available, so the emulator cannot run here.",
      );
    }
    const avd = readAndroidAvd(ready.avdHome, device.avdName);
    if (!avd) {
      throw new AndroidEmulatorFailure("ANDROID_AVD_NOT_FOUND", `The lane's AVD ${device.avdName} is no longer on this machine.`);
    }
    // Already running (a start from before a brain restart, or the user's own
    // emulator for an attached AVD): use it as it is.
    if (runningFor(device.avdName)) return laneStatus(laneId, ready.sdk);
    const force = options.force === true;
    const reservation = await reserveAndroidMemoryForStart({ laneId, avd, force, platform, logger });
    try {
      const status = await bootLocked(state, device, ready);
      // Started past the RAM guard: how often the guard's answer is overruled.
      if (force && status.state === "booted") deps.captureAnalytics?.("start_forced");
      return status;
    } finally {
      reservation.release();
    }
  };

  /** The launch and the boot wait of `startLocked`, once the start may go ahead. */
  const bootLocked = async (state: LaneState, device: AndroidLaneDevice, ready: ReadyAndroidSdk): Promise<AndroidLaneDeviceStatus> => {
    const laneId = state.laneId;
    const logPath = path.join(deps.dataDir, "logs", `${device.avdName}.log`);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    // One log per AVD, from this start only, so "Open log" and the crash
    // sentence read this boot.
    fs.writeFileSync(logPath, "");
    state.error = null;
    state.stopRequested = false;
    state.launchStop = null;
    state.transient = "starting";
    emit({ type: "android.device.state", laneId, state: "starting" });
    let launch: AndroidEmulatorLaunch | null = null;
    try {
      launch = await launchAndroidEmulator({
        emulatorPath: ready.emulatorPath,
        sdkRoot: ready.root,
        avdHome: ready.avdHome,
        avdName: device.avdName,
        logPath,
        snapshot: device.origin === "created" ? "cold" : "no-save",
        registry,
        discoveryDirs,
        env,
        detached: deps.handOffOnDispose === true,
      });
      state.launch = launch;
      // A stop that came while the launch was still picking ports.
      if (state.stopRequested) throw new AndroidEmulatorFailure("ANDROID_NOT_RUNNING", "The emulator was stopped while it was starting.");
      const startedAt = Date.now();
      const boot = await waitForAndroidBoot(launch, { adbPath: ready.adbPath, timeoutMs: bootTimeoutMs, registry, discoveryDirs });
      if (state.stopRequested) throw new AndroidEmulatorFailure("ANDROID_NOT_RUNNING", "The emulator was stopped while it was starting.");
      bootedSeen.add(`${launch.serial}:${boot.pid}`);
      logger?.info("android.emulator_booted", {
        laneId,
        avdName: device.avdName,
        serial: launch.serial,
        waitForDeviceMs: boot.waitForDeviceMs,
        bootCompletedMs: boot.bootCompletedMs,
        totalMs: Date.now() - startedAt,
      });
      state.transient = null;
      onBooted(laneId);
      watchExit(state, launch);
      crashWatch.ensure(laneId, { serial: launch.serial, adbPath: ready.adbPath });
      return await emitDeviceState(laneId);
    } catch (error) {
      const stoppedByUser = state.stopRequested;
      if (launch) {
        // A boot that timed out leaves the emulator running; any other failure
        // after the launch may too. Stop it: ADE started it. A stop that
        // arrived during the boot is already doing that.
        state.transient = "stopping";
        const ending = state.launchStop ?? (launch.exited() ? Promise.resolve() : stopLaunch(launch, ready.adbPath));
        await ending.catch((stopError: unknown) => {
          logger?.warn("android.failed_boot_stop_failed", { laneId, error: getErrorMessage(stopError) });
        });
      }
      state.transient = null;
      state.launchStop = null;
      if (state.launch === launch) state.launch = null;
      if (stoppedByUser) {
        state.error = null;
        throw new AndroidEmulatorFailure("ANDROID_NOT_RUNNING", "The emulator was stopped while it was starting.");
      }
      const failure = error instanceof AndroidEmulatorFailure
        ? error
        : new AndroidEmulatorFailure("ANDROID_EMULATOR_EXITED", `The emulator for ${device.avdName} did not start: ${getErrorMessage(error)}`, logPath);
      state.error = failure.toAndroidEmulatorError();
      logger?.warn("android.emulator_start_failed", { laneId, avdName: device.avdName, code: failure.code, error: failure.message });
      emit({ type: "android.device.state", laneId, state: "crashed" });
      throw failure;
    }
  };

  return { stopEmulator, abortBoot, stopLocked, startLocked };
}
