import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalSessionSummary } from "../../../shared/types";
import {
  BOARD_MOVE_DONE_TO_WORKING_TEXT,
  BOARD_MOVE_STAGE_MS,
  BOARD_MOVE_TO_NEEDS_YOU_TEXT,
  __resetStagedBoardMovesForTest,
  boardMoveMessageText,
  createSessionBoardMoveActions,
  deriveWorkBoardColumn,
  flushStagedBoardMoves,
  stagedBoardMoveCountForTest,
} from "./sessionBoardMove";

/**
 * A board move is a lifecycle write plus a message, and the whole point of the
 * staging window is that neither can land without the other. These tests hold
 * that invariant from both ends: the undo reverses both, and a message that
 * cannot be delivered reverses the write it already made.
 */

type Row = TerminalSessionSummary;

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: "chat-1",
    laneId: "lane-1",
    title: "Chat",
    status: "running",
    toolType: "claude-chat",
    runtimeState: "idle",
    summary: null,
    startedAt: "2026-09-11T10:00:00.000Z",
    lastActivityAt: "2026-09-11T10:00:00.000Z",
    tracked: true,
    ...overrides,
  } as unknown as Row;
}

function makeSessionService(initial: Row) {
  let current = initial;
  const calls: string[] = [];
  return {
    calls,
    get current() { return current; },
    set current(next: Row) { current = next; },
    service: {
      get: (sessionId: string) => (sessionId === current.id ? current : null),
      unsettleSession: (_id: string) => {
        calls.push("unsettle");
        current = { ...current, settledAt: null };
        return true;
      },
      setSettleOverride: (_id: string, override: "settled" | "active" | null) => {
        calls.push(`override:${override}`);
        current = { ...current, settleOverride: override };
        return true;
      },
      snoozeSession: (_id: string, untilIso: string) => {
        calls.push(`snooze:${untilIso}`);
        current = { ...current, snoozedUntil: untilIso };
        return true;
      },
      wakeSession: (_id: string) => {
        calls.push("wake");
        current = { ...current, snoozedUntil: null };
        return true;
      },
      requestAttention: (_id: string, message: string | null, source?: string) => {
        calls.push(`attention:${source ?? ""}:${message ?? ""}`);
        current = {
          ...current,
          attentionRequestedAt: "2026-09-11T11:00:00.000Z",
          attentionMessage: message,
          attentionSource: (source ?? "agent_explicit") as Row["attentionSource"],
        };
        return true;
      },
      clearAttentionRequest: (_id: string) => {
        calls.push("clearAttention");
        current = {
          ...current,
          attentionRequestedAt: null,
          attentionMessage: null,
          attentionSource: null,
        };
        return true;
      },
      settleSession: async (_id: string) => {
        calls.push("settle");
        current = {
          ...current,
          settledAt: "2026-09-11T12:00:00.000Z",
          attentionRequestedAt: null,
          attentionMessage: null,
          attentionSource: null,
        };
        return true;
      },
    },
  };
}

const silentLogger = { warn: () => {} };

describe("deriveWorkBoardColumn", () => {
  it("reads the same columns the board buckets from", () => {
    expect(deriveWorkBoardColumn(row({ runtimeState: "running" }))).toBe("working");
    expect(deriveWorkBoardColumn(row({ pendingInputItemId: "item-1" }))).toBe("needs_you");
    expect(deriveWorkBoardColumn(row({ attentionRequestedAt: "2026-09-11T10:00:00.000Z" })))
      .toBe("needs_you");
    expect(deriveWorkBoardColumn(row({ settledAt: "2026-09-11T10:00:00.000Z" }))).toBe("done");
  });

  it("files a snoozed row as Waiting, which is why Waiting cannot be a target", () => {
    const snoozed = row({ snoozedUntil: new Date(Date.now() + 60_000).toISOString() });
    expect(deriveWorkBoardColumn(snoozed)).toBe("waiting");
  });
});

