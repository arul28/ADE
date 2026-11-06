import fs from "node:fs";

/*
 * What this process's databases are doing, for the brain's resource-pressure
 * sampling (`resourcePressureMonitor.ts`): which ADE databases are open (to
 * read their write-ahead logs' size) and which tables take the writes.
 *
 * The write count rides the statement wrapper every `run` already goes
 * through (`kvDb.ts`), so it costs one map lookup and one increment per
 * write. The SQL-to-table answer is cached per statement text; ADE's SQL is a
 * fixed set of strings, and the cache starts over if something builds them
 * dynamically. Table names are ADE's own schema, never user data.
 */

const TABLE_BY_SQL_LIMIT = 2_048;
const tableBySql = new Map<string, string | null>();
const writesByTable = new Map<string, number>();
const openDatabases = new Map<string, number>();

const WRITE_TARGET = /^\s*(?:insert(?:\s+or\s+\w+)?\s+into|replace\s+into|update(?:\s+or\s+\w+)?|delete\s+from)\s+["'`[]?([A-Za-z_][A-Za-z0-9_]*)/i;

/** The table a write statement targets, or null for anything else. Pure. */
export function writeTargetTable(sql: string): string | null {
  const match = WRITE_TARGET.exec(sql);
  return match ? match[1]!.toLowerCase() : null;
}

/** Called by `kvDb`'s statement wrapper for every `run`. */
export function noteDbWrite(sql: string): void {
  let table = tableBySql.get(sql);
  if (table === undefined) {
    if (tableBySql.size >= TABLE_BY_SQL_LIMIT) tableBySql.clear();
    table = writeTargetTable(sql);
    tableBySql.set(sql, table);
  }
  if (table) writesByTable.set(table, (writesByTable.get(table) ?? 0) + 1);
}

/** The writes per table since the last call, most first; the counter starts over. */
export function takeDbWriteCounts(): Array<{ table: string; writes: number }> {
  const counts = [...writesByTable.entries()]
    .map(([table, writes]) => ({ table, writes }))
    .sort((left, right) => right.writes - left.writes);
  writesByTable.clear();
  return counts;
}

export function noteDbOpened(dbPath: string): void {
  openDatabases.set(dbPath, (openDatabases.get(dbPath) ?? 0) + 1);
}

export function noteDbClosed(dbPath: string): void {
  const count = (openDatabases.get(dbPath) ?? 0) - 1;
  if (count > 0) openDatabases.set(dbPath, count);
  else openDatabases.delete(dbPath);
}

/**
 * The size of each open database's write-ahead log, in MB, largest first. One
 * asynchronous `stat` per open database (a handful), so a drive that stopped
 * answering cannot hold the event loop; a missing `-wal` (checkpointed and
 * removed) is 0. Paths stay in this process.
 */
export async function openDatabaseWalSizesMb(): Promise<number[]> {
  const sizes = await Promise.all([...openDatabases.keys()].map(async (dbPath) => {
    try {
      return Math.round((await fs.promises.stat(`${dbPath}-wal`)).size / (1024 * 1024));
    } catch {
      return 0;
    }
  }));
  return sizes.sort((left, right) => right - left);
}
