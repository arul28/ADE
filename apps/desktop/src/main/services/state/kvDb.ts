import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import initSqlJs from "sql.js";
import type { Database, SqlJsStatic } from "sql.js";
import type { Logger } from "../logging/logger";

export type SqlValue = string | number | null | Uint8Array;

export type AdeDb = {
  getJson: <T>(key: string) => T | null;
  setJson: (key: string, value: unknown) => void;

  run: (sql: string, params?: SqlValue[]) => void;
  get: <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: SqlValue[]) => T | null;
  all: <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: SqlValue[]) => T[];

  flushNow: () => void;
  close: () => void;
};

const require = createRequire(__filename);

function resolveSqlJsWasmDir(): string {
  // Ensure the wasm file can be located regardless of cwd.
  const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
  return path.dirname(wasmPath);
}

function ensureParentDir(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function safeJsonParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function mapExecRows(rows: { columns: string[]; values: unknown[][] }[]): Record<string, unknown>[] {
  const first = rows[0];
  if (!first) return [];
  const { columns, values } = first;
  const out: Record<string, unknown>[] = [];
  for (const row of values) {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < columns.length; i++) {
      obj[columns[i] ?? String(i)] = row[i];
    }
    out.push(obj);
  }
  return out;
}

function hasColumn(db: Database, table: string, column: string): boolean {
  try {
    const rows = db.exec(`pragma table_info(${table})`);
    const mapped = mapExecRows(rows);
    return mapped.some((row) => String(row.name ?? "") === column);
  } catch {
    return false;
  }
}

function addColumnIfMissing(db: Database, table: string, columnSql: string, columnName: string) {
  if (hasColumn(db, table, columnName)) return;
  db.run(`alter table ${table} add column ${columnSql}`);
}

function createIndexIfColumnsExist(db: Database, indexSql: string, table: string, columns: string[]) {
  const allPresent = columns.every((column) => hasColumn(db, table, column));
  if (!allPresent) return;
  db.run(indexSql);
}

