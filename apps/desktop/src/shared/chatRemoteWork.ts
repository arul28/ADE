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
): AgentChatRemoteWorkUse[] {
  return (session?.remoteWork ?? [])
    .filter((use) => use.usesSimulator === true && Boolean(use.workCopyLaneId))
    .sort((a, b) => Date.parse(b.lastStartedAt) - Date.parse(a.lastStartedAt));
}
