import type { ChildProcess } from "node:child_process";
import type {
  AppleInstalledRuntime,
  AppleMissingRuntime,
  AppleRuntimeDeleteArgs,
  AppleRuntimeDeleteResult,
  AppleRuntimeEntry,
  AppleRuntimeInstallArgs,
  AppleRuntimeInstallState,
  AppleRuntimeInventory,
  AppleRuntimePruneArgs,
  AppleRuntimeSimulator,
  AppleRuntimeSimulatorDisposition,
  AppleSimulatorDeviceType,
  AppleXcodeStatus,
  IosSimulatorEventPayload,
} from "../../../shared/types/iosSimulator";
import type { Logger } from "../logging/logger";
import { appleDeviceFamily, parseAppleInstalledRuntimes, parseSimctlDevices } from "./appleSimulatorCatalog";
import { appleRuntimeScore, newestAppleRuntimeRunning } from "../../../shared/appleRuntimeVersions";
import { appleRuntimeInstallActive } from "../../../shared/appleRuntimeVersions";

/**
 * Simulator runtimes: list what is installed and what depends on it, fetch the
 * runtime this Xcode expects, and remove old ones.
 *
 * Everything here runs on the machine that owns the lane's simulators; the
 * renderer reaches it through the `ios_simulator` action domain with the
 * lane's pin, so a laptop pinned to a desktop manages the desktop's runtimes.
 *
 * The download is a background job. `runtimeInstall` returns as soon as
 * `xcodebuild -downloadPlatform` starts; progress arrives as
 * `apple.runtime.install` events and in every `runtimeList` answer. That keeps
 * the RPC short however long the 8 GB download takes, and a closed panel does
 * not stop it.
 */

