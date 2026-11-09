/**
 * Saved chats (ADE Cloud), reading a computer's copy from the account server
 * while the computer can't answer. Account-level, so no pin; `null` is "couldn't
 * ask", which a caller treats as "keep what you have".
 */

import { ipcMain } from "electron";

import { IPC } from "../../../shared/ipc";
import {
  cloudSavedChatUrl,
  cloudSavedChatsUrl,
  type CloudSavedChatDeleteArgs,
  type CloudSavedChatList,
  type CloudSavedChatPage,
  type CloudSavedChatReadArgs,
  type CloudSavedChatsListArgs,
} from "../../../shared/cloudSavedChats";
import { getSharedAccountAuthService, getSharedAccountDirectoryBaseUrl } from "../../../../../ade-cli/src/services/account/sharedAccountAuthService";
import { getSignedInAccountAccessToken } from "../../../../../ade-cli/src/services/account/accountAuthService";
import { isTrustedAdeRendererSenderOrWarn } from "../ipc/trustedRendererSender";
import type { Logger } from "../logging/logger";

const REQUEST_TIMEOUT_MS = 20_000;

export function registerCloudSavedChatsIpc(args: { logger: Logger }): void {
  const { logger } = args;
  const account = () => getSharedAccountAuthService();

  const request = async (url: string, init: RequestInit): Promise<Response | null> => {
    try {
      if (account().getStatus().signedIn !== true) return null;
      const token = await getSignedInAccountAccessToken(account());
      if (!token) return null;
      return await fetch(url, {
        ...init,
        headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      logger.warn("cloud.saved_chats_request_failed", { error: error instanceof Error ? error.name : "unknown" });
      return null;
    }
  };

  const baseUrl = (): string | null => {
    try {
      return getSharedAccountDirectoryBaseUrl() || null;
    } catch (error) {
      logger.warn("cloud.saved_chats_directory_unavailable", { error: error instanceof Error ? error.name : "unknown" });
      return null;
    }
  };

  ipcMain.handle(IPC.cloudSavedChatsList, async (event, arg: CloudSavedChatsListArgs): Promise<CloudSavedChatList | null> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.cloudSavedChatsList)) return null;
    const base = baseUrl();
    if (!base) return null;
    const params = new URLSearchParams();
    if (arg?.machineKey) params.set("machine", arg.machineKey);
    if (arg?.projectKey) params.set("project", arg.projectKey);
    if (arg?.limit) params.set("limit", String(arg.limit));
    if (arg?.cursor) params.set("cursor", arg.cursor);
    const response = await request(`${cloudSavedChatsUrl(base)}?${params.toString()}`, { method: "GET" });
    // 404 is this account being off the access list: no chats, not a failure.
    if (response?.status === 404) return { chats: [], nextCursor: null };
    if (!response?.ok) return null;
    return await response.json() as CloudSavedChatList;
  });

  ipcMain.handle(IPC.cloudSavedChatsRead, async (event, arg: CloudSavedChatReadArgs): Promise<CloudSavedChatPage | null> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.cloudSavedChatsRead)) return null;
    const base = baseUrl();
    if (!base || !arg?.machineKey || !arg.chatId) return null;
    const params = new URLSearchParams();
    if (arg.before != null) params.set("before", String(arg.before));
    if (arg.limit) params.set("limit", String(arg.limit));
    const query = params.toString();
    const response = await request(`${cloudSavedChatUrl(base, arg.machineKey, arg.chatId)}${query ? `?${query}` : ""}`, { method: "GET" });
    if (!response?.ok) return null;
    return await response.json() as CloudSavedChatPage;
  });

  ipcMain.handle(IPC.cloudSavedChatsDelete, async (event, arg: CloudSavedChatDeleteArgs): Promise<void> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.cloudSavedChatsDelete)) return;
    const base = baseUrl();
    if (!base || !arg?.machineKey || !arg.chatId) throw new Error("This saved chat can't be deleted right now.");
    const response = await request(cloudSavedChatUrl(base, arg.machineKey, arg.chatId), { method: "DELETE" });
    if (!response?.ok) throw new Error("This saved chat can't be deleted right now.");
  });
}
