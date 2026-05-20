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
  onEvent?: (event: any) => void;
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
    onEvent: args.onEvent,
  });

  // Test harness convenience: opencode workers require metadata.modelId in Phase 3.
  // Inject a default modelId for tests that are validating unrelated behavior.
  const defaultOpenCodeModelId = "anthropic/claude-sonnet-4-6";
  const normalizeStepModelId = (step: any) => {
    const executorKind = typeof step?.executorKind === "string" ? step.executorKind : null;
    if (executorKind !== "opencode") return step;
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
        modelId: defaultOpenCodeModelId,
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

  it("grants one infrastructure retry when restart recovery finds a zero-retry step", async () => {
    const events: any[] = [];
    const fixture = await createFixture({ onEvent: (event) => events.push(event) });
    try {
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [
          {
            stepKey: "apply",
            title: "Apply patch",
            stepIndex: 0,
            retryLimit: 0
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
      fixture.service.activateRun(started.run.id);

      fixture.service.resumeRun({ runId: started.run.id });

      const updatedStep = fixture.service.listSteps(started.run.id)[0];
      expect(updatedStep?.status).toBe("ready");
      expect(updatedStep?.retryCount).toBe(0);
      expect(updatedStep?.metadata?.resumeRecoveryCount).toBe(1);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "orchestrator-attempt-updated",
            attemptId: attempt.id,
            reason: "completed"
          }),
          expect.objectContaining({
            type: "orchestrator-step-updated",
            stepId: step.id,
            reason: "attempt_completed"
          })
        ])
      );
    } finally {
      fixture.dispose();
    }
  });

  it("requeues shutdown-interrupted failures without consuming step retry budget", async () => {
    const fixture = await createFixture();
    try {
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [
          {
            stepKey: "reload-safe",
            title: "Reload Safe",
            stepIndex: 0,
            retryLimit: 1
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
        status: "failed",
        errorClass: "executor_failure",
        errorMessage: "Chat session 'session-1' was closed during shutdown."
      });

      const updatedStep = fixture.service.listSteps(started.run.id)[0];
      expect(updatedStep?.status).toBe("ready");
      expect(updatedStep?.retryCount).toBe(0);
      expect(updatedStep?.metadata?.restartInterruptedRetryCount).toBe(1);

      const updatedRun = fixture.service.listRuns({ missionId: fixture.missionId }).find((run) => run.id === started.run.id);
      expect(updatedRun?.lastError).toBeNull();
    } finally {
      fixture.dispose();
    }
  });

  it("resumeRun restores failed legacy shutdown attempts into the scheduler", async () => {
    const fixture = await createFixture();
    try {
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [
          {
            stepKey: "legacy-reload",
            title: "Legacy Reload",
            stepIndex: 0,
            retryLimit: 1
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
      const completedAt = "2026-03-08T00:10:00.000Z";
      fixture.db.run(
        `
          update orchestrator_attempts
          set status = 'failed',
              error_class = 'executor_failure',
              error_message = ?,
              completed_at = ?
          where id = ?
        `,
        ["Chat session 'session-legacy' was closed during shutdown.", completedAt, attempt.id]
      );
      fixture.db.run(
        `
          update orchestrator_steps
          set status = 'failed',
              retry_count = 1,
              last_attempt_id = ?,
              completed_at = ?,
              updated_at = ?
          where id = ?
        `,
        [attempt.id, completedAt, completedAt, step.id]
      );
      fixture.db.run(
        `
          update orchestrator_runs
          set status = 'active',
              last_error = ?
          where id = ?
        `,
        ["Chat session 'session-legacy' was closed during shutdown.", started.run.id]
      );

      const resumed = fixture.service.resumeRun({ runId: started.run.id });
      expect(resumed.status).toBe("active");

      const updatedStep = fixture.service.listSteps(started.run.id)[0];
      expect(updatedStep?.status).toBe("ready");
      expect(updatedStep?.retryCount).toBe(0);
      expect(updatedStep?.metadata?.restartInterruptedFailureRecovered).toBe(true);

      const timeline = fixture.service.listTimeline({ runId: started.run.id, limit: 50 });
      expect(timeline.some((entry) => entry.eventType === "attempt_recovered_after_restart")).toBe(true);
      const updatedRun = fixture.service.listRuns({ missionId: fixture.missionId }).find((run) => run.id === started.run.id);
      expect(updatedRun?.lastError).toBeNull();
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
            executorKind: "opencode",
            ownerId: "autopilot-owner",
            parallelismCap: 1
          }
        },
        steps: [
          {
            stepKey: "status-guarded",
            title: "Status Guarded",
            stepIndex: 0,
            executorKind: "opencode"
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
            executorKind: "opencode",
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
          executorKind: "opencode",
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
            executorKind: "opencode",
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
            executorKind: "opencode",
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

  it("allows planner recovery autopilot through an open planner-plan-missing intervention only for planning steps", async () => {
    const fixture = await createFixture();
    try {
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        metadata: {
          autopilot: {
            enabled: true,
            executorKind: "opencode",
            ownerId: "autopilot-owner",
            parallelismCap: 2,
          },
        },
        steps: [
          {
            stepKey: "planning-recovery",
            title: "Recover planning",
            stepIndex: 0,
            laneId: fixture.laneId,
            executorKind: "opencode",
            metadata: {
              stepType: "planning",
              taskType: "planning",
              phaseKey: "planning",
            },
          },
          {
            stepKey: "implementation-while-blocked",
            title: "Implementation while blocked",
            stepIndex: 1,
            laneId: fixture.laneId,
            executorKind: "opencode",
            metadata: {
              stepType: "implementation",
              phaseKey: "development",
            },
          },
        ],
      });
      const now = new Date().toISOString();
      const planningStep = fixture.service.listSteps(started.run.id).find((step) => step.stepKey === "planning-recovery");
      const implementationStep = fixture.service
        .listSteps(started.run.id)
        .find((step) => step.stepKey === "implementation-while-blocked");
      if (!planningStep || !implementationStep) throw new Error("Missing test steps");

      fixture.db.run(
        `update missions set status = 'intervention_required', updated_at = ? where id = ? and project_id = ?`,
        [now, fixture.missionId, fixture.projectId],
      );
      fixture.db.run(
        `
          insert into mission_interventions(
            id,
            mission_id,
            project_id,
            intervention_type,
            status,
            title,
            body,
            requested_action,
            lane_id,
            metadata_json,
            created_at,
            updated_at
          ) values (?, ?, ?, 'failed_step', 'open', ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          "planner-plan-missing-intervention",
          fixture.missionId,
          fixture.projectId,
          "Planner result missing plan",
          "Planning worker completed without returning report_result.plan.markdown.",
          "Retry planning and return report_result.plan.markdown.",
          fixture.laneId,
          JSON.stringify({
            runId: started.run.id,
            stepId: "failed-planner-step",
            reasonCode: "planner_plan_missing",
          }),
          now,
          now,
        ],
      );

      const startedAttempts = await fixture.service.startReadyAutopilotAttempts({
        runId: started.run.id,
        reason: "planner_recovery",
      });

      const attempts = fixture.service.listAttempts({ runId: started.run.id });
      expect(startedAttempts).toBe(1);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.stepId).toBe(planningStep.id);
      expect(fixture.service.listSteps(started.run.id).find((step) => step.id === implementationStep.id)?.status).toBe("ready");
    } finally {
      fixture.dispose();
    }
  });

  it("keeps non-planner recovery interventions blocking autopilot", async () => {
    const fixture = await createFixture();
    try {
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        metadata: {
          autopilot: {
            enabled: true,
            executorKind: "opencode",
            ownerId: "autopilot-owner",
            parallelismCap: 1,
          },
        },
        steps: [
          {
            stepKey: "blocked-planning",
            title: "Blocked planning",
            stepIndex: 0,
            laneId: fixture.laneId,
            executorKind: "opencode",
            metadata: {
              stepType: "planning",
              phaseKey: "planning",
            },
          },
        ],
      });
      const now = new Date().toISOString();
      fixture.db.run(
        `update missions set status = 'intervention_required', updated_at = ? where id = ? and project_id = ?`,
        [now, fixture.missionId, fixture.projectId],
      );
      fixture.db.run(
        `
          insert into mission_interventions(
            id,
            mission_id,
            project_id,
            intervention_type,
            status,
            title,
            body,
            requested_action,
            lane_id,
            metadata_json,
            created_at,
            updated_at
          ) values (?, ?, ?, 'failed_step', 'open', ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          "ordinary-failed-step-intervention",
          fixture.missionId,
          fixture.projectId,
          "Worker failed",
          "A non-planning worker failed.",
          "Review the failed worker before continuing.",
          fixture.laneId,
          JSON.stringify({
            runId: started.run.id,
            reasonCode: "worker_failed",
          }),
          now,
          now,
        ],
      );

      expect(
        await fixture.service.startReadyAutopilotAttempts({
          runId: started.run.id,
          reason: "non_planner_intervention",
        }),
      ).toBe(0);
      expect(fixture.service.listAttempts({ runId: started.run.id })).toHaveLength(0);
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
            executorKind: "opencode",
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
            executorKind: "opencode",
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
            executorKind: "opencode",
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

  it("does not require plan.markdown from read-only non-planning workers", async () => {
    const fixture = await createFixture();
    try {
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [
          {
            stepKey: "read-only-development",
            title: "Read-only development check",
            stepIndex: 0,
            executorKind: "manual",
            metadata: {
              stepType: "implementation",
              phaseKey: "development",
              phaseName: "Development",
              readOnlyExecution: true,
            },
          },
        ],
      });
      const step = fixture.service.listSteps(started.run.id)[0];
      if (!step) throw new Error("Missing read-only development step");

      const attempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId: step.id,
        ownerId: "development-owner",
        executorKind: "manual",
      });
      const completed = await fixture.service.completeAttempt({
        attemptId: attempt.id,
        status: "succeeded",
        result: {
          schema: "ade.orchestratorAttempt.v1",
          success: true,
          summary: "Read-only development check completed.",
          outputs: null,
          warnings: [],
          sessionId: null,
          trackedSession: false,
        },
      });

      expect(completed.status).toBe("succeeded");
      expect(completed.errorClass).toBe("none");
      expect(completed.errorMessage).toBeNull();
    } finally {
      fixture.dispose();
    }
  });

  it("does not auto-advance a phase while required self-validation is pending", async () => {
    const fixture = await createFixture();
    try {
      const implementationPhase = {
        id: "phase-implementation",
        phaseKey: "implementation",
        name: "Implementation",
        description: "Build",
        instructions: "Implement.",
        model: { provider: "openai", modelId: "openai/gpt-5.3-codex" },
        budget: {},
        orderingConstraints: {},
        askQuestions: { enabled: false },
        validationGate: { tier: "self", required: true, criteria: "Implementation must be validated." },
        isBuiltIn: true,
        isCustom: false,
        position: 1,
        createdAt: "2026-03-08T00:00:00.000Z",
        updatedAt: "2026-03-08T00:00:00.000Z",
      };
      const testingPhase = {
        id: "phase-testing",
        phaseKey: "testing",
        name: "Testing",
        description: "Test",
        instructions: "Run tests.",
        model: { provider: "openai", modelId: "openai/gpt-5.3-codex" },
        budget: {},
        orderingConstraints: { mustFollow: ["implementation"] },
        askQuestions: { enabled: false },
        validationGate: { tier: "self", required: true, criteria: "Tests must pass." },
        isBuiltIn: true,
        isCustom: false,
        position: 2,
        createdAt: "2026-03-08T00:00:00.000Z",
        updatedAt: "2026-03-08T00:00:00.000Z",
      };

      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        metadata: {
          phaseConfiguration: { selectedPhases: [implementationPhase, testingPhase] },
          phaseRuntime: {
            currentPhaseKey: "implementation",
            currentPhaseName: "Implementation",
            currentPhaseModel: implementationPhase.model,
          },
        },
        steps: [
          {
            stepKey: "impl-work",
            title: "Implement work",
            stepIndex: 0,
            executorKind: "manual",
            metadata: {
              stepType: "implementation",
              phaseKey: "implementation",
              phaseName: "Implementation",
              validationContract: {
                level: "step",
                tier: "self",
                required: true,
                criteria: "Implementation must be validated.",
                evidence: [],
                maxRetries: 2,
              },
            },
          },
          {
            stepKey: "test-work",
            title: "Test work",
            stepIndex: 1,
            dependencyStepKeys: ["impl-work"],
            executorKind: "manual",
            metadata: {
              stepType: "testing",
              phaseKey: "testing",
              phaseName: "Testing",
            },
          },
        ],
      });

      const implStep = fixture.service.listSteps(started.run.id).find((step) => step.stepKey === "impl-work");
      const testStep = fixture.service.listSteps(started.run.id).find((step) => step.stepKey === "test-work");
      if (!implStep || !testStep) throw new Error("Missing phase validation gate steps");

      const attempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId: implStep.id,
        ownerId: "owner",
        executorKind: "manual",
      });
      await fixture.service.completeAttempt({
        attemptId: attempt.id,
        status: "succeeded",
        result: {
          schema: "ade.orchestratorAttempt.v1",
          success: true,
          summary: "Implementation complete.",
          outputs: { filesChanged: ["src/index.ts"] },
          warnings: [],
          sessionId: null,
          trackedSession: false,
        },
      });

      const beforeValidation = fixture.service.getRunGraph({ runId: started.run.id, timelineLimit: 50 });
      expect((beforeValidation.run.metadata?.phaseRuntime as Record<string, unknown>)?.currentPhaseKey).toBe("implementation");
      expect(beforeValidation.steps.find((step) => step.id === testStep.id)?.status).toBe("pending");

      const implAfterCompletion = beforeValidation.steps.find((step) => step.id === implStep.id);
      fixture.db.run(
        `update orchestrator_steps set metadata_json = ?, updated_at = ? where id = ?`,
        [
          JSON.stringify({
            ...(implAfterCompletion?.metadata ?? {}),
            validationState: "pass",
            validationPassedAt: "2026-03-08T00:05:00.000Z",
          }),
          "2026-03-08T00:05:00.000Z",
          implStep.id,
        ],
      );
      fixture.service.tick({ runId: started.run.id });

      const afterValidation = fixture.service.getRunGraph({ runId: started.run.id, timelineLimit: 50 });
      expect((afterValidation.run.metadata?.phaseRuntime as Record<string, unknown>)?.currentPhaseKey).toBe("testing");
      expect(afterValidation.steps.find((step) => step.id === testStep.id)?.status).toBe("ready");
    } finally {
      fixture.dispose();
    }
  });

  it("keeps terminal display-only tracker steps terminal during readiness refresh", async () => {
    const fixture = await createFixture();
    try {
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [
          {
            stepKey: "planner-launch-tracker",
            title: "Launch planning worker",
            stepIndex: -1000,
            executorKind: "manual",
            metadata: {
              plannerLaunchTracker: true,
              phaseKey: "planning",
              phaseName: "Planning",
            },
          },
        ],
      });
      const tracker = fixture.service.listSteps(started.run.id)[0];
      if (!tracker) throw new Error("Missing tracker step");
      fixture.db.run(
        `update orchestrator_steps set status = 'succeeded', completed_at = ?, updated_at = ? where id = ?`,
        ["2026-03-08T00:10:00.000Z", "2026-03-08T00:10:00.000Z", tracker.id],
      );

      fixture.service.tick({ runId: started.run.id });

      const refreshed = fixture.service.listSteps(started.run.id).find((step) => step.id === tracker.id);
      expect(refreshed?.status).toBe("succeeded");
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
            executorKind: "opencode",
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
            executorKind: "opencode",
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
            executorKind: "opencode",
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
            executorKind: "opencode",
            ownerId: "autopilot-owner",
            parallelismCap: 4
          }
        },
        steps: [
          { stepKey: "s1", title: "S1", stepIndex: 0, laneId: fixture.laneId, executorKind: "opencode" },
          { stepKey: "s2", title: "S2", stepIndex: 1, laneId: fixture.laneId, executorKind: "opencode" },
          { stepKey: "s3", title: "S3", stepIndex: 2, laneId: fixture.laneId, executorKind: "opencode" }
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
            executorKind: "opencode",
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
          { stepKey: "s1", title: "S1", stepIndex: 0, laneId: fixture.laneId, executorKind: "opencode" },
          { stepKey: "s2", title: "S2", stepIndex: 1, laneId: fixture.laneId, executorKind: "opencode" },
          { stepKey: "s3", title: "S3", stepIndex: 2, laneId: fixture.laneId, executorKind: "opencode" }
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
            executorKind: "opencode",
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
            executorKind: "opencode",
            metadata: { aiPriority: 1 }
          },
          {
            stepKey: "high-priority",
            title: "High Priority",
            stepIndex: 1,
            laneId: fixture.laneId,
            executorKind: "opencode",
            metadata: { aiPriority: 50 }
          },
          {
            stepKey: "no-ai-priority",
            title: "No AI Priority",
            stepIndex: 2,
            laneId: fixture.laneId,
            executorKind: "opencode"
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
        defaultExecutorKind: "opencode",
        metadata: {
          plannerParallelismCap: 6
        }
      });

      const run = fixture.service.listRuns({ missionId: fixture.missionId })[0];
      expect(run?.metadata?.runMode).toBe("autopilot");
      const autopilot = run?.metadata?.autopilot as Record<string, unknown> | undefined;
      expect(autopilot?.enabled).toBe(true);
      expect(autopilot?.executorKind).toBe("opencode");
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
        defaultExecutorKind: "opencode"
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
        defaultExecutorKind: "opencode"
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
      expect(finalized.finalStatus).toBe("active");
      expect(finalized.blockers.some((entry) => entry.includes("without any successful work"))).toBe(true);
      expect(run?.status).toBe("active");
    } finally {
      fixture.dispose();
    }
  });

  it("reactivates a completion-blocked run when recovery steps are added", async () => {
    const fixture = await createFixture();
    try {
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [],
      });
      fixture.db.run(
        `update orchestrator_runs set status = 'completing', updated_at = ? where id = ?`,
        [new Date().toISOString(), started.run.id],
      );

      const [recoveryStep] = fixture.service.addSteps({
        runId: started.run.id,
        steps: [
          {
            stepKey: "recovery",
            title: "Recovery validation work",
            stepIndex: 1,
          },
        ],
      });
      expect(recoveryStep?.status).toBe("ready");

      const graph = fixture.service.getRunGraph({ runId: started.run.id, timelineLimit: 20 });
      expect(graph.run.status).toBe("active");
      expect(graph.timeline.some((entry) => entry.eventType === "run_reactivated")).toBe(true);

      const attempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId: recoveryStep!.id,
        ownerId: "owner",
      });
      expect(attempt.status).toBe("running");
    } finally {
      fixture.dispose();
    }
  });

  it("moves blocked finalization back to active when pending recovery work exists", async () => {
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
        validationGate: { tier: "none", required: false },
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
            stepKey: "pending-recovery",
            title: "Pending recovery",
            stepIndex: 0,
            metadata: {
              stepType: "implementation",
              phaseKey: "development",
              phaseName: "Development",
            },
          },
        ],
      });
      fixture.db.run(
        `update orchestrator_runs set status = 'completing', updated_at = ? where id = ?`,
        [new Date().toISOString(), started.run.id],
      );

      const finalized = fixture.service.finalizeRun({ runId: started.run.id });
      expect(finalized.finalized).toBe(false);
      expect(finalized.finalStatus).toBe("active");

      const graph = fixture.service.getRunGraph({ runId: started.run.id, timelineLimit: 20 });
      expect(graph.run.status).toBe("active");
      expect(
        graph.timeline.some((entry) => (
          entry.eventType === "run_completion_blocked"
          && (entry.detail as Record<string, unknown> | null)?.nextStatus === "active"
        )),
      ).toBe(true);
    } finally {
      fixture.dispose();
    }
  });

  it("lets a dedicated validation phase run the previous phase gate", async () => {
    const fixture = await createFixture();
    try {
      const testingPhase = {
        id: "phase-testing",
        phaseKey: "testing",
        name: "Testing",
        description: "Run tests.",
        instructions: "Run tests.",
        model: { provider: "openai", modelId: "openai/gpt-5.3-codex" },
        budget: {},
        orderingConstraints: { mustBeFirst: false, mustBeLast: false, mustFollow: [], mustPrecede: [], canLoop: false, loopTarget: null },
        askQuestions: { enabled: false },
        validationGate: { tier: "dedicated", required: true },
        isBuiltIn: true,
        isCustom: false,
        position: 0,
        createdAt: "2026-03-04T00:00:00.000Z",
        updatedAt: "2026-03-04T00:00:00.000Z",
      };
      const validationPhase = {
        ...testingPhase,
        id: "phase-validation",
        phaseKey: "validation",
        name: "Validation",
        description: "Validate output.",
        instructions: "Validate output.",
        validationGate: { tier: "dedicated", required: true },
        position: 1,
      };
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        metadata: {
          phaseConfiguration: { phases: [testingPhase, validationPhase] },
          missionLevelSettings: { prStrategy: { kind: "manual" } },
        },
        steps: [
          {
            stepKey: "test-work",
            title: "Test work",
            stepIndex: 0,
            metadata: {
              phaseKey: "testing",
              phaseName: "Testing",
              stepType: "testing",
            },
          },
        ],
      });
      const testStep = fixture.service.listSteps(started.run.id)[0];
      if (!testStep) throw new Error("Missing test step");
      const attempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId: testStep.id,
        ownerId: "owner",
      });
      await fixture.service.completeAttempt({ attemptId: attempt.id, status: "succeeded" });

      const [validationStep] = fixture.service.addSteps({
        runId: started.run.id,
        steps: [
          {
            stepKey: "validate-test-work",
            title: "Validate test work",
            stepIndex: 1,
            dependencyStepKeys: ["test-work"],
            metadata: {
              phaseKey: "validation",
              phaseName: "Validation",
              stepType: "validation",
            },
          },
        ],
      });

      const graph = fixture.service.getRunGraph({ runId: started.run.id, timelineLimit: 20 });
      const phaseRuntime = graph.run.metadata?.phaseRuntime as Record<string, unknown> | undefined;
      expect(phaseRuntime?.currentPhaseKey).toBe("validation");
      expect(graph.steps.find((step) => step.id === validationStep?.id)?.status).toBe("ready");
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
            executorKind: "opencode",
            ownerId: "orchestrator-autopilot"
          }
        },
        steps: [
          {
            stepKey: "first",
            title: "First",
            stepIndex: 0,
            laneId: fixture.laneId,
            executorKind: "opencode"
          },
          {
            stepKey: "second",
            title: "Second",
            stepIndex: 1,
            dependencyStepKeys: ["first"],
            laneId: fixture.laneId,
            executorKind: "opencode"
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
            executorKind: "opencode"
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
      fixture.db.run(
        `
          update orchestrator_attempts
          set status = 'running',
              executor_session_id = ?,
              executor_kind = 'codex',
              error_class = 'none',
              error_message = null,
              completed_at = null
          where id = ?
        `,
        [preSessionId, attempt.id]
      );

      fs.writeFileSync(
        transcriptPath,
        "looking at router wiring first\n\nThe plan is ready. The implementation requires 4 targeted changes across 3 existing files plus 1 new file.\n",
        "utf8"
      );

      const reconciled = await fixture.service.onTrackedSessionEnded({
        sessionId: preSessionId,
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

  it("recovers markdown report_result payloads from tracked worker transcripts", async () => {
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
        metadata: {
          phaseConfiguration: {
            selectedPhases: [
              {
                id: "phase-implementation-math",
                phaseKey: "implementation_math",
                name: "Implementation math",
                position: 1,
                instructions: "Implement math work.",
                model: { provider: "openai", modelId: "openai/gpt-5.3-codex" },
                budget: {},
                orderingConstraints: {},
                askQuestions: { enabled: false },
                validationGate: { tier: "self", required: true, criteria: "Tests must pass." },
                isBuiltIn: false,
                isCustom: true,
                createdAt: now,
                updatedAt: now,
              },
            ],
          },
          phaseRuntime: { currentPhaseKey: "implementation_math", currentPhaseName: "Implementation math" },
        },
        steps: [
          {
            stepKey: "implementation-math-worker",
            title: "Implementation math worker",
            stepIndex: 0,
            laneId: fixture.laneId,
            executorKind: "opencode",
            metadata: {
              stepType: "implementation",
              phaseKey: "implementation_math",
              phaseName: "Implementation math",
              validationContract: {
                level: "step",
                tier: "self",
                required: true,
                criteria: "Tests must pass.",
                evidence: [],
                maxRetries: 2,
              },
            },
          }
        ]
      });
      const stepId = fixture.service.listSteps(started.run.id)[0]?.id;
      if (!stepId) throw new Error("Expected implementation step");

      const attempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId,
        ownerId: "operator"
      });
      fixture.db.run(
        `
          update orchestrator_attempts
          set status = 'running',
              executor_session_id = ?,
              executor_kind = 'codex',
              error_class = 'none',
              error_message = null,
              completed_at = null
          where id = ?
        `,
        [preSessionId, attempt.id]
      );

      fs.writeFileSync(
        transcriptPath,
        [
          "Implemented helpers and ran the package tests.",
          "",
          "## report_result",
          "### outcome",
          "completed",
          "### summary",
          "Added three math utilities and tests.",
          "### filesChanged",
          "- [src/math.js](file:///tmp/src/math.js)",
          "- [test/math.test.js](file:///tmp/test/math.test.js)",
          "### testsRun",
          "- Ran `npm test`",
          "- Passed: 9",
          "- Failed: 0",
          "- Skipped: 0",
          "",
        ].join("\n"),
        "utf8"
      );

      const reconciled = await fixture.service.onTrackedSessionEnded({
        sessionId: preSessionId,
        laneId: fixture.laneId,
        exitCode: 0
      });
      expect(reconciled).toBe(1);

      const step = fixture.service.listSteps(started.run.id).find((entry) => entry.id === stepId);
      const metadata = (step?.metadata ?? {}) as Record<string, any>;
      expect(metadata.recoveredResultReportFromTranscript).toBe(true);
      expect(metadata.lastResultReport?.summary).toBe("Added three math utilities and tests.");
      expect(metadata.lastResultReport?.filesChanged).toEqual(["src/math.js", "test/math.test.js"]);
      expect(metadata.lastResultReport?.testsRun).toEqual(expect.objectContaining({
        command: "npm test",
        passed: 9,
        failed: 0,
        skipped: 0,
      }));
    } finally {
      fixture.dispose();
    }
  });

  it("blocks ask-enabled planners on recovered natural-language questions instead of failing the plan contract", async () => {
    const fixture = await createFixture();
    try {
      const now = "2026-02-19T00:00:00.000Z";
      const transcriptDir = path.join(fixture.projectRoot, ".ade", "transcripts");
      fs.mkdirSync(transcriptDir, { recursive: true });
      const preSessionId = "session-planner-question";
      const transcriptPath = path.join(transcriptDir, `${preSessionId}.log`);
      fixture.db.run(
        `insert or ignore into terminal_sessions(
          id, lane_id, pty_id, tracked, title, started_at, ended_at,
          exit_code, transcript_path, head_sha_start, head_sha_end,
          status, last_output_preview, summary, tool_type, resume_command, last_output_at
        ) values (?, ?, null, 1, 'Planning Worker', ?, null, null, ?, null, null,
          'running', null, null, 'codex-orchestrated', null, ?)`,
        [preSessionId, fixture.laneId, now, transcriptPath, now]
      );

      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        metadata: {
          phaseConfiguration: {
            selectedPhases: [
              {
                id: "phase-planning",
                phaseKey: "planning",
                name: "Planning",
                position: 0,
                instructions: "Ask one clarification before planning.",
                model: { provider: "codex", modelId: "openai/gpt-5.3-codex-spark" },
                budget: {},
                orderingConstraints: { mustBeFirst: true },
                askQuestions: { enabled: true, maxQuestions: 1 },
                validationGate: { tier: "none", required: false },
                isBuiltIn: true,
                isCustom: true,
                createdAt: now,
                updatedAt: now,
              },
            ],
          },
          phaseRuntime: { currentPhaseKey: "planning", currentPhaseName: "Planning" },
        },
        steps: [
          {
            stepKey: "planning-worker",
            title: "Planning worker",
            stepIndex: 0,
            laneId: fixture.laneId,
            executorKind: "codex",
            metadata: {
              stepType: "planning",
              phaseKey: "planning",
              phaseName: "Planning",
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
      fixture.db.run(
        `
          update orchestrator_attempts
          set status = 'running',
              executor_session_id = ?,
              executor_kind = 'codex',
              error_class = 'none',
              error_message = null,
              completed_at = null
          where id = ?
        `,
        [preSessionId, attempt.id]
      );

      fs.writeFileSync(
        transcriptPath,
        [
          "codex",
          "I inspected the parser and formatter files.",
          "codex",
          "Should missing/unknown item weights default to `1`?",
          "tokens used",
          "1200",
        ].join("\n"),
        "utf8"
      );

      const reconciled = await fixture.service.onTrackedSessionEnded({
        sessionId: preSessionId,
        laneId: fixture.laneId,
        exitCode: 0
      });
      expect(reconciled).toBe(1);

      const graph = fixture.service.getRunGraph({ runId: started.run.id, timelineLimit: 20 });
      const step = graph.steps.find((entry) => entry.id === stepId);
      const completedAttempt = graph.attempts.find((entry) => entry.id === attempt.id);
      expect(step?.status).toBe("blocked");
      expect(completedAttempt?.status).toBe("blocked");
      expect(completedAttempt?.errorClass).toBe("deterministic");
	      const awaitingUserInput = step?.metadata?.awaitingUserInput as Record<string, unknown> | undefined;
	      expect(String(awaitingUserInput?.question ?? "")).toContain("default to `1`");
	      expect(graph.run.status).toBe("paused");
	      const intervention = fixture.db.get<{ status: string; intervention_type: string; body: string; metadata_json: string | null }>(
	        `
	          select status, intervention_type, body, metadata_json
	          from mission_interventions
	          where mission_id = ?
	          limit 1
	        `,
	        [fixture.missionId]
	      );
	      expect(intervention).toEqual(expect.objectContaining({
	        status: "open",
	        intervention_type: "manual_input",
	      }));
	      expect(intervention?.body).toContain("default to `1`");
	      expect(JSON.parse(intervention?.metadata_json ?? "{}")).toEqual(expect.objectContaining({
	        reasonCode: "planner_natural_question",
	        attemptId: attempt.id,
	      }));

	      const questionEvent = fixture.service
        .listRuntimeEvents({ attemptId: attempt.id, eventTypes: ["question"], limit: 5 })
        .find((entry) => entry.eventType === "question");
      expect(questionEvent?.payload).toEqual(expect.objectContaining({
        source: "planner_natural_question",
      }));
    } finally {
      fixture.dispose();
    }
  });

  it("blocks a planning worker that skips a required blocking question before returning a plan", async () => {
    const fixture = await createFixture();
    try {
      const now = "2026-02-19T00:00:00.000Z";
      fixture.db.run(
        `update missions set prompt = ? where id = ?`,
        [
          "Build a launch dashboard with a planning phase that asks blocking questions before implementation.",
          fixture.missionId,
        ],
      );
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        metadata: {
          phaseConfiguration: {
            selectedPhases: [
              {
                id: "phase-planning",
                phaseKey: "planning",
                name: "Planning",
                position: 0,
                instructions: "Ask one clarification before planning.",
                model: { provider: "codex", modelId: "openai/gpt-5.3-codex-spark" },
                budget: {},
                orderingConstraints: { mustBeFirst: true },
                askQuestions: { enabled: true, requiredBeforeExit: true },
                validationGate: { tier: "none", required: false },
                isBuiltIn: true,
                isCustom: true,
                createdAt: now,
                updatedAt: now,
              },
            ],
          },
          phaseRuntime: { currentPhaseKey: "planning", currentPhaseName: "Planning" },
        },
        steps: [
          {
            stepKey: "planning-worker",
            title: "Planning worker",
            stepIndex: 0,
            laneId: fixture.laneId,
            executorKind: "codex",
            metadata: {
              stepType: "planning",
              phaseKey: "planning",
              phaseName: "Planning",
              phaseAskQuestions: { enabled: true, requiredBeforeExit: true },
              readOnlyExecution: true,
            },
          },
        ],
      });
      const step = fixture.service.listSteps(started.run.id)[0];
      if (!step) throw new Error("Expected planning step");
      fixture.service.updateStepMetadata({
        runId: started.run.id,
        stepId: step.id,
        metadata: {
          ...step.metadata,
          lastResultReport: {
            outcome: "succeeded",
            summary: "Planning complete.",
            filesChanged: [],
            testsRun: { commands: [] },
            plan: { markdown: "## Plan\n- Implement the dashboard." },
          },
        },
      });
      const attempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId: step.id,
        ownerId: "planner-owner",
        executorKind: "codex",
      });

      const completed = await fixture.service.completeAttempt({
        attemptId: attempt.id,
        status: "succeeded",
      });

      expect(completed.status).toBe("blocked");
      expect(completed.errorMessage ?? "").toContain("required blocking question");
      const graph = fixture.service.getRunGraph({ runId: started.run.id, timelineLimit: 20 });
      expect(graph.steps.find((entry) => entry.id === step.id)?.status).toBe("blocked");
      expect(graph.run.status).toBe("paused");
      const intervention = fixture.db.get<{ status: string; intervention_type: string; metadata_json: string | null }>(
        `
          select status, intervention_type, metadata_json
          from mission_interventions
          where mission_id = ?
          limit 1
        `,
        [fixture.missionId],
      );
      expect(intervention).toEqual(expect.objectContaining({
        status: "open",
        intervention_type: "manual_input",
      }));
      expect(JSON.parse(intervention?.metadata_json ?? "{}")).toEqual(expect.objectContaining({
        reasonCode: "planner_required_question_missing",
        attemptId: attempt.id,
      }));
    } finally {
      fixture.dispose();
    }
  });

  it("counts resolved managed chat questions before enforcing required planning clarification", async () => {
    const fixture = await createFixture();
    try {
      const now = "2026-02-19T00:00:00.000Z";
      const transcriptDir = path.join(fixture.projectRoot, ".ade", "transcripts");
      fs.mkdirSync(transcriptDir, { recursive: true });
      const sessionId = "managed-planner-session";
      const transcriptPath = path.join(transcriptDir, `${sessionId}.chat.jsonl`);
      fixture.db.run(
        `update missions set prompt = ? where id = ?`,
        [
          "Build a launch dashboard with a planning phase that asks blocking questions before implementation.",
          fixture.missionId,
        ],
      );
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        metadata: {
          phaseConfiguration: {
            selectedPhases: [
              {
                id: "phase-planning",
                phaseKey: "planning",
                name: "Planning",
                position: 0,
                instructions: "Ask one clarification before planning.",
                model: { provider: "codex", modelId: "openai/gpt-5.3-codex-spark" },
                budget: {},
                orderingConstraints: { mustBeFirst: true },
                askQuestions: { enabled: true, requiredBeforeExit: true },
                validationGate: { tier: "none", required: false },
                isBuiltIn: true,
                isCustom: true,
                createdAt: now,
                updatedAt: now,
              },
            ],
          },
          phaseRuntime: { currentPhaseKey: "planning", currentPhaseName: "Planning" },
        },
        steps: [
          {
            stepKey: "planning-worker",
            title: "Planning worker",
            stepIndex: 0,
            laneId: fixture.laneId,
            executorKind: "codex",
            metadata: {
              stepType: "planning",
              phaseKey: "planning",
              phaseName: "Planning",
              phaseAskQuestions: { enabled: true, requiredBeforeExit: true },
              readOnlyExecution: true,
            },
          },
        ],
      });
      const step = fixture.service.listSteps(started.run.id)[0];
      if (!step) throw new Error("Expected planning step");
      fixture.service.updateStepMetadata({
        runId: started.run.id,
        stepId: step.id,
        metadata: {
          ...step.metadata,
          lastResultReport: {
            outcome: "succeeded",
            summary: "Planning complete after asking the launch-scope question.",
            filesChanged: [],
            testsRun: { commands: [] },
            plan: { markdown: "## Plan\n- Implement the dashboard with the approved launch scope." },
          },
        },
      });
      const attempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId: step.id,
        ownerId: "planner-owner",
        executorKind: "codex",
      });
      const legacyInterventionId = "legacy-required-planner-question";
      fixture.db.run(
        `
          insert into mission_interventions(
            id,
            mission_id,
            project_id,
            intervention_type,
            status,
            resolution_kind,
            title,
            body,
            requested_action,
            resolution_note,
            lane_id,
            metadata_json,
            created_at,
            updated_at,
            resolved_at
          ) values (?, ?, ?, 'manual_input', 'open', null, ?, ?, ?, null, ?, ?, ?, ?, null)
        `,
        [
          legacyInterventionId,
          fixture.missionId,
          fixture.projectId,
          "Required planner question",
          "Which launch scope should the planner assume?",
          "Answer the required planning question.",
          fixture.laneId,
          JSON.stringify({
            source: "planner_required_question_missing",
            reasonCode: "planner_required_question_missing",
            question: "Which launch scope should the planner assume?",
            runId: started.run.id,
            stepId: step.id,
            stepKey: step.stepKey,
            attemptId: attempt.id,
            sessionId,
            phaseKey: "planning",
            stepType: "planning",
          }),
          now,
          now,
        ],
      );

      fs.writeFileSync(
        transcriptPath,
        [
          {
            sessionId,
            timestamp: now,
            sequence: 1,
            event: {
              type: "approval_request",
              itemId: "question-1",
              kind: "tool_call",
              description: "Which launch scope should the planner assume?",
              detail: {
                request: {
                  itemId: "question-1",
                  source: "codex",
                  kind: "structured_question",
                  questions: [
                    {
                      id: "scope",
                      header: "Scope",
                      question: "Which launch scope should the planner assume?",
                      options: [{ label: "Internal drill" }, { label: "Customer launch" }],
                    },
                  ],
                },
              },
            },
          },
          {
            sessionId,
            timestamp: now,
            sequence: 2,
            event: {
              type: "pending_input_resolved",
              itemId: "question-1",
              resolution: "accepted",
            },
          },
        ].map((entry) => JSON.stringify(entry)).join("\n"),
        "utf8",
      );

      const completed = await fixture.service.completeAttempt({
        attemptId: attempt.id,
        status: "succeeded",
        metadata: { trackedSessionId: sessionId, transcriptPath },
      });

      expect(completed.status).toBe("succeeded");
      const graph = fixture.service.getRunGraph({ runId: started.run.id, timelineLimit: 20 });
      expect(graph.steps.find((entry) => entry.id === step.id)?.status).toBe("succeeded");
      const interventions = fixture.db.all<{ id: string; status: string; intervention_type: string; body: string; resolution_kind: string | null; resolution_note: string | null; metadata_json: string | null }>(
        `
          select id, status, intervention_type, body, resolution_kind, resolution_note, metadata_json
          from mission_interventions
          where mission_id = ?
        `,
        [fixture.missionId],
      );
      const intervention = interventions.find((entry) => {
        const metadata = JSON.parse(entry.metadata_json ?? "{}");
        return metadata.reasonCode === "planner_chat_question";
      });
      expect(intervention).toEqual(expect.objectContaining({
        status: "resolved",
        intervention_type: "manual_input",
      }));
      expect(intervention?.body).toContain("Which launch scope");
      expect(JSON.parse(intervention?.metadata_json ?? "{}")).toEqual(expect.objectContaining({
        source: "request_user_input",
        reasonCode: "planner_chat_question",
        attemptId: attempt.id,
        itemId: "question-1",
      }));
      const legacyIntervention = interventions.find((entry) => entry.id === legacyInterventionId);
      expect(legacyIntervention).toEqual(expect.objectContaining({
        status: "resolved",
        resolution_kind: "answer_provided",
        resolution_note: "Answered in ADE chat.",
      }));
    } finally {
      fixture.dispose();
    }
  });

  it("promotes generated planning worker metadata when the mission prompt requires questions", async () => {
    const fixture = await createFixture();
    try {
      const now = "2026-02-19T00:00:00.000Z";
      fixture.db.run(
        `update missions set prompt = ? where id = ?`,
        [
          "Planning is blocked until the planner asks required clarification questions before implementation.",
          fixture.missionId,
        ],
      );
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        metadata: {
          phaseConfiguration: {
            selectedPhases: [
              {
                id: "phase-planning",
                phaseKey: "planning",
                name: "Planning",
                description: "Plan first",
                position: 0,
                instructions: "Research, clarify requirements, and design the execution DAG.",
                model: { provider: "codex", modelId: "openai/gpt-5.5", thinkingLevel: "low" },
                budget: {},
                orderingConstraints: { mustBeFirst: true },
                askQuestions: { enabled: true, maxQuestions: null, requiredBeforeExit: false },
                validationGate: { tier: "none", required: false },
                isBuiltIn: true,
                isCustom: false,
                createdAt: now,
                updatedAt: now,
              },
            ],
          },
          phaseRuntime: { currentPhaseKey: "planning", currentPhaseName: "Planning" },
        },
        steps: [],
      });

      const [step] = fixture.service.addSteps({
        runId: started.run.id,
        steps: [
          {
            stepKey: "planning-worker",
            title: "Planning worker",
            stepIndex: 0,
            executorKind: "codex",
            metadata: {
              phaseKey: "planning",
              phaseName: "Planning",
              phaseInstructions: "Investigate dependencies before implementation.",
              phaseAskQuestions: { enabled: true, maxQuestions: null, requiredBeforeExit: false },
              stepType: "planning",
              taskType: "planning",
              readOnlyExecution: true,
              instructions: "Ask the required clarification questions through ADE before returning a plan.",
            },
          },
        ],
      });

      expect(step?.metadata?.phaseAskQuestions).toEqual(expect.objectContaining({
        enabled: true,
        requiredBeforeExit: true,
      }));
    } finally {
      fixture.dispose();
    }
  });

  it("recovers Codex final-answer markdown result summaries from tracked worker transcripts", async () => {
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
            stepKey: "implementation-math-worker",
            title: "Implementation math worker",
            stepIndex: 0,
            laneId: fixture.laneId,
            executorKind: "opencode",
            metadata: {
              stepType: "implementation",
              phaseKey: "implementation_math",
              phaseName: "Implementation math",
            },
          }
        ]
      });
      const stepId = fixture.service.listSteps(started.run.id)[0]?.id;
      if (!stepId) throw new Error("Expected implementation step");

      const attempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId,
        ownerId: "operator"
      });
      if (!attempt.executorSessionId) throw new Error("Expected running session-backed attempt");

      fs.writeFileSync(
        transcriptPath,
        [
          "codex",
          "The math worker lane is complete.",
          "",
          "Outcome: Math stream completed in the result lane.",
          "",
          "1) Accomplished",
          "- Added `median`, `range`, and `clamp` to the math module with focused coverage.",
          "- Did not edit shared files (`src/index.js` / `README.md`).",
          "",
          "FilesChanged:",
          "- Added math utilities in [src/math.js](/tmp/work/src/math.js).",
          "- Extended tests in [test/math.test.js](/tmp/work/test/math.test.js).",
          "- Wrote [./.ade/checkpoints/worker.md](/tmp/work/.ade/checkpoints/worker.md).",
          "",
          "TestsRun:",
          "- `npm test` (passes)",
          "",
          "Validation:",
          "- Result: PASS (7/7 tests).",
          "",
        ].join("\n"),
        "utf8"
      );

      const reconciled = await fixture.service.onTrackedSessionEnded({
        sessionId: attempt.executorSessionId,
        laneId: fixture.laneId,
        exitCode: 0
      });
      expect(reconciled).toBe(1);

      const step = fixture.service.listSteps(started.run.id).find((entry) => entry.id === stepId);
      const metadata = (step?.metadata ?? {}) as Record<string, any>;
      expect(metadata.recoveredResultReportFromTranscript).toBe(true);
      expect(metadata.lastResultReport?.summary).toContain("Added `median`, `range`, and `clamp`");
      expect(metadata.lastResultReport?.filesChanged).toEqual(["src/math.js", "test/math.test.js"]);
      expect(metadata.lastResultReport?.testsRun).toEqual(expect.objectContaining({
        command: "npm test",
        passed: 7,
      }));
    } finally {
      fixture.dispose();
    }
  });

  it("does not treat zero failed tests as a failed Codex final-answer outcome", async () => {
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
            stepKey: "testing-worker",
            title: "Testing worker",
            stepIndex: 0,
            laneId: fixture.laneId,
            executorKind: "opencode",
            metadata: {
              stepType: "implementation",
              phaseKey: "implementation_testing",
              phaseName: "Testing",
              validationContract: {
                level: "step",
                tier: "self",
                required: true,
                criteria: "npm test passes.",
                evidence: [],
                maxRetries: 2,
              },
            },
          }
        ]
      });
      const stepId = fixture.service.listSteps(started.run.id)[0]?.id;
      if (!stepId) throw new Error("Expected testing step");

      const attempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId,
        ownerId: "operator"
      });
      const sessionId = attempt.executorSessionId ?? preSessionId;
      if (!attempt.executorSessionId) {
        fixture.db.run(
          `update orchestrator_attempts set status = 'running', executor_session_id = ?, completed_at = null where id = ?`,
          [sessionId, attempt.id],
        );
        fixture.db.run(
          `update orchestrator_steps set status = 'running', last_attempt_id = ?, updated_at = ? where id = ?`,
          [attempt.id, now, stepId],
        );
      }

      fs.writeFileSync(
        transcriptPath,
        [
          "codex",
          "",
          "## Summary",
          "Completed the testing lane. Executed `npm test` on the merged implementation and confirmed the suite passes fully.",
          "",
          "## Files Changed",
          "- No functional source/test files were modified in this testing step.",
          "- Added/updated:",
          "  - `.ade/checkpoints/testing-worker.md`",
          "  - `.ade/step-output-testing-worker.md`",
          "- Worktree already contains upstream changes in:",
          "  - `README.md`",
          "  - `src/index.js`",
          "",
          "## Tests",
          "- `npm test` executed from `/tmp/work`",
          "  - Result: PASS (13 passed, 0 failed)",
          "",
          "## Validation",
          "- Node test harness executed successfully.",
          "",
          "## Warnings",
          "- No functional test blockers found.",
          "- `.ade/` currently appears as untracked in git status and is generated lane metadata.",
          "",
        ].join("\n"),
        "utf8"
      );

      const reconciled = await fixture.service.onTrackedSessionEnded({
        sessionId,
        laneId: fixture.laneId,
        exitCode: 0
      });
      expect(reconciled).toBe(1);

      const step = fixture.service.listSteps(started.run.id).find((entry) => entry.id === stepId);
      const metadata = (step?.metadata ?? {}) as Record<string, any>;
      expect(metadata.recoveredResultReportFromTranscript).toBe(true);
      expect(metadata.lastResultReport?.outcome).toBe("succeeded");
      expect(metadata.lastResultReport?.testsRun).toEqual(expect.objectContaining({
        command: "npm test",
        passed: 13,
        failed: 0,
      }));
      expect(metadata.lastResultReport?.filesChanged).not.toEqual(expect.arrayContaining([
        expect.stringContaining(".ade/"),
        expect.stringMatching(/^\//),
      ]));
    } finally {
      fixture.dispose();
    }
  });

  it("recovers Codex h2 report_result sections from tracked worker transcripts", async () => {
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
            stepKey: "implementation-math-worker",
            title: "Implementation math worker",
            stepIndex: 0,
            laneId: fixture.laneId,
            executorKind: "opencode",
            metadata: {
              stepType: "implementation",
              phaseKey: "implementation_math",
              phaseName: "Implementation math",
            },
          }
        ]
      });
      const stepId = fixture.service.listSteps(started.run.id)[0]?.id;
      if (!stepId) throw new Error("Expected implementation step");

      const attempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId,
        ownerId: "operator"
      });
      if (!attempt.executorSessionId) throw new Error("Expected running session-backed attempt");

      fs.writeFileSync(
        transcriptPath,
        [
          "codex",
          "`report_result`:",
          "",
          "## Outcome",
          "Completed math worker scope successfully. Added `median`, `range`, and `clamp` to the math module with focused tests, and executed the test suite successfully.",
          "",
          "## Summary",
          "- Implemented `median`, `range`, and `clamp` in `src/math.js`.",
          "- Extended `test/math.test.js` with focused coverage for each function.",
          "- Did **not** edit `src/index.js` or `README.md` due shared ownership for API/docs consolidation phase.",
          "- Recorded checkpoint and step-output per ADE requirements.",
          "",
          "## Files Changed",
          "- `src/math.js`",
          "- `test/math.test.js`",
          "- `.ade/checkpoints/worker_implementation-math-worker.md`",
          "- `.ade/step-output-worker_implementation-math-worker.md`",
          "",
          "## Tests Run",
          "- `npm test`",
          "- Result: pass (7/7 tests)",
          "",
        ].join("\n"),
        "utf8"
      );

      const reconciled = await fixture.service.onTrackedSessionEnded({
        sessionId: attempt.executorSessionId,
        laneId: fixture.laneId,
        exitCode: 0
      });
      expect(reconciled).toBe(1);

      const step = fixture.service.listSteps(started.run.id).find((entry) => entry.id === stepId);
      const metadata = (step?.metadata ?? {}) as Record<string, any>;
      expect(metadata.recoveredResultReportFromTranscript).toBe(true);
      expect(metadata.lastResultReport?.summary).toContain("Implemented `median`, `range`, and `clamp`");
      expect(metadata.lastResultReport?.filesChanged).toEqual(["src/math.js", "test/math.test.js"]);
      expect(metadata.lastResultReport?.testsRun).toEqual(expect.objectContaining({
        command: "npm test",
        passed: 7,
      }));
    } finally {
      fixture.dispose();
    }
  });

  it("recovers natural Codex final-answer sections after prompt templates", async () => {
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
            stepKey: "implementation-math-worker",
            title: "Implementation math worker",
            stepIndex: 0,
            laneId: fixture.laneId,
            executorKind: "opencode",
            metadata: {
              stepType: "implementation",
              phaseKey: "implementation_math",
              phaseName: "Implementation math",
            },
          }
        ]
      });
      const stepId = fixture.service.listSteps(started.run.id)[0]?.id;
      if (!stepId) throw new Error("Expected implementation step");

      const attempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId,
        ownerId: "operator"
      });
      if (!attempt.executorSessionId) throw new Error("Expected running session-backed attempt");

      fs.writeFileSync(
        transcriptPath,
        [
          "STEP OUTPUT FILE: When you complete your task, write a structured summary file.",
          "Before exiting, call `report_result` with outcome, summary, filesChanged, and testsRun.",
          "",
          "## Summary",
          "1-2 sentence description of what was accomplished.",
          "",
          "## Files Changed",
          "Bulleted list of files created or modified.",
          "",
          "codex",
          "What I accomplished",
          "- Completed the math phase: added `median`, `range`, and `clamp` utilities in `src/math.js`.",
          "- Added focused `node:test` coverage in `test/math.test.js`.",
          "",
          "What I changed",
          "- [`src/math.js`](file:///tmp/work/src/math.js): added math utilities.",
          "- [`test/math.test.js`](file:///tmp/work/test/math.test.js): added tests.",
          "- [`.ade/checkpoints/worker.md`](file:///tmp/work/.ade/checkpoints/worker.md): checkpoint.",
          "",
          "Tests",
          "- `npm test`: passed (8 passed, 0 failed).",
          "",
          "Validation",
          "- Confirmed all existing and new tests execute successfully.",
          "",
        ].join("\n"),
        "utf8"
      );

      const reconciled = await fixture.service.onTrackedSessionEnded({
        sessionId: attempt.executorSessionId,
        laneId: fixture.laneId,
        exitCode: 0
      });
      expect(reconciled).toBe(1);

      const step = fixture.service.listSteps(started.run.id).find((entry) => entry.id === stepId);
      const metadata = (step?.metadata ?? {}) as Record<string, any>;
      expect(metadata.recoveredResultReportFromTranscript).toBe(true);
      expect(metadata.lastResultReport?.summary).toContain("Completed the math phase");
      expect(metadata.lastResultReport?.summary).not.toContain("1-2 sentence");
      expect(metadata.lastResultReport?.filesChanged).toEqual(["src/math.js", "test/math.test.js"]);
      expect(metadata.lastResultReport?.testsRun).toEqual(expect.objectContaining({
        command: "npm test",
        passed: 8,
        failed: 0,
      }));
    } finally {
      fixture.dispose();
    }
  });

  it("recovers Codex closeout counts from label-first test summaries", async () => {
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
            stepKey: "closeout-worker",
            title: "Closeout worker",
            stepIndex: 0,
            laneId: fixture.laneId,
            executorKind: "opencode",
            metadata: {
              stepType: "implementation",
              phaseKey: "closeout",
              phaseName: "Closeout",
            },
          }
        ]
      });
      const stepId = fixture.service.listSteps(started.run.id)[0]?.id;
      if (!stepId) throw new Error("Expected closeout step");

      const attempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId,
        ownerId: "operator"
      });
      if (!attempt.executorSessionId) throw new Error("Expected running session-backed attempt");

      fs.writeFileSync(
        transcriptPath,
        [
          "STEP OUTPUT FILE: When you complete your task, write a structured summary file.",
          "Before exiting, call `report_result` with outcome, summary, filesChanged, and testsRun.",
          "",
          "## Accomplished",
          "- This is prompt/template noise and must not become the final summary.",
          "",
          "TAP version 13",
          "# pass 10",
          "# fail 0",
          "# skipped 0",
          "",
          "codex",
          "Accomplished: closeout verification is complete. The requested math and string utilities are implemented, exported, documented, and covered by tests.",
          "",
          "What I changed in this phase:",
          "- [src/math.js](./src/math.js)",
          "- [src/strings.js](./src/strings.js)",
          "- [src/index.js](./src/index.js)",
          "- [README.md](./README.md)",
          "- [test/math.test.js](./test/math.test.js)",
          "- [test/strings.test.js](./test/strings.test.js)",
          "- [`.ade/step-output-closeout.md`](./.ade/step-output-closeout.md)",
          "- [`..checkpoints/closeout.md`](../.ade/checkpoints/closeout.md)",
          "",
          "Tests:",
          "- Ran `npm test` (Node test runner via `node --test`)",
          "- Result: `pass 10`, `fail 0`, `skipped 0`",
          "",
          "Notes / risks:",
          "- No known functional risks.",
          "",
        ].join("\n"),
        "utf8"
      );

      const reconciled = await fixture.service.onTrackedSessionEnded({
        sessionId: attempt.executorSessionId,
        laneId: fixture.laneId,
        exitCode: 0
      });
      expect(reconciled).toBe(1);

      const step = fixture.service.listSteps(started.run.id).find((entry) => entry.id === stepId);
      const metadata = (step?.metadata ?? {}) as Record<string, any>;
      expect(metadata.recoveredResultReportFromTranscript).toBe(true);
      expect(metadata.lastResultReport?.summary).toContain("closeout verification is complete");
      expect(metadata.lastResultReport?.summary).not.toContain("prompt/template noise");
      expect(metadata.lastResultReport?.filesChanged).toEqual([
        "src/math.js",
        "src/strings.js",
        "src/index.js",
        "README.md",
        "test/math.test.js",
        "test/strings.test.js",
      ]);
      expect(metadata.lastResultReport?.testsRun).toEqual(expect.objectContaining({
        command: "npm test",
        passed: 10,
        failed: 0,
        skipped: 0,
      }));
    } finally {
      fixture.dispose();
    }
  });

  it("prefers the final Codex report over embedded earlier worker result JSON", async () => {
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
            stepKey: "closeout-worker",
            title: "Closeout worker",
            stepIndex: 0,
            laneId: fixture.laneId,
            executorKind: "opencode",
            metadata: {
              stepType: "implementation",
              phaseKey: "closeout",
              phaseName: "Closeout",
            },
          }
        ]
      });
      const stepId = fixture.service.listSteps(started.run.id)[0]?.id;
      if (!stepId) throw new Error("Expected closeout step");

      const attempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId,
        ownerId: "operator"
      });
      if (!attempt.executorSessionId) throw new Error("Expected running session-backed attempt");

      fs.writeFileSync(
        transcriptPath,
        [
          "codex",
          "Inspecting the run graph before final closeout.",
          "exec",
          JSON.stringify({
            previousStep: {
              lastResultReport: {
                outcome: "succeeded",
                summary: "Inspected the live run and produced a concrete execution DAG. No files were modified.",
                filesChanged: [],
                testsRun: null,
                plan: {
                  markdown: [
                    "## Plan",
                    "- Launch contract_author and consumer_impl in parallel.",
                    "- Integrate, test, and close out.",
                  ].join("\n"),
                },
              },
            },
          }, null, 2),
          "",
          "codex",
          "## report_result",
          "- `outcome`: `succeeded`",
          "- `summary`: Closeout verification is complete with final file and test evidence.",
          "- `filesChanged`:",
          "  - [`src/statusContract.js`](/tmp/work/src/statusContract.js)",
          "  - [`src/report.js`](/tmp/work/src/report.js)",
          "  - [`test/inventory.test.js`](/tmp/work/test/inventory.test.js)",
          "- `testsRun`:",
          "  - `npm test`",
          "  - pass: 6",
          "  - fail: 0",
          "  - skipped: 0",
          "",
          "## HANDOFF SUMMARY",
          "Final closeout should not inherit the earlier planning payload.",
        ].join("\n"),
        "utf8"
      );

      const reconciled = await fixture.service.onTrackedSessionEnded({
        sessionId: attempt.executorSessionId,
        laneId: fixture.laneId,
        exitCode: 0
      });
      expect(reconciled).toBe(1);

      const step = fixture.service.listSteps(started.run.id).find((entry) => entry.id === stepId);
      const metadata = (step?.metadata ?? {}) as Record<string, any>;
      expect(metadata.recoveredResultReportFromTranscript).toBe(true);
      expect(metadata.lastResultReport?.summary).toContain("Closeout verification is complete");
      expect(metadata.lastResultReport?.summary).not.toContain("execution DAG");
      expect(metadata.lastResultReport?.plan).toBeUndefined();
      expect(metadata.lastResultReport?.filesChanged).toEqual([
        "src/statusContract.js",
        "src/report.js",
        "test/inventory.test.js",
      ]);
      expect(metadata.lastResultReport?.testsRun).toEqual(expect.objectContaining({
        command: "npm test",
        passed: 6,
        failed: 0,
        skipped: 0,
      }));
    } finally {
      fixture.dispose();
    }
  });

  it("recovers Codex final-answer JSON plans that are missing a trailing top-level brace", async () => {
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
            title: "Planning worker",
            stepIndex: 0,
            laneId: fixture.laneId,
            executorKind: "opencode",
            metadata: {
              stepType: "planning",
              phaseKey: "planning",
              phaseName: "Planning",
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

      const finalPayload = JSON.stringify({
        outcome: "Read-only planning pass complete.",
        summary: "Validated custom Codex phase cards and produced the Real60 execution DAG.",
        filesChanged: [],
        testsRun: [],
        plan: {
          markdown: [
            "## Mission Plan",
            "- Run contract_author and consumer_impl in parallel.",
            "- Integrate, test, and close out with ADE evidence.",
          ].join("\n"),
          metadata: {
            phaseModel: "codex/openai/gpt-5.3-codex-spark",
            nextCritical: "spawn contract_author + consumer_impl in parallel",
          },
        },
      });

      fs.writeFileSync(
        transcriptPath,
        [
          "codex",
          "Preparing the plan.",
          "exec",
          JSON.stringify({
            previousStep: {
              lastResultReport: {
                outcome: "succeeded",
                summary: "Earlier embedded planning JSON should not be the chosen payload.",
                filesChanged: ["old.js"],
                testsRun: null,
              },
            },
          }, null, 2),
          "",
          "codex",
          finalPayload.slice(0, -1),
          "",
          "tokens used",
          "44,004",
        ].join("\n"),
        "utf8"
      );

      const reconciled = await fixture.service.onTrackedSessionEnded({
        sessionId: attempt.executorSessionId,
        laneId: fixture.laneId,
        exitCode: 0
      });
      expect(reconciled).toBe(1);

      const step = fixture.service.listSteps(started.run.id).find((entry) => entry.id === stepId);
      const metadata = (step?.metadata ?? {}) as Record<string, any>;
      expect(step?.status).toBe("succeeded");
      expect(metadata.recoveredResultReportFromTranscript).toBe(true);
      expect(metadata.lastResultReport?.summary).toContain("Real60 execution DAG");
      expect(metadata.lastResultReport?.summary).not.toContain("Earlier embedded");
      expect(metadata.lastResultReport?.filesChanged).toEqual([]);
      expect(metadata.lastResultReport?.testsRun).toBeNull();
      expect(metadata.lastResultReport?.plan?.markdown).toContain("contract_author and consumer_impl in parallel");
    } finally {
      fixture.dispose();
    }
  });

  it("prefers final Codex fenced JSON plans over loose prose recovery without a report_result heading", async () => {
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
            title: "Planning worker",
            stepIndex: 0,
            laneId: fixture.laneId,
            executorKind: "opencode",
            metadata: {
              stepType: "planning",
              phaseKey: "planning",
              phaseName: "Planning",
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
          "codex",
          "`what I accomplished`",
          "- Inspected the run graph and phase cards.",
          "",
          "`what I changed`",
          "- No files were modified.",
          "- `filesChanged: []`",
          "- `testsRun: []`",
          "",
          "```json",
          JSON.stringify({
            outcome: "success",
            summary: "Structured planning payload should win over loose prose.",
            filesChanged: [],
            testsRun: [],
            plan: {
              markdown: [
                "## Plan",
                "- Spawn contract_author and consumer_impl in parallel.",
                "- Capture ADE message_worker evidence.",
              ].join("\n"),
            },
          }, null, 2),
          "```",
          "",
          "`HANDOFF SUMMARY`",
          "Structured JSON contains the first-class plan.",
        ].join("\n"),
        "utf8"
      );

      const reconciled = await fixture.service.onTrackedSessionEnded({
        sessionId: attempt.executorSessionId,
        laneId: fixture.laneId,
        exitCode: 0
      });
      expect(reconciled).toBe(1);

      const step = fixture.service.listSteps(started.run.id).find((entry) => entry.id === stepId);
      const metadata = (step?.metadata ?? {}) as Record<string, any>;
      expect(step?.status).toBe("succeeded");
      expect(metadata.recoveredResultReportFromTranscript).toBe(true);
      expect(metadata.lastResultReport?.summary).toContain("Structured planning payload");
      expect(metadata.lastResultReport?.plan?.markdown).toContain("message_worker evidence");
    } finally {
      fixture.dispose();
    }
  });

  it("prefers the final Codex bullet report over earlier yamlish planning payloads", async () => {
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
            stepKey: "integration-worker",
            title: "Integration worker",
            stepIndex: 0,
            laneId: fixture.laneId,
            executorKind: "opencode",
            metadata: {
              stepType: "implementation",
              phaseKey: "integration",
              phaseName: "Integration",
            },
          }
        ]
      });
      const stepId = fixture.service.listSteps(started.run.id)[0]?.id;
      if (!stepId) throw new Error("Expected integration step");

      const attempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId,
        ownerId: "operator"
      });
      if (!attempt.executorSessionId) throw new Error("Expected running session-backed attempt");

      fs.writeFileSync(
        transcriptPath,
        [
          "codex",
          "Earlier graph output included an old planning payload.",
          "report_result:",
          "  outcome: complete",
          "  summary: \"First-class plan is complete and should not be reused.\"",
          "  filesChanged: []",
          "  testsRun: []",
          "  plan:",
          "    markdown: |",
          "      # Old planning payload",
          "      - Do not select this for integration.",
          "",
          "codex",
          "What I accomplished",
          "- Completed the integration phase after both parallel peers were finished.",
          "- Exported helper APIs and updated docs.",
          "",
          "What I changed",
          "- [src/index.js](/tmp/work/src/index.js)",
          "- [README.md](/tmp/work/README.md)",
          "- [.ade/checkpoints/worker_integration-worker.md](/tmp/work/.ade/checkpoints/worker_integration-worker.md)",
          "",
          "Tests",
          "- `npm test`: total 6, passed 6, failed 0, skipped 0.",
          "",
          "`report_result`",
          "- outcome: `succeeded`",
          "- summary: `Integrated status helper exports + README update after parallel workers.`",
          "- filesChanged: `src/index.js`, `README.md`, `.ade/checkpoints/worker_integration-worker.md`",
          "- testsRun: `npm test (passed: 6, failed: 0, skipped: 0)`",
        ].join("\n"),
        "utf8"
      );

      const reconciled = await fixture.service.onTrackedSessionEnded({
        sessionId: attempt.executorSessionId,
        laneId: fixture.laneId,
        exitCode: 0
      });
      expect(reconciled).toBe(1);

      const step = fixture.service.listSteps(started.run.id).find((entry) => entry.id === stepId);
      const metadata = (step?.metadata ?? {}) as Record<string, any>;
      expect(step?.status).toBe("succeeded");
      expect(metadata.recoveredResultReportFromTranscript).toBe(true);
      expect(metadata.lastResultReport?.summary).toContain("Integrated status helper exports");
      expect(metadata.lastResultReport?.summary).not.toContain("First-class plan");
      expect(metadata.lastResultReport?.plan).toBeUndefined();
      expect(metadata.lastResultReport?.filesChanged).toEqual(["src/index.js", "README.md"]);
      expect(metadata.lastResultReport?.testsRun).toEqual(expect.objectContaining({
        command: expect.stringContaining("npm test"),
        passed: 6,
        failed: 0,
        skipped: 0,
      }));
    } finally {
      fixture.dispose();
    }
  });

  it("recovers Codex testing summaries without an explicit report_result heading", async () => {
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
            stepKey: "testing-worker",
            title: "Testing worker",
            stepIndex: 0,
            laneId: fixture.laneId,
            executorKind: "opencode",
            metadata: {
              stepType: "testing",
              phaseKey: "testing",
              phaseName: "Testing",
            },
          }
        ]
      });
      const stepId = fixture.service.listSteps(started.run.id)[0]?.id;
      if (!stepId) throw new Error("Expected testing step");

      const attempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId,
        ownerId: "operator"
      });
      if (!attempt.executorSessionId) throw new Error("Expected running session-backed attempt");

      fs.writeFileSync(
        transcriptPath,
        [
          "exec",
          "/bin/zsh -lc \"ade actions run orchestrator_core.addReflection --input-json '{...}'\" in /tmp/work",
          "exited 1",
          "ade: occurredAt is required and must be a valid ISO-8601 timestamp.",
          "",
          "codex",
          "Testing phase complete.",
          "",
          "## What I accomplished",
          "- Ran required validation and reporting commands for this phase.",
          "- Captured exact test counts and exact ADE evidence outputs.",
          "",
          "## What I changed",
          "- [`.ade/checkpoints/worker_testing-worker.md`](.ade/checkpoints/worker_testing-worker.md)",
          "- [`.ade/step-output-worker_testing-worker.md`](.ade/step-output-worker_testing-worker.md)",
          "",
          "## Test results",
          "- `npm test`",
          "- total: `6`",
          "- pass: `6`",
          "- fail: `0`",
          "- skipped: `0`",
          "",
          "## Evidence captured",
          "- `ade message_worker`: `queued_for_polling` for completed peers.",
        ].join("\n"),
        "utf8"
      );

      const reconciled = await fixture.service.onTrackedSessionEnded({
        sessionId: attempt.executorSessionId,
        laneId: fixture.laneId,
        exitCode: 0
      });
      expect(reconciled).toBe(1);

      const step = fixture.service.listSteps(started.run.id).find((entry) => entry.id === stepId);
      const metadata = (step?.metadata ?? {}) as Record<string, any>;
      expect(step?.status).toBe("succeeded");
      expect(metadata.recoveredResultReportFromTranscript).toBe(true);
      expect(metadata.lastResultReport?.summary).toContain("Ran required validation");
      expect(metadata.lastResultReport?.filesChanged).toEqual([]);
      expect(metadata.lastResultReport?.testsRun).toEqual(expect.objectContaining({
        command: "npm test",
        passed: 6,
        failed: 0,
        skipped: 0,
      }));
    } finally {
      fixture.dispose();
    }
  });

  it("recovers Codex closeout summaries that start with implemented", async () => {
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
            stepKey: "closeout-worker",
            title: "Closeout worker",
            stepIndex: 0,
            laneId: fixture.laneId,
            executorKind: "opencode",
            metadata: {
              stepType: "closeout",
              phaseKey: "closeout",
              phaseName: "Closeout",
            },
          }
        ]
      });
      const stepId = fixture.service.listSteps(started.run.id)[0]?.id;
      if (!stepId) throw new Error("Expected closeout step");

      const attempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId,
        ownerId: "operator"
      });
      if (!attempt.executorSessionId) throw new Error("Expected running session-backed attempt");

      fs.writeFileSync(
        transcriptPath,
        [
          "codex",
          "Earlier graph output included a planning payload.",
          "report_result:",
          "  outcome: complete",
          "  summary: \"First-class plan is complete and should not close out the mission.\"",
          "  filesChanged: []",
          "  testsRun: []",
          "  plan:",
          "    markdown: |",
          "      # Old planning payload",
          "",
          "codex",
          "Implemented: Real63 closeout was completed from the active worker context, with upstream phase outputs and ADE evidence consolidated.",
          "",
          "What I changed:",
          "- Added checkpoint: [.ade/checkpoints/worker_closeout-worker.md](/tmp/work/.ade/checkpoints/worker_closeout-worker.md)",
          "- Added closeout step output: [.ade/step-output-worker_closeout-worker.md](/tmp/work/.ade/step-output-worker_closeout-worker.md)",
          "",
          "Mission changes from upstream:",
          "- [README.md](/tmp/work/README.md)",
          "- [src/index.js](/tmp/work/src/index.js)",
          "- [src/report.js](/tmp/work/src/report.js)",
          "- [test/inventory.test.js](/tmp/work/test/inventory.test.js)",
          "- [src/statusContract.js](/tmp/work/src/statusContract.js)",
          "",
          "Tests:",
          "- contract_author phase: pass 4, fail 0, skip 0",
          "- consumer_impl phase: pass 5, fail 0, skip 0",
          "- testing phase: pass 5, fail 0, skip 0",
          "",
          "Risks / notes for downstream:",
          "- No product defaults or phase defaults were changed.",
        ].join("\n"),
        "utf8"
      );

      const reconciled = await fixture.service.onTrackedSessionEnded({
        sessionId: attempt.executorSessionId,
        laneId: fixture.laneId,
        exitCode: 0
      });
      expect(reconciled).toBe(1);

      const step = fixture.service.listSteps(started.run.id).find((entry) => entry.id === stepId);
      const metadata = (step?.metadata ?? {}) as Record<string, any>;
      expect(step?.status).toBe("succeeded");
      expect(metadata.recoveredResultReportFromTranscript).toBe(true);
      expect(metadata.lastResultReport?.summary).toContain("Real63 closeout");
      expect(metadata.lastResultReport?.summary).not.toContain("First-class plan");
      expect(metadata.lastResultReport?.plan).toBeUndefined();
      expect(metadata.lastResultReport?.filesChanged).toEqual([
        "README.md",
        "src/index.js",
        "src/report.js",
        "test/inventory.test.js",
        "src/statusContract.js",
      ]);
      expect(metadata.lastResultReport?.testsRun).toEqual(expect.objectContaining({
        passed: 4,
        failed: 0,
        skipped: 0,
      }));
    } finally {
      fixture.dispose();
    }
  });

  it("recovers Codex report_result bullet lists under h3 headings", async () => {
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
            stepKey: "implementation-math-worker",
            title: "Implementation math worker",
            stepIndex: 0,
            laneId: fixture.laneId,
            executorKind: "opencode",
            metadata: {
              stepType: "implementation",
              phaseKey: "implementation_math",
              phaseName: "Implementation math",
            },
          }
        ]
      });
      const stepId = fixture.service.listSteps(started.run.id)[0]?.id;
      if (!stepId) throw new Error("Expected implementation step");

      const attempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId,
        ownerId: "operator"
      });
      if (!attempt.executorSessionId) throw new Error("Expected running session-backed attempt");

      fs.writeFileSync(
        transcriptPath,
        [
          "Before exiting, call `report_result` with outcome, summary, filesChanged, and testsRun.",
          "",
          "codex",
          "### report_result",
          "- outcome: Completed. Implemented math utilities and math tests in this phase only; all tests pass.",
          "- summary: Added `median`, `range`, and `clamp` utilities to `src/math.js`, and added focused `node:test` coverage in `test/math.test.js`.",
          "- filesChanged: 2",
          "  - [`src/math.js`](/tmp/work/src/math.js)",
          "  - [`test/math.test.js`](/tmp/work/test/math.test.js)",
          "- testsRun: `npm test` (pass; 14 total tests, 14 passed)",
          "",
          "### HANDOFF SUMMARY",
          "Downstream should wire exports and docs later.",
          "diff --git a/src/math.js b/src/math.js",
          "",
        ].join("\n"),
        "utf8"
      );

      const reconciled = await fixture.service.onTrackedSessionEnded({
        sessionId: attempt.executorSessionId,
        laneId: fixture.laneId,
        exitCode: 0
      });
      expect(reconciled).toBe(1);

      const step = fixture.service.listSteps(started.run.id).find((entry) => entry.id === stepId);
      const metadata = (step?.metadata ?? {}) as Record<string, any>;
      expect(metadata.recoveredResultReportFromTranscript).toBe(true);
      expect(metadata.lastResultReport?.summary).toContain("Added `median`, `range`, and `clamp`");
      expect(metadata.lastResultReport?.filesChanged).toEqual(["src/math.js", "test/math.test.js"]);
      expect(metadata.lastResultReport?.testsRun).toEqual(expect.objectContaining({
        command: "npm test",
        passed: 14,
      }));
    } finally {
      fixture.dispose();
    }
  });

  it("recovers Codex yamlish report_result plans without treating target files as changes", async () => {
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
            title: "Planning worker",
            stepIndex: 0,
            laneId: fixture.laneId,
            executorKind: "opencode",
            metadata: {
              stepType: "planning",
              phaseKey: "planning",
              phaseName: "Planning",
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
          "Return the plan through report_result with a first-class plan payload.",
          "",
          "codex",
          "report_result:",
          "  outcome: \"Completed planning-only inspection and produced a concrete execution plan.\"",
          "  summary: \"I completed a read-only sweep and split math/string work into parallel workers.\"",
          "  filesChanged: []",
          "  testsRun: []",
          "  plan:",
          "    markdown: |",
          "      ## Context summary",
          "      - Current API is split into `src/math.js` and `src/strings.js`.",
          "",
          "      ## Target files",
          "      - `[src/math.js](/tmp/work/src/math.js)`",
          "      - `[src/strings.js](/tmp/work/src/strings.js)`",
          "      - `[src/index.js](/tmp/work/src/index.js)`",
          "      - `[README.md](/tmp/work/README.md)`",
          "",
          "  handoffSummary:",
          "    - \"No code changes were made in planning.\"",
          "",
        ].join("\n"),
        "utf8"
      );

      const reconciled = await fixture.service.onTrackedSessionEnded({
        sessionId: attempt.executorSessionId,
        laneId: fixture.laneId,
        exitCode: 0
      });
      expect(reconciled).toBe(1);

      const step = fixture.service.listSteps(started.run.id).find((entry) => entry.id === stepId);
      const metadata = (step?.metadata ?? {}) as Record<string, any>;
      expect(metadata.recoveredResultReportFromTranscript).toBe(true);
      expect(metadata.lastResultReport?.summary).toContain("read-only sweep");
      expect(metadata.lastResultReport?.filesChanged).toEqual([]);
      expect(metadata.lastResultReport?.testsRun).toBeNull();
      expect(metadata.lastResultReport?.plan?.markdown).toContain("## Context summary");
      expect(metadata.lastResultReport?.plan?.markdown).toContain("src/index.js");
    } finally {
      fixture.dispose();
    }
  });

  it("prefers Codex fenced JSON report_result plans over lossy final-answer parsing", async () => {
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
            title: "Planning worker",
            stepIndex: 0,
            laneId: fixture.laneId,
            executorKind: "opencode",
            metadata: {
              stepType: "planning",
              phaseKey: "planning",
              phaseName: "Planning",
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
          "codex",
          "### What I accomplished",
          "- Completed a read-only planning scan.",
          "",
          "### report_result",
          "```json",
          JSON.stringify({
            outcome: "Read-only planning complete; implementation plan is ready.",
            summary: "Split math and string work into parallel streams, then consolidate docs and exports.",
            filesChanged: [],
            testsRun: [],
            plan: {
              metadata: {
                owner: "planning-worker",
                phase: "read-only planning",
              },
              markdown: [
                "- Math worker owns `src/math.js` and `test/math.test.js`.",
                "- String worker owns `src/strings.js` and `test/strings.test.js`.",
                "- API/docs worker owns `src/index.js` and `README.md` after both streams finish.",
              ].join("\n"),
            },
          }, null, 2),
          "```",
          "",
          "### HANDOFF SUMMARY",
          "- No files were edited.",
        ].join("\n"),
        "utf8"
      );

      const reconciled = await fixture.service.onTrackedSessionEnded({
        sessionId: attempt.executorSessionId,
        laneId: fixture.laneId,
        exitCode: 0
      });
      expect(reconciled).toBe(1);

      const step = fixture.service.listSteps(started.run.id).find((entry) => entry.id === stepId);
      const metadata = (step?.metadata ?? {}) as Record<string, any>;
      expect(step?.status).toBe("succeeded");
      expect(metadata.recoveredResultReportFromTranscript).toBe(true);
      expect(metadata.lastResultReport?.summary).toContain("parallel streams");
      expect(metadata.lastResultReport?.filesChanged).toEqual([]);
      expect(metadata.lastResultReport?.testsRun).toBeNull();
      expect(metadata.lastResultReport?.plan?.markdown).toContain("API/docs worker");
    } finally {
      fixture.dispose();
    }
  });

  it("recovers Codex final-answer fenced planning markdown as report_result.plan.markdown", async () => {
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
            title: "Planning worker",
            stepIndex: 0,
            laneId: fixture.laneId,
            executorKind: "opencode",
            metadata: {
              stepType: "planning",
              phaseKey: "planning",
              phaseName: "Planning",
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
          "codex",
          "Accomplished:",
          "- Completed read-only planning and confirmed the custom Codex phases.",
          "",
          "What changed:",
          "- None; planning is read-only.",
          "",
          "Plan (for orchestration handoff):",
          "```markdown",
          "## Plan: Real49 parallel worker lane proof",
          "",
          "### 1) Parallel execution",
          "- `contract_author` owns `src/statusContract.js` and focused tests.",
          "- `consumer_impl` owns status-aware report output.",
          "",
          "### 2) Closeout",
          "- Report worker paths, messaging outcome, and exact test counts.",
          "```",
          "",
          "`report_result` payload fields:",
          "- `outcome`: planning complete",
          "- `summary`: validated fixture structure and phase ordering",
          "",
          "Handoff summary:",
          "- No files were edited.",
        ].join("\n"),
        "utf8"
      );

      const reconciled = await fixture.service.onTrackedSessionEnded({
        sessionId: attempt.executorSessionId,
        laneId: fixture.laneId,
        exitCode: 0
      });
      expect(reconciled).toBe(1);

      const step = fixture.service.listSteps(started.run.id).find((entry) => entry.id === stepId);
      const metadata = (step?.metadata ?? {}) as Record<string, any>;
      expect(step?.status).toBe("succeeded");
      expect(metadata.recoveredResultReportFromTranscript).toBe(true);
      expect(metadata.lastResultReport?.summary).toContain("read-only planning");
      expect(metadata.lastResultReport?.filesChanged).toEqual([]);
      expect(metadata.lastResultReport?.plan?.markdown).toContain("Real49 parallel worker lane proof");
      expect(metadata.lastResultReport?.plan?.markdown).toContain("consumer_impl");
    } finally {
      fixture.dispose();
    }
  });

  it("recovers Codex list-style report_result planning markdown", async () => {
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
            title: "Planning worker",
            stepIndex: 0,
            laneId: fixture.laneId,
            executorKind: "opencode",
            metadata: {
              stepType: "planning",
              phaseKey: "planning",
              phaseName: "Planning",
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
          "codex",
          "report_result",
          "- outcome: `planning-complete`",
          "- summary: `Prepared a concrete DAG for two custom Codex workers.`",
          "- filesChanged: `[]`",
          "- testsRun: `[]`",
          "- plan:",
          "  - markdown: |",
          "      ## Plan for Real50 mission",
          "",
          "      ### Parallel custom phases",
          "      - `contract_author` owns the shared status contract.",
          "      - `consumer_impl` owns the report consumer.",
          "",
          "      ### Integration",
          "      - Verify worker messaging and exact test counts.",
          "  - metadata:",
          "      parallelism: required",
        ].join("\n"),
        "utf8"
      );

      const reconciled = await fixture.service.onTrackedSessionEnded({
        sessionId: attempt.executorSessionId,
        laneId: fixture.laneId,
        exitCode: 0
      });
      expect(reconciled).toBe(1);

      const step = fixture.service.listSteps(started.run.id).find((entry) => entry.id === stepId);
      const metadata = (step?.metadata ?? {}) as Record<string, any>;
      expect(step?.status).toBe("succeeded");
      expect(metadata.recoveredResultReportFromTranscript).toBe(true);
      expect(metadata.lastResultReport?.summary).toContain("concrete DAG");
      expect(metadata.lastResultReport?.plan?.markdown).toContain("Plan for Real50 mission");
      expect(metadata.lastResultReport?.plan?.markdown).toContain("consumer_impl");
      expect(metadata.lastResultReport?.plan?.markdown).not.toContain("metadata:");
    } finally {
      fixture.dispose();
    }
  });

  it("recovers glued Codex report_result bullets with direct plan.markdown", async () => {
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
            title: "Planning worker",
            stepIndex: 0,
            laneId: fixture.laneId,
            executorKind: "opencode",
            metadata: {
              stepType: "planning",
              phaseKey: "planning",
              phaseName: "Planning",
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
          "codex",
          "I’ll keep this strictly read-only and just ground the smoke-plan result in the mission context already provided.### report_result",
          "- outcome: succeeded",
          "- summary: Read the current mission context and produced the required minimal read-only planning payload; no repository inspection or edits were needed.",
          "- filesChanged: []",
          "- testsRun: read-only mission-context review only",
          "- plan.markdown:",
          "  ## Plan",
          "  - What was learned: this is a throwaway ADE Missions smoke test for the normal chat runtime.",
          "  - Recommended next steps: the coordinator should accept this result and stop the mission cleanly.",
          "  - Risks or stop conditions: stop if any worker attempts mutation, PR, merge, push, or main activity.",
          "",
          "### Accomplished",
          "- Produced the required report_result-shaped planning response.",
          "",
          "### Changed Files",
          "- None.",
        ].join("\n"),
        "utf8"
      );

      const reconciled = await fixture.service.onTrackedSessionEnded({
        sessionId: attempt.executorSessionId,
        laneId: fixture.laneId,
        exitCode: 0
      });
      expect(reconciled).toBe(1);

      const step = fixture.service.listSteps(started.run.id).find((entry) => entry.id === stepId);
      const metadata = (step?.metadata ?? {}) as Record<string, any>;
      expect(step?.status).toBe("succeeded");
      expect(metadata.recoveredResultReportFromTranscript).toBe(true);
      expect(metadata.lastResultReport?.summary).toContain("minimal read-only planning payload");
      expect(metadata.lastResultReport?.filesChanged).toEqual([]);
      expect(metadata.lastResultReport?.plan?.markdown).toContain("throwaway ADE Missions smoke test");
      expect(metadata.lastResultReport?.plan?.markdown).not.toContain("Accomplished");
    } finally {
      fixture.dispose();
    }
  });

  it("recovers chunked agent chat report_result bullets with direct plan.markdown", async () => {
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
          'running', null, null, 'codex-chat', null, ?)`,
        [preSessionId, fixture.laneId, now, transcriptPath, now]
      );

      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [
          {
            stepKey: "planning-worker",
            title: "Planning worker",
            stepIndex: 0,
            laneId: fixture.laneId,
            executorKind: "opencode",
            metadata: {
              stepType: "planning",
              phaseKey: "planning",
              phaseName: "Planning",
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
      fixture.db.run(
        `
          update orchestrator_attempts
          set status = 'running',
              executor_session_id = ?,
              executor_kind = 'codex',
              error_class = 'none',
              error_message = null,
              completed_at = null
          where id = ?
        `,
        [preSessionId, attempt.id]
      );

      const chunks = [
        "I’ll do the minimal read-only check for mission context, then return the required planning result with a first-class `plan.markdown`.### report_result\n- outcome: succeeded\n- summary",
        ": Produced the required read-only planning payload for the mission without source edits.\n",
        "- filesChanged: []\n",
        "- testsRun: Read-only mission context inspection only.\n- plan",
        ".markdown:\n  ```markdown\n  ## Plan\n  - What was learned: This is a throwaway ADE Missions smoke test for chunked chat transcript recovery.\n  - Recommended next steps: The coordinator should accept this result and continue or close cleanly.\n  - Risks or stop conditions: Stop if any worker attempts mutation, PR, merge, push, or main activity.\n  ```\n\n### HANDOFF SUMMARY\nThe plan was returned in the required field.",
      ];
      fs.writeFileSync(
        transcriptPath,
        chunks
          .map((text, index) => JSON.stringify({
            sessionId: preSessionId,
            timestamp: now,
            sequence: index + 1,
            event: {
              type: "text",
              text,
              messageId: "assistant-message-1",
            },
          }))
          .join("\n"),
        "utf8"
      );

      const reconciled = await fixture.service.onTrackedSessionEnded({
        sessionId: preSessionId,
        laneId: fixture.laneId,
        exitCode: 0
      });
      expect(reconciled).toBe(1);

      const step = fixture.service.listSteps(started.run.id).find((entry) => entry.id === stepId);
      const metadata = (step?.metadata ?? {}) as Record<string, any>;
      expect(step?.status).toBe("succeeded");
      expect(metadata.recoveredResultReportFromTranscript).toBe(true);
      expect(metadata.lastResultReport?.summary).toContain("read-only planning payload");
      expect(metadata.lastResultReport?.filesChanged).toEqual([]);
      expect(metadata.lastResultReport?.plan?.markdown).toContain("chunked chat transcript recovery");
      expect(metadata.lastResultReport?.plan?.markdown).not.toContain("HANDOFF SUMMARY");
    } finally {
      fixture.dispose();
    }
  });

  it("recovers Codex REPORT_RESULT plan.markdown artifacts", async () => {
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
            title: "Planning worker",
            stepIndex: 0,
            laneId: fixture.laneId,
            executorKind: "opencode",
            metadata: {
              stepType: "planning",
              phaseKey: "planning",
              phaseName: "Planning",
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
          "codex",
          "[REPORT_RESULT]",
          "",
          "- What I accomplished:",
          "  - Completed a read-only planning pass.",
          "  - Ran ADE CLI aliases and captured failures.",
          "",
          "- Plan artifact (first-class):",
          "  - `plan.markdown`",
          "    ```md",
          "    # Real51 Mission Plan",
          "    ## Parallel track A",
          "    - contract_author owns statusContract.js.",
          "    ## Parallel track B",
          "    - consumer_impl owns status-aware report output.",
          "    ```",
          "",
          "- testsRun: `[]`",
          "",
          "HANDOFF SUMMARY:",
          "1. Planning completed.",
        ].join("\n"),
        "utf8"
      );

      const reconciled = await fixture.service.onTrackedSessionEnded({
        sessionId: attempt.executorSessionId,
        laneId: fixture.laneId,
        exitCode: 0
      });
      expect(reconciled).toBe(1);

      const step = fixture.service.listSteps(started.run.id).find((entry) => entry.id === stepId);
      const metadata = (step?.metadata ?? {}) as Record<string, any>;
      expect(step?.status).toBe("succeeded");
      expect(metadata.recoveredResultReportFromTranscript).toBe(true);
      expect(metadata.lastResultReport?.summary).toContain("read-only planning");
      expect(metadata.lastResultReport?.plan?.markdown).toContain("Real51 Mission Plan");
      expect(metadata.lastResultReport?.plan?.markdown).toContain("consumer_impl");
    } finally {
      fixture.dispose();
    }
  });

  it("recovers Codex fenced JSON plan payload markdown", async () => {
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
            title: "Planning worker",
            stepIndex: 0,
            laneId: fixture.laneId,
            executorKind: "opencode",
            metadata: {
              stepType: "planning",
              phaseKey: "planning",
              phaseName: "Planning",
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
          "codex",
          "### What I accomplished",
          "- Completed planning inspection.",
          "",
          "### plan (first-class payload)",
          "```json",
          JSON.stringify({
            markdown: [
              "## Plan: Real52 inventory status feature",
              "",
              "### contract_author",
              "- Add statusContract.js.",
              "",
              "### consumer_impl",
              "- Add status-aware report output.",
            ].join("\n"),
            metadata: { requiredParallelPhases: ["contract_author", "consumer_impl"] },
          }, null, 2),
          "```",
        ].join("\n"),
        "utf8"
      );

      const reconciled = await fixture.service.onTrackedSessionEnded({
        sessionId: attempt.executorSessionId,
        laneId: fixture.laneId,
        exitCode: 0
      });
      expect(reconciled).toBe(1);

      const step = fixture.service.listSteps(started.run.id).find((entry) => entry.id === stepId);
      const metadata = (step?.metadata ?? {}) as Record<string, any>;
      expect(step?.status).toBe("succeeded");
      expect(metadata.recoveredResultReportFromTranscript).toBe(true);
      expect(metadata.lastResultReport?.plan?.markdown).toContain("Real52 inventory status feature");
      expect(metadata.lastResultReport?.plan?.markdown).toContain("consumer_impl");
    } finally {
      fixture.dispose();
    }
  });

  it("recovers Codex plan.markdown heading artifacts", async () => {
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
            title: "Planning worker",
            stepIndex: 0,
            laneId: fixture.laneId,
            executorKind: "opencode",
            metadata: {
              stepType: "planning",
              phaseKey: "planning",
              phaseName: "Planning",
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
          "codex",
          "### report_result",
          "- **outcome:** Read-only planning complete.",
          "- **summary:** Prepared the phase plan.",
          "- **filesChanged:** `[]`",
          "- **testsRun:** `[]`",
          "",
          "### plan.markdown",
          "```markdown",
          "## Objective",
          "Run contract_author and consumer_impl in parallel.",
          "```",
        ].join("\n"),
        "utf8"
      );

      const reconciled = await fixture.service.onTrackedSessionEnded({
        sessionId: attempt.executorSessionId,
        laneId: fixture.laneId,
        exitCode: 0
      });
      expect(reconciled).toBe(1);

      const step = fixture.service.listSteps(started.run.id).find((entry) => entry.id === stepId);
      const metadata = (step?.metadata ?? {}) as Record<string, any>;
      expect(step?.status).toBe("succeeded");
      expect(metadata.recoveredResultReportFromTranscript).toBe(true);
      expect(metadata.lastResultReport?.plan?.markdown).toContain("contract_author");
      expect(metadata.lastResultReport?.plan?.markdown).toContain("consumer_impl");
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
            executorKind: "opencode",
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
          "/Users/admin/.zshrc:3: no such file or directory: /Users/admin/.legacy-cli/get-codex-token.sh",
          "/Users/admin/.legacy-cli/completions/legacy.zsh:3803: command not found: compdef",
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
            executorKind: "opencode",
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

  it("classifies tracked workers interrupted during an open shell command as failed even with exit code zero", async () => {
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
            stepKey: "implementation-worker",
            title: "Implementation Worker",
            stepIndex: 0,
            laneId: fixture.laneId,
            executorKind: "opencode",
            metadata: {
              stepType: "implementation",
            },
          }
        ]
      });
      const stepId = fixture.service.listSteps(started.run.id)[0]?.id;
      if (!stepId) throw new Error("Expected implementation step");

      const attempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId,
        ownerId: "operator"
      });
      if (!attempt.executorSessionId) throw new Error("Expected running session-backed attempt");

      fs.writeFileSync(
        transcriptPath,
        [
          "codex",
          "I’m opening the required coordination window before making changes.",
          "exec",
          "/bin/zsh -lc 'node scripts/coordination-wait.js' in /tmp/mission-lane",
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
      expect(after?.errorMessage).toBe("Worker session was interrupted while a shell command was still running before report_result.");
    } finally {
      fixture.dispose();
    }
  });

  it("recovers durable step output before classifying an open shell command as interrupted", async () => {
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
            stepKey: "implementation-worker",
            title: "Implementation Worker",
            stepIndex: 0,
            laneId: fixture.laneId,
            executorKind: "opencode",
            metadata: {
              stepType: "implementation",
            },
          }
        ]
      });
      const stepId = fixture.service.listSteps(started.run.id)[0]?.id;
      if (!stepId) throw new Error("Expected implementation step");

      const attempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId,
        ownerId: "operator"
      });
      if (!attempt.executorSessionId) throw new Error("Expected running session-backed attempt");

      fs.mkdirSync(path.join(fixture.projectRoot, ".ade"), { recursive: true });
      fs.writeFileSync(
        path.join(fixture.projectRoot, ".ade", `step-output-implementation-worker-attempt-${attempt.id}.md`),
        [
          "## Summary",
          "Implemented the preference banner and validated the helper.",
          "",
          "## Files Changed",
          "- `app/page.tsx`",
          "- `lib/preference-banner.ts`",
          "",
          "## Tests",
          "- `npm test` passed: 3 failed: 0 skipped: 0",
          "",
          "## Validation",
          "- `npm run typecheck` passed",
        ].join("\n"),
        "utf8"
      );
      fs.writeFileSync(
        transcriptPath,
        [
          "codex",
          "I’m sending the result through the CLI.",
          "exec",
          "/bin/zsh -lc 'ade coordinator report_result --payload @/tmp/result.json' in /tmp/mission-lane",
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
      expect(after?.status).toBe("succeeded");
      expect(after?.errorClass).toBe("none");
      const [stepAfter] = fixture.service.listSteps(started.run.id);
      const metadata = stepAfter?.metadata as Record<string, unknown>;
      const report = metadata.lastResultReport as Record<string, unknown>;
      expect(metadata.recoveredResultReportFromStepOutput).toBe(true);
      expect(report.summary).toBe("Implemented the preference banner and validated the helper.");
      expect(report.filesChanged).toEqual(["app/page.tsx", "lib/preference-banner.ts"]);
      expect(report.testsRun).toMatchObject({ command: "npm test", passed: 3, failed: 0, skipped: 0 });
    } finally {
      fixture.dispose();
    }
  });

  it("recovers legacy durable step output files for in-flight workers", async () => {
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
            stepKey: "legacy-worker",
            title: "Legacy Worker",
            stepIndex: 0,
            laneId: fixture.laneId,
            executorKind: "opencode",
            metadata: {
              stepType: "implementation",
            },
          }
        ]
      });
      const stepId = fixture.service.listSteps(started.run.id)[0]?.id;
      if (!stepId) throw new Error("Expected implementation step");

      const attempt = await fixture.service.startAttempt({
        runId: started.run.id,
        stepId,
        ownerId: "operator"
      });
      if (!attempt.executorSessionId) throw new Error("Expected running session-backed attempt");

      fs.mkdirSync(path.join(fixture.projectRoot, ".ade"), { recursive: true });
      fs.writeFileSync(
        path.join(fixture.projectRoot, ".ade", "step-output-legacy-worker.md"),
        [
          "## Summary",
          "Recovered the legacy output file.",
          "",
          "## Files Changed",
          "- `legacy.ts`",
          "",
          "## Tests",
          "- `npm test` passed: 1 failed: 0 skipped: 0",
        ].join("\n"),
        "utf8"
      );
      fs.writeFileSync(
        transcriptPath,
        [
          "codex",
          "I’m sending the result through the CLI.",
          "exec",
          "/bin/zsh -lc 'ade coordinator report_result --payload @/tmp/result.json' in /tmp/mission-lane",
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
      expect(after?.status).toBe("succeeded");
      expect(after?.errorClass).toBe("none");
      const [stepAfter] = fixture.service.listSteps(started.run.id);
      const metadata = stepAfter?.metadata as Record<string, unknown>;
      const report = metadata.lastResultReport as Record<string, unknown>;
      expect(metadata.recoveredResultReportFromStepOutput).toBe(true);
      expect(report.summary).toBe("Recovered the legacy output file.");
      expect(report.filesChanged).toEqual(["legacy.ts"]);
    } finally {
      fixture.dispose();
    }
  });

  it("does not recover report_result prompt templates as worker results", async () => {
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
            title: "Planning worker",
            stepIndex: 0,
            laneId: fixture.laneId,
            executorKind: "opencode",
            metadata: {
              phaseKey: "planning",
              stepType: "planning",
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
          "## Planning worker report contract",
          "If the runtime exposes mission control through transcript recovery instead of a callable tool, finish with this exact section shape:",
          "### report_result",
          "- outcome: succeeded",
          "- summary: <one sentence>",
          "- filesChanged: []",
          "- testsRun: <commands run, or read-only checks only>",
          "- plan.markdown:",
          "  ```markdown",
          "  ## Plan",
          "  - What was learned",
          "  - Recommended next steps",
          "  - Risks or stop conditions",
          "  ```",
          "/bin/zsh -lc 'ade coordinator report_result --payload @/tmp/result.json' in /tmp/mission-lane",
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
      expect(after?.errorMessage).toBe("Planning worker session was interrupted while a shell command was still running before report_result.plan.markdown.");
      const [stepAfter] = fixture.service.listSteps(started.run.id);
      const metadata = stepAfter?.metadata as Record<string, unknown>;
      expect(metadata.lastResultReport).toBeUndefined();
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
            executorKind: "opencode"
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
        kind: "opencode",
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
            executorKind: "opencode"
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
        kind: "opencode",
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
            executorKind: "opencode",
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

  it("threads project provider permissions into executor launch config", async () => {
    const fixture = await createFixture({
      projectConfigService: {
        get: () => ({
          effective: {
            ai: {
              permissions: {
                cli: { mode: "full-auto", sandboxPermissions: "danger-full-access" },
                inProcess: { mode: "full-auto" },
                providers: {
                  claude: "edit",
                  codex: "config-toml",
                  opencode: "full-auto",
                  codexSandbox: "read-only",
                  allowedTools: ["Bash"],
                },
              },
            },
          },
        }),
      },
    });
    try {
      fixture.db.run(
        `update missions set metadata_json = ? where id = ? and project_id = ?`,
        [
          JSON.stringify({
            launch: {
              permissionConfig: {
                inProcess: { mode: "plan" },
              },
            },
          }),
          fixture.missionId,
          fixture.projectId,
        ]
      );

      let capturedPermissionConfig: Record<string, unknown> | undefined;
      fixture.service.registerExecutorAdapter({
        kind: "opencode",
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
            stepKey: "project-provider-permissions",
            title: "Project provider permissions",
            stepIndex: 0,
            executorKind: "opencode",
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
      const providers = capturedPermissionConfig?._providers as Record<string, unknown> | undefined;
      expect(cli?.mode).toBe("edit");
      expect(cli?.sandboxPermissions).toBe("read-only");
      expect(inProcess?.mode).toBe("plan");
      expect(providers?.codex).toBe("config-toml");
      expect(providers?.opencode).toBe("plan");
      expect(providers?.allowedTools).toEqual(["Bash"]);
    } finally {
      fixture.dispose();
    }
  });

  it("does not let Claude full-auto defaults bypass Codex sandbox flags", async () => {
    const fixture = await createFixture({
      projectConfigService: {
        get: () => ({
          effective: {
            ai: {
              permissions: {
                providers: {
                  claude: "full-auto",
                  codex: "default",
                  codexSandbox: "workspace-write",
                },
              },
            },
          },
        }),
      },
    });
    try {
      const now = "2026-02-19T00:00:00.000Z";
      const transcriptDir = path.join(fixture.projectRoot, ".ade", "transcripts");
      fs.mkdirSync(transcriptDir, { recursive: true });
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
            stepKey: "codex-permissions",
            title: "Codex permissions",
            stepIndex: 0,
            laneId: fixture.laneId,
            executorKind: "opencode",
            metadata: {
              modelId: "openai/gpt-5.3-codex",
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

      expect(attempt.status).toBe("running");
      const startupCommand = String(fixture.ptyCreateCalls[0]?.startupCommand ?? "");
      expect(startupCommand).toContain("codex");
      expect(startupCommand).toMatch(/(?:--sandbox|-s)\s+'?workspace-write'?/);
      expect(startupCommand).toMatch(/(?:--ask-for-approval|-a)\s+'?on-request'?/);
      expect(startupCommand).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    } finally {
      fixture.dispose();
    }
  });

  it("uses safe permission defaults when project and mission permission settings are missing", async () => {
    const fixture = await createFixture();
    try {
      let capturedPermissionConfig: Record<string, unknown> | undefined;
      fixture.service.registerExecutorAdapter({
        kind: "opencode",
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
            executorKind: "opencode",
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

  it("runs non-CLI opencode attempts in-process without spawning terminal sessions", async () => {
    const executeTask = vi.fn(async () => ({
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
        executeTask
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
            executorKind: "opencode",
            metadata: {
              modelId: "opencode/openai/gpt-5.4"
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
      expect(executeTask).toHaveBeenCalledWith(
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
    const executeTask = vi.fn(async () => ({
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
        executeTask,
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
            executorKind: "opencode",
            metadata: {
              modelId: "opencode/openai/gpt-5.4",
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
        kind: "opencode",
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
            executorKind: "opencode",
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
        kind: "opencode",
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
            executorKind: "opencode",
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

  it("allows an explicitly superseded failed step to be skipped with rationale", async () => {
    const fixture = await createFixture();
    try {
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [{ stepKey: "failed-but-superseded", title: "Failed But Superseded", stepIndex: 0 }]
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
        status: "failed",
        errorMessage: "Validation reported contradicting evidence."
      });

      expect(() =>
        fixture.service.skipStep({
          runId: started.run.id,
          stepId: step.id,
          reason: "Superseded by replacement validation."
        })
      ).toThrow(/terminal/i);

      const skipped = fixture.service.skipStep({
        runId: started.run.id,
        stepId: step.id,
        reason: "Superseded by replacement validation.",
        allowTerminal: true
      });
      expect(skipped.status).toBe("skipped");
      expect(skipped.metadata).toMatchObject({
        skippedFromStatus: "failed",
        skippedReason: "Superseded by replacement validation."
      });
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
        kind: "opencode",
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
            metadata: { adapterKind: "opencode" }
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
        defaultExecutorKind: "opencode",
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
        kind: "opencode",
        start: async () => ({
          status: "accepted" as const,
          sessionId: "ghost-session-999",
          metadata: { adapterKind: "opencode" }
        })
      });

      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [
          {
            stepKey: "orphan-session-step",
            title: "Step with missing session",
            stepIndex: 0,
            executorKind: "opencode"
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

  it("supersedes ready auto-spawned validators when the target already has a passing validation report", async () => {
    const fixture = await createFixture();
    try {
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        metadata: {
          autopilot: {
            enabled: true,
            executorKind: "opencode",
            ownerId: "autopilot-owner",
            parallelismCap: 1
          }
        },
        steps: [
          {
            stepKey: "test-npm",
            title: "Run npm test",
            stepIndex: 0,
            laneId: fixture.laneId,
            executorKind: "opencode",
            metadata: {
              validationContract: {
                level: "step",
                tier: "dedicated",
                required: true,
                criteria: "Validate completed tests",
                evidence: [],
                maxRetries: 2
              }
            }
          }
        ]
      });
      const targetStep = fixture.service.listSteps(started.run.id).find((step) => step.stepKey === "test-npm");
      if (!targetStep) throw new Error("Missing target step");
      const validatedAt = "2026-03-04T00:10:00.000Z";
      fixture.db.run(
        `
          update orchestrator_steps
          set status = 'succeeded',
              metadata_json = ?,
              started_at = coalesce(started_at, ?),
              completed_at = ?,
              updated_at = ?
          where id = ?
            and project_id = ?
        `,
        [
          JSON.stringify({
            ...(targetStep.metadata ?? {}),
            validationState: "pass",
            validationPassedAt: validatedAt
          }),
          validatedAt,
          validatedAt,
          validatedAt,
          targetStep.id,
          fixture.projectId
        ]
      );
      fixture.service.addSteps({
        runId: started.run.id,
        steps: [
          {
            stepKey: "validate_test-npm",
            title: "Validate: Run npm test",
            stepIndex: 1,
            laneId: fixture.laneId,
            dependencyStepKeys: ["test-npm"],
            executorKind: "opencode",
            metadata: {
              stepType: "validation",
              autoSpawnedValidation: true,
              targetStepId: targetStep.id,
              targetStepKey: targetStep.stepKey,
              validationContract: {
                level: "step",
                tier: "dedicated",
                required: true,
                criteria: "Validate completed tests",
                evidence: [],
                maxRetries: 2
              }
            }
          }
        ]
      });

      const startedAttempts = await fixture.service.startReadyAutopilotAttempts({
        runId: started.run.id,
        reason: "test_target_validation_passed"
      });

      expect(startedAttempts).toBe(0);
      expect(fixture.service.listAttempts({ runId: started.run.id })).toHaveLength(0);
      expect(fixture.ptyCreateCalls).toHaveLength(0);
      const validator = fixture.service.listSteps(started.run.id).find((step) => step.stepKey === "validate_test-npm");
      expect(validator?.status).toBe("superseded");
      expect((validator?.metadata as Record<string, unknown>)?.supersededReason).toBe("target_validation_already_passed");
      const timeline = fixture.service.listTimeline({ runId: started.run.id, limit: 100 });
      expect(timeline.some((event) => event.eventType === "validation_auto_step_superseded")).toBe(true);
    } finally {
      fixture.dispose();
    }
  });

  it("heals failed auto-spawned validators after the target receives a passing validation report", async () => {
    const fixture = await createFixture();
    try {
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [
          {
            stepKey: "test-npm",
            title: "Run npm test",
            stepIndex: 0,
            laneId: fixture.laneId,
            metadata: {
              validationContract: {
                level: "step",
                tier: "dedicated",
                required: true,
                criteria: "Validate completed tests",
                evidence: [],
                maxRetries: 2
              },
              validationState: "pass",
              validationPassedAt: "2026-03-04T00:10:00.000Z"
            }
          }
        ]
      });
      const targetStep = fixture.service.listSteps(started.run.id).find((step) => step.stepKey === "test-npm");
      if (!targetStep) throw new Error("Missing target step");
      fixture.db.run(
        `update orchestrator_steps set status = 'succeeded', completed_at = ?, updated_at = ? where id = ? and project_id = ?`,
        ["2026-03-04T00:10:00.000Z", "2026-03-04T00:10:00.000Z", targetStep.id, fixture.projectId]
      );
      const [validator] = fixture.service.addSteps({
        runId: started.run.id,
        steps: [
          {
            stepKey: "validate_test-npm",
            title: "Validate: Run npm test",
            stepIndex: 1,
            laneId: fixture.laneId,
            dependencyStepKeys: ["test-npm"],
            executorKind: "opencode",
            metadata: {
              stepType: "validation",
              autoSpawnedValidation: true,
              targetStepId: targetStep.id,
              targetStepKey: targetStep.stepKey
            }
          }
        ]
      });
      if (!validator) throw new Error("Missing validator step");
      fixture.db.run(
        `
          insert into orchestrator_chat_threads(
            id, project_id, mission_id, thread_type, title, run_id, step_id,
            step_key, attempt_id, session_id, lane_id, status, unread_count,
            metadata_json, created_at, updated_at
          ) values (?, ?, ?, 'worker', ?, ?, ?, ?, null, null, ?, 'active', 1, null, ?, ?)
        `,
        [
          "worker-thread-validate-test-npm",
          fixture.projectId,
          fixture.missionId,
          "Worker: validate_test-npm",
          started.run.id,
          validator.id,
          validator.stepKey,
          fixture.laneId,
          "2026-03-04T00:11:00.000Z",
          "2026-03-04T00:11:00.000Z"
        ]
      );
      fixture.db.run(
        `update orchestrator_steps set status = 'failed', completed_at = ?, updated_at = ? where id = ? and project_id = ?`,
        ["2026-03-04T00:11:00.000Z", "2026-03-04T00:11:00.000Z", validator.id, fixture.projectId]
      );

      fixture.service.tick({ runId: started.run.id });

      const healed = fixture.service.listSteps(started.run.id).find((step) => step.stepKey === "validate_test-npm");
      expect(healed?.status).toBe("superseded");
      expect((healed?.metadata as Record<string, unknown>)?.targetValidationAlreadyPassed).toBe(true);
      const thread = fixture.db.get<{ status: string }>(
        `select status from orchestrator_chat_threads where id = ?`,
        ["worker-thread-validate-test-npm"]
      );
      expect(thread?.status).toBe("closed");
    } finally {
      fixture.dispose();
    }
  });

  it("reconciles active worker threads for terminal steps during tick", async () => {
    const fixture = await createFixture();
    try {
      const started = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [
          {
            stepKey: "validate-output",
            title: "Validate output",
            stepIndex: 0,
            laneId: fixture.laneId,
            metadata: { stepType: "validation" }
          }
        ]
      });
      const step = fixture.service.listSteps(started.run.id).find((entry) => entry.stepKey === "validate-output");
      if (!step) throw new Error("Missing validation step");
      fixture.db.run(
        `update orchestrator_steps set status = 'failed', completed_at = ?, updated_at = ? where id = ? and project_id = ?`,
        ["2026-03-04T00:12:00.000Z", "2026-03-04T00:12:00.000Z", step.id, fixture.projectId]
      );
      fixture.db.run(
        `
          insert into orchestrator_chat_threads(
            id, project_id, mission_id, thread_type, title, run_id, step_id,
            step_key, attempt_id, session_id, lane_id, status, unread_count,
            metadata_json, created_at, updated_at
          ) values (?, ?, ?, 'worker', ?, ?, ?, ?, null, null, ?, 'active', 1, null, ?, ?)
        `,
        [
          "worker-thread-validate-output",
          fixture.projectId,
          fixture.missionId,
          "Worker: validate-output",
          started.run.id,
          step.id,
          step.stepKey,
          fixture.laneId,
          "2026-03-04T00:12:00.000Z",
          "2026-03-04T00:12:00.000Z"
        ]
      );

      fixture.service.tick({ runId: started.run.id });

      const thread = fixture.db.get<{ status: string }>(
        `select status from orchestrator_chat_threads where id = ?`,
        ["worker-thread-validate-output"]
      );
      expect(thread?.status).toBe("closed");
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
