import { beforeAll, describe, expect, it, vi } from "vitest";
import path from "node:path";
import { createRequire } from "node:module";
import initSqlJs from "sql.js";
import type { Database, SqlJsStatic } from "sql.js";
import { getChatMessageById, sendThreadMessageCtx, upsertThread } from "./chatMessageService";
import {
  resolveWorkerDeliverySessionCtx,
  routeMessageToCoordinatorCtx,
  upsertWorkerDeliveryInterventionCtx,
} from "./workerDeliveryService";

type SqlValue = string | number | null | Uint8Array;

type AdeDb = {
  run: (sql: string, params?: SqlValue[]) => void;
  get: <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: SqlValue[]) => T | null;
  all: <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: SqlValue[]) => T[];
};

function mapExecRows(rows: { columns: string[]; values: unknown[][] }[]): Record<string, unknown>[] {
  const first = rows[0];
  if (!first) return [];
  const out: Record<string, unknown>[] = [];
  for (const row of first.values) {
    const mapped: Record<string, unknown> = {};
    for (let index = 0; index < first.columns.length; index += 1) {
      mapped[first.columns[index] ?? String(index)] = row[index];
    }
    out.push(mapped);
  }
  return out;
}

let SQL: SqlJsStatic;

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
  const wasmDir = path.dirname(wasmPath);
  SQL = await initSqlJs({
    locateFile: (file) => path.join(wasmDir, file),
  });
});

function createInMemoryAdeDb(): { db: AdeDb; raw: Database } {
  const raw = new SQL.Database();
  raw.run(`
    create table missions(
      id text primary key,
      project_id text not null,
      lane_id text,
      metadata_json text,
      updated_at text
    );
    create table orchestrator_chat_threads(
      id text primary key,
      project_id text not null,
      mission_id text not null,
      thread_type text not null,
      title text not null,
      run_id text,
      step_id text,
      step_key text,
      attempt_id text,
      session_id text,
      lane_id text,
      status text not null,
      unread_count integer not null default 0,
      metadata_json text,
      created_at text not null,
      updated_at text not null
    );
    create table orchestrator_chat_messages(
      id text primary key,
      project_id text not null,
      mission_id text not null,
      thread_id text,
      role text not null,
      content text not null,
      timestamp text not null,
      step_key text,
      target_json text,
      visibility text,
      delivery_state text,
      source_session_id text,
      attempt_id text,
      lane_id text,
      run_id text,
      metadata_json text,
      created_at text not null
    );
  `);

  const run = (sql: string, params: SqlValue[] = []) => raw.run(sql, params);
  const all = <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: SqlValue[] = []): T[] =>
    mapExecRows(raw.exec(sql, params)) as T[];
  const get = <T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: SqlValue[] = []): T | null =>
    all<T>(sql, params)[0] ?? null;

  return { raw, db: { run, all, get } };
}

