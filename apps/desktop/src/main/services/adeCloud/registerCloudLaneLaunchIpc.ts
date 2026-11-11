import path from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import type { CloudLaneLaunchCallRequest, CloudLaneLaunchCallResult } from "../../../shared/cloudLaneLaunch";
import { normalizeGitRemoteIdentity } from "../../../shared/crossMachineHandoff";
import { IPC } from "../../../shared/ipc";
import type {
  ChatLaunchArgs,
  ChatLaunchCompleteClientArgs,
  ChatLaunchEvent,
  ChatLaunchIdArgs,
  ChatLaunchQueueMessageArgs,
} from "../../../shared/types";
import type { RuntimeBridgeRegistration } from "../ipc/runtimeBridge";
import { readGitOriginUrlWithoutGit } from "../projects/recentProjectSummary";
import { isTrustedAdeRendererSenderOrWarn } from "../ipc/trustedRendererSender";
import type { Logger } from "../logging/logger";
import type { CloudMachineCreatorDeps } from "./cloudMachineCreator";
import { createCloudLaneLaunchService, type CloudLaneLaunchService } from "./cloudLaneLaunchService";

function sendToAllWindows(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    try {
      win.webContents.send(channel, payload);
    } catch {
      // Closing mid-send; the next event reaches it if it stays.
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The launch id of an id-based call, or null when the args carry none. */
function launchIdOf(args: unknown): string | null {
  return isRecord(args) && typeof args.launchId === "string" ? args.launchId : null;
}

/**
 * Hosts ADE Cloud lane launches in this app's main process and answers
 * `IPC.cloudLaneLaunchCall`. The routing rules live at the top of
 * `cloudLaneLaunchService.ts`.
 */
export function registerCloudLaneLaunchIpc(args: {
  machineCreatorDeps: CloudMachineCreatorDeps;
  removeAccountMachine: (machineKey: string) => Promise<unknown>;
  pairMachine: (machineKey: string) => Promise<{ targetId: string }>;
  remote: RuntimeBridgeRegistration["remoteForMain"];
  logger: Logger;
}): CloudLaneLaunchService {
  const { remote, logger } = args;
  const { pendingCreates: _pendingCreates, ...creator } = args.machineCreatorDeps;
  // The launch kinds each connect's brain advertised, so the hand-off reads
  // what its own connect just saw instead of connecting again.
  const brainLaunchKinds = new Map<string, string[]>();
  const service = createCloudLaneLaunchService({
    recordsDir: path.join(app.getPath("userData"), "cloud-lane-launches"),
    logger,
    emit: (event: ChatLaunchEvent) => sendToAllWindows(IPC.cloudLaneLaunchEvent, event),
    creator,
    removeAccountMachine: args.removeAccountMachine,
    pairMachine: args.pairMachine,
    connect: async (targetId) => {
      const connected = await remote.connect(targetId);
      brainLaunchKinds.set(targetId, connected.chatLaunchKinds);
      return true;
    },
    brainLaunchKinds: async (targetId) => brainLaunchKinds.get(targetId) ?? null,
    listProjects: (targetId) => remote.projects(targetId),
    defaultParentDir: (targetId) => remote.defaultParentDir(targetId),
    cloneProject: (targetId, input) => remote.cloneProject(targetId, input),
    resolveBinding: (targetId, projectId, rootPath) => remote.resolveBinding(targetId, projectId, rootPath),
    callChatAction: (binding, action, request) => remote.callAction(binding, { domain: "chat", action, ...request }),
    subscribeChatLaunchEvents: (binding, onEvent, onEnded) => remote.subscribeEvents(
      binding,
      "runtime",
      (event) => {
        const payload = event.payload;
        if (payload?.type === "chat_launch_event" && isRecord(payload.event)) onEvent(payload.event as ChatLaunchEvent);
      },
      onEnded,
    ),
  });

  ipcMain.handle(IPC.cloudLaneLaunchCall, async (event, raw: unknown): Promise<CloudLaneLaunchCallResult> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.cloudLaneLaunchCall)) {
      throw new Error("ADE can't do that from here.");
    }
    const request = (isRecord(raw) ? raw : {}) as Partial<CloudLaneLaunchCallRequest>;
    const source = isRecord(request.source) ? request.source : null;
    const localRootPath = typeof source?.localRootPath === "string" ? source.localRootPath.trim() : "";
    const originUrl = (typeof source?.gitOriginUrl === "string" && source.gitOriginUrl.trim())
      // Read from the checkout's git config, without starting git.
      || (localRootPath ? readGitOriginUrlWithoutGit(localRootPath) ?? null : null);
    switch (request.method) {
      case "start":
        return {
          owned: true,
          result: await service.start({ args: request.args as ChatLaunchArgs, originUrl }),
          projectIdentity: normalizeGitRemoteIdentity(originUrl),
        };
      case "list": {
        const projectIdentity = normalizeGitRemoteIdentity(originUrl);
        // No project, or one with no origin: it has no cloud launches.
        return { owned: true, result: projectIdentity ? service.list({ originUrl: projectIdentity }) : [], projectIdentity };
      }
      case "get":
      case "cancel":
      case "retry":
      case "startNow":
      case "queueMessage":
      case "completeClient": {
        const launchId = launchIdOf(request.args);
        if (!launchId || !service.owns(launchId)) return { owned: false };
        const idArgs = request.args as ChatLaunchIdArgs;
        switch (request.method) {
          case "get":
            return { owned: true, result: await service.get(idArgs) };
          case "cancel":
            return { owned: true, result: await service.cancel(idArgs) };
          case "retry":
            return { owned: true, result: await service.retry(idArgs) };
          case "startNow":
            return { owned: true, result: await service.startNow(idArgs) };
          case "queueMessage":
            return { owned: true, result: await service.queueMessage(request.args as ChatLaunchQueueMessageArgs) };
          case "completeClient":
            return { owned: true, result: await service.completeClient(request.args as ChatLaunchCompleteClientArgs) };
        }
        return { owned: false };
      }
      default:
        throw new Error("Unknown ADE Cloud launch call.");
    }
  });

  app.once("will-quit", () => service.dispose());
  return service;
}
