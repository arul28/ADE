import fs from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type { Logger } from "../logging/logger";
import { safeJsonParse } from "../shared/utils";
import { resolveCrsqliteExtensionPath } from "./crsqliteExtension";
import type { ApplyRemoteChangesResult, CrsqlChangeRow, SyncScalar } from "../../../shared/types/sync";

type DatabaseSyncConstructor = new (dbPath: string, options?: { allowExtension?: boolean }) => DatabaseSyncType;

// Anchor createRequire to a synthetic CJS file so builtin resolution follows the active runtime.
const require = createRequire(path.join(process.cwd(), "ade-runtime.cjs"));
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: DatabaseSyncConstructor };

export type SqlValue = string | number | boolean | null | Uint8Array;

export type AdeDbSyncApi = {
  isAvailable?: () => boolean;
  getSiteId: () => string;
  getDbVersion: () => number;
  exportChangesSince: (version: number) => CrsqlChangeRow[];
  applyChanges: (changes: CrsqlChangeRow[]) => ApplyRemoteChangesResult;
};

/**
 * Well-known KV key registry. Services store typed JSON under these key
 * patterns. The registry is advisory -- callers use `getJson<T>` to specify
 * the expected shape -- but having the keys in one place aids discoverability
 * and prevents key collisions.
 *
 * Known key patterns:
 *   "onboarding:status"           -> OnboardingStatus
 *   "keybinding:overrides"        -> KeybindingOverride[]
 *   "trusted_shared_hash"         -> string
 *   "context_doc_last_run"        -> { provider; generatedAt; prdPath; archPath }
 *   "dock:<projectId>"            -> DockLayout
 *   "file-tree:<projectId>"       -> unknown (file tree state)
 *   "graph-state:<projectId>"     -> GraphPersistedState
 *   "agent-chat-parallel-launch:<projectRoot>:<laneId>" -> AgentChatParallelLaunchState
 *   "auto-rebase:<laneId>"        -> StoredStatus
 *   "rebase-suggestion:<laneId>"  -> StoredSuggestionState
 */

export type AdeDb = {
  /**
   * Retrieve a JSON value from the KV store. Callers should always supply the
   * expected type parameter `T` to get type-safe access, e.g.
   * `db.getJson<MyType>("my:key")`.
   */
  getJson: <T = unknown>(key: string) => T | null;

  /**
   * Persist a JSON-serializable value under `key`. Passing `null` or
   * `undefined` will store the literal JSON `null`.
   */
  setJson: (key: string, value: unknown) => void;

  run: (sql: string, params?: SqlValue[]) => void;
  get: <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: SqlValue[]) => T | null;
  all: <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: SqlValue[]) => T[];

  sync: AdeDbSyncApi;
  flushNow: () => void;
  close: () => void;
};

function ensureParentDir(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function openRawDatabase(dbPath: string): DatabaseSyncType {
  ensureParentDir(dbPath);
  const db = new DatabaseSync(dbPath, { allowExtension: true });
  // Allow concurrent access from multiple ADE processes (e.g. dogfooding).
  // Without this, a second instance gets SQLITE_BUSY immediately on writes.
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

function describeUnsupportedDbValue(value: unknown): string {
  const kind = value === undefined
    ? "undefined"
    : value === null
      ? "null"
      : Array.isArray(value)
        ? "array"
        : typeof value;
  const ctor =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as { constructor?: { name?: string } }).constructor?.name
      : null;
  return ctor && ctor !== "Object" ? `${kind} (${ctor})` : kind;
}

function toDbValue(value: SqlValue | SyncScalar, index?: number): string | number | null | Uint8Array {
  if (value == null || typeof value === "string" || typeof value === "number") {
    return value;
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (value instanceof Uint8Array) {
    return value;
  }
  if (typeof value === "object" && "type" in value && value.type === "bytes") {
    return Buffer.from(value.base64, "base64");
  }
  const suffix = typeof index === "number" ? ` at parameter ${index + 1}` : "";
  throw new Error(`Unsupported database value${suffix}: ${describeUnsupportedDbValue(value)}`);
}

function runStatement(db: DatabaseSyncType, sql: string, params: Array<SqlValue | SyncScalar> = []): { changes: number } {
  try {
    return db.prepare(sql).run(...params.map((param, index) => toDbValue(param, index))) as { changes: number };
  } catch (error) {
    const statement = sql.replace(/\s+/g, " ").trim();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message} [sql=${statement}]`);
  }
}

function getRow<T>(db: DatabaseSyncType, sql: string, params: Array<SqlValue | SyncScalar> = []): T | null {
  try {
    return (db.prepare(sql).get(...params.map((param, index) => toDbValue(param, index))) as T | undefined) ?? null;
  } catch (error) {
    const statement = sql.replace(/\s+/g, " ").trim();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message} [sql=${statement}]`);
  }
}

function allRows<T>(db: DatabaseSyncType, sql: string, params: Array<SqlValue | SyncScalar> = []): T[] {
  try {
    return db.prepare(sql).all(...params.map((param, index) => toDbValue(param, index))) as T[];
  } catch (error) {
    const statement = sql.replace(/\s+/g, " ").trim();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message} [sql=${statement}]`);
  }
}

function rawHasTable(db: DatabaseSyncType, tableName: string): boolean {
  return Boolean(getRow(db, "select 1 as present from sqlite_master where type = 'table' and name = ? limit 1", [tableName]));
}

function rawHasColumn(db: DatabaseSyncType, tableName: string, columnName: string): boolean {
  return allRows<{ name: string }>(db, `pragma table_info('${tableName.replace(/'/g, "''")}')`)
    .some((column) => column.name === columnName);
}

function isReadonlyDatabaseError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /readonly database|SQLITE_READONLY/i.test(message);
}

function defaultLiteralForType(typeName: string): string {
  const normalized = typeName.trim().toLowerCase();
  if (normalized.includes("int") || normalized.includes("real") || normalized.includes("floa") || normalized.includes("doub") || normalized.includes("num")) {
    return "0";
  }
  if (normalized.includes("blob")) {
    return "X''";
  }
  return "''";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, "\"\"")}"`;
}

function rewriteCreateTableName(sql: string, fromName: string, toName: string): string {
  const pattern = new RegExp(
    `^(\\s*create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?)((?:["'\`\\[])?${escapeRegExp(fromName)}(?:["'\`\\]])?)`,
    "i",
  );
  return sql.replace(pattern, `$1${quoteIdentifier(toName)}`);
}

function retrofitLegacyPrimaryKeyNotNullSchema(db: DatabaseSyncType): boolean {
  const tables = allRows<{ name: string; sql: string }>(
    db,
    `select m.name, m.sql
       from sqlite_master m
      where m.type = 'table'
        and m.sql is not null
        and m.name not like 'sqlite_%'
        and m.name not like 'crsql_%'
        and m.name not like '%__crsql_clock'
        and m.name not like '%__crsql_pks'
        and lower(m.sql) not like 'create virtual%'
        and not exists (
          select 1 from sqlite_master v
           where v.type = 'table'
             and v.sql is not null
             and lower(v.sql) like 'create virtual%'
             and m.name like v.name || '\\_%' escape '\\'
        )`
  );

  let changed = false;
  runStatement(db, "pragma foreign_keys = off");
  try {
    for (const table of tables) {
      const tableInfo = allRows<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }>(db, `pragma table_info('${table.name.replace(/'/g, "''")}')`);

      let nextSql = table.sql;
      for (const column of tableInfo) {
        const columnPattern = new RegExp(`(^|[,(])\\s*${escapeRegExp(column.name)}\\s+([^,\\n\\r)]+)`, "im");
        const match = nextSql.match(columnPattern);
        if (!match) continue;
        let columnDefinition = match[0];
        if (column.pk > 0 && !/\bnot\s+null\b/i.test(columnDefinition)) {
          columnDefinition = columnDefinition.replace(/\bprimary\s+key\b/i, "not null primary key");
        }
        if (column.notnull === 1 && column.dflt_value == null && !/\bdefault\b/i.test(columnDefinition)) {
          columnDefinition = `${columnDefinition} default ${defaultLiteralForType(column.type)}`;
        }
        nextSql = nextSql.replace(match[0], columnDefinition);
      }

      nextSql = nextSql
        .split("\n")
        .filter((line) => !line.trim().toLowerCase().startsWith("foreign key("))
        .join("\n")
        .replace(/,\s*unique\s*\([^)]*\)(?:\s+on\s+conflict\s+\w+)?/gi, "")
        .replace(/\bunique\b(?:\s+on\s+conflict\s+\w+)?/gi, "")
        .replace(/,\s*\)/g, "\n    )");

      const indexes = allRows<{ name: string; unique: number; origin: string }>(db, `pragma index_list('${table.name.replace(/'/g, "''")}')`);
      const hasDisallowedUniqueIndices = indexes.some((index) => index.unique && index.origin !== "pk");
      if (nextSql === table.sql && !hasDisallowedUniqueIndices) {
        continue;
      }

      const repairName = `__ade_crr_repair_${table.name}`;
      const rewrittenSql = rewriteCreateTableName(nextSql, table.name, repairName);
      const columnsSql = tableInfo.map((column) => quoteIdentifier(column.name)).join(", ");

      runStatement(db, rewrittenSql);
      runStatement(
        db,
        `insert into ${quoteIdentifier(repairName)} (${columnsSql}) select ${columnsSql} from ${quoteIdentifier(table.name)}`,
      );
      runStatement(db, `drop table ${quoteIdentifier(table.name)}`);
      runStatement(db, `alter table ${quoteIdentifier(repairName)} rename to ${quoteIdentifier(table.name)}`);
      changed = true;
    }
  } finally {
    runStatement(db, "pragma foreign_keys = on");
  }

  return changed;
}

/**
 * Desired foreign key constraints with ON DELETE actions.
 *
 * Keyed by `"table:column"`.  `references` is the target (e.g. `"pull_requests(id)"`),
 * `action` is the ON DELETE clause (e.g. `"on delete cascade"`).
 *
 * When a database was created before these clauses were added to the CREATE
 * TABLE statements the stored schema in `sqlite_master` will be missing them;
 * this map drives a one-time table-rebuild migration that adds the correct
 * referential actions.
 */
const FK_CONSTRAINTS: Record<string, { references: string; action: string }> = {
  // PR convergence loop tables
  "pr_issue_inventory:pr_id": { references: "pull_requests(id)", action: "on delete cascade" },
  "pr_pipeline_settings:pr_id": { references: "pull_requests(id)", action: "on delete cascade" },
  "pr_convergence_state:pr_id": { references: "pull_requests(id)", action: "on delete cascade" },
};

/**
 * Retrofit existing tables whose stored CREATE TABLE SQL is missing the
 * desired ON DELETE CASCADE / SET NULL clauses.
 *
 * This mirrors the approach of `retrofitLegacyPrimaryKeyNotNullSchema`:
 * disable FK enforcement, recreate affected tables with the corrected
 * schema via a temp-table swap, then re-enable FK enforcement.
 *
 * Returns `true` if any table was rebuilt.
 */
function retrofitForeignKeyCascadeActions(db: DatabaseSyncType, crsqliteEnabled: boolean): boolean {
  const tables = allRows<{ name: string; sql: string }>(
    db,
    `select m.name, m.sql
       from sqlite_master m
      where m.type = 'table'
        and m.sql is not null
        and m.name not like 'sqlite_%'
        and m.name not like 'crsql_%'
        and m.name not like '%__crsql_clock'
        and m.name not like '%__crsql_pks'
        and lower(m.sql) not like 'create virtual%'
        and not exists (
          select 1 from sqlite_master v
           where v.type = 'table'
             and v.sql is not null
             and lower(v.sql) like 'create virtual%'
             and m.name like v.name || '\\_%' escape '\\'
        )`
  );

  // Build a lookup: tableName -> list of { column, references, action }
  const desiredByTable = new Map<string, Array<{ column: string; references: string; action: string }>>();
  for (const [key, constraint] of Object.entries(FK_CONSTRAINTS)) {
    const [tableName, column] = key.split(":");
    if (!desiredByTable.has(tableName)) {
      desiredByTable.set(tableName, []);
    }
    desiredByTable.get(tableName)!.push({ column, ...constraint });
  }

  let changed = false;
  runStatement(db, "pragma foreign_keys = off");
  try {
    for (const table of tables) {
      const desired = desiredByTable.get(table.name);
      if (!desired) continue;

      // CRR tables must not carry checked FK constraints — cr-sqlite strips
      // them during crsql_as_crr() and they must stay stripped.  Skip tables
      // that already are CRR-managed or will become CRR-eligible when the
      // extension is loaded.
      if (rawHasTable(db, `${table.name}__crsql_clock`)) continue;
      if (crsqliteEnabled) continue;

      let nextSql = table.sql;
      let needsRebuild = false;

      for (const { column, references, action } of desired) {
        // Match a foreign key constraint line for this column, e.g.:
        //   foreign key(pr_id) references pull_requests(id)
        // Optionally already carrying an ON DELETE clause.
        const fkPattern = new RegExp(
          `(foreign\\s+key\\s*\\(\\s*${escapeRegExp(column)}\\s*\\)\\s+references\\s+\\w+\\s*\\([^)]+\\))` +
          `(\\s+on\\s+delete\\s+\\w+(?:\\s+\\w+)?)?`,
          "i",
        );
        const match = nextSql.match(fkPattern);
        if (!match) {
          // FK line not present at all (e.g. stripped by previous migration or
          // table was created before the FK was added).  We need to add it.
          // Find the closing paren of the CREATE TABLE body and insert before it.
          const colPattern = new RegExp(`\\b${escapeRegExp(column)}\\b\\s+\\w+`, "i");
          if (colPattern.test(nextSql)) {
            const closingParenIdx = nextSql.lastIndexOf(")");
            if (closingParenIdx > 0) {
              const fkLine = `foreign key(${column}) references ${references} ${action}`;
              nextSql = nextSql.slice(0, closingParenIdx).trimEnd() +
                `,\n      ${fkLine}\n    ` +
                nextSql.slice(closingParenIdx);
              needsRebuild = true;
            }
          }
          continue;
        }

        const existingAction = (match[2] ?? "").trim().toLowerCase();
        if (existingAction === action) continue;

        // Replace the FK constraint with the corrected version
        const corrected = `${match[1]} ${action}`;
        nextSql = nextSql.replace(match[0], corrected);
        needsRebuild = true;
      }

      if (!needsRebuild) continue;

      const tableInfo = allRows<{ name: string }>(
        db,
        `pragma table_info('${table.name.replace(/'/g, "''")}')`
      );

      const repairName = `__ade_fk_repair_${table.name}`;
      const rewrittenSql = rewriteCreateTableName(nextSql, table.name, repairName);
      const columnsSql = tableInfo.map((col) => quoteIdentifier(col.name)).join(", ");

      runStatement(db, rewrittenSql);
      runStatement(
        db,
        `insert into ${quoteIdentifier(repairName)} (${columnsSql}) select ${columnsSql} from ${quoteIdentifier(table.name)}`,
      );
      runStatement(db, `drop table ${quoteIdentifier(table.name)}`);
      runStatement(db, `alter table ${quoteIdentifier(repairName)} rename to ${quoteIdentifier(table.name)}`);
      changed = true;
    }
  } finally {
    runStatement(db, "pragma foreign_keys = on");
  }

  return changed;
}

