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

export type SqlValue = string | number | null | Uint8Array;

export type AdeDbSyncApi = {
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

const require = createRequire(__filename);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: typeof DatabaseSyncType };

function ensureParentDir(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function openRawDatabase(dbPath: string): DatabaseSyncType {
  ensureParentDir(dbPath);
  return new DatabaseSync(dbPath, { allowExtension: true });
}

function toDbValue(value: SqlValue | SyncScalar): string | number | null | Uint8Array {
  if (value == null || typeof value === "string" || typeof value === "number") {
    return value;
  }
  if (value instanceof Uint8Array) {
    return value;
  }
  if (typeof value === "object" && "type" in value && value.type === "bytes") {
    return Buffer.from(value.base64, "base64");
  }
  throw new Error("Unsupported database value");
}

function runStatement(db: DatabaseSyncType, sql: string, params: Array<SqlValue | SyncScalar> = []): { changes: number } {
  try {
    return db.prepare(sql).run(...params.map((param) => toDbValue(param))) as { changes: number };
  } catch (error) {
    const statement = sql.replace(/\s+/g, " ").trim();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message} [sql=${statement}]`);
  }
}

function getRow<T>(db: DatabaseSyncType, sql: string, params: Array<SqlValue | SyncScalar> = []): T | null {
  return (db.prepare(sql).get(...params.map((param) => toDbValue(param))) as T | undefined) ?? null;
}

function allRows<T>(db: DatabaseSyncType, sql: string, params: Array<SqlValue | SyncScalar> = []): T[] {
  return db.prepare(sql).all(...params.map((param) => toDbValue(param))) as T[];
}

function rawHasTable(db: DatabaseSyncType, tableName: string): boolean {
  return Boolean(getRow(db, "select 1 as present from sqlite_master where type = 'table' and name = ? limit 1", [tableName]));
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
    `select name, sql
       from sqlite_master
      where type = 'table'
        and sql is not null
        and name not like 'sqlite_%'
        and name not like 'crsql_%'
        and name not like '%__crsql_clock'
        and name not like '%__crsql_pks'
        and name not like 'unified_memories_fts%'`
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
 * Keyed by `"table:column"`.  `references` is the target (e.g. `"missions(id)"`),
 * `action` is the ON DELETE clause (e.g. `"on delete cascade"`).
 *
 * When a database was created before these clauses were added to the CREATE
 * TABLE statements the stored schema in `sqlite_master` will be missing them;
 * this map drives a one-time table-rebuild migration that adds the correct
 * referential actions.
 */
const FK_CONSTRAINTS: Record<string, { references: string; action: string }> = {
  // lanes
  "lanes:mission_id": { references: "missions(id)", action: "on delete set null" },
  // missions
  "missions:mission_lane_id": { references: "lanes(id)", action: "on delete set null" },
  "missions:result_lane_id": { references: "lanes(id)", action: "on delete set null" },
  // mission child tables
  "mission_steps:mission_id": { references: "missions(id)", action: "on delete cascade" },
  "mission_events:mission_id": { references: "missions(id)", action: "on delete cascade" },
  "mission_artifacts:mission_id": { references: "missions(id)", action: "on delete cascade" },
  "mission_interventions:mission_id": { references: "missions(id)", action: "on delete cascade" },
  "mission_phase_overrides:mission_id": { references: "missions(id)", action: "on delete cascade" },
  "mission_step_handoffs:mission_id": { references: "missions(id)", action: "on delete cascade" },
  "mission_metrics_config:mission_id": { references: "missions(id)", action: "on delete cascade" },
  // orchestrator tables
  "orchestrator_runs:mission_id": { references: "missions(id)", action: "on delete cascade" },
  "orchestrator_chat_threads:mission_id": { references: "missions(id)", action: "on delete cascade" },
  "orchestrator_chat_messages:mission_id": { references: "missions(id)", action: "on delete cascade" },
  "orchestrator_worker_digests:mission_id": { references: "missions(id)", action: "on delete cascade" },
  "orchestrator_artifacts:mission_id": { references: "missions(id)", action: "on delete cascade" },
  "orchestrator_context_checkpoints:mission_id": { references: "missions(id)", action: "on delete cascade" },
  "orchestrator_worker_checkpoints:mission_id": { references: "missions(id)", action: "on delete cascade" },
  "orchestrator_lane_decisions:mission_id": { references: "missions(id)", action: "on delete cascade" },
  "orchestrator_ai_decisions:mission_id": { references: "missions(id)", action: "on delete cascade" },
  "orchestrator_metrics_samples:mission_id": { references: "missions(id)", action: "on delete cascade" },
  "orchestrator_team_members:mission_id": { references: "missions(id)", action: "on delete cascade" },
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
    `select name, sql
       from sqlite_master
      where type = 'table'
        and sql is not null
        and name not like 'sqlite_%'
        and name not like 'crsql_%'
        and name not like '%__crsql_clock'
        and name not like '%__crsql_pks'
        and name not like 'unified_memories_fts%'`
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
        //   foreign key(mission_id) references missions(id)
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

function listEligibleCrrTables(db: DatabaseSyncType): string[] {
  const tables = allRows<{ name: string; sql: string | null }>(
    db,
    `select name, sql
       from sqlite_master
      where type = 'table'
        and sql is not null
        and name not like 'sqlite_%'
        and name not like 'crsql_%'
        and name not like '%__crsql_clock'
        and name not like '%__crsql_pks'
        and name not like 'unified_memories_fts%'`
  );
  return tables
    .filter((table) => !table.sql?.toLowerCase().startsWith("create virtual table"))
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
  const repairTargets = new Set<string>(PHONE_CRITICAL_CRR_TABLES);
  for (const tableName of listEligibleCrrTables(db)) {
    if (rawHasTable(db, `${tableName}__crsql_clock`)) {
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

function rebuildUnifiedMemoriesFts(db: DatabaseSyncType): void {
  if (!rawHasTable(db, "unified_memories") || !rawHasTable(db, "unified_memories_fts")) {
    return;
  }
  try {
    runStatement(db, "insert into unified_memories_fts(unified_memories_fts) values ('rebuild')");
  } catch {
    runStatement(db, "delete from unified_memories_fts");
    runStatement(db, "insert into unified_memories_fts(rowid, content) select rowid, content from unified_memories");
  }
}

function ensureUnifiedMemoriesSearchTable(db: { run: (sql: string, params?: SqlValue[]) => void }): void {
  try {
    db.run(`
      create virtual table if not exists unified_memories_fts using fts4(
        content,
        content='unified_memories'
      )
    `);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/no such module: fts4/i.test(message) && !/no such module: fts5/i.test(message)) {
      throw error;
    }
    db.run(`
      create table if not exists unified_memories_fts (
        rowid integer primary key,
        content text not null
      )
    `);
  }
}

function parseAlterTableTarget(sql: string): string | null {
  const match = sql.match(/^\s*alter\s+table\s+([`"'[\]A-Za-z0-9_]+)\s+add\s+column\s+/i);
  if (!match?.[1]) return null;
  return match[1].replace(/^["'`[]|["'`\]]$/g, "");
}

function migrate(db: { run: (sql: string, params?: SqlValue[]) => void }) {
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
      mission_id text,
      lane_role text,
      status text not null,
      created_at text not null,
      archived_at text,
      foreign key(project_id) references projects(id),
      foreign key(parent_lane_id) references lanes(id),
      foreign key(mission_id) references missions(id) on delete set null
    )
  `);
  try { db.run("alter table lanes add column mission_id text"); } catch {}
  try { db.run("alter table lanes add column lane_role text"); } catch {}
  db.run("create index if not exists idx_lanes_project_id on lanes(project_id)");
  db.run("create index if not exists idx_lanes_project_type on lanes(project_id, lane_type)");
  db.run("create index if not exists idx_lanes_project_parent on lanes(project_id, parent_lane_id)");
  db.run("create index if not exists idx_lanes_project_mission on lanes(project_id, mission_id)");
  db.run("create index if not exists idx_lanes_project_role on lanes(project_id, lane_role)");

  db.run(`
    create table if not exists lane_state_snapshots (
      lane_id text primary key,
      dirty integer not null default 0,
      ahead integer not null default 0,
      behind integer not null default 0,
      remote_behind integer not null default -1,
      rebase_in_progress integer not null default 0,
      agent_summary_json text,
      mission_summary_json text,
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
      foreign key(lane_id) references lanes(id)
    )
  `);
  db.run("create index if not exists idx_terminal_sessions_lane_id on terminal_sessions(lane_id)");
  db.run("create index if not exists idx_terminal_sessions_status on terminal_sessions(status)");
  db.run("create index if not exists idx_terminal_sessions_started_at on terminal_sessions(started_at desc)");
  db.run("create index if not exists idx_terminal_sessions_lane_started_at on terminal_sessions(lane_id, started_at desc)");

  // Migration: add resume_command to existing databases that pre-date this column.
  try { db.run("alter table terminal_sessions add column resume_command text"); } catch {}

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

  // Phase 1 missions model foundation.
  db.run(`
    create table if not exists missions (
      id text primary key,
      project_id text not null,
      lane_id text,
      mission_lane_id text,
      result_lane_id text,
      title text not null,
      prompt text not null,
      status text not null,
      priority text not null default 'normal',
      execution_mode text not null default 'local',
      target_machine_id text,
      queue_claim_token text,
      queue_claimed_at text,
      outcome_summary text,
      last_error text,
      metadata_json text,
      created_at text not null,
      updated_at text not null,
      started_at text,
      completed_at text,
      archived_at text,
      foreign key(project_id) references projects(id),
      foreign key(lane_id) references lanes(id),
      foreign key(mission_lane_id) references lanes(id) on delete set null,
      foreign key(result_lane_id) references lanes(id) on delete set null
    )
  `);
  try { db.run("alter table missions add column mission_lane_id text"); } catch {}
  try { db.run("alter table missions add column result_lane_id text"); } catch {}
  try { db.run("alter table missions add column queue_claim_token text"); } catch {}
  try { db.run("alter table missions add column queue_claimed_at text"); } catch {}
  try { db.run("alter table missions add column archived_at text"); } catch {}
  db.run("create index if not exists idx_missions_project_updated on missions(project_id, updated_at)");
  db.run("create index if not exists idx_missions_project_status on missions(project_id, status)");
  db.run("create index if not exists idx_missions_project_lane on missions(project_id, lane_id)");
  db.run("create index if not exists idx_missions_project_mission_lane on missions(project_id, mission_lane_id)");
  db.run("create index if not exists idx_missions_project_result_lane on missions(project_id, result_lane_id)");
  db.run("drop index if exists idx_missions_queue_claim_token");
  db.run("create index if not exists idx_missions_project_queue_claim on missions(project_id, queue_claim_token)");

  db.run(`
    create table if not exists mission_steps (
      id text primary key,
      mission_id text not null,
      project_id text not null,
      step_index integer not null,
      title text not null,
      detail text,
      kind text not null default 'manual',
      lane_id text,
      status text not null,
      metadata_json text,
      created_at text not null,
      updated_at text not null,
      started_at text,
      completed_at text,
      foreign key(mission_id) references missions(id) on delete cascade,
      foreign key(project_id) references projects(id),
      foreign key(lane_id) references lanes(id)
    )
  `);
  db.run("create index if not exists idx_mission_steps_mission_index on mission_steps(mission_id, step_index)");
  db.run("create index if not exists idx_mission_steps_project_status on mission_steps(project_id, status)");

  db.run(`
    create table if not exists mission_events (
      id text primary key,
      mission_id text not null,
      project_id text not null,
      event_type text not null,
      actor text not null,
      summary text not null,
      payload_json text,
      created_at text not null,
      foreign key(mission_id) references missions(id) on delete cascade,
      foreign key(project_id) references projects(id)
    )
  `);
  db.run("create index if not exists idx_mission_events_mission_created on mission_events(mission_id, created_at)");
  db.run("create index if not exists idx_mission_events_project_created on mission_events(project_id, created_at)");

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

  db.run(`
    create table if not exists mission_artifacts (
      id text primary key,
      mission_id text not null,
      project_id text not null,
      artifact_type text not null,
      title text not null,
      description text,
      uri text,
      lane_id text,
      metadata_json text,
      created_at text not null,
      updated_at text not null,
      created_by text not null,
      foreign key(mission_id) references missions(id) on delete cascade,
      foreign key(project_id) references projects(id),
      foreign key(lane_id) references lanes(id)
    )
  `);
  db.run("create index if not exists idx_mission_artifacts_mission_created on mission_artifacts(mission_id, created_at)");

  db.run(`
    create table if not exists mission_interventions (
      id text primary key,
      mission_id text not null,
      project_id text not null,
      intervention_type text not null,
      status text not null,
      resolution_kind text,
      title text not null,
      body text not null,
      requested_action text,
      resolution_note text,
      lane_id text,
      metadata_json text,
      created_at text not null,
      updated_at text not null,
      resolved_at text,
      foreign key(mission_id) references missions(id) on delete cascade,
      foreign key(project_id) references projects(id),
      foreign key(lane_id) references lanes(id)
    )
  `);
  try { db.run("alter table mission_interventions add column resolution_kind text"); } catch {}
  db.run("create index if not exists idx_mission_interventions_mission_status on mission_interventions(mission_id, status)");
  db.run("create index if not exists idx_mission_interventions_project_status on mission_interventions(project_id, status)");

  // Phase 3: mission phases engine + profile storage.
  db.run(`
    create table if not exists phase_cards (
      id text primary key,
      project_id text not null,
      phase_key text not null,
      name text not null,
      description text not null,
      instructions text not null,
      model_json text not null,
      budget_json text,
      ordering_constraints_json text,
      ask_questions_json text,
      validation_gate_json text,
      is_built_in integer not null default 0,
      is_custom integer not null default 0,
      position integer not null default 0,
      archived_at text,
      created_at text not null,
      updated_at text not null,
      foreign key(project_id) references projects(id)
    )
  `);
  db.run("create index if not exists idx_phase_cards_project_position on phase_cards(project_id, position)");

  db.run(`
    create table if not exists phase_profiles (
      id text primary key,
      project_id text not null,
      name text not null,
      description text not null,
      phases_json text not null,
      is_built_in integer not null default 0,
      is_default integer not null default 0,
      archived_at text,
      created_at text not null,
      updated_at text not null,
      foreign key(project_id) references projects(id)
    )
  `);
  db.run("create index if not exists idx_phase_profiles_project_updated on phase_profiles(project_id, updated_at)");
  db.run("create index if not exists idx_phase_profiles_project_default on phase_profiles(project_id, is_default)");

  db.run(`
    create table if not exists mission_phase_overrides (
      id text primary key,
      mission_id text not null,
      project_id text not null,
      profile_id text,
      phases_json text not null,
      created_at text not null,
      updated_at text not null,
      foreign key(mission_id) references missions(id) on delete cascade,
      foreign key(project_id) references projects(id),
      foreign key(profile_id) references phase_profiles(id)
    )
  `);
  db.run("create index if not exists idx_mission_phase_overrides_project_mission on mission_phase_overrides(project_id, mission_id)");
  db.run("create index if not exists idx_mission_phase_overrides_profile on mission_phase_overrides(profile_id)");

  // Phase 1.5 orchestrator/context hardening gate.
  db.run(`
    create table if not exists orchestrator_runs (
      id text primary key,
      project_id text not null,
      mission_id text not null,
      status text not null,
      context_profile text not null default 'orchestrator_deterministic_v1',
      scheduler_state text not null,
      runtime_cursor_json text,
      last_error text,
      metadata_json text,
      created_at text not null,
      updated_at text not null,
      started_at text,
      completed_at text,
      foreign key(project_id) references projects(id),
      foreign key(mission_id) references missions(id) on delete cascade
    )
  `);
  db.run("create index if not exists idx_orchestrator_runs_project_status on orchestrator_runs(project_id, status)");
  db.run("create index if not exists idx_orchestrator_runs_mission on orchestrator_runs(mission_id)");
  db.run("create index if not exists idx_orchestrator_runs_project_updated on orchestrator_runs(project_id, updated_at)");

  db.run(`
    create table if not exists orchestrator_steps (
      id text primary key,
      run_id text not null,
      project_id text not null,
      mission_step_id text,
      step_key text not null,
      step_index integer not null,
      title text not null,
      lane_id text,
      status text not null,
      join_policy text not null default 'all_success',
      quorum_count integer,
      dependency_step_ids_json text not null default '[]',
      retry_limit integer not null default 0,
      retry_count integer not null default 0,
      last_attempt_id text,
      policy_json text,
      metadata_json text,
      created_at text not null,
      updated_at text not null,
      started_at text,
      completed_at text,
      foreign key(run_id) references orchestrator_runs(id),
      foreign key(project_id) references projects(id),
      foreign key(mission_step_id) references mission_steps(id),
      foreign key(lane_id) references lanes(id)
    )
  `);
  db.run("create index if not exists idx_orchestrator_steps_run_status on orchestrator_steps(run_id, status)");
  db.run("create index if not exists idx_orchestrator_steps_project_status on orchestrator_steps(project_id, status)");
  db.run("create index if not exists idx_orchestrator_steps_run_order on orchestrator_steps(run_id, step_index)");

  db.run(`
    create table if not exists orchestrator_attempts (
      id text primary key,
      run_id text not null,
      step_id text not null,
      project_id text not null,
      attempt_number integer not null,
      status text not null,
      executor_kind text not null,
      executor_session_id text,
      tracked_session_enforced integer not null default 1,
      context_profile text not null default 'orchestrator_deterministic_v1',
      context_snapshot_id text,
      error_class text not null default 'none',
      error_message text,
      retry_backoff_ms integer not null default 0,
      result_envelope_json text,
      metadata_json text,
      created_at text not null,
      started_at text,
      completed_at text,
      foreign key(run_id) references orchestrator_runs(id),
      foreign key(step_id) references orchestrator_steps(id),
      foreign key(project_id) references projects(id),
      foreign key(context_snapshot_id) references orchestrator_context_snapshots(id)
    )
  `);
  db.run("create index if not exists idx_orchestrator_attempts_run_status on orchestrator_attempts(run_id, status)");
  db.run("create index if not exists idx_orchestrator_attempts_step_status on orchestrator_attempts(step_id, status)");
  db.run("create index if not exists idx_orchestrator_attempts_project_created on orchestrator_attempts(project_id, created_at)");

  db.run(`
    create table if not exists orchestrator_attempt_runtime (
      attempt_id text primary key,
      session_id text,
      runtime_state text,
      last_signal_at text,
      last_output_preview text,
      last_preview_digest text,
      digest_since_ms integer not null default 0,
      repeat_count integer not null default 0,
      last_waiting_intervention_at_ms integer not null default 0,
      last_event_heartbeat_at_ms integer not null default 0,
      last_waiting_notified_at_ms integer not null default 0,
      updated_at text not null,
      foreign key(attempt_id) references orchestrator_attempts(id)
    )
  `);
  db.run("create index if not exists idx_orchestrator_attempt_runtime_session on orchestrator_attempt_runtime(session_id)");
  db.run("create index if not exists idx_orchestrator_attempt_runtime_updated on orchestrator_attempt_runtime(updated_at)");

  db.run(`
    create table if not exists orchestrator_runtime_events (
      id text primary key,
      project_id text not null,
      run_id text not null,
      step_id text,
      attempt_id text,
      session_id text,
      event_type text not null,
      event_key text not null,
      occurred_at text not null,
      payload_json text,
      created_at text not null,
      foreign key(project_id) references projects(id),
      foreign key(run_id) references orchestrator_runs(id),
      foreign key(step_id) references orchestrator_steps(id),
      foreign key(attempt_id) references orchestrator_attempts(id)
    )
  `);
  db.run("create index if not exists idx_orchestrator_runtime_events_run_occurred on orchestrator_runtime_events(run_id, occurred_at)");
  db.run("create index if not exists idx_orchestrator_runtime_events_attempt_occurred on orchestrator_runtime_events(attempt_id, occurred_at)");
  db.run("create index if not exists idx_orchestrator_runtime_events_session_occurred on orchestrator_runtime_events(session_id, occurred_at)");
  db.run("create index if not exists idx_orchestrator_runtime_events_project_key on orchestrator_runtime_events(project_id, event_key)");

  db.run(`
    create table if not exists orchestrator_claims (
      id text primary key,
      project_id text not null,
      run_id text not null,
      step_id text,
      attempt_id text,
      owner_id text not null,
      scope_kind text not null,
      scope_value text not null,
      state text not null,
      acquired_at text not null,
      heartbeat_at text not null,
      expires_at text not null,
      released_at text,
      policy_json text,
      metadata_json text,
      foreign key(project_id) references projects(id),
      foreign key(run_id) references orchestrator_runs(id),
      foreign key(step_id) references orchestrator_steps(id),
      foreign key(attempt_id) references orchestrator_attempts(id)
    )
  `);
  db.run("create index if not exists idx_orchestrator_claims_run_state on orchestrator_claims(run_id, state)");
  db.run("create index if not exists idx_orchestrator_claims_scope_state on orchestrator_claims(project_id, scope_kind, scope_value, state)");
  db.run("create index if not exists idx_orchestrator_claims_expires on orchestrator_claims(state, expires_at)");
  db.run(
    "create index if not exists idx_orchestrator_claims_active_scope on orchestrator_claims(project_id, scope_kind, scope_value) where state = 'active'"
  );

  db.run(`
    create table if not exists orchestrator_context_snapshots (
      id text primary key,
      project_id text not null,
      run_id text not null,
      step_id text,
      attempt_id text,
      snapshot_type text not null,
      context_profile text not null default 'orchestrator_deterministic_v1',
      cursor_json text not null,
      created_at text not null,
      foreign key(project_id) references projects(id),
      foreign key(run_id) references orchestrator_runs(id),
      foreign key(step_id) references orchestrator_steps(id),
      foreign key(attempt_id) references orchestrator_attempts(id)
    )
  `);
  db.run("create index if not exists idx_orchestrator_context_snapshots_run_created on orchestrator_context_snapshots(run_id, created_at)");
  db.run("create index if not exists idx_orchestrator_context_snapshots_attempt on orchestrator_context_snapshots(attempt_id)");

  db.run(`
    create table if not exists mission_step_handoffs (
      id text primary key,
      project_id text not null,
      mission_id text not null,
      mission_step_id text,
      run_id text,
      step_id text,
      attempt_id text,
      handoff_type text not null,
      producer text not null,
      payload_json text not null,
      created_at text not null,
      foreign key(project_id) references projects(id),
      foreign key(mission_id) references missions(id) on delete cascade,
      foreign key(mission_step_id) references mission_steps(id),
      foreign key(run_id) references orchestrator_runs(id),
      foreign key(step_id) references orchestrator_steps(id),
      foreign key(attempt_id) references orchestrator_attempts(id)
    )
  `);
  db.run("create index if not exists idx_mission_step_handoffs_mission_created on mission_step_handoffs(mission_id, created_at)");
  db.run("create index if not exists idx_mission_step_handoffs_step_created on mission_step_handoffs(mission_step_id, created_at)");
  db.run("create index if not exists idx_mission_step_handoffs_attempt on mission_step_handoffs(attempt_id)");

  // Phase 2 orchestrator runtime v2: durable timeline + quality gate snapshots.
  db.run(`
    create table if not exists orchestrator_timeline_events (
      id text primary key,
      project_id text not null,
      run_id text not null,
      step_id text,
      attempt_id text,
      claim_id text,
      event_type text not null,
      reason text not null,
      detail_json text,
      created_at text not null,
      foreign key(project_id) references projects(id),
      foreign key(run_id) references orchestrator_runs(id),
      foreign key(step_id) references orchestrator_steps(id),
      foreign key(attempt_id) references orchestrator_attempts(id),
      foreign key(claim_id) references orchestrator_claims(id)
    )
  `);
  db.run("create index if not exists idx_orchestrator_timeline_run_created on orchestrator_timeline_events(run_id, created_at)");
  db.run("create index if not exists idx_orchestrator_timeline_attempt on orchestrator_timeline_events(attempt_id)");
  db.run("create index if not exists idx_orchestrator_timeline_project_created on orchestrator_timeline_events(project_id, created_at)");

  db.run(`
    create table if not exists orchestrator_gate_reports (
      id text primary key,
      project_id text not null,
      generated_at text not null,
      report_json text not null,
      foreign key(project_id) references projects(id)
    )
  `);
  db.run("create index if not exists idx_orchestrator_gate_reports_project_generated on orchestrator_gate_reports(project_id, generated_at)");

  // Big-bang orchestrator overhaul: threaded chat, digest/checkpoint, lane decisions, and mission metrics.
  db.run(`
    create table if not exists orchestrator_chat_threads (
      id text primary key,
      project_id text not null,
      mission_id text not null,
      thread_type text not null,
      title text not null,
      run_id text,
      step_id text,
      step_key text,
      attempt_id text,
      session_id text,
      lane_id text,
      status text not null default 'active',
      unread_count integer not null default 0,
      metadata_json text,
      created_at text not null,
      updated_at text not null,
      foreign key(project_id) references projects(id),
      foreign key(mission_id) references missions(id) on delete cascade,
      foreign key(run_id) references orchestrator_runs(id),
      foreign key(step_id) references orchestrator_steps(id),
      foreign key(attempt_id) references orchestrator_attempts(id),
      foreign key(lane_id) references lanes(id)
    )
  `);
  db.run("create index if not exists idx_orchestrator_chat_threads_mission_updated on orchestrator_chat_threads(mission_id, updated_at)");
  db.run("create index if not exists idx_orchestrator_chat_threads_project_mission on orchestrator_chat_threads(project_id, mission_id)");
  db.run("create index if not exists idx_orchestrator_chat_threads_mission_type on orchestrator_chat_threads(mission_id, thread_type)");
  db.run("create index if not exists idx_orchestrator_chat_threads_lane on orchestrator_chat_threads(lane_id)");

  db.run(`
    create table if not exists orchestrator_chat_messages (
      id text primary key,
      project_id text not null,
      mission_id text not null,
      thread_id text not null,
      role text not null,
      content text not null,
      timestamp text not null,
      step_key text,
      target_json text,
      visibility text not null default 'full',
      delivery_state text not null default 'delivered',
      source_session_id text,
      attempt_id text,
      lane_id text,
      run_id text,
      metadata_json text,
      created_at text not null,
      foreign key(project_id) references projects(id),
      foreign key(mission_id) references missions(id) on delete cascade,
      foreign key(thread_id) references orchestrator_chat_threads(id),
      foreign key(attempt_id) references orchestrator_attempts(id),
      foreign key(lane_id) references lanes(id),
      foreign key(run_id) references orchestrator_runs(id)
    )
  `);
  db.run("create index if not exists idx_orchestrator_chat_messages_thread_ts on orchestrator_chat_messages(thread_id, timestamp)");
  db.run("create index if not exists idx_orchestrator_chat_messages_mission_ts on orchestrator_chat_messages(mission_id, timestamp)");
  db.run("create index if not exists idx_orchestrator_chat_messages_attempt_ts on orchestrator_chat_messages(attempt_id, timestamp)");
  db.run("create index if not exists idx_orchestrator_chat_messages_lane_ts on orchestrator_chat_messages(lane_id, timestamp)");
  db.run("create index if not exists idx_orchestrator_chat_messages_delivery_queue on orchestrator_chat_messages(delivery_state, role, mission_id, thread_id, timestamp)");

  db.run(`
    create table if not exists orchestrator_worker_digests (
      id text primary key,
      project_id text not null,
      mission_id text not null,
      run_id text not null,
      step_id text not null,
      step_key text,
      attempt_id text not null,
      lane_id text,
      session_id text,
      status text not null,
      summary text not null,
      files_changed_json text not null,
      tests_run_json text not null,
      warnings_json text not null,
      tokens_json text,
      cost_usd real,
      suggested_next_actions_json text not null,
      created_at text not null,
      foreign key(project_id) references projects(id),
      foreign key(mission_id) references missions(id) on delete cascade,
      foreign key(run_id) references orchestrator_runs(id),
      foreign key(step_id) references orchestrator_steps(id),
      foreign key(attempt_id) references orchestrator_attempts(id),
      foreign key(lane_id) references lanes(id)
    )
  `);
  db.run("create index if not exists idx_orchestrator_worker_digests_mission_created on orchestrator_worker_digests(mission_id, created_at)");
  db.run("create index if not exists idx_orchestrator_worker_digests_run_created on orchestrator_worker_digests(run_id, created_at)");
  db.run("create index if not exists idx_orchestrator_worker_digests_attempt on orchestrator_worker_digests(attempt_id)");
  db.run("create index if not exists idx_orchestrator_worker_digests_lane_created on orchestrator_worker_digests(lane_id, created_at)");

  db.run(`
    create table if not exists orchestrator_artifacts (
      id text primary key,
      project_id text not null,
      mission_id text not null,
      run_id text not null,
      step_id text not null,
      attempt_id text not null,
      artifact_key text not null,
      kind text not null,
      value text not null,
      metadata_json text not null default '{}',
      declared integer not null default 0,
      created_at text not null,
      foreign key(project_id) references projects(id),
      foreign key(mission_id) references missions(id) on delete cascade,
      foreign key(run_id) references orchestrator_runs(id),
      foreign key(step_id) references orchestrator_steps(id),
      foreign key(attempt_id) references orchestrator_attempts(id)
    )
  `);
  db.run("create index if not exists idx_orchestrator_artifacts_mission_created on orchestrator_artifacts(mission_id, created_at)");
  db.run("create index if not exists idx_orchestrator_artifacts_step on orchestrator_artifacts(step_id)");
  db.run("create index if not exists idx_orchestrator_artifacts_mission_key on orchestrator_artifacts(mission_id, artifact_key)");

  db.run(`
    create table if not exists orchestrator_context_checkpoints (
      id text primary key,
      project_id text not null,
      mission_id text not null,
      run_id text,
      trigger text not null,
      summary text not null,
      source_json text not null,
      created_at text not null,
      foreign key(project_id) references projects(id),
      foreign key(mission_id) references missions(id) on delete cascade,
      foreign key(run_id) references orchestrator_runs(id)
    )
  `);
  db.run("create index if not exists idx_orchestrator_context_checkpoints_mission_created on orchestrator_context_checkpoints(mission_id, created_at)");
  db.run("create index if not exists idx_orchestrator_context_checkpoints_run_created on orchestrator_context_checkpoints(run_id, created_at)");

  db.run(`
    create table if not exists orchestrator_worker_checkpoints (
      id text primary key,
      project_id text not null,
      mission_id text not null,
      run_id text not null,
      step_id text not null,
      attempt_id text not null,
      step_key text not null,
      content text not null,
      file_path text not null,
      created_at text not null,
      updated_at text not null,
      foreign key(project_id) references projects(id),
      foreign key(mission_id) references missions(id) on delete cascade,
      foreign key(run_id) references orchestrator_runs(id),
      foreign key(step_id) references orchestrator_steps(id),
      foreign key(attempt_id) references orchestrator_attempts(id)
    )
  `);
  db.run("create index if not exists idx_orchestrator_worker_checkpoints_mission_step_key on orchestrator_worker_checkpoints(mission_id, step_key)");
  db.run("create index if not exists idx_orchestrator_worker_checkpoints_run on orchestrator_worker_checkpoints(run_id)");
  db.run("create index if not exists idx_orchestrator_worker_checkpoints_mission on orchestrator_worker_checkpoints(mission_id, updated_at)");

  db.run(`
    create table if not exists orchestrator_lane_decisions (
      id text primary key,
      project_id text not null,
      mission_id text not null,
      run_id text,
      step_id text,
      step_key text,
      lane_id text,
      decision_type text not null,
      validator_outcome text not null,
      rule_hits_json text not null,
      rationale text not null,
      metadata_json text,
      created_at text not null,
      foreign key(project_id) references projects(id),
      foreign key(mission_id) references missions(id) on delete cascade,
      foreign key(run_id) references orchestrator_runs(id),
      foreign key(step_id) references orchestrator_steps(id),
      foreign key(lane_id) references lanes(id)
    )
  `);
  db.run("create index if not exists idx_orchestrator_lane_decisions_mission_created on orchestrator_lane_decisions(mission_id, created_at)");
  db.run("create index if not exists idx_orchestrator_lane_decisions_run_created on orchestrator_lane_decisions(run_id, created_at)");
  db.run("create index if not exists idx_orchestrator_lane_decisions_step_created on orchestrator_lane_decisions(step_id, created_at)");
  db.run("create index if not exists idx_orchestrator_lane_decisions_lane_created on orchestrator_lane_decisions(lane_id, created_at)");

  db.run(`
    create table if not exists orchestrator_ai_decisions (
      id text primary key,
      project_id text not null,
      mission_id text not null,
      run_id text,
      step_id text,
      attempt_id text,
      call_type text not null,
      provider text,
      model text,
      timeout_cap_ms integer,
      decision_json text not null,
      action_trace_json text,
      validation_json text,
      rationale text,
      fallback_used integer not null default 0,
      failure_reason text,
      duration_ms integer,
      prompt_tokens integer,
      completion_tokens integer,
      created_at text not null,
      foreign key(project_id) references projects(id),
      foreign key(mission_id) references missions(id) on delete cascade,
      foreign key(run_id) references orchestrator_runs(id),
      foreign key(step_id) references orchestrator_steps(id),
      foreign key(attempt_id) references orchestrator_attempts(id)
    )
  `);
  db.run("create index if not exists idx_orchestrator_ai_decisions_mission_created on orchestrator_ai_decisions(mission_id, created_at)");
  db.run("create index if not exists idx_orchestrator_ai_decisions_run_created on orchestrator_ai_decisions(run_id, created_at)");
  db.run("create index if not exists idx_orchestrator_ai_decisions_step_created on orchestrator_ai_decisions(step_id, created_at)");
  db.run("create index if not exists idx_orchestrator_ai_decisions_project_category_created on orchestrator_ai_decisions(project_id, call_type, created_at)");
  db.run("create index if not exists idx_orchestrator_ai_decisions_created on orchestrator_ai_decisions(created_at)");

  db.run(`
    create table if not exists mission_metrics_config (
      mission_id text primary key,
      project_id text not null,
      toggles_json text not null,
      updated_at text not null,
      foreign key(mission_id) references missions(id) on delete cascade,
      foreign key(project_id) references projects(id)
    )
  `);
  db.run("create index if not exists idx_mission_metrics_config_project_updated on mission_metrics_config(project_id, updated_at)");

  db.run(`
    create table if not exists orchestrator_metrics_samples (
      id text primary key,
      project_id text not null,
      mission_id text not null,
      run_id text,
      attempt_id text,
      metric text not null,
      value real not null,
      unit text,
      metadata_json text,
      created_at text not null,
      foreign key(project_id) references projects(id),
      foreign key(mission_id) references missions(id) on delete cascade,
      foreign key(run_id) references orchestrator_runs(id),
      foreign key(attempt_id) references orchestrator_attempts(id)
    )
  `);
  db.run("create index if not exists idx_orchestrator_metrics_samples_mission_created on orchestrator_metrics_samples(mission_id, created_at)");
  db.run("create index if not exists idx_orchestrator_metrics_samples_run_created on orchestrator_metrics_samples(run_id, created_at)");
  db.run("create index if not exists idx_orchestrator_metrics_samples_metric_created on orchestrator_metrics_samples(metric, created_at)");

  // WS8 Memory & Context Enhancement System.
  db.run(`
    create table if not exists memories (
      id text primary key,
      project_id text not null,
      scope text not null,
      category text not null,
      content text not null,
      importance text default 'medium',
      source_session_id text,
      source_pack_key text,
      status text default 'promoted',
      agent_id text,
      confidence real default 1.0,
      promoted_at text,
      source_run_id text,
      created_at text not null,
      last_accessed_at text not null,
      access_count integer default 0
    )
  `);
  db.run("create index if not exists idx_memories_project_scope on memories(project_id, scope)");
  db.run("create index if not exists idx_memories_project_importance on memories(project_id, importance)");
  db.run("create index if not exists idx_memories_last_accessed on memories(last_accessed_at)");
  db.run("create index if not exists idx_memories_status on memories(project_id, status)");
  db.run("create index if not exists idx_memories_agent on memories(agent_id)");

  // Unified memory backend (project/agent/mission scopes, tiered retrieval).
  db.run(`
    create table if not exists unified_memories (
      id text primary key,
      project_id text not null,
      scope text not null,
      scope_owner_id text,
      tier integer not null default 2,
      category text not null,
      content text not null,
      importance text not null default 'medium',
      confidence real not null default 1.0,
      observation_count integer not null default 1,
      status text not null default 'promoted',
      source_type text not null default 'agent',
      source_id text,
      source_session_id text,
      source_pack_key text,
      source_run_id text,
      file_scope_pattern text,
      agent_id text,
      pinned integer not null default 0,
      access_score real not null default 0,
      composite_score real not null default 0,
      write_gate_reason text,
      dedupe_key text not null default '',
      created_at text not null,
      updated_at text not null,
      last_accessed_at text not null,
      access_count integer not null default 0,
      promoted_at text,
      foreign key(project_id) references projects(id)
    )
  `);
  db.run("create index if not exists idx_unified_memories_project_scope_tier on unified_memories(project_id, scope, tier)");
  db.run("create index if not exists idx_unified_memories_scope_owner on unified_memories(project_id, scope, scope_owner_id)");
  db.run("create index if not exists idx_unified_memories_project_status on unified_memories(project_id, status)");
  db.run("create index if not exists idx_unified_memories_project_pinned on unified_memories(project_id, pinned, tier)");
  db.run("create index if not exists idx_unified_memories_project_accessed on unified_memories(project_id, last_accessed_at)");
  db.run("create index if not exists idx_unified_memories_project_dedupe on unified_memories(project_id, scope, scope_owner_id, dedupe_key)");
  try { db.run("alter table unified_memories add column access_score real not null default 0"); } catch {}
  db.run(`
    update unified_memories
    set access_score = case
      when coalesce(access_score, 0) > 0 then access_score
      when coalesce(composite_score, 0) > 0 then composite_score
      else min(1.0, max(0.0, coalesce(access_count, 0) / 10.0))
    end
  `);

  ensureUnifiedMemoriesSearchTable(db);
  db.run(`
    create trigger if not exists unified_memories_fts_ai after insert on unified_memories begin
      insert into unified_memories_fts(rowid, content)
      values (new.rowid, new.content);
    end
  `);
  db.run(`
    create trigger if not exists unified_memories_fts_bd before delete on unified_memories begin
      delete from unified_memories_fts
      where rowid = old.rowid;
    end
  `);
  db.run(`
    create trigger if not exists unified_memories_fts_bu before update on unified_memories begin
      delete from unified_memories_fts
      where rowid = old.rowid;
    end
  `);
  db.run(`
    create trigger if not exists unified_memories_fts_au after update on unified_memories begin
      insert into unified_memories_fts(rowid, content)
      values (new.rowid, new.content);
    end
  `);

  db.run(`
    create table if not exists unified_memory_embeddings (
      id text primary key,
      memory_id text not null,
      project_id text not null,
      embedding_model text not null,
      embedding_blob blob not null,
      dimensions integer not null,
      norm real,
      created_at text not null,
      updated_at text not null,
      foreign key(memory_id) references unified_memories(id),
      foreign key(project_id) references projects(id)
    )
  `);
  db.run("create index if not exists idx_unified_memory_embeddings_project on unified_memory_embeddings(project_id)");
  db.run("create index if not exists idx_unified_memory_embeddings_memory on unified_memory_embeddings(memory_id)");

  db.run(`
    create table if not exists memory_procedure_details (
      memory_id text primary key,
      trigger text not null,
      procedure_markdown text not null,
      success_count integer not null default 0,
      failure_count integer not null default 0,
      last_used_at text,
      exported_skill_path text,
      exported_at text,
      superseded_by_memory_id text,
      created_at text not null,
      updated_at text not null,
      foreign key(memory_id) references unified_memories(id),
      foreign key(superseded_by_memory_id) references unified_memories(id)
    )
  `);
  db.run("create index if not exists idx_memory_procedure_details_updated on memory_procedure_details(updated_at desc)");
  db.run("create index if not exists idx_memory_procedure_details_exported on memory_procedure_details(exported_at desc)");

  db.run(`
    create table if not exists memory_procedure_sources (
      procedure_memory_id text not null,
      episode_memory_id text not null,
      created_at text not null,
      primary key (procedure_memory_id, episode_memory_id),
      foreign key(procedure_memory_id) references unified_memories(id),
      foreign key(episode_memory_id) references unified_memories(id)
    )
  `);
  db.run("create index if not exists idx_memory_procedure_sources_episode on memory_procedure_sources(episode_memory_id)");

  db.run(`
    create table if not exists memory_procedure_history (
      id text primary key,
      procedure_memory_id text not null,
      confidence real not null,
      outcome text not null,
      reason text,
      recorded_at text not null,
      foreign key(procedure_memory_id) references unified_memories(id)
    )
  `);
  db.run("create index if not exists idx_memory_procedure_history_procedure on memory_procedure_history(procedure_memory_id, recorded_at desc)");

  db.run(`
    create table if not exists memory_skill_index (
      id text primary key,
      path text not null,
      kind text not null,
      source text not null,
      memory_id text,
      content_hash text not null,
      last_modified_at text,
      archived_at text,
      created_at text not null,
      updated_at text not null,
      foreign key(memory_id) references unified_memories(id)
    )
  `);
  db.run("create index if not exists idx_memory_skill_index_memory on memory_skill_index(memory_id)");
  db.run("create index if not exists idx_memory_skill_index_archived on memory_skill_index(archived_at)");

  db.run(`
    create table if not exists memory_capture_ledger (
      id text primary key,
      project_id text not null,
      source_type text not null,
      source_key text not null,
      memory_id text,
      episode_memory_id text,
      metadata_json text,
      created_at text not null,
      updated_at text not null,
      foreign key(project_id) references projects(id),
      foreign key(memory_id) references unified_memories(id),
      foreign key(episode_memory_id) references unified_memories(id)
    )
  `);
  db.run("create index if not exists idx_memory_capture_ledger_source on memory_capture_ledger(project_id, source_type, updated_at desc)");
  db.run("create index if not exists idx_memory_capture_ledger_memory on memory_capture_ledger(memory_id)");

  db.run(`
    create table if not exists memory_sweep_log (
      sweep_id text primary key,
      project_id text not null,
      trigger_reason text not null,
      started_at text not null,
      completed_at text not null,
      entries_decayed integer not null default 0,
      entries_demoted integer not null default 0,
      entries_promoted integer not null default 0,
      entries_archived integer not null default 0,
      entries_orphaned integer not null default 0,
      duration_ms integer not null default 0,
      foreign key(project_id) references projects(id)
    )
  `);
  db.run("create index if not exists idx_memory_sweep_log_project_completed on memory_sweep_log(project_id, completed_at desc)");

  db.run(`
    create table if not exists memory_consolidation_log (
      consolidation_id text primary key,
      project_id text not null,
      trigger_reason text not null,
      started_at text not null,
      completed_at text not null,
      clusters_found integer not null default 0,
      entries_merged integer not null default 0,
      entries_created integer not null default 0,
      tokens_used integer not null default 0,
      duration_ms integer not null default 0
    )
  `);
  db.run("create index if not exists idx_memory_consolidation_log_project_completed on memory_consolidation_log(project_id, completed_at desc)");

  // One-time safe backfill from legacy memories table.
  db.run(`
    insert or ignore into unified_memories (
      id,
      project_id,
      scope,
      scope_owner_id,
      tier,
      category,
      content,
      importance,
      confidence,
      observation_count,
      status,
      source_type,
      source_id,
      source_session_id,
      source_pack_key,
      source_run_id,
      file_scope_pattern,
      agent_id,
      pinned,
      access_score,
      composite_score,
      write_gate_reason,
      dedupe_key,
      created_at,
      updated_at,
      last_accessed_at,
      access_count,
      promoted_at
    )
    select
      id,
      project_id,
      case scope
        when 'project' then 'project'
        when 'mission' then 'mission'
        when 'user' then 'agent'
        when 'lane' then 'mission'
        else 'project'
      end as scope,
      case scope
        when 'mission' then coalesce(source_run_id, agent_id, source_session_id)
        when 'user' then coalesce(agent_id, source_session_id)
        when 'lane' then coalesce(agent_id, source_session_id)
        else null
      end as scope_owner_id,
      case
        when status = 'archived' then 3
        when status = 'candidate' then 3
        else 2
      end as tier,
      category,
      content,
      coalesce(importance, 'medium') as importance,
      coalesce(confidence, 1.0) as confidence,
      case
        when coalesce(access_count, 0) > 0 then access_count
        else 1
      end as observation_count,
      coalesce(status, 'promoted') as status,
      'system' as source_type,
      coalesce(source_run_id, source_session_id, source_pack_key, agent_id) as source_id,
      source_session_id,
      source_pack_key,
      source_run_id,
      null as file_scope_pattern,
      agent_id,
      0 as pinned,
      min(1.0, max(0.0, coalesce(access_count, 0) / 10.0)) as access_score,
      0 as composite_score,
      null as write_gate_reason,
      lower(trim(content)) as dedupe_key,
      coalesce(created_at, last_accessed_at, datetime('now')) as created_at,
      coalesce(promoted_at, last_accessed_at, created_at, datetime('now')) as updated_at,
      coalesce(last_accessed_at, created_at, datetime('now')) as last_accessed_at,
      coalesce(access_count, 0) as access_count,
      promoted_at
    from memories
  `);
  try {
    db.run("insert into unified_memories_fts(unified_memories_fts) values ('rebuild')");
  } catch {
    db.run("delete from unified_memories_fts");
    db.run("insert into unified_memories_fts(rowid, content) select rowid, content from unified_memories");
  }

  // Canonicalize mission memory ownership from run ids to mission ids where possible.
  try {
    db.run(`
      update unified_memories
      set scope_owner_id = (
        select r.mission_id
        from orchestrator_runs r
        where r.id = unified_memories.scope_owner_id
          and coalesce(r.mission_id, '') != ''
        limit 1
      ),
      updated_at = datetime('now')
      where scope = 'mission'
        and coalesce(scope_owner_id, '') != ''
        and exists (
          select 1
          from orchestrator_runs r
          where r.id = unified_memories.scope_owner_id
            and coalesce(r.mission_id, '') != ''
        )
    `);
  } catch {
    // Best-effort migration for older databases.
  }

  // CTO persistent identity/core-memory/session-log state.
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
    create table if not exists cto_core_memory_state (
      project_id text primary key,
      version integer not null,
      payload_json text not null,
      updated_at text not null
    )
  `);
  db.run("create index if not exists idx_cto_core_memory_state_updated on cto_core_memory_state(updated_at)");

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

  // Team runtime: persistent team member registry for agent-team orchestration.
  db.run(`
    create table if not exists orchestrator_team_members (
      id text primary key,
      run_id text not null,
      mission_id text not null,
      provider text not null,
      model text not null,
      role text not null default 'teammate',
      session_id text,
      status text not null default 'spawning',
      claimed_task_ids_json text not null default '[]',
      metadata_json text,
      created_at text not null,
      updated_at text not null,
      foreign key(run_id) references orchestrator_runs(id),
      foreign key(mission_id) references missions(id) on delete cascade
    )
  `);
  db.run("create index if not exists idx_orchestrator_team_members_run on orchestrator_team_members(run_id)");
  db.run("create index if not exists idx_orchestrator_team_members_mission on orchestrator_team_members(mission_id)");
  db.run("create index if not exists idx_orchestrator_team_members_status on orchestrator_team_members(run_id, status)");


  // Reflection protocol tables (Phase 7): structured reflection ledger + run retrospectives.
  db.run(`
    create table if not exists orchestrator_reflections (
      id text primary key,
      project_id text not null,
      mission_id text not null,
      run_id text not null,
      step_id text,
      attempt_id text,
      agent_role text not null,
      phase text not null,
      signal_type text not null,
      observation text not null,
      recommendation text not null,
      context text not null,
      occurred_at text not null,
      created_at text not null,
      schema_version integer not null default 1,
      foreign key(run_id) references orchestrator_runs(id)
    )
  `);
  db.run("create index if not exists idx_orchestrator_reflections_run_occurred on orchestrator_reflections(run_id, occurred_at)");
  db.run("create index if not exists idx_orchestrator_reflections_mission on orchestrator_reflections(mission_id, occurred_at)");

  db.run(`
    create table if not exists orchestrator_retrospectives (
      id text primary key,
      project_id text not null,
      mission_id text not null,
      run_id text not null,
      generated_at text not null,
      final_status text not null,
      payload_json text not null,
      schema_version integer not null default 1,
      created_at text not null,
      foreign key(run_id) references orchestrator_runs(id)
    )
  `);
  db.run("create index if not exists idx_orchestrator_retrospectives_mission_generated on orchestrator_retrospectives(mission_id, generated_at)");

  db.run(`
    create table if not exists orchestrator_retrospective_trends (
      id text primary key,
      project_id text not null,
      mission_id text not null,
      run_id text not null,
      retrospective_id text not null,
      source_mission_id text not null,
      source_run_id text not null,
      source_retrospective_id text not null,
      pain_point_key text not null,
      pain_point_label text not null,
      status text not null,
      previous_pain_score integer not null default 0,
      current_pain_score integer not null default 0,
      created_at text not null
    )
  `);
  db.run("create index if not exists idx_orchestrator_retrospective_trends_mission_created on orchestrator_retrospective_trends(mission_id, created_at)");
  db.run("create index if not exists idx_orchestrator_retrospective_trends_run_created on orchestrator_retrospective_trends(run_id, created_at)");

  db.run(`
    create table if not exists orchestrator_reflection_pattern_stats (
      id text primary key,
      project_id text not null,
      pattern_key text not null,
      pattern_label text not null,
      occurrence_count integer not null default 0,
      first_seen_retrospective_id text not null,
      first_seen_run_id text not null,
      last_seen_retrospective_id text not null,
      last_seen_run_id text not null,
      promoted_memory_id text,
      created_at text not null,
      updated_at text not null
    )
  `);
  db.run("create index if not exists idx_orchestrator_reflection_pattern_stats_count on orchestrator_reflection_pattern_stats(project_id, occurrence_count desc, updated_at desc)");

  db.run(`
    create table if not exists orchestrator_reflection_pattern_sources (
      id text primary key,
      project_id text not null,
      pattern_stat_id text not null,
      retrospective_id text not null,
      mission_id text not null,
      run_id text not null,
      created_at text not null,
      foreign key(pattern_stat_id) references orchestrator_reflection_pattern_stats(id)
    )
  `);
  db.run("create index if not exists idx_orchestrator_reflection_pattern_sources_pattern on orchestrator_reflection_pattern_sources(pattern_stat_id, created_at)");
  db.run("create index if not exists idx_orchestrator_reflection_pattern_sources_mission on orchestrator_reflection_pattern_sources(mission_id, created_at)");
  // Team runtime: durable run-level state for team lifecycle (phase, completion gating).
  db.run(`
    create table if not exists orchestrator_run_state (
      run_id text primary key,
      phase text not null default 'bootstrapping',
      completion_requested integer not null default 0,
      completion_validated integer not null default 0,
      last_validation_error text,
      coordinator_session_id text,
      teammate_ids_json text not null default '[]',
      created_at text not null,
      updated_at text not null,
      foreign key(run_id) references orchestrator_runs(id)
    )
  `);

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
      mission_id text,
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
      mission_id text,
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
      linked_mission_id text,
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

  db.run(`
    create table if not exists external_mcp_usage_events (
      id text primary key,
      project_id text not null,
      server_name text not null,
      tool_name text not null,
      namespaced_tool_name text not null,
      safety text not null,
      caller_role text not null,
      caller_id text not null,
      chat_session_id text,
      mission_id text,
      run_id text,
      step_id text,
      attempt_id text,
      owner_id text,
      cost_cents integer not null default 0,
      estimated integer not null default 0,
      occurred_at text not null,
      created_at text not null
    )
  `);
  try { db.run("alter table external_mcp_usage_events add column chat_session_id text"); } catch {}
  db.run("create index if not exists idx_external_mcp_usage_events_project_occurred on external_mcp_usage_events(project_id, occurred_at)");
  db.run("create index if not exists idx_external_mcp_usage_events_chat on external_mcp_usage_events(project_id, chat_session_id, occurred_at)");
  db.run("create index if not exists idx_external_mcp_usage_events_mission on external_mcp_usage_events(project_id, mission_id, occurred_at)");
  db.run("create index if not exists idx_external_mcp_usage_events_run on external_mcp_usage_events(project_id, run_id, occurred_at)");

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

  // PR pipeline settings: per-PR auto-converge / auto-merge configuration
  db.run(`
    create table if not exists pr_pipeline_settings (
      pr_id text primary key,
      auto_merge integer not null default 0,
      merge_method text not null default 'repo_default',
      max_rounds integer not null default 5,
      on_rebase_needed text not null default 'pause',
      updated_at text not null,
      foreign key(pr_id) references pull_requests(id) on delete cascade
    )
  `);

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

  try {
    const hadCrsqlMetadata = hasCrsqlMetadata(db);
    if (hadCrsqlMetadata && hasCrsqlite) {
      loadCrsqlite(db, extensionPath);
    }

    migrate({
      run: (sql: string, params: SqlValue[] = []) => {
        runStatement(db, sql, params);
      },
    });

    if (existedBeforeOpen && !hasCrsqlMetadata(db)) {
      writeMigrationBackupIfNeeded(dbPath);
    }

    if (retrofitLegacyPrimaryKeyNotNullSchema(db)) {
      db.close();
      db = openRawDatabase(dbPath);
      if (hadCrsqlMetadata && hasCrsqlite) {
        loadCrsqlite(db, extensionPath);
      }
      migrate({
        run: (sql: string, params: SqlValue[] = []) => {
          runStatement(db, sql, params);
        },
      });
    }

    if (retrofitForeignKeyCascadeActions(db, hasCrsqlite)) {
      db.close();
      db = openRawDatabase(dbPath);
      if (hadCrsqlMetadata && hasCrsqlite) {
        loadCrsqlite(db, extensionPath);
      }
      migrate({
        run: (sql: string, params: SqlValue[] = []) => {
          runStatement(db, sql, params);
        },
      });
    }

    if (hasCrsqlite) {
      if (!hadCrsqlMetadata) {
        loadCrsqlite(db, extensionPath);
      }
      ensureCrrTables(db, logger);
      forceSiteId(db, desiredSiteId);

      if (readCurrentSiteId(db) !== desiredSiteId) {
        db.close();
        db = openRawDatabase(dbPath);
        loadCrsqlite(db, extensionPath);
        forceSiteId(db, desiredSiteId);
      }
    } else {
      logger.warn("db.crsqlite_unavailable", { dbPath, reason: "extension not found for this platform" });
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
    if (hasCrsqlite && alterTable && rawHasTable(db, `${alterTable}__crsql_clock`)) {
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

  const crsqliteUnavailableError = () => new Error("cr-sqlite extension not available on this platform");

  const sync: AdeDbSyncApi = {
    getSiteId: () => desiredSiteId,
    getDbVersion: () => {
      if (!hasCrsqlite) throw crsqliteUnavailableError();
      const row = get<{ db_version: number }>("select crsql_db_version() as db_version");
      return Number(row?.db_version ?? 0);
    },
    exportChangesSince: (version: number) => {
      if (!hasCrsqlite) throw crsqliteUnavailableError();
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
      if (!hasCrsqlite) throw crsqliteUnavailableError();
      let appliedCount = 0;
      const touchedTables = new Set<string>();
      runStatement(db, "begin");
      try {
        for (const change of changes) {
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

      let rebuiltFts = false;
      if (touchedTables.has("unified_memories")) {
        rebuildUnifiedMemoriesFts(db);
        rebuiltFts = true;
      }

      return {
        appliedCount,
        dbVersion: sync.getDbVersion(),
        touchedTables: Array.from(touchedTables).sort(),
        rebuiltFts,
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
