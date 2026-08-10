import { describe, expect, it } from "vitest";
import type { AgentChatEventEnvelope } from "./types";
import {
  FOLDABLE_CHAT_EVENT_TYPES,
  foldChatEventEnvelopesForReplay,
  isCleanTextAppend,
  isFoldableChatEventType,
} from "./chatReplayFold";

const SESSION = "session-1";

function envelope(
  event: Record<string, unknown>,
  sequence: number,
  timestamp = `2026-08-09T00:00:${String(sequence % 60).padStart(2, "0")}.000Z`,
): AgentChatEventEnvelope {
  return { sessionId: SESSION, timestamp, sequence, event } as unknown as AgentChatEventEnvelope;
}

function textEvent(text: string, seq: number, itemId = "msg_1", turnId = "turn_1"): AgentChatEventEnvelope {
  return envelope({ type: "text", text, messageId: `mid:${itemId}`, itemId, turnId }, seq);
}

/** Desktop `mergeStreamingText` (chatTranscriptRows.ts), verbatim. */
function desktopMerge(existing: string, incoming: string): string {
  if (!existing.length) return incoming;
  if (!incoming.length) return existing;
  if (incoming.startsWith(existing)) return incoming;
  return `${existing}${incoming}`;
}

/**
 * The subset of iOS `mergeWorkStreamingText` that can fire before its overlap
 * scan. If none of these hit, iOS reaches `existing + incoming` too.
 */
function iosMergeAgreesWithConcat(existing: string, incoming: string): boolean {
  if (!existing.length || !incoming.length) return false;
  if (existing === incoming) return false;
  if (incoming.startsWith(existing)) return false;
  if (existing.startsWith(incoming)) return false;
  const te = existing.trim();
  const ti = incoming.trim();
  if (ti.length && te.endsWith(ti)) return false;
  if (te.length && ti.startsWith(te)) return false;
  if (existing.endsWith(incoming)) return false;
  const max = Math.min(existing.length, incoming.length, 64);
  for (let n = max; n > 0; n -= 1) if (existing.endsWith(incoming.slice(0, n))) return false;
  return true;
}

/** What a client derives from an unfolded run, using the desktop merge. */
function clientFoldText(events: AgentChatEventEnvelope[]): string {
  let acc = "";
  for (const e of events) {
    acc = desktopMerge(acc, (e.event as unknown as { text: string }).text);
  }
  return acc;
}

describe("fold scope", () => {
  it("folds only the types it can prove, and nothing else", () => {
    expect(Object.keys(FOLDABLE_CHAT_EVENT_TYPES).sort()).toEqual(["reasoning", "text"]);
    for (const type of ["plan", "command", "file_change", "tool_call", "tool_result", "context_usage"]) {
      expect(isFoldableChatEventType(type)).toBe(false);
    }
  });

  it("passes an unknown event type through untouched rather than guessing", () => {
    const input = [
      envelope({ type: "some_future_event", text: "a", itemId: "x", turnId: "t" }, 1),
      envelope({ type: "some_future_event", text: "b", itemId: "x", turnId: "t" }, 2),
    ];
    const { events, foldedAwayCount } = foldChatEventEnvelopesForReplay(input);
    expect(foldedAwayCount).toBe(0);
    expect(events).toEqual(input);
  });

  it("carries malformed envelopes through instead of faulting", () => {
    // Real transcripts contain lines with no `event` (legacy writes and
    // splice-repaired tails); this crashed the first implementation.
    const input = [
      { sessionId: SESSION, timestamp: "2026-08-09T00:00:00.000Z", sequence: 1 },
      { sessionId: SESSION, timestamp: "2026-08-09T00:00:01.000Z", sequence: 2, event: null },
      textEvent("a ", 3),
      textEvent("b", 4),
    ] as unknown as AgentChatEventEnvelope[];
    const { events, foldedAwayCount } = foldChatEventEnvelopesForReplay(input);
    expect(foldedAwayCount).toBe(1);
    expect(events).toHaveLength(3);
    expect((events[2]!.event as unknown as { text: string }).text).toBe("a b");
  });

  it("leaves every non-text type in the union unfolded", () => {
    // Named explicitly: these all merge field-wise or append a payload field,
    // and desktop/iOS do it differently, so keep-last would change rendering.
    const input = [
      envelope({ type: "plan", steps: [{ text: "a" }], turnId: "t", itemId: "p" }, 1),
      envelope({ type: "plan", steps: [], explanation: "why", turnId: "t", itemId: "p" }, 2),
      envelope({ type: "command", command: "ls", output: "one", itemId: "c", turnId: "t" }, 3),
      envelope({ type: "command", command: "ls", output: "two", itemId: "c", turnId: "t" }, 4),
      envelope({ type: "file_change", path: "a.ts", diff: "+1", itemId: "f", turnId: "t" }, 5),
      envelope({ type: "tool_call", tool: "grep", itemId: "tc", turnId: "t" }, 6),
      envelope({ type: "tool_result", tool: "grep", itemId: "tc", turnId: "t", status: "completed" }, 7),
      envelope({ type: "context_usage", usage: { used: 10 }, turnId: "t" }, 8),
    ];
    const { events, foldedAwayCount } = foldChatEventEnvelopesForReplay(input);
    expect(foldedAwayCount).toBe(0);
    expect(events).toEqual(input);
  });
});

