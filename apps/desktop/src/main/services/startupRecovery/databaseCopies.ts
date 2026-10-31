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
      kept: parsed.kept,
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
    // The copy first: if it cannot go, its journal files stay with it.
    fs.rmSync(listed.path);
    for (const side of SIDE_FILES) fs.rmSync(`${listed.path}${side}`, { force: true });
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
 * Where the current database is set aside: `pre-<target>-from-<running>_kept.bak`
 * (`_kept2`, … on a repeat). The `_kept` mark keeps it out of the way back and
 * out of the "superseded" cleanup; it goes a week after going back worked.
 */
function keepPathFor(dbPath: string, targetVersion: string, runningVersion: string): string {
  const base = `${dbPath}.pre-${versionLabel(targetVersion)}-from-${versionLabel(runningVersion)}_kept`;
  for (let index = 1; ; index += 1) {
    const candidate = `${base}${index === 1 ? "" : index}.bak`;
    if (existingParts(candidate).length === 0) return candidate;
  }
}

export type DatabaseRestoreResult = { dbPath: string; restoredFrom: string; keptAs: string | null };

/**
 * A restore that did not finish. `rolledBack`: every database is exactly as
 * it was before the restore began. `copyMissing`: a copy disappeared after
 * the person agreed, so nothing was moved.
 */
export class DatabaseRestoreError extends Error {
  constructor(message: string, readonly rolledBack: boolean, readonly copyMissing = false) {
    super(message);
    this.name = "DatabaseRestoreError";
  }
}

type DoneMove = { entry: GoBackPlan["restores"][number]; liveParts: string[]; keptAs: string | null; copyParts: string[] };

/**
 * Puts back the copies of a go-back plan, all or nothing. Every process that
 * has these files open must be stopped first; on Windows a held file makes a
 * rename fail, which is caught here.
 *
 * Moves only, never copies or overwrites (T3 #20906): the current database,
 * even one ADE cannot open, is set aside whole (journal files too), then the
 * copy takes its place. Renames are instant and need no free space, so a large
 * project does not stall the install that waits on this. When one database
 * fails to move, every database already moved is moved back, and the error
 * says whether that worked. Records are written only once every move is done.
 */
export function restoreDatabaseCopies(args: {
  plan: GoBackPlan;
  runningVersion: string;
  logger: Logger;
}): DatabaseRestoreResult[] {
  const { plan, runningVersion, logger } = args;
  for (const entry of plan.restores) {
    if (!fs.existsSync(entry.copy.path)) {
      logger.warn("startupRecovery.database_copy_missing", { dbPath: entry.dbPath, copy: entry.copy.path });
      throw new DatabaseRestoreError(`The copy of ${entry.label} is gone: ${entry.copy.path}`, true, true);
    }
  }
  const done: DoneMove[] = [];
  for (const entry of plan.restores) {
    const { dbPath } = entry;
    const liveParts = existingParts(dbPath);
    const copyParts = existingParts(entry.copy.path);
    const keptAs = liveParts.length > 0 ? keepPathFor(dbPath, plan.targetVersion, runningVersion) : null;
    try {
      if (keptAs) moveDatabaseFiles(dbPath, keptAs, liveParts);
      try {
        moveDatabaseFiles(entry.copy.path, dbPath, copyParts);
      } catch (error) {
        if (keptAs) moveDatabaseFiles(keptAs, dbPath, liveParts);
        throw error;
      }
      logger.info("startupRecovery.database_moved", { dbPath, keptAs, restoredFrom: entry.copy.path });
      done.push({ entry, liveParts, keptAs, copyParts });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const rolledBack = undoMoves(done, logger);
      logger.error("startupRecovery.database_restore_failed", {
        dbPath,
        copy: entry.copy.path,
        movedBefore: done.length,
        rolledBack,
        error: message,
      });
      throw new DatabaseRestoreError(`ADE couldn't move ${entry.label}: ${message}`, rolledBack);
    }
  }
  const results: DatabaseRestoreResult[] = [];
  for (const { entry, keptAs } of done) {
    // The target opens it next. `cleanOpen: false`: it has not opened it yet,
    // so its one-day clock starts at that open, not now.
    writeDbCompatRecord(entry.dbPath, plan.targetVersion, logger, new Date(), { cleanOpen: false });
    logger.info("startupRecovery.database_restored", {
      dbPath: entry.dbPath,
      restoredFrom: entry.copy.path,
      keptAs,
      takenAt: new Date(entry.copy.takenAt).toISOString(),
    });
    results.push({ dbPath: entry.dbPath, restoredFrom: entry.copy.path, keptAs });
  }
  return results;
}

/** Moves finished databases back, newest first. True when all of them went back. */
function undoMoves(done: readonly DoneMove[], logger: Logger): boolean {
  let ok = true;
  for (const move of [...done].reverse()) {
    try {
      moveDatabaseFiles(move.entry.dbPath, move.entry.copy.path, move.copyParts);
      if (move.keptAs) moveDatabaseFiles(move.keptAs, move.entry.dbPath, move.liveParts);
      logger.info("startupRecovery.database_move_undone", { dbPath: move.entry.dbPath });
    } catch (error) {
      ok = false;
      logger.error("startupRecovery.database_move_undo_failed", {
        dbPath: move.entry.dbPath,
        keptAs: move.keptAs,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return ok;
}
