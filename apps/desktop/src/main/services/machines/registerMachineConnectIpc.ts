import { ipcMain } from "electron";
import { IPC } from "../../../shared/ipc";
import type { MachineAddress, MachineConnectResult } from "../../../shared/machineAddress";
import { isTrustedAdeRendererSenderOrWarn } from "../ipc/trustedRendererSender";
import type { Logger } from "../logging/logger";
import { isRecord } from "../shared/utils";
import { createMachineConnector, type MachineConnector, type MachineConnectorDeps } from "./machineConnector";

/**
 * Answers `window.ade.machines` (contract C2, `shared/machineAddress.ts`).
 * Account level: each call names a machine by its key, never a tab or a pin.
 */
export function registerMachineConnectIpc(args: Omit<MachineConnectorDeps, "logger"> & { logger: Logger }): MachineConnector {
  const { logger } = args;
  const connector = createMachineConnector({
    ...args,
    logger: { info: (event, meta) => logger.info(event, meta), warn: (event, meta) => logger.warn(event, meta) },
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
