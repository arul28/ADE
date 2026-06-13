import fs from "node:fs";
import path from "node:path";
import { autoUpdater, type UpdateInfo } from "electron-updater";
import type { AutoUpdateSnapshot, RecentlyInstalledUpdate } from "../../../shared/types";
import type { Logger } from "../logging/logger";
import { readGlobalState, writeGlobalState, type GlobalState } from "../state/globalState";

const DEFAULT_RELEASE_NOTES_BASE_URL = "https://www.ade-app.dev";

type AutoUpdaterLike = {
  logger: typeof autoUpdater.logger;
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  setFeedURL?: (options: { provider: "github"; owner: string; repo: string }) => void;
  checkForUpdates: () => Promise<unknown>;
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
  now?: () => string;
  releaseNotesBaseUrl?: string;
  startupDelayMs?: number;
  periodicCheckMs?: number;
  updaterCacheDir?: string;
  autoCheckEnabled?: boolean;
};

type UpdateCheckResultLike = {
  downloadPromise?: Promise<unknown> | null;
};

type ProgressInfo = {
  percent: number;
  bytesPerSecond: number;
  transferred: number;
  total: number;
};

export function createEmptyAutoUpdateSnapshot(): AutoUpdateSnapshot {
  return {
    status: "idle",
    version: null,
    progressPercent: null,
    bytesPerSecond: null,
    transferredBytes: null,
    totalBytes: null,
    releaseNotesUrl: null,
    error: null,
    recentlyInstalled: null,
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
  return Boolean(result && typeof result === "object" && "downloadPromise" in result);
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
  return `${normalizedBaseUrl}/changelog/${encodeURIComponent(`v${normalizedVersion}`)}`;
}

function cloneRecentlyInstalledUpdate(
  update: RecentlyInstalledUpdate | null,
): RecentlyInstalledUpdate | null {
  return update ? { ...update } : null;
}

function cloneSnapshot(snapshot: AutoUpdateSnapshot): AutoUpdateSnapshot {
  return {
    ...snapshot,
    recentlyInstalled: cloneRecentlyInstalledUpdate(snapshot.recentlyInstalled),
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
        releaseNotesUrl:
          pendingInstall.targetVersion === args.currentVersion
            ? pendingInstall.releaseNotesUrl
            : buildReleaseNotesUrl(args.currentVersion, args.releaseNotesBaseUrl),
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
    recentlyInstalled: cloneRecentlyInstalledUpdate(nextState.recentlyInstalledUpdate ?? null),
    cacheCleanupReason,
  };
}

function applyUpdateInfo(
  info: Pick<UpdateInfo, "version">,
  releaseNotesBaseUrl: string,
): Partial<AutoUpdateSnapshot> {
  return {
    version: info.version,
    releaseNotesUrl: buildReleaseNotesUrl(info.version, releaseNotesBaseUrl),
    error: null,
  };
}

export function createAutoUpdateService({
  logger,
  currentVersion,
  globalStatePath,
  updater = autoUpdater as unknown as AutoUpdaterLike,
  beforeQuitAndInstall,
  now = () => new Date().toISOString(),
  releaseNotesBaseUrl = DEFAULT_RELEASE_NOTES_BASE_URL,
  startupDelayMs = 5_000,
  periodicCheckMs = 30 * 60 * 1_000,
  updaterCacheDir,
  autoCheckEnabled = true,
}: CreateAutoUpdateServiceArgs) {
  updater.logger = null;
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = false;
  try {
    updater.setFeedURL?.({
      provider: "github",
      owner: "arul28",
      repo: "ADE",
    });
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
    ...createEmptyAutoUpdateSnapshot(),
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
  let ignoredDownloadVersion: string | null = null;
  let readyRefreshInProgress = false;
  let readyRefreshError: string | null = null;
  const listeners = new Set<(snapshot: AutoUpdateSnapshot) => void>();

  function emit(): void {
    const nextSnapshot = cloneSnapshot(snapshot);
    for (const listener of listeners) {
      listener(nextSnapshot);
    }
  }

  function patchSnapshot(partial: Partial<AutoUpdateSnapshot>): void {
    snapshot = { ...snapshot, ...partial };
    emit();
  }

  function clearPendingInstallUpdate(): void {
    const currentState = readGlobalState(globalStatePath);
    if (!currentState.pendingInstallUpdate) return;
    writeGlobalState(globalStatePath, {
      ...currentState,
      pendingInstallUpdate: undefined,
    });
  }

  function isTerminalSnapshotStatus(): boolean {
    return snapshot.status === "ready" || snapshot.status === "installing";
  }

  function preservedOrIdlePatch(idleStatus: AutoUpdateSnapshot["status"]): Partial<AutoUpdateSnapshot> {
    if (isTerminalSnapshotStatus()) {
      return {
        status: snapshot.status,
        version: snapshot.version,
        progressPercent: snapshot.progressPercent,
        bytesPerSecond: snapshot.bytesPerSecond,
        transferredBytes: snapshot.transferredBytes,
        totalBytes: snapshot.totalBytes,
        releaseNotesUrl: snapshot.releaseNotesUrl,
        error: null,
      };
    }
    return {
      status: idleStatus,
      version: null,
      progressPercent: null,
      bytesPerSecond: null,
      transferredBytes: null,
      totalBytes: null,
      releaseNotesUrl: null,
      error: null,
    };
  }

  const onCheckingForUpdate = () => {
    logger.info("autoUpdate.checking");
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
      cleanupUpdaterCacheDir({
        updaterCacheDir,
        logger,
        reason: "superseded_ready_update",
      });
    }
    ignoredDownloadVersion = null;
    patchSnapshot({
      status: "downloading",
      progressPercent: 0,
      bytesPerSecond: null,
      transferredBytes: null,
      totalBytes: null,
      ...applyUpdateInfo(info, releaseNotesBaseUrl),
    });
  };

  const onDownloadProgress = (info: ProgressInfo) => {
    if (ignoredDownloadVersion) return;
    patchSnapshot({
      status: "downloading",
      progressPercent: info.percent,
      bytesPerSecond: info.bytesPerSecond,
      transferredBytes: info.transferred,
      totalBytes: info.total,
      error: null,
    });
  };

  const onUpdateDownloaded = (info: UpdateInfo) => {
    logger.info("autoUpdate.update_downloaded", { version: info.version });
    if (ignoredDownloadVersion === info.version) {
      logger.info("autoUpdate.update_downloaded_ignored", {
        version: info.version,
        readyVersion: snapshot.version,
        reason: "ignored_ready_version",
      });
      ignoredDownloadVersion = null;
      return;
    }
    if (snapshot.version && compareUpdateVersions(info.version, snapshot.version) < 0) {
      logger.info("autoUpdate.update_downloaded_ignored", {
        version: info.version,
        readyVersion: snapshot.version,
        reason: "older_than_ready_version",
      });
      return;
    }
    patchSnapshot({
      status: "ready",
      progressPercent: 100,
      bytesPerSecond: null,
      transferredBytes: null,
      totalBytes: null,
      ...applyUpdateInfo(info, releaseNotesBaseUrl),
    });
  };

  const onUpdateNotAvailable = () => {
    logger.info("autoUpdate.update_not_available");
    if (!isTerminalSnapshotStatus()) {
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
    cleanupUpdaterCacheDir({
      updaterCacheDir,
      logger,
      reason: "cancelled",
    });
    patchSnapshot({
      ...createEmptyAutoUpdateSnapshot(),
      recentlyInstalled: snapshot.recentlyInstalled,
    });
  };

  const onError = (err: unknown) => {
    const message = formatErrorMessage(err);
    logger.warn("autoUpdate.error", { message });
    ignoredDownloadVersion = null;
    if (readyRefreshInProgress) {
      readyRefreshError = message;
      return;
    }
    if (snapshot.status === "ready") return;
    if (snapshot.status === "installing") {
      clearPendingInstallUpdate();
    }
    cleanupUpdaterCacheDir({
      updaterCacheDir,
      logger,
      reason: "error",
    });
    patchSnapshot({
      ...createEmptyAutoUpdateSnapshot(),
      status: "error",
      error: message,
      recentlyInstalled: snapshot.recentlyInstalled,
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
    checkPromise = updater.checkForUpdates()
      .then(async (result) => {
        const downloadPromise = extractDownloadPromise(result);
        if (downloadPromise) {
          await downloadPromise;
        }
      })
      .catch((error) => {
        if (readyRefreshInProgress) {
          readyRefreshError = formatErrorMessage(error);
        }
        // `error` is emitted separately by electron-updater.
      })
      .finally(() => {
        checkPromise = null;
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
    readyRefreshError = null;
    try {
      await runUpdateCheck({ allowReady: true });
    } finally {
      readyRefreshInProgress = false;
    }
    if (readyRefreshError) {
      const error = `Could not verify the latest update before installing: ${readyRefreshError}`;
      logger.warn("autoUpdate.refresh_ready_before_install_failed", {
        version: readyVersion,
        message: readyRefreshError,
      });
      cleanupUpdaterCacheDir({
        updaterCacheDir,
        logger,
        reason: "latest_refresh_failed",
      });
      patchSnapshot({
        ...createEmptyAutoUpdateSnapshot(),
        status: "error",
        error,
        recentlyInstalled: snapshot.recentlyInstalled,
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
    async quitAndInstall(): Promise<boolean> {
      // Mirrors checkPromise: collapse concurrent IPC calls onto one in-flight
      // promise so two callers cannot race the refresh + quitAndInstall pair.
      if (quitAndInstallPromise) return quitAndInstallPromise;
      if (snapshot.status !== "ready" || !snapshot.version) return false;
      const run = async (): Promise<boolean> => {
        const refreshSucceeded = await refreshReadyUpdateBeforeInstall();
        if (!refreshSucceeded) return false;
        // After refresh, snapshot may have been replaced; re-check version
        // (refreshReadyUpdateBeforeInstall returns false if snapshot is no
        // longer "ready" with a version, but be explicit for the narrowing).
        const installVersion = snapshot.version;
        if (!installVersion) return false;
        try {
          await beforeQuitAndInstall?.();
        } catch (error) {
          const message = formatErrorMessage(error);
          logger.warn("autoUpdate.prepare_quit_and_install_failed", {
            version: installVersion,
            message,
          });
          patchSnapshot({
            ...createEmptyAutoUpdateSnapshot(),
            status: "error",
            error: message,
            recentlyInstalled: snapshot.recentlyInstalled,
          });
          return false;
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
        });
        try {
          updater.quitAndInstall(false, true);
          return true;
        } catch (error) {
          const message = formatErrorMessage(error);
          logger.warn("autoUpdate.quit_and_install_failed", {
            version: installVersion,
            message,
          });
          clearPendingInstallUpdate();
          patchSnapshot({
            ...createEmptyAutoUpdateSnapshot(),
            status: "error",
            error: message,
            recentlyInstalled: snapshot.recentlyInstalled,
          });
          cleanupUpdaterCacheDir({
            updaterCacheDir,
            logger,
            reason: "quit_and_install_failed",
          });
          return false;
        }
      };
      quitAndInstallPromise = run().finally(() => {
        quitAndInstallPromise = null;
      });
      return quitAndInstallPromise;
    },
    dispose() {
      if (startupTimer) clearTimeout(startupTimer);
      if (periodicTimer) clearInterval(periodicTimer);
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
