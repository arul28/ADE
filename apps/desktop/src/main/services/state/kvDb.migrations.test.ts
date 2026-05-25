import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { createLaneWorktreeLockService } from "../lanes/laneWorktreeLockService";
import { openKvDb } from "./kvDb";

const require = createRequire(import.meta.url);

type RawDb = {
  exec: (sql: string) => void;
  prepare: (sql: string) => { run: (...params: unknown[]) => void };
  close: () => void;
};

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as any;
}

function listColumnNames(db: Awaited<ReturnType<typeof openKvDb>>, table: string): string[] {
  const rows = db.all<{ name: string }>(`pragma table_info(${table})`);
  return rows.map((row) => String(row.name ?? "")).filter(Boolean);
}

function makeDbPath(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return path.join(root, ".ade", "kv.sqlite");
}

function expectTables(db: Awaited<ReturnType<typeof openKvDb>>, tables: readonly string[]): void {
  for (const table of tables) {
    const hit = db.get<{ name: string }>(
      "select name from sqlite_master where type = 'table' and name = ? limit 1",
      [table],
    );
    expect(hit?.name).toBe(table);
  }
}

function expectIndexes(db: Awaited<ReturnType<typeof openKvDb>>, indexes: readonly string[]): void {
  for (const indexName of indexes) {
    const hit = db.get<{ name: string }>(
      "select name from sqlite_master where type = 'index' and name = ? limit 1",
      [indexName],
    );
    expect(hit?.name).toBe(indexName);
  }
}

