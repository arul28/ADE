import { describe, expect, it } from "vitest";
import { latestExpandableFailureId, renderChatLines, renderObject } from "../format";

describe("renderChatLines", () => {
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
    expect(lines[1]?.header).toContain("ade");
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
