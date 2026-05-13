import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { ChatView, computeChatScrollMaxOffset, renderChatTranscriptPlainText } from "../components/ChatView";
import { buildSubagentTranscriptEvents } from "../subagentPane";
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

function renderEvents(
  events: AgentChatEventEnvelope[],
  options: { maxRows?: number; scrollOffsetRows?: number; width?: number; streaming?: boolean } = {},
): string {
  const result = render(
    <ChatView
      events={events}
      notices={[]}
      activeSession={session}
      projectName="ADE"
      laneName="Primary"
      streaming={options.streaming}
      maxRows={options.maxRows}
      scrollOffsetRows={options.scrollOffsetRows}
      width={options.width}
    />,
  );
  return stripAnsi(result.lastFrame() ?? "");
}

function transcriptLines(frame: string): string[] {
  return frame.split(/\r?\n/);
}

describe("ChatView", () => {
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

  it("shows a model working indicator while a turn is active before text arrives", () => {
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
  });

  it("keeps the model working indicator visible while active text is streaming", () => {
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

    expect(frame).toContain("compacting context");
    expect(frame).toContain("auto");
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
    expect(frame).not.toContain("internal thought");
    expect(frame).not.toContain("Thinking through the answer");
    expect(frame).not.toContain("Codex");
    expect(frame).not.toContain("gpt");
    expect(frame).not.toContain("tok");
    expect(frame).not.toContain("[status]");
    expect(frame).not.toContain("[done]");
  });

  it("keeps startup/auth notices out of the transcript header spam path", () => {
    const result = render(
      <ChatView
        events={[
          { sessionId: "s1", timestamp: "2026-01-01T12:00:00.000Z", sequence: 1, event: { type: "system_notice", noticeKind: "info", message: "Session ready" } as never },
          { sessionId: "s1", timestamp: "2026-01-01T12:00:01.000Z", sequence: 2, event: { type: "system_notice", noticeKind: "hook", message: "Hook: SessionStart:startup started" } as never },
          { sessionId: "s1", timestamp: "2026-01-01T12:00:02.000Z", sequence: 3, event: { type: "system_notice", noticeKind: "auth", message: "Failed to authenticate. API Error: 401 Invalid authentication credentials" } as never },
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

  it("renders single command in a work block with bash header and command arg", () => {
    const frame = renderEvents([
      {
        sessionId: "s1",
        timestamp: "2026-01-01T12:00:00.000Z",
        sequence: 1,
        event: { type: "command", command: "git branch", cwd: "/repo", output: "main", itemId: "cmd-1", status: "completed", exitCode: 0, durationMs: 12 },
      },
    ], { width: 100 });
    expect(frame).toMatch(/▸\s+working/);
    expect(frame).toMatch(/✓ bash/);
    expect(frame).toContain("git branch");
  });

  it("groups consecutive tool calls into a live work block with counter and last tool row", () => {
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
    expect(frame).toMatch(/working · 3 tools so far/);
    // Newest tool (typecheck) is on top of the live list.
    expect(frame).toContain("npm run typecheck");
  });

  it("keeps subagent lifecycle and child tool chatter out of the center transcript", () => {
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

    expect(frame).toContain("working · 1 tool so far");
    expect(frame).toContain("spawn_agent");
    expect(frame).toContain("Explore renderer");
    expect(frame).not.toContain("child launch spam");
    expect(frame).not.toContain("read_file");
    expect(frame).not.toContain("noisy-child");
    expect(frame).not.toContain("child tool result spam");
    expect(frame).not.toContain("child progress spam");
    expect(frame).not.toContain("child result spam");
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
    expect(frame).toContain("Viewing subagent: Explore renderer");
    expect(frame).toContain("Leave the agents pane to return to the main chat.");
    expect(transcriptBody).toContain("Subagent started: Explore renderer");
    expect(frame).toContain("read_file");
    expect(frame).toContain("src/child.ts");
    expect(transcriptBody).toContain("found the renderer path");
    expect(transcriptBody).not.toContain("unrelated agent result");
  });

  it("collapses work block on done with failed tool surfaced alongside last ok", () => {
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
    const frame = renderEvents(events, { width: 100 });
    expect(frame).toMatch(/▸\s+4 tools/);
    expect(frame).toMatch(/3 ok/);
    expect(frame).toMatch(/1 failed/);
    // Failed tool surfaced.
    expect(frame).toContain("npm test");
    // Last successful tool also surfaced.
    expect(frame).toContain("echo two");
  });

  it("hides reasoning-only events from the quiet transcript", () => {
    const turnId = "turn-think";
    const events: AgentChatEventEnvelope[] = [
      { sessionId: "s1", timestamp: "2026-01-01T12:00:00.000Z", sequence: 1, event: { type: "reasoning", text: "first thought", turnId } },
      { sessionId: "s1", timestamp: "2026-01-01T12:00:00.500Z", sequence: 2, event: { type: "reasoning", text: "second thought", turnId } },
      { sessionId: "s1", timestamp: "2026-01-01T12:00:01.000Z", sequence: 3, event: { type: "reasoning", text: "third thought", turnId } },
    ];
    const frame = renderEvents(events, { width: 80 });
    expect(frame).not.toMatch(/✦/);
    expect(frame).not.toContain("first thought");
    expect(frame).not.toContain("second thought");
    expect(frame).not.toContain("third thought");
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
});
