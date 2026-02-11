# Data Model & Persistence

> Last updated: 2026-02-11

---

## Table of Contents

1. [Overview](#overview)
2. [Design Decisions](#design-decisions)
3. [Technical Details](#technical-details)
   - [SQLite Database](#sqlite-database)
   - [Database Schema](#database-schema)
   - [Database API](#database-api)
   - [Migration System](#migration-system)
   - [Filesystem Artifacts](#filesystem-artifacts)
   - [Global State](#global-state)
4. [Integration Points](#integration-points)
5. [Implementation Status](#implementation-status)

---

## Overview

ADE uses a dual persistence strategy: structured data lives in a SQLite database (via sql.js, an in-process WASM implementation), while large artifacts (terminal transcripts, pack files, process logs, test logs) are stored as files on the filesystem. This split balances the need for efficient querying of metadata with the practical reality that large text blobs are better served by filesystem storage.

All persistence is local to the project. The primary database and all artifact files reside under the `.ade/` directory within the project root, ensuring that ADE's state travels with the repository and can be included or excluded from version control as desired. A separate global state file tracks the user's recent project list.

---

## Design Decisions

### sql.js (WASM) Over Native SQLite

ADE uses sql.js rather than native SQLite (e.g., better-sqlite3) for several reasons:

- **No native compilation**: sql.js is pure JavaScript + WASM, eliminating the need to compile native binaries for each platform and Electron version
- **In-process**: The database runs in the same V8 isolate as the main process, avoiding IPC overhead
- **Portable**: The database file is a standard SQLite format, readable by any SQLite client
- **Trade-off**: Write performance is lower than native SQLite, but ADE's workload is read-heavy with infrequent writes, making this acceptable

### Manual Flush Strategy

Rather than relying on WAL mode or auto-commit, ADE uses a manual flush strategy. The in-memory database is serialized to disk:

- On a debounced timer (125ms after the last write)
- On explicit `flushNow()` calls
- On application shutdown

This approach batches rapid writes (e.g., multiple operation records during a git sync) into a single disk write, reducing I/O overhead.

### TEXT Primary Keys (UUIDs)

All tables use TEXT primary keys containing UUIDs (generated via `crypto.randomUUID()`). This decision trades some query performance for:

- Globally unique identifiers that work across projects and machines
- No auto-increment coordination
- Safe for distributed scenarios (future hosted agent sync)

### ISO 8601 Timestamps

All timestamp columns store ISO 8601 strings (`new Date().toISOString()`). This provides human-readable values, sorts correctly as text, and avoids timezone ambiguity.

### JSON Columns for Flexible Data

Several tables use `*_json` TEXT columns to store structured data that varies by record type (e.g., `metadata_json` in operations, `touched_files_json` in session_deltas). This avoids schema proliferation while keeping the core columns strongly typed.

---

## Technical Details

### SQLite Database

**Location**: `<project_root>/.ade/ade.db`

**Engine**: sql.js 1.13 (SQLite compiled to WASM, loaded via `initSqlJs()`)

**Initialization sequence**:
1. Locate the sql.js WASM binary via `require.resolve("sql.js/dist/sql-wasm.wasm")`
2. Initialize sql.js with the WASM locator
3. Load existing database file if present, otherwise create new in-memory database
4. Run migrations (idempotent `CREATE TABLE IF NOT EXISTS` statements)
5. Return the `AdeDb` interface

### Database Schema

The following tables are created by the migration system in `kvDb.ts`:

#### Key-Value Store

```sql
CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

General-purpose key-value store used for UI layout persistence (`dock_layout:*` keys), config trust hashes, and miscellaneous settings.

#### Projects

```sql
CREATE TABLE IF NOT EXISTS projects (
  id               TEXT PRIMARY KEY,
  root_path        TEXT NOT NULL UNIQUE,
  display_name     TEXT NOT NULL,
  default_base_ref TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  last_opened_at   TEXT NOT NULL
);
```

One row per git repository that has been opened in ADE. The `root_path` uniquely identifies the project. The `default_base_ref` records the detected default branch (e.g., `main`, `master`).

#### Lanes

```sql
CREATE TABLE IF NOT EXISTS lanes (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT,
  base_ref      TEXT NOT NULL,
  branch_ref    TEXT NOT NULL,
  worktree_path TEXT NOT NULL,
  status        TEXT NOT NULL,          -- 'active' | 'archived'
  created_at    TEXT NOT NULL,
  archived_at   TEXT,
  FOREIGN KEY(project_id) REFERENCES projects(id)
);
CREATE INDEX IF NOT EXISTS idx_lanes_project_id ON lanes(project_id);
```

Each lane represents a unit of parallel development work, backed by a git worktree. The `branch_ref` follows the `ade/<slug>-<uuid_prefix>` naming convention. The `worktree_path` points to the filesystem location under `.ade/worktrees/`.

#### Terminal Sessions

```sql
CREATE TABLE IF NOT EXISTS terminal_sessions (
  id                  TEXT PRIMARY KEY,
  lane_id             TEXT NOT NULL,
  pty_id              TEXT,
  title               TEXT NOT NULL,
  started_at          TEXT NOT NULL,
  ended_at            TEXT,
  exit_code           INTEGER,
  transcript_path     TEXT NOT NULL,
  head_sha_start      TEXT,
  head_sha_end        TEXT,
  status              TEXT NOT NULL,     -- 'running' | 'completed' | 'failed' | 'disposed'
  last_output_preview TEXT,
  FOREIGN KEY(lane_id) REFERENCES lanes(id)
);
CREATE INDEX IF NOT EXISTS idx_terminal_sessions_lane_id ON terminal_sessions(lane_id);
CREATE INDEX IF NOT EXISTS idx_terminal_sessions_status  ON terminal_sessions(status);
```

Records every terminal session within a lane. `head_sha_start` and `head_sha_end` capture the git HEAD at session creation and termination, enabling diff computation for what changed during the session. `transcript_path` points to the raw terminal output log file.

#### Session Deltas

```sql
CREATE TABLE IF NOT EXISTS session_deltas (
  session_id        TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL,
  lane_id           TEXT NOT NULL,
  started_at        TEXT NOT NULL,
  ended_at          TEXT,
  head_sha_start    TEXT,
  head_sha_end      TEXT,
  files_changed     INTEGER NOT NULL,
  insertions        INTEGER NOT NULL,
  deletions         INTEGER NOT NULL,
  touched_files_json TEXT NOT NULL,      -- JSON array of file paths
  failure_lines_json TEXT NOT NULL,      -- JSON array of error lines from transcript
  computed_at       TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id),
  FOREIGN KEY(lane_id)    REFERENCES lanes(id),
  FOREIGN KEY(session_id) REFERENCES terminal_sessions(id)
);
CREATE INDEX IF NOT EXISTS idx_session_deltas_lane_started    ON session_deltas(lane_id, started_at);
CREATE INDEX IF NOT EXISTS idx_session_deltas_project_started ON session_deltas(project_id, started_at);
```

Computed after session end by the pack service. Contains the diff statistics (files changed, insertions, deletions), the list of touched files, and any failure lines extracted from the terminal transcript. This is the primary input for pack generation.

#### Operations

```sql
CREATE TABLE IF NOT EXISTS operations (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  lane_id       TEXT,
  kind          TEXT NOT NULL,           -- operation type identifier
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  status        TEXT NOT NULL,           -- 'running' | 'succeeded' | 'failed' | 'canceled'
  pre_head_sha  TEXT,
  post_head_sha TEXT,
  metadata_json TEXT,
  FOREIGN KEY(project_id) REFERENCES projects(id),
  FOREIGN KEY(lane_id)    REFERENCES lanes(id)
);
CREATE INDEX IF NOT EXISTS idx_operations_project_started ON operations(project_id, started_at);
CREATE INDEX IF NOT EXISTS idx_operations_lane_started    ON operations(lane_id, started_at);
CREATE INDEX IF NOT EXISTS idx_operations_kind            ON operations(kind);
```

Records every significant operation (git commands, pack updates, etc.) with timing, status, and before/after HEAD SHAs. The `kind` field identifies the operation type (e.g., `git_commit`, `git_push`, `pack_update_lane`). The `metadata_json` column stores operation-specific details.

Known `kind` values:
- `git_stage`, `git_unstage`, `git_discard`, `git_restore_staged`
- `git_commit`, `git_commit_amend`, `git_revert`, `git_cherry_pick`
- `git_stash_push`, `git_stash_apply`, `git_stash_pop`, `git_stash_drop`
- `git_fetch`, `git_sync_merge`, `git_sync_rebase`
- `git_push`, `git_push_force_with_lease`
- `pack_update_lane`, `pack_update_project`

#### Process Definitions

```sql
CREATE TABLE IF NOT EXISTS process_definitions (
  id                   TEXT PRIMARY KEY,
  project_id           TEXT NOT NULL,
  key                  TEXT NOT NULL,
  name                 TEXT NOT NULL,
  command_json         TEXT NOT NULL,     -- JSON array of command parts
  cwd                  TEXT NOT NULL,
  env_json             TEXT NOT NULL,     -- JSON object of env vars
  autostart            INTEGER NOT NULL,
  restart_policy       TEXT NOT NULL,     -- 'never' | 'on_crash'
  graceful_shutdown_ms INTEGER NOT NULL,
  depends_on_json      TEXT NOT NULL,     -- JSON array of process keys
  readiness_json       TEXT NOT NULL,     -- JSON readiness config
  updated_at           TEXT NOT NULL,
  UNIQUE(project_id, key),
  FOREIGN KEY(project_id) REFERENCES projects(id)
);
```

Stores the resolved process definitions derived from `ade.yaml` and `local.yaml`. Updated when the project configuration is saved or reloaded.

#### Process Runtime

```sql
CREATE TABLE IF NOT EXISTS process_runtime (
  project_id   TEXT NOT NULL,
  process_key  TEXT NOT NULL,
  status       TEXT NOT NULL,            -- 'stopped' | 'starting' | 'running' | etc.
  pid          INTEGER,
  started_at   TEXT,
  ended_at     TEXT,
  exit_code    INTEGER,
  readiness    TEXT NOT NULL,            -- 'unknown' | 'ready' | 'not_ready'
  updated_at   TEXT NOT NULL,
  PRIMARY KEY(project_id, process_key),
  FOREIGN KEY(project_id) REFERENCES projects(id)
);
```

Tracks the current runtime state of each managed process. Updated in real time as processes start, stop, crash, or change readiness state.

#### Process Runs

```sql
CREATE TABLE IF NOT EXISTS process_runs (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL,
  process_key        TEXT NOT NULL,
  started_at         TEXT NOT NULL,
  ended_at           TEXT,
  exit_code          INTEGER,
  termination_reason TEXT NOT NULL,
  log_path           TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id)
);
CREATE INDEX IF NOT EXISTS idx_process_runs_project_proc ON process_runs(project_id, process_key);
CREATE INDEX IF NOT EXISTS idx_process_runs_started_at   ON process_runs(started_at);
```

Historical record of every process execution. Each start-to-exit cycle creates one row.

#### Stack Buttons

```sql
CREATE TABLE IF NOT EXISTS stack_buttons (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL,
  key               TEXT NOT NULL,
  name              TEXT NOT NULL,
  process_keys_json TEXT NOT NULL,       -- JSON array of process keys
  start_order       TEXT NOT NULL,       -- 'parallel' | 'dependency'
  updated_at        TEXT NOT NULL,
  UNIQUE(project_id, key),
  FOREIGN KEY(project_id) REFERENCES projects(id)
);
```

Defines grouped process launch configurations. A stack button starts/stops a set of processes together.

#### Test Suites

```sql
CREATE TABLE IF NOT EXISTS test_suites (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  key          TEXT NOT NULL,
  name         TEXT NOT NULL,
  command_json TEXT NOT NULL,
  cwd          TEXT NOT NULL,
  env_json     TEXT NOT NULL,
  timeout_ms   INTEGER,
  tags_json    TEXT NOT NULL,            -- JSON array of tags
  updated_at   TEXT NOT NULL,
  UNIQUE(project_id, key),
  FOREIGN KEY(project_id) REFERENCES projects(id)
);
```

#### Test Runs

```sql
CREATE TABLE IF NOT EXISTS test_runs (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  lane_id      TEXT,
  suite_key    TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  ended_at     TEXT,
  status       TEXT NOT NULL,            -- 'running' | 'passed' | 'failed' | 'canceled' | 'timed_out'
  exit_code    INTEGER,
  duration_ms  INTEGER,
  summary_json TEXT,
  log_path     TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id)
);
CREATE INDEX IF NOT EXISTS idx_test_runs_project_suite ON test_runs(project_id, suite_key);
CREATE INDEX IF NOT EXISTS idx_test_runs_started_at    ON test_runs(started_at);
```

#### Packs Index

```sql
CREATE TABLE IF NOT EXISTS packs_index (
  pack_key                TEXT PRIMARY KEY,
  project_id              TEXT NOT NULL,
  lane_id                 TEXT,
  pack_type               TEXT NOT NULL,  -- 'project' | 'lane'
  pack_path               TEXT NOT NULL,
  deterministic_updated_at TEXT NOT NULL,
  narrative_updated_at    TEXT,
  last_head_sha           TEXT,
  metadata_json           TEXT,
  FOREIGN KEY(project_id) REFERENCES projects(id),
  FOREIGN KEY(lane_id)    REFERENCES lanes(id)
);
CREATE INDEX IF NOT EXISTS idx_packs_index_project ON packs_index(project_id);
CREATE INDEX IF NOT EXISTS idx_packs_index_lane    ON packs_index(lane_id);
```

Index table for pack files. The `pack_key` is either `"project"` for the project pack or `"lane:<lane_id>"` for lane packs. Tracks when the deterministic and narrative sections were last updated and the HEAD SHA at the time of generation.

### Database API

The `AdeDb` interface provides a minimal API surface:

```typescript
export type AdeDb = {
  // Key-value operations (backed by kv table)
  getJson: <T>(key: string) => T | null;
  setJson: (key: string, value: unknown) => void;

  // Raw SQL operations (parameterized queries only)
  run: (sql: string, params?: SqlValue[]) => void;
  get: <T>(sql: string, params?: SqlValue[]) => T | null;
  all: <T>(sql: string, params?: SqlValue[]) => T[];

  // Lifecycle
  flushNow: () => void;
  close: () => void;
};
```

All queries use parameterized statements (`?` placeholders), preventing SQL injection. The `run()` method is for INSERT/UPDATE/DELETE statements and triggers a debounced flush. The `get()` and `all()` methods are for SELECT queries and do not trigger flushes.

### Migration System

Migrations are defined in the `migrate()` function in `kvDb.ts`. All migrations use `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`, making them idempotent. The migration function runs on every database open, ensuring the schema is always current.

There is no explicit version tracking -- the idempotent nature of the DDL statements serves as the migration mechanism. Future schema changes that require data transformation will need a version column in the `kv` table.

### Filesystem Artifacts

All ADE artifacts live under `.ade/` in the project root:

```
<project_root>/
└── .ade/
    ├── ade.db                           # SQLite database
    ├── ade.yaml                         # Shared config (git-tracked)
    ├── local.yaml                       # Local config (gitignored)
    ├── logs/
    │   └── main.jsonl                   # Structured JSON logs
    ├── worktrees/
    │   ├── <lane-slug-1>-<uuid>/        # Git worktree for lane 1
    │   └── <lane-slug-2>-<uuid>/        # Git worktree for lane 2
    ├── transcripts/
    │   └── <session-uuid>.log           # Raw terminal output capture
    ├── packs/
    │   ├── project_pack.md              # Project-level context pack
    │   └── lanes/
    │       └── <lane-uuid>/
    │           └── lane_pack.md         # Lane-level context pack
    ├── process-logs/
    │   └── <process-key>-<run-uuid>.log # Process stdout/stderr
    └── test-logs/
        └── <suite-key>-<run-uuid>.log   # Test suite output
```

The `.ade/` directory is excluded from git tracking via `.git/info/exclude` (added automatically by `ensureAdeExcluded()` on project initialization). The `ade.yaml` file is the exception -- it is intended to be committed to the repository for shared configuration.

### Global State

**Location**: `<electron_userData>/ade-state.json` (typically `~/Library/Application Support/ade-desktop/ade-state.json` on macOS)

**Contents**:
```json
{
  "recentProjects": [
    {
      "rootPath": "/path/to/project",
      "displayName": "project-name",
      "baseRef": "main"
    }
  ],
  "lastProjectRoot": "/path/to/project"
}
```

Updated whenever a project is opened. Used to restore the last-opened project on application launch.

---

## Integration Points

- **KV Store** --> Layout persistence, config trust hashes
- **Projects table** --> Lane service (foreign key), operation service (scoping)
- **Lanes table** --> Session service, pack service, git service, diff service
- **Terminal Sessions** --> Session delta computation, pack generation
- **Session Deltas** --> Lane pack body, project pack body
- **Operations** --> History page, undo tracking (future)
- **Packs Index** --> Pack viewer UI, hosted agent sync (future)
- **Process/Test tables** --> Process manager UI, test runner UI, pack body generation

---

## Implementation Status

### Completed

- SQLite database initialization with sql.js WASM
- Complete schema with 12 tables and 16 indexes
- Debounced flush strategy (125ms after last write)
- Parameterized query API (no SQL injection)
- KV store for layout and settings
- All core tables (projects, lanes, sessions, session_deltas, operations, packs_index)
- All process/test tables (process_definitions, process_runtime, process_runs, stack_buttons, test_suites, test_runs)
- Filesystem artifact directories (transcripts, packs, process-logs, test-logs, worktrees)
- Global state persistence (recent projects)
- Idempotent migration system

### Planned (Not Yet Created)

- `stacks` table for parent-child lane relationships
- `lane_profiles` table for named process/test/env defaults per lane type
- `lane_overlay_policies` table for workspace-level overrides
- `checkpoints` table for immutable execution snapshots
- `pack_events` table for append-only pack change log
- `pack_versions` table for immutable rendered pack snapshots
- `pack_heads` table for mutable pointers to latest pack version per scope
- Schema version tracking for non-idempotent migrations
- Database compaction / vacuum scheduling
