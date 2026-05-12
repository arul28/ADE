import { describe, expect, it } from "vitest";
import type { AgentChatEventEnvelope } from "../../../../desktop/src/shared/types/chat";
import { tuiEventDedupKey } from "../eventDedup";

describe("tuiEventDedupKey", () => {
  it("uses sequence when present", () => {
    const event = {
      sessionId: "session-1",
      sequence: 42,
      timestamp: "2026-01-01T00:00:00.000Z",
      event: { type: "text", text: "hello" },
    } as AgentChatEventEnvelope;

    expect(tuiEventDedupKey(event)).toBe("seq:42");
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
});
