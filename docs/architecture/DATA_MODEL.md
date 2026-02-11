# Data Model (Local)

Last updated: 2026-02-11

ADE uses a local database (SQLite recommended) plus filesystem artifacts to persist project/lane state, complete execution history, and pack versions.

This target model is for comprehensive packs with append-only history.

## 1. Goals

- Recover state after app restart.
- Keep derived status computed from git/processes, not stored redundantly.
- Preserve immutable history for checkpoints, plan revisions, and pack versions.
- Provide stable IDs for packs, sessions, process runs, operations, and history artifacts.

## 2. Core Tables

### projects

- `id` (uuid)
- `root_path` (string)
- `display_name` (string)
- `default_base_ref` (string)
- `created_at`, `last_opened_at`

### workspaces

Physical directories ADE can operate in.

- `id` (uuid)
- `project_id` (fk)
- `kind` (`primary|worktree|attached`)
- `root_path` (string)
- `git_dir_path` (string)
- `is_primary` (bool)
- `is_stale` (bool)
- `metadata_json`
- `created_at`, `updated_at`

### lanes

- `id` (uuid)
- `project_id` (fk)
- `workspace_id` (fk)
- `name`, `description`
- `lane_type` (`primary|worktree|attached`)
- `base_ref` (string)
- `branch_ref` (string) (active branch for lane workspace)
- `worktree_path` (string) (denormalized from workspace for convenience)
- `branch_protection_mode` (`none|warn|block`)
- `profile_id` (fk, nullable)
- `status` (enum: active|ready|merged|archived)
- `created_at`, `archived_at`

### stacks

- `child_lane_id` (fk)
- `parent_lane_id` (fk)

### lane_profiles

Reusable lane creation templates.

- `id` (uuid)
- `project_id` (fk)
- `name`
- `bootstrap_commands_json`
- `default_tool_type`
- `default_goal_template`
- `settings_json`
- `created_at`, `updated_at`

### lane_overlay_policies

Explicit allowlist for copying/symlinking local-only files to lanes.

- `id` (uuid)
- `project_id` (fk)
- `name`
- `mode` (`copy|symlink|mixed`)
- `items_json` (allowlist glob/path entries)
- `created_at`, `updated_at`

### lane_overlay_applies

Audit trail for overlay applications.

- `id` (uuid)
- `project_id` (fk)
- `lane_id` (fk)
- `policy_id` (fk)
- `applied_at`
- `result_json`

### terminal_sessions

- `id` (uuid)
- `project_id` (fk)
- `lane_id` (fk)
- `pty_id` (nullable)
- `title`
- `goal` (nullable)
- `tool_type` (codex|claude|gemini|custom|unknown)
- `started_at`, `ended_at`
- `head_sha_start`, `head_sha_end`
- `transcript_path` (local file path)
- `exit_code` (int, nullable)
- `status` (running|completed|failed|disposed)
- `last_output_preview`

## 3. Process/Test Tables

### process_definitions

- `id` (uuid)
- `project_id` (fk)
- `key` (stable process id)
- `name`
- `command_json`
- `cwd`
- `env_json`
- `autostart`
- `restart_policy`
- `graceful_shutdown_ms`
- `depends_on_json`
- `readiness_json`
- `updated_at`

### process_runtime

- `project_id` (fk)
- `process_key`
- `status`
- `pid` (nullable)
- `started_at` (nullable)
- `ended_at` (nullable)
- `exit_code` (nullable)
- `readiness`
- `updated_at`

### process_runs

- `id` (uuid)
- `project_id` (fk)
- `process_key`
- `started_at`, `ended_at`
- `exit_code` (nullable)
- `termination_reason`
- `log_path`

### stack_buttons

- `id` (uuid)
- `project_id` (fk)
- `key`
- `name`
- `process_keys_json`
- `start_order`
- `updated_at`

### test_suites

- `id` (uuid)
- `project_id` (fk)
- `key`
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
- `lane_id` (nullable)
- `suite_key`
- `started_at`, `ended_at`
- `status` (running|passed|failed|canceled|timed_out)
- `exit_code` (nullable)
- `duration_ms`
- `summary_json` (nullable)
- `log_path`

## 4. Operations Table (Undo Timeline)

### operations

- `id` (uuid)
- `project_id` (fk)
- `lane_id` (fk, nullable)
- `kind` (`sync|rebase|merge|merge_simulation|apply_patch|restack|push|pr_create|pr_update|branch_switch|process_start|process_stop|test_run|pack_update|...`)
- `started_at`, `ended_at`
- `status` (`running|succeeded|failed|canceled`)
- `pre_head_sha`, `post_head_sha` (nullable)
- `metadata_json`

## 5. Checkpoint and History Tables

### session_checkpoints

