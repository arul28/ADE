import { createRequire } from "node:module";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

type DatabaseSyncConstructor = new (
  dbPath: string,
  options?: { allowExtension?: boolean; readOnly?: boolean },
) => DatabaseSyncType;

export type NodeSqlite = {
  DatabaseSync: DatabaseSyncConstructor;
  backup: (source: DatabaseSyncType, destination: string) => Promise<number>;
};

let nodeSqlite: NodeSqlite | null = null;

/**
 * `node:sqlite`, loaded on the first open. A static import is rewritten by the
 * desktop test bundler into a missing `sqlite` URL, so it is a runtime require.
 * Loading it lazily lets modules that load with every ACP dialect, and the
 * usage ledger worker, import this one without paying for SQLite until a
 * database is actually opened.
 */
export function loadNodeSqlite(): NodeSqlite {
  if (!nodeSqlite) {
    const require = createRequire(path.join(process.cwd(), "ade-runtime.cjs"));
    nodeSqlite = require("node:sqlite") as NodeSqlite;
  }
  return nodeSqlite;
}

/** Open `dbPath` read-only. Throws when the file cannot be opened. */
export function openReadOnlyDatabase(dbPath: string): DatabaseSyncType {
  const { DatabaseSync } = loadNodeSqlite();
  return new DatabaseSync(dbPath, { readOnly: true });
}

export function hasTable(db: DatabaseSyncType, tableName: string): boolean {
  return Boolean(
    db.prepare("select 1 as present from sqlite_master where type = 'table' and name = ? limit 1")
      .get<{ present?: number }>(tableName)?.present,
  );
}

export function hasColumn(
  db: DatabaseSyncType,
  tableName: string,
  columnName: string,
): boolean {
  return db.prepare(`pragma table_info(${tableName})`)
    .all<{ name?: string }>()
    .some((row) => row.name === columnName);
}
