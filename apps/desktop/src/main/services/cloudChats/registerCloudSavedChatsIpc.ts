/**
 * Saved chats (ADE Cloud), reading a computer's copy from the account server
 * while the computer can't answer. Account-level, so no pin; `null` is "couldn't
 * ask", which a caller treats as "keep what you have".
 */

import { ipcMain } from "electron";

import { IPC } from "../../../shared/ipc";
import type {
  CloudSavedChatDeleteArgs,
  CloudSavedChatList,
  CloudSavedChatPage,
  CloudSavedChatReadArgs,
  CloudSavedChatsListArgs,
} from "../../../shared/cloudSavedChats";
import { getSharedAccountAuthService, getSharedAccountDirectoryBaseUrl } from "../../../../../ade-cli/src/services/account/sharedAccountAuthService";
import { cloudAccessDepsFor, cloudServerFor } from "../adeCloud/cloudAccess";
import { isTrustedAdeRendererSenderOrWarn } from "../ipc/trustedRendererSender";
import type { Logger } from "../logging/logger";

export function registerCloudSavedChatsIpc(args: { logger: Logger }): void {
  const { logger } = args;
  const credentials = cloudAccessDepsFor({
    account: () => getSharedAccountAuthService(),
    directoryBaseUrl: () => getSharedAccountDirectoryBaseUrl(),
    logger,
    onDirectoryUnavailable: (error) => logger.warn("cloud.saved_chats_directory_unavailable", { error: error instanceof Error ? error.name : "unknown" }),
  });

  /** Runs one saved-chat read; null when it couldn't be asked. */
  const read = async <T>(run: (server: NonNullable<ReturnType<typeof cloudServerFor>>) => Promise<T>): Promise<T | null> => {
    const server = cloudServerFor(credentials);
    if (!server) return null;
    try {
      return await run(server);
    } catch (error) {
      logger.warn("cloud.saved_chats_request_failed", { error: error instanceof Error ? error.name : "unknown" });
      return null;
    }
  };

  ipcMain.handle(IPC.cloudSavedChatsList, async (event, arg: CloudSavedChatsListArgs): Promise<CloudSavedChatList | null> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.cloudSavedChatsList)) return null;
    return await read((server) => server.listSavedChats(arg ?? {}));
  });

  ipcMain.handle(IPC.cloudSavedChatsRead, async (event, arg: CloudSavedChatReadArgs): Promise<CloudSavedChatPage | null> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.cloudSavedChatsRead)) return null;
    if (!arg?.machineKey || !arg.chatId) return null;
    return await read((server) => server.readSavedChat(arg));
  });

  ipcMain.handle(IPC.cloudSavedChatsDelete, async (event, arg: CloudSavedChatDeleteArgs): Promise<void> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.cloudSavedChatsDelete)) return;
    const deleted = arg?.machineKey && arg.chatId
      ? await read(async (server) => { await server.deleteSavedChat(arg); return true; })
      : null;
    if (!deleted) throw new Error("This saved chat can't be deleted right now.");
  });
}
