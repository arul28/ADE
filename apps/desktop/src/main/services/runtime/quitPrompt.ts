import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { BrowserWindow, dialog, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from "electron";
import { IPC } from "../../../shared/ipc";
import { quitPromptModel } from "../../../shared/quitPromptModel";
import type {
  BackgroundServiceSummary,
  LocalRuntimeStatus,
  QuitPromptAnswer,
  QuitPromptAppOwnedService,
  QuitPromptChoice,
  QuitPromptRepairResult,
  QuitPromptRequest,
  StopBackgroundServiceRequest,
  StopBackgroundServiceResult,
  UpdateInstallImpact,
  UpdateInterruptedChat,
} from "../../../shared/types";
import type { Logger } from "../logging/logger";
import { readGlobalState, writeGlobalState } from "../state/globalState";
import { isTrustedAdeRendererSender } from "../ipc/trustedRendererSender";

/** The window has this long to show the prompt before main asks natively. */
const QUIT_PROMPT_SHOWN_TIMEOUT_MS = 1_500;

export type QuitPromptDeps = {
  logger: Logger;
  globalStatePath: string;
  /** Packaged builds that install the login service; a dev app never stops it. */
  manageService: boolean;
  getRuntimeStatus: () => LocalRuntimeStatus;
  /** Chats with a live turn right now, bounded so a quit is never held up. */
  collectImpact: () => Promise<UpdateInstallImpact>;
  /** The Repair button's restart; throws when the service does not come back. */
  restartService: () => Promise<void>;
  /** Queues each chat to continue where it stopped once a brain is back. */
  armResume: (sessionIds: readonly string[]) => Promise<UpdateInterruptedChat[]>;
  getRunningLaneDeleteLabels: () => Promise<string[]>;
  /** Live agent turns across every project the service runs; null when unknown. */
  countRunningAgents: () => Promise<number | null>;
  /** Stops the pool reinstalling a service that is being removed on purpose. */
  holdServiceRepair: (reason: string) => void;
  releaseServiceRepair: (reason: string) => void;
  /** Waits out an install already running, then removes the service. */
  uninstallService: () => Promise<void>;
  isShuttingDown: () => boolean;
  shutdown: (reason: string) => void;
};

export type QuitPrompt = {
  /**
   * Asks before quitting or restarting. Resolves true when ADE may go.
   * Skipped when the person ticked "Don't ask again", unless quitting would
   * stop running agents.
   */
  confirm: (ownerWindow: BrowserWindow | null | undefined, relaunch: boolean) => Promise<boolean>;
  /** A repair started from the prompt is still running; quitting waits for it. */
  isRepairing: () => boolean;
};

const QUIT_CHOICES: readonly QuitPromptChoice[] = ["quit", "keep", "repair"];

function parseAnswer(raw: unknown): QuitPromptAnswer | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.requestId !== "string" || !QUIT_CHOICES.includes(value.choice as QuitPromptChoice)) return null;
  return {
    requestId: value.requestId,
    choice: value.choice as QuitPromptChoice,
    dontAskAgain: value.dontAskAgain === true,
  };
}

/**
 * Agents survive a quit unless this desktop is running the service itself:
 * the fallback when the service cannot start, or an isolated brain.
 */
function appOwnedService(status: LocalRuntimeStatus): QuitPromptAppOwnedService | null {
  if (status.runtimeMode === "primary") return null;
  if (status.runtimeMode === "isolated") return { repair: "wait" };
  return { repair: status.appFallback?.reason === "background_item_blocked" ? "system_settings" : "restart" };
}

/**
 * The quit confirmation and the Settings "Background service" controls.
 *
 * Main asks the window over `ade.app.quitPrompt`; the window says it is on
 * screen with `ade.app.quitPromptShown`, then answers. No window, no
 * acknowledgement in time, or a window that reloads or crashes mid-question:
 * main asks natively with the same words, and tells the window to drop its copy.
 */
