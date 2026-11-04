import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AndroidAvd,
  AndroidAvdListing,
  AndroidCreateDeviceArgs,
  AndroidDeviceInventory,
  AndroidEmulatorError,
  AndroidEmulatorEvent,
  AndroidEmulatorServiceApi,
  AndroidEmulatorStatus,
  AndroidLaneDevice,
  AndroidLaneDeviceStatus,
  AndroidRunningEmulator,
  AndroidSdkStatus,
  AndroidStreamStatus,
  AndroidSystemImage,
} from "../../../shared/types/androidEmulator";
import type { Logger } from "../logging/logger";
import { getErrorMessage, sleep } from "../shared/utils";
import {
  createAndroidAvd,
  deleteAdeAndroidAvd,
  listAndroidAvds,
  pickAndroidSystemImage,
  readAdeAvdLaneId,
  readAndroidAvd,
  sameAvdName,
} from "./androidAvds";
import { AndroidEmulatorFailure, requireLaneId } from "./androidEmulatorErrors";
import {
  AdeStartedEmulators,
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
import { listAndroidDeviceDefinitions } from "./androidHardwareProfiles";
import { createAndroidInput } from "./androidInput";
import { releaseAndroidLaneDevice, type AndroidLaneDeviceRepo } from "./androidLaneRelease";
import { takeAndroidScreenshot } from "./androidScreenshot";
import {
  androidSdkPaths,
  androidUserHome,
  listAndroidSystemImages,
  locateAndroidSdk,
  readAndroidSdkStatus,
  requireAndroidSdkTools,
  type AndroidEnv,
  type ReadyAndroidSdk,
} from "./androidSdk";
import { asStreamFailure, createAndroidStreamHub, type AndroidStreamHub } from "./androidStream";
import { isRemoteWorkLaneId } from "../remoteWork/remoteWorkCopyService";
import { createAndroidLaneScope, pickWorkCopyAvd } from "./androidWorkCopy";

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

/** A first boot of a new AVD measured 54 s on Windows; slower hosts need more. */
const ANDROID_BOOT_TIMEOUT_MS = 180_000;
/** The profile a chat's work copy gets when no AVD here is free. */
const WORK_COPY_PROFILE_ID = "medium_phone";

type AndroidEmulatorServiceDeps = {
  /** The lane rows (`lane_android_devices`); `sqlAndroidLaneDeviceRepo(db)` in the app. */
  laneDevices: AndroidLaneDeviceRepo;
  /**
   * ADE's folder for this service's own files: the started-emulators state
   * file, the emulator logs, default screenshots.
   */
  dataDir: string;
  /** The bundled scrcpy server (`resolveScrcpyServerJarPath`). */
  serverJarPath: string;
  /**
   * The process's streams (`createAndroidStreamHub`), shared by every service
   * the process builds. Absent = a hub of this service's own.
   */
  streamHub?: AndroidStreamHub;
  /**
   * The lane's worktree. A screenshot `outPath` resolves against it and must
   * stay inside it; without one, a call that names an `outPath` is refused.
   */
  resolveLaneWorktreePath?: (laneId: string) => string | null;
  /**
   * The project's root, where chats on other machines keep their work copies
   * (`remoteWorkCopyService`). Without it a `remote-work-…` lane is refused.
   */
  projectRoot?: string | null;
  logger?: Logger | null;
  /** The SDK the user picked in Settings, read on every use. */
  readSdkSettingPath?: () => string | null;
  env?: AndroidEnv;
  platform?: NodeJS.Platform;
  home?: string;
  discoveryDirs?: readonly string[];
  bootTimeoutMs?: number;
  /**
   * The brain sets this. Its exits are restarts (an update, a service
   * restart, a crash), so `dispose` leaves ADE's emulators running, they
   * start in their own process group, and the next service re-adopts them
   * through the state file. An in-process runtime leaves it off: closing the
   * project there stops every emulator ADE started for it.
   */
  handOffOnDispose?: boolean;
  now?: () => Date;
  onEvent?: (event: AndroidEmulatorEvent) => void;
};

type LaneState = {
  laneId: string;
  /** The tail of this lane's lifecycle queue. */
  queue: Promise<unknown>;
  transient: "starting" | "stopping" | null;
  /** The last start that failed or the emulator that died; cleared by a start or stop. */
  error: AndroidEmulatorError | null;
  /** The emulator this process launched for the lane, while it runs. */
  launch: AndroidEmulatorLaunch | null;
  /** Set by a stop that arrived while the start was booting. */
  stopRequested: boolean;
  /** That stop's end of the booting emulator, so the failing start does not stop it twice. */
  launchStop: Promise<void> | null;
  /** The serial the lane's stream runs on, while it runs. */
  streamSerial: string | null;
};

export function createAndroidEmulatorService(deps: AndroidEmulatorServiceDeps): AndroidEmulatorServiceApi {
  const logger = deps.logger ?? null;
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const home = deps.home ?? os.homedir();
  const discoveryDirs = deps.discoveryDirs ?? androidDiscoveryDirs(platform, env, home);
  const bootTimeoutMs = Math.max(deps.bootTimeoutMs ?? ANDROID_BOOT_TIMEOUT_MS, 120_000);
  const now = deps.now ?? (() => new Date());
  /** One warning per kind of failure: the file is read on every call. */
  const registryWarned = new Set<string>();
  const registryFile = path.join(deps.dataDir, "started-emulators.json");
  const registry = new AdeStartedEmulators(registryFile, (op, error) => {
    const code = (error as NodeJS.ErrnoException)?.code ?? "parse";
    if (registryWarned.has(`${op}:${code}`)) return;
    registryWarned.add(`${op}:${code}`);
    logger?.warn("android.started_emulators_file_failed", { op, file: registryFile, error: getErrorMessage(error) });
  });
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

  const { laneRoot, laneLiveness, assertWorkCopyLive, onWorkCopyReleased } = createAndroidLaneScope({
    projectRoot: deps.projectRoot,
    resolveLaneWorktreePath: deps.resolveLaneWorktreePath,
    laneDevices: deps.laneDevices,
  });

  /* ---------- the SDK, read on use ---------- */

  const readSdk = async (): Promise<AndroidSdkStatus> => {
    const sdk = await readAndroidSdkStatus({ settingPath: deps.readSdkSettingPath?.() ?? null, env, platform, home });
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
    return { laneId, device, avd: avdWithRunning, state: derived, error: derived === "crashed" || derived === "off" ? error : null };
  };

  const emitDeviceState = async (laneId: string): Promise<AndroidLaneDeviceStatus> => {
    const status = await laneStatus(laneId);
    emit({ type: "android.device.state", laneId, state: status.state });
    return status;
  };

  /* ---------- streams ---------- */

  const stopLaneStream = async (state: LaneState): Promise<void> => {
    const serial = state.streamSerial;
    if (!serial) return;
    state.streamSerial = null;
    try {
      await streams.stopStream(serial);
    } catch (error) {
      logger?.warn("android.stream_stop_failed", { laneId: state.laneId, serial, error: getErrorMessage(error) });
    }
    emit({ type: "android.stream.state", laneId: state.laneId, running: false });
  };

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
  const stopLocked = async (state: LaneState, device: AndroidLaneDevice, options: { refuseForeign: boolean }): Promise<void> => {
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
      if (state.launch !== launch || state.transient !== null || state.stopRequested || disposed) return;
      state.launch = null;
      const how = info.error ?? (info.signal ? `signal ${info.signal}` : `code ${info.code}`);
      state.error = {
        code: "ANDROID_EMULATOR_EXITED",
        message: `The emulator for ${launch.avdName} exited (${how}).`,
        logPath: launch.logPath,
      };
      logger?.warn("android.emulator_exited", { laneId: state.laneId, avdName: launch.avdName, how });
      await stopLaneStream(state);
      emit({ type: "android.device.state", laneId: state.laneId, state: "crashed" });
    });
  };

  const startLocked = async (state: LaneState): Promise<AndroidLaneDeviceStatus> => {
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
    if (!readAndroidAvd(ready.avdHome, device.avdName)) {
      throw new AndroidEmulatorFailure("ANDROID_AVD_NOT_FOUND", `The lane's AVD ${device.avdName} is no longer on this machine.`);
    }
    // Already running (a start from before a brain restart, or the user's own
    // emulator for an attached AVD): use it as it is.
    if (runningFor(device.avdName)) return laneStatus(laneId, ready.sdk);

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
      watchExit(state, launch);
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

  /* ---------- devices ---------- */

  const assertLaneFree = (laneId: string, avdName: string | null) => {
    const held = deps.laneDevices.get(laneId);
    if (held && !(avdName && sameAvdName(held.avdName, avdName))) {
      throw new AndroidEmulatorFailure(
        "ANDROID_LANE_HAS_DEVICE",
        `This lane already has ${held.avdName}. Release it before adding another device.`,
      );
    }
  };

  const assertNotHeldElsewhere = (laneId: string | null, avdName: string) => {
    const holder = deps.laneDevices.holder(avdName, laneId);
    if (holder) {
      throw new AndroidEmulatorFailure("ANDROID_AVD_HELD_BY_OTHER_LANE", `${avdName} belongs to another lane (${holder}).`);
    }
  };

  const definitionsFor = (root: string, images: readonly AndroidSystemImage[]) =>
    listAndroidDeviceDefinitions({
      sdkRoot: root,
      systemImageDirs: images.map((image) => image.path),
      platform,
      env,
      home,
      onUnreadable: (filePath, error) => logger?.warn("android.profile_file_unreadable", { filePath, error: getErrorMessage(error) }),
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

  /** The serial of the lane's live stream, when one runs (input then goes through scrcpy). */
  const liveStreamSerial = (laneId: string): string | null => {
    const serial = lanes.get(laneId)?.streamSerial ?? null;
    return serial && streams.status(serial, laneId).running ? serial : null;
  };

  const input = createAndroidInput({ streams, requireBooted, liveStreamSerial, signal: lifetime.signal });

  /** A new row for the lane's AVD. */
  const newLaneDevice = (
    laneId: string,
    avdName: string,
    origin: AndroidLaneDevice["origin"],
    profileId: string | null,
    systemImage: string | null,
  ): AndroidLaneDevice => ({ laneId, avdName, origin, profileId, systemImage, createdAt: now().toISOString(), adeInstalledPackages: [] });

  /** How the lane release reads this machine's disks. */
  const releaseOptions = (deleteCreated?: boolean) => ({
    env,
    platform,
    home,
    discoveryDirs,
    logger,
    ...(deleteCreated === undefined ? {} : { deleteCreated }),
  });

  /**
   * Makes a new AVD for the lane and records it as the lane's own (deleted
   * with the lane). The caller holds the lane's queue and checked the lane
   * is free.
   */
  const createLocked = async (laneId: string, profileId: string, wanted: string | null, displayName: string | null): Promise<void> => {
    const ready = await requireSdk({ emulator: true });
    const images = listAndroidSystemImages(ready.root);
    const definition = definitionsFor(ready.root, images).find((entry) => entry.profile.id === profileId);
    if (!definition) {
      throw new AndroidEmulatorFailure("ANDROID_AVD_NOT_FOUND", `No hardware profile named ${profileId} is on this machine.`);
    }
    const image = wanted
      ? images.find((entry) => entry.packageId === wanted) ?? null
      : pickAndroidSystemImage(images, ready.sdk.hostAbi, definition);
    if (!image) {
      throw new AndroidEmulatorFailure(
        "ANDROID_NO_SYSTEM_IMAGE",
        wanted
          ? `The system image ${wanted} is not installed.`
          : `No ${ready.sdk.hostAbi} system image is installed. Install one with the SDK Manager.`,
      );
    }
    const avd = createAndroidAvd({
      sdkRoot: ready.root,
      avdHome: ready.avdHome,
      userHome: androidUserHome(env, home),
      laneId,
      definition,
      image,
      displayName,
    });
    deps.laneDevices.set(newLaneDevice(laneId, avd.name, "created", profileId, image.packageId));
    logger?.info("android.device_created", { laneId, avdName: avd.name, profileId, systemImage: image.packageId });
    emit({ type: "android.inventory.changed" });
  };

  /**
   * A chat's work copy gets its first device: a free AVD this machine already
   * has before a new one, since a new one costs gigabytes and a first boot.
   * The borrowed AVD is attached, so releasing it never deletes it. The caller
   * holds the lane's queue.
   */
  const ensureWorkCopyDeviceLocked = async (laneId: string): Promise<void> => {
    const ready = await requireSdk({ emulator: true });
    // No await from here to the row write: two lanes asking at once cannot
    // both take one AVD.
    const borrowed = pickWorkCopyAvd(listAndroidAvds(ready.avdHome), discovered(), { ...deps.laneDevices, owns: ownsEmulator });
    if (borrowed) {
      deps.laneDevices.set(newLaneDevice(laneId, borrowed.name, "attached", borrowed.profileId, null));
      logger?.info("android.work_copy_borrowed", { laneId, avdName: borrowed.name, adeCreated: borrowed.adeCreated });
      emit({ type: "android.inventory.changed" });
      return;
    }
    await createLocked(laneId, WORK_COPY_PROFILE_ID, null, null);
  };

  /**
   * Stops the lane's emulator and releases its AVD by the normal rules (an
   * attached AVD stays). The caller holds the lane's queue.
   */
  const endLaneLocked = async (device: AndroidLaneDevice) => {
    await stopLocked(laneState(device.laneId), device, { refuseForeign: false });
    const result = await releaseAndroidLaneDevice(device.laneId, deps.laneDevices, releaseOptions());
    lanes.delete(device.laneId);
    return result;
  };

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
    if (endedLanes.length === 0 && orphans().length === 0) return;
    const located = locateAndroidSdk({ settingPath: deps.readSdkSettingPath?.() ?? null, env, platform, home });
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

  /* ---------- the API ---------- */

  const service: AndroidEmulatorServiceApi = {
    async getStatus(args) {
      const sdk = await readSdk();
      const laneId = args?.laneId?.trim() || null;
      const status: AndroidEmulatorStatus = {
        platformSupported,
        unsupportedReason,
        sdk,
        lane: laneId ? await laneStatus(laneId, sdk) : null,
      };
      return status;
    },

    async listDevices() {
      const sdk = await readSdk();
      if (!sdk.found || !sdk.root || !sdk.avdHome) return { avds: [], profiles: [], images: [] };
      const adbPath = androidSdkPaths(sdk.root, platform).adb;
      const running = await Promise.all(discovered().map((emulator) => asRunning(adbPath, emulator)));
      const avds: AndroidAvdListing[] = listAndroidAvds(sdk.avdHome, { running }).map((avd) => {
        const madeFor = avd.adeCreated ? readAdeAvdLaneId(avd) : null;
        return {
          ...avd,
          running: running.find((emulator) => sameAvdName(emulator.avdName, avd.name)) ?? null,
          heldByLaneId: deps.laneDevices.holder(avd.name),
          madeForOtherLane: madeFor !== null && laneLiveness(madeFor) === "missing",
        };
      });
      const images = listAndroidSystemImages(sdk.root);
      const profiles = definitionsFor(sdk.root, images).map((definition) => definition.profile);
      const inventory: AndroidDeviceInventory = { avds, profiles, images };
      return inventory;
    },

    createDevice(args: AndroidCreateDeviceArgs) {
      assertLive();
      const laneId = requireLaneId(args.laneId);
      const profileId = typeof args.profileId === "string" ? args.profileId.trim() : "";
      if (!profileId) throw new Error("profileId is required.");
      return serialize(laneId, async () => {
        assertWorkCopyLive(laneId);
        assertLaneFree(laneId, null);
        await createLocked(laneId, profileId, args.systemImage?.trim() || null, args.displayName ?? null);
        if (args.start === false) return emitDeviceState(laneId);
        return startLocked(laneState(laneId));
      });
    },

    attachDevice(args) {
      assertLive();
      const laneId = requireLaneId(args.laneId);
      const avdName = typeof args.avdName === "string" ? args.avdName.trim() : "";
      if (!avdName) throw new Error("avdName is required.");
      return serialize(laneId, async () => {
        assertWorkCopyLive(laneId);
        assertLaneFree(laneId, avdName);
        assertNotHeldElsewhere(laneId, avdName);
        const ready = await requireSdk({ emulator: false });
        const avd = readAndroidAvd(ready.avdHome, avdName);
        if (!avd) throw new AndroidEmulatorFailure("ANDROID_AVD_NOT_FOUND", `No AVD named ${avdName} is on this machine.`);
        if (!deps.laneDevices.get(laneId)) {
          // Again after the await: another lane's queue may have taken it meanwhile.
          // No await from here to the row write.
          assertNotHeldElsewhere(laneId, avdName);
          // Only the lane an AVD was made for deletes it with the lane. An
          // ADE AVD made for another lane may belong to a lane of another
          // project (this lane table cannot see it), so it is attached:
          // never deleted on release, like the user's own AVDs.
          const origin = avd.adeCreated && readAdeAvdLaneId(avd) === laneId ? "created" : "attached";
          deps.laneDevices.set(newLaneDevice(laneId, avd.name, origin, avd.profileId, null));
          emit({ type: "android.inventory.changed" });
        }
        if (args.start === false) return emitDeviceState(laneId);
        return startLocked(laneState(laneId));
      });
    },

    start(args) {
      assertLive();
      const laneId = requireLaneId(args.laneId);
      return serialize(laneId, async () => {
        assertWorkCopyLive(laneId);
        // A chat's work copy has no device until its first start asks for one.
        if (isRemoteWorkLaneId(laneId) && !deps.laneDevices.get(laneId)) await ensureWorkCopyDeviceLocked(laneId);
        return startLocked(laneState(laneId));
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
        if (device) await stopLocked(state, device, { refuseForeign: true });
        else await stopLaneStream(state);
        state.error = null;
        return emitDeviceState(laneId);
      });
    },

    releaseDevice(args) {
      const laneId = requireLaneId(args.laneId);
      return serialize(laneId, async () => {
        const state = laneState(laneId);
        const device = deps.laneDevices.get(laneId);
        if (!device) return { released: false, deletedAvd: null };
        await stopLocked(state, device, { refuseForeign: false });
        const result = await releaseAndroidLaneDevice(laneId, deps.laneDevices, releaseOptions(args.deleteCreated !== false));
        if (!result.released) {
          throw new AndroidEmulatorFailure("ANDROID_AVD_RUNNING", result.reason ?? `${device.avdName} could not be released.`);
        }
        state.error = null;
        emit({ type: "android.inventory.changed" });
        emit({ type: "android.device.state", laneId, state: "none" });
        return { released: true, deletedAvd: result.deletedAvd };
      });
    },

    deleteDevice(args) {
      assertLive();
      const avdName = typeof args.avdName === "string" ? args.avdName.trim() : "";
      if (!avdName) throw new Error("avdName is required.");
      return serialize(`avd:${avdName.toLowerCase()}`, async () => {
        assertNotHeldElsewhere(null, avdName);
        const ready = await requireSdk({ emulator: false });
        const running = runningFor(avdName);
        if (running) throw new AndroidEmulatorFailure("ANDROID_AVD_RUNNING", `${avdName} is running. Stop it before deleting it.`);
        // Again after the await: a lane may have attached it meanwhile.
        assertNotHeldElsewhere(null, avdName);
        deleteAdeAndroidAvd(ready.avdHome, avdName, []);
        logger?.info("android.device_deleted", { avdName });
        emit({ type: "android.inventory.changed" });
        return { deleted: true };
      });
    },

    async startStream(args) {
      assertLive();
      const laneId = requireLaneId(args.laneId);
      assertWorkCopyLive(laneId);
      const { serial, adbPath } = await requireBooted(laneId);
      const state = laneState(laneId);
      if (state.streamSerial && state.streamSerial !== serial) await stopLaneStream(state);
      const transport = await streams.startStream({
        adbPath,
        serial,
        serverJarPath: deps.serverJarPath,
        laneId,
        ...(typeof args.maxSize === "number" ? { maxSize: args.maxSize } : {}),
        ...(typeof args.bitRateBps === "number" ? { bitRate: args.bitRateBps } : {}),
        ...(typeof args.maxFps === "number" ? { maxFps: args.maxFps } : {}),
        logger,
      }).catch(asStreamFailure);
      const fresh = state.streamSerial !== serial;
      state.streamSerial = serial;
      if (fresh) emit({ type: "android.stream.state", laneId, running: true });
      const status = streams.status(serial, laneId);
      return { ...status, laneId, running: true, backend: "scrcpy", transport };
    },

    async stopStream(args) {
      const laneId = requireLaneId(args.laneId);
      await stopLaneStream(laneState(laneId));
      return { laneId, running: false, backend: null, transport: null, fps: null };
    },

    async getStreamStatus(args) {
      const laneId = requireLaneId(args.laneId);
      const serial = lanes.get(laneId)?.streamSerial ?? null;
      const status: AndroidStreamStatus = serial
        ? streams.status(serial, laneId)
        : { laneId, running: false, backend: null, transport: null, fps: null };
      // Redacted: the token is only for the viewer that started the stream.
      return { ...status, laneId, transport: null };
    },

    ...input,

    async screenshot(args) {
      const laneId = requireLaneId(args.laneId);
      return takeAndroidScreenshot({
        laneId,
        outPath: args.outPath?.trim() || null,
        laneRoot: () => laneRoot(laneId),
        workCopy: isRemoteWorkLaneId(laneId),
        requireBooted: () => requireBooted(laneId),
        dataDir: deps.dataDir,
        platform,
        signal: lifetime.signal,
        now,
      });
    },

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
      lanes.delete(id);
      if (hadDevice || hadState) emit({ type: "android.device.state", laneId: id, state: hadDevice ? "off" : "none" });
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
      lifetime.abort();
      offCopyReleased();
      const sdk = await requireSdk({ emulator: false }).catch(() => null);
      const handOff = deps.handOffOnDispose === true;
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
        for (const emulator of discovered()) {
          if (!registry.owns(emulator)) continue;
          const launcherPid = [...lanes.values()].find((state) => state.launch?.consolePort === emulator.consolePort)?.launch?.launcherPid ?? null;
          await stopEmulator(emulator, sdk.adbPath, launcherPid).catch((error: unknown) => {
            logger?.warn("android.dispose_stop_failed", { serial: emulator.serial, error: getErrorMessage(error) });
          });
        }
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
  // After construction returns, so a caller's first call is not held up by it;
  // lane steps still queue behind it through `serialize`.
  setTimeout(() => {
    void reconcile().catch((error: unknown) => {
      logger?.warn("android.reconcile_failed", { error: getErrorMessage(error) });
    });
  }, 0);
  return service;
}
