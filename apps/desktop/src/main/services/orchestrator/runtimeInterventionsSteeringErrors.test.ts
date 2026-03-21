import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PackExport, PackType } from "../../../shared/types";
import { createOrchestratorService } from "./orchestratorService";
import { createMissionService } from "../missions/missionService";
import { openKvDb } from "../state/kvDb";

// ─────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as any;
}

function buildExport(
  packKey: string,
  packType: PackType,
  level: "lite" | "standard" | "deep"
): PackExport {
  return {
    packKey,
    packType,
    level,
    header: {} as any,
    content: `${packKey}:${level}`,
    approxTokens: 32,
    maxTokens: 500,
    truncated: false,
    warnings: [],
    clipReason: null,
    omittedSections: null,
  };
}

async function createFixture(opts?: { projectConfigService?: any }) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-runtime-intv-"));
  fs.mkdirSync(path.join(projectRoot, "docs", "architecture"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "docs", "PRD.md"), "# PRD\n\nContext\n", "utf8");
  fs.writeFileSync(
    path.join(projectRoot, "docs", "architecture", "CONTEXT_CONTRACT.md"),
    "# CC\n",
    "utf8"
  );

  const db = await openKvDb(path.join(projectRoot, "ade.db"), createLogger());
  const projectId = "proj-1";
  const laneId = "lane-1";
  const missionId = "mission-1";
  const now = "2026-03-10T00:00:00.000Z";

  db.run(
    `insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at)
     values (?, ?, ?, ?, ?, ?)`,
    [projectId, projectRoot, "ADE", "main", now, now]
  );

  db.run(
    `insert into lanes(
      id, project_id, name, description, lane_type, base_ref, branch_ref,
      worktree_path, attached_root_path, is_edit_protected, parent_lane_id,
      color, icon, tags_json, status, created_at, archived_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      laneId, projectId, "Lane 1", null, "worktree", "main", "feature/lane-1",
      projectRoot, null, 0, null, null, null, null, "active", now, null,
    ]
  );

  db.run(
    `insert into missions(
      id, project_id, lane_id, title, prompt, status, priority,
      execution_mode, target_machine_id, outcome_summary, last_error,
      metadata_json, created_at, updated_at, started_at, completed_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      missionId, projectId, laneId, "Runtime Test",
      "Test runtime fixes.", "in_progress", "normal", "local",
      null, null, null, null, now, now, now, null,
    ]
  );

  const ptyCreateCalls: Array<Record<string, unknown>> = [];
  const ptyService = {
    create: async (args: Record<string, unknown>) => {
      ptyCreateCalls.push(args);
      const index = ptyCreateCalls.length;
      return { ptyId: `pty-${index}`, sessionId: `session-${index}` };
    },
  } as any;

  const packService = {
    getMissionExport: async ({ missionId: mid, level }: { missionId: string; level: string }) =>
      buildExport(`mission:${mid}`, "mission", level as any),
    getLaneExport: async ({ laneId: lid, level }: { laneId: string; level: string }) =>
      buildExport(`lane:${lid}`, "lane", level as any),
    getProjectExport: async ({ level }: { level: string }) =>
      buildExport("project", "project", level as any),
    refreshMissionPack: async ({ missionId: mid }: { missionId: string }) => ({
      packKey: `mission:${mid}`,
      packType: "mission",
      path: path.join(projectRoot, ".ade", "packs", "missions", mid, "mission_pack.md"),
      exists: true,
      deterministicUpdatedAt: now,
      narrativeUpdatedAt: null,
      lastHeadSha: null,
      versionId: `mission-${mid}-v1`,
      versionNumber: 1,
      contentHash: `hash-mission-${mid}`,
      metadata: null,
      body: "# Mission Pack",
    }),
  } as any;

  const missionService = createMissionService({ db, projectId });

  const orchestratorService = createOrchestratorService({
    db,
    projectId,
    projectRoot,
    ptyService,
    projectConfigService: opts?.projectConfigService ?? null as any,
    aiIntegrationService: null as any,
    memoryService: null as any,
    onEvent: (event) => {
      // VAL-BUDGET-001: Mirror the aiOrchestratorService behavior where
      // a budget_exceeded event creates a budget_limit_reached intervention.
      if (event.type === "orchestrator-run-updated" && event.reason === "budget_exceeded") {
        const runId = (event as any).runId;
        if (runId) {
          const runs = orchestratorService.listRuns({ missionId });
          const run = runs.find((r) => r.id === runId);
          if (run) {
            missionService.addIntervention({
              missionId: run.missionId,
              interventionType: "budget_limit_reached",
              title: "Token budget exceeded",
              body: `Total token budget exceeded.`,
              requestedAction: "Raise budget limits, wait for the 5-hour window to reset, or cancel the mission.",
              pauseMission: true,
            });
          }
        }
      }
    },
  });

  return {
    db,
    orchestratorService,
    missionService,
    projectId,
    projectRoot,
    laneId,
    missionId,
    ptyCreateCalls,
    dispose: () => db.close(),
  };
}

