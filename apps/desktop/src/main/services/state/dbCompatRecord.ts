import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import { DB_COMPAT_LEVEL, LEGACY_DB_COMPAT_LEVEL } from "../../../shared/releaseCompat";
import { compareUpdateVersions } from "../../../shared/updateVersions";
import type { Logger } from "../logging/logger";
import { readVolumeSpace } from "../storage/volume";
import { parseDatabaseCopyName } from "../startupRecovery/goBackPlan";

/**
 * What the newest build that opened a database left beside it, in
 * `<db>.compat.json`:
 *
 * - `level`: the highest `DB_COMPAT_LEVEL` that ever ran its migrations on
 *   this file. A track switch to a build with a lower level is blocked
 *   (docs/plans/beta-track.md), because that build may not read this file.
 * - `lastOpenedVersion`: the app version that last opened it. A different
 *   version on the next open means an update ran, so the file is copied
 *   before its migrations run.
 * - `firstOpenedAt`: when `lastOpenedVersion` first opened it cleanly. Null
 *   right after "Go back" put a copy in place, until that version opens it.
 *   A day later the update has proven itself for this file, and its copy is
 *   deleted (`clearProvenDatabaseCopies`).
 * - `copiesClearedAt` / `keptClearedAt`: when that cleanup finished for this
 *   version, so later opens do not read the folder again.
 *
 * Beside the file rather than inside it: the guard reads it without opening
 * the database (the brain may hold it), and it describes this copy of the
 * file, not data that syncs to other machines.
 */
export type DbCompatRecord = {
  level: number;
  lastOpenedVersion: string | null;
  updatedAt: string | null;
  firstOpenedAt: string | null;
  copiesClearedAt: string | null;
  keptClearedAt: string | null;
};

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function dbCompatRecordPath(dbPath: string): string {
  return `${dbPath}.compat.json`;
}

/**
 * The record, `null` when none was written (the file was only ever opened by
 * builds from before records existed, whose schema is level 1 by definition),
 * or `"unreadable"` when one exists but cannot be read. An unreadable record
 * must block a switch: the level is unknown (T3 #26288).
 */
