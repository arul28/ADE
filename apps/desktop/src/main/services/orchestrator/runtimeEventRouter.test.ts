import { describe, expect, it, vi } from "vitest";
import {
  buildRunStateSnapshot,
  onAgentChatEvent,
  onSessionRuntimeSignal,
  routeEventToCoordinator,
} from "./runtimeEventRouter";

describe("runtimeEventRouter", () => {
  it("buildRunStateSnapshot falls back to default parallelism cap when metadata is NaN", () => {
    const ctx = {
      orchestratorService: {
        getRunGraph: vi.fn(() => ({
          run: {
            metadata: {
              autopilot: {
                parallelismCap: "not-a-number",
              },
            },
          },
          steps: [],
          attempts: [],
          claims: [],
        })),
      },
    } as any;

    const snapshot = buildRunStateSnapshot(ctx, "run-1");

    expect(snapshot.parallelismCap).toBe(4);
    expect(snapshot.activeAgentCount).toBe(0);
  });

  it("deduplicates repetitive routed events within a short window", () => {
    vi.useFakeTimers();
    try {
      const coordinator = {
        injectEvent: vi.fn(),
      } as any;
      const event = {
        type: "orchestrator-step-updated",
        runId: "run-1",
        stepId: "step-1",
        attemptId: "attempt-1",
        at: "2026-03-03T00:00:00.000Z",
        reason: "validation_self_check_reminder",
      } as any;

      routeEventToCoordinator(coordinator, event);
      routeEventToCoordinator(coordinator, event);
      expect(coordinator.injectEvent).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(800);
      routeEventToCoordinator(coordinator, event);
      expect(coordinator.injectEvent).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not deduplicate critical runtime reasons inside the dedupe window", () => {
    vi.useFakeTimers();
    try {
      const coordinator = {
        injectEvent: vi.fn(),
      } as any;
      const criticalEvent = {
        type: "orchestrator-step-updated",
        runId: "run-1",
        stepId: "step-1",
        attemptId: "attempt-1",
        at: "2026-03-03T00:00:00.000Z",
        reason: "completed",
      } as any;

      routeEventToCoordinator(coordinator, criticalEvent);
      routeEventToCoordinator(coordinator, criticalEvent);

      expect(coordinator.injectEvent).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores idle runtime churn so the coordinator stays quiet while workers are just running", () => {
    const coordinator = {
      injectEvent: vi.fn(),
    } as any;

    routeEventToCoordinator(coordinator, {
      type: "orchestrator-attempt-updated",
      runId: "run-1",
      stepId: "step-1",
      attemptId: "attempt-1",
      at: "2026-03-03T00:00:00.000Z",
      reason: "started",
    } as any);
    routeEventToCoordinator(coordinator, {
      type: "orchestrator-attempt-updated",
      runId: "run-1",
      stepId: "step-1",
      attemptId: "attempt-1",
      at: "2026-03-03T00:00:00.100Z",
      reason: "session_attached",
    } as any);
    routeEventToCoordinator(coordinator, {
      type: "orchestrator-claim-updated",
      runId: "run-1",
      claimId: "claim-1",
      at: "2026-03-03T00:00:00.200Z",
      reason: "heartbeat",
    } as any);

    expect(coordinator.injectEvent).not.toHaveBeenCalled();
  });

  it("ignores coordinator-owned DAG churn and only wakes for actionable runtime events", () => {
    const coordinator = {
      injectEvent: vi.fn(),
    } as any;

    routeEventToCoordinator(coordinator, {
      type: "orchestrator-step-updated",
      runId: "run-1",
      stepId: "step-1",
      at: "2026-03-03T00:00:00.000Z",
      reason: "steps_added",
    } as any);
    routeEventToCoordinator(coordinator, {
      type: "orchestrator-step-updated",
      runId: "run-1",
      stepId: "step-1",
      at: "2026-03-03T00:00:00.050Z",
      reason: "dependencies_updated",
    } as any);
    routeEventToCoordinator(coordinator, {
      type: "orchestrator-run-updated",
      runId: "run-1",
      at: "2026-03-03T00:00:00.100Z",
      reason: "status_updated",
    } as any);
    routeEventToCoordinator(coordinator, {
      type: "orchestrator-step-updated",
      runId: "run-1",
      stepId: "step-1",
      attemptId: "attempt-1",
      at: "2026-03-03T00:00:00.200Z",
      reason: "attempt_completed",
    } as any);

    expect(coordinator.injectEvent).toHaveBeenCalledTimes(1);
    const message = coordinator.injectEvent.mock.calls[0]?.[1] as string;
    expect(message).toContain("attempt_completed");
  });

  it("clips oversized routed messages and emits suppression summaries after rate limiting", () => {
    vi.useFakeTimers();
    try {
      const coordinator = {
        injectEvent: vi.fn(),
      } as any;

      const largeEvent = {
        type: "orchestrator-run-updated",
        runId: "run-1",
        stepId: "step-1",
        attemptId: "attempt-1",
        at: "2026-03-03T00:00:00.000Z",
        reason: "validation_contract_unfulfilled",
      } as any;
      routeEventToCoordinator(coordinator, largeEvent, {
        graph: {
          run: { id: "run-1", status: "active", metadata: {} },
          steps: [
            {
              id: "step-1",
              stepKey: "step-1",
              status: "failed",
            },
          ],
          attempts: [
            {
              id: "attempt-1",
              stepId: "step-1",
              status: "failed",
              resultEnvelope: {
                summary: "x".repeat(10_000),
              },
            },
          ],
          claims: [],
        } as any,
      });
      const firstMessage = coordinator.injectEvent.mock.calls[0]?.[1] as string;
      expect(firstMessage.length).toBeLessThanOrEqual(6_000);
      expect(firstMessage).toContain("[router-truncated]");

      for (let index = 0; index < 30; index += 1) {
        routeEventToCoordinator(coordinator, {
          type: "orchestrator-step-updated",
          runId: "run-1",
          stepId: `step-${index}`,
          at: "2026-03-03T00:00:00.000Z",
          reason: "validation_self_check_reminder",
        } as any);
      }
      expect(coordinator.injectEvent).toHaveBeenCalledTimes(24);

      vi.advanceTimersByTime(1_001);
      routeEventToCoordinator(coordinator, {
        type: "orchestrator-step-updated",
        runId: "run-1",
        stepId: "step-next",
        at: "2026-03-03T00:00:01.100Z",
        reason: "validation_self_check_reminder",
      } as any);

      expect(coordinator.injectEvent).toHaveBeenCalledTimes(25);
      const resumedMessage = coordinator.injectEvent.mock.calls[24]?.[1] as string;
      expect(resumedMessage).toContain("Suppressed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("routes critical runtime reasons even after non-critical events hit the rate limit", () => {
    vi.useFakeTimers();
    try {
      const coordinator = {
        injectEvent: vi.fn(),
      } as any;

      for (let index = 0; index < 24; index += 1) {
        routeEventToCoordinator(coordinator, {
          type: "orchestrator-step-updated",
          runId: "run-1",
          stepId: `step-${index}`,
          at: "2026-03-03T00:00:00.000Z",
          reason: "validation_self_check_reminder",
        } as any);
      }
      expect(coordinator.injectEvent).toHaveBeenCalledTimes(24);

      routeEventToCoordinator(coordinator, {
        type: "orchestrator-step-updated",
        runId: "run-1",
        stepId: "step-over-limit",
        at: "2026-03-03T00:00:00.100Z",
        reason: "validation_self_check_reminder",
      } as any);
      expect(coordinator.injectEvent).toHaveBeenCalledTimes(24);

      routeEventToCoordinator(coordinator, {
        type: "orchestrator-step-updated",
        runId: "run-1",
        stepId: "step-critical",
        attemptId: "attempt-critical",
        at: "2026-03-03T00:00:00.101Z",
        reason: "failed",
      } as any);

      expect(coordinator.injectEvent).toHaveBeenCalledTimes(25);
      const criticalMessage = coordinator.injectEvent.mock.calls[24]?.[1] as string;
      expect(criticalMessage).toContain("Suppressed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("adds a development transition hint when a planning-labeled step completes", () => {
    const coordinator = {
      injectEvent: vi.fn(),
    } as any;

    routeEventToCoordinator(
      coordinator,
      {
        type: "orchestrator-step-updated",
        runId: "run-1",
        stepId: "step-1",
        attemptId: "attempt-1",
        at: "2026-03-03T00:00:00.000Z",
        reason: "attempt_completed",
      } as any,
      {
        graph: {
          run: {
            status: "active",
            metadata: {
              phaseRuntime: {
                currentPhaseKey: "planning",
                currentPhaseName: "Planning",
              },
            },
          },
          steps: [
            {
              id: "step-1",
              stepKey: "worker_plan",
              status: "succeeded",
              metadata: {
                phaseKey: "planning",
                phaseName: "Planning",
              },
            },
          ],
          attempts: [
            {
              id: "attempt-1",
              stepId: "step-1",
              status: "succeeded",
              resultEnvelope: {
                summary: "Research complete.",
              },
            },
          ],
          claims: [],
        } as any,
      },
    );

    const message = coordinator.injectEvent.mock.calls[0]?.[1] as string;
    expect(message).toContain("set_current_phase");
    expect(message).toContain("development");
  });

  it("adds a complete_mission hint when all tracked steps are terminal", () => {
    const coordinator = {
      injectEvent: vi.fn(),
    } as any;

    routeEventToCoordinator(
      coordinator,
      {
        type: "orchestrator-step-updated",
        runId: "run-1",
        stepId: "step-1",
        attemptId: "attempt-1",
        at: "2026-03-03T00:00:00.000Z",
        reason: "attempt_completed",
      } as any,
      {
        graph: {
          run: {
            status: "active",
            metadata: {
              phaseRuntime: {
                currentPhaseKey: "development",
                currentPhaseName: "Development",
              },
            },
          },
          steps: [
            {
              id: "step-1",
              stepKey: "worker_impl",
              status: "succeeded",
              metadata: {
                phaseKey: "development",
                phaseName: "Development",
              },
            },
          ],
          attempts: [
            {
              id: "attempt-1",
              stepId: "step-1",
              status: "succeeded",
              resultEnvelope: {
                summary: "Implementation complete.",
              },
            },
          ],
          claims: [],
        } as any,
      },
    );

    const message = coordinator.injectEvent.mock.calls[0]?.[1] as string;
    expect(message).toContain("complete_mission");
    expect(message).toContain("all tracked steps are terminal");
  });

  it("replays queued worker messages when agent chat reports a terminal failure state", async () => {
    const replayQueuedWorkerMessages = vi.fn().mockResolvedValue(undefined);
    const ctx = {
      disposed: { current: false },
      logger: { debug: vi.fn() },
      sessionSignalQueues: new Map(),
    } as any;

    onAgentChatEvent(
      ctx,
      {
        sessionId: "session-1",
        event: {
          type: "status",
          turnStatus: "failed",
        },
      } as any,
      { replayQueuedWorkerMessages },
    );

    const queued = ctx.sessionSignalQueues.get("session-1");
    await queued;

    expect(replayQueuedWorkerMessages).toHaveBeenCalledWith(expect.objectContaining({
      reason: "agent_chat_event:status",
      sessionId: "session-1",
    }));
    expect(ctx.sessionSignalQueues.size).toBe(0);
  });

  it("cleans up session queue entries after runtime signal processing settles", async () => {
    const processSessionRuntimeSignal = vi.fn().mockResolvedValue(undefined);
    const replayQueuedWorkerMessages = vi.fn().mockResolvedValue(undefined);
    const ctx = {
      disposed: { current: false },
      logger: { debug: vi.fn() },
      sessionRuntimeSignals: new Map(),
      sessionSignalQueues: new Map(),
    } as any;

    onSessionRuntimeSignal(
      ctx,
      {
        sessionId: "session-2",
        runtimeState: "running",
      } as any,
      { processSessionRuntimeSignal, replayQueuedWorkerMessages },
    );

    const queued = ctx.sessionSignalQueues.get("session-2");
    await queued;

    expect(processSessionRuntimeSignal).toHaveBeenCalledTimes(1);
    expect(replayQueuedWorkerMessages).toHaveBeenCalledWith(expect.objectContaining({
      reason: "runtime_signal",
      sessionId: "session-2",
    }));
    expect(ctx.sessionSignalQueues.size).toBe(0);
    expect(ctx.sessionRuntimeSignals.get("session-2")?.runtimeState).toBe("running");
  });

  it("replays queued worker messages when agent chat reports an error event", async () => {
    const replayQueuedWorkerMessages = vi.fn().mockResolvedValue(undefined);
    const ctx = {
      disposed: { current: false },
      logger: { debug: vi.fn() },
      sessionSignalQueues: new Map(),
    } as any;

    onAgentChatEvent(
      ctx,
      {
        sessionId: "session-err",
        event: {
          type: "error",
          message: "worker crashed",
        },
      } as any,
      { replayQueuedWorkerMessages },
    );

    const queued = ctx.sessionSignalQueues.get("session-err");
    await queued;

    expect(replayQueuedWorkerMessages).toHaveBeenCalledWith(expect.objectContaining({
      reason: "agent_chat_event:error",
      sessionId: "session-err",
    }));
    expect(ctx.sessionSignalQueues.size).toBe(0);
  });
});
