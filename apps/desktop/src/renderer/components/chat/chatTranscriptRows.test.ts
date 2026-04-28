/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import type { AgentChatEventEnvelope } from "../../../shared/types";
import {
  collapseChatTranscriptEvents,
  collapseChatTranscriptEventsIncremental,
  deriveTurnDividerData,
  eventHasPayload,
  formatStructuredValue,
  groupConsecutiveWorkLogRows,
  readRecord,
  summarizeDiffStats,
  summarizeInlineText,
} from "./chatTranscriptRows";

function groupEvents(events: AgentChatEventEnvelope[]) {
  return groupConsecutiveWorkLogRows(collapseChatTranscriptEvents(events));
}

describe("chatTranscriptRows", () => {
  it("keeps Claude reasoning blocks split across tool boundaries", () => {
    const grouped = groupEvents([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "reasoning",
          text: "First thought.",
          itemId: "reasoning-1",
          turnId: "turn-1",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "tool_call",
          tool: "functions.exec_command",
          args: { cmd: "pwd" },
          itemId: "tool-1",
          turnId: "turn-1",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:02.000Z",
        event: {
          type: "reasoning",
          text: "Second thought.",
          itemId: "reasoning-2",
          turnId: "turn-1",
        },
      },
    ]);

    expect(grouped).toHaveLength(3);
    expect(grouped[0]!.event.type).toBe("reasoning");
    expect(grouped[1]!.event.type).toBe("work_log_group");
    expect(grouped[2]!.event.type).toBe("reasoning");
  });

  it("collapses Claude and Codex tool lifecycles into one work-log entry", () => {
    const rows = collapseChatTranscriptEvents([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "tool_call",
          tool: "functions.exec_command",
          args: { cmd: "pwd" },
          itemId: "tool-1",
          turnId: "turn-1",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "tool_result",
          tool: "functions.exec_command",
          result: { stdout: "/tmp/project" },
          itemId: "tool-1",
          turnId: "turn-1",
          status: "completed",
        },
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.event.type).toBe("work_log_entry");
    if (rows[0]!.event.type !== "work_log_entry") {
      throw new Error("Expected a work log entry");
    }
    expect(rows[0]!.event.entry.status).toBe("completed");
    expect(rows[0]!.event.entry.args).toEqual({ cmd: "pwd" });
    expect(rows[0]!.event.entry.result).toEqual({ stdout: "/tmp/project" });
  });

  it("collapses work-log lifecycle events by logicalItemId when raw item ids rotate", () => {
    const rows = collapseChatTranscriptEvents([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "tool_call",
          tool: "functions.exec_command",
          args: { cmd: "pwd" },
          itemId: "tool-start-1",
          logicalItemId: "tool-logical-1",
          turnId: "turn-1",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "tool_result",
          tool: "functions.exec_command",
          result: { stdout: "/tmp/project" },
          itemId: "tool-complete-1",
          logicalItemId: "tool-logical-1",
          turnId: "turn-1",
          status: "completed",
        },
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.event.type).toBe("work_log_entry");
    if (rows[0]!.event.type !== "work_log_entry") {
      throw new Error("Expected a work log entry");
    }
    expect(rows[0]!.event.entry.status).toBe("completed");
    expect(rows[0]!.event.entry.args).toEqual({ cmd: "pwd" });
    expect(rows[0]!.event.entry.result).toEqual({ stdout: "/tmp/project" });
  });

  it("preserves the richer tool identity when Cursor updates fall back to generic tool names", () => {
    const rows = collapseChatTranscriptEvents([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "tool_call",
          tool: "memory_search",
          args: { query: "stash", title: "memory_search", kind: "other" },
          itemId: "tool-1",
          turnId: "turn-1",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "tool_result",
          tool: "other",
          result: { totalMatches: 3 },
          itemId: "tool-1",
          turnId: "turn-1",
          status: "completed",
        },
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.event.type).toBe("work_log_entry");
    if (rows[0]!.event.type !== "work_log_entry") {
      throw new Error("Expected a work log entry");
    }
    expect(rows[0]!.event.entry.toolName).toBe("memory_search");
    expect(rows[0]!.event.entry.label).toBe("memory_search");
    expect(rows[0]!.event.entry.status).toBe("completed");
  });

  it("keeps assistant text deltas stable by logical message id across adjacent events", () => {
    const rows = collapseChatTranscriptEvents([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "text",
          text: "Hello",
          messageId: "assistant-message-1",
          itemId: "text-1",
          turnId: "turn-1",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "text",
          text: " world",
          messageId: "assistant-message-1",
          itemId: "text-1",
          turnId: "turn-1",
        },
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.event.type).toBe("text");
    if (rows[0]!.event.type !== "text") {
      throw new Error("Expected a text event");
    }
    expect(rows[0]!.event.text).toBe("Hello world");
    expect(rows[0]!.event.messageId).toBe("assistant-message-1");
  });

  it("hides subagent lifecycle rows and keeps adjacent assistant text merged", () => {
    const rows = collapseChatTranscriptEvents([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "text",
          text: "Hello",
          messageId: "assistant-message-2",
          turnId: "turn-1",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "subagent_started",
          taskId: "agent-1",
          description: "Inspect the current route tree",
          turnId: "turn-1",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:02.000Z",
        event: {
          type: "text",
          text: " world",
          messageId: "assistant-message-2",
          turnId: "turn-1",
        },
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.event.type).toBe("text");
    if (rows[0]!.event.type !== "text") {
      throw new Error("Expected a text event");
    }
    expect(rows[0]!.event.text).toBe("Hello world");
  });

  it("updates streaming command and file-change entries in place instead of stacking", () => {
    const rows = collapseChatTranscriptEvents([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "command",
          command: "npm test",
          cwd: "/Users/admin/project",
          output: "running",
          itemId: "command-1",
          turnId: "turn-1",
          status: "running",
          exitCode: null,
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "command",
          command: "npm test",
          cwd: "/Users/admin/project",
          output: "running\ncompleted",
          itemId: "command-1",
          turnId: "turn-1",
          status: "completed",
          exitCode: 0,
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:02.000Z",
        event: {
          type: "file_change",
          path: "apps/desktop/src/foo.ts",
          diff: "+ const first = true;\n",
          kind: "modify",
          itemId: "file-1",
          turnId: "turn-1",
          status: "running",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:03.000Z",
        event: {
          type: "file_change",
          path: "apps/desktop/src/foo.ts",
          diff: "+ const first = true;\n+ const second = true;\n",
          kind: "modify",
          itemId: "file-1",
          turnId: "turn-1",
          status: "completed",
        },
      },
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]!.event.type).toBe("work_log_entry");
    expect(rows[1]!.event.type).toBe("work_log_entry");

    if (rows[0]!.event.type !== "work_log_entry" || rows[1]!.event.type !== "work_log_entry") {
      throw new Error("Expected work log entries");
    }

    expect(rows[0]!.event.entry.status).toBe("completed");
    expect(rows[0]!.event.entry.output).toBe("running\ncompleted");
    expect(rows[1]!.event.entry.status).toBe("completed");
    expect(rows[1]!.event.entry.changedFiles?.[0]?.diff).toContain("+ const second = true;");
  });

  it("groups mixed tool activity into one shared work-log block", () => {
    const grouped = groupEvents([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "tool_call",
          tool: "functions.exec_command",
          args: { cmd: "pwd" },
          itemId: "tool-1",
          turnId: "turn-1",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "command",
          command: "npm test",
          cwd: "/Users/admin/project",
          output: "ok",
          itemId: "command-1",
          turnId: "turn-1",
          status: "completed",
          exitCode: 0,
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:02.000Z",
        event: {
          type: "file_change",
          path: "apps/desktop/src/foo.ts",
          diff: "+ const a = 1;\n",
          kind: "modify",
          itemId: "file-1",
          turnId: "turn-1",
          status: "completed",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:03.000Z",
        event: {
          type: "web_search",
          query: "latest ADE transcript UI ideas",
          action: "search_query",
          itemId: "web-1",
          turnId: "turn-1",
          status: "completed",
        },
      },
    ]);

    expect(grouped).toHaveLength(1);
    expect(grouped[0]!.event.type).toBe("work_log_group");
    if (grouped[0]!.event.type !== "work_log_group") {
      throw new Error("Expected a work log group");
    }
    expect(grouped[0]!.event.entries.map((entry) => entry.entryKind)).toEqual([
      "tool",
      "command",
      "file_change",
      "web_search",
    ]);
  });

  it("preserves failed tool result detail for expansion", () => {
    const grouped = groupEvents([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "tool_result",
          tool: "functions.exec_command",
          result: { error: "permission denied" },
          itemId: "tool-1",
          turnId: "turn-1",
          status: "failed",
        },
      },
    ]);

    expect(grouped).toHaveLength(1);
    expect(grouped[0]!.event.type).toBe("work_log_group");
    if (grouped[0]!.event.type !== "work_log_group") {
      throw new Error("Expected a work log group");
    }
    expect(grouped[0]!.event.entries[0]!.status).toBe("failed");
    expect(grouped[0]!.event.entries[0]!.result).toEqual({ error: "permission denied" });
  });

  it("merges consecutive reasoning events with same turn/item/summaryIndex into one entry", () => {
    // Build rows that bypass collapse (e.g. from different summaryIndex values that
    // happened to resolve to the same identity after a prior pass). The grouping step
    // should merge them with a "---" separator.
    const rows = [
      {
        key: "s1:0:t0",
        timestamp: "2026-04-08T12:00:00.000Z",
        event: { type: "reasoning" as const, text: "First block.", turnId: "t1", itemId: "r1", summaryIndex: null },
      },
      {
        key: "s1:1:t1",
        timestamp: "2026-04-08T12:00:01.000Z",
        event: { type: "reasoning" as const, text: "Second block.", turnId: "t1", itemId: "r1", summaryIndex: null },
      },
    ];

    const grouped = groupConsecutiveWorkLogRows(rows as any);
    const reasoning = grouped.filter((r) => r.event.type === "reasoning");
    expect(reasoning).toHaveLength(1);
    const text = (reasoning[0]!.event as any).text as string;
    expect(text).toContain("First block.");
    expect(text).toContain("---");
    expect(text).toContain("Second block.");
    // Should use the later timestamp
    expect(reasoning[0]!.timestamp).toBe("2026-04-08T12:00:01.000Z");
  });

  it("does not merge consecutive reasoning events with different itemIds", () => {
    const rows = [
      {
        key: "s1:0:t0",
        timestamp: "2026-04-08T12:00:00.000Z",
        event: { type: "reasoning" as const, text: "Thought A.", turnId: "t1", itemId: "r1" },
      },
      {
        key: "s1:1:t1",
        timestamp: "2026-04-08T12:00:01.000Z",
        event: { type: "reasoning" as const, text: "Thought B.", turnId: "t1", itemId: "r2" },
      },
    ];

    const grouped = groupConsecutiveWorkLogRows(rows as any);
    const reasoning = grouped.filter((r) => r.event.type === "reasoning");
    expect(reasoning).toHaveLength(2);
  });

  it("deduplicates consecutive status events with the same turnStatus, turnId, and message", () => {
    const rows = [
      {
        key: "s1:0:t0",
        timestamp: "2026-04-08T12:00:00.000Z",
        event: { type: "status" as const, turnStatus: "interrupted", turnId: "t1", message: "Stopped" },
      },
      {
        key: "s1:1:t1",
        timestamp: "2026-04-08T12:00:01.000Z",
        event: { type: "status" as const, turnStatus: "interrupted", turnId: "t1", message: "Stopped" },
      },
    ];

    const grouped = groupConsecutiveWorkLogRows(rows as any);
    const statuses = grouped.filter((r) => r.event.type === "status");
    expect(statuses).toHaveLength(1);
    expect(statuses[0]!.timestamp).toBe("2026-04-08T12:00:01.000Z");
  });

  it("keeps consecutive status events with different turnStatus values", () => {
    const rows = [
      {
        key: "s1:0:t0",
        timestamp: "2026-04-08T12:00:00.000Z",
        event: { type: "status" as const, turnStatus: "failed", turnId: "t1", message: "Error" },
      },
      {
        key: "s1:1:t1",
        timestamp: "2026-04-08T12:00:01.000Z",
        event: { type: "status" as const, turnStatus: "interrupted", turnId: "t1", message: "Stopped" },
      },
    ];

    const grouped = groupConsecutiveWorkLogRows(rows as any);
    const statuses = grouped.filter((r) => r.event.type === "status");
    expect(statuses).toHaveLength(2);
  });

  it("absorbs tool_use_summary into the preceding work log group", () => {
    const grouped = groupEvents([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "tool_call",
          tool: "functions.exec_command",
          args: { cmd: "pwd" },
          itemId: "tool-1",
          turnId: "turn-1",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "tool_result",
          tool: "functions.exec_command",
          result: { stdout: "/tmp/project" },
          itemId: "tool-1",
          turnId: "turn-1",
          status: "completed",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:02.000Z",
        event: {
          type: "tool_use_summary",
          summary: "Checked the current working directory",
          toolUseIds: ["tool-1"],
          turnId: "turn-1",
        },
      },
    ]);

    expect(grouped).toHaveLength(1);
    expect(grouped[0]!.event.type).toBe("work_log_group");
    if (grouped[0]!.event.type !== "work_log_group") {
      throw new Error("Expected a work log group");
    }
    expect(grouped[0]!.event.summary).toBe("Checked the current working directory");
    expect(grouped[0]!.event.toolUseIds).toEqual(["tool-1"]);
  });
});