export function createQuitPrompt(deps: QuitPromptDeps): QuitPrompt {
  const pending = new Map<string, {
    webContentsId: number;
    shown: () => void;
    answer: (answer: QuitPromptAnswer) => Promise<QuitPromptRepairResult | null>;
  }>();
  let repairing: Promise<unknown> | null = null;

  const readAskBeforeQuit = (): boolean => readGlobalState(deps.globalStatePath).askBeforeQuit !== false;
  const writeAskBeforeQuit = (ask: boolean): boolean => {
    const current = readGlobalState(deps.globalStatePath);
    // `readGlobalState` answers {} for an unreadable file too; writing that
    // back would wipe every other setting in it.
    if (Object.keys(current).length === 0 && fs.existsSync(deps.globalStatePath)) {
      throw new Error("ADE could not read its settings file, so the choice was not saved.");
    }
    const { askBeforeQuit: _previous, ...rest } = current;
    writeGlobalState(deps.globalStatePath, ask ? rest : { ...rest, askBeforeQuit: false });
    return ask;
  };

  const trusted = (event: IpcMainInvokeEvent | IpcMainEvent, channel: string): boolean => {
    if (isTrustedAdeRendererSender(event as IpcMainInvokeEvent)) return true;
    deps.logger.warn("ipc.quit_prompt.untrusted_sender", { channel });
    return false;
  };

  ipcMain.handle(IPC.appGetAskBeforeQuit, (event) => {
    if (!trusted(event, IPC.appGetAskBeforeQuit)) throw new Error("Untrusted sender.");
    return readAskBeforeQuit();
  });
  ipcMain.handle(IPC.appSetAskBeforeQuit, (event, ask: unknown) => {
    if (!trusted(event, IPC.appSetAskBeforeQuit)) throw new Error("Untrusted sender.");
    return writeAskBeforeQuit(ask !== false);
  });
  ipcMain.on(IPC.appQuitPromptShown, (event, requestId: unknown) => {
    if (!trusted(event, IPC.appQuitPromptShown) || typeof requestId !== "string") return;
    const entry = pending.get(requestId);
    if (entry?.webContentsId === event.sender.id) entry.shown();
  });
  ipcMain.handle(IPC.appAnswerQuitPrompt, async (event, raw: unknown) => {
    if (!trusted(event, IPC.appAnswerQuitPrompt)) return null;
    const answer = parseAnswer(raw);
    const entry = answer ? pending.get(answer.requestId) : undefined;
    // Only the window that was asked may answer.
    if (!answer || !entry || entry.webContentsId !== event.sender.id) return null;
    return await entry.answer(answer);
  });

  /**
   * "Repair service". Restarting the service stops the chats the desktop was
   * running, so once it is back they are queued to continue, the same way an
   * update resumes them. Nothing is queued when the repair fails: the desktop's
   * own brain may still be running them.
   */
  const repair = async (impact: UpdateInstallImpact): Promise<QuitPromptRepairResult> => {
    try {
      await deps.restartService();
    } catch (error) {
      deps.logger.warn("quit_prompt.repair_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { repaired: false, resumedChats: 0 };
    }
    if (deps.getRuntimeStatus().runtimeMode !== "primary") return { repaired: false, resumedChats: 0 };
    const resumed = await deps.armResume(impact.interruptedChats.map((chat) => chat.sessionId));
    return { repaired: true, resumedChats: resumed.length };
  };

  /** Null when the window could not show the prompt; the caller asks natively. */
  const askInWindow = (
    win: BrowserWindow,
    request: QuitPromptRequest,
    impact: UpdateInstallImpact,
  ): Promise<QuitPromptAnswer | null> => {
    if (win.isDestroyed() || win.webContents.isLoading() || win.webContents.isCrashed()) {
      return Promise.resolve(null);
    }
    const contents = win.webContents;
    return new Promise((resolve) => {
      let settled = false;
      let shown = false;
      const finish = (value: QuitPromptAnswer | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(shownTimer);
        pending.delete(request.requestId);
        win.removeListener("closed", onClosed);
        contents.removeListener("did-start-loading", onLost);
        contents.removeListener("render-process-gone", onLost);
        // The native box is taking over; a late window copy must not show too.
        if (value === null && !contents.isDestroyed()) contents.send(IPC.appQuitPromptDismiss, request.requestId);
        resolve(value);
      };
      // A reload or crash loses the window's copy; nothing would ever answer.
      const onLost = () => finish(null);
      const onClosed = () => finish(shown ? { requestId: request.requestId, choice: "keep", dontAskAgain: false } : null);
      const shownTimer = setTimeout(() => {
        if (!shown) finish(null);
      }, QUIT_PROMPT_SHOWN_TIMEOUT_MS);
      win.once("closed", onClosed);
      contents.once("did-start-loading", onLost);
      contents.once("render-process-gone", onLost);
      pending.set(request.requestId, {
        webContentsId: contents.id,
        shown: () => {
          shown = true;
          clearTimeout(shownTimer);
        },
        answer: async (answer) => {
          finish(answer);
          // Only a restart is ADE's to run; System Settings is the person's.
          if (answer.choice !== "repair" || request.appOwnedService?.repair !== "restart") return null;
          // Repair keeps ADE open; the window waits for the outcome.
          const running = repair(impact);
          repairing = running;
          try {
            return await running;
          } finally {
            if (repairing === running) repairing = null;
          }
        },
      });
      contents.send(IPC.appQuitPrompt, request);
    });
  };

  const askNatively = async (
    ownerWindow: BrowserWindow | null,
    request: QuitPromptRequest,
  ): Promise<QuitPromptAnswer> => {
    const model = quitPromptModel(request, { canRepair: false });
    const options: Electron.MessageBoxOptions = {
      type: model.tone === "warning" ? "warning" : "info",
      buttons: model.actions.map((action) => action.label),
      defaultId: Math.max(0, model.actions.findIndex((action) => action.primary)),
      cancelId: model.actions.findIndex((action) => action.choice === "keep"),
      noLink: true,
      title: request.relaunch ? "Restart ADE?" : "Quit ADE?",
      message: model.title,
      detail: model.description,
      ...(model.offerDontAskAgain ? { checkboxLabel: "Don't ask again", checkboxChecked: false } : {}),
    };
    const result = ownerWindow
      ? await dialog.showMessageBox(ownerWindow, options)
      : await dialog.showMessageBox(options);
    return {
      requestId: request.requestId,
      choice: model.actions[result.response]?.choice ?? "keep",
      dontAskAgain: result.checkboxChecked === true,
    };
  };

  const confirm: QuitPrompt["confirm"] = async (ownerWindow, relaunch) => {
    const owned = appOwnedService(deps.getRuntimeStatus());
    // A normal quit stops nothing, so "Don't ask again" skips even the probe.
    // When it would stop agents, ask every time: a probe that timed out reads
    // as zero agents, so zero is not proof that nothing is running.
    if (!owned && !readAskBeforeQuit()) return true;
    const impact = await deps.collectImpact();
    const request: QuitPromptRequest = {
      requestId: randomUUID(),
      relaunch,
      runningAgents: impact.interruptedChats.length,
      appOwnedService: owned,
    };
    const parentWindow =
      ownerWindow && !ownerWindow.isDestroyed()
        ? ownerWindow
        : BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().find((win) => !win.isDestroyed()) ?? null;
    if (parentWindow) {
      if (parentWindow.isMinimized()) parentWindow.restore();
      parentWindow.show();
      parentWindow.focus();
    }
    const answer = (parentWindow ? await askInWindow(parentWindow, request, impact) : null)
      ?? await askNatively(parentWindow && !parentWindow.isDestroyed() ? parentWindow : null, request);
    if (answer.choice !== "quit") return false;
    if (answer.dontAskAgain && !owned) {
      try {
        writeAskBeforeQuit(false);
      } catch (error) {
        deps.logger.warn("quit_prompt.save_failed", { error: error instanceof Error ? error.message : String(error) });
      }
    }
    return true;
  };

  const backgroundServiceSummary = async (): Promise<BackgroundServiceSummary> => {
    const [impact, total] = await Promise.all([deps.collectImpact(), deps.countRunningAgents()]);
    const runningChats = impact.interruptedChats;
    return {
      manageable: deps.manageService,
      runner: appOwnedService(deps.getRuntimeStatus()) ? "desktop" : "service",
      runningChats,
      runningAgentsTotal: Math.max(runningChats.length, total ?? 0),
    };
  };

  ipcMain.handle(IPC.appGetBackgroundService, async (event): Promise<BackgroundServiceSummary> => {
    if (!trusted(event, IPC.appGetBackgroundService)) throw new Error("Untrusted sender.");
    return await backgroundServiceSummary();
  });

  /**
   * Settings → "Stop and quit ADE". Removes the login service (what `ade brain
   * stop` does), which stops its brain and every agent in it, then quits. The
   * desktop cannot run without a brain, and it installs the service again on
   * its next launch, so stopping lasts until ADE is opened again.
   */
  ipcMain.handle(IPC.appStopBackgroundServiceAndQuit, async (event, raw: unknown): Promise<StopBackgroundServiceResult> => {
    if (!trusted(event, IPC.appStopBackgroundServiceAndQuit)) {
      return { ok: false, message: "Only an ADE window can stop the background service." };
    }
    if (!deps.manageService) {
      return { ok: false, message: "This build of ADE does not manage the background service." };
    }
    if (deps.isShuttingDown()) return { ok: false, message: "ADE is already quitting." };
    if (repairing) return { ok: false, message: "Wait for the background service repair to finish." };
    const deletes = await deps.getRunningLaneDeleteLabels();
    if (deletes.length > 0) {
      // A lane delete runs in the service, so stopping it would cut the delete short.
      return { ok: false, message: `Wait for the lane delete in ${deletes.join(", ")} to finish.` };
    }
    // An agent may have started while the confirmation was open; the person
    // must see it before it is stopped.
    const confirmed = raw as Partial<StopBackgroundServiceRequest> | undefined;
    const confirmedIds = new Set(Array.isArray(confirmed?.confirmedSessionIds) ? confirmed.confirmedSessionIds : []);
    const now = await backgroundServiceSummary();
    const unseen = now.runningChats.some((chat) => !confirmedIds.has(chat.sessionId))
      || now.runningAgentsTotal > (typeof confirmed?.confirmedTotal === "number" ? confirmed.confirmedTotal : 0);
    if (unseen) return { ok: false, message: "Another agent started working. Press Stop again to see it." };
    deps.holdServiceRepair("stop_background_service");
    try {
      await deps.uninstallService();
    } catch (error) {
      deps.releaseServiceRepair("stop_background_service_failed");
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
    deps.shutdown("stop_background_service");
    return { ok: true };
  });

  return { confirm, isRepairing: () => repairing != null };
}
