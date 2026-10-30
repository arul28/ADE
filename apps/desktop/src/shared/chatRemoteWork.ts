import type { AgentChatRemoteWorkUse, AgentChatSessionSummary } from "./types/chat";

/**
 * The machines a chat is running commands on right now
 * (`ade shell start --machine`): those used since its current turn began.
 * Empty when the chat is not in a turn, so a mark shows only while the work
 * is happening there.
 */
export function activeRemoteWork(
  chat: Pick<AgentChatSessionSummary, "remoteWork" | "status" | "currentTurnStartedAt"> | null | undefined,
): AgentChatRemoteWorkUse[] {
  if (!chat?.remoteWork?.length || chat.status !== "active") return [];
  const turnStart = Date.parse(chat.currentTurnStartedAt ?? "");
  return chat.remoteWork.filter((use) =>
    !Number.isFinite(turnStart) || Date.parse(use.lastStartedAt) >= turnStart);
}

/**
 * The machines whose simulator this chat drives through its work copy, newest
 * first. Only those whose machine told us the copy's lane (current ADE there).
 */
export function remoteSimulatorUses(
  session: { remoteWork?: AgentChatRemoteWorkUse[] | null } | null | undefined,
): Array<AgentChatRemoteWorkUse & { workCopyLaneId: string }> {
  return (session?.remoteWork ?? [])
    .filter((use): use is AgentChatRemoteWorkUse & { workCopyLaneId: string } =>
      use.usesSimulator && typeof use.workCopyLaneId === "string" && use.workCopyLaneId.length > 0)
    .sort((a, b) => Date.parse(b.lastStartedAt) - Date.parse(a.lastStartedAt));
}

/**
 * Of a session row's remote work (`TerminalSessionSummary.remoteWork`), the
 * machines its current turn uses right now (`remoteWorkActiveMachineKeys`).
 */
export function activeRemoteWorkOnRow(
  row: { remoteWork?: AgentChatRemoteWorkUse[]; remoteWorkActiveMachineKeys?: string[] } | null | undefined,
): AgentChatRemoteWorkUse[] {
  const active = row?.remoteWorkActiveMachineKeys;
  if (!active?.length) return [];
  return (row?.remoteWork ?? []).filter((use) => active.includes(use.machineKey));
}
