import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import {
  CTO_ARCHIVE_KINDS,
  emptyCtoArchiveCounts,
  emptyCtoArchivePage,
  type CtoArchiveEntry,
  type CtoArchiveKind,
  type CtoArchivePage,
  type CtoArchiveQuery,
  type CtoNotesScope,
} from "../../../shared/types/cto";
import { nowIso, redactSecrets } from "../shared/utils";

// Same builtin resolution as kvDb.ts / searchIndexDb.ts.
const require = createRequire(path.join(process.cwd(), "ade-runtime.cjs"));

/*
 * The CTO's archive: everything that left the per-turn notes, every version
 * of the story so far, the facts each story fold pulls out, and the worker
 * discoveries once drained. Project-scoped, in its own SQLite file next to
 * the notes (`.ade/cto/archive.db`, never inside ade.db: FTS5 tables cannot be
 * cr-sqlite CRRs and the database never syncs). Its rows move with the CTO to
 * a new home through the account copy (`ctoArchiveCopy.ts`).
 *
 * Unlike the search index this is not a cache. Rows are the only copy of an
 * archived note or an old story, so a file that won't open is moved aside,
 * never deleted, and the CTO falls back to refusing a full write.
 *
 * Search is keyword only: FTS5 when the runtime has it, word matching when
 * not. `CtoArchivePage.mode` leaves room for a semantic mode later.
 */

export const CTO_ARCHIVE_DB_FILENAME = "archive.db";
const SCHEMA_VERSION = 1;
const LIST_DEFAULT_LIMIT = 30;
const LIST_MAX_LIMIT = 100;
/** A story version in a list shows this much; `{ id }` reads it in full. */
const STORY_PREVIEW_CHARS = 480;
const ENTRY_MAX_CHARS = 16_000;

const DDL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  scope TEXT,
  text TEXT NOT NULL,
  reason TEXT,
  source_session_id TEXT,
  source_at TEXT,
  source_label TEXT,
  archived_at TEXT NOT NULL,
  pinned_at TEXT,
  text_key TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS entries_kind_idx ON entries(kind, id);
CREATE TABLE IF NOT EXISTS note_heat (
  scope TEXT NOT NULL,
  note_key TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  PRIMARY KEY (scope, note_key)
);
`;

const FTS_DDL = `
CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(text, content='entries', content_rowid='id', tokenize='porter unicode61');
CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE OF text ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO entries_fts(rowid, text) VALUES (new.id, new.text);
END;
`;

type Logger = { warn: (message: string, meta?: Record<string, unknown>) => void };

export type CtoArchiveRecord = {
  kind: CtoArchiveKind;
  text: string;
  scope?: CtoNotesScope | null;
  reason?: string | null;
  sourceSessionId?: string | null;
  sourceAt?: string | null;
  sourceLabel?: string | null;
  /** When it was archived; now when not given. An import keeps the original time. */
  archivedAt?: string | null;
};

/** One entry as the account copy carries it (`ctoArchiveCopy.ts`). */
export type CtoArchiveCarriedRow = {
  id: number;
  kind: CtoArchiveKind;
  scope: CtoNotesScope | null;
  text: string;
  reason: string | null;
  sourceAt: string | null;
  sourceLabel: string | null;
  archivedAt: string;
};

/** The last use of one pinned note, by `ctoNoteKey`. */
export type CtoNoteHeatRow = { scope: CtoNotesScope; key: string; at: string };

type Row = {
  id: number;
  kind: string;
  scope: string | null;
  text: string;
  reason: string | null;
  source_session_id: string | null;
  source_at: string | null;
  source_label: string | null;
  archived_at: string;
};

const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** Notes and facts are the same entry whatever their case or spacing; a story version only when identical. */
function textKey(kind: CtoArchiveKind, scope: CtoNotesScope | null, text: string): string {
  const body = kind === "story" ? text : text.replace(/\s+/g, " ").trim().toLowerCase();
  // A decision and a fact saying the same thing are one entry.
  const group = kind === "decision" ? "fact" : kind;
  return sha(`${group}|${kind === "note" ? scope ?? "project" : ""}|${body}`);
}

/** Heat is kept per note line, by the same normalization the notes file dedupes on. */
export function ctoNoteKey(text: string): string {
  return sha(text.replace(/\s+/g, " ").trim().toLowerCase());
}

/** Words of a query, for FTS5 (quoted, prefix) or word matching. */
function queryWords(query: string): string[] {
  return Array.from(new Set((query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter((word) => word.length > 0))).slice(0, 12);
}

const UPSERT_HEAT_SQL = `
  INSERT INTO note_heat(scope, note_key, last_used_at) VALUES (?, ?, ?)
  ON CONFLICT(scope, note_key) DO UPDATE SET last_used_at = excluded.last_used_at
