import { describe, expect, it } from "vitest";

import {
  AGENT_CHAT_CONTEXT_ROTATION_PCT,
  AGENT_CHAT_CONTEXT_ROTATION_TURNS,
  isContextOverflowFailureText,
  type AgentChatSessionContextHealth,
} from "../../../shared/types/chat";
import {
  normalizeLastTurnFailure,
  normalizeSessionContextHealth,
  shouldAdviseSessionRotation,
} from "./agentChatService";

/**
 * The bookkeeping behind two promises: a CTO voice call is never started on a
 * thread that cannot answer, and a thread is offered a rotation BEFORE it
 * wedges rather than after.
 *
 * The sentences below are the real ones. The owner's CTO thread failed with
 * "Prompt is too long" and its fallback compaction answered "conversation could
 * not be reduced below the context limit" — the second half of the same event,
 * and the strongest statement a provider can make that a thread is finished.
 */
describe("isContextOverflowFailureText", () => {
  it("recognises the sentences a wedged thread actually produces", () => {
    expect(isContextOverflowFailureText("Prompt is too long")).toBe(true);
    expect(isContextOverflowFailureText(
      "API Error: 400 prompt is too long: 1204321 tokens > 1000000 maximum",
    )).toBe(true);
    expect(isContextOverflowFailureText(
      "The conversation could not be reduced below the context limit.",
    )).toBe(true);
    expect(isContextOverflowFailureText("context window overflow")).toBe(true);
  });

  it("does not claim an ordinary failure is the conversation's fault", () => {
    expect(isContextOverflowFailureText("ECONNRESET")).toBe(false);
    expect(isContextOverflowFailureText("Tool 'Bash' was denied by the user.")).toBe(false);
    expect(isContextOverflowFailureText("")).toBe(false);
    expect(isContextOverflowFailureText(null)).toBe(false);
    expect(isContextOverflowFailureText(undefined)).toBe(false);
  });
});

describe("shouldAdviseSessionRotation", () => {
  const context = (
    overrides: Partial<AgentChatSessionContextHealth> = {},
  ): AgentChatSessionContextHealth => ({
    occupancyPct: AGENT_CHAT_CONTEXT_ROTATION_PCT,
    aboveHighWaterTurns: AGENT_CHAT_CONTEXT_ROTATION_TURNS,
    compactionSeen: true,
    updatedAt: "2026-09-16T00:00:00.000Z",
    ...overrides,
  });

  it("says nothing about a thread that is merely busy", () => {
    expect(shouldAdviseSessionRotation(null, context({
      occupancyPct: AGENT_CHAT_CONTEXT_ROTATION_PCT - 1,
    }))).toBe(false);
    expect(shouldAdviseSessionRotation(null, context({ occupancyPct: 12 }))).toBe(false);
    expect(shouldAdviseSessionRotation(null, null)).toBe(false);
  });

  it("waits for a trend, not a spike", () => {
    expect(shouldAdviseSessionRotation(null, context({ aboveHighWaterTurns: 1 }))).toBe(false);
    expect(shouldAdviseSessionRotation(null, context())).toBe(true);
  });

  it("stays quiet until a compaction has actually run", () => {
    // Before compaction the occupancy number is not the thread's floor: the
    // next compaction may win most of it back, so advising a rotation then
    // would be advising it for nothing.
    expect(shouldAdviseSessionRotation(null, context({ compactionSeen: false }))).toBe(false);
  });

  it("is past advice once the thread has already failed on overflow", () => {
    expect(shouldAdviseSessionRotation(
      { kind: "context_overflow", message: "Prompt is too long", at: "2026-09-16T00:00:00.000Z" },
      null,
    )).toBe(true);
  });

  it("does not treat one bad turn as a reason to throw the thread away", () => {
    expect(shouldAdviseSessionRotation(
      { kind: "error", message: "ECONNRESET", at: "2026-09-16T00:00:00.000Z" },
      context({ occupancyPct: 10, aboveHighWaterTurns: 0 }),
    )).toBe(false);
  });
});

describe("reading the persisted record back", () => {
  it("keeps a real failure and refuses anything else", () => {
    expect(normalizeLastTurnFailure({
      kind: "context_overflow",
      message: "Prompt is too long",
      at: "2026-09-16T00:00:00.000Z",
      turnId: "turn-1",
    })).toEqual({
      kind: "context_overflow",
      message: "Prompt is too long",
      at: "2026-09-16T00:00:00.000Z",
      turnId: "turn-1",
    });
    expect(normalizeLastTurnFailure({ kind: "nonsense", at: "2026-09-16T00:00:00.000Z" })).toBeNull();
    expect(normalizeLastTurnFailure({ kind: "error", message: "x" })).toBeNull();
    expect(normalizeLastTurnFailure(null)).toBeNull();
    expect(normalizeLastTurnFailure("failed")).toBeNull();
  });

  it("clamps an occupancy a provider reported badly", () => {
    expect(normalizeSessionContextHealth({
      occupancyPct: 140,
      aboveHighWaterTurns: -3,
      compactionSeen: true,
      updatedAt: "2026-09-16T00:00:00.000Z",
    })).toEqual({
      occupancyPct: 100,
      aboveHighWaterTurns: 0,
      compactionSeen: true,
      updatedAt: "2026-09-16T00:00:00.000Z",
    });
    expect(normalizeSessionContextHealth({ occupancyPct: 50 })).toBeNull();
  });
});
