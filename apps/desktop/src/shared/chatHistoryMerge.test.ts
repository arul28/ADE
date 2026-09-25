import { describe, expect, it } from "vitest";

import type { AgentChatEventEnvelope } from "./types/chat";
import {
  agentChatEventIdentityKey,
  captureAgentChatHistoryArrivalWatermark,
  mergeAgentChatHistorySnapshot,
  mergeAgentChatLiveEvents,
} from "./chatHistoryMerge";

function envelope(timestamp: string, text: string): AgentChatEventEnvelope {
  return {
    sessionId: "session-1",
    timestamp,
    event: { type: "text", text },
  };
}

function toolEnvelope(
  timestamp: string,
  event: AgentChatEventEnvelope["event"],
): AgentChatEventEnvelope {
  return { sessionId: "session-1", timestamp, event };
}

describe("chat history ordering", () => {
  it("caches serialized identity across long-thread merge passes", () => {
    let serializations = 0;
    const cached = {
      sessionId: "session-1",
      timestamp: "2026-07-29T10:00:00.000Z",
      event: {
        type: "text",
        text: "cached",
        toJSON: () => {
          serializations += 1;
          return { type: "text", text: "cached" };
        },
      },
    } as unknown as AgentChatEventEnvelope;

    expect(agentChatEventIdentityKey(cached)).toBe(agentChatEventIdentityKey(cached));
    expect(serializations).toBe(1);
    expect(mergeAgentChatLiveEvents([cached], [cached])).toEqual([cached]);
    expect(serializations).toBe(1);
  });

  it("keeps the append-only live path stable and deduped", () => {
    const first = envelope("2026-07-29T10:00:00.000Z", "first");
    const second = envelope("2026-07-29T10:00:01.000Z", "second");
    const existing = [first];

    expect(mergeAgentChatLiveEvents(existing, [first])).toBe(existing);
    expect(mergeAgentChatLiveEvents(existing, [second])).toEqual([first, second]);
  });

  it("upserts streamed tool input in place without losing its completed result", () => {
    const call = toolEnvelope("2026-07-29T10:00:00.000Z", {
      type: "tool_call", tool: "bash", args: {}, itemId: "call-1", logicalItemId: "logical-1", turnId: "turn-1",
    });
    const result = toolEnvelope("2026-07-29T10:00:02.000Z", {
      type: "tool_result", tool: "bash", result: "passed", itemId: "call-1", logicalItemId: "logical-1",
      turnId: "turn-1", status: "completed",
    });
    const updated = toolEnvelope("2026-07-29T10:00:03.000Z", {
      type: "tool_call", tool: "bash", args: { command: "npm test" }, itemId: "call-1",
      logicalItemId: "logical-1", turnId: "turn-1",
    });

    const merged = mergeAgentChatLiveEvents([call, result], [updated]);

    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ timestamp: call.timestamp, event: { type: "tool_call", args: { command: "npm test" } } });
    expect(merged[1]).toBe(result);
  });

  it("drops a preexisting tool result omitted by the authoritative snapshot", () => {
    const call = toolEnvelope("2026-07-29T10:00:00.000Z", {
      type: "tool_call", tool: "bash", args: {}, itemId: "call-2", logicalItemId: "logical-2", turnId: "turn-2",
    });
    const result = toolEnvelope("2026-07-29T10:00:02.000Z", {
      type: "tool_result", tool: "bash", result: "passed", itemId: "call-2", logicalItemId: "logical-2",
      turnId: "turn-2", status: "completed",
    });
    const updated = toolEnvelope("2026-07-29T10:00:03.000Z", {
      type: "tool_call", tool: "bash", args: { command: "pnpm test" }, itemId: "call-2",
      logicalItemId: "logical-2", turnId: "turn-2",
    });

    const arrivalWatermark = captureAgentChatHistoryArrivalWatermark([call, result]);
    const merged = mergeAgentChatHistorySnapshot([updated], [call, result], { arrivalWatermark });

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ event: { type: "tool_call", args: { command: "pnpm test" } } });
  });

  it("retains a tool result that arrives while history is loading", () => {
    const call = toolEnvelope("2026-07-29T10:00:00.000Z", {
      type: "tool_call", tool: "bash", args: { command: "pnpm test" }, itemId: "call-3",
      logicalItemId: "logical-3", turnId: "turn-3",
    });
    const result = toolEnvelope("2026-07-29T10:00:02.000Z", {
      type: "tool_result", tool: "bash", result: "passed", itemId: "call-3", logicalItemId: "logical-3",
      turnId: "turn-3", status: "completed",
    });
    const tail = envelope("2026-07-29T10:00:03.000Z", "tail");
    const arrivalWatermark = captureAgentChatHistoryArrivalWatermark([call]);

    const merged = mergeAgentChatHistorySnapshot(
      [call, tail],
      [call, result, tail],
      { arrivalWatermark },
    );

    expect(merged).toEqual([call, result, tail]);
  });

  it("keeps newer streamed tool arguments inside a stale snapshot range", () => {
    const anchor = envelope("2026-07-29T10:00:00.000Z", "anchor");
    const snapshotCall = toolEnvelope("2026-07-29T10:00:02.000Z", {
      type: "tool_call", tool: "bash", args: {}, itemId: "call-stale", logicalItemId: "logical-stale", turnId: "turn-stale",
    });
    const streamedCall = toolEnvelope("2026-07-29T10:00:03.000Z", {
      type: "tool_call", tool: "bash", args: { command: "npm test" }, itemId: "call-stale",
      logicalItemId: "logical-stale", turnId: "turn-stale",
    });
    const tail = envelope("2026-07-29T10:00:04.000Z", "tail");

    const merged = mergeAgentChatHistorySnapshot(
      [anchor, snapshotCall, tail],
      [anchor, streamedCall, tail],
    );

    expect(merged).toHaveLength(3);
    expect(merged[1]).toMatchObject({
      timestamp: snapshotCall.timestamp,
      event: { type: "tool_call", args: { command: "npm test" } },
    });
  });

  it("uses arrival order to resolve equal-millisecond tool-call updates", () => {
    const timestamp = "2026-07-29T10:00:02.000Z";
    const stale = toolEnvelope(timestamp, {
      type: "tool_call", tool: "bash", args: {}, itemId: "call-equal", logicalItemId: "logical-equal", turnId: "turn-equal",
    });
    const latest = toolEnvelope(timestamp, {
      type: "tool_call", tool: "bash", args: { command: "npm test" }, itemId: "call-equal",
      logicalItemId: "logical-equal", turnId: "turn-equal",
    });

    const merged = mergeAgentChatHistorySnapshot([stale, latest], []);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ event: { type: "tool_call", args: { command: "npm test" } } });
  });

  it("keeps equal-millisecond streamed tool arguments over a stale snapshot", () => {
    const timestamp = "2026-07-29T10:00:02.000Z";
    const stale = toolEnvelope(timestamp, {
      type: "tool_call", tool: "bash", args: {}, itemId: "call-live-tie", logicalItemId: "logical-live-tie", turnId: "turn-live-tie",
    });
    const streamed = toolEnvelope(timestamp, {
      type: "tool_call", tool: "bash", args: { command: "npm test" }, itemId: "call-live-tie",
      logicalItemId: "logical-live-tie", turnId: "turn-live-tie",
    });

    const merged = mergeAgentChatHistorySnapshot([stale], [streamed]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      timestamp,
      event: { type: "tool_call", args: { command: "npm test" } },
    });
  });

  it("consolidates repeated tool calls on the first history snapshot", () => {
    const call = toolEnvelope("2026-07-29T10:00:00.000Z", {
      type: "tool_call", tool: "bash", args: {}, itemId: "call-first", logicalItemId: "logical-first", turnId: "turn-first",
    });
    const updated = toolEnvelope("2026-07-29T10:00:01.000Z", {
      type: "tool_call", tool: "bash", args: { command: "npm test" }, itemId: "call-first",
      logicalItemId: "logical-first", turnId: "turn-first",
    });

    const merged = mergeAgentChatHistorySnapshot([call, updated], []);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      timestamp: call.timestamp,
      event: { type: "tool_call", args: { command: "npm test" } },
    });
  });

  it("inserts a delayed old envelope before the completed tail", () => {
    const prompt = envelope("2026-07-29T10:00:00.000Z", "prompt");
    const done = envelope("2026-07-29T10:00:03.000Z", "done");
    const delayed = envelope("2026-07-29T10:00:01.000Z", "delayed");

    expect(mergeAgentChatLiveEvents([prompt, done], [delayed])).toEqual([
      prompt,
      delayed,
      done,
    ]);
  });

  it("drops replayed rows after an overlapping authoritative tail", () => {
    const older = envelope("2026-07-29T10:00:00.000Z", "older");
    const tail = envelope("2026-07-29T10:00:03.000Z", "tail");
    const replayed = envelope("2026-07-29T10:00:01.000Z", "replayed");

    expect(mergeAgentChatHistorySnapshot(
      [{ ...tail }],
      [older, tail, replayed],
    )).toEqual([older, tail]);
  });

  it("keeps only post-snapshot rows when there is no overlap", () => {
    const replayed = envelope("2026-07-29T10:00:01.000Z", "replayed");
    const snapshotTail = envelope("2026-07-29T10:00:03.000Z", "snapshot tail");
    const live = envelope("2026-07-29T10:00:04.000Z", "live");

    expect(mergeAgentChatHistorySnapshot(
      [snapshotTail],
      [replayed, live],
    )).toEqual([snapshotTail, live]);
  });

  it("preserves non-duplicate paged rows before the first overlap", () => {
    const older = envelope("2026-07-29T10:00:00.000Z", "older");
    const tailFirst = envelope("2026-07-29T10:00:01.000Z", "tail first");
    const tailLast = envelope("2026-07-29T10:00:02.000Z", "tail last");
    const parsedFirst = envelope("2026-07-29T10:00:01.000Z", "tail first");
    const parsedLast = envelope("2026-07-29T10:00:02.000Z", "tail last");

    const merged = mergeAgentChatHistorySnapshot(
      [parsedFirst, parsedLast],
      [older, tailFirst, tailLast],
    );

    expect(merged).toEqual([older, tailFirst, tailLast]);
    expect(merged[0]).toBe(older);
    expect(merged[1]).toBe(tailFirst);
    expect(merged[2]).toBe(tailLast);
  });

  it("excludes old replay after a matched tail while retaining valid live rows", () => {
    const older = envelope("2026-07-29T10:00:00.000Z", "older");
    const tail = envelope("2026-07-29T10:00:03.000Z", "tail");
    const replayed = envelope("2026-07-29T10:00:01.000Z", "replayed");
    const sameTimeLive = envelope("2026-07-29T10:00:03.000Z", "same-time live");
    const laterLive = envelope("2026-07-29T10:00:04.000Z", "later live");
    const existing = [older, tail, replayed, sameTimeLive, laterLive];
    const arrivalWatermark = captureAgentChatHistoryArrivalWatermark(existing);

    const merged = mergeAgentChatHistorySnapshot(
      [{ ...tail }],
      existing,
      { arrivalWatermark },
    );

    expect(merged).toEqual([older, tail, sameTimeLive, laterLive]);
    expect(merged[0]).toBe(older);
    expect(merged[1]).toBe(tail);
    expect(merged[2]).toBe(sameTimeLive);
    expect(merged[3]).toBe(laterLive);
  });

  it("preserves an in-flight delayed event that sorts inside the snapshot range", () => {
    const prompt = envelope("2026-07-29T10:00:00.000Z", "prompt");
    const done = envelope("2026-07-29T10:00:03.000Z", "done");
    const arrivalWatermark = captureAgentChatHistoryArrivalWatermark([prompt, done]);
    const delayedLive = envelope("2026-07-29T10:00:01.000Z", "delayed live");
    const existing = mergeAgentChatLiveEvents([prompt, done], [delayedLive]);

    const merged = mergeAgentChatHistorySnapshot(
      [{ ...prompt }, { ...done }],
      existing,
      { arrivalWatermark },
    );

    expect(merged).toBe(existing);
    expect(merged).toEqual([prompt, delayedLive, done]);
  });
});