Immutable checkpoint objects built from sessions/commit boundaries.

- `id` (uuid)
- `project_id` (fk)
- `lane_id` (fk, nullable)
- `session_id` (fk, nullable)
- `feature_key` (nullable)
- `issue_key` (nullable)
- `checkpoint_type` (`session_end|commit|manual|replan`)
- `created_at`
- `head_sha_start`, `head_sha_end` (nullable)
- `commit_sha` (nullable)
- `files_changed`
- `insertions`
- `deletions`
- `touched_files_json`
- `failure_lines_json`
- `commands_summary_json` (nullable)
- `tool_summary_json` (nullable)
- `token_usage_json` (nullable)
- `transcript_path` (nullable)
- `transcript_hash` (nullable)
- `metadata_json`

### checkpoint_links

Links checkpoints to external/internal entities.

- `checkpoint_id` (fk)
- `link_type` (`issue|pr|operation|artifact|commit|parent_checkpoint`)
- `link_value`

### pack_events

Append-only event log for all context/pack lifecycle activity.

- `id` (uuid)
- `project_id` (fk)
- `lane_id` (fk, nullable)
- `feature_key` (nullable)
- `pack_key` (nullable)
- `event_type`
- `event_ts`
- `checkpoint_id` (fk, nullable)
- `pack_version_id` (fk, nullable)
- `plan_version_id` (fk, nullable)
- `operation_id` (fk, nullable)
- `payload_json`

### conflict_predictions

Stores latest conflict and overlap predictions for lane/base and lane/lane pairs.

- `id` (uuid)
- `project_id` (fk)
- `source_lane_id` (fk)
- `target_type` (`base|lane|branch`)
- `target_lane_id` (fk, nullable)
- `target_ref` (nullable)
- `prediction_kind` (`merge_conflict|overlap_risk|simulation`)
- `risk_score` (0-100)
- `status` (`clean|auto_merge|conflicts|unknown`)
- `files_json`
- `details_json`
- `computed_at`

## 6. Pack Version Tables

### pack_versions

Immutable rendered pack versions.

- `id` (uuid)
- `project_id` (fk)
- `lane_id` (fk, nullable)
- `feature_key` (nullable)
- `pack_key` (for example `project`, `lane:<laneId>`, `feature:<featureKey>`)
- `pack_type` (`project|lane|feature|conflict|plan`)
- `deterministic_version_path`
- `narrative_version_path` (nullable)
- `created_at`
- `deterministic_updated_at`
- `narrative_updated_at` (nullable)
- `head_sha` (nullable)
- `source_inputs_json` (checkpoint ids, plan ids, operation ids)
- `metadata_json`

### pack_heads

Current materialized pointer per pack key.

- `pack_key` (pk)
- `project_id` (fk)
- `lane_id` (fk, nullable)
- `feature_key` (nullable)
- `pack_type`
- `active_pack_version_id` (fk)
- `latest_deterministic_version_id` (fk)
- `latest_narrative_version_id` (fk, nullable)
- `current_view_path`
- `updated_at`

## 7. Planning Version Tables

### planning_threads

- `id` (uuid)
- `project_id` (fk)
- `lane_id` (fk, nullable)
- `feature_key` (nullable)
- `issue_key` (nullable)
- `created_at`, `updated_at`

### plan_versions

Immutable plan revisions tied to planning threads.

- `id` (uuid)
- `thread_id` (fk)
- `version_number`
- `created_at`
- `created_by` (`user|agent|system`)
- `summary`
- `research_json`
- `design_choices_json`
- `phases_json`
- `tasks_json`
- `agent_prompts_json`
- `rationale_json`
- `is_active` (bool)

### plan_messages

- `id` (uuid)
- `thread_id` (fk)
- `plan_version_id` (fk, nullable)
- `role` (`user|agent|system`)
- `created_at`
- `body`

## 8. Pack Storage (Files)

Packs and history artifacts are stored as files; DB stores pointers and indexes.

- `.ade/history/checkpoints/<checkpointId>.json`
- `.ade/history/events/<YYYY-MM>.jsonl`
- `.ade/packs/versions/<packKey>/<versionId>.md`
- `.ade/packs/heads/<packKey>.json`
- `.ade/packs/current/project_pack.md`
- `.ade/packs/current/lanes/<laneId>/lane_pack.md`
- `.ade/packs/current/features/<featureKey>/feature_pack.md`
- `.ade/packs/current/conflicts/<operationId>/conflict_pack.md`
- `.ade/packs/current/plans/<planKey>/plan_pack.md`

## 9. Notes

- `pack_heads` replaces the old "latest pointer only" approach.
- `pack_versions` + `pack_events` + `session_checkpoints` form the source of truth.
- Current views under `.ade/packs/current/` are materialized caches for fast reads.
