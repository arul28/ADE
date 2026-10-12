import { randomUUID } from "node:crypto";
import { BrowserWindow, dialog, ipcMain } from "electron";
import { IPC } from "../../../shared/ipc";
import { quitPromptModel } from "../../../shared/quitPromptModel";
import type {
  LocalRuntimeStatus,
  QuitPromptAnswer,
  QuitPromptAppOwnedService,
  QuitPromptChoice,
  QuitPromptRepairResult,
  QuitPromptRequest,
  UpdateInstallImpact,
  UpdateInterruptedChat,
} from "../../../shared/types";
import type { Logger } from "../logging/logger";
import { readGlobalState, readGlobalStateForUpdate, writeGlobalState } from "../state/globalState";
import { isTrustedAdeRendererSender } from "../ipc/trustedRendererSender";

/** The window has this long to show the prompt before main asks natively. */
const QUIT_PROMPT_SHOWN_TIMEOUT_MS = 1_500;

export type QuitPromptDeps = {
  logger: Logger;
  globalStatePath: string;
  getRuntimeStatus: () => LocalRuntimeStatus;
  /** Chats with a live turn right now, bounded so a quit is never held up. */
  collectImpact: () => Promise<UpdateInstallImpact>;
  /** The Repair button's restart; throws when the service does not come back. */
  restartService: () => Promise<void>;
  /** Any Repair or brain restart is running, whichever surface started it. */
  isRecovering: () => boolean;
  /** Queues each chat to continue where it stopped once a brain is back. */
  armResume: (sessionIds: readonly string[]) => Promise<UpdateInterruptedChat[]>;
};

export type QuitPrompt = {
  /**
   * Asks before quitting or restarting. Resolves true when ADE may go.
   * Skipped when the person ticked "Don't ask again", unless quitting would
   * stop running agents.
   */
  confirm: (ownerWindow: BrowserWindow | null | undefined, relaunch: boolean) => Promise<boolean>;
  /** A repair is handing agents over; quitting or stopping now would cut it off. */
  isRepairing: () => boolean;
};

const QUIT_CHOICES: ReadonlySet<string> = new Set<QuitPromptChoice>(["quit", "keep", "repair", "settings"]);

function isQuitChoice(value: unknown): value is QuitPromptChoice {
  return typeof value === "string" && QUIT_CHOICES.has(value);
}

function parseAnswer(raw: unknown): QuitPromptAnswer | null {
  if (!raw || typeof raw !== "object") return null;
  const { requestId, choice, dontAskAgain } = raw as Record<string, unknown>;
  if (typeof requestId !== "string" || !isQuitChoice(choice)) return null;
  return { requestId, choice, dontAskAgain: dontAskAgain === true };
}

/**
 * Agents survive a quit unless this desktop is running the service itself:
 * the fallback when the service cannot start, or an isolated brain.
 */
export function appOwnedService(status: LocalRuntimeStatus): QuitPromptAppOwnedService | null {
  if (status.runtimeMode === "primary") return null;
  if (status.runtimeMode === "isolated") return { repair: "wait" };
  return { repair: status.appFallback?.reason === "background_item_blocked" ? "system_settings" : "restart" };
}

/**
 * The quit confirmation.
 *
 * Main asks the window over `ade.app.quitPrompt`; the window says it is on
 * screen with `ade.app.quitPromptShown`, then answers. No window, no
 * acknowledgement in time, or a window that reloads or crashes mid-question:
 * main asks natively with the same words, and tells the window to drop its copy.
 *
 * The handlers are registered on raw `ipcMain`, ahead of `registerIpc`'s
 * trace-and-timeout wrapper, so no IPC timeout applies: a repair answer can
 * take minutes and must not be cut off.
 */
export function createQuitPrompt(deps: QuitPromptDeps): QuitPrompt {
  const pending = new Map<string, {
    webContentsId: number;
    shown: () => void;
    answer: (answer: QuitPromptAnswer) => Promise<QuitPromptRepairResult | null>;
  }>();
  let repairing = false;

  const readAskBeforeQuit = (): boolean => readGlobalState(deps.globalStatePath).askBeforeQuit !== false;
  const writeAskBeforeQuit = (ask: boolean): boolean => {
    // Throws on an unreadable file rather than writing {} over it.
    const { askBeforeQuit: _previous, ...rest } = readGlobalStateForUpdate(deps.globalStatePath);
    writeGlobalState(deps.globalStatePath, ask ? rest : { ...rest, askBeforeQuit: false });
    return ask;
  };

  const trusted = (event: Parameters<typeof isTrustedAdeRendererSender>[0], channel: string): boolean => {
    if (isTrustedAdeRendererSender(event)) return true;
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
   * running, and a failed restart may already have stopped them too. So
   * afterwards every chat that is no longer running is queued to continue,
   * the same way an update resumes them; a chat still running is left alone.
   */
  const repair = async (impact: UpdateInstallImpact): Promise<QuitPromptRepairResult> => {
    let restarted = true;
    try {
      await deps.restartService();
    } catch (error) {
      restarted = false;
      deps.logger.warn("quit_prompt.repair_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const repaired = restarted && deps.getRuntimeStatus().runtimeMode === "primary";
    const stillRunning = new Set((await deps.collectImpact()).interruptedChats.map((chat) => chat.sessionId));
    const stopped = impact.interruptedChats.map((chat) => chat.sessionId).filter((id) => !stillRunning.has(id));
    const resumed = await deps.armResume(stopped);
    return { repaired, resumedChats: resumed.length };
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
          // Only a restart is ADE's to run, and only when the prompt offered it.
          if (answer.choice !== "repair" || request.appOwnedService?.repair !== "restart") return null;
          // Repair keeps ADE open; the window waits for the outcome.
          repairing = true;
          try {
            return await repair(impact);
          } finally {
            repairing = false;
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
      ...(model.dontAskAgainLabel ? { checkboxLabel: model.dontAskAgainLabel, checkboxChecked: false } : {}),
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

  return { confirm, isRepairing: () => repairing || deps.isRecovering() };
}
