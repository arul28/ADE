import { describe, expect, it } from "vitest";
import type { AgentChatEventEnvelope } from "./types";
import { isChatTurnBoundaryEnvelope, turnAlignedSnapshotStart } from "./chatSnapshotBoundary";

function envelope(event: Record<string, unknown>, sequence: number): AgentChatEventEnvelope {
  return {
    sessionId: "s",
    timestamp: `2026-09-23T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    sequence,
    event,
  } as unknown as AgentChatEventEnvelope;
}

const user = (seq: number) => envelope({ type: "user_message", text: "hi" }, seq);
const started = (seq: number) => envelope({ type: "status", turnStatus: "started", turnId: "t" }, seq);
const text = (seq: number) => envelope({ type: "text", text: "x", turnId: "t" }, seq);

describe("turnAlignedSnapshotStart", () => {
  it("recognizes user messages and turn starts as boundaries, nothing else", () => {
    expect(isChatTurnBoundaryEnvelope(user(1))).toBe(true);
    expect(isChatTurnBoundaryEnvelope(started(1))).toBe(true);
    expect(isChatTurnBoundaryEnvelope(envelope({ type: "status", turnStatus: "completed" }, 1))).toBe(false);
    expect(isChatTurnBoundaryEnvelope(text(1))).toBe(false);
    expect(isChatTurnBoundaryEnvelope(null)).toBe(false);
  });

  it("moves a mid-turn cut back to the nearest boundary within the extra budget", () => {
    const events = [text(1), user(2), text(3), text(4), text(5), text(6)];
    // Natural cut at index 4; each event costs 100 bytes; one budget = 300.
    expect(turnAlignedSnapshotStart(events, 4, 300, () => 100)).toBe(1);
  });

  it("prefers the nearest boundary, including a turn start", () => {
    const events = [user(1), text(2), started(3), text(4), text(5)];
    expect(turnAlignedSnapshotStart(events, 4, 1_000, () => 100)).toBe(2);
  });

  it("keeps the natural cut when no boundary lies within one extra budget", () => {
    const events = [user(1), text(2), text(3), text(4), text(5)];
    // Reaching index 0 costs 4 × 100 = 400 > 300.
    expect(turnAlignedSnapshotStart(events, 4, 300, () => 100)).toBe(4);
  });

  it("leaves an already aligned or uncut window alone", () => {
    const events = [text(1), user(2), text(3)];
    expect(turnAlignedSnapshotStart(events, 1, 1_000, () => 100)).toBe(1);
    expect(turnAlignedSnapshotStart(events, 0, 1_000, () => 100)).toBe(0);
    expect(turnAlignedSnapshotStart(events, 3, 1_000, () => 100)).toBe(3);
  });
});
