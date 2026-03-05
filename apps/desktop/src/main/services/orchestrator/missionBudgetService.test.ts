import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openKvDb } from "../state/kvDb";
import { createMissionService } from "../missions/missionService";
import { createBuiltInPhaseCards } from "../missions/phaseEngine";
import { createOrchestratorService } from "./orchestratorService";
import { createMissionBudgetService } from "./missionBudgetService";
import type { PackExport, PackType } from "../../../shared/types";

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
    approxTokens: 16,
    maxTokens: 500,
    truncated: false,
    warnings: [],
    clipReason: null,
    omittedSections: null
  };
}

async function createDbWithProjectAndLane() {
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
    const { db, projectId, root, dispose } = await createDbWithProjectAndLane();
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
    const { db, projectId, laneId, root, dispose } = await createDbWithProjectAndLane();
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
    const { db, projectId, laneId, root, dispose } = await createDbWithProjectAndLane();
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
      packService: {
        getLaneExport: async ({ laneId, level }: { laneId: string; level: "lite" | "standard" | "deep" }) =>
          buildExport(`lane:${laneId}`, "lane", level),
        refreshLanePack: async () => {},
        getProjectExport: async ({ level }: { level: "lite" | "standard" | "deep" }) =>
          buildExport("project", "project", level),
        getDeltaDigest: async () => null,
        getHeadVersion: () => ({ versionId: "pack-v1", versionNumber: 1 })
      } as any,
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
    const { db, projectId, laneId, root, dispose } = await createDbWithProjectAndLane();
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
    const { db, projectId, laneId, root, dispose } = await createDbWithProjectAndLane();
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