function writeMigrationBackupIfNeeded(dbPath: string): void {
  if (!fs.existsSync(dbPath)) return;
  const backupPath = `${dbPath}.pre-crsqlite-w1.bak`;
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(dbPath, backupPath);
  }
}

const LOCAL_ONLY_CRR_EXCLUDED_TABLES = new Set([
  "lane_detail_snapshots",
  "lane_list_snapshots",
  "pr_auto_link_ignores",
  "pull_request_ai_summaries",
]);

function listEligibleCrrTables(db: DatabaseSyncType): string[] {
  const tables = allRows<{ name: string; sql: string | null }>(
    db,
    `select m.name, m.sql
       from sqlite_master m
      where m.type = 'table'
        and m.sql is not null
        and m.name not like 'sqlite_%'
        and m.name not like 'crsql_%'
        and m.name not like '%__crsql_clock'
        and m.name not like '%__crsql_pks'
        and lower(m.sql) not like 'create virtual%'
        and not exists (
          select 1 from sqlite_master v
           where v.type = 'table'
             and v.sql is not null
             and lower(v.sql) like 'create virtual%'
             and m.name like v.name || '\\_%' escape '\\'
        )`
  );
  return tables
    .filter((table) => !LOCAL_ONLY_CRR_EXCLUDED_TABLES.has(table.name))
    .filter((table) => allRows<{ pk: number }>(db, `pragma table_info('${table.name.replace(/'/g, "''")}')`).some((column) => column.pk > 0))
    .map((table) => table.name);
}

function hasCrsqlMetadata(db: DatabaseSyncType): boolean {
  return Boolean(
    getRow(
      db,
      "select 1 as present from sqlite_master where type = 'table' and (name = 'crsql_master' or name = 'crsql_site_id' or name like '%__crsql_clock') limit 1"
    )
  );
}

function isCrsqliteRuntimeUsable(db: DatabaseSyncType): boolean {
  try {
    getRow(db, "select crsql_db_version() as db_version");
    getRow(db, "select crsql_internal_sync_bit() as sync_bit");
    return true;
  } catch {
    return false;
  }
}

const PHONE_CRITICAL_CRR_TABLES = [
  "lanes",
  "lane_state_snapshots",
  "terminal_sessions",
  "pull_requests",
  "pull_request_snapshots",
] as const;

function countTableRows(db: DatabaseSyncType, tableName: string): number {
  const row = getRow<{ count: number }>(db, `select count(1) as count from ${quoteIdentifier(tableName)}`);
  return Number(row?.count ?? 0);
}

function tableNeedsCrrRepair(db: DatabaseSyncType, tableName: string): { baseRowCount: number; pkRowCount: number } | null {
  const baseRowCount = countTableRows(db, tableName);
  if (baseRowCount <= 0) {
    return null;
  }

  const pksTable = `${tableName}__crsql_pks`;
  if (!rawHasTable(db, pksTable)) {
    return { baseRowCount, pkRowCount: 0 };
  }

  const pkRowCount = countTableRows(db, pksTable);
  return pkRowCount === baseRowCount ? null : { baseRowCount, pkRowCount };
}

function listCrrTriggers(db: DatabaseSyncType, tableName: string): string[] {
  return allRows<{ name: string }>(
    db,
    `select name
       from sqlite_master
      where type = 'trigger'
        and tbl_name = ?
        and name like ?`,
    [tableName, `${tableName}__crsql_%trig`],
  ).map((row) => row.name);
}