type RunCommand = (
  command: string,
  args: string[],
  options?: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

type SpawnCommand = (command: string, args: string[]) => ChildProcess;

export type AppleRuntimeManagerDeps = {
  run: RunCommand;
  spawn: SpawnCommand;
  emit: (payload: IosSimulatorEventPayload) => void;
  logger: Logger;
  /** Free bytes on the system volume, where CoreSimulator stages runtimes. */
  freeBytes: () => Promise<number | null>;
  /** Simulators a lane of this project holds. */
  laneHeldUdids: () => Set<string>;
  /** ADE made this simulator (marker file or lane row). */
  isAdeSimulator: (udid: string) => boolean;
  /**
   * Power a simulator off the way the service does everywhere else: its
   * recording and streams stop, the helper drops its HID and CoreDevice
   * handles, then `simctl shutdown` (an already-off device is fine). Throws
   * only when the shutdown really failed.
   */
  powerOff: (udid: string) => Promise<void>;
  /** Device lists and statuses changed. */
  invalidate: () => void;
  captureAnalytics?: (outcome: "runtime_installed" | "runtime_removed") => void;
  /** Apple's developer releases feed (`APPLE_RELEASES_FEED_URL`), as text. */
  releasesFeed: () => Promise<string>;
  /** Where the newest-Xcode answer is kept between launches; null keeps it in memory only. */
  store: { getJson: <T>(key: string) => T | null; setJson: (key: string, value: unknown) => void } | null;
  arch?: string;
  now?: () => Date;
};

/* ───────────────────────── parsing (pure) ───────────────────────── */

type RuntimeImage = {
  id: string;
  runtimeIdentifier: string;
  version: string;
  build: string | null;
  sizeBytes: number | null;
  deletable: boolean;
  lastUsedAt: string | null;
};

/** `simctl runtime list -j`: the disk images, keyed by runtime identifier. */
export function parseSimctlRuntimeImages(stdout: string): Map<string, RuntimeImage> {
  const parsed = JSON.parse(stdout) as Record<string, Record<string, unknown>>;
  const images = new Map<string, RuntimeImage>();
  for (const [key, value] of Object.entries(parsed ?? {})) {
    if (!value || typeof value !== "object") continue;
    const runtimeIdentifier = typeof value.runtimeIdentifier === "string" ? value.runtimeIdentifier : null;
    if (!runtimeIdentifier) continue;
    const id = typeof value.identifier === "string" ? value.identifier : key;
    const sizeBytes = typeof value.sizeBytes === "number" && value.sizeBytes > 0 ? value.sizeBytes : null;
    images.set(runtimeIdentifier, {
      id,
      runtimeIdentifier,
      version: typeof value.version === "string" ? value.version : "",
      build: typeof value.build === "string" ? value.build : null,
      sizeBytes,
      deletable: value.deletable !== false,
      lastUsedAt: typeof value.lastUsedAt === "string" ? value.lastUsedAt : null,
    });
  }
  return images;
}

type RuntimeDevice = { udid: string; name: string; state: string; deviceTypeIdentifier: string | null };

/** `simctl list devices --json`, every device (available or not) grouped by the runtime it is on. */
export function parseSimctlDevicesByRuntime(stdout: string): Map<string, RuntimeDevice[]> {
  const byRuntime = new Map<string, RuntimeDevice[]>();
  for (const device of parseSimctlDevices(stdout).values()) {
    const list = byRuntime.get(device.runtimeIdentifier) ?? [];
    list.push({ udid: device.udid, name: device.name, state: device.state, deviceTypeIdentifier: device.deviceTypeIdentifier });
    byRuntime.set(device.runtimeIdentifier, list);
  }
  return byRuntime;
}

type DeviceTypeRecord = AppleSimulatorDeviceType & { productFamily: string; minRuntimeVersion: string | null; maxRuntimeVersion: string | null };

/** `simctl list devicetypes -j`. */
export function parseSimctlDeviceTypes(stdout: string): DeviceTypeRecord[] {
  const parsed = JSON.parse(stdout) as { devicetypes?: Array<Record<string, unknown>> };
  const types: DeviceTypeRecord[] = [];
  for (const type of parsed.devicetypes ?? []) {
    if (typeof type.identifier !== "string" || typeof type.name !== "string") continue;
    const productFamily = typeof type.productFamily === "string" ? type.productFamily : "";
    types.push({
      identifier: type.identifier,
      name: type.name,
      family: appleDeviceFamily({ deviceTypeIdentifier: type.identifier, name: `${productFamily} ${type.name}` }),
      productFamily,
      minRuntimeVersion: typeof type.minRuntimeVersionString === "string" ? type.minRuntimeVersionString : null,
      maxRuntimeVersion: typeof type.maxRuntimeVersionString === "string" ? type.maxRuntimeVersionString : null,
    });
  }
  return types;
}

/** `xcodebuild -showsdks -json`: the iOS simulator SDK version this Xcode builds with (`27.1`). */
export function parseIosSimulatorSdkVersion(stdout: string): string | null {
  const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>;
  let best: string | null = null;
  for (const sdk of Array.isArray(parsed) ? parsed : []) {
    if (sdk.platform !== "iphonesimulator" || typeof sdk.platformVersion !== "string") continue;
    if (!best || appleRuntimeScore(sdk.platformVersion) > appleRuntimeScore(best)) best = sdk.platformVersion;
  }
  return best;
}

/** `xcodebuild -version`: `Xcode 27.1` / `Build version 27A9275`. */
export function parseXcodeVersionOutput(stdout: string): { version: string | null; build: string | null } {
  const version = /Xcode\s+(\d+(?:\.\d+){0,2})/u.exec(stdout)?.[1] ?? null;
  const build = /Build version\s+(\S+)/u.exec(stdout)?.[1] ?? null;
  return { version, build };
}

/** Apple's releases RSS: the newest Xcode, skipping betas and RCs unless asked. */
export function parseLatestXcodeFromReleasesFeed(xml: string, options: { includeBeta?: boolean } = {}): AppleXcodeStatus["latest"] {
  let best: NonNullable<AppleXcodeStatus["latest"]> | null = null;
  const items = xml.split(/<item>/u).slice(1);
  for (const item of items) {
    const title = /<title>([^<]*)<\/title>/u.exec(item)?.[1]?.trim() ?? "";
    const match = /^Xcode\s+(\d+(?:\.\d+){0,2})(?:\s+(beta(?:\s*\d+)?|RC(?:\s*\d+)?))?(?:\s+\(([^)]+)\))?$/iu.exec(title);
    if (!match) continue;
    const beta = Boolean(match[2]);
    if (beta && !options.includeBeta) continue;
    const link = /<link>([^<]*)<\/link>/u.exec(item)?.[1]?.trim() ?? "https://developer.apple.com/xcode/";
    const candidate = { version: match[1]!, build: match[3] ?? null, beta, url: link };
    if (!best || appleRuntimeScore(candidate.version) > appleRuntimeScore(best.version)) best = candidate;
  }
  return best;
}

/**
 * One progress line from `xcodebuild -downloadPlatform`, e.g.
 * `Downloading iOS 27.1 Simulator (24A94425) (arm64): 52.3% (4.1 GB of 7.85 GB)`.
 * Returns the fields that changed, or null for lines that are not progress.
 */
export function parseRuntimeDownloadProgress(line: string): Partial<AppleRuntimeInstallState> | null {
  const body = /^Downloading .+?:\s*(.*)$/u.exec(line.trim())?.[1]?.trim();
  if (body === undefined) return null;
  const progress = /^(\d+(?:\.\d+)?)%\s*\(([^)]+?)\s+of\s+([^)]+?)\)/u.exec(body);
  if (progress) {
    return { phase: "downloading", percent: Number(progress[1]), received: progress[2]!, total: progress[3]! };
  }
  if (/^Preparing/iu.test(body)) return { phase: "preparing" };
  if (/^Installing/iu.test(body)) return { phase: "installing", percent: 100 };
  if (/^Done/iu.test(body)) return { phase: "done", percent: 100 };
  return null;
}

/** `iOS`, `watchOS`, `tvOS` or `visionOS`; anything else is refused before it reaches xcodebuild. */
function normalizePlatform(value: unknown): string {
  if (value === undefined || value === null || value === "") return "iOS";
  if (typeof value === "string" && ["iOS", "watchOS", "tvOS", "visionOS"].includes(value.trim())) return value.trim();
  throw new Error("platform must be iOS, watchOS, tvOS or visionOS.");
}

