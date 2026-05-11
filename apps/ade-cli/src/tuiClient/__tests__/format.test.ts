import { describe, expect, it } from "vitest";
import { latestExpandableFailureId, parseAssistantMarkdown, renderChatLines, renderObject } from "../format";

describe("renderChatLines", () => {
  it("parses assistant markdown into stable blocks", () => {
    expect(parseAssistantMarkdown([
      "# Heading",
      "",
      "Paragraph text",
      "",
      "- Bullet",
      "1. Numbered",
      "> Quote",
      "",
      "```sh",
      "npm test",
      "```",
    ].join("\n"))).toEqual([
      { kind: "heading", level: 1, text: "Heading" },
      { kind: "paragraph", text: "Paragraph text" },
      { kind: "bullet", text: "Bullet" },
      { kind: "numbered", number: "1", text: "Numbered" },
      { kind: "quote", text: "Quote" },
      { kind: "code", language: "sh", lines: ["npm test"] },
    ]);
  });

  it("renders compact rule-separated chat turns", () => {
    const lines = renderChatLines({
      activeSession: null,
      notices: [],
      events: [
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:00.000Z",
          sequence: 1,
          event: { type: "user_message", text: "hello" },
        },
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:01.000Z",
          sequence: 2,
          event: { type: "text", text: "hi" },
        },
      ],
    });
    expect(lines.map((line) => line.tone)).toEqual(["user", "assistant"]);
    expect(lines[0]?.header).toContain("you");
    expect(lines[1]?.header).toContain("ADE");
  });

  it("orders local notices and chat events by timestamp", () => {
    const lines = renderChatLines({
      activeSession: null,
      notices: [
        {
          id: "notice-1",
          timestamp: "2026-01-01T12:00:02.000Z",
          tone: "success",
          text: "Auth completed.",
        },
      ],
      events: [
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:01.000Z",
          sequence: 1,
          event: { type: "user_message", text: "hello" },
        },
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:03.000Z",
          sequence: 2,
          event: { type: "text", text: "hi" },
        },
      ],
    });

    expect(lines.map((line) => line.body)).toEqual(["hello", "Auth completed.", "hi"]);
  });

  it("keeps terminal formatting artifacts out of model labels", () => {
    const lines = renderChatLines({
      activeSession: {
        sessionId: "s1",
        laneId: "lane-1",
        provider: "claude",
        model: "claude-opus-4-7[1m]",
        status: "idle",
        startedAt: "2026-01-01T12:00:00.000Z",
        endedAt: null,
        lastActivityAt: "2026-01-01T12:00:00.000Z",
        lastOutputPreview: null,
        summary: null,
      },
      notices: [],
      events: [
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:01.000Z",
          sequence: 1,
          event: { type: "text", text: "hi" },
        },
      ],
    });

    expect(lines[0]?.header).toMatch(/^Claude · .* · claude-opus-4-7$/);
  });

  it("renders non-JSON-safe objects without throwing", () => {
    const value: { self?: unknown } = {};
    value.self = value;
    expect(renderObject(value)).toBe("[object Object]");
  });

  it("renders tool, edit, and compaction events compactly", () => {
    const lines = renderChatLines({
      activeSession: null,
      notices: [],
      events: [
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:00.000Z",
          sequence: 1,
          event: { type: "tool_call", tool: "read", args: { path: "src/app.ts" }, itemId: "tool-1" },
        },
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:01.000Z",
          sequence: 2,
          event: {
            type: "file_change",
            path: "src/app.ts",
            kind: "modify",
            status: "completed",
            itemId: "edit-1",
            diff: "+hello\n-world",
          },
        },
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:02.000Z",
          sequence: 3,
          event: { type: "context_compact", trigger: "auto" },
        },
      ],
    });

    expect(lines).toEqual([
      expect.objectContaining({ tone: "tool", body: expect.stringContaining("> read") }),
      expect.objectContaining({ tone: "tool", body: expect.stringContaining("> edit src/app.ts") }),
      expect.objectContaining({ tone: "notice", body: expect.stringContaining("context compacted") }),
    ]);
  });

  it("summarizes command pass and fail counts when present", () => {
    const events = [{
      sessionId: "s1",
      timestamp: "2026-01-01T12:00:00.000Z",
      sequence: 1,
      event: {
        type: "command",
        command: "vitest",
        cwd: "/repo",
        output: "Test Files 1 failed | Tests 7 passed, 1 failed",
        itemId: "cmd-1",
        status: "failed",
        exitCode: 1,
        durationMs: 2100,
      },
    }] as const;
    const lines = renderChatLines({
      activeSession: null,
      notices: [],
      events: [...events],
    });

    expect(lines[0]).toEqual(expect.objectContaining({
      tone: "error",
      body: expect.stringContaining("7 passed · 1 failed"),
    }));
    expect(lines[0]?.body).toContain("↵ expands");
    expect(latestExpandableFailureId([...events])).toBe("1:command:2026-01-01T12:00:00.000Z");
  });

  it("coalesces consecutive streamed text events from the same provider into one line", () => {
    const session = {
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
    } as const;
    const lines = renderChatLines({
      activeSession: session,
      notices: [],
      events: [
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:01.000Z",
          sequence: 1,
          event: { type: "text", text: "I'm Codex," },
        },
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:02.000Z",
          sequence: 2,
          event: { type: "text", text: " running as a GPT-5 based" },
        },
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:03.000Z",
          sequence: 3,
          event: { type: "text", text: " software engineering agent." },
        },
      ],
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.tone).toBe("assistant");
    expect(lines[0]?.body).toBe("I'm Codex, running as a GPT-5 based software engineering agent.");
    expect(lines[0]?.blocks).toEqual([
      { kind: "paragraph", text: "I'm Codex, running as a GPT-5 based software engineering agent." },
    ]);
    expect(lines[0]?.header).toMatch(/^Codex /);
  });

  it("does not coalesce assistant text across a tool call", () => {
    const session = {
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
    } as const;
    const lines = renderChatLines({
      activeSession: session,
      notices: [],
      events: [
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:01.000Z",
          sequence: 1,
          event: { type: "text", text: "I'll check the branch." },
        },
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:02.000Z",
          sequence: 2,
          event: { type: "tool_call", tool: "shell", args: { command: "git branch" }, itemId: "tool-1" },
        },
        {
          sessionId: "s1",
          timestamp: "2026-01-01T12:00:03.000Z",
          sequence: 3,
          event: { type: "text", text: "We're on main." },
        },
      ],
    });
    expect(lines.map((line) => line.tone)).toEqual(["assistant", "tool", "assistant"]);
    expect(lines[0]?.body).toBe("I'll check the branch.");
    expect(lines[2]?.body).toBe("We're on main.");
    expect(lines[2]?.header).toMatch(/^Codex /);
  });

  it("renders expanded failed tool output when requested", () => {
    const events = [{
      sessionId: "s1",
      timestamp: "2026-01-01T12:00:00.000Z",
      sequence: 1,
      event: {
        type: "tool_result",
        tool: "read",
        result: { error: "Permission denied", path: "/repo/secret" },
        itemId: "tool-1",
        status: "failed",
      },
    }] as const;
    const id = latestExpandableFailureId([...events]);
    const lines = renderChatLines({
      activeSession: null,
      notices: [],
      events: [...events],
      expandedLineIds: new Set(id ? [id] : []),
    });

    expect(lines[0]).toEqual(expect.objectContaining({
      tone: "error",
      body: expect.stringContaining("Permission denied"),
    }));
    expect(lines[0]?.body).not.toContain("↵ expands");
  });
});
