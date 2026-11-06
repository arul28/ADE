import { getErrorMessage } from "../shared/utils";

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

/**
 * SQLite's message without the `[sql=…]` suffix kvDb puts on a failed
 * statement, so a statement's own text (`PRAGMA busy_timeout`, a table named
 * `io_errors`) never decides what kind of failure it was.
 */
function sqliteMessage(error: unknown): string {
  return getErrorMessage(error).replace(/\s*\[sql=[\s\S]*\]\s*$/, "");
}

/** True when SQLite reported the database busy or locked: the write may work on a retry. */
export function isSqliteBusyOrLockedError(error: unknown): boolean {
  const code = (error as { errcode?: unknown } | null)?.errcode;
  // Extended result codes (SQLITE_BUSY_SNAPSHOT, ...) carry the primary in the low byte.
  if (typeof code === "number" && [SQLITE_BUSY, SQLITE_LOCKED].includes(code & 0xff)) return true;
  // SQLite's own phrases only: a bare "busy" would also match a path in a
  // file-system error (`/Users/a/busy-app/...`), which a retry cannot fix.
  return /database (?:table )?is locked|\bSQLITE_(?:BUSY|LOCKED)(?:_[A-Z]+)?\b/i.test(sqliteMessage(error));
}

const SQLITE_IOERR = 10;
/**
 * I/O result codes that mean the bytes are wrong or memory ran out, not that
 * the drive stopped answering: a short read (the file is shorter than its
 * pages say, so truncated or damaged), a checksum mismatch, and out of memory.
 */
const SQLITE_IOERR_NOT_DRIVE_FAULT = new Set([
  SQLITE_IOERR | (2 << 8), // SQLITE_IOERR_SHORT_READ
  SQLITE_IOERR | (12 << 8), // SQLITE_IOERR_NOMEM
  SQLITE_IOERR | (32 << 8), // SQLITE_IOERR_DATA
]);

/**
 * True when SQLite could not read or write the file at all ("disk I/O error"):
 * the drive stopped answering, was removed, or failed underneath the database.
 * With an extended code, a damaged file or a memory failure is not one.
 */
export function isSqliteIoError(error: unknown): boolean {
  const code = (error as { errcode?: unknown } | null)?.errcode;
  if (typeof code === "number" && (code & 0xff) === SQLITE_IOERR) return !SQLITE_IOERR_NOT_DRIVE_FAULT.has(code);
  return /disk I\/O error|SQLITE_IOERR/i.test(sqliteMessage(error));
}
