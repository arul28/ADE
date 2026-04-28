import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOrchestratorService } from "./orchestratorService";
import { transitionMissionStatus } from "./missionLifecycle";
import { createMissionService } from "../missions/missionService";
import { createBuiltInPhaseCards } from "../missions/phaseEngine";
import { openKvDb } from "../state/kvDb";
import { createMissionBudgetService } from "./missionBudgetService";
import type { PackExport, PackType } from "../../../shared/types";
import {
  createInitialMissionStateDocument,
  getMissionStateDocumentPath,
  getCoordinatorCheckpointPath,
  updateMissionStateDocument,
  readMissionStateDocument,
  writeCoordinatorCheckpoint,
  readCoordinatorCheckpoint,
  deleteCoordinatorCheckpoint,
} from "./missionStateDoc";

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as any;
}

// ─────────────────────────────────────────────────────
// missionLifecycle — terminal status regression guard
// ─────────────────────────────────────────────────────

async function createLifecycleFixture(initialStatus: string = "in_progress") {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lifecycle-regression-"));
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
      missionId, projectId, laneId, "Lifecycle Regression Test",
      "Test lifecycle regression guard.", initialStatus, "normal", "local",
      null, null, null, null, now, now, now, null,
    ]
  );

  const orchestratorService = createOrchestratorService({
    db,
    projectId,
    projectRoot,
    ptyService: {
      create: async () => ({ ptyId: "pty-1", sessionId: "session-1" }),
    } as any,
    projectConfigService: null as any,
    aiIntegrationService: null as any,
    memoryService: null as any,
  });

  const missionService = createMissionService({ db, projectId });

  const ctx = {
    db,
    logger: createLogger(),
    missionService,
    orchestratorService,
    projectRoot,
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

  return {
    ctx,
    missionId,
    missionService,
    dispose: () => {
      db.close();
      fs.rmSync(projectRoot, { recursive: true, force: true });
    },
  };
}

describe("transitionMissionStatus — terminal status regression guard", () => {
  it("blocks transition from completed to in_progress", async () => {
    const fixture = await createLifecycleFixture("completed");
    try {
      transitionMissionStatus(fixture.ctx, fixture.missionId, "in_progress");
      const mission = fixture.missionService.get(fixture.missionId);
      expect(mission?.status).toBe("completed");
    } finally {
      fixture.dispose();
    }
  });

  it("blocks transition from failed to running", async () => {
    const fixture = await createLifecycleFixture("failed");
    try {
      transitionMissionStatus(fixture.ctx, fixture.missionId, "in_progress");
      const mission = fixture.missionService.get(fixture.missionId);
      expect(mission?.status).toBe("failed");
    } finally {
      fixture.dispose();
    }
  });

  it("blocks transition from canceled to in_progress", async () => {
    const fixture = await createLifecycleFixture("canceled");
    try {
      transitionMissionStatus(fixture.ctx, fixture.missionId, "in_progress");
      const mission = fixture.missionService.get(fixture.missionId);
      expect(mission?.status).toBe("canceled");
    } finally {
      fixture.dispose();
    }
  });

  it("passes through the regression guard for terminal-to-terminal (completed to completed)", async () => {
    const fixture = await createLifecycleFixture("completed");
    try {
      transitionMissionStatus(fixture.ctx, fixture.missionId, "completed");
      const mission = fixture.missionService.get(fixture.missionId);
      expect(mission?.status).toBe("completed");
    } finally {
      fixture.dispose();
    }
  });

  it("does not throw for terminal-to-terminal even when missionService rejects it", async () => {
    const fixture = await createLifecycleFixture("completed");
    try {
      transitionMissionStatus(fixture.ctx, fixture.missionId, "failed");
      const mission = fixture.missionService.get(fixture.missionId);
      expect(mission?.status).toBe("completed");
    } finally {
      fixture.dispose();
    }
  });

  it("allows failed -> canceled (valid in missionService transition table)", async () => {
    const fixture = await createLifecycleFixture("failed");
    try {
      transitionMissionStatus(fixture.ctx, fixture.missionId, "canceled");
      const mission = fixture.missionService.get(fixture.missionId);
      expect(mission?.status).toBe("canceled");
    } finally {
      fixture.dispose();
    }
  });

  it("allows transition from non-terminal to terminal (in_progress to completed)", async () => {
    const fixture = await createLifecycleFixture("in_progress");
    try {
      transitionMissionStatus(fixture.ctx, fixture.missionId, "completed", {
        outcomeSummary: "All tasks done",
      });
      const mission = fixture.missionService.get(fixture.missionId);
      expect(mission?.status).toBe("completed");
    } finally {
      fixture.dispose();
    }
  });

  it("allows transition from non-terminal to non-terminal (in_progress to intervention_required)", async () => {
    const fixture = await createLifecycleFixture("in_progress");
    try {
      transitionMissionStatus(fixture.ctx, fixture.missionId, "intervention_required", {
        lastError: "Needs human review",
      });
      const mission = fixture.missionService.get(fixture.missionId);
      expect(mission?.status).toBe("intervention_required");
    } finally {
      fixture.dispose();
    }
  });

  it("blocks transition from completed to intervention_required (non-terminal)", async () => {
    const fixture = await createLifecycleFixture("completed");
    try {
      transitionMissionStatus(fixture.ctx, fixture.missionId, "intervention_required");
      const mission = fixture.missionService.get(fixture.missionId);
      expect(mission?.status).toBe("completed");
    } finally {
      fixture.dispose();
    }
  });

  it("no-ops when transitioning to the same status with no args", async () => {
    const fixture = await createLifecycleFixture("in_progress");
    try {
      transitionMissionStatus(fixture.ctx, fixture.missionId, "in_progress");
      const mission = fixture.missionService.get(fixture.missionId);
      expect(mission?.status).toBe("in_progress");
    } finally {
      fixture.dispose();
    }
  });

  it("returns silently for a non-existent mission", async () => {
    const fixture = await createLifecycleFixture("in_progress");
    try {
      transitionMissionStatus(fixture.ctx, "non-existent-mission-id", "completed");
    } finally {
      fixture.dispose();
    }
  });
});

