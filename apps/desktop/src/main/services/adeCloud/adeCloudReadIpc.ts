/**
 * ADE with no computer, on the desktop: the main-process half.
 *
 * - `adeCloudOpenProject` binds a window to a project tab bound to ADE Cloud
 *   (`shared/adeCloud/binding.ts`). It opens no connection: nothing is
 *   dialed for ADE Cloud as a machine.
 * - The account reads behind such a tab (`GET /cloud/projects/overview`,
 *   the Git summaries, the CLI and shell copies). The reader itself runs in
 *   the preload (`shared/adeCloud/accountReader.ts`); main only holds the
 *   account token.
 * - The message queue of an existing cloud chat (`GET/DELETE
 *   /cloud/chats/:m/:c/messages`): its open messages, and taking one back.
 *   The send is `cloud.sendChatMessage` (`registerCloudIpc.ts`).
 *
 * Account-level calls: no machine pin. No chat text, lane name or token goes
 * to a log; a failure logs only its error class and HTTP status.
 */

import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";

import { IPC } from "../../../shared/ipc";
import { markExpected } from "../../../shared/expectedError";
import { CloudApiError, createCloudApiClient, type CloudApiClient } from "../../../shared/cloudApiClient";
import { adeCloudBinding, isAdeCloudBinding } from "../../../shared/adeCloud/binding";
import type { RemoteOpenProjectBinding } from "../../../shared/types";
import type { AdeCloudQueueSendAnswer } from "../../../shared/adeCloud/chatQueue";
import { runAdeCloudAccountCall } from "../../../shared/adeCloud/accountCalls";
import { ACCOUNT_REQUEST_TIMEOUT_MS, accountTokenWithin, DESKTOP_CLOUD_TOKEN_WAIT_MS } from "./cloudAccess";
import { CloudProviderError } from "./cloudProvider";
import { getSharedAccountAuthService, getSharedAccountDirectoryBaseUrl } from "../../../../../ade-cli/src/services/account/sharedAccountAuthService";
import { isTrustedAdeRendererSenderOrWarn } from "../ipc/trustedRendererSender";
import type { Logger } from "../logging/logger";
import { BRAND } from "../../../shared/brand";

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const KEY_MAX_CHARS = 200;