describe("kvDb migrations - orchestrator schema bootstrap", () => {
  it("creates Phase 1.5 context hardening tables and indexes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-kvdb-orchestrator-"));
    const dbPath = path.join(root, "ade.db");
    const db = await openKvDb(dbPath, createLogger());
    try {

    const expectedTables = [
      "orchestrator_runs",
      "orchestrator_steps",
      "orchestrator_attempts",
      "orchestrator_attempt_runtime",
      "orchestrator_runtime_events",
      "orchestrator_claims",
      "orchestrator_context_snapshots",
      "mission_step_handoffs",
      "orchestrator_timeline_events",
      "orchestrator_gate_reports",
      "orchestrator_reflections",
      "orchestrator_retrospectives",
      "orchestrator_retrospective_trends",
      "orchestrator_reflection_pattern_stats",
      "orchestrator_reflection_pattern_sources",
      "orchestrator_lane_decisions",
      "orchestrator_ai_decisions",
    ];

    expectTables(db, expectedTables);

    expect(listColumnNames(db, "orchestrator_runs")).toEqual(
      expect.arrayContaining([
        "id",
        "project_id",
        "mission_id",
        "status",
        "context_profile",
        "scheduler_state",
        "runtime_cursor_json",
        "last_error",
        "metadata_json",
        "created_at",
        "updated_at",
      ]),
    );

    expect(listColumnNames(db, "orchestrator_steps")).toEqual(
      expect.arrayContaining([
        "id",
        "run_id",
        "project_id",
        "mission_step_id",
        "step_key",
        "status",
        "join_policy",
        "dependency_step_ids_json",
        "retry_limit",
        "retry_count",
      ]),
    );

    expect(listColumnNames(db, "orchestrator_attempts")).toEqual(
      expect.arrayContaining([
        "id",
        "run_id",
        "step_id",
        "project_id",
        "attempt_number",
        "status",
        "executor_kind",
        "tracked_session_enforced",
        "context_profile",
        "context_snapshot_id",
        "error_class",
        "result_envelope_json",
      ]),
    );

    expect(listColumnNames(db, "orchestrator_attempt_runtime")).toEqual(
      expect.arrayContaining([
        "attempt_id",
        "session_id",
        "runtime_state",
        "last_signal_at",
        "last_output_preview",
        "last_preview_digest",
        "digest_since_ms",
        "repeat_count",
        "last_waiting_intervention_at_ms",
        "last_event_heartbeat_at_ms",
        "last_waiting_notified_at_ms",
        "updated_at",
      ]),
    );

    expect(listColumnNames(db, "orchestrator_runtime_events")).toEqual(
      expect.arrayContaining([
        "id",
        "project_id",
        "run_id",
        "step_id",
        "attempt_id",
        "session_id",
        "event_type",
        "event_key",
        "occurred_at",
        "payload_json",
        "created_at",
      ]),
    );

    expect(listColumnNames(db, "orchestrator_claims")).toEqual(
      expect.arrayContaining([
        "id",
        "project_id",
        "run_id",
        "step_id",
        "attempt_id",
        "owner_id",
        "scope_kind",
        "scope_value",
        "state",
        "heartbeat_at",
        "expires_at",
        "policy_json",
      ]),
    );

    expect(listColumnNames(db, "orchestrator_context_snapshots")).toEqual(
      expect.arrayContaining([
        "id",
        "project_id",
        "run_id",
        "step_id",
        "attempt_id",
        "snapshot_type",
        "context_profile",
        "cursor_json",
        "created_at",
      ]),
    );

    expect(listColumnNames(db, "mission_step_handoffs")).toEqual(
      expect.arrayContaining([
        "id",
        "project_id",
        "mission_id",
        "mission_step_id",
        "run_id",
        "step_id",
        "attempt_id",
        "handoff_type",
        "producer",
        "payload_json",
        "created_at",
      ]),
    );

    expect(listColumnNames(db, "orchestrator_timeline_events")).toEqual(
      expect.arrayContaining([
        "id",
        "project_id",
        "run_id",
        "step_id",
        "attempt_id",
        "claim_id",
        "event_type",
        "reason",
        "detail_json",
        "created_at",
      ]),
    );

    expect(listColumnNames(db, "orchestrator_gate_reports")).toEqual(
      expect.arrayContaining(["id", "project_id", "generated_at", "report_json"]),
    );

    expect(listColumnNames(db, "orchestrator_reflections")).toEqual(
      expect.arrayContaining([
        "id",
        "project_id",
        "mission_id",
        "run_id",
        "agent_role",
        "phase",
        "signal_type",
        "observation",
        "recommendation",
        "context",
        "occurred_at",
        "created_at",
        "schema_version",
      ]),
    );

    expect(listColumnNames(db, "orchestrator_retrospectives")).toEqual(
      expect.arrayContaining([
        "id",
        "project_id",
        "mission_id",
        "run_id",
        "generated_at",
        "final_status",
        "payload_json",
        "schema_version",
        "created_at",
      ]),
    );

    expect(listColumnNames(db, "orchestrator_retrospective_trends")).toEqual(
      expect.arrayContaining([
        "id",
        "project_id",
        "mission_id",
        "run_id",
        "retrospective_id",
        "source_mission_id",
        "source_run_id",
        "source_retrospective_id",
        "pain_point_key",
        "pain_point_label",
        "status",
        "previous_pain_score",
        "current_pain_score",
        "created_at",
      ]),
    );

    expect(listColumnNames(db, "orchestrator_reflection_pattern_stats")).toEqual(
      expect.arrayContaining([
        "id",
        "project_id",
        "pattern_key",
        "pattern_label",
        "occurrence_count",
        "first_seen_retrospective_id",
        "first_seen_run_id",
        "last_seen_retrospective_id",
        "last_seen_run_id",
        "created_at",
        "updated_at",
      ]),
    );

    expect(listColumnNames(db, "orchestrator_reflection_pattern_sources")).toEqual(
      expect.arrayContaining([
        "id",
        "project_id",
        "pattern_stat_id",
        "retrospective_id",
        "mission_id",
        "run_id",
        "created_at",
      ]),
    );

    expect(listColumnNames(db, "orchestrator_lane_decisions")).toEqual(
      expect.arrayContaining([
        "id",
        "project_id",
        "mission_id",
        "run_id",
        "step_id",
        "step_key",
        "lane_id",
        "decision_type",
        "validator_outcome",
        "rule_hits_json",
        "rationale",
        "metadata_json",
        "created_at",
      ]),
    );

    expect(listColumnNames(db, "orchestrator_ai_decisions")).toEqual(
      expect.arrayContaining([
        "id",
        "project_id",
        "mission_id",
        "run_id",
        "step_id",
        "attempt_id",
        "call_type",
        "provider",
        "model",
        "timeout_cap_ms",
        "decision_json",
        "action_trace_json",
        "validation_json",
        "rationale",
        "fallback_used",
        "failure_reason",
        "duration_ms",
        "prompt_tokens",
        "completion_tokens",
        "created_at",
      ]),
    );

    const expectedIndexes = [
      "idx_orchestrator_runs_project_status",
      "idx_orchestrator_runs_mission",
      "idx_orchestrator_runs_project_updated",
      "idx_orchestrator_steps_run_status",
      "idx_orchestrator_steps_project_status",
      "idx_orchestrator_steps_run_order",
      "idx_orchestrator_attempts_run_status",
      "idx_orchestrator_attempts_step_status",
      "idx_orchestrator_attempts_project_created",
      "idx_orchestrator_attempt_runtime_session",
      "idx_orchestrator_attempt_runtime_updated",
      "idx_orchestrator_runtime_events_run_occurred",
      "idx_orchestrator_runtime_events_attempt_occurred",
      "idx_orchestrator_runtime_events_session_occurred",
      "idx_orchestrator_runtime_events_project_key",
      "idx_orchestrator_claims_run_state",
      "idx_orchestrator_claims_scope_state",
      "idx_orchestrator_claims_expires",
      "idx_orchestrator_claims_active_scope",
      "idx_orchestrator_context_snapshots_run_created",
      "idx_orchestrator_context_snapshots_attempt",
      "idx_mission_step_handoffs_mission_created",
      "idx_mission_step_handoffs_step_created",
      "idx_mission_step_handoffs_attempt",
      "idx_orchestrator_timeline_run_created",
      "idx_orchestrator_timeline_attempt",
      "idx_orchestrator_timeline_project_created",
      "idx_orchestrator_gate_reports_project_generated",
      "idx_orchestrator_reflections_run_occurred",
      "idx_orchestrator_reflections_mission",
      "idx_orchestrator_retrospectives_mission_generated",
      "idx_orchestrator_retrospective_trends_mission_created",
      "idx_orchestrator_retrospective_trends_run_created",
      "idx_orchestrator_reflection_pattern_stats_count",
      "idx_orchestrator_reflection_pattern_sources_pattern",
      "idx_orchestrator_reflection_pattern_sources_mission",
      "idx_orchestrator_lane_decisions_mission_created",
      "idx_orchestrator_lane_decisions_run_created",
      "idx_orchestrator_lane_decisions_step_created",
      "idx_orchestrator_lane_decisions_lane_created",
      "idx_orchestrator_ai_decisions_mission_created",
      "idx_orchestrator_ai_decisions_run_created",
      "idx_orchestrator_ai_decisions_step_created",
      "idx_orchestrator_ai_decisions_project_category_created",
      "idx_orchestrator_ai_decisions_created",
    ];

    expectIndexes(db, expectedIndexes);

    const activeScopeSql = db.get<{ sql: string | null }>(
      "select sql from sqlite_master where type = 'index' and name = 'idx_orchestrator_claims_active_scope' limit 1",
    );
    expect((activeScopeSql?.sql ?? "").toLowerCase()).toContain("where state = 'active'");
    } finally {
      db.close();
    }
  });
});