// ─────────────────────────────────────────────────────
// missionBudgetService
// ─────────────────────────────────────────────────────

function buildExport(packKey: string, packType: PackType, level: "lite" | "standard" | "deep"): PackExport {
  return {
    packKey,
    packType,
    level,
    header: {} as any,
    content: `${packKey}:${level}`,
    approxTokens: 16,
    maxTokens: 500,
    truncated: false,
    warnings: [],
    clipReason: null,
    omittedSections: null
  };
}

async function createBudgetDbWithProjectAndLane() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-mission-budget-"));
  const dbPath = path.join(root, "ade.db");
  const db = await openKvDb(dbPath, createLogger());

  const projectId = "proj-1";
  const laneId = "lane-1";
  const now = "2026-02-18T00:00:00.000Z";

  db.run(
    `
      insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at)
      values (?, ?, ?, ?, ?, ?)
    `,
    [projectId, root, "ADE", "main", now, now]
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
      root,
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

  return {
    db,
    projectId,
    laneId,
    root,
    dispose: () => db.close()
  };
}

function writeCodexSessionLog(args: {
  sessionsRoot: string;
  cwd: string;
  timestampIso: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
}): void {
  const date = new Date(args.timestampIso);
  const yyyy = String(date.getUTCFullYear());
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const dayDir = path.join(args.sessionsRoot, yyyy, mm, dd);
  fs.mkdirSync(dayDir, { recursive: true });
  const filePath = path.join(dayDir, "rollout-test.jsonl");
  const model = args.model ?? "openai/gpt-5";
  const lines = [
    JSON.stringify({
      timestamp: args.timestampIso,
      type: "session_meta",
      payload: {
        id: "session-test-1",
        cwd: args.cwd,
      },
    }),
    JSON.stringify({
      timestamp: args.timestampIso,
      type: "turn_context",
      payload: {
        cwd: args.cwd,
        model,
      },
    }),
    JSON.stringify({
      timestamp: args.timestampIso,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: args.inputTokens,
            output_tokens: args.outputTokens,
            cached_input_tokens: 0,
            reasoning_output_tokens: 0,
            total_tokens: args.inputTokens + args.outputTokens,
          },
          last_token_usage: {
            input_tokens: args.inputTokens,
            output_tokens: args.outputTokens,
            cached_input_tokens: 0,
            reasoning_output_tokens: 0,
            total_tokens: args.inputTokens + args.outputTokens,
          },
        },
      },
    }),
  ];
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

