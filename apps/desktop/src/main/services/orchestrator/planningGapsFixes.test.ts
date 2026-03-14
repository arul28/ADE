import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildClaudeReadOnlyWorkerAllowedTools } from "./unifiedOrchestratorAdapter";
import { classifyBlockingWarnings } from "./orchestratorQueries";
import { extractAndRegisterArtifacts } from "./workerTracking";
import { createOrchestratorService } from "./orchestratorService";
import { createMissionService } from "../missions/missionService";
import { openKvDb } from "../state/kvDb";
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

  function buildPlanningAttempt(overrides?: {
    stepMeta?: Record<string, unknown>;
    envelopeSummary?: string;
    outputs?: Record<string, unknown>;
    plan?: Record<string, unknown> | null;
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
          metadata: {
            ...stepMeta,
            lastResultReport: {
              workerId: "planning-worker",
              runId: "run-1",
              missionId: "mission-1",
              outcome: "succeeded",
              summary: overrides?.envelopeSummary ?? "Planning completed. Created architecture plan.",
              plan: overrides?.plan === null
                ? null
                : {
                    markdown: "# Mission plan\n\n- Investigate auth flow\n- Update tests\n",
                    ...(overrides?.outputs?.planPath ? { artifactPath: String(overrides.outputs.planPath) } : {}),
                    ...(overrides?.plan ?? {}),
                  },
              artifacts: [],
              filesChanged: [],
              testsRun: null,
              reportedAt: "2026-03-10T00:05:00.000Z",
            },
          },
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
      source: "ade_persisted_plan",
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
    const { ctx } = buildMockCtx();
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

  it("opens an explicit failed_step intervention when the plan payload is missing", () => {
    const { ctx } = buildMockCtx();
    const { graph, attempt } = buildPlanningAttempt({
      plan: null,
    });

    extractAndRegisterArtifacts(ctx, { graph, attempt });

    expect(ctx.missionService.addIntervention).toHaveBeenCalledWith(
      expect.objectContaining({
        interventionType: "failed_step",
        title: "Planner result missing plan",
      }),
    );
  });
});

