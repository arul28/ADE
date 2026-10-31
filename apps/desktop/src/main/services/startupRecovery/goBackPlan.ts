import type { DatabaseCopyInfo, LocalDatabaseKind } from "../../../shared/types/startupRecovery";
import { shippedVersionOrNull } from "../../../shared/updateTrack";

/**
 * Database copy names, and which version "Go back" installs and which copies
 * it puts back. Pure: the caller lists the copies (`databaseCopies.ts`).
 *
 * A copy is named for the move it guards: `<db>.pre-<to>-from-<from>.bak` is
 * the file as `<from>` left it, taken just before `<to>` first opened it. So
 * the copies that undo the running version are the ones whose `<to>` is the
 * running version, and the version to go back to is their `<from>`: that
 * build last opened those files, so it can read them.
 *
 * "Go back" sets the current database aside as `…_kept.bak` (`_kept2`, …).
 * That file holds what the broken build left; it is never a way back.
 */

const COPY_SUFFIX = ".bak";
const MOVE_SEPARATOR = "-from-";
/** A release version: `1.2.127`, `1.2.128-beta.3`. */
const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
/** The `<to>` label as `safeVersionLabel` writes it. */
const VERSION_LABEL = /^\d[0-9A-Za-z._-]*$/;
/**
 * The mark of a database "Go back" set aside. A release version label never
 * contains `_`, so it cannot be mistaken for part of one.
 */
const KEPT_MARK = /_kept\d*$/;

/** The same rule `snapshotDatabaseBeforeVersionChange` uses for the name. */
export function versionLabel(version: string): string {
  return version.replace(/[^0-9A-Za-z.-]/g, "_");
}

/**
 * Reads a copy's name. Null for a file that is not a version copy (kvDb's
 * one-time `.pre-crsqlite-w1.bak`, a half-written `.tmp`, a `-wal` beside a
 * copy). `fromVersion` is null when the name does not carry a release
 * version: `unknown`, or `before-1.2.127` for a file no build had recorded.
 */
export function parseDatabaseCopyName(
  databaseFileName: string,
  copyFileName: string,
): { toVersion: string; fromVersion: string | null; kept: boolean } | null {
  const prefix = `${databaseFileName}.pre-`;
  if (!copyFileName.startsWith(prefix) || !copyFileName.endsWith(COPY_SUFFIX)) return null;
  const move = copyFileName.slice(prefix.length, -COPY_SUFFIX.length);
  const split = move.indexOf(MOVE_SEPARATOR);
  if (split <= 0) return null;
  const toVersion = move.slice(0, split);
  if (!VERSION_LABEL.test(toVersion)) return null;
  const fromLabel = move.slice(split + MOVE_SEPARATOR.length);
  const kept = KEPT_MARK.test(fromLabel);
  const from = fromLabel.replace(KEPT_MARK, "");
  return { toVersion, fromVersion: RELEASE_VERSION.test(from) ? from : null, kept };
}

export type GoBackDatabase = {
  kind: LocalDatabaseKind;
  label: string;
  dbPath: string;
  copies: readonly DatabaseCopyInfo[];
  /**
   * The running version already opened this file cleanly (its compat record
   * says so). Work done since then lives only in it, so it is never put back,
   * whatever made the window appear.
   */
  openedOnRunningVersion: boolean;
};

export type GoBackPlan = {
  /** The version to install. */
  targetVersion: string;
  /** One copy per database that is put back. */
  restores: Array<{ kind: LocalDatabaseKind; label: string; dbPath: string; copy: DatabaseCopyInfo }>;
  /** Every other database: the target build opens it as it is. */
  untouched: Array<{ kind: LocalDatabaseKind; label: string; dbPath: string }>;
  /** When the newest restored copy was taken. */
  dataFrom: number;
};

/**
 * Which databases go back with the app: this computer's own database and the
 * personal chats', always; a project's only when it is the one that failed.
 * A project database syncs with other machines, and putting back one that
 * works would drop what was done in it since the update. None that the
 * running version already opened cleanly: that open proved the update for
 * that file, and what was done since would be lost.
 */
function restorable(database: GoBackDatabase, failedDbPath: string | null): boolean {
  if (database.openedOnRunningVersion) return false;
  return database.kind !== "project" || (failedDbPath != null && database.dbPath === failedDbPath);
}

/**
 * Null when there is nothing to go back to: no database that would be put
 * back has a copy of a move into the running version from a release version.
 *
 * The update record (`recentlyInstalledUpdate`) names the version the app
 * came from. It wins when a copy for that move exists, because that is the
 * build the person was using. Otherwise the newest copy decides: an install
 * by hand leaves no record, and a record can name a version that never opened
 * these files.
 */
export function chooseGoBackPlan(input: {
  runningVersion: string;
  updateRecord: { version: string; fromVersion: string | null } | null;
  databases: readonly GoBackDatabase[];
  /** The project database that failed to open, when that is what failed. */
  failedDbPath: string | null;
}): GoBackPlan | null {
  const running = versionLabel(input.runningVersion.trim());
  const isCandidate = (copy: DatabaseCopyInfo): copy is DatabaseCopyInfo & { fromVersion: string } =>
    !copy.kept
    && copy.toVersion === running
    && copy.fromVersion != null
    && versionLabel(copy.fromVersion) !== running
    // A dev build's placeholder or 0.0.0 has no release to download.
    && shippedVersionOrNull(copy.fromVersion) != null;

  const eligible = input.databases.filter((database) => restorable(database, input.failedDbPath));
  const candidates = eligible.flatMap((database) => database.copies.filter(isCandidate));
  if (candidates.length === 0) return null;

  const recordFrom = input.updateRecord
    && versionLabel(input.updateRecord.version.trim()) === running
    ? input.updateRecord.fromVersion
    : null;
  const newest = candidates.reduce((best, copy) => (copy.takenAt > best.takenAt ? copy : best));
  const targetVersion = recordFrom && candidates.some((copy) => copy.fromVersion === recordFrom)
    ? recordFrom
    : newest.fromVersion;

  const restores: GoBackPlan["restores"] = [];
  const untouched: GoBackPlan["untouched"] = [];
  for (const database of input.databases) {
    const matching = restorable(database, input.failedDbPath)
      ? database.copies.filter(isCandidate).filter((copy) => copy.fromVersion === targetVersion)
      : [];
    if (matching.length === 0) {
      untouched.push({ kind: database.kind, label: database.label, dbPath: database.dbPath });
      continue;
    }
    const copy = matching.reduce((best, entry) => (entry.takenAt > best.takenAt ? entry : best));
    restores.push({ kind: database.kind, label: database.label, dbPath: database.dbPath, copy });
  }
  return {
    targetVersion,
    restores,
    untouched,
    dataFrom: Math.max(...restores.map((entry) => entry.copy.takenAt)),
  };
}
