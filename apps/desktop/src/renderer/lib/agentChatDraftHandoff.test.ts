/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
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

  it("drops stale handoffs", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-27T12:00:00.000Z"));
    queueAgentChatDraftHandoff({ sessionId: "chat-1" }, "Old failure");
    vi.advanceTimersByTime(30_001);
    expect(takeAgentChatDraftHandoff({ sessionId: "chat-1" })).toBeNull();
  });
});
