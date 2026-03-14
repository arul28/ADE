import { describe, expect, it, vi } from "vitest";
import { createCompactionFlushService } from "./compactionFlushService";

describe("compactionFlushService", () => {
  it("uses sensible default config", () => {
    const service = createCompactionFlushService();

    expect(service.getConfig()).toMatchObject({
      enabled: true,
      reserveTokensFloor: 40_000,
      maxFlushTurnsPerSession: 3,
    });
    expect(service.getConfig().flushPrompt).toContain("compaction");
  });

  it("injects a hidden system message and runs a flush turn when the threshold is exceeded", async () => {
    const service = createCompactionFlushService();
    const appendHiddenMessage = vi.fn();
    const flushTurn = vi.fn(async () => ({ status: "flushed" as const }));

    const result = await service.beforeCompaction({
      sessionId: "session-1",
      boundaryId: "boundary-1",
      conversationTokenCount: 70_001,
      maxTokens: 100_000,
      appendHiddenMessage,
      flushTurn,
    });

    expect(result).toMatchObject({
      injected: true,
      flushCount: 1,
      reason: "flushed",
    });
    expect(appendHiddenMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "system",
        hidden: true,
        content: expect.stringContaining("compaction"),
      }),
    );
    expect(flushTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        boundaryId: "boundary-1",
        prompt: expect.stringContaining("compaction"),
      }),
    );
  });

  it("does nothing when disabled", async () => {
    const service = createCompactionFlushService({ enabled: false });
    const appendHiddenMessage = vi.fn();
    const flushTurn = vi.fn();

    const result = await service.beforeCompaction({
      sessionId: "session-1",
      boundaryId: "boundary-1",
      conversationTokenCount: 99_000,
      maxTokens: 100_000,
      appendHiddenMessage,
      flushTurn,
    });

    expect(result).toMatchObject({
      injected: false,
      flushCount: 0,
      reason: "disabled",
    });
    expect(appendHiddenMessage).not.toHaveBeenCalled();
    expect(flushTurn).not.toHaveBeenCalled();
  });

  it("does nothing below the reserve threshold", async () => {
    const service = createCompactionFlushService({ reserveTokensFloor: 20_000 });
    const appendHiddenMessage = vi.fn();
    const flushTurn = vi.fn();

    const result = await service.beforeCompaction({
      sessionId: "session-1",
      boundaryId: "boundary-1",
      conversationTokenCount: 79_999,
      maxTokens: 100_000,
      appendHiddenMessage,
      flushTurn,
    });

    expect(result).toMatchObject({
      injected: false,
      flushCount: 0,
      reason: "below-threshold",
    });
    expect(appendHiddenMessage).not.toHaveBeenCalled();
    expect(flushTurn).not.toHaveBeenCalled();
  });

  it("prevents a second flush for the same compaction boundary", async () => {
    const service = createCompactionFlushService();
    const flushTurn = vi.fn(async () => ({ status: "flushed" as const }));

    const first = await service.beforeCompaction({
      sessionId: "session-1",
      boundaryId: "boundary-1",
      conversationTokenCount: 75_000,
      maxTokens: 100_000,
      flushTurn,
    });
    const second = await service.beforeCompaction({
      sessionId: "session-1",
      boundaryId: "boundary-1",
      conversationTokenCount: 80_000,
      maxTokens: 100_000,
      flushTurn,
    });

    expect(first.reason).toBe("flushed");
    expect(second).toMatchObject({
      injected: false,
      flushCount: 1,
      reason: "already-flushed-boundary",
    });
    expect(flushTurn).toHaveBeenCalledTimes(1);
  });

  it("enforces the max flush turns per session across boundaries", async () => {
    const service = createCompactionFlushService({ maxFlushTurnsPerSession: 2 });
    const flushTurn = vi.fn(async () => ({ status: "flushed" as const }));

    await service.beforeCompaction({
      sessionId: "session-1",
      boundaryId: "boundary-1",
      conversationTokenCount: 75_000,
      maxTokens: 100_000,
      flushTurn,
    });
    await service.beforeCompaction({
      sessionId: "session-1",
      boundaryId: "boundary-2",
      conversationTokenCount: 80_000,
      maxTokens: 100_000,
      flushTurn,
    });
    const third = await service.beforeCompaction({
      sessionId: "session-1",
      boundaryId: "boundary-3",
      conversationTokenCount: 85_000,
      maxTokens: 100_000,
      flushTurn,
    });

    expect(third).toMatchObject({
      injected: false,
      flushCount: 2,
      reason: "max-flush-turns-reached",
    });
    expect(flushTurn).toHaveBeenCalledTimes(2);
  });

  it("uses a custom flush prompt when provided", async () => {
    const service = createCompactionFlushService({
      flushPrompt: "Persist durable findings with memoryAdd before compaction.",
    });
    const appendHiddenMessage = vi.fn();

    await service.beforeCompaction({
      sessionId: "session-1",
      boundaryId: "boundary-1",
      conversationTokenCount: 90_000,
      maxTokens: 100_000,
      appendHiddenMessage,
      flushTurn: async () => ({ status: "flushed" as const }),
    });

    expect(appendHiddenMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Persist durable findings with memoryAdd before compaction.",
      }),
    );
  });

  it("treats flush failures as best-effort and still allows compaction to proceed", async () => {
    const service = createCompactionFlushService();

    await expect(
      service.beforeCompaction({
        sessionId: "session-1",
        boundaryId: "boundary-1",
        conversationTokenCount: 90_000,
        maxTokens: 100_000,
        flushTurn: async () => {
          throw new Error("tool failure");
        },
      }),
    ).resolves.toMatchObject({
      injected: true,
      flushCount: 1,
      reason: "flush-failed",
      proceedWithCompaction: true,
    });
  });

  it("treats over-budget flush attempts as best-effort and still allows compaction to proceed", async () => {
    const service = createCompactionFlushService();

    await expect(
      service.beforeCompaction({
        sessionId: "session-1",
        boundaryId: "boundary-1",
        conversationTokenCount: 90_000,
        maxTokens: 100_000,
        flushTurn: async () => ({ status: "budget_exceeded" as const }),
      }),
    ).resolves.toMatchObject({
      injected: true,
      flushCount: 1,
      reason: "flush-budget-exceeded",
      proceedWithCompaction: true,
    });
  });
});
