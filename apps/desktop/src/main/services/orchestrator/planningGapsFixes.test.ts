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
  });

  it("ask_user respects custom server name", () => {
    const tools = buildClaudeReadOnlyWorkerAllowedTools("custom_server");
    expect(tools).toContain("mcp__custom_server__ask_user");
  });

  it("ask_user is listed after report_result (ordering preserved)", () => {
    const tools = buildClaudeReadOnlyWorkerAllowedTools();
    const reportResultIndex = tools.indexOf("mcp__ade__report_result");
    const askUserIndex = tools.indexOf("mcp__ade__ask_user");
    expect(reportResultIndex).toBeGreaterThanOrEqual(0);
    expect(askUserIndex).toBeGreaterThan(reportResultIndex);
  });
});

// ─────────────────────────────────────────────────────────────────
// VAL-PLAN-002: ExitPlanMode Zod validation errors handled gracefully
// ─────────────────────────────────────────────────────────────────

describe("VAL-PLAN-002: ExitPlanMode Zod errors handled cleanly", () => {
  it("treats ExitPlanMode Zod validation error as non-blocking (benign)", () => {
    const result = classifyBlockingWarnings({
      warnings: [
        "Tool 'ExitPlanMode' failed: Zod validation error: Expected string, received number at path 'planDescription'",
      ],
      summary: "Planning completed with some tool errors.",
    });
    expect(result.hasBlockingFailure).toBe(false);
  });

  it("treats ExitPlanMode schema parse error as non-blocking", () => {
    const result = classifyBlockingWarnings({
      warnings: [
        "Tool 'ExitPlanMode' failed: schema parse error: invalid input",
      ],
      summary: null,
    });
    expect(result.hasBlockingFailure).toBe(false);
  });

  it("treats Zod validation with ExitPlanMode context as non-blocking", () => {
    const result = classifyBlockingWarnings({
      warnings: [
        "Zod validation failed for tool ExitPlanMode: Required field missing",
      ],
      summary: null,
    });
    expect(result.hasBlockingFailure).toBe(false);
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

  it("still treats ~/.claude/plans/ sandbox blocks as non-blocking", () => {
    const result = classifyBlockingWarnings({
      warnings: [
        "Tool 'ExitPlanMode' failed: PreToolUse:Write hook error: SANDBOX BLOCKED: File path outside sandbox: /Users/admin/.claude/plans/foo.md",
      ],
      summary: null,
    });
    expect(result.hasBlockingFailure).toBe(false);
  });

  it("ExitPlanMode validation errors do not cause retries (soft_success_blocking_failure is not retryable)", () => {
    // When a warning is benign, classifyBlockingWarnings returns hasBlockingFailure=false.
    // This means the attempt stays "succeeded" — no failure, no retry.
    const result = classifyBlockingWarnings({
      warnings: [
        "Tool 'ExitPlanMode' failed: Zod validation error: Invalid input",
      ],
      summary: "Plan written successfully.",
    });
    expect(result.hasBlockingFailure).toBe(false);
    // No failure override means the attempt succeeds cleanly — no retry loop
  });
});

// ─────────────────────────────────────────────────────────────────
// VAL-ART-001: Planning artifacts registered after planner completes
// ─────────────────────────────────────────────────────────────────

describe("VAL-ART-001: Planning step registers plan artifact", () => {
  function buildMockCtx() {
    const registeredArtifacts: Array<Record<string, unknown>> = [];
    return {
      ctx: {
        orchestratorService: {
          registerArtifact: vi.fn((artifact: Record<string, unknown>) => {
            registeredArtifacts.push(artifact);
            return artifact;
          }),
          appendTimelineEvent: vi.fn(),
        },
        logger: {
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
      } as any,
      registeredArtifacts,
    };
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
    const { ctx, registeredArtifacts } = buildMockCtx();
    const { graph, attempt } = buildPlanningAttempt();

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
    const { ctx, registeredArtifacts } = buildMockCtx();
    const { graph, attempt } = buildPlanningAttempt();

    extractAndRegisterArtifacts(ctx, { graph, attempt });

    const planArtifact = registeredArtifacts.find(
      (a) => a.artifactKey === "plan"
    );
    expect(planArtifact).toBeTruthy();
    expect(typeof planArtifact!.value).toBe("string");
    expect((planArtifact!.value as string).length).toBeGreaterThan(0);
  });

  it("uses custom planPath from outputs when provided", () => {
    const { ctx, registeredArtifacts } = buildMockCtx();
    const { graph, attempt } = buildPlanningAttempt({
      outputs: { planPath: ".ade/plans/custom-plan.md" },
    });

    extractAndRegisterArtifacts(ctx, { graph, attempt });

    const planArtifact = registeredArtifacts.find(
      (a) => a.artifactKey === "plan"
    );
    expect(planArtifact).toBeTruthy();
    expect(planArtifact!.value).toBe(".ade/plans/custom-plan.md");
  });

  it("falls back to default plan path when outputs.planPath is absent", () => {
    const { ctx, registeredArtifacts } = buildMockCtx();
    const { graph, attempt } = buildPlanningAttempt({
      outputs: {},
    });

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
    const { ctx, registeredArtifacts } = buildMockCtx();
    const { graph, attempt } = buildPlanningAttempt({
      stepMeta: { readOnlyExecution: true },
    });

    extractAndRegisterArtifacts(ctx, { graph, attempt });

    const planArtifact = registeredArtifacts.find(
      (a) => a.artifactKey === "plan"
    );
    expect(planArtifact).toBeTruthy();
  });

  it("registers plan artifact for phaseKey=planning steps", () => {
    const { ctx, registeredArtifacts } = buildMockCtx();
    const { graph, attempt } = buildPlanningAttempt({
      stepMeta: { phaseKey: "Planning" },
    });

    extractAndRegisterArtifacts(ctx, { graph, attempt });

    const planArtifact = registeredArtifacts.find(
      (a) => a.artifactKey === "plan"
    );
    expect(planArtifact).toBeTruthy();
  });

  it("plan artifact metadata includes envelope summary", () => {
    const { ctx, registeredArtifacts } = buildMockCtx();
    const { graph, attempt } = buildPlanningAttempt({
      envelopeSummary: "Designed API for auth module with 3 endpoints.",
    });

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
    const { ctx, registeredArtifacts } = buildMockCtx();
    const { graph, attempt } = buildPlanningAttempt();

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
