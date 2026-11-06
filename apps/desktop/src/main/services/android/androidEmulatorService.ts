import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AndroidAvd,
  AndroidEmulatorEvent,
  AndroidEmulatorServiceApi as AndroidServiceMethods,
  AndroidEmulatorServiceApi,
  AndroidEmulatorStatus,
  AndroidLaneDevice,
  AndroidLaneDeviceStatus,
  AndroidRunningEmulator,
  AndroidSdkStatus,
} from "../../../shared/types/androidEmulator";
import { getErrorMessage } from "../shared/utils";
import { readAndroidAvd, sameAvdName } from "./androidAvds";
import { AndroidEmulatorFailure, requireLaneId } from "./androidEmulatorErrors";
import {
  androidDiscoveryDirs,
  launchAndroidEmulator,
  readAndroidBootCompleted,
  readAndroidDiscoveryFiles,
  stopAndroidEmulator,
  stopAndroidLaunch,
  waitForAndroidBoot,
  type AndroidDiscoveredEmulator,
  type AndroidEmulatorLaunch,
} from "./androidEmulatorProcess";
import { createAndroidAgentSuite } from "./androidAgentSuite";
import { createAndroidDeviceInventory } from "./androidDeviceInventory";
import { createAndroidDeviceSettings } from "./androidDeviceSettings";
import { createAndroidInput } from "./androidInput";
import { createAndroidCrashWatch } from "./androidCrashWatch";
import { createAndroidLaneStreams } from "./androidLaneStreams";
import { openStartedEmulators, stopAdeStartedEmulators } from "./androidHandedOffEmulators";
import { reserveAndroidMemoryForStart } from "./androidMemoryGuard";
import type { AndroidEmulatorOwnerRecord, AndroidEmulatorStopReason } from "./androidEmulatorOwners";
import type { AndroidIdleStopAnswer } from "./androidEmulatorSweep";
import { createPerKeyThrottle } from "../device/deviceMaintenance";
import type { AppleStreamOwningService } from "../ios/appleStreamRelayForService";
import { takeAndroidScreenshot } from "./androidScreenshot";
import { createAndroidRenderBroker } from "./androidRender";
import { createAndroidSdkSetup, createAndroidSdkSettingStore } from "./androidSdkSetup";
import { createAndroidSystemImages } from "./androidSystemImages";
import {
  androidAvdHome,
  androidSdkPaths,
  locateAndroidSdk,
  readAndroidSdkStatus,
  requireAndroidSdkTools,
  type ReadyAndroidSdk,
} from "./androidSdk";
import { createAndroidPosture } from "./androidPosture";
import { createAndroidComposePreviews } from "./androidComposePreviews";
import { createAndroidStreamHub } from "./androidStream";
import { isRemoteWorkLaneId } from "../remoteWork/remoteWorkCopyService";
import { createAndroidLaneScope } from "./androidWorkCopy";
import { ANDROID_BOOT_TIMEOUT_MS, type AndroidEmulatorServiceDeps, type AndroidLaneState as LaneState } from "./androidEmulatorServiceDeps";

/** The project-removal stop moved with the state file; the CLI keeps importing it from here. */
export { stopHandedOffAndroidEmulators } from "./androidHandedOffEmulators";

/**
 * The calls that count as using the lane's emulator: driving it, streaming,
 * installing, capturing, recording, reading its log, a lease. Each one moves
 * the emulator's idle clock, and while one is in flight (a Gradle build, a
 * test run, a lease wait) the emulator counts as busy. Status reads do not:
 * a pane that only looks must not keep an emulator alive forever.
 */
const ANDROID_USE_METHODS = [
  "start",
  "startStream",
  "sendTouch",
  "tap",
  "swipe",
  "sendKey",
  "sendText",
  "rotate",
  "screenshot",
  "installApp",
  "launchApp",
  "terminateApp",
  "uninstallApp",
  "openUrl",
  "longPress",
  "drag",
  "scroll",
  "getScreenSnapshot",
  "findElement",
  "tapElement",
  "fillElement",
  "waitForElement",
  "assertVisible",
  "readLog",
  "recordStart",
  "recordStop",
  "captureProofBundle",
  "deviceLease",
  "setLocation",
  "setAppearance",
  "setPermission",
  "setDeviceSetting",
  "setPosture",
  "runInstrumentationTests",
] as const satisfies readonly (keyof AndroidServiceMethods)[];

/** A lane's use is passed to the lifecycle at most this often; the lifecycle writes the file once a minute. */
const LANE_TOUCH_EVERY_MS = 15_000;

/*
 * The lane's Android emulator: one per brain, composing the phase A modules
 * (SDK, AVDs, the emulator process, the scrcpy stream).
 *
 * Rules it keeps:
 * - A lane holds at most one AVD, and an AVD belongs to at most one lane.
 * - ADE stops only emulators it started. Who started what is kept in a small
 *   state file under the ADE data folder, so it survives a brain restart.
 * - Lifecycle calls on one lane run one at a time, except a stop during a
 *   start: it ends the boot at once instead of waiting behind it.
 * - The SDK is read on every use (phase A caches the slow part), never only
 *   at start, so an SDK installed while ADE runs is seen on the next call.
 * - A chat on another machine stands in for a lane with its work copy here
 *   (`remote-work-…`, as in the Apple service). The copy is the lane's folder
 *   and the lane lives as long as the copy. Its first start borrows a free
 *   AVD (attached, so never deleted) or makes one; the copy's delete gives
 *   the device back.
 *
 * Node built-ins and relative imports only, so the service also runs under a
 * plain `tsx` harness with an in-memory lane store.
 */

/** The service, plus the lane streams as the brain's stream relay drives them (phone and web viewers). */
export type AndroidEmulatorService = AndroidEmulatorServiceApi & {
  streamRelaySource: AppleStreamOwningService;
};

