import { describe, expect, it, vi } from "vitest";
import type { TerminalSessionSummary } from "../../../shared/types";
import { deleteTerminalSessionWithRuntimeCleanup } from "./deleteTerminalSession";
import { stopSettledSessionMachinery } from "./sessionMachineryTeardown";
import { settleTerminalSession } from "./settleTerminalSession";
import type { createPtyService } from "../pty/ptyService";
import type { createSessionService } from "./sessionService";

/**
 * End-of-life teardown for a session, in one place: what settle stops, what
 * delete removes, and — the distinction the whole thing turns on — what each
 * deliberately leaves alone.
 *
 * These three modules (`settleTerminalSession`, `sessionMachineryTeardown`,
 * `deleteTerminalSession`) are one contract split across files for dependency
 * reasons, not behavioral ones, so they are tested together.
 */

type Row = { id: string; toolType: string };

function deps(rows: Row[], overrides: Record<string, unknown> = {}) {
  const stopBackgroundWork = vi.fn(async () => ({ stopped: 2, skippedActiveTurn: false }));
  return {
    sessionService: {
      get: (id: string) => rows.find((row) => row.id === id) ?? null,
    } as never,
    agentChatService: {
      stopBackgroundWork,
      ...overrides,
    } as never,
    logger: { warn: vi.fn() },
    stopBackgroundWork,
  };
}

describe("stopSettledSessionMachinery", () => {
  it("stops background work and pauses scheduled work for a chat session", async () => {
    // Settle used to be a pure column write: the row went quiet while its
    // monitors kept polling and its background shells kept holding ports.
    const d = deps([{ id: "chat-1", toolType: "claude-chat" }]);
    const result = await stopSettledSessionMachinery(d, ["chat-1"]);

    expect(d.stopBackgroundWork).toHaveBeenCalledWith({ sessionId: "chat-1" });
    expect(result).toMatchObject({
      sessionIds: ["chat-1"],
      stoppedBackgroundWork: 2,
      skippedActiveTurns: 0,
    });
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

function makeSession(overrides: Partial<TerminalSessionSummary> = {}): TerminalSessionSummary {
  return {
    id: "session-1",
    laneId: "lane-1",
    laneName: "Primary",
    ptyId: null,
    tracked: true,
    pinned: false,
    goal: null,
    toolType: "shell",
    title: "Shell",
    status: "completed",
    startedAt: "2026-08-01T00:00:00.000Z",
    endedAt: "2026-08-01T00:01:00.000Z",
    exitCode: 0,
    transcriptPath: "/tmp/transcript",
    headShaStart: null,
    headShaEnd: null,
    lastOutputPreview: null,
    summary: null,
    runtimeState: "exited",
    resumeCommand: null,
    ...overrides,
  };
}

function makeServices(session: TerminalSessionSummary | null) {
  const deleteSession = vi.fn().mockReturnValue(true);
  const sessionService = {
    get: vi.fn().mockReturnValue(session),
    deleteSession,
  } as unknown as ReturnType<typeof createSessionService>;
  const ptyService = {
    enrichSessions: vi.fn((sessions: TerminalSessionSummary[]) => sessions),
    isSessionOwnedByLivePeerRuntime: vi.fn().mockReturnValue(false),
    dispose: vi.fn(),
  } as unknown as ReturnType<typeof createPtyService>;
  return { deleteSession, ptyService, sessionService };
}

describe("deleteTerminalSessionWithRuntimeCleanup", () => {
  it("deletes a session this runtime owns", () => {
    const { deleteSession, ptyService, sessionService } = makeServices(makeSession());

    expect(deleteTerminalSessionWithRuntimeCleanup({
      sessionId: "session-1",
      sessionService,
      ptyService,
    })).toBe(true);
    expect(deleteSession).toHaveBeenCalledWith("session-1");
  });

  it("treats a session this runtime does not have as already deleted", () => {
    // Delete is idempotent: the goal state is "not here", and it already holds.
    // Throwing surfaced a red "Delete failed" banner over a list that was
    // correct — the renderer routinely asks a runtime to delete a row that
    // never persisted there, or that another window already removed.
    const { deleteSession, ptyService, sessionService } = makeServices(null);

    expect(deleteTerminalSessionWithRuntimeCleanup({
      sessionId: "missing-session",
      sessionService,
      ptyService,
    })).toBe(false);
    expect(deleteSession).not.toHaveBeenCalled();
  });

  it("still rejects an empty session id", () => {
    const { ptyService, sessionService } = makeServices(makeSession());

    expect(() => deleteTerminalSessionWithRuntimeCleanup({
      sessionId: "   ",
      sessionService,
      ptyService,
    })).toThrow("Session id is required.");
  });

  it("still refuses a chat session", () => {
    const { ptyService, sessionService } = makeServices(makeSession({ toolType: "codex-chat" }));

    expect(() => deleteTerminalSessionWithRuntimeCleanup({
      sessionId: "session-1",
      sessionService,
      ptyService,
    })).toThrow("Use the chat delete flow instead.");
  });
});
