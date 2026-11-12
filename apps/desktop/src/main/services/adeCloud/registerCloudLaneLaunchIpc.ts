import path from "node:path";
import { app, ipcMain } from "electron";
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
import { resolveProjectRepoOrigin } from "../projects/projectRepoOrigin";
import { isTrustedAdeRendererSenderOrWarn } from "../ipc/trustedRendererSender";
import type { Logger } from "../logging/logger";
import { isRecord } from "../shared/utils";
import { sendToAllWindows } from "./broadcast";
import type { CloudMachineCreatorDeps } from "./cloudMachineCreator";
import { createCloudLaneLaunchService, type CloudLaneLaunchService } from "./cloudLaneLaunchService";
import { cloudLaneLaunchOutcomes, type CloudLaneAnalyticsCapture } from "./cloudLaneAnalytics";
import type { CloudGitPreflight } from "../../../shared/cloudGitCredential";

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
  /** Forgets this app's saved connections to a computer a cancel deleted. */
  forgetMachineConnections: (machine: { machineKey: string | null; instanceId: string }) => void;
  pairMachine: (machineKey: string) => Promise<{ targetId: string }>;
  remote: RuntimeBridgeRegistration["remoteForMain"];
  /** How each launch ends, one coarse outcome (cloudLaneAnalytics.ts). */
  analytics?: CloudLaneAnalyticsCapture;
  /**
   * C4 (`registerCloudIpc`'s `gitPreflight`): a start for a private
   * repository with no GitHub sign-in in the account is refused before any
   * computer is made. Unset: no check.
   */
  gitPreflight?: (originUrl: string) => Promise<CloudGitPreflight>;
  logger: Logger;
}): CloudLaneLaunchService {
  const { remote, logger } = args;
  const { pendingCreates: _pendingCreates, ...creator } = args.machineCreatorDeps;
  // The launch kinds each connect's brain advertised, so the hand-off reads
  // what its own connect just saw instead of connecting again.
  const brainLaunchKinds = new Map<string, string[]>();
  const countOutcome = cloudLaneLaunchOutcomes(args.analytics, "desktop");
  const service = createCloudLaneLaunchService({
    recordsDir: path.join(app.getPath("userData"), "cloud-lane-launches"),
    logger,
    emit: (event: ChatLaunchEvent) => {
      sendToAllWindows(IPC.cloudLaneLaunchEvent, event);
      countOutcome(event);
    },
    creator,
    removeAccountMachine: args.removeAccountMachine,
    forgetMachineConnections: args.forgetMachineConnections,
    uploadAttachment: (binding, input) => remote.uploadAttachment(binding, input),
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
    ...(args.gitPreflight ? { gitPreflight: args.gitPreflight } : {}),
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

  // One origin read for `start` and `list`. The project is the repository:
  // the origin the launch carries (what the composer checked before Send),
  // else the tab's stamped origin, this computer's copy (the file, then git
  // itself), or the machine that holds the copy (`resolveProjectRepoOrigin`).
  const readOrigin = async (request: Partial<CloudLaneLaunchCallRequest>): Promise<string | null> => {
    const source = isRecord(request.source) ? request.source : null;
    const carried = isRecord(request.args) && isRecord(request.args.cloud) && typeof request.args.cloud.originUrl === "string"
      ? request.args.cloud.originUrl.trim() || null
      : null;
    const remoteSource = isRecord(source?.remote)
      && typeof source.remote.targetId === "string"
      && typeof source.remote.projectId === "string"
      ? { targetId: source.remote.targetId, projectId: source.remote.projectId }
      : null;
    return await resolveProjectRepoOrigin({
      gitOriginUrl: carried ?? (typeof source?.gitOriginUrl === "string" ? source.gitOriginUrl : null),
      localRootPath: typeof source?.localRootPath === "string" ? source.localRootPath : null,
      remote: remoteSource,
    }, { remoteProjects: (targetId) => remote.projects(targetId), logger });
  };

  ipcMain.handle(IPC.cloudLaneLaunchCall, async (event, raw: unknown): Promise<CloudLaneLaunchCallResult> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.cloudLaneLaunchCall)) {
      throw new Error("ADE can't do that from here.");
    }
    const request = (isRecord(raw) ? raw : {}) as Partial<CloudLaneLaunchCallRequest>;
    switch (request.method) {
      case "start": {
        const originUrl = await readOrigin(request);
        return {
          owned: true,
          result: await service.start({ args: request.args as ChatLaunchArgs, originUrl }),
          projectIdentity: normalizeGitRemoteIdentity(originUrl),
        };
      }
      case "list": {
        const projectIdentity = normalizeGitRemoteIdentity(await readOrigin(request));
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
