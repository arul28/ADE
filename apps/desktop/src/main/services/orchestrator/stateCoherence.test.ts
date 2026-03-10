import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PackExport, PackType } from "../../../shared/types";
import { createOrchestratorService } from "./orchestratorService";
import { transitionMissionStatus } from "./missionLifecycle";
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

async function createFixture() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-state-coherence-"));
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
      missionId, projectId, laneId, "State Coherence Test",
      "Test state coherence.", "in_progress", "normal", "local",
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

  const orchestratorService = createOrchestratorService({
    db,
    projectId,
    projectRoot,
    packService,
    ptyService,
    projectConfigService: null as any,
    aiIntegrationService: null as any,
    memoryService: null as any,
  });

  const missionService = createMissionService({ db, projectId });

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
// VAL-STATE-001: Mission → intervention_required pauses active runs
// ─────────────────────────────────────────────────────

describe("VAL-STATE-001: intervention_required pauses active runs", () => {
  it("pauses active run before transitioning mission to intervention_required", async () => {
    const fixture = await createFixture();
    try {
      const { run } = await fixture.orchestratorService.startRun({
        missionId: fixture.missionId,
        steps: [
          {
            stepKey: "step-1",
            stepIndex: 0,
            title: "Step 1",
            executorKind: "manual",
            laneId: fixture.laneId,
            metadata: {},
          },
        ],
      });

      // Verify run is in a non-paused state (bootstrapping or active)
      const graph = fixture.orchestratorService.getRunGraph({ runId: run.id });
      expect(["active", "bootstrapping"]).toContain(graph.run.status);
      expect(graph.run.status).not.toBe("paused");

      // Build OrchestratorContext for transitionMissionStatus
      const ctx = {
        db: fixture.db,
        logger: createLogger(),
        missionService: fixture.missionService,
        orchestratorService: fixture.orchestratorService,
        projectRoot: fixture.projectRoot,
        hookCommandRunner: async () => ({
          exitCode: 0,
          signal: null,
          timedOut: false,
          durationMs: 0,
          stdout: "",
          stderr: "",
          spawnError: null,
        }),
        // All required context fields (minimal stubs)
        agentChatService: null,
        laneService: null,
        projectConfigService: null,
        aiIntegrationService: null,
        prService: null,
        missionBudgetService: null,
        onThreadEvent: undefined,
        onDagMutation: undefined,
        syncLocks: new Set<string>(),
        workerStates: new Map(),
        activeSteeringDirectives: new Map(),
        runRuntimeProfiles: new Map(),
        chatMessages: new Map(),
        activeChatSessions: new Map(),
        chatTurnQueues: new Map(),
        activeHealthSweepRuns: new Set<string>(),
        sessionRuntimeSignals: new Map(),
        attemptRuntimeTrackers: new Map(),
        sessionSignalQueues: new Map(),
        workerDeliveryThreadQueues: new Map(),
        workerDeliveryInterventionCooldowns: new Map(),
        runTeamManifests: new Map(),
        runRecoveryLoopStates: new Map(),
        aiTimeoutBudgetStepLocks: new Set<string>(),
        aiTimeoutBudgetRunLocks: new Set<string>(),
        aiRetryDecisionLocks: new Set<string>(),
        coordinatorSessions: new Map(),
        pendingIntegrations: new Map(),
        coordinatorThinkingLoops: new Map(),
        pendingCoordinatorEvals: new Map(),
        coordinatorAgents: new Map(),
        coordinatorRecoveryAttempts: new Map(),
        teamRuntimeStates: new Map(),
        callTypeConfigCache: new Map(),
        disposed: { current: false },
        healthSweepTimer: { current: null },
      } as any;

      // Transition mission to intervention_required
      transitionMissionStatus(ctx, fixture.missionId, "intervention_required", {
        lastError: "Step failed, needs intervention",
      });

      // After transition, the run should be paused (not active)
      const updatedGraph = fixture.orchestratorService.getRunGraph({ runId: run.id });
      expect(updatedGraph.run.status).toBe("paused");

      // Mission should be intervention_required
      const mission = fixture.missionService.get(fixture.missionId);
      expect(mission?.status).toBe("intervention_required");
    } finally {
      fixture.dispose();
    }
  });

  it("does NOT pause runs for transitions other than intervention_required", async () => {
    const fixture = await createFixture();
    try {
      const { run } = await fixture.orchestratorService.startRun({
        missionId: fixture.missionId,
        steps: [
          {
            stepKey: "step-1",
            stepIndex: 0,
            title: "Step 1",
            executorKind: "manual",
            laneId: fixture.laneId,
            metadata: {},
          },
        ],
      });

      const ctx = {
        db: fixture.db,
        logger: createLogger(),
        missionService: fixture.missionService,
        orchestratorService: fixture.orchestratorService,
        projectRoot: fixture.projectRoot,
        hookCommandRunner: async () => ({
          exitCode: 0,
          signal: null,
          timedOut: false,
          durationMs: 0,
          stdout: "",
          stderr: "",
          spawnError: null,
        }),
        agentChatService: null,
        laneService: null,
        projectConfigService: null,
        aiIntegrationService: null,
        prService: null,
        missionBudgetService: null,
        onThreadEvent: undefined,
        onDagMutation: undefined,
        syncLocks: new Set<string>(),
        workerStates: new Map(),
        activeSteeringDirectives: new Map(),
        runRuntimeProfiles: new Map(),
        chatMessages: new Map(),
        activeChatSessions: new Map(),
        chatTurnQueues: new Map(),
        activeHealthSweepRuns: new Set<string>(),
        sessionRuntimeSignals: new Map(),
        attemptRuntimeTrackers: new Map(),
        sessionSignalQueues: new Map(),
        workerDeliveryThreadQueues: new Map(),
        workerDeliveryInterventionCooldowns: new Map(),
        runTeamManifests: new Map(),
        runRecoveryLoopStates: new Map(),
        aiTimeoutBudgetStepLocks: new Set<string>(),
        aiTimeoutBudgetRunLocks: new Set<string>(),
        aiRetryDecisionLocks: new Set<string>(),
        coordinatorSessions: new Map(),
        pendingIntegrations: new Map(),
        coordinatorThinkingLoops: new Map(),
        pendingCoordinatorEvals: new Map(),
        coordinatorAgents: new Map(),
        coordinatorRecoveryAttempts: new Map(),
        teamRuntimeStates: new Map(),
        callTypeConfigCache: new Map(),
        disposed: { current: false },
        healthSweepTimer: { current: null },
      } as any;

      // Transition to in_progress (should NOT pause the run)
      transitionMissionStatus(ctx, fixture.missionId, "in_progress");

      // Run starts as bootstrapping, verify it stays non-paused
      const graph = fixture.orchestratorService.getRunGraph({ runId: run.id });
      expect(["active", "bootstrapping"]).toContain(graph.run.status);
      expect(graph.run.status).not.toBe("paused");
    } finally {
      fixture.dispose();
    }
  });

  it("handles missions with no active runs gracefully", async () => {
    const fixture = await createFixture();
    try {
      // Don't start any run, just transition to intervention_required
      const ctx = {
        db: fixture.db,
        logger: createLogger(),
        missionService: fixture.missionService,
        orchestratorService: fixture.orchestratorService,
        projectRoot: fixture.projectRoot,
        hookCommandRunner: async () => ({
          exitCode: 0,
          signal: null,
          timedOut: false,
          durationMs: 0,
          stdout: "",
          stderr: "",
          spawnError: null,
        }),
        agentChatService: null,
        laneService: null,
        projectConfigService: null,
        aiIntegrationService: null,
        prService: null,
        missionBudgetService: null,
        onThreadEvent: undefined,
        onDagMutation: undefined,
        syncLocks: new Set<string>(),
        workerStates: new Map(),
        activeSteeringDirectives: new Map(),
        runRuntimeProfiles: new Map(),
        chatMessages: new Map(),
        activeChatSessions: new Map(),
        chatTurnQueues: new Map(),
        activeHealthSweepRuns: new Set<string>(),
        sessionRuntimeSignals: new Map(),
        attemptRuntimeTrackers: new Map(),
        sessionSignalQueues: new Map(),
        workerDeliveryThreadQueues: new Map(),
        workerDeliveryInterventionCooldowns: new Map(),
        runTeamManifests: new Map(),
        runRecoveryLoopStates: new Map(),
        aiTimeoutBudgetStepLocks: new Set<string>(),
        aiTimeoutBudgetRunLocks: new Set<string>(),
        aiRetryDecisionLocks: new Set<string>(),
        coordinatorSessions: new Map(),
        pendingIntegrations: new Map(),
        coordinatorThinkingLoops: new Map(),
        pendingCoordinatorEvals: new Map(),
        coordinatorAgents: new Map(),
        coordinatorRecoveryAttempts: new Map(),
        teamRuntimeStates: new Map(),
        callTypeConfigCache: new Map(),
        disposed: { current: false },
        healthSweepTimer: { current: null },
      } as any;

      // Should not throw
      transitionMissionStatus(ctx, fixture.missionId, "intervention_required", {
        lastError: "Something happened",
      });

      const mission = fixture.missionService.get(fixture.missionId);
      expect(mission?.status).toBe("intervention_required");
    } finally {
      fixture.dispose();
    }
  });
});

