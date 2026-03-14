import { describe, expect, it } from "vitest";
import type { AgentChatEventEnvelope } from "../../shared/types";
import { shouldRefreshSessionListForChatEvent } from "./chatSessionEvents";

function makeEnvelope(event: AgentChatEventEnvelope["event"]): AgentChatEventEnvelope {
  return {
    sessionId: "session-1",
    timestamp: new Date().toISOString(),
    event,
  };
}

describe("shouldRefreshSessionListForChatEvent", () => {
  it("refreshes on turn completion", () => {
    expect(shouldRefreshSessionListForChatEvent(makeEnvelope({ type: "done", turnId: "turn-1", status: "completed" }))).toBe(true);
  });

  it("refreshes on chat errors", () => {
    expect(shouldRefreshSessionListForChatEvent(makeEnvelope({ type: "error", message: "boom" }))).toBe(true);
  });

  it("ignores noisy intermediate events", () => {
    expect(shouldRefreshSessionListForChatEvent(makeEnvelope({ type: "status", turnStatus: "completed" }))).toBe(false);
    expect(shouldRefreshSessionListForChatEvent(makeEnvelope({ type: "text", text: "hello" }))).toBe(false);
    expect(shouldRefreshSessionListForChatEvent(makeEnvelope({ type: "user_message", text: "hi" }))).toBe(false);
  });
});
