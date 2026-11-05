import type { AgentChatSessionSummary } from "./chat";
import type { ExternalSessionProvider } from "./externalSessions";

/**
 * Settings › Recently deleted: chats the user deleted whose conversation the
 * agent still keeps on this machine. Reopening one opens it again from that
 * copy, the way Import does. ADE never deletes the agent's own files; a chat
 * leaves this list when the agent clears its copy, or when the user reopens
 * it or removes it from the list.
 */
export type DeletedChat = {
  /** The deleted chat's id. */
  id: string;
  title: string | null;
  /** The ADE chat provider it ran on (`claude`, `codex`, `opencode`, …). */
  provider: string;
  /** Whose conversation copy Reopen reads. */
  sourceProvider: ExternalSessionProvider;
  modelId: string | null;
  laneId: string | null;
  laneName: string | null;
  laneColor: string | null;
  /** False when the lane was deleted too: Reopen then asks for a lane. */
  laneExists: boolean;
  createdAt: string | null;
  lastActiveAt: string | null;
  deletedAt: string;
};

export type DeletedChatListArgs = {
  /** Text to match against the title and lane name. */
  query?: string | null;
};

export type DeletedChatListResult = {
  chats: DeletedChat[];
};

export type DeletedChatDetailArgs = {
  id: string;
  /** Paging cursor from the previous page's `olderCursor`. */
  before?: string | null;
};

export type DeletedChatReopenArgs = {
  id: string;
  /** Where to reopen it. Defaults to the lane it was in, when that still exists. */
  laneId?: string | null;
};

export type DeletedChatReopenResult = {
  chatSessionId: string;
  laneId: string;
  /** `continue`: picks up the same conversation. `copy`: a copy in another lane. */
  mode: "continue" | "copy";
  chatSummary: AgentChatSessionSummary;
};

export type DeletedChatRemoveArgs = {
  ids: string[];
};

export type DeletedChatRemoveResult = {
  removed: number;
};