// ─────────────────────────────────────────────────────
// VAL-STATE-002: Parent step reflects spawned variant outcomes
// ─────────────────────────────────────────────────────

describe("VAL-STATE-002: Parent step status reflects variant outcomes", () => {
  it("marks parent step as failed when all fan-out children fail", async () => {
    const fixture = await createFixture();
    try {
      // Create a run with a parent step + fan-out children
      const { run } = await fixture.orchestratorService.startRun({
        missionId: fixture.missionId,
        steps: [
          {
            stepKey: "parent-step",
            stepIndex: 0,
            title: "Parent Step",
            executorKind: "manual",
            laneId: fixture.laneId,
            metadata: {},
          },
        ],
      });

      // Now create fan-out children from the parent
      const graph = fixture.orchestratorService.getRunGraph({ runId: run.id });
      const parentStep = graph.steps.find((s) => s.stepKey === "parent-step");
      expect(parentStep).toBeDefined();

      // Add fan-out children via addSteps
      const addedSteps = fixture.orchestratorService.addSteps({
        runId: run.id,
        steps: [
          {
            stepKey: "childA",
            stepIndex: 1,
            title: "Variant A",
            executorKind: "manual",
            laneId: fixture.laneId,
            metadata: { fanOutParent: "parent-step" },
            dependencyStepKeys: ["parent-step"],
          },
          {
            stepKey: "childB",
            stepIndex: 2,
            title: "Variant B",
            executorKind: "manual",
            laneId: fixture.laneId,
            metadata: { fanOutParent: "parent-step" },
            dependencyStepKeys: ["parent-step"],
          },
          {
            stepKey: "childC",
            stepIndex: 3,
            title: "Variant C",
            executorKind: "manual",
            laneId: fixture.laneId,
            metadata: { fanOutParent: "parent-step" },
            dependencyStepKeys: ["parent-step"],
          },
        ],
      });

      // Update parent metadata with fanOutChildren
      const parentId = parentStep!.id;
      fixture.db.run(
        `update orchestrator_steps set metadata_json = ?, status = 'succeeded', completed_at = ? where id = ? and project_id = ?`,
        [
          JSON.stringify({
            fanOutChildren: ["childA", "childB", "childC"],
            fanOutComplete: false,
          }),
          new Date().toISOString(),
          parentId,
          fixture.projectId,
        ]
      );

      // Get the child step IDs
      const updatedGraph = fixture.orchestratorService.getRunGraph({ runId: run.id });
      const childSteps = updatedGraph.steps.filter((s) => s.stepKey.startsWith("child"));
      expect(childSteps.length).toBe(3);

      // Make children ready
      for (const child of childSteps) {
        fixture.db.run(
          `update orchestrator_steps set status = 'ready' where id = ? and project_id = ?`,
          [child.id, fixture.projectId]
        );
      }

      // Start and fail all 3 children
      for (const child of childSteps) {
        const attempt = await fixture.orchestratorService.startAttempt({
          runId: run.id,
          stepId: child.id,
          ownerId: "test-owner",
          executorKind: "manual",
        });

        await fixture.orchestratorService.completeAttempt({
          attemptId: attempt.id,
          status: "failed",
          errorClass: "executor_failure",
          errorMessage: `Variant ${child.stepKey} failed`,
        });
      }

      // Check parent step status — should be 'failed' since all children failed
      const finalGraph = fixture.orchestratorService.getRunGraph({ runId: run.id });
      const finalParent = finalGraph.steps.find((s) => s.stepKey === "parent-step");
      expect(finalParent).toBeDefined();
      expect(finalParent!.status).toBe("failed");
    } finally {
      fixture.dispose();
    }
  });

  it("marks parent step as succeeded when at least one fan-out child succeeds", async () => {
    const fixture = await createFixture();
    try {
      const { run } = await fixture.orchestratorService.startRun({
        missionId: fixture.missionId,
        steps: [
          {
            stepKey: "parent-step",
            stepIndex: 0,
            title: "Parent Step",
            executorKind: "manual",
            laneId: fixture.laneId,
            metadata: {},
          },
        ],
      });

      const graph = fixture.orchestratorService.getRunGraph({ runId: run.id });
      const parentStep = graph.steps.find((s) => s.stepKey === "parent-step");
      expect(parentStep).toBeDefined();

      // Add fan-out children
      fixture.orchestratorService.addSteps({
        runId: run.id,
        steps: [
          {
            stepKey: "childA",
            stepIndex: 1,
            title: "Variant A",
            executorKind: "manual",
            laneId: fixture.laneId,
            metadata: { fanOutParent: "parent-step" },
            dependencyStepKeys: ["parent-step"],
          },
          {
            stepKey: "childB",
            stepIndex: 2,
            title: "Variant B",
            executorKind: "manual",
            laneId: fixture.laneId,
            metadata: { fanOutParent: "parent-step" },
            dependencyStepKeys: ["parent-step"],
          },
          {
            stepKey: "childC",
            stepIndex: 3,
            title: "Variant C",
            executorKind: "manual",
            laneId: fixture.laneId,
            metadata: { fanOutParent: "parent-step" },
            dependencyStepKeys: ["parent-step"],
          },
        ],
      });

      // Update parent metadata with fanOutChildren and mark as succeeded
      const parentId = parentStep!.id;
      fixture.db.run(
        `update orchestrator_steps set metadata_json = ?, status = 'succeeded', completed_at = ? where id = ? and project_id = ?`,
        [
          JSON.stringify({
            fanOutChildren: ["childA", "childB", "childC"],
            fanOutComplete: false,
          }),
          new Date().toISOString(),
          parentId,
          fixture.projectId,
        ]
      );

      // Get children and make them ready
      const updatedGraph = fixture.orchestratorService.getRunGraph({ runId: run.id });
      const childSteps = updatedGraph.steps.filter((s) => s.stepKey.startsWith("child"));

      for (const child of childSteps) {
        fixture.db.run(
          `update orchestrator_steps set status = 'ready' where id = ? and project_id = ?`,
          [child.id, fixture.projectId]
        );
      }

      // Fail first two children, succeed the third
      for (let i = 0; i < childSteps.length; i++) {
        const child = childSteps[i];
        const attempt = await fixture.orchestratorService.startAttempt({
          runId: run.id,
          stepId: child.id,
          ownerId: "test-owner",
          executorKind: "manual",
        });

        if (i < 2) {
          await fixture.orchestratorService.completeAttempt({
            attemptId: attempt.id,
            status: "failed",
            errorClass: "executor_failure",
            errorMessage: `Variant ${child.stepKey} failed`,
          });
        } else {
          await fixture.orchestratorService.completeAttempt({
            attemptId: attempt.id,
            status: "succeeded",
          });
        }
      }

      // Check parent step — should be 'succeeded' since at least one child succeeded
      const finalGraph = fixture.orchestratorService.getRunGraph({ runId: run.id });
      const finalParent = finalGraph.steps.find((s) => s.stepKey === "parent-step");
      expect(finalParent).toBeDefined();
      expect(finalParent!.status).toBe("succeeded");
    } finally {
      fixture.dispose();
    }
  });

  it("does not change parent step status when children are still running", async () => {
    const fixture = await createFixture();
    try {
      const { run } = await fixture.orchestratorService.startRun({
        missionId: fixture.missionId,
        steps: [
          {
            stepKey: "parent-step",
            stepIndex: 0,
            title: "Parent Step",
            executorKind: "manual",
            laneId: fixture.laneId,
            metadata: {},
          },
        ],
      });

      const graph = fixture.orchestratorService.getRunGraph({ runId: run.id });
      const parentStep = graph.steps.find((s) => s.stepKey === "parent-step");

      // Add 2 fan-out children
      fixture.orchestratorService.addSteps({
        runId: run.id,
        steps: [
          {
            stepKey: "childA",
            stepIndex: 1,
            title: "Variant A",
            executorKind: "manual",
            laneId: fixture.laneId,
            metadata: { fanOutParent: "parent-step" },
            dependencyStepKeys: ["parent-step"],
          },
          {
            stepKey: "childB",
            stepIndex: 2,
            title: "Variant B",
            executorKind: "manual",
            laneId: fixture.laneId,
            metadata: { fanOutParent: "parent-step" },
            dependencyStepKeys: ["parent-step"],
          },
        ],
      });

      // Update parent
      fixture.db.run(
        `update orchestrator_steps set metadata_json = ?, status = 'succeeded', completed_at = ? where id = ? and project_id = ?`,
        [
          JSON.stringify({
            fanOutChildren: ["childA", "childB"],
            fanOutComplete: false,
          }),
          new Date().toISOString(),
          parentStep!.id,
          fixture.projectId,
        ]
      );

      // Make first child ready, fail it
      const updatedGraph = fixture.orchestratorService.getRunGraph({ runId: run.id });
      const firstChild = updatedGraph.steps.find((s) => s.stepKey === "childA");
      fixture.db.run(
        `update orchestrator_steps set status = 'ready' where id = ? and project_id = ?`,
        [firstChild!.id, fixture.projectId]
      );

      const attempt = await fixture.orchestratorService.startAttempt({
        runId: run.id,
        stepId: firstChild!.id,
        ownerId: "test-owner",
        executorKind: "manual",
      });

      await fixture.orchestratorService.completeAttempt({
        attemptId: attempt.id,
        status: "failed",
        errorClass: "executor_failure",
        errorMessage: "First child failed",
      });

      // Parent should remain 'succeeded' (its pre-fanout status) since second child not yet terminal
      const finalGraph = fixture.orchestratorService.getRunGraph({ runId: run.id });
      const finalParent = finalGraph.steps.find((s) => s.stepKey === "parent-step");
      expect(finalParent!.status).toBe("succeeded");
    } finally {
      fixture.dispose();
    }
  });
});