function ensureProcessRuntimeLaneSchema(db: Database) {
  const hasLaneId = hasColumn(db, "process_runtime", "lane_id");
  if (hasLaneId) {
    db.run("create index if not exists idx_process_runtime_project_lane on process_runtime(project_id, lane_id)");
    return;
  }

  db.run("alter table process_runtime rename to process_runtime_legacy");
  db.run(`
    create table process_runtime (
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

  db.run(`
    insert into process_runtime(
      project_id, lane_id, process_key, status, pid, started_at, ended_at, exit_code, readiness, updated_at
    )
    select
      project_id,
      '__legacy__',
      process_key,
      status,
      pid,
      started_at,
      ended_at,
      exit_code,
      readiness,
      updated_at
    from process_runtime_legacy
  `);
  db.run("drop table process_runtime_legacy");
  db.run("create index if not exists idx_process_runtime_project_id on process_runtime(project_id)");
  db.run("create index if not exists idx_process_runtime_project_lane on process_runtime(project_id, lane_id)");
}

function migrate(db: Database) {
  // Keep KV for UI layout persistence.
  db.run("create table if not exists kv (key text primary key, value text not null)");

  // Phase 0 + Phase 1 tables.
  db.run(`
    create table if not exists projects (
      id text primary key,
      root_path text not null unique,
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
      status text not null,
      created_at text not null,
      archived_at text,
      foreign key(project_id) references projects(id),
      foreign key(parent_lane_id) references lanes(id)
    )
  `);
  addColumnIfMissing(db, "lanes", "lane_type text not null default 'worktree'", "lane_type");
  addColumnIfMissing(db, "lanes", "attached_root_path text", "attached_root_path");
  addColumnIfMissing(db, "lanes", "is_edit_protected integer not null default 0", "is_edit_protected");
  addColumnIfMissing(db, "lanes", "parent_lane_id text", "parent_lane_id");
  addColumnIfMissing(db, "lanes", "color text", "color");
  addColumnIfMissing(db, "lanes", "icon text", "icon");
  addColumnIfMissing(db, "lanes", "tags_json text", "tags_json");
  createIndexIfColumnsExist(db, "create index if not exists idx_lanes_project_id on lanes(project_id)", "lanes", ["project_id"]);
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_lanes_project_type on lanes(project_id, lane_type)",
    "lanes",
    ["project_id", "lane_type"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_lanes_project_parent on lanes(project_id, parent_lane_id)",
    "lanes",
    ["project_id", "parent_lane_id"]
  );

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
      foreign key(lane_id) references lanes(id)
    )
  `);
  addColumnIfMissing(db, "terminal_sessions", "tracked integer not null default 1", "tracked");
  addColumnIfMissing(db, "terminal_sessions", "goal text", "goal");
  addColumnIfMissing(db, "terminal_sessions", "tool_type text", "tool_type");
  addColumnIfMissing(db, "terminal_sessions", "pinned integer not null default 0", "pinned");
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_terminal_sessions_lane_id on terminal_sessions(lane_id)",
    "terminal_sessions",
    ["lane_id"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_terminal_sessions_status on terminal_sessions(status)",
    "terminal_sessions",
    ["status"]
  );

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
      unique(project_id, key),
      foreign key(project_id) references projects(id)
    )
  `);
  db.run("create index if not exists idx_process_definitions_project_id on process_definitions(project_id)");

  db.run(`
    create table if not exists process_runtime (
      project_id text not null,
      lane_id text not null default '__legacy__',
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
  ensureProcessRuntimeLaneSchema(db);
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_process_runtime_project_id on process_runtime(project_id)",
    "process_runtime",
    ["project_id"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_process_runtime_project_lane on process_runtime(project_id, lane_id)",
    "process_runtime",
    ["project_id", "lane_id"]
  );

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
  addColumnIfMissing(db, "process_runs", "lane_id text", "lane_id");
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_process_runs_project_proc on process_runs(project_id, process_key)",
    "process_runs",
    ["project_id", "process_key"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_process_runs_project_lane on process_runs(project_id, lane_id)",
    "process_runs",
    ["project_id", "lane_id"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_process_runs_started_at on process_runs(started_at)",
    "process_runs",
    ["started_at"]
  );

  db.run(`
    create table if not exists stack_buttons (
      id text primary key,
      project_id text not null,
      key text not null,
      name text not null,
      process_keys_json text not null,
      start_order text not null,
      updated_at text not null,
      unique(project_id, key),
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
      unique(project_id, key),
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
  addColumnIfMissing(db, "test_runs", "lane_id text", "lane_id");
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_test_runs_project_suite on test_runs(project_id, suite_key)",
    "test_runs",
    ["project_id", "suite_key"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_test_runs_started_at on test_runs(started_at)",
    "test_runs",
    ["started_at"]
  );

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
  addColumnIfMissing(db, "operations", "lane_id text", "lane_id");
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_operations_project_started on operations(project_id, started_at)",
    "operations",
    ["project_id", "started_at"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_operations_lane_started on operations(lane_id, started_at)",
    "operations",
    ["lane_id", "started_at"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_operations_kind on operations(kind)",
    "operations",
    ["kind"]
  );

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
  addColumnIfMissing(db, "packs_index", "lane_id text", "lane_id");
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_packs_index_project on packs_index(project_id)",
    "packs_index",
    ["project_id"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_packs_index_lane on packs_index(lane_id)",
    "packs_index",
    ["lane_id"]
  );

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
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_session_deltas_lane_started on session_deltas(lane_id, started_at)",
    "session_deltas",
    ["lane_id", "started_at"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_session_deltas_project_started on session_deltas(project_id, started_at)",
    "session_deltas",
    ["project_id", "started_at"]
  );

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
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_cp_lane_a on conflict_predictions(lane_a_id)",
    "conflict_predictions",
    ["lane_a_id"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_cp_lane_b on conflict_predictions(lane_b_id)",
    "conflict_predictions",
    ["lane_b_id"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_cp_predicted_at on conflict_predictions(predicted_at)",
    "conflict_predictions",
    ["predicted_at"]
  );

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
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_conflict_proposals_lane on conflict_proposals(project_id, lane_id)",
    "conflict_proposals",
    ["project_id", "lane_id"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_conflict_proposals_status on conflict_proposals(project_id, status)",
    "conflict_proposals",
    ["project_id", "status"]
  );

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
      unique(project_id, lane_id),
      unique(project_id, repo_owner, repo_name, github_pr_number),
      foreign key(project_id) references projects(id),
      foreign key(lane_id) references lanes(id)
    )
  `);
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_pull_requests_lane_id on pull_requests(lane_id)",
    "pull_requests",
    ["lane_id"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_pull_requests_project_id on pull_requests(project_id)",
    "pull_requests",
    ["project_id"]
  );

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
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_checkpoints_project_created on checkpoints(project_id, created_at)",
    "checkpoints",
    ["project_id", "created_at"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_checkpoints_lane_created on checkpoints(lane_id, created_at)",
    "checkpoints",
    ["lane_id", "created_at"]
  );

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
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_pack_events_project_created on pack_events(project_id, created_at)",
    "pack_events",
    ["project_id", "created_at"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_pack_events_pack_key_created on pack_events(project_id, pack_key, created_at)",
    "pack_events",
    ["project_id", "pack_key", "created_at"]
  );

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
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_pack_versions_project_pack on pack_versions(project_id, pack_key)",
    "pack_versions",
    ["project_id", "pack_key"]
  );
  db.run(
    "create unique index if not exists idx_pack_versions_project_pack_version on pack_versions(project_id, pack_key, version_number)"
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
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_pack_heads_project on pack_heads(project_id)",
    "pack_heads",
    ["project_id"]
  );

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
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_automation_runs_project_started on automation_runs(project_id, started_at)",
    "automation_runs",
    ["project_id", "started_at"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_automation_runs_project_automation on automation_runs(project_id, automation_id)",
    "automation_runs",
    ["project_id", "automation_id"]
  );

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
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_automation_action_results_project_run on automation_action_results(project_id, run_id)",
    "automation_action_results",
    ["project_id", "run_id"]
  );
}

