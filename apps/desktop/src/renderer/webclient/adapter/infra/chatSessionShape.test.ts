import { describe, expect, it } from "vitest";
import { chatSessionFromRemoteSummary } from "./chatSessionShape";

describe("chatSessionFromRemoteSummary", () => {
  it("translates the host's sessionId/startedAt into the id/createdAt callers read", () => {
    // This is the exact host payload shape (`summarizeChatSessionForRemote`).
    // Passing it through untranslated left `id` undefined, and the draft launch
    // then dispatched chat.send with no session — the host's
    // "chat.send requires sessionId." rejection.
    const session = chatSessionFromRemoteSummary({
      sessionId: "chat-123",
      laneId: "lane-1",
      provider: "claude",
      model: "opus",
      startedAt: "2026-08-03T00:00:00.000Z",
    });
    expect(session.id).toBe("chat-123");
    expect(session.createdAt).toBe("2026-08-03T00:00:00.000Z");
    expect(session.laneId).toBe("lane-1");
    expect((session as unknown as { sessionId?: string }).sessionId).toBeUndefined();
  });

  it("keeps an already-translated session unchanged", () => {
    const session = chatSessionFromRemoteSummary({ id: "chat-9", createdAt: "2026-01-01T00:00:00.000Z" });
    expect(session.id).toBe("chat-9");
    expect(session.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });
});