describe("summarizeInlineText", () => {
  it("returns empty string for blank input", () => {
    expect(summarizeInlineText("")).toBe("");
    expect(summarizeInlineText("   ")).toBe("");
  });

  it("trims and collapses whitespace", () => {
    expect(summarizeInlineText("  hello   world  ")).toBe("hello world");
  });

  it("truncates long text with ellipsis", () => {
    const long = "a".repeat(200);
    const result = summarizeInlineText(long, 100);
    expect(result).toHaveLength(103); // 100 + "..."
    expect(result.endsWith("...")).toBe(true);
  });

  it("does not truncate text shorter than maxChars", () => {
    expect(summarizeInlineText("short", 100)).toBe("short");
  });
});

describe("eventHasPayload", () => {
  it("returns false for null and undefined", () => {
    expect(eventHasPayload(null)).toBe(false);
    expect(eventHasPayload(undefined)).toBe(false);
  });

  it("returns false for empty strings and true for non-empty", () => {
    expect(eventHasPayload("")).toBe(false);
    expect(eventHasPayload("  ")).toBe(false);
    expect(eventHasPayload("hello")).toBe(true);
  });

  it("returns true for numbers and booleans", () => {
    expect(eventHasPayload(0)).toBe(true);
    expect(eventHasPayload(42)).toBe(true);
    expect(eventHasPayload(false)).toBe(true);
    expect(eventHasPayload(true)).toBe(true);
  });

  it("returns false for empty arrays and true for non-empty", () => {
    expect(eventHasPayload([])).toBe(false);
    expect(eventHasPayload([1])).toBe(true);
  });

  it("returns false for empty objects and true for non-empty", () => {
    expect(eventHasPayload({})).toBe(false);
    expect(eventHasPayload({ key: "value" })).toBe(true);
  });
});

