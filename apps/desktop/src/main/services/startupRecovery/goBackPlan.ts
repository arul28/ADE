import type { DatabaseCopyInfo } from "../../../shared/types/startupRecovery";
import { shippedVersionOrNull } from "../../../shared/updateTrack";

/**
 * Which version "Go back" installs and which database copies it puts back.
 * Pure: the caller lists the copies (`databaseCopies.ts`).
 *
 * A copy is named for the move it guards: `<db>.pre-<to>-from-<from>.bak` is
 * the file as `<from>` left it, taken just before `<to>` first opened it. So
 * the copies that undo the running version are the ones whose `<to>` is the
 * running version, and the version to go back to is their `<from>`: that
 * build last opened those files, so it can read them.
 */

const COPY_SUFFIX = ".bak";
const MOVE_SEPARATOR = "-from-";
/** A release version: `1.2.127`, `1.2.128-beta.3`. */
const RELEASE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
/** The `<to>` label as `safeVersionLabel` writes it. */
const VERSION_LABEL = /^\d[0-9A-Za-z._-]*$/;
/**
 * A second copy for the same move gets `_2`, `_3` (`databaseCopies.ts`).
 * Version labels never contain `_` for a release version, so it cannot be
 * mistaken for part of one.
 */
const DUPLICATE_MARK = /_\d+$/;

/** The same rule `snapshotDatabaseBeforeVersionChange` uses for the name. */
export function versionLabel(version: string): string {
  return version.replace(/[^0-9A-Za-z.-]/g, "_");
}

/**
 * Reads a copy's name. Null for a file that is not a version copy (kvDb's
 * one-time `.pre-crsqlite-w1.bak`, a half-written `.tmp`). `fromVersion` is
 * null when the name does not carry a release version: `unknown`, or
 * `before-1.2.127` for a file no build had recorded.
 */
export function parseDatabaseCopyName(
  databaseFileName: string,
  copyFileName: string,
): { toVersion: string; fromVersion: string | null } | null {
  const prefix = `${databaseFileName}.pre-`;
  if (!copyFileName.startsWith(prefix) || !copyFileName.endsWith(COPY_SUFFIX)) return null;
  const move = copyFileName.slice(prefix.length, -COPY_SUFFIX.length);
  const split = move.indexOf(MOVE_SEPARATOR);
  if (split <= 0) return null;
  const toVersion = move.slice(0, split);
  if (!VERSION_LABEL.test(toVersion)) return null;
  const from = move.slice(split + MOVE_SEPARATOR.length).replace(DUPLICATE_MARK, "");
  return { toVersion, fromVersion: RELEASE_VERSION.test(from) ? from : null };
}

export type GoBackDatabase = {
  label: string;
  dbPath: string;
  copies: readonly DatabaseCopyInfo[];
};

export type GoBackPlan = {
  /** The version to install. */
  targetVersion: string;
  /** One copy per database that has one for this move. */
  restores: Array<{ label: string; dbPath: string; copy: DatabaseCopyInfo }>;
  /** Databases with no copy for this move: the target build opens them as they are. */
  untouched: Array<{ label: string; dbPath: string }>;
  /** When the newest restored copy was taken. */
  dataFrom: number;
};

/**
 * Null when there is nothing to go back to: no copy names a move into the
 * running version from a release version.
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
}): GoBackPlan | null {
  const running = versionLabel(input.runningVersion.trim());
  const isCandidate = (copy: DatabaseCopyInfo): copy is DatabaseCopyInfo & { fromVersion: string } =>
    copy.toVersion === running
    && copy.fromVersion != null
    && versionLabel(copy.fromVersion) !== running
    // A dev build's placeholder or 0.0.0 has no release to download.
    && shippedVersionOrNull(copy.fromVersion) != null;

  const candidates = input.databases.flatMap((database) => database.copies.filter(isCandidate));
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
    const matching = database.copies
      .filter(isCandidate)
      .filter((copy) => copy.fromVersion === targetVersion);
    if (matching.length === 0) {
      untouched.push({ label: database.label, dbPath: database.dbPath });
      continue;
    }
    // A second copy of the same move (`_2`) is newer data than the first.
    const copy = matching.reduce((best, entry) => (entry.takenAt > best.takenAt ? entry : best));
    restores.push({ label: database.label, dbPath: database.dbPath, copy });
  }
  return {
    targetVersion,
    restores,
    untouched,
    dataFrom: Math.max(...restores.map((entry) => entry.copy.takenAt)),
  };
}
