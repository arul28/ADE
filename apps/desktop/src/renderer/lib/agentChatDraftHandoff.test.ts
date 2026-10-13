/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  QUOTE_HANDOFF_MAX_AGE_MS,
  clearAgentChatDraftHandoffsForTest,
  queueAgentChatDraftHandoff,
  takeAgentChatDraftHandoff,
} from "./agentChatDraftHandoff";

afterEach(() => {
  clearAgentChatDraftHandoffsForTest();
  vi.useRealTimers();
});

describe("agent chat draft handoff", () => {
  it("dispatches immediately and remains available for the destination mount", () => {
    const listener = vi.fn();
    window.addEventListener("ade:agent-chat:insert-draft", listener);
    try {
      queueAgentChatDraftHandoff({ sessionId: "chat-1" }, "Fix this failure");
      expect(listener).toHaveBeenCalledTimes(1);
      expect((listener.mock.calls[0]![0] as CustomEvent).detail).toEqual({
        sessionId: "chat-1",
        text: "Fix this failure",
      });
      expect(takeAgentChatDraftHandoff({ sessionId: "chat-1" })).toBe("Fix this failure");
      expect(takeAgentChatDraftHandoff({ sessionId: "chat-1" })).toBeNull();
    } finally {
      window.removeEventListener("ade:agent-chat:insert-draft", listener);
    }
  });

  it("does not deliver a handoff to the wrong composer", () => {
    queueAgentChatDraftHandoff({ draftTargetId: "work:draft:lane-1:chat" }, "Use the log");
    expect(takeAgentChatDraftHandoff({ draftTargetId: "work:draft:lane-2:chat" })).toBeNull();
    expect(takeAgentChatDraftHandoff({ draftTargetId: "work:draft:lane-1:chat" })).toBe("Use the log");
  });

  it("collects quotes for a chat that is not on screen, and keeps them longer than a prompt", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-27T12:00:00.000Z"));
    queueAgentChatDraftHandoff({ sessionId: "chat-1" }, "first quote", { collect: true });
    vi.advanceTimersByTime(5 * 60_000);
    queueAgentChatDraftHandoff({ sessionId: "chat-1" }, "second quote", { collect: true });
    queueAgentChatDraftHandoff({ sessionId: "chat-2" }, "another chat", { collect: true });
    // The reader opens the chat minutes later: both quotes are there, in order.
    vi.advanceTimersByTime(QUOTE_HANDOFF_MAX_AGE_MS - 1);
    expect(takeAgentChatDraftHandoff({ sessionId: "chat-1" })).toBe("first quote\n\nsecond quote");
    expect(takeAgentChatDraftHandoff({ sessionId: "chat-1" })).toBeNull();
    vi.advanceTimersByTime(2);
    expect(takeAgentChatDraftHandoff({ sessionId: "chat-2" })).toBeNull();

    // A prompt replaces what waits; it is one instruction, not a collection.
    queueAgentChatDraftHandoff({ sessionId: "chat-3" }, "quote", { collect: true });
    queueAgentChatDraftHandoff({ sessionId: "chat-3" }, "Fix the checks");
    expect(takeAgentChatDraftHandoff({ sessionId: "chat-3" })).toBe("Fix the checks");
  });

  it("drops stale handoffs", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-27T12:00:00.000Z"));
    queueAgentChatDraftHandoff({ sessionId: "chat-1" }, "Old failure");
    vi.advanceTimersByTime(30_001);
    expect(takeAgentChatDraftHandoff({ sessionId: "chat-1" })).toBeNull();
  });
});
