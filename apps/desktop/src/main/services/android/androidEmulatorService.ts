import os from "node:os";
import path from "node:path";
import type {
  AndroidEmulatorEvent,
  AndroidEmulatorServiceApi,
  AndroidEmulatorStatus,
  AndroidLaneDevice,
  AndroidLaneDeviceStatus,
  AndroidRunningEmulator,
  AndroidSdkStatus,
} from "../../../shared/types/androidEmulator";
import { getErrorMessage, sleep } from "../shared/utils";
import { cloudAndroidNeedsVmMessage, cloudShapeForResources } from "../../../shared/adeCloud";
import { listAndroidAvds, readAdeAvdLaneId, readAndroidAvd, sameAvdName } from "./androidAvds";
import { createAndroidInspect } from "./androidInspect";
import { createAndroidLaneMaintenance, readUseOnDevice } from "./androidLaneMaintenance";
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
import { createAndroidDevicePromote } from "./androidDevicePromote";
import { createAndroidLaneRows } from "./androidLaneRows";
import { createAndroidDeviceRouter } from "./androidDeviceRouter";
import { createAndroidLaneStatus } from "./androidLaneStatus";
import { androidLaneExtraLimit, createAndroidLaneExtras } from "./androidLaneExtras";
import {
  openStartedEmulators,
  reconcileStartedEmulators,
  stopAdeStartedEmulators,
  STARTED_EXTRA_EMULATORS_FILE,
} from "./androidHandedOffEmulators";
import { createAndroidEmulatorUse } from "./androidEmulatorUse";
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
  readableAndroidAvdHome,
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
import { createAndroidLaneScope, watchAndroidWorkCopyDevices } from "./androidWorkCopy";
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
 * - ADE stops only emulators it started. Who started what is kept in small
 *   state files under the ADE data folder (one for the lanes' own devices,
 *   one for their extras), so it survives a brain restart.
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
  /** These emulators of the lane, when idle and not pinned. Not an agent action: the settled-lane release calls it. */
  powerOffEmulators(args: { laneId: string; avdNames: ReadonlySet<string> }): Promise<{ poweredOff: Array<{ avdName: string }> }>;
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
  /** The extras' own file: an older ADE on the same project reads only the one above. */
  const extraRegistry = openStartedEmulators(deps.dataDir, logger, STARTED_EXTRA_EMULATORS_FILE);
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

  /** Runs one lifecycle step after every earlier step on the lane (or on one extra's key) has settled. */
  const serialize = <T>(key: string, step: () => Promise<T>): Promise<T> => {
    const state = laneState(key);
    const run = state.queue.then(step, step);
    state.queue = run.catch(() => undefined);
    return run;
  };

  /** An extra that went (released or promoted): its queue entry goes once no step waits on it, so `lanes` does not grow. */
  const forgetQueue = (key: string): void => {
    const state = lanes.get(key);
    if (!state) return;
    const tail = state.queue;
    void tail.then(() => {
      if (lanes.get(key) === state && state.queue === tail) lanes.delete(key);
    });
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
    // a cloud box never has KVM. Refuse its first emulator step (making a
    // device, or a start) with what a VM costs, not "turn on KVM".
    if (needs.emulator && !ready.sdk.acceleration.usable && process.env.ADE_CLOUD_INSTANCE_ID?.trim()) {
      throw new AndroidEmulatorFailure(
        "ANDROID_NO_ACCELERATION",
        cloudAndroidNeedsVmMessage(cloudShapeForResources(os.cpus().length, os.totalmem())),
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
    if (registry.owns(emulator) || extraRegistry.owns(emulator)) return true;
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

  const laneStatus = createAndroidLaneStatus({
    laneDevices: deps.laneDevices,
    platform,
    peekLane: (laneId) => lanes.get(laneId),
    readSdk: () => readSdk(),
    runningFor,
    asRunning,
    crashWatch,
    laneStatusFields: (avdName, startedByAde) => use.laneStatusFields(avdName, startedByAde),
    poweredOffRecord: (laneId) => maintenance.poweredOffRecord(laneId),
    extraStatuses: (laneId, sdk) => extras.statuses(laneId, sdk),
  });

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

  const { stopEmulator, abortBoot, interruptBoot, stopLocked, startLocked, adoptLaunch, slots } = createAndroidEmulatorLifecycle({
    deps,
    env,
    platform,
    logger,
    registry,
    extraRegistry,
    discoveryDirs,
    bootedSeen,
    machineLifecycle: lifecycle,
    discovered,
    noteStopped: (emulator, reason, laneId) => use.noteStopped(emulator, reason, laneId),
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

  /** The one orphan stop: an emulator ADE started that no lane holds (the start-up reconcile and the cleanup pass). */
  const stopOrphan = (emulator: AndroidDiscoveredEmulator, adbPath: string) => stopEmulator(emulator, adbPath, "orphan", null);

  /* ---------- extra devices (`androidLaneExtras.ts`) ---------- */

  const extras = createAndroidLaneExtras({
    deps,
    env,
    platform,
    logger,
    extraRegistry,
    discoveryDirs,
    home,
    slots,
    emit,
    runningFor,
    asRunning,
    bootedNow,
    requireSdk,
    serialize,
    forgetQueue,
    avdHome: () => readableAvdHome(),
    touch: (avdName) => lifecycle?.touch(avdName),
    started: (key) => maintenance.started(key),
    poweredOffRecord: (key) => maintenance.poweredOffRecord(key),
    notePoweredOff: (key, record) => maintenance.notePoweredOff(key, record),
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
    startExtra: (laneId, extra, options) => extras.start(laneId, extra, options),
    onExtraCreated: () => deps.captureAnalytics?.("extra_device_created"),
  });

  /** A lane ended: its extras stop and go, then its own device by the normal rules. The caller holds the lane's queue. */
  const endLaneLocked = async (device: AndroidLaneDevice) => {
    await extras.endLane(device.laneId);
    return inventory.endLaneLocked(device);
  };

  /* ---------- parity: the cleanup pass and the power-off record (`androidLaneMaintenance.ts`) ---------- */

  /** The AVD folder when it can be read now; null keeps the pass from forgetting rows on an unmounted drive. */
  const readableAvdHome = () => readableAndroidAvdHome(env, home);

  /** How the cleanup pass reaches one row: the lane's own device, or one of its extras (`androidLaneRows.ts`). */
  const rows = createAndroidLaneRows({
    laneDevices: deps.laneDevices,
    extras,
    logger,
    serialize,
    laneState,
    deviceBusy: (device) => use.deviceBusy(device),
    endLaneLocked,
    stopLocked,
    emitDeviceState,
    emit,
    notePoweredOff: (key, record) => maintenance.notePoweredOff(key, record),
  });

  const maintenance = createAndroidLaneMaintenance({
    // The lane's own devices, then every lane's extras (`extra: true`), each with its own power-off record.
    listRows: () => [...(deps.laneDevices.list?.() ?? []), ...deps.laneDevices.extras(null)],
    ...rows.maintenance,
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
    stopOrphan: async (emulator) => {
      const { adbPath } = await requireSdk({ emulator: false });
      await stopOrphan(emulator, adbPath);
      logger?.info("android.cleanup.stopped_orphan", { serial: emulator.serial, avdName: emulator.avdName });
    },
    isPinned: (avdName) => use.isPinned(avdName),
    idleMinutes: (avdName) => use.idleMinutes(avdName),
    idleStopMinutes: () => use.idleStopMinutes(),
    onChanged: () => emit({ type: "android.inventory.changed" }),
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

  const offWorkCopies = watchAndroidWorkCopyDevices({
    laneDevices: deps.laneDevices,
    isDisposed: () => disposed,
    laneLiveness,
    serialize,
    peekLane: (laneId) => lanes.get(laneId),
    runningFor,
    endExtrasLocked: (laneId) => extras.endLane(laneId),
    endLaneLocked,
    onWorkCopyReleased,
    registerWorkCopyDeviceCheck,
    emit,
    logger,
  });

  /* ---------- the lifecycle: use, busy, the idle stop, the pin (`androidEmulatorUse.ts`) ---------- */

  /** Running emulators the project's state files (the lanes' and the extras') list as ADE's. */
  const startedHere = () => discovered().filter((emulator) => registry.owns(emulator) || extraRegistry.owns(emulator));
  const locateAdb = () => {
    const located = locateAndroidSdk({ settingPath: readSdkSettingPath(), env, platform, home });
    return located ? androidSdkPaths(located.root, platform).adb : null;
  };
  const use = createAndroidEmulatorUse({
    lifecycle,
    laneDevices: deps.laneDevices,
    projectRoot: deps.projectRoot ?? null,
    logger,
    now,
    isDisposed: () => disposed,
    busyHere: (laneId) => {
      const state = lanes.get(laneId);
      // A stream counts only while someone holds it (a viewer or a recording), not when it is merely up.
      return Boolean(state?.transient) || laneStreams.held(laneId) || agent.isRecording(laneId) || agent.isLeased(laneId);
    },
    extraBusy: (laneId, avdName) => extras.busyReason(laneId, avdName) !== null,
    usedOnDevice: async (device, idleMs) => {
      const laneId = device.laneId;
      const booted = await (device.extra ? extras.requireBooted(laneId, device) : requireBooted(laneId)).catch(() => null);
      // The lane's own stream is this brain's viewer, not another one.
      const ownStream = !device.extra && liveStreamSerial(laneId) !== null;
      return booted ? readUseOnDevice(booted, { idleMs, ownStream, signal: lifetime.signal, logger, laneId }) : null;
    },
    ownedRunning: (avdName) => {
      const emulator = runningFor(avdName);
      return emulator && ownsEmulator(emulator) ? emulator : null;
    },
    startedHere,
    describe: (avdName) => ({ adbPath: locateAdb(), guestRamMb: readAndroidAvd(androidAvdHome(env, home), avdName)?.ramMb ?? null }),
    serialize,
    stopIdleLocked: rows.stopIdleLocked,
    stopIdleExtra: (laneId, extra, idleMinutes, check) => extras.stopIdle(laneId, extra, idleMinutes, check),
    onAutoStopped: () => deps.captureAnalytics?.("emulator_auto_stopped"),
  });

  /* ---------- extra devices: promote (`androidDevicePromote.ts`) ---------- */

  const promotion = createAndroidDevicePromote({
    deps,
    logger,
    extras,
    registry,
    extraRegistry,
    peekLane: (laneId) => lanes.get(laneId),
    laneState,
    serialize,
    assertLive,
    assertWorkCopyLive,
    avdHome: readableAvdHome,
    runningFor,
    laneStatus: (laneId) => laneStatus(laneId),
    emitDeviceState,
    emit,
    stopLocked,
    adoptLaunch,
    crashWatch,
    stopLaneStream,
    laneStreams,
    agent,
    maintenance,
    touch: (avdName) => lifecycle?.touch(avdName),
  });

  /* ---------- start, stop and release, with their `device` (`androidDeviceRouter.ts`) ---------- */

  const router = createAndroidDeviceRouter({
    laneDevices: deps.laneDevices,
    extras,
    settled: promotion.settled,
    serialize,
    laneState,
    assertLive,
    assertWorkCopyLive,
    avdHome: readableAvdHome,
    ensureDeviceLocked: async (laneId) => {
      if (isRemoteWorkLaneId(laneId) && !deps.laneDevices.get(laneId)) await inventory.ensureWorkCopyDeviceLocked(laneId);
    },
    startLocked,
    stopLocked,
    interruptBoot,
    adbPath: async () => (await requireSdk({ emulator: false })).adbPath,
    stopLaneStream,
    laneStatus: (laneId) => laneStatus(laneId),
    emitDeviceState,
    releaseLaneDevice: (args) => inventory.api.releaseDevice(args),
    abortBoot,
    hasLane: (laneId) => lanes.has(laneId),
    forgetLane: (laneId) => { lanes.delete(laneId); },
    emit,
    logger,
  });

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

    start: router.start,
    stop: router.stop,
    releaseDevice: router.releaseDevice,

    devicePromote: (args) => promotion.promote(args),

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
        if (ownsEmulator(emulator)) use.setKeepRunning(laneId, device.avdName, args.keepRunning);
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
    // `install --device` / `launch --device`: on one of the lane's extras, or the lane's device.
    installApp: (args) => promotion.onLaneOrExtra(args, () => agent.api.installApp(args), (laneId, booted) => agent.installOnExtra(laneId, booted, args)),
    launchApp: (args) => promotion.onLaneOrExtra(args, () => agent.api.launchApp(args), (laneId, booted) => agent.launchOnExtra(laneId, booted, args)),
    // A test run is a use call: in flight, its lane's emulator is busy (`androidEmulatorUse.ts`), and a promote is refused.
    runInstrumentationTests: (args) => promotion.runTests(
      typeof args?.laneId === "string" ? args.laneId.trim() : "",
      () => agent.runInstrumentationTests(args),
    ),

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
    powerOffEmulators: (args) =>
      maintenance.powerOffNow({ onlyLaneId: args.laneId, onlyAvdNames: args.avdNames }),
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

    stopForLane: router.stopForLane,

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
      use.dispose();
      maintenance.stop();
      renders.dispose();
      setup.dispose();
      crashWatch.dispose();
      // Recordings end (and are filed) while their stream still runs.
      await agent.dispose().catch((error: unknown) => {
        logger?.warn("android.agent_dispose_failed", { error: getErrorMessage(error) });
      });
      lifetime.abort();
      offWorkCopies();
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
        logger?.info("android.dispose_hand_off", { emulators: startedHere().map((emulator) => emulator.serial) });
      } else if (sdk) {
        // Every emulator ADE started for this project, this run or an earlier
        // one (the lanes' file and the extras' file), and nothing else.
        await stopAdeStartedEmulators({
          registries: [registry, extraRegistry],
          adbPath: sdk.adbPath,
          discoveryDirs,
          logger,
          launcherPidFor: (emulator) =>
            [...lanes.values()].find((state) => state.launch?.consolePort === emulator.consolePort)?.launch?.launcherPid
              ?? extras.launches().find((launch) => launch.consolePort === emulator.consolePort)?.launcherPid
              ?? null,
          onStopped: (emulator) => use.noteStopped(emulator, "project_closed", deps.laneDevices.holder(emulator.avdName)),
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
  // The start-up reconcile, after construction returns, so a caller's first
  // call is not held up by it; lane steps still queue behind it through
  // `serialize`. The cleanup timers arm after it, from what the reconcile
  // left: none for a project with no Android device and no emulator ADE started.
  setTimeout(() => {
    void reconcileStartedEmulators({
      laneDevices: deps.laneDevices,
      laneLiveness,
      startedHere,
      takeIn: use.adoptUnrecordedEmulators,
      locateAdb,
      isDisposed: () => disposed,
      serialize,
      endLaneLocked,
      endExtrasLocked: (laneId) => extras.endLane(laneId),
      stopOrphan,
      logger,
    }).then((changed) => {
      if (changed) emit({ type: "android.inventory.changed" });
    }, (error: unknown) => {
      logger?.warn("android.reconcile_failed", { error: getErrorMessage(error) });
    }).finally(() => maintenance.start());
  }, 0);
  // Each call that uses the lane's emulator moves its idle clock, and keeps it busy while it runs.
  return use.track(service);
}
