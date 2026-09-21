import { describe, expect, it } from "vitest";
import type { AgentChatEvent, AgentChatEventEnvelope } from "./types/chat";
import {
  compactChatEventForMobileWire,
  compactToolResultForMobile,
  createSubagentProgressCoalescer,
  foldSubagentProgressForSnapshot,
  isMirroredSubagentProgress,
  MOBILE_TOOL_RESULT_MAX_BYTES,
  subagentProgressIdentity,
} from "./chatMobileSlim";

const envelope = (event: AgentChatEvent, sequence: number): AgentChatEventEnvelope => ({
  sessionId: "s1",
  timestamp: new Date(1_700_000_000_000 + sequence).toISOString(),
  sequence,
  event,
});

const underscoreProgress = (agentId: string, summary = "working"): AgentChatEvent => ({
  type: "subagent_progress",
  taskId: agentId,
  agentId,
  summary,
});

const dotProgress = (agentId: string, text = "working"): AgentChatEvent => ({
  type: "subagent.progress",
  agentId,
  text,
});

describe("subagentProgressIdentity", () => {
  it("identifies both families and never the lifecycle bookends", () => {
    expect(subagentProgressIdentity(underscoreProgress("a"))).toEqual({ agentKey: "a", family: "underscore" });
    expect(subagentProgressIdentity(dotProgress("a"))).toEqual({ agentKey: "a", family: "dot" });
    expect(subagentProgressIdentity({ type: "subagent_started", taskId: "a", description: "d" })).toBeNull();
    expect(subagentProgressIdentity({ type: "subagent_result", taskId: "a", status: "completed", summary: "s" })).toBeNull();
    expect(subagentProgressIdentity({ type: "subagent.completed", agentId: "a", summary: "s" })).toBeNull();
    expect(subagentProgressIdentity({ type: "text", text: "hi" })).toBeNull();
  });

  it("falls back to taskId when the underscore family omits agentId", () => {
    expect(subagentProgressIdentity({ type: "subagent_progress", taskId: "t1", summary: "x" }))
      .toEqual({ agentKey: "t1", family: "underscore" });
  });
});

describe("isMirroredSubagentProgress", () => {
  it("only drops a dot event that directly follows its underscore original", () => {
    const underscore = { agentKey: "a", family: "underscore" } as const;
    const dot = { agentKey: "a", family: "dot" } as const;
    expect(isMirroredSubagentProgress(underscore, dot)).toBe(true);
    // A different agent's underscore event is not this one's original.
    expect(isMirroredSubagentProgress({ agentKey: "b", family: "underscore" }, dot)).toBe(false);
    // A dot-only stream keeps every event: nothing minted an underscore twin.
    expect(isMirroredSubagentProgress(dot, dot)).toBe(false);
    expect(isMirroredSubagentProgress(null, dot)).toBe(false);
    // The underscore original itself is never a mirror.
    expect(isMirroredSubagentProgress(dot, underscore)).toBe(false);
  });
});