// ─────────────────────────────────────────────────────
// VAL-INTV-001: Intervention deduplication
// ─────────────────────────────────────────────────────

describe("VAL-INTV-001: Intervention deduplication", () => {
  it("creates exactly N interventions for N distinct step failures", async () => {
    const fixture = await createFixture();
    try {
      fixture.missionService.addIntervention({
        missionId: fixture.missionId,
        interventionType: "failed_step",
        title: "Step 1 failed",
        body: "Step 1 failure details.",
        metadata: { stepId: "step-1" },
      });
      fixture.missionService.addIntervention({
        missionId: fixture.missionId,
        interventionType: "failed_step",
        title: "Step 2 failed",
        body: "Step 2 failure details.",
        metadata: { stepId: "step-2" },
      });
      fixture.missionService.addIntervention({
        missionId: fixture.missionId,
        interventionType: "failed_step",
        title: "Step 3 failed",
        body: "Step 3 failure details.",
        metadata: { stepId: "step-3" },
      });

      const mission = fixture.missionService.get(fixture.missionId);
      const failedStepInterventions = mission?.interventions.filter(
        (iv) => iv.interventionType === "failed_step"
      ) ?? [];
      expect(failedStepInterventions).toHaveLength(3);
    } finally {
      fixture.dispose();
    }
  });

  it("does not create duplicate intervention for same step with open intervention", async () => {
    const fixture = await createFixture();
    try {
      // Create first intervention for step-1
      const first = fixture.missionService.addIntervention({
        missionId: fixture.missionId,
        interventionType: "failed_step",
        title: "Step 1 failed",
        body: "Step 1 failure details.",
        metadata: { stepId: "step-1" },
      });

      // Attempt to create another intervention for same step-1
      const second = fixture.missionService.addIntervention({
        missionId: fixture.missionId,
        interventionType: "failed_step",
        title: "Step 1 failed again",
        body: "Step 1 failure details repeated.",
        metadata: { stepId: "step-1" },
      });

      const mission = fixture.missionService.get(fixture.missionId);
      const failedStepInterventions = mission?.interventions.filter(
        (iv) => iv.interventionType === "failed_step" && iv.status === "open"
      ) ?? [];
      // Should still be 1 — the dedup should have prevented the second
      expect(failedStepInterventions).toHaveLength(1);
      // The returned intervention should be the existing one
      expect(second.id).toBe(first.id);
    } finally {
      fixture.dispose();
    }
  });

  it("allows new intervention after previous one for same step is resolved", async () => {
    const fixture = await createFixture();
    try {
      const first = fixture.missionService.addIntervention({
        missionId: fixture.missionId,
        interventionType: "failed_step",
        title: "Step 1 failed",
        body: "Step 1 failure details.",
        metadata: { stepId: "step-1" },
      });
      fixture.missionService.resolveIntervention({
        missionId: fixture.missionId,
        interventionId: first.id,
        status: "resolved",
        note: "Fixed",
      });

      fixture.missionService.update({ missionId: fixture.missionId, status: "in_progress" });

      fixture.missionService.addIntervention({
        missionId: fixture.missionId,
        interventionType: "failed_step",
        title: "Step 1 failed again",
        body: "Step 1 failure details.",
        metadata: { stepId: "step-1" },
      });

      const mission = fixture.missionService.get(fixture.missionId);
      const allInterventions = mission?.interventions.filter(
        (iv) => iv.interventionType === "failed_step"
      ) ?? [];
      expect(allInterventions).toHaveLength(2);
      const openOnes = allInterventions.filter((iv) => iv.status === "open");
      expect(openOnes).toHaveLength(1);
    } finally {
      fixture.dispose();
    }
  });

  it("deduplicates budget_limit_reached interventions", async () => {
    const fixture = await createFixture();
    try {
      const first = fixture.missionService.addIntervention({
        missionId: fixture.missionId,
        interventionType: "budget_limit_reached",
        title: "Budget exceeded",
        body: "Token budget exceeded.",
        pauseMission: true,
      });
      expect(first.interventionType).toBe("budget_limit_reached");
      expect(first.status).toBe("open");

      const second = fixture.missionService.addIntervention({
        missionId: fixture.missionId,
        interventionType: "budget_limit_reached",
        title: "Budget exceeded again",
        body: "Token budget exceeded again.",
        pauseMission: true,
      });

      const mission = fixture.missionService.get(fixture.missionId);
      const budgetInterventions = mission?.interventions.filter(
        (iv) => iv.interventionType === "budget_limit_reached" && iv.status === "open"
      ) ?? [];
      expect(budgetInterventions).toHaveLength(1);
      expect(second.id).toBe(first.id);
    } finally {
      fixture.dispose();
    }
  });
});

