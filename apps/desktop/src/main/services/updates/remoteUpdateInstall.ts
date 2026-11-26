import type {
  DesktopAppTrackSwitchRequest,
  DesktopAppUpdateInstallRequest,
  DesktopAppUpdateInstallResult,
} from "../../../../../ade-cli/src/services/runtime/desktopAppUpdateBridge";
import type { AutoUpdateSnapshot, TrackSwitchCheckResult, UpdateTrackSwitchResult } from "../../../shared/types";
import { compareUpdateVersions, isWindowsSelfInstallBlocked } from "../../../shared/updateVersions";
import { updateTrackLabel, updateTrackOfVersion, type UpdateTrack } from "../../../shared/updateTrack";
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
  quitAndInstall(resumeChats?: boolean, options?: { requestedRemotely?: boolean }): Promise<boolean>;
  onStateChange(cb: (snapshot: AutoUpdateSnapshot) => void): () => void;
  startTrackSwitch(target: UpdateTrack): UpdateTrackSwitchResult;
};

export type RemoteUpdateInstaller = {
  install(request: DesktopAppUpdateInstallRequest): Promise<DesktopAppUpdateInstallResult>;
  /**
   * "Stable / Beta" pressed on another machine: this app's own guarded switch
   * (Settings › About), then the install of that track's build, answered as
   * `install` answers.
   */
  switchTrack(request: DesktopAppTrackSwitchRequest): Promise<DesktopAppUpdateInstallResult>;
  dispose(): void;
};

/** Long enough for the brain's reply to reach the asking machine. */
const DEFAULT_INSTALL_DELAY_MS = 1_500;
/** The feed answer only; a download that starts is followed separately. */
const DEFAULT_CHECK_TIMEOUT_MS = 60_000;
/** A download still running after this is abandoned, not installed later. */
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30 * 60_000;

function covers(version: string | null, targetVersion: string | null, track?: UpdateTrack): boolean {
  if (!version || (track && updateTrackOfVersion(version) !== track)) return false;
  return targetVersion == null || compareUpdateVersions(version, targetVersion) >= 0;
}