export function readDbCompatRecord(dbPath: string): DbCompatRecord | null | "unreadable" {
  let raw: string;
  try {
    raw = fs.readFileSync(dbCompatRecordPath(dbPath), "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT" ? null : "unreadable";
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const level = parsed?.level;
    if (typeof level !== "number" || !Number.isInteger(level) || level < 1) return "unreadable";
    return {
      level,
      lastOpenedVersion: optionalString(parsed.lastOpenedVersion),
      updatedAt: optionalString(parsed.updatedAt),
      firstOpenedAt: optionalString(parsed.firstOpenedAt),
      copiesClearedAt: optionalString(parsed.copiesClearedAt),
      keptClearedAt: optionalString(parsed.keptClearedAt),
    };
  } catch {
    return "unreadable";
  }
}

/** The level a database is at, for the switch guard. */
export function dbCompatLevelOf(dbPath: string): number | "unreadable" {
  if (!fs.existsSync(dbPath)) return 0;
  const record = readDbCompatRecord(dbPath);
  if (record === "unreadable") return "unreadable";
  return record?.level ?? LEGACY_DB_COMPAT_LEVEL;
}

/**
 * Called after migrations ran (a clean open), or by "Go back" after it put a
 * copy in place (`cleanOpen: false`: that version has not opened it yet).
 * Never lowers the level: an older build that opens the file (it may, when
 * nothing it needs changed) must not erase what a newer build did to it.
 * Returns what it wrote, or null when it could not write.
 */
export function writeDbCompatRecord(
  dbPath: string,
  appVersion: string,
  logger: Logger,
  now = new Date(),
  options: {
    cleanOpen?: boolean;
    /**
     * "Go back" replaced the file with an older copy: record that copy's
     * level (the target build's), even when it is lower. The one place a
     * level is lowered, because the file itself is a different one now.
     */
    restoredLevel?: number;
  } = {},
): DbCompatRecord | null {
  const cleanOpen = options.cleanOpen !== false;
  const read = readDbCompatRecord(dbPath);
  const previous = read && read !== "unreadable" ? read : null;
  const sameVersion = previous?.lastOpenedVersion === appVersion;
  const record: DbCompatRecord = {
    level: options.restoredLevel ?? Math.max(previous?.level ?? 0, DB_COMPAT_LEVEL),
    lastOpenedVersion: appVersion,
    updatedAt: now.toISOString(),
    // A record from before this field starts its clock now: later, never sooner.
    firstOpenedAt: cleanOpen ? (sameVersion && previous?.firstOpenedAt) || now.toISOString() : null,
    copiesClearedAt: cleanOpen && sameVersion ? previous?.copiesClearedAt ?? null : null,
    keptClearedAt: cleanOpen && sameVersion ? previous?.keptClearedAt ?? null : null,
  };
  return writeRecordFile(dbPath, record, logger) ? record : null;
}

function writeRecordFile(dbPath: string, record: DbCompatRecord, logger: Logger): boolean {
  // Written with a plain rename that replaces the old file, never delete-then-
  // rename (writeJsonAtomic's Windows path): between those two steps the
  // switch guard would read "no record" and take the level for 1. On Windows
  // a rename onto a file another process has open fails briefly; it retries.
  const target = dbCompatRecordPath(dbPath);
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    renameReplacing(temporary, target);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* best effort */ }
    logger.warn("db.compat_record_write_failed", {
      dbPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
  return true;
}

const RENAME_ATTEMPTS = 5;

function renameReplacing(from: string, to: string): void {
  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (attempt >= RENAME_ATTEMPTS || (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY")) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * attempt);
    }
  }
}

const SNAPSHOT_SUFFIX = ".bak";
/** 1.2.127 is the first release that writes the compat record. */
const UNRECORDED_VERSION_LABEL = "before-1.2.127";
const SNAPSHOT_HEADROOM_BYTES = 256 * 1024 * 1024;
/** Pages copied per step; small steps keep the event loop free on big files. */
const SNAPSHOT_PAGES_PER_STEP = 256;

function snapshotPrefix(dbPath: string): string {
  return `${path.basename(dbPath)}.pre-`;
}

function safeVersionLabel(version: string): string {
  return version.replace(/[^0-9A-Za-z.-]/g, "_");
}

type SqliteBackup = (source: DatabaseSyncType, destination: string, options?: { rate?: number }) => Promise<number>;

function resolveSqliteBackup(): SqliteBackup | null {
  try {
    const sqlite = require("node:sqlite") as { backup?: SqliteBackup };
    return typeof sqlite.backup === "function" ? sqlite.backup : null;
  } catch {
    return null;
  }
}

/**
 * Copy the database before the first open by a new app version, so "Go back"
 * in the "ADE could not start" window can undo a broken update. Runs before
 * the migrations, on the connection that will run them.
 *
 * The copy uses SQLite's online backup in small steps, so a large project
 * database does not freeze the process that opens it. It is best effort by
 * design: no space, an older Node, or a failed copy is logged and the open
 * continues. Refusing to open would turn a missing safety copy into a broken
 * app.
 *
 * One copy per database: a new copy deletes the older ones, and the copy
 * itself goes once the update has proven itself (`clearProvenDatabaseCopies`).
 */
export async function snapshotDatabaseBeforeVersionChange(args: {
  db: DatabaseSyncType;
  dbPath: string;
  appVersion: string;
  logger: Logger;
}): Promise<string | null> {
  const { db, dbPath, appVersion, logger } = args;
  let size = 0;
  try {
    size = fs.statSync(dbPath).size;
  } catch {
    return null;
  }
  if (size === 0) return null;
  const record = readDbCompatRecord(dbPath);
  const lastOpenedVersion = record && record !== "unreadable" ? record.lastOpenedVersion : null;
  if (lastOpenedVersion && compareUpdateVersions(lastOpenedVersion, appVersion) === 0) return null;

  const backup = resolveSqliteBackup();
  if (!backup) {
    logger.info("db.snapshot_skipped", { dbPath, reason: "backup_unavailable" });
    return null;
  }
  const freeBytes = readVolumeSpace(path.dirname(dbPath))?.freeBytes ?? null;
  if (freeBytes != null && freeBytes < size + SNAPSHOT_HEADROOM_BYTES) {
    logger.warn("db.snapshot_skipped", { dbPath, reason: "low_disk", freeBytes, size });
    return null;
  }

  // Named by both versions (`ade.db.pre-1.2.127-from-1.2.128-beta.3.bak`):
  // a file that goes back and forth between versions gets a copy for each
  // move, so a return to an older build never reuses, or overwrites, the copy
  // taken before an earlier upgrade. A file with no record was last opened by
  // a build from before records: `-from-before-1.2.127`.
  const destination = path.join(
    path.dirname(dbPath),
    `${snapshotPrefix(dbPath)}${safeVersionLabel(appVersion)}-from-${safeVersionLabel(lastOpenedVersion ?? UNRECORDED_VERSION_LABEL)}${SNAPSHOT_SUFFIX}`,
  );
  // The same move again (the file went back and forth twice): the first copy
  // of this move is already there; keep it.
  if (fs.existsSync(destination)) return null;
  const temporary = `${destination}.${process.pid}.tmp`;
  const startedAt = Date.now();
  try {
    await fsp.rm(temporary, { force: true });
    await backup(db, temporary, { rate: SNAPSHOT_PAGES_PER_STEP });
    await fsp.rename(temporary, destination);
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => undefined);
    logger.warn("db.snapshot_failed", {
      dbPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  logger.info("db.snapshot_written", {
    dbPath,
    snapshot: destination,
    fromVersion: lastOpenedVersion,
    toVersion: appVersion,
    sizeBytes: size,
    durationMs: Date.now() - startedAt,
  });
  deleteSupersededCopies(dbPath, destination, logger);
  return destination;
}

/**
 * The journal files a database set aside by "Go back" keeps beside its copy.
 * A copy SQLite's backup wrote is one file and has none.
 */
const COPY_SIDE_FILES = ["-wal", "-shm", "-journal"] as const;
/** A version that opened a database cleanly this long ago has proven itself for it. */
export const COPY_PROVEN_AFTER_MS = 24 * 60 * 60 * 1000;
/** What "Go back" set aside stays this long after going back worked, for support. */
export const KEPT_COPY_FOR_MS = 7 * 24 * 60 * 60 * 1000;

type CopyFile = { path: string; kept: boolean } | { path: string; orphanSideOf: string };

/**
 * The copies in the database's own folder, by exact name only: a version copy
 * (`parseDatabaseCopyName`), or a journal file left beside a copy that is
 * gone. Never the live database or its journal files, never kvDb's one-time
 * `.pre-crsqlite-w1.bak`, never a half-written `.tmp`. Null when the folder
 * cannot be read.
 */
function listCopyFiles(dbPath: string): CopyFile[] | null {
  const directory = path.dirname(dbPath);
  const databaseFileName = path.basename(dbPath);
  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch {
    return null;
  }
  const present = new Set(names);
  const files: CopyFile[] = [];
  for (const name of names) {
    const parsed = parseDatabaseCopyName(databaseFileName, name);
    if (parsed) {
      files.push({ path: path.join(directory, name), kept: parsed.kept });
      continue;
    }
    const side = COPY_SIDE_FILES.find((suffix) => name.endsWith(suffix));
    if (!side) continue;
    const base = name.slice(0, -side.length);
    if (!present.has(base) && parseDatabaseCopyName(databaseFileName, base)) {
      files.push({ path: path.join(directory, name), orphanSideOf: base });
    }
  }
  return files;
}

/**
 * Deletes one copy: the copy first, then its journal files, so a copy whose
 * delete fails keeps everything it needs. A file another process holds (a
 * Windows lock) is skipped and tried again on a later open; it never throws.
 */
function deleteCopyFile(file: CopyFile, reason: string, logger: Logger): boolean {
  try {
    fs.rmSync(file.path, { force: true });
    if (!("orphanSideOf" in file)) {
      for (const side of COPY_SIDE_FILES) fs.rmSync(`${file.path}${side}`, { force: true });
    }
  } catch (error) {
    logger.warn("db.copy_delete_skipped", {
      copy: file.path,
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
  logger.info("db.copy_deleted", { copy: file.path, reason });
  return true;
}

/**
 * A new copy supersedes the older ones of the same database: they undo an
 * earlier update, and going back that far is not offered. What "Go back" set
 * aside is not superseded; it waits for `clearProvenDatabaseCopies`.
 */
function deleteSupersededCopies(dbPath: string, newest: string, logger: Logger): void {
  try {
    for (const file of listCopyFiles(dbPath) ?? []) {
      if (file.path === newest || ("kept" in file && file.kept)) continue;
      deleteCopyFile(file, "superseded", logger);
    }
  } catch (error) {
    logger.warn("db.copy_cleanup_failed", { dbPath, error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * After a clean open: once the running version has opened this database
 * cleanly for a day (`firstOpenedAt` at least `COPY_PROVEN_AFTER_MS` ago),
 * the update has proven itself here and its copy goes. What "Go back" set
 * aside goes a week after (`KEPT_COPY_FOR_MS`).
 *
 * That day is also what keeps the copy while the "ADE could not start" window
 * can offer it: the window never offers Go back for a database the running
 * version has already opened cleanly, and nothing here deletes a copy before
 * such an open. Reads the folder only when something is due, and records when
 * it is done, so a normal open reads nothing. Never throws.
 */
export function clearProvenDatabaseCopies(
  dbPath: string,
  record: DbCompatRecord,
  logger: Logger,
  now = new Date(),
): void {
  try {
    if (!record.firstOpenedAt || !record.lastOpenedVersion) return;
    const age = now.getTime() - Date.parse(record.firstOpenedAt);
    if (!Number.isFinite(age)) return;
    const copiesDue = age >= COPY_PROVEN_AFTER_MS && !record.copiesClearedAt;
    const keptDue = age >= KEPT_COPY_FOR_MS && !record.keptClearedAt;
    if (!copiesDue && !keptDue) return;
    const files = listCopyFiles(dbPath);
    if (!files) return;
    let copiesDone = copiesDue;
    let keptDone = keptDue;
    for (const file of files) {
      const kept = "kept" in file ? file.kept : false;
      if (kept ? !keptDue : !copiesDue) continue;
      const deleted = deleteCopyFile(file, kept ? "kept_copy_expired" : "update_proven", logger);
      if (!deleted) {
        if (kept) keptDone = false;
        else copiesDone = false;
      }
    }
    if (!copiesDone && !keptDone) return;
    const stamp = now.toISOString();
    writeRecordFile(dbPath, {
      ...record,
      copiesClearedAt: copiesDone ? stamp : record.copiesClearedAt,
      keptClearedAt: keptDone ? stamp : record.keptClearedAt,
    }, logger);
  } catch (error) {
    logger.warn("db.copy_cleanup_failed", { dbPath, error: error instanceof Error ? error.message : String(error) });
  }
}
