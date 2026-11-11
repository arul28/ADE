import path from "node:path";
import { app, ipcMain } from "electron";
import type { CloudLaneChangeTierArgs, CloudLaneLifeCallRequest } from "../../../shared/cloudLaneLife";
import { IPC } from "../../../shared/ipc";
import type { RuntimeBridgeRegistration } from "../ipc/runtimeBridge";
import { isTrustedAdeRendererSenderOrWarn } from "../ipc/trustedRendererSender";
import type { Logger } from "../logging/logger";
import { isRecord } from "../shared/utils";
import { sendToAllWindows } from "./broadcast";
import { createCloudLaneLife, type CloudLaneLife } from "./cloudLaneLife";
import type { CloudCopyDeps } from "./cloudMachineCopy";
import type { createCloudMachines } from "./cloudMachines";
import type { CloudProvider } from "./cloudProvider";

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
  pairMachine: (machineKey: string) => Promise<{ targetId: string }>;
  /** This app's saved target for a machine already paired, or null. */
  targetIdForMachine: (machineKey: string) => string | null;
  remote: RuntimeBridgeRegistration["remoteForMain"];
  logger: Logger;
}): CloudLaneLife {
  const { logger, remote } = args;
  const life = createCloudLaneLife({
    recordsDir: path.join(app.getPath("userData"), "cloud-lane-jobs"),
    machines: args.machines,
    client: args.client,
    copyDeps: args.copyDeps,
    forgetMachineConnections: args.forgetMachineConnections,
    connectMachine: async (machineKey) => {
      // A moved lane's new computer is paired once; after that its saved target is reused.
      const targetId = args.targetIdForMachine(machineKey) ?? (await args.pairMachine(machineKey)).targetId;
      await remote.connect(targetId);
      return { targetId };
    },
    listProjects: (targetId) => remote.projects(targetId),
    emit: (job) => sendToAllWindows(IPC.cloudLaneJobEvent, job),
    changed: () => sendToAllWindows(IPC.cloudStatusChanged),
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
      case "deleteLane":
        return await life.deleteLane({ instanceId: textArg(callArgs, "instanceId"), skipCheck: callArgs.skipCheck === true });
      case "freeLane":
        return await life.freeLane({ instanceId: textArg(callArgs, "instanceId") });
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
      default:
        throw new Error("Unknown ADE Cloud lane call.");
    }
  });

  app.once("will-quit", () => life.dispose());
  return life;
}
