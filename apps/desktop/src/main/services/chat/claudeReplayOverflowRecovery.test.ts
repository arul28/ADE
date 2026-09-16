import { describe, expect, it, vi } from "vitest";

import {
  createClaudeReplayOverflowRecovery,
  normalizeTranscriptReplayOrigin,
  type ReplayForkProvenance,
  type TranscriptReplayOrigin,
} from "./claudeReplayOverflowRecovery";
import type { TranscriptReplayFit } from "./crossProviderReplayFork";

type FakeSession = { id: string };
type FakeRuntime = { name: string };

const CONTEXT_WINDOW = 1_000_000;

function fit(overrides: Partial<TranscriptReplayFit> = {}): TranscriptReplayFit {
  return {
    text: `Full prior transcript (verbatim replay; not a summary).\n\n[user]\nnewest ${"n".repeat(60_000)}`,
    turnCount: 9,
    keptTurnCount: 2,
    truncatedTurnCount: 7,
    truncated: true,
    ...overrides,
  };
}

function harness(options: {
  origin?: TranscriptReplayOrigin | null;
  provenance?: ReplayForkProvenance | null;
  sourceReplay?: TranscriptReplayFit | null;
} = {}) {
  const session: FakeSession = { id: "chat-target" };
  const runtime: FakeRuntime = { name: "claude-runtime" };
  let origin = options.origin ?? null;

  const notices: Array<{ kind: string; message: string; turnId: string }> = [];
  const staged: Array<string | null> = [];
  const deps = {
    logger: { info: vi.fn(), warn: vi.fn() },
    emitNotice: vi.fn((_session: FakeSession, notice: { kind: "info" | "warning"; message: string; turnId: string }) => {
      notices.push(notice);
    }),
    persist: vi.fn(),
    describeSession: vi.fn(() => ({
      id: session.id,
      modelLabel: "Claude Opus 5",
      contextWindowTokens: CONTEXT_WINDOW as number | null,
    })),
    readOrigin: vi.fn(() => origin),
    writeOrigin: vi.fn((_session: FakeSession, next: TranscriptReplayOrigin) => { origin = next; }),
    readForkProvenance: vi.fn(() => options.provenance ?? null),
    stageReplay: vi.fn((_session: FakeSession, replay: string | null) => { staged.push(replay); }),
    buildSourceReplay: vi.fn(() => options.sourceReplay === undefined ? fit() : options.sourceReplay),
    resetProviderSession: vi.fn(async () => {}),
    clearContinuityContext: vi.fn(),
    onGaveUp: vi.fn(),
  };

  return {
    session,
    runtime,
    deps,
    notices,
    staged,
    readOrigin: () => origin,
    recovery: createClaudeReplayOverflowRecovery<FakeSession, FakeRuntime>(deps),
  };
}

describe("normalizeTranscriptReplayOrigin", () => {
  it("keeps a marker with a source id and drops one without", () => {
    expect(normalizeTranscriptReplayOrigin({
      sourceSessionId: " chat-source ",
      budgetChars: 40_000.7,
      keptTurnCount: 2,
      turnCount: 9,
      contextWindowTokens: 1_000_000,
    })).toEqual({
      sourceSessionId: "chat-source",
      budgetChars: 40_000,
      keptTurnCount: 2,
      turnCount: 9,
      contextWindowTokens: 1_000_000,
    });
    expect(normalizeTranscriptReplayOrigin({ budgetChars: 10 })).toBeNull();
    expect(normalizeTranscriptReplayOrigin(null)).toBeNull();
    expect(normalizeTranscriptReplayOrigin("chat-source")).toBeNull();
  });

  it("floors nonsense counts to zero rather than carrying them forward", () => {
    expect(normalizeTranscriptReplayOrigin({
      sourceSessionId: "chat-source",
      budgetChars: -5,
      keptTurnCount: Number.NaN,
      turnCount: "9",
      contextWindowTokens: 0,
    })).toEqual({
      sourceSessionId: "chat-source",
      budgetChars: 0,
      keptTurnCount: 0,
      turnCount: 0,
    });
  });
});