describe("foldSubagentProgressForSnapshot", () => {
  it("keeps one progress per agent, at the position of the newest one", () => {
    const events = [
      envelope(underscoreProgress("a", "1"), 1),
      envelope(underscoreProgress("b", "1"), 2),
      envelope({ type: "text", text: "hi" }, 3),
      envelope(underscoreProgress("a", "2"), 4),
      envelope(underscoreProgress("a", "3"), 5),
    ];
    const folded = foldSubagentProgressForSnapshot(events);
    expect(folded.foldedAwayCount).toBe(2);
    expect(folded.events.map((entry) => entry.sequence)).toEqual([2, 3, 5]);
  });

  it("never lets a thinner dot event replace the underscore original", () => {
    const events = [
      envelope(underscoreProgress("a", "rich"), 1),
      envelope(dotProgress("a", "thin"), 2),
    ];
    const folded = foldSubagentProgressForSnapshot(events);
    expect(folded.events).toHaveLength(1);
    expect((folded.events[0]!.event as { type: string }).type).toBe("subagent_progress");
  });

  it("keeps a dot-only agent's progress rather than losing its card", () => {
    const events = [envelope(dotProgress("a", "only"), 1), envelope(dotProgress("a", "newer"), 2)];
    const folded = foldSubagentProgressForSnapshot(events);
    expect(folded.events).toHaveLength(1);
    expect(folded.events[0]!.sequence).toBe(2);
  });

  it("never folds started or result", () => {
    const events = [
      envelope({ type: "subagent_started", taskId: "a", description: "d" }, 1),
      envelope(underscoreProgress("a"), 2),
      envelope({ type: "subagent_result", taskId: "a", status: "completed", summary: "done" }, 3),
    ];
    const folded = foldSubagentProgressForSnapshot(events);
    expect(folded.foldedAwayCount).toBe(0);
    expect(folded.events).toHaveLength(3);
  });

  it("returns a copy and leaves the input untouched when nothing folds", () => {
    const events = [envelope({ type: "text", text: "hi" }, 1)];
    const folded = foldSubagentProgressForSnapshot(events);
    expect(folded.events).toEqual(events);
    expect(folded.events).not.toBe(events);
  });
});

