import { getErrorMessage } from "../shared/utils";

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

/** True when SQLite reported the database busy or locked: the write may work on a retry. */
export function isSqliteBusyOrLockedError(error: unknown): boolean {
  const code = (error as { errcode?: unknown } | null)?.errcode;
  // Extended result codes (SQLITE_BUSY_SNAPSHOT, ...) carry the primary in the low byte.
  if (typeof code === "number" && [SQLITE_BUSY, SQLITE_LOCKED].includes(code & 0xff)) return true;
  return /database (?:table )?is locked|busy/i.test(getErrorMessage(error));
}

const SQLITE_IOERR = 10;

/**
 * True when SQLite could not read or write the file at all ("disk I/O error"):
 * the drive stopped answering, was removed, or failed underneath the database.
 */
export function isSqliteIoError(error: unknown): boolean {
  const code = (error as { errcode?: unknown } | null)?.errcode;
  if (typeof code === "number" && (code & 0xff) === SQLITE_IOERR) return true;
  return /disk I\/O error|SQLITE_IOERR/i.test(getErrorMessage(error));
}
