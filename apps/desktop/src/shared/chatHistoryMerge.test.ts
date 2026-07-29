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