describe("recoverFromOverflow", () => {
  it("stages a half-budget replay on a fresh provider session", async () => {
    const h = harness({
      origin: {
        sourceSessionId: "chat-source",
        budgetChars: 90_000,
        keptTurnCount: 9,
        turnCount: 9,
      },
    });
    h.recovery.noteConsumedReplay(h.runtime, "turn-1", "x".repeat(60_000), false);

    const outcome = await h.recovery.recoverFromOverflow(h.session, h.runtime, "turn-1", {
      isRetryTurn: false,
    });

    expect(outcome).toBe("retry");
    // Half of what this turn actually sent, not half of the older marker value.
    expect(h.deps.buildSourceReplay).toHaveBeenCalledWith("chat-source", CONTEXT_WINDOW, 30_000);
    // Resuming the session that just rejected the prompt would fail the same
    // way, and its continuity tail would re-add the turns the replay carries.
    expect(h.deps.resetProviderSession).toHaveBeenCalledTimes(1);
    expect(h.deps.clearContinuityContext).toHaveBeenCalledTimes(1);
    expect(h.staged).toEqual([fit().text]);
    expect(h.readOrigin()).toEqual({
      sourceSessionId: "chat-source",
      budgetChars: 30_000,
      keptTurnCount: 2,
      turnCount: 9,
      contextWindowTokens: CONTEXT_WINDOW,
    });
    expect(h.notices).toEqual([{
      kind: "info",
      message: "That was too long for Claude Opus 5. ADE is sending your message again with the newest 2 turns of the handoff.",
      turnId: "turn-1",
    }]);
    // A retry in flight is not an outcome yet: only the caller knows whether it
    // landed, so nothing is reported from here.
    expect(h.deps.onGaveUp).not.toHaveBeenCalled();
  });

  it("falls back to the window budget when no replay length is known", async () => {
    const h = harness({
      origin: { sourceSessionId: "chat-source", budgetChars: 0, keptTurnCount: 0, turnCount: 0 },
    });

    expect(await h.recovery.recoverFromOverflow(h.session, h.runtime, "turn-1", {
      isRetryTurn: false,
    })).toBe("retry");
    // 60% of a 1M-token window at 3 chars per token.
    expect(h.deps.buildSourceReplay).toHaveBeenCalledWith("chat-source", CONTEXT_WINDOW, 1_800_000);
  });

  it("gives up without a retry once the message has already been retried", async () => {
    const h = harness({
      origin: {
        sourceSessionId: "chat-source",
        budgetChars: 90_000,
        keptTurnCount: 9,
        turnCount: 9,
      },
    });
    h.recovery.noteConsumedReplay(h.runtime, "turn-1", "x".repeat(60_000), false);
    await h.recovery.recoverFromOverflow(h.session, h.runtime, "turn-1", { isRetryTurn: false });
    h.deps.buildSourceReplay.mockClear();
    h.deps.resetProviderSession.mockClear();
    h.notices.length = 0;
    h.staged.length = 0;

    // The retry carried the halved replay and overflowed again.
    h.recovery.noteConsumedReplay(h.runtime, "turn-2", fit().text, true);
    const outcome = await h.recovery.recoverFromOverflow(h.session, h.runtime, "turn-2", {
      isRetryTurn: true,
    });

    expect(outcome).toBe("stop");
    expect(h.deps.buildSourceReplay).not.toHaveBeenCalled();
    expect(h.deps.resetProviderSession).not.toHaveBeenCalled();
    // "Send your message again" is only true if the next message still carries
    // the conversation, so the replay goes back.
    expect(h.staged).toEqual([fit().text]);
    expect(h.notices).toEqual([{
      kind: "warning",
      message: "The handoff transcript is too long for Claude Opus 5. ADE kept the newest 2 turns. Send your message again.",
      turnId: "turn-2",
    }]);
    // Exactly one coarse product fact per give-up.
    expect(h.deps.onGaveUp).toHaveBeenCalledTimes(1);
    expect(h.deps.onGaveUp).toHaveBeenCalledWith(h.session);
  });

  it("gives up when the halved budget is too small to carry anything", async () => {
    const h = harness({
      origin: { sourceSessionId: "chat-source", budgetChars: 1_000, keptTurnCount: 1, turnCount: 9 },
    });

    expect(await h.recovery.recoverFromOverflow(h.session, h.runtime, "turn-1", {
      isRetryTurn: false,
    })).toBe("stop");
    expect(h.deps.buildSourceReplay).not.toHaveBeenCalled();
    expect(h.notices[0]?.kind).toBe("warning");
  });

  it("gives up when the source transcript has nothing left to send", async () => {
    const h = harness({
      origin: { sourceSessionId: "chat-source", budgetChars: 90_000, keptTurnCount: 9, turnCount: 9 },
      sourceReplay: fit({ text: "", keptTurnCount: 0 }),
    });

    expect(await h.recovery.recoverFromOverflow(h.session, h.runtime, "turn-1", {
      isRetryTurn: false,
    })).toBe("stop");
    expect(h.deps.resetProviderSession).not.toHaveBeenCalled();
    expect(h.notices[0]?.message).toContain("ADE kept the newest 0 turns.");
  });
});

