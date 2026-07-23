import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { autoUpdater, type UpdateInfo } from "electron-updater";
import type {
  AutoUpdateErrorDetails,
  AutoUpdateErrorKind,
  AutoUpdateInstallAbortReason,
  AutoUpdatePhase,
  AutoUpdateSnapshot,
  RecentlyInstalledUpdate,
} from "../../../shared/types";
import type { Logger } from "../logging/logger";
import type { ProductAnalyticsService } from "../analytics/productAnalyticsService";
import { readGlobalState, writeGlobalState, type GlobalState } from "../state/globalState";
import {
  classifyUpdateError,
  estimateUpdateRequiredBytes,
  finitePositive,
  readDiskSpace,
  updateDownloadBytes,
  type DiskSpaceInfo,
} from "./autoUpdateErrors";

const DEFAULT_RELEASE_NOTES_BASE_URL = "https://www.ade-app.dev";
const DEFAULT_INSTALL_WATCHDOG_MS = 30_000;
const DEFAULT_QUIT_DEADLINE_MS = 10_000;
const DEFAULT_AUTO_APPLY_IDLE_MS = 2 * 60_000;
const DEFAULT_AUTO_APPLY_COUNTDOWN_MS = 10_000;
const DEFAULT_AUTO_APPLY_SUPPRESSION_MS = 4 * 60 * 60_000;
const DEFAULT_ACTIVITY_CHECK_MS = 5_000;

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
  startupDelayMs?: number;
  periodicCheckMs?: number;
  updaterCacheDir?: string;
  installTargetPath?: string;
  getDiskSpace?: (targetPath: string) => DiskSpaceInfo;
  installWatchdogMs?: number;
  quitDeadlineMs?: number;
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
    autoApplyPending: null,
    autoApplySuppressedUntil: null,
  };
}

function parseVersion(version: string): {
  core: number[];
  prerelease: string[];
} {
  const withoutBuild = version.trim().replace(/^v/i, "").split("+")[0] ?? "";
  const [coreText = "", prereleaseText = ""] = withoutBuild.split("-", 2);
  return {
    core: coreText.split(".").map((part) => {
      const parsed = Number.parseInt(part, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    }),
    prerelease: prereleaseText ? prereleaseText.split(".") : [],
  };
}

function comparePrereleaseIdentifier(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric && rightNumeric) {
    return Number(left) - Number(right);
  }
  if (leftNumeric !== rightNumeric) {
    return leftNumeric ? -1 : 1;
  }
  return left.localeCompare(right);
}

export function compareUpdateVersions(left: string, right: string): number {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);
  const coreLength = Math.max(leftVersion.core.length, rightVersion.core.length, 3);
  for (let index = 0; index < coreLength; index += 1) {
    const delta = (leftVersion.core[index] ?? 0) - (rightVersion.core[index] ?? 0);
    if (delta !== 0) return delta;
  }

  if (leftVersion.prerelease.length === 0 && rightVersion.prerelease.length > 0) return 1;
  if (leftVersion.prerelease.length > 0 && rightVersion.prerelease.length === 0) return -1;
  const prereleaseLength = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length);
  for (let index = 0; index < prereleaseLength; index += 1) {
    const leftPart = leftVersion.prerelease[index];
    const rightPart = rightVersion.prerelease[index];
    if (leftPart == null && rightPart == null) return 0;
    if (leftPart == null) return -1;
    if (rightPart == null) return 1;
    const delta = comparePrereleaseIdentifier(leftPart, rightPart);
    if (delta !== 0) return delta;
  }
  return 0;
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

export function buildReleaseNotesUrl(
  version: string,
  baseUrl = DEFAULT_RELEASE_NOTES_BASE_URL,
): string | null {
  const normalizedVersion = version.trim().replace(/^v/i, "");
  const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
  if (!normalizedVersion || !normalizedBaseUrl) return null;
  return `${normalizedBaseUrl}/docs/changelog/${encodeURIComponent(`v${normalizedVersion}`)}`;
}

// Deterministic GitHub release page for a version tag, e.g.
// https://github.com/arul28/ADE/releases/tag/v1.2.18 — the same repo the
// updater feed points at above.
export function buildGithubReleaseUrl(version: string): string | null {
  const normalizedVersion = version.trim().replace(/^v/i, "");
  if (!normalizedVersion) return null;
  return `https://github.com/arul28/ADE/releases/tag/${encodeURIComponent(`v${normalizedVersion}`)}`;
}

function cloneRecentlyInstalledUpdate(
  update: RecentlyInstalledUpdate | null,
): RecentlyInstalledUpdate | null {
  return update ? { ...update } : null;
}

// Backfills the GitHub release URL for updates persisted before that field
// existed, so the renderer always has a "View on GitHub" target.
function withGithubReleaseUrl(
  update: RecentlyInstalledUpdate | null,
): RecentlyInstalledUpdate | null {
  if (!update) return null;
  if (update.githubReleaseUrl) return update;
  return { ...update, githubReleaseUrl: buildGithubReleaseUrl(update.version) };
}

