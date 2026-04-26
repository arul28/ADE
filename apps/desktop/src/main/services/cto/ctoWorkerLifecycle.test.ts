import YAML from "yaml";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentIdentity } from "../../../shared/types";
import type { AgentIdentity, WorkerAgentRunStatus, WorkerAgentWakeupReason } from "../../../shared/types";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenclawBridgeService } from "./openclawBridgeService";
import { createWorkerAdapterRuntimeService } from "./workerAdapterRuntimeService";
import { createWorkerAgentService } from "./workerAgentService";
import { createWorkerBudgetService } from "./workerBudgetService";
import { createWorkerHeartbeatService } from "./workerHeartbeatService";
import { createWorkerRevisionService } from "./workerRevisionService";
import { createWorkerTaskSessionService } from "./workerTaskSessionService";
import { describe, expect, it } from "vitest";
import { describe, expect, it, vi } from "vitest";
import { describe, expect, it, vi, afterEach } from "vitest";
import { openKvDb } from "../state/kvDb";
import { openKvDb, type AdeDb } from "../state/kvDb";

describe("workerHeartbeatService (file group)", () => {

  function createLogger() {
    return {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    } as any;
  }

  function nowIso(): string {
    return new Date().toISOString();
  }

  async function waitForCondition(assertion: () => void, timeoutMs = 3_000, intervalMs = 15): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown = null;
    while (Date.now() <= deadline) {
      try {
        assertion();
        return;
      } catch (error) {
        lastError = error;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw lastError instanceof Error ? lastError : new Error("Condition timed out.");
  }

  function insertRunRow(
    db: AdeDb,
    input: {
      id: string;
      projectId: string;
      agentId: string;
      status: WorkerAgentRunStatus;
      wakeupReason?: WorkerAgentWakeupReason;
      taskKey?: string | null;
      issueKey?: string | null;
      executionRunId?: string | null;
      executionLockedAt?: string | null;
      contextJson?: string | null;
      resultJson?: string | null;
      errorMessage?: string | null;
      startedAt?: string | null;
      finishedAt?: string | null;
      createdAt?: string;
      updatedAt?: string;
    }
  ): void {
    const createdAt = input.createdAt ?? nowIso();
    const updatedAt = input.updatedAt ?? createdAt;
    db.run(
      `
        insert into worker_agent_runs(
          id, project_id, agent_id, status, wakeup_reason, task_key, issue_key, execution_run_id, execution_locked_at,
          context_json, result_json, error_message, started_at, finished_at, created_at, updated_at
        )
        values(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        input.id,
        input.projectId,
        input.agentId,
        input.status,
        input.wakeupReason ?? "manual",
        input.taskKey ?? null,
        input.issueKey ?? null,
        input.executionRunId ?? null,
        input.executionLockedAt ?? null,
        input.contextJson ?? "{}",
        input.resultJson ?? null,
        input.errorMessage ?? null,
        input.startedAt ?? null,
        input.finishedAt ?? null,
        createdAt,
        updatedAt,
      ]
    );
  }

  async function createFixture(options: {
    runtimeRun?: ReturnType<typeof vi.fn>;
    memoryService?: {
      getMemoryBudget: ReturnType<typeof vi.fn>;
    };
    ctoStateService?: {
      appendSubordinateActivity: ReturnType<typeof vi.fn>;
    };
    autoStart?: boolean;
    staleLockMs?: number;
    maintenanceIntervalMs?: number;
  } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-worker-heartbeat-"));
    const adeDir = path.join(root, ".ade");
    fs.mkdirSync(adeDir, { recursive: true });
    const db = await openKvDb(path.join(adeDir, "ade.db"), createLogger());
    const projectId = "project-heartbeat-test";
    const workerAgentService = createWorkerAgentService({
      db,
      projectId,
      adeDir,
    });
    const workerTaskSessionService = createWorkerTaskSessionService({
      db,
      projectId,
    });
    const runtimeRun = options.runtimeRun ?? vi.fn(async () => ({
      ok: true,
      adapterType: "codex-local",
      effectiveSurface: "process",
      statusCode: 200,
      outputText: "HEARTBEAT_OK",
      provider: "codex",
      modelId: "openai/gpt-5.3-codex",
      continuation: null,
      usage: null,
    }));
    const runtimeAdapter = {
      run: vi.fn(async (...runtimeArgs: any[]) => {
        const result = await runtimeRun(...runtimeArgs) as Record<string, unknown>;
        return {
          effectiveSurface: "process",
          provider: null,
          modelId: null,
          sessionId: null,
          continuation: null,
          ...result,
        };
      }),
    };
    const recordCostEvent = vi.fn();
    const heartbeat = createWorkerHeartbeatService({
      db,
      projectId,
      workerAgentService,
      workerTaskSessionService,
      workerAdapterRuntimeService: runtimeAdapter as any,
      workerBudgetService: { recordCostEvent } as any,
      memoryService: options.memoryService as any,
      ctoStateService: options.ctoStateService as any,
      logger: createLogger(),
      autoStart: options.autoStart ?? false,
      staleLockMs: options.staleLockMs,
      maintenanceIntervalMs: options.maintenanceIntervalMs,
    });

    const createWorker = (overrides: Partial<AgentIdentity> & { name: string }): AgentIdentity => {
      return workerAgentService.saveAgent({
        id: overrides.id,
        name: overrides.name,
        role: overrides.role ?? "engineer",
        title: overrides.title,
        reportsTo: overrides.reportsTo,
        capabilities: overrides.capabilities ?? [],
        adapterType: overrides.adapterType ?? "codex-local",
        adapterConfig: (overrides.adapterConfig as Record<string, unknown> | undefined) ?? { model: "gpt-5.3-codex" },
        runtimeConfig: (overrides.runtimeConfig as Record<string, unknown> | undefined) ?? {
          heartbeat: {
            enabled: true,
            intervalSec: 60,
            wakeOnDemand: true,
          },
        },
        status: overrides.status,
        budgetMonthlyCents: overrides.budgetMonthlyCents,
      });
    };

    const dispose = async () => {
      await heartbeat.dispose();
      db.close();
    };

    return {
      root,
      adeDir,
      db,
      projectId,
      workerAgentService,
      workerTaskSessionService,
      heartbeat,
      runtimeRun,
      recordCostEvent,
      createWorker,
      dispose,
    };
  }

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  describe("workerHeartbeatService", () => {
    it("timer wake fires at configured interval", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-05T12:00:00.000Z"));
      const fixture = await createFixture();
      const worker = fixture.createWorker({
        name: "Timer Worker",
        runtimeConfig: {
          heartbeat: {
            enabled: true,
            intervalSec: 1,
            wakeOnDemand: true,
          },
        },
      });

      fixture.heartbeat.syncFromConfig();
      await vi.advanceTimersByTimeAsync(1_200);

      // Assert directly after advancing fake timers -- waitForCondition cannot
      // work here because its internal setTimeout/Date.now rely on real timers.
      const runs = fixture.heartbeat.listRuns({ agentId: worker.id, limit: 5 });
      expect(runs.length).toBeGreaterThan(0);
      expect(runs[0]?.wakeupReason).toBe("timer");
      expect(runs[0]?.status).toBe("completed");
      await fixture.dispose();
    });

    it("active-hours gate blocks timer wakes outside configured window", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-05T12:00:00.000Z"));
      const fixture = await createFixture();
      const worker = fixture.createWorker({
        name: "Active Hours Timer Worker",
        runtimeConfig: {
          heartbeat: {
            enabled: true,
            intervalSec: 30,
            wakeOnDemand: true,
            activeHours: {
              start: "00:00",
              end: "00:01",
              timezone: "UTC",
            },
          },
        },
      });

      const wake = await fixture.heartbeat.triggerWakeup({
        agentId: worker.id,
        reason: "timer",
      });
      expect(wake.status).toBe("deferred");
      expect(fixture.runtimeRun).not.toHaveBeenCalled();
      await fixture.dispose();
    });

    it("on-demand wake also respects active-hours gate", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-03-05T12:00:00.000Z"));
      const fixture = await createFixture();
      const worker = fixture.createWorker({
        name: "Active Hours Manual Worker",
        runtimeConfig: {
          heartbeat: {
            enabled: true,
            intervalSec: 60,
            wakeOnDemand: true,
            activeHours: {
              start: "00:00",
              end: "00:01",
              timezone: "UTC",
            },
          },
        },
      });

      const wake = await fixture.heartbeat.triggerWakeup({
        agentId: worker.id,
        reason: "manual",
        prompt: "Please inspect current assignment",
      });
      expect(wake.status).toBe("deferred");
      expect(fixture.runtimeRun).not.toHaveBeenCalled();
      await fixture.dispose();
    });

    it("cheap-check timer run with no change skips adapter escalation", async () => {
      const fixture = await createFixture();
      const worker = fixture.createWorker({ name: "Cheap Check Worker" });

      const wake = await fixture.heartbeat.triggerWakeup({
        agentId: worker.id,
        reason: "timer",
        context: { hasChanges: false, eventCount: 0 },
      });
      expect(wake.status).toBe("completed");
      expect(fixture.runtimeRun).not.toHaveBeenCalled();
      await fixture.dispose();
    });

    it("records HEARTBEAT_OK results without errors", async () => {
      const runtimeRun = vi.fn(async () => ({
        ok: true,
        adapterType: "codex-local",
        statusCode: 200,
        outputText: "HEARTBEAT_OK",
        usage: null,
      }));
      const fixture = await createFixture({ runtimeRun });
      const worker = fixture.createWorker({ name: "Heartbeat Ok Worker" });

      const wake = await fixture.heartbeat.triggerWakeup({
        agentId: worker.id,
        reason: "manual",
        prompt: "Check for urgent events",
      });
      const run = fixture.heartbeat.listRuns({ agentId: worker.id, limit: 5 }).find((entry) => entry.id === wake.runId);
      expect(run?.status).toBe("completed");
      expect((run?.result as Record<string, unknown>)?.heartbeatOk).toBe(true);
      expect((run?.result as Record<string, unknown>)?.outputPreview).toBe("HEARTBEAT_OK");
      await fixture.dispose();
    });

    it("injects worker reconstruction, task session, and project memory into runtime prompts", async () => {
      const runtimeRun = vi.fn(async () => ({
        ok: true,
        adapterType: "codex-local",
        statusCode: 200,
        outputText: "looked good",
        usage: null,
      }));
      const memoryService = {
        getMemoryBudget: vi.fn(() => ([
          {
            category: "pattern",
            content: "Reuse the issue lock before starting a second worker on the same issue.",
          },
        ])),
      };
      const fixture = await createFixture({ runtimeRun, memoryService });
      const worker = fixture.createWorker({ name: "Memory Rich Worker" });
      fixture.workerAgentService.updateCoreMemory(worker.id, {
        projectSummary: "Owns worker-side issue triage and escalation.",
        criticalConventions: ["Prefer HEARTBEAT_OK when there is no actionable work."],
        activeFocus: ["Issue triage"],
      });

      await fixture.heartbeat.triggerWakeup({
        agentId: worker.id,
        reason: "manual",
        taskKey: "task:memory-rich",
        issueKey: "ISSUE-900",
        prompt: "Inspect the issue queue and decide whether escalation is needed.",
        context: { queue: "bugs", severity: "high" },
      });

      expect(runtimeRun).toHaveBeenCalledTimes(1);
      const firstCall = (runtimeRun.mock.calls as Array<any[]>)[0]?.[0] as { prompt?: string } | undefined;
      const prompt = String(firstCall?.prompt ?? "");
      expect(prompt).toContain("System context (worker reconstruction, do not echo verbatim):");
      expect(prompt).toContain("Owns worker-side issue triage and escalation.");
      expect(prompt).toContain("Project memory highlights:");
      expect(prompt).toContain("Reuse the issue lock before starting a second worker on the same issue.");
      expect(prompt).toContain("Task session state:");
      expect(prompt).toContain("task:memory-rich");
      expect(prompt).toContain("Current wakeup request:");
      await fixture.dispose();
    });

    it("appends worker session logs after escalated runs so reconstruction memory compounds", async () => {
      const runtimeRun = vi.fn(async () => ({
        ok: true,
        adapterType: "codex-local",
        statusCode: 200,
        outputText: "Reviewed alerts and found no actionable follow-up.",
        usage: null,
      }));
      const fixture = await createFixture({ runtimeRun });
      const worker = fixture.createWorker({ name: "Session Log Worker" });

      await fixture.heartbeat.triggerWakeup({
        agentId: worker.id,
        reason: "manual",
        taskKey: "task:session-log",
        prompt: "Review the alert backlog.",
      });

      const sessions = fixture.workerAgentService.listSessionLogs(worker.id, 10);
      expect(sessions.length).toBe(1);
      expect(sessions[0]?.summary).toContain("Wake reason: manual.");
      expect(sessions[0]?.summary).toContain("task:session-log");
      await fixture.dispose();
    });

    it("propagates meaningful worker runs into CTO subordinate activity", async () => {
      const runtimeRun = vi.fn(async () => ({
        ok: true,
        adapterType: "codex-local",
        statusCode: 200,
        outputText: "Reviewed alerts and found no actionable follow-up.",
        usage: null,
      }));
      const ctoStateService = {
        appendSubordinateActivity: vi.fn(),
      };
      const fixture = await createFixture({ runtimeRun, ctoStateService });
      const worker = fixture.createWorker({ name: "Digest Worker" });

      await fixture.heartbeat.triggerWakeup({
        agentId: worker.id,
        reason: "manual",
        taskKey: "task:cto-digest",
        issueKey: "ISSUE-42",
        prompt: "Review the alert backlog.",
      });

      expect(ctoStateService.appendSubordinateActivity).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: worker.id,
          agentName: "Digest Worker",
          activityType: "worker_run",
          taskKey: "task:cto-digest",
          issueKey: "ISSUE-42",
        })
      );
      await fixture.dispose();
    });

    it("coalesces duplicate wakeups while same task is running", async () => {
      let resolveFirst!: (value: {
        ok: boolean;
        adapterType: string;
        statusCode: number;
        outputText: string;
        usage: null;
      }) => void;
      const runtimeRun = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveFirst = resolve;
            })
        )
        .mockResolvedValue({
          ok: true,
          adapterType: "codex-local",
          statusCode: 200,
          outputText: "done",
          usage: null,
        });

      const fixture = await createFixture({ runtimeRun });
      const worker = fixture.createWorker({ name: "Coalescing Worker" });

      const firstWakePromise = fixture.heartbeat.triggerWakeup({
        agentId: worker.id,
        reason: "manual",
        taskKey: "task:same",
        issueKey: "ISSUE-123",
        prompt: "Work on issue 123",
        context: { source: "first" },
      });

      await waitForCondition(() => {
        const running = fixture.heartbeat
          .listRuns({ agentId: worker.id, limit: 10 })
          .find((run) => run.status === "running");
        expect(running).toBeTruthy();
      });

      const secondWake = await fixture.heartbeat.triggerWakeup({
        agentId: worker.id,
        reason: "manual",
        taskKey: "task:same",
        issueKey: "ISSUE-123",
        context: { source: "second" },
      });
      expect(secondWake.status).toBe("skipped");

      resolveFirst({
        ok: true,
        adapterType: "codex-local",
        statusCode: 200,
        outputText: "complete",
        usage: null,
      });
      const firstWake = await firstWakePromise;

      await waitForCondition(() => {
        const firstRun = fixture.heartbeat.listRuns({ agentId: worker.id, limit: 10 }).find((run) => run.id === firstWake.runId);
        expect(firstRun?.status).toBe("completed");
      });

      const latestRuns = fixture.heartbeat.listRuns({ agentId: worker.id, limit: 10 });
      const firstRun = latestRuns.find((run) => run.id === firstWake.runId);
      const coalesced = (firstRun?.context.coalescedWakeups as unknown[]) ?? [];
      expect(coalesced.length).toBe(1);
      await fixture.dispose();
    });

    it("promotes deferred wake after active run completes", async () => {
      let resolveFirst!: (value: {
        ok: boolean;
        adapterType: string;
        statusCode: number;
        outputText: string;
        usage: null;
      }) => void;
      const runtimeRun = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveFirst = resolve;
            })
        )
        .mockResolvedValue({
          ok: true,
          adapterType: "codex-local",
          statusCode: 200,
          outputText: "second-complete",
          usage: null,
        });
      const fixture = await createFixture({ runtimeRun });
      const worker = fixture.createWorker({ name: "Deferred Promotion Worker" });

      const firstWakePromise = fixture.heartbeat.triggerWakeup({
        agentId: worker.id,
        reason: "manual",
        taskKey: "task:first",
        issueKey: "ISSUE-A",
        prompt: "first task",
      });
      await waitForCondition(() => {
        const running = fixture.heartbeat.listRuns({ agentId: worker.id, limit: 10 }).find((run) => run.status === "running");
        expect(running).toBeTruthy();
      });

      const secondWake = await fixture.heartbeat.triggerWakeup({
        agentId: worker.id,
        reason: "manual",
        taskKey: "task:second",
        issueKey: "ISSUE-B",
        prompt: "second task",
      });
      expect(secondWake.status).toBe("deferred");

      resolveFirst({
        ok: true,
        adapterType: "codex-local",
        statusCode: 200,
        outputText: "first-complete",
        usage: null,
      });
      await firstWakePromise;

      await waitForCondition(() => {
        const promoted = fixture.heartbeat.listRuns({ agentId: worker.id, limit: 10 }).find((run) => run.id === secondWake.runId);
        expect(promoted?.status).toBe("completed");
      });
      expect(runtimeRun).toHaveBeenCalledTimes(2);
      await fixture.dispose();
    });

    it("reaps orphaned queued/running runs on startup and promotes deferred work", async () => {
      const runtimeRun = vi.fn(async () => ({
        ok: true,
        adapterType: "codex-local",
        statusCode: 200,
        outputText: "startup-recovered",
        usage: null,
      }));
      const fixture = await createFixture({ runtimeRun });
      const worker = fixture.createWorker({ name: "Startup Recovery Worker" });
      const timestamp = "2026-03-05T00:00:00.000Z";

      insertRunRow(fixture.db, {
        id: "orphan-queued",
        projectId: fixture.projectId,
        agentId: worker.id,
        status: "queued",
        wakeupReason: "startup_recovery",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      insertRunRow(fixture.db, {
        id: "orphan-running",
        projectId: fixture.projectId,
        agentId: worker.id,
        status: "running",
        wakeupReason: "startup_recovery",
        executionRunId: "exec-orphan",
        executionLockedAt: timestamp,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      insertRunRow(fixture.db, {
        id: "recoverable-deferred",
        projectId: fixture.projectId,
        agentId: worker.id,
        status: "deferred",
        wakeupReason: "deferred_promotion",
        taskKey: "task:recover",
        issueKey: "ISSUE-RECOVER",
        contextJson: JSON.stringify({ prompt: "recover deferred task" }),
        createdAt: timestamp,
        updatedAt: timestamp,
      });

      await fixture.heartbeat.reapOrphansOnStartup();

      await waitForCondition(() => {
        const runs = fixture.heartbeat.listRuns({ agentId: worker.id, limit: 20 });
        expect(runs.find((run) => run.id === "orphan-queued")?.status).toBe("failed");
        expect(runs.find((run) => run.id === "orphan-running")?.status).toBe("failed");
        expect(runs.find((run) => run.id === "recoverable-deferred")?.status).toBe("completed");
      });

      await fixture.dispose();
    });

    it("issue lock checkout blocks parallel run for same issue", async () => {
      let resolveFirst!: (value: {
        ok: boolean;
        adapterType: string;
        statusCode: number;
        outputText: string;
        usage: null;
      }) => void;
      const runtimeRun = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveFirst = resolve;
            })
        )
        .mockResolvedValue({
          ok: true,
          adapterType: "codex-local",
          statusCode: 200,
          outputText: "done",
          usage: null,
        });
      const fixture = await createFixture({ runtimeRun });
      const workerA = fixture.createWorker({ name: "Issue Locker A" });
      const workerB = fixture.createWorker({ name: "Issue Locker B" });

      const firstWakePromise = fixture.heartbeat.triggerWakeup({
        agentId: workerA.id,
        reason: "manual",
        issueKey: "ISSUE-LOCK",
        prompt: "worker A task",
      });
      await waitForCondition(() => {
        const running = fixture.heartbeat.listRuns({ agentId: workerA.id, limit: 10 }).find((run) => run.status === "running");
        expect(running).toBeTruthy();
      });

      const secondWake = await fixture.heartbeat.triggerWakeup({
        agentId: workerB.id,
        reason: "manual",
        issueKey: "ISSUE-LOCK",
        prompt: "worker B task",
      });
      expect(secondWake.status).toBe("deferred");

      resolveFirst({
        ok: true,
        adapterType: "codex-local",
        statusCode: 200,
        outputText: "finish",
        usage: null,
      });
      await firstWakePromise;

      const secondRun = fixture.heartbeat.listRuns({ agentId: workerB.id, limit: 10 }).find((run) => run.id === secondWake.runId);
      expect(secondRun?.status).toBe("deferred");
      await fixture.dispose();
    });

    it("adopts stale issue lock and fails stale owner run", async () => {
      const fixture = await createFixture({ staleLockMs: 50 });
      const workerA = fixture.createWorker({ name: "Stale Owner" });
      const workerB = fixture.createWorker({ name: "Stale Adopter" });
      const staleAt = new Date(Date.now() - 120_000).toISOString();
      insertRunRow(fixture.db, {
        id: "stale-running-run",
        projectId: fixture.projectId,
        agentId: workerA.id,
        status: "running",
        wakeupReason: "manual",
        issueKey: "ISSUE-STALE",
        executionRunId: "exec-stale",
        executionLockedAt: staleAt,
        createdAt: staleAt,
        updatedAt: staleAt,
      });

      const wake = await fixture.heartbeat.triggerWakeup({
        agentId: workerB.id,
        reason: "manual",
        issueKey: "ISSUE-STALE",
        prompt: "adopt stale lock",
      });
      expect(wake.status).toBe("completed");

      const staleRun = fixture.heartbeat.listRuns({ agentId: workerA.id, limit: 10 }).find((run) => run.id === "stale-running-run");
      expect(staleRun?.status).toBe("failed");
      expect(staleRun?.errorMessage).toContain("adopted");
      await fixture.dispose();
    });

    it("waits for direct wakeup dispatches during dispose", async () => {
      let releaseRun: () => void = () => {
        throw new Error("Expected wakeup runtime to be blocked.");
      };
      const runtimeRun = vi.fn(async () => {
        await new Promise<void>((resolve) => {
          releaseRun = resolve;
        });
        return {
          ok: true,
          adapterType: "codex-local",
          effectiveSurface: "process",
          statusCode: 200,
          outputText: "completed wake",
          provider: "codex",
          modelId: "openai/gpt-5.3-codex",
          continuation: null,
          usage: null,
        };
      });
      const fixture = await createFixture({ runtimeRun });
      const worker = fixture.createWorker({ name: "Direct Wake Worker" });

      const wake = fixture.heartbeat.triggerWakeup({
        agentId: worker.id,
        reason: "manual",
        prompt: "run slowly",
      });
      await waitForCondition(() => {
        expect(runtimeRun).toHaveBeenCalledTimes(1);
      });

      let disposeSettled = false;
      const dispose = fixture.heartbeat.dispose().then(() => {
        disposeSettled = true;
      });
      await Promise.resolve();
      expect(disposeSettled).toBe(false);

      releaseRun();
      await wake;
      await dispose;
      expect(disposeSettled).toBe(true);
      fixture.db.close();
    });

    it("reuses persisted worker continuation handles across repeated wakeups on the same delegated task", async () => {
      const runtimeRun = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          adapterType: "codex-local",
          effectiveSurface: "codex_app_server",
          statusCode: 200,
          outputText: "completed first wake",
          provider: "codex",
          modelId: "openai/gpt-5.3-codex",
          sessionId: "session-1",
          continuation: {
            surface: "codex_app_server",
            provider: "codex",
            modelId: "openai/gpt-5.3-codex",
            sessionId: "session-1",
            threadId: "thread-1",
          },
          usage: null,
        })
        .mockResolvedValueOnce({
          ok: true,
          adapterType: "codex-local",
          effectiveSurface: "codex_app_server",
          statusCode: 200,
          outputText: "completed second wake",
          provider: "codex",
          modelId: "openai/gpt-5.3-codex",
          sessionId: "session-1",
          continuation: {
            surface: "codex_app_server",
            provider: "codex",
            modelId: "openai/gpt-5.3-codex",
            sessionId: "session-1",
            threadId: "thread-1",
          },
          usage: null,
        });
      const fixture = await createFixture({ runtimeRun });
      const worker = fixture.createWorker({ name: "Continuation Worker" });
      const taskKey = fixture.workerTaskSessionService.deriveTaskKey({
        agentId: worker.id,
        workflowRunId: "linear-run-1",
        laneId: "lane-123",
        linearIssueId: "issue-123",
        summary: "Resume delegated work",
      });

      await fixture.heartbeat.triggerWakeup({
        agentId: worker.id,
        reason: "assignment",
        taskKey,
        issueKey: "ABC-123",
        prompt: "first wake",
        context: {
          runId: "linear-run-1",
          laneId: "lane-123",
          issueId: "issue-123",
          issueTitle: "Resume delegated work",
        },
      });

      const persisted = fixture.workerTaskSessionService.getTaskSession(worker.id, worker.adapterType, taskKey);
      expect((persisted?.payload as Record<string, any>)?.continuity?.handle).toMatchObject({
        sessionId: "session-1",
        threadId: "thread-1",
      });

      await fixture.heartbeat.triggerWakeup({
        agentId: worker.id,
        reason: "assignment",
        taskKey,
        issueKey: "ABC-123",
        prompt: "second wake",
        context: {
          runId: "linear-run-1",
          laneId: "lane-123",
          issueId: "issue-123",
          issueTitle: "Resume delegated work",
        },
      });

      expect(runtimeRun).toHaveBeenCalledTimes(2);
      const secondCall = (runtimeRun.mock.calls as Array<any[]>)[1]?.[0] as Record<string, any>;
      expect(secondCall.laneId).toBe("lane-123");
      expect(secondCall.continuation).toMatchObject({
        sessionId: "session-1",
        threadId: "thread-1",
        surface: "codex_app_server",
      });

      await fixture.dispose();
    });
  });

});

describe("workerAdapterRuntimeService (file group)", () => {

  type SpawnStubCapture = {
    command: string;
    args: string[];
    stdinWritten: string;
  };

  function makeAgent(overrides: Partial<AgentIdentity>): AgentIdentity {
    return {
      id: "agent-1",
      name: "Worker",
      slug: "worker",
      role: "engineer",
      reportsTo: null,
      capabilities: [],
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      budgetMonthlyCents: 0,
      spentMonthlyCents: 0,
      createdAt: "2026-03-05T00:00:00.000Z",
      updatedAt: "2026-03-05T00:00:00.000Z",
      deletedAt: null,
      ...overrides,
    };
  }

  function createSpawnStub(output = "ok"): {
    spawn: any;
    capture: SpawnStubCapture;
  } {
    const capture: SpawnStubCapture = {
      command: "",
      args: [],
      stdinWritten: "",
    };
    const spawn = vi.fn((command: string, args: string[]) => {
      capture.command = command;
      capture.args = [...args];
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      const child = new EventEmitter() as any;
      child.stdout = stdout;
      child.stderr = stderr;
      child.stdin = {
        write: (chunk: string) => {
          capture.stdinWritten += chunk;
        },
        end: () => {},
      };
      child.kill = vi.fn();
      queueMicrotask(() => {
        stdout.emit("data", output);
        child.emit("close", 0, null);
      });
      return child;
    });
    return { spawn, capture };
  }

  function createSession(id: string, provider: "claude" | "codex" | "opencode", model: string, modelId: string) {
    return {
      id,
      laneId: "lane-1",
      provider,
      model,
      modelId,
      status: "idle" as const,
      createdAt: "2026-03-05T00:00:00.000Z",
      lastActivityAt: "2026-03-05T00:00:00.000Z",
    };
  }

  describe("workerAdapterRuntimeService", () => {
    it("runs claude-local through CLI spawn path", async () => {
      const { spawn, capture } = createSpawnStub("claude-output");
      const service = createWorkerAdapterRuntimeService({ spawnImpl: spawn as any });
      const result = await service.run({
        agent: makeAgent({
          adapterType: "claude-local",
          adapterConfig: { model: "sonnet", cliArgs: ["--json"] },
        }),
        prompt: "hello",
      });

      expect(capture.command).toBe("claude");
      expect(capture.args).toEqual(["--model", "sonnet", "--json"]);
      expect(capture.stdinWritten).toContain("hello");
      expect(result.ok).toBe(true);
      expect(result.effectiveSurface).toBe("process");
      expect(result.outputText).toContain("claude-output");
    });

    it("runs codex-local through CLI spawn path", async () => {
      const { spawn, capture } = createSpawnStub("codex-output");
      const service = createWorkerAdapterRuntimeService({ spawnImpl: spawn as any });
      const result = await service.run({
        agent: makeAgent({
          adapterType: "codex-local",
          adapterConfig: { model: "gpt-5.3-codex", cliArgs: ["--json"] },
        }),
        prompt: "fix this",
      });

      expect(path.basename(capture.command)).toBe("codex");
      expect(capture.args).toEqual(["--model", "gpt-5.3-codex", "--json"]);
      expect(result.ok).toBe(true);
      expect(result.effectiveSurface).toBe("process");
      expect(result.outputText).toContain("codex-output");
    });

    it("reuses Claude SDK session handles through the shared chat surface", async () => {
      const ensureIdentitySession = vi.fn(async () =>
        createSession("session-claude-1", "claude", "claude-sonnet-4-6", "anthropic/claude-sonnet-4-6")
      );
      const runSessionTurn = vi.fn(async () => ({
        sessionId: "session-claude-1",
        provider: "claude",
        model: "claude-sonnet-4-6",
        modelId: "anthropic/claude-sonnet-4-6",
        outputText: "claude session output",
        sdkSessionId: "sdk-session-1",
      }));
      const service = createWorkerAdapterRuntimeService({
        getAgentChatService: () => ({ ensureIdentitySession, runSessionTurn }),
      });

      const result = await service.run({
        agent: makeAgent({
          adapterType: "claude-local",
          adapterConfig: { modelId: "anthropic/claude-sonnet-4-6" },
        }),
        laneId: "lane-1",
        prompt: "resume the delegated issue",
      });

      expect(ensureIdentitySession).toHaveBeenCalledWith({
        identityKey: "agent:agent-1",
        laneId: "lane-1",
        modelId: "anthropic/claude-sonnet-4-6",
        reuseExisting: true,
      });
      expect(result.effectiveSurface).toBe("claude_sdk");
      expect(result.continuation).toMatchObject({
        surface: "claude_sdk",
        sessionId: "session-claude-1",
        sdkSessionId: "sdk-session-1",
      });
    });

    it("reuses Codex app-server thread handles through the shared chat surface", async () => {
      const ensureIdentitySession = vi.fn(async () =>
        createSession("session-codex-1", "codex", "gpt-5.3-codex", "openai/gpt-5.3-codex")
      );
      const runSessionTurn = vi.fn(async () => ({
        sessionId: "session-codex-1",
        provider: "codex",
        model: "gpt-5.3-codex",
        modelId: "openai/gpt-5.3-codex",
        outputText: "codex session output",
        threadId: "thread-77",
      }));
      const service = createWorkerAdapterRuntimeService({
        getAgentChatService: () => ({ ensureIdentitySession, runSessionTurn }),
      });

      const result = await service.run({
        agent: makeAgent({
          adapterType: "codex-local",
          adapterConfig: { modelId: "openai/gpt-5.3-codex" },
        }),
        laneId: "lane-1",
        prompt: "resume the delegated issue",
      });

      expect(result.effectiveSurface).toBe("codex_app_server");
      expect(result.continuation).toMatchObject({
        surface: "codex_app_server",
        sessionId: "session-codex-1",
        threadId: "thread-77",
      });
    });

    it("reuses opencode chat sessions for API-key or local-model workers", async () => {
      const ensureIdentitySession = vi.fn(async () =>
        createSession("session-opencode-1", "opencode", "gpt-5.4-mini", "openai/gpt-5.4-mini")
      );
      const runSessionTurn = vi.fn(async () => ({
        sessionId: "session-opencode-1",
        provider: "opencode",
        model: "gpt-5.4-mini",
        modelId: "openai/gpt-5.4-mini",
        outputText: "opencode chat output",
      }));
      const service = createWorkerAdapterRuntimeService({
        getAgentChatService: () => ({ ensureIdentitySession, runSessionTurn }),
      });

      const result = await service.run({
        agent: makeAgent({
          adapterType: "process",
          adapterConfig: { modelId: "openai/gpt-5.4-mini" },
        }),
        continuation: {
          surface: "unified_chat",
          sessionId: "session-opencode-1",
        },
        prompt: "continue the same worker context",
      });

      expect(ensureIdentitySession).not.toHaveBeenCalled();
      expect(runSessionTurn).toHaveBeenCalledWith({
        sessionId: "session-opencode-1",
        text: expect.stringContaining("continue the same worker context"),
        timeoutMs: 300000,
      });
      const firstCall = runSessionTurn.mock.calls[0] as unknown as [{ text: string }] | undefined;
      expect(firstCall?.[0]?.text).toContain("## ADE CLI");
      expect(firstCall?.[0]?.text).toContain("Before saying an ADE task is blocked");
      expect(result.effectiveSurface).toBe("unified_chat");
      expect(result.continuation).toMatchObject({
        surface: "unified_chat",
        sessionId: "session-opencode-1",
        modelId: "openai/gpt-5.4-mini",
      });
    });

    it("sends openclaw-webhook request with resolved env header", async () => {
      process.env.OPENCLAW_WEBHOOK_TOKEN = "secret-token";
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ output: "webhook-ok" }),
        } as any;
      });
      const service = createWorkerAdapterRuntimeService({ fetchImpl: fetchMock as any });
      const result = await service.run({
        agent: makeAgent({
          adapterType: "openclaw-webhook",
          adapterConfig: {
            url: "https://example.com/hook",
            headers: {
              Authorization: "Bearer ${env:OPENCLAW_WEBHOOK_TOKEN}",
            },
          },
        }),
        prompt: "run remote",
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret-token");
      expect(result.ok).toBe(true);
      expect(result.outputText).toBe("webhook-ok");
    });

    it("runs process adapter and blocks unsafe commands", async () => {
      const { spawn } = createSpawnStub("process-output");
      const service = createWorkerAdapterRuntimeService({ spawnImpl: spawn as any });
      const ok = await service.run({
        agent: makeAgent({
          adapterType: "process",
          adapterConfig: { command: "echo", args: ["hello"] },
        }),
        prompt: "test",
      });
      expect(ok.ok).toBe(true);
      expect(ok.outputText).toContain("process-output");

      await expect(
        service.run({
          agent: makeAgent({
            adapterType: "process",
            adapterConfig: { command: "rm -rf /" },
          }),
          prompt: "test",
        })
      ).rejects.toThrow(/unsafe/i);
    });
  });

});

describe("workerAgentService (file group)", () => {

  function createLogger() {
    return {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    } as any;
  }

  async function createFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-worker-agents-"));
    const adeDir = path.join(root, ".ade");
    fs.mkdirSync(adeDir, { recursive: true });
    const dbPath = path.join(adeDir, "ade.db");
    const db = await openKvDb(dbPath, createLogger());
    const projectId = "project-test";
    const service = createWorkerAgentService({
      db,
      projectId,
      adeDir,
    });
    return { root, adeDir, db, projectId, service };
  }

  describe("workerAgentService", () => {
    it("creates, edits, and removes worker agents with unlink-on-delete", async () => {
      const fixture = await createFixture();
      const manager = fixture.service.saveAgent({
        name: "Backend Lead",
        role: "engineer",
        adapterType: "claude-local",
        adapterConfig: { model: "sonnet" },
      });
      const report = fixture.service.saveAgent({
        name: "Backend IC",
        role: "engineer",
        reportsTo: manager.id,
        adapterType: "codex-local",
        adapterConfig: { model: "gpt-5.3-codex" },
      });

      const edited = fixture.service.saveAgent({
        id: report.id,
        name: "Backend Engineer",
        role: "engineer",
        reportsTo: manager.id,
        adapterType: "codex-local",
        adapterConfig: { model: "gpt-5.3-codex-spark" },
        capabilities: ["api", "tests"],
      });
      expect(edited.name).toBe("Backend Engineer");
      expect(edited.capabilities).toEqual(["api", "tests"]);

      fixture.service.removeAgent(manager.id);
      const unlinked = fixture.service.getAgent(report.id);
      expect(unlinked?.reportsTo).toBeNull();
      expect(fixture.service.getAgent(manager.id)).toBeNull();
      expect(fixture.service.getAgent(manager.id, { includeDeleted: true })?.deletedAt).toBeTruthy();

      fixture.db.close();
    });

    it("reconstructs org tree and chain-of-command", async () => {
      const fixture = await createFixture();
      const lead = fixture.service.saveAgent({
        name: "Lead",
        role: "engineer",
        adapterType: "claude-local",
        adapterConfig: {},
      });
      const mid = fixture.service.saveAgent({
        name: "Mid",
        role: "engineer",
        reportsTo: lead.id,
        adapterType: "claude-local",
        adapterConfig: {},
      });
      const junior = fixture.service.saveAgent({
        name: "Junior",
        role: "qa",
        reportsTo: mid.id,
        adapterType: "process",
        adapterConfig: { command: "echo" },
      });

      const tree = fixture.service.listOrgTree();
      expect(tree.length).toBe(1);
      expect(tree[0]?.id).toBe(lead.id);
      expect(tree[0]?.reports[0]?.id).toBe(mid.id);
      expect(tree[0]?.reports[0]?.reports[0]?.id).toBe(junior.id);

      const chain = fixture.service.getChainOfCommand(junior.id);
      expect(chain.map((entry) => entry.id)).toEqual([junior.id, mid.id, lead.id]);

      fixture.db.close();
    });

    it("blocks cycle creation and 50-hop overflow", async () => {
      const fixture = await createFixture();
      const a = fixture.service.saveAgent({
        name: "A",
        role: "engineer",
        adapterType: "claude-local",
        adapterConfig: {},
      });
      const b = fixture.service.saveAgent({
        name: "B",
        role: "engineer",
        reportsTo: a.id,
        adapterType: "claude-local",
        adapterConfig: {},
      });

      expect(() =>
        fixture.service.saveAgent({
          id: a.id,
          name: "A",
          role: "engineer",
          reportsTo: b.id,
          adapterType: "claude-local",
          adapterConfig: {},
        })
      ).toThrow(/cycle/i);

      let parentId = b.id;
      for (let i = 0; i < 49; i += 1) {
        const node = fixture.service.saveAgent({
          name: `worker-${i}`,
          role: "general",
          reportsTo: parentId,
          adapterType: "process",
          adapterConfig: { command: "echo" },
        });
        parentId = node.id;
      }

      expect(() =>
        fixture.service.saveAgent({
          name: "overflow-node",
          role: "general",
          reportsTo: parentId,
          adapterType: "process",
          adapterConfig: { command: "echo" },
        })
      ).toThrow(/50 hops/i);

      fixture.db.close();
    });

    it("rejects raw secret-like adapter config values", async () => {
      const fixture = await createFixture();
      expect(() =>
        fixture.service.saveAgent({
          name: "Remote",
          role: "researcher",
          adapterType: "openclaw-webhook",
          adapterConfig: {
            url: "https://example.com/hook",
            headers: {
              Authorization: "Bearer sk-secret-value",
            },
          },
        })
      ).toThrow(/raw secret-like value/i);

      const ok = fixture.service.saveAgent({
        name: "Remote 2",
        role: "researcher",
        adapterType: "openclaw-webhook",
        adapterConfig: {
          url: "https://example.com/hook",
          headers: {
            Authorization: "Bearer ${env:OPENCLAW_WEBHOOK_TOKEN}",
          },
        },
      });
      expect(ok.id).toBeTruthy();

      fixture.db.close();
    });

    it("normalizes legacy full_mcp worker session logs as full tooling", async () => {
      const fixture = await createFixture();
      const worker = fixture.service.saveAgent({
        name: "Legacy Worker",
        role: "engineer",
        adapterType: "codex-local",
        adapterConfig: {},
      });
      const sessionsPath = path.join(fixture.adeDir, "agents", worker.slug, "sessions.jsonl");
      fs.writeFileSync(
        sessionsPath,
        `${JSON.stringify({
          sessionId: "legacy-session",
          summary: "Legacy worker session",
          startedAt: "2026-03-05T10:00:00.000Z",
          endedAt: "2026-03-05T10:05:00.000Z",
          provider: "codex",
          modelId: "openai/gpt-5.3-codex",
          capabilityMode: "full_mcp",
          createdAt: "2026-03-05T10:06:00.000Z",
        })}\n`,
        "utf8"
      );

      expect(fixture.service.listSessionLogs(worker.id, 10)[0]?.capabilityMode).toBe("full_tooling");

      fixture.db.close();
    });
  });

});

describe("workerBudgetService (file group)", () => {

  function createLogger() {
    return {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    } as any;
  }

  async function createFixture(config?: { companyBudgetMonthlyCents?: number }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-worker-budget-"));
    const adeDir = path.join(root, ".ade");
    fs.mkdirSync(adeDir, { recursive: true });
    const dbPath = path.join(adeDir, "ade.db");
    const db = await openKvDb(dbPath, createLogger());
    const projectId = "project-test";
    const workerAgentService = createWorkerAgentService({
      db,
      projectId,
      adeDir,
    });
    const projectConfigService = {
      get: () => ({
        effective: {
          cto: {
            companyBudgetMonthlyCents: config?.companyBudgetMonthlyCents ?? 0,
            budgetTelemetry: {
              enabled: false,
            },
          },
        },
      }),
    } as any;
    const workerBudgetService = createWorkerBudgetService({
      db,
      projectId,
      workerAgentService,
      projectConfigService,
    });
    return { db, workerAgentService, workerBudgetService };
  }

  describe("workerBudgetService", () => {
    it("records cost events and combines exact+estimated spend", async () => {
      const fixture = await createFixture();
      const worker = fixture.workerAgentService.saveAgent({
        name: "Budget Worker",
        role: "engineer",
        adapterType: "codex-local",
        adapterConfig: { model: "gpt-5.3-codex" },
        budgetMonthlyCents: 10_000,
      });

      fixture.workerBudgetService.recordCostEvent({
        agentId: worker.id,
        provider: "openai",
        modelId: "gpt-5.3-codex",
        costCents: 120,
        estimated: false,
        source: "api",
      });
      fixture.workerBudgetService.recordCostEvent({
        agentId: worker.id,
        provider: "codex-local",
        modelId: "gpt-5.3-codex",
        costCents: 80,
        estimated: true,
        source: "cli",
      });

      const snapshot = fixture.workerBudgetService.getBudgetSnapshot();
      const row = snapshot.workers.find((entry) => entry.agentId === worker.id);
      expect(row?.exactSpentCents).toBe(120);
      expect(row?.estimatedSpentCents).toBe(80);
      expect(row?.spentMonthlyCents).toBe(200);
      expect(snapshot.companySpentMonthlyCents).toBe(200);
      expect(snapshot.companyExactSpentCents).toBe(120);
      expect(snapshot.companyEstimatedSpentCents).toBe(80);

      fixture.db.close();
    });

    it("auto-pauses worker when per-worker cap is breached", async () => {
      const fixture = await createFixture();
      const worker = fixture.workerAgentService.saveAgent({
        name: "Capped Worker",
        role: "qa",
        adapterType: "process",
        adapterConfig: { command: "echo" },
        budgetMonthlyCents: 150,
      });

      fixture.workerBudgetService.recordCostEvent({
        agentId: worker.id,
        provider: "manual",
        costCents: 151,
        estimated: false,
        source: "manual",
      });
      const updated = fixture.workerAgentService.getAgent(worker.id);
      expect(updated?.status).toBe("paused");

      fixture.db.close();
    });

    it("auto-pauses workers when company cap is breached", async () => {
      const fixture = await createFixture({ companyBudgetMonthlyCents: 200 });
      const workerA = fixture.workerAgentService.saveAgent({
        name: "A",
        role: "engineer",
        adapterType: "process",
        adapterConfig: { command: "echo" },
        budgetMonthlyCents: 0,
      });
      const workerB = fixture.workerAgentService.saveAgent({
        name: "B",
        role: "engineer",
        adapterType: "process",
        adapterConfig: { command: "echo" },
        budgetMonthlyCents: 0,
      });

      fixture.workerBudgetService.recordCostEvent({
        agentId: workerA.id,
        provider: "manual",
        costCents: 120,
        estimated: false,
        source: "manual",
      });
      fixture.workerBudgetService.recordCostEvent({
        agentId: workerB.id,
        provider: "manual",
        costCents: 120,
        estimated: false,
        source: "manual",
      });

      const stateA = fixture.workerAgentService.getAgent(workerA.id);
      const stateB = fixture.workerAgentService.getAgent(workerB.id);
      expect(stateA?.status).toBe("paused");
      expect(stateB?.status).toBe("paused");

      fixture.db.close();
    });

    it("respects monthly boundaries for spend accumulation", async () => {
      const fixture = await createFixture();
      const worker = fixture.workerAgentService.saveAgent({
        name: "Month Worker",
        role: "general",
        adapterType: "process",
        adapterConfig: { command: "echo" },
        budgetMonthlyCents: 0,
      });

      fixture.workerBudgetService.recordCostEvent({
        agentId: worker.id,
        provider: "manual",
        costCents: 50,
        estimated: false,
        source: "manual",
        occurredAt: "2026-01-31T23:59:00.000Z",
      });
      fixture.workerBudgetService.recordCostEvent({
        agentId: worker.id,
        provider: "manual",
        costCents: 75,
        estimated: false,
        source: "manual",
        occurredAt: "2026-02-01T00:00:00.000Z",
      });

      const jan = fixture.workerBudgetService.getBudgetSnapshot({ monthKey: "2026-01" });
      const feb = fixture.workerBudgetService.getBudgetSnapshot({ monthKey: "2026-02" });
      expect(jan.workers.find((entry) => entry.agentId === worker.id)?.spentMonthlyCents).toBe(50);
      expect(feb.workers.find((entry) => entry.agentId === worker.id)?.spentMonthlyCents).toBe(75);

      fixture.db.close();
    });
  });

});

describe("workerRevisionService (file group)", () => {

  function createLogger() {
    return {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    } as any;
  }

  async function createFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-worker-revisions-"));
    const adeDir = path.join(root, ".ade");
    fs.mkdirSync(adeDir, { recursive: true });
    const dbPath = path.join(adeDir, "ade.db");
    const db = await openKvDb(dbPath, createLogger());
    const projectId = "project-test";
    const workerAgentService = createWorkerAgentService({
      db,
      projectId,
      adeDir,
    });
    const workerRevisionService = createWorkerRevisionService({
      db,
      projectId,
      workerAgentService,
    });
    return { db, projectId, workerAgentService, workerRevisionService };
  }

  describe("workerRevisionService", () => {
    it("records revisions on create and update with changed-key detection", async () => {
      const fixture = await createFixture();
      const created = fixture.workerRevisionService.saveAgent(
        {
          name: "Worker A",
          role: "engineer",
          adapterType: "claude-local",
          adapterConfig: { model: "sonnet" },
        },
        "tester"
      );
      fixture.workerRevisionService.saveAgent(
        {
          id: created.id,
          name: "Worker Alpha",
          role: "engineer",
          adapterType: "claude-local",
          adapterConfig: { model: "opus" },
          capabilities: ["api"],
        },
        "tester"
      );

      const revisions = fixture.workerRevisionService.listAgentRevisions(created.id, 10);
      expect(revisions.length).toBeGreaterThanOrEqual(2);
      expect(revisions.some((revision) => revision.changedKeys.some((key) => key.includes("name")))).toBe(true);
      expect(revisions.some((revision) => revision.changedKeys.some((key) => key.includes("adapterConfig.model")))).toBe(true);

      fixture.db.close();
    });

    it("rolls back to selected revision snapshot", async () => {
      const fixture = await createFixture();
      const created = fixture.workerRevisionService.saveAgent(
        {
          name: "Rollback Worker",
          role: "engineer",
          adapterType: "claude-local",
          adapterConfig: { model: "sonnet" },
        },
        "tester"
      );

      fixture.workerRevisionService.saveAgent(
        {
          id: created.id,
          name: "Rollback Worker v2",
          role: "engineer",
          adapterType: "codex-local",
          adapterConfig: { model: "gpt-5.3-codex" },
        },
        "tester"
      );
      const revisions = fixture.workerRevisionService.listAgentRevisions(created.id, 10);
      const revisionToRollback = revisions.find((entry) => entry.before.name === "Rollback Worker");
      expect(revisionToRollback).toBeTruthy();

      const restored = fixture.workerRevisionService.rollbackAgentRevision(
        created.id,
        revisionToRollback!.id,
        "tester"
      );
      expect(restored.name).toBe("Rollback Worker");
      expect(restored.adapterType).toBe("claude-local");

      fixture.db.close();
    });

    it("blocks rollback when revision has redactions", async () => {
      const fixture = await createFixture();
      const created = fixture.workerRevisionService.saveAgent(
        {
          name: "Redacted Worker",
          role: "researcher",
          adapterType: "openclaw-webhook",
          adapterConfig: {
            url: "https://example.com",
            headers: { Authorization: "${env:OPENCLAW_WEBHOOK_TOKEN}" },
          },
        },
        "tester"
      );

      const redactedRevisionId = "rev-redacted";
      fixture.db.run(
        `
          insert into worker_agent_revisions(
            id, project_id, agent_id, before_json, after_json, changed_keys_json, had_redactions, actor, created_at
          ) values(?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          redactedRevisionId,
          fixture.projectId,
          created.id,
          JSON.stringify({ ...created, name: "__REDACTED__" }),
          JSON.stringify(created),
          JSON.stringify(["adapterConfig.headers.Authorization"]),
          1,
          "tester",
          new Date().toISOString(),
        ]
      );

      expect(() =>
        fixture.workerRevisionService.rollbackAgentRevision(created.id, redactedRevisionId, "tester")
      ).toThrow(/redacted/i);

      fixture.db.close();
    });
  });

});

