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
    const previousKey = "precomputed-previous-key";
    const keys = new Set<string>([previousKey]);

    const key = reserveTuiEventDedupKey(incoming, keys);
    expect(key).not.toBeNull();
    const next = appendReservedTuiEvent([previous], incoming, keys, [previousKey], key!);

    expect(next.events).toEqual([previous, incoming]);
    expect(next.eventKeys).toEqual([previousKey, key]);
    expect(keys.has(key!)).toBe(true);
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

  it("keeps pending reserved keys when trimming old events", () => {
    const oldFirst = {
      sessionId: "session-1",
      sequence: 1,
      timestamp: "2026-01-01T00:00:00.000Z",
      event: { type: "text", text: "old first" },
    } as AgentChatEventEnvelope;
    const oldSecond = {
      sessionId: "session-1",
      sequence: 2,
      timestamp: "2026-01-01T00:00:01.000Z",
      event: { type: "text", text: "old second" },
    } as AgentChatEventEnvelope;
    const incomingFirst = {
      sessionId: "session-1",
      sequence: 3,
      timestamp: "2026-01-01T00:00:02.000Z",
      event: { type: "text", text: "new first" },
    } as AgentChatEventEnvelope;
    const incomingSecond = {
      sessionId: "session-1",
      sequence: 4,
      timestamp: "2026-01-01T00:00:03.000Z",
      event: { type: "text", text: "new second" },
    } as AgentChatEventEnvelope;
    const keys = new Set<string>();
    const oldKeys = syncTuiEventDedupKeys(keys, [oldFirst, oldSecond]);

    const firstKey = reserveTuiEventDedupKey(incomingFirst, keys);
    const secondKey = reserveTuiEventDedupKey(incomingSecond, keys);
    expect(firstKey).not.toBeNull();
    expect(secondKey).not.toBeNull();

    const afterFirstAppend = appendReservedTuiEvent([oldFirst, oldSecond], incomingFirst, keys, oldKeys, firstKey!, 2);

    expect(afterFirstAppend.events).toEqual([oldSecond, incomingFirst]);
    expect(keys.has(oldKeys[0]!)).toBe(false);
    expect(keys.has(secondKey!)).toBe(true);
    expect(reserveTuiEventDedupKey(incomingSecond, keys)).toBeNull();

    const afterSecondAppend = appendReservedTuiEvent(
      afterFirstAppend.events,
      incomingSecond,
      keys,
      afterFirstAppend.eventKeys,
      secondKey!,
      2,
    );

    expect(afterSecondAppend.events).toEqual([incomingFirst, incomingSecond]);
    expect(keys.has(oldKeys[1]!)).toBe(false);
    expect(keys.has(firstKey!)).toBe(true);
    expect(keys.has(secondKey!)).toBe(true);
  });

  it("evicts cached keys without re-stringifying trimmed events", () => {
    const oldFirst = {
      sessionId: "session-1",
      sequence: 1,
      timestamp: "2026-01-01T00:00:00.000Z",
      event: {
        type: "text",
        text: "old first",
        toJSON() {
          return { type: "text", text: "old first" };
        },
      },
    } as unknown as AgentChatEventEnvelope;
    const oldSecond = {
      sessionId: "session-1",
      sequence: 2,
      timestamp: "2026-01-01T00:00:01.000Z",
      event: { type: "text", text: "old second" },
    } as AgentChatEventEnvelope;
    const incoming = {
      sessionId: "session-1",
      sequence: 3,
      timestamp: "2026-01-01T00:00:02.000Z",
      event: { type: "text", text: "new" },
    } as AgentChatEventEnvelope;
    const keys = new Set<string>();
    const oldKeys = syncTuiEventDedupKeys(keys, [oldFirst, oldSecond]);
    (oldFirst.event as { toJSON?: () => unknown }).toJSON = () => {
      throw new Error("trimmed event should not be stringified again");
    };

    const incomingKey = reserveTuiEventDedupKey(incoming, keys);
    expect(incomingKey).not.toBeNull();
    const next = appendReservedTuiEvent([oldFirst, oldSecond], incoming, keys, oldKeys, incomingKey!, 2);

    expect(next.events).toEqual([oldSecond, incoming]);
    expect(keys.has(oldKeys[0]!)).toBe(false);
  });
});