describe("createSubagentProgressCoalescer", () => {
  it("drops the dot mirror that follows its underscore original", () => {
    const coalescer = createSubagentProgressCoalescer({ intervalMs: 1_000 });
    const first = coalescer.admit(envelope(underscoreProgress("a"), 1), 1, 0);
    expect(first).toHaveLength(1);
    expect(coalescer.admit(envelope(dotProgress("a"), 2), 2, 1)).toEqual([]);
    expect(coalescer.pendingCount).toBe(0);
  });

  it("sends the first progress immediately and coalesces the rest of the window", () => {
    const coalescer = createSubagentProgressCoalescer({ intervalMs: 1_000 });
    expect(coalescer.admit(envelope(underscoreProgress("a", "1"), 1), 1, 0)).toHaveLength(1);
    expect(coalescer.admit(envelope(underscoreProgress("a", "2"), 2), 2, 100)).toEqual([]);
    expect(coalescer.admit(envelope(underscoreProgress("a", "3"), 3), 3, 200)).toEqual([]);
    expect(coalescer.flushDue(500)).toEqual([]);
    const flushed = coalescer.flushDue(1_000);
    expect(flushed).toHaveLength(1);
    // Last write wins: the superseded middle event never goes out.
    expect((flushed[0]!.event.event as { summary: string }).summary).toBe("3");
    expect(flushed[0]!.seq).toBe(3);
  });

  it("passes every non-progress event straight through, in order", () => {
    const coalescer = createSubagentProgressCoalescer({ intervalMs: 1_000 });
    const text = envelope({ type: "text", text: "hi" }, 1);
    expect(coalescer.admit(text, 1, 0)).toEqual([{ event: text, seq: 1, sourceSeq: 1 }]);
  });

  it("drops pending progress when the agent's result supersedes it", () => {
    const coalescer = createSubagentProgressCoalescer({ intervalMs: 1_000 });
    coalescer.admit(envelope(underscoreProgress("a", "1"), 1), 1, 0);
    const pending = envelope(underscoreProgress("a", "2"), 2);
    coalescer.admit(pending, 2, 100);
    expect(coalescer.pendingCount).toBe(1);
    const result = envelope({ type: "subagent_result", taskId: "a", agentId: "a", status: "completed", summary: "done" }, 3);
    expect(coalescer.admit(result, 3, 200)).toEqual([{
      event: result,
      seq: 3,
      sourceSeq: 3,
      superseded: [pending],
    }]);
    expect(coalescer.pendingCount).toBe(0);
    expect(coalescer.flushDue(5_000)).toEqual([]);
  });

  it("delivers a progress stranded behind a newer event without a seq", () => {
    const coalescer = createSubagentProgressCoalescer({ intervalMs: 1_000 });
    coalescer.admit(envelope(underscoreProgress("a", "1"), 1), 1, 0);
    // Superseded within the window, so it waits.
    coalescer.admit(envelope(underscoreProgress("a", "2"), 2), 2, 100);
    // A newer event for a different agent goes out first and advances the
    // client's watermark past the pending event's seq.
    coalescer.admit(envelope(underscoreProgress("b", "1"), 3), 3, 200);
    const flushed = coalescer.flushDue(1_000);
    const stranded = flushed.find((entry) => (entry.event.event as { taskId: string }).taskId === "a");
    expect(stranded).toBeDefined();
    // Sent without a seq: the client applies it (its drop rule is `if let
    // seq`) and its resume watermark stays on the newer event.
    expect(stranded!.seq).toBeNull();
  });

  it("never downgrades a pending underscore event to its dot twin", () => {
    const coalescer = createSubagentProgressCoalescer({ intervalMs: 1_000 });
    coalescer.admit(envelope(underscoreProgress("a", "1"), 1), 1, 0);
    coalescer.admit(envelope(underscoreProgress("a", "2"), 2), 2, 100);
    // Not positionally a mirror (a dot event was admitted in between for b),
    // but still the thinner twin of what is pending.
    coalescer.admit(envelope(dotProgress("b"), 3), 3, 150);
    coalescer.admit(envelope(dotProgress("a"), 4), 4, 160);
    const flushed = coalescer.flushDue(2_000);
    const forA = flushed.find((entry) => {
      const event = entry.event.event as { taskId?: string; agentId?: string };
      return (event.taskId ?? event.agentId) === "a";
    });
    expect((forA!.event.event as { type: string }).type).toBe("subagent_progress");
  });

  it("flushAll empties everything pending", () => {
    const coalescer = createSubagentProgressCoalescer({ intervalMs: 1_000 });
    coalescer.admit(envelope(underscoreProgress("a", "1"), 1), 1, 0);
    coalescer.admit(envelope(underscoreProgress("a", "2"), 2), 2, 10);
    expect(coalescer.pendingCount).toBe(1);
    expect(coalescer.flushAll(20)).toHaveLength(1);
    expect(coalescer.pendingCount).toBe(0);
  });

  it("requeues progress when the transport rejects a flush", () => {
    const coalescer = createSubagentProgressCoalescer({ intervalMs: 1_000 });
    coalescer.admit(envelope(underscoreProgress("a", "1"), 1), 1, 0);
    coalescer.admit(envelope(underscoreProgress("a", "2"), 2), 2, 100);
    const due = coalescer.flushDue(1_000);
    expect(due).toHaveLength(1);
    coalescer.requeue(due);
    const retry = coalescer.flushDue(1_000);
    expect(retry).toHaveLength(1);
    expect((retry[0]!.event.event as { summary: string }).summary).toBe("2");
    expect(retry[0]!.seq).toBeNull();
    expect(retry[0]!.sourceSeq).toBe(2);
  });

  it("requeues non-progress events when the transport rejects them", () => {
    const coalescer = createSubagentProgressCoalescer({ intervalMs: 1_000 });
    const text = envelope({ type: "text", text: "retry me" }, 1);
    const outbound = coalescer.admit(text, 1, 0);
    coalescer.requeue(outbound);
    expect(coalescer.flushAll(1)).toEqual(outbound);
  });

  it("carries a failed progress event as superseded when its result succeeds", () => {
    const coalescer = createSubagentProgressCoalescer({ intervalMs: 1_000 });
    const progress = envelope(underscoreProgress("a", "stale"), 1);
    coalescer.requeue(coalescer.admit(progress, 1, 0));
    const result = envelope({ type: "subagent_result", taskId: "a", agentId: "a", status: "completed", summary: "done" }, 2);
    expect(coalescer.admit(result, 2, 1)).toEqual([{
      event: result,
      seq: 2,
      sourceSeq: 2,
      superseded: [progress],
    }]);
  });

  it("carries an overwritten failed progress event into the replacement", () => {
    const coalescer = createSubagentProgressCoalescer({ intervalMs: 1_000 });
    const failed = envelope(underscoreProgress("a", "failed"), 1);
    coalescer.requeue(coalescer.admit(failed, 1, 0));
    const replacement = envelope(underscoreProgress("a", "replacement"), 2);
    expect(coalescer.admit(replacement, 2, 1)).toEqual([{
      event: replacement,
      seq: 2,
      sourceSeq: 2,
      superseded: [failed],
    }]);
  });
});

