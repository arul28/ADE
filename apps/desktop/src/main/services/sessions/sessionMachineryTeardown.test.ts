import { describe, expect, it, vi } from "vitest";
import { stopSettledSessionMachinery } from "./sessionMachineryTeardown";
import { settleTerminalSession } from "./settleTerminalSession";

type Row = { id: string; toolType: string };

function deps(rows: Row[], overrides: Record<string, unknown> = {}) {
  const stopBackgroundWork = vi.fn(async () => ({ stopped: 2, skippedActiveTurn: false }));
  const setScheduledWorkPaused = vi.fn(async ({ sessionId }: { sessionId: string }) => ({
    sessionId,
    paused: true,
    nextWakeAt: null,
  }));
  const listScheduledWork = vi.fn(async () => [{ id: "sched-1", status: "scheduled" }]);
  return {
    sessionService: {
      get: (id: string) => rows.find((row) => row.id === id) ?? null,
    } as never,
    agentChatService: {
      stopBackgroundWork,
      setScheduledWorkPaused,
      listScheduledWork,
      ...overrides,
    } as never,
    logger: { warn: vi.fn() },
    stopBackgroundWork,
    setScheduledWorkPaused,
    listScheduledWork,
  };
}

describe("stopSettledSessionMachinery", () => {
  it("stops background work and pauses scheduled work for a chat session", async () => {
    // Settle used to be a pure column write: the row went quiet while its
    // monitors kept polling and its background shells kept holding ports.
    const d = deps([{ id: "chat-1", toolType: "claude-chat" }]);
    const result = await stopSettledSessionMachinery(d, ["chat-1"]);

    expect(d.stopBackgroundWork).toHaveBeenCalledWith({ sessionId: "chat-1" });
    expect(d.setScheduledWorkPaused).toHaveBeenCalledWith({ sessionId: "chat-1", paused: true });
    expect(result).toMatchObject({
      sessionIds: ["chat-1"],
      stoppedBackgroundWork: 2,
      pausedScheduledWork: 1,
      skippedActiveTurns: 0,
    });
  });

  it("pauses rather than cancels, so an unsettle can bring the schedules back", async () => {
    const d = deps([{ id: "chat-1", toolType: "claude-chat" }], {
      cancelScheduledWork: vi.fn(),
    });
    await stopSettledSessionMachinery(d, ["chat-1"]);
    expect(d.setScheduledWorkPaused).toHaveBeenCalledTimes(1);
    expect((d.agentChatService as unknown as { cancelScheduledWork: ReturnType<typeof vi.fn> })
      .cancelScheduledWork).not.toHaveBeenCalled();
  });

  it("leaves terminal sessions alone — a terminal pane is user-owned", async () => {
    // The whole carve-out of settle teardown: an agent's background shell is
    // thread background work, but the pane the user opened to watch a build is
    // theirs and must survive the settle with its scrollback.
    const d = deps([
      { id: "term-1", toolType: "shell" },
      { id: "cli-1", toolType: "claude" },
    ]);
    const result = await stopSettledSessionMachinery(d, ["term-1", "cli-1"]);

    expect(result.sessionIds).toEqual([]);
    expect(d.stopBackgroundWork).not.toHaveBeenCalled();
    expect(d.setScheduledWorkPaused).not.toHaveBeenCalled();
  });

  it("reports a session skipped because its foreground turn is still streaming", async () => {
    const d = deps([{ id: "chat-1", toolType: "claude-chat" }], {
      stopBackgroundWork: vi.fn(async () => ({ stopped: 0, skippedActiveTurn: true })),
    });
    const result = await stopSettledSessionMachinery(d, ["chat-1"]);
    expect(result.skippedActiveTurns).toBe(1);
    expect(result.stoppedBackgroundWork).toBe(0);
  });

  it("never lets a provider failure block the settle", async () => {
    const d = deps([{ id: "chat-1", toolType: "claude-chat" }], {
      stopBackgroundWork: vi.fn(async () => {
        throw new Error("provider unreachable");
      }),
    });
    await expect(stopSettledSessionMachinery(d, ["chat-1"])).resolves.toMatchObject({
      sessionIds: ["chat-1"],
      stoppedBackgroundWork: 0,
    });
    expect(d.logger.warn).toHaveBeenCalled();
  });

  it("skips unknown ids and de-duplicates repeats", async () => {
    const d = deps([{ id: "chat-1", toolType: "claude-chat" }]);
    const result = await stopSettledSessionMachinery(d, ["chat-1", "chat-1", " ", "missing"]);
    expect(result.sessionIds).toEqual(["chat-1"]);
    expect(d.stopBackgroundWork).toHaveBeenCalledTimes(1);
  });

  it("does nothing at all without a chat service, rather than throwing", async () => {
    const result = await stopSettledSessionMachinery(
      {
        sessionService: { get: () => ({ id: "chat-1", toolType: "claude-chat" }) } as never,
        agentChatService: null,
      },
      ["chat-1"],
    );
    expect(result.sessionIds).toEqual(["chat-1"]);
    expect(result.stoppedBackgroundWork).toBe(0);
  });
});

describe("settleTerminalSession", () => {
  it("tears the machinery down before writing the settled column", async () => {
    // Ordering matters: a settle must never report success while the monitors
    // it claims to have concluded are still armed.
    const order: string[] = [];
    const d = deps([{ id: "chat-1", toolType: "claude-chat" }], {
      stopBackgroundWork: vi.fn(async () => {
        order.push("stop");
        return { stopped: 1, skippedActiveTurn: false };
      }),
    });
    const sessionService = {
      get: (id: string) => (id === "chat-1" ? { id, toolType: "claude-chat" } : null),
      settleSession: vi.fn(() => {
        order.push("settle");
        return true;
      }),
    };

    await expect(settleTerminalSession({
      sessionId: "chat-1",
      opts: { source: "user" },
      sessionService: sessionService as never,
      agentChatService: d.agentChatService,
      logger: d.logger,
    })).resolves.toBe(true);

    expect(order).toEqual(["stop", "settle"]);
    expect(sessionService.settleSession).toHaveBeenCalledWith("chat-1", { source: "user" });
  });
});
