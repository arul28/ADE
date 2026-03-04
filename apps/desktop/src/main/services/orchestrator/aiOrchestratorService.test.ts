import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PackDeltaDigestV1, PackExport, PackType } from "../../../shared/types";
import { openKvDb } from "../state/kvDb";
import { createMissionService } from "../missions/missionService";
import { createOrchestratorService } from "./orchestratorService";
import { createAiOrchestratorService, deriveFallbackLaneStrategyDecision } from "./aiOrchestratorService";

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

const VALID_PLANNER_PLAN = JSON.stringify({
  schemaVersion: "1.0",
  missionSummary: {
    title: "Execute mission",
    objective: "Deliver the requested changes",
    domain: "mixed",
    complexity: "medium",
    strategy: "sequential",
    parallelismCap: 1
  },
  assumptions: [],
  risks: [],
  steps: [
    {
      stepId: "implement-changes",
      name: "Implement requested changes",
      description: "Write and apply the code changes described in the mission prompt.",
      taskType: "code",
      executorHint: "either",
      preferredScope: "lane",
      requiresContextProfiles: ["deterministic"],
      dependencies: [],
      artifactHints: [],
      claimPolicy: { lanes: ["backend"] },
      maxAttempts: 2,
      retryPolicy: { baseMs: 5000, maxMs: 120000, multiplier: 2, maxRetries: 1 },
      outputContract: { expectedSignals: ["code_written"], completionCriteria: "code_written" }
    }
  ],
  handoffPolicy: { externalConflictDefault: "intervention" }
});

function buildDefaultDecisionStructuredOutput(prompt: string): Record<string, unknown> | null {
  const normalized = prompt.toLowerCase();
  if (normalized.includes("decision: lane strategy")) {
    const stepKeys = [...prompt.matchAll(/"stepKey"\s*:\s*"([^"]+)"/g)]
      .map((match) => match[1]?.trim())
      .filter((value): value is string => Boolean(value));
    const uniqueStepKeys = [...new Set(stepKeys)];
    const stepAssignments = uniqueStepKeys.map((stepKey, index) => ({
      stepKey,
      laneLabel: index === 1 ? "parallel-1" : "base",
      rationale: index === 1 ? "Run an independent branch in a child lane." : "Keep on the base lane."
    }));
    return {
      strategy: "dependency_parallel",
      maxParallelLanes: 3,
      rationale: "Independent steps can run in parallel lanes.",
      confidence: 0.9,
      stepAssignments
    };
  }
  if (normalized.includes("decision: state transition")) {
    return {
      actionType: "continue",
      reason: "No blockers detected.",
      rationale: "The completed step can transition forward safely.",
      nextStatus: null,
      retryDelayMs: null,
      timeoutBudgetMs: null,
      confidence: 0.86
    };
  }
  if (normalized.includes("decision: parallelism cap")) {
    return {
      parallelismCap: 2,
      rationale: "Use conservative mission-start parallelism.",
      confidence: 0.78
    };
  }
  if (normalized.includes("decision: retry policy")) {
    return {
      shouldRetry: true,
      delayMs: 5000,
      reason: "Transient failure pattern detected.",
      adjustedHint: null,
      confidence: 0.75
    };
  }
  if (normalized.includes("decision: timeout budget")) {
    return {
      timeoutMs: 120000,
      rationale: "Default timeout budget for this step category.",
      confidence: 0.72
    };
  }
  if (normalized.includes("decision: step priority")) {
    return {
      priority: 50,
      laneHint: null,
      rationale: "Balanced default priority.",
      confidence: 0.7
    };
  }
  if (normalized.includes("decision: stagnation evaluation")) {
    return {
      isStagnating: false,
      severity: "low",
      recommendedAction: "continue",
      rationale: "Recent activity indicates forward progress.",
      confidence: 0.7
    };
  }
  if (normalized.includes("decision: quality gate")) {
    return {
      verdict: "pass",
      reason: "No blocking findings.",
      blockingFindings: [],
      confidence: 0.82
    };
  }
  if (normalized.includes("decision: recovery action")) {
    return {
      action: "retry_with_hint",
      reason: "Retrying with explicit guidance is safest.",
      retryHint: "Retry once with focused diagnostics.",
      confidence: 0.68
    };
  }
  if (normalized.includes("decision: mission replan")) {
    return {
      shouldReplan: false,
      summary: "Current mission plan remains valid.",
      planDelta: [],
      confidence: 0.74
    };
  }
  return null;
}

function createAiTaskResult(structuredOutput: Record<string, unknown> | null, textFallback = "{}") {
  return {
    text: structuredOutput ? JSON.stringify(structuredOutput) : textFallback,
    structuredOutput,
    provider: "claude",
    model: "sonnet",
    sessionId: null,
    inputTokens: 100,
    outputTokens: 50,
    durationMs: 1000
  };
}

