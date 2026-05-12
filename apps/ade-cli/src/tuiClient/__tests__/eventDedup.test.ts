import { describe, expect, it } from "vitest";
import type { AgentChatEventEnvelope } from "../../../../desktop/src/shared/types/chat";
import {
  appendReservedTuiEvent,
  reserveTuiEventDedupKey,
  syncTuiEventDedupKeys,
  tuiEventDedupKey,
} from "../eventDedup";

describe("tuiEventDedupKey", () => {
  it("uses sequence when present", () => {
    const event = {
      sessionId: "session-1",
      sequence: 42,
      timestamp: "2026-01-01T00:00:00.000Z",
      event: { type: "text", text: "hello" },
    } as AgentChatEventEnvelope;

    expect(tuiEventDedupKey(event)).toContain("seq:42");
  });

  it("keeps same-millisecond payload variants distinct when sequence is absent", () => {
    const base = {
      sessionId: "session-1",
      timestamp: "2026-01-01T00:00:00.000Z",
    };
    const first = {
      ...base,
      event: { type: "text", text: "hel" },
    } as AgentChatEventEnvelope;
    const second = {
      ...base,
      event: { type: "text", text: "lo" },
    } as AgentChatEventEnvelope;

    expect(tuiEventDedupKey(first)).not.toBe(tuiEventDedupKey(second));
  });

  it("keeps rebuilt events distinct when sequence restarts", () => {
    const first = {
      sessionId: "session-1",
      sequence: 1,
      timestamp: "2026-01-01T00:00:00.000Z",
      event: { type: "text", text: "old" },
    } as AgentChatEventEnvelope;
    const rebuilt = {
      sessionId: "session-1",
      sequence: 1,
      timestamp: "2026-01-01T00:00:01.000Z",
      event: { type: "text", text: "new" },
    } as AgentChatEventEnvelope;

    expect(tuiEventDedupKey(first)).not.toBe(tuiEventDedupKey(rebuilt));
  });

  it("dedupes exact fallback event replays", () => {
    const first = {
      sessionId: "session-1",
      timestamp: "2026-01-01T00:00:00.000Z",
      event: { type: "text", text: "hello" },
    } as AgentChatEventEnvelope;
    const replay = {
      sessionId: "session-1",
      timestamp: "2026-01-01T00:00:00.000Z",
      event: { type: "text", text: "hello" },
    } as AgentChatEventEnvelope;

    expect(tuiEventDedupKey(first)).toBe(tuiEventDedupKey(replay));
  });

  it("appends using cached keys without re-stringifying previous events", () => {
    const previous = {
      sessionId: "session-1",
      sequence: 1,
      timestamp: "2026-01-01T00:00:00.000Z",
      event: {
        type: "text",
        text: "old",
        toJSON() {
          throw new Error("previous event should not be stringified again");
        },
      },
    } as unknown as AgentChatEventEnvelope;
    const incoming = {
      sessionId: "session-1",
      sequence: 2,
      timestamp: "2026-01-01T00:00:01.000Z",
      event: { type: "text", text: "new" },
    } as AgentChatEventEnvelope;
    const keys = new Set<string>(["precomputed-previous-key"]);

    const key = reserveTuiEventDedupKey(incoming, keys);
    expect(key).not.toBeNull();
    const next = appendReservedTuiEvent([previous], incoming, keys);

    expect(next).toEqual([previous, incoming]);
    expect(keys.has(tuiEventDedupKey(incoming))).toBe(true);
  });

  it("uses cached keys to reject replays", () => {
    const first = {
      sessionId: "session-1",
      timestamp: "2026-01-01T00:00:00.000Z",
      event: { type: "text", text: "hello" },
    } as AgentChatEventEnvelope;
    const keys = new Set<string>();
    syncTuiEventDedupKeys(keys, [first]);

    expect(reserveTuiEventDedupKey(first, keys)).toBeNull();
  });
});
