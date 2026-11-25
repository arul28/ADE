import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import {
  CTO_ARCHIVE_KINDS,
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
 * discoveries once drained. Machine-local and project-scoped, in its own
 * SQLite file next to the notes (`.ade/cto/archive.db`, never inside ade.db:
 * FTS5 tables cannot be cr-sqlite CRRs and none of this syncs).
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
};

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

function emptyCounts(): Record<CtoArchiveKind, number> {
  return { note: 0, fact: 0, decision: 0, discovery: 0, story: 0 };
}

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
      // A file that exists but won't open is the only copy of what it holds:
      // set it aside and start a new one, never delete it.
      if (fs.existsSync(dbPath)) {
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
   * Adds an entry, or refreshes the one that already says it: a note archived
   * again comes back out of `pinned` with the new reason. Returns the id, or
   * null when there is no archive.
   */
  const add = (record: CtoArchiveRecord): number | null => {
    const handle = open();
    if (!handle) return null;
    const text = redactSecrets(record.text.trim()).slice(0, ENTRY_MAX_CHARS);
    if (!text) return null;
    const scope = record.kind === "note" ? record.scope ?? "project" : null;
    const key = textKey(record.kind, scope, text);
    const now = nowIso();
    try {
      const existing = handle.prepare("SELECT id FROM entries WHERE text_key = ?").get(key) as { id: number } | undefined;
      if (existing) {
        if (record.kind === "note") {
          handle.prepare("UPDATE entries SET reason = ?, archived_at = ?, pinned_at = NULL WHERE id = ?")
            .run(record.reason ?? null, now, existing.id);
        }
        return existing.id;
      }
      const result = handle.prepare(`
        INSERT INTO entries(kind, scope, text, reason, source_session_id, source_at, source_label, archived_at, text_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.kind,
        scope,
        text,
        record.reason ?? null,
        record.sourceSessionId ?? null,
        record.sourceAt ?? null,
        record.sourceLabel ?? null,
        now,
        key,
      );
      return Number(result.lastInsertRowid);
    } catch (error) {
      warn("cto_archive.add_failed", error, { kind: record.kind });
      return null;
    }
  };

  /** Many entries in one transaction (a fold's facts, an import). */
  const addMany = (records: readonly CtoArchiveRecord[]): number => {
    const handle = open();
    if (!handle || !records.length) return 0;
    let added = 0;
    try {
      handle.exec("BEGIN");
      const before = (handle.prepare("SELECT COUNT(*) AS n FROM entries").get() as { n: number }).n;
      for (const record of records) add(record);
      added = (handle.prepare("SELECT COUNT(*) AS n FROM entries").get() as { n: number }).n - before;
      handle.exec("COMMIT");
    } catch (error) {
      try {
        handle.exec("ROLLBACK");
      } catch {
        // Nothing was open.
      }
      warn("cto_archive.add_many_failed", error, { count: records.length });
      return 0;
    }
    return added;
  };

  const get = (id: number): CtoArchiveEntry | null => {
    const handle = open();
    if (!handle) return null;
    const row = handle.prepare("SELECT * FROM entries WHERE id = ? AND pinned_at IS NULL").get(id) as Row | undefined;
    return row ? toEntry(row, true) : null;
  };

  /** An entry went back into the notes: it leaves the archive (the row stays for when it comes back). */
  const markPinned = (id: number): void => {
    open()?.prepare("UPDATE entries SET pinned_at = ? WHERE id = ?").run(nowIso(), id);
  };

  const counts = (handle: DatabaseSyncType): Record<CtoArchiveKind, number> => {
    const out = emptyCounts();
    const rows = handle.prepare("SELECT kind, COUNT(*) AS n FROM entries WHERE pinned_at IS NULL GROUP BY kind").all() as Array<{ kind: string; n: number }>;
    for (const row of rows) if (row.kind in out) out[row.kind as CtoArchiveKind] = row.n;
    return out;
  };

  const search = (query: CtoArchiveQuery = {}): CtoArchivePage => {
    const handle = open();
    if (!handle) return { available: false, mode: "recent", entries: [], nextBefore: null, counts: emptyCounts() };
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
      warn("cto_archive.search_failed", error);
      return { available: true, mode: "keyword", entries: [], nextBefore: null, counts: emptyCounts() };
    }
  };

  /* ── Heat: which pinned notes are cold ── */

  /** A note was written, rewritten, said again or recalled. */
  const touchNote = (scope: CtoNotesScope, text: string): void => {
    try {
      open()?.prepare(`
        INSERT INTO note_heat(scope, note_key, last_used_at) VALUES (?, ?, ?)
        ON CONFLICT(scope, note_key) DO UPDATE SET last_used_at = excluded.last_used_at
      `).run(scope, ctoNoteKey(text), nowIso());
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

  const readMeta = (key: string): string | null => {
    const row = open()?.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  };

  const writeMeta = (key: string, value: string): void => {
    open()?.prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  };

  const close = (): void => {
    try {
      db?.close();
    } catch {
      // Closing at teardown: nothing left to protect.
    }
    db = null;
  };

  return { available, add, addMany, get, markPinned, search, touchNote, noteHeat, readMeta, writeMeta, close, path: dbPath };
}

export type CtoMemoryArchive = ReturnType<typeof createCtoMemoryArchive>;