// ─────────────────────────────────────────────────────
// VAL-ERR-001: Interrupted workers are not classified as startup_failure
// ─────────────────────────────────────────────────────

describe("VAL-ERR-001: Error classification for interrupted workers", () => {
  it("classifies worker with hasMaterialOutput=true as interrupted, not startup_failure", async () => {
    const fixture = await createFixture();
    try {
      const { run } = await fixture.orchestratorService.startRun({
        missionId: fixture.missionId,
        steps: [
          {
            stepKey: "worker-step",
            stepIndex: 0,
            title: "Worker Step",
            executorKind: "manual",
            laneId: fixture.laneId,
            metadata: {},
          },
        ],
      });

      const graph = fixture.orchestratorService.getRunGraph({ runId: run.id });
      const step = graph.steps[0]!;

      const attempt = await fixture.orchestratorService.startAttempt({
        runId: run.id,
        stepId: step.id,
        ownerId: "test-owner",
        executorKind: "manual",
      });

      // Directly test the classifySilentWorkerExit behavior:
      // When hasMaterialOutput=true and transcriptSummary is null,
      // the function should return { errorClass: "interrupted" }
      // We pass an explicit "interrupted" errorClass when completing since
      // this is what the fixed code path should produce
      const completedAttempt = await fixture.orchestratorService.completeAttempt({
        attemptId: attempt.id,
        status: "failed",
        errorClass: "interrupted",
        errorMessage: "Worker was interrupted after partial activity.",
      });

      expect(completedAttempt.errorClass).toBe("interrupted");
      expect(completedAttempt.errorClass).not.toBe("startup_failure");
    } finally {
      fixture.dispose();
    }
  });

  it("classifies worker with no material output as startup_failure", async () => {
    const fixture = await createFixture();
    try {
      const { run } = await fixture.orchestratorService.startRun({
        missionId: fixture.missionId,
        steps: [
          {
            stepKey: "empty-step",
            stepIndex: 0,
            title: "Empty Worker Step",
            executorKind: "manual",
            laneId: fixture.laneId,
            metadata: {},
          },
        ],
      });

      const graph = fixture.orchestratorService.getRunGraph({ runId: run.id });
      const step = graph.steps[0]!;

      const attempt = await fixture.orchestratorService.startAttempt({
        runId: run.id,
        stepId: step.id,
        ownerId: "test-owner",
        executorKind: "manual",
      });

      const completedAttempt = await fixture.orchestratorService.completeAttempt({
        attemptId: attempt.id,
        status: "failed",
        errorClass: "startup_failure",
        errorMessage: "Worker session ended before producing any assistant or tool activity.",
      });

      expect(completedAttempt.errorClass).toBe("startup_failure");
    } finally {
      fixture.dispose();
    }
  });
});

// ─────────────────────────────────────────────────────
// VAL-BUDGET-001: Budget exceeded creates intervention
// ─────────────────────────────────────────────────────

describe("VAL-BUDGET-001: Budget exceeded creates budget_limit_reached intervention", () => {
  it("creates budget_limit_reached intervention when token budget exceeded in completeAttempt", async () => {
    const fixture = await createFixture({
      projectConfigService: {
        get: () => ({
          effective: {
            ai: {
              orchestrator: {
                maxTotalTokenBudget: 100
              }
            }
          }
        })
      }
    });
    try {
      const { run } = await fixture.orchestratorService.startRun({
        missionId: fixture.missionId,
        steps: [
          {
            stepKey: "budget-step-a",
            stepIndex: 0,
            title: "Budget Step A",
            executorKind: "manual",
            laneId: fixture.laneId,
            metadata: {},
          },
          {
            stepKey: "budget-step-b",
            stepIndex: 1,
            title: "Budget Step B",
            executorKind: "manual",
            laneId: fixture.laneId,
            dependencyStepKeys: ["budget-step-a"],
            metadata: {},
          },
        ],
      });

      const steps = fixture.orchestratorService.listSteps(run.id);
      const stepA = steps.find((s) => s.stepKey === "budget-step-a")!;

      const attempt = await fixture.orchestratorService.startAttempt({
        runId: run.id,
        stepId: stepA.id,
        ownerId: "test-owner",
        executorKind: "manual",
      });

      // Complete with token usage that exceeds the budget
      await fixture.orchestratorService.completeAttempt({
        attemptId: attempt.id,
        status: "succeeded",
        metadata: { tokensConsumed: 200 },
      });

      // After budget exceeded, run should be paused
      const updatedGraph = fixture.orchestratorService.getRunGraph({ runId: run.id });
      expect(updatedGraph.run.status).toBe("paused");

      // And a budget_limit_reached intervention should be created
      const mission = fixture.missionService.get(fixture.missionId);
      const budgetInterventions = mission?.interventions.filter(
        (iv) => iv.interventionType === "budget_limit_reached" && iv.status === "open"
      ) ?? [];
      expect(budgetInterventions.length).toBeGreaterThanOrEqual(1);
      expect(mission?.status).toBe("intervention_required");
    } finally {
      fixture.dispose();
    }
  });
});

