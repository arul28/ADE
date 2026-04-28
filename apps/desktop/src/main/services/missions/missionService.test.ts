import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
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
    dbPath,
    projectId,
    laneId,
    root,
    dispose: () => db.close()
  };
}

describe("missionService lifecycle", () => {
  it("supports valid mission lifecycle transitions", async () => {
    const { db, projectId, laneId, dispose } = await createDbWithProjectAndLane();
    const service = createMissionService({ db, projectId });

    const created = service.create({
      prompt: "Implement profile tab improvements and prepare PR summary.",
      laneId,
      plannedSteps: [
        { index: 0, title: "Implement profile tab", detail: "Profile tab improvements", kind: "task", metadata: { stepType: "implementation" } },
        { index: 1, title: "Prepare PR summary", detail: "PR summary", kind: "integration", metadata: { stepType: "integration" } }
      ]
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

  it("keeps mission active for scoped manual-input interventions", async () => {
    const { db, projectId, laneId, dispose } = await createDbWithProjectAndLane();
    const service = createMissionService({ db, projectId });

    const created = service.create({
      prompt: "Coordinate workers and ask for optional user guidance when needed.",
      laneId
    });

    service.update({ missionId: created.id, status: "in_progress" });
    service.addIntervention({
      missionId: created.id,
      interventionType: "manual_input",
      title: "Clarify API naming",
      body: "Worker requested optional naming guidance.",
      pauseMission: false
    });

    const detail = service.get(created.id);
    expect(detail?.status).toBe("in_progress");
    expect(detail?.openInterventions).toBe(1);

    dispose();
  });

  it("emits the resolved intervention through the resolution hook", async () => {
    const { db, projectId, laneId, dispose } = await createDbWithProjectAndLane();
    const onInterventionResolved = vi.fn();
    const service = createMissionService({ db, projectId, onInterventionResolved });

    const created = service.create({
      prompt: "Wait for user guidance before resuming work.",
      laneId,
    });

    service.update({ missionId: created.id, status: "in_progress" });
    const intervention = service.addIntervention({
      missionId: created.id,
      interventionType: "manual_input",
      title: "Clarify rollout rule",
      body: "Do we keep the old rollout guard?",
    });

    service.resolveIntervention({
      missionId: created.id,
      interventionId: intervention.id,
      status: "resolved",
      note: "Keep the old rollout guard for now.",
    });

    expect(onInterventionResolved).toHaveBeenCalledTimes(1);
    expect(onInterventionResolved).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId: created.id,
        intervention: expect.objectContaining({
          id: intervention.id,
          status: "resolved",
          resolutionNote: "Keep the old rollout guard for now.",
        }),
      }),
    );

    dispose();
  });

  it("persists explicit planned steps with metadata", async () => {
    const { db, projectId, laneId, dispose } = await createDbWithProjectAndLane();
    const service = createMissionService({ db, projectId });

    const created = service.create({
      prompt: "Implement auth orchestration end-to-end.",
      laneId,
      plannedSteps: [
        { index: 0, title: "Refactor token middleware", detail: "Refactor", kind: "task", metadata: { stepType: "implementation", doneCriteria: "Middleware refactored" } },
        { index: 1, title: "Add route guards", detail: "Guards", kind: "task", metadata: { stepType: "implementation", doneCriteria: "Guards added", dependencyIndices: [0] } },
        { index: 2, title: "Run tests", detail: "Tests", kind: "validation", metadata: { stepType: "test", doneCriteria: "Tests pass", dependencyIndices: [0, 1] } },
        { index: 3, title: "Summarize and integrate", detail: "Integration", kind: "integration", metadata: { stepType: "integration", doneCriteria: "PR ready", dependencyIndices: [2] } }
      ]
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

  it("flushes newly created missions to disk immediately", async () => {
    const { db, dbPath, projectId, laneId, dispose } = await createDbWithProjectAndLane();
    const service = createMissionService({ db, projectId });

    const created = service.create({
      prompt: "Persist mission rows before a quick app restart.",
      laneId
    });

    const reopened = await openKvDb(dbPath, createLogger());
    const persisted = reopened.get<{ count: number }>(
      "select count(*) as count from missions where id = ? and project_id = ?",
      [created.id, projectId]
    );

    expect(Number(persisted?.count ?? 0)).toBe(1);

    reopened.close();
    dispose();
  });

  it("maps legacy plan_review lifecycle rows to in_progress in active mission listings", async () => {
    const { db, projectId, laneId, dispose } = await createDbWithProjectAndLane();
    const service = createMissionService({ db, projectId });

    const created = service.create({
      prompt: "Design orchestration plan and await approval before execution.",
      laneId
    });

    const planning = service.update({ missionId: created.id, status: "planning" });
    expect(planning.status).toBe("planning");
    const activePlanning = service.list({ status: "active" });
    expect(activePlanning.some((entry) => entry.id === created.id && entry.status === "planning")).toBe(true);

    db.run(
      "update missions set status = 'plan_review' where id = ? and project_id = ?",
      [created.id, projectId]
    );

    const detail = service.get(created.id);
    expect(detail?.status).toBe("in_progress");

    const activeReviewCompat = service.list({ status: "active" });
    expect(activeReviewCompat.some((entry) => entry.id === created.id && entry.status === "in_progress")).toBe(true);

    const running = service.update({ missionId: created.id, status: "in_progress" });
    expect(running.status).toBe("in_progress");

    dispose();
  });

  it("rejects invalid mission and step transitions", async () => {
    const { db, projectId, laneId, dispose } = await createDbWithProjectAndLane();
    const service = createMissionService({ db, projectId });

    const created = service.create({
      prompt: "Write migration notes and close release lane.",
      laneId,
      plannedSteps: [
        { index: 0, title: "Write migration notes", detail: "Notes", kind: "task", metadata: { stepType: "implementation" } }
      ]
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
      laneId,
      plannedSteps: [
        { index: 0, title: "Refactor auth checks", detail: "Auth refactor", kind: "task", metadata: { stepType: "implementation" } }
      ]
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
      laneId,
      plannedSteps: [
        { index: 0, title: "Ship auth hardening", detail: "Auth hardening", kind: "task", metadata: { stepType: "implementation" } }
      ]
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

  it("supports phase profile CRUD and import/export", async () => {
    const { db, projectId, root, dispose } = await createDbWithProjectAndLane();
    const service = createMissionService({ db, projectId, projectRoot: root });

    const seeded = service.listPhaseProfiles();
    expect(seeded.length).toBeGreaterThanOrEqual(2);
    const defaultProfile = seeded.find((profile) => profile.isDefault);
    expect(defaultProfile).toBeTruthy();

    const clone = service.clonePhaseProfile({
      profileId: defaultProfile!.id,
      name: "Security Focused"
    });
    expect(clone.isBuiltIn).toBe(false);
    expect(clone.name).toBe("Security Focused");

    const exported = service.exportPhaseProfile({ profileId: clone.id });
    expect(exported.profile.id).toBe(clone.id);
    expect(exported.savedPath).toBeTruthy();

    const imported = service.importPhaseProfile({
      filePath: exported.savedPath!,
      setAsDefault: true
    });
    expect(imported.isDefault).toBe(true);

    const proofProfile = service.savePhaseProfile({
      profile: {
        ...defaultProfile!,
        id: "proof-profile",
        name: "Proof Required",
        isDefault: false,
        phases: defaultProfile!.phases.map((phase) =>
          phase.phaseKey === "testing" || phase.phaseKey === "validation"
            ? {
                ...phase,
                validationGate: {
                  ...phase.validationGate,
                  evidenceRequirements: ["screenshot"],
                  capabilityFallback: "warn",
                },
              }
            : phase
        ),
      },
    });
    const proofPhase = proofProfile.phases.find((phase) =>
      phase.phaseKey === "testing" || phase.phaseKey === "validation"
    );
    expect(proofPhase?.validationGate.evidenceRequirements).toEqual(["screenshot"]);
    expect(proofPhase?.validationGate.capabilityFallback).toBe("warn");

    const profiles = service.listPhaseProfiles();
    const defaultCount = profiles.filter((profile) => profile.isDefault).length;
    expect(defaultCount).toBe(1);

    dispose();
  });

  it("persists mission phase configuration and annotates step metadata with phase context", async () => {
    const { db, projectId, laneId, dispose } = await createDbWithProjectAndLane();
    const service = createMissionService({ db, projectId });
    const profiles = service.listPhaseProfiles();
    const defaultProfile = profiles.find((profile) => profile.isDefault);
    expect(defaultProfile).toBeTruthy();

    const created = service.create({
      prompt: "Ship auth migration",
      laneId,
      phaseProfileId: defaultProfile!.id,
      phaseOverride: defaultProfile!.phases.map((phase, index) => ({
        ...phase,
        position: index
      }))
    });

    expect(created.phaseConfiguration).toBeTruthy();
    expect(created.phaseConfiguration?.selectedPhases.length).toBeGreaterThan(0);
    expect(
      created.steps.every((step) => typeof step.metadata?.phaseKey === "string" && String(step.metadata?.phaseKey).length > 0)
    ).toBe(true);

    const cfg = service.getPhaseConfiguration(created.id);
    expect(cfg?.override?.phases.length).toBeGreaterThan(0);
    expect(cfg?.profile?.id).toBe(defaultProfile!.id);

    dispose();
  });

  it("normalizes question and validation settings to planning-only semantics", async () => {
    const { db, projectId, laneId, dispose } = await createDbWithProjectAndLane();
    const service = createMissionService({ db, projectId });
    const profiles = service.listPhaseProfiles();
    const defaultProfile = profiles.find((profile) => profile.isDefault);
    if (!defaultProfile) throw new Error("Expected default profile");

    const created = service.create({
      prompt: "Normalize phase semantics",
      laneId,
      phaseProfileId: defaultProfile.id,
      phaseOverride: defaultProfile.phases.map((phase, index) => ({
        ...phase,
        position: index,
        askQuestions: phase.phaseKey === "development"
          ? { enabled: true, maxQuestions: 9 }
          : phase.askQuestions,
        validationGate: phase.phaseKey === "planning"
          ? { tier: "self", required: true, criteria: "Should be removed" }
          : phase.validationGate,
      })),
    });

    const planning = created.phaseConfiguration?.selectedPhases.find((phase) => phase.phaseKey === "planning");
    const development = created.phaseConfiguration?.selectedPhases.find((phase) => phase.phaseKey === "development");
    expect(planning?.validationGate.tier).toBe("none");
    expect(planning?.validationGate.required).toBe(false);
    expect(development?.askQuestions.enabled).toBe(false);
    expect(development?.askQuestions.maxQuestions).toBeUndefined();

    dispose();
  });

  it("returns mission dashboard snapshots for active/recent/weekly views", async () => {
    const { db, projectId, laneId, dispose } = await createDbWithProjectAndLane();
    const service = createMissionService({ db, projectId });

    const activeMission = service.create({
      prompt: "Implement active mission",
      laneId
    });
    service.update({ missionId: activeMission.id, status: "in_progress" });

    const completedMission = service.create({
      prompt: "Implement completed mission",
      laneId
    });
    service.update({ missionId: completedMission.id, status: "in_progress" });
    service.update({ missionId: completedMission.id, status: "completed" });

    const snapshot = service.getDashboard();
    expect(snapshot.active.some((entry) => entry.mission.id === activeMission.id)).toBe(true);
    expect(snapshot.recent.some((entry) => entry.mission.id === completedMission.id)).toBe(true);
    expect(snapshot.weekly.missions).toBeGreaterThanOrEqual(2);

    dispose();
  });
});
