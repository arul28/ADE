import { ipcMain } from "electron";
import { IPC } from "../../../shared/ipc";
import { appOwnedService } from "../../../shared/quitPromptModel";
import type {
  BackgroundServiceActivity,
  BackgroundServiceSummary,
  StopBackgroundServiceRequest,
  StopBackgroundServiceResult,
  UpdateInterruptedChat,
} from "../../../shared/types";
import type { Logger } from "../logging/logger";
import type { LocalRuntimeConnectionPool } from "../localRuntime/localRuntimeConnectionPool";
import { isTrustedAdeRendererSenderOrWarn } from "../ipc/trustedRendererSender";

const STOP_REASON = "stop_background_service";

export type BackgroundServiceControlsDeps = {
  logger: Logger;
  /** Packaged builds that install the login service; a dev app never stops it. */
  manageService: boolean;
  pool: Pick<
    LocalRuntimeConnectionPool,
    | "getStatus"
    | "activitySummary"
    | "beginUpdateWindow"
    | "endUpdateWindow"
    | "waitForServiceInstall"
    | "uninstallServiceBestEffort"
  >;
  /** Chats with a live turn in projects open in ADE; null when ADE could not check. */
  collectLiveChats: () => Promise<UpdateInterruptedChat[] | null>;
  getRunningLaneDeleteLabels: () => Promise<string[]>;
  /** A Repair or brain restart is running, from any surface. */
  isRepairing: () => boolean;
  isShuttingDown: () => boolean;
  shutdown: (reason: string) => void;
};

function parseStopRequest(raw: unknown): StopBackgroundServiceRequest | null {
  if (!raw || typeof raw !== "object") return null;
  const { confirmedSessionIds, confirmedOtherProjectsBusy } = raw as Record<string, unknown>;
  if (!Array.isArray(confirmedSessionIds) || typeof confirmedOtherProjectsBusy !== "boolean") return null;
  return {
    confirmedSessionIds: confirmedSessionIds.filter((id): id is string => typeof id === "string"),
    confirmedOtherProjectsBusy,
  };
}

/**
 * Settings → Background service: what runs agents on this computer, and
 * "Stop and quit ADE". Registered on raw `ipcMain` like the quit prompt, so
 * no IPC timeout cuts off a slow service-manager uninstall.
 */
export function registerBackgroundServiceControls(deps: BackgroundServiceControlsDeps): void {
  /** Null when either read failed or timed out. */
  const readActivity = async (): Promise<BackgroundServiceActivity | null> => {
    const [runningChats, busyProjects] = await Promise.all([
      deps.collectLiveChats(),
      deps.pool.activitySummary().then((activity) => activity.activeAgentTurns, () => null),
    ]);
    if (!runningChats || busyProjects == null) return null;
    // `activeAgentTurns` sums one flag per busy project runtime.
    const openBusyProjects = new Set(runningChats.map((chat) => chat.projectName)).size;
    return { runningChats, otherProjectsBusy: busyProjects > openBusyProjects };
  };

  const stopRefusal = async (): Promise<string | null> => {
    if (deps.isShuttingDown()) return "ADE is already quitting.";
    if (deps.isRepairing()) return "Wait for the background service repair to finish.";
    const deletes = await deps.getRunningLaneDeleteLabels();
    // A lane delete runs in the service, so stopping it would cut the delete short.
    if (deletes.length > 0) return `Wait for the lane delete in ${deletes.join(", ")} to finish.`;
    return null;
  };

  ipcMain.handle(IPC.appGetBackgroundService, async (event): Promise<BackgroundServiceSummary> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, deps.logger, IPC.appGetBackgroundService)) {
      throw new Error("Untrusted sender.");
    }
    return {
      manageable: deps.manageService,
      runner: appOwnedService(deps.pool.getStatus()) ? "desktop" : "service",
      activity: await readActivity(),
    };
  });

  /**
   * Removes the login service (what `ade brain stop` does), which stops its
   * brain and every agent in it, then quits. The desktop cannot run without a
   * brain, and it installs the service again on its next launch, so stopping
   * lasts until ADE is opened again.
   */
  ipcMain.handle(IPC.appStopBackgroundServiceAndQuit, async (event, raw: unknown): Promise<StopBackgroundServiceResult> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, deps.logger, IPC.appStopBackgroundServiceAndQuit)) {
      return { ok: false, message: "Only an ADE window can stop the background service." };
    }
    if (!deps.manageService) {
      return { ok: false, message: "This build of ADE does not manage the background service." };
    }
    const confirmed = parseStopRequest(raw);
    if (!confirmed) return { ok: false, message: "ADE did not get the list you confirmed. Press Stop again." };
    // An agent may have started while the confirmation was open; the person
    // must see it before it is stopped. Unknown is refused, never read as none.
    const now = await readActivity();
    if (!now) return { ok: false, message: "ADE couldn't check which agents are working, so it stopped nothing. Try again." };
    const confirmedIds = new Set(confirmed.confirmedSessionIds);
    if (
      now.runningChats.some((chat) => !confirmedIds.has(chat.sessionId))
      || (now.otherProjectsBusy && !confirmed.confirmedOtherProjectsBusy)
    ) {
      return { ok: false, message: "Another agent started working. Press Stop again to see it." };
    }
    // Checked after the last await, so nothing that started meanwhile is missed.
    const refusal = await stopRefusal();
    if (refusal) return { ok: false, message: refusal };
    deps.pool.beginUpdateWindow(STOP_REASON);
    try {
      // An install already running could put the service back after the stop.
      await deps.pool.waitForServiceInstall();
      await deps.pool.uninstallServiceBestEffort();
    } catch (error) {
      deps.pool.endUpdateWindow(`${STOP_REASON}_failed`);
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    deps.shutdown(STOP_REASON);
    return { ok: true };
  });
}
