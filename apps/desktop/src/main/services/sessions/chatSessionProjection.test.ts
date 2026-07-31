import { describe, expect, it } from "vitest";
import type { AgentChatSessionSummary, TerminalSessionSummary } from "../../../shared/types";
import { projectChatOntoSession } from "./chatSessionProjection";

function session(): TerminalSessionSummary {
  return {
    id: "chat-1",
    laneId: "lane-1",
    laneName: "Planning state",
    ptyId: null,
    tracked: true,
    pinned: false,
    goal: null,
    toolType: "codex-chat",
    title: "Planning state",
    status: "running",
    startedAt: "2026-08-01T10:00:00.000Z",
    endedAt: null,
    exitCode: null,
    transcriptPath: "/tmp/chat-1.jsonl",
    headShaStart: null,
    headShaEnd: null,
    lastOutputPreview: null,
    summary: null,
    runtimeState: "idle",
    resumeCommand: null,
  };
}

function chat(overrides: Partial<AgentChatSessionSummary> = {}): AgentChatSessionSummary {
  return {
    sessionId: "chat-1",
    laneId: "lane-1",
    provider: "codex",
    model: "openai/gpt-5.6-sol",
    status: "idle",
    startedAt: "2026-08-01T10:00:00.000Z",
    endedAt: null,
    lastActivityAt: "2026-08-01T10:01:00.000Z",
    lastOutputPreview: null,
    summary: null,
    nextWakeAt: null,
    ...overrides,
  };
}

describe("chatSessionProjection", () => {
  it("projects current plan mode without changing idle chat lifecycle", () => {
    const projected = projectChatOntoSession(session(), chat({
      interactionMode: "plan",
      permissionMode: "plan",
    }));

    expect(projected.chatActivityMode).toBe("planning");
    expect(projected.runtimeState).toBe("idle");
    expect(projected.activeBackgroundTaskCount).toBe(0);
  });

  it("projects authoritative background count and the next armed wake", () => {
    const projected = projectChatOntoSession(session(), chat({
      activeBackgroundTaskCount: 2,
      nextWakeAt: "2026-08-01T12:00:00.000Z",
    }));

    expect(projected.activeBackgroundTaskCount).toBe(2);
    expect(projected.nextWakeAt).toBe("2026-08-01T12:00:00.000Z");
    expect(projected.runtimeState).toBe("idle");
  });

  it("clears stale presentation metadata when the chat reports normal mode and no tasks", () => {
    const projected = projectChatOntoSession({
      ...session(),
      chatActivityMode: "planning",
      activeBackgroundTaskCount: 3,
    }, chat({
      interactionMode: "default",
      permissionMode: "default",
      activeBackgroundTaskCount: 0,
    }));

    expect(projected.chatActivityMode).toBeNull();
    expect(projected.activeBackgroundTaskCount).toBe(0);
    expect(projected.nextWakeAt).toBeNull();
  });

  it("does not mistake a read-only legacy permission projection for plan interaction mode", () => {
    const projected = projectChatOntoSession(session(), chat({
      interactionMode: "default",
      permissionMode: "plan",
    }));

    expect(projected.chatActivityMode).toBeNull();
    expect(projected.runtimeState).toBe("idle");
    expect(projected.activeBackgroundTaskCount).toBe(0);
  });
});
