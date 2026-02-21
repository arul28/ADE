import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PackDeltaDigestV1, PackExport, PackType } from "../../../shared/types";
import { openKvDb } from "../state/kvDb";
import { createMissionService } from "../missions/missionService";
import { createOrchestratorService } from "./orchestratorService";
import { createAiOrchestratorService } from "./aiOrchestratorService";

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {}
  } as any;
}

function buildExport(packKey: string, packType: PackType, level: "lite" | "standard" | "deep"): PackExport {
  return {
    packKey,
    packType,
    level,
    header: {} as any,
    content: `${packKey}:${level}`,
    approxTokens: 24,
    maxTokens: 500,
    truncated: false,
    warnings: [],
    clipReason: null,
    omittedSections: null
  };
}

function createMockAiIntegrationService(overrides: {
  executeTask?: (...args: any[]) => Promise<any>;
  planMission?: (...args: any[]) => Promise<any>;
} = {}) {
  return {
    getAvailability: () => ({ claude: true, codex: true }),
    getMode: () => "subscription",
    getFeatureFlag: () => true,
    getDailyBudgetLimit: () => null,
    getDailyUsage: () => 0,
    executeTask: overrides.executeTask ?? vi.fn().mockResolvedValue({
      text: "{}",
      structuredOutput: null,
      provider: "claude",
      model: "sonnet",
      sessionId: null,
      inputTokens: 100,
      outputTokens: 50,
      durationMs: 1000
    }),
    planMission: overrides.planMission ?? vi.fn().mockResolvedValue({
      text: "{}",
      structuredOutput: null,
      provider: "claude",
      model: "sonnet",
      sessionId: null,
      inputTokens: 200,
      outputTokens: 100,
      durationMs: 2000
    }),
    listModels: vi.fn().mockResolvedValue([])
  } as any;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

async function createFixture(args: {
  requirePlanReview?: boolean;
  aiIntegrationService?: any;
  laneService?: any;
} = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-ai-orchestrator-"));
  fs.mkdirSync(path.join(projectRoot, "docs", "architecture"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "docs", "PRD.md"), "# PRD\n", "utf8");
  fs.writeFileSync(path.join(projectRoot, "docs", "architecture", "SYSTEM_OVERVIEW.md"), "# Architecture\n", "utf8");

  const db = await openKvDb(path.join(projectRoot, ".ade.db"), createLogger());
  const projectId = "proj-1";
  const laneId = "lane-1";
  const now = "2026-02-20T00:00:00.000Z";

  db.run(
    `
      insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at)
      values (?, ?, ?, ?, ?, ?)
    `,
    [projectId, projectRoot, "ADE", "main", now, now]
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
      projectRoot,
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

  const missionService = createMissionService({ db, projectId });
  const laneService = args.laneService ?? null;
  const aiIntegrationService = args.aiIntegrationService ?? null;
  const projectConfigService = {
    get: () => ({
      effective: {
        ai: {
          orchestrator: {
            requirePlanReview: args.requirePlanReview === true
          }
        }
      }
    })
  } as any;

  const packService = {
    getLaneExport: async ({ laneId: targetLaneId, level }: { laneId: string; level: "lite" | "standard" | "deep" }) =>
      buildExport(`lane:${targetLaneId}`, "lane", level),
    getProjectExport: async ({ level }: { level: "lite" | "standard" | "deep" }) => buildExport("project", "project", level),
    getHeadVersion: ({ packKey }: { packKey: string }) => ({
      packKey,
      packType: packKey.startsWith("lane:") ? "lane" : "project",
      versionId: `${packKey}-v1`,
      versionNumber: 1,
      contentHash: `hash-${packKey}`,
      updatedAt: now
    }),
    getDeltaDigest: async (): Promise<PackDeltaDigestV1> => ({
      packKey: `lane:${laneId}`,
      packType: "lane",
      since: {
        sinceVersionId: null,
        sinceTimestamp: now,
        baselineVersionId: null,
        baselineVersionNumber: null,
        baselineCreatedAt: null
      },
      newVersion: {
        packKey: `lane:${laneId}`,
        packType: "lane",
        versionId: `lane:${laneId}-v1`,
        versionNumber: 1,
        contentHash: "hash",
        updatedAt: now
      },
      changedSections: [],
      highImpactEvents: [],
      blockers: [],
      conflicts: null,
      decisionState: {
        recommendedExportLevel: "standard",
        reasons: []
      },
      handoffSummary: "none",
      clipReason: null,
      omittedSections: null
    }),
    refreshMissionPack: async ({ missionId }: { missionId: string }) => ({
      packKey: `mission:${missionId}`,
      packType: "mission",
      path: path.join(projectRoot, ".ade", "packs", "missions", missionId, "mission_pack.md"),
      exists: true,
      deterministicUpdatedAt: now,
      narrativeUpdatedAt: null,
      lastHeadSha: null,
      versionId: `mission-${missionId}-v1`,
      versionNumber: 1,
      contentHash: `hash-mission-${missionId}`,
      metadata: null,
      body: "# Mission Pack"
    })
  } as any;

  const orchestratorService = createOrchestratorService({
    db,
    projectId,
    projectRoot,
    packService,
    projectConfigService
  });
  const aiOrchestratorService = createAiOrchestratorService({
    db,
    logger: createLogger(),
    missionService,
    orchestratorService,
    laneService,
    projectConfigService,
    aiIntegrationService,
    projectRoot
  });

  return {
    db,
    projectId,
    projectRoot,
    laneId,
    missionService,
    orchestratorService,
    laneService,
    projectConfigService,
    aiIntegrationService,
    aiOrchestratorService,
    dispose: () => {
      aiOrchestratorService.dispose();
      db.close();
    }
  };
}

describe("aiOrchestratorService", () => {
  it("blocks mission run at plan review when configured and opens approval intervention", async () => {
    const fixture = await createFixture({ requirePlanReview: true });
    try {
      const mission = fixture.missionService.create({
        prompt: "Implement orchestration startup policy and summarize outcomes.",
        laneId: fixture.laneId
      });

      const started = await fixture.aiOrchestratorService.startMissionRun({
        missionId: mission.id,
        runMode: "autopilot",
        defaultExecutorKind: "codex"
      });

      expect(started.blockedByPlanReview).toBe(true);
      expect(started.started).toBeNull();
      const refreshed = fixture.missionService.get(mission.id);
      expect(refreshed?.status).toBe("plan_review");
      expect(refreshed?.openInterventions).toBeGreaterThan(0);
      expect(
        refreshed?.interventions.some(
          (entry) => entry.status === "open" && entry.interventionType === "approval_required"
        )
      ).toBe(true);
      expect(fixture.orchestratorService.listRuns({ missionId: mission.id }).length).toBe(0);
    } finally {
      fixture.dispose();
    }
  });

  it("approves mission plan and starts execution", async () => {
    const fixture = await createFixture({ requirePlanReview: true });
    try {
      const mission = fixture.missionService.create({
        prompt: "Plan and implement runtime resiliency improvements.",
        laneId: fixture.laneId
      });

      const blocked = await fixture.aiOrchestratorService.startMissionRun({
        missionId: mission.id,
        runMode: "autopilot",
        defaultExecutorKind: "codex"
      });
      expect(blocked.blockedByPlanReview).toBe(true);

      const approved = await fixture.aiOrchestratorService.approveMissionPlan({
        missionId: mission.id,
        runMode: "manual",
        defaultExecutorKind: "manual"
      });

      expect(approved.blockedByPlanReview).toBe(false);
      expect(approved.started?.run.id).toBeTruthy();
      const refreshed = fixture.missionService.get(mission.id);
      expect(refreshed?.status).toBe("in_progress");
      expect(refreshed?.openInterventions).toBe(0);
      expect(fixture.orchestratorService.listRuns({ missionId: mission.id }).length).toBe(1);
    } finally {
      fixture.dispose();
    }
  });

  it("tracks worker state through lifecycle on orchestrator events", async () => {
    const fixture = await createFixture();
    try {
      const mission = fixture.missionService.create({
        prompt: "Build feature and test.",
        laneId: fixture.laneId
      });

      const launch = await fixture.aiOrchestratorService.startMissionRun({
        missionId: mission.id,
        runMode: "manual",
        defaultExecutorKind: "manual"
      });
      if (!launch.started) throw new Error("Expected mission run to start");
      const runId = launch.started.run.id;

      // Before any attempts, no workers
      expect(fixture.aiOrchestratorService.getWorkerStates({ runId })).toHaveLength(0);

      // Tick to get ready steps
      fixture.orchestratorService.tick({ runId });
      const graph = fixture.orchestratorService.getRunGraph({ runId });
      const readyStep = graph.steps.find((s) => s.status === "ready");
      if (!readyStep) throw new Error("Expected a ready step");

      // Start attempt → fire event → worker should be "working"
      const attempt = await fixture.orchestratorService.startAttempt({
        runId,
        stepId: readyStep.id,
        ownerId: "test-owner",
        executorKind: "manual"
      });
      fixture.aiOrchestratorService.onOrchestratorRuntimeEvent({
        type: "orchestrator-attempt-updated",
        runId,
        stepId: readyStep.id,
        attemptId: attempt.id,
        at: new Date().toISOString(),
        reason: "started"
      });

      const workingStates = fixture.aiOrchestratorService.getWorkerStates({ runId });
      expect(workingStates.length).toBe(1);
      expect(workingStates[0].state).toBe("working");
      expect(workingStates[0].attemptId).toBe(attempt.id);
      expect(workingStates[0].executorKind).toBe("manual");

      // Complete attempt → fire event → worker should be "completed"
      fixture.orchestratorService.completeAttempt({
        attemptId: attempt.id,
        status: "succeeded"
      });
      fixture.aiOrchestratorService.onOrchestratorRuntimeEvent({
        type: "orchestrator-attempt-updated",
        runId,
        stepId: readyStep.id,
        attemptId: attempt.id,
        at: new Date().toISOString(),
        reason: "completed"
      });

      const completedStates = fixture.aiOrchestratorService.getWorkerStates({ runId });
      expect(completedStates.length).toBe(1);
      expect(completedStates[0].state).toBe("completed");
      expect(completedStates[0].completedAt).toBeTruthy();
    } finally {
      fixture.dispose();
    }
  });

  it("tracks failed worker state", async () => {
    const fixture = await createFixture();
    try {
      const mission = fixture.missionService.create({
        prompt: "A task that will fail.",
        laneId: fixture.laneId
      });

      const launch = await fixture.aiOrchestratorService.startMissionRun({
        missionId: mission.id,
        runMode: "manual",
        defaultExecutorKind: "manual"
      });
      if (!launch.started) throw new Error("Expected mission run to start");
      const runId = launch.started.run.id;

      fixture.orchestratorService.tick({ runId });
      const graph = fixture.orchestratorService.getRunGraph({ runId });
      const readyStep = graph.steps.find((s) => s.status === "ready");
      if (!readyStep) throw new Error("Expected a ready step");

      const attempt = await fixture.orchestratorService.startAttempt({
        runId,
        stepId: readyStep.id,
        ownerId: "test-owner",
        executorKind: "manual"
      });
      fixture.orchestratorService.completeAttempt({
        attemptId: attempt.id,
        status: "failed",
        errorClass: "deterministic",
        errorMessage: "Test failure"
      });
      fixture.aiOrchestratorService.onOrchestratorRuntimeEvent({
        type: "orchestrator-attempt-updated",
        runId,
        stepId: readyStep.id,
        attemptId: attempt.id,
        at: new Date().toISOString(),
        reason: "failed"
      });

      const states = fixture.aiOrchestratorService.getWorkerStates({ runId });
      expect(states.length).toBe(1);
      expect(states[0].state).toBe("failed");
    } finally {
      fixture.dispose();
    }
  });

  it("recovers stale non-manual attempts during health sweep", async () => {
    const fixture = await createFixture();
    try {
      const mission = fixture.missionService.create({
        prompt: "Implement and validate orchestrator health checks.",
        laneId: fixture.laneId
      });

      const launch = await fixture.aiOrchestratorService.startMissionRun({
        missionId: mission.id,
        runMode: "manual",
        defaultExecutorKind: "manual"
      });
      if (!launch.started) throw new Error("Expected mission run to start");
      const runId = launch.started.run.id;

      fixture.orchestratorService.tick({ runId });
      const graph = fixture.orchestratorService.getRunGraph({ runId });
      const readyStep = graph.steps.find((s) => s.status === "ready");
      if (!readyStep) throw new Error("Expected a ready step");

      const attempt = await fixture.orchestratorService.startAttempt({
        runId,
        stepId: readyStep.id,
        ownerId: "test-owner",
        executorKind: "manual"
      });

      // Simulate a long-running codex worker that exceeded its timeout.
      fixture.db.run(
        `
          update orchestrator_attempts
          set executor_kind = 'codex',
              started_at = ?,
              created_at = ?
          where id = ?
        `,
        ["2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z", attempt.id]
      );

      const sweep = await fixture.aiOrchestratorService.runHealthSweep("test");
      expect(sweep.staleRecovered).toBeGreaterThanOrEqual(1);

      const refreshedGraph = fixture.orchestratorService.getRunGraph({ runId });
      const refreshedAttempt = refreshedGraph.attempts.find((entry) => entry.id === attempt.id);
      expect(refreshedAttempt?.status).toBe("failed");
      expect(refreshedAttempt?.errorMessage ?? "").toContain("Marking as stuck");
    } finally {
      fixture.dispose();
    }
  });

  it("keeps running attempts alive when tracked sessions show recent output activity", async () => {
    const fixture = await createFixture();
    try {
      const mission = fixture.missionService.create({
        prompt: "Do long-running work while continuously streaming output.",
        laneId: fixture.laneId
      });

      const launch = await fixture.aiOrchestratorService.startMissionRun({
        missionId: mission.id,
        runMode: "manual",
        defaultExecutorKind: "manual"
      });
      if (!launch.started) throw new Error("Expected mission run to start");
      const runId = launch.started.run.id;

      fixture.orchestratorService.tick({ runId });
      const graph = fixture.orchestratorService.getRunGraph({ runId });
      const readyStep = graph.steps.find((s) => s.status === "ready");
      if (!readyStep) throw new Error("Expected a ready step");

      const attempt = await fixture.orchestratorService.startAttempt({
        runId,
        stepId: readyStep.id,
        ownerId: "test-owner",
        executorKind: "manual"
      });

      const sessionId = "session-active-1";
      const transcriptPath = path.join(fixture.projectRoot, ".ade", "transcripts", `${sessionId}.log`);
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      fs.writeFileSync(transcriptPath, "still producing output\n", "utf8");

      fixture.db.run(
        `
          update orchestrator_attempts
          set executor_kind = 'codex',
              executor_session_id = ?,
              started_at = ?,
              created_at = ?
          where id = ?
        `,
        [sessionId, "2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z", attempt.id]
      );

      fixture.db.run(
        `
          insert into terminal_sessions(
            id,
            lane_id,
            pty_id,
            tracked,
            title,
            started_at,
            ended_at,
            exit_code,
            transcript_path,
            head_sha_start,
            head_sha_end,
            status,
            last_output_preview,
            summary,
            tool_type,
            resume_command,
            last_output_at
          ) values (?, ?, null, 1, 'Worker', ?, null, null, ?, null, null, 'running', null, null, 'codex-orchestrated', null, ?)
        `,
        [
          sessionId,
          fixture.laneId,
          "2026-02-20T00:00:00.000Z",
          transcriptPath,
          new Date().toISOString()
        ]
      );

      const sweep = await fixture.aiOrchestratorService.runHealthSweep("active_output");
      expect(sweep.staleRecovered).toBe(0);

      const refreshedGraph = fixture.orchestratorService.getRunGraph({ runId });
      const refreshedAttempt = refreshedGraph.attempts.find((entry) => entry.id === attempt.id);
      expect(refreshedAttempt?.status).toBe("running");
    } finally {
      fixture.dispose();
    }
  });

  it("recovers running attempts with tracked sessions that go silent", async () => {
    const fixture = await createFixture();
    try {
      const mission = fixture.missionService.create({
        prompt: "Recover no-output workers before they block the mission forever.",
        laneId: fixture.laneId
      });

      const launch = await fixture.aiOrchestratorService.startMissionRun({
        missionId: mission.id,
        runMode: "manual",
        defaultExecutorKind: "manual"
      });
      if (!launch.started) throw new Error("Expected mission run to start");
      const runId = launch.started.run.id;

      fixture.orchestratorService.tick({ runId });
      const graph = fixture.orchestratorService.getRunGraph({ runId });
      const readyStep = graph.steps.find((s) => s.status === "ready");
      if (!readyStep) throw new Error("Expected a ready step");

      const attempt = await fixture.orchestratorService.startAttempt({
        runId,
        stepId: readyStep.id,
        ownerId: "test-owner",
        executorKind: "manual"
      });

      const sessionId = "session-silent-1";
      const transcriptPath = path.join(fixture.projectRoot, ".ade", "transcripts", `${sessionId}.log`);
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      fs.writeFileSync(transcriptPath, "", "utf8");
      const old = new Date("2000-01-01T00:00:00.000Z");
      fs.utimesSync(transcriptPath, old, old);

      fixture.db.run(
        `
          update orchestrator_attempts
          set executor_kind = 'codex',
              executor_session_id = ?,
              started_at = ?,
              created_at = ?
          where id = ?
        `,
        [sessionId, "2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z", attempt.id]
      );

      fixture.db.run(
        `
          insert into terminal_sessions(
            id,
            lane_id,
            pty_id,
            tracked,
            title,
            started_at,
            ended_at,
            exit_code,
            transcript_path,
            head_sha_start,
            head_sha_end,
            status,
            last_output_preview,
            summary,
            tool_type,
            resume_command,
            last_output_at
          ) values (?, ?, null, 1, 'Worker', ?, null, null, ?, null, null, 'running', null, null, 'codex-orchestrated', null, ?)
        `,
        [
          sessionId,
          fixture.laneId,
          "2026-02-20T00:00:00.000Z",
          transcriptPath,
          "2000-01-01T00:00:00.000Z"
        ]
      );

      const sweep = await fixture.aiOrchestratorService.runHealthSweep("silent_output");
      expect(sweep.staleRecovered).toBeGreaterThanOrEqual(1);

      const refreshedGraph = fixture.orchestratorService.getRunGraph({ runId });
      const refreshedAttempt = refreshedGraph.attempts.find((entry) => entry.id === attempt.id);
      expect(refreshedAttempt?.status).toBe("failed");
      expect(refreshedAttempt?.errorMessage ?? "").toContain("Marking as stuck");
    } finally {
      fixture.dispose();
    }
  });

  it("does not open failed-step intervention when failure already queued a retry", async () => {
    const fixture = await createFixture();
    try {
      const mission = fixture.missionService.create({
        prompt: "Implement endpoint and run verification checks.",
        laneId: fixture.laneId
      });

      const launch = await fixture.aiOrchestratorService.startMissionRun({
        missionId: mission.id,
        runMode: "manual",
        defaultExecutorKind: "manual"
      });
      if (!launch.started) throw new Error("Expected mission run to start");
      const runId = launch.started.run.id;

      fixture.orchestratorService.tick({ runId });
      const graph = fixture.orchestratorService.getRunGraph({ runId });
      const readyStep = graph.steps.find((step) => step.status === "ready");
      if (!readyStep) throw new Error("Expected a ready step");

      const attempt = await fixture.orchestratorService.startAttempt({
        runId,
        stepId: readyStep.id,
        ownerId: "test-owner",
        executorKind: "manual"
      });
      fixture.orchestratorService.completeAttempt({
        attemptId: attempt.id,
        status: "failed",
        errorClass: "transient",
        errorMessage: "Temporary CI outage"
      });

      fixture.aiOrchestratorService.onOrchestratorRuntimeEvent({
        type: "orchestrator-attempt-updated",
        runId,
        stepId: readyStep.id,
        attemptId: attempt.id,
        at: new Date().toISOString(),
        reason: "failed"
      });

      const refreshedMission = fixture.missionService.get(mission.id);
      const failedStepInterventions = refreshedMission?.interventions.filter((item) => item.interventionType === "failed_step") ?? [];
      expect(failedStepInterventions).toHaveLength(0);

      const chat = fixture.aiOrchestratorService.getChat({ missionId: mission.id });
      expect(chat.some((entry) => entry.content.includes("Retry scheduled"))).toBe(true);
    } finally {
      fixture.dispose();
    }
  });

  it("reconciles running attempts when tracked sessions already ended", async () => {
    const fixture = await createFixture();
    try {
      const mission = fixture.missionService.create({
        prompt: "Recover attempts when tracked worker sessions end.",
        laneId: fixture.laneId
      });

      const launch = await fixture.aiOrchestratorService.startMissionRun({
        missionId: mission.id,
        runMode: "manual",
        defaultExecutorKind: "manual"
      });
      if (!launch.started) throw new Error("Expected mission run to start");
      const runId = launch.started.run.id;

      fixture.orchestratorService.tick({ runId });
      const graph = fixture.orchestratorService.getRunGraph({ runId });
      const readyStep = graph.steps.find((s) => s.status === "ready");
      if (!readyStep) throw new Error("Expected a ready step");

      const attempt = await fixture.orchestratorService.startAttempt({
        runId,
        stepId: readyStep.id,
        ownerId: "test-owner",
        executorKind: "manual"
      });

      fixture.db.run(
        `
          update orchestrator_attempts
          set executor_kind = 'codex',
              executor_session_id = ?
          where id = ?
        `,
        ["session-ended-1", attempt.id]
      );

      fixture.db.run(
        `
          insert into terminal_sessions(
            id,
            lane_id,
            pty_id,
            tracked,
            title,
            started_at,
            ended_at,
            exit_code,
            transcript_path,
            head_sha_start,
            head_sha_end,
            status,
            last_output_preview,
            summary,
            tool_type,
            resume_command
          ) values (?, ?, null, 1, 'Worker', ?, ?, 0, ?, null, null, 'completed', null, null, 'codex-orchestrated', null)
        `,
        [
          "session-ended-1",
          fixture.laneId,
          "2026-02-20T00:00:00.000Z",
          "2026-02-20T00:05:00.000Z",
          path.join(fixture.projectRoot, ".ade", "transcripts", "session-ended-1.log")
        ]
      );

      const sweep = await fixture.aiOrchestratorService.runHealthSweep("session_ended_test");
      expect(sweep.staleRecovered).toBeGreaterThanOrEqual(1);

      const refreshedGraph = fixture.orchestratorService.getRunGraph({ runId });
      const refreshedAttempt = refreshedGraph.attempts.find((entry) => entry.id === attempt.id);
      expect(refreshedAttempt?.status).toBe("succeeded");
    } finally {
      fixture.dispose();
    }
  });

  it("opens manual-input interventions from runtime waiting-input signals", async () => {
    const fixture = await createFixture();
    try {
      const mission = fixture.missionService.create({
        prompt: "Keep workers moving and request help when blocked.",
        laneId: fixture.laneId
      });

      const launch = await fixture.aiOrchestratorService.startMissionRun({
        missionId: mission.id,
        runMode: "manual",
        defaultExecutorKind: "manual"
      });
      if (!launch.started) throw new Error("Expected mission run to start");
      const runId = launch.started.run.id;

      fixture.orchestratorService.tick({ runId });
      const graph = fixture.orchestratorService.getRunGraph({ runId });
      const readyStep = graph.steps.find((s) => s.status === "ready");
      if (!readyStep) throw new Error("Expected a ready step");

      const attempt = await fixture.orchestratorService.startAttempt({
        runId,
        stepId: readyStep.id,
        ownerId: "test-owner",
        executorKind: "manual"
      });

      const sessionId = "session-waiting-input-1";
      fixture.db.run(
        `
          update orchestrator_attempts
          set executor_kind = 'codex',
              executor_session_id = ?
          where id = ?
        `,
        [sessionId, attempt.id]
      );

      fixture.aiOrchestratorService.onSessionRuntimeSignal({
        laneId: fixture.laneId,
        sessionId,
        runtimeState: "waiting-input",
        lastOutputPreview: "Need your input: choose option A or B before proceeding.",
        at: new Date().toISOString()
      });

      await waitFor(() => {
        const refreshed = fixture.missionService.get(mission.id);
        return Boolean(
          refreshed?.interventions.some(
            (entry) =>
              entry.status === "open" &&
              entry.interventionType === "manual_input" &&
              String(entry.metadata?.attemptId ?? "") === attempt.id
          )
        );
      });

      const refreshedMission = fixture.missionService.get(mission.id);
      expect(
        refreshedMission?.interventions.some(
          (entry) =>
            entry.status === "open" &&
            entry.interventionType === "manual_input" &&
            String(entry.metadata?.attemptId ?? "") === attempt.id
        )
      ).toBe(true);

      const states = fixture.aiOrchestratorService.getWorkerStates({ runId });
      const tracked = states.find((entry) => entry.attemptId === attempt.id);
      expect(tracked?.state).toBe("waiting_input");
    } finally {
      fixture.dispose();
    }
  });

  it("reconciles attempts immediately on terminal runtime end signals", async () => {
    const fixture = await createFixture();
    try {
      const mission = fixture.missionService.create({
        prompt: "Detect ended sessions and reconcile without waiting for periodic sweeps.",
        laneId: fixture.laneId
      });

      const launch = await fixture.aiOrchestratorService.startMissionRun({
        missionId: mission.id,
        runMode: "manual",
        defaultExecutorKind: "manual"
      });
      if (!launch.started) throw new Error("Expected mission run to start");
      const runId = launch.started.run.id;

      fixture.orchestratorService.tick({ runId });
      const graph = fixture.orchestratorService.getRunGraph({ runId });
      const readyStep = graph.steps.find((s) => s.status === "ready");
      if (!readyStep) throw new Error("Expected a ready step");

      const attempt = await fixture.orchestratorService.startAttempt({
        runId,
        stepId: readyStep.id,
        ownerId: "test-owner",
        executorKind: "manual"
      });

      const sessionId = "session-runtime-ended-1";
      fixture.db.run(
        `
          update orchestrator_attempts
          set executor_kind = 'codex',
              executor_session_id = ?
          where id = ?
        `,
        [sessionId, attempt.id]
      );

      fixture.db.run(
        `
          insert into terminal_sessions(
            id,
            lane_id,
            pty_id,
            tracked,
            title,
            started_at,
            ended_at,
            exit_code,
            transcript_path,
            head_sha_start,
            head_sha_end,
            status,
            last_output_preview,
            summary,
            tool_type,
            resume_command
          ) values (?, ?, null, 1, 'Worker', ?, ?, 0, ?, null, null, 'completed', null, null, 'codex-orchestrated', null)
        `,
        [
          sessionId,
          fixture.laneId,
          "2026-02-20T00:00:00.000Z",
          "2026-02-20T00:05:00.000Z",
          path.join(fixture.projectRoot, ".ade", "transcripts", "session-runtime-ended-1.log")
        ]
      );

      fixture.aiOrchestratorService.onSessionRuntimeSignal({
        laneId: fixture.laneId,
        sessionId,
        runtimeState: "exited",
        lastOutputPreview: "Done",
        at: new Date().toISOString()
      });

      await waitFor(() => {
        const refreshed = fixture.orchestratorService.getRunGraph({ runId });
        const matched = refreshed.attempts.find((entry) => entry.id === attempt.id);
        return matched?.status === "succeeded";
      });
    } finally {
      fixture.dispose();
    }
  });

  it("rehydrates persisted runtime waiting-input state after service restart", async () => {
    const fixture = await createFixture();
    let restartedService: ReturnType<typeof createAiOrchestratorService> | null = null;
    try {
      const mission = fixture.missionService.create({
        prompt: "Keep waiting-input awareness across orchestrator restarts.",
        laneId: fixture.laneId
      });

      const launch = await fixture.aiOrchestratorService.startMissionRun({
        missionId: mission.id,
        runMode: "manual",
        defaultExecutorKind: "manual"
      });
      if (!launch.started) throw new Error("Expected mission run to start");
      const runId = launch.started.run.id;

      fixture.orchestratorService.tick({ runId });
      const graph = fixture.orchestratorService.getRunGraph({ runId });
      const readyStep = graph.steps.find((s) => s.status === "ready");
      if (!readyStep) throw new Error("Expected a ready step");

      const attempt = await fixture.orchestratorService.startAttempt({
        runId,
        stepId: readyStep.id,
        ownerId: "test-owner",
        executorKind: "manual"
      });

      const sessionId = "session-runtime-restart-1";
      const transcriptPath = path.join(fixture.projectRoot, ".ade", "transcripts", `${sessionId}.log`);
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      fs.writeFileSync(transcriptPath, "still waiting...\n", "utf8");

      fixture.db.run(
        `
          update orchestrator_attempts
          set executor_kind = 'codex',
              executor_session_id = ?
          where id = ?
        `,
        [sessionId, attempt.id]
      );

      fixture.db.run(
        `
          insert into terminal_sessions(
            id,
            lane_id,
            pty_id,
            tracked,
            title,
            started_at,
            ended_at,
            exit_code,
            transcript_path,
            head_sha_start,
            head_sha_end,
            status,
            last_output_preview,
            summary,
            tool_type,
            resume_command,
            last_output_at
          ) values (?, ?, null, 1, 'Worker', ?, null, null, ?, null, null, 'running', ?, null, 'codex-orchestrated', null, ?)
        `,
        [
          sessionId,
          fixture.laneId,
          "2026-02-20T00:00:00.000Z",
          transcriptPath,
          "still waiting...",
          new Date().toISOString()
        ]
      );

      fixture.aiOrchestratorService.onSessionRuntimeSignal({
        laneId: fixture.laneId,
        sessionId,
        runtimeState: "waiting-input",
        lastOutputPreview: "still waiting...",
        at: new Date().toISOString()
      });

      await waitFor(() => {
        const row = fixture.db.get<{ runtime_state: string | null }>(
          `select runtime_state from orchestrator_attempt_runtime where attempt_id = ? limit 1`,
          [attempt.id]
        );
        return String(row?.runtime_state ?? "") === "waiting-input";
      });

      fixture.db.run(
        `delete from mission_interventions where mission_id = ? and intervention_type = 'manual_input'`,
        [mission.id]
      );

      fixture.aiOrchestratorService.dispose();
      restartedService = createAiOrchestratorService({
        db: fixture.db,
        logger: createLogger(),
        missionService: fixture.missionService,
        orchestratorService: fixture.orchestratorService,
        laneService: fixture.laneService,
        projectConfigService: fixture.projectConfigService,
        aiIntegrationService: fixture.aiIntegrationService,
        projectRoot: fixture.projectRoot
      });

      await restartedService.runHealthSweep("restart_hydrate");

      const refreshed = fixture.missionService.get(mission.id);
      expect(
        refreshed?.interventions.some(
          (entry) =>
            entry.status === "open" &&
            entry.interventionType === "manual_input" &&
            String(entry.metadata?.attemptId ?? "") === attempt.id
        )
      ).toBe(true);
    } finally {
      restartedService?.dispose();
      fixture.dispose();
    }
  });

  it("clears persisted runtime rows once attempts become terminal", async () => {
    const fixture = await createFixture();
    try {
      const mission = fixture.missionService.create({
        prompt: "Persist runtime tracking while running and clean it on terminal status.",
        laneId: fixture.laneId
      });

      const launch = await fixture.aiOrchestratorService.startMissionRun({
        missionId: mission.id,
        runMode: "manual",
        defaultExecutorKind: "manual"
      });
      if (!launch.started) throw new Error("Expected mission run to start");
      const runId = launch.started.run.id;

      fixture.orchestratorService.tick({ runId });
      const graph = fixture.orchestratorService.getRunGraph({ runId });
      const readyStep = graph.steps.find((s) => s.status === "ready");
      if (!readyStep) throw new Error("Expected a ready step");

      const attempt = await fixture.orchestratorService.startAttempt({
        runId,
        stepId: readyStep.id,
        ownerId: "test-owner",
        executorKind: "manual"
      });

      const sessionId = "session-runtime-cleanup-1";
      fixture.db.run(
        `
          update orchestrator_attempts
          set executor_kind = 'codex',
              executor_session_id = ?
          where id = ?
        `,
        [sessionId, attempt.id]
      );

      fixture.aiOrchestratorService.onSessionRuntimeSignal({
        laneId: fixture.laneId,
        sessionId,
        runtimeState: "running",
        lastOutputPreview: "processing work",
        at: new Date().toISOString()
      });

      await waitFor(() => {
        const row = fixture.db.get<{ attempt_id: string | null }>(
          `select attempt_id from orchestrator_attempt_runtime where attempt_id = ? limit 1`,
          [attempt.id]
        );
        return String(row?.attempt_id ?? "") === attempt.id;
      });

      fixture.orchestratorService.completeAttempt({
        attemptId: attempt.id,
        status: "failed",
        errorClass: "deterministic",
        errorMessage: "cleanup check"
      });
      fixture.aiOrchestratorService.onOrchestratorRuntimeEvent({
        type: "orchestrator-attempt-updated",
        runId,
        stepId: readyStep.id,
        attemptId: attempt.id,
        at: new Date().toISOString(),
        reason: "failed"
      });

      const persisted = fixture.db.get<{ attempt_id: string | null }>(
        `select attempt_id from orchestrator_attempt_runtime where attempt_id = ? limit 1`,
        [attempt.id]
      );
      expect(persisted).toBeNull();
    } finally {
      fixture.dispose();
    }
  });

  it("clips chat context before calling AI so orchestrator prompts stay compact", async () => {
    const mockAi = createMockAiIntegrationService({
      executeTask: vi.fn().mockResolvedValue({
        text: "Acknowledged.",
        structuredOutput: null,
        provider: "claude",
        model: "sonnet",
        sessionId: null,
        inputTokens: 80,
        outputTokens: 20,
        durationMs: 300
      })
    });
    const fixture = await createFixture({ aiIntegrationService: mockAi });
    try {
      const mission = fixture.missionService.create({
        prompt: "Keep prompts concise while preserving decision-relevant context.",
        laneId: fixture.laneId
      });

      const hugeMessage = `Need a compact response context.\n${"x".repeat(12_000)}`;
      fixture.aiOrchestratorService.sendChat({
        missionId: mission.id,
        content: hugeMessage
      });

      await waitFor(() => (mockAi.executeTask as any).mock.calls.length > 0);
      const firstCallArgs = (mockAi.executeTask as any).mock.calls[0]?.[0];
      expect(firstCallArgs).toBeTruthy();
      expect(typeof firstCallArgs.prompt).toBe("string");
      expect(firstCallArgs.prompt.length).toBeLessThan(9_000);
      expect(firstCallArgs.prompt).toContain("...[truncated]");
      expect(firstCallArgs.prompt.includes("x".repeat(5_000))).toBe(false);
    } finally {
      fixture.dispose();
    }
  });

  it("planWithAI gracefully degrades when aiIntegrationService is not available", async () => {
    const fixture = await createFixture();
    try {
      const mission = fixture.missionService.create({
        prompt: "Test planning without AI.",
        laneId: fixture.laneId
      });
      // No aiIntegrationService → should log warning and return without error
      await expect(
        fixture.aiOrchestratorService.planWithAI({
          missionId: mission.id,
          provider: "claude"
        })
      ).resolves.toBeUndefined();
      // Mission steps should remain unchanged (deterministic)
      const refreshed = fixture.missionService.get(mission.id);
      expect(refreshed?.steps.length).toBeGreaterThan(0);
    } finally {
      fixture.dispose();
    }
  });

  it("planWithAI replaces mission steps when AI planning succeeds", async () => {
    // Build a mock that returns a valid planner plan JSON
    const mockPlanJson = JSON.stringify({
      schemaVersion: "1.0",
      missionSummary: {
        title: "AI-planned mission",
        objective: "Test objective",
        domain: "backend",
        complexity: "low",
        strategy: "sequential",
        parallelismCap: 1
      },
      assumptions: [],
      risks: [],
      steps: [
        {
          stepId: "ai-step-1",
          name: "AI Step One",
          description: "First AI step.",
          taskType: "code",
          executorHint: "claude",
          preferredScope: "lane",
          requiresContextProfiles: ["deterministic"],
          dependencies: [],
          artifactHints: [],
          claimPolicy: { lanes: ["backend"] },
          maxAttempts: 2,
          retryPolicy: { baseMs: 5000, maxMs: 120000, multiplier: 2, maxRetries: 1 },
          outputContract: { expectedSignals: [], completionCriteria: "step_done" }
        },
        {
          stepId: "ai-step-2",
          name: "AI Step Two",
          description: "Second AI step.",
          taskType: "test",
          executorHint: "codex",
          preferredScope: "lane",
          requiresContextProfiles: ["deterministic"],
          dependencies: ["ai-step-1"],
          artifactHints: [],
          claimPolicy: { lanes: ["backend"] },
          maxAttempts: 2,
          retryPolicy: { baseMs: 5000, maxMs: 120000, multiplier: 2, maxRetries: 1 },
          outputContract: { expectedSignals: [], completionCriteria: "tests_pass" }
        }
      ],
      handoffPolicy: { externalConflictDefault: "intervention" }
    });

    const mockAi = createMockAiIntegrationService({
      planMission: vi.fn().mockResolvedValue({
        text: mockPlanJson,
        structuredOutput: JSON.parse(mockPlanJson),
        provider: "claude",
        model: "sonnet",
        sessionId: null,
        inputTokens: 200,
        outputTokens: 300,
        durationMs: 3000
      })
    });

    const fixture = await createFixture({ aiIntegrationService: mockAi });
    try {
      const mission = fixture.missionService.create({
        prompt: "Implement a backend feature.",
        laneId: fixture.laneId
      });
      const originalStepCount = mission.steps.length;
      expect(originalStepCount).toBeGreaterThan(0);

      await fixture.aiOrchestratorService.planWithAI({
        missionId: mission.id,
        provider: "claude"
      });

      const refreshed = fixture.missionService.get(mission.id);
      expect(refreshed).toBeTruthy();
      // AI plan produced 2 steps
      expect(refreshed!.steps.length).toBe(2);
      expect(refreshed!.steps[0].title).toBe("AI Step One");
      expect(refreshed!.steps[1].title).toBe("AI Step Two");

      // Verify metadata was stored
      const metaRow = fixture.db.get<{ metadata_json: string | null }>(
        `select metadata_json from missions where id = ?`,
        [mission.id]
      );
      expect(metaRow?.metadata_json).toBeTruthy();
      const meta = JSON.parse(metaRow!.metadata_json!);
      expect(meta.plannerPlan).toBeTruthy();
      expect(meta.plannerPlan.stepCount).toBe(2);
      expect(meta.planner).toBeTruthy();
    } finally {
      fixture.dispose();
    }
  });

  it("startMissionRun reports deterministic fallback reason when AI planner degrades", async () => {
    const mockAi = createMockAiIntegrationService({
      planMission: vi.fn().mockResolvedValue({
        text: "planner output was malformed",
        structuredOutput: null,
        provider: "claude",
        model: "sonnet",
        sessionId: null,
        inputTokens: 120,
        outputTokens: 80,
        durationMs: 900
      })
    });

    const fixture = await createFixture({ aiIntegrationService: mockAi });
    try {
      const mission = fixture.missionService.create({
        prompt: "Add endpoint, tests, docs, and final review.",
        laneId: fixture.laneId
      });

      const launch = await fixture.aiOrchestratorService.startMissionRun({
        missionId: mission.id,
        plannerProvider: "claude",
        runMode: "manual",
        defaultExecutorKind: "manual"
      });
      expect(launch.started).toBeTruthy();

      const chat = fixture.aiOrchestratorService.getChat({ missionId: mission.id });
      expect(chat.some((entry) => entry.content.includes("fell back to deterministic"))).toBe(true);
      expect(chat.some((entry) => entry.content.includes("planner_parse_error"))).toBe(true);
    } finally {
      fixture.dispose();
    }
  });

  it("planWithAI rejects generic AI plans and preserves non-generic mission steps", async () => {
    const genericPlan = {
      schemaVersion: "1.0",
      missionSummary: {
        title: "Generic plan",
        objective: "Should be rejected by planner validation",
        domain: "backend",
        complexity: "medium",
        strategy: "parallel-lite",
        parallelismCap: 2
      },
      assumptions: [],
      risks: [],
      steps: [
        {
          stepId: "step-1",
          name: "Step 1",
          description: "Execute mission work for this step.",
          taskType: "code",
          executorHint: "either",
          preferredScope: "lane",
          requiresContextProfiles: ["deterministic"],
          dependencies: [],
          artifactHints: [],
          claimPolicy: { lanes: ["backend"] },
          maxAttempts: 2,
          retryPolicy: { baseMs: 5000, maxMs: 120000, multiplier: 2, maxRetries: 1 },
          outputContract: { expectedSignals: [], completionCriteria: "done" }
        }
      ],
      handoffPolicy: { externalConflictDefault: "intervention" }
    };

    const mockAi = createMockAiIntegrationService({
      planMission: vi.fn().mockResolvedValue({
        text: JSON.stringify(genericPlan),
        structuredOutput: genericPlan,
        provider: "claude",
        model: "sonnet",
        sessionId: null,
        inputTokens: 150,
        outputTokens: 120,
        durationMs: 1200
      })
    });

    const fixture = await createFixture({ aiIntegrationService: mockAi });
    try {
      const mission = fixture.missionService.create({
        prompt: "Add health endpoint, tests, docs, and final review.",
        laneId: fixture.laneId
      });
      const originalStepTitles = mission.steps.map((step) => step.title);
      expect(originalStepTitles.some((title) => title === "Step 1")).toBe(false);

      await fixture.aiOrchestratorService.planWithAI({
        missionId: mission.id,
        provider: "claude"
      });

      const refreshed = fixture.missionService.get(mission.id);
      expect(refreshed).toBeTruthy();
      expect(refreshed!.steps.some((step) => step.title === "Step 1")).toBe(false);
      expect(refreshed!.steps.length).toBeGreaterThan(0);
    } finally {
      fixture.dispose();
    }
  });

  it("evaluateWorkerPlan approves when AI returns approved=true", async () => {
    const mockAi = createMockAiIntegrationService({
      executeTask: vi.fn().mockResolvedValue({
        text: "",
        structuredOutput: {
          approved: true,
          feedback: "Output meets quality criteria.",
          suggestedAction: "accept"
        },
        provider: "claude",
        model: "sonnet",
        sessionId: null,
        inputTokens: 100,
        outputTokens: 50,
        durationMs: 1000
      })
    });

    const fixture = await createFixture({ aiIntegrationService: mockAi });
    try {
      const result = await fixture.aiOrchestratorService.evaluateWorkerPlan({
        attemptId: "a-1",
        workerPlan: { action: "edit files", filesModified: 3 },
        provider: "claude"
      });
      expect(result.approved).toBe(true);
      expect(result.feedback).toBe("Output meets quality criteria.");
    } finally {
      fixture.dispose();
    }
  });

  it("evaluateWorkerPlan rejects when AI returns approved=false", async () => {
    const mockAi = createMockAiIntegrationService({
      executeTask: vi.fn().mockResolvedValue({
        text: "",
        structuredOutput: {
          approved: false,
          feedback: "Output has scope violations.",
          scopeViolations: ["Modified files outside reservation"],
          suggestedAction: "retry_with_feedback"
        },
        provider: "claude",
        model: "sonnet",
        sessionId: null,
        inputTokens: 100,
        outputTokens: 50,
        durationMs: 1000
      })
    });

    const fixture = await createFixture({ aiIntegrationService: mockAi });
    try {
      const result = await fixture.aiOrchestratorService.evaluateWorkerPlan({
        attemptId: "a-2",
        workerPlan: { action: "edit outside scope" },
        provider: "claude"
      });
      expect(result.approved).toBe(false);
      expect(result.feedback).toBe("Output has scope violations.");
    } finally {
      fixture.dispose();
    }
  });

  it("evaluateWorkerPlan gracefully degrades when AI is unavailable", async () => {
    const fixture = await createFixture(); // No aiIntegrationService
    try {
      const result = await fixture.aiOrchestratorService.evaluateWorkerPlan({
        attemptId: "a-1",
        workerPlan: { action: "edit files" },
        provider: "claude"
      });
      expect(result.approved).toBe(true);
      expect(result.feedback).toContain("not available");
    } finally {
      fixture.dispose();
    }
  });

  it("evaluateWorkerPlan gracefully degrades when AI throws", async () => {
    const mockAi = createMockAiIntegrationService({
      executeTask: vi.fn().mockRejectedValue(new Error("AI service timeout"))
    });

    const fixture = await createFixture({ aiIntegrationService: mockAi });
    try {
      const result = await fixture.aiOrchestratorService.evaluateWorkerPlan({
        attemptId: "a-err",
        workerPlan: { action: "edit files" },
        provider: "claude"
      });
      expect(result.approved).toBe(true);
      expect(result.feedback).toContain("failed");
    } finally {
      fixture.dispose();
    }
  });

  it("handleInterventionWithAI auto-resolves with high confidence", async () => {
    const mockAi = createMockAiIntegrationService({
      executeTask: vi.fn().mockResolvedValue({
        text: "",
        structuredOutput: {
          autoResolvable: true,
          confidence: 0.9,
          suggestedAction: "retry",
          reasoning: "The failure was transient. Retrying should succeed."
        },
        provider: "claude",
        model: "sonnet",
        sessionId: null,
        inputTokens: 100,
        outputTokens: 50,
        durationMs: 1000
      })
    });

    const fixture = await createFixture({ aiIntegrationService: mockAi });
    try {
      const mission = fixture.missionService.create({
        prompt: "Test intervention resolution.",
        laneId: fixture.laneId
      });
      // Transition to in_progress before adding intervention
      fixture.missionService.update({ missionId: mission.id, status: "planning" });
      fixture.missionService.update({ missionId: mission.id, status: "in_progress" });
      const intervention = fixture.missionService.addIntervention({
        missionId: mission.id,
        interventionType: "failed_step",
        title: "Step failed after retries",
        body: "Step 1 failed 3 times.",
        requestedAction: "Review and decide next action."
      });

      const result = await fixture.aiOrchestratorService.handleInterventionWithAI({
        missionId: mission.id,
        interventionId: intervention.id,
        provider: "claude"
      });

      expect(result.autoResolved).toBe(true);
      expect(result.suggestion).toContain("transient");
    } finally {
      fixture.dispose();
    }
  });

  it("handleInterventionWithAI escalates with low confidence", async () => {
    const mockAi = createMockAiIntegrationService({
      executeTask: vi.fn().mockResolvedValue({
        text: "",
        structuredOutput: {
          autoResolvable: false,
          confidence: 0.3,
          suggestedAction: "escalate",
          reasoning: "The error indicates a configuration issue that requires human review."
        },
        provider: "claude",
        model: "sonnet",
        sessionId: null,
        inputTokens: 100,
        outputTokens: 50,
        durationMs: 1000
      })
    });

    const fixture = await createFixture({ aiIntegrationService: mockAi });
    try {
      const mission = fixture.missionService.create({
        prompt: "Test intervention escalation.",
        laneId: fixture.laneId
      });

      const result = await fixture.aiOrchestratorService.handleInterventionWithAI({
        missionId: mission.id,
        interventionId: "i-1",
        provider: "codex"
      });

      expect(result.autoResolved).toBe(false);
      expect(result.suggestion).toContain("configuration issue");
    } finally {
      fixture.dispose();
    }
  });

  it("handleInterventionWithAI gracefully degrades when AI is unavailable", async () => {
    const fixture = await createFixture(); // No aiIntegrationService
    try {
      const result = await fixture.aiOrchestratorService.handleInterventionWithAI({
        missionId: "m-1",
        interventionId: "i-1",
        provider: "codex"
      });
      expect(result.autoResolved).toBe(false);
      expect(result.suggestion).toBeNull();
    } finally {
      fixture.dispose();
    }
  });

  it("startMissionRun with plannerProvider calls planWithAI", async () => {
    const fixture = await createFixture();
    try {
      const mission = fixture.missionService.create({
        prompt: "AI-planned mission.",
        laneId: fixture.laneId
      });

      // Without aiIntegrationService, planWithAI gracefully degrades
      const result = await fixture.aiOrchestratorService.startMissionRun({
        missionId: mission.id,
        runMode: "manual",
        defaultExecutorKind: "manual",
        plannerProvider: "claude"
      });

      // Should still start since planWithAI degrades gracefully
      expect(result.blockedByPlanReview).toBe(false);
      expect(result.started).toBeTruthy();
    } finally {
      fixture.dispose();
    }
  });

  it("auto-creates lanes for independent parallel steps and assigns downstream lanes", async () => {
    const laneService = {
      createChild: vi.fn().mockResolvedValue({
        id: "lane-child-1",
        name: "m-auto-child-1"
      })
    };
    const fixture = await createFixture({ laneService });
    try {
      const mission = fixture.missionService.create({
        prompt: "Implement two independent units in parallel, then integrate.",
        laneId: fixture.laneId
      });

      const now = "2026-02-21T00:00:00.000Z";
      fixture.db.run(`delete from mission_steps where mission_id = ?`, [mission.id]);
      fixture.db.run(
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
          ) values
            ('mstep-par-1', ?, ?, 0, 'Build API slice', 'Implement API changes', 'implementation', ?, 'pending', '{"stepType":"implementation","dependencyStepKeys":[]}', ?, ?, null, null),
            ('mstep-par-2', ?, ?, 1, 'Build UI slice', 'Implement UI changes', 'implementation', ?, 'pending', '{"stepType":"implementation","dependencyStepKeys":[]}', ?, ?, null, null),
            ('mstep-par-3', ?, ?, 2, 'Integrate and verify', 'Join outputs and verify', 'integration', ?, 'pending', '{"stepType":"integration","dependencyIndices":[0,1],"joinPolicy":"all_success"}', ?, ?, null, null)
        `,
        [
          mission.id,
          fixture.projectId,
          fixture.laneId,
          now,
          now,
          mission.id,
          fixture.projectId,
          fixture.laneId,
          now,
          now,
          mission.id,
          fixture.projectId,
          fixture.laneId,
          now,
          now
        ]
      );

      const started = await fixture.aiOrchestratorService.startMissionRun({
        missionId: mission.id,
        runMode: "autopilot",
        defaultExecutorKind: "manual"
      });
      expect(started.blockedByPlanReview).toBe(false);
      expect(laneService.createChild).toHaveBeenCalledTimes(1);

      const refreshedMission = fixture.missionService.get(mission.id);
      expect(refreshedMission).toBeTruthy();
      const apiStep = refreshedMission!.steps.find((step) => step.id === "mstep-par-1");
      const uiStep = refreshedMission!.steps.find((step) => step.id === "mstep-par-2");
      const joinStep = refreshedMission!.steps.find((step) => step.id === "mstep-par-3");
      expect(apiStep?.laneId).toBe(fixture.laneId);
      expect(uiStep?.laneId).toBe("lane-child-1");
      expect(joinStep?.laneId).toBe(fixture.laneId);

      const runs = fixture.orchestratorService.listRuns({ missionId: mission.id });
      expect(runs.length).toBeGreaterThan(0);
      const graph = fixture.orchestratorService.getRunGraph({ runId: runs[0]!.id });
      const runUiStep = graph.steps.find((step) => step.missionStepId === "mstep-par-2");
      expect(runUiStep?.laneId).toBe("lane-child-1");
    } finally {
      fixture.dispose();
    }
  });

  it("does not create duplicate child lanes when parallel roots are already assigned", async () => {
    const laneService = {
      createChild: vi.fn().mockResolvedValue({
        id: "lane-child-unexpected",
        name: "unexpected"
      })
    };
    const fixture = await createFixture({ laneService });
    try {
      const mission = fixture.missionService.create({
        prompt: "Run existing parallel workstreams and integrate.",
        laneId: fixture.laneId
      });

      const now = "2026-02-21T00:00:00.000Z";
      fixture.db.run(
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
          "lane-child-existing",
          fixture.projectId,
          "Child Existing",
          null,
          "worktree",
          "main",
          "feature/lane-child-existing",
          fixture.projectRoot,
          null,
          0,
          fixture.laneId,
          null,
          null,
          null,
          "active",
          now,
          null
        ]
      );

      fixture.db.run(`delete from mission_steps where mission_id = ?`, [mission.id]);
      fixture.db.run(
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
          ) values
            ('mstep-pre-1', ?, ?, 0, 'Build API slice', 'Implement API changes', 'implementation', ?, 'pending', '{"stepType":"implementation","dependencyStepKeys":[]}', ?, ?, null, null),
            ('mstep-pre-2', ?, ?, 1, 'Build UI slice', 'Implement UI changes', 'implementation', ?, 'pending', '{"stepType":"implementation","dependencyStepKeys":[]}', ?, ?, null, null),
            ('mstep-pre-3', ?, ?, 2, 'Integrate and verify', 'Join outputs and verify', 'integration', ?, 'pending', '{"stepType":"integration","dependencyIndices":[0,1],"joinPolicy":"all_success"}', ?, ?, null, null)
        `,
        [
          mission.id,
          fixture.projectId,
          fixture.laneId,
          now,
          now,
          mission.id,
          fixture.projectId,
          "lane-child-existing",
          now,
          now,
          mission.id,
          fixture.projectId,
          fixture.laneId,
          now,
          now
        ]
      );

      const started = await fixture.aiOrchestratorService.startMissionRun({
        missionId: mission.id,
        runMode: "autopilot",
        defaultExecutorKind: "manual"
      });
      expect(started.blockedByPlanReview).toBe(false);
      expect(laneService.createChild).toHaveBeenCalledTimes(0);

      const refreshedMission = fixture.missionService.get(mission.id);
      expect(refreshedMission).toBeTruthy();
      const uiStep = refreshedMission!.steps.find((step) => step.id === "mstep-pre-2");
      expect(uiStep?.laneId).toBe("lane-child-existing");
    } finally {
      fixture.dispose();
    }
  });

  it("adjustPlanFromResults runs deterministic checks and logs progress", async () => {
    const fixture = await createFixture();
    try {
      const mission = fixture.missionService.create({
        prompt: "Build feature and test.",
        laneId: fixture.laneId
      });

      const launch = await fixture.aiOrchestratorService.startMissionRun({
        missionId: mission.id,
        runMode: "manual",
        defaultExecutorKind: "manual"
      });
      if (!launch.started) throw new Error("Expected mission run to start");
      const runId = launch.started.run.id;

      fixture.orchestratorService.tick({ runId });
      const graph = fixture.orchestratorService.getRunGraph({ runId });
      const readyStep = graph.steps.find((s) => s.status === "ready");
      if (!readyStep) throw new Error("Expected a ready step");

      const attempt = await fixture.orchestratorService.startAttempt({
        runId,
        stepId: readyStep.id,
        ownerId: "test-owner",
        executorKind: "manual"
      });
      fixture.orchestratorService.completeAttempt({
        attemptId: attempt.id,
        status: "succeeded"
      });

      // adjustPlanFromResults is called internally via onOrchestratorRuntimeEvent
      // This should not throw even without AI
      expect(() => {
        fixture.aiOrchestratorService.onOrchestratorRuntimeEvent({
          type: "orchestrator-attempt-updated",
          runId,
          stepId: readyStep.id,
          attemptId: attempt.id,
          at: new Date().toISOString(),
          reason: "completed"
        });
      }).not.toThrow();

      const states = fixture.aiOrchestratorService.getWorkerStates({ runId });
      expect(states.length).toBe(1);
      expect(states[0].state).toBe("completed");
    } finally {
      fixture.dispose();
    }
  });

  it("synchronizes mission step and mission status from orchestrator runtime state", async () => {
    const fixture = await createFixture();
    try {
      const mission = fixture.missionService.create({
        prompt: "Implement endpoint update, test, and summarize outcome.",
        laneId: fixture.laneId
      });

      const launch = await fixture.aiOrchestratorService.startMissionRun({
        missionId: mission.id,
        runMode: "manual",
        defaultExecutorKind: "manual"
      });
      if (!launch.started) {
        throw new Error("Expected mission run to start");
      }

      const runId = launch.started.run.id;
      let safety = 0;
      while (safety < 20) {
        safety += 1;
        const graph = fixture.orchestratorService.getRunGraph({ runId });
        if (graph.run.status === "succeeded" || graph.run.status === "failed" || graph.run.status === "canceled") {
          break;
        }
        const readySteps = graph.steps.filter((step) => step.status === "ready");
        if (!readySteps.length) {
          fixture.orchestratorService.tick({ runId });
          continue;
        }
        for (const step of readySteps) {
          const attempt = await fixture.orchestratorService.startAttempt({
            runId,
            stepId: step.id,
            ownerId: "test-owner",
            executorKind: "manual"
          });
          fixture.orchestratorService.completeAttempt({
            attemptId: attempt.id,
            status: "succeeded"
          });
          fixture.aiOrchestratorService.onOrchestratorRuntimeEvent({
            type: "orchestrator-attempt-updated",
            runId,
            stepId: step.id,
            attemptId: attempt.id,
            at: new Date().toISOString(),
            reason: "completed"
          });
        }
      }

      fixture.aiOrchestratorService.syncMissionFromRun(runId, "test_final_sync");
      const refreshed = fixture.missionService.get(mission.id);
      expect(refreshed?.status).toBe("completed");
      expect(refreshed?.steps.every((step) => step.status === "succeeded")).toBe(true);
      expect((refreshed?.outcomeSummary ?? "").length).toBeGreaterThan(0);
    } finally {
      fixture.dispose();
    }
  });

  it("persists chat and steering directives and hydrates them after service recreation", async () => {
    const fixture = await createFixture();
    try {
      const mission = fixture.missionService.create({
        prompt: "Keep chat history durable across orchestrator restarts.",
        laneId: fixture.laneId
      });

      fixture.aiOrchestratorService.sendChat({
        missionId: mission.id,
        content: "Please prioritize tests first."
      });

      const initialMessages = fixture.aiOrchestratorService.getChat({ missionId: mission.id });
      expect(initialMessages.some((entry) => entry.role === "user" && entry.content.includes("prioritize tests"))).toBe(true);
      expect(initialMessages.some((entry) => entry.role === "orchestrator" && entry.content.includes("Directive received"))).toBe(true);

      const recreatedService = createAiOrchestratorService({
        db: fixture.db,
        logger: createLogger(),
        missionService: fixture.missionService,
        orchestratorService: fixture.orchestratorService,
        projectRoot: fixture.projectRoot
      });
      const hydratedMessages = recreatedService.getChat({ missionId: mission.id });
      expect(hydratedMessages.some((entry) => entry.role === "user" && entry.content.includes("prioritize tests"))).toBe(true);

      const metaRow = fixture.db.get<{ metadata_json: string | null }>(
        `select metadata_json from missions where id = ?`,
        [mission.id]
      );
      const metadata = metaRow?.metadata_json ? JSON.parse(metaRow.metadata_json) : {};
      expect(Array.isArray(metadata.orchestratorChat)).toBe(true);
      expect(Array.isArray(metadata.steeringDirectives)).toBe(true);
      expect(
        (metadata.steeringDirectives as unknown[]).some(
          (entry) => typeof (entry as { directive?: unknown }).directive === "string"
            && String((entry as { directive?: unknown }).directive).includes("prioritize tests")
        )
      ).toBe(true);
    } finally {
      fixture.dispose();
    }
  });

  it("returns a deterministic telemetry summary for status chat prompts", async () => {
    const fixture = await createFixture();
    try {
      const mission = fixture.missionService.create({
        prompt: "Expose orchestrator telemetry on demand.",
        laneId: fixture.laneId
      });

      const launch = await fixture.aiOrchestratorService.startMissionRun({
        missionId: mission.id,
        runMode: "manual",
        defaultExecutorKind: "manual"
      });
      expect(launch.started?.run.id).toBeTruthy();

      fixture.aiOrchestratorService.sendChat({
        missionId: mission.id,
        content: "status update please"
      });

      await waitFor(() =>
        fixture.aiOrchestratorService
          .getChat({ missionId: mission.id })
          .some((entry) => entry.role === "orchestrator" && entry.content.includes("Progress"))
      );

      const messages = fixture.aiOrchestratorService.getChat({ missionId: mission.id });
      expect(messages.some((entry) => entry.role === "orchestrator" && entry.content.includes("Progress"))).toBe(true);
    } finally {
      fixture.dispose();
    }
  });

  it("reuses persisted orchestrator chat session ids across mission chat turns", async () => {
    const executeTask = vi
      .fn()
      .mockResolvedValueOnce({
        text: "Hello. I can help with this mission.",
        structuredOutput: null,
        provider: "claude",
        model: "claude-sonnet-4-6",
        sessionId: "chat-session-1",
        inputTokens: 42,
        outputTokens: 17,
        durationMs: 50
      })
      .mockResolvedValueOnce({
        text: "Second response on the same thread.",
        structuredOutput: null,
        provider: "claude",
        model: "claude-sonnet-4-6",
        sessionId: "chat-session-1",
        inputTokens: 44,
        outputTokens: 19,
        durationMs: 50
      });

    const fixture = await createFixture({
      aiIntegrationService: createMockAiIntegrationService({
        executeTask
      })
    });

    try {
      const mission = fixture.missionService.create({
        prompt: "Use a persistent orchestrator chat thread.",
        laneId: fixture.laneId
      });

      fixture.aiOrchestratorService.sendChat({
        missionId: mission.id,
        content: "hello orchestrator"
      });

      await waitFor(() =>
        fixture.aiOrchestratorService.getChat({ missionId: mission.id })
          .some((entry) => entry.role === "orchestrator" && entry.content.includes("Hello. I can help"))
      );

      fixture.aiOrchestratorService.sendChat({
        missionId: mission.id,
        content: "what's the run status?"
      });

      await waitFor(() =>
        fixture.aiOrchestratorService.getChat({ missionId: mission.id })
          .some((entry) => entry.role === "orchestrator" && entry.content.includes("Second response on the same thread"))
      );

      expect(executeTask).toHaveBeenCalledTimes(2);
      expect(executeTask.mock.calls[0]?.[0]?.sessionId).toBeUndefined();
      expect(executeTask.mock.calls[1]?.[0]?.sessionId).toBe("chat-session-1");

      const row = fixture.db.get<{ metadata_json: string | null }>(
        `select metadata_json from missions where id = ?`,
        [mission.id]
      );
      const metadata = row?.metadata_json ? JSON.parse(row.metadata_json) : {};
      expect(metadata.orchestratorChatSession).toMatchObject({
        provider: "claude",
        sessionId: "chat-session-1"
      });
    } finally {
      fixture.dispose();
    }
  });
});