function writeClaudeProjectLog(args: {
  projectsRoot: string;
  timestampIso: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
}): void {
  const projectDir = path.join(args.projectsRoot, "-tmp-test-project");
  fs.mkdirSync(projectDir, { recursive: true });
  const filePath = path.join(projectDir, "session.jsonl");
  const model = args.model ?? "anthropic/claude-sonnet-4-6";
  const line = JSON.stringify({
    timestamp: args.timestampIso,
    message: {
      model,
      usage: {
        input_tokens: args.inputTokens,
        output_tokens: args.outputTokens,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  });
  fs.writeFileSync(filePath, `${line}\n`, "utf8");
}

describe("missionBudgetService", () => {
  it("flags API-key launch estimate when projected spend exceeds remaining envelope", async () => {
    const { db, projectId, root, dispose } = await createBudgetDbWithProjectAndLane();
    const missionService = createMissionService({ db, projectId });
    const budgetService = createMissionBudgetService({
      db,
      logger: createLogger(),
      projectId,
      projectRoot: root,
      missionService,
      aiIntegrationService: {
        getStatus: async () => ({ mode: "api-key", detectedAuth: [] })
      } as any
    });

    const estimate = await budgetService.estimateLaunchBudget({
      launch: {
        prompt: "Implement a complex mission pipeline.",
        modelConfig: {
          orchestratorModel: {
            provider: "claude",
            modelId: "claude-sonnet-4-6"
          },
          smartBudget: {
            enabled: true,
            fiveHourThresholdUsd: 0.05,
            weeklyThresholdUsd: 1
          }
        }
      },
      selectedPhases: createBuiltInPhaseCards().map((phase) => ({
        ...phase,
        budget: {
          maxTokens: 4_000
        }
      }))
    });

    expect(estimate.estimate.mode).toBe("api-key");
    expect(estimate.estimate.estimatedCostUsd).toBeGreaterThan(0);
    expect(estimate.hardLimitExceeded).toBe(true);

    dispose();
  });

  it("uses local Codex session telemetry for subscription preflight and runtime budget snapshots", async () => {
    const { db, projectId, laneId, root, dispose } = await createBudgetDbWithProjectAndLane();
    const missionService = createMissionService({ db, projectId });
    const mission = missionService.create({
      prompt: "Use subscription telemetry.",
      laneId,
      phaseOverride: createBuiltInPhaseCards(),
    });
    const codexSessionsRoot = path.join(root, "codex-sessions");
    const nowIso = new Date().toISOString();
    writeCodexSessionLog({
      sessionsRoot: codexSessionsRoot,
      cwd: root,
      timestampIso: nowIso,
      model: "openai/gpt-5",
      inputTokens: 100_000,
      outputTokens: 128_750,
    });

    const budgetService = createMissionBudgetService({
      db,
      logger: createLogger(),
      projectId,
      projectRoot: root,
      missionService,
      aiIntegrationService: {
        getStatus: async () => ({ mode: "subscription", detectedAuth: [{ type: "cli-subscription", authenticated: true, cli: "codex" }] })
      } as any,
      projectConfigService: {
        get: () => ({
          effective: {
            cto: {
              budgetTelemetry: {
                enabled: true,
                codexSessionsRoot,
                claudeProjectsRoot: path.join(root, "no-claude-logs"),
              },
            },
          },
        }),
      } as any,
    });

    const estimate = await budgetService.estimateLaunchBudget({
      launch: {
        prompt: "Run with local CLI subscription telemetry.",
        modelConfig: {
          orchestratorModel: {
            provider: "codex",
            modelId: "openai/gpt-5",
          },
        },
      },
      selectedPhases: createBuiltInPhaseCards(),
    });
    expect(estimate.estimate.mode).toBe("subscription");
    expect(estimate.estimate.actualSpendUsd).toBeCloseTo(1.23, 6);
    expect(estimate.estimate.burnRateUsdPerHour ?? null).toBeNull();
    expect(estimate.estimate.note ?? "").toContain("local CLI telemetry");

    const snapshot = await budgetService.getMissionBudgetStatus({
      missionId: mission.id,
    });
    expect(snapshot.mode).toBe("subscription");
    const codexProvider = snapshot.perProvider.find((provider) => provider.provider === "codex");
    expect(codexProvider?.fiveHour.usedCostUsd).toBeCloseTo(1.23, 6);
    expect(snapshot.burnRateUsdPerHour).toBeNull();
    expect(snapshot.dataSources).toContain("~/.codex/sessions/*.jsonl");

    dispose();
  });

  it("returns per-phase and per-worker budget snapshot with pressure", async () => {
    const { db, projectId, laneId, root, dispose } = await createBudgetDbWithProjectAndLane();
    const missionService = createMissionService({ db, projectId });
    const phaseOverride = createBuiltInPhaseCards().map((phase) => ({
      ...phase,
      budget: {
        maxTokens: 100,
        maxTimeMs: 60_000
      }
    }));
    const mission = missionService.create({
      prompt: "Build and validate mission budget usage telemetry.",
      laneId,
      phaseOverride
    });

    const orchestratorService = createOrchestratorService({
      db,
      projectId,
      projectRoot: root,
    });

    const started = orchestratorService.startRun({
      missionId: mission.id,
      metadata: {},
      steps: [
        {
          stepKey: "planning-1",
          stepIndex: 0,
          title: "Planning task",
          laneId,
          dependencyStepKeys: [],
          retryLimit: 1,
          executorKind: "manual",
          metadata: {
            phaseKey: phaseOverride[0]!.phaseKey,
            phaseName: phaseOverride[0]!.name
          }
        }
      ]
    });

    const step = started.steps[0]!;
    db.run(
      `update orchestrator_steps set status = 'ready', updated_at = ? where id = ? and run_id = ?`,
      [new Date().toISOString(), step.id, started.run.id]
    );

    const attempt = await orchestratorService.startAttempt({
      runId: started.run.id,
      stepId: step.id,
      ownerId: "test-owner",
      executorKind: "manual"
    });
    const sessionId = `session-${randomUUID()}`;
    db.run(
      `update orchestrator_attempts set executor_session_id = ? where id = ? and run_id = ?`,
      [sessionId, attempt.id, started.run.id]
    );
    db.run(
      `
        insert into ai_usage_log(
          id,
          timestamp,
          feature,
          provider,
          model,
          input_tokens,
          output_tokens,
          duration_ms,
          success,
          session_id
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        randomUUID(),
        new Date().toISOString(),
        "orchestrator",
        "claude",
        "anthropic/claude-sonnet-4-6",
        250,
        200,
        45_000,
        1,
        sessionId
      ]
    );

    const budgetService = createMissionBudgetService({
      db,
      logger: createLogger(),
      projectId,
      projectRoot: root,
      missionService,
      aiIntegrationService: {
        getStatus: async () => ({ mode: "api-key", detectedAuth: [] })
      } as any
    });

    const snapshot = await budgetService.getMissionBudgetStatus({
      missionId: mission.id,
      runId: started.run.id
    });

    expect(snapshot.mode).toBe("api-key");
    expect(snapshot.pressure).toBe("critical");
    expect(snapshot.mission.usedTokens).toBe(450);
    expect(snapshot.perPhase.length).toBeGreaterThan(0);
    expect(snapshot.perWorker.length).toBeGreaterThan(0);
    expect(snapshot.dataSources).toContain("ai_usage_log");

    dispose();
  });

  it("enforces subscription hard caps only for providers selected by mission models", async () => {
    const { db, projectId, laneId, root, dispose } = await createBudgetDbWithProjectAndLane();
    const missionService = createMissionService({ db, projectId });
    const codexSessionsRoot = path.join(root, "codex-sessions");
    const claudeProjectsRoot = path.join(root, "claude-projects");
    const nowIso = new Date().toISOString();
    writeCodexSessionLog({
      sessionsRoot: codexSessionsRoot,
      cwd: root,
      timestampIso: nowIso,
      model: "openai/gpt-5.3-codex",
      inputTokens: 500,
      outputTokens: 500,
    });
    writeClaudeProjectLog({
      projectsRoot: claudeProjectsRoot,
      timestampIso: nowIso,
      model: "anthropic/claude-sonnet-4-6",
      inputTokens: 5_000,
      outputTokens: 5_000,
    });

    const phaseOverride = createBuiltInPhaseCards().map((phase, index) => ({
      ...phase,
      model: {
        ...phase.model,
        provider: "codex",
        modelId: "openai/gpt-5.3-codex",
      },
      position: index,
    }));
    const mission = missionService.create({
      prompt: "Codex-only mission with provider-scoped hard caps.",
      laneId,
      phaseOverride,
      modelConfig: {
        orchestratorModel: {
          provider: "codex",
          modelId: "openai/gpt-5.3-codex",
        },
        smartBudget: {
          enabled: true,
          fiveHourThresholdUsd: 10,
          weeklyThresholdUsd: 40,
          fiveHourHardStopPercent: 80,
          weeklyHardStopPercent: 90,
          providerLimits: {
            codex: { fiveHourTokenLimit: 10_000, weeklyTokenLimit: 10_000 },
            claude: { fiveHourTokenLimit: 1_000, weeklyTokenLimit: 1_000 },
          },
        },
      },
    });

    const budgetService = createMissionBudgetService({
      db,
      logger: createLogger(),
      projectId,
      projectRoot: root,
      missionService,
      aiIntegrationService: {
        getStatus: async () => ({ mode: "subscription", detectedAuth: [{ type: "cli-subscription", authenticated: true, cli: "codex" }] })
      } as any,
      projectConfigService: {
        get: () => ({
          effective: {
            cto: {
              budgetTelemetry: {
                enabled: true,
                codexSessionsRoot,
                claudeProjectsRoot,
              },
            },
          },
        }),
      } as any,
    });

    const snapshot = await budgetService.getMissionBudgetStatus({ missionId: mission.id });
    const claudeProvider = snapshot.perProvider.find((provider) => provider.provider === "claude");
    expect((claudeProvider?.fiveHour.usedPct ?? 0)).toBeGreaterThan(80);
    expect(snapshot.hardCaps.fiveHourTriggered).toBe(false);
    expect(snapshot.hardCaps.weeklyTriggered).toBe(false);

    const telemetry = budgetService.getMissionBudgetTelemetry({
      providers: ["codex"],
      providerLimits: {
        codex: { fiveHourTokenLimit: 10_000, weeklyTokenLimit: 10_000 },
      },
    });
    expect(telemetry.perProvider).toHaveLength(1);
    expect(telemetry.perProvider[0]?.provider).toBe("codex");
    expect(telemetry.perProvider[0]?.fiveHour.usedTokens ?? 0).toBeGreaterThan(0);

    dispose();
  });

  it("disables hard-stop enforcement when smart budget toggle is off", async () => {
    const { db, projectId, laneId, root, dispose } = await createBudgetDbWithProjectAndLane();
    const missionService = createMissionService({ db, projectId });
    const codexSessionsRoot = path.join(root, "codex-sessions");
    const nowIso = new Date().toISOString();
    writeCodexSessionLog({
      sessionsRoot: codexSessionsRoot,
      cwd: root,
      timestampIso: nowIso,
      model: "openai/gpt-5.3-codex",
      inputTokens: 9_000,
      outputTokens: 9_000,
    });
    const phaseOverride = createBuiltInPhaseCards().map((phase, index) => ({
      ...phase,
      model: {
        ...phase.model,
        provider: "codex",
        modelId: "openai/gpt-5.3-codex",
      },
      position: index,
    }));
    const mission = missionService.create({
      prompt: "Mission with smart budget disabled.",
      laneId,
      phaseOverride,
      modelConfig: {
        orchestratorModel: {
          provider: "codex",
          modelId: "openai/gpt-5.3-codex",
        },
        smartBudget: {
          enabled: false,
          fiveHourThresholdUsd: 10,
          weeklyThresholdUsd: 40,
          fiveHourHardStopPercent: 80,
          weeklyHardStopPercent: 90,
          providerLimits: {
            codex: { fiveHourTokenLimit: 1_000, weeklyTokenLimit: 1_000 },
          },
        },
      },
    });

    const budgetService = createMissionBudgetService({
      db,
      logger: createLogger(),
      projectId,
      projectRoot: root,
      missionService,
      aiIntegrationService: {
        getStatus: async () => ({ mode: "subscription", detectedAuth: [{ type: "cli-subscription", authenticated: true, cli: "codex" }] })
      } as any,
      projectConfigService: {
        get: () => ({
          effective: {
            cto: {
              budgetTelemetry: {
                enabled: true,
                codexSessionsRoot,
              },
            },
          },
        }),
      } as any,
    });

    const snapshot = await budgetService.getMissionBudgetStatus({ missionId: mission.id });
    expect(snapshot.hardCaps.fiveHourHardStopPercent).toBeNull();
    expect(snapshot.hardCaps.weeklyHardStopPercent).toBeNull();
    expect(snapshot.hardCaps.apiKeyMaxSpendUsd).toBeNull();
    expect(snapshot.hardCaps.fiveHourTriggered).toBe(false);
    expect(snapshot.hardCaps.weeklyTriggered).toBe(false);
    expect(snapshot.hardCaps.apiKeyTriggered).toBe(false);

    dispose();
  });
});

// ─────────────────────────────────────────────────────
// missionStateDoc
// ─────────────────────────────────────────────────────

describe("missionStateDoc", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-msd-test-"));
    const missionStateDir = path.join(tmpDir, ".ade", "cache", "mission-state");
    fs.mkdirSync(missionStateDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("getMissionStateDocumentPath", () => {
    it("returns path under .ade/cache/mission-state", () => {
      const result = getMissionStateDocumentPath(tmpDir, "run-abc");
      expect(result).toContain("mission-state");
      expect(result).toContain("mission-state-run-abc.json");
    });
  });

  describe("getCoordinatorCheckpointPath", () => {
    it("returns path under .ade/cache/mission-state", () => {
      const result = getCoordinatorCheckpointPath(tmpDir, "run-abc");
      expect(result).toContain("mission-state");
      expect(result).toContain("coordinator-checkpoint-run-abc.json");
    });
  });

  describe("createInitialMissionStateDocument", () => {
    it("creates a document with schemaVersion 1 and empty collections", () => {
      const doc = createInitialMissionStateDocument({
        missionId: "mission-1",
        runId: "run-1",
        goal: "Build feature X",
      });
      expect(doc.schemaVersion).toBe(1);
      expect(doc.missionId).toBe("mission-1");
      expect(doc.runId).toBe("run-1");
      expect(doc.goal).toBe("Build feature X");
      expect(doc.stepOutcomes).toEqual([]);
      expect(doc.decisions).toEqual([]);
      expect(doc.activeIssues).toEqual([]);
      expect(doc.modifiedFiles).toEqual([]);
      expect(doc.pendingInterventions).toEqual([]);
      expect(doc.reflections).toEqual([]);
      expect(doc.latestRetrospective).toBeNull();
    });

    it("initializes progress with defaults when not provided", () => {
      const doc = createInitialMissionStateDocument({
        missionId: "m1",
        runId: "r1",
        goal: "Test",
      });
      expect(doc.progress.currentPhase).toBe("unknown");
      expect(doc.progress.completedSteps).toBe(0);
      expect(doc.progress.totalSteps).toBe(0);
      expect(doc.progress.activeWorkers).toEqual([]);
      expect(doc.progress.blockedSteps).toEqual([]);
      expect(doc.progress.failedSteps).toEqual([]);
    });

    it("accepts partial progress overrides", () => {
      const doc = createInitialMissionStateDocument({
        missionId: "m1",
        runId: "r1",
        goal: "Test",
        progress: { currentPhase: "development", totalSteps: 5 },
      });
      expect(doc.progress.currentPhase).toBe("development");
      expect(doc.progress.totalSteps).toBe(5);
      expect(doc.progress.completedSteps).toBe(0);
    });
  });

  describe("updateMissionStateDocument", () => {
    it("creates a new document and applies the patch", async () => {
      const result = await updateMissionStateDocument({
        projectRoot: tmpDir,
        missionId: "m1",
        runId: "run-update-1",
        goal: "Build X",
        patch: {
          updateProgress: {
            currentPhase: "development",
            totalSteps: 3,
          },
        },
      });
      expect(result.missionId).toBe("m1");
      expect(result.progress.currentPhase).toBe("development");
      expect(result.progress.totalSteps).toBe(3);
    });

    it("adds a step outcome", async () => {
      const result = await updateMissionStateDocument({
        projectRoot: tmpDir,
        missionId: "m1",
        runId: "run-step-outcome",
        goal: "Build X",
        patch: {
          addStepOutcome: {
            stepKey: "step-1",
            stepName: "Implement auth",
            phase: "development",
            status: "succeeded",
            summary: "Auth module completed",
            filesChanged: ["src/auth.ts"],
            warnings: [],
            completedAt: "2026-03-25T12:00:00.000Z",
          },
        },
      });
      expect(result.stepOutcomes).toHaveLength(1);
      expect(result.stepOutcomes[0].stepKey).toBe("step-1");
      expect(result.stepOutcomes[0].status).toBe("succeeded");
      expect(result.stepOutcomes[0].filesChanged).toEqual(["src/auth.ts"]);
      expect(result.modifiedFiles).toContain("src/auth.ts");
    });

    it("merges step outcome updates on existing step", async () => {
      await updateMissionStateDocument({
        projectRoot: tmpDir,
        missionId: "m1",
        runId: "run-merge-outcome",
        goal: "Build X",
        patch: {
          addStepOutcome: {
            stepKey: "step-1",
            stepName: "Implement auth",
            phase: "development",
            status: "in_progress",
            summary: "Started",
            filesChanged: ["src/auth.ts"],
            warnings: [],
            completedAt: null,
          },
        },
      });

      const result = await updateMissionStateDocument({
        projectRoot: tmpDir,
        missionId: "m1",
        runId: "run-merge-outcome",
        goal: "Build X",
        patch: {
          addStepOutcome: {
            stepKey: "step-1",
            stepName: "Implement auth",
            phase: "development",
            status: "succeeded",
            summary: "Completed auth module",
            filesChanged: ["src/auth.ts", "src/middleware.ts"],
            warnings: [],
            completedAt: "2026-03-25T13:00:00.000Z",
          },
        },
      });
      expect(result.stepOutcomes).toHaveLength(1);
      expect(result.stepOutcomes[0].status).toBe("succeeded");
      expect(result.stepOutcomes[0].summary).toBe("Completed auth module");
    });

    it("adds decisions", async () => {
      const result = await updateMissionStateDocument({
        projectRoot: tmpDir,
        missionId: "m1",
        runId: "run-decision",
        goal: "Build X",
        patch: {
          addDecision: {
            timestamp: "2026-03-25T12:00:00.000Z",
            decision: "Use JWT for auth",
            rationale: "Standard approach",
            context: "Architecture decision",
          },
        },
      });
      expect(result.decisions).toHaveLength(1);
      expect(result.decisions[0].decision).toBe("Use JWT for auth");
    });

    it("adds and resolves issues", async () => {
      await updateMissionStateDocument({
        projectRoot: tmpDir,
        missionId: "m1",
        runId: "run-issue",
        goal: "Build X",
        patch: {
          addIssue: {
            id: "issue-1",
            severity: "high",
            description: "Auth module failing tests",
            affectedSteps: ["step-1"],
            status: "open",
          },
        },
      });

      const result = await updateMissionStateDocument({
        projectRoot: tmpDir,
        missionId: "m1",
        runId: "run-issue",
        goal: "Build X",
        patch: {
          resolveIssue: {
            id: "issue-1",
            resolution: "Fixed the test setup",
          },
        },
      });
      expect(result.activeIssues).toHaveLength(1);
      expect(result.activeIssues[0].status).toBe("resolved");
      expect(result.decisions.some((d) => d.decision.includes("Resolved issue issue-1"))).toBe(true);
    });

    it("sets and clears finalization state", async () => {
      const result = await updateMissionStateDocument({
        projectRoot: tmpDir,
        missionId: "m1",
        runId: "run-fin",
        goal: "Build X",
        patch: {
          finalization: {
            policy: {
              kind: "integration",
              targetBranch: "main",
              draft: false,
              prDepth: null,
              autoRebase: true,
              ciGating: true,
              autoLand: false,
              autoResolveConflicts: false,
              archiveLaneOnLand: true,
              mergeMethod: "squash",
              conflictResolverModel: null,
              reasoningEffort: null,
              description: null,
            },
            status: "creating_pr",
            executionComplete: true,
            contractSatisfied: false,
            blocked: false,
            blockedReason: null,
            summary: "Creating PR",
            detail: null,
            resolverJobId: null,
            integrationLaneId: null,
            resultLaneId: null,
            queueGroupId: null,
            queueId: null,
            activePrId: null,
            waitReason: null,
            proposalUrl: null,
            prUrls: [],
            reviewStatus: null,
            mergeReadiness: null,
            requirements: [],
            warnings: [],
            updatedAt: "2026-03-25T12:00:00.000Z",
            startedAt: "2026-03-25T12:00:00.000Z",
            completedAt: null,
          },
        },
      });
      expect(result.finalization).not.toBeNull();
      expect(result.finalization!.status).toBe("creating_pr");
      expect(result.finalization!.policy.kind).toBe("integration");

      const cleared = await updateMissionStateDocument({
        projectRoot: tmpDir,
        missionId: "m1",
        runId: "run-fin",
        goal: "Build X",
        patch: { finalization: null },
      });
      expect(cleared.finalization).toBeNull();
    });
  });

  describe("readMissionStateDocument", () => {
    it("returns null when no document exists", async () => {
      const doc = await readMissionStateDocument({
        projectRoot: tmpDir,
        runId: "nonexistent-run",
      });
      expect(doc).toBeNull();
    });

    it("reads back a previously written document", async () => {
      await updateMissionStateDocument({
        projectRoot: tmpDir,
        missionId: "m1",
        runId: "run-read-test",
        goal: "Readable goal",
        patch: { updateProgress: { currentPhase: "testing" } },
      });

      const doc = await readMissionStateDocument({
        projectRoot: tmpDir,
        runId: "run-read-test",
      });
      expect(doc).not.toBeNull();
      expect(doc!.goal).toBe("Readable goal");
      expect(doc!.progress.currentPhase).toBe("testing");
    });
  });

  describe("writeCoordinatorCheckpoint / readCoordinatorCheckpoint", () => {
    it("writes and reads a checkpoint", async () => {
      await writeCoordinatorCheckpoint(tmpDir, "run-cp-1", {
        version: 1,
        runId: "run-cp-1",
        missionId: "m1",
        conversationSummary: "Worker completed step 1",
        lastEventTimestamp: "2026-03-25T12:00:00.000Z",
        turnCount: 5,
        compactionCount: 1,
        savedAt: "2026-03-25T12:01:00.000Z",
      });

      const cp = await readCoordinatorCheckpoint(tmpDir, "run-cp-1");
      expect(cp).not.toBeNull();
      expect(cp!.missionId).toBe("m1");
      expect(cp!.conversationSummary).toBe("Worker completed step 1");
      expect(cp!.turnCount).toBe(5);
      expect(cp!.compactionCount).toBe(1);
    });

    it("returns null for non-existent checkpoint", async () => {
      const cp = await readCoordinatorCheckpoint(tmpDir, "nonexistent");
      expect(cp).toBeNull();
    });

    it("rejects invalid checkpoint payload", async () => {
      await expect(
        writeCoordinatorCheckpoint(tmpDir, "run-bad", {
          version: 1,
          runId: "",
          missionId: "",
          conversationSummary: "",
          lastEventTimestamp: null,
          turnCount: 0,
          compactionCount: 0,
          savedAt: "",
        }),
      ).rejects.toThrow("Invalid coordinator checkpoint payload");
    });

    it("truncates oversized conversation summaries", async () => {
      const longSummary = "x".repeat(10_000);
      await writeCoordinatorCheckpoint(tmpDir, "run-long", {
        version: 1,
        runId: "run-long",
        missionId: "m1",
        conversationSummary: longSummary,
        lastEventTimestamp: null,
        turnCount: 0,
        compactionCount: 0,
        savedAt: "2026-03-25T12:00:00.000Z",
      });
      const cp = await readCoordinatorCheckpoint(tmpDir, "run-long");
      expect(cp).not.toBeNull();
      expect(cp!.conversationSummary.length).toBeLessThanOrEqual(8_000);
    });
  });

  describe("deleteCoordinatorCheckpoint", () => {
    it("deletes an existing checkpoint", async () => {
      await writeCoordinatorCheckpoint(tmpDir, "run-del", {
        version: 1,
        runId: "run-del",
        missionId: "m1",
        conversationSummary: "Test",
        lastEventTimestamp: null,
        turnCount: 1,
        compactionCount: 0,
        savedAt: "2026-03-25T12:00:00.000Z",
      });

      await deleteCoordinatorCheckpoint(tmpDir, "run-del");
      const cp = await readCoordinatorCheckpoint(tmpDir, "run-del");
      expect(cp).toBeNull();
    });

    it("does not throw when deleting a non-existent checkpoint", async () => {
      await expect(
        deleteCoordinatorCheckpoint(tmpDir, "nonexistent"),
      ).resolves.toBeUndefined();
    });
  });
});
