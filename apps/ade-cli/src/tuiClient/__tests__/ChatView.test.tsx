import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import {
  ChatView,
  chatScrollMaxOffsetFromSelectableRows,
  computeChatScrollMaxOffset,
  renderChatSelectableRows,
  renderChatSelectableRowTexts,
  renderChatSelectableRowTextsFromRows,
  renderChatTranscriptPlainText,
  renderChatVisibleSelectionRows,
  renderChatVisibleSelectionRowsFromRows,
  selectedTextFromChatRows,
  workGroupExpandKey,
} from "../components/ChatView";
import { aggregateChatBlocks } from "../aggregate";
import { chatEventLineId } from "../format";
import { buildSubagentTranscriptEvents } from "../subagentPane";
import {
  parseAssistantMarkdown,
  parseInlineRuns,
  type AssistantMarkdownBlock,
} from "../format";
import type { AdeCodeProvider } from "../types";
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

function stripAnsi(value: string): string {
  return value.replace(/\[[0-9;]*m/g, "");
}

// Tool-call / file-change groups collapse to a single header row by default.
// Tests that assert per-entry rendering (every call/file, glyphs, durations,
// badges) pass `expanded: true` to open every work group.
function expandAllWorkGroups(
  events: AgentChatEventEnvelope[],
  activeSession: AgentChatSessionSummary | null,
): Set<string> {
  const blocks = aggregateChatBlocks({ events, notices: [], activeSession });
  const ids = new Set<string>();
  for (const block of blocks) {
    if (block.kind === "tool-calls-group" || block.kind === "files-changed-group") {
      ids.add(workGroupExpandKey(block.id));
    }
  }
  return ids;
}

function renderEvents(
  events: AgentChatEventEnvelope[],
  options: { maxRows?: number; scrollOffsetRows?: number; width?: number; streaming?: boolean; interrupted?: boolean; provider?: AdeCodeProvider; olderHistory?: "loading" | "available" | "exhausted" | null; expanded?: boolean } = {},
): string {
  const provider = options.provider ?? "codex";
  const activeSession = { ...session, provider };
  const result = render(
    <ChatView
      events={events}
      notices={[]}
      activeSession={activeSession}
      projectName="ADE"
      laneName="Primary"
      provider={provider}
      streaming={options.streaming}
      interrupted={options.interrupted}
      maxRows={options.maxRows}
      scrollOffsetRows={options.scrollOffsetRows}
      olderHistory={options.olderHistory}
      width={options.width}
      expandedLineIds={options.expanded ? expandAllWorkGroups(events, activeSession) : undefined}
    />,
  );
  return stripAnsi(result.lastFrame() ?? "");
}

function transcriptLines(frame: string): string[] {
  return frame.split(/\r?\n/);
}

describe("ChatView", () => {
  it("copies only the selected chat row columns", () => {
    expect(selectedTextFromChatRows(
      ["alpha bravo", "charlie delta", "echo"],
      { startRow: 0, startColumn: 6, endRow: 1, endColumn: 6 },
    )).toBe("bravo\ncharlie");
  });

  it("preserves selected leading and trailing whitespace", () => {
    expect(selectedTextFromChatRows(
      ["  const value = 1;  ", "    return value;  "],
      { startRow: 0, startColumn: 0, endRow: 1, endColumn: 19 },
    )).toBe("  const value = 1;  \n    return value;  ");
  });

  it("selects CJK and emoji by terminal display cells", () => {
    expect(selectedTextFromChatRows(
      ["a界b"],
      { startRow: 0, startColumn: 1, endRow: 0, endColumn: 2 },
    )).toBe("界");

    expect(selectedTextFromChatRows(
      ["a🙂b"],
      { startRow: 0, startColumn: 1, endRow: 0, endColumn: 2 },
    )).toBe("🙂");
  });

  it("copies selected absolute transcript rows outside the visible viewport", () => {
    const events = Array.from({ length: 12 }, (_, index): AgentChatEventEnvelope => ({
      sessionId: "s1",
      timestamp: `2026-01-01T12:00:${String(index).padStart(2, "0")}.000Z`,
      sequence: index + 1,
      event: { type: "text", text: `selectable row ${index + 1}` },
    }));
    const rows = renderChatSelectableRowTexts({
      events,
      notices: [],
      activeSession: session,
      width: 80,
    });

    expect(rows.join("\n")).toContain("selectable row 1");
    expect(rows.join("\n")).toContain("selectable row 12");
    expect(selectedTextFromChatRows(rows, { startRow: 0, startColumn: 0, endRow: rows.length - 1, endColumn: 200 }))
      .toContain("selectable row 12");
  });

  it("derives scroll and selection data from one selectable row pass", () => {
    const events = Array.from({ length: 8 }, (_, index): AgentChatEventEnvelope => ({
      sessionId: "s1",
      timestamp: `2026-01-01T12:00:${String(index).padStart(2, "0")}.000Z`,
      sequence: index + 1,
      event: {
        type: index % 2 === 0 ? "user_message" : "text",
        text: `single pass row ${index + 1}`,
      },
    }));
    const blocks = aggregateChatBlocks({ events, notices: [], activeSession: session });
    const selectableRows = renderChatSelectableRows({
      blocks,
      width: 80,
      streaming: true,
      showWorkingIndicator: true,
    });

    expect(chatScrollMaxOffsetFromSelectableRows({ rows: selectableRows, maxRows: 5 })).toBe(
      computeChatScrollMaxOffset({
        blocks,
        events,
        notices: [],
        activeSession: session,
        maxRows: 5,
        width: 80,
        streaming: true,
        showWorkingIndicator: true,
      }),
    );
    expect(renderChatVisibleSelectionRowsFromRows({
      rows: selectableRows,
      maxRows: 5,
      scrollOffsetRows: 1,
      unseenMessageCount: 2,
    })).toEqual(renderChatVisibleSelectionRows({
      blocks,
      events,
      notices: [],
      activeSession: session,
      maxRows: 5,
      scrollOffsetRows: 1,
      unseenMessageCount: 2,
      width: 80,
      streaming: true,
      showWorkingIndicator: true,
    }));
    expect(renderChatSelectableRowTextsFromRows(selectableRows)).toEqual(renderChatSelectableRowTexts({
      blocks,
      events,
      notices: [],
      activeSession: session,
      width: 80,
      streaming: true,
      showWorkingIndicator: true,
    }));
  });

  it("renders a bordered hero card with the ADE wordmark when the chat is empty", () => {
    const frame = renderEvents([]);
    // Hero card uses a bordered box
    expect(frame).toMatch(/[╭╮╯╰┌┐└┘]/);
    expect(frame).toContain("AGENTIC DEVELOPMENT ENVIRONMENT");
    expect(frame).toContain("project");
    expect(frame).toContain("lane");
    expect(frame).toContain("branch");
    expect(frame).toContain("Primary");
    expect(frame).toContain("type");
    expect(frame).toContain("cmds");
  });

  it("uses a compact empty state inside multi-chat tiles", () => {
    const result = render(
      <ChatView
        events={[]}
        notices={[]}
        activeSession={session}
        projectName="ADE"
        laneName="Primary"
        maxRows={10}
        width={44}
        focused
      />,
    );
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toContain("No transcript yet.");
    expect(frame).not.toContain("AGENTIC DEVELOPMENT ENVIRONMENT");
  });

  it("does not invite chat input when the selected lane worktree is missing", () => {
    const result = render(
      <ChatView
        events={[]}
        notices={[]}
        activeSession={null}
        projectName="perf pass"
        laneName="ui audit lane 1"
        provider="codex"
        modelDisplay="GPT-5.5"
        worktreeAvailable={false}
        width={80}
      />,
    );
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toContain("worktree missing");
    expect(frame).toContain("restore lane before chat");
    expect(frame).not.toContain("type to chat");
  });

  it("shows a model working state before runtime events arrive", () => {
    const frame = renderEvents([
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:00.000Z",
        sequence: 1,
        event: { type: "user_message", text: "check status", turnId: "turn-active" },
      },
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:01.000Z",
        sequence: 2,
        event: { type: "status", turnStatus: "started", turnId: "turn-active" },
      },
    ], { streaming: true, width: 80 });

    expect(frame).toContain("check status");
    expect(frame).toContain("model working");
    expect(frame).not.toContain("waiting for runtime events");
  });

  it("shows the model working state after historical assistant output", () => {
    const events: AgentChatEventEnvelope[] = [
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:00.000Z",
        sequence: 1,
        event: { type: "user_message", text: "first turn", turnId: "turn-1" },
      },
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:01.000Z",
        sequence: 2,
        event: { type: "text", text: "first answer", turnId: "turn-1" },
      },
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:02.000Z",
        sequence: 3,
        event: { type: "done", status: "completed", turnId: "turn-1" },
      },
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:03.000Z",
        sequence: 4,
        event: { type: "user_message", text: "second turn", turnId: "turn-2" },
      },
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:04.000Z",
        sequence: 5,
        event: { type: "status", turnStatus: "started", turnId: "turn-2" },
      },
    ];
    const frame = renderEvents(events, { streaming: true, width: 80 });
    const maxOffset = computeChatScrollMaxOffset({
      events,
      notices: [],
      activeSession: session,
      streaming: true,
      maxRows: 3,
      width: 80,
    });

    expect(frame).toContain("first answer");
    expect(frame).toContain("second turn");
    expect(frame).toContain("model working");
    expect(frame).not.toContain("waiting for runtime events");
    expect(maxOffset).toBeGreaterThan(0);
  });

  it("keeps showing the model working indicator while active text is streaming", () => {
    const frame = renderEvents([
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:00.000Z",
        sequence: 1,
        event: { type: "text", text: "I found the issue.", turnId: "turn-active" },
      },
    ], { streaming: true, width: 80 });

    expect(frame).toContain("I found the issue.");
    expect(frame).toContain("model working");
    expect(frame).not.toContain("waiting for runtime events");
  });

  it("does not show the TUI model working indicator for Claude chat sessions", () => {
    const frame = renderEvents([
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:00.000Z",
        sequence: 1,
        event: { type: "user_message", text: "claude status", turnId: "turn-active" },
      },
    ], { streaming: true, width: 80, provider: "claude" });

    expect(frame).toContain("claude status");
    expect(frame).not.toContain("model working");
    expect(frame).not.toContain("waiting for runtime events");
  });

  it("shows interrupted state where the working indicator normally appears", () => {
    const frame = renderEvents([
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:00.000Z",
        sequence: 1,
        event: { type: "user_message", text: "stop this", turnId: "turn-active" },
      },
    ], { interrupted: true, width: 80 });

    expect(frame).toContain("stop this");
    expect(frame).toContain("Interrupted · chat to continue");
    expect(frame).not.toContain("model working");
    expect(frame).not.toContain("waiting for runtime events");
  });

  it("renders context compaction as an explicit active state", () => {
    const frame = renderEvents([
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:00.000Z",
        sequence: 1,
        event: { type: "codex_context_compaction", state: "started", trigger: "auto", turnId: "turn-active" },
      },
    ], { width: 80 });

    expect(frame.toLowerCase()).toContain("compacting context");
    expect(frame).not.toContain("model working");
    expect(frame).not.toContain("waiting for runtime events");
  });

  it("renders a generic context_compact begin (Claude/OpenCode) as an active state", () => {
    const frame = renderEvents([
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:00.000Z",
        sequence: 1,
        event: { type: "context_compact", state: "started", trigger: "auto", turnId: "turn-active" },
      },
    ], { width: 80 });

    expect(frame.toLowerCase()).toContain("compacting context");
    expect(frame).not.toContain("model working");
  });

  it("renders queued steer messages as staged instead of normal sent bubbles", () => {
    const frame = renderEvents([
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:00.000Z",
        sequence: 1,
        event: { type: "user_message", text: "follow this after the tool finishes", steerId: "steer-1", deliveryState: "queued", turnId: "turn-active" },
      },
    ], { width: 80 });

    expect(frame).toContain("staged message");
    expect(frame).toContain("sends after turn");
    expect(frame).toContain("follow this after the tool finishes");
    expect(frame).not.toMatch(/[╭╮╯╰]/);
  });

  it("removes staged steer rows once the steer is delivered", () => {
    const frame = renderEvents([
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:00.000Z",
        sequence: 1,
        event: { type: "user_message", text: "queued version", steerId: "steer-1", deliveryState: "queued", turnId: "turn-active" },
      },
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:01.000Z",
        sequence: 2,
        event: { type: "user_message", text: "delivered version", steerId: "steer-1", deliveryState: "delivered", turnId: "turn-active" },
      },
    ], { width: 80 });

    expect(frame).not.toContain("queued version");
    expect(frame).not.toContain("staged message");
    expect(frame).toContain("delivered version");
  });

  it("keeps steer lifecycle notices out of visible chat blocks", () => {
    const frame = renderEvents([
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:00.000Z",
        sequence: 1,
        event: { type: "user_message", text: "queued version", steerId: "steer-1", deliveryState: "queued", turnId: "turn-active" },
      },
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:00.500Z",
        sequence: 2,
        event: { type: "system_notice", steerId: "steer-1", message: "Message queued" } as never,
      },
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:01.000Z",
        sequence: 3,
        event: { type: "system_notice", steerId: "steer-1", message: "Delivering queued message" } as never,
      },
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:01.500Z",
        sequence: 4,
        event: { type: "system_notice", steerId: "steer-1", message: "Queued message cancelled" } as never,
      },
    ], { width: 80 });

    expect(frame).not.toContain("Message queued");
    expect(frame).not.toContain("Delivering queued message");
    expect(frame).not.toContain("Queued message cancelled");
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
    const borderLine = lines.find((line) => line.includes("╭"));
    expect(bubbleLine, "expected the rendered frame to include the user message").toBeDefined();
    // Round border characters wrap the bubble; verify presence so layout stays a bubble.
    expect(frame).toMatch(/[╭╮╯╰]/);
    expect(borderLine?.trim().length).toBeLessThan(24);
    // Bubble is right-aligned: a compact bubble still has left padding.
    const helloIndex = (bubbleLine ?? "").indexOf("hello");
    expect(helloIndex).toBeGreaterThan(0);
  });

  it("keeps a simple exchange quiet without message metadata or turn footer", () => {
    const turnId = "quiet-turn";
    const frame = renderEvents([
      { sessionId: "s1", timestamp: "2026-01-01T12:00:00.000Z", sequence: 1, event: { type: "user_message", text: "test message", turnId } },
      { sessionId: "s1", timestamp: "2026-01-01T12:00:01.000Z", sequence: 2, event: { type: "reasoning", text: "internal thought", turnId } },
      { sessionId: "s1", timestamp: "2026-01-01T12:00:01.500Z", sequence: 3, event: { type: "activity", activity: "thinking", detail: "Thinking through the answer", turnId } },
      { sessionId: "s1", timestamp: "2026-01-01T12:00:02.000Z", sequence: 4, event: { type: "text", text: "Got it.", turnId } },
      { sessionId: "s1", timestamp: "2026-01-01T12:00:03.000Z", sequence: 5, event: { type: "done", turnId, status: "completed", usage: { inputTokens: 40, outputTokens: 12 } } },
    ], { width: 80 });

    expect(frame).toContain("test message");
    expect(frame).toContain("Got it.");
    // Reasoning renders as a collapsed desktop-style "Thought" row with a
    // single-line preview — not as a full reasoning dump.
    expect(frame).toContain("Thought");
    expect(frame).toContain("internal thought");
    expect(frame).not.toContain("Thinking through the answer");
    expect(frame).not.toContain("Codex");
    expect(frame).not.toContain("gpt");
    expect(frame).not.toContain("tok");
    expect(frame).not.toContain("[status]");
    expect(frame).not.toContain("[done]");
  });

  it("keeps tool activity status out of the visible transcript", () => {
    const turnId = "tool-status-turn";
    const frame = renderChatTranscriptPlainText({
      events: [
        { sessionId: "s1", timestamp: "2026-01-01T12:00:00.000Z", sequence: 1, event: { type: "activity", activity: "tool_calling", detail: "Processing tool input", turnId } },
        { sessionId: "s1", timestamp: "2026-01-01T12:00:01.000Z", sequence: 2, event: { type: "tool_call", tool: "Grep", args: {}, itemId: "tool-1", turnId } },
        { sessionId: "s1", timestamp: "2026-01-01T12:00:02.000Z", sequence: 3, event: { type: "activity", activity: "reading", detail: "Read", turnId } },
        { sessionId: "s1", timestamp: "2026-01-01T12:00:03.000Z", sequence: 4, event: { type: "tool_call", tool: "Read", args: {}, itemId: "tool-2", turnId } },
        { sessionId: "s1", timestamp: "2026-01-01T12:00:04.000Z", sequence: 5, event: { type: "text", text: "Let me look at the sendMessage flow more carefully and what ", itemId: "msg-1", turnId } },
        { sessionId: "s1", timestamp: "2026-01-01T12:00:05.000Z", sequence: 6, event: { type: "activity", activity: "searching", detail: "Grep", turnId } },
        { sessionId: "s1", timestamp: "2026-01-01T12:00:06.000Z", sequence: 7, event: { type: "text", text: "events are emitted when a session is resumed.", itemId: "msg-1", turnId } },
      ],
      notices: [],
      activeSession: session,
      width: 120,
    });

    expect(frame).not.toContain("Runtime");
    expect(frame).not.toContain("Processing tool input");
    // The two real tool calls collapse to a single header row; the latest call
    // (read) previews, the earlier one (grep) hides behind the collapsed group.
    expect(frame).toContain("Tool calls");
    expect(frame).toContain("(2)");
    expect(frame).toContain("read");
    expect(frame).not.toContain("grep");
    expect(frame).toContain("Let me look at the sendMessage flow more carefully and what events are emitted when a session is resumed.");
  });

  it("keeps startup/auth notices out of the transcript header spam path", () => {
    const result = render(
      <ChatView
        events={[
          { sessionId: "s1", timestamp: "2026-01-01T12:00:00.000Z", sequence: 1, event: { type: "system_notice", noticeKind: "info", message: "Session ready" } as never },
          { sessionId: "s1", timestamp: "2026-01-01T12:00:01.000Z", sequence: 2, event: { type: "system_notice", noticeKind: "hook", message: "Hook: SessionStart:startup started" } as never },
          { sessionId: "s1", timestamp: "2026-01-01T12:00:02.000Z", sequence: 3, event: { type: "system_notice", noticeKind: "hook", message: "Trimmed large tool output before sending it back to Claude." } as never },
          { sessionId: "s1", timestamp: "2026-01-01T12:00:03.000Z", sequence: 4, event: { type: "system_notice", noticeKind: "auth", message: "Failed to authenticate. API Error: 401 Invalid authentication credentials" } as never },
        ]}
        notices={[
          { id: "notice-1", timestamp: "2026-01-01T12:00:03.000Z", tone: "info", text: "Starting `claude auth login` in this terminal." },
          { id: "notice-2", timestamp: "2026-01-01T12:00:04.000Z", tone: "success", text: "Claude auth completed. Refreshing provider status." },
        ]}
        activeSession={{ ...session, provider: "claude", model: "claude-sonnet-4-5" }}
        projectName="ADE"
        laneName="Primary"
        width={100}
      />,
    );
    const frame = stripAnsi(result.lastFrame() ?? "");

    expect(frame).toContain("Failed to authenticate. API Error: 401 Invalid authentication credentials");
    expect(frame).toContain("Starting `claude auth login` in this terminal.");
    expect(frame).toContain("Claude auth completed. Refreshing provider status.");
    expect(frame).not.toContain("Session ready");
    expect(frame).not.toContain("Hook: SessionStart");
    expect(frame).not.toContain("Trimmed large tool output");
    expect(frame).not.toContain("Claude ·");
    expect(frame).not.toContain("ADE Code ·");
    expect(frame).not.toContain("12:00");
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

  it("renders a re-emitted overlapping tail fragment only once (no duplicated sentence)", () => {
    // Screenshot regression: "…so I can split the review instead of doing it as
    // one giant pass. so I can split the review…" — the provider re-emitted the
    // closing fragment for the same messageId and concat duplicated it.
    const frame = renderEvents([
      { sessionId: "s1", timestamp: "2026-01-01T12:00:00.000Z", sequence: 1, event: { type: "text", text: "Alpha beta gamma.", messageId: "m1", turnId: "t1" } },
      { sessionId: "s1", timestamp: "2026-01-01T12:00:01.000Z", sequence: 2, event: { type: "text", text: "beta gamma.", messageId: "m1", turnId: "t1" } },
    ], { width: 80 });
    expect(frame).toContain("Alpha beta gamma.");
    expect(frame.match(/beta gamma\./g)).toHaveLength(1);
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
        ? { type: "user_message", text: `user row ${String(index + 1).padStart(2, "0")}` }
        : { type: "text", text: `assistant row ${String(index + 1).padStart(2, "0")}` },
    }));
    const bottom = renderEvents(events, { maxRows: 5, width: 80 });
    expect(bottom).toContain("assistant row 12");
    expect(bottom).not.toContain("user row 01");
    expect(bottom).toContain("↑ older messages");

    const older = renderEvents(events, { maxRows: 5, scrollOffsetRows: 8, width: 80 });
    expect(older).toContain("row");
    expect(older).toContain("↓ newer messages");
    expect(older).not.toContain("assistant row 12");
    expect(older.split("\n").at(-1)).toContain("↓ newer messages");
  });

  it("swaps the older-messages indicator for a loading variant in place while a scroll-back page is in flight", () => {
    const events = Array.from({ length: 12 }, (_, index): AgentChatEventEnvelope => ({
      sessionId: "s1",
      timestamp: `2026-01-01T12:00:${String(index).padStart(2, "0")}.000Z`,
      sequence: index + 1,
      event: index % 2 === 0
        ? { type: "user_message", text: `user row ${String(index + 1).padStart(2, "0")}` }
        : { type: "text", text: `assistant row ${String(index + 1).padStart(2, "0")}` },
    }));
    const maxRows = 5;

    const idle = renderEvents(events, { maxRows, width: 80 });
    const loading = renderEvents(events, { maxRows, width: 80, olderHistory: "loading" });
    const exhausted = renderEvents(events, { maxRows, width: 80, olderHistory: "exhausted" });

    expect(idle).toContain("↑ older messages");
    expect(loading).toContain("↑ loading earlier…");
    expect(loading).not.toContain("↑ older messages");
    // "exhausted"/"available" keep the existing indicator behavior untouched.
    expect(exhausted).toContain("↑ older messages");
    // The indicator swaps text in the SAME row: row count is identical in all
    // states so the scroll math is untouched.
    expect(transcriptLines(loading)).toHaveLength(transcriptLines(idle).length);
    expect(transcriptLines(loading)[0]).toContain("↑ loading earlier…");
    expect(transcriptLines(idle)[0]).toContain("↑ older messages");
  });

  it("stays at the oldest rows when the transcript is overscrolled", () => {
    const events = Array.from({ length: 12 }, (_, index): AgentChatEventEnvelope => ({
      sessionId: "s1",
      timestamp: `2026-01-01T12:00:${String(index).padStart(2, "0")}.000Z`,
      sequence: index + 1,
      event: index % 2 === 0
        ? { type: "user_message", text: `user row ${String(index + 1).padStart(2, "0")}` }
        : { type: "text", text: `assistant row ${String(index + 1).padStart(2, "0")}` },
    }));

    const frame = renderEvents(events, { maxRows: 5, scrollOffsetRows: 100_000, width: 80 });
    expect(frame).toContain("user row 01");
    expect(frame).toContain("↓ newer messages");
    expect(frame).not.toContain("assistant row 12");
  });

  it("keeps a fixed transcript row count while scroll indicators move", () => {
    const events = Array.from({ length: 14 }, (_, index): AgentChatEventEnvelope => ({
      sessionId: "s1",
      timestamp: `2026-01-01T12:00:${String(index).padStart(2, "0")}.000Z`,
      sequence: index + 1,
      event: index % 2 === 0
        ? { type: "user_message", text: `user row ${String(index + 1).padStart(2, "0")}` }
        : { type: "text", text: `assistant row ${String(index + 1).padStart(2, "0")}` },
    }));
    const maxRows = 6;
    const frames = [
      renderEvents(events, { maxRows, scrollOffsetRows: 0, width: 80 }),
      renderEvents(events, { maxRows, scrollOffsetRows: 5, width: 80 }),
      renderEvents(events, { maxRows, scrollOffsetRows: 100_000, width: 80 }),
    ];

    for (const frame of frames) {
      expect(transcriptLines(frame)).toHaveLength(maxRows);
    }
    expect(transcriptLines(frames[1]!).at(-1)).toContain("↓ newer messages");
    expect(transcriptLines(frames[2]!)[0]).not.toContain("↑ older messages");
    expect(transcriptLines(frames[2]!).at(-1)).toContain("↓ newer messages");
  });

  it("can scroll to the true oldest row in long histories beyond the old render cap", () => {
    const events = Array.from({ length: 240 }, (_, index): AgentChatEventEnvelope => ({
      sessionId: "s1",
      timestamp: `2026-01-01T12:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
      sequence: index + 1,
      event: index % 2 === 0
        ? { type: "user_message", text: `user row ${String(index + 1).padStart(3, "0")}` }
        : { type: "text", text: `assistant row ${String(index + 1).padStart(3, "0")}` },
    }));
    const maxRows = 8;
    const maxOffset = computeChatScrollMaxOffset({
      events,
      notices: [],
      activeSession: session,
      maxRows,
      width: 80,
    });

    expect(maxOffset).toBeGreaterThan(200);
    const frame = renderEvents(events, { maxRows, scrollOffsetRows: maxOffset, width: 80 });
    expect(frame).toContain("user row 001");
    expect(frame).not.toContain("user row 041");
    expect(transcriptLines(frame)).toHaveLength(maxRows);
    expect(transcriptLines(frame).at(-1)).toContain("↓ newer messages");
  });

  it("renders an expanded command as a shell tool line with label, command, and duration", () => {
    const frame = renderEvents([
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:00.000Z",
        sequence: 1,
        event: { type: "command", command: "git branch", cwd: "/repo", output: "main", itemId: "cmd-1", status: "completed", exitCode: 0, durationMs: 12 },
      },
    ], { width: 100, expanded: true });
    expect(frame).toContain("Tool calls");
    expect(frame).toContain("(1)");
    expect(frame).toMatch(/✓ shell\s+git branch\s+12ms/);
  });

  it("splits consecutive tool-calls and file_changes into typed groups within one turn", () => {
    const turnId = "turn-live";
    const events: AgentChatEventEnvelope[] = [
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:00.000Z",
        sequence: 1,
        event: { type: "command", command: "npm test", cwd: "/repo", output: "", itemId: "cmd-a", status: "completed", exitCode: 0, durationMs: 2100, turnId },
      },
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:02.000Z",
        sequence: 2,
        event: { type: "file_change", path: "src/auth.ts", diff: "+a\n+b\n-c\n", kind: "modify", itemId: "fc-a", status: "completed", turnId },
      },
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:03.000Z",
        sequence: 3,
        event: { type: "command", command: "npm run typecheck", cwd: "/repo", output: "", itemId: "cmd-b", status: "running", turnId },
      },
    ];
    const frame = renderEvents(events, { width: 100 });
    // Typed split: tool calls and file changes each get their own collapsible
    // header. The collapsed tool-call header previews the latest call so live
    // progress stays visible without stacking every command by default.
    expect(frame).toContain("Tool calls");
    expect(frame).toContain("Files changed");
    expect(frame).toContain("npm run typecheck");
    expect(frame).not.toContain("npm test");
    expect(frame).toContain("auth.ts");
    // The collapsed file header keeps the badge + diff stats format.
    expect(frame).toContain("TS");
    expect(frame).toContain("+2 −1");
  });

  it("shows compact subagent lifecycle while keeping child tool chatter out of the center transcript", () => {
    const turnId = "turn-subagents";
    const frame = renderEvents([
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:00.000Z",
        sequence: 1,
        event: {
          type: "tool_call",
          tool: "spawn_agent",
          args: { message: "Explore renderer" },
          itemId: "spawn-1",
          turnId,
        },
      },
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:01.000Z",
        sequence: 2,
        event: {
          type: "subagent_started",
          taskId: "agent-1",
          parentToolUseId: "spawn-1",
          description: "child launch spam",
          turnId,
        },
      },
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:02.000Z",
        sequence: 3,
        event: {
          type: "tool_call",
          tool: "read_file",
          args: { path: "src/noisy-child.ts" },
          itemId: "child-tool-1",
          parentItemId: "spawn-1",
          turnId,
        },
      },
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:03.000Z",
        sequence: 4,
        event: {
          type: "tool_result",
          tool: "read_file",
          result: "child tool result spam",
          itemId: "child-tool-1",
          status: "completed",
          turnId,
        },
      },
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:04.000Z",
        sequence: 5,
        event: {
          type: "subagent_progress",
          taskId: "agent-1",
          parentToolUseId: "spawn-1",
          summary: "child progress spam",
          turnId,
        },
      },
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:05.000Z",
        sequence: 6,
        event: {
          type: "subagent_result",
          taskId: "agent-1",
          parentToolUseId: "spawn-1",
          status: "completed",
          summary: "child result spam",
          turnId,
        },
      },
    ], { width: 100 });

    // The top-level spawn collapses into a single "Tool calls" header that
    // previews it; the subagent's own child tool chatter stays suppressed.
    expect(frame).toContain("Tool calls");
    expect(frame).toContain("spawn_agent");
    expect(frame).toContain("Explore renderer");
    expect(frame).toContain("Activity");
    expect(frame).toContain("child result spam");
    expect(frame).toContain("agent");
    expect(frame).not.toContain("read_file");
    expect(frame).not.toContain("noisy-child");
    expect(frame).not.toContain("child tool result spam");
  });

  it("renders a selected subagent transcript with the same ChatView format", () => {
    const turnId = "turn-subagents";
    const events: AgentChatEventEnvelope[] = [
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:00.000Z",
        sequence: 1,
        event: { type: "subagent_started", taskId: "agent-1", parentToolUseId: "spawn-1", description: "Explore renderer", turnId },
      },
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:01.000Z",
        sequence: 2,
        event: { type: "tool_call", tool: "read_file", args: { path: "src/child.ts" }, itemId: "child-tool-1", parentItemId: "spawn-1", turnId },
      },
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:02.000Z",
        sequence: 3,
        event: { type: "tool_result", tool: "read_file", result: "child output", itemId: "child-tool-1", status: "completed", turnId },
      },
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:03.000Z",
        sequence: 4,
        event: { type: "subagent_progress", taskId: "agent-1", parentToolUseId: "spawn-1", summary: "found the renderer path", turnId },
      },
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:04.000Z",
        sequence: 5,
        event: { type: "subagent_result", taskId: "agent-2", parentToolUseId: "spawn-2", status: "completed", summary: "unrelated agent result", turnId },
      },
    ];
    const transcriptEvents = buildSubagentTranscriptEvents({
      events,
      activeSession: session,
      snapshot: {
        id: "agent-1",
        name: "Explore renderer",
        kind: "subagent",
        status: "running",
        summary: "found the renderer path",
        parentToolUseId: "spawn-1",
        turnId,
      },
    });
    const transcriptBody = transcriptEvents
      .map((entry) => JSON.stringify(entry.event))
      .join("\n");
    const frame = renderEvents(transcriptEvents, { width: 100, maxRows: 40 });
    expect(frame).toContain("Viewing agent transcript.");
    expect(frame).toContain("Select Main chat in Chat Info to return.");
    expect(transcriptBody).toContain("Started.");
    expect(frame).toContain("read_file");
    expect(frame).toContain("src/child.ts");
    expect(transcriptBody).toContain("found the renderer path");
    expect(transcriptBody).not.toContain("unrelated agent result");
  });

  it("renders per-call ok/failed glyphs for an expanded finished tool group", () => {
    const turnId = "turn-done";
    const events: AgentChatEventEnvelope[] = [
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:00.000Z",
        sequence: 1,
        event: { type: "command", command: "lint check", cwd: "/repo", output: "", itemId: "c1", status: "completed", exitCode: 0, durationMs: 200, turnId },
      },
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:01.000Z",
        sequence: 2,
        event: { type: "command", command: "npm test", cwd: "/repo", output: "", itemId: "c2", status: "failed", exitCode: 1, durationMs: 800, turnId },
      },
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:02.000Z",
        sequence: 3,
        event: { type: "command", command: "echo ok", cwd: "/repo", output: "", itemId: "c3", status: "completed", exitCode: 0, durationMs: 50, turnId },
      },
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:03.000Z",
        sequence: 4,
        event: { type: "command", command: "echo two", cwd: "/repo", output: "", itemId: "c4", status: "completed", exitCode: 0, durationMs: 50, turnId },
      },
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:08.300Z",
        sequence: 5,
        event: { type: "done", turnId, status: "completed", usage: { inputTokens: 4000, outputTokens: 2200 }, costUsd: 0.31 },
      },
    ];
    const frame = renderEvents(events, { width: 100, expanded: true });
    // Expanded group: ok/failed status lives on each call's glyph.
    expect(frame).toContain("Tool calls");
    expect(frame).toContain("(4)");
    expect(frame.match(/✓/g)).toHaveLength(3);
    expect(frame.match(/✗/g)).toHaveLength(1);
    // Every shell command is visible when expanded.
    expect(frame).toContain("npm test");
    expect(frame).toContain("echo two");
    expect(frame).not.toContain("8.3s");
  });

  it("hides missing and zero tool durations while preserving valid per-call durations", () => {
    const turnId = "turn-durations";
    const events: AgentChatEventEnvelope[] = [
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:00.000Z",
        sequence: 1,
        event: { type: "command", command: "instant", cwd: "/repo", output: "", itemId: "c1", status: "completed", exitCode: 0, durationMs: 0, turnId },
      },
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:01.000Z",
        sequence: 2,
        event: { type: "command", command: "measured", cwd: "/repo", output: "", itemId: "c2", status: "completed", exitCode: 0, durationMs: 12, turnId },
      },
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:24:00.000Z",
        sequence: 3,
        event: { type: "done", turnId, status: "completed" },
      },
    ];

    const frame = renderEvents(events, { width: 100, expanded: true });
    expect(frame).toContain("instant");
    expect(frame).toContain("measured");
    expect(frame).toContain("12ms");
    expect(frame).not.toContain("0ms");
    expect(frame).not.toContain("24m");
  });

  it("collapses streamed reasoning into one desktop-style Thinking row", () => {
    const turnId = "turn-think";
    const events: AgentChatEventEnvelope[] = [
      { sessionId: "s1", timestamp: "2026-01-01T12:00:00.000Z", sequence: 1, event: { type: "reasoning", text: "first thought ", turnId } },
      { sessionId: "s1", timestamp: "2026-01-01T12:00:00.500Z", sequence: 2, event: { type: "reasoning", text: "second thought ", turnId } },
      { sessionId: "s1", timestamp: "2026-01-01T12:00:01.000Z", sequence: 3, event: { type: "reasoning", text: "third thought", turnId } },
    ];
    const frame = renderEvents(events, { width: 80 });
    expect(frame).not.toMatch(/✦/);
    // One merged row, live label, single-line preview of the streamed text.
    expect(frame).toContain("Thinking…");
    expect(frame).toContain("first thought second thought third thought");
    const reasoningRows = frame.split(/\r?\n/).filter((line) => line.includes("thought"));
    expect(reasoningRows).toHaveLength(1);
  });

  it("marks the reasoning row as Thought once the turn completes", () => {
    const turnId = "turn-think-done";
    const events: AgentChatEventEnvelope[] = [
      { sessionId: "s1", timestamp: "2026-01-01T12:00:00.000Z", sequence: 1, event: { type: "reasoning", text: "weighing options", turnId } },
      { sessionId: "s1", timestamp: "2026-01-01T12:00:01.000Z", sequence: 2, event: { type: "done", turnId, status: "completed" } },
    ];
    const frame = renderEvents(events, { width: 80 });
    expect(frame).toContain("Thought");
    expect(frame).not.toContain("Thinking…");
    expect(frame).toContain("weighing options");
  });

  it("suppresses done footers because token/runtime detail lives in the footer", () => {
    const turnId = "turn-footer";
    const events: AgentChatEventEnvelope[] = [
      { sessionId: "s1", timestamp: "2026-01-01T12:00:00.000Z", sequence: 1, event: { type: "user_message", text: "hi", turnId } },
      { sessionId: "s1", timestamp: "2026-01-01T12:00:08.300Z", sequence: 2, event: { type: "done", turnId, status: "completed", usage: { inputTokens: 4000, outputTokens: 2200 }, costUsd: 0.31 } },
    ];
    const frame = renderEvents(events, { width: 80 });
    expect(frame).toContain("hi");
    expect(frame).not.toContain("8.3s");
    expect(frame).not.toContain("6.2k tok");
    expect(frame).not.toContain("$0.31");
  });

  it("renders a markdown table with box-drawing borders", () => {
    const text = [
      "| tool | duration | status |",
      "|------|----------|--------|",
      "| bash | 2.1s     | running |",
      "| edit | 120ms    | ok      |",
    ].join("\n");
    const frame = renderEvents([
      { sessionId: "s1", timestamp: "2026-01-01T12:00:00.000Z", sequence: 1, event: { type: "text", text } },
    ], { width: 80 });
    expect(frame).toMatch(/┌.*┬.*┐/);
    expect(frame).toMatch(/├.*┼.*┤/);
    expect(frame).toMatch(/└.*┴.*┘/);
    expect(frame).toMatch(/│/);
    expect(frame).toContain("tool");
    expect(frame).toContain("duration");
    expect(frame).toContain("status");
    expect(frame).toContain("bash");
    expect(frame).toContain("120ms");
  });

  it("exports visible transcript rows as plain text for copy", () => {
    const text = renderChatTranscriptPlainText({
      events: [
        { sessionId: "s1", timestamp: "2026-01-01T12:00:00.000Z", sequence: 1, event: { type: "user_message", text: "copy me" } },
        { sessionId: "s1", timestamp: "2026-01-01T12:00:01.000Z", sequence: 2, event: { type: "text", text: "copied" } },
      ],
      notices: [],
      activeSession: session,
      width: 64,
    });

    expect(text).toContain("copy me");
    expect(text).toContain("copied");
    expect(text).not.toContain("Codex");
    expect(text).not.toContain("gpt");
  });

  it("collapses many tool calls to one header row and expands to stack every call", () => {
    const turnId = "turn-many";
    const events: AgentChatEventEnvelope[] = Array.from({ length: 12 }, (_, index): AgentChatEventEnvelope => ({
      sessionId: "s1",
      timestamp: `2026-01-01T12:00:${String(index).padStart(2, "0")}.000Z`,
      sequence: index + 1,
      event: {
        type: "command",
        command: `cmd-${index + 1}`,
        cwd: "/repo",
        output: "",
        itemId: `c${index + 1}`,
        status: "completed",
        exitCode: 0,
        durationMs: 100,
        turnId,
      },
    }));

    // Collapsed (default): one header row with the count + the latest call's
    // preview; the earlier calls are hidden behind the collapsed group.
    const collapsed = renderEvents(events, { width: 120, maxRows: 40 });
    expect(collapsed).toContain("Tool calls");
    expect(collapsed).toContain("(12)");
    expect(collapsed).toContain("cmd-12");
    expect(collapsed).not.toContain("cmd-1 ");
    expect(collapsed).not.toContain("cmd-5");

    // Expanded: the header stays, and every consecutive call stacks one per line.
    const expanded = renderEvents(events, { width: 120, maxRows: 40, expanded: true });
    expect(expanded).toContain("Tool calls");
    expect(expanded).toContain("cmd-1");
    expect(expanded).toContain("cmd-5");
    expect(expanded).toContain("cmd-12");
  });

  it("strips the /bin/zsh -lc launcher wrapper from shell commands", () => {
    const events: AgentChatEventEnvelope[] = [
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:00.000Z",
        sequence: 1,
        event: {
          type: "command",
          command: "/bin/zsh -lc \"git status --short\"",
          cwd: "/repo",
          output: "",
          itemId: "c1",
          status: "completed",
          exitCode: 0,
          durationMs: 12,
        },
      },
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:01.000Z",
        sequence: 2,
        event: {
          type: "command",
          command: "/bin/bash -c 'npm test'",
          cwd: "/repo",
          output: "",
          itemId: "c2",
          status: "completed",
          exitCode: 0,
          durationMs: 1500,
        },
      },
    ];
    const frame = renderEvents(events, { width: 120, expanded: true });
    expect(frame).toContain("git status --short");
    expect(frame).toContain("npm test");
    // Launcher prefix is gone.
    expect(frame).not.toContain("/bin/zsh -lc");
    expect(frame).not.toContain("/bin/bash -c");
  });

  it("renders files-changed-group with typed badges per extension", () => {
    const events: AgentChatEventEnvelope[] = [
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:00.000Z",
        sequence: 1,
        event: { type: "file_change", path: "src/Component.tsx", diff: "+a\n+b\n-c", kind: "modify", itemId: "f1", status: "completed", turnId: "t1" },
      },
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:01.000Z",
        sequence: 2,
        event: { type: "file_change", path: "src/legacy.js", diff: "", kind: "delete", itemId: "f2", status: "completed", turnId: "t1" },
      },
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:02.000Z",
        sequence: 3,
        event: { type: "file_change", path: "docs/notes.md", diff: "+line1", kind: "create", itemId: "f3", status: "completed", turnId: "t1" },
      },
    ];
    const frame = renderEvents(events, { width: 120, expanded: true });
    expect(frame).toContain("Files changed");
    expect(frame).toContain("(3)");
    expect(frame).toContain("TSX");
    expect(frame).toContain("JS");
    expect(frame).toContain("MD");
    expect(frame).toContain("Component.tsx");
    expect(frame).toContain("Deleted");
  });

  it("collapses file changes to one header row by default, previewing the latest edit", () => {
    const events: AgentChatEventEnvelope[] = [
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:00.000Z",
        sequence: 1,
        event: { type: "file_change", path: "src/early.ts", diff: "+a\n+b\n-c", kind: "modify", itemId: "f1", status: "completed", turnId: "t1" },
      },
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:01.000Z",
        sequence: 2,
        event: { type: "file_change", path: "src/recent.ts", diff: "+x", kind: "modify", itemId: "f2", status: "completed", turnId: "t1" },
      },
    ];
    const collapsed = renderEvents(events, { width: 120 });
    expect(collapsed).toContain("Files changed");
    expect(collapsed).toContain("(2)");
    // Latest edit previews; the earlier file hides behind the collapsed group.
    expect(collapsed).toContain("recent.ts");
    expect(collapsed).not.toContain("early.ts");

    const expanded = renderEvents(events, { width: 120, expanded: true });
    expect(expanded).toContain("early.ts");
    expect(expanded).toContain("recent.ts");
  });

  it("tags a collapsed work-group header with an expandable click-target id", () => {
    const events: AgentChatEventEnvelope[] = [
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:00.000Z",
        sequence: 1,
        event: { type: "command", command: "alpha", cwd: "/repo", output: "", itemId: "c1", status: "completed", exitCode: 0, durationMs: 10, turnId: "t1" },
      },
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:01.000Z",
        sequence: 2,
        event: { type: "command", command: "beta", cwd: "/repo", output: "", itemId: "c2", status: "completed", exitCode: 0, durationMs: 10, turnId: "t1" },
      },
    ];
    const expectedKey = workGroupExpandKey(chatEventLineId(events[0]!, 0));
    const rows = renderChatVisibleSelectionRows({
      events,
      notices: [],
      activeSession: session,
      width: 120,
    });
    const headerRow = rows.find((row) => row.expandableId != null);
    // The collapsed group renders exactly one clickable header carrying the
    // expand key the transcript click handler toggles in expandedLineIds.
    expect(headerRow?.expandableId).toBe(expectedKey);
    expect(rows.filter((row) => row.expandableId != null)).toHaveLength(1);

    const expandedRows = renderChatVisibleSelectionRows({
      events,
      notices: [],
      activeSession: session,
      expandedLineIds: new Set([expectedKey]),
      width: 120,
    });
    // Still exactly one clickable header (now ▾) plus the stacked call rows.
    expect(expandedRows.filter((row) => row.expandableId != null)).toHaveLength(1);
    expect(expandedRows.length).toBeGreaterThan(rows.length);
  });

  it("renders fenced code with highlight.js-derived per-line tokens", () => {
    const events: AgentChatEventEnvelope[] = [
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:00.000Z",
        sequence: 1,
        event: { type: "text", text: "Here's a snippet:\n\n```ts\nconst x = 1;\nconst y = \"hi\";\n```" },
      },
    ];
    const frame = renderEvents(events, { width: 80 });
    // Code-fence border
    expect(frame).toMatch(/┌.*ts/);
    expect(frame).toContain("const x = 1;");
    expect(frame).toContain('const y = "hi";');
    // Closing border
    expect(frame).toContain("└");
  });

  it("preserves inline-code markers when flattening list-item / paragraph text", () => {
    // Regression guard: flattenInlineTokensToText used to drop backticks when
    // reconstructing bullet text, so downstream re-tokenization saw plain text
    // and the inline-code violet styling never fired. Verify the parsed
    // AssistantMarkdownBlock text still contains the backticks so the renderer
    // can re-detect codespans.
    const blocks = parseAssistantMarkdown(
      "What changed:\n- Split `LaneRuntimeBar` refresh work\n- Updated `cli.ts` parity\n\nAlso ran `npm test`.",
    );
    const bullets = blocks.filter((b) => b.kind === "bullet") as Array<Extract<AssistantMarkdownBlock, { kind: "bullet" }>>;
    expect(bullets).toHaveLength(2);
    expect(bullets[0]!.text).toContain("`LaneRuntimeBar`");
    expect(bullets[1]!.text).toContain("`cli.ts`");
    const trailingParagraph = [...blocks].reverse().find((b) => b.kind === "paragraph") as Extract<AssistantMarkdownBlock, { kind: "paragraph" }> | undefined;
    expect(trailingParagraph?.text).toContain("`npm test`");

    // And confirm parseInlineRuns produces a run with code: true for those.
    const runs = parseInlineRuns(bullets[0]!.text);
    expect(runs.some((r) => r.code && r.text === "LaneRuntimeBar")).toBe(true);
  });

  it("does not render the left vertical rail bar on assistant lines", () => {
    const events: AgentChatEventEnvelope[] = [
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:00.000Z",
        sequence: 1,
        event: { type: "text", text: "plain assistant text" },
      },
    ];
    const frame = renderEvents(events, { width: 80 });
    expect(frame).toContain("plain assistant text");
    // The rail prefix was "▎ " on every assistant line; assert it's gone.
    expect(frame).not.toMatch(/▎\s+plain assistant/);
  });

  it("adds a single blank line between bullets for readability", () => {
    const events: AgentChatEventEnvelope[] = [
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:00.000Z",
        sequence: 1,
        event: { type: "text", text: "What changed:\n- First item\n- Second item\n- Third item" },
      },
    ];
    const frame = renderEvents(events, { width: 80 });
    const lines = transcriptLines(frame).map((line) => line.trimEnd());
    const bulletLines = lines.filter((line) => line.trim().startsWith("•"));
    expect(bulletLines.length).toBe(3);
    // Each consecutive bullet should sit two lines apart (one blank between).
    const indices = bulletLines.map((bullet) => lines.indexOf(bullet));
    for (let i = 1; i < indices.length; i += 1) {
      expect(indices[i]! - indices[i - 1]!).toBe(2);
    }
  });

  it("shows the \"↓ N new messages\" pill when scrolled up and new events arrived", () => {
    // 200 user/assistant alternating events generates enough rows to overflow the
    // 10-row viewport at width=80, so the offset path in sliceRows fires.
    const events = Array.from({ length: 200 }, (_, index): AgentChatEventEnvelope => ({
      sessionId: "s1",
      timestamp: `2026-01-01T12:00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
      sequence: index + 1,
      event: index % 2 === 0
        ? { type: "user_message", text: `user row ${String(index + 1).padStart(3, "0")}` }
        : { type: "text", text: `assistant row ${String(index + 1).padStart(3, "0")}` },
    }));
    const maxRows = 10;
    const maxOffset = computeChatScrollMaxOffset({
      events,
      notices: [],
      activeSession: session,
      maxRows,
      width: 80,
    });
    expect(maxOffset).toBeGreaterThan(50);
    const result = render(
      <ChatView
        events={events}
        notices={[]}
        activeSession={session}
        projectName="ADE"
        laneName="Primary"
        maxRows={maxRows}
        scrollOffsetRows={maxOffset}
        unseenMessageCount={4}
        width={80}
      />,
    );
    const frame = stripAnsi(result.lastFrame() ?? "");
    expect(frame).toMatch(/↓ 4 new messages/);
    expect(frame).toContain("press End");
  });

  it("falls back to the generic \"↓ newer messages\" indicator when no unseen count is supplied", () => {
    const events = Array.from({ length: 200 }, (_, index): AgentChatEventEnvelope => ({
      sessionId: "s1",
      timestamp: `2026-01-01T12:00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
      sequence: index + 1,
      event: index % 2 === 0
        ? { type: "user_message", text: `user row ${String(index + 1).padStart(3, "0")}` }
        : { type: "text", text: `assistant row ${String(index + 1).padStart(3, "0")}` },
    }));
    const maxRows = 10;
    const maxOffset = computeChatScrollMaxOffset({
      events,
      notices: [],
      activeSession: session,
      maxRows,
      width: 80,
    });
    const frame = renderEvents(events, { maxRows, scrollOffsetRows: maxOffset, width: 80 });
    expect(frame).toContain("↓ newer messages");
    expect(frame).not.toMatch(/↓ \d+ new/);
  });

  it("omits scroll affordances from copied transcript text", () => {
    const events = Array.from({ length: 8 }, (_, index): AgentChatEventEnvelope => ({
      sessionId: "s1",
      timestamp: `2026-01-01T12:00:${String(index).padStart(2, "0")}.000Z`,
      sequence: index + 1,
      event: { type: "text", text: `copy row ${index + 1}` },
    }));
    const text = renderChatTranscriptPlainText({
      events,
      notices: [],
      activeSession: session,
      maxRows: 4,
      width: 64,
    });

    expect(text).toContain("copy row 8");
    expect(text).not.toContain("older messages");
    expect(text).not.toContain("newer messages");
  });

  it("collapses a valid ```mosaic fence to one dim summary line (interactive card is desktop-only)", () => {
    const card = JSON.stringify({
      v: 1,
      title: "Pick a runtime",
      elements: [
        { type: "select", id: "runtime", label: "Runtime", options: [{ value: "claude" }, { value: "codex" }] },
        { type: "approval", id: "go", label: "Proceed" },
      ],
    });
    const events: AgentChatEventEnvelope[] = [
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:00.000Z",
        sequence: 1,
        event: { type: "text", text: `Here is a card:\n\n\`\`\`mosaic\n${card}\n\`\`\`` },
      },
    ];
    const frame = renderEvents(events, { width: 80 });
    // Summary line renders with the card title and the "answer on desktop" hint,
    // and the raw JSON body never leaks into the transcript.
    expect(frame).toContain("Interactive card: Pick a runtime");
    expect(frame).toContain("answer on desktop");
    expect(frame).not.toContain('"v": 1');
    expect(frame).not.toContain("multiselect");
    // No code-fence rail glyphs for the collapsed card.
    expect(frame).not.toMatch(/┌─\s*mosaic/);
  });

  it("renders a malformed ```mosaic fence as a normal code block, not a summary line", () => {
    const events: AgentChatEventEnvelope[] = [
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:00.000Z",
        sequence: 1,
        event: { type: "text", text: "Broken:\n\n```mosaic\n{ not valid json\n```" },
      },
    ];
    const frame = renderEvents(events, { width: 80 });
    // Parse failure falls back to the plain fenced code block (rail + raw body).
    expect(frame).toContain("{ not valid json");
    expect(frame).not.toContain("Interactive card");
    expect(frame).not.toContain("answer on desktop");
  });
});
