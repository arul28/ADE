# Data Model & Persistence

> Roadmap reference: `docs/final-plan/README.md` is the canonical future plan and sequencing source.

> Last updated: 2026-03-05

---

## Table of Contents

1. [Overview](#overview)
2. [Design Decisions](#design-decisions)
3. [TypeScript Types Architecture](#typescript-types-architecture)
   - [Domain Module Layout](#domain-module-layout)
   - [Model System](#model-system)
4. [Technical Details](#technical-details)
   - [SQLite Database](#sqlite-database)
   - [Database Schema](#database-schema)
   - [Database API](#database-api)
   - [Migration System](#migration-system)
   - [Filesystem Artifacts](#filesystem-artifacts)
   - [Global State](#global-state)
5. [Integration Points](#integration-points)
6. [Implementation Status](#implementation-status)

---

## Overview

ADE uses a dual persistence strategy: structured data lives in a SQLite database (via sql.js, an in-process WASM implementation), while large artifacts (terminal transcripts, logs, generated docs, and compatibility/history artifacts) are stored as files on the filesystem. This split balances the need for efficient querying of metadata with the practical reality that large text blobs are better served by filesystem storage.

All persistence is local to the project. The primary database and all artifact files reside under the `.ade/` directory within the project root, ensuring that ADE's state travels with the repository and can be included or excluded from version control as desired. Unified memory in SQLite is the canonical durable memory backend. Persisted `.ade/packs/...` files may still exist for compatibility/history, but live runtime exports are generated from current local state rather than loaded from pre-refreshed pack files. A separate global state file tracks the user's recent project list.

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
- Safe for distributed scenarios (future relay sync)

### ISO 8601 Timestamps

All timestamp columns store ISO 8601 strings (`new Date().toISOString()`). This provides human-readable values, sorts correctly as text, and avoids timezone ambiguity.

### JSON Columns for Flexible Data

Several tables use `*_json` TEXT columns to store structured data that varies by record type (e.g., `metadata_json` in operations, `touched_files_json` in session_deltas). This avoids schema proliferation while keeping the core columns strongly typed.

---

## TypeScript Types Architecture

All shared TypeScript types consumed by both the main process and the renderer live under `apps/desktop/src/shared/types/`. This directory replaced the former monolithic `src/shared/types.ts` file (which had grown to ~5,700 lines) with a set of focused domain modules. A barrel `index.ts` re-exports every module, so existing imports from `../shared/types` continue to work without changes.

### Domain Module Layout

```
src/shared/types/
├── index.ts          # Barrel re-export (`export * from "./core"`, etc.)
├── core.ts           # AppInfo, ProjectInfo, utility/foundation types
├── models.ts         # ModelProvider, ModelConfig, ThinkingLevel, OrchestratorCallType, intelligence config
├── git.ts            # Git status, diff, stash, log, branch types
├── lanes.ts          # Lane, LaneOverlay, lane filter/creation types
├── conflicts.ts      # Conflict predictions, proposals, resolution, risk matrix types
├── prs.ts            # Pull request, PrStrategy, PrDepth, review/check status types
├── files.ts          # Workspace file tree, file status, diff stat types
├── sessions.ts       # Terminal session, session delta, agent chat session types
├── chat.ts           # Agent chat messages, envelopes, tool types
├── missions.ts       # Mission status, steps, events, interventions, artifacts
├── orchestrator.ts   # Run graph, worker state, DAG, recovery, coordinator, team runtime
├── config.ts         # AdeConfig, ConfigSnapshot, TrustState, lane overlay policies
├── automations.ts    # Automation rules, triggers, action types
├── packs.ts          # Pack headers, exports, delta digests, conflict lineage
├── budget.ts         # Mission budget, phase caps, cost tracking
└── usage.ts          # Token usage, cost breakdown, model utilization
```

Each module owns a single domain and imports from sibling modules only when necessary (for example, `missions.ts` imports `ModelConfig` from `./models` and `PrStrategy` from `./prs`). Cross-module imports are kept minimal to avoid circular dependencies.

During the split, 16 dead or unused types were identified and deleted rather than migrated. The barrel re-export in `index.ts` ensures full backward compatibility: every consumer that previously imported from `../shared/types` or `../../shared/types` works unchanged.

### Model System

The model system is built on two coordinated files:

- **`src/shared/modelRegistry.ts`** — The single source of truth for all AI models. Defines the `MODEL_REGISTRY` constant (an array of `ModelDescriptor` objects) covering every supported model across Anthropic, OpenAI, Google, Mistral, DeepSeek, xAI, Meta, and local providers (Ollama, LM Studio, vLLM, Groq, Together). Each descriptor includes:
  - Identity: `id`, `shortId`, `displayName`, `family`, `sdkProvider`, `sdkModelId`
  - Capabilities: `tools`, `vision`, `reasoning`, `streaming`, plus optional `reasoningTiers`
  - Sizing: `contextWindow`, `maxOutputTokens`
  - Pricing: `inputPricePer1M`, `outputPricePer1M`, `costTier` (low/medium/high/very_high)
  - Auth: `authTypes` (cli-subscription, api-key, oauth, openrouter, local)
  - Runtime: `isCliWrapped`, `cliCommand`, `color`

  The module also exports helper functions: `getModelById()`, `getModelPricing()`, `updateModelPricingInRegistry()`.

- **`src/shared/modelProfiles.ts`** — Derives the missions UI model catalog and intelligence profiles from `MODEL_REGISTRY` rather than maintaining parallel lists. Maps registry descriptors to `ModelEntry` objects (used by the mission model selector) and defines per-call-type intelligence defaults (`OrchestratorIntelligenceConfig`) and mission model profiles (`MissionModelProfile`).

This two-file structure ensures that adding a new model requires only a single entry in `MODEL_REGISTRY`. Pricing, display names, cost tiers, and intelligence defaults all flow from that one record.

---

## Technical Details

### SQLite Database

**Location**: `<project_root>/.ade/ade.db`

**Engine**: sql.js 1.13 (SQLite compiled to WASM, loaded via `initSqlJs()`)

**Initialization sequence**:
1. Locate the sql.js WASM binary via `require.resolve("sql.js/dist/sql-wasm.wasm")`
2. Initialize sql.js with the WASM locator
3. Load existing database file if present, otherwise create new in-memory database
4. Bootstrap the current schema via idempotent `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` statements
5. Return the `AdeDb` interface

### Database Schema

The following 63 tables are created by the schema bootstrap in `kvDb.ts`:

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
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL,
  name              TEXT NOT NULL,
  description       TEXT,
  lane_type         TEXT NOT NULL DEFAULT 'worktree',  -- 'primary' | 'worktree' | 'attached'
  base_ref          TEXT NOT NULL,
  branch_ref        TEXT NOT NULL,
  worktree_path     TEXT NOT NULL,
  attached_root_path TEXT,              -- For 'attached' lanes: external path
  is_edit_protected INTEGER NOT NULL DEFAULT 0,
  parent_lane_id    TEXT,               -- For stacked lanes: parent in the stack
  color             TEXT,               -- UI color hint
  icon              TEXT,               -- UI icon hint
  tags_json         TEXT,               -- JSON array of string tags
  status            TEXT NOT NULL,      -- 'active' | 'archived'
  created_at        TEXT NOT NULL,
  archived_at       TEXT,
  FOREIGN KEY(project_id) REFERENCES projects(id),
  FOREIGN KEY(parent_lane_id) REFERENCES lanes(id)
);
CREATE INDEX IF NOT EXISTS idx_lanes_project_id     ON lanes(project_id);
CREATE INDEX IF NOT EXISTS idx_lanes_project_type   ON lanes(project_id, lane_type);
CREATE INDEX IF NOT EXISTS idx_lanes_project_parent ON lanes(project_id, parent_lane_id);
```

Each lane represents a unit of parallel development work. Lanes have three types:
- `primary`: The main branch (e.g., `main`), always present.
- `worktree`: Standard ADE worktree-backed lanes under `.ade/worktrees/`.
- `attached`: External directories attached as lanes (e.g., existing checkouts).

The `parent_lane_id` enables stacked lane hierarchies. The `color`, `icon`, and `tags_json` fields provide UI customization. `is_edit_protected` prevents accidental modifications to protected lanes (e.g., production branches).

#### Terminal Sessions

```sql
CREATE TABLE IF NOT EXISTS terminal_sessions (
  id                  TEXT PRIMARY KEY,
  lane_id             TEXT NOT NULL,
  pty_id              TEXT,
  tracked             INTEGER NOT NULL DEFAULT 1,
  goal                TEXT,
  tool_type           TEXT,
  pinned              INTEGER NOT NULL DEFAULT 0,
  title               TEXT NOT NULL,
  started_at          TEXT NOT NULL,
  ended_at            TEXT,
  exit_code           INTEGER,
  transcript_path     TEXT NOT NULL,
  head_sha_start      TEXT,
  head_sha_end        TEXT,
  status              TEXT NOT NULL,     -- 'running' | 'completed' | 'failed' | 'disposed'
  last_output_preview TEXT,
  summary             TEXT,
  FOREIGN KEY(lane_id) REFERENCES lanes(id)
);
CREATE INDEX IF NOT EXISTS idx_terminal_sessions_lane_id ON terminal_sessions(lane_id);
CREATE INDEX IF NOT EXISTS idx_terminal_sessions_status  ON terminal_sessions(status);
```

Records every terminal session within a lane. `head_sha_start` and `head_sha_end` capture the git HEAD at session creation and termination, enabling diff computation for what changed during the session. `transcript_path` points to the raw terminal output log file. Additional metadata:
- `tracked`: Whether the session is included in compatibility pack generation and live export synthesis (default: yes).
- `goal`: User-provided or inferred session intent description.
- `tool_type`: Session tool identifier (e.g., `shell`, `codex`, `claude`, `codex-chat`, `claude-chat`, `ai-chat`, `cursor`) used for filtering, badges, and lifecycle semantics.
- `pinned`: Whether the session is pinned for retention.
- `summary`: Post-session AI-generated or user-provided summary.

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

Computed after session end by the pack service. Contains the diff statistics (files changed, insertions, deletions), the list of touched files, and any failure lines extracted from the terminal transcript. This is a primary input for compatibility pack generation and live export synthesis.

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
  lane_id      TEXT NOT NULL,
  process_key  TEXT NOT NULL,
  status       TEXT NOT NULL,            -- 'stopped' | 'starting' | 'running' | etc.
  pid          INTEGER,
  started_at   TEXT,
  ended_at     TEXT,
  exit_code    INTEGER,
  readiness    TEXT NOT NULL,            -- 'unknown' | 'ready' | 'not_ready'
  updated_at   TEXT NOT NULL,
  PRIMARY KEY(project_id, lane_id, process_key),
  FOREIGN KEY(project_id) REFERENCES projects(id),
  FOREIGN KEY(lane_id) REFERENCES lanes(id)
);
CREATE INDEX IF NOT EXISTS idx_process_runtime_project_id   ON process_runtime(project_id);
CREATE INDEX IF NOT EXISTS idx_process_runtime_project_lane ON process_runtime(project_id, lane_id);
```

Tracks the current runtime state of each managed process, scoped per lane. `lane_id` is required for every runtime row.

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
  pack_type               TEXT NOT NULL,  -- 'project' | 'lane' | 'feature' | 'conflict' | 'plan' | 'mission'
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

Index table for persisted pack-compatible artifacts. `pack_key` is scoped by pack type (`project`, `lane:<lane_id>`, `feature:<feature_key>`, `conflict:<lane_id>:<peer_key>`, `plan:<lane_id>`, `mission:<mission_id>`). Tracks when deterministic/narrative sections were last updated and the HEAD SHA at generation time. Live runtime exports may be generated without reading these files first.

#### Conflict Predictions (Phase 5)

```sql
CREATE TABLE IF NOT EXISTS conflict_predictions (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL,
  lane_a_id             TEXT NOT NULL,
  lane_b_id             TEXT,
  status                TEXT NOT NULL,
  conflicting_files_json TEXT,
  overlap_files_json    TEXT,
  lane_a_sha            TEXT,
  lane_b_sha            TEXT,
  predicted_at          TEXT NOT NULL,
  expires_at            TEXT,
  FOREIGN KEY(project_id) REFERENCES projects(id),
  FOREIGN KEY(lane_a_id) REFERENCES lanes(id),
  FOREIGN KEY(lane_b_id) REFERENCES lanes(id)
);
CREATE INDEX IF NOT EXISTS idx_cp_lane_a       ON conflict_predictions(lane_a_id);
CREATE INDEX IF NOT EXISTS idx_cp_lane_b       ON conflict_predictions(lane_b_id);
CREATE INDEX IF NOT EXISTS idx_cp_predicted_at ON conflict_predictions(predicted_at);
```

Stores the results of conflict prediction dry-merge simulations between lane pairs. Each prediction records which files conflict, which files overlap, and the HEAD SHAs at prediction time. Predictions expire after a configurable duration.

#### Conflict Proposals (Phase 5)

```sql
CREATE TABLE IF NOT EXISTS conflict_proposals (
  id                    TEXT PRIMARY KEY,
  project_id            TEXT NOT NULL,
  lane_id               TEXT NOT NULL,
  peer_lane_id          TEXT,
  prediction_id         TEXT,
  source                TEXT NOT NULL,     -- 'hosted' | 'byok' | 'manual'
  confidence            REAL,              -- 0.0 to 1.0
  explanation           TEXT,
  diff_patch            TEXT NOT NULL,
  status                TEXT NOT NULL,     -- 'pending' | 'applied' | 'rejected' | 'undone'
  job_id                TEXT,
  artifact_id           TEXT,
  applied_operation_id  TEXT,
  metadata_json         TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id),
  FOREIGN KEY(lane_id) REFERENCES lanes(id),
  FOREIGN KEY(peer_lane_id) REFERENCES lanes(id),
  FOREIGN KEY(prediction_id) REFERENCES conflict_predictions(id),
  FOREIGN KEY(applied_operation_id) REFERENCES operations(id)
);
CREATE INDEX IF NOT EXISTS idx_conflict_proposals_lane   ON conflict_proposals(project_id, lane_id);
CREATE INDEX IF NOT EXISTS idx_conflict_proposals_status ON conflict_proposals(project_id, status);
```

Stores AI-generated conflict resolution proposals. Each proposal contains a unified diff patch, a confidence score, and an explanation. When applied, the `applied_operation_id` links to the git operation for undo support.

#### Pull Requests (Phase 7)

```sql
CREATE TABLE IF NOT EXISTS pull_requests (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL,
  lane_id           TEXT NOT NULL,
  repo_owner        TEXT NOT NULL,
  repo_name         TEXT NOT NULL,
  github_pr_number  INTEGER NOT NULL,
  github_url        TEXT NOT NULL,
  github_node_id    TEXT,
  title             TEXT,
  state             TEXT NOT NULL,         -- 'open' | 'closed' | 'merged'
  base_branch       TEXT NOT NULL,
  head_branch       TEXT NOT NULL,
  checks_status     TEXT,                  -- 'pending' | 'passing' | 'failing' | null
  review_status     TEXT,                  -- 'approved' | 'changes_requested' | 'pending' | null
  additions         INTEGER NOT NULL DEFAULT 0,
  deletions         INTEGER NOT NULL DEFAULT 0,
  last_synced_at    TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE(project_id, lane_id),
  UNIQUE(project_id, repo_owner, repo_name, github_pr_number),
  FOREIGN KEY(project_id) REFERENCES projects(id),
  FOREIGN KEY(lane_id) REFERENCES lanes(id)
);
CREATE INDEX IF NOT EXISTS idx_pull_requests_lane_id    ON pull_requests(lane_id);
CREATE INDEX IF NOT EXISTS idx_pull_requests_project_id ON pull_requests(project_id);
```

Maps lanes to GitHub pull requests. Each lane can have at most one linked PR. The PR state and check/review statuses are synced periodically by the PR polling service.

#### Checkpoints (Phase 8)

```sql
CREATE TABLE IF NOT EXISTS checkpoints (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL,
  lane_id             TEXT NOT NULL,
  session_id          TEXT,
  sha                 TEXT NOT NULL,
  diff_stat_json      TEXT,
  pack_event_ids_json TEXT,
  created_at          TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id),
  FOREIGN KEY(lane_id) REFERENCES lanes(id),
  FOREIGN KEY(session_id) REFERENCES terminal_sessions(id)
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_project_created ON checkpoints(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_checkpoints_lane_created    ON checkpoints(lane_id, created_at);
```

Immutable execution snapshots recorded at session boundaries. Each checkpoint captures the git SHA, diff statistics, and associated pack event IDs for that point in time.

#### Pack Events (Phase 8)

```sql
CREATE TABLE IF NOT EXISTS pack_events (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  pack_key      TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  payload_json  TEXT,
  created_at    TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id)
);
CREATE INDEX IF NOT EXISTS idx_pack_events_project_created  ON pack_events(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_pack_events_pack_key_created ON pack_events(project_id, pack_key, created_at);
```

Append-only event log for pack lifecycle events. Known `event_type` values include: `deterministic_update`, `narrative_update`, `narrative_requested`, `narrative_failed`, `version_created`, `checkpoint_created`. The `payload_json` column stores event-specific details (e.g., provider mode, job IDs, timing telemetry).

#### Pack Versions (Phase 8)

```sql
CREATE TABLE IF NOT EXISTS pack_versions (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL,
  pack_key        TEXT NOT NULL,
  version_number  INTEGER NOT NULL,
  content_hash    TEXT NOT NULL,
  rendered_path   TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id)
);
CREATE INDEX IF NOT EXISTS idx_pack_versions_project_pack         ON pack_versions(project_id, pack_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pack_versions_project_pack_version
  ON pack_versions(project_id, pack_key, version_number);
```

Immutable rendered pack snapshots. Each version is content-addressed by `content_hash` (SHA-256 of the rendered markdown). The `rendered_path` points to the snapshot file on disk. Version numbers are monotonically increasing per `pack_key`.

#### Pack Heads (Phase 8)

```sql
CREATE TABLE IF NOT EXISTS pack_heads (
  project_id         TEXT NOT NULL,
  pack_key           TEXT NOT NULL,
  current_version_id TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  PRIMARY KEY(project_id, pack_key),
  FOREIGN KEY(project_id) REFERENCES projects(id)
);
CREATE INDEX IF NOT EXISTS idx_pack_heads_project ON pack_heads(project_id);
```

Mutable pointers to the latest pack version for each scope. Updated atomically when a new pack version is created.

#### Automation Runs (Phase 8)

```sql
CREATE TABLE IF NOT EXISTS automation_runs (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL,
  automation_id     TEXT NOT NULL,
  trigger_type      TEXT NOT NULL,
  started_at        TEXT NOT NULL,
  ended_at          TEXT,
  status            TEXT NOT NULL,       -- 'running' | 'completed' | 'failed'
  actions_completed INTEGER NOT NULL DEFAULT 0,
  actions_total     INTEGER NOT NULL,
  error_message     TEXT,
  trigger_metadata  TEXT,
  FOREIGN KEY(project_id) REFERENCES projects(id)
);
CREATE INDEX IF NOT EXISTS idx_automation_runs_project_started    ON automation_runs(project_id, started_at);
CREATE INDEX IF NOT EXISTS idx_automation_runs_project_automation ON automation_runs(project_id, automation_id);
```

Records every automation rule execution. Tracks progress (actions completed vs total) and overall status. `trigger_type` identifies what triggered the run (e.g., `head_change`, `manual`).

#### Automation Action Results (Phase 8)

```sql
CREATE TABLE IF NOT EXISTS automation_action_results (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  run_id        TEXT NOT NULL,
  action_index  INTEGER NOT NULL,
  action_type   TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  status        TEXT NOT NULL,
  error_message TEXT,
  output        TEXT,
  FOREIGN KEY(project_id) REFERENCES projects(id),
  FOREIGN KEY(run_id) REFERENCES automation_runs(id)
);
CREATE INDEX IF NOT EXISTS idx_automation_action_results_project_run
  ON automation_action_results(project_id, run_id);
```

Per-action results within an automation run. Each action in a rule's action list gets a separate result row, enabling granular progress tracking and error diagnosis.

#### Missions (Phase 1)

```sql
CREATE TABLE IF NOT EXISTS missions (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL,
  lane_id           TEXT,
  title             TEXT NOT NULL,
  prompt            TEXT NOT NULL,
  status            TEXT NOT NULL,        -- 'queued' | 'in_progress' | 'intervention_required' | 'completed' | 'failed' | 'canceled'
  priority          TEXT NOT NULL DEFAULT 'normal',
  execution_mode    TEXT NOT NULL DEFAULT 'local',
  target_machine_id TEXT,
  outcome_summary   TEXT,
  last_error        TEXT,
  metadata_json     TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  started_at        TEXT,
  completed_at      TEXT,
  FOREIGN KEY(project_id) REFERENCES projects(id),
  FOREIGN KEY(lane_id) REFERENCES lanes(id)
);
CREATE INDEX IF NOT EXISTS idx_missions_project_updated ON missions(project_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_missions_project_status  ON missions(project_id, status);
CREATE INDEX IF NOT EXISTS idx_missions_project_lane    ON missions(project_id, lane_id);
```

Top-level mission goal records. These rows store intake prompt, lifecycle status, priority, execution mode (`local`/`relay`), and target machine metadata for future relay routing.

#### Mission Steps (Phase 1)

```sql
CREATE TABLE IF NOT EXISTS mission_steps (
  id            TEXT PRIMARY KEY,
  mission_id    TEXT NOT NULL,
  project_id    TEXT NOT NULL,
  step_index    INTEGER NOT NULL,
  title         TEXT NOT NULL,
  detail        TEXT,
  kind          TEXT NOT NULL DEFAULT 'manual',
  lane_id       TEXT,
  status        TEXT NOT NULL,
  metadata_json TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  started_at    TEXT,
  completed_at  TEXT,
  UNIQUE(mission_id, step_index),
  FOREIGN KEY(mission_id) REFERENCES missions(id),
  FOREIGN KEY(project_id) REFERENCES projects(id),
  FOREIGN KEY(lane_id) REFERENCES lanes(id)
);
CREATE INDEX IF NOT EXISTS idx_mission_steps_mission_index ON mission_steps(mission_id, step_index);
CREATE INDEX IF NOT EXISTS idx_mission_steps_project_status ON mission_steps(project_id, status);
```

Ordered per-mission steps with independent status transitions. Orchestrator runs can now attach through `mission_step_id` in `orchestrator_steps`.

#### Mission Events (Phase 1)

```sql
CREATE TABLE IF NOT EXISTS mission_events (
  id          TEXT PRIMARY KEY,
  mission_id  TEXT NOT NULL,
  project_id  TEXT NOT NULL,
  event_type  TEXT NOT NULL,
  actor       TEXT NOT NULL,
  summary     TEXT NOT NULL,
  payload_json TEXT,
  created_at  TEXT NOT NULL,
  FOREIGN KEY(mission_id) REFERENCES missions(id),
  FOREIGN KEY(project_id) REFERENCES projects(id)
);
CREATE INDEX IF NOT EXISTS idx_mission_events_mission_created ON mission_events(mission_id, created_at);
CREATE INDEX IF NOT EXISTS idx_mission_events_project_created ON mission_events(project_id, created_at);
```

Append-only mission timeline entries used by the Missions detail event feed and audit surfaces.

#### Mission Artifacts (Phase 1)

```sql
CREATE TABLE IF NOT EXISTS mission_artifacts (
  id            TEXT PRIMARY KEY,
  mission_id    TEXT NOT NULL,
  project_id    TEXT NOT NULL,
  artifact_type TEXT NOT NULL,            -- 'summary' | 'pr' | 'link' | 'note' | 'patch'
  title         TEXT NOT NULL,
  description   TEXT,
  uri           TEXT,
  lane_id       TEXT,
  metadata_json TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  created_by    TEXT NOT NULL,
  FOREIGN KEY(mission_id) REFERENCES missions(id),
  FOREIGN KEY(project_id) REFERENCES projects(id),
  FOREIGN KEY(lane_id) REFERENCES lanes(id)
);
CREATE INDEX IF NOT EXISTS idx_mission_artifacts_mission_created ON mission_artifacts(mission_id, created_at);
```

Outcome and linkage records (PR links, summary notes, patches, references) attached to mission history.

#### Mission Interventions (Phase 1)

```sql
CREATE TABLE IF NOT EXISTS mission_interventions (
  id                TEXT PRIMARY KEY,
  mission_id        TEXT NOT NULL,
  project_id        TEXT NOT NULL,
  intervention_type TEXT NOT NULL,
  status            TEXT NOT NULL,        -- 'open' | 'resolved' | 'dismissed'
  title             TEXT NOT NULL,
  body              TEXT NOT NULL,
  requested_action  TEXT,
  resolution_note   TEXT,
  lane_id           TEXT,
  metadata_json     TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  resolved_at       TEXT,
  FOREIGN KEY(mission_id) REFERENCES missions(id),
  FOREIGN KEY(project_id) REFERENCES projects(id),
  FOREIGN KEY(lane_id) REFERENCES lanes(id)
);
CREATE INDEX IF NOT EXISTS idx_mission_interventions_mission_status ON mission_interventions(mission_id, status);
CREATE INDEX IF NOT EXISTS idx_mission_interventions_project_status ON mission_interventions(project_id, status);
```

Human-in-the-loop gating records used when a mission requires operator approval or input.

#### Mission Step Handoffs (Phase 1.5)

```sql
CREATE TABLE IF NOT EXISTS mission_step_handoffs (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL,
  mission_id     TEXT NOT NULL,
  mission_step_id TEXT,
  run_id         TEXT,
  step_id        TEXT,
  attempt_id     TEXT,
  handoff_type   TEXT NOT NULL,
  producer       TEXT NOT NULL,
  payload_json   TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id),
  FOREIGN KEY(mission_id) REFERENCES missions(id),
  FOREIGN KEY(mission_step_id) REFERENCES mission_steps(id),
  FOREIGN KEY(run_id) REFERENCES orchestrator_runs(id),
  FOREIGN KEY(step_id) REFERENCES orchestrator_steps(id),
  FOREIGN KEY(attempt_id) REFERENCES orchestrator_attempts(id)
);
CREATE INDEX IF NOT EXISTS idx_mission_step_handoffs_mission_created ON mission_step_handoffs(mission_id, created_at);
CREATE INDEX IF NOT EXISTS idx_mission_step_handoffs_step_created ON mission_step_handoffs(mission_step_id, created_at);
CREATE INDEX IF NOT EXISTS idx_mission_step_handoffs_attempt ON mission_step_handoffs(attempt_id);
```

Structured handoff outputs for orchestrator attempts. These are append-only, machine-readable records used for resume, audit replay, and mission history provenance.

#### Orchestrator Runs (Phase 1.5)

```sql
CREATE TABLE IF NOT EXISTS orchestrator_runs (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL,
  mission_id         TEXT NOT NULL,
  status             TEXT NOT NULL,      -- 'queued' | 'running' | 'paused' | 'succeeded' | 'failed' | 'canceled'
  context_profile    TEXT NOT NULL DEFAULT 'orchestrator_deterministic_v1',
  scheduler_state    TEXT NOT NULL,
  runtime_cursor_json TEXT,
  last_error         TEXT,
  metadata_json      TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  started_at         TEXT,
  completed_at       TEXT,
  FOREIGN KEY(project_id) REFERENCES projects(id),
  FOREIGN KEY(mission_id) REFERENCES missions(id)
);
CREATE INDEX IF NOT EXISTS idx_orchestrator_runs_project_status ON orchestrator_runs(project_id, status);
CREATE INDEX IF NOT EXISTS idx_orchestrator_runs_mission ON orchestrator_runs(mission_id);
CREATE INDEX IF NOT EXISTS idx_orchestrator_runs_project_updated ON orchestrator_runs(project_id, updated_at);
```

Top-level deterministic orchestration records. `runtime_cursor_json` stores context cursor state for durable resume and replay.

#### Orchestrator Steps (Phase 1.5)

```sql
CREATE TABLE IF NOT EXISTS orchestrator_steps (
  id                      TEXT PRIMARY KEY,
  run_id                  TEXT NOT NULL,
  project_id              TEXT NOT NULL,
  mission_step_id         TEXT,
  step_key                TEXT NOT NULL,
  step_index              INTEGER NOT NULL,
  title                   TEXT NOT NULL,
  lane_id                 TEXT,
  status                  TEXT NOT NULL,   -- 'pending' | 'ready' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'skipped' | 'canceled'
  join_policy             TEXT NOT NULL DEFAULT 'all_success',
  quorum_count            INTEGER,
  dependency_step_ids_json TEXT NOT NULL DEFAULT '[]',
  retry_limit             INTEGER NOT NULL DEFAULT 0,
  retry_count             INTEGER NOT NULL DEFAULT 0,
  last_attempt_id         TEXT,
  policy_json             TEXT,
  metadata_json           TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  started_at              TEXT,
  completed_at            TEXT,
  UNIQUE(run_id, step_key),
  FOREIGN KEY(run_id) REFERENCES orchestrator_runs(id),
  FOREIGN KEY(project_id) REFERENCES projects(id),
  FOREIGN KEY(mission_step_id) REFERENCES mission_steps(id),
  FOREIGN KEY(lane_id) REFERENCES lanes(id)
);
CREATE INDEX IF NOT EXISTS idx_orchestrator_steps_run_status ON orchestrator_steps(run_id, status);
CREATE INDEX IF NOT EXISTS idx_orchestrator_steps_project_status ON orchestrator_steps(project_id, status);
CREATE INDEX IF NOT EXISTS idx_orchestrator_steps_run_order ON orchestrator_steps(run_id, step_index);
```

DAG step rows linked to mission and lane scopes with deterministic dependency/join semantics.

#### Orchestrator Attempts (Phase 1.5)

```sql
CREATE TABLE IF NOT EXISTS orchestrator_attempts (
  id                     TEXT PRIMARY KEY,
  run_id                 TEXT NOT NULL,
  step_id                TEXT NOT NULL,
  project_id             TEXT NOT NULL,
  attempt_number         INTEGER NOT NULL,
  status                 TEXT NOT NULL,   -- 'queued' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'canceled'
  executor_kind          TEXT NOT NULL,   -- 'claude' | 'codex' | 'gemini' | 'shell' | 'manual'
  executor_session_id    TEXT,
  tracked_session_enforced INTEGER NOT NULL DEFAULT 1,
  context_profile        TEXT NOT NULL DEFAULT 'orchestrator_deterministic_v1',
  context_snapshot_id    TEXT,
  error_class            TEXT NOT NULL DEFAULT 'none',
  error_message          TEXT,
  retry_backoff_ms       INTEGER NOT NULL DEFAULT 0,
  result_envelope_json   TEXT,
  metadata_json          TEXT,
  created_at             TEXT NOT NULL,
  started_at             TEXT,
  completed_at           TEXT,
  UNIQUE(step_id, attempt_number),
  FOREIGN KEY(run_id) REFERENCES orchestrator_runs(id),
  FOREIGN KEY(step_id) REFERENCES orchestrator_steps(id),
  FOREIGN KEY(project_id) REFERENCES projects(id),
  FOREIGN KEY(context_snapshot_id) REFERENCES orchestrator_context_snapshots(id)
);
CREATE INDEX IF NOT EXISTS idx_orchestrator_attempts_run_status ON orchestrator_attempts(run_id, status);
CREATE INDEX IF NOT EXISTS idx_orchestrator_attempts_step_status ON orchestrator_attempts(step_id, status);
CREATE INDEX IF NOT EXISTS idx_orchestrator_attempts_project_created ON orchestrator_attempts(project_id, created_at);
```

Attempt-level execution records with normalized result envelopes and explicit context profile provenance.

#### Orchestrator Claims (Phase 1.5)

```sql
CREATE TABLE IF NOT EXISTS orchestrator_claims (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  run_id       TEXT NOT NULL,
  step_id      TEXT,
  attempt_id   TEXT,
  owner_id     TEXT NOT NULL,
  scope_kind   TEXT NOT NULL,            -- 'lane' | 'file' | 'env'
  scope_value  TEXT NOT NULL,
  state        TEXT NOT NULL,            -- 'active' | 'released' | 'expired'
  acquired_at  TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  released_at  TEXT,
  policy_json  TEXT,
  metadata_json TEXT,
  FOREIGN KEY(project_id) REFERENCES projects(id),
  FOREIGN KEY(run_id) REFERENCES orchestrator_runs(id),
  FOREIGN KEY(step_id) REFERENCES orchestrator_steps(id),
  FOREIGN KEY(attempt_id) REFERENCES orchestrator_attempts(id)
);
CREATE INDEX IF NOT EXISTS idx_orchestrator_claims_run_state ON orchestrator_claims(run_id, state);
CREATE INDEX IF NOT EXISTS idx_orchestrator_claims_scope_state ON orchestrator_claims(project_id, scope_kind, scope_value, state);
CREATE INDEX IF NOT EXISTS idx_orchestrator_claims_expires ON orchestrator_claims(state, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_orchestrator_claims_active_scope
  ON orchestrator_claims(project_id, scope_kind, scope_value)
  WHERE state = 'active';
```

Lease/claim ownership model for collision-safe multi-lane execution. Partial unique index enforces one active owner per scope.

#### Orchestrator Context Snapshots (Phase 1.5)

```sql
CREATE TABLE IF NOT EXISTS orchestrator_context_snapshots (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL,
  run_id         TEXT NOT NULL,
  step_id        TEXT,
  attempt_id     TEXT,
  snapshot_type  TEXT NOT NULL,          -- 'run' | 'step' | 'attempt'
  context_profile TEXT NOT NULL DEFAULT 'orchestrator_deterministic_v1',
  cursor_json    TEXT NOT NULL,
  created_at     TEXT NOT NULL,
  FOREIGN KEY(project_id) REFERENCES projects(id),
  FOREIGN KEY(run_id) REFERENCES orchestrator_runs(id),
  FOREIGN KEY(step_id) REFERENCES orchestrator_steps(id),
  FOREIGN KEY(attempt_id) REFERENCES orchestrator_attempts(id)
);
CREATE INDEX IF NOT EXISTS idx_orchestrator_context_snapshots_run_created ON orchestrator_context_snapshots(run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_orchestrator_context_snapshots_attempt ON orchestrator_context_snapshots(attempt_id);
```

Durable context cursor snapshots for exact replay of what context was consumed by each run/step/attempt.

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

Schema bootstrap is defined in the `migrate()` function in `kvDb.ts`. Runtime startup creates the current tables/indexes idempotently and enables foreign keys (`pragma foreign_keys = on`).

The no-legacy baseline assumes current table shapes. Runtime code does not maintain helper backfill layers (`addColumnIfMissing`, `createIndexIfColumnsExist`) or runtime data backfill shims for old schemas.

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
    ├── packs/                           # Compatibility pack artifacts + export history
    │   ├── project_pack.md              # Optional persisted project context artifact
    │   ├── versions/                    # Immutable pack version snapshots
    │   │   └── <pack-key>/
    │   │       └── v<N>.md
    │   ├── conflicts/
    │   │   └── predictions/
    │   │       └── <lane-id>.json       # Deterministic conflict prediction summary
    │   ├── external-resolver-runs/
    │   │   └── <run-id>/                # Generated per-run resolver context files + prompt/log/patch
    │   └── lanes/
    │       └── <lane-uuid>/
    │           ├── lane_pack.md         # Optional persisted lane context artifact
    │           └── plan_pack.md         # Optional persisted lane plan artifact
    ├── process-logs/
    │   └── <process-key>-<run-uuid>.log # Process stdout/stderr
    └── test-logs/
        └── <suite-key>-<run-uuid>.log   # Test suite output
```

The `.ade/` directory is excluded from git tracking via `.git/info/exclude` (added automatically by `ensureAdeExcluded()` on project initialization). The `ade.yaml` file is the exception -- it is intended to be committed to the repository for shared configuration.

Runtime note: the canonical W6 context path is live local state plus unified memory. `.ade/packs/` is retained for compatibility exports, history, and audit artifacts rather than as the primary runtime source of truth.

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

- **KV Store** --> Layout persistence, config trust hashes, tiling tree state, graph state
- **Projects table** --> Lane service (foreign key), operation service (scoping)
- **Lanes table** --> Session service, pack service, git service, diff service, conflict service, PR service
- **Terminal Sessions** --> Session delta computation, live export synthesis, compatibility artifact generation
- **Session Deltas** --> Lane/project export synthesis, compatibility artifact generation
- **Operations** --> History page, proposal undo tracking
- **Packs Index** --> Pack viewer UI, relay sync
- **Conflict Predictions** --> Conflict radar UI, live conflict exports, risk matrix
- **Conflict Proposals** --> Conflict resolution UI, proposal apply/undo flow
- **Pull Requests** --> PR page UI, PR polling service, lane status indicators
- **Checkpoints** --> Pack checkpoint viewer, session boundary snapshots
- **Pack Events** --> Pack event timeline, narrative telemetry, delta digest API
- **Pack Versions** --> Pack version history, diff viewer, head version API
- **Pack Heads** --> Current version pointer for each pack scope
- **Automation Runs/Results** --> Automation history UI, run detail viewer
- **Missions tables** --> Missions board, detail timeline, intervention queue, artifact/PR linking
- **Mission Step Handoffs** --> Mission/orchestrator attempt provenance, structured resume context
- **Orchestrator runtime tables** --> Deterministic run/step/attempt scheduling state, claims, and context snapshots
- **Process/Test tables** --> Process manager UI, test runner UI, pack body generation

---

## Implementation Status

### Completed

- TypeScript types directory (`src/shared/types/`) with 16 domain modules + barrel re-export (replaced ~5,700-line monolith)
- Unified model registry (`src/shared/modelRegistry.ts`) as single source of truth for all AI models, with pricing fields and derived profiles
- SQLite database initialization with sql.js WASM
- Complete schema with 40 tables and 80+ indexes
- Debounced flush strategy (125ms after last write)
- Parameterized query API (no SQL injection)
- KV store for layout and settings
- All core tables (projects, lanes, sessions, session_deltas, operations, packs_index)
- All process/test tables (process_definitions, process_runtime, process_runs, stack_buttons, test_suites, test_runs)
- Conflict prediction tables: `conflict_predictions`, `conflict_proposals` (Phase 5)
- Pull request tracking: `pull_requests` (Phase 7)
- Pack versioning: `checkpoints`, `pack_events`, `pack_versions`, `pack_heads` (Phase 8)
- Automation run logging: `automation_runs`, `automation_action_results` (Phase 8)
- Missions persistence: `missions`, `mission_steps`, `mission_events`, `mission_artifacts`, `mission_interventions` (Phase 1)
- Context hardening persistence: `orchestrator_runs`, `orchestrator_steps`, `orchestrator_attempts`, `orchestrator_claims`, `orchestrator_context_snapshots`, `mission_step_handoffs` (Phase 1.5)
- Orchestrator evolution persistence: `memories` (with status/agent_id/confidence/promoted_at/source_run_id extensions), `agent_identities` (agent definition/identity store), `orchestrator_shared_facts`, `attempt_transcripts` (Orchestrator Evolution)
- Lanes table extended with: `lane_type`, `attached_root_path`, `is_edit_protected`, `parent_lane_id`, `color`, `icon`, `tags_json`
- Terminal sessions table extended with: `tracked`, `goal`, `tool_type`, `pinned`, `summary`
- Process runtime table uses required `lane_id` (per-lane process isolation)
- Filesystem artifact directories (transcripts, packs, process-logs, test-logs, worktrees)
- Global state persistence (recent projects)
- Idempotent schema bootstrap with `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`

### Planned (Not Yet Created)

- `lane_profiles` table for named process/test/env defaults per lane type
- `lane_overlay_policies` table for workspace-level overrides
- Schema version tracking for non-idempotent migrations
- Database compaction / vacuum scheduling

#### Planned Tables

```sql
-- Lane port allocation tracking
CREATE TABLE lane_port_allocations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lane_id TEXT NOT NULL REFERENCES lanes(id),
    port_start INTEGER NOT NULL,
    port_end INTEGER NOT NULL,
    allocated_at TEXT NOT NULL DEFAULT (datetime('now')),
    released_at TEXT,
    UNIQUE(lane_id),
    CHECK(port_start < port_end)
);

-- Lane proxy registration
CREATE TABLE lane_proxy_registrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lane_id TEXT NOT NULL REFERENCES lanes(id),
    hostname TEXT NOT NULL,
    target_port INTEGER NOT NULL,
    proxy_port INTEGER NOT NULL DEFAULT 8080,
    registered_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_health_check TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'inactive', 'error')),
    UNIQUE(hostname),
    UNIQUE(lane_id)
);

-- Lane compute backend metadata
CREATE TABLE lane_compute_metadata (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lane_id TEXT NOT NULL REFERENCES lanes(id),
    backend_type TEXT NOT NULL CHECK(backend_type IN ('local', 'vps', 'daytona')),
    workspace_id TEXT,  -- Daytona workspace ID or VPS machine ID
    workspace_url TEXT, -- Remote access URL if applicable
    preview_url TEXT,   -- Generated preview URL
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    stopped_at TEXT,
    metadata_json TEXT, -- Backend-specific metadata
    UNIQUE(lane_id)
);
```

---

## 2026-02-19 Addendum — Phase 2 Orchestrator Persistence

New Phase 2 tables (implemented):

- `orchestrator_timeline_events`
  - append-only timeline for run/step/attempt/claim/scheduler/context/integration signals
  - indexes:
    - `idx_orchestrator_timeline_run_created`
    - `idx_orchestrator_timeline_attempt`
    - `idx_orchestrator_timeline_project_created`
- `orchestrator_gate_reports`
  - deterministic quality-gate snapshot storage
  - index:
    - `idx_orchestrator_gate_reports_project_generated`

Phase 1.5 gate reporting snapshots now persist evaluation outputs for:

- tracked session -> delta/checkpoint latency,
- live context snapshot freshness,
- context completeness rate for orchestrated attempts,
- blocked-run rate due to insufficient context (with reason metadata).

---

## 2026-02-25 Addendum — Orchestrator Evolution Tables

### New Tables

#### Unified Memories (canonical backend)

```sql
CREATE TABLE IF NOT EXISTS unified_memories (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL,
  scope             TEXT NOT NULL,
  scope_owner_id    TEXT,
  tier              INTEGER NOT NULL DEFAULT 2,
  category          TEXT NOT NULL,
  content           TEXT NOT NULL,
  importance        TEXT NOT NULL DEFAULT 'medium',
  confidence        REAL NOT NULL DEFAULT 1.0,
  observation_count INTEGER NOT NULL DEFAULT 1,
  status            TEXT NOT NULL DEFAULT 'promoted',
  source_type       TEXT NOT NULL DEFAULT 'agent',
  source_id         TEXT,
  source_session_id TEXT,
  source_pack_key   TEXT,
  source_run_id     TEXT,
  file_scope_pattern TEXT,
  agent_id          TEXT,
  pinned            INTEGER NOT NULL DEFAULT 0,
  composite_score   REAL NOT NULL DEFAULT 0,
  write_gate_reason TEXT,
  dedupe_key        TEXT NOT NULL DEFAULT '',
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  last_accessed_at  TEXT NOT NULL,
  access_count      INTEGER NOT NULL DEFAULT 0,
  promoted_at       TEXT
);
```

Canonical durable memory store for project-, mission-, and agent-scoped memories. Current retrieval is lexical/composite over `unified_memories`; vector/embedding retrieval is not active in this branch.

#### Unified Memory Embeddings (reserved/future)

```sql
CREATE TABLE IF NOT EXISTS unified_memory_embeddings (
  id              TEXT PRIMARY KEY,
  memory_id       TEXT NOT NULL,
  project_id      TEXT NOT NULL,
  embedding_model TEXT NOT NULL,
  embedding_blob  BLOB NOT NULL,
  dimensions      INTEGER NOT NULL,
  norm            REAL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
```

Reserved for future embedding-backed retrieval. The table exists in the schema, but current retrieval does not use it.

#### Legacy Memories (migration/backfill compatibility)

```sql
CREATE TABLE IF NOT EXISTS memories (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL,
  scope             TEXT NOT NULL,
  category          TEXT NOT NULL,
  content           TEXT NOT NULL,
  importance        TEXT DEFAULT 'medium',
  source_session_id TEXT,
  source_pack_key   TEXT,
  created_at        TEXT NOT NULL,
  last_accessed_at  TEXT NOT NULL,
  access_count      INTEGER DEFAULT 0,
  -- Current memory lifecycle columns:
  status            TEXT DEFAULT 'promoted',     -- 'candidate' | 'promoted' | 'archived'
  agent_id          TEXT,                        -- originating agent identity
  confidence        REAL DEFAULT 1.0,            -- 0.0-1.0 confidence score
  promoted_at       TEXT,                        -- timestamp when promoted from candidate
  source_run_id     TEXT                         -- orchestrator run that created this memory
);
CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id);
CREATE INDEX IF NOT EXISTS idx_memories_project_status ON memories(project_id, status);
```

Retained for safe backfill into `unified_memories`. New runtime reads and writes should be described in terms of unified memory, not this legacy table.

#### Agent Identities (Schema Placeholder)

```sql
CREATE TABLE IF NOT EXISTS agent_identities (
  id                     TEXT PRIMARY KEY,
  project_id             TEXT NOT NULL,
  name                   TEXT NOT NULL,           -- "Developer Agent", "Testing Agent"
  profile_json           TEXT NOT NULL DEFAULT '{}',  -- role, rules, capabilities
  persona_json           TEXT NOT NULL DEFAULT '{}',  -- communication style, preferences
  tool_policy_json       TEXT NOT NULL DEFAULT '{}',  -- allowed/denied tools, permission level
  user_preferences_json  TEXT NOT NULL DEFAULT '{}',  -- per-agent user preferences
  heartbeat_json         TEXT,                    -- last activity, health, resource usage
  model_preference       TEXT,                    -- preferred model ID
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_identities_project ON agent_identities(project_id);
```

Identity and policy store for agent definitions. Supports runtime profile reconstruction (identity, tool policy, user preferences, heartbeat) and agent-bound memory scoping.

#### Orchestrator Shared Facts

```sql
CREATE TABLE IF NOT EXISTS orchestrator_shared_facts (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL,
  step_id     TEXT,
  fact_type   TEXT NOT NULL,              -- 'discovery' | 'decision' | 'blocker' | 'dependency'
  content     TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orchestrator_shared_facts_run ON orchestrator_shared_facts(run_id);
CREATE INDEX IF NOT EXISTS idx_orchestrator_shared_facts_run_type ON orchestrator_shared_facts(run_id, fact_type);
```

Stores facts discovered by agents during a mission run. Facts are injected into subsequent agent prompts via `buildFullPrompt()`, enabling collective knowledge sharing across agents. The pre-compaction writeback step extracts facts before context compaction to prevent knowledge loss.

#### Attempt Transcripts

```sql
CREATE TABLE IF NOT EXISTS attempt_transcripts (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL,
  attempt_id          TEXT NOT NULL,
  run_id              TEXT NOT NULL,
  step_id             TEXT NOT NULL,
  messages_json       TEXT NOT NULL,        -- JSON array of conversation messages
  token_count         INTEGER DEFAULT 0,
  compacted_at        TEXT,                 -- timestamp of last compaction
  compaction_summary  TEXT,                 -- summary generated during compaction
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempt_transcripts_attempt ON attempt_transcripts(attempt_id);
CREATE INDEX IF NOT EXISTS idx_attempt_transcripts_run ON attempt_transcripts(run_id);
```

Stores the full conversation history for each orchestrator attempt. Used by the compaction engine (records compaction events) and session resume (`resumeUnified()` loads the latest transcript to restore agent state). The `messages_json` column contains the complete message array; `compaction_summary` stores the compressed summary after compaction.

### Run Narrative Metadata

The `orchestrator_runs` table's `metadata_json` column now includes a `runNarrative` field — a rolling text summary of mission progress that is appended after each step completion via `appendRunNarrative()`. This narrative is displayed in the Activity tab's Run Narrative section.

### Updated Table Count

The schema now contains **40 tables** (up from 35) with the addition of: `memories`, `agent_identities`, `orchestrator_shared_facts`, `attempt_transcripts`, and `orchestrator_timeline_events`/`orchestrator_gate_reports` (from Phase 2 addendum).
