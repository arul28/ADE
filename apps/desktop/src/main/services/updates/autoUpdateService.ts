import { autoUpdater, type UpdateInfo } from "electron-updater";
import type { Logger } from "../logging/logger";

export function createAutoUpdateService(logger: Logger) {
  autoUpdater.logger = null;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  let updateAvailableCallback: ((info: UpdateInfo) => void) | null = null;
  let updateDownloadedCallback: ((info: UpdateInfo) => void) | null = null;

  autoUpdater.on("update-available", (info) => {
    logger.info("autoUpdate.update_available", { version: info.version });
    updateAvailableCallback?.(info);
  });

  autoUpdater.on("update-downloaded", (info) => {
    logger.info("autoUpdate.update_downloaded", { version: info.version });
    updateDownloadedCallback?.(info);
  });

  autoUpdater.on("error", (err) => {
    logger.warn("autoUpdate.error", { message: err?.message ?? "unknown" });
  });

  function checkForUpdates() {
    autoUpdater.checkForUpdates().catch((err) => {
      logger.warn("autoUpdate.check_failed", { message: err?.message ?? "unknown" });
    });
  }

  // Check after 5s delay, then every 30 minutes
  const startupTimer = setTimeout(checkForUpdates, 5_000);
  const periodicTimer = setInterval(checkForUpdates, 30 * 60 * 1_000);

  return {
    checkForUpdates,
    onUpdateAvailable(cb: (info: UpdateInfo) => void) {
      updateAvailableCallback = cb;
    },
    onUpdateDownloaded(cb: (info: UpdateInfo) => void) {
      updateDownloadedCallback = cb;
    },
    quitAndInstall() {
      autoUpdater.quitAndInstall();
    },
    dispose() {
      clearTimeout(startupTimer);
      clearInterval(periodicTimer);
    },
  };
}
