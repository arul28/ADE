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
});