describe("kvDb migrations - lane worktree lock schema", () => {
  it("repairs legacy lock tables before lane lock upserts run", async () => {
    const dbPath = makeDbPath("ade-kvdb-lane-lock-legacy-");
    const worktreePath = path.join(path.dirname(dbPath), "worktree");
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => RawDb };
    const rawDb = new DatabaseSync(dbPath);
    rawDb.exec(`
      create table lane_worktree_locks (
        worktree_key text not null,
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
      );
    `);
    const insert = rawDb.prepare(`
      insert into lane_worktree_locks (
        worktree_key, worktree_path, lane_id, owner_kind, owner_pr_id,
        owner_session_id, owner_proposal_id, owner_label, token,
        created_at, heartbeat_at, expires_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const key = fs.realpathSync.native(worktreePath);
    const expiredAt = "2026-01-01T00:00:00.000Z";
    insert.run(key, key, "lane-old", "path_to_merge", "pr-old", null, null, "Old stale lock 1", "token-1", expiredAt, expiredAt, expiredAt);
    insert.run(key, key, "lane-old", "path_to_merge", "pr-old", null, null, "Old stale lock 2", "token-2", expiredAt, expiredAt, expiredAt);
    rawDb.close();

    const db = await openKvDb(dbPath, createLogger());
    try {
      expect(
        db.get<{ name: string }>(
          "select name from sqlite_master where type = 'index' and name = 'idx_lane_worktree_locks_worktree_key_unique' limit 1",
        )?.name,
      ).toBe("idx_lane_worktree_locks_worktree_key_unique");
      expect(db.get<{ count: number }>("select count(1) as count from lane_worktree_locks where worktree_key = ?", [key])?.count).toBe(1);

      const service = createLaneWorktreeLockService({ db, logger: createLogger() });
      const acquired = service.acquire({
        laneId: "lane-new",
        worktreePath,
        ownerKind: "path_to_merge",
        ownerPrId: "pr-new",
        ownerLabel: "Path to Merge for PR #123",
      });

      expect(acquired.token).toBeTruthy();
      expect(acquired.lock.worktreeKey).toBe(key);
      expect(acquired.lock.laneId).toBe("lane-new");
      expect(db.get<{ count: number }>("select count(1) as count from lane_worktree_locks where worktree_key = ?", [key])?.count).toBe(1);
    } finally {
      db.close();
    }
  });

  it("returns the actual number of rows released", async () => {
    const dbPath = makeDbPath("ade-kvdb-lane-lock-release-");
    const worktreePath = path.join(path.dirname(dbPath), "worktree");
    fs.mkdirSync(worktreePath, { recursive: true });

    const db = await openKvDb(dbPath, createLogger());
    try {
      const service = createLaneWorktreeLockService({ db, logger: createLogger() });
      const acquired = service.acquire({
        laneId: "lane-1",
        worktreePath,
        ownerKind: "path_to_merge",
        ownerPrId: "pr-1",
        ownerLabel: "Path to Merge for PR #1",
      });

      expect(service.release({ ownerKind: "path_to_merge", ownerPrId: "missing" })).toBe(0);
      expect(service.getActiveForLane("lane-1")).toHaveLength(1);
      expect(service.release({ token: "missing-token" })).toBe(0);
      expect(service.release({ token: acquired.token })).toBe(1);
      expect(service.release({ token: acquired.token })).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe("kvDb migrations - pipeline settings", () => {
  it("backfills legacy default-shaped PtM settings without touching customized rows", async () => {
    const dbPath = makeDbPath("ade-kvdb-pipeline-settings-legacy-");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => RawDb };
    const rawDb = new DatabaseSync(dbPath);
    rawDb.exec(`
      create table pr_pipeline_settings (
        pr_id text primary key,
        auto_merge integer not null default 0,
        merge_method text not null default 'repo_default',
        max_rounds integer not null default 5,
        on_rebase_needed text not null default 'pause',
        conflict_strategy text not null default 'pause',
        force_finalize_mode text not null default 'off',
        force_finalize_require_no_ci_failures integer not null default 1,
        early_merge_on_green integer not null default 1,
        auto_agent_provider text,
        auto_agent_model text,
        auto_agent_reasoning_effort text,
        auto_agent_permission_mode text,
        auto_agent_confidence_threshold real,
        at_cap_policy text,
        at_cap_wait_minutes integer,
        at_cap_ci_retry_max integer,
        force_merge_requires_confirmation integer,
        updated_at text not null
      );
    `);
    const insert = rawDb.prepare(`
      insert into pr_pipeline_settings (
        pr_id, auto_merge, merge_method, max_rounds, on_rebase_needed,
        conflict_strategy, force_finalize_mode, force_finalize_require_no_ci_failures,
        early_merge_on_green, at_cap_policy, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run("pr-legacy", 0, "repo_default", 5, "pause", "pause", "off", 1, 1, null, "2026-05-01T00:00:00.000Z");
    insert.run("pr-custom", 0, "squash", 5, "pause", "pause", "off", 1, 1, "stop", "2026-05-01T00:00:00.000Z");
    rawDb.close();

    const db = await openKvDb(dbPath, createLogger());
    try {
      const legacy = db.get<{
        auto_merge: number;
        force_finalize_mode: string;
        at_cap_policy: string | null;
      }>(
        "select auto_merge, force_finalize_mode, at_cap_policy from pr_pipeline_settings where pr_id = ?",
        ["pr-legacy"],
      );
      expect(legacy).toEqual({
        auto_merge: 1,
        force_finalize_mode: "conditional",
        at_cap_policy: "ci_retry_once",
      });

      const custom = db.get<{
        auto_merge: number;
        force_finalize_mode: string;
        at_cap_policy: string | null;
      }>(
        "select auto_merge, force_finalize_mode, at_cap_policy from pr_pipeline_settings where pr_id = ?",
        ["pr-custom"],
      );
      expect(custom).toEqual({
        auto_merge: 0,
        force_finalize_mode: "off",
        at_cap_policy: "stop",
      });

      db.run(
        "update pr_pipeline_settings set auto_merge = 0, force_finalize_mode = 'off', at_cap_policy = 'stop' where pr_id = ?",
        ["pr-legacy"],
      );
    } finally {
      db.close();
    }

    const reopened = await openKvDb(dbPath, createLogger());
    try {
      const legacyAfterUserOverride = reopened.get<{
        auto_merge: number;
        force_finalize_mode: string;
        at_cap_policy: string | null;
      }>(
        "select auto_merge, force_finalize_mode, at_cap_policy from pr_pipeline_settings where pr_id = ?",
        ["pr-legacy"],
      );
      expect(legacyAfterUserOverride).toEqual({
        auto_merge: 0,
        force_finalize_mode: "off",
        at_cap_policy: "stop",
      });
    } finally {
      reopened.close();
    }
  });
});

describe("kvDb migrations - mission schema", () => {
  it("creates mission tables and key indexes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-kvdb-missions-"));
    const dbPath = path.join(root, "ade.db");
    const db = await openKvDb(dbPath, createLogger());
    try {

    const expectedTables = [
      "missions",
      "mission_steps",
      "mission_events",
      "mission_artifacts",
      "mission_interventions",
    ];

    expectTables(db, expectedTables);

    expect(listColumnNames(db, "missions")).toEqual(
      expect.arrayContaining([
        "id",
        "project_id",
        "lane_id",
        "title",
        "prompt",
        "status",
        "priority",
        "execution_mode",
        "target_machine_id",
        "outcome_summary",
        "last_error",
        "metadata_json",
        "created_at",
        "updated_at",
        "started_at",
        "completed_at",
      ]),
    );

    expect(listColumnNames(db, "mission_steps")).toEqual(
      expect.arrayContaining(["mission_id", "step_index", "status", "started_at", "completed_at"]),
    );

    expect(listColumnNames(db, "lanes")).toEqual(expect.arrayContaining(["folder"]));

    expect(listColumnNames(db, "pr_groups")).toEqual(
      expect.arrayContaining(["name", "auto_rebase", "ci_gating", "target_branch"]),
    );

    expect(listColumnNames(db, "integration_proposals")).toEqual(
      expect.arrayContaining([
        "title",
        "body",
        "draft",
        "integration_lane_name",
        "status",
        "integration_lane_id",
        "preferred_integration_lane_id",
        "merge_into_head_sha",
        "resolution_state_json",
        "pairwise_results_json",
        "lane_summaries_json",
      ]),
    );

    const expectedIndexes = [
      "idx_missions_project_updated",
      "idx_mission_steps_mission_index",
      "idx_mission_events_mission_created",
      "idx_mission_artifacts_mission_created",
      "idx_mission_interventions_mission_status",
    ];

    expectIndexes(db, expectedIndexes);
    } finally {
      db.close();
    }
  });
});