export async function openKvDb(dbPath: string, logger: Logger): Promise<AdeDb> {
  const wasmDir = resolveSqlJsWasmDir();

  let SQL: SqlJsStatic;
  try {
    SQL = await initSqlJs({
      locateFile: (file) => path.join(wasmDir, file)
    });
  } catch (err) {
    logger.error("db.init_failed", { dbPath, err: String(err) });
    throw err;
  }

  ensureParentDir(dbPath);
  const data = fs.existsSync(dbPath) ? fs.readFileSync(dbPath) : null;
  const db: Database = new SQL.Database(data);

  migrate(db);

  let dirty = false;
  let flushTimer: NodeJS.Timeout | null = null;

  const flushNow = () => {
    if (!dirty) return;
    dirty = false;
    try {
      const bytes = db.export();
      ensureParentDir(dbPath);
      fs.writeFileSync(dbPath, bytes);
      logger.debug("db.flushed", { dbPath, bytes: bytes.length });
    } catch (err) {
      logger.error("db.flush_failed", { dbPath, err: String(err) });
    }
  };

  const scheduleFlush = () => {
    dirty = true;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flushNow, 125);
  };

  const getString = (key: string): string | null => {
    const rows = db.exec("select value from kv where key = ? limit 1", [key]);
    const first = rows[0]?.values?.[0]?.[0];
    return typeof first === "string" ? first : first == null ? null : String(first);
  };

  const setString = (key: string, value: string) => {
    db.run(
      "insert into kv(key, value) values (?, ?) on conflict(key) do update set value=excluded.value",
      [key, value]
    );
    scheduleFlush();
  };

  const run = (sql: string, params: SqlValue[] = []) => {
    db.run(sql, params);
    scheduleFlush();
  };

  const all = <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: SqlValue[] = []): T[] => {
    const rows = db.exec(sql, params);
    return mapExecRows(rows) as T[];
  };

  const get = <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: SqlValue[] = []): T | null => {
    const rows = all<T>(sql, params);
    return rows[0] ?? null;
  };

  return {
    getJson: <T,>(key: string): T | null => {
      const raw = getString(key);
      if (raw == null) return null;
      return safeJsonParse<T>(raw);
    },
    setJson: (key: string, value: unknown) => {
      setString(key, JSON.stringify(value));
    },
    run,
    all,
    get,
    flushNow: () => flushNow(),
    close: () => {
      if (flushTimer) clearTimeout(flushTimer);
      flushNow();
      db.close();
    }
  };
}
