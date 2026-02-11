# Data Model (Local)

Last updated: 2026-02-11

ADE needs a local database (SQLite recommended) to persist project and lane metadata, session history, process config snapshots, and operation timeline.

## 1. Goals

- Recover state after app restart.
- Keep derived status computed from git/processes, not stored redundantly.
- Provide stable IDs for packs, sessions, process runs, and operations.

## 2. Core Tables (MVP)

### projects

- `id` (uuid)
- `root_path` (string)
- `display_name` (string)
- `default_base_ref` (string)
- `created_at`, `last_opened_at`

### lanes

- `id` (uuid)
- `project_id` (fk)
- `name`, `description`
- `base_ref` (string) (for example `refs/heads/main`)
- `branch_ref` (string)
- `worktree_path` (string)
- `status` (enum: active|ready|merged|archived)
- `created_at`, `archived_at`

### stacks (optional for MVP; can be inferred)

- `child_lane_id` (fk)
- `parent_lane_id` (fk)

### terminal_sessions

- `id` (uuid)
- `lane_id` (fk)
- `pty_id` (nullable)
- `title`
- `started_at`, `ended_at`
- `head_sha_start`, `head_sha_end`
- `transcript_path` (local file path)
- `exit_code` (int, nullable)
- `status` (running|completed|failed|disposed)
- `last_output_preview`

## 3. Process/Test Tables (Phase 2)

### process_definitions

Resolved effective process definitions from config.

- `id` (uuid)
- `project_id` (fk)
- `key` (stable process id from config, unique per project)
- `name`
- `command_json` (argv array)
- `cwd`
- `env_json`
- `autostart` (bool)
- `restart_policy` (`never|on_crash`)
- `graceful_shutdown_ms` (int)
- `depends_on_json` (array of process keys)
- `readiness_json`
- `updated_at`

### process_runtime

Current runtime cache for fast UI rendering after restart.

- `project_id` (fk)
- `process_key` (fk-like)
- `status` (`stopped|starting|running|degraded|stopping|exited|crashed`)
- `pid` (nullable)
- `started_at` (nullable)
- `ended_at` (nullable)
- `exit_code` (nullable)
- `readiness` (`unknown|ready|not_ready`)
- `updated_at`

### process_runs

Historical process lifecycles.

- `id` (uuid)
- `project_id` (fk)
- `process_key`
- `started_at`, `ended_at`
- `exit_code` (nullable)
- `termination_reason` (`stopped|killed|crashed|restart`)
- `log_path`

### stack_buttons

Named process subsets for Home tab buttons.

- `id` (uuid)
- `project_id` (fk)
- `key` (stable stack id, unique per project)
- `name`
- `process_keys_json`
- `start_order` (`parallel|dependency`)
- `updated_at`

### test_suites

- `id` (uuid)
- `project_id` (fk)
- `key` (stable suite id, unique per project)
- `name`
- `command_json`
- `cwd`
- `env_json`
- `timeout_ms` (nullable)
- `tags_json`
- `updated_at`

### test_runs

- `id` (uuid)
- `project_id` (fk)
- `lane_id` (nullable; phase 2 usually null/global)
- `suite_key`
- `started_at`, `ended_at`
- `status` (`running|passed|failed|canceled|timed_out`)
- `exit_code` (nullable)
- `duration_ms`
- `summary_json` (optional parsed metadata)
- `log_path`

## 4. Operations Table (Undo Timeline)

### operations

- `id` (uuid)
- `lane_id` (fk, nullable for project-global actions)
- `kind` (`sync|rebase|merge|apply_patch|restack|push|pr_create|pr_update|process_start|process_stop|test_run|...`)
- `started_at`, `ended_at`
- `status` (`running|succeeded|failed|canceled`)
- `pre_head_sha`, `post_head_sha` (nullable)
- `metadata_json` (conflict files, test run id, stack button id, etc.)

## 5. Pack Index

### packs_index

Stores latest pack artifact paths and last computed SHAs.

- `lane_id` (fk, nullable for project pack)
- `project_id` (fk)
- `project_pack_path`
- `lane_pack_path`
- `last_pack_head_sha`
- `updated_at`

## 6. Pack Storage (Files)

Packs should be stored as markdown files on disk (not blobs in SQLite):

- `.ade/packs/project_pack.md` (local-only by default)
- `.ade/packs/lanes/<laneId>/lane_pack.md`
- `.ade/packs/conflicts/<operationId>/conflict_pack.md`

The DB stores pointers/metadata.
