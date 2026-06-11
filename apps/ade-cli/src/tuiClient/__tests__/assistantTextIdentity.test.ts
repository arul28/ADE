import { describe, expect, it } from "vitest";
import {
  appendStreamingText,
  coalesceTextDeltaEnvelopes,
  isCodexSubagentMessageId,
  shouldMergeAssistantText,
} from "../assistantTextIdentity";
import type { AgentChatEventEnvelope } from "../../../../desktop/src/shared/types/chat";

function textDelta(seq: number, text: string, ids: { messageId?: string; turnId?: string; itemId?: string }): AgentChatEventEnvelope {
  return {
    sessionId: "s1",
    timestamp: `2026-01-01T12:00:${String(seq).padStart(2, "0")}.000Z`,
    sequence: seq,
    event: { type: "text", text, ...ids },
  };
}

describe("shouldMergeAssistantText", () => {
  it("merges same messageId, never across different messages", () => {
    expect(shouldMergeAssistantText({ messageId: "a" }, { messageId: "a" })).toBe(true);
    expect(shouldMergeAssistantText({ messageId: "a" }, { messageId: "b" })).toBe(false);
  });
  it("falls back to turn+item, and merges identity-less deltas", () => {
    expect(shouldMergeAssistantText({ turnId: "t", itemId: "i" }, { turnId: "t", itemId: "i" })).toBe(true);
    expect(shouldMergeAssistantText({ turnId: "t", itemId: "i" }, { turnId: "t", itemId: "j" })).toBe(false);
    expect(shouldMergeAssistantText({}, {})).toBe(true);
  });
});

describe("isCodexSubagentMessageId", () => {
  it("matches only the codex-subagent namespace", () => {
    expect(isCodexSubagentMessageId("codex-subagent:x:y:z:text")).toBe(true);
    expect(isCodexSubagentMessageId("msg_123")).toBe(false);
    expect(isCodexSubagentMessageId(undefined)).toBe(false);
  });
});

describe("appendStreamingText", () => {
  it("concatenates ordinary deltas without inserting whitespace", () => {
    expect(appendStreamingText("Consolid", "ated")).toBe("Consolidated");
    expect(appendStreamingText("", "x")).toBe("x");
    expect(appendStreamingText("x", "")).toBe("x");
  });

  it("takes the incoming text when it is a cumulative re-emit of the message", () => {
    expect(appendStreamingText("Hello", "Hello world.")).toBe("Hello world.");
  });

  it("keeps the existing text when the incoming fragment is its re-emitted tail", () => {
    expect(appendStreamingText("A B C.", "B C.")).toBe("A B C.");
    expect(appendStreamingText(
      "so I can split the review instead of doing it as one giant pass.",
      " instead of doing it as one giant pass.",
    )).toBe("so I can split the review instead of doing it as one giant pass.");
  });

  it("still appends whitespace-only repeats (paragraph breaks are legitimate)", () => {
    expect(appendStreamingText("para\n\n", "\n\n")).toBe("para\n\n\n\n");
  });

  it("still appends single-token repeats (only multi-word fragments tail-dedupe)", () => {
    expect(appendStreamingText("x x", " x")).toBe("x x x");
    expect(appendStreamingText("had", " had")).toBe("had had");
  });
});

describe("coalesceTextDeltaEnvelopes", () => {
  it("dedupes a re-emitted tail fragment instead of duplicating it", () => {
    const ids = { messageId: "m1", turnId: "t1", itemId: "i1" };
    const out = coalesceTextDeltaEnvelopes([
      textDelta(1, "A B C.", ids),
      textDelta(2, "B C.", ids),
    ]);
    expect(out).toHaveLength(1);
    expect((out[0]!.event as { text: string }).text).toBe("A B C.");
  });

  it("fuses consecutive same-message deltas into one envelope, byte-identical, latest ts/seq", () => {
    const ids = { messageId: "m1", turnId: "t1", itemId: "i1" };
    const out = coalesceTextDeltaEnvelopes([
      textDelta(1, "I'll do", ids),
      textDelta(2, " a read-only", ids),
      textDelta(3, " pass.", ids),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.event.type).toBe("text");
    expect((out[0]!.event as { text: string }).text).toBe("I'll do a read-only pass.");
    expect(out[0]!.sequence).toBe(3); // latest, so the timeline sort is unchanged
    expect(out[0]!.timestamp).toBe("2026-01-01T12:00:03.000Z");
  });

  it("keeps interleaved concurrent messages separate (never scrambled)", () => {
    const out = coalesceTextDeltaEnvelopes([
      textDelta(1, "Plan", { messageId: "A" }),
      textDelta(2, "Read", { messageId: "B" }),
      textDelta(3, "ning", { messageId: "A" }),
      textDelta(4, "ing", { messageId: "B" }),
    ]);
    // No fusion across the message boundary → 4 envelopes preserved in order.
    expect(out.map((e) => (e.event as { text: string }).text)).toEqual(["Plan", "Read", "ning", "ing"]);
  });

  it("does not fuse across a non-text event", () => {
    const ids = { messageId: "m1", turnId: "t1", itemId: "i1" };
    const out = coalesceTextDeltaEnvelopes([
      textDelta(1, "before", ids),
      { sessionId: "s1", timestamp: "2026-01-01T12:00:02.000Z", sequence: 2, event: { type: "tool_call", itemId: "tc", tool: "read_file" } as never },
      textDelta(3, "after", ids),
    ]);
    expect(out).toHaveLength(3);
  });

  it("collapses a large single-message token stream to one envelope (flood guard)", () => {
    const ids = { messageId: "m1", turnId: "t1", itemId: "i1" };
    const deltas = Array.from({ length: 800 }, (_, i) => textDelta(i + 1, i === 0 ? "x" : " x", ids));
    const out = coalesceTextDeltaEnvelopes(deltas);
    expect(out).toHaveLength(1);
    expect((out[0]!.event as { text: string }).text.startsWith("x x x")).toBe(true);
  });
});