describe("boardMoveMessageText", () => {
  it("uses the two fixed texts, and nothing else", () => {
    expect(boardMoveMessageText("done", "working")).toBe(BOARD_MOVE_DONE_TO_WORKING_TEXT);
    expect(boardMoveMessageText("working", "needs_you")).toBe(BOARD_MOVE_TO_NEEDS_YOU_TEXT);
    expect(boardMoveMessageText("done", "needs_you")).toBe(BOARD_MOVE_TO_NEEDS_YOU_TEXT);
    expect(boardMoveMessageText("waiting", "needs_you")).toBe(BOARD_MOVE_TO_NEEDS_YOU_TEXT);
  });

  it("says nothing on a move to Done — that move is a settle, not an instruction", () => {
    expect(boardMoveMessageText("working", "done")).toBeNull();
    expect(boardMoveMessageText("needs_you", "done")).toBeNull();
  });

  it("says nothing when Working is reached from anywhere but Done", () => {
    expect(boardMoveMessageText("needs_you", "working")).toBeNull();
    expect(boardMoveMessageText("waiting", "working")).toBeNull();
  });

  it("pins the exact wording both texts ship with", () => {
    expect(BOARD_MOVE_DONE_TO_WORKING_TEXT).toBe(
      "You moved this chat from Done to Working. Continue the work, or ask me what you need if the next step is unclear.",
    );
    expect(BOARD_MOVE_TO_NEEDS_YOU_TEXT).toBe(
      "The user parked this for their input. Stop, summarize where you are, and list what you need from them.",
    );
  });
});

describe("session.moveOnBoard", () => {
  beforeEach(() => {
    __resetStagedBoardMovesForTest();
    vi.useRealTimers();
  });

  it("refuses Waiting as a target — it is derived, not asserted", async () => {
    const sessions = makeSessionService(row());
    const actions = createSessionBoardMoveActions({
      sessionService: sessions.service,
      logger: silentLogger,
    });
    await expect(actions.moveOnBoard({ sessionId: "chat-1", to: "waiting" }))
      .rejects.toThrow(/Waiting is derived/);
    // And nothing was written.
    expect(sessions.calls).toEqual([]);
  });

  it("refuses an unknown column", async () => {
    const sessions = makeSessionService(row());
    const actions = createSessionBoardMoveActions({
      sessionService: sessions.service,
      logger: silentLogger,
    });
    await expect(actions.moveOnBoard({ sessionId: "chat-1", to: "blocked" }))
      .rejects.toThrow(/must be one of/);
  });

  it("is a no-op when the card is already in that column", async () => {
    const sessions = makeSessionService(row({ settledAt: "2026-09-11T09:00:00.000Z" }));
    const actions = createSessionBoardMoveActions({
      sessionService: sessions.service,
      logger: silentLogger,
    });
    const result = await actions.moveOnBoard({ sessionId: "chat-1", to: "done" });
    expect(result).toMatchObject({ changed: false, moveId: null });
    expect(sessions.calls).toEqual([]);
  });

  it("stamps host-derived provenance on the message it dispatches", async () => {
    vi.useFakeTimers();
    const sessions = makeSessionService(row({ settledAt: "2026-09-11T09:00:00.000Z" }));
    const messageSession = vi.fn(async (_args: unknown) => ({ ok: true }));
    const actions = createSessionBoardMoveActions({
      sessionService: sessions.service,
      agentChatService: { messageSession },
      logger: silentLogger,
    });
    const result = await actions.moveOnBoard({ sessionId: "chat-1", to: "working" }) as {
      moveId: string;
      from: string;
      to: string;
      message: string | null;
    };
    expect(result.from).toBe("done");
    expect(result.to).toBe("working");
    expect(result.message).toBe(BOARD_MOVE_DONE_TO_WORKING_TEXT);
    // Status write lands immediately; the message waits out the undo window.
    expect(sessions.calls).toContain("override:active");
    expect(messageSession).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(BOARD_MOVE_STAGE_MS + 5);
    expect(messageSession).toHaveBeenCalledTimes(1);
    const sent = messageSession.mock.calls[0]![0] as unknown as {
      sessionId: string;
      text: string;
      kind: string;
      metadata: { boardMove: { from: string; to: string; at: string; moveId: string } };
    };
    expect(sent.sessionId).toBe("chat-1");
    expect(sent.kind).toBe("auto");
    expect(sent.text).toBe(BOARD_MOVE_DONE_TO_WORKING_TEXT);
    expect(sent.metadata.boardMove).toMatchObject({
      from: "done",
      to: "working",
      moveId: result.moveId,
    });
    expect(Date.parse(sent.metadata.boardMove.at)).not.toBeNaN();
  });

  it("raises the hand as the USER when the card lands on Needs you", async () => {
    vi.useFakeTimers();
    const sessions = makeSessionService(row({ runtimeState: "running" }));
    const messageSession = vi.fn(async (_args: unknown) => ({ ok: true }));
    const actions = createSessionBoardMoveActions({
      sessionService: sessions.service,
      agentChatService: { messageSession },
      logger: silentLogger,
    });
    await actions.moveOnBoard({ sessionId: "chat-1", to: "needs_you" });
    expect(sessions.calls.some((call) => call.startsWith("attention:user:"))).toBe(true);
    await vi.advanceTimersByTimeAsync(BOARD_MOVE_STAGE_MS + 5);
    expect((messageSession.mock.calls[0]![0] as unknown as { text: string }).text)
      .toBe(BOARD_MOVE_TO_NEEDS_YOU_TEXT);
  });

  it("sends nothing for a move to Done, but still writes the settle", async () => {
    vi.useFakeTimers();
    const sessions = makeSessionService(row({ runtimeState: "running" }));
    const messageSession = vi.fn(async (_args: unknown) => ({ ok: true }));
    const actions = createSessionBoardMoveActions({
      sessionService: sessions.service,
      agentChatService: { messageSession },
      logger: silentLogger,
    });
    const result = await actions.moveOnBoard({ sessionId: "chat-1", to: "done" }) as {
      message: string | null;
    };
    expect(result.message).toBeNull();
    expect(sessions.calls).toContain("settle");
    await vi.advanceTimersByTimeAsync(BOARD_MOVE_STAGE_MS + 5);
    expect(messageSession).not.toHaveBeenCalled();
  });
});