describe("summarizeDiffStats", () => {
  it("counts additions and deletions from diff lines", () => {
    const diff = "+ const a = 1;\n- const b = 2;\n+ const c = 3;\n";
    const stats = summarizeDiffStats(diff);
    expect(stats.additions).toBe(2);
    expect(stats.deletions).toBe(1);
  });

  it("ignores diff header lines", () => {
    const diff = "+++ a/file.ts\n--- b/file.ts\n@@ -1,3 +1,3 @@\n+ added\n- removed\n";
    const stats = summarizeDiffStats(diff);
    expect(stats.additions).toBe(1);
    expect(stats.deletions).toBe(1);
  });

  it("returns zero counts for empty diff", () => {
    expect(summarizeDiffStats("")).toEqual({ additions: 0, deletions: 0 });
  });

  it("returns zero counts for context-only diff lines", () => {
    const diff = "  unchanged line 1\n  unchanged line 2\n";
    expect(summarizeDiffStats(diff)).toEqual({ additions: 0, deletions: 0 });
  });
});

describe("readRecord", () => {
  it("returns null for non-object values", () => {
    expect(readRecord(null)).toBeNull();
    expect(readRecord(undefined)).toBeNull();
    expect(readRecord("string")).toBeNull();
    expect(readRecord(42)).toBeNull();
    expect(readRecord([1, 2])).toBeNull();
  });

  it("returns the value as a record for plain objects", () => {
    const obj = { key: "value" };
    expect(readRecord(obj)).toBe(obj);
  });
});

