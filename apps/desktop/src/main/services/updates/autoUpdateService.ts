import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { autoUpdater, type UpdateInfo } from "electron-updater";
import {
  DEFAULT_AUTO_UPDATE_PREFERENCES,
  type AutoUpdateErrorDetails,
  type AutoUpdateErrorKind,
  type AutoUpdateInstallAbortReason,
  type AutoUpdatePhase,
  type AutoUpdatePreferences,
  type AutoUpdateSnapshot,
  type RecentlyInstalledUpdate,
} from "../../../shared/types";
import type { Logger } from "../logging/logger";
import type { ProductAnalyticsService } from "../analytics/productAnalyticsService";
import { readGlobalState, writeGlobalState, type GlobalState } from "../state/globalState";
import {
  classifyUpdateError,
  estimateUpdateRequiredBytes,
  exceedsMacUpdateArtifactLimit,
  finitePositive,
  MAC_UPDATE_ARTIFACT_MAX_BYTES,
  MAC_UPDATE_ARTIFACT_TOO_LARGE_MESSAGE,
  readDiskSpace,
  updateDownloadBytes,
  type DiskSpaceInfo,
} from "./autoUpdateErrors";
import {
  buildGithubReleaseUrl,
  buildReleaseNotesUrl,
  compareUpdateVersions,
  DEFAULT_RELEASE_NOTES_BASE_URL,
  DEFAULT_RELEASE_REPOSITORY,
} from "./autoUpdateVersions";

const DEFAULT_INSTALL_WATCHDOG_MS = 30_000;
// Warn only, never fatal. Squirrel.Mac needs roughly this long just to expand
// and code-sign verify the archive, so killing here loses a coin flip against a
// healthy install — which is exactly the bug this replaced.
const DEFAULT_QUIT_STAGING_SLOW_WARN_MS = 10_000;
// Hard bound while the OS installer may still be staging. Only a genuinely
// wedged handoff should reach this. macOS only: it is long because Squirrel.Mac
// stages in-process and signals when it is done.
const DEFAULT_QUIT_HARD_DEADLINE_MS = 5 * 60_000;
// Everywhere else the installer is an external process (NSIS, AppImage) that
// never emits the staging signal, so the long bound would just hang the app in
// "installing" for five minutes. Nothing stages in-process there, so a short
// bound is correct — and still far more generous than the 10s that broke macOS.
const DEFAULT_QUIT_HARD_DEADLINE_NO_STAGING_MS = 60_000;
// Once staging is done the installer is already running and about to replace
// the bundle, so a process that still has not exited is a real wedge and a
// short bound is safe again.
const DEFAULT_QUIT_POST_STAGING_DEADLINE_MS = 15_000;
const FAILED_INSTALL_CACHE_RESET_ATTEMPTS = 2;
const DEFAULT_AUTO_APPLY_IDLE_MS = 2 * 60_000;
const DEFAULT_AUTO_APPLY_COUNTDOWN_MS = 10_000;
const DEFAULT_AUTO_APPLY_SUPPRESSION_MS = 4 * 60 * 60_000;
const DEFAULT_ACTIVITY_CHECK_MS = 5_000;
const AUTO_UPDATE_PREFERENCE_ANALYTICS_DEDUPE_MS = 24 * 60 * 60_000;
type AutoUpdaterLike = {
  logger: typeof autoUpdater.logger;
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  setFeedURL?: (
    options:
      | { provider: "github"; owner: string; repo: string }
      | { provider: "generic"; url: string },
  ) => void;
  checkForUpdates: () => Promise<unknown>;
  downloadUpdate?: () => Promise<unknown>;
  quitAndInstall: (isSilent?: boolean, isForceRunAfter?: boolean) => void;
  on: (event: string, listener: (...args: any[]) => void) => unknown;
  removeListener: (event: string, listener: (...args: any[]) => void) => unknown;
};

// Electron's own `autoUpdater`, i.e. the Squirrel.Mac binding that
// electron-updater's MacUpdater drives underneath. Its `update-downloaded`
// fires when the OS installer has finished staging the new bundle — the only
// in-process signal that the native handoff actually got somewhere.
type NativeUpdaterLike = {
  on: (event: string, listener: (...args: any[]) => void) => unknown;
  removeListener: (event: string, listener: (...args: any[]) => void) => unknown;
};

function resolveNativeUpdater(): NativeUpdaterLike | null {
  // Resolved through require, NOT a static import, and this is load-bearing:
  // tests mock "electron" as `{ app }`, and a static `import { autoUpdater }`
  // makes vitest throw "No 'autoUpdater' export is defined on the electron
  // mock" before any test body runs. A missing native updater must degrade to
  // "no staging signal", never to a crash.
  try {
    if (typeof require !== "function") return null;
    const electron = require("electron") as { autoUpdater?: NativeUpdaterLike };
    const candidate = electron?.autoUpdater;
    return typeof candidate?.on === "function" ? candidate : null;
  } catch {
    return null;
  }
}

type CreateAutoUpdateServiceArgs = {
  logger: Logger;
  currentVersion: string;
  globalStatePath: string;
  updater?: AutoUpdaterLike;
  beforeQuitAndInstall?: () => void | Promise<void>;
  rollbackQuitAndInstall?: (reason: string) => void | Promise<void>;
  forceQuit?: (args: { blockedPhase: string; blockedMs: number }) => void;
  getRuntimeActivitySummary?: () => Promise<{ idle: boolean }>;
  productAnalyticsService?: Pick<ProductAnalyticsService, "captureInternal">;
  now?: () => string;
  nowMs?: () => number;
  releaseNotesBaseUrl?: string;
  releaseRepository?: string;
  startupDelayMs?: number;
  periodicCheckMs?: number;
  updaterCacheDir?: string;
  installTargetPath?: string;
  getDiskSpace?: (targetPath: string) => DiskSpaceInfo;
  platform?: NodeJS.Platform;
  installWatchdogMs?: number;
  quitStagingSlowWarnMs?: number;
  quitHardDeadlineMs?: number;
  quitPostStagingDeadlineMs?: number;
  nativeUpdater?: NativeUpdaterLike | null;
  autoApplyIdleMs?: number;
  autoApplyCountdownMs?: number;
  autoApplySuppressionMs?: number;
  activityCheckMs?: number;
  autoCheckEnabled?: boolean;
  autoApplyEnabled?: boolean;
};

type UpdateCheckResultLike = {
  downloadPromise?: Promise<unknown> | null;
  updateInfo?: UpdateInfo;
};

type ProgressInfo = {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
};

type PreservedDownloadRetry = {
  version: string;
  releaseNotesUrl: string | null;
};

function normalizeAutoUpdatePreferences(value: unknown): AutoUpdatePreferences {
  const candidate = value && typeof value === "object"
    ? value as Partial<AutoUpdatePreferences>
    : {};
  return {
    automaticInstall: typeof candidate.automaticInstall === "boolean"
      ? candidate.automaticInstall
      : DEFAULT_AUTO_UPDATE_PREFERENCES.automaticInstall,
    onlyWhenIdle: typeof candidate.onlyWhenIdle === "boolean"
      ? candidate.onlyWhenIdle
      : DEFAULT_AUTO_UPDATE_PREFERENCES.onlyWhenIdle,
  };
}

