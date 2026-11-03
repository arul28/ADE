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
  AndroidHardwareKey,
  AndroidLaneDevice,
  AndroidLaneDeviceStatus,
  AndroidRunningEmulator,
  AndroidScreenshot,
  AndroidSdkStatus,
  AndroidStreamStatus,
  AndroidSystemImage,
  AndroidTouchEvent,
} from "../../../shared/types/androidEmulator";
import type { Logger } from "../logging/logger";
import { runAdb } from "./adb";
import { createAndroidAvd, deleteAdeAndroidAvd, listAndroidAvds, readAndroidAvd } from "./androidAvds";
import { AndroidEmulatorFailure } from "./androidEmulatorErrors";
import {
  AdeStartedEmulators,
  androidDiscoveryDirs,
  launchAndroidEmulator,
  readAndroidBootCompleted,
  readAndroidDiscoveryFiles,
  stopAndroidEmulator,
  waitForAndroidBoot,
  type AndroidDiscoveredEmulator,
  type AndroidEmulatorLaunch,
} from "./androidEmulatorProcess";
import { listAndroidDeviceDefinitions, type AndroidDeviceDefinition } from "./androidHardwareProfiles";
import { releaseAndroidLaneDevice, type AndroidLaneDeviceRepo } from "./androidLaneRelease";
import { androidSdkPaths, androidUserHome, listAndroidSystemImages, readAndroidSdkStatus, type AndroidEnv } from "./androidSdk";
import * as androidStream from "./androidStream";
import { ANDROID_HARDWARE_KEYCODES } from "./scrcpyControl";

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
 *
 * Node built-ins and relative imports only, so the service also runs under a
 * plain `tsx` harness with an in-memory lane store.
 */

/** A first boot of a new AVD measured 54 s on Windows; slower hosts need more. */
export const ANDROID_BOOT_TIMEOUT_MS = 180_000;
const SWIPE_DEFAULT_MS = 300;
const SWIPE_STEP_MS = 16;
const SCREENSHOT_TIMEOUT_MS = 20_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type AndroidEmulatorServiceDeps = {
  /** The lane rows (`lane_android_devices`); `sqlAndroidLaneDeviceRepo(db)` in the app. */
  laneDevices: AndroidLaneDeviceRepo;
  /**
   * ADE's folder for this service's own files: the started-emulators state
   * file, the emulator logs, default screenshots.
   */
  dataDir: string;
  /** The bundled scrcpy server (`resolveScrcpyServerJarPath` or `findScrcpyServerJar`). */
  serverJarPath: string;
  /**
   * The lane's worktree. A screenshot `outPath` resolves against it and must
   * stay inside it; without one, a call that names an `outPath` is refused.
   */
  resolveLaneWorktreePath?: (laneId: string) => string | null;
  logger?: Logger | null;
  /** The SDK the user picked in Settings, read on every use. */
  readSdkSettingPath?: () => string | null;
  env?: AndroidEnv;
  platform?: NodeJS.Platform;
  home?: string;
  discoveryDirs?: readonly string[];
  bootTimeoutMs?: number;
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

/**
 * The started-emulators registry, read from its file on every call.
 *
 * Two services can share one project's file (the desktop's own copy in a dev
 * build and the brain's). A registry that loaded once would write its stale
 * list over the other's starts, and those emulators would stop counting as
 * ADE's. Reading per call keeps both, short of two writes in one instant.
 */
class FileBackedStartedEmulators extends AdeStartedEmulators {
  constructor(private readonly file: string) {
    super(null);
  }

  private fresh(): AdeStartedEmulators {
    return new AdeStartedEmulators(this.file);
  }

  override record(entry: Parameters<AdeStartedEmulators["record"]>[0]): void {
    this.fresh().record(entry);
  }

  override forget(match: Parameters<AdeStartedEmulators["forget"]>[0]): void {
    this.fresh().forget(match);
  }

  override owns(emulator: Parameters<AdeStartedEmulators["owns"]>[0]): boolean {
    return this.fresh().owns(emulator);
  }

  override prune(): void {
    this.fresh().prune();
  }
}

/**
 * The scrcpy server jar for a brain that is not the Electron main process:
 * `<resources>/android/scrcpy-server` when it runs from the packaged app, else
 * the checkout's `apps/desktop/resources/android/scrcpy-server`, found by
 * walking up from `startDir`. Returns the first candidate when none exists, so
 * the stream's error names a real place to look.
 */
export function findScrcpyServerJar(input: { resourcesPath?: string | null; startDir: string }): string {
  const candidates: string[] = [];
  if (input.resourcesPath) candidates.push(path.join(input.resourcesPath, "android", "scrcpy-server"));
  let dir = path.resolve(input.startDir);
  for (;;) {
    candidates.push(path.join(dir, "apps", "desktop", "resources", "android", "scrcpy-server"));
    candidates.push(path.join(dir, "resources", "android", "scrcpy-server"));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]!;
}

const samePath = (a: string, b: string) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);