function createStagnationRecoveryAiIntegrationService() {
  return createMockAiIntegrationService({
    executeTask: vi.fn().mockImplementation(async (request: { prompt?: string }) => {
      const prompt = String(request?.prompt ?? "");
      const structuredOutput = prompt.includes("Decision: stagnation evaluation")
        ? {
            isStagnating: true,
            severity: "high",
            recommendedAction: "continue",
            rationale: "Attempt has exceeded timeout with no meaningful progress.",
            confidence: 0.93
          }
        : buildDefaultDecisionStructuredOutput(prompt);
      return createAiTaskResult(structuredOutput);
    })
  });
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
    executeTask: overrides.executeTask ?? vi.fn().mockImplementation(async (request: { prompt?: string }) => {
      const prompt = String(request?.prompt ?? "");
      const structuredOutput = buildDefaultDecisionStructuredOutput(prompt);
      return createAiTaskResult(structuredOutput);
    }),
    planMission: overrides.planMission ?? vi.fn().mockResolvedValue({
      text: VALID_PLANNER_PLAN,
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

function createMockAgentChatService(overrides: {
  createSession?: (...args: any[]) => Promise<any>;
  sendMessage?: (...args: any[]) => Promise<void>;
  steer?: (...args: any[]) => Promise<void>;
  interrupt?: (...args: any[]) => Promise<void>;
  resumeSession?: (...args: any[]) => Promise<any>;
  listSessions?: (...args: any[]) => Promise<any[]>;
  dispose?: (...args: any[]) => Promise<void>;
} = {}) {
  return {
    createSession: overrides.createSession ?? vi.fn().mockResolvedValue({
      id: "chat-session-1",
      laneId: "lane-1",
      provider: "claude",
      model: "sonnet",
      reasoningEffort: "medium",
      status: "idle",
      createdAt: "2026-02-20T00:00:00.000Z",
      lastActivityAt: "2026-02-20T00:00:00.000Z"
    }),
    sendMessage: overrides.sendMessage ?? vi.fn().mockResolvedValue(undefined),
    steer: overrides.steer ?? vi.fn().mockResolvedValue(undefined),
    interrupt: overrides.interrupt ?? vi.fn().mockResolvedValue(undefined),
    resumeSession: overrides.resumeSession ?? vi.fn().mockResolvedValue({}),
    listSessions: overrides.listSessions ?? vi.fn().mockResolvedValue([]),
    dispose: overrides.dispose ?? vi.fn().mockResolvedValue(undefined)
  } as any;
}

function clearWorkerDeliveryBackoff(db: Awaited<ReturnType<typeof openKvDb>>, messageId: string): void {
  const row = db.get<{ metadata_json: string | null }>(
    `
      select metadata_json
      from orchestrator_chat_messages
      where id = ?
      limit 1
    `,
    [messageId]
  );
  const metadata = row?.metadata_json ? JSON.parse(row.metadata_json) : {};
  const workerDelivery = metadata && typeof metadata.workerDelivery === "object" && !Array.isArray(metadata.workerDelivery)
    ? metadata.workerDelivery
    : {};
  metadata.workerDelivery = {
    ...workerDelivery,
    nextRetryAt: null
  };
  db.run(
    `
      update orchestrator_chat_messages
      set metadata_json = ?
      where id = ?
    `,
    [JSON.stringify(metadata), messageId]
  );
}

function patchWorkerDeliveryMetadata(
  db: Awaited<ReturnType<typeof openKvDb>>,
  messageId: string,
  patch: Record<string, unknown>
): void {
  const row = db.get<{ metadata_json: string | null }>(
    `
      select metadata_json
      from orchestrator_chat_messages
      where id = ?
      limit 1
    `,
    [messageId]
  );
  const metadata = row?.metadata_json ? JSON.parse(row.metadata_json) : {};
  const workerDelivery = metadata && typeof metadata.workerDelivery === "object" && !Array.isArray(metadata.workerDelivery)
    ? metadata.workerDelivery
    : {};
  metadata.workerDelivery = {
    ...workerDelivery,
    ...patch
  };
  db.run(
    `
      update orchestrator_chat_messages
      set metadata_json = ?
      where id = ?
    `,
    [JSON.stringify(metadata), messageId]
  );
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
  agentChatService?: any;
  orchestratorConfig?: Record<string, unknown>;
  logger?: any;
  hookCommandRunner?: any;
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
  const aiIntegrationService = "aiIntegrationService" in args ? args.aiIntegrationService : createMockAiIntegrationService();
  const projectConfigService = {
    get: () => ({
      effective: {
        ai: {
          orchestrator: {
            requirePlanReview: args.requirePlanReview === true,
            ...(args.orchestratorConfig ?? {})
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
  const defaultUnifiedModelId = "anthropic/claude-sonnet-4-6";
  const normalizeStepModelId = (step: any) => {
    const executorKind = typeof step?.executorKind === "string" ? step.executorKind : null;
    if (executorKind !== "unified") return step;
    const metadata =
      step?.metadata && typeof step.metadata === "object" && !Array.isArray(step.metadata)
        ? step.metadata
        : {};
    const modelId = typeof metadata.modelId === "string" ? metadata.modelId.trim() : "";
    if (modelId.length > 0) return { ...step, metadata: { ...metadata, modelId } };
    return {
      ...step,
      metadata: {
        ...metadata,
        modelId: defaultUnifiedModelId,
      },
    };
  };
  const originalStartRun = orchestratorService.startRun.bind(orchestratorService);
  (orchestratorService as any).startRun = ((input: any) =>
    originalStartRun({
      ...input,
      steps: Array.isArray(input?.steps) ? input.steps.map((step: any) => normalizeStepModelId(step)) : input?.steps,
    })) as typeof orchestratorService.startRun;

  const aiOrchestratorService = createAiOrchestratorService({
    db,
    logger: args.logger ?? createLogger(),
    missionService,
    orchestratorService,
    agentChatService: args.agentChatService ?? null,
    laneService,
    projectConfigService,
    aiIntegrationService,
    projectRoot,
    hookCommandRunner: args.hookCommandRunner
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
  it("starts mission directly without opening plan-review intervention when requirePlanReview is true", async () => {
    const fixture = await createFixture({ requirePlanReview: true });
    let started: any;
    try {
      const mission = fixture.missionService.create({
        prompt: "Implement orchestration startup policy and summarize outcomes.",
        laneId: fixture.laneId
      });

      started = await fixture.aiOrchestratorService.startMissionRun({
        missionId: mission.id,
        runMode: "autopilot",
        defaultExecutorKind: "unified"
      });
      // In the AI-first flow, there is no plan review gate — the coordinator handles everything.
      // The mission goes directly to in_progress.
      expect(started.started).toBeTruthy();
      const refreshed = fixture.missionService.get(mission.id);
      expect(refreshed?.status).toBe("in_progress");
      expect(refreshed?.interventions ?? []).toHaveLength(0);
      expect(fixture.orchestratorService.listRuns({ missionId: mission.id }).length).toBe(1);
    } finally {
      fixture.dispose();
    }
  });

  it("starts mission directly in the AI-first flow without plan review gate", async () => {
    const fixture = await createFixture({ requirePlanReview: true });
    try {
      const mission = fixture.missionService.create({
        prompt: "Plan and implement runtime resiliency improvements.",
        laneId: fixture.laneId
      });

      // In the AI-first flow, startMissionRun goes directly to in_progress
      // regardless of requirePlanReview — the coordinator handles everything.
      const launched = await fixture.aiOrchestratorService.startMissionRun({
        missionId: mission.id,
        runMode: "autopilot",
        defaultExecutorKind: "unified"
      });
      expect(launched.started).toBeTruthy();
      expect(launched.started?.run.id).toBeTruthy();
      const refreshed = fixture.missionService.get(mission.id);
      expect(refreshed?.status).toBe("in_progress");
      expect(fixture.orchestratorService.listRuns({ missionId: mission.id }).length).toBe(1);
    } finally {
      fixture.dispose();
    }
  });

  it("persists a run-level autopilot cap from planner summary metadata in AI-first startup", async () => {
    const fixture = await createFixture();
    try {
      const plannerPlan = JSON.parse(VALID_PLANNER_PLAN) as Record<string, unknown>;
      const missionSummary = plannerPlan.missionSummary as Record<string, unknown>;
      missionSummary.parallelismCap = 6;

      const mission = fixture.missionService.create({
        prompt: "Implement orchestration updates with planner-provided cap.",
        laneId: fixture.laneId,
        plannerPlan: plannerPlan as any,
      });

      const launched = await fixture.aiOrchestratorService.startMissionRun({
        missionId: mission.id,
        runMode: "autopilot",
        defaultExecutorKind: "unified",
      });

      expect(launched.started).toBeTruthy();
      const run = launched.started?.run;
      expect(run).toBeTruthy();
      const metadata = (run?.metadata ?? {}) as Record<string, unknown>;
      const autopilot = (metadata.autopilot ?? {}) as Record<string, unknown>;

      expect(metadata.maxParallelWorkers).toBe(6);
      expect(autopilot.enabled).toBe(true);
      expect(autopilot.executorKind).toBe("unified");
      expect(autopilot.parallelismCap).toBe(6);
    } finally {
      fixture.dispose();
    }
  });

  it("persists disabled autopilot metadata for manual AI-first runs", async () => {
    const fixture = await createFixture();
    try {
      const mission = fixture.missionService.create({
        prompt: "Run mission manually and verify autopilot metadata.",
        laneId: fixture.laneId,
      });

      const launched = await fixture.aiOrchestratorService.startMissionRun({
        missionId: mission.id,
        runMode: "manual",
        defaultExecutorKind: "manual",
      });

      expect(launched.started).toBeTruthy();
      const run = launched.started?.run;
      expect(run).toBeTruthy();
      const metadata = (run?.metadata ?? {}) as Record<string, unknown>;
      const autopilot = (metadata.autopilot ?? {}) as Record<string, unknown>;

      expect(metadata.maxParallelWorkers).toBe(4);
      expect(autopilot.enabled).toBe(false);
      expect(autopilot.executorKind).toBe("manual");
      expect(autopilot.parallelismCap).toBe(4);
    } finally {
      fixture.dispose();
    }
  });

  it("does not activate runs when coordinator startup fails", async () => {
    const fixture = await createFixture();
    let noRootService: ReturnType<typeof createAiOrchestratorService> | null = null;
    try {
      fixture.aiOrchestratorService.dispose();
      noRootService = createAiOrchestratorService({
        db: fixture.db,
        logger: createLogger(),
        missionService: fixture.missionService,
        orchestratorService: fixture.orchestratorService,
        laneService: fixture.laneService,
        projectConfigService: fixture.projectConfigService,
        aiIntegrationService: fixture.aiIntegrationService,
        projectRoot: undefined
      });

      const mission = fixture.missionService.create({
        prompt: "Verify coordinator startup gating.",
        laneId: fixture.laneId
      });
      const launched = await noRootService.startMissionRun({
        missionId: mission.id,
        runMode: "autopilot",
        defaultExecutorKind: "unified"
      });
      expect(launched.started).toBeTruthy();

      const run = fixture.orchestratorService.listRuns({ missionId: mission.id })[0];
      expect(run?.status).toBe("paused");
      expect(fixture.orchestratorService.listAttempts({ runId: run?.id ?? "missing" })).toHaveLength(0);

      const refreshed = fixture.missionService.get(mission.id);
      expect(refreshed?.status).toBe("intervention_required");
      expect(
        refreshed?.interventions.some(
          (entry) =>
            entry.status === "open"
            && entry.interventionType === "failed_step"
            && String(entry.metadata?.reasonCode ?? "") === "coordinator_start_failed"
        )
      ).toBe(true);
    } finally {
      noRootService?.dispose();
      fixture.dispose();
    }
  });

  it("pauses runs and blocks fallback runtime handling when coordinator is unavailable", async () => {
    const fixture = await createFixture();
    try {
      const mission = fixture.missionService.create({
        prompt: "Ensure coordinator ownership on runtime events.",
        laneId: fixture.laneId
      });
      const started = fixture.orchestratorService.startRun({
        missionId: mission.id,
        metadata: {
          autopilot: {
            enabled: true,
            executorKind: "unified",
            ownerId: "autopilot-owner",
            parallelismCap: 1
          }
        },
        steps: [{ stepKey: "guarded-step", title: "Guarded step", stepIndex: 0, executorKind: "unified" }]
      });
      fixture.db.run(`update orchestrator_runs set status = 'active', updated_at = ? where id = ?`, [new Date().toISOString(), started.run.id]);
      const step = fixture.orchestratorService.listSteps(started.run.id)[0];
      if (!step) throw new Error("Missing step");

      fixture.aiOrchestratorService.onOrchestratorRuntimeEvent({
        type: "orchestrator-attempt-updated",
        runId: started.run.id,
        stepId: step.id,
        attemptId: "attempt-without-coordinator",
        at: new Date().toISOString(),
        reason: "completed"
      });

      const updatedRun = fixture.orchestratorService.listRuns({ missionId: mission.id }).find((run) => run.id === started.run.id);
      expect(updatedRun?.status).toBe("paused");
      expect(fixture.orchestratorService.listAttempts({ runId: started.run.id })).toHaveLength(0);
    } finally {
      fixture.dispose();
    }
  });

  it("propagates attempt token usage for attempt-updated completed events", async () => {
    const fixture = await createFixture();
    try {
      const mission = fixture.missionService.create({
        prompt: "Track token propagation for completed attempt events.",
        laneId: fixture.laneId
      });
      const launch = await fixture.aiOrchestratorService.startMissionRun({
        missionId: mission.id,
        runMode: "manual",
        defaultExecutorKind: "manual"
      });
      if (!launch.started) throw new Error("Expected mission run to start");
      const runId = launch.started.run.id;

      fixture.orchestratorService.addSteps({
        runId,
        steps: [{ stepKey: "token-step", title: "Token step", stepIndex: 0, dependencyStepKeys: [], executorKind: "manual" }]
      });
      fixture.orchestratorService.tick({ runId });
      const step = fixture.orchestratorService.listSteps(runId).find((entry) => entry.stepKey === "token-step");
      if (!step) throw new Error("Missing token-step");

      const attempt = await fixture.orchestratorService.startAttempt({
        runId,
        stepId: step.id,
        ownerId: "token-owner",
        executorKind: "manual"
      });
      fixture.db.run(`alter table orchestrator_attempts add column session_id text`);
      fixture.db.run(
        `update orchestrator_attempts set session_id = ?, executor_session_id = ? where id = ?`,
        ["token-session-1", "token-session-1", attempt.id]
      );
      fixture.db.run(
        `
          insert into ai_usage_log(
            id, timestamp, feature, provider, model, input_tokens, output_tokens, duration_ms, success, session_id
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          "usage-token-1",
          new Date().toISOString(),
          "orchestrator",
          "claude",
          "sonnet",
          70,
          50,
          200,
          1,
          "token-session-1"
        ]
      );

      fixture.aiOrchestratorService.onOrchestratorRuntimeEvent({
        type: "orchestrator-attempt-updated",
        runId,
        stepId: step.id,
        attemptId: attempt.id,
        at: new Date().toISOString(),
        reason: "completed"
      });

      const runRow = fixture.db.get<{ metadata_json: string | null }>(
        `select metadata_json from orchestrator_runs where id = ? limit 1`,
        [runId]
      );
      const metadata = runRow?.metadata_json ? JSON.parse(runRow.metadata_json) : {};
      expect(Number(metadata.tokensConsumed ?? 0)).toBeGreaterThanOrEqual(120);
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

      // Add steps manually (simulating coordinator creating tasks)
      fixture.orchestratorService.addSteps({
        runId,
        steps: [{
          stepKey: "implement-changes",
          title: "Implement requested changes",
          stepIndex: 0,
          dependencyStepKeys: [],
          laneId: fixture.laneId,
          executorKind: "manual",
          metadata: {
            instructions: "Do the work",
            modelId: "openai/gpt-5.3-codex",
          }
        }]
      });
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
      fixture.aiOrchestratorService.dispose();
    }
  });

  it("pushes terminal sub-agent completion summaries to the parent attempt thread", async () => {
    const fixture = await createFixture();
    try {
      const mission = fixture.missionService.create({
        prompt: "Validate sub-agent completion rollups.",
        laneId: fixture.laneId
      });

      const launch = await fixture.aiOrchestratorService.startMissionRun({
        missionId: mission.id,
        runMode: "manual",
        defaultExecutorKind: "manual"
      });
      if (!launch.started) throw new Error("Expected mission run to start");
      const runId = launch.started.run.id;

      fixture.orchestratorService.addSteps({
        runId,
        steps: [
          {
            stepKey: "parent-worker",
            title: "Parent Worker",
            stepIndex: 0,
            dependencyStepKeys: [],
            laneId: fixture.laneId,
            executorKind: "manual",
            metadata: { instructions: "Own the parent task." }
          },
          {
            stepKey: "child-worker",
            title: "Child Worker",
            stepIndex: 1,
            dependencyStepKeys: [],
            laneId: fixture.laneId,
            executorKind: "manual",
            metadata: {
              instructions: "Sub-agent child task.",
              isSubAgent: true,
              parentWorkerId: "parent-worker"
            }
          }
        ]
      });
      fixture.orchestratorService.tick({ runId });
      const graph = fixture.orchestratorService.getRunGraph({ runId });
      const parentStep = graph.steps.find((step) => step.stepKey === "parent-worker");
      const childStep = graph.steps.find((step) => step.stepKey === "child-worker");
      if (!parentStep || !childStep) throw new Error("Expected parent/child steps");

      const parentAttempt = await fixture.orchestratorService.startAttempt({
        runId,
        stepId: parentStep.id,
        ownerId: "parent-owner",
        executorKind: "manual"
      });
      const childAttempt = await fixture.orchestratorService.startAttempt({
        runId,
        stepId: childStep.id,
        ownerId: "child-owner",
        executorKind: "manual"
      });
      fixture.orchestratorService.completeAttempt({
        attemptId: childAttempt.id,
        status: "succeeded",
        result: {
          schema: "ade.orchestratorAttempt.v1",
          success: true,
          summary: "Implemented child task.",
          outputs: null,
          warnings: [],
          sessionId: null,
          trackedSession: true
        }
      });

      fixture.aiOrchestratorService.onOrchestratorRuntimeEvent({
        type: "orchestrator-step-updated",
        runId,
        stepId: childStep.id,
        attemptId: childAttempt.id,
        at: new Date().toISOString(),
        reason: "attempt_completed"
      });

      const parentThread = fixture.aiOrchestratorService
        .listChatThreads({ missionId: mission.id, includeClosed: true })
        .find((thread) => thread.attemptId === parentAttempt.id);
      expect(parentThread).toBeTruthy();
      if (!parentThread) throw new Error("Expected parent thread");

      const messages = fixture.aiOrchestratorService.getThreadMessages({
        missionId: mission.id,
        threadId: parentThread.id,
        limit: 200
      });
      const rollups = messages.filter((entry) =>
        entry.role === "agent"
        && String(entry.metadata?.source ?? "") === "subagent_result_rollup"
        && entry.content.includes("Sub-agent 'Child Worker' completed (succeeded): Implemented child task.")
      );
      expect(rollups).toHaveLength(1);
    } finally {
      fixture.dispose();
    }
  });

  it("deduplicates sub-agent completion rollups when completion events are replayed", async () => {
    const fixture = await createFixture();
    try {
      const mission = fixture.missionService.create({
        prompt: "Ensure sub-agent completion rollups are deduplicated.",
        laneId: fixture.laneId
      });

      const launch = await fixture.aiOrchestratorService.startMissionRun({
        missionId: mission.id,
        runMode: "manual",
        defaultExecutorKind: "manual"
      });
      if (!launch.started) throw new Error("Expected mission run to start");
      const runId = launch.started.run.id;

      fixture.orchestratorService.addSteps({
        runId,
        steps: [
          {
            stepKey: "parent-worker",
            title: "Parent Worker",
            stepIndex: 0,
            dependencyStepKeys: [],
            laneId: fixture.laneId,
            executorKind: "manual",
            metadata: { instructions: "Parent." }
          },
          {
            stepKey: "child-worker",
            title: "Child Worker",
            stepIndex: 1,
            dependencyStepKeys: [],
            laneId: fixture.laneId,
            executorKind: "manual",
            metadata: {
              instructions: "Child.",
              isSubAgent: true,
              parentWorkerId: "parent-worker"
            }
          }
        ]
      });
      fixture.orchestratorService.tick({ runId });
      const graph = fixture.orchestratorService.getRunGraph({ runId });
      const parentStep = graph.steps.find((step) => step.stepKey === "parent-worker");
      const childStep = graph.steps.find((step) => step.stepKey === "child-worker");
      if (!parentStep || !childStep) throw new Error("Expected parent/child steps");

      const parentAttempt = await fixture.orchestratorService.startAttempt({
        runId,
        stepId: parentStep.id,
        ownerId: "parent-owner",
        executorKind: "manual"
      });
      const childAttempt = await fixture.orchestratorService.startAttempt({
        runId,
        stepId: childStep.id,
        ownerId: "child-owner",
        executorKind: "manual"
      });
      fixture.orchestratorService.completeAttempt({
        attemptId: childAttempt.id,
        status: "succeeded",
        result: {
          schema: "ade.orchestratorAttempt.v1",
          success: true,
          summary: "Child complete.",
          outputs: null,
          warnings: [],
          sessionId: null,
          trackedSession: true
        }
      });

      const completionEvent = {
        type: "orchestrator-attempt-updated" as const,
        runId,
        stepId: childStep.id,
        attemptId: childAttempt.id,
        at: new Date().toISOString(),
        reason: "completed" as const
      };
      fixture.aiOrchestratorService.onOrchestratorRuntimeEvent(completionEvent);
      fixture.aiOrchestratorService.onOrchestratorRuntimeEvent(completionEvent);

      const parentThread = fixture.aiOrchestratorService
        .listChatThreads({ missionId: mission.id, includeClosed: true })
        .find((thread) => thread.attemptId === parentAttempt.id);
      expect(parentThread).toBeTruthy();
      if (!parentThread) throw new Error("Expected parent thread");

      const messages = fixture.aiOrchestratorService.getThreadMessages({
        missionId: mission.id,
        threadId: parentThread.id,
        limit: 200
      });
      const rollups = messages.filter((entry) =>
        entry.role === "agent"
        && String(entry.metadata?.source ?? "") === "subagent_result_rollup"
        && entry.content.includes("Sub-agent 'Child Worker' completed (succeeded): Child complete.")
      );
      expect(rollups).toHaveLength(1);
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

      // Add steps manually (simulating coordinator)
      fixture.orchestratorService.addSteps({
        runId,
        steps: [{
          stepKey: "implement-changes",
          title: "Implement requested changes",
          stepIndex: 0,
          dependencyStepKeys: [],
          laneId: fixture.laneId,
          executorKind: "manual",
          metadata: {
            instructions: "Do the work",
            modelId: "openai/gpt-5.3-codex",
          }
        }]
      });
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
      fixture.aiOrchestratorService.dispose();
    }
  });

  it("gracefully cancels runs by notifying and shutting down active worker sessions before hard cancel", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const interrupt = vi.fn().mockResolvedValue(undefined);
    const disposeSession = vi.fn().mockResolvedValue(undefined);
    const fixture = await createFixture({
      agentChatService: createMockAgentChatService({
        sendMessage,
        interrupt,
        dispose: disposeSession
      })
    });
    try {
      const mission = fixture.missionService.create({
        prompt: "Cancel the run after worker startup.",
        laneId: fixture.laneId
      });
      const started = fixture.orchestratorService.startRun({
        missionId: mission.id,
        steps: [{ stepKey: "implement", title: "Implement", stepIndex: 0 }]
      });
      const runId = started.run.id;

      fixture.orchestratorService.tick({ runId });
      const graph = fixture.orchestratorService.getRunGraph({ runId, timelineLimit: 0 });
      const readyStep = graph.steps.find((step) => step.status === "ready");
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
          set executor_kind = 'unified',
              executor_session_id = ?
          where id = ?
        `,
        ["worker-session-cancel-1", attempt.id]
      );

      const canceled = await fixture.aiOrchestratorService.cancelRunGracefully({
        runId,
        reason: "Canceled from test."
      });
      expect(canceled.status).toBe("canceled");
      expect(sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "worker-session-cancel-1",
          text: expect.stringContaining("Run cancellation requested")
        })
      );
      expect(interrupt).toHaveBeenCalledWith({ sessionId: "worker-session-cancel-1" });
      expect(disposeSession).toHaveBeenCalledWith({ sessionId: "worker-session-cancel-1" });

      const refreshed = fixture.orchestratorService.getRunGraph({ runId, timelineLimit: 0 });
      const refreshedAttempt = refreshed.attempts.find((entry) => entry.id === attempt.id);
      expect(refreshedAttempt?.status).toBe("canceled");
    } finally {
      fixture.dispose();
    }
  });

  it("still force-cancels runs when graceful shutdown worker calls fail", async () => {
    const sendMessage = vi.fn().mockRejectedValue(new Error("send failed"));
    const interrupt = vi.fn().mockRejectedValue(new Error("interrupt failed"));
    const disposeSession = vi.fn().mockRejectedValue(new Error("dispose failed"));
    const fixture = await createFixture({
      agentChatService: createMockAgentChatService({
        sendMessage,
        interrupt,
        dispose: disposeSession
      })
    });
    try {
      const mission = fixture.missionService.create({
        prompt: "Cancel run even if worker shutdown errors.",
        laneId: fixture.laneId
      });
      const started = fixture.orchestratorService.startRun({
        missionId: mission.id,
        steps: [{ stepKey: "implement", title: "Implement", stepIndex: 0 }]
      });
      const runId = started.run.id;

      fixture.orchestratorService.tick({ runId });
      const graph = fixture.orchestratorService.getRunGraph({ runId, timelineLimit: 0 });
      const readyStep = graph.steps.find((step) => step.status === "ready");
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
          set executor_kind = 'unified',
              executor_session_id = ?
          where id = ?
        `,
        ["worker-session-cancel-2", attempt.id]
      );

      const canceled = await fixture.aiOrchestratorService.cancelRunGracefully({
        runId,
        reason: "Cancel with failures."
      });
      expect(canceled.status).toBe("canceled");
      expect(sendMessage).toHaveBeenCalled();
      expect(interrupt).toHaveBeenCalled();
      expect(disposeSession).toHaveBeenCalled();
    } finally {
      fixture.dispose();
    }
  });

  it("cleans up mission lanes through explicit team resource cleanup API", async () => {
    const archiveLane = vi.fn().mockImplementation(({ laneId }: { laneId: string }) => {
      if (laneId === "lane-cleanup-b") {
        throw new Error("Lane not found");
      }
    });
    const fixture = await createFixture({
      laneService: {
        archive: archiveLane
      } as any
    });
    try {
      const mission = fixture.missionService.create({
        prompt: "Archive lanes after mission cancellation.",
        laneId: fixture.laneId
      });
      const started = fixture.orchestratorService.startRun({
        missionId: mission.id,
        steps: [
          { stepKey: "lane-a", title: "Lane A", stepIndex: 0 },
          { stepKey: "lane-b", title: "Lane B", stepIndex: 1 }
        ]
      });
      const runId = started.run.id;
      const laneInsertTime = new Date().toISOString();

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
          "lane-cleanup-a",
          fixture.projectId,
          "Cleanup A",
          null,
          "worktree",
          "main",
          "feature/cleanup-a",
          fixture.projectRoot,
          null,
          0,
          null,
          null,
          null,
          null,
          "active",
          laneInsertTime,
          null
        ]
      );
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
          "lane-cleanup-b",
          fixture.projectId,
          "Cleanup B",
          null,
          "worktree",
          "main",
          "feature/cleanup-b",
          fixture.projectRoot,
          null,
          0,
          null,
          null,
          null,
          null,
          "active",
          laneInsertTime,
          null
        ]
      );

      const graph = fixture.orchestratorService.getRunGraph({ runId, timelineLimit: 0 });
      const stepA = graph.steps.find((step) => step.stepKey === "lane-a");
      const stepB = graph.steps.find((step) => step.stepKey === "lane-b");
      if (!stepA || !stepB) throw new Error("Expected lane steps");

      fixture.db.run(`update orchestrator_steps set lane_id = ? where id = ?`, ["lane-cleanup-a", stepA.id]);
      fixture.db.run(`update orchestrator_steps set lane_id = ? where id = ?`, ["lane-cleanup-b", stepB.id]);

      const result = await fixture.aiOrchestratorService.cleanupTeamResources({
        missionId: mission.id,
        runId,
        cleanupLanes: true
      });

      expect(result.runId).toBe(runId);
      expect(result.laneIds).toEqual(expect.arrayContaining(["lane-cleanup-a", "lane-cleanup-b"]));
      expect(result.lanesArchived).toEqual(expect.arrayContaining(["lane-cleanup-a"]));
      expect(result.lanesSkipped).toEqual(expect.arrayContaining(["lane-cleanup-b"]));
      expect(result.laneErrors).toHaveLength(0);
      expect(archiveLane).toHaveBeenCalledWith({ laneId: "lane-cleanup-a" });
      expect(archiveLane).toHaveBeenCalledWith({ laneId: "lane-cleanup-b" });
    } finally {
      fixture.dispose();
    }
  });

  it("dispatches TaskCompleted hooks on step completion runtime events", async () => {
    const hookCommandRunner = vi.fn().mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      durationMs: 7,
      stdout: "task done",
      stderr: "",
      spawnError: null
    });
    const fixture = await createFixture({
      orchestratorConfig: {
        hooks: {
          TaskCompleted: {
            command: "echo task-completed",
            timeoutMs: 2500
          }
        }
      },
      hookCommandRunner
    });
    try {
      const mission = fixture.missionService.create({
        prompt: "Dispatch completion hooks for finished steps.",
        laneId: fixture.laneId
      });

      const launch = await fixture.aiOrchestratorService.startMissionRun({
        missionId: mission.id,
        runMode: "manual",
        defaultExecutorKind: "manual"
      });
      if (!launch.started) throw new Error("Expected mission run to start");
      const runId = launch.started.run.id;

      // Add steps manually (simulating coordinator creating tasks)
      fixture.orchestratorService.addSteps({
        runId,
        steps: [{ stepKey: "implement-changes", title: "Implement requested changes", stepIndex: 0, dependencyStepKeys: [], executorKind: "manual", metadata: { instructions: "Do the work" } }]
      });
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
        status: "succeeded"
      });
      fixture.aiOrchestratorService.onOrchestratorRuntimeEvent({
        type: "orchestrator-step-updated",
        runId,
        stepId: readyStep.id,
        attemptId: attempt.id,
        at: new Date().toISOString(),
        reason: "attempt_completed"
      });

      await waitFor(() => hookCommandRunner.mock.calls.length === 1);
      const [hookCall] = hookCommandRunner.mock.calls[0] as [Record<string, string | number | Record<string, string>>];
      expect(hookCall.command).toBe("echo task-completed");
      expect(hookCall.timeoutMs).toBe(2500);
      expect((hookCall.env as Record<string, string>).ADE_HOOK_EVENT).toBe("TaskCompleted");
      expect((hookCall.env as Record<string, string>).ADE_HOOK_RUN_ID).toBe(runId);
      expect((hookCall.env as Record<string, string>).ADE_HOOK_STEP_ID).toBe(readyStep.id);

      await waitFor(() => {
        const events = fixture.orchestratorService
          .listRuntimeEvents({ runId, eventTypes: ["progress"], limit: 200 })
          .filter((event) => {
            const payload = event.payload as Record<string, unknown> | null;
            return payload?.source === "orchestrator_hook" && payload?.hookEvent === "TaskCompleted";
          });
        const phases = events.map((event) => (event.payload as Record<string, unknown> | null)?.phase);
        return phases.includes("started") && phases.includes("succeeded");
      });
    } finally {
      fixture.dispose();
    }
  });

  it("dispatches TeammateIdle hook only on transition into waiting input", async () => {
    const hookCommandRunner = vi.fn().mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      durationMs: 5,
      stdout: "idle",
      stderr: "",
      spawnError: null
    });
    const fixture = await createFixture({
      orchestratorConfig: {
        hooks: {
          TeammateIdle: {
            command: "echo teammate-idle",
            timeoutMs: 2200
          }
        }
      },
      hookCommandRunner
    });
    try {
      const mission = fixture.missionService.create({
        prompt: "Track worker waiting-input transitions.",
        laneId: fixture.laneId
      });

      const launch = await fixture.aiOrchestratorService.startMissionRun({
        missionId: mission.id,
        runMode: "manual",
        defaultExecutorKind: "manual"
      });
      if (!launch.started) throw new Error("Expected mission run to start");
      const runId = launch.started.run.id;

      // Add steps manually (simulating coordinator creating tasks)
      fixture.orchestratorService.addSteps({
        runId,
        steps: [{ stepKey: "implement-changes", title: "Implement requested changes", stepIndex: 0, dependencyStepKeys: [], executorKind: "manual", metadata: { instructions: "Do the work" } }]
      });
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
      const sessionId = "session-idle-hook-1";
      fixture.db.run(
        `update orchestrator_attempts set executor_kind = 'unified', executor_session_id = ? where id = ?`,
        [sessionId, attempt.id]
      );
      fixture.aiOrchestratorService.onOrchestratorRuntimeEvent({
        type: "orchestrator-attempt-updated",
        runId,
        stepId: readyStep.id,
        attemptId: attempt.id,
        at: new Date().toISOString(),
        reason: "started"
      });

      fixture.aiOrchestratorService.onSessionRuntimeSignal({
        laneId: fixture.laneId,
        sessionId,
        runtimeState: "waiting-input",
        lastOutputPreview: "Need approval to continue.",
        at: new Date().toISOString()
      });
      await waitFor(() => hookCommandRunner.mock.calls.length === 1);
      const [hookCall] = hookCommandRunner.mock.calls[0] as [Record<string, string | number | Record<string, string>>];
      expect(hookCall.command).toBe("echo teammate-idle");
      expect((hookCall.env as Record<string, string>).ADE_HOOK_EVENT).toBe("TeammateIdle");
      expect((hookCall.env as Record<string, string>).ADE_HOOK_ATTEMPT_ID).toBe(attempt.id);
      expect((hookCall.env as Record<string, string>).ADE_HOOK_SESSION_ID).toBe(sessionId);

      fixture.aiOrchestratorService.onSessionRuntimeSignal({
        laneId: fixture.laneId,
        sessionId,
        runtimeState: "waiting-input",
        lastOutputPreview: "Need approval to continue.",
        at: new Date(Date.now() + 1000).toISOString()
      });
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(hookCommandRunner).toHaveBeenCalledTimes(1);
    } finally {
      fixture.dispose();
    }
  });

  it("keeps runtime handling alive when hook execution fails", async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };
    const hookCommandRunner = vi.fn().mockRejectedValue(new Error("hook transport unavailable"));
    const fixture = await createFixture({
      orchestratorConfig: {
        hooks: {
          TaskCompleted: {
            command: "echo task-hook-fails"
          }
        }
      },
      hookCommandRunner,
      logger
    });
    try {
      const mission = fixture.missionService.create({
        prompt: "Do not crash if runtime hooks fail.",
        laneId: fixture.laneId
      });

      const launch = await fixture.aiOrchestratorService.startMissionRun({
        missionId: mission.id,
        runMode: "manual",
        defaultExecutorKind: "manual"
      });
      if (!launch.started) throw new Error("Expected mission run to start");
      const runId = launch.started.run.id;

      // Add steps manually (simulating coordinator creating tasks)
      fixture.orchestratorService.addSteps({
        runId,
        steps: [{ stepKey: "implement-changes", title: "Implement requested changes", stepIndex: 0, dependencyStepKeys: [], executorKind: "manual", metadata: { instructions: "Do the work" } }]
      });
      fixture.orchestratorService.tick({ runId });
      const graph = fixture.orchestratorService.getRunGraph({ runId });
      const readyStep = graph.steps.find((step) => step.status === "ready");
      if (!readyStep) throw new Error("Expected a ready step");

      expect(() => {
        fixture.aiOrchestratorService.onOrchestratorRuntimeEvent({
          type: "orchestrator-step-updated",
          runId,
          stepId: readyStep.id,
          at: new Date().toISOString(),
          reason: "attempt_completed"
        });
      }).not.toThrow();

      await waitFor(() =>
        logger.warn.mock.calls.some((entry) => entry[0] === "ai_orchestrator.hook_execution_failed")
      );
      expect(() => fixture.aiOrchestratorService.getWorkerStates({ runId })).not.toThrow();

      const hookEvents = fixture.orchestratorService
        .listRuntimeEvents({ runId, eventTypes: ["progress"], limit: 200 })
        .filter((event) => {
          const payload = event.payload as Record<string, unknown> | null;
          return payload?.source === "orchestrator_hook" && payload?.hookEvent === "TaskCompleted";
        });
      expect(hookEvents.some((event) => (event.payload as Record<string, unknown> | null)?.phase === "failed")).toBe(true);
    } finally {
      fixture.dispose();
    }
  });

  it("recovers stale non-manual attempts during health sweep", async () => {
    const fixture = await createFixture({
      aiIntegrationService: createStagnationRecoveryAiIntegrationService()
    });
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

      // Add steps manually (simulating coordinator creating tasks)
      fixture.orchestratorService.addSteps({
        runId,
        steps: [{ stepKey: "implement-changes", title: "Implement requested changes", stepIndex: 0, dependencyStepKeys: [], executorKind: "manual", metadata: { instructions: "Do the work" } }]
      });
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
          set executor_kind = 'unified',
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
      expect(refreshedAttempt?.errorMessage ?? "").toContain("stagnating");
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

      // Add steps manually (simulating coordinator creating tasks)
      fixture.orchestratorService.addSteps({
        runId,
        steps: [{ stepKey: "implement-changes", title: "Implement requested changes", stepIndex: 0, dependencyStepKeys: [], executorKind: "manual", metadata: { instructions: "Do the work" } }]
      });
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
          set executor_kind = 'unified',
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
    const fixture = await createFixture({
      aiIntegrationService: createStagnationRecoveryAiIntegrationService()
    });
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

      // Add steps manually (simulating coordinator creating tasks)
      fixture.orchestratorService.addSteps({
        runId,
        steps: [{ stepKey: "implement-changes", title: "Implement requested changes", stepIndex: 0, dependencyStepKeys: [], executorKind: "manual", metadata: { instructions: "Do the work" } }]
      });
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
          set executor_kind = 'unified',
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
      expect(refreshedAttempt?.errorMessage ?? "").toContain("stagnating");
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

      // Add steps manually with retryLimit > 0 so the first failure queues a retry
      fixture.orchestratorService.addSteps({
        runId,
        steps: [{ stepKey: "implement-changes", title: "Implement requested changes", stepIndex: 0, dependencyStepKeys: [], executorKind: "manual", retryLimit: 2, metadata: { instructions: "Do the work" } }]
      });
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

      // Add steps manually (simulating coordinator creating tasks)
      fixture.orchestratorService.addSteps({
        runId,
        steps: [{ stepKey: "implement-changes", title: "Implement requested changes", stepIndex: 0, dependencyStepKeys: [], executorKind: "manual", metadata: { instructions: "Do the work" } }]
      });
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
          set executor_kind = 'unified',
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

      // Add steps manually (simulating coordinator creating tasks)
      fixture.orchestratorService.addSteps({
        runId,
        steps: [{ stepKey: "implement-changes", title: "Implement requested changes", stepIndex: 0, dependencyStepKeys: [], executorKind: "manual", metadata: { instructions: "Do the work" } }]
      });
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
          set executor_kind = 'unified',
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
      const waitingIntervention = refreshedMission?.interventions.find(
        (entry) =>
          entry.status === "open"
          && entry.interventionType === "manual_input"
          && String(entry.metadata?.attemptId ?? "") === attempt.id
      );
      expect(
        refreshedMission?.interventions.some(
          (entry) =>
            entry.status === "open" &&
            entry.interventionType === "manual_input" &&
            String(entry.metadata?.attemptId ?? "") === attempt.id
        )
      ).toBe(true);
      expect(String(waitingIntervention?.metadata?.threadId ?? "")).toBe(`question:${attempt.id}`);
      expect(String(waitingIntervention?.metadata?.messageId ?? "")).toContain(`question:${attempt.id}:`);

      const questionEvent = fixture.orchestratorService
        .listRuntimeEvents({
          attemptId: attempt.id,
          eventTypes: ["question"],
          limit: 5
        })
        .find((entry) => entry.eventType === "question");
      expect(questionEvent?.questionLink?.threadId).toBe(`question:${attempt.id}`);
      expect(questionEvent?.questionLink?.messageId.startsWith(`question:${attempt.id}:`)).toBe(true);
      expect(questionEvent?.questionLink?.replyTo).toBeNull();

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

      // Add steps manually (simulating coordinator creating tasks)
      fixture.orchestratorService.addSteps({
        runId,
        steps: [{ stepKey: "implement-changes", title: "Implement requested changes", stepIndex: 0, dependencyStepKeys: [], executorKind: "manual", metadata: { instructions: "Do the work" } }]
      });
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
          set executor_kind = 'unified',
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

  it("replays open questions after restart from runtime event bus deterministically", async () => {
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

      // Add steps manually (simulating coordinator creating tasks)
      fixture.orchestratorService.addSteps({
        runId,
        steps: [{ stepKey: "implement-changes", title: "Implement requested changes", stepIndex: 0, dependencyStepKeys: [], executorKind: "manual", metadata: { instructions: "Do the work" } }]
      });
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
          set executor_kind = 'unified',
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
      fixture.db.run(`delete from orchestrator_attempt_runtime where attempt_id = ?`, [attempt.id]);

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

  it("resumeActiveTeamRuntimes pages through all active runs instead of stopping at 10", async () => {
    const fixture = await createFixture();
    try {
      const mission = fixture.missionService.create({
        prompt: "Recover all active team runtimes after restart.",
        laneId: fixture.laneId
      });

      const runIds: string[] = [];
      for (let index = 0; index < 12; index += 1) {
        const started = fixture.orchestratorService.startRun({
          missionId: mission.id,
          steps: [],
          metadata: { seed: index }
        });
        runIds.push(started.run.id);

        const ts = `2026-03-03T00:${String(index).padStart(2, "0")}:00.000Z`;
        fixture.db.run(
          `update orchestrator_runs set status = 'active', created_at = ?, updated_at = ? where id = ?`,
          [ts, ts, started.run.id]
        );
        fixture.db.run(
          `
            insert into orchestrator_run_state(
              run_id,
              phase,
              completion_requested,
              completion_validated,
              last_validation_error,
              coordinator_session_id,
              teammate_ids_json,
              created_at,
              updated_at
            ) values (?, 'executing', 0, 0, null, null, '[]', ?, ?)
            on conflict(run_id) do update set
              phase = excluded.phase,
              updated_at = excluded.updated_at
          `,
          [started.run.id, ts, ts]
        );
      }

      const resumeRunSpy = vi.spyOn(fixture.orchestratorService, "resumeRun");
      fixture.aiOrchestratorService.resumeActiveTeamRuntimes();
      await waitFor(() => resumeRunSpy.mock.calls.length >= runIds.length, 6_000);

      expect(resumeRunSpy.mock.calls.length).toBe(runIds.length);
    } finally {
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

      // Add steps manually (simulating coordinator creating tasks)
      fixture.orchestratorService.addSteps({
        runId,
        steps: [{ stepKey: "implement-changes", title: "Implement requested changes", stepIndex: 0, dependencyStepKeys: [], executorKind: "manual", metadata: { instructions: "Do the work" } }]
      });
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
          set executor_kind = 'unified',
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
      expect(firstCallArgs.prompt).toContain("... (truncated)");
      expect(firstCallArgs.prompt.includes("x".repeat(5_000))).toBe(false);
    } finally {
      fixture.dispose();
    }
  });

  it("planWithAI throws MissionPlanningError when aiIntegrationService is not available", async () => {
    const fixture = await createFixture({ aiIntegrationService: null });
    try {
      const mission = fixture.missionService.create({
        prompt: "Test planning without AI.",
        laneId: fixture.laneId
      });
      // No aiIntegrationService → should throw MissionPlanningError
      await expect(
        fixture.aiOrchestratorService.planWithAI({
          missionId: mission.id,
          provider: "claude"
        })
      ).rejects.toThrow("Mission planning failed");
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
          executorHint: "unified",
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
          executorHint: "unified",
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

  it("planWithAI uses a spawned planner agent session when lane + chat services are available", async () => {
    const plannerResponse = JSON.stringify({
      schemaVersion: "1.0",
      missionSummary: {
        title: "Planner agent mission",
        objective: "Ensure planner runs as a visible agent thread",
        domain: "backend",
        complexity: "low",
        strategy: "sequential",
        parallelismCap: 1
      },
      assumptions: [],
      risks: [],
      steps: [
        {
          stepId: "planner-agent-step-1",
          name: "Planner agent step",
          description: "Implement planner-agent integration.",
          taskType: "code",
          executorHint: "either",
          preferredScope: "lane",
          requiresContextProfiles: ["deterministic"],
          dependencies: [],
          artifactHints: [],
          claimPolicy: { lanes: ["backend"] },
          maxAttempts: 2,
          retryPolicy: { baseMs: 5000, maxMs: 120000, multiplier: 2, maxRetries: 1 },
          outputContract: { expectedSignals: ["code_written"], completionCriteria: "code_written" }
        }
      ],
      handoffPolicy: { externalConflictDefault: "intervention" }
    });

    const mockAi = createMockAiIntegrationService();
    const plannerSessionId = "planner-session-1";
    let aiOrchestratorRef: ReturnType<typeof createAiOrchestratorService> | null = null;

    const agentChatService = createMockAgentChatService({
      createSession: vi.fn().mockResolvedValue({
        id: plannerSessionId,
        laneId: "lane-1",
        provider: "claude",
        model: "opus",
        reasoningEffort: "high",
        status: "idle",
        createdAt: "2026-02-20T00:00:00.000Z",
        lastActivityAt: "2026-02-20T00:00:00.000Z"
      }),
      sendMessage: vi.fn().mockImplementation(async ({ sessionId }: { sessionId: string }) => {
        const orchestrator = aiOrchestratorRef;
        if (!orchestrator) return;
        orchestrator.onAgentChatEvent({
          sessionId,
          timestamp: "2026-02-20T00:00:01.000Z",
          event: { type: "status", turnStatus: "started", turnId: "planner-turn-1" }
        });
        orchestrator.onAgentChatEvent({
          sessionId,
          timestamp: "2026-02-20T00:00:02.000Z",
          event: { type: "text", text: plannerResponse, turnId: "planner-turn-1" }
        });
        orchestrator.onAgentChatEvent({
          sessionId,
          timestamp: "2026-02-20T00:00:03.000Z",
          event: { type: "done", turnId: "planner-turn-1", status: "completed" }
        });
      }),
      listSessions: vi.fn().mockResolvedValue([
        {
          sessionId: plannerSessionId,
          laneId: "lane-1",
          provider: "claude",
          model: "opus",
          reasoningEffort: "high",
          status: "idle",
          startedAt: "2026-02-20T00:00:00.000Z",
          endedAt: null,
          lastActivityAt: "2026-02-20T00:00:03.000Z",
          lastOutputPreview: plannerResponse.slice(0, 120),
          summary: "Planner output ready"
        }
      ])
    });

    const fixture = await createFixture({
      aiIntegrationService: mockAi,
      laneService: {} as any,
      agentChatService
    });
    aiOrchestratorRef = fixture.aiOrchestratorService;

    try {
      const mission = fixture.missionService.create({
        prompt: "Run planner through an agent session.",
        laneId: fixture.laneId
      });

      await fixture.aiOrchestratorService.planWithAI({
        missionId: mission.id,
        provider: "claude",
        model: "opus"
      });

      expect(agentChatService.createSession).toHaveBeenCalledTimes(1);
      expect(agentChatService.sendMessage).toHaveBeenCalledTimes(1);
      expect(mockAi.planMission).not.toHaveBeenCalled();

      const plannerThreadId = `planner:${mission.id}`;
      const threads = fixture.aiOrchestratorService.listChatThreads({ missionId: mission.id, includeClosed: true });
      const plannerThread = threads.find((thread) => thread.id === plannerThreadId);
      expect(plannerThread?.threadType).toBe("worker");
      expect(plannerThread?.sessionId).toBe(plannerSessionId);
      expect(plannerThread?.title).toBe("Planner Agent");

      const plannerMessages = fixture.aiOrchestratorService.getThreadMessages({
        missionId: mission.id,
        threadId: plannerThreadId,
        limit: 200
      });
      expect(plannerMessages.some((entry) => entry.content.includes("Planner online"))).toBe(true);
      expect(plannerMessages.some((entry) => entry.content.includes("\"schemaVersion\""))).toBe(true);

      const refreshed = fixture.missionService.get(mission.id);
      expect(refreshed?.steps.length).toBe(1);
      expect(refreshed?.steps[0]?.title).toBe("Planner agent step");
    } finally {
      aiOrchestratorRef = null;
      fixture.dispose();
    }
  });

  it("startMissionRun goes to in_progress regardless of planner config in AI-first flow", async () => {
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

      // In the AI-first flow, startMissionRun always succeeds and goes to in_progress.
      // The coordinator agent handles planning internally.
      const launch = await fixture.aiOrchestratorService.startMissionRun({
        missionId: mission.id,
        plannerProvider: "claude",
        runMode: "manual",
        defaultExecutorKind: "manual"
      });
      expect(launch.started).toBeTruthy();
      const refreshed = fixture.missionService.get(mission.id);
      expect(refreshed?.status).toBe("in_progress");
    } finally {
      fixture.dispose();
    }
  });

  it("planWithAI throws when AI returns generic plan labels", async () => {
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

      await expect(
        fixture.aiOrchestratorService.planWithAI({
          missionId: mission.id,
          provider: "claude"
        })
      ).rejects.toThrow("Mission planning failed");
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

  it("evaluateWorkerPlan flags for manual review when AI is unavailable", async () => {
    const fixture = await createFixture({ aiIntegrationService: null });
    try {
      const result = await fixture.aiOrchestratorService.evaluateWorkerPlan({
        attemptId: "a-1",
        workerPlan: { action: "edit files" },
        provider: "claude"
      });
      expect(result.approved).toBe(false);
      expect(result.feedback).toContain("unavailable");
    } finally {
      fixture.dispose();
    }
  });

  it("evaluateWorkerPlan flags for manual review when AI throws", async () => {
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
      expect(result.approved).toBe(false);
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
    const fixture = await createFixture({ aiIntegrationService: null });
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

  it("startMissionRun goes to in_progress even without AI integration in AI-first flow", async () => {
    const fixture = await createFixture({ aiIntegrationService: null });
    try {
      const mission = fixture.missionService.create({
        prompt: "AI-planned mission.",
        laneId: fixture.laneId
      });

      // In the AI-first flow, startMissionRun always starts the run and goes to in_progress.
      // The coordinator handles AI availability internally.
      const result = await fixture.aiOrchestratorService.startMissionRun({
        missionId: mission.id,
        runMode: "manual",
        defaultExecutorKind: "manual",
        plannerProvider: "claude"
      });

      expect(result.blockedByPlanReview).toBe(false);
      expect(result.started).toBeTruthy();
      const refreshed = fixture.missionService.get(mission.id);
      expect(refreshed?.status).toBe("in_progress");
    } finally {
      fixture.dispose();
    }
  });

  it("reuses persisted mission lane on plan-review re-entry instead of creating duplicates", async () => {
    let laneCounter = 0;
    const laneService = {
      list: vi.fn(async () => [
        { id: "lane-1", laneType: "primary" }
      ]),
      createChild: vi.fn(async () => {
        laneCounter += 1;
        return { id: `mission-lane-${laneCounter}`, name: `Mission Lane ${laneCounter}` };
      }),
    };
    const fixture = await createFixture({ laneService });
    try {
      const mission = fixture.missionService.create({
        prompt: "Run mission with restart-safe lane reuse.",
        laneId: fixture.laneId,
      });

      const firstStart = await fixture.aiOrchestratorService.startMissionRun({
        missionId: mission.id,
        runMode: "manual",
        defaultExecutorKind: "manual",
      });
      expect(firstStart.started).toBeTruthy();
      const firstRunId = firstStart.started!.run.id;

      const metadataRow = fixture.db.get<{ metadata_json: string | null }>(
        `select metadata_json from orchestrator_runs where id = ? limit 1`,
        [firstRunId]
      );
      const metadata = metadataRow?.metadata_json ? JSON.parse(metadataRow.metadata_json) : {};
      expect(metadata.missionLaneId).toBe("mission-lane-1");

      const reentryStart = await fixture.aiOrchestratorService.startMissionRun({
        missionId: mission.id,
        forcePlanReviewBypass: true,
        runMode: "manual",
        defaultExecutorKind: "manual",
      });

      expect(reentryStart.started?.run.id).toBe(firstRunId);
      expect(laneService.createChild).toHaveBeenCalledTimes(1);
    } finally {
      fixture.dispose();
    }
  });

  it("fallback lane strategy keeps independent roots off a single forced base lane", () => {
    const decision = deriveFallbackLaneStrategyDecision({
      baseLaneId: "lane-base",
      descriptors: [
        {
          id: "step-1",
          index: 0,
          title: "Root A",
          kind: "implementation",
          laneId: "lane-base",
          stepType: "implementation",
          stepKey: "root-a",
          dependencyStepKeys: [],
        },
        {
          id: "step-2",
          index: 1,
          title: "Root B",
          kind: "implementation",
          laneId: null,
          stepType: "implementation",
          stepKey: "root-b",
          dependencyStepKeys: [],
        },
        {
          id: "step-3",
          index: 2,
          title: "Integrate",
          kind: "integration",
          laneId: null,
          stepType: "integration",
          stepKey: "join",
          dependencyStepKeys: ["root-a", "root-b"],
        },
      ] as any,
    });

    const assignments = new Map(decision.stepAssignments.map((entry) => [entry.stepKey, entry.laneLabel]));
    expect(decision.strategy).toBe("dependency_parallel");
    expect(assignments.get("root-a")).toBe("base");
    expect(assignments.get("root-b")).toMatch(/^parallel-/);
    expect(assignments.get("join")).toBe("base");
  });

  it("auto-creates lanes for independent parallel steps and assigns downstream lanes", async () => {
    // laneService.createChild must insert the lane row into the DB so that
    // foreign key constraints on mission_steps.lane_id -> lanes.id are satisfied.
    let fixtureRef: Awaited<ReturnType<typeof createFixture>> | null = null;
    const laneService = {
      createChild: vi.fn().mockImplementation(async () => {
        const f = fixtureRef!;
        const childNow = new Date().toISOString();
        f.db.run(
          `insert into lanes(
            id, project_id, name, description, lane_type, base_ref, branch_ref,
            worktree_path, attached_root_path, is_edit_protected, parent_lane_id,
            color, icon, tags_json, status, created_at, archived_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            "lane-child-1", f.projectId, "m-auto-child-1", null, "worktree",
            "main", "feature/lane-child-1", f.projectRoot, null, 0, f.laneId,
            null, null, null, "active", childNow, null
          ]
        );
        return { id: "lane-child-1", name: "m-auto-child-1" };
      })
    };
    const fixture = await createFixture({ laneService });
    fixtureRef = fixture;
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

	      setMissionPlanningMode(fixture.db, mission.id, "off");
	      const started = await fixture.aiOrchestratorService.startMissionRun({
	        missionId: mission.id,
	        runMode: "autopilot",
	        defaultExecutorKind: "manual",
	      });
      // In the AI-first flow, the run starts with empty steps and the coordinator manages lanes
      expect(started.blockedByPlanReview).toBe(false);
      expect(started.started).toBeTruthy();

      const runs = fixture.orchestratorService.listRuns({ missionId: mission.id });
      expect(runs.length).toBeGreaterThan(0);
      // The run starts with empty steps — the coordinator will create tasks and lanes
      const graph = fixture.orchestratorService.getRunGraph({ runId: runs[0]!.id });
      expect(graph.steps).toHaveLength(0);

      const refreshedMission = fixture.missionService.get(mission.id);
      expect(refreshedMission?.status).toBe("in_progress");
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

	      setMissionPlanningMode(fixture.db, mission.id, "off");
	      const started = await fixture.aiOrchestratorService.startMissionRun({
	        missionId: mission.id,
	        runMode: "autopilot",
	        defaultExecutorKind: "manual",
	      });
      // In the AI-first flow, the run starts with empty steps and goes to in_progress
      expect(started.blockedByPlanReview).toBe(false);
      expect(started.started).toBeTruthy();

      const refreshedMission = fixture.missionService.get(mission.id);
      expect(refreshedMission?.status).toBe("in_progress");
    } finally {
      fixture.dispose();
    }
  });

  it("pauses mission start when AI lane assignments omit required steps", async () => {
    const executeTask = vi.fn().mockImplementation(async (request: { prompt?: string }) => {
      const prompt = String(request?.prompt ?? "");
      if (prompt.includes("Decision: lane strategy")) {
        const laneDecision = {
          strategy: "dependency_parallel",
          maxParallelLanes: 2,
          rationale: "Attempt parallel split.",
          confidence: 0.9,
          stepAssignments: [
            { stepKey: "step-a", laneLabel: "base", rationale: "Primary stream." }
          ]
        };
        return createAiTaskResult(laneDecision);
      }
      return createAiTaskResult(buildDefaultDecisionStructuredOutput(prompt));
    });
    const laneService = {
      createChild: vi.fn().mockResolvedValue({ id: "lane-unused", name: "lane-unused" })
    };
    const fixture = await createFixture({
      aiIntegrationService: createMockAiIntegrationService({ executeTask }),
      laneService
    });
    try {
	      const mission = fixture.missionService.create({
	        prompt: "Run in parallel and then integrate.",
	        laneId: fixture.laneId,
	        plannedSteps: [
          { index: 0, title: "Step A", detail: "A", kind: "implementation", metadata: { stepType: "implementation", stepKey: "step-a", dependencyStepKeys: [] } },
          { index: 1, title: "Step B", detail: "B", kind: "implementation", metadata: { stepType: "implementation", stepKey: "step-b", dependencyStepKeys: [] } },
          { index: 2, title: "Integrate", detail: "Join", kind: "integration", metadata: { stepType: "integration", stepKey: "step-c", dependencyStepKeys: ["step-a", "step-b"] } }
	        ]
	      });

	      setMissionPlanningMode(fixture.db, mission.id, "off");
	      const started = await fixture.aiOrchestratorService.startMissionRun({
	        missionId: mission.id,
	        runMode: "autopilot",
	        defaultExecutorKind: "manual",
      });
      // In the AI-first flow, the run starts with empty steps and in_progress.
      // The coordinator handles lane assignments internally.
      expect(started.started).toBeTruthy();
      expect(started.blockedByPlanReview).toBe(false);

      const refreshed = fixture.missionService.get(mission.id);
      expect(refreshed?.status).toBe("in_progress");
    } finally {
      fixture.dispose();
    }
  });

  it("gracefully degrades when AI parallelism decision fails by using default cap", async () => {
    const executeTask = vi.fn().mockImplementation(async (request: { prompt?: string }) => {
      const prompt = String(request?.prompt ?? "");
      if (prompt.toLowerCase().includes("decision: parallelism cap")) {
        return createAiTaskResult(null, "not-json");
      }
      return createAiTaskResult(buildDefaultDecisionStructuredOutput(prompt));
    });
    const fixture = await createFixture({
      aiIntegrationService: createMockAiIntegrationService({ executeTask })
    });
    try {
      const mission = fixture.missionService.create({
        prompt: "Run a simple mission with deterministic guardrails only.",
        laneId: fixture.laneId,
        plannedSteps: [
          {
            index: 0,
            title: "Single step",
            detail: "Implement a scoped change",
            kind: "implementation",
            metadata: { stepType: "implementation" }
          }
        ]
      });
      setMissionPlanningMode(fixture.db, mission.id, "off");

      const started = await fixture.aiOrchestratorService.startMissionRun({
        missionId: mission.id,
        runMode: "manual",
        defaultExecutorKind: "manual"
      });

      expect(started.started).toBeTruthy();
      expect(started.blockedByPlanReview).toBe(false);

      // Parallelism decision failure is now a soft failure — the run proceeds
      // with a default parallelism cap instead of pausing for intervention.
      const refreshedMission = fixture.missionService.get(mission.id);
      expect(refreshedMission?.status).toBe("in_progress");
    } finally {
      fixture.dispose();
    }
  });

  it("handles completed shadow events without invoking legacy deterministic plan adjustment", async () => {
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

      // Add steps manually (simulating coordinator creating tasks)
      fixture.orchestratorService.addSteps({
        runId,
        steps: [{ stepKey: "implement-changes", title: "Implement requested changes", stepIndex: 0, dependencyStepKeys: [], executorKind: "manual", metadata: { instructions: "Do the work" } }]
      });
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

      // Completed shadow event should be tolerated and should not throw.
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

      // Get mission steps created by the deterministic planner and map them to orchestrator steps
      const missionDetail = fixture.missionService.get(mission.id);
      const missionSteps = missionDetail?.steps ?? [];

      // Add orchestrator steps manually, mapping each to a mission step via missionStepId
      fixture.orchestratorService.addSteps({
        runId,
        steps: missionSteps.map((ms, idx) => ({
          stepKey: `step-${idx}`,
          title: ms.title,
          stepIndex: idx,
          dependencyStepKeys: [],
          executorKind: "manual" as const,
          missionStepId: ms.id,
          metadata: { instructions: "Do the work" }
        }))
      });

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

      fixture.aiOrchestratorService.finalizeRun({ runId, force: true });
      await fixture.aiOrchestratorService.syncMissionFromRun(runId, "test_final_sync");
      const refreshed = fixture.missionService.get(mission.id);
      expect(refreshed?.status).toBe("completed");
      expect(refreshed?.steps.every((step) => step.status === "succeeded")).toBe(true);
      expect((refreshed?.outcomeSummary ?? "").length).toBeGreaterThan(0);
    } finally {
      fixture.dispose();
    }
  });

  it("applies steering directives onto active run steps for worker prompt guidance", async () => {
    const fixture = await createFixture();
    try {
      const mission = fixture.missionService.create({
        prompt: "Apply targeted steering to active orchestrator steps.",
        laneId: fixture.laneId
      });
      const started = fixture.orchestratorService.startRun({
        missionId: mission.id,
        steps: [
          { stepKey: "alpha", title: "Alpha", stepIndex: 0 },
          { stepKey: "beta", title: "Beta", stepIndex: 1, dependencyStepKeys: ["alpha"] }
        ]
      });

      const result = fixture.aiOrchestratorService.steerMission({
        missionId: mission.id,
        directive: "Prioritize integration tests before non-critical refactors.",
        priority: "instruction",
        targetStepKey: "beta"
      });
      expect(result.acknowledged).toBe(true);

      const graph = fixture.orchestratorService.getRunGraph({ runId: started.run.id, timelineLimit: 0 });
      const alpha = graph.steps.find((entry) => entry.stepKey === "alpha");
      const beta = graph.steps.find((entry) => entry.stepKey === "beta");
      const betaDirectives = Array.isArray(beta?.metadata?.steeringDirectives)
        ? beta?.metadata?.steeringDirectives as Array<Record<string, unknown>>
        : [];
      const alphaDirectives = Array.isArray(alpha?.metadata?.steeringDirectives)
        ? alpha?.metadata?.steeringDirectives as Array<Record<string, unknown>>
        : [];
      expect(
        betaDirectives.some(
          (entry) =>
            String(entry.directive ?? "").includes("Prioritize integration tests")
              && String(entry.priority ?? "") === "instruction"
              && String(entry.targetStepKey ?? "") === "beta"
        )
      ).toBe(true);
      expect(alphaDirectives).toHaveLength(0);
    } finally {
      fixture.dispose();
    }
  });

  it("records deterministic question reply linkage and resume transition after steering input", async () => {
    const fixture = await createFixture();
    try {
      const mission = fixture.missionService.create({
        prompt: "Require operator reply when worker asks a question, then resume deterministically.",
        laneId: fixture.laneId
      });
      const started = fixture.orchestratorService.startRun({
        missionId: mission.id,
        metadata: {
          autopilot: {
            enabled: true,
            executorKind: "unified",
            ownerId: "test-owner",
            parallelismCap: 2
          }
        },
        steps: [{ stepKey: "question-step", title: "Question Step", stepIndex: 0 }]
      });

      fixture.orchestratorService.tick({ runId: started.run.id });
      const graph = fixture.orchestratorService.getRunGraph({ runId: started.run.id, timelineLimit: 0 });
      const readyStep = graph.steps.find((step) => step.status === "ready");
      if (!readyStep) throw new Error("Expected ready step");

      const attempt = await fixture.orchestratorService.startAttempt({
        runId: started.run.id,
        stepId: readyStep.id,
        ownerId: "test-owner",
        executorKind: "manual"
      });
      const sessionId = "session-question-thread-1";
      fixture.db.run(
        `
          update orchestrator_attempts
          set executor_kind = 'unified',
              executor_session_id = ?
          where id = ?
        `,
        [sessionId, attempt.id]
      );

      fixture.aiOrchestratorService.onSessionRuntimeSignal({
        laneId: fixture.laneId,
        sessionId,
        runtimeState: "waiting-input",
        lastOutputPreview: "Need operator input before continuing.",
        at: new Date().toISOString()
      });

      await waitFor(() => {
        const refreshed = fixture.missionService.get(mission.id);
        return Boolean(
          refreshed?.interventions.some(
            (entry) =>
              entry.status === "open"
              && entry.interventionType === "manual_input"
              && String(entry.metadata?.attemptId ?? "") === attempt.id
          )
        );
      });

      const questionEvent = fixture.orchestratorService
        .listRuntimeEvents({ attemptId: attempt.id, eventTypes: ["question"], limit: 5 })
        .find((entry) => entry.eventType === "question");
      expect(questionEvent?.questionLink).toBeTruthy();

      fixture.aiOrchestratorService.steerMission({
        missionId: mission.id,
        directive: "Proceed with option A and keep changes scoped to auth files.",
        priority: "instruction"
      });

      await waitFor(() => {
        const refreshed = fixture.missionService.get(mission.id);
        return Boolean(
          refreshed?.interventions.some(
            (entry) =>
              entry.interventionType === "manual_input"
              && String(entry.metadata?.attemptId ?? "") === attempt.id
              && entry.status === "resolved"
          )
        );
      });

      const runtimeEvents = fixture.orchestratorService.listRuntimeEvents({
        attemptId: attempt.id,
        eventTypes: ["intervention_resolved", "progress"],
        limit: 20
      });
      const resolvedEvent = runtimeEvents.find((entry) => entry.eventType === "intervention_resolved");
      const resumeEvent = runtimeEvents.find(
        (entry) => entry.eventType === "progress" && String((entry.payload as Record<string, unknown> | null)?.transition ?? "") === "question_answered_resume"
      );
      expect(resolvedEvent?.questionLink?.threadId).toBe(questionEvent?.questionLink?.threadId);
      expect(resolvedEvent?.questionLink?.replyTo).toBe(questionEvent?.questionLink?.messageId);
      expect(resumeEvent?.questionLink?.replyTo).toBe(questionEvent?.questionLink?.messageId);

      const states = fixture.aiOrchestratorService.getWorkerStates({ runId: started.run.id });
      const worker = states.find((entry) => entry.attemptId === attempt.id);
      expect(worker?.state).toBe("working");
    } finally {
      fixture.dispose();
    }
  });

  it("persists chat and steering directives and hydrates them after service recreation", async () => {
    const fixture = await createFixture({ aiIntegrationService: null });
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
      // The fallback one-shot chat response path no longer passes sessionId
      expect(executeTask.mock.calls[0]?.[0]?.sessionId).toBeUndefined();
      expect(executeTask.mock.calls[1]?.[0]?.sessionId).toBeUndefined();
    } finally {
      fixture.dispose();
    }
  });

  it("delivers worker thread guidance through agent chat when the worker session is available", async () => {
    const agentChatService = createMockAgentChatService({
      listSessions: vi.fn().mockResolvedValue([{ sessionId: "worker-session-1", status: "idle" }])
    });
    const fixture = await createFixture({ agentChatService });
    try {
      const mission = fixture.missionService.create({
        prompt: "Deliver operator guidance directly to active worker sessions.",
        laneId: fixture.laneId
      });

      const sent = fixture.aiOrchestratorService.sendThreadMessage({
        missionId: mission.id,
        content: "Prioritize the flaky test fix before refactors.",
        target: {
          kind: "worker",
          sessionId: "worker-session-1",
          stepKey: "step-fix-tests"
        }
      });

      await waitFor(() => {
        const updated = fixture.aiOrchestratorService
          .getThreadMessages({ missionId: mission.id, threadId: sent.threadId ?? "" })
          .find((entry) => entry.id === sent.id);
        return updated?.deliveryState === "delivered";
      });

      expect(agentChatService.sendMessage).toHaveBeenCalledTimes(1);
      expect(agentChatService.sendMessage).toHaveBeenCalledWith({
        sessionId: "worker-session-1",
        text: "Prioritize the flaky test fix before refactors."
      });
      expect(agentChatService.steer).not.toHaveBeenCalled();
    } finally {
      fixture.dispose();
    }
  });

  it("bridges worker delivery to the single active lane chat session when mapped executor session is non-chat", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const agentChatService = createMockAgentChatService({
      sendMessage,
      listSessions: vi.fn().mockResolvedValue([
        {
          sessionId: "worker-chat-bridge-1",
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.3-codex",
          status: "idle",
          startedAt: new Date().toISOString(),
          endedAt: null,
          lastActivityAt: new Date().toISOString(),
          lastOutputPreview: null,
          summary: null
        }
      ])
    });
    const fixture = await createFixture({ agentChatService });
    try {
      const mission = fixture.missionService.create({
        prompt: "Bridge delivery from orchestrated session ids to active worker chat sessions.",
        laneId: fixture.laneId
      });

      const sent = fixture.aiOrchestratorService.sendThreadMessage({
        missionId: mission.id,
        content: "Use the active lane chat worker when direct session mapping is unavailable.",
        target: {
          kind: "worker",
          sessionId: "legacy-orchestrated-session-42",
          laneId: fixture.laneId,
          stepKey: "step-bridge"
        }
      });

      await waitFor(() => {
        const updated = fixture.aiOrchestratorService
          .getThreadMessages({ missionId: mission.id, threadId: sent.threadId ?? "" })
          .find((entry) => entry.id === sent.id);
        return updated?.deliveryState === "delivered";
      });

      const updated = fixture.aiOrchestratorService
        .getThreadMessages({ missionId: mission.id, threadId: sent.threadId ?? "" })
        .find((entry) => entry.id === sent.id);
      expect(sendMessage).toHaveBeenCalledWith({
        sessionId: "worker-chat-bridge-1",
        text: "Use the active lane chat worker when direct session mapping is unavailable."
      });
      expect(updated?.metadata).toMatchObject({
        workerDelivery: {
          agentSessionId: "worker-chat-bridge-1"
        }
      });
    } finally {
      fixture.dispose();
    }
  });

  it("keeps worker delivery queued when lane fallback is ambiguous across multiple active chat sessions", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const agentChatService = createMockAgentChatService({
      sendMessage,
      listSessions: vi.fn().mockResolvedValue([
        {
          sessionId: "worker-chat-a",
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.3-codex",
          status: "idle",
          startedAt: new Date().toISOString(),
          endedAt: null,
          lastActivityAt: new Date().toISOString(),
          lastOutputPreview: null,
          summary: null
        },
        {
          sessionId: "worker-chat-b",
          laneId: "lane-1",
          provider: "codex",
          model: "gpt-5.3-codex",
          status: "active",
          startedAt: new Date().toISOString(),
          endedAt: null,
          lastActivityAt: new Date().toISOString(),
          lastOutputPreview: null,
          summary: null
        }
      ])
    });
    const fixture = await createFixture({ agentChatService });
    try {
      const mission = fixture.missionService.create({
        prompt: "Keep queued when multiple possible worker chat sessions exist.",
        laneId: fixture.laneId
      });

      const sent = fixture.aiOrchestratorService.sendThreadMessage({
        missionId: mission.id,
        content: "Do not misdeliver this directive.",
        target: {
          kind: "worker",
          sessionId: "legacy-orchestrated-session-99",
          laneId: fixture.laneId,
          stepKey: "step-ambiguous"
        }
      });

      await waitFor(() => {
        const updated = fixture.aiOrchestratorService
          .getThreadMessages({ missionId: mission.id, threadId: sent.threadId ?? "" })
          .find((entry) => entry.id === sent.id);
        if (!updated) return false;
        if (updated.deliveryState !== "queued") return false;
        const workerDelivery = ((updated.metadata ?? {}) as { workerDelivery?: { lastError?: string } }).workerDelivery;
        return typeof workerDelivery?.lastError === "string" && workerDelivery.lastError.includes("Multiple active worker chat sessions");
      });

      expect(sendMessage).not.toHaveBeenCalled();
    } finally {
      fixture.dispose();
    }
  });

  it("falls back to steer when worker delivery hits an active-turn conflict", async () => {
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error("A turn is already active. Use steer or interrupt."));
    const steer = vi.fn().mockResolvedValue(undefined);
    const agentChatService = createMockAgentChatService({
      sendMessage,
      steer,
      listSessions: vi.fn().mockResolvedValue([{ sessionId: "worker-session-busy", status: "idle" }])
    });
    const fixture = await createFixture({ agentChatService });
    try {
      const mission = fixture.missionService.create({
        prompt: "Use steer fallback when direct worker delivery is busy.",
        laneId: fixture.laneId
      });

      const sent = fixture.aiOrchestratorService.sendThreadMessage({
        missionId: mission.id,
        content: "Keep current diff, but pause on unrelated cleanup.",
        target: {
          kind: "worker",
          sessionId: "worker-session-busy",
          stepKey: "step-busy"
        }
      });

      await waitFor(() => {
        const updated = fixture.aiOrchestratorService
          .getThreadMessages({ missionId: mission.id, threadId: sent.threadId ?? "" })
          .find((entry) => entry.id === sent.id);
        return updated?.deliveryState === "delivered";
      });

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(steer).toHaveBeenCalledTimes(1);
      expect(steer).toHaveBeenCalledWith({
        sessionId: "worker-session-busy",
        text: "Keep current diff, but pause on unrelated cleanup."
      });
    } finally {
      fixture.dispose();
    }
  });

  it("replays queued worker guidance during startup reconciliation", async () => {
    const fixture = await createFixture();
    let restartedService: ReturnType<typeof createAiOrchestratorService> | null = null;
    try {
      const mission = fixture.missionService.create({
        prompt: "Replay queued worker guidance after orchestrator restart.",
        laneId: fixture.laneId
      });

      const queued = fixture.aiOrchestratorService.sendThreadMessage({
        missionId: mission.id,
        content: "Queue this guidance until worker runtime is ready.",
        target: {
          kind: "worker",
          sessionId: "worker-session-replay",
          stepKey: "step-replay"
        }
      });

      await waitFor(() => {
        const current = fixture.aiOrchestratorService
          .getThreadMessages({ missionId: mission.id, threadId: queued.threadId ?? "" })
          .find((entry) => entry.id === queued.id);
        return current?.deliveryState === "queued";
      });

      fixture.aiOrchestratorService.dispose();
      const replayAgent = createMockAgentChatService({
        listSessions: vi.fn().mockResolvedValue([{ sessionId: "worker-session-replay", status: "idle" }])
      });
      restartedService = createAiOrchestratorService({
        db: fixture.db,
        logger: createLogger(),
        missionService: fixture.missionService,
        orchestratorService: fixture.orchestratorService,
        agentChatService: replayAgent,
        projectRoot: fixture.projectRoot
      });

      await waitFor(() => {
        const current = restartedService
          ?.getThreadMessages({ missionId: mission.id, threadId: queued.threadId ?? "" })
          .find((entry) => entry.id === queued.id);
        return current?.deliveryState === "delivered";
      });

      expect(replayAgent.sendMessage).toHaveBeenCalledWith({
        sessionId: "worker-session-replay",
        text: "Queue this guidance until worker runtime is ready."
      });
    } finally {
      restartedService?.dispose();
      fixture.dispose();
    }
  });

  it("ignores legacy metadata chat entries without message IDs during startup reconciliation", async () => {
    const fixture = await createFixture();
    let restartedService: ReturnType<typeof createAiOrchestratorService> | null = null;
    try {
      const mission = fixture.missionService.create({
        prompt: "Legacy metadata entries without IDs should not be imported.",
        laneId: fixture.laneId
      });
      const legacyContent = "legacy-backfill-without-id";
      const missionThreadId = `mission:${mission.id}`;
      fixture.db.run(
        `
          update missions
          set metadata_json = ?
          where id = ?
        `,
        [
          JSON.stringify({
            orchestratorChat: [
              {
                role: "user",
                content: legacyContent,
                timestamp: "2026-02-20T00:00:00.000Z",
                target: {
                  kind: "coordinator",
                  runId: null
                }
              }
            ]
          }),
          mission.id
        ]
      );

      fixture.aiOrchestratorService.dispose();
      const restart = () =>
        createAiOrchestratorService({
          db: fixture.db,
          logger: createLogger(),
          missionService: fixture.missionService,
          orchestratorService: fixture.orchestratorService,
          projectRoot: fixture.projectRoot
        });

      restartedService = restart();
      await waitFor(() => {
        const thread = fixture.db.get<{ id: string }>(
          `
            select id
            from orchestrator_chat_threads
            where mission_id = ?
              and id = ?
          `,
          [mission.id, missionThreadId]
        );
        return Boolean(thread?.id);
      });
      const firstCount = fixture.db.get<{ count: number }>(
        `
          select count(1) as count
          from orchestrator_chat_messages
          where mission_id = ?
            and content = ?
        `,
        [mission.id, legacyContent]
      );
      expect(firstCount?.count).toBe(0);
      restartedService.dispose();

      restartedService = restart();
      await waitFor(() => {
        const thread = fixture.db.get<{ id: string }>(
          `
            select id
            from orchestrator_chat_threads
            where mission_id = ?
              and id = ?
          `,
          [mission.id, missionThreadId]
        );
        return Boolean(thread?.id);
      });

      const finalCount = fixture.db.get<{ count: number }>(
        `
          select count(1) as count
          from orchestrator_chat_messages
          where mission_id = ?
            and content = ?
        `,
        [mission.id, legacyContent]
      );
      expect(finalCount?.count).toBe(0);
    } finally {
      restartedService?.dispose();
      fixture.dispose();
    }
  });

  it("preserves per-thread ordering while replaying queued worker guidance on runtime signals", async () => {
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error("Temporary transport failure."))
      .mockResolvedValue(undefined);
    const agentChatService = createMockAgentChatService({
      sendMessage,
      listSessions: vi.fn().mockResolvedValue([{ sessionId: "worker-session-order", status: "idle" }])
    });
    const fixture = await createFixture({ agentChatService });
    try {
      const mission = fixture.missionService.create({
        prompt: "Replay queued worker guidance deterministically in-order.",
        laneId: fixture.laneId
      });

      const first = fixture.aiOrchestratorService.sendThreadMessage({
        missionId: mission.id,
        content: "first guidance",
        target: {
          kind: "worker",
          sessionId: "worker-session-order",
          stepKey: "step-order"
        }
      });
      const second = fixture.aiOrchestratorService.sendThreadMessage({
        missionId: mission.id,
        threadId: first.threadId,
        content: "second guidance",
        target: {
          kind: "worker",
          sessionId: "worker-session-order",
          stepKey: "step-order"
        }
      });

      await waitFor(() => {
        const entries = fixture.aiOrchestratorService.getThreadMessages({
          missionId: mission.id,
          threadId: first.threadId ?? ""
        });
        const firstState = entries.find((entry) => entry.id === first.id)?.deliveryState;
        const secondState = entries.find((entry) => entry.id === second.id)?.deliveryState;
        return firstState === "queued" && secondState === "queued";
      });

      await waitFor(() => sendMessage.mock.calls.length >= 1);
      expect(sendMessage).toHaveBeenCalledTimes(1);

      clearWorkerDeliveryBackoff(fixture.db, first.id);
      fixture.aiOrchestratorService.onSessionRuntimeSignal({
        laneId: fixture.laneId,
        sessionId: "worker-session-order",
        runtimeState: "running",
        lastOutputPreview: "worker online",
        at: new Date().toISOString()
      });

      await waitFor(() => {
        const entries = fixture.aiOrchestratorService.getThreadMessages({
          missionId: mission.id,
          threadId: first.threadId ?? ""
        });
        const firstState = entries.find((entry) => entry.id === first.id)?.deliveryState;
        const secondState = entries.find((entry) => entry.id === second.id)?.deliveryState;
        return firstState === "delivered" && secondState === "delivered";
      });

      const texts = sendMessage.mock.calls.map((call) => call[0]?.text);
      expect(texts).toEqual(["first guidance", "first guidance", "second guidance"]);
    } finally {
      fixture.dispose();
    }
  });

  it("marks worker guidance as failed after retry budget and opens a recovery intervention", async () => {
    const sendMessage = vi.fn().mockRejectedValue(new Error("Worker runtime unavailable."));
    const agentChatService = createMockAgentChatService({
      sendMessage,
      listSessions: vi.fn().mockResolvedValue([{ sessionId: "worker-session-fail", status: "idle" }])
    });
    const fixture = await createFixture({ agentChatService });
    try {
      const mission = fixture.missionService.create({
        prompt: "Fail queued guidance after bounded retries.",
        laneId: fixture.laneId
      });

      const sent = fixture.aiOrchestratorService.sendThreadMessage({
        missionId: mission.id,
        content: "This guidance should eventually fail delivery.",
        target: {
          kind: "worker",
          sessionId: "worker-session-fail",
          stepKey: "step-fail"
        }
      });

      await waitFor(() => {
        const current = fixture.aiOrchestratorService
          .getThreadMessages({ missionId: mission.id, threadId: sent.threadId ?? "" })
          .find((entry) => entry.id === sent.id);
        return current?.deliveryState === "queued";
      });

      for (let i = 0; i < 6; i += 1) {
        clearWorkerDeliveryBackoff(fixture.db, sent.id);
        fixture.aiOrchestratorService.onSessionRuntimeSignal({
          laneId: fixture.laneId,
          sessionId: "worker-session-fail",
          runtimeState: "running",
          lastOutputPreview: `replay-${i}`,
          at: new Date().toISOString()
        });
        const done = fixture.aiOrchestratorService
          .getThreadMessages({ missionId: mission.id, threadId: sent.threadId ?? "" })
          .find((entry) => entry.id === sent.id)?.deliveryState;
        if (done === "failed") break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }

      await waitFor(() => {
        const current = fixture.aiOrchestratorService
          .getThreadMessages({ missionId: mission.id, threadId: sent.threadId ?? "" })
          .find((entry) => entry.id === sent.id);
        return current?.deliveryState === "failed";
      });

      const refreshedMission = fixture.missionService.get(mission.id);
      expect(
        refreshedMission?.interventions.some(
          (entry) =>
            entry.status === "open"
            && entry.interventionType === "manual_input"
            && String(entry.metadata?.sourceMessageId ?? "") === sent.id
        )
      ).toBe(true);
      expect(sendMessage.mock.calls.length).toBeGreaterThanOrEqual(4);
    } finally {
      fixture.dispose();
    }
  });

  it("replays queued worker guidance when agent chat reports turn completion", async () => {
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error("Temporary transport failure."))
      .mockResolvedValue(undefined);
    const agentChatService = createMockAgentChatService({
      sendMessage,
      listSessions: vi.fn().mockResolvedValue([{ sessionId: "worker-session-agent-event", status: "idle" }])
    });
    const fixture = await createFixture({ agentChatService });
    try {
      const mission = fixture.missionService.create({
        prompt: "Replay queued messages on agent-chat turn completion events.",
        laneId: fixture.laneId
      });

      const sent = fixture.aiOrchestratorService.sendThreadMessage({
        missionId: mission.id,
        content: "Replay me on agent-chat completion.",
        target: {
          kind: "worker",
          sessionId: "worker-session-agent-event",
          stepKey: "step-agent-event"
        }
      });

      await waitFor(() => {
        const current = fixture.aiOrchestratorService
          .getThreadMessages({ missionId: mission.id, threadId: sent.threadId ?? "" })
          .find((entry) => entry.id === sent.id);
        return current?.deliveryState === "queued";
      });

      clearWorkerDeliveryBackoff(fixture.db, sent.id);
      fixture.aiOrchestratorService.onAgentChatEvent({
        sessionId: "worker-session-agent-event",
        timestamp: new Date().toISOString(),
        event: {
          type: "status",
          turnStatus: "completed"
        }
      });

      await waitFor(() => {
        const current = fixture.aiOrchestratorService
          .getThreadMessages({ missionId: mission.id, threadId: sent.threadId ?? "" })
          .find((entry) => entry.id === sent.id);
        return current?.deliveryState === "delivered";
      });

      expect(sendMessage).toHaveBeenCalledTimes(2);
    } finally {
      fixture.dispose();
    }
  });

  it("preserves delivery idempotence by holding in-flight messages then failing stale in-flight attempts", async () => {
    const sendMessage = vi.fn().mockRejectedValue(new Error("Transport unavailable."));
    const agentChatService = createMockAgentChatService({
      sendMessage,
      listSessions: vi.fn().mockResolvedValue([{ sessionId: "worker-session-inflight", status: "idle" }])
    });
    const fixture = await createFixture({ agentChatService });
    try {
      const mission = fixture.missionService.create({
        prompt: "Guard against duplicate injection while delivery is in-flight.",
        laneId: fixture.laneId
      });

      const sent = fixture.aiOrchestratorService.sendThreadMessage({
        missionId: mission.id,
        content: "In-flight guard test guidance.",
        target: {
          kind: "worker",
          sessionId: "worker-session-inflight",
          stepKey: "step-inflight"
        }
      });

      await waitFor(() => {
        const current = fixture.aiOrchestratorService
          .getThreadMessages({ missionId: mission.id, threadId: sent.threadId ?? "" })
          .find((entry) => entry.id === sent.id);
        return current?.deliveryState === "queued";
      });

      const initialCalls = sendMessage.mock.calls.length;
      patchWorkerDeliveryMetadata(fixture.db, sent.id, {
        inFlightAttemptId: `${sent.id}:attempt:1`,
        inFlightAt: new Date().toISOString(),
        inFlightSessionId: "worker-session-inflight",
        nextRetryAt: null
      });

      fixture.aiOrchestratorService.onSessionRuntimeSignal({
        laneId: fixture.laneId,
        sessionId: "worker-session-inflight",
        runtimeState: "running",
        lastOutputPreview: "still running",
        at: new Date().toISOString()
      });

      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(sendMessage.mock.calls.length).toBe(initialCalls);

      patchWorkerDeliveryMetadata(fixture.db, sent.id, {
        inFlightAttemptId: `${sent.id}:attempt:1`,
        inFlightAt: "2000-01-01T00:00:00.000Z",
        inFlightSessionId: "worker-session-inflight",
        nextRetryAt: null
      });

      fixture.aiOrchestratorService.onSessionRuntimeSignal({
        laneId: fixture.laneId,
        sessionId: "worker-session-inflight",
        runtimeState: "running",
        lastOutputPreview: "resume",
        at: new Date().toISOString()
      });

      await waitFor(() => {
        const current = fixture.aiOrchestratorService
          .getThreadMessages({ missionId: mission.id, threadId: sent.threadId ?? "" })
          .find((entry) => entry.id === sent.id);
        return current?.deliveryState === "failed";
      });

      const refreshedMission = fixture.missionService.get(mission.id);
      expect(
        refreshedMission?.interventions.some(
          (entry) =>
            entry.status === "open"
            && entry.interventionType === "manual_input"
            && String(entry.metadata?.sourceMessageId ?? "") === sent.id
        )
      ).toBe(true);
    } finally {
      fixture.dispose();
    }
  });

  it("supports broadcast worker targeting and fans out guidance to matching worker threads", async () => {
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const agentChatService = createMockAgentChatService({
      sendMessage,
      listSessions: vi.fn().mockImplementation(async () => [
        { sessionId: "worker-session-a", status: "idle" },
        { sessionId: "worker-session-b", status: "idle" }
      ])
    });
    const fixture = await createFixture({ agentChatService });
    try {
      const mission = fixture.missionService.create({
        prompt: "Broadcast one directive to all workers.",
        laneId: fixture.laneId
      });

      const workerA = fixture.aiOrchestratorService.sendThreadMessage({
        missionId: mission.id,
        content: "bootstrap worker A",
        target: {
          kind: "worker",
          sessionId: "worker-session-a",
          stepKey: "step-a"
        }
      });
      const workerB = fixture.aiOrchestratorService.sendThreadMessage({
        missionId: mission.id,
        content: "bootstrap worker B",
        target: {
          kind: "worker",
          sessionId: "worker-session-b",
          stepKey: "step-b"
        }
      });

      await waitFor(() => {
        const messagesA = fixture.aiOrchestratorService.getThreadMessages({ missionId: mission.id, threadId: workerA.threadId ?? "" });
        const messagesB = fixture.aiOrchestratorService.getThreadMessages({ missionId: mission.id, threadId: workerB.threadId ?? "" });
        return messagesA.some((entry) => entry.id === workerA.id && entry.deliveryState === "delivered")
          && messagesB.some((entry) => entry.id === workerB.id && entry.deliveryState === "delivered");
      });

      sendMessage.mockClear();

      const broadcast = fixture.aiOrchestratorService.sendThreadMessage({
        missionId: mission.id,
        content: "Apply logging guardrails before continuing implementation.",
        target: {
          kind: "workers"
        }
      });

      expect(broadcast.target?.kind).toBe("workers");

      await waitFor(() => sendMessage.mock.calls.length >= 2);
      const callTexts = sendMessage.mock.calls.map((call) => String(call[0]?.text ?? ""));
      expect(callTexts).toEqual([
        "Apply logging guardrails before continuing implementation.",
        "Apply logging guardrails before continuing implementation."
      ]);

      const messagesA = fixture.aiOrchestratorService.getThreadMessages({ missionId: mission.id, threadId: workerA.threadId ?? "" });
      const messagesB = fixture.aiOrchestratorService.getThreadMessages({ missionId: mission.id, threadId: workerB.threadId ?? "" });
      const broadcastA = messagesA.find((entry) => entry.content.includes("Apply logging guardrails"));
      const broadcastB = messagesB.find((entry) => entry.content.includes("Apply logging guardrails"));
      const metadataA = (broadcastA?.metadata ?? null) as { workerBroadcast?: { sourceMessageId?: string } } | null;
      const metadataB = (broadcastB?.metadata ?? null) as { workerBroadcast?: { sourceMessageId?: string } } | null;
      expect(String(metadataA?.workerBroadcast?.sourceMessageId ?? "")).toBe(broadcast.id);
      expect(String(metadataB?.workerBroadcast?.sourceMessageId ?? "")).toBe(broadcast.id);
    } finally {
      fixture.dispose();
    }
  });

  it("completes multi-lane run and calls createIntegrationPr via prService", async () => {
    const prServiceMock = {
      createIntegrationPr: vi.fn().mockResolvedValue({
        groupId: "group-1",
        integrationLaneId: "int-lane-1",
        pr: {
          id: "pr-1",
          laneId: "int-lane-1",
          projectId: "proj-1",
          repoOwner: "test",
          repoName: "repo",
          githubPrNumber: 42,
          githubUrl: "https://github.com/test/repo/pull/42",
          githubNodeId: null,
          title: "[ADE] Integration: Test Mission",
          state: "draft",
          baseBranch: "main",
          headBranch: "integration/test",
          checksStatus: "none",
          reviewStatus: "none",
          additions: 0,
          deletions: 0,
          lastSyncedAt: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        },
        mergeResults: []
      })
    } as any;

    const fixture = await createFixture();
    try {
      // Create a mission with steps on different lanes
      const mission = fixture.missionService.create({
        prompt: "Build feature with two workers.",
        laneId: fixture.laneId,
        plannedSteps: [
          { index: 0, title: "Worker A task", detail: "Task A", kind: "implementation", metadata: { stepType: "implementation" } },
          { index: 0, title: "Worker B task", detail: "Task B", kind: "implementation", metadata: { stepType: "implementation" } }
        ]
      });

      // Set integration PR policy on mission metadata
      const existingMeta = JSON.parse(
        fixture.db.get<{ metadata_json: string | null }>(
          `select metadata_json from missions where id = ? limit 1`,
          [mission.id]
        )?.metadata_json ?? "{}"
      );
      existingMeta.executionPolicy = {
        ...existingMeta.executionPolicy,
        prStrategy: { kind: "integration" },
        integrationPr: { enabled: true, draft: true, autoResolveConflicts: false }
      };
      existingMeta.missionLevelSettings = {
        allowCompletionWithRisk: true,
        prStrategy: { kind: "integration" },
        integrationPr: { enabled: true, createIntegrationLane: false, prDepth: "shallow", draft: true }
      };
      fixture.db.run(
        `update missions set metadata_json = ? where id = ?`,
        [JSON.stringify(existingMeta), mission.id]
      );

      // Manually add prService to the ai orchestrator by recreating it with prService
      const logMessages: string[] = [];
      const captureLogger = {
        debug: (msg: string) => logMessages.push(`debug: ${msg}`),
        info: (msg: string) => logMessages.push(`info: ${msg}`),
        warn: (msg: string) => logMessages.push(`warn: ${msg}`),
        error: (msg: string) => logMessages.push(`error: ${msg}`)
      } as any;
	      const aiOrchestratorWithPr = createAiOrchestratorService({
	        db: fixture.db,
	        logger: captureLogger,
        missionService: fixture.missionService,
        orchestratorService: fixture.orchestratorService,
        laneService: fixture.laneService,
        projectConfigService: fixture.projectConfigService,
        aiIntegrationService: fixture.aiIntegrationService,
        prService: prServiceMock,
	        projectRoot: fixture.projectRoot
	      });

	      setMissionPlanningMode(fixture.db, mission.id, "off");
	      const launch = await aiOrchestratorWithPr.startMissionRun({
	        missionId: mission.id,
	        runMode: "manual",
	        defaultExecutorKind: "manual",
      });
      if (!launch.started) throw new Error("Expected mission run to start");
      const runId = launch.started.run.id;

      // Add steps manually (simulating coordinator creating tasks)
      fixture.orchestratorService.addSteps({
        runId,
        steps: [
          { stepKey: "worker-a-task", title: "Worker A task", stepIndex: 0, dependencyStepKeys: [], executorKind: "manual", metadata: { stepType: "implementation", instructions: "Task A" } },
          { stepKey: "worker-b-task", title: "Worker B task", stepIndex: 1, dependencyStepKeys: [], executorKind: "manual", metadata: { stepType: "implementation", instructions: "Task B" } }
        ]
      });
      fixture.orchestratorService.tick({ runId });
      const graph = fixture.orchestratorService.getRunGraph({ runId });

      // Insert synthetic lane rows so FK constraints on orchestrator_steps.lane_id are satisfied
      const laneNow = new Date().toISOString();
      for (const lid of ["lane-a", "lane-b"]) {
        fixture.db.run(
          `insert into lanes(
            id, project_id, name, description, lane_type, base_ref, branch_ref,
            worktree_path, attached_root_path, is_edit_protected, parent_lane_id,
            color, icon, tags_json, status, created_at, archived_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            lid, fixture.projectId, lid, null, "worktree", "main",
            `feature/${lid}`, fixture.projectRoot, null, 0, fixture.laneId,
            null, null, null, "active", laneNow, null
          ]
        );
      }

      // Assign different laneIds to steps via DB to simulate multi-lane run
      for (const step of graph.steps) {
        const laneId = step.title === "Worker A task" ? "lane-a" : "lane-b";
        fixture.db.run(
          `update orchestrator_steps set lane_id = ? where id = ?`,
          [laneId, step.id]
        );
      }

      // Complete all steps, ticking between each to advance readiness
      let remaining = graph.steps.length;
      while (remaining > 0) {
        fixture.orchestratorService.tick({ runId });
        const currentGraph = fixture.orchestratorService.getRunGraph({ runId });
        const readySteps = currentGraph.steps.filter((s) => s.status === "ready");
        if (readySteps.length === 0) break;
        for (const step of readySteps) {
          const attempt = await fixture.orchestratorService.startAttempt({
            runId,
            stepId: step.id,
            ownerId: "test-owner",
            executorKind: "manual"
          });
          fixture.orchestratorService.completeAttempt({
            attemptId: attempt.id,
            status: "succeeded",
            result: {
              schema: "ade.orchestratorAttempt.v1",
              success: true,
              summary: "Done",
              outputs: null,
              warnings: [],
              sessionId: null,
              trackedSession: false
            }
          });
          remaining--;
        }
      }
      fixture.orchestratorService.tick({ runId });
      aiOrchestratorWithPr.finalizeRun({ runId, force: true });

      // Verify run is actually completed (may be "succeeded" or "succeeded_with_risk")
      const finalGraph = fixture.orchestratorService.getRunGraph({ runId });
      expect(["succeeded", "succeeded_with_risk"]).toContain(finalGraph.run.status);

      // Verify steps have different lane IDs
      const uniqueLaneIds = new Set(finalGraph.steps.map((s) => s.laneId).filter(Boolean));
      expect(uniqueLaneIds.size).toBeGreaterThan(1);

      // Directly call syncMissionFromRun and await it
      await aiOrchestratorWithPr.syncMissionFromRun(runId, "run_completed");

      // Verify mission became completed
      const missionAfterSync = fixture.missionService.get(mission.id);
      expect(missionAfterSync?.status).toBe("completed");

      // The prService.createIntegrationPr should have been called
      expect(prServiceMock.createIntegrationPr).toHaveBeenCalled();
      const prArgs = prServiceMock.createIntegrationPr.mock.calls[0]![0];
      expect(prArgs.title).toContain("[ADE] Integration:");
      expect(prArgs.draft).toBe(true);

      aiOrchestratorWithPr.dispose();
    } finally {
      fixture.dispose();
    }
  });

  it("handles PR creation failure gracefully without crashing mission sync", async () => {
    const prServiceMock = {
      createIntegrationPr: vi.fn().mockRejectedValue(new Error("GitHub API rate limit exceeded"))
    } as any;

    const fixture = await createFixture();
    try {
      const mission = fixture.missionService.create({
        prompt: "Build feature with two workers.",
        laneId: fixture.laneId,
        plannedSteps: [
          { index: 0, title: "Worker A", detail: "A", kind: "implementation", metadata: { stepType: "implementation" } },
          { index: 0, title: "Worker B", detail: "B", kind: "implementation", metadata: { stepType: "implementation" } }
        ]
      });

      // Set integration PR policy on mission metadata
      const existingMeta2 = JSON.parse(
        fixture.db.get<{ metadata_json: string | null }>(
          `select metadata_json from missions where id = ? limit 1`,
          [mission.id]
        )?.metadata_json ?? "{}"
      );
      existingMeta2.executionPolicy = {
        ...existingMeta2.executionPolicy,
        integrationPr: { enabled: true, draft: true, autoResolveConflicts: false }
      };
      fixture.db.run(
        `update missions set metadata_json = ? where id = ?`,
        [JSON.stringify(existingMeta2), mission.id]
      );

	      const aiOrchestratorWithPr = createAiOrchestratorService({
	        db: fixture.db,
	        logger: createLogger(),
        missionService: fixture.missionService,
        orchestratorService: fixture.orchestratorService,
        laneService: fixture.laneService,
        projectConfigService: fixture.projectConfigService,
        aiIntegrationService: fixture.aiIntegrationService,
        prService: prServiceMock,
	        projectRoot: fixture.projectRoot
	      });

	      setMissionPlanningMode(fixture.db, mission.id, "off");
	      const launch = await aiOrchestratorWithPr.startMissionRun({
	        missionId: mission.id,
	        runMode: "manual",
	        defaultExecutorKind: "manual",
      });
      if (!launch.started) throw new Error("Expected mission run to start");
      const runId = launch.started.run.id;

      // Add steps manually (simulating coordinator creating tasks)
      fixture.orchestratorService.addSteps({
        runId,
        steps: [
          { stepKey: "worker-a", title: "Worker A", stepIndex: 0, dependencyStepKeys: [], executorKind: "manual", metadata: { stepType: "implementation" } },
          { stepKey: "worker-b", title: "Worker B", stepIndex: 1, dependencyStepKeys: [], executorKind: "manual", metadata: { stepType: "implementation" } }
        ]
      });

      // Assign different laneIds and complete all steps sequentially
      {
        // Insert synthetic lane rows so FK constraints on orchestrator_steps.lane_id are satisfied
        const laneNow2 = new Date().toISOString();
        for (const lid of ["lane-a", "lane-b"]) {
          fixture.db.run(
            `insert or ignore into lanes(
              id, project_id, name, description, lane_type, base_ref, branch_ref,
              worktree_path, attached_root_path, is_edit_protected, parent_lane_id,
              color, icon, tags_json, status, created_at, archived_at
            ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              lid, fixture.projectId, lid, null, "worktree", "main",
              `feature/${lid}`, fixture.projectRoot, null, 0, fixture.laneId,
              null, null, null, "active", laneNow2, null
            ]
          );
        }

        fixture.orchestratorService.tick({ runId });
        const initialGraph = fixture.orchestratorService.getRunGraph({ runId });
        for (const step of initialGraph.steps) {
          const lid = step.title === "Worker A" ? "lane-a" : "lane-b";
          fixture.db.run(`update orchestrator_steps set lane_id = ? where id = ?`, [lid, step.id]);
        }
        let rem = initialGraph.steps.length;
        while (rem > 0) {
          fixture.orchestratorService.tick({ runId });
          const g = fixture.orchestratorService.getRunGraph({ runId });
          const ready = g.steps.filter((s) => s.status === "ready");
          if (ready.length === 0) break;
          for (const step of ready) {
            const attempt = await fixture.orchestratorService.startAttempt({
              runId, stepId: step.id, ownerId: "test-owner", executorKind: "manual"
            });
            fixture.orchestratorService.completeAttempt({
              attemptId: attempt.id, status: "succeeded",
              result: { schema: "ade.orchestratorAttempt.v1", success: true, summary: "Done", outputs: null, warnings: [], sessionId: null, trackedSession: false }
            });
            rem--;
          }
        }
        fixture.orchestratorService.tick({ runId });
      }

      aiOrchestratorWithPr.finalizeRun({ runId, force: true });

      // This should not throw even though PR creation fails
      aiOrchestratorWithPr.onOrchestratorRuntimeEvent({
        type: "orchestrator-run-updated",
        runId,
        at: new Date().toISOString(),
        reason: "run_completed"
      });

      await new Promise((resolve) => setTimeout(resolve, 500));

      // Mission should still be completed despite PR failure
      const refreshed = fixture.missionService.get(mission.id);
      expect(refreshed?.status).toBe("completed");

      aiOrchestratorWithPr.dispose();
    } finally {
      fixture.dispose();
    }
  });

  it("does not create integration PR for single-lane run", async () => {
    const prServiceMock = {
      createIntegrationPr: vi.fn().mockResolvedValue({
        groupId: "group-1",
        integrationLaneId: "int-lane-1",
        pr: { githubPrNumber: 42, githubUrl: "https://github.com/test/repo/pull/42" },
        mergeResults: []
      })
    } as any;

    const fixture = await createFixture();
    try {
      const mission = fixture.missionService.create({
        prompt: "Build feature.",
        laneId: fixture.laneId,
        plannedSteps: [
          { index: 0, title: "Step 1", detail: "A", kind: "implementation", metadata: { stepType: "implementation" } },
          { index: 1, title: "Step 2", detail: "B", kind: "test", metadata: { stepType: "test" } }
        ]
      });

      // Set integration PR policy on mission metadata
      const existingMeta3 = JSON.parse(
        fixture.db.get<{ metadata_json: string | null }>(
          `select metadata_json from missions where id = ? limit 1`,
          [mission.id]
        )?.metadata_json ?? "{}"
      );
      existingMeta3.executionPolicy = {
        ...existingMeta3.executionPolicy,
        integrationPr: { enabled: true, draft: true, autoResolveConflicts: false }
      };
      fixture.db.run(
        `update missions set metadata_json = ? where id = ?`,
        [JSON.stringify(existingMeta3), mission.id]
      );

	      const aiOrchestratorWithPr = createAiOrchestratorService({
	        db: fixture.db,
	        logger: createLogger(),
        missionService: fixture.missionService,
        orchestratorService: fixture.orchestratorService,
        laneService: fixture.laneService,
        projectConfigService: fixture.projectConfigService,
        aiIntegrationService: fixture.aiIntegrationService,
        prService: prServiceMock,
	        projectRoot: fixture.projectRoot
	      });

	      setMissionPlanningMode(fixture.db, mission.id, "off");
	      const launch = await aiOrchestratorWithPr.startMissionRun({
	        missionId: mission.id,
	        runMode: "manual",
	        defaultExecutorKind: "manual",
      });
      if (!launch.started) throw new Error("Expected mission run to start");
      const runId = launch.started.run.id;

      // Add steps manually (simulating coordinator creating tasks)
      fixture.orchestratorService.addSteps({
        runId,
        steps: [
          { stepKey: "step-1", title: "Step 1", stepIndex: 0, dependencyStepKeys: [], executorKind: "manual", metadata: { stepType: "implementation" } },
          { stepKey: "step-2", title: "Step 2", stepIndex: 1, dependencyStepKeys: ["step-1"], executorKind: "manual", metadata: { stepType: "test" } }
        ]
      });

      // Complete all steps sequentially (single lane — no lane_id changes)
      {
        let rem = 10; // safety bound
        while (rem > 0) {
          fixture.orchestratorService.tick({ runId });
          const g = fixture.orchestratorService.getRunGraph({ runId });
          const ready = g.steps.filter((s) => s.status === "ready");
          if (ready.length === 0) break;
          for (const step of ready) {
            const attempt = await fixture.orchestratorService.startAttempt({
              runId, stepId: step.id, ownerId: "test-owner", executorKind: "manual"
            });
            fixture.orchestratorService.completeAttempt({
              attemptId: attempt.id, status: "succeeded",
              result: { schema: "ade.orchestratorAttempt.v1", success: true, summary: "Done", outputs: null, warnings: [], sessionId: null, trackedSession: false }
            });
          }
          rem--;
        }
        fixture.orchestratorService.tick({ runId });
      }

      aiOrchestratorWithPr.onOrchestratorRuntimeEvent({
        type: "orchestrator-run-updated",
        runId,
        at: new Date().toISOString(),
        reason: "run_completed"
      });

      await new Promise((resolve) => setTimeout(resolve, 300));

      // Single-lane run should NOT trigger integration PR
      expect(prServiceMock.createIntegrationPr).not.toHaveBeenCalled();

      aiOrchestratorWithPr.dispose();
    } finally {
      fixture.dispose();
    }
  });

  it("watchdog detects stalled attempt with no session output and emits warning event", async () => {
    const fixture = await createFixture({
      aiIntegrationService: createStagnationRecoveryAiIntegrationService()
    });
    try {
      // Register a codex adapter that returns "accepted" with a fake session
      const sessionId = "session-stalled-1";
      const transcriptPath = path.join(fixture.projectRoot, ".ade", "transcripts", `${sessionId}.log`);
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      fs.writeFileSync(transcriptPath, "", "utf8");

      // Pre-create the terminal_sessions row so the accepted path doesn't fail
      fixture.db.run(
        `
          insert into terminal_sessions(
            id, lane_id, pty_id, tracked, title, started_at, ended_at,
            exit_code, transcript_path, head_sha_start, head_sha_end,
            status, last_output_preview, summary, tool_type,
            resume_command, last_output_at
          ) values (?, ?, null, 1, 'Stalled Worker', ?, null, null, ?,
            null, null, 'running', null, null, 'codex-orchestrated', null, null)
        `,
        [sessionId, fixture.laneId, new Date().toISOString(), transcriptPath]
      );

      fixture.orchestratorService.registerExecutorAdapter({
        kind: "unified",
        start: async () => ({
          status: "accepted" as const,
          sessionId,
          metadata: { adapterKind: "unified" }
        })
      });

      const mission = fixture.missionService.create({
        prompt: "Build a feature that may stall during execution.",
        laneId: fixture.laneId
      });

      const launch = await fixture.aiOrchestratorService.startMissionRun({
        missionId: mission.id,
        runMode: "manual",
        defaultExecutorKind: "unified"
      });
      if (!launch.started) throw new Error("Expected mission run to start");
      const runId = launch.started.run.id;

      // Add steps manually (simulating coordinator creating tasks)
      fixture.orchestratorService.addSteps({
        runId,
        steps: [
          {
            stepKey: "implement-changes",
            title: "Implement requested changes",
            stepIndex: 0,
            dependencyStepKeys: [],
            laneId: fixture.laneId,
            executorKind: "manual",
            metadata: {
              instructions: "Do the work",
              modelId: "openai/gpt-5.3-codex",
            },
          }
        ]
      });
      fixture.orchestratorService.tick({ runId });
      const graph = fixture.orchestratorService.getRunGraph({ runId });
      const readyStep = graph.steps.find((s) => s.stepKey === "implement-changes" && s.status === "ready");
      if (!readyStep) throw new Error("Expected implement-changes step to be ready");

      const attempt = await fixture.orchestratorService.startAttempt({
        runId,
        stepId: readyStep.id,
        ownerId: "test-owner",
        executorKind: "unified"
      });

      // Verify the attempt is running before we backdate
      expect(attempt.status).toBe("running");
      expect(attempt.executorSessionId).toBe(sessionId);

      // Backdate the attempt so it appears to have been running for a very long time
      // (well past any timeout). This simulates a stalled execution.
      fixture.db.run(
        `
          update orchestrator_attempts
          set started_at = '2000-01-01T00:00:00.000Z',
              created_at = '2000-01-01T00:00:00.000Z'
          where id = ?
        `,
        [attempt.id]
      );

      // Also backdate the claims so heartbeat doesn't refresh the activity window
      fixture.db.run(
        `
          update orchestrator_claims
          set heartbeat_at = '2000-01-01T00:00:00.000Z'
          where attempt_id = ?
        `,
        [attempt.id]
      );

      // Backdate the transcript file mtime so it doesn't look like recent activity
      const pastTime = new Date("2000-01-01T00:00:00.000Z");
      fs.utimesSync(transcriptPath, pastTime, pastTime);

      // Run the health sweep — the stale attempt should be recovered
      await fixture.aiOrchestratorService.runHealthSweep("watchdog_test");

      // Check the attempt state regardless of sweep count — the health sweep
      // may recover via timeout detection OR via session state reconciliation.
      const refreshedGraph = fixture.orchestratorService.getRunGraph({ runId });
      const refreshedAttempt = refreshedGraph.attempts.find((a) => a.id === attempt.id);

      // The backdated attempt should have been detected as timed out and failed
      expect(refreshedAttempt?.status).toBe("failed");
      expect(refreshedAttempt?.errorClass).toBe("transient");
      expect(refreshedAttempt?.errorMessage ?? "").toContain("stagnating");
    } finally {
      fixture.dispose();
    }
  });
});