export function createAndroidEmulatorService(deps: AndroidEmulatorServiceDeps): AndroidEmulatorService {
  const logger = deps.logger ?? null;
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const home = deps.home ?? os.homedir();
  const discoveryDirs = deps.discoveryDirs ?? androidDiscoveryDirs(platform, env, home);
  const bootTimeoutMs = Math.max(deps.bootTimeoutMs ?? ANDROID_BOOT_TIMEOUT_MS, 120_000);
  const now = deps.now ?? (() => new Date());
  /** One warning per kind of failure: the file is read on every call. */
  const registry = openStartedEmulators(deps.dataDir, logger);
  const streams = deps.streamHub ?? createAndroidStreamHub();
  const releaseStreams = streams.retain();
  const listeners = new Set<(event: AndroidEmulatorEvent) => void>();
  const lanes = new Map<string, LaneState>();
  /** `serial:pid` of emulators already seen booted; booted stays booted for one process. */
  const bootedSeen = new Set<string>();
  /** Ends every adb call this service started, on dispose. */
  const lifetime = new AbortController();
  /** The brain's emulator lifecycle: owner records, the idle clock, the pin, the sweep. */
  const lifecycle = deps.emulatorLifecycle ?? null;
  /** Calls in flight that count as use, by lane (`ANDROID_USE_METHODS`). */
  const useInFlight = new Map<string, number>();
  const laneTouchThrottle = createPerKeyThrottle(LANE_TOUCH_EVERY_MS, () => now().getTime());
  let lastSdkKey: string | null = null;
  let disposed = false;

  const platformSupported = platform === "darwin" || platform === "win32" || platform === "linux";
  const unsupportedReason = platformSupported
    ? null
    : `The Android emulator runs on macOS, Windows and Linux, not on ${platform}.`;

  const emit = (event: AndroidEmulatorEvent) => {
    try {
      deps.onEvent?.(event);
    } catch (error) {
      logger?.warn("android.event_forward_failed", { error: getErrorMessage(error) });
    }
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        logger?.warn("android.event_listener_failed", { error: getErrorMessage(error) });
      }
    }
  };

  /* ---------- P2 crash pin (`androidCrashWatch.ts`) ---------- */

  const crashWatch = createAndroidCrashWatch({
    lanePackages: (laneId) => deps.laneDevices.get(laneId)?.adeInstalledPackages ?? [],
    onCrash: (laneId, crash) => emit({ type: "android.app.crashed", laneId, crash }),
    logger,
    signal: lifetime.signal,
  });

  const laneState = (laneId: string): LaneState => {
    let state = lanes.get(laneId);
    if (!state) {
      state = {
        laneId,
        queue: Promise.resolve(),
        transient: null,
        error: null,
        launch: null,
        stopRequested: false,
        launchStop: null,
        streamSerial: null,
        streamViewer: false,
      };
      lanes.set(laneId, state);
    }
    return state;
  };

  /** Runs one lifecycle step after every earlier step on the lane has settled. */
  const serialize = <T>(key: string, step: () => Promise<T>): Promise<T> => {
    const state = laneState(key);
    const run = state.queue.then(step, step);
    state.queue = run.catch(() => undefined);
    return run;
  };

  const assertLive = () => {
    if (disposed) throw new Error("The Android emulator service has shut down.");
  };

  /* ---------- lanes and work copies ---------- */

  const { laneRoot, laneLiveness, assertWorkCopyLive, onWorkCopyReleased, registerWorkCopyDeviceCheck } = createAndroidLaneScope({
    projectRoot: deps.projectRoot,
    resolveLaneWorktreePath: deps.resolveLaneWorktreePath,
    laneDevices: deps.laneDevices,
  });

  /* ---------- the SDK, read on use ---------- */

  const sdkSettings = createAndroidSdkSettingStore(deps.sdkSettingsFile);
  const readSdkSettingPath = deps.readSdkSettingPath ?? (() => sdkSettings.read());
  const readSdk = async (options: { forceAccelCheck?: boolean } = {}): Promise<AndroidSdkStatus> => {
    const sdk = await readAndroidSdkStatus({ settingPath: readSdkSettingPath(), env, platform, home, forceAccelCheck: options.forceAccelCheck });
    const key = JSON.stringify([sdk.found, sdk.root, sdk.tools.map((tool) => [tool.id, tool.available]), sdk.acceleration.usable]);
    if (lastSdkKey !== null && key !== lastSdkKey) emit({ type: "android.sdk.changed" });
    lastSdkKey = key;
    return sdk;
  };

  /** The SDK with adb and the emulator, or the refusal that says what is missing. */
  const requireSdk = async (needs: { emulator: boolean }): Promise<ReadyAndroidSdk> => {
    if (unsupportedReason !== null) throw new AndroidEmulatorFailure("ANDROID_SDK_NOT_FOUND", unsupportedReason);
    return requireAndroidSdkTools(await readSdk(), platform, needs);
  };

  /* ---------- running emulators ---------- */

  const discovered = (): AndroidDiscoveredEmulator[] => readAndroidDiscoveryFiles(discoveryDirs);

  const bootedNow = async (adbPath: string | null, emulator: AndroidDiscoveredEmulator): Promise<boolean> => {
    const key = `${emulator.serial}:${emulator.pid}`;
    if (bootedSeen.has(key)) return true;
    if (!adbPath) return false;
    const booted = await readAndroidBootCompleted(adbPath, emulator.serial, 2_000);
    if (booted) bootedSeen.add(key);
    return booted;
  };

  const ownsEmulator = (emulator: AndroidDiscoveredEmulator): boolean => {
    if (registry.owns(emulator)) return true;
    for (const state of lanes.values()) {
      const launch = state.launch;
      if (launch && launch.consolePort === emulator.consolePort && sameAvdName(launch.avdName, emulator.avdName)) return true;
    }
    return false;
  };

  const asRunning = async (adbPath: string | null, emulator: AndroidDiscoveredEmulator): Promise<AndroidRunningEmulator> => ({
    ...emulator,
    startedByAde: ownsEmulator(emulator),
    booted: await bootedNow(adbPath, emulator),
  });

  const runningFor = (avdName: string): AndroidDiscoveredEmulator | null =>
    discovered().find((emulator) => sameAvdName(emulator.avdName, avdName)) ?? null;

  /* ---------- lane status ---------- */

  const laneStatus = async (laneId: string, sdk?: AndroidSdkStatus | null): Promise<AndroidLaneDeviceStatus> => {
    const state = lanes.get(laneId) ?? null;
    const device = deps.laneDevices.get(laneId);
    const error = state?.error ?? null;
    if (!device) return { laneId, device: null, avd: null, state: state?.transient ?? "none", error };
    const sdkStatus = sdk ?? await readSdk();
    const adbPath = sdkStatus.root ? androidSdkPaths(sdkStatus.root, platform).adb : null;
    const emulator = runningFor(device.avdName);
    // A lane that is still booting is not asked for `sys.boot_completed`: the
    // boot wait already asks, and the answer is "starting" either way.
    const running = emulator
      ? state?.transient === "starting"
        ? { ...emulator, startedByAde: true, booted: false }
        : await asRunning(adbPath, emulator)
      : null;
    const avd = sdkStatus.avdHome ? readAndroidAvd(sdkStatus.avdHome, device.avdName, { running: running ? [running] : [] }) : null;
    const avdWithRunning: AndroidAvd | null = avd ? { ...avd, running } : null;
    const derived: AndroidLaneDeviceStatus["state"] = state?.transient
      ?? (running ? (running.booted ? "booted" : "starting") : error ? "crashed" : "off");
    // A booted emulator is watched for crashes of the lane's app, once.
    if (derived === "booted" && running && adbPath) crashWatch.ensure(laneId, { serial: running.serial, adbPath });
    return {
      laneId,
      device,
      avd: avdWithRunning,
      state: derived,
      error: derived === "crashed" || derived === "off" ? error : null,
      appCrash: derived === "booted" ? crashWatch.latest(laneId) : null,
      ...(lifecycle
        ? {
          // Only an emulator ADE started is ever stopped by ADE, so only it has a pin.
          keepRunning: running?.startedByAde ? lifecycle.recordFor(device.avdName)?.pinned ?? false : null,
          idleStopMinutes: lifecycle.idleMs > 0 ? Math.round(lifecycle.idleMs / 60_000) : null,
        }
        : {}),
    };
  };

  /** P1 look: `ade android render`, drawn by a desktop window (`androidRender.ts`). */
  const renders = createAndroidRenderBroker({
    emit: (event) => emit(event),
    rendersDir: path.join(deps.dataDir, "renders"),
    artifactFiler: deps.artifactFiler ?? null,
    ...(deps.resolveLaneWorktreePath ? { resolveLaneWorktreePath: deps.resolveLaneWorktreePath } : {}),
    onFileError: (error) => logger?.warn("android.render_proof_failed", { error: getErrorMessage(error) }),
    onFiled: () => deps.captureAnalytics?.("device_rendered"),
  });

  const emitDeviceState = async (laneId: string): Promise<AndroidLaneDeviceStatus> => {
    const status = await laneStatus(laneId);
    emit({ type: "android.device.state", laneId, state: status.state });
    return status;
  };

  /* ---------- streams ---------- */

  const laneStreams = createAndroidLaneStreams<LaneState>({
    streams,
    peekLane: (laneId) => lanes.get(laneId),
    laneState,
    requireBooted: (laneId) => requireBooted(laneId),
    assertLive,
    assertWorkCopyLive: (laneId) => assertWorkCopyLive(laneId),
    serverJarPath: deps.serverJarPath,
    emit,
    logger,
    onStreamEnding: (laneId) => agent.onStreamEnding(laneId),
    isRecording: (laneId) => agent.isRecording(laneId),
    onRemoteViewerStarted: () => deps.captureAnalytics?.("remote_viewed"),
  });
  const { stopLaneStream, liveStreamSerial } = laneStreams;

  /* ---------- stop ---------- */

  /**
   * One emulator ADE started stopped: its machine-wide owner record goes and
   * the stop is logged once, with why (`android.emulator_stopped`).
   */
  const noteStopped = (emulator: Pick<AndroidDiscoveredEmulator, "avdName" | "consolePort">, reason: AndroidEmulatorStopReason, laneId: string | null) => {
    if (lifecycle) {
      lifecycle.noteStopped({ avdName: emulator.avdName, consolePort: emulator.consolePort, reason, laneId });
      return;
    }
    logger?.info("android.emulator_stopped", { reason, avdName: emulator.avdName, consolePort: emulator.consolePort, laneId });
  };

  /** Stops one running emulator ADE started; the stop forgets it in the state file. */
  const stopEmulator = async (
    emulator: AndroidDiscoveredEmulator,
    adbPath: string,
    reason: AndroidEmulatorStopReason,
    laneId: string | null,
    launcherPid: number | null = null,
  ) => {
    const result = await stopAndroidEmulator({
      adbPath,
      serial: emulator.serial,
      consolePort: emulator.consolePort,
      avdName: emulator.avdName,
      pid: emulator.pid,
      launcherPid,
      registry,
      discoveryDirs,
    });
    noteStopped(emulator, reason, laneId);
    return result;
  };

  /** Stops an emulator this process launched, at any point of its boot. A boot that never finished leaves no owner record. */
  const stopLaunch = async (launch: AndroidEmulatorLaunch, adbPath: string): Promise<void> => {
    await stopAndroidLaunch(launch, { adbPath, registry, discoveryDirs, logger });
    lifecycle?.forget({ avdName: launch.avdName, consolePort: launch.consolePort });
  };

  /** Waits for the lane's mid-boot stop; a failure is logged, never thrown. */
  const settleLaunchStop = async (state: LaneState): Promise<void> => {
    await state.launchStop?.catch((error: unknown) => {
      logger?.warn("android.launch_stop_failed", { laneId: state.laneId, error: getErrorMessage(error) });
    });
  };

  /**
   * Ends the lane's boot in progress: the failing start then reads
   * `stopRequested`. Starts the stop of the booting emulator unless one runs;
   * `adbPath` is asked for only then, and a null one starts none.
   */
  const abortBoot = async (state: LaneState, adbPath: () => Promise<string | null>): Promise<void> => {
    state.stopRequested = true;
    if (state.launch && !state.launchStop) {
      const resolved = await adbPath();
      if (resolved && state.launch && !state.launchStop) state.launchStop = stopLaunch(state.launch, resolved);
    }
    await settleLaunchStop(state);
  };

  /** Stops the lane's emulator if ADE started it. The caller holds the lane's queue. */
  const stopLocked = async (
    state: LaneState,
    device: AndroidLaneDevice,
    options: { refuseForeign: boolean; reason?: AndroidEmulatorStopReason },
  ): Promise<void> => {
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
      await stopEmulator(
        emulator,
        adbPath,
        options.reason ?? "user",
        state.laneId,
        state.launch?.consolePort === emulator.consolePort ? state.launch.launcherPid : null,
      );
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
      if (state.launch !== launch || state.transient !== null || state.stopRequested || disposed) return;
      state.launch = null;
      const how = info.error ?? (info.signal ? `signal ${info.signal}` : `code ${info.code}`);
      state.error = {
        code: "ANDROID_EMULATOR_EXITED",
        message: `The emulator for ${launch.avdName} exited (${how}).`,
        logPath: launch.logPath,
      };
      logger?.warn("android.emulator_exited", { laneId: state.laneId, avdName: launch.avdName, how });
      lifecycle?.forget({ avdName: launch.avdName, consolePort: launch.consolePort });
      crashWatch.stop(state.laneId);
      await stopLaneStream(state);
      emit({ type: "android.device.state", laneId: state.laneId, state: "crashed" });
    });
  };

  const startLocked = async (
    state: LaneState,
    options: { force?: boolean; chatSessionId?: string | null } = {},
  ): Promise<AndroidLaneDeviceStatus> => {
    const laneId = state.laneId;
    const device = deps.laneDevices.get(laneId);
    if (!device) {
      throw new AndroidEmulatorFailure("ANDROID_AVD_NOT_FOUND", "This lane has no Android device. Create or attach one first.");
    }
    const ready = await requireSdk({ emulator: true });
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
    const reservation = await reserveAndroidMemoryForStart({
      laneId,
      avd,
      force,
      platform,
      logger,
      // Every running emulator counts, the user's and other brains' too.
      discoveryPids: discovered().map((emulator) => emulator.pid),
      ledger: lifecycle?.ledger ?? null,
    });
    try {
      const status = await bootLocked(state, device, ready, {
        guestRamMb: reservation.cost.guestRamMb,
        costMb: reservation.cost.costMb,
        chatSessionId: options.chatSessionId?.trim() || null,
      });
      // Started past the RAM guard: how often the guard's answer is overruled.
      if (force && status.state === "booted") deps.captureAnalytics?.("start_forced");
      return status;
    } finally {
      reservation.release();
    }
  };

  /** The launch and the boot wait of `startLocked`, once the start may go ahead. */
  const bootLocked = async (
    state: LaneState,
    device: AndroidLaneDevice,
    ready: ReadyAndroidSdk,
    owner: { guestRamMb: number; costMb: number; chatSessionId: string | null },
  ): Promise<AndroidLaneDeviceStatus> => {
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
      // The machine-wide owner record: this brain owns it from now on.
      lifecycle?.recordLaunch({
        avdName: launch.avdName,
        consolePort: launch.consolePort,
        launcherPid: launch.launcherPid,
        adbPath: ready.adbPath,
        laneId,
        projectRoot: deps.projectRoot ?? null,
        chatSessionId: owner.chatSessionId,
        guestRamMb: owner.guestRamMb,
        costMb: owner.costMb,
      });
      // A stop that came while the launch was still picking ports.
      if (state.stopRequested) throw new AndroidEmulatorFailure("ANDROID_NOT_RUNNING", "The emulator was stopped while it was starting.");
      const startedAt = Date.now();
      const boot = await waitForAndroidBoot(launch, { adbPath: ready.adbPath, timeoutMs: bootTimeoutMs, registry, discoveryDirs });
      if (state.stopRequested) throw new AndroidEmulatorFailure("ANDROID_NOT_RUNNING", "The emulator was stopped while it was starting.");
      bootedSeen.add(`${launch.serial}:${boot.pid}`);
      void lifecycle?.recordBooted({ avdName: launch.avdName, consolePort: launch.consolePort, pid: boot.pid }).catch(() => undefined);
      logger?.info("android.emulator_booted", {
        laneId,
        avdName: device.avdName,
        serial: launch.serial,
        waitForDeviceMs: boot.waitForDeviceMs,
        bootCompletedMs: boot.bootCompletedMs,
        totalMs: Date.now() - startedAt,
      });
      state.transient = null;
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
        // A boot that never finished leaves no owner record (one that outlived
        // its stop stays ADE's in the project's state file).
        lifecycle?.forget({ avdName: launch.avdName, consolePort: launch.consolePort });
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

  /* ---------- input ---------- */

  /** The lane's booted emulator, or `ANDROID_NOT_RUNNING`. */
  const requireBooted = async (laneId: string): Promise<{ serial: string; adbPath: string }> => {
    const device = deps.laneDevices.get(laneId);
    if (!device) throw new AndroidEmulatorFailure("ANDROID_NOT_RUNNING", "This lane has no Android device.");
    const { adbPath } = await requireSdk({ emulator: false });
    const emulator = runningFor(device.avdName);
    if (!emulator || lanes.get(laneId)?.transient === "starting" || !(await bootedNow(adbPath, emulator))) {
      throw new AndroidEmulatorFailure("ANDROID_NOT_RUNNING", `${device.avdName} is not running. Start it first.`);
    }
    return { serial: emulator.serial, adbPath };
  };

  const rawInput = createAndroidInput({ streams, requireBooted, liveStreamSerial, signal: lifetime.signal });

  /** The lane's screen as a PNG, with no proof filing; `outPath` is checked against the lane's folder. */
  const captureLaneScreen = (laneId: string, outPath: string | null) => takeAndroidScreenshot({
    laneId,
    outPath,
    laneRoot: () => laneRoot(laneId),
    workCopy: isRemoteWorkLaneId(laneId),
    requireBooted: () => requireBooted(laneId),
    dataDir: deps.dataDir,
    platform,
    signal: lifetime.signal,
    now,
  });

  /* ---------- P1 agent suite (`androidAgentSuite.ts`) ---------- */

  const agent = createAndroidAgentSuite({
    captureAnalytics: deps.captureAnalytics,
    laneDevices: deps.laneDevices,
    requireBooted,
    readSdk: () => readSdk(),
    laneRoot,
    isWorkCopy: isRemoteWorkLaneId,
    assertWorkCopyLive,
    input: rawInput,
    streams,
    liveStreamSerial,
    holdStreamForRecording: laneStreams.holdForRecording,
    releaseStreamForRecording: laneStreams.releaseForRecording,
    captureScreen: captureLaneScreen,
    artifactFiler: deps.artifactFiler ?? null,
    callerRoot: deps.projectRoot ?? null,
    dataDir: deps.dataDir,
    serverJarPath: deps.serverJarPath,
    platform,
    env,
    signal: lifetime.signal,
    logger,
    now,
    onRecordingChanged: (laneId, recording) => emit({ type: "android.recording.state", laneId, recording }),
  });

  /* ---------- the Tools drawer's device settings (`androidDeviceSettings.ts`) ---------- */

  const deviceSettings = createAndroidDeviceSettings({
    requireBooted,
    onScreenChanged: (laneId) => agent.invalidateUi(laneId),
    signal: lifetime.signal,
  });

  /* ---------- P3 fold: the hinge of a foldable (`androidPosture.ts`) ---------- */

  const posture = createAndroidPosture({
    requireBooted,
    onScreenChanged: (laneId) => agent.invalidateUi(laneId),
    onPostureChanged: (laneId, next) => emit({ type: "android.device.posture", laneId, posture: next }),
    captureAnalytics: deps.captureAnalytics,
    signal: lifetime.signal,
    now: () => now().getTime(),
  });

  /* ---------- P3 Compose previews, with no emulator (`androidComposePreviews.ts`) ---------- */

  const composePreviews = createAndroidComposePreviews({
    laneRoot,
    sdkRoot: async () => (await readSdk()).root,
    env,
    platform,
    dataDir: deps.dataDir,
    artifactFiler: deps.artifactFiler ?? null,
    callerRoot: deps.projectRoot ?? null,
    signal: lifetime.signal,
    logger,
    now,
    captureAnalytics: deps.captureAnalytics,
  });

  /** P0 input, each call also ending the lane's cached UI tree (the screen changes). */
  const input: typeof rawInput = {
    sendTouch: async (args) => { agent.invalidateUi(args.laneId); await rawInput.sendTouch(args); },
    tap: async (args) => { agent.invalidateUi(args.laneId); await rawInput.tap(args); },
    swipe: async (args) => { agent.invalidateUi(args.laneId); await rawInput.swipe(args); },
    sendKey: async (args) => { agent.invalidateUi(args.laneId); await rawInput.sendKey(args); },
    sendText: async (args) => { agent.invalidateUi(args.laneId); await rawInput.sendText(args); },
    rotate: async (args) => { agent.invalidateUi(args.laneId); await rawInput.rotate(args); },
  };

  /* ---------- devices (`androidDeviceInventory.ts`) ---------- */

  const inventory = createAndroidDeviceInventory<LaneState>({
    laneDevices: deps.laneDevices,
    readSdk: () => readSdk(),
    requireSdk,
    platform,
    env,
    home,
    discoveryDirs,
    logger,
    now,
    emit,
    assertLive,
    assertWorkCopyLive,
    laneLiveness,
    serialize,
    laneState,
    forgetLane: (laneId) => { lanes.delete(laneId); },
    startLocked,
    stopLocked,
    emitDeviceState,
    discovered,
    ownsEmulator,
    asRunning,
    runningFor,
    beforeRelease: (laneId) => {
      crashWatch.stop(laneId);
      return agent.beforeRelease(laneId);
    },
  });
  const { endLaneLocked } = inventory;

  /** A chat's work copy here was deleted: give its device back. */
  const releaseGoneWorkCopy = (laneId: string) => {
    if (disposed || !deps.laneDevices.get(laneId)) return;
    void serialize(laneId, async () => {
      // A new copy for the same chat may have come back while this waited,
      // and an unreadable copy list is not proof that the copy is gone.
      if (laneLiveness(laneId) !== "missing") return;
      const device = deps.laneDevices.get(laneId);
      if (!device) return;
      const result = await endLaneLocked(device);
      logger?.info("android.work_copy_released", { laneId, avdName: device.avdName, ...result });
      emit({ type: "android.inventory.changed" });
      emit({ type: "android.device.state", laneId, state: "none" });
    }).catch((error: unknown) => {
      logger?.warn("android.work_copy_release_failed", { laneId, error: getErrorMessage(error) });
    });
  };
  const offCopyReleased = onWorkCopyReleased(releaseGoneWorkCopy);
  // A work copy's emulator in use (starting, stopping, streaming, or running
  // for its lane) keeps the copy through the idle and low-disk cleanups.
  const offDeviceCheck = registerWorkCopyDeviceCheck((laneId) => {
    if (disposed || !isRemoteWorkLaneId(laneId)) return false;
    const state = lanes.get(laneId);
    if (state?.transient || state?.launch || state?.streamSerial) return true;
    const device = deps.laneDevices.get(laneId);
    return Boolean(device && runningFor(device.avdName));
  });

  /* ---------- the lifecycle: use, busy, the idle stop, the pin ---------- */

  /** The lane's emulator in use here now: a boot or stop, a stream, a recording, a lease, a call in flight. */
  const laneBusy = (laneId: string): boolean => {
    const state = lanes.get(laneId);
    return Boolean(state?.transient || state?.streamSerial)
      || agent.isRecording(laneId)
      || agent.isLeased(laneId)
      || (useInFlight.get(laneId) ?? 0) > 0;
  };

  /** Something used the lane's emulator: move its idle clock. Throttled; never throws. */
  const touchLane = (laneId: string): void => {
    if (!lifecycle || !laneTouchThrottle.take(laneId)) return;
    try {
      const device = deps.laneDevices.get(laneId);
      if (device) lifecycle.touch(device.avdName);
    } catch (error) {
      logger?.debug("android.touch_failed", { laneId, error: getErrorMessage(error) });
    }
  };

  /**
   * The sweep found one of this service's emulators idle: stop it through the
   * lane's queue, unless it was used since the sweep looked.
   */
  const stopIdleEmulator = async (record: AndroidEmulatorOwnerRecord, idleMs: number): Promise<AndroidIdleStopAnswer> => {
    const laneId = record.laneId;
    const holds = () => {
      const device = deps.laneDevices.get(laneId);
      const emulator = device && sameAvdName(device.avdName, record.avdName) ? runningFor(device.avdName) : null;
      return device && emulator && ownsEmulator(emulator) ? device : null;
    };
    if (disposed || !holds()) return "not_found";
    return serialize(laneId, async (): Promise<AndroidIdleStopAnswer> => {
      const device = holds();
      if (!device) return "not_found";
      const lastHere = lifecycle?.lastUsedHereMs(record.avdName) ?? null;
      if (laneBusy(laneId) || (lastHere !== null && now().getTime() - lastHere < idleMs)) return "busy";
      const state = laneState(laneId);
      await stopLocked(state, device, { refuseForeign: false, reason: "idle" });
      state.error = null;
      await emitDeviceState(laneId);
      return "stopped";
    });
  };

  /**
   * Emulators ADE started before the machine's owner file existed (an
   * upgrade with emulators running) are taken in as they run, with a fresh
   * idle clock, so they stop when idle like any other.
   */
  const adoptUnrecordedEmulators = () => {
    if (!lifecycle) return;
    for (const emulator of discovered()) {
      if (!registry.owns(emulator) || lifecycle.recordFor(emulator.avdName)) continue;
      const laneId = deps.laneDevices.holder(emulator.avdName);
      if (!laneId) continue;
      const located = locateAndroidSdk({ settingPath: readSdkSettingPath(), env, platform, home });
      const avd = readAndroidAvd(androidAvdHome(env, home), emulator.avdName);
      lifecycle.recordLaunch({
        avdName: emulator.avdName,
        consolePort: emulator.consolePort,
        launcherPid: emulator.pid,
        pid: emulator.pid,
        adbPath: located ? androidSdkPaths(located.root, platform).adb : null,
        laneId,
        projectRoot: deps.projectRoot ?? null,
        chatSessionId: null,
        guestRamMb: avd?.ramMb ?? null,
        costMb: 0,
      });
      void lifecycle.recordBooted({ avdName: emulator.avdName, consolePort: emulator.consolePort, pid: emulator.pid }).catch(() => undefined);
      logger?.info("android.emulator_taken_in", { laneId, avdName: emulator.avdName, serial: emulator.serial });
    }
  };

  const unregisterLifecycle = lifecycle?.register({
    projectRoot: deps.projectRoot ?? null,
    isBusy: laneBusy,
    stopIdle: stopIdleEmulator,
    onAutoStopped: () => deps.captureAnalytics?.("emulator_auto_stopped"),
    logger,
  }) ?? null;

  /* ---------- start-up reconcile ---------- */

  /**
   * Runs once when the service starts. A lane archived or deleted while no
   * brain ran (or a chat's work copy deleted then) left its row (the release
   * keeps a running AVD's row) and maybe its emulator: stop that emulator and
   * release the AVD by the normal rules.
   * Then an emulator ADE started that no lane holds at all is stopped.
   * Lanes that are still active keep their emulators: those are re-adopted.
   */
  const reconcile = async (): Promise<void> => {
    // Cheap reads first (the lane rows, the discovery files, the state file):
    // a brain start with nothing to reconcile never reads the SDK, which would
    // run `emulator -accel-check` once per project.
    // A chat's work copy counts as a lane while the copy exists.
    const endedLanes = (deps.laneDevices.list?.() ?? []).filter((device) => {
      const liveness = laneLiveness(device.laneId);
      return liveness !== null && liveness !== "active";
    });
    const orphans = () => discovered().filter((emulator) =>
      registry.owns(emulator) && deps.laneDevices.holder(emulator.avdName) === null);
    adoptUnrecordedEmulators();
    if (endedLanes.length === 0 && orphans().length === 0) return;
    const located = locateAndroidSdk({ settingPath: readSdkSettingPath(), env, platform, home });
    if (!located || disposed) return;
    const adbPath = androidSdkPaths(located.root, platform).adb;
    let changed = false;
    for (const device of endedLanes) {
      await serialize(device.laneId, async () => {
        const result = await endLaneLocked(device);
        changed = true;
        logger?.info("android.reconcile.released", { laneId: device.laneId, avdName: device.avdName, ...result });
      }).catch((error: unknown) => {
        logger?.warn("android.reconcile.release_failed", { laneId: device.laneId, error: getErrorMessage(error) });
      });
    }
    for (const emulator of orphans()) {
      if (disposed) return;
      await stopEmulator(emulator, adbPath, "orphan", null).then(
        () => {
          changed = true;
          logger?.info("android.reconcile.stopped_orphan", { serial: emulator.serial, avdName: emulator.avdName });
        },
        (error: unknown) => logger?.warn("android.reconcile.stop_failed", { serial: emulator.serial, error: getErrorMessage(error) }),
      );
    }
    if (changed) emit({ type: "android.inventory.changed" });
  };

  /* ---------- the API ---------- */

  // P1 setup: the guided install and "Use mine…" (`androidSdkSetup.ts`).
  const setup = createAndroidSdkSetup({
    readSdk,
    getStatus: () => service.getStatus(),
    settings: sdkSettings,
    emit,
    logger,
    platform,
    env,
    home,
    onInstalled: () => deps.captureAnalytics?.("sdk_installed"),
  });

  // P3: the system image manager (`androidSystemImages.ts`), on the guided install's job.
  const systemImages = createAndroidSystemImages({
    readSdk: () => readSdk(),
    listAvds: async () => (await inventory.api.listDevices({})).avds,
    emit,
    logger,
    platform,
    env,
    home,
    onInstalled: () => deps.captureAnalytics?.("image_installed"),
  });

  const service: AndroidEmulatorService = {
    streamRelaySource: laneStreams.relaySource,

    getSdkSetupPlan: setup.getSdkSetupPlan,
    installSdk: setup.installSdk,
    cancelSdkInstall: setup.cancelSdkInstall,
    getSdkInstallState: setup.getSdkInstallState,
    setSdkPath: setup.setSdkPath,
    listSystemImages: systemImages.listSystemImages,
    installSystemImage: systemImages.installSystemImage,
    removeSystemImage: systemImages.removeSystemImage,

    async getStatus(args) {
      const sdk = await readSdk();
      const laneId = args?.laneId?.trim() || null;
      const status: AndroidEmulatorStatus = {
        platformSupported,
        unsupportedReason,
        sdk,
        lane: laneId ? await laneStatus(laneId, sdk) : null,
        capabilities: await agent.capabilities(sdk),
      };
      return status;
    },

    ...inventory.api,

    start(args) {
      assertLive();
      const laneId = requireLaneId(args.laneId);
      return serialize(laneId, async () => {
        assertWorkCopyLive(laneId);
        // A chat's work copy has no device until its first start asks for one.
        if (isRemoteWorkLaneId(laneId) && !deps.laneDevices.get(laneId)) await inventory.ensureWorkCopyDeviceLocked(laneId);
        return startLocked(laneState(laneId), { force: args.force === true, chatSessionId: args.chatSessionId ?? null });
      });
    },

    async stop(args) {
      const laneId = requireLaneId(args.laneId);
      const state = laneState(laneId);
      // A stop during a start does not wait behind the boot: it ends it now,
      // and the start fails with "stopped while it was starting".
      if (state.transient === "starting") {
        state.transient = "stopping";
        emit({ type: "android.device.state", laneId, state: "stopping" });
        await abortBoot(state, async () => (await requireSdk({ emulator: false })).adbPath);
      }
      return serialize(laneId, async () => {
        state.stopRequested = false;
        const device = deps.laneDevices.get(laneId);
        if (device) await stopLocked(state, device, { refuseForeign: true, reason: "user" });
        else await stopLaneStream(state);
        state.error = null;
        return emitDeviceState(laneId);
      });
    },

    setKeepRunning(args) {
      const laneId = requireLaneId(args.laneId);
      if (typeof args.keepRunning !== "boolean") throw new Error("keepRunning must be true or false.");
      return serialize(laneId, async () => {
        const device = deps.laneDevices.get(laneId);
        if (!device) throw new AndroidEmulatorFailure("ANDROID_NOT_RUNNING", "This lane has no Android device.");
        const emulator = runningFor(device.avdName);
        if (!emulator) throw new AndroidEmulatorFailure("ANDROID_NOT_RUNNING", `${device.avdName} is not running. Start it first.`);
        // ADE never stops an emulator it did not start, so it has nothing to
        // pin; without a lifecycle nothing stops it either. The status says so
        // (`keepRunning: null`).
        if (lifecycle && ownsEmulator(emulator)) {
          if (!lifecycle.recordFor(device.avdName)) adoptUnrecordedEmulators();
          if (lifecycle.setPinned(device.avdName, args.keepRunning)) {
            logger?.info("android.keep_running_set", { laneId, avdName: device.avdName, keepRunning: args.keepRunning });
          }
        }
        return emitDeviceState(laneId);
      });
    },

    ...laneStreams.api,

    ...input,

    async screenshot(args) {
      const laneId = requireLaneId(args.laneId);
      const shot = await captureLaneScreen(laneId, args.outPath?.trim() || null);
      // Default on, as Apple's. `proof: false`: a caller on another machine
      // files it there (`cliMachineTargeting.ts`), or one that files its own.
      if (args.proof === false) return shot;
      return { ...shot, proofArtifactId: agent.fileScreenshot(laneId, shot, args.chatSessionId?.trim() || null, args.caption ?? null) };
    },

    ...agent.api,
    runInstrumentationTests: (args) => agent.runInstrumentationTests(args),
    ...deviceSettings.verbs,
    ...posture,
    ...composePreviews,
    getDeviceSettings: (args) => deviceSettings.getDeviceSettings(requireLaneId(args.laneId), args.fields === "foreground" ? "foreground" : "all"),
    setDeviceSetting: async (args) => {
      const laneId = requireLaneId(args.laneId);
      await deviceSettings.setDeviceSetting(laneId, args.setting);
      return deviceSettings.getDeviceSettings(laneId);
    },

    releaseIfOwnedBy: (chatSessionId) => agent.releaseIfOwnedBy(chatSessionId),

    async stopForLane(laneId) {
      const id = laneId?.trim();
      if (!id) return;
      const hadState = lanes.has(id);
      const state = laneState(id);
      if (state.transient === "starting") {
        await abortBoot(state, async () => (await requireSdk({ emulator: false }).catch(() => null))?.adbPath ?? null);
      }
      let hadDevice = false;
      await serialize(id, async () => {
        state.stopRequested = false;
        const device = deps.laneDevices.get(id);
        hadDevice = device !== null;
        if (device) await stopLocked(state, device, { refuseForeign: false, reason: "lane_released" });
        else await stopLaneStream(state);
      }).catch((error: unknown) => {
        logger?.warn("android.stop_for_lane_failed", { laneId: id, error: getErrorMessage(error) });
      });
      lanes.delete(id);
      if (hadDevice || hadState) emit({ type: "android.device.state", laneId: id, state: hadDevice ? "off" : "none" });
    },

    /* ---------- P1 look: the render ---------- */

    requestRender(args) {
      assertLive();
      const laneId = requireLaneId(args.laneId);
      if (!deps.laneDevices.get(laneId)) {
        throw new AndroidEmulatorFailure("ANDROID_NOT_RUNNING", "This lane has no Android device to render.");
      }
      return renders.requestRender({ ...args, laneId });
    },

    async renderAck(args) {
      return renders.renderAck(args?.requestId);
    },

    async renderComplete(args) {
      return renders.renderComplete(args?.requestId, args?.error ?? null);
    },

    attachRenderProof(args) {
      assertLive();
      return renders.attachRenderProof({ ...args, laneId: requireLaneId(args.laneId) });
    },

    async dispose(options) {
      if (disposed) return;
      disposed = true;
      // First, so a sweep never asks a service that is going away.
      unregisterLifecycle?.();
      renders.dispose();
      setup.dispose();
      crashWatch.dispose();
      // Recordings end (and are filed) while their stream still runs.
      await agent.dispose().catch((error: unknown) => {
        logger?.warn("android.agent_dispose_failed", { error: getErrorMessage(error) });
      });
      lifetime.abort();
      offCopyReleased();
      offDeviceCheck();
      const sdk = await requireSdk({ emulator: false }).catch(() => null);
      // A removed project has no next service to re-adopt its emulators, so
      // even a hand-off service stops them; every other teardown keeps the
      // configured default.
      const handOff = deps.handOffOnDispose === true && options?.reason !== "unregister";
      await Promise.all([...lanes.values()].map(async (state) => {
        await stopLaneStream(state);
        if (!handOff && state.transient === "starting" && state.launch && sdk) await abortBoot(state, async () => sdk.adbPath);
      }));
      if (handOff) {
        // A brain exit: the emulators stay up and stay in the state file, and
        // the next service re-adopts them. A boot still in progress finishes
        // on its own and reads as "starting" there until it is done.
        logger?.info("android.dispose_hand_off", {
          emulators: discovered().filter((emulator) => registry.owns(emulator)).map((emulator) => emulator.serial),
        });
      } else if (sdk) {
        // Every emulator ADE started for this project, this run or an earlier
        // one (the state file), and nothing else.
        await stopAdeStartedEmulators({
          registry,
          adbPath: sdk.adbPath,
          discoveryDirs,
          logger,
          launcherPidFor: (emulator) =>
            [...lanes.values()].find((state) => state.launch?.consolePort === emulator.consolePort)?.launch?.launcherPid ?? null,
          onStopped: (emulator) => noteStopped(emulator, "project_closed", deps.laneDevices.holder(emulator.avdName)),
        });
      }
      lanes.clear();
      listeners.clear();
      // The last service of the process stops every stream and the server.
      await releaseStreams().catch((error: unknown) => {
        logger?.warn("android.stream_stop_all_failed", { error: getErrorMessage(error) });
      });
    },

    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  // Each call that uses the lane's emulator moves its idle clock, and keeps it
  // busy while it runs.
  if (lifecycle) {
    const methods = service as unknown as Record<string, (args: unknown) => unknown>;
    for (const name of ANDROID_USE_METHODS) {
      const original = methods[name];
      if (typeof original !== "function") continue;
      methods[name] = (args: unknown) => {
        const laneId = typeof (args as { laneId?: unknown } | null)?.laneId === "string"
          ? (args as { laneId: string }).laneId.trim()
          : "";
        if (!laneId) return original.call(service, args);
        touchLane(laneId);
        useInFlight.set(laneId, (useInFlight.get(laneId) ?? 0) + 1);
        const done = () => {
          const left = (useInFlight.get(laneId) ?? 1) - 1;
          if (left > 0) useInFlight.set(laneId, left);
          else useInFlight.delete(laneId);
        };
        let result: unknown;
        try {
          result = original.call(service, args);
        } catch (error) {
          done();
          throw error;
        }
        if (result && typeof (result as Promise<unknown>).then === "function") return (result as Promise<unknown>).finally(done);
        done();
        return result;
      };
    }
  }
  // After construction returns, so a caller's first call is not held up by it;
  // lane steps still queue behind it through `serialize`.
  setTimeout(() => {
    void reconcile().catch((error: unknown) => {
      logger?.warn("android.reconcile_failed", { error: getErrorMessage(error) });
    });
  }, 0);
  return service;
}
