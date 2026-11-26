/**
 * Saved chats (ADE Cloud): the server's chat copy of a computer, read while the
 * computer can't answer. The shapes are the `/cloud/chats` routes' own.
 */

import {
  cloudChatRowSettingsOf,
  cloudLaneColorOf,
  type CloudChatComputer,
  type CloudChatRow,
  type CloudChatRowInput,
  type CloudChatRowSettings,
  type CloudChatTranscriptPage,
  type CloudComputerDeleteReason,
} from "../../../account-directory/src/cloud/contract";
import type { AgentChatSessionSummary } from "./types/chat";

export type { CloudChatComputer, CloudChatRowSettings, CloudComputerDeleteReason };
/**
 * The composer settings of a chat (from its summary), for its saved row: the
 * computer sends them with each part, and a client shows them while the
 * computer rests. Null when the chat has none.
 */
export { cloudChatRowSettingsOf };

/**
 * A lane color as a saved row or a launch carries it (`#rrggbb`, lower case),
 * or null. The computer sends its lane's color with each row; a client checks
 * it again before it paints with it.
 */
export { cloudLaneColorOf };

/**
 * A saved row's settings as summary fields, checked again: a client never
 * trusts a stored copy's shape. The check keeps known keys and short tokens
 * only, not each field's own union: a value this ADE does not know (a newer
 * computer's mode) reaches the composer, whose pickers show what they know.
 */
export function savedChatSettingsSummaryFields(row: Pick<CloudChatRow, "settings">): Partial<AgentChatSessionSummary> {
  return (cloudChatRowSettingsOf(row.settings) ?? {}) as Partial<AgentChatSessionSummary>;
}

/**
 * The machine id (and pin target id) a window gives a saved chat's computer
 * while it has no connection to it: the prefix, then the machine key. Main
 * resolves a pin with such a target id by that key (`machines/goneTargets.ts`).
 */
export const SAVED_CHATS_MACHINE_PREFIX = "cloud-saved:";

/**
 * The saved row status of a chat whose running turn ADE stopped because its
 * computer went to sleep, stopped or was deleted (`ade cloud prepare-stop`).
 * A client shows that chat as Stopped while the computer rests, as the turn
 * itself reads ("Stopped" in the chat), not Done.
 */
export const SAVED_CHAT_STOPPED_STATUS = "interrupted";

/** The machine key a saved-chat machine id names, or null. */
export function savedChatsMachineKey(machineId: string | null | undefined): string | null {
  if (!machineId?.startsWith(SAVED_CHATS_MACHINE_PREFIX)) return null;
  return machineId.slice(SAVED_CHATS_MACHINE_PREFIX.length).trim() || null;
}

export type CloudSavedChatRowInput = CloudChatRowInput;
export type CloudSavedChatRow = CloudChatRow;
export type CloudSavedChatList = { chats: CloudSavedChatRow[]; nextCursor: string | null };
export type CloudSavedChatPage = CloudChatTranscriptPage;

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
