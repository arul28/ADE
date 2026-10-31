import { ipcMain, shell } from "electron";

import { IPC } from "../../../shared/ipc";
import type { DatabaseCopyDeleteResult, DatabaseCopyInfo } from "../../../shared/types/startupRecovery";
import { isTrustedAdeRendererSenderOrWarn } from "../ipc/trustedRendererSender";
import type { Logger } from "../logging/logger";
import { deleteDatabaseCopy, listAllDatabaseCopies, listLocalDatabases } from "./databaseCopies";

/**
 * Settings › Advanced › Database copies.
 *
 * No remote pin, on purpose: these are files on THIS computer, beside its own
 * databases, and Settings shows the section only for This computer. Another
 * machine's copies are on that machine.
 *
 * There is no restore here. Putting a copy back while ADE runs would swap a
 * database under the brain that has it open; "Go back" in the "ADE could not
 * start" window does it after the brain has stopped, as part of installing
 * the version the copy belongs to.
 */
export function registerDatabaseCopiesIpc(args: { logger: Pick<Logger, "info" | "warn"> }): void {
  const { logger } = args;
  const guard = (event: Electron.IpcMainInvokeEvent, channel: string): void => {
    if (!isTrustedAdeRendererSenderOrWarn(event, logger, channel)) {
      throw new Error("Database copies are only available to the ADE window.");
    }
  };
  const requestedPath = (payload: unknown): string => {
    const value = (payload as { path?: unknown } | null)?.path;
    if (typeof value !== "string" || !value.trim()) throw new Error("No copy was named.");
    return value;
  };

  ipcMain.handle(IPC.databaseCopiesList, (event): DatabaseCopyInfo[] => {
    guard(event, IPC.databaseCopiesList);
    return listAllDatabaseCopies(listLocalDatabases());
  });

  ipcMain.handle(IPC.databaseCopiesReveal, (event, payload: unknown): { revealed: boolean } => {
    guard(event, IPC.databaseCopiesReveal);
    const copyPath = requestedPath(payload);
    // Only a path that is a copy right now; the renderer names it.
    const listed = listAllDatabaseCopies(listLocalDatabases()).some((copy) => copy.path === copyPath);
    if (!listed) return { revealed: false };
    shell.showItemInFolder(copyPath);
    return { revealed: true };
  });

  ipcMain.handle(IPC.databaseCopiesDelete, (event, payload: unknown): DatabaseCopyDeleteResult => {
    guard(event, IPC.databaseCopiesDelete);
    return deleteDatabaseCopy({ copyPath: requestedPath(payload), databases: listLocalDatabases(), logger });
  });
}