describe("session.undoBoardMove", () => {
  beforeEach(() => {
    __resetStagedBoardMovesForTest();
    vi.useRealTimers();
  });

  it("reverses the status write and cancels the staged message", async () => {
    vi.useFakeTimers();
    const sessions = makeSessionService(row({ settledAt: "2026-09-11T09:00:00.000Z" }));
    const messageSession = vi.fn(async (_args: unknown) => ({ ok: true }));
    const actions = createSessionBoardMoveActions({
      sessionService: sessions.service,
      agentChatService: { messageSession },
      logger: silentLogger,
    });
    const moved = await actions.moveOnBoard({ sessionId: "chat-1", to: "working" }) as {
      moveId: string;
    };
    expect(sessions.current.settledAt).toBeNull();

    const undone = await actions.undoBoardMove({ sessionId: "chat-1", moveId: moved.moveId });
    expect(undone).toMatchObject({ ok: true, reversed: true });
    // The row is back in Done...
    expect(sessions.current.settledAt).not.toBeNull();
    expect(deriveWorkBoardColumn(sessions.current)).toBe("done");

    // ...and the message never goes out, now or later.
    await vi.advanceTimersByTimeAsync(BOARD_MOVE_STAGE_MS * 3);
    expect(messageSession).not.toHaveBeenCalled();
  });

  it("restores the attention hand a move to Working cleared", async () => {
    vi.useFakeTimers();
    const sessions = makeSessionService(row({
      attentionRequestedAt: "2026-09-11T09:00:00.000Z",
      attentionMessage: "Which database?",
      attentionSource: "agent_explicit",
    }));
    const actions = createSessionBoardMoveActions({
      sessionService: sessions.service,
      agentChatService: { messageSession: vi.fn(async (_args: unknown) => ({ ok: true })) },
      logger: silentLogger,
    });
    const moved = await actions.moveOnBoard({ sessionId: "chat-1", to: "working" }) as {
      moveId: string;
    };
    expect(sessions.current.attentionRequestedAt).toBeNull();
    await actions.undoBoardMove({ sessionId: "chat-1", moveId: moved.moveId });
    expect(sessions.current.attentionMessage).toBe("Which database?");
    expect(sessions.current.attentionSource).toBe("agent_explicit");
    expect(deriveWorkBoardColumn(sessions.current)).toBe("needs_you");
  });

  it("refuses once the message has gone out, rather than reversing the write alone", async () => {
    vi.useFakeTimers();
    const sessions = makeSessionService(row({ settledAt: "2026-09-11T09:00:00.000Z" }));
    const messageSession = vi.fn(async (_args: unknown) => ({ ok: true }));
    const actions = createSessionBoardMoveActions({
      sessionService: sessions.service,
      agentChatService: { messageSession },
      logger: silentLogger,
    });
    const moved = await actions.moveOnBoard({ sessionId: "chat-1", to: "working" }) as {
      moveId: string;
    };
    await vi.advanceTimersByTimeAsync(BOARD_MOVE_STAGE_MS + 5);
    expect(messageSession).toHaveBeenCalledTimes(1);

    const undone = await actions.undoBoardMove({ sessionId: "chat-1", moveId: moved.moveId });
    expect(undone).toMatchObject({ ok: false, reason: "already_dispatched" });
    // Still in Working: the agent was told, so the board must keep agreeing.
    expect(deriveWorkBoardColumn(sessions.current)).toBe("working");
  });
});

