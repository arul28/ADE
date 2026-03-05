import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openKvDb } from "./kvDb";

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {}
  } as any;
}

function listColumnNames(db: Awaited<ReturnType<typeof openKvDb>>, table: string): string[] {
  const rows = db.all<{ name: string }>(`pragma table_info(${table})`);
  return rows.map((row) => String(row.name ?? "")).filter(Boolean);
}

describe("kvDb orchestrator schema bootstrap", () => {
  it("creates Phase 1.5 context hardening tables and indexes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-kvdb-orchestrator-"));
    const dbPath = path.join(root, "ade.db");
    const db = await openKvDb(dbPath, createLogger());

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
      "orchestrator_ai_decisions"
    ];

    for (const table of expectedTables) {
      const hit = db.get<{ name: string }>(
        "select name from sqlite_master where type = 'table' and name = ? limit 1",
        [table]
      );
      expect(hit?.name).toBe(table);
    }

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
        "updated_at"
      ])
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
        "retry_count"
      ])
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
        "result_envelope_json"
      ])
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
        "updated_at"
      ])
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
        "created_at"
      ])
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
        "policy_json"
      ])
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
        "created_at"
      ])
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
        "created_at"
      ])
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
        "created_at"
      ])
    );

    expect(listColumnNames(db, "orchestrator_gate_reports")).toEqual(
      expect.arrayContaining([
        "id",
        "project_id",
        "generated_at",
        "report_json"
      ])
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
        "schema_version"
      ])
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
        "created_at"
      ])
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
        "created_at"
      ])
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
        "promoted_memory_id",
        "created_at",
        "updated_at"
      ])
    );

    expect(listColumnNames(db, "orchestrator_reflection_pattern_sources")).toEqual(
      expect.arrayContaining([
        "id",
        "project_id",
        "pattern_stat_id",
        "retrospective_id",
        "mission_id",
        "run_id",
        "created_at"
      ])
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
        "created_at"
      ])
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
        "created_at"
      ])
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
      "idx_orchestrator_ai_decisions_created"
    ];

    for (const indexName of expectedIndexes) {
      const hit = db.get<{ name: string }>(
        "select name from sqlite_master where type = 'index' and name = ? limit 1",
        [indexName]
      );
      expect(hit?.name).toBe(indexName);
    }

    const activeScopeSql = db.get<{ sql: string | null }>(
      "select sql from sqlite_master where type = 'index' and name = 'idx_orchestrator_claims_active_scope' limit 1"
    );
    expect((activeScopeSql?.sql ?? "").toLowerCase()).toContain("where state = 'active'");

    db.close();
  });
});