function text(value: unknown, max = KEY_MAX_CHARS): string | null {
  return typeof value === "string" && value.trim() && value.length <= max ? value.trim() : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function registerAdeCloudReadIpc(args: {
  logger: Logger;
  bindRemoteProject?: (windowId: number | null, binding: RemoteOpenProjectBinding) => void;
}): void {
  const { logger } = args;

  /** The account server's client, or null while signed out. Built per call: the base URL can change at sign-in. */
  const client = (): CloudApiClient | null => {
    const account = getSharedAccountAuthService();
    if (account?.getStatus().signedIn !== true) return null;
    let baseUrl = "";
    try {
      baseUrl = getSharedAccountDirectoryBaseUrl();
    } catch {
      return null;
    }
    if (!baseUrl) return null;
    return createCloudApiClient({
      baseUrl,
      timeoutMs: ACCOUNT_REQUEST_TIMEOUT_MS,
      accessToken: () => accountTokenWithin(account, DESKTOP_CLOUD_TOKEN_WAIT_MS),
    });
  };

  /** A read: its answer, null from an older server or while signed out; a failure says it could not load. */
  const read = async <T>(event: IpcMainInvokeEvent, channel: string, run: (api: CloudApiClient) => Promise<T | null>): Promise<T | null> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, channel)) return null;
    const api = client();
    if (!api) return null;
    const startedAt = Date.now();
    try {
      return await run(api);
    } catch (error) {
      logger.warn("ade_cloud.account_read_failed", {
        channel,
        error: error instanceof Error ? error.name : "unknown",
        status: error instanceof CloudApiError ? error.status : null,
        // Which wait ran out: `token_timeout` (the sign-in refresh), `timeout`
        // (the server), `network`, or the server's own code.
        code: error instanceof CloudApiError || error instanceof CloudProviderError ? error.code : null,
        durationMs: Date.now() - startedAt,
      });
      const failure = new Error(`${BRAND.NAME} couldn't load this from your ${BRAND.NAME} account. Try again.`);
      // No answer (offline, a network still coming up at launch) or the
      // server busy: the reader tries again, and it is not an ADE fault.
      const noAnswer = !(error instanceof CloudApiError) || error.status === 0 || error.status === 429 || error.status >= 502;
      if (noAnswer) throw markExpected(failure, "network");
      // A sign-in that lapsed: the account token would not refresh (the
      // client refuses before any request) or the server turned it down.
      // The person signs in again; nothing in ADE is broken.
      if (error instanceof CloudApiError && error.status === 401) throw markExpected(failure, "user");
      throw failure;
    }
  };

  ipcMain.handle(IPC.adeCloudOpenProject, async (event, arg: { binding?: unknown }): Promise<RemoteOpenProjectBinding> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.adeCloudOpenProject)) {
      throw new Error(`Only the ${BRAND.NAME} window can open a project.`);
    }
    const given = record(arg?.binding);
    const projectId = text(given.projectId);
    if (given.kind !== "remote" || !projectId || !isAdeCloudBinding(given as RemoteOpenProjectBinding)) {
      throw new Error(`This isn't a project on ${BRAND.CLOUD_NAME}.`);
    }
    // Rebuilt field by field: main stores and persists it.
    const binding = adeCloudBinding({
      accountProjectId: projectId,
      displayName: text(given.displayName) ?? projectId,
      gitOriginUrl: text(given.gitOriginUrl, 500),
      iconDataUrl: typeof given.iconDataUrl === "string" && given.iconDataUrl.startsWith("data:image/") && given.iconDataUrl.length < 200_000
        ? given.iconDataUrl
        : null,
    });
    const windowId = BrowserWindow.fromWebContents(event.sender)?.id ?? null;
    args.bindRemoteProject?.(windowId, binding);
    return binding;
  });

  ipcMain.handle(IPC.adeCloudProjectOverview, (event, arg: { origin?: unknown }) => {
    const origin = text(arg?.origin, 500);
    return read(event, IPC.adeCloudProjectOverview, (api) => (origin ? api.projectOverview(origin) : Promise.resolve(null)));
  });

  ipcMain.handle(IPC.adeCloudGitSummary, (event, arg: { machineKey?: unknown; laneId?: unknown }) => {
    const machineKey = text(arg?.machineKey);
    const laneId = text(arg?.laneId);
    return read(event, IPC.adeCloudGitSummary, (api) => (machineKey && laneId ? api.gitSummary(machineKey, laneId) : Promise.resolve(null)));
  });

  ipcMain.handle(IPC.adeCloudSavedSessions, (event, arg: { machineKey?: unknown; projectKey?: unknown; cursor?: unknown }) =>
    read(event, IPC.adeCloudSavedSessions, (api) => api.savedSessions({
      machineKey: text(arg?.machineKey),
      projectKey: text(arg?.projectKey, 500),
      cursor: text(arg?.cursor, 500),
    })));

  ipcMain.handle(IPC.adeCloudChatMessages, (event, arg: { machineKey?: unknown; chatId?: unknown }) => {
    const machineKey = text(arg?.machineKey);
    const chatId = text(arg?.chatId);
    return read(event, IPC.adeCloudChatMessages, (api) => (machineKey && chatId ? api.chatMessages(machineKey, chatId) : Promise.resolve(null)));
  });

  /**
   * A write to the account: the server's own answer, or its refusal as data
   * (code + sentence). An IPC error carries only a message, and the caller
   * needs the code to tell an older server (fall back) from a refusal (show).
   */
  const write = async <T>(event: IpcMainInvokeEvent, channel: string, run: (api: CloudApiClient) => Promise<T>): Promise<AdeCloudQueueSendAnswer<T>> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, channel)) {
      return { ok: false, code: "untrusted", status: 0, message: `Only the ${BRAND.NAME} window can send this.` };
    }
    const api = client();
    if (!api) return { ok: false, code: "signed_out", status: 401, message: `Sign in to ${BRAND.NAME} to send to this chat.` };
    try {
      return { ok: true, result: await run(api) };
    } catch (error) {
      if (error instanceof CloudApiError) {
        logger.warn("ade_cloud.account_write_refused", { channel, code: error.code, status: error.status });
        return { ok: false, code: error.code, status: error.status, message: error.message };
      }
      logger.warn("ade_cloud.account_write_failed", { channel, error: error instanceof Error ? error.name : "unknown" });
      return { ok: false, code: "network", status: 0, message: `${BRAND.NAME} couldn't reach your ${BRAND.NAME} account. Try again.` };
    }
  };

  /** Account data with no computer: CTO, automations, Linear, Jira and the rest (`accountCalls.ts`). It never throws. */
  ipcMain.handle(IPC.adeCloudAccountCall, async (event, call: unknown) => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.adeCloudAccountCall)) {
      return { ok: false, code: "untrusted", status: 0, message: `Only the ${BRAND.NAME} window can read this.` };
    }
    const answer = await runAdeCloudAccountCall(client(), call);
    if (!answer.ok && answer.status !== 404) {
      const name = (call as { call?: unknown } | null)?.call;
      logger.warn("ade_cloud.account_call_refused", {
        call: typeof name === "string" ? name.slice(0, 40) : "unknown",
        code: answer.code,
        status: answer.status,
      });
    }
    return answer;
  });

  ipcMain.handle(IPC.adeCloudChatMessageCancel, (event, arg: { machineKey?: unknown; chatId?: unknown; messageId?: unknown }) => {
    const machineKey = text(arg?.machineKey);
    const chatId = text(arg?.chatId);
    const messageId = typeof arg?.messageId === "string" && ID_PATTERN.test(arg.messageId) ? arg.messageId : null;
    if (!machineKey || !chatId || !messageId) {
      return { ok: false, code: "invalid", status: 400, message: `${BRAND.NAME} couldn't take this message back.` } satisfies AdeCloudQueueSendAnswer<never>;
    }
    return write(event, IPC.adeCloudChatMessageCancel, (api) => api.cancelChatMessage(machineKey, chatId, messageId));
  });
}