describe("workerTaskSessionService (file group)", () => {

  function createLogger() {
    return {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    } as any;
  }

  async function createFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-worker-task-sessions-"));
    const adeDir = path.join(root, ".ade");
    fs.mkdirSync(adeDir, { recursive: true });
    const dbPath = path.join(adeDir, "ade.db");
    const db = await openKvDb(dbPath, createLogger());
    const projectId = "project-test";
    const service = createWorkerTaskSessionService({
      db,
      projectId,
    });
    return { db, projectId, service };
  }

  describe("workerTaskSessionService", () => {
    it("derives deterministic task keys", async () => {
      const fixture = await createFixture();
      const keyA = fixture.service.deriveTaskKey({
        agentId: "a1",
        laneId: "lane-x",
        missionId: "mission-1",
        summary: "fix checkout bug",
      });
      const keyB = fixture.service.deriveTaskKey({
        agentId: "a1",
        laneId: "lane-x",
        missionId: "mission-1",
        summary: "fix checkout bug",
      });
      expect(keyA).toBe(keyB);
      expect(keyA.startsWith("task:")).toBe(true);

      const scopedKey = fixture.service.deriveTaskKey({
        agentId: "a1",
        laneId: "lane-x",
        workflowRunId: "linear-run-1",
        linearIssueId: "issue-1",
        summary: "fix checkout bug",
      });
      expect(scopedKey).not.toBe(keyA);
      fixture.db.close();
    });

    it("persists and merges task session continuity by (agentId, adapterType, taskKey)", async () => {
      const fixture = await createFixture();
      const taskKey = fixture.service.deriveTaskKey({
        agentId: "worker-1",
        chatSessionId: "chat-123",
        summary: "investigate flaky test",
      });
      const created = fixture.service.ensureTaskSession({
        agentId: "worker-1",
        adapterType: "codex-local",
        taskKey,
        payload: {
          continuity: {
            handle: {
              surface: "codex_app_server",
              sessionId: "chat-123",
              threadId: "thread-1",
            },
          },
        },
      });
      expect(created.taskKey).toBe(taskKey);

      const resumed = fixture.service.getTaskSession("worker-1", "codex-local", taskKey);
      expect(resumed?.payload).toEqual({
        continuity: {
          handle: {
            surface: "codex_app_server",
            sessionId: "chat-123",
            threadId: "thread-1",
          },
        },
      });

      fixture.service.ensureTaskSession({
        agentId: "worker-1",
        adapterType: "codex-local",
        taskKey,
        payload: {
          continuity: {
            handle: {
              surface: "codex_app_server",
              threadId: "thread-2",
            },
            scope: {
              runId: "linear-run-2",
            },
          },
          wake: {
            lastRunId: "wake-2",
          },
        },
      });
      const updated = fixture.service.getTaskSession("worker-1", "codex-local", taskKey);
      expect(updated?.payload).toEqual({
        continuity: {
          handle: {
            surface: "codex_app_server",
            sessionId: "chat-123",
            threadId: "thread-2",
          },
          scope: {
            runId: "linear-run-2",
          },
        },
        wake: {
          lastRunId: "wake-2",
        },
      });

      fixture.db.close();
    });

    it("clears task sessions with targeted and bulk behavior", async () => {
      const fixture = await createFixture();
      const keyOne = fixture.service.deriveTaskKey({ agentId: "worker-1", summary: "one" });
      const keyTwo = fixture.service.deriveTaskKey({ agentId: "worker-1", summary: "two" });
      fixture.service.ensureTaskSession({
        agentId: "worker-1",
        adapterType: "process",
        taskKey: keyOne,
        payload: { run: 1 },
      });
      fixture.service.ensureTaskSession({
        agentId: "worker-1",
        adapterType: "process",
        taskKey: keyTwo,
        payload: { run: 2 },
      });

      const clearedOne = fixture.service.clearAgentTaskSession({
        agentId: "worker-1",
        adapterType: "process",
        taskKey: keyOne,
      });
      expect(clearedOne).toBe(1);
      expect(fixture.service.getTaskSession("worker-1", "process", keyOne)?.payload).toEqual({});

      const clearedAll = fixture.service.clearAgentTaskSession({
        agentId: "worker-1",
        adapterType: "process",
      });
      expect(clearedAll).toBeGreaterThanOrEqual(1);
      expect(fixture.service.getTaskSession("worker-1", "process", keyTwo)?.payload).toEqual({});

      fixture.db.close();
    });
  });

});