describe("formatStructuredValue", () => {
  it("returns strings as-is", () => {
    expect(formatStructuredValue("hello")).toBe("hello");
  });

  it("formats objects as pretty JSON", () => {
    const result = formatStructuredValue({ a: 1, b: "two" });
    expect(result).toBe(JSON.stringify({ a: 1, b: "two" }, null, 2));
  });

  it("formats numbers as their string representation", () => {
    expect(formatStructuredValue(42)).toBe("42");
  });

  it("formats null as JSON null", () => {
    expect(formatStructuredValue(null)).toBe("null");
  });
});

describe("collapseChatTranscriptEventsIncremental", () => {
  it("reuses previous rows and only processes new events", () => {
    const events1: AgentChatEventEnvelope[] = [
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "text",
          text: "Hello",
          messageId: "msg-1",
          itemId: "text-1",
          turnId: "turn-1",
        },
      },
    ];
    const rows1 = collapseChatTranscriptEvents(events1);

    const events2 = [
      ...events1,
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "text" as const,
          text: " World",
          messageId: "msg-2",
          itemId: "text-2",
          turnId: "turn-1",
        },
      },
    ];

    const rows2 = collapseChatTranscriptEventsIncremental(events2, events1, rows1);
    expect(rows2).toHaveLength(2);
    expect(rows2[0]!.event.type).toBe("text");
    expect(rows2[1]!.event.type).toBe("text");
  });

  it("falls back to full recompute when events diverge", () => {
    const events1: AgentChatEventEnvelope[] = [
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: { type: "text", text: "A", itemId: "text-1", turnId: "turn-1" },
      },
    ];
    const rows1 = collapseChatTranscriptEvents(events1);

    // Replace last event with a different one
    const events2: AgentChatEventEnvelope[] = [
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: { type: "text", text: "B", itemId: "text-2", turnId: "turn-1" },
      },
    ];

    const rows2 = collapseChatTranscriptEventsIncremental(events2, events1, rows1);
    expect(rows2).toHaveLength(1);
    if (rows2[0]!.event.type !== "text") throw new Error("Expected text");
    expect(rows2[0]!.event.text).toBe("B");
  });

  it("falls back to full recompute when events shrink", () => {
    const events: AgentChatEventEnvelope[] = [
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: { type: "text", text: "A", itemId: "text-1", turnId: "turn-1" },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: { type: "text", text: "B", itemId: "text-2", turnId: "turn-1" },
      },
    ];
    const rows = collapseChatTranscriptEvents(events);
    const shorter = [events[0]!];
    const result = collapseChatTranscriptEventsIncremental(shorter, events, rows);
    expect(result).toHaveLength(1);
  });
});