function dropCrrTriggers(db: DatabaseSyncType, tableName: string, logger?: Logger): number {
  const triggers = listCrrTriggers(db, tableName);
  for (const triggerName of triggers) {
    try {
      runStatement(db, `drop trigger if exists ${quoteIdentifier(triggerName)}`);
    } catch (error) {
      logger?.warn("db.crr_trigger_drop_failed", {
        tableName,
        triggerName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return triggers.length;
}

function removeExcludedCrrMetadata(db: DatabaseSyncType, logger?: Logger): void {
  for (const tableName of LOCAL_ONLY_CRR_EXCLUDED_TABLES) {
    const clockTableName = `${tableName}__crsql_clock`;
    const pksTableName = `${tableName}__crsql_pks`;
    const hasClockTable = rawHasTable(db, clockTableName);
    const hasPksTable = rawHasTable(db, pksTableName);
    const triggerCount = listCrrTriggers(db, tableName).length;
    const hasMasterRows = rawHasTable(db, "crsql_master")
      && rawHasColumn(db, "crsql_master", "tbl_name")
      && Boolean(getRow(db, "select 1 as present from crsql_master where tbl_name = ? limit 1", [tableName]));
    const hasChangesRows = rawHasTable(db, "crsql_changes")
      && rawHasColumn(db, "crsql_changes", "table")
      && Boolean(getRow(db, "select 1 as present from crsql_changes where [table] = ? limit 1", [tableName]));

    if (!hasClockTable && !hasPksTable && triggerCount === 0 && !hasMasterRows && !hasChangesRows) {
      continue;
    }

    let deletedMetadataCount = 0;
    if (hasMasterRows) {
      deletedMetadataCount += runStatement(db, "delete from crsql_master where tbl_name = ?", [tableName]).changes;
    }
    if (hasChangesRows) {
      deletedMetadataCount += runStatement(db, "delete from crsql_changes where [table] = ?", [tableName]).changes;
    }

    try {
      getRow(db, "select crsql_as_table(?) as ok", [tableName]);
    } catch {
      // Older or partial CRR metadata may not be registered enough for
      // crsql_as_table; explicit shadow-table cleanup below is still safe.
    }
    const droppedTriggerCount = dropCrrTriggers(db, tableName, logger);
    runStatement(db, `drop table if exists ${quoteIdentifier(clockTableName)}`);
    runStatement(db, `drop table if exists ${quoteIdentifier(pksTableName)}`);

    logger?.info("db.crr_excluded_metadata_removed", {
      tableName,
      hadClockTable: hasClockTable,
      hadPksTable: hasPksTable,
      droppedTriggerCount,
      deletedMetadataCount,
    });
  }
}

/**
 * Drop the legacy `unified_memories` + `unified_memories_fts` schema that
 * existed before #329 (Memory Wipe).
 *
 * Old DBs carry an FTS4 virtual table whose shadow tables (`*_segdir`,
 * `*_segments`, `*_docsize`, `*_stat`) cannot be dropped individually — the
 * retrofit pass that follows iterates `sqlite_master` and previously crashed
 * with `table <shadow> may not be dropped`. Without this cleanup, every user
 * upgrading from a pre-#329 build would brick on first launch.
 *
 * The function is idempotent: every statement uses `if exists`, so it is safe
 * to run on every open. Once a DB has been cleaned, subsequent calls are
 * cheap no-ops.
 */
function dropLegacyUnifiedMemoriesSchema(db: DatabaseSyncType, logger?: Logger): void {
  const ftsParent = "unified_memories_fts";
  const baseTable = "unified_memories";
  const hasFtsParent = rawHasTable(db, ftsParent);
  const hasBaseTable = rawHasTable(db, baseTable);
  if (!hasFtsParent && !hasBaseTable) return;

  for (const trigger of [
    "unified_memories_fts_ai",
    "unified_memories_fts_au",
    "unified_memories_fts_bd",
    "unified_memories_fts_bu",
  ]) {
    try {
      runStatement(db, `drop trigger if exists ${quoteIdentifier(trigger)}`);
    } catch (error) {
      logger?.warn("db.legacy_memory_trigger_drop_failed", {
        trigger,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (hasFtsParent) {
    try {
      runStatement(db, `drop table if exists ${quoteIdentifier(ftsParent)}`);
    } catch (error) {
      logger?.warn("db.legacy_memory_fts_drop_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const orphanRepairs = allRows<{ name: string }>(
    db,
    "select name from sqlite_master where type = 'table' and name like '__ade_crr_repair_unified_memories%'",
  );
  for (const orphan of orphanRepairs) {
    try {
      runStatement(db, `drop table if exists ${quoteIdentifier(orphan.name)}`);
    } catch (error) {
      logger?.warn("db.legacy_memory_orphan_drop_failed", {
        table: orphan.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (hasBaseTable) {
    if (rawHasTable(db, "crsql_master") && rawHasColumn(db, "crsql_master", "tbl_name")) {
      runStatement(db, "delete from crsql_master where tbl_name = ?", [baseTable]);
    }
    if (rawHasTable(db, "crsql_changes") && rawHasColumn(db, "crsql_changes", "table")) {
      runStatement(db, "delete from crsql_changes where [table] = ?", [baseTable]);
    }
    try {
      getRow(db, "select crsql_as_table(?) as ok", [baseTable]);
    } catch {
      // The table may not be CRR-registered at runtime (older partial state); the
      // explicit shadow + trigger cleanup below covers that case.
    }
    dropCrrTriggers(db, baseTable, logger);
    runStatement(db, `drop table if exists ${quoteIdentifier(`${baseTable}__crsql_clock`)}`);
    runStatement(db, `drop table if exists ${quoteIdentifier(`${baseTable}__crsql_pks`)}`);
    try {
      runStatement(db, `drop table if exists ${quoteIdentifier(baseTable)}`);
    } catch (error) {
      logger?.warn("db.legacy_memory_base_drop_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logger?.info("db.legacy_unified_memories_cleaned", {
    hadFts: hasFtsParent,
    hadBase: hasBaseTable,
    orphanRepairsDropped: orphanRepairs.length,
  });
}

function tableNeedsCrrTriggerRepair(db: DatabaseSyncType, tableName: string): boolean {
  if (!rawHasTable(db, `${tableName}__crsql_clock`)) {
    return false;
  }
  return listCrrTriggers(db, tableName).length < 3;
}

function disableCrrTriggersForUnavailableRuntime(db: DatabaseSyncType, logger?: Logger): void {
  const triggers = allRows<{ name: string; tbl_name: string }>(
    db,
    `select name, tbl_name
       from sqlite_master
      where type = 'trigger'
        and name like '%__crsql_%trig'`,
  );
  for (const trigger of triggers) {
    try {
      runStatement(db, `drop trigger if exists ${quoteIdentifier(trigger.name)}`);
    } catch (error) {
      logger?.warn("db.crsqlite_trigger_disable_failed", {
        tableName: trigger.tbl_name,
        triggerName: trigger.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (triggers.length > 0) {
    logger?.warn("db.crsqlite_triggers_disabled", { triggerCount: triggers.length });
  }
}

function rebuildCrrTableWithBackfill(db: DatabaseSyncType, tableName: string): void {
  const tableRow = getRow<{ sql: string | null }>(
    db,
    "select sql from sqlite_master where type = 'table' and name = ? limit 1",
    [tableName],
  );
  const createSql = tableRow?.sql?.trim();
  if (!createSql) {
    throw new Error(`Unable to repair CRR table ${tableName}: create SQL missing.`);
  }

  const columns = allRows<{ name: string }>(db, `pragma table_info('${tableName.replace(/'/g, "''")}')`);
  if (columns.length === 0) {
    throw new Error(`Unable to repair CRR table ${tableName}: no columns found.`);
  }

  const stageTable = `__ade_crr_stage_${tableName}`;
  const columnsSql = columns.map((column) => quoteIdentifier(column.name)).join(", ");
  const indexSqls = allRows<{ sql: string | null }>(
    db,
    "select sql from sqlite_master where type = 'index' and tbl_name = ? and sql is not null order by name asc",
    [tableName],
  )
    .map((row) => row.sql?.trim() ?? "")
    .filter((sql) => sql.length > 0);

  runStatement(db, "pragma foreign_keys = off");
  runStatement(db, "begin");
  try {
    runStatement(
      db,
      `create temp table ${quoteIdentifier(stageTable)} as select ${columnsSql} from ${quoteIdentifier(tableName)}`,
    );
    runStatement(db, `drop table ${quoteIdentifier(tableName)}`);
    if (rawHasTable(db, `${tableName}__crsql_clock`)) {
      runStatement(db, `drop table ${quoteIdentifier(`${tableName}__crsql_clock`)}`);
    }
    if (rawHasTable(db, `${tableName}__crsql_pks`)) {
      runStatement(db, `drop table ${quoteIdentifier(`${tableName}__crsql_pks`)}`);
    }
    runStatement(db, createSql);
    for (const indexSql of indexSqls) {
      runStatement(db, indexSql);
    }
    getRow(db, "select crsql_as_crr(?) as ok", [tableName]);
    runStatement(
      db,
      `insert into ${quoteIdentifier(tableName)} (${columnsSql}) select ${columnsSql} from ${quoteIdentifier(stageTable)}`,
    );
    runStatement(db, `drop table ${quoteIdentifier(stageTable)}`);
    runStatement(db, "commit");
  } catch (error) {
    runStatement(db, "rollback");
    throw error;
  } finally {
    runStatement(db, "pragma foreign_keys = on");
  }
}

function ensureCrrTables(db: DatabaseSyncType, logger?: Logger): void {
  removeExcludedCrrMetadata(db, logger);

  const repairTargets = new Set<string>(PHONE_CRITICAL_CRR_TABLES);
  for (const tableName of listEligibleCrrTables(db)) {
    if (rawHasTable(db, `${tableName}__crsql_clock`)) {
      if (tableNeedsCrrTriggerRepair(db, tableName)) {
        getRow(db, "select crsql_as_crr(?) as ok", [tableName]);
      }
      if (!repairTargets.has(tableName)) {
        continue;
      }
    } else {
      getRow(db, "select crsql_as_crr(?) as ok", [tableName]);
    }

    if (!repairTargets.has(tableName)) {
      continue;
    }

    const mismatch = tableNeedsCrrRepair(db, tableName);
    if (!mismatch) {
      continue;
    }

    logger?.warn("db.crr_integrity_mismatch", {
      tableName,
      baseRowCount: mismatch.baseRowCount,
      pkRowCount: mismatch.pkRowCount,
    });
    try {
      rebuildCrrTableWithBackfill(db, tableName);
      const remainingMismatch = tableNeedsCrrRepair(db, tableName);
      if (remainingMismatch) {
        logger?.warn("db.crr_integrity_repair_incomplete", {
          tableName,
          baseRowCount: remainingMismatch.baseRowCount,
          pkRowCount: remainingMismatch.pkRowCount,
        });
      } else {
        logger?.info("db.crr_integrity_repaired", { tableName, rowCount: mismatch.baseRowCount });
      }
    } catch (error) {
      logger?.warn("db.crr_integrity_repair_failed", {
        tableName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function ensureLocalSiteIdFile(dbPath: string): string {
  const siteIdPath = path.join(path.dirname(dbPath), "secrets", "sync-site-id");
  ensureParentDir(siteIdPath);
  if (!fs.existsSync(siteIdPath)) {
    fs.writeFileSync(siteIdPath, randomBytes(16).toString("hex"));
  }
  return fs.readFileSync(siteIdPath, "utf8").trim().toLowerCase();
}

function forceSiteId(db: DatabaseSyncType, siteId: string): void {
  if (!rawHasTable(db, "crsql_site_id")) return;
  runStatement(
    db,
    "insert into crsql_site_id(site_id, ordinal) values (?, 0) on conflict(ordinal) do update set site_id = excluded.site_id",
    [Buffer.from(siteId, "hex")]
  );
}

function readCurrentSiteId(db: DatabaseSyncType): string | null {
  const row = getRow<{ site_id: string }>(db, "select lower(hex(crsql_site_id())) as site_id");
  return row?.site_id ?? null;
}

function encodeSyncScalar(value: unknown): SyncScalar {
  if (value === undefined) {
    return null;
  }
  if (value == null || typeof value === "string" || typeof value === "number") {
    return value;
  }
  if (value instanceof Uint8Array) {
    return {
      type: "bytes",
      base64: Buffer.from(value).toString("base64"),
    };
  }
  throw new Error(`Unsupported sync scalar type: ${typeof value}`);
}

function isSyncScalarBytes(value: SyncScalar): value is { type: "bytes"; base64: string } {
  return Boolean(
    value
    && typeof value === "object"
    && "type" in value
    && value.type === "bytes"
    && typeof value.base64 === "string"
  );
}

function packedCrsqlPrimaryKey(value: SyncScalar): SyncScalar | null {
  if (isSyncScalarBytes(value)) {
    const bytes = Buffer.from(value.base64, "base64");
    return bytes.length >= 2 && bytes[0] > 0 ? value : null;
  }

  if (typeof value === "string") {
    const textBytes = Buffer.from(value, "utf8");
    if (textBytes.length > 0xff) return null;
    return {
      type: "bytes",
      base64: Buffer.concat([Buffer.from([0x01, 0x0b, textBytes.length]), textBytes]).toString("base64"),
    };
  }

  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) return null;
    if (value === 0) return { type: "bytes", base64: Buffer.from([0x01, 0x08]).toString("base64") };
    if (value === 1) return { type: "bytes", base64: Buffer.from([0x01, 0x09]).toString("base64") };
    if (value >= -0x80 && value <= 0x7f) {
      const bytes = Buffer.alloc(3);
      bytes[0] = 0x01;
      bytes[1] = 0x01;
      bytes.writeInt8(value, 2);
      return { type: "bytes", base64: bytes.toString("base64") };
    }
    if (value >= -0x8000 && value <= 0x7fff) {
      const bytes = Buffer.alloc(4);
      bytes[0] = 0x01;
      bytes[1] = 0x02;
      bytes.writeInt16BE(value, 2);
      return { type: "bytes", base64: bytes.toString("base64") };
    }
    if (value >= -0x80000000 && value <= 0x7fffffff) {
      const bytes = Buffer.alloc(6);
      bytes[0] = 0x01;
      bytes[1] = 0x04;
      bytes.writeInt32BE(value, 2);
      return { type: "bytes", base64: bytes.toString("base64") };
    }
    const bytes = Buffer.alloc(10);
    bytes[0] = 0x01;
    bytes[1] = 0x06;
    bytes.writeBigInt64BE(BigInt(value), 2);
    return { type: "bytes", base64: bytes.toString("base64") };
  }

  return null;
}

/** Tables removed locally (#329) that older peers may still export via CRDT. */
const DROPPED_INCOMING_SYNC_TABLES = new Set(["unified_memories"]);

function isIgnoredIncomingSyncTable(db: DatabaseSyncType, table: string): boolean {
  return (
    DROPPED_INCOMING_SYNC_TABLES.has(table) ||
    table.startsWith("unified_memories_") ||
    !rawHasTable(db, table)
  );
}

function normalizeIncomingCrsqlChange(db: DatabaseSyncType, change: CrsqlChangeRow): CrsqlChangeRow {
  const tableInfo = allRows<{ pk: number }>(
    db,
    `pragma table_info('${change.table.replace(/'/g, "''")}')`
  );
  const primaryKeyColumns = tableInfo.filter((column) => Number(column.pk) > 0);
  if (primaryKeyColumns.length !== 1) {
    const shape = primaryKeyColumns.length === 0
      ? "no primary key"
      : `${primaryKeyColumns.length} primary key columns`;
    throw new Error(`Unsupported incoming CRSQL primary key for ${change.table}.${change.cid}: ${shape}.`);
  }

  if (isSyncScalarBytes(change.pk)) {
    const packedPk = packedCrsqlPrimaryKey(change.pk);
    if (packedPk) return change;
    throw new Error(`Unsupported incoming CRSQL primary key for ${change.table}.${change.cid}: invalid packed key.`);
  }

  const packedPk = packedCrsqlPrimaryKey(change.pk);
  if (packedPk) return { ...change, pk: packedPk };

  throw new Error(`Unsupported incoming CRSQL primary key for ${change.table}.${change.cid}: unsupported scalar shape.`);
}

type MigrationDb = {
  run: (sql: string, params?: SqlValue[]) => void;
  get: <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: SqlValue[]) => T | null;
};

function parseAlterTableTarget(sql: string): string | null {
  const match = sql.match(/^\s*alter\s+table\s+([`"'[\]A-Za-z0-9_]+)\s+add\s+column\s+/i);
  if (!match?.[1]) return null;
  return match[1].replace(/^["'`[]|["'`\]]$/g, "");
}

function migrate(db: MigrationDb) {
  // Keep KV for UI layout persistence.
  db.run("create table if not exists kv (key text primary key, value text not null)");

  // Phase 0 + Phase 1 tables.
  db.run(`
    create table if not exists projects (
      id text primary key,
      root_path text not null,
      display_name text not null,
      default_base_ref text not null,
      created_at text not null,
      last_opened_at text not null
    )
  `);

  db.run(`
    create table if not exists lanes (
      id text primary key,
      project_id text not null,
      name text not null,
      description text,
      lane_type text not null default 'worktree',
      base_ref text not null,
      branch_ref text not null,
      worktree_path text not null,
      attached_root_path text,
      is_edit_protected integer not null default 0,
      parent_lane_id text,
      color text,
      icon text,
      tags_json text,
      folder text,
      runtime_placement text not null default 'local',
      status text not null,
      created_at text not null,
      archived_at text,
      foreign key(project_id) references projects(id),
      foreign key(parent_lane_id) references lanes(id)
    )
  `);
  try { db.run("alter table lanes add column runtime_placement text not null default 'local'"); } catch {}
  db.run("create index if not exists idx_lanes_project_id on lanes(project_id)");
  db.run("create index if not exists idx_lanes_project_type on lanes(project_id, lane_type)");
  db.run("create index if not exists idx_lanes_project_parent on lanes(project_id, parent_lane_id)");

  db.run(`
    create table if not exists lane_linear_issues (
      id text primary key,
      project_id text not null,
      lane_id text not null,
      issue_id text not null,
      issue_json text not null,
      created_at text not null,
      updated_at text not null,
      foreign key(project_id) references projects(id) on delete cascade,
      foreign key(lane_id) references lanes(id) on delete cascade
    )
  `);
  db.run("create index if not exists idx_lane_linear_issues_lane on lane_linear_issues(project_id, lane_id)");
  db.run("create index if not exists idx_lane_linear_issues_issue on lane_linear_issues(project_id, issue_id)");
  // Drop a previously-created UNIQUE index on (project_id, lane_id) — it
  // existed briefly in development builds but conflicts with cr-sqlite's
  // `crsql_as_crr` requirement that CRR tables carry no unique indices
  // besides the primary key.
  try {
    db.run("drop index if exists uniq_lane_linear_issues_lane");
  } catch {
    // best-effort cleanup
  }
  // Each lane is linked to at most one Linear issue. CRR-converted tables
  // cannot carry UNIQUE indices besides the primary key (`crsql_as_crr`
  // rejects them with "Table … has unique indices besides the primary key.
  // This is not allowed for CRRs"), so uniqueness on (project_id, lane_id)
  // is enforced at the application layer inside `attachLinearIssue`
  // (delete-then-insert in a transaction). Coalesce duplicates from older
  // dev builds — keep the most recently updated row per (project, lane)
  // and delete the rest. This runs on every bootstrap so the app-layer
  // guarantee has a clean slate even after a multi-writer race produced
  // extras.
  try {
    db.run(`
      delete from lane_linear_issues
      where rowid not in (
        select rowid from lane_linear_issues as keep
        where keep.id = (
          select id from lane_linear_issues inner_p
          where inner_p.project_id = keep.project_id
            and inner_p.lane_id = keep.lane_id
          order by inner_p.updated_at desc,
                   inner_p.id asc
          limit 1
        )
      )
    `);
  } catch {
    // best-effort migration; duplicates will be coalesced on the next
    // upsert via the existing delete-then-insert path.
  }

  db.run(`
    create table if not exists lane_linear_issue_links (
      id text primary key,
      project_id text not null,
      lane_id text not null,
      issue_id text not null,
      issue_json text not null,
      role text not null,
      source text not null,
      include_in_pr integer not null default 1,
      close_on_merge integer not null default 0,
      evidence_json text,
      created_at text not null,
      updated_at text not null,
      foreign key(project_id) references projects(id) on delete cascade,
      foreign key(lane_id) references lanes(id) on delete cascade
    )
  `);
  db.run("create index if not exists idx_lane_linear_issue_links_lane on lane_linear_issue_links(project_id, lane_id)");
  db.run("create index if not exists idx_lane_linear_issue_links_issue on lane_linear_issue_links(project_id, issue_id)");
  db.run("create index if not exists idx_lane_linear_issue_links_role on lane_linear_issue_links(project_id, role)");
  // Drop the legacy UNIQUE index on (project_id, lane_id, issue_id, role).
  // CRR-converted tables cannot carry UNIQUE indices besides the primary key
  // (`crsql_as_crr` rejects them with "Table … has unique indices besides the
  // primary key. This is not allowed for CRRs"). Uniqueness on this tuple is
  // enforced at the application layer (same pattern as `lane_linear_issues`
  // above). Without this drop, every existing user DB with the legacy index
  // bricks on `ensureCrrTables` during the next attach.
  try {
    db.run("drop index if exists uq_lane_linear_issue_links_role");
  } catch {
    // best-effort cleanup
  }
  // Coalesce any duplicates that older dev builds may have produced — keep
  // the most recently updated row per (project_id, lane_id, issue_id, role).
  try {
    db.run(`
      delete from lane_linear_issue_links
      where rowid not in (
        select rowid from lane_linear_issue_links as keep
        where keep.id = (
          select id from lane_linear_issue_links inner_p
          where inner_p.project_id = keep.project_id
            and inner_p.lane_id = keep.lane_id
            and inner_p.issue_id = keep.issue_id
            and inner_p.role = keep.role
          order by inner_p.updated_at desc,
                   inner_p.id asc
          limit 1
        )
      )
    `);
  } catch {
    // best-effort migration; duplicates will be coalesced on the next upsert.
  }

  db.run(`
    create table if not exists lane_branch_profiles (
      id text primary key,
      project_id text not null,
      lane_id text not null,
      branch_ref text not null,
      normalized_branch_ref text not null,
      base_ref text not null,
      parent_lane_id text,
      source_branch_ref text,
      created_at text not null,
      updated_at text not null,
      last_checked_out_at text,
      foreign key(project_id) references projects(id),
      foreign key(lane_id) references lanes(id),
      foreign key(parent_lane_id) references lanes(id)
    )
  `);
  db.run("create index if not exists idx_lane_branch_profiles_lane on lane_branch_profiles(project_id, lane_id)");
  db.run("create index if not exists idx_lane_branch_profiles_project_branch on lane_branch_profiles(project_id, normalized_branch_ref)");
  // NOTE: CRR-converted tables cannot carry UNIQUE indices besides the
  // primary key (`crsql_as_crr` rejects them with "Table … has unique
  // indices besides the primary key. This is not allowed for CRRs"), so
  // uniqueness on (project_id, lane_id, normalized_branch_ref) is enforced
  // at the application layer inside `upsertBranchProfileForRow` (check-then-
  // insert) and via the duplicate sweep below. Coalesce duplicates from
  // older dev builds — keep the most recently updated row per (project,
  // lane, normalized branch) and delete the rest. This runs on every
  // bootstrap so the app-layer check has a clean slate even after a
  // multi-writer race produced extras.
  try {
    db.run(`
      delete from lane_branch_profiles
      where rowid not in (
        select rowid from lane_branch_profiles as keep
        where keep.id = (
          select id from lane_branch_profiles inner_p
          where inner_p.project_id = keep.project_id
            and inner_p.lane_id = keep.lane_id
            and inner_p.normalized_branch_ref = keep.normalized_branch_ref
          order by coalesce(inner_p.last_checked_out_at, inner_p.updated_at) desc,
                   inner_p.updated_at desc,
                   inner_p.id asc
          limit 1
        )
      )
    `);
  } catch {
    // best-effort migration; duplicates will be coalesced on the next
    // upsert via the existing check-then-insert path.
  }

  db.run(`
    create table if not exists lane_state_snapshots (
      lane_id text primary key,
      dirty integer not null default 0,
      ahead integer not null default 0,
      behind integer not null default 0,
      remote_behind integer not null default -1,
      rebase_in_progress integer not null default 0,
      agent_summary_json text,
      updated_at text not null,
      foreign key(lane_id) references lanes(id)
    )
  `);
  db.run("create index if not exists idx_lane_state_snapshots_updated_at on lane_state_snapshots(updated_at)");

  db.run(`
    create table if not exists terminal_sessions (
      id text primary key,
      lane_id text not null,
      pty_id text,
      tracked integer not null default 1,
      goal text,
      tool_type text,
      pinned integer not null default 0,
      manually_named integer not null default 0,
      title text not null,
      started_at text not null,
      ended_at text,
      exit_code integer,
      transcript_path text not null,
      head_sha_start text,
      head_sha_end text,
      status text not null,
      last_output_preview text,
      last_output_at text,
      summary text,
      resume_command text,
      resume_metadata_json text,
      archived_at text,
      chat_session_id text,
      owner_process_started_at text,
      foreign key(lane_id) references lanes(id)
    )
  `);
  db.run("create index if not exists idx_terminal_sessions_lane_id on terminal_sessions(lane_id)");
  db.run("create index if not exists idx_terminal_sessions_status on terminal_sessions(status)");
  db.run("create index if not exists idx_terminal_sessions_started_at on terminal_sessions(started_at desc)");
  db.run("create index if not exists idx_terminal_sessions_lane_started_at on terminal_sessions(lane_id, started_at desc)");

  // Migration: add resume_command to existing databases that pre-date this column.
  try { db.run("alter table terminal_sessions add column resume_command text"); } catch {}
  try { db.run("alter table terminal_sessions add column resume_metadata_json text"); } catch {}
  try { db.run("alter table terminal_sessions add column manually_named integer not null default 0"); } catch {}
  try { db.run("alter table terminal_sessions add column archived_at text"); } catch {}
  try { db.run("alter table terminal_sessions add column chat_session_id text"); } catch {}
  try { db.run("create index if not exists idx_terminal_sessions_chat_session_id on terminal_sessions(chat_session_id)"); } catch {}
  // owner_pid identifies the ADE OS process that owns this row's runtime
  // (the one with the live PTY or SDK session). Cross-process dispose /
  // reconcile must check it before sweeping or every concurrent surface
  // would happily mark each other's live sessions dead. Nullable because
  // pre-migration rows pre-date ownership tracking.
  try { db.run("alter table terminal_sessions add column owner_pid integer"); } catch {}
  try { db.run("create index if not exists idx_terminal_sessions_owner_pid on terminal_sessions(owner_pid)"); } catch {}
  try { db.run("alter table terminal_sessions add column owner_process_started_at text"); } catch {}
  try { db.run("create index if not exists idx_terminal_sessions_owner_process on terminal_sessions(owner_pid, owner_process_started_at)"); } catch {}

  // Process liveness registry. Every ADE process (desktop main, TUI runtime,
  // ade-serve daemon) writes its pid here on boot and refreshes last_seen
  // on a timer. Reconcile / dispose paths use this to tell "row whose owner
  // crashed" from "row a sibling process is actively managing."
  db.run(`
    create table if not exists runtime_processes (
      pid integer primary key,
      role text not null,
      project_root text,
      started_at text not null,
      last_seen text not null
    )
  `);
  db.run("create index if not exists idx_runtime_processes_last_seen on runtime_processes(last_seen)");

  db.run(`
    create table if not exists claude_sessions (
      session_id text primary key,
      lane_id text not null,
      chat_session_id text unique,
      title text,
      tags_json text,
      created_at text not null,
      updated_at text not null,
      foreign key(lane_id) references lanes(id),
      foreign key(chat_session_id) references terminal_sessions(id) on delete set null
    )
  `);
  db.run("create index if not exists idx_claude_sessions_lane_id on claude_sessions(lane_id)");
  db.run("create index if not exists idx_claude_sessions_updated_at on claude_sessions(updated_at desc)");

  // Phase 2 process/test config and history tables.
  db.run(`
    create table if not exists process_definitions (
      id text primary key,
      project_id text not null,
      key text not null,
      name text not null,
      command_json text not null,
      cwd text not null,
      env_json text not null,
      autostart integer not null,
      restart_policy text not null,
      graceful_shutdown_ms integer not null,
      depends_on_json text not null,
      readiness_json text not null,
      updated_at text not null,
      foreign key(project_id) references projects(id)
    )
  `);
  db.run("create index if not exists idx_process_definitions_project_id on process_definitions(project_id)");

  db.run(`
    create table if not exists process_runtime (
      project_id text not null,
      lane_id text not null,
      process_key text not null,
      status text not null,
      pid integer,
      started_at text,
      ended_at text,
      exit_code integer,
      readiness text not null,
      updated_at text not null,
      primary key(project_id, lane_id, process_key),
      foreign key(project_id) references projects(id),
      foreign key(lane_id) references lanes(id)
    )
  `);
  db.run("create index if not exists idx_process_runtime_project_id on process_runtime(project_id)");
  db.run("create index if not exists idx_process_runtime_project_lane on process_runtime(project_id, lane_id)");

  db.run(`
    create table if not exists process_runs (
      id text primary key,
      project_id text not null,
      lane_id text,
      process_key text not null,
      started_at text not null,
      ended_at text,
      exit_code integer,
      termination_reason text not null,
      log_path text not null,
      foreign key(project_id) references projects(id),
      foreign key(lane_id) references lanes(id)
    )
  `);
  db.run("create index if not exists idx_process_runs_project_proc on process_runs(project_id, process_key)");
  db.run("create index if not exists idx_process_runs_project_lane on process_runs(project_id, lane_id)");
  db.run("create index if not exists idx_process_runs_started_at on process_runs(started_at)");

  db.run(`
    create table if not exists stack_buttons (
      id text primary key,
      project_id text not null,
      key text not null,
      name text not null,
      process_keys_json text not null,
      start_order text not null,
      updated_at text not null,
      foreign key(project_id) references projects(id)
    )
  `);
  db.run("create index if not exists idx_stack_buttons_project_id on stack_buttons(project_id)");

  db.run(`
    create table if not exists test_suites (
      id text primary key,
      project_id text not null,
      key text not null,
      name text not null,
      command_json text not null,
      cwd text not null,
      env_json text not null,
      timeout_ms integer,
      tags_json text not null,
      updated_at text not null,
      foreign key(project_id) references projects(id)
    )
  `);
  db.run("create index if not exists idx_test_suites_project_id on test_suites(project_id)");

  db.run(`
    create table if not exists test_runs (
      id text primary key,
      project_id text not null,
      lane_id text,
      suite_key text not null,
      started_at text not null,
      ended_at text,
      status text not null,
      exit_code integer,
      duration_ms integer,
      summary_json text,
      log_path text not null,
      foreign key(project_id) references projects(id)
    )
  `);
  db.run("create index if not exists idx_test_runs_project_suite on test_runs(project_id, suite_key)");
  db.run("create index if not exists idx_test_runs_started_at on test_runs(started_at)");

  // Phase 2.5 + Phase 3 git operations timeline and deterministic packs.
  db.run(`
    create table if not exists operations (
      id text primary key,
      project_id text not null,
      lane_id text,
      kind text not null,
      started_at text not null,
      ended_at text,
      status text not null,
      pre_head_sha text,
      post_head_sha text,
      metadata_json text,
      foreign key(project_id) references projects(id),
      foreign key(lane_id) references lanes(id)
    )
  `);
  db.run("create index if not exists idx_operations_project_started on operations(project_id, started_at)");
  db.run("create index if not exists idx_operations_lane_started on operations(lane_id, started_at)");
  db.run("create index if not exists idx_operations_kind on operations(kind)");

  db.run(`
    create table if not exists packs_index (
      pack_key text primary key,
      project_id text not null,
      lane_id text,
      pack_type text not null,
      pack_path text not null,
      deterministic_updated_at text not null,
      narrative_updated_at text,
      last_head_sha text,
      metadata_json text,
      foreign key(project_id) references projects(id),
      foreign key(lane_id) references lanes(id)
    )
  `);
  db.run("create index if not exists idx_packs_index_project on packs_index(project_id)");
  db.run("create index if not exists idx_packs_index_lane on packs_index(lane_id)");

  db.run(`
    create table if not exists session_deltas (
      session_id text primary key,
      project_id text not null,
      lane_id text not null,
      started_at text not null,
      ended_at text,
      head_sha_start text,
      head_sha_end text,
      files_changed integer not null,
      insertions integer not null,
      deletions integer not null,
      touched_files_json text not null,
      failure_lines_json text not null,
      computed_at text not null,
      foreign key(project_id) references projects(id),
      foreign key(lane_id) references lanes(id),
      foreign key(session_id) references terminal_sessions(id)
    )
  `);
  db.run("create index if not exists idx_session_deltas_lane_started on session_deltas(lane_id, started_at)");
  db.run("create index if not exists idx_session_deltas_project_started on session_deltas(project_id, started_at)");

  // Phase 5 conflict radar predictions.
  db.run(`
    create table if not exists conflict_predictions (
      id text primary key,
      project_id text not null,
      lane_a_id text not null,
      lane_b_id text,
      status text not null,
      conflicting_files_json text,
      overlap_files_json text,
      lane_a_sha text,
      lane_b_sha text,
      predicted_at text not null,
      expires_at text,
      foreign key(project_id) references projects(id),
      foreign key(lane_a_id) references lanes(id),
      foreign key(lane_b_id) references lanes(id)
    )
  `);
  db.run("create index if not exists idx_cp_lane_a on conflict_predictions(lane_a_id)");
  db.run("create index if not exists idx_cp_lane_b on conflict_predictions(lane_b_id)");
  db.run("create index if not exists idx_cp_predicted_at on conflict_predictions(predicted_at)");

  db.run(`
    create table if not exists conflict_proposals (
      id text primary key,
      project_id text not null,
      lane_id text not null,
      peer_lane_id text,
      prediction_id text,
      source text not null,
      confidence real,
      explanation text,
      diff_patch text not null,
      status text not null,
      job_id text,
      artifact_id text,
      applied_operation_id text,
      metadata_json text,
      created_at text not null,
      updated_at text not null,
      foreign key(project_id) references projects(id),
      foreign key(lane_id) references lanes(id),
      foreign key(peer_lane_id) references lanes(id),
      foreign key(prediction_id) references conflict_predictions(id),
      foreign key(applied_operation_id) references operations(id)
    )
  `);
  db.run("create index if not exists idx_conflict_proposals_lane on conflict_proposals(project_id, lane_id)");
  db.run("create index if not exists idx_conflict_proposals_status on conflict_proposals(project_id, status)");

  db.run(`
    create table if not exists ai_usage_log (
      id text primary key,
      timestamp text not null,
      feature text not null,
      provider text not null,
      model text,
      input_tokens integer,
      output_tokens integer,
      duration_ms integer not null,
      success integer not null default 0,
      session_id text
    )
  `);
  db.run("create index if not exists idx_ai_usage_feature_timestamp on ai_usage_log(feature, timestamp)");
  db.run("create index if not exists idx_ai_usage_timestamp on ai_usage_log(timestamp)");

  // Phase 7 GitHub PR tracking (lane -> PR mapping).
  db.run(`
    create table if not exists pull_requests (
      id text primary key,
      project_id text not null,
      lane_id text not null,
      repo_owner text not null,
      repo_name text not null,
      github_pr_number integer not null,
      github_url text not null,
      github_node_id text,
      title text,
      state text not null,
      base_branch text not null,
      head_branch text not null,
      checks_status text,
      review_status text,
      additions integer not null default 0,
      deletions integer not null default 0,
      last_synced_at text,
      created_at text not null,
      updated_at text not null,
      foreign key(project_id) references projects(id),
      foreign key(lane_id) references lanes(id)
    )
  `);
  db.run("create index if not exists idx_pull_requests_lane_id on pull_requests(lane_id)");
  db.run("create index if not exists idx_pull_requests_project_id on pull_requests(project_id)");
  try { db.run("alter table pull_requests add column last_polled_at text"); } catch {}
  try { db.run("alter table pull_requests add column head_sha text"); } catch {}
  try { db.run("alter table pull_requests add column creation_strategy text"); } catch {}

  db.run("drop table if exists github_pr_cache");

  db.run(`
    create table if not exists pr_auto_link_ignores (
      project_id text not null,
      repo_owner text not null,
      repo_name text not null,
      github_pr_number integer not null,
      lane_id text not null,
      head_branch text,
      created_at text not null,
      primary key(project_id, repo_owner, repo_name, github_pr_number, lane_id),
      foreign key(project_id) references projects(id),
      foreign key(lane_id) references lanes(id)
    )
  `);
  db.run("create index if not exists idx_pr_auto_link_ignores_project_repo on pr_auto_link_ignores(project_id, repo_owner, repo_name)");

  // Phase 21: AI PR summary cache (keyed by PR + headSha so pushes invalidate).
  db.run(`
    create table if not exists pull_request_ai_summaries (
      pr_id text not null,
      head_sha text not null,
      summary_json text not null,
      generated_at text not null,
      primary key(pr_id, head_sha),
      foreign key(pr_id) references pull_requests(id)
    )
  `);
  db.run("create index if not exists idx_pr_ai_summaries_pr_id on pull_request_ai_summaries(pr_id)");

  db.run(`
    create table if not exists pull_request_snapshots (
      pr_id text primary key,
      detail_json text,
      status_json text,
      checks_json text,
      reviews_json text,
      comments_json text,
      files_json text,
      updated_at text not null,
      foreign key(pr_id) references pull_requests(id)
    )
  `);
  db.run("create index if not exists idx_pull_request_snapshots_updated_at on pull_request_snapshots(updated_at)");
  try { db.run("alter table pull_request_snapshots add column commits_json text"); } catch {}

  db.run(`
    create table if not exists files_workspaces (
      id text primary key,
      kind text not null,
      lane_id text,
      name text not null,
      root_path text not null,
      is_read_only_by_default integer not null default 1,
      mobile_read_only integer not null default 1,
      updated_at text not null
    )
  `);

  db.run(`
    create table if not exists file_directory_snapshots (
      workspace_id text not null,
      parent_path text not null default '',
      include_hidden integer not null default 0,
      nodes_json text not null,
      updated_at text not null,
      primary key(workspace_id, parent_path, include_hidden),
      foreign key(workspace_id) references files_workspaces(id) on delete cascade
    )
  `);

  db.run(`
    create table if not exists file_content_snapshots (
      workspace_id text not null,
      relative_path text not null,
      blob_json text not null,
      updated_at text not null,
      primary key(workspace_id, relative_path),
      foreign key(workspace_id) references files_workspaces(id) on delete cascade
    )
  `);

  db.run(`
    create table if not exists file_diff_snapshots (
      workspace_id text not null,
      relative_path text not null,
      mode text not null,
      diff_json text not null,
      updated_at text not null,
      primary key(workspace_id, relative_path, mode),
      foreign key(workspace_id) references files_workspaces(id) on delete cascade
    )
  `);

  db.run(`
    create table if not exists file_history_snapshots (
      workspace_id text not null,
      relative_path text not null,
      entries_json text not null,
      updated_at text not null,
      primary key(workspace_id, relative_path),
      foreign key(workspace_id) references files_workspaces(id) on delete cascade
    )
  `);

  db.run("create index if not exists idx_file_directory_snapshots_workspace on file_directory_snapshots(workspace_id, updated_at desc)");
  db.run("create index if not exists idx_file_content_snapshots_workspace on file_content_snapshots(workspace_id, updated_at desc)");
  db.run("create index if not exists idx_file_diff_snapshots_workspace on file_diff_snapshots(workspace_id, updated_at desc)");
  db.run("create index if not exists idx_file_history_snapshots_workspace on file_history_snapshots(workspace_id, updated_at desc)");

  // Phase 8 pack versioning + checkpoints.
  db.run(`
    create table if not exists checkpoints (
      id text primary key,
      project_id text not null,
      lane_id text not null,
      session_id text,
      sha text not null,
      diff_stat_json text,
      pack_event_ids_json text,
      created_at text not null,
      foreign key(project_id) references projects(id),
      foreign key(lane_id) references lanes(id),
      foreign key(session_id) references terminal_sessions(id)
    )
  `);
  db.run("create index if not exists idx_checkpoints_project_created on checkpoints(project_id, created_at)");
  db.run("create index if not exists idx_checkpoints_lane_created on checkpoints(lane_id, created_at)");

  db.run(`
    create table if not exists pack_events (
      id text primary key,
      project_id text not null,
      pack_key text not null,
      event_type text not null,
      payload_json text,
      created_at text not null,
      foreign key(project_id) references projects(id)
    )
  `);
  db.run("create index if not exists idx_pack_events_project_created on pack_events(project_id, created_at)");
  db.run("create index if not exists idx_pack_events_pack_key_created on pack_events(project_id, pack_key, created_at)");

  db.run(`
    create table if not exists pack_versions (
      id text primary key,
      project_id text not null,
      pack_key text not null,
      version_number integer not null,
      content_hash text not null,
      rendered_path text not null,
      created_at text not null,
      foreign key(project_id) references projects(id)
    )
  `);
  db.run("create index if not exists idx_pack_versions_project_pack on pack_versions(project_id, pack_key)");
  db.run(
    "create index if not exists idx_pack_versions_project_pack_version on pack_versions(project_id, pack_key, version_number)"
  );

  db.run(`
    create table if not exists pack_heads (
      project_id text not null,
      pack_key text not null,
      current_version_id text not null,
      updated_at text not null,
      primary key(project_id, pack_key),
      foreign key(project_id) references projects(id)
    )
  `);
  db.run("create index if not exists idx_pack_heads_project on pack_heads(project_id)");

  // Phase 8 automations run logs.
  db.run(`
    create table if not exists automation_runs (
      id text primary key,
      project_id text not null,
      automation_id text not null,
      trigger_type text not null,
      started_at text not null,
      ended_at text,
      status text not null,
      actions_completed integer not null default 0,
      actions_total integer not null,
      error_message text,
      trigger_metadata text,
      foreign key(project_id) references projects(id)
    )
  `);
  db.run("create index if not exists idx_automation_runs_project_started on automation_runs(project_id, started_at)");
  db.run("create index if not exists idx_automation_runs_project_automation on automation_runs(project_id, automation_id)");

  db.run(`
    create table if not exists automation_action_results (
      id text primary key,
      project_id text not null,
      run_id text not null,
      action_index integer not null,
      action_type text not null,
      started_at text not null,
      ended_at text,
      status text not null,
      error_message text,
      output text,
      foreign key(project_id) references projects(id),
      foreign key(run_id) references automation_runs(id)
    )
  `);
  db.run("create index if not exists idx_automation_action_results_project_run on automation_action_results(project_id, run_id)");

  // Phase 8+ PR groups (queue / integration).
  db.run(`
    create table if not exists pr_groups (
      id text primary key,
      project_id text not null,
      group_type text not null,
      name text,
      auto_rebase integer not null default 0,
      ci_gating integer not null default 0,
      target_branch text,
      created_at text not null,
      foreign key(project_id) references projects(id)
    )
  `);
  db.run("create index if not exists idx_pr_groups_project on pr_groups(project_id)");

  db.run(`
    create table if not exists pr_group_members (
      id text primary key,
      group_id text not null,
      pr_id text not null,
      lane_id text not null,
      position integer not null,
      role text not null,
      foreign key(group_id) references pr_groups(id),
      foreign key(pr_id) references pull_requests(id),
      foreign key(lane_id) references lanes(id)
    )
  `);
  db.run("create index if not exists idx_pr_group_members_group on pr_group_members(group_id)");
  db.run("create index if not exists idx_pr_group_members_pr on pr_group_members(pr_id)");

  // Integration proposals table (dry-merge simulation results)
  db.run(`
    create table if not exists integration_proposals (
      id text primary key,
      project_id text not null,
      source_lane_ids_json text not null,
      base_branch text not null,
      steps_json text not null,
      title text default '',
      body text default '',
      draft integer not null default 0,
      integration_lane_name text default '',
      status text not null default 'proposed',
      integration_lane_id text,
      resolution_state_json text,
      pairwise_results_json text not null default '[]',
      lane_summaries_json text not null default '[]',
      overall_outcome text not null,
      created_at text not null,
      foreign key(project_id) references projects(id)
    )
  `);
  db.run("create index if not exists idx_integration_proposals_project on integration_proposals(project_id)");
  try { db.run("alter table integration_proposals add column linked_group_id text"); } catch {}
  try { db.run("alter table integration_proposals add column linked_pr_id text"); } catch {}
  try { db.run("alter table integration_proposals add column workflow_display_state text not null default 'active'"); } catch {}
  try { db.run("alter table integration_proposals add column cleanup_state text not null default 'none'"); } catch {}
  try { db.run("alter table integration_proposals add column closed_at text"); } catch {}
  try { db.run("alter table integration_proposals add column merged_at text"); } catch {}
  try { db.run("alter table integration_proposals add column completed_at text"); } catch {}
  try { db.run("alter table integration_proposals add column cleanup_declined_at text"); } catch {}
  try { db.run("alter table integration_proposals add column cleanup_completed_at text"); } catch {}
  try { db.run("alter table integration_proposals add column preferred_integration_lane_id text"); } catch {}
  try { db.run("alter table integration_proposals add column merge_into_head_sha text"); } catch {}

  // Queue landing state table (crash recovery for sequential landing)
  db.run(`
    create table if not exists queue_landing_state (
      id text primary key,
      group_id text not null,
      project_id text not null,
      state text not null,
      entries_json text not null,
      config_json text not null default '{}',
      current_position integer not null default 0,
      active_pr_id text,
      active_resolver_run_id text,
      last_error text,
      wait_reason text,
      started_at text not null,
      completed_at text,
      updated_at text,
      foreign key(group_id) references pr_groups(id),
      foreign key(project_id) references projects(id)
    )
  `);
  db.run("create index if not exists idx_queue_landing_state_group on queue_landing_state(group_id)");
  try { db.run("alter table queue_landing_state add column config_json text not null default '{}'"); } catch {}
  try { db.run("alter table queue_landing_state add column active_pr_id text"); } catch {}
  try { db.run("alter table queue_landing_state add column active_resolver_run_id text"); } catch {}
  try { db.run("alter table queue_landing_state add column last_error text"); } catch {}
  try { db.run("alter table queue_landing_state add column wait_reason text"); } catch {}
  try { db.run("alter table queue_landing_state add column updated_at text"); } catch {}

  // One-shot wipe of legacy queue_landing_state on upgrade to the stacked-PR
  // queue overhaul. The new queue creates PRs with chain bases (PR_N's base =
  // previous lane's branch) instead of all-into-main, so any in-flight queue
  // from the old code path would be misinterpreted by the new landing loop.
  // Wiping rather than migrating is a deliberate choice — the user accepts
  // losing in-flight queues in exchange for not maintaining a translation
  // layer for every legacy field shape.
  const QUEUE_OVERHAUL_WIPE_MARKER = "queue_landing_state.wiped_for_stacked_overhaul.v1";
  try {
    const row = db.get<{ value: string }>(
      "select value from kv where key = ?",
      [QUEUE_OVERHAUL_WIPE_MARKER],
    );
    if (!row) {
      db.run("delete from queue_landing_state");
      db.run(
        "insert into kv (key, value) values (?, ?) on conflict(key) do update set value = excluded.value",
        [QUEUE_OVERHAUL_WIPE_MARKER, new Date().toISOString()],
      );
    }
  } catch {
    // Table may not exist on a brand-new DB; initialization will create both
    // tables and the next startup will record the marker. Skipping the wipe
    // on a fresh DB is correct (nothing to wipe).
  }

  // Rebase dismiss/defer persistence
  db.run(`
    create table if not exists rebase_dismissed (
      lane_id text not null,
      project_id text not null,
      dismissed_at text not null,
      primary key(lane_id, project_id),
      foreign key(project_id) references projects(id)
    )
  `);
  db.run("create index if not exists idx_rebase_dismissed_project on rebase_dismissed(project_id)");
  db.run(`
    create table if not exists rebase_deferred (
      lane_id text not null,
      project_id text not null,
      deferred_until text not null,
      primary key(lane_id, project_id),
      foreign key(project_id) references projects(id)
    )
  `);
  db.run("create index if not exists idx_rebase_deferred_project on rebase_deferred(project_id)");


  db.run(`
    create table if not exists computer_use_artifacts (
      id text primary key,
      project_id text not null,
      artifact_kind text not null,
      backend_style text not null,
      backend_name text not null,
      source_tool_name text,
      original_type text,
      title text not null,
      description text,
      uri text not null,
      storage_kind text not null,
      mime_type text,
      metadata_json text not null default '{}',
      created_at text not null,
      foreign key(project_id) references projects(id)
    )
  `);
  db.run("create index if not exists idx_computer_use_artifacts_project_created on computer_use_artifacts(project_id, created_at)");
  db.run("create index if not exists idx_computer_use_artifacts_project_kind on computer_use_artifacts(project_id, artifact_kind)");

  db.run(`
    create table if not exists computer_use_artifact_links (
      id text primary key,
      artifact_id text not null,
      project_id text not null,
      owner_kind text not null,
      owner_id text not null,
      relation text not null default 'attached_to',
      metadata_json text,
      created_at text not null,
      foreign key(artifact_id) references computer_use_artifacts(id),
      foreign key(project_id) references projects(id)
    )
  `);
  db.run("create index if not exists idx_computer_use_artifact_links_owner on computer_use_artifact_links(project_id, owner_kind, owner_id, created_at)");
  db.run("create index if not exists idx_computer_use_artifact_links_artifact on computer_use_artifact_links(artifact_id)");


  // CTO persistent identity/core-continuity/session-log state.
  db.run(`
    create table if not exists cto_identity_state (
      project_id text primary key,
      version integer not null,
      payload_json text not null,
      updated_at text not null
    )
  `);
  db.run("create index if not exists idx_cto_identity_state_updated on cto_identity_state(updated_at)");

  db.run(`
    create table if not exists cto_session_logs (
      id text primary key,
      project_id text not null,
      session_id text not null,
      summary text not null,
      started_at text not null,
      ended_at text,
      provider text not null,
      model_id text,
      capability_mode text not null,
      created_at text not null
    )
  `);
  db.run("create index if not exists idx_cto_session_logs_project_created on cto_session_logs(project_id, created_at)");
  db.run("create index if not exists idx_cto_session_logs_session on cto_session_logs(project_id, session_id)");

  // WS7 Agent identities table (schema placeholder for future).
  db.run(`
    create table if not exists agent_identities (
      id text primary key,
      project_id text not null,
      name text not null,
      profile_json text not null default '{}',
      persona_json text not null default '{}',
      tool_policy_json text not null default '{}',
      user_preferences_json text not null default '{}',
      heartbeat_json text,
      model_preference text,
      created_at text not null,
      updated_at text not null
    )
  `);
  db.run("create index if not exists idx_agent_identities_project on agent_identities(project_id)");

  // Context compaction engine — transcript persistence for SDK agent sessions.
  db.run(`
    create table if not exists attempt_transcripts (
      id text primary key,
      project_id text not null,
      attempt_id text not null,
      run_id text not null,
      step_id text not null,
      messages_json text not null,
      token_count integer default 0,
      compacted_at text,
      compaction_summary text,
      created_at text not null,
      updated_at text not null
    )
  `);
  db.run("create index if not exists idx_attempt_transcripts_attempt on attempt_transcripts(attempt_id)");
  db.run("create index if not exists idx_attempt_transcripts_run on attempt_transcripts(run_id)");

  // Phase 6 W3: Multi-device desktop registry and brain authority state.
  db.run(`
    create table if not exists devices (
      device_id text primary key,
      site_id text not null,
      name text not null,
      platform text not null,
      device_type text not null,
      created_at text not null,
      updated_at text not null,
      last_seen_at text,
      last_host text,
      last_port integer,
      tailscale_ip text,
      ip_addresses_json text not null default '[]',
      metadata_json text not null default '{}'
    )
  `);
  db.run("create index if not exists idx_devices_site_id on devices(site_id)");
  db.run("create index if not exists idx_devices_last_seen_at on devices(last_seen_at)");

  db.run(`
    create table if not exists sync_cluster_state (
      cluster_id text primary key,
      brain_device_id text not null,
      brain_epoch integer not null default 1,
      updated_at text not null,
      updated_by_device_id text not null
    )
  `);

  // Phase 4 W2: Worker agents org chart
  db.run(`
    create table if not exists worker_agents (
      id text primary key,
      project_id text not null,
      slug text not null,
      name text not null,
      role text not null default 'generalist',
      title text,
      reports_to text,
      capabilities_json text not null default '[]',
      status text not null default 'idle',
      adapter_type text not null default 'claude-local',
      adapter_config_json text not null default '{}',
      runtime_config_json text not null default '{}',
      linear_identity_json text not null default '{}',
      budget_monthly_cents integer not null default 0,
      spent_monthly_cents integer not null default 0,
      last_heartbeat_at text,
      created_at text not null,
      updated_at text not null,
      deleted_at text
    )
  `);
  try { db.run("alter table worker_agents add column linear_identity_json text not null default '{}'"); } catch {}
  db.run("create index if not exists idx_worker_agents_project on worker_agents(project_id)");
  db.run("create index if not exists idx_worker_agents_project_active on worker_agents(project_id, deleted_at)");

  db.run(`
    create table if not exists linear_ingress_state (
      project_id text primary key,
      local_webhook_json text not null default '{}',
      relay_json text not null default '{}',
      reconciliation_json text not null default '{}',
      updated_at text not null
    )
  `);

  db.run(`
    create table if not exists linear_ingress_events (
      id text primary key,
      project_id text not null,
      source text not null,
      delivery_id text not null,
      event_id text not null,
      entity_type text not null,
      action text,
      issue_id text,
      issue_identifier text,
      summary text not null,
      payload_json text,
      created_at text not null
    )
  `);
  db.run("create index if not exists idx_linear_ingress_events_project_created on linear_ingress_events(project_id, created_at desc)");
  db.run("create index if not exists idx_linear_ingress_events_project_event on linear_ingress_events(project_id, event_id)");

  // Phase 4 W2: Worker agent config revisions (audit trail)
  db.run(`
    create table if not exists worker_agent_revisions (
      id text primary key,
      project_id text not null,
      agent_id text not null,
      before_json text not null,
      after_json text not null,
      changed_keys_json text not null default '[]',
      had_redactions integer not null default 0,
      actor text not null default 'user',
      created_at text not null
    )
  `);
  db.run("create index if not exists idx_worker_agent_revisions_agent on worker_agent_revisions(project_id, agent_id)");

  // Phase 4 W2: Worker agent task sessions (persistent per-agent task context)
  db.run(`
    create table if not exists worker_agent_task_sessions (
      id text primary key,
      project_id text not null,
      agent_id text not null,
      adapter_type text not null,
      task_key text not null,
      payload_json text not null default '{}',
      cleared_at text,
      created_at text not null,
      updated_at text not null
    )
  `);
  db.run("create index if not exists idx_worker_agent_task_sessions_lookup on worker_agent_task_sessions(project_id, agent_id, adapter_type, task_key)");

  // Phase 4 W3: Worker agent heartbeat runs
  db.run(`
    create table if not exists worker_agent_runs (
      id text primary key,
      project_id text not null,
      agent_id text not null,
      status text not null default 'pending',
      wakeup_reason text not null default 'timer',
      task_key text,
      issue_key text,
      execution_run_id text,
      execution_locked_at text,
      context_json text not null default '{}',
      result_json text,
      error_message text,
      started_at text,
      finished_at text,
      created_at text not null,
      updated_at text not null
    )
  `);
  db.run("create index if not exists idx_worker_agent_runs_agent on worker_agent_runs(project_id, agent_id)");
  db.run("create index if not exists idx_worker_agent_runs_status on worker_agent_runs(project_id, status)");

  // Phase 4 W2: Worker agent cost events (budget tracking)
  db.run(`
    create table if not exists worker_agent_cost_events (
      id text primary key,
      project_id text not null,
      agent_id text not null,
      run_id text,
      session_id text,
      provider text not null,
      model_id text,
      input_tokens integer,
      output_tokens integer,
      cost_cents integer not null default 0,
      estimated integer not null default 0,
      source text not null default 'manual',
      occurred_at text not null,
      created_at text not null
    )
  `);
  db.run("create index if not exists idx_worker_agent_cost_events_agent on worker_agent_cost_events(project_id, agent_id)");
  db.run("create index if not exists idx_worker_agent_cost_events_month on worker_agent_cost_events(project_id, agent_id, occurred_at)");

  // Phase 4 W4: Linear sync loop state (heartbeat + health)
  db.run(`
    create table if not exists linear_sync_state (
      project_id text primary key,
      enabled integer not null default 0,
      running integer not null default 0,
      last_poll_at text,
      last_success_at text,
      last_error text,
      health_json text not null default '{}',
      updated_at text not null
    )
  `);
  db.run("create index if not exists idx_linear_sync_state_updated on linear_sync_state(updated_at)");

  // Phase 4 W4: Latest normalized Linear issue snapshots for de-dup/reconciliation.
  db.run(`
    create table if not exists linear_issue_snapshots (
      id text primary key,
      project_id text not null,
      issue_id text not null,
      identifier text not null,
      state_type text not null,
      assignee_id text,
      updated_at_linear text not null,
      payload_json text not null,
      hash text not null,
      created_at text not null,
      updated_at text not null
    )
  `);
  db.run("create index if not exists idx_linear_issue_snapshots_project_updated_linear on linear_issue_snapshots(project_id, updated_at_linear)");

  // Phase 4 W4: Queue for dispatch/escalation/retry.
  db.run(`
    create table if not exists linear_dispatch_queue (
      id text primary key,
      project_id text not null,
      issue_id text not null,
      identifier text not null,
      title text not null,
      status text not null,
      action text not null,
      worker_id text,
      worker_slug text,
      route_json text not null default '{}',
      attempt_count integer not null default 0,
      next_attempt_at text,
      last_error text,
      note text,
      created_at text not null,
      updated_at text not null
    )
  `);
  db.run(
    "create index if not exists idx_linear_dispatch_queue_lookup on linear_dispatch_queue(project_id, status, next_attempt_at, created_at)"
  );
  db.run("create index if not exists idx_linear_dispatch_queue_issue on linear_dispatch_queue(project_id, issue_id, status)");

  // Phase 4 W4: Atomic issue claim lock for dispatch.
  db.run(`
    create table if not exists linear_issue_claims (
      id text primary key,
      project_id text not null,
      issue_id text not null,
      queue_item_id text,
      worker_id text,
      worker_slug text,
      linear_assignee_id text,
      status text not null default 'active',
      claimed_at text not null,
      released_at text,
      updated_at text not null
    )
  `);
  db.run("drop index if exists idx_linear_issue_claims_unique");
  db.run(
    "create index if not exists idx_linear_issue_claims_active_unique on linear_issue_claims(project_id, issue_id) where status = 'active'"
  );
  db.run("create index if not exists idx_linear_issue_claims_lookup on linear_issue_claims(project_id, issue_id, status)");

  // Phase 4 W4: Persistent issue workpad mapping (single comment per issue).
  db.run(`
    create table if not exists linear_workpads (
      id text primary key,
      project_id text not null,
      issue_id text not null,
      comment_id text not null,
      last_body_hash text,
      last_body text,
      created_at text not null,
      updated_at text not null
    )
  `);
  db.run("create index if not exists idx_linear_workpads_project_issue on linear_workpads(project_id, issue_id)");

  // Phase 4 W4: Sync event/audit log.
  db.run(`
    create table if not exists linear_sync_events (
      id text primary key,
      project_id text not null,
      issue_id text,
      queue_item_id text,
      event_type text not null,
      status text,
      message text,
      payload_json text,
      created_at text not null
    )
  `);
  db.run("create index if not exists idx_linear_sync_events_project_created on linear_sync_events(project_id, created_at)");
  db.run("create index if not exists idx_linear_sync_events_issue_created on linear_sync_events(project_id, issue_id, created_at)");

  db.run(`
    create table if not exists linear_workflow_runs (
      id text primary key,
      project_id text not null,
      issue_id text not null,
      identifier text not null,
      title text not null,
      workflow_id text not null,
      workflow_name text not null,
      workflow_version text not null,
      source text not null default 'repo',
      target_type text not null,
      status text not null,
      current_step_index integer not null default 0,
      current_step_id text,
      execution_lane_id text,
      linked_session_id text,
      linked_worker_run_id text,
      linked_pr_id text,
      review_state text,
      supervisor_identity_key text,
      review_ready_reason text,
      pr_state text,
      pr_checks_status text,
      pr_review_status text,
      latest_review_note text,
      retry_count integer not null default 0,
      retry_after text,
      closeout_state text not null default 'pending',
      terminal_outcome text,
      last_error text,
      route_context_json text,
      execution_context_json text,
      source_issue_snapshot_json text not null default '{}',
      created_at text not null,
      updated_at text not null
    )
  `);
  try { db.run("alter table linear_workflow_runs add column execution_lane_id text"); } catch {}
  try { db.run("alter table linear_workflow_runs add column supervisor_identity_key text"); } catch {}
  try { db.run("alter table linear_workflow_runs add column review_ready_reason text"); } catch {}
  try { db.run("alter table linear_workflow_runs add column pr_state text"); } catch {}
  try { db.run("alter table linear_workflow_runs add column pr_checks_status text"); } catch {}
  try { db.run("alter table linear_workflow_runs add column pr_review_status text"); } catch {}
  try { db.run("alter table linear_workflow_runs add column latest_review_note text"); } catch {}
  try { db.run("alter table linear_workflow_runs add column route_context_json text"); } catch {}
  try { db.run("alter table linear_workflow_runs add column execution_context_json text"); } catch {}
  db.run("create index if not exists idx_linear_workflow_runs_project_status on linear_workflow_runs(project_id, status, updated_at)");
  db.run("create index if not exists idx_linear_workflow_runs_issue on linear_workflow_runs(project_id, issue_id, updated_at)");

  db.run(`
    create table if not exists linear_workflow_run_steps (
      id text primary key,
      project_id text not null,
      run_id text not null,
      workflow_step_id text not null,
      type text not null,
      status text not null,
      started_at text,
      completed_at text,
      payload_json text,
      created_at text not null,
      updated_at text not null
    )
  `);
  db.run("create index if not exists idx_linear_workflow_run_steps_run on linear_workflow_run_steps(project_id, run_id, created_at)");

  db.run(`
    create table if not exists linear_workflow_run_events (
      id text primary key,
      project_id text not null,
      run_id text not null,
      event_type text not null,
      status text,
      message text,
      payload_json text,
      created_at text not null
    )
  `);
  db.run("create index if not exists idx_linear_workflow_run_events_run on linear_workflow_run_events(project_id, run_id, created_at)");

  // Phase 4 W4: Active flow policy snapshot and immutable revision history.
  db.run(`
    create table if not exists cto_flow_policies (
      project_id text primary key,
      policy_json text not null,
      active_revision_id text,
      updated_at text not null,
      updated_by text not null
    )
  `);
  db.run("create index if not exists idx_cto_flow_policies_updated on cto_flow_policies(updated_at)");

  db.run(`
    create table if not exists cto_flow_policy_revisions (
      id text primary key,
      project_id text not null,
      actor text not null,
      policy_json text not null,
      diff_json text,
      created_at text not null
    )
  `);
  db.run("create index if not exists idx_cto_flow_policy_revisions_project_created on cto_flow_policy_revisions(project_id, created_at)");

  // W5 automation budget cap: cumulative usage tracking per scope per week.
  db.run(`
    create table if not exists budget_usage_records (
      id text primary key,
      scope text not null,
      scope_id text not null,
      provider text not null,
      tokens_used integer not null default 0,
      cost_usd real not null default 0,
      week_key text not null,
      recorded_at text not null
    )
  `);
  db.run("create index if not exists idx_budget_usage_records_scope_week on budget_usage_records(scope, scope_id, week_key)");
  db.run("create index if not exists idx_budget_usage_records_week on budget_usage_records(week_key)");
  db.run("create index if not exists idx_budget_usage_records_provider_week on budget_usage_records(provider, week_key)");

  // Local review history for Review tab runs.
  db.run(`
    create table if not exists review_runs (
      id text primary key,
      project_id text not null,
      lane_id text not null,
      target_json text not null,
      config_json text not null,
      target_label text not null,
      compare_target_json text,
      status text not null,
      summary text,
      error_message text,
      finding_count integer not null default 0,
      severity_summary_json text,
      chat_session_id text,
      created_at text not null,
      started_at text not null,
      ended_at text,
      updated_at text not null,
      foreign key(project_id) references projects(id),
      foreign key(lane_id) references lanes(id)
    )
  `);
  db.run("create index if not exists idx_review_runs_project_created on review_runs(project_id, created_at desc)");
  db.run("create index if not exists idx_review_runs_lane_created on review_runs(lane_id, created_at desc)");
  db.run("create index if not exists idx_review_runs_project_status on review_runs(project_id, status)");

  db.run(`
    create table if not exists review_findings (
      id text primary key,
      run_id text not null,
      title text not null,
      severity text not null,
      finding_class text,
      body text not null,
      confidence real not null default 0.5,
      evidence_json text,
      file_path text,
      line integer,
      anchor_state text not null,
      source_pass text not null,
      publication_state text not null,
      originating_passes_json text,
      adjudication_json text,
      foreign key(run_id) references review_runs(id) on delete cascade
    )
  `);
  db.run("create index if not exists idx_review_findings_run on review_findings(run_id)");
  db.run("create index if not exists idx_review_findings_run_file on review_findings(run_id, file_path, line)");

  db.run(`
    create table if not exists review_run_publications (
      id text primary key,
      run_id text not null,
      destination_json text not null,
      review_event text not null,
      status text not null,
      review_url text,
      remote_review_id text,
      summary_body text not null,
      inline_comments_json text not null default '[]',
      summary_finding_ids_json text not null default '[]',
      error_message text,
      created_at text not null,
      updated_at text not null,
      completed_at text,
      foreign key(run_id) references review_runs(id) on delete cascade
    )
  `);
  db.run("create index if not exists idx_review_run_publications_run on review_run_publications(run_id, created_at)");

  db.run(`
    create table if not exists review_run_artifacts (
      id text primary key,
      run_id text not null,
      artifact_type text not null,
      title text not null,
      mime_type text not null,
      content_text text,
      metadata_json text,
      created_at text not null,
      foreign key(run_id) references review_runs(id) on delete cascade
    )
  `);
  db.run("create index if not exists idx_review_run_artifacts_run on review_run_artifacts(run_id, created_at)");

  db.run(`
    create table if not exists review_reviewer_runs (
      id text primary key,
      run_id text not null,
      reviewer_key text not null,
      label text not null,
      focus text not null,
      status text not null,
      chat_session_id text,
      prompt_artifact_id text,
      output_artifact_id text,
      findings_artifact_id text,
      candidate_count integer not null default 0,
      kept_count integer not null default 0,
      summary text,
      error_message text,
      started_at text,
      ended_at text,
      created_at text not null,
      updated_at text not null,
      foreign key(run_id) references review_runs(id) on delete cascade
    )
  `);
  db.run("create index if not exists idx_review_reviewer_runs_run on review_reviewer_runs(run_id, created_at)");
  db.run("create index if not exists idx_review_reviewer_runs_run_key on review_reviewer_runs(run_id, reviewer_key)");

  db.run(`
    create table if not exists review_candidate_findings (
      id text primary key,
      run_id text not null,
      reviewer_run_id text not null,
      reviewer_key text not null,
      title text not null,
      severity text not null,
      finding_class text,
      body text not null,
      confidence real not null default 0.5,
      evidence_json text,
      file_path text,
      line integer,
      anchor_state text not null,
      evidence_score real not null default 0,
      low_signal integer not null default 0,
      score real not null default 0,
      created_at text not null,
      foreign key(run_id) references review_runs(id) on delete cascade,
      foreign key(reviewer_run_id) references review_reviewer_runs(id) on delete cascade
    )
  `);
  db.run("create index if not exists idx_review_candidate_findings_run on review_candidate_findings(run_id)");
  db.run("create index if not exists idx_review_candidate_findings_reviewer on review_candidate_findings(reviewer_run_id)");
  try { db.run("alter table review_findings add column finding_class text"); } catch {}
  try { db.run("alter table review_findings add column originating_passes_json text"); } catch {}
  try { db.run("alter table review_findings add column adjudication_json text"); } catch {}
  try { db.run("alter table review_findings add column diff_context_json text"); } catch {}
  try { db.run("alter table review_findings add column suppression_match_json text"); } catch {}

  // Per-finding feedback — powers the learning loop.
  db.run(`
    create table if not exists review_finding_feedback (
      id text primary key,
      finding_id text not null,
      run_id text not null,
      project_id text not null,
      kind text not null,
      reason text,
      note text,
      snooze_until text,
      created_at text not null,
      foreign key(finding_id) references review_findings(id) on delete cascade
    )
  `);
  db.run("create index if not exists idx_review_feedback_finding on review_finding_feedback(finding_id)");
  db.run("create index if not exists idx_review_feedback_project_created on review_finding_feedback(project_id, created_at desc)");

  // Durable suppressions — Greptile-style learned filter.
  db.run(`
    create table if not exists review_suppressions (
      id text primary key,
      project_id text not null,
      scope text not null,
      repo_key text,
      path_pattern text,
      title text not null,
      title_norm text not null,
      finding_class text,
      severity text,
      reason text,
      note text,
      source_finding_id text,
      hit_count integer not null default 0,
      created_at text not null,
      last_matched_at text
    )
  `);
  db.run("create index if not exists idx_review_suppressions_project on review_suppressions(project_id, created_at desc)");
  db.run("create index if not exists idx_review_suppressions_repo on review_suppressions(project_id, repo_key)");

  // PR convergence loop: issue inventory tracking
  db.run(`
    create table if not exists pr_issue_inventory (
      id text primary key,
      pr_id text not null,
      source text not null,
      type text not null,
      external_id text not null,
      state text not null default 'new',
      round integer not null default 0,
      file_path text,
      line integer,
      severity text,
      headline text not null,
      body text,
      author text,
      url text,
      dismiss_reason text,
      agent_session_id text,
      created_at text not null,
      updated_at text not null,
      unique(pr_id, external_id),
      foreign key(pr_id) references pull_requests(id) on delete cascade
    )
  `);
  try { db.run("alter table pr_issue_inventory add column thread_comment_count integer"); } catch {}
  try { db.run("alter table pr_issue_inventory add column thread_latest_comment_id text"); } catch {}
  try { db.run("alter table pr_issue_inventory add column thread_latest_comment_author text"); } catch {}
  try { db.run("alter table pr_issue_inventory add column thread_latest_comment_at text"); } catch {}
  try { db.run("alter table pr_issue_inventory add column thread_latest_comment_source text"); } catch {}
  db.run("create index if not exists idx_inventory_pr_state on pr_issue_inventory(pr_id, state)");

  // PR pipeline settings: per-PR auto-converge / auto-merge configuration.
  // Newer fields (conflict_strategy, force_finalize_*, early_merge_on_green,
  // auto_agent_*) are added via try-catch ALTER below so existing DBs upgrade
  // in place. The legacy `on_rebase_needed` column is retained for back-compat.
  db.run(`
    create table if not exists pr_pipeline_settings (
      pr_id text primary key,
      auto_merge integer not null default 1,
      merge_method text not null default 'repo_default',
      max_rounds integer not null default 5,
      on_rebase_needed text not null default 'pause',
      updated_at text not null,
      foreign key(pr_id) references pull_requests(id) on delete cascade
    )
  `);
  try { db.run("alter table pr_pipeline_settings add column conflict_strategy text not null default 'pause'"); } catch {}
  try { db.run("alter table pr_pipeline_settings add column force_finalize_mode text not null default 'conditional'"); } catch {}
  try { db.run("alter table pr_pipeline_settings add column force_finalize_require_no_ci_failures integer not null default 1"); } catch {}
  try { db.run("alter table pr_pipeline_settings add column early_merge_on_green integer not null default 1"); } catch {}
  try { db.run("alter table pr_pipeline_settings add column auto_agent_provider text"); } catch {}
  try { db.run("alter table pr_pipeline_settings add column auto_agent_model text"); } catch {}
  try { db.run("alter table pr_pipeline_settings add column auto_agent_reasoning_effort text"); } catch {}
  try { db.run("alter table pr_pipeline_settings add column auto_agent_permission_mode text"); } catch {}
  try { db.run("alter table pr_pipeline_settings add column auto_agent_confidence_threshold real"); } catch {}
  try { db.run("alter table pr_pipeline_settings add column at_cap_policy text default 'ci_retry_once'"); } catch {}
  try { db.run("alter table pr_pipeline_settings add column at_cap_wait_minutes integer"); } catch {}
  try { db.run("alter table pr_pipeline_settings add column at_cap_ci_retry_max integer"); } catch {}
  try { db.run("alter table pr_pipeline_settings add column force_merge_requires_confirmation integer"); } catch {}
  try { db.run("alter table pr_pipeline_settings add column ptm_defaults_backfilled_version text"); } catch {}
  try {
    db.run(`
      update pr_pipeline_settings
         set auto_merge = 1,
             force_finalize_mode = 'conditional',
             at_cap_policy = 'ci_retry_once',
             ptm_defaults_backfilled_version = 'ptm-defaults-v1'
       where auto_merge = 0
         and merge_method = 'repo_default'
         and max_rounds = 5
         and on_rebase_needed = 'pause'
         and coalesce(conflict_strategy, 'pause') = 'pause'
         and coalesce(force_finalize_mode, 'off') = 'off'
         and coalesce(force_finalize_require_no_ci_failures, 1) = 1
         and coalesce(early_merge_on_green, 1) = 1
         and (at_cap_policy is null or at_cap_policy = 'stop')
         and (at_cap_wait_minutes is null or at_cap_wait_minutes = 30)
         and (at_cap_ci_retry_max is null or at_cap_ci_retry_max = 3)
         and coalesce(force_merge_requires_confirmation, 1) = 1
         and auto_agent_provider is null
         and auto_agent_model is null
         and auto_agent_reasoning_effort is null
         and auto_agent_permission_mode is null
         and auto_agent_confidence_threshold is null
         and (ptm_defaults_backfilled_version is null or ptm_defaults_backfilled_version <> 'ptm-defaults-v1')
    `);
  } catch (err) {
    // Backfill failure leaves existing rows on the legacy defaults while new
    // rows pick up the new defaults — surface this so the split is visible.
    console.warn("kvDb.migrate.ptm_defaults_backfill_failed", err);
  }

  db.run(`
    create table if not exists pr_convergence_state (
      pr_id text primary key,
      auto_converge_enabled integer not null default 0,
      status text not null default 'idle',
      poller_status text not null default 'idle',
      current_round integer not null default 0,
      active_session_id text,
      active_lane_id text,
      active_href text,
      pause_reason text,
      error_message text,
      last_started_at text,
      last_polled_at text,
      last_paused_at text,
      last_stopped_at text,
      created_at text not null,
      updated_at text not null,
      foreign key(pr_id) references pull_requests(id) on delete cascade
    )
  `);
  // PtM-specific run args (modelId, reasoning, scope, additionalInstructions)
  // serialized as JSON. Persisted so resumeFromPersistedState can re-dispatch
  // the fix agent after a desktop restart instead of pausing on missing modelId.
  try { db.run("alter table pr_convergence_state add column ptm_args_json text"); } catch {}
  try { db.run("alter table pr_convergence_state add column force_finalize_used integer not null default 0"); } catch {}
  try { db.run("alter table pr_convergence_state add column ci_retry_attempts_used integer not null default 0"); } catch {}
  try { db.run("alter table pr_convergence_state add column wait_for_ci_started_at text"); } catch {}
  try { db.run("alter table pr_convergence_state add column last_dispatch_head_sha text"); } catch {}
  try { db.run("alter table pr_convergence_state add column last_bot_ping_head_sha text"); } catch {}
  try { db.run("alter table pr_convergence_state add column last_bot_ping_at text"); } catch {}
  try { db.run("alter table pr_convergence_state add column merge_wait_kind text"); } catch {}
  try { db.run("alter table pr_convergence_state add column pause_repeat_count integer not null default 0"); } catch {}
  try { db.run("alter table pr_convergence_state add column last_pause_reason_hash text"); } catch {}

  // Machine-local runtime guard for PR automation. This table intentionally
  // has no PRIMARY KEY so cr-sqlite does not register it as a CRR table.
  db.run(`
    create table if not exists lane_worktree_locks (
      worktree_key text not null unique,
      worktree_path text not null,
      lane_id text not null,
      owner_kind text not null,
      owner_pr_id text,
      owner_session_id text,
      owner_proposal_id text,
      owner_label text not null,
      token text not null,
      created_at text not null,
      heartbeat_at text not null,
      expires_at text not null
    )
  `);
  try {
    db.run("delete from lane_worktree_locks where worktree_key is null or trim(worktree_key) = ''");
    db.run(`
      delete from lane_worktree_locks
      where rowid not in (
        select max(rowid)
        from lane_worktree_locks
        group by worktree_key
      )
    `);
  } catch (error) {
    if (!isReadonlyDatabaseError(error)) throw error;
  }
  db.run("create unique index if not exists idx_lane_worktree_locks_worktree_key_unique on lane_worktree_locks(worktree_key)");
  db.run("create index if not exists idx_lane_worktree_locks_lane on lane_worktree_locks(lane_id)");
  db.run("create index if not exists idx_lane_worktree_locks_session on lane_worktree_locks(owner_session_id)");
  db.run("create index if not exists idx_lane_worktree_locks_expires on lane_worktree_locks(expires_at)");
}

function loadCrsqlite(db: DatabaseSyncType, extensionPath: string): void {
  db.enableLoadExtension(true);
  db.loadExtension(extensionPath);
}

export async function openKvDb(dbPath: string, logger: Logger): Promise<AdeDb> {
  const extensionPath = resolveCrsqliteExtensionPath();
  const hasCrsqlite = extensionPath != null;
  const desiredSiteId = ensureLocalSiteIdFile(dbPath);
  const existedBeforeOpen = fs.existsSync(dbPath);
  let db = openRawDatabase(dbPath);
  let crsqliteLoaded = false;
  const loadCrsqliteIfAvailable = (): boolean => {
    if (crsqliteLoaded) return true;
    if (!extensionPath) return false;
    try {
      loadCrsqlite(db, extensionPath);
      crsqliteLoaded = isCrsqliteRuntimeUsable(db);
      if (!crsqliteLoaded) {
        logger.warn("db.crsqlite_unavailable", { dbPath, reason: "extension loaded but required functions are unavailable" });
      }
    } catch (error) {
      crsqliteLoaded = false;
      logger.warn("db.crsqlite_unavailable", {
        dbPath,
        reason: "extension failed to load",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return crsqliteLoaded;
  };

  try {
    // Existing CRR tables install triggers that call cr-sqlite functions on
    // ordinary writes. Load the extension before any migrations or repair
    // updates can touch those tables in source-mode CLI and desktop startup.
    loadCrsqliteIfAvailable();
    const hadCrsqlMetadata = hasCrsqlMetadata(db);
    if (hadCrsqlMetadata && !crsqliteLoaded) {
      disableCrrTriggersForUnavailableRuntime(db, logger);
    }

    // Build a CRR-aware run wrapper: when crsqlite is loaded and a table has
    // been converted to a CRR, ALTER TABLE statements must be wrapped with
    // crsql_begin_alter / crsql_commit_alter so the clock tables stay in sync.
    const makeMigrateDb = () => ({
      run: (sql: string, params: SqlValue[] = []) => {
        const alterTable = parseAlterTableTarget(sql);
        if (alterTable && crsqliteLoaded && rawHasTable(db, `${alterTable}__crsql_clock`)) {
          getRow(db, "select crsql_begin_alter(?) as ok", [alterTable]);
          try {
            runStatement(db, sql, params);
          } catch (error) {
            // Commit the alter even on failure so the CRR state stays consistent,
            // then re-throw so the caller's try/catch can handle it (e.g. column
            // already exists on upgrade).
            getRow(db, "select crsql_commit_alter(?) as ok", [alterTable]);
            throw error;
          }
          getRow(db, "select crsql_commit_alter(?) as ok", [alterTable]);
          return;
        }
        runStatement(db, sql, params);
      },
      get: <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: SqlValue[] = []) => {
        return getRow<T>(db, sql, params);
      },
    });

    const migrateDb = makeMigrateDb();
    migrate(migrateDb);
    removeExcludedCrrMetadata(db, logger);
    // Tear down the legacy `unified_memories` schema (removed in #329) before
    // any retrofit pass runs — the FTS4 shadow tables cannot be dropped
    // individually and would crash the schema-rewrite loop further down.
    try {
      dropLegacyUnifiedMemoriesSchema(db, logger);
    } catch (error) {
      if (!isReadonlyDatabaseError(error)) throw error;
    }

    if (existedBeforeOpen && !hasCrsqlMetadata(db)) {
      writeMigrationBackupIfNeeded(dbPath);
    }

    let retrofittedLegacyPrimaryKeySchema = false;
    try {
      retrofittedLegacyPrimaryKeySchema = retrofitLegacyPrimaryKeyNotNullSchema(db);
    } catch (error) {
      if (!isReadonlyDatabaseError(error)) throw error;
    }
    if (retrofittedLegacyPrimaryKeySchema) {
      db.close();
      db = openRawDatabase(dbPath);
      crsqliteLoaded = false;
      loadCrsqliteIfAvailable();
      if (hasCrsqlMetadata(db) && !crsqliteLoaded) {
        disableCrrTriggersForUnavailableRuntime(db, logger);
      }
      const remigrateDb = makeMigrateDb();
      migrate(remigrateDb);
      removeExcludedCrrMetadata(db, logger);
    }

    let retrofittedForeignKeySchema = false;
    try {
      retrofittedForeignKeySchema = retrofitForeignKeyCascadeActions(db, crsqliteLoaded);
    } catch (error) {
      if (!isReadonlyDatabaseError(error)) throw error;
    }
    if (retrofittedForeignKeySchema) {
      db.close();
      db = openRawDatabase(dbPath);
      crsqliteLoaded = false;
      loadCrsqliteIfAvailable();
      if (hasCrsqlMetadata(db) && !crsqliteLoaded) {
        disableCrrTriggersForUnavailableRuntime(db, logger);
      }
      const remigrateDb = makeMigrateDb();
      migrate(remigrateDb);
      removeExcludedCrrMetadata(db, logger);
    }

    if (crsqliteLoaded) {
      loadCrsqliteIfAvailable();
      ensureCrrTables(db, logger);
      forceSiteId(db, desiredSiteId);

      if (readCurrentSiteId(db) !== desiredSiteId) {
        db.close();
        db = openRawDatabase(dbPath);
        crsqliteLoaded = false;
        loadCrsqliteIfAvailable();
        if (hasCrsqlMetadata(db) && !crsqliteLoaded) {
          disableCrrTriggersForUnavailableRuntime(db, logger);
        }
        if (crsqliteLoaded) {
          forceSiteId(db, desiredSiteId);
        }
      }
    } else {
      logger.warn("db.crsqlite_unavailable", {
        dbPath,
        reason: hasCrsqlite ? "extension not usable for this runtime" : "extension not found for this platform",
      });
    }
  } catch (err) {
    try {
      db.close();
    } catch {
      // best effort cleanup
    }
    logger.error("db.init_failed", { dbPath, err: String(err) });
    throw err;
  }

  const getString = (key: string): string | null => {
    const row = getRow<{ value: string }>(db, "select value from kv where key = ? limit 1", [key]);
    return row?.value ?? null;
  };

  const setString = (key: string, value: string) => {
    runStatement(db, "insert into kv(key, value) values (?, ?) on conflict(key) do update set value = excluded.value", [key, value]);
  };

  const run = (sql: string, params: SqlValue[] = []) => {
    const alterTable = parseAlterTableTarget(sql);
    if (crsqliteLoaded && alterTable && rawHasTable(db, `${alterTable}__crsql_clock`)) {
      getRow(db, "select crsql_begin_alter(?) as ok", [alterTable]);
      try {
        runStatement(db, sql, params);
      } catch (error) {
        throw error;
      }
      getRow(db, "select crsql_commit_alter(?) as ok", [alterTable]);
      return;
    }
    runStatement(db, sql, params);
  };

  const all = <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: SqlValue[] = []): T[] => {
    return allRows<T>(db, sql, params);
  };

  const get = <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: SqlValue[] = []): T | null => {
    return getRow<T>(db, sql, params);
  };

  const sync: AdeDbSyncApi = {
    isAvailable: () => crsqliteLoaded,
    getSiteId: () => desiredSiteId,
    getDbVersion: () => {
      if (!crsqliteLoaded) return 0;
      const row = get<{ db_version: number }>("select crsql_db_version() as db_version");
      return Number(row?.db_version ?? 0);
    },
    exportChangesSince: (version: number) => {
      if (!crsqliteLoaded) return [];
      const rows = allRows<{
        table_name: string;
        pk: unknown;
        cid: string;
        val: unknown;
        col_version: number;
        db_version: number;
        site_id: Uint8Array;
        cl: number;
        seq: number;
      }>(
        db,
        `select [table] as table_name,
                pk,
                cid,
                val,
                col_version,
                db_version,
                site_id,
                cl,
                seq
           from crsql_changes
          where db_version > ?
          order by db_version asc, cl asc, seq asc`,
        [version]
      );

      return rows.map((row) => ({
        table: row.table_name,
        pk: encodeSyncScalar(row.pk),
        cid: row.cid,
        val: encodeSyncScalar(row.val),
        col_version: Number(row.col_version),
        db_version: Number(row.db_version),
        site_id: Buffer.from(row.site_id).toString("hex"),
        cl: Number(row.cl),
        seq: Number(row.seq),
      }));
    },
    applyChanges: (changes: CrsqlChangeRow[]) => {
      if (!crsqliteLoaded) return { appliedCount: 0, dbVersion: 0, touchedTables: [], rebuiltFts: false };
      const actionableChanges = changes.filter(
        (change) => !isIgnoredIncomingSyncTable(db, change.table),
      );
      if (actionableChanges.length === 0) {
        return {
          appliedCount: 0,
          dbVersion: sync.getDbVersion(),
          touchedTables: [],
          rebuiltFts: false,
        };
      }
      let appliedCount = 0;
      const touchedTables = new Set<string>();
      runStatement(db, "begin");
      try {
        for (const rawChange of actionableChanges) {
          const change = normalizeIncomingCrsqlChange(db, rawChange);
          const result = runStatement(
            db,
            `insert or ignore into crsql_changes ([table], pk, cid, val, col_version, db_version, site_id, cl, seq)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              change.table,
              change.pk,
              change.cid,
              change.val,
              change.col_version,
              change.db_version,
              Buffer.from(change.site_id, "hex"),
              change.cl,
              change.seq,
            ]
          );
          appliedCount += result.changes;
          touchedTables.add(change.table);
        }
        runStatement(db, "commit");
      } catch (err) {
        runStatement(db, "rollback");
        throw err;
      }

      return {
        appliedCount,
        dbVersion: sync.getDbVersion(),
        touchedTables: Array.from(touchedTables).sort(),
        rebuiltFts: false,
      };
    },
  };

  return {
    getJson: <T,>(key: string): T | null => {
      const raw = getString(key);
      if (raw == null) return null;
      return safeJsonParse<T | null>(raw, null);
    },
    setJson: (key: string, value: unknown) => {
      setString(key, JSON.stringify(value));
    },
    run,
    all,
    get,
    sync,
    flushNow: () => {},
    close: () => {
      db.close();
    },
  };
}
