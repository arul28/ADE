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

function buildDecisionStructuredOutput(prompt: string): Record<string, unknown> | null {
  const normalized = prompt.toLowerCase();
  if (normalized.includes("decision: lane strategy")) {
    const stepKeys = [...prompt.matchAll(/"stepKey"\s*:\s*"([^"]+)"/g)]
      .map((match) => match[1]?.trim())
      .filter((value): value is string => Boolean(value));
    const uniqueStepKeys = [...new Set(stepKeys)];
    const stepAssignments = uniqueStepKeys.map((stepKey, index) => ({
      stepKey,
      laneLabel: index > 0 && index % 2 === 1 ? "parallel-1" : "base",
      rationale: index > 0 && index % 2 === 1 ? "Split independent work into a child lane." : "Keep shared work on base lane."
    }));
    return {
      strategy: "dependency_parallel",
      maxParallelLanes: 3,
      rationale: "Multiple independent root steps should fan out across lanes.",
      confidence: 0.93,
      stepAssignments
    };
  }
  if (normalized.includes("decision: state transition")) {
    return {
      actionType: "continue",
      reason: "Continue run progression.",
      rationale: "No blockers or safety overrides required.",
      nextStatus: null,
      retryDelayMs: null,
      timeoutBudgetMs: null,
      confidence: 0.86
    };
  }
  if (normalized.includes("decision: parallelism cap")) {
    return {
      parallelismCap: 2,
      rationale: "Keep smoke run fanout conservative.",
      confidence: 0.8
    };
  }
  if (normalized.includes("decision: quality gate")) {
    return {
      verdict: "pass",
      reason: "Quality gate passed for this output.",
      blockingFindings: [],
      confidence: 0.88
    };
  }
  if (normalized.includes("decision: timeout budget")) {
    return {
      timeoutMs: 120000,
      rationale: "Use default timeout budget for smoke execution.",
      confidence: 0.72
    };
  }
  if (normalized.includes("decision: retry policy")) {
    return {
      shouldRetry: true,
      delayMs: 5000,
      reason: "Retry is acceptable for transient failures.",
      adjustedHint: null,
      confidence: 0.74
    };
  }
  if (normalized.includes("decision: stagnation evaluation")) {
    return {
      isStagnating: false,
      severity: "low",
      recommendedAction: "continue",
      rationale: "Smoke run is actively progressing.",
      confidence: 0.7
    };
  }
  if (normalized.includes("decision: recovery action")) {
    return {
      action: "retry_with_hint",
      reason: "Prefer retry with guidance before escalation.",
      retryHint: "Retry once with focused diagnostics.",
      confidence: 0.69
    };
  }
  if (normalized.includes("decision: mission replan")) {
    return {
      shouldReplan: false,
      summary: "No replan required for smoke execution.",
      planDelta: [],
      confidence: 0.76
    };
  }
  if (normalized.includes("decision: step priority")) {
    return {
      priority: 50,
      laneHint: null,
      rationale: "Balanced priority for smoke run.",
      confidence: 0.7
    };
  }
  return null;
}

