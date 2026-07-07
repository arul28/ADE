import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  claudeJsonlToChatEvents,
  codexTurnsToChatEvents,
  deriveImportedChatTitle,
  readTailLines,
} from "./externalChatHistoryImport";

const baseOptions = {
  sessionId: "chat-1",
  provider: "claude" as const,
  externalSessionId: "11111111-2222-3333-4444-555555555555",
  importedAt: Date.parse("2026-07-06T12:00:00.000Z"),
  laneId: "lane-1",
};

describe("claudeJsonlToChatEvents", () => {
  it("tail-reads oversized JSONL and drops the first partial line", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-import-tail-"));
    try {
      const filePath = path.join(root, "session.jsonl");
      const first = JSON.stringify({ message: { role: "user", content: "first" } });
      const second = JSON.stringify({ message: { role: "user", content: "second" } });
      const third = JSON.stringify({ message: { role: "user", content: "third" } });
      fs.writeFileSync(filePath, `${first}\n${second}\n${third}\n`, "utf8");

      const maxBytes = Buffer.byteLength(`${second.slice(4)}\n${third}\n`, "utf8");
      const result = readTailLines(filePath, maxBytes);

      expect(result.truncated).toBe(true);
      expect(result.lines).toEqual([third]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("maps Claude JSONL user, assistant, and tool blocks into chat events", () => {
    const lines = [
      JSON.stringify({
        type: "user",
        uuid: "user-1",
        timestamp: "2026-07-06T10:00:00.000Z",
        cwd: "/Users/admin/Projects/ADE",
        sessionId: "11111111-2222-3333-4444-555555555555",
        message: {
          role: "user",
          content: [{ type: "text", text: "Please inspect the failing test." }],
        },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "assistant-1",
        timestamp: "2026-07-06T10:00:02.000Z",
        cwd: "/Users/admin/Projects/ADE",
        sessionId: "11111111-2222-3333-4444-555555555555",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "private reasoning omitted" },
            { type: "text", text: "I will check the test output." },
            { type: "tool_use", id: "toolu_01", name: "Bash", input: { command: "npm test" } },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        uuid: "user-2",
        timestamp: "2026-07-06T10:00:04.000Z",
        cwd: "/Users/admin/Projects/ADE",
        sessionId: "11111111-2222-3333-4444-555555555555",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "1 failed test" }],
        },
      }),
    ];

    const events = claudeJsonlToChatEvents(lines, baseOptions);

    expect(events.map((envelope) => envelope.event.type)).toEqual([
      "system_notice",
      "user_message",
      "text",
      "tool_call",
      "tool_result",
    ]);
    expect(events[0]!.event).toMatchObject({
      type: "system_notice",
      message: "Session imported from claude CLI (11111111)",
    });
    expect(events[1]!.event).toMatchObject({ type: "user_message", text: "Please inspect the failing test." });
    expect(events[2]!.event).toMatchObject({ type: "text", text: "I will check the test output." });
    expect(events[3]!.event).toMatchObject({ type: "tool_call", tool: "Bash", itemId: "toolu_01" });
    expect(events[4]!.event).toMatchObject({ type: "tool_result", itemId: "toolu_01", result: "1 failed test" });
  });

  it("caps pathological Claude imports and keeps the newest content messages plus notices", () => {
    const lines = Array.from({ length: 5 }, (_, index) => JSON.stringify({
      type: "user",
      uuid: `user-${index}`,
      timestamp: `2026-07-06T10:00:0${index}.000Z`,
      message: { role: "user", content: [{ type: "text", text: `message ${index}` }] },
    }));

    const events = claudeJsonlToChatEvents(lines, { ...baseOptions, maxEvents: 3 });

    expect(events).toHaveLength(5);
    expect(events[0]!.event).toMatchObject({
      type: "system_notice",
      message: "Session imported from claude CLI (11111111)",
    });
    expect(events[1]!.event).toMatchObject({
      type: "system_notice",
      message: "Imported: 2 earlier messages truncated",
    });
    expect(events.slice(2).map((envelope) => envelope.event)).toEqual([
      expect.objectContaining({ type: "user_message", text: "message 2" }),
      expect.objectContaining({ type: "user_message", text: "message 3" }),
      expect.objectContaining({ type: "user_message", text: "message 4" }),
    ]);
  });

  it("adds a byte-level truncation notice when a tail-read was required", () => {
    const events = claudeJsonlToChatEvents([
      JSON.stringify({
        type: "user",
        uuid: "user-tail",
        timestamp: "2026-07-06T10:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "tail message" }] },
      }),
    ], { ...baseOptions, transcriptBytesTruncated: true, transcriptByteLimit: 16 });

    expect(events[0]!.event).toMatchObject({
      type: "system_notice",
      message: "Session imported from claude CLI (11111111)",
    });
    expect(events[1]!.event).toMatchObject({
      type: "system_notice",
      message: "Imported: earlier transcript bytes truncated to the last 16 bytes",
    });
    expect(events.map((envelope) => envelope.event.type)).toEqual([
      "system_notice",
      "system_notice",
      "user_message",
    ]);
  });

  it("keeps both truncation notices when byte and event caps both apply", () => {
    const lines = Array.from({ length: 6 }, (_, index) => JSON.stringify({
      type: "user",
      uuid: `user-${index}`,
      timestamp: `2026-07-06T10:00:0${index}.000Z`,
      message: { role: "user", content: [{ type: "text", text: `message ${index}` }] },
    }));

    const events = claudeJsonlToChatEvents(lines, {
      ...baseOptions,
      maxEvents: 3,
      transcriptBytesTruncated: true,
      transcriptByteLimit: 16,
    });

    expect(events.slice(0, 3).map((envelope) => envelope.event)).toEqual([
      expect.objectContaining({
        type: "system_notice",
        message: "Session imported from claude CLI (11111111)",
      }),
      expect.objectContaining({
        type: "system_notice",
        message: "Imported: earlier transcript bytes truncated to the last 16 bytes",
      }),
      expect.objectContaining({
        type: "system_notice",
        message: "Imported: 3 earlier messages truncated",
      }),
    ]);
    const contentEvents = events.filter((envelope) => envelope.event.type !== "system_notice");
    expect(contentEvents).toHaveLength(3);
    expect(contentEvents.map((envelope) => envelope.event)).toEqual([
      expect.objectContaining({ type: "user_message", text: "message 3" }),
      expect.objectContaining({ type: "user_message", text: "message 4" }),
      expect.objectContaining({ type: "user_message", text: "message 5" }),
    ]);
  });
});