export function createEmptyAutoUpdateSnapshot(currentVersion = ""): AutoUpdateSnapshot {
  return {
    status: "idle",
    currentVersion,
    latestKnownVersion: null,
    version: null,
    progressPercent: null,
    bytesPerSecond: null,
    transferredBytes: null,
    totalBytes: null,
    releaseNotesUrl: null,
    error: null,
    errorDetails: null,
    recentlyInstalled: null,
    parked: null,
    lastInstallFailed: null,
    autoApplyPending: null,
    autoApplySuppressedUntil: null,
  };
}

function isUpdateCheckResultLike(result: unknown): result is UpdateCheckResultLike {
  return Boolean(
    result
    && typeof result === "object"
    && ("downloadPromise" in result || "updateInfo" in result),
  );
}

function extractDownloadPromise(result: unknown): Promise<unknown> | null {
  if (!isUpdateCheckResultLike(result)) return null;
  const downloadPromise = result.downloadPromise;
  return downloadPromise && typeof (downloadPromise as Promise<unknown>).then === "function"
    ? downloadPromise
    : null;
}

function cloneRecentlyInstalledUpdate(
  update: RecentlyInstalledUpdate | null,
): RecentlyInstalledUpdate | null {
  return update ? { ...update } : null;
}

// Backfill missing links and replace stale links from packages that did not
// persist their configured update repository yet.
function withGithubReleaseUrl(
  update: RecentlyInstalledUpdate | null,
  releaseRepository: string,
): RecentlyInstalledUpdate | null {
  if (!update) return null;
  const githubReleaseUrl = buildGithubReleaseUrl(update.version, releaseRepository);
  if (update.githubReleaseUrl === githubReleaseUrl) return update;
  return { ...update, githubReleaseUrl };
}

function cloneSnapshot(snapshot: AutoUpdateSnapshot): AutoUpdateSnapshot {
  return {
    ...snapshot,
    recentlyInstalled: cloneRecentlyInstalledUpdate(snapshot.recentlyInstalled),
    parked: snapshot.parked ? { ...snapshot.parked } : null,
    lastInstallFailed: snapshot.lastInstallFailed ? { ...snapshot.lastInstallFailed } : null,
    autoApplyPending: snapshot.autoApplyPending ? { ...snapshot.autoApplyPending } : null,
  };
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "unknown");
}

