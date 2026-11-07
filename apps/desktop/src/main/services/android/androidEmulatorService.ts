import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AndroidAvd,
  AndroidDevicePromoteResult,
  AndroidEmulatorEvent,
  AndroidEmulatorServiceApi,
  AndroidEmulatorStatus,
  AndroidLaneDevice,
  AndroidLaneDeviceStatus,
  AndroidRunningEmulator,
  AndroidSdkStatus,
  AndroidTargetDevice,
} from "../../../shared/types/androidEmulator";
import { androidAvdDisplayName } from "../../../shared/androidDevicePresentation";
import { getErrorMessage, sleep } from "../shared/utils";
import { agent37AndroidNeedsVmMessage, agent37ShapeForResources } from "../../../shared/agent37";
import { listAndroidAvds, readAdeAvdLaneId, readAndroidAvd, sameAvdName } from "./androidAvds";
import { createAndroidInspect } from "./androidInspect";
import {
  androidIdlePowerOffMs as androidIdlePowerOffMsFromEnv,
  createAndroidLaneMaintenance,
  readDeviceIdleMs,
  readOtherScrcpyViewer,
} from "./androidLaneMaintenance";
import { AndroidEmulatorFailure, requireLaneId } from "./androidEmulatorErrors";
import {
  androidDiscoveryDirs,
  readAndroidBootCompleted,
  readAndroidDiscoveryFiles,
  type AndroidDiscoveredEmulator,
} from "./androidEmulatorProcess";
import { createAndroidAgentSuite } from "./androidAgentSuite";
import { createAndroidDeviceInventory } from "./androidDeviceInventory";
import { createAndroidDeviceSettings } from "./androidDeviceSettings";
import { createAndroidInput } from "./androidInput";
import { wrapAndroidInput } from "./androidAutoRecord";
import { createAndroidCrashWatch } from "./androidCrashWatch";
import { createAndroidLaneStreams } from "./androidLaneStreams";
import { createAndroidEmulatorLifecycle } from "./androidEmulatorLifecycle";
import { androidExtraKey, androidLaneExtraLimit, createAndroidLaneExtras } from "./androidLaneExtras";
import { openStartedEmulators, stopAdeStartedEmulators } from "./androidHandedOffEmulators";
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
import { createAndroidStoreShots } from "./androidStoreShots";
import { createAndroidWindows } from "./androidWindows";
import { createAndroidComposePreviews } from "./androidComposePreviews";
import { createAndroidStreamHub } from "./androidStream";
import { createAndroidMachinePreferenceStore, createAndroidSettingsFile } from "./androidMachinePreferences";
import { createDemoEngineSet } from "../demoVideo/demoEngines";
import { NOOP_LOGGER } from "../logging/machineLogger";
import { isRemoteWorkLaneId } from "../remoteWork/remoteWorkCopyService";
import { createAndroidLaneScope } from "./androidWorkCopy";
import type { AndroidEmulatorServiceDeps, AndroidLaneState as LaneState } from "./androidEmulatorServiceDeps";

/** The project-removal stop moved with the state file; the CLI keeps importing it from here. */
export { stopHandedOffAndroidEmulators } from "./androidHandedOffEmulators";

/*
 * The lane's Android emulator: one per brain, composing the phase A modules
 * (SDK, AVDs, the emulator process, the scrcpy stream).
 *
 * Rules it keeps:
 * - A lane holds one AVD as its own device, and may hold extra devices beside
 *   it (`androidLaneExtras.ts`). An AVD belongs to at most one lane.
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
  /** The machine's remote viewer cap in kbit/s: the relay's ceiling for pacing. */
  streamRemoteBitrateKbpsCap: () => number;
};