function isInside(child: string, root: string): boolean {
  const relative = path.relative(root, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** The real path of `target`'s nearest existing ancestor, joined with the missing tail. */
function realPathAllowMissing(target: string): string {
  const missing: string[] = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...missing.reverse());
    } catch {
      const parent = path.dirname(current);
      if (samePath(parent, current)) return path.resolve(target);
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Where an agent's screenshot may go: inside the lane's worktree, after both
 * a lexical check and a real-path check (a symlink inside the worktree can
 * point anywhere). `outPath` comes from agents and other machines, so an
 * unchecked one could overwrite any file the brain can write.
 */
export function containAndroidOutPath(outPath: string, root: string): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, outPath);
  const outside = () => new AndroidEmulatorFailure(
    "ANDROID_PATH_OUTSIDE_LANE",
    `${target} is outside the lane's worktree (${resolvedRoot}). Pick a path inside it, or leave the path out.`,
  );
  if (!isInside(target, resolvedRoot)) throw outside();
  if (fs.existsSync(resolvedRoot) && !isInside(realPathAllowMissing(target), realPathAllowMissing(resolvedRoot))) throw outside();
  return target;
}

/** The services alive in this process; the last one to go stops the shared stream server. */
let liveServices = 0;

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireLaneId(laneId: unknown): string {
  const trimmed = typeof laneId === "string" ? laneId.trim() : "";
  if (!trimmed) throw new Error("laneId is required.");
  return trimmed;
}

function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a number.`);
  return value;
}

/** Width and height from a PNG's IHDR chunk (bytes 16–23), or null for anything else. */
export function readPngSize(buffer: Buffer): { width: number; height: number } | null {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buffer.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** `system-images;…;google_apis_playstore;…` first, then `google_apis`, then the rest. */
function imageTagRank(tag: string): number {
  if (tag === "google_apis_playstore") return 0;
  if (tag === "google_apis") return 1;
  if (tag === "default" || tag === "aosp_atd" || tag === "google_atd") return 2;
  return 3;
}

/** Tags that only fit their own form factor (a watch, a TV, a car, an XR headset). */
const SPECIAL_IMAGE_TAG = /wear|tv|automotive|xr|desktop/iu;

/**
 * The image a new AVD gets when the caller names none: the newest API level
 * for the host ABI, Play Store first within one level. A watch or TV profile
 * takes an image with its own tag; a phone never gets one of those.
 */
export function pickAndroidSystemImage(
  images: readonly AndroidSystemImage[],
  hostAbi: string,
  definition: Pick<AndroidDeviceDefinition, "tagId">,
): AndroidSystemImage | null {
  const wantedTag = definition.tagId?.trim() || null;
  const candidates = images.filter((image) =>
    image.abi === hostAbi
    && (wantedTag && SPECIAL_IMAGE_TAG.test(wantedTag) ? image.tag.includes(wantedTag) : !SPECIAL_IMAGE_TAG.test(image.tag)));
  candidates.sort((a, b) => b.apiLevel - a.apiLevel || imageTagRank(a.tag) - imageTagRank(b.tag) || a.packageId.localeCompare(b.packageId));
  return candidates[0] ?? null;
}

/** `adb shell input text` takes one shell word; spaces are `%s`. */
function shellInputText(text: string): string {
  return `'${text.replace(/ /gu, "%s").replace(/'/gu, "'\\''")}'`;
}

