/**
 * Saved chats (ADE Cloud): the server's chat copy of a computer, read while the
 * computer can't answer. Mirrors the `/cloud/chats` routes in
 * `apps/account-directory/src/cloud/contract.ts`.
 */

export type CloudSavedChatRowInput = {
  title: string | null;
  laneId: string | null;
  laneName: string | null;
  status: string | null;
  toolType: string | null;
  provider: string | null;
  model: string | null;
  /** `normalizeGitRemoteIdentity` of the chat's project, so a window lists its own project's chats. */
  projectKey: string | null;
  /** The computer's own id and folder for that project, to address a send to it. */
  projectId: string | null;
  projectRoot: string | null;
  lastActivityAt: string | null;
};

export type CloudSavedChatRow = CloudSavedChatRowInput & {
  machineKey: string;
  chatId: string;
  instanceId: string | null;
  lastSeq: number;
  updatedAt: number;
};

export type CloudSavedChatList = { chats: CloudSavedChatRow[]; nextCursor: string | null };

export type CloudSavedChatPage = {
  chat: CloudSavedChatRow;
  /** Newest part first. Each `text` is JSON lines of chat events. */
  parts: Array<{ seq: number; text: string }>;
  hasMore: boolean;
  nextBefore: number | null;
};

export type CloudSavedChatsListArgs = { machineKey?: string | null; projectKey?: string | null; limit?: number; cursor?: string | null };
export type CloudSavedChatReadArgs = { machineKey: string; chatId: string; before?: number | null; limit?: number };
export type CloudSavedChatDeleteArgs = { machineKey: string; chatId: string };

export function cloudSavedChatsUrl(base: string): string {
  return `${base.replace(/\/+$/, "")}/cloud/chats`;
}

export function cloudSavedChatUrl(base: string, machineKey: string, chatId: string): string {
  return `${cloudSavedChatsUrl(base)}/${encodeURIComponent(machineKey)}/${encodeURIComponent(chatId)}`;
}

export function cloudSavedChatPartUrl(base: string, machineKey: string, chatId: string, seq: number): string {
  return `${cloudSavedChatUrl(base, machineKey, chatId)}/parts/${seq}`;
}

export function cloudSavedChatLaneUrl(base: string, machineKey: string, laneId: string): string {
  return `${cloudSavedChatsUrl(base)}/${encodeURIComponent(machineKey)}/lanes/${encodeURIComponent(laneId)}`;
}
