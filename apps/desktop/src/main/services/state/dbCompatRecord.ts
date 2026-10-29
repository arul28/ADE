import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

import { DB_COMPAT_LEVEL } from "../../../shared/releaseCompat";
import { compareUpdateVersions } from "../../../shared/updateVersions";
import type { Logger } from "../logging/logger";
import { readVolumeSpace } from "../storage/volume";

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
 *
 * Beside the file rather than inside it: the guard reads it without opening
 * the database (the brain may hold it), and it describes this copy of the
 * file, not data that syncs to other machines.
 */
export type DbCompatRecord = {
  level: number;
  lastOpenedVersion: string | null;
  updatedAt: string | null;
};

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
      lastOpenedVersion: typeof parsed.lastOpenedVersion === "string" ? parsed.lastOpenedVersion : null,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
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
  return record?.level ?? 1;
}

/**
 * Called after migrations ran. Never lowers the level: an older build that
 * opens the file (it may, when nothing it needs changed) must not erase what
 * a newer build did to it.
 */
export function writeDbCompatRecord(dbPath: string, appVersion: string, logger: Logger, now = new Date()): void {
  const previous = readDbCompatRecord(dbPath);
  const previousLevel = previous && previous !== "unreadable" ? previous.level : 0;
  const record: DbCompatRecord = {
    level: Math.max(previousLevel, DB_COMPAT_LEVEL),
    lastOpenedVersion: appVersion,
    updatedAt: now.toISOString(),
  };
  const target = dbCompatRecordPath(dbPath);
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    if (process.platform === "win32") {
      try { fs.unlinkSync(target); } catch { /* first write */ }
    }
    fs.renameSync(temporary, target);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* best effort */ }
    logger.warn("db.compat_record_write_failed", {
      dbPath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

const SNAPSHOT_SUFFIX = ".bak";
const SNAPSHOTS_KEPT = 2;
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
 * Copy the database before the first open by a new app version, so a broken
 * migration can be undone by hand (Settings, or support). Runs before the
 * migrations, on the connection that will run them.
 *
 * The copy uses SQLite's online backup in small steps, so a large project
 * database does not freeze the process that opens it. It is best effort by
 * design: no space, an older Node, or a failed copy is logged and the open
 * continues. Refusing to open would turn a missing safety copy into a broken
 * app. The newest two copies per database are kept.
 *
 * A project database syncs with other machines, so restoring its copy is a
 * last resort that support decides on; the safe recovery is to take the data
 * back from another machine. The machine database can simply be put back.
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

  const destination = path.join(
    path.dirname(dbPath),
    `${snapshotPrefix(dbPath)}${safeVersionLabel(appVersion)}${SNAPSHOT_SUFFIX}`,
  );
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
  await pruneDatabaseSnapshots(dbPath, logger);
  return destination;
}

/** Newest first, by modification time. */
export function listDatabaseSnapshots(dbPath: string): Array<{ path: string; modifiedAt: number; sizeBytes: number }> {
  const directory = path.dirname(dbPath);
  const prefix = snapshotPrefix(dbPath);
  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch {
    return [];
  }
  const snapshots: Array<{ path: string; modifiedAt: number; sizeBytes: number }> = [];
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(SNAPSHOT_SUFFIX)) continue;
    const fullPath = path.join(directory, name);
    try {
      const stat = fs.statSync(fullPath);
      snapshots.push({ path: fullPath, modifiedAt: stat.mtimeMs, sizeBytes: stat.size });
    } catch {
      // Removed between the listing and the stat.
    }
  }
  return snapshots.sort((left, right) => right.modifiedAt - left.modifiedAt);
}

async function pruneDatabaseSnapshots(dbPath: string, logger: Logger): Promise<void> {
  for (const stale of listDatabaseSnapshots(dbPath).slice(SNAPSHOTS_KEPT)) {
    try {
      await fsp.rm(stale.path, { force: true });
    } catch (error) {
      logger.warn("db.snapshot_prune_failed", {
        snapshot: stale.path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
