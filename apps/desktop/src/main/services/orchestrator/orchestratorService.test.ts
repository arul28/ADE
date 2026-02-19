import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PackExport, PackType } from "../../../shared/types";
import { createOrchestratorService } from "./orchestratorService";
import { openKvDb } from "../state/kvDb";

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
    approxTokens: 32,
    maxTokens: 500,
    truncated: false,
    warnings: [],
    clipReason: null,
    omittedSections: null
  };
}

async function createFixture() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-orchestrator-"));
  fs.mkdirSync(path.join(projectRoot, "docs", "architecture"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "docs", "PRD.md"), "# PRD\n\nContext baseline\n", "utf8");
  fs.writeFileSync(path.join(projectRoot, "docs", "architecture", "CONTEXT_CONTRACT.md"), "# Context Contract\n", "utf8");

  const db = await openKvDb(path.join(projectRoot, "ade.db"), createLogger());
  const projectId = "proj-1";
  const laneId = "lane-1";
  const missionId = "mission-1";
  const now = "2026-02-19T00:00:00.000Z";

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

  db.run(
    `
      insert into missions(
        id,
        project_id,
        lane_id,
        title,
        prompt,
        status,
        priority,
        execution_mode,
        target_machine_id,
        outcome_summary,
        last_error,
        metadata_json,
        created_at,
        updated_at,
        started_at,
        completed_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [missionId, projectId, laneId, "Mission 1", "Execute deterministic run.", "queued", "normal", "local", null, null, null, null, now, now, null, null]
  );

  const ptyCreateCalls: Array<Record<string, unknown>> = [];
  const ptyService = {
    create: async (args: Record<string, unknown>) => {
      ptyCreateCalls.push(args);
      const index = ptyCreateCalls.length;
      return {
        ptyId: `pty-${index}`,
        sessionId: `session-${index}`
      };
    }
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
    refreshMissionPack: async ({ missionId: targetMissionId }: { missionId: string }) => ({
      packKey: `mission:${targetMissionId}`,
      packType: "mission",
      path: path.join(projectRoot, ".ade", "packs", "missions", targetMissionId, "mission_pack.md"),
      exists: true,
      deterministicUpdatedAt: now,
      narrativeUpdatedAt: null,
      lastHeadSha: null,
      versionId: `mission-${targetMissionId}-v1`,
      versionNumber: 1,
      contentHash: `hash-mission-${targetMissionId}`,
      metadata: null,
      body: "# Mission Pack"
    })
  } as any;

  const service = createOrchestratorService({
    db,
    projectId,
    projectRoot,
    packService,
    ptyService
  });

  return {
    db,
    service,
    laneId,
    missionId,
    ptyCreateCalls,
    dispose: () => db.close()
  };
}

describe("orchestratorService", () => {
  it("enforces tracked sessions for orchestrated execution", async () => {
    const fixture = await createFixture();
    try {
      await expect(
        fixture.service.createOrchestratedSession({
          laneId: fixture.laneId,
          cols: 120,
          rows: 36,
          title: "orchestrator session",
          tracked: false
        })
      ).rejects.toThrow(/tracked=true/i);

      const created = await fixture.service.createOrchestratedSession({
        laneId: fixture.laneId,
        cols: 120,
        rows: 36,
        title: "orchestrator session"
      });

      expect(created.sessionId).toBe("session-1");
      expect(fixture.ptyCreateCalls).toHaveLength(1);
      expect(fixture.ptyCreateCalls[0]?.tracked).toBe(true);
    } finally {
      fixture.dispose();
    }
  });

  it("blocks attempts deterministically on claim collisions", async () => {
    const fixture = await createFixture();
    try {
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [
          {
            stepKey: "build",
            title: "Build",
            stepIndex: 0,
            policy: {
              claimScopes: [{ scopeKind: "lane", scopeValue: `lane:${fixture.laneId}`, ttlMs: 60_000 }]
            }
          },
          {
            stepKey: "test",
            title: "Test",
            stepIndex: 1,
            policy: {
              claimScopes: [{ scopeKind: "lane", scopeValue: `lane:${fixture.laneId}`, ttlMs: 60_000 }]
            }
          }
        ]
      });
      const [firstStep, secondStep] = fixture.service.listSteps(started.run.id);

      const firstAttempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId: firstStep!.id,
        ownerId: "owner-a"
      });
      expect(firstAttempt.status).toBe("running");

      const secondAttempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId: secondStep!.id,
        ownerId: "owner-b"
      });
      expect(secondAttempt.status).toBe("blocked");
      expect(secondAttempt.errorClass).toBe("claim_conflict");

      const activeClaims = fixture.service.listClaims({ runId: started.run.id, state: "active" });
      expect(activeClaims).toHaveLength(1);
      expect(activeClaims[0]?.scopeValue).toBe(`lane:${fixture.laneId}`);
    } finally {
      fixture.dispose();
    }
  });

  it("recovers running attempts into deterministic resume path", async () => {
    const fixture = await createFixture();
    try {
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [
          {
            stepKey: "apply",
            title: "Apply patch",
            stepIndex: 0,
            retryLimit: 1
          }
        ]
      });
      const step = fixture.service.listSteps(started.run.id)[0];
      expect(step?.status).toBe("ready");
      if (!step) throw new Error("Missing step");

      const attempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId: step.id,
        ownerId: "owner"
      });
      expect(attempt.status).toBe("running");

      const resumed = fixture.service.resumeRun({ runId: started.run.id });
      expect(resumed.status).toBe("running");

      const attempts = fixture.service.listAttempts({ runId: started.run.id });
      const recovered = attempts.find((entry) => entry.id === attempt.id);
      expect(recovered?.status).toBe("failed");
      expect(recovered?.errorClass).toBe("resume_recovered");

      const updatedStep = fixture.service.listSteps(started.run.id)[0];
      expect(updatedStep?.status).toBe("ready");

      const handoff = fixture.service
        .listHandoffs({ runId: started.run.id })
        .find((entry) => entry.attemptId === attempt.id && entry.handoffType === "attempt_recovered_after_restart");
      expect(handoff).toBeTruthy();
    } finally {
      fixture.dispose();
    }
  });

  it("uses deterministic-by-default profile and supports explicit narrative opt-in profile", async () => {
    const fixture = await createFixture();
    try {
      const deterministic = fixture.service.getContextProfile("orchestrator_deterministic_v1");
      const narrative = fixture.service.getContextProfile("orchestrator_narrative_opt_in_v1");
      expect(deterministic.includeNarrative).toBe(false);
      expect(narrative.includeNarrative).toBe(true);

      const defaultRun = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [
          {
            stepKey: "default-step",
            title: "Default step",
            stepIndex: 0,
            policy: {
              includeFullDocs: true
            }
          }
        ]
      });
      const defaultStep = fixture.service.listSteps(defaultRun.run.id)[0];
      if (!defaultStep) throw new Error("Missing default step");
      const defaultAttempt = await fixture.service.startAttempt({
        runId: defaultRun.run.id,
        stepId: defaultStep.id,
        ownerId: "owner-default"
      });
      expect(defaultAttempt.contextProfile).toBe("orchestrator_deterministic_v1");

      const defaultStartHandoff = fixture.service
        .listHandoffs({ runId: defaultRun.run.id })
        .find((entry) => entry.handoffType === "attempt_started" && entry.attemptId === defaultAttempt.id);
      expect(defaultStartHandoff?.payload?.docsMode).toBe("full_docs");

      const optInRun = fixture.service.startRun({
        missionId: fixture.missionId,
        contextProfile: "orchestrator_narrative_opt_in_v1",
        steps: [
          {
            stepKey: "optin-step",
            title: "Opt-in step",
            stepIndex: 0
          }
        ]
      });
      const optInStep = fixture.service.listSteps(optInRun.run.id)[0];
      if (!optInStep) throw new Error("Missing opt-in step");
      const optInAttempt = await fixture.service.startAttempt({
        runId: optInRun.run.id,
        stepId: optInStep.id,
        ownerId: "owner-optin"
      });
      expect(optInAttempt.contextProfile).toBe("orchestrator_narrative_opt_in_v1");
    } finally {
      fixture.dispose();
    }
  });
});