function createMockAiIntegrationService() {
  return {
    getAvailability: () => ({ claude: true, codex: true, cursor: false }),
    getMode: () => "subscription",
    getFeatureFlag: () => true,
    getDailyBudgetLimit: () => null,
    getDailyUsage: () => 0,
    executeTask: vi.fn().mockImplementation(async (request: { prompt?: string }) => {
      const prompt = String(request?.prompt ?? "");
      const structuredOutput = buildDecisionStructuredOutput(prompt);
      return {
        text: structuredOutput ? JSON.stringify(structuredOutput) : "{}",
        structuredOutput,
        provider: "claude",
        model: "sonnet",
        sessionId: null,
        inputTokens: 100,
        outputTokens: 50,
        durationMs: 500
      };
    }),
    listModels: vi.fn().mockResolvedValue([])
  } as any;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timed out waiting for smoke condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function setMissionPlanningMode(
  db: Awaited<ReturnType<typeof openKvDb>>,
  missionId: string,
  mode: "off" | "auto" | "manual_review"
): void {
  const row = db.get<{ metadata_json: string | null }>(
    `select metadata_json from missions where id = ? limit 1`,
    [missionId]
  );
  const metadata = row?.metadata_json ? JSON.parse(row.metadata_json) : {};
  const executionPolicy =
    metadata && typeof metadata.executionPolicy === "object" && !Array.isArray(metadata.executionPolicy)
      ? metadata.executionPolicy
      : {};
  const planning =
    executionPolicy && typeof executionPolicy.planning === "object" && !Array.isArray(executionPolicy.planning)
      ? executionPolicy.planning
      : {};
  executionPolicy.planning = {
    ...planning,
    mode,
    ...(mode === "off" ? {} : { model: "codex" })
  };
  metadata.executionPolicy = executionPolicy;
  db.run(`update missions set metadata_json = ? where id = ?`, [JSON.stringify(metadata), missionId]);
}

async function createSmokeFixture() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-orchestrator-smoke-"));
  fs.mkdirSync(path.join(projectRoot, "docs", "architecture"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "docs", "PRD.md"), "# PRD\n", "utf8");
  fs.writeFileSync(path.join(projectRoot, "docs", "architecture", "SYSTEM_OVERVIEW.md"), "# Architecture\n", "utf8");

  const db = await openKvDb(path.join(projectRoot, ".ade.db"), createLogger());
  const projectId = "proj-smoke";
  const laneId = "lane-smoke";
  const now = "2026-02-21T00:00:00.000Z";

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
      "Lane Smoke",
      null,
      "worktree",
      "main",
      "feature/smoke",
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
  let resultLaneCounter = 0;
  const laneService = {
    list: async ({ includeArchived }: { includeArchived?: boolean } = {}) => db.all<{
      id: string;
      project_id: string;
      name: string;
      lane_type: string | null;
      base_ref: string | null;
      branch_ref: string | null;
      worktree_path: string | null;
      attached_root_path: string | null;
      status: string | null;
      archived_at: string | null;
      mission_id: string | null;
      lane_role: string | null;
    }>(
      `
        select
          id,
          project_id,
          name,
          lane_type,
          base_ref,
          branch_ref,
          worktree_path,
          attached_root_path,
          status,
          archived_at,
          mission_id,
          lane_role
        from lanes
        where project_id = ?
          and (? = 1 or archived_at is null)
        order by created_at asc, id asc
      `,
      [projectId, includeArchived ? 1 : 0]
    ).map((row) => ({
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      laneType: row.lane_type === "primary" ? "primary" : "worktree",
      baseRef: row.base_ref,
      branchRef: row.branch_ref,
      worktreePath: row.worktree_path,
      attachedRootPath: row.attached_root_path,
      status: row.archived_at ? "archived" : row.status === "archived" ? "archived" : "active",
      missionId: row.mission_id,
      laneRole: row.lane_role,
      archivedAt: row.archived_at,
    })),
    createChild: async (args: {
      parentLaneId: string;
      name: string;
      description?: string;
      folder?: string;
      missionId?: string | null;
      laneRole?: string | null;
    }) => {
      const childId = `lane-${Math.random().toString(36).slice(2, 10)}`;
      const childBranch = `mission/${childId}`;
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
            folder,
            mission_id,
            lane_role,
            status,
            created_at,
            archived_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          childId,
          projectId,
          args.name,
          args.description ?? null,
          "worktree",
          "main",
          childBranch,
          projectRoot,
          null,
          0,
          args.parentLaneId,
          null,
          null,
          JSON.stringify(args.folder ? [args.folder] : []),
          args.folder ?? null,
          args.missionId ?? null,
          args.laneRole ?? null,
          "active",
          now,
          null,
        ]
      );
      return {
        id: childId,
        name: args.name,
        branchRef: childBranch,
        laneType: "worktree",
        worktreePath: projectRoot,
        missionId: args.missionId ?? null,
        laneRole: args.laneRole ?? null,
      };
    },
    archive: async ({ laneId: targetLaneId }: { laneId: string }) => {
      db.run(
        `update lanes set status = 'archived', archived_at = ? where id = ? and project_id = ?`,
        [new Date().toISOString(), targetLaneId, projectId]
      );
    },
    setMissionOwnership: async ({
      laneId: targetLaneId,
      missionId,
      laneRole,
    }: {
      laneId: string;
      missionId: string | null;
      laneRole?: string | null;
    }) => {
      db.run(
        `update lanes set mission_id = ?, lane_role = ? where id = ? and project_id = ?`,
        [missionId, laneRole ?? null, targetLaneId, projectId]
      );
    },
    getLaneWorktreePath: (targetLaneId: string) => {
      const row = db.get<{ worktree_path: string | null }>(
        `select worktree_path from lanes where id = ? and project_id = ? limit 1`,
        [targetLaneId, projectId]
      );
      return row?.worktree_path ?? projectRoot;
    },
  } as any;
  const prService = {
    createIntegrationLane: vi.fn(async ({
      sourceLaneIds,
      integrationLaneName,
      missionId,
      laneRole,
    }: {
      sourceLaneIds: string[];
      integrationLaneName: string;
      missionId?: string | null;
      laneRole?: string | null;
    }) => {
      resultLaneCounter += 1;
      const resultLaneId = `result-lane-${resultLaneCounter}`;
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
            folder,
            mission_id,
            lane_role,
            status,
            created_at,
            archived_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          resultLaneId,
          projectId,
          integrationLaneName,
          "Result lane for smoke mission",
          "worktree",
          "main",
          `integration/${resultLaneId}`,
          projectRoot,
          null,
          0,
          laneId,
          null,
          null,
          null,
          null,
          missionId ?? null,
          laneRole ?? "result",
          "active",
          new Date().toISOString(),
          null,
        ]
      );
      return {
        integrationLane: {
          id: resultLaneId,
          name: integrationLaneName,
          laneType: "worktree",
          branchRef: `integration/${resultLaneId}`,
          worktreePath: projectRoot,
          missionId: missionId ?? null,
          laneRole: laneRole ?? "result",
        },
        mergeResults: sourceLaneIds.map((sourceLaneId) => ({ laneId: sourceLaneId, success: true })),
      };
    }),
  } as any;
  const projectConfigService = {
    get: () => ({
      effective: {
        ai: {
          orchestrator: {}
        }
      }
    })
  } as any;

  const orchestratorService = createOrchestratorService({
    db,
    projectId,
    projectRoot,
    projectConfigService
  });
  const aiOrchestratorService = createAiOrchestratorService({
    db,
    logger: createLogger(),
    missionService,
    orchestratorService,
      aiIntegrationService: createMockAiIntegrationService(),
      laneService,
      projectConfigService,
      prService,
      projectRoot
  });

  return {
    db,
    projectRoot,
    laneId,
    missionService,
    orchestratorService,
    aiOrchestratorService,
    dispose: () => {
      aiOrchestratorService.dispose();
      db.close();
    }
  };
}

