import { describe, expect, it, vi } from "vitest";
import { buildRunStateSnapshot, routeEventToCoordinator } from "./runtimeEventRouter";

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
        reason: "status_changed",
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

  it("clips oversized routed messages and emits suppression summaries after rate limiting", () => {
    vi.useFakeTimers();
    try {
      const coordinator = {
        injectEvent: vi.fn(),
      } as any;

      const largeEvent = {
        type: "orchestrator-run-updated",
        runId: "run-1",
        at: "2026-03-03T00:00:00.000Z",
        reason: "x".repeat(10_000),
      } as any;
      routeEventToCoordinator(coordinator, largeEvent);
      const firstMessage = coordinator.injectEvent.mock.calls[0]?.[1] as string;
      expect(firstMessage.length).toBeLessThanOrEqual(6_000);
      expect(firstMessage).toContain("[router-truncated]");

      for (let index = 0; index < 30; index += 1) {
        routeEventToCoordinator(coordinator, {
          type: "orchestrator-step-updated",
          runId: "run-1",
          stepId: `step-${index}`,
          at: "2026-03-03T00:00:00.000Z",
          reason: `tick_${index}`,
        } as any);
      }
      expect(coordinator.injectEvent).toHaveBeenCalledTimes(24);

      vi.advanceTimersByTime(1_001);
      routeEventToCoordinator(coordinator, {
        type: "orchestrator-step-updated",
        runId: "run-1",
        stepId: "step-next",
        at: "2026-03-03T00:00:01.100Z",
        reason: "tick_next",
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
          reason: `tick_${index}`,
        } as any);
      }
      expect(coordinator.injectEvent).toHaveBeenCalledTimes(24);

      routeEventToCoordinator(coordinator, {
        type: "orchestrator-step-updated",
        runId: "run-1",
        stepId: "step-over-limit",
        at: "2026-03-03T00:00:00.100Z",
        reason: "tick_over_limit",
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
});