`;

function toEntry(row: Row, full: boolean): CtoArchiveEntry {
  const kind = (CTO_ARCHIVE_KINDS as readonly string[]).includes(row.kind) ? (row.kind as CtoArchiveKind) : "fact";
  const preview = kind === "story" && !full && row.text.length > STORY_PREVIEW_CHARS;
  return {
    id: row.id,
    kind,
    scope: row.scope === "user" ? "user" : row.scope === "project" ? "project" : null,
    text: preview ? `${row.text.slice(0, STORY_PREVIEW_CHARS).trimEnd()}…` : row.text,
    ...(preview ? { truncated: true } : {}),
    reason: row.reason,
    sourceAt: row.source_at,
    sourceLabel: row.source_label,
    sourceSessionId: row.source_session_id,
    archivedAt: row.archived_at,
  };
}

/** SQLite's primary result code, from node:sqlite's `errcode` (extended codes carry it in the low byte). */
function sqliteCode(error: unknown): number | null {
  const code = (error as { errcode?: unknown } | null)?.errcode;
  return typeof code === "number" ? code & 0xff : null;
}

/** SQLITE_BUSY or SQLITE_LOCKED: another connection holds the file. */
const isSqliteBusy = (error: unknown): boolean => sqliteCode(error) === 5 || sqliteCode(error) === 6;

/** SQLITE_CORRUPT or SQLITE_NOTADB: the file is not a database this can read. */
const isSqliteUnreadable = (error: unknown): boolean => sqliteCode(error) === 11 || sqliteCode(error) === 26;

export function createCtoMemoryArchive(args: { dir: string; logger?: Logger | null }) {
  const dbPath = path.join(args.dir, CTO_ARCHIVE_DB_FILENAME);
  let db: DatabaseSyncType | null = null;
  let fts = false;
  /** Set after a failed open: one try per process, not one per note. */
  let failed = false;

  const warn = (event: string, error: unknown, meta?: Record<string, unknown>): void => {
    args.logger?.warn(event, { ...(meta ?? {}), error: error instanceof Error ? error.message : String(error) });
  };

  const openAt = (): DatabaseSyncType => {
    const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (file: string) => DatabaseSyncType };
    fs.mkdirSync(args.dir, { recursive: true });
    const handle = new DatabaseSync(dbPath);
    try {
      handle.exec("PRAGMA busy_timeout = 5000");
      handle.exec("PRAGMA journal_mode = WAL");
      handle.exec(DDL);
      handle.prepare("INSERT OR IGNORE INTO meta(key, value) VALUES ('schemaVersion', ?)").run(String(SCHEMA_VERSION));
      try {
        handle.exec(FTS_DDL);
        fts = true;
      } catch (error) {
        // No FTS5 in this SQLite build: word matching still finds things.
        fts = false;
        warn("cto_archive.fts_unavailable", error);
      }
      return handle;
    } catch (error) {
      try {
        handle.close();
      } catch {
        // The open already failed.
      }
      throw error;
    }
  };

  /** The open database, or null when this machine can't have one (logged once). */
  const open = (): DatabaseSyncType | null => {
    if (db) return db;
    if (failed) return null;
    try {
      db = openAt();
      return db;
    } catch (error) {
      warn("cto_archive.open_failed", error, { dbPath });
      // Another process holds the file (the brain and a CLI on one project):
      // the file is fine, so try again on the next call.
      if (isSqliteBusy(error)) return null;
      // A file that SQLite says is not a database is the only copy of what it
      // holds: set it aside and start a new one, never delete it.
      if (isSqliteUnreadable(error) && fs.existsSync(dbPath)) {
        const aside = `${dbPath}.unreadable-${Date.now()}`;
        try {
          for (const suffix of ["", "-wal", "-shm"]) {
            if (fs.existsSync(`${dbPath}${suffix}`)) fs.renameSync(`${dbPath}${suffix}`, `${aside}${suffix}`);
          }
          db = openAt();
          return db;
        } catch (retryError) {
          warn("cto_archive.reopen_failed", retryError, { movedTo: aside });
        }
      }
      failed = true;
      return null;
    }
  };

  const available = (): boolean => open() != null;

  /**
   * Adds an entry. One that already says the same thing stays one entry; a
   * note archived again replaces its old row (out of `pinned`, the new
   * reason, a new id). Returns the id, or null when there is no archive or
   * the write failed.
   */
  const add = (record: CtoArchiveRecord): number | null => {
    const handle = open();
    if (!handle) return null;
    try {
      return inTransaction(handle, () => write(handle, record));
    } catch (error) {
      warn("cto_archive.add_failed", error, { kind: record.kind });
      return null;
    }
  };

  /** One entry in (see `add`); throws on a failed write so a batch rolls back. */
  const write = (handle: DatabaseSyncType, record: CtoArchiveRecord): number | null => {
    const text = redactSecrets(record.text.trim()).slice(0, ENTRY_MAX_CHARS);
    if (!text) return null;
    const scope = record.kind === "note" ? record.scope ?? "project" : null;
    const key = textKey(record.kind, scope, text);
    const archivedAt = record.archivedAt?.trim() || nowIso();
    // A note archived again now is a new entry (new id, new reason): the
    // account copy carries rows by id, and an old id may sit below its travel
    // cut. An import (it brings its own time) keeps the row this machine has.
    if (record.kind === "note" && !record.archivedAt?.trim()) {
      handle.prepare("DELETE FROM entries WHERE text_key = ?").run(key);
    }
    // ON CONFLICT: another process may have added the same text since.
    const result = handle.prepare(`
      INSERT INTO entries(kind, scope, text, reason, source_session_id, source_at, source_label, archived_at, text_key)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(text_key) DO NOTHING
    `).run(
      record.kind,
      scope,
      text,
      record.reason ?? null,
      record.sourceSessionId ?? null,
      record.sourceAt ?? null,
      record.sourceLabel ?? null,
      archivedAt,
      key,
    );
    if (result.changes > 0) return Number(result.lastInsertRowid);
    return (handle.prepare("SELECT id FROM entries WHERE text_key = ?").get(key) as { id: number } | undefined)?.id ?? null;
  };

  /** Runs `fn` in one write transaction, or rolls it all back and rethrows. */
  const inTransaction = <T>(handle: DatabaseSyncType, fn: () => T): T => {
    // IMMEDIATE takes the write lock first (waiting on busy_timeout): a read
    // that later becomes a write fails at once when another process wrote in
    // between.
    handle.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      handle.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        handle.exec("ROLLBACK");
      } catch {
        // The failed statement already ended the transaction.
      }
      throw error;
    }
  };

  /**
   * Many entries in one transaction (a fold's facts, an import). Returns how
   * many were new, or null when there is no archive or the write failed.
   */
  const addMany = (records: readonly CtoArchiveRecord[]): number | null => {
    const handle = open();
    if (!handle) return null;
    if (!records.length) return 0;
    const total = (): number => (handle.prepare("SELECT COUNT(*) AS n FROM entries").get() as { n: number }).n;
    try {
      return inTransaction(handle, () => {
        const before = total();
        for (const record of records) write(handle, record);
        return total() - before;
      });
    } catch (error) {
      warn("cto_archive.add_many_failed", error, { count: records.length });
      return null;
    }
  };

  const get = (id: number): CtoArchiveEntry | null => {
    const handle = open();
    if (!handle) return null;
    try {
      const row = handle.prepare("SELECT * FROM entries WHERE id = ? AND pinned_at IS NULL").get(id) as Row | undefined;
      return row ? toEntry(row, true) : null;
    } catch (error) {
      warn("cto_archive.get_failed", error, { id });
      return null;
    }
  };

  /** An entry went back into the notes: it leaves the archive (the row stays for when it comes back). */
  const markPinned = (id: number): void => {
    try {
      open()?.prepare("UPDATE entries SET pinned_at = ? WHERE id = ?").run(nowIso(), id);
    } catch (error) {
      // The note is pinned already; the entry only shows twice until the next recall.
      warn("cto_archive.mark_pinned_failed", error, { id });
    }
  };

  /**
   * Marks pinned every entry whose text is a note in the files now (keys by
   * `ctoNoteKey`). After an import: a note the other home recalled travels as
   * its archived row, but this machine's notes already hold it. How many.
   */
  const markPinnedMatching = (noteKeys: ReadonlySet<string>): number => {
    const handle = open();
    if (!handle || !noteKeys.size) return 0;
    try {
      const rows = handle.prepare("SELECT id, text FROM entries WHERE pinned_at IS NULL AND kind <> 'story'").all() as Array<{ id: number; text: string }>;
      const ids = rows.filter((row) => noteKeys.has(ctoNoteKey(row.text))).map((row) => row.id);
      if (!ids.length) return 0;
      const at = nowIso();
      const mark = handle.prepare("UPDATE entries SET pinned_at = ? WHERE id = ?");
      inTransaction(handle, () => {
        for (const id of ids) mark.run(at, id);
      });
      return ids.length;
    } catch (error) {
      // The notes hold them already; they only show in the archive too.
      warn("cto_archive.mark_pinned_failed", error, { count: noteKeys.size });
      return 0;
    }
  };

  const counts = (handle: DatabaseSyncType): Record<CtoArchiveKind, number> => {
    const out = emptyCtoArchiveCounts();
    const rows = handle.prepare("SELECT kind, COUNT(*) AS n FROM entries WHERE pinned_at IS NULL GROUP BY kind").all() as Array<{ kind: string; n: number }>;
    for (const row of rows) if (row.kind in out) out[row.kind as CtoArchiveKind] = row.n;
    return out;
  };

  const search = (query: CtoArchiveQuery = {}): CtoArchivePage => {
    const handle = open();
    if (!handle) return emptyCtoArchivePage();
    try {
      if (typeof query.id === "number") {
        const entry = get(query.id);
        return { available: true, mode: "recent", entries: entry ? [entry] : [], nextBefore: null, counts: counts(handle) };
      }
      const limit = Math.max(1, Math.min(LIST_MAX_LIMIT, Math.floor(query.limit ?? LIST_DEFAULT_LIMIT)));
      const kinds = (query.kinds ?? []).filter((kind) => (CTO_ARCHIVE_KINDS as readonly string[]).includes(kind));
      const kindClause = kinds.length ? ` AND e.kind IN (${kinds.map(() => "?").join(", ")})` : "";
      const words = queryWords(query.query ?? "");
      let rows: Row[];
      if (words.length && fts) {
        const match = words.map((word) => `"${word.replace(/"/g, "")}"*`).join(" ");
        rows = handle.prepare(`
          SELECT e.* FROM entries_fts f JOIN entries e ON e.id = f.rowid
          WHERE entries_fts MATCH ? AND e.pinned_at IS NULL${kindClause}
          ORDER BY bm25(entries_fts), e.id DESC LIMIT ?
        `).all(match, ...kinds, limit) as Row[];
      } else if (words.length) {
        const like = words.map(() => " AND lower(e.text) LIKE ? ESCAPE '\\'").join("");
        rows = handle.prepare(`
          SELECT e.* FROM entries e WHERE e.pinned_at IS NULL${kindClause}${like} ORDER BY e.id DESC LIMIT ?
        `).all(...kinds, ...words.map((word) => `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`), limit) as Row[];
      } else {
        const beforeClause = typeof query.before === "number" ? " AND e.id < ?" : "";
        rows = handle.prepare(`
          SELECT e.* FROM entries e WHERE e.pinned_at IS NULL${kindClause}${beforeClause} ORDER BY e.id DESC LIMIT ?
        `).all(...kinds, ...(typeof query.before === "number" ? [query.before] : []), limit + 1) as Row[];
        const more = rows.length > limit;
        const page = rows.slice(0, limit);
        return {
          available: true,
          mode: "recent",
          entries: page.map((row) => toEntry(row, false)),
          nextBefore: more ? page[page.length - 1]!.id : null,
          counts: counts(handle),
        };
      }
      return { available: true, mode: "keyword", entries: rows.map((row) => toEntry(row, false)), nextBefore: null, counts: counts(handle) };
    } catch (error) {
      // Thrown, not an empty page: "nothing found" would hide a failure the
      // person can retry.
      warn("cto_archive.search_failed", error);
      throw error;
    }
  };

  /* ── Heat: which pinned notes are cold ── */

  /** A note was written, rewritten, said again or recalled. */
  const touchNote = (scope: CtoNotesScope, text: string): void => {
    try {
      open()?.prepare(UPSERT_HEAT_SQL).run(scope, ctoNoteKey(text), nowIso());
    } catch (error) {
      warn("cto_archive.heat_failed", error);
    }
  };

  /** Last use of each note, by `ctoNoteKey`. A note with none was never touched since the archive began. */
  const noteHeat = (scope: CtoNotesScope): Map<string, string> => {
    const handle = open();
    if (!handle) return new Map();
    try {
      const rows = handle.prepare("SELECT note_key, last_used_at FROM note_heat WHERE scope = ?").all(scope) as Array<{ note_key: string; last_used_at: string }>;
      return new Map(rows.map((row) => [row.note_key, row.last_used_at]));
    } catch (error) {
      // No heat: every note counts as untouched and leaves top of the file first.
      warn("cto_archive.heat_read_failed", error);
      return new Map();
    }
  };

  /* ── The account copy: what a new home machine takes over ── */

  /**
   * Changes whenever what the account copy carries could: an entry added,
   * archived again or pinned, or a note used (its heat). Cheap, so the copy
   * can skip a pack when nothing moved.
   */
  const changeStamp = (): string | null => {
    const handle = open();
    if (!handle) return null;
    try {
      const row = handle.prepare(`
        SELECT COUNT(*) AS n, MAX(id) AS top, MAX(archived_at) AS at,
          (SELECT COUNT(*) FROM note_heat) AS heat, (SELECT MAX(last_used_at) FROM note_heat) AS used
        FROM entries WHERE pinned_at IS NULL
      `).get() as { n: number; top: number | null; at: string | null; heat: number; used: string | null };
      return `${row.n}|${row.top ?? 0}|${row.at ?? ""}|${row.heat}|${row.used ?? ""}`;
    } catch (error) {
      warn("cto_archive.stamp_failed", error);
      return null;
    }
  };

  /** Every entry not pinned back into the notes, oldest first. Null when there is no archive. */
  const exportRows = (): CtoArchiveCarriedRow[] | null => {
    const handle = open();
    if (!handle) return null;
    const rows = handle.prepare("SELECT * FROM entries WHERE pinned_at IS NULL ORDER BY id ASC").all() as Row[];
    return rows.map((row) => {
      const entry = toEntry(row, true);
      return {
        id: entry.id,
        kind: entry.kind,
        scope: entry.scope,
        text: entry.text,
        reason: entry.reason,
        sourceAt: entry.sourceAt,
        sourceLabel: entry.sourceLabel,
        archivedAt: entry.archivedAt,
      };
    });
  };

  /** The heat of the given note keys (the lines in the notes now). */
  const exportHeat = (scope: CtoNotesScope, keys: ReadonlySet<string>): CtoNoteHeatRow[] => {
    const heat = noteHeat(scope);
    return Array.from(heat.entries())
      .filter(([key]) => keys.has(key))
      .map(([key, at]) => ({ scope, key, at }));
  };

  /**
   * Heat from the machine the CTO moved from, for the notes it carried. For
   * each of those notes it replaces this machine's: the notes came from there,
   * so that is when each was last used. Other notes keep their heat.
   */
  const importHeat = (rows: readonly CtoNoteHeatRow[]): void => {
    const handle = open();
    if (!handle || !rows.length) return;
    try {
      const upsert = handle.prepare(UPSERT_HEAT_SQL);
      inTransaction(handle, () => {
        for (const row of rows) upsert.run(row.scope, row.key, row.at);
      });
    } catch (error) {
      warn("cto_archive.heat_import_failed", error, { count: rows.length });
    }
  };

  /** A meta value, or null when there is none or the read failed. */
  const readMeta = (key: string): string | null => {
    try {
      const row = open()?.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
      return row?.value ?? null;
    } catch (error) {
      warn("cto_archive.meta_read_failed", error, { key });
      return null;
    }
  };

  /** False when the write failed (logged). */
  const writeMeta = (key: string, value: string): boolean => {
    try {
      const handle = open();
      if (!handle) return false;
      handle.prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
      return true;
    } catch (error) {
      warn("cto_archive.meta_write_failed", error, { key });
      return false;
    }
  };

  const close = (): void => {
    try {
      db?.close();
    } catch {
      // Closing at teardown: nothing left to protect.
    }
    db = null;
  };

  return {
    available,
    add,
    addMany,
    get,
    markPinned,
    markPinnedMatching,
    search,
    touchNote,
    noteHeat,
    changeStamp,
    exportRows,
    exportHeat,
    importHeat,
    readMeta,
    writeMeta,
    close,
    path: dbPath,
  };
}

export type CtoMemoryArchive = ReturnType<typeof createCtoMemoryArchive>;
