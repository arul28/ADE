import { createRequire } from "node:module";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";

type DatabaseSyncConstructor = new (
  dbPath: string,
  options?: { allowExtension?: boolean; readOnly?: boolean },
) => DatabaseSyncType;

const require = createRequire(path.join(process.cwd(), "ade-runtime.cjs"));
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: DatabaseSyncConstructor;
};

export function openReadOnlyDatabase(dbPath: string): DatabaseSyncType {
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