export function createAndroidEmulatorService(deps: AndroidEmulatorServiceDeps): AndroidEmulatorServiceApi {
  const logger = deps.logger ?? null;
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const home = deps.home ?? os.homedir();
  const discoveryDirs = deps.discoveryDirs ?? androidDiscoveryDirs(platform, env, home);
  const bootTimeoutMs = Math.max(deps.bootTimeoutMs ?? ANDROID_BOOT_TIMEOUT_MS, 120_000);
  const now = deps.now ?? (() => new Date());
  const registry = new FileBackedStartedEmulators(path.join(deps.dataDir, "started-emulators.json"));
  const listeners = new Set<(event: AndroidEmulatorEvent) => void>();
  const lanes = new Map<string, LaneState>();
  /** `serial:pid` of emulators already seen booted; booted stays booted for one process. */
  const bootedSeen = new Set<string>();
  /** Ends every adb call this service started, on dispose. */
  const lifetime = new AbortController();
  let lastSdkKey: string | null = null;
  let disposed = false;
  liveServices += 1;

  const platformSupported = platform === "darwin" || platform === "win32" || platform === "linux";
  const unsupportedReason = platformSupported
    ? null
    : `The Android emulator runs on macOS, Windows and Linux, not on ${platform}.`;

  const emit = (event: AndroidEmulatorEvent) => {
    try {
      deps.onEvent?.(event);
    } catch (error) {
      logger?.warn("android.event_forward_failed", { error: messageOf(error) });
    }
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        logger?.warn("android.event_listener_failed", { error: messageOf(error) });
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

  /* ---------- the SDK, read on use ---------- */

  const readSdk = async (): Promise<AndroidSdkStatus> => {
    const sdk = await readAndroidSdkStatus({ settingPath: deps.readSdkSettingPath?.() ?? null, env, platform, home });
    const key = JSON.stringify([sdk.found, sdk.root, sdk.tools.map((tool) => [tool.id, tool.available]), sdk.acceleration.usable]);
    if (lastSdkKey !== null && key !== lastSdkKey) emit({ type: "android.sdk.changed" });
    lastSdkKey = key;
    return sdk;
  };

  type ReadySdk = { sdk: AndroidSdkStatus; root: string; avdHome: string; adbPath: string; emulatorPath: string };

  /** The SDK with adb and the emulator, or the refusal that says what is missing. */
  const requireSdk = async (needs: { emulator: boolean }): Promise<ReadySdk> => {
    if (!platformSupported) throw new AndroidEmulatorFailure("ANDROID_SDK_NOT_FOUND", unsupportedReason!);
    const sdk = await readSdk();
    if (!sdk.found || !sdk.root || !sdk.avdHome) {
      throw new AndroidEmulatorFailure("ANDROID_SDK_NOT_FOUND", "No Android SDK was found on this machine. Install Android Studio or the SDK command-line tools.");
    }
    const paths = androidSdkPaths(sdk.root, platform);
    const tool = (id: "platform-tools" | "emulator") => sdk.tools.find((entry) => entry.id === id);
    const adb = tool("platform-tools");
    if (!adb?.available) {
      throw new AndroidEmulatorFailure("ANDROID_TOOL_MISSING", adb?.detail ?? "Android SDK Platform-Tools (adb) is not installed.");
    }
    if (needs.emulator) {
      const emulator = tool("emulator");
      if (!emulator?.available) {
        throw new AndroidEmulatorFailure("ANDROID_TOOL_MISSING", emulator?.detail ?? "The Android Emulator package is not installed.");
      }
    }
    return { sdk, root: sdk.root, avdHome: sdk.avdHome, adbPath: paths.adb, emulatorPath: paths.emulator };
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
      if (launch && launch.consolePort === emulator.consolePort && sameName(launch.avdName, emulator.avdName)) return true;
    }
    return false;
  };

  const asRunning = async (adbPath: string | null, emulator: AndroidDiscoveredEmulator): Promise<AndroidRunningEmulator> => ({
    ...emulator,
    startedByAde: ownsEmulator(emulator),
    booted: await bootedNow(adbPath, emulator),
  });

  const runningFor = (avdName: string): AndroidDiscoveredEmulator | null =>
    discovered().find((emulator) => sameName(emulator.avdName, avdName)) ?? null;

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
      await androidStream.stopStream(serial);
    } catch (error) {
      logger?.warn("android.stream_stop_failed", { laneId: state.laneId, serial, error: messageOf(error) });
    }
    emit({ type: "android.stream.state", laneId: state.laneId, running: false });
  };

  /* ---------- stop ---------- */

  /**
   * Stops an emulator this process launched, at any point of its boot. Before
   * qemu wrote its discovery file there is no qemu pid yet, so it waits a
   * little for one (or for the launcher to exit) before ending the launcher.
   */
  const stopLaunch = async (launch: AndroidEmulatorLaunch, adbPath: string): Promise<void> => {
    const deadline = Date.now() + 15_000;
    while (!launch.exited()) {
      const found = discovered().find((emulator) =>
        emulator.consolePort === launch.consolePort && sameName(emulator.avdName, launch.avdName));
      if (found) {
        await stopAndroidEmulator({
          adbPath,
          serial: launch.serial,
          consolePort: launch.consolePort,
          avdName: found.avdName,
          pid: found.pid,
          launcherPid: launch.launcherPid,
          registry,
          discoveryDirs,
        });
        return;
      }
      if (Date.now() >= deadline) break;
      await Promise.race([sleep(250), launch.exit]);
    }
    if (!launch.exited()) {
      // No discovery file after 15 s: qemu has not started, so the launcher
      // is the whole emulator (and on macOS and Linux it is qemu itself).
      launch.child.kill();
      await Promise.race([launch.exit, sleep(5_000)]);
    }
    registry.forget({ avdName: launch.avdName, consolePort: launch.consolePort });
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
      await stopAndroidEmulator({
        adbPath,
        serial: emulator.serial,
        consolePort: emulator.consolePort,
        avdName: emulator.avdName,
        pid: emulator.pid,
        launcherPid: state.launch?.consolePort === emulator.consolePort ? state.launch.launcherPid : null,
        registry,
        discoveryDirs,
      });
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
        env: env as NodeJS.ProcessEnv,
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
          logger?.warn("android.failed_boot_stop_failed", { laneId, error: messageOf(stopError) });
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
        : new AndroidEmulatorFailure("ANDROID_EMULATOR_EXITED", `The emulator for ${device.avdName} did not start: ${messageOf(error)}`, logPath);
      state.error = failure.toAndroidEmulatorError();
      logger?.warn("android.emulator_start_failed", { laneId, avdName: device.avdName, code: failure.code, error: failure.message });
      emit({ type: "android.device.state", laneId, state: "crashed" });
      throw failure;
    }
  };

  /* ---------- devices ---------- */

  const assertLaneFree = (laneId: string, avdName: string | null) => {
    const held = deps.laneDevices.get(laneId);
    if (held && !(avdName && sameName(held.avdName, avdName))) {
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
    listAndroidDeviceDefinitions({ sdkRoot: root, systemImageDirs: images.map((image) => image.path), platform, env, home });

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
    return serial && androidStream.status(serial, laneId).running ? serial : null;
  };

  const asStreamFailure = (error: unknown): never => {
    if (error instanceof androidStream.AndroidStreamError) throw new AndroidEmulatorFailure(error.code, error.message);
    throw error;
  };

  const touch = async (serial: string, events: readonly AndroidTouchEvent[]) => {
    for (const event of events) await androidStream.sendTouch(serial, event).catch(asStreamFailure);
  };

  const adbInput = async (adbPath: string, serial: string, args: string[]) => {
    await runAdb(adbPath, ["shell", "input", ...args], { serial, timeoutMs: 15_000, signal: lifetime.signal });
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
      const avds: AndroidAvdListing[] = listAndroidAvds(sdk.avdHome, { running }).map((avd) => ({
        ...avd,
        running: running.find((emulator) => sameName(emulator.avdName, avd.name)) ?? null,
        heldByLaneId: deps.laneDevices.holder(avd.name),
      }));
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
        assertLaneFree(laneId, null);
        const ready = await requireSdk({ emulator: true });
        const images = listAndroidSystemImages(ready.root);
        const definition = definitionsFor(ready.root, images).find((entry) => entry.profile.id === profileId);
        if (!definition) {
          throw new AndroidEmulatorFailure("ANDROID_AVD_NOT_FOUND", `No hardware profile named ${profileId} is on this machine.`);
        }
        const wanted = args.systemImage?.trim() || null;
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
          displayName: args.displayName ?? null,
        });
        deps.laneDevices.set({
          laneId,
          avdName: avd.name,
          origin: "created",
          profileId,
          systemImage: image.packageId,
          createdAt: now().toISOString(),
          adeInstalledPackages: [],
        });
        logger?.info("android.device_created", { laneId, avdName: avd.name, profileId, systemImage: image.packageId });
        emit({ type: "android.inventory.changed" });
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
        assertLaneFree(laneId, avdName);
        assertNotHeldElsewhere(laneId, avdName);
        const ready = await requireSdk({ emulator: false });
        const avd = readAndroidAvd(ready.avdHome, avdName);
        if (!avd) throw new AndroidEmulatorFailure("ANDROID_AVD_NOT_FOUND", `No AVD named ${avdName} is on this machine.`);
        if (!deps.laneDevices.get(laneId)) {
          deps.laneDevices.set({
            laneId,
            avdName: avd.name,
            // A free AVD ADE made is still ADE's to clean up with the lane;
            // only the user's own AVD is never deleted.
            origin: avd.adeCreated ? "created" : "attached",
            profileId: avd.profileId,
            systemImage: null,
            createdAt: now().toISOString(),
            adeInstalledPackages: [],
          });
          emit({ type: "android.inventory.changed" });
        }
        if (args.start === false) return emitDeviceState(laneId);
        return startLocked(laneState(laneId));
      });
    },

    start(args) {
      assertLive();
      const laneId = requireLaneId(args.laneId);
      return serialize(laneId, () => startLocked(laneState(laneId)));
    },

    async stop(args) {
      const laneId = requireLaneId(args.laneId);
      const state = laneState(laneId);
      // A stop during a start does not wait behind the boot: it ends it now,
      // and the start fails with "stopped while it was starting".
      if (state.transient === "starting") {
        state.stopRequested = true;
        state.transient = "stopping";
        emit({ type: "android.device.state", laneId, state: "stopping" });
        if (state.launch && !state.launchStop) {
          const { adbPath } = await requireSdk({ emulator: false });
          state.launchStop = stopLaunch(state.launch, adbPath);
        }
        await state.launchStop?.catch(() => undefined);
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
        const result = await releaseAndroidLaneDevice(laneId, deps.laneDevices, {
          sdkSettingPath: deps.readSdkSettingPath?.() ?? null,
          env,
          platform,
          home,
          discoveryDirs,
          deleteCreated: args.deleteCreated !== false,
          signal: lifetime.signal,
          logger,
        });
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
        deleteAdeAndroidAvd(ready.avdHome, avdName, []);
        logger?.info("android.device_deleted", { avdName });
        emit({ type: "android.inventory.changed" });
        return { deleted: true };
      });
    },

    async startStream(args) {
      assertLive();
      const laneId = requireLaneId(args.laneId);
      const { serial, adbPath } = await requireBooted(laneId);
      const state = laneState(laneId);
      if (state.streamSerial && state.streamSerial !== serial) await stopLaneStream(state);
      const transport = await androidStream.startStream({
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
      const status = androidStream.status(serial, laneId);
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
        ? androidStream.status(serial, laneId)
        : { laneId, running: false, backend: null, transport: null, fps: null };
      // Redacted: the token is only for the viewer that started the stream.
      return { ...status, laneId, transport: null };
    },

    async sendTouch(args) {
      const laneId = requireLaneId(args.laneId);
      if (!Array.isArray(args.events) || args.events.length === 0) return;
      const serial = liveStreamSerial(laneId);
      if (!serial) throw new AndroidEmulatorFailure("ANDROID_NOT_RUNNING", "No live view is running for this lane.");
      await touch(serial, args.events);
    },

    async tap(args) {
      const laneId = requireLaneId(args.laneId);
      const x = finiteNumber(args.x, "x");
      const y = finiteNumber(args.y, "y");
      const serial = liveStreamSerial(laneId);
      if (serial) {
        await touch(serial, [{ action: "down", x, y }, { action: "up", x, y }]);
        return;
      }
      // No viewer is open: an agent's tap goes through `adb shell input`.
      const booted = await requireBooted(laneId);
      await adbInput(booted.adbPath, booted.serial, ["tap", String(Math.round(x)), String(Math.round(y))]);
    },

    async swipe(args) {
      const laneId = requireLaneId(args.laneId);
      const fromX = finiteNumber(args.fromX, "fromX");
      const fromY = finiteNumber(args.fromY, "fromY");
      const toX = finiteNumber(args.toX, "toX");
      const toY = finiteNumber(args.toY, "toY");
      const durationMs = Math.min(10_000, Math.max(0, typeof args.durationMs === "number" && Number.isFinite(args.durationMs) ? args.durationMs : SWIPE_DEFAULT_MS));
      const serial = liveStreamSerial(laneId);
      if (!serial) {
        const booted = await requireBooted(laneId);
        await adbInput(booted.adbPath, booted.serial, [
          "swipe",
          String(Math.round(fromX)), String(Math.round(fromY)),
          String(Math.round(toX)), String(Math.round(toY)),
          String(Math.round(durationMs)),
        ]);
        return;
      }
      const steps = Math.max(1, Math.round(durationMs / SWIPE_STEP_MS));
      await touch(serial, [{ action: "down", x: fromX, y: fromY }]);
      try {
        for (let step = 1; step <= steps; step += 1) {
          await sleep(durationMs / steps);
          const t = step / steps;
          await touch(serial, [{ action: "move", x: fromX + (toX - fromX) * t, y: fromY + (toY - fromY) * t }]);
        }
      } finally {
        // Always lift the finger, or the device keeps a pointer down.
        await touch(serial, [{ action: "up", x: toX, y: toY }]).catch(() => undefined);
      }
    },

    async sendKey(args) {
      const laneId = requireLaneId(args.laneId);
      const key = args.key as AndroidHardwareKey;
      if (!(key in ANDROID_HARDWARE_KEYCODES)) throw new Error(`Unknown Android key ${String(args.key)}.`);
      const serial = liveStreamSerial(laneId);
      if (serial) {
        await androidStream.sendKey(serial, key).catch(asStreamFailure);
        return;
      }
      const booted = await requireBooted(laneId);
      await adbInput(booted.adbPath, booted.serial, ["keyevent", String(ANDROID_HARDWARE_KEYCODES[key])]);
    },

    async sendText(args) {
      const laneId = requireLaneId(args.laneId);
      const text = typeof args.text === "string" ? args.text : "";
      if (!text) return;
      const serial = liveStreamSerial(laneId);
      if (serial) {
        await androidStream.sendText(serial, text).catch(asStreamFailure);
        return;
      }
      const booted = await requireBooted(laneId);
      await adbInput(booted.adbPath, booted.serial, ["text", shellInputText(text)]);
    },

    async screenshot(args) {
      const laneId = requireLaneId(args.laneId);
      const requested = args.outPath?.trim() || null;
      let outPath: string | null = null;
      if (requested) {
        const root = deps.resolveLaneWorktreePath?.(laneId) ?? null;
        if (!root) {
          throw new AndroidEmulatorFailure(
            "ANDROID_PATH_OUTSIDE_LANE",
            "ADE cannot find this lane's worktree, so it will not write a screenshot to a chosen path. Leave the path out.",
          );
        }
        outPath = containAndroidOutPath(requested, root);
      }
      const { serial, adbPath } = await requireBooted(laneId);
      const result = await runAdb(adbPath, ["exec-out", "screencap", "-p"], {
        serial,
        timeoutMs: SCREENSHOT_TIMEOUT_MS,
        signal: lifetime.signal,
      });
      const png = result.stdout;
      const size = readPngSize(png);
      if (!size) throw new Error(`The emulator ${serial} did not return a PNG (${png.length} bytes).`);
      const capturedAt = now();
      const target = outPath
        ?? path.join(deps.dataDir, "screenshots", `${laneId.replace(/[^A-Za-z0-9_-]+/gu, "_")}-${capturedAt.toISOString().replace(/[:.]/gu, "-")}.png`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // Checked again right before the write (a link swapped in during the
      // capture), and the file is opened without following a link.
      if (outPath) containAndroidOutPath(outPath, deps.resolveLaneWorktreePath?.(laneId) ?? path.dirname(outPath));
      const handle = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | (fs.constants.O_NOFOLLOW ?? 0), 0o644);
      try {
        fs.writeSync(handle, png);
      } finally {
        fs.closeSync(handle);
      }
      const shot: AndroidScreenshot = { path: target, width: size.width, height: size.height, bytes: png.length, capturedAt: capturedAt.toISOString() };
      return shot;
    },

    async stopForLane(laneId) {
      const id = laneId?.trim();
      if (!id) return;
      const hadState = lanes.has(id);
      const state = laneState(id);
      if (state.transient === "starting") {
        state.stopRequested = true;
        const sdk = state.launch && !state.launchStop ? await requireSdk({ emulator: false }).catch(() => null) : null;
        if (sdk && state.launch) state.launchStop = stopLaunch(state.launch, sdk.adbPath);
        await state.launchStop?.catch(() => undefined);
      }
      let hadDevice = false;
      await serialize(id, async () => {
        state.stopRequested = false;
        const device = deps.laneDevices.get(id);
        hadDevice = device !== null;
        if (device) await stopLocked(state, device, { refuseForeign: false });
        else await stopLaneStream(state);
      }).catch((error: unknown) => {
        logger?.warn("android.stop_for_lane_failed", { laneId: id, error: messageOf(error) });
      });
      lanes.delete(id);
      if (hadDevice || hadState) emit({ type: "android.device.state", laneId: id, state: hadDevice ? "off" : "none" });
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
      liveServices -= 1;
      lifetime.abort();
      const sdk = await requireSdk({ emulator: false }).catch(() => null);
      await Promise.all([...lanes.values()].map(async (state) => {
        await stopLaneStream(state);
        if (state.transient === "starting" && state.launch && sdk) {
          state.stopRequested = true;
          state.launchStop ??= stopLaunch(state.launch, sdk.adbPath);
          await state.launchStop.catch(() => undefined);
        }
      }));
      if (sdk) {
        // Every emulator ADE started for this project, this run or an earlier
        // one (the state file), and nothing else.
        for (const emulator of discovered()) {
          if (!registry.owns(emulator)) continue;
          await stopAndroidEmulator({
            adbPath: sdk.adbPath,
            serial: emulator.serial,
            consolePort: emulator.consolePort,
            avdName: emulator.avdName,
            pid: emulator.pid,
            launcherPid: [...lanes.values()].find((state) => state.launch?.consolePort === emulator.consolePort)?.launch?.launcherPid ?? null,
            registry,
            discoveryDirs,
          }).catch((error: unknown) => {
            logger?.warn("android.dispose_stop_failed", { serial: emulator.serial, error: messageOf(error) });
          });
        }
      }
      lanes.clear();
      listeners.clear();
      if (liveServices === 0) await androidStream.stopAllStreams().catch(() => undefined);
    },

    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return service;
}
