import type {
  DesktopAppUpdateInstallRequest,
  DesktopAppUpdateInstallResult,
} from "../../../../../ade-cli/src/services/runtime/desktopAppUpdateBridge";
import type { AutoUpdateSnapshot } from "../../../shared/types";
import { compareUpdateVersions } from "../../../shared/updateVersions";
import type { Logger } from "../logging/logger";

/**
 * This app's half of "Update & restart" pressed on ANOTHER machine.
 *
 * The brain here forwards the request over the desktop bridge (see
 * `desktopAppUpdateBridge` in ade-cli). Answering it means doing exactly what
 * this app's own "Restart to update" does -- the consented `quitAndInstall`
 * that uninstalls the service, swaps the app and restarts the brain on the new
 * build after relaunch -- because that transaction is the only one that moves
 * the app and its brain together.
 *
 * The answer goes back first and the quit follows a moment later: the brain
 * that asked dies with the service uninstall, and the person who pressed the
 * button should hear "installing" rather than a dropped connection.
 */

type UpdateService = {
  getSnapshot(): AutoUpdateSnapshot;
  checkForUpdates(options?: { userInitiated?: boolean }): Promise<void>;
  quitAndInstall(resumeChats?: boolean): Promise<boolean>;
  onStateChange(cb: (snapshot: AutoUpdateSnapshot) => void): () => void;
};

export type RemoteUpdateInstaller = {
  install(request: DesktopAppUpdateInstallRequest): Promise<DesktopAppUpdateInstallResult>;
  dispose(): void;
};

/** Long enough for the brain's reply to reach the asking machine. */
const DEFAULT_INSTALL_DELAY_MS = 1_500;
/** The feed answer only; a download that starts is followed separately. */
const DEFAULT_CHECK_TIMEOUT_MS = 60_000;
/** A download still running after this is abandoned, not installed later. */
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30 * 60_000;

function covers(version: string | null, targetVersion: string | null): boolean {
  if (!version) return false;
  return targetVersion == null || compareUpdateVersions(version, targetVersion) >= 0;
}

