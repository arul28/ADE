import { describe, expect, it, vi } from "vitest";
import { routeMessageToCoordinatorCtx } from "./workerDeliveryService";

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