describe("orchestrator smoke", () => {
  it("runs a mission end-to-end without UI interaction", async () => {
    const fixture = await createSmokeFixture();
    try {
      const mission = fixture.missionService.create({
        prompt: [
          "Implement a small feature and prove it works:",
          "1) Add GET /api/health endpoint.",
          "2) Add/update endpoint tests.",
          "3) Update README health section.",
          "4) Run final review for regressions."
        ].join("\n"),
        laneId: fixture.laneId
      });
      setMissionPlanningMode(fixture.db, mission.id, "off");

      const launch = await fixture.aiOrchestratorService.startMissionRun({
        missionId: mission.id,
        runMode: "manual",
        defaultExecutorKind: "manual"
      });
      if (!launch.started) throw new Error("Expected smoke run to start");
      const runId = launch.started.run.id;

      // In the AI-first flow, startMissionRun creates an empty run.
      // Simulate the coordinator adding steps.
      fixture.orchestratorService.addSteps({
        runId,
        steps: [
          {
            stepKey: "api-health",
            title: "Add GET /api/health endpoint",
            stepIndex: 0,
            dependencyStepKeys: [],
            executorKind: "manual",
            metadata: { instructions: "Implement health endpoint", taskType: "implementation" }
          },
          {
            stepKey: "endpoint-tests",
            title: "Add/update endpoint tests",
            stepIndex: 1,
            dependencyStepKeys: ["api-health"],
            executorKind: "manual",
            metadata: { instructions: "Write tests", taskType: "test" }
          },
          {
            stepKey: "readme-update",
            title: "Update README health section",
            stepIndex: 2,
            dependencyStepKeys: ["endpoint-tests"],
            executorKind: "manual",
            metadata: { instructions: "Update docs", taskType: "implementation" }
          },
          {
            stepKey: "final-review",
            title: "Run final review for regressions",
            stepIndex: 3,
            dependencyStepKeys: ["readme-update"],
            executorKind: "manual",
            metadata: { instructions: "Final review", taskType: "milestone" }
          }
        ]
      });

      for (let i = 0; i < 40; i += 1) {
        const graph = fixture.orchestratorService.getRunGraph({ runId, timelineLimit: 0 });
        if (graph.run.status === "succeeded" || graph.run.status === "failed" || graph.run.status === "canceled") {
          break;
        }
        const ready = graph.steps.filter((step) => {
          if (step.status !== "ready") return false;
          // Skip system-managed steps (e.g. planner-launch-tracker) — they are
          // created automatically by the coordinator and should not be driven
          // by the smoke-runner loop.
          const meta = step.metadata && typeof step.metadata === "object" && !Array.isArray(step.metadata)
            ? (step.metadata as Record<string, unknown>)
            : {};
          return !meta.systemManaged;
        });
        if (!ready.length) {
          fixture.orchestratorService.tick({ runId });
          continue;
        }
        for (const step of ready) {
          const attempt = await fixture.orchestratorService.startAttempt({
            runId,
            stepId: step.id,
            ownerId: "smoke-runner",
            executorKind: "manual"
          });
          await fixture.orchestratorService.completeAttempt({
            attemptId: attempt.id,
            status: "succeeded",
            result: {
              schema: "ade.orchestratorAttempt.v1",
              success: true,
              summary: `Completed ${step.title}`,
              outputs: { smoke: true, stepKey: step.stepKey },
              warnings: [],
              sessionId: null,
              trackedSession: true
            }
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

      // tick() no longer auto-terminates runs — explicitly finalize.
      fixture.aiOrchestratorService.finalizeRun({ runId, force: true });

      await fixture.aiOrchestratorService.syncMissionFromRun(runId, "smoke_finalize");
      const finalGraph = fixture.orchestratorService.getRunGraph({ runId, timelineLimit: 0 });
      const refreshedMission = fixture.missionService.get(mission.id);
      expect(finalGraph.run.status).toBe("succeeded");
      // Filter out system-managed steps (e.g. planner-launch-tracker) which
      // may remain in a non-succeeded state since they are not driven by the
      // smoke test loop.
      const userSteps = finalGraph.steps.filter((step) => {
        const meta = step.metadata && typeof step.metadata === "object" && !Array.isArray(step.metadata)
          ? (step.metadata as Record<string, unknown>)
          : {};
        return !meta.systemManaged;
      });
      expect(userSteps.every((step) => step.status === "succeeded")).toBe(true);
      expect(refreshedMission?.status).toBe("completed");
      expect(refreshedMission?.openInterventions ?? 0).toBe(0);

      fixture.aiOrchestratorService.sendChat({
        missionId: mission.id,
        content: "status update"
      });

      await waitFor(() =>
        fixture.aiOrchestratorService.getChat({ missionId: mission.id })
          .some((entry) => entry.role === "orchestrator" && entry.content.includes("Progress"))
      );

      const sweep = await fixture.aiOrchestratorService.runHealthSweep("smoke_post");
      expect(sweep.sweeps).toBeGreaterThanOrEqual(0);
      expect(sweep.staleRecovered).toBeGreaterThanOrEqual(0);
    } finally {
      fixture.dispose();
    }
  });

  it("runs a complex mock prompt with AI planning, auto lanes, and dependency-safe orchestration", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-orchestrator-complex-"));
    fs.mkdirSync(path.join(projectRoot, "docs", "architecture"), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, "docs", "PRD.md"), "# PRD\n", "utf8");
    fs.writeFileSync(path.join(projectRoot, "docs", "architecture", "SYSTEM_OVERVIEW.md"), "# Architecture\n", "utf8");

    const db = await openKvDb(path.join(projectRoot, ".ade.db"), createLogger());
    const projectId = "proj-complex";
    const laneId = "lane-primary";
    const now = "2026-02-21T00:00:00.000Z";

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
        "Primary",
        null,
        "worktree",
        "main",
        "feature/primary",
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
    const projectConfigService = {
      get: () => ({
        effective: {
          ai: {
            orchestrator: {}
          }
        }
      })
    } as any;

    const complexPlan = {
      schemaVersion: "1.0",
      missionSummary: {
        title: "Complex multi-lane mission",
        objective: "Parallel implementation with integration and quality gates",
        domain: "mixed",
        complexity: "high",
        strategy: "parallel-first",
        parallelismCap: 4
      },
      assumptions: [
        "Service contracts are stable.",
        "Test harness is available locally."
      ],
      risks: [
        "Parallel edits may drift without integration contract checks."
      ],
      steps: [
        {
          stepId: "api-health-route",
          name: "Build health API route",
          description: "Implement GET /api/health with version and timestamp payload.",
          taskType: "code",
          executorHint: "opencode",
          preferredScope: "lane",
          requiresContextProfiles: ["deterministic"],
          dependencies: [],
          artifactHints: ["api_diff"],
          claimPolicy: { lanes: ["backend"] },
          maxAttempts: 2,
          retryPolicy: { baseMs: 5000, maxMs: 120000, multiplier: 2, maxRetries: 1 },
          outputContract: { expectedSignals: ["endpoint_added"], completionCriteria: "endpoint_added" }
        },
        {
          stepId: "runtime-watchdog-hardening",
          name: "Harden watchdog recovery",
          description: "Improve stall detection and recovery path instrumentation for mission workers.",
          taskType: "code",
          executorHint: "opencode",
          preferredScope: "lane",
          requiresContextProfiles: ["deterministic"],
          dependencies: [],
          artifactHints: ["watchdog_diff"],
          claimPolicy: { lanes: ["backend"] },
          maxAttempts: 2,
          retryPolicy: { baseMs: 5000, maxMs: 120000, multiplier: 2, maxRetries: 1 },
          outputContract: { expectedSignals: ["watchdog_hardened"], completionCriteria: "watchdog_hardened" }
        },
        {
          stepId: "ui-telemetry-panel",
          name: "Add mission telemetry panel UI",
          description: "Expose run/step/worker telemetry in mission detail panel.",
          taskType: "code",
          executorHint: "opencode",
          preferredScope: "lane",
          requiresContextProfiles: ["deterministic"],
          dependencies: [],
          artifactHints: ["ui_diff"],
          claimPolicy: { lanes: ["frontend"] },
          maxAttempts: 2,
          retryPolicy: { baseMs: 5000, maxMs: 120000, multiplier: 2, maxRetries: 1 },
          outputContract: { expectedSignals: ["ui_telemetry_visible"], completionCriteria: "ui_telemetry_visible" }
        },
        {
          stepId: "integration-contract-check",
          name: "Integrate contracts and orchestration data model",
          description: "Validate interface compatibility across API, runtime, and UI changes.",
          taskType: "integration",
          executorHint: "opencode",
          preferredScope: "lane",
          requiresContextProfiles: ["deterministic"],
          dependencies: ["api-health-route", "runtime-watchdog-hardening", "ui-telemetry-panel"],
          artifactHints: ["integration_report"],
          claimPolicy: { lanes: ["integration"] },
          maxAttempts: 2,
          retryPolicy: { baseMs: 5000, maxMs: 120000, multiplier: 2, maxRetries: 1 },
          outputContract: { expectedSignals: ["contracts_validated"], completionCriteria: "contracts_validated" }
        },
        {
          stepId: "docs-and-readme",
          name: "Update docs and README",
          description: "Document new endpoint and orchestration behavior updates.",
          taskType: "docs",
          executorHint: "opencode",
          preferredScope: "lane",
          requiresContextProfiles: ["deterministic"],
          dependencies: ["integration-contract-check"],
          artifactHints: ["docs_diff"],
          claimPolicy: { lanes: ["analysis"] },
          maxAttempts: 2,
          retryPolicy: { baseMs: 5000, maxMs: 120000, multiplier: 2, maxRetries: 1 },
          outputContract: { expectedSignals: ["docs_updated"], completionCriteria: "docs_updated" }
        },
        {
          stepId: "test-matrix",
          name: "Execute endpoint and orchestration test matrix",
          description: "Run targeted tests across API, orchestrator, and mission UI modules.",
          taskType: "test",
          executorHint: "opencode",
          preferredScope: "lane",
          requiresContextProfiles: ["deterministic"],
          dependencies: ["integration-contract-check"],
          artifactHints: ["test_output"],
          claimPolicy: { lanes: ["backend"] },
          maxAttempts: 2,
          retryPolicy: { baseMs: 5000, maxMs: 120000, multiplier: 2, maxRetries: 1 },
          outputContract: { expectedSignals: ["tests_passed"], completionCriteria: "tests_passed" }
        },
        {
          stepId: "rollback-and-risk-check",
          name: "Perform rollback and risk sanity check",
          description: "Verify rollback path and capture edge-case risk notes.",
          taskType: "analysis",
          executorHint: "opencode",
          preferredScope: "lane",
          requiresContextProfiles: ["deterministic"],
          dependencies: ["integration-contract-check"],
          artifactHints: ["risk_notes"],
          claimPolicy: { lanes: ["analysis"] },
          maxAttempts: 1,
          retryPolicy: { baseMs: 5000, maxMs: 120000, multiplier: 2, maxRetries: 0 },
          outputContract: { expectedSignals: ["risk_checked"], completionCriteria: "risk_checked" }
        },
        {
          stepId: "final-review-gate",
          name: "Finalize review gate",
          description: "Validate regressions, edge cases, and code quality before mission closeout.",
          taskType: "review",
          executorHint: "opencode",
          preferredScope: "lane",
          requiresContextProfiles: ["deterministic"],
          dependencies: ["docs-and-readme", "test-matrix", "rollback-and-risk-check"],
          artifactHints: ["review_summary"],
          claimPolicy: { lanes: ["integration"] },
          maxAttempts: 2,
          retryPolicy: { baseMs: 5000, maxMs: 120000, multiplier: 2, maxRetries: 1 },
          outputContract: { expectedSignals: ["review_complete"], completionCriteria: "review_complete" }
        }
      ],
      handoffPolicy: {
        externalConflictDefault: "intervention"
      }
    };

    const aiIntegrationService = {
      getAvailability: () => ({ claude: true, codex: true, cursor: false }),
      getMode: () => "subscription",
      getFeatureFlag: () => true,
      getDailyBudgetLimit: () => null,
      getDailyUsage: () => 0,
      executeTask: vi.fn().mockImplementation(async (request: { prompt?: string }) => {
        const prompt = String(request?.prompt ?? "");
        const structuredOutput = buildDecisionStructuredOutput(prompt);
        return {
          text: structuredOutput ? JSON.stringify(structuredOutput) : "orchestrator chat response",
          structuredOutput,
          provider: "claude",
          model: "claude-sonnet-4-6",
          sessionId: "complex-chat-1",
          inputTokens: 32,
          outputTokens: 16,
          durationMs: 30
        };
      }),
      listModels: vi.fn().mockResolvedValue([])
    } as any;

    let laneCounter = 0;
    let resultLaneCounter = 0;
    const laneService = {
      list: vi.fn(async ({ includeArchived }: { includeArchived?: boolean } = {}) => db.all<{
        id: string;
        project_id: string;
        name: string;
        lane_type: string | null;
        base_ref: string | null;
        branch_ref: string | null;
        worktree_path: string | null;
        attached_root_path: string | null;
        status: string | null;
        archived_at: string | null;
        mission_id: string | null;
        lane_role: string | null;
      }>(
        `
          select
            id,
            project_id,
            name,
            lane_type,
            base_ref,
            branch_ref,
            worktree_path,
            attached_root_path,
            status,
            archived_at,
            mission_id,
            lane_role
          from lanes
          where project_id = ?
            and (? = 1 or archived_at is null)
          order by created_at asc, id asc
        `,
        [projectId, includeArchived ? 1 : 0]
      ).map((row) => ({
        id: row.id,
        projectId: row.project_id,
        name: row.name,
        laneType: row.lane_type === "primary" ? "primary" : "worktree",
        baseRef: row.base_ref,
        branchRef: row.branch_ref,
        worktreePath: row.worktree_path,
        attachedRootPath: row.attached_root_path,
        status: row.archived_at ? "archived" : row.status === "archived" ? "archived" : "active",
        missionId: row.mission_id,
        laneRole: row.lane_role,
        archivedAt: row.archived_at,
      }))),
      createChild: vi.fn().mockImplementation(async ({
        parentLaneId,
        name,
        missionId,
        laneRole,
      }: {
        parentLaneId: string;
        name: string;
        missionId?: string | null;
        laneRole?: string | null;
      }) => {
        laneCounter += 1;
        const id = `lane-child-${laneCounter}`;
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
              folder,
              mission_id,
              lane_role,
              status,
              created_at,
              archived_at
            ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [
            id,
            projectId,
            name,
            "Auto child lane for complex orchestration test",
            "worktree",
            "main",
            `feature/${id}`,
            projectRoot,
            null,
            0,
            parentLaneId,
            null,
            null,
            null,
            null,
            missionId ?? null,
            laneRole ?? null,
            "active",
            new Date().toISOString(),
            null
          ]
        );
        return {
          id,
          name,
          laneType: "worktree",
          branchRef: `feature/${id}`,
          worktreePath: projectRoot,
          missionId: missionId ?? null,
          laneRole: laneRole ?? null,
        };
      }),
      archive: vi.fn(async ({ laneId: targetLaneId }: { laneId: string }) => {
        db.run(
          `update lanes set status = 'archived', archived_at = ? where id = ? and project_id = ?`,
          [new Date().toISOString(), targetLaneId, projectId]
        );
      }),
      setMissionOwnership: vi.fn(async ({
        laneId: targetLaneId,
        missionId,
        laneRole,
      }: {
        laneId: string;
        missionId: string | null;
        laneRole?: string | null;
      }) => {
        db.run(
          `update lanes set mission_id = ?, lane_role = ? where id = ? and project_id = ?`,
          [missionId, laneRole ?? null, targetLaneId, projectId]
        );
      }),
      getLaneWorktreePath: vi.fn((targetLaneId: string) => {
        const row = db.get<{ worktree_path: string | null }>(
          `select worktree_path from lanes where id = ? and project_id = ? limit 1`,
          [targetLaneId, projectId]
        );
        return row?.worktree_path ?? projectRoot;
      }),
    } as any;
    const prService = {
      createIntegrationLane: vi.fn(async ({
        sourceLaneIds,
        integrationLaneName,
        missionId,
        laneRole,
      }: {
        sourceLaneIds: string[];
        integrationLaneName: string;
        missionId?: string | null;
        laneRole?: string | null;
      }) => {
        resultLaneCounter += 1;
        const resultLaneId = `complex-result-${resultLaneCounter}`;
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
              folder,
              mission_id,
              lane_role,
              status,
              created_at,
              archived_at
            ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [
            resultLaneId,
            projectId,
            integrationLaneName,
            "Complex smoke result lane",
            "worktree",
            "main",
            `integration/${resultLaneId}`,
            projectRoot,
            null,
            0,
            laneId,
            null,
            null,
            null,
            null,
            missionId ?? null,
            laneRole ?? "result",
            "active",
            new Date().toISOString(),
            null,
          ]
        );
        return {
          integrationLane: {
            id: resultLaneId,
            name: integrationLaneName,
            laneType: "worktree",
            branchRef: `integration/${resultLaneId}`,
            worktreePath: projectRoot,
            missionId: missionId ?? null,
            laneRole: laneRole ?? "result",
          },
          mergeResults: sourceLaneIds.map((sourceLaneId) => ({ laneId: sourceLaneId, success: true })),
        };
      }),
    } as any;

    const orchestratorService = createOrchestratorService({
      db,
      projectId,
      projectRoot,
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
      prService,
      projectRoot
    });

    try {
      const complexPrompt = [
        "Build a complex mission that exercises multi-lane orchestration.",
        "Parallelize backend API, runtime watchdog improvements, and mission UI telemetry.",
        "Then perform integration contract verification, docs update, full test matrix, and a final review gate.",
        "Require lane fan-out, dependency-safe joins, and mission status reporting."
      ].join("\n");

      const mission = missionService.create({
        prompt: complexPrompt,
        laneId
      });
      setMissionPlanningMode(db, mission.id, "off");

      orchestratorService.registerExecutorAdapter({
        kind: "codex",
        start: async ({ step }) => ({
          status: "completed",
          result: {
            schema: "ade.orchestratorAttempt.v1",
            success: true,
            summary: `Auto-completed ${step.stepKey}`,
            outputs: { auto: true, stepKey: step.stepKey, observerMode: true },
            warnings: [],
            sessionId: null,
            trackedSession: true
          }
        })
      });
      orchestratorService.registerExecutorAdapter({
        kind: "claude",
        start: async ({ step }) => ({
          status: "completed",
          result: {
            schema: "ade.orchestratorAttempt.v1",
            success: true,
            summary: `Auto-completed ${step.stepKey}`,
            outputs: { auto: true, stepKey: step.stepKey, observerMode: true },
            warnings: [],
            sessionId: null,
            trackedSession: true
          }
        })
      });
      orchestratorService.registerExecutorAdapter({
        kind: "opencode",
        start: async ({ step }) => ({
          status: "completed",
          result: {
            schema: "ade.orchestratorAttempt.v1",
            success: true,
            summary: `Auto-completed ${step.stepKey}`,
            outputs: { auto: true, stepKey: step.stepKey, observerMode: true },
            warnings: [],
            sessionId: null,
            trackedSession: true
          }
        })
      });

      const launch = await aiOrchestratorService.startMissionRun({
        missionId: mission.id,
        runMode: "autopilot",
        defaultExecutorKind: "opencode",
        plannerProvider: "claude"
      });
      if (!launch.started) throw new Error("Expected complex mission run to start");
      const runId = launch.started.run.id;
      const initialRunRow = db.get<{ metadata_json: string | null }>(
        `select metadata_json from orchestrator_runs where id = ? limit 1`,
        [runId]
      );
      const initialRunMetadata = initialRunRow?.metadata_json
        ? (JSON.parse(initialRunRow.metadata_json) as Record<string, unknown>)
        : {};
      delete initialRunMetadata.phaseConfiguration;
      delete initialRunMetadata.phaseOverride;
      delete initialRunMetadata.phaseRuntime;
      db.run(
        `update orchestrator_runs set metadata_json = ?, updated_at = ? where id = ?`,
        [JSON.stringify(initialRunMetadata), new Date().toISOString(), runId]
      );

      // In the AI-first flow, startMissionRun creates an empty run.
      // Simulate the coordinator creating child lanes and adding steps.
      const childLane1 = await laneService.createChild({ parentLaneId: laneId, name: "parallel-1" });
      const childLane2 = await laneService.createChild({ parentLaneId: laneId, name: "parallel-2" });

      // Record parallel lane metadata on the mission
      const mRow = db.get<{ metadata_json: string | null }>(
        `select metadata_json from missions where id = ?`,
        [mission.id]
      );
      const mMeta = mRow?.metadata_json ? JSON.parse(mRow.metadata_json) : {};
      mMeta.parallelLanes = {
        enabled: true,
        createdLaneIds: [childLane1.id, childLane2.id],
        assignedSteps: 3
      };
      db.run(`update missions set metadata_json = ? where id = ?`, [JSON.stringify(mMeta), mission.id]);

      const workerModelId = "anthropic/claude-sonnet-4-6";

      // Add steps from the complex plan, assigning lanes
      orchestratorService.addSteps({
        runId,
        steps: [
          {
            stepKey: "api-health-route",
            title: "Build health API route",
            stepIndex: 0,
            dependencyStepKeys: [],
            executorKind: "opencode",
            laneId,
            metadata: {
              instructions: "Implement GET /api/health",
              modelId: workerModelId,
              taskType: "implementation",
              phaseKey: "development",
              phaseName: "Development",
            }
          },
          {
            stepKey: "runtime-watchdog-hardening",
            title: "Harden watchdog recovery",
            stepIndex: 1,
            dependencyStepKeys: [],
            executorKind: "opencode",
            laneId: childLane1.id,
            metadata: {
              instructions: "Improve stall detection",
              modelId: workerModelId,
              taskType: "implementation",
              phaseKey: "development",
              phaseName: "Development",
            }
          },
          {
            stepKey: "ui-telemetry-panel",
            title: "Add mission telemetry panel UI",
            stepIndex: 2,
            dependencyStepKeys: [],
            executorKind: "opencode",
            laneId: childLane2.id,
            metadata: {
              instructions: "Expose telemetry in UI",
              modelId: workerModelId,
              taskType: "implementation",
              phaseKey: "development",
              phaseName: "Development",
            }
          },
          {
            stepKey: "integration-contract-check",
            title: "Integrate contracts and orchestration data model",
            stepIndex: 3,
            dependencyStepKeys: ["api-health-route", "runtime-watchdog-hardening", "ui-telemetry-panel"],
            executorKind: "opencode",
            laneId,
            metadata: {
              instructions: "Validate interface compatibility",
              modelId: workerModelId,
              taskType: "integration",
              phaseKey: "development",
              phaseName: "Development",
            }
          },
          {
            stepKey: "docs-and-readme",
            title: "Update docs and README",
            stepIndex: 4,
            dependencyStepKeys: ["integration-contract-check"],
            executorKind: "opencode",
            laneId,
            metadata: {
              instructions: "Document changes",
              modelId: workerModelId,
              taskType: "implementation",
              phaseKey: "development",
              phaseName: "Development",
            }
          },
          {
            stepKey: "test-matrix",
            title: "Execute endpoint and orchestration test matrix",
            stepIndex: 5,
            dependencyStepKeys: ["integration-contract-check"],
            executorKind: "opencode",
            laneId,
            metadata: {
              instructions: "Run tests",
              modelId: workerModelId,
              taskType: "test",
              phaseKey: "testing",
              phaseName: "Testing",
            }
          },
          {
            stepKey: "rollback-and-risk-check",
            title: "Perform rollback and risk sanity check",
            stepIndex: 6,
            dependencyStepKeys: ["integration-contract-check"],
            executorKind: "opencode",
            laneId,
            metadata: {
              instructions: "Verify rollback path",
              modelId: workerModelId,
              taskType: "validation",
              phaseKey: "validation",
              phaseName: "Validation",
            }
          },
          {
            stepKey: "final-review-gate",
            title: "Finalize review gate",
            stepIndex: 7,
            dependencyStepKeys: ["docs-and-readme", "test-matrix", "rollback-and-risk-check"],
            executorKind: "opencode",
            laneId,
            metadata: {
              instructions: "Final review",
              modelId: workerModelId,
              taskType: "milestone",
              phaseKey: "validation",
              phaseName: "Validation",
            }
          }
        ]
      });

      // Force a wider cap for this specific smoke scenario so parallel lane
      // execution remains deterministic under test timing constraints.
      const runRow = db.get<{ metadata_json: string | null }>(
        `select metadata_json from orchestrator_runs where id = ?`,
        [runId]
      );
      const runMeta = runRow?.metadata_json
        ? (JSON.parse(runRow.metadata_json) as Record<string, unknown>)
        : {};
      const autopilot = runMeta.autopilot && typeof runMeta.autopilot === "object" && !Array.isArray(runMeta.autopilot)
        ? { ...(runMeta.autopilot as Record<string, unknown>) }
        : {};
      runMeta.maxParallelWorkers = 4;
      runMeta.autopilot = {
        ...autopilot,
        enabled: true,
        executorKind: "opencode",
        ownerId: typeof autopilot.ownerId === "string" ? autopilot.ownerId : "orchestrator-autopilot",
        parallelismCap: 4
      };
      db.run(
        `update orchestrator_runs set metadata_json = ?, updated_at = ? where id = ?`,
        [JSON.stringify(runMeta), new Date().toISOString(), runId]
      );

      // Drive execution: tick to refresh readiness then dispatch autopilot attempts
      let terminalReached = false;
      for (let i = 0; i < 120; i += 1) {
        const graph = orchestratorService.getRunGraph({ runId, timelineLimit: 0 });
        for (const step of graph.steps) {
          const meta = step.metadata && typeof step.metadata === "object" && !Array.isArray(step.metadata)
            ? (step.metadata as Record<string, unknown>)
            : {};
          if (step.stepKey !== "planner-launch-tracker" && meta.plannerLaunchTracker !== true) continue;
          if (step.status !== "pending" && step.status !== "ready" && step.status !== "running") continue;
          const skippedAt = new Date().toISOString();
          db.run(
            `
              update orchestrator_steps
              set status = 'skipped',
                  started_at = coalesce(started_at, ?),
                  completed_at = ?,
                  updated_at = ?
              where id = ?
            `,
            [skippedAt, skippedAt, skippedAt, step.id]
          );
        }
        const status = graph.run.status;
        if (status === "succeeded" || status === "failed" || status === "canceled") {
          terminalReached = true;
          break;
        }

        // Refresh step readiness and dispatch ready steps via autopilot
        orchestratorService.tick({ runId });
        await orchestratorService.startReadyAutopilotAttempts({ runId, reason: "smoke_test_driver" });

        // Once all user-managed steps are done, explicitly finalize (tick no
        // longer auto-terminates).  System-managed steps like
        // planner-launch-tracker may remain non-terminal because the
        // coordinator agent cannot run inside a test harness.
        const userManagedSteps = graph.steps.filter((s) => {
          const meta = s.metadata && typeof s.metadata === "object" && !Array.isArray(s.metadata)
            ? (s.metadata as Record<string, unknown>)
            : {};
          return !meta.systemManaged;
        });
        const allStepsDone = userManagedSteps.length > 0 && userManagedSteps.every(
          (s) => s.status === "succeeded" || s.status === "skipped" || s.status === "failed" || s.status === "canceled"
        );
        if (allStepsDone && (status === "active" || status === "completing" || status === "bootstrapping")) {
          aiOrchestratorService.finalizeRun({ runId, force: true });
          const afterFinalize = orchestratorService.getRunGraph({ runId, timelineLimit: 0 }).run.status;
          if (afterFinalize === "succeeded" || afterFinalize === "failed" || afterFinalize === "canceled") {
            terminalReached = true;
            break;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!terminalReached) {
        const graph = orchestratorService.getRunGraph({ runId, timelineLimit: 1_000 });
        const debugPayload = {
          runId,
          runStatus: graph.run.status,
          steps: graph.steps.map((step) => ({
            stepKey: step.stepKey,
            status: step.status,
            laneId: step.laneId
          })),
          attempts: graph.attempts.map((attempt) => ({
            stepId: attempt.stepId,
            status: attempt.status,
            errorClass: attempt.errorClass,
            errorMessage: attempt.errorMessage
          })),
          timelineTail: graph.timeline.slice(-40)
        };
        fs.writeFileSync("/tmp/ade-orchestrator-complex-timeout-debug.json", `${JSON.stringify(debugPayload, null, 2)}\n`, "utf8");
        throw new Error(`Observer run did not reach terminal state (run status: ${graph.run.status}).`);
      }

      await aiOrchestratorService.syncMissionFromRun(runId, "complex_smoke_finalize");
      const sweep = await aiOrchestratorService.runHealthSweep("complex_smoke_post");

      const finalGraph = orchestratorService.getRunGraph({ runId, timelineLimit: 1_000 });
      const refreshedMission = missionService.get(mission.id);
      expect(finalGraph.run.status).toBe("succeeded");
      expect(refreshedMission?.status).toBe("completed");

      const stepById = new Map(finalGraph.steps.map((step) => [step.id, step] as const));
      const stepByKey = new Map(finalGraph.steps.map((step) => [step.stepKey, step] as const));
      const attemptsByStepKey = new Map<string, typeof finalGraph.attempts>();
      for (const attempt of finalGraph.attempts) {
        const step = stepById.get(attempt.stepId);
        if (!step) continue;
        const bucket = attemptsByStepKey.get(step.stepKey) ?? [];
        bucket.push(attempt);
        attemptsByStepKey.set(step.stepKey, bucket);
      }

      const integrationAttempt = (attemptsByStepKey.get("integration-contract-check") ?? [])
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))[0];
      expect(integrationAttempt).toBeTruthy();

      const rootKeys = ["api-health-route", "runtime-watchdog-hardening", "ui-telemetry-panel"];
      for (const rootKey of rootKeys) {
        const rootAttempt = (attemptsByStepKey.get(rootKey) ?? [])[0];
        expect(rootAttempt).toBeTruthy();
        expect(Date.parse(rootAttempt!.completedAt ?? rootAttempt!.createdAt)).toBeLessThanOrEqual(
          Date.parse(integrationAttempt!.startedAt ?? integrationAttempt!.createdAt)
        );
      }

      const metadataRow = db.get<{ metadata_json: string | null }>(
        `select metadata_json from missions where id = ?`,
        [mission.id]
      );
      const missionMetadata = metadataRow?.metadata_json ? JSON.parse(metadataRow.metadata_json) : {};
      const parallelLanes = missionMetadata.parallelLanes as {
        enabled?: boolean;
        createdLaneIds?: string[];
        assignedSteps?: number;
      } | undefined;
      expect(parallelLanes?.enabled).toBe(true);
      expect((parallelLanes?.createdLaneIds ?? []).length).toBeGreaterThanOrEqual(1);
      expect(parallelLanes?.assignedSteps ?? 0).toBeGreaterThanOrEqual(2);

      const rootLaneIds = rootKeys
        .map((key) => stepByKey.get(key)?.laneId ?? null)
        .filter((value): value is string => Boolean(value));
      expect(new Set(rootLaneIds).size).toBeGreaterThanOrEqual(2);

      const timelineCounts = finalGraph.timeline.reduce<Record<string, number>>((acc, entry) => {
        acc[entry.eventType] = (acc[entry.eventType] ?? 0) + 1;
        return acc;
      }, {});
      const stepSummary = finalGraph.steps.map((step) => ({
        stepKey: step.stepKey,
        title: step.title,
        status: step.status,
        laneId: step.laneId,
        dependencies: step.dependencyStepIds.map((depId) => stepById.get(depId)?.stepKey ?? depId)
      }));

      const report = {
        missionId: mission.id,
        runId,
        executionMode: "observer_autopilot_no_manual_intervention",
        prompt: complexPrompt,
        runStatus: finalGraph.run.status,
        missionStatus: refreshedMission?.status ?? "unknown",
        totalSteps: finalGraph.steps.length,
        totalAttempts: finalGraph.attempts.length,
        rootStepCount: rootKeys.length,
        rootLaneIds,
        uniqueRootLaneCount: new Set(rootLaneIds).size,
        parallelLaneMetadata: parallelLanes ?? null,
        autopilotMetadata: finalGraph.run.metadata?.autopilot ?? null,
        healthSweep: sweep,
        timelineCounts,
        stepSummary
      };

      const reportPath = "/tmp/ade-orchestrator-complex-mock-report.json";
      fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      expect(fs.existsSync(reportPath)).toBe(true);
    } finally {
      aiOrchestratorService.dispose();
      db.close();
    }
  }, 60_000);
});
