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
  /**
   * `cli`: a deleted agent CLI terminal (Claude Code, Codex, …). Reopen
   * relaunches the CLI in its lane instead of opening a chat. Absent (a chat)
   * on older hosts.
   */
  kind?: DeletedSessionKind;
  /** CLI only: the terminal's tool type (`claude`, `codex`, `cursor-cli`, …). */
  toolType?: string | null;
  /**
   * CLI only: Reopen resumes the CLI's own conversation. False when ADE never
   * learned the conversation id or the agent no longer has it; Reopen then
   * starts a fresh CLI in the lane and says so.
   */
  resumable?: boolean;
};

export type DeletedSessionKind = "chat" | "cli";

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
  /** The reopened chat, or for a CLI the terminal session it relaunched in. */
  chatSessionId: string;
  laneId: string;
  /**
   * `continue`: picks up the same conversation. `copy`: a copy in another
   * lane. `fresh` (CLI only): ADE could not resume the CLI's conversation, so
   * a new CLI started in the lane.
   */
  mode: "continue" | "copy" | "fresh";
  /** Absent for a CLI, which reopens as a terminal session, not a chat. */
  chatSummary?: AgentChatSessionSummary;
  /** `cli` when a deleted agent CLI was relaunched. Absent for a chat. */
  kind?: DeletedSessionKind;
  /** CLI only: why the CLI started fresh, said to the person. */
  notice?: string | null;
};

export type DeletedChatRemoveArgs = {
  ids: string[];
};

export type DeletedChatRemoveResult = {
  removed: number;
};