describe("replay-fork provenance", () => {
  it("adopts a replay fork with no marker yet", async () => {
    const h = harness({
      origin: null,
      provenance: { sourceSessionId: "chat-source", replayFork: true, sourceProvider: "cursor" },
    });

    expect(await h.recovery.recoverFromOverflow(h.session, h.runtime, "turn-1", {
      isRetryTurn: false,
    })).toBe("retry");
    expect(h.readOrigin()).toMatchObject({ sourceSessionId: "chat-source" });
  });

  it("adopts a legacy cross-provider fork, which could only have been replayed", async () => {
    const h = harness({
      origin: null,
      provenance: { sourceSessionId: "chat-source", replayFork: false, sourceProvider: "codex" },
    });

    expect(await h.recovery.recoverFromOverflow(h.session, h.runtime, "turn-1", {
      isRetryTurn: false,
    })).toBe("retry");
  });

  it("leaves a native Claude fork alone: its history lives on the provider", async () => {
    const h = harness({
      origin: null,
      provenance: { sourceSessionId: "chat-source", replayFork: false, sourceProvider: "claude" },
    });

    // null hands the failure back to the caller's ordinary overflow handling.
    expect(await h.recovery.recoverFromOverflow(h.session, h.runtime, "turn-1", {
      isRetryTurn: false,
    })).toBeNull();
    expect(h.deps.writeOrigin).not.toHaveBeenCalled();
    expect(h.deps.resetProviderSession).not.toHaveBeenCalled();
    expect(h.staged).toEqual([]);
    expect(h.notices).toEqual([]);
  });

  it("leaves a fork whose source provider cannot be read alone", async () => {
    const h = harness({
      origin: null,
      provenance: { sourceSessionId: "chat-source", replayFork: false, sourceProvider: null },
    });

    expect(await h.recovery.recoverFromOverflow(h.session, h.runtime, "turn-1", {
      isRetryTurn: false,
    })).toBeNull();
  });

  it("returns null for a chat that was never forked", async () => {
    const h = harness({ origin: null, provenance: null });

    expect(await h.recovery.recoverFromOverflow(h.session, h.runtime, "turn-1", {
      isRetryTurn: false,
    })).toBeNull();
    expect(h.deps.persist).not.toHaveBeenCalled();
  });
});

describe("retry bookkeeping", () => {
  async function stagedHarness() {
    const h = harness({
      origin: { sourceSessionId: "chat-source", budgetChars: 90_000, keptTurnCount: 9, turnCount: 9 },
    });
    h.recovery.noteConsumedReplay(h.runtime, "turn-1", "x".repeat(60_000), false);
    await h.recovery.recoverFromOverflow(h.session, h.runtime, "turn-1", { isRetryTurn: false });
    h.notices.length = 0;
    h.staged.length = 0;
    h.deps.buildSourceReplay.mockClear();
    return h;
  }

  it("clears the staged replay and the turn record once the retry lands", async () => {
    const h = await stagedHarness();

    h.recovery.noteRetrySucceeded(h.runtime);

    // Nothing staged: the replay is in the provider session now, and putting it
    // back would send the conversation twice.
    h.recovery.reportRetryFailed(h.session, h.runtime, "turn-2");
    expect(h.staged).toEqual([]);
    expect(h.notices).toEqual([]);
    // The consumed record is gone too, so a later overflow is judged by the
    // caller's own flag rather than a stale attempt count.
    expect(await h.recovery.recoverFromOverflow(h.session, h.runtime, "turn-1", {
      isRetryTurn: false,
    })).toBe("retry");
  });

  it("re-stages once when the retry never reaches the provider", async () => {
    const h = await stagedHarness();

    h.recovery.reportRetryFailed(h.session, h.runtime, "turn-2");

    expect(h.staged).toEqual([fit().text]);
    expect(h.notices).toEqual([{
      kind: "warning",
      message: "The handoff transcript is too long for Claude Opus 5. ADE kept the newest 2 turns. Send your message again.",
      turnId: "turn-2",
    }]);

    // Two terminal paths can both notice the same dead retry. The second one
    // must not re-stage or say it again.
    h.recovery.reportRetryFailed(h.session, h.runtime, "turn-2");
    expect(h.staged).toHaveLength(1);
    expect(h.notices).toHaveLength(1);
    expect(h.deps.onGaveUp).toHaveBeenCalledTimes(1);
  });

  it("stays quiet when there was never a retry to fail", () => {
    const h = harness({
      origin: { sourceSessionId: "chat-source", budgetChars: 90_000, keptTurnCount: 9, turnCount: 9 },
    });

    h.recovery.reportRetryFailed(h.session, h.runtime, "turn-1");

    expect(h.staged).toEqual([]);
    expect(h.notices).toEqual([]);
  });

  it("forgets a consumed replay that belonged to a different turn", async () => {
    const h = harness({
      origin: { sourceSessionId: "chat-source", budgetChars: 90_000, keptTurnCount: 9, turnCount: 9 },
    });
    h.recovery.noteConsumedReplay(h.runtime, "turn-1", "x".repeat(60_000), true);

    // The overflow lands on a later turn, so the earlier record's attempt count
    // must not make this one give up.
    expect(await h.recovery.recoverFromOverflow(h.session, h.runtime, "turn-2", {
      isRetryTurn: false,
    })).toBe("retry");
    expect(h.deps.buildSourceReplay).toHaveBeenCalledWith("chat-source", CONTEXT_WINDOW, 45_000);
  });

  it("drops the record when a turn carries no replay at all", async () => {
    const h = harness({
      origin: { sourceSessionId: "chat-source", budgetChars: 90_000, keptTurnCount: 9, turnCount: 9 },
    });
    h.recovery.noteConsumedReplay(h.runtime, "turn-1", "x".repeat(60_000), true);
    h.recovery.forgetConsumedReplay(h.runtime);

    expect(await h.recovery.recoverFromOverflow(h.session, h.runtime, "turn-1", {
      isRetryTurn: false,
    })).toBe("retry");
  });
});