describe("VAL-PLAN-004: planner contract enforcement", () => {
  it("fails a planning attempt that completes without report_result.plan.markdown", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-plan-contract-"));
    const db = await openKvDb(path.join(projectRoot, "ade.db"), {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    } as any);
    const projectId = "proj-1";
    const laneId = "lane-1";
    const missionId = "mission-1";
    const now = "2026-03-12T00:00:00.000Z";

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
        laneId, projectId, "Lane 1", null, "worktree", "main", "feature/planning",
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
        missionId, projectId, laneId, "Planner contract", "Create a plan.",
        "planning", "normal", "local", null, null, null, null, now, now, now, null,
      ]
    );

    const orchestratorService = createOrchestratorService({
      db,
      projectId,
      projectRoot,
      packService: {
        getLaneExport: vi.fn(async () => ({
          packKey: `lane:${laneId}`,
          packType: "lane",
          level: "standard",
          header: {} as any,
          content: "lane",
          approxTokens: 32,
          maxTokens: 500,
          truncated: false,
          warnings: [],
          clipReason: null,
          omittedSections: null,
        })),
        getProjectExport: vi.fn(async () => ({
          packKey: "project",
          packType: "project",
          level: "standard",
          header: {} as any,
          content: "project",
          approxTokens: 32,
          maxTokens: 500,
          truncated: false,
          warnings: [],
          clipReason: null,
          omittedSections: null,
        })),
        refreshMissionPack: vi.fn(async () => ({
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
          body: "# Mission Pack",
        })),
      } as any,
      ptyService: {
        create: vi.fn(async () => ({ ptyId: "pty-1", sessionId: "session-1" })),
      } as any,
      projectConfigService: null as any,
      aiIntegrationService: null as any,
      memoryService: null as any,
    });
    createMissionService({ db, projectId, projectRoot });

    try {
      const started = await orchestratorService.startRun({
        missionId,
        steps: [
          {
            stepKey: "planning-worker",
            stepIndex: 0,
            title: "Plan the work",
            executorKind: "manual",
            laneId,
            metadata: {
              stepType: "planning",
              phaseKey: "planning",
              readOnlyExecution: true,
            },
          },
        ],
      });
      const step = started.steps[0]!;
      db.run(
        "update orchestrator_steps set metadata_json = ? where id = ? and project_id = ?",
        [
          JSON.stringify({
            stepType: "planning",
            phaseKey: "planning",
            readOnlyExecution: true,
            lastResultReport: {
              summary: "needed",
              outputs: null,
            },
          }),
          step.id,
          projectId,
        ]
      );

      const attempt = await orchestratorService.startAttempt({
        runId: started.run.id,
        stepId: step.id,
        ownerId: "planner",
        executorKind: "manual",
      });

      const completed = await orchestratorService.completeAttempt({
        attemptId: attempt.id,
        status: "succeeded",
      });

      const graph = orchestratorService.getRunGraph({ runId: started.run.id, timelineLimit: 20 });
      const updatedStep = graph.steps.find((entry) => entry.id === step.id);
      const planningArtifactEvents = orchestratorService.listRuntimeEvents({
        runId: started.run.id,
        attemptId: attempt.id,
        eventTypes: ["planning_artifact_missing"],
      });

      expect(completed.status).toBe("failed");
      expect(completed.errorClass).toBe("planner_contract_violation");
      expect(completed.errorMessage).toContain("report_result.plan.markdown");
      expect(updatedStep?.status).toBe("failed");
      expect(planningArtifactEvents).toHaveLength(1);
      expect(planningArtifactEvents[0]?.payload).toMatchObject({
        reason: "planner_plan_missing",
        expectedPlanPath: ".ade/plans/mission-plan.md",
      });
    } finally {
      db.close();
    }
  });

  it("emits distinct artifact-missing and intervention-opened runtime events for planner failures", () => {
    const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-plan-artifacts-"));
    fs.mkdirSync(path.join(worktreePath, ".ade", "plans"), { recursive: true });
    const appendRuntimeEvent = vi.fn();
    const ctx = {
      projectRoot: worktreePath,
      db: {
        get: vi.fn(() => ({ worktree_path: worktreePath })),
      },
      missionService: {
        addArtifact: vi.fn(),
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
        registerArtifact: vi.fn(),
        appendTimelineEvent: vi.fn(),
        appendRuntimeEvent,
      },
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    } as any;
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
        summary: "Planner finished without reporting a plan artifact.",
        outputs: {},
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
          title: "Plan the work",
          laneId: "lane-1",
          status: "running",
          metadata: {
            stepType: "planning",
            readOnlyExecution: true,
            lastResultReport: {
              workerId: "planning-worker",
              runId: "run-1",
              missionId: "mission-1",
              outcome: "succeeded",
              summary: "Planner finished without reporting a plan artifact.",
              plan: null,
              artifacts: [],
              filesChanged: [],
              testsRun: null,
              reportedAt: "2026-03-10T00:05:00.000Z",
            },
          },
          dependencyStepIds: [],
          joinPolicy: "all_success",
          retryCount: 0,
          retryLimit: 2,
        },
      ],
      attempts: [attempt],
    } as any;

    extractAndRegisterArtifacts(ctx, { graph, attempt });

    const planningArtifactEvent = ctx.orchestratorService.appendTimelineEvent.mock.calls
      .map(([event]: [Record<string, unknown>]) => event)
      .find((event: Record<string, unknown>) => event.eventType === "planning_artifact_missing");
    const interventionOpenedEvent = appendRuntimeEvent.mock.calls
      .map(([event]: [Record<string, unknown>]) => event)
      .find((event: Record<string, unknown>) => event.eventType === "intervention_opened");

    expect(planningArtifactEvent).toBeTruthy();
    expect(interventionOpenedEvent).toBeTruthy();
    expect(interventionOpenedEvent?.eventKey).toBe("intervention_opened:intervention-1");
  });
});
