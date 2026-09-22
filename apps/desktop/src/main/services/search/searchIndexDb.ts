import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

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
 * cheap as deleting the file. Bump the schema version for any DDL change —
 * mismatches drop and recreate the database instead of migrating.
 */
export const SEARCH_INDEX_SCHEMA_VERSION = 4;

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

  const create = (): DatabaseSyncType => {
    const db = openAt(dbPath);
    assertFts5Available(db);
    db.exec(DDL);
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schemaVersion', ?)").run(
      String(SEARCH_INDEX_SCHEMA_VERSION)
    );
    return db;
  };

  let db: DatabaseSyncType;
  try {
    db = openAt(dbPath);
    // Before anything that needs the module, so the caller gets the named
    // error instead of a file deletion it cannot benefit from.
    assertFts5Available(db);
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

/** Drop every row (docs, FTS, cursors) while keeping the schema. */
export function clearSearchIndex(db: DatabaseSyncType): void {
  db.exec("DELETE FROM docs_fts");
  db.exec("DELETE FROM docs");
  db.exec("DELETE FROM sources");
  db.exec("DELETE FROM meta WHERE key <> 'schemaVersion'");
}