describe("fold equivalence: text", () => {
  it("collapses a clean-append run into one event with the same text", () => {
    const input = [
      textEvent("Because the comparison", 1),
      textEvent(" is fundamentally visual", 2),
      textEvent(", I am using the in-app", 3),
      textEvent(" browser skill", 4),
    ];
    const { events, foldedAwayCount } = foldChatEventEnvelopesForReplay(input);
    expect(events).toHaveLength(1);
    expect(foldedAwayCount).toBe(3);
    expect((events[0]!.event as unknown as { text: string }).text).toBe(clientFoldText(input));
  });

  it("carries the LAST delta's sequence and timestamp so a watermark cannot land mid-run", () => {
    const input = [textEvent("a ", 10), textEvent("b ", 11), textEvent("c", 12)];
    const { events } = foldChatEventEnvelopesForReplay(input);
    expect(events[0]!.sequence).toBe(12);
    expect(events[0]!.timestamp).toBe(input[2]!.timestamp);
  });

  it("emits the folded run at the position of its FIRST event", () => {
    const input = [
      envelope({ type: "status", turnStatus: "active", turnId: "turn_1" }, 1),
      textEvent("hello ", 2),
      textEvent("world", 3),
      envelope({ type: "done", turnId: "turn_1", status: "completed" }, 4),
    ];
    const { events } = foldChatEventEnvelopesForReplay(input);
    expect(events.map((e) => (e.event as unknown as { type: string }).type))
      .toEqual(["status", "text", "done"]);
  });

  it("keeps separate messages and separate turns apart", () => {
    const input = [
      textEvent("one", 1, "msg_a", "turn_1"),
      textEvent("two", 2, "msg_b", "turn_1"),
      textEvent("three", 3, "msg_a", "turn_2"),
    ];
    const { events, foldedAwayCount } = foldChatEventEnvelopesForReplay(input);
    expect(foldedAwayCount).toBe(0);
    expect(events).toHaveLength(3);
  });

  it("interleaved messages each fold to what a client derives", () => {
    const a = [textEvent("alpha ", 1, "msg_a"), textEvent("beta", 3, "msg_a")];
    const b = [textEvent("gamma ", 2, "msg_b"), textEvent("delta", 4, "msg_b")];
    const { events } = foldChatEventEnvelopesForReplay([a[0]!, b[0]!, a[1]!, b[1]!]);
    expect(events).toHaveLength(2);
    expect((events[0]!.event as unknown as { text: string }).text).toBe(clientFoldText(a));
    expect((events[1]!.event as unknown as { text: string }).text).toBe(clientFoldText(b));
  });

  it("does not fold deltas without a stable id — clients merge those by adjacency", () => {
    const input = [
      envelope({ type: "text", text: "a", turnId: "t" }, 1),
      envelope({ type: "text", text: "b", turnId: "t" }, 2),
    ];
    const { events, foldedAwayCount } = foldChatEventEnvelopesForReplay(input);
    expect(foldedAwayCount).toBe(0);
    expect(events).toEqual(input);
  });

  it("folds reasoning on the same rule as text", () => {
    const input = [
      envelope({ type: "reasoning", text: "first ", itemId: "r1", turnId: "t" }, 1),
      envelope({ type: "reasoning", text: "second", itemId: "r1", turnId: "t" }, 2),
    ];
    const { events, foldedAwayCount } = foldChatEventEnvelopesForReplay(input);
    expect(foldedAwayCount).toBe(1);
    expect((events[0]!.event as unknown as { text: string }).text).toBe("first second");
  });
});

