import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi, afterEach } from "vitest";
import { openKvDb, type AdeDb } from "../state/kvDb";
import { createWorkerAgentService } from "./workerAgentService";
import { createWorkerHeartbeatService } from "./workerHeartbeatService";
import { createWorkerTaskSessionService } from "./workerTaskSessionService";
import type { AgentIdentity, WorkerAgentRunStatus, WorkerAgentWakeupReason } from "../../../shared/types";

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
    statusCode: 200,
    outputText: "HEARTBEAT_OK",
    usage: null,
  }));
  const recordCostEvent = vi.fn();
  const heartbeat = createWorkerHeartbeatService({
    db,
    projectId,
    workerAgentService,
    workerTaskSessionService,
    workerAdapterRuntimeService: { run: runtimeRun } as any,
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

  const dispose = () => {
    heartbeat.dispose();
    db.close();
  };

  return {
    root,
    adeDir,
    db,
    projectId,
    workerAgentService,
    heartbeat,
    runtimeRun,
    recordCostEvent,
    createWorker,
    dispose,
  };
}

afterEach(() => {
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

    const runs = fixture.heartbeat.listRuns({ agentId: worker.id, limit: 5 });
    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0]?.wakeupReason).toBe("timer");
    fixture.dispose();
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
    fixture.dispose();
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
    fixture.dispose();
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
    fixture.dispose();
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
    fixture.dispose();
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
    fixture.dispose();
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
    fixture.dispose();
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
    fixture.dispose();
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
    fixture.dispose();
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
    fixture.dispose();
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

    fixture.dispose();
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
    fixture.dispose();
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
    fixture.dispose();
  });
});