describe("compactToolResultForMobile", () => {
  const toolResult = (result: unknown, extra: Record<string, unknown> = {}): Extract<AgentChatEvent, { type: "tool_result" }> => ({
    type: "tool_result",
    tool: "Bash",
    result,
    itemId: "item-1",
    status: "completed",
    ...extra,
  } as Extract<AgentChatEvent, { type: "tool_result" }>);

  it("leaves a result that already fits alone", () => {
    const event = toolResult("short");
    expect(compactToolResultForMobile(event)).toBe(event);
  });

  it("slices a large result and flags it for on-demand fetch", () => {
    const event = toolResult("x".repeat(50_000));
    const compacted = compactToolResultForMobile(event) as Extract<AgentChatEvent, { type: "tool_result" }>;
    expect(typeof compacted.result).toBe("string");
    expect(Buffer.byteLength(compacted.result as string, "utf8")).toBe(MOBILE_TOOL_RESULT_MAX_BYTES);
    expect(compacted.resultTruncatedForMobile).toBe(true);
    expect(compacted.resultOriginalBytes).toBe(50_000);
    expect(compacted.resultOmittedBytes).toBe(50_000 - MOBILE_TOOL_RESULT_MAX_BYTES);
  });

  it("keeps the size the agent actually produced when the result was already capped", () => {
    const compacted = compactToolResultForMobile(
      toolResult("y".repeat(20_000), { resultOriginalBytes: 4_000_000 }),
    ) as Extract<AgentChatEvent, { type: "tool_result" }>;
    expect(compacted.resultOriginalBytes).toBe(4_000_000);
  });

  it("replaces a structured result with text rather than half an object", () => {
    const compacted = compactToolResultForMobile(
      toolResult({ rows: Array.from({ length: 2_000 }, (_, index) => `row-${index}`) }),
    ) as Extract<AgentChatEvent, { type: "tool_result" }>;
    expect(typeof compacted.result).toBe("string");
    expect(compacted.resultTruncatedForMobile).toBe(true);
  });

  it("never slices mid-codepoint", () => {
    const compacted = compactToolResultForMobile(toolResult("é".repeat(4_000))) as Extract<AgentChatEvent, { type: "tool_result" }>;
    expect((compacted.result as string).includes("�")).toBe(false);
  });
});

describe("compactChatEventForMobileWire", () => {
  it("applies the shared wire policy and then the phone cap", () => {
    const wire = compactChatEventForMobileWire({
      type: "tool_result",
      tool: "Bash",
      result: "z".repeat(100_000),
      structured: { big: "payload" },
      itemId: "item-1",
      status: "completed",
    } as AgentChatEvent) as Extract<AgentChatEvent, { type: "tool_result" }>;
    // `structured` is dropped by the shared wire policy for every client.
    expect(wire.structured).toBeUndefined();
    expect(wire.resultTruncatedForMobile).toBe(true);
  });

  it("leaves every other event type to the shared policy alone", () => {
    const event: AgentChatEvent = { type: "text", text: "hello" };
    expect(compactChatEventForMobileWire(event)).toBe(event);
  });
});