/** `27.1` or `27.1.2`; anything else is refused before it reaches xcodebuild. */
function normalizeVersion(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "string" && /^\d{1,3}(\.\d{1,3}){1,2}$/u.test(value.trim())) return value.trim();
  throw new Error("version must look like 27.1.");
}

/**
 * Which runtime a model that no installed runtime runs needs, as far as the
 * Mac can tell. There is no local list of downloadable runtimes, so:
 *
 * - A model new in this SDK (its first runtime is the SDK version, the Duo on
 *   Xcode 27.1) needs the SDK's runtime.
 * - A model that an installed runtime it is old enough for does NOT run sits
 *   behind a narrow point release (iOS 27.1 runs only the Duo). It needs the
 *   major's base release, iOS 27.0; that version is pinned for the install.
 * - Otherwise the SDK's version, unpinned: Xcode fetches every runtime its
 *   SDK needs, and the list names the gap again once one is installed.
 */
function runtimeNeededBy(
  type: DeviceTypeRecord,
  installedIos: AppleInstalledRuntime[],
  sdkVersion: string,
): { version: string; installVersion: string | null } {
  const sdkScore = appleRuntimeScore(sdkVersion);
  const minScore = type.minRuntimeVersion ? appleRuntimeScore(type.minRuntimeVersion) : 0;
  if (minScore >= sdkScore) return { version: sdkVersion, installVersion: null };
  const sdkMajor = Math.floor(sdkScore / 1_000_000);
  // Only a point release of the SDK's own major counts: an old iOS 18.6
  // that does not run an iPhone 17 says nothing about iOS 27.
  const narrow = installedIos
    .filter((runtime) => {
      const score = appleRuntimeScore(runtime.version);
      return Math.floor(score / 1_000_000) === sdkMajor && score <= sdkScore && score >= minScore;
    })
    .sort((a, b) => appleRuntimeScore(a.version) - appleRuntimeScore(b.version))[0];
  if (narrow) {
    const major = Math.floor(appleRuntimeScore(narrow.version) / 1_000_000);
    const base = `${major}.0`;
    const baseScore = appleRuntimeScore(base);
    if (baseScore < appleRuntimeScore(narrow.version) && baseScore >= minScore) {
      return { version: base, installVersion: base };
    }
  }
  return { version: sdkVersion, installVersion: null };
}

/* ───────────────────────── the manager ───────────────────────── */

export const APPLE_RUNTIME_ALREADY_INSTALLED_CODE = "APPLE_RUNTIME_ALREADY_INSTALLED";

/** A pinned `runtimes install --version` for a runtime the Mac already has. */
export class AppleRuntimeAlreadyInstalledError extends Error {
  readonly code = APPLE_RUNTIME_ALREADY_INSTALLED_CODE;
  readonly adeExpected = "user" as const;

  constructor(detail: string) {
    super(`${APPLE_RUNTIME_ALREADY_INSTALLED_CODE}: ${detail}`);
    this.name = "AppleRuntimeAlreadyInstalledError";
  }
}

/** Apple's developer releases feed, for the "newer Xcode" note. */
export const APPLE_RELEASES_FEED_URL = "https://developer.apple.com/news/releases/rss/releases.rss";
const APPLE_LATEST_XCODE_KEY = "apple.xcode.latestRelease";
const DAY_MS = 24 * 60 * 60_000;

/** CoreSimulator wants headroom beyond the image itself while it stages and verifies. */
const INSTALL_FREE_BYTES_FLOOR = 10 * 1024 ** 3;
/** At most four progress events a second; xcodebuild prints far more often. */
const PROGRESS_EVENT_INTERVAL_MS = 250;

export type AppleRuntimeManager = ReturnType<typeof createAppleRuntimeManager>;

type InstallListener = { emit: AppleRuntimeManagerDeps["emit"]; invalidate: () => void };

/**
 * One runtime download per MACHINE, not per project: the manager is built by
 * each project's simulator service, but `xcodebuild -downloadPlatform` and
 * its progress belong to the Mac. Every open project's manager registers
 * here, sees the same install, and hears its progress; the download is
 * stopped only when the last of them goes away.
 */
const installer: {
  install: AppleRuntimeInstallState | null;
  child: ChildProcess | null;
  lastEmitAt: number;
  /** Bumped by every new install; a call that wakes to a newer one stands down. */
  generation: number;
  listeners: Set<InstallListener>;
} = { install: null, child: null, lastEmitAt: 0, generation: 0, listeners: new Set() };

