import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openKvDb } from "../state/kvDb";
import { createMissionService } from "./missionService";

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {}
  } as any;
}

async function createDbWithProjectAndLane() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-mission-service-"));
  const dbPath = path.join(root, "ade.db");
  const db = await openKvDb(dbPath, createLogger());

  const projectId = "proj-1";
  const laneId = "lane-1";
  const now = "2026-02-18T00:00:00.000Z";

  db.run(
    `
      insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at)
      values (?, ?, ?, ?, ?, ?)
    `,
    [projectId, root, "ADE", "main", now, now]
  );

  db.run(
    `
      insert into lanes(
        id,
        project_id,
        name,
        description,
        lane_type,
        base_ref,
        branch_ref,
        worktree_path,
        attached_root_path,
        is_edit_protected,
        parent_lane_id,
        color,
        icon,
        tags_json,
        status,
        created_at,
        archived_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      laneId,
      projectId,
      "Lane 1",
      null,
      "worktree",
      "main",
      "feature/lane-1",
      root,
      null,
      0,
      null,
      null,
      null,
      null,
      "active",
      now,
      null
    ]
  );

  return {
    db,
    projectId,
    laneId,
    dispose: () => db.close()
  };
}

describe("missionService lifecycle", () => {
  it("supports valid mission lifecycle transitions", async () => {
    const { db, projectId, laneId, dispose } = await createDbWithProjectAndLane();
    const service = createMissionService({ db, projectId });

    const created = service.create({
      prompt: "Implement profile tab improvements and prepare PR summary.",
      laneId
    });

    expect(created.status).toBe("queued");
    expect(created.steps.length).toBeGreaterThan(0);

    const started = service.update({ missionId: created.id, status: "in_progress" });
    expect(started.status).toBe("in_progress");

    const intervention = service.addIntervention({
      missionId: created.id,
      interventionType: "manual_input",
      title: "Need design confirmation",
      body: "Confirm whether we should preserve the old spacing scale."
    });

    expect(intervention.status).toBe("open");

    const paused = service.get(created.id);
    expect(paused?.status).toBe("intervention_required");
    expect(paused?.openInterventions).toBe(1);

    service.resolveIntervention({
      missionId: created.id,
      interventionId: intervention.id,
      status: "resolved",
      note: "Proceed with the new spacing scale."
    });

    const resumed = service.get(created.id);
    expect(resumed?.status).toBe("in_progress");
    expect(resumed?.openInterventions).toBe(0);

    const completed = service.update({
      missionId: created.id,
      status: "completed",
      outcomeSummary: "Updated profile layout and linked PR #123."
    });

    expect(completed.status).toBe("completed");
    expect(completed.outcomeSummary).toContain("PR #123");
    expect(completed.artifacts.some((artifact) => artifact.artifactType === "summary")).toBe(true);

    dispose();
  });

  it("creates deterministic planner steps with dependencies and completion criteria", async () => {
    const { db, projectId, laneId, dispose } = await createDbWithProjectAndLane();
    const service = createMissionService({ db, projectId });

    const created = service.create({
      prompt: [
        "Implement auth orchestration end-to-end:",
        "1. refactor token middleware",
        "2. add route guards",
        "3. run tests and summarize outcome"
      ].join("\n"),
      laneId
    });

    expect(created.steps.length).toBeGreaterThanOrEqual(4);
    expect(created.steps.some((step) => step.kind === "integration")).toBe(true);
    expect(
      created.steps.every(
        (step) => typeof step.metadata?.doneCriteria === "string" && String(step.metadata?.doneCriteria).trim().length > 0
      )
    ).toBe(true);
    expect(
      created.steps.some(
        (step) => Array.isArray(step.metadata?.dependencyIndices) && (step.metadata?.dependencyIndices as unknown[]).length > 0
      )
    ).toBe(true);

    dispose();
  });

  it("rejects invalid mission and step transitions", async () => {
    const { db, projectId, laneId, dispose } = await createDbWithProjectAndLane();
    const service = createMissionService({ db, projectId });

    const created = service.create({
      prompt: "Write migration notes and close release lane.",
      laneId
    });

    expect(() => service.update({ missionId: created.id, status: "completed" })).toThrow(/Invalid mission transition/i);

    const firstStep = service.get(created.id)?.steps[0];
    expect(firstStep).toBeTruthy();
    if (!firstStep) {
      dispose();
      throw new Error("Expected first step");
    }

    expect(() =>
      service.updateStep({
        missionId: created.id,
        stepId: firstStep.id,
        status: "succeeded"
      })
    ).toThrow(/Invalid mission step transition/i);

    dispose();
  });

  it("creates intervention-required status when a running step fails", async () => {
    const { db, projectId, laneId, dispose } = await createDbWithProjectAndLane();
    const service = createMissionService({ db, projectId });

    const created = service.create({
      prompt: "Refactor auth checks and run regression tests.",
      laneId
    });

    service.update({ missionId: created.id, status: "in_progress" });

    const firstStep = service.get(created.id)?.steps[0];
    expect(firstStep).toBeTruthy();
    if (!firstStep) {
      dispose();
      throw new Error("Expected first step");
    }

    service.updateStep({
      missionId: created.id,
      stepId: firstStep.id,
      status: "running"
    });

    service.updateStep({
      missionId: created.id,
      stepId: firstStep.id,
      status: "failed",
      note: "Unit tests failed in CI parity suite."
    });

    const detail = service.get(created.id);
    expect(detail?.status).toBe("intervention_required");
    expect(detail?.openInterventions).toBeGreaterThan(0);
    expect(detail?.lastError).toContain("Unit tests failed");

    dispose();
  });

  it("deletes mission records and orchestrator runtime dependents", async () => {
    const { db, projectId, laneId, dispose } = await createDbWithProjectAndLane();
    const service = createMissionService({ db, projectId });
    const created = service.create({
      prompt: "Ship auth hardening changes and open PR.",
      laneId
    });
    const firstStep = created.steps[0];
    if (!firstStep) {
      dispose();
      throw new Error("Expected mission step");
    }

    const now = "2026-02-19T00:00:00.000Z";
    const runId = randomUUID();
    const orchestratorStepId = randomUUID();
    const snapshotId = randomUUID();
    const attemptId = randomUUID();
    const claimId = randomUUID();

    db.run(
      `
        insert into orchestrator_runs(
          id,
          project_id,
          mission_id,
          status,
          context_profile,
          scheduler_state,
          runtime_cursor_json,
          last_error,
          metadata_json,
          created_at,
          updated_at,
          started_at,
          completed_at
        ) values (?, ?, ?, 'running', 'orchestrator_deterministic_v1', 'manual', null, null, null, ?, ?, ?, null)
      `,
      [runId, projectId, created.id, now, now, now]
    );
    db.run(
      `
        insert into orchestrator_steps(
          id,
          run_id,
          project_id,
          mission_step_id,
          step_key,
          step_index,
          title,
          lane_id,
          status,
          join_policy,
          quorum_count,
          dependency_step_ids_json,
          retry_limit,
          retry_count,
          last_attempt_id,
          policy_json,
          metadata_json,
          created_at,
          updated_at,
          started_at,
          completed_at
        ) values (?, ?, ?, ?, 'mission_step_0_0', 0, 'Review objective', ?, 'running', 'all_success', null, '[]', 1, 0, null, null, null, ?, ?, ?, null)
      `,
      [orchestratorStepId, runId, projectId, firstStep.id, laneId, now, now, now]
    );
    db.run(
      `
        insert into orchestrator_context_snapshots(
          id,
          project_id,
          run_id,
          step_id,
          attempt_id,
          snapshot_type,
          context_profile,
          cursor_json,
          created_at
        ) values (?, ?, ?, ?, null, 'attempt', 'orchestrator_deterministic_v1', '{"docs":[]}', ?)
      `,
      [snapshotId, projectId, runId, orchestratorStepId, now]
    );
    db.run(
      `
        insert into orchestrator_attempts(
          id,
          run_id,
          step_id,
          project_id,
          attempt_number,
          status,
          executor_kind,
          executor_session_id,
          tracked_session_enforced,
          context_profile,
          context_snapshot_id,
          error_class,
          error_message,
          retry_backoff_ms,
          result_envelope_json,
          metadata_json,
          created_at,
          started_at,
          completed_at
        ) values (?, ?, ?, ?, 1, 'running', 'manual', null, 1, 'orchestrator_deterministic_v1', ?, 'none', null, 0, null, null, ?, ?, null)
      `,
      [attemptId, runId, orchestratorStepId, projectId, snapshotId, now, now]
    );
    db.run(
      `
        insert into orchestrator_claims(
          id,
          project_id,
          run_id,
          step_id,
          attempt_id,
          owner_id,
          scope_kind,
          scope_value,
          state,
          acquired_at,
          heartbeat_at,
          expires_at,
          released_at,
          policy_json,
          metadata_json
        ) values (?, ?, ?, ?, ?, 'owner', 'lane', ?, 'active', ?, ?, ?, null, '{"ttlMs":45000}', null)
      `,
      [claimId, projectId, runId, orchestratorStepId, attemptId, laneId, now, now, "2026-02-19T00:10:00.000Z"]
    );
    db.run(
      `
        insert into mission_step_handoffs(
          id,
          project_id,
          mission_id,
          mission_step_id,
          run_id,
          step_id,
          attempt_id,
          handoff_type,
          producer,
          payload_json,
          created_at
        ) values (?, ?, ?, ?, ?, ?, ?, 'attempt_started', 'orchestrator', '{}', ?)
      `,
      [randomUUID(), projectId, created.id, firstStep.id, runId, orchestratorStepId, attemptId, now]
    );
    db.run(
      `
        insert into orchestrator_timeline_events(
          id,
          project_id,
          run_id,
          step_id,
          attempt_id,
          claim_id,
          event_type,
          reason,
          detail_json,
          created_at
        ) values (?, ?, ?, ?, ?, ?, 'attempt_started', 'test', null, ?)
      `,
      [randomUUID(), projectId, runId, orchestratorStepId, attemptId, claimId, now]
    );

    service.delete({ missionId: created.id });

    const mission = service.get(created.id);
    expect(mission).toBeNull();
    expect(db.get<{ count: number }>("select count(*) as count from orchestrator_runs where mission_id = ?", [created.id])?.count ?? 0).toBe(0);
    expect(db.get<{ count: number }>("select count(*) as count from mission_steps where mission_id = ?", [created.id])?.count ?? 0).toBe(0);
    expect(
      db.get<{ count: number }>("select count(*) as count from mission_step_handoffs where mission_id = ?", [created.id])?.count ?? 0
    ).toBe(0);
    expect(
      db.get<{ count: number }>("select count(*) as count from orchestrator_timeline_events where run_id = ?", [runId])?.count ?? 0
    ).toBe(0);

    dispose();
  });

  it("lists planner runs and resolves planner attempts from mission events", async () => {
    const { db, projectId, laneId, dispose } = await createDbWithProjectAndLane();
    const service = createMissionService({ db, projectId });

    const created = service.create({
      prompt: "Ship a deterministic planner run.",
      laneId,
      plannerRun: {
        id: "planner-run-1",
        missionId: "",
        requestedEngine: "auto",
        resolvedEngine: "claude_cli",
        status: "succeeded",
        degraded: false,
        reasonCode: null,
        reasonDetail: null,
        planHash: "hash-raw",
        normalizedPlanHash: "hash-normalized",
        commandPreview: "claude -p ...",
        rawResponse: "{\"schemaVersion\":\"1.0\"}",
        createdAt: "2026-02-19T00:00:00.000Z",
        durationMs: 1200,
        validationErrors: [],
        attempts: [
          {
            id: "planner-attempt-1",
            engine: "claude_cli",
            status: "succeeded",
            reasonCode: null,
            detail: null,
            commandPreview: "claude -p ...",
            rawResponse: "{\"schemaVersion\":\"1.0\"}",
            validationErrors: [],
            createdAt: "2026-02-19T00:00:00.000Z"
          }
        ]
      },
      plannerPlan: {
        schemaVersion: "1.0",
        missionSummary: {
          title: "Ship a deterministic planner run.",
          objective: "Ship a deterministic planner run.",
          domain: "mixed",
          complexity: "low",
          strategy: "sequential",
          parallelismCap: 1
        },
        assumptions: [],
        risks: [],
        steps: [],
        handoffPolicy: {
          externalConflictDefault: "intervention"
        }
      }
    });

    const runs = service.listPlannerRuns({ missionId: created.id, limit: 10 });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe("planner-run-1");
    expect(runs[0]?.attempts).toHaveLength(1);

    const attempt = service.getPlannerAttempt({
      plannerRunId: "planner-run-1",
      attemptId: "planner-attempt-1"
    });
    expect(attempt?.id).toBe("planner-attempt-1");
    expect(attempt?.engine).toBe("claude_cli");

    dispose();
  });
});
