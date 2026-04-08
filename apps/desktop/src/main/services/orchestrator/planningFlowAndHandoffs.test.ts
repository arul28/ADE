import { describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { buildFullPrompt } from "./baseOrchestratorAdapter";
import { createOrchestratorService } from "./orchestratorService";
import { openKvDb } from "../state/kvDb";
import { classifyBlockingWarnings } from "./orchestratorQueries";
import type { OrchestratorAttemptResultEnvelope } from "../../../shared/types/orchestrator";
import type { PackExport, PackType } from "../../../shared/types";

// ── Shared Helpers ──────────────────────────────────────────────

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
  level: string
): PackExport {
  return {
    packKey,
    packType,
    level: level as any,
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
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-planning-flow-"));
  const db = await openKvDb(path.join(projectRoot, "ade.db"), createLogger());
  const projectId = "proj-1";
  const laneId = "lane-1";
  const missionId = "mission-1";
  const runId = "run-1";
  const now = "2026-03-10T00:00:00.000Z";

  db.run(
    `insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at)
     values (?, ?, ?, ?, ?, ?)`,
    [projectId, projectRoot, "ADE", "main", now, now]
  );

  const worktreePath = path.join(projectRoot, "worktree-lane-1");
  fs.mkdirSync(worktreePath, { recursive: true });

  db.run(
    `insert into lanes(
      id, project_id, name, description, lane_type, base_ref, branch_ref,
      worktree_path, attached_root_path, is_edit_protected, parent_lane_id,
      color, icon, tags_json, status, created_at, archived_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      laneId, projectId, "Lane 1", null, "worktree", "main", "feature/lane-1",
      worktreePath, null, 0, null, null, null, null, "active", now, null,
    ]
  );

  db.run(
    `insert into missions(
      id, project_id, lane_id, title, prompt, status, priority,
      execution_mode, target_machine_id, outcome_summary, last_error,
      metadata_json, created_at, updated_at, started_at, completed_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      missionId, projectId, laneId, "Mission 1", "Test planning flow.",
      "in_progress", "normal", "local", null, null, null, null, now, now, null, null,
    ]
  );

  const ptyService = {
    create: async () => ({ ptyId: "pty-1", sessionId: "session-1" }),
  } as any;

  const service = createOrchestratorService({
    db,
    projectId,
    projectRoot,
    ptyService,
    projectConfigService: null as any,
    aiIntegrationService: null as any,
    memoryService: null as any,
  });

  return {
    db,
    service,
    projectId,
    projectRoot,
    laneId,
    missionId,
    runId,
    worktreePath,
    now,
    dispose: () => {
      db.close();
      fs.rmSync(projectRoot, { recursive: true, force: true });
    },
  };
}

// ─────────────────────────────────────────────────────────────────
// VAL-PLAN-001: Planning workers return plan payloads instead of writing files
// ─────────────────────────────────────────────────────────────────

describe("VAL-PLAN-001: Planning workers return plan payloads", () => {
  it("buildFullPrompt for planning step forbids plan file writes and requires report_result plan payload", () => {
    const result = buildFullPrompt(
      {
        run: {
          id: "run-1",
          missionId: "mission-1",
          metadata: { missionGoal: "Plan the feature" },
        } as any,
        step: {
          id: "step-1",
          title: "Plan the feature",
          stepKey: "plan-feature",
          laneId: "lane-1",
          metadata: {
            stepType: "planning",
            readOnlyExecution: true,
            laneWorktreePath: "/tmp/worktree/lane-1",
          },
          dependencyStepIds: [],
          joinPolicy: "all_success",
        } as any,
        attempt: {} as any,
        allSteps: [],
        contextProfile: {} as any,
        laneExport: null,
        projectExport: { content: "Project context" } as any,
        docsRefs: [],
        fullDocs: [],
        createTrackedSession: async () => ({ ptyId: "pty-1", sessionId: "session-1" }),
      },
      "opencode",
      {}
    );

    expect(result.prompt).toContain("Do not create directories or write plan files yourself.");
    expect(result.prompt).toContain("plan` object");
    expect(result.prompt).toContain("ADE will persist the canonical mission plan artifact");
  });

  it("planning step prompt includes 'Do not use ExitPlanMode' instruction", () => {
    const result = buildFullPrompt(
      {
        run: {
          id: "run-1",
          missionId: "mission-1",
          metadata: { missionGoal: "Plan the feature" },
        } as any,
        step: {
          id: "step-1",
          title: "Plan the feature",
          stepKey: "plan-feature",
          laneId: "lane-1",
          metadata: {
            stepType: "planning",
            readOnlyExecution: true,
          },
          dependencyStepIds: [],
          joinPolicy: "all_success",
        } as any,
        attempt: {} as any,
        allSteps: [],
        contextProfile: {} as any,
        laneExport: null,
        projectExport: { content: "Project context" } as any,
        docsRefs: [],
        fullDocs: [],
        createTrackedSession: async () => ({ ptyId: "pty-1", sessionId: "session-1" }),
      },
      "opencode",
      {}
    );

    expect(result.prompt.toLowerCase()).toContain("do not use exitplanmode");
  });
});

// ─────────────────────────────────────────────────────────────────
// VAL-PLAN-002: ExitPlanMode errors handled gracefully
// ─────────────────────────────────────────────────────────────────

describe("VAL-PLAN-002: planning worker tool failures stay blocking", () => {
  it("classifyBlockingWarnings treats ~/.claude/plans/ sandbox block as blocking", () => {
    const result = classifyBlockingWarnings({
      warnings: [
        "Tool 'ExitPlanMode' failed: PreToolUse:Write hook error: SANDBOX BLOCKED: File path outside sandbox: /Users/admin/.claude/plans/temporal-kindling-platypus.md",
      ],
      summary: "Planning completed successfully.",
    });

    expect(result.hasBlockingFailure).toBe(true);
    expect(result.category).toBe("sandbox_block");
  });

  it("still blocks real sandbox violations for non-plan paths", () => {
    const result = classifyBlockingWarnings({
      warnings: [
        "Tool 'Write' failed: PreToolUse:Write hook error: SANDBOX BLOCKED: File path outside sandbox: /etc/passwd",
      ],
      summary: null,
    });

    expect(result.hasBlockingFailure).toBe(true);
    expect(result.category).toBe("sandbox_block");
  });

  it("treats ~/.claude/plans/ sandbox blocks as blocking regardless of tool name", () => {
    const result = classifyBlockingWarnings({
      warnings: [
        "Tool 'Write' failed: SANDBOX BLOCKED: File path outside sandbox: /Users/admin/.claude/plans/foo.md",
      ],
      summary: null,
    });

    expect(result.hasBlockingFailure).toBe(true);
    expect(result.category).toBe("sandbox_block");
  });
});

// ─────────────────────────────────────────────────────────────────
// VAL-PLAN-003: Planner has ask_user available
// ─────────────────────────────────────────────────────────────────

describe("VAL-PLAN-003: Planner has ask_user available", () => {
  it("planning step prompt mentions ask_user as available mechanism for clarifications", () => {
    const result = buildFullPrompt(
      {
        run: {
          id: "run-1",
          missionId: "mission-1",
          metadata: { missionGoal: "Plan the feature" },
        } as any,
        step: {
          id: "step-1",
          title: "Plan the feature",
          stepKey: "plan-feature",
          laneId: "lane-1",
          metadata: {
            stepType: "planning",
            readOnlyExecution: true,
          },
          dependencyStepIds: [],
          joinPolicy: "all_success",
        } as any,
        attempt: {} as any,
        allSteps: [],
        contextProfile: {} as any,
        laneExport: null,
        projectExport: { content: "Project context" } as any,
        docsRefs: [],
        fullDocs: [],
        createTrackedSession: async () => ({ ptyId: "pty-1", sessionId: "session-1" }),
      },
      "opencode",
      {}
    );

    // Planning workers must be told about ask_user for clarifications
    expect(result.prompt).toContain("ask_user");
  });
});

// ─────────────────────────────────────────────────────────────────
// VAL-HAND-001: Workers produce structured handoff data on completion
// ─────────────────────────────────────────────────────────────────

describe("VAL-HAND-001: Succeeded attempts have worker digest", () => {
  it("succeeded attempt result envelope contains structured digest data", async () => {
    const fixture = await createFixture();
    try {
      const { db, service, projectId, missionId, laneId, now } = fixture;

      // Create a run via the service
      const started = await service.startRun({
        missionId,
        steps: [
          {
            stepKey: "implement-alpha",
            stepIndex: 0,
            title: "Implement Alpha",
            laneId,
            executorKind: "opencode",
            metadata: {
              modelId: "anthropic/claude-sonnet-4-6",
              lastResultReport: {
                summary: "Alpha implemented successfully. Added new API endpoint.",
                filesChanged: ["src/alpha.ts", "src/alpha.test.ts"],
                testsRun: { passed: 5, failed: 0, skipped: 0 },
              },
            },
          },
        ],
      });

      const alphaStep = started.steps.find((s) => s.stepKey === "implement-alpha")!;
      expect(alphaStep).toBeTruthy();

      // Start an attempt
      const attempt = await service.startAttempt({
        runId: started.run.id,
        stepId: alphaStep.id,
        ownerId: "worker-1",
        executorKind: "opencode",
      });

      // Complete the attempt with success
      const completed = await service.completeAttempt({
        attemptId: attempt.id,
        status: "succeeded",
        result: {
          schema: "ade.orchestratorAttempt.v1",
          success: true,
          summary: "Alpha implemented successfully.",
          outputs: {
            filesChanged: ["src/alpha.ts", "src/alpha.test.ts"],
            testsPassed: 5,
            testsFailed: 0,
            testsSkipped: 0,
          },
          warnings: [],
          sessionId: null,
          trackedSession: false,
        },
      });

      // Verify the result envelope has structured data
      expect(completed.resultEnvelope).toBeTruthy();
      expect(completed.resultEnvelope!.success).toBe(true);
      expect(completed.resultEnvelope!.summary.length).toBeGreaterThan(0);
      expect(completed.resultEnvelope!.outputs).toBeTruthy();
      const outputs = completed.resultEnvelope!.outputs as Record<string, unknown>;
      expect(Array.isArray(outputs.filesChanged)).toBe(true);
      expect((outputs.filesChanged as string[]).length).toBeGreaterThan(0);
    } finally {
      fixture.dispose();
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// VAL-HAND-002: Handoff summaries injected into downstream worker prompts
// ─────────────────────────────────────────────────────────────────

describe("VAL-HAND-002: Handoff summaries injected into downstream prompts", () => {
  it("buildFullPrompt includes handoffSummaries from upstream steps", () => {
    const result = buildFullPrompt(
      {
        run: {
          id: "run-1",
          missionId: "mission-1",
          metadata: { missionGoal: "Build the feature" },
        } as any,
        step: {
          id: "step-2",
          title: "Implement Beta",
          stepKey: "implement-beta",
          laneId: "lane-1",
          metadata: {
            handoffSummaries: [
              "[implement-alpha] (succeeded) Alpha implemented. | Files: src/alpha.ts | Tests: 5 passed",
            ],
          },
          dependencyStepIds: ["step-1"],
          joinPolicy: "all_success",
        } as any,
        attempt: {} as any,
        allSteps: [],
        contextProfile: {} as any,
        laneExport: null,
        projectExport: { content: "Project context" } as any,
        docsRefs: [],
        fullDocs: [],
        createTrackedSession: async () => ({ ptyId: "pty-1", sessionId: "session-1" }),
      },
      "opencode",
      {}
    );

    expect(result.prompt).toContain("Context from upstream steps");
    expect(result.prompt).toContain("implement-alpha");
    expect(result.prompt).toContain("Alpha implemented");
  });

  it("buildFullPrompt without handoffSummaries omits upstream section", () => {
    const result = buildFullPrompt(
      {
        run: {
          id: "run-1",
          missionId: "mission-1",
          metadata: { missionGoal: "Build the feature" },
        } as any,
        step: {
          id: "step-2",
          title: "Implement Beta",
          stepKey: "implement-beta",
          laneId: "lane-1",
          metadata: {},
          dependencyStepIds: [],
          joinPolicy: "all_success",
        } as any,
        attempt: {} as any,
        allSteps: [],
        contextProfile: {} as any,
        laneExport: null,
        projectExport: { content: "Project context" } as any,
        docsRefs: [],
        fullDocs: [],
        createTrackedSession: async () => ({ ptyId: "pty-1", sessionId: "session-1" }),
      },
      "opencode",
      {}
    );

    expect(result.prompt).not.toContain("Context from upstream steps");
  });
});

// ─────────────────────────────────────────────────────────────────
// VAL-ART-001: Planning artifacts registered as mission artifacts
// ─────────────────────────────────────────────────────────────────

describe("VAL-ART-001: Planning artifacts registered as mission artifacts", () => {
  it("addArtifact can register a plan artifact via orchestrator service", async () => {
    const fixture = await createFixture();
    try {
      const { service, missionId, laneId, now } = fixture;

      // Start a run to get IDs
      const started = await service.startRun({
        missionId,
        steps: [
          {
            stepKey: "plan-step",
            stepIndex: 0,
            title: "Planning",
            laneId,
            executorKind: "opencode",
            metadata: {
              modelId: "anthropic/claude-sonnet-4-6",
              stepType: "planning",
              readOnlyExecution: true,
            },
          },
        ],
      });
      const step = started.steps[0]!;
      const attempt = await service.startAttempt({
        runId: started.run.id,
        stepId: step.id,
        ownerId: "planner-1",
        executorKind: "opencode",
      });

      // Register a plan artifact via the orchestrator service registerArtifact
      const artifact = service.registerArtifact({
        missionId,
        runId: started.run.id,
        stepId: step.id,
        attemptId: attempt.id,
        artifactKey: "plan-output",
        kind: "custom",
        value: ".ade/plans/mission-plan.md",
        metadata: { planType: "mission_plan", source: "planning_worker" },
      });

      expect(artifact).toBeTruthy();
      expect(artifact.artifactKey).toBe("plan-output");
      expect(artifact.kind).toBe("custom");
      expect(artifact.value).toContain(".ade/plans/");

      // Verify it can be queried back via getArtifactsForStep
      const artifacts = service.getArtifactsForStep(step.id);
      const planArtifact = artifacts.find((a) => a.artifactKey === "plan-output");
      expect(planArtifact).toBeTruthy();
      expect(planArtifact!.kind).toBe("custom");
      expect(planArtifact!.value).toContain(".ade/plans/");
    } finally {
      fixture.dispose();
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// VAL-ART-002: getWorkerCheckpoint resolves using lane worktree path
// ─────────────────────────────────────────────────────────────────

describe("VAL-ART-002: getWorkerCheckpoint resolves using lane worktree path", () => {
  it("getWorkerCheckpoint returns persisted content for step with checkpoint", async () => {
    const fixture = await createFixture();
    try {
      const { service, missionId, laneId } = fixture;

      const started = await service.startRun({
        missionId,
        steps: [
          {
            stepKey: "test-step",
            stepIndex: 0,
            title: "Test Step",
            laneId,
            executorKind: "opencode",
            metadata: { modelId: "anthropic/claude-sonnet-4-6" },
          },
        ],
      });
      const step = started.steps[0]!;
      const attempt = await service.startAttempt({
        runId: started.run.id,
        stepId: step.id,
        ownerId: "worker-1",
        executorKind: "opencode",
      });

      // Upsert a checkpoint
      service.upsertWorkerCheckpoint({
        missionId,
        runId: started.run.id,
        stepId: step.id,
        attemptId: attempt.id,
        stepKey: "test-step",
        content: "## Checkpoint\n- Implemented feature X\n- Modified file.ts",
        filePath: path.join(fixture.worktreePath, ".ade", "checkpoints", "test-step.md"),
      });

      // Retrieve the checkpoint
      const checkpoint = service.getWorkerCheckpoint({ missionId, stepKey: "test-step" });
      expect(checkpoint).toBeTruthy();
      expect(checkpoint!.content).toContain("Implemented feature X");
      expect(checkpoint!.stepKey).toBe("test-step");
    } finally {
      fixture.dispose();
    }
  });

  it("getWorkerCheckpoint returns null for non-existent checkpoint", async () => {
    const fixture = await createFixture();
    try {
      const checkpoint = fixture.service.getWorkerCheckpoint({
        missionId: fixture.missionId,
        stepKey: "non-existent-step",
      });
      expect(checkpoint).toBeNull();
    } finally {
      fixture.dispose();
    }
  });
});
