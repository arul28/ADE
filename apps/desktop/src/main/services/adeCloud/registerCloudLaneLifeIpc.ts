import path from "node:path";
import { app, ipcMain } from "electron";
import type { CloudLaneChangeTierArgs, CloudLaneLifeCallRequest } from "../../../shared/cloudLaneLife";
import { IPC } from "../../../shared/ipc";
import type { RemoteRuntimeActionRequest } from "../../../shared/types";
import type { RuntimeBridgeRegistration } from "../ipc/runtimeBridge";
import { isTrustedAdeRendererSenderOrWarn } from "../ipc/trustedRendererSender";
import type { Logger } from "../logging/logger";
import { isRecord } from "../shared/utils";
import { sendToAllWindows } from "./broadcast";
import { createCloudLaneLife, type CloudLaneLife } from "./cloudLaneLife";
import { captureCloudLaneAnalytics, type CloudLaneAnalyticsCapture } from "./cloudLaneAnalytics";
import type { CloudCopyDeps } from "./cloudMachineCopy";
import type { createCloudMachines } from "./cloudMachines";
import type { CloudProvider } from "./cloudProvider";
import type { MachineConnector } from "../machines/machineConnector";
import type { CloudLaneBackup } from "../../../../../account-directory/src/cloud/contract";

function textArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required.`);
  return value.trim();
}

/**
 * Hosts the life of ADE Cloud lane computers (`cloudLaneLife.ts`) in this
 * app's main process and answers `IPC.cloudLaneLifeCall`. Account-level: each
 * call names a computer of the account, never a project pin. A tier change's
 * steps go to every window on `IPC.cloudLaneJobEvent`.
 */
export function registerCloudLaneLifeIpc(args: {
  machines: ReturnType<typeof createCloudMachines>;
  copyDeps: CloudCopyDeps;
  client: () => Promise<CloudProvider>;
  forgetMachineConnections: (machine: { machineKey: string | null; instanceId: string }) => void;
  /** Contract C2: reaches the lane's computer by its machine key. */
  machineConnector: MachineConnector;
  remote: RuntimeBridgeRegistration["remoteForMain"];
  /** The account's lane backups of one computer: an asleep computer's work check reads them with no wake. */
  laneBackups?: (machineKey: string) => Promise<CloudLaneBackup[]>;
  /** One runtime action in a project of this computer (a chat here asked for the size); null where there is no local runtime. */
  callLocalAction?: ((rootPath: string, request: RemoteRuntimeActionRequest) => Promise<unknown>) | null;
  /** One coarse outcome per freed lane (cloudLaneAnalytics.ts). */
  analytics?: CloudLaneAnalyticsCapture;
  logger: Logger;
}): CloudLaneLife {
  const { logger, remote } = args;
  const connectMachine = async (machineKey: string): Promise<{ targetId: string }> => {
    // Contract C2: a moved lane's new computer is paired once (woken first
    // when asleep); after that its saved connection is reused.
    const result = await args.machineConnector.connect(machineKey);
    if (!result.ok) throw new Error(result.message);
    if (result.address.kind !== "remote") throw new Error("The lane's computer is this computer.");
    return { targetId: result.address.targetId };
  };
  const life = createCloudLaneLife({
    recordsDir: path.join(app.getPath("userData"), "cloud-lane-jobs"),
    machines: args.machines,
    client: args.client,
    copyDeps: args.copyDeps,
    forgetMachineConnections: args.forgetMachineConnections,
    connectMachine,
    // How a change an agent asked for ended, to that chat's own machine by its pin.
    chatCalls: {
      callAction: async (pin, request) => {
        if (pin.kind === "remote") return await remote.callAction(pin, request);
        if (!args.callLocalAction) throw new Error("This ADE has no local runtime to tell the chat.");
        return await args.callLocalAction(pin.rootPath, request);
      },
      machineKeyOf: (targetId) => remote.machineKeyOf(targetId),
      resolveBinding: (targetId, projectId, rootPath) => remote.resolveBinding(targetId, projectId, rootPath),
    },
    listProjects: (targetId) => remote.projects(targetId),
    emit: (job) => sendToAllWindows(IPC.cloudLaneJobEvent, job),
    changed: () => sendToAllWindows(IPC.cloudStatusChanged),
    laneBackups: args.laneBackups ?? null,
    logger: { info: (event, meta) => logger.info(event, meta), warn: (event, meta) => logger.warn(event, meta) },
  });
  life.load();

  ipcMain.handle(IPC.cloudLaneLifeCall, async (event, raw: unknown): Promise<unknown> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.cloudLaneLifeCall)) throw new Error("ADE can't do that from here.");
    const request = (isRecord(raw) ? raw : {}) as Partial<CloudLaneLifeCallRequest>;
    const callArgs = isRecord(request.args) ? request.args : {};
    switch (request.method) {
      case "workState":
        return await life.workState({ instanceId: textArg(callArgs, "instanceId") });
      case "deleteLane": {
        const keepChats = callArgs.keepChats === true;
        const onlyChats = Array.isArray(callArgs.onlyChats)
          ? callArgs.onlyChats.filter((id): id is string => typeof id === "string" && id.trim().length > 0).map((id) => id.trim())
          : undefined;
        const deleted = await life.deleteLane({ instanceId: textArg(callArgs, "instanceId"), skipCheck: callArgs.skipCheck === true, keepChats, onlyChats }).catch((error: unknown) => {
          captureCloudLaneAnalytics(args.analytics, "desktop", "cloud_lane_deleted", "failed");
          throw error;
        });
        // Whether people keep a deleted lane's chats tells whether "delete them" is the right default.
        captureCloudLaneAnalytics(args.analytics, "desktop", "cloud_lane_deleted", !deleted.ok ? "failed" : keepChats ? "kept" : deleted.chatsKept ? "partial" : "completed");
        return deleted;
      }
      case "freeLane": {
        const freed = await life.freeLane({ instanceId: textArg(callArgs, "instanceId") }).catch((error: unknown) => {
          captureCloudLaneAnalytics(args.analytics, "desktop", "cloud_lane_freed", "failed");
          throw error;
        });
        captureCloudLaneAnalytics(args.analytics, "desktop", "cloud_lane_freed", freed.ok ? "completed" : "failed");
        return freed;
      }
      case "lanesWithoutComputer":
        return await life.lanesWithoutComputer();
      case "forgetLaneWithoutComputer":
        return await life.forgetLaneWithoutComputer({ laneId: textArg(callArgs, "laneId") });
      case "changeTier":
        return await life.changeTier(callArgs as CloudLaneChangeTierArgs);
      case "listJobs":
        return life.listJobs();
      case "retryJob":
        return await life.retryJob({ jobId: textArg(callArgs, "jobId") });
      case "cancelJob":
        return await life.cancelJob({ jobId: textArg(callArgs, "jobId") });
      case "dismissJob":
        return await life.dismissJob({ jobId: textArg(callArgs, "jobId") });
      default:
        throw new Error("Unknown ADE Cloud lane call.");
    }
  });

  app.once("will-quit", () => life.dispose());
  return life;
}
