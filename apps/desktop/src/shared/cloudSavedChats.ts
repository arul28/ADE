/**
 * Saved chats (ADE Cloud): the server's chat copy of a computer, read while the
 * computer can't answer. The shapes are the `/cloud/chats` routes' own.
 */

import type { CloudChatRow, CloudChatRowInput, CloudChatTranscriptPage } from "../../../account-directory/src/cloud/contract";

/**
 * The machine id (and pin target id) a window gives a saved chat's computer
 * while it has no connection to it: the prefix, then the machine key. Main
 * resolves a pin with such a target id by that key (`machines/goneTargets.ts`).
 */
export const SAVED_CHATS_MACHINE_PREFIX = "cloud-saved:";

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
