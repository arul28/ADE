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
