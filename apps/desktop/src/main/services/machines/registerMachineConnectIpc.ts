import path from "node:path";
import { app, ipcMain } from "electron";
import { configureGoneTargets, setGoneTargetReach } from "./goneTargets";
import { IPC } from "../../../shared/ipc";
import { sameMachineKey, type MachineAddress, type MachineConnectResult } from "../../../shared/machineAddress";
import type { AdeAccountMachinesResult } from "../../../shared/types/account";
import { isTrustedAdeRendererSenderOrWarn } from "../ipc/trustedRendererSender";
import type { Logger } from "../logging/logger";
import { isRecord } from "../shared/utils";
import { createMachineConnector, type MachineConnector, type MachineConnectorDeps } from "./machineConnector";

/**
 * Answers `window.ade.machines` (contract C2, `shared/machineAddress.ts`), and
 * lets pins to a connection that is gone reach their machine again
 * (`goneTargets.ts`). Account level: each call names a machine by its key,
 * never a tab or a pin.
 */
export function registerMachineConnectIpc(args: Omit<MachineConnectorDeps, "logger" | "accountMachine"> & {
  /** The account's machine list; the connector checks a key is on it before a pairing. */
  listAccountMachines: () => Promise<AdeAccountMachinesResult>;
  logger: Logger;
}): MachineConnector {
  const { logger, listAccountMachines, ...connectorDeps } = args;
  configureGoneTargets({
    filePath: path.join(app.getPath("userData"), "gone-machine-connections.json"),
    log: (event, meta) => logger.info(event, meta),
  });
  const connector = createMachineConnector({
    ...connectorDeps,
    accountMachine: async (machineKey) => {
      const list = await listAccountMachines();
      if (list.state !== "ok") throw new Error(list.message ?? "Your account's computers can't be read right now.");
      const row = list.machines.find((machine) => sameMachineKey(machine.machineKey, machineKey));
      return row ? { name: row.customName?.trim() || row.name } : null;
    },
    logger: { info: (event, meta) => logger.info(event, meta), warn: (event, meta) => logger.warn(event, meta) },
  });
  // A call through a pin to a saved connection wakes its cloud computer; one
  // through a gone connection does the same (runtimeBridge decides which calls may).
  setGoneTargetReach(async (machineKey) => {
    const result = await connector.connect(machineKey);
    return result.ok ? { ok: true } : { ok: false, message: result.message };
  });

  ipcMain.handle(IPC.machinesConnect, async (event, raw: unknown): Promise<MachineConnectResult> => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.machinesConnect)) throw new Error("ADE can't do that from here.");
    const request = isRecord(raw) ? raw : {};
    const machineKey = typeof request.machineKey === "string" ? request.machineKey : "";
    return await connector.connect(machineKey, { connect: request.connect !== false });
  });

  ipcMain.handle(IPC.machinesAddressFor, (event, raw: unknown): MachineAddress | null => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, IPC.machinesAddressFor)) throw new Error("ADE can't do that from here.");
    const request = isRecord(raw) ? raw : {};
    return connector.addressFor(typeof request.machineKey === "string" ? request.machineKey : "");
  });

  return connector;
}