describe("workerDeliveryService routeMessageToCoordinatorCtx", () => {
  it("answers worker status questions locally without waking the coordinator", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-06T17:00:30.000Z"));
    try {
      const appended: Array<{ content: string }> = [];
      const ctx = {
        disposed: { current: false },
        logger: { debug: vi.fn() },
        aiIntegrationService: {},
        projectRoot: "/tmp/project",
        chatMessages: new Map(),
        sessionRuntimeSignals: new Map([
          [
            "session-1",
            {
              laneId: "lane-1",
              sessionId: "session-1",
              runtimeState: "running",
              lastOutputPreview: "Reviewing App.tsx and wiring the new tab.",
              at: "2026-03-06T17:00:25.000Z",
            },
          ],
        ]),
        orchestratorService: {
          listRuns: vi.fn(() => [
            {
              id: "run-1",
              status: "active",
              createdAt: "2026-03-06T17:00:00.000Z",
            },
          ]),
          getRunGraph: vi.fn(() => ({
            run: {
              id: "run-1",
              status: "active",
              metadata: {},
            },
            steps: [
              {
                id: "step-1",
                stepKey: "implement-test-tab",
                title: "Implement test tab",
                status: "running",
              },
            ],
            attempts: [
              {
                id: "attempt-1",
                stepId: "step-1",
                status: "running",
                createdAt: "2026-03-06T17:00:10.000Z",
                startedAt: "2026-03-06T17:00:10.000Z",
                executorSessionId: "session-1",
                resultEnvelope: null,
              },
            ],
            claims: [],
          })),
        },
      } as any;
      const deps = {
        appendChatMessage: vi.fn((message) => {
          appended.push(message);
          return message;
        }),
        steerMission: vi.fn(),
        enqueueChatResponse: vi.fn(),
        runHealthSweep: vi.fn().mockResolvedValue({ sweeps: 1, staleRecovered: 0 }),
      };

      routeMessageToCoordinatorCtx(
        ctx,
        {
          missionId: "mission-1",
          content: "What is implement-test-tab doing?",
          threadId: "thread-1",
          target: { kind: "coordinator", runId: "run-1" },
        } as any,
        deps as any,
      );

      await vi.advanceTimersByTimeAsync(0);

      expect(deps.runHealthSweep).toHaveBeenCalledWith("chat_status");
      expect(deps.steerMission).not.toHaveBeenCalled();
      expect(deps.enqueueChatResponse).not.toHaveBeenCalled();
      expect(appended).toHaveLength(1);
      expect(appended[0]?.content).toContain("Implement test tab");
      expect(appended[0]?.content).toContain("Runtime state: running.");
      expect(appended[0]?.content).toContain("Latest signal: Reviewing App.tsx and wiring the new tab.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats imperative worker guidance as a directive instead of a passive status query", () => {
    const ctx = {
      disposed: { current: false },
      logger: { debug: vi.fn() },
      aiIntegrationService: {},
      projectRoot: "/tmp/project",
      chatMessages: new Map(),
      sessionRuntimeSignals: new Map(),
      orchestratorService: {
        listRuns: vi.fn(() => []),
        getRunGraph: vi.fn(),
      },
    } as any;
    const deps = {
      appendChatMessage: vi.fn((message) => message),
      steerMission: vi.fn(),
      enqueueChatResponse: vi.fn(),
      runHealthSweep: vi.fn(),
    };

    routeMessageToCoordinatorCtx(
      ctx,
      {
        missionId: "mission-1",
        content: "Tell the worker to retry with a smaller diff and report back.",
        threadId: "thread-1",
        target: { kind: "coordinator", runId: "run-1" },
      } as any,
      deps as any,
    );

    expect(deps.runHealthSweep).not.toHaveBeenCalled();
    expect(deps.steerMission).toHaveBeenCalledTimes(1);
    expect(deps.enqueueChatResponse).toHaveBeenCalledTimes(1);
  });
});

describe("workerDeliveryService resolveWorkerDeliverySessionCtx", () => {
  it("prefers the session already bound to the worker thread before lane fallback", async () => {
    const ctx = {
      agentChatService: {
        listSessions: vi.fn().mockResolvedValue([
          {
            sessionId: "session-thread-a",
            laneId: "lane-1",
            provider: "codex",
            status: "active",
            threadId: "thread-a",
          },
          {
            sessionId: "session-thread-b",
            laneId: "lane-1",
            provider: "codex",
            status: "active",
            threadId: "thread-b",
          },
        ]),
      },
    } as any;

    const resolution = await resolveWorkerDeliverySessionCtx(ctx, {
      message: {
        missionId: "mission-1",
        laneId: "lane-1",
        threadId: "thread-a",
        sourceSessionId: null,
        target: { kind: "worker", sessionId: null },
      } as any,
      context: {
        missionId: "mission-1",
        threadId: "thread-a",
        laneId: "lane-1",
        sessionId: null,
        target: { kind: "worker", sessionId: null },
      } as any,
      deliveryMeta: {
        agentSessionId: null,
      } as any,
    });

    expect(resolution.sessionId).toBe("session-thread-a");
    expect(resolution.error).toBeNull();
  });

  it("blocks lane fallback when thread-bound sessions exist for other worker threads", async () => {
    const ctx = {
      agentChatService: {
        listSessions: vi.fn().mockResolvedValue([
          {
            sessionId: "session-thread-b",
            laneId: "lane-1",
            provider: "codex",
            status: "active",
            threadId: "thread-b",
          },
        ]),
      },
    } as any;

    const resolution = await resolveWorkerDeliverySessionCtx(ctx, {
      message: {
        missionId: "mission-1",
        laneId: "lane-1",
        threadId: "thread-a",
        sourceSessionId: null,
        target: { kind: "worker", sessionId: null },
      } as any,
      context: {
        missionId: "mission-1",
        threadId: "thread-a",
        laneId: "lane-1",
        sessionId: null,
        target: { kind: "worker", sessionId: null },
      } as any,
      deliveryMeta: {
        agentSessionId: null,
      } as any,
    });

    expect(resolution.sessionId).toBeNull();
    expect(resolution.error).toContain("Lane fallback is blocked");
  });
});

describe("workerDeliveryService upsertWorkerDeliveryInterventionCtx", () => {
  it("does not open a manual-input intervention for a worker that has already finished", () => {
    const addIntervention = vi.fn();
    const ctx = {
      workerDeliveryInterventionCooldowns: new Map(),
      missionService: {
        get: vi.fn(() => ({
          id: "mission-1",
          status: "in_progress",
          interventions: [],
        })),
        update: vi.fn(),
        addIntervention,
      },
      orchestratorService: {
        getRunGraph: vi.fn(() => ({
          run: { id: "run-1", missionId: "mission-1" },
          steps: [
            {
              id: "step-1",
              status: "succeeded",
            },
          ],
          attempts: [],
          claims: [],
          contextSnapshots: [],
          handoffs: [],
          timeline: [],
          runtimeEvents: [],
        })),
      },
      logger: {
        info: vi.fn(),
        debug: vi.fn(),
      },
    } as any;
    const deps = {
      appendChatMessage: vi.fn(),
      recordRuntimeEvent: vi.fn(),
    };

    const result = upsertWorkerDeliveryInterventionCtx(
      ctx,
      {
        message: {
          id: "message-1",
          missionId: "mission-1",
          laneId: "lane-1",
        } as any,
        context: {
          runId: "run-1",
          stepId: "step-1",
          stepKey: "planner-step",
          laneId: "lane-1",
        } as any,
        retries: 4,
        error: "No worker agent-chat session is currently mapped to this thread.",
      },
      deps as any,
    );

    expect(result).toBeNull();
    expect(addIntervention).not.toHaveBeenCalled();
  });
});

describe("chatMessageService sendThreadMessageCtx", () => {
  function createRoutingTestHarness() {
    const { db } = createInMemoryAdeDb();
    db.run(
      `insert into missions(id, project_id, lane_id, metadata_json, updated_at) values (?, ?, ?, ?, ?)`,
      ["mission-1", "project-1", "lane-1", "{}", "2026-03-08T12:00:00.000Z"],
    );
    const ctx = {
      disposed: { current: false },
      db,
      logger: { debug: vi.fn() },
      chatMessages: new Map(),
      missionService: {},
    } as any;
    const deps = {
      routeMessageToWorker: vi.fn(),
      routeMessageToCoordinator: vi.fn(),
      replayQueuedWorkerMessages: vi.fn().mockResolvedValue({ delivered: 0, failed: 0, queued: 0 }),
      sendWorkerMessageToSession: vi.fn().mockResolvedValue("delivered"),
      createContextCheckpoint: vi.fn(),
      listWorkerDigests: vi.fn().mockReturnValue([]),
    };
    return { ctx, deps };
  }

  it("routes a threadId-only reply on a worker thread back to that worker with preserved metadata", () => {
    const { ctx, deps } = createRoutingTestHarness();

    const workerThread = upsertThread(ctx, {
      missionId: "mission-1",
      threadId: "worker-thread-1",
      threadType: "worker",
      title: "Implement tab",
      target: {
        kind: "worker",
        runId: "run-1",
        stepId: "step-1",
        stepKey: "implement-tab",
        attemptId: "attempt-1",
        sessionId: "session-1",
        laneId: "lane-1",
      },
    });

    const sent = sendThreadMessageCtx(
      ctx,
      {
        missionId: "mission-1",
        threadId: workerThread.id,
        content: "Please retry with a narrower diff and preserve the passing tests.",
        metadata: {
          workerDelivery: {
            sourceMessageId: "source-1",
            retries: 2,
          },
          customFlag: true,
        },
      },
      deps as any,
    );

    expect(deps.routeMessageToWorker).toHaveBeenCalledTimes(1);
    expect(deps.routeMessageToCoordinator).not.toHaveBeenCalled();
    expect(sent.target).toEqual({
      kind: "worker",
      runId: "run-1",
      stepId: "step-1",
      stepKey: "implement-tab",
      attemptId: "attempt-1",
      sessionId: "session-1",
      laneId: "lane-1",
    });
    expect(sent.stepKey).toBe("implement-tab");
    expect(sent.attemptId).toBe("attempt-1");
    expect(sent.sourceSessionId).toBe("session-1");
    expect(sent.laneId).toBe("lane-1");
    expect(sent.runId).toBe("run-1");
    expect(sent.deliveryState).toBe("queued");
    expect(sent.metadata).toMatchObject({
      workerDelivery: {
        sourceMessageId: "source-1",
        retries: 2,
      },
      customFlag: true,
    });

    const persisted = getChatMessageById(ctx, sent.id);
    expect(persisted?.target).toEqual(sent.target);
    expect(persisted?.stepKey).toBe("implement-tab");
    expect(persisted?.attemptId).toBe("attempt-1");
    expect(persisted?.sourceSessionId).toBe("session-1");
    expect(persisted?.laneId).toBe("lane-1");
    expect(persisted?.runId).toBe("run-1");
    expect(persisted?.metadata).toMatchObject({
      workerDelivery: {
        sourceMessageId: "source-1",
        retries: 2,
      },
      customFlag: true,
    });
  });

  it("backfills missing worker target fields from thread identity when an explicit partial target is provided", () => {
    const { ctx, deps } = createRoutingTestHarness();

    const workerThread = upsertThread(ctx, {
      missionId: "mission-1",
      threadId: "worker-thread-2",
      threadType: "worker",
      title: "Review results",
      target: {
        kind: "worker",
        runId: "run-2",
        stepId: "step-2",
        stepKey: "review-results",
        attemptId: "attempt-2",
        sessionId: "session-2",
        laneId: "lane-2",
      },
    });

    const sent = sendThreadMessageCtx(
      ctx,
      {
        missionId: "mission-1",
        threadId: workerThread.id,
        content: "Use the current session but keep the same target step.",
        target: {
          kind: "worker",
          runId: "run-2",
          sessionId: "session-override",
        },
      },
      deps as any,
    );

    expect(deps.routeMessageToWorker).toHaveBeenCalledTimes(1);
    expect(sent.target).toEqual({
      kind: "worker",
      runId: "run-2",
      stepId: "step-2",
      stepKey: "review-results",
      attemptId: "attempt-2",
      sessionId: "session-override",
      laneId: "lane-2",
    });
    expect(sent.stepKey).toBe("review-results");
    expect(sent.attemptId).toBe("attempt-2");
    expect(sent.laneId).toBe("lane-2");
  });
});