describe("openclawBridgeService (file group)", () => {

  function writeOpenclawConfig(adeDir: string, patch: Record<string, unknown>): void {
    fs.mkdirSync(adeDir, { recursive: true });
    fs.writeFileSync(
      path.join(adeDir, "local.secret.yaml"),
      YAML.stringify({
        openclaw: {
          bridgePort: 0,
          hooksToken: "test-hook-token",
          ...patch,
        },
      }),
      "utf8",
    );
  }

  describe("openclawBridgeService", () => {
    const services: Array<ReturnType<typeof createOpenclawBridgeService>> = [];

    afterEach(async () => {
      while (services.length) {
        const service = services.pop();
        await service?.stop();
      }
    });

    it("handles synchronous query replies end to end", async () => {
      const adeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-openclaw-query-"));
      writeOpenclawConfig(adeDir, { enabled: false });

      let service!: ReturnType<typeof createOpenclawBridgeService>;
      const sentMessages: Array<{ sessionId: string; text: string; displayText?: string }> = [];
      const agentChatService = {
        listSessions: vi.fn(async () => []),
        ensureIdentitySession: vi.fn(async () => ({ id: "session-cto", laneId: "lane-1" })),
        sendMessage: vi.fn(async ({ sessionId, text, displayText }: { sessionId: string; text: string; displayText?: string }) => {
          sentMessages.push({ sessionId, text, displayText });
          const turnId = "turn-1";
          queueMicrotask(() => {
            service.onAgentChatEvent({
              sessionId,
              timestamp: new Date().toISOString(),
              event: { type: "user_message", text: displayText ?? text, turnId },
            });
            service.onAgentChatEvent({
              sessionId,
              timestamp: new Date().toISOString(),
              event: { type: "text", text: "CTO reply from ADE", turnId },
            });
            service.onAgentChatEvent({
              sessionId,
              timestamp: new Date().toISOString(),
              event: { type: "done", turnId, status: "completed" },
            });
          });
        }),
      } as any;

      service = createOpenclawBridgeService({
        projectRoot: "/tmp/project",
        adeDir,
        laneService: {
          ensurePrimaryLane: vi.fn(async () => {}),
          list: vi.fn(async () => [
            { id: "lane-2", laneType: "feature" },
            { id: "lane-1", laneType: "primary" },
          ]),
        } as any,
        agentChatService,
        ctoStateService: {
          getIdentity: vi.fn(() => ({
            openclawContextPolicy: { shareMode: "filtered", blockedCategories: ["secret"] },
          })),
        } as any,
      });
      services.push(service);
      await service.start();

      const state = service.getState();
      const res = await fetch(state.endpoints.queryUrl!, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-hook-token",
        },
        body: JSON.stringify({
          requestId: "req-query-1",
          agentId: "discord-cto",
          sessionKey: "discord:thread:123",
          message: "What changed?",
          context: { channel: "discord", secret: "redact-me" },
        }),
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.reply).toBe("CTO reply from ADE");
      expect(agentChatService.ensureIdentitySession).toHaveBeenCalledWith(
        expect.objectContaining({ identityKey: "cto", laneId: "lane-1" }),
      );
      expect(sentMessages[0]?.text).toContain("Treat this routing context as turn-scoped bridge metadata only.");
      expect(sentMessages[0]?.text).toContain("What changed?");
    });

    it("routes worker targets by slug and falls back unknown targets to CTO", async () => {
      const adeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-openclaw-target-"));
      writeOpenclawConfig(adeDir, { enabled: false, allowEmployeeTargets: true });

      let service!: ReturnType<typeof createOpenclawBridgeService>;
      const ensureIdentitySession = vi.fn(async ({ identityKey }: { identityKey: string }) => ({
        id: identityKey === "cto" ? "session-cto" : "session-worker",
        laneId: "lane-1",
      }));
      const sendMessage = vi.fn(async ({ sessionId, text, displayText }: { sessionId: string; text: string; displayText?: string }) => {
        const turnId = sessionId === "session-worker" ? "turn-worker" : "turn-cto";
        queueMicrotask(() => {
          service.onAgentChatEvent({
            sessionId,
            timestamp: new Date().toISOString(),
            event: { type: "user_message", text: displayText ?? text, turnId },
          });
          service.onAgentChatEvent({
            sessionId,
            timestamp: new Date().toISOString(),
            event: { type: "text", text: sessionId === "session-worker" ? "worker reply" : "cto fallback reply", turnId },
          });
          service.onAgentChatEvent({
            sessionId,
            timestamp: new Date().toISOString(),
            event: { type: "done", turnId, status: "completed" },
          });
        });
      });

      service = createOpenclawBridgeService({
        projectRoot: "/tmp/project",
        adeDir,
        laneService: {
          ensurePrimaryLane: vi.fn(async () => {}),
          list: vi.fn(async () => [{ id: "lane-1", laneType: "primary" }]),
        } as any,
        agentChatService: {
          listSessions: vi.fn(async () => []),
          ensureIdentitySession,
          sendMessage,
        } as any,
        workerAgentService: {
          listAgents: vi.fn(() => [
            { id: "worker-1", slug: "frontend", status: "active", deletedAt: null },
          ]),
        } as any,
        ctoStateService: {
          getIdentity: vi.fn(() => ({
            openclawContextPolicy: { shareMode: "filtered", blockedCategories: [] },
          })),
        } as any,
      });
      services.push(service);
      await service.start();

      const state = service.getState();
      const good = await fetch(state.endpoints.queryUrl!, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-hook-token",
        },
        body: JSON.stringify({
          requestId: "req-good-target",
          message: "Ping frontend worker",
          targetHint: "agent:frontend",
        }),
      });
      expect(good.status).toBe(200);
      await expect(good.json()).resolves.toEqual(expect.objectContaining({
        accepted: true,
        async: true,
        status: "working",
        routeTarget: "agent:frontend",
      }));
      expect(ensureIdentitySession).toHaveBeenCalledWith(expect.objectContaining({ identityKey: "agent:worker-1" }));

      const fallback = await fetch(state.endpoints.queryUrl!, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-hook-token",
        },
        body: JSON.stringify({
          requestId: "req-bad-target",
          message: "Ping unknown worker",
          targetHint: "agent:ghost",
        }),
      });
      expect(fallback.status).toBe(200);
      const latestInbound = service.listMessages(4).find((entry) => entry.requestId === "req-bad-target" && entry.direction === "inbound");
      expect(latestInbound?.resolvedTarget).toBe("cto");
      expect(latestInbound?.metadata).toEqual(expect.objectContaining({
        fallbackReason: expect.stringContaining("ghost"),
      }));
    });

    it("deduplicates async hook requests by idempotency key", async () => {
      const adeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-openclaw-hook-"));
      writeOpenclawConfig(adeDir, { enabled: false });

      let service!: ReturnType<typeof createOpenclawBridgeService>;
      const sendMessage = vi.fn(async ({ sessionId, text, displayText }: { sessionId: string; text: string; displayText?: string }) => {
        queueMicrotask(() => {
          service.onAgentChatEvent({
            sessionId,
            timestamp: new Date().toISOString(),
            event: { type: "user_message", text: displayText ?? text, turnId: "turn-hook" },
          });
        });
      });

      service = createOpenclawBridgeService({
        projectRoot: "/tmp/project",
        adeDir,
        laneService: {
          ensurePrimaryLane: vi.fn(async () => {}),
          list: vi.fn(async () => [{ id: "lane-1", laneType: "primary" }]),
        } as any,
        agentChatService: {
          listSessions: vi.fn(async () => []),
          ensureIdentitySession: vi.fn(async () => ({ id: "session-cto", laneId: "lane-1" })),
          sendMessage,
        } as any,
        ctoStateService: {
          getIdentity: vi.fn(() => ({
            openclawContextPolicy: { shareMode: "filtered", blockedCategories: [] },
          })),
        } as any,
      });
      services.push(service);
      await service.start();

      const state = service.getState();
      const request = {
        requestId: "dup-key-1",
        message: "Fire and forget",
      };
      const first = await fetch(state.endpoints.hookUrl!, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-hook-token",
        },
        body: JSON.stringify(request),
      });
      const second = await fetch(state.endpoints.hookUrl!, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-hook-token",
        },
        body: JSON.stringify(request),
      });

      expect(first.status).toBe(202);
      expect(second.status).toBe(202);
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(await second.json()).toEqual(expect.objectContaining({ duplicate: true }));
    });

    it("queues outbound messages when the operator socket is unavailable", async () => {
      const adeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-openclaw-outbox-"));
      writeOpenclawConfig(adeDir, { enabled: false });

      const service = createOpenclawBridgeService({
        projectRoot: "/tmp/project",
        adeDir,
        laneService: {
          ensurePrimaryLane: vi.fn(async () => {}),
          list: vi.fn(async () => [{ id: "lane-1", laneType: "primary" }]),
        } as any,
        agentChatService: {
          listSessions: vi.fn(async () => []),
          ensureIdentitySession: vi.fn(async () => ({ id: "session-cto", laneId: "lane-1" })),
          sendMessage: vi.fn(async () => {}),
        } as any,
        ctoStateService: {
          getIdentity: vi.fn(() => ({
            openclawContextPolicy: { shareMode: "filtered", blockedCategories: ["secret"] },
          })),
        } as any,
      });
      services.push(service);
      await service.start();

      const record = await service.sendMessage({
        requestId: "queued-message-1",
        agentId: "discord-cto",
        message: "Mission finished",
        context: { secret: "hide-me", lane: "lane-1" },
      });

      expect(record.status).toBe("queued");
      expect(service.getState().status.queuedMessages).toBe(1);
      expect(record.context).toEqual({ lane: "lane-1" });
    });

    it("recursively redacts inbound bridge context before prompting and persistence", async () => {
      const adeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-openclaw-redact-"));
      writeOpenclawConfig(adeDir, { enabled: false });

      let service!: ReturnType<typeof createOpenclawBridgeService>;
      const sentMessages: Array<{ text: string }> = [];
      service = createOpenclawBridgeService({
        projectRoot: "/tmp/project",
        adeDir,
        laneService: {
          ensurePrimaryLane: vi.fn(async () => {}),
          list: vi.fn(async () => [{ id: "lane-1", laneType: "primary" }]),
        } as any,
        agentChatService: {
          listSessions: vi.fn(async () => []),
          ensureIdentitySession: vi.fn(async () => ({ id: "session-cto", laneId: "lane-1" })),
          sendMessage: vi.fn(async ({ sessionId, text, displayText }: { sessionId: string; text: string; displayText?: string }) => {
            sentMessages.push({ text });
            queueMicrotask(() => {
              service.onAgentChatEvent({
                sessionId,
                timestamp: new Date().toISOString(),
                event: { type: "user_message", text: displayText ?? text, turnId: "turn-1" },
              });
              service.onAgentChatEvent({
                sessionId,
                timestamp: new Date().toISOString(),
                event: { type: "text", text: "redacted", turnId: "turn-1" },
              });
              service.onAgentChatEvent({
                sessionId,
                timestamp: new Date().toISOString(),
                event: { type: "done", turnId: "turn-1", status: "completed" },
              });
            });
          }),
        } as any,
        ctoStateService: {
          getIdentity: vi.fn(() => ({
            openclawContextPolicy: { shareMode: "filtered", blockedCategories: ["secret"] },
          })),
        } as any,
      });
      services.push(service);
      await service.start();

      const res = await fetch(service.getState().endpoints.queryUrl!, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-hook-token",
        },
        body: JSON.stringify({
          requestId: "req-redact-1",
          message: "Review this",
          context: {
            nested: {
              apiKey: "test-api-key-placeholder",
              note: "safe",
            },
            secret: "remove-me",
          },
        }),
      });

      expect(res.status).toBe(200);
      expect(sentMessages[0]?.text).toContain("\"apiKey\": \"[REDACTED]\"");
      expect(sentMessages[0]?.text).toContain("\"note\": \"safe\"");
      expect(sentMessages[0]?.text).not.toContain("remove-me");
      const inbound = service.listMessages(10).find((entry) => entry.requestId === "req-redact-1" && entry.direction === "inbound");
      expect(inbound?.context).toEqual({
        nested: {
          apiKey: "[REDACTED]",
          note: "safe",
        },
      });
    });

    it("keeps shareMode full while still redacting sensitive values", async () => {
      const adeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-openclaw-full-share-"));
      writeOpenclawConfig(adeDir, { enabled: false });

      const service = createOpenclawBridgeService({
        projectRoot: "/tmp/project",
        adeDir,
        laneService: {
          ensurePrimaryLane: vi.fn(async () => {}),
          list: vi.fn(async () => [{ id: "lane-1", laneType: "primary" }]),
        } as any,
        agentChatService: {
          listSessions: vi.fn(async () => []),
          ensureIdentitySession: vi.fn(async () => ({ id: "session-cto", laneId: "lane-1" })),
          sendMessage: vi.fn(async () => {}),
        } as any,
        ctoStateService: {
          getIdentity: vi.fn(() => ({
            openclawContextPolicy: { shareMode: "full", blockedCategories: ["secret"] },
          })),
        } as any,
      });
      services.push(service);
      await service.start();

      const record = await service.sendMessage({
        requestId: "queued-message-2",
        agentId: "discord-cto",
        message: "Mission finished",
        context: {
          secret: "Bearer very-secret-token-value",
          lane: "lane-1",
        },
      });

      expect(record.context).toEqual({
        secret: "[REDACTED]",
        lane: "lane-1",
      });
    });

    it("migrates legacy runtime files into cache and removes repo-visible copies", async () => {
      const adeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-openclaw-migrate-"));
      writeOpenclawConfig(adeDir, { enabled: false });
      fs.mkdirSync(path.join(adeDir, "cto"), { recursive: true });
      fs.writeFileSync(
        path.join(adeDir, "cto", "openclaw-history.json"),
        JSON.stringify([{
          id: "legacy-1",
          requestId: "legacy-request",
          direction: "inbound",
          mode: "hook",
          status: "received",
          body: "Legacy body",
          summary: "Legacy summary",
          context: {
            apiKey: "test-api-key-placeholder",
          },
          createdAt: new Date().toISOString(),
        }], null, 2),
        "utf8",
      );

      const service = createOpenclawBridgeService({
        projectRoot: "/tmp/project",
        adeDir,
        laneService: {
          ensurePrimaryLane: vi.fn(async () => {}),
          list: vi.fn(async () => [{ id: "lane-1", laneType: "primary" }]),
        } as any,
        agentChatService: {
          listSessions: vi.fn(async () => []),
          ensureIdentitySession: vi.fn(async () => ({ id: "session-cto", laneId: "lane-1" })),
          sendMessage: vi.fn(async () => {}),
        } as any,
        ctoStateService: {
          getIdentity: vi.fn(() => ({
            openclawContextPolicy: { shareMode: "filtered", blockedCategories: [] },
          })),
        } as any,
      });
      services.push(service);
      await service.start();

      expect(fs.existsSync(path.join(adeDir, "cto", "openclaw-history.json"))).toBe(false);
      expect(fs.existsSync(path.join(adeDir, "cache", "openclaw", "openclaw-history.json"))).toBe(true);
      expect(service.listMessages(10)[0]?.context).toEqual({ apiKey: "[REDACTED]" });
    });
  });

});
