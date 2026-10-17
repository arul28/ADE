import { useRef, useState } from "react";
import {
  ArrowClockwise,
  ArrowSquareOut,
  Desktop,
  Hourglass,
  Prohibit,
  SlidersHorizontal,
  X,
} from "@phosphor-icons/react";
import type {
  AgentChatCrossMachineHandoffOptionsResult,
  AgentChatCrossMachineHandoffRecord,
  AgentChatCrossMachineTargetConfig,
  AgentChatSessionSummary,
  OpenProjectBinding,
  TerminalSessionSummary,
} from "../../../shared/types";
import { getModelById } from "../../../shared/modelRegistry";
import {
  crossMachineContinuation,
  isCrossMachineHandoffActive,
  pickNewerCrossMachineHandoffRecord,
} from "../../../shared/crossMachineHandoff";
import { stripElectronErrorWrapper } from "../../../shared/codedError";
import { showToast } from "../app/toast/toastStore";
import { describeTravellingChanges, openChatOnOtherMachine } from "../chat/CrossMachineHandoffBanner";
import { MENU_ITEM_CLASS, MenuRowIcon, MenuSeparator, MenuSubmenu, MenuSubmenuStatus } from "../ui/MenuSubmenu";
import { cn } from "../ui/cn";

/**
 * Session menu "Hand off ▸ Another machine ▸". The panel paints at once and
 * fills its machine rows when the brain answers (a context menu that waits on
 * IPC before it appears is a broken one). A row's main click is a quick brief
 * with the chat's current model and permissions (and any uncommitted work,
 * which the row says travels); its trailing button opens the full setup with
 * that machine picked. A machine without the repository always opens the full
 * setup, which asks before cloning.
 */

type OptionsState =
  | { status: "idle" | "loading" }
  | { status: "ready"; result: AgentChatCrossMachineHandoffOptionsResult }
  | { status: "error"; message: string };

/** The destination starts with what this chat runs now. */
function targetFromSummary(summary: AgentChatSessionSummary): AgentChatCrossMachineTargetConfig | null {
  const targetModelId = summary.modelId ?? (getModelById(summary.model)?.id ?? null);
  if (!targetModelId) return null;
  const target: AgentChatCrossMachineTargetConfig = {
    targetModelId,
    reasoningEffort: summary.reasoningEffort ?? null,
    ...(summary.fastMode !== undefined ? { fastMode: summary.fastMode } : {}),
    ...(summary.claudePermissionMode ? { claudePermissionMode: summary.claudePermissionMode } : {}),
    ...(summary.codexApprovalPolicy ? { codexApprovalPolicy: summary.codexApprovalPolicy } : {}),
    ...(summary.codexSandbox ? { codexSandbox: summary.codexSandbox } : {}),
    ...(summary.codexConfigSource ? { codexConfigSource: summary.codexConfigSource } : {}),
    ...(summary.opencodePermissionMode ? { opencodePermissionMode: summary.opencodePermissionMode } : {}),
    ...(summary.droidPermissionMode ? { droidPermissionMode: summary.droidPermissionMode } : {}),
    ...(summary.permissionMode ? { permissionMode: summary.permissionMode } : {}),
    ...(summary.cursorModeId !== undefined ? { cursorModeId: summary.cursorModeId } : {}),
    ...(summary.cursorConfigValues !== undefined ? { cursorConfigValues: summary.cursorConfigValues } : {}),
    ...(summary.acpPermissionMode ? { acpPermissionMode: summary.acpPermissionMode } : {}),
    ...(summary.acpConfigSnapshot !== undefined ? { acpConfigSnapshot: summary.acpConfigSnapshot } : {}),
  };
  return target;
}

function errorText(error: unknown): string {
  return stripElectronErrorWrapper(error instanceof Error ? error.message : String(error));
}

