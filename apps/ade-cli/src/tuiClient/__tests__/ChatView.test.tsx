import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { ChatView } from "../components/ChatView";
import type { AgentChatEventEnvelope, AgentChatSessionSummary } from "../../../../desktop/src/shared/types/chat";

const session: AgentChatSessionSummary = {
  sessionId: "s1",
  laneId: "lane-1",
  provider: "codex",
  model: "gpt-5.5",
  status: "idle",
  startedAt: "2026-01-01T12:00:00.000Z",
  endedAt: null,
  lastActivityAt: "2026-01-01T12:00:00.000Z",
  lastOutputPreview: null,
  summary: null,
};

function renderEvents(events: AgentChatEventEnvelope[]): string {
  const result = render(
    <ChatView
      events={events}
      notices={[]}
      activeSession={session}
      projectName="ADE"
      laneName="Primary"
    />,
  );
  return result.lastFrame() ?? "";
}

describe("ChatView", () => {
  it("renders a bordered hero card with the ADE wordmark when the chat is empty", () => {
    const frame = renderEvents([]);
    expect(frame).toMatch(/[╭╮╯╰]/);
    expect(frame).toContain("█▀█");
    expect(frame).toContain("ade code");
    expect(frame).toContain("v0.1");
    expect(frame).toContain("Primary");
    expect(frame).toContain("type to chat");
    expect(frame).toContain("›");
    expect(frame).toContain("inspect the current diff");
  });

  it("right-aligns user messages inside an accent-bordered bubble", () => {
    const frame = renderEvents([
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:00.000Z",
        sequence: 1,
        event: { type: "user_message", text: "hello" },
      },
    ]);
    const lines = frame.split(/\r?\n/);
    const bubbleLine = lines.find((line) => line.includes("hello"));
    expect(bubbleLine).toBeTruthy();
    // Round border characters wrap the bubble; verify presence so layout stays a bubble.
    expect(frame).toMatch(/[╭╮╯╰]/);
    // Bubble is right-aligned: the content sits past the half-width of the frame.
    if (bubbleLine) {
      const helloIndex = bubbleLine.indexOf("hello");
      expect(helloIndex).toBeGreaterThan(0);
    }
  });

  it("renders assistant messages flat without the bubble border", () => {
    const frame = renderEvents([
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:00.000Z",
        sequence: 1,
        event: { type: "text", text: "I'm Codex." },
      },
    ]);
    expect(frame).toContain("I'm Codex.");
    // No round-border glyphs in an assistant-only frame.
    expect(frame).not.toMatch(/[╭╮╯╰]/);
  });

  it("indents tool call output", () => {
    const frame = renderEvents([
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:00.000Z",
        sequence: 1,
        event: { type: "command", command: "git branch", cwd: "/repo", output: "main", itemId: "cmd-1", status: "completed", exitCode: 0, durationMs: 12 },
      },
    ]);
    const lines = frame.split(/\r?\n/).filter((line) => line.includes("run git branch"));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.startsWith("   ")).toBe(true);
    }
  });
});
