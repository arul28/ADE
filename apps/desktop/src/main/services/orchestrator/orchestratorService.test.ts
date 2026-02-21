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
  projectConfigService?: Record<string, unknown> | null;
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
    ptyService,
    projectConfigService: (args.projectConfigService ?? null) as any
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

  it("enforces fan-out/fan-in ordering before a final manual review gate", async () => {
    const fixture = await createFixture();
    try {
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [
          {
            stepKey: "api",
            title: "Implement API slice",
            stepIndex: 0,
            executorKind: "manual"
          },
          {
            stepKey: "ui",
            title: "Implement UI slice",
            stepIndex: 1,
            executorKind: "manual"
          },
          {
            stepKey: "integrate",
            title: "Integrate outputs",
            stepIndex: 2,
            dependencyStepKeys: ["api", "ui"],
            joinPolicy: "all_success",
            executorKind: "manual"
          },
          {
            stepKey: "final-review",
            title: "Final human review",
            stepIndex: 3,
            dependencyStepKeys: ["integrate"],
            executorKind: "manual"
          }
        ]
      });

      let [apiStep, uiStep, integrateStep, finalReviewStep] = fixture.service.listSteps(started.run.id);
      if (!apiStep || !uiStep || !integrateStep || !finalReviewStep) throw new Error("Missing expected steps");
      expect(apiStep.status).toBe("ready");
      expect(uiStep.status).toBe("ready");
      expect(["pending", "blocked"]).toContain(integrateStep.status);
      expect(["pending", "blocked"]).toContain(finalReviewStep.status);

      const apiAttempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId: apiStep.id,
        ownerId: "owner-api",
        executorKind: "manual"
      });
      fixture.service.completeAttempt({ attemptId: apiAttempt.id, status: "succeeded" });

      [apiStep, uiStep, integrateStep, finalReviewStep] = fixture.service.listSteps(started.run.id);
      expect(apiStep.status).toBe("succeeded");
      expect(uiStep.status).toBe("ready");
      expect(["pending", "blocked"]).toContain(integrateStep.status);
      expect(["pending", "blocked"]).toContain(finalReviewStep.status);

      const uiAttempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId: uiStep.id,
        ownerId: "owner-ui",
        executorKind: "manual"
      });
      fixture.service.completeAttempt({ attemptId: uiAttempt.id, status: "succeeded" });

      [apiStep, uiStep, integrateStep, finalReviewStep] = fixture.service.listSteps(started.run.id);
      expect(integrateStep.status).toBe("ready");
      expect(["pending", "blocked"]).toContain(finalReviewStep.status);

      const integrateAttempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId: integrateStep.id,
        ownerId: "owner-integrate",
        executorKind: "manual"
      });
      fixture.service.completeAttempt({ attemptId: integrateAttempt.id, status: "succeeded" });

      [apiStep, uiStep, integrateStep, finalReviewStep] = fixture.service.listSteps(started.run.id);
      expect(integrateStep.status).toBe("succeeded");
      expect(finalReviewStep.status).toBe("ready");

      const reviewAttempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId: finalReviewStep.id,
        ownerId: "owner-review",
        executorKind: "manual"
      });
      fixture.service.completeAttempt({ attemptId: reviewAttempt.id, status: "succeeded" });

      const run = fixture.service.listRuns({ missionId: fixture.missionId }).find((entry) => entry.id === started.run.id);
      expect(run?.status).toBe("succeeded");
    } finally {
      fixture.dispose();
    }
  });

  it("rejects invalid step graphs at run start (unknown dependencies + cycles)", async () => {
    const fixture = await createFixture();
    try {
      expect(() =>
        fixture.service.startRun({
          missionId: fixture.missionId,
          steps: [
            {
              stepKey: "compile",
              title: "Compile",
              stepIndex: 0
            },
            {
              stepKey: "verify",
              title: "Verify",
              stepIndex: 1,
              dependencyStepKeys: ["missing_step"]
            }
          ]
        })
      ).toThrow(/unknown dependency/i);
      expect(fixture.service.listRuns({ missionId: fixture.missionId })).toHaveLength(0);

      expect(() =>
        fixture.service.startRun({
          missionId: fixture.missionId,
          steps: [
            {
              stepKey: "a",
              title: "A",
              stepIndex: 0,
              dependencyStepKeys: ["b"]
            },
            {
              stepKey: "b",
              title: "B",
              stepIndex: 1,
              dependencyStepKeys: ["a"]
            }
          ]
        })
      ).toThrow(/dependency cycle/i);
      expect(fixture.service.listRuns({ missionId: fixture.missionId })).toHaveLength(0);
    } finally {
      fixture.dispose();
    }
  });

  it("maps mission planner metadata into deterministic run graph and autopilot metadata", async () => {
    const fixture = await createFixture({
      projectConfigService: {
        get: () => ({
          effective: {
            ai: {
              orchestrator: {
                maxParallelWorkers: 2
              }
            }
          }
        })
      }
    });
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
        defaultExecutorKind: "codex",
        metadata: {
          plannerParallelismCap: 6
        }
      });

      const run = fixture.service.listRuns({ missionId: fixture.missionId })[0];
      expect(run?.metadata?.runMode).toBe("autopilot");
      const autopilot = run?.metadata?.autopilot as Record<string, unknown> | undefined;
      expect(autopilot?.enabled).toBe(true);
      expect(autopilot?.executorKind).toBe("codex");
      expect(autopilot?.parallelismCap).toBe(2);
      const planner = run?.metadata?.planner as Record<string, unknown> | undefined;
      expect(planner?.parallelismCap).toBe(2);

      const steps = fixture.service.listSteps(started.run.id);
      const join = steps.find((step) => step.missionStepId === "mstep-3");
      expect(join?.joinPolicy).toBe("quorum");
      expect(join?.quorumCount).toBe(1);
      expect(join?.dependencyStepIds.length).toBe(2);
    } finally {
      fixture.dispose();
    }
  });

  it("preserves explicit empty mission-step dependencies instead of forcing sequential fallback", async () => {
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
            ('mstep-empty-1', ?, ?, 0, 'Implement API', 'Add endpoint', 'implementation', ?, 'pending', '{"stepType":"implementation","dependencyStepKeys":[]}', ?, ?, null, null),
            ('mstep-empty-2', ?, ?, 1, 'Update docs', 'Update README', 'docs', ?, 'pending', '{"stepType":"docs","dependencyStepKeys":[]}', ?, ?, null, null)
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
          now
        ]
      );

      const started = fixture.service.startRunFromMission({
        missionId: fixture.missionId,
        runMode: "manual",
        defaultExecutorKind: "manual"
      });

      const steps = fixture.service.listSteps(started.run.id);
      const docsStep = steps.find((step) => step.missionStepId === "mstep-empty-2");
      expect(docsStep).toBeTruthy();
      expect(docsStep?.dependencyStepIds).toHaveLength(0);
    } finally {
      fixture.dispose();
    }
  });

  it("derives integration lane metadata from dependency lanes when missing", async () => {
    const fixture = await createFixture();
    try {
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
          ) values
            (?, ?, 'Child A', null, 'worktree', 'main', 'feature/child-a', ?, null, 0, ?, null, null, null, 'active', ?, null),
            (?, ?, 'Child B', null, 'worktree', 'main', 'feature/child-b', ?, null, 0, ?, null, null, null, 'active', ?, null)
        `,
        [
          "lane-child-a",
          fixture.projectId,
          fixture.projectRoot,
          fixture.laneId,
          now,
          "lane-child-b",
          fixture.projectId,
          fixture.projectRoot,
          fixture.laneId,
          now
        ]
      );

      fixture.db.run(`delete from mission_steps where mission_id = ?`, [fixture.missionId]);
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
            ('mstep-int-1', ?, ?, 0, 'Root A', 'A', 'implementation', ?, 'pending', '{"stepKey":"root-a","stepType":"implementation","dependencyStepKeys":[]}', ?, ?, null, null),
            ('mstep-int-2', ?, ?, 1, 'Root B', 'B', 'implementation', ?, 'pending', '{"stepKey":"root-b","stepType":"implementation","dependencyStepKeys":[]}', ?, ?, null, null),
            ('mstep-int-3', ?, ?, 2, 'Root C', 'C', 'implementation', ?, 'pending', '{"stepKey":"root-c","stepType":"implementation","dependencyStepKeys":[]}', ?, ?, null, null),
            ('mstep-int-4', ?, ?, 3, 'Integrate', 'join', 'integration', ?, 'pending', '{"stepKey":"join","stepType":"integration","dependencyStepKeys":["root-a","root-b","root-c"]}', ?, ?, null, null)
        `,
        [
          fixture.missionId,
          fixture.projectId,
          fixture.laneId,
          now,
          now,
          fixture.missionId,
          fixture.projectId,
          "lane-child-a",
          now,
          now,
          fixture.missionId,
          fixture.projectId,
          "lane-child-b",
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
        runMode: "manual",
        defaultExecutorKind: "manual"
      });

      const steps = fixture.service.listSteps(started.run.id);
      const join = steps.find((step) => step.missionStepId === "mstep-int-4");
      expect(join).toBeTruthy();
      expect(join?.metadata?.targetLaneId).toBe(fixture.laneId);
      const sourceLaneIds = Array.isArray(join?.metadata?.sourceLaneIds) ? join?.metadata?.sourceLaneIds : [];
      expect(sourceLaneIds).toContain("lane-child-a");
      expect(sourceLaneIds).toContain("lane-child-b");
    } finally {
      fixture.dispose();
    }
  });

  it("keeps policy-blocked steps blocked until explicit intervention", async () => {
    const fixture = await createFixture();
    try {
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [
          {
            stepKey: "blocked_policy",
            title: "Blocked Policy",
            stepIndex: 0
          }
        ]
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
        errorMessage: "Blocked by missing integration metadata."
      });

      fixture.service.tick({ runId: started.run.id });
      const refreshed = fixture.service.listSteps(started.run.id).find((entry) => entry.id === step.id);
      expect(refreshed?.status).toBe("blocked");
      expect(refreshed?.metadata?.blockedSticky).toBe(true);
    } finally {
      fixture.dispose();
    }
  });

  it("propagates sticky policy blocks to downstream dependencies and pauses the run", async () => {
    const fixture = await createFixture();
    try {
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [
          {
            stepKey: "integration_gate",
            title: "Integration Gate",
            stepIndex: 0
          },
          {
            stepKey: "downstream_validation",
            title: "Downstream Validation",
            stepIndex: 1,
            dependencyStepKeys: ["integration_gate"]
          }
        ]
      });
      const [integrationStep, downstreamStep] = fixture.service.listSteps(started.run.id);
      if (!integrationStep || !downstreamStep) throw new Error("Expected two orchestrator steps");

      const attempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId: integrationStep.id,
        ownerId: "owner"
      });
      fixture.service.completeAttempt({
        attemptId: attempt.id,
        status: "blocked",
        errorClass: "policy",
        errorMessage: "Manual intervention required."
      });

      const graph = fixture.service.getRunGraph({ runId: started.run.id, timelineLimit: 0 });
      const refreshedIntegration = graph.steps.find((step) => step.id === integrationStep.id);
      const refreshedDownstream = graph.steps.find((step) => step.id === downstreamStep.id);
      expect(refreshedIntegration?.status).toBe("blocked");
      expect(refreshedDownstream?.status).toBe("blocked");
      expect(graph.run.status).toBe("paused");
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

  it("recovers from retryable failure and succeeds on deterministic retry", async () => {
    const fixture = await createFixture();
    try {
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [{ stepKey: "retry-once", title: "Retry Once", stepIndex: 0, retryLimit: 1 }]
      });
      const step = fixture.service.listSteps(started.run.id)[0];
      if (!step) throw new Error("Missing step");

      const first = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId: step.id,
        ownerId: "owner"
      });
      fixture.service.completeAttempt({
        attemptId: first.id,
        status: "failed",
        errorClass: "transient",
        errorMessage: "temporary outage",
        retryBackoffMs: 0
      });

      fixture.service.tick({ runId: started.run.id });
      const readyAgain = fixture.service.listSteps(started.run.id)[0];
      expect(readyAgain?.status).toBe("ready");
      expect(readyAgain?.retryCount).toBe(1);

      const second = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId: step.id,
        ownerId: "owner"
      });
      fixture.service.completeAttempt({
        attemptId: second.id,
        status: "succeeded"
      });

      const finalGraph = fixture.service.getRunGraph({ runId: started.run.id, timelineLimit: 0 });
      const finalStep = finalGraph.steps.find((entry) => entry.id === step.id);
      expect(finalStep?.status).toBe("succeeded");
      expect(finalGraph.run.status).toBe("succeeded");
    } finally {
      fixture.dispose();
    }
  });

  it("marks step failed after retry exhaustion", async () => {
    const fixture = await createFixture();
    try {
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [{ stepKey: "exhaust", title: "Exhaust Retries", stepIndex: 0, retryLimit: 1 }]
      });
      const step = fixture.service.listSteps(started.run.id)[0];
      if (!step) throw new Error("Missing step");

      const first = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId: step.id,
        ownerId: "owner"
      });
      fixture.service.completeAttempt({
        attemptId: first.id,
        status: "failed",
        errorClass: "transient",
        errorMessage: "attempt one",
        retryBackoffMs: 0
      });
      fixture.service.tick({ runId: started.run.id });

      const second = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId: step.id,
        ownerId: "owner"
      });
      fixture.service.completeAttempt({
        attemptId: second.id,
        status: "failed",
        errorClass: "transient",
        errorMessage: "attempt two"
      });

      const graph = fixture.service.getRunGraph({ runId: started.run.id, timelineLimit: 0 });
      const finalStep = graph.steps.find((entry) => entry.id === step.id);
      expect(finalStep?.status).toBe("failed");
      expect(finalStep?.retryCount).toBe(1);
      expect(graph.run.status).toBe("failed");
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

  it("derives tracked-session completion status from terminal session state when exit code is missing", async () => {
    const fixture = await createFixture();
    try {
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [
          {
            stepKey: "first",
            title: "First",
            stepIndex: 0,
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
      if (!firstAttempt.executorSessionId) throw new Error("Expected running session-backed attempt");

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
          ) values (?, ?, null, 1, 'Worker', ?, ?, null, ?, null, null, 'completed', null, null, 'codex-orchestrated', null)
        `,
        [
          firstAttempt.executorSessionId,
          fixture.laneId,
          "2026-02-20T00:00:00.000Z",
          "2026-02-20T00:05:00.000Z",
          path.join(fixture.projectRoot, ".ade", "transcripts", `${firstAttempt.executorSessionId}.log`)
        ]
      );

      const reconciled = await fixture.service.onTrackedSessionEnded({
        sessionId: firstAttempt.executorSessionId,
        laneId: fixture.laneId,
        exitCode: null
      });
      expect(reconciled).toBe(1);

      const after = fixture.service.listAttempts({ runId: started.run.id });
      const refreshed = after.find((attempt) => attempt.id === firstAttempt.id);
      expect(refreshed?.status).toBe("succeeded");
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

  it("summarizes older mission handoffs in context snapshots to limit context bloat", async () => {
    const fixture = await createFixture();
    try {
      const now = "2026-02-20T00:00:00.000Z";
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
          ) values ('mstep-handoff', ?, ?, 0, 'Implement', null, 'implementation', ?, 'pending', '{"stepType":"implementation"}', ?, ?, null, null)
        `,
        [fixture.missionId, fixture.projectId, fixture.laneId, now, now]
      );

      for (let index = 0; index < 20; index += 1) {
        fixture.db.run(
          `
            insert into mission_step_handoffs(
              id,
              project_id,
              mission_id,
              mission_step_id,
              run_id,
              step_id,
              attempt_id,
              handoff_type,
              producer,
              payload_json,
              created_at
            ) values (?, ?, ?, ?, null, null, null, ?, 'orchestrator', ?, ?)
          `,
          [
            `handoff-${index}`,
            fixture.projectId,
            fixture.missionId,
            "mstep-handoff",
            index % 2 === 0 ? "attempt_succeeded" : "attempt_failed",
            JSON.stringify({ index }),
            new Date(Date.parse(now) + index * 1_000).toISOString()
          ]
        );
      }

      const started = fixture.service.startRunFromMission({
        missionId: fixture.missionId,
        runMode: "manual",
        defaultExecutorKind: "manual"
      });
      const step = fixture.service.listSteps(started.run.id)[0];
      if (!step) throw new Error("Missing step");
      const attempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId: step.id,
        ownerId: "owner-handoff",
        executorKind: "manual"
      });
      const snapshot = fixture.service
        .listContextSnapshots({ runId: started.run.id })
        .find((entry) => entry.id === attempt.contextSnapshotId);
      expect(snapshot?.cursor.missionHandoffIds?.length).toBe(12);
      expect(snapshot?.cursor.missionHandoffDigest?.summarizedCount).toBe(8);
      expect(snapshot?.cursor.missionHandoffDigest?.byType?.attempt_failed).toBeGreaterThan(0);
      expect(snapshot?.cursor.missionHandoffDigest?.byType?.attempt_succeeded).toBeGreaterThan(0);
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

  it("enforces total budget limit in startAttempt", async () => {
    const fixture = await createFixture({
      projectConfigService: {
        get: () => ({
          effective: {
            ai: {
              orchestrator: {
                maxTotalTokenBudget: 50_000
              }
            }
          }
        })
      }
    });
    try {
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        metadata: { tokensConsumed: 60_000 },
        steps: [{ stepKey: "expensive", title: "Expensive", stepIndex: 0 }]
      });
      const step = fixture.service.listSteps(started.run.id)[0];
      if (!step) throw new Error("Missing step");

      await expect(
        fixture.service.startAttempt({
          runId: started.run.id,
          stepId: step.id,
          ownerId: "owner"
        })
      ).rejects.toThrow(/budget exceeded/i);

      const runs = fixture.service.listRuns({ missionId: fixture.missionId });
      const run = runs.find((r) => r.id === started.run.id);
      expect(run?.status).toBe("paused");

      const timeline = fixture.service.listTimeline({ runId: started.run.id, limit: 50 });
      expect(timeline.some((e) => e.eventType === "budget_exceeded")).toBe(true);
    } finally {
      fixture.dispose();
    }
  });

  it("accumulates budget from attempt metadata in completeAttempt and pauses when exceeded", async () => {
    const fixture = await createFixture({
      projectConfigService: {
        get: () => ({
          effective: {
            ai: {
              orchestrator: {
                maxTotalTokenBudget: 100_000
              }
            }
          }
        })
      }
    });
    try {
      // 3 steps: a → b → c. After a and b complete, budget exceeds. c remains pending so run doesn't finalize.
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [
          { stepKey: "step-a", title: "Step A", stepIndex: 0 },
          { stepKey: "step-b", title: "Step B", stepIndex: 1, dependencyStepKeys: ["step-a"] },
          { stepKey: "step-c", title: "Step C", stepIndex: 2, dependencyStepKeys: ["step-b"] }
        ]
      });
      const stepA = fixture.service.listSteps(started.run.id).find((s) => s.stepKey === "step-a");
      if (!stepA) throw new Error("Missing step-a");

      const attemptA = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId: stepA.id,
        ownerId: "owner"
      });
      fixture.service.completeAttempt({
        attemptId: attemptA.id,
        status: "succeeded",
        metadata: { tokensConsumed: 70_000 }
      });

      // Budget should be accumulated
      const timeline1 = fixture.service.listTimeline({ runId: started.run.id, limit: 50 });
      expect(timeline1.some((e) => e.eventType === "budget_updated")).toBe(true);

      const stepB = fixture.service.listSteps(started.run.id).find((s) => s.stepKey === "step-b");
      if (!stepB) throw new Error("Missing step-b");
      const attemptB = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId: stepB.id,
        ownerId: "owner"
      });
      fixture.service.completeAttempt({
        attemptId: attemptB.id,
        status: "succeeded",
        metadata: { tokensConsumed: 50_000 }
      });

      // Total is now 120,000, exceeding 100,000 limit. Step C is still pending so run pauses.
      const runs = fixture.service.listRuns({ missionId: fixture.missionId });
      const run = runs.find((r) => r.id === started.run.id);
      expect(run?.status).toBe("paused");

      const timeline2 = fixture.service.listTimeline({ runId: started.run.id, limit: 50 });
      expect(timeline2.some((e) => e.eventType === "budget_exceeded")).toBe(true);
    } finally {
      fixture.dispose();
    }
  });

  it("adds steps to a running run with dependency resolution", async () => {
    const fixture = await createFixture();
    try {
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [
          { stepKey: "existing-a", title: "Existing A", stepIndex: 0 },
          { stepKey: "existing-b", title: "Existing B", stepIndex: 1, dependencyStepKeys: ["existing-a"] }
        ]
      });

      const newSteps = fixture.service.addSteps({
        runId: started.run.id,
        steps: [
          { stepKey: "new-c", title: "New C", stepIndex: 2, dependencyStepKeys: ["existing-b"] },
          { stepKey: "new-d", title: "New D", stepIndex: 3, dependencyStepKeys: ["new-c"] }
        ]
      });

      expect(newSteps).toHaveLength(2);
      expect(newSteps[0]?.stepKey).toBe("new-c");
      expect(newSteps[1]?.stepKey).toBe("new-d");

      // new-c should depend on existing-b
      const existingB = fixture.service.listSteps(started.run.id).find((s) => s.stepKey === "existing-b");
      expect(newSteps[0]?.dependencyStepIds).toContain(existingB?.id);

      // new-d should depend on new-c
      expect(newSteps[1]?.dependencyStepIds).toContain(newSteps[0]?.id);

      // Timeline should show step_registered events
      const timeline = fixture.service.listTimeline({ runId: started.run.id, limit: 50 });
      const registeredEvents = timeline.filter((e) => e.eventType === "step_registered" && e.reason === "add_steps");
      expect(registeredEvents.length).toBe(2);
    } finally {
      fixture.dispose();
    }
  });

  it("rejects invalid dependency edges when adding steps", async () => {
    const fixture = await createFixture();
    try {
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [{ stepKey: "seed", title: "Seed", stepIndex: 0 }]
      });

      expect(() =>
        fixture.service.addSteps({
          runId: started.run.id,
          steps: [
            {
              stepKey: "bad-edge",
              title: "Bad Edge",
              stepIndex: 1,
              dependencyStepKeys: ["does_not_exist"]
            }
          ]
        })
      ).toThrow(/unknown dependency/i);
      expect(fixture.service.listSteps(started.run.id)).toHaveLength(1);

      expect(() =>
        fixture.service.addSteps({
          runId: started.run.id,
          steps: [
            {
              stepKey: "cycle-a",
              title: "Cycle A",
              stepIndex: 1,
              dependencyStepKeys: ["cycle-b"]
            },
            {
              stepKey: "cycle-b",
              title: "Cycle B",
              stepIndex: 2,
              dependencyStepKeys: ["cycle-a"]
            }
          ]
        })
      ).toThrow(/dependency cycle/i);
      expect(fixture.service.listSteps(started.run.id)).toHaveLength(1);
    } finally {
      fixture.dispose();
    }
  });

  it("rejects duplicate step keys in addSteps", async () => {
    const fixture = await createFixture();
    try {
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [{ stepKey: "original", title: "Original", stepIndex: 0 }]
      });

      expect(() =>
        fixture.service.addSteps({
          runId: started.run.id,
          steps: [{ stepKey: "original", title: "Duplicate", stepIndex: 1 }]
        })
      ).toThrow(/duplicate/i);
    } finally {
      fixture.dispose();
    }
  });

  it("skips a step and unblocks downstream dependencies", async () => {
    const fixture = await createFixture();
    try {
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [
          { stepKey: "skip-me", title: "Skip Me", stepIndex: 0 },
          { stepKey: "downstream", title: "Downstream", stepIndex: 1, dependencyStepKeys: ["skip-me"] }
        ]
      });
      const [skipStep, downstream] = fixture.service.listSteps(started.run.id);
      if (!skipStep || !downstream) throw new Error("Missing steps");

      // downstream should not be ready yet
      expect(downstream.status).toBe("pending");

      const skipped = fixture.service.skipStep({
        runId: started.run.id,
        stepId: skipStep.id,
        reason: "Not needed"
      });
      expect(skipped.status).toBe("skipped");

      // downstream should now be ready since its dependency was skipped
      const updatedDownstream = fixture.service.listSteps(started.run.id).find((s) => s.id === downstream.id);
      expect(updatedDownstream?.status).toBe("ready");

      // Timeline should show skip event
      const timeline = fixture.service.listTimeline({ runId: started.run.id, limit: 50 });
      expect(timeline.some((e) => e.eventType === "step_skipped")).toBe(true);
    } finally {
      fixture.dispose();
    }
  });

  it("rejects skip on terminal step", async () => {
    const fixture = await createFixture();
    try {
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [{ stepKey: "done", title: "Done", stepIndex: 0 }]
      });
      const step = fixture.service.listSteps(started.run.id)[0];
      if (!step) throw new Error("Missing step");
      const attempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId: step.id,
        ownerId: "owner"
      });
      fixture.service.completeAttempt({ attemptId: attempt.id, status: "succeeded" });

      expect(() =>
        fixture.service.skipStep({
          runId: started.run.id,
          stepId: step.id
        })
      ).toThrow(/terminal/i);
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