function cloneSnapshot(snapshot: AutoUpdateSnapshot): AutoUpdateSnapshot {
  return {
    ...snapshot,
    recentlyInstalled: cloneRecentlyInstalledUpdate(snapshot.recentlyInstalled),
    parked: snapshot.parked ? { ...snapshot.parked } : null,
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
}): {
  state: GlobalState;
  changed: boolean;
  recentlyInstalled: RecentlyInstalledUpdate | null;
  cacheCleanupReason: string | null;
} {
  const nextState: GlobalState = { ...args.state };
  let changed = false;
  let cacheCleanupReason: string | null = null;

  if (
    nextState.recentlyInstalledUpdate
    && nextState.recentlyInstalledUpdate.version !== args.currentVersion
  ) {
    nextState.recentlyInstalledUpdate = undefined;
    changed = true;
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
        githubReleaseUrl: buildGithubReleaseUrl(args.currentVersion),
      };
      cacheCleanupReason = "installed";
    } else {
      cacheCleanupReason = "failed_install";
    }
    nextState.pendingInstallUpdate = undefined;
    changed = true;
  }

  return {
    state: nextState,
    changed,
    recentlyInstalled: withGithubReleaseUrl(
      cloneRecentlyInstalledUpdate(nextState.recentlyInstalledUpdate ?? null),
    ),
    cacheCleanupReason,
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
  startupDelayMs = 5_000,
  periodicCheckMs = 30 * 60 * 1_000,
  updaterCacheDir,
  installTargetPath = process.execPath,
  getDiskSpace = readDiskSpace,
  installWatchdogMs = DEFAULT_INSTALL_WATCHDOG_MS,
  quitDeadlineMs = DEFAULT_QUIT_DEADLINE_MS,
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
    } else {
      updater.setFeedURL?.({
        provider: "github",
        owner: "arul28",
        repo: "ADE",
      });
    }
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

  let snapshot: AutoUpdateSnapshot = {
    ...createEmptyAutoUpdateSnapshot(currentVersion),
    recentlyInstalled: initialState.recentlyInstalled,
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
  let quitDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let activityCheckTimer: ReturnType<typeof setTimeout> | null = null;
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
      scheduleActivityCheck(0);
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
    if (!quitDeadlineTimer) return;
    clearTimeout(quitDeadlineTimer);
    quitDeadlineTimer = null;
  }

  function clearAutoApplyDeadline(): void {
    if (!autoApplyDeadlineTimer) return;
    clearTimeout(autoApplyDeadlineTimer);
    autoApplyDeadlineTimer = null;
  }

  function clearActivityCheck(): void {
    if (!activityCheckTimer) return;
    clearTimeout(activityCheckTimer);
    activityCheckTimer = null;
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
    clearActivityCheck();
    clearAutoApplyDeadline();
    idleSinceMs = null;
    if (clearPending && snapshot.autoApplyPending) {
      patchSnapshot({ autoApplyPending: null });
    }
  }

  function scheduleActivityCheck(delayMs: number): void {
    if (
      !autoApplyEnabled
      || !getRuntimeActivitySummary
      || snapshot.status !== "ready"
      || quitAndInstallPromise != null
      || installQuitArmed
      || activityCheckInProgress
      || activityCheckTimer
    ) {
      return;
    }
    activityCheckTimer = setTimeout(() => {
      activityCheckTimer = null;
      void checkAutoApplyActivity();
    }, Math.max(0, delayMs));
    activityCheckTimer.unref?.();
  }

  function clearPendingAutoApply(): void {
    clearAutoApplyDeadline();
    if (!snapshot.autoApplyPending) return;
    patchSnapshot({ autoApplyPending: null });
  }

  async function checkAutoApplyActivity(): Promise<void> {
    if (
      activityCheckInProgress
      || !autoApplyEnabled
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
      scheduleActivityCheck(suppressedUntil - currentMs);
      return;
    }
    if (suppressedUntil != null) {
      patchSnapshot({ autoApplySuppressedUntil: null });
    }

    activityCheckInProgress = true;
    try {
      const activity = await getRuntimeActivitySummary();
      if (snapshot.status !== "ready" || quitAndInstallPromise != null || installQuitArmed) return;
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
      const deadlineAt = checkedAt + autoApplyCountdownMs;
      patchSnapshot({ autoApplyPending: { deadlineAt } });
      autoApplyDeadlineTimer = setTimeout(() => {
        autoApplyDeadlineTimer = null;
        if (
          snapshot.status !== "ready"
          || snapshot.autoApplyPending?.deadlineAt !== deadlineAt
          || (snapshot.autoApplySuppressedUntil ?? 0) > nowMs()
        ) {
          return;
        }
        patchSnapshot({ autoApplyPending: null });
        void quitAndInstall().then((started) => {
          if (!started) return;
          productAnalyticsService?.captureInternal({
            event: "ade_update_auto_applied",
            surface: "desktop",
          });
        });
      }, autoApplyCountdownMs);
      autoApplyDeadlineTimer.unref?.();
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
      scheduleActivityCheck(activityCheckMs);
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
    scheduleActivityCheck(0);
    return false;
  }

  function armQuitDeadline(): void {
    clearQuitDeadline();
    installQuitArmed = true;
    const startedAt = nowMs();
    quitDeadlineTimer = setTimeout(() => {
      quitDeadlineTimer = null;
      if (!installQuitArmed) return;
      const blockedMs = Math.max(0, nowMs() - startedAt);
      const blockedPhase = "app_quit";
      logger.error("autoUpdate.quit_escalated", {
        blockedPhase,
        blockedMs,
      });
      productAnalyticsService?.captureInternal({
        event: "ade_update_quit_escalated",
        surface: "desktop",
        properties: { blocked_ms: blockedMs },
      });
      forceQuit?.({ blockedPhase, blockedMs });
    }, quitDeadlineMs);
    quitDeadlineTimer.unref?.();
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
      if (snapshot.status === "ready") scheduleActivityCheck(0);
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
      scheduleActivityCheck(autoApplySuppressionMs);
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
      clearActivityCheck();
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
