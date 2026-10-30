import fs from "node:fs";
import path from "node:path";

import {
  resolveMachineAdeLayout,
  resolvePersonalChatsStateRoot,
} from "../../../../../ade-cli/src/services/projects/machineLayout";
import { ProjectRegistry } from "../../../../../ade-cli/src/services/projects/projectRegistry";
import { resolveAdeLayout } from "../../../shared/adeLayout";
import type {
  DatabaseCopyDeleteResult,
  DatabaseCopyInfo,
  LocalDatabaseKind,
} from "../../../shared/types/startupRecovery";
import type { Logger } from "../logging/logger";
import { writeDbCompatRecord } from "../state/dbCompatRecord";
import { parseDatabaseCopyName, versionLabel, type GoBackPlan } from "./goBackPlan";

/**
 * The database copies on this computer, and the two things done with them:
 * deleting one (Settings › Advanced) and putting the copies of one move back
 * ("Go back" in the "ADE could not start" window).
 *
 * Everything here is local disk. It never routes to another machine: each
 * machine keeps its own copies beside its own databases.
 */

export type LocalDatabase = {
  kind: LocalDatabaseKind;
  /** Words for a sentence: "this computer's ADE data", a project's name. */
  label: string;
  dbPath: string;
};

/**
 * Every database on this computer: the machine's, the personal chats', and
 * each registered project's. Reads the project registry, one small file.
 */
export function listLocalDatabases(env: NodeJS.ProcessEnv = process.env): LocalDatabase[] {
  const layout = resolveMachineAdeLayout(env);
  const databases: LocalDatabase[] = [
    { kind: "machine", label: "this computer's ADE data", dbPath: path.join(layout.adeDir, "ade.db") },
    // Personal chats run a runtime of their own on this state root.
    {
      kind: "personal",
      label: "your personal chats",
      dbPath: resolveAdeLayout(resolvePersonalChatsStateRoot(layout)).dbPath,
    },
  ];
  for (const project of new ProjectRegistry(layout).list()) {
    databases.push({
      kind: "project",
      label: project.displayName || path.basename(project.rootPath),
      dbPath: resolveAdeLayout(project.rootPath).dbPath,
    });
  }
  return databases;
}

/**
 * The files that make up one SQLite database on disk. A copy written by
 * SQLite's backup is one file, but a database kept aside by "Go back" is moved
 * as it was, journal files included, so nothing in its WAL is lost.
 */
const SIDE_FILES = ["-wal", "-shm", "-journal"] as const;

function fileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

