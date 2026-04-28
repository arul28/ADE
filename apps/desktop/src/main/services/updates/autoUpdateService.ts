import fs from "node:fs";
import path from "node:path";
import type { ProgressInfo } from "builder-util-runtime";
import { autoUpdater, type UpdateInfo } from "electron-updater";
import type { AutoUpdateSnapshot, RecentlyInstalledUpdate } from "../../../shared/types";
import type { Logger } from "../logging/logger";
import { readGlobalState, writeGlobalState, type GlobalState } from "../state/globalState";

const DEFAULT_RELEASE_NOTES_BASE_URL = "https://www.ade-app.dev";

type AutoUpdaterLike = {
  logger: typeof autoUpdater.logger;
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
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
  now?: () => string;
  releaseNotesBaseUrl?: string;
  startupDelayMs?: number;
  periodicCheckMs?: number;
  updaterCacheDir?: string;
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
    if (pendingInstall.targetVersion === args.currentVersion) {
      nextState.recentlyInstalledUpdate = {
        version: pendingInstall.targetVersion,
        installedAt: args.now,
        releaseNotesUrl:
          pendingInstall.releaseNotesUrl
          ?? buildReleaseNotesUrl(pendingInstall.targetVersion, args.releaseNotesBaseUrl),
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
  now = () => new Date().toISOString(),
  releaseNotesBaseUrl = DEFAULT_RELEASE_NOTES_BASE_URL,
  startupDelayMs = 5_000,
  periodicCheckMs = 30 * 60 * 1_000,
  updaterCacheDir,
}: CreateAutoUpdateServiceArgs) {
  updater.logger = null;
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = false;

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

  const onCheckingForUpdate = () => {
    logger.info("autoUpdate.checking");
    patchSnapshot({
      status: snapshot.status === "ready" ? snapshot.status : "checking",
      version: snapshot.status === "ready" ? snapshot.version : null,
      progressPercent: snapshot.status === "ready" ? snapshot.progressPercent : null,
      bytesPerSecond: snapshot.status === "ready" ? snapshot.bytesPerSecond : null,
      transferredBytes: snapshot.status === "ready" ? snapshot.transferredBytes : null,
      totalBytes: snapshot.status === "ready" ? snapshot.totalBytes : null,
      releaseNotesUrl: snapshot.status === "ready" ? snapshot.releaseNotesUrl : null,
      error: null,
    });
  };

  const onUpdateAvailable = (info: UpdateInfo) => {
    logger.info("autoUpdate.update_available", { version: info.version });
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
    if (snapshot.status !== "ready") {
      cleanupUpdaterCacheDir({
        updaterCacheDir,
        logger,
        reason: "not_available",
      });
    }
    patchSnapshot({
      status: snapshot.status === "ready" ? "ready" : "idle",
      version: snapshot.status === "ready" ? snapshot.version : null,
      progressPercent: snapshot.status === "ready" ? snapshot.progressPercent : null,
      bytesPerSecond: snapshot.status === "ready" ? snapshot.bytesPerSecond : null,
      transferredBytes: snapshot.status === "ready" ? snapshot.transferredBytes : null,
      totalBytes: snapshot.status === "ready" ? snapshot.totalBytes : null,
      releaseNotesUrl: snapshot.status === "ready" ? snapshot.releaseNotesUrl : null,
      error: null,
    });
  };

  const onUpdateCancelled = (info: UpdateInfo) => {
    logger.warn("autoUpdate.update_cancelled", { version: info.version });
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
    const message = err instanceof Error ? err.message : String(err ?? "unknown");
    logger.warn("autoUpdate.error", { message });
    if (snapshot.status === "ready") return;
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

  function checkForUpdates(): void {
    if (
      checkPromise
      || snapshot.status === "checking"
      || snapshot.status === "downloading"
      || snapshot.status === "ready"
    ) {
      return;
    }
    checkPromise = updater.checkForUpdates()
      .catch(() => {
        // `error` is emitted separately by electron-updater.
      })
      .finally(() => {
        checkPromise = null;
      });
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

  const startupTimer = setTimeout(checkForUpdates, startupDelayMs);
  const periodicTimer = setInterval(checkForUpdates, periodicCheckMs);

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
    quitAndInstall(): boolean {
      if (snapshot.status !== "ready" || !snapshot.version) return false;
      writeGlobalState(globalStatePath, {
        ...readGlobalState(globalStatePath),
        pendingInstallUpdate: {
          fromVersion: currentVersion,
          targetVersion: snapshot.version,
          releaseNotesUrl: snapshot.releaseNotesUrl,
          requestedAt: now(),
        },
        recentlyInstalledUpdate: undefined,
      });
      logger.info("autoUpdate.quit_and_install", { version: snapshot.version });
      try {
        updater.quitAndInstall(false, true);
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("autoUpdate.quit_and_install_failed", {
          version: snapshot.version,
          message,
        });
        const currentState = readGlobalState(globalStatePath);
        writeGlobalState(globalStatePath, {
          ...currentState,
          pendingInstallUpdate: undefined,
        });
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
    },
    dispose() {
      clearTimeout(startupTimer);
      clearInterval(periodicTimer);
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
