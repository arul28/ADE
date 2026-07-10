import { describe, expect, it } from "vitest";
import type { AgentChatSessionSummary } from "../../../../desktop/src/shared/types/chat";
import { chatSelectionCopyText, resolveDrawerChatSelection } from "../drawerSelection";

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
    nextWakeAt: null,
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

  it("keeps the selected new-chat row while the draft is active", () => {
    expect(resolveDrawerChatSelection({
      activeLaneId: "lane-1",
      activeSessionId: null,
      draftChatActive: true,
      drawerLaneId: "lane-1",
      drawerVisibleLaneSessions: [session("chat-1")],
      selectedDrawerChatAction: "new-chat",
      selectedDrawerChatId: null,
    })).toBeNull();
  });

  it("keeps the selected new-chat row as a preview before a draft starts", () => {
    expect(resolveDrawerChatSelection({
      activeLaneId: "lane-1",
      activeSessionId: null,
      draftChatActive: false,
      drawerLaneId: "lane-1",
      drawerVisibleLaneSessions: [session("chat-1")],
      selectedDrawerChatAction: "new-chat",
      selectedDrawerChatId: null,
    })).toBeNull();
  });

  it("snaps stale new-chat selection back to the active visible chat", () => {
    expect(resolveDrawerChatSelection({
      activeLaneId: "lane-1",
      activeSessionId: "chat-2",
      draftChatActive: false,
      drawerLaneId: "lane-1",
      drawerVisibleLaneSessions: [session("chat-1"), session("chat-2")],
      selectedDrawerChatAction: "new-chat",
      selectedDrawerChatId: "deleted-chat",
    })).toEqual({
      selectedDrawerChatId: "chat-2",
      selectedDrawerChatAction: null,
    });
  });
});

describe("chatSelectionCopyText", () => {
  it("copies the highlighted drawer chat label when no text selection exists", () => {
    expect(chatSelectionCopyText({
      drawerSection: "chats",
      displaySessions: [
        { ...session("chat-1"), title: "Refactor auth flow" },
        { ...session("chat-2"), title: "  " },
      ],
      selectedDrawerChatAction: null,
      selectedDrawerChatId: "chat-1",
    })).toBe("Refactor auth flow");
  });

  it("falls back to the chat id when the highlighted chat has no title", () => {
    expect(chatSelectionCopyText({
      drawerSection: "chats",
      displaySessions: [session("chat-2")],
      selectedDrawerChatAction: null,
      selectedDrawerChatId: "chat-2",
    })).toBe("chat-2");
  });

  it("ignores the new-chat row and non-chat drawer sections", () => {
    expect(chatSelectionCopyText({
      drawerSection: "chats",
      displaySessions: [session("chat-1")],
      selectedDrawerChatAction: "new-chat",
      selectedDrawerChatId: null,
    })).toBeNull();
    expect(chatSelectionCopyText({
      drawerSection: "lanes",
      displaySessions: [session("chat-1")],
      selectedDrawerChatAction: null,
      selectedDrawerChatId: "chat-1",
    })).toBeNull();
  });
});