export function createAppleRuntimeManager(deps: AppleRuntimeManagerDeps) {
  const now = () => (deps.now ? deps.now() : new Date());
  /**
   * A read that can fail without failing the list (an Xcode mid-update, a
   * missing first-launch package): log the cause, answer the fallback. The
   * panel then shows less, and the log says why.
   */
  const fallingBack = <T,>(event: string, fallback: T) => (error: unknown): T => {
    deps.logger.warn(event, { error: error instanceof Error ? error.message : String(error) });
    return fallback;
  };

  const listener: InstallListener = { emit: deps.emit, invalidate: deps.invalidate };
  installer.listeners.add(listener);
  const invalidateAll = () => {
    for (const each of installer.listeners) each.invalidate();
  };

  const emitInstall = (force = false) => {
    if (!installer.install) return;
    const at = Date.now();
    if (!force && at - installer.lastEmitAt < PROGRESS_EVENT_INTERVAL_MS) return;
    installer.lastEmitAt = at;
    const event = { type: "apple.runtime.install" as const, install: { ...installer.install } };
    for (const each of installer.listeners) each.emit(event);
  };

  const finish = (phase: "done" | "failed" | "cancelled", message: string | null) => {
    if (!installer.install) return;
    installer.install = { ...installer.install, phase, message, finishedAt: now().toISOString() };
    installer.child = null;
    invalidateAll();
    emitInstall(true);
    deps.logger.info("apple.runtime_install_finished", { version: installer.install.version, phase, message });
    if (phase === "done") deps.captureAnalytics?.("runtime_installed");
  };

  const readXcode = async (): Promise<Omit<AppleXcodeStatus, "latest" | "updateAvailable">> => {
    const version = await deps.run("xcodebuild", ["-version"], { timeoutMs: 20_000 })
      .then(({ stdout }) => parseXcodeVersionOutput(stdout))
      .catch(fallingBack("apple.xcode_version_unreadable", { version: null, build: null }));
    // Exit 0 means nothing is pending; anything else (including a missing
    // Xcode) is reported as pending only when an Xcode version was read.
    const firstLaunchPending = version.version
      ? await deps.run("xcodebuild", ["-checkFirstLaunchStatus"], { timeoutMs: 20_000 }).then(() => false, () => true)
      : false;
    return { ...version, firstLaunchPending };
  };

  /**
   * The newest released Xcode, read from Apple's feed at most once a day (kept
   * in the store across launches). A failed read is retried in an hour, not on
   * every list.
   */
  let latestXcodeCache: { at: number; value: AppleXcodeStatus["latest"] } | null = null;
  const latestXcode = async (): Promise<AppleXcodeStatus["latest"]> => {
    if (latestXcodeCache && Date.now() - latestXcodeCache.at < DAY_MS) return latestXcodeCache.value;
    const stored = deps.store?.getJson<{ at: number; value: AppleXcodeStatus["latest"] }>(APPLE_LATEST_XCODE_KEY) ?? null;
    if (stored && typeof stored.at === "number" && Date.now() - stored.at < DAY_MS) {
      latestXcodeCache = stored;
      return stored.value;
    }
    try {
      const value = parseLatestXcodeFromReleasesFeed(await deps.releasesFeed());
      latestXcodeCache = { at: Date.now(), value };
      try {
        deps.store?.setJson(APPLE_LATEST_XCODE_KEY, latestXcodeCache);
      } catch (error) {
        // The in-memory copy still holds for today.
        deps.logger.warn("apple.xcode_latest_not_stored", { error: error instanceof Error ? error.message : String(error) });
      }
      return value;
    } catch (error) {
      deps.logger.debug("apple.xcode_release_feed_failed", { error: error instanceof Error ? error.message : String(error) });
      latestXcodeCache = { at: Date.now() - DAY_MS + 60 * 60_000, value: latestXcodeCache?.value ?? stored?.value ?? null };
      return latestXcodeCache.value;
    }
  };

  const xcodeStatus = async (): Promise<AppleXcodeStatus> => {
    const [local, latest] = await Promise.all([readXcode(), latestXcode()]);
    const updateAvailable = Boolean(local.version && latest
      && appleRuntimeScore(latest.version) > appleRuntimeScore(local.version));
    return { ...local, latest, updateAvailable };
  };

  /**
   * Is a model still current? Xcode lists every model it knows with the range
   * of runtimes that run it; a model whose newest runtime is older than this
   * Xcode's SDK is retired (iPhone Xs stops at iOS 18.99) and keeps no runtime
   * around on its own.
   */
  const isCurrentModel = (type: DeviceTypeRecord | undefined, sdkScore: number | null): boolean =>
    !type || sdkScore === null || !type.maxRuntimeVersion || appleRuntimeScore(type.maxRuntimeVersion) >= sdkScore;

  /**
   * The runtimes, joined with their disk images, the simulators on them, and
   * whether a newer installed runtime makes each one replaceable.
   */
  const readRuntimes = async () => {
    const [runtimesOut, imagesOut, devicesOut, typesOut, sdkOut] = await Promise.all([
      deps.run("xcrun", ["simctl", "list", "runtimes", "--json"], { timeoutMs: 30_000 }),
      deps.run("xcrun", ["simctl", "runtime", "list", "-j"], { timeoutMs: 30_000 })
        .catch(fallingBack("apple.runtime_images_unreadable", { stdout: "{}", stderr: "" })),
      deps.run("xcrun", ["simctl", "list", "devices", "--json"], { timeoutMs: 30_000 }),
      deps.run("xcrun", ["simctl", "list", "devicetypes", "-j"], { timeoutMs: 30_000 })
        .catch(fallingBack("apple.device_types_unreadable", { stdout: "{}", stderr: "" })),
      deps.run("xcodebuild", ["-showsdks", "-json"], { timeoutMs: 30_000 })
        .catch(fallingBack("apple.sdks_unreadable", { stdout: "[]", stderr: "" })),
    ]);
    const installed = parseAppleInstalledRuntimes(runtimesOut.stdout);
    const images = parseSimctlRuntimeImages(imagesOut.stdout);
    const devices = parseSimctlDevicesByRuntime(devicesOut.stdout);
    const types = (() => {
      try {
        return parseSimctlDeviceTypes(typesOut.stdout);
      } catch (error) {
        return fallingBack("apple.device_types_unparsable", [] as DeviceTypeRecord[])(error);
      }
    })();
    const sdkVersion = (() => {
      try {
        return parseIosSimulatorSdkVersion(sdkOut.stdout);
      } catch (error) {
        return fallingBack("apple.sdks_unparsable", null)(error);
      }
    })();
    const sdkScore = sdkVersion ? appleRuntimeScore(sdkVersion) : null;
    const typeById = new Map(types.map((type) => [type.identifier, type]));
    const held = deps.laneHeldUdids();
    const newestByPlatform = new Map<string, string>();
    for (const runtime of installed) {
      const current = newestByPlatform.get(runtime.platform);
      const currentRuntime = current ? installed.find((candidate) => candidate.identifier === current) : null;
      if (!currentRuntime || appleRuntimeScore(runtime.version) > appleRuntimeScore(currentRuntime.version)) {
        newestByPlatform.set(runtime.platform, runtime.identifier);
      }
    }
    const newerRuns = (runtime: AppleInstalledRuntime, typeId: string) => installed.some((other) =>
      other.platform === runtime.platform
      && appleRuntimeScore(other.version) > appleRuntimeScore(runtime.version)
      && other.deviceTypes.some((candidate) => candidate.identifier === typeId));
    const entries = installed.map((runtime): AppleRuntimeEntry => {
      const image = images.get(runtime.identifier) ?? null;
      const simulators: AppleRuntimeSimulator[] = (devices.get(runtime.identifier) ?? []).map((device) => ({
        ...device,
        laneHeld: held.has(device.udid),
        ade: held.has(device.udid) || deps.isAdeSimulator(device.udid),
      }));
      const hasNewer = installed.some((other) => other.platform === runtime.platform
        && appleRuntimeScore(other.version) > appleRuntimeScore(runtime.version));
      // Replaceable when a newer runtime runs every current model it runs and
      // every model one of its simulators uses. iOS 27.0 is never replaceable
      // by iOS 27.1, which runs only the Duo.
      const superseded = hasNewer
        && runtime.deviceTypes
          .filter((type) => isCurrentModel(typeById.get(type.identifier), sdkScore))
          .every((type) => newerRuns(runtime, type.identifier))
        && simulators.every((simulator) => !simulator.deviceTypeIdentifier || newerRuns(runtime, simulator.deviceTypeIdentifier));
      return {
        id: image?.id ?? null,
        runtimeIdentifier: runtime.identifier,
        name: runtime.name,
        platform: runtime.platform,
        version: runtime.version || image?.version || "",
        build: image?.build ?? null,
        sizeBytes: image?.sizeBytes ?? null,
        deletable: Boolean(image?.id) && image?.deletable !== false,
        lastUsedAt: image?.lastUsedAt ?? null,
        newest: newestByPlatform.get(runtime.platform) === runtime.identifier,
        superseded,
        deviceTypes: runtime.deviceTypes,
        simulators,
      };
    });
    return { entries, installed, types, sdkVersion };
  };

  /**
   * What this Xcode can simulate but the Mac cannot yet: the current iPhone and
   * iPad models (they run on this Xcode's SDK version) that no installed
   * runtime runs. Counted per model, not per runtime: with only iOS 27.1
   * installed every iPhone but the Duo is missing, because they need iOS 27.0,
   * so the gap is named "iOS 27.0", not the SDK's 27.1. Models that need
   * different runtimes are grouped per version.
   */
  const missingFrom = (input: { installed: AppleInstalledRuntime[]; types: DeviceTypeRecord[]; sdkVersion: string | null }): AppleMissingRuntime | null => {
    if (!input.sdkVersion) return null;
    const sdkVersion = input.sdkVersion;
    const sdkScore = appleRuntimeScore(sdkVersion);
    const installedIos = input.installed.filter((runtime) => runtime.platform === "iOS");
    const supported = new Set(installedIos.flatMap((runtime) => runtime.deviceTypes.map((type) => type.identifier)));
    const missingTypes = input.types
      .filter((type) => type.productFamily === "iPhone" || type.productFamily === "iPad")
      .filter((type) => !supported.has(type.identifier))
      .filter((type) => !type.minRuntimeVersion || appleRuntimeScore(type.minRuntimeVersion) <= sdkScore)
      .filter((type) => isCurrentModel(type, sdkScore))
      .reverse();
    if (!missingTypes.length) return null;
    const groups = new Map<string, { version: string; installVersion: string | null; deviceTypes: AppleMissingRuntime["deviceTypes"] }>();
    for (const type of missingTypes) {
      const need = runtimeNeededBy(type, installedIos, sdkVersion);
      const group = groups.get(need.version) ?? { version: need.version, installVersion: need.installVersion, deviceTypes: [] };
      group.deviceTypes.push({ identifier: type.identifier, name: type.name, family: type.family });
      groups.set(need.version, group);
    }
    const runtimes = [...groups.values()]
      .sort((a, b) => appleRuntimeScore(a.version) - appleRuntimeScore(b.version))
      .map((group) => ({ ...group, name: `iOS ${group.version}` }));
    return {
      platform: "iOS",
      // The first group's version: what an older renderer pins nothing with
      // and shows; `name` lists every one.
      version: runtimes[0]!.version,
      name: runtimes.map((group) => group.name).join(" and "),
      deviceTypes: runtimes.flatMap((group) => group.deviceTypes),
      runtimes,
    };
  };

  const runtimeList = async (): Promise<AppleRuntimeInventory> => {
    const [read, xcode, freeBytes] = await Promise.all([
      readRuntimes(),
      xcodeStatus(),
      deps.freeBytes().catch(fallingBack("apple.free_space_unreadable", null)),
    ]);
    return { runtimes: read.entries, missing: missingFrom(read), install: installer.install ? { ...installer.install } : null, xcode, freeBytes };
  };

  const installActive = () => appleRuntimeInstallActive(installer.install);

  /** Throws when iOS `version` is already installed, with the install that would help instead. */
  const refuseInstalledPin = async (version: string): Promise<void> => {
    const read = await readRuntimes();
    const score = appleRuntimeScore(version);
    const same = read.installed.find((runtime) => runtime.platform === "iOS" && appleRuntimeScore(runtime.version) === score);
    if (!same) return;
    const runs = same.deviceTypes.map((type) => type.name);
    const runsText = runs.length === 0
      ? "it runs no device model"
      : runs.length <= 3 ? `it runs only ${runs.join(", ")}` : `it runs ${runs.length} models`;
    const missing = missingFrom(read);
    const groups = missing?.runtimes ?? [];
    if (!groups.length) {
      throw new AppleRuntimeAlreadyInstalledError(`iOS ${same.version} is already installed (${runsText}), and every current iPhone and iPad already has a runtime. Nothing to install.`);
    }
    const steps = groups.map((group) => {
      const names = group.deviceTypes.slice(0, 3).map((type) => type.name).join(", ")
        + (group.deviceTypes.length > 3 ? ` and ${group.deviceTypes.length - 3} more` : "");
      const command = group.installVersion && appleRuntimeScore(group.installVersion) !== score
        ? `ade apple runtimes install --version ${group.installVersion}`
        : "ade apple runtimes install (no --version: Xcode fetches what its SDK needs)";
      return `${names} need ${group.name}: run \`${command}\``;
    });
    throw new AppleRuntimeAlreadyInstalledError(`iOS ${same.version} is already installed, and ${runsText}. ${steps.join(". ")}.`);
  };

  const runtimeInstall = async (args: AppleRuntimeInstallArgs = {}): Promise<AppleRuntimeInstallState> => {
    // Guarded on the phase, not on the child: the child only exists after the
    // SDK lookup and the free-space check, and a second call in that window
    // would start a second 8 GB download nothing can cancel.
    if (installer.install && installActive()) return { ...installer.install };
    const platform = normalizePlatform(args.platform);
    // An explicit version pins `-buildVersion`. Without one, Xcode fetches every
    // runtime it needs: Xcode 27.1 needs iOS 27.0 (every iPhone) AND iOS 27.1
    // (only the Duo), and pinning 27.1 alone would leave the other iPhones out.
    const pinnedVersion = normalizeVersion(args.version);
    if (pinnedVersion && platform === "iOS") {
      // xcodebuild answers a pinned version that is already installed with
      // "already downloaded" and nothing else, even when that runtime does
      // not run the models the list calls missing. Refuse up front and name
      // the version they need.
      await refuseInstalledPin(pinnedVersion);
      // The read above awaited: another call may have started the download.
      if (installer.install && installActive()) return { ...installer.install };
    }
    installer.install = {
      platform,
      version: pinnedVersion ?? "",
      phase: "checking",
      percent: null,
      received: null,
      total: null,
      message: null,
      startedAt: now().toISOString(),
      finishedAt: null,
    };
    const generation = ++installer.generation;
    emitInstall(true);
    // Every await below can wake to a cancel, or to a newer install that a
    // cancel let start; either way this call no longer owns the download.
    const superseded = () => installer.generation !== generation || installer.install?.phase === "cancelled";
    const version = pinnedVersion ?? await deps.run("xcodebuild", ["-showsdks", "-json"], { timeoutMs: 30_000 })
      .then(({ stdout }) => parseIosSimulatorSdkVersion(stdout))
      .catch(fallingBack("apple.sdks_unreadable", null));
    if (superseded()) return { ...installer.install! };
    if (!version) {
      finish("failed", "Could not read which iOS runtime this Xcode expects. Open Xcode once, then try again.");
      return { ...installer.install };
    }
    installer.install = { ...installer.install, version };
    emitInstall(true);
    const free = await deps.freeBytes().catch(fallingBack("apple.free_space_unreadable", null));
    // Cancelled (or replaced) while it was checking: never spawn.
    if (superseded()) return { ...installer.install! };
    if (free !== null && free < INSTALL_FREE_BYTES_FLOOR) {
      const gb = (free / 1024 ** 3).toFixed(1);
      finish("failed", `Only ${gb} GB free. A runtime needs about 10 GB while it installs; remove an older runtime first.`);
      return { ...installer.install };
    }
    const commandArgs = ["-downloadPlatform", platform];
    if (pinnedVersion) commandArgs.push("-buildVersion", pinnedVersion);
    if ((deps.arch ?? process.arch) === "arm64") commandArgs.push("-architectureVariant", "arm64");
    deps.logger.info("apple.runtime_install_started", { platform, version });
    const spawned = deps.spawn("xcodebuild", commandArgs);
    installer.child = spawned;
    installer.install = { ...installer.install, phase: "preparing" };
    emitInstall(true);
    let tail = "";
    let lastLine = "";
    const onChunk = (chunk: Buffer | string) => {
      tail += chunk.toString();
      // xcodebuild redraws its progress line with carriage returns.
      const lines = tail.split(/[\r\n]+/u);
      tail = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        lastLine = line.trim();
        const update = parseRuntimeDownloadProgress(line);
        if (!update || !installer.install || installer.child !== spawned) continue;
        installer.install = { ...installer.install, ...update, phase: update.phase === "done" ? "installing" : update.phase ?? installer.install.phase };
        emitInstall(update.phase !== "downloading");
      }
    };
    spawned.stdout?.on("data", onChunk);
    spawned.stderr?.on("data", onChunk);
    spawned.on("error", (error) => {
      if (installer.child !== spawned) return;
      finish("failed", error.message);
    });
    spawned.on("close", (code, signal) => {
      if (installer.child !== spawned) return;
      if (installer.install?.phase === "cancelled") return;
      if (code === 0) finish("done", null);
      else finish("failed", lastLine || `xcodebuild exited with ${signal ?? code}`);
    });
    return { ...installer.install };
  };

  const runtimeInstallCancel = async (): Promise<AppleRuntimeInstallState | null> => {
    if (!installer.install || !installActive()) return installer.install ? { ...installer.install } : null;
    const running = installer.child;
    installer.install = { ...installer.install, phase: "cancelled", message: "Cancelled", finishedAt: now().toISOString() };
    installer.child = null;
    // Still checking: there is no process yet, and the phase stops the spawn.
    if (running) {
      try {
        running.kill("SIGTERM");
      } catch {
        // Already gone.
      }
    }
    invalidateAll();
    emitInstall(true);
    return { ...installer.install };
  };

  /**
   * Move or erase the simulators on `entry`, then delete its disk image.
   *
   * Lane devices always move when a newer runtime runs their model; one that
   * cannot move stops the removal, because erasing a lane's device behind its
   * back would leave the lane pointing at nothing.
   */
  const deleteOne = async (
    entry: AppleRuntimeEntry,
    all: AppleRuntimeEntry[],
    disposition: AppleRuntimeSimulatorDisposition,
    result: AppleRuntimeDeleteResult,
    /** Runtimes this same removal deletes: never a place to move a simulator to. */
    deleting: ReadonlySet<string> = new Set(),
  ) => {
    if (!entry.id || !entry.deletable) {
      result.errors.push({ id: entry.id, udid: null, message: `${entry.name} is part of Xcode and cannot be removed here.` });
      return;
    }
    // The newest newer runtime that runs THIS simulator's model: iOS 27.1 runs
    // only the Duo, so an iPhone 17 on iOS 26.3 moves to iOS 27.0, not 27.1.
    const targetFor = (simulator: AppleRuntimeSimulator): AppleRuntimeEntry | null =>
      newestAppleRuntimeRunning(all, simulator.deviceTypeIdentifier, { after: entry, excluding: deleting });
    // "Move" means move: a simulator no remaining newer runtime runs is never
    // erased behind it. Lane devices always move, so they always count.
    const stuck = entry.simulators.filter((simulator) =>
      (simulator.laneHeld || disposition === "upgrade") && !targetFor(simulator));
    if (stuck.length) {
      result.errors.push({
        id: entry.id,
        udid: stuck[0]!.udid,
        message: stuck.some((simulator) => simulator.laneHeld)
          ? `${stuck.map((simulator) => simulator.name).join(", ")} belongs to a lane and no newer runtime runs its model. Delete it from that lane first.`
          : `No newer runtime runs ${stuck.map((simulator) => simulator.name).join(", ")}, so it cannot move. Remove ${entry.name} again and choose to erase it, or keep the runtime.`,
      });
      return;
    }
    for (const simulator of entry.simulators) {
      const target = targetFor(simulator);
      const move = simulator.laneHeld || (disposition === "upgrade" && target !== null);
      try {
        await deps.powerOff(simulator.udid);
        if (move && target) {
          await deps.run("xcrun", ["simctl", "upgrade", simulator.udid, target.runtimeIdentifier], { timeoutMs: 5 * 60_000 });
          result.moved.push({ udid: simulator.udid, name: simulator.name, to: target.name });
        } else {
          await deps.run("xcrun", ["simctl", "delete", simulator.udid], { timeoutMs: 2 * 60_000 });
          result.erased.push({ udid: simulator.udid, name: simulator.name });
        }
      } catch (error) {
        result.errors.push({ id: entry.id, udid: simulator.udid, message: error instanceof Error ? error.message : String(error) });
      }
    }
    if (result.errors.some((error) => error.id === entry.id)) return;
    try {
      await deps.run("xcrun", ["simctl", "runtime", "delete", entry.id], { timeoutMs: 5 * 60_000 });
      result.deleted.push({ id: entry.id, name: entry.name, sizeBytes: entry.sizeBytes });
      deps.logger.info("apple.runtime_deleted", { id: entry.id, name: entry.name });
    } catch (error) {
      result.errors.push({ id: entry.id, udid: null, message: error instanceof Error ? error.message : String(error) });
    }
  };

  const assertConfirmed = (confirmed: boolean | undefined) => {
    if (confirmed !== true) {
      throw new Error("Removing a simulator runtime is the user's call. Ask them to remove it from the Apple Development panel's Runtimes section, which lists what it will move or erase.");
    }
  };

  const runtimeDelete = async (args: AppleRuntimeDeleteArgs): Promise<AppleRuntimeDeleteResult> => {
    assertConfirmed(args?.confirmedByUser);
    if (typeof args.id !== "string" || !/^[0-9A-Fa-f-]{36}$/u.test(args.id)) {
      throw new Error("Runtime id must be the runtime's UUID, as runtimeList reports it.");
    }
    const { entries } = await readRuntimes();
    const entry = entries.find((candidate) => candidate.id === args.id);
    if (!entry) throw new Error(`No installed runtime has id ${args.id}.`);
    const result: AppleRuntimeDeleteResult = { deleted: [], moved: [], erased: [], errors: [] };
    try {
      await deleteOne(entry, entries, args.simulators === "erase" ? "erase" : "upgrade", result);
    } finally {
      invalidateAll();
    }
    if (result.deleted.length) deps.captureAnalytics?.("runtime_removed");
    return result;
  };

  /** Remove every runtime whose models a newer installed runtime all runs (`superseded`). */
  const runtimePrune = async (args: AppleRuntimePruneArgs): Promise<AppleRuntimeDeleteResult> => {
    assertConfirmed(args?.confirmedByUser);
    const { entries } = await readRuntimes();
    const result: AppleRuntimeDeleteResult = { deleted: [], moved: [], erased: [], errors: [] };
    try {
      const doomed = entries.filter((candidate) => candidate.superseded && candidate.deletable);
      const deleting = new Set(doomed.map((candidate) => candidate.runtimeIdentifier));
      for (const entry of doomed) {
        await deleteOne(entry, entries, args.simulators === "erase" ? "erase" : "upgrade", result, deleting);
      }
    } finally {
      invalidateAll();
    }
    if (result.deleted.length) deps.captureAnalytics?.("runtime_removed");
    return result;
  };

  const xcodeRunFirstLaunch = async (args: { confirmedByUser?: boolean } = {}): Promise<AppleXcodeStatus> => {
    if (args?.confirmedByUser !== true) {
      throw new Error("Xcode's first-launch setup installs system packages. Ask the user to run it from the Apple Development panel.");
    }
    try {
      await deps.run("xcodebuild", ["-runFirstLaunch"], { timeoutMs: 10 * 60_000 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Xcode's setup needs an administrator. Run \`sudo xcodebuild -runFirstLaunch\` in Terminal. (${message})`);
    }
    return xcodeStatus();
  };

  const dispose = () => {
    installer.listeners.delete(listener);
    // Another project still watches this Mac's download: leave it running.
    if (installer.listeners.size > 0) return;
    // The last watcher is gone: stop the download for good. The phase says
    // so (a later manager must not see a running install nobody owns), and
    // the generation bump stops a call still checking from spawning one.
    if (installActive() && installer.install) {
      installer.generation += 1;
      installer.install = { ...installer.install, phase: "cancelled", message: "Stopped when ADE closed the project", finishedAt: now().toISOString() };
    }
    if (installer.child) {
      try {
        installer.child.kill("SIGTERM");
      } catch {
        // Already gone.
      }
      installer.child = null;
    }
  };

  return { runtimeList, runtimeInstall, runtimeInstallCancel, runtimeDelete, runtimePrune, xcodeRunFirstLaunch, dispose };
}