export function createRemoteUpdateInstaller(args: {
  getService: () => UpdateService | null;
  /** False for development and channel builds: they have no feed of their own. */
  supported: boolean;
  logger: Pick<Logger, "info" | "warn">;
  installDelayMs?: number;
  checkTimeoutMs?: number;
  downloadTimeoutMs?: number;
}): RemoteUpdateInstaller {
  const installDelayMs = args.installDelayMs ?? DEFAULT_INSTALL_DELAY_MS;
  const checkTimeoutMs = args.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
  const downloadTimeoutMs = args.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  let installTimer: ReturnType<typeof setTimeout> | null = null;
  /** The wait for a download to finish; one at a time, the latest request wins. */
  let pendingDownload: { stop: () => void } | null = null;
  let disposed = false;

  const clearPendingDownload = (): void => {
    pendingDownload?.stop();
    pendingDownload = null;
  };

  const scheduleInstall = (service: UpdateService, version: string | null): void => {
    clearPendingDownload();
    if (installTimer) return;
    installTimer = setTimeout(() => {
      installTimer = null;
      if (disposed) return;
      args.logger.info("autoUpdate.remote_install_start", { version });
      // Resume interrupted chats on relaunch, as the in-app button offers: the
      // person who asked is not here to resume them by hand.
      void service.quitAndInstall(true).then(
        (started) => {
          if (!started) args.logger.warn("autoUpdate.remote_install_not_started", { version });
        },
        (error: unknown) => {
          args.logger.warn("autoUpdate.remote_install_failed", {
            version,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      );
    }, installDelayMs);
  };

  const installWhenDownloaded = (service: UpdateService, targetVersion: string | null): void => {
    clearPendingDownload();
    let unsubscribe: (() => void) | null = null;
    const timeout = setTimeout(() => {
      args.logger.warn("autoUpdate.remote_install_download_timeout", { targetVersion });
      stop();
    }, downloadTimeoutMs);
    const stop = (): void => {
      clearTimeout(timeout);
      unsubscribe?.();
      unsubscribe = null;
      if (pendingDownload === entry) pendingDownload = null;
    };
    const entry = { stop };
    pendingDownload = entry;
    const onSnapshot = (snapshot: AutoUpdateSnapshot): void => {
      if (pendingDownload !== entry) return;
      if (snapshot.status === "ready") {
        stop();
        if (covers(snapshot.version, targetVersion)) {
          scheduleInstall(service, snapshot.version);
        } else {
          args.logger.warn("autoUpdate.remote_install_downloaded_older", {
            targetVersion,
            version: snapshot.version,
          });
        }
        return;
      }
      if (snapshot.status === "error" || snapshot.status === "idle") {
        args.logger.warn("autoUpdate.remote_install_download_ended", {
          targetVersion,
          status: snapshot.status,
          error: snapshot.error,
        });
        stop();
      }
    };
    unsubscribe = service.onStateChange(onSnapshot);
    // The download may have finished between the check and this subscription.
    onSnapshot(service.getSnapshot());
  };

  /** Waits for the feed's answer: a download (or a staged update), or the check ending. */
  const awaitCheck = async (
    service: UpdateService,
    targetVersion: string | null,
  ): Promise<AutoUpdateSnapshot> => {
    let unsubscribe: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const decided = new Promise<AutoUpdateSnapshot>((resolve) => {
        unsubscribe = service.onStateChange((snapshot) => {
          if (
            snapshot.status === "downloading"
            || snapshot.status === "installing"
            || snapshot.status === "error"
            || (snapshot.status === "ready" && covers(snapshot.version, targetVersion))
          ) {
            resolve(snapshot);
          }
        });
      });
      const checked = service.checkForUpdates({ userInitiated: true })
        .catch(() => undefined)
        .then(() => service.getSnapshot());
      const timedOut = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), checkTimeoutMs);
      });
      const settled = await Promise.race([decided, checked, timedOut]);
      return settled ?? service.getSnapshot();
    } finally {
      if (timer) clearTimeout(timer);
      (unsubscribe as (() => void) | null)?.();
    }
  };

  const result = (
    outcome: DesktopAppUpdateInstallResult["outcome"],
    snapshot: AutoUpdateSnapshot | null,
    version: string | null,
    message: string,
  ): DesktopAppUpdateInstallResult => ({
    outcome,
    currentVersion: snapshot?.currentVersion ?? null,
    version,
    message,
  });

  return {
    async install(request) {
      const targetVersion = request.targetVersion?.trim() || null;
      const service = args.getService();
      if (!service || !args.supported || disposed) {
        return result(
          "unsupported",
          service?.getSnapshot() ?? null,
          null,
          "This ADE app is a development or channel build and does not update itself.",
        );
      }
      try {
        let snapshot = service.getSnapshot();
        args.logger.info("autoUpdate.remote_install_requested", {
          targetVersion,
          currentVersion: snapshot.currentVersion,
          status: snapshot.status,
          version: snapshot.version,
        });
        if (targetVersion && compareUpdateVersions(snapshot.currentVersion, targetVersion) >= 0) {
          return result("already_current", snapshot, snapshot.currentVersion, `ADE is already on ${snapshot.currentVersion}.`);
        }
        if (snapshot.status === "installing") {
          return result("installing", snapshot, snapshot.version, `ADE ${snapshot.version ?? "update"} is already installing.`);
        }
        if (!(snapshot.status === "ready" && covers(snapshot.version, targetVersion))
          && !(snapshot.status === "downloading" && covers(snapshot.version, targetVersion))) {
          snapshot = await awaitCheck(service, targetVersion);
        }
        if (snapshot.status === "installing") {
          return result("installing", snapshot, snapshot.version, `ADE ${snapshot.version ?? "update"} is already installing.`);
        }
        if (snapshot.status === "ready" && snapshot.version) {
          if (!covers(snapshot.version, targetVersion)) {
            return result(
              "no_update",
              snapshot,
              snapshot.version,
              `The ADE app on that machine only found ${snapshot.version}, not ${targetVersion}.`,
            );
          }
          scheduleInstall(service, snapshot.version);
          return result("installing", snapshot, snapshot.version, `Installing ADE ${snapshot.version}.`);
        }
        if (snapshot.status === "downloading") {
          installWhenDownloaded(service, targetVersion);
          return result(
            "downloading",
            snapshot,
            snapshot.version ?? targetVersion,
            `Downloading ADE ${snapshot.version ?? targetVersion ?? "update"}; it installs when the download finishes.`,
          );
        }
        if (snapshot.status === "error") {
          return result("failed", snapshot, snapshot.version, snapshot.error?.trim() || "The update check failed.");
        }
        if (snapshot.status === "checking") {
          return result("failed", snapshot, null, "The update check on that machine did not finish in time.");
        }
        return result(
          "no_update",
          snapshot,
          null,
          `The ADE app on that machine found no newer version than ${snapshot.currentVersion}.`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        args.logger.warn("autoUpdate.remote_install_request_failed", { targetVersion, error: message });
        return result("failed", null, null, message);
      }
    },
    dispose() {
      disposed = true;
      clearPendingDownload();
      if (installTimer) clearTimeout(installTimer);
      installTimer = null;
    },
  };
}