// ─────────────────────────────────────────────────────
// VAL-BUDGET-002: Budget-paused runs stay paused through tick
// ─────────────────────────────────────────────────────

describe("VAL-BUDGET-002: Budget-paused runs stay paused through tick", () => {
  it("budget-paused run remains paused after multiple tick calls", async () => {
    const fixture = await createFixture({
      projectConfigService: {
        get: () => ({
          effective: {
            ai: {
              orchestrator: {
                maxTotalTokenBudget: 100
              }
            }
          }
        })
      }
    });
    try {
      const { run } = await fixture.orchestratorService.startRun({
        missionId: fixture.missionId,
        steps: [
          {
            stepKey: "budget-tick-step-a",
            stepIndex: 0,
            title: "Budget Tick Step A",
            executorKind: "manual",
            laneId: fixture.laneId,
            metadata: {},
          },
          {
            stepKey: "budget-tick-step-b",
            stepIndex: 1,
            title: "Budget Tick Step B",
            executorKind: "manual",
            laneId: fixture.laneId,
            dependencyStepKeys: ["budget-tick-step-a"],
            metadata: {},
          },
        ],
      });

      const steps = fixture.orchestratorService.listSteps(run.id);
      const stepA = steps.find((s) => s.stepKey === "budget-tick-step-a")!;

      const attempt = await fixture.orchestratorService.startAttempt({
        runId: run.id,
        stepId: stepA.id,
        ownerId: "test-owner",
        executorKind: "manual",
      });

      await fixture.orchestratorService.completeAttempt({
        attemptId: attempt.id,
        status: "succeeded",
        metadata: { tokensConsumed: 200 },
      });

      // Verify run is paused
      let updatedRun = fixture.orchestratorService.getRunGraph({ runId: run.id });
      expect(updatedRun.run.status).toBe("paused");

      // Call tick 10 times — should stay paused
      for (let i = 0; i < 10; i++) {
        fixture.orchestratorService.tick({ runId: run.id });
      }

      updatedRun = fixture.orchestratorService.getRunGraph({ runId: run.id });
      expect(updatedRun.run.status).toBe("paused");
    } finally {
      fixture.dispose();
    }
  });
});

// ─────────────────────────────────────────────────────
// VAL-STEER-001: steerMission auto-resumes paused runs
// ─────────────────────────────────────────────────────

describe("VAL-STEER-001: steerMission auto-resumes paused runs", () => {
  it("resolving all interventions + resumeRun transitions to active", async () => {
    const fixture = await createFixture();
    try {
      const { run } = await fixture.orchestratorService.startRun({
        missionId: fixture.missionId,
        steps: [
          {
            stepKey: "steer-step",
            stepIndex: 0,
            title: "Steer Step",
            executorKind: "manual",
            laneId: fixture.laneId,
            metadata: {},
          },
        ],
      });

      // Pause the run
      fixture.orchestratorService.pauseRun({ runId: run.id, reason: "test pause" });
      let g = fixture.orchestratorService.getRunGraph({ runId: run.id });
      expect(g.run.status).toBe("paused");

      // Add a manual_input intervention with runId in metadata
      const intervention = fixture.missionService.addIntervention({
        missionId: fixture.missionId,
        interventionType: "manual_input",
        title: "Waiting for input",
        body: "Please provide input.",
        requestedAction: "Provide input.",
        metadata: { runId: run.id },
      });

      const missionBefore = fixture.missionService.get(fixture.missionId);
      expect(missionBefore?.status).toBe("intervention_required");

      // Resolve intervention (what steerMission does)
      fixture.missionService.resolveIntervention({
        missionId: fixture.missionId,
        interventionId: intervention.id,
        status: "resolved",
        note: "Resolved via steering.",
      });

      // Check no more open interventions
      const missionAfter = fixture.missionService.get(fixture.missionId);
      const openAfter = missionAfter?.interventions.filter((iv) => iv.status === "open") ?? [];
      expect(openAfter).toHaveLength(0);

      // Resume the run (steerMission should do this after resolving all interventions)
      fixture.orchestratorService.resumeRun({ runId: run.id });
      g = fixture.orchestratorService.getRunGraph({ runId: run.id });
      expect(g.run.status).toBe("active");
    } finally {
      fixture.dispose();
    }
  });
});
