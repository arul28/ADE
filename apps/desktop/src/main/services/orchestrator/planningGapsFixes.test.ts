import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildClaudeReadOnlyWorkerAllowedTools } from "./unifiedOrchestratorAdapter";
import { classifyBlockingWarnings } from "./orchestratorQueries";
import { extractAndRegisterArtifacts } from "./workerTracking";
import type { OrchestratorRunGraph } from "../../../shared/types/orchestrator";

// ─────────────────────────────────────────────────────────────────
// VAL-PLAN-003: mcp__ade__ask_user in the planning worker allowlist
// ─────────────────────────────────────────────────────────────────

describe("VAL-PLAN-003: ask_user in planning worker allowlist", () => {
  it("mcp__ade__ask_user is included in the read-only worker allowed tools", () => {
    const tools = buildClaudeReadOnlyWorkerAllowedTools();
    expect(tools).toContain("mcp__ade__ask_user");
    expect(tools).toContain("mcp__ade__memory_search");
    expect(tools).toContain("mcp__ade__memory_add");
  });

  it("ask_user respects custom server name", () => {
    const tools = buildClaudeReadOnlyWorkerAllowedTools("custom_server");
    expect(tools).toContain("mcp__custom_server__ask_user");
    expect(tools).toContain("mcp__custom_server__memory_search");
    expect(tools).toContain("mcp__custom_server__memory_add");
  });

  it("memory tools are listed after ask_user (ordering preserved)", () => {
    const tools = buildClaudeReadOnlyWorkerAllowedTools();
    const reportResultIndex = tools.indexOf("mcp__ade__report_result");
    const askUserIndex = tools.indexOf("mcp__ade__ask_user");
    const memorySearchIndex = tools.indexOf("mcp__ade__memory_search");
    const memoryAddIndex = tools.indexOf("mcp__ade__memory_add");
    expect(reportResultIndex).toBeGreaterThanOrEqual(0);
    expect(askUserIndex).toBeGreaterThan(reportResultIndex);
    expect(memorySearchIndex).toBeGreaterThan(askUserIndex);
    expect(memoryAddIndex).toBeGreaterThan(memorySearchIndex);
  });
});

// ─────────────────────────────────────────────────────────────────
// VAL-PLAN-002: ExitPlanMode Zod validation errors handled gracefully
// ─────────────────────────────────────────────────────────────────

describe("VAL-PLAN-002: ExitPlanMode Zod errors handled cleanly", () => {
  it("treats ExitPlanMode Zod validation error as blocking", () => {
    const result = classifyBlockingWarnings({
      warnings: [
        "Tool 'ExitPlanMode' failed: Zod validation error: Expected string, received number at path 'planDescription'",
      ],
      summary: "Planning completed with some tool errors.",
    });
    expect(result.hasBlockingFailure).toBe(true);
    expect(result.category).toBe("tool_failure");
  });

  it("treats ExitPlanMode schema parse error as blocking", () => {
    const result = classifyBlockingWarnings({
      warnings: [
        "Tool 'ExitPlanMode' failed: schema parse error: invalid input",
      ],
      summary: null,
    });
    expect(result.hasBlockingFailure).toBe(true);
    expect(result.category).toBe("tool_failure");
  });

  it("treats Zod validation with ExitPlanMode context as blocking", () => {
    const result = classifyBlockingWarnings({
      warnings: [
        "Zod validation failed for tool ExitPlanMode: Required field missing",
      ],
      summary: null,
    });
    expect(result.hasBlockingFailure).toBe(true);
  });

  it("still blocks genuine tool failures unrelated to ExitPlanMode", () => {
    const result = classifyBlockingWarnings({
      warnings: [
        "Tool 'Write' failed: SANDBOX BLOCKED: File path outside sandbox: /etc/passwd",
      ],
      summary: null,
    });
    expect(result.hasBlockingFailure).toBe(true);
    expect(result.category).toBe("sandbox_block");
  });

  it("treats ~/.claude/plans/ sandbox blocks as blocking", () => {
    const result = classifyBlockingWarnings({
      warnings: [
        "Tool 'ExitPlanMode' failed: PreToolUse:Write hook error: SANDBOX BLOCKED: File path outside sandbox: /Users/admin/.claude/plans/foo.md",
      ],
      summary: null,
    });
    expect(result.hasBlockingFailure).toBe(true);
    expect(result.category).toBe("sandbox_block");
  });

  it("ExitPlanMode validation errors stay classified as blocking failures", () => {
    const result = classifyBlockingWarnings({
      warnings: [
        "Tool 'ExitPlanMode' failed: Zod validation error: Invalid input",
      ],
      summary: "Plan written successfully.",
    });
    expect(result.hasBlockingFailure).toBe(true);
    expect(result.category).toBe("tool_failure");
  });
});