function cleanupUpdaterCacheDir(args: {
  updaterCacheDir?: string;
  logger: Logger;
  reason: string;
}): void {
  const rawCacheDir = args.updaterCacheDir?.trim();
  if (!rawCacheDir) return;

  const updaterCacheDir = path.resolve(rawCacheDir);
  if (!fs.existsSync(updaterCacheDir)) return;

  try {
    const entries = fs.readdirSync(updaterCacheDir, { withFileTypes: true });
    let entriesRemoved = 0;
    for (const entry of entries) {
      fs.rmSync(path.join(updaterCacheDir, entry.name), {
        recursive: true,
        force: true,
      });
      entriesRemoved += 1;
    }
    if (entriesRemoved > 0) {
      args.logger.info("autoUpdate.cache_cleaned", {
        reason: args.reason,
        updaterCacheDir,
        entriesRemoved,
      });
    }
  } catch (error) {
    args.logger.warn("autoUpdate.cache_cleanup_failed", {
      reason: args.reason,
      updaterCacheDir,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function reconcilePersistedUpdateState(args: {
  state: GlobalState;
  currentVersion: string;
  now: string;
  releaseNotesBaseUrl: string;
  releaseRepository: string;
}): {
  state: GlobalState;
  changed: boolean;
  recentlyInstalled: RecentlyInstalledUpdate | null;
  cacheCleanupReason: string | null;
  failedInstall: { targetVersion: string; attempt: number } | null;
} {
  const nextState: GlobalState = { ...args.state };
  let changed = false;
  let cacheCleanupReason: string | null = null;
  let failedInstall: { targetVersion: string; attempt: number } | null = null;

  if (
    nextState.recentlyInstalledUpdate
    && nextState.recentlyInstalledUpdate.version !== args.currentVersion
  ) {
    nextState.recentlyInstalledUpdate = undefined;
    changed = true;
  }

  // The counter outlives the launch that recorded it, so the notice has to as
  // well. Without this, one ordinary quit-and-reopen drops lastInstallFailed
  // from the snapshot while the persisted counter still makes the next failure
  // attempt 2 and evicts the cache — the UI would claim a clean slate the
  // policy does not agree with. The renderer only shows it when it matches the
  // version actually being offered, so surfacing it here is safe.
  const persistedFailure = nextState.failedInstallAttempts;
  if (persistedFailure) {
    failedInstall = {
      targetVersion: persistedFailure.targetVersion,
      attempt: persistedFailure.count,
    };
  }

  const pendingInstall = nextState.pendingInstallUpdate;
  if (pendingInstall) {
    const installedTargetOrNewer = compareUpdateVersions(args.currentVersion, pendingInstall.targetVersion) >= 0;
    if (installedTargetOrNewer) {
      nextState.recentlyInstalledUpdate = {
        version: args.currentVersion,
        installedAt: args.now,
        releaseNotesUrl: buildReleaseNotesUrl(args.currentVersion, args.releaseNotesBaseUrl)
          ?? pendingInstall.releaseNotesUrl,
        githubReleaseUrl: buildGithubReleaseUrl(args.currentVersion, args.releaseRepository),
      };
      cacheCleanupReason = "installed";
      nextState.failedInstallAttempts = undefined;
      failedInstall = null;
    } else {
      const previous = nextState.failedInstallAttempts;
      const attempt = previous?.targetVersion === pendingInstall.targetVersion
        ? previous.count + 1
        : 1;
      nextState.failedInstallAttempts = {
        targetVersion: pendingInstall.targetVersion,
        count: attempt,
        lastFailedAt: args.now,
      };
      failedInstall = { targetVersion: pendingInstall.targetVersion, attempt };
      // First failure: the archive passed its checksum before it ever went
      // "ready", so the quit lost a race rather than the bytes being bad.
      // Keeping it turns a retry into a click instead of a fresh download of
      // the whole release. A second failure stops trusting it.
      cacheCleanupReason = attempt >= FAILED_INSTALL_CACHE_RESET_ATTEMPTS
        ? "failed_install"
        : null;
    }
    nextState.pendingInstallUpdate = undefined;
    changed = true;
  }

  const recentlyInstalled = withGithubReleaseUrl(
    cloneRecentlyInstalledUpdate(nextState.recentlyInstalledUpdate ?? null),
    args.releaseRepository,
  );
  if (
    recentlyInstalled
    && nextState.recentlyInstalledUpdate?.githubReleaseUrl !== recentlyInstalled.githubReleaseUrl
  ) {
    nextState.recentlyInstalledUpdate = recentlyInstalled;
    changed = true;
  }

  return {
    state: nextState,
    changed,
    recentlyInstalled,
    cacheCleanupReason,
    failedInstall,
  };
}

function applyUpdateInfo(
  info: Pick<UpdateInfo, "version">,
  releaseNotesBaseUrl: string,
): Partial<AutoUpdateSnapshot> {
  return {
    latestKnownVersion: info.version,
    version: info.version,
    releaseNotesUrl: buildReleaseNotesUrl(info.version, releaseNotesBaseUrl),
    error: null,
    errorDetails: null,
  };
}

export function createAutoUpdateService({
  logger,
  currentVersion,
  globalStatePath,
  updater = autoUpdater as unknown as AutoUpdaterLike,
  beforeQuitAndInstall,
  rollbackQuitAndInstall,
  forceQuit,
  getRuntimeActivitySummary,
  productAnalyticsService,
  now = () => new Date().toISOString(),
  nowMs = () => Date.now(),
  releaseNotesBaseUrl = DEFAULT_RELEASE_NOTES_BASE_URL,
  releaseRepository = DEFAULT_RELEASE_REPOSITORY,
  startupDelayMs = 5_000,
  periodicCheckMs = 30 * 60 * 1_000,
  updaterCacheDir,
  installTargetPath = process.execPath,
  getDiskSpace = readDiskSpace,
  platform = process.platform,
  installWatchdogMs = DEFAULT_INSTALL_WATCHDOG_MS,
  quitStagingSlowWarnMs = DEFAULT_QUIT_STAGING_SLOW_WARN_MS,
  // Only Squirrel.Mac reports staging progress; electron-updater's other
  // backends never touch the native updater, so arming the long bound off a
  // signal that cannot arrive would strand the app in "installing".
  nativeUpdater = process.platform === "darwin" ? resolveNativeUpdater() : null,
  quitHardDeadlineMs = nativeUpdater
    ? DEFAULT_QUIT_HARD_DEADLINE_MS
    : DEFAULT_QUIT_HARD_DEADLINE_NO_STAGING_MS,
  quitPostStagingDeadlineMs = DEFAULT_QUIT_POST_STAGING_DEADLINE_MS,
  autoApplyIdleMs = DEFAULT_AUTO_APPLY_IDLE_MS,
  autoApplyCountdownMs = DEFAULT_AUTO_APPLY_COUNTDOWN_MS,
  autoApplySuppressionMs = DEFAULT_AUTO_APPLY_SUPPRESSION_MS,
  activityCheckMs = DEFAULT_ACTIVITY_CHECK_MS,
  autoCheckEnabled = true,
  autoApplyEnabled = autoCheckEnabled && process.env.ADE_DISABLE_AUTO_UPDATE_APPLY !== "1",
}: CreateAutoUpdateServiceArgs) {
  updater.logger = null;
  // Manual download is required so ADE can preflight the updater cache volume
  // after discovering the artifact size but before bytes are written.
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  try {
    // Dev/test override: ADE_UPDATE_FEED_URL points the updater at a local/staging
    // feed (generic provider) instead of the GitHub release feed. Used to exercise
    // the real Install-update flow against a local server. Unset in production.
    // Defense-in-depth: only honor the override in non-packaged (dev/test) builds so
    // a packaged app can never be redirected to an attacker-controlled feed.
    const overrideFeedUrl = !app.isPackaged ? process.env.ADE_UPDATE_FEED_URL?.trim() : undefined;
    if (overrideFeedUrl) {
      updater.setFeedURL?.({ provider: "generic", url: overrideFeedUrl });
      logger.info("autoUpdate.feed_override", { url: overrideFeedUrl });
    }
    // Packaged builds intentionally keep electron-builder's generated
    // app-update.yml as the sole update-feed authority. Calling setFeedURL here
    // would silently replace build-time repository configuration.
  } catch (error) {
    logger.warn("autoUpdate.feed_config_failed", {
      message: formatErrorMessage(error),
    });
  }

  const initialState = reconcilePersistedUpdateState({
    state: readGlobalState(globalStatePath),
    currentVersion,
    now: now(),
    releaseNotesBaseUrl,
    releaseRepository,
  });
  if (initialState.changed) {
    writeGlobalState(globalStatePath, initialState.state);
  }
  if (initialState.cacheCleanupReason) {
    cleanupUpdaterCacheDir({
      updaterCacheDir,
      logger,
      reason: initialState.cacheCleanupReason,
    });
  }
  if (initialState.failedInstall) {
    // Relaunching on the old version after an install was requested means the
    // handoff never landed. Say so plainly: silently re-offering the same
    // update is what made this look like the update "did nothing".
    logger.error("autoUpdate.install_did_not_land", {
      targetVersion: initialState.failedInstall.targetVersion,
      currentVersion,
      attempt: initialState.failedInstall.attempt,
      downloadPreserved: initialState.cacheCleanupReason == null,
    });
    productAnalyticsService?.captureInternal({
      event: "ade_update_install_did_not_land",
      surface: "desktop",
      properties: { attempt: initialState.failedInstall.attempt },
    });
  }

  let autoUpdatePreferences = normalizeAutoUpdatePreferences(
    initialState.state.autoUpdatePreferences,
  );
  let snapshot: AutoUpdateSnapshot = {
    ...createEmptyAutoUpdateSnapshot(currentVersion),
    recentlyInstalled: initialState.recentlyInstalled,
    lastInstallFailed: initialState.failedInstall,
  };
  let checkPromise: Promise<unknown> | null = null;
  // In-flight guard for quitAndInstall. Two IPC callers (e.g. AutoUpdateControl
  // double-click, or a renderer click that races a menu trigger) can both
  // reach the await on refreshReadyUpdateBeforeInstall before either of them
  // calls updater.quitAndInstall. Mirror the checkPromise pattern: the first
  // call sets this; subsequent calls return the same promise so we never
  // race the actual install.
  let quitAndInstallPromise: Promise<boolean> | null = null;
  let installReadySnapshot: AutoUpdateSnapshot | null = null;
  let ignoredDownloadVersion: string | null = null;
  let readyRefreshInProgress = false;
  const readyRefreshFailure: {
    current: { error: unknown; phase: AutoUpdatePhase } | null;
  } = { current: null };
  let currentPhase: AutoUpdatePhase = "download";
  let compressedUpdateBytes: number | null = null;
  let compressedUpdateVersion: string | null = null;
  let preservedDownloadRetry: PreservedDownloadRetry | null = null;
  let escalationTimer: ReturnType<typeof setTimeout> | null = null;
  let stagingSlowWarnTimer: ReturnType<typeof setTimeout> | null = null;
  let quitArmedAtMs: number | null = null;
  let nativeStagingCompleted = false;
  let detachNativeStagingListener: (() => void) | null = null;
  let autoApplyScheduleTimer: ReturnType<typeof setTimeout> | null = null;
  let autoApplyDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let idleSinceMs: number | null = null;
  let installQuitArmed = false;
  let activityCheckFailed = false;
  let activityCheckInProgress = false;
  const listeners = new Set<(snapshot: AutoUpdateSnapshot) => void>();

  function emit(): void {
    const nextSnapshot = cloneSnapshot(snapshot);
    for (const listener of listeners) {
      listener(nextSnapshot);
    }
  }

  function patchSnapshot(partial: Partial<AutoUpdateSnapshot>): void {
    const previousStatus = snapshot.status;
    let nextSnapshot = { ...snapshot, ...partial };
    if (nextSnapshot.status !== "ready") {
      resetAutoApplyTracking(false);
      nextSnapshot = { ...nextSnapshot, autoApplyPending: null };
    }
    snapshot = nextSnapshot;
    emit();
    if (snapshot.status === "ready" && previousStatus !== "ready") {
      scheduleAutoApply(0);
    }
  }

  function clearPendingInstallUpdate(): void {
    const currentState = readGlobalState(globalStatePath);
    if (!currentState.pendingInstallUpdate) return;
    writeGlobalState(globalStatePath, {
      ...currentState,
      pendingInstallUpdate: undefined,
    });
  }

  function clearQuitDeadline(): void {
    if (escalationTimer) {
      clearTimeout(escalationTimer);
      escalationTimer = null;
    }
    if (stagingSlowWarnTimer) {
      clearTimeout(stagingSlowWarnTimer);
      stagingSlowWarnTimer = null;
    }
    detachNativeStagingListener?.();
    detachNativeStagingListener = null;
    quitArmedAtMs = null;
    nativeStagingCompleted = false;
  }

  function clearAutoApplyDeadline(): void {
    if (!autoApplyDeadlineTimer) return;
    clearTimeout(autoApplyDeadlineTimer);
    autoApplyDeadlineTimer = null;
  }

  function clearAutoApplySchedule(): void {
    if (!autoApplyScheduleTimer) return;
    clearTimeout(autoApplyScheduleTimer);
    autoApplyScheduleTimer = null;
  }

  function rememberUpdateSize(info: UpdateInfo | null | undefined): void {
    if (!info) return;
    const nextSize = updateDownloadBytes(info);
    if (compressedUpdateVersion !== info.version) {
      compressedUpdateVersion = info.version;
      compressedUpdateBytes = nextSize;
      return;
    }
    compressedUpdateBytes = nextSize ?? compressedUpdateBytes;
  }

  function readReadyRefreshFailure(): { error: unknown; phase: AutoUpdatePhase } | null {
    return readyRefreshFailure.current;
  }

  function shouldPreserveDownloadedUpdate(
    kind: AutoUpdateErrorKind,
    phase: AutoUpdatePhase,
  ): boolean {
    return phase !== "download"
      && (kind === "insufficient_space" || kind === "disk_full" || kind === "quota" || kind === "permission" || kind === "installer");
  }

  function setErrorSnapshot(args: {
    error: unknown;
    fallbackPhase: AutoUpdatePhase;
    capacity?: Pick<AutoUpdateErrorDetails, "availableBytes" | "requiredBytes" | "volumePath">;
    message?: string;
    preservesDownload?: boolean;
    preservedUpdate?: PreservedDownloadRetry;
  }): void {
    const classified = classifyUpdateError(args.error, args.fallbackPhase);
    const message = args.message ?? formatErrorMessage(args.error);
    const preservesDownload = args.preservesDownload
      ?? shouldPreserveDownloadedUpdate(classified.kind, classified.phase);
    let capacity = args.capacity;
    if (
      !capacity
      && (classified.kind === "insufficient_space" || classified.kind === "disk_full" || classified.kind === "quota")
    ) {
      try {
        const targetPath = classified.phase === "download"
          ? updaterCacheDir ?? path.dirname(globalStatePath)
          : installTargetPath;
        const disk = getDiskSpace(targetPath);
        capacity = {
          availableBytes: disk.availableBytes,
          requiredBytes: estimateUpdateRequiredBytes(
            classified.phase === "download" ? "download" : "install",
            compressedUpdateBytes,
          ),
          volumePath: disk.volumePath,
        };
      } catch {
        // Preserve the original updater failure when a follow-up probe fails.
      }
    }
    const details: AutoUpdateErrorDetails = {
      kind: classified.kind,
      phase: classified.phase,
      message,
      availableBytes: capacity?.availableBytes ?? null,
      requiredBytes: capacity?.requiredBytes ?? null,
      volumePath: capacity?.volumePath ?? null,
      preservesDownload,
    };
    if (!preservesDownload) {
      cleanupUpdaterCacheDir({
        updaterCacheDir,
        logger,
        reason: classified.kind === "verification" || classified.kind === "signature"
          ? "unsafe_update_error"
          : "error",
      });
    }
    patchSnapshot({
      status: "error",
      error: message,
      errorDetails: details,
      progressPercent: null,
      bytesPerSecond: null,
      transferredBytes: null,
      totalBytes: null,
      ...(args.preservedUpdate ?? {}),
    });
  }

  function preservedUpdateForRetryError(error: unknown): PreservedDownloadRetry | null {
    if (!preservedDownloadRetry || snapshot.status !== "checking") return null;
    if (
      snapshot.version
      && compareUpdateVersions(snapshot.version, preservedDownloadRetry.version) > 0
    ) {
      return null;
    }
    const { kind } = classifyUpdateError(error, currentPhase);
    return kind === "signature" || kind === "verification" ? null : preservedDownloadRetry;
  }

  // Squirrel.Mac crashes the app on an oversized archive rather than failing the
  // install, so this refuses the download outright instead of handing the bytes
  // to a code path that cannot survive them.
  function preflightArtifactSize(): boolean {
    if (!exceedsMacUpdateArtifactLimit(platform, compressedUpdateBytes)) return true;
    logger.error("autoUpdate.artifact_too_large", {
      version: snapshot.version,
      compressedUpdateBytes,
      maxBytes: MAC_UPDATE_ARTIFACT_MAX_BYTES,
    });
    setErrorSnapshot({
      error: new Error(MAC_UPDATE_ARTIFACT_TOO_LARGE_MESSAGE),
      fallbackPhase: "download",
      message: MAC_UPDATE_ARTIFACT_TOO_LARGE_MESSAGE,
      preservesDownload: false,
    });
    return false;
  }

  function preflightSpace(
    phase: "download" | "install",
    targetPath: string,
  ): boolean {
    const requiredBytes = estimateUpdateRequiredBytes(phase, compressedUpdateBytes);
    try {
      const disk = getDiskSpace(targetPath);
      logger.info("autoUpdate.space_preflight", {
        phase,
        targetPath,
        volumePath: disk.volumePath,
        availableBytes: disk.availableBytes,
        requiredBytes,
        compressedUpdateBytes,
      });
      if (disk.availableBytes >= requiredBytes) return true;
      const error = new Error("Not enough space to update ADE.");
      setErrorSnapshot({
        error,
        fallbackPhase: phase,
        capacity: {
          availableBytes: disk.availableBytes,
          requiredBytes,
          volumePath: disk.volumePath,
        },
        message: "Not enough space to update ADE.",
        preservesDownload: phase === "install",
      });
      return false;
    } catch (error) {
      // A failed capacity probe should not block updates. Runtime ENOSPC/EDQUOT
      // errors remain classified if the updater later encounters them.
      logger.warn("autoUpdate.space_preflight_failed", {
        phase,
        targetPath,
        message: formatErrorMessage(error),
      });
      return true;
    }
  }

  function isTerminalSnapshotStatus(): boolean {
    return snapshot.status === "ready" || snapshot.status === "installing";
  }

  function preservedOrIdlePatch(idleStatus: AutoUpdateSnapshot["status"]): Partial<AutoUpdateSnapshot> {
    if (isTerminalSnapshotStatus()) {
      return {
        status: snapshot.status,
        latestKnownVersion: snapshot.latestKnownVersion,
        version: snapshot.version,
        progressPercent: snapshot.progressPercent,
        bytesPerSecond: snapshot.bytesPerSecond,
        transferredBytes: snapshot.transferredBytes,
        totalBytes: snapshot.totalBytes,
        releaseNotesUrl: snapshot.releaseNotesUrl,
        error: null,
        errorDetails: null,
        parked: snapshot.parked,
        autoApplyPending: snapshot.autoApplyPending,
        autoApplySuppressedUntil: snapshot.autoApplySuppressedUntil,
      };
    }
    return {
      status: idleStatus,
      latestKnownVersion: snapshot.latestKnownVersion,
      version: null,
      progressPercent: null,
      bytesPerSecond: null,
      transferredBytes: null,
      totalBytes: null,
      releaseNotesUrl: null,
      error: null,
      errorDetails: null,
      parked: null,
      autoApplyPending: null,
    };
  }

  const onCheckingForUpdate = () => {
    logger.info("autoUpdate.checking");
    currentPhase = "download";
    patchSnapshot(preservedOrIdlePatch("checking"));
  };

  const onUpdateAvailable = (info: UpdateInfo) => {
    logger.info("autoUpdate.update_available", { version: info.version });
    if (snapshot.status === "ready" && snapshot.version) {
      const comparison = compareUpdateVersions(info.version, snapshot.version);
      if (comparison <= 0) {
        ignoredDownloadVersion = info.version;
        logger.info("autoUpdate.update_available_ignored", {
          version: info.version,
          readyVersion: snapshot.version,
          reason: comparison === 0 ? "same_ready_version" : "older_than_ready_version",
        });
        return;
      }
      if (!readyRefreshInProgress) {
        cleanupUpdaterCacheDir({
          updaterCacheDir,
          logger,
          reason: "superseded_ready_update",
        });
      }
    }
    ignoredDownloadVersion = null;
    rememberUpdateSize(info);
    patchSnapshot({
      status: "checking",
      parked: null,
      autoApplyPending: null,
      progressPercent: null,
      bytesPerSecond: null,
      transferredBytes: null,
      totalBytes: compressedUpdateBytes,
      ...applyUpdateInfo(info, releaseNotesBaseUrl),
    });
  };

  const onDownloadProgress = (info: ProgressInfo) => {
    if (ignoredDownloadVersion) return;
    currentPhase = "download";
    compressedUpdateBytes = finitePositive(info.total) ?? compressedUpdateBytes;
    compressedUpdateVersion = snapshot.version;
    patchSnapshot({
      status: "downloading",
      progressPercent: info.percent,
      bytesPerSecond: info.bytesPerSecond,
      transferredBytes: info.transferred,
      totalBytes: info.total,
      error: null,
      errorDetails: null,
    });
  };

  const onUpdateDownloaded = (info: UpdateInfo) => {
    logger.info("autoUpdate.update_downloaded", { version: info.version });
    if (snapshot.version && compareUpdateVersions(info.version, snapshot.version) < 0) {
      logger.info("autoUpdate.update_downloaded_ignored", {
        version: info.version,
        readyVersion: snapshot.version,
        reason: "older_than_ready_version",
      });
      if (ignoredDownloadVersion === info.version) ignoredDownloadVersion = null;
      return;
    }
    if (ignoredDownloadVersion === info.version) {
      rememberUpdateSize(info);
      logger.info("autoUpdate.update_downloaded_ignored", {
        version: info.version,
        readyVersion: snapshot.version,
        reason: "ignored_ready_version",
      });
      ignoredDownloadVersion = null;
      return;
    }
    rememberUpdateSize(info);
    patchSnapshot({
      status: "ready",
      parked: null,
      autoApplyPending: null,
      progressPercent: 100,
      bytesPerSecond: null,
      transferredBytes: null,
      totalBytes: null,
      ...applyUpdateInfo(info, releaseNotesBaseUrl),
    });
  };

  const onUpdateNotAvailable = (info?: UpdateInfo) => {
    logger.info("autoUpdate.update_not_available");
    if (info?.version) {
      patchSnapshot({ latestKnownVersion: info.version });
    }
    if (!isTerminalSnapshotStatus()) {
      compressedUpdateBytes = null;
      compressedUpdateVersion = null;
      cleanupUpdaterCacheDir({
        updaterCacheDir,
        logger,
        reason: "not_available",
      });
    }
    patchSnapshot(preservedOrIdlePatch("idle"));
  };

  const onUpdateCancelled = (info: UpdateInfo) => {
    logger.warn("autoUpdate.update_cancelled", { version: info.version });
    ignoredDownloadVersion = null;
    compressedUpdateBytes = null;
    compressedUpdateVersion = null;
    cleanupUpdaterCacheDir({
      updaterCacheDir,
      logger,
      reason: "cancelled",
    });
    patchSnapshot({
      ...createEmptyAutoUpdateSnapshot(currentVersion),
      latestKnownVersion: snapshot.latestKnownVersion ?? info.version,
      recentlyInstalled: snapshot.recentlyInstalled,
      autoApplySuppressedUntil: snapshot.autoApplySuppressedUntil,
    });
  };

  const onError = (err: unknown) => {
    const message = formatErrorMessage(err);
    const classified = classifyUpdateError(err, currentPhase);
    logger.warn("autoUpdate.error", {
      message,
      kind: classified.kind,
      phase: classified.phase,
    });
    ignoredDownloadVersion = null;
    if (readyRefreshInProgress) {
      readyRefreshFailure.current = {
        error: err,
        phase: snapshot.status === "downloading" ? "download" : "verification",
      };
      return;
    }
    if (snapshot.status === "installing") {
      clearPendingInstallUpdate();
      clearQuitDeadline();
      installQuitArmed = false;
      void abortInstall("handoff_failed", installReadySnapshot ?? snapshot);
      return;
    }
    const preservedUpdate = preservedUpdateForRetryError(err);
    setErrorSnapshot({
      error: err,
      fallbackPhase: currentPhase,
      preservesDownload: preservedUpdate ? true : undefined,
      preservedUpdate: preservedUpdate ?? undefined,
    });
  };

  updater.on("checking-for-update", onCheckingForUpdate);
  updater.on("update-available", onUpdateAvailable);
  updater.on("download-progress", onDownloadProgress);
  updater.on("update-downloaded", onUpdateDownloaded);
  updater.on("update-not-available", onUpdateNotAvailable);
  updater.on("update-cancelled", onUpdateCancelled);
  updater.on("error", onError);

  async function runUpdateCheck(args: { allowReady?: boolean } = {}): Promise<void> {
    if (checkPromise) {
      await checkPromise;
      return;
    }
    if (
      snapshot.status === "checking"
      || snapshot.status === "downloading"
      || snapshot.status === "installing"
      || (!args.allowReady && snapshot.status === "ready")
    ) {
      return;
    }
    const reusableDownloadedVersion = snapshot.status === "error"
      && snapshot.errorDetails?.preservesDownload
      ? snapshot.version
      : null;
    preservedDownloadRetry = reusableDownloadedVersion
      ? { version: reusableDownloadedVersion, releaseNotesUrl: snapshot.releaseNotesUrl }
      : null;
    checkPromise = updater.checkForUpdates()
      .then(async (result) => {
        const updateInfo = isUpdateCheckResultLike(result) ? result.updateInfo : undefined;
        if (
          updateInfo
          && (!snapshot.version || compareUpdateVersions(updateInfo.version, snapshot.version) >= 0)
        ) {
          rememberUpdateSize(updateInfo);
        }
        if (updateInfo?.version) {
          patchSnapshot({ latestKnownVersion: updateInfo.version });
        }
        if (snapshot.status === "ready" || ignoredDownloadVersion) {
          ignoredDownloadVersion = null;
          return;
        }
        if (snapshot.version) {
          const downloadTarget = updaterCacheDir ?? path.dirname(globalStatePath);
          const reusesPreservedDownload = reusableDownloadedVersion === snapshot.version;
          if (!preflightArtifactSize()) return;
          if (!reusesPreservedDownload && !preflightSpace("download", downloadTarget)) return;
          currentPhase = "download";
          patchSnapshot({
            status: "downloading",
            progressPercent: 0,
            totalBytes: compressedUpdateBytes,
            error: null,
            errorDetails: null,
          });
          if (updater.downloadUpdate) {
            await updater.downloadUpdate();
            return;
          }
        }
        const downloadPromise = extractDownloadPromise(result);
        if (downloadPromise) {
          await downloadPromise;
        }
      })
      .catch((error) => {
        if (readyRefreshInProgress) {
          readyRefreshFailure.current = {
            error,
            phase: snapshot.status === "downloading" ? "download" : "verification",
          };
          return;
        }
        // electron-updater normally emits `error` as well as rejecting. Keep
        // this fallback so synchronous filesystem failures cannot disappear.
        if (snapshot.status !== "error") {
          const preservedUpdate = preservedUpdateForRetryError(error);
          setErrorSnapshot({
            error,
            fallbackPhase: currentPhase,
            preservesDownload: preservedUpdate ? true : undefined,
            preservedUpdate: preservedUpdate ?? undefined,
          });
        }
      })
      .finally(() => {
        checkPromise = null;
        preservedDownloadRetry = null;
      });
    await checkPromise;
  }

  function checkForUpdates(): void {
    void runUpdateCheck();
  }

  async function refreshReadyUpdateBeforeInstall(): Promise<boolean> {
    if (snapshot.status !== "ready" || !snapshot.version) return false;
    const readyVersion = snapshot.version;
    logger.info("autoUpdate.refresh_ready_before_install", { version: readyVersion });
    readyRefreshInProgress = true;
    readyRefreshFailure.current = null;
    try {
      await runUpdateCheck({ allowReady: true });
    } finally {
      readyRefreshInProgress = false;
    }
    const refreshFailure = readReadyRefreshFailure();
    if (refreshFailure) {
      const failureMessage = formatErrorMessage(refreshFailure.error);
      logger.warn("autoUpdate.refresh_ready_before_install_failed", {
        version: readyVersion,
        message: failureMessage,
      });
      return false;
    }
    if (snapshot.status === "ready" && snapshot.version) {
      logger.info("autoUpdate.refresh_ready_before_install_completed", {
        previousVersion: readyVersion,
        version: snapshot.version,
      });
    }
    return snapshot.status === "ready" && Boolean(snapshot.version);
  }

  async function waitForInstallStep<T>(
    task: Promise<T>,
    phase: AutoUpdatePhase,
    timeoutMessage: string,
  ): Promise<{ completed: true; value: T } | { completed: false }> {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const timeoutResult = new Promise<{ completed: false }>((resolve) => {
      timeout = setTimeout(() => {
        logger.warn("autoUpdate.install_step_timed_out", {
          phase,
          installWatchdogMs,
          message: timeoutMessage,
        });
        resolve({ completed: false });
      }, installWatchdogMs);
    });
    const taskResult = task.then((value) => ({ completed: true as const, value }));
    try {
      return await Promise.race([taskResult, timeoutResult]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  function resetAutoApplyTracking(clearPending: boolean): void {
    clearAutoApplySchedule();
    clearAutoApplyDeadline();
    idleSinceMs = null;
    if (clearPending && snapshot.autoApplyPending) {
      patchSnapshot({ autoApplyPending: null });
    }
  }

  function scheduleActivityCheck(delayMs: number): void {
    if (
      !autoApplyEnabled
      || !autoUpdatePreferences.automaticInstall
      || !autoUpdatePreferences.onlyWhenIdle
      || !getRuntimeActivitySummary
      || snapshot.status !== "ready"
      || quitAndInstallPromise != null
      || installQuitArmed
      || activityCheckInProgress
      || autoApplyScheduleTimer
    ) {
      return;
    }
    autoApplyScheduleTimer = setTimeout(() => {
      autoApplyScheduleTimer = null;
      void checkAutoApplyActivity();
    }, Math.max(0, delayMs));
    autoApplyScheduleTimer.unref?.();
  }

  function armAutoApplyCountdown(deadlineAt = nowMs() + autoApplyCountdownMs): void {
    if (snapshot.autoApplyPending || autoApplyDeadlineTimer) return;
    patchSnapshot({ autoApplyPending: { deadlineAt } });
    autoApplyDeadlineTimer = setTimeout(() => {
      autoApplyDeadlineTimer = null;
      void applyAutoUpdateAtDeadline(deadlineAt);
    }, autoApplyCountdownMs);
    autoApplyDeadlineTimer.unref?.();
  }

  function scheduleAutomaticInstallCountdown(delayMs: number): void {
    if (
      !autoApplyEnabled
      || !autoUpdatePreferences.automaticInstall
      || autoUpdatePreferences.onlyWhenIdle
      || snapshot.status !== "ready"
      || quitAndInstallPromise != null
      || installQuitArmed
      || autoApplyScheduleTimer
      || snapshot.autoApplyPending
    ) {
      return;
    }
    autoApplyScheduleTimer = setTimeout(() => {
      autoApplyScheduleTimer = null;
      if (
        !autoApplyEnabled
        || !autoUpdatePreferences.automaticInstall
        || autoUpdatePreferences.onlyWhenIdle
        || snapshot.status !== "ready"
        || quitAndInstallPromise != null
        || installQuitArmed
      ) {
        return;
      }
      const suppressedUntil = snapshot.autoApplySuppressedUntil;
      const currentMs = nowMs();
      if (suppressedUntil != null && suppressedUntil > currentMs) {
        scheduleAutoApply(suppressedUntil - currentMs);
        return;
      }
      if (suppressedUntil != null) {
        patchSnapshot({ autoApplySuppressedUntil: null });
      }
      armAutoApplyCountdown();
    }, Math.max(0, delayMs));
    autoApplyScheduleTimer.unref?.();
  }

  function scheduleAutoApply(delayMs: number): void {
    if (autoUpdatePreferences.onlyWhenIdle) {
      scheduleActivityCheck(delayMs);
      return;
    }
    scheduleAutomaticInstallCountdown(delayMs);
  }

  function clearPendingAutoApply(): void {
    clearAutoApplyDeadline();
    if (!snapshot.autoApplyPending) return;
    patchSnapshot({ autoApplyPending: null });
  }

  async function applyAutoUpdateAtDeadline(deadlineAt: number): Promise<void> {
    if (
      !autoApplyEnabled
      || !autoUpdatePreferences.automaticInstall
      || snapshot.status !== "ready"
      || snapshot.autoApplyPending?.deadlineAt !== deadlineAt
      || (snapshot.autoApplySuppressedUntil ?? 0) > nowMs()
    ) {
      return;
    }
    try {
      const activity = autoUpdatePreferences.onlyWhenIdle
        ? await getRuntimeActivitySummary?.()
        : { idle: true };
      if (
        !autoApplyEnabled
        || !autoUpdatePreferences.automaticInstall
        || snapshot.status !== "ready"
        || snapshot.autoApplyPending?.deadlineAt !== deadlineAt
        || (snapshot.autoApplySuppressedUntil ?? 0) > nowMs()
      ) {
        return;
      }
      if (!activity?.idle) {
        idleSinceMs = null;
        clearPendingAutoApply();
        scheduleAutoApply(activityCheckMs);
        return;
      }
      patchSnapshot({ autoApplyPending: null });
      const started = await quitAndInstall();
      if (!started) return;
      productAnalyticsService?.captureInternal({
        event: "ade_update_auto_applied",
        surface: "desktop",
      });
    } catch (error) {
      idleSinceMs = null;
      clearPendingAutoApply();
      logger.warn("autoUpdate.deadline_activity_check_failed", {
        message: formatErrorMessage(error),
      });
      scheduleAutoApply(activityCheckMs);
    }
  }

  async function checkAutoApplyActivity(): Promise<void> {
    if (
      activityCheckInProgress
      || !autoApplyEnabled
      || !autoUpdatePreferences.automaticInstall
      || !autoUpdatePreferences.onlyWhenIdle
      || !getRuntimeActivitySummary
      || snapshot.status !== "ready"
      || quitAndInstallPromise != null
      || installQuitArmed
    ) {
      return;
    }
    const currentMs = nowMs();
    const suppressedUntil = snapshot.autoApplySuppressedUntil;
    if (suppressedUntil != null && suppressedUntil > currentMs) {
      idleSinceMs = null;
      clearPendingAutoApply();
      scheduleAutoApply(suppressedUntil - currentMs);
      return;
    }
    if (suppressedUntil != null) {
      patchSnapshot({ autoApplySuppressedUntil: null });
    }

    activityCheckInProgress = true;
    try {
      const activity = await getRuntimeActivitySummary();
      if (
        !autoApplyEnabled
        || !autoUpdatePreferences.automaticInstall
        || !autoUpdatePreferences.onlyWhenIdle
        || snapshot.status !== "ready"
        || quitAndInstallPromise != null
        || installQuitArmed
      ) {
        return;
      }
      if (activityCheckFailed) {
        activityCheckFailed = false;
        logger.info("autoUpdate.activity_check_recovered");
      }
      if (!activity.idle) {
        idleSinceMs = null;
        clearPendingAutoApply();
        return;
      }
      const checkedAt = nowMs();
      idleSinceMs ??= checkedAt;
      if (snapshot.autoApplyPending || checkedAt - idleSinceMs < autoApplyIdleMs) return;
      armAutoApplyCountdown(checkedAt + autoApplyCountdownMs);
    } catch (error) {
      idleSinceMs = null;
      clearPendingAutoApply();
      if (!activityCheckFailed) {
        activityCheckFailed = true;
        logger.warn("autoUpdate.activity_check_failed", {
          message: formatErrorMessage(error),
        });
      }
    } finally {
      activityCheckInProgress = false;
      scheduleAutoApply(activityCheckMs);
    }
  }

  async function abortInstall(
    reason: AutoUpdateInstallAbortReason,
    readySnapshot: AutoUpdateSnapshot,
  ): Promise<false> {
    clearQuitDeadline();
    installQuitArmed = false;
    clearPendingInstallUpdate();
    resetAutoApplyTracking(true);
    try {
      await rollbackQuitAndInstall?.(reason);
    } catch (error) {
      logger.error("autoUpdate.install_rollback_failed", {
        reason,
        message: formatErrorMessage(error),
      });
    }
    logger.warn("autoUpdate.install_aborted", {
      reason,
      version: readySnapshot.version,
    });
    productAnalyticsService?.captureInternal({
      event: "ade_update_install_aborted",
      surface: "desktop",
      properties: { reason },
    });
    patchSnapshot({
      ...readySnapshot,
      status: "ready",
      latestKnownVersion: snapshot.latestKnownVersion ?? readySnapshot.latestKnownVersion,
      progressPercent: 100,
      bytesPerSecond: null,
      transferredBytes: null,
      totalBytes: null,
      error: null,
      errorDetails: null,
      parked: { reason, at: nowMs() },
      autoApplyPending: null,
    });
    installReadySnapshot = null;
    scheduleAutoApply(0);
    return false;
  }

  function escalateQuit(reason: "hard_deadline" | "post_staging"): void {
    if (!installQuitArmed) return;
    const blockedMs = quitBlockedMs();
    const blockedPhase = "app_quit";
    logger.error("autoUpdate.quit_escalated", {
      blockedPhase,
      blockedMs,
      reason,
      nativeStagingCompleted,
    });
    productAnalyticsService?.captureInternal({
      event: "ade_update_quit_escalated",
      surface: "desktop",
      properties: {
        blocked_ms: blockedMs,
        escalation_reason: reason,
        native_staging_completed: nativeStagingCompleted,
      },
    });
    // forceQuit ends the process outright, and log writes are batched onto an
    // async stream — without this the record above dies with the process and
    // the escalation leaves no trace at all.
    logger.flushSync?.();
    forceQuit?.({ blockedPhase, blockedMs });
  }

  const quitBlockedMs = (): number => Math.max(0, nowMs() - (quitArmedAtMs ?? nowMs()));

  // One escalation timer, re-armed. Before staging completes it carries the
  // long bound; after, the short one. Two variables would imply two ways to get
  // force-quit, and there is only ever one armed at a time.
  function armEscalation(delayMs: number, reason: "hard_deadline" | "post_staging"): void {
    if (escalationTimer) clearTimeout(escalationTimer);
    escalationTimer = setTimeout(() => {
      escalationTimer = null;
      escalateQuit(reason);
    }, delayMs);
    escalationTimer.unref?.();
  }

  // Squirrel finished expanding and verifying the new bundle and is handing off
  // to its installer, so the remaining window is short and bounded.
  function onNativeStagingComplete(): void {
    if (!installQuitArmed || nativeStagingCompleted) return;
    nativeStagingCompleted = true;
    logger.info("autoUpdate.native_staging_complete", { elapsedMs: quitBlockedMs() });
    armEscalation(quitPostStagingDeadlineMs, "post_staging");
  }

  function armQuitDeadline(): void {
    clearQuitDeadline();
    installQuitArmed = true;
    nativeStagingCompleted = false;
    quitArmedAtMs = nowMs();

    if (nativeUpdater) {
      const listener = () => onNativeStagingComplete();
      nativeUpdater.on("update-downloaded", listener);
      detachNativeStagingListener = () => {
        try {
          nativeUpdater.removeListener("update-downloaded", listener);
        } catch {
          // A detached native updater is not worth failing the install over.
        }
      };
    }

    // Observation, not enforcement: staging legitimately runs past this on a
    // large bundle or a busy disk. Killing here is what broke installs before.
    stagingSlowWarnTimer = setTimeout(() => {
      stagingSlowWarnTimer = null;
      if (!installQuitArmed || nativeStagingCompleted) return;
      logger.warn("autoUpdate.quit_staging_slow", { blockedMs: quitBlockedMs() });
    }, quitStagingSlowWarnMs);
    stagingSlowWarnTimer.unref?.();

    armEscalation(quitHardDeadlineMs, "hard_deadline");
  }

  function dismissInstalledNotice(): void {
    if (!snapshot.recentlyInstalled) return;
    const currentState = readGlobalState(globalStatePath);
    writeGlobalState(globalStatePath, {
      ...currentState,
      recentlyInstalledUpdate: undefined,
    });
    patchSnapshot({
      recentlyInstalled: null,
    });
  }

  async function quitAndInstall(): Promise<boolean> {
    // Mirrors checkPromise: collapse concurrent IPC/idle-timer calls onto one
    // transaction so cleanup, rollback, and native handoff cannot race.
    if (quitAndInstallPromise) return quitAndInstallPromise;
    if (snapshot.status !== "ready" || !snapshot.version) return false;
    const originalReadySnapshot = cloneSnapshot(snapshot);
    resetAutoApplyTracking(true);
    const run = async (): Promise<boolean> => {
      currentPhase = "verification";
      const refreshSucceeded = await refreshReadyUpdateBeforeInstall();
      if (!refreshSucceeded) {
        return await abortInstall("refresh_failed", originalReadySnapshot);
      }
      const installVersion = snapshot.version;
      if (!installVersion) {
        return await abortInstall("refresh_failed", originalReadySnapshot);
      }
      installReadySnapshot = cloneSnapshot(snapshot);
      currentPhase = "staging";
      if (!preflightSpace("install", installTargetPath)) {
        return await abortInstall("install_preflight_failed", installReadySnapshot);
      }
      try {
        const prepareResult = await waitForInstallStep(
          Promise.resolve(beforeQuitAndInstall?.()),
          "install",
          "ADE could not prepare to quit for the update. Try again.",
        );
        if (!prepareResult.completed) {
          return await abortInstall("prepare_timeout", installReadySnapshot);
        }
      } catch (error) {
        const message = formatErrorMessage(error);
        logger.warn("autoUpdate.prepare_quit_and_install_failed", {
          version: installVersion,
          message,
        });
        return await abortInstall("prepare_failed", installReadySnapshot);
      }
      writeGlobalState(globalStatePath, {
        ...readGlobalState(globalStatePath),
        pendingInstallUpdate: {
          fromVersion: currentVersion,
          targetVersion: installVersion,
          releaseNotesUrl: snapshot.releaseNotesUrl,
          requestedAt: now(),
        },
        recentlyInstalledUpdate: undefined,
      });
      logger.info("autoUpdate.quit_and_install", { version: installVersion });
      patchSnapshot({
        status: "installing",
        progressPercent: 100,
        error: null,
        errorDetails: null,
        parked: null,
        // This attempt supersedes the notice about the previous one.
        lastInstallFailed: null,
        autoApplyPending: null,
      });
      try {
        currentPhase = "install";
        // Mark the quit before entering electron-updater: it calls app.quit()
        // synchronously, and ADE's before-quit handler must recognize this
        // consented path instead of opening the normal quit confirmation.
        armQuitDeadline();
        updater.quitAndInstall(false, true);
        return true;
      } catch (error) {
        const message = formatErrorMessage(error);
        logger.warn("autoUpdate.quit_and_install_failed", {
          version: installVersion,
          message,
        });
        return await abortInstall("handoff_failed", installReadySnapshot);
      }
    };
    quitAndInstallPromise = run().finally(() => {
      quitAndInstallPromise = null;
      if (snapshot.status === "ready") scheduleAutoApply(0);
    });
    return quitAndInstallPromise;
  }

  const startupTimer = autoCheckEnabled ? setTimeout(checkForUpdates, startupDelayMs) : null;
  const periodicTimer = autoCheckEnabled ? setInterval(checkForUpdates, periodicCheckMs) : null;

  return {
    checkForUpdates,
    getSnapshot(): AutoUpdateSnapshot {
      return cloneSnapshot(snapshot);
    },
    getPreferences(): AutoUpdatePreferences {
      return { ...autoUpdatePreferences };
    },
    setPreferences(next: unknown): AutoUpdatePreferences {
      autoUpdatePreferences = normalizeAutoUpdatePreferences(next);
      const currentState = readGlobalState(globalStatePath);
      writeGlobalState(globalStatePath, {
        ...currentState,
        autoUpdatePreferences,
      });
      logger.info("autoUpdate.preferences_updated", autoUpdatePreferences);
      productAnalyticsService?.captureInternal({
        event: "ade_feature_used",
        surface: "desktop",
        properties: {
          feature: "updates",
          action: "preferences_changed",
          mode: autoUpdatePreferences.automaticInstall ? "automatic" : "manual",
          outcome: autoUpdatePreferences.onlyWhenIdle ? "idle_only" : "immediate",
        },
        dedupeKey:
          `update_preferences:${autoUpdatePreferences.automaticInstall}:`
          + `${autoUpdatePreferences.onlyWhenIdle}`,
        minimumIntervalMs: AUTO_UPDATE_PREFERENCE_ANALYTICS_DEDUPE_MS,
      });
      resetAutoApplyTracking(true);
      if (autoUpdatePreferences.automaticInstall) {
        scheduleAutoApply(0);
      }
      return { ...autoUpdatePreferences };
    },
    onStateChange(cb: (snapshot: AutoUpdateSnapshot) => void) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    dismissInstalledNotice,
    quitAndInstall,
    cancelAutoApply(): boolean {
      if (snapshot.status !== "ready" || !snapshot.autoApplyPending) return false;
      const autoApplySuppressedUntil = nowMs() + autoApplySuppressionMs;
      resetAutoApplyTracking(true);
      patchSnapshot({ autoApplySuppressedUntil });
      productAnalyticsService?.captureInternal({
        event: "ade_update_auto_apply_cancelled",
        surface: "desktop",
      });
      scheduleAutoApply(autoApplySuppressionMs);
      return true;
    },
    isInstallQuitArmed(): boolean {
      return installQuitArmed;
    },
    notifyQuitHandoffStarted(): void {
      installQuitArmed = false;
      installReadySnapshot = null;
      clearQuitDeadline();
    },
    dispose() {
      if (startupTimer) clearTimeout(startupTimer);
      if (periodicTimer) clearInterval(periodicTimer);
      clearQuitDeadline();
      clearAutoApplySchedule();
      clearAutoApplyDeadline();
      listeners.clear();
      updater.removeListener("checking-for-update", onCheckingForUpdate);
      updater.removeListener("update-available", onUpdateAvailable);
      updater.removeListener("download-progress", onDownloadProgress);
      updater.removeListener("update-downloaded", onUpdateDownloaded);
      updater.removeListener("update-not-available", onUpdateNotAvailable);
      updater.removeListener("update-cancelled", onUpdateCancelled);
      updater.removeListener("error", onError);
    },
  };
}
