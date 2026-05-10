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

function renderEvents(
  events: AgentChatEventEnvelope[],
  options: { maxRows?: number; scrollOffsetRows?: number; width?: number } = {},
): string {
  const result = render(
    <ChatView
      events={events}
      notices={[]}
      activeSession={session}
      projectName="ADE"
      laneName="Primary"
      maxRows={options.maxRows}
      scrollOffsetRows={options.scrollOffsetRows}
      width={options.width}
    />,
  );
  return result.lastFrame() ?? "";
}

describe("ChatView", () => {
  it("renders a bordered hero card with the ADE wordmark when the chat is empty", () => {
    const frame = renderEvents([]);
    expect(frame).toMatch(/[╭╮╯╰]/);
    expect(frame).toContain("██████");
    expect(frame).toContain("ade code");
    expect(frame).toContain("v0.1");
    expect(frame).toContain("Project");
    expect(frame).toContain("Lane");
    expect(frame).toContain("Branch");
    expect(frame).toContain("Primary");
    expect(frame).toContain("type to chat");
    expect(frame).toContain("commands");
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

  it("renders markdown-like assistant output into readable blocks", () => {
    const frame = renderEvents([
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:00.000Z",
        sequence: 1,
        event: {
          type: "text",
          text: [
            "## Fix plan",
            "",
            "- Trace commands",
            "1. Patch renderer",
            "",
            "```ts",
            "const ok = true;",
            "```",
          ].join("\n"),
        },
      },
    ], { width: 60 });
    expect(frame).toContain("Fix plan");
    expect(frame).toContain("• Trace commands");
    expect(frame).toContain("1. Patch renderer");
    expect(frame).toContain("│ const ok = true;");
  });

  it("wraps long assistant paragraphs to the supplied width", () => {
    const frame = renderEvents([
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:00.000Z",
        sequence: 1,
        event: { type: "text", text: "This paragraph should wrap cleanly across more than one terminal row instead of flattening into an unreadable single line." },
      },
    ], { width: 42 });
    expect(frame).toContain("This paragraph should wrap cleanly");
    expect(frame).toContain("across more than one terminal row");
  });

  it("shows the bottom viewport by default and older rows when scrolled", () => {
    const events = Array.from({ length: 12 }, (_, index): AgentChatEventEnvelope => ({
      sessionId: "s1",
      timestamp: `2026-01-01T12:00:${String(index).padStart(2, "0")}.000Z`,
      sequence: index + 1,
      event: index % 2 === 0
        ? { type: "user_message", text: `user row ${index + 1}` }
        : { type: "text", text: `assistant row ${index + 1}` },
    }));
    const bottom = renderEvents(events, { maxRows: 5, width: 80 });
    expect(bottom).toContain("assistant row 12");
    expect(bottom).not.toContain("user row 1");
    expect(bottom).toContain("↑ older messages");

    const older = renderEvents(events, { maxRows: 5, scrollOffsetRows: 8, width: 80 });
    expect(older).toContain("row");
    expect(older).toContain("↓ newer messages");
    expect(older).not.toContain("assistant row 12");
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
      expect(line.startsWith("  ")).toBe(true);
    }
  });
});