describe("codexTurnsToChatEvents", () => {
  it("maps Codex app-server ThreadItems into chat events", () => {
    const turns = [{
      id: "turn-1",
      startedAt: "2026-07-06T11:00:00.000Z",
      items: [
        { type: "userMessage", id: "item-user", content: [{ type: "input_text", text: "Run the focused test." }] },
        { type: "agentMessage", id: "item-agent", text: "I will run it now." },
        {
          type: "commandExecution",
          id: "item-cmd",
          command: "npm test -- externalChatHistoryImport.test.ts",
          cwd: "/repo/apps/desktop",
          aggregatedOutput: "PASS externalChatHistoryImport.test.ts",
          exitCode: 0,
          status: "completed",
        },
      ],
    }];

    const events = codexTurnsToChatEvents(turns, {
      ...baseOptions,
      provider: "codex",
      externalSessionId: "thread_abc123456789",
    });

    expect(events.map((envelope) => envelope.event.type)).toEqual([
      "system_notice",
      "user_message",
      "text",
      "command",
    ]);
    expect(events[0]!.event).toMatchObject({
      type: "system_notice",
      message: "Session imported from codex CLI (thread_a)",
    });
    expect(events[3]!.event).toMatchObject({
      type: "command",
      command: "npm test -- externalChatHistoryImport.test.ts",
      status: "completed",
      output: "PASS externalChatHistoryImport.test.ts",
    });
  });

  it("maps rollout-style message and function call items", () => {
    const turns = [{
      id: "turn-2",
      items: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "List files." }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "Sure." }] },
        { type: "function_call", call_id: "call-1", name: "shell", arguments: "{\"cmd\":\"ls\"}" },
        { type: "function_call_output", call_id: "call-1", output: "README.md" },
      ],
    }];

    const events = codexTurnsToChatEvents(turns, {
      ...baseOptions,
      provider: "codex",
      externalSessionId: "thread_def456789",
    });

    expect(events.map((envelope) => envelope.event.type)).toEqual([
      "system_notice",
      "user_message",
      "text",
      "tool_call",
      "tool_result",
    ]);
    expect(events[3]!.event).toMatchObject({ type: "tool_call", tool: "shell", args: { cmd: "ls" } });
    expect(events[4]!.event).toMatchObject({ type: "tool_result", result: "README.md" });
  });

  it("derives an imported chat title from the first user message", () => {
    const events = codexTurnsToChatEvents([
      { id: "turn-3", items: [{ type: "userMessage", id: "item-user", content: [{ type: "input_text", text: "Explain the lane status" }] }] },
    ], {
      ...baseOptions,
      provider: "codex",
      externalSessionId: "thread_title",
    });

    expect(deriveImportedChatTitle(events, "codex")).toBe("Explain the lane status");
  });
});
