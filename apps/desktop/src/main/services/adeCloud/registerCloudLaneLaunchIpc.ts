import fs from "node:fs/promises";
import path from "node:path";
import { app, ipcMain } from "electron";
import type { CloudLaneLaunchCallRequest, CloudLaneLaunchCallResult } from "../../../shared/cloudLaneLaunch";
import { normalizeGitRemoteIdentity } from "../../../shared/crossMachineHandoff";
import { IPC } from "../../../shared/ipc";
import type {
  AgentChatFileRef,
  ChatLaunchArgs,
  ChatLaunchCompleteClientArgs,
  ChatLaunchEvent,
  ChatLaunchIdArgs,
  ChatLaunchQueueMessageArgs,
  OpenProjectBinding,
} from "../../../shared/types";
import type { RuntimeBridgeRegistration } from "../ipc/runtimeBridge";
import { resolveProjectRepoOrigin } from "../projects/projectRepoOrigin";
import { isTrustedAdeRendererSenderOrWarn } from "../ipc/trustedRendererSender";
import type { Logger } from "../logging/logger";
import { isRecord } from "../shared/utils";
import { sendToAllWindows } from "./broadcast";
import type { CloudMachineCreatorDeps } from "./cloudMachineCreator";
import { createCloudLaneLaunchService, type CloudLaneLaunchService } from "./cloudLaneLaunchService";
import { cloudLaunchFilesDir } from "./cloudLaneLaunchRecords";
import { copyLaunchFilesFromSource } from "./cloudLaunchFileCopies";
import { requireLaunchId } from "./cloudLaneLaunchSteps";
import { createCtoCloudHomeService } from "./ctoCloudHomeService";
import type { CtoCloudHomeCallRequest } from "../../../shared/ctoCloudHome";
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
  /** This app's update track: a launch's computer follows the same one. */
  updateChannel?: () => "stable" | "beta" | null;
  logger: Logger;
}): CloudLaneLaunchService {
  const { remote, logger } = args;
  const { pendingCreates: _pendingCreates, ...creator } = args.machineCreatorDeps;
  const countOutcome = cloudLaneLaunchOutcomes(args.analytics, "desktop");
  const recordsDir = path.join(app.getPath("userData"), "cloud-lane-launches");
  const service = createCloudLaneLaunchService({
    recordsDir,
    logger,
    emit: (event: ChatLaunchEvent) => {
      sendToAllWindows(IPC.cloudLaneLaunchEvent, event);
      countOutcome(event);
    },
    creator,
    ...(args.updateChannel ? { updateChannel: args.updateChannel } : {}),
    removeAccountMachine: args.removeAccountMachine,
    forgetMachineConnections: args.forgetMachineConnections,
    uploadAttachment: (binding, input) => remote.uploadAttachment(binding, input),
    pairMachine: args.pairMachine,
    connect: async (targetId) => {
      await remote.connect(targetId);
      return true;
    },
    listProjects: (targetId) => remote.projects(targetId),
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

  /**
   * The composer saves a draft's files on the machine the tab's project is
   * open on, and this app runs the launch: files saved on another machine are
   * copied here first (`cloudLaunchFileCopies.ts`).
   */
  const copyFilesFromSource = async (
    request: Partial<CloudLaneLaunchCallRequest>,
    launchId: string,
    attachments: AgentChatFileRef[] | undefined,
  ): Promise<Record<string, string>> => {
    const source = isRecord(request.source) && isRecord(request.source.remote) ? request.source.remote : null;
    const targetId = typeof source?.targetId === "string" ? source.targetId : null;
    const projectId = typeof source?.projectId === "string" ? source.projectId : null;
    const rootPath = typeof source?.rootPath === "string" ? source.rootPath : null;
    let binding: Promise<OpenProjectBinding & { kind: "remote" }> | null = null;
    return await copyLaunchFilesFromSource({
      attachments,
      dir: cloudLaunchFilesDir(recordsDir, launchId),
      readSourceImage: targetId && projectId && rootPath
        ? async (filePath) => {
          binding ??= resolveSourceBinding(targetId, projectId, rootPath);
          const answer = await remote.callAction(await binding, { domain: "chat", action: "getImageDataUrl", args: { path: filePath } });
          const dataUrl = isRecord(answer) ? answer.dataUrl : null;
          if (typeof dataUrl !== "string") throw new Error("the machine sent no image");
          return dataUrl;
        }
        : null,
    });
  };
  const resolveSourceBinding = async (targetId: string, projectId: string, rootPath: string) => {
    await remote.connect(targetId);
    return await remote.resolveBinding(targetId, projectId, rootPath);
  };

  /** Starts not yet held by the service (their files still copying), by launch id. */
  const starting = new Map<string, Promise<CloudLaneLaunchCallResult>>();
  const startLaunch = async (
    request: Partial<CloudLaneLaunchCallRequest>,
    launchArgs: ChatLaunchArgs,
    launchId: string,
  ): Promise<CloudLaneLaunchCallResult> => {
    // A start this app already holds (a second Send) needs no copies.
    const copying = !service.owns(launchId);
    try {
      const localCopies = copying
        ? await copyFilesFromSource(request, launchId, [
          ...(launchArgs.attachments ?? []),
          ...(launchArgs.chat?.message?.attachments ?? []),
        ])
        : {};
      const originUrl = await readOrigin(request);
      return {
        owned: true,
        result: await service.start({ args: launchArgs, originUrl, localCopies }),
        projectIdentity: normalizeGitRemoteIdentity(originUrl),
      };
    } catch (error) {
      // Refused before a record took the copies: nothing else removes them.
      if (copying && !service.owns(launchId)) {
        await fs.rm(cloudLaunchFilesDir(recordsDir, launchId), { recursive: true, force: true }).catch((rmError: unknown) => {
          logger.warn("cloud_lane_launch.files_rollback_failed", { launchId, error: rmError instanceof Error ? rmError.message : String(rmError) });
        });
      }
      throw error;
    }
  };

  ipcMain.handle(IPC.cloudLaneLaunchCall, async (event, raw: unknown): Promise<CloudLaneLaunchCallResult> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.cloudLaneLaunchCall)) {
      throw new Error("ADE can't do that from here.");
    }
    const request = (isRecord(raw) ? raw : {}) as Partial<CloudLaneLaunchCallRequest>;
    switch (request.method) {
      case "start": {
        const launchArgs = request.args as ChatLaunchArgs;
        const launchId = requireLaunchId(launchArgs?.launchId);
        // A second Send while the first still copies: one start, one set of copies.
        const already = starting.get(launchId);
        if (already) return await already;
        const run = startLaunch(request, launchArgs, launchId);
        starting.set(launchId, run);
        try {
          return await run;
        } finally {
          if (starting.get(launchId) === run) starting.delete(launchId);
        }
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
        // A start still copying its files: a Cancel pressed meanwhile waits for it, then cancels the launch it made.
        const pending = launchId && !service.owns(launchId) ? starting.get(launchId.trim().toLowerCase()) : undefined;
        if (pending) await pending.catch(() => undefined);
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
          case "queueMessage": {
            const queued = request.args as ChatLaunchQueueMessageArgs;
            const localCopies = await copyFilesFromSource(request, requireLaunchId(launchId), queued.attachments);
            return { owned: true, result: await service.queueMessage(queued, localCopies) };
          }
          case "completeClient":
            return { owned: true, result: await service.completeClient(request.args as ChatLaunchCompleteClientArgs) };
        }
        return { owned: false };
      }
      default:
        throw new Error("Unknown ADE Cloud launch call.");
    }
  });

  // The CTO's home on ADE Cloud: a computer made the way Settings' "New cloud
  // machine" makes one (no lane), then the repository cloned there.
  const ctoCloudHome = createCtoCloudHomeService({
    recordsDir: path.join(app.getPath("userData"), "cto-cloud-homes"),
    logger,
    emit: (event) => sendToAllWindows(IPC.ctoCloudHomeEvent, event),
    // With its note of computers being made: one a quit cut off is found and deleted on the next start.
    creator: args.machineCreatorDeps,
    removeAccountMachine: args.removeAccountMachine,
    forgetMachineConnections: args.forgetMachineConnections,
    pairMachine: args.pairMachine,
    connect: async (targetId) => {
      await remote.connect(targetId);
      return true;
    },
    listProjects: (targetId) => remote.projects(targetId),
    defaultParentDir: (targetId) => remote.defaultParentDir(targetId),
    cloneProject: (targetId, input) => remote.cloneProject(targetId, input),
    resolveBinding: (targetId, projectId, rootPath) => remote.resolveBinding(targetId, projectId, rootPath),
    ...(args.gitPreflight ? { gitPreflight: args.gitPreflight } : {}),
  });
  ipcMain.handle(IPC.ctoCloudHomeCall, async (event, raw: unknown) => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.ctoCloudHomeCall)) {
      throw new Error("ADE can't do that from here.");
    }
    const request = (isRecord(raw) ? raw : {}) as Partial<CtoCloudHomeCallRequest>;
    const callArgs: Record<string, unknown> = isRecord(request.args) ? request.args : {};
    const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
    switch (request.method) {
      case "start":
        return await ctoCloudHome.start({ originUrl: text(callArgs.originUrl) });
      case "get":
        return ctoCloudHome.get({ originUrl: text(callArgs.originUrl) });
      case "retry":
        return await ctoCloudHome.retry({ jobId: text(callArgs.jobId) ?? "" });
      case "cancel":
        return await ctoCloudHome.cancel({ jobId: text(callArgs.jobId) ?? "" });
      case "finish":
        return ctoCloudHome.finish({ jobId: text(callArgs.jobId) ?? "" });
      default:
        throw new Error("Unknown CTO cloud home call.");
    }
  });

  app.once("will-quit", () => {
    service.dispose();
    ctoCloudHome.dispose();
  });
  return service;
}
