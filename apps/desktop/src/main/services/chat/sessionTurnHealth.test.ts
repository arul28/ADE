import { describe, expect, it } from "vitest";

import { isContextOverflowFailureText } from "../../../shared/types/chat";
import {
  normalizeLastTurnFailure,
  normalizeSessionContextHealth,
} from "./sessionTurnHealth";

/**
 * The bookkeeping behind one promise: a thread is offered a rotation BEFORE it
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