describe("deriveTurnDividerData", () => {
  it("accumulates file stats and done event data per turn", () => {
    const events: AgentChatEventEnvelope[] = [
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "status",
          turnStatus: "started",
          turnId: "turn-1",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "file_change",
          path: "foo.ts",
          diff: "+ line\n- old\n",
          kind: "modify",
          itemId: "file-1",
          turnId: "turn-1",
          status: "completed",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:02.000Z",
        event: {
          type: "done",
          turnId: "turn-1",
          status: "completed",
          modelId: "gpt-5.4-codex",
          model: "GPT-5.4",
          usage: {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadTokens: 10,
          },
          costUsd: 0.002,
        },
      },
    ];

    const turns = deriveTurnDividerData(events);
    expect(turns.size).toBe(1);

    const turn = turns.get("turn-1")!;
    expect(turn, "turn-1 should exist in the map").toBeTruthy();
    expect(turn.filesChanged).toBe(1);
    expect(turn.insertions).toBe(1);
    expect(turn.deletions).toBe(1);
    expect(turn.status).toBe("completed");
    expect(turn.model).toBe("GPT-5.4");
    expect(turn.modelId).toBe("gpt-5.4-codex");
    expect(turn.inputTokens).toBe(100);
    expect(turn.outputTokens).toBe(50);
    expect(turn.cacheReadTokens).toBe(10);
    expect(turn.costUsd).toBe(0.002);
  });

  it("ignores running file changes", () => {
    const events: AgentChatEventEnvelope[] = [
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "file_change",
          path: "foo.ts",
          diff: "+ line\n",
          kind: "modify",
          itemId: "file-1",
          turnId: "turn-1",
          status: "running",
        },
      },
    ];

    const turns = deriveTurnDividerData(events);
    const turn = turns.get("turn-1")!;
    expect(turn.filesChanged).toBe(0);
  });

  it("skips events without turnId", () => {
    const events: AgentChatEventEnvelope[] = [
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: { type: "error", message: "boom" },
      },
    ];

    const turns = deriveTurnDividerData(events);
    expect(turns.size).toBe(0);
  });

  it("tracks multiple turns independently", () => {
    const events: AgentChatEventEnvelope[] = [
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "file_change",
          path: "a.ts",
          diff: "+ a\n",
          kind: "modify",
          itemId: "file-1",
          turnId: "turn-1",
          status: "completed",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "file_change",
          path: "b.ts",
          diff: "+ b\n+ c\n",
          kind: "modify",
          itemId: "file-2",
          turnId: "turn-2",
          status: "completed",
        },
      },
    ];

    const turns = deriveTurnDividerData(events);
    expect(turns.size).toBe(2);
    expect(turns.get("turn-1")!.filesChanged).toBe(1);
    expect(turns.get("turn-1")!.insertions).toBe(1);
    expect(turns.get("turn-2")!.filesChanged).toBe(1);
    expect(turns.get("turn-2")!.insertions).toBe(2);
  });
});

