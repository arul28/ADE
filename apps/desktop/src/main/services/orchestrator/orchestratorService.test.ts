import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PackDeltaDigestV1, PackExport, PackType } from "../../../shared/types";
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

async function createFixture(args: {
  conflictService?: any;
  packService?: Record<string, unknown>;
} = {}) {
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
    packService: {
      ...packService,
      ...(args.packService ?? {})
    } as any,
    conflictService: args.conflictService,
    ptyService
  });

  return {
    db,
    service,
    projectId,
    projectRoot,
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

  it("supports deterministic DAG join semantics (all_success, any_success, quorum)", async () => {
    const fixture = await createFixture();
    try {
      const anyRun = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [
          { stepKey: "a", title: "A", stepIndex: 0 },
          { stepKey: "b", title: "B", stepIndex: 1 },
          {
            stepKey: "join-any",
            title: "Join Any",
            stepIndex: 2,
            dependencyStepKeys: ["a", "b"],
            joinPolicy: "any_success"
          }
        ]
      });
      const [aAny, bAny, joinAny] = fixture.service.listSteps(anyRun.run.id);
      if (!aAny || !bAny || !joinAny) throw new Error("Missing steps for any_success run");
      const aAnyAttempt = await fixture.service.startAttempt({ runId: anyRun.run.id, stepId: aAny.id, ownerId: "owner" });
      fixture.service.completeAttempt({
        attemptId: aAnyAttempt.id,
        status: "failed",
        errorClass: "deterministic",
        errorMessage: "deterministic failure"
      });
      const bAnyAttempt = await fixture.service.startAttempt({ runId: anyRun.run.id, stepId: bAny.id, ownerId: "owner" });
      fixture.service.completeAttempt({ attemptId: bAnyAttempt.id, status: "succeeded" });
      const joinAnyStep = fixture.service.listSteps(anyRun.run.id).find((step) => step.id === joinAny.id);
      expect(joinAnyStep?.status).toBe("ready");

      const allRun = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [
          { stepKey: "a", title: "A", stepIndex: 0 },
          { stepKey: "b", title: "B", stepIndex: 1 },
          {
            stepKey: "join-all",
            title: "Join All",
            stepIndex: 2,
            dependencyStepKeys: ["a", "b"],
            joinPolicy: "all_success"
          }
        ]
      });
      const [aAll, bAll, joinAll] = fixture.service.listSteps(allRun.run.id);
      if (!aAll || !bAll || !joinAll) throw new Error("Missing steps for all_success run");
      const aAllAttempt = await fixture.service.startAttempt({ runId: allRun.run.id, stepId: aAll.id, ownerId: "owner" });
      fixture.service.completeAttempt({
        attemptId: aAllAttempt.id,
        status: "failed",
        errorClass: "deterministic",
        errorMessage: "deterministic failure"
      });
      const bAllAttempt = await fixture.service.startAttempt({ runId: allRun.run.id, stepId: bAll.id, ownerId: "owner" });
      fixture.service.completeAttempt({ attemptId: bAllAttempt.id, status: "succeeded" });
      const joinAllStep = fixture.service.listSteps(allRun.run.id).find((step) => step.id === joinAll.id);
      expect(joinAllStep?.status).toBe("blocked");

      const quorumRun = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [
          { stepKey: "a", title: "A", stepIndex: 0 },
          { stepKey: "b", title: "B", stepIndex: 1 },
          { stepKey: "c", title: "C", stepIndex: 2 },
          {
            stepKey: "join-quorum",
            title: "Join Quorum",
            stepIndex: 3,
            dependencyStepKeys: ["a", "b", "c"],
            joinPolicy: "quorum",
            quorumCount: 2
          }
        ]
      });
      const [aQ, bQ, cQ, joinQ] = fixture.service.listSteps(quorumRun.run.id);
      if (!aQ || !bQ || !cQ || !joinQ) throw new Error("Missing steps for quorum run");
      const aQAttempt = await fixture.service.startAttempt({ runId: quorumRun.run.id, stepId: aQ.id, ownerId: "owner" });
      fixture.service.completeAttempt({ attemptId: aQAttempt.id, status: "succeeded" });
      const bQAttempt = await fixture.service.startAttempt({ runId: quorumRun.run.id, stepId: bQ.id, ownerId: "owner" });
      fixture.service.completeAttempt({ attemptId: bQAttempt.id, status: "succeeded" });
      const cQAttempt = await fixture.service.startAttempt({ runId: quorumRun.run.id, stepId: cQ.id, ownerId: "owner" });
      fixture.service.completeAttempt({
        attemptId: cQAttempt.id,
        status: "failed",
        errorClass: "deterministic",
        errorMessage: "deterministic failure"
      });
      const joinQuorumStep = fixture.service.listSteps(quorumRun.run.id).find((step) => step.id === joinQ.id);
      expect(joinQuorumStep?.status).toBe("ready");
    } finally {
      fixture.dispose();
    }
  });

  it("maps mission planner metadata into deterministic run graph and autopilot metadata", async () => {
    const fixture = await createFixture();
    try {
      const now = "2026-02-19T00:00:00.000Z";
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
            ('mstep-1', ?, ?, 0, 'Branch A', null, 'implementation', ?, 'pending', '{"stepType":"implementation"}', ?, ?, null, null),
            ('mstep-2', ?, ?, 1, 'Branch B', null, 'implementation', ?, 'pending', '{"stepType":"implementation"}', ?, ?, null, null),
            ('mstep-3', ?, ?, 2, 'Join', null, 'integration', ?, 'pending', '{"stepType":"integration","dependencyIndices":[0,1],"joinPolicy":"quorum","quorumCount":1}', ?, ?, null, null)
        `,
        [
          fixture.missionId,
          fixture.projectId,
          fixture.laneId,
          now,
          now,
          fixture.missionId,
          fixture.projectId,
          fixture.laneId,
          now,
          now,
          fixture.missionId,
          fixture.projectId,
          fixture.laneId,
          now,
          now
        ]
      );

      const started = fixture.service.startRunFromMission({
        missionId: fixture.missionId,
        runMode: "autopilot",
        defaultExecutorKind: "codex"
      });

      const run = fixture.service.listRuns({ missionId: fixture.missionId })[0];
      expect(run?.metadata?.runMode).toBe("autopilot");
      const autopilot = run?.metadata?.autopilot as Record<string, unknown> | undefined;
      expect(autopilot?.enabled).toBe(true);
      expect(autopilot?.executorKind).toBe("codex");

      const steps = fixture.service.listSteps(started.run.id);
      const join = steps.find((step) => step.missionStepId === "mstep-3");
      expect(join?.joinPolicy).toBe("quorum");
      expect(join?.quorumCount).toBe(1);
      expect(join?.dependencyStepIds.length).toBe(2);
    } finally {
      fixture.dispose();
    }
  });

  it("applies deterministic retry/backoff scheduling before retrying", async () => {
    const fixture = await createFixture();
    try {
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [{ stepKey: "retryable", title: "Retryable", stepIndex: 0, retryLimit: 2 }]
      });
      const step = fixture.service.listSteps(started.run.id)[0];
      if (!step) throw new Error("Missing step");

      const attempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId: step.id,
        ownerId: "owner"
      });
      fixture.service.completeAttempt({
        attemptId: attempt.id,
        status: "failed",
        errorClass: "transient",
        errorMessage: "transient failure",
        retryBackoffMs: 15_000
      });

      const afterFailure = fixture.service.listSteps(started.run.id)[0];
      expect(afterFailure?.status).toBe("pending");
      expect(Number((afterFailure?.metadata?.lastRetryBackoffMs as number | undefined) ?? 0)).toBe(15_000);

      fixture.db.run(
        `
          update orchestrator_steps
          set metadata_json = ?,
              updated_at = ?
          where id = ?
            and project_id = ?
        `,
        [
          JSON.stringify({
            ...(afterFailure?.metadata ?? {}),
            nextRetryAt: "2000-01-01T00:00:00.000Z"
          }),
          new Date().toISOString(),
          step.id,
          fixture.projectId
        ]
      );
      fixture.service.tick({ runId: started.run.id });
      const retryReady = fixture.service.listSteps(started.run.id)[0];
      expect(retryReady?.status).toBe("ready");
    } finally {
      fixture.dispose();
    }
  });

  it("supports claim heartbeat and expiry recovery for blocked collision steps", async () => {
    const fixture = await createFixture();
    try {
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [
          {
            stepKey: "one",
            title: "One",
            stepIndex: 0,
            policy: {
              claimScopes: [{ scopeKind: "lane", scopeValue: `lane:${fixture.laneId}`, ttlMs: 60_000 }]
            }
          },
          {
            stepKey: "two",
            title: "Two",
            stepIndex: 1,
            policy: {
              claimScopes: [{ scopeKind: "lane", scopeValue: `lane:${fixture.laneId}`, ttlMs: 60_000 }]
            }
          }
        ]
      });
      const [one, two] = fixture.service.listSteps(started.run.id);
      if (!one || !two) throw new Error("Missing steps");

      const firstAttempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId: one.id,
        ownerId: "owner-a"
      });
      const beats = fixture.service.heartbeatClaims({ attemptId: firstAttempt.id, ownerId: "owner-a" });
      expect(beats).toBe(1);

      const blockedAttempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId: two.id,
        ownerId: "owner-b"
      });
      expect(blockedAttempt.status).toBe("blocked");

      fixture.db.run(
        `
          update orchestrator_claims
          set expires_at = ?
          where attempt_id = ?
        `,
        ["2000-01-01T00:00:00.000Z", firstAttempt.id]
      );
      fixture.service.tick({ runId: started.run.id });
      const recoveredStep = fixture.service.listSteps(started.run.id).find((step) => step.id === two.id);
      expect(recoveredStep?.status).toBe("ready");
    } finally {
      fixture.dispose();
    }
  });

  it("reconciles tracked session exits and auto-advances autopilot", async () => {
    const fixture = await createFixture();
    try {
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        metadata: {
          autopilot: {
            enabled: true,
            executorKind: "codex",
            ownerId: "orchestrator-autopilot"
          }
        },
        steps: [
          {
            stepKey: "first",
            title: "First",
            stepIndex: 0,
            laneId: fixture.laneId,
            executorKind: "codex"
          },
          {
            stepKey: "second",
            title: "Second",
            stepIndex: 1,
            dependencyStepKeys: ["first"],
            laneId: fixture.laneId,
            executorKind: "codex"
          }
        ]
      });

      const firstStepId = fixture.service.listSteps(started.run.id)[0]?.id;
      if (!firstStepId) throw new Error("Expected first step");
      const firstAttempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId: firstStepId,
        ownerId: "operator"
      });
      expect(firstAttempt?.status).toBe("running");
      expect(firstAttempt?.executorSessionId).toBeTruthy();
      if (!firstAttempt?.executorSessionId) throw new Error("Expected running session-backed attempt");

      const reconciled = await fixture.service.onTrackedSessionEnded({
        sessionId: firstAttempt.executorSessionId,
        laneId: fixture.laneId,
        exitCode: 0
      });
      expect(reconciled).toBe(1);

      const after = fixture.service.listAttempts({ runId: started.run.id });
      const firstAfter = after.find((attempt) => attempt.id === firstAttempt.id);
      expect(firstAfter?.status).toBe("succeeded");

      const secondStepId = fixture.service.listSteps(started.run.id).find((step) => step.stepKey === "second")?.id;
      const secondAttempt = after.find((attempt) => attempt.stepId === secondStepId);
      expect(secondAttempt?.status).toBe("running");
    } finally {
      fixture.dispose();
    }
  });

  it("records docs truncation and context provenance metadata in snapshots", async () => {
    const fixture = await createFixture();
    try {
      const docsRoot = path.join(fixture.projectRoot, "docs", "architecture");
      fs.mkdirSync(docsRoot, { recursive: true });
      fs.writeFileSync(path.join(docsRoot, "HUGE.md"), "x".repeat(20_000), "utf8");

      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [
          {
            stepKey: "docs",
            title: "Docs",
            stepIndex: 0,
            policy: {
              includeFullDocs: true,
              docsMaxBytes: 64
            }
          }
        ]
      });
      const step = fixture.service.listSteps(started.run.id)[0];
      if (!step) throw new Error("Missing step");
      const attempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId: step.id,
        ownerId: "owner-docs"
      });
      expect(attempt.contextSnapshotId).toBeTruthy();
      const snapshot = fixture.service
        .listContextSnapshots({ runId: started.run.id })
        .find((entry) => entry.id === attempt.contextSnapshotId);
      expect(snapshot?.cursor.docsMode).toBe("full_body");
      expect((snapshot?.cursor.docsTruncatedCount ?? 0) >= 1).toBe(true);
      expect((snapshot?.cursor.docsConsumedBytes ?? 0) <= 64).toBe(true);
    } finally {
      fixture.dispose();
    }
  });

  it("bootstraps lane pack refresh when context snapshot sees empty lane pack", async () => {
    let laneExportCalls = 0;
    let laneRefreshCalls = 0;
    const fixture = await createFixture({
      packService: {
        getLaneExport: async ({ laneId, level }: { laneId: string; level: "lite" | "standard" | "deep" }) => {
          laneExportCalls += 1;
          if (laneExportCalls === 1) {
            throw new Error("Lane pack is empty. Refresh deterministic packs first.");
          }
          return buildExport(`lane:${laneId}`, "lane", level);
        },
        refreshLanePack: async () => {
          laneRefreshCalls += 1;
          return {} as any;
        }
      }
    });
    try {
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [{ stepKey: "bootstrap-pack", title: "Bootstrap pack", stepIndex: 0, laneId: fixture.laneId }]
      });
      const step = fixture.service.listSteps(started.run.id)[0];
      if (!step) throw new Error("Missing step");
      const attempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId: step.id,
        ownerId: "owner"
      });
      expect(attempt.contextSnapshotId).toBeTruthy();
      expect(laneRefreshCalls).toBe(1);
      expect(laneExportCalls).toBeGreaterThanOrEqual(2);
    } finally {
      fixture.dispose();
    }
  });

  it("normalizes adapter envelopes and supports deterministic integration chain blocking", async () => {
    const conflictService = {
      prepareResolverSession: async () => ({
        runId: "resolver-1",
        promptFilePath: "/tmp/prompt.md",
        cwdWorktreePath: "/tmp/worktree",
        cwdLaneId: "lane-1",
        integrationLaneId: "lane-integration",
        warnings: [],
        contextGaps: [],
        status: "ready" as const
      })
    };
    const fixture = await createFixture({
      conflictService
    });
    try {
      fixture.service.registerExecutorAdapter({
        kind: "claude",
        start: async () => ({
          status: "completed",
          result: {
            success: true,
            summary: "adapter completed",
            warnings: "not-array"
          } as any
        })
      });

      const adapterRun = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [
          {
            stepKey: "adapter",
            title: "Adapter Step",
            stepIndex: 0,
            executorKind: "claude"
          }
        ]
      });
      const adapterStep = fixture.service.listSteps(adapterRun.run.id)[0];
      if (!adapterStep) throw new Error("Missing adapter step");
      const adapterAttempt = await fixture.service.startAttempt({
        runId: adapterRun.run.id,
        stepId: adapterStep.id,
        ownerId: "owner"
      });
      expect(adapterAttempt.status).toBe("succeeded");
      expect(adapterAttempt.resultEnvelope?.schema).toBe("ade.orchestratorAttempt.v1");
      expect(Array.isArray(adapterAttempt.resultEnvelope?.warnings)).toBe(true);

      const integrationRun = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [
          {
            stepKey: "integration",
            title: "Integration",
            stepIndex: 0,
            metadata: {
              integrationFlow: true,
              targetLaneId: "lane-target",
              sourceLaneIds: ["lane-source"]
            }
          }
        ]
      });
      const integrationStep = fixture.service.listSteps(integrationRun.run.id)[0];
      if (!integrationStep) throw new Error("Missing integration step");
      const integrationAttempt = await fixture.service.startAttempt({
        runId: integrationRun.run.id,
        stepId: integrationStep.id,
        ownerId: "owner"
      });
      expect(integrationAttempt.status).toBe("blocked");
      expect(integrationAttempt.errorClass).toBe("policy");
      const timeline = fixture.service.listTimeline({ runId: integrationRun.run.id, limit: 50 });
      expect(timeline.some((entry) => entry.eventType === "integration_chain_stage")).toBe(true);
    } finally {
      fixture.dispose();
    }
  });

  it("evaluates and persists gate reports with deterministic thresholds", async () => {
    const fixture = await createFixture();
    try {
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [{ stepKey: "gate-step", title: "Gate Step", stepIndex: 0 }]
      });
      const step = fixture.service.listSteps(started.run.id)[0];
      if (!step) throw new Error("Missing step");
      const attempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId: step.id,
        ownerId: "owner"
      });
      fixture.service.completeAttempt({
        attemptId: attempt.id,
        status: "blocked",
        errorClass: "policy",
        errorMessage: "insufficient_context:missing_pack"
      });

      const report = fixture.service.getLatestGateReport({ refresh: true });
      expect(report.generatedBy).toBe("deterministic_kernel");
      expect(report.gates.length).toBe(4);
      const blockedGate = report.gates.find((gate) => gate.key === "blocked_run_rate_insufficient_context");
      expect(blockedGate?.status).toBe("fail");
      expect((blockedGate?.metadata?.reasonCodes as string[] | undefined)?.some((reason) => reason.includes("insufficient_context"))).toBe(
        true
      );

      const persisted = fixture.service.getLatestGateReport();
      expect(persisted.id).toBe(report.id);
    } finally {
      fixture.dispose();
    }
  });
});