/** Newest first. Reads one folder. */
export function listDatabaseCopies(database: LocalDatabase): DatabaseCopyInfo[] {
  const directory = path.dirname(database.dbPath);
  const databaseFileName = path.basename(database.dbPath);
  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch {
    return [];
  }
  const copies: DatabaseCopyInfo[] = [];
  for (const fileName of names) {
    const parsed = parseDatabaseCopyName(databaseFileName, fileName);
    if (!parsed) continue;
    const copyPath = path.join(directory, fileName);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(copyPath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    copies.push({
      path: copyPath,
      fileName,
      databaseKind: database.kind,
      databaseLabel: database.label,
      databasePath: database.dbPath,
      toVersion: parsed.toVersion,
      fromVersion: parsed.fromVersion,
      takenAt: stat.mtimeMs,
      sizeBytes: stat.size + SIDE_FILES.reduce((sum, side) => sum + fileSize(`${copyPath}${side}`), 0),
    });
  }
  return copies.sort((left, right) => right.takenAt - left.takenAt);
}

export function listAllDatabaseCopies(databases: readonly LocalDatabase[]): DatabaseCopyInfo[] {
  return databases
    .flatMap((database) => listDatabaseCopies(database))
    .sort((left, right) => right.takenAt - left.takenAt);
}

/**
 * Deletes a copy and the journal files beside it. Only a path that is a copy
 * on this computer right now: the renderer names it, so it is checked against
 * a fresh listing rather than trusted.
 */
export function deleteDatabaseCopy(args: {
  copyPath: string;
  databases: readonly LocalDatabase[];
  logger: Pick<Logger, "info" | "warn">;
}): DatabaseCopyDeleteResult {
  const listed = listAllDatabaseCopies(args.databases).find((copy) => copy.path === args.copyPath);
  if (!listed) return { deleted: false, reason: "That copy is no longer on this computer." };
  try {
    for (const side of SIDE_FILES) fs.rmSync(`${listed.path}${side}`, { force: true });
    fs.rmSync(listed.path);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    args.logger.warn("startupRecovery.database_copy_delete_failed", { copy: listed.path, error: reason });
    return { deleted: false, reason: "ADE couldn't delete that copy. Close anything that has it open and try again." };
  }
  args.logger.info("startupRecovery.database_copy_deleted", {
    copy: listed.path,
    toVersion: listed.toVersion,
    fromVersion: listed.fromVersion,
    sizeBytes: listed.sizeBytes,
  });
  return { deleted: true };
}

const RENAME_ATTEMPTS = 5;

/** Windows refuses a rename for a moment after a process lets the file go. */
function renameRetrying(from: string, to: string): void {
  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (attempt >= RENAME_ATTEMPTS || (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY")) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * attempt);
    }
  }
}

function existingParts(basePath: string): string[] {
  return ["", ...SIDE_FILES].filter((side) => fs.existsSync(`${basePath}${side}`));
}

/** Moves a database and its journal files. Never onto a file that exists. */
function moveDatabaseFiles(from: string, to: string, parts: readonly string[]): void {
  const moved: string[] = [];
  try {
    for (const side of parts) {
      if (fs.existsSync(`${to}${side}`)) throw new Error(`${to}${side} already exists.`);
      renameRetrying(`${from}${side}`, `${to}${side}`);
      moved.push(side);
    }
  } catch (error) {
    for (const side of moved.reverse()) {
      try { renameRetrying(`${to}${side}`, `${from}${side}`); } catch { /* reported by the throw below */ }
    }
    throw error;
  }
}

/**
 * Where the current database is kept: the copy the target version would have
 * taken itself on its first open (`pre-<target>-from-<running>.bak`), so the
 * Settings list reads it as one more copy and the target build does not take
 * another. A second go-back between the same two versions gets `_2`.
 */
function keepPathFor(dbPath: string, targetVersion: string, runningVersion: string): string {
  const base = `${dbPath}.pre-${versionLabel(targetVersion)}-from-${versionLabel(runningVersion)}`;
  for (let index = 1; ; index += 1) {
    const candidate = `${base}${index === 1 ? "" : `_${index}`}.bak`;
    if (existingParts(candidate).length === 0) return candidate;
  }
}

export type DatabaseRestoreResult = { dbPath: string; restoredFrom: string; keptAs: string | null };

/**
 * Puts back the copies of a go-back plan. Every process that has these files
 * open must be stopped first; on Windows a held file makes the rename fail,
 * which stops the restore before anything changed.
 *
 * Moves only, never copies or overwrites (T3 #20906): the current database,
 * even one ADE cannot open, is kept as another copy, then the copy takes its
 * place. Renames are instant and need no free space, so a large project does
 * not stall the install that waits on this. One database that fails to move is
 * put back as it was and stops the restore; the ones already restored stay
 * restored, and the error says so.
 */
export function restoreDatabaseCopies(args: {
  plan: GoBackPlan;
  runningVersion: string;
  logger: Logger;
}): DatabaseRestoreResult[] {
  const { plan, runningVersion, logger } = args;
  for (const entry of plan.restores) {
    if (!fs.existsSync(entry.copy.path)) {
      throw new Error(`The copy of ${entry.label} is gone: ${entry.copy.path}`);
    }
  }
  const results: DatabaseRestoreResult[] = [];
  for (const entry of plan.restores) {
    const { dbPath } = entry;
    const liveParts = existingParts(dbPath);
    const keptAs = liveParts.length > 0 ? keepPathFor(dbPath, plan.targetVersion, runningVersion) : null;
    try {
      if (keptAs) {
        moveDatabaseFiles(dbPath, keptAs, liveParts);
        logger.info("startupRecovery.database_kept", { dbPath, keptAs, files: liveParts.length });
      }
      try {
        moveDatabaseFiles(entry.copy.path, dbPath, existingParts(entry.copy.path));
      } catch (error) {
        if (keptAs) moveDatabaseFiles(keptAs, dbPath, liveParts);
        throw error;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("startupRecovery.database_restore_failed", {
        dbPath,
        copy: entry.copy.path,
        restoredBefore: results.length,
        error: message,
      });
      throw new Error(
        results.length > 0
          ? `ADE put back ${results.length} of ${plan.restores.length} databases, then couldn't move ${entry.label}: ${message}`
          : `ADE couldn't move ${entry.label}: ${message}`,
      );
    }
    // The record beside the file names the build that last opened it. The
    // target opens it next, and it already has the current file kept.
    writeDbCompatRecord(dbPath, plan.targetVersion, logger);
    logger.info("startupRecovery.database_restored", {
      dbPath,
      restoredFrom: entry.copy.path,
      keptAs,
      takenAt: new Date(entry.copy.takenAt).toISOString(),
    });
    results.push({ dbPath, restoredFrom: entry.copy.path, keptAs });
  }
  return results;
}