describe("fold equivalence: the cases where clients disagree stay unfolded", () => {
  it.each([
    ["full-text replay (incoming repeats existing plus more)", "hello", "hello world"],
    ["exact duplicate", "hello", "hello"],
    ["existing already contains incoming as prefix", "hello world", "hello"],
    ["repeated tail", "the answer is", " is"],
    ["boundary overlap", "abcdef", "defghi"],
    ["empty incoming", "hello", ""],
  ])("%s is not a clean append", (_label, existing, incoming) => {
    expect(isCleanTextAppend(existing, incoming)).toBe(false);
  });

  it("stops the run instead of guessing when a delta replays the message", () => {
    const input = [textEvent("hello", 1), textEvent(" world", 2), textEvent("hello world!", 3)];
    const { events, foldedAwayCount } = foldChatEventEnvelopesForReplay(input);
    // First two fold; the replay-shaped third is left for the client's own merge.
    expect(foldedAwayCount).toBe(1);
    expect(events).toHaveLength(2);
    expect((events[0]!.event as unknown as { text: string }).text).toBe("hello world");
    expect((events[1]!.event as unknown as { text: string }).text).toBe("hello world!");
  });

  it("every pair this module folds is one where desktop and iOS provably agree", () => {
    const pairs: Array<[string, string]> = [
      ["Because the comparison", " is fundamentally visual"],
      ["hello", " world"],
      ["a", "b"],
      ["hello", "hello world"],
      ["hello", "hello"],
      ["the answer is", " is"],
      ["abcdef", "defghi"],
      ["x", ""],
      ["", "y"],
    ];
    for (const [existing, incoming] of pairs) {
      if (!isCleanTextAppend(existing, incoming)) continue;
      expect(iosMergeAgreesWithConcat(existing, incoming)).toBe(true);
      expect(desktopMerge(existing, incoming)).toBe(existing + incoming);
    }
  });
});

describe("delivery bookkeeping", () => {
  it("returns every pre-fold envelope as a source so collapsed deltas are still marked sent", () => {
    const input = [textEvent("a ", 1), textEvent("b ", 2), textEvent("c", 3)];
    const { events, sources } = foldChatEventEnvelopesForReplay(input);
    expect(events).toHaveLength(1);
    expect(sources).toEqual(input);
  });
});

describe("sequence identity regression (ADE transcript sequence collision class)", () => {
  /**
   * The documented failure: a host rehydration restarts `eventSequence` at 1,
   * so two different events share a `sessionId:sequence` pair and the second is
   * discarded as a replay — which is how AskUserQuestion cards silently vanished
   * on iOS. A fold that reused one sequence across distinct messages, or that
   * left a run's sequence pointing at its first delta, would manufacture the
   * same collision. This asserts it cannot.
   */
  const deliveryKey = (e: AgentChatEventEnvelope): string =>
    `${e.sessionId}:${e.sequence ?? -1}:${e.timestamp}:${(e.event as unknown as { type: string }).type}`;

  it("never emits two folded events sharing a delivery key", () => {
    const input = [
      textEvent("one ", 1, "msg_a"),
      textEvent("two", 2, "msg_a"),
      textEvent("three ", 3, "msg_b"),
      textEvent("four", 4, "msg_b"),
    ];
    const { events } = foldChatEventEnvelopesForReplay(input);
    const keys = events.map(deliveryKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("survives a rehydration that restarts sequences at 1 without collapsing distinct messages", () => {
    // Two host epochs, both numbering from 1, replayed into one snapshot.
    const epochOne = [
      textEvent("before ", 1, "msg_old", "turn_old"),
      textEvent("restart", 2, "msg_old", "turn_old"),
    ];
    const epochTwo = [
      textEvent("after ", 1, "msg_new", "turn_new"),
      textEvent("restart", 2, "msg_new", "turn_new"),
    ];
    const { events } = foldChatEventEnvelopesForReplay([...epochOne, ...epochTwo]);
    expect(events).toHaveLength(2);
    // Same reused sequence number, but the events stay distinct and neither
    // message absorbed the other's text.
    expect(events[0]!.sequence).toBe(2);
    expect(events[1]!.sequence).toBe(2);
    expect((events[0]!.event as unknown as { text: string }).text).toBe("before restart");
    expect((events[1]!.event as unknown as { text: string }).text).toBe("after restart");
  });

  it("a folded run's sequence is >= every sequence it absorbed", () => {
    const input = [textEvent("a ", 5), textEvent("b ", 9), textEvent("c", 17)];
    const { events } = foldChatEventEnvelopesForReplay(input);
    expect(events[0]!.sequence).toBe(17);
    for (const source of input) {
      expect(events[0]!.sequence! >= source.sequence!).toBe(true);
    }
  });
});