export function createAndroidEmulatorService(deps: AndroidEmulatorServiceDeps): AndroidEmulatorService {
  const logger = deps.logger ?? null;
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const home = deps.home ?? os.homedir();
  const discoveryDirs = deps.discoveryDirs ?? androidDiscoveryDirs(platform, env, home);
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
  let lastSdkKey: string | null = null;
  let disposed = false;

  const platformSupported = platform === "darwin" || platform === "win32" || platform === "linux";
  const unsupportedReason = platformSupported
    ? null
    : `The Android emulator runs on macOS, Windows and Linux, not on ${platform}.`;

  /** Set once the maintenance timers exist (`androidLaneMaintenance.ts`); a lifecycle event re-checks them. */
  let refreshMaintenance: () => void = () => {};

  const emit = (event: AndroidEmulatorEvent) => {
    // A device came or went: the idle and cleanup timers run only while there is one.
    if (event.type === "android.device.state" || event.type === "android.extra.state" || event.type === "android.inventory.changed") {
      refreshMaintenance();
    }
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

  /** The machine's Android settings file: the SDK folder and the machine preferences (read per use; cached per change). */
  const settingsFile = createAndroidSettingsFile(deps.sdkSettingsFile, logger);
  const sdkSettings = createAndroidSdkSettingStore(settingsFile);
  const streamPreferences = createAndroidMachinePreferenceStore(settingsFile);
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
    const ready = requireAndroidSdkTools(await readSdk(), platform, needs);
    // An Agent 37 box never has KVM. Refuse its first emulator step (making a
    // device, or a start) with what a VM costs, not "turn on KVM".
    if (needs.emulator && !ready.sdk.acceleration.usable && process.env.AGENT37_INSTANCE_ID?.trim()) {
      throw new AndroidEmulatorFailure(
        "ANDROID_NO_ACCELERATION",
        agent37AndroidNeedsVmMessage(agent37ShapeForResources(os.cpus().length, os.totalmem())),
      );
    }
    return ready;
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
    for (const launch of extras.launches()) {
      if (launch.consolePort === emulator.consolePort && sameAvdName(launch.avdName, emulator.avdName)) return true;
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
    // The SDK is read only when the lane holds a device: a lane with none is the common read.
    const hasExtras = deps.laneDevices.extras(laneId).length > 0;
    if (!device) {
      const bare: AndroidLaneDeviceStatus = { laneId, device: null, avd: null, state: state?.transient ?? "none", error };
      return hasExtras ? { ...bare, extras: await extras.statuses(laneId, sdk ?? await readSdk()) } : bare;
    }
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
      // Parity: "ADE powered it off after 31 min idle", until the next start.
      poweredOff: derived === "off" ? maintenance.poweredOffRecord(laneId) : null,
      ...(hasExtras ? { extras: await extras.statuses(laneId, sdkStatus) } : {}),
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
    onRemoteViewerStarted: () => deps.captureAnalytics?.("remote_viewed"),
    remoteBitrateKbpsCap: () => streamPreferences.read().remoteBitrateKbpsCap,
  });
  const { stopLaneStream, liveStreamSerial } = laneStreams;

  /* ---------- start and stop (`androidEmulatorLifecycle.ts`) ---------- */

  const { stopEmulator, abortBoot, stopLocked, startLocked, adoptLaunch } = createAndroidEmulatorLifecycle({
    deps,
    env,
    platform,
    logger,
    registry,
    discoveryDirs,
    bootedSeen,
    crashWatch,
    emit,
    runningFor,
    ownsEmulator,
    requireSdk,
    laneStatus,
    emitDeviceState,
    stopLaneStream,
    isDisposed: () => disposed,
    onBooted: (laneId) => {
      maintenance.started(laneId);
      agent.onDeviceBooted(laneId);
    },
  });

  /* ---------- extra devices (`androidLaneExtras.ts`) ---------- */

  const extras = createAndroidLaneExtras({
    deps,
    env,
    platform,
    logger,
    registry,
    discoveryDirs,
    bootedSeen,
    home,
    emit,
    runningFor,
    ownsEmulator,
    asRunning,
    bootedNow,
    requireSdk,
    stopEmulator,
    serialize,
    isDisposed: () => disposed,
    touch: (key) => maintenance.touch(key),
    started: (key) => maintenance.started(key),
    poweredOffRecord: (key) => maintenance.poweredOffRecord(key),
  });

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
    // Rec: the demo step (Swift on macOS, ffmpeg everywhere, ADE's own ffmpeg when the machine has none).
    demoEngines: deps.demoEngines ?? createDemoEngineSet({ logger: logger ?? NOOP_LOGGER }),
    readPreferences: () => streamPreferences.read(),
    readSetting: deps.readSetting ?? null,
    writeSetting: deps.writeSetting ?? null,
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

  /* ---------- parity: Play Store screenshots and window layout (`androidStoreShots.ts`, `androidWindows.ts`) ---------- */

  const storeShots = createAndroidStoreShots({
    requireBooted,
    posture,
    fileShot: (laneId, shot, chatSessionId, caption) => agent.fileScreenshot(laneId, shot, chatSessionId, caption),
    dataDir: deps.dataDir,
    signal: lifetime.signal,
    logger,
    now,
    sleep,
    captureAnalytics: deps.captureAnalytics,
  });

  const windows = createAndroidWindows({
    requireBooted,
    onScreenChanged: (laneId) => agent.invalidateUi(laneId),
    signal: lifetime.signal,
    sleep,
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

  // P0 input through auto-record (`androidAutoRecord.ts`).
  const input = wrapAndroidInput(rawInput, {
    autoRecord: agent.autoRecord,
    invalidateUi: (laneId) => agent.invalidateUi(laneId),
    onRotated: (laneId) => {
      agent.recordings.forgetScreenSize(laneId);
      void deviceSettings.refreshStatusBar(laneId).catch((error: unknown) => {
        logger?.warn("android.status_bar_refresh_failed", { laneId, error: getErrorMessage(error) });
      });
      // Parity: a half turn keeps the video's shape, so viewers learn the turn here.
      // The read is one more adb call; the caller does not wait for it, the event follows.
      void deviceSettings.getDeviceSettings(laneId, "orientation").then((read) => {
        if (read.orientation) emit({ type: "android.device.orientation", laneId, orientation: read.orientation });
      }).catch((error: unknown) => {
        logger?.warn("android.orientation_read_failed", { laneId, error: getErrorMessage(error) });
      });
    },
  });

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
    extraLimit: androidLaneExtraLimit(env),
    startExtra: (laneId, extra) => extras.start(laneId, extra),
    onExtraCreated: () => deps.captureAnalytics?.("extra_device_created"),
  });

  /**
   * A lane ended: its extras stop and are deleted, then its own device is
   * released by the normal rules (an attached AVD stays). The caller holds
   * the lane's queue.
   */
  const endLaneLocked = async (device: AndroidLaneDevice) => {
    await extras.endLane(device.laneId);
    return inventory.endLaneLocked(device);
  };

  /* ---------- extra devices: which device a call names ---------- */

  /** True when `wanted` is this device's AVD name or the name a person reads. */
  const namesDevice = (device: AndroidLaneDevice, wanted: string, avdHome: string | null): boolean => {
    if (sameAvdName(device.avdName, wanted) || sameAvdName(androidAvdDisplayName(device.avdName), wanted)) return true;
    const shown = avdHome ? readAndroidAvd(avdHome, device.avdName)?.displayName ?? null : null;
    return shown !== null && sameAvdName(shown, wanted);
  };

  /**
   * The extra a call's `device` names, or null for the lane's own device (no
   * `device`, or one that names it). Anything else is refused: an install or
   * a start never lands on a device the lane does not hold.
   */
  const resolveTarget = (laneId: string, wanted: string | null | undefined): AndroidLaneDevice | null => {
    const asked = typeof wanted === "string" ? wanted.trim() : "";
    if (!asked) return null;
    const avdHome = readableAvdHome();
    const own = deps.laneDevices.get(laneId);
    if (own && namesDevice(own, asked, avdHome)) return null;
    const extra = extras.find(laneId, asked, avdHome);
    if (extra) return extra;
    throw new AndroidEmulatorFailure(
      "ANDROID_DEVICE_NOT_LANE_OWNED",
      `${asked} is neither this lane's device nor one of its extra devices. ade android status --text lists them; ade android device-create --extra adds one.`,
    );
  };

  /** Installs and launches in flight on each lane's own device: a promote waits for them. */
  const laneJobs = new Map<string, number>();

  /**
   * An install or a launch: on one of the lane's extras when `device` names
   * one (booted first when off), else on the lane's device, counted as in use.
   */
  const onLaneOrExtra = async <T extends object>(
    args: { laneId: string; device?: string | null },
    onLane: () => Promise<T>,
    onExtra: (laneId: string, booted: () => Promise<{ serial: string; adbPath: string }>) => Promise<T>,
  ): Promise<T & { device?: AndroidTargetDevice }> => {
    const laneId = requireLaneId(args.laneId);
    const extra = resolveTarget(laneId, args.device);
    if (extra) {
      const result = await extras.runJob(laneId, extra, (booted) => onExtra(laneId, booted));
      return { ...result, device: { avdName: extra.avdName, extra: true } };
    }
    laneJobs.set(laneId, (laneJobs.get(laneId) ?? 0) + 1);
    try {
      const result = await onLane();
      const own = args.device ? deps.laneDevices.get(laneId) : null;
      return own ? { ...result, device: { avdName: own.avdName, extra: false } } : result;
    } finally {
      const left = (laneJobs.get(laneId) ?? 1) - 1;
      if (left > 0) laneJobs.set(laneId, left);
      else laneJobs.delete(laneId);
    }
  };

  /* ---------- parity: idle power-off and the cleanup pass (`androidLaneMaintenance.ts`) ---------- */

  /** Lanes with an instrumentation test run in progress: never idle. */
  const testsRunning = new Set<string>();

  /** The AVD folder when it can be read now; null keeps the pass from forgetting rows on an unmounted drive. */
  const readableAvdHome = (): string | null => {
    const avdHome = androidAvdHome(env, home);
    try {
      fs.readdirSync(avdHome);
      return avdHome;
    } catch {
      return null;
    }
  };

  /**
   * A scrcpy server runs on the device while this brain streams none: another
   * brain on the same project (the dev app beside the installed one) or
   * another tool shows the screen, so the idle pass leaves it on. One adb
   * call, made only just before a power-off. A failed read is no viewer.
   */
  const otherViewerOnDevice = async (laneId: string): Promise<boolean> => {
    if (liveStreamSerial(laneId) !== null) return false;
    try {
      return await readOtherScrcpyViewer(await requireBooted(laneId), lifetime.signal);
    } catch (error) {
      logger?.warn("android.idle_viewer_check_failed", { laneId, error: getErrorMessage(error) });
      return false;
    }
  };

  const maintenance = createAndroidLaneMaintenance({
    // The lane's own devices, then every lane's extras (`extra: true`), each on its own idle clock.
    listRows: () => [...(deps.laneDevices.list?.() ?? []), ...deps.laneDevices.extras(null)],
    keyOf: (device) => (device.extra ? androidExtraKey(device.laneId, device.avdName) : device.laneId),
    laneLiveness,
    discovered,
    ownsEmulator,
    holder: (avdName) => deps.laneDevices.holder(avdName),
    runningFor,
    avdHome: readableAvdHome,
    avdExists: (avdHome, avdName) => readAndroidAvd(avdHome, avdName) !== null,
    adeAvds: async () => {
      const avdHome = readableAvdHome();
      if (!avdHome) return [];
      return listAndroidAvds(avdHome).filter((avd) => avd.adeCreated).map((avd) => ({ avdName: avd.name, markerLaneId: readAdeAvdLaneId(avd) }));
    },
    endLane: async (device) => {
      if (device.extra) {
        await serialize(device.laneId, () => extras.release(device.laneId, device));
        logger?.info("android.cleanup.released_extra", { laneId: device.laneId, avdName: device.avdName });
        return;
      }
      await serialize(device.laneId, async () => {
        const current = deps.laneDevices.get(device.laneId);
        if (!current || !sameAvdName(current.avdName, device.avdName)) return;
        const result = await endLaneLocked(current);
        logger?.info("android.cleanup.released", { laneId: device.laneId, avdName: device.avdName, ...result });
      });
      emit({ type: "android.device.state", laneId: device.laneId, state: "none" });
    },
    stopOrphan: async (emulator) => {
      const { adbPath } = await requireSdk({ emulator: false });
      await stopEmulator(emulator, adbPath);
      logger?.info("android.cleanup.stopped_orphan", { serial: emulator.serial, avdName: emulator.avdName });
    },
    forgetRow: (device) => {
      if (device.extra) deps.laneDevices.forgetExtra(device.laneId, device.avdName);
      else deps.laneDevices.forget(device.laneId, device.avdName);
      logger?.info("android.cleanup.forgot_row", { laneId: device.laneId, avdName: device.avdName });
    },
    isBusy: (device) => {
      const laneId = device.laneId;
      if (device.extra) return extras.busyReason(laneId, device.avdName) !== null;
      const state = lanes.get(laneId);
      // A stream counts only while someone holds it (a viewer or a recording), not when it is merely up.
      return Boolean(state?.transient || laneStreams.held(laneId) || agent.isRecording(laneId) || agent.isLeased(laneId)
        || testsRunning.has(laneId) || laneJobs.has(laneId));
    },
    deviceIdleMs: async (device) => readDeviceIdleMs(
      device.extra ? await extras.requireBooted(device.laneId, device) : await requireBooted(device.laneId),
      lifetime.signal,
    ),
    powerOff: async (device, guard) => {
      if (device.extra) return extras.powerOffIdle(device.laneId, device, guard.stillIdle);
      const laneId = device.laneId;
      const stopped = await serialize(laneId, async () => {
        const state = laneState(laneId);
        // Something started using it (a lease, a test run, a call) while the pass waited.
        if (!guard.stillIdle()) throw new Error("The emulator came into use, so ADE left it running.");
        const current = deps.laneDevices.get(laneId);
        if (!current || !sameAvdName(current.avdName, device.avdName)) return false;
        if (await otherViewerOnDevice(laneId)) {
          logger?.info("android.idle_power_off_skipped", { laneId, avdName: device.avdName, reason: "other-viewer" });
          return false;
        }
        await stopLocked(state, current, { refuseForeign: false });
        state.error = null;
        return true;
      });
      if (stopped) await emitDeviceState(laneId);
      return stopped;
    },
    onChanged: () => emit({ type: "android.inventory.changed" }),
    idleMs: deps.idlePowerOffMs ?? androidIdlePowerOffMsFromEnv(env),
    logger,
  });
  refreshMaintenance = () => maintenance.refresh();

  /* ---------- parity: Inspect at a point (`androidInspect.ts`) ---------- */

  const inspect = createAndroidInspect({
    snapshot: (laneId) => agent.api.getScreenSnapshot({ laneId, fresh: true }),
    captureScreen: (laneId) => captureLaneScreen(laneId, null),
    laneRoot,
    logger,
    now,
  });

  /** A chat's work copy here was deleted: give its device back. */
  const releaseGoneWorkCopy = (laneId: string) => {
    if (disposed || (!deps.laneDevices.get(laneId) && deps.laneDevices.extras(laneId).length === 0)) return;
    void serialize(laneId, async () => {
      // A new copy for the same chat may have come back while this waited,
      // and an unreadable copy list is not proof that the copy is gone.
      if (laneLiveness(laneId) !== "missing") return;
      const device = deps.laneDevices.get(laneId);
      if (!device) {
        await extras.endLane(laneId);
        return;
      }
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
    if (device && runningFor(device.avdName)) return true;
    return deps.laneDevices.extras(laneId).some((extra) => runningFor(extra.avdName) !== null);
  });

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
    const ended = (laneId: string) => {
      const liveness = laneLiveness(laneId);
      return liveness !== null && liveness !== "active";
    };
    const endedLanes = (deps.laneDevices.list?.() ?? []).filter((device) => ended(device.laneId));
    // A lane that ended with extras and no device of its own.
    const endedExtraLanes = [...new Set(deps.laneDevices.extras(null).map((extra) => extra.laneId))]
      .filter((laneId) => ended(laneId) && !endedLanes.some((device) => device.laneId === laneId));
    const orphans = () => discovered().filter((emulator) =>
      registry.owns(emulator) && deps.laneDevices.holder(emulator.avdName) === null);
    if (endedLanes.length === 0 && endedExtraLanes.length === 0 && orphans().length === 0) return;
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
    for (const laneId of endedExtraLanes) {
      await serialize(laneId, async () => {
        await extras.endLane(laneId);
        changed = true;
        logger?.info("android.reconcile.released_extras", { laneId });
      }).catch((error: unknown) => {
        logger?.warn("android.reconcile.release_failed", { laneId, error: getErrorMessage(error) });
      });
    }
    for (const emulator of orphans()) {
      if (disposed) return;
      await stopEmulator(emulator, adbPath).then(
        () => {
          changed = true;
          logger?.info("android.reconcile.stopped_orphan", { serial: emulator.serial, avdName: emulator.avdName });
        },
        (error: unknown) => logger?.warn("android.reconcile.stop_failed", { serial: emulator.serial, error: getErrorMessage(error) }),
      );
    }
    if (changed) emit({ type: "android.inventory.changed" });
  };

  /* ---------- extra devices: promote ---------- */

  /**
   * What the lane's own device is busy with, as a phrase, or null when
   * nothing would break if it stopped being the lane's device. The caller's
   * own lease (`chatSessionId`) is no reason to refuse it.
   */
  const laneBusyReason = (laneId: string, chatSessionId: string | null): string | null => {
    const state = lanes.get(laneId);
    if (state?.transient === "starting") return "starting";
    if (state?.transient === "stopping") return "stopping";
    // Before the stream: a recording holds the stream too, and "recording" is the answer a caller can act on.
    if (agent.isRecording(laneId)) return "recording";
    if (laneStreams.held(laneId)) return "streaming its live view";
    if (testsRunning.has(laneId)) return "running tests";
    if (laneJobs.has(laneId)) return "installing or launching an app";
    const holder = agent.otherLeaseHolder(laneId, chatSessionId);
    return holder ? `leased to ${holder}` : null;
  };

  /**
   * One of the lane's extras becomes the lane's own device. In the lane's
   * queue and the extra's, so no start, stop, create or release of either can
   * interleave. Refused while either device is in use, before anything
   * changes. The old device is kept: an AVD ADE made becomes an extra in the
   * promoted one's place (its emulator keeps running), and the user's own AVD
   * is released back to them (what ADE installed comes off, ADE's emulator
   * stops, nothing is deleted).
   */
  const promote = (args: Parameters<AndroidEmulatorServiceApi["devicePromote"]>[0]): Promise<AndroidDevicePromoteResult> => {
    assertLive();
    const laneId = requireLaneId(args?.laneId);
    const wanted = typeof args?.device === "string" ? args.device.trim() : "";
    if (!wanted) throw new Error("device-promote needs --device <avd> of one of this lane's extra devices.");
    const chatSessionId = typeof args.chatSessionId === "string" ? args.chatSessionId.trim() || null : null;
    return serialize(laneId, async () => {
      assertWorkCopyLive(laneId);
      const avdHome = readableAvdHome();
      const current = deps.laneDevices.get(laneId);
      const extra = extras.find(laneId, wanted, avdHome);
      if (!extra) {
        // Already the lane's device: the state the caller asked for.
        if (current && namesDevice(current, wanted, avdHome)) {
          return { device: current, previous: null, previousKeptAs: null, lane: await laneStatus(laneId) };
        }
        throw new AndroidEmulatorFailure(
          "ANDROID_DEVICE_NOT_LANE_OWNED",
          `${wanted} is not one of this lane's extra devices. ade android status --text lists the lane's devices.`,
        );
      }
      return serialize(androidExtraKey(laneId, extra.avdName), async (): Promise<AndroidDevicePromoteResult> => {
        const extraBusy = extras.busyReason(laneId, extra.avdName);
        if (extraBusy) {
          throw new AndroidEmulatorFailure(
            "ANDROID_LANE_DEVICE_BUSY",
            `${extra.avdName} is ${extraBusy}, so it cannot become the lane's device now. Wait for that to finish, then run device-promote again.`,
          );
        }
        const busy = current ? laneBusyReason(laneId, chatSessionId) : null;
        if (current && busy) {
          throw new AndroidEmulatorFailure(
            "ANDROID_LANE_DEVICE_BUSY",
            `the lane's device ${current.avdName} is ${busy}, so it cannot hand over to ${extra.avdName} now. `
              + "Finish or stop that first (close the live view, record-stop, wait for the test or the install, or have the lease's "
              + "holder run ade android lease release --token <t>), then run device-promote again.",
          );
        }
        const state = laneState(laneId);
        let previousKeptAs: AndroidDevicePromoteResult["previousKeptAs"] = null;
        if (current) {
          crashWatch.stop(laneId);
          // A stream no viewer holds may still run on the old device.
          await stopLaneStream(state);
          // Ends the lane's recording (none runs: checked above), and on the
          // user's own AVD takes off what ADE installed, while it still runs.
          await agent.beforeRelease(laneId);
          if (current.origin === "attached") {
            await stopLocked(state, current, { refuseForeign: false });
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
        if (current && previousKeptAs === "extra") {
          deps.laneDevices.setExtra({ ...current, adeInstalledPackages: [], extra: true });
        }
        adoptLaunch(state, extras.takeLaunch(laneId, extra.avdName));
        state.stopRequested = false;
        // A new device under the lane: the idle clock, the UI tree, the
        // screen size and the per-boot setup all start over.
        maintenance.started(laneId);
        agent.invalidateUi(laneId);
        agent.recordings.forgetScreenSize(laneId);
        agent.onDeviceBooted(laneId);
        logger?.info("android.lane_device_promoted", {
          laneId,
          avdName: device.avdName,
          previousAvdName: current?.avdName ?? null,
          previousKeptAs,
          by: chatSessionId ? "agent" : "user",
        });
        deps.captureAnalytics?.("device_promoted");
        emit({ type: "android.inventory.changed" });
        if (current && previousKeptAs === "extra") {
          const keptRunning = runningFor(current.avdName) !== null;
          emit({ type: "android.extra.state", laneId, avdName: current.avdName, state: keptRunning ? "booted" : "off" });
        }
        const lane = await emitDeviceState(laneId);
        return { device, previous: current ?? null, previousKeptAs, lane };
      });
    });
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
    streamRemoteBitrateKbpsCap: laneStreams.remoteBitrateKbpsCap,

    getSdkSetupPlan: setup.getSdkSetupPlan,
    installSdk: setup.installSdk,
    cancelSdkInstall: setup.cancelSdkInstall,
    getSdkInstallState: setup.getSdkInstallState,
    setSdkPath: setup.setSdkPath,

    /* Rec: the machine preferences and the lane's auto-record switch. */
    async getMachinePreferences() {
      return { preferences: streamPreferences.read(), recordingsBytes: agent.recordings.totalBytes() };
    },
    async setMachinePreferences(args) {
      const preferences = streamPreferences.write(args ?? {});
      logger?.info("android.preferences_set", { keys: Object.keys(args ?? {}) });
      emit({ type: "android.preferences.changed", preferences });
      return { preferences, recordingsBytes: agent.recordings.totalBytes() };
    },
    async getAutoRecord(args) {
      return agent.autoRecord.getAutoRecord(requireLaneId(args?.laneId));
    },
    async setAutoRecord(args) {
      const laneId = requireLaneId(args?.laneId);
      if (typeof args.enabled !== "boolean") throw new Error("auto-record needs on or off.");
      return agent.autoRecord.setAutoRecord(laneId, args.enabled);
    },
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
      // `start --device <extra>`: that extra boots beside the lane's device, on its own queue.
      const extra = resolveTarget(laneId, args.device);
      if (extra) {
        assertWorkCopyLive(laneId);
        return extras.start(laneId, extra, { force: args.force === true, restartAdb: args.restartAdb === true })
          .then(() => laneStatus(laneId));
      }
      return serialize(laneId, async () => {
        assertWorkCopyLive(laneId);
        // A chat's work copy has no device until its first start asks for one.
        if (isRemoteWorkLaneId(laneId) && !deps.laneDevices.get(laneId)) await inventory.ensureWorkCopyDeviceLocked(laneId);
        return startLocked(laneState(laneId), { force: args.force === true, restartAdb: args.restartAdb === true });
      });
    },

    async stop(args) {
      const laneId = requireLaneId(args.laneId);
      const extra = resolveTarget(laneId, args.device);
      if (extra) {
        await extras.stop(laneId, extra);
        return laneStatus(laneId);
      }
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
        if (device) await stopLocked(state, device, { refuseForeign: true });
        else await stopLaneStream(state);
        state.error = null;
        return emitDeviceState(laneId);
      });
    },

    /* `device-detach --device <extra>`: that extra goes (deleted unless `deleteCreated` is false); the lane keeps its device. */
    releaseDevice(args) {
      const laneId = requireLaneId(args.laneId);
      const extra = resolveTarget(laneId, args.device);
      if (!extra) return inventory.api.releaseDevice(args);
      return serialize(laneId, async () => ({
        ...(await extras.release(laneId, extra, { deleteCreated: args.deleteCreated !== false })),
        extra: true,
      }));
    },

    devicePromote: (args) => promote(args),

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
    // `install --device` / `launch --device`: on one of the lane's extras, or the lane's device.
    installApp: (args) => onLaneOrExtra(args, () => agent.api.installApp(args), (laneId, booted) => agent.installOnExtra(laneId, booted, args)),
    launchApp: (args) => onLaneOrExtra(args, () => agent.api.launchApp(args), (laneId, booted) => agent.launchOnExtra(laneId, booted, args)),
    runInstrumentationTests: async (args) => {
      const laneId = typeof args?.laneId === "string" ? args.laneId.trim() : "";
      if (laneId) testsRunning.add(laneId);
      try {
        return await agent.runInstrumentationTests(args);
      } finally {
        if (laneId) testsRunning.delete(laneId);
      }
    },

    /* ---------- parity: frame, Inspect, the cleanup pass ---------- */

    async frame(args) {
      const laneId = requireLaneId(args.laneId);
      const streamRunning = liveStreamSerial(laneId) !== null;
      // The device's own capture: the brain decodes no video, and Apple's
      // `frame` is also a capture of the screen. It is never filed as proof.
      const shot = await captureLaneScreen(laneId, args.outPath?.trim() || null);
      return { laneId, filePath: shot.path, width: shot.width, height: shot.height, capturedAt: shot.capturedAt, streamRunning };
    },

    inspectPoint: inspect.inspectPoint,
    selectPoint: inspect.selectPoint,

    deviceCleanup: (args) => maintenance.runCleanup(args ?? {}),
    ...deviceSettings.verbs,
    ...posture,
    ...composePreviews,
    ...storeShots,
    ...windows,
    getDeviceSettings: (args) => deviceSettings.getDeviceSettings(
      requireLaneId(args.laneId),
      args.fields === "foreground" || args.fields === "orientation" ? args.fields : "all",
    ),
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
        if (device) await stopLocked(state, device, { refuseForeign: false });
        else await stopLaneStream(state);
      }).catch((error: unknown) => {
        logger?.warn("android.stop_for_lane_failed", { laneId: id, error: getErrorMessage(error) });
      });
      // The lane's extras stop too; the lane release deletes them after.
      await extras.stopAll(id);
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
      maintenance.stop();
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
      if (!handOff && sdk) await extras.abortAll(sdk.adbPath);
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
            [...lanes.values()].find((state) => state.launch?.consolePort === emulator.consolePort)?.launch?.launcherPid
              ?? extras.launches().find((launch) => launch.consolePort === emulator.consolePort)?.launcherPid
              ?? null,
        });
      }
      lanes.clear();
      extras.clear();
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
  /*
   * Parity: every call that acts on a lane's emulator (an agent's or a
   * viewer's) restarts that lane's idle clock. The reads a pane or the mini
   * player polls do not, or an open window would keep an emulator up forever;
   * the viewer's stream counts by itself while it runs.
   */
  const NOT_USE = new Set<string>([
    "getStatus", "listDevices", "getStreamStatus", "deviceLeaseStatus", "recordList", "getAutoRecord",
    "getMachinePreferences", "getSdkSetupPlan", "getSdkInstallState", "listSystemImages", "deviceCleanup",
    "stop", "stopForLane", "releaseDevice", "dispose", "onEvent", "releaseIfOwnedBy", "streamRemoteBitrateKbpsCap",
  ]);
  const record = service as unknown as Record<string, unknown>;
  for (const [name, value] of Object.entries(record)) {
    if (typeof value !== "function" || NOT_USE.has(name)) continue;
    const method = value as (...callArgs: unknown[]) => unknown;
    record[name] = (...callArgs: unknown[]) => {
      const laneId = (callArgs[0] as { laneId?: unknown } | null | undefined)?.laneId;
      if (typeof laneId === "string" && laneId.trim()) maintenance.touch(laneId.trim());
      return method(...callArgs);
    };
  }
  // After construction returns, so a caller's first call is not held up by it;
  // lane steps still queue behind it through `serialize`. The maintenance
  // timers arm after it, from what the reconcile left: none for a project
  // with no Android device and no emulator ADE started.
  setTimeout(() => {
    void reconcile()
      .catch((error: unknown) => {
        logger?.warn("android.reconcile_failed", { error: getErrorMessage(error) });
      })
      .finally(() => maintenance.start());
  }, 0);
  return service;
}