describe("a board move that cannot deliver its message", () => {
  beforeEach(() => {
    __resetStagedBoardMovesForTest();
    vi.useRealTimers();
  });

  it("reverses the status write, so the board never asserts a move the agent was not told about", async () => {
    vi.useFakeTimers();
    const sessions = makeSessionService(row({ settledAt: "2026-09-11T09:00:00.000Z" }));
    const warn = vi.fn();
    const actions = createSessionBoardMoveActions({
      sessionService: sessions.service,
      agentChatService: {
        messageSession: vi.fn(async (_args: unknown) => {
          throw new Error("chat is blocked on pending input");
        }),
      },
      logger: { warn },
    });
    await actions.moveOnBoard({ sessionId: "chat-1", to: "working" });
    expect(deriveWorkBoardColumn(sessions.current)).toBe("working");

    await vi.advanceTimersByTimeAsync(BOARD_MOVE_STAGE_MS + 5);
    expect(deriveWorkBoardColumn(sessions.current)).toBe("done");
    expect(warn).toHaveBeenCalledWith("session.board_move_reverted", expect.objectContaining({
      reason: "message_failed",
    }));
  });

  it("reverses when there is no chat service to deliver through at all", async () => {
    vi.useFakeTimers();
    const sessions = makeSessionService(row({ settledAt: "2026-09-11T09:00:00.000Z" }));
    const warn = vi.fn();
    const actions = createSessionBoardMoveActions({
      sessionService: sessions.service,
      agentChatService: null,
      logger: { warn },
    });
    await actions.moveOnBoard({ sessionId: "chat-1", to: "working" });
    await vi.advanceTimersByTimeAsync(BOARD_MOVE_STAGE_MS + 5);
    expect(deriveWorkBoardColumn(sessions.current)).toBe("done");
    expect(warn).toHaveBeenCalledWith("session.board_move_reverted", expect.objectContaining({
      reason: "chat_service_unavailable",
    }));
  });
});

describe("the host's Waiting is narrower than the board's", () => {
  /**
   * Not a bug to fix here — a contract to keep visible. `deriveWorkBoardColumn`
   * files Waiting from the snooze alone; the renderer's `buildWorkBoardModel`
   * also parks a running row there when its lane's PR has CI in flight. Teaching
   * this function about PR state would drag the PR service into the action
   * registry, so the disagreement stays and the caller reports the no-op.
   */
  it("derives a running row as Working however its PR looks", () => {
    expect(deriveWorkBoardColumn(row({ runtimeState: "running" }))).toBe("working");
  });

  it("answers changed:false with a `from` the caller can show", async () => {
    const sessions = makeSessionService(row({ runtimeState: "running" }));
    const actions = createSessionBoardMoveActions({
      sessionService: sessions.service,
      logger: silentLogger,
    });
    // The board offered Working because it had the card in Waiting for a
    // pending check. The host already has it in Working.
    const result = await actions.moveOnBoard({ sessionId: "chat-1", to: "working" });
    expect(result).toMatchObject({ changed: false, from: "working", to: "working" });
  });
});

describe("a snoozed card dragged to Done", () => {
  beforeEach(() => {
    __resetStagedBoardMovesForTest();
    vi.useRealTimers();
  });

  it("actually lands in Done — the snooze is lifted, not left standing", async () => {
    const sessions = makeSessionService(row({
      snoozedUntil: new Date(Date.now() + 3_600_000).toISOString(),
    }));
    expect(deriveWorkBoardColumn(sessions.current)).toBe("waiting");

    const actions = createSessionBoardMoveActions({
      sessionService: sessions.service,
      logger: silentLogger,
    });
    const result = await actions.moveOnBoard({ sessionId: "chat-1", to: "done" });
    expect(result).toMatchObject({ from: "waiting", to: "done", changed: true });
    // `isSessionFiledAsSnoozed` keeps filing a snoozed row as Waiting even once
    // it is settled, so a Done branch that skipped the wake would report a move
    // that never happened.
    expect(sessions.calls).toContain("wake");
    expect(deriveWorkBoardColumn(sessions.current)).toBe("done");
  });
});

