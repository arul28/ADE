# Data Model (Local)

Last updated: 2026-02-10

ADE needs a local database (SQLite recommended) to persist project and lane metadata, session history, process configs, and operation timeline.

## 1. Goals

- Recover state after app restart.
- Keep derived status computed from git/processes, not stored redundantly.
- Provide stable IDs for packs, sessions, and operations.

## 2. Minimal Tables (Sketch)

### projects

- `id` (uuid)
- `root_path` (string)
- `created_at`, `last_opened_at`
- `default_base_ref` (string)

### lanes

- `id` (uuid)
- `project_id` (fk)
- `name`, `description`
- `base_ref` (string) (e.g., `refs/heads/main` or parent lane ref)
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
- `title`
- `started_at`, `ended_at`
- `head_sha_start`, `head_sha_end`
- `transcript_path` (local file path)
- `exit_code` (int, nullable)

### processes

- `id` (uuid)
- `project_id` (fk)
- `name`
- `command_json` (argv array)
- `cwd_template`
- `env_json`

### test_runs

- `id` (uuid)
- `lane_id` (nullable; some tests may be global)
- `suite_id` (string)
- `started_at`, `ended_at`
- `exit_code`
- `summary_path` (local)

### operations (undo timeline)

- `id` (uuid)
- `lane_id` (fk)
- `kind` (sync|rebase|merge|apply_patch|restack|push|pr_create|pr_update|...)
- `started_at`, `ended_at`
- `status` (running|succeeded|failed|canceled)
- `pre_head_sha`, `post_head_sha`
- `metadata_json` (conflict files, test suite run, etc.)

### packs_index

Stores the latest pack artifact paths and last computed SHAs.

- `lane_id` (fk, nullable for project pack)
- `project_id` (fk)
- `project_pack_path`
- `lane_pack_path`
- `last_pack_head_sha`
- `updated_at`

## 3. Pack Storage (Files)

Packs should be stored as markdown files on disk (not blobs in SQLite):

- `.ade/packs/project_pack.md` (local-only by default)
- `.ade/packs/lanes/<laneId>/lane_pack.md`
- `.ade/packs/conflicts/<operationId>/conflict_pack.md`

The DB stores only pointers/metadata.