export function createRemoteUpdateInstaller(args: {
  getService: () => UpdateService | null;
  /** False for development and channel builds: they have no feed of their own. */
  supported: boolean;
  /**
   * Whether the install's own preparation would go ahead, asked before this
   * app tells anyone it is installing. The answer goes back before the quit,
   * so a refusal found later would reach the asking machine only as an update
   * that never landed.
   */
  preflightInstall?: () => Promise<{ ok: true } | { ok: false; message: string }>;
  /** The database guard a track switch runs first (`checkTrackSwitch`). */
  checkTrackSwitch: (target: UpdateTrack) => Promise<TrackSwitchCheckResult>;
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

  /** The reason the install would refuse, or null when it would go ahead. */
  const preflight = async (): Promise<string | null> => {
    if (!args.preflightInstall) return null;
    try {
      const answer = await args.preflightInstall();
      return answer.ok ? null : answer.message;
    } catch (error) {
      // A check that cannot run is not a refusal: the install decides then.
      args.logger.warn("autoUpdate.remote_install_preflight_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };

  const clearPendingDownload = (): void => {
    pendingDownload?.stop();
    pendingDownload = null;
  };

  const scheduleInstall = (service: UpdateService, version: string | null, track?: UpdateTrack): void => {
    clearPendingDownload();
    if (installTimer) return;
    installTimer = setTimeout(() => {
      installTimer = null;
      if (disposed) return;
      if (track && !covers(service.getSnapshot().version, version, track)) {
        args.logger.warn("autoUpdate.remote_track_switch_archive_changed", { track, version });
        return;
      }
      args.logger.info("autoUpdate.remote_install_start", { version });
      // Resume interrupted chats on relaunch, as the in-app button offers: the
      // person who asked is not here to resume them by hand.
      void service.quitAndInstall(true, { requestedRemotely: true }).then(
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

  const installWhenDownloaded = (service: UpdateService, targetVersion: string | null, track?: UpdateTrack): void => {
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
        if (covers(snapshot.version, targetVersion, track)) {
          const version = snapshot.version;
          void preflight().then((blocked) => {
            if (pendingDownload !== null || disposed) return;
            if (blocked) {
              args.logger.warn("autoUpdate.remote_install_blocked", { version, reason: blocked });
              return;
            }
            scheduleInstall(service, version, track);
          });
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
    track?: UpdateTrack,
  ): Promise<AutoUpdateSnapshot> => {
    let unsubscribe: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const decided = new Promise<AutoUpdateSnapshot>((resolve) => {
        unsubscribe = service.onStateChange((snapshot) => {
          if (
            snapshot.status === "installing" || snapshot.status === "error"
            || (snapshot.status === "downloading" && (!track || covers(snapshot.version, targetVersion, track)))
            || (snapshot.status === "ready" && covers(snapshot.version, targetVersion, track))
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

  async function install(request: DesktopAppUpdateInstallRequest, track?: UpdateTrack): Promise<DesktopAppUpdateInstallResult> {
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
        requestedByKind: request.requestedBy?.clientKind ?? "unknown",
        requestedByName: request.requestedBy?.machineName ?? null,
        currentVersion: snapshot.currentVersion,
        status: snapshot.status,
        version: snapshot.version,
      });
      if (!track && snapshot.track?.switching) {
        return result("failed", snapshot, null, "A track switch is already running on this computer. Try again after it finishes.");
      }
      if (!track && targetVersion && compareUpdateVersions(snapshot.currentVersion, targetVersion) >= 0) {
        return result("already_current", snapshot, snapshot.currentVersion, `ADE is already on ${snapshot.currentVersion}.`);
      }
      if (snapshot.status === "installing") {
        return result("installing", snapshot, snapshot.version, `ADE ${snapshot.version ?? "update"} is already installing.`);
      }
      if (!(snapshot.status === "ready" && covers(snapshot.version, targetVersion, track))
        && !(snapshot.status === "downloading" && covers(snapshot.version, targetVersion, track))) {
        snapshot = await awaitCheck(service, targetVersion, track);
      }
      if (snapshot.status === "installing") {
        return result("installing", snapshot, snapshot.version, `ADE ${snapshot.version ?? "update"} is already installing.`);
      }
      if (snapshot.status === "ready" && snapshot.version) {
        if (!covers(snapshot.version, targetVersion, track)) {
          return result(
            "no_update",
            snapshot,
            snapshot.version,
            track
              ? `The ADE app could not find a ${updateTrackLabel(track)} build to install.`
              : `The ADE app on that machine only found ${snapshot.version}, not ${targetVersion}.`,
          );
        }
        const blocked = await preflight();
        if (blocked) {
          return result("failed", snapshot, snapshot.version, `ADE ${snapshot.version} is downloaded but can't install: ${blocked}`);
        }
        scheduleInstall(service, snapshot.version, track);
        return result("installing", snapshot, snapshot.version, `Installing ADE ${snapshot.version}.`);
      }
      if (snapshot.status === "downloading" && (!track || covers(snapshot.version, targetVersion, track))) {
        installWhenDownloaded(service, targetVersion, track);
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
  }

  return {
    install,
    async switchTrack(request) {
      const target = request.track;
      const label = updateTrackLabel(target);
      const service = args.getService();
      if (!service || !args.supported || disposed) {
        return result(
          "unsupported",
          service?.getSnapshot() ?? null,
          null,
          "This ADE app is a development or channel build and can't switch tracks.",
        );
      }
      const snapshot = service.getSnapshot();
      const runningTrack = updateTrackOfVersion(snapshot.currentVersion);
      if (isWindowsSelfInstallBlocked(snapshot.currentVersion, process.platform)) {
        return result("failed", snapshot, null, "Use Update & restart to update this Windows installation before switching tracks.");
      }
      args.logger.info("autoUpdate.remote_track_switch_requested", {
        target,
        requestedByKind: request.requestedBy?.clientKind ?? "unknown",
        requestedByName: request.requestedBy?.machineName ?? null,
        currentVersion: snapshot.currentVersion,
      });
      try {
        // Checked here too, not trusted from the brain: this is the app that installs.
        const check = await args.checkTrackSwitch(target);
        if (!check.allowed) return result("failed", snapshot, null, check.reason);
        const started = service.startTrackSwitch(target);
        if (!started.ok) return result("failed", snapshot, null, started.reason);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        args.logger.warn("autoUpdate.remote_track_switch_failed", { target, error: message });
        return result("failed", snapshot, null, message);
      }
      if (target === runningTrack) {
        return result("already_current", snapshot, snapshot.currentVersion, `Follows ${label} again. Nothing to install.`);
      }
      // The switch offers the newest build on the selected track, including
      // when moving back to an older Stable version.
      const answer = await install({ targetVersion: null, requestedBy: request.requestedBy ?? null }, target);
      if (answer.outcome !== "installing" && answer.outcome !== "downloading") {
        // The asking machine hears this failed: the switch must not finish later on its own.
        const cancelled = service.startTrackSwitch(runningTrack);
        if (!cancelled.ok) args.logger.warn("autoUpdate.remote_track_switch_cancel_failed", { target, reason: cancelled.reason });
      }
      return answer;
    },
    dispose() {
      disposed = true;
      clearPendingDownload();
      if (installTimer) clearTimeout(installTimer);
      installTimer = null;
    },
  };
}
