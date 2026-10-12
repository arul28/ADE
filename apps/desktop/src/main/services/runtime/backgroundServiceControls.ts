import { ipcMain } from "electron";
import { IPC } from "../../../shared/ipc";
import type {
  BackgroundServiceSummary,
  StopBackgroundServiceRequest,
  StopBackgroundServiceResult,
  UpdateInstallImpact,
} from "../../../shared/types";
import type { Logger } from "../logging/logger";
import type { LocalRuntimeConnectionPool } from "../localRuntime/localRuntimeConnectionPool";
import { isTrustedAdeRendererSender } from "../ipc/trustedRendererSender";
import { appOwnedService } from "./quitPrompt";

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
  /** Chats with a live turn right now in projects open in ADE. */
  collectImpact: () => Promise<UpdateInstallImpact>;
  getRunningLaneDeleteLabels: () => Promise<string[]>;
  /** A repair started from the quit prompt is still handing agents over. */
  isRepairing: () => boolean;
  isShuttingDown: () => boolean;
  shutdown: (reason: string) => void;
};

/**
 * Settings → Background service: what runs agents on this computer, and
 * "Stop and quit ADE". Registered on raw `ipcMain` like the quit prompt, so
 * no IPC timeout cuts off a slow service-manager uninstall.
 */
export function registerBackgroundServiceControls(deps: BackgroundServiceControlsDeps): void {
  const summary = async (): Promise<BackgroundServiceSummary> => {
    const [impact, total] = await Promise.all([
      deps.collectImpact(),
      deps.pool.activitySummary().then((activity) => activity.activeAgentTurns, () => 0),
    ]);
    return {
      manageable: deps.manageService,
      runner: appOwnedService(deps.pool.getStatus()) ? "desktop" : "service",
      runningChats: impact.interruptedChats,
      runningAgentsTotal: Math.max(impact.interruptedChats.length, total),
    };
  };

  ipcMain.handle(IPC.appGetBackgroundService, async (event): Promise<BackgroundServiceSummary> => {
    if (!isTrustedAdeRendererSender(event)) throw new Error("Untrusted sender.");
    return await summary();
  });

  /**
   * Removes the login service (what `ade brain stop` does), which stops its
   * brain and every agent in it, then quits. The desktop cannot run without a
   * brain, and it installs the service again on its next launch, so stopping
   * lasts until ADE is opened again.
   */
  ipcMain.handle(IPC.appStopBackgroundServiceAndQuit, async (event, raw: unknown): Promise<StopBackgroundServiceResult> => {
    if (!isTrustedAdeRendererSender(event)) {
      deps.logger.warn("ipc.background_service.untrusted_sender", { channel: IPC.appStopBackgroundServiceAndQuit });
      return { ok: false, message: "Only an ADE window can stop the background service." };
    }
    if (!deps.manageService) {
      return { ok: false, message: "This build of ADE does not manage the background service." };
    }
    if (deps.isShuttingDown()) return { ok: false, message: "ADE is already quitting." };
    if (deps.isRepairing()) return { ok: false, message: "Wait for the background service repair to finish." };
    const deletes = await deps.getRunningLaneDeleteLabels();
    if (deletes.length > 0) {
      // A lane delete runs in the service, so stopping it would cut the delete short.
      return { ok: false, message: `Wait for the lane delete in ${deletes.join(", ")} to finish.` };
    }
    // An agent may have started while the confirmation was open; the person
    // must see it before it is stopped.
    const confirmed = raw as Partial<StopBackgroundServiceRequest> | undefined;
    const confirmedIds = new Set(Array.isArray(confirmed?.confirmedSessionIds) ? confirmed.confirmedSessionIds : []);
    const confirmedTotal = typeof confirmed?.confirmedTotal === "number" ? confirmed.confirmedTotal : 0;
    const now = await summary();
    if (now.runningChats.some((chat) => !confirmedIds.has(chat.sessionId)) || now.runningAgentsTotal > confirmedTotal) {
      return { ok: false, message: "Another agent started working. Press Stop again to see it." };
    }
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
