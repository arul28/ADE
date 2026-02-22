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

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error("Timed out waiting for smoke condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
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
  const projectConfigService = {
    get: () => ({
      effective: {
        ai: {
          orchestrator: {
            requirePlanReview: false
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
    laneService: null,
    projectConfigService,
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

      const launch = await fixture.aiOrchestratorService.startMissionRun({
        missionId: mission.id,
        runMode: "manual",
        defaultExecutorKind: "manual",
        plannerProvider: "deterministic"
      });
      if (!launch.started) throw new Error("Expected smoke run to start");
      const runId = launch.started.run.id;

      for (let i = 0; i < 40; i += 1) {
        const graph = fixture.orchestratorService.getRunGraph({ runId, timelineLimit: 0 });
        if (graph.run.status === "succeeded" || graph.run.status === "succeeded_with_risk" || graph.run.status === "failed" || graph.run.status === "canceled") {
          break;
        }
        const ready = graph.steps.filter((step) => step.status === "ready");
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
          fixture.orchestratorService.completeAttempt({
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

      fixture.aiOrchestratorService.syncMissionFromRun(runId, "smoke_finalize");
      const finalGraph = fixture.orchestratorService.getRunGraph({ runId, timelineLimit: 0 });
      const refreshedMission = fixture.missionService.get(mission.id);
      // With policy-aware evaluation, runs without step-type metadata resolve to
      // succeeded_with_risk because the evaluator cannot confirm required phases.
      expect(["succeeded", "succeeded_with_risk"]).toContain(finalGraph.run.status);
      expect(finalGraph.steps.every((step) => step.status === "succeeded")).toBe(true);
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
            orchestrator: {
              requirePlanReview: false
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
          executorHint: "codex",
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
          executorHint: "codex",
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
          executorHint: "codex",
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
          executorHint: "codex",
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
          executorHint: "claude",
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
          executorHint: "codex",
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
          executorHint: "claude",
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
          executorHint: "claude",
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
      getAvailability: () => ({ claude: true, codex: true }),
      getMode: () => "subscription",
      getFeatureFlag: () => true,
      getDailyBudgetLimit: () => null,
      getDailyUsage: () => 0,
      executeTask: vi.fn().mockResolvedValue({
        text: "orchestrator chat response",
        structuredOutput: null,
        provider: "claude",
        model: "claude-sonnet-4-6",
        sessionId: "complex-chat-1",
        inputTokens: 32,
        outputTokens: 16,
        durationMs: 30
      }),
      planMission: vi.fn().mockResolvedValue({
        text: JSON.stringify(complexPlan),
        structuredOutput: complexPlan,
        provider: "claude",
        model: "claude-sonnet-4-6",
        sessionId: "complex-plan-1",
        inputTokens: 210,
        outputTokens: 450,
        durationMs: 80
      }),
      listModels: vi.fn().mockResolvedValue([])
    } as any;

    let laneCounter = 0;
    const laneService = {
      createChild: vi.fn().mockImplementation(async ({ parentLaneId, name }: { parentLaneId: string; name: string }) => {
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
              status,
              created_at,
              archived_at
            ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            "active",
            new Date().toISOString(),
            null
          ]
        );
        return { id, name };
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

      const launch = await aiOrchestratorService.startMissionRun({
        missionId: mission.id,
        runMode: "autopilot",
        defaultExecutorKind: "codex",
        plannerProvider: "claude"
      });
      if (!launch.started) throw new Error("Expected complex mission run to start");
      const runId = launch.started.run.id;

      let terminalReached = false;
      for (let i = 0; i < 120; i += 1) {
        const status = orchestratorService.getRunGraph({ runId, timelineLimit: 0 }).run.status;
        if (status === "succeeded" || status === "succeeded_with_risk" || status === "failed" || status === "canceled") {
          terminalReached = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
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

      aiOrchestratorService.syncMissionFromRun(runId, "complex_smoke_finalize");
      const sweep = await aiOrchestratorService.runHealthSweep("complex_smoke_post");

      const finalGraph = orchestratorService.getRunGraph({ runId, timelineLimit: 1_000 });
      const refreshedMission = missionService.get(mission.id);
      // With policy-aware evaluation, runs without step-type metadata resolve to
      // succeeded_with_risk because the evaluator cannot confirm required phases.
      expect(["succeeded", "succeeded_with_risk"]).toContain(finalGraph.run.status);
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
      expect((parallelLanes?.createdLaneIds ?? []).length).toBeGreaterThanOrEqual(2);
      expect(parallelLanes?.assignedSteps ?? 0).toBeGreaterThanOrEqual(2);

      const rootLaneIds = rootKeys
        .map((key) => stepByKey.get(key)?.laneId ?? null)
        .filter((value): value is string => Boolean(value));
      expect(new Set(rootLaneIds).size).toBeGreaterThanOrEqual(3);

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
