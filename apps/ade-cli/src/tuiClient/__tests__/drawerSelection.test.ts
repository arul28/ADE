import { describe, expect, it } from "vitest";
import type { AgentChatSessionSummary } from "../../../../desktop/src/shared/types/chat";
import { resolveDrawerChatSelection } from "../drawerSelection";

function session(sessionId: string, laneId = "lane-1"): AgentChatSessionSummary {
  return {
    sessionId,
    laneId,
    provider: "codex",
    model: "gpt-5.5",
    status: "idle",
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: null,
    lastActivityAt: "2026-01-01T00:00:00.000Z",
    lastOutputPreview: null,
    summary: null,
  };
}

describe("resolveDrawerChatSelection", () => {
  it("does not snap a manually selected chat back to the draft new-chat row", () => {
    expect(resolveDrawerChatSelection({
      activeLaneId: "lane-1",
      activeSessionId: null,
      draftChatActive: true,
      drawerLaneId: "lane-1",
      drawerVisibleLaneSessions: [session("chat-1"), session("chat-2")],
      selectedDrawerChatAction: null,
      selectedDrawerChatId: "chat-2",
    })).toBeNull();
  });

  it("selects the new-chat row for a draft only when no valid chat row is selected", () => {
    expect(resolveDrawerChatSelection({
      activeLaneId: "lane-1",
      activeSessionId: null,
      draftChatActive: true,
      drawerLaneId: "lane-1",
      drawerVisibleLaneSessions: [session("chat-1")],
      selectedDrawerChatAction: null,
      selectedDrawerChatId: null,
    })).toEqual({
      selectedDrawerChatId: null,
      selectedDrawerChatAction: "new-chat",
    });
  });
});
