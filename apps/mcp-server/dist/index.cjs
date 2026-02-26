"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/index.ts
var import_node_path15 = __toESM(require("path"), 1);

// src/bootstrap.ts
var import_node_fs13 = __toESM(require("fs"), 1);
var import_node_path13 = __toESM(require("path"), 1);
var nodePty = __toESM(require("node-pty"), 1);

// ../desktop/src/main/services/logging/logger.ts
var import_node_fs = __toESM(require("fs"), 1);
var import_node_path = __toESM(require("path"), 1);
var LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3
};
var MAX_LOG_FILE_BYTES = 10 * 1024 * 1024;
var ROTATION_CHECK_WRITE_INTERVAL = 1e3;
var ROTATION_CHECK_INTERVAL_MS = 6e4;
var FLUSH_INTERVAL_MS = 500;
var FLUSH_BATCH_SIZE = 100;
function resolveMinLevel() {
  const value = process.env.ADE_LOG_LEVEL?.trim().toLowerCase();
  if (value === "debug" || value === "info" || value === "warn" || value === "error") {
    return LOG_LEVELS[value];
  }
  return LOG_LEVELS.info;
}
function getRotatedLogFilePath(logFilePath) {
  const parsed = import_node_path.default.parse(logFilePath);
  return import_node_path.default.join(parsed.dir, `${parsed.name}.1${parsed.ext}`);
}
function createConsoleMirror(level, event, meta) {
  if (!process.env.VITE_DEV_SERVER_URL) return;
  const fn = level === "error" ? console.error : level === "warn" ? console.warn : level === "debug" ? console.debug : console.log;
  fn(`[${level}] ${event}`, meta ?? "");
}
function createFileLogger(logFilePath) {
  const minLevel = resolveMinLevel();
  const logDir = import_node_path.default.dirname(logFilePath);
  const rotatedLogFilePath = getRotatedLogFilePath(logFilePath);
  let writesSinceRotateCheck = 0;
  let lastRotateCheckAt = Date.now();
  let estimatedFileSize = null;
  let queuedLines = [];
  let flushTimer = null;
  let flushInProgress = false;
  let flushRequested = false;
  const shouldCheckRotation = () => {
    if (writesSinceRotateCheck >= ROTATION_CHECK_WRITE_INTERVAL) return true;
    return Date.now() - lastRotateCheckAt >= ROTATION_CHECK_INTERVAL_MS;
  };
  const refreshEstimatedFileSizeIfNeeded = async () => {
    if (estimatedFileSize != null && !shouldCheckRotation()) return;
    writesSinceRotateCheck = 0;
    lastRotateCheckAt = Date.now();
    try {
      const stat = await import_node_fs.default.promises.stat(logFilePath);
      estimatedFileSize = stat.size;
    } catch (err) {
      if (err.code === "ENOENT") {
        estimatedFileSize = 0;
        return;
      }
      throw err;
    }
  };
  const rotateIfNeeded = async (upcomingWriteBytes) => {
    await refreshEstimatedFileSizeIfNeeded();
    const currentFileSize = estimatedFileSize ?? 0;
    if (currentFileSize < MAX_LOG_FILE_BYTES && currentFileSize + upcomingWriteBytes <= MAX_LOG_FILE_BYTES) return;
    try {
      await import_node_fs.default.promises.unlink(rotatedLogFilePath);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    try {
      await import_node_fs.default.promises.rename(logFilePath, rotatedLogFilePath);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
    await import_node_fs.default.promises.writeFile(logFilePath, "", "utf8");
    estimatedFileSize = 0;
  };
  const flush = async () => {
    if (flushInProgress) {
      flushRequested = true;
      return;
    }
    if (queuedLines.length === 0) return;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    const lines = queuedLines.splice(0, FLUSH_BATCH_SIZE);
    const payload = lines.join("");
    const bytes = Buffer.byteLength(payload, "utf8");
    flushInProgress = true;
    try {
      await import_node_fs.default.promises.mkdir(logDir, { recursive: true });
      await rotateIfNeeded(bytes);
      await import_node_fs.default.promises.appendFile(logFilePath, payload, "utf8");
      estimatedFileSize = (estimatedFileSize ?? 0) + bytes;
    } catch {
    } finally {
      flushInProgress = false;
      if (flushRequested || queuedLines.length > 0) {
        flushRequested = false;
        void flush();
      }
    }
  };
  const scheduleFlush = () => {
    if (queuedLines.length >= FLUSH_BATCH_SIZE) {
      void flush();
      return;
    }
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, FLUSH_INTERVAL_MS);
  };
  const writeLine = (level, event, meta) => {
    if (LOG_LEVELS[level] < minLevel) return;
    const line = JSON.stringify({
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      level,
      event,
      ...meta ? { meta } : {}
    });
    const payload = `${line}
`;
    queuedLines.push(payload);
    writesSinceRotateCheck += 1;
    scheduleFlush();
    createConsoleMirror(level, event, meta);
  };
  return {
    debug: (event, meta) => writeLine("debug", event, meta),
    info: (event, meta) => writeLine("info", event, meta),
    warn: (event, meta) => writeLine("warn", event, meta),
    error: (event, meta) => writeLine("error", event, meta)
  };
}

// ../desktop/src/main/services/state/kvDb.ts
var import_node_fs2 = __toESM(require("fs"), 1);
var import_node_path2 = __toESM(require("path"), 1);
var import_node_module = require("module");
var import_sql = __toESM(require("sql.js"), 1);
var require2 = (0, import_node_module.createRequire)(__filename);
var FLUSH_DEBOUNCE_MS = 500;
function resolveSqlJsWasmDir() {
  const wasmPath = require2.resolve("sql.js/dist/sql-wasm.wasm");
  return import_node_path2.default.dirname(wasmPath);
}
function ensureParentDir(filePath) {
  import_node_fs2.default.mkdirSync(import_node_path2.default.dirname(filePath), { recursive: true });
}
function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function mapExecRows(rows) {
  const first = rows[0];
  if (!first) return [];
  const { columns, values } = first;
  const out = [];
  for (const row of values) {
    const obj = {};
    for (let i = 0; i < columns.length; i++) {
      obj[columns[i] ?? String(i)] = row[i];
    }
    out.push(obj);
  }
  return out;
}
function hasColumn(db, table, column) {
  try {
    const rows = db.exec(`pragma table_info(${table})`);
    const mapped = mapExecRows(rows);
    return mapped.some((row) => String(row.name ?? "") === column);
  } catch {
    return false;
  }
}
function addColumnIfMissing(db, table, columnSql, columnName) {
  if (hasColumn(db, table, columnName)) return;
  db.run(`alter table ${table} add column ${columnSql}`);
}
function createIndexIfColumnsExist(db, indexSql, table, columns) {
  const allPresent = columns.every((column) => hasColumn(db, table, column));
  if (!allPresent) return;
  db.run(indexSql);
}
function ensureProcessRuntimeLaneSchema(db) {
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
function migrate(db) {
  db.run("create table if not exists kv (key text primary key, value text not null)");
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
  addColumnIfMissing(db, "pr_groups", "name text", "name");
  addColumnIfMissing(db, "pr_groups", "auto_rebase integer not null default 0", "auto_rebase");
  addColumnIfMissing(db, "pr_groups", "ci_gating integer not null default 0", "ci_gating");
  addColumnIfMissing(db, "pr_groups", "target_branch text", "target_branch");
  db.run(`update pr_groups set group_type = 'queue' where group_type = 'stacked'`);
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
async function openKvDb(dbPath, logger) {
  const wasmDir = resolveSqlJsWasmDir();
  let SQL;
  try {
    SQL = await (0, import_sql.default)({
      locateFile: (file) => import_node_path2.default.join(wasmDir, file)
    });
  } catch (err) {
    logger.error("db.init_failed", { dbPath, err: String(err) });
    throw err;
  }
  ensureParentDir(dbPath);
  const data = import_node_fs2.default.existsSync(dbPath) ? import_node_fs2.default.readFileSync(dbPath) : null;
  const db = new SQL.Database(data);
  migrate(db);
  db.run("pragma foreign_keys = on");
  let dirty = false;
  let flushTimer = null;
  const flushNow = () => {
    if (!dirty) return;
    let tempPath = null;
    try {
      const bytes = db.export();
      ensureParentDir(dbPath);
      const dbDir = import_node_path2.default.dirname(dbPath);
      const dbBase = import_node_path2.default.basename(dbPath);
      tempPath = import_node_path2.default.join(dbDir, `.${dbBase}.${process.pid}.${Date.now()}.tmp`);
      import_node_fs2.default.writeFileSync(tempPath, Buffer.from(bytes));
      const tempFd = import_node_fs2.default.openSync(tempPath, "r");
      try {
        import_node_fs2.default.fsyncSync(tempFd);
      } finally {
        import_node_fs2.default.closeSync(tempFd);
      }
      import_node_fs2.default.renameSync(tempPath, dbPath);
      try {
        const dirFd = import_node_fs2.default.openSync(dbDir, "r");
        try {
          import_node_fs2.default.fsyncSync(dirFd);
        } finally {
          import_node_fs2.default.closeSync(dirFd);
        }
      } catch {
      }
      dirty = false;
    } catch (err) {
      if (tempPath && import_node_fs2.default.existsSync(tempPath)) {
        try {
          import_node_fs2.default.unlinkSync(tempPath);
        } catch {
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
  const getString = (key) => {
    const rows = db.exec("select value from kv where key = ? limit 1", [key]);
    const first = rows[0]?.values?.[0]?.[0];
    return typeof first === "string" ? first : first == null ? null : String(first);
  };
  const setString = (key, value) => {
    db.run(
      "insert into kv(key, value) values (?, ?) on conflict(key) do update set value=excluded.value",
      [key, value]
    );
    scheduleFlush();
  };
  const run = (sql, params = []) => {
    db.run(sql, params);
    scheduleFlush();
  };
  const all = (sql, params = []) => {
    const rows = db.exec(sql, params);
    return mapExecRows(rows);
  };
  const get = (sql, params = []) => {
    const rows = all(sql, params);
    return rows[0] ?? null;
  };
  return {
    getJson: (key) => {
      const raw = getString(key);
      if (raw == null) return null;
      return safeJsonParse(raw);
    },
    setJson: (key, value) => {
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

// ../desktop/src/main/services/projects/projectService.ts
var import_node_fs3 = __toESM(require("fs"), 1);
var import_node_path3 = __toESM(require("path"), 1);
var import_node_crypto = require("crypto");

// ../desktop/src/main/services/git/git.ts
var import_node_child_process = require("child_process");
var DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
function appendChunkWithCap(args) {
  const { current, chunk, currentBytes, maxBytes } = args;
  if (maxBytes <= 0 || currentBytes >= maxBytes) {
    return { text: current, bytes: currentBytes, truncated: true };
  }
  const remaining = maxBytes - currentBytes;
  if (chunk.length <= remaining) {
    return {
      text: current + chunk.toString("utf8"),
      bytes: currentBytes + chunk.length,
      truncated: false
    };
  }
  return {
    text: current + chunk.subarray(0, remaining).toString("utf8"),
    bytes: maxBytes,
    truncated: true
  };
}
async function runGit(args, opts) {
  const timeoutMs = opts.timeoutMs ?? 3e4;
  const maxOutputBytes = Number.isFinite(opts.maxOutputBytes) ? Math.max(0, Math.floor(opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES)) : DEFAULT_MAX_OUTPUT_BYTES;
  return await new Promise((resolve) => {
    const child = (0, import_node_child_process.spawn)("git", args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env ?? {} },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let settled = false;
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(onTimeout);
      resolve(result);
    };
    const onTimeout = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
      }
      finish({
        exitCode: 124,
        stdout,
        stderr: stderr.length ? stderr : "git timed out",
        timedOut: true,
        stdoutTruncated,
        stderrTruncated
      });
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      if (stdoutTruncated) return;
      const chunk = Buffer.isBuffer(d) ? d : Buffer.from(String(d), "utf8");
      const next = appendChunkWithCap({
        current: stdout,
        chunk,
        currentBytes: stdoutBytes,
        maxBytes: maxOutputBytes
      });
      stdout = next.text;
      stdoutBytes = next.bytes;
      stdoutTruncated = next.truncated;
    });
    child.stderr.on("data", (d) => {
      if (stderrTruncated) return;
      const chunk = Buffer.isBuffer(d) ? d : Buffer.from(String(d), "utf8");
      const next = appendChunkWithCap({
        current: stderr,
        chunk,
        currentBytes: stderrBytes,
        maxBytes: maxOutputBytes
      });
      stderr = next.text;
      stderrBytes = next.bytes;
      stderrTruncated = next.truncated;
    });
    child.on("error", (error) => {
      finish({
        exitCode: 1,
        stdout,
        stderr: stderr.length ? stderr : error.message,
        stdoutTruncated,
        stderrTruncated
      });
    });
    child.on("close", (code) => {
      finish({
        exitCode: code ?? 1,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated
      });
    });
  });
}
async function runGitOrThrow(args, opts) {
  const res = await runGit(args, opts);
  if (res.exitCode !== 0) {
    const msg = res.stderr.trim() || res.stdout.trim() || `git ${args.join(" ")} failed`;
    throw new Error(msg);
  }
  return res.stdout;
}
function normalizeConflictType(raw) {
  const value = raw.trim().toLowerCase();
  if (value.includes("rename")) return "rename";
  if (value.includes("delete")) return "delete";
  if (value.includes("add")) return "add";
  return "content";
}
function parseMergeTreeConflicts(output) {
  const lines = output.split(/\r?\n/);
  const byPath = /* @__PURE__ */ new Map();
  const addConflict = (path16, type, markerPreview) => {
    const clean = path16.trim();
    if (!clean.length) return;
    if (byPath.has(clean)) return;
    byPath.set(clean, { path: clean, conflictType: type, markerPreview });
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const conflictMatch = line.match(/^CONFLICT \(([^)]+)\): .* in (.+)$/);
    if (conflictMatch) {
      const type = normalizeConflictType(conflictMatch[1] ?? "");
      const path16 = (conflictMatch[2] ?? "").trim();
      const markerPreview = [lines[i], lines[i + 1], lines[i + 2]].filter(Boolean).join("\n");
      addConflict(path16, type, markerPreview);
      continue;
    }
    const autoMergingMatch = line.match(/^Auto-merging (.+)$/);
    if (autoMergingMatch && (lines[i + 1] ?? "").startsWith("CONFLICT")) {
      const next = lines[i + 1] ?? "";
      const typeMatch = next.match(/^CONFLICT \(([^)]+)\):/);
      const type = normalizeConflictType(typeMatch?.[1] ?? "");
      const path16 = (autoMergingMatch[1] ?? "").trim();
      const markerPreview = [line, next, lines[i + 2]].filter(Boolean).join("\n");
      addConflict(path16, type, markerPreview);
    }
  }
  return Array.from(byPath.values());
}
function shouldFallbackFromWriteTree(stderr) {
  const text = stderr.toLowerCase();
  return text.includes("unable to create temporary file") || text.includes("failure to merge") || text.includes("unknown option") || text.includes("usage: git merge-tree");
}
async function runGitMergeTree(args) {
  const timeoutMs = args.timeoutMs ?? 45e3;
  const writeTreeCmd = [
    "merge-tree",
    "--write-tree",
    "--messages",
    "--merge-base",
    args.mergeBase,
    args.branchA,
    args.branchB
  ];
  const writeTree = await runGit(writeTreeCmd, { cwd: args.cwd, timeoutMs });
  if (!(writeTree.exitCode !== 0 && shouldFallbackFromWriteTree(writeTree.stderr))) {
    const combined2 = `${writeTree.stdout}
${writeTree.stderr}`;
    return {
      ...writeTree,
      mergeBase: args.mergeBase,
      branchA: args.branchA,
      branchB: args.branchB,
      conflicts: parseMergeTreeConflicts(combined2),
      usedWriteTree: true
    };
  }
  const fallbackCmd = ["merge-tree", args.mergeBase, args.branchA, args.branchB];
  const fallback = await runGit(fallbackCmd, { cwd: args.cwd, timeoutMs });
  const combined = `${fallback.stdout}
${fallback.stderr}`;
  return {
    ...fallback,
    mergeBase: args.mergeBase,
    branchA: args.branchA,
    branchB: args.branchB,
    conflicts: parseMergeTreeConflicts(combined),
    usedWriteTree: false
  };
}

// ../desktop/src/main/services/projects/projectService.ts
async function detectDefaultBaseRef(repoRoot) {
  const originHead = await runGit(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], { cwd: repoRoot, timeoutMs: 6e3 });
  if (originHead.exitCode === 0) {
    const ref = originHead.stdout.trim();
    const m = ref.match(/refs\/remotes\/origin\/(.+)$/);
    if (m?.[1]) return m[1];
  }
  const head = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoRoot, timeoutMs: 6e3 });
  if (head.exitCode === 0) {
    const name = head.stdout.trim();
    if (name && name !== "HEAD") return name;
  }
  return "main";
}
function upsertProjectRow({
  db,
  repoRoot,
  displayName,
  baseRef
}) {
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const existing = db.get("select id from projects where root_path = ? limit 1", [repoRoot]);
  const id = existing?.id ?? (0, import_node_crypto.randomUUID)();
  if (existing?.id) {
    db.run("update projects set display_name = ?, default_base_ref = ?, last_opened_at = ? where id = ?", [
      displayName,
      baseRef,
      now,
      id
    ]);
  } else {
    db.run(
      "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
      [id, repoRoot, displayName, baseRef, now, now]
    );
  }
  return { projectId: id };
}
function toProjectInfo(repoRoot, baseRef) {
  return { rootPath: repoRoot, displayName: import_node_path3.default.basename(repoRoot), baseRef };
}

// ../desktop/src/main/services/history/operationService.ts
var import_node_crypto2 = require("crypto");
function safeParseMetadata(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}
function toJson(value) {
  return JSON.stringify(value);
}
function createOperationService({
  db,
  projectId
}) {
  const nowIso3 = () => (/* @__PURE__ */ new Date()).toISOString();
  const start = (args) => {
    const operationId = (0, import_node_crypto2.randomUUID)();
    const startedAt = nowIso3();
    const metadata = args.metadata ?? {};
    db.run(
      `
        insert into operations(
          id,
          project_id,
          lane_id,
          kind,
          started_at,
          ended_at,
          status,
          pre_head_sha,
          post_head_sha,
          metadata_json
        ) values(?, ?, ?, ?, ?, null, 'running', ?, null, ?)
      `,
      [operationId, projectId, args.laneId ?? null, args.kind, startedAt, args.preHeadSha ?? null, toJson(metadata)]
    );
    return { operationId, startedAt };
  };
  const finish = (args) => {
    const endedAt = nowIso3();
    const existing = db.get(
      "select metadata_json from operations where id = ? and project_id = ? limit 1",
      [args.operationId, projectId]
    );
    const mergedMetadata = {
      ...safeParseMetadata(existing?.metadata_json),
      ...args.metadataPatch ?? {}
    };
    db.run(
      `
        update operations
        set ended_at = ?,
            status = ?,
            post_head_sha = ?,
            metadata_json = ?
        where id = ? and project_id = ?
      `,
      [endedAt, args.status, args.postHeadSha ?? null, toJson(mergedMetadata), args.operationId, projectId]
    );
  };
  return {
    start,
    finish,
    recordCompleted(args) {
      const started = start({
        laneId: args.laneId,
        kind: args.kind,
        preHeadSha: args.preHeadSha,
        metadata: args.metadata
      });
      finish({
        operationId: started.operationId,
        status: args.status ?? "succeeded",
        postHeadSha: args.postHeadSha,
        metadataPatch: args.metadata
      });
      return { operationId: started.operationId };
    },
    list(args = {}) {
      const where = ["o.project_id = ?"];
      const params = [projectId];
      if (args.laneId) {
        where.push("o.lane_id = ?");
        params.push(args.laneId);
      }
      if (args.kind) {
        where.push("o.kind = ?");
        params.push(args.kind);
      }
      const limit = typeof args.limit === "number" ? Math.max(1, Math.min(1e3, Math.floor(args.limit))) : 300;
      params.push(limit);
      const rows = db.all(
        `
          select
            o.id as id,
            o.lane_id as laneId,
            l.name as laneName,
            o.kind as kind,
            o.started_at as startedAt,
            o.ended_at as endedAt,
            o.status as status,
            o.pre_head_sha as preHeadSha,
            o.post_head_sha as postHeadSha,
            o.metadata_json as metadataJson
          from operations o
          left join lanes l on l.id = o.lane_id
          where ${where.join(" and ")}
          order by o.started_at desc
          limit ?
        `,
        params
      );
      return rows;
    }
  };
}

// ../desktop/src/main/services/lanes/laneService.ts
var import_node_fs4 = __toESM(require("fs"), 1);
var import_node_path4 = __toESM(require("path"), 1);
var import_node_crypto3 = require("crypto");
function slugify(input) {
  const s = input.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s.length ? s : "lane";
}
function normAbs(p) {
  return import_node_path4.default.resolve(p);
}
function parseLaneIcon(value) {
  if (!value) return null;
  if (value === "star" || value === "flag" || value === "bolt" || value === "shield" || value === "tag") {
    return value;
  }
  return null;
}
function parseLaneTags(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry) => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean).slice(0, 24);
  } catch {
    return [];
  }
}
function toLaneSummary(args) {
  const { row, status, parentStatus, childCount, stackDepth } = args;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    laneType: row.lane_type,
    baseRef: row.base_ref,
    branchRef: row.branch_ref,
    worktreePath: row.worktree_path,
    attachedRootPath: row.attached_root_path,
    parentLaneId: row.parent_lane_id,
    childCount,
    stackDepth,
    parentStatus,
    isEditProtected: row.is_edit_protected === 1,
    status,
    color: row.color,
    icon: parseLaneIcon(row.icon),
    tags: parseLaneTags(row.tags_json),
    folder: row.folder,
    createdAt: row.created_at,
    archivedAt: row.archived_at
  };
}
async function detectBranchRef(worktreePath, fallback) {
  const branchRes = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktreePath, timeoutMs: 8e3 });
  if (branchRes.exitCode === 0) {
    const value = branchRes.stdout.trim();
    if (value && value !== "HEAD") return value;
  }
  return fallback;
}
async function getHeadSha(worktreePath) {
  const head = await runGit(["rev-parse", "HEAD"], { cwd: worktreePath, timeoutMs: 8e3 });
  if (head.exitCode !== 0) return null;
  const sha = head.stdout.trim();
  return sha.length ? sha : null;
}
async function computeLaneStatus(worktreePath, baseRef, branchRef) {
  const dirtyRes = await runGit(["status", "--porcelain=v1"], { cwd: worktreePath, timeoutMs: 8e3 });
  const dirty = dirtyRes.exitCode === 0 && dirtyRes.stdout.trim().length > 0;
  const countsRes = await runGit(["rev-list", "--left-right", "--count", `${baseRef}...${branchRef}`], {
    cwd: worktreePath,
    timeoutMs: 8e3
  });
  let behind = 0;
  let ahead = 0;
  if (countsRes.exitCode === 0) {
    const parts = countsRes.stdout.trim().split(/\s+/).filter(Boolean);
    const left = Number(parts[0] ?? 0);
    const right = Number(parts[1] ?? 0);
    behind = Number.isFinite(left) ? left : 0;
    ahead = Number.isFinite(right) ? right : 0;
  }
  let remoteBehind = -1;
  const upstreamRes = await runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], {
    cwd: worktreePath,
    timeoutMs: 5e3
  });
  if (upstreamRes.exitCode === 0 && upstreamRes.stdout.trim()) {
    const behindRes = await runGit(["rev-list", "HEAD..@{upstream}", "--count"], {
      cwd: worktreePath,
      timeoutMs: 5e3
    });
    if (behindRes.exitCode === 0) {
      const count = parseInt(behindRes.stdout.trim(), 10);
      remoteBehind = Number.isFinite(count) ? count : 0;
    }
  }
  return { dirty, ahead, behind, remoteBehind };
}
function computeStackDepth(args) {
  const { laneId, rowsById, memo } = args;
  const visiting = args.visiting ?? /* @__PURE__ */ new Set();
  const cached = memo.get(laneId);
  if (cached != null) return cached;
  if (visiting.has(laneId)) return 0;
  visiting.add(laneId);
  const row = rowsById.get(laneId);
  let depth = 0;
  if (row?.parent_lane_id) {
    depth = 1 + computeStackDepth({ laneId: row.parent_lane_id, rowsById, memo, visiting });
  }
  memo.set(laneId, depth);
  visiting.delete(laneId);
  return depth;
}
function sortByCreatedAtAsc(rows) {
  return [...rows].sort((a, b) => {
    const aTs = Date.parse(a.created_at);
    const bTs = Date.parse(b.created_at);
    if (!Number.isNaN(aTs) && !Number.isNaN(bTs) && aTs !== bTs) return aTs - bTs;
    return a.name.localeCompare(b.name);
  });
}
function collectDepthFirstIds(args) {
  const out = [];
  const visit = (laneId) => {
    out.push(laneId);
    for (const child of args.childrenByParent.get(laneId) ?? []) {
      visit(child.id);
    }
  };
  visit(args.rootLaneId);
  return args.includeSelf ? out : out.slice(1);
}
function createLaneService({
  db,
  projectRoot,
  projectId,
  defaultBaseRef,
  worktreesDir,
  operationService,
  onHeadChanged
}) {
  const getLaneRow = (laneId) => db.get("select * from lanes where id = ? and project_id = ? limit 1", [laneId, projectId]);
  const getAllLaneRows = (includeArchived = false) => db.all(
    includeArchived ? "select * from lanes where project_id = ? order by created_at desc" : "select * from lanes where project_id = ? and status != 'archived' order by created_at desc",
    [projectId]
  );
  const getChildrenRows = (laneId, includeArchived = false) => db.all(
    includeArchived ? "select * from lanes where project_id = ? and parent_lane_id = ? order by created_at asc" : "select * from lanes where project_id = ? and parent_lane_id = ? and status != 'archived' order by created_at asc",
    [projectId, laneId]
  );
  const ensureSameRepo = async (candidatePath) => {
    const resolvedProject = normAbs(projectRoot);
    const repoTop = (await runGitOrThrow(["rev-parse", "--show-toplevel"], { cwd: candidatePath, timeoutMs: 1e4 })).trim();
    if (normAbs(repoTop) !== resolvedProject) {
      throw new Error("Attached lane path must belong to the current project repository");
    }
  };
  const ensurePrimaryLane = async () => {
    const existing = db.get(
      "select id from lanes where project_id = ? and lane_type = 'primary' limit 1",
      [projectId]
    );
    if (existing?.id) return;
    const laneId = (0, import_node_crypto3.randomUUID)();
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const branchRef = await detectBranchRef(projectRoot, defaultBaseRef);
    db.run(
      `
        insert into lanes(
          id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
          attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
        )
        values(?, ?, ?, ?, 'primary', ?, ?, ?, null, 1, null, null, null, null, 'active', ?, null)
      `,
      [laneId, projectId, "Primary", "Main repository workspace", defaultBaseRef, branchRef, projectRoot, now]
    );
  };
  const syncPrimaryLaneBranchRef = async () => {
    const primary = db.get(
      `
        select id, worktree_path, base_ref, branch_ref
        from lanes
        where project_id = ? and lane_type = 'primary' and status != 'archived'
        limit 1
      `,
      [projectId]
    );
    if (!primary) return;
    const branchRes = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: primary.worktree_path,
      timeoutMs: 8e3
    });
    if (branchRes.exitCode !== 0) return;
    const detectedBranchRef = branchRes.stdout.trim();
    if (!detectedBranchRef || detectedBranchRef === "HEAD" || detectedBranchRef === primary.branch_ref) return;
    db.run(
      "update lanes set branch_ref = ? where id = ? and project_id = ?",
      [detectedBranchRef, primary.id, projectId]
    );
  };
  const listLanes = async ({ includeArchived = false } = {}) => {
    try {
      await ensurePrimaryLane();
    } catch (err) {
      console.warn("[laneService] ensurePrimaryLane failed, continuing with existing lanes:", err instanceof Error ? err.message : String(err));
    }
    try {
      await syncPrimaryLaneBranchRef();
    } catch (err) {
      console.warn("[laneService] syncPrimaryLaneBranchRef failed, continuing:", err instanceof Error ? err.message : String(err));
    }
    const rows = getAllLaneRows(includeArchived);
    const contextRows = getAllLaneRows(true);
    const activeRows = contextRows.filter((row) => row.status !== "archived");
    const rowsById = new Map(contextRows.map((row) => [row.id, row]));
    const depthMemo = /* @__PURE__ */ new Map();
    const statusCache = /* @__PURE__ */ new Map();
    const childCountMap = /* @__PURE__ */ new Map();
    for (const row of activeRows) {
      if (!row.parent_lane_id) continue;
      childCountMap.set(row.parent_lane_id, (childCountMap.get(row.parent_lane_id) ?? 0) + 1);
    }
    const resolveStatus = async (laneId) => {
      const cached = statusCache.get(laneId);
      if (cached) return cached;
      const row = rowsById.get(laneId);
      if (!row) return { dirty: false, ahead: 0, behind: 0, remoteBehind: -1 };
      const parent = row.parent_lane_id ? rowsById.get(row.parent_lane_id) : null;
      let baseRef = parent?.branch_ref ?? row.base_ref;
      if (!parent && row.lane_type === "primary") {
        const upstreamRes = await runGit(
          ["rev-parse", "--verify", `${row.branch_ref}@{upstream}`],
          { cwd: row.worktree_path, timeoutMs: 5e3 }
        );
        if (upstreamRes.exitCode === 0 && upstreamRes.stdout.trim()) {
          baseRef = upstreamRes.stdout.trim();
        } else {
          const originRes = await runGit(
            ["rev-parse", "--verify", `origin/${row.branch_ref}`],
            { cwd: row.worktree_path, timeoutMs: 5e3 }
          );
          if (originRes.exitCode === 0 && originRes.stdout.trim()) {
            baseRef = originRes.stdout.trim();
          }
        }
      }
      const status = await computeLaneStatus(row.worktree_path, baseRef, row.branch_ref);
      statusCache.set(laneId, status);
      return status;
    };
    const defaultStatus = { dirty: false, ahead: 0, behind: 0, remoteBehind: -1 };
    const out = [];
    for (const row of rows) {
      try {
        let status;
        try {
          status = await resolveStatus(row.id);
        } catch {
          console.warn(`[laneService] resolveStatus failed for lane ${row.id}, using default`);
          status = defaultStatus;
        }
        let parentStatus = null;
        if (row.parent_lane_id) {
          try {
            parentStatus = await resolveStatus(row.parent_lane_id);
          } catch {
            console.warn(`[laneService] resolveStatus failed for parent lane ${row.parent_lane_id}, using default`);
            parentStatus = defaultStatus;
          }
        }
        let stackDepth = 0;
        try {
          stackDepth = computeStackDepth({ laneId: row.id, rowsById, memo: depthMemo });
        } catch {
          console.warn(`[laneService] computeStackDepth failed for lane ${row.id}, defaulting to 0`);
        }
        out.push(
          toLaneSummary({
            row,
            status,
            parentStatus,
            childCount: childCountMap.get(row.id) ?? 0,
            stackDepth
          })
        );
      } catch (err) {
        console.warn(`[laneService] Failed to build summary for lane ${row.id}, skipping:`, err instanceof Error ? err.message : String(err));
      }
    }
    return out;
  };
  const createWorktreeLane = async (args) => {
    const laneId = (0, import_node_crypto3.randomUUID)();
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const slug = slugify(args.name);
    const suffix = laneId.slice(0, 8);
    const branchRef = `ade/${slug}-${suffix}`;
    const worktreePath = import_node_path4.default.join(worktreesDir, `${slug}-${suffix}`);
    await runGitOrThrow(["worktree", "add", "-b", branchRef, worktreePath, args.startPoint], {
      cwd: projectRoot,
      timeoutMs: 6e4
    });
    db.run(
      `
        insert into lanes(
          id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
          attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, folder, status, created_at, archived_at
        )
        values(?, ?, ?, ?, 'worktree', ?, ?, ?, null, 0, ?, null, null, null, ?, 'active', ?, null)
      `,
      [laneId, projectId, args.name, args.description ?? null, args.baseRef, branchRef, worktreePath, args.parentLaneId, args.folder ?? null, now]
    );
    const row = getLaneRow(laneId);
    if (!row) throw new Error(`Failed to create lane: ${laneId}`);
    const rowsById = new Map(getAllLaneRows(true).map((entry) => [entry.id, entry]));
    const status = await computeLaneStatus(worktreePath, args.baseRef, branchRef);
    const parentStatus = args.parentLaneId ? await (async () => {
      const parentId = args.parentLaneId;
      if (!parentId) return null;
      const parent = rowsById.get(parentId);
      if (!parent) return null;
      const grandParent = parent.parent_lane_id ? rowsById.get(parent.parent_lane_id) : null;
      return await computeLaneStatus(parent.worktree_path, grandParent?.branch_ref ?? parent.base_ref, parent.branch_ref);
    })() : null;
    return toLaneSummary({
      row,
      status,
      parentStatus,
      childCount: 0,
      stackDepth: computeStackDepth({ laneId, rowsById, memo: /* @__PURE__ */ new Map() })
    });
  };
  const getRowsById = (includeArchived = true) => new Map(getAllLaneRows(includeArchived).map((row) => [row.id, row]));
  const isDescendant = (rowsById, laneId, possibleDescendantId) => {
    const queue = [laneId];
    const visited = /* @__PURE__ */ new Set();
    while (queue.length > 0) {
      const current = queue.shift();
      if (visited.has(current)) continue;
      visited.add(current);
      if (current === possibleDescendantId) return true;
      for (const row of rowsById.values()) {
        if (row.parent_lane_id === current) queue.push(row.id);
      }
    }
    return false;
  };
  return {
    async ensurePrimaryLane() {
      await ensurePrimaryLane();
    },
    async list({ includeArchived = false } = {}) {
      return await listLanes({ includeArchived });
    },
    async create({ name, description, parentLaneId }) {
      if (parentLaneId) {
        const parent = getLaneRow(parentLaneId);
        if (!parent) throw new Error(`Parent lane not found: ${parentLaneId}`);
        if (parent.status === "archived") throw new Error("Parent lane is archived");
        if (parent.lane_type === "primary") {
          await runGitOrThrow(["fetch", "--prune"], { cwd: parent.worktree_path, timeoutMs: 6e4 });
          const upstreamRes = await runGit(["rev-parse", "@{upstream}"], { cwd: parent.worktree_path, timeoutMs: 1e4 });
          if (upstreamRes.exitCode === 0) {
            const behindRes = await runGit(["rev-list", "HEAD..@{upstream}", "--count"], {
              cwd: parent.worktree_path,
              timeoutMs: 1e4
            });
            if (behindRes.exitCode === 0) {
              const behindCount = parseInt(behindRes.stdout.trim(), 10);
              if (behindCount > 0) {
                throw new Error(
                  `Primary branch is behind remote by ${behindCount} commit(s). Pull/sync before creating a new lane.`
                );
              }
            }
          }
        }
        const parentHeadSha = await getHeadSha(parent.worktree_path);
        if (!parentHeadSha) throw new Error(`Unable to resolve parent HEAD for lane ${parent.name}`);
        return await createWorktreeLane({
          name,
          description,
          baseRef: parent.branch_ref,
          startPoint: parentHeadSha,
          parentLaneId: parent.id
        });
      }
      const headRes = await runGit(["rev-parse", defaultBaseRef], { cwd: projectRoot, timeoutMs: 1e4 });
      const startPoint = headRes.exitCode === 0 && headRes.stdout.trim().length ? headRes.stdout.trim() : defaultBaseRef;
      return await createWorktreeLane({
        name,
        description,
        baseRef: defaultBaseRef,
        startPoint,
        parentLaneId: null
      });
    },
    async createChild(args) {
      const parent = getLaneRow(args.parentLaneId);
      if (!parent) throw new Error(`Parent lane not found: ${args.parentLaneId}`);
      if (parent.status === "archived") throw new Error("Parent lane is archived");
      if (parent.lane_type === "primary") {
        await runGitOrThrow(["fetch", "--prune"], { cwd: parent.worktree_path, timeoutMs: 6e4 });
        const upstreamRes = await runGit(["rev-parse", "@{upstream}"], { cwd: parent.worktree_path, timeoutMs: 1e4 });
        if (upstreamRes.exitCode === 0) {
          const behindRes = await runGit(["rev-list", "HEAD..@{upstream}", "--count"], {
            cwd: parent.worktree_path,
            timeoutMs: 1e4
          });
          if (behindRes.exitCode === 0) {
            const behindCount = parseInt(behindRes.stdout.trim(), 10);
            if (behindCount > 0) {
              throw new Error(
                `Primary branch is behind remote by ${behindCount} commit(s). Pull/sync before creating a new lane.`
              );
            }
          }
        }
      }
      const parentHeadSha = await getHeadSha(parent.worktree_path);
      if (!parentHeadSha) throw new Error(`Unable to resolve parent HEAD for lane ${parent.name}`);
      return await createWorktreeLane({
        name: args.name,
        description: args.description,
        baseRef: parent.branch_ref,
        startPoint: parentHeadSha,
        parentLaneId: parent.id,
        folder: args.folder
      });
    },
    async importBranch(args) {
      const branchRef = (args.branchRef ?? "").trim();
      if (!branchRef) throw new Error("branchRef is required");
      if (branchRef.includes("\0")) throw new Error("Invalid branchRef");
      await runGitOrThrow(["rev-parse", "--verify", branchRef], { cwd: projectRoot, timeoutMs: 12e3 });
      const existing = db.get(
        "select id from lanes where project_id = ? and branch_ref = ? limit 1",
        [projectId, branchRef]
      );
      if (existing?.id) {
        throw new Error(`Lane already exists for branch '${branchRef}'`);
      }
      const laneId = (0, import_node_crypto3.randomUUID)();
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const displayName = (args.name ?? "").trim() || branchRef;
      const slug = slugify(displayName);
      const suffix = laneId.slice(0, 8);
      const worktreePath = import_node_path4.default.join(worktreesDir, `${slug}-${suffix}`);
      await runGitOrThrow(["worktree", "add", worktreePath, branchRef], {
        cwd: projectRoot,
        timeoutMs: 6e4
      });
      const parentLaneIdRaw = typeof args.parentLaneId === "string" ? args.parentLaneId.trim() : "";
      const parentLaneId = parentLaneIdRaw.length ? parentLaneIdRaw : null;
      const parent = parentLaneId ? getLaneRow(parentLaneId) : null;
      if (parentLaneId && !parent) throw new Error(`Parent lane not found: ${parentLaneId}`);
      if (parent && parent.status === "archived") throw new Error("Parent lane is archived");
      const baseRef = parent?.branch_ref ?? defaultBaseRef;
      db.run(
        `
          insert into lanes(
            id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
            attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
          )
          values(?, ?, ?, ?, 'worktree', ?, ?, ?, null, 0, ?, null, null, null, 'active', ?, null)
        `,
        [laneId, projectId, displayName, args.description ?? null, baseRef, branchRef, worktreePath, parentLaneId, now]
      );
      const row = getLaneRow(laneId);
      if (!row) throw new Error(`Failed to import lane: ${laneId}`);
      const rowsById = getRowsById(true);
      const status = await computeLaneStatus(worktreePath, baseRef, branchRef);
      const parentStatus = parent ? await computeLaneStatus(parent.worktree_path, parent.base_ref, parent.branch_ref) : null;
      if (onHeadChanged) {
        try {
          const postHeadSha = await getHeadSha(worktreePath);
          onHeadChanged({
            laneId,
            reason: "import_branch",
            preHeadSha: null,
            postHeadSha
          });
        } catch {
        }
      }
      return toLaneSummary({
        row,
        status,
        parentStatus,
        childCount: 0,
        stackDepth: computeStackDepth({ laneId, rowsById, memo: /* @__PURE__ */ new Map() })
      });
    },
    async getChildren(laneId) {
      const childRows = getChildrenRows(laneId, false);
      if (childRows.length === 0) return [];
      const allRows = getAllLaneRows(true);
      const rowsById = new Map(allRows.map((row) => [row.id, row]));
      const activeRows = allRows.filter((row) => row.status !== "archived");
      const depthMemo = /* @__PURE__ */ new Map();
      const childCountMap = /* @__PURE__ */ new Map();
      for (const row of activeRows) {
        if (!row.parent_lane_id) continue;
        childCountMap.set(row.parent_lane_id, (childCountMap.get(row.parent_lane_id) ?? 0) + 1);
      }
      const parentRow = rowsById.get(laneId);
      let parentStatus = null;
      if (parentRow) {
        const grandParent = parentRow.parent_lane_id ? rowsById.get(parentRow.parent_lane_id) : null;
        try {
          parentStatus = await computeLaneStatus(
            parentRow.worktree_path,
            grandParent?.branch_ref ?? parentRow.base_ref,
            parentRow.branch_ref
          );
        } catch {
          parentStatus = { dirty: false, ahead: 0, behind: 0, remoteBehind: -1 };
        }
      }
      const defaultStatus = { dirty: false, ahead: 0, behind: 0, remoteBehind: -1 };
      const out = [];
      for (const row of childRows) {
        let status;
        try {
          const parent = row.parent_lane_id ? rowsById.get(row.parent_lane_id) : null;
          status = await computeLaneStatus(
            row.worktree_path,
            parent?.branch_ref ?? row.base_ref,
            row.branch_ref
          );
        } catch {
          status = defaultStatus;
        }
        out.push(
          toLaneSummary({
            row,
            status,
            parentStatus,
            childCount: childCountMap.get(row.id) ?? 0,
            stackDepth: computeStackDepth({ laneId: row.id, rowsById, memo: depthMemo })
          })
        );
      }
      return out;
    },
    async getStackChain(laneId) {
      const start = getLaneRow(laneId);
      if (!start) throw new Error(`Lane not found: ${laneId}`);
      let rootId = start.id;
      let cursor = start;
      const visited = /* @__PURE__ */ new Set();
      while (cursor?.parent_lane_id && !visited.has(cursor.id)) {
        visited.add(cursor.id);
        const parent = getLaneRow(cursor.parent_lane_id);
        if (!parent) break;
        rootId = parent.id;
        cursor = parent;
      }
      const chainRows = db.all(
        `
          with recursive stack as (
            select id, parent_lane_id, 0 as depth
            from lanes
            where id = ? and project_id = ?
            union all
            select l.id, l.parent_lane_id, s.depth + 1
            from lanes l
            join stack s on l.parent_lane_id = s.id
            where l.project_id = ? and l.status != 'archived'
          )
          select l.id, l.name, l.branch_ref, l.parent_lane_id, l.base_ref, l.worktree_path, l.created_at
          from stack s
          join lanes l on l.id = s.id
          where l.project_id = ?
          order by l.created_at asc
        `,
        [rootId, projectId, projectId, projectId]
      );
      if (chainRows.length === 0) return [];
      const rowsById = new Map(chainRows.map((row) => [row.id, row]));
      const childrenByParent = /* @__PURE__ */ new Map();
      for (const row of chainRows) {
        if (!row.parent_lane_id) continue;
        const arr = childrenByParent.get(row.parent_lane_id) ?? [];
        const laneRow = getLaneRow(row.id);
        if (!laneRow) continue;
        arr.push(laneRow);
        childrenByParent.set(row.parent_lane_id, arr);
      }
      for (const [parentId, children] of childrenByParent.entries()) {
        childrenByParent.set(parentId, sortByCreatedAtAsc(children));
      }
      const statusCache = /* @__PURE__ */ new Map();
      const resolveStatus = async (row) => {
        const cached = statusCache.get(row.id);
        if (cached) return cached;
        const parent = row.parent_lane_id ? rowsById.get(row.parent_lane_id) : null;
        const status = await computeLaneStatus(row.worktree_path, parent?.branch_ref ?? row.base_ref, row.branch_ref);
        statusCache.set(row.id, status);
        return status;
      };
      const out = [];
      const visit = async (id, depth) => {
        const row = rowsById.get(id);
        if (!row) return;
        out.push({
          laneId: row.id,
          laneName: row.name,
          branchRef: row.branch_ref,
          depth,
          parentLaneId: row.parent_lane_id,
          status: await resolveStatus(row)
        });
        for (const child of childrenByParent.get(id) ?? []) {
          await visit(child.id, depth + 1);
        }
      };
      await visit(rootId, 0);
      return out;
    },
    async restack(args) {
      const recursive = args.recursive ?? true;
      const reason = typeof args.reason === "string" && args.reason.trim().length ? args.reason.trim() : "restack";
      const target = getLaneRow(args.laneId);
      if (!target) throw new Error(`Lane not found: ${args.laneId}`);
      if (!target.parent_lane_id) {
        return {
          restackedLanes: [],
          failedLaneId: null,
          error: "Lane has no parent; nothing to restack."
        };
      }
      const activeRows = getAllLaneRows(false);
      const rowsById = new Map(activeRows.map((row) => [row.id, row]));
      const childrenByParent = /* @__PURE__ */ new Map();
      for (const row of activeRows) {
        if (!row.parent_lane_id) continue;
        const arr = childrenByParent.get(row.parent_lane_id) ?? [];
        arr.push(row);
        childrenByParent.set(row.parent_lane_id, arr);
      }
      for (const [parentId, children] of childrenByParent.entries()) {
        childrenByParent.set(parentId, sortByCreatedAtAsc(children));
      }
      const restackOrder = recursive ? collectDepthFirstIds({ rootLaneId: target.id, childrenByParent, includeSelf: true }) : [target.id];
      const restackedLanes = [];
      for (const laneId of restackOrder) {
        const lane = rowsById.get(laneId) ?? getLaneRow(laneId);
        if (!lane?.parent_lane_id) continue;
        const parent = rowsById.get(lane.parent_lane_id) ?? getLaneRow(lane.parent_lane_id);
        if (!parent) {
          return {
            restackedLanes,
            failedLaneId: lane.id,
            error: `Parent lane not found for ${lane.name}`
          };
        }
        const parentHead = await getHeadSha(parent.worktree_path);
        if (!parentHead) {
          return {
            restackedLanes,
            failedLaneId: lane.id,
            error: `Unable to resolve parent HEAD for ${parent.name}`
          };
        }
        const preHeadSha = await getHeadSha(lane.worktree_path);
        const operation = operationService?.start({
          laneId: lane.id,
          kind: "lane_restack",
          preHeadSha,
          metadata: {
            reason,
            parentLaneId: parent.id,
            parentBranchRef: parent.branch_ref,
            parentHeadSha: parentHead,
            recursive
          }
        });
        try {
          await runGitOrThrow(["rebase", parentHead], { cwd: lane.worktree_path, timeoutMs: 12e4 });
          const postHeadSha = await getHeadSha(lane.worktree_path);
          if (operation?.operationId) {
            operationService?.finish({
              operationId: operation.operationId,
              status: "succeeded",
              postHeadSha
            });
          }
          if (preHeadSha !== postHeadSha && onHeadChanged) {
            try {
              onHeadChanged({
                laneId: lane.id,
                reason,
                preHeadSha,
                postHeadSha
              });
            } catch {
            }
          }
          restackedLanes.push(lane.id);
        } catch (error) {
          const postHeadSha = await getHeadSha(lane.worktree_path);
          const message = error instanceof Error ? error.message : String(error);
          if (operation?.operationId) {
            operationService?.finish({
              operationId: operation.operationId,
              status: "failed",
              postHeadSha,
              metadataPatch: { error: message }
            });
          }
          return {
            restackedLanes,
            failedLaneId: lane.id,
            error: message
          };
        }
      }
      return {
        restackedLanes,
        failedLaneId: null,
        error: null
      };
    },
    async reparent({ laneId, newParentLaneId }) {
      const lane = getLaneRow(laneId);
      if (!lane) throw new Error(`Lane not found: ${laneId}`);
      if (lane.lane_type === "primary") throw new Error("Primary lane cannot be reparented");
      const newParent = getLaneRow(newParentLaneId);
      if (!newParent) throw new Error(`Parent lane not found: ${newParentLaneId}`);
      if (newParent.status === "archived") throw new Error("Parent lane is archived");
      if (lane.id === newParent.id) throw new Error("Cannot reparent lane to itself");
      const rowsById = getRowsById(true);
      if (isDescendant(rowsById, lane.id, newParent.id)) {
        throw new Error("Cannot reparent lane under one of its descendants");
      }
      const previousParentLaneId = lane.parent_lane_id;
      const previousBaseRef = lane.base_ref;
      const newBaseRef = newParent.branch_ref;
      const preHeadSha = await getHeadSha(lane.worktree_path);
      const newParentHead = await getHeadSha(newParent.worktree_path);
      if (!newParentHead) throw new Error(`Unable to resolve parent HEAD for lane ${newParent.name}`);
      const operation = operationService?.start({
        laneId: lane.id,
        kind: "lane_reparent",
        preHeadSha,
        metadata: {
          previousParentLaneId,
          newParentLaneId: newParent.id,
          previousBaseRef,
          newBaseRef,
          parentHeadSha: newParentHead
        }
      });
      db.run(
        "update lanes set parent_lane_id = ?, base_ref = ? where id = ? and project_id = ?",
        [newParent.id, newBaseRef, lane.id, projectId]
      );
      try {
        await runGitOrThrow(["rebase", newParentHead], { cwd: lane.worktree_path, timeoutMs: 12e4 });
      } catch (error) {
        try {
          await runGit(["rebase", "--abort"], { cwd: lane.worktree_path, timeoutMs: 2e4 });
        } catch {
        }
        db.run(
          "update lanes set parent_lane_id = ?, base_ref = ? where id = ? and project_id = ?",
          [previousParentLaneId, previousBaseRef, lane.id, projectId]
        );
        const message = error instanceof Error ? error.message : String(error);
        if (operation?.operationId) {
          const postHeadSha2 = await getHeadSha(lane.worktree_path);
          operationService?.finish({
            operationId: operation.operationId,
            status: "failed",
            postHeadSha: postHeadSha2,
            metadataPatch: { error: message }
          });
        }
        throw new Error(message);
      }
      const postHeadSha = await getHeadSha(lane.worktree_path);
      if (operation?.operationId) {
        operationService?.finish({
          operationId: operation.operationId,
          status: "succeeded",
          postHeadSha
        });
      }
      if (preHeadSha !== postHeadSha && onHeadChanged) {
        try {
          onHeadChanged({
            laneId: lane.id,
            reason: "reparent",
            preHeadSha,
            postHeadSha
          });
        } catch {
        }
      }
      return {
        laneId: lane.id,
        previousParentLaneId,
        newParentLaneId: newParent.id,
        previousBaseRef,
        newBaseRef,
        preHeadSha,
        postHeadSha
      };
    },
    rename({ laneId, name }) {
      db.run("update lanes set name = ? where id = ? and project_id = ?", [name, laneId, projectId]);
    },
    updateAppearance({ laneId, color, icon, tags }) {
      const lane = getLaneRow(laneId);
      if (!lane) throw new Error(`Lane not found: ${laneId}`);
      const normalizedTags = tags == null ? parseLaneTags(lane.tags_json) : tags.map((entry) => entry.trim()).filter(Boolean).slice(0, 24);
      const normalizedColor = color === void 0 ? lane.color : color;
      const normalizedIcon = icon === void 0 ? parseLaneIcon(lane.icon) : icon;
      db.run(
        `
          update lanes
          set color = ?, icon = ?, tags_json = ?
          where id = ? and project_id = ?
        `,
        [
          normalizedColor ?? null,
          normalizedIcon ?? null,
          JSON.stringify(normalizedTags),
          laneId,
          projectId
        ]
      );
    },
    archive({ laneId }) {
      const row = getLaneRow(laneId);
      if (!row) throw new Error(`Lane not found: ${laneId}`);
      if (row.lane_type === "primary") {
        throw new Error("Primary lane cannot be archived");
      }
      const activeGroupMember = db.get(
        `select m.group_id from pr_group_members m
         join pr_groups g on g.id = m.group_id
         where m.lane_id = ? and g.project_id = ?
         limit 1`,
        [laneId, projectId]
      );
      if (activeGroupMember) {
        throw new Error("Cannot archive a lane that is part of a PR group. Remove from the group first.");
      }
      const now = (/* @__PURE__ */ new Date()).toISOString();
      db.run("update lanes set status = 'archived', archived_at = ? where id = ? and project_id = ?", [now, laneId, projectId]);
    },
    async delete({
      laneId,
      deleteBranch = true,
      deleteRemoteBranch = false,
      remoteName = "origin",
      force = false
    }) {
      const row = getLaneRow(laneId);
      if (!row) throw new Error(`Lane not found: ${laneId}`);
      if (row.lane_type === "primary") {
        throw new Error("Primary lane cannot be deleted");
      }
      const childRows = getChildrenRows(laneId, false);
      if (childRows.length > 0) {
        throw new Error("Cannot delete a lane with active child lanes. Delete or restack/archive children first.");
      }
      if (row.lane_type === "worktree" && row.worktree_path && import_node_fs4.default.existsSync(row.worktree_path)) {
        const dirtyRes = await runGit(["status", "--porcelain=v1"], { cwd: row.worktree_path, timeoutMs: 8e3 });
        const dirty = dirtyRes.exitCode === 0 && dirtyRes.stdout.trim().length > 0;
        if (dirty && !force) {
          throw new Error("Lane has uncommitted changes. Enable force delete after confirming warnings.");
        }
        const removeArgs = ["worktree", "remove"];
        if (force) removeArgs.push("--force");
        removeArgs.push(row.worktree_path);
        await runGitOrThrow(removeArgs, { cwd: projectRoot, timeoutMs: 6e4 });
      }
      if (deleteBranch && row.branch_ref) {
        const refCheck = await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${row.branch_ref}`], {
          cwd: projectRoot,
          timeoutMs: 8e3
        });
        if (refCheck.exitCode === 0) {
          await runGitOrThrow(["branch", "-D", row.branch_ref], { cwd: projectRoot, timeoutMs: 3e4 });
        }
      }
      if (deleteRemoteBranch && row.branch_ref) {
        const remote = remoteName.trim() || "origin";
        const remoteCheck = await runGit(["remote", "get-url", remote], { cwd: projectRoot, timeoutMs: 8e3 });
        if (remoteCheck.exitCode !== 0) {
          throw new Error(`Remote '${remote}' is not configured for this repository`);
        }
        const remoteRefCheck = await runGit(["ls-remote", "--heads", remote, row.branch_ref], {
          cwd: projectRoot,
          timeoutMs: 12e3
        });
        if (remoteRefCheck.exitCode === 0 && remoteRefCheck.stdout.trim().length > 0) {
          await runGitOrThrow(["push", remote, "--delete", row.branch_ref], { cwd: projectRoot, timeoutMs: 45e3 });
        }
      }
      const lanePackDir = import_node_path4.default.join(projectRoot, ".ade", "packs", "lanes", laneId);
      try {
        import_node_fs4.default.rmSync(lanePackDir, { recursive: true, force: true });
      } catch {
      }
      db.run("update lanes set parent_lane_id = null where parent_lane_id = ? and project_id = ?", [laneId, projectId]);
      db.run("delete from pr_group_members where lane_id = ?", [laneId]);
      db.run("delete from pull_requests where lane_id = ? and project_id = ?", [laneId, projectId]);
      db.run("delete from session_deltas where lane_id = ?", [laneId]);
      db.run("delete from terminal_sessions where lane_id = ?", [laneId]);
      db.run("delete from operations where lane_id = ?", [laneId]);
      db.run("delete from packs_index where lane_id = ?", [laneId]);
      db.run("delete from process_runtime where lane_id = ?", [laneId]);
      db.run("delete from process_runs where lane_id = ?", [laneId]);
      db.run("delete from test_runs where lane_id = ?", [laneId]);
      db.run("delete from lanes where id = ? and project_id = ?", [laneId, projectId]);
    },
    getLaneWorktreePath(laneId) {
      const row = getLaneRow(laneId);
      if (!row) throw new Error(`Lane not found: ${laneId}`);
      return row.worktree_path;
    },
    getLaneBaseAndBranch(laneId) {
      const row = getLaneRow(laneId);
      if (!row) throw new Error(`Lane not found: ${laneId}`);
      return { baseRef: row.base_ref, branchRef: row.branch_ref, worktreePath: row.worktree_path, laneType: row.lane_type };
    },
    updateBranchRef(laneId, branchRef) {
      db.run("update lanes set branch_ref = ? where id = ? and project_id = ?", [branchRef, laneId, projectId]);
    },
    getFilesWorkspaces() {
      const rows = getAllLaneRows(false);
      return rows.map((row) => ({
        id: row.id,
        kind: row.lane_type,
        laneId: row.id,
        name: row.name,
        rootPath: row.worktree_path,
        isReadOnlyByDefault: row.is_edit_protected === 1
      }));
    },
    resolveWorkspaceById(workspaceId) {
      const row = getLaneRow(workspaceId);
      if (!row) throw new Error(`Workspace not found: ${workspaceId}`);
      return {
        id: row.id,
        kind: row.lane_type,
        laneId: row.id,
        name: row.name,
        rootPath: row.worktree_path,
        isReadOnlyByDefault: row.is_edit_protected === 1
      };
    },
    async attach(args) {
      const attachedPath = normAbs(args.attachedPath);
      if (!import_node_fs4.default.existsSync(attachedPath) || !import_node_fs4.default.statSync(attachedPath).isDirectory()) {
        throw new Error("Attached lane path must be an existing directory");
      }
      await ensureSameRepo(attachedPath);
      const laneId = (0, import_node_crypto3.randomUUID)();
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const branchRef = await detectBranchRef(attachedPath, defaultBaseRef);
      const baseRef = defaultBaseRef;
      db.run(
        `
        insert into lanes(
          id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
          attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at
        )
        values(?, ?, ?, ?, 'attached', ?, ?, ?, ?, 0, null, null, null, null, 'active', ?, null)
      `,
        [laneId, projectId, args.name, args.description ?? null, baseRef, branchRef, attachedPath, attachedPath, now]
      );
      const row = getLaneRow(laneId);
      if (!row) throw new Error(`Failed to attach lane: ${laneId}`);
      const status = await computeLaneStatus(attachedPath, baseRef, branchRef);
      return toLaneSummary({
        row,
        status,
        parentStatus: null,
        childCount: 0,
        stackDepth: 0
      });
    }
  };
}

// ../desktop/src/main/services/sessions/sessionService.ts
var import_node_fs5 = __toESM(require("fs"), 1);

// ../desktop/src/main/utils/ansiStrip.ts
var OSC_REGEX = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;
var CSI_REGEX = /\u001b\[[0-?]*[ -/]*[@-~]/g;
var CHARSET_REGEX = /\u001b[\(\)][0-9A-Za-z]/g;
var TWO_CHAR_ESC_REGEX = /\u001b[@-Z\\-_]/g;
function applyBackspaces(text) {
  if (!text.includes("\b")) return text;
  const out = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] ?? "";
    if (ch === "\b") {
      if (out.length) out.pop();
      continue;
    }
    out.push(ch);
  }
  return out.join("");
}
function stripAnsi(text) {
  return stripAnsiWithOptions(text);
}
function stripAnsiWithOptions(text, options) {
  const input = typeof text === "string" ? text : String(text ?? "");
  if (!input) return "";
  const strippedEscapes = input.replace(OSC_REGEX, "").replace(CSI_REGEX, "").replace(CHARSET_REGEX, "").replace(TWO_CHAR_ESC_REGEX, "");
  const stripped = options?.preserveCarriageReturns ? strippedEscapes : strippedEscapes.replace(/\r/g, "");
  return applyBackspaces(stripped);
}

// ../desktop/src/main/utils/terminalSessionSignals.ts
var OSC_133_REGEX = /\u001b\]133;([ABCD])(?:;[^\u0007\u001b]*)?(?:\u0007|\u001b\\)/g;
var RESUME_BACKTICK_REGEX = /`((?:claude|codex)\s+(?:resume|--resume\b)[^`\r\n]*)`/gi;
var RESUME_PLAIN_REGEX = /\b((?:claude|codex)\s+(?:resume|--resume\b)[^\r\n]*)/gi;
function normalizeCommand(raw) {
  return raw.trim().replace(/\s+/g, " ").replace(/[)\].,;:!?]+$/g, "").trim();
}
function toolFromCommand(raw) {
  const normalized = raw.trim().toLowerCase();
  if (normalized.startsWith("claude ")) return "claude";
  if (normalized.startsWith("codex ")) return "codex";
  return null;
}
function prefersTool(raw, preferredTool) {
  if (!preferredTool || preferredTool !== "claude" && preferredTool !== "codex") return true;
  const cmdTool = toolFromCommand(raw);
  return cmdTool === preferredTool;
}
function defaultResumeCommandForTool(toolType) {
  if (toolType === "claude" || toolType === "claude-orchestrated") return "claude resume";
  if (toolType === "codex" || toolType === "codex-orchestrated") return "codex resume";
  return null;
}
function extractResumeCommandFromOutput(text, preferredTool) {
  if (!text.trim()) return null;
  const fromBackticks = Array.from(text.matchAll(RESUME_BACKTICK_REGEX)).map((m) => normalizeCommand(m[1] ?? "")).filter(Boolean);
  for (const candidate of fromBackticks) {
    if (prefersTool(candidate, preferredTool)) return candidate;
  }
  const fromPlain = Array.from(text.matchAll(RESUME_PLAIN_REGEX)).map((m) => normalizeCommand(m[1] ?? "")).filter(Boolean);
  for (const candidate of fromPlain) {
    if (prefersTool(candidate, preferredTool)) return candidate;
  }
  return null;
}
function runtimeStateFromOsc133Chunk(chunk, previous) {
  let next = previous;
  if (!chunk) return next;
  for (const match of chunk.matchAll(OSC_133_REGEX)) {
    const marker = (match[1] ?? "").toUpperCase();
    if (marker === "A" || marker === "D") {
      next = "waiting-input";
      continue;
    }
    if (marker === "B" || marker === "C") {
      next = "running";
    }
  }
  return next;
}

// ../desktop/src/main/services/sessions/sessionService.ts
function createSessionService({ db }) {
  const runtimeStateFromStatus = (status) => {
    if (status === "running") return "running";
    if (status === "disposed") return "killed";
    return "exited";
  };
  const normalizeToolType2 = (raw) => {
    const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (!value) return null;
    const allowed = [
      "shell",
      "claude",
      "codex",
      "claude-orchestrated",
      "codex-orchestrated",
      "codex-chat",
      "claude-chat",
      "cursor",
      "aider",
      "continue",
      "other"
    ];
    return allowed.includes(value) ? value : "other";
  };
  const list = ({ laneId, status, limit } = {}) => {
    const where = [];
    const params = [];
    if (laneId) {
      where.push("s.lane_id = ?");
      params.push(laneId);
    }
    if (status) {
      where.push("s.status = ?");
      params.push(status);
    }
    const whereSql = where.length ? `where ${where.join(" and ")}` : "";
    const limitSql = typeof limit === "number" ? "limit ?" : "limit 200";
    if (typeof limit === "number") params.push(limit);
    const rows = db.all(
      `
        select
          s.id as id,
          s.lane_id as laneId,
          l.name as laneName,
          s.pty_id as ptyId,
          s.tracked as tracked,
          s.pinned as pinned,
          s.goal as goal,
          s.tool_type as toolType,
          s.title as title,
          s.status as status,
          s.started_at as startedAt,
          s.ended_at as endedAt,
          s.exit_code as exitCode,
          s.transcript_path as transcriptPath,
          s.head_sha_start as headShaStart,
          s.head_sha_end as headShaEnd,
          s.last_output_preview as lastOutputPreview,
          s.summary as summary,
          s.resume_command as resumeCommand
        from terminal_sessions s
        join lanes l on l.id = s.lane_id
        ${whereSql}
        order by s.started_at desc
        ${limitSql}
      `,
      params
    );
    return rows.map((row) => ({
      ...row,
      tracked: row.tracked === 1,
      pinned: row.pinned === 1,
      goal: row.goal ?? null,
      toolType: normalizeToolType2(row.toolType),
      summary: row.summary ?? null,
      runtimeState: runtimeStateFromStatus(row.status),
      resumeCommand: row.resumeCommand ?? null
    }));
  };
  return {
    list,
    reconcileStaleRunningSessions({
      endedAt,
      status
    } = {}) {
      const row = db.get("select count(1) as count from terminal_sessions where status = 'running'");
      const count = Number(row?.count ?? 0);
      if (!Number.isFinite(count) || count <= 0) return 0;
      const finalEndedAt = endedAt ?? (/* @__PURE__ */ new Date()).toISOString();
      const finalStatus = status ?? "disposed";
      db.run("update terminal_sessions set ended_at = ?, exit_code = ?, status = ?, pty_id = null where status = 'running'", [
        finalEndedAt,
        null,
        finalStatus
      ]);
      return count;
    },
    get(sessionId) {
      const row = db.get(
        `
          select
            s.id as id,
            s.lane_id as laneId,
            l.name as laneName,
            s.pty_id as ptyId,
            s.tracked as tracked,
            s.pinned as pinned,
            s.goal as goal,
            s.tool_type as toolType,
            s.title as title,
            s.status as status,
            s.started_at as startedAt,
            s.ended_at as endedAt,
            s.exit_code as exitCode,
            s.transcript_path as transcriptPath,
            s.head_sha_start as headShaStart,
            s.head_sha_end as headShaEnd,
            s.last_output_preview as lastOutputPreview,
            s.summary as summary,
            s.resume_command as resumeCommand
          from terminal_sessions s
          join lanes l on l.id = s.lane_id
          where s.id = ?
          limit 1
        `,
        [sessionId]
      );
      return row ? {
        ...row,
        tracked: row.tracked === 1,
        pinned: row.pinned === 1,
        goal: row.goal ?? null,
        toolType: normalizeToolType2(row.toolType),
        runtimeState: runtimeStateFromStatus(row.status),
        resumeCommand: row.resumeCommand ?? null
      } : null;
    },
    updateMeta(args) {
      const sessionId = typeof args?.sessionId === "string" ? args.sessionId.trim() : "";
      if (!sessionId) return null;
      const sets = [];
      const params = [];
      if (typeof args.pinned === "boolean") {
        sets.push("pinned = ?");
        params.push(args.pinned ? 1 : 0);
      }
      if (args.goal !== void 0) {
        sets.push("goal = ?");
        params.push(args.goal == null ? null : String(args.goal));
      }
      if (args.toolType !== void 0) {
        const normalized = normalizeToolType2(args.toolType);
        sets.push("tool_type = ?");
        params.push(normalized);
      }
      if (args.resumeCommand !== void 0) {
        const next = typeof args.resumeCommand === "string" ? args.resumeCommand.trim() : "";
        sets.push("resume_command = ?");
        params.push(next ? next : null);
      }
      if (sets.length) {
        params.push(sessionId);
        db.run(`update terminal_sessions set ${sets.join(", ")} where id = ?`, params);
      }
      const updated = this.get(sessionId);
      if (!updated) return null;
      if (args.resumeCommand !== void 0) return updated;
      if (args.toolType !== void 0 && !updated.resumeCommand) {
        const fallback = defaultResumeCommandForTool(updated.toolType);
        if (fallback) {
          db.run("update terminal_sessions set resume_command = ? where id = ? and resume_command is null", [fallback, sessionId]);
          const withResume = this.get(sessionId);
          return withResume ?? updated;
        }
      }
      return updated;
    },
    create({
      sessionId,
      laneId,
      ptyId,
      title,
      startedAt,
      transcriptPath,
      tracked,
      toolType,
      resumeCommand
    }) {
      const normalizedToolType = normalizeToolType2(toolType);
      const normalizedResumeCommand = typeof resumeCommand === "string" && resumeCommand.trim().length ? resumeCommand.trim() : defaultResumeCommandForTool(normalizedToolType);
      db.run(
        `
          insert into terminal_sessions(
            id, lane_id, pty_id, tracked, title, started_at, ended_at, exit_code, transcript_path,
            head_sha_start, head_sha_end, status, last_output_preview, last_output_at, summary, tool_type, resume_command
          ) values (?, ?, ?, ?, ?, ?, null, null, ?, null, null, 'running', null, null, null, ?, ?)
        `,
        [
          sessionId,
          laneId,
          ptyId ?? null,
          tracked ? 1 : 0,
          title,
          startedAt,
          transcriptPath,
          normalizedToolType,
          normalizedResumeCommand ?? null
        ]
      );
    },
    reopen(sessionId) {
      db.run(
        `
          update terminal_sessions
          set status = 'running',
              ended_at = null,
              exit_code = null
          where id = ?
        `,
        [sessionId]
      );
    },
    setHeadShaStart(sessionId, sha) {
      db.run("update terminal_sessions set head_sha_start = ? where id = ?", [sha, sessionId]);
    },
    setHeadShaEnd(sessionId, sha) {
      db.run("update terminal_sessions set head_sha_end = ? where id = ?", [sha, sessionId]);
    },
    setLastOutputPreview(sessionId, preview) {
      db.run(
        "update terminal_sessions set last_output_preview = ?, last_output_at = ? where id = ?",
        [preview, (/* @__PURE__ */ new Date()).toISOString(), sessionId]
      );
    },
    setSummary(sessionId, summary) {
      db.run("update terminal_sessions set summary = ? where id = ?", [summary, sessionId]);
    },
    setResumeCommand(sessionId, resumeCommand) {
      const next = typeof resumeCommand === "string" ? resumeCommand.trim() : "";
      db.run("update terminal_sessions set resume_command = ? where id = ?", [next ? next : null, sessionId]);
    },
    end({
      sessionId,
      endedAt,
      exitCode,
      status
    }) {
      db.run("update terminal_sessions set ended_at = ?, exit_code = ?, status = ?, pty_id = null where id = ?", [
        endedAt,
        exitCode,
        status,
        sessionId
      ]);
    },
    readTranscriptTail(transcriptPath, maxBytes, options) {
      if (!transcriptPath) return "";
      try {
        const stat = import_node_fs5.default.statSync(transcriptPath);
        const size = stat.size;
        const start = Math.max(0, size - maxBytes);
        const fd = import_node_fs5.default.openSync(transcriptPath, "r");
        try {
          const out = Buffer.alloc(size - start);
          import_node_fs5.default.readSync(fd, out, 0, out.length, start);
          const alignToLineBoundary = options?.alignToLineBoundary === true;
          let slice = out;
          if (alignToLineBoundary && start > 0 && out.length > 0) {
            const nextNewline = out.indexOf(10);
            if (nextNewline >= 0 && nextNewline + 1 < out.length) {
              slice = out.subarray(nextNewline + 1);
            }
          }
          const text = slice.toString("utf8");
          return options?.raw ? text : stripAnsi(text);
        } finally {
          import_node_fs5.default.closeSync(fd);
        }
      } catch {
        return "";
      }
    }
  };
}

// ../desktop/src/main/services/config/projectConfigService.ts
var import_node_fs6 = __toESM(require("fs"), 1);
var import_node_path5 = __toESM(require("path"), 1);
var import_node_crypto4 = require("crypto");
var import_yaml = __toESM(require("yaml"), 1);
var import_node_cron = __toESM(require("node-cron"), 1);
var TRUSTED_SHARED_HASH_KEY = "project_config:trusted_shared_hash";
var VERSION = 1;
var DEFAULT_GRACEFUL_MS = 7e3;
var EMPTY_CONTENT_HASH = (0, import_node_crypto4.createHash)("sha256").update("").digest("hex");
function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function asString(value) {
  return typeof value === "string" ? value : void 0;
}
function asStringArray(value) {
  if (!Array.isArray(value)) return void 0;
  const out = value.filter((v) => typeof v === "string").map((v) => v.trim()).filter(Boolean);
  return out;
}
function asLaneTypeArray(value) {
  const out = asStringArray(value);
  if (!out) return void 0;
  const laneTypes = out.filter(
    (laneType) => laneType === "primary" || laneType === "worktree" || laneType === "attached"
  );
  return laneTypes;
}
function asNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function asBool(value) {
  return typeof value === "boolean" ? value : void 0;
}
function coerceOrchestratorHookConfig(value) {
  if (typeof value === "string") {
    const command2 = value.trim();
    return command2.length ? { command: command2 } : null;
  }
  if (!isRecord(value)) return null;
  const command = asString(value.command)?.trim() ?? "";
  if (!command.length) return null;
  const timeoutMs = asNumber(value.timeoutMs) ?? asNumber(value.timeout_ms);
  return {
    command,
    ...timeoutMs != null ? { timeoutMs: Math.max(1e3, Math.floor(timeoutMs)) } : {}
  };
}
function asStringMap(value) {
  if (!isRecord(value)) return void 0;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
function parseReadiness(value) {
  if (!isRecord(value)) return void 0;
  const type = asString(value.type);
  if (type === "port") {
    return { type, port: asNumber(value.port) };
  }
  if (type === "logRegex") {
    return { type, pattern: asString(value.pattern) };
  }
  if (type === "none") {
    return { type };
  }
  return void 0;
}
function coerceAutomationTrigger(value) {
  if (!isRecord(value)) return void 0;
  const typeRaw = asString(value.type)?.trim() ?? "";
  const type = typeRaw === "session-end" || typeRaw === "commit" || typeRaw === "schedule" || typeRaw === "manual" ? typeRaw : null;
  if (!type) return void 0;
  const out = { type };
  const cron2 = asString(value.cron);
  const branch = asString(value.branch);
  if (cron2 != null) out.cron = cron2;
  if (branch != null) out.branch = branch;
  return out;
}
function coerceAutomationAction(value) {
  if (!isRecord(value)) return null;
  const typeRaw = asString(value.type)?.trim() ?? "";
  const type = typeRaw === "update-packs" || typeRaw === "predict-conflicts" || typeRaw === "run-tests" || typeRaw === "run-command" ? typeRaw : null;
  if (!type) return null;
  const out = { type };
  const suiteId = asString(value.suiteId);
  const command = asString(value.command);
  const cwd = asString(value.cwd);
  const condition = asString(value.condition);
  const continueOnFailure = asBool(value.continueOnFailure);
  const timeoutMs = asNumber(value.timeoutMs);
  const retry = asNumber(value.retry);
  if (suiteId != null) out.suiteId = suiteId;
  if (command != null) out.command = command;
  if (cwd != null) out.cwd = cwd;
  if (condition != null) out.condition = condition;
  if (continueOnFailure != null) out.continueOnFailure = continueOnFailure;
  if (timeoutMs != null) out.timeoutMs = timeoutMs;
  if (retry != null) out.retry = retry;
  return out;
}
function coerceAutomationRule(value) {
  if (!isRecord(value)) return null;
  const id = asString(value.id)?.trim() ?? "";
  const out = { id };
  const name = asString(value.name);
  const enabled = asBool(value.enabled);
  const trigger = coerceAutomationTrigger(value.trigger);
  const actions = Array.isArray(value.actions) ? value.actions.map(coerceAutomationAction).filter((x) => x != null) : void 0;
  if (name != null) out.name = name;
  if (enabled != null) out.enabled = enabled;
  if (trigger != null) out.trigger = trigger;
  if (actions != null) out.actions = actions;
  return out;
}
function coerceProcessDef(value) {
  if (!isRecord(value)) return null;
  const id = asString(value.id)?.trim() ?? "";
  const out = { id };
  const name = asString(value.name);
  const command = asStringArray(value.command);
  const cwd = asString(value.cwd);
  const env = asStringMap(value.env);
  const autostart = asBool(value.autostart);
  const restart = asString(value.restart);
  const gracefulShutdownMs = asNumber(value.gracefulShutdownMs);
  const dependsOn = asStringArray(value.dependsOn);
  const readiness = parseReadiness(value.readiness);
  if (name != null) out.name = name;
  if (command != null) out.command = command;
  if (cwd != null) out.cwd = cwd;
  if (env != null) out.env = env;
  if (autostart != null) out.autostart = autostart;
  if (restart === "never" || restart === "on_crash" || restart === "on-failure" || restart === "always") out.restart = restart;
  if (gracefulShutdownMs != null) out.gracefulShutdownMs = gracefulShutdownMs;
  if (dependsOn != null) out.dependsOn = dependsOn;
  if (readiness != null) out.readiness = readiness;
  return out;
}
function coerceStackButton(value) {
  if (!isRecord(value)) return null;
  const id = asString(value.id)?.trim() ?? "";
  const out = { id };
  const name = asString(value.name);
  const processIds = asStringArray(value.processIds);
  const startOrder = asString(value.startOrder);
  if (name != null) out.name = name;
  if (processIds != null) out.processIds = processIds;
  if (startOrder === "parallel" || startOrder === "dependency") out.startOrder = startOrder;
  return out;
}
function coerceTestSuite(value) {
  if (!isRecord(value)) return null;
  const id = asString(value.id)?.trim() ?? "";
  const out = { id };
  const name = asString(value.name);
  const command = asStringArray(value.command);
  const cwd = asString(value.cwd);
  const env = asStringMap(value.env);
  const timeoutMs = asNumber(value.timeoutMs);
  const tags = asStringArray(value.tags);
  if (name != null) out.name = name;
  if (command != null) out.command = command;
  if (cwd != null) out.cwd = cwd;
  if (env != null) out.env = env;
  if (timeoutMs != null) out.timeoutMs = timeoutMs;
  if (tags != null) {
    out.tags = tags.filter(
      (tag) => tag === "unit" || tag === "lint" || tag === "integration" || tag === "e2e" || tag === "custom"
    );
  }
  return out;
}
function coerceEnvironmentMapping(value) {
  if (!isRecord(value)) return null;
  const branch = asString(value.branch)?.trim() ?? "";
  const env = asString(value.env)?.trim() ?? "";
  const color = asString(value.color)?.trim();
  if (!branch || !env) return null;
  const out = { branch, env };
  if (color) out.color = color;
  return out;
}
function coerceLaneOverlayPolicy(value) {
  if (!isRecord(value)) return null;
  const id = asString(value.id)?.trim() ?? "";
  const out = { id };
  const name = asString(value.name);
  const enabled = asBool(value.enabled);
  if (name != null) out.name = name;
  if (enabled != null) out.enabled = enabled;
  if (isRecord(value.match)) {
    const match = {};
    const laneIds = asStringArray(value.match.laneIds);
    const laneTypes = asLaneTypeArray(value.match.laneTypes);
    const namePattern = asString(value.match.namePattern);
    const branchPattern = asString(value.match.branchPattern);
    const tags = asStringArray(value.match.tags);
    if (laneIds != null) match.laneIds = laneIds;
    if (laneTypes != null) match.laneTypes = laneTypes;
    if (namePattern != null) match.namePattern = namePattern;
    if (branchPattern != null) match.branchPattern = branchPattern;
    if (tags != null) match.tags = tags;
    if (Object.keys(match).length > 0) out.match = match;
  }
  if (isRecord(value.overrides)) {
    const overrides = {};
    const env = asStringMap(value.overrides.env);
    const cwd = asString(value.overrides.cwd);
    const processIds = asStringArray(value.overrides.processIds);
    const testSuiteIds = asStringArray(value.overrides.testSuiteIds);
    if (env != null) overrides.env = env;
    if (cwd != null) overrides.cwd = cwd;
    if (processIds != null) overrides.processIds = processIds;
    if (testSuiteIds != null) overrides.testSuiteIds = testSuiteIds;
    if (Object.keys(overrides).length > 0) out.overrides = overrides;
  }
  return out;
}
var AI_TASK_KEYS = [
  "planning",
  "implementation",
  "review",
  "conflict_resolution",
  "narrative",
  "pr_description",
  "terminal_summary",
  "mission_planning",
  "initial_context"
];
var AI_FEATURE_KEYS = [
  "narratives",
  "conflict_proposals",
  "pr_descriptions",
  "terminal_summaries",
  "mission_planning",
  "orchestrator",
  "initial_context"
];
function coerceAiTaskRoutingRule(value) {
  if (!isRecord(value)) return null;
  const providerRaw = asString(value.provider)?.trim().toLowerCase();
  const provider = providerRaw === "auto" || providerRaw === "claude" || providerRaw === "codex" ? providerRaw : void 0;
  const model = asString(value.model);
  const timeoutMs = asNumber(value.timeoutMs) ?? asNumber(value.timeout_ms);
  const maxOutputTokens = asNumber(value.maxOutputTokens) ?? asNumber(value.max_output_tokens);
  const temperature = asNumber(value.temperature);
  const out = {};
  if (provider) out.provider = provider;
  if (model != null) out.model = model;
  if (timeoutMs != null) out.timeoutMs = timeoutMs;
  if (maxOutputTokens != null) out.maxOutputTokens = maxOutputTokens;
  if (temperature != null) out.temperature = temperature;
  return Object.keys(out).length ? out : null;
}
function coerceAiConfig(value) {
  if (!isRecord(value)) return void 0;
  const out = {};
  const mode = asString(value.mode)?.trim();
  if (mode === "guest" || mode === "subscription") {
    out.mode = mode;
  }
  const defaultProvider = (asString(value.defaultProvider) ?? asString(value.default_provider))?.trim().toLowerCase();
  if (defaultProvider === "auto" || defaultProvider === "claude" || defaultProvider === "codex") {
    out.defaultProvider = defaultProvider;
  }
  const taskRoutingRaw = isRecord(value.taskRouting) ? value.taskRouting : isRecord(value.task_routing) ? value.task_routing : null;
  if (taskRoutingRaw) {
    const routing = {};
    for (const taskKey of AI_TASK_KEYS) {
      const rule = coerceAiTaskRoutingRule(taskRoutingRaw[taskKey]);
      if (rule) routing[taskKey] = rule;
    }
    if (Object.keys(routing).length) out.taskRouting = routing;
  }
  const featuresRaw = isRecord(value.features) ? value.features : null;
  if (featuresRaw) {
    const features = {};
    for (const key of AI_FEATURE_KEYS) {
      const bool = asBool(featuresRaw[key]);
      if (bool != null) features[key] = bool;
    }
    if (Object.keys(features).length) out.features = features;
  }
  const budgetsRaw = isRecord(value.budgets) ? value.budgets : null;
  if (budgetsRaw) {
    const budgets = {};
    for (const key of AI_FEATURE_KEYS) {
      const entry = isRecord(budgetsRaw[key]) ? budgetsRaw[key] : null;
      if (!entry) continue;
      const dailyLimit = asNumber(entry.dailyLimit) ?? asNumber(entry.daily_limit);
      if (dailyLimit == null) continue;
      budgets[key] = { dailyLimit };
    }
    if (Object.keys(budgets).length) out.budgets = budgets;
  }
  const permissionsRaw = isRecord(value.permissions) ? value.permissions : null;
  if (permissionsRaw) {
    const permissions = {};
    const claude = isRecord(permissionsRaw.claude) ? permissionsRaw.claude : null;
    if (claude) {
      const entry = {};
      const permissionMode = (asString(claude.permissionMode) ?? asString(claude.permission_mode))?.trim();
      if (permissionMode === "default" || permissionMode === "acceptEdits" || permissionMode === "bypassPermissions" || permissionMode === "plan") {
        entry.permissionMode = permissionMode;
      }
      const settingsSources = Array.isArray(claude.settingsSources) ? claude.settingsSources : Array.isArray(claude.settings_sources) ? claude.settings_sources : null;
      if (settingsSources) {
        const normalized = settingsSources.map((item) => String(item).trim()).filter((item) => item === "user" || item === "project" || item === "local");
        if (normalized.length) entry.settingsSources = normalized;
      }
      const maxBudgetUsd = asNumber(claude.maxBudgetUsd) ?? asNumber(claude.max_budget_usd);
      if (maxBudgetUsd != null && maxBudgetUsd > 0) entry.maxBudgetUsd = maxBudgetUsd;
      const sandbox = asBool(claude.sandbox);
      if (sandbox != null) entry.sandbox = sandbox;
      const dangerouslySkipPermissions = asBool(claude.dangerouslySkipPermissions) ?? asBool(claude.dangerously_skip_permissions);
      if (dangerouslySkipPermissions != null) entry.dangerouslySkipPermissions = dangerouslySkipPermissions;
      const allowedTools = asStringArray(claude.allowedTools) ?? asStringArray(claude.allowed_tools);
      if (allowedTools?.length) entry.allowedTools = allowedTools;
      if (Object.keys(entry).length) permissions.claude = entry;
    }
    const codex = isRecord(permissionsRaw.codex) ? permissionsRaw.codex : null;
    if (codex) {
      const entry = {};
      const sandboxPermissions = (asString(codex.sandboxPermissions) ?? asString(codex.sandbox_permissions))?.trim();
      if (sandboxPermissions === "read-only" || sandboxPermissions === "workspace-write" || sandboxPermissions === "danger-full-access") {
        entry.sandboxPermissions = sandboxPermissions;
      }
      const approvalMode = (asString(codex.approvalMode) ?? asString(codex.approval_mode))?.trim();
      if (approvalMode === "untrusted" || approvalMode === "on-request" || approvalMode === "on-failure" || approvalMode === "never" || approvalMode === "suggest" || approvalMode === "auto-edit" || approvalMode === "full-auto") {
        entry.approvalMode = approvalMode;
      }
      const writablePaths = asStringArray(codex.writablePaths) ?? asStringArray(codex.writable_paths);
      if (writablePaths?.length) entry.writablePaths = writablePaths;
      const commandAllowlist = asStringArray(codex.commandAllowlist) ?? asStringArray(codex.command_allowlist);
      if (commandAllowlist?.length) entry.commandAllowlist = commandAllowlist;
      const configPath = asString(codex.configPath) ?? asString(codex.config_path);
      if (configPath) entry.configPath = configPath;
      if (Object.keys(entry).length) permissions.codex = entry;
    }
    if (Object.keys(permissions).length) out.permissions = permissions;
  }
  const conflictRaw = isRecord(value.conflictResolution) ? value.conflictResolution : isRecord(value.conflict_resolution) ? value.conflict_resolution : null;
  if (conflictRaw) {
    const conflict = {};
    const changeTarget = (asString(conflictRaw.changeTarget) ?? asString(conflictRaw.change_target))?.trim();
    if (changeTarget === "target" || changeTarget === "source" || changeTarget === "ai_decides") {
      conflict.changeTarget = changeTarget;
    }
    const postResolution = (asString(conflictRaw.postResolution) ?? asString(conflictRaw.post_resolution))?.trim();
    if (postResolution === "unstaged" || postResolution === "staged" || postResolution === "commit") {
      conflict.postResolution = postResolution;
    }
    const prBehavior = (asString(conflictRaw.prBehavior) ?? asString(conflictRaw.pr_behavior))?.trim();
    if (prBehavior === "do_nothing" || prBehavior === "open_pr" || prBehavior === "add_to_existing") {
      conflict.prBehavior = prBehavior;
    }
    const autonomy = asString(conflictRaw.autonomy)?.trim();
    if (autonomy === "propose_only" || autonomy === "auto_apply") {
      conflict.autonomy = autonomy;
    }
    const threshold = asNumber(conflictRaw.autoApplyThreshold) ?? asNumber(conflictRaw.auto_apply_threshold);
    if (threshold != null) conflict.autoApplyThreshold = threshold;
    if (Object.keys(conflict).length) out.conflictResolution = conflict;
  }
  const orchestratorRaw = isRecord(value.orchestrator) ? value.orchestrator : null;
  if (orchestratorRaw) {
    const orchestrator = {};
    const teammatePlanMode = (asString(orchestratorRaw.teammatePlanMode) ?? asString(orchestratorRaw.teammate_plan_mode))?.trim();
    if (teammatePlanMode === "off" || teammatePlanMode === "auto" || teammatePlanMode === "required") {
      orchestrator.teammatePlanMode = teammatePlanMode;
    }
    const requirePlanReview = asBool(orchestratorRaw.requirePlanReview) ?? asBool(orchestratorRaw.require_plan_review);
    if (requirePlanReview != null) orchestrator.requirePlanReview = requirePlanReview;
    const maxParallelWorkers = asNumber(orchestratorRaw.maxParallelWorkers) ?? asNumber(orchestratorRaw.max_parallel_workers);
    if (maxParallelWorkers != null) orchestrator.maxParallelWorkers = Math.max(1, Math.floor(maxParallelWorkers));
    const defaultMergePolicy = (asString(orchestratorRaw.defaultMergePolicy) ?? asString(orchestratorRaw.default_merge_policy))?.trim();
    if (defaultMergePolicy === "sequential" || defaultMergePolicy === "batch-at-end" || defaultMergePolicy === "per-step") {
      orchestrator.defaultMergePolicy = defaultMergePolicy;
    }
    const defaultConflictHandoff = (asString(orchestratorRaw.defaultConflictHandoff) ?? asString(orchestratorRaw.default_conflict_handoff))?.trim();
    if (defaultConflictHandoff === "auto-resolve" || defaultConflictHandoff === "ask-user" || defaultConflictHandoff === "orchestrator-decides") {
      orchestrator.defaultConflictHandoff = defaultConflictHandoff;
    }
    const workerHeartbeatIntervalMs = asNumber(orchestratorRaw.workerHeartbeatIntervalMs) ?? asNumber(orchestratorRaw.worker_heartbeat_interval_ms);
    if (workerHeartbeatIntervalMs != null) orchestrator.workerHeartbeatIntervalMs = Math.max(1e3, Math.floor(workerHeartbeatIntervalMs));
    const workerHeartbeatTimeoutMs = asNumber(orchestratorRaw.workerHeartbeatTimeoutMs) ?? asNumber(orchestratorRaw.worker_heartbeat_timeout_ms);
    if (workerHeartbeatTimeoutMs != null) orchestrator.workerHeartbeatTimeoutMs = Math.max(1e3, Math.floor(workerHeartbeatTimeoutMs));
    const workerIdleTimeoutMs = asNumber(orchestratorRaw.workerIdleTimeoutMs) ?? asNumber(orchestratorRaw.worker_idle_timeout_ms);
    if (workerIdleTimeoutMs != null) orchestrator.workerIdleTimeoutMs = Math.max(1e3, Math.floor(workerIdleTimeoutMs));
    const stepTimeoutDefaultMs = asNumber(orchestratorRaw.stepTimeoutDefaultMs) ?? asNumber(orchestratorRaw.step_timeout_default_ms);
    if (stepTimeoutDefaultMs != null) orchestrator.stepTimeoutDefaultMs = Math.max(1e3, Math.floor(stepTimeoutDefaultMs));
    const maxRetriesPerStep = asNumber(orchestratorRaw.maxRetriesPerStep) ?? asNumber(orchestratorRaw.max_retries_per_step);
    if (maxRetriesPerStep != null) orchestrator.maxRetriesPerStep = Math.max(0, Math.floor(maxRetriesPerStep));
    const contextPressureThreshold = asNumber(orchestratorRaw.contextPressureThreshold) ?? asNumber(orchestratorRaw.context_pressure_threshold);
    if (contextPressureThreshold != null) orchestrator.contextPressureThreshold = Math.max(0.1, Math.min(0.99, contextPressureThreshold));
    const progressiveLoading = asBool(orchestratorRaw.progressiveLoading) ?? asBool(orchestratorRaw.progressive_loading);
    if (progressiveLoading != null) orchestrator.progressiveLoading = progressiveLoading;
    const maxTotalTokenBudget = asNumber(orchestratorRaw.maxTotalTokenBudget) ?? asNumber(orchestratorRaw.max_total_token_budget);
    if (maxTotalTokenBudget != null && maxTotalTokenBudget > 0) orchestrator.maxTotalTokenBudget = maxTotalTokenBudget;
    const maxPerStepTokenBudget = asNumber(orchestratorRaw.maxPerStepTokenBudget) ?? asNumber(orchestratorRaw.max_per_step_token_budget);
    if (maxPerStepTokenBudget != null && maxPerStepTokenBudget > 0) orchestrator.maxPerStepTokenBudget = maxPerStepTokenBudget;
    const defaultExecutionPolicy = isRecord(orchestratorRaw.defaultExecutionPolicy) ? orchestratorRaw.defaultExecutionPolicy : isRecord(orchestratorRaw.default_execution_policy) ? orchestratorRaw.default_execution_policy : null;
    if (defaultExecutionPolicy) {
      orchestrator.defaultExecutionPolicy = defaultExecutionPolicy;
    }
    const defaultDepthTier = (asString(orchestratorRaw.defaultDepthTier) ?? asString(orchestratorRaw.default_depth_tier))?.trim();
    if (defaultDepthTier === "light" || defaultDepthTier === "standard" || defaultDepthTier === "deep") {
      orchestrator.defaultDepthTier = defaultDepthTier;
    }
    const defaultPlannerProvider = (asString(orchestratorRaw.defaultPlannerProvider) ?? asString(orchestratorRaw.default_planner_provider))?.trim();
    if (defaultPlannerProvider === "auto" || defaultPlannerProvider === "claude" || defaultPlannerProvider === "codex") {
      orchestrator.defaultPlannerProvider = defaultPlannerProvider;
    }
    const autoResolveInterventions = asBool(orchestratorRaw.autoResolveInterventions) ?? asBool(orchestratorRaw.auto_resolve_interventions);
    if (autoResolveInterventions != null) orchestrator.autoResolveInterventions = autoResolveInterventions;
    const interventionConfidenceThreshold = asNumber(orchestratorRaw.interventionConfidenceThreshold) ?? asNumber(orchestratorRaw.intervention_confidence_threshold);
    if (interventionConfidenceThreshold != null) {
      orchestrator.interventionConfidenceThreshold = Math.max(0, Math.min(1, interventionConfidenceThreshold));
    }
    const hooksRaw = isRecord(orchestratorRaw.hooks) ? orchestratorRaw.hooks : null;
    if (hooksRaw) {
      const hooks = {};
      const teammateIdle = coerceOrchestratorHookConfig(
        hooksRaw.TeammateIdle ?? hooksRaw.teammateIdle ?? hooksRaw.teammate_idle
      );
      if (teammateIdle) hooks.TeammateIdle = teammateIdle;
      const taskCompleted = coerceOrchestratorHookConfig(
        hooksRaw.TaskCompleted ?? hooksRaw.taskCompleted ?? hooksRaw.task_completed
      );
      if (taskCompleted) hooks.TaskCompleted = taskCompleted;
      if (Object.keys(hooks).length) orchestrator.hooks = hooks;
    }
    if (Object.keys(orchestrator).length) out.orchestrator = orchestrator;
  }
  return Object.keys(out).length ? out : void 0;
}
function mergeAiConfig(sharedAi, localAi) {
  if (!sharedAi && !localAi) return void 0;
  const taskRouting = {
    ...sharedAi?.taskRouting ?? {},
    ...localAi?.taskRouting ?? {}
  };
  const features = {
    ...sharedAi?.features ?? {},
    ...localAi?.features ?? {}
  };
  const budgets = {
    ...sharedAi?.budgets ?? {},
    ...localAi?.budgets ?? {}
  };
  const permissions = {
    ...sharedAi?.permissions ?? {},
    ...localAi?.permissions ?? {}
  };
  const conflictResolution = {
    ...sharedAi?.conflictResolution ?? {},
    ...localAi?.conflictResolution ?? {}
  };
  const orchestrator = {
    ...sharedAi?.orchestrator ?? {},
    ...localAi?.orchestrator ?? {}
  };
  const out = {
    mode: localAi?.mode ?? sharedAi?.mode,
    defaultProvider: localAi?.defaultProvider ?? sharedAi?.defaultProvider,
    ...Object.keys(taskRouting).length ? { taskRouting } : {},
    ...Object.keys(features).length ? { features } : {},
    ...Object.keys(budgets).length ? { budgets } : {},
    ...Object.keys(permissions).length ? { permissions } : {},
    ...Object.keys(conflictResolution).length ? { conflictResolution } : {},
    ...Object.keys(orchestrator).length ? { orchestrator } : {}
  };
  return Object.keys(out).length ? out : void 0;
}
function coerceConfigFile(value) {
  if (!isRecord(value)) {
    return { version: VERSION, processes: [], stackButtons: [], testSuites: [], laneOverlayPolicies: [], automations: [] };
  }
  const version = asNumber(value.version) ?? VERSION;
  const processes = Array.isArray(value.processes) ? value.processes.map(coerceProcessDef).filter((x) => x != null) : [];
  const stackButtons = Array.isArray(value.stackButtons) ? value.stackButtons.map(coerceStackButton).filter((x) => x != null) : [];
  const testSuites = Array.isArray(value.testSuites) ? value.testSuites.map(coerceTestSuite).filter((x) => x != null) : [];
  const laneOverlayPolicies = Array.isArray(value.laneOverlayPolicies) ? value.laneOverlayPolicies.map(coerceLaneOverlayPolicy).filter((x) => x != null) : [];
  const automations = Array.isArray(value.automations) ? value.automations.map(coerceAutomationRule).filter((x) => x != null) : [];
  const environments = Array.isArray(value.environments) ? value.environments.map(coerceEnvironmentMapping).filter((x) => x != null) : [];
  const github = isRecord(value.github) && asNumber(value.github.prPollingIntervalSeconds) != null ? {
    ...asNumber(value.github.prPollingIntervalSeconds) != null ? { prPollingIntervalSeconds: asNumber(value.github.prPollingIntervalSeconds) } : {}
  } : void 0;
  const git = isRecord(value.git) && asBool(value.git.autoRebaseOnHeadChange) != null ? {
    ...asBool(value.git.autoRebaseOnHeadChange) != null ? { autoRebaseOnHeadChange: asBool(value.git.autoRebaseOnHeadChange) } : {}
  } : void 0;
  const providersRaw = isRecord(value.providers) ? { ...value.providers } : void 0;
  const legacyAi = providersRaw ? coerceAiConfig(providersRaw.ai) : void 0;
  const legacyModeRaw = asString(providersRaw?.mode)?.trim().toLowerCase() ?? "";
  const legacyMode = legacyModeRaw === "guest" ? "guest" : legacyModeRaw === "subscription" || legacyModeRaw === "hosted" || legacyModeRaw === "byok" ? "subscription" : void 0;
  let ai = coerceAiConfig(value.ai) ?? legacyAi;
  if (legacyMode != null) {
    ai = {
      ...ai ?? {},
      mode: ai?.mode ?? legacyMode
    };
  }
  if (providersRaw) {
    delete providersRaw.mode;
    delete providersRaw.ai;
  }
  return {
    version,
    processes,
    stackButtons,
    testSuites,
    laneOverlayPolicies,
    automations,
    ...environments.length ? { environments } : {},
    ...github ? { github } : {},
    ...git ? { git } : {},
    ...ai ? { ai } : {},
    ...providersRaw && Object.keys(providersRaw).length ? { providers: providersRaw } : {}
  };
}
function readConfigFile(filePath) {
  try {
    const raw = import_node_fs6.default.readFileSync(filePath, "utf8");
    if (!raw.trim().length) {
      return {
        config: { version: VERSION, processes: [], stackButtons: [], testSuites: [], laneOverlayPolicies: [], automations: [] },
        raw
      };
    }
    const parsed = import_yaml.default.parse(raw);
    return { config: coerceConfigFile(parsed), raw };
  } catch (err) {
    if (err?.code === "ENOENT") {
      return {
        config: { version: VERSION, processes: [], stackButtons: [], testSuites: [], laneOverlayPolicies: [], automations: [] },
        raw: ""
      };
    }
    throw err;
  }
}
function toCanonicalYaml(config) {
  const normalized = {
    version: VERSION,
    processes: config.processes ?? [],
    stackButtons: config.stackButtons ?? [],
    testSuites: config.testSuites ?? [],
    laneOverlayPolicies: config.laneOverlayPolicies ?? [],
    automations: config.automations ?? [],
    ...config.environments ? { environments: config.environments } : {},
    ...config.github ? { github: config.github } : {},
    ...config.git ? { git: config.git } : {},
    ...config.ai ? { ai: config.ai } : {},
    ...config.providers ? { providers: config.providers } : {}
  };
  return import_yaml.default.stringify(normalized, { indent: 2 });
}
function hashContent(content) {
  return (0, import_node_crypto4.createHash)("sha256").update(content).digest("hex");
}
function createDefId(projectId, key) {
  return `${projectId}:${key}`;
}
function mergeById(base = [], local = [], merge) {
  const out = [];
  const indexById = /* @__PURE__ */ new Map();
  for (const entry of base) {
    const id = (entry.id ?? "").trim();
    if (!id) continue;
    if (indexById.has(id)) continue;
    indexById.set(id, out.length);
    out.push(entry);
  }
  for (const entry of local) {
    const id = (entry.id ?? "").trim();
    if (!id) continue;
    const idx = indexById.get(id);
    if (idx == null) {
      indexById.set(id, out.length);
      out.push(entry);
      continue;
    }
    out[idx] = merge(out[idx], entry);
  }
  return out;
}
function resolveReadiness(readiness) {
  if (!readiness) return { type: "none" };
  if (readiness.type === "port") return { type: "port", port: Number(readiness.port ?? 0) };
  if (readiness.type === "logRegex") return { type: "logRegex", pattern: readiness.pattern ?? "" };
  return { type: "none" };
}
function resolveEffectiveConfig(shared, local) {
  const mergedProcesses = mergeById(shared.processes ?? [], local.processes ?? [], (base, over) => ({
    ...base,
    ...over,
    ...base.env || over.env ? { env: { ...base.env ?? {}, ...over.env ?? {} } } : {},
    ...over.readiness != null ? { readiness: over.readiness } : base.readiness != null ? { readiness: base.readiness } : {},
    ...over.dependsOn != null ? { dependsOn: over.dependsOn } : base.dependsOn != null ? { dependsOn: base.dependsOn } : {}
  }));
  const mergedStackButtons = mergeById(shared.stackButtons ?? [], local.stackButtons ?? [], (base, over) => ({
    ...base,
    ...over,
    ...over.processIds != null ? { processIds: over.processIds } : base.processIds != null ? { processIds: base.processIds } : {}
  }));
  const mergedSuites = mergeById(shared.testSuites ?? [], local.testSuites ?? [], (base, over) => ({
    ...base,
    ...over,
    ...base.env || over.env ? { env: { ...base.env ?? {}, ...over.env ?? {} } } : {}
  }));
  const mergedLaneOverlayPolicies = mergeById(
    shared.laneOverlayPolicies ?? [],
    local.laneOverlayPolicies ?? [],
    (base, over) => ({
      ...base,
      ...over,
      ...base.match || over.match ? { match: { ...base.match ?? {}, ...over.match ?? {} } } : {},
      ...base.overrides || over.overrides ? { overrides: { ...base.overrides ?? {}, ...over.overrides ?? {} } } : {}
    })
  );
  const mergedAutomations = mergeById(shared.automations ?? [], local.automations ?? [], (base, over) => ({
    ...base,
    ...over,
    ...over.trigger != null ? { trigger: over.trigger } : base.trigger != null ? { trigger: base.trigger } : {},
    ...over.actions != null ? { actions: over.actions } : base.actions != null ? { actions: base.actions } : {}
  }));
  const processes = mergedProcesses.map((entry) => ({
    id: entry.id.trim(),
    name: entry.name?.trim() ?? "",
    command: (entry.command ?? []).map((c) => c.trim()).filter(Boolean),
    cwd: entry.cwd?.trim() ?? "",
    env: entry.env ?? {},
    autostart: entry.autostart ?? false,
    restart: entry.restart ?? "never",
    gracefulShutdownMs: entry.gracefulShutdownMs ?? DEFAULT_GRACEFUL_MS,
    dependsOn: (entry.dependsOn ?? []).map((d) => d.trim()).filter(Boolean),
    readiness: resolveReadiness(entry.readiness)
  }));
  const stackButtons = mergedStackButtons.map((entry) => ({
    id: entry.id.trim(),
    name: entry.name?.trim() ?? "",
    processIds: (entry.processIds ?? []).map((id) => id.trim()).filter(Boolean),
    startOrder: entry.startOrder ?? "parallel"
  }));
  const testSuites = mergedSuites.map((entry) => ({
    id: entry.id.trim(),
    name: entry.name?.trim() ?? "",
    command: (entry.command ?? []).map((c) => c.trim()).filter(Boolean),
    cwd: entry.cwd?.trim() ?? "",
    env: entry.env ?? {},
    timeoutMs: entry.timeoutMs ?? null,
    tags: entry.tags ?? []
  }));
  const laneOverlayPolicies = mergedLaneOverlayPolicies.map((entry) => ({
    id: entry.id.trim(),
    name: entry.name?.trim() ?? entry.id.trim(),
    enabled: entry.enabled ?? true,
    match: {
      ...entry.match?.laneIds ? { laneIds: entry.match.laneIds.map((v) => v.trim()).filter(Boolean) } : {},
      ...entry.match?.laneTypes ? { laneTypes: entry.match.laneTypes } : {},
      ...entry.match?.namePattern ? { namePattern: entry.match.namePattern.trim() } : {},
      ...entry.match?.branchPattern ? { branchPattern: entry.match.branchPattern.trim() } : {},
      ...entry.match?.tags ? { tags: entry.match.tags.map((v) => v.trim()).filter(Boolean) } : {}
    },
    overrides: {
      ...entry.overrides?.env ? { env: entry.overrides.env } : {},
      ...entry.overrides?.cwd ? { cwd: entry.overrides.cwd.trim() } : {},
      ...entry.overrides?.processIds ? { processIds: entry.overrides.processIds.map((v) => v.trim()).filter(Boolean) } : {},
      ...entry.overrides?.testSuiteIds ? { testSuiteIds: entry.overrides.testSuiteIds.map((v) => v.trim()).filter(Boolean) } : {}
    }
  }));
  const automations = mergedAutomations.map((entry) => ({
    id: entry.id.trim(),
    name: entry.name?.trim() ?? entry.id.trim(),
    trigger: {
      type: entry.trigger?.type ?? "manual",
      ...entry.trigger?.cron ? { cron: entry.trigger.cron.trim() } : {},
      ...entry.trigger?.branch ? { branch: entry.trigger.branch.trim() } : {}
    },
    actions: (entry.actions ?? []).map((action) => ({
      type: action.type,
      ...action.suiteId ? { suiteId: action.suiteId.trim() } : {},
      ...action.command ? { command: action.command } : {},
      ...action.cwd ? { cwd: action.cwd.trim() } : {},
      ...action.condition ? { condition: action.condition.trim() } : {},
      ...action.continueOnFailure != null ? { continueOnFailure: action.continueOnFailure } : {},
      ...action.timeoutMs != null ? { timeoutMs: action.timeoutMs } : {},
      ...action.retry != null ? { retry: action.retry } : {}
    })),
    enabled: entry.enabled ?? true
  }));
  const mergedProviders = shared.providers || local.providers ? {
    ...shared.providers ?? {},
    ...local.providers ?? {}
  } : void 0;
  const mergedGithub = shared.github || local.github ? {
    ...shared.github ?? {},
    ...local.github ?? {}
  } : void 0;
  const mergedGit = shared.git || local.git ? {
    ...shared.git ?? {},
    ...local.git ?? {}
  } : void 0;
  const mergedAi = mergeAiConfig(shared.ai, local.ai);
  const environments = [...shared.environments ?? [], ...local.environments ?? []];
  const legacyModeRaw = typeof mergedProviders?.mode === "string" ? String(mergedProviders.mode).trim().toLowerCase() : "";
  const aiModeRaw = typeof mergedAi?.mode === "string" ? String(mergedAi.mode).trim().toLowerCase() : "";
  const providerMode = (() => {
    const resolved = aiModeRaw || legacyModeRaw;
    if (resolved === "guest") return "guest";
    if (resolved === "subscription" || resolved === "hosted" || resolved === "byok") return "subscription";
    return "guest";
  })();
  const effectiveAi = mergedAi ? {
    ...mergedAi,
    mode: providerMode
  } : void 0;
  return {
    version: VERSION,
    processes,
    stackButtons,
    testSuites,
    laneOverlayPolicies,
    automations,
    ...environments.length ? { environments } : {},
    providerMode,
    ...mergedGithub ? { github: mergedGithub } : {},
    git: {
      autoRebaseOnHeadChange: mergedGit?.autoRebaseOnHeadChange ?? false
    },
    ...effectiveAi ? { ai: effectiveAi } : {},
    ...mergedProviders ? { providers: mergedProviders } : {}
  };
}
function validateDuplicateIds(values, sectionPath, issues, fileLabel) {
  const seen = /* @__PURE__ */ new Set();
  for (let i = 0; i < values.length; i++) {
    const id = (values[i]?.id ?? "").trim();
    if (!id) continue;
    if (seen.has(id)) {
      issues.push({ path: `${fileLabel}.${sectionPath}[${i}].id`, message: `Duplicate id '${id}'` });
      continue;
    }
    seen.add(id);
  }
}
function isDirectory(absPath) {
  try {
    return import_node_fs6.default.statSync(absPath).isDirectory();
  } catch {
    return false;
  }
}
function validateProcessCycles(processes, issues) {
  const byId2 = new Map(processes.map((p) => [p.id, p]));
  const visited = /* @__PURE__ */ new Set();
  const inStack = /* @__PURE__ */ new Set();
  const dfs = (id) => {
    if (inStack.has(id)) return true;
    if (visited.has(id)) return false;
    visited.add(id);
    inStack.add(id);
    const proc = byId2.get(id);
    if (proc) {
      for (const dep of proc.dependsOn) {
        if (!byId2.has(dep)) continue;
        if (dfs(dep)) return true;
      }
    }
    inStack.delete(id);
    return false;
  };
  for (const id of byId2.keys()) {
    if (dfs(id)) {
      issues.push({ path: "effective.processes", message: `Cyclic dependsOn graph detected around '${id}'` });
      return;
    }
  }
}
function validateEffectiveConfig(effective, projectRoot, shared, local) {
  const issues = [];
  validateDuplicateIds(shared.processes ?? [], "processes", issues, "shared");
  validateDuplicateIds(local.processes ?? [], "processes", issues, "local");
  validateDuplicateIds(shared.stackButtons ?? [], "stackButtons", issues, "shared");
  validateDuplicateIds(local.stackButtons ?? [], "stackButtons", issues, "local");
  validateDuplicateIds(shared.testSuites ?? [], "testSuites", issues, "shared");
  validateDuplicateIds(local.testSuites ?? [], "testSuites", issues, "local");
  validateDuplicateIds(shared.laneOverlayPolicies ?? [], "laneOverlayPolicies", issues, "shared");
  validateDuplicateIds(local.laneOverlayPolicies ?? [], "laneOverlayPolicies", issues, "local");
  validateDuplicateIds(shared.automations ?? [], "automations", issues, "shared");
  validateDuplicateIds(local.automations ?? [], "automations", issues, "local");
  const prPoll = effective.github?.prPollingIntervalSeconds;
  if (prPoll != null) {
    if (!Number.isFinite(prPoll) || prPoll <= 0) {
      issues.push({ path: "effective.github.prPollingIntervalSeconds", message: "prPollingIntervalSeconds must be > 0" });
    } else if (prPoll < 5 || prPoll > 300) {
      issues.push({ path: "effective.github.prPollingIntervalSeconds", message: "prPollingIntervalSeconds must be between 5 and 300" });
    }
  }
  if (effective.environments?.length) {
    for (const [idx, mapping] of effective.environments.entries()) {
      const p = `effective.environments[${idx}]`;
      if (!mapping.branch.trim()) issues.push({ path: `${p}.branch`, message: "Environment mapping branch is required" });
      if (!mapping.env.trim()) issues.push({ path: `${p}.env`, message: "Environment mapping env is required" });
      if (mapping.color != null && mapping.color.trim().length) {
        const color = mapping.color.trim();
        if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
          issues.push({ path: `${p}.color`, message: "Environment color must be a hex string like #22c55e" });
        }
      }
    }
  }
  const processIds = /* @__PURE__ */ new Set();
  for (const [idx, proc] of effective.processes.entries()) {
    const p = `effective.processes[${idx}]`;
    if (!proc.id) {
      issues.push({ path: `${p}.id`, message: "Process id is required" });
    } else if (processIds.has(proc.id)) {
      issues.push({ path: `${p}.id`, message: `Duplicate process id '${proc.id}'` });
    } else {
      processIds.add(proc.id);
    }
    if (!proc.name) issues.push({ path: `${p}.name`, message: "Process name is required" });
    if (!proc.command.length) issues.push({ path: `${p}.command`, message: "Process command must be a non-empty argv array" });
    if (!proc.cwd) issues.push({ path: `${p}.cwd`, message: "Process cwd is required" });
    if (!Number.isFinite(proc.gracefulShutdownMs) || proc.gracefulShutdownMs <= 0) {
      issues.push({ path: `${p}.gracefulShutdownMs`, message: "gracefulShutdownMs must be > 0" });
    }
    const absCwd = import_node_path5.default.isAbsolute(proc.cwd) ? proc.cwd : import_node_path5.default.join(projectRoot, proc.cwd);
    if (proc.cwd && !isDirectory(absCwd)) {
      issues.push({ path: `${p}.cwd`, message: `cwd does not exist: ${proc.cwd}` });
    }
    if (proc.readiness.type === "port") {
      if (!Number.isInteger(proc.readiness.port) || proc.readiness.port < 1 || proc.readiness.port > 65535) {
        issues.push({ path: `${p}.readiness.port`, message: "Port readiness requires a valid port (1-65535)" });
      }
    }
    if (proc.readiness.type === "logRegex") {
      if (!proc.readiness.pattern) {
        issues.push({ path: `${p}.readiness.pattern`, message: "logRegex readiness requires a pattern" });
      } else {
        try {
          new RegExp(proc.readiness.pattern);
        } catch {
          issues.push({ path: `${p}.readiness.pattern`, message: "Invalid readiness regex pattern" });
        }
      }
    }
  }
  for (const [idx, proc] of effective.processes.entries()) {
    const p = `effective.processes[${idx}]`;
    for (const dep of proc.dependsOn) {
      if (!processIds.has(dep)) {
        issues.push({ path: `${p}.dependsOn`, message: `Unknown dependency '${dep}'` });
      }
    }
  }
  validateProcessCycles(effective.processes, issues);
  const stackIds = /* @__PURE__ */ new Set();
  for (const [idx, stack] of effective.stackButtons.entries()) {
    const p = `effective.stackButtons[${idx}]`;
    if (!stack.id) {
      issues.push({ path: `${p}.id`, message: "Stack button id is required" });
    } else if (stackIds.has(stack.id)) {
      issues.push({ path: `${p}.id`, message: `Duplicate stack button id '${stack.id}'` });
    } else {
      stackIds.add(stack.id);
    }
    if (!stack.name) issues.push({ path: `${p}.name`, message: "Stack button name is required" });
    for (const processId of stack.processIds) {
      if (!processIds.has(processId)) {
        issues.push({ path: `${p}.processIds`, message: `Unknown process id '${processId}'` });
      }
    }
  }
  const suiteIds = /* @__PURE__ */ new Set();
  for (const [idx, suite] of effective.testSuites.entries()) {
    const p = `effective.testSuites[${idx}]`;
    if (!suite.id) {
      issues.push({ path: `${p}.id`, message: "Test suite id is required" });
    } else if (suiteIds.has(suite.id)) {
      issues.push({ path: `${p}.id`, message: `Duplicate test suite id '${suite.id}'` });
    } else {
      suiteIds.add(suite.id);
    }
    if (!suite.name) issues.push({ path: `${p}.name`, message: "Test suite name is required" });
    if (!suite.command.length) issues.push({ path: `${p}.command`, message: "Test suite command must be a non-empty argv array" });
    if (!suite.cwd) issues.push({ path: `${p}.cwd`, message: "Test suite cwd is required" });
    const absCwd = import_node_path5.default.isAbsolute(suite.cwd) ? suite.cwd : import_node_path5.default.join(projectRoot, suite.cwd);
    if (suite.cwd && !isDirectory(absCwd)) {
      issues.push({ path: `${p}.cwd`, message: `cwd does not exist: ${suite.cwd}` });
    }
    if (suite.timeoutMs != null && (!Number.isFinite(suite.timeoutMs) || suite.timeoutMs <= 0)) {
      issues.push({ path: `${p}.timeoutMs`, message: "timeoutMs must be > 0 when provided" });
    }
  }
  const overlayIds = /* @__PURE__ */ new Set();
  for (const [idx, policy] of effective.laneOverlayPolicies.entries()) {
    const p = `effective.laneOverlayPolicies[${idx}]`;
    if (!policy.id) {
      issues.push({ path: `${p}.id`, message: "Lane overlay policy id is required" });
      continue;
    }
    if (overlayIds.has(policy.id)) {
      issues.push({ path: `${p}.id`, message: `Duplicate lane overlay policy id '${policy.id}'` });
    } else {
      overlayIds.add(policy.id);
    }
    if (!policy.name) {
      issues.push({ path: `${p}.name`, message: "Lane overlay policy name is required" });
    }
    const overrideCwd = policy.overrides.cwd;
    if (overrideCwd) {
      const absCwd = import_node_path5.default.isAbsolute(overrideCwd) ? overrideCwd : import_node_path5.default.join(projectRoot, overrideCwd);
      if (!isDirectory(absCwd)) {
        issues.push({ path: `${p}.overrides.cwd`, message: `cwd override does not exist: ${overrideCwd}` });
      }
    }
    for (const processId of policy.overrides.processIds ?? []) {
      if (!processIds.has(processId)) {
        issues.push({ path: `${p}.overrides.processIds`, message: `Unknown process id '${processId}'` });
      }
    }
    for (const suiteId of policy.overrides.testSuiteIds ?? []) {
      if (!suiteIds.has(suiteId)) {
        issues.push({ path: `${p}.overrides.testSuiteIds`, message: `Unknown test suite id '${suiteId}'` });
      }
    }
  }
  const automationIds = /* @__PURE__ */ new Set();
  for (const [idx, rule] of effective.automations.entries()) {
    const p = `effective.automations[${idx}]`;
    if (!rule.id) {
      issues.push({ path: `${p}.id`, message: "Automation id is required" });
      continue;
    }
    if (automationIds.has(rule.id)) {
      issues.push({ path: `${p}.id`, message: `Duplicate automation id '${rule.id}'` });
    } else {
      automationIds.add(rule.id);
    }
    if (!rule.name) issues.push({ path: `${p}.name`, message: "Automation name is required" });
    if (!rule.enabled) continue;
    const triggerType = rule.trigger?.type;
    if (triggerType !== "session-end" && triggerType !== "commit" && triggerType !== "schedule" && triggerType !== "manual") {
      issues.push({ path: `${p}.trigger.type`, message: "Invalid trigger type" });
    }
    if (triggerType === "schedule") {
      const expr = (rule.trigger?.cron ?? "").trim();
      if (!expr) {
        issues.push({ path: `${p}.trigger.cron`, message: "Schedule trigger requires cron" });
      } else if (!import_node_cron.default.validate(expr)) {
        issues.push({ path: `${p}.trigger.cron`, message: `Invalid cron expression '${expr}'` });
      }
    }
    if (!rule.actions.length) {
      issues.push({ path: `${p}.actions`, message: "Enabled automation must have at least one action" });
      continue;
    }
    for (let actionIdx = 0; actionIdx < rule.actions.length; actionIdx += 1) {
      const action = rule.actions[actionIdx];
      const ap = `${p}.actions[${actionIdx}]`;
      const type = action.type;
      if (type !== "update-packs" && type !== "predict-conflicts" && type !== "run-tests" && type !== "run-command") {
        issues.push({ path: `${ap}.type`, message: `Unknown action type '${String(action.type)}'` });
        continue;
      }
      if (type === "run-tests") {
        const suiteId = (action.suiteId ?? "").trim();
        if (!suiteId) {
          issues.push({ path: `${ap}.suiteId`, message: "run-tests requires suiteId" });
        } else if (!suiteIds.has(suiteId)) {
          issues.push({ path: `${ap}.suiteId`, message: `Unknown suiteId '${suiteId}'` });
        }
      }
      if (type === "run-command") {
        const command = (action.command ?? "").trim();
        if (!command) {
          issues.push({ path: `${ap}.command`, message: "run-command requires command" });
        }
      }
      if (action.timeoutMs != null && (!Number.isFinite(action.timeoutMs) || action.timeoutMs <= 0)) {
        issues.push({ path: `${ap}.timeoutMs`, message: "timeoutMs must be > 0 when provided" });
      }
      if (action.retry != null && (!Number.isFinite(action.retry) || action.retry < 0)) {
        issues.push({ path: `${ap}.retry`, message: "retry must be >= 0 when provided" });
      }
    }
  }
  return {
    ok: issues.length === 0,
    issues
  };
}
function trustError(sharedHash) {
  const err = new Error(
    `ADE_TRUST_REQUIRED: Shared config changed and must be confirmed before execution (sharedHash=${sharedHash})`
  );
  err.code = "ADE_TRUST_REQUIRED";
  return err;
}
function invalidConfigError(validation) {
  const first = validation.issues[0];
  const msg = first ? `${first.path}: ${first.message}` : "Unknown config validation failure";
  const err = new Error(`ADE_CONFIG_INVALID: ${msg}`);
  err.code = "ADE_CONFIG_INVALID";
  return err;
}
function createProjectConfigService({
  projectRoot,
  adeDir,
  projectId,
  db,
  logger
}) {
  const sharedPath = import_node_path5.default.join(adeDir, "ade.yaml");
  const localPath = import_node_path5.default.join(adeDir, "local.yaml");
  let lastSeenSharedHash = null;
  let lastSeenLocalHash = null;
  const getTrustedSharedHash = () => db.getJson(TRUSTED_SHARED_HASH_KEY);
  const setTrustedSharedHash = (hash) => {
    db.setJson(TRUSTED_SHARED_HASH_KEY, hash);
  };
  const buildTrust = ({ sharedHash, localHash }) => {
    const approvedSharedHash = getTrustedSharedHash();
    return {
      sharedHash,
      localHash,
      approvedSharedHash,
      requiresSharedTrust: approvedSharedHash == null ? sharedHash !== EMPTY_CONTENT_HASH : approvedSharedHash !== sharedHash
    };
  };
  const syncSnapshots = (effective) => {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    db.run("delete from process_definitions where project_id = ?", [projectId]);
    db.run("delete from stack_buttons where project_id = ?", [projectId]);
    db.run("delete from test_suites where project_id = ?", [projectId]);
    for (const proc of effective.processes) {
      db.run(
        `
          insert into process_definitions(
            id, project_id, key, name, command_json, cwd, env_json, autostart,
            restart_policy, graceful_shutdown_ms, depends_on_json, readiness_json, updated_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          createDefId(projectId, `proc:${proc.id}`),
          projectId,
          proc.id,
          proc.name,
          JSON.stringify(proc.command),
          proc.cwd,
          JSON.stringify(proc.env),
          proc.autostart ? 1 : 0,
          proc.restart,
          proc.gracefulShutdownMs,
          JSON.stringify(proc.dependsOn),
          JSON.stringify(proc.readiness),
          now
        ]
      );
    }
    for (const stack of effective.stackButtons) {
      db.run(
        `
          insert into stack_buttons(
            id, project_id, key, name, process_keys_json, start_order, updated_at
          ) values (?, ?, ?, ?, ?, ?, ?)
        `,
        [
          createDefId(projectId, `stack:${stack.id}`),
          projectId,
          stack.id,
          stack.name,
          JSON.stringify(stack.processIds),
          stack.startOrder,
          now
        ]
      );
    }
    for (const suite of effective.testSuites) {
      db.run(
        `
          insert into test_suites(
            id, project_id, key, name, command_json, cwd, env_json, timeout_ms, tags_json, updated_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          createDefId(projectId, `suite:${suite.id}`),
          projectId,
          suite.id,
          suite.name,
          JSON.stringify(suite.command),
          suite.cwd,
          JSON.stringify(suite.env),
          suite.timeoutMs,
          JSON.stringify(suite.tags),
          now
        ]
      );
    }
  };
  const buildSnapshotFromFiles = (shared, local, hashes, options) => {
    const effective = resolveEffectiveConfig(shared, local);
    const validation = validateEffectiveConfig(effective, projectRoot, shared, local);
    const trust = buildTrust(hashes);
    if (options.persistSnapshots && validation.ok) {
      syncSnapshots(effective);
    }
    return {
      shared,
      local,
      effective,
      validation,
      trust,
      paths: { sharedPath, localPath }
    };
  };
  const readSnapshotFromDisk = () => {
    import_node_fs6.default.mkdirSync(adeDir, { recursive: true });
    const sharedFile = readConfigFile(sharedPath);
    const localFile = readConfigFile(localPath);
    const sharedHash = hashContent(sharedFile.raw);
    const localHash = hashContent(localFile.raw);
    return buildSnapshotFromFiles(sharedFile.config, localFile.config, { sharedHash, localHash }, { persistSnapshots: true });
  };
  const validateCandidate = (shared, local) => {
    const sharedHash = hashContent(toCanonicalYaml(shared));
    const localHash = hashContent(toCanonicalYaml(local));
    const snapshot = buildSnapshotFromFiles(shared, local, { sharedHash, localHash }, { persistSnapshots: false });
    return snapshot.validation;
  };
  return {
    get() {
      const snapshot = readSnapshotFromDisk();
      lastSeenSharedHash = snapshot.trust.sharedHash;
      lastSeenLocalHash = snapshot.trust.localHash;
      return snapshot;
    },
    validate(candidate) {
      const shared = coerceConfigFile(candidate.shared);
      const local = coerceConfigFile(candidate.local);
      return validateCandidate(shared, local);
    },
    save(candidate) {
      const shared = coerceConfigFile(candidate.shared);
      const local = coerceConfigFile(candidate.local);
      const validation = validateCandidate(shared, local);
      if (!validation.ok) {
        throw invalidConfigError(validation);
      }
      const sharedYaml = toCanonicalYaml(shared);
      const localYaml = toCanonicalYaml(local);
      import_node_fs6.default.mkdirSync(import_node_path5.default.dirname(sharedPath), { recursive: true });
      import_node_fs6.default.writeFileSync(sharedPath, sharedYaml, "utf8");
      import_node_fs6.default.writeFileSync(localPath, localYaml, "utf8");
      const sharedHash = hashContent(sharedYaml);
      setTrustedSharedHash(sharedHash);
      logger.info("projectConfig.save", {
        sharedPath,
        localPath,
        sharedHash,
        sharedProcesses: shared.processes?.length ?? 0,
        localProcesses: local.processes?.length ?? 0
      });
      const snapshot = readSnapshotFromDisk();
      lastSeenSharedHash = snapshot.trust.sharedHash;
      lastSeenLocalHash = snapshot.trust.localHash;
      return snapshot;
    },
    diffAgainstDisk() {
      const snapshot = readSnapshotFromDisk();
      const sharedChanged = lastSeenSharedHash != null ? snapshot.trust.sharedHash !== lastSeenSharedHash : false;
      const localChanged = lastSeenLocalHash != null ? snapshot.trust.localHash !== lastSeenLocalHash : false;
      return {
        sharedChanged,
        localChanged,
        sharedHash: snapshot.trust.sharedHash,
        localHash: snapshot.trust.localHash,
        approvedSharedHash: snapshot.trust.approvedSharedHash,
        requiresSharedTrust: snapshot.trust.requiresSharedTrust
      };
    },
    confirmTrust({ sharedHash } = {}) {
      const snapshot = readSnapshotFromDisk();
      if (sharedHash && sharedHash !== snapshot.trust.sharedHash) {
        throw new Error("Shared hash mismatch while confirming trust");
      }
      setTrustedSharedHash(snapshot.trust.sharedHash);
      logger.info("projectConfig.confirmTrust", { sharedHash: snapshot.trust.sharedHash });
      return {
        ...snapshot.trust,
        approvedSharedHash: snapshot.trust.sharedHash,
        requiresSharedTrust: false
      };
    },
    getEffective() {
      const snapshot = readSnapshotFromDisk();
      lastSeenSharedHash = snapshot.trust.sharedHash;
      lastSeenLocalHash = snapshot.trust.localHash;
      if (!snapshot.validation.ok) {
        throw invalidConfigError(snapshot.validation);
      }
      return snapshot.effective;
    },
    getExecutableConfig() {
      const snapshot = readSnapshotFromDisk();
      lastSeenSharedHash = snapshot.trust.sharedHash;
      lastSeenLocalHash = snapshot.trust.localHash;
      if (!snapshot.validation.ok) {
        throw invalidConfigError(snapshot.validation);
      }
      if (snapshot.trust.requiresSharedTrust) {
        throw trustError(snapshot.trust.sharedHash);
      }
      return snapshot.effective;
    }
  };
}

// ../desktop/src/main/services/packs/packService.ts
var import_node_crypto5 = require("crypto");
var import_node_fs7 = __toESM(require("fs"), 1);
var import_node_path6 = __toESM(require("path"), 1);

// ../desktop/src/shared/contextContract.ts
var ADE_INTENT_START = "<!-- ADE_INTENT_START -->";
var ADE_INTENT_END = "<!-- ADE_INTENT_END -->";
var ADE_TODOS_START = "<!-- ADE_TODOS_START -->";
var ADE_TODOS_END = "<!-- ADE_TODOS_END -->";
var ADE_NARRATIVE_START = "<!-- ADE_NARRATIVE_START -->";
var ADE_NARRATIVE_END = "<!-- ADE_NARRATIVE_END -->";
var ADE_TASK_SPEC_START = "<!-- ADE_TASK_SPEC_START -->";
var ADE_TASK_SPEC_END = "<!-- ADE_TASK_SPEC_END -->";
var CONTEXT_HEADER_SCHEMA_V1 = "ade.context.v1";
var CONTEXT_CONTRACT_VERSION = 4;

// ../desktop/src/main/services/packs/transcriptInsights.ts
function normalize(raw) {
  return stripAnsi(String(raw ?? "")).replace(/\r\n/g, "\n");
}
function lastIndexOfRegex(text, pattern) {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  let last = -1;
  let match;
  while ((match = re.exec(text)) != null) {
    last = match.index;
  }
  return last;
}
function lineAt(text, idx) {
  if (idx < 0) return "";
  const start = text.lastIndexOf("\n", idx);
  const end = text.indexOf("\n", idx);
  const slice = text.slice(start < 0 ? 0 : start + 1, end < 0 ? text.length : end);
  return slice.trim();
}
function inferTestOutcomeFromText(rawText) {
  const text = normalize(rawText);
  if (!text.trim()) return null;
  const passPatterns = [
    /\bAll\b.{0,120}\btests?\b.{0,120}\bpass(?:ed)?\b/gi,
    /\bTest Suites?:\s*\d+\s*passed\b/gi,
    /\bTests?:\s*\d+\s*passed\b/gi,
    /\bTest Files?:\s*\d+\s*passed\b/gi
  ];
  const failPatterns = [
    /\bAll\b.{0,120}\btests?\b.{0,120}\bfail(?:ed)?\b/gi,
    /\bTest Suites?:\s*\d+\s*failed\b/gi,
    /\bTests?:\s*\d+\s*failed\b/gi,
    /\bFAIL\b.{0,160}\btest\b/gi,
    /\btest\b.{0,160}\bFAIL\b/gi
  ];
  let passIdx = -1;
  for (const pattern of passPatterns) passIdx = Math.max(passIdx, lastIndexOfRegex(text, pattern));
  let failIdx = -1;
  for (const pattern of failPatterns) failIdx = Math.max(failIdx, lastIndexOfRegex(text, pattern));
  if (passIdx < 0 && failIdx < 0) return null;
  const status = failIdx > passIdx ? "fail" : "pass";
  const idx = status === "fail" ? failIdx : passIdx;
  const evidence = lineAt(text, idx) || (status === "fail" ? "tests failed" : "tests passed");
  return { status, evidence };
}

// ../desktop/src/main/services/packs/lanePackTemplate.ts
function fmtChange(insertions, deletions) {
  if (insertions == null || deletions == null) return "binary";
  return `+${insertions}/-${deletions}`;
}
function mdCode(value) {
  const clean = value.replace(/`/g, "'");
  return `\`${clean}\``;
}
function renderLanePackMarkdown(args) {
  const shortSha = args.headSha ? args.headSha.slice(0, 8) : "unknown";
  const cleanliness = args.dirty ? "dirty" : "clean";
  const lines = [];
  lines.push("```json");
  lines.push(
    JSON.stringify(
      {
        schema: CONTEXT_HEADER_SCHEMA_V1,
        contractVersion: CONTEXT_CONTRACT_VERSION,
        projectId: args.projectId,
        packKey: args.packKey,
        packType: "lane",
        laneId: args.laneId,
        peerKey: null,
        baseRef: args.baseRef,
        headSha: args.headSha,
        deterministicUpdatedAt: args.deterministicUpdatedAt,
        versionId: null,
        versionNumber: null,
        contentHash: null,
        providerMode: args.providerMode,
        graph: args.graph ?? null,
        dependencyState: args.dependencyState ?? null,
        conflictState: args.conflictState ?? null
      },
      null,
      2
    )
  );
  lines.push("```");
  lines.push("");
  lines.push(`# Lane: ${stripAnsi(args.laneName)}`);
  lines.push(`> Branch: ${mdCode(stripAnsi(args.branchRef))} | Base: ${mdCode(stripAnsi(args.baseRef))} | HEAD: ${mdCode(shortSha)} | ${cleanliness} \xB7 ahead ${args.ahead} \xB7 behind ${args.behind}`);
  if (args.parentName) lines.push(`> Parent: ${stripAnsi(args.parentName)}`);
  lines.push("");
  const laneDesc = stripAnsi(args.laneDescription).trim();
  if (laneDesc) {
    lines.push("## Original Intent");
    lines.push(laneDesc);
    lines.push("");
  }
  lines.push("## What Changed");
  if (args.whatChangedLines.length) {
    for (const entry of args.whatChangedLines) lines.push(`- ${stripAnsi(entry)}`);
  } else {
    lines.push("- No changes detected yet.");
  }
  lines.push("");
  lines.push("## Why");
  lines.push(args.userIntentMarkers.start);
  lines.push(stripAnsi(args.userIntent).trim().length ? stripAnsi(args.userIntent).trim() : "Intent not set \u2014 click to add.");
  lines.push(args.userIntentMarkers.end);
  if (args.inferredWhyLines.length) {
    lines.push("");
    lines.push("Inferred from commits:");
    for (const entry of args.inferredWhyLines) lines.push(`- ${stripAnsi(entry)}`);
  }
  lines.push("");
  lines.push("## Task Spec");
  lines.push(args.taskSpecMarkers.start);
  lines.push(stripAnsi(args.taskSpec).trim().length ? stripAnsi(args.taskSpec).trim() : "- (add task spec here)");
  lines.push(args.taskSpecMarkers.end);
  lines.push("");
  lines.push("## Validation");
  if (args.validationLines.length) {
    for (const entry of args.validationLines) lines.push(`- ${stripAnsi(entry)}`);
  } else {
    lines.push("- Tests: NOT RUN");
    lines.push("- Lint: NOT RUN");
  }
  lines.push("");
  lines.push(`## Key Files (${args.keyFiles.length} files touched)`);
  if (!args.keyFiles.length) {
    lines.push("No files touched.");
    lines.push("");
  } else {
    lines.push("| File | Change |");
    lines.push("|------|--------|");
    for (const row of args.keyFiles.slice(0, 25)) {
      lines.push(`| ${mdCode(stripAnsi(row.file))} | ${fmtChange(row.insertions, row.deletions)} |`);
    }
    lines.push("");
  }
  lines.push("## Errors & Issues");
  if (!args.errors.length) {
    lines.push("No errors detected.");
  } else {
    for (const entry of args.errors.slice(0, 30)) lines.push(`- ${stripAnsi(entry)}`);
  }
  lines.push("");
  lines.push(`## Sessions (${args.sessionsTotal} total, ${args.sessionsRunning} running)`);
  if (args.sessionsDetailed.length) {
    for (const [idx, row] of args.sessionsDetailed.slice(0, 30).entries()) {
      lines.push(`### Session ${idx + 1}: ${stripAnsi(row.when)} \u2014 ${stripAnsi(row.tool)}`);
      const prompt = stripAnsi(row.prompt).trim();
      if (prompt) {
        lines.push(`- **Prompt**: ${prompt}`);
      }
      lines.push(`- **Goal**: ${stripAnsi(row.goal)}`);
      lines.push(`- **Result**: ${stripAnsi(row.result)}`);
      lines.push(`- **Delta**: ${stripAnsi(row.delta)}`);
      if (row.commands.length) {
        lines.push(`- **Commands**: ${row.commands.map((c) => mdCode(stripAnsi(c))).join(", ")}`);
      }
      if (row.filesTouched.length) {
        lines.push(`- **Files touched**: ${row.filesTouched.map((f) => mdCode(stripAnsi(f))).join(", ")}`);
      }
      if (row.errors.length) {
        lines.push(`- **Errors**: ${row.errors.map((e) => stripAnsi(e)).join("; ")}`);
      }
      lines.push("");
    }
  } else {
    lines.push("No sessions recorded yet.");
    lines.push("");
  }
  if (args.sessionsTotal > args.sessionsDetailed.length) {
    lines.push(`Showing ${args.sessionsDetailed.length} most recent sessions out of ${args.sessionsTotal} total.`);
    lines.push("");
  }
  lines.push("## Open Questions / Next Steps");
  if (args.nextSteps.length) {
    for (const entry of args.nextSteps) lines.push(`- ${stripAnsi(entry)}`);
  } else {
    lines.push("- (none detected)");
  }
  lines.push("");
  lines.push(args.userTodosMarkers.start);
  lines.push(stripAnsi(args.userTodos).trim().length ? stripAnsi(args.userTodos).trim() : "- (add notes/todos here)");
  lines.push(args.userTodosMarkers.end);
  lines.push("");
  lines.push("---");
  lines.push(
    `*Updated: ${stripAnsi(args.deterministicUpdatedAt)} | Trigger: ${stripAnsi(args.trigger)} | Provider: ${stripAnsi(args.providerMode)} | [View history \u2192](ade://packs/versions/${stripAnsi(args.packKey)})*`
  );
  lines.push("");
  return `${lines.join("\n")}
`;
}

// ../desktop/src/main/services/packs/packSections.ts
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function findLineEnd(content, fromIndex) {
  const idx = content.indexOf("\n", fromIndex);
  return idx >= 0 ? idx + 1 : content.length;
}
function findNextIndex(content, regex, fromIndex) {
  let flags = regex.flags;
  if (!flags.includes("g")) flags += "g";
  if (!flags.includes("m")) flags += "m";
  const re = new RegExp(regex.source, flags);
  re.lastIndex = Math.max(0, fromIndex);
  const match = re.exec(content);
  return match ? match.index : -1;
}
function extractBetweenMarkers(content, startMarker, endMarker) {
  const startIdx = content.indexOf(startMarker);
  const endIdx = content.indexOf(endMarker);
  if (startIdx < 0 || endIdx < 0 || endIdx <= startIdx) return null;
  const body = content.slice(startIdx + startMarker.length, endIdx).trim();
  return body.length ? body : "";
}
function replaceBetweenMarkers(args) {
  const startIdx = args.content.indexOf(args.startMarker);
  const endIdx = args.content.indexOf(args.endMarker);
  if (startIdx < 0 || endIdx < 0 || endIdx <= startIdx) {
    return { content: args.content, changed: false };
  }
  const before = args.content.slice(0, startIdx + args.startMarker.length);
  const after = args.content.slice(endIdx);
  const nextBody = args.body.trim();
  const updated = `${before}
${nextBody}
${after}`;
  return { content: updated, changed: updated !== args.content };
}
function upsertSectionByHeading(args) {
  const replaced = replaceBetweenMarkers({
    content: args.content,
    startMarker: args.startMarker,
    endMarker: args.endMarker,
    body: args.body
  });
  if (replaced.changed || args.content.includes(args.startMarker) && args.content.includes(args.endMarker)) {
    return { content: replaced.content, insertedMarkers: false };
  }
  const headingRe = new RegExp(`^${escapeRegExp(args.heading)}\\s*$`, "m");
  const match = headingRe.exec(args.content);
  if (match?.index != null) {
    const headingStart = match.index;
    const headingLineEnd = findLineEnd(args.content, headingStart);
    const nextHeadingIdx = findNextIndex(args.content, /^##\s+/gm, headingLineEnd);
    const nextHrIdx = findNextIndex(args.content, /^---\s*$/gm, headingLineEnd);
    const candidates = [nextHeadingIdx, nextHrIdx].filter((idx) => idx >= 0);
    const sectionEnd = candidates.length ? Math.min(...candidates) : args.content.length;
    const before = args.content.slice(0, headingLineEnd);
    const after = args.content.slice(sectionEnd);
    const body2 = args.body.trim();
    const updated2 = `${before}${args.startMarker}
${body2}
${args.endMarker}
${after}`;
    return { content: updated2, insertedMarkers: true };
  }
  const trimmed = args.content.trimEnd();
  const body = args.body.trim();
  const suffix = `${args.heading}
${args.startMarker}
${body}
${args.endMarker}
`;
  const updated = trimmed.length ? `${trimmed}

${suffix}` : `${suffix}`;
  return { content: updated, insertedMarkers: true };
}
function extractSectionByHeading(content, heading) {
  const headingRe = new RegExp(`^${escapeRegExp(heading)}\\s*$`, "m");
  const match = headingRe.exec(content);
  if (!match?.index && match?.index !== 0) return null;
  const headingStart = match.index;
  const headingLineEnd = findLineEnd(content, headingStart);
  const nextHeadingIdx = findNextIndex(content, /^##\s+/gm, headingLineEnd);
  const nextHrIdx = findNextIndex(content, /^---\s*$/gm, headingLineEnd);
  const candidates = [nextHeadingIdx, nextHrIdx].filter((idx) => idx >= 0);
  const sectionEnd = candidates.length ? Math.min(...candidates) : content.length;
  const body = content.slice(headingLineEnd, sectionEnd).trim();
  return body.length ? body : "";
}
function extractSectionContent(content, locator) {
  if (locator.kind === "markers") return extractBetweenMarkers(content, locator.startMarker, locator.endMarker);
  if (locator.kind === "heading") return extractSectionByHeading(content, locator.heading);
  return null;
}
function computeSectionChanges(args) {
  const norm = (value) => {
    if (value == null) return null;
    return String(value).replace(/\r\n/g, "\n").trim();
  };
  const beforeContent = args.before ?? "";
  const out = [];
  for (const locator of args.locators) {
    const a = norm(extractSectionContent(beforeContent, locator));
    const b = norm(extractSectionContent(args.after, locator));
    if (a == null && b == null) continue;
    if (a == null && b != null) {
      out.push({ sectionId: locator.id, changeType: "added" });
      continue;
    }
    if (a != null && b == null) {
      out.push({ sectionId: locator.id, changeType: "removed" });
      continue;
    }
    if (a !== b) out.push({ sectionId: locator.id, changeType: "modified" });
  }
  return out;
}
function renderJsonSection(heading, value, opts = {}) {
  const pretty = opts.pretty !== false;
  let json = "";
  try {
    json = pretty ? JSON.stringify(value ?? null, null, 2) : JSON.stringify(value ?? null);
  } catch {
    json = pretty ? JSON.stringify({ error: "Failed to serialize JSON section." }, null, 2) : JSON.stringify({ error: "Failed to serialize JSON section." });
  }
  return [heading, "```json", json, "```", ""];
}

// ../desktop/src/main/services/packs/packExports.ts
var DEFAULT_BUDGETS = {
  project: {
    lite: { maxTokens: 900 },
    standard: { maxTokens: 2500 },
    deep: { maxTokens: 6500 }
  },
  lane: {
    lite: { maxTokens: 800 },
    standard: { maxTokens: 2800 },
    deep: { maxTokens: 8e3 }
  },
  conflict: {
    lite: { maxTokens: 1100 },
    standard: { maxTokens: 3200 },
    deep: { maxTokens: 9e3 }
  },
  feature: {
    lite: { maxTokens: 1e3 },
    standard: { maxTokens: 2800 },
    deep: { maxTokens: 8e3 }
  },
  plan: {
    lite: { maxTokens: 1100 },
    standard: { maxTokens: 3200 },
    deep: { maxTokens: 9e3 }
  },
  mission: {
    lite: { maxTokens: 1200 },
    standard: { maxTokens: 3600 },
    deep: { maxTokens: 9e3 }
  }
};
function approxTokensFromText(text) {
  return Math.max(0, Math.ceil((text ?? "").length / 4));
}
function normalizeForExport(text) {
  return stripAnsi(String(text ?? "")).replace(/\r\n/g, "\n");
}
function renderHeaderFence(header, opts = {}) {
  const pretty = opts.pretty !== false;
  return ["```json", pretty ? JSON.stringify(header, null, 2) : JSON.stringify(header), "```", ""].join("\n");
}
function ensureBudgetOmission(omissions, truncated) {
  if (!truncated) return omissions;
  if (omissions.some((o) => o.sectionId === "export" && o.reason === "budget_clipped")) return omissions;
  return [
    ...omissions,
    {
      sectionId: "export",
      reason: "budget_clipped",
      detail: "Export clipped to fit token budget.",
      recommendedLevel: "deep"
    }
  ];
}
function takeLines(lines, max) {
  if (lines.length <= max) return { lines, truncated: false };
  return { lines: lines.slice(0, Math.max(0, max)), truncated: true };
}
function clipBlock(text, maxChars) {
  const normalized = normalizeForExport(text ?? "").trim();
  if (maxChars <= 0) return { text: normalized, truncated: false };
  if (normalized.length <= maxChars) return { text: normalized, truncated: false };
  const clipped = `${normalized.slice(0, Math.max(0, maxChars - 20)).trimEnd()}
...(truncated)...
`;
  return { text: clipped, truncated: true };
}
function extractSectionLines(args) {
  const raw = normalizeForExport(args.content);
  const lines = raw.split("\n");
  const startIdx = lines.findIndex((line) => line.trim() === args.headingPrefix || line.startsWith(args.headingPrefix));
  if (startIdx < 0) return { lines: [], truncated: false };
  const out = [];
  let inCodeFence = false;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (trimmed.startsWith("```")) inCodeFence = !inCodeFence;
    if (!inCodeFence && trimmed.startsWith("## ")) break;
    if (!inCodeFence && trimmed === "---") break;
    out.push(line);
  }
  while (out.length && !out[0].trim()) out.shift();
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return takeLines(out, args.maxLines);
}
function clipToBudget(args) {
  const normalized = normalizeForExport(args.content);
  const approx = approxTokensFromText(normalized);
  if (approx <= args.maxTokens) return { content: normalized, truncated: false };
  const maxChars = Math.max(0, args.maxTokens * 4);
  if (normalized.length <= maxChars) return { content: normalized, truncated: false };
  const clipped = `${normalized.slice(0, Math.max(0, maxChars - 20)).trimEnd()}

...(truncated)...
`;
  return { content: clipped, truncated: true };
}
function buildLaneExport(args) {
  const level = args.level;
  const budget = DEFAULT_BUDGETS.lane[level];
  const body = normalizeForExport(args.pack.body ?? "");
  const taskSpecRaw = extractBetweenMarkers(body, args.markers.taskSpecStart, args.markers.taskSpecEnd) ?? "(task spec missing; refresh lane pack to upgrade markers)";
  const intentRaw = extractBetweenMarkers(body, args.markers.intentStart, args.markers.intentEnd) ?? "(intent missing; refresh lane pack to upgrade markers)";
  const todosRaw = extractBetweenMarkers(body, args.markers.todosStart, args.markers.todosEnd) ?? "";
  const narrativeRaw = extractBetweenMarkers(body, args.markers.narrativeStart, args.markers.narrativeEnd) ?? "";
  const whatChanged = extractSectionLines({
    content: body,
    headingPrefix: "## What Changed",
    maxLines: level === "lite" ? 10 : level === "standard" ? 24 : 80
  });
  const validation = extractSectionLines({
    content: body,
    headingPrefix: "## Validation",
    maxLines: level === "lite" ? 8 : level === "standard" ? 16 : 40
  });
  const keyFiles = extractSectionLines({
    content: body,
    headingPrefix: "## Key Files",
    maxLines: level === "lite" ? 10 : level === "standard" ? 20 : 60
  });
  const errors = extractSectionLines({
    content: body,
    headingPrefix: "## Errors & Issues",
    maxLines: level === "lite" ? 12 : level === "standard" ? 30 : 120
  });
  const sessions = extractSectionLines({
    content: body,
    headingPrefix: "## Sessions",
    maxLines: level === "lite" ? 12 : level === "standard" ? 24 : 80
  });
  const nextSteps = extractSectionLines({
    content: body,
    headingPrefix: "## Open Questions / Next Steps",
    maxLines: level === "lite" ? 16 : level === "standard" ? 40 : 120
  });
  const warnings = [];
  const omissionsBase = [];
  const userBlockLimits = level === "lite" ? { taskSpecChars: 650, intentChars: 360, todosChars: 450, narrativeChars: 0 } : level === "standard" ? { taskSpecChars: 2200, intentChars: 1400, todosChars: 1200, narrativeChars: 0 } : { taskSpecChars: 4e3, intentChars: 2200, todosChars: 2e3, narrativeChars: 5e3 };
  const taskSpec = clipBlock(taskSpecRaw, userBlockLimits.taskSpecChars);
  const intent = clipBlock(intentRaw, userBlockLimits.intentChars);
  const todos = clipBlock(todosRaw, userBlockLimits.todosChars);
  const narrative = clipBlock(narrativeRaw, userBlockLimits.narrativeChars);
  if (taskSpec.truncated) {
    warnings.push("Task Spec section truncated for export budget.");
    omissionsBase.push({ sectionId: "task_spec", reason: "truncated_section", detail: "Task Spec truncated." });
  }
  if (intent.truncated) {
    warnings.push("Intent section truncated for export budget.");
    omissionsBase.push({ sectionId: "intent", reason: "truncated_section", detail: "Intent truncated." });
  }
  if (todos.truncated) {
    warnings.push("Todos section truncated for export budget.");
    omissionsBase.push({ sectionId: "todos", reason: "truncated_section", detail: "Todos truncated." });
  }
  if (narrative.truncated) {
    warnings.push("Narrative section truncated for export budget.");
    omissionsBase.push({ sectionId: "narrative", reason: "truncated_section", detail: "Narrative truncated." });
  }
  if (whatChanged.truncated) {
    warnings.push("What Changed section truncated for export budget.");
    omissionsBase.push({ sectionId: "what_changed", reason: "truncated_section", detail: "What Changed truncated." });
  }
  if (validation.truncated) {
    warnings.push("Validation section truncated for export budget.");
    omissionsBase.push({ sectionId: "validation", reason: "truncated_section", detail: "Validation truncated." });
  }
  if (keyFiles.truncated) {
    warnings.push("Key Files section truncated for export budget.");
    omissionsBase.push({ sectionId: "key_files", reason: "truncated_section", detail: "Key Files truncated." });
  }
  if (errors.truncated) {
    warnings.push("Errors section truncated for export budget.");
    omissionsBase.push({ sectionId: "errors", reason: "truncated_section", detail: "Errors truncated." });
  }
  if (sessions.truncated) {
    warnings.push("Sessions section truncated for export budget.");
    omissionsBase.push({ sectionId: "sessions", reason: "truncated_section", detail: "Sessions truncated." });
  }
  if (nextSteps.truncated) {
    warnings.push("Next Steps section truncated for export budget.");
    omissionsBase.push({ sectionId: "next_steps", reason: "truncated_section", detail: "Next Steps truncated." });
  }
  const exportedAt = (/* @__PURE__ */ new Date()).toISOString();
  const header = {
    schema: CONTEXT_HEADER_SCHEMA_V1,
    contractVersion: CONTEXT_CONTRACT_VERSION,
    projectId: args.projectId,
    packKey: args.pack.packKey,
    packType: "lane",
    exportLevel: level,
    laneId: args.laneId,
    peerKey: null,
    baseRef: args.baseRef,
    headSha: args.headSha,
    deterministicUpdatedAt: args.pack.deterministicUpdatedAt,
    narrativeUpdatedAt: args.pack.narrativeUpdatedAt,
    versionId: args.pack.versionId ?? null,
    versionNumber: args.pack.versionNumber ?? null,
    contentHash: args.pack.contentHash ?? null,
    providerMode: args.providerMode,
    exportedAt,
    apiBaseUrl: args.apiBaseUrl,
    remoteProjectId: args.remoteProjectId,
    graph: args.graph ?? null,
    dependencyState: args.dependencyState ?? null,
    conflictState: args.conflictState ?? null,
    omissions: null
  };
  const lines = [];
  lines.push(`# Lane Export (${level.toUpperCase()})`);
  lines.push(
    `> Lane: ${normalizeForExport(args.laneName)} | Branch: \`${normalizeForExport(args.branchRef)}\` | Base: \`${normalizeForExport(args.baseRef)}\``
  );
  lines.push("");
  if (args.manifest) {
    const liteManifest = level === "lite" ? {
      schema: args.manifest.schema,
      projectId: args.manifest.projectId,
      laneId: args.manifest.laneId,
      laneName: args.manifest.laneName,
      laneType: args.manifest.laneType,
      branchRef: args.manifest.branchRef,
      baseRef: args.manifest.baseRef,
      lineage: args.manifest.lineage,
      mergeConstraints: args.manifest.mergeConstraints,
      branchState: {
        baseRef: args.manifest.branchState?.baseRef ?? null,
        headRef: args.manifest.branchState?.headRef ?? null,
        headSha: args.manifest.branchState?.headSha ?? null,
        lastPackRefreshAt: args.manifest.branchState?.lastPackRefreshAt ?? null,
        isEditProtected: args.manifest.branchState?.isEditProtected ?? null,
        packStale: args.manifest.branchState?.packStale ?? null,
        ...args.manifest.branchState?.packStaleReason ? { packStaleReason: args.manifest.branchState.packStaleReason } : {}
      },
      conflicts: {
        activeConflictPackKeys: args.manifest.conflicts?.activeConflictPackKeys ?? [],
        unresolvedPairCount: args.manifest.conflicts?.unresolvedPairCount ?? 0,
        lastConflictRefreshAt: args.manifest.conflicts?.lastConflictRefreshAt ?? null,
        lastConflictRefreshAgeMs: args.manifest.conflicts?.lastConflictRefreshAgeMs ?? null,
        ...args.manifest.conflicts?.predictionStale != null ? { predictionStale: args.manifest.conflicts.predictionStale } : {},
        ...args.manifest.conflicts?.stalePolicy ? { stalePolicy: args.manifest.conflicts.stalePolicy } : {},
        ...args.manifest.conflicts?.staleReason ? { staleReason: args.manifest.conflicts.staleReason } : {}
      }
    } : args.manifest;
    lines.push(...renderJsonSection("## Manifest", liteManifest, { pretty: level !== "lite" }));
  } else {
    lines.push(...renderJsonSection("## Manifest", { schema: "ade.manifest.lane.v1", unavailable: true }, { pretty: level !== "lite" }));
    omissionsBase.push({ sectionId: "manifest", reason: "data_unavailable", detail: "Manifest unavailable." });
  }
  lines.push("## Task Spec");
  lines.push(args.markers.taskSpecStart);
  lines.push(taskSpec.text);
  lines.push(args.markers.taskSpecEnd);
  lines.push("");
  lines.push("## Intent");
  lines.push(args.markers.intentStart);
  lines.push(intent.text);
  lines.push(args.markers.intentEnd);
  lines.push("");
  lines.push("## Conflict Risk Summary");
  if (args.conflictRiskSummaryLines.length) {
    const max = level === "lite" ? 8 : args.conflictRiskSummaryLines.length;
    for (const line of args.conflictRiskSummaryLines.slice(0, max)) lines.push(line);
  } else {
    lines.push("- Conflict status: unknown (prediction not available yet)");
  }
  lines.push("");
  if (whatChanged.lines.length) {
    lines.push("## What Changed");
    lines.push(...whatChanged.lines);
    lines.push("");
  }
  if (validation.lines.length) {
    lines.push("## Validation");
    lines.push(...validation.lines);
    lines.push("");
  }
  if (keyFiles.lines.length) {
    lines.push("## Key Files");
    lines.push(...keyFiles.lines);
    lines.push("");
  }
  if (errors.lines.length) {
    lines.push("## Errors & Issues");
    lines.push(...errors.lines);
    lines.push("");
  }
  if (sessions.lines.length) {
    lines.push("## Sessions");
    lines.push(...sessions.lines);
    lines.push("");
  }
  if (nextSteps.lines.length) {
    lines.push("## Next Steps");
    lines.push(...nextSteps.lines);
    lines.push("");
  }
  if (todos.text.trim().length) {
    lines.push("## Notes / Todos");
    lines.push(args.markers.todosStart);
    lines.push(todos.text);
    lines.push(args.markers.todosEnd);
    lines.push("");
  }
  if (level === "deep" && narrative.text.trim().length) {
    lines.push("## Narrative (Deep)");
    lines.push(args.markers.narrativeStart);
    lines.push(narrative.text);
    lines.push(args.markers.narrativeEnd);
    lines.push("");
  } else if (level !== "deep") {
    omissionsBase.push({
      sectionId: "narrative",
      reason: "omitted_by_level",
      detail: "Narrative is only included at deep export level.",
      recommendedLevel: "deep"
    });
  }
  const buildContent = (omissions) => {
    header.omissions = omissions.length ? omissions : null;
    header.maxTokens = budget.maxTokens;
    const draft = `${renderHeaderFence(header, { pretty: level !== "lite" })}${lines.join("\n")}
`;
    return clipToBudget({ content: draft, maxTokens: budget.maxTokens });
  };
  let clipped = buildContent(omissionsBase);
  const omissionsFinal = ensureBudgetOmission(omissionsBase, clipped.truncated);
  if (omissionsFinal !== omissionsBase) {
    clipped = buildContent(omissionsFinal);
  }
  const approxTokens = approxTokensFromText(clipped.content);
  header.approxTokens = approxTokens;
  return {
    packKey: args.pack.packKey,
    packType: "lane",
    level,
    header,
    content: clipped.content,
    approxTokens,
    maxTokens: budget.maxTokens,
    truncated: clipped.truncated,
    warnings: clipped.truncated ? [...warnings, "Export clipped to fit token budget."] : warnings,
    clipReason: clipped.truncated ? "budget_clipped" : null,
    omittedSections: (header.omissions ?? []).map((entry) => entry.sectionId)
  };
}
function buildProjectExport(args) {
  const level = args.level;
  const budget = DEFAULT_BUDGETS.project[level];
  const body = normalizeForExport(args.pack.body ?? "");
  const overview = extractSectionLines({
    content: body,
    headingPrefix: "# Project Pack",
    maxLines: level === "lite" ? 60 : level === "standard" ? 140 : 400
  });
  const warnings = [];
  const omissionsBase = [];
  const exportedAt = (/* @__PURE__ */ new Date()).toISOString();
  const header = {
    schema: CONTEXT_HEADER_SCHEMA_V1,
    contractVersion: CONTEXT_CONTRACT_VERSION,
    projectId: args.projectId,
    packKey: args.pack.packKey,
    packType: "project",
    exportLevel: level,
    laneId: null,
    peerKey: null,
    baseRef: null,
    headSha: null,
    deterministicUpdatedAt: args.pack.deterministicUpdatedAt,
    narrativeUpdatedAt: args.pack.narrativeUpdatedAt,
    versionId: args.pack.versionId ?? null,
    versionNumber: args.pack.versionNumber ?? null,
    contentHash: args.pack.contentHash ?? null,
    providerMode: args.providerMode,
    exportedAt,
    apiBaseUrl: args.apiBaseUrl,
    remoteProjectId: args.remoteProjectId,
    graph: args.graph ?? null,
    omissions: null
  };
  const lines = [];
  lines.push(`# Project Export (${level.toUpperCase()})`);
  lines.push("");
  if (args.manifest) {
    lines.push(...renderJsonSection("## Manifest", args.manifest, { pretty: level !== "lite" }));
  } else {
    lines.push(...renderJsonSection("## Manifest", { schema: "ade.manifest.project.v1", unavailable: true }, { pretty: level !== "lite" }));
    omissionsBase.push({ sectionId: "manifest", reason: "data_unavailable", detail: "Manifest unavailable." });
  }
  if (overview.lines.length) {
    lines.push("## Snapshot");
    lines.push(...overview.lines);
    lines.push("");
  } else {
    lines.push("## Snapshot");
    lines.push("- Project pack is empty. Refresh deterministic packs first.");
    lines.push("");
    omissionsBase.push({ sectionId: "snapshot", reason: "data_unavailable", detail: "Snapshot unavailable." });
  }
  if (overview.truncated) {
    warnings.push("Project snapshot truncated for export budget.");
    omissionsBase.push({ sectionId: "snapshot", reason: "truncated_section", detail: "Snapshot truncated." });
  }
  const buildContent = (omissions) => {
    header.omissions = omissions.length ? omissions : null;
    header.maxTokens = budget.maxTokens;
    const draft = `${renderHeaderFence(header, { pretty: level !== "lite" })}${lines.join("\n")}
`;
    return clipToBudget({ content: draft, maxTokens: budget.maxTokens });
  };
  let clipped = buildContent(omissionsBase);
  const omissionsFinal = ensureBudgetOmission(omissionsBase, clipped.truncated);
  if (omissionsFinal !== omissionsBase) {
    clipped = buildContent(omissionsFinal);
  }
  const approxTokens = approxTokensFromText(clipped.content);
  header.approxTokens = approxTokens;
  return {
    packKey: args.pack.packKey,
    packType: "project",
    level,
    header,
    content: clipped.content,
    approxTokens,
    maxTokens: budget.maxTokens,
    truncated: clipped.truncated,
    warnings: clipped.truncated ? [...warnings, "Export clipped to fit token budget."] : warnings,
    clipReason: clipped.truncated ? "budget_clipped" : null,
    omittedSections: (header.omissions ?? []).map((entry) => entry.sectionId)
  };
}
function buildConflictExport(args) {
  const level = args.level;
  const budget = DEFAULT_BUDGETS.conflict[level];
  const body = normalizeForExport(args.pack.body ?? "");
  const overlapLines = extractSectionLines({
    content: body,
    headingPrefix: "## Overlapping Files",
    maxLines: level === "lite" ? 24 : level === "standard" ? 60 : 220
  });
  const conflictsLines = extractSectionLines({
    content: body,
    headingPrefix: "## Conflicts (merge-tree)",
    maxLines: level === "lite" ? 60 : level === "standard" ? 140 : 400
  });
  const warnings = [];
  const omissionsBase = [];
  if (overlapLines.truncated) warnings.push("Overlap list truncated for export budget.");
  if (conflictsLines.truncated) warnings.push("Conflicts section truncated for export budget.");
  if (overlapLines.truncated) omissionsBase.push({ sectionId: "overlap_files", reason: "truncated_section", detail: "Overlap list truncated." });
  if (conflictsLines.truncated) omissionsBase.push({ sectionId: "merge_tree", reason: "truncated_section", detail: "Merge-tree conflicts truncated." });
  const exportedAt = (/* @__PURE__ */ new Date()).toISOString();
  const header = {
    schema: CONTEXT_HEADER_SCHEMA_V1,
    contractVersion: CONTEXT_CONTRACT_VERSION,
    projectId: args.projectId,
    packKey: args.packKey,
    packType: "conflict",
    exportLevel: level,
    laneId: args.laneId,
    peerKey: args.peerLabel,
    baseRef: null,
    headSha: args.pack.lastHeadSha ?? null,
    deterministicUpdatedAt: args.pack.deterministicUpdatedAt,
    narrativeUpdatedAt: args.pack.narrativeUpdatedAt,
    versionId: args.pack.versionId ?? null,
    versionNumber: args.pack.versionNumber ?? null,
    contentHash: args.pack.contentHash ?? null,
    providerMode: args.providerMode,
    exportedAt,
    apiBaseUrl: args.apiBaseUrl,
    remoteProjectId: args.remoteProjectId,
    graph: args.graph ?? null,
    omissions: null
  };
  const lines = [];
  lines.push(`# Conflict Export (${level.toUpperCase()})`);
  lines.push(`> Lane: ${args.laneId} | Peer: ${normalizeForExport(args.peerLabel)}`);
  lines.push("");
  if (args.lineage) {
    lines.push(...renderJsonSection("## Conflict Lineage", args.lineage, { pretty: level !== "lite" }));
  } else {
    omissionsBase.push({ sectionId: "conflict_lineage", reason: "data_unavailable", detail: "Conflict lineage unavailable." });
  }
  lines.push("## Overlapping Files");
  if (overlapLines.lines.length) lines.push(...overlapLines.lines);
  else lines.push("- (none listed; refresh conflict pack)");
  lines.push("");
  lines.push("## Conflicts (merge-tree)");
  if (conflictsLines.lines.length) lines.push(...conflictsLines.lines);
  else lines.push("- (none listed; refresh conflict pack)");
  lines.push("");
  const buildContent = (omissions) => {
    header.omissions = omissions.length ? omissions : null;
    header.maxTokens = budget.maxTokens;
    const draft = `${renderHeaderFence(header, { pretty: level !== "lite" })}${lines.join("\n")}
`;
    return clipToBudget({ content: draft, maxTokens: budget.maxTokens });
  };
  let clipped = buildContent(omissionsBase);
  const omissionsFinal = ensureBudgetOmission(omissionsBase, clipped.truncated);
  if (omissionsFinal !== omissionsBase) {
    clipped = buildContent(omissionsFinal);
  }
  const approxTokens = approxTokensFromText(clipped.content);
  header.approxTokens = approxTokens;
  return {
    packKey: args.packKey,
    packType: "conflict",
    level,
    header,
    content: clipped.content,
    approxTokens,
    maxTokens: budget.maxTokens,
    truncated: clipped.truncated,
    warnings: clipped.truncated ? [...warnings, "Export clipped to fit token budget."] : warnings,
    clipReason: clipped.truncated ? "budget_clipped" : null,
    omittedSections: (header.omissions ?? []).map((entry) => entry.sectionId)
  };
}

// ../desktop/src/main/services/packs/packService.ts
function safeJsonParseArray(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((entry) => String(entry));
  } catch {
    return [];
  }
}
function readFileIfExists(filePath) {
  try {
    return import_node_fs7.default.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}
function ensureDirFor(filePath) {
  import_node_fs7.default.mkdirSync(import_node_path6.default.dirname(filePath), { recursive: true });
}
function upsertPackIndex({
  db,
  projectId,
  packKey,
  laneId,
  packType,
  packPath,
  deterministicUpdatedAt,
  narrativeUpdatedAt,
  lastHeadSha,
  metadata
}) {
  db.run(
    `
      insert into packs_index(
        pack_key,
        project_id,
        lane_id,
        pack_type,
        pack_path,
        deterministic_updated_at,
        narrative_updated_at,
        last_head_sha,
        metadata_json
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(pack_key) do update set
        project_id = excluded.project_id,
        lane_id = excluded.lane_id,
        pack_type = excluded.pack_type,
        pack_path = excluded.pack_path,
        deterministic_updated_at = excluded.deterministic_updated_at,
        narrative_updated_at = excluded.narrative_updated_at,
        last_head_sha = excluded.last_head_sha,
        metadata_json = excluded.metadata_json
    `,
    [
      packKey,
      projectId,
      laneId,
      packType,
      packPath,
      deterministicUpdatedAt,
      narrativeUpdatedAt ?? null,
      lastHeadSha ?? null,
      JSON.stringify(metadata ?? {})
    ]
  );
}
function parsePackMetadataJson(raw) {
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}
function toPackSummaryFromRow(args) {
  const packType = args.row?.pack_type ?? "project";
  const packPath = args.row?.pack_path ?? "";
  const body = packPath ? readFileIfExists(packPath) : "";
  const exists = packPath.length ? import_node_fs7.default.existsSync(packPath) : false;
  const metadata = parsePackMetadataJson(args.row?.metadata_json);
  return {
    packKey: args.packKey,
    packType,
    path: packPath,
    exists,
    deterministicUpdatedAt: args.row?.deterministic_updated_at ?? null,
    narrativeUpdatedAt: args.row?.narrative_updated_at ?? null,
    lastHeadSha: args.row?.last_head_sha ?? null,
    versionId: args.version?.versionId ?? null,
    versionNumber: args.version?.versionNumber ?? null,
    contentHash: args.version?.contentHash ?? null,
    metadata,
    body
  };
}
function parseNumStat(stdout) {
  const files = /* @__PURE__ */ new Set();
  let insertions = 0;
  let deletions = 0;
  const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const parts = line.split("	");
    if (parts.length < 3) continue;
    const ins = parts[0] ?? "0";
    const del = parts[1] ?? "0";
    const filePath = parts.slice(2).join("	").trim();
    if (filePath.length) files.add(filePath);
    const insNum = ins === "-" ? 0 : Number(ins);
    const delNum = del === "-" ? 0 : Number(del);
    if (Number.isFinite(insNum)) insertions += insNum;
    if (Number.isFinite(delNum)) deletions += delNum;
  }
  return { insertions, deletions, files };
}
function parsePorcelainPaths(stdout) {
  const out = /* @__PURE__ */ new Set();
  const lines = stdout.split("\n").map((line) => line.trimEnd()).filter(Boolean);
  for (const line of lines) {
    if (line.startsWith("??")) {
      const rel = line.slice(2).trim();
      if (rel.length) out.add(rel);
      continue;
    }
    const raw = line.slice(2).trim();
    const arrow = raw.indexOf("->");
    if (arrow >= 0) {
      const rel = raw.slice(arrow + 2).trim();
      if (rel.length) out.add(rel);
      continue;
    }
    if (raw.length) out.add(raw);
  }
  return [...out];
}
function parseChatTranscriptDelta(rawTranscript) {
  const touched = /* @__PURE__ */ new Set();
  const failureLines = [];
  const seenFailure = /* @__PURE__ */ new Set();
  const pushFailure = (value) => {
    const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
    if (!normalized.length) return;
    const clipped = normalized.length > 320 ? normalized.slice(0, 320) : normalized;
    if (seenFailure.has(clipped)) return;
    seenFailure.add(clipped);
    failureLines.push(clipped);
  };
  for (const rawLine of rawTranscript.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.length) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    const event = parsed.event;
    if (!event || typeof event !== "object" || Array.isArray(event)) continue;
    const eventRecord = event;
    const type = typeof eventRecord.type === "string" ? eventRecord.type : "";
    if (type === "file_change") {
      const pathValue = String(eventRecord.path ?? "").trim();
      if (pathValue.length && !pathValue.startsWith("(")) touched.add(pathValue);
      continue;
    }
    if (type === "command") {
      const command = String(eventRecord.command ?? "").trim();
      const output = String(eventRecord.output ?? "");
      const status = String(eventRecord.status ?? "").trim();
      const exitCode = typeof eventRecord.exitCode === "number" ? eventRecord.exitCode : null;
      if (status === "failed" || exitCode != null && exitCode !== 0) {
        pushFailure(command.length ? `Command failed: ${command}` : "Command failed.");
      }
      for (const outputLine of output.split(/\r?\n/)) {
        const normalized = outputLine.replace(/\s+/g, " ").trim();
        if (!normalized.length) continue;
        if (!/\b(error|failed|exception|fatal|traceback)\b/i.test(normalized)) continue;
        pushFailure(normalized);
      }
      continue;
    }
    if (type === "error") {
      pushFailure(String(eventRecord.message ?? "Chat error."));
      continue;
    }
    if (type === "status") {
      const turnStatus = String(eventRecord.turnStatus ?? "").trim();
      if (turnStatus === "failed") {
        pushFailure(String(eventRecord.message ?? "Turn failed."));
      }
    }
  }
  return {
    touchedFiles: uniqueSorted(touched),
    failureLines: failureLines.slice(-16)
  };
}
function extractSection(existing, start, end, fallback) {
  const startIdx = existing.indexOf(start);
  const endIdx = existing.indexOf(end);
  if (startIdx < 0 || endIdx < 0 || endIdx <= startIdx) return fallback;
  const body = existing.slice(startIdx + start.length, endIdx).trim();
  return body.length ? body : fallback;
}
function extractSectionByHeading2(existing, heading) {
  const re = new RegExp(`^${heading.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\s*$`, "m");
  const match = re.exec(existing);
  if (!match?.index && match?.index !== 0) return null;
  const headingStart = match.index;
  const headingLineEnd = existing.indexOf("\n", headingStart);
  const sectionStart = headingLineEnd >= 0 ? headingLineEnd + 1 : existing.length;
  const nextHeading = (() => {
    const r = /^##\s+/gm;
    r.lastIndex = sectionStart;
    const m = r.exec(existing);
    return m ? m.index : -1;
  })();
  const nextHr = (() => {
    const r = /^---\s*$/gm;
    r.lastIndex = sectionStart;
    const m = r.exec(existing);
    return m ? m.index : -1;
  })();
  const candidates = [nextHeading, nextHr].filter((idx) => idx >= 0);
  const sectionEnd = candidates.length ? Math.min(...candidates) : existing.length;
  const body = existing.slice(sectionStart, sectionEnd).trim();
  return body.length ? body : "";
}
function replaceNarrativeSection(existing, narrative) {
  const cleanNarrative = narrative.trim().length ? narrative.trim() : "Narrative generation returned empty content.";
  const next = upsertSectionByHeading({
    content: existing,
    heading: "## Narrative",
    startMarker: ADE_NARRATIVE_START,
    endMarker: ADE_NARRATIVE_END,
    body: cleanNarrative
  });
  return { updated: next.content, insertedMarkers: next.insertedMarkers };
}
function statusFromCode(status) {
  if (status === "passed") return "PASS";
  if (status === "failed") return "FAIL";
  if (status === "running") return "RUNNING";
  if (status === "canceled") return "CANCELED";
  return "TIMED_OUT";
}
function humanToolLabel(toolType) {
  const normalized = String(toolType ?? "").trim().toLowerCase();
  if (!normalized) return "Shell";
  if (normalized === "claude") return "Claude";
  if (normalized === "codex") return "Codex";
  if (normalized === "cursor") return "Cursor";
  if (normalized === "aider") return "Aider";
  if (normalized === "continue") return "Continue";
  if (normalized === "shell") return "Shell";
  return normalized.slice(0, 1).toUpperCase() + normalized.slice(1);
}
function shellQuoteArg(arg) {
  const value = String(arg);
  if (!value.length) return "''";
  if (/^[a-zA-Z0-9_./:-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
function formatCommand(command) {
  if (Array.isArray(command)) return command.map((part) => shellQuoteArg(String(part))).join(" ");
  if (typeof command === "string") return command.trim();
  return JSON.stringify(command);
}
function moduleFromPath(relPath) {
  const normalized = relPath.replace(/\\/g, "/");
  const first = normalized.split("/")[0] ?? normalized;
  return first || ".";
}
function parseDiffNameOnly(stdout) {
  return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}
function uniqueSorted(values) {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}
function normalizeConflictStatus(value) {
  const v = value.trim();
  if (v === "merge-ready" || v === "behind-base" || v === "conflict-predicted" || v === "conflict-active" || v === "unknown") {
    return v;
  }
  return null;
}
function normalizeRiskLevel(value) {
  const v = value.trim();
  if (v === "none" || v === "low" || v === "medium" || v === "high") return v;
  return null;
}
function createPackService({
  db,
  logger,
  projectRoot,
  projectId,
  packsDir,
  laneService,
  sessionService,
  projectConfigService,
  aiIntegrationService,
  operationService,
  onEvent
}) {
  const projectPackPath = import_node_path6.default.join(packsDir, "project_pack.md");
  const projectBootstrapPath = import_node_path6.default.join(packsDir, "_bootstrap", "project_bootstrap.md");
  const getLanePackPath = (laneId) => import_node_path6.default.join(packsDir, "lanes", laneId, "lane_pack.md");
  const getFeaturePackPath = (featureKey) => import_node_path6.default.join(packsDir, "features", safeSegment2(featureKey), "feature_pack.md");
  const getPlanPackPath = (laneId) => import_node_path6.default.join(packsDir, "plans", laneId, "plan_pack.md");
  const getMissionPackPath = (missionId) => import_node_path6.default.join(packsDir, "missions", missionId, "mission_pack.md");
  const getConflictPackPath = (laneId, peer) => import_node_path6.default.join(packsDir, "conflicts", "v2", `${laneId}__${safeSegment2(peer)}.md`);
  const conflictsRootDir = import_node_path6.default.join(packsDir, "conflicts");
  const conflictPredictionsDir = import_node_path6.default.join(conflictsRootDir, "predictions");
  const getConflictPredictionPath = (laneId) => import_node_path6.default.join(conflictPredictionsDir, `${laneId}.json`);
  const getLegacyConflictPredictionPath = (laneId) => import_node_path6.default.join(conflictsRootDir, `${laneId}.json`);
  const versionsDir = import_node_path6.default.join(packsDir, "versions");
  const historyDir = import_node_path6.default.join(import_node_path6.default.dirname(packsDir), "history");
  const checkpointsDir = import_node_path6.default.join(historyDir, "checkpoints");
  const eventsDir = import_node_path6.default.join(historyDir, "events");
  const nowIso3 = () => (/* @__PURE__ */ new Date()).toISOString();
  const sha256 = (input) => (0, import_node_crypto5.createHash)("sha256").update(input).digest("hex");
  const isRecord5 = (value) => !!value && typeof value === "object" && !Array.isArray(value);
  const asString3 = (value) => typeof value === "string" ? value : "";
  const parseRecord = (raw) => {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return isRecord5(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };
  const buildGraphEnvelope = (relations) => ({
    schema: "ade.packGraph.v1",
    relations
  });
  const computeMergeReadiness = (args) => {
    if (args.requiredMerges.length) return "blocked";
    if (args.conflictStatus === "unknown" || args.conflictStatus == null) return "unknown";
    if (args.conflictStatus === "conflict-active" || args.conflictStatus === "conflict-predicted") return "blocked";
    if (args.behindCount > 0) return "needs_sync";
    return "ready";
  };
  const importanceRank = (value) => {
    const v = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (v === "high") return 3;
    if (v === "medium") return 2;
    if (v === "low") return 1;
    return 0;
  };
  const getDefaultSectionLocators = (packType) => {
    if (packType === "lane") {
      return [
        { id: "task_spec", kind: "markers", startMarker: ADE_TASK_SPEC_START, endMarker: ADE_TASK_SPEC_END },
        { id: "intent", kind: "markers", startMarker: ADE_INTENT_START, endMarker: ADE_INTENT_END },
        { id: "todos", kind: "markers", startMarker: ADE_TODOS_START, endMarker: ADE_TODOS_END },
        { id: "narrative", kind: "markers", startMarker: ADE_NARRATIVE_START, endMarker: ADE_NARRATIVE_END },
        { id: "what_changed", kind: "heading", heading: "## What Changed" },
        { id: "validation", kind: "heading", heading: "## Validation" },
        { id: "errors", kind: "heading", heading: "## Errors & Issues" },
        { id: "sessions", kind: "heading", heading: "## Sessions" }
      ];
    }
    if (packType === "conflict") {
      return [
        { id: "overlap", kind: "heading", heading: "## Overlapping Files" },
        { id: "conflicts", kind: "heading", heading: "## Conflicts (merge-tree)" },
        { id: "lane_excerpt", kind: "heading", heading: "## Lane Pack (Excerpt)" }
      ];
    }
    return [
      { id: "bootstrap", kind: "heading", heading: "## Bootstrap context (codebase + docs)" },
      { id: "lane_snapshot", kind: "heading", heading: "## Lane Snapshot" }
    ];
  };
  const inferPackTypeFromKey = (packKey) => {
    if (packKey === "project") return "project";
    if (packKey.startsWith("lane:")) return "lane";
    if (packKey.startsWith("feature:")) return "feature";
    if (packKey.startsWith("conflict:")) return "conflict";
    if (packKey.startsWith("plan:")) return "plan";
    if (packKey.startsWith("mission:")) return "mission";
    return "project";
  };
  const CONTEXT_VERSION = 1;
  const BOOTSTRAP_FINGERPRINT_RE = /<!--\s*ADE_DOCS_FINGERPRINT:([a-f0-9]{64})\s*-->/i;
  const ADE_DOC_PRD_REL = ".ade/context/PRD.ade.md";
  const ADE_DOC_ARCH_REL = ".ade/context/ARCHITECTURE.ade.md";
  const CONTEXT_DOC_LAST_RUN_KEY = "context:docs:lastRun.v1";
  const FALLBACK_GENERATED_ROOT = import_node_path6.default.join(import_node_path6.default.dirname(packsDir), "context", "generated");
  const CONTEXT_CLIP_TAG = "omitted_due_size";
  const nowTimestampSegment = () => {
    const iso = nowIso3();
    return iso.replace(/[:]/g, "-").replace(/\..+$/, "Z");
  };
  const safeReadDoc = (absPath, maxBytes) => {
    try {
      const fd = import_node_fs7.default.openSync(absPath, "r");
      try {
        const buf = Buffer.alloc(maxBytes);
        const bytesRead = import_node_fs7.default.readSync(fd, buf, 0, maxBytes, 0);
        const text = buf.slice(0, Math.max(0, bytesRead)).toString("utf8");
        const size = import_node_fs7.default.statSync(absPath).size;
        return { text, truncated: size > bytesRead };
      } finally {
        import_node_fs7.default.closeSync(fd);
      }
    } catch {
      return { text: "", truncated: false };
    }
  };
  const formatDocDigest = (args) => {
    const warnings = [];
    const lines = [
      `# ${args.title}`,
      "",
      "> ADE minimized context document. Generated deterministically for model context.",
      ""
    ];
    let usedChars = lines.join("\n").length;
    for (const rel of args.sources) {
      const abs = import_node_path6.default.join(projectRoot, rel);
      if (!import_node_fs7.default.existsSync(abs)) continue;
      const read = safeReadDoc(abs, 16e4);
      if (!read.text.trim()) continue;
      const normalized = read.text.replace(/\r\n/g, "\n");
      const sourceLines = normalized.split("\n");
      const digest = [];
      for (const line of sourceLines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith("```")) continue;
        digest.push(trimmed);
        if (digest.join(" ").length > 1400) break;
      }
      const blockHeader = `## Source: ${rel}`;
      const block = [blockHeader, ...digest.slice(0, 16), ""].join("\n");
      if (usedChars + block.length > args.maxChars) {
        warnings.push(`${CONTEXT_CLIP_TAG}:${rel}`);
        lines.push(blockHeader);
        lines.push(`- ${CONTEXT_CLIP_TAG}: source exceeded generation cap`);
        lines.push("");
        continue;
      }
      lines.push(blockHeader);
      for (const entry of digest.slice(0, 16)) lines.push(entry);
      if (read.truncated) lines.push(`- ${CONTEXT_CLIP_TAG}: source file truncated while reading`);
      lines.push("");
      usedChars = lines.join("\n").length;
    }
    if (warnings.length) {
      lines.push("## Omitted");
      for (const warning of warnings) lines.push(`- ${warning}`);
      lines.push("");
    }
    return { content: `${lines.join("\n").trim()}
`, warnings };
  };
  const extractFirstJsonObject2 = (text) => {
    const raw = text.trim();
    if (!raw) return null;
    if (raw.startsWith("{") && raw.endsWith("}")) return raw;
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced?.[1]) {
      const inner = fenced[1].trim();
      if (inner.startsWith("{") && inner.endsWith("}")) return inner;
    }
    const first = raw.indexOf("{");
    const last = raw.lastIndexOf("}");
    if (first >= 0 && last > first) {
      const candidate = raw.slice(first, last + 1).trim();
      if (candidate.startsWith("{") && candidate.endsWith("}")) return candidate;
    }
    return null;
  };
  const writeDocWithFallback = (args) => {
    try {
      ensureDirFor(args.preferredAbsPath);
      import_node_fs7.default.writeFileSync(args.preferredAbsPath, args.content, "utf8");
      return { writtenPath: args.preferredAbsPath, usedFallback: false, warning: null };
    } catch (error) {
      const ts = nowTimestampSegment();
      const fallbackDir = import_node_path6.default.join(FALLBACK_GENERATED_ROOT, ts);
      import_node_fs7.default.mkdirSync(fallbackDir, { recursive: true });
      const fallbackPath = import_node_path6.default.join(fallbackDir, args.fallbackFileName);
      import_node_fs7.default.writeFileSync(fallbackPath, args.content, "utf8");
      const reason = error instanceof Error ? error.message : String(error);
      return {
        writtenPath: fallbackPath,
        usedFallback: true,
        warning: `write_failed_preferred_path:${args.preferredAbsPath}:${reason}`
      };
    }
  };
  const collectContextDocPaths = () => {
    const out = /* @__PURE__ */ new Set(["docs/PRD.md", ADE_DOC_PRD_REL, ADE_DOC_ARCH_REL]);
    const walk = (relDir, depth) => {
      if (depth < 0) return;
      const abs = import_node_path6.default.join(projectRoot, relDir);
      if (!import_node_fs7.default.existsSync(abs)) return;
      let entries = [];
      try {
        entries = import_node_fs7.default.readdirSync(abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const rel = import_node_path6.default.join(relDir, entry.name).replace(/\\/g, "/");
        if (entry.isDirectory()) {
          walk(rel, depth - 1);
          continue;
        }
        if (!entry.isFile()) continue;
        if (!/\.(md|mdx|txt|yaml|yml|json)$/i.test(entry.name)) continue;
        out.add(rel);
      }
    };
    walk("docs/architecture", 3);
    walk("docs/features", 3);
    return [...out].sort((a, b) => a.localeCompare(b)).sort((a, b) => {
      const aAde = a.endsWith(".ade.md") ? 0 : 1;
      const bAde = b.endsWith(".ade.md") ? 0 : 1;
      return aAde - bAde;
    });
  };
  const readContextDocMeta = () => {
    const paths = collectContextDocPaths();
    const entries = [];
    for (const rel of paths) {
      const abs = import_node_path6.default.join(projectRoot, rel);
      try {
        const st = import_node_fs7.default.statSync(abs);
        if (!st.isFile()) continue;
        entries.push({ path: rel, size: st.size, mtimeMs: st.mtimeMs });
      } catch {
      }
    }
    const contextFingerprint = sha256(JSON.stringify(entries));
    const latestMtime = entries.reduce((max, entry) => Math.max(max, entry.mtimeMs), 0);
    return {
      contextFingerprint,
      contextVersion: CONTEXT_VERSION,
      lastDocsRefreshAt: latestMtime > 0 ? new Date(latestMtime).toISOString() : null,
      docsStaleReason: entries.length ? null : "docs_missing_or_unreadable"
    };
  };
  const collectCanonicalContextDocPaths = () => collectContextDocPaths().filter((rel) => !rel.endsWith(".ade.md"));
  const readCanonicalDocMeta = () => {
    const paths = collectCanonicalContextDocPaths();
    const present = [];
    for (const rel of paths) {
      try {
        const st = import_node_fs7.default.statSync(import_node_path6.default.join(projectRoot, rel));
        if (!st.isFile()) continue;
        present.push({ path: rel, size: st.size, mtimeMs: st.mtimeMs });
      } catch {
      }
    }
    const latestMtime = present.reduce((max, entry) => Math.max(max, entry.mtimeMs), 0);
    return {
      scanned: paths.length,
      present: present.length,
      fingerprint: sha256(JSON.stringify(present)),
      updatedAt: latestMtime > 0 ? new Date(latestMtime).toISOString() : null
    };
  };
  const readDocStatus = (args) => {
    const absPath = import_node_path6.default.join(projectRoot, args.relPath);
    let exists = false;
    let sizeBytes = 0;
    let updatedAt = null;
    let fingerprint = null;
    try {
      const st = import_node_fs7.default.statSync(absPath);
      if (st.isFile()) {
        exists = true;
        sizeBytes = st.size;
        updatedAt = st.mtime.toISOString();
        const body = import_node_fs7.default.readFileSync(absPath, "utf8");
        fingerprint = sha256(body);
      }
    } catch {
    }
    const staleReason = (() => {
      if (!exists) return "missing";
      if (!updatedAt || !args.canonicalUpdatedAt) return null;
      const docTs = Date.parse(updatedAt);
      const canonicalTs = Date.parse(args.canonicalUpdatedAt);
      if (Number.isFinite(docTs) && Number.isFinite(canonicalTs) && docTs < canonicalTs) {
        return "older_than_canonical_docs";
      }
      return null;
    })();
    return {
      id: args.id,
      label: args.label,
      preferredPath: args.relPath,
      exists,
      sizeBytes,
      updatedAt,
      fingerprint,
      staleReason,
      fallbackCount: args.fallbackCount
    };
  };
  const countFallbackWrites = () => {
    if (!import_node_fs7.default.existsSync(FALLBACK_GENERATED_ROOT)) return 0;
    const walk = (dir) => {
      let total = 0;
      let entries = [];
      try {
        entries = import_node_fs7.default.readdirSync(dir, { withFileTypes: true });
      } catch {
        return 0;
      }
      for (const entry of entries) {
        const abs = import_node_path6.default.join(dir, entry.name);
        if (entry.isDirectory()) total += walk(abs);
        if (entry.isFile() && entry.name.endsWith(".ade.md")) total += 1;
      }
      return total;
    };
    return walk(FALLBACK_GENERATED_ROOT);
  };
  const readContextStatus = () => {
    const canonical = readCanonicalDocMeta();
    const fallbackCount = countFallbackWrites();
    const latestRunRaw = db.getJson(CONTEXT_DOC_LAST_RUN_KEY);
    const latestWarnings = Array.isArray(latestRunRaw?.warnings) ? latestRunRaw.warnings.map((warning) => ({
      code: String(warning?.code ?? "unknown"),
      message: String(warning?.message ?? ""),
      ...warning?.actionLabel ? { actionLabel: String(warning.actionLabel) } : {},
      ...warning?.actionPath ? { actionPath: String(warning.actionPath) } : {}
    })) : [];
    const docs = [
      readDocStatus({
        id: "prd_ade",
        label: "PRD (ADE minimized)",
        relPath: ADE_DOC_PRD_REL,
        canonicalUpdatedAt: canonical.updatedAt,
        fallbackCount
      }),
      readDocStatus({
        id: "architecture_ade",
        label: "Architecture (ADE minimized)",
        relPath: ADE_DOC_ARCH_REL,
        canonicalUpdatedAt: canonical.updatedAt,
        fallbackCount
      })
    ];
    const projectPackIndex = db.get(
      `
        select metadata_json, deterministic_updated_at
        from packs_index
        where project_id = ?
          and pack_key = 'project'
        limit 1
      `,
      [projectId]
    );
    const projectPackMeta = (() => {
      if (!projectPackIndex?.metadata_json) return {};
      try {
        const parsed = JSON.parse(projectPackIndex.metadata_json);
        return isRecord5(parsed) ? parsed : {};
      } catch {
        return {};
      }
    })();
    const insufficientContextCount = Number(
      db.get(
        `
          select count(1) as count
          from conflict_proposals
          where project_id = ?
            and metadata_json like '%"insufficientContext":true%'
        `,
        [projectId]
      )?.count ?? 0
    );
    return {
      docs,
      canonicalDocsPresent: canonical.present,
      canonicalDocsScanned: canonical.scanned,
      canonicalDocsFingerprint: canonical.fingerprint,
      canonicalDocsUpdatedAt: canonical.updatedAt,
      projectExportFingerprint: typeof projectPackMeta.contextFingerprint === "string" ? projectPackMeta.contextFingerprint : null,
      projectExportUpdatedAt: projectPackIndex?.deterministic_updated_at ?? null,
      contextManifestRefs: {
        project: null,
        packs: null,
        transcripts: null
      },
      fallbackWrites: fallbackCount,
      insufficientContextCount,
      warnings: latestWarnings
    };
  };
  const runContextDocGeneration = async (args) => {
    const provider = args.provider;
    const generatedAt = nowIso3();
    const warnings = [];
    const canonicalPaths = collectCanonicalContextDocPaths();
    const prdDigest = formatDocDigest({
      title: "PRD.ade",
      sources: canonicalPaths.filter((rel) => /prd|product|roadmap|feature/i.test(rel)).concat(["docs/PRD.md"]).filter(Boolean),
      maxChars: 18e3
    });
    const archDigest = formatDocDigest({
      title: "ARCHITECTURE.ade",
      sources: canonicalPaths.filter((rel) => /architecture|system|design|lanes|conflict|pack/i.test(rel)),
      maxChars: 2e4
    });
    for (const warning of [...prdDigest.warnings, ...archDigest.warnings]) {
      warnings.push({ code: "omitted_due_size", message: warning });
    }
    const prompt = [
      "Generate two markdown documents from the provided repository context digest.",
      "Return ONLY one JSON object with this exact shape:",
      '{"prd":"<markdown>","architecture":"<markdown>"}',
      "Do not include markdown fences or prose outside JSON.",
      "",
      "PRD source digest:",
      prdDigest.content,
      "",
      "Architecture source digest:",
      archDigest.content
    ].join("\n");
    let generatedPrd = "";
    let generatedArch = "";
    let outputPreview = "";
    if (!aiIntegrationService || aiIntegrationService.getMode() === "guest") {
      warnings.push({
        code: "generator_failed",
        message: `provider=${provider} ai_unavailable`
      });
    } else {
      try {
        const aiResult = await aiIntegrationService.generateInitialContext({
          cwd: projectRoot,
          provider: provider === "codex" ? "codex" : "claude",
          prompt,
          timeoutMs: 12e4,
          jsonSchema: {
            type: "object",
            additionalProperties: false,
            properties: {
              prd: { type: "string" },
              architecture: { type: "string" }
            },
            required: ["prd", "architecture"]
          }
        });
        outputPreview = aiResult.text.trim().slice(0, 1500);
        const structured = isRecord5(aiResult.structuredOutput) ? aiResult.structuredOutput : null;
        if (structured) {
          generatedPrd = asString3(structured.prd).trim();
          generatedArch = asString3(structured.architecture).trim();
        }
        if (!generatedPrd || !generatedArch) {
          const rawJson = extractFirstJsonObject2(aiResult.text);
          if (rawJson) {
            try {
              const parsed = JSON.parse(rawJson);
              if (isRecord5(parsed)) {
                if (!generatedPrd) generatedPrd = asString3(parsed.prd).trim();
                if (!generatedArch) generatedArch = asString3(parsed.architecture).trim();
              }
            } catch {
            }
          }
        }
      } catch (error) {
        warnings.push({
          code: "generator_failed",
          message: `provider=${provider} error=${error instanceof Error ? error.message : String(error)}`
        });
      }
    }
    if (!generatedPrd.trim()) {
      generatedPrd = prdDigest.content;
      warnings.push({ code: "generator_fallback_prd", message: "Used deterministic fallback PRD digest." });
    }
    if (!generatedArch.trim()) {
      generatedArch = archDigest.content;
      warnings.push({ code: "generator_fallback_architecture", message: "Used deterministic fallback architecture digest." });
    }
    const prdWrite = writeDocWithFallback({
      preferredAbsPath: import_node_path6.default.join(projectRoot, ADE_DOC_PRD_REL),
      fallbackFileName: "PRD.ade.md",
      content: generatedPrd
    });
    const archWrite = writeDocWithFallback({
      preferredAbsPath: import_node_path6.default.join(projectRoot, ADE_DOC_ARCH_REL),
      fallbackFileName: "ARCHITECTURE.ade.md",
      content: generatedArch
    });
    if (prdWrite.warning) {
      warnings.push({
        code: "write_fallback_prd",
        message: prdWrite.warning,
        actionLabel: "Open fallback PRD",
        actionPath: prdWrite.writtenPath
      });
    }
    if (archWrite.warning) {
      warnings.push({
        code: "write_fallback_architecture",
        message: archWrite.warning,
        actionLabel: "Open fallback architecture",
        actionPath: archWrite.writtenPath
      });
    }
    db.setJson(CONTEXT_DOC_LAST_RUN_KEY, {
      generatedAt,
      provider,
      prdPath: prdWrite.writtenPath,
      architecturePath: archWrite.writtenPath,
      warnings
    });
    return {
      provider,
      generatedAt,
      prdPath: prdWrite.writtenPath,
      architecturePath: archWrite.writtenPath,
      usedFallbackPath: prdWrite.usedFallback || archWrite.usedFallback,
      warnings,
      outputPreview
    };
  };
  const prepareContextDocGeneration = (args) => {
    let cwd = projectRoot;
    try {
      const info = laneService.getLaneBaseAndBranch(args.laneId);
      if (info.worktreePath) cwd = info.worktreePath;
    } catch {
    }
    const tmpRoot = import_node_path6.default.join(import_node_path6.default.dirname(packsDir), "context", "tmp");
    import_node_fs7.default.mkdirSync(tmpRoot, { recursive: true });
    try {
      const cutoff = Date.now() - 24 * 60 * 60 * 1e3;
      for (const entry of import_node_fs7.default.readdirSync(tmpRoot)) {
        const abs = import_node_path6.default.join(tmpRoot, entry);
        try {
          const stat = import_node_fs7.default.statSync(abs);
          if (stat.mtimeMs < cutoff) import_node_fs7.default.rmSync(abs, { force: true });
        } catch {
        }
      }
    } catch {
    }
    const outputPrdPath = import_node_path6.default.join(projectRoot, ADE_DOC_PRD_REL);
    const outputArchPath = import_node_path6.default.join(projectRoot, ADE_DOC_ARCH_REL);
    import_node_fs7.default.mkdirSync(import_node_path6.default.dirname(outputPrdPath), { recursive: true });
    import_node_fs7.default.mkdirSync(import_node_path6.default.dirname(outputArchPath), { recursive: true });
    const prompt = `# ADE Context Document Generation

You are generating context documentation for a software project. Explore this
codebase and produce two markdown files that ADE uses as context for AI coding
agents working in this repository.

## Output Files \u2014 Write exactly two files:

1. \`${outputPrdPath}\` \u2014 Product Requirements Document
2. \`${outputArchPath}\` \u2014 Architecture Document

## Exploration Strategy

Before writing, explore to understand:
- Project structure (top-level directories, key files)
- Dependencies and package manager (package.json, Cargo.toml, go.mod, etc.)
- Existing documentation (README, docs/, CONTRIBUTING)
- Source code organization (src/, lib/, app/)
- Test structure and frameworks
- Build and CI configuration
- Key entry points and main modules

## PRD Document Content

- **Project Overview**: What this project does, its purpose, target users
- **Key Features**: Main capabilities, described functionally
- **Technical Stack**: Languages, frameworks, key dependencies
- **Project Status**: Current state, recent activity
- **Development Workflow**: Branching strategy, contribution patterns
- **Key Concepts**: Important domain terminology

## Architecture Document Content

- **System Overview**: High-level architecture (layers, services, components)
- **Directory Structure**: Key directories and their purposes
- **Core Modules**: Most important modules and responsibilities
- **Data Flow**: How data moves through the system
- **Key Patterns**: Design patterns used (MVC, event sourcing, etc.)
- **Configuration**: How the app is configured
- **Build & Deploy**: Build system, deployment targets
- **Testing Strategy**: Test organization and frameworks

## Rules

- Base everything on actual code you read \u2014 do not speculate
- Keep each document concise (under 2500 words)
- Use the project's actual terminology
- If existing docs/ exist, use them as primary source material
- Write the files directly to the paths above \u2014 do not ask questions
`;
    const promptFilePath = import_node_path6.default.join(tmpRoot, `generate-context-${Date.now()}.md`);
    import_node_fs7.default.writeFileSync(promptFilePath, prompt, "utf8");
    return { promptFilePath, outputPrdPath, outputArchPath, cwd, provider: args.provider };
  };
  const installGeneratedDocs = (args) => {
    const generatedAt = nowIso3();
    const warnings = [];
    let generatedPrd = "";
    let generatedArch = "";
    try {
      if (import_node_fs7.default.existsSync(args.outputPrdPath)) generatedPrd = import_node_fs7.default.readFileSync(args.outputPrdPath, "utf8");
    } catch {
    }
    try {
      if (import_node_fs7.default.existsSync(args.outputArchPath)) generatedArch = import_node_fs7.default.readFileSync(args.outputArchPath, "utf8");
    } catch {
    }
    if (!generatedPrd.trim()) {
      warnings.push({ code: "output_missing_prd", message: "PRD file was not created by the agent." });
    }
    if (!generatedArch.trim()) {
      warnings.push({ code: "output_missing_architecture", message: "Architecture file was not created by the agent." });
    }
    const prdWrite = generatedPrd.trim() ? writeDocWithFallback({ preferredAbsPath: import_node_path6.default.join(projectRoot, ADE_DOC_PRD_REL), fallbackFileName: "PRD.ade.md", content: generatedPrd }) : { writtenPath: import_node_path6.default.join(projectRoot, ADE_DOC_PRD_REL), usedFallback: false, warning: null };
    const archWrite = generatedArch.trim() ? writeDocWithFallback({ preferredAbsPath: import_node_path6.default.join(projectRoot, ADE_DOC_ARCH_REL), fallbackFileName: "ARCHITECTURE.ade.md", content: generatedArch }) : { writtenPath: import_node_path6.default.join(projectRoot, ADE_DOC_ARCH_REL), usedFallback: false, warning: null };
    if (prdWrite.warning) {
      warnings.push({ code: "write_fallback_prd", message: prdWrite.warning, actionLabel: "Open fallback PRD", actionPath: prdWrite.writtenPath });
    }
    if (archWrite.warning) {
      warnings.push({ code: "write_fallback_architecture", message: archWrite.warning, actionLabel: "Open fallback architecture", actionPath: archWrite.writtenPath });
    }
    db.setJson(CONTEXT_DOC_LAST_RUN_KEY, {
      generatedAt,
      provider: args.provider,
      prdPath: prdWrite.writtenPath,
      architecturePath: archWrite.writtenPath,
      warnings
    });
    return {
      provider: args.provider,
      generatedAt,
      prdPath: prdWrite.writtenPath,
      architecturePath: archWrite.writtenPath,
      usedFallbackPath: prdWrite.usedFallback || archWrite.usedFallback,
      warnings,
      outputPreview: ""
    };
  };
  const resolveContextDocPath = (docId) => {
    if (docId === "prd_ade") return import_node_path6.default.join(projectRoot, ADE_DOC_PRD_REL);
    return import_node_path6.default.join(projectRoot, ADE_DOC_ARCH_REL);
  };
  const findBaselineVersionAtOrBefore = (args) => {
    const row = db.get(
      `
        select id, version_number, created_at
        from pack_versions
        where project_id = ?
          and pack_key = ?
          and created_at <= ?
        order by created_at desc
        limit 1
      `,
      [projectId, args.packKey, args.sinceIso]
    );
    if (!row?.id) return null;
    return { id: row.id, versionNumber: Number(row.version_number ?? 0), createdAt: row.created_at };
  };
  const classifyPackEvent = (args) => {
    const eventType = args.eventType;
    const payload = args.payload ?? {};
    const entityIdsSet = /* @__PURE__ */ new Set();
    const entityRefs = [];
    const addEntity = (kind, idRaw) => {
      const id = typeof idRaw === "string" ? idRaw.trim() : "";
      if (!id) return;
      entityIdsSet.add(id);
      entityRefs.push({ kind, id });
    };
    if (args.packKey.startsWith("lane:")) addEntity("lane", args.packKey.slice("lane:".length));
    if (args.packKey.startsWith("conflict:")) {
      const parts = args.packKey.split(":");
      if (parts.length >= 2) addEntity("lane", parts[1]);
      if (parts.length >= 3) addEntity("peer", parts.slice(2).join(":"));
    }
    addEntity("lane", payload.laneId);
    addEntity("lane", payload.peerLaneId);
    addEntity("session", payload.sessionId);
    addEntity("checkpoint", payload.checkpointId);
    addEntity("version", payload.versionId);
    addEntity("operation", payload.operationId);
    addEntity("job", payload.jobId);
    addEntity("artifact", payload.artifactId);
    addEntity("proposal", payload.proposalId);
    const category = (() => {
      if (eventType.startsWith("narrative_")) return "narrative";
      if (eventType === "checkpoint") return "session";
      if (eventType.includes("conflict")) return "conflict";
      if (eventType.includes("branch")) return "branch";
      return "pack";
    })();
    const importance = (() => {
      if (eventType === "narrative_update") return "high";
      if (eventType === "narrative_failed") return "high";
      if (eventType === "checkpoint") return "medium";
      if (eventType === "refresh_triggered") return "medium";
      if (eventType === "narrative_requested") return "medium";
      return "low";
    })();
    const importanceScore = importance === "high" ? 0.9 : importance === "medium" ? 0.6 : 0.25;
    const rationale = (() => {
      const trigger = typeof payload.trigger === "string" ? payload.trigger.trim() : "";
      if (trigger) return trigger;
      const source = typeof payload.source === "string" ? payload.source.trim() : "";
      if (source) return source;
      return null;
    })();
    return {
      importance,
      importanceScore,
      category,
      entityIds: Array.from(entityIdsSet),
      entityRefs,
      actionType: eventType,
      rationale
    };
  };
  const ensureEventMeta = (event) => {
    const payload = event.payload ?? {};
    const hasMeta = payload.importance != null || payload.importanceScore != null || payload.category != null || payload.entityIds != null || payload.entityRefs != null || payload.actionType != null || payload.rationale != null;
    if (hasMeta) return event;
    const meta = classifyPackEvent({
      packKey: event.packKey,
      eventType: event.eventType,
      createdAt: event.createdAt,
      payload
    });
    return {
      ...event,
      payload: {
        ...payload,
        importance: meta.importance,
        importanceScore: meta.importanceScore,
        category: meta.category,
        entityIds: meta.entityIds,
        entityRefs: meta.entityRefs,
        actionType: meta.actionType,
        rationale: meta.rationale
      }
    };
  };
  const upsertEventMetaForInsert = (args) => {
    const payload = args.payload ?? {};
    const out = { ...payload };
    const meta = classifyPackEvent(args);
    if (out.importance == null) out.importance = meta.importance;
    if (out.importanceScore == null) out.importanceScore = meta.importanceScore;
    if (out.category == null) out.category = meta.category;
    if (out.entityIds == null) out.entityIds = meta.entityIds;
    if (out.entityRefs == null) out.entityRefs = meta.entityRefs;
    if (out.actionType == null) out.actionType = meta.actionType;
    if (out.rationale == null) out.rationale = meta.rationale;
    return out;
  };
  const readGatewayMeta = () => {
    return { apiBaseUrl: null, remoteProjectId: null };
  };
  const ensureDir = (dirPath) => {
    import_node_fs7.default.mkdirSync(dirPath, { recursive: true });
  };
  const safeSegment2 = (raw) => {
    const trimmed = raw.trim();
    if (!trimmed) return "untitled";
    return trimmed.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
  };
  const PACK_RETENTION_KEEP_DAYS = 14;
  const PACK_RETENTION_MAX_ARCHIVED_LANES = 25;
  const PACK_RETENTION_CLEANUP_INTERVAL_MS = 60 * 6e4;
  let lastCleanupAt = 0;
  const cleanupPacks = async () => {
    const lanes = await laneService.list({ includeArchived: true });
    const laneById2 = new Map(lanes.map((lane) => [lane.id, lane]));
    const now = Date.now();
    const keepBeforeMs = now - PACK_RETENTION_KEEP_DAYS * 24 * 60 * 6e4;
    const lanesDir = import_node_path6.default.join(packsDir, "lanes");
    const conflictsDir = import_node_path6.default.join(packsDir, "conflicts");
    const archivedDirs = [];
    if (import_node_fs7.default.existsSync(lanesDir)) {
      for (const entry of import_node_fs7.default.readdirSync(lanesDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const laneId = entry.name;
        const lane = laneById2.get(laneId);
        const absDir = import_node_path6.default.join(lanesDir, laneId);
        if (!lane) {
          import_node_fs7.default.rmSync(absDir, { recursive: true, force: true });
          continue;
        }
        if (!lane.archivedAt) continue;
        const ts = Date.parse(lane.archivedAt);
        const archivedAtMs = Number.isFinite(ts) ? ts : now;
        archivedDirs.push({ laneId, archivedAtMs });
      }
    }
    archivedDirs.sort((a, b) => b.archivedAtMs - a.archivedAtMs);
    const keepByCount = new Set(archivedDirs.slice(0, PACK_RETENTION_MAX_ARCHIVED_LANES).map((entry) => entry.laneId));
    for (const { laneId, archivedAtMs } of archivedDirs) {
      if (keepByCount.has(laneId) && archivedAtMs >= keepBeforeMs) continue;
      const absDir = import_node_path6.default.join(lanesDir, laneId);
      import_node_fs7.default.rmSync(absDir, { recursive: true, force: true });
    }
    if (import_node_fs7.default.existsSync(conflictsDir)) {
      for (const entry of import_node_fs7.default.readdirSync(conflictsDir, { withFileTypes: true })) {
        if (!entry.isFile()) continue;
        if (!entry.name.endsWith(".json")) continue;
        const laneId = entry.name.slice(0, -".json".length);
        const lane = laneById2.get(laneId);
        if (!lane) {
          import_node_fs7.default.rmSync(import_node_path6.default.join(conflictsDir, entry.name), { force: true });
          continue;
        }
        if (!lane.archivedAt) continue;
        const ts = Date.parse(lane.archivedAt);
        const archivedAtMs = Number.isFinite(ts) ? ts : now;
        if (!keepByCount.has(laneId) || archivedAtMs < keepBeforeMs) {
          import_node_fs7.default.rmSync(import_node_path6.default.join(conflictsDir, entry.name), { force: true });
        }
      }
      const predictionsDir = import_node_path6.default.join(conflictsDir, "predictions");
      if (import_node_fs7.default.existsSync(predictionsDir)) {
        for (const entry of import_node_fs7.default.readdirSync(predictionsDir, { withFileTypes: true })) {
          if (!entry.isFile()) continue;
          if (!entry.name.endsWith(".json")) continue;
          const laneId = entry.name.slice(0, -".json".length);
          const lane = laneById2.get(laneId);
          const absPath = import_node_path6.default.join(predictionsDir, entry.name);
          if (!lane) {
            import_node_fs7.default.rmSync(absPath, { force: true });
            continue;
          }
          if (!lane.archivedAt) continue;
          const ts = Date.parse(lane.archivedAt);
          const archivedAtMs = Number.isFinite(ts) ? ts : now;
          if (!keepByCount.has(laneId) || archivedAtMs < keepBeforeMs) {
            import_node_fs7.default.rmSync(absPath, { force: true });
          }
        }
      }
      const v2Dir = import_node_path6.default.join(conflictsDir, "v2");
      if (import_node_fs7.default.existsSync(v2Dir)) {
        for (const entry of import_node_fs7.default.readdirSync(v2Dir, { withFileTypes: true })) {
          if (!entry.isFile()) continue;
          if (!entry.name.endsWith(".md")) continue;
          const file = entry.name;
          const laneId = file.split("__")[0]?.trim() ?? "";
          if (!laneId) continue;
          const lane = laneById2.get(laneId);
          const absPath = import_node_path6.default.join(v2Dir, file);
          if (!lane) {
            import_node_fs7.default.rmSync(absPath, { force: true });
            continue;
          }
          if (!lane.archivedAt) continue;
          const ts = Date.parse(lane.archivedAt);
          const archivedAtMs = Number.isFinite(ts) ? ts : now;
          if (!keepByCount.has(laneId) || archivedAtMs < keepBeforeMs) {
            import_node_fs7.default.rmSync(absPath, { force: true });
          }
        }
      }
    }
  };
  const maybeCleanupPacks = () => {
    const now = Date.now();
    if (now - lastCleanupAt < PACK_RETENTION_CLEANUP_INTERVAL_MS) return;
    lastCleanupAt = now;
    void cleanupPacks().catch((error) => {
      logger.warn("packs.cleanup_failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    });
  };
  const readCurrentPackVersion = (packKey) => {
    const row = db.get(
      `
        select v.id as id, v.version_number as version_number, v.content_hash as content_hash, v.rendered_path as rendered_path
        from pack_heads h
        join pack_versions v on v.id = h.current_version_id and v.project_id = h.project_id
        where h.project_id = ?
          and h.pack_key = ?
        limit 1
      `,
      [projectId, packKey]
    );
    if (!row?.id) return null;
    return {
      versionId: row.id,
      versionNumber: Number(row.version_number ?? 0),
      contentHash: String(row.content_hash ?? ""),
      renderedPath: String(row.rendered_path ?? "")
    };
  };
  const createPackEvent = (args) => {
    const eventId = (0, import_node_crypto5.randomUUID)();
    const createdAt = nowIso3();
    const payload = upsertEventMetaForInsert({
      packKey: args.packKey,
      eventType: args.eventType,
      createdAt,
      payload: args.payload ?? {}
    });
    db.run(
      `
        insert into pack_events(
          id,
          project_id,
          pack_key,
          event_type,
          payload_json,
          created_at
        ) values (?, ?, ?, ?, ?, ?)
      `,
      [eventId, projectId, args.packKey, args.eventType, JSON.stringify(payload), createdAt]
    );
    const event = ensureEventMeta({ id: eventId, packKey: args.packKey, eventType: args.eventType, payload, createdAt });
    try {
      const monthKey = createdAt.slice(0, 7);
      const monthDir = import_node_path6.default.join(eventsDir, monthKey);
      ensureDir(monthDir);
      import_node_fs7.default.writeFileSync(
        import_node_path6.default.join(monthDir, `${eventId}.json`),
        JSON.stringify(event, null, 2),
        "utf8"
      );
    } catch {
    }
    try {
      onEvent?.(event);
    } catch {
    }
    return event;
  };
  const createPackVersion = (args) => {
    const bodyHash = sha256(args.body);
    const existing = readCurrentPackVersion(args.packKey);
    if (existing && existing.contentHash === bodyHash) {
      return {
        versionId: existing.versionId,
        versionNumber: existing.versionNumber,
        contentHash: existing.contentHash
      };
    }
    const versionId = (0, import_node_crypto5.randomUUID)();
    const createdAt = nowIso3();
    const maxRow = db.get(
      "select max(version_number) as max_version from pack_versions where project_id = ? and pack_key = ?",
      [projectId, args.packKey]
    );
    const versionNumber = Number(maxRow?.max_version ?? 0) + 1;
    const renderedPath = import_node_path6.default.join(versionsDir, `${versionId}.md`);
    ensureDir(versionsDir);
    import_node_fs7.default.writeFileSync(renderedPath, args.body, "utf8");
    db.run(
      `
        insert into pack_versions(
          id,
          project_id,
          pack_key,
          version_number,
          content_hash,
          rendered_path,
          created_at
        ) values (?, ?, ?, ?, ?, ?, ?)
      `,
      [versionId, projectId, args.packKey, versionNumber, bodyHash, renderedPath, createdAt]
    );
    db.run(
      `
        insert into pack_heads(project_id, pack_key, current_version_id, updated_at)
        values (?, ?, ?, ?)
        on conflict(project_id, pack_key) do update set
          current_version_id = excluded.current_version_id,
          updated_at = excluded.updated_at
      `,
      [projectId, args.packKey, versionId, createdAt]
    );
    createPackEvent({
      packKey: args.packKey,
      eventType: "version_created",
      payload: {
        packKey: args.packKey,
        packType: args.packType,
        versionId,
        versionNumber,
        contentHash: bodyHash
      }
    });
    return { versionId, versionNumber, contentHash: bodyHash };
  };
  const persistPackRefresh = (args) => {
    ensureDirFor(args.packPath);
    import_node_fs7.default.writeFileSync(args.packPath, args.body, "utf8");
    createPackEvent({
      packKey: args.packKey,
      eventType: args.eventType ?? "refresh_triggered",
      payload: args.eventPayload ?? {}
    });
    const version = createPackVersion({ packKey: args.packKey, packType: args.packType, body: args.body });
    const metadata = {
      ...args.metadata ?? {},
      versionId: version.versionId,
      versionNumber: version.versionNumber,
      contentHash: version.contentHash
    };
    upsertPackIndex({
      db,
      projectId,
      packKey: args.packKey,
      laneId: args.laneId,
      packType: args.packType,
      packPath: args.packPath,
      deterministicUpdatedAt: args.deterministicUpdatedAt,
      narrativeUpdatedAt: args.narrativeUpdatedAt ?? null,
      lastHeadSha: args.lastHeadSha ?? null,
      metadata
    });
    maybeCleanupPacks();
    return {
      packKey: args.packKey,
      packType: args.packType,
      path: args.packPath,
      exists: true,
      deterministicUpdatedAt: args.deterministicUpdatedAt,
      narrativeUpdatedAt: args.narrativeUpdatedAt ?? null,
      lastHeadSha: args.lastHeadSha ?? null,
      versionId: version.versionId,
      versionNumber: version.versionNumber,
      contentHash: version.contentHash,
      metadata,
      body: args.body
    };
  };
  const recordCheckpointFromDelta = (args) => {
    const existing = db.get(
      "select id from checkpoints where project_id = ? and session_id = ? limit 1",
      [projectId, args.sessionId]
    );
    if (existing?.id) return null;
    const checkpointId = (0, import_node_crypto5.randomUUID)();
    const createdAt = nowIso3();
    const diffStat = {
      insertions: args.delta.insertions,
      deletions: args.delta.deletions,
      filesChanged: args.delta.filesChanged,
      files: args.delta.touchedFiles
    };
    const event = createPackEvent({
      packKey: `lane:${args.laneId}`,
      eventType: "checkpoint",
      payload: {
        checkpointId,
        laneId: args.laneId,
        sessionId: args.sessionId,
        sha: args.sha,
        diffStat
      }
    });
    try {
      ensureDir(checkpointsDir);
      import_node_fs7.default.writeFileSync(
        import_node_path6.default.join(checkpointsDir, `${checkpointId}.json`),
        JSON.stringify(
          {
            id: checkpointId,
            laneId: args.laneId,
            sessionId: args.sessionId,
            sha: args.sha,
            diffStat,
            packEventIds: [event.id],
            createdAt
          },
          null,
          2
        ),
        "utf8"
      );
    } catch {
    }
    db.run(
      `
        insert into checkpoints(
          id,
          project_id,
          lane_id,
          session_id,
          sha,
          diff_stat_json,
          pack_event_ids_json,
          created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        checkpointId,
        projectId,
        args.laneId,
        args.sessionId,
        args.sha,
        JSON.stringify(diffStat),
        JSON.stringify([event.id]),
        createdAt
      ]
    );
    return {
      id: checkpointId,
      laneId: args.laneId,
      sessionId: args.sessionId,
      sha: args.sha,
      diffStat,
      packEventIds: [event.id],
      createdAt
    };
  };
  const getSessionRow = (sessionId) => db.get(
    `
        select
          id,
          lane_id,
          tracked,
          started_at,
          ended_at,
          head_sha_start,
          head_sha_end,
          transcript_path
        from terminal_sessions
        where id = ?
        limit 1
      `,
    [sessionId]
  );
  const getSessionDeltaRow = (sessionId) => db.get(
    `
        select
          session_id,
          lane_id,
          started_at,
          ended_at,
          head_sha_start,
          head_sha_end,
          files_changed,
          insertions,
          deletions,
          touched_files_json,
          failure_lines_json,
          computed_at
        from session_deltas
        where session_id = ?
        limit 1
      `,
    [sessionId]
  );
  const rowToSessionDelta = (row) => ({
    sessionId: row.session_id,
    laneId: row.lane_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    headShaStart: row.head_sha_start,
    headShaEnd: row.head_sha_end,
    filesChanged: Number(row.files_changed ?? 0),
    insertions: Number(row.insertions ?? 0),
    deletions: Number(row.deletions ?? 0),
    touchedFiles: safeJsonParseArray(row.touched_files_json),
    failureLines: safeJsonParseArray(row.failure_lines_json),
    computedAt: row.computed_at ?? null
  });
  const getHeadSha3 = async (worktreePath) => {
    const res = await runGit(["rev-parse", "HEAD"], { cwd: worktreePath, timeoutMs: 8e3 });
    if (res.exitCode !== 0) return null;
    const sha = res.stdout.trim();
    return sha.length ? sha : null;
  };
  const listRecentLaneSessionDeltas = (laneId, limit) => {
    const rows = db.all(
      `
        select
          d.session_id,
          d.lane_id,
          d.started_at,
          d.ended_at,
          d.head_sha_start,
          d.head_sha_end,
          d.files_changed,
          d.insertions,
          d.deletions,
          d.touched_files_json,
          d.failure_lines_json,
          d.computed_at
        from session_deltas d
        where d.lane_id = ?
        order by d.started_at desc
        limit ?
      `,
      [laneId, limit]
    );
    return rows.map(rowToSessionDelta);
  };
  const buildLanePackBody = async ({
    laneId,
    reason,
    latestDelta,
    deterministicUpdatedAt
  }) => {
    const lanes = await laneService.list({ includeArchived: true });
    const lane = lanes.find((candidate) => candidate.id === laneId);
    if (!lane) throw new Error(`Lane not found: ${laneId}`);
    const primaryLane = lanes.find((candidate) => candidate.laneType === "primary") ?? null;
    const parentLane = lane.parentLaneId ? lanes.find((candidate) => candidate.id === lane.parentLaneId) ?? null : null;
    const existingBody = readFileIfExists(getLanePackPath(laneId));
    const userIntent = extractSection(existingBody, ADE_INTENT_START, ADE_INTENT_END, "Intent not set \u2014 click to add.");
    const userTodos = extractSection(existingBody, ADE_TODOS_START, ADE_TODOS_END, "");
    const taskSpecFallback = [
      "Problem Statement:",
      "- (what are we solving, and for whom?)",
      "",
      "Scope:",
      "- (what is included?)",
      "",
      "Non-goals:",
      "- (what is explicitly out of scope?)",
      "",
      "Acceptance Criteria:",
      "- [ ] (add checkable acceptance criteria)",
      "",
      "Constraints / Conventions:",
      "- (languages, frameworks, patterns, performance, security, etc.)",
      "",
      "Dependencies:",
      `- Parent lane: ${parentLane ? parentLane.name : "(none)"}`,
      "- Required merges: (list lanes/PRs that must land first)"
    ].join("\n");
    const taskSpec = extractSection(existingBody, ADE_TASK_SPEC_START, ADE_TASK_SPEC_END, taskSpecFallback);
    const providerMode = projectConfigService.get().effective.providerMode ?? "guest";
    const { worktreePath } = laneService.getLaneBaseAndBranch(laneId);
    const headSha = await getHeadSha3(worktreePath);
    const isoTime = (value) => {
      const raw = typeof value === "string" ? value : "";
      return raw.length >= 16 ? raw.slice(11, 16) : raw;
    };
    const recentSessions = db.all(
      `
        select
          s.id as id,
          s.title as title,
          s.goal as goal,
          s.tool_type as toolType,
          s.summary as summary,
          s.last_output_preview as lastOutputPreview,
          s.transcript_path as transcriptPath,
          s.resume_command as resumeCommand,
          s.status as status,
          s.tracked as tracked,
          s.started_at as startedAt,
          s.ended_at as endedAt,
          s.exit_code as exitCode,
          d.files_changed as filesChanged,
          d.insertions as insertions,
          d.deletions as deletions,
          d.touched_files_json as touchedFilesJson,
          d.failure_lines_json as failureLinesJson
        from terminal_sessions s
        left join session_deltas d on d.session_id = s.id
        where s.lane_id = ?
        order by s.started_at desc
        limit 30
      `,
      [laneId]
    );
    const sessionsTotal = Number(
      db.get("select count(1) as count from terminal_sessions where lane_id = ?", [laneId])?.count ?? 0
    );
    const sessionsRunning = Number(
      db.get(
        "select count(1) as count from terminal_sessions where lane_id = ? and status = 'running' and pty_id is not null",
        [laneId]
      )?.count ?? 0
    );
    const transcriptTailCache = /* @__PURE__ */ new Map();
    const getTranscriptTail = (transcriptPath) => {
      const key = String(transcriptPath ?? "").trim();
      if (!key) return "";
      const cached = transcriptTailCache.get(key);
      if (cached != null) return cached;
      const tail = sessionService.readTranscriptTail(key, 14e4);
      transcriptTailCache.set(key, tail);
      return tail;
    };
    const latestTest = db.get(
      `
        select
          r.id as run_id,
          r.suite_key as suite_id,
          s.name as suite_name,
          s.command_json as command_json,
          r.status as status,
          r.duration_ms as duration_ms,
          r.ended_at as ended_at
        from test_runs r
        left join test_suites s on s.project_id = r.project_id and s.id = r.suite_key
        where r.project_id = ?
          and r.lane_id = ?
        order by started_at desc
        limit 1
      `,
      [projectId, laneId]
    );
    const validationLines = [];
    if (latestTest) {
      const suiteLabel = (latestTest.suite_name ?? latestTest.suite_id).trim();
      validationLines.push(
        `Tests: ${statusFromCode(latestTest.status)} (suite=${suiteLabel}, duration=${latestTest.duration_ms ?? 0}ms)`
      );
      if (latestTest.command_json) {
        try {
          const command = JSON.parse(latestTest.command_json);
          validationLines.push(`Tests command: ${formatCommand(command)}`);
        } catch {
        }
      }
    } else {
      const latestEnded = recentSessions.find((s) => Boolean(s.endedAt));
      const transcriptTail = latestEnded ? getTranscriptTail(latestEnded.transcriptPath) : "";
      const inferred = inferTestOutcomeFromText(transcriptTail);
      if (inferred) {
        validationLines.push(`Tests: ${inferred.status === "pass" ? "PASS" : "FAIL"} (inferred from terminal output)`);
      } else {
        validationLines.push("Tests: NOT RUN");
      }
    }
    const lintSession = recentSessions.find((s) => {
      const haystack = `${s.summary ?? ""} ${s.goal ?? ""} ${s.title}`.toLowerCase();
      return haystack.includes("lint");
    });
    if (lintSession && lintSession.endedAt) {
      const lintStatus = lintSession.exitCode == null ? "ENDED" : lintSession.exitCode === 0 ? "PASS" : `FAIL (exit ${lintSession.exitCode})`;
      validationLines.push(`Lint: ${lintStatus}`);
    } else {
      validationLines.push("Lint: NOT RUN");
    }
    const deltas = /* @__PURE__ */ new Map();
    const addDelta = (filePath, insRaw, delRaw) => {
      const file = filePath.trim();
      if (!file) return;
      const ins = insRaw === "-" ? null : Number(insRaw);
      const del = delRaw === "-" ? null : Number(delRaw);
      const prev = deltas.get(file);
      const next = {
        insertions: Number.isFinite(ins) ? ins : ins,
        deletions: Number.isFinite(del) ? del : del
      };
      if (!prev) {
        deltas.set(file, next);
        return;
      }
      deltas.set(file, {
        insertions: prev.insertions == null || next.insertions == null ? null : prev.insertions + next.insertions,
        deletions: prev.deletions == null || next.deletions == null ? null : prev.deletions + next.deletions
      });
    };
    const addNumstat = (stdout) => {
      for (const line of stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
        const parts = line.split("	");
        if (parts.length < 3) continue;
        const insRaw = parts[0] ?? "0";
        const delRaw = parts[1] ?? "0";
        const filePath = parts.slice(2).join("	").trim();
        addDelta(filePath, insRaw, delRaw);
      }
    };
    const mergeBaseSha = await (async () => {
      const headRef = headSha ?? "HEAD";
      const baseRef = lane.baseRef?.trim() || "HEAD";
      const res = await runGit(["merge-base", headRef, baseRef], { cwd: projectRoot, timeoutMs: 12e3 });
      if (res.exitCode !== 0) return null;
      const sha = res.stdout.trim();
      return sha.length ? sha : null;
    })();
    if (mergeBaseSha && (headSha ?? "HEAD") !== mergeBaseSha) {
      const diff = await runGit(["diff", "--numstat", `${mergeBaseSha}..${headSha ?? "HEAD"}`], { cwd: projectRoot, timeoutMs: 2e4 });
      if (diff.exitCode === 0) addNumstat(diff.stdout);
    }
    const unstaged = await runGit(["diff", "--numstat"], { cwd: worktreePath, timeoutMs: 2e4 });
    if (unstaged.exitCode === 0) addNumstat(unstaged.stdout);
    const staged = await runGit(["diff", "--numstat", "--cached"], { cwd: worktreePath, timeoutMs: 2e4 });
    if (staged.exitCode === 0) addNumstat(staged.stdout);
    const statusRes = await runGit(["status", "--porcelain=v1"], { cwd: worktreePath, timeoutMs: 8e3 });
    if (statusRes.exitCode === 0) {
      const statusLines = statusRes.stdout.split("\n").map((l) => l.trimEnd()).filter(Boolean);
      const newUntrackedPaths = [];
      for (const line of statusLines) {
        const statusCode = line.slice(0, 2);
        const raw = line.slice(2).trim();
        const arrow = raw.indexOf("->");
        const rel = arrow >= 0 ? raw.slice(arrow + 2).trim() : raw;
        if (!rel) continue;
        if (!deltas.has(rel)) {
          if (statusCode === "??") {
            newUntrackedPaths.push(rel);
          } else {
            deltas.set(rel, { insertions: 0, deletions: 0 });
          }
        }
      }
      for (const rel of newUntrackedPaths) {
        try {
          const fullPath = import_node_path6.default.join(worktreePath, rel);
          const content = await import_node_fs7.default.promises.readFile(fullPath, "utf-8");
          const lineCount = content.split("\n").length;
          deltas.set(rel, { insertions: lineCount, deletions: 0 });
        } catch {
          deltas.set(rel, { insertions: 0, deletions: 0 });
        }
      }
    }
    if (!deltas.size && latestDelta?.touchedFiles?.length) {
      for (const rel of latestDelta.touchedFiles.slice(0, 120)) {
        if (!deltas.has(rel)) deltas.set(rel, { insertions: 0, deletions: 0 });
      }
    }
    const whatChangedLines = (() => {
      const files = [...deltas.keys()];
      if (!files.length) return [];
      const byModule = /* @__PURE__ */ new Map();
      for (const file of files) {
        const module2 = moduleFromPath(file);
        const list = byModule.get(module2) ?? [];
        list.push(file);
        byModule.set(module2, list);
      }
      const entries = [...byModule.entries()].map(([module2, files2]) => ({ module: module2, files: files2.sort(), count: files2.length })).sort((a, b) => b.count - a.count || a.module.localeCompare(b.module));
      return entries.slice(0, 12).map((entry) => {
        const examples = entry.files.slice(0, 3).join(", ");
        const suffix = entry.files.length > 3 ? `, +${entry.files.length - 3} more` : "";
        return `${entry.module}: ${entry.count} files (${examples}${suffix})`;
      });
    })();
    const inferredWhyLines = await (async () => {
      if (!mergeBaseSha) return [];
      const res = await runGit(["log", "--oneline", `${mergeBaseSha}..${headSha ?? "HEAD"}`, "-n", "15"], {
        cwd: projectRoot,
        timeoutMs: 12e3
      });
      if (res.exitCode !== 0) return [];
      return res.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    })();
    const keyFiles = (() => {
      const scored = [...deltas.entries()].map(([file, delta]) => {
        const magnitude = delta.insertions == null || delta.deletions == null ? Number.MAX_SAFE_INTEGER : delta.insertions + delta.deletions;
        return { file, insertions: delta.insertions, deletions: delta.deletions, magnitude };
      });
      return scored.sort((a, b) => b.magnitude - a.magnitude || a.file.localeCompare(b.file)).slice(0, 25).map(({ magnitude: _magnitude, ...rest }) => rest);
    })();
    const errors = (() => {
      const raw = latestDelta?.failureLines ?? [];
      const out = [];
      const seen = /* @__PURE__ */ new Set();
      for (const entry of raw) {
        const clean = stripAnsi(entry).trim().replace(/\s+/g, " ");
        if (!clean) continue;
        if (!/\b(error|failed|exception|fatal|traceback)\b/i.test(clean)) continue;
        const clipped = clean.length > 220 ? `${clean.slice(0, 219)}\u2026` : clean;
        if (seen.has(clipped)) continue;
        seen.add(clipped);
        out.push(clipped);
      }
      return out;
    })();
    const sessionsDetailed = recentSessions.slice(0, 30).map((session) => {
      const tool = humanToolLabel(session.toolType);
      const goal = (session.goal ?? "").trim() || session.title;
      const result = session.endedAt == null ? "running" : session.exitCode == null ? "ended" : session.exitCode === 0 ? "ok" : `exit ${session.exitCode}`;
      const delta = session.filesChanged != null ? `+${session.insertions ?? 0}/-${session.deletions ?? 0}` : "";
      const prompt = (session.resumeCommand ?? "").trim();
      const touchedFiles = safeJsonParseArray(session.touchedFilesJson);
      const failureLines = safeJsonParseArray(session.failureLinesJson);
      const commands = [];
      if (session.title && session.title !== goal) {
        commands.push(session.title);
      }
      return {
        when: isoTime(session.startedAt),
        tool,
        goal,
        result,
        delta,
        prompt,
        commands,
        filesTouched: touchedFiles.slice(0, 20),
        errors: failureLines.slice(0, 10)
      };
    });
    const nextSteps = (() => {
      const items = [];
      const intentSet = userIntent.trim().length && userIntent.trim() !== "Intent not set \u2014 click to add.";
      if (!intentSet) items.push("Set lane intent (Why section).");
      if (lane.status.dirty) items.push("Working tree is dirty; consider committing or stashing before switching lanes.");
      if (lane.status.behind > 0) items.push(`Lane is behind base by ${lane.status.behind} commits; consider syncing/rebasing.`);
      if (errors.length) items.push("Errors detected in the latest session output; review Errors & Issues.");
      if (latestTest && latestTest.status === "failed") items.push("Latest test run failed; fix failures before merging.");
      if (sessionsRunning > 0) items.push(`${sessionsRunning} terminal session(s) currently running.`);
      const latestFailedSession = recentSessions.find((s) => s.endedAt && (s.exitCode ?? 0) !== 0);
      if (latestFailedSession?.summary) items.push(`Recent failure: ${latestFailedSession.summary}`);
      return items;
    })();
    const requiredMerges = parentLane ? [parentLane.id] : [];
    const conflictState = deriveConflictStateForLane(laneId);
    const dependencyState = {
      requiredMerges,
      blockedByLanes: requiredMerges,
      mergeReadiness: computeMergeReadiness({
        requiredMerges,
        behindCount: lane.status.behind,
        conflictStatus: conflictState?.status ?? null
      })
    };
    const graph = buildGraphEnvelope(
      [
        {
          relationType: "depends_on",
          targetPackKey: "project",
          targetPackType: "project",
          rationale: "Lane context depends on project baseline."
        },
        ...parentLane ? [
          {
            relationType: "blocked_by",
            targetPackKey: `lane:${parentLane.id}`,
            targetPackType: "lane",
            targetLaneId: parentLane.id,
            targetBranch: parentLane.branchRef,
            rationale: "Lane is stacked on parent lane."
          },
          {
            relationType: "merges_into",
            targetPackKey: `lane:${parentLane.id}`,
            targetPackType: "lane",
            targetLaneId: parentLane.id,
            targetBranch: parentLane.branchRef,
            rationale: "Stacked lane merges into parent lane first."
          }
        ] : []
      ]
    );
    const body = renderLanePackMarkdown({
      packKey: `lane:${laneId}`,
      projectId,
      laneId,
      laneName: lane.name,
      branchRef: lane.branchRef,
      baseRef: lane.baseRef,
      headSha,
      dirty: lane.status.dirty,
      ahead: lane.status.ahead,
      behind: lane.status.behind,
      parentName: parentLane?.name ?? (primaryLane && lane.laneType !== "primary" ? `${primaryLane.name} (primary)` : null),
      deterministicUpdatedAt,
      trigger: reason,
      providerMode,
      graph,
      dependencyState,
      conflictState,
      whatChangedLines,
      inferredWhyLines,
      userIntentMarkers: { start: ADE_INTENT_START, end: ADE_INTENT_END },
      userIntent,
      taskSpecMarkers: { start: ADE_TASK_SPEC_START, end: ADE_TASK_SPEC_END },
      taskSpec,
      validationLines,
      keyFiles,
      errors,
      sessionsDetailed,
      sessionsTotal: Number.isFinite(sessionsTotal) ? sessionsTotal : 0,
      sessionsRunning: Number.isFinite(sessionsRunning) ? sessionsRunning : 0,
      nextSteps,
      userTodosMarkers: { start: ADE_TODOS_START, end: ADE_TODOS_END },
      userTodos,
      laneDescription: lane.description ?? ""
    });
    return { body, lastHeadSha: headSha };
  };
  const buildProjectBootstrap = async (args) => {
    const lanes = args.lanes;
    const primary = lanes.find((lane) => lane.laneType === "primary") ?? null;
    const historyRef = primary?.branchRef || primary?.baseRef || "HEAD";
    const topLevelEntries = (() => {
      try {
        return import_node_fs7.default.readdirSync(projectRoot, { withFileTypes: true }).filter((entry) => !entry.name.startsWith(".") && entry.name !== "node_modules").slice(0, 40).map((entry) => `${entry.isDirectory() ? "dir" : "file"}: ${entry.name}`);
      } catch {
        return [];
      }
    })();
    const pickDocs = () => {
      const out = [];
      const push = (rel) => {
        const normalized = rel.replace(/\\/g, "/");
        if (out.includes(normalized)) return;
        const abs = import_node_path6.default.join(projectRoot, normalized);
        try {
          if (import_node_fs7.default.statSync(abs).isFile()) out.push(normalized);
        } catch {
        }
      };
      push("README.md");
      push("docs/README.md");
      push(ADE_DOC_PRD_REL);
      push(ADE_DOC_ARCH_REL);
      push("docs/PRD.md");
      push("docs/architecture/SYSTEM_OVERVIEW.md");
      push("docs/architecture/DESKTOP_APP.md");
      push("docs/architecture/HOSTED_AGENT.md");
      push("docs/features/LANES.md");
      push("docs/features/PACKS.md");
      push("docs/features/ONBOARDING_AND_SETTINGS.md");
      const addDir = (relDir, limit) => {
        const absDir = import_node_path6.default.join(projectRoot, relDir);
        try {
          const entries = import_node_fs7.default.readdirSync(absDir).filter((name) => name.endsWith(".md")).slice(0, limit);
          for (const name of entries) push(import_node_path6.default.posix.join(relDir.replace(/\\/g, "/"), name));
        } catch {
        }
      };
      addDir("docs/architecture", 6);
      addDir("docs/features", 6);
      addDir("docs/guides", 4);
      return out.slice(0, 14);
    };
    const excerptDoc = (rel) => {
      const abs = import_node_path6.default.join(projectRoot, rel);
      try {
        const fd = import_node_fs7.default.openSync(abs, "r");
        try {
          const MAX = 48e3;
          const buf = Buffer.alloc(MAX);
          const read = import_node_fs7.default.readSync(fd, buf, 0, MAX, 0);
          const raw = buf.slice(0, Math.max(0, read)).toString("utf8");
          const lines2 = raw.split(/\r?\n/);
          const titleLine = lines2.find((line) => line.trim().startsWith("# "));
          const title = titleLine ? titleLine.replace(/^#\s+/, "").trim() : import_node_path6.default.basename(rel);
          const blurbLines = [];
          for (const line of lines2) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            if (trimmed.startsWith("#")) continue;
            if (/^table of contents/i.test(trimmed)) continue;
            if (trimmed.startsWith("---")) continue;
            blurbLines.push(trimmed);
            if (blurbLines.join(" ").length > 220) break;
          }
          const blurb = blurbLines.slice(0, 2).join(" ");
          return { rel, title, blurb };
        } finally {
          import_node_fs7.default.closeSync(fd);
        }
      } catch {
        return null;
      }
    };
    const historyLines = await (async () => {
      const res = await runGit(["log", historyRef, "-n", "18", "--date=short", "--pretty=format:%h %ad %s"], {
        cwd: projectRoot,
        timeoutMs: 12e3
      });
      if (res.exitCode !== 0) return [];
      return res.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    })();
    const lines = [];
    lines.push("## Bootstrap context (codebase + docs)");
    lines.push("");
    lines.push("### Repo map (top level)");
    if (topLevelEntries.length) {
      for (const entry of topLevelEntries) lines.push(`- ${entry}`);
    } else {
      lines.push("- (unavailable)");
    }
    lines.push("");
    lines.push("### Docs index");
    const docs = pickDocs().map(excerptDoc).filter(Boolean);
    if (docs.length) {
      for (const doc of docs) {
        lines.push(`- ${doc.rel}: ${doc.title}`);
        if (doc.blurb) lines.push(`  - ${doc.blurb}`);
      }
    } else {
      lines.push("- no docs found");
    }
    lines.push("");
    lines.push(`### Git history seed (${historyRef})`);
    if (historyLines.length) {
      for (const entry of historyLines) lines.push(`- ${entry}`);
    } else {
      lines.push("- (no git history available)");
    }
    lines.push("");
    return `${lines.join("\n")}
`;
  };
  const buildProjectPackBody = async ({
    reason,
    deterministicUpdatedAt,
    sourceLaneId
  }) => {
    const config = projectConfigService.get().effective;
    const lanes = await laneService.list({ includeArchived: false });
    const docsMeta = readContextDocMeta();
    const existingBootstrapRaw = readFileIfExists(projectBootstrapPath);
    const existingFingerprint = (() => {
      const m = existingBootstrapRaw.match(BOOTSTRAP_FINGERPRINT_RE);
      return m?.[1]?.toLowerCase() ?? null;
    })();
    const shouldBootstrap = reason === "onboarding_init" || !import_node_fs7.default.existsSync(projectBootstrapPath) || existingFingerprint !== docsMeta.contextFingerprint;
    if (shouldBootstrap) {
      try {
        const bootstrap = await buildProjectBootstrap({ lanes });
        ensureDirFor(projectBootstrapPath);
        const withMeta = [
          `<!-- ADE_DOCS_FINGERPRINT:${docsMeta.contextFingerprint} -->`,
          `<!-- ADE_CONTEXT_VERSION:${docsMeta.contextVersion} -->`,
          `<!-- ADE_LAST_DOCS_REFRESH_AT:${docsMeta.lastDocsRefreshAt ?? ""} -->`,
          bootstrap
        ].join("\n");
        import_node_fs7.default.writeFileSync(projectBootstrapPath, withMeta, "utf8");
      } catch (error) {
        logger.warn("packs.project_bootstrap_failed", {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    const bootstrapBody = readFileIfExists(projectBootstrapPath).replace(BOOTSTRAP_FINGERPRINT_RE, "").replace(/<!--\s*ADE_CONTEXT_VERSION:[^>]+-->/gi, "").replace(/<!--\s*ADE_LAST_DOCS_REFRESH_AT:[^>]*-->/gi, "").trim();
    const lines = [];
    lines.push("# Project Pack");
    lines.push("");
    lines.push(`Deterministic updated: ${deterministicUpdatedAt}`);
    lines.push(`Trigger: ${reason}`);
    if (sourceLaneId) lines.push(`Source lane: ${sourceLaneId}`);
    lines.push(`Active lanes: ${lanes.length}`);
    lines.push(`Context fingerprint: ${docsMeta.contextFingerprint}`);
    lines.push(`Context version: ${docsMeta.contextVersion}`);
    lines.push(`Last docs refresh at: ${docsMeta.lastDocsRefreshAt ?? "unknown"}`);
    if (docsMeta.docsStaleReason) lines.push(`Docs stale reason: ${docsMeta.docsStaleReason}`);
    lines.push("");
    if (bootstrapBody) {
      lines.push(bootstrapBody);
    } else {
      lines.push("## Bootstrap context");
      lines.push("- Bootstrap scan not generated yet.");
      lines.push("- Run Onboarding \u2192 Generate Initial Packs, or refresh the Project pack once after onboarding.");
      lines.push("");
    }
    lines.push("## How To Run (Processes)");
    if (config.processes.length) {
      for (const proc of config.processes) {
        const cmd = formatCommand(proc.command);
        const cwd = proc.cwd && proc.cwd !== "." ? ` (cwd=${proc.cwd})` : "";
        lines.push(`- ${proc.name}: ${cmd}${cwd}`);
      }
    } else {
      lines.push("- no managed process definitions");
    }
    lines.push("");
    lines.push("## How To Test (Test Suites)");
    if (config.testSuites.length) {
      for (const suite of config.testSuites) {
        const cmd = formatCommand(suite.command);
        const cwd = suite.cwd && suite.cwd !== "." ? ` (cwd=${suite.cwd})` : "";
        lines.push(`- ${suite.name}: ${cmd}${cwd}`);
      }
    } else {
      lines.push("- no test suites configured");
    }
    lines.push("");
    lines.push("## Stack Buttons");
    if (config.stackButtons.length) {
      for (const stack of config.stackButtons) {
        lines.push(`- ${stack.name}: ${stack.processIds.join(", ")}`);
      }
    } else {
      lines.push("- no stack buttons configured");
    }
    lines.push("");
    lines.push("## Lane Snapshot");
    if (lanes.length) {
      for (const lane of lanes) {
        const dirty = lane.status.dirty ? "dirty" : "clean";
        const stack = lane.parentLaneId ? "stacked" : lane.laneType === "primary" ? "primary" : "root";
        lines.push(`- ${lane.name}: ${dirty} \xB7 ahead ${lane.status.ahead} \xB7 behind ${lane.status.behind} \xB7 ${stack}`);
      }
    } else {
      lines.push("- no active lanes");
    }
    lines.push("");
    lines.push("## Conventions And Constraints");
    lines.push("- Deterministic sections are rebuilt by ADE on session end and commit operations.");
    if ((config.providerMode ?? "guest") === "guest") {
      lines.push("- Guest Mode active: narrative sections use local templates only.");
    } else {
      lines.push("- Narrative sections are AI-assisted when subscription providers are configured and available.");
    }
    lines.push("");
    return `${lines.join("\n")}
`;
  };
  const getPackIndexRow = (packKey) => {
    return db.get(
      `
        select
          pack_type,
          lane_id,
          pack_path,
          deterministic_updated_at,
          narrative_updated_at,
          last_head_sha,
          metadata_json
        from packs_index
        where pack_key = ?
          and project_id = ?
        limit 1
      `,
      [packKey, projectId]
    );
  };
  const getPackSummaryForKey = (packKey, fallback) => {
    const row = getPackIndexRow(packKey);
    const effectiveRow = row ?? {
      pack_type: fallback.packType,
      lane_id: null,
      pack_path: fallback.packPath,
      deterministic_updated_at: null,
      narrative_updated_at: null,
      last_head_sha: null,
      metadata_json: null
    };
    const version = readCurrentPackVersion(packKey);
    return toPackSummaryFromRow({ packKey, row: effectiveRow, version });
  };
  const readLanePackExcerpt = (laneId) => {
    const filePath = getLanePackPath(laneId);
    if (!import_node_fs7.default.existsSync(filePath)) return null;
    try {
      const raw = import_node_fs7.default.readFileSync(filePath, "utf8");
      const trimmed = raw.trim();
      if (!trimmed) return null;
      const MAX = 12e3;
      return trimmed.length > MAX ? `${trimmed.slice(0, MAX)}

\u2026(truncated)\u2026
` : trimmed;
    } catch {
      return null;
    }
  };
  const readConflictPredictionPack = (laneId) => {
    const candidates = [getConflictPredictionPath(laneId), getLegacyConflictPredictionPath(laneId)];
    for (const filePath of candidates) {
      if (!import_node_fs7.default.existsSync(filePath)) continue;
      try {
        const raw = import_node_fs7.default.readFileSync(filePath, "utf8");
        const parsed = JSON.parse(raw);
        if (!isRecord5(parsed)) continue;
        return parsed;
      } catch {
        continue;
      }
    }
    return null;
  };
  const readGitConflictState = async (laneId) => {
    const lane = laneService.getLaneBaseAndBranch(laneId);
    const gitDirRes = await runGit(["rev-parse", "--absolute-git-dir"], { cwd: lane.worktreePath, timeoutMs: 1e4 });
    const gitDir = gitDirRes.exitCode === 0 ? gitDirRes.stdout.trim() : "";
    const hasRebase = gitDir.length > 0 && (import_node_fs7.default.existsSync(import_node_path6.default.join(gitDir, "rebase-apply")) || import_node_fs7.default.existsSync(import_node_path6.default.join(gitDir, "rebase-merge")));
    const hasMerge = gitDir.length > 0 && import_node_fs7.default.existsSync(import_node_path6.default.join(gitDir, "MERGE_HEAD"));
    const kind = hasRebase ? "rebase" : hasMerge ? "merge" : null;
    const unmergedRes = await runGit(["diff", "--name-only", "--diff-filter=U"], { cwd: lane.worktreePath, timeoutMs: 1e4 });
    const conflictedFiles = unmergedRes.exitCode === 0 ? parseDiffNameOnly(unmergedRes.stdout).sort((a, b) => a.localeCompare(b)) : [];
    const inProgress = kind != null;
    return {
      laneId,
      kind,
      inProgress,
      conflictedFiles,
      canContinue: inProgress && conflictedFiles.length === 0,
      canAbort: inProgress
    };
  };
  const deriveConflictStateForLane = (laneId) => {
    const pack = readConflictPredictionPack(laneId);
    if (!pack || !isRecord5(pack.status)) return null;
    const status = pack.status;
    const statusValue = normalizeConflictStatus(asString3(status.status).trim()) ?? "unknown";
    const overlappingFileCount = Number(status.overlappingFileCount ?? 0);
    const peerConflictCount = Number(status.peerConflictCount ?? 0);
    const lastPredictedAt = asString3(status.lastPredictedAt).trim() || null;
    const strategy = asString3(pack.strategy).trim() || void 0;
    const pairwisePairsComputed = Number.isFinite(Number(pack.pairwisePairsComputed)) ? Number(pack.pairwisePairsComputed) : void 0;
    const pairwisePairsTotal = Number.isFinite(Number(pack.pairwisePairsTotal)) ? Number(pack.pairwisePairsTotal) : void 0;
    const lastRecomputedAt = asString3(pack.lastRecomputedAt).trim() || asString3(pack.generatedAt).trim() || null;
    return {
      status: statusValue,
      lastPredictedAt,
      overlappingFileCount: Number.isFinite(overlappingFileCount) ? overlappingFileCount : 0,
      peerConflictCount: Number.isFinite(peerConflictCount) ? peerConflictCount : 0,
      unresolvedPairCount: Number.isFinite(peerConflictCount) ? peerConflictCount : 0,
      truncated: Boolean(pack.truncated),
      strategy,
      pairwisePairsComputed,
      pairwisePairsTotal,
      lastRecomputedAt
    };
  };
  const computeLaneLineage = (args) => {
    const lane = args.lanesById.get(args.laneId) ?? null;
    const stackDepth = Number(lane?.stackDepth ?? 0);
    const parentLaneId = lane?.parentLaneId ?? null;
    let baseLaneId = lane?.id ?? args.laneId;
    let cursor = lane;
    const visited = /* @__PURE__ */ new Set();
    while (cursor?.parentLaneId && !visited.has(cursor.id)) {
      visited.add(cursor.id);
      const parent = args.lanesById.get(cursor.parentLaneId) ?? null;
      if (!parent) break;
      baseLaneId = parent.id;
      cursor = parent;
    }
    return {
      laneId: args.laneId,
      parentLaneId,
      baseLaneId,
      stackDepth: Number.isFinite(stackDepth) ? stackDepth : 0
    };
  };
  const buildLaneConflictRiskSummaryLines = (laneId) => {
    const pack = readConflictPredictionPack(laneId);
    if (!pack || !isRecord5(pack.status)) return [];
    const status = pack.status;
    const statusValue = asString3(status.status).trim() || "unknown";
    const overlappingFileCount = Number(status.overlappingFileCount ?? 0);
    const peerConflictCount = Number(status.peerConflictCount ?? 0);
    const lastPredictedAt = asString3(status.lastPredictedAt).trim() || null;
    const lines = [];
    lines.push(`- Conflict status: \`${statusValue}\``);
    lines.push(`- Overlapping files: ${Number.isFinite(overlappingFileCount) ? overlappingFileCount : 0}`);
    lines.push(`- Peer conflicts: ${Number.isFinite(peerConflictCount) ? peerConflictCount : 0}`);
    if (lastPredictedAt) lines.push(`- Last predicted: ${lastPredictedAt}`);
    if (asString3(pack.generatedAt).trim()) lines.push(`- Generated: ${asString3(pack.generatedAt).trim()}`);
    const overlaps = Array.isArray(pack.overlaps) ? pack.overlaps : [];
    const riskScore = (riskLevel) => {
      const normalized = riskLevel.trim().toLowerCase();
      if (normalized === "high") return 3;
      if (normalized === "medium") return 2;
      if (normalized === "low") return 1;
      if (normalized === "none") return 0;
      return 0;
    };
    const peers = overlaps.filter((ov) => ov && ov.peerId != null).map((ov) => {
      const peerName = asString3(ov.peerName).trim() || "Unknown lane";
      const riskLevel = asString3(ov.riskLevel).trim() || "unknown";
      const fileCount = Array.isArray(ov.files) ? ov.files.length : 0;
      return { peerName, riskLevel, fileCount, score: riskScore(riskLevel) };
    }).filter((ov) => ov.score > 0 || ov.fileCount > 0).sort((a, b) => b.score - a.score || b.fileCount - a.fileCount || a.peerName.localeCompare(b.peerName)).slice(0, 5);
    if (peers.length) {
      lines.push("- Top risky peers:");
      for (const peer of peers) {
        lines.push(`  - ${peer.peerName}: \`${peer.riskLevel}\` (${peer.fileCount} files)`);
      }
    }
    if (pack.truncated) {
      const strategy = asString3(pack.strategy).trim() || "partial";
      const computed = Number(pack.pairwisePairsComputed ?? NaN);
      const total = Number(pack.pairwisePairsTotal ?? NaN);
      if (Number.isFinite(computed) && Number.isFinite(total) && total > 0) {
        lines.push(`- Pairwise coverage: ${computed}/${total} pairs (strategy=\`${strategy}\`)`);
      } else {
        lines.push(`- Pairwise coverage: partial (strategy=\`${strategy}\`)`);
      }
    }
    return lines;
  };
  const buildFeaturePackBody = async (args) => {
    const lanes = await laneService.list({ includeArchived: false });
    const matching = lanes.filter((lane) => lane.tags.includes(args.featureKey));
    const lines = [];
    lines.push("```json");
    lines.push(
      JSON.stringify(
        {
          schema: CONTEXT_HEADER_SCHEMA_V1,
          contractVersion: CONTEXT_CONTRACT_VERSION,
          projectId,
          packType: "feature",
          featureKey: args.featureKey,
          deterministicUpdatedAt: args.deterministicUpdatedAt,
          laneCount: matching.length,
          laneIds: matching.map((l) => l.id)
        },
        null,
        2
      )
    );
    lines.push("```");
    lines.push("");
    lines.push(`# Feature Pack: ${args.featureKey}`);
    lines.push(`> Updated: ${args.deterministicUpdatedAt} | Trigger: ${args.reason} | Lanes: ${matching.length}`);
    lines.push("");
    if (matching.length === 0) {
      lines.push("No lanes are tagged with this feature key yet.");
      lines.push("");
      lines.push("## How To Use");
      lines.push(`- Add the tag '${args.featureKey}' to one or more lanes (Workspace Graph -> right click lane -> Customize).`);
      lines.push("");
      return { body: `${lines.join("\n")}
`, laneIds: [] };
    }
    const dirtyCount = matching.filter((l) => l.status.dirty).length;
    const cleanCount = matching.length - dirtyCount;
    const totalAhead = matching.reduce((sum, l) => sum + l.status.ahead, 0);
    const totalBehind = matching.reduce((sum, l) => sum + l.status.behind, 0);
    lines.push("## Feature Progress Summary");
    lines.push(`- Lanes: ${matching.length} (${dirtyCount} dirty, ${cleanCount} clean)`);
    lines.push(`- Total ahead: ${totalAhead} | Total behind: ${totalBehind}`);
    lines.push("");
    lines.push("## Combined File Changes");
    const featureDeltas = /* @__PURE__ */ new Map();
    for (const lane of matching) {
      const { worktreePath } = laneService.getLaneBaseAndBranch(lane.id);
      const headSha = await getHeadSha3(worktreePath);
      const mergeBaseRes = await runGit(
        ["merge-base", headSha ?? "HEAD", lane.baseRef?.trim() || "HEAD"],
        { cwd: projectRoot, timeoutMs: 12e3 }
      );
      const mergeBaseSha = mergeBaseRes.exitCode === 0 ? mergeBaseRes.stdout.trim() : null;
      if (mergeBaseSha && (headSha ?? "HEAD") !== mergeBaseSha) {
        const diff = await runGit(
          ["diff", "--numstat", `${mergeBaseSha}..${headSha ?? "HEAD"}`],
          { cwd: projectRoot, timeoutMs: 2e4 }
        );
        if (diff.exitCode === 0) {
          for (const diffLine of diff.stdout.split("\n").map((l) => l.trim()).filter(Boolean)) {
            const parts = diffLine.split("	");
            if (parts.length < 3) continue;
            const insRaw = parts[0] ?? "0";
            const delRaw = parts[1] ?? "0";
            const filePath = parts.slice(2).join("	").trim();
            if (!filePath) continue;
            const ins = insRaw === "-" ? null : Number(insRaw);
            const del = delRaw === "-" ? null : Number(delRaw);
            const prev = featureDeltas.get(filePath);
            if (!prev) {
              featureDeltas.set(filePath, {
                insertions: Number.isFinite(ins) ? ins : null,
                deletions: Number.isFinite(del) ? del : null
              });
            } else {
              featureDeltas.set(filePath, {
                insertions: prev.insertions == null || ins == null ? null : prev.insertions + ins,
                deletions: prev.deletions == null || del == null ? null : prev.deletions + del
              });
            }
          }
        }
      }
    }
    if (featureDeltas.size === 0) {
      lines.push("No file changes detected across feature lanes.");
    } else {
      const sorted = [...featureDeltas.entries()].sort((a, b) => {
        const aTotal = (a[1].insertions ?? 0) + (a[1].deletions ?? 0);
        const bTotal = (b[1].insertions ?? 0) + (b[1].deletions ?? 0);
        return bTotal - aTotal;
      }).slice(0, 40);
      lines.push("| File | Change |");
      lines.push("|------|--------|");
      for (const [file, delta] of sorted) {
        const change = delta.insertions == null || delta.deletions == null ? "binary" : `+${delta.insertions}/-${delta.deletions}`;
        lines.push(`| \`${file}\` | ${change} |`);
      }
      if (featureDeltas.size > 40) {
        lines.push(`| ... | ${featureDeltas.size - 40} more files |`);
      }
    }
    lines.push("");
    lines.push("## Rolled-up Test Results");
    let totalPassed = 0;
    let totalFailed = 0;
    let totalOtherTests = 0;
    const failingTests = [];
    for (const lane of matching) {
      const testRows = db.all(
        `
          select
            r.id as run_id,
            s.name as suite_name,
            r.suite_key as suite_key,
            r.status as status
          from test_runs r
          left join test_suites s on s.project_id = r.project_id and s.id = r.suite_key
          where r.project_id = ?
            and r.lane_id = ?
          order by r.started_at desc
          limit 3
        `,
        [projectId, lane.id]
      );
      for (const tr of testRows) {
        if (tr.status === "passed") totalPassed++;
        else if (tr.status === "failed") {
          totalFailed++;
          failingTests.push(`${lane.name}: ${(tr.suite_name ?? tr.suite_key).trim()}`);
        } else {
          totalOtherTests++;
        }
      }
    }
    if (totalPassed + totalFailed + totalOtherTests === 0) {
      lines.push("- No test runs recorded across feature lanes.");
    } else {
      lines.push(`- Passed: ${totalPassed} | Failed: ${totalFailed} | Other: ${totalOtherTests}`);
      if (failingTests.length) {
        lines.push("- Failing tests:");
        for (const ft of failingTests.slice(0, 20)) {
          lines.push(`  - ${ft}`);
        }
      }
    }
    lines.push("");
    lines.push("## Cross-Lane Conflict Predictions");
    const conflictEntries = [];
    const matchingIds = new Set(matching.map((l) => l.id));
    for (const lane of matching) {
      const conflictPack = readConflictPredictionPack(lane.id);
      if (!conflictPack) continue;
      const overlaps = Array.isArray(conflictPack.overlaps) ? conflictPack.overlaps : [];
      for (const ov of overlaps) {
        if (!ov || !ov.peerId) continue;
        if (!matchingIds.has(ov.peerId)) continue;
        const peerName = asString3(ov.peerName).trim() || ov.peerId;
        const riskLevel = asString3(ov.riskLevel).trim() || "unknown";
        const fileCount = Array.isArray(ov.files) ? ov.files.length : 0;
        conflictEntries.push(`- ${lane.name} <-> ${peerName}: risk=\`${riskLevel}\`, ${fileCount} overlapping files`);
      }
    }
    if (conflictEntries.length === 0) {
      lines.push("- No cross-lane conflict predictions within this feature.");
    } else {
      for (const entry of conflictEntries.slice(0, 20)) {
        lines.push(entry);
      }
    }
    lines.push("");
    lines.push("## Combined Session Timeline");
    const featureSessions = db.all(
      `
        select
          s.id, s.lane_id, s.title, s.tool_type, s.started_at, s.ended_at, s.status, s.exit_code
        from terminal_sessions s
        where s.lane_id in (${matching.map(() => "?").join(",")})
        order by s.started_at desc
        limit 30
      `,
      matching.map((l) => l.id)
    );
    if (featureSessions.length === 0) {
      lines.push("- No sessions recorded across feature lanes.");
    } else {
      lines.push("| When | Lane | Tool | Title | Status |");
      lines.push("|------|------|------|-------|--------|");
      const laneNameById = new Map(matching.map((l) => [l.id, l.name]));
      for (const sess of featureSessions) {
        const when = sess.started_at.length >= 16 ? sess.started_at.slice(0, 16) : sess.started_at;
        const laneName = laneNameById.get(sess.lane_id) ?? sess.lane_id;
        const tool = humanToolLabel(sess.tool_type);
        const title = (sess.title ?? "").replace(/\|/g, "\\|").slice(0, 60);
        const status = sess.status === "running" ? "RUNNING" : sess.exit_code === 0 ? "OK" : sess.exit_code != null ? `EXIT ${sess.exit_code}` : "ENDED";
        lines.push(`| ${when} | ${laneName} | ${tool} | ${title} | ${status} |`);
      }
    }
    lines.push("");
    lines.push("## Combined Errors");
    const allErrors = [];
    for (const lane of matching) {
      const lanePackBody = readFileIfExists(getLanePackPath(lane.id));
      const errSection = extractSectionByHeading2(lanePackBody, "## Errors & Issues");
      if (errSection && errSection.trim() !== "No errors detected.") {
        for (const errLine of errSection.split("\n").map((l) => l.trim()).filter(Boolean)) {
          const cleaned = errLine.startsWith("- ") ? errLine.slice(2) : errLine;
          if (cleaned.length) allErrors.push(`[${lane.name}] ${cleaned}`);
        }
      }
    }
    if (allErrors.length === 0) {
      lines.push("No errors detected across feature lanes.");
    } else {
      for (const err of allErrors.slice(0, 30)) {
        lines.push(`- ${err}`);
      }
    }
    lines.push("");
    for (const lane of matching.sort((a, b) => a.stackDepth - b.stackDepth || a.name.localeCompare(b.name))) {
      const lanePackBody = readFileIfExists(getLanePackPath(lane.id));
      const intent = extractSection(lanePackBody, ADE_INTENT_START, ADE_INTENT_END, "");
      const laneTest = db.get(
        `
          select r.status as status, s.name as suite_name, r.suite_key as suite_key
          from test_runs r
          left join test_suites s on s.project_id = r.project_id and s.id = r.suite_key
          where r.project_id = ? and r.lane_id = ?
          order by r.started_at desc limit 1
        `,
        [projectId, lane.id]
      );
      const laneFileCount = (() => {
        const { worktreePath: laneWt } = laneService.getLaneBaseAndBranch(lane.id);
        try {
          const lanePackContent = readFileIfExists(getLanePackPath(lane.id));
          const keyFilesMatch = /## Key Files \((\d+) files touched\)/.exec(lanePackContent);
          if (keyFilesMatch) return Number(keyFilesMatch[1]);
        } catch {
        }
        return 0;
      })();
      lines.push(`### Lane: ${lane.name}`);
      lines.push(`- Branch: \`${lane.branchRef}\` | Status: ${lane.status.dirty ? "dirty" : "clean"} | Ahead: ${lane.status.ahead} | Behind: ${lane.status.behind}`);
      if (intent.trim().length) {
        lines.push(`- Intent: ${intent.trim().slice(0, 200)}`);
      }
      lines.push(`- Files changed: ${laneFileCount}`);
      if (laneTest) {
        const testLabel = (laneTest.suite_name ?? laneTest.suite_key).trim();
        lines.push(`- Latest test: ${statusFromCode(laneTest.status)} (${testLabel})`);
      } else {
        lines.push("- Latest test: NOT RUN");
      }
      lines.push("");
    }
    lines.push("---");
    lines.push(`*Feature pack: deterministic aggregation across ${matching.length} lanes. Updated: ${args.deterministicUpdatedAt}*`);
    lines.push("");
    return { body: `${lines.join("\n")}
`, laneIds: matching.map((lane) => lane.id) };
  };
  const buildPlanPackBody = async (args) => {
    const lanes = await laneService.list({ includeArchived: true });
    const lane = lanes.find((l) => l.id === args.laneId);
    if (!lane) throw new Error(`Lane not found: ${args.laneId}`);
    const { worktreePath } = laneService.getLaneBaseAndBranch(args.laneId);
    const headSha = await getHeadSha3(worktreePath);
    const lines = [];
    lines.push("```json");
    lines.push(
      JSON.stringify(
        {
          schema: CONTEXT_HEADER_SCHEMA_V1,
          contractVersion: CONTEXT_CONTRACT_VERSION,
          projectId,
          packType: "plan",
          laneId: args.laneId,
          headSha,
          deterministicUpdatedAt: args.deterministicUpdatedAt
        },
        null,
        2
      )
    );
    lines.push("```");
    lines.push("");
    const mission = db.get(
      `
        select id, title, prompt, status, priority, created_at, updated_at, started_at, completed_at
        from missions
        where lane_id = ? and project_id = ?
        order by updated_at desc
        limit 1
      `,
      [args.laneId, projectId]
    );
    if (mission?.id) {
      lines.push(`# Plan: ${mission.title}`);
      lines.push(`> Lane: ${lane.name} | Mission: ${mission.id} | Status: ${mission.status} | Priority: ${mission.priority}`);
      lines.push("");
      lines.push("## Original Prompt");
      lines.push("```");
      lines.push(mission.prompt.trim());
      lines.push("```");
      lines.push("");
      lines.push("## Mission Metadata");
      lines.push(`- Mission ID: ${mission.id}`);
      lines.push(`- Status: ${mission.status}`);
      lines.push(`- Priority: ${mission.priority}`);
      lines.push(`- Created: ${mission.created_at}`);
      lines.push(`- Updated: ${mission.updated_at}`);
      if (mission.started_at) lines.push(`- Started: ${mission.started_at}`);
      if (mission.completed_at) lines.push(`- Completed: ${mission.completed_at}`);
      lines.push("");
      const steps = db.all(
        `
          select id, step_index, title, detail, kind, status, lane_id, metadata_json, started_at, completed_at
          from mission_steps
          where mission_id = ? and project_id = ?
          order by step_index asc
        `,
        [mission.id, projectId]
      );
      const completedSteps = steps.filter((s) => s.status === "completed").length;
      lines.push("## Steps");
      lines.push(`Progress: ${completedSteps}/${steps.length} completed`);
      lines.push("");
      if (steps.length === 0) {
        lines.push("- No steps defined yet.");
      } else {
        lines.push("| # | Step | Status | Kind | Started | Completed |");
        lines.push("|---|------|--------|------|---------|-----------|");
        for (const step of steps) {
          const desc = step.detail ? ` - ${step.detail.slice(0, 80).replace(/\|/g, "\\|")}` : "";
          lines.push(
            `| ${Number(step.step_index) + 1} | ${step.title.replace(/\|/g, "\\|")}${desc} | ${step.status} | ${step.kind} | ${step.started_at ?? "-"} | ${step.completed_at ?? "-"} |`
          );
        }
        const depsLines = [];
        for (const step of steps) {
          const meta = parseRecord(step.metadata_json);
          const deps = meta && Array.isArray(meta.dependencies) ? meta.dependencies : [];
          if (deps.length) {
            depsLines.push(`- Step ${Number(step.step_index) + 1} (${step.title}): depends on ${deps.join(", ")}`);
          }
        }
        if (depsLines.length) {
          lines.push("");
          lines.push("### Step Dependencies");
          for (const dl of depsLines) lines.push(dl);
        }
      }
      lines.push("");
      const timelineEntries = steps.filter((s) => s.started_at || s.completed_at).sort((a, b) => (a.started_at ?? a.completed_at ?? "").localeCompare(b.started_at ?? b.completed_at ?? ""));
      if (timelineEntries.length) {
        lines.push("## Timeline");
        for (const step of timelineEntries) {
          const start = step.started_at ?? "-";
          const end = step.completed_at ?? "-";
          lines.push(`- Step ${Number(step.step_index) + 1} (${step.title}): started=${start}, completed=${end}`);
        }
        lines.push("");
      }
      const missionMeta = db.get(
        "select metadata_json from missions where id = ? and project_id = ?",
        [mission.id, projectId]
      );
      const missionMetaParsed = parseRecord(missionMeta?.metadata_json);
      if (missionMetaParsed) {
        const policies = [];
        if (missionMetaParsed.handoffPolicy) policies.push(`- Handoff policy: ${JSON.stringify(missionMetaParsed.handoffPolicy)}`);
        if (missionMetaParsed.retryPolicy) policies.push(`- Retry policy: ${JSON.stringify(missionMetaParsed.retryPolicy)}`);
        if (policies.length) {
          lines.push("## Policies");
          for (const p of policies) lines.push(p);
          lines.push("");
        }
      }
    } else {
      const lanePackBody = readFileIfExists(getLanePackPath(args.laneId));
      const intent = extractSection(lanePackBody, ADE_INTENT_START, ADE_INTENT_END, "");
      const taskSpec = extractSection(lanePackBody, ADE_TASK_SPEC_START, ADE_TASK_SPEC_END, "");
      lines.push(`# Plan: ${lane.name}`);
      lines.push(`> Lane: ${lane.name} | Branch: \`${lane.branchRef}\` | No mission linked`);
      lines.push("");
      lines.push("## Objective");
      lines.push(intent.trim().length ? intent.trim() : "Not yet defined");
      lines.push("");
      lines.push("## Current State");
      const keyFilesMatch = /## Key Files \((\d+) files touched\)/.exec(lanePackBody);
      const fileCount = keyFilesMatch ? keyFilesMatch[1] : "0";
      lines.push(`- Files changed: ${fileCount}`);
      lines.push(`- Branch status: ${lane.status.dirty ? "dirty" : "clean"}, ahead ${lane.status.ahead}, behind ${lane.status.behind}`);
      const latestTest = db.get(
        `
          select r.status as status, s.name as suite_name, r.suite_key as suite_key
          from test_runs r
          left join test_suites s on s.project_id = r.project_id and s.id = r.suite_key
          where r.project_id = ? and r.lane_id = ?
          order by r.started_at desc limit 1
        `,
        [projectId, args.laneId]
      );
      if (latestTest) {
        const testLabel = (latestTest.suite_name ?? latestTest.suite_key).trim();
        lines.push(`- Latest test: ${statusFromCode(latestTest.status)} (${testLabel})`);
      } else {
        lines.push("- Latest test: NOT RUN");
      }
      lines.push("");
      lines.push("## Steps");
      lines.push("- (define steps for this lane's work)");
      lines.push("");
      lines.push("## Dependencies");
      const packKey = `lane:${args.laneId}`;
      const packRow = getPackIndexRow(packKey);
      if (packRow?.metadata_json) {
        const packMeta = parseRecord(packRow.metadata_json);
        if (packMeta?.graph && isRecord5(packMeta.graph)) {
          const graphRelations = Array.isArray(packMeta.graph.relations) ? packMeta.graph.relations : [];
          const blockingRels = graphRelations.filter(
            (r) => r.relationType === "blocked_by" || r.relationType === "depends_on"
          );
          if (blockingRels.length) {
            for (const rel of blockingRels) {
              lines.push(`- ${rel.relationType}: ${rel.targetPackKey}`);
            }
          } else {
            lines.push("- No blocking dependencies detected.");
          }
        } else {
          lines.push("- No blocking dependencies detected.");
        }
      } else {
        lines.push("- No blocking dependencies detected.");
      }
      if (lane.parentLaneId) {
        const parentLane = lanes.find((l) => l.id === lane.parentLaneId);
        if (parentLane) lines.push(`- Parent lane: ${parentLane.name} (\`${parentLane.branchRef}\`)`);
      }
      lines.push("");
      lines.push("## Acceptance Criteria");
      if (taskSpec.trim().length) {
        lines.push(taskSpec.trim());
      } else {
        lines.push("- (add acceptance criteria here)");
      }
      lines.push("");
    }
    lines.push("---");
    lines.push(`*Plan pack: auto-generated for lane ${lane.name}. Updated: ${args.deterministicUpdatedAt}*`);
    lines.push("");
    return { body: `${lines.join("\n")}
`, headSha };
  };
  const buildMissionPackBody = async (args) => {
    const mission = db.get(
      `
        select
          id,
          title,
          prompt,
          lane_id,
          status,
          priority,
          execution_mode,
          target_machine_id,
          outcome_summary,
          last_error,
          created_at,
          updated_at,
          started_at,
          completed_at
        from missions
        where id = ?
          and project_id = ?
        limit 1
      `,
      [args.missionId, projectId]
    );
    if (!mission?.id) throw new Error(`Mission not found: ${args.missionId}`);
    const steps = db.all(
      `
        select
          id,
          step_index,
          title,
          detail,
          kind,
          status,
          lane_id,
          metadata_json,
          started_at,
          completed_at,
          updated_at
        from mission_steps
        where mission_id = ?
          and project_id = ?
        order by step_index asc
      `,
      [args.missionId, projectId]
    );
    const artifactRows = db.all(
      `
        select id, artifact_type, title, description, lane_id, created_at
        from mission_artifacts
        where mission_id = ? and project_id = ?
        order by created_at desc
        limit 40
      `,
      [args.missionId, projectId]
    );
    const interventionRows = db.all(
      `
        select id, intervention_type, status, title, body, requested_action, resolution_note, created_at, resolved_at
        from mission_interventions
        where mission_id = ? and project_id = ?
        order by created_at desc
        limit 40
      `,
      [args.missionId, projectId]
    );
    const handoffs = db.all(
      `
        select handoff_type, producer, created_at, payload_json
        from mission_step_handoffs
        where mission_id = ?
          and project_id = ?
        order by created_at desc
        limit 40
      `,
      [args.missionId, projectId]
    );
    const runs = db.all(
      `
        select id, status, context_profile, last_error, created_at, updated_at, started_at, completed_at
        from orchestrator_runs
        where mission_id = ?
          and project_id = ?
        order by created_at desc
        limit 20
      `,
      [args.missionId, projectId]
    );
    const lines = [];
    lines.push("```json");
    lines.push(
      JSON.stringify(
        {
          schema: CONTEXT_HEADER_SCHEMA_V1,
          contractVersion: CONTEXT_CONTRACT_VERSION,
          projectId,
          packType: "mission",
          missionId: mission.id,
          laneId: mission.lane_id,
          status: mission.status,
          deterministicUpdatedAt: args.deterministicUpdatedAt,
          stepCount: steps.length,
          runId: args.runId ?? null
        },
        null,
        2
      )
    );
    lines.push("```");
    lines.push("");
    lines.push(`# Mission Pack: ${mission.title}`);
    lines.push(`> Status: ${mission.status} | Priority: ${mission.priority} | Mode: ${mission.execution_mode}`);
    lines.push("");
    lines.push("## Original Prompt");
    lines.push("```");
    lines.push(mission.prompt.trim());
    lines.push("```");
    lines.push("");
    lines.push("## Mission Metadata");
    lines.push(`- Mission ID: ${mission.id}`);
    lines.push(`- Updated: ${args.deterministicUpdatedAt}`);
    lines.push(`- Trigger: ${args.reason}`);
    lines.push(`- Status: ${mission.status}`);
    lines.push(`- Priority: ${mission.priority}`);
    lines.push(`- Execution mode: ${mission.execution_mode}`);
    if (mission.target_machine_id) lines.push(`- Target machine: ${mission.target_machine_id}`);
    if (args.runId) lines.push(`- Orchestrator run: ${args.runId}`);
    lines.push(`- Created: ${mission.created_at}`);
    lines.push(`- Updated: ${mission.updated_at}`);
    if (mission.started_at) lines.push(`- Started: ${mission.started_at}`);
    if (mission.completed_at) lines.push(`- Completed: ${mission.completed_at}`);
    if (mission.outcome_summary) lines.push(`- Outcome summary: ${mission.outcome_summary}`);
    if (mission.last_error) lines.push(`- Last error: ${mission.last_error}`);
    lines.push("");
    if (mission.started_at) {
      const endTime = mission.completed_at ?? args.deterministicUpdatedAt;
      lines.push("## Mission Duration");
      lines.push(`- Start: ${mission.started_at}`);
      lines.push(`- End: ${mission.completed_at ?? "(in progress)"}`);
      const startMs = new Date(mission.started_at).getTime();
      const endMs = new Date(endTime).getTime();
      if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
        const durationMin = Math.round((endMs - startMs) / 6e4);
        lines.push(`- Duration: ${durationMin}m`);
      }
      lines.push("");
    }
    const completedSteps = steps.filter((s) => s.status === "completed").length;
    lines.push("## Step Progress");
    lines.push(`Progress: ${completedSteps}/${steps.length} completed`);
    lines.push("");
    if (!steps.length) {
      lines.push("- No mission steps.");
      lines.push("");
    } else {
      lines.push("| # | Step | Status | Kind | Lane | Started | Completed |");
      lines.push("|---|------|--------|------|------|---------|-----------|");
      for (const step of steps) {
        const detail = step.detail ? ` - ${step.detail.slice(0, 60).replace(/\|/g, "\\|")}` : "";
        lines.push(
          `| ${Number(step.step_index) + 1} | ${step.title.replace(/\|/g, "\\|")}${detail} | ${step.status} | ${step.kind} | ${step.lane_id ?? "-"} | ${step.started_at ?? "-"} | ${step.completed_at ?? "-"} |`
        );
      }
      lines.push("");
      const stepErrors = [];
      for (const step of steps) {
        const meta = parseRecord(step.metadata_json);
        if (!meta) continue;
        const errors = Array.isArray(meta.errors) ? meta.errors : [];
        const lastError = typeof meta.last_error === "string" ? meta.last_error : null;
        if (errors.length) {
          for (const err of errors.slice(-5)) {
            stepErrors.push(`- Step ${Number(step.step_index) + 1} (${step.title}): ${String(err).slice(0, 200)}`);
          }
        } else if (lastError) {
          stepErrors.push(`- Step ${Number(step.step_index) + 1} (${step.title}): ${lastError.slice(0, 200)}`);
        }
      }
      if (stepErrors.length) {
        lines.push("### Step Error History");
        for (const se of stepErrors.slice(0, 20)) lines.push(se);
        lines.push("");
      }
    }
    const timelineSteps = steps.filter((s) => s.started_at || s.completed_at);
    if (timelineSteps.length) {
      lines.push("## Step Timeline");
      const timelineEvents = [];
      for (const step of timelineSteps) {
        if (step.started_at) {
          timelineEvents.push({ time: step.started_at, label: `Step ${Number(step.step_index) + 1} (${step.title}) started` });
        }
        if (step.completed_at) {
          timelineEvents.push({ time: step.completed_at, label: `Step ${Number(step.step_index) + 1} (${step.title}) completed [${step.status}]` });
        }
      }
      timelineEvents.sort((a, b) => a.time.localeCompare(b.time));
      for (const ev of timelineEvents) {
        lines.push(`- ${ev.time}: ${ev.label}`);
      }
      lines.push("");
    }
    lines.push("## Step Sessions");
    let hasStepSessions = false;
    for (const step of steps) {
      if (!step.lane_id) continue;
      const stepSessions = db.all(
        `
          select id, title, tool_type, started_at, ended_at, status, exit_code
          from terminal_sessions
          where lane_id = ?
            and started_at >= ?
          order by started_at asc
          limit 8
        `,
        [step.lane_id, step.started_at ?? step.updated_at]
      );
      if (stepSessions.length) {
        hasStepSessions = true;
        lines.push(`### Step ${Number(step.step_index) + 1}: ${step.title}`);
        for (const sess of stepSessions) {
          const tool = humanToolLabel(sess.tool_type);
          const outcome = sess.status === "running" ? "RUNNING" : sess.exit_code === 0 ? "OK" : sess.exit_code != null ? `EXIT ${sess.exit_code}` : "ENDED";
          lines.push(`- ${sess.started_at} | ${tool} | ${(sess.title ?? "").slice(0, 60)} | ${outcome}`);
        }
        lines.push("");
      }
    }
    if (!hasStepSessions) {
      lines.push("- No per-step sessions recorded.");
      lines.push("");
    }
    lines.push("## Artifacts");
    if (!artifactRows.length) {
      lines.push("- No artifacts recorded.");
    } else {
      lines.push(`Total: ${artifactRows.length}`);
      lines.push("");
      for (const art of artifactRows) {
        const desc = art.description ? ` - ${art.description.slice(0, 100)}` : "";
        lines.push(`- [${art.artifact_type}] ${art.title}${desc} (${art.created_at})`);
      }
    }
    lines.push("");
    lines.push("## Interventions");
    const openInterventions = interventionRows.filter((i) => i.status === "open").length;
    if (!interventionRows.length) {
      lines.push("- No interventions recorded.");
    } else {
      lines.push(`Total: ${interventionRows.length} (${openInterventions} open)`);
      lines.push("");
      for (const intv of interventionRows) {
        lines.push(`- [${intv.status}] ${intv.intervention_type}: ${intv.title}`);
        if (intv.body.trim()) lines.push(`  ${intv.body.trim().slice(0, 200)}`);
        if (intv.requested_action) lines.push(`  Requested: ${intv.requested_action.slice(0, 150)}`);
        if (intv.resolution_note) lines.push(`  Resolution: ${intv.resolution_note.slice(0, 150)}`);
      }
    }
    lines.push("");
    lines.push("## Orchestrator Runs");
    if (!runs.length) {
      lines.push("- No orchestrator runs linked yet.");
    } else {
      for (const run of runs) {
        const duration = run.started_at && run.completed_at ? `${Math.round((new Date(run.completed_at).getTime() - new Date(run.started_at).getTime()) / 6e4)}m` : run.started_at ? "in progress" : "-";
        lines.push(`- ${run.id} | ${run.status} | profile=${run.context_profile} | duration=${duration} | updated=${run.updated_at}`);
        if (run.last_error) lines.push(`  error: ${run.last_error.slice(0, 200)}`);
      }
    }
    lines.push("");
    lines.push("## Step Handoffs");
    if (!handoffs.length) {
      lines.push("- No step handoffs recorded.");
    } else {
      for (const handoff of handoffs) {
        const payload = parseRecord(handoff.payload_json);
        const summary = payload?.result && typeof payload.result === "object" ? String(payload.result.summary ?? "") : "";
        lines.push(
          `- ${handoff.created_at} | ${handoff.handoff_type} | producer=${handoff.producer}${summary ? ` | ${summary}` : ""}`
        );
      }
    }
    lines.push("");
    if (mission.lane_id) {
      const lanePack = readFileIfExists(getLanePackPath(mission.lane_id));
      if (lanePack.trim().length) {
        lines.push("## Lane Pack Reference");
        lines.push(`- Lane pack key: lane:${mission.lane_id}`);
        lines.push(`- Lane pack path: ${getLanePackPath(mission.lane_id)}`);
        lines.push("");
      }
    }
    lines.push("---");
    lines.push(`*Mission pack: deterministic context snapshot. Updated: ${args.deterministicUpdatedAt}*`);
    lines.push("");
    return {
      body: `${lines.join("\n")}
`,
      laneId: mission.lane_id ?? null
    };
  };
  const buildConflictPackBody = async (args) => {
    const laneA = laneService.getLaneBaseAndBranch(args.laneId);
    const laneAHead = (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: laneA.worktreePath, timeoutMs: 1e4 })).trim();
    const peerLabel = args.peerLaneId ? `lane:${args.peerLaneId}` : `base:${laneA.baseRef}`;
    const laneBHead = args.peerLaneId ? (await runGitOrThrow(["rev-parse", "HEAD"], { cwd: laneService.getLaneBaseAndBranch(args.peerLaneId).worktreePath, timeoutMs: 1e4 })).trim() : (await runGitOrThrow(["rev-parse", laneA.baseRef], { cwd: projectRoot, timeoutMs: 1e4 })).trim();
    const mergeBase = (await runGitOrThrow(["merge-base", laneAHead, laneBHead], { cwd: projectRoot, timeoutMs: 12e3 })).trim();
    const merge = await runGitMergeTree({
      cwd: projectRoot,
      mergeBase,
      branchA: laneAHead,
      branchB: laneBHead,
      timeoutMs: 6e4
    });
    const touchedA = await runGit(["diff", "--name-only", `${mergeBase}..${laneAHead}`], { cwd: projectRoot, timeoutMs: 2e4 });
    const touchedB = await runGit(["diff", "--name-only", `${mergeBase}..${laneBHead}`], { cwd: projectRoot, timeoutMs: 2e4 });
    const aFiles = new Set(parseDiffNameOnly(touchedA.stdout));
    const bFiles = new Set(parseDiffNameOnly(touchedB.stdout));
    const overlap = uniqueSorted(Array.from(aFiles).filter((file) => bFiles.has(file)));
    const lines = [];
    lines.push(`# Conflict Pack`);
    lines.push("");
    lines.push(`- Deterministic updated: ${args.deterministicUpdatedAt}`);
    lines.push(`- Trigger: ${args.reason}`);
    lines.push(`- Lane: ${args.laneId}`);
    lines.push(`- Peer: ${peerLabel}`);
    lines.push(`- Merge base: ${mergeBase}`);
    lines.push(`- Lane HEAD: ${laneAHead}`);
    lines.push(`- Peer HEAD: ${laneBHead}`);
    lines.push("");
    lines.push("## Overlapping Files");
    if (overlap.length) {
      for (const file of overlap.slice(0, 120)) {
        lines.push(`- ${file}`);
      }
      if (overlap.length > 120) lines.push(`- \u2026 (${overlap.length - 120} more)`);
    } else {
      lines.push("- none");
    }
    lines.push("");
    lines.push("## Conflicts (merge-tree)");
    if (merge.conflicts.length) {
      for (const conflict of merge.conflicts.slice(0, 30)) {
        lines.push(`### ${conflict.path} (${conflict.conflictType})`);
        if (conflict.markerPreview.trim().length) {
          lines.push("```");
          lines.push(conflict.markerPreview.trim());
          lines.push("```");
        }
        lines.push("");
      }
      if (merge.conflicts.length > 30) {
        lines.push(`(truncated) ${merge.conflicts.length} conflicts total.`);
        lines.push("");
      }
    } else {
      lines.push("- no merge-tree conflicts reported");
      lines.push("");
    }
    const lanePackBody = readLanePackExcerpt(args.laneId);
    if (lanePackBody) {
      lines.push("## Lane Pack (Excerpt)");
      lines.push("```");
      lines.push(lanePackBody.trim());
      lines.push("```");
      lines.push("");
    }
    if (args.peerLaneId) {
      const peerPackBody = readLanePackExcerpt(args.peerLaneId);
      if (peerPackBody) {
        lines.push("## Peer Lane Pack (Excerpt)");
        lines.push("```");
        lines.push(peerPackBody.trim());
        lines.push("```");
        lines.push("");
      }
    }
    lines.push("## Narrative");
    lines.push("Conflict packs are data-heavy: overlap lists, merge-tree conflicts, and lane context excerpts.");
    lines.push("");
    return { body: `${lines.join("\n")}
`, lastHeadSha: laneAHead };
  };
  return {
    getProjectPack() {
      const row = db.get(
        `
          select
            pack_type,
            pack_path,
            deterministic_updated_at,
            narrative_updated_at,
            last_head_sha,
            metadata_json
          from packs_index
          where pack_key = 'project'
            and project_id = ?
          limit 1
        `,
        [projectId]
      );
      const version = readCurrentPackVersion("project");
      if (row) return toPackSummaryFromRow({ packKey: "project", row, version });
      const body = readFileIfExists(projectPackPath);
      const exists = import_node_fs7.default.existsSync(projectPackPath);
      return {
        packKey: "project",
        packType: "project",
        path: projectPackPath,
        exists,
        deterministicUpdatedAt: null,
        narrativeUpdatedAt: null,
        lastHeadSha: null,
        versionId: version?.versionId ?? null,
        versionNumber: version?.versionNumber ?? null,
        contentHash: version?.contentHash ?? null,
        metadata: null,
        body
      };
    },
    getContextStatus() {
      return readContextStatus();
    },
    async generateContextDocs(args) {
      return runContextDocGeneration(args);
    },
    prepareContextDocGeneration(args) {
      return prepareContextDocGeneration(args);
    },
    installGeneratedDocs(args) {
      return installGeneratedDocs(args);
    },
    getContextDocPath(docId) {
      return resolveContextDocPath(docId);
    },
    getLanePack(laneId) {
      const row = db.get(
        `
          select
            pack_type,
            pack_path,
            deterministic_updated_at,
            narrative_updated_at,
            last_head_sha,
            metadata_json
          from packs_index
          where pack_key = ?
            and project_id = ?
          limit 1
        `,
        [`lane:${laneId}`, projectId]
      );
      const packKey = `lane:${laneId}`;
      const version = readCurrentPackVersion(packKey);
      if (row) return toPackSummaryFromRow({ packKey, row, version });
      const lanePackPath = getLanePackPath(laneId);
      const body = readFileIfExists(lanePackPath);
      const exists = import_node_fs7.default.existsSync(lanePackPath);
      return {
        packKey,
        packType: "lane",
        path: lanePackPath,
        exists,
        deterministicUpdatedAt: null,
        narrativeUpdatedAt: null,
        lastHeadSha: null,
        versionId: version?.versionId ?? null,
        versionNumber: version?.versionNumber ?? null,
        contentHash: version?.contentHash ?? null,
        metadata: null,
        body
      };
    },
    getFeaturePack(featureKey) {
      const key = featureKey.trim();
      if (!key) throw new Error("featureKey is required");
      const packKey = `feature:${key}`;
      return getPackSummaryForKey(packKey, { packType: "feature", packPath: getFeaturePackPath(key) });
    },
    getConflictPack(args) {
      const laneId = args.laneId.trim();
      if (!laneId) throw new Error("laneId is required");
      const peer = args.peerLaneId?.trim() || null;
      const lane = laneService.getLaneBaseAndBranch(laneId);
      const peerKey = peer ?? lane.baseRef;
      const packKey = `conflict:${laneId}:${peerKey}`;
      return getPackSummaryForKey(packKey, { packType: "conflict", packPath: getConflictPackPath(laneId, peerKey) });
    },
    getPlanPack(laneId) {
      const id = laneId.trim();
      if (!id) throw new Error("laneId is required");
      const packKey = `plan:${id}`;
      return getPackSummaryForKey(packKey, { packType: "plan", packPath: getPlanPackPath(id) });
    },
    getMissionPack(missionId) {
      const id = missionId.trim();
      if (!id) throw new Error("missionId is required");
      const packKey = `mission:${id}`;
      return getPackSummaryForKey(packKey, { packType: "mission", packPath: getMissionPackPath(id) });
    },
    getSessionDelta(sessionId) {
      const row = getSessionDeltaRow(sessionId);
      if (!row) return null;
      return rowToSessionDelta(row);
    },
    async computeSessionDelta(sessionId) {
      const session = getSessionRow(sessionId);
      if (!session) return null;
      if (session.tracked !== 1) return null;
      const lane = laneService.getLaneBaseAndBranch(session.lane_id);
      const diffRef = session.head_sha_start?.trim() || "HEAD";
      const numStatRes = await runGit(["diff", "--numstat", diffRef], { cwd: lane.worktreePath, timeoutMs: 2e4 });
      const nameRes = await runGit(["diff", "--name-only", diffRef], { cwd: lane.worktreePath, timeoutMs: 2e4 });
      const statusRes = await runGit(["status", "--porcelain=v1"], { cwd: lane.worktreePath, timeoutMs: 8e3 });
      const parsedStat = parseNumStat(numStatRes.stdout);
      const touched = /* @__PURE__ */ new Set([...parsedStat.files]);
      if (nameRes.exitCode === 0) {
        for (const line of nameRes.stdout.split("\n").map((entry) => entry.trim()).filter(Boolean)) {
          touched.add(line);
        }
      }
      if (statusRes.exitCode === 0) {
        for (const rel of parsePorcelainPaths(statusRes.stdout)) {
          touched.add(rel);
        }
      }
      const isChatTranscript = session.transcript_path.endsWith(".chat.jsonl");
      const transcript = sessionService.readTranscriptTail(
        session.transcript_path,
        22e4,
        isChatTranscript ? { raw: true, alignToLineBoundary: true } : void 0
      );
      const failureLines = (() => {
        const out = [];
        const seen = /* @__PURE__ */ new Set();
        const push = (value) => {
          const normalized = stripAnsi(String(value ?? "")).replace(/\s+/g, " ").trim();
          if (!normalized.length) return;
          if (seen.has(normalized)) return;
          seen.add(normalized);
          out.push(normalized);
        };
        for (const rawLine of transcript.split("\n")) {
          const line = stripAnsi(rawLine).trim();
          if (!line) continue;
          if (!/\b(error|failed|exception|fatal|traceback)\b/i.test(line)) continue;
          push(line);
        }
        if (isChatTranscript) {
          const chatDelta = parseChatTranscriptDelta(transcript);
          for (const touchedPath of chatDelta.touchedFiles) {
            touched.add(touchedPath);
          }
          for (const line of chatDelta.failureLines) {
            push(line);
          }
        }
        return out.slice(-8);
      })();
      const touchedFiles = [...touched].sort();
      const computedAt = (/* @__PURE__ */ new Date()).toISOString();
      db.run(
        `
          insert into session_deltas(
            session_id,
            project_id,
            lane_id,
            started_at,
            ended_at,
            head_sha_start,
            head_sha_end,
            files_changed,
            insertions,
            deletions,
            touched_files_json,
            failure_lines_json,
            computed_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict(session_id) do update set
            project_id = excluded.project_id,
            lane_id = excluded.lane_id,
            started_at = excluded.started_at,
            ended_at = excluded.ended_at,
            head_sha_start = excluded.head_sha_start,
            head_sha_end = excluded.head_sha_end,
            files_changed = excluded.files_changed,
            insertions = excluded.insertions,
            deletions = excluded.deletions,
            touched_files_json = excluded.touched_files_json,
            failure_lines_json = excluded.failure_lines_json,
            computed_at = excluded.computed_at
        `,
        [
          session.id,
          projectId,
          session.lane_id,
          session.started_at,
          session.ended_at,
          session.head_sha_start,
          session.head_sha_end,
          touchedFiles.length,
          parsedStat.insertions,
          parsedStat.deletions,
          JSON.stringify(touchedFiles),
          JSON.stringify(failureLines),
          computedAt
        ]
      );
      logger.info("packs.session_delta_updated", {
        sessionId,
        laneId: session.lane_id,
        filesChanged: touchedFiles.length,
        insertions: parsedStat.insertions,
        deletions: parsedStat.deletions
      });
      return {
        sessionId: session.id,
        laneId: session.lane_id,
        startedAt: session.started_at,
        endedAt: session.ended_at,
        headShaStart: session.head_sha_start,
        headShaEnd: session.head_sha_end,
        filesChanged: touchedFiles.length,
        insertions: parsedStat.insertions,
        deletions: parsedStat.deletions,
        touchedFiles,
        failureLines,
        computedAt
      };
    },
    async refreshLanePack(args) {
      const op = operationService.start({
        laneId: args.laneId,
        kind: "pack_update_lane",
        metadata: {
          reason: args.reason,
          sessionId: args.sessionId ?? null
        }
      });
      try {
        const latestDelta = args.sessionId ? await this.computeSessionDelta(args.sessionId) : listRecentLaneSessionDeltas(args.laneId, 1)[0] ?? null;
        const deterministicUpdatedAt = nowIso3();
        const { body, lastHeadSha } = await buildLanePackBody({
          laneId: args.laneId,
          reason: args.reason,
          latestDelta,
          deterministicUpdatedAt
        });
        const packKey = `lane:${args.laneId}`;
        const packPath = getLanePackPath(args.laneId);
        const summary = persistPackRefresh({
          packKey,
          packType: "lane",
          packPath,
          laneId: args.laneId,
          body,
          deterministicUpdatedAt,
          narrativeUpdatedAt: null,
          lastHeadSha,
          metadata: {
            reason: args.reason,
            sessionId: args.sessionId ?? null,
            latestDeltaSessionId: latestDelta?.sessionId ?? null,
            operationId: op.operationId
          },
          eventType: "refresh_triggered",
          eventPayload: {
            operationId: op.operationId,
            trigger: args.reason,
            laneId: args.laneId,
            sessionId: args.sessionId ?? null
          }
        });
        if (args.sessionId && latestDelta) {
          const checkpointSha = lastHeadSha ?? latestDelta.headShaEnd ?? latestDelta.headShaStart ?? null;
          if (checkpointSha) {
            recordCheckpointFromDelta({
              laneId: args.laneId,
              sessionId: args.sessionId,
              sha: checkpointSha,
              delta: latestDelta
            });
          }
        }
        operationService.finish({
          operationId: op.operationId,
          status: "succeeded",
          postHeadSha: lastHeadSha,
          metadataPatch: {
            packPath,
            deterministicUpdatedAt,
            latestDeltaSessionId: latestDelta?.sessionId ?? null,
            versionId: summary.versionId ?? null,
            versionNumber: summary.versionNumber ?? null
          }
        });
        return summary;
      } catch (error) {
        operationService.finish({
          operationId: op.operationId,
          status: "failed",
          metadataPatch: {
            error: error instanceof Error ? error.message : String(error)
          }
        });
        throw error;
      }
    },
    async refreshProjectPack(args) {
      const op = operationService.start({
        laneId: args.laneId ?? null,
        kind: "pack_update_project",
        metadata: {
          reason: args.reason,
          sourceLaneId: args.laneId ?? null
        }
      });
      try {
        const deterministicUpdatedAt = nowIso3();
        const body = await buildProjectPackBody({
          reason: args.reason,
          deterministicUpdatedAt,
          sourceLaneId: args.laneId
        });
        const packKey = "project";
        const summary = persistPackRefresh({
          packKey,
          packType: "project",
          packPath: projectPackPath,
          laneId: null,
          body,
          deterministicUpdatedAt,
          narrativeUpdatedAt: null,
          lastHeadSha: null,
          metadata: {
            ...readContextDocMeta(),
            reason: args.reason,
            sourceLaneId: args.laneId ?? null,
            operationId: op.operationId
          },
          eventType: "refresh_triggered",
          eventPayload: {
            operationId: op.operationId,
            trigger: args.reason,
            laneId: args.laneId ?? null
          }
        });
        operationService.finish({
          operationId: op.operationId,
          status: "succeeded",
          metadataPatch: {
            packPath: projectPackPath,
            deterministicUpdatedAt,
            versionId: summary.versionId ?? null,
            versionNumber: summary.versionNumber ?? null
          }
        });
        return summary;
      } catch (error) {
        operationService.finish({
          operationId: op.operationId,
          status: "failed",
          metadataPatch: {
            error: error instanceof Error ? error.message : String(error)
          }
        });
        throw error;
      }
    },
    async refreshFeaturePack(args) {
      const key = args.featureKey.trim();
      if (!key) throw new Error("featureKey is required");
      const packKey = `feature:${key}`;
      const deterministicUpdatedAt = nowIso3();
      const built = await buildFeaturePackBody({
        featureKey: key,
        reason: args.reason,
        deterministicUpdatedAt
      });
      const packPath = getFeaturePackPath(key);
      return persistPackRefresh({
        packKey,
        packType: "feature",
        packPath,
        laneId: null,
        body: built.body,
        deterministicUpdatedAt,
        narrativeUpdatedAt: null,
        lastHeadSha: null,
        metadata: {
          reason: args.reason,
          featureKey: key,
          laneIds: built.laneIds
        },
        eventType: "refresh_triggered",
        eventPayload: { trigger: args.reason, featureKey: key, laneIds: built.laneIds }
      });
    },
    async refreshConflictPack(args) {
      const laneId = args.laneId.trim();
      if (!laneId) throw new Error("laneId is required");
      const peer = args.peerLaneId?.trim() || null;
      const lane = laneService.getLaneBaseAndBranch(laneId);
      const peerKey = peer ?? lane.baseRef;
      const packKey = `conflict:${laneId}:${peerKey}`;
      const deterministicUpdatedAt = nowIso3();
      const built = await buildConflictPackBody({
        laneId,
        peerLaneId: peer,
        reason: args.reason,
        deterministicUpdatedAt
      });
      const packPath = getConflictPackPath(laneId, peerKey);
      return persistPackRefresh({
        packKey,
        packType: "conflict",
        packPath,
        laneId,
        body: built.body,
        deterministicUpdatedAt,
        narrativeUpdatedAt: null,
        lastHeadSha: built.lastHeadSha,
        metadata: {
          reason: args.reason,
          laneId,
          peerLaneId: peer,
          peerKey
        },
        eventType: "refresh_triggered",
        eventPayload: { trigger: args.reason, laneId, peerLaneId: peer, peerKey }
      });
    },
    async refreshPlanPack(args) {
      const laneId = args.laneId.trim();
      if (!laneId) throw new Error("laneId is required");
      const packKey = `plan:${laneId}`;
      const deterministicUpdatedAt = nowIso3();
      const built = await buildPlanPackBody({
        laneId,
        reason: args.reason,
        deterministicUpdatedAt
      });
      const packPath = getPlanPackPath(laneId);
      return persistPackRefresh({
        packKey,
        packType: "plan",
        packPath,
        laneId,
        body: built.body,
        deterministicUpdatedAt,
        narrativeUpdatedAt: null,
        lastHeadSha: built.headSha,
        metadata: {
          reason: args.reason,
          laneId
        },
        eventType: "refresh_triggered",
        eventPayload: { trigger: args.reason, laneId }
      });
    },
    async savePlanPack(args) {
      const laneId = args.laneId.trim();
      if (!laneId) throw new Error("laneId is required");
      const packKey = `plan:${laneId}`;
      const packPath = getPlanPackPath(laneId);
      const deterministicUpdatedAt = nowIso3();
      const lane = laneService.getLaneBaseAndBranch(laneId);
      const headSha = await getHeadSha3(lane.worktreePath);
      const body = args.body ?? "";
      return persistPackRefresh({
        packKey,
        packType: "plan",
        packPath,
        laneId,
        body,
        deterministicUpdatedAt,
        narrativeUpdatedAt: deterministicUpdatedAt,
        lastHeadSha: headSha,
        metadata: {
          reason: args.reason,
          laneId
        },
        eventType: "plan_saved",
        eventPayload: { trigger: args.reason, laneId }
      });
    },
    async refreshMissionPack(args) {
      const missionId = args.missionId.trim();
      if (!missionId) throw new Error("missionId is required");
      const packKey = `mission:${missionId}`;
      const deterministicUpdatedAt = nowIso3();
      const built = await buildMissionPackBody({
        missionId,
        reason: args.reason,
        deterministicUpdatedAt,
        runId: args.runId ?? null
      });
      const packPath = getMissionPackPath(missionId);
      return persistPackRefresh({
        packKey,
        packType: "mission",
        packPath,
        laneId: built.laneId,
        body: built.body,
        deterministicUpdatedAt,
        narrativeUpdatedAt: null,
        lastHeadSha: null,
        metadata: {
          reason: args.reason,
          missionId,
          runId: args.runId ?? null
        },
        eventType: "refresh_triggered",
        eventPayload: {
          trigger: args.reason,
          missionId,
          runId: args.runId ?? null
        }
      });
    },
    updateNarrative(args) {
      const packKey = args.packKey.trim();
      if (!packKey) throw new Error("packKey is required");
      const row = getPackIndexRow(packKey);
      if (!row?.pack_path) throw new Error(`Pack not found: ${packKey}`);
      const existingMetadata = parsePackMetadataJson(row.metadata_json) ?? {};
      const nextMetadata = {
        ...existingMetadata,
        ...args.metadata ?? {}
      };
      const existing = readFileIfExists(row.pack_path);
      const { updated: updatedBody, insertedMarkers } = replaceNarrativeSection(existing, args.narrative);
      ensureDirFor(row.pack_path);
      import_node_fs7.default.writeFileSync(row.pack_path, updatedBody, "utf8");
      const now = nowIso3();
      const provider = typeof nextMetadata.provider === "string" ? nextMetadata.provider : null;
      const model = typeof nextMetadata.model === "string" ? nextMetadata.model : null;
      createPackEvent({
        packKey,
        eventType: "narrative_update",
        payload: {
          source: args.source ?? "user",
          insertedMarkers,
          ...provider ? { provider } : {},
          ...model ? { model } : {}
        }
      });
      const version = createPackVersion({ packKey, packType: row.pack_type, body: updatedBody });
      nextMetadata.source = args.source ?? "user";
      nextMetadata.versionId = version.versionId;
      nextMetadata.versionNumber = version.versionNumber;
      nextMetadata.contentHash = version.contentHash;
      upsertPackIndex({
        db,
        projectId,
        packKey,
        laneId: row.lane_id ?? null,
        packType: row.pack_type,
        packPath: row.pack_path,
        deterministicUpdatedAt: row.deterministic_updated_at ?? now,
        narrativeUpdatedAt: now,
        lastHeadSha: row.last_head_sha ?? null,
        metadata: nextMetadata
      });
      return toPackSummaryFromRow({
        packKey,
        row: {
          ...row,
          narrative_updated_at: now
        },
        version: {
          versionId: version.versionId,
          versionNumber: version.versionNumber,
          contentHash: version.contentHash
        }
      });
    },
    listVersions(args) {
      const packKey = args.packKey.trim();
      if (!packKey) throw new Error("packKey is required");
      const limit = typeof args.limit === "number" ? Math.max(1, Math.min(200, Math.floor(args.limit))) : 50;
      const packType = getPackIndexRow(packKey)?.pack_type ?? inferPackTypeFromKey(packKey);
      const rows = db.all(
        `
          select id, version_number, content_hash, created_at
          from pack_versions
          where project_id = ?
            and pack_key = ?
          order by version_number desc
          limit ?
        `,
        [projectId, packKey, limit]
      );
      return rows.map((row) => ({
        id: row.id,
        packKey,
        packType,
        versionNumber: Number(row.version_number ?? 0),
        contentHash: String(row.content_hash ?? ""),
        createdAt: row.created_at
      }));
    },
    getVersion(versionId) {
      const id = versionId.trim();
      if (!id) throw new Error("versionId is required");
      const row = db.get(
        `
          select id, pack_key, version_number, content_hash, rendered_path, created_at
          from pack_versions
          where project_id = ?
            and id = ?
          limit 1
        `,
        [projectId, id]
      );
      if (!row) throw new Error(`Pack version not found: ${id}`);
      const packType = getPackIndexRow(row.pack_key)?.pack_type ?? inferPackTypeFromKey(row.pack_key);
      return {
        id: row.id,
        packKey: row.pack_key,
        packType,
        versionNumber: Number(row.version_number ?? 0),
        contentHash: String(row.content_hash ?? ""),
        renderedPath: row.rendered_path,
        body: readFileIfExists(row.rendered_path),
        createdAt: row.created_at
      };
    },
    async diffVersions(args) {
      const from = this.getVersion(args.fromId);
      const to = this.getVersion(args.toId);
      const res = await runGit(["diff", "--no-index", "--", from.renderedPath, to.renderedPath], {
        cwd: projectRoot,
        timeoutMs: 2e4
      });
      if (res.exitCode === 0 || res.exitCode === 1) {
        return res.stdout;
      }
      throw new Error(res.stderr.trim() || "Failed to diff pack versions");
    },
    listEvents(args) {
      const packKey = args.packKey.trim();
      if (!packKey) throw new Error("packKey is required");
      const limit = typeof args.limit === "number" ? Math.max(1, Math.min(200, Math.floor(args.limit))) : 50;
      const rows = db.all(
        `
          select id, pack_key, event_type, payload_json, created_at
          from pack_events
          where project_id = ?
            and pack_key = ?
          order by created_at desc
          limit ?
        `,
        [projectId, packKey, limit]
      );
      return rows.map(
        (row) => ensureEventMeta({
          id: row.id,
          packKey: row.pack_key,
          eventType: row.event_type,
          payload: (() => {
            try {
              return row.payload_json ? JSON.parse(row.payload_json) : {};
            } catch {
              return {};
            }
          })(),
          createdAt: row.created_at
        })
      );
    },
    listEventsSince(args) {
      const packKey = args.packKey.trim();
      if (!packKey) throw new Error("packKey is required");
      const sinceIso = args.sinceIso.trim();
      if (!sinceIso) throw new Error("sinceIso is required");
      const limit = typeof args.limit === "number" ? Math.max(1, Math.min(500, Math.floor(args.limit))) : 200;
      const rows = db.all(
        `
          select id, pack_key, event_type, payload_json, created_at
          from pack_events
          where project_id = ?
            and pack_key = ?
            and created_at > ?
          order by created_at asc
          limit ?
        `,
        [projectId, packKey, sinceIso, limit]
      );
      return rows.map(
        (row) => ensureEventMeta({
          id: row.id,
          packKey: row.pack_key,
          eventType: row.event_type,
          payload: (() => {
            try {
              return row.payload_json ? JSON.parse(row.payload_json) : {};
            } catch {
              return {};
            }
          })(),
          createdAt: row.created_at
        })
      );
    },
    getHeadVersion(args) {
      const packKey = args.packKey.trim();
      if (!packKey) throw new Error("packKey is required");
      const packType = getPackIndexRow(packKey)?.pack_type ?? inferPackTypeFromKey(packKey);
      const row = db.get(
        `
          select v.id as id,
                 v.version_number as version_number,
                 v.content_hash as content_hash,
                 h.updated_at as updated_at
          from pack_heads h
          join pack_versions v on v.id = h.current_version_id and v.project_id = h.project_id
          where h.project_id = ?
            and h.pack_key = ?
          limit 1
        `,
        [projectId, packKey]
      );
      return {
        packKey,
        packType,
        versionId: row?.id ?? null,
        versionNumber: row ? Number(row.version_number ?? 0) : null,
        contentHash: row?.content_hash != null ? String(row.content_hash) : null,
        updatedAt: row?.updated_at ?? null
      };
    },
    async getDeltaDigest(args) {
      const packKey = (args.packKey ?? "").trim();
      if (!packKey) throw new Error("packKey is required");
      const minimum = args.minimumImportance ?? "medium";
      const limit = typeof args.limit === "number" ? Math.max(10, Math.min(500, Math.floor(args.limit))) : 200;
      const sinceVersionId = typeof args.sinceVersionId === "string" ? args.sinceVersionId.trim() : "";
      const sinceTimestamp = typeof args.sinceTimestamp === "string" ? args.sinceTimestamp.trim() : "";
      if (!sinceVersionId && !sinceTimestamp) {
        throw new Error("sinceVersionId or sinceTimestamp is required");
      }
      let baselineVersion = null;
      let baselineCreatedAt = null;
      let baselineVersionId = null;
      let baselineVersionNumber = null;
      let sinceIso = sinceTimestamp;
      if (sinceVersionId) {
        const v = this.getVersion(sinceVersionId);
        baselineVersion = v;
        baselineCreatedAt = v.createdAt;
        baselineVersionId = v.id;
        baselineVersionNumber = v.versionNumber;
        sinceIso = v.createdAt;
      } else {
        const parsed = Date.parse(sinceTimestamp);
        if (!Number.isFinite(parsed)) throw new Error("Invalid sinceTimestamp");
        const baseline = findBaselineVersionAtOrBefore({ packKey, sinceIso: sinceTimestamp });
        if (baseline?.id) {
          const v = this.getVersion(baseline.id);
          baselineVersion = v;
          baselineCreatedAt = v.createdAt;
          baselineVersionId = v.id;
          baselineVersionNumber = v.versionNumber;
          sinceIso = v.createdAt;
        }
      }
      const newVersion = this.getHeadVersion({ packKey });
      const packType = newVersion.packType;
      const afterBody = newVersion.versionId ? this.getVersion(newVersion.versionId).body : "";
      const beforeBody = baselineVersion?.body ?? null;
      const changedSections = computeSectionChanges({
        before: beforeBody,
        after: afterBody,
        locators: getDefaultSectionLocators(packType)
      });
      const eventsRaw = this.listEventsSince({ packKey, sinceIso, limit });
      const highImpactEvents = eventsRaw.filter((event) => {
        const payload = event.payload ?? {};
        return importanceRank(payload.importance) >= importanceRank(minimum);
      });
      const conflictState = (() => {
        if (!packKey.startsWith("lane:")) return null;
        const laneId = packKey.slice("lane:".length);
        return deriveConflictStateForLane(laneId);
      })();
      const blockers = [];
      if (packKey.startsWith("lane:")) {
        const laneId = packKey.slice("lane:".length);
        const row = db.get(
          "select parent_lane_id from lanes where id = ? and project_id = ? limit 1",
          [laneId, projectId]
        );
        const parentLaneId = row?.parent_lane_id ?? null;
        if (parentLaneId) {
          blockers.push({
            kind: "merge",
            summary: `Blocked by parent lane ${parentLaneId} (stacked lane).`,
            entityIds: [laneId, parentLaneId]
          });
        }
      }
      if (conflictState?.status === "conflict-active" || conflictState?.status === "conflict-predicted") {
        blockers.push({
          kind: "conflict",
          summary: `Conflicts: ${conflictState.status} (peerConflicts=${conflictState.peerConflictCount ?? 0}).`,
          entityIds: []
        });
      }
      if (conflictState?.truncated) {
        blockers.push({
          kind: "conflict",
          summary: `Conflict coverage is partial (strategy=${conflictState.strategy ?? "partial"}; pairs=${conflictState.pairwisePairsComputed ?? 0}/${conflictState.pairwisePairsTotal ?? 0}).`,
          entityIds: []
        });
      }
      const decisionReasons = [];
      let recommendedExportLevel = "lite";
      if (changedSections.some((c) => c.sectionId === "narrative")) {
        recommendedExportLevel = "deep";
        decisionReasons.push("Narrative changed; deep export includes narrative content.");
      } else if (blockers.length || conflictState?.status && conflictState.status !== "merge-ready") {
        recommendedExportLevel = "standard";
        decisionReasons.push("Blockers/conflicts present; standard export recommended.");
      } else if (changedSections.length) {
        recommendedExportLevel = "standard";
        decisionReasons.push("Multiple sections changed; standard export recommended.");
      } else {
        decisionReasons.push("No material section changes detected; lite is sufficient.");
      }
      const handoffSummary = (() => {
        const parts = [];
        const baseLabel = baselineVersionNumber != null && newVersion.versionNumber != null ? `v${baselineVersionNumber} -> v${newVersion.versionNumber}` : `since ${sinceIso}`;
        parts.push(`${packKey} delta (${baseLabel}).`);
        if (changedSections.length) parts.push(`Changed: ${changedSections.map((c) => c.sectionId).join(", ")}.`);
        if (blockers.length) parts.push(`Blockers: ${blockers.map((b) => b.summary).join(" ")}`);
        if (highImpactEvents.length) {
          const top = highImpactEvents.slice(-6).map((e) => `${e.eventType}${e.payload?.rationale ? ` (${String(e.payload.rationale)})` : ""}`);
          parts.push(`Events: ${top.join("; ")}.`);
        }
        if (conflictState?.lastPredictedAt) parts.push(`Conflicts last predicted at: ${conflictState.lastPredictedAt}.`);
        return parts.join(" ");
      })();
      const omittedSections = [];
      if (eventsRaw.length >= limit) {
        omittedSections.push("events:limit_cap");
      }
      if (conflictState?.truncated) {
        omittedSections.push("conflicts:partial_coverage");
      }
      const clipReason = omittedSections.length > 0 ? "budget_clipped" : null;
      return {
        packKey,
        packType,
        since: {
          sinceVersionId: sinceVersionId || null,
          sinceTimestamp: sinceTimestamp || sinceIso,
          baselineVersionId,
          baselineVersionNumber,
          baselineCreatedAt
        },
        newVersion,
        changedSections,
        highImpactEvents,
        blockers,
        conflicts: conflictState,
        decisionState: {
          recommendedExportLevel,
          reasons: decisionReasons
        },
        handoffSummary,
        clipReason,
        omittedSections: omittedSections.length ? omittedSections : null
      };
    },
    listCheckpoints(args = {}) {
      const limit = typeof args.limit === "number" ? Math.max(1, Math.min(500, Math.floor(args.limit))) : 100;
      const where = ["project_id = ?"];
      const params = [projectId];
      if (args.laneId) {
        where.push("lane_id = ?");
        params.push(args.laneId);
      }
      params.push(limit);
      const rows = db.all(
        `
          select id, lane_id, session_id, sha, diff_stat_json, pack_event_ids_json, created_at
          from checkpoints
          where ${where.join(" and ")}
          order by created_at desc
          limit ?
        `,
        params
      );
      return rows.map((row) => ({
        id: row.id,
        laneId: row.lane_id,
        sessionId: row.session_id,
        sha: row.sha,
        diffStat: (() => {
          try {
            return row.diff_stat_json ? JSON.parse(row.diff_stat_json) : { insertions: 0, deletions: 0, filesChanged: 0, files: [] };
          } catch {
            return { insertions: 0, deletions: 0, filesChanged: 0, files: [] };
          }
        })(),
        packEventIds: (() => {
          try {
            return row.pack_event_ids_json ? JSON.parse(row.pack_event_ids_json) : [];
          } catch {
            return [];
          }
        })(),
        createdAt: row.created_at
      }));
    },
    getPeerLanesContext(laneId) {
      const id = laneId.trim();
      if (!id) return "";
      try {
        const pack = readConflictPredictionPack(id);
        if (!pack) return "";
        const overlaps = Array.isArray(pack.overlaps) ? pack.overlaps : [];
        if (!overlaps.length) return "";
        const riskScore = (r) => {
          const n = r.trim().toLowerCase();
          if (n === "high") return 3;
          if (n === "medium") return 2;
          if (n === "low") return 1;
          return 0;
        };
        const peers = overlaps.filter((ov) => ov && ov.peerId != null).map((ov) => {
          const peerName = asString3(ov.peerName).trim() || asString3(ov.peerId).trim() || "unknown";
          const riskLevel = asString3(ov.riskLevel).trim() || "unknown";
          const files = Array.isArray(ov.files) ? ov.files.map((f) => asString3(typeof f === "string" ? f : f?.path).trim()).filter(Boolean) : [];
          return { peerName, riskLevel, files, score: riskScore(riskLevel) };
        }).filter((ov) => ov.score > 0 || ov.files.length > 0).sort((a, b) => b.score - a.score || b.files.length - a.files.length || a.peerName.localeCompare(b.peerName)).slice(0, 10);
        if (!peers.length) return "";
        const lines = ["## Peer Lanes Context", ""];
        for (const peer of peers) {
          const risk = ` | conflict risk: ${peer.riskLevel}`;
          const fileList = peer.files.length ? ` | overlapping files: ${peer.files.slice(0, 5).join(", ")}` : "";
          lines.push(`- **${peer.peerName}**${risk}${fileList}`);
        }
        return lines.join("\n");
      } catch {
        return "";
      }
    },
    async getLaneExport(args) {
      const laneId = args.laneId.trim();
      if (!laneId) throw new Error("laneId is required");
      const level = args.level;
      if (level !== "lite" && level !== "standard" && level !== "deep") {
        throw new Error(`Invalid export level: ${String(level)}`);
      }
      const lanes = await laneService.list({ includeArchived: true });
      const lane = lanes.find((entry) => entry.id === laneId);
      if (!lane) throw new Error(`Lane not found: ${laneId}`);
      const pack = this.getLanePack(laneId);
      if (!pack.exists || !pack.body.trim().length) {
        throw new Error("Lane pack is empty. Refresh deterministic packs first.");
      }
      const providerMode = projectConfigService.get().effective.providerMode ?? "guest";
      const { apiBaseUrl, remoteProjectId } = readGatewayMeta();
      const docsMeta = readContextDocMeta();
      const conflictRiskSummaryLines = buildLaneConflictRiskSummaryLines(laneId);
      const conflictState = deriveConflictStateForLane(laneId);
      const lanesById = new Map(lanes.map((l) => [l.id, l]));
      const lineage = computeLaneLineage({ laneId, lanesById });
      const requiredMerges = lane.parentLaneId ? [lane.parentLaneId] : [];
      const dependencyState = {
        requiredMerges,
        blockedByLanes: requiredMerges,
        mergeReadiness: computeMergeReadiness({
          requiredMerges,
          behindCount: lane.status.behind,
          conflictStatus: conflictState?.status ?? null
        })
      };
      const packRefreshAt = pack.deterministicUpdatedAt ?? null;
      const packRefreshAgeMs = (() => {
        if (!packRefreshAt) return null;
        const ts = Date.parse(packRefreshAt);
        if (!Number.isFinite(ts)) return null;
        return Math.max(0, Date.now() - ts);
      })();
      const predictionPack = readConflictPredictionPack(laneId);
      const lastConflictRefreshAt = asString3(predictionPack?.lastRecomputedAt).trim() || asString3(predictionPack?.generatedAt).trim() || null;
      const lastConflictRefreshAgeMs = (() => {
        if (!lastConflictRefreshAt) return null;
        const ts = Date.parse(lastConflictRefreshAt);
        if (!Number.isFinite(ts)) return null;
        return Math.max(0, Date.now() - ts);
      })();
      const ttlMs = Number(predictionPack?.stalePolicy?.ttlMs ?? NaN);
      const staleTtlMs = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 5 * 6e4;
      const predictionStale = lastConflictRefreshAgeMs != null ? lastConflictRefreshAgeMs > staleTtlMs : null;
      const staleReason = predictionStale && lastConflictRefreshAgeMs != null ? `lastConflictRefreshAgeMs=${lastConflictRefreshAgeMs} ttlMs=${staleTtlMs}` : null;
      const activeConflictPackKeys = (() => {
        const out = [];
        if (predictionPack?.status) out.push(`conflict:${laneId}:${lane.baseRef}`);
        const overlaps = Array.isArray(predictionPack?.overlaps) ? predictionPack.overlaps : [];
        const score = (v) => v === "high" ? 3 : v === "medium" ? 2 : v === "low" ? 1 : 0;
        const peers = overlaps.filter((ov) => ov && ov.peerId != null).map((ov) => ({
          peerId: asString3(ov.peerId).trim(),
          riskLevel: normalizeRiskLevel(asString3(ov.riskLevel)) ?? "none",
          fileCount: Array.isArray(ov.files) ? ov.files.length : 0
        })).filter((ov) => ov.peerId.length).sort((a, b) => score(b.riskLevel) - score(a.riskLevel) || b.fileCount - a.fileCount || a.peerId.localeCompare(b.peerId)).slice(0, 6);
        for (const peer of peers) out.push(`conflict:${laneId}:${peer.peerId}`);
        return uniqueSorted(out);
      })();
      const orchestratorSummary = (() => {
        let completionSignal = "in-progress";
        if (lane.status.ahead === 0) {
          completionSignal = "not-started";
        } else if (conflictState?.status === "conflict-active") {
          completionSignal = "blocked";
        } else if (lane.status.ahead > 0 && !lane.status.dirty && conflictState?.status === "merge-ready") {
          completionSignal = "review-ready";
        }
        const touchedFiles = [];
        const keyFilesRe = /\|\s*`([^`]+)`/g;
        let kfMatch;
        const bodyText = pack.body ?? "";
        const keyFilesStart = bodyText.indexOf("## Key Files");
        if (keyFilesStart !== -1) {
          const keyFilesSection = bodyText.slice(keyFilesStart, bodyText.indexOf("\n## ", keyFilesStart + 1) >>> 0 || bodyText.length);
          while ((kfMatch = keyFilesRe.exec(keyFilesSection)) !== null) {
            const fp = kfMatch[1].trim();
            if (fp.length > 0 && !touchedFiles.includes(fp)) touchedFiles.push(fp);
          }
        }
        const peerOverlaps = (Array.isArray(predictionPack?.overlaps) ? predictionPack.overlaps : []).filter((ov) => ov && ov.peerId).slice(0, 10).map((ov) => ({
          peerId: String(ov.peerId ?? "").trim(),
          files: Array.isArray(ov.files) ? ov.files.map(String).slice(0, 20) : [],
          risk: normalizeRiskLevel(String(ov.riskLevel ?? "")) ?? "none"
        })).filter((ov) => ov.peerId.length > 0);
        const blockers = [];
        if (lane.status.dirty) blockers.push("dirty working tree");
        if (conflictState?.status === "conflict-active") blockers.push("active merge conflict");
        if (conflictState?.status === "conflict-predicted") blockers.push("predicted conflicts with peer lanes");
        if (lane.status.behind > 0) blockers.push(`behind base by ${lane.status.behind} commits`);
        return {
          laneId,
          completionSignal,
          touchedFiles: touchedFiles.slice(0, 50),
          peerOverlaps,
          suggestedMergeOrder: null,
          blockers
        };
      })();
      const manifest = {
        schema: "ade.manifest.lane.v1",
        projectId,
        laneId,
        laneName: lane.name,
        laneType: lane.laneType,
        worktreePath: lane.worktreePath,
        branchRef: lane.branchRef,
        baseRef: lane.baseRef,
        contextFingerprint: docsMeta.contextFingerprint,
        contextVersion: docsMeta.contextVersion,
        lastDocsRefreshAt: docsMeta.lastDocsRefreshAt,
        ...docsMeta.docsStaleReason ? { docsStaleReason: docsMeta.docsStaleReason } : {},
        lineage,
        mergeConstraints: {
          requiredMerges,
          blockedByLanes: requiredMerges,
          mergeReadiness: dependencyState.mergeReadiness ?? "unknown"
        },
        branchState: {
          baseRef: lane.baseRef,
          headRef: lane.branchRef,
          headSha: pack.lastHeadSha ?? null,
          lastPackRefreshAt: packRefreshAt,
          isEditProtected: lane.isEditProtected,
          packStale: packRefreshAgeMs != null ? packRefreshAgeMs > 10 * 6e4 : null,
          ...packRefreshAgeMs != null && packRefreshAgeMs > 10 * 6e4 ? { packStaleReason: `lastPackRefreshAgeMs=${packRefreshAgeMs}` } : {}
        },
        conflicts: {
          activeConflictPackKeys,
          unresolvedPairCount: conflictState?.unresolvedPairCount ?? 0,
          lastConflictRefreshAt,
          lastConflictRefreshAgeMs,
          ...predictionPack?.truncated != null ? { truncated: Boolean(predictionPack.truncated) } : {},
          ...asString3(predictionPack?.strategy).trim() ? { strategy: asString3(predictionPack?.strategy).trim() } : {},
          ...Number.isFinite(Number(predictionPack?.pairwisePairsComputed)) ? { pairwisePairsComputed: Number(predictionPack?.pairwisePairsComputed) } : {},
          ...Number.isFinite(Number(predictionPack?.pairwisePairsTotal)) ? { pairwisePairsTotal: Number(predictionPack?.pairwisePairsTotal) } : {},
          predictionStale,
          predictionStalenessMs: lastConflictRefreshAgeMs,
          stalePolicy: { ttlMs: staleTtlMs },
          ...staleReason ? { staleReason } : {},
          unresolvedResolutionState: null
        },
        orchestratorSummary
      };
      const graph = buildGraphEnvelope(
        [
          {
            relationType: "depends_on",
            targetPackKey: "project",
            targetPackType: "project",
            rationale: "Lane export depends on project context."
          },
          ...lane.parentLaneId ? [
            {
              relationType: "blocked_by",
              targetPackKey: `lane:${lane.parentLaneId}`,
              targetPackType: "lane",
              targetLaneId: lane.parentLaneId,
              rationale: "Stacked lane depends on parent lane landing first."
            },
            {
              relationType: "merges_into",
              targetPackKey: `lane:${lane.parentLaneId}`,
              targetPackType: "lane",
              targetLaneId: lane.parentLaneId,
              rationale: "Stacked lane merges into parent lane first."
            }
          ] : [
            {
              relationType: "merges_into",
              targetPackKey: `lane:${lineage.baseLaneId ?? laneId}`,
              targetPackType: "lane",
              targetLaneId: lineage.baseLaneId ?? laneId,
              rationale: "Lane merges into base lane."
            }
          ]
        ]
      );
      return buildLaneExport({
        level,
        projectId,
        laneId,
        laneName: lane.name,
        branchRef: lane.branchRef,
        baseRef: lane.baseRef,
        headSha: pack.lastHeadSha ?? null,
        pack,
        providerMode,
        apiBaseUrl,
        remoteProjectId,
        graph,
        manifest,
        dependencyState,
        conflictState,
        markers: {
          taskSpecStart: ADE_TASK_SPEC_START,
          taskSpecEnd: ADE_TASK_SPEC_END,
          intentStart: ADE_INTENT_START,
          intentEnd: ADE_INTENT_END,
          todosStart: ADE_TODOS_START,
          todosEnd: ADE_TODOS_END,
          narrativeStart: ADE_NARRATIVE_START,
          narrativeEnd: ADE_NARRATIVE_END
        },
        conflictRiskSummaryLines
      });
    },
    async getProjectExport(args) {
      const level = args.level;
      if (level !== "lite" && level !== "standard" && level !== "deep") {
        throw new Error(`Invalid export level: ${String(level)}`);
      }
      const pack = this.getProjectPack();
      const providerMode = projectConfigService.get().effective.providerMode ?? "guest";
      const { apiBaseUrl, remoteProjectId } = readGatewayMeta();
      const docsMeta = readContextDocMeta();
      const lanes = await laneService.list({ includeArchived: false });
      const lanesById = new Map(lanes.map((lane) => [lane.id, lane]));
      const lanesTotal = lanes.length;
      const maxIncluded = level === "lite" ? 10 : level === "standard" ? 25 : 80;
      const included = [...lanes].filter((lane) => !lane.archivedAt).sort((a, b) => a.stackDepth - b.stackDepth || a.name.localeCompare(b.name)).slice(0, maxIncluded);
      const laneEntries = included.map((lane) => {
        const lineage = computeLaneLineage({ laneId: lane.id, lanesById });
        const requiredMerges = lane.parentLaneId ? [lane.parentLaneId] : [];
        const conflictState = deriveConflictStateForLane(lane.id);
        const mergeReadiness = computeMergeReadiness({
          requiredMerges,
          behindCount: lane.status.behind,
          conflictStatus: conflictState?.status ?? null
        });
        const packRow = getPackIndexRow(`lane:${lane.id}`);
        const packRefreshAt = packRow?.deterministic_updated_at ?? null;
        const packRefreshAgeMs = (() => {
          if (!packRefreshAt) return null;
          const ts = Date.parse(packRefreshAt);
          if (!Number.isFinite(ts)) return null;
          return Math.max(0, Date.now() - ts);
        })();
        return {
          laneId: lane.id,
          laneName: lane.name,
          laneType: lane.laneType,
          branchRef: lane.branchRef,
          baseRef: lane.baseRef,
          worktreePath: lane.worktreePath,
          isEditProtected: Boolean(lane.isEditProtected),
          status: lane.status,
          lineage,
          mergeConstraints: {
            requiredMerges,
            blockedByLanes: requiredMerges,
            mergeReadiness
          },
          branchState: {
            baseRef: lane.baseRef,
            headRef: lane.branchRef,
            headSha: null,
            lastPackRefreshAt: packRefreshAt,
            isEditProtected: lane.isEditProtected,
            packStale: packRefreshAgeMs != null ? packRefreshAgeMs > 10 * 6e4 : null,
            ...packRefreshAgeMs != null && packRefreshAgeMs > 10 * 6e4 ? { packStaleReason: `lastPackRefreshAgeMs=${packRefreshAgeMs}` } : {}
          },
          conflictState
        };
      });
      const manifest = {
        schema: "ade.manifest.project.v1",
        projectId,
        generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
        contextFingerprint: docsMeta.contextFingerprint,
        contextVersion: docsMeta.contextVersion,
        lastDocsRefreshAt: docsMeta.lastDocsRefreshAt,
        ...docsMeta.docsStaleReason ? { docsStaleReason: docsMeta.docsStaleReason } : {},
        lanesTotal,
        lanesIncluded: included.length,
        lanesOmitted: Math.max(0, lanesTotal - included.length),
        lanes: laneEntries
      };
      const graph = buildGraphEnvelope(
        laneEntries.map((lane) => ({
          relationType: "parent_of",
          targetPackKey: `lane:${lane.laneId}`,
          targetPackType: "lane",
          targetLaneId: lane.laneId,
          targetBranch: lane.branchRef,
          rationale: "Project contains lane context."
        }))
      );
      return buildProjectExport({ level, projectId, pack, providerMode, apiBaseUrl, remoteProjectId, graph, manifest });
    },
    async getConflictExport(args) {
      const laneId = args.laneId.trim();
      if (!laneId) throw new Error("laneId is required");
      const peerLaneId = args.peerLaneId?.trim() || null;
      const level = args.level;
      if (level !== "lite" && level !== "standard" && level !== "deep") {
        throw new Error(`Invalid export level: ${String(level)}`);
      }
      const lane = laneService.getLaneBaseAndBranch(laneId);
      const peerKey = peerLaneId ?? lane.baseRef;
      const packKey = `conflict:${laneId}:${peerKey}`;
      const peerLabel = peerLaneId ? `lane:${peerLaneId}` : `base:${lane.baseRef}`;
      const pack = this.getConflictPack({ laneId, peerLaneId });
      const providerMode = projectConfigService.get().effective.providerMode ?? "guest";
      const { apiBaseUrl, remoteProjectId } = readGatewayMeta();
      const predictionPack = readConflictPredictionPack(laneId);
      const matrix = Array.isArray(predictionPack?.matrix) ? predictionPack.matrix : [];
      const entry = peerLaneId == null ? matrix.find((m) => asString3(m.laneAId).trim() === laneId && asString3(m.laneBId).trim() === laneId) ?? null : matrix.find((m) => {
        const a = asString3(m.laneAId).trim();
        const b = asString3(m.laneBId).trim();
        return a === laneId && b === peerLaneId || a === peerLaneId && b === laneId;
      }) ?? null;
      const ttlMs = Number(predictionPack?.stalePolicy?.ttlMs ?? NaN);
      const staleTtlMs = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 5 * 6e4;
      const nowMs = Date.now();
      const predictionAt = asString3(entry?.computedAt).trim() || asString3(predictionPack?.predictionAt).trim() || asString3(predictionPack?.status?.lastPredictedAt).trim() || null;
      const predictionAgeMs = (() => {
        if (!predictionAt) return null;
        const ts = Date.parse(predictionAt);
        if (!Number.isFinite(ts)) return null;
        return Math.max(0, nowMs - ts);
      })();
      const predictionStale = predictionAgeMs != null ? predictionAgeMs > staleTtlMs : null;
      const staleReason = predictionStale && predictionAgeMs != null ? `predictionAgeMs=${predictionAgeMs} ttlMs=${staleTtlMs}` : null;
      const openConflictSummaries = (() => {
        const raw = Array.isArray(predictionPack?.openConflictSummaries) ? predictionPack.openConflictSummaries : null;
        if (raw) {
          return raw.map((s) => {
            const riskLevel = normalizeRiskLevel(asString3(s.riskLevel)) ?? "none";
            const lastSeenAt = asString3(s.lastSeenAt).trim() || null;
            const lastSeenAgeMs = (() => {
              if (!lastSeenAt) return null;
              const ts = Date.parse(lastSeenAt);
              if (!Number.isFinite(ts)) return null;
              return Math.max(0, nowMs - ts);
            })();
            return {
              peerId: s.peerId ?? null,
              peerLabel: asString3(s.peerLabel).trim() || "unknown",
              riskLevel,
              fileCount: Number.isFinite(Number(s.fileCount)) ? Number(s.fileCount) : 0,
              lastSeenAt,
              lastSeenAgeMs,
              riskSignals: Array.isArray(s.riskSignals) ? s.riskSignals.map((v) => String(v)) : []
            };
          }).slice(0, 12);
        }
        const overlaps = Array.isArray(predictionPack?.overlaps) ? predictionPack.overlaps : [];
        const summaries = [];
        for (const ov of overlaps) {
          const peerId = ov.peerId ?? null;
          const peerLabel2 = peerId ? `lane:${peerId}` : `base:${lane.baseRef}`;
          const riskLevel = normalizeRiskLevel(asString3(ov.riskLevel)) ?? "none";
          const fileCount = Array.isArray(ov.files) ? ov.files.length : 0;
          const signals = [];
          if (riskLevel === "high") signals.push("high_risk");
          if (fileCount > 0) signals.push("overlap_files");
          if (predictionPack?.truncated) signals.push("partial_coverage");
          summaries.push({
            peerId,
            peerLabel: peerLabel2,
            riskLevel,
            fileCount,
            lastSeenAt: null,
            lastSeenAgeMs: null,
            riskSignals: signals
          });
        }
        return summaries.slice(0, 12);
      })();
      const lineage = {
        schema: "ade.conflictLineage.v1",
        laneId,
        peerKey,
        predictionAt,
        predictionAgeMs,
        predictionStale,
        ...staleReason ? { staleReason } : {},
        lastRecomputedAt: asString3(predictionPack?.lastRecomputedAt).trim() || asString3(predictionPack?.generatedAt).trim() || null,
        truncated: predictionPack?.truncated != null ? Boolean(predictionPack.truncated) : null,
        strategy: asString3(predictionPack?.strategy).trim() || null,
        pairwisePairsComputed: Number.isFinite(Number(predictionPack?.pairwisePairsComputed)) ? Number(predictionPack?.pairwisePairsComputed) : null,
        pairwisePairsTotal: Number.isFinite(Number(predictionPack?.pairwisePairsTotal)) ? Number(predictionPack?.pairwisePairsTotal) : null,
        stalePolicy: { ttlMs: staleTtlMs },
        openConflictSummaries,
        unresolvedResolutionState: await readGitConflictState(laneId).catch(() => null)
      };
      const graph = buildGraphEnvelope(
        [
          {
            relationType: "depends_on",
            targetPackKey: `lane:${laneId}`,
            targetPackType: "lane",
            targetLaneId: laneId,
            targetBranch: lane.branchRef,
            targetHeadCommit: pack.lastHeadSha ?? null,
            rationale: "Conflict export depends on lane pack."
          },
          ...peerLaneId ? [
            {
              relationType: "depends_on",
              targetPackKey: `lane:${peerLaneId}`,
              targetPackType: "lane",
              targetLaneId: peerLaneId,
              rationale: "Conflict export depends on peer lane pack."
            }
          ] : [
            {
              relationType: "shares_base",
              targetPackKey: "project",
              targetPackType: "project",
              rationale: "Base conflicts are computed against project base ref."
            }
          ]
        ]
      );
      return buildConflictExport({
        level,
        projectId,
        packKey,
        laneId,
        peerLabel,
        pack,
        providerMode,
        apiBaseUrl,
        remoteProjectId,
        graph,
        lineage
      });
    },
    async getFeatureExport(args) {
      const featureKey = args.featureKey.trim();
      if (!featureKey) throw new Error("featureKey is required");
      const level = args.level;
      if (level !== "lite" && level !== "standard" && level !== "deep") {
        throw new Error(`Invalid export level: ${String(level)}`);
      }
      const pack = this.getFeaturePack(featureKey);
      const packKey = `feature:${featureKey}`;
      const header = {
        schema: CONTEXT_HEADER_SCHEMA_V1,
        contractVersion: CONTEXT_CONTRACT_VERSION,
        projectId,
        packKey,
        packType: "feature",
        exportLevel: level
      };
      const content = pack.exists ? pack.body : "";
      const approxTokens = Math.ceil(content.length / 4);
      const maxTokens = level === "lite" ? 3e4 : level === "standard" ? 6e4 : 12e4;
      const truncated = approxTokens > maxTokens;
      const finalContent = truncated ? content.slice(0, maxTokens * 4) : content;
      return {
        packKey,
        packType: "feature",
        level,
        header,
        content: finalContent,
        approxTokens: Math.ceil(finalContent.length / 4),
        maxTokens,
        truncated,
        warnings: truncated ? ["Feature pack content was truncated to fit token budget."] : []
      };
    },
    async getPlanExport(args) {
      const laneId = args.laneId.trim();
      if (!laneId) throw new Error("laneId is required");
      const level = args.level;
      if (level !== "lite" && level !== "standard" && level !== "deep") {
        throw new Error(`Invalid export level: ${String(level)}`);
      }
      const pack = this.getPlanPack(laneId);
      const packKey = `plan:${laneId}`;
      const header = {
        schema: CONTEXT_HEADER_SCHEMA_V1,
        contractVersion: CONTEXT_CONTRACT_VERSION,
        projectId,
        packKey,
        packType: "plan",
        exportLevel: level
      };
      const content = pack.exists ? pack.body : "";
      const approxTokens = Math.ceil(content.length / 4);
      const maxTokens = level === "lite" ? 3e4 : level === "standard" ? 6e4 : 12e4;
      const truncated = approxTokens > maxTokens;
      const finalContent = truncated ? content.slice(0, maxTokens * 4) : content;
      return {
        packKey,
        packType: "plan",
        level,
        header,
        content: finalContent,
        approxTokens: Math.ceil(finalContent.length / 4),
        maxTokens,
        truncated,
        warnings: truncated ? ["Plan pack content was truncated to fit token budget."] : []
      };
    },
    async getMissionExport(args) {
      const missionId = args.missionId.trim();
      if (!missionId) throw new Error("missionId is required");
      const level = args.level;
      if (level !== "lite" && level !== "standard" && level !== "deep") {
        throw new Error(`Invalid export level: ${String(level)}`);
      }
      const pack = this.getMissionPack(missionId);
      const packKey = `mission:${missionId}`;
      const header = {
        schema: CONTEXT_HEADER_SCHEMA_V1,
        contractVersion: CONTEXT_CONTRACT_VERSION,
        projectId,
        packKey,
        packType: "mission",
        exportLevel: level
      };
      const content = pack.exists ? pack.body : "";
      const approxTokens = Math.ceil(content.length / 4);
      const maxTokens = level === "lite" ? 3e4 : level === "standard" ? 6e4 : 12e4;
      const truncated = approxTokens > maxTokens;
      const finalContent = truncated ? content.slice(0, maxTokens * 4) : content;
      return {
        packKey,
        packType: "mission",
        level,
        header,
        content: finalContent,
        approxTokens: Math.ceil(finalContent.length / 4),
        maxTokens,
        truncated,
        warnings: truncated ? ["Mission pack content was truncated to fit token budget."] : []
      };
    },
    recordEvent(args) {
      return createPackEvent(args);
    }
  };
}

// ../desktop/src/main/services/conflicts/conflictService.ts
var import_node_crypto6 = require("crypto");
var import_node_child_process2 = require("child_process");
var import_node_fs8 = __toESM(require("fs"), 1);
var import_node_path7 = __toESM(require("path"), 1);
var import_node_os = __toESM(require("os"), 1);

// ../desktop/src/main/utils/redaction.ts
function redactText(text) {
  let output = text;
  output = output.replace(
    /((?:api[_-]?key|token|secret|password)\s*[:=]\s*)(["']?)[^\s"']{6,}\2/gi,
    "$1<redacted>"
  );
  output = output.replace(
    /-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/g,
    "<redacted-private-key>"
  );
  output = output.replace(
    /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g,
    "<redacted-token>"
  );
  return output;
}
function redactSecretsDeep(value, maxDepth = 8) {
  const seen = /* @__PURE__ */ new WeakSet();
  const walk = (v, depth) => {
    if (depth > maxDepth) return v;
    if (typeof v === "string") return redactText(v);
    if (v == null || typeof v !== "object") return v;
    if (seen.has(v)) return v;
    seen.add(v);
    if (Array.isArray(v)) {
      return v.map((entry) => walk(entry, depth + 1));
    }
    const record = v;
    const out = {};
    for (const [k, entry] of Object.entries(record)) {
      out[k] = walk(entry, depth + 1);
    }
    return out;
  };
  return walk(value, 0);
}

// ../desktop/src/main/services/conflicts/conflictService.ts
var RISK_SCORE = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3
};
var FULL_MATRIX_MAX_LANES = 15;
var PREFILTER_MAX_PEERS_PER_LANE = 6;
var PREFILTER_MAX_GLOBAL_PAIRS = 800;
var PREFILTER_MAX_TOUCHED_FILES = 800;
var STALE_MS = 5 * 6e4;
var EXTERNAL_DIFF_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
function isRecord2(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function asString2(value) {
  return typeof value === "string" ? value : "";
}
function safeJsonArray(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
function toIsoPlusMinutes(minutes) {
  return new Date(Date.now() + minutes * 6e4).toISOString();
}
function pairKey(a, b) {
  return a < b ? `${a}::${b}` : `${b}::${a}`;
}
function matrixEntryKey(entry) {
  return pairKey(entry.laneAId, entry.laneBId);
}
function normalizeConflictType2(value) {
  const normalized = value.trim().toLowerCase();
  if (normalized.includes("rename")) return "rename";
  if (normalized.includes("delete")) return "delete";
  if (normalized.includes("add")) return "add";
  return "content";
}
function riskFromPrediction(status, overlapCount, conflictCount) {
  if (status === "conflict" || conflictCount > 0) return "high";
  if (overlapCount === 0) return "none";
  if (overlapCount <= 2) return "low";
  if (overlapCount <= 6) return "medium";
  return "high";
}
function isStalePrediction(predictedAt) {
  if (!predictedAt) return true;
  const ts = Date.parse(predictedAt);
  if (Number.isNaN(ts)) return true;
  return Date.now() - ts > STALE_MS;
}
function extractOverlapFiles(row) {
  if (!row) return [];
  const overlaps = safeJsonArray(row.overlap_files_json ?? null);
  const conflicting = safeJsonArray(row.conflicting_files_json ?? null);
  return uniqueSorted2([
    ...overlaps.map((value) => value.trim()).filter(Boolean),
    ...conflicting.map((value) => value.path?.trim() ?? "").filter(Boolean)
  ]);
}
function parseDiffNameOnly2(stdout) {
  return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}
async function readHeadSha(cwd, ref = "HEAD") {
  return (await runGitOrThrow(["rev-parse", ref], { cwd, timeoutMs: 1e4 })).trim();
}
async function readMergeBase(cwd, refA, refB) {
  return (await runGitOrThrow(["merge-base", refA, refB], { cwd, timeoutMs: 1e4 })).trim();
}
async function readTouchedFiles(cwd, mergeBase, headSha) {
  const res = await runGit(["diff", "--name-only", `${mergeBase}..${headSha}`], { cwd, timeoutMs: 15e3 });
  if (res.exitCode !== 0) return /* @__PURE__ */ new Set();
  return new Set(parseDiffNameOnly2(res.stdout));
}
async function readDiffNumstat(cwd, mergeBase, headSha) {
  const res = await runGit(["diff", "--numstat", `${mergeBase}..${headSha}`], {
    cwd,
    timeoutMs: 15e3
  });
  if (res.exitCode !== 0) {
    return {
      files: /* @__PURE__ */ new Set(),
      insertions: 0,
      deletions: 0
    };
  }
  const files = /* @__PURE__ */ new Set();
  let insertions = 0;
  let deletions = 0;
  for (const rawLine of res.stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const [insRaw, delRaw, file] = line.split(/\t/);
    if (!file) continue;
    files.add(file);
    const ins = Number(insRaw);
    const del = Number(delRaw);
    if (Number.isFinite(ins)) insertions += ins;
    if (Number.isFinite(del)) deletions += del;
  }
  return { files, insertions, deletions };
}
function uniqueSorted2(values) {
  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}
function safeSegment(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return "untitled";
  return trimmed.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
}
function latestPerPair(rows) {
  const out = /* @__PURE__ */ new Map();
  for (const row of rows) {
    const key = row.lane_b_id == null ? `base:${row.lane_a_id}` : `pair:${pairKey(row.lane_a_id, row.lane_b_id)}`;
    if (!out.has(key)) {
      out.set(key, row);
      continue;
    }
    const current = out.get(key);
    if (row.predicted_at > current.predicted_at) {
      out.set(key, row);
    }
  }
  return out;
}
function computeStatusValue(args) {
  if (args.hasActiveConflict) return "conflict-active";
  if (!args.hasBasePrediction) return "unknown";
  if (args.hasPredictedConflict) return "conflict-predicted";
  if (args.behindCount > 0) return "behind-base";
  return "merge-ready";
}
function laneById(lanes) {
  return new Map(lanes.map((lane) => [lane.id, lane]));
}
function buildConflictFiles(conflicting, overlapFiles) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const file of conflicting) {
    const clean = file.path?.trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push({
      path: clean,
      conflictType: normalizeConflictType2(file.conflictType ?? "content"),
      markerPreview: file.markerPreview ?? ""
    });
  }
  for (const path16 of overlapFiles) {
    const clean = path16.trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push({
      path: clean,
      conflictType: "content",
      markerPreview: ""
    });
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}
function dedupeChips(chips) {
  const map = /* @__PURE__ */ new Map();
  for (const chip of chips) {
    const key = `${chip.laneId}:${chip.peerId ?? "base"}:${chip.kind}`;
    const existing = map.get(key);
    if (!existing || chip.overlapCount > existing.overlapCount) {
      map.set(key, chip);
    }
  }
  return Array.from(map.values());
}
function rowToProposal(row) {
  return {
    id: row.id,
    laneId: row.lane_id,
    peerLaneId: row.peer_lane_id,
    predictionId: row.prediction_id,
    source: row.source,
    confidence: row.confidence,
    explanation: row.explanation ?? "",
    diffPatch: row.diff_patch,
    status: row.status,
    jobId: row.job_id,
    artifactId: row.artifact_id,
    appliedOperationId: row.applied_operation_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
function safeParseMetadata2(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}
function writePatchFile(content) {
  const filePath = import_node_path7.default.join(import_node_os.default.tmpdir(), `ade-proposal-${(0, import_node_crypto6.randomUUID)()}.patch`);
  import_node_fs8.default.writeFileSync(filePath, content, "utf8");
  return filePath;
}
function extractPathsFromUnifiedDiff(diffPatch) {
  const paths = /* @__PURE__ */ new Set();
  for (const line of diffPatch.split(/\r?\n/)) {
    if (line.startsWith("+++ b/")) {
      const p = line.slice("+++ b/".length).trim();
      if (p && p !== "/dev/null") paths.add(p);
    }
    if (line.startsWith("diff --git ")) {
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      const p = match?.[2]?.trim();
      if (p && p !== "/dev/null") paths.add(p);
    }
  }
  return Array.from(paths).sort((a, b) => a.localeCompare(b));
}
function extractCommitPathsFromUnifiedDiff(diffPatch) {
  const paths = /* @__PURE__ */ new Set();
  for (const line of diffPatch.split(/\r?\n/)) {
    if (line.startsWith("+++ b/")) {
      const p = line.slice("+++ b/".length).trim();
      if (p && p !== "/dev/null") paths.add(p);
      continue;
    }
    if (line.startsWith("--- a/")) {
      const p = line.slice("--- a/".length).trim();
      if (p && p !== "/dev/null") paths.add(p);
      continue;
    }
    if (line.startsWith("diff --git ")) {
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      const left = match?.[1]?.trim();
      const right = match?.[2]?.trim();
      if (left && left !== "/dev/null") paths.add(left);
      if (right && right !== "/dev/null") paths.add(right);
    }
  }
  return Array.from(paths).sort((a, b) => a.localeCompare(b));
}
function extractDiffPatchFromText(text) {
  const fence = text.match(/```diff\s*\n([\s\S]*?)\n```/i);
  if (fence?.[1]) {
    const raw = fence[1].trim();
    return raw.length ? `${raw}
` : "";
  }
  return "";
}
function stripDiffFence(text) {
  return text.replace(/```diff\s*\n[\s\S]*?\n```/gi, "").trim();
}
function extractFirstJsonObject(text) {
  const raw = text.trim();
  if (!raw) return null;
  if (raw.startsWith("{") && raw.endsWith("}")) return raw;
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    const inner = fenced[1].trim();
    if (inner.startsWith("{") && inner.endsWith("}")) return inner;
  }
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) {
    const candidate = raw.slice(first, last + 1).trim();
    if (candidate.startsWith("{") && candidate.endsWith("}")) return candidate;
  }
  return null;
}
function parseStructuredObject(text) {
  const candidate = extractFirstJsonObject(text);
  if (!candidate) return null;
  try {
    const parsed = JSON.parse(candidate);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}
function normalizeConfidence(value) {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return null;
  if (raw < 0) return 0;
  if (raw > 1) return 1;
  return raw;
}
function parseHunksFromDiff(diffText, kind) {
  const hunks = [];
  for (const line of diffText.split(/\r?\n/)) {
    const m = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
    if (!m) continue;
    hunks.push({
      kind,
      header: line.trim(),
      baseStart: Number(m[1] ?? 0) || 0,
      baseCount: Number(m[2] ?? 1) || 1,
      otherStart: Number(m[3] ?? 0) || 0,
      otherCount: Number(m[4] ?? 1) || 1
    });
  }
  return hunks;
}
function makeContextSide(args) {
  const trimmed = args.excerpt.trim();
  return {
    side: args.side,
    ref: args.ref,
    blobSha: args.blobSha,
    excerpt: trimmed,
    excerptFormat: trimmed.length ? "diff_hunks" : "unavailable",
    truncated: Boolean(args.truncated),
    ...args.fallbackReason ? { omittedReasonTags: [args.fallbackReason] } : {}
  };
}
function deletePatchFile(filePath) {
  try {
    import_node_fs8.default.unlinkSync(filePath);
  } catch {
  }
}
function createConflictService({
  db,
  logger,
  projectId,
  projectRoot,
  laneService,
  projectConfigService,
  aiIntegrationService,
  packService,
  operationService,
  conflictPacksDir,
  onEvent
}) {
  const pairLocks = /* @__PURE__ */ new Map();
  const pairQueued = /* @__PURE__ */ new Set();
  const rebaseDismissed = /* @__PURE__ */ new Map();
  const rebaseDeferred = /* @__PURE__ */ new Map();
  const activeRebaseLanes = /* @__PURE__ */ new Set();
  try {
    const dismissRows = db.all(
      `select lane_id, dismissed_at from rebase_dismissed where project_id = ?`,
      [projectId]
    );
    for (const row of dismissRows) rebaseDismissed.set(row.lane_id, row.dismissed_at);
    const deferRows = db.all(
      `select lane_id, deferred_until from rebase_deferred where project_id = ?`,
      [projectId]
    );
    for (const row of deferRows) rebaseDeferred.set(row.lane_id, row.deferred_until);
  } catch {
  }
  const runSerializedPairTask = async (pairId, task) => {
    const active = pairLocks.get(pairId);
    if (active) {
      pairQueued.add(pairId);
      await active;
      if (!pairQueued.has(pairId)) return;
      pairQueued.delete(pairId);
    }
    const running = (async () => {
      await task();
    })().finally(() => {
      const current = pairLocks.get(pairId);
      if (current === running) {
        pairLocks.delete(pairId);
      }
    });
    pairLocks.set(pairId, running);
    await running;
    if (pairQueued.has(pairId)) {
      pairQueued.delete(pairId);
      await runSerializedPairTask(pairId, task);
    }
  };
  const listActiveLanes = async () => {
    const lanes = await laneService.list({ includeArchived: false });
    return lanes.filter((lane) => !lane.archivedAt);
  };
  const sha256 = (input) => (0, import_node_crypto6.createHash)("sha256").update(input).digest("hex");
  const preparedContexts = /* @__PURE__ */ new Map();
  const PREPARED_TTL_MS = 20 * 6e4;
  const cleanupPreparedContexts = () => {
    const cutoff = Date.now() - PREPARED_TTL_MS;
    for (const [digest, entry] of preparedContexts.entries()) {
      const ts = Date.parse(entry.preparedAt);
      const ms = Number.isFinite(ts) ? ts : Date.now();
      if (ms < cutoff) preparedContexts.delete(digest);
    }
  };
  const packsRootDir = conflictPacksDir ? import_node_path7.default.dirname(conflictPacksDir) : null;
  const resolvedPacksRootDir = packsRootDir ?? import_node_path7.default.join(projectRoot, ".ade", "packs");
  const projectPackPath = import_node_path7.default.join(resolvedPacksRootDir, "project_pack.md");
  const lanePackPath = (laneId) => import_node_path7.default.join(resolvedPacksRootDir, "lanes", laneId, "lane_pack.md");
  const conflictPackPath = (laneId, peerKey) => import_node_path7.default.join(resolvedPacksRootDir, "conflicts", "v2", `${laneId}__${safeSegment(peerKey)}.md`);
  const contextDocPaths = [
    import_node_path7.default.join(projectRoot, ".ade/context/PRD.ade.md"),
    import_node_path7.default.join(projectRoot, ".ade/context/ARCHITECTURE.ade.md"),
    import_node_path7.default.join(projectRoot, "docs/PRD.md")
  ];
  const toRepoRelativePath = (absPath) => {
    const rel = import_node_path7.default.relative(projectRoot, absPath).replace(/\\/g, "/");
    if (!rel || rel.startsWith("..")) return absPath.replace(/\\/g, "/");
    return rel;
  };
  const readLanePackBody = (laneId) => {
    const filePath = lanePackPath(laneId);
    if (!import_node_fs8.default.existsSync(filePath)) return null;
    try {
      const raw = import_node_fs8.default.readFileSync(filePath, "utf8");
      const trimmed = raw.trim();
      if (!trimmed) return null;
      return trimmed.length > 12e3 ? `${trimmed.slice(0, 12e3)}

\u2026(truncated)\u2026
` : trimmed;
    } catch {
      return null;
    }
  };
  const safeReadText = (absPath, maxBytes) => {
    try {
      const fd = import_node_fs8.default.openSync(absPath, "r");
      try {
        const buf = Buffer.alloc(maxBytes);
        const read = import_node_fs8.default.readSync(fd, buf, 0, maxBytes, 0);
        return buf.slice(0, Math.max(0, read)).toString("utf8");
      } finally {
        import_node_fs8.default.closeSync(fd);
      }
    } catch {
      return "";
    }
  };
  const externalRunsRootDir = import_node_path7.default.join(resolvedPacksRootDir, "external-resolver-runs");
  const buildExternalResolverPackRefs = (args) => {
    const refs = /* @__PURE__ */ new Map();
    const addRef = (ref) => {
      const key = `${ref.kind}:${ref.absPath}`;
      if (refs.has(key)) return;
      const absPath = import_node_path7.default.resolve(ref.absPath);
      refs.set(key, {
        ...ref,
        absPath,
        repoRelativePath: toRepoRelativePath(absPath),
        exists: import_node_fs8.default.existsSync(absPath)
      });
    };
    addRef({
      kind: "project_pack",
      laneId: null,
      peerLaneId: null,
      absPath: projectPackPath,
      required: true
    });
    const relevantLaneIds = uniqueSorted2([
      args.targetLaneId,
      args.cwdLaneId,
      ...args.integrationLaneId ? [args.integrationLaneId] : [],
      ...args.sourceLaneIds
    ]);
    for (const laneId of relevantLaneIds) {
      addRef({
        kind: "lane_pack",
        laneId,
        peerLaneId: null,
        absPath: lanePackPath(laneId),
        required: true
      });
    }
    for (const ctx of args.contexts) {
      const peerKey = (ctx.peerLaneId?.trim() || laneService.getLaneBaseAndBranch(ctx.laneId).baseRef || "").trim();
      if (!peerKey) continue;
      addRef({
        kind: "conflict_pack",
        laneId: ctx.laneId,
        peerLaneId: ctx.peerLaneId ?? null,
        absPath: conflictPackPath(ctx.laneId, peerKey),
        required: true
      });
    }
    for (const absPath of contextDocPaths) {
      addRef({
        kind: "project_doc",
        laneId: null,
        peerLaneId: null,
        absPath,
        required: false
      });
    }
    return [...refs.values()].sort((a, b) => {
      const rank = (value) => {
        if (value === "project_pack") return 1;
        if (value === "project_doc") return 2;
        if (value === "lane_pack") return 3;
        return 4;
      };
      const rankDelta = rank(a.kind) - rank(b.kind);
      if (rankDelta !== 0) return rankDelta;
      const laneDelta = (a.laneId ?? "").localeCompare(b.laneId ?? "");
      if (laneDelta !== 0) return laneDelta;
      const peerDelta = (a.peerLaneId ?? "").localeCompare(b.peerLaneId ?? "");
      if (peerDelta !== 0) return peerDelta;
      return a.absPath.localeCompare(b.absPath);
    });
  };
  const ensureExternalRunsDir = () => {
    import_node_fs8.default.mkdirSync(externalRunsRootDir, { recursive: true });
  };
  const resolveExternalResolverCommand = (provider) => {
    const snapshot = projectConfigService.get();
    const providers = isRecord2(snapshot.local.providers) ? snapshot.local.providers : isRecord2(snapshot.effective.providers) ? snapshot.effective.providers : {};
    const contextTools = isRecord2(providers.contextTools) ? providers.contextTools : {};
    const conflictResolvers = isRecord2(contextTools.conflictResolvers) ? contextTools.conflictResolvers : {};
    const providerEntry = isRecord2(conflictResolvers[provider]) ? conflictResolvers[provider] : {};
    return Array.isArray(providerEntry.command) ? providerEntry.command.map((entry) => String(entry)) : [];
  };
  const toRunSummary = (run) => ({
    runId: run.runId,
    provider: run.provider,
    status: run.status,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    targetLaneId: run.targetLaneId,
    sourceLaneIds: run.sourceLaneIds,
    cwdLaneId: run.cwdLaneId,
    integrationLaneId: run.integrationLaneId,
    summary: run.summary,
    patchPath: run.patchPath,
    logPath: run.logPath,
    insufficientContext: run.insufficientContext,
    contextGaps: run.contextGaps,
    warnings: run.warnings,
    committedAt: run.committedAt ?? null,
    commitSha: run.commitSha ?? null,
    commitMessage: run.commitMessage ?? null,
    error: run.error
  });
  const writeExternalRunRecord = (run) => {
    ensureExternalRunsDir();
    const runDir = import_node_path7.default.join(externalRunsRootDir, run.runId);
    import_node_fs8.default.mkdirSync(runDir, { recursive: true });
    import_node_fs8.default.writeFileSync(import_node_path7.default.join(runDir, "run.json"), `${JSON.stringify(run, null, 2)}
`, "utf8");
  };
  const readExternalRunRecord = (runId) => {
    const filePath = import_node_path7.default.join(externalRunsRootDir, runId, "run.json");
    if (!import_node_fs8.default.existsSync(filePath)) return null;
    try {
      const parsed = JSON.parse(import_node_fs8.default.readFileSync(filePath, "utf8"));
      if (!parsed || parsed.schema !== "ade.conflictExternalRun.v1") return null;
      return parsed;
    } catch {
      return null;
    }
  };
  const listExternalRunRecords = () => {
    if (!import_node_fs8.default.existsSync(externalRunsRootDir)) return [];
    const out = [];
    let entries = [];
    try {
      entries = import_node_fs8.default.readdirSync(externalRunsRootDir, { withFileTypes: true });
    } catch {
      return [];
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const run = readExternalRunRecord(entry.name);
      if (run) out.push(run);
    }
    out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return out;
  };
  const extractResolverSummary = (output) => {
    const normalized = output.replace(/\r\n/g, "\n");
    const markers = [
      /done\.?[\s\S]*?here'?s what (?:i|we) (?:changed|did)[:\s]*([\s\S]+)/i,
      /summary\s*:\s*([\s\S]+)/i
    ];
    for (const marker of markers) {
      const m = normalized.match(marker);
      if (!m?.[1]) continue;
      const clean = m[1].split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 6).join(" ");
      if (clean) return clean.length > 420 ? `${clean.slice(0, 419)}\u2026` : clean;
    }
    const tail = normalized.split("\n").slice(-10).map((line) => line.trim()).filter(Boolean).join(" ");
    if (!tail) return null;
    return tail.length > 420 ? `${tail.slice(0, 419)}\u2026` : tail;
  };
  const ensureRelativeRepoPath2 = (relPath) => {
    const normalized = relPath.trim().replace(/\\/g, "/");
    if (!normalized.length) throw new Error("File path is required");
    if (normalized.includes("\0")) throw new Error("Invalid file path");
    if (import_node_path7.default.isAbsolute(normalized)) throw new Error("Path must be repo-relative");
    if (normalized.startsWith("../") || normalized === ".." || normalized.includes("/../")) {
      throw new Error("Path escapes lane root");
    }
    return normalized;
  };
  const readGitConflictState = async (laneId) => {
    const lane = laneService.getLaneBaseAndBranch(laneId);
    const gitDirRes = await runGit(["rev-parse", "--absolute-git-dir"], { cwd: lane.worktreePath, timeoutMs: 1e4 });
    const gitDir = gitDirRes.exitCode === 0 ? gitDirRes.stdout.trim() : "";
    const hasRebase = gitDir.length > 0 && (import_node_fs8.default.existsSync(import_node_path7.default.join(gitDir, "rebase-apply")) || import_node_fs8.default.existsSync(import_node_path7.default.join(gitDir, "rebase-merge")));
    const hasMerge = gitDir.length > 0 && import_node_fs8.default.existsSync(import_node_path7.default.join(gitDir, "MERGE_HEAD"));
    const kind = hasRebase ? "rebase" : hasMerge ? "merge" : null;
    const unmergedRes = await runGit(["diff", "--name-only", "--diff-filter=U"], { cwd: lane.worktreePath, timeoutMs: 1e4 });
    const conflictedFiles = unmergedRes.exitCode === 0 ? parseDiffNameOnly2(unmergedRes.stdout).sort((a, b) => a.localeCompare(b)) : [];
    let mergeHeadSha = null;
    if (kind === "merge" && gitDir.length) {
      try {
        const raw = import_node_fs8.default.readFileSync(import_node_path7.default.join(gitDir, "MERGE_HEAD"), "utf8").trim();
        if (raw) mergeHeadSha = raw;
      } catch {
      }
    }
    const inProgress = kind != null;
    return {
      laneId,
      kind,
      inProgress,
      conflictedFiles,
      canContinue: inProgress && conflictedFiles.length === 0,
      canAbort: inProgress,
      mergeHeadSha
    };
  };
  const extractMarkerPreview = (laneId, relPath, warnings) => {
    const filePath = ensureRelativeRepoPath2(relPath);
    const lane = laneService.getLaneBaseAndBranch(laneId);
    const abs = import_node_path7.default.join(lane.worktreePath, filePath);
    const raw = safeReadText(abs, 48e3);
    if (!raw) return null;
    if (raw.includes("\0")) return null;
    const idx = raw.indexOf("<<<<<<<");
    if (idx < 0) {
      const trimmed = raw.trim();
      if (!trimmed) return null;
      const excerpt2 = trimmed.length > 2e3 ? `${trimmed.slice(0, 2e3)}
...(truncated)...
` : trimmed;
      if (trimmed.length > 2e3) warnings.push(`Marker preview truncated for ${filePath}.`);
      return excerpt2;
    }
    const start = Math.max(0, idx - 1600);
    const end = Math.min(raw.length, idx + 3200);
    const excerpt = raw.slice(start, end).trim();
    if (start > 0 || end < raw.length) warnings.push(`Marker preview excerpted for ${filePath}.`);
    return excerpt;
  };
  const getLatestRows = () => {
    const rows = db.all(
      `
        select
          id,
          lane_a_id,
          lane_b_id,
          status,
          conflicting_files_json,
          overlap_files_json,
          lane_a_sha,
          lane_b_sha,
          predicted_at,
          expires_at
        from conflict_predictions
        where project_id = ?
        order by predicted_at desc
      `,
      [projectId]
    );
    return latestPerPair(rows);
  };
  const getLatestBaseRow = (laneId) => {
    return db.get(
      `
        select
          id,
          lane_a_id,
          lane_b_id,
          status,
          conflicting_files_json,
          overlap_files_json,
          lane_a_sha,
          lane_b_sha,
          predicted_at,
          expires_at
        from conflict_predictions
        where project_id = ?
          and lane_a_id = ?
          and lane_b_id is null
        order by predicted_at desc
        limit 1
      `,
      [projectId, laneId]
    );
  };
  const getLatestPairRowsForLane = (laneId) => {
    return db.all(
      `
        select
          id,
          lane_a_id,
          lane_b_id,
          status,
          conflicting_files_json,
          overlap_files_json,
          lane_a_sha,
          lane_b_sha,
          predicted_at,
          expires_at
        from conflict_predictions
        where project_id = ?
          and lane_b_id is not null
          and (lane_a_id = ? or lane_b_id = ?)
        order by predicted_at desc
      `,
      [projectId, laneId, laneId]
    );
  };
  const upsertPrediction = (args) => {
    const id = (0, import_node_crypto6.randomUUID)();
    const predictedAt = (/* @__PURE__ */ new Date()).toISOString();
    const expiresAt = toIsoPlusMinutes(30);
    const conflictingFiles = args.conflictingFiles.map((file) => ({
      path: file.path,
      conflictType: file.conflictType
    }));
    const overlapFiles = uniqueSorted2(args.overlapFiles);
    db.run(
      `
        insert into conflict_predictions(
          id,
          project_id,
          lane_a_id,
          lane_b_id,
          status,
          conflicting_files_json,
          overlap_files_json,
          lane_a_sha,
          lane_b_sha,
          predicted_at,
          expires_at
        ) values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        id,
        projectId,
        args.laneAId,
        args.laneBId,
        args.status,
        JSON.stringify(conflictingFiles),
        JSON.stringify(overlapFiles),
        args.laneASha,
        args.laneBSha,
        predictedAt,
        expiresAt
      ]
    );
    if (args.laneBId == null) {
      db.run(
        `
          delete from conflict_predictions
          where project_id = ?
            and lane_a_id = ?
            and lane_b_id is null
            and id != ?
        `,
        [projectId, args.laneAId, id]
      );
    } else {
      db.run(
        `
          delete from conflict_predictions
          where project_id = ?
            and lane_a_id = ?
            and lane_b_id = ?
            and id != ?
        `,
        [projectId, args.laneAId, args.laneBId, id]
      );
    }
    return {
      id,
      laneAId: args.laneAId,
      laneBId: args.laneBId,
      status: args.status,
      conflictingFiles,
      overlapFiles,
      laneASha: args.laneASha,
      laneBSha: args.laneBSha,
      predictedAt
    };
  };
  const hasActiveConflict = async (lane) => {
    const res = await runGit(["ls-files", "-u"], { cwd: lane.worktreePath, timeoutMs: 8e3 });
    if (res.exitCode !== 0) return false;
    return res.stdout.trim().length > 0;
  };
  const predictLaneVsBase = async (lane) => {
    const laneHead = await readHeadSha(lane.worktreePath, "HEAD");
    const baseHead = await readHeadSha(projectRoot, lane.baseRef);
    const mergeBase = await readMergeBase(projectRoot, baseHead, laneHead);
    const merge = await runGitMergeTree({
      cwd: projectRoot,
      mergeBase,
      branchA: baseHead,
      branchB: laneHead,
      timeoutMs: 6e4
    });
    const [baseTouched, laneTouched] = await Promise.all([
      readTouchedFiles(projectRoot, mergeBase, baseHead),
      readTouchedFiles(projectRoot, mergeBase, laneHead)
    ]);
    const overlap = uniqueSorted2(Array.from(laneTouched).filter((file) => baseTouched.has(file)));
    const conflicts = merge.conflicts.map((conflict) => ({
      path: conflict.path,
      conflictType: conflict.conflictType,
      markerPreview: conflict.markerPreview
    }));
    const status = conflicts.length > 0 ? "conflict" : merge.exitCode === 0 ? "clean" : "unknown";
    return upsertPrediction({
      laneAId: lane.id,
      laneBId: null,
      status,
      conflictingFiles: conflicts,
      overlapFiles: overlap,
      laneASha: laneHead,
      laneBSha: baseHead
    });
  };
  const predictPairwise = async (laneA, laneB) => {
    const laneAHead = await readHeadSha(laneA.worktreePath, "HEAD");
    const laneBHead = await readHeadSha(laneB.worktreePath, "HEAD");
    const mergeBase = await readMergeBase(projectRoot, laneAHead, laneBHead);
    const merge = await runGitMergeTree({
      cwd: projectRoot,
      mergeBase,
      branchA: laneAHead,
      branchB: laneBHead,
      timeoutMs: 6e4
    });
    const [aTouched, bTouched] = await Promise.all([
      readTouchedFiles(projectRoot, mergeBase, laneAHead),
      readTouchedFiles(projectRoot, mergeBase, laneBHead)
    ]);
    const overlap = uniqueSorted2(Array.from(aTouched).filter((file) => bTouched.has(file)));
    const conflicts = merge.conflicts.map((conflict) => ({
      path: conflict.path,
      conflictType: conflict.conflictType,
      markerPreview: conflict.markerPreview
    }));
    const status = conflicts.length > 0 ? "conflict" : merge.exitCode === 0 ? "clean" : "unknown";
    const [leftLane, rightLane, leftSha, rightSha] = laneA.id < laneB.id ? [laneA, laneB, laneAHead, laneBHead] : [laneB, laneA, laneBHead, laneAHead];
    return upsertPrediction({
      laneAId: leftLane.id,
      laneBId: rightLane.id,
      status,
      conflictingFiles: conflicts,
      overlapFiles: overlap,
      laneASha: leftSha,
      laneBSha: rightSha
    });
  };
  const getLaneStatusInternal = async (lane) => {
    const baseRow = getLatestBaseRow(lane.id);
    const pairRows = latestPerPair(getLatestPairRowsForLane(lane.id));
    const overlapSet = /* @__PURE__ */ new Set();
    let peerConflictCount = 0;
    const foldRow = (row) => {
      const conflicting = safeJsonArray(row.conflicting_files_json);
      const overlapFiles = safeJsonArray(row.overlap_files_json);
      for (const path16 of overlapFiles) {
        const clean = path16.trim();
        if (clean) overlapSet.add(clean);
      }
      for (const file of conflicting) {
        const clean = file.path?.trim();
        if (clean) overlapSet.add(clean);
      }
      if (row.status === "conflict" && row.lane_b_id) {
        peerConflictCount += 1;
      }
    };
    if (baseRow) foldRow(baseRow);
    for (const [key, row] of pairRows) {
      if (!key.startsWith("pair:")) continue;
      foldRow(row);
    }
    const hasPredictedConflict = baseRow?.status === "conflict" || Array.from(pairRows.values()).some((row) => row.lane_b_id != null && row.status === "conflict");
    const activeConflict = await hasActiveConflict(lane);
    const status = computeStatusValue({
      hasActiveConflict: activeConflict,
      hasBasePrediction: Boolean(baseRow),
      hasPredictedConflict,
      behindCount: lane.status.behind
    });
    const lastPredictedAt = [
      baseRow?.predicted_at ?? null,
      ...Array.from(pairRows.values()).map((row) => row.predicted_at)
    ].filter((value) => Boolean(value)).sort((a, b) => b.localeCompare(a))[0] ?? null;
    return {
      laneId: lane.id,
      status,
      overlappingFileCount: overlapSet.size,
      peerConflictCount,
      lastPredictedAt
    };
  };
  const getRiskMatrixAndOverlaps = async (lanes) => {
    const latest = getLatestRows();
    const matrix = [];
    const overlapEntries = [];
    for (const lane of lanes) {
      const row = latest.get(`base:${lane.id}`);
      const overlapFiles = extractOverlapFiles(row);
      const conflicting = safeJsonArray(row?.conflicting_files_json ?? null);
      matrix.push({
        laneAId: lane.id,
        laneBId: lane.id,
        riskLevel: riskFromPrediction(row?.status ?? "unknown", overlapFiles.length, conflicting.length),
        overlapCount: overlapFiles.length,
        hasConflict: (row?.status ?? "unknown") === "conflict" || conflicting.length > 0,
        computedAt: row?.predicted_at ?? null,
        stale: isStalePrediction(row?.predicted_at)
      });
      overlapEntries.push({
        laneAId: lane.id,
        laneBId: lane.id,
        files: overlapFiles
      });
    }
    for (let i = 0; i < lanes.length; i++) {
      for (let j = i + 1; j < lanes.length; j++) {
        const laneA = lanes[i];
        const laneB = lanes[j];
        const key = `pair:${pairKey(laneA.id, laneB.id)}`;
        const row = latest.get(key);
        const overlapFiles = extractOverlapFiles(row);
        const conflicting = safeJsonArray(row?.conflicting_files_json ?? null);
        matrix.push({
          laneAId: laneA.id,
          laneBId: laneB.id,
          riskLevel: riskFromPrediction(row?.status ?? "unknown", overlapFiles.length, conflicting.length),
          overlapCount: overlapFiles.length,
          hasConflict: (row?.status ?? "unknown") === "conflict" || conflicting.length > 0,
          computedAt: row?.predicted_at ?? null,
          stale: isStalePrediction(row?.predicted_at)
        });
        overlapEntries.push({
          laneAId: laneA.id,
          laneBId: laneB.id,
          files: overlapFiles
        });
      }
    }
    return {
      matrix,
      overlaps: overlapEntries
    };
  };
  const buildBatchAssessment = async (options = {}) => {
    const lanes = await listActiveLanes();
    const statuses = await Promise.all(lanes.map((lane) => getLaneStatusInternal(lane)));
    const { matrix, overlaps } = await getRiskMatrixAndOverlaps(lanes);
    return {
      lanes: statuses,
      matrix,
      overlaps,
      computedAt: (/* @__PURE__ */ new Date()).toISOString(),
      progress: options.progress,
      truncated: options.truncated,
      comparedLaneIds: options.comparedLaneIds,
      maxAutoLanes: options.maxAutoLanes,
      totalLanes: options.totalLanes,
      strategy: options.strategy,
      pairwisePairsComputed: options.pairwisePairsComputed,
      pairwisePairsTotal: options.pairwisePairsTotal
    };
  };
  const buildChips = (prev, next) => {
    const prevMap = new Map(prev.map((entry) => [matrixEntryKey(entry), entry]));
    const chips = [];
    for (const entry of next) {
      if (entry.laneAId === entry.laneBId) continue;
      const key = matrixEntryKey(entry);
      const previous = prevMap.get(key);
      const isNewOverlap = entry.overlapCount > 0 && (previous == null || previous.overlapCount === 0);
      if (isNewOverlap) {
        chips.push(
          { laneId: entry.laneAId, peerId: entry.laneBId, kind: "new-overlap", overlapCount: entry.overlapCount },
          { laneId: entry.laneBId, peerId: entry.laneAId, kind: "new-overlap", overlapCount: entry.overlapCount }
        );
      }
      const becameHighRisk = entry.riskLevel === "high" && (previous == null || RISK_SCORE[previous.riskLevel] < RISK_SCORE.high);
      if (becameHighRisk) {
        chips.push(
          { laneId: entry.laneAId, peerId: entry.laneBId, kind: "high-risk", overlapCount: entry.overlapCount },
          { laneId: entry.laneBId, peerId: entry.laneAId, kind: "high-risk", overlapCount: entry.overlapCount }
        );
      }
    }
    return dedupeChips(chips);
  };
  const writeConflictPacks = async (assessment) => {
    if (!conflictPacksDir) return;
    const predictionsDir = import_node_path7.default.join(conflictPacksDir, "predictions");
    import_node_fs8.default.mkdirSync(predictionsDir, { recursive: true });
    for (const status of assessment.lanes) {
      try {
        const overlaps = await listOverlaps({ laneId: status.laneId });
        const laneMatrix = assessment.matrix.filter(
          (entry) => entry.laneAId === status.laneId || entry.laneBId === status.laneId
        );
        const matrixRowFor = (peerId) => {
          if (!peerId) {
            return laneMatrix.find((m) => m.laneAId === status.laneId && m.laneBId === status.laneId) ?? null;
          }
          return laneMatrix.find((m) => m.laneAId === status.laneId && m.laneBId === peerId || m.laneAId === peerId && m.laneBId === status.laneId) ?? null;
        };
        const openConflictSummaries = overlaps.filter((ov) => ov && (ov.files?.length ?? 0) > 0).map((ov) => {
          const row = matrixRowFor(ov.peerId ?? null);
          const riskSignals = [];
          if (row?.stale) riskSignals.push("stale_prediction");
          if (row?.hasConflict) riskSignals.push("predicted_conflict");
          if ((ov.files?.length ?? 0) > 0) riskSignals.push("overlap_files");
          if (assessment.truncated) riskSignals.push("partial_coverage");
          return {
            peerId: ov.peerId ?? null,
            peerLabel: ov.peerName,
            riskLevel: ov.riskLevel,
            fileCount: ov.files.length,
            lastSeenAt: row?.computedAt ?? status.lastPredictedAt ?? null,
            riskSignals
          };
        }).sort((a, b) => b.fileCount - a.fileCount || a.peerLabel.localeCompare(b.peerLabel)).slice(0, 12);
        const payload = {
          schema: "ade.conflicts.predictionPack.v2",
          laneId: status.laneId,
          status,
          overlaps,
          matrix: laneMatrix,
          generatedAt: assessment.computedAt,
          predictionAt: status.lastPredictedAt ?? null,
          lastRecomputedAt: assessment.computedAt,
          stalePolicy: { ttlMs: STALE_MS },
          openConflictSummaries,
          truncated: Boolean(assessment.truncated),
          strategy: assessment.strategy,
          pairwisePairsComputed: assessment.pairwisePairsComputed,
          pairwisePairsTotal: assessment.pairwisePairsTotal
        };
        const outPath = import_node_path7.default.join(predictionsDir, `${status.laneId}.json`);
        import_node_fs8.default.writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf8");
      } catch (error) {
        logger.warn("conflicts.pack_write_failed", {
          laneId: status.laneId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  };
  const getLaneStatus = async (args) => {
    const lane = (await listActiveLanes()).find((entry) => entry.id === args.laneId);
    if (!lane) {
      throw new Error(`Lane not found: ${args.laneId}`);
    }
    return await getLaneStatusInternal(lane);
  };
  const listOverlaps = async (args) => {
    const lanes = await listActiveLanes();
    const lane = lanes.find((entry) => entry.id === args.laneId);
    if (!lane) throw new Error(`Lane not found: ${args.laneId}`);
    const laneMap = laneById(lanes);
    const overlaps = [];
    const baseRow = getLatestBaseRow(args.laneId);
    if (baseRow) {
      const conflicting = safeJsonArray(baseRow.conflicting_files_json);
      const overlapFiles = safeJsonArray(baseRow.overlap_files_json);
      const files = buildConflictFiles(conflicting, overlapFiles).map((file) => ({
        path: file.path,
        conflictType: file.conflictType
      }));
      overlaps.push({
        peerId: null,
        peerName: `base (${lane.baseRef})`,
        files,
        riskLevel: riskFromPrediction(baseRow.status, overlapFiles.length, conflicting.length)
      });
    }
    const latest = latestPerPair(getLatestPairRowsForLane(args.laneId));
    for (const [key, row] of latest) {
      if (!key.startsWith("pair:") || row.lane_b_id == null) continue;
      const peerId = row.lane_a_id === args.laneId ? row.lane_b_id : row.lane_a_id;
      const peerLane = laneMap.get(peerId);
      const conflicting = safeJsonArray(row.conflicting_files_json);
      const overlapFiles = safeJsonArray(row.overlap_files_json);
      const files = buildConflictFiles(conflicting, overlapFiles).map((file) => ({
        path: file.path,
        conflictType: file.conflictType
      }));
      overlaps.push({
        peerId,
        peerName: peerLane?.name ?? "Unknown lane",
        files,
        riskLevel: riskFromPrediction(row.status, overlapFiles.length, conflicting.length)
      });
    }
    overlaps.sort((a, b) => {
      const riskDelta = RISK_SCORE[b.riskLevel] - RISK_SCORE[a.riskLevel];
      if (riskDelta !== 0) return riskDelta;
      return a.peerName.localeCompare(b.peerName);
    });
    return overlaps;
  };
  const getRiskMatrix = async () => {
    const lanes = await listActiveLanes();
    return (await getRiskMatrixAndOverlaps(lanes)).matrix;
  };
  const simulateMerge = async (args) => {
    const lanes = await listActiveLanes();
    const laneA = lanes.find((entry) => entry.id === args.laneAId);
    if (!laneA) {
      return {
        outcome: "error",
        mergedFiles: [],
        conflictingFiles: [],
        diffStat: { insertions: 0, deletions: 0, filesChanged: 0 },
        error: `Lane not found: ${args.laneAId}`
      };
    }
    try {
      const laneAHead = await readHeadSha(laneA.worktreePath, "HEAD");
      let laneBHead;
      if (args.laneBId) {
        const laneB = lanes.find((entry) => entry.id === args.laneBId);
        if (!laneB) {
          return {
            outcome: "error",
            mergedFiles: [],
            conflictingFiles: [],
            diffStat: { insertions: 0, deletions: 0, filesChanged: 0 },
            error: `Lane not found: ${args.laneBId}`
          };
        }
        laneBHead = await readHeadSha(laneB.worktreePath, "HEAD");
      } else {
        laneBHead = await readHeadSha(projectRoot, laneA.baseRef);
      }
      const mergeBase = await readMergeBase(projectRoot, laneAHead, laneBHead);
      const merge = await runGitMergeTree({
        cwd: projectRoot,
        mergeBase,
        branchA: laneAHead,
        branchB: laneBHead,
        timeoutMs: 6e4
      });
      const [statA, statB, touchedA, touchedB] = await Promise.all([
        readDiffNumstat(projectRoot, mergeBase, laneAHead),
        readDiffNumstat(projectRoot, mergeBase, laneBHead),
        readTouchedFiles(projectRoot, mergeBase, laneAHead),
        readTouchedFiles(projectRoot, mergeBase, laneBHead)
      ]);
      const mergedFiles = uniqueSorted2(/* @__PURE__ */ new Set([...touchedA, ...touchedB]));
      const overlapFiles = uniqueSorted2(Array.from(touchedA).filter((file) => touchedB.has(file)));
      const conflictFiles = buildConflictFiles(
        merge.conflicts.map((entry) => ({
          path: entry.path,
          conflictType: entry.conflictType,
          markerPreview: entry.markerPreview
        })),
        merge.exitCode === 0 ? [] : overlapFiles
      );
      return {
        outcome: conflictFiles.length > 0 ? "conflict" : merge.exitCode === 0 ? "clean" : "error",
        mergedFiles,
        conflictingFiles: conflictFiles.map((file) => ({
          path: file.path,
          conflictMarkers: file.markerPreview
        })),
        diffStat: {
          insertions: statA.insertions + statB.insertions,
          deletions: statA.deletions + statB.deletions,
          filesChanged: (/* @__PURE__ */ new Set([...statA.files, ...statB.files])).size
        },
        error: merge.exitCode === 0 ? void 0 : merge.stderr.trim() || void 0
      };
    } catch (error) {
      return {
        outcome: "error",
        mergedFiles: [],
        conflictingFiles: [],
        diffStat: { insertions: 0, deletions: 0, filesChanged: 0 },
        error: error instanceof Error ? error.message : String(error)
      };
    }
  };
  const pruneTouchedFilesForHeuristic = (files) => {
    if (files.size <= PREFILTER_MAX_TOUCHED_FILES) return files;
    const sorted = Array.from(files).sort((a, b) => a.localeCompare(b));
    return new Set(sorted.slice(0, PREFILTER_MAX_TOUCHED_FILES));
  };
  const readTouchedFilesSinceBase = async (lane) => {
    try {
      const laneHead = await readHeadSha(lane.worktreePath, "HEAD");
      const baseHead = await readHeadSha(projectRoot, lane.baseRef);
      const mergeBase = await readMergeBase(projectRoot, baseHead, laneHead);
      const touched = await readTouchedFiles(projectRoot, mergeBase, laneHead);
      return pruneTouchedFilesForHeuristic(touched);
    } catch {
      return /* @__PURE__ */ new Set();
    }
  };
  const intersectionCount = (a, b) => {
    if (a.size === 0 || b.size === 0) return 0;
    const [small, big] = a.size <= b.size ? [a, b] : [b, a];
    let count = 0;
    for (const file of small) {
      if (big.has(file)) count += 1;
    }
    return count;
  };
  const buildPrefilterPairs = async (comparisonLanes) => {
    const touchedById = /* @__PURE__ */ new Map();
    for (const lane of comparisonLanes) {
      touchedById.set(lane.id, await readTouchedFilesSinceBase(lane));
    }
    const overlapsByLane = /* @__PURE__ */ new Map();
    const overlapByPair = /* @__PURE__ */ new Map();
    for (let i = 0; i < comparisonLanes.length; i++) {
      for (let j = i + 1; j < comparisonLanes.length; j++) {
        const laneA = comparisonLanes[i];
        const laneB = comparisonLanes[j];
        const count = intersectionCount(touchedById.get(laneA.id) ?? /* @__PURE__ */ new Set(), touchedById.get(laneB.id) ?? /* @__PURE__ */ new Set());
        if (count <= 0) continue;
        const key = pairKey(laneA.id, laneB.id);
        overlapByPair.set(key, count);
        const left = overlapsByLane.get(laneA.id) ?? [];
        left.push({ peerId: laneB.id, overlapCount: count });
        overlapsByLane.set(laneA.id, left);
        const right = overlapsByLane.get(laneB.id) ?? [];
        right.push({ peerId: laneA.id, overlapCount: count });
        overlapsByLane.set(laneB.id, right);
      }
    }
    const candidateKeys = /* @__PURE__ */ new Set();
    for (const lane of comparisonLanes) {
      const peers = overlapsByLane.get(lane.id) ?? [];
      peers.sort((a, b) => b.overlapCount - a.overlapCount || a.peerId.localeCompare(b.peerId));
      for (const peer of peers.slice(0, PREFILTER_MAX_PEERS_PER_LANE)) {
        candidateKeys.add(pairKey(lane.id, peer.peerId));
      }
    }
    let keys = Array.from(candidateKeys);
    if (keys.length > PREFILTER_MAX_GLOBAL_PAIRS) {
      keys.sort((a, b) => (overlapByPair.get(b) ?? 0) - (overlapByPair.get(a) ?? 0) || a.localeCompare(b));
      keys = keys.slice(0, PREFILTER_MAX_GLOBAL_PAIRS);
    }
    const laneMap = laneById(comparisonLanes);
    const out = [];
    for (const key of keys) {
      const [aId, bId] = key.split("::");
      if (!aId || !bId) continue;
      const laneA = laneMap.get(aId);
      const laneB = laneMap.get(bId);
      if (!laneA || !laneB) continue;
      out.push({ laneA, laneB, overlapCount: overlapByPair.get(key) ?? 0 });
    }
    out.sort((a, b) => b.overlapCount - a.overlapCount || a.laneA.id.localeCompare(b.laneA.id) || a.laneB.id.localeCompare(b.laneB.id));
    return out;
  };
  const runPrediction = async (args = {}) => {
    const lanes = await listActiveLanes();
    if (lanes.length === 0) {
      return {
        lanes: [],
        matrix: [],
        overlaps: [],
        computedAt: (/* @__PURE__ */ new Date()).toISOString(),
        progress: { completedPairs: 0, totalPairs: 0 }
      };
    }
    const before = await buildBatchAssessment();
    const targetLane = args.laneId ? lanes.find((lane) => lane.id === args.laneId) : null;
    if (args.laneId && !targetLane) {
      throw new Error(`Lane not found: ${args.laneId}`);
    }
    const requestedLaneIds = uniqueSorted2(
      (args.laneIds ?? []).map((laneId) => laneId.trim()).filter(Boolean)
    );
    let comparisonLanes = [];
    let basePredictionLanes = [];
    let strategy = "full";
    let truncated = false;
    let pairwisePairsTotal = 0;
    let pairwisePairsComputed = 0;
    let pairwiseComparisons = [];
    if (targetLane) {
      comparisonLanes = lanes;
      basePredictionLanes = [targetLane];
      strategy = "full-target";
      pairwisePairsTotal = Math.max(0, lanes.length - 1);
      pairwiseComparisons = lanes.filter((lane) => lane.id !== targetLane.id).map((peer) => ({ laneA: targetLane, laneB: peer }));
    } else {
      if (requestedLaneIds.length > 0) {
        const requestedSet = new Set(requestedLaneIds);
        const selected = lanes.filter((lane) => requestedSet.has(lane.id));
        if (selected.length === 0) {
          throw new Error("No valid lanes selected for conflict prediction");
        }
        comparisonLanes = selected;
      } else {
        comparisonLanes = lanes;
      }
      basePredictionLanes = comparisonLanes;
      pairwisePairsTotal = Math.max(0, comparisonLanes.length * (comparisonLanes.length - 1) / 2);
      if (comparisonLanes.length <= FULL_MATRIX_MAX_LANES) {
        strategy = "full";
        for (let i = 0; i < comparisonLanes.length; i++) {
          for (let j = i + 1; j < comparisonLanes.length; j++) {
            const laneA = comparisonLanes[i];
            const laneB = comparisonLanes[j];
            pairwiseComparisons.push({ laneA, laneB });
          }
        }
      } else {
        strategy = "prefilter-overlap";
        const pairs = await buildPrefilterPairs(comparisonLanes);
        pairwiseComparisons = pairs.map((pair) => ({ laneA: pair.laneA, laneB: pair.laneB }));
        truncated = pairwiseComparisons.length < pairwisePairsTotal;
      }
    }
    pairwisePairsComputed = pairwiseComparisons.length;
    const totalPairs = pairwiseComparisons.length;
    let completedPairs = 0;
    const emitProgress = (pair) => {
      if (!onEvent) return;
      onEvent({
        type: "prediction-progress",
        computedAt: (/* @__PURE__ */ new Date()).toISOString(),
        laneIds: comparisonLanes.map((lane) => lane.id),
        completedPairs,
        totalPairs,
        pair
      });
    };
    for (const lane of basePredictionLanes) {
      try {
        await runSerializedPairTask(`base:${lane.id}`, async () => {
          await predictLaneVsBase(lane);
        });
      } catch (error) {
        logger.warn("conflicts.predict_lane_base_failed", {
          laneId: lane.id,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    for (const pair of pairwiseComparisons) {
      try {
        const pairId = `pair:${pairKey(pair.laneA.id, pair.laneB.id)}`;
        await runSerializedPairTask(pairId, async () => {
          await predictPairwise(pair.laneA, pair.laneB);
        });
      } catch (error) {
        logger.warn("conflicts.predict_pair_failed", {
          laneId: pair.laneA.id,
          peerId: pair.laneB.id,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      completedPairs += 1;
      emitProgress({ laneAId: pair.laneA.id, laneBId: pair.laneB.id });
    }
    const after = await buildBatchAssessment({
      progress: { completedPairs, totalPairs },
      truncated,
      comparedLaneIds: comparisonLanes.map((lane) => lane.id),
      totalLanes: lanes.length,
      strategy,
      pairwisePairsComputed,
      pairwisePairsTotal
    });
    await writeConflictPacks(after);
    const chips = buildChips(before.matrix, after.matrix);
    if (onEvent) {
      const relatedPeerIds = chips.map((chip) => chip.peerId).filter((peerId) => Boolean(peerId));
      const laneIds = targetLane ? uniqueSorted2([targetLane.id, ...relatedPeerIds]) : comparisonLanes.map((lane) => lane.id);
      onEvent({
        type: "prediction-complete",
        computedAt: after.computedAt,
        laneIds,
        chips,
        completedPairs,
        totalPairs
      });
    }
    return after;
  };
  const getBatchAssessment = async () => {
    const hasAny = db.get(
      "select id from conflict_predictions where project_id = ? limit 1",
      [projectId]
    );
    if (!hasAny) {
      return await runPrediction({});
    }
    const lanes = await listActiveLanes();
    const comparedLaneIds = lanes.map((lane) => lane.id);
    const readAssessmentMeta = () => {
      if (!conflictPacksDir) return {};
      const predictionsDir = import_node_path7.default.join(conflictPacksDir, "predictions");
      if (!import_node_fs8.default.existsSync(predictionsDir)) return {};
      try {
        const entries = import_node_fs8.default.readdirSync(predictionsDir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
        if (!entries.length) return {};
        let bestName = entries[0].name;
        let bestMtime = import_node_fs8.default.statSync(import_node_path7.default.join(predictionsDir, bestName)).mtimeMs;
        for (const entry of entries.slice(1)) {
          const ms = import_node_fs8.default.statSync(import_node_path7.default.join(predictionsDir, entry.name)).mtimeMs;
          if (ms > bestMtime) {
            bestMtime = ms;
            bestName = entry.name;
          }
        }
        const raw = import_node_fs8.default.readFileSync(import_node_path7.default.join(predictionsDir, bestName), "utf8");
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
        const record = parsed;
        return {
          truncated: typeof record.truncated === "boolean" ? record.truncated : void 0,
          strategy: typeof record.strategy === "string" ? record.strategy : void 0,
          pairwisePairsComputed: typeof record.pairwisePairsComputed === "number" ? record.pairwisePairsComputed : void 0,
          pairwisePairsTotal: typeof record.pairwisePairsTotal === "number" ? record.pairwisePairsTotal : void 0
        };
      } catch {
        return {};
      }
    };
    const meta = readAssessmentMeta();
    const computed = Number(meta.pairwisePairsComputed ?? NaN);
    const total = Number(meta.pairwisePairsTotal ?? NaN) || Math.max(0, comparedLaneIds.length * (comparedLaneIds.length - 1) / 2);
    const truncated = typeof meta.truncated === "boolean" ? meta.truncated : Number.isFinite(computed) && Number.isFinite(total) && total > 0 ? computed < total : false;
    return await buildBatchAssessment({
      truncated,
      comparedLaneIds,
      totalLanes: lanes.length,
      strategy: meta.strategy,
      pairwisePairsComputed: Number.isFinite(computed) ? computed : void 0,
      pairwisePairsTotal: Number.isFinite(total) ? total : void 0
    });
  };
  const getProposalRow = (proposalId) => {
    return db.get(
      `
        select
          id,
          lane_id,
          peer_lane_id,
          prediction_id,
          source,
          confidence,
          explanation,
          diff_patch,
          status,
          job_id,
          artifact_id,
          applied_operation_id,
          created_at,
          updated_at
        from conflict_proposals
        where id = ?
          and project_id = ?
        limit 1
      `,
      [proposalId, projectId]
    );
  };
  const listProposals = async (args) => {
    const rows = db.all(
      `
        select
          id,
          lane_id,
          peer_lane_id,
          prediction_id,
          source,
          confidence,
          explanation,
          diff_patch,
          status,
          job_id,
          artifact_id,
          applied_operation_id,
          created_at,
          updated_at
        from conflict_proposals
        where project_id = ?
          and lane_id = ?
        order by created_at desc
      `,
      [projectId, args.laneId]
    );
    return rows.map(rowToProposal);
  };
  const getLatestPredictionId = (laneId, peerLaneId) => {
    if (!peerLaneId) {
      const row2 = db.get(
        `
          select id
          from conflict_predictions
          where project_id = ?
            and lane_a_id = ?
            and lane_b_id is null
          order by predicted_at desc
          limit 1
        `,
        [projectId, laneId]
      );
      return row2?.id ?? null;
    }
    const [laneAId, laneBId] = laneId < peerLaneId ? [laneId, peerLaneId] : [peerLaneId, laneId];
    const row = db.get(
      `
        select id
        from conflict_predictions
        where project_id = ?
          and lane_a_id = ?
          and lane_b_id = ?
        order by predicted_at desc
        limit 1
      `,
      [projectId, laneAId, laneBId]
    );
    return row?.id ?? null;
  };
  const findExistingProposalIdForDigest = (args) => {
    const rows = db.all(
      `
        select id, peer_lane_id, metadata_json
        from conflict_proposals
        where project_id = ?
          and lane_id = ?
        order by created_at desc
        limit 50
      `,
      [projectId, args.laneId]
    );
    for (const row of rows) {
      const peer = row.peer_lane_id ?? null;
      if (peer !== args.peerLaneId) continue;
      const meta = safeParseMetadata2(row.metadata_json);
      if (typeof meta.contextDigest === "string" && meta.contextDigest === args.contextDigest) {
        return row.id;
      }
    }
    return null;
  };
  const readConflictResolutionConfig = () => {
    const config = projectConfigService.get().effective.ai?.conflictResolution ?? {};
    const thresholdRaw = Number(config.autoApplyThreshold ?? NaN);
    const threshold = Number.isFinite(thresholdRaw) ? Math.max(0, Math.min(1, thresholdRaw)) : 0.85;
    return {
      changeTarget: config.changeTarget ?? "ai_decides",
      postResolution: config.postResolution ?? "staged",
      prBehavior: config.prBehavior ?? "do_nothing",
      autonomy: config.autonomy ?? "propose_only",
      autoApplyThreshold: threshold
    };
  };
  const mapPostResolutionToApplyMode = (postResolution) => {
    if (postResolution === "unstaged") return "unstaged";
    if (postResolution === "commit") return "commit";
    return "staged";
  };
  const prepareProposal = async (args) => {
    cleanupPreparedContexts();
    const laneId = args.laneId.trim();
    if (!laneId) throw new Error("laneId is required");
    const peerLaneId = args.peerLaneId?.trim() || null;
    const providerMode = projectConfigService.get().effective.providerMode ?? "guest";
    const aiMode = aiIntegrationService?.getMode() ?? "guest";
    const subscriptionAvailable = providerMode !== "guest" && aiMode === "subscription" && Boolean(aiIntegrationService);
    const provider = "subscription";
    const lanes = await listActiveLanes();
    const lane = lanes.find((entry) => entry.id === laneId);
    if (!lane) throw new Error(`Lane not found: ${laneId}`);
    if (lane.parentLaneId) {
      const parentStatus = await getLaneStatus({ laneId: lane.parentLaneId }).catch(() => null);
      if (parentStatus && parentStatus.status !== "merge-ready") {
        throw new Error(`Stack-aware resolution: resolve parent lane conflicts first (parent status: ${parentStatus.status}).`);
      }
    }
    const warnings = [];
    if (!subscriptionAvailable) {
      warnings.push("Subscription AI is unavailable; proposal preview is prepared for manual/external resolution.");
    }
    const MAX_FILES = 6;
    const MAX_DIFF_CHARS = 6e3;
    const MAX_FILE_CONTEXT_CHARS = 8e3;
    const LANE_EXPORT_LEVEL = "lite";
    const CONFLICT_EXPORT_LEVEL = "standard";
    const truncate = (label, text, maxChars) => {
      const clean = text ?? "";
      if (clean.length <= maxChars) return clean;
      warnings.push(`${label} truncated to ${maxChars} characters.`);
      return `${clean.slice(0, maxChars)}
...(truncated)...
`;
    };
    const preparedAt = (/* @__PURE__ */ new Date()).toISOString();
    if (packService) {
      await packService.refreshLanePack({ laneId, reason: "conflict_proposal_prepare" });
      if (peerLaneId) {
        await packService.refreshLanePack({ laneId: peerLaneId, reason: "conflict_proposal_prepare" });
      }
      await packService.refreshConflictPack({ laneId, peerLaneId, reason: "conflict_proposal_prepare" });
    }
    const conflictState = await readGitConflictState(laneId);
    const activeConflict = {
      laneId,
      kind: conflictState.kind,
      inProgress: conflictState.inProgress,
      conflictedFiles: conflictState.conflictedFiles,
      canContinue: conflictState.canContinue,
      canAbort: conflictState.canAbort
    };
    const overlaps = await listOverlaps({ laneId });
    const status = await getLaneStatus({ laneId });
    const overlapEntry = overlaps.find((entry) => entry.peerId === peerLaneId) ?? null;
    const overlapPaths = (overlapEntry?.files ?? []).map((file) => file.path).filter(Boolean);
    const includeFromConflicts = activeConflict.inProgress && activeConflict.conflictedFiles.length > 0;
    const includeReason = includeFromConflicts ? "conflicted" : "overlap";
    const selectedSourcePaths = uniqueSorted2(includeFromConflicts ? activeConflict.conflictedFiles : overlapPaths);
    const selectedPaths = selectedSourcePaths.slice(0, MAX_FILES);
    if (selectedSourcePaths.length > MAX_FILES) {
      warnings.push(
        `Conflict context omitted ${selectedSourcePaths.length - MAX_FILES} files (omitted:path_count_limit).`
      );
    }
    if (selectedPaths.length === 0) {
      warnings.push("No conflicted/overlap files found; proposal context will be minimal.");
    }
    let laneExportLite = null;
    let peerLaneExportLite = null;
    let conflictExportStandard = null;
    if (packService) {
      try {
        laneExportLite = (await packService.getLaneExport({ laneId, level: LANE_EXPORT_LEVEL })).content;
      } catch (error) {
        warnings.push(`Lane export unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (peerLaneId) {
        try {
          peerLaneExportLite = (await packService.getLaneExport({ laneId: peerLaneId, level: LANE_EXPORT_LEVEL })).content;
        } catch (error) {
          warnings.push(`Peer lane export unavailable: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      try {
        conflictExportStandard = (await packService.getConflictExport({ laneId, peerLaneId, level: CONFLICT_EXPORT_LEVEL })).content;
      } catch (error) {
        warnings.push(`Conflict export unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      warnings.push("Pack service unavailable; conflict exports omitted from AI context.");
    }
    const files = [];
    const relevantFilesForConflict = [];
    const fileContexts = [];
    const laneGit = laneService.getLaneBaseAndBranch(laneId);
    const laneHeadSha = await readHeadSha(laneGit.worktreePath, laneGit.branchRef || "HEAD").catch(async () => await readHeadSha(laneGit.worktreePath).catch(() => ""));
    const mergeHeadSha = (conflictState.mergeHeadSha ?? "").trim();
    const diffMode = await (async () => {
      if (!laneHeadSha) return { kind: "none" };
      if (activeConflict.kind === "merge" && mergeHeadSha.length) {
        const base = await readMergeBase(laneGit.worktreePath, laneHeadSha, mergeHeadSha).catch(() => "");
        if (base.trim().length) return { kind: "merge-head", base: base.trim(), laneHeadSha, peerHeadSha: mergeHeadSha };
      }
      if (peerLaneId) {
        const peerGit = laneService.getLaneBaseAndBranch(peerLaneId);
        const peerHeadSha = await readHeadSha(peerGit.worktreePath, peerGit.branchRef || "HEAD").catch(async () => await readHeadSha(peerGit.worktreePath).catch(() => ""));
        if (peerHeadSha) {
          const base = await readMergeBase(laneGit.worktreePath, laneHeadSha, peerHeadSha).catch(() => "");
          if (base.trim().length) return { kind: "peer-lane", base: base.trim(), laneHeadSha, peerHeadSha };
        }
      }
      const parentLane = lane.parentLaneId ? lanes.find((entry) => entry.id === lane.parentLaneId) ?? null : null;
      const baseRef = parentLane?.branchRef ?? lane.baseRef;
      return { kind: "base-ref", baseRef, laneHeadSha };
    })();
    for (const rawPath of selectedPaths) {
      const filePath = rawPath.trim();
      if (!filePath) continue;
      try {
        ensureRelativeRepoPath2(filePath);
      } catch (err) {
        warnings.push(err instanceof Error ? err.message : String(err));
        continue;
      }
      const markerPreview = activeConflict.inProgress ? extractMarkerPreview(laneId, filePath, warnings) : null;
      const laneDiff = await (async () => {
        if (diffMode.kind === "merge-head" || diffMode.kind === "peer-lane") {
          const res = await runGit(["diff", "--unified=3", `${diffMode.base}..${diffMode.laneHeadSha}`, "--", filePath], {
            cwd: laneGit.worktreePath,
            timeoutMs: 25e3
          });
          return res.exitCode === 0 ? truncate(`Lane diff (${filePath})`, res.stdout, MAX_DIFF_CHARS) : "";
        }
        if (diffMode.kind === "base-ref") {
          const res = await runGit(["diff", "--unified=3", `${diffMode.baseRef}..${diffMode.laneHeadSha}`, "--", filePath], {
            cwd: laneGit.worktreePath,
            timeoutMs: 25e3
          });
          return res.exitCode === 0 ? truncate(`Lane diff (${filePath})`, res.stdout, MAX_DIFF_CHARS) : "";
        }
        return "";
      })();
      const peerDiff = await (async () => {
        if (diffMode.kind === "merge-head" || diffMode.kind === "peer-lane") {
          const res = await runGit(["diff", "--unified=3", `${diffMode.base}..${diffMode.peerHeadSha}`, "--", filePath], {
            cwd: laneGit.worktreePath,
            timeoutMs: 25e3
          });
          return res.exitCode === 0 ? truncate(`Peer diff (${filePath})`, res.stdout, MAX_DIFF_CHARS) : "";
        }
        return null;
      })();
      files.push({
        path: filePath,
        includeReason,
        markerPreview: markerPreview ?? null,
        laneDiff,
        peerDiff: peerDiff ?? null
      });
      relevantFilesForConflict.push({
        path: filePath,
        includeReason,
        selectedBecause: includeFromConflicts ? "active_conflict_file" : "overlap_prediction_file"
      });
      const baseRefForContext = diffMode.kind === "merge-head" || diffMode.kind === "peer-lane" ? diffMode.base : diffMode.kind === "base-ref" ? diffMode.baseRef : null;
      const leftRefForContext = diffMode.kind === "none" ? null : diffMode.laneHeadSha;
      const rightRefForContext = diffMode.kind === "merge-head" || diffMode.kind === "peer-lane" ? diffMode.peerHeadSha : null;
      const laneDiffClipped = truncate(`Lane file context (${filePath})`, laneDiff, MAX_FILE_CONTEXT_CHARS);
      const peerDiffClipped = peerDiff ? truncate(`Peer file context (${filePath})`, peerDiff, MAX_FILE_CONTEXT_CHARS) : "";
      const markerPreviewClipped = markerPreview ? truncate(`Marker preview (${filePath})`, markerPreview, 2400) : "";
      const hunkSummaries = [
        ...parseHunksFromDiff(laneDiffClipped, "base_left"),
        ...parseHunksFromDiff(peerDiffClipped, "base_right")
      ];
      const omittedReasonTags = [];
      if (!laneDiffClipped.trim() && !peerDiffClipped.trim() && !markerPreviewClipped.trim()) {
        omittedReasonTags.push("omitted:no_text_context");
      }
      if (laneDiff.length > MAX_FILE_CONTEXT_CHARS || (peerDiff ?? "").length > MAX_FILE_CONTEXT_CHARS) {
        omittedReasonTags.push("omitted:byte_cap");
      }
      fileContexts.push({
        path: filePath,
        selectedBecause: includeFromConflicts ? "active_conflict_file" : "overlap_prediction_file",
        hunks: hunkSummaries,
        base: makeContextSide({
          side: "base",
          ref: baseRefForContext,
          blobSha: null,
          excerpt: "",
          fallbackReason: "omitted:base_snapshot_not_loaded"
        }),
        left: makeContextSide({
          side: "left",
          ref: leftRefForContext,
          blobSha: null,
          excerpt: laneDiffClipped
        }),
        right: makeContextSide({
          side: "right",
          ref: rightRefForContext,
          blobSha: null,
          excerpt: peerDiffClipped
        }),
        markerPreview: markerPreviewClipped || null,
        ...omittedReasonTags.length ? { omittedReasonTags } : {}
      });
    }
    const overlapSummary = overlapEntry ? {
      peerId: overlapEntry.peerId,
      peerName: overlapEntry.peerName,
      riskLevel: overlapEntry.riskLevel,
      fileCount: overlapEntry.files.length,
      files: overlapEntry.files.slice(0, 40)
    } : null;
    const extractNumericFromConflictExport = (key) => {
      if (!conflictExportStandard) return null;
      const match = conflictExportStandard.match(new RegExp(`"${key}"\\s*:\\s*(\\d+)`));
      if (!match) return null;
      const value = Number(match[1] ?? NaN);
      return Number.isFinite(value) ? value : null;
    };
    const pairwisePairsComputed = extractNumericFromConflictExport("pairwisePairsComputed");
    const pairwisePairsTotal = extractNumericFromConflictExport("pairwisePairsTotal");
    const stalePolicyTtlFromExport = extractNumericFromConflictExport("ttlMs");
    const stalePolicyTtlMs = stalePolicyTtlFromExport != null ? stalePolicyTtlFromExport : STALE_MS;
    const predictionAgeMs = status.lastPredictedAt ? Math.max(0, Date.now() - Date.parse(status.lastPredictedAt)) : null;
    const predictionStalenessMs = predictionAgeMs;
    const highPatchRisk = activeConflict.inProgress || status.status === "conflict-active" || status.status === "conflict-predicted" || overlapEntry?.riskLevel === "high";
    const insufficientReasons = [];
    if (selectedPaths.length === 0) insufficientReasons.push("missing:relevant_files");
    if (relevantFilesForConflict.length > 0 && fileContexts.length === 0) {
      insufficientReasons.push("missing:file_contexts");
    }
    if (highPatchRisk && fileContexts.some((ctx) => (ctx.omittedReasonTags ?? []).includes("omitted:no_text_context"))) {
      insufficientReasons.push("missing:file_text_excerpt");
    }
    const insufficientContext = highPatchRisk && insufficientReasons.length > 0;
    const conflictJobContext = {
      schema: "ade.conflictJobContext.v1",
      relevantFilesForConflict,
      fileContexts,
      stalePolicy: { ttlMs: stalePolicyTtlMs },
      predictionAgeMs,
      predictionStalenessMs,
      pairwisePairsComputed,
      pairwisePairsTotal,
      insufficientContext,
      insufficientReasons
    };
    const conflictContext = {
      laneId,
      peerLaneId,
      preparedAt,
      provider,
      status,
      overlapSummary,
      activeConflict,
      ...mergeHeadSha.length ? { mergeHeadSha } : {},
      laneExportLite,
      peerLaneExportLite,
      conflictExportStandard,
      files,
      relevantFilesForConflict,
      fileContexts,
      predictionAgeMs,
      predictionStalenessMs,
      stalePolicy: { ttlMs: stalePolicyTtlMs },
      pairwisePairsComputed,
      pairwisePairsTotal,
      insufficientContext,
      insufficientReasons,
      conflictContext: conflictJobContext,
      limits: {
        maxFiles: MAX_FILES,
        maxDiffChars: MAX_DIFF_CHARS,
        maxFileContextChars: MAX_FILE_CONTEXT_CHARS,
        laneExportLevel: LANE_EXPORT_LEVEL,
        conflictExportLevel: CONFLICT_EXPORT_LEVEL
      }
    };
    const redactedContext = redactSecretsDeep(conflictContext);
    const contextDigest = sha256(JSON.stringify(redactedContext));
    preparedContexts.set(contextDigest, {
      preparedAt,
      laneId,
      peerLaneId,
      provider,
      conflictContext: redactedContext
    });
    const existingProposalId = findExistingProposalIdForDigest({ laneId, peerLaneId, contextDigest });
    const approxChars = JSON.stringify(redactedContext).length;
    logger.info("conflicts.proposal_prepared", {
      laneId,
      peerLaneId,
      provider,
      fileCount: files.length,
      approxChars,
      activeKind: activeConflict.kind,
      activeInProgress: activeConflict.inProgress
    });
    const redactedLaneExportLite = typeof redactedContext.laneExportLite === "string" ? redactedContext.laneExportLite : null;
    const redactedPeerLaneExportLite = typeof redactedContext.peerLaneExportLite === "string" ? redactedContext.peerLaneExportLite : null;
    const redactedConflictExportStandard = typeof redactedContext.conflictExportStandard === "string" ? redactedContext.conflictExportStandard : null;
    return {
      laneId,
      peerLaneId,
      provider,
      preparedAt,
      contextDigest,
      activeConflict,
      laneExportLite: redactedLaneExportLite,
      peerLaneExportLite: redactedPeerLaneExportLite,
      conflictExportStandard: redactedConflictExportStandard,
      files,
      stats: {
        approxChars,
        laneExportChars: redactedLaneExportLite?.length ?? 0,
        peerLaneExportChars: redactedPeerLaneExportLite?.length ?? 0,
        conflictExportChars: redactedConflictExportStandard?.length ?? 0,
        fileCount: files.length
      },
      warnings,
      existingProposalId
    };
  };
  const requestProposal = async (args) => {
    cleanupPreparedContexts();
    const laneId = args.laneId.trim();
    if (!laneId) throw new Error("laneId is required");
    const peerLaneId = args.peerLaneId?.trim() || null;
    const contextDigest = args.contextDigest.trim();
    if (!contextDigest) throw new Error("contextDigest is required (prepare context first).");
    const prepared = preparedContexts.get(contextDigest);
    if (!prepared) {
      throw new Error("Conflict context is missing or expired. Prepare a fresh preview before requesting AI.");
    }
    if (prepared.laneId !== laneId || prepared.peerLaneId !== peerLaneId) {
      throw new Error("Prepared conflict context does not match the requested lane/peer.");
    }
    const lanes = await listActiveLanes();
    const lane = lanes.find((entry) => entry.id === laneId);
    if (!lane) throw new Error(`Lane not found: ${laneId}`);
    if (lane.parentLaneId) {
      const parentStatus = await getLaneStatus({ laneId: lane.parentLaneId }).catch(() => null);
      if (parentStatus && parentStatus.status !== "merge-ready") {
        throw new Error(`Stack-aware resolution: resolve parent lane conflicts first (parent status: ${parentStatus.status}).`);
      }
    }
    const existingId = findExistingProposalIdForDigest({ laneId, peerLaneId, contextDigest });
    if (existingId) {
      const row2 = getProposalRow(existingId);
      if (!row2) throw new Error("Failed to load existing proposal");
      return rowToProposal(row2);
    }
    const preparedConflictContext = isRecord2(prepared.conflictContext.conflictContext) && prepared.conflictContext.conflictContext.schema === "ade.conflictJobContext.v1" ? prepared.conflictContext.conflictContext : null;
    const insufficientContext = Boolean(preparedConflictContext?.insufficientContext);
    const insufficientReasons = Array.isArray(preparedConflictContext?.insufficientReasons) ? preparedConflictContext.insufficientReasons.map((value) => String(value)) : [];
    if (insufficientContext) {
      const createdAt2 = (/* @__PURE__ */ new Date()).toISOString();
      const proposalId2 = (0, import_node_crypto6.randomUUID)();
      const predictionId2 = getLatestPredictionId(laneId, peerLaneId);
      const explanation = [
        "Insufficient context to generate a safe conflict patch.",
        "",
        "Missing data:",
        ...insufficientReasons.map((reason) => `- ${reason}`)
      ].join("\n");
      db.run(
        `
          insert into conflict_proposals(
            id,
            project_id,
            lane_id,
            peer_lane_id,
            prediction_id,
            source,
            confidence,
            explanation,
            diff_patch,
            status,
            job_id,
            artifact_id,
            applied_operation_id,
            metadata_json,
            created_at,
            updated_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, null, ?, ?, ?)
        `,
        [
          proposalId2,
          projectId,
          laneId,
          peerLaneId,
          predictionId2,
          "local",
          null,
          explanation,
          "",
          null,
          null,
          JSON.stringify({
            provider: "local",
            contextDigest,
            preparedAt: prepared.preparedAt,
            insufficientContext: true,
            insufficientReasons
          }),
          createdAt2,
          createdAt2
        ]
      );
      logger.warn("conflicts.proposal_insufficient_context", {
        laneId,
        peerLaneId,
        reasons: insufficientReasons
      });
      const row2 = getProposalRow(proposalId2);
      if (!row2) throw new Error("Failed to persist insufficient-context proposal");
      return rowToProposal(row2);
    }
    const providerMode = projectConfigService.get().effective.providerMode ?? "guest";
    const aiMode = aiIntegrationService?.getMode() ?? "guest";
    const subscriptionReady = providerMode !== "guest" && aiMode === "subscription" && Boolean(aiIntegrationService);
    if (!subscriptionReady || !aiIntegrationService) {
      throw new Error("AI conflict resolution requires a subscription provider (Claude and/or Codex CLI).");
    }
    const provider = "subscription";
    if (provider !== prepared.provider) {
      throw new Error("Provider mode changed since preview. Prepare a fresh preview before requesting AI.");
    }
    const laneGit = laneService.getLaneBaseAndBranch(laneId);
    const outputSchema = {
      type: "object",
      additionalProperties: false,
      properties: {
        explanation: { type: "string" },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        diffPatch: { type: "string" }
      },
      required: ["explanation", "confidence", "diffPatch"]
    };
    const prompt = [
      "You are ADE's conflict resolution assistant.",
      "Produce a safe proposal using only provided context. Do not invent files or hunks.",
      "",
      "Return JSON with keys: explanation, confidence (0..1), diffPatch (unified diff).",
      "If context is insufficient for a safe patch, set diffPatch to an empty string and explain why.",
      "",
      "Conflict Context JSON:",
      JSON.stringify(prepared.conflictContext, null, 2)
    ].join("\n");
    const aiResult = await aiIntegrationService.requestConflictProposal({
      laneId,
      cwd: laneGit.worktreePath,
      prompt,
      jsonSchema: outputSchema
    });
    const structured = (isRecord2(aiResult.structuredOutput) ? aiResult.structuredOutput : null) ?? parseStructuredObject(aiResult.text) ?? {};
    const diffPatchFromStructured = asString2(structured.diffPatch).trim();
    const explanationFromStructured = asString2(structured.explanation).trim();
    const result = {
      diffPatch: diffPatchFromStructured.length ? `${diffPatchFromStructured}
` : extractDiffPatchFromText(aiResult.text),
      explanation: explanationFromStructured.length ? explanationFromStructured : stripDiffFence(aiResult.text),
      rawContent: aiResult.text,
      confidence: normalizeConfidence(structured.confidence),
      model: aiResult.model,
      provider: aiResult.provider,
      sessionId: aiResult.sessionId
    };
    const createdAt = (/* @__PURE__ */ new Date()).toISOString();
    const proposalId = (0, import_node_crypto6.randomUUID)();
    const predictionId = getLatestPredictionId(laneId, peerLaneId);
    const resolutionConfig = readConflictResolutionConfig();
    db.run(
      `
        insert into conflict_proposals(
          id,
          project_id,
          lane_id,
          peer_lane_id,
          prediction_id,
          source,
          confidence,
          explanation,
          diff_patch,
          status,
          job_id,
          artifact_id,
          applied_operation_id,
          metadata_json,
          created_at,
          updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, null, ?, ?, ?)
      `,
      [
        proposalId,
        projectId,
        laneId,
        peerLaneId,
        predictionId,
        "local",
        result.confidence,
        result.explanation,
        result.diffPatch,
        null,
        null,
        JSON.stringify({
          provider,
          model: result.model,
          providerName: result.provider,
          sessionId: result.sessionId,
          rawContent: result.rawContent,
          contextDigest,
          preparedAt: prepared.preparedAt,
          resolutionConfig
        }),
        createdAt,
        createdAt
      ]
    );
    const row = getProposalRow(proposalId);
    if (!row) throw new Error("Failed to persist conflict proposal");
    if (resolutionConfig.autonomy === "auto_apply" && typeof result.confidence === "number" && result.confidence >= resolutionConfig.autoApplyThreshold && result.diffPatch.trim().length > 0) {
      try {
        const applyMode = mapPostResolutionToApplyMode(resolutionConfig.postResolution) ?? "staged";
        const generatedCommitMessage = applyMode === "commit" ? `Resolve conflicts in ${lane.name} (${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)})` : void 0;
        return await applyProposal({
          laneId,
          proposalId,
          applyMode,
          ...generatedCommitMessage ? { commitMessage: generatedCommitMessage } : {}
        });
      } catch (error) {
        logger.warn("conflicts.proposal_auto_apply_failed", {
          laneId,
          peerLaneId,
          proposalId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    return rowToProposal(row);
  };
  const ensureIntegrationLane = async (args) => {
    const name = (args.integrationLaneName ?? "Integration lane").trim() || "Integration lane";
    const lanes = await laneService.list({ includeArchived: false });
    const existing = lanes.find((lane) => !lane.archivedAt && lane.name === name);
    if (existing) return existing;
    return await laneService.create({
      name,
      description: `Auto-created integration lane for conflict resolution into ${args.targetLaneId}.`,
      parentLaneId: args.targetLaneId
    });
  };
  const buildPackRefsBlock = (packRefs) => {
    const lines = [];
    lines.push("## ADE Pack References");
    for (const ref of packRefs) {
      const tags = [ref.required ? "required" : "optional", ref.exists ? "present" : "missing"];
      const laneInfo = ref.laneId ? ` lane=${ref.laneId}` : "";
      const peerInfo = ref.peerLaneId ? ` peer=${ref.peerLaneId}` : "";
      lines.push(`- ${ref.kind}${laneInfo}${peerInfo} [${tags.join(", ")}]`);
      lines.push(`  - path: ${ref.absPath}`);
      lines.push(`  - repo: ${ref.repoRelativePath}`);
    }
    lines.push("");
    return lines;
  };
  const buildGuardrailsBlock = () => {
    const lines = [];
    lines.push("## Guardrails (Non-Negotiable)");
    lines.push("- Do not modify non-relevant files.");
    lines.push("- Do not run: git add, git commit, git push, git rebase, git merge, git cherry-pick, git reset.");
    lines.push("- Keep conflict-resolution work sequential; do not spawn parallel editing agents.");
    lines.push("- Respect staleness markers and insufficient-context signals.");
    lines.push("- If context is insufficient, do not fabricate changes.");
    lines.push("- If blocked, print `INSUFFICIENT_CONTEXT` followed by a concrete gap list.");
    lines.push("");
    return lines;
  };
  const buildPairContextBlock = (contexts) => {
    const lines = [];
    lines.push("## Pair Context (Structured)");
    for (const ctx of contexts) {
      lines.push(`### Pair ${ctx.laneId} -> ${ctx.peerLaneId ?? "base"}`);
      lines.push(`- Prepared at: ${ctx.preview.preparedAt}`);
      lines.push(`- Context digest: ${ctx.preview.contextDigest}`);
      lines.push(`- Existing proposal: ${ctx.preview.existingProposalId ?? "none"}`);
      lines.push(`- Preview warnings: ${ctx.preview.warnings.join(" | ") || "none"}`);
      lines.push(`- Relevant files count: ${ctx.preview.files.length}`);
      lines.push("```json");
      lines.push(
        JSON.stringify(
          {
            laneId: ctx.laneId,
            peerLaneId: ctx.peerLaneId,
            stats: ctx.preview.stats,
            files: ctx.preview.files.map((file) => ({
              path: file.path,
              includeReason: file.includeReason
            })),
            conflictContext: ctx.conflictContext ?? null
          },
          null,
          2
        )
      );
      lines.push("```");
      lines.push("");
    }
    return lines;
  };
  const buildOutputContractBlock = () => {
    const lines = [];
    lines.push("## Output Contract");
    lines.push("Done. Here's what changed:");
    lines.push("- file: <repo-path>");
    lines.push("- rationale: <one sentence>");
    lines.push("- unresolved: <none|short note>");
    lines.push("");
    lines.push("If blocked:");
    lines.push("INSUFFICIENT_CONTEXT");
    lines.push("- gap: <missing artifact, file, or decision>");
    lines.push("- requested_action: <what user should provide>");
    lines.push("");
    return lines;
  };
  const buildSingleMergePrompt = (args) => {
    const lines = [];
    lines.push("# ADE External Conflict Resolver");
    lines.push("");
    lines.push("## Objective");
    lines.push("- Resolve merge conflicts using ADE context packs first, then code/docs as needed.");
    lines.push("- Apply edits in the execution lane worktree only.");
    lines.push("- Do not commit, push, or stage changes.");
    lines.push("");
    lines.push("## Run Metadata");
    lines.push(`- Scenario: single-merge`);
    lines.push(`- Target lane: ${args.targetLaneId}`);
    lines.push(`- Source lanes: ${args.sourceLaneIds.join(", ")}`);
    lines.push(`- Execution lane (cwd): ${args.cwdLaneId}`);
    lines.push(`- Integration lane: ${args.integrationLaneId ?? "(not used)"}`);
    lines.push("");
    lines.push("## Required Read Order");
    lines.push("1) Read all required ADE pack files listed below.");
    lines.push("2) Read optional ADE docs if present.");
    lines.push("3) Read additional repository files only when needed to resolve conflicts safely.");
    lines.push("");
    lines.push(...buildPackRefsBlock(args.packRefs));
    lines.push(...buildGuardrailsBlock());
    lines.push("## Strategy");
    lines.push("- Merge the single source lane into the target lane.");
    lines.push("- Resolve each conflicting file using pack context to determine correct resolution.");
    lines.push("- Verify that no unrelated files are modified.");
    lines.push("");
    lines.push(...buildPairContextBlock(args.contexts));
    lines.push(...buildOutputContractBlock());
    return `${lines.join("\n").trim()}
`;
  };
  const buildSequentialMergePrompt = (args) => {
    const lines = [];
    lines.push("# ADE External Conflict Resolver");
    lines.push("");
    lines.push("## Objective");
    lines.push("- Resolve merge conflicts across multiple source lanes sequentially.");
    lines.push("- Apply edits in the execution lane worktree only.");
    lines.push("- Do not commit, push, or stage changes.");
    lines.push("");
    lines.push("## Run Metadata");
    lines.push(`- Scenario: sequential-merge`);
    lines.push(`- Target lane: ${args.targetLaneId}`);
    lines.push(`- Source lanes: ${args.sourceLaneIds.join(", ")}`);
    lines.push(`- Execution lane (cwd): ${args.cwdLaneId}`);
    lines.push(`- Integration lane: ${args.integrationLaneId ?? "(not used)"}`);
    lines.push("");
    lines.push("## Required Read Order");
    lines.push("1) Read all required ADE pack files listed below.");
    lines.push("2) Read optional ADE docs if present.");
    lines.push("3) Read additional repository files only when needed to resolve conflicts safely.");
    lines.push("");
    lines.push(...buildPackRefsBlock(args.packRefs));
    lines.push(...buildGuardrailsBlock());
    lines.push("## Strategy");
    lines.push("- Process source lanes in order: " + args.sourceLaneIds.join(" -> ") + ".");
    lines.push("- For each source lane, resolve conflicts against the current worktree state.");
    lines.push("- After resolving each source, verify the worktree is clean before proceeding to the next.");
    lines.push("- Accumulate changes; do not revert between sources.");
    lines.push("");
    lines.push(...buildPairContextBlock(args.contexts));
    lines.push(...buildOutputContractBlock());
    return `${lines.join("\n").trim()}
`;
  };
  const buildIntegrationMergePrompt = (args) => {
    const lines = [];
    lines.push("# ADE External Conflict Resolver");
    lines.push("");
    lines.push("## Objective");
    lines.push("- Resolve merge conflicts by integrating multiple source lanes into a dedicated integration lane.");
    lines.push("- Apply edits in the integration lane worktree only.");
    lines.push("- Do not commit, push, or stage changes.");
    lines.push("");
    lines.push("## Run Metadata");
    lines.push(`- Scenario: integration-merge`);
    lines.push(`- Target lane: ${args.targetLaneId}`);
    lines.push(`- Source lanes: ${args.sourceLaneIds.join(", ")}`);
    lines.push(`- Execution lane (cwd): ${args.cwdLaneId}`);
    lines.push(`- Integration lane: ${args.integrationLaneId ?? "(not used)"}`);
    lines.push("");
    lines.push("## Required Read Order");
    lines.push("1) Read all required ADE pack files listed below.");
    lines.push("2) Read optional ADE docs if present.");
    lines.push("3) Read additional repository files only when needed to resolve conflicts safely.");
    lines.push("");
    lines.push(...buildPackRefsBlock(args.packRefs));
    lines.push(...buildGuardrailsBlock());
    lines.push("## Strategy");
    lines.push("- The integration lane aggregates changes from all source lanes.");
    lines.push("- Resolve all conflicts holistically, considering interactions between source lanes.");
    lines.push("- Ensure the integration lane cleanly merges all source contributions.");
    lines.push("- Pay special attention to files modified by multiple source lanes.");
    lines.push("");
    lines.push(...buildPairContextBlock(args.contexts));
    lines.push(...buildOutputContractBlock());
    return `${lines.join("\n").trim()}
`;
  };
  const buildExternalResolverPrompt = (args) => {
    const scenario = args.scenario ?? (args.sourceLaneIds.length === 1 ? "single-merge" : args.integrationLaneId ? "integration-merge" : "sequential-merge");
    switch (scenario) {
      case "single-merge":
        return buildSingleMergePrompt(args);
      case "sequential-merge":
        return buildSequentialMergePrompt(args);
      case "integration-merge":
        return buildIntegrationMergePrompt(args);
      default:
        return buildSingleMergePrompt(args);
    }
  };
  const runExternalResolver = async (args) => {
    const targetLaneId = args.targetLaneId.trim();
    const sourceLaneIds = uniqueSorted2((args.sourceLaneIds ?? []).map((value) => value.trim()).filter(Boolean));
    if (!targetLaneId) throw new Error("targetLaneId is required");
    if (!sourceLaneIds.length) throw new Error("sourceLaneIds is required");
    const lanes = await listActiveLanes();
    const laneByIdMap = new Map(lanes.map((lane) => [lane.id, lane]));
    const targetLane = laneByIdMap.get(targetLaneId);
    if (!targetLane) throw new Error(`Target lane not found: ${targetLaneId}`);
    const integrationLane = sourceLaneIds.length > 1 ? await ensureIntegrationLane({ targetLaneId, integrationLaneName: args.integrationLaneName }) : null;
    const cwdLaneId = sourceLaneIds.length === 1 ? sourceLaneIds[0] : integrationLane.id;
    const cwdLane = laneByIdMap.get(cwdLaneId) ?? (integrationLane && integrationLane.id === cwdLaneId ? integrationLane : null);
    if (!cwdLane) throw new Error(`Execution lane not found: ${cwdLaneId}`);
    const contexts = [];
    const contextGaps = [];
    for (const sourceLaneId of sourceLaneIds) {
      const preview = await prepareProposal({ laneId: sourceLaneId, peerLaneId: targetLaneId });
      const prepared = preparedContexts.get(preview.contextDigest);
      const conflictContext = prepared?.conflictContext ?? null;
      const cc = isRecord2(conflictContext) && isRecord2(conflictContext.conflictContext) ? conflictContext.conflictContext : conflictContext;
      const insufficient = isRecord2(cc) && Boolean(cc.insufficientContext);
      if (insufficient) {
        const reasons = Array.isArray(cc.insufficientReasons) ? cc.insufficientReasons.map((value) => String(value)) : [];
        if (!reasons.length) {
          contextGaps.push({
            code: "insufficient_context",
            message: `${sourceLaneId} -> ${targetLaneId}: insufficient_context_flagged`
          });
        } else {
          for (const reason of reasons) {
            contextGaps.push({
              code: "insufficient_context",
              message: `${sourceLaneId} -> ${targetLaneId}: ${reason}`
            });
          }
        }
      }
      contexts.push({
        laneId: sourceLaneId,
        peerLaneId: targetLaneId,
        preview,
        conflictContext: prepared?.conflictContext ?? null
      });
    }
    const packRefs = buildExternalResolverPackRefs({
      targetLaneId,
      sourceLaneIds,
      cwdLaneId,
      integrationLaneId: integrationLane?.id ?? null,
      contexts: contexts.map((entry) => ({ laneId: entry.laneId, peerLaneId: entry.peerLaneId }))
    });
    const missingRequiredPacks = packRefs.filter((entry) => entry.required && !entry.exists).map((entry) => entry.repoRelativePath);
    const runId = (0, import_node_crypto6.randomUUID)();
    const runDir = import_node_path7.default.join(externalRunsRootDir, runId);
    import_node_fs8.default.mkdirSync(runDir, { recursive: true });
    const startedAt = (/* @__PURE__ */ new Date()).toISOString();
    if (contextGaps.length > 0) {
      const blocked = {
        schema: "ade.conflictExternalRun.v1",
        runId,
        provider: args.provider,
        status: "blocked",
        startedAt,
        completedAt: (/* @__PURE__ */ new Date()).toISOString(),
        targetLaneId,
        sourceLaneIds,
        cwdLaneId,
        integrationLaneId: integrationLane?.id ?? null,
        command: [],
        summary: "Insufficient context blocked external resolver execution.",
        patchPath: null,
        logPath: null,
        insufficientContext: true,
        contextGaps,
        warnings: [
          "insufficient_context_blocked",
          ...missingRequiredPacks.map((relPath) => `missing_pack:${relPath}`)
        ],
        committedAt: null,
        commitSha: null,
        commitMessage: null,
        error: null
      };
      writeExternalRunRecord(blocked);
      return toRunSummary(blocked);
    }
    const prompt = buildExternalResolverPrompt({
      targetLaneId,
      sourceLaneIds,
      contexts,
      packRefs,
      cwdLaneId,
      integrationLaneId: integrationLane?.id ?? null
    });
    const promptPath = import_node_path7.default.join(runDir, "prompt.md");
    import_node_fs8.default.writeFileSync(promptPath, prompt, "utf8");
    const commandTemplate = resolveExternalResolverCommand(args.provider);
    if (!commandTemplate.length) {
      const missing = {
        schema: "ade.conflictExternalRun.v1",
        runId,
        provider: args.provider,
        status: "failed",
        startedAt,
        completedAt: (/* @__PURE__ */ new Date()).toISOString(),
        targetLaneId,
        sourceLaneIds,
        cwdLaneId,
        integrationLaneId: integrationLane?.id ?? null,
        command: [],
        summary: null,
        patchPath: null,
        logPath: null,
        insufficientContext: false,
        contextGaps: [],
        warnings: [
          "resolver_command_missing_in_config",
          ...missingRequiredPacks.map((relPath) => `missing_pack:${relPath}`)
        ],
        committedAt: null,
        commitSha: null,
        commitMessage: null,
        error: "No external resolver command configured for provider."
      };
      writeExternalRunRecord(missing);
      return toRunSummary(missing);
    }
    const renderedCommand = commandTemplate.map(
      (token) => token.replace(/\{\{promptFile\}\}/g, promptPath).replace(/\{\{projectRoot\}\}/g, projectRoot).replace(/\{\{targetLaneId\}\}/g, targetLaneId).replace(/\{\{sourceLaneIds\}\}/g, sourceLaneIds.join(",")).replace(/\{\{runDir\}\}/g, runDir)
    );
    const bin = renderedCommand[0];
    if (!bin) {
      throw new Error("Invalid external resolver command template");
    }
    const proc = (0, import_node_child_process2.spawnSync)(bin, renderedCommand.slice(1), {
      cwd: cwdLane.worktreePath,
      encoding: "utf8",
      timeout: 8 * 6e4,
      maxBuffer: 8 * 1024 * 1024
    });
    const stdout = proc.stdout ?? "";
    const stderr = proc.stderr ?? "";
    const outputLogPath = import_node_path7.default.join(runDir, "output.log");
    import_node_fs8.default.writeFileSync(outputLogPath, `${stdout}

--- STDERR ---
${stderr}
`, "utf8");
    const diffResult = await runGit(["diff", "--binary"], {
      cwd: cwdLane.worktreePath,
      timeoutMs: 45e3,
      maxOutputBytes: EXTERNAL_DIFF_MAX_OUTPUT_BYTES
    });
    const patchPath = import_node_path7.default.join(runDir, "changes.patch");
    let finalPatchPath = null;
    if (diffResult.exitCode === 0 && diffResult.stdout.trim().length > 0) {
      import_node_fs8.default.writeFileSync(patchPath, diffResult.stdout, "utf8");
      finalPatchPath = patchPath;
    }
    const status = proc.status === 0 ? "completed" : "failed";
    const runRecord = {
      schema: "ade.conflictExternalRun.v1",
      runId,
      provider: args.provider,
      status,
      startedAt,
      completedAt: (/* @__PURE__ */ new Date()).toISOString(),
      targetLaneId,
      sourceLaneIds,
      cwdLaneId,
      integrationLaneId: integrationLane?.id ?? null,
      command: renderedCommand,
      summary: extractResolverSummary(stdout),
      patchPath: finalPatchPath,
      logPath: outputLogPath,
      insufficientContext: false,
      contextGaps: [],
      warnings: [
        ...proc.signal ? [`process_signal:${proc.signal}`] : [],
        ...diffResult.stdoutTruncated ? ["git_diff_stdout_truncated"] : [],
        ...diffResult.stderrTruncated ? ["git_diff_stderr_truncated"] : [],
        ...missingRequiredPacks.map((relPath) => `missing_pack:${relPath}`)
      ],
      committedAt: null,
      commitSha: null,
      commitMessage: null,
      error: proc.status === 0 ? null : stderr.trim() || `Exit code ${proc.status ?? -1}`
    };
    writeExternalRunRecord(runRecord);
    return toRunSummary(runRecord);
  };
  const listExternalResolverRuns = (args = {}) => {
    const laneId = typeof args.laneId === "string" ? args.laneId.trim() : "";
    const limit = Number.isFinite(Number(args.limit)) ? Math.max(1, Number(args.limit)) : 20;
    const records = listExternalRunRecords().filter(
      (run) => laneId ? run.targetLaneId === laneId || run.cwdLaneId === laneId || run.sourceLaneIds.includes(laneId) : true
    );
    return records.slice(0, limit).map(toRunSummary);
  };
  const commitExternalResolverRun = async (args) => {
    const runId = args.runId.trim();
    if (!runId) throw new Error("runId is required");
    const run = readExternalRunRecord(runId);
    if (!run) throw new Error(`External resolver run not found: ${runId}`);
    if (run.status !== "completed") throw new Error("Only completed resolver runs can be committed.");
    if (!run.patchPath || !import_node_fs8.default.existsSync(run.patchPath)) {
      throw new Error("Resolver run has no patch artifact to commit.");
    }
    if (run.commitSha && run.committedAt) {
      throw new Error(`Resolver run already committed at ${run.committedAt}.`);
    }
    const laneId = run.cwdLaneId;
    const lane = laneService.getLaneBaseAndBranch(laneId);
    const patchBody = import_node_fs8.default.readFileSync(run.patchPath, "utf8");
    const touchedPaths = extractCommitPathsFromUnifiedDiff(patchBody);
    if (!touchedPaths.length) throw new Error("Resolver patch has no changed paths.");
    const normalizedPaths = touchedPaths.map((entry) => ensureRelativeRepoPath2(entry));
    const commitMessage = args.message?.trim() || `Resolve conflicts via ADE ${run.provider} external resolver`;
    await runGitOrThrow(["add", "--", ...normalizedPaths], { cwd: lane.worktreePath, timeoutMs: 6e4 });
    const commitRes = await runGit(
      ["commit", "-m", commitMessage, "--", ...normalizedPaths],
      { cwd: lane.worktreePath, timeoutMs: 9e4 }
    );
    if (commitRes.exitCode !== 0) {
      const reason = commitRes.stderr.trim() || commitRes.stdout.trim() || "Failed to create commit.";
      throw new Error(reason);
    }
    const commitSha = await readHeadSha(lane.worktreePath);
    const committedAt = (/* @__PURE__ */ new Date()).toISOString();
    writeExternalRunRecord({
      ...run,
      committedAt,
      commitSha,
      commitMessage
    });
    return {
      runId,
      laneId,
      commitSha,
      message: commitMessage,
      committedPaths: normalizedPaths
    };
  };
  const applyProposal = async (args) => {
    const row = getProposalRow(args.proposalId);
    if (!row || row.lane_id !== args.laneId) {
      throw new Error(`Proposal not found: ${args.proposalId}`);
    }
    if (!row.diff_patch.trim()) {
      throw new Error("Proposal does not include a diff patch");
    }
    const resolutionConfig = readConflictResolutionConfig();
    const applyMode = args.applyMode ?? mapPostResolutionToApplyMode(resolutionConfig.postResolution) ?? "staged";
    const commitMessage = args.commitMessage?.trim() ?? (applyMode === "commit" ? `Resolve conflicts via ADE (${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10)})` : "");
    if (applyMode === "commit" && !commitMessage) {
      throw new Error("commitMessage is required when applyMode='commit'");
    }
    const lane = laneService.getLaneBaseAndBranch(args.laneId);
    const preHeadSha = await readHeadSha(lane.worktreePath);
    const operation = operationService?.start({
      laneId: args.laneId,
      kind: "conflict_proposal_apply",
      preHeadSha,
      metadata: {
        proposalId: args.proposalId,
        applyMode
      }
    });
    const patchFile = writePatchFile(row.diff_patch);
    try {
      const applyResult = await runGit(
        ["apply", "--3way", "--whitespace=nowarn", patchFile],
        { cwd: lane.worktreePath, timeoutMs: 6e4 }
      );
      if (applyResult.exitCode !== 0) {
        throw new Error(applyResult.stderr.trim() || "Failed to apply conflict proposal patch");
      }
      const touchedFiles = extractPathsFromUnifiedDiff(row.diff_patch);
      if (applyMode === "staged" || applyMode === "commit") {
        if (touchedFiles.length) {
          await runGitOrThrow(["add", "--", ...touchedFiles], { cwd: lane.worktreePath, timeoutMs: 6e4 });
        } else {
          await runGitOrThrow(["add", "-A"], { cwd: lane.worktreePath, timeoutMs: 6e4 });
        }
      }
      let appliedCommitSha = null;
      if (applyMode === "commit") {
        await runGitOrThrow(["commit", "-m", commitMessage], { cwd: lane.worktreePath, timeoutMs: 6e4 });
        appliedCommitSha = await readHeadSha(lane.worktreePath);
      }
      const postHeadSha = await readHeadSha(lane.worktreePath);
      if (operationService && operation) {
        operationService.finish({
          operationId: operation.operationId,
          status: "succeeded",
          postHeadSha,
          metadataPatch: {
            proposalId: args.proposalId,
            ...appliedCommitSha ? { appliedCommitSha } : {}
          }
        });
      }
      const now = (/* @__PURE__ */ new Date()).toISOString();
      const nextMetadata = {
        ...safeParseMetadata2(row.metadata_json),
        applyMode,
        ...commitMessage ? { commitMessage } : {},
        ...appliedCommitSha ? { appliedCommitSha } : {}
      };
      db.run(
        `
          update conflict_proposals
          set status = 'applied',
              applied_operation_id = ?,
              metadata_json = ?,
              updated_at = ?
          where id = ?
            and project_id = ?
        `,
        [operation?.operationId ?? null, JSON.stringify(nextMetadata), now, args.proposalId, projectId]
      );
    } catch (error) {
      const postHeadSha = await readHeadSha(lane.worktreePath);
      if (operationService && operation) {
        operationService.finish({
          operationId: operation.operationId,
          status: "failed",
          postHeadSha,
          metadataPatch: {
            error: error instanceof Error ? error.message : String(error)
          }
        });
      }
      throw error;
    } finally {
      deletePatchFile(patchFile);
    }
    const updated = getProposalRow(args.proposalId);
    if (!updated) {
      throw new Error(`Proposal not found after apply: ${args.proposalId}`);
    }
    return rowToProposal(updated);
  };
  const undoProposal = async (args) => {
    const row = getProposalRow(args.proposalId);
    if (!row || row.lane_id !== args.laneId) {
      throw new Error(`Proposal not found: ${args.proposalId}`);
    }
    if (row.status !== "applied") {
      throw new Error("Only applied proposals can be undone");
    }
    const lane = laneService.getLaneBaseAndBranch(args.laneId);
    const preHeadSha = await readHeadSha(lane.worktreePath);
    const operation = operationService?.start({
      laneId: args.laneId,
      kind: "conflict_proposal_undo",
      preHeadSha,
      metadata: {
        proposalId: args.proposalId
      }
    });
    try {
      const metadata = safeParseMetadata2(row.metadata_json);
      const applyMode = typeof metadata.applyMode === "string" ? metadata.applyMode : "unstaged";
      const appliedCommitSha = typeof metadata.appliedCommitSha === "string" ? metadata.appliedCommitSha : "";
      if (applyMode === "commit" && appliedCommitSha.trim()) {
        await runGitOrThrow(["revert", "--no-edit", appliedCommitSha.trim()], { cwd: lane.worktreePath, timeoutMs: 9e4 });
      } else {
        const patchFile = writePatchFile(row.diff_patch);
        try {
          const undoResult = await runGit(
            ["apply", "-R", "--3way", "--whitespace=nowarn", patchFile],
            { cwd: lane.worktreePath, timeoutMs: 6e4 }
          );
          if (undoResult.exitCode !== 0) {
            throw new Error(undoResult.stderr.trim() || "Failed to undo applied proposal patch");
          }
        } finally {
          deletePatchFile(patchFile);
        }
      }
      const postHeadSha = await readHeadSha(lane.worktreePath);
      if (operationService && operation) {
        operationService.finish({
          operationId: operation.operationId,
          status: "succeeded",
          postHeadSha,
          metadataPatch: {
            proposalId: args.proposalId
          }
        });
      }
      const now = (/* @__PURE__ */ new Date()).toISOString();
      db.run(
        `
          update conflict_proposals
          set status = 'pending',
              applied_operation_id = null,
              metadata_json = ?,
              updated_at = ?
          where id = ?
            and project_id = ?
        `,
        [JSON.stringify({ ...safeParseMetadata2(row.metadata_json), applyMode: "unstaged", appliedCommitSha: null }), now, args.proposalId, projectId]
      );
    } catch (error) {
      const postHeadSha = await readHeadSha(lane.worktreePath);
      if (operationService && operation) {
        operationService.finish({
          operationId: operation.operationId,
          status: "failed",
          postHeadSha,
          metadataPatch: {
            error: error instanceof Error ? error.message : String(error)
          }
        });
      }
      throw error;
    } finally {
    }
    const updated = getProposalRow(args.proposalId);
    if (!updated) {
      throw new Error(`Proposal not found after undo: ${args.proposalId}`);
    }
    return rowToProposal(updated);
  };
  const prepareResolverSession = async (args) => {
    const targetLaneId = args.targetLaneId.trim();
    const sourceLaneIds = uniqueSorted2((args.sourceLaneIds ?? []).map((value) => value.trim()).filter(Boolean));
    if (!targetLaneId) throw new Error("targetLaneId is required");
    if (!sourceLaneIds.length) throw new Error("sourceLaneIds is required");
    const lanes = await listActiveLanes();
    const laneByIdMap = new Map(lanes.map((lane) => [lane.id, lane]));
    const targetLane = laneByIdMap.get(targetLaneId);
    if (!targetLane) throw new Error(`Target lane not found: ${targetLaneId}`);
    const scenario = args.scenario ?? (sourceLaneIds.length === 1 ? "single-merge" : args.integrationLaneName ? "integration-merge" : "sequential-merge");
    const integrationLane = scenario === "integration-merge" ? await ensureIntegrationLane({ targetLaneId, integrationLaneName: args.integrationLaneName }) : null;
    const requestedCwdLaneId = typeof args.cwdLaneId === "string" ? args.cwdLaneId.trim() : "";
    const defaultCwdLaneId = sourceLaneIds.length === 1 ? sourceLaneIds[0] : integrationLane?.id ?? sourceLaneIds[0];
    let cwdLaneId = defaultCwdLaneId;
    if (sourceLaneIds.length > 1 && integrationLane?.id) {
      cwdLaneId = integrationLane.id;
    } else if (requestedCwdLaneId && (requestedCwdLaneId === targetLaneId || sourceLaneIds.includes(requestedCwdLaneId))) {
      cwdLaneId = requestedCwdLaneId;
    }
    const cwdLane = laneByIdMap.get(cwdLaneId) ?? (integrationLane && integrationLane.id === cwdLaneId ? integrationLane : null);
    if (!cwdLane) throw new Error(`Execution lane not found: ${cwdLaneId}`);
    const contexts = [];
    const contextGaps = [];
    for (const sourceLaneId of sourceLaneIds) {
      const preview = await prepareProposal({ laneId: sourceLaneId, peerLaneId: targetLaneId });
      const prepared = preparedContexts.get(preview.contextDigest);
      const conflictContext = prepared?.conflictContext ?? null;
      const cc = isRecord2(conflictContext) && isRecord2(conflictContext.conflictContext) ? conflictContext.conflictContext : conflictContext;
      const insufficient = isRecord2(cc) && Boolean(cc.insufficientContext);
      if (insufficient) {
        const reasons = Array.isArray(cc.insufficientReasons) ? cc.insufficientReasons.map((value) => String(value)) : [];
        if (!reasons.length) {
          contextGaps.push({
            code: "insufficient_context",
            message: `${sourceLaneId} -> ${targetLaneId}: insufficient_context_flagged`
          });
        } else {
          for (const reason of reasons) {
            contextGaps.push({
              code: "insufficient_context",
              message: `${sourceLaneId} -> ${targetLaneId}: ${reason}`
            });
          }
        }
      }
      contexts.push({
        laneId: sourceLaneId,
        peerLaneId: targetLaneId,
        preview,
        conflictContext: prepared?.conflictContext ?? null
      });
    }
    const packRefs = buildExternalResolverPackRefs({
      targetLaneId,
      sourceLaneIds,
      cwdLaneId,
      integrationLaneId: integrationLane?.id ?? null,
      contexts: contexts.map((entry) => ({ laneId: entry.laneId, peerLaneId: entry.peerLaneId }))
    });
    const missingRequiredPacks = packRefs.filter((entry) => entry.required && !entry.exists).map((entry) => entry.repoRelativePath);
    const warnings = [
      ...missingRequiredPacks.map((relPath) => `missing_pack:${relPath}`)
    ];
    const status = contextGaps.length > 0 ? "blocked" : "ready";
    const runId = (0, import_node_crypto6.randomUUID)();
    const runDir = import_node_path7.default.join(externalRunsRootDir, runId);
    import_node_fs8.default.mkdirSync(runDir, { recursive: true });
    const prompt = buildExternalResolverPrompt({
      targetLaneId,
      sourceLaneIds,
      contexts,
      packRefs,
      cwdLaneId,
      integrationLaneId: integrationLane?.id ?? null,
      scenario
    });
    const promptPath = import_node_path7.default.join(runDir, "prompt.md");
    import_node_fs8.default.writeFileSync(promptPath, prompt, "utf8");
    const startedAt = (/* @__PURE__ */ new Date()).toISOString();
    const runRecord = {
      schema: "ade.conflictExternalRun.v1",
      runId,
      provider: args.provider,
      status: status === "blocked" ? "blocked" : "running",
      startedAt,
      completedAt: status === "blocked" ? startedAt : null,
      targetLaneId,
      sourceLaneIds,
      cwdLaneId,
      integrationLaneId: integrationLane?.id ?? null,
      command: [],
      summary: status === "blocked" ? "Insufficient context blocked external resolver execution." : null,
      patchPath: null,
      logPath: null,
      insufficientContext: contextGaps.length > 0,
      contextGaps,
      warnings,
      committedAt: null,
      commitSha: null,
      commitMessage: null,
      error: null
    };
    writeExternalRunRecord(runRecord);
    return {
      runId,
      promptFilePath: promptPath,
      cwdWorktreePath: cwdLane.worktreePath,
      cwdLaneId,
      integrationLaneId: integrationLane?.id ?? null,
      warnings,
      contextGaps,
      status
    };
  };
  const finalizeResolverSession = async (args) => {
    const runId = args.runId.trim();
    if (!runId) throw new Error("runId is required");
    const run = readExternalRunRecord(runId);
    if (!run) throw new Error(`External resolver run not found: ${runId}`);
    const cwdLane = laneService.getLaneBaseAndBranch(run.cwdLaneId);
    const diffResult = await runGit(["diff", "--binary"], {
      cwd: cwdLane.worktreePath,
      timeoutMs: 45e3,
      maxOutputBytes: EXTERNAL_DIFF_MAX_OUTPUT_BYTES
    });
    const runDir = import_node_path7.default.join(externalRunsRootDir, runId);
    const patchPath = import_node_path7.default.join(runDir, "changes.patch");
    let finalPatchPath = null;
    if (diffResult.exitCode === 0 && diffResult.stdout.trim().length > 0) {
      import_node_fs8.default.writeFileSync(patchPath, diffResult.stdout, "utf8");
      finalPatchPath = patchPath;
    }
    const completedAt = (/* @__PURE__ */ new Date()).toISOString();
    const status = args.exitCode === 0 ? "completed" : "failed";
    const updatedRecord = {
      ...run,
      status,
      completedAt,
      patchPath: finalPatchPath,
      warnings: [
        ...run.warnings ?? [],
        ...diffResult.stdoutTruncated ? ["git_diff_stdout_truncated"] : [],
        ...diffResult.stderrTruncated ? ["git_diff_stderr_truncated"] : []
      ],
      error: args.exitCode === 0 ? null : `Exit code ${args.exitCode}`
    };
    writeExternalRunRecord(updatedRecord);
    return toRunSummary(updatedRecord);
  };
  const suggestResolverTarget = async (args) => {
    const sourceLaneId = args.sourceLaneId.trim();
    const targetLaneId = args.targetLaneId.trim();
    if (!sourceLaneId || !targetLaneId) throw new Error("sourceLaneId and targetLaneId are required");
    const sourcePack = packService?.getLanePack(sourceLaneId);
    const targetPack = packService?.getLanePack(targetLaneId);
    const overlaps = await listOverlaps({ laneId: sourceLaneId });
    const targetOverlap = overlaps.find((entry) => entry.peerId === targetLaneId);
    const overlapCount = targetOverlap?.files.length ?? 0;
    if (overlapCount > 5) {
      return {
        suggestion: "target",
        reason: `High overlap count (${overlapCount}) suggests resolving in target to minimize coordination.`
      };
    }
    return {
      suggestion: "source",
      reason: `Low overlap count (${overlapCount}) suggests resolving in source for simpler integration.`
    };
  };
  const simulateChainedMerge = async (args) => {
    const lanes = await listActiveLanes();
    const laneMap = new Map(lanes.map((l) => [l.id, l]));
    const steps = [];
    let accumulatedSha = await readHeadSha(projectRoot, args.baseBranch);
    for (let i = 0; i < args.sourceLaneIds.length; i++) {
      const laneId = args.sourceLaneIds[i];
      const lane = laneMap.get(laneId);
      if (!lane) {
        steps.push({
          laneId,
          laneName: laneId,
          position: i,
          outcome: "blocked",
          conflictingFiles: [],
          diffStat: { insertions: 0, deletions: 0, filesChanged: 0 }
        });
        continue;
      }
      const laneHeadSha = await readHeadSha(lane.worktreePath, "HEAD");
      const mergeBase = await readMergeBase(projectRoot, accumulatedSha, laneHeadSha);
      const merge = await runGitMergeTree({
        cwd: projectRoot,
        mergeBase,
        branchA: accumulatedSha,
        branchB: laneHeadSha,
        timeoutMs: 6e4
      });
      const conflictingFiles = merge.conflicts.map((c) => ({
        path: c.path,
        conflictMarkers: c.markerPreview,
        oursExcerpt: null,
        theirsExcerpt: null,
        diffHunk: null
      }));
      const outcome = conflictingFiles.length > 0 ? "conflict" : merge.exitCode === 0 ? "clean" : "blocked";
      const numstat = await readDiffNumstat(projectRoot, mergeBase, laneHeadSha);
      steps.push({
        laneId,
        laneName: lane.name,
        position: i,
        outcome,
        conflictingFiles,
        diffStat: {
          insertions: numstat.insertions,
          deletions: numstat.deletions,
          filesChanged: numstat.files.size
        }
      });
      if (outcome === "clean" && merge.usedWriteTree && merge.stdout.trim()) {
        const firstLine = merge.stdout.trim().split(/\r?\n/)[0].trim();
        if (/^[0-9a-f]{40}$/.test(firstLine)) {
          accumulatedSha = firstLine;
        } else {
          accumulatedSha = laneHeadSha;
        }
      } else if (outcome === "clean") {
        accumulatedSha = laneHeadSha;
      }
    }
    return steps;
  };
  const scanRebaseNeeds = async () => {
    const lanes = await listActiveLanes();
    const needs = [];
    const nonPrimaryLanes = lanes.filter((l) => l.laneType !== "primary");
    for (const lane of nonPrimaryLanes) {
      try {
        const baseHead = await readHeadSha(projectRoot, lane.baseRef);
        const laneHead = await readHeadSha(lane.worktreePath, "HEAD");
        const behindRes = await runGit(
          ["rev-list", "--count", `${laneHead}..${baseHead}`],
          { cwd: projectRoot, timeoutMs: 15e3 }
        );
        const behindBy = behindRes.exitCode === 0 ? Number(behindRes.stdout.trim()) || 0 : 0;
        if (behindBy === 0) continue;
        const mergeBase = await readMergeBase(projectRoot, baseHead, laneHead);
        const merge = await runGitMergeTree({
          cwd: projectRoot,
          mergeBase,
          branchA: baseHead,
          branchB: laneHead,
          timeoutMs: 6e4
        });
        const conflictingFiles = merge.conflicts.map((c) => c.path);
        needs.push({
          laneId: lane.id,
          laneName: lane.name,
          baseBranch: lane.baseRef,
          behindBy,
          conflictPredicted: conflictingFiles.length > 0,
          conflictingFiles,
          prId: null,
          groupContext: null,
          dismissedAt: rebaseDismissed.get(lane.id) ?? null,
          deferredUntil: rebaseDeferred.get(lane.id) ?? null
        });
      } catch (err) {
        logger.warn(`scanRebaseNeeds: failed for lane ${lane.id}`, { error: err });
      }
    }
    if (onEvent) {
      onEvent({ type: "rebase-needs-updated", needs, timestamp: (/* @__PURE__ */ new Date()).toISOString() });
    }
    return needs;
  };
  const getRebaseNeed = async (laneId) => {
    const lanes = await listActiveLanes();
    const lane = lanes.find((l) => l.id === laneId);
    if (!lane || lane.laneType === "primary") return null;
    try {
      const baseHead = await readHeadSha(projectRoot, lane.baseRef);
      const laneHead = await readHeadSha(lane.worktreePath, "HEAD");
      const behindRes = await runGit(
        ["rev-list", "--count", `${laneHead}..${baseHead}`],
        { cwd: projectRoot, timeoutMs: 15e3 }
      );
      const behindBy = behindRes.exitCode === 0 ? Number(behindRes.stdout.trim()) || 0 : 0;
      if (behindBy === 0) return null;
      const mergeBase = await readMergeBase(projectRoot, baseHead, laneHead);
      const merge = await runGitMergeTree({
        cwd: projectRoot,
        mergeBase,
        branchA: baseHead,
        branchB: laneHead,
        timeoutMs: 6e4
      });
      const conflictingFiles = merge.conflicts.map((c) => c.path);
      return {
        laneId: lane.id,
        laneName: lane.name,
        baseBranch: lane.baseRef,
        behindBy,
        conflictPredicted: conflictingFiles.length > 0,
        conflictingFiles,
        prId: null,
        groupContext: null,
        dismissedAt: rebaseDismissed.get(lane.id) ?? null,
        deferredUntil: rebaseDeferred.get(lane.id) ?? null
      };
    } catch (err) {
      logger.warn(`getRebaseNeed: failed for lane ${laneId}`, { error: err });
      return null;
    }
  };
  const dismissRebase = (laneId) => {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    rebaseDismissed.set(laneId, now);
    try {
      db.run(
        `insert into rebase_dismissed(lane_id, project_id, dismissed_at)
         values (?, ?, ?)
         on conflict(lane_id, project_id) do update set dismissed_at = excluded.dismissed_at`,
        [laneId, projectId, now]
      );
    } catch {
    }
  };
  const deferRebase = (laneId, until) => {
    rebaseDeferred.set(laneId, until);
    try {
      db.run(
        `insert into rebase_deferred(lane_id, project_id, deferred_until)
         values (?, ?, ?)
         on conflict(lane_id, project_id) do update set deferred_until = excluded.deferred_until`,
        [laneId, projectId, until]
      );
    } catch {
    }
  };
  const rebaseLane = async (args) => {
    if (activeRebaseLanes.has(args.laneId)) {
      return {
        laneId: args.laneId,
        success: false,
        conflictingFiles: [],
        error: `Rebase already in progress for lane ${args.laneId}`
      };
    }
    activeRebaseLanes.add(args.laneId);
    try {
      const lanes = await listActiveLanes();
      const lane = lanes.find((l) => l.id === args.laneId);
      if (!lane) {
        return {
          laneId: args.laneId,
          success: false,
          conflictingFiles: [],
          error: `Lane ${args.laneId} not found`
        };
      }
      const dirtyCheck = await runGit(
        ["status", "--porcelain"],
        { cwd: lane.worktreePath, timeoutMs: 1e4 }
      );
      if (dirtyCheck.exitCode === 0 && dirtyCheck.stdout.trim().length > 0) {
        return {
          laneId: args.laneId,
          success: false,
          conflictingFiles: [],
          error: "Worktree has uncommitted changes. Commit or stash before rebasing."
        };
      }
      if (args.aiAssisted) {
        logger.info(`rebaseLane: AI-assisted rebase requested for lane ${args.laneId}`, {
          provider: args.provider ?? "codex",
          autoApplyThreshold: args.autoApplyThreshold
        });
      }
      if (onEvent) {
        onEvent({ type: "rebase-started", laneId: args.laneId, timestamp: (/* @__PURE__ */ new Date()).toISOString() });
      }
      const rebaseRes = await runGit(
        ["rebase", lane.baseRef],
        { cwd: lane.worktreePath, timeoutMs: 12e4 }
      );
      if (rebaseRes.exitCode === 0) {
        rebaseDismissed.delete(args.laneId);
        rebaseDeferred.delete(args.laneId);
        try {
          db.run(`delete from rebase_dismissed where lane_id = ? and project_id = ?`, [args.laneId, projectId]);
          db.run(`delete from rebase_deferred where lane_id = ? and project_id = ?`, [args.laneId, projectId]);
        } catch {
        }
        if (onEvent) {
          onEvent({ type: "rebase-completed", laneId: args.laneId, success: true, timestamp: (/* @__PURE__ */ new Date()).toISOString() });
        }
        return {
          laneId: args.laneId,
          success: true,
          conflictingFiles: [],
          resolvedByAi: false
        };
      }
      const statusRes = await runGit(
        ["diff", "--name-only", "--diff-filter=U"],
        { cwd: lane.worktreePath, timeoutMs: 15e3 }
      );
      const conflictingFiles = statusRes.exitCode === 0 ? parseDiffNameOnly2(statusRes.stdout) : [];
      const abortRes = await runGit(["rebase", "--abort"], { cwd: lane.worktreePath, timeoutMs: 15e3 });
      if (abortRes.exitCode !== 0) {
        logger.error(`rebaseLane: Failed to abort rebase for lane ${args.laneId}`, {
          stderr: abortRes.stderr
        });
      }
      if (onEvent) {
        onEvent({ type: "rebase-completed", laneId: args.laneId, success: false, timestamp: (/* @__PURE__ */ new Date()).toISOString() });
      }
      return {
        laneId: args.laneId,
        success: false,
        conflictingFiles,
        error: rebaseRes.stderr.trim() || "Rebase failed with conflicts",
        resolvedByAi: false
      };
    } finally {
      activeRebaseLanes.delete(args.laneId);
    }
  };
  return {
    getLaneStatus,
    listOverlaps,
    getRiskMatrix,
    simulateMerge,
    runPrediction,
    getBatchAssessment,
    listProposals,
    prepareProposal,
    requestProposal,
    runExternalResolver,
    listExternalResolverRuns,
    commitExternalResolverRun,
    applyProposal,
    undoProposal,
    prepareResolverSession,
    finalizeResolverSession,
    suggestResolverTarget,
    simulateChainedMerge,
    scanRebaseNeeds,
    getRebaseNeed,
    dismissRebase,
    deferRebase,
    rebaseLane
  };
}

// ../desktop/src/main/services/git/gitOperationsService.ts
var import_node_path9 = __toESM(require("path"), 1);

// ../desktop/src/main/services/git/gitConflictState.ts
var import_node_fs9 = __toESM(require("fs"), 1);
var import_node_path8 = __toESM(require("path"), 1);
function detectConflictKind(gitDir) {
  try {
    if (import_node_fs9.default.existsSync(import_node_path8.default.join(gitDir, "rebase-apply")) || import_node_fs9.default.existsSync(import_node_path8.default.join(gitDir, "rebase-merge"))) {
      return "rebase";
    }
    if (import_node_fs9.default.existsSync(import_node_path8.default.join(gitDir, "MERGE_HEAD"))) {
      return "merge";
    }
  } catch {
  }
  return null;
}
function parseNameOnly(stdout) {
  return Array.from(
    new Set(
      stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    )
  ).sort((a, b) => a.localeCompare(b));
}

// ../desktop/src/main/services/git/gitOperationsService.ts
function localBranchNameFromRemoteRef(ref) {
  const normalized = ref.trim();
  const slashIndex = normalized.indexOf("/");
  return slashIndex >= 0 ? normalized.slice(slashIndex + 1) : normalized;
}
function isUnsupportedIgnoreOtherWorktreesError(message) {
  return /unknown option.*ignore-other-worktrees|usage:\s*git\s+checkout\b/i.test(message);
}
function ensureRelativeRepoPath(relPath) {
  const normalized = relPath.trim().replace(/\\/g, "/");
  if (!normalized.length) throw new Error("File path is required");
  if (normalized.includes("\0")) throw new Error("Invalid file path");
  if (import_node_path9.default.isAbsolute(normalized)) throw new Error("Path must be repo-relative");
  if (normalized.startsWith("../") || normalized === ".." || normalized.includes("/../")) {
    throw new Error("Path escapes lane root");
  }
  return normalized;
}
async function getHeadSha2(worktreePath) {
  const res = await runGit(["rev-parse", "HEAD"], { cwd: worktreePath, timeoutMs: 8e3 });
  if (res.exitCode !== 0) return null;
  const sha = res.stdout.trim();
  return sha.length ? sha : null;
}
function parseDelimited(line) {
  return line.split("");
}
async function isWorktreeDirty(worktreePath) {
  const res = await runGit(["status", "--porcelain=v1"], { cwd: worktreePath, timeoutMs: 8e3 });
  if (res.exitCode !== 0) return false;
  return res.stdout.trim().length > 0;
}
async function isUntrackedFile(worktreePath, relPath) {
  const res = await runGit(["status", "--porcelain=v1", "--", relPath], { cwd: worktreePath, timeoutMs: 8e3 });
  if (res.exitCode !== 0) return false;
  const lines = res.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.some((line) => line.startsWith("??"));
}
async function getAbsoluteGitDir(worktreePath) {
  const res = await runGit(["rev-parse", "--absolute-git-dir"], { cwd: worktreePath, timeoutMs: 8e3 });
  if (res.exitCode !== 0) return null;
  const dir = res.stdout.trim();
  return dir.length ? dir : null;
}
function createGitOperationsService({
  laneService,
  operationService,
  logger,
  onHeadChanged,
  onWorktreeChanged
}) {
  const runLaneOperation = async ({
    laneId,
    kind,
    reason,
    metadata,
    fn
  }) => {
    const lane = laneService.getLaneBaseAndBranch(laneId);
    const preHeadSha = await getHeadSha2(lane.worktreePath);
    const operation = operationService.start({
      laneId,
      kind,
      preHeadSha,
      metadata: {
        reason,
        branchRef: lane.branchRef,
        baseRef: lane.baseRef,
        ...metadata ?? {}
      }
    });
    try {
      const result = await fn(lane);
      const postHeadSha = await getHeadSha2(lane.worktreePath);
      operationService.finish({
        operationId: operation.operationId,
        status: "succeeded",
        postHeadSha
      });
      if (onWorktreeChanged) {
        try {
          onWorktreeChanged({
            laneId,
            reason,
            operationId: operation.operationId,
            preHeadSha,
            postHeadSha
          });
        } catch {
        }
      }
      if (preHeadSha !== postHeadSha && onHeadChanged) {
        try {
          onHeadChanged({
            laneId,
            reason,
            operationId: operation.operationId,
            preHeadSha,
            postHeadSha
          });
        } catch {
        }
      }
      return {
        result,
        action: {
          operationId: operation.operationId,
          preHeadSha,
          postHeadSha
        }
      };
    } catch (error) {
      const postHeadSha = await getHeadSha2(lane.worktreePath);
      const message = error instanceof Error ? error.message : String(error);
      operationService.finish({
        operationId: operation.operationId,
        status: "failed",
        postHeadSha,
        metadataPatch: { error: message }
      });
      logger.warn("git.operation_failed", { laneId, kind, reason, error: message });
      throw error;
    }
  };
  const maybeFetchAndSync = async (lane, mode, baseRef) => {
    const dirty = await isWorktreeDirty(lane.worktreePath);
    if (dirty) {
      throw new Error("Lane has uncommitted changes. Commit or stash before sync.");
    }
    await runGitOrThrow(["fetch", "--prune"], { cwd: lane.worktreePath, timeoutMs: 6e4 });
    const treatConflictAsSuccess = async (expected) => {
      const gitDir = await getAbsoluteGitDir(lane.worktreePath);
      if (!gitDir) return false;
      const kind = detectConflictKind(gitDir);
      if (kind !== expected) return false;
      const unmergedRes = await runGit(["diff", "--name-only", "--diff-filter=U"], {
        cwd: lane.worktreePath,
        timeoutMs: 1e4
      });
      if (unmergedRes.exitCode !== 0) return false;
      return parseNameOnly(unmergedRes.stdout).length > 0;
    };
    if (mode === "rebase") {
      const res2 = await runGit(["rebase", baseRef], { cwd: lane.worktreePath, timeoutMs: 6e4 });
      if (res2.exitCode === 0) return;
      if (await treatConflictAsSuccess("rebase")) {
        logger.info("git.sync_rebase_conflict", { laneRef: lane.branchRef, baseRef });
        return;
      }
      throw new Error((res2.stderr || res2.stdout).trim() || "Failed to rebase");
    }
    const res = await runGit(["merge", "--no-edit", baseRef], { cwd: lane.worktreePath, timeoutMs: 6e4 });
    if (res.exitCode === 0) return;
    if (await treatConflictAsSuccess("merge")) {
      logger.info("git.sync_merge_conflict", { laneRef: lane.branchRef, baseRef });
      return;
    }
    throw new Error((res.stderr || res.stdout).trim() || "Failed to merge");
  };
  return {
    async stageFile(args) {
      const filePath = ensureRelativeRepoPath(args.path);
      const { action } = await runLaneOperation({
        laneId: args.laneId,
        kind: "git_stage",
        reason: "stage_file",
        metadata: { path: filePath },
        fn: async (lane) => {
          await runGitOrThrow(["add", "--", filePath], { cwd: lane.worktreePath, timeoutMs: 15e3 });
        }
      });
      return action;
    },
    async stageAll(args) {
      const fileCount = Array.isArray(args.paths) ? args.paths.length : 0;
      const { action } = await runLaneOperation({
        laneId: args.laneId,
        kind: "git_stage_all",
        reason: "stage_all",
        metadata: { count: fileCount },
        fn: async (lane) => {
          await runGitOrThrow(["add", "-A", "--", "."], { cwd: lane.worktreePath, timeoutMs: 3e4 });
        }
      });
      return action;
    },
    async unstageAll(args) {
      const filePaths = args.paths.map(ensureRelativeRepoPath);
      const { action } = await runLaneOperation({
        laneId: args.laneId,
        kind: "git_unstage_all",
        reason: "unstage_all",
        metadata: { count: filePaths.length },
        fn: async (lane) => {
          if (filePaths.length === 0) return;
          await runGitOrThrow(["restore", "--staged", "--", ...filePaths], { cwd: lane.worktreePath, timeoutMs: 3e4 });
        }
      });
      return action;
    },
    async unstageFile(args) {
      const filePath = ensureRelativeRepoPath(args.path);
      const { action } = await runLaneOperation({
        laneId: args.laneId,
        kind: "git_unstage",
        reason: "unstage_file",
        metadata: { path: filePath },
        fn: async (lane) => {
          await runGitOrThrow(["restore", "--staged", "--", filePath], { cwd: lane.worktreePath, timeoutMs: 15e3 });
        }
      });
      return action;
    },
    async discardFile(args) {
      const filePath = ensureRelativeRepoPath(args.path);
      const { action } = await runLaneOperation({
        laneId: args.laneId,
        kind: "git_discard",
        reason: "discard_file",
        metadata: { path: filePath },
        fn: async (lane) => {
          const untracked = await isUntrackedFile(lane.worktreePath, filePath);
          if (untracked) {
            await runGitOrThrow(["clean", "-f", "--", filePath], { cwd: lane.worktreePath, timeoutMs: 15e3 });
            return;
          }
          await runGitOrThrow(["restore", "--worktree", "--", filePath], { cwd: lane.worktreePath, timeoutMs: 15e3 });
        }
      });
      return action;
    },
    async restoreStagedFile(args) {
      const filePath = ensureRelativeRepoPath(args.path);
      const { action } = await runLaneOperation({
        laneId: args.laneId,
        kind: "git_restore_staged",
        reason: "restore_staged_file",
        metadata: { path: filePath },
        fn: async (lane) => {
          await runGitOrThrow(["restore", "--staged", "--worktree", "--source=HEAD", "--", filePath], {
            cwd: lane.worktreePath,
            timeoutMs: 15e3
          });
        }
      });
      return action;
    },
    async commit(args) {
      const message = args.message.trim();
      if (!message.length) {
        throw new Error("Commit message is required");
      }
      const { action } = await runLaneOperation({
        laneId: args.laneId,
        kind: args.amend ? "git_commit_amend" : "git_commit",
        reason: args.amend ? "amend_commit" : "commit",
        metadata: { amend: Boolean(args.amend), message },
        fn: async (lane) => {
          const cmd = args.amend ? ["commit", "--amend", "-m", message] : ["commit", "-m", message];
          await runGitOrThrow(cmd, { cwd: lane.worktreePath, timeoutMs: 3e4 });
        }
      });
      return action;
    },
    async listRecentCommits(args) {
      const lane = laneService.getLaneBaseAndBranch(args.laneId);
      const limit = typeof args.limit === "number" ? Math.max(1, Math.min(200, Math.floor(args.limit))) : 30;
      const out = await runGitOrThrow(
        ["log", `-n${limit}`, "--date=iso-strict", "--pretty=format:%H%x1f%h%x1f%P%x1f%an%x1f%aI%x1f%s"],
        { cwd: lane.worktreePath, timeoutMs: 15e3 }
      );
      let unpushedShas = null;
      const upstreamRes = await runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], {
        cwd: lane.worktreePath,
        timeoutMs: 1e4
      });
      if (upstreamRes.exitCode === 0) {
        const upstream = upstreamRes.stdout.trim();
        if (upstream.length) {
          const unpushedRes = await runGit(["log", "--format=%H", `${upstream}..HEAD`], {
            cwd: lane.worktreePath,
            timeoutMs: 15e3
          });
          if (unpushedRes.exitCode === 0) {
            unpushedShas = new Set(
              unpushedRes.stdout.split("\n").map((l) => l.trim()).filter(Boolean)
            );
          }
        }
      }
      const rows = out.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
        const [sha, shortSha, parentsRaw, authorName, authoredAt, subject] = parseDelimited(line);
        if (!sha || !shortSha) return null;
        const parents = (parentsRaw ?? "").split(" ").map((entry) => entry.trim()).filter(Boolean);
        return {
          sha,
          shortSha,
          parents,
          authorName: authorName ?? "",
          authoredAt: authoredAt ?? "",
          subject: subject ?? "",
          pushed: unpushedShas ? !unpushedShas.has(sha) : false
        };
      }).filter((entry) => entry != null);
      return rows;
    },
    async getSyncStatus(args) {
      const lane = laneService.getLaneBaseAndBranch(args.laneId);
      const upstreamRes = await runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], {
        cwd: lane.worktreePath,
        timeoutMs: 1e4
      });
      if (upstreamRes.exitCode !== 0) {
        return {
          hasUpstream: false,
          upstreamRef: null,
          ahead: 0,
          behind: 0,
          diverged: false,
          recommendedAction: "push"
        };
      }
      const upstreamRef = upstreamRes.stdout.trim();
      if (!upstreamRef.length) {
        return {
          hasUpstream: false,
          upstreamRef: null,
          ahead: 0,
          behind: 0,
          diverged: false,
          recommendedAction: "push"
        };
      }
      const countRes = await runGit(["rev-list", "--left-right", "--count", `${upstreamRef}...HEAD`], {
        cwd: lane.worktreePath,
        timeoutMs: 1e4
      });
      if (countRes.exitCode !== 0) {
        return {
          hasUpstream: true,
          upstreamRef,
          ahead: 0,
          behind: 0,
          diverged: false,
          recommendedAction: "none"
        };
      }
      const parts = countRes.stdout.trim().split(/\s+/).filter(Boolean);
      const behind = Number.parseInt(parts[0] ?? "0", 10);
      const ahead = Number.parseInt(parts[1] ?? "0", 10);
      const normalizedBehind = Number.isFinite(behind) && behind > 0 ? behind : 0;
      const normalizedAhead = Number.isFinite(ahead) && ahead > 0 ? ahead : 0;
      const diverged = normalizedAhead > 0 && normalizedBehind > 0;
      let recommendedAction = "none";
      if (normalizedAhead > 0 && normalizedBehind === 0) {
        recommendedAction = "push";
      } else if (normalizedBehind > 0 && normalizedAhead === 0) {
        recommendedAction = "pull";
      } else if (diverged) {
        recommendedAction = "pull";
      }
      return {
        hasUpstream: true,
        upstreamRef,
        ahead: normalizedAhead,
        behind: normalizedBehind,
        diverged,
        recommendedAction
      };
    },
    async listCommitFiles(args) {
      const lane = laneService.getLaneBaseAndBranch(args.laneId);
      const sha = args.commitSha.trim();
      if (!sha.length) throw new Error("commitSha is required");
      const res = await runGitOrThrow(["show", "--pretty=format:", "--name-only", sha], {
        cwd: lane.worktreePath,
        timeoutMs: 12e3
      });
      return res.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    },
    async getCommitMessage(args) {
      const lane = laneService.getLaneBaseAndBranch(args.laneId);
      const sha = args.commitSha.trim();
      if (!sha.length) throw new Error("commitSha is required");
      const res = await runGitOrThrow(["show", "-s", "--format=%B", sha], {
        cwd: lane.worktreePath,
        timeoutMs: 12e3
      });
      const message = res.trimEnd();
      const MAX = 8e3;
      if (message.length > MAX) {
        return `${message.slice(0, MAX)}

...(truncated)...
`;
      }
      return message;
    },
    async revertCommit(args) {
      const commitSha = args.commitSha.trim();
      if (!commitSha.length) throw new Error("Commit SHA is required");
      const { action } = await runLaneOperation({
        laneId: args.laneId,
        kind: "git_revert",
        reason: "revert_commit",
        metadata: { commitSha },
        fn: async (lane) => {
          await runGitOrThrow(["revert", "--no-edit", commitSha], { cwd: lane.worktreePath, timeoutMs: 6e4 });
        }
      });
      return action;
    },
    async cherryPickCommit(args) {
      const commitSha = args.commitSha.trim();
      if (!commitSha.length) throw new Error("Commit SHA is required");
      const { action } = await runLaneOperation({
        laneId: args.laneId,
        kind: "git_cherry_pick",
        reason: "cherry_pick_commit",
        metadata: { commitSha },
        fn: async (lane) => {
          await runGitOrThrow(["cherry-pick", commitSha], { cwd: lane.worktreePath, timeoutMs: 6e4 });
        }
      });
      return action;
    },
    async stashPush(args) {
      const message = args.message?.trim();
      const { action } = await runLaneOperation({
        laneId: args.laneId,
        kind: "git_stash_push",
        reason: "stash_push",
        metadata: {
          includeUntracked: Boolean(args.includeUntracked),
          message: message ?? null
        },
        fn: async (lane) => {
          const cmd = ["stash", "push"];
          if (args.includeUntracked) cmd.push("-u");
          if (message) {
            cmd.push("-m", message);
          }
          await runGitOrThrow(cmd, { cwd: lane.worktreePath, timeoutMs: 3e4 });
        }
      });
      return action;
    },
    async listStashes(args) {
      const lane = laneService.getLaneBaseAndBranch(args.laneId);
      const out = await runGitOrThrow(["stash", "list", "--date=iso-strict", "--format=%gd%x1f%ci%x1f%gs"], {
        cwd: lane.worktreePath,
        timeoutMs: 15e3
      });
      return out.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => {
        const [ref, createdAt, subject] = parseDelimited(line);
        if (!ref) return null;
        return {
          ref,
          createdAt: createdAt && createdAt.length ? createdAt : null,
          subject: subject ?? ""
        };
      }).filter((entry) => entry != null);
    },
    async stashApply(args) {
      const stashRef = args.stashRef.trim();
      if (!stashRef.length) throw new Error("stashRef is required");
      const { action } = await runLaneOperation({
        laneId: args.laneId,
        kind: "git_stash_apply",
        reason: "stash_apply",
        metadata: { stashRef },
        fn: async (lane) => {
          await runGitOrThrow(["stash", "apply", stashRef], { cwd: lane.worktreePath, timeoutMs: 3e4 });
        }
      });
      return action;
    },
    async stashPop(args) {
      const stashRef = args.stashRef.trim();
      if (!stashRef.length) throw new Error("stashRef is required");
      const { action } = await runLaneOperation({
        laneId: args.laneId,
        kind: "git_stash_pop",
        reason: "stash_pop",
        metadata: { stashRef },
        fn: async (lane) => {
          await runGitOrThrow(["stash", "pop", stashRef], { cwd: lane.worktreePath, timeoutMs: 3e4 });
        }
      });
      return action;
    },
    async stashDrop(args) {
      const stashRef = args.stashRef.trim();
      if (!stashRef.length) throw new Error("stashRef is required");
      const { action } = await runLaneOperation({
        laneId: args.laneId,
        kind: "git_stash_drop",
        reason: "stash_drop",
        metadata: { stashRef },
        fn: async (lane) => {
          await runGitOrThrow(["stash", "drop", stashRef], { cwd: lane.worktreePath, timeoutMs: 3e4 });
        }
      });
      return action;
    },
    async fetch(args) {
      const { action } = await runLaneOperation({
        laneId: args.laneId,
        kind: "git_fetch",
        reason: "fetch",
        fn: async (lane) => {
          await runGitOrThrow(["fetch", "--prune"], { cwd: lane.worktreePath, timeoutMs: 6e4 });
        }
      });
      return action;
    },
    async sync(args) {
      const mode = args.mode ?? "merge";
      const { action } = await runLaneOperation({
        laneId: args.laneId,
        kind: mode === "rebase" ? "git_sync_rebase" : "git_sync_merge",
        reason: mode === "rebase" ? "sync_rebase" : "sync_merge",
        metadata: { mode, baseRefOverride: args.baseRef ?? null },
        fn: async (lane) => {
          const targetBase = args.baseRef?.trim() || lane.baseRef;
          await maybeFetchAndSync(lane, mode, targetBase);
        }
      });
      return action;
    },
    async pull(args) {
      const { action } = await runLaneOperation({
        laneId: args.laneId,
        kind: "git_pull",
        reason: "pull_from_remote",
        metadata: {},
        fn: async (lane) => {
          await runGitOrThrow(["pull", "--ff-only"], { cwd: lane.worktreePath, timeoutMs: 6e4 });
        }
      });
      return action;
    },
    async push(args) {
      const forceWithLease = Boolean(args.forceWithLease);
      const { action } = await runLaneOperation({
        laneId: args.laneId,
        kind: forceWithLease ? "git_push_force_with_lease" : "git_push",
        reason: forceWithLease ? "push_force_with_lease" : "push",
        metadata: { forceWithLease },
        fn: async (lane) => {
          const upstreamRes = await runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], {
            cwd: lane.worktreePath,
            timeoutMs: 1e4
          });
          if (upstreamRes.exitCode === 0) {
            const cmd2 = ["push"];
            if (forceWithLease) cmd2.push("--force-with-lease");
            await runGitOrThrow(cmd2, { cwd: lane.worktreePath, timeoutMs: 6e4 });
            return;
          }
          const cmd = ["push", "-u", "origin", lane.branchRef];
          if (forceWithLease) {
            cmd.push("--force-with-lease");
          }
          await runGitOrThrow(cmd, { cwd: lane.worktreePath, timeoutMs: 6e4 });
        }
      });
      return action;
    },
    async getConflictState(args) {
      const laneId = args.laneId.trim();
      if (!laneId) throw new Error("laneId is required");
      const lane = laneService.getLaneBaseAndBranch(laneId);
      const gitDir = await getAbsoluteGitDir(lane.worktreePath);
      const kind = gitDir ? detectConflictKind(gitDir) : null;
      const unmergedRes = await runGit(["diff", "--name-only", "--diff-filter=U"], {
        cwd: lane.worktreePath,
        timeoutMs: 1e4
      });
      const conflictedFiles = unmergedRes.exitCode === 0 ? parseNameOnly(unmergedRes.stdout) : [];
      const inProgress = kind != null;
      return {
        laneId,
        kind,
        inProgress,
        conflictedFiles,
        canContinue: inProgress && conflictedFiles.length === 0,
        canAbort: inProgress
      };
    },
    async rebaseContinue(args) {
      const { action } = await runLaneOperation({
        laneId: args.laneId,
        kind: "git_rebase_continue",
        reason: "rebase_continue",
        fn: async (lane) => {
          await runGitOrThrow(["-c", "core.editor=true", "rebase", "--continue"], {
            cwd: lane.worktreePath,
            timeoutMs: 3e5
          });
        }
      });
      return action;
    },
    async rebaseAbort(args) {
      const { action } = await runLaneOperation({
        laneId: args.laneId,
        kind: "git_rebase_abort",
        reason: "rebase_abort",
        fn: async (lane) => {
          await runGitOrThrow(["rebase", "--abort"], { cwd: lane.worktreePath, timeoutMs: 3e5 });
        }
      });
      return action;
    },
    async mergeContinue(args) {
      const { action } = await runLaneOperation({
        laneId: args.laneId,
        kind: "git_merge_continue",
        reason: "merge_continue",
        fn: async (lane) => {
          const res = await runGit(["-c", "core.editor=true", "merge", "--continue"], {
            cwd: lane.worktreePath,
            timeoutMs: 3e5
          });
          if (res.exitCode === 0) return;
          const combined = `${res.stderr ?? ""}
${res.stdout ?? ""}`.trim();
          if (/unknown option.*--continue|usage:\\s*git\\s+merge\\b/i.test(combined)) {
            await runGitOrThrow(["-c", "core.editor=true", "commit", "--no-edit"], {
              cwd: lane.worktreePath,
              timeoutMs: 3e5
            });
            return;
          }
          throw new Error(combined || "Failed to continue merge");
        }
      });
      return action;
    },
    async mergeAbort(args) {
      const { action } = await runLaneOperation({
        laneId: args.laneId,
        kind: "git_merge_abort",
        reason: "merge_abort",
        fn: async (lane) => {
          await runGitOrThrow(["merge", "--abort"], { cwd: lane.worktreePath, timeoutMs: 3e5 });
        }
      });
      return action;
    },
    async listBranches(args) {
      const lane = laneService.getLaneBaseAndBranch(args.laneId);
      const out = await runGitOrThrow(
        ["for-each-ref", "--sort=refname", "--format=%(refname)	%(refname:short)	%(HEAD)	%(upstream:short)", "refs/heads", "refs/remotes"],
        { cwd: lane.worktreePath, timeoutMs: 15e3 }
      );
      const localBranches = /* @__PURE__ */ new Map();
      const remoteBranches = [];
      out.split("\n").map((line) => line.trimEnd()).filter(Boolean).forEach((line) => {
        const parts = line.split("	");
        const fullRef = parts[0]?.trim() ?? "";
        const shortRef = parts[1]?.trim() ?? "";
        if (!fullRef || !shortRef) return;
        if (fullRef.startsWith("refs/heads/")) {
          const isCurrent = (parts[2]?.trim() ?? "") === "*";
          const upstream = parts[3]?.trim() || null;
          localBranches.set(shortRef, { name: shortRef, isCurrent, isRemote: false, upstream });
          return;
        }
        if (fullRef.startsWith("refs/remotes/")) {
          if (shortRef.endsWith("/HEAD")) return;
          remoteBranches.push({
            name: shortRef,
            isCurrent: false,
            isRemote: true,
            upstream: null
          });
        }
      });
      const localNames = new Set(localBranches.keys());
      const dedupedRemotes = remoteBranches.filter((branch) => {
        const localCandidate = localBranchNameFromRemoteRef(branch.name);
        return !localNames.has(localCandidate);
      });
      const sortedLocals = Array.from(localBranches.values()).sort((a, b) => {
        if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      const sortedRemotes = dedupedRemotes.sort((a, b) => a.name.localeCompare(b.name));
      return [...sortedLocals, ...sortedRemotes];
    },
    async checkoutBranch(args) {
      const branchName = args.branchName.trim();
      if (!branchName.length) throw new Error("Branch name is required");
      const lane = laneService.getLaneBaseAndBranch(args.laneId);
      if (lane.laneType !== "primary") {
        throw new Error("Branch checkout is only supported on the primary lane");
      }
      const localExists = await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], {
        cwd: lane.worktreePath,
        timeoutMs: 8e3
      }).then((res) => res.exitCode === 0);
      const remoteExists = !localExists ? await runGit(["show-ref", "--verify", "--quiet", `refs/remotes/${branchName}`], {
        cwd: lane.worktreePath,
        timeoutMs: 8e3
      }).then((res) => res.exitCode === 0) : false;
      const trackRemoteBranch = !localExists && remoteExists;
      const resolvedBranchRef = trackRemoteBranch ? localBranchNameFromRemoteRef(branchName) : branchName;
      const { action } = await runLaneOperation({
        laneId: args.laneId,
        kind: "git_checkout_branch",
        reason: "checkout_branch",
        metadata: { branchName, trackRemoteBranch },
        fn: async (l) => {
          const preferredCmd = trackRemoteBranch ? ["checkout", "--track", "--ignore-other-worktrees", branchName] : ["checkout", "--ignore-other-worktrees", branchName];
          const fallbackCmd = trackRemoteBranch ? ["checkout", "--track", branchName] : ["checkout", branchName];
          const preferredRes = await runGit(preferredCmd, { cwd: l.worktreePath, timeoutMs: 6e4 });
          if (preferredRes.exitCode !== 0) {
            const combined = `${preferredRes.stderr ?? ""}
${preferredRes.stdout ?? ""}`.trim();
            if (isUnsupportedIgnoreOtherWorktreesError(combined)) {
              await runGitOrThrow(fallbackCmd, { cwd: l.worktreePath, timeoutMs: 6e4 });
            } else {
              throw new Error(combined || `Failed to checkout branch '${branchName}'`);
            }
          }
          laneService.updateBranchRef(args.laneId, resolvedBranchRef);
        }
      });
      return action;
    }
  };
}

// ../desktop/src/main/services/diffs/diffService.ts
var import_node_fs10 = __toESM(require("fs"), 1);
var import_node_path10 = __toESM(require("path"), 1);
function parseStatusKind(code) {
  if (code === "??") return "untracked";
  const c = code.replace(/[^A-Z]/g, "");
  if (c.includes("M")) return "modified";
  if (c.includes("A")) return "added";
  if (c.includes("D")) return "deleted";
  if (c.includes("R")) return "renamed";
  return "unknown";
}
function stripGitStatusPath(raw) {
  const idx = raw.indexOf("->");
  if (idx >= 0) return raw.slice(idx + 2).trim();
  return raw.trim();
}
function detectBinary(buf) {
  return buf.includes(0);
}
function readTextFileSafe(absPath, maxBytes) {
  try {
    const stat = import_node_fs10.default.statSync(absPath);
    if (!stat.isFile()) return { exists: false, text: "" };
    const size = stat.size;
    const toRead = Math.min(size, maxBytes);
    const fd = import_node_fs10.default.openSync(absPath, "r");
    try {
      const buf = Buffer.alloc(toRead);
      import_node_fs10.default.readSync(fd, buf, 0, buf.length, 0);
      if (detectBinary(buf)) return { exists: true, text: "", isBinary: true };
      const text = buf.toString("utf8");
      return { exists: true, text };
    } finally {
      import_node_fs10.default.closeSync(fd);
    }
  } catch {
    return { exists: false, text: "" };
  }
}
async function gitShowText(cwd, spec, maxBytes) {
  const res = await runGit(["show", spec], {
    cwd,
    timeoutMs: 1e4,
    maxOutputBytes: maxBytes + 64 * 1024
  });
  if (res.exitCode !== 0) return { exists: false, text: "" };
  const buf = Buffer.from(res.stdout, "utf8");
  if (detectBinary(buf)) return { exists: true, text: "", isBinary: true };
  if (buf.length > maxBytes) return { exists: true, text: buf.subarray(0, maxBytes).toString("utf8") };
  return { exists: true, text: res.stdout };
}
function createDiffService({ laneService }) {
  const MAX_TEXT_BYTES = 512 * 1024;
  return {
    async getChanges(laneId) {
      const { worktreePath } = laneService.getLaneBaseAndBranch(laneId);
      const res = await runGit(["status", "--porcelain=v1"], { cwd: worktreePath, timeoutMs: 12e3 });
      if (res.exitCode !== 0) {
        return { unstaged: [], staged: [] };
      }
      const unstaged = [];
      const staged = [];
      const lines = res.stdout.split("\n").map((l) => l.trimEnd()).filter(Boolean);
      for (const line of lines) {
        if (line.startsWith("??")) {
          const p2 = stripGitStatusPath(line.slice(2));
          unstaged.push({ path: p2, kind: "untracked" });
          continue;
        }
        const x = line[0] ?? " ";
        const y = line[1] ?? " ";
        const p = stripGitStatusPath(line.slice(2));
        const code = `${x}${y}`;
        const kind = parseStatusKind(code);
        if (x !== " " && x !== "?") staged.push({ path: p, kind });
        if (y !== " " && y !== "?") unstaged.push({ path: p, kind });
      }
      return { unstaged, staged };
    },
    async getFileDiff({
      laneId,
      filePath,
      mode,
      compareRef,
      compareTo
    }) {
      const { worktreePath } = laneService.getLaneBaseAndBranch(laneId);
      const abs = import_node_path10.default.join(worktreePath, filePath);
      if (mode === "staged") {
        const head = await gitShowText(worktreePath, `HEAD:${filePath}`, MAX_TEXT_BYTES);
        const idx2 = await gitShowText(worktreePath, `:${filePath}`, MAX_TEXT_BYTES);
        const isBinary2 = Boolean(head.isBinary || idx2.isBinary);
        return {
          path: filePath,
          mode,
          original: { exists: head.exists, text: head.text },
          modified: { exists: idx2.exists, text: idx2.text },
          ...isBinary2 ? { isBinary: true } : {}
        };
      }
      if (mode === "commit") {
        const ref = compareRef?.trim();
        if (!ref) {
          throw new Error("compareRef is required for commit mode");
        }
        const target = compareTo ?? "worktree";
        if (target === "parent") {
          const parentsRes = await runGit(["rev-list", "--parents", "-n", "1", ref], { cwd: worktreePath, timeoutMs: 1e4 });
          const parentSha = parentsRes.exitCode === 0 ? parentsRes.stdout.trim().split(" ").slice(1)[0] : void 0;
          const parentRef = parentSha?.trim() ? parentSha.trim() : null;
          const parentSide = parentRef ? await gitShowText(worktreePath, `${parentRef}:${filePath}`, MAX_TEXT_BYTES) : { exists: false, text: "" };
          const commitSide2 = await gitShowText(worktreePath, `${ref}:${filePath}`, MAX_TEXT_BYTES);
          const isBinary3 = Boolean(parentSide.isBinary || commitSide2.isBinary);
          return {
            path: filePath,
            mode,
            original: { exists: parentSide.exists, text: parentSide.text },
            modified: { exists: commitSide2.exists, text: commitSide2.text },
            ...isBinary3 ? { isBinary: true } : {}
          };
        }
        const commitSide = await gitShowText(worktreePath, `${ref}:${filePath}`, MAX_TEXT_BYTES);
        const wt2 = readTextFileSafe(abs, MAX_TEXT_BYTES);
        const isBinary2 = Boolean(commitSide.isBinary || wt2.isBinary);
        return {
          path: filePath,
          mode,
          original: { exists: commitSide.exists, text: commitSide.text },
          modified: { exists: wt2.exists, text: wt2.text },
          ...isBinary2 ? { isBinary: true } : {}
        };
      }
      const idx = await gitShowText(worktreePath, `:${filePath}`, MAX_TEXT_BYTES);
      const wt = readTextFileSafe(abs, MAX_TEXT_BYTES);
      const isBinary = Boolean(idx.isBinary || wt.isBinary);
      return {
        path: filePath,
        mode,
        original: { exists: idx.exists, text: idx.text },
        modified: { exists: wt.exists, text: wt.text },
        ...isBinary ? { isBinary: true } : {}
      };
    }
  };
}

// ../desktop/src/main/services/missions/missionService.ts
var import_node_crypto7 = require("crypto");

// ../desktop/src/shared/types.ts
var SLASH_COMMAND_TRANSLATIONS = {
  "/automate": {
    prompt: "Run the /automate skill. This means: analyze the current project state, identify work that needs to be done based on the mission context, and execute it autonomously using agent teams. Use the Skill tool to invoke the 'automate' skill if available, otherwise carry out the automation workflow directly.",
    interactive: false
  },
  "/finalize": {
    prompt: "Run the /finalize skill. This means: perform end-of-cycle documentation audit - scan the codebase, verify docs are up to date, update the implementation plan, and run local checks. Use the Skill tool to invoke the 'finalize' skill if available, otherwise carry out the finalization workflow directly.",
    interactive: false
  }
};

// ../desktop/src/shared/modelRegistry.ts
var ALL_CAPS = { tools: true, vision: true, reasoning: true, streaming: true };
var NO_REASONING = { tools: true, vision: true, reasoning: false, streaming: true };
var BASIC_CAPS = { tools: true, vision: false, reasoning: false, streaming: true };
var MODEL_REGISTRY = [
  // ---- Anthropic (CLI-wrapped via claude) ----
  {
    id: "anthropic/claude-opus-4-6",
    shortId: "opus",
    displayName: "Claude Opus 4.6",
    family: "anthropic",
    authTypes: ["cli-subscription"],
    contextWindow: 2e5,
    maxOutputTokens: 32e3,
    capabilities: ALL_CAPS,
    reasoningTiers: ["low", "medium", "high", "max"],
    color: "#D97706",
    sdkProvider: "ai-sdk-provider-claude-code",
    sdkModelId: "opus",
    cliCommand: "claude",
    isCliWrapped: true
  },
  {
    id: "anthropic/claude-sonnet-4-6",
    shortId: "sonnet",
    displayName: "Claude Sonnet 4.6",
    family: "anthropic",
    authTypes: ["cli-subscription"],
    contextWindow: 2e5,
    maxOutputTokens: 32e3,
    capabilities: ALL_CAPS,
    reasoningTiers: ["low", "medium", "high", "max"],
    color: "#8B5CF6",
    sdkProvider: "ai-sdk-provider-claude-code",
    sdkModelId: "sonnet",
    cliCommand: "claude",
    isCliWrapped: true
  },
  {
    id: "anthropic/claude-haiku-4-5",
    shortId: "haiku",
    displayName: "Claude Haiku 4.5",
    family: "anthropic",
    authTypes: ["cli-subscription"],
    contextWindow: 2e5,
    maxOutputTokens: 32e3,
    capabilities: NO_REASONING,
    color: "#06B6D4",
    sdkProvider: "ai-sdk-provider-claude-code",
    sdkModelId: "haiku",
    cliCommand: "claude",
    isCliWrapped: true
  },
  // ---- Anthropic (API key direct) ----
  {
    id: "anthropic/claude-sonnet-4-6-api",
    shortId: "sonnet-api",
    displayName: "Claude Sonnet 4.6 (API)",
    family: "anthropic",
    authTypes: ["api-key"],
    contextWindow: 2e5,
    maxOutputTokens: 8192,
    capabilities: ALL_CAPS,
    reasoningTiers: ["low", "medium", "high", "max"],
    color: "#8B5CF6",
    sdkProvider: "@ai-sdk/anthropic",
    sdkModelId: "claude-sonnet-4-6",
    isCliWrapped: false
  },
  {
    id: "anthropic/claude-haiku-4-5-api",
    shortId: "haiku-api",
    displayName: "Claude Haiku 4.5 (API)",
    family: "anthropic",
    authTypes: ["api-key"],
    contextWindow: 2e5,
    maxOutputTokens: 8192,
    capabilities: NO_REASONING,
    color: "#06B6D4",
    sdkProvider: "@ai-sdk/anthropic",
    sdkModelId: "claude-haiku-4-5-20251001",
    isCliWrapped: false
  },
  // ---- OpenAI (CLI-wrapped via codex) ----
  {
    id: "openai/gpt-5.3-codex",
    shortId: "gpt-5.3-codex",
    displayName: "GPT-5.3 Codex",
    family: "openai",
    authTypes: ["cli-subscription"],
    contextWindow: 192e3,
    maxOutputTokens: 16384,
    capabilities: ALL_CAPS,
    reasoningTiers: ["low", "medium", "high", "extra_high"],
    color: "#10B981",
    sdkProvider: "ai-sdk-provider-codex-cli",
    sdkModelId: "gpt-5.3-codex",
    cliCommand: "codex",
    isCliWrapped: true
  },
  {
    id: "openai/gpt-5.2-codex",
    shortId: "gpt-5.2-codex",
    displayName: "GPT-5.2 Codex",
    family: "openai",
    authTypes: ["cli-subscription"],
    contextWindow: 192e3,
    maxOutputTokens: 16384,
    capabilities: ALL_CAPS,
    reasoningTiers: ["low", "medium", "high", "extra_high"],
    color: "#10B981",
    sdkProvider: "ai-sdk-provider-codex-cli",
    sdkModelId: "gpt-5.2-codex",
    cliCommand: "codex",
    isCliWrapped: true
  },
  {
    id: "openai/gpt-5.1-codex-max",
    shortId: "gpt-5.1-codex-max",
    displayName: "GPT-5.1 Codex Max",
    family: "openai",
    authTypes: ["cli-subscription"],
    contextWindow: 192e3,
    maxOutputTokens: 16384,
    capabilities: ALL_CAPS,
    reasoningTiers: ["low", "medium", "high", "extra_high"],
    color: "#10B981",
    sdkProvider: "ai-sdk-provider-codex-cli",
    sdkModelId: "gpt-5.1-codex-max",
    cliCommand: "codex",
    isCliWrapped: true
  },
  {
    id: "openai/codex-mini-latest",
    shortId: "codex-mini",
    displayName: "Codex Mini",
    family: "openai",
    authTypes: ["cli-subscription"],
    contextWindow: 192e3,
    maxOutputTokens: 16384,
    capabilities: NO_REASONING,
    color: "#34D399",
    sdkProvider: "ai-sdk-provider-codex-cli",
    sdkModelId: "codex-mini-latest",
    cliCommand: "codex",
    isCliWrapped: true
  },
  {
    id: "openai/o4-mini",
    shortId: "o4-mini",
    displayName: "o4-mini",
    family: "openai",
    authTypes: ["cli-subscription"],
    contextWindow: 192e3,
    maxOutputTokens: 16384,
    capabilities: ALL_CAPS,
    color: "#6EE7B7",
    sdkProvider: "ai-sdk-provider-codex-cli",
    sdkModelId: "o4-mini",
    cliCommand: "codex",
    isCliWrapped: true
  },
  {
    id: "openai/o3",
    shortId: "o3",
    displayName: "o3",
    family: "openai",
    authTypes: ["cli-subscription"],
    contextWindow: 192e3,
    maxOutputTokens: 16384,
    capabilities: ALL_CAPS,
    color: "#059669",
    sdkProvider: "ai-sdk-provider-codex-cli",
    sdkModelId: "o3",
    cliCommand: "codex",
    isCliWrapped: true
  },
  // ---- OpenAI (API key direct) ----
  {
    id: "openai/gpt-4.1",
    shortId: "gpt-4.1",
    displayName: "GPT-4.1",
    family: "openai",
    authTypes: ["api-key"],
    contextWindow: 1e6,
    maxOutputTokens: 32768,
    capabilities: NO_REASONING,
    color: "#10B981",
    sdkProvider: "@ai-sdk/openai",
    sdkModelId: "gpt-4.1",
    isCliWrapped: false
  },
  {
    id: "openai/gpt-4.1-mini",
    shortId: "gpt-4.1-mini",
    displayName: "GPT-4.1 Mini",
    family: "openai",
    authTypes: ["api-key"],
    contextWindow: 1e6,
    maxOutputTokens: 32768,
    capabilities: NO_REASONING,
    color: "#34D399",
    sdkProvider: "@ai-sdk/openai",
    sdkModelId: "gpt-4.1-mini",
    isCliWrapped: false
  },
  {
    id: "openai/o4-mini-api",
    shortId: "o4-mini-api",
    displayName: "o4-mini (API)",
    family: "openai",
    authTypes: ["api-key"],
    contextWindow: 2e5,
    maxOutputTokens: 1e5,
    capabilities: ALL_CAPS,
    color: "#6EE7B7",
    sdkProvider: "@ai-sdk/openai",
    sdkModelId: "o4-mini",
    isCliWrapped: false
  },
  // ---- Google ----
  {
    id: "google/gemini-2.5-pro",
    shortId: "gemini-pro",
    displayName: "Gemini 2.5 Pro",
    family: "google",
    authTypes: ["api-key", "cli-subscription"],
    contextWindow: 1e6,
    maxOutputTokens: 65536,
    capabilities: ALL_CAPS,
    color: "#F59E0B",
    sdkProvider: "@ai-sdk/google",
    sdkModelId: "gemini-2.5-pro",
    isCliWrapped: false
  },
  {
    id: "google/gemini-2.5-flash",
    shortId: "gemini-flash",
    displayName: "Gemini 2.5 Flash",
    family: "google",
    authTypes: ["api-key", "cli-subscription"],
    contextWindow: 1e6,
    maxOutputTokens: 65536,
    capabilities: NO_REASONING,
    color: "#FBBF24",
    sdkProvider: "@ai-sdk/google",
    sdkModelId: "gemini-2.5-flash",
    isCliWrapped: false
  },
  // ---- DeepSeek ----
  {
    id: "deepseek/deepseek-r1",
    shortId: "deepseek-r1",
    displayName: "DeepSeek R1",
    family: "deepseek",
    authTypes: ["api-key"],
    contextWindow: 128e3,
    maxOutputTokens: 8192,
    capabilities: { tools: true, vision: false, reasoning: true, streaming: true },
    color: "#3B82F6",
    sdkProvider: "@ai-sdk/deepseek",
    sdkModelId: "deepseek-reasoner",
    isCliWrapped: false
  },
  {
    id: "deepseek/deepseek-chat",
    shortId: "deepseek-chat",
    displayName: "DeepSeek Chat",
    family: "deepseek",
    authTypes: ["api-key"],
    contextWindow: 128e3,
    maxOutputTokens: 8192,
    capabilities: BASIC_CAPS,
    color: "#60A5FA",
    sdkProvider: "@ai-sdk/deepseek",
    sdkModelId: "deepseek-chat",
    isCliWrapped: false
  },
  // ---- Mistral ----
  {
    id: "mistral/codestral-latest",
    shortId: "codestral",
    displayName: "Codestral",
    family: "mistral",
    authTypes: ["api-key"],
    contextWindow: 256e3,
    maxOutputTokens: 8192,
    capabilities: BASIC_CAPS,
    color: "#F97316",
    sdkProvider: "@ai-sdk/mistral",
    sdkModelId: "codestral-latest",
    isCliWrapped: false
  },
  // ---- xAI ----
  {
    id: "xai/grok-3",
    shortId: "grok-3",
    displayName: "Grok 3",
    family: "xai",
    authTypes: ["api-key"],
    contextWindow: 131072,
    maxOutputTokens: 8192,
    capabilities: ALL_CAPS,
    color: "#EF4444",
    sdkProvider: "@ai-sdk/xai",
    sdkModelId: "grok-3",
    isCliWrapped: false
  },
  // ---- OpenRouter ----
  {
    id: "openrouter/auto",
    shortId: "openrouter-auto",
    displayName: "OpenRouter Auto",
    family: "openrouter",
    authTypes: ["openrouter"],
    contextWindow: 2e5,
    maxOutputTokens: 16384,
    capabilities: ALL_CAPS,
    color: "#A855F7",
    sdkProvider: "@openrouter/ai-sdk-provider",
    sdkModelId: "openrouter/auto",
    isCliWrapped: false
  },
  // ---- Local (Ollama) ----
  {
    id: "ollama/llama-3.3",
    shortId: "llama-3.3",
    displayName: "Llama 3.3 (Local)",
    family: "ollama",
    authTypes: ["local"],
    contextWindow: 128e3,
    maxOutputTokens: 4096,
    capabilities: BASIC_CAPS,
    color: "#71717A",
    sdkProvider: "@ai-sdk/openai-compatible",
    sdkModelId: "llama-3.3",
    isCliWrapped: false
  }
];
var byId = /* @__PURE__ */ new Map();
var byShortId = /* @__PURE__ */ new Map();
for (const m of MODEL_REGISTRY) {
  byId.set(m.id, m);
  byShortId.set(m.shortId, m);
}
function getModelById(id) {
  return byId.get(id);
}

// ../desktop/src/main/services/orchestrator/executionPolicy.ts
var DEFAULT_EXECUTION_POLICY = {
  planning: { mode: "auto", model: "anthropic/claude-sonnet-4-6" },
  implementation: { model: "openai/gpt-5.3-codex" },
  testing: { mode: "post_implementation", model: "openai/gpt-5.3-codex" },
  validation: { mode: "optional", model: "openai/gpt-5.3-codex" },
  codeReview: { mode: "off" },
  testReview: { mode: "off" },
  integration: { mode: "auto", model: "openai/gpt-5.3-codex" },
  merge: { mode: "off" },
  completion: { allowCompletionWithRisk: true },
  prStrategy: { kind: "manual" }
};
function depthTierToPolicy(tier) {
  switch (tier) {
    case "light":
      return {
        planning: { mode: "off" },
        implementation: { model: "openai/gpt-5.3-codex" },
        testing: { mode: "none" },
        validation: { mode: "off" },
        codeReview: { mode: "off" },
        testReview: { mode: "off" },
        integration: { mode: "off" },
        merge: { mode: "off" },
        completion: { allowCompletionWithRisk: true },
        prStrategy: { kind: "per-lane", draft: true, prDepth: "propose-only" }
      };
    case "deep":
      return {
        planning: { mode: "manual_review", model: "anthropic/claude-sonnet-4-6" },
        implementation: { model: "openai/gpt-5.3-codex" },
        testing: { mode: "post_implementation", model: "openai/gpt-5.3-codex" },
        validation: { mode: "required", model: "openai/gpt-5.3-codex" },
        codeReview: { mode: "required", model: "anthropic/claude-sonnet-4-6" },
        testReview: { mode: "required", model: "openai/gpt-5.3-codex" },
        integration: { mode: "auto", model: "openai/gpt-5.3-codex" },
        merge: { mode: "off" },
        completion: { allowCompletionWithRisk: false },
        prStrategy: { kind: "integration", targetBranch: "main", draft: false, prDepth: "open-and-comment" }
      };
    case "standard":
    default:
      return {
        planning: { mode: "auto", model: "openai/gpt-5.3-codex" },
        implementation: { model: "openai/gpt-5.3-codex" },
        testing: { mode: "post_implementation", model: "openai/gpt-5.3-codex" },
        validation: { mode: "optional", model: "openai/gpt-5.3-codex" },
        codeReview: { mode: "off" },
        testReview: { mode: "off" },
        integration: { mode: "auto", model: "openai/gpt-5.3-codex" },
        merge: { mode: "off" },
        completion: { allowCompletionWithRisk: true },
        prStrategy: { kind: "queue", targetBranch: "main", draft: true, autoRebase: true, ciGating: false, prDepth: "resolve-conflicts" }
      };
  }
}
var MODEL_TO_EXECUTOR = {
  claude: "claude",
  codex: "codex"
};
function phaseModelToExecutorKind(model, fallback = "codex") {
  if (!model) return fallback;
  if (model === "claude") return "claude";
  if (model === "codex") return "codex";
  const descriptor = getModelById(model);
  if (descriptor) return "unified";
  return MODEL_TO_EXECUTOR[model] ?? fallback;
}

// ../desktop/src/main/services/missions/missionPlanner.ts
var ANALYSIS_WORDS = ["analyze", "analysis", "investigate", "research", "understand", "audit", "review", "plan"];
var IMPLEMENT_WORDS = ["implement", "refactor", "fix", "build", "create", "update", "add", "remove", "migrate", "ship", "write"];
var VALIDATION_WORDS = ["test", "verify", "validate", "check", "lint", "typecheck", "ci", "qa"];
var INTEGRATION_WORDS = ["merge", "integrate", "reconcile", "combine", "conflict", "land", "cherry-pick"];
var SUMMARY_WORDS = ["summary", "summarize", "handoff", "report", "pr", "pull request", "document"];
var ACTION_HINT_WORDS = [
  ...ANALYSIS_WORDS,
  ...IMPLEMENT_WORDS,
  ...VALIDATION_WORDS,
  ...INTEGRATION_WORDS,
  ...SUMMARY_WORDS,
  "harden",
  "instrument",
  "expose",
  "show",
  "prove"
];
var NON_EXECUTABLE_LINE_RE = /^(?:goals?|plan requirements?|hard constraints?|constraints?|important|notes?|final output|output)\s*:?\s*$/i;
var NON_EXECUTABLE_PHRASES = [
  "keep changes minimal",
  "changes minimal and focused",
  "exercise real parallel fan-out",
  "dependency-safe joins",
  "clean terminal completion",
  "no manual intervention",
  "step titles must be descriptive",
  "run roots concurrently when dependencies allow"
];
function normalizePrompt(prompt) {
  return prompt.replace(/\r\n/g, "\n").split("\n").map((line) => line.trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
function toWords(input) {
  return input.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).map((entry) => entry.trim()).filter(Boolean);
}
function hasAnyKeyword(input, keywords) {
  const lower = input.toLowerCase();
  return keywords.some((keyword) => lower.includes(keyword));
}
function slugify2(input) {
  const slug = input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return slug.length ? slug : "step";
}
function dedupe(values) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}
function hasActionHint(task) {
  const lower = task.toLowerCase();
  return ACTION_HINT_WORDS.some((word) => lower.includes(word));
}
function isActionableTask(task) {
  const normalized = task.replace(/\s+/g, " ").trim().replace(/[.;]+$/g, "").trim();
  if (normalized.length < 8) return false;
  if (NON_EXECUTABLE_LINE_RE.test(normalized)) return false;
  const lower = normalized.toLowerCase();
  if (NON_EXECUTABLE_PHRASES.some((phrase) => lower.includes(phrase))) return false;
  if (normalized.endsWith(":")) return false;
  if (hasActionHint(lower)) return true;
  return /^(?:backend|runtime|ui|frontend|api|docs?|tests?|review)\b/i.test(normalized);
}
function extractTaskCandidates(prompt) {
  const lines = prompt.replace(/\r\n/g, "\n").split("\n").map((line) => line.replace(/\s+$/g, "")).filter((line) => line.trim().length > 0);
  const bulletLineRe = /^(\s*)(?:[-*•]|\d+[.)])\s+(.+)$/;
  const bulletTasks = lines.map((line, index) => {
    const match = line.match(bulletLineRe);
    if (!match?.[2]) return null;
    return {
      index,
      indent: match[1]?.length ?? 0,
      task: match[2].trim()
    };
  }).filter((entry) => Boolean(entry)).filter((entry) => {
    if (!entry.task.endsWith(":")) return true;
    const nextLine = lines[entry.index + 1];
    if (!nextLine) return true;
    const nextMatch = nextLine.match(bulletLineRe);
    if (!nextMatch) return true;
    const nextIndent = nextMatch[1]?.length ?? 0;
    return nextIndent <= entry.indent;
  }).map((entry) => entry.task.replace(/\s+/g, " ").trim()).filter((task) => isActionableTask(task));
  if (bulletTasks.length >= 2) {
    return dedupe(bulletTasks.map((task) => task.slice(0, 140)));
  }
  const sentenceTasks = normalizePrompt(prompt).replace(/\n/g, " ").split(/(?<=[.!?;])\s+|\s+\band\b\s+/i).map((entry) => entry.trim()).filter((entry) => entry.length >= 8).map((entry) => entry.replace(/[.!?;]+$/g, "").trim()).filter((entry) => isActionableTask(entry));
  return dedupe(sentenceTasks.slice(0, 8).map((task) => task.slice(0, 140)));
}
function classifyTask(task) {
  if (hasAnyKeyword(task, SUMMARY_WORDS)) return "summary";
  if (hasAnyKeyword(task, INTEGRATION_WORDS)) return "integration";
  if (hasAnyKeyword(task, VALIDATION_WORDS)) return "validation";
  if (hasAnyKeyword(task, ANALYSIS_WORDS)) return "analysis";
  return "implementation";
}
function deriveJoinPolicy(prompt, branchCount) {
  if (branchCount <= 1) {
    return {
      joinPolicy: "all_success",
      quorumCount: null
    };
  }
  const lower = prompt.toLowerCase();
  const quorumMatch = lower.match(/\b(?:quorum|at least)\s+(\d+)\b/);
  const quorum = quorumMatch ? Number(quorumMatch[1]) : NaN;
  if (Number.isFinite(quorum) && quorum > 0) {
    return {
      joinPolicy: "quorum",
      quorumCount: Math.max(1, Math.min(branchCount, Math.floor(quorum)))
    };
  }
  if (/\b(?:either|any one|any of|one of)\b/.test(lower)) {
    return {
      joinPolicy: "any_success",
      quorumCount: null
    };
  }
  return {
    joinPolicy: "all_success",
    quorumCount: null
  };
}
function buildPolicy(args) {
  const claimScopes = [];
  if (args.laneId && (args.kind === "integration" || args.kind === "merge" || args.kind === "validation")) {
    claimScopes.push({
      scopeKind: "lane",
      scopeValue: `lane:${args.laneId}`,
      ttlMs: 6e4
    });
  } else if (args.parallelBranch) {
    claimScopes.push({
      scopeKind: "file",
      scopeValue: `planner:${slugify2(args.title)}`,
      ttlMs: 45e3
    });
  }
  return {
    includeNarrative: false,
    includeFullDocs: args.kind === "analysis" || args.kind === "integration",
    docsMaxBytes: args.kind === "analysis" ? 16e4 : 12e4,
    claimScopes
  };
}
function toPlannerStep(step, index, strategy, keywords) {
  const rawStepType = String(step.extraMetadata?.stepType ?? step.extraMetadata?.taskType ?? step.kind ?? "").trim().toLowerCase();
  const roleClass = step.kind === "analysis" ? "planning" : step.kind === "implementation" ? "implementation" : step.kind === "integration" ? "integration" : step.kind === "merge" ? "merge" : step.kind === "summary" ? "handoff" : rawStepType === "review" || rawStepType === "test_review" || rawStepType === "review_test" ? "review" : "testing";
  const metadata = {
    stepType: step.kind,
    dependencyIndices: step.dependencyIndices,
    joinPolicy: step.joinPolicy,
    quorumCount: step.quorumCount,
    retryLimit: step.retryLimit,
    executorKind: step.executorKind,
    doneCriteria: step.doneCriteria,
    policy: step.policy,
    planner: {
      version: "ade.missionPlanner.v1",
      strategy,
      splitReason: step.splitReason,
      keywords
    },
    roleClass,
    requiresDedicatedWorker: roleClass === "review" || roleClass === "testing" || roleClass === "integration",
    role: step.kind === "analysis" ? "planning" : step.kind === "implementation" ? "implementation" : step.kind === "validation" ? "testing" : step.kind === "integration" ? "integration" : step.kind === "summary" ? "merge" : step.kind === "merge" ? "merge" : "implementation"
  };
  if (Number.isFinite(step.timeoutMs ?? NaN) && (step.timeoutMs ?? 0) > 0) {
    metadata.timeoutMs = Math.floor(step.timeoutMs);
  }
  if (step.extraMetadata) {
    for (const [key, value] of Object.entries(step.extraMetadata)) {
      metadata[key] = value;
    }
  }
  return {
    index,
    title: step.title,
    detail: step.detail,
    kind: step.kind,
    metadata
  };
}
function detectSlashCommands(prompt) {
  return prompt.split("\n").map((line) => line.trim()).filter((line) => /^\/[a-zA-Z]/.test(line));
}
function buildDeterministicMissionPlan(args) {
  const prompt = normalizePrompt(args.prompt);
  const policy = args.policy;
  const laneId = typeof args.laneId === "string" && args.laneId.trim().length ? args.laneId.trim() : null;
  const taskCandidates = extractTaskCandidates(prompt);
  const lowerPrompt = prompt.toLowerCase();
  const promptWords = toWords(prompt);
  const keywords = dedupe(promptWords.filter(
    (word) => ANALYSIS_WORDS.includes(word) || IMPLEMENT_WORDS.includes(word) || VALIDATION_WORDS.includes(word) || INTEGRATION_WORDS.includes(word) || SUMMARY_WORDS.includes(word)
  ));
  const classified = taskCandidates.map((task) => ({
    task,
    kind: classifyTask(task)
  }));
  const workCandidates = classified.filter((entry) => entry.kind === "implementation" || entry.kind === "analysis").map((entry) => entry.task);
  const validationCandidates = classified.filter((entry) => entry.kind === "validation").map((entry) => entry.task);
  const summaryCandidates = classified.filter((entry) => entry.kind === "summary").map((entry) => entry.task);
  const explicitIntegration = classified.some((entry) => entry.kind === "integration");
  const explicitParallelRootIntent = /\bparallel\b/.test(lowerPrompt) && (/\broot\b/.test(lowerPrompt) || /\bfan[-\s]?out\b/.test(lowerPrompt) || /\bbranches?\b/.test(lowerPrompt));
  const strategy = workCandidates.length >= 2 ? "parallel_execution_branches_with_join" : explicitIntegration ? "single_branch_with_explicit_integration_gate" : "single_branch_default";
  const analysisExecutor = policy ? phaseModelToExecutorKind(policy.planning.model) : "codex";
  const implExecutor = policy ? phaseModelToExecutorKind(policy.implementation.model) : "codex";
  const testExecutor = policy ? phaseModelToExecutorKind(policy.testing.model) : "codex";
  const reviewExecutor = policy?.codeReview.model ? phaseModelToExecutorKind(policy.codeReview.model) : "codex";
  const testReviewExecutor = policy?.testReview.model ? phaseModelToExecutorKind(policy.testReview.model) : "codex";
  const integrationExecutor = policy ? phaseModelToExecutorKind(policy.integration.model) : "codex";
  const rawSteps = [];
  let previousIndex = -1;
  let analysisIndex = -1;
  const shouldSeedAnalysis = (!explicitParallelRootIntent || workCandidates.length < 2) && (prompt.length >= 120 || hasAnyKeyword(prompt, ANALYSIS_WORDS) || taskCandidates.length >= 3);
  if (shouldSeedAnalysis) {
    const index = rawSteps.length;
    analysisIndex = index;
    rawSteps.push({
      title: "Clarify mission constraints and success signal",
      detail: "Collect deterministic constraints from packs and mission prompt before execution.",
      kind: "analysis",
      dependencyIndices: [],
      joinPolicy: "all_success",
      quorumCount: null,
      timeoutMs: 18e4,
      retryLimit: 0,
      executorKind: analysisExecutor,
      doneCriteria: "Context baseline and explicit success criteria are recorded for downstream steps.",
      splitReason: "Mission prompt requires up-front deterministic scoping.",
      policy: buildPolicy({
        kind: "analysis",
        laneId,
        title: "analysis",
        parallelBranch: false
      }),
      extraMetadata: policy?.planning.reasoningEffort ? { reasoningEffort: policy.planning.reasoningEffort } : void 0
    });
    previousIndex = index;
  }
  const effectiveWork = workCandidates.length > 0 ? workCandidates : ["Implement the mission objective"];
  const parallelBranches = effectiveWork.length >= 2 ? effectiveWork.slice(0, 3) : effectiveWork.slice(0, 1);
  const fanOutDependencies = analysisIndex >= 0 ? [analysisIndex] : [];
  const workIndexes = [];
  const isTdd = policy?.testing.mode === "tdd";
  for (const workTask of parallelBranches) {
    const implDependencyIndices = parallelBranches.length > 1 ? [...fanOutDependencies] : analysisIndex >= 0 ? [analysisIndex] : previousIndex >= 0 ? [previousIndex] : [];
    if (isTdd) {
      const testIndex = rawSteps.length;
      rawSteps.push({
        title: `Write tests for: ${workTask}`,
        detail: "Write test cases before implementation (TDD).",
        kind: "validation",
        dependencyIndices: [...implDependencyIndices],
        joinPolicy: "all_success",
        quorumCount: null,
        timeoutMs: 3e5,
        retryLimit: 1,
        executorKind: testExecutor,
        doneCriteria: "Test cases are written and ready for implementation to satisfy.",
        splitReason: "TDD policy requires test-first workflow.",
        policy: buildPolicy({
          kind: "validation",
          laneId,
          title: `tdd-test-${slugify2(workTask)}`,
          parallelBranch: parallelBranches.length > 1
        }),
        extraMetadata: {
          stepType: "test",
          taskType: "test",
          ...policy?.testing.reasoningEffort ? { reasoningEffort: policy.testing.reasoningEffort } : {}
        }
      });
      const implIndex = rawSteps.length;
      workIndexes.push(implIndex);
      rawSteps.push({
        title: workTask,
        detail: "Execute this branch and keep outputs isolated for deterministic integration.",
        kind: "implementation",
        dependencyIndices: [testIndex],
        joinPolicy: "all_success",
        quorumCount: null,
        timeoutMs: 42e4,
        retryLimit: 1,
        executorKind: implExecutor,
        doneCriteria: "Code changes are produced in lane scope and recorded as attempt outputs.",
        splitReason: parallelBranches.length > 1 ? "Prompt included multiple executable units that can run concurrently." : "Prompt maps to a single executable workstream.",
        policy: buildPolicy({
          kind: "implementation",
          laneId,
          title: workTask,
          parallelBranch: parallelBranches.length > 1
        }),
        extraMetadata: policy?.implementation.reasoningEffort ? { reasoningEffort: policy.implementation.reasoningEffort } : void 0
      });
      previousIndex = implIndex;
    } else {
      const index = rawSteps.length;
      workIndexes.push(index);
      rawSteps.push({
        title: workTask,
        detail: "Execute this branch and keep outputs isolated for deterministic integration.",
        kind: "implementation",
        dependencyIndices: [...implDependencyIndices],
        joinPolicy: "all_success",
        quorumCount: null,
        timeoutMs: 42e4,
        retryLimit: 1,
        executorKind: implExecutor,
        doneCriteria: "Code changes are produced in lane scope and recorded as attempt outputs.",
        splitReason: parallelBranches.length > 1 ? "Prompt included multiple executable units that can run concurrently." : "Prompt maps to a single executable workstream.",
        policy: buildPolicy({
          kind: "implementation",
          laneId,
          title: workTask,
          parallelBranch: parallelBranches.length > 1
        }),
        extraMetadata: policy?.implementation.reasoningEffort ? { reasoningEffort: policy.implementation.reasoningEffort } : void 0
      });
      previousIndex = index;
    }
  }
  if (policy && policy.codeReview.mode !== "off") {
    const index = rawSteps.length;
    rawSteps.push({
      title: "Code review gate",
      detail: "Review implementation outputs for quality, correctness, and adherence to standards.",
      kind: "validation",
      dependencyIndices: workIndexes.length ? [...workIndexes] : previousIndex >= 0 ? [previousIndex] : [],
      joinPolicy: "all_success",
      quorumCount: null,
      timeoutMs: 6e5,
      retryLimit: 0,
      executorKind: reviewExecutor,
      doneCriteria: "Review feedback is recorded and blocking issues are flagged.",
      splitReason: "Execution policy requires code review before validation/summary.",
      policy: buildPolicy({
        kind: "validation",
        laneId,
        title: "code-review",
        parallelBranch: false
      }),
      extraMetadata: {
        taskType: "review",
        stepType: "review",
        ...policy.codeReview.reasoningEffort ? { reasoningEffort: policy.codeReview.reasoningEffort } : {}
      }
    });
    previousIndex = index;
  }
  const hasParallelJoin = workIndexes.length > 1 || explicitIntegration;
  const skipIntegration = policy?.integration.mode === "off";
  if (hasParallelJoin && !skipIntegration) {
    const joinConfig = deriveJoinPolicy(prompt, workIndexes.length || 1);
    const index = rawSteps.length;
    rawSteps.push({
      title: "Integrate branch outputs",
      detail: "Verify cross-branch compatibility and consolidate a single integration result.",
      kind: "integration",
      dependencyIndices: workIndexes.length ? workIndexes : previousIndex >= 0 ? [previousIndex] : [],
      joinPolicy: joinConfig.joinPolicy,
      quorumCount: joinConfig.quorumCount,
      timeoutMs: 9e5,
      retryLimit: 1,
      executorKind: integrationExecutor,
      doneCriteria: "Cross-branch contracts are validated and integration outputs are summarized for downstream gates.",
      splitReason: "Parallel branches require a compatibility gate before validation.",
      policy: buildPolicy({
        kind: "integration",
        laneId,
        title: "integration",
        parallelBranch: false
      }),
      extraMetadata: policy?.integration.reasoningEffort ? { reasoningEffort: policy.integration.reasoningEffort } : void 0
    });
    previousIndex = index;
  }
  const skipValidation = policy?.testing.mode === "none";
  if (!skipValidation) {
    const validationTitle = validationCandidates[0] ?? "Run deterministic verification checks";
    const index = rawSteps.length;
    rawSteps.push({
      title: validationTitle,
      detail: "Execute deterministic checks and classify failures before completion.",
      kind: "validation",
      dependencyIndices: previousIndex >= 0 ? [previousIndex] : [],
      joinPolicy: "all_success",
      quorumCount: null,
      timeoutMs: 6e5,
      retryLimit: 1,
      executorKind: testExecutor,
      doneCriteria: "Required checks complete and outcomes are attached to mission artifacts/handoffs.",
      splitReason: "Validation gate ensures deterministic completion criteria.",
      policy: buildPolicy({
        kind: "validation",
        laneId,
        title: validationTitle,
        parallelBranch: false
      }),
      extraMetadata: policy?.testing.reasoningEffort ? { reasoningEffort: policy.testing.reasoningEffort } : void 0
    });
    previousIndex = index;
  }
  if (policy && policy.testReview.mode !== "off" && policy.testing.mode !== "none") {
    const index = rawSteps.length;
    rawSteps.push({
      title: "Test review gate",
      detail: "Review test outcomes and failure diagnostics before final handoff/merge.",
      kind: "validation",
      dependencyIndices: previousIndex >= 0 ? [previousIndex] : [],
      joinPolicy: "all_success",
      quorumCount: null,
      timeoutMs: 42e4,
      retryLimit: 0,
      executorKind: testReviewExecutor,
      doneCriteria: "Test findings are reviewed and release blockers are called out explicitly.",
      splitReason: "Execution policy requires a dedicated test review phase.",
      policy: buildPolicy({
        kind: "validation",
        laneId,
        title: "test-review",
        parallelBranch: false
      }),
      extraMetadata: {
        taskType: "test_review",
        stepType: "test_review",
        reviewTarget: "tests",
        ...policy.testReview.reasoningEffort ? { reasoningEffort: policy.testReview.reasoningEffort } : {}
      }
    });
    previousIndex = index;
  }
  const summaryTitle = summaryCandidates[0] ?? "Record mission outcomes and handoff artifacts";
  rawSteps.push({
    title: summaryTitle,
    detail: "Finalize mission summary, artifacts, and runtime provenance for audit/history.",
    kind: "summary",
    dependencyIndices: previousIndex >= 0 ? [previousIndex] : [],
    joinPolicy: "all_success",
    quorumCount: null,
    timeoutMs: 18e4,
    retryLimit: 0,
    executorKind: "codex",
    doneCriteria: "Outcome summary and required artifact links are persisted for operators.",
    splitReason: "Mission completion requires a deterministic audit and handoff record.",
    policy: buildPolicy({
      kind: "summary",
      laneId,
      title: summaryTitle,
      parallelBranch: false
    })
  });
  const slashCommands = detectSlashCommands(args.prompt);
  for (const cmd of slashCommands) {
    const depIndex = rawSteps.length - 1;
    const cmdBase = cmd.split(/\s/)[0];
    const translation = SLASH_COMMAND_TRANSLATIONS[cmdBase];
    if (translation) {
      rawSteps.push({
        title: cmd,
        detail: translation.prompt,
        kind: "implementation",
        dependencyIndices: depIndex >= 0 ? [depIndex] : [],
        joinPolicy: "all_success",
        quorumCount: null,
        timeoutMs: 3e5,
        retryLimit: 0,
        executorKind: "claude",
        doneCriteria: "Slash command execution completed.",
        splitReason: "Slash command detected in prompt.",
        policy: buildPolicy({
          kind: "implementation",
          laneId,
          title: cmd,
          parallelBranch: false
        }),
        extraMetadata: {
          stepType: "command",
          slashCommand: cmd,
          instructions: translation.prompt
        }
      });
    } else {
      rawSteps.push({
        title: cmd,
        detail: `Execute slash command: ${cmd}`,
        kind: "implementation",
        dependencyIndices: depIndex >= 0 ? [depIndex] : [],
        joinPolicy: "all_success",
        quorumCount: null,
        timeoutMs: 3e5,
        retryLimit: 0,
        executorKind: "claude",
        doneCriteria: "Slash command execution completed.",
        splitReason: "Slash command detected in prompt.",
        policy: buildPolicy({
          kind: "implementation",
          laneId,
          title: cmd,
          parallelBranch: false
        }),
        extraMetadata: {
          startupCommand: cmd,
          stepType: "command",
          slashCommand: cmd
        }
      });
    }
  }
  return {
    plannerVersion: "ade.missionPlanner.v1",
    strategy,
    keywords,
    steps: rawSteps.map((step, index) => toPlannerStep(step, index, strategy, keywords))
  };
}

// ../desktop/src/main/services/missions/missionService.ts
var TERMINAL_MISSION_STATUSES = /* @__PURE__ */ new Set(["completed", "failed", "canceled"]);
var ACTIVE_MISSION_STATUSES = /* @__PURE__ */ new Set(["in_progress", "planning", "plan_review", "intervention_required"]);
var DEFAULT_CONCURRENCY_CONFIG = {
  maxConcurrentMissions: 3,
  laneExclusivity: true
};
var PRIORITY_ORDER = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3
};
var MISSION_TRANSITIONS = {
  queued: /* @__PURE__ */ new Set(["queued", "planning", "in_progress", "canceled"]),
  planning: /* @__PURE__ */ new Set(["planning", "plan_review", "in_progress", "intervention_required", "failed", "canceled", "queued"]),
  plan_review: /* @__PURE__ */ new Set(["plan_review", "in_progress", "queued", "failed", "canceled", "intervention_required"]),
  in_progress: /* @__PURE__ */ new Set(["in_progress", "intervention_required", "completed", "failed", "canceled", "plan_review"]),
  intervention_required: /* @__PURE__ */ new Set(["intervention_required", "in_progress", "failed", "canceled", "plan_review"]),
  completed: /* @__PURE__ */ new Set(["completed", "queued"]),
  failed: /* @__PURE__ */ new Set(["failed", "queued", "planning", "in_progress", "canceled"]),
  canceled: /* @__PURE__ */ new Set(["canceled", "queued", "planning", "in_progress"])
};
var STEP_TRANSITIONS = {
  pending: /* @__PURE__ */ new Set(["pending", "running", "skipped", "blocked", "canceled"]),
  running: /* @__PURE__ */ new Set(["running", "succeeded", "failed", "blocked", "canceled"]),
  blocked: /* @__PURE__ */ new Set(["blocked", "running", "failed", "canceled", "skipped"]),
  succeeded: /* @__PURE__ */ new Set(["succeeded"]),
  failed: /* @__PURE__ */ new Set(["failed", "running", "canceled"]),
  skipped: /* @__PURE__ */ new Set(["skipped"]),
  canceled: /* @__PURE__ */ new Set(["canceled"])
};
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function isRecord3(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function safeParseRecord(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return isRecord3(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
function normalizeMissionStatus(value) {
  if (value === "queued" || value === "planning" || value === "plan_review" || value === "in_progress" || value === "intervention_required" || value === "completed" || value === "failed" || value === "canceled") {
    return value;
  }
  return "queued";
}
function normalizeMissionPriority(value) {
  if (value === "urgent" || value === "high" || value === "normal" || value === "low") return value;
  return "normal";
}
function normalizeExecutionMode(value) {
  if (value === "local" || value === "relay") return value;
  return "local";
}
function normalizeStepStatus(value) {
  if (value === "pending" || value === "running" || value === "succeeded" || value === "failed" || value === "skipped" || value === "blocked" || value === "canceled") {
    return value;
  }
  return "pending";
}
function normalizeArtifactType(value) {
  if (value === "summary" || value === "pr" || value === "link" || value === "note" || value === "patch") return value;
  return "note";
}
function normalizeInterventionType(value) {
  if (value === "approval_required" || value === "manual_input" || value === "conflict" || value === "policy_block" || value === "failed_step") {
    return value;
  }
  return "manual_input";
}
function normalizeInterventionStatus(value) {
  if (value === "open" || value === "resolved" || value === "dismissed") return value;
  return "open";
}
function normalizePrompt2(prompt) {
  return prompt.replace(/\r\n/g, "\n").split("\n").map((line) => line.trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
function summarizePrompt(prompt) {
  const oneLine = prompt.replace(/\s+/g, " ").trim();
  if (!oneLine.length) return "Mission";
  if (oneLine.length <= 88) return oneLine;
  return `${oneLine.slice(0, 85)}...`;
}
function deriveMissionTitle(prompt, explicit) {
  const cleanedExplicit = (explicit ?? "").trim();
  if (cleanedExplicit.length) return cleanedExplicit.slice(0, 140);
  const firstSentence = normalizePrompt2(prompt).split(/(?<=[.!?])\s+/)[0] ?? "";
  const compact = firstSentence.trim() || summarizePrompt(prompt);
  return compact.slice(0, 140);
}
function sanitizeOptionalText(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}
function coerceNullableString(value) {
  if (value == null) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}
function truncateForMetadata(value, maxChars = 12e4) {
  if (!value) return null;
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}
...<truncated>`;
}
function mergeWithDefaults(partial) {
  const base = DEFAULT_EXECUTION_POLICY;
  return {
    planning: { ...base.planning, ...partial.planning },
    implementation: { ...base.implementation, ...partial.implementation },
    testing: { ...base.testing, ...partial.testing },
    validation: { ...base.validation, ...partial.validation },
    codeReview: { ...base.codeReview, ...partial.codeReview },
    testReview: { ...base.testReview, ...partial.testReview },
    integration: { ...base.integration, ...partial.integration },
    merge: { ...base.merge, ...partial.merge },
    completion: { ...base.completion, ...partial.completion }
  };
}
function normalizeMissionExecutorPolicy(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw === "codex" || raw === "claude" || raw === "both") return raw;
  return "both";
}
function toPlannerAttempt(value) {
  if (!isRecord3(value)) return null;
  const id = String(value.id ?? "").trim();
  const engine = String(value.engine ?? "").trim();
  const status = String(value.status ?? "").trim();
  if (!id.length || !engine.length || status !== "succeeded" && status !== "failed") return null;
  return {
    id,
    engine,
    status,
    reasonCode: typeof value.reasonCode === "string" ? value.reasonCode : null,
    detail: typeof value.detail === "string" ? value.detail : null,
    commandPreview: typeof value.commandPreview === "string" ? value.commandPreview : null,
    rawResponse: typeof value.rawResponse === "string" ? value.rawResponse : null,
    validationErrors: Array.isArray(value.validationErrors) ? value.validationErrors.map((entry) => String(entry ?? "").trim()).filter((entry) => entry.length > 0) : [],
    createdAt: typeof value.createdAt === "string" ? value.createdAt : nowIso()
  };
}
function toPlannerRunFromEvent(row) {
  if (row.event_type !== "mission_plan_generated") return null;
  const payload = safeParseRecord(row.payload_json);
  if (!payload) return null;
  const runId = String(payload.plannerRunId ?? "").trim();
  if (!runId.length) return null;
  const attemptsRaw = Array.isArray(payload.attempts) ? payload.attempts : [];
  const attempts = attemptsRaw.map((entry) => toPlannerAttempt(entry)).filter((entry) => entry != null);
  const validationErrors = Array.isArray(payload.validationErrors) ? payload.validationErrors.map((entry) => String(entry ?? "").trim()).filter((entry) => entry.length > 0) : [];
  const rawResolvedEngine = String(payload.resolvedEngine ?? "").trim();
  const resolvedEngine = rawResolvedEngine === "claude_cli" || rawResolvedEngine === "codex_cli" ? rawResolvedEngine : null;
  return {
    id: runId,
    missionId: row.mission_id,
    requestedEngine: String(payload.requestedEngine ?? "auto"),
    resolvedEngine,
    status: resolvedEngine != null && payload.degraded !== true ? "succeeded" : "skipped",
    degraded: payload.degraded === true,
    reasonCode: typeof payload.reasonCode === "string" ? payload.reasonCode : null,
    reasonDetail: typeof payload.reasonDetail === "string" ? payload.reasonDetail : null,
    planHash: typeof payload.planHash === "string" && payload.planHash.length > 0 ? payload.planHash : "",
    normalizedPlanHash: typeof payload.normalizedPlanHash === "string" && payload.normalizedPlanHash.length > 0 ? payload.normalizedPlanHash : "",
    commandPreview: typeof payload.commandPreview === "string" ? payload.commandPreview : null,
    rawResponse: typeof payload.rawResponse === "string" ? payload.rawResponse : null,
    createdAt: row.created_at,
    durationMs: Number.isFinite(Number(payload.durationMs)) ? Math.floor(Number(payload.durationMs)) : 0,
    validationErrors,
    attempts
  };
}
function toMissionSummary(row) {
  return {
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    laneId: row.lane_id,
    laneName: row.lane_name,
    status: normalizeMissionStatus(row.status),
    priority: normalizeMissionPriority(row.priority),
    executionMode: normalizeExecutionMode(row.execution_mode),
    targetMachineId: row.target_machine_id,
    outcomeSummary: row.outcome_summary,
    lastError: row.last_error,
    artifactCount: Number(row.artifact_count ?? 0),
    openInterventions: Number(row.open_interventions ?? 0),
    totalSteps: Number(row.total_steps ?? 0),
    completedSteps: Number(row.completed_steps ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at
  };
}
function toMissionStep(row) {
  return {
    id: row.id,
    missionId: row.mission_id,
    index: Number(row.step_index ?? 0),
    title: row.title,
    detail: row.detail,
    kind: row.kind,
    laneId: row.lane_id,
    status: normalizeStepStatus(row.status),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    metadata: safeParseRecord(row.metadata_json)
  };
}
function toMissionEvent(row) {
  return {
    id: row.id,
    missionId: row.mission_id,
    eventType: row.event_type,
    actor: row.actor,
    summary: row.summary,
    payload: safeParseRecord(row.payload_json),
    createdAt: row.created_at
  };
}
function toMissionArtifact(row) {
  return {
    id: row.id,
    missionId: row.mission_id,
    artifactType: normalizeArtifactType(row.artifact_type),
    title: row.title,
    description: row.description,
    uri: row.uri,
    laneId: row.lane_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: safeParseRecord(row.metadata_json)
  };
}
function toMissionIntervention(row) {
  return {
    id: row.id,
    missionId: row.mission_id,
    interventionType: normalizeInterventionType(row.intervention_type),
    status: normalizeInterventionStatus(row.status),
    title: row.title,
    body: row.body,
    requestedAction: row.requested_action,
    resolutionNote: row.resolution_note,
    laneId: row.lane_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
    metadata: safeParseRecord(row.metadata_json)
  };
}
function hasTransition(graph, from, to) {
  return graph[from]?.has(to) ?? false;
}
function isValidMissionTransition(from, to) {
  return hasTransition(MISSION_TRANSITIONS, from, to);
}
function isValidMissionStepTransition(from, to) {
  return STEP_TRANSITIONS[from]?.has(to) ?? false;
}
function createMissionService({
  db,
  projectId,
  onEvent,
  concurrencyConfig
}) {
  let activeConcurrencyConfig = {
    ...DEFAULT_CONCURRENCY_CONFIG,
    ...concurrencyConfig
  };
  let serviceRef = null;
  const emit = (payload) => {
    try {
      onEvent?.({
        type: "missions-updated",
        at: nowIso(),
        ...payload
      });
    } catch {
    }
  };
  const assertLaneExists = (laneId) => {
    if (!laneId) return;
    const hit = db.get(
      "select id from lanes where id = ? and project_id = ? and status != 'archived' limit 1",
      [laneId, projectId]
    );
    if (!hit?.id) {
      throw new Error(`Lane not found or archived: ${laneId}`);
    }
  };
  const baseMissionSelect = `
    select
      m.id as id,
      m.title as title,
      m.prompt as prompt,
      m.lane_id as lane_id,
      l.name as lane_name,
      m.status as status,
      m.priority as priority,
      m.execution_mode as execution_mode,
      m.target_machine_id as target_machine_id,
      m.outcome_summary as outcome_summary,
      m.last_error as last_error,
      (
        select count(*)
        from mission_artifacts ma
        where ma.project_id = m.project_id and ma.mission_id = m.id
      ) as artifact_count,
      (
        select count(*)
        from mission_interventions mi
        where mi.project_id = m.project_id and mi.mission_id = m.id and mi.status = 'open'
      ) as open_interventions,
      (
        select count(*)
        from mission_steps ms
        where ms.project_id = m.project_id and ms.mission_id = m.id
      ) as total_steps,
      (
        select count(*)
        from mission_steps ms
        where ms.project_id = m.project_id and ms.mission_id = m.id and ms.status in ('succeeded', 'skipped')
      ) as completed_steps,
      m.created_at as created_at,
      m.updated_at as updated_at,
      m.started_at as started_at,
      m.completed_at as completed_at
    from missions m
    left join lanes l on l.id = m.lane_id
    where m.project_id = ?
  `;
  const getMissionRow = (missionId) => {
    return db.get(
      `${baseMissionSelect}
       and m.id = ?
       limit 1`,
      [projectId, missionId]
    );
  };
  const recordEvent = (args) => {
    const id = (0, import_node_crypto7.randomUUID)();
    const createdAt = nowIso();
    db.run(
      `
        insert into mission_events(
          id,
          mission_id,
          project_id,
          event_type,
          actor,
          summary,
          payload_json,
          created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        id,
        args.missionId,
        projectId,
        args.eventType,
        args.actor,
        args.summary,
        args.payload ? JSON.stringify(args.payload) : null,
        createdAt
      ]
    );
    return {
      id,
      missionId: args.missionId,
      eventType: args.eventType,
      actor: args.actor,
      summary: args.summary,
      payload: args.payload ?? null,
      createdAt
    };
  };
  const upsertMissionStatus = (args) => {
    const row = db.get(
      "select status, started_at, completed_at from missions where id = ? and project_id = ? limit 1",
      [args.missionId, projectId]
    );
    if (!row) throw new Error(`Mission not found: ${args.missionId}`);
    const previous = normalizeMissionStatus(row.status);
    const next = args.nextStatus;
    if (!isValidMissionTransition(previous, next)) {
      throw new Error(`Invalid mission transition: ${previous} -> ${next}`);
    }
    const updatedAt = args.updatedAt ?? nowIso();
    let startedAt = row.started_at;
    let completedAt = row.completed_at;
    if (next === "planning" || next === "plan_review" || next === "in_progress") {
      if (!startedAt) startedAt = updatedAt;
      completedAt = null;
    } else if (next === "queued") {
      startedAt = null;
      completedAt = null;
    } else if (TERMINAL_MISSION_STATUSES.has(next)) {
      completedAt = updatedAt;
      if (!startedAt) startedAt = updatedAt;
    }
    db.run(
      `
        update missions
        set status = ?,
            started_at = ?,
            completed_at = ?,
            updated_at = ?
        where id = ?
          and project_id = ?
      `,
      [next, startedAt, completedAt, updatedAt, args.missionId, projectId]
    );
    if (previous !== next) {
      recordEvent({
        missionId: args.missionId,
        eventType: "mission_status_changed",
        actor: args.actor ?? "user",
        summary: args.summary ?? `Mission status changed to ${next}.`,
        payload: {
          from: previous,
          to: next,
          ...args.payload ?? {}
        }
      });
      if (TERMINAL_MISSION_STATUSES.has(next) && serviceRef) {
        try {
          serviceRef.processQueue();
        } catch {
        }
      }
    }
  };
  const insertArtifact = (args) => {
    assertLaneExists(args.laneId ?? null);
    const id = (0, import_node_crypto7.randomUUID)();
    const createdAt = nowIso();
    const title = args.title.trim();
    if (!title.length) throw new Error("Artifact title is required");
    const description = sanitizeOptionalText(args.description ?? null);
    const uri = coerceNullableString(args.uri);
    db.run(
      `
        insert into mission_artifacts(
          id,
          mission_id,
          project_id,
          artifact_type,
          title,
          description,
          uri,
          lane_id,
          metadata_json,
          created_at,
          updated_at,
          created_by
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        id,
        args.missionId,
        projectId,
        args.artifactType,
        title,
        description,
        uri,
        args.laneId ?? null,
        args.metadata ? JSON.stringify(args.metadata) : null,
        createdAt,
        createdAt,
        args.createdBy
      ]
    );
    return {
      id,
      missionId: args.missionId,
      artifactType: args.artifactType,
      title,
      description,
      uri,
      laneId: args.laneId ?? null,
      createdBy: args.createdBy,
      createdAt,
      updatedAt: createdAt,
      metadata: args.metadata ?? null
    };
  };
  const insertIntervention = (args) => {
    assertLaneExists(args.laneId ?? null);
    const id = (0, import_node_crypto7.randomUUID)();
    const createdAt = nowIso();
    const title = args.title.trim();
    const body = args.body.trim();
    if (!title.length) throw new Error("Intervention title is required");
    if (!body.length) throw new Error("Intervention body is required");
    db.run(
      `
        insert into mission_interventions(
          id,
          mission_id,
          project_id,
          intervention_type,
          status,
          title,
          body,
          requested_action,
          resolution_note,
          lane_id,
          metadata_json,
          created_at,
          updated_at,
          resolved_at
        ) values (?, ?, ?, ?, 'open', ?, ?, ?, null, ?, ?, ?, ?, null)
      `,
      [
        id,
        args.missionId,
        projectId,
        args.interventionType,
        title,
        body,
        sanitizeOptionalText(args.requestedAction ?? null),
        args.laneId ?? null,
        args.metadata ? JSON.stringify(args.metadata) : null,
        createdAt,
        createdAt
      ]
    );
    return {
      id,
      missionId: args.missionId,
      interventionType: args.interventionType,
      status: "open",
      title,
      body,
      requestedAction: sanitizeOptionalText(args.requestedAction ?? null),
      resolutionNote: null,
      laneId: args.laneId ?? null,
      createdAt,
      updatedAt: createdAt,
      resolvedAt: null,
      metadata: args.metadata ?? null
    };
  };
  const service = {
    list(args = {}) {
      const where = [];
      const params = [projectId];
      const laneId = typeof args.laneId === "string" ? args.laneId.trim() : "";
      if (laneId.length) {
        where.push("m.lane_id = ?");
        params.push(laneId);
      }
      if (args.status === "active") {
        where.push("m.status in ('queued', 'planning', 'plan_review', 'in_progress', 'intervention_required')");
      } else if (args.status) {
        where.push("m.status = ?");
        params.push(args.status);
      }
      const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(500, Math.floor(args.limit ?? 120))) : 120;
      const rows = db.all(
        `${baseMissionSelect}
         ${where.length ? `and ${where.join(" and ")}` : ""}
         order by
           case m.status
             when 'intervention_required' then 0
             when 'in_progress' then 1
             when 'plan_review' then 2
             when 'planning' then 3
             when 'queued' then 4
             when 'failed' then 5
             when 'completed' then 6
             else 7
           end,
           m.updated_at desc,
           m.created_at desc
         limit ?`,
        [...params, limit]
      );
      return rows.map(toMissionSummary);
    },
    get(missionId) {
      const id = missionId.trim();
      if (!id.length) return null;
      const row = getMissionRow(id);
      if (!row) return null;
      const steps = db.all(
        `
            select
              id,
              mission_id,
              step_index,
              title,
              detail,
              kind,
              lane_id,
              status,
              created_at,
              updated_at,
              started_at,
              completed_at,
              metadata_json
            from mission_steps
            where project_id = ?
              and mission_id = ?
            order by step_index asc
          `,
        [projectId, id]
      ).map(toMissionStep);
      const events = db.all(
        `
            select
              id,
              mission_id,
              event_type,
              actor,
              summary,
              payload_json,
              created_at
            from mission_events
            where project_id = ?
              and mission_id = ?
            order by created_at desc
            limit 500
          `,
        [projectId, id]
      ).map(toMissionEvent);
      const artifacts = db.all(
        `
            select
              id,
              mission_id,
              artifact_type,
              title,
              description,
              uri,
              lane_id,
              created_by,
              created_at,
              updated_at,
              metadata_json
            from mission_artifacts
            where project_id = ?
              and mission_id = ?
            order by created_at desc
          `,
        [projectId, id]
      ).map(toMissionArtifact);
      const interventions = db.all(
        `
            select
              id,
              mission_id,
              intervention_type,
              status,
              title,
              body,
              requested_action,
              resolution_note,
              lane_id,
              created_at,
              updated_at,
              resolved_at,
              metadata_json
            from mission_interventions
            where project_id = ?
              and mission_id = ?
            order by
              case status when 'open' then 0 when 'resolved' then 1 else 2 end,
              created_at desc
          `,
        [projectId, id]
      ).map(toMissionIntervention);
      return {
        ...toMissionSummary(row),
        steps,
        events,
        artifacts,
        interventions
      };
    },
    listPlannerRuns(args = {}) {
      const where = ["project_id = ?", "event_type = 'mission_plan_generated'"];
      const params = [projectId];
      const missionId = String(args.missionId ?? "").trim();
      if (missionId.length > 0) {
        where.push("mission_id = ?");
        params.push(missionId);
      }
      const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(250, Math.floor(args.limit ?? 50))) : 50;
      const rows = db.all(
        `
          select id, mission_id, event_type, actor, summary, payload_json, created_at
          from mission_events
          where ${where.join(" and ")}
          order by created_at desc
          limit ?
        `,
        [...params, limit]
      );
      return rows.map((row) => toPlannerRunFromEvent(row)).filter((entry) => entry != null);
    },
    getPlannerAttempt(args) {
      const plannerRunId = String(args.plannerRunId ?? "").trim();
      const attemptId = String(args.attemptId ?? "").trim();
      if (!plannerRunId.length || !attemptId.length) return null;
      const runs = this.listPlannerRuns({ limit: 250 });
      const run = runs.find((entry) => entry.id === plannerRunId);
      if (!run) return null;
      return run.attempts.find((entry) => entry.id === attemptId) ?? null;
    },
    create(args) {
      const prompt = normalizePrompt2(args.prompt ?? "");
      if (!prompt.length) {
        throw new Error("Mission prompt is required.");
      }
      const title = deriveMissionTitle(prompt, args.title);
      const laneId = coerceNullableString(args.laneId);
      assertLaneExists(laneId);
      const priority = args.priority ?? "normal";
      const executionMode = args.executionMode ?? "local";
      const targetMachineId = coerceNullableString(args.targetMachineId);
      const plannerRun = args.plannerRun ?? null;
      const plannerPlan = args.plannerPlan ?? null;
      const launchMode = args.launchMode === "manual" ? "manual" : "autopilot";
      const autostart = args.autostart !== false;
      const autopilotExecutor = args.autopilotExecutor ?? "codex";
      const executorPolicy = normalizeMissionExecutorPolicy(args.executorPolicy);
      const allowPlanningQuestions = args.allowPlanningQuestions === true;
      const launchModelRaw = typeof args.orchestratorModel === "string" ? args.orchestratorModel.trim().toLowerCase() : "";
      const launchModel = launchModelRaw === "opus" || launchModelRaw === "sonnet" || launchModelRaw === "haiku" ? launchModelRaw : null;
      const launchThinkingBudgets = (() => {
        if (!isRecord3(args.thinkingBudgets)) return null;
        const out = {};
        for (const [key, value] of Object.entries(args.thinkingBudgets)) {
          const normalizedKey = String(key).trim();
          const numeric = Number(value);
          if (!normalizedKey.length || !Number.isFinite(numeric) || numeric < 0) continue;
          out[normalizedKey] = Math.floor(numeric);
        }
        return Object.keys(out).length > 0 ? out : null;
      })();
      const missionDepthRaw = typeof args.missionDepth === "string" ? args.missionDepth.trim() : "";
      const missionDepth = missionDepthRaw === "light" || missionDepthRaw === "standard" || missionDepthRaw === "deep" ? missionDepthRaw : null;
      const executionPolicyArg = args.executionPolicy && typeof args.executionPolicy === "object" ? args.executionPolicy : null;
      const resolvedExecutionPolicy = executionPolicyArg ? mergeWithDefaults(executionPolicyArg) : missionDepth ? depthTierToPolicy(missionDepth) : null;
      const legacyPlan = buildDeterministicMissionPlan({
        prompt,
        laneId
      });
      const stepsToPersist = Array.isArray(args.plannedSteps) && args.plannedSteps.length ? [...args.plannedSteps].sort((a, b) => a.index - b.index || a.title.localeCompare(b.title)) : legacyPlan.steps.map((step) => ({
        index: step.index,
        title: step.title,
        detail: step.detail,
        kind: step.kind,
        metadata: step.metadata
      }));
      const id = (0, import_node_crypto7.randomUUID)();
      const createdAt = nowIso();
      const missionMetadata = {
        source: "manual",
        version: 2,
        launch: {
          autostart,
          runMode: launchMode,
          autopilotExecutor,
          executorPolicy,
          allowPlanningQuestions,
          ...launchModel ? { orchestratorModel: launchModel } : {},
          ...launchThinkingBudgets ? { thinkingBudgets: launchThinkingBudgets } : {},
          ...args.modelConfig ? { modelConfig: args.modelConfig } : {},
          ...args.modelConfig && typeof args.modelConfig === "object" ? { intelligenceConfig: args.modelConfig.intelligenceConfig } : {},
          ...args.allowParallelSubagents != null ? { allowParallelSubagents: args.allowParallelSubagents } : {},
          ...args.allowAgentTeams != null ? { allowAgentTeams: args.allowAgentTeams } : {}
        },
        ...missionDepth ? { missionDepth } : {},
        ...resolvedExecutionPolicy ? { executionPolicy: resolvedExecutionPolicy } : {},
        planner: plannerRun ? {
          id: plannerRun.id,
          requestedEngine: plannerRun.requestedEngine,
          resolvedEngine: plannerRun.resolvedEngine,
          status: plannerRun.status,
          degraded: plannerRun.degraded,
          reasonCode: plannerRun.reasonCode,
          reasonDetail: plannerRun.reasonDetail,
          planHash: plannerRun.planHash,
          normalizedPlanHash: plannerRun.normalizedPlanHash,
          commandPreview: plannerRun.commandPreview,
          rawResponse: truncateForMetadata(plannerRun.rawResponse, 2e5),
          durationMs: plannerRun.durationMs,
          validationErrors: plannerRun.validationErrors,
          attempts: plannerRun.attempts.map((attempt) => ({
            id: attempt.id,
            engine: attempt.engine,
            status: attempt.status,
            reasonCode: attempt.reasonCode,
            detail: attempt.detail,
            commandPreview: attempt.commandPreview,
            rawResponse: truncateForMetadata(attempt.rawResponse, 5e4),
            validationErrors: attempt.validationErrors,
            createdAt: attempt.createdAt
          }))
        } : {
          id: null,
          requestedEngine: args.plannerEngine ?? "auto",
          resolvedEngine: null,
          status: "skipped",
          degraded: false,
          reasonCode: "planner_unavailable",
          reasonDetail: "Planner run was not provided.",
          planHash: null,
          normalizedPlanHash: null,
          commandPreview: null,
          rawResponse: null,
          durationMs: null,
          validationErrors: [],
          attempts: []
        },
        plannerPlan: plannerPlan ? {
          schemaVersion: plannerPlan.schemaVersion,
          missionSummary: plannerPlan.missionSummary,
          assumptions: plannerPlan.assumptions,
          risks: plannerPlan.risks,
          stepCount: plannerPlan.steps.length,
          handoffPolicy: plannerPlan.handoffPolicy
        } : null
      };
      db.run(
        `
          insert into missions(
            id,
            project_id,
            lane_id,
            title,
            prompt,
            status,
            priority,
            execution_mode,
            target_machine_id,
            outcome_summary,
            last_error,
            metadata_json,
            created_at,
            updated_at,
            started_at,
            completed_at
          ) values (?, ?, ?, ?, ?, 'queued', ?, ?, ?, null, null, ?, ?, ?, null, null)
        `,
        [
          id,
          projectId,
          laneId,
          title,
          prompt,
          priority,
          executionMode,
          targetMachineId,
          JSON.stringify(missionMetadata),
          createdAt,
          createdAt
        ]
      );
      stepsToPersist.forEach((step, index) => {
        const stepId = (0, import_node_crypto7.randomUUID)();
        db.run(
          `
            insert into mission_steps(
              id,
              mission_id,
              project_id,
              step_index,
              title,
              detail,
              kind,
              lane_id,
              status,
              metadata_json,
              created_at,
              updated_at,
              started_at,
              completed_at
            ) values (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, null, null)
          `,
          [
            stepId,
            id,
            projectId,
            index,
            step.title,
            step.detail,
            step.kind,
            laneId,
            JSON.stringify(step.metadata),
            createdAt,
            createdAt
          ]
        );
      });
      recordEvent({
        missionId: id,
        eventType: "mission_created",
        actor: "user",
        summary: "Mission created from plain-English prompt.",
        payload: {
          title,
          laneId,
          priority,
          executionMode,
          targetMachineId,
          preview: summarizePrompt(prompt),
          plannerVersion: plannerRun ? "ade.missionPlanner.v2" : legacyPlan.plannerVersion,
          plannerStrategy: plannerPlan?.missionSummary.strategy ?? legacyPlan.strategy,
          plannerStepCount: stepsToPersist.length,
          plannerKeywords: legacyPlan.keywords,
          plannerEngineRequested: plannerRun?.requestedEngine ?? args.plannerEngine ?? "auto",
          plannerEngineResolved: plannerRun?.resolvedEngine ?? null,
          plannerDegraded: plannerRun?.degraded ?? false,
          executorPolicy
        }
      });
      if (plannerRun) {
        recordEvent({
          missionId: id,
          eventType: "mission_plan_generated",
          actor: "system",
          summary: `Planner completed with ${plannerRun.resolvedEngine ?? "unknown"}.`,
          payload: {
            plannerRunId: plannerRun.id,
            requestedEngine: plannerRun.requestedEngine,
            resolvedEngine: plannerRun.resolvedEngine,
            status: plannerRun.status,
            degraded: plannerRun.degraded,
            reasonCode: plannerRun.reasonCode,
            reasonDetail: plannerRun.reasonDetail,
            planHash: plannerRun.planHash,
            normalizedPlanHash: plannerRun.normalizedPlanHash,
            commandPreview: plannerRun.commandPreview,
            rawResponse: truncateForMetadata(plannerRun.rawResponse, 8e3),
            durationMs: plannerRun.durationMs,
            validationErrors: plannerRun.validationErrors,
            attempts: plannerRun.attempts.map((attempt) => ({
              id: attempt.id,
              engine: attempt.engine,
              status: attempt.status,
              reasonCode: attempt.reasonCode,
              detail: attempt.detail,
              createdAt: attempt.createdAt
            }))
          }
        });
      }
      emit({ missionId: id, reason: "created" });
      const detail = this.get(id);
      if (!detail) throw new Error("Mission creation failed");
      return detail;
    },
    update(args) {
      const missionId = args.missionId.trim();
      if (!missionId.length) throw new Error("Mission id is required.");
      const existing = db.get(
        `
          select
            id,
            title,
            prompt,
            lane_id,
            status,
            priority,
            execution_mode,
            target_machine_id,
            outcome_summary,
            last_error
          from missions
          where id = ?
            and project_id = ?
          limit 1
        `,
        [missionId, projectId]
      );
      if (!existing) {
        throw new Error(`Mission not found: ${missionId}`);
      }
      const nextLaneId = args.laneId !== void 0 ? coerceNullableString(args.laneId) : existing.lane_id;
      assertLaneExists(nextLaneId);
      const nextPrompt = args.prompt !== void 0 ? normalizePrompt2(args.prompt) : existing.prompt;
      if (!nextPrompt.length) throw new Error("Mission prompt cannot be empty.");
      const nextTitle = args.title !== void 0 ? deriveMissionTitle(nextPrompt, args.title) : existing.title;
      const nextPriority = args.priority ?? normalizeMissionPriority(existing.priority);
      const nextExecutionMode = args.executionMode ?? normalizeExecutionMode(existing.execution_mode);
      const nextTargetMachineId = args.targetMachineId !== void 0 ? coerceNullableString(args.targetMachineId) : existing.target_machine_id;
      const nextOutcomeSummary = args.outcomeSummary !== void 0 ? sanitizeOptionalText(args.outcomeSummary) : existing.outcome_summary;
      const nextLastError = args.lastError !== void 0 ? sanitizeOptionalText(args.lastError) : existing.last_error;
      const updatedAt = nowIso();
      if (args.status) {
        upsertMissionStatus({
          missionId,
          nextStatus: args.status,
          updatedAt,
          summary: `Mission status changed to ${args.status}.`
        });
      }
      db.run(
        `
          update missions
          set title = ?,
              prompt = ?,
              lane_id = ?,
              priority = ?,
              execution_mode = ?,
              target_machine_id = ?,
              outcome_summary = ?,
              last_error = ?,
              updated_at = ?
          where id = ?
            and project_id = ?
        `,
        [
          nextTitle,
          nextPrompt,
          nextLaneId,
          nextPriority,
          nextExecutionMode,
          nextTargetMachineId,
          nextOutcomeSummary,
          nextLastError,
          updatedAt,
          missionId,
          projectId
        ]
      );
      const changedFields = [];
      if (nextTitle !== existing.title) changedFields.push("title");
      if (nextPrompt !== existing.prompt) changedFields.push("prompt");
      if (nextLaneId !== existing.lane_id) changedFields.push("laneId");
      if (nextPriority !== existing.priority) changedFields.push("priority");
      if (nextExecutionMode !== existing.execution_mode) changedFields.push("executionMode");
      if (nextTargetMachineId !== existing.target_machine_id) changedFields.push("targetMachineId");
      if (nextOutcomeSummary !== existing.outcome_summary) changedFields.push("outcomeSummary");
      if (nextLastError !== existing.last_error) changedFields.push("lastError");
      if (changedFields.length) {
        recordEvent({
          missionId,
          eventType: "mission_updated",
          actor: "user",
          summary: `Mission updated (${changedFields.join(", ")}).`,
          payload: { changedFields }
        });
      }
      if (nextOutcomeSummary && args.outcomeSummary !== void 0) {
        const hasSummaryArtifact = db.get(
          `
            select id
            from mission_artifacts
            where project_id = ?
              and mission_id = ?
              and artifact_type = 'summary'
            order by created_at desc
            limit 1
          `,
          [projectId, missionId]
        );
        if (!hasSummaryArtifact?.id) {
          const summaryArtifact = insertArtifact({
            missionId,
            artifactType: "summary",
            title: "Mission outcome summary",
            description: nextOutcomeSummary,
            createdBy: "system"
          });
          recordEvent({
            missionId,
            eventType: "mission_artifact_added",
            actor: "system",
            summary: "Outcome summary artifact recorded.",
            payload: {
              artifactId: summaryArtifact.id,
              artifactType: summaryArtifact.artifactType
            }
          });
        }
      }
      emit({ missionId, reason: "updated" });
      const detail = this.get(missionId);
      if (!detail) throw new Error("Mission update failed");
      return detail;
    },
    delete(args) {
      const missionId = args.missionId.trim();
      if (!missionId.length) throw new Error("missionId is required.");
      if (!getMissionRow(missionId)) throw new Error(`Mission not found: ${missionId}`);
      const runRows = db.all(
        `
          select id
          from orchestrator_runs
          where project_id = ?
            and mission_id = ?
        `,
        [projectId, missionId]
      );
      const runIds = runRows.map((row) => row.id);
      const runPlaceholders = runIds.map(() => "?").join(", ");
      db.run(
        `
          delete from mission_step_handoffs
          where project_id = ?
            and mission_id = ?
        `,
        [projectId, missionId]
      );
      if (runIds.length) {
        db.run(
          `
            update orchestrator_attempts
            set context_snapshot_id = null
            where project_id = ?
              and run_id in (${runPlaceholders})
          `,
          [projectId, ...runIds]
        );
        db.run(
          `
            delete from orchestrator_attempt_runtime
            where attempt_id in (
              select id
              from orchestrator_attempts
              where project_id = ?
                and run_id in (${runPlaceholders})
            )
          `,
          [projectId, ...runIds]
        );
        db.run(
          `
            delete from orchestrator_runtime_events
            where project_id = ?
              and run_id in (${runPlaceholders})
          `,
          [projectId, ...runIds]
        );
        db.run(
          `
            delete from orchestrator_claims
            where project_id = ?
              and run_id in (${runPlaceholders})
          `,
          [projectId, ...runIds]
        );
        db.run(
          `
            delete from orchestrator_chat_messages
            where project_id = ?
              and run_id in (${runPlaceholders})
          `,
          [projectId, ...runIds]
        );
        db.run(
          `
            delete from orchestrator_worker_digests
            where project_id = ?
              and run_id in (${runPlaceholders})
          `,
          [projectId, ...runIds]
        );
        db.run(
          `
            delete from orchestrator_lane_decisions
            where project_id = ?
              and run_id in (${runPlaceholders})
          `,
          [projectId, ...runIds]
        );
        db.run(
          `
            delete from orchestrator_context_checkpoints
            where project_id = ?
              and run_id in (${runPlaceholders})
          `,
          [projectId, ...runIds]
        );
        db.run(
          `
            delete from orchestrator_worker_checkpoints
            where project_id = ?
              and run_id in (${runPlaceholders})
          `,
          [projectId, ...runIds]
        );
        db.run(
          `
            delete from orchestrator_metrics_samples
            where project_id = ?
              and run_id in (${runPlaceholders})
          `,
          [projectId, ...runIds]
        );
        db.run(
          `
            delete from orchestrator_context_snapshots
            where project_id = ?
              and run_id in (${runPlaceholders})
          `,
          [projectId, ...runIds]
        );
        db.run(
          `
            delete from orchestrator_chat_threads
            where project_id = ?
              and run_id in (${runPlaceholders})
          `,
          [projectId, ...runIds]
        );
        db.run(
          `
            delete from orchestrator_attempts
            where project_id = ?
              and run_id in (${runPlaceholders})
          `,
          [projectId, ...runIds]
        );
        db.run(
          `
            delete from orchestrator_steps
            where project_id = ?
              and run_id in (${runPlaceholders})
          `,
          [projectId, ...runIds]
        );
      }
      db.run(
        `
          delete from mission_metrics_config
          where project_id = ?
            and mission_id = ?
        `,
        [projectId, missionId]
      );
      db.run(
        `
          delete from orchestrator_chat_messages
          where project_id = ?
            and mission_id = ?
        `,
        [projectId, missionId]
      );
      db.run(
        `
          delete from orchestrator_chat_threads
          where project_id = ?
            and mission_id = ?
        `,
        [projectId, missionId]
      );
      db.run(
        `
          delete from orchestrator_worker_digests
          where project_id = ?
            and mission_id = ?
        `,
        [projectId, missionId]
      );
      db.run(
        `
          delete from orchestrator_lane_decisions
          where project_id = ?
            and mission_id = ?
        `,
        [projectId, missionId]
      );
      db.run(
        `
          delete from orchestrator_context_checkpoints
          where project_id = ?
            and mission_id = ?
        `,
        [projectId, missionId]
      );
      db.run(
        `
          delete from orchestrator_worker_checkpoints
          where project_id = ?
            and mission_id = ?
        `,
        [projectId, missionId]
      );
      db.run(
        `
          delete from orchestrator_metrics_samples
          where project_id = ?
            and mission_id = ?
        `,
        [projectId, missionId]
      );
      db.run(
        `
          delete from orchestrator_runs
          where project_id = ?
            and mission_id = ?
        `,
        [projectId, missionId]
      );
      db.run(
        `
          delete from mission_interventions
          where project_id = ?
            and mission_id = ?
        `,
        [projectId, missionId]
      );
      db.run(
        `
          delete from mission_artifacts
          where project_id = ?
            and mission_id = ?
        `,
        [projectId, missionId]
      );
      db.run(
        `
          delete from mission_events
          where project_id = ?
            and mission_id = ?
        `,
        [projectId, missionId]
      );
      db.run(
        `
          delete from mission_steps
          where project_id = ?
            and mission_id = ?
        `,
        [projectId, missionId]
      );
      db.run(
        `
          delete from missions
          where project_id = ?
            and id = ?
        `,
        [projectId, missionId]
      );
      emit({ missionId, reason: "deleted" });
    },
    updateStep(args) {
      const missionId = args.missionId.trim();
      const stepId = args.stepId.trim();
      if (!missionId.length || !stepId.length) throw new Error("missionId and stepId are required.");
      const step = db.get(
        `
          select
            id,
            mission_id,
            step_index,
            title,
            detail,
            kind,
            lane_id,
            status,
            created_at,
            updated_at,
            started_at,
            completed_at,
            metadata_json
          from mission_steps
          where id = ?
            and mission_id = ?
            and project_id = ?
          limit 1
        `,
        [stepId, missionId, projectId]
      );
      if (!step) {
        throw new Error(`Mission step not found: ${stepId}`);
      }
      const previous = normalizeStepStatus(step.status);
      const next = args.status;
      if (!isValidMissionStepTransition(previous, next)) {
        throw new Error(`Invalid mission step transition: ${previous} -> ${next}`);
      }
      const updatedAt = nowIso();
      let startedAt = step.started_at;
      let completedAt = step.completed_at;
      if (next === "running") {
        if (!startedAt) startedAt = updatedAt;
        completedAt = null;
      }
      if (next === "pending") {
        startedAt = null;
        completedAt = null;
      }
      if (next === "succeeded" || next === "failed" || next === "skipped" || next === "canceled") {
        if (!startedAt) startedAt = updatedAt;
        completedAt = updatedAt;
      }
      if (next === "blocked") {
        completedAt = null;
      }
      db.run(
        `
          update mission_steps
          set status = ?,
              started_at = ?,
              completed_at = ?,
              updated_at = ?
          where id = ?
            and mission_id = ?
            and project_id = ?
        `,
        [next, startedAt, completedAt, updatedAt, stepId, missionId, projectId]
      );
      const note = sanitizeOptionalText(args.note ?? null);
      recordEvent({
        missionId,
        eventType: "mission_step_updated",
        actor: "user",
        summary: `Step ${Number(step.step_index) + 1} set to ${next}.`,
        payload: {
          stepId,
          stepIndex: Number(step.step_index),
          stepTitle: step.title,
          from: previous,
          to: next,
          ...note ? { note } : {}
        }
      });
      if (next === "failed") {
        const intervention = insertIntervention({
          missionId,
          interventionType: "failed_step",
          title: `Step failed: ${step.title}`,
          body: note ?? "A mission step was marked as failed and needs attention.",
          requestedAction: "Review the failure and decide whether to continue, retry, or cancel."
        });
        db.run(
          `
            update missions
            set last_error = ?,
                updated_at = ?
            where id = ?
              and project_id = ?
          `,
          [note ?? step.title, updatedAt, missionId, projectId]
        );
        upsertMissionStatus({
          missionId,
          nextStatus: "intervention_required",
          updatedAt,
          summary: "Mission paused for intervention after step failure.",
          payload: {
            interventionId: intervention.id,
            stepId
          }
        });
      }
      emit({ missionId, reason: "step-updated" });
      const nextStep = db.get(
        `
          select
            id,
            mission_id,
            step_index,
            title,
            detail,
            kind,
            lane_id,
            status,
            created_at,
            updated_at,
            started_at,
            completed_at,
            metadata_json
          from mission_steps
          where id = ?
            and mission_id = ?
            and project_id = ?
          limit 1
        `,
        [stepId, missionId, projectId]
      );
      if (!nextStep) throw new Error("Mission step update failed");
      return toMissionStep(nextStep);
    },
    addArtifact(args) {
      const missionId = args.missionId.trim();
      if (!missionId.length) throw new Error("missionId is required.");
      if (!getMissionRow(missionId)) throw new Error(`Mission not found: ${missionId}`);
      const artifact = insertArtifact({
        missionId,
        artifactType: args.artifactType,
        title: args.title,
        description: args.description,
        uri: args.uri,
        laneId: args.laneId,
        metadata: args.metadata,
        createdBy: "user"
      });
      recordEvent({
        missionId,
        eventType: "mission_artifact_added",
        actor: "user",
        summary: `Artifact added: ${artifact.title}`,
        payload: {
          artifactId: artifact.id,
          artifactType: artifact.artifactType,
          uri: artifact.uri
        }
      });
      db.run(
        "update missions set updated_at = ? where id = ? and project_id = ?",
        [nowIso(), missionId, projectId]
      );
      emit({ missionId, reason: "artifact-added" });
      return artifact;
    },
    addIntervention(args) {
      const missionId = args.missionId.trim();
      if (!missionId.length) throw new Error("missionId is required.");
      const missionRow = getMissionRow(missionId);
      if (!missionRow) throw new Error(`Mission not found: ${missionId}`);
      const missionStatus = normalizeMissionStatus(missionRow.status);
      const intervention = insertIntervention({
        missionId,
        interventionType: args.interventionType,
        title: args.title,
        body: args.body,
        requestedAction: args.requestedAction,
        laneId: args.laneId,
        metadata: args.metadata
      });
      recordEvent({
        missionId,
        eventType: "mission_intervention_added",
        actor: "user",
        summary: `Intervention added: ${intervention.title}`,
        payload: {
          interventionId: intervention.id,
          interventionType: intervention.interventionType
        }
      });
      const keepPlanReview = missionStatus === "plan_review" && intervention.status === "open" && intervention.interventionType === "approval_required";
      if (!keepPlanReview) {
        upsertMissionStatus({
          missionId,
          nextStatus: "intervention_required",
          summary: "Mission moved to intervention required."
        });
      }
      db.run(
        "update missions set updated_at = ? where id = ? and project_id = ?",
        [nowIso(), missionId, projectId]
      );
      emit({ missionId, reason: "intervention-added" });
      return intervention;
    },
    resolveIntervention(args) {
      const missionId = args.missionId.trim();
      const interventionId = args.interventionId.trim();
      if (!missionId.length || !interventionId.length) {
        throw new Error("missionId and interventionId are required.");
      }
      const row = db.get(
        `
          select
            id,
            mission_id,
            intervention_type,
            status,
            title,
            body,
            requested_action,
            resolution_note,
            lane_id,
            created_at,
            updated_at,
            resolved_at,
            metadata_json
          from mission_interventions
          where id = ?
            and mission_id = ?
            and project_id = ?
          limit 1
        `,
        [interventionId, missionId, projectId]
      );
      if (!row) {
        throw new Error(`Intervention not found: ${interventionId}`);
      }
      const targetStatus = args.status;
      const note = sanitizeOptionalText(args.note ?? null);
      const resolvedAt = nowIso();
      db.run(
        `
          update mission_interventions
          set status = ?,
              resolution_note = ?,
              resolved_at = ?,
              updated_at = ?
          where id = ?
            and mission_id = ?
            and project_id = ?
        `,
        [targetStatus, note, resolvedAt, resolvedAt, interventionId, missionId, projectId]
      );
      recordEvent({
        missionId,
        eventType: "mission_intervention_resolved",
        actor: "user",
        summary: `Intervention ${targetStatus}: ${row.title}`,
        payload: {
          interventionId,
          status: targetStatus,
          ...note ? { note } : {}
        }
      });
      const openCount = db.get(
        `
          select count(*) as count
          from mission_interventions
          where project_id = ?
            and mission_id = ?
            and status = 'open'
        `,
        [projectId, missionId]
      );
      if ((openCount?.count ?? 0) === 0) {
        const mission = db.get(
          "select status from missions where id = ? and project_id = ? limit 1",
          [missionId, projectId]
        );
        if (mission && normalizeMissionStatus(mission.status) === "intervention_required") {
          upsertMissionStatus({
            missionId,
            nextStatus: "in_progress",
            summary: "All interventions resolved. Mission resumed."
          });
        }
      }
      db.run(
        "update missions set updated_at = ? where id = ? and project_id = ?",
        [resolvedAt, missionId, projectId]
      );
      emit({ missionId, reason: "intervention-resolved" });
      const updated = db.get(
        `
          select
            id,
            mission_id,
            intervention_type,
            status,
            title,
            body,
            requested_action,
            resolution_note,
            lane_id,
            created_at,
            updated_at,
            resolved_at,
            metadata_json
          from mission_interventions
          where id = ?
            and mission_id = ?
            and project_id = ?
          limit 1
        `,
        [interventionId, missionId, projectId]
      );
      if (!updated) throw new Error("Intervention update failed");
      return toMissionIntervention(updated);
    },
    // ── Concurrency Guard ────────────────────────────────────────
    canStartMission(missionId) {
      const activeMissions = this.list({ status: "active" }).filter((m) => ACTIVE_MISSION_STATUSES.has(m.status) && m.id !== missionId);
      const maxConcurrent = activeConcurrencyConfig.maxConcurrentMissions;
      if (activeMissions.length >= maxConcurrent) {
        const queuedMissions = this.list({}).filter((m) => m.status === "queued").sort(
          (a, b) => (PRIORITY_ORDER[a.priority] ?? 2) - (PRIORITY_ORDER[b.priority] ?? 2) || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
        );
        const queuePosition = queuedMissions.findIndex((m) => m.id === missionId);
        return {
          allowed: false,
          reason: `${activeMissions.length} missions already active (max: ${maxConcurrent})`,
          queuePosition: queuePosition >= 0 ? queuePosition + 1 : void 0
        };
      }
      return { allowed: true };
    },
    isLaneClaimed(laneId, excludeMissionId) {
      if (!activeConcurrencyConfig.laneExclusivity) return { claimed: false };
      if (!laneId) return { claimed: false };
      const activeMissions = this.list({ status: "active" }).filter((m) => ACTIVE_MISSION_STATUSES.has(m.status) && m.id !== excludeMissionId);
      for (const mission of activeMissions) {
        if (mission.laneId === laneId) return { claimed: true, byMissionId: mission.id };
        const detail = this.get(mission.id);
        if (detail) {
          const hasRunningStepOnLane = detail.steps.some(
            (s) => s.laneId === laneId && s.status === "running"
          );
          if (hasRunningStepOnLane) return { claimed: true, byMissionId: mission.id };
        }
      }
      return { claimed: false };
    },
    processQueue() {
      const started = [];
      const queuedMissions = this.list({}).filter((m) => m.status === "queued").sort(
        (a, b) => (PRIORITY_ORDER[a.priority] ?? 2) - (PRIORITY_ORDER[b.priority] ?? 2) || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
      for (const mission of queuedMissions) {
        const detail = this.get(mission.id);
        const metadata = detail ? safeParseRecord(
          db.get(
            "select metadata_json from missions where id = ? and project_id = ? limit 1",
            [mission.id, projectId]
          )?.metadata_json ?? null
        ) : null;
        const launch = metadata && isRecord3(metadata.launch) ? metadata.launch : null;
        if (launch && launch.autostart === false) continue;
        const check = this.canStartMission(mission.id);
        if (!check.allowed) break;
        if (activeConcurrencyConfig.laneExclusivity && mission.laneId) {
          const laneClaim = this.isLaneClaimed(mission.laneId, mission.id);
          if (laneClaim.claimed) continue;
        }
        recordEvent({
          missionId: mission.id,
          eventType: "mission_ready_to_start",
          actor: "system",
          summary: "Mission eligible to start after concurrency slot opened.",
          payload: { queuePosition: 1 }
        });
        emit({ missionId: mission.id, reason: "ready_to_start" });
        started.push(mission.id);
      }
      return started;
    },
    getConcurrencyConfig() {
      return { ...activeConcurrencyConfig };
    },
    setConcurrencyConfig(config) {
      if (config.maxConcurrentMissions !== void 0) {
        activeConcurrencyConfig.maxConcurrentMissions = Math.max(1, Math.floor(config.maxConcurrentMissions));
      }
      if (config.laneExclusivity !== void 0) {
        activeConcurrencyConfig.laneExclusivity = config.laneExclusivity;
      }
      return { ...activeConcurrencyConfig };
    }
  };
  serviceRef = service;
  return service;
}

// ../desktop/src/main/services/pty/ptyService.ts
var import_node_fs11 = __toESM(require("fs"), 1);
var import_node_path11 = __toESM(require("path"), 1);
var import_node_crypto8 = require("crypto");

// ../desktop/src/main/utils/sessionSummary.ts
function clip(text, max = 140) {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1)).trimEnd()}\u2026`;
}
function findLikelyCommand(lines) {
  const promptRegex = /^(?:\$|❯|#|>)\s+(.+)$/;
  const npmScriptHeaderRegex = /^>\s+(?:@[^/\s]+\/)?[^\s@]+@[^\s]+\s+([^\s]+)\s*$/;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? "";
    if (npmScriptHeaderRegex.test(line)) continue;
    const match = line.match(promptRegex);
    if (!match) continue;
    const cmd = match[1]?.trim() ?? "";
    if (!cmd) continue;
    if (cmd.toLowerCase() === "clear") continue;
    return clip(cmd, 160);
  }
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? "";
    const match = line.match(npmScriptHeaderRegex);
    if (!match) continue;
    const script = match[1]?.trim() ?? "";
    if (!script) continue;
    return `npm run ${script}`;
  }
  return null;
}
function parseTestSummary(lines) {
  for (const line of lines) {
    if (!/^Tests:\s+/i.test(line)) continue;
    const passed = Number(line.match(/(\d+)\s+passed/i)?.[1] ?? NaN);
    const failed = Number(line.match(/(\d+)\s+failed/i)?.[1] ?? NaN);
    const total = Number(line.match(/(\d+)\s+total/i)?.[1] ?? NaN);
    const testsTotal = Number.isFinite(total) ? total : Number.isFinite(passed) ? passed : null;
    const status = Number.isFinite(failed) && failed > 0 ? "FAIL" : "PASS";
    return { status, testsTotal, durationText: null };
  }
  let testsLine = null;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] ?? "";
    if (!/\bTests?\b/i.test(line)) continue;
    if (!/\b(passed|failed)\b/i.test(line)) continue;
    testsLine = line;
    break;
  }
  if (testsLine) {
    const passed = Number(testsLine.match(/(\d+)\s+passed/i)?.[1] ?? NaN);
    const failed = Number(testsLine.match(/(\d+)\s+failed/i)?.[1] ?? NaN);
    const total = Number(testsLine.match(/\((\d+)\)\s*$/)?.[1] ?? NaN);
    const testsTotal = Number.isFinite(total) ? total : Number.isFinite(passed) ? passed : null;
    const status = Number.isFinite(failed) && failed > 0 ? "FAIL" : "PASS";
    let durationText = null;
    const durationLine = lines.find((l) => /^Duration\b/i.test(l)) ?? null;
    if (durationLine) {
      const match = durationLine.match(/(\d+(?:\.\d+)?)(ms|s)\b/i);
      if (match) durationText = `${match[1]}${match[2]}`;
    }
    return { status, testsTotal, durationText };
  }
  for (const line of lines) {
    const match = line.match(/\b(\d+)\s+passed\b.*\bin\s+(\d+(?:\.\d+)?)s\b/i);
    if (!match) continue;
    return { status: "PASS", testsTotal: Number(match[1]), durationText: `${match[2]}s` };
  }
  return null;
}
function findFailureHint(lines) {
  const patterns = [
    /\bEACCES\b/i,
    /\bENOENT\b/i,
    /\bpermission denied\b/i,
    /\bTypeError:\b/i,
    /\bReferenceError:\b/i,
    /\bSyntaxError:\b/i,
    /\bTraceback\b/i,
    /\bfatal:\b/i,
    /^\s*error:\s+/i,
    /\bfailed\b/i
  ];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]?.trim() ?? "";
    if (!line) continue;
    if (patterns.some((re) => re.test(line))) return clip(line, 120);
  }
  return null;
}
function summarizeTerminalSession(args) {
  const title = (args.title ?? "").trim();
  const goal = (args.goal ?? "").trim();
  const intent = goal || title || "terminal session";
  const transcript = stripAnsi(args.transcript ?? "");
  const lines = transcript.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-320);
  const cmd = findLikelyCommand(lines) ?? intent;
  const prefix = cmd.toLowerCase().startsWith("ran ") ? cmd : `Ran ${cmd}`;
  const test = parseTestSummary(lines);
  if (test) {
    const testsSuffix = test.testsTotal != null ? `, ${test.testsTotal} tests` : "";
    const durationSuffix = test.durationText ? `, ${test.durationText}` : "";
    return `${prefix} (${test.status}${testsSuffix}${durationSuffix})`;
  }
  if (args.exitCode == null) {
    return `${prefix} (ENDED)`;
  }
  if (args.exitCode === 0) {
    return `${prefix} (OK)`;
  }
  const hint = findFailureHint(lines);
  return `${prefix} (FAIL, exit code ${args.exitCode}${hint ? `, ${hint}` : ""})`;
}

// ../desktop/src/main/utils/terminalPreview.ts
function normalizePreviewLine(raw) {
  if (!raw) return "";
  return raw.replace(/\t/g, " ").replace(/\s+/g, " ").trim();
}
function appendVisibleChar(line, ch) {
  if (!ch) return line;
  const code = ch.charCodeAt(0);
  if (code < 32 || code === 127) return line;
  if (line.length >= 500) return line;
  return line + ch;
}
function derivePreviewFromChunk(args) {
  const maxChars = Number.isFinite(args.maxChars) ? Math.max(20, Math.floor(args.maxChars ?? 220)) : 220;
  const cleaned = stripAnsiWithOptions(args.chunk ?? "", { preserveCarriageReturns: true });
  let line = args.previousLine ?? "";
  let preview = args.previousPreview ?? null;
  const captureLine = () => {
    const normalized = normalizePreviewLine(line);
    if (normalized.length) preview = normalized;
    line = "";
  };
  for (let i = 0; i < cleaned.length; i += 1) {
    const ch = cleaned[i] ?? "";
    if (ch === "\r") {
      line = "";
      continue;
    }
    if (ch === "\n") {
      captureLine();
      continue;
    }
    line = appendVisibleChar(line, ch);
  }
  const currentLine = normalizePreviewLine(line);
  if (currentLine.length) preview = currentLine;
  if (preview && preview.length > maxChars) {
    preview = `${preview.slice(0, Math.max(0, maxChars - 1)).trimEnd()}\u2026`;
  }
  return { nextLine: line.slice(-500), preview };
}

// ../desktop/src/main/services/pty/ptyService.ts
function resolveShellCandidates() {
  if (process.platform === "win32") {
    return [
      { file: "powershell.exe", args: [] },
      { file: "cmd.exe", args: [] }
    ];
  }
  const candidates = [];
  const fromEnv = process.env.SHELL?.trim();
  if (fromEnv) candidates.push(fromEnv);
  candidates.push("/bin/zsh", "/bin/bash", "/bin/sh");
  const uniq = Array.from(new Set(candidates.filter(Boolean)));
  return uniq.map((file) => ({ file, args: [] }));
}
function clampDims(cols, rows) {
  const safeCols = Number.isFinite(cols) ? Math.max(20, Math.min(400, Math.floor(cols))) : 80;
  const safeRows = Number.isFinite(rows) ? Math.max(6, Math.min(200, Math.floor(rows))) : 24;
  return { cols: safeCols, rows: safeRows };
}
function statusFromExit(exitCode) {
  if (exitCode == null) return "completed";
  if (exitCode === 0) return "completed";
  return "failed";
}
function runtimeFromStatus(status) {
  if (status === "running") return "running";
  if (status === "disposed") return "killed";
  return "exited";
}
function normalizeToolType(raw) {
  const value = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!value) return null;
  const allowed = [
    "shell",
    "claude",
    "codex",
    "claude-orchestrated",
    "codex-orchestrated",
    "codex-chat",
    "claude-chat",
    "cursor",
    "aider",
    "continue",
    "other"
  ];
  return allowed.includes(value) ? value : "other";
}
var MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
var TRANSCRIPT_LIMIT_NOTICE = "\n[ADE] transcript limit reached (8MB). Further output omitted.\n";
function createPtyService({
  projectRoot,
  transcriptsDir,
  laneService,
  sessionService,
  aiIntegrationService,
  logger,
  broadcastData,
  broadcastExit,
  onSessionEnded,
  onSessionRuntimeSignal,
  loadPty
}) {
  const ptys = /* @__PURE__ */ new Map();
  const runtimeStates = /* @__PURE__ */ new Map();
  const toolAutoCloseTimers = /* @__PURE__ */ new Map();
  const TOOL_TYPES_WITH_AUTO_CLOSE = /* @__PURE__ */ new Set([
    "claude",
    "codex",
    "claude-orchestrated",
    "codex-orchestrated",
    "aider",
    "cursor",
    "continue"
  ]);
  const clearToolAutoCloseTimer = (ptyId) => {
    const timer = toolAutoCloseTimers.get(ptyId);
    if (timer) {
      clearTimeout(timer);
      toolAutoCloseTimers.delete(ptyId);
    }
  };
  const clearIdleTimer = (sessionId) => {
    const state = runtimeStates.get(sessionId);
    if (!state?.idleTimer) return;
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
  };
  const setRuntimeState = (sessionId, nextState, opts) => {
    const now = Date.now();
    const prev = runtimeStates.get(sessionId);
    if (prev) {
      prev.state = nextState;
      prev.updatedAt = now;
      if (opts?.touch ?? true) {
        prev.lastActivityAt = now;
      }
      runtimeStates.set(sessionId, prev);
      return;
    }
    runtimeStates.set(sessionId, {
      state: nextState,
      updatedAt: now,
      lastActivityAt: now,
      idleTimer: null
    });
  };
  const scheduleIdleTransition = (sessionId) => {
    const state = runtimeStates.get(sessionId);
    if (!state) return;
    clearIdleTimer(sessionId);
    state.idleTimer = setTimeout(() => {
      const current = runtimeStates.get(sessionId);
      if (!current) return;
      if (current.state !== "running") return;
      if (Date.now() - current.lastActivityAt < 12e3) return;
      current.state = "idle";
      current.updatedAt = Date.now();
      current.idleTimer = null;
    }, 12500);
  };
  const safeTranscriptPathFor = (sessionId) => import_node_path11.default.join(transcriptsDir, `${sessionId}.log`);
  const computeHeadShaBestEffort = async (worktreePath) => {
    const res = await runGit(["rev-parse", "HEAD"], { cwd: worktreePath, timeoutMs: 6e3 });
    if (res.exitCode !== 0) return null;
    const sha = res.stdout.trim();
    return sha.length ? sha : null;
  };
  const summarizeSessionBestEffort = (sessionId) => {
    Promise.resolve().then(async () => {
      const session = sessionService.get(sessionId);
      if (!session) return;
      const transcript = session.tracked ? sessionService.readTranscriptTail(session.transcriptPath, 22e4) : "";
      const summary = summarizeTerminalSession({
        title: session.title,
        goal: session.goal,
        toolType: session.toolType,
        exitCode: session.exitCode,
        transcript
      });
      sessionService.setSummary(sessionId, summary);
      if (!aiIntegrationService || aiIntegrationService.getMode() === "guest") return;
      const lane = laneService.getLaneBaseAndBranch(session.laneId);
      const prompt = [
        "You are ADE's terminal summary assistant.",
        "Rewrite this terminal session into a concise 1-3 sentence summary with outcome and next action.",
        "Do not invent commands or outcomes.",
        "",
        "Deterministic summary:",
        summary,
        "",
        "Terminal transcript tail:",
        transcript.slice(-18e3)
      ].join("\n");
      const aiSummary = await aiIntegrationService.summarizeTerminal({
        cwd: lane.worktreePath,
        prompt
      });
      const text = aiSummary.text.trim();
      if (text.length) {
        sessionService.setSummary(sessionId, text);
      }
    }).catch(() => {
    });
  };
  const closeEntry = (ptyId, exitCode) => {
    const entry = ptys.get(ptyId);
    if (!entry) return;
    if (entry.disposed) return;
    entry.disposed = true;
    clearToolAutoCloseTimer(ptyId);
    try {
      entry.transcriptStream?.end();
    } catch {
    }
    flushPreview(entry);
    const endedAt = (/* @__PURE__ */ new Date()).toISOString();
    const status = statusFromExit(exitCode);
    sessionService.end({ sessionId: entry.sessionId, endedAt, exitCode, status });
    clearIdleTimer(entry.sessionId);
    const finalRuntimeState = runtimeFromStatus(status);
    setRuntimeState(entry.sessionId, finalRuntimeState, { touch: false });
    runtimeStates.delete(entry.sessionId);
    try {
      onSessionRuntimeSignal?.({
        laneId: entry.laneId,
        sessionId: entry.sessionId,
        runtimeState: finalRuntimeState,
        lastOutputPreview: entry.latestPreviewLine ?? entry.lastPreviewWritten ?? null,
        at: endedAt
      });
    } catch {
    }
    summarizeSessionBestEffort(entry.sessionId);
    Promise.resolve().then(async () => {
      const { worktreePath } = laneService.getLaneBaseAndBranch(entry.laneId);
      const sha = await computeHeadShaBestEffort(worktreePath);
      if (sha) sessionService.setHeadShaEnd(entry.sessionId, sha);
    }).catch(() => {
    }).finally(() => {
      if (!entry.tracked) return;
      try {
        onSessionEnded?.({ laneId: entry.laneId, sessionId: entry.sessionId, exitCode });
      } catch {
      }
    });
    broadcastExit({ ptyId, sessionId: entry.sessionId, exitCode });
    ptys.delete(ptyId);
  };
  const writeTranscript = (entry, data) => {
    if (!entry.tracked || !entry.transcriptStream) return;
    if (entry.transcriptLimitReached) return;
    try {
      const chunk = Buffer.from(data, "utf8");
      const remaining = MAX_TRANSCRIPT_BYTES - entry.transcriptBytesWritten;
      if (remaining <= 0) {
        entry.transcriptLimitReached = true;
        entry.transcriptStream.write(TRANSCRIPT_LIMIT_NOTICE);
        return;
      }
      if (chunk.length > remaining) {
        entry.transcriptStream.write(chunk.subarray(0, remaining));
        entry.transcriptBytesWritten += remaining;
        entry.transcriptLimitReached = true;
        entry.transcriptStream.write(TRANSCRIPT_LIMIT_NOTICE);
        return;
      }
      entry.transcriptStream.write(chunk);
      entry.transcriptBytesWritten += chunk.length;
    } catch {
    }
  };
  const flushPreview = (entry) => {
    const candidate = (entry.latestPreviewLine ?? "").trim();
    if (!candidate) return;
    if (candidate === entry.lastPreviewWritten) return;
    entry.lastPreviewWritten = candidate;
    sessionService.setLastOutputPreview(entry.sessionId, candidate);
  };
  const updatePreviewThrottled = (entry, chunk) => {
    const next = derivePreviewFromChunk({
      previousLine: entry.previewCurrentLine,
      previousPreview: entry.latestPreviewLine,
      chunk,
      maxChars: 220
    });
    entry.previewCurrentLine = next.nextLine;
    entry.latestPreviewLine = next.preview;
    const now = Date.now();
    if (now - entry.lastPreviewWriteAt < 900) return;
    entry.lastPreviewWriteAt = now;
    flushPreview(entry);
  };
  const emitRuntimeSignalThrottled = (entry, runtimeState) => {
    if (!entry.tracked || !onSessionRuntimeSignal) return;
    const now = Date.now();
    const preview = entry.latestPreviewLine ?? entry.lastPreviewWritten ?? null;
    const stateChanged = runtimeState !== entry.lastRuntimeSignalState;
    const previewChanged = preview !== entry.lastRuntimeSignalPreview;
    const periodicHeartbeatDue = now - entry.lastRuntimeSignalAt >= 1e4;
    const previewEmitDue = previewChanged && now - entry.lastRuntimeSignalAt >= 1200;
    if (!stateChanged && !previewEmitDue && !periodicHeartbeatDue) return;
    entry.lastRuntimeSignalAt = now;
    entry.lastRuntimeSignalState = runtimeState;
    entry.lastRuntimeSignalPreview = preview;
    try {
      onSessionRuntimeSignal({
        laneId: entry.laneId,
        sessionId: entry.sessionId,
        runtimeState,
        lastOutputPreview: preview,
        at: new Date(now).toISOString()
      });
    } catch {
    }
  };
  return {
    async create(args) {
      const { laneId, title } = args;
      const { worktreePath } = laneService.getLaneBaseAndBranch(laneId);
      const cwd = import_node_fs11.default.existsSync(worktreePath) ? worktreePath : projectRoot;
      if (cwd !== worktreePath) {
        logger.warn("pty.cwd_missing_fallback", { laneId, missingCwd: worktreePath, fallbackCwd: cwd });
      }
      const { cols, rows } = clampDims(args.cols, args.rows);
      const ptyId = (0, import_node_crypto8.randomUUID)();
      const sessionId = (0, import_node_crypto8.randomUUID)();
      const startedAt = (/* @__PURE__ */ new Date()).toISOString();
      const tracked = args.tracked !== false;
      const toolTypeHint = normalizeToolType(args.toolType);
      const startupCommand = typeof args.startupCommand === "string" ? args.startupCommand.trim() : "";
      const initialResumeCommand = defaultResumeCommandForTool(toolTypeHint);
      const transcriptPath = safeTranscriptPathFor(sessionId);
      let transcriptStream = null;
      let transcriptBytesWritten = 0;
      if (tracked) {
        import_node_fs11.default.mkdirSync(import_node_path11.default.dirname(transcriptPath), { recursive: true });
        try {
          transcriptBytesWritten = import_node_fs11.default.existsSync(transcriptPath) ? import_node_fs11.default.statSync(transcriptPath).size : 0;
        } catch {
          transcriptBytesWritten = 0;
        }
        transcriptStream = import_node_fs11.default.createWriteStream(transcriptPath, { flags: "a" });
      }
      sessionService.create({
        sessionId,
        laneId,
        ptyId,
        tracked,
        title,
        startedAt,
        transcriptPath: tracked ? transcriptPath : "",
        toolType: toolTypeHint,
        resumeCommand: initialResumeCommand
      });
      setRuntimeState(sessionId, "running");
      Promise.resolve().then(async () => {
        const sha = await computeHeadShaBestEffort(worktreePath);
        if (sha) sessionService.setHeadShaStart(sessionId, sha);
      }).catch(() => {
      });
      const shellCandidates = resolveShellCandidates();
      let pty;
      let selectedShell = null;
      try {
        const ptyLib = loadPty();
        const opts = {
          name: "xterm-256color",
          cols,
          rows,
          cwd,
          env: { ...process.env }
        };
        let lastErr = null;
        let created = null;
        for (const shell of shellCandidates) {
          try {
            created = ptyLib.spawn(shell.file, shell.args, opts);
            selectedShell = shell;
            break;
          } catch (err) {
            lastErr = err;
            logger.warn("pty.spawn_retry", { ptyId, sessionId, shell: shell.file, err: String(err) });
          }
        }
        if (!created) {
          throw lastErr ?? new Error("Unable to spawn terminal shell.");
        }
        pty = created;
      } catch (err) {
        logger.error("pty.spawn_failed", { ptyId, sessionId, err: String(err) });
        try {
          transcriptStream?.end();
        } catch {
        }
        sessionService.end({ sessionId, endedAt: (/* @__PURE__ */ new Date()).toISOString(), exitCode: null, status: "failed" });
        clearIdleTimer(sessionId);
        setRuntimeState(sessionId, "exited", { touch: false });
        runtimeStates.delete(sessionId);
        summarizeSessionBestEffort(sessionId);
        broadcastExit({ ptyId, sessionId, exitCode: null });
        throw err;
      }
      const entry = {
        pty,
        laneId,
        sessionId,
        tracked,
        transcriptPath,
        transcriptStream,
        transcriptBytesWritten,
        transcriptLimitReached: transcriptBytesWritten >= MAX_TRANSCRIPT_BYTES,
        lastPreviewWriteAt: 0,
        previewCurrentLine: "",
        latestPreviewLine: null,
        lastPreviewWritten: null,
        toolTypeHint,
        resumeCommand: initialResumeCommand,
        resumeCommandIsFallback: Boolean(initialResumeCommand),
        resumeScanBuffer: "",
        lastRuntimeSignalAt: 0,
        lastRuntimeSignalState: "running",
        lastRuntimeSignalPreview: null,
        disposed: false,
        createdAt: Date.now()
      };
      ptys.set(ptyId, entry);
      let titleOutputBuffer = "";
      let titleBufferFull = false;
      pty.onData((data) => {
        writeTranscript(entry, data);
        updatePreviewThrottled(entry, data);
        broadcastData({ ptyId, sessionId, data });
        const prevState = runtimeStates.get(sessionId)?.state ?? "running";
        const runtimeState = runtimeStateFromOsc133Chunk(data, prevState);
        setRuntimeState(sessionId, runtimeState);
        if (runtimeState === "running") {
          scheduleIdleTransition(sessionId);
          clearToolAutoCloseTimer(ptyId);
        } else {
          clearIdleTimer(sessionId);
        }
        emitRuntimeSignalThrottled(entry, runtimeState);
        if (runtimeState === "waiting-input" && (prevState === "running" || prevState === "idle") && entry.toolTypeHint && TOOL_TYPES_WITH_AUTO_CLOSE.has(entry.toolTypeHint) && !toolAutoCloseTimers.has(ptyId) && Date.now() - entry.createdAt > 5e3) {
          toolAutoCloseTimers.set(
            ptyId,
            setTimeout(() => {
              toolAutoCloseTimers.delete(ptyId);
              if (entry.disposed) return;
              logger.info("pty.tool_exit_auto_close", { ptyId, sessionId, toolType: entry.toolTypeHint });
              try {
                entry.pty.kill();
              } catch {
                closeEntry(ptyId, 0);
              }
            }, 1500)
          );
        }
        if (!entry.resumeCommand || entry.resumeCommandIsFallback) {
          entry.resumeScanBuffer = `${entry.resumeScanBuffer}${data}`.slice(-12e3);
          const detected = extractResumeCommandFromOutput(entry.resumeScanBuffer, entry.toolTypeHint);
          if (detected && detected !== entry.resumeCommand) {
            entry.resumeCommand = detected;
            entry.resumeCommandIsFallback = false;
            sessionService.setResumeCommand(sessionId, detected);
          }
        }
        if (!titleBufferFull) {
          titleOutputBuffer += data;
          if (titleOutputBuffer.length >= 500) {
            titleBufferFull = true;
          }
        }
      });
      pty.onExit(({ exitCode }) => {
        logger.info("pty.exit", { ptyId, sessionId, exitCode });
        closeEntry(ptyId, exitCode ?? null);
      });
      if (startupCommand) {
        try {
          pty.write(`${startupCommand}\r`);
          setRuntimeState(sessionId, "running");
          scheduleIdleTransition(sessionId);
        } catch (err) {
          logger.warn("pty.startup_command_failed", { ptyId, sessionId, err: String(err) });
        }
      }
      if (aiIntegrationService && aiIntegrationService.getMode() === "subscription") {
        const capturedAi = aiIntegrationService;
        setTimeout(() => {
          if (entry.disposed) return;
          const strippedOutput = stripAnsi(titleOutputBuffer).trim();
          if (strippedOutput.length < 10) return;
          const session = sessionService.get(sessionId);
          if (!session) return;
          const toolType = session.toolType;
          if (!toolType || toolType === "shell") return;
          const lane = laneService.getLaneBaseAndBranch(laneId);
          const prompt = [
            "Generate a concise terminal session title.",
            "Return only plain text, max 80 characters, no punctuation at the end.",
            "",
            "Initial output:",
            strippedOutput.slice(0, 500)
          ].join("\n");
          capturedAi.summarizeTerminal({
            cwd: lane.worktreePath,
            prompt,
            timeoutMs: 8e3
          }).then((result) => {
            const title2 = result.text.trim().replace(/\s+/g, " ").slice(0, 80);
            if (title2) {
              sessionService.updateMeta({ sessionId, goal: title2 });
            }
          }).catch((err) => {
            logger.warn("pty.session_title_generation_failed", {
              sessionId,
              error: err instanceof Error ? err.message : String(err)
            });
          });
        }, 4e3);
      }
      logger.info("pty.create", { ptyId, sessionId, laneId, cwd, shell: selectedShell?.file ?? "unknown" });
      return { ptyId, sessionId };
    },
    write({ ptyId, data }) {
      const entry = ptys.get(ptyId);
      if (!entry) return;
      try {
        entry.pty.write(data);
        setRuntimeState(entry.sessionId, "running");
        scheduleIdleTransition(entry.sessionId);
      } catch (err) {
        logger.warn("pty.write_failed", { ptyId, err: String(err) });
      }
    },
    resize({ ptyId, cols, rows }) {
      const entry = ptys.get(ptyId);
      if (!entry) return;
      const safe = clampDims(cols, rows);
      try {
        entry.pty.resize(safe.cols, safe.rows);
      } catch (err) {
        logger.warn("pty.resize_failed", { ptyId, err: String(err) });
      }
    },
    getRuntimeState(sessionId, fallbackStatus) {
      const runtime = runtimeStates.get(sessionId);
      if (runtime) return runtime.state;
      return runtimeFromStatus(fallbackStatus);
    },
    enrichSessions(rows) {
      return rows.map((row) => ({
        ...row,
        runtimeState: this.getRuntimeState(row.id, row.status)
      }));
    },
    dispose({ ptyId, sessionId }) {
      const entry = ptys.get(ptyId);
      if (!entry) {
        if (!sessionId) return;
        const session = sessionService.get(sessionId);
        if (!session) return;
        const endedAt2 = (/* @__PURE__ */ new Date()).toISOString();
        sessionService.end({ sessionId, endedAt: endedAt2, exitCode: null, status: "disposed" });
        clearIdleTimer(sessionId);
        setRuntimeState(sessionId, "killed", { touch: false });
        runtimeStates.delete(sessionId);
        try {
          onSessionRuntimeSignal?.({
            laneId: session.laneId,
            sessionId,
            runtimeState: "killed",
            lastOutputPreview: session.lastOutputPreview ?? null,
            at: endedAt2
          });
        } catch {
        }
        summarizeSessionBestEffort(sessionId);
        broadcastExit({ ptyId, sessionId, exitCode: null });
        if (session.tracked) {
          try {
            onSessionEnded?.({ laneId: session.laneId, sessionId, exitCode: null });
          } catch {
          }
        }
        logger.warn("pty.dispose_orphaned", { ptyId, sessionId });
        return;
      }
      if (entry.disposed) return;
      entry.disposed = true;
      clearToolAutoCloseTimer(ptyId);
      try {
        entry.transcriptStream?.end();
      } catch {
      }
      try {
        entry.pty.kill();
      } catch {
      }
      const endedAt = (/* @__PURE__ */ new Date()).toISOString();
      sessionService.end({ sessionId: entry.sessionId, endedAt, exitCode: null, status: "disposed" });
      clearIdleTimer(entry.sessionId);
      setRuntimeState(entry.sessionId, "killed", { touch: false });
      runtimeStates.delete(entry.sessionId);
      try {
        onSessionRuntimeSignal?.({
          laneId: entry.laneId,
          sessionId: entry.sessionId,
          runtimeState: "killed",
          lastOutputPreview: entry.latestPreviewLine ?? entry.lastPreviewWritten ?? null,
          at: endedAt
        });
      } catch {
      }
      summarizeSessionBestEffort(entry.sessionId);
      broadcastExit({ ptyId, sessionId: entry.sessionId, exitCode: null });
      ptys.delete(ptyId);
      if (!entry.tracked) {
        return;
      }
      try {
        onSessionEnded?.({ laneId: entry.laneId, sessionId: entry.sessionId, exitCode: null });
      } catch {
      }
    },
    disposeAll() {
      for (const ptyId of [...ptys.keys()]) {
        try {
          this.dispose({ ptyId });
        } catch {
        }
      }
    }
  };
}

// ../desktop/src/main/services/tests/testService.ts
var import_node_fs12 = __toESM(require("fs"), 1);
var import_node_path12 = __toESM(require("path"), 1);
var import_node_crypto9 = require("crypto");
var import_node_child_process3 = require("child_process");

// ../desktop/src/main/services/config/laneOverlayMatcher.ts
function escapeRegExp2(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}
function globToRegExp(pattern) {
  const normalized = pattern.trim();
  if (!normalized.length) return /^$/;
  const parts = normalized.split("*").map((chunk) => escapeRegExp2(chunk));
  return new RegExp(`^${parts.join(".*")}$`, "i");
}
function normalizeSet(values) {
  return new Set((values ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean));
}
function intersectOrAdopt(current, next) {
  if (!next || next.length === 0) return current;
  if (!current || current.length === 0) return [...next];
  const allowed = new Set(next);
  return current.filter((entry) => allowed.has(entry));
}
function matchesPolicy(lane, policy) {
  if (!policy.enabled) return false;
  const match = policy.match ?? {};
  if (match.laneIds && match.laneIds.length > 0 && !match.laneIds.includes(lane.id)) {
    return false;
  }
  if (match.laneTypes && match.laneTypes.length > 0 && !match.laneTypes.includes(lane.laneType)) {
    return false;
  }
  if (match.namePattern) {
    const pattern = globToRegExp(match.namePattern);
    if (!pattern.test(lane.name)) return false;
  }
  if (match.branchPattern) {
    const pattern = globToRegExp(match.branchPattern);
    if (!pattern.test(lane.branchRef)) return false;
  }
  if (match.tags && match.tags.length > 0) {
    const laneTags = normalizeSet(lane.tags);
    const required = normalizeSet(match.tags);
    let matched = false;
    for (const tag of required) {
      if (laneTags.has(tag)) {
        matched = true;
        break;
      }
    }
    if (!matched) return false;
  }
  return true;
}
function matchLaneOverlayPolicies(lane, policies) {
  const merged = {};
  for (const policy of policies) {
    if (!matchesPolicy(lane, policy)) continue;
    const overrides = policy.overrides ?? {};
    if (overrides.env) {
      merged.env = {
        ...merged.env ?? {},
        ...overrides.env
      };
    }
    if (typeof overrides.cwd === "string" && overrides.cwd.trim().length > 0) {
      merged.cwd = overrides.cwd.trim();
    }
    merged.processIds = intersectOrAdopt(merged.processIds, overrides.processIds);
    merged.testSuiteIds = intersectOrAdopt(merged.testSuiteIds, overrides.testSuiteIds);
  }
  if (merged.processIds && merged.processIds.length === 0) {
    delete merged.processIds;
  }
  if (merged.testSuiteIds && merged.testSuiteIds.length === 0) {
    delete merged.testSuiteIds;
  }
  return merged;
}

// ../desktop/src/main/services/tests/testService.ts
var MAX_TEST_LOG_BYTES = 10 * 1024 * 1024;
var TEST_LOG_LIMIT_NOTICE = "\n[ADE] test log limit reached (10MB). Further output omitted.\n";
function clampMaxBytes(maxBytes, fallback) {
  if (typeof maxBytes !== "number" || !Number.isFinite(maxBytes)) return fallback;
  return Math.max(1024, Math.min(2e6, Math.floor(maxBytes)));
}
function readTail(filePath, maxBytes) {
  try {
    const stat = import_node_fs12.default.statSync(filePath);
    const size = stat.size;
    const start = Math.max(0, size - maxBytes);
    const fd = import_node_fs12.default.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(size - start);
      import_node_fs12.default.readSync(fd, buf, 0, buf.length, start);
      return buf.toString("utf8");
    } finally {
      import_node_fs12.default.closeSync(fd);
    }
  } catch {
    return "";
  }
}
function createTestService({
  db,
  projectId,
  testLogsDir,
  logger,
  laneService,
  projectConfigService,
  broadcastEvent
}) {
  const activeRuns = /* @__PURE__ */ new Map();
  const nowIso3 = () => (/* @__PURE__ */ new Date()).toISOString();
  const writeRunLogChunk = (entry, chunk) => {
    if (entry.logLimitReached) return;
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    const remaining = MAX_TEST_LOG_BYTES - entry.logBytesWritten;
    if (remaining <= 0) {
      entry.logLimitReached = true;
      try {
        entry.logStream.write(TEST_LOG_LIMIT_NOTICE);
      } catch {
      }
      return;
    }
    if (data.length > remaining) {
      try {
        entry.logStream.write(data.subarray(0, remaining));
        entry.logBytesWritten += remaining;
        entry.logLimitReached = true;
        entry.logStream.write(TEST_LOG_LIMIT_NOTICE);
      } catch {
      }
      return;
    }
    try {
      entry.logStream.write(data);
      entry.logBytesWritten += data.length;
    } catch {
    }
  };
  const persistRunStart = (runId, laneId, suiteId, startedAt, logPath) => {
    db.run(
      `
        insert into test_runs(id, project_id, lane_id, suite_key, started_at, ended_at, status, exit_code, duration_ms, summary_json, log_path)
        values (?, ?, ?, ?, ?, null, 'running', null, null, null, ?)
      `,
      [runId, projectId, laneId, suiteId, startedAt, logPath]
    );
  };
  const persistRunEnd = ({
    runId,
    status,
    exitCode,
    endedAt,
    durationMs
  }) => {
    db.run("update test_runs set ended_at = ?, status = ?, exit_code = ?, duration_ms = ? where id = ?", [
      endedAt,
      status,
      exitCode,
      durationMs,
      runId
    ]);
  };
  const getSuiteMap = (config) => new Map(config.testSuites.map((s) => [s.id, s]));
  const getLaneSummary = async (laneId) => {
    const lanes = await laneService.list({ includeArchived: false });
    const lane = lanes.find((entry) => entry.id === laneId);
    if (!lane) throw new Error(`Lane not found: ${laneId}`);
    return lane;
  };
  const getLaneOverlay = async (laneId, config) => {
    const lane = await getLaneSummary(laneId);
    return matchLaneOverlayPolicies(lane, config.laneOverlayPolicies);
  };
  const applySuiteFilter = (suiteIds, overlay) => {
    const allowed = overlay.testSuiteIds;
    if (!allowed || allowed.length === 0) return suiteIds;
    const allowedSet = new Set(allowed);
    return suiteIds.filter((id) => allowedSet.has(id));
  };
  const emitRun = (run) => broadcastEvent({ type: "run", run });
  const emitLog = (runId, suiteId, stream, chunk) => broadcastEvent({ type: "log", runId, suiteId, stream, chunk, ts: nowIso3() });
  const buildRunSummary = (row, suiteNameMap) => ({
    id: row.id,
    suiteId: row.suiteId,
    suiteName: suiteNameMap.get(row.suiteId) ?? row.suiteId,
    laneId: row.laneId,
    status: row.status,
    exitCode: row.exitCode,
    durationMs: row.durationMs,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    logPath: row.logPath
  });
  const getRunById = (runId, suiteNameMap) => {
    const row = db.get(
      `
        select
          id as id,
          suite_key as suiteId,
          lane_id as laneId,
          status as status,
          exit_code as exitCode,
          duration_ms as durationMs,
          started_at as startedAt,
          ended_at as endedAt,
          log_path as logPath
        from test_runs
        where id = ?
        limit 1
      `,
      [runId]
    );
    if (!row) return null;
    return buildRunSummary(row, suiteNameMap);
  };
  const finishRun = (entry, exitCode) => {
    if (entry.timeoutTimer) {
      clearTimeout(entry.timeoutTimer);
      entry.timeoutTimer = null;
    }
    if (entry.killTimer) {
      clearTimeout(entry.killTimer);
      entry.killTimer = null;
    }
    const endedAt = nowIso3();
    const durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(entry.startedAt));
    let status;
    if (entry.stopIntent === "timed_out") status = "timed_out";
    else if (entry.stopIntent === "canceled") status = "canceled";
    else status = exitCode === 0 ? "passed" : "failed";
    writeRunLogChunk(entry, `
# test run ended at ${endedAt} status=${status} exit=${exitCode ?? "null"}
`);
    try {
      entry.logStream.end();
    } catch {
    }
    persistRunEnd({ runId: entry.runId, status, exitCode, endedAt, durationMs });
    const summary = getRunById(entry.runId, /* @__PURE__ */ new Map([[entry.suiteId, entry.suiteName]]));
    if (summary) emitRun(summary);
    activeRuns.delete(entry.runId);
    logger.info("tests.run.finished", {
      runId: entry.runId,
      laneId: entry.laneId,
      suiteId: entry.suiteId,
      status,
      exitCode,
      durationMs
    });
  };
  const spawnSuite = (laneId, suite, overlay) => {
    const runId = (0, import_node_crypto9.randomUUID)();
    const startedAt = nowIso3();
    const laneRoot = laneService.getLaneWorktreePath(laneId);
    const configuredCwd = overlay.cwd?.trim() ? overlay.cwd : suite.cwd;
    const cwd = import_node_path12.default.isAbsolute(configuredCwd) ? configuredCwd : import_node_path12.default.join(laneRoot, configuredCwd);
    if (!suite.command.length) throw new Error(`Suite '${suite.id}' has an empty command`);
    const suiteDir = import_node_path12.default.join(testLogsDir, laneId, suite.id);
    import_node_fs12.default.mkdirSync(suiteDir, { recursive: true });
    const logPath = import_node_path12.default.join(suiteDir, `${runId}.log`);
    const logStream = import_node_fs12.default.createWriteStream(logPath, { flags: "a" });
    const initialLogBytes = (() => {
      try {
        return import_node_fs12.default.existsSync(logPath) ? import_node_fs12.default.statSync(logPath).size : 0;
      } catch {
        return 0;
      }
    })();
    const child = (0, import_node_child_process3.spawn)(suite.command[0], suite.command.slice(1), {
      cwd,
      env: { ...process.env, ...suite.env, ...overlay.env ?? {} },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const entry = {
      laneId,
      runId,
      suiteId: suite.id,
      suiteName: suite.name,
      child,
      startedAt,
      logPath,
      logStream,
      logBytesWritten: initialLogBytes,
      logLimitReached: initialLogBytes >= MAX_TEST_LOG_BYTES,
      timeoutTimer: null,
      killTimer: null,
      stopIntent: null
    };
    writeRunLogChunk(entry, `
# test run start ${startedAt} cmd=${JSON.stringify(suite.command)} cwd=${cwd}
`);
    activeRuns.set(runId, entry);
    persistRunStart(runId, laneId, suite.id, startedAt, logPath);
    const summary = {
      id: runId,
      suiteId: suite.id,
      suiteName: suite.name,
      laneId,
      status: "running",
      exitCode: null,
      durationMs: null,
      startedAt,
      endedAt: null,
      logPath
    };
    emitRun(summary);
    const onChunk = (stream, chunk) => {
      writeRunLogChunk(entry, chunk);
      emitLog(runId, suite.id, stream, chunk);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => onChunk("stdout", chunk));
    child.stderr.on("data", (chunk) => onChunk("stderr", chunk));
    child.on("error", (err) => {
      writeRunLogChunk(entry, `
[test run error] ${String(err)}
`);
    });
    child.on("close", (code) => finishRun(entry, code ?? null));
    if (suite.timeoutMs && suite.timeoutMs > 0) {
      entry.timeoutTimer = setTimeout(() => {
        entry.stopIntent = "timed_out";
        try {
          child.kill("SIGTERM");
        } catch {
        }
        entry.killTimer = setTimeout(() => {
          if (activeRuns.has(runId)) {
            try {
              child.kill("SIGKILL");
            } catch {
            }
          }
        }, 3e3);
      }, suite.timeoutMs);
    }
    logger.info("tests.run.started", { runId, laneId, suiteId: suite.id, cwd, command: suite.command });
    return summary;
  };
  return {
    listSuites() {
      return projectConfigService.get().effective.testSuites;
    },
    async run(arg) {
      const config = projectConfigService.getExecutableConfig();
      const overlay = await getLaneOverlay(arg.laneId, config);
      const suiteMap = getSuiteMap(config);
      const availableSuiteIds = applySuiteFilter(Array.from(suiteMap.keys()), overlay);
      if (!availableSuiteIds.includes(arg.suiteId)) {
        throw new Error(`Test suite '${arg.suiteId}' is disabled by lane overlay policy for this lane`);
      }
      const suite = suiteMap.get(arg.suiteId);
      if (!suite) throw new Error(`Test suite not found: ${arg.suiteId}`);
      const existing = Array.from(activeRuns.values()).find((entry) => entry.laneId === arg.laneId && entry.suiteId === suite.id);
      if (existing) {
        const summary = getRunById(existing.runId, /* @__PURE__ */ new Map([[suite.id, suite.name]]));
        if (summary) return summary;
      }
      return spawnSuite(arg.laneId, suite, overlay);
    },
    stop(arg) {
      const entry = activeRuns.get(arg.runId);
      if (!entry) return;
      if (entry.timeoutTimer) {
        clearTimeout(entry.timeoutTimer);
        entry.timeoutTimer = null;
      }
      if (entry.killTimer) {
        clearTimeout(entry.killTimer);
        entry.killTimer = null;
      }
      entry.stopIntent = "canceled";
      try {
        entry.child.kill("SIGTERM");
      } catch {
      }
      entry.killTimer = setTimeout(() => {
        if (!activeRuns.has(arg.runId)) return;
        try {
          entry.child.kill("SIGKILL");
        } catch {
        }
      }, 3e3);
    },
    listRuns(arg = {}) {
      const config = projectConfigService.get();
      const suiteNameMap = new Map(config.effective.testSuites.map((suite) => [suite.id, suite.name]));
      const where = ["project_id = ?"];
      const params = [projectId];
      if (arg.laneId) {
        where.push("lane_id = ?");
        params.push(arg.laneId);
      }
      if (arg.suiteId) {
        where.push("suite_key = ?");
        params.push(arg.suiteId);
      }
      const limit = typeof arg.limit === "number" ? Math.max(1, Math.min(500, arg.limit)) : 120;
      params.push(limit);
      const rows = db.all(
        `
          select
            id as id,
            suite_key as suiteId,
            lane_id as laneId,
            status as status,
            exit_code as exitCode,
            duration_ms as durationMs,
            started_at as startedAt,
            ended_at as endedAt,
            log_path as logPath
          from test_runs
          where ${where.join(" and ")}
          order by started_at desc
          limit ?
        `,
        params
      );
      return rows.map((row) => buildRunSummary(row, suiteNameMap));
    },
    getLogTail({ runId, maxBytes }) {
      const limit = clampMaxBytes(maxBytes, 22e4);
      const active = activeRuns.get(runId);
      if (active) return readTail(active.logPath, limit);
      const row = db.get("select log_path from test_runs where id = ? limit 1", [runId]);
      if (!row?.log_path) return "";
      return readTail(row.log_path, limit);
    },
    disposeAll() {
      for (const entry of activeRuns.values()) {
        if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer);
        if (entry.killTimer) clearTimeout(entry.killTimer);
        try {
          entry.child.kill("SIGKILL");
        } catch {
        }
        try {
          entry.logStream.end();
        } catch {
        }
      }
      activeRuns.clear();
    }
  };
}

// src/bootstrap.ts
function ensureAdePaths(projectRoot) {
  const adeDir = import_node_path13.default.join(projectRoot, ".ade");
  const logsDir = import_node_path13.default.join(adeDir, "logs");
  const processLogsDir = import_node_path13.default.join(logsDir, "processes");
  const testLogsDir = import_node_path13.default.join(logsDir, "tests");
  const transcriptsDir = import_node_path13.default.join(adeDir, "transcripts");
  const worktreesDir = import_node_path13.default.join(adeDir, "worktrees");
  const packsDir = import_node_path13.default.join(adeDir, "packs");
  const dbPath = import_node_path13.default.join(adeDir, "ade.db");
  import_node_fs13.default.mkdirSync(processLogsDir, { recursive: true });
  import_node_fs13.default.mkdirSync(testLogsDir, { recursive: true });
  import_node_fs13.default.mkdirSync(transcriptsDir, { recursive: true });
  import_node_fs13.default.mkdirSync(worktreesDir, { recursive: true });
  import_node_fs13.default.mkdirSync(packsDir, { recursive: true });
  return {
    adeDir,
    logsDir,
    processLogsDir,
    testLogsDir,
    transcriptsDir,
    worktreesDir,
    packsDir,
    dbPath
  };
}
async function createAdeMcpRuntime(projectRootInput) {
  const projectRoot = import_node_path13.default.resolve(projectRootInput);
  if (!import_node_fs13.default.existsSync(projectRoot) || !import_node_fs13.default.statSync(projectRoot).isDirectory()) {
    throw new Error(`Project root does not exist: ${projectRoot}`);
  }
  const baseRef = await detectDefaultBaseRef(projectRoot);
  const paths = ensureAdePaths(projectRoot);
  const logger = createFileLogger(import_node_path13.default.join(paths.logsDir, "mcp-server.jsonl"));
  const db = await openKvDb(paths.dbPath, logger);
  const project = toProjectInfo(projectRoot, baseRef);
  const { projectId } = upsertProjectRow({
    db,
    repoRoot: projectRoot,
    displayName: project.displayName,
    baseRef
  });
  const operationService = createOperationService({ db, projectId });
  const laneService = createLaneService({
    db,
    projectRoot,
    projectId,
    defaultBaseRef: baseRef,
    worktreesDir: paths.worktreesDir,
    operationService
  });
  await laneService.ensurePrimaryLane();
  const sessionService = createSessionService({ db });
  sessionService.reconcileStaleRunningSessions({ status: "disposed" });
  const projectConfigService = createProjectConfigService({
    projectRoot,
    adeDir: paths.adeDir,
    projectId,
    db,
    logger
  });
  const packService = createPackService({
    db,
    logger,
    projectRoot,
    projectId,
    packsDir: paths.packsDir,
    laneService,
    sessionService,
    projectConfigService,
    operationService,
    onEvent: () => {
    }
  });
  const conflictService = createConflictService({
    db,
    logger,
    projectId,
    projectRoot,
    laneService,
    projectConfigService,
    packService,
    operationService,
    conflictPacksDir: import_node_path13.default.join(paths.packsDir, "conflicts"),
    onEvent: () => {
    }
  });
  const gitService = createGitOperationsService({
    laneService,
    operationService,
    logger
  });
  const diffService = createDiffService({ laneService });
  const missionService = createMissionService({
    db,
    projectId,
    onEvent: () => {
    }
  });
  const ptyService = createPtyService({
    projectRoot,
    transcriptsDir: paths.transcriptsDir,
    laneService,
    sessionService,
    logger,
    broadcastData: () => {
    },
    broadcastExit: () => {
    },
    onSessionEnded: () => {
    },
    loadPty: () => nodePty
  });
  const testService = createTestService({
    db,
    projectId,
    testLogsDir: paths.testLogsDir,
    logger,
    laneService,
    projectConfigService,
    broadcastEvent: () => {
    }
  });
  return {
    projectRoot,
    projectId,
    project,
    paths,
    logger,
    db,
    laneService,
    sessionService,
    operationService,
    projectConfigService,
    packService,
    conflictService,
    gitService,
    diffService,
    missionService,
    ptyService,
    testService,
    dispose: () => {
      try {
        testService.disposeAll();
      } catch {
      }
      try {
        ptyService.disposeAll();
      } catch {
      }
      try {
        db.flushNow();
      } catch {
      }
      try {
        db.close();
      } catch {
      }
    }
  };
}

// src/jsonrpc.ts
var import_node_buffer = require("buffer");
var JsonRpcErrorCode = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  policyDenied: -32010,
  toolFailed: -32011
};
var JsonRpcError = class extends Error {
  code;
  data;
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
};
function writeMessage(message, mode) {
  const payload = JSON.stringify(message);
  if (mode === "jsonl") {
    process.stdout.write(`${payload}
`);
    return;
  }
  const framed = `Content-Length: ${import_node_buffer.Buffer.byteLength(payload, "utf8")}\r
\r
${payload}`;
  process.stdout.write(framed);
}
function toErrorResponse(id, error) {
  if (error instanceof JsonRpcError) {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: error.code,
        message: error.message,
        ...error.data !== void 0 ? { data: error.data } : {}
      }
    };
  }
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: JsonRpcErrorCode.internalError,
      message: error instanceof Error ? error.message : String(error)
    }
  };
}
function isValidRequest(payload) {
  return Boolean(payload) && typeof payload === "object" && !Array.isArray(payload);
}
async function handleSingleMessage(message, handler) {
  if (!isValidRequest(message)) {
    return {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: JsonRpcErrorCode.invalidRequest,
        message: "Invalid JSON-RPC request payload"
      }
    };
  }
  const request = message;
  const id = request.id ?? null;
  if (!request.method || typeof request.method !== "string") {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: JsonRpcErrorCode.invalidRequest,
        message: "JSON-RPC request is missing a string method"
      }
    };
  }
  if (request.jsonrpc != null && request.jsonrpc !== "2.0") {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: JsonRpcErrorCode.invalidRequest,
        message: "Unsupported JSON-RPC version"
      }
    };
  }
  if (request.id === void 0) {
    await handler(request);
    return null;
  }
  try {
    const result = await handler(request);
    return {
      jsonrpc: "2.0",
      id,
      result: result ?? {}
    };
  } catch (error) {
    return toErrorResponse(id, error);
  }
}
function isWhitespaceByte(byte) {
  return byte === 32 || byte === 9 || byte === 13 || byte === 10;
}
function findHeaderBoundary(buffer, start) {
  const crlf = buffer.indexOf("\r\n\r\n", start, "utf8");
  const lf = buffer.indexOf("\n\n", start, "utf8");
  if (crlf === -1 && lf === -1) return null;
  if (crlf === -1) {
    return { index: lf, delimiterLength: 2 };
  }
  if (lf === -1) {
    return { index: crlf, delimiterLength: 4 };
  }
  if (crlf < lf) {
    return { index: crlf, delimiterLength: 4 };
  }
  return { index: lf, delimiterLength: 2 };
}
function parseContentLength(headerBlock) {
  const lines = headerBlock.split(/\r?\n/);
  for (const line of lines) {
    const match = /^content-length\s*:\s*(\d+)\s*$/i.exec(line.trim());
    if (match) {
      return Number.parseInt(match[1], 10);
    }
  }
  return null;
}
function takeNextPayload(buffer) {
  if (!buffer.length) return null;
  let offset = 0;
  while (offset < buffer.length && isWhitespaceByte(buffer[offset])) {
    offset += 1;
  }
  if (offset >= buffer.length) {
    return null;
  }
  const first = buffer[offset];
  if (first === 123 || first === 91) {
    const newline = buffer.indexOf(10, offset);
    if (newline === -1) return null;
    const payloadText2 = buffer.slice(offset, newline).toString("utf8").trim();
    return {
      kind: "payload",
      payloadText: payloadText2,
      transport: "jsonl",
      rest: buffer.slice(newline + 1)
    };
  }
  const boundary = findHeaderBoundary(buffer, offset);
  if (!boundary) return null;
  const headerBlock = buffer.slice(offset, boundary.index).toString("utf8");
  const contentLength = parseContentLength(headerBlock);
  const bodyStart = boundary.index + boundary.delimiterLength;
  if (contentLength == null) {
    return {
      kind: "frame_error",
      transport: "framed",
      response: {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: JsonRpcErrorCode.parseError,
          message: "Missing Content-Length header"
        }
      },
      rest: buffer.slice(bodyStart)
    };
  }
  if (buffer.length < bodyStart + contentLength) {
    return null;
  }
  const payloadText = buffer.slice(bodyStart, bodyStart + contentLength).toString("utf8");
  return {
    kind: "payload",
    payloadText,
    transport: "framed",
    rest: buffer.slice(bodyStart + contentLength)
  };
}
async function dispatchPayload(args) {
  const { payloadText, handler, transport } = args;
  const trimmed = payloadText.trim();
  if (!trimmed.length) return;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    writeMessage({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: JsonRpcErrorCode.parseError,
        message: "Failed to parse JSON input",
        data: error instanceof Error ? error.message : String(error)
      }
    }, transport);
    return;
  }
  if (Array.isArray(parsed)) {
    if (!parsed.length) {
      writeMessage({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: JsonRpcErrorCode.invalidRequest,
          message: "JSON-RPC batch requests cannot be empty"
        }
      }, transport);
      return;
    }
    if (parsed.length > MAX_BATCH_SIZE) {
      writeMessage({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: JsonRpcErrorCode.invalidRequest,
          message: `JSON-RPC batch size ${parsed.length} exceeds maximum of ${MAX_BATCH_SIZE}`
        }
      }, transport);
      return;
    }
    const results = (await Promise.all(parsed.map((entry) => handleSingleMessage(entry, handler)))).filter((entry) => entry != null);
    if (results.length) {
      writeMessage(results, transport);
    }
    return;
  }
  const response = await handleSingleMessage(parsed, handler);
  if (response) {
    writeMessage(response, transport);
  }
}
var MAX_BUFFER_BYTES = 64 * 1024 * 1024;
var MAX_BATCH_SIZE = 100;
function startJsonRpcServer(handler) {
  let buffer = import_node_buffer.Buffer.alloc(0);
  let stopped = false;
  let draining = false;
  let responseTransport = null;
  const drain = async () => {
    if (draining || stopped) return;
    draining = true;
    try {
      while (!stopped) {
        const parsed = takeNextPayload(buffer);
        if (!parsed) break;
        buffer = parsed.rest;
        if (responseTransport == null) {
          responseTransport = parsed.transport;
        }
        if (parsed.kind === "frame_error") {
          writeMessage(parsed.response, responseTransport ?? "framed");
          continue;
        }
        await dispatchPayload({
          payloadText: parsed.payloadText,
          handler,
          transport: responseTransport ?? "framed"
        });
      }
    } finally {
      draining = false;
      if (!stopped && buffer.length) {
        void drain();
      }
    }
  };
  const onData = (chunk) => {
    if (stopped) return;
    const part = typeof chunk === "string" ? import_node_buffer.Buffer.from(chunk, "utf8") : import_node_buffer.Buffer.from(chunk);
    buffer = buffer.length ? import_node_buffer.Buffer.concat([buffer, part]) : part;
    if (buffer.length > MAX_BUFFER_BYTES) {
      writeMessage({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: JsonRpcErrorCode.parseError,
          message: `Input buffer exceeded maximum size of ${MAX_BUFFER_BYTES} bytes`
        }
      }, responseTransport ?? "framed");
      stopped = true;
      process.stdin.off("data", onData);
      process.nextTick(() => process.exit(1));
      return;
    }
    void drain();
  };
  process.stdin.on("data", onData);
  process.stdin.resume();
  return () => {
    stopped = true;
    process.stdin.off("data", onData);
  };
}

// src/mcpServer.ts
var import_node_crypto10 = require("crypto");
var import_node_fs14 = __toESM(require("fs"), 1);
var import_node_path14 = __toESM(require("path"), 1);
var DEFAULT_PROTOCOL_VERSION = "2025-06-18";
var DEFAULT_PTY_COLS = 120;
var DEFAULT_PTY_ROWS = 36;
var RESOURCE_MIME_MARKDOWN = "text/markdown";
var RESOURCE_MIME_JSON = "application/json";
var TOOL_SPECS = [
  {
    name: "spawn_agent",
    description: "Spawn a Codex or Claude CLI session in a lane-scoped tracked terminal.",
    inputSchema: {
      type: "object",
      required: ["laneId"],
      additionalProperties: false,
      properties: {
        laneId: { type: "string", minLength: 1 },
        provider: { type: "string", enum: ["codex", "claude"], default: "codex" },
        prompt: { type: "string" },
        model: { type: "string" },
        title: { type: "string" },
        runId: { type: "string" },
        stepId: { type: "string" },
        attemptId: { type: "string" },
        permissionMode: { type: "string", enum: ["plan", "edit", "full-auto"], default: "edit" },
        toolWhitelist: { type: "array", items: { type: "string" }, maxItems: 24 },
        maxPromptChars: { type: "number", minimum: 256, maximum: 12e3 },
        contextFilePath: { type: "string" },
        context: {
          type: "object",
          additionalProperties: false,
          properties: {
            profile: { type: "string" },
            packs: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  scope: { type: "string" },
                  packKey: { type: "string" },
                  level: { type: "string" },
                  approxTokens: { type: "number" },
                  summary: { type: "string" }
                }
              }
            },
            docs: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  path: { type: "string" },
                  sha256: { type: "string" },
                  bytes: { type: "number" }
                }
              }
            },
            handoffDigest: {
              type: "object",
              additionalProperties: false,
              properties: {
                summarizedCount: { type: "number" },
                byType: { type: "object" },
                oldestCreatedAt: { type: "string" },
                newestCreatedAt: { type: "string" }
              }
            }
          }
        }
      }
    }
  },
  {
    name: "read_context",
    description: "Read project/lane/feature/conflict/plan/mission context packs for orchestration.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        scope: {
          type: "string",
          enum: ["project", "lane", "feature", "conflict", "plan", "mission"],
          default: "project"
        },
        laneId: { type: "string" },
        featureKey: { type: "string" },
        peerLaneId: { type: "string" },
        missionId: { type: "string" },
        level: { type: "string", enum: ["lite", "standard", "deep"], default: "standard" }
      }
    }
  },
  {
    name: "create_lane",
    description: "Create a new lane/worktree for task execution.",
    inputSchema: {
      type: "object",
      required: ["name"],
      additionalProperties: false,
      properties: {
        name: { type: "string", minLength: 1 },
        description: { type: "string" },
        parentLaneId: { type: "string" }
      }
    }
  },
  {
    name: "check_conflicts",
    description: "Run conflict prediction against one lane or a lane set.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        laneId: { type: "string" },
        laneIds: { type: "array", items: { type: "string" } },
        force: { type: "boolean", default: false }
      }
    }
  },
  {
    name: "merge_lane",
    description: "Merge a source lane into its parent lane with conflict-aware status reporting.",
    inputSchema: {
      type: "object",
      required: ["laneId"],
      additionalProperties: false,
      properties: {
        laneId: { type: "string", minLength: 1 },
        message: { type: "string" },
        deleteSourceLane: { type: "boolean", default: false }
      }
    }
  },
  {
    name: "ask_user",
    description: "Create a mission intervention and optionally wait for user resolution.",
    inputSchema: {
      type: "object",
      required: ["missionId", "title", "body"],
      additionalProperties: false,
      properties: {
        missionId: { type: "string", minLength: 1 },
        title: { type: "string", minLength: 1 },
        body: { type: "string", minLength: 1 },
        requestedAction: { type: "string" },
        laneId: { type: "string" },
        waitForResolutionMs: { type: "number", minimum: 0, maximum: 36e5 },
        pollIntervalMs: { type: "number", minimum: 100, maximum: 1e4 }
      }
    }
  },
  {
    name: "run_tests",
    description: "Run a configured test suite or ad-hoc command in a lane and return execution results.",
    inputSchema: {
      type: "object",
      required: ["laneId"],
      additionalProperties: false,
      properties: {
        laneId: { type: "string", minLength: 1 },
        suiteId: { type: "string" },
        command: { type: "string" },
        timeoutMs: { type: "number", minimum: 500, maximum: 18e5 },
        waitForCompletion: { type: "boolean", default: true },
        maxLogBytes: { type: "number", minimum: 1024, maximum: 2e6 }
      }
    }
  },
  {
    name: "get_lane_status",
    description: "Return lane status, diff stats, and conflict/rebase state.",
    inputSchema: {
      type: "object",
      required: ["laneId"],
      additionalProperties: false,
      properties: {
        laneId: { type: "string", minLength: 1 }
      }
    }
  },
  {
    name: "list_lanes",
    description: "List active lanes with metadata and branch status.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        includeArchived: { type: "boolean", default: false }
      }
    }
  },
  {
    name: "commit_changes",
    description: "Stage and commit lane changes with a provided message.",
    inputSchema: {
      type: "object",
      required: ["laneId", "message"],
      additionalProperties: false,
      properties: {
        laneId: { type: "string", minLength: 1 },
        message: { type: "string", minLength: 1 },
        amend: { type: "boolean", default: false },
        stageAll: { type: "boolean", default: true }
      }
    }
  },
  {
    name: "simulate_integration",
    description: "Dry-merge N lanes sequentially using git merge-tree, returning per-step conflict analysis without creating any branches or PRs",
    inputSchema: {
      type: "object",
      required: ["sourceLaneIds", "baseBranch"],
      additionalProperties: false,
      properties: {
        sourceLaneIds: { type: "array", items: { type: "string", minLength: 1 } },
        baseBranch: { type: "string", minLength: 1 }
      }
    }
  },
  {
    name: "create_queue",
    description: "Create a queue PR group with ordered lanes, each targeting the same branch for sequential landing",
    inputSchema: {
      type: "object",
      required: ["laneIds", "targetBranch"],
      additionalProperties: false,
      properties: {
        laneIds: { type: "array", items: { type: "string", minLength: 1 } },
        targetBranch: { type: "string", minLength: 1 },
        titles: { type: "object", additionalProperties: { type: "string" } },
        draft: { type: "boolean" },
        autoRebase: { type: "boolean" },
        ciGating: { type: "boolean" },
        queueName: { type: "string" }
      }
    }
  },
  {
    name: "create_integration",
    description: "Create an integration lane, merge source lanes into it, and create a single integration PR",
    inputSchema: {
      type: "object",
      required: ["sourceLaneIds", "integrationLaneName", "baseBranch", "title"],
      additionalProperties: false,
      properties: {
        sourceLaneIds: { type: "array", items: { type: "string", minLength: 1 } },
        integrationLaneName: { type: "string", minLength: 1 },
        baseBranch: { type: "string", minLength: 1 },
        title: { type: "string", minLength: 1 },
        body: { type: "string" },
        draft: { type: "boolean" }
      }
    }
  },
  {
    name: "rebase_lane",
    description: "Rebase a lane onto its base branch, optionally using AI to resolve conflicts",
    inputSchema: {
      type: "object",
      required: ["laneId"],
      additionalProperties: false,
      properties: {
        laneId: { type: "string", minLength: 1 },
        aiAssisted: { type: "boolean" },
        provider: { type: "string" },
        autoApplyThreshold: { type: "number", minimum: 0, maximum: 1 }
      }
    }
  },
  {
    name: "get_pr_health",
    description: "Get unified health status for a PR including checks, reviews, conflicts, and rebase status",
    inputSchema: {
      type: "object",
      required: ["prId"],
      additionalProperties: false,
      properties: {
        prId: { type: "string", minLength: 1 }
      }
    }
  },
  {
    name: "land_queue_next",
    description: "Land the next pending PR in a queue group sequentially",
    inputSchema: {
      type: "object",
      required: ["groupId", "method"],
      additionalProperties: false,
      properties: {
        groupId: { type: "string", minLength: 1 },
        method: { type: "string", minLength: 1 },
        autoResolve: { type: "boolean" },
        confidenceThreshold: { type: "number", minimum: 0, maximum: 1 }
      }
    }
  }
];
var READ_ONLY_TOOLS = /* @__PURE__ */ new Set([
  "read_context",
  "check_conflicts",
  "get_lane_status",
  "list_lanes",
  "simulate_integration",
  "get_pr_health"
]);
var MUTATION_TOOLS = /* @__PURE__ */ new Set([
  "create_lane",
  "merge_lane",
  "commit_changes",
  "run_tests",
  "create_queue",
  "create_integration",
  "rebase_lane",
  "land_queue_next"
]);
function nowIso2() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function isRecord4(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function safeObject(value) {
  return isRecord4(value) ? value : {};
}
function asTrimmedString(value) {
  return typeof value === "string" ? value.trim() : "";
}
function asOptionalTrimmedString(value) {
  const text = asTrimmedString(value);
  return text.length ? text : null;
}
function asBoolean(value, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}
function asNumber2(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function assertNonEmptyString(value, field) {
  const text = asTrimmedString(value);
  if (!text.length) {
    throw new JsonRpcError(JsonRpcErrorCode.invalidParams, `${field} is required`);
  }
  return text;
}
function normalizeExportLevel(value, fallback = "standard") {
  if (value === "lite" || value === "standard" || value === "deep") return value;
  return fallback;
}
function jsonText(value) {
  return JSON.stringify(value, null, 2);
}
function mcpTextResult(value, isError = false) {
  const text = typeof value === "string" ? value : jsonText(value);
  return {
    content: [{ type: "text", text }],
    structuredContent: value,
    ...isError ? { isError: true } : {}
  };
}
function sanitizeForAudit(value, depth = 0) {
  if (depth > 4) return "[depth-clipped]";
  if (value == null) return value;
  if (typeof value === "string") {
    return value.length > 500 ? `${value.slice(0, 500)}\u2026` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 40).map((entry) => sanitizeForAudit(entry, depth + 1));
  }
  if (isRecord4(value)) {
    const out = {};
    let count = 0;
    for (const [key, entry] of Object.entries(value)) {
      out[key] = sanitizeForAudit(entry, depth + 1);
      count += 1;
      if (count >= 40) {
        out.__truncated__ = true;
        break;
      }
    }
    return out;
  }
  return String(value);
}
function requirePrService(runtime) {
  if (!runtime.prService) {
    throw new JsonRpcError(JsonRpcErrorCode.internalError, "prService is not available in this MCP runtime configuration");
  }
  return runtime.prService;
}
function extractLaneId(args) {
  const fromPrimary = asOptionalTrimmedString(args.laneId);
  if (fromPrimary) return fromPrimary;
  const fromParent = asOptionalTrimmedString(args.parentLaneId);
  if (fromParent) return fromParent;
  return null;
}
function stripInjectionChars(value) {
  return value.replace(/[\n\r\0]/g, " ");
}
function shellEscapeArg(value) {
  const sanitized = stripInjectionChars(value);
  if (!sanitized.length) return "''";
  if (/^[a-zA-Z0-9_./:-]+$/.test(sanitized)) return sanitized;
  return `'${sanitized.replace(/'/g, `'"'"'`)}'`;
}
function clipText(value, maxChars) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 18))}
...<truncated>`;
}
function sha256Text(value) {
  return (0, import_node_crypto10.createHash)("sha256").update(value).digest("hex");
}
function parseSpawnPermissionMode(value) {
  const normalized = asTrimmedString(value).toLowerCase();
  if (normalized === "plan" || normalized === "full-auto") return normalized;
  return "edit";
}
function normalizeToolWhitelist(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => asTrimmedString(entry)).filter(Boolean))].slice(0, 24);
}
function resolveSpawnContextFile(args) {
  const contextFilePathRaw = args.contextFilePathRaw?.trim() ?? "";
  const packList = Array.isArray(args.context.packs) ? args.context.packs : [];
  const docsList = Array.isArray(args.context.docs) ? args.context.docs : [];
  const hasContextPayload = packList.length > 0 || docsList.length > 0 || Object.keys(args.context).length > 0;
  const approxTokens = packList.reduce((sum, item) => {
    const record = safeObject(item);
    const raw = Number(record.approxTokens ?? 0);
    return sum + (Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0);
  }, 0);
  if (!contextFilePathRaw && !hasContextPayload) {
    return { contextFilePath: null, contextDigest: null, contextBytes: null, approxTokens };
  }
  if (contextFilePathRaw.length) {
    if (import_node_path14.default.isAbsolute(contextFilePathRaw)) {
      throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "contextFilePath must be a relative path within the project directory");
    }
    const abs = import_node_path14.default.resolve(args.runtime.projectRoot, contextFilePathRaw);
    if (!abs.startsWith(args.runtime.projectRoot + import_node_path14.default.sep) && abs !== args.runtime.projectRoot) {
      throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "contextFilePath must be within the project directory");
    }
    if (!import_node_fs14.default.existsSync(abs)) {
      throw new JsonRpcError(JsonRpcErrorCode.invalidParams, `contextFilePath does not exist: ${contextFilePathRaw}`);
    }
    const text = import_node_fs14.default.readFileSync(abs, "utf8");
    return {
      contextFilePath: abs,
      contextDigest: sha256Text(text),
      contextBytes: Buffer.byteLength(text, "utf8"),
      approxTokens
    };
  }
  const baseDir = import_node_path14.default.join(args.runtime.projectRoot, ".ade", "orchestrator", "mcp-context");
  const runSegment = args.runId ?? "standalone";
  const dir = import_node_path14.default.join(baseDir, runSegment);
  import_node_fs14.default.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${(0, import_node_crypto10.randomUUID)()}.json`;
  const contextFilePath = import_node_path14.default.join(dir, filename);
  const payload = {
    schema: "ade.mcp.spawnAgentContext.v1",
    generatedAt: nowIso2(),
    mission: {
      runId: args.runId,
      stepId: args.stepId,
      attemptId: args.attemptId
    },
    worker: {
      laneId: args.laneId,
      provider: args.provider,
      permissionMode: args.permissionMode
    },
    promptPreview: args.userPrompt ? clipText(args.userPrompt, 2e3) : null,
    context: {
      profile: asOptionalTrimmedString(args.context.profile),
      packs: packList.slice(0, 24).map((item) => {
        const record = safeObject(item);
        return {
          scope: asOptionalTrimmedString(record.scope),
          packKey: asOptionalTrimmedString(record.packKey),
          level: asOptionalTrimmedString(record.level),
          approxTokens: Number.isFinite(Number(record.approxTokens)) ? Number(record.approxTokens) : null,
          summary: clipText(asTrimmedString(record.summary), 800)
        };
      }),
      docs: docsList.slice(0, 40).map((item) => {
        const record = safeObject(item);
        return {
          path: asOptionalTrimmedString(record.path),
          sha256: asOptionalTrimmedString(record.sha256),
          bytes: Number.isFinite(Number(record.bytes)) ? Number(record.bytes) : null
        };
      }),
      handoffDigest: safeObject(args.context.handoffDigest)
    }
  };
  const serialized = `${JSON.stringify(payload, null, 2)}
`;
  import_node_fs14.default.writeFileSync(contextFilePath, serialized, "utf8");
  return {
    contextFilePath,
    contextDigest: sha256Text(serialized),
    contextBytes: Buffer.byteLength(serialized, "utf8"),
    approxTokens
  };
}
function mapLaneSummary(lane) {
  return {
    id: lane.id,
    name: lane.name,
    laneType: lane.laneType,
    parentLaneId: lane.parentLaneId,
    baseRef: lane.baseRef,
    branchRef: lane.branchRef,
    worktreePath: lane.worktreePath,
    archivedAt: lane.archivedAt,
    stackDepth: lane.stackDepth,
    status: lane.status
  };
}
function parseInitializeIdentity(params) {
  const data = safeObject(params);
  const identity = safeObject(data.identity);
  const role = asTrimmedString(identity.role);
  return {
    callerId: asOptionalTrimmedString(identity.callerId) ?? "unknown",
    role: role === "orchestrator" || role === "agent" ? role : "external",
    runId: asOptionalTrimmedString(identity.runId),
    attemptId: asOptionalTrimmedString(identity.attemptId),
    ownerId: asOptionalTrimmedString(identity.ownerId),
    allowMutations: asBoolean(identity.allowMutations, false),
    allowSpawnAgent: asBoolean(identity.allowSpawnAgent, false)
  };
}
function parseMcpUri(uriRaw) {
  const trimmed = uriRaw.trim();
  if (!trimmed.startsWith("ade://")) {
    throw new JsonRpcError(JsonRpcErrorCode.invalidParams, `Unsupported resource URI: ${uriRaw}`);
  }
  const body = trimmed.slice("ade://".length);
  const pathParts = body.split("/").map((part) => decodeURIComponent(part));
  return { path: pathParts.filter((part) => part.length > 0) };
}
function resourceListFromLanes(lanes) {
  const resources = [
    {
      uri: "ade://pack/project/lite",
      name: "Project Pack (Lite)",
      description: "Project context export (lite)",
      mimeType: RESOURCE_MIME_MARKDOWN
    },
    {
      uri: "ade://pack/project/standard",
      name: "Project Pack (Standard)",
      description: "Project context export (standard)",
      mimeType: RESOURCE_MIME_MARKDOWN
    },
    {
      uri: "ade://pack/project/deep",
      name: "Project Pack (Deep)",
      description: "Project context export (deep)",
      mimeType: RESOURCE_MIME_MARKDOWN
    }
  ];
  for (const lane of lanes) {
    const laneId = asTrimmedString(lane.id);
    const laneName = asTrimmedString(lane.name) || laneId;
    if (!laneId) continue;
    for (const level of ["lite", "standard", "deep"]) {
      resources.push({
        uri: `ade://pack/lane/${encodeURIComponent(laneId)}/${level}`,
        name: `${laneName} Pack (${level})`,
        description: `Lane context export for '${laneName}' (${level})`,
        mimeType: RESOURCE_MIME_MARKDOWN
      });
    }
    resources.push({
      uri: `ade://lane/${encodeURIComponent(laneId)}/status`,
      name: `${laneName} Status`,
      description: `Lane status snapshot for '${laneName}'`,
      mimeType: RESOURCE_MIME_JSON
    });
    resources.push({
      uri: `ade://lane/${encodeURIComponent(laneId)}/conflicts`,
      name: `${laneName} Conflict Summary`,
      description: `Conflict overlap summary for '${laneName}'`,
      mimeType: RESOURCE_MIME_JSON
    });
  }
  return resources;
}
function appendPackResource(resources, args) {
  resources.push({
    uri: args.uri,
    name: args.name,
    description: args.description,
    mimeType: RESOURCE_MIME_MARKDOWN
  });
}
function listFeatureKeysFromLanes(lanes) {
  const keys = /* @__PURE__ */ new Set();
  for (const lane of lanes) {
    const rawTags = Array.isArray(lane.tags) ? lane.tags : [];
    for (const tag of rawTags) {
      const key = asTrimmedString(tag);
      if (key.length) keys.add(key);
    }
  }
  return [...keys].sort((a, b) => a.localeCompare(b));
}
function listMissionIds(runtime) {
  const rows = runtime.db.all(
    `
      select id
      from missions
      where project_id = ?
      order by updated_at desc
      limit 120
    `,
    [runtime.projectId]
  );
  return rows.map((row) => asTrimmedString(row.id)).filter((entry) => entry.length > 0);
}
function buildResourceList(args) {
  const resources = resourceListFromLanes(args.lanes);
  for (const lane of args.lanes) {
    const laneId = asTrimmedString(lane.id);
    const laneName = asTrimmedString(lane.name) || laneId;
    if (!laneId) continue;
    for (const level of ["lite", "standard", "deep"]) {
      appendPackResource(resources, {
        uri: `ade://pack/plan/${encodeURIComponent(laneId)}/${level}`,
        name: `${laneName} Plan Pack (${level})`,
        description: `Plan pack export for lane '${laneName}' (${level})`
      });
      appendPackResource(resources, {
        uri: `ade://pack/conflict/${encodeURIComponent(laneId)}/base/${level}`,
        name: `${laneName} Conflict Pack (${level})`,
        description: `Conflict pack export anchored to lane '${laneName}' (${level})`
      });
    }
  }
  for (const featureKey of args.featureKeys) {
    for (const level of ["lite", "standard", "deep"]) {
      appendPackResource(resources, {
        uri: `ade://pack/feature/${encodeURIComponent(featureKey)}/${level}`,
        name: `Feature Pack: ${featureKey} (${level})`,
        description: `Feature pack export for '${featureKey}' (${level})`
      });
    }
  }
  for (const missionId of args.missionIds) {
    for (const level of ["lite", "standard", "deep"]) {
      appendPackResource(resources, {
        uri: `ade://pack/mission/${encodeURIComponent(missionId)}/${level}`,
        name: `Mission Pack: ${missionId} (${level})`,
        description: `Mission pack export for mission '${missionId}' (${level})`
      });
    }
  }
  return resources;
}
function findToolSpec(name) {
  const match = TOOL_SPECS.find((entry) => entry.name === name);
  if (!match) {
    throw new JsonRpcError(JsonRpcErrorCode.methodNotFound, `Unknown MCP tool: ${name}`);
  }
  return match;
}
async function waitForTestRunCompletion(args) {
  const { runtime, runId, laneId, timeoutMs } = args;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const rows2 = runtime.testService.listRuns({ laneId, limit: 500 });
    const run2 = rows2.find((entry) => entry.id === runId);
    if (run2 && run2.status !== "running") {
      return {
        run: run2,
        logTail: runtime.testService.getLogTail({ runId, maxBytes: 22e4 })
      };
    }
    await sleep(500);
  }
  runtime.testService.stop({ runId });
  const rows = runtime.testService.listRuns({ laneId, limit: 500 });
  const run = rows.find((entry) => entry.id === runId) ?? null;
  return {
    run,
    timedOut: true,
    logTail: runtime.testService.getLogTail({ runId, maxBytes: 22e4 })
  };
}
async function waitForSessionCompletion(args) {
  const { runtime, ptyId, sessionId, timeoutMs, maxLogBytes } = args;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const session2 = runtime.sessionService.get(sessionId);
    if (session2 && session2.status !== "running") {
      const logTail = runtime.sessionService.readTranscriptTail(session2.transcriptPath, maxLogBytes, {
        raw: true,
        alignToLineBoundary: true
      });
      return {
        session: session2,
        logTail
      };
    }
    await sleep(400);
  }
  runtime.ptyService.dispose({ ptyId, sessionId });
  const session = runtime.sessionService.get(sessionId);
  return {
    session,
    timedOut: true,
    logTail: session ? runtime.sessionService.readTranscriptTail(session.transcriptPath, maxLogBytes, {
      raw: true,
      alignToLineBoundary: true
    }) : ""
  };
}
async function buildLaneStatus(runtime, laneId) {
  const lanes = await runtime.laneService.list({ includeArchived: true });
  const lane = lanes.find((entry) => entry.id === laneId);
  if (!lane) {
    throw new JsonRpcError(JsonRpcErrorCode.invalidParams, `Lane not found: ${laneId}`);
  }
  const changes = await runtime.diffService.getChanges(laneId);
  const conflict = await runtime.conflictService.getLaneStatus({ laneId });
  const gitConflictState = await runtime.gitService.getConflictState({ laneId });
  return {
    lane: mapLaneSummary(lane),
    diff: {
      unstagedCount: changes.unstaged.length,
      stagedCount: changes.staged.length,
      hasChanges: changes.unstaged.length > 0 || changes.staged.length > 0
    },
    conflict,
    gitConflictState,
    rebaseStatus: gitConflictState.kind === "rebase" ? "in_progress" : "idle"
  };
}
function ensureMutationAuthorized(args) {
  if (args.session.identity.allowMutations) return;
  const now = nowIso2();
  const baseWhere = [
    "project_id = ?",
    "state = 'active'",
    "expires_at > ?"
  ];
  const baseParams = [args.runtime.projectId, now];
  if (args.session.identity.runId) {
    baseWhere.push("run_id = ?");
    baseParams.push(args.session.identity.runId);
  }
  if (args.session.identity.ownerId) {
    baseWhere.push("owner_id = ?");
    baseParams.push(args.session.identity.ownerId);
  }
  const checkClaim = (scopeKind, scopeValues) => {
    if (!scopeValues.length) return false;
    const placeholders = scopeValues.map(() => "?").join(", ");
    const row = args.runtime.db.get(
      `
        select count(*) as count
        from orchestrator_claims
        where ${baseWhere.join(" and ")}
          and scope_kind = ?
          and scope_value in (${placeholders})
      `,
      [...baseParams, scopeKind, ...scopeValues]
    );
    return Number(row?.count ?? 0) > 0;
  };
  if (args.laneId) {
    if (checkClaim("lane", [args.laneId, "*"])) {
      return;
    }
  }
  if (checkClaim("env", ["mcp:mutate", "lane:create", args.toolName, "*"])) {
    return;
  }
  throw new JsonRpcError(JsonRpcErrorCode.policyDenied, `Policy denied mutation tool '${args.toolName}'. Active claim required.`);
}
function ensureSpawnAuthorized(session) {
  if (session.identity.allowSpawnAgent) return;
  if (session.identity.role === "orchestrator") return;
  throw new JsonRpcError(
    JsonRpcErrorCode.policyDenied,
    "Policy denied spawn_agent. Only orchestrator sessions may spawn agents."
  );
}
var GLOBAL_ASK_USER_RATE_LIMIT = {
  maxCalls: 20,
  windowMs: 6e4,
  events: []
};
function ensureAskUserAllowed(session) {
  const now = Date.now();
  const globalCutoff = now - GLOBAL_ASK_USER_RATE_LIMIT.windowMs;
  GLOBAL_ASK_USER_RATE_LIMIT.events = GLOBAL_ASK_USER_RATE_LIMIT.events.filter((ts) => ts >= globalCutoff);
  if (GLOBAL_ASK_USER_RATE_LIMIT.events.length >= GLOBAL_ASK_USER_RATE_LIMIT.maxCalls) {
    throw new JsonRpcError(JsonRpcErrorCode.policyDenied, "ask_user global rate limit exceeded.");
  }
  const sessionCutoff = now - session.askUserRateLimit.windowMs;
  session.askUserEvents = session.askUserEvents.filter((ts) => ts >= sessionCutoff);
  if (session.askUserEvents.length >= session.askUserRateLimit.maxCalls) {
    throw new JsonRpcError(JsonRpcErrorCode.policyDenied, "ask_user rate limit exceeded.");
  }
  session.askUserEvents.push(now);
  GLOBAL_ASK_USER_RATE_LIMIT.events.push(now);
}
async function runTool(args) {
  const { runtime, session, name, toolArgs } = args;
  if (name === "list_lanes") {
    const includeArchived = asBoolean(toolArgs.includeArchived, false);
    const lanes = await runtime.laneService.list({ includeArchived });
    return {
      lanes: lanes.map((lane) => mapLaneSummary(lane))
    };
  }
  if (name === "get_lane_status") {
    const laneId = assertNonEmptyString(toolArgs.laneId, "laneId");
    return await buildLaneStatus(runtime, laneId);
  }
  if (name === "create_lane") {
    ensureMutationAuthorized({ runtime, session, toolName: name, laneId: asOptionalTrimmedString(toolArgs.parentLaneId) });
    const nameArg = assertNonEmptyString(toolArgs.name, "name");
    const description = asOptionalTrimmedString(toolArgs.description);
    const parentLaneId = asOptionalTrimmedString(toolArgs.parentLaneId);
    const lane = await runtime.laneService.create({
      name: nameArg,
      ...description ? { description } : {},
      ...parentLaneId ? { parentLaneId } : {}
    });
    return {
      lane: mapLaneSummary(lane)
    };
  }
  if (name === "check_conflicts") {
    const laneId = asOptionalTrimmedString(toolArgs.laneId);
    const laneIds = Array.isArray(toolArgs.laneIds) ? toolArgs.laneIds.map((entry) => asTrimmedString(entry)).filter(Boolean) : void 0;
    const assessment = await runtime.conflictService.runPrediction({
      ...laneId ? { laneId } : {},
      ...laneIds && laneIds.length ? { laneIds } : {}
    });
    return {
      assessment
    };
  }
  if (name === "merge_lane") {
    const laneId = assertNonEmptyString(toolArgs.laneId, "laneId");
    ensureMutationAuthorized({ runtime, session, laneId, toolName: name });
    const message = asOptionalTrimmedString(toolArgs.message);
    const deleteSourceLane = asBoolean(toolArgs.deleteSourceLane, false);
    const lanes = await runtime.laneService.list({ includeArchived: false });
    const source = lanes.find((entry) => entry.id === laneId);
    if (!source) {
      throw new JsonRpcError(JsonRpcErrorCode.invalidParams, `Lane not found: ${laneId}`);
    }
    if (!source.parentLaneId) {
      throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "Source lane has no parent lane to merge into.");
    }
    const parentLaneId = source.parentLaneId;
    ensureMutationAuthorized({ runtime, session, laneId: parentLaneId, toolName: name });
    const parent = runtime.laneService.getLaneBaseAndBranch(parentLaneId);
    const preHead = (await runGit(["rev-parse", "HEAD"], { cwd: parent.worktreePath, timeoutMs: 8e3 })).stdout.trim() || null;
    const mergeArgs = ["merge", "--no-ff"];
    if (message) {
      mergeArgs.push("-m", message);
    }
    mergeArgs.push(source.branchRef);
    const mergeResult = await runGit(mergeArgs, {
      cwd: parent.worktreePath,
      timeoutMs: 18e4
    });
    if (mergeResult.exitCode !== 0) {
      const unmerged = await runGit(["diff", "--name-only", "--diff-filter=U"], {
        cwd: parent.worktreePath,
        timeoutMs: 12e3
      });
      const conflictedFiles = unmerged.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      return {
        merged: false,
        status: "conflict",
        laneId,
        parentLaneId,
        conflictedFiles,
        error: mergeResult.stderr.trim() || mergeResult.stdout.trim() || "Merge failed"
      };
    }
    const postHead = (await runGit(["rev-parse", "HEAD"], { cwd: parent.worktreePath, timeoutMs: 8e3 })).stdout.trim() || null;
    if (deleteSourceLane) {
      await runtime.laneService.delete({
        laneId,
        deleteBranch: false,
        force: false
      });
    }
    return {
      merged: true,
      status: "clean",
      laneId,
      parentLaneId,
      preHeadSha: preHead,
      postHeadSha: postHead,
      deleteSourceLane
    };
  }
  if (name === "ask_user") {
    ensureAskUserAllowed(session);
    const missionId = assertNonEmptyString(toolArgs.missionId, "missionId");
    const title = assertNonEmptyString(toolArgs.title, "title");
    const body = assertNonEmptyString(toolArgs.body, "body");
    const requestedAction = asOptionalTrimmedString(toolArgs.requestedAction);
    const laneId = asOptionalTrimmedString(toolArgs.laneId);
    const waitForResolutionMs = Math.max(0, Math.floor(asNumber2(toolArgs.waitForResolutionMs, 0)));
    const pollIntervalMs = Math.max(100, Math.floor(asNumber2(toolArgs.pollIntervalMs, 1e3)));
    const intervention = runtime.missionService.addIntervention({
      missionId,
      interventionType: "manual_input",
      title,
      body,
      ...requestedAction ? { requestedAction } : {},
      ...laneId ? { laneId } : {}
    });
    if (waitForResolutionMs <= 0) {
      return {
        intervention,
        awaitingUserResponse: true
      };
    }
    const deadline = Date.now() + waitForResolutionMs;
    while (Date.now() <= deadline) {
      const mission2 = runtime.missionService.get(missionId);
      const latest2 = mission2?.interventions.find((entry) => entry.id === intervention.id) ?? null;
      if (latest2 && latest2.status !== "open") {
        return {
          intervention: latest2,
          awaitingUserResponse: false
        };
      }
      await sleep(pollIntervalMs);
    }
    const mission = runtime.missionService.get(missionId);
    const latest = mission?.interventions.find((entry) => entry.id === intervention.id) ?? intervention;
    return {
      intervention: latest,
      awaitingUserResponse: true,
      timedOut: true
    };
  }
  if (name === "run_tests") {
    const laneId = assertNonEmptyString(toolArgs.laneId, "laneId");
    ensureMutationAuthorized({ runtime, session, laneId, toolName: name });
    const suiteId = asOptionalTrimmedString(toolArgs.suiteId);
    const command = asOptionalTrimmedString(toolArgs.command);
    const waitForCompletion = asBoolean(toolArgs.waitForCompletion, true);
    const timeoutMs = Math.max(500, Math.floor(asNumber2(toolArgs.timeoutMs, 10 * 6e4)));
    const maxLogBytes = Math.max(1024, Math.floor(asNumber2(toolArgs.maxLogBytes, 22e4)));
    if (!suiteId && !command) {
      throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "run_tests requires either suiteId or command.");
    }
    if (suiteId) {
      const run = await runtime.testService.run({ laneId, suiteId });
      if (!waitForCompletion) {
        return { run };
      }
      const result2 = await waitForTestRunCompletion({ runtime, runId: run.id, laneId, timeoutMs });
      return {
        mode: "suite",
        suiteId,
        ...result2
      };
    }
    const commandText = assertNonEmptyString(command, "command");
    const pty = await runtime.ptyService.create({
      laneId,
      cols: DEFAULT_PTY_COLS,
      rows: DEFAULT_PTY_ROWS,
      title: `MCP Test: ${commandText}`,
      tracked: true,
      toolType: "shell",
      startupCommand: commandText
    });
    if (!waitForCompletion) {
      return {
        mode: "command",
        laneId,
        command: commandText,
        ptyId: pty.ptyId,
        sessionId: pty.sessionId
      };
    }
    const result = await waitForSessionCompletion({
      runtime,
      ptyId: pty.ptyId,
      sessionId: pty.sessionId,
      timeoutMs,
      maxLogBytes
    });
    return {
      mode: "command",
      laneId,
      command: commandText,
      ptyId: pty.ptyId,
      sessionId: pty.sessionId,
      ...result
    };
  }
  if (name === "commit_changes") {
    const laneId = assertNonEmptyString(toolArgs.laneId, "laneId");
    ensureMutationAuthorized({ runtime, session, laneId, toolName: name });
    const message = assertNonEmptyString(toolArgs.message, "message");
    const amend = asBoolean(toolArgs.amend, false);
    const stageAll = asBoolean(toolArgs.stageAll, true);
    if (stageAll) {
      await runtime.gitService.stageAll({ laneId, paths: [] });
    }
    const action = await runtime.gitService.commit({ laneId, message, amend });
    const latest = await runtime.gitService.listRecentCommits({ laneId, limit: 1 });
    return {
      action,
      commit: latest[0] ?? null
    };
  }
  if (name === "simulate_integration") {
    const sourceLaneIds = Array.isArray(toolArgs.sourceLaneIds) ? toolArgs.sourceLaneIds.map((entry) => asTrimmedString(entry)).filter(Boolean) : [];
    if (!sourceLaneIds.length) {
      throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "sourceLaneIds is required and must be non-empty");
    }
    const baseBranch = assertNonEmptyString(toolArgs.baseBranch, "baseBranch");
    const prSvc = requirePrService(runtime);
    const result = await prSvc.simulateIntegration({ sourceLaneIds, baseBranch });
    return result;
  }
  if (name === "create_queue") {
    ensureMutationAuthorized({ runtime, session, toolName: name });
    const laneIds = Array.isArray(toolArgs.laneIds) ? toolArgs.laneIds.map((entry) => asTrimmedString(entry)).filter(Boolean) : [];
    if (!laneIds.length) {
      throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "laneIds is required and must be non-empty");
    }
    const targetBranch = assertNonEmptyString(toolArgs.targetBranch, "targetBranch");
    const titles = isRecord4(toolArgs.titles) ? toolArgs.titles : void 0;
    const draft = typeof toolArgs.draft === "boolean" ? toolArgs.draft : void 0;
    const autoRebase = typeof toolArgs.autoRebase === "boolean" ? toolArgs.autoRebase : void 0;
    const ciGating = typeof toolArgs.ciGating === "boolean" ? toolArgs.ciGating : void 0;
    const queueName = asOptionalTrimmedString(toolArgs.queueName);
    const prSvc = requirePrService(runtime);
    const result = await prSvc.createQueuePrs({
      laneIds,
      targetBranch,
      ...titles ? { titles } : {},
      ...draft !== void 0 ? { draft } : {},
      ...autoRebase !== void 0 ? { autoRebase } : {},
      ...ciGating !== void 0 ? { ciGating } : {},
      ...queueName ? { queueName } : {}
    });
    return result;
  }
  if (name === "create_integration") {
    ensureMutationAuthorized({ runtime, session, toolName: name });
    const sourceLaneIds = Array.isArray(toolArgs.sourceLaneIds) ? toolArgs.sourceLaneIds.map((entry) => asTrimmedString(entry)).filter(Boolean) : [];
    if (!sourceLaneIds.length) {
      throw new JsonRpcError(JsonRpcErrorCode.invalidParams, "sourceLaneIds is required and must be non-empty");
    }
    const integrationLaneName = assertNonEmptyString(toolArgs.integrationLaneName, "integrationLaneName");
    const baseBranch = assertNonEmptyString(toolArgs.baseBranch, "baseBranch");
    const title = assertNonEmptyString(toolArgs.title, "title");
    const body = asOptionalTrimmedString(toolArgs.body);
    const draft = typeof toolArgs.draft === "boolean" ? toolArgs.draft : void 0;
    const prSvc = requirePrService(runtime);
    const result = await prSvc.createIntegrationPr({
      sourceLaneIds,
      integrationLaneName,
      baseBranch,
      title,
      ...body ? { body } : {},
      ...draft !== void 0 ? { draft } : {}
    });
    return result;
  }
  if (name === "rebase_lane") {
    const laneId = assertNonEmptyString(toolArgs.laneId, "laneId");
    ensureMutationAuthorized({ runtime, session, laneId, toolName: name });
    const aiAssisted = typeof toolArgs.aiAssisted === "boolean" ? toolArgs.aiAssisted : void 0;
    const provider = asOptionalTrimmedString(toolArgs.provider);
    const autoApplyThreshold = typeof toolArgs.autoApplyThreshold === "number" ? toolArgs.autoApplyThreshold : void 0;
    const result = await runtime.conflictService.rebaseLane({
      laneId,
      ...aiAssisted !== void 0 ? { aiAssisted } : {},
      ...provider ? { provider } : {},
      ...autoApplyThreshold !== void 0 ? { autoApplyThreshold } : {}
    });
    return result;
  }
  if (name === "get_pr_health") {
    const prId = assertNonEmptyString(toolArgs.prId, "prId");
    const prSvc = requirePrService(runtime);
    const result = await prSvc.getPrHealth(prId);
    return result;
  }
  if (name === "land_queue_next") {
    ensureMutationAuthorized({ runtime, session, toolName: name });
    const groupId = assertNonEmptyString(toolArgs.groupId, "groupId");
    const method = assertNonEmptyString(toolArgs.method, "method");
    const autoResolve = typeof toolArgs.autoResolve === "boolean" ? toolArgs.autoResolve : void 0;
    const confidenceThreshold = typeof toolArgs.confidenceThreshold === "number" ? toolArgs.confidenceThreshold : void 0;
    const prSvc = requirePrService(runtime);
    const result = await prSvc.landQueueNext({
      groupId,
      method,
      ...autoResolve !== void 0 ? { autoResolve } : {},
      ...confidenceThreshold !== void 0 ? { confidenceThreshold } : {}
    });
    return result;
  }
  if (name === "read_context") {
    const scope = asTrimmedString(toolArgs.scope) || "project";
    const level = normalizeExportLevel(toolArgs.level, "standard");
    if (scope === "project") {
      const exportData = await runtime.packService.getProjectExport({ level });
      return { export: exportData };
    }
    if (scope === "lane") {
      const laneId = assertNonEmptyString(toolArgs.laneId, "laneId");
      const exportData = await runtime.packService.getLaneExport({ laneId, level });
      return { export: exportData };
    }
    if (scope === "feature") {
      const featureKey = assertNonEmptyString(toolArgs.featureKey, "featureKey");
      const exportData = await runtime.packService.getFeatureExport({ featureKey, level });
      return { export: exportData };
    }
    if (scope === "conflict") {
      const laneId = assertNonEmptyString(toolArgs.laneId, "laneId");
      const peerLaneId = asOptionalTrimmedString(toolArgs.peerLaneId);
      const exportData = await runtime.packService.getConflictExport({
        laneId,
        ...peerLaneId ? { peerLaneId } : {},
        level
      });
      return { export: exportData };
    }
    if (scope === "plan") {
      const laneId = assertNonEmptyString(toolArgs.laneId, "laneId");
      const exportData = await runtime.packService.getPlanExport({ laneId, level });
      return { export: exportData };
    }
    if (scope === "mission") {
      const missionId = assertNonEmptyString(toolArgs.missionId, "missionId");
      const exportData = await runtime.packService.getMissionExport({ missionId, level });
      return { export: exportData };
    }
    throw new JsonRpcError(JsonRpcErrorCode.invalidParams, `Unsupported read_context scope '${scope}'.`);
  }
  if (name === "spawn_agent") {
    ensureSpawnAuthorized(session);
    const laneId = assertNonEmptyString(toolArgs.laneId, "laneId");
    const provider = asTrimmedString(toolArgs.provider) === "claude" ? "claude" : "codex";
    const model = asOptionalTrimmedString(toolArgs.model);
    const permissionMode = parseSpawnPermissionMode(toolArgs.permissionMode);
    const maxPromptChars = Math.max(256, Math.min(12e3, Math.floor(asNumber2(toolArgs.maxPromptChars, 2800))));
    const prompt = asOptionalTrimmedString(toolArgs.prompt);
    const runId = asOptionalTrimmedString(toolArgs.runId);
    const stepId = asOptionalTrimmedString(toolArgs.stepId);
    const attemptId = asOptionalTrimmedString(toolArgs.attemptId);
    const toolWhitelist = normalizeToolWhitelist(toolArgs.toolWhitelist);
    const title = stripInjectionChars(
      asOptionalTrimmedString(toolArgs.title) ?? `MCP Agent (${provider}${permissionMode === "plan" ? " \xB7 plan" : ""})`
    );
    const context = safeObject(toolArgs.context);
    const contextRef = resolveSpawnContextFile({
      runtime,
      laneId,
      provider,
      permissionMode,
      runId,
      stepId,
      attemptId,
      userPrompt: prompt,
      context,
      contextFilePathRaw: asOptionalTrimmedString(toolArgs.contextFilePath)
    });
    const promptSegments = [];
    if (runId || stepId || attemptId) {
      promptSegments.push(
        `Mission context: run=${runId ?? "n/a"} step=${stepId ?? "n/a"} attempt=${attemptId ?? "n/a"}.`
      );
    }
    if (contextRef.contextFilePath) {
      promptSegments.push(`Read worker context from: ${contextRef.contextFilePath}`);
    }
    if (toolWhitelist.length > 0) {
      promptSegments.push(`Allowed tools: ${toolWhitelist.join(", ")}`);
    }
    if (prompt) {
      promptSegments.push(clipText(prompt, maxPromptChars));
    }
    const finalPrompt = promptSegments.join("\n").trim();
    const commandParts = [provider];
    if (model) {
      commandParts.push("--model", shellEscapeArg(model));
    }
    if (provider === "codex") {
      const codexSandbox = permissionMode === "plan" ? "read-only" : permissionMode === "full-auto" ? "danger-full-access" : "workspace-write";
      commandParts.push("--sandbox", codexSandbox);
      if (permissionMode === "full-auto") {
        commandParts.push("--full-auto");
      }
    } else {
      const claudePermission = permissionMode === "plan" ? "plan" : permissionMode === "full-auto" ? "bypassPermissions" : "acceptEdits";
      commandParts.push("--permission-mode", claudePermission);
    }
    if (finalPrompt) {
      commandParts.push(shellEscapeArg(finalPrompt));
    }
    const startupCommand = commandParts.join(" ");
    const created = await runtime.ptyService.create({
      laneId,
      cols: DEFAULT_PTY_COLS,
      rows: DEFAULT_PTY_ROWS,
      title,
      tracked: true,
      toolType: `${provider}-orchestrated`,
      startupCommand
    });
    return {
      provider,
      laneId,
      title,
      permissionMode,
      startupCommand,
      ptyId: created.ptyId,
      sessionId: created.sessionId,
      contextRef: {
        path: contextRef.contextFilePath,
        digest: contextRef.contextDigest,
        bytes: contextRef.contextBytes,
        approxTokens: contextRef.approxTokens
      }
    };
  }
  throw new JsonRpcError(JsonRpcErrorCode.methodNotFound, `Unknown MCP tool: ${name}`);
}
async function readResource(runtime, uri) {
  const parsed = parseMcpUri(uri);
  const [head, ...tail] = parsed.path;
  if (head === "pack") {
    const [scope, a, b, c] = tail;
    if (scope === "project" && a) {
      const level = normalizeExportLevel(a, "standard");
      const exportData = await runtime.packService.getProjectExport({ level });
      return {
        contents: [
          {
            uri,
            mimeType: RESOURCE_MIME_MARKDOWN,
            text: `\`\`\`json
${jsonText(exportData.header)}
\`\`\`

${exportData.content}`
          }
        ]
      };
    }
    if (scope === "lane" && a && b) {
      const laneId = a;
      const level = normalizeExportLevel(b, "standard");
      const exportData = await runtime.packService.getLaneExport({ laneId, level });
      return {
        contents: [
          {
            uri,
            mimeType: RESOURCE_MIME_MARKDOWN,
            text: `\`\`\`json
${jsonText(exportData.header)}
\`\`\`

${exportData.content}`
          }
        ]
      };
    }
    if (scope === "feature" && a && b) {
      const featureKey = a;
      const level = normalizeExportLevel(b, "standard");
      const exportData = await runtime.packService.getFeatureExport({ featureKey, level });
      return {
        contents: [
          {
            uri,
            mimeType: RESOURCE_MIME_MARKDOWN,
            text: `\`\`\`json
${jsonText(exportData.header)}
\`\`\`

${exportData.content}`
          }
        ]
      };
    }
    if (scope === "plan" && a && b) {
      const laneId = a;
      const level = normalizeExportLevel(b, "standard");
      const exportData = await runtime.packService.getPlanExport({ laneId, level });
      return {
        contents: [
          {
            uri,
            mimeType: RESOURCE_MIME_MARKDOWN,
            text: `\`\`\`json
${jsonText(exportData.header)}
\`\`\`

${exportData.content}`
          }
        ]
      };
    }
    if (scope === "mission" && a && b) {
      const missionId = a;
      const level = normalizeExportLevel(b, "standard");
      const exportData = await runtime.packService.getMissionExport({ missionId, level });
      return {
        contents: [
          {
            uri,
            mimeType: RESOURCE_MIME_MARKDOWN,
            text: `\`\`\`json
${jsonText(exportData.header)}
\`\`\`

${exportData.content}`
          }
        ]
      };
    }
    if (scope === "conflict" && a && b && c) {
      const laneId = a;
      const peerLaneId = b === "base" ? null : b;
      const level = normalizeExportLevel(c, "standard");
      const exportData = await runtime.packService.getConflictExport({
        laneId,
        ...peerLaneId ? { peerLaneId } : {},
        level
      });
      return {
        contents: [
          {
            uri,
            mimeType: RESOURCE_MIME_MARKDOWN,
            text: `\`\`\`json
${jsonText(exportData.header)}
\`\`\`

${exportData.content}`
          }
        ]
      };
    }
  }
  if (head === "lane") {
    const [laneId, scope] = tail;
    if (laneId && scope === "status") {
      const payload = await buildLaneStatus(runtime, laneId);
      return {
        contents: [
          {
            uri,
            mimeType: RESOURCE_MIME_JSON,
            text: jsonText(payload)
          }
        ]
      };
    }
    if (laneId && scope === "conflicts") {
      const status = await runtime.conflictService.getLaneStatus({ laneId });
      const overlaps = await runtime.conflictService.listOverlaps({ laneId });
      return {
        contents: [
          {
            uri,
            mimeType: RESOURCE_MIME_JSON,
            text: jsonText({ status, overlaps })
          }
        ]
      };
    }
  }
  throw new JsonRpcError(JsonRpcErrorCode.invalidParams, `Unsupported resource URI: ${uri}`);
}
function createMcpRequestHandler(args) {
  const { runtime, serverVersion } = args;
  const session = {
    initialized: false,
    protocolVersion: DEFAULT_PROTOCOL_VERSION,
    identity: {
      callerId: "unknown",
      role: "external",
      runId: null,
      attemptId: null,
      ownerId: null,
      allowMutations: false,
      allowSpawnAgent: false
    },
    askUserEvents: [],
    askUserRateLimit: {
      maxCalls: 6,
      windowMs: 6e4
    }
  };
  const auditToolCall = async (toolName, toolArgs, runner) => {
    const startedAt = Date.now();
    const laneId = extractLaneId(toolArgs);
    const operation = runtime.operationService.start({
      laneId,
      kind: "mcp_tool_call",
      metadata: {
        tool: toolName,
        callerId: session.identity.callerId,
        role: session.identity.role,
        runId: session.identity.runId,
        attemptId: session.identity.attemptId,
        ownerId: session.identity.ownerId,
        args: sanitizeForAudit(toolArgs)
      }
    });
    try {
      const result = await runner();
      runtime.operationService.finish({
        operationId: operation.operationId,
        status: "succeeded",
        metadataPatch: {
          resultStatus: "success",
          durationMs: Date.now() - startedAt,
          result: sanitizeForAudit(result)
        }
      });
      return result;
    } catch (error) {
      runtime.operationService.finish({
        operationId: operation.operationId,
        status: "failed",
        metadataPatch: {
          resultStatus: "failed",
          durationMs: Date.now() - startedAt,
          errorMessage: error instanceof Error ? error.message : String(error)
        }
      });
      throw error;
    }
  };
  return async (request) => {
    const method = typeof request.method === "string" ? request.method : "";
    const params = safeObject(request.params);
    if (method === "initialize") {
      session.initialized = true;
      session.protocolVersion = asOptionalTrimmedString(params.protocolVersion) ?? DEFAULT_PROTOCOL_VERSION;
      session.identity = parseInitializeIdentity(params);
      return {
        protocolVersion: session.protocolVersion,
        serverInfo: {
          name: "ade-mcp-server",
          version: serverVersion
        },
        capabilities: {
          tools: {
            listChanged: false
          },
          resources: {
            listChanged: false,
            subscribe: false
          }
        }
      };
    }
    if (method === "notifications/initialized") {
      return null;
    }
    if (!session.initialized) {
      throw new JsonRpcError(JsonRpcErrorCode.invalidRequest, "Server must be initialized first.");
    }
    if (method === "ping") {
      return { pong: true, at: nowIso2() };
    }
    if (method === "tools/list") {
      return {
        tools: TOOL_SPECS.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema
        }))
      };
    }
    if (method === "tools/call") {
      const toolName = assertNonEmptyString(params.name, "name");
      const toolSpec = findToolSpec(toolName);
      void toolSpec;
      const toolArgs = safeObject(params.arguments);
      try {
        const result = await auditToolCall(toolName, toolArgs, async () => {
          if (READ_ONLY_TOOLS.has(toolName) || MUTATION_TOOLS.has(toolName) || toolName === "spawn_agent" || toolName === "ask_user") {
            return await runTool({ runtime, session, name: toolName, toolArgs });
          }
          throw new JsonRpcError(JsonRpcErrorCode.methodNotFound, `Unsupported tool: ${toolName}`);
        });
        return mcpTextResult(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return mcpTextResult(
          {
            ok: false,
            error: {
              code: error instanceof JsonRpcError ? error.code : JsonRpcErrorCode.toolFailed,
              message
            }
          },
          true
        );
      }
    }
    if (method === "resources/list") {
      const lanes = await runtime.laneService.list({ includeArchived: false });
      const laneRecords = lanes;
      const featureKeys = listFeatureKeysFromLanes(laneRecords);
      const missionIds = listMissionIds(runtime);
      return {
        resources: buildResourceList({
          lanes: laneRecords,
          featureKeys,
          missionIds
        })
      };
    }
    if (method === "resources/read") {
      const uri = assertNonEmptyString(params.uri, "uri");
      return await readResource(runtime, uri);
    }
    if (method === "shutdown") {
      return {};
    }
    if (method === "exit") {
      process.nextTick(() => process.exit(0));
      return {};
    }
    throw new JsonRpcError(JsonRpcErrorCode.methodNotFound, `Method not found: ${method}`);
  };
}

// src/index.ts
function resolveProjectRoot() {
  const fromEnv = process.env.ADE_PROJECT_ROOT?.trim();
  if (fromEnv) return import_node_path15.default.resolve(fromEnv);
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const value = args[i];
    if (value === "--project-root") {
      const next = args[i + 1];
      if (next?.trim()) return import_node_path15.default.resolve(next.trim());
    }
  }
  return process.cwd();
}
async function main() {
  const projectRoot = resolveProjectRoot();
  const runtime = await createAdeMcpRuntime(projectRoot);
  const version = "0.1.0";
  const handler = createMcpRequestHandler({ runtime, serverVersion: version });
  const stop = startJsonRpcServer(handler);
  const shutdown = () => {
    try {
      stop();
    } catch {
    }
    try {
      runtime.dispose();
    } catch {
    }
  };
  process.on("SIGINT", () => {
    shutdown();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    shutdown();
    process.exit(0);
  });
  process.on("exit", () => {
    shutdown();
  });
}
main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`${message}
`);
  process.exit(1);
});
//# sourceMappingURL=index.cjs.map