import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import type { PackExport, PackType } from "../../../shared/types";
import { createOrchestratorService, ReflectionValidationError } from "./orchestratorService";
import { openKvDb } from "../state/kvDb";

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {}
  } as any;
}

function runGit(cwd: string, args: string[]) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8"
  });
  if (result.status === 0) return;
  const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
  throw new Error(`git ${args.join(" ")} failed (${result.status}): ${stderr}`);
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
  projectConfigService?: Record<string, unknown> | null;
  aiIntegrationService?: Record<string, unknown> | null;
  memoryService?: Record<string, unknown> | null;
  memoryBriefingService?: Record<string, unknown> | null;
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

  const service = createOrchestratorService({
    db,
    projectId,
    projectRoot,
    conflictService: args.conflictService,
    ptyService,
    projectConfigService: (args.projectConfigService ?? null) as any,
    aiIntegrationService: (args.aiIntegrationService ?? null) as any,
    memoryService: (args.memoryService ?? null) as any,
    memoryBriefingService: (args.memoryBriefingService ?? null) as any,
  });

  // Test harness convenience: unified workers require metadata.modelId in Phase 3.
  // Inject a default modelId for tests that are validating unrelated behavior.
  const defaultUnifiedModelId = "anthropic/claude-sonnet-4-6";
  const normalizeStepModelId = (step: any) => {
    const executorKind = typeof step?.executorKind === "string" ? step.executorKind : null;
    if (executorKind !== "unified") return step;
    const metadata =
      step?.metadata && typeof step.metadata === "object" && !Array.isArray(step.metadata)
        ? step.metadata
        : {};
    const modelId = typeof metadata.modelId === "string" ? metadata.modelId.trim() : "";
    if (modelId.length > 0) return step;
    return {
      ...step,
      metadata: {
        ...metadata,
        modelId: defaultUnifiedModelId,
      },
    };
  };
  const originalStartRun = service.startRun.bind(service);
  (service as any).startRun = ((input: any) =>
    originalStartRun({
      ...input,
      steps: Array.isArray(input?.steps) ? input.steps.map((step: any) => normalizeStepModelId(step)) : input?.steps,
    })) as typeof service.startRun;

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

  it("keeps cancellation and resume deterministic when claim conflicts are active", async () => {
    const fixture = await createFixture();
    try {
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [
          {
            stepKey: "lane-lock-a",
            title: "Lane Lock A",
            stepIndex: 0,
            policy: {
              claimScopes: [{ scopeKind: "lane", scopeValue: `lane:${fixture.laneId}`, ttlMs: 60_000 }]
            }
          },
          {
            stepKey: "lane-lock-b",
            title: "Lane Lock B",
            stepIndex: 1,
            policy: {
              claimScopes: [{ scopeKind: "lane", scopeValue: `lane:${fixture.laneId}`, ttlMs: 60_000 }]
            }
          }
        ]
      });
      const [firstStep, secondStep] = fixture.service.listSteps(started.run.id);
      if (!firstStep || !secondStep) throw new Error("Missing steps");

      const runningAttempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId: firstStep.id,
        ownerId: "owner-running"
      });
      expect(runningAttempt.status).toBe("running");

      const blockedAttempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId: secondStep.id,
        ownerId: "owner-blocked"
      });
      expect(blockedAttempt.status).toBe("blocked");
      expect(blockedAttempt.errorClass).toBe("claim_conflict");

      fixture.service.cancelRun({
        runId: started.run.id,
        reason: "operator_cancel_conflict"
      });

      const canceledGraph = fixture.service.getRunGraph({ runId: started.run.id, timelineLimit: 50 });
      expect(canceledGraph.run.status).toBe("canceled");
      expect(canceledGraph.steps.every((step) => step.status === "canceled")).toBe(true);
      expect(canceledGraph.attempts.some((attempt) => attempt.status === "canceled")).toBe(true);

      const activeClaims = fixture.service.listClaims({ runId: started.run.id, state: "active" });
      expect(activeClaims).toHaveLength(0);

      const resumed = fixture.service.resumeRun({ runId: started.run.id });
      expect(resumed.status).toBe("canceled");

      const runtimeEvents = fixture.service.listRuntimeEvents({
        runId: started.run.id,
        eventTypes: ["claim_conflict"],
        limit: 20
      });
      expect(runtimeEvents.length).toBeGreaterThan(0);

      const timeline = fixture.service.listTimeline({ runId: started.run.id, limit: 50 });
      expect(timeline.some((entry) => entry.eventType === "run_canceled")).toBe(true);
    } finally {
      fixture.dispose();
    }
  });

  it("persists runtime bus events idempotently and replays them from run graph", async () => {
    const fixture = await createFixture();
    try {
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [{ stepKey: "runtime", title: "Runtime", stepIndex: 0 }]
      });
      const step = fixture.service.listSteps(started.run.id)[0];
      if (!step) throw new Error("Missing step");
      const attempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId: step.id,
        ownerId: "runtime-owner"
      });

      fixture.service.appendRuntimeEvent({
        runId: started.run.id,
        stepId: step.id,
        attemptId: attempt.id,
        eventType: "heartbeat",
        eventKey: "dedupe-key",
        payload: { source: "test" }
      });
      fixture.service.appendRuntimeEvent({
        runId: started.run.id,
        stepId: step.id,
        attemptId: attempt.id,
        eventType: "heartbeat",
        eventKey: "dedupe-key",
        payload: { source: "test-duplicate" }
      });

      const events = fixture.service.listRuntimeEvents({
        runId: started.run.id,
        eventTypes: ["heartbeat"],
        limit: 10
      });
      const deduped = events.filter((event) => event.eventKey === "dedupe-key");
      expect(deduped).toHaveLength(1);
      expect(deduped[0]?.payload?.source).toBe("test");

      const graph = fixture.service.getRunGraph({ runId: started.run.id, timelineLimit: 0 });
      expect((graph.runtimeEvents ?? []).some((event) => event.eventKey === "dedupe-key")).toBe(true);
    } finally {
      fixture.dispose();
    }
  });

  it("blocks overlapping file reservation patterns under parallel load", async () => {
    const fixture = await createFixture();
    try {
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [
          {
            stepKey: "file-a",
            title: "File A",
            stepIndex: 0,
            policy: {
              claimScopes: [{ scopeKind: "file", scopeValue: "glob:src/**", ttlMs: 60_000 }]
            }
          },
          {
            stepKey: "file-b",
            title: "File B",
            stepIndex: 1,
            policy: {
              claimScopes: [{ scopeKind: "file", scopeValue: "glob:src/app/**", ttlMs: 60_000 }]
            }
          }
        ]
      });
      const [first, second] = fixture.service.listSteps(started.run.id);
      if (!first || !second) throw new Error("Missing steps");

      const firstAttempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId: first.id,
        ownerId: "owner-a"
      });
      expect(firstAttempt.status).toBe("running");

      const secondAttempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId: second.id,
        ownerId: "owner-b"
      });
      expect(secondAttempt.status).toBe("blocked");
      expect(secondAttempt.errorClass).toBe("claim_conflict");
      expect(secondAttempt.errorMessage ?? "").toContain("Claim collision");

      const metadata = secondAttempt.metadata ?? {};
      expect(metadata.claimConflict).toBeTruthy();
      expect(String((metadata.claimConflict as Record<string, unknown>).conflictReason ?? "")).toContain("overlapping_file_scope");
    } finally {
      fixture.dispose();
    }
  });

  it("warns on file reservation violations at completion boundary in warn mode", async () => {
    const fixture = await createFixture({
      projectConfigService: {
        get: () => ({
          effective: {
            ai: {
              orchestrator: {
                fileReservationGuardMode: "warn"
              }
            }
          }
        })
      }
    });
    try {
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [
          {
            stepKey: "guard-warn",
            title: "Guard Warn",
            stepIndex: 0,
            policy: {
              claimScopes: [{ scopeKind: "file", scopeValue: "glob:src/**", ttlMs: 60_000 }]
            }
          }
        ]
      });
      const step = fixture.service.listSteps(started.run.id)[0];
      if (!step) throw new Error("Missing step");

      const attempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId: step.id,
        ownerId: "owner-warn"
      });
      expect(attempt.status).toBe("running");

      const completed = await fixture.service.completeAttempt({
        attemptId: attempt.id,
        status: "succeeded",
        metadata: {
          changedFiles: ["src/app/main.ts", "README.md"]
        }
      });
      expect(completed.status).toBe("succeeded");
      expect(
        (completed.resultEnvelope?.warnings ?? []).some((entry: string) => entry.includes("File reservation violation"))
      ).toBe(true);
      expect(Array.isArray(completed.metadata?.fileReservationViolations)).toBe(true);
      expect((completed.metadata?.fileReservationViolations as string[])).toContain("README.md");

      const timeline = fixture.service.listTimeline({ runId: started.run.id, limit: 50 });
      const guard = timeline.find((entry) => entry.eventType === "file_reservation_guard");
      expect(guard?.reason).toBe("warn");
    } finally {
      fixture.dispose();
    }
  });

  it("blocks completion on file reservation violations in block mode", async () => {
    const fixture = await createFixture({
      projectConfigService: {
        get: () => ({
          effective: {
            ai: {
              orchestrator: {
                fileReservationGuardMode: "block"
              }
            }
          }
        })
      }
    });
    try {
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [
          {
            stepKey: "guard-block",
            title: "Guard Block",
            stepIndex: 0,
            policy: {
              claimScopes: [{ scopeKind: "file", scopeValue: "glob:src/**", ttlMs: 60_000 }]
            }
          }
        ]
      });
      const step = fixture.service.listSteps(started.run.id)[0];
      if (!step) throw new Error("Missing step");

      const attempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId: step.id,
        ownerId: "owner-block"
      });
      const completed = await fixture.service.completeAttempt({
        attemptId: attempt.id,
        status: "succeeded",
        metadata: {
          changedFiles: ["README.md"]
        }
      });
      expect(completed.status).toBe("blocked");
      expect(completed.errorClass).toBe("policy");
      expect(completed.errorMessage ?? "").toContain("File reservation violation");

      const graph = fixture.service.getRunGraph({ runId: started.run.id, timelineLimit: 0 });
      const refreshedStep = graph.steps.find((entry) => entry.id === step.id);
      expect(refreshedStep?.status).toBe("blocked");

      const timeline = fixture.service.listTimeline({ runId: started.run.id, limit: 50 });
      const guard = timeline.find((entry) => entry.eventType === "file_reservation_guard");
      expect(guard?.reason).toBe("block");
    } finally {
      fixture.dispose();
    }
  });

  it("treats rename/move paths as touched files for reservation enforcement", async () => {
    const fixture = await createFixture({
      projectConfigService: {
        get: () => ({
          effective: {
            ai: {
              orchestrator: {
                fileReservationGuardMode: "warn"
              }
            }
          }
        })
      }
    });
    try {
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [
          {
            stepKey: "rename-edge",
            title: "Rename Edge",
            stepIndex: 0,
            policy: {
              claimScopes: [{ scopeKind: "file", scopeValue: "glob:src/**", ttlMs: 60_000 }]
            }
          }
        ]
      });
      const step = fixture.service.listSteps(started.run.id)[0];
      if (!step) throw new Error("Missing step");

      const attempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId: step.id,
        ownerId: "owner-rename"
      });
      const completed = await fixture.service.completeAttempt({
        attemptId: attempt.id,
        status: "succeeded",
        metadata: {
          renamedFiles: [{ from: "src/legacy.ts", to: "docs/legacy.ts" }]
        }
      });
      expect(completed.status).toBe("succeeded");
      expect((completed.metadata?.fileReservationTouchedPaths as string[])).toContain("src/legacy.ts");
      expect((completed.metadata?.fileReservationTouchedPaths as string[])).toContain("docs/legacy.ts");
      expect((completed.metadata?.fileReservationViolations as string[])).toContain("docs/legacy.ts");
      expect((completed.metadata?.fileReservationViolations as string[])).not.toContain("src/legacy.ts");
    } finally {
      fixture.dispose();
    }
  });

  it("uses git status fallback for staged and unstaged touched-file reservation checks", async () => {
    const fixture = await createFixture({
      projectConfigService: {
        get: () => ({
          effective: {
            ai: {
              orchestrator: {
                fileReservationGuardMode: "block"
              }
            }
          }
        })
      }
    });
    try {
      runGit(fixture.projectRoot, ["init"]);
      runGit(fixture.projectRoot, ["config", "user.email", "test@example.com"]);
      runGit(fixture.projectRoot, ["config", "user.name", "ADE Test"]);

      fs.mkdirSync(path.join(fixture.projectRoot, "src"), { recursive: true });
      fs.writeFileSync(path.join(fixture.projectRoot, "src", "in-scope.ts"), "export const value = 1;\n", "utf8");
      runGit(fixture.projectRoot, ["add", "-A"]);
      runGit(fixture.projectRoot, ["commit", "-m", "baseline"]);

      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [
          {
            stepKey: "git-fallback",
            title: "Git Fallback",
            stepIndex: 0,
            laneId: fixture.laneId,
            policy: {
              claimScopes: [{ scopeKind: "file", scopeValue: "glob:src/**", ttlMs: 60_000 }]
            }
          }
        ]
      });
      const step = fixture.service.listSteps(started.run.id)[0];
      if (!step) throw new Error("Missing step");

      const attempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId: step.id,
        ownerId: "owner-git-fallback"
      });

      fs.writeFileSync(path.join(fixture.projectRoot, "src", "in-scope.ts"), "export const value = 2;\n", "utf8");
      fs.mkdirSync(path.join(fixture.projectRoot, "docs"), { recursive: true });
      fs.writeFileSync(path.join(fixture.projectRoot, "docs", "out-of-scope.md"), "changed\n", "utf8");
      runGit(fixture.projectRoot, ["add", "src/in-scope.ts"]);

      const completed = await fixture.service.completeAttempt({
        attemptId: attempt.id,
        status: "succeeded",
        metadata: {}
      });

      expect(completed.status).toBe("blocked");
      expect(completed.errorClass).toBe("policy");
      expect(completed.errorMessage ?? "").toContain("File reservation violation");
      expect((completed.metadata?.fileReservationTouchedPaths as string[])).toContain("src/in-scope.ts");
      expect((completed.metadata?.fileReservationTouchedPaths as string[])).toContain("docs/out-of-scope.md");
      expect((completed.metadata?.fileReservationViolations as string[])).toContain("docs/out-of-scope.md");
      expect((completed.metadata?.fileReservationViolations as string[])).not.toContain("src/in-scope.ts");
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

      fixture.service.activateRun(started.run.id);
      const resumed = fixture.service.resumeRun({ runId: started.run.id });
      expect(resumed.status).toBe("active");

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

  it("blocks startAttempt and autopilot dispatch when run is paused or completing", async () => {
    const fixture = await createFixture();
    try {
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        metadata: {
          autopilot: {
            enabled: true,
            executorKind: "unified",
            ownerId: "autopilot-owner",
            parallelismCap: 1
          }
        },
        steps: [
          {
            stepKey: "status-guarded",
            title: "Status Guarded",
            stepIndex: 0,
            executorKind: "unified"
          }
        ]
      });
      const step = fixture.service.listSteps(started.run.id)[0];
      if (!step) throw new Error("Missing step");

      fixture.service.pauseRun({ runId: started.run.id, reason: "operator pause" });
      await expect(
        fixture.service.startAttempt({
          runId: started.run.id,
          stepId: step.id,
          ownerId: "owner"
        })
      ).rejects.toThrow(/status 'paused'/i);
      expect(
        await fixture.service.startReadyAutopilotAttempts({
          runId: started.run.id,
          reason: "paused_guard"
        })
      ).toBe(0);

      fixture.db.run(`update orchestrator_runs set status = 'completing', updated_at = ? where id = ?`, [new Date().toISOString(), started.run.id]);
      await expect(
        fixture.service.startAttempt({
          runId: started.run.id,
          stepId: step.id,
          ownerId: "owner"
        })
      ).rejects.toThrow(/status 'completing'/i);
      expect(
        await fixture.service.startReadyAutopilotAttempts({
          runId: started.run.id,
          reason: "completing_guard"
        })
      ).toBe(0);

      expect(fixture.service.listAttempts({ runId: started.run.id })).toHaveLength(0);
    } finally {
      fixture.dispose();
    }
  });

  it("rejects executor-backed attempts before scaffolding when laneId is missing", async () => {
    const fixture = await createFixture();
    try {
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [
          {
            stepKey: "missing-lane",
            title: "Missing lane",
            stepIndex: 0,
            laneId: fixture.laneId,
            executorKind: "unified",
          }
        ]
      });
      const createdStep = fixture.service.listSteps(started.run.id)[0];
      if (!createdStep) throw new Error("Missing step");

      fixture.db.run(
        `update orchestrator_steps set lane_id = null, updated_at = ? where id = ? and project_id = ?`,
        [new Date().toISOString(), createdStep.id, fixture.projectId],
      );
      const refreshedStep = fixture.service.listSteps(started.run.id)[0];
      expect(refreshedStep?.laneId).toBeNull();

      await expect(
        fixture.service.startAttempt({
          runId: started.run.id,
          stepId: refreshedStep?.id ?? createdStep.id,
          ownerId: "owner",
          executorKind: "unified",
        }),
      ).rejects.toThrow(/laneId is missing/i);
      expect(fixture.service.listAttempts({ runId: started.run.id })).toHaveLength(0);
      expect(fixture.ptyCreateCalls).toHaveLength(0);
    } finally {
      fixture.dispose();
    }
  });

  it("defaults added mission steps to the persisted mission lane", async () => {
    const fixture = await createFixture();
    try {
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        metadata: {
          missionLaneId: fixture.laneId,
        },
        steps: [],
      });

      const created = fixture.service.addSteps({
        runId: started.run.id,
        steps: [
          {
            stepKey: "mission-task",
            title: "Mission task",
            stepIndex: 0,
            executorKind: "manual",
          },
        ],
      });

      expect(created[0]?.laneId).toBe(fixture.laneId);
      expect(fixture.service.listSteps(started.run.id)[0]?.laneId).toBe(fixture.laneId);
    } finally {
      fixture.dispose();
    }
  });

  it("still launches ready workers even when manual task steps are present", async () => {
    const fixture = await createFixture();
    try {
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        metadata: {
          autopilot: {
            enabled: true,
            executorKind: "unified",
            ownerId: "autopilot-owner",
            parallelismCap: 1
          }
        },
        steps: [
          {
            stepKey: "plan",
            title: "Plan sidebar work",
            stepIndex: 0,
            executorKind: "manual",
            metadata: {
              stepType: "task"
            }
          },
          {
            stepKey: "planning-worker",
            title: "Research sidebar",
            stepIndex: 1,
            laneId: fixture.laneId,
            executorKind: "unified",
            metadata: {
              stepType: "planning"
            }
          }
        ]
      });

      const startedAttempts = await fixture.service.startReadyAutopilotAttempts({
        runId: started.run.id,
        reason: "ignore_display_only_tasks"
      });

      expect(startedAttempts).toBe(1);
      const attempts = fixture.service.listAttempts({ runId: started.run.id });
      const planningWorkerStep = fixture.service
        .listSteps(started.run.id)
        .find((step) => step.stepKey === "planning-worker");

      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.stepId).toBe(planningWorkerStep?.id);

    } finally {
      fixture.dispose();
    }
  });

  it("keeps future-phase steps pending until the active phase changes", async () => {
    const fixture = await createFixture();
    try {
      const planningPhase = {
        id: "phase-planning",
        phaseKey: "planning",
        name: "Planning",
        description: "Plan the work",
        instructions: "Research first.",
        model: { provider: "anthropic", modelId: "anthropic/claude-sonnet-4-6" },
        budget: {},
        orderingConstraints: { mustBeFirst: true },
        askQuestions: { enabled: false },
        validationGate: { tier: "none", required: false, criteria: "" },
        isBuiltIn: true,
        isCustom: false,
        position: 0,
        createdAt: "2026-03-08T00:00:00.000Z",
        updatedAt: "2026-03-08T00:00:00.000Z",
      };
      const developmentPhase = {
        id: "phase-development",
        phaseKey: "development",
        name: "Development",
        description: "Implement the work",
        instructions: "Write code.",
        model: { provider: "openai", modelId: "openai/gpt-5.3-codex" },
        budget: {},
        orderingConstraints: { mustFollow: ["planning"] },
        askQuestions: { enabled: false },
        validationGate: { tier: "none", required: false, criteria: "" },
        isBuiltIn: true,
        isCustom: false,
        position: 1,
        createdAt: "2026-03-08T00:00:00.000Z",
        updatedAt: "2026-03-08T00:00:00.000Z",
      };

      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        metadata: {
          phaseConfiguration: { selectedPhases: [planningPhase, developmentPhase] },
          phaseRuntime: {
            currentPhaseKey: "planning",
            currentPhaseName: "Planning",
            currentPhaseModel: planningPhase.model,
          },
          autopilot: {
            enabled: true,
            executorKind: "unified",
            ownerId: "autopilot-owner",
            parallelismCap: 2
          }
        },
        steps: [
          {
            stepKey: "plan-work",
            title: "Plan work",
            stepIndex: 0,
            laneId: fixture.laneId,
            executorKind: "unified",
            metadata: {
              stepType: "planning",
              phaseKey: "planning",
              phaseName: "Planning",
              phasePosition: 0,
            }
          },
          {
            stepKey: "impl-work",
            title: "Implement work",
            stepIndex: 1,
            laneId: fixture.laneId,
            executorKind: "unified",
            metadata: {
              stepType: "implementation",
              phaseKey: "development",
              phaseName: "Development",
              phasePosition: 1,
            }
          }
        ]
      });

      const planningStep = fixture.service.listSteps(started.run.id).find((step) => step.stepKey === "plan-work");
      const implementationStep = fixture.service.listSteps(started.run.id).find((step) => step.stepKey === "impl-work");
      expect(planningStep?.status).toBe("ready");
      expect(implementationStep?.status).toBe("pending");

      const startedAttempts = await fixture.service.startReadyAutopilotAttempts({
        runId: started.run.id,
        reason: "phase_gate_regression"
      });

      expect(startedAttempts).toBe(1);
      const attempts = fixture.service.listAttempts({ runId: started.run.id });
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.stepId).toBe(planningStep?.id);
      const refreshedImplementation = fixture.service.listSteps(started.run.id).find((step) => step.stepKey === "impl-work");
      expect(refreshedImplementation?.status).toBe("pending");
    } finally {
      fixture.dispose();
    }
  });

  it("auto-advances to the next configured phase when current phase is complete and downstream work exists", async () => {
    const fixture = await createFixture();
    try {
      const planningPhase = {
        id: "phase-planning",
        phaseKey: "planning",
        name: "Planning",
        description: "Plan the work",
        instructions: "Research first.",
        model: { provider: "anthropic", modelId: "anthropic/claude-sonnet-4-6" },
        budget: {},
        orderingConstraints: { mustBeFirst: true },
        askQuestions: { enabled: false },
        validationGate: { tier: "none", required: false, criteria: "" },
        isBuiltIn: true,
        isCustom: false,
        position: 0,
        createdAt: "2026-03-08T00:00:00.000Z",
        updatedAt: "2026-03-08T00:00:00.000Z",
      };
      const developmentPhase = {
        id: "phase-development",
        phaseKey: "development",
        name: "Development",
        description: "Implement the work",
        instructions: "Write code.",
        model: { provider: "openai", modelId: "openai/gpt-5.3-codex" },
        budget: {},
        orderingConstraints: { mustFollow: ["planning"] },
        askQuestions: { enabled: false },
        validationGate: { tier: "none", required: false, criteria: "" },
        isBuiltIn: true,
        isCustom: false,
        position: 1,
        createdAt: "2026-03-08T00:00:00.000Z",
        updatedAt: "2026-03-08T00:00:00.000Z",
      };

      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        metadata: {
          phaseConfiguration: { selectedPhases: [planningPhase, developmentPhase] },
          phaseRuntime: {
            currentPhaseKey: "planning",
            currentPhaseName: "Planning",
            currentPhaseModel: planningPhase.model,
          },
        },
        steps: [
          {
            stepKey: "plan-work",
            title: "Plan work",
            stepIndex: 0,
            executorKind: "manual",
            metadata: {
              stepType: "planning",
              phaseKey: "planning",
              phaseName: "Planning",
              readOnlyExecution: true,
            }
          },
          {
            stepKey: "impl-work",
            title: "Implement work",
            stepIndex: 1,
            dependencyStepKeys: ["plan-work"],
            executorKind: "manual",
            metadata: {
              stepType: "implementation",
              phaseKey: "development",
              phaseName: "Development",
            }
          }
        ]
      });

      const planningStep = fixture.service.listSteps(started.run.id).find((step) => step.stepKey === "plan-work");
      const implementationStep = fixture.service.listSteps(started.run.id).find((step) => step.stepKey === "impl-work");
      if (!planningStep || !implementationStep) throw new Error("Missing phase auto-advance steps");

      const attempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId: planningStep.id,
        ownerId: "planner-owner",
        executorKind: "manual",
      });
      fixture.service.updateStepMetadata({
        runId: started.run.id,
        stepId: planningStep.id,
        metadata: {
          lastResultReport: {
            summary: "Planning complete.",
            plan: {
              markdown: "# Plan\n\n1. Implement work",
              artifactPath: ".ade/plans/mission-plan.md",
            },
          },
        },
      });
      await fixture.service.completeAttempt({
        attemptId: attempt.id,
        status: "succeeded",
        result: {
          schema: "ade.orchestratorAttempt.v1",
          success: true,
          summary: "Planning complete.",
          outputs: null,
          warnings: [],
          sessionId: null,
          trackedSession: false,
        },
      });

      const refreshed = fixture.service.getRunGraph({ runId: started.run.id, timelineLimit: 50 });
      const phaseRuntime = refreshed.run.metadata?.phaseRuntime as Record<string, unknown> | undefined;
      const developmentStep = refreshed.steps.find((step) => step.id === implementationStep.id);

      expect(phaseRuntime?.currentPhaseKey).toBe("development");
      expect(phaseRuntime?.currentPhaseName).toBe("Development");
      expect(developmentStep?.status).toBe("ready");
      expect(
        refreshed.timeline.some((entry) => entry.eventType === "phase_transition" && entry.reason === "kernel_auto_advance")
      ).toBe(true);
    } finally {
      fixture.dispose();
    }
  });

  it("holds downstream steps pending until required validation passes", async () => {
    const fixture = await createFixture();
    try {
      const implementationPhase = {
        id: "phase-implementation",
        phaseKey: "implementation",
        name: "Implementation",
        description: "Build",
        instructions: "",
        model: { provider: "openai", modelId: "openai/gpt-5.3-codex" },
        budget: {},
        orderingConstraints: {},
        askQuestions: { enabled: false },
        validationGate: { tier: "self", required: true, criteria: "Reviewer must confirm the change." },
        isBuiltIn: true,
        isCustom: false,
        position: 1,
        createdAt: "2026-03-08T00:00:00.000Z",
        updatedAt: "2026-03-08T00:00:00.000Z",
      };

      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        metadata: {
          phaseConfiguration: { selectedPhases: [implementationPhase] },
          phaseRuntime: {
            currentPhaseKey: "implementation",
            currentPhaseName: "Implementation",
            currentPhaseModel: implementationPhase.model,
          },
          autopilot: {
            enabled: true,
            executorKind: "unified",
            ownerId: "autopilot-owner",
            parallelismCap: 1
          }
        },
        steps: [
          {
            stepKey: "impl-auth",
            title: "Implement auth flow",
            stepIndex: 0,
            laneId: fixture.laneId,
            executorKind: "unified",
            metadata: {
              stepType: "implementation",
              phaseKey: "implementation",
              phaseName: "Implementation",
              validationContract: {
                level: "step",
                tier: "self",
                required: true,
                criteria: "Reviewer must confirm the change.",
                evidence: [],
                maxRetries: 2
              }
            }
          },
          {
            stepKey: "wire-auth",
            title: "Wire auth into app shell",
            stepIndex: 1,
            laneId: fixture.laneId,
            dependencyStepKeys: ["impl-auth"],
            executorKind: "unified",
            metadata: {
              stepType: "implementation",
              phaseKey: "implementation",
              phaseName: "Implementation",
            }
          }
        ]
      });

      const implStep = fixture.service.listSteps(started.run.id).find((step) => step.stepKey === "impl-auth");
      const downstreamStep = fixture.service.listSteps(started.run.id).find((step) => step.stepKey === "wire-auth");
      if (!implStep || !downstreamStep) throw new Error("Missing steps for validation gate test");

      const attempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId: implStep.id,
        ownerId: "owner"
      });
      await fixture.service.completeAttempt({
        attemptId: attempt.id,
        status: "succeeded",
        result: {
          schema: "ade.orchestratorAttempt.v1",
          success: true,
          summary: "Implemented auth flow.",
          outputs: {
            filesChanged: ["src/auth.ts"],
          },
          warnings: [],
          sessionId: null,
          trackedSession: false
        }
      });

      const pendingBeforePass = fixture.service.listSteps(started.run.id).find((step) => step.id === downstreamStep.id);
      expect(pendingBeforePass?.status).toBe("pending");
      expect(
        await fixture.service.startReadyAutopilotAttempts({
          runId: started.run.id,
          reason: "validation_gate_regression"
        })
      ).toBe(0);

      const implAfterSuccess = fixture.service.listSteps(started.run.id).find((step) => step.id === implStep.id);
      fixture.db.run(
        `update orchestrator_steps set metadata_json = ?, updated_at = ? where id = ?`,
        [
          JSON.stringify({
            ...(implAfterSuccess?.metadata ?? {}),
            validationState: "pass",
            validationPassedAt: "2026-03-08T00:05:00.000Z",
          }),
          "2026-03-08T00:05:00.000Z",
          implStep.id
        ]
      );

      fixture.service.tick({ runId: started.run.id });

      const releasedStep = fixture.service.listSteps(started.run.id).find((step) => step.id === downstreamStep.id);
      expect(releasedStep?.status).toBe("ready");
      expect(
        await fixture.service.startReadyAutopilotAttempts({
          runId: started.run.id,
          reason: "validation_gate_released"
        })
      ).toBe(1);
    } finally {
      fixture.dispose();
    }
  });

  it("resumeRun unpauses paused runs safely", async () => {
    const fixture = await createFixture();
    try {
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [
          {
            stepKey: "resume-guard",
            title: "Resume Guard",
            stepIndex: 0
          }
        ]
      });
      fixture.service.pauseRun({ runId: started.run.id, reason: "manual_pause" });
      const paused = fixture.service.listRuns({ missionId: fixture.missionId }).find((run) => run.id === started.run.id);
      expect(paused?.status).toBe("paused");

      const resumed = fixture.service.resumeRun({ runId: started.run.id });
      expect(resumed.status).toBe("active");
      const timeline = fixture.service.listTimeline({ runId: started.run.id, limit: 30 });
      expect(timeline.some((entry) => entry.eventType === "run_resumed")).toBe(true);
    } finally {
      fixture.dispose();
    }
  });

  it("uses deterministic default context profile", async () => {
    const fixture = await createFixture();
    try {
      const profile = fixture.service.getContextProfile();
      expect(profile.id).toBe("orchestrator_deterministic_v1");
      expect(profile.docsMode).toBe("digest_refs");
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
      await fixture.service.completeAttempt({
        attemptId: aAnyAttempt.id,
        status: "failed",
        errorClass: "deterministic",
        errorMessage: "deterministic failure"
      });
      const bAnyAttempt = await fixture.service.startAttempt({ runId: anyRun.run.id, stepId: bAny.id, ownerId: "owner" });
      await fixture.service.completeAttempt({ attemptId: bAnyAttempt.id, status: "succeeded" });
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
      await fixture.service.completeAttempt({
        attemptId: aAllAttempt.id,
        status: "failed",
        errorClass: "deterministic",
        errorMessage: "deterministic failure"
      });
      const bAllAttempt = await fixture.service.startAttempt({ runId: allRun.run.id, stepId: bAll.id, ownerId: "owner" });
      await fixture.service.completeAttempt({ attemptId: bAllAttempt.id, status: "succeeded" });
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
      await fixture.service.completeAttempt({ attemptId: aQAttempt.id, status: "succeeded" });
      const bQAttempt = await fixture.service.startAttempt({ runId: quorumRun.run.id, stepId: bQ.id, ownerId: "owner" });
      await fixture.service.completeAttempt({ attemptId: bQAttempt.id, status: "succeeded" });
      const cQAttempt = await fixture.service.startAttempt({ runId: quorumRun.run.id, stepId: cQ.id, ownerId: "owner" });
      await fixture.service.completeAttempt({
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
      await fixture.service.completeAttempt({ attemptId: apiAttempt.id, status: "succeeded" });

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
      await fixture.service.completeAttempt({ attemptId: uiAttempt.id, status: "succeeded" });

      [apiStep, uiStep, integrateStep, finalReviewStep] = fixture.service.listSteps(started.run.id);
      expect(integrateStep.status).toBe("ready");
      expect(["pending", "blocked"]).toContain(finalReviewStep.status);

      const integrateAttempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId: integrateStep.id,
        ownerId: "owner-integrate",
        executorKind: "manual"
      });
      await fixture.service.completeAttempt({ attemptId: integrateAttempt.id, status: "succeeded" });

      [apiStep, uiStep, integrateStep, finalReviewStep] = fixture.service.listSteps(started.run.id);
      expect(integrateStep.status).toBe("succeeded");
      expect(finalReviewStep.status).toBe("ready");

      const reviewAttempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId: finalReviewStep.id,
        ownerId: "owner-review",
        executorKind: "manual"
      });
      await fixture.service.completeAttempt({ attemptId: reviewAttempt.id, status: "succeeded" });

      fixture.service.finalizeRun({ runId: started.run.id, force: true });
      const run = fixture.service.listRuns({ missionId: fixture.missionId }).find((entry) => entry.id === started.run.id);
      expect(run?.status).toBe("succeeded");
    } finally {
      fixture.dispose();
    }
  });

  it("uses configured autopilot parallel cap when AI cap metadata is absent", async () => {
    const fixture = await createFixture();
    try {
      const now = "2026-02-19T00:00:00.000Z";
      const transcriptDir = path.join(fixture.projectRoot, ".ade", "transcripts");
      fs.mkdirSync(transcriptDir, { recursive: true });
      // Pre-insert terminal_sessions rows for sessions the default adapter will create.
      for (let i = 1; i <= 3; i++) {
        const sid = `session-${i}`;
        fixture.db.run(
          `insert or ignore into terminal_sessions(
            id, lane_id, pty_id, tracked, title, started_at, ended_at,
            exit_code, transcript_path, head_sha_start, head_sha_end,
            status, last_output_preview, summary, tool_type, resume_command, last_output_at
          ) values (?, ?, null, 1, 'Worker', ?, null, null, ?, null, null,
            'running', null, null, 'codex-orchestrated', null, ?)`,
          [sid, fixture.laneId, now, path.join(transcriptDir, `${sid}.log`), now]
        );
      }

      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        metadata: {
          autopilot: {
            enabled: true,
            executorKind: "unified",
            ownerId: "autopilot-owner",
            parallelismCap: 4
          }
        },
        steps: [
          { stepKey: "s1", title: "S1", stepIndex: 0, laneId: fixture.laneId, executorKind: "unified" },
          { stepKey: "s2", title: "S2", stepIndex: 1, laneId: fixture.laneId, executorKind: "unified" },
          { stepKey: "s3", title: "S3", stepIndex: 2, laneId: fixture.laneId, executorKind: "unified" }
        ]
      });

      const gateReport = {
        id: "gate-fail-1",
        generatedAt: new Date().toISOString(),
        generatedBy: "deterministic_kernel",
        overallStatus: "fail",
        gates: [],
        notes: ["forced gate fail for test"]
      };
      fixture.db.run(
        `
          insert into orchestrator_gate_reports(
            id,
            project_id,
            generated_at,
            report_json
          ) values (?, ?, ?, ?)
        `,
        [gateReport.id, fixture.projectId, gateReport.generatedAt, JSON.stringify(gateReport)]
      );

      const startedAttempts = await fixture.service.startReadyAutopilotAttempts({
        runId: started.run.id,
        reason: "test_dynamic_cap"
      });
      expect(startedAttempts).toBe(3);

      const runningAttempts = fixture.service
        .listAttempts({ runId: started.run.id })
        .filter((attempt) => attempt.status === "running");
      expect(runningAttempts).toHaveLength(3);

      const timeline = fixture.service.listTimeline({ runId: started.run.id, limit: 100 });
      const capEvents = timeline.filter((entry) => entry.eventType === "autopilot_parallelism_cap_adjusted");
      expect(capEvents.length).toBeGreaterThanOrEqual(1);
      const allReasons = capEvents.flatMap((evt) => {
        const detail = evt.detail as Record<string, unknown> | null;
        return Array.isArray(detail?.reasons)
          ? (detail!.reasons as unknown[]).map((entry) => String(entry))
          : [];
      });
      expect(allReasons).toContain("configured_cap");
      expect(allReasons).not.toContain("gate_fail");
      expect(allReasons).not.toContain("initial_ramp_bypass");
      expect(allReasons).not.toContain("claim_conflicts");
      expect(allReasons).not.toContain("context_pressure");
      expect(allReasons).not.toContain("resource_pressure");
    } finally {
      fixture.dispose();
    }
  });

  it("uses AI cap directives without deterministic gate/context/resource reductions", async () => {
    const fixture = await createFixture();
    try {
      const now = "2026-02-19T00:00:00.000Z";
      const transcriptDir = path.join(fixture.projectRoot, ".ade", "transcripts");
      fs.mkdirSync(transcriptDir, { recursive: true });
      for (let i = 1; i <= 3; i++) {
        const sid = `session-${i}`;
        fixture.db.run(
          `insert or ignore into terminal_sessions(
            id, lane_id, pty_id, tracked, title, started_at, ended_at,
            exit_code, transcript_path, head_sha_start, head_sha_end,
            status, last_output_preview, summary, tool_type, resume_command, last_output_at
          ) values (?, ?, null, 1, 'Worker', ?, null, null, ?, null, null,
            'running', null, null, 'codex-orchestrated', null, ?)`,
          [sid, fixture.laneId, now, path.join(transcriptDir, `${sid}.log`), now]
        );
      }

      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        metadata: {
          autopilot: {
            enabled: true,
            executorKind: "unified",
            ownerId: "autopilot-owner",
            parallelismCap: 4
          },
          aiDecisions: {
            parallelismCap: 3,
            disableHeuristicParallelism: false,
            source: "ai_decision_service",
            lastDecisionAt: now
          }
        },
        steps: [
          { stepKey: "s1", title: "S1", stepIndex: 0, laneId: fixture.laneId, executorKind: "unified" },
          { stepKey: "s2", title: "S2", stepIndex: 1, laneId: fixture.laneId, executorKind: "unified" },
          { stepKey: "s3", title: "S3", stepIndex: 2, laneId: fixture.laneId, executorKind: "unified" }
        ]
      });

      const gateReport = {
        id: "gate-fail-ai-1",
        generatedAt: new Date().toISOString(),
        generatedBy: "deterministic_kernel",
        overallStatus: "fail",
        gates: [],
        notes: ["forced gate fail for AI cap bypass test"]
      };
      fixture.db.run(
        `
          insert into orchestrator_gate_reports(
            id,
            project_id,
            generated_at,
            report_json
          ) values (?, ?, ?, ?)
        `,
        [gateReport.id, fixture.projectId, gateReport.generatedAt, JSON.stringify(gateReport)]
      );

      const startedAttempts = await fixture.service.startReadyAutopilotAttempts({
        runId: started.run.id,
        reason: "test_ai_cap"
      });
      expect(startedAttempts).toBe(3);

      const runningAttempts = fixture.service
        .listAttempts({ runId: started.run.id })
        .filter((attempt) => attempt.status === "running");
      expect(runningAttempts).toHaveLength(3);

      const timeline = fixture.service.listTimeline({ runId: started.run.id, limit: 100 });
      const capEvents = timeline.filter((entry) => entry.eventType === "autopilot_parallelism_cap_adjusted");
      expect(capEvents.length).toBeGreaterThanOrEqual(1);
      const allReasons = capEvents.flatMap((evt) => {
        const detail = evt.detail as Record<string, unknown> | null;
        return Array.isArray(detail?.reasons)
          ? (detail!.reasons as unknown[]).map((entry) => String(entry))
          : [];
      });
      expect(allReasons).toContain("ai_decision_cap");
      expect(allReasons).not.toContain("gate_fail");
      expect(allReasons).not.toContain("initial_ramp_bypass");
      expect(allReasons).not.toContain("claim_conflicts");
      expect(allReasons).not.toContain("context_pressure");
      expect(allReasons).not.toContain("resource_pressure");
    } finally {
      fixture.dispose();
    }
  });

  it("prioritizes aiPriority when selecting ready steps under constrained autopilot cap", async () => {
    const fixture = await createFixture();
    try {
      const now = "2026-02-19T00:00:00.000Z";
      const transcriptDir = path.join(fixture.projectRoot, ".ade", "transcripts");
      fs.mkdirSync(transcriptDir, { recursive: true });
      fixture.db.run(
        `insert or ignore into terminal_sessions(
          id, lane_id, pty_id, tracked, title, started_at, ended_at,
          exit_code, transcript_path, head_sha_start, head_sha_end,
          status, last_output_preview, summary, tool_type, resume_command, last_output_at
        ) values (?, ?, null, 1, 'Worker', ?, null, null, ?, null, null,
          'running', null, null, 'codex-orchestrated', null, ?)`,
        ["session-1", fixture.laneId, now, path.join(transcriptDir, "session-1.log"), now]
      );

      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        metadata: {
          autopilot: {
            enabled: true,
            executorKind: "unified",
            ownerId: "autopilot-owner",
            parallelismCap: 1
          }
        },
        steps: [
          {
            stepKey: "low-priority",
            title: "Low Priority",
            stepIndex: 0,
            laneId: fixture.laneId,
            executorKind: "unified",
            metadata: { aiPriority: 1 }
          },
          {
            stepKey: "high-priority",
            title: "High Priority",
            stepIndex: 1,
            laneId: fixture.laneId,
            executorKind: "unified",
            metadata: { aiPriority: 50 }
          },
          {
            stepKey: "no-ai-priority",
            title: "No AI Priority",
            stepIndex: 2,
            laneId: fixture.laneId,
            executorKind: "unified"
          }
        ]
      });

      const startedAttempts = await fixture.service.startReadyAutopilotAttempts({
        runId: started.run.id,
        reason: "test_ai_priority_ordering"
      });
      expect(startedAttempts).toBe(1);

      const runningAttempt = fixture.service
        .listAttempts({ runId: started.run.id })
        .find((attempt) => attempt.status === "running");
      expect(runningAttempt).toBeTruthy();
      const highPriorityStep = fixture.service
        .listSteps(started.run.id)
        .find((step) => step.stepKey === "high-priority");
      expect(highPriorityStep).toBeTruthy();
      expect(runningAttempt?.stepId).toBe(highPriorityStep?.id);
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
        defaultExecutorKind: "unified",
        metadata: {
          plannerParallelismCap: 6
        }
      });

      const run = fixture.service.listRuns({ missionId: fixture.missionId })[0];
      expect(run?.metadata?.runMode).toBe("autopilot");
      const autopilot = run?.metadata?.autopilot as Record<string, unknown> | undefined;
      expect(autopilot?.enabled).toBe(true);
      expect(autopilot?.executorKind).toBe("unified");
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

  it("applies teammatePlanMode when deriving per-step plan approval metadata", async () => {
    const requiredFixture = await createFixture({
      projectConfigService: {
        get: () => ({
          effective: {
            ai: {
              orchestrator: {
                teammatePlanMode: "required"
              }
            }
          }
        })
      }
    });
    try {
      const now = "2026-02-22T00:00:00.000Z";
      requiredFixture.db.run(`delete from mission_steps where mission_id = ?`, [requiredFixture.missionId]);
      requiredFixture.db.run(
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
            ('mstep-plan-1', ?, ?, 0, 'Implement feature', null, 'implementation', ?, 'pending', '{"stepKey":"impl-1","stepType":"implementation"}', ?, ?, null, null),
            ('mstep-plan-2', ?, ?, 1, 'Explicit no-plan', null, 'implementation', ?, 'pending', '{"stepKey":"impl-2","stepType":"implementation","requiresPlanApproval":false}', ?, ?, null, null)
        `,
        [
          requiredFixture.missionId,
          requiredFixture.projectId,
          requiredFixture.laneId,
          now,
          now,
          requiredFixture.missionId,
          requiredFixture.projectId,
          requiredFixture.laneId,
          now,
          now
        ]
      );

      const requiredStarted = requiredFixture.service.startRunFromMission({
        missionId: requiredFixture.missionId,
        runMode: "autopilot",
        defaultExecutorKind: "unified"
      });
      const requiredSteps = requiredFixture.service.listSteps(requiredStarted.run.id);
      const inferredStep = requiredSteps.find((step) => step.missionStepId === "mstep-plan-1");
      const explicitStep = requiredSteps.find((step) => step.missionStepId === "mstep-plan-2");
      expect(inferredStep?.metadata?.requiresPlanApproval).toBe(true);
      expect(inferredStep?.metadata?.teammatePlanMode).toBe("required");
      expect(explicitStep?.metadata?.requiresPlanApproval).toBe(false);
    } finally {
      requiredFixture.dispose();
    }

    const offFixture = await createFixture({
      projectConfigService: {
        get: () => ({
          effective: {
            ai: {
              orchestrator: {
                teammatePlanMode: "off"
              }
            }
          }
        })
      }
    });
    try {
      const now = "2026-02-22T00:00:00.000Z";
      offFixture.db.run(`delete from mission_steps where mission_id = ?`, [offFixture.missionId]);
      offFixture.db.run(
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
            ('mstep-plan-3', ?, ?, 0, 'Analyze requirements', null, 'analysis', ?, 'pending', '{"stepKey":"analysis-1","stepType":"analysis"}', ?, ?, null, null),
            ('mstep-plan-4', ?, ?, 1, 'Explicit plan', null, 'analysis', ?, 'pending', '{"stepKey":"analysis-2","stepType":"analysis","requiresPlanApproval":true}', ?, ?, null, null)
        `,
        [
          offFixture.missionId,
          offFixture.projectId,
          offFixture.laneId,
          now,
          now,
          offFixture.missionId,
          offFixture.projectId,
          offFixture.laneId,
          now,
          now
        ]
      );

      const offStarted = offFixture.service.startRunFromMission({
        missionId: offFixture.missionId,
        runMode: "autopilot",
        defaultExecutorKind: "unified"
      });
      const offSteps = offFixture.service.listSteps(offStarted.run.id);
      const inferredAnalysis = offSteps.find((step) => step.missionStepId === "mstep-plan-3");
      const explicitAnalysis = offSteps.find((step) => step.missionStepId === "mstep-plan-4");
      expect(inferredAnalysis?.metadata?.requiresPlanApproval).toBe(false);
      expect(inferredAnalysis?.metadata?.teammatePlanMode).toBe("off");
      expect(explicitAnalysis?.metadata?.requiresPlanApproval).toBe(true);
    } finally {
      offFixture.dispose();
    }
  });

  it("preserves mission phase metadata and initializes phase runtime when starting from a mission", async () => {
    const fixture = await createFixture();
    try {
      const planningPhase = {
        id: "phase-planning",
        phaseKey: "planning",
        name: "Planning",
        description: "Plan the work",
        instructions: "Research the task first.",
        model: { provider: "anthropic", modelId: "anthropic/claude-sonnet-4-6" },
        budget: {},
        orderingConstraints: { mustBeFirst: true },
        askQuestions: { enabled: false },
        validationGate: { tier: "none", required: false, criteria: "" },
        isBuiltIn: true,
        isCustom: false,
        position: 0,
        createdAt: "2026-03-08T00:00:00.000Z",
        updatedAt: "2026-03-08T00:00:00.000Z",
      };
      const releasePhase = {
        id: "phase-release",
        phaseKey: "release",
        name: "Release",
        description: "Ship the change",
        instructions: "Prepare release notes and ship.",
        model: { provider: "openai", modelId: "openai/gpt-5.3-codex" },
        budget: {},
        orderingConstraints: { mustFollow: ["planning"] },
        askQuestions: { enabled: false },
        validationGate: { tier: "self", required: true, criteria: "Release checklist must pass." },
        isBuiltIn: false,
        isCustom: true,
        position: 1,
        createdAt: "2026-03-08T00:00:00.000Z",
        updatedAt: "2026-03-08T00:00:00.000Z",
      };

      fixture.db.run(
        `update missions set metadata_json = ? where id = ? and project_id = ?`,
        [
          JSON.stringify({
            phaseConfiguration: {
              selectedPhases: [planningPhase, releasePhase],
              profileId: "custom-phase-profile"
            },
            missionLevelSettings: {
              prStrategy: { kind: "manual" }
            },
            phaseOverride: [planningPhase, releasePhase],
            phaseProfileId: "custom-phase-profile"
          }),
          fixture.missionId,
          fixture.projectId
        ]
      );

      const started = fixture.service.startRunFromMission({
        missionId: fixture.missionId,
        runMode: "manual",
        defaultExecutorKind: "manual"
      });
      const run = fixture.service.listRuns({ missionId: fixture.missionId }).find((entry) => entry.id === started.run.id);
      const metadata = run?.metadata as Record<string, unknown> | undefined;
      const phaseRuntime = (metadata?.phaseRuntime ?? {}) as Record<string, unknown>;

      expect(metadata?.phaseConfiguration).toEqual({
        selectedPhases: [planningPhase, releasePhase],
        profileId: "custom-phase-profile"
      });
      expect(metadata?.missionLevelSettings).toEqual({
        prStrategy: { kind: "manual" }
      });
      expect(metadata?.phaseOverride).toEqual([planningPhase, releasePhase]);
      expect(metadata?.phaseProfileId).toBe("custom-phase-profile");
      expect(phaseRuntime.currentPhaseKey).toBe("planning");
      expect(phaseRuntime.currentPhaseName).toBe("Planning");
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
      await fixture.service.completeAttempt({
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
      await fixture.service.completeAttempt({
        attemptId: attempt.id,
        status: "blocked",
        errorClass: "policy",
        errorMessage: "Manual intervention required."
      });

      fixture.service.pauseRun({ runId: started.run.id, reason: "policy_block" });
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

  it("keeps retry backoff neutral when AI retry metadata is absent", async () => {
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
      // Explicit caller backoff of 0 overrides exponential default
      await fixture.service.completeAttempt({
        attemptId: attempt.id,
        status: "failed",
        errorClass: "transient",
        errorMessage: "transient failure",
        retryBackoffMs: 0
      });

      const afterFailure = fixture.service.listSteps(started.run.id)[0];
      expect(["pending", "ready"]).toContain(afterFailure?.status);
      expect(Number((afterFailure?.metadata?.lastRetryBackoffMs as number | undefined) ?? -1)).toBe(0);
      fixture.service.tick({ runId: started.run.id });
      const retryReady = fixture.service.listSteps(started.run.id)[0];
      expect(retryReady?.status).toBe("ready");
    } finally {
      fixture.dispose();
    }
  });

  it("uses exponential backoff when no explicit backoff is provided", async () => {
    const fixture = await createFixture();
    try {
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [{ stepKey: "retry-default-exp", title: "Retry Exponential", stepIndex: 0, retryLimit: 1 }]
      });
      const step = fixture.service.listSteps(started.run.id)[0];
      if (!step) throw new Error("Missing step");

      const attempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId: step.id,
        ownerId: "owner"
      });
      // No retryBackoffMs or aiRetryBackoffMs — should use exponential default (10s base)
      await fixture.service.completeAttempt({
        attemptId: attempt.id,
        status: "failed",
        errorClass: "transient",
        errorMessage: "transient failure"
      });

      const afterFailure = fixture.service.listSteps(started.run.id)[0];
      expect(afterFailure?.status).toBe("pending");
      // Exponential backoff: 10_000 * 2^0 = 10_000 for first retry
      expect(Number((afterFailure?.metadata?.lastRetryBackoffMs as number | undefined) ?? -1)).toBe(10_000);
    } finally {
      fixture.dispose();
    }
  });

  it("uses aiRetryBackoffMs metadata for retry scheduling when no caller backoff", async () => {
    const fixture = await createFixture();
    try {
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [
          {
            stepKey: "retryable-ai-backoff",
            title: "Retryable AI Backoff",
            stepIndex: 0,
            retryLimit: 2,
            metadata: {
              aiRetryBackoffMs: 42_000
            }
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
      // No caller retryBackoffMs — AI metadata (42s) should take precedence over exponential default
      await fixture.service.completeAttempt({
        attemptId: attempt.id,
        status: "failed",
        errorClass: "transient",
        errorMessage: "temporary outage"
      });

      const afterFailure = fixture.service.listSteps(started.run.id)[0];
      expect(afterFailure?.status).toBe("pending");
      expect(Number((afterFailure?.metadata?.lastRetryBackoffMs as number | undefined) ?? 0)).toBe(42_000);

      const graph = fixture.service.getRunGraph({ runId: started.run.id, timelineLimit: 0 });
      const recordedAttempt = graph.attempts.find((entry) => entry.id === attempt.id);
      expect(recordedAttempt?.retryBackoffMs).toBe(42_000);
    } finally {
      fixture.dispose();
    }
  });

  it("recovers from retryable failure and succeeds on retry", async () => {
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
      await fixture.service.completeAttempt({
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
      await fixture.service.completeAttempt({
        attemptId: second.id,
        status: "succeeded"
      });

      fixture.service.finalizeRun({ runId: started.run.id, force: true });
      const finalGraph = fixture.service.getRunGraph({ runId: started.run.id, timelineLimit: 0 });
      const finalStep = finalGraph.steps.find((entry) => entry.id === step.id);
      expect(finalStep?.status).toBe("succeeded");
      expect(finalGraph.run.status).toBe("succeeded");
    } finally {
      fixture.dispose();
    }
  });

  it("uses phaseOverride metadata to avoid inventing a disabled testing phase in completion evaluation", async () => {
    const fixture = await createFixture();
    try {
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        metadata: {
          phaseOverride: [
            {
              id: "phase-development",
              phaseKey: "development",
              name: "Development",
              description: "Build",
              instructions: "",
              model: { provider: "openai", modelId: "openai/gpt-5.3-codex" },
              budget: {},
              orderingConstraints: {},
              askQuestions: { enabled: false },
              validationGate: { tier: "none", required: false },
              isBuiltIn: true,
              isCustom: false,
              position: 1,
              createdAt: "2026-03-04T00:00:00.000Z",
              updatedAt: "2026-03-04T00:00:00.000Z",
            },
            {
              id: "phase-validation",
              phaseKey: "validation",
              name: "Validation",
              description: "Validate",
              instructions: "",
              model: { provider: "anthropic", modelId: "anthropic/claude-sonnet-4-6" },
              budget: {},
              orderingConstraints: {},
              askQuestions: { enabled: false },
              validationGate: { tier: "dedicated", required: false },
              isBuiltIn: true,
              isCustom: false,
              position: 2,
              createdAt: "2026-03-04T00:00:00.000Z",
              updatedAt: "2026-03-04T00:00:00.000Z",
            },
          ],
        },
        steps: [
          {
            stepKey: "implement",
            title: "Implement",
            stepIndex: 0,
            metadata: {
              stepType: "implementation",
              phaseKey: "development",
              phaseName: "Development",
            },
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
      await fixture.service.completeAttempt({
        attemptId: attempt.id,
        status: "succeeded"
      });

      const graph = fixture.service.getRunGraph({ runId: started.run.id, timelineLimit: 0 });
      expect(graph.completionEvaluation?.riskFactors).not.toContain("testing_required_but_missing");
      expect(
        graph.completionEvaluation?.diagnostics.some((entry) => entry.message.includes('Required phase "testing"'))
      ).toBe(false);
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
      await fixture.service.completeAttempt({
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
      await fixture.service.completeAttempt({
        attemptId: second.id,
        status: "failed",
        errorClass: "transient",
        errorMessage: "attempt two"
      });

      fixture.service.finalizeRun({ runId: started.run.id, force: true });
      const graph = fixture.service.getRunGraph({ runId: started.run.id, timelineLimit: 0 });
      const finalStep = graph.steps.find((entry) => entry.id === step.id);
      expect(finalStep?.status).toBe("failed");
      expect(finalStep?.retryCount).toBe(1);
      expect(graph.run.status).toBe("failed");
    } finally {
      fixture.dispose();
    }
  });

  it("matches null step ids when resolving run-level interventions during finalize", async () => {
    const fixture = await createFixture();
    try {
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [{ stepKey: "finalize-step", title: "Finalize Step", stepIndex: 0 }]
      });
      const step = fixture.service.listSteps(started.run.id)[0];
      if (!step) throw new Error("Missing step");

      const attempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId: step.id,
        ownerId: "owner"
      });
      await fixture.service.completeAttempt({
        attemptId: attempt.id,
        status: "succeeded"
      });

      fixture.service.appendRuntimeEvent({
        runId: started.run.id,
        stepId: null,
        eventType: "intervention_opened",
        eventKey: "run-level-intervention"
      });
      fixture.service.appendRuntimeEvent({
        runId: started.run.id,
        stepId: null,
        eventType: "intervention_resolved",
        eventKey: "run-level-intervention-resolved"
      });

      const finalized = fixture.service.finalizeRun({ runId: started.run.id });
      expect(finalized.finalized).toBe(true);
      expect(finalized.blockers).toHaveLength(0);
      expect(finalized.finalStatus).toBe("succeeded");
    } finally {
      fixture.dispose();
    }
  });

  it("does not let force finalize bypass required phase success", async () => {
    const fixture = await createFixture();
    try {
      const developmentPhase = {
        id: "phase-development",
        phaseKey: "development",
        name: "Development",
        description: "Build the feature.",
        instructions: "Implement the feature.",
        model: { provider: "openai", modelId: "openai/gpt-5.3-codex" },
        budget: {},
        orderingConstraints: {},
        askQuestions: { enabled: false },
        validationGate: { tier: "dedicated", required: true, criteria: "Implementation must actually succeed" },
        isBuiltIn: true,
        isCustom: false,
        position: 1,
        createdAt: "2026-03-04T00:00:00.000Z",
        updatedAt: "2026-03-04T00:00:00.000Z",
      };
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        metadata: {
          phaseConfiguration: { selectedPhases: [developmentPhase] },
          missionLevelSettings: { prStrategy: { kind: "manual" } },
        },
        steps: [
          {
            stepKey: "impl",
            title: "Implementation",
            stepIndex: 0,
            metadata: {
              stepType: "implementation",
              phaseKey: "development",
              phaseName: "Development",
            },
          },
        ],
      });
      const step = fixture.service.listSteps(started.run.id)[0];
      if (!step) throw new Error("Missing step");
      fixture.service.skipStep({
        runId: started.run.id,
        stepId: step.id,
        reason: "Skipped by coordinator",
      });

      const finalized = fixture.service.finalizeRun({ runId: started.run.id, force: true });
      const run = fixture.service.listRuns({ missionId: fixture.missionId }).find((entry) => entry.id === started.run.id);

      expect(finalized.finalized).toBe(false);
      expect(finalized.finalStatus).toBe("completing");
      expect(finalized.blockers.some((entry) => entry.includes("without any successful work"))).toBe(true);
      expect(run?.status).toBe("completing");
    } finally {
      fixture.dispose();
    }
  });

  it("keeps interventions on the same step distinct until each interventionId is resolved", async () => {
    const fixture = await createFixture();
    try {
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [{ stepKey: "finalize-step", title: "Finalize Step", stepIndex: 0 }],
      });
      const step = fixture.service.listSteps(started.run.id)[0];
      if (!step) throw new Error("Missing step");

      const attempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId: step.id,
        ownerId: "owner",
      });
      await fixture.service.completeAttempt({
        attemptId: attempt.id,
        status: "succeeded",
      });

      fixture.service.appendRuntimeEvent({
        runId: started.run.id,
        stepId: step.id,
        eventType: "intervention_opened",
        eventKey: "intervention-opened-1",
        payload: { interventionId: "intervention-1" },
      });
      fixture.service.appendRuntimeEvent({
        runId: started.run.id,
        stepId: step.id,
        eventType: "intervention_opened",
        eventKey: "intervention-opened-2",
        payload: { interventionId: "intervention-2" },
      });
      fixture.service.appendRuntimeEvent({
        runId: started.run.id,
        stepId: step.id,
        eventType: "intervention_resolved",
        eventKey: "intervention-resolved-1",
        payload: { interventionId: "intervention-1" },
      });

      const blocked = fixture.service.finalizeRun({ runId: started.run.id });
      expect(blocked.finalized).toBe(false);
      expect(blocked.blockers).toEqual(
        expect.arrayContaining([expect.stringContaining("unresolved intervention")]),
      );

      fixture.service.appendRuntimeEvent({
        runId: started.run.id,
        stepId: step.id,
        eventType: "intervention_resolved",
        eventKey: "intervention-resolved-2",
        payload: { interventionId: "intervention-2" },
      });

      const finalized = fixture.service.finalizeRun({ runId: started.run.id });
      expect(finalized.finalized).toBe(true);
      expect(finalized.finalStatus).toBe("succeeded");
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
      const now = "2026-02-19T00:00:00.000Z";
      const transcriptDir = path.join(fixture.projectRoot, ".ade", "transcripts");
      fs.mkdirSync(transcriptDir, { recursive: true });
      // Pre-insert terminal_sessions rows for sessions the default adapter will create.
      // session-1 for the first step, session-2 for the second (auto-advanced).
      for (let i = 1; i <= 2; i++) {
        const sid = `session-${i}`;
        fixture.db.run(
          `insert or ignore into terminal_sessions(
            id, lane_id, pty_id, tracked, title, started_at, ended_at,
            exit_code, transcript_path, head_sha_start, head_sha_end,
            status, last_output_preview, summary, tool_type, resume_command, last_output_at
          ) values (?, ?, null, 1, 'Worker', ?, null, null, ?, null, null,
            'running', null, null, 'codex-orchestrated', null, ?)`,
          [sid, fixture.laneId, now, path.join(transcriptDir, `${sid}.log`), now]
        );
      }

      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        metadata: {
          autopilot: {
            enabled: true,
            executorKind: "unified",
            ownerId: "orchestrator-autopilot"
          }
        },
        steps: [
          {
            stepKey: "first",
            title: "First",
            stepIndex: 0,
            laneId: fixture.laneId,
            executorKind: "unified"
          },
          {
            stepKey: "second",
            title: "Second",
            stepIndex: 1,
            dependencyStepKeys: ["first"],
            laneId: fixture.laneId,
            executorKind: "unified"
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
      const transcriptPath = path.join(transcriptDir, `${firstAttempt.executorSessionId}.log`);
      fs.writeFileSync(
        transcriptPath,
        "Implemented the first step and verified the result before exiting.\n",
        "utf8"
      );

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

  it("hydrates tracked-session success summaries from transcript tails when no explicit result was reported", async () => {
    const fixture = await createFixture();
    try {
      const now = "2026-02-19T00:00:00.000Z";
      const transcriptDir = path.join(fixture.projectRoot, ".ade", "transcripts");
      fs.mkdirSync(transcriptDir, { recursive: true });
      const preSessionId = "session-1";
      const transcriptPath = path.join(transcriptDir, `${preSessionId}.log`);
      fixture.db.run(
        `insert or ignore into terminal_sessions(
          id, lane_id, pty_id, tracked, title, started_at, ended_at,
          exit_code, transcript_path, head_sha_start, head_sha_end,
          status, last_output_preview, summary, tool_type, resume_command, last_output_at
        ) values (?, ?, null, 1, 'Worker', ?, null, null, ?, null, null,
          'running', null, null, 'codex-orchestrated', null, ?)`,
        [preSessionId, fixture.laneId, now, transcriptPath, now]
      );

      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [
          {
            stepKey: "planning-worker",
            title: "Planning Worker",
            stepIndex: 0,
            laneId: fixture.laneId,
            executorKind: "unified"
          }
        ]
      });
      const stepId = fixture.service.listSteps(started.run.id)[0]?.id;
      if (!stepId) throw new Error("Expected planning step");

      const attempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId,
        ownerId: "operator"
      });
      if (!attempt.executorSessionId) throw new Error("Expected running session-backed attempt");

      fs.writeFileSync(
        transcriptPath,
        "looking at router wiring first\n\nThe plan is ready. The implementation requires 4 targeted changes across 3 existing files plus 1 new file.\n",
        "utf8"
      );

      const reconciled = await fixture.service.onTrackedSessionEnded({
        sessionId: attempt.executorSessionId,
        laneId: fixture.laneId,
        exitCode: 0
      });
      expect(reconciled).toBe(1);

      const after = fixture.service.listAttempts({ runId: started.run.id }).find((entry) => entry.id === attempt.id);
      expect(after?.status).toBe("succeeded");
      expect(after?.resultEnvelope?.summary).toContain("The plan is ready.");
    } finally {
      fixture.dispose();
    }
  });

  it("fails a planning worker that exits cleanly with only shell bootstrap noise", async () => {
    const fixture = await createFixture();
    try {
      const now = "2026-02-19T00:00:00.000Z";
      const transcriptDir = path.join(fixture.projectRoot, ".ade", "transcripts");
      fs.mkdirSync(transcriptDir, { recursive: true });
      const preSessionId = "session-1";
      const transcriptPath = path.join(transcriptDir, `${preSessionId}.log`);
      fixture.db.run(
        `insert or ignore into terminal_sessions(
          id, lane_id, pty_id, tracked, title, started_at, ended_at,
          exit_code, transcript_path, head_sha_start, head_sha_end,
          status, last_output_preview, summary, tool_type, resume_command, last_output_at
        ) values (?, ?, null, 1, 'Worker', ?, null, null, ?, null, null,
          'running', null, null, 'claude-orchestrated', null, ?)`,
        [preSessionId, fixture.laneId, now, transcriptPath, now]
      );

      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [
          {
            stepKey: "planning-worker",
            title: "Planning Worker",
            stepIndex: 0,
            laneId: fixture.laneId,
            executorKind: "unified",
            metadata: {
              stepType: "planning",
              readOnlyExecution: true,
            },
          }
        ]
      });
      const stepId = fixture.service.listSteps(started.run.id)[0]?.id;
      if (!stepId) throw new Error("Expected planning step");

      const attempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId,
        ownerId: "operator"
      });
      if (!attempt.executorSessionId) throw new Error("Expected running session-backed attempt");

      fs.writeFileSync(
        transcriptPath,
        [
          "ADE_MISSION_ID='mission-1' ADE_RUN_ID='run-1' exec claude --model 'sonnet' --permission-mode 'default'",
          "/Users/admin/.zshrc:3: no such file or directory: /Users/admin/.openclaw/get-codex-token.sh",
          "/Users/admin/.openclaw/completions/openclaw.zsh:3803: command not found: compdef",
          "admin@Mac test-10-f4bb12de %",
          "-p \"$(cat '/Users/admin/Projects/ADE/.ade/orchestrator/worker-prompts/worker-123.txt')\"",
        ].join("\n"),
        "utf8"
      );

      const reconciled = await fixture.service.onTrackedSessionEnded({
        sessionId: attempt.executorSessionId,
        laneId: fixture.laneId,
        exitCode: 0
      });
      expect(reconciled).toBe(1);

      const after = fixture.service.listAttempts({ runId: started.run.id }).find((entry) => entry.id === attempt.id);
      expect(after?.status).toBe("failed");
      expect(after?.errorMessage).toBe("Planning worker exited before producing any assistant or tool activity.");
      expect(after?.errorClass).toBe("startup_failure");
    } finally {
      fixture.dispose();
    }
  });

  it("classifies planning workers with lifecycle-only chat transcripts as interrupted", async () => {
    const fixture = await createFixture();
    try {
      const now = "2026-02-19T00:00:00.000Z";
      const transcriptDir = path.join(fixture.projectRoot, ".ade", "transcripts");
      fs.mkdirSync(transcriptDir, { recursive: true });
      const preSessionId = "session-1";
      const transcriptPath = path.join(transcriptDir, `${preSessionId}.chat.jsonl`);
      fixture.db.run(
        `insert or ignore into terminal_sessions(
          id, lane_id, pty_id, tracked, title, started_at, ended_at,
          exit_code, transcript_path, head_sha_start, head_sha_end,
          status, last_output_preview, summary, tool_type, resume_command, last_output_at
        ) values (?, ?, null, 1, 'Worker', ?, null, null, ?, null, null,
          'running', null, null, 'claude-orchestrated', null, ?)`,
        [preSessionId, fixture.laneId, now, transcriptPath, now]
      );

      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [
          {
            stepKey: "planning-worker",
            title: "Planning Worker",
            stepIndex: 0,
            laneId: fixture.laneId,
            executorKind: "unified",
            metadata: {
              stepType: "planning",
              readOnlyExecution: true,
            },
          }
        ]
      });
      const stepId = fixture.service.listSteps(started.run.id)[0]?.id;
      if (!stepId) throw new Error("Expected planning step");

      const attempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId,
        ownerId: "operator"
      });
      if (!attempt.executorSessionId) throw new Error("Expected running session-backed attempt");

      fs.writeFileSync(
        transcriptPath,
        [
          JSON.stringify({
            sessionId: attempt.executorSessionId,
            timestamp: now,
            event: {
              type: "status",
              turnStatus: "started",
            },
          }),
        ].join("\n"),
        "utf8"
      );

      const reconciled = await fixture.service.onTrackedSessionEnded({
        sessionId: attempt.executorSessionId,
        laneId: fixture.laneId,
        exitCode: 0
      });
      expect(reconciled).toBe(1);

      const after = fixture.service.listAttempts({ runId: started.run.id }).find((entry) => entry.id === attempt.id);
      expect(after?.status).toBe("failed");
      expect(after?.errorClass).toBe("interrupted");
      expect(after?.errorMessage).toBe("Planning worker session started but was interrupted before producing any assistant or tool activity.");
    } finally {
      fixture.dispose();
    }
  });

  it("derives tracked-session completion status from terminal session state when exit code is missing", async () => {
    const fixture = await createFixture();
    try {
      const now = "2026-02-19T00:00:00.000Z";
      const transcriptDir = path.join(fixture.projectRoot, ".ade", "transcripts");
      fs.mkdirSync(transcriptDir, { recursive: true });
      // Pre-insert terminal_sessions row so startAttempt finds it when the default adapter returns.
      const preSessionId = "session-1";
      fixture.db.run(
        `insert or ignore into terminal_sessions(
          id, lane_id, pty_id, tracked, title, started_at, ended_at,
          exit_code, transcript_path, head_sha_start, head_sha_end,
          status, last_output_preview, summary, tool_type, resume_command, last_output_at
        ) values (?, ?, null, 1, 'Worker', ?, null, null, ?, null, null,
          'running', null, null, 'codex-orchestrated', null, ?)`,
        [preSessionId, fixture.laneId, now, path.join(transcriptDir, `${preSessionId}.log`), now]
      );

      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [
          {
            stepKey: "first",
            title: "First",
            stepIndex: 0,
            laneId: fixture.laneId,
            executorKind: "unified"
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
      fs.writeFileSync(
        path.join(transcriptDir, `${firstAttempt.executorSessionId}.log`),
        "Completed the worker step and reported the outcome.\n",
        "utf8"
      );

      // Update the pre-inserted row to simulate a completed session (for deriving status).
      fixture.db.run(
        `update terminal_sessions set status = 'completed', ended_at = ? where id = ?`,
        ["2026-02-20T00:05:00.000Z", firstAttempt.executorSessionId]
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
      expect(snapshot?.cursor.docsMode).toBe("digest_ref");
      expect(snapshot?.cursor.docsBudgetBytes).toBe(64);
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

  it("creates context snapshots without lane pack bootstrap refresh", async () => {
    let laneExportCalls = 0;
    const fixture = await createFixture({});
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
      const snapshot = fixture.service
        .listContextSnapshots({ runId: started.run.id })
        .find((entry) => entry.id === attempt.contextSnapshotId);
      expect(attempt.contextSnapshotId).toBeTruthy();
      expect(laneExportCalls).toBe(1);
      expect(snapshot?.cursor.contextSources?.some((source) => source.startsWith("context_export:project:"))).toBe(true);
      expect(snapshot?.cursor.contextSources?.some((source) => source.startsWith("context_export:lane:"))).toBe(true);
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
        kind: "unified",
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
            executorKind: "unified"
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

  it("applies mission-level permission overrides even when project ai.permissions are absent", async () => {
    const fixture = await createFixture();
    try {
      fixture.db.run(
        `update missions set metadata_json = ? where id = ? and project_id = ?`,
        [
          JSON.stringify({
            launch: {
              permissionConfig: {
                cli: { mode: "edit", sandboxPermissions: "danger-full-access" },
                inProcess: { mode: "plan" }
              }
            }
          }),
          fixture.missionId,
          fixture.projectId
        ]
      );

      let capturedPermissionConfig: Record<string, unknown> | undefined;
      fixture.service.registerExecutorAdapter({
        kind: "unified",
        start: async (args) => {
          capturedPermissionConfig = args.permissionConfig as Record<string, unknown> | undefined;
          return {
            status: "completed",
            result: {
              schema: "ade.orchestratorAttempt.v1",
              success: true,
              summary: "ok",
              outputs: null,
              warnings: [],
              sessionId: null,
              trackedSession: false
            }
          };
        }
      });

      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [
          {
            stepKey: "permissions-override",
            title: "Permissions override",
            stepIndex: 0,
            executorKind: "unified",
            metadata: {
              modelId: "anthropic/claude-sonnet-4-6"
            }
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

      expect(attempt.status).toBe("succeeded");
      const cli = capturedPermissionConfig?.cli as Record<string, unknown> | undefined;
      const inProcess = capturedPermissionConfig?.inProcess as Record<string, unknown> | undefined;
      expect(cli?.mode).toBe("edit");
      expect(cli?.sandboxPermissions).toBe("danger-full-access");
      expect(inProcess?.mode).toBe("plan");
    } finally {
      fixture.dispose();
    }
  });

  it("uses safe permission defaults when project and mission permission settings are missing", async () => {
    const fixture = await createFixture();
    try {
      let capturedPermissionConfig: Record<string, unknown> | undefined;
      fixture.service.registerExecutorAdapter({
        kind: "unified",
        start: async (args) => {
          capturedPermissionConfig = args.permissionConfig as Record<string, unknown> | undefined;
          return {
            status: "completed",
            result: {
              schema: "ade.orchestratorAttempt.v1",
              success: true,
              summary: "ok",
              outputs: null,
              warnings: [],
              sessionId: null,
              trackedSession: false
            }
          };
        }
      });

      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [
          {
            stepKey: "permissions-defaults",
            title: "Permissions defaults",
            stepIndex: 0,
            executorKind: "unified",
            metadata: {
              modelId: "openai/gpt-5.3-codex"
            }
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

      expect(attempt.status).toBe("succeeded");
      const cli = capturedPermissionConfig?.cli as Record<string, unknown> | undefined;
      const inProcess = capturedPermissionConfig?.inProcess as Record<string, unknown> | undefined;
      expect(cli?.mode).toBe("full-auto");
      expect(cli?.sandboxPermissions).toBe("workspace-write");
      expect(inProcess?.mode).toBe("full-auto");
    } finally {
      fixture.dispose();
    }
  });

  it("runs non-CLI unified attempts in-process without spawning terminal sessions", async () => {
    const executeViaUnified = vi.fn(async () => ({
      text: "api/local execution completed",
      structuredOutput: { ok: true },
      sessionId: null
    }));
    const memoryService = {
      writeMemory: vi.fn(),
      getMemoryBudget: vi.fn(() => []),
    };
    const fixture = await createFixture({
      aiIntegrationService: {
        executeViaUnified
      },
      memoryService,
    });
    try {
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [
          {
            stepKey: "api-worker",
            title: "API worker",
            stepIndex: 0,
            laneId: fixture.laneId,
            executorKind: "unified",
            metadata: {
              modelId: "openai/gpt-4.1"
            }
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

      expect(attempt.status).toBe("succeeded");
      expect(attempt.resultEnvelope?.trackedSession).toBe(false);
      expect(fixture.ptyCreateCalls).toHaveLength(0);
      expect(executeViaUnified).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: fixture.projectId,
          runId: started.run.id,
          stepId: step.id,
          attemptId: attempt.id,
          memoryService,
        })
      );
    } finally {
      fixture.dispose();
    }
  });

  it("passes explicit employee agent memory context into in-process worker briefings", async () => {
    const executeViaUnified = vi.fn(async () => ({
      text: "api/local execution completed",
      structuredOutput: { ok: true },
      sessionId: null
    }));
    const buildBriefing = vi.fn(async () => ({
      project: [],
      mission: [],
      sharedFacts: [],
      episodic: [],
      agent: [],
    }));
    const fixture = await createFixture({
      aiIntegrationService: {
        executeViaUnified,
      },
      memoryService: {
        writeMemory: vi.fn(),
        getMemoryBudget: vi.fn(() => []),
      },
      memoryBriefingService: {
        buildBriefing,
      },
    });
    try {
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        metadata: {
          employeeAgentId: "employee-42",
        },
        steps: [
          {
            stepKey: "api-worker-memory",
            title: "API worker memory",
            stepIndex: 0,
            laneId: fixture.laneId,
            executorKind: "unified",
            metadata: {
              modelId: "openai/gpt-4.1",
            },
          },
        ],
      });
      const step = fixture.service.listSteps(started.run.id)[0];
      if (!step) throw new Error("Missing step");

      const attempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId: step.id,
        ownerId: "owner",
      });

      expect(attempt.status).toBe("succeeded");
      expect(buildBriefing).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: fixture.projectId,
          missionId: fixture.missionId,
          runId: started.run.id,
          agentId: "employee-42",
          includeAgentMemory: true,
          taskDescription: "API worker memory",
          mode: "mission_worker",
        }),
      );
    } finally {
      fixture.dispose();
    }
  });

  it("passes explicit employee agent memory context into CLI-backed worker briefings", async () => {
    const buildBriefing = vi.fn(async () => ({
      project: [],
      mission: [],
      sharedFacts: [],
      episodic: [],
      agent: [],
    }));
    const fixture = await createFixture({
      memoryService: {
        writeMemory: vi.fn(),
        getMemoryBudget: vi.fn(() => []),
      },
      memoryBriefingService: {
        buildBriefing,
      },
    });
    try {
      fixture.service.registerExecutorAdapter({
        kind: "unified",
        start: async () => ({
          status: "completed",
          result: {
            schema: "ade.orchestratorAttempt.v1",
            success: true,
            summary: "ok",
            outputs: null,
            warnings: [],
            sessionId: null,
            trackedSession: false,
          },
        }),
      });

      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        metadata: {
          employeeAgentId: "employee-84",
        },
        steps: [
          {
            stepKey: "cli-worker-memory",
            title: "CLI worker memory",
            stepIndex: 0,
            laneId: fixture.laneId,
            executorKind: "unified",
            metadata: {
              modelId: "anthropic/claude-sonnet-4-6",
            },
          },
        ],
      });
      const step = fixture.service.listSteps(started.run.id)[0];
      if (!step) throw new Error("Missing step");

      const attempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId: step.id,
        ownerId: "owner",
      });

      expect(attempt.status).toBe("succeeded");
      expect(buildBriefing).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: fixture.projectId,
          missionId: fixture.missionId,
          runId: started.run.id,
          agentId: "employee-84",
          includeAgentMemory: true,
          taskDescription: "CLI worker memory",
          mode: "mission_worker",
        }),
      );
    } finally {
      fixture.dispose();
    }
  });

  it("omits agent memory briefing context when a run has no explicit employee agent id", async () => {
    const buildBriefing = vi.fn(async () => ({
      project: [],
      mission: [],
      sharedFacts: [],
      episodic: [],
      agent: [],
    }));
    const fixture = await createFixture({
      memoryService: {
        writeMemory: vi.fn(),
        getMemoryBudget: vi.fn(() => []),
      },
      memoryBriefingService: {
        buildBriefing,
      },
    });
    try {
      fixture.service.registerExecutorAdapter({
        kind: "unified",
        start: async () => ({
          status: "completed",
          result: {
            schema: "ade.orchestratorAttempt.v1",
            success: true,
            summary: "ok",
            outputs: null,
            warnings: [],
            sessionId: null,
            trackedSession: false,
          },
        }),
      });

      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [
          {
            stepKey: "cli-worker-no-employee",
            title: "CLI worker no employee",
            stepIndex: 0,
            laneId: fixture.laneId,
            executorKind: "unified",
            metadata: {
              modelId: "anthropic/claude-sonnet-4-6",
            },
          },
        ],
      });
      const step = fixture.service.listSteps(started.run.id)[0];
      if (!step) throw new Error("Missing step");

      const attempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId: step.id,
        ownerId: "owner",
      });

      expect(attempt.status).toBe("succeeded");
      const firstBriefingCall = buildBriefing.mock.calls.at(0) as unknown[] | undefined;
      const briefingArgs = firstBriefingCall?.[0] as Record<string, unknown> | undefined;
      expect(briefingArgs).toBeTruthy();
      expect(briefingArgs?.agentId).toBeUndefined();
      expect(briefingArgs?.includeAgentMemory).toBeUndefined();
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
      await fixture.service.completeAttempt({
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
      await fixture.service.completeAttempt({
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

  it("keeps tick as a no-op for paused runs", async () => {
    const fixture = await createFixture();
    try {
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [{ stepKey: "paused-guard", title: "Paused guard", stepIndex: 0 }]
      });

      const paused = fixture.service.pauseRun({
        runId: started.run.id,
        reason: "manual_pause_for_review"
      });
      expect(paused.status).toBe("paused");

      const before = fixture.service.listRuns({ missionId: fixture.missionId }).find((run) => run.id === started.run.id);
      const timelineBefore = fixture.service.listTimeline({ runId: started.run.id, limit: 100 }).length;

      const ticked = fixture.service.tick({ runId: started.run.id });
      const after = fixture.service.listRuns({ missionId: fixture.missionId }).find((run) => run.id === started.run.id);
      const timelineAfter = fixture.service.listTimeline({ runId: started.run.id, limit: 100 }).length;

      expect(ticked.status).toBe("paused");
      expect(after?.status).toBe("paused");
      expect(after?.updatedAt).toBe(before?.updatedAt);
      expect(timelineAfter).toBe(timelineBefore);
    } finally {
      fixture.dispose();
    }
  });

  it("keeps tick as a no-op for completing runs", async () => {
    const fixture = await createFixture();
    try {
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [{ stepKey: "completion-guard", title: "Completion guard", stepIndex: 0 }]
      });

      const completing = fixture.service.requestCompletion(started.run.id);
      expect(completing.status).toBe("completing");

      const before = fixture.service.listRuns({ missionId: fixture.missionId }).find((run) => run.id === started.run.id);
      const timelineBefore = fixture.service.listTimeline({ runId: started.run.id, limit: 100 }).length;

      const ticked = fixture.service.tick({ runId: started.run.id });
      const after = fixture.service.listRuns({ missionId: fixture.missionId }).find((run) => run.id === started.run.id);
      const timelineAfter = fixture.service.listTimeline({ runId: started.run.id, limit: 100 }).length;

      expect(ticked.status).toBe("completing");
      expect(after?.status).toBe("completing");
      expect(after?.updatedAt).toBe(before?.updatedAt);
      expect(timelineAfter).toBe(timelineBefore);
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
      await fixture.service.completeAttempt({ attemptId: attempt.id, status: "succeeded" });

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
      await fixture.service.completeAttempt({
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

  it("accepted attempt triggers autopilot advancement for sibling ready steps", async () => {
    const fixture = await createFixture();
    try {
      // Register an adapter that returns "accepted" with a sessionId.
      // We need a terminal_sessions row so the session lookup succeeds.
      const now = "2026-02-19T00:00:00.000Z";
      const transcriptDir = path.join(fixture.projectRoot, ".ade", "transcripts");
      fs.mkdirSync(transcriptDir, { recursive: true });

      let adapterCallCount = 0;
      fixture.service.registerExecutorAdapter({
        kind: "unified",
        start: async () => {
          adapterCallCount += 1;
          const sessionId = `adapter-session-${adapterCallCount}`;
          // Insert a terminal_sessions row for each accepted session
          fixture.db.run(
            `
              insert or ignore into terminal_sessions(
                id, lane_id, pty_id, tracked, title, started_at, ended_at,
                exit_code, transcript_path, head_sha_start, head_sha_end,
                status, last_output_preview, summary, tool_type, resume_command, last_output_at
              ) values (?, ?, null, 1, 'Worker', ?, null, null, ?, null, null,
                'running', null, null, 'codex-orchestrated', null, ?)
            `,
            [sessionId, fixture.laneId, now, path.join(transcriptDir, `${sessionId}.log`), now]
          );
          return {
            status: "accepted" as const,
            sessionId,
            metadata: { adapterKind: "unified" }
          };
        }
      });

      // Create a run with 2 independent steps (no dependencies) in autopilot mode
      const now2 = "2026-02-19T00:00:00.000Z";
      fixture.db.run(
        `
          insert into mission_steps(
            id, mission_id, project_id, step_index, title, detail, kind,
            lane_id, status, metadata_json, created_at, updated_at, started_at, completed_at
          ) values
            ('mstep-a', ?, ?, 0, 'Step A', null, 'implementation', ?, 'pending', '{"stepType":"implementation","dependencyStepKeys":[]}', ?, ?, null, null),
            ('mstep-b', ?, ?, 1, 'Step B', null, 'implementation', ?, 'pending', '{"stepType":"implementation","dependencyStepKeys":[]}', ?, ?, null, null)
        `,
        [
          fixture.missionId, fixture.projectId, fixture.laneId, now2, now2,
          fixture.missionId, fixture.projectId, fixture.laneId, now2, now2
        ]
      );

      const started = fixture.service.startRunFromMission({
        missionId: fixture.missionId,
        runMode: "autopilot",
        defaultExecutorKind: "unified",
        metadata: { plannerParallelismCap: 4 }
      });

      // Wait for the async autopilot advancement triggered by startRun (initial pass)
      // plus the deferred accepted_step_advance pass (50ms) for the second step
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Both steps should now be running because:
      // 1. The first step's adapter returns "accepted"
      // 2. The accepted-step-advance logic fires startReadyAutopilotAttempts
      // 3. The second step (also ready) gets started
      const attempts = fixture.service.listAttempts({ runId: started.run.id });
      const runningAttempts = attempts.filter((a) => a.status === "running");
      expect(runningAttempts.length).toBeGreaterThanOrEqual(2);
      expect(adapterCallCount).toBeGreaterThanOrEqual(2);

      // Verify the attempts have sessionIds attached
      for (const attempt of runningAttempts) {
        expect(attempt.executorSessionId).toBeTruthy();
      }

      // Verify timeline has autopilot_advance event
      const timeline = fixture.service.listTimeline({ runId: started.run.id, limit: 100 });
      expect(timeline.some((e) => e.eventType === "autopilot_advance")).toBe(true);
    } finally {
      fixture.dispose();
    }
  });

  it("accepted attempt with missing terminal session still marks attempt running", async () => {
    const fixture = await createFixture();
    try {
      // Register adapter that returns accepted with a sessionId, but do NOT insert
      // a terminal_sessions row — the session doesn't exist in the database.
      fixture.service.registerExecutorAdapter({
        kind: "unified",
        start: async () => ({
          status: "accepted" as const,
          sessionId: "ghost-session-999",
          metadata: { adapterKind: "unified" }
        })
      });

      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [
          {
            stepKey: "orphan-session-step",
            title: "Step with missing session",
            stepIndex: 0,
            executorKind: "unified"
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

      // The attempt should be marked as failed because the session row doesn't
      // exist in terminal_sessions — the P0 fix catches this and fails fast.
      expect(attempt.status).toBe("failed");
      expect(attempt.errorClass).toBe("executor_failure");
      expect(attempt.errorMessage).toContain("Session row not found");

      // Timeline should have executor_session_missing event
      const timeline = fixture.service.listTimeline({ runId: started.run.id, limit: 50 });
      expect(timeline.some((e) => e.eventType === "executor_session_missing")).toBe(true);
    } finally {
      fixture.dispose();
    }
  });

  it("auto-spawns one dedicated validator and emits validation_contract_unfulfilled on required step success", async () => {
    const fixture = await createFixture();
    try {
      const phaseCard = {
        id: "phase-implementation",
        phaseKey: "implementation",
        name: "Implementation",
        description: "Build",
        instructions: "",
        model: { provider: "openai", modelId: "openai/gpt-5.3-codex" },
        budget: {},
        orderingConstraints: {},
        askQuestions: { enabled: false },
        validationGate: { tier: "dedicated", required: true, criteria: "Validator must pass before moving on" },
        isBuiltIn: true,
        isCustom: false,
        position: 1,
        createdAt: "2026-03-04T00:00:00.000Z",
        updatedAt: "2026-03-04T00:00:00.000Z",
      };
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        metadata: {
          phaseConfiguration: { selectedPhases: [phaseCard] },
          phaseRuntime: {
            currentPhaseKey: "implementation",
            currentPhaseName: "Implementation",
            currentPhaseModel: {
              provider: "openai",
              modelId: "openai/gpt-5.3-codex",
            }
          }
        },
        steps: [
          {
            stepKey: "impl_auth",
            title: "Implement auth flow",
            stepIndex: 0,
            metadata: {
              stepType: "implementation",
              phaseKey: "implementation",
              phaseName: "Implementation",
              phasePosition: 1,
              validationContract: {
                level: "step",
                tier: "dedicated",
                required: true,
                criteria: "Validator must pass before moving on",
                evidence: [],
                maxRetries: 2
              }
            }
          }
        ]
      });
      const implStep = fixture.service.listSteps(started.run.id).find((step) => step.stepKey === "impl_auth");
      if (!implStep) throw new Error("Missing implementation step");
      const attempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId: implStep.id,
        ownerId: "owner"
      });

      await fixture.service.completeAttempt({
        attemptId: attempt.id,
        status: "succeeded",
        result: {
          schema: "ade.orchestratorAttempt.v1",
          success: true,
          summary: "Auth flow implemented.",
          outputs: {
            filesChanged: ["src/auth.ts"],
            testsRun: { passed: 4, failed: 0, skipped: 1 }
          },
          warnings: [],
          sessionId: null,
          trackedSession: false
        }
      });

      const steps = fixture.service.listSteps(started.run.id);
      const validators = steps.filter((step) => {
        const meta = (step.metadata ?? {}) as Record<string, unknown>;
        return meta.autoSpawnedValidation === true && meta.targetStepId === implStep.id;
      });
      expect(validators).toHaveLength(1);
      expect(validators[0]?.dependencyStepIds).toContain(implStep.id);
      const validatorMeta = (validators[0]?.metadata ?? {}) as Record<string, unknown>;
      const validatorContract = (validatorMeta.validationContract ?? {}) as Record<string, unknown>;
      expect(validatorMeta.targetStepKey).toBe("impl_auth");
      expect(validatorMeta.phaseKey).toBe("implementation");
      expect(validatorMeta.phaseName).toBe("Implementation");
      expect(validatorContract.required).toBe(true);
      expect(validatorContract.tier).toBe("dedicated");

      const runtimeEvents = fixture.service.listRuntimeEvents({ runId: started.run.id, limit: 100 });
      expect(runtimeEvents.some((event) => {
        if (event.eventType !== "validation_contract_unfulfilled") return false;
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        return payload.stepKey === "impl_auth";
      })).toBe(true);
      const timeline = fixture.service.listTimeline({ runId: started.run.id, limit: 100 });
      expect(timeline.some((event) => event.eventType === "validation_auto_spawned")).toBe(true);
    } finally {
      fixture.dispose();
    }
  });

  it("does not create duplicate auto-spawned validator for the same target step", async () => {
    const fixture = await createFixture();
    try {
      const phaseCard = {
        id: "phase-implementation",
        phaseKey: "implementation",
        name: "Implementation",
        description: "Build",
        instructions: "",
        model: { provider: "openai", modelId: "openai/gpt-5.3-codex" },
        budget: {},
        orderingConstraints: {},
        askQuestions: { enabled: false },
        validationGate: { tier: "dedicated", required: true, criteria: "Validator must pass before moving on" },
        isBuiltIn: true,
        isCustom: false,
        position: 1,
        createdAt: "2026-03-04T00:00:00.000Z",
        updatedAt: "2026-03-04T00:00:00.000Z",
      };
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        metadata: {
          phaseConfiguration: { selectedPhases: [phaseCard] },
          phaseRuntime: { currentPhaseKey: "implementation", currentPhaseName: "Implementation" }
        },
        steps: [
          {
            stepKey: "impl_auth",
            title: "Implement auth flow",
            stepIndex: 0,
            metadata: {
              stepType: "implementation",
              phaseKey: "implementation",
              phaseName: "Implementation",
              phasePosition: 1,
              validationContract: {
                level: "step",
                tier: "dedicated",
                required: true,
                criteria: "Validator must pass before moving on",
                evidence: [],
                maxRetries: 2
              }
            }
          }
        ]
      });
      const implStep = fixture.service.listSteps(started.run.id).find((step) => step.stepKey === "impl_auth");
      if (!implStep) throw new Error("Missing implementation step");
      fixture.service.addSteps({
        runId: started.run.id,
        steps: [
          {
            stepKey: "validate_impl_auth",
            title: "Validate existing impl step",
            stepIndex: 1,
            dependencyStepKeys: ["impl_auth"],
            metadata: {
              stepType: "validation",
              autoSpawnedValidation: true,
              targetStepId: implStep.id,
              targetStepKey: "impl_auth",
              phaseKey: "implementation",
              phaseName: "Implementation",
              validationContract: {
                level: "step",
                tier: "dedicated",
                required: true,
                criteria: "Validator must pass before moving on",
                evidence: [],
                maxRetries: 2
              }
            }
          }
        ]
      });

      const attempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId: implStep.id,
        ownerId: "owner"
      });
      await fixture.service.completeAttempt({
        attemptId: attempt.id,
        status: "succeeded",
        result: {
          schema: "ade.orchestratorAttempt.v1",
          success: true,
          summary: "Auth flow implemented.",
          outputs: {},
          warnings: [],
          sessionId: null,
          trackedSession: false
        }
      });

      const steps = fixture.service.listSteps(started.run.id);
      const validators = steps.filter((step) => {
        const meta = (step.metadata ?? {}) as Record<string, unknown>;
        return meta.autoSpawnedValidation === true && meta.targetStepId === implStep.id;
      });
      expect(validators).toHaveLength(1);
    } finally {
      fixture.dispose();
    }
  });

  it("emits self-check reminder message for required self-tier validation when pass is missing", async () => {
    const fixture = await createFixture();
    try {
      const phaseCard = {
        id: "phase-testing",
        phaseKey: "testing",
        name: "Testing",
        description: "Test",
        instructions: "",
        model: { provider: "openai", modelId: "openai/gpt-5.3-codex" },
        budget: {},
        orderingConstraints: {},
        askQuestions: { enabled: false },
        validationGate: { tier: "self", required: true, criteria: "Coordinator must validate test results" },
        isBuiltIn: true,
        isCustom: false,
        position: 2,
        createdAt: "2026-03-04T00:00:00.000Z",
        updatedAt: "2026-03-04T00:00:00.000Z",
      };
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        metadata: {
          phaseConfiguration: { selectedPhases: [phaseCard] },
          phaseRuntime: { currentPhaseKey: "testing", currentPhaseName: "Testing" }
        },
        steps: [
          {
            stepKey: "test_auth",
            title: "Run auth tests",
            stepIndex: 0,
            metadata: {
              stepType: "test",
              taskType: "test",
              phaseKey: "testing",
              phaseName: "Testing",
              phasePosition: 2,
              validationContract: {
                level: "step",
                tier: "self",
                required: true,
                criteria: "Coordinator must validate test results",
                evidence: [],
                maxRetries: 2
              }
            }
          }
        ]
      });
      const testStep = fixture.service.listSteps(started.run.id).find((step) => step.stepKey === "test_auth");
      if (!testStep) throw new Error("Missing test step");
      const attempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId: testStep.id,
        ownerId: "owner"
      });
      await fixture.service.completeAttempt({
        attemptId: attempt.id,
        status: "succeeded",
        result: {
          schema: "ade.orchestratorAttempt.v1",
          success: true,
          summary: "Auth tests completed.",
          outputs: {
            testsRun: { passed: 10, failed: 0, skipped: 0 }
          },
          warnings: [],
          sessionId: null,
          trackedSession: false
        }
      });

      const runtimeEvents = fixture.service.listRuntimeEvents({ runId: started.run.id, limit: 100 });
      expect(runtimeEvents.some((event) => {
        if (event.eventType !== "validation_self_check_reminder") return false;
        const payload = (event.payload ?? {}) as Record<string, unknown>;
        return payload.audience === "coordinator" && String(payload.message ?? "").includes("requires self-validation");
      })).toBe(true);
      expect(runtimeEvents.some((event) => event.eventType === "validation_contract_unfulfilled")).toBe(true);

      const timeline = fixture.service.listTimeline({ runId: started.run.id, limit: 100 });
      expect(timeline.some((event) => event.eventType === "validation_self_check_reminder")).toBe(true);
    } finally {
      fixture.dispose();
    }
  });

  it("validates reflection input strictly and rejects invalid timestamps", async () => {
    const fixture = await createFixture();
    try {
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [{ stepKey: "impl", title: "Implement", stepIndex: 0 }]
      });
      const step = fixture.service.listSteps(started.run.id)[0];
      if (!step) throw new Error("Expected step");

      expect(() =>
        fixture.service.addReflection({
          missionId: fixture.missionId,
          runId: started.run.id,
          stepId: step.id,
          agentRole: "implementer",
          phase: "development",
          signalType: "idea",
          observation: "Need better local iteration loop",
          recommendation: "Add focused test command",
          context: "Editing auth handler",
          occurredAt: "not-a-date"
        })
      ).toThrowError(ReflectionValidationError);
      expect(() =>
        fixture.service.addReflection({
          missionId: fixture.missionId,
          runId: started.run.id,
          stepId: step.id,
          agentRole: "implementer",
          phase: "development",
          signalType: "idea",
          observation: "Need better local iteration loop",
          recommendation: "Add focused test command",
          context: "Editing auth handler",
          occurredAt: "2026-03-05 00:00:00"
        })
      ).toThrowError(ReflectionValidationError);
      expect(() =>
        fixture.service.addReflection({
          missionId: fixture.missionId,
          runId: started.run.id,
          stepId: step.id,
          agentRole: "implementer",
          phase: "development",
          signalType: "idea",
          observation: "Need better local iteration loop",
          recommendation: "",
          context: "Editing auth handler",
          occurredAt: "2026-03-05T00:00:00.000Z"
        })
      ).toThrowError(ReflectionValidationError);
    } finally {
      fixture.dispose();
    }
  });

  it("rejects reflection scope mismatches and persists DB+ledger on valid writes", async () => {
    const fixture = await createFixture();
    try {
      const runA = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [{ stepKey: "a", title: "A", stepIndex: 0 }]
      });
      const runB = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [{ stepKey: "b", title: "B", stepIndex: 0 }]
      });
      const stepB = fixture.service.listSteps(runB.run.id)[0];
      if (!stepB) throw new Error("Expected runB step");

      expect(() =>
        fixture.service.addReflection({
          missionId: fixture.missionId,
          runId: runA.run.id,
          stepId: stepB.id,
          agentRole: "implementer",
          phase: "development",
          signalType: "frustration",
          observation: "Scope mismatch",
          recommendation: "Use correct step scope",
          context: "unit test",
          occurredAt: "2026-03-05T01:00:00.000Z"
        })
      ).toThrowError(ReflectionValidationError);

      const stepA = fixture.service.listSteps(runA.run.id)[0];
      if (!stepA) throw new Error("Expected runA step");
      const reflection = fixture.service.addReflection({
        missionId: fixture.missionId,
        runId: runA.run.id,
        stepId: stepA.id,
        agentRole: "implementer",
        phase: "development",
        signalType: "frustration",
        observation: "Typecheck is slow",
        recommendation: "Use incremental mode",
        context: "editing foo.ts",
        occurredAt: "2026-03-05T01:05:00.000Z"
      });
      const stored = fixture.service.listReflections({ runId: runA.run.id, limit: 10 });
      expect(stored.some((entry) => entry.id === reflection.id)).toBe(true);

      const ledgerPath = path.join(fixture.projectRoot, ".ade", "reflections", `${fixture.missionId}.jsonl`);
      const ledgerText = fs.readFileSync(ledgerPath, "utf8");
      expect(ledgerText).toContain(reflection.id);
      expect(ledgerText).toContain("\"signalType\":\"frustration\"");
    } finally {
      fixture.dispose();
    }
  });

  it("generates deterministic idempotent retrospectives, trends, and cancel-path artifacts", async () => {
    const fixture = await createFixture();
    try {
      const now = "2026-03-05T01:20:00.000Z";
      fixture.db.run(
        `
          insert into missions(
            id, project_id, lane_id, title, prompt, status, priority, execution_mode, target_machine_id,
            outcome_summary, last_error, metadata_json, created_at, updated_at, started_at, completed_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          "mission-2",
          fixture.projectId,
          fixture.laneId,
          "Mission 2",
          "Second mission",
          "queued",
          "normal",
          "local",
          null,
          null,
          null,
          null,
          now,
          now,
          null,
          null
        ]
      );

      const first = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [{ stepKey: "first", title: "First", stepIndex: 0 }]
      });
      const firstStep = fixture.service.listSteps(first.run.id)[0];
      if (!firstStep) throw new Error("Expected first step");
      const firstAttempt = await fixture.service.startAttempt({ runId: first.run.id, stepId: firstStep.id, ownerId: "owner" });
      await fixture.service.completeAttempt({
        attemptId: firstAttempt.id,
        status: "succeeded",
        result: {
          schema: "ade.orchestratorAttempt.v1",
          success: true,
          summary: "done",
          outputs: {},
          warnings: [],
          sessionId: null,
          trackedSession: false
        }
      });
      fixture.service.addReflection({
        missionId: fixture.missionId,
        runId: first.run.id,
        stepId: firstStep.id,
        attemptId: firstAttempt.id,
        agentRole: "validator",
        phase: "validation",
        signalType: "frustration",
        observation: "Slow tests",
        recommendation: "Parallelize tests",
        context: "running integration suite",
        occurredAt: "2026-03-05T01:21:00.000Z"
      });
      fixture.service.addReflection({
        missionId: fixture.missionId,
        runId: first.run.id,
        stepId: firstStep.id,
        attemptId: firstAttempt.id,
        agentRole: "validator",
        phase: "validation",
        signalType: "frustration",
        observation: "Flaky network",
        recommendation: "Stabilize test network fixtures",
        context: "integration setup",
        occurredAt: "2026-03-05T01:21:30.000Z"
      });
      fixture.service.addReflection({
        missionId: fixture.missionId,
        runId: first.run.id,
        stepId: firstStep.id,
        attemptId: firstAttempt.id,
        agentRole: "validator",
        phase: "validation",
        signalType: "frustration",
        observation: "Tooling drift",
        recommendation: "Pin shared tooling versions",
        context: "worker bootstrap",
        occurredAt: "2026-03-05T01:21:45.000Z"
      });
      fixture.service.finalizeRun({ runId: first.run.id, force: true });
      const firstRetro = fixture.service.generateRunRetrospective({ runId: first.run.id });
      expect(firstRetro?.id).toBe(`retro:${first.run.id}`);

      const second = fixture.service.startRun({
        missionId: "mission-2",
        steps: [{ stepKey: "second", title: "Second", stepIndex: 0 }]
      });
      const secondStep = fixture.service.listSteps(second.run.id)[0];
      if (!secondStep) throw new Error("Expected second step");
      const secondAttempt = await fixture.service.startAttempt({ runId: second.run.id, stepId: secondStep.id, ownerId: "owner" });
      await fixture.service.completeAttempt({
        attemptId: secondAttempt.id,
        status: "succeeded",
        result: {
          schema: "ade.orchestratorAttempt.v1",
          success: true,
          summary: "done",
          outputs: {},
          warnings: [],
          sessionId: null,
          trackedSession: false
        }
      });
      fixture.service.addReflection({
        missionId: "mission-2",
        runId: second.run.id,
        stepId: secondStep.id,
        attemptId: secondAttempt.id,
        agentRole: "validator",
        phase: "validation",
        signalType: "frustration",
        observation: "Slow tests",
        recommendation: "Parallelize tests",
        context: "first pass",
        occurredAt: "2026-03-05T01:25:00.000Z"
      });
      fixture.service.addReflection({
        missionId: "mission-2",
        runId: second.run.id,
        stepId: secondStep.id,
        attemptId: secondAttempt.id,
        agentRole: "validator",
        phase: "validation",
        signalType: "frustration",
        observation: "Slow tests",
        recommendation: "Parallelize tests",
        context: "second pass",
        occurredAt: "2026-03-05T01:26:00.000Z"
      });
      fixture.service.addReflection({
        missionId: "mission-2",
        runId: second.run.id,
        stepId: secondStep.id,
        attemptId: secondAttempt.id,
        agentRole: "validator",
        phase: "validation",
        signalType: "frustration",
        observation: "Tooling drift",
        recommendation: "Pin shared tooling versions",
        context: "worker bootstrap",
        occurredAt: "2026-03-05T01:26:15.000Z"
      });
      fixture.service.finalizeRun({ runId: second.run.id, force: true });
      const secondRetro = fixture.service.generateRunRetrospective({ runId: second.run.id });
      const secondRetroAgain = fixture.service.generateRunRetrospective({ runId: second.run.id });
      expect(secondRetro?.id).toBe(`retro:${second.run.id}`);
      expect(secondRetroAgain?.id).toBe(secondRetro?.id);
      expect(secondRetroAgain?.generatedAt).toBe(secondRetro?.generatedAt);
      expect(secondRetro?.changelog.some((entry) => entry.status === "worsened")).toBe(true);
      expect(secondRetro?.changelog.some((entry) => entry.status === "resolved")).toBe(true);
      expect(secondRetro?.changelog.some((entry) => entry.status === "still_open")).toBe(true);
      const trendsBefore = fixture.service.listRetrospectiveTrends({ runId: second.run.id, limit: 100 });
      const trendsAfter = fixture.service.listRetrospectiveTrends({ runId: second.run.id, limit: 100 });
      expect(trendsBefore.length).toBeGreaterThan(0);
      expect(trendsAfter.length).toBe(trendsBefore.length);
      expect(trendsBefore.some((entry) => entry.status === "worsened")).toBe(true);
      expect(trendsBefore.some((entry) => entry.status === "resolved")).toBe(true);
      expect(trendsBefore.some((entry) => entry.status === "still_open")).toBe(true);
      expect(trendsBefore.every((entry) => entry.sourceRetrospectiveId.length > 0)).toBe(true);
      expect(trendsBefore.every((entry) => entry.sourceMissionId.length > 0)).toBe(true);
      expect(trendsBefore.every((entry) => entry.sourceRunId.length > 0)).toBe(true);

      const canceled = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [{ stepKey: "cancel", title: "Cancel", stepIndex: 0 }]
      });
      fixture.service.cancelRun({ runId: canceled.run.id, reason: "user canceled" });
      const canceledRetro = fixture.service.generateRunRetrospective({ runId: canceled.run.id });
      expect(canceledRetro?.id).toBe(`retro:${canceled.run.id}`);
    } finally {
      fixture.dispose();
    }
  });

  it("promotes repeated patterns to candidate memory once with traceable sources", async () => {
    const addCandidateMemory = vi.fn((opts: any) => ({
      id: "candidate-memory-1",
      ...opts
    }));
    const fixture = await createFixture({
      memoryService: {
        addCandidateMemory,
      }
    });
    try {
      const runOne = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [{ stepKey: "one", title: "One", stepIndex: 0 }]
      });
      const stepOne = fixture.service.listSteps(runOne.run.id)[0];
      if (!stepOne) throw new Error("Expected step one");
      const attemptOne = await fixture.service.startAttempt({ runId: runOne.run.id, stepId: stepOne.id, ownerId: "owner" });
      await fixture.service.completeAttempt({
        attemptId: attemptOne.id,
        status: "succeeded",
        result: {
          schema: "ade.orchestratorAttempt.v1",
          success: true,
          summary: "done",
          outputs: {},
          warnings: [],
          sessionId: null,
          trackedSession: false
        }
      });
      fixture.service.addReflection({
        missionId: fixture.missionId,
        runId: runOne.run.id,
        stepId: stepOne.id,
        attemptId: attemptOne.id,
        agentRole: "implementer",
        phase: "development",
        signalType: "pattern",
        observation: "Use barrel exports from index.ts",
        recommendation: "Check index.ts first when wiring imports",
        context: "import resolution",
        occurredAt: "2026-03-05T01:40:00.000Z"
      });
      fixture.service.finalizeRun({ runId: runOne.run.id, force: true });
      fixture.service.generateRunRetrospective({ runId: runOne.run.id });
      expect(addCandidateMemory).not.toHaveBeenCalled();

      const runTwo = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [{ stepKey: "two", title: "Two", stepIndex: 0 }]
      });
      const stepTwo = fixture.service.listSteps(runTwo.run.id)[0];
      if (!stepTwo) throw new Error("Expected step two");
      const attemptTwo = await fixture.service.startAttempt({ runId: runTwo.run.id, stepId: stepTwo.id, ownerId: "owner" });
      await fixture.service.completeAttempt({
        attemptId: attemptTwo.id,
        status: "succeeded",
        result: {
          schema: "ade.orchestratorAttempt.v1",
          success: true,
          summary: "done",
          outputs: {},
          warnings: [],
          sessionId: null,
          trackedSession: false
        }
      });
      fixture.service.addReflection({
        missionId: fixture.missionId,
        runId: runTwo.run.id,
        stepId: stepTwo.id,
        attemptId: attemptTwo.id,
        agentRole: "implementer",
        phase: "development",
        signalType: "pattern",
        observation: "Use barrel exports from index.ts",
        recommendation: "Check index.ts first when wiring imports",
        context: "import resolution",
        occurredAt: "2026-03-05T01:45:00.000Z"
      });
      fixture.service.finalizeRun({ runId: runTwo.run.id, force: true });
      fixture.service.generateRunRetrospective({ runId: runTwo.run.id });
      fixture.service.generateRunRetrospective({ runId: runTwo.run.id });
      expect(addCandidateMemory).toHaveBeenCalledTimes(1);

      const patternStats = fixture.service.listRetrospectivePatternStats({ limit: 10 });
      const stat = patternStats.find((entry) => entry.patternKey.includes("use barrel exports"));
      expect(stat).toBeTruthy();
      expect(stat?.occurrenceCount).toBe(2);
      expect(stat?.promotedMemoryId).toBe("candidate-memory-1");

      if (!stat) throw new Error("Expected pattern stat");
      const sourceRows = fixture.db.all<{ count: number }>(
        `
          select count(*) as count
          from orchestrator_reflection_pattern_sources
          where pattern_stat_id = ?
        `,
        [stat.id]
      );
      expect(Number(sourceRows[0]?.count ?? 0)).toBe(2);
    } finally {
      fixture.dispose();
    }
  });
});
