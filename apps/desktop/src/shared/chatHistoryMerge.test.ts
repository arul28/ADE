import { describe, expect, it } from "vitest";

import type { AgentChatEventEnvelope } from "./types/chat";
import {
  agentChatEventIdentityKey,
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
});