describe("chatTranscriptRows edge cases", () => {
  it("filters out step_boundary and activity events", () => {
    const rows = collapseChatTranscriptEvents([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: { type: "step_boundary", stepNumber: 1 },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: { type: "activity", activity: "reading", detail: "foo.ts", turnId: "turn-1" },
      },
    ]);
    expect(rows).toHaveLength(0);
  });

  it("filters out 'session ready' system notices", () => {
    const rows = collapseChatTranscriptEvents([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "system_notice",
          noticeKind: "info",
          message: "Session ready",
        },
      },
    ]);
    expect(rows).toHaveLength(0);
  });

  it("filters out duplicate identical system notices within the same turn", () => {
    const rows = collapseChatTranscriptEvents([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "system_notice",
          noticeKind: "info",
          message: "Agent mode: plan",
          turnId: "turn-1",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "system_notice",
          noticeKind: "info",
          message: "Agent mode: plan",
          turnId: "turn-1",
        },
      },
    ]);
    expect(rows).toHaveLength(1);
  });

  it("filters standalone whitespace-only assistant text chunks", () => {
    const rows = collapseChatTranscriptEvents([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "text",
          text: "\n\n\n",
          messageId: "msg-1",
          itemId: "text-1",
          turnId: "turn-1",
        },
      },
    ]);
    expect(rows).toHaveLength(0);
  });

  it("keeps failed and interrupted status events", () => {
    const rows = collapseChatTranscriptEvents([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "status",
          turnStatus: "failed",
          turnId: "turn-1",
          message: "something broke",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "status",
          turnStatus: "interrupted",
          turnId: "turn-2",
        },
      },
    ]);
    expect(rows).toHaveLength(2);
  });

  it("filters out redundant started/completed status events with no informative message", () => {
    const rows = collapseChatTranscriptEvents([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "status",
          turnStatus: "started",
          turnId: "turn-1",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "status",
          turnStatus: "completed",
          turnId: "turn-1",
        },
      },
    ]);
    expect(rows).toHaveLength(0);
  });

  it("merges reasoning blocks with the same itemId", () => {
    const rows = collapseChatTranscriptEvents([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "reasoning",
          text: "Part 1. ",
          itemId: "reasoning-1",
          turnId: "turn-1",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "reasoning",
          text: "Part 2.",
          itemId: "reasoning-1",
          turnId: "turn-1",
        },
      },
    ]);
    expect(rows).toHaveLength(1);
    if (rows[0]!.event.type !== "reasoning") throw new Error("Expected reasoning");
    expect(rows[0]!.event.text).toBe("Part 1. Part 2.");
  });

  it("hides raw subagent_progress rows from the transcript", () => {
    const rows = collapseChatTranscriptEvents([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "subagent_progress",
          taskId: "task-1",
          turnId: "turn-1",
          summary: "Working on it...",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "subagent_progress",
          taskId: "task-1",
          turnId: "turn-1",
          summary: "Almost done.",
        },
      },
    ]);
    expect(rows).toHaveLength(0);
  });

  it("collapses todo_update events within the same turn", () => {
    const rows = collapseChatTranscriptEvents([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "todo_update",
          turnId: "turn-1",
          items: [{ id: "t-1", description: "Task 1", status: "in_progress" }],
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "todo_update",
          turnId: "turn-1",
          items: [
            { id: "t-1", description: "Task 1", status: "completed" },
            { id: "t-2", description: "Task 2", status: "in_progress" },
          ],
        },
      },
    ]);
    expect(rows).toHaveLength(1);
    if (rows[0]!.event.type !== "todo_update") throw new Error("Expected todo_update");
    expect(rows[0]!.event.items).toHaveLength(2);
  });

  it("builds web_search work log entries", () => {
    const rows = collapseChatTranscriptEvents([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "web_search",
          query: "typescript patterns",
          action: "search_query",
          itemId: "web-1",
          turnId: "turn-1",
          status: "completed",
        },
      },
    ]);
    expect(rows).toHaveLength(1);
    if (rows[0]!.event.type !== "work_log_entry") throw new Error("Expected work_log_entry");
    expect(rows[0]!.event.entry.entryKind).toBe("web_search");
    expect(rows[0]!.event.entry.query).toBe("typescript patterns");
  });
});