describe("two moves on one session", () => {
  beforeEach(() => {
    __resetStagedBoardMovesForTest();
    vi.useRealTimers();
  });

  it("dispatches the first the moment the second is staged, and only the second can be undone", async () => {
    vi.useFakeTimers();
    const sessions = makeSessionService(row({ settledAt: "2026-09-11T09:00:00.000Z" }));
    const messageSession = vi.fn(async (_args: unknown) => ({ ok: true }));
    const actions = createSessionBoardMoveActions({
      sessionService: sessions.service,
      agentChatService: { messageSession },
      logger: silentLogger,
    });

    const first = await actions.moveOnBoard({ sessionId: "chat-1", to: "working" }) as {
      moveId: string;
    };
    expect(messageSession).not.toHaveBeenCalled();

    const second = await actions.moveOnBoard({ sessionId: "chat-1", to: "needs_you" }) as {
      moveId: string;
    };
    // The first move's status write already landed, so its message must not be
    // lost behind the second — it goes out immediately instead.
    expect(messageSession).toHaveBeenCalledTimes(1);
    expect((messageSession.mock.calls[0]![0] as unknown as { text: string }).text)
      .toBe(BOARD_MOVE_DONE_TO_WORKING_TEXT);
    expect(stagedBoardMoveCountForTest()).toBe(1);

    // And its undo is dead: restoring its snapshot would wipe the second move's
    // write while the second is still staged.
    expect(await actions.undoBoardMove({ sessionId: "chat-1", moveId: first.moveId }))
      .toMatchObject({ ok: false, reason: "already_dispatched" });
    expect(deriveWorkBoardColumn(sessions.current)).toBe("needs_you");

    // The second undo restores the state the second move found, not the first.
    await actions.undoBoardMove({ sessionId: "chat-1", moveId: second.moveId });
    expect(sessions.current.settledAt).toBeNull();
    expect(sessions.current.settleOverride).toBe("active");
    await vi.advanceTimersByTimeAsync(BOARD_MOVE_STAGE_MS * 2);
    expect(messageSession).toHaveBeenCalledTimes(1);
  });
});

describe("a move that outlives its process", () => {
  beforeEach(() => {
    __resetStagedBoardMovesForTest();
    vi.useRealTimers();
  });

  it("drains on shutdown rather than losing the message the write promised", async () => {
    vi.useFakeTimers();
    const sessions = makeSessionService(row({ settledAt: "2026-09-11T09:00:00.000Z" }));
    const messageSession = vi.fn(async (_args: unknown) => ({ ok: true }));
    const actions = createSessionBoardMoveActions({
      sessionService: sessions.service,
      agentChatService: { messageSession },
      logger: silentLogger,
    });
    await actions.moveOnBoard({ sessionId: "chat-1", to: "working" });

    await flushStagedBoardMoves();
    expect(messageSession).toHaveBeenCalledTimes(1);
    expect(stagedBoardMoveCountForTest()).toBe(0);
    // The timer is cleared with it, so the drain cannot double-send.
    await vi.advanceTimersByTimeAsync(BOARD_MOVE_STAGE_MS * 2);
    expect(messageSession).toHaveBeenCalledTimes(1);
  });

  it("says `unknown_move`, not `already_dispatched`, for a move it never staged", async () => {
    const sessions = makeSessionService(row());
    const actions = createSessionBoardMoveActions({
      sessionService: sessions.service,
      logger: silentLogger,
    });
    // A hard kill inside the undo window leaves exactly this: the columns are
    // written, the message was never sent, and claiming it was is a lie the
    // caller repeats to the user.
    expect(await actions.undoBoardMove({ sessionId: "chat-1", moveId: "move-from-a-dead-process" }))
      .toEqual({
        ok: false,
        sessionId: "chat-1",
        moveId: "move-from-a-dead-process",
        reason: "unknown_move",
      });
  });
});
