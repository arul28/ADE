import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type { MaintenanceStepResult } from "../../../shared/types/storage";
import { openReadOnlyDatabase } from "../projects/readOnlySqlite";

// Anchor createRequire to a synthetic CJS file so builtin resolution follows
// the active runtime (same pattern as kvDb.ts).
const require = createRequire(path.join(process.cwd(), "ade-runtime.cjs"));
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (dbPath: string) => DatabaseSyncType;
};

/**
 * The search index is a machine-local, disposable cache. It lives in its own
 * SQLite file (never inside ade.db): FTS5 virtual tables cannot be cr-sqlite
 * CRRs, the index must never sync to other devices, and a rebuild must be as
 * cheap as deleting the file. Bump the schema version for any DDL change, or
 * when doc ids change shape — mismatches drop and recreate the database
 * instead of migrating, and the delayed background backfill refills it.
 *
 * 5: a steer's lifecycle rows fold onto one `chat:<session>:steer:<steerId>`
 * doc; indexes built before that still hold them as per-row docs.
 */
export const SEARCH_INDEX_SCHEMA_VERSION = 5;

export const SEARCH_INDEX_DB_FILENAME = "search-index.db";

const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS docs (
  id INTEGER PRIMARY KEY,
  doc_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  lane_id TEXT,
  lane_name TEXT,
  session_id TEXT,
  owner_session_id TEXT,
  title TEXT NOT NULL,
  rank_title TEXT,
  snippet_source TEXT,
  deep_link TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS docs_kind_idx ON docs(kind, updated_at);
CREATE INDEX IF NOT EXISTS docs_session_idx ON docs(session_id);
CREATE INDEX IF NOT EXISTS docs_owner_session_idx ON docs(owner_session_id);
CREATE INDEX IF NOT EXISTS docs_lane_idx ON docs(lane_id);
CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
  rank_title,
  body,
  tokenize='porter unicode61'
);
CREATE TABLE IF NOT EXISTS sources (
  source_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  cursor INTEGER NOT NULL DEFAULT 0,
  doc_seq INTEGER NOT NULL DEFAULT 0,
  state TEXT,
  updated_at TEXT
);
`;

export type SearchIndexDb = {
  db: DatabaseSyncType;
  path: string;
  close: () => void;
};

function tryRemoveDbFiles(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.rmSync(`${dbPath}${suffix}`, { force: true });
    } catch {
      // best effort — a locked file will be handled by the next open attempt
    }
  }
}

function openAt(dbPath: string): DatabaseSyncType {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  return db;
}

function readSchemaVersion(db: DatabaseSyncType): number | null {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get() as
      | { value?: string }
      | undefined;
    if (!row?.value) return null;
    const parsed = Number(row.value);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * This SQLite build cannot make an FTS5 table, so there can be no index.
 *
 * Distinguished from every other open failure because the answer is the
 * opposite: a corrupt file is worth deleting and recreating, a missing module
 * is not. Treating the two the same is what made a runtime without FTS5 delete
 * and recreate the index file on every indexing attempt, failing each time and
 * logging `search.index_source_failed` several times a second — measured on a
 * dev brain, hundreds of lines and a `no such module: fts5` per chat event.
 */
export class SearchIndexFts5UnavailableError extends Error {
  readonly code = "SEARCH_INDEX_FTS5_UNAVAILABLE" as const;

  constructor(readonly cause: unknown) {
    super(
      "SEARCH_INDEX_FTS5_UNAVAILABLE: this SQLite build has no FTS5 module, so the search index cannot be created. Search stands down; nothing else is affected.",
    );
    this.name = "SearchIndexFts5UnavailableError";
  }
}

/**
 * Can this SQLite build make an FTS5 table?
 *
 * Probed on a TEMP table so the answer costs nothing and leaves nothing
 * behind, and probed BEFORE the DDL so the failure is named rather than
 * arriving as a bare "no such module" from whichever statement hit it first.
 */
export function assertFts5Available(db: Pick<DatabaseSyncType, "exec">): void {
  try {
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS temp.ade_fts5_probe USING fts5(probe)");
    db.exec("DROP TABLE IF EXISTS temp.ade_fts5_probe");
  } catch (cause) {
    throw new SearchIndexFts5UnavailableError(cause);
  }
}

/**
 * Open (or create) the search index database. On schema mismatch or any
 * corruption the file is dropped and recreated — the index is a cache and the
 * ingestion cursors it loses are rebuilt by the backfill pass.
 *
 * Throws {@link SearchIndexFts5UnavailableError} when the runtime has no FTS5.
 * That is not recoverable by deleting anything, so it is never retried here.
 */
export function openSearchIndexDb(cacheDir: string): SearchIndexDb {
  const dbPath = path.join(cacheDir, SEARCH_INDEX_DB_FILENAME);

  // A failed probe closes the handle it opened. On Windows an open handle
  // would also keep the index file from being deleted until exit.
  const openWithFts5 = (): DatabaseSyncType => {
    const db = openAt(dbPath);
    try {
      assertFts5Available(db);
    } catch (error) {
      db.close();
      throw error;
    }
    return db;
  };

  const create = (): DatabaseSyncType => {
    const db = openWithFts5();
    // Before the first table: deletes then hand pages back in small steps
    // (`compactSearchIndex`) instead of leaving the file at its peak size.
    db.exec("PRAGMA auto_vacuum = INCREMENTAL");
    db.exec(DDL);
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schemaVersion', ?)").run(
      String(SEARCH_INDEX_SCHEMA_VERSION)
    );
    return db;
  };

  let db: DatabaseSyncType;
  try {
    // Before anything that needs the module, so the caller gets the named
    // error instead of a file deletion it cannot benefit from.
    db = openWithFts5();
    const version = readSchemaVersion(db);
    if (version !== SEARCH_INDEX_SCHEMA_VERSION) {
      db.close();
      tryRemoveDbFiles(dbPath);
      db = create();
    } else {
      // Ensure tables exist even if the meta row survived a partial write.
      db.exec(DDL);
    }
  } catch (error) {
    if (error instanceof SearchIndexFts5UnavailableError) throw error;
    try {
      tryRemoveDbFiles(dbPath);
    } catch {
      // ignore
    }
    db = create();
  }

  return {
    db,
    path: dbPath,
    close: () => {
      try {
        db.close();
      } catch {
        // ignore double-close
      }
    }
  };
}

/** What a read-only open found at a project's index path. */
export type SearchIndexReadOpen =
  | { status: "open"; index: SearchIndexDb }
  /** No index file yet. */
  | { status: "missing" }
  /** An index file this build cannot read: another schema version, or it fails to open. */
  | { status: "unusable" };

/**
 * Open an existing index for reading only.
 *
 * For a caller that does not own the index: a search across projects reads
 * the file of a project whose runtime is not loaded. So this never creates,
 * migrates or deletes anything. The owning runtime rebuilds an unusable index
 * the next time the project is opened.
 */
export function openSearchIndexDbReadOnly(cacheDir: string): SearchIndexReadOpen {
  const dbPath = path.join(cacheDir, SEARCH_INDEX_DB_FILENAME);
  if (!fs.existsSync(dbPath)) return { status: "missing" };
  let db: DatabaseSyncType;
  try {
    db = openReadOnlyDatabase(dbPath);
  } catch {
    return { status: "unusable" };
  }
  const opened = db;
  const close = (): void => {
    try {
      opened.close();
    } catch {
      // ignore double-close
    }
  };
  try {
    // A WAL reader does not wait on the owner's writes; this only bounds the
    // rare checkpoint or recovery lock, on a thread that must not stall.
    opened.exec("PRAGMA busy_timeout = 250");
    if (readSchemaVersion(opened) === SEARCH_INDEX_SCHEMA_VERSION) {
      return { status: "open", index: { db: opened, path: dbPath, close } };
    }
  } catch {
    // Fall through: a handle that cannot be configured cannot be read.
  }
  close();
  return { status: "unusable" };
}

/** Drop every row (docs, FTS, cursors) while keeping the schema. */
export function clearSearchIndex(db: DatabaseSyncType): void {
  db.exec("DELETE FROM docs_fts");
  db.exec("DELETE FROM docs");
  db.exec("DELETE FROM sources");
  db.exec("DELETE FROM meta WHERE key <> 'schemaVersion'");
}

/** Free pages above this share of the file, and at least this many bytes, are worth a rebuild. */
const SEARCH_INDEX_COMPACT_MIN_FREE_FRACTION = 0.25;
const SEARCH_INDEX_COMPACT_MIN_FREE_BYTES = 16 * 1024 * 1024;
const SEARCH_INDEX_INCREMENTAL_CHUNK_PAGES = 2_000;
const SEARCH_INDEX_INCREMENTAL_MAX_CHUNKS = 25;

function indexFileBytes(dbPath: string): number {
  let total = 0;
  for (const suffix of ["", "-wal"]) {
    try {
      total += fs.statSync(`${dbPath}${suffix}`).size;
    } catch {
      // absent
    }
  }
  return total;
}

/**
 * Hand the index's free pages back to the disk. Re-indexing deletes and
 * re-inserts rows, and an index built before incremental auto-vacuum keeps
 * every freed page: one measured index was 384 MB with 92% of its pages free.
 * A file in that state is rebuilt once (`VACUUM`, which also switches on
 * incremental auto-vacuum); after that each call frees a bounded number of
 * pages, so the blocking rebuild never runs again.
 */
export function compactSearchIndex(index: SearchIndexDb): MaintenanceStepResult {
  const pragma = (name: string): number => {
    const row = index.db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
    return Number(row ? Object.values(row)[0] : 0) || 0;
  };
  const before = indexFileBytes(index.path);
  const pageSize = pragma("page_size");
  const pageCount = pragma("page_count");
  const freeBefore = pragma("freelist_count");
  let freed = 0;
  if (pragma("auto_vacuum") === 2) {
    if (freeBefore === 0) return { itemsAffected: 0, bytesReclaimed: 0, skippedReason: "nothing_due" };
    let free = freeBefore;
    for (let chunk = 0; chunk < SEARCH_INDEX_INCREMENTAL_MAX_CHUNKS && free > 0; chunk += 1) {
      index.db.exec(`PRAGMA incremental_vacuum(${SEARCH_INDEX_INCREMENTAL_CHUNK_PAGES})`);
      free = pragma("freelist_count");
    }
    freed = freeBefore - free;
  } else {
    const freeFraction = pageCount > 0 ? freeBefore / pageCount : 0;
    if (freeFraction < SEARCH_INDEX_COMPACT_MIN_FREE_FRACTION || freeBefore * pageSize < SEARCH_INDEX_COMPACT_MIN_FREE_BYTES) {
      return { itemsAffected: 0, bytesReclaimed: 0, skippedReason: "below_threshold" };
    }
    index.db.exec("PRAGMA auto_vacuum = INCREMENTAL");
    index.db.exec("VACUUM");
    freed = freeBefore;
  }
  index.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  return {
    itemsAffected: Math.max(0, freed),
    bytesReclaimed: Math.max(0, before - indexFileBytes(index.path)),
    skippedReason: null,
  };
}