describe("kvDb migrations - worker agent schema", () => {
  it("creates W2 worker tables and indexes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-kvdb-workers-"));
    const dbPath = path.join(root, "ade.db");
    const db = await openKvDb(dbPath, createLogger());
    try {

    const expectedTables = [
      "worker_agents",
      "worker_agent_revisions",
      "worker_agent_cost_events",
      "worker_agent_task_sessions",
      "worker_agent_runs",
    ];

    expectTables(db, expectedTables);

    expect(listColumnNames(db, "worker_agents")).toEqual(
      expect.arrayContaining([
        "id",
        "project_id",
        "slug",
        "name",
        "role",
        "reports_to",
        "capabilities_json",
        "status",
        "adapter_type",
        "adapter_config_json",
        "runtime_config_json",
        "budget_monthly_cents",
        "spent_monthly_cents",
        "last_heartbeat_at",
        "created_at",
        "updated_at",
        "deleted_at",
      ]),
    );

    expect(listColumnNames(db, "worker_agent_revisions")).toEqual(
      expect.arrayContaining([
        "id",
        "project_id",
        "agent_id",
        "before_json",
        "after_json",
        "changed_keys_json",
        "had_redactions",
        "actor",
        "created_at",
      ]),
    );

    expect(listColumnNames(db, "worker_agent_cost_events")).toEqual(
      expect.arrayContaining([
        "id",
        "project_id",
        "agent_id",
        "run_id",
        "session_id",
        "provider",
        "model_id",
        "input_tokens",
        "output_tokens",
        "cost_cents",
        "estimated",
        "source",
        "occurred_at",
        "created_at",
      ]),
    );

    expect(listColumnNames(db, "worker_agent_task_sessions")).toEqual(
      expect.arrayContaining([
        "id",
        "project_id",
        "agent_id",
        "adapter_type",
        "task_key",
        "payload_json",
        "cleared_at",
        "created_at",
        "updated_at",
      ]),
    );

    expect(listColumnNames(db, "worker_agent_runs")).toEqual(
      expect.arrayContaining([
        "id",
        "project_id",
        "agent_id",
        "status",
        "wakeup_reason",
        "task_key",
        "issue_key",
        "execution_run_id",
        "execution_locked_at",
        "context_json",
        "result_json",
        "error_message",
        "started_at",
        "finished_at",
        "created_at",
        "updated_at",
      ]),
    );

    const expectedIndexes = [
      "idx_worker_agents_project",
      "idx_worker_agents_project_active",
      "idx_worker_agent_revisions_agent",
      "idx_worker_agent_task_sessions_lookup",
      "idx_worker_agent_runs_agent",
      "idx_worker_agent_runs_status",
      "idx_worker_agent_cost_events_agent",
      "idx_worker_agent_cost_events_month",
    ];

    expectIndexes(db, expectedIndexes);
    } finally {
      db.close();
    }
  });
});