export function CrossMachineMoveSubmenu({
  session,
  binding,
  busy,
  onClose,
  onOpenFullSetup,
}: {
  session: TerminalSessionSummary;
  binding: OpenProjectBinding | null;
  /** The chat has a turn running: a quick move waits for it to end. */
  busy: boolean;
  onClose: () => void;
  /** Full setup modal, optionally with a machine preselected (name or key). */
  onOpenFullSetup: (machine: string | null) => void;
}) {
  const [options, setOptions] = useState<OptionsState>({ status: "idle" });
  const requestRef = useRef(0);

  const load = () => {
    const request = ++requestRef.current;
    setOptions({ status: "loading" });
    void window.ade.agentChat
      .getCrossMachineHandoffOptions({ sourceSessionId: session.id }, binding)
      .then((result) => {
        if (request === requestRef.current) setOptions({ status: "ready", result });
      })
      .catch((error: unknown) => {
        if (request === requestRef.current) setOptions({ status: "error", message: errorText(error) });
      });
  };

  const result = options.status === "ready" ? options.result : null;
  // The summary and the brain's answer can arrive in either order.
  const record: AgentChatCrossMachineHandoffRecord | null = pickNewerCrossMachineHandoffRecord(
    session.crossMachineHandoff ?? null,
    result?.current ?? null,
  );
  const changes = result?.changes ?? null;
  const changesLabel = changes ? describeTravellingChanges(changes.unpushedCommits, changes.changedFiles) : null;
  const changeCount = changes ? changes.unpushedCommits + changes.changedFiles : 0;
  // Blockers a quick brief can't clear on its own. Changes travel along;
  // anything else needs the full setup.
  const hardBlockers = (result?.blockers ?? []).filter((blocker) =>
    !blocker.clearedByIncludeChanges && blocker.id !== "move_in_progress",
  );

  /** Keeps a queued move here, or drops a lost one the person already checked. */
  const cancelMove = async (outcome: { title: string; message: string }) => {
    onClose();
    try {
      await window.ade.agentChat.cancelCrossMachineHandoff({ sourceSessionId: session.id }, binding);
      showToast({ tone: "info", ...outcome });
    } catch (error) {
      showToast({ tone: "warning", title: "Couldn't cancel the move", message: errorText(error) });
    }
  };

  const retryMove = async () => {
    onClose();
    try {
      await window.ade.agentChat.retryCrossMachineHandoff({ sourceSessionId: session.id }, binding);
    } catch (error) {
      showToast({ tone: "warning", title: "Couldn't retry the move", message: errorText(error) });
    }
  };

  const quickBrief = async (machineKey: string, machineName: string) => {
    onClose();
    try {
      const summary = await window.ade.agentChat.getSummary({ sessionId: session.id }, binding);
      const target = summary ? targetFromSummary(summary) : null;
      if (!target) {
        showToast({
          tone: "warning",
          title: `Couldn't move to ${machineName}`,
          message: "ADE couldn't tell which model this chat runs. Use Choose in full setup.",
        });
        return;
      }
      const started = await window.ade.agentChat.startCrossMachineHandoff({
        ...target,
        sourceSessionId: session.id,
        machine: machineKey,
        mode: "brief",
        ...(changeCount > 0 ? { includeChanges: true } : {}),
        ...(busy ? { whenTurnEnds: true } : {}),
      }, binding);
      const model = getModelById(started.targetModelId)?.displayName ?? started.targetModelId;
      // Info, not success: the move has only started; the banner reports how it ends.
      showToast({
        tone: "info",
        title: started.state === "pending"
          ? `Moving to ${started.targetMachineName} when this turn ends`
          : `Sending this chat to ${started.targetMachineName}`,
        message: ["Brief", model, started.includeChanges && changesLabel ? `brings ${changesLabel}` : null]
          .filter(Boolean)
          .join(" · "),
      });
    } catch (error) {
      showToast({
        tone: "warning",
        title: `Couldn't move to ${machineName}`,
        message: errorText(error),
        durationMs: 18_000,
      });
    }
  };

  // Kept across later attempts, so a cancelled second move still offers it.
  const continuation = crossMachineContinuation(record);
  // A lost confirmation is never replayed blindly: retry it or go look.
  const unknownTargetSessionId = record?.state === "unknown"
    ? record.targetSessionId ?? continuation?.targetSessionId ?? null
    : null;
  return (
    <MenuSubmenu
      label="Another machine"
      icon={<MenuRowIcon icon={Desktop} />}
      className={MENU_ITEM_CLASS}
      data-testid="session-menu-handoff-remote"
      panelMinWidth={248}
      onOpen={load}
    >
      {record && isCrossMachineHandoffActive(record) && record.state !== "sending" ? (
        <>
          <MenuSubmenuStatus>
            {record.state === "pending"
              ? `Moving to ${record.targetMachineName} when this turn ends`
              : `The agent wants to continue on ${record.targetMachineName}`}
          </MenuSubmenuStatus>
          <button
            type="button"
            data-testid="session-menu-move-keep-here"
            className={MENU_ITEM_CLASS}
            onClick={() => void cancelMove({ title: "Kept it here", message: "The move was cancelled." })}
          >
            <MenuRowIcon icon={Prohibit} />
            Keep it here
          </button>
        </>
      ) : record?.state === "sending" ? (
        <MenuSubmenuStatus>Sending to {record.targetMachineName}…</MenuSubmenuStatus>
      ) : record?.state === "unknown" ? (
        <>
          <MenuSubmenuStatus>Lost confirmation from {record.targetMachineName}. Check it before retrying.</MenuSubmenuStatus>
          <button
            type="button"
            data-testid="session-menu-move-retry"
            className={MENU_ITEM_CLASS}
            onClick={() => void retryMove()}
          >
            <MenuRowIcon icon={ArrowClockwise} />
            Retry the move
          </button>
          {unknownTargetSessionId ? (
            <button
              type="button"
              data-testid="session-menu-move-open-target"
              className={MENU_ITEM_CLASS}
              onClick={() => {
                onClose();
                openChatOnOtherMachine(unknownTargetSessionId);
              }}
            >
              <MenuRowIcon icon={ArrowSquareOut} />
              Open on {record.targetMachineName}
            </button>
          ) : null}
          <button
            type="button"
            data-testid="session-menu-move-dismiss"
            className={MENU_ITEM_CLASS}
            onClick={() => void cancelMove({ title: "Move dismissed", message: `Stopped tracking the move to ${record.targetMachineName}.` })}
          >
            <MenuRowIcon icon={X} />
            Dismiss
          </button>
        </>
      ) : (
        <>
          {continuation ? (
            <>
              <button
                type="button"
                data-testid="session-menu-move-open-target"
                className={MENU_ITEM_CLASS}
                onClick={() => {
                  onClose();
                  openChatOnOtherMachine(continuation.targetSessionId);
                }}
              >
                <MenuRowIcon icon={ArrowSquareOut} />
                Open on {continuation.targetMachineName}
              </button>
              <MenuSeparator />
            </>
          ) : null}
          {options.status === "idle" || options.status === "loading" ? (
            <MenuSubmenuStatus>Finding your machines…</MenuSubmenuStatus>
          ) : options.status === "error" ? (
            <MenuSubmenuStatus>{options.message}</MenuSubmenuStatus>
          ) : result && result.machines.length === 0 ? (
            <MenuSubmenuStatus>No other machines on this account.</MenuSubmenuStatus>
          ) : null}
          {hardBlockers.length ? (
            <MenuSubmenuStatus>{hardBlockers[0]!.title}. {hardBlockers[0]!.detail}</MenuSubmenuStatus>
          ) : null}
          {result?.machines.map((machine) => {
            const available = machine.online && !machine.unavailableReason;
            // No repository there: the full setup asks before cloning.
            const needsClone = machine.hasRepository === false;
            const hint = needsClone
              ? "will clone the repo"
              : [
                changeCount > 0 && changesLabel ? `brings ${changesLabel}` : null,
                busy ? "when this turn ends" : null,
              ].filter(Boolean).join(" · ");
            return (
              <div key={machine.machineKey} className="flex items-center gap-0.5" data-testid="session-menu-move-machine">
                <button
                  type="button"
                  disabled={!available}
                  title={available ? undefined : machine.unavailableReason ?? "Offline"}
                  className={cn(MENU_ITEM_CLASS, "min-w-0 flex-1 disabled:cursor-not-allowed disabled:text-muted-fg/45 disabled:hover:bg-transparent")}
                  onClick={() => {
                    if (needsClone) {
                      onClose();
                      onOpenFullSetup(machine.machineKey);
                      return;
                    }
                    void quickBrief(machine.machineKey, machine.name);
                  }}
                >
                  <span
                    className="kit-dot shrink-0"
                    data-state={available ? "ok" : undefined}
                    aria-label={available ? "Online" : "Unavailable"}
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {!available ? machine.name : needsClone ? `Set up ${machine.name}…` : `Quick brief to ${machine.name}`}
                  </span>
                  {available ? (
                    hint ? <span className="ml-2 shrink-0 text-[10px] text-muted-fg/55">{hint}</span> : null
                  ) : (
                    <span className="ml-2 shrink-0 text-[10px] text-muted-fg/45">{machine.unavailableReason ?? "Offline"}</span>
                  )}
                  {busy && available && !needsClone ? <Hourglass size={11} className="shrink-0 text-muted-fg/45" aria-hidden /> : null}
                </button>
                {available ? (
                  <button
                    type="button"
                    className="kit-icon-btn shrink-0"
                    title={`Set up the move to ${machine.name}`}
                    aria-label={`Set up the move to ${machine.name}`}
                    onClick={() => {
                      onClose();
                      onOpenFullSetup(machine.machineKey);
                    }}
                  >
                    <SlidersHorizontal size={12} />
                  </button>
                ) : null}
              </div>
            );
          })}
          <MenuSeparator />
          <button
            type="button"
            data-testid="session-menu-move-full-setup"
            className={MENU_ITEM_CLASS}
            onClick={() => {
              onClose();
              onOpenFullSetup(null);
            }}
          >
            <MenuRowIcon icon={SlidersHorizontal} />
            Choose in full setup…
          </button>
        </>
      )}
    </MenuSubmenu>
  );
}
