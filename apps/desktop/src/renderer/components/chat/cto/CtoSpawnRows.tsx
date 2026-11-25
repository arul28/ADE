import React, { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { CaretDown, CaretRight } from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../../shared/types";
import { deriveSubagentCardName } from "../../../../shared/chatSubagents";
import { pluralCount } from "../../../../shared/formatting";
import { providerDisplayLabel } from "../../../../shared/pendingInputLabels";
import { chatToolTypeForProvider } from "../../../lib/sessions";
import { ToolLogo } from "../../terminals/ToolLogos";
import { ChatStatusGlyph } from "../chatStatusVisuals";
import { spawnedChildCardStatus } from "../SubagentActivityCards";
import { openCtoChat } from "../../cto/ctoNavigation";
import { usePinTargetsTab } from "../../../state/crossMachineLanes";
import { useChatMachineSessions, useSpawnedChildPaneStatuses } from "../chatSubagentRoster";
import type { SubagentCardGridMember } from "../chatTranscriptRows";
import { splitCtoSpawnMembers } from "./ctoSpawnRules";
import type { CtoToolChip } from "./ctoToolWords";
import "./ctoChat.css";

type CtoSpawnRowsProps = {
  members: readonly SubagentCardGridMember[];
  /** The CTO's own provider: a native helper runs on it. */
  sessionProvider?: string | null;
  /** The machine the CTO chat (and so its children) lives on. */
  runtimePin?: OpenProjectBinding | null;
  /** Opens a native helper's transcript in the chat info pane; absent when the host has none. */
  onOpenTranscript?: (agentKey: string) => void;
};

/**
 * The CTO thread's spawn rows, in place of subagent cards: one quiet
 * "Started a new task" row per child chat, and one "N background tasks" row
 * for its read-only helpers and native subagents, which opens to list them.
 */
export function CtoSpawnRows({ members, sessionProvider, runtimePin, onOpenTranscript }: CtoSpawnRowsProps) {
  const { tasks, helpers } = useMemo(() => splitCtoSpawnMembers(members), [members]);
  return (
    <div className="ade-cto-spawns" data-testid="cto-spawn-rows">
      {tasks.map((member) => (
        <CtoStartedTaskRow key={member.key} member={member} runtimePin={runtimePin ?? null} />
      ))}
      {helpers.length > 0 ? (
        <CtoBackgroundTasksRow
          helpers={helpers}
          sessionProvider={sessionProvider ?? null}
          runtimePin={runtimePin ?? null}
          onOpenTranscript={onOpenTranscript}
        />
      ) : null}
    </div>
  );
}

function ProviderAvatar({ provider, size = 18 }: { provider: string | null; size?: number }) {
  const normalized = provider?.trim() || null;
  return (
    <span className="ade-cto-spawn-avatar" style={{ width: size, height: size }} title={normalized ? providerDisplayLabel(normalized, normalized) : undefined}>
      {normalized ? <ToolLogo toolType={chatToolTypeForProvider(normalized)} size={size - 6} className="block shrink-0" /> : null}
    </span>
  );
}

/**
 * Opens a child chat in the Work tab, the way the CTO page's own lists do: the
 * select event focuses it, and the route switches the visible tab (the CTO
 * page is not the Work tab). `pin` names the child's machine; null means only
 * the Work list knows it (a chat on another machine or ADE Cloud), so its ids
 * stay out of the URL.
 */
function useOpenChildChat(pin: OpenProjectBinding | null): (sessionId: string | null, laneId: string | null) => void {
  const navigate = useNavigate();
  const pinTargetsTab = usePinTargetsTab(pin);
  return useCallback((sessionId, laneId) => {
    if (!sessionId) return;
    openCtoChat(navigate, sessionId, laneId, pin, pin ? pinTargetsTab : false);
  }, [navigate, pin, pinTargetsTab]);
}

/** The child chat's row on its machine: its current title (renamed or auto-titled) and lane. */
function useChildChat(childSessionId: string | null, fallbackTitle: string): { title: string; laneId: string | null } {
  const sessions = useChatMachineSessions();
  return useMemo(() => {
    const row = childSessionId && sessions?.length ? sessions.find((session) => session.id === childSessionId) : null;
    return { title: row?.title?.trim() || fallbackTitle, laneId: row?.laneId ?? null };
  }, [childSessionId, fallbackTitle, sessions]);
}

function CtoStartedTaskRow({ member, runtimePin }: { member: SubagentCardGridMember; runtimePin: OpenProjectBinding | null }) {
  const { event } = member;
  const childSessionId = event.childSessionId?.trim() || null;
  const { title, laneId } = useChildChat(childSessionId, deriveSubagentCardName(event));
  const openChild = useOpenChildChat(runtimePin);
  return (
    <button
      type="button"
      className="ade-cto-spawn"
      data-testid="cto-started-task"
      onClick={() => openChild(childSessionId, laneId)}
      title={`Open ${title}`}
    >
      <span className="ade-cto-spawn-verb">Started a new task</span>
      <ProviderAvatar provider={event.provider ?? null} />
      <span className="ade-cto-spawn-title">{title}</span>
      <CaretRight size={10} className="ade-cto-spawn-caret" aria-hidden />
    </button>
  );
}

/**
 * A chat the CTO started on another machine or ADE Cloud, read off the
 * `spawnChat` result. Opening it goes through the Work list, which knows the
 * other machine's chats (no pin: this thread's pin names the CTO's machine,
 * the same rule the `spawn_completed` line follows for a child elsewhere).
 */
export function CtoRemoteTaskRow({ chip }: { chip: CtoToolChip }) {
  const remote = chip.remote;
  const title = chip.text ?? "a chat";
  const sessionId = remote?.sessionId ?? null;
  const openChild = useOpenChildChat(null);
  return (
    <button
      type="button"
      className="ade-cto-spawn"
      data-testid="cto-started-task"
      disabled={!sessionId}
      onClick={() => openChild(sessionId, remote?.laneId ?? null)}
      title={sessionId ? `Open ${title}` : title}
    >
      <span className="ade-cto-spawn-verb">Started a new task</span>
      <ProviderAvatar provider={remote?.provider ?? null} />
      <span className="ade-cto-spawn-title">{title}</span>
      {remote?.machineName ? <span className="ade-cto-spawn-verb">on {remote.machineName}</span> : null}
      {sessionId ? <CaretRight size={10} className="ade-cto-spawn-caret" aria-hidden /> : null}
    </button>
  );
}

function CtoBackgroundTasksRow({
  helpers,
  sessionProvider,
  runtimePin,
  onOpenTranscript,
}: {
  helpers: readonly SubagentCardGridMember[];
  sessionProvider: string | null;
  runtimePin: OpenProjectBinding | null;
  onOpenTranscript?: (agentKey: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const openChild = useOpenChildChat(runtimePin);
  const childIds = useMemo(
    () => helpers.map((member) => member.event.childSessionId?.trim() || "").filter(Boolean),
    [helpers],
  );
  const childStatuses = useSpawnedChildPaneStatuses(childIds);
  const rows = helpers.map((member) => {
    const childSessionId = member.event.childSessionId?.trim() || null;
    const status = spawnedChildCardStatus(member.event, childSessionId ? childStatuses.get(childSessionId) : null);
    return { member, childSessionId, status };
  });
  const running = rows.filter((row) => row.status === "running").length;
  const failed = rows.filter((row) => row.status === "failed").length;
  const summary = running > 0 ? `${running} running` : failed > 0 ? `${failed} failed` : "done";
  return (
    <div className="ade-cto-helpers" data-open={open ? "true" : undefined}>
      <button
        type="button"
        className="ade-cto-spawn"
        data-testid="cto-background-tasks"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <ChatStatusGlyph status={running > 0 ? "working" : failed > 0 ? "failed" : "completed"} size={11} />
        <span className="ade-cto-spawn-title">{pluralCount(helpers.length, "background task")}</span>
        <span className="ade-cto-spawn-verb">· {summary}</span>
        {open ? <CaretDown size={10} className="ade-cto-spawn-caret" aria-hidden /> : <CaretRight size={10} className="ade-cto-spawn-caret" aria-hidden />}
      </button>
      {open ? (
        <ul className="ade-cto-helper-list">
          {rows.map(({ member, childSessionId, status }) => {
            const name = deriveSubagentCardName(member.event);
            const openHelper = childSessionId
              ? () => openChild(childSessionId, null)
              : onOpenTranscript
                ? () => onOpenTranscript(member.event.agentKey)
                : null;
            const statusWord = status === "running" ? "running" : status === "completed" ? "done" : status;
            const body = (
              <>
                <ProviderAvatar provider={member.event.provider ?? (childSessionId ? null : sessionProvider)} size={16} />
                <span className="ade-cto-helper-name">{name}</span>
                <span className="ade-cto-helper-status" data-status={status}>{statusWord}</span>
              </>
            );
            return (
              <li key={member.key}>
                {openHelper ? (
                  <button type="button" className="ade-cto-helper" onClick={openHelper} title={`Open ${name}`}>{body}</button>
                ) : (
                  <span className="ade-cto-helper" title={name}>{body}</span>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
