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

/** SQLite's primary result codes, by number, as the class names a report shows. */
const SQLITE_PRIMARY_NAMES: Readonly<Record<number, string>> = {
  1: "error", 2: "internal", 3: "perm", 4: "abort", 5: "busy", 6: "locked", 7: "nomem", 8: "readonly",
  9: "interrupt", 10: "ioerr", 11: "corrupt", 12: "notfound", 13: "full", 14: "cantopen", 15: "protocol",
  16: "empty", 17: "schema", 18: "toobig", 19: "constraint", 20: "mismatch", 21: "misuse", 22: "nolfs",
  23: "auth", 24: "format", 25: "range", 26: "notadb",
};

/**
 * What kind of failure an open hit, as a short code token and never its
 * message: `sqlite_cantopen` from SQLite's own result code, `sqlite_<name>`
 * from a `SQLITE_<NAME>` in the message, a lowercased errno (`eacces`) for a
 * file-system failure, or `unclassified`. What a project-open failure that no
 * recovery bucket fits carries, so it is not just "unknown".
 */
export function sqliteErrorClass(error: unknown): string {
  const record = error as { errcode?: unknown; code?: unknown } | null;
  const errcode = record?.errcode;
  if (typeof errcode === "number") {
    const name = SQLITE_PRIMARY_NAMES[errcode & 0xff];
    if (name) return `sqlite_${name}`;
  }
  const named = /\bSQLITE_([A-Z]+)\b/.exec(sqliteMessage(error));
  if (named?.[1] && Object.values(SQLITE_PRIMARY_NAMES).includes(named[1].toLowerCase())) {
    return `sqlite_${named[1].toLowerCase()}`;
  }
  const code = typeof record?.code === "string" ? record.code.trim() : "";
  if (/^E[A-Z0-9]{2,15}$/.test(code)) return code.toLowerCase();
  return "unclassified";
}