// ─────────────────────────────────────────────────────────────────
// VAL-ART-001: Planning artifacts registered after planner completes
// ─────────────────────────────────────────────────────────────────

describe("VAL-ART-001: Planning step registers plan artifact", () => {
  function buildMockCtx() {
    const registeredArtifacts: Array<Record<string, unknown>> = [];
    const missionArtifacts: Array<Record<string, unknown>> = [];
    const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-plan-artifacts-"));
    fs.mkdirSync(path.join(worktreePath, ".ade", "plans"), { recursive: true });
    return {
      ctx: {
        projectRoot: worktreePath,
        db: {
          get: vi.fn(() => ({ worktree_path: worktreePath })),
        },
        missionService: {
          addArtifact: vi.fn((artifact: Record<string, unknown>) => {
            missionArtifacts.push(artifact);
            return artifact;
          }),
          addIntervention: vi.fn((intervention: Record<string, unknown>) => ({
            id: "intervention-1",
            missionId: "mission-1",
            status: "open",
            createdAt: "2026-03-10T00:05:00.000Z",
            updatedAt: "2026-03-10T00:05:00.000Z",
            resolvedAt: null,
            resolutionNote: null,
            laneId: null,
            ...intervention,
          })),
        },
        orchestratorService: {
          registerArtifact: vi.fn((artifact: Record<string, unknown>) => {
            registeredArtifacts.push(artifact);
            return artifact;
          }),
          appendTimelineEvent: vi.fn(),
          appendRuntimeEvent: vi.fn(),
        },
        logger: {
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
      } as any,
      registeredArtifacts,
      missionArtifacts,
      worktreePath,
    };
  }

  function ensurePlanFile(worktreePath: string, relativePlanPath = ".ade/plans/mission-plan.md") {
    const absolutePlanPath = path.join(worktreePath, relativePlanPath);
    fs.mkdirSync(path.dirname(absolutePlanPath), { recursive: true });
    fs.writeFileSync(absolutePlanPath, "# Mission plan\n", "utf8");
    return absolutePlanPath;
  }

  function buildPlanningAttempt(overrides?: {
    stepMeta?: Record<string, unknown>;
    envelopeSummary?: string;
    outputs?: Record<string, unknown>;
  }): {
    graph: OrchestratorRunGraph;
    attempt: OrchestratorRunGraph["attempts"][number];
  } {
    const stepMeta = overrides?.stepMeta ?? {
      stepType: "planning",
      readOnlyExecution: true,
    };
    const attempt = {
      id: "attempt-1",
      runId: "run-1",
      stepId: "step-1",
      status: "succeeded" as const,
      executorSessionId: "session-1",
      executorKind: "unified" as const,
      createdAt: "2026-03-10T00:00:00.000Z",
      completedAt: "2026-03-10T00:05:00.000Z",
      resultEnvelope: {
        schema: "ade.orchestratorAttempt.v1",
        success: true,
        summary: overrides?.envelopeSummary ?? "Planning completed. Created architecture plan.",
        outputs: overrides?.outputs ?? {},
        warnings: [],
        sessionId: "session-1",
        trackedSession: true,
      },
      metadata: {},
    } as any;

    const graph = {
      run: {
        id: "run-1",
        missionId: "mission-1",
        status: "active",
        metadata: {},
      },
      steps: [
        {
          id: "step-1",
          stepKey: "planning-worker",
          title: "Plan the feature",
          laneId: "lane-1",
          status: "running",
          metadata: stepMeta,
          dependencyStepIds: [],
          joinPolicy: "all_success",
          retryCount: 0,
          retryLimit: 2,
        },
      ],
      attempts: [attempt],
    } as any;

    return { graph, attempt };
  }

  it("registers a 'plan' artifact for planning steps on success", () => {
    const { ctx, registeredArtifacts, worktreePath } = buildMockCtx();
    const { graph, attempt } = buildPlanningAttempt();
    ensurePlanFile(worktreePath);

    extractAndRegisterArtifacts(ctx, { graph, attempt });

    const planArtifact = registeredArtifacts.find(
      (a) => a.artifactKey === "plan"
    );
    expect(planArtifact).toBeTruthy();
    expect(planArtifact!.kind).toBe("custom");
    expect(planArtifact!.metadata).toMatchObject({
      planType: "mission_plan",
      source: "planning_worker",
    });
  });

  it("plan artifact has valid value path", () => {
    const { ctx, registeredArtifacts, worktreePath } = buildMockCtx();
    const { graph, attempt } = buildPlanningAttempt();
    ensurePlanFile(worktreePath);

    extractAndRegisterArtifacts(ctx, { graph, attempt });

    const planArtifact = registeredArtifacts.find(
      (a) => a.artifactKey === "plan"
    );
    expect(planArtifact).toBeTruthy();
    expect(typeof planArtifact!.value).toBe("string");
    expect((planArtifact!.value as string).length).toBeGreaterThan(0);
  });

  it("uses custom planPath from outputs when provided", () => {
    const { ctx, registeredArtifacts, worktreePath } = buildMockCtx();
    const { graph, attempt } = buildPlanningAttempt({
      outputs: { planPath: ".ade/plans/custom-plan.md" },
    });
    ensurePlanFile(worktreePath, ".ade/plans/custom-plan.md");

    extractAndRegisterArtifacts(ctx, { graph, attempt });

    const planArtifact = registeredArtifacts.find(
      (a) => a.artifactKey === "plan"
    );
    expect(planArtifact).toBeTruthy();
    expect(planArtifact!.value).toBe(".ade/plans/custom-plan.md");
  });

  it("falls back to default plan path when outputs.planPath is absent", () => {
    const { ctx, registeredArtifacts, worktreePath } = buildMockCtx();
    const { graph, attempt } = buildPlanningAttempt({
      outputs: {},
    });
    ensurePlanFile(worktreePath);

    extractAndRegisterArtifacts(ctx, { graph, attempt });

    const planArtifact = registeredArtifacts.find(
      (a) => a.artifactKey === "plan"
    );
    expect(planArtifact).toBeTruthy();
    expect(planArtifact!.value).toBe(".ade/plans/mission-plan.md");
  });

  it("does NOT register plan artifact for non-planning steps", () => {
    const { ctx, registeredArtifacts } = buildMockCtx();
    const { graph, attempt } = buildPlanningAttempt({
      stepMeta: { stepType: "implementation" },
    });

    extractAndRegisterArtifacts(ctx, { graph, attempt });

    const planArtifact = registeredArtifacts.find(
      (a) => a.artifactKey === "plan"
    );
    expect(planArtifact).toBeUndefined();
  });

  it("registers plan artifact for readOnlyExecution steps", () => {
    const { ctx, registeredArtifacts, worktreePath } = buildMockCtx();
    const { graph, attempt } = buildPlanningAttempt({
      stepMeta: { readOnlyExecution: true },
    });
    ensurePlanFile(worktreePath);

    extractAndRegisterArtifacts(ctx, { graph, attempt });

    const planArtifact = registeredArtifacts.find(
      (a) => a.artifactKey === "plan"
    );
    expect(planArtifact).toBeTruthy();
  });

  it("registers plan artifact for phaseKey=planning steps", () => {
    const { ctx, registeredArtifacts, worktreePath } = buildMockCtx();
    const { graph, attempt } = buildPlanningAttempt({
      stepMeta: { phaseKey: "Planning" },
    });
    ensurePlanFile(worktreePath);

    extractAndRegisterArtifacts(ctx, { graph, attempt });

    const planArtifact = registeredArtifacts.find(
      (a) => a.artifactKey === "plan"
    );
    expect(planArtifact).toBeTruthy();
  });

  it("plan artifact metadata includes envelope summary", () => {
    const { ctx, registeredArtifacts, worktreePath } = buildMockCtx();
    const { graph, attempt } = buildPlanningAttempt({
      envelopeSummary: "Designed API for auth module with 3 endpoints.",
    });
    ensurePlanFile(worktreePath);

    extractAndRegisterArtifacts(ctx, { graph, attempt });

    const planArtifact = registeredArtifacts.find(
      (a) => a.artifactKey === "plan"
    );
    expect(planArtifact).toBeTruthy();
    expect((planArtifact!.metadata as Record<string, unknown>).summary).toBe(
      "Designed API for auth module with 3 endpoints."
    );
  });

  it("plan artifact is queryable (registered via registerArtifact on orchestratorService)", () => {
    const { ctx, worktreePath } = buildMockCtx();
    const { graph, attempt } = buildPlanningAttempt();
    ensurePlanFile(worktreePath);

    extractAndRegisterArtifacts(ctx, { graph, attempt });

    // Verify the artifact was registered via the service
    expect(ctx.orchestratorService.registerArtifact).toHaveBeenCalled();
    const planCall = ctx.orchestratorService.registerArtifact.mock.calls.find(
      (call: any[]) => call[0].artifactKey === "plan"
    );
    expect(planCall).toBeTruthy();
    expect(planCall![0]).toMatchObject({
      missionId: "mission-1",
      runId: "run-1",
      stepId: "step-1",
      attemptId: "attempt-1",
      artifactKey: "plan",
      kind: "custom",
    });
  });
});
