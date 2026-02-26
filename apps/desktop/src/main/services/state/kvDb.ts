import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import initSqlJs from "sql.js";
import type { Database, SqlJsStatic } from "sql.js";
import type { Logger } from "../logging/logger";

export type SqlValue = string | number | null | Uint8Array;

/**
 * Well-known KV key registry. Services store typed JSON under these key
 * patterns. The registry is advisory -- callers use `getJson<T>` to specify
 * the expected shape -- but having the keys in one place aids discoverability
 * and prevents key collisions.
 *
 * Known key patterns:
 *   "onboarding:status"           -> OnboardingStatus
 *   "ci:import_state"             -> CiImportState
 *   "keybinding:overrides"        -> KeybindingOverride[]
 *   "trusted_shared_hash"         -> string
 *   "context_doc_last_run"        -> { provider; generatedAt; prdPath; archPath }
 *   "dock:<projectId>"            -> DockLayout
 *   "file-tree:<projectId>"       -> unknown (file tree state)
 *   "graph-state:<projectId>"     -> GraphPersistedState
 *   "terminal-profiles:<projId>"  -> TerminalProfilesSnapshot
 *   "auto-rebase:<laneId>"        -> StoredStatus
 *   "restack-suggestion:<laneId>" -> StoredSuggestionState
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

  flushNow: () => void;
  close: () => void;
};

const require = createRequire(
  typeof __filename !== "undefined" ? __filename : import.meta.url
);
const FLUSH_DEBOUNCE_MS = 500;

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
  addColumnIfMissing(db, "lanes", "folder text", "folder");
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
      last_output_at text,
      summary text,
      resume_command text,
      foreign key(lane_id) references lanes(id)
    )
  `);
  addColumnIfMissing(db, "terminal_sessions", "tracked integer not null default 1", "tracked");
  addColumnIfMissing(db, "terminal_sessions", "goal text", "goal");
  addColumnIfMissing(db, "terminal_sessions", "tool_type text", "tool_type");
  addColumnIfMissing(db, "terminal_sessions", "pinned integer not null default 0", "pinned");
  addColumnIfMissing(db, "terminal_sessions", "summary text", "summary");
  addColumnIfMissing(db, "terminal_sessions", "last_output_at text", "last_output_at");
  addColumnIfMissing(db, "terminal_sessions", "resume_command text", "resume_command");
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
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_ai_usage_feature_timestamp on ai_usage_log(feature, timestamp)",
    "ai_usage_log",
    ["feature", "timestamp"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_ai_usage_timestamp on ai_usage_log(timestamp)",
    "ai_usage_log",
    ["timestamp"]
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

  // Phase 8+ PR groups (stacked / integration).
  db.run(`
    create table if not exists pr_groups (
      id text primary key,
      project_id text not null,
      group_type text not null,
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

  // PR groups: add columns for queue overhaul
  addColumnIfMissing(db, "pr_groups", "name text", "name");
  addColumnIfMissing(db, "pr_groups", "auto_rebase integer not null default 0", "auto_rebase");
  addColumnIfMissing(db, "pr_groups", "ci_gating integer not null default 0", "ci_gating");
  addColumnIfMissing(db, "pr_groups", "target_branch text", "target_branch");

  // Migrate "stacked" → "queue" group type
  db.run(`update pr_groups set group_type = 'queue' where group_type = 'stacked'`);

  // Integration proposals table (dry-merge simulation results)
  db.run(`
    create table if not exists integration_proposals (
      id text primary key,
      project_id text not null,
      source_lane_ids_json text not null,
      base_branch text not null,
      steps_json text not null,
      overall_outcome text not null,
      created_at text not null,
      foreign key(project_id) references projects(id)
    )
  `);
  db.run("create index if not exists idx_integration_proposals_project on integration_proposals(project_id)");
  addColumnIfMissing(db, "integration_proposals", "title text default ''", "title");
  addColumnIfMissing(db, "integration_proposals", "body text default ''", "body");
  addColumnIfMissing(db, "integration_proposals", "draft integer not null default 0", "draft");
  addColumnIfMissing(db, "integration_proposals", "integration_lane_name text default ''", "integration_lane_name");
  addColumnIfMissing(db, "integration_proposals", "status text not null default 'proposed'", "status");
  addColumnIfMissing(db, "integration_proposals", "integration_lane_id text", "integration_lane_id");
  addColumnIfMissing(db, "integration_proposals", "resolution_state_json text", "resolution_state_json");
  addColumnIfMissing(db, "integration_proposals", "pairwise_results_json text not null default '[]'", "pairwise_results_json");
  addColumnIfMissing(db, "integration_proposals", "lane_summaries_json text not null default '[]'", "lane_summaries_json");

  // Queue landing state table (crash recovery for sequential landing)
  db.run(`
    create table if not exists queue_landing_state (
      id text primary key,
      group_id text not null,
      project_id text not null,
      state text not null,
      entries_json text not null,
      current_position integer not null default 0,
      started_at text not null,
      completed_at text,
      foreign key(group_id) references pr_groups(id),
      foreign key(project_id) references projects(id)
    )
  `);
  db.run("create index if not exists idx_queue_landing_state_group on queue_landing_state(group_id)");

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
      title text not null,
      prompt text not null,
      status text not null,
      priority text not null default 'normal',
      execution_mode text not null default 'local',
      target_machine_id text,
      outcome_summary text,
      last_error text,
      metadata_json text,
      created_at text not null,
      updated_at text not null,
      started_at text,
      completed_at text,
      foreign key(project_id) references projects(id),
      foreign key(lane_id) references lanes(id)
    )
  `);
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_missions_project_updated on missions(project_id, updated_at)",
    "missions",
    ["project_id", "updated_at"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_missions_project_status on missions(project_id, status)",
    "missions",
    ["project_id", "status"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_missions_project_lane on missions(project_id, lane_id)",
    "missions",
    ["project_id", "lane_id"]
  );

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
      unique(mission_id, step_index),
      foreign key(mission_id) references missions(id),
      foreign key(project_id) references projects(id),
      foreign key(lane_id) references lanes(id)
    )
  `);
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_mission_steps_mission_index on mission_steps(mission_id, step_index)",
    "mission_steps",
    ["mission_id", "step_index"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_mission_steps_project_status on mission_steps(project_id, status)",
    "mission_steps",
    ["project_id", "status"]
  );

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
      foreign key(mission_id) references missions(id),
      foreign key(project_id) references projects(id)
    )
  `);
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_mission_events_mission_created on mission_events(mission_id, created_at)",
    "mission_events",
    ["mission_id", "created_at"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_mission_events_project_created on mission_events(project_id, created_at)",
    "mission_events",
    ["project_id", "created_at"]
  );

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
      foreign key(mission_id) references missions(id),
      foreign key(project_id) references projects(id),
      foreign key(lane_id) references lanes(id)
    )
  `);
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_mission_artifacts_mission_created on mission_artifacts(mission_id, created_at)",
    "mission_artifacts",
    ["mission_id", "created_at"]
  );

  db.run(`
    create table if not exists mission_interventions (
      id text primary key,
      mission_id text not null,
      project_id text not null,
      intervention_type text not null,
      status text not null,
      title text not null,
      body text not null,
      requested_action text,
      resolution_note text,
      lane_id text,
      metadata_json text,
      created_at text not null,
      updated_at text not null,
      resolved_at text,
      foreign key(mission_id) references missions(id),
      foreign key(project_id) references projects(id),
      foreign key(lane_id) references lanes(id)
    )
  `);
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_mission_interventions_mission_status on mission_interventions(mission_id, status)",
    "mission_interventions",
    ["mission_id", "status"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_mission_interventions_project_status on mission_interventions(project_id, status)",
    "mission_interventions",
    ["project_id", "status"]
  );

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
      foreign key(mission_id) references missions(id)
    )
  `);
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_runs_project_status on orchestrator_runs(project_id, status)",
    "orchestrator_runs",
    ["project_id", "status"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_runs_mission on orchestrator_runs(mission_id)",
    "orchestrator_runs",
    ["mission_id"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_runs_project_updated on orchestrator_runs(project_id, updated_at)",
    "orchestrator_runs",
    ["project_id", "updated_at"]
  );

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
      unique(run_id, step_key),
      foreign key(run_id) references orchestrator_runs(id),
      foreign key(project_id) references projects(id),
      foreign key(mission_step_id) references mission_steps(id),
      foreign key(lane_id) references lanes(id)
    )
  `);
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_steps_run_status on orchestrator_steps(run_id, status)",
    "orchestrator_steps",
    ["run_id", "status"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_steps_project_status on orchestrator_steps(project_id, status)",
    "orchestrator_steps",
    ["project_id", "status"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_steps_run_order on orchestrator_steps(run_id, step_index)",
    "orchestrator_steps",
    ["run_id", "step_index"]
  );

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
      unique(step_id, attempt_number),
      foreign key(run_id) references orchestrator_runs(id),
      foreign key(step_id) references orchestrator_steps(id),
      foreign key(project_id) references projects(id),
      foreign key(context_snapshot_id) references orchestrator_context_snapshots(id)
    )
  `);
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_attempts_run_status on orchestrator_attempts(run_id, status)",
    "orchestrator_attempts",
    ["run_id", "status"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_attempts_step_status on orchestrator_attempts(step_id, status)",
    "orchestrator_attempts",
    ["step_id", "status"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_attempts_project_created on orchestrator_attempts(project_id, created_at)",
    "orchestrator_attempts",
    ["project_id", "created_at"]
  );

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
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_attempt_runtime_session on orchestrator_attempt_runtime(session_id)",
    "orchestrator_attempt_runtime",
    ["session_id"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_attempt_runtime_updated on orchestrator_attempt_runtime(updated_at)",
    "orchestrator_attempt_runtime",
    ["updated_at"]
  );

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
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_runtime_events_run_occurred on orchestrator_runtime_events(run_id, occurred_at)",
    "orchestrator_runtime_events",
    ["run_id", "occurred_at"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_runtime_events_attempt_occurred on orchestrator_runtime_events(attempt_id, occurred_at)",
    "orchestrator_runtime_events",
    ["attempt_id", "occurred_at"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_runtime_events_session_occurred on orchestrator_runtime_events(session_id, occurred_at)",
    "orchestrator_runtime_events",
    ["session_id", "occurred_at"]
  );
  createIndexIfColumnsExist(
    db,
    "create unique index if not exists idx_orchestrator_runtime_events_project_key on orchestrator_runtime_events(project_id, event_key)",
    "orchestrator_runtime_events",
    ["project_id", "event_key"]
  );

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
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_claims_run_state on orchestrator_claims(run_id, state)",
    "orchestrator_claims",
    ["run_id", "state"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_claims_scope_state on orchestrator_claims(project_id, scope_kind, scope_value, state)",
    "orchestrator_claims",
    ["project_id", "scope_kind", "scope_value", "state"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_claims_expires on orchestrator_claims(state, expires_at)",
    "orchestrator_claims",
    ["state", "expires_at"]
  );
  db.run(
    "create unique index if not exists idx_orchestrator_claims_active_scope on orchestrator_claims(project_id, scope_kind, scope_value) where state = 'active'"
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
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_context_snapshots_run_created on orchestrator_context_snapshots(run_id, created_at)",
    "orchestrator_context_snapshots",
    ["run_id", "created_at"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_context_snapshots_attempt on orchestrator_context_snapshots(attempt_id)",
    "orchestrator_context_snapshots",
    ["attempt_id"]
  );

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
      foreign key(mission_id) references missions(id),
      foreign key(mission_step_id) references mission_steps(id),
      foreign key(run_id) references orchestrator_runs(id),
      foreign key(step_id) references orchestrator_steps(id),
      foreign key(attempt_id) references orchestrator_attempts(id)
    )
  `);
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_mission_step_handoffs_mission_created on mission_step_handoffs(mission_id, created_at)",
    "mission_step_handoffs",
    ["mission_id", "created_at"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_mission_step_handoffs_step_created on mission_step_handoffs(mission_step_id, created_at)",
    "mission_step_handoffs",
    ["mission_step_id", "created_at"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_mission_step_handoffs_attempt on mission_step_handoffs(attempt_id)",
    "mission_step_handoffs",
    ["attempt_id"]
  );

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
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_timeline_run_created on orchestrator_timeline_events(run_id, created_at)",
    "orchestrator_timeline_events",
    ["run_id", "created_at"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_timeline_attempt on orchestrator_timeline_events(attempt_id)",
    "orchestrator_timeline_events",
    ["attempt_id"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_timeline_project_created on orchestrator_timeline_events(project_id, created_at)",
    "orchestrator_timeline_events",
    ["project_id", "created_at"]
  );

  db.run(`
    create table if not exists orchestrator_gate_reports (
      id text primary key,
      project_id text not null,
      generated_at text not null,
      report_json text not null,
      foreign key(project_id) references projects(id)
    )
  `);
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_gate_reports_project_generated on orchestrator_gate_reports(project_id, generated_at)",
    "orchestrator_gate_reports",
    ["project_id", "generated_at"]
  );

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
      foreign key(mission_id) references missions(id),
      foreign key(run_id) references orchestrator_runs(id),
      foreign key(step_id) references orchestrator_steps(id),
      foreign key(attempt_id) references orchestrator_attempts(id),
      foreign key(lane_id) references lanes(id)
    )
  `);
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_chat_threads_mission_updated on orchestrator_chat_threads(mission_id, updated_at)",
    "orchestrator_chat_threads",
    ["mission_id", "updated_at"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_chat_threads_project_mission on orchestrator_chat_threads(project_id, mission_id)",
    "orchestrator_chat_threads",
    ["project_id", "mission_id"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_chat_threads_mission_type on orchestrator_chat_threads(mission_id, thread_type)",
    "orchestrator_chat_threads",
    ["mission_id", "thread_type"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_chat_threads_lane on orchestrator_chat_threads(lane_id)",
    "orchestrator_chat_threads",
    ["lane_id"]
  );

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
      foreign key(mission_id) references missions(id),
      foreign key(thread_id) references orchestrator_chat_threads(id),
      foreign key(attempt_id) references orchestrator_attempts(id),
      foreign key(lane_id) references lanes(id),
      foreign key(run_id) references orchestrator_runs(id)
    )
  `);
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_chat_messages_thread_ts on orchestrator_chat_messages(thread_id, timestamp)",
    "orchestrator_chat_messages",
    ["thread_id", "timestamp"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_chat_messages_mission_ts on orchestrator_chat_messages(mission_id, timestamp)",
    "orchestrator_chat_messages",
    ["mission_id", "timestamp"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_chat_messages_attempt_ts on orchestrator_chat_messages(attempt_id, timestamp)",
    "orchestrator_chat_messages",
    ["attempt_id", "timestamp"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_chat_messages_lane_ts on orchestrator_chat_messages(lane_id, timestamp)",
    "orchestrator_chat_messages",
    ["lane_id", "timestamp"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_chat_messages_delivery_queue on orchestrator_chat_messages(delivery_state, role, mission_id, thread_id, timestamp)",
    "orchestrator_chat_messages",
    ["delivery_state", "role", "mission_id", "thread_id", "timestamp"]
  );

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
      foreign key(mission_id) references missions(id),
      foreign key(run_id) references orchestrator_runs(id),
      foreign key(step_id) references orchestrator_steps(id),
      foreign key(attempt_id) references orchestrator_attempts(id),
      foreign key(lane_id) references lanes(id)
    )
  `);
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_worker_digests_mission_created on orchestrator_worker_digests(mission_id, created_at)",
    "orchestrator_worker_digests",
    ["mission_id", "created_at"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_worker_digests_run_created on orchestrator_worker_digests(run_id, created_at)",
    "orchestrator_worker_digests",
    ["run_id", "created_at"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_worker_digests_attempt on orchestrator_worker_digests(attempt_id)",
    "orchestrator_worker_digests",
    ["attempt_id"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_worker_digests_lane_created on orchestrator_worker_digests(lane_id, created_at)",
    "orchestrator_worker_digests",
    ["lane_id", "created_at"]
  );

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
      foreign key(mission_id) references missions(id),
      foreign key(run_id) references orchestrator_runs(id),
      foreign key(step_id) references orchestrator_steps(id),
      foreign key(attempt_id) references orchestrator_attempts(id)
    )
  `);
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_artifacts_mission_created on orchestrator_artifacts(mission_id, created_at)",
    "orchestrator_artifacts",
    ["mission_id", "created_at"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_artifacts_step on orchestrator_artifacts(step_id)",
    "orchestrator_artifacts",
    ["step_id"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_artifacts_mission_key on orchestrator_artifacts(mission_id, artifact_key)",
    "orchestrator_artifacts",
    ["mission_id", "artifact_key"]
  );

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
      foreign key(mission_id) references missions(id),
      foreign key(run_id) references orchestrator_runs(id)
    )
  `);
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_context_checkpoints_mission_created on orchestrator_context_checkpoints(mission_id, created_at)",
    "orchestrator_context_checkpoints",
    ["mission_id", "created_at"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_context_checkpoints_run_created on orchestrator_context_checkpoints(run_id, created_at)",
    "orchestrator_context_checkpoints",
    ["run_id", "created_at"]
  );

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
      foreign key(mission_id) references missions(id),
      foreign key(run_id) references orchestrator_runs(id),
      foreign key(step_id) references orchestrator_steps(id),
      foreign key(attempt_id) references orchestrator_attempts(id)
    )
  `);
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_worker_checkpoints_mission_step_key on orchestrator_worker_checkpoints(mission_id, step_key)",
    "orchestrator_worker_checkpoints",
    ["mission_id", "step_key"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_worker_checkpoints_run on orchestrator_worker_checkpoints(run_id)",
    "orchestrator_worker_checkpoints",
    ["run_id"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_worker_checkpoints_mission on orchestrator_worker_checkpoints(mission_id, updated_at)",
    "orchestrator_worker_checkpoints",
    ["mission_id", "updated_at"]
  );

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
      foreign key(mission_id) references missions(id),
      foreign key(run_id) references orchestrator_runs(id),
      foreign key(step_id) references orchestrator_steps(id),
      foreign key(lane_id) references lanes(id)
    )
  `);
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_lane_decisions_mission_created on orchestrator_lane_decisions(mission_id, created_at)",
    "orchestrator_lane_decisions",
    ["mission_id", "created_at"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_lane_decisions_run_created on orchestrator_lane_decisions(run_id, created_at)",
    "orchestrator_lane_decisions",
    ["run_id", "created_at"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_lane_decisions_step_created on orchestrator_lane_decisions(step_id, created_at)",
    "orchestrator_lane_decisions",
    ["step_id", "created_at"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_lane_decisions_lane_created on orchestrator_lane_decisions(lane_id, created_at)",
    "orchestrator_lane_decisions",
    ["lane_id", "created_at"]
  );

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
      foreign key(mission_id) references missions(id),
      foreign key(run_id) references orchestrator_runs(id),
      foreign key(step_id) references orchestrator_steps(id),
      foreign key(attempt_id) references orchestrator_attempts(id)
    )
  `);
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_ai_decisions_mission_created on orchestrator_ai_decisions(mission_id, created_at)",
    "orchestrator_ai_decisions",
    ["mission_id", "created_at"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_ai_decisions_run_created on orchestrator_ai_decisions(run_id, created_at)",
    "orchestrator_ai_decisions",
    ["run_id", "created_at"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_ai_decisions_step_created on orchestrator_ai_decisions(step_id, created_at)",
    "orchestrator_ai_decisions",
    ["step_id", "created_at"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_ai_decisions_project_category_created on orchestrator_ai_decisions(project_id, call_type, created_at)",
    "orchestrator_ai_decisions",
    ["project_id", "call_type", "created_at"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_ai_decisions_created on orchestrator_ai_decisions(created_at)",
    "orchestrator_ai_decisions",
    ["created_at"]
  );

  db.run(`
    create table if not exists mission_metrics_config (
      mission_id text primary key,
      project_id text not null,
      toggles_json text not null,
      updated_at text not null,
      foreign key(mission_id) references missions(id),
      foreign key(project_id) references projects(id)
    )
  `);
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_mission_metrics_config_project_updated on mission_metrics_config(project_id, updated_at)",
    "mission_metrics_config",
    ["project_id", "updated_at"]
  );

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
      foreign key(mission_id) references missions(id),
      foreign key(run_id) references orchestrator_runs(id),
      foreign key(attempt_id) references orchestrator_attempts(id)
    )
  `);
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_metrics_samples_mission_created on orchestrator_metrics_samples(mission_id, created_at)",
    "orchestrator_metrics_samples",
    ["mission_id", "created_at"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_metrics_samples_run_created on orchestrator_metrics_samples(run_id, created_at)",
    "orchestrator_metrics_samples",
    ["run_id", "created_at"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_metrics_samples_metric_created on orchestrator_metrics_samples(metric, created_at)",
    "orchestrator_metrics_samples",
    ["metric", "created_at"]
  );

  // Legacy compatibility hardening for orchestrator tables created before recent schema expansions.
  addColumnIfMissing(db, "orchestrator_runs", "context_profile text not null default 'orchestrator_deterministic_v1'", "context_profile");
  addColumnIfMissing(db, "orchestrator_runs", "scheduler_state text not null default 'queued'", "scheduler_state");
  addColumnIfMissing(db, "orchestrator_runs", "runtime_cursor_json text", "runtime_cursor_json");
  addColumnIfMissing(db, "orchestrator_runs", "last_error text", "last_error");
  addColumnIfMissing(db, "orchestrator_runs", "metadata_json text", "metadata_json");
  addColumnIfMissing(db, "orchestrator_runs", "started_at text", "started_at");
  addColumnIfMissing(db, "orchestrator_runs", "completed_at text", "completed_at");

  addColumnIfMissing(db, "orchestrator_steps", "mission_step_id text", "mission_step_id");
  addColumnIfMissing(db, "orchestrator_steps", "join_policy text not null default 'all_success'", "join_policy");
  addColumnIfMissing(db, "orchestrator_steps", "quorum_count integer", "quorum_count");
  addColumnIfMissing(db, "orchestrator_steps", "dependency_step_ids_json text not null default '[]'", "dependency_step_ids_json");
  addColumnIfMissing(db, "orchestrator_steps", "retry_limit integer not null default 0", "retry_limit");
  addColumnIfMissing(db, "orchestrator_steps", "retry_count integer not null default 0", "retry_count");
  addColumnIfMissing(db, "orchestrator_steps", "last_attempt_id text", "last_attempt_id");
  addColumnIfMissing(db, "orchestrator_steps", "policy_json text", "policy_json");
  addColumnIfMissing(db, "orchestrator_steps", "metadata_json text", "metadata_json");
  addColumnIfMissing(db, "orchestrator_steps", "started_at text", "started_at");
  addColumnIfMissing(db, "orchestrator_steps", "completed_at text", "completed_at");

  addColumnIfMissing(db, "orchestrator_attempts", "executor_session_id text", "executor_session_id");
  addColumnIfMissing(db, "orchestrator_attempts", "tracked_session_enforced integer not null default 1", "tracked_session_enforced");
  addColumnIfMissing(db, "orchestrator_attempts", "context_profile text not null default 'orchestrator_deterministic_v1'", "context_profile");
  addColumnIfMissing(db, "orchestrator_attempts", "context_snapshot_id text", "context_snapshot_id");
  addColumnIfMissing(db, "orchestrator_attempts", "error_class text not null default 'none'", "error_class");
  addColumnIfMissing(db, "orchestrator_attempts", "error_message text", "error_message");
  addColumnIfMissing(db, "orchestrator_attempts", "retry_backoff_ms integer not null default 0", "retry_backoff_ms");
  addColumnIfMissing(db, "orchestrator_attempts", "result_envelope_json text", "result_envelope_json");
  addColumnIfMissing(db, "orchestrator_attempts", "metadata_json text", "metadata_json");
  addColumnIfMissing(db, "orchestrator_attempts", "started_at text", "started_at");
  addColumnIfMissing(db, "orchestrator_attempts", "completed_at text", "completed_at");

  addColumnIfMissing(db, "orchestrator_attempt_runtime", "session_id text", "session_id");
  addColumnIfMissing(db, "orchestrator_attempt_runtime", "runtime_state text", "runtime_state");
  addColumnIfMissing(db, "orchestrator_attempt_runtime", "last_signal_at text", "last_signal_at");
  addColumnIfMissing(db, "orchestrator_attempt_runtime", "last_output_preview text", "last_output_preview");
  addColumnIfMissing(db, "orchestrator_attempt_runtime", "last_preview_digest text", "last_preview_digest");
  addColumnIfMissing(db, "orchestrator_attempt_runtime", "digest_since_ms integer not null default 0", "digest_since_ms");
  addColumnIfMissing(db, "orchestrator_attempt_runtime", "repeat_count integer not null default 0", "repeat_count");
  addColumnIfMissing(db, "orchestrator_attempt_runtime", "last_waiting_intervention_at_ms integer not null default 0", "last_waiting_intervention_at_ms");
  addColumnIfMissing(db, "orchestrator_attempt_runtime", "last_event_heartbeat_at_ms integer not null default 0", "last_event_heartbeat_at_ms");
  addColumnIfMissing(db, "orchestrator_attempt_runtime", "last_waiting_notified_at_ms integer not null default 0", "last_waiting_notified_at_ms");
  addColumnIfMissing(db, "orchestrator_attempt_runtime", "updated_at text not null default ''", "updated_at");

  addColumnIfMissing(db, "orchestrator_runtime_events", "step_id text", "step_id");
  addColumnIfMissing(db, "orchestrator_runtime_events", "attempt_id text", "attempt_id");
  addColumnIfMissing(db, "orchestrator_runtime_events", "session_id text", "session_id");
  addColumnIfMissing(db, "orchestrator_runtime_events", "event_key text", "event_key");
  addColumnIfMissing(db, "orchestrator_runtime_events", "occurred_at text", "occurred_at");
  addColumnIfMissing(db, "orchestrator_runtime_events", "payload_json text", "payload_json");
  addColumnIfMissing(db, "orchestrator_runtime_events", "created_at text", "created_at");
  createIndexIfColumnsExist(
    db,
    "create unique index if not exists idx_orchestrator_runtime_events_project_key on orchestrator_runtime_events(project_id, event_key)",
    "orchestrator_runtime_events",
    ["project_id", "event_key"]
  );

  addColumnIfMissing(db, "orchestrator_claims", "step_id text", "step_id");
  addColumnIfMissing(db, "orchestrator_claims", "attempt_id text", "attempt_id");
  addColumnIfMissing(db, "orchestrator_claims", "released_at text", "released_at");
  addColumnIfMissing(db, "orchestrator_claims", "policy_json text", "policy_json");
  addColumnIfMissing(db, "orchestrator_claims", "metadata_json text", "metadata_json");

  addColumnIfMissing(db, "orchestrator_context_snapshots", "step_id text", "step_id");
  addColumnIfMissing(db, "orchestrator_context_snapshots", "attempt_id text", "attempt_id");
  addColumnIfMissing(db, "orchestrator_context_snapshots", "context_profile text not null default 'orchestrator_deterministic_v1'", "context_profile");
  addColumnIfMissing(db, "orchestrator_context_snapshots", "cursor_json text not null default '{}'", "cursor_json");

  addColumnIfMissing(db, "orchestrator_timeline_events", "step_id text", "step_id");
  addColumnIfMissing(db, "orchestrator_timeline_events", "attempt_id text", "attempt_id");
  addColumnIfMissing(db, "orchestrator_timeline_events", "claim_id text", "claim_id");
  addColumnIfMissing(db, "orchestrator_timeline_events", "detail_json text", "detail_json");

  addColumnIfMissing(db, "orchestrator_chat_threads", "run_id text", "run_id");
  addColumnIfMissing(db, "orchestrator_chat_threads", "step_id text", "step_id");
  addColumnIfMissing(db, "orchestrator_chat_threads", "step_key text", "step_key");
  addColumnIfMissing(db, "orchestrator_chat_threads", "attempt_id text", "attempt_id");
  addColumnIfMissing(db, "orchestrator_chat_threads", "session_id text", "session_id");
  addColumnIfMissing(db, "orchestrator_chat_threads", "lane_id text", "lane_id");
  addColumnIfMissing(db, "orchestrator_chat_threads", "status text not null default 'active'", "status");
  addColumnIfMissing(db, "orchestrator_chat_threads", "unread_count integer not null default 0", "unread_count");
  addColumnIfMissing(db, "orchestrator_chat_threads", "metadata_json text", "metadata_json");
  addColumnIfMissing(db, "orchestrator_chat_threads", "updated_at text not null default ''", "updated_at");

  addColumnIfMissing(db, "orchestrator_chat_messages", "step_key text", "step_key");
  addColumnIfMissing(db, "orchestrator_chat_messages", "target_json text", "target_json");
  addColumnIfMissing(db, "orchestrator_chat_messages", "visibility text not null default 'full'", "visibility");
  addColumnIfMissing(db, "orchestrator_chat_messages", "delivery_state text not null default 'delivered'", "delivery_state");
  addColumnIfMissing(db, "orchestrator_chat_messages", "source_session_id text", "source_session_id");
  addColumnIfMissing(db, "orchestrator_chat_messages", "attempt_id text", "attempt_id");
  addColumnIfMissing(db, "orchestrator_chat_messages", "lane_id text", "lane_id");
  addColumnIfMissing(db, "orchestrator_chat_messages", "run_id text", "run_id");
  addColumnIfMissing(db, "orchestrator_chat_messages", "metadata_json text", "metadata_json");
  addColumnIfMissing(db, "orchestrator_chat_messages", "created_at text not null default ''", "created_at");

  addColumnIfMissing(db, "orchestrator_worker_digests", "step_key text", "step_key");
  addColumnIfMissing(db, "orchestrator_worker_digests", "lane_id text", "lane_id");
  addColumnIfMissing(db, "orchestrator_worker_digests", "session_id text", "session_id");
  addColumnIfMissing(db, "orchestrator_worker_digests", "tokens_json text", "tokens_json");
  addColumnIfMissing(db, "orchestrator_worker_digests", "cost_usd real", "cost_usd");
  addColumnIfMissing(db, "orchestrator_worker_digests", "suggested_next_actions_json text not null default '[]'", "suggested_next_actions_json");

  addColumnIfMissing(db, "orchestrator_context_checkpoints", "run_id text", "run_id");
  addColumnIfMissing(db, "orchestrator_lane_decisions", "run_id text", "run_id");
  addColumnIfMissing(db, "orchestrator_lane_decisions", "step_id text", "step_id");
  addColumnIfMissing(db, "orchestrator_lane_decisions", "step_key text", "step_key");
  addColumnIfMissing(db, "orchestrator_lane_decisions", "lane_id text", "lane_id");
  addColumnIfMissing(db, "orchestrator_lane_decisions", "metadata_json text", "metadata_json");

  addColumnIfMissing(db, "orchestrator_ai_decisions", "project_id text not null default ''", "project_id");
  addColumnIfMissing(db, "orchestrator_ai_decisions", "mission_id text not null default ''", "mission_id");
  addColumnIfMissing(db, "orchestrator_ai_decisions", "run_id text", "run_id");
  addColumnIfMissing(db, "orchestrator_ai_decisions", "step_id text", "step_id");
  addColumnIfMissing(db, "orchestrator_ai_decisions", "attempt_id text", "attempt_id");
  addColumnIfMissing(db, "orchestrator_ai_decisions", "call_type text not null default 'unknown'", "call_type");
  addColumnIfMissing(db, "orchestrator_ai_decisions", "provider text", "provider");
  addColumnIfMissing(db, "orchestrator_ai_decisions", "model text", "model");
  addColumnIfMissing(db, "orchestrator_ai_decisions", "timeout_cap_ms integer", "timeout_cap_ms");
  addColumnIfMissing(db, "orchestrator_ai_decisions", "decision_json text not null default '{}'", "decision_json");
  addColumnIfMissing(db, "orchestrator_ai_decisions", "action_trace_json text", "action_trace_json");
  addColumnIfMissing(db, "orchestrator_ai_decisions", "validation_json text", "validation_json");
  addColumnIfMissing(db, "orchestrator_ai_decisions", "rationale text", "rationale");
  addColumnIfMissing(db, "orchestrator_ai_decisions", "fallback_used integer not null default 0", "fallback_used");
  addColumnIfMissing(db, "orchestrator_ai_decisions", "failure_reason text", "failure_reason");
  addColumnIfMissing(db, "orchestrator_ai_decisions", "duration_ms integer", "duration_ms");
  addColumnIfMissing(db, "orchestrator_ai_decisions", "prompt_tokens integer", "prompt_tokens");
  addColumnIfMissing(db, "orchestrator_ai_decisions", "completion_tokens integer", "completion_tokens");
  addColumnIfMissing(db, "orchestrator_ai_decisions", "created_at text not null default ''", "created_at");
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_ai_decisions_mission_created on orchestrator_ai_decisions(mission_id, created_at)",
    "orchestrator_ai_decisions",
    ["mission_id", "created_at"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_ai_decisions_run_created on orchestrator_ai_decisions(run_id, created_at)",
    "orchestrator_ai_decisions",
    ["run_id", "created_at"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_ai_decisions_step_created on orchestrator_ai_decisions(step_id, created_at)",
    "orchestrator_ai_decisions",
    ["step_id", "created_at"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_ai_decisions_project_category_created on orchestrator_ai_decisions(project_id, call_type, created_at)",
    "orchestrator_ai_decisions",
    ["project_id", "call_type", "created_at"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_ai_decisions_created on orchestrator_ai_decisions(created_at)",
    "orchestrator_ai_decisions",
    ["created_at"]
  );

  addColumnIfMissing(db, "mission_metrics_config", "project_id text", "project_id");
  addColumnIfMissing(db, "orchestrator_metrics_samples", "run_id text", "run_id");
  addColumnIfMissing(db, "orchestrator_metrics_samples", "attempt_id text", "attempt_id");
  addColumnIfMissing(db, "orchestrator_metrics_samples", "unit text", "unit");
  addColumnIfMissing(db, "orchestrator_metrics_samples", "metadata_json text", "metadata_json");

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
      created_at text not null,
      last_accessed_at text not null,
      access_count integer default 0
    )
  `);
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_memories_project_scope on memories(project_id, scope)",
    "memories",
    ["project_id", "scope"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_memories_project_importance on memories(project_id, importance)",
    "memories",
    ["project_id", "importance"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_memories_last_accessed on memories(last_accessed_at)",
    "memories",
    ["last_accessed_at"]
  );

  // WS7 Memory promotion flow: add status, agent_id, confidence, promoted_at, source_run_id columns.
  addColumnIfMissing(db, "memories", "status text default 'promoted'", "status");
  addColumnIfMissing(db, "memories", "agent_id text", "agent_id");
  addColumnIfMissing(db, "memories", "confidence real default 1.0", "confidence");
  addColumnIfMissing(db, "memories", "promoted_at text", "promoted_at");
  addColumnIfMissing(db, "memories", "source_run_id text", "source_run_id");
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_memories_status on memories(project_id, status)",
    "memories",
    ["project_id", "status"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_memories_agent on memories(agent_id)",
    "memories",
    ["agent_id"]
  );

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
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_agent_identities_project on agent_identities(project_id)",
    "agent_identities",
    ["project_id"]
  );

  db.run(`
    create table if not exists orchestrator_shared_facts (
      id text primary key,
      run_id text not null,
      step_id text,
      fact_type text not null,
      content text not null,
      created_at text not null
    )
  `);
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_shared_facts_run on orchestrator_shared_facts(run_id)",
    "orchestrator_shared_facts",
    ["run_id"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_orchestrator_shared_facts_run_type on orchestrator_shared_facts(run_id, fact_type)",
    "orchestrator_shared_facts",
    ["run_id", "fact_type"]
  );

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
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_attempt_transcripts_attempt on attempt_transcripts(attempt_id)",
    "attempt_transcripts",
    ["attempt_id"]
  );
  createIndexIfColumnsExist(
    db,
    "create index if not exists idx_attempt_transcripts_run on attempt_transcripts(run_id)",
    "attempt_transcripts",
    ["run_id"]
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
  db.run("pragma foreign_keys = on");

  let dirty = false;
  let flushTimer: NodeJS.Timeout | null = null;

  const flushNow = () => {
    if (!dirty) return;
    let tempPath: string | null = null;
    try {
      const bytes = db.export();
      ensureParentDir(dbPath);
      const dbDir = path.dirname(dbPath);
      const dbBase = path.basename(dbPath);
      tempPath = path.join(dbDir, `.${dbBase}.${process.pid}.${Date.now()}.tmp`);
      fs.writeFileSync(tempPath, Buffer.from(bytes));
      const tempFd = fs.openSync(tempPath, "r");
      try {
        fs.fsyncSync(tempFd);
      } finally {
        fs.closeSync(tempFd);
      }
      fs.renameSync(tempPath, dbPath);
      try {
        const dirFd = fs.openSync(dbDir, "r");
        try {
          fs.fsyncSync(dirFd);
        } finally {
          fs.closeSync(dirFd);
        }
      } catch {
        // Best-effort directory sync; unsupported platforms/filesystems can skip.
      }
      dirty = false;
    } catch (err) {
      if (tempPath && fs.existsSync(tempPath)) {
        try {
          fs.unlinkSync(tempPath);
        } catch {
          // best effort cleanup
        }
      }
      logger.error("db.flush_failed", { dbPath, err: String(err) });
    }
  };

  const scheduleFlush = () => {
    dirty = true;
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flushNow, FLUSH_DEBOUNCE_MS);
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
