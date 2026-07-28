/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import type { AgentChatEventEnvelope } from "../../../shared/types";
import {
  collapseChatTranscriptEvents,
  collapseChatTranscriptEventsIncremental,
  collapseChatTranscriptEventsIncrementalWithContext,
  collapseChatTranscriptEventsWithContext,
  collapseGroupedActivityPhaseRows,
  countRowsAppendedSince,
  deriveTurnDividerData,
  deriveWebSearchResultDisplay,
  extractLocalhostUrlsFromText,
  eventHasPayload,
  formatStructuredValue,
  groupChatTranscriptRows,
  mergeAdjacentActivityBundleRows,
  groupConsecutiveWorkLogRows,
  readRecord,
  shouldCollapseUserMessageText,
  summarizeDiffStats,
  summarizeInlineText,
} from "./chatTranscriptRows";

function groupEvents(events: AgentChatEventEnvelope[]) {
  return groupChatTranscriptRows(collapseChatTranscriptEvents(events));
}

describe("chatTranscriptRows", () => {
  it("collapses duplicate semantic failures for the same turn without hiding distinct errors", () => {
    const base = {
      sessionId: "session-1",
      timestamp: "2026-07-10T18:18:53.000Z",
    };
    const duplicateFailure = {
      type: "error" as const,
      message: "Selected model is at capacity. Please try a different model.",
      turnId: "turn-capacity",
      errorInfo: "serverOverloaded",
    };
    const rows = collapseChatTranscriptEvents([
      { ...base, sequence: 1, event: duplicateFailure },
      { ...base, sequence: 2, event: { ...duplicateFailure } },
      {
        ...base,
        sequence: 3,
        event: {
          type: "error",
          message: "A separate transport failure occurred.",
          turnId: "turn-capacity",
          errorInfo: "responseStreamDisconnected",
        },
      },
    ]);

    expect(rows.filter((row) => row.event.type === "error")).toHaveLength(2);
    expect(rows.map((row) => row.event.type === "error" ? row.event.message : null)).toEqual([
      duplicateFailure.message,
      "A separate transport failure occurred.",
    ]);
    expect(rows[1]?.event).toEqual(expect.objectContaining({
      type: "error",
      errorInfo: "responseStreamDisconnected",
    }));
  });

  it("extracts and normalizes localhost URLs from tool output text", () => {
    expect(
      extractLocalhostUrlsFromText("Local: http://localhost:5173/\nNetwork: http://0.0.0.0:5173/"),
    ).toEqual([
      {
        url: "http://localhost:5173/",
        href: "http://localhost:5173/",
        host: "localhost",
        port: 5173,
      },
    ]);
  });

  it("collapses alternating reasoning and tool bursts into merged activity rows", () => {
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
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:03.000Z",
        event: {
          type: "tool_call",
          tool: "Read",
          args: { path: "foo.ts" },
          itemId: "tool-2",
          turnId: "turn-1",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:04.000Z",
        event: {
          type: "reasoning",
          text: "Third thought.",
          itemId: "reasoning-3",
          turnId: "turn-1",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:05.000Z",
        event: {
          type: "tool_call",
          tool: "Edit",
          args: { path: "bar.ts" },
          itemId: "tool-3",
          turnId: "turn-1",
        },
      },
    ]);

    expect(grouped).toHaveLength(2);
    expect(grouped[0]!.event.type).toBe("reasoning");
    expect(grouped[1]!.event.type).toBe("work_log_group");
    if (grouped[0]!.event.type === "reasoning") {
      expect(grouped[0]!.event.text).toContain("First thought.");
      expect(grouped[0]!.event.text).toContain("Second thought.");
      expect(grouped[0]!.event.text).toContain("Third thought.");
    }
    if (grouped[1]!.event.type === "work_log_group") {
      expect(grouped[1]!.event.entries).toHaveLength(3);
    }
  });

  it("keeps a simple thought + tool pair as separate rows", () => {
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
    ]);

    expect(grouped).toHaveLength(2);
    expect(grouped[0]!.event.type).toBe("reasoning");
    expect(grouped[1]!.event.type).toBe("work_log_group");
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
          tool: "git_status",
          args: { porcelain: true, title: "git_status", kind: "other" },
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
    expect(rows[0]!.event.entry.toolName).toBe("git_status");
    expect(rows[0]!.event.entry.label).toBe("git_status");
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

  it("renders a real subagent spawn as its own anchor row between assistant text", () => {
    const rows = groupEvents([
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
          agentType: "Explore",
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

    expect(rows).toHaveLength(3);
    expect(rows[0]!.event.type).toBe("text");
    expect(rows[1]!.event.type).toBe("subagent_spawn_anchor");
    expect(rows[2]!.event.type).toBe("text");
    if (rows[0]!.event.type !== "text" || rows[1]!.event.type !== "subagent_spawn_anchor" || rows[2]!.event.type !== "text") {
      throw new Error("Expected text / spawn anchor / text");
    }
    expect(rows[0]!.event.text).toBe("Hello");
    expect(rows[1]!.event.agentKey).toBe("agent-1");
    expect(rows[1]!.event.description).toBe("Inspect the current route tree");
    expect(rows[1]!.event.agentType).toBe("Explore");
    expect(rows[1]!.key).toBe("subagent-spawn:agent-1");
    expect(rows[2]!.event.text).toBe(" world");
  });

  it("threads childSessionId and spawnKind onto a spawned-ADE-chat anchor", () => {
    const rows = collapseChatTranscriptEvents([
      {
        sessionId: "parent-session",
        timestamp: "2026-07-14T10:00:00.000Z",
        event: {
          type: "subagent_started",
          taskId: "chat:child-123",
          agentId: "child-123",
          agentType: "claude",
          description: "Wave 2 UI",
          spawnKind: "peer",
          taskType: "subagent",
        },
      },
    ]);

    expect(rows).toHaveLength(1);
    const anchor = rows[0]!.event;
    if (anchor.type !== "subagent_spawn_anchor") throw new Error("Expected spawn anchor");
    expect(anchor.childSessionId).toBe("child-123");
    expect(anchor.spawnKind).toBe("peer");
    expect(anchor.agentType).toBe("claude");
  });

  it("keeps a navigable spawn card when the canonical dot twin follows the underscore event", () => {
    // Both events share the agentId identity key; the dot twin's taskId is bare
    // (no `chat:` prefix), so the anchor must retain the childSessionId derived
    // from the underscore event.
    const rows = collapseChatTranscriptEvents([
      {
        sessionId: "parent-session",
        timestamp: "2026-07-18T04:10:54.789Z",
        event: {
          type: "subagent_started",
          taskId: "chat:child-123",
          agentId: "child-123",
          agentType: "codex",
          description: "Codex Chat",
          spawnKind: "subagent",
        },
      },
      {
        sessionId: "parent-session",
        timestamp: "2026-07-18T04:10:54.900Z",
        event: {
          type: "subagent.started",
          agentId: "child-123",
          agentType: "codex",
          description: "Codex Chat",
        },
      },
    ]);

    expect(rows).toHaveLength(1);
    const anchor = rows[0]!.event;
    if (anchor.type !== "subagent_spawn_anchor") throw new Error("Expected spawn anchor");
    expect(anchor.childSessionId).toBe("child-123");
    expect(anchor.spawnKind).toBe("subagent");
  });

  it("keeps a navigable spawn card when the dot twin precedes the underscore event", () => {
    const rows = collapseChatTranscriptEvents([
      {
        sessionId: "parent-session",
        timestamp: "2026-07-18T04:10:54.700Z",
        event: {
          type: "subagent.started",
          agentId: "child-123",
          agentType: "codex",
          description: "Codex Chat",
        },
      },
      {
        sessionId: "parent-session",
        timestamp: "2026-07-18T04:10:54.789Z",
        event: {
          type: "subagent_started",
          taskId: "chat:child-123",
          agentId: "child-123",
          agentType: "codex",
          description: "Codex Chat",
          spawnKind: "subagent",
        },
      },
    ]);

    expect(rows).toHaveLength(1);
    const anchor = rows[0]!.event;
    if (anchor.type !== "subagent_spawn_anchor") throw new Error("Expected spawn anchor");
    expect(anchor.childSessionId).toBe("child-123");
    expect(anchor.spawnKind).toBe("subagent");
  });

  it("leaves childSessionId/spawnKind null for a runtime-native subagent", () => {
    const rows = collapseChatTranscriptEvents([
      {
        sessionId: "session-1",
        timestamp: "2026-07-14T10:00:00.000Z",
        event: {
          type: "subagent_started",
          taskId: "agent-native",
          agentType: "Explore",
          description: "Search the tree",
        },
      },
    ]);

    const anchor = rows[0]!.event;
    if (anchor.type !== "subagent_spawn_anchor") throw new Error("Expected spawn anchor");
    expect(anchor.childSessionId).toBeNull();
    expect(anchor.spawnKind).toBeNull();
  });

  it("emits a spawn-wake divider above a subagent completion wake turn", () => {
    const rows = collapseChatTranscriptEvents([
      {
        sessionId: "parent-session",
        timestamp: "2026-07-14T10:00:00.000Z",
        event: {
          type: "user_message",
          text: 'Your subagent "Docs" finished — done.',
          turnId: "turn-wake",
          metadata: {
            spawnCompletion: {
              childSessionId: "child-9",
              childTitle: "Docs",
              spawnKind: "subagent",
              status: "completed",
              summary: "Wrote the docs.",
            },
          },
        },
      },
    ]);

    const divider = rows.find((row) => row.event.type === "spawn_wake_divider");
    expect(divider).toBeTruthy();
    if (!divider || divider.event.type !== "spawn_wake_divider") throw new Error("Expected spawn_wake_divider");
    expect(divider.event.childSessionId).toBe("child-9");
    expect(divider.event.childTitle).toBe("Docs");
    expect(divider.event.summary).toBe("Wrote the docs.");
    // The synthetic wake user turn still renders below the divider.
    expect(rows.some((row) => row.event.type === "user_message")).toBe(true);
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

  it("carries detected localhost URLs through merged command output deltas", () => {
    const rows = collapseChatTranscriptEvents([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "command",
          command: "npm run dev",
          cwd: "/Users/admin/project",
          output: "starting vite\n",
          itemId: "command-1",
          turnId: "turn-1",
          status: "running",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "command",
          command: "npm run dev",
          cwd: "/Users/admin/project",
          output: "Local: http://127.0.0.1:5173/\n",
          itemId: "command-1",
          turnId: "turn-1",
          status: "running",
        },
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.event.type).toBe("work_log_entry");
    if (rows[0]!.event.type !== "work_log_entry") {
      throw new Error("Expected a work log entry");
    }
    expect(rows[0]!.event.entry.localUrls).toEqual([
      {
        url: "http://127.0.0.1:5173/",
        href: "http://localhost:5173/",
        host: "127.0.0.1",
        port: 5173,
      },
    ]);
  });

  it("detects localhost URLs from structured tool results, not only command events", () => {
    const rows = collapseChatTranscriptEvents([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "tool_result",
          tool: "functions.exec_command",
          result: {
            stdout: "server ready at http://localhost:3000/",
          },
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
    expect(rows[0]!.event.entry.localUrls?.map((url) => url.href)).toEqual([
      "http://localhost:3000/",
    ]);
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

  it("retains MCP connector identity and action on compact tool rows", () => {
    const rows = collapseChatTranscriptEvents([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "tool_call",
          tool: "github:search_issues",
          args: { query: "is:open label:bug" },
          mcp: {
            server: "github",
            tool: "search_issues",
            appContext: { appName: "GitHub", actionName: "Search issues" },
          },
          itemId: "mcp-1",
          turnId: "turn-1",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "tool_result",
          tool: "github:search_issues",
          result: "Issue 1",
          mcp: {
            server: "github",
            tool: "search_issues",
            appContext: { appName: "GitHub", actionName: "Search issues" },
          },
          itemId: "mcp-1",
          turnId: "turn-1",
          status: "completed",
        },
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.event.type).toBe("work_log_entry");
    if (rows[0]!.event.type !== "work_log_entry") throw new Error("Expected work log entry");
    expect(rows[0]!.event.entry).toMatchObject({
      label: "GitHub",
      detail: "Search issues",
      status: "completed",
      mcp: { server: "github", tool: "search_issues" },
    });
  });

  it("collapses image generation lifecycle updates into one completed card", () => {
    const rows = collapseChatTranscriptEvents([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "codex_image_generation",
          itemId: "image-1",
          turnId: "turn-1",
          prompt: "A tiny moon icon",
          status: "running",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "codex_image_generation",
          itemId: "image-1",
          turnId: "turn-1",
          revisedPrompt: "A crisp crescent moon icon",
          result: "/tmp/moon.png",
          savedPath: "/tmp/moon.png",
          status: "completed",
        },
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.event).toMatchObject({
      type: "codex_image_generation",
      itemId: "image-1",
      prompt: "A tiny moon icon",
      revisedPrompt: "A crisp crescent moon icon",
      result: "/tmp/moon.png",
      status: "completed",
    });
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

describe("shouldCollapseUserMessageText", () => {
  it("collapses past 600 characters", () => {
    expect(shouldCollapseUserMessageText("x".repeat(600))).toBe(false);
    expect(shouldCollapseUserMessageText("x".repeat(601))).toBe(true);
  });

  it("collapses past 8 lines", () => {
    expect(shouldCollapseUserMessageText(Array.from({ length: 8 }, () => "line").join("\n"))).toBe(false);
    expect(shouldCollapseUserMessageText(Array.from({ length: 9 }, () => "line").join("\n"))).toBe(true);
  });

  it("never collapses empty or whitespace-only text", () => {
    expect(shouldCollapseUserMessageText("")).toBe(false);
    expect(shouldCollapseUserMessageText("   \n\n\n\n\n\n\n\n\n\n  ")).toBe(false);
  });
});

describe("countRowsAppendedSince", () => {
  it("counts rows after the anchor", () => {
    expect(countRowsAppendedSince(["a", "b", "c", "d"], "b")).toBe(2);
    expect(countRowsAppendedSince(["a", "b", "c"], "c")).toBe(0);
  });

  it("returns 0 for a null or missing anchor", () => {
    expect(countRowsAppendedSince(["a", "b"], null)).toBe(0);
    expect(countRowsAppendedSince(["a", "b"], "regrouped-away")).toBe(0);
    expect(countRowsAppendedSince([], "a")).toBe(0);
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

  it("does not report exact line counts from a compacted stored diff preview", () => {
    const diff = [
      "[ADE] Large file diff was shortened for stored chat history.",
      "Original size: 120000 bytes. Full content was not stored.",
      "",
      "----- BEGIN FIRST PREVIEW -----",
      "+ first preview line",
      "- first removed line",
      "----- END FIRST PREVIEW -----",
      "",
      "[ADE] 87000 bytes omitted from stored chat history.",
      "",
      "----- BEGIN LAST PREVIEW -----",
      "+ last preview line",
      "- last removed line",
      "----- END LAST PREVIEW -----",
    ].join("\n");

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
          modelId: "gpt-5.4",
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
    expect(turn.modelId).toBe("gpt-5.4");
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

  it("keeps Codex goal lifecycle events visible", () => {
    const rows = collapseChatTranscriptEvents([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "codex_goal_updated",
          goal: { objective: "Ship CLI parity", status: "active", tokenBudget: null },
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: { type: "codex_goal_cleared" },
      },
    ]);
    expect(rows.map((row) => row.event.type)).toEqual([
      "codex_goal_updated",
      "codex_goal_cleared",
    ]);
  });

  it("filters out low-value system notices", () => {
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
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "system_notice",
          noticeKind: "hook",
          message: "Hook: SessionStart:startup started",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:02.000Z",
        event: {
          type: "system_notice",
          noticeKind: "hook",
          message: "Trimmed large tool output before sending it back to Claude.",
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

  it("keeps populated plan steps when a streaming delta updates the same turn", () => {
    const rows = collapseChatTranscriptEvents([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "plan",
          turnId: "turn-1",
          itemId: "plan-1",
          state: "updated",
          explanation: "Implementation plan",
          steps: [{ text: "Wire the command", status: "completed" }],
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "plan",
          turnId: "turn-1",
          itemId: "plan-1",
          state: "delta",
          streamingText: "Streaming the next detail",
          steps: [],
        },
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.event.type).toBe("plan");
    if (rows[0]!.event.type !== "plan") {
      throw new Error("Expected merged plan row");
    }
    expect(rows[0]!.event.steps).toEqual([{ text: "Wire the command", status: "completed" }]);
    expect(rows[0]!.event.explanation).toBe("Implementation plan");
    expect(rows[0]!.event.streamingText).toBe("Streaming the next detail");
  });

  it("clears live plan text when structured plan steps arrive", () => {
    const rows = collapseChatTranscriptEvents([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "plan",
          turnId: "turn-1",
          itemId: "plan-1",
          state: "delta",
          streamingText: "Drafting the plan",
          steps: [],
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "plan",
          turnId: "turn-1",
          itemId: "plan-1",
          state: "updated",
          explanation: "Implementation plan",
          steps: [{ text: "Wire the command", status: "completed" }],
        },
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.event.type).toBe("plan");
    if (rows[0]!.event.type !== "plan") {
      throw new Error("Expected merged plan row");
    }
    expect(rows[0]!.event.steps).toEqual([{ text: "Wire the command", status: "completed" }]);
    expect(rows[0]!.event.explanation).toBe("Implementation plan");
    expect(rows[0]!.event.streamingText).toBeUndefined();
  });

  it("preserves plan item identity when a structured update omits it", () => {
    const rows = collapseChatTranscriptEvents([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "plan",
          turnId: "turn-1",
          itemId: "plan-1",
          state: "delta",
          streamingText: "Drafting the plan",
          steps: [],
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "plan",
          turnId: "turn-1",
          steps: [{ text: "Wire the command", status: "completed" }],
        },
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.event.type).toBe("plan");
    if (rows[0]!.event.type !== "plan") {
      throw new Error("Expected merged plan row");
    }
    expect(rows[0]!.event.itemId).toBe("plan-1");
    expect(rows[0]!.event.state).toBe("updated");
    expect(rows[0]!.event.streamingText).toBeUndefined();
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

  it("folds consecutive subagent progress rows into a single mutated spawn anchor", () => {
    const rows = groupEvents([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "subagent_progress",
          taskId: "task-1",
          turnId: "turn-1",
          summary: "Working...",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "subagent_progress",
          taskId: "task-1",
          turnId: "turn-1",
          summary: "Almost done, wrapping up.",
        },
      },
    ]);
    expect(rows).toHaveLength(1);
    if (rows[0]!.event.type !== "subagent_spawn_anchor") throw new Error("Expected subagent_spawn_anchor");
    expect(rows[0]!.event.agentKey).toBe("task-1");
    expect(rows[0]!.event.status).toBe("running");
    // The live status line reflects the last meaningful progress summary
    // (preferSubagentSummary keeps the richer of two real summaries).
    expect(rows[0]!.event.statusLine).toBe("Almost done, wrapping up.");
  });

  it("renders todo_update deltas within the same turn", () => {
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
    expect(rows).toHaveLength(2);
    if (rows[0]!.event.type !== "todo_update") throw new Error("Expected todo_update");
    if (rows[1]!.event.type !== "todo_update") throw new Error("Expected todo_update");
    expect(rows[0]!.event.items).toEqual([
      { id: "t-1", description: "Task 1", status: "in_progress" },
    ]);
    expect(rows[1]!.event.items).toEqual([
      { id: "t-1", description: "Task 1", status: "completed" },
      { id: "t-2", description: "Task 2", status: "in_progress" },
    ]);
  });

  it("bundles adjacent task + scheduled work but renders subagents as separate cards", () => {
    const rows = groupEvents([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "todo_update",
          turnId: "turn-1",
          items: [{ id: "task-1", description: "Inspect chat activity", status: "in_progress" }],
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "scheduled_work_update",
          id: "cron-1",
          kind: "cron",
          status: "scheduled",
          title: "Follow-up cron",
          turnId: "turn-1",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:02.000Z",
        event: {
          type: "subagent_started",
          taskId: "agent-1",
          agentType: "Explore",
          description: "Review transcript grouping",
          turnId: "turn-1",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:03.000Z",
        event: {
          type: "subagent_result",
          taskId: "workflow-1",
          taskType: "local_workflow",
          workflowName: "Quality pass",
          status: "completed",
          summary: "Quality pass completed",
          turnId: "turn-1",
        },
      },
    ]);

    // todo + cron bundle; the subagent start/result render as their own cards.
    expect(rows.map((row) => row.event.type)).toEqual([
      "activity_bundle",
      "subagent_spawn_anchor",
      "subagent_result_card",
    ]);
    if (rows[0]!.event.type !== "activity_bundle") throw new Error("Expected activity_bundle");
    expect(rows[0]!.event.items.map((item) => item.event.type)).toEqual([
      "todo_update",
      "scheduled_work_update",
    ]);
  });

  it("normalizes canonical dotted subagent lifecycle events into spawn + result cards", () => {
    const rows = groupEvents([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "subagent.started",
          agentId: "agent-canonical",
          agentType: "Explore",
          parentToolUseId: "call-spawn",
          description: "Inspect canonical lifecycle events",
          turnId: "turn-1",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "subagent.completed",
          agentId: "agent-canonical",
          agentType: "Explore",
          parentToolUseId: "call-spawn",
          summary: "Canonical lifecycle mapped.",
          status: "completed",
          turnId: "turn-1",
        },
      },
    ]);

    expect(rows.map((row) => row.event.type)).toEqual([
      "subagent_spawn_anchor",
      "subagent_result_card",
    ]);
    if (rows[0]!.event.type !== "subagent_spawn_anchor") throw new Error("Expected spawn anchor");
    expect(rows[0]!.event.agentKey).toBe("agent-canonical");
    expect(rows[0]!.event.status).toBe("completed");
    if (rows[1]!.event.type !== "subagent_result_card") throw new Error("Expected result card");
    expect(rows[1]!.event.summaryPreview).toBe("Canonical lifecycle mapped.");
  });

  it("gives each subagent its own stable spawn anchor row", () => {
    const rows = groupEvents([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "subagent_started",
          taskId: "agent-1",
          agentType: "Explore",
          description: "First turn",
          turnId: "turn-1",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "subagent_started",
          taskId: "agent-2",
          agentType: "Explore",
          description: "Second turn",
          turnId: "turn-2",
        },
      },
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]!.event.type).toBe("subagent_spawn_anchor");
    expect(rows[1]!.event.type).toBe("subagent_spawn_anchor");
    expect(rows[0]!.key).toBe("subagent-spawn:agent-1");
    expect(rows[1]!.key).toBe("subagent-spawn:agent-2");
  });

  it("keeps activity bundles separated when turn ids are missing", () => {
    const rows = groupEvents([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "todo_update",
          items: [{ id: "task-1", description: "First unknown turn task", status: "in_progress" }],
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "scheduled_work_update",
          id: "cron-1",
          kind: "cron",
          status: "scheduled",
          title: "Unknown turn cron",
        },
      },
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]!.event.type).toBe("activity_bundle");
    expect(rows[1]!.event.type).toBe("activity_bundle");
    if (rows[0]!.event.type !== "activity_bundle" || rows[1]!.event.type !== "activity_bundle") {
      throw new Error("Expected activity bundles");
    }
    expect(rows[0]!.event.items).toHaveLength(1);
    expect(rows[1]!.event.items).toHaveLength(1);
  });

  it("rejoins same-turn task cards after a hidden tool-only row is filtered", () => {
    const grouped = groupEvents([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "todo_update",
          turnId: "turn-1",
          items: [{ id: "task-1", description: "Inspect", status: "completed" }],
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
          type: "todo_update",
          turnId: "turn-1",
          items: [{ id: "task-2", description: "Implement", status: "in_progress" }],
        },
      },
    ]);

    expect(grouped.map((row) => row.event.type)).toEqual([
      "activity_bundle",
      "work_log_group",
      "activity_bundle",
    ]);
    const visible = mergeAdjacentActivityBundleRows(
      grouped.filter((row) => row.event.type !== "work_log_group"),
    );
    expect(visible).toHaveLength(1);
    expect(visible[0]!.key).toBe(grouped[0]!.key);
    expect(visible[0]!.timestamp).toBe("2026-03-17T10:00:02.000Z");
    if (visible[0]!.event.type !== "activity_bundle") throw new Error("Expected activity_bundle");
    expect(visible[0]!.event.items.map((item) => item.event.type)).toEqual([
      "todo_update",
      "todo_update",
    ]);
  });

  it("batches Claude PreToolUse hook errors into compact work-log groups", () => {
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
          type: "system_notice",
          noticeKind: "hook",
          message: "Hook: PreToolUse:Bash error",
          detail: "Command rejected by hook",
          turnId: "turn-1",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:02.000Z",
        event: {
          type: "system_notice",
          noticeKind: "hook",
          message: "Hook: PreToolUse:Read error",
          detail: "Read rejected by hook",
          turnId: "turn-1",
        },
      },
    ]);

    expect(grouped).toHaveLength(1);
    expect(grouped[0]!.event.type).toBe("work_log_group");
    if (grouped[0]!.event.type !== "work_log_group") {
      throw new Error("Expected a work log group");
    }
    expect(grouped[0]!.event.entries.map((entry) => entry.entryKind)).toEqual(["tool", "hook", "hook"]);
    expect(grouped[0]!.event.entries[1]).toMatchObject({
      label: "Hook",
      detail: "PreToolUse:Bash error",
      output: "Command rejected by hook",
      status: "failed",
      tone: "error",
    });
    expect(grouped[0]!.event.entries[2]).toMatchObject({
      detail: "PreToolUse:Read error",
      output: "Read rejected by hook",
      status: "failed",
    });
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

  it("threads structured web_search results and total onto the work log entry", () => {
    const rows = collapseChatTranscriptEvents([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "web_search",
          query: "codex releases",
          itemId: "web-1",
          turnId: "turn-1",
          status: "completed",
          results: [
            { url: "https://openai.com/index/codex", title: "Codex" },
            { url: "https://platform.openai.com/docs/codex" },
          ],
          resultsTotal: 12,
        },
      },
    ]);
    expect(rows).toHaveLength(1);
    if (rows[0]!.event.type !== "work_log_entry") throw new Error("Expected work_log_entry");
    expect(rows[0]!.event.entry.results).toHaveLength(2);
    expect(rows[0]!.event.entry.resultsTotal).toBe(12);
  });

  it("preserves earlier web_search results when a later status event omits them", () => {
    const rows = collapseChatTranscriptEvents([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "web_search",
          query: "codex releases",
          itemId: "web-1",
          turnId: "turn-1",
          status: "running",
          results: [{ url: "https://openai.com/index/codex", title: "Codex" }],
          resultsTotal: 4,
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "web_search",
          query: "codex releases",
          itemId: "web-1",
          turnId: "turn-1",
          status: "completed",
        },
      },
    ]);
    expect(rows).toHaveLength(1);
    if (rows[0]!.event.type !== "work_log_entry") throw new Error("Expected work_log_entry");
    expect(rows[0]!.event.entry.status).toBe("completed");
    expect(rows[0]!.event.entry.results).toHaveLength(1);
    expect(rows[0]!.event.entry.resultsTotal).toBe(4);
  });

  describe("deriveWebSearchResultDisplay", () => {
    it("prefers the title and shows a www-stripped domain beside it", () => {
      expect(deriveWebSearchResultDisplay({ url: "https://www.openai.com/index/codex", title: "Codex" }))
        .toEqual({ href: "https://www.openai.com/index/codex", title: "Codex", domain: "openai.com" });
    });

    it("falls back to the domain as the title and hides a duplicate domain", () => {
      expect(deriveWebSearchResultDisplay({ url: "https://platform.openai.com/docs" }))
        .toEqual({ href: "https://platform.openai.com/docs", title: "platform.openai.com", domain: null });
    });

    it("handles non-url text with no href", () => {
      expect(deriveWebSearchResultDisplay({ title: "Just a note" }))
        .toEqual({ href: null, title: "Just a note", domain: null });
    });
  });

  it("removes assistant text rows superseded by transcript retractions", () => {
    const rows = collapseChatTranscriptEvents([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: { type: "text", text: "Original answer", messageId: "msg-old", turnId: "turn-1" },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "transcript_retraction",
          messageIds: ["msg-old"],
          reason: "assistant_supersedes",
          replacementMessageId: "msg-new",
          turnId: "turn-1",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:02.000Z",
        event: { type: "text", text: "Replacement answer", messageId: "msg-new", turnId: "turn-1" },
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.event.type).toBe("text");
    if (rows[0]!.event.type !== "text") throw new Error("Expected text row");
    expect(rows[0]!.event.text).toBe("Replacement answer");
    expect(rows[0]!.event.messageId).toBe("msg-new");
  });

  it("collapses started and completed context_compact events into one divider row", () => {
    const rows = collapseChatTranscriptEvents([
      {
        sessionId: "session-1",
        timestamp: "2026-01-01T12:00:00.000Z",
        event: {
          type: "context_compact",
          trigger: "auto",
          state: "started",
          turnId: "turn-1",
          provider: "claude",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-01-01T12:00:02.000Z",
        event: {
          type: "context_compact",
          trigger: "auto",
          state: "completed",
          turnId: "turn-1",
          preTokens: 120_000,
          postTokens: 40_000,
          durationMs: 2_000,
          provider: "claude",
        },
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.event).toMatchObject({
      type: "context_compact",
      state: "completed",
      preTokens: 120_000,
      postTokens: 40_000,
      durationMs: 2_000,
    });
  });

  it("merges cross-turn context_compact completion into the started divider row", () => {
    const rows = collapseChatTranscriptEvents([
      {
        sessionId: "session-1",
        timestamp: "2026-01-01T12:00:00.000Z",
        event: {
          type: "context_compact",
          trigger: "auto",
          state: "started",
          turnId: "turn-1",
          compactionId: "item-1",
          provider: "codex",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-01-01T12:00:02.000Z",
        event: {
          type: "context_compact",
          trigger: "auto",
          state: "completed",
          turnId: "turn-2",
          compactionId: "item-1",
          preTokens: 120_000,
          postTokens: 40_000,
          provider: "codex",
        },
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.event).toMatchObject({
      type: "context_compact",
      state: "completed",
      turnId: "turn-2",
      compactionId: "item-1",
      preTokens: 120_000,
      postTokens: 40_000,
    });
  });
});

function env(
  timestamp: string,
  event: AgentChatEventEnvelope["event"],
): AgentChatEventEnvelope {
  return { sessionId: "session-1", timestamp, event };
}

describe("subagent two-row rendering", () => {
  it("collapses a double subagent_started into exactly one enriched spawn anchor", () => {
    const rows = collapseChatTranscriptEvents([
      env("2026-06-01T10:00:00.000Z", {
        type: "subagent_started",
        taskId: "agent-1",
        agentType: "Explore",
        description: "Find",
      }),
      env("2026-06-01T10:00:01.000Z", {
        type: "subagent_started",
        taskId: "agent-1",
        agentType: "Explore",
        description: "Find update modal component",
        background: true,
      }),
    ]);

    expect(rows).toHaveLength(1);
    if (rows[0]!.event.type !== "subagent_spawn_anchor") throw new Error("Expected spawn anchor");
    // Enriched: longer description + background flag adopted.
    expect(rows[0]!.event.description).toBe("Find update modal component");
    expect(rows[0]!.event.background).toBe(true);
    expect(rows[0]!.event.agentType).toBe("Explore");
    expect(rows[0]!.key).toBe("subagent-spawn:agent-1");
  });

  it("keeps progress ticks interleaved with tool/text rows to a single anchor and reflects the last meaningful summary", () => {
    const rows = collapseChatTranscriptEvents([
      env("2026-06-01T10:00:00.000Z", {
        type: "subagent_started",
        taskId: "agent-1",
        agentType: "Explore",
        description: "Investigate route tree",
      }),
      env("2026-06-01T10:00:01.000Z", {
        type: "subagent_progress",
        taskId: "agent-1",
        summary: "Reading files",
        lastToolName: "Read",
        usage: { toolUses: 1 },
      }),
      env("2026-06-01T10:00:02.000Z", { type: "text", text: "parent thinking", messageId: "m-1" }),
      env("2026-06-01T10:00:03.000Z", {
        type: "tool_call",
        tool: "Read",
        args: { path: "a.ts" },
        itemId: "tool-1",
        turnId: "turn-1",
      }),
      env("2026-06-01T10:00:04.000Z", {
        type: "subagent_progress",
        taskId: "agent-1",
        summary: "Task updated",
        lastToolName: "Grep",
        usage: { toolUses: 3 },
      }),
      env("2026-06-01T10:00:05.000Z", {
        type: "subagent_progress",
        taskId: "agent-1",
        summary: "Located the modal in Modal.tsx",
        usage: { toolUses: 4 },
      }),
    ]);

    // One spawn anchor + one text row + one work-log entry — the progress ticks
    // never add rows.
    expect(rows.map((row) => row.event.type)).toEqual([
      "subagent_spawn_anchor",
      "text",
      "work_log_entry",
    ]);
    const anchor = rows[0]!;
    if (anchor.event.type !== "subagent_spawn_anchor") throw new Error("Expected spawn anchor");
    expect(anchor.event.status).toBe("running");
    expect(anchor.event.toolCount).toBe(4);
    // Placeholder "Task updated" never displaces the real summary.
    expect(anchor.event.statusLine).toBe("Located the modal in Modal.tsx");
  });

  it("collapses a double subagent_result into one card, richer summary wins, anchor flips terminal", () => {
    const rows = collapseChatTranscriptEvents([
      env("2026-06-01T10:00:00.000Z", {
        type: "subagent_started",
        taskId: "agent-1",
        agentType: "Explore",
        description: "Investigate",
      }),
      env("2026-06-01T10:00:01.000Z", {
        type: "subagent_result",
        taskId: "agent-1",
        status: "completed",
        summary: "Status: completed",
      }),
      env("2026-06-01T10:00:02.000Z", {
        type: "subagent_result",
        taskId: "agent-1",
        status: "completed",
        summary: "Found the modal in src/components/UpdateModal.tsx and wired the trigger.",
      }),
    ]);

    expect(rows.map((row) => row.event.type)).toEqual([
      "subagent_spawn_anchor",
      "subagent_result_card",
    ]);
    const anchor = rows[0]!;
    const result = rows[1]!;
    if (anchor.event.type !== "subagent_spawn_anchor") throw new Error("Expected anchor");
    if (result.event.type !== "subagent_result_card") throw new Error("Expected result card");
    // Anchor flipped to terminal.
    expect(anchor.event.status).toBe("completed");
    expect(anchor.event.endedAt).not.toBeNull();
    // Richer summary wins over the "Status: …" placeholder.
    expect(result.event.summaryPreview).toBe(
      "Found the modal in src/components/UpdateModal.tsx and wired the trigger.",
    );
    expect(result.event.status).toBe("completed");
    expect(result.key).toBe("subagent-result:agent-1");
  });

  it("mutates the anchor and appends the result at the tail after many intervening rows", () => {
    const rows = collapseChatTranscriptEvents([
      env("2026-06-01T10:00:00.000Z", {
        type: "subagent_started",
        taskId: "agent-1",
        agentType: "Explore",
        description: "Investigate",
      }),
      env("2026-06-01T10:00:01.000Z", { type: "text", text: "one", messageId: "m-1" }),
      env("2026-06-01T10:00:02.000Z", { type: "text", text: "two", messageId: "m-2" }),
      env("2026-06-01T10:00:03.000Z", {
        type: "tool_call",
        tool: "Read",
        args: {},
        itemId: "tool-1",
        turnId: "turn-1",
      }),
      env("2026-06-01T10:00:04.000Z", {
        type: "subagent_result",
        taskId: "agent-1",
        status: "completed",
        summary: "done investigating",
      }),
    ]);

    expect(rows[0]!.event.type).toBe("subagent_spawn_anchor");
    expect(rows[rows.length - 1]!.event.type).toBe("subagent_result_card");
    if (rows[0]!.event.type !== "subagent_spawn_anchor") throw new Error("Expected anchor");
    expect(rows[0]!.event.status).toBe("completed");
    expect(rows[0]!.key).toBe("subagent-spawn:agent-1");
  });

  it("rebinds a taskId anchor to an agentId while keeping the original render key", () => {
    const rows = collapseChatTranscriptEvents([
      env("2026-06-01T10:00:00.000Z", {
        type: "subagent_started",
        taskId: "task-1",
        agentType: "Explore",
        description: "Investigate",
      }),
      env("2026-06-01T10:00:01.000Z", {
        type: "subagent_progress",
        taskId: "task-1",
        agentId: "agent-1",
        summary: "still going",
      }),
      env("2026-06-01T10:00:02.000Z", {
        type: "subagent_result",
        taskId: "task-1",
        agentId: "agent-1",
        status: "completed",
        summary: "complete",
      }),
    ]);

    // One anchor + one result card — rebind must not create a second anchor. The
    // render key stays bound to the original taskId (load-bearing for the virtualizer).
    expect(rows.map((row) => row.event.type)).toEqual([
      "subagent_spawn_anchor",
      "subagent_result_card",
    ]);
    expect(rows[0]!.key).toBe("subagent-spawn:task-1");
    expect(rows[1]!.key).toBe("subagent-result:task-1");
  });

  it("keeps incremental and full-recompute output identical over a mixed subagent stream", () => {
    const stream: AgentChatEventEnvelope[] = [
      env("2026-06-01T10:00:00.000Z", { type: "text", text: "kick off", messageId: "m-1" }),
      env("2026-06-01T10:00:01.000Z", {
        type: "subagent_started",
        taskId: "agent-1",
        agentType: "Explore",
        description: "Investigate route tree",
      }),
      env("2026-06-01T10:00:02.000Z", {
        type: "subagent_progress",
        taskId: "agent-1",
        summary: "reading files",
        lastToolName: "Read",
        usage: { toolUses: 2 },
      }),
      env("2026-06-01T10:00:03.000Z", {
        type: "subagent_started",
        taskId: "agent-2",
        agentType: "Explore",
        description: "Check tests",
      }),
      env("2026-06-01T10:00:04.000Z", {
        type: "tool_call",
        tool: "Read",
        args: {},
        itemId: "tool-1",
        turnId: "turn-1",
      }),
      env("2026-06-01T10:00:05.000Z", {
        type: "subagent_result",
        taskId: "agent-1",
        status: "completed",
        summary: "found it",
      }),
      env("2026-06-01T10:00:06.000Z", {
        type: "subagent_progress",
        taskId: "agent-2",
        summary: "still running tests",
        usage: { toolUses: 5 },
      }),
      env("2026-06-01T10:00:07.000Z", {
        type: "subagent_result",
        taskId: "agent-2",
        status: "failed",
        summary: "tests failed",
      }),
    ];

    const full = collapseChatTranscriptEvents(stream);

    // Feed the stream one event at a time through the incremental path.
    let prevEvents: AgentChatEventEnvelope[] = [];
    let prevRows = collapseChatTranscriptEventsWithContext(prevEvents).rows;
    let prevContext = collapseChatTranscriptEventsWithContext(prevEvents).context;
    for (let index = 1; index <= stream.length; index += 1) {
      const nextEvents = stream.slice(0, index);
      const result = collapseChatTranscriptEventsIncrementalWithContext(
        nextEvents,
        prevEvents,
        prevRows,
        prevContext,
      );
      prevEvents = nextEvents;
      prevRows = result.rows;
      prevContext = result.context;
    }

    expect(prevRows).toEqual(full);
    // Row keys must be identical too (virtualizer identity).
    expect(prevRows.map((row) => row.key)).toEqual(full.map((row) => row.key));

    // Also verify the legacy no-context incremental signature stays in parity.
    const legacy = collapseChatTranscriptEventsIncremental(
      stream,
      stream.slice(0, stream.length - 1),
      collapseChatTranscriptEvents(stream.slice(0, stream.length - 1)),
    );
    expect(legacy).toEqual(full);
  });

  it("repairs subagent anchor positions after retracting an earlier text row", () => {
    const stream: AgentChatEventEnvelope[] = [
      env("2026-06-01T10:00:00.000Z", {
        type: "text",
        text: "Retracted parent text",
        messageId: "message-m",
      }),
      env("2026-06-01T10:00:01.000Z", {
        type: "subagent_started",
        taskId: "agent-a",
        agentType: "Explore",
        description: "Inspect the transcript",
      }),
      env("2026-06-01T10:00:02.000Z", {
        type: "text",
        text: "Parent text that remains",
        messageId: "message-stays",
      }),
      env("2026-06-01T10:00:03.000Z", {
        type: "transcript_retraction",
        messageIds: ["message-m"],
        reason: "assistant_supersedes",
      }),
      env("2026-06-01T10:00:04.000Z", {
        type: "subagent_progress",
        taskId: "agent-a",
        summary: "Reading transcript rows",
        lastToolName: "Read",
        usage: { toolUses: 2 },
      }),
      env("2026-06-01T10:00:05.000Z", {
        type: "subagent_result",
        taskId: "agent-a",
        status: "completed",
        summary: "Anchor positions verified",
      }),
    ];

    const full = collapseChatTranscriptEvents(stream);
    expect(full.map((row) => row.event.type)).toEqual([
      "subagent_spawn_anchor",
      "text",
      "subagent_result_card",
    ]);
    const [anchor, remainingText, result] = full;
    expect(anchor?.key).toBe("subagent-spawn:agent-a");
    expect(anchor?.event).toMatchObject({
      type: "subagent_spawn_anchor",
      agentKey: "agent-a",
      description: "Inspect the transcript",
      status: "completed",
      statusLine: "Reading transcript rows",
      toolCount: 2,
    });
    expect(remainingText?.event).toMatchObject({
      type: "text",
      text: "Parent text that remains",
      messageId: "message-stays",
    });
    expect(result).toMatchObject({
      key: "subagent-result:agent-a",
      event: {
        type: "subagent_result_card",
        agentKey: "agent-a",
        status: "completed",
        summaryPreview: "Anchor positions verified",
      },
    });

    let previousEvents: AgentChatEventEnvelope[] = [];
    let incremental = collapseChatTranscriptEventsWithContext(previousEvents);
    for (let index = 1; index <= stream.length; index += 1) {
      const nextEvents = stream.slice(0, index);
      incremental = collapseChatTranscriptEventsIncrementalWithContext(
        nextEvents,
        previousEvents,
        incremental.rows,
        incremental.context,
      );
      previousEvents = nextEvents;
    }
    expect(incremental.rows).toEqual(full);
  });

  it("renders old-style background shell subagent events as one finish chip, no cards", () => {
    const rows = collapseChatTranscriptEvents([
      env("2026-06-01T10:00:00.000Z", {
        type: "subagent_started",
        taskId: "bg-1",
        taskType: "background",
        description: "cd /repo && npm run dev",
      }),
      env("2026-06-01T10:00:01.000Z", {
        type: "subagent_progress",
        taskId: "bg-1",
        summary: "server starting",
      }),
      env("2026-06-01T10:00:02.000Z", {
        type: "subagent_result",
        taskId: "bg-1",
        taskType: "background",
        status: "completed",
        summary: "exited 0",
      }),
    ]);

    expect(rows).toHaveLength(1);
    if (rows[0]!.event.type !== "background_finish_chip") throw new Error("Expected finish chip");
    expect(rows[0]!.event.status).toBe("completed");
    expect(rows[0]!.event.label).toBe("npm run dev");
    expect(rows[0]!.key).toBe("background-chip:bg-1");
  });

  it("dedupes a double background result into one finish chip", () => {
    const rows = collapseChatTranscriptEvents([
      env("2026-06-01T10:00:00.000Z", {
        type: "subagent_started",
        taskId: "bg-1",
        taskType: "background",
        description: "cd /repo && npm test",
      }),
      env("2026-06-01T10:00:01.000Z", {
        type: "subagent_result",
        taskId: "bg-1",
        taskType: "background",
        status: "completed",
        summary: "Status: completed",
      }),
      env("2026-06-01T10:00:02.000Z", {
        type: "subagent_result",
        taskId: "bg-1",
        taskType: "background",
        status: "failed",
        summary: "exit 1",
      }),
    ]);

    expect(rows).toHaveLength(1);
    if (rows[0]!.event.type !== "background_finish_chip") throw new Error("Expected finish chip");
    expect(rows[0]!.event.status).toBe("failed");
  });

  it("drops background_task scheduled_work_update from the in-thread transcript", () => {
    const rows = collapseChatTranscriptEvents([
      env("2026-06-01T10:00:00.000Z", {
        type: "scheduled_work_update",
        id: "bg-task-1",
        kind: "background_task",
        status: "running",
        title: "cd /repo && npm run dev",
      }),
      env("2026-06-01T10:00:01.000Z", {
        type: "scheduled_work_update",
        id: "cron-1",
        kind: "cron",
        status: "scheduled",
        title: "Nightly",
      }),
    ]);

    // background_task produces no thread row; the cron survives.
    expect(rows).toHaveLength(1);
    if (rows[0]!.event.type !== "scheduled_work_update") throw new Error("Expected scheduled_work_update");
    expect(rows[0]!.event.kind).toBe("cron");
  });

  it("derives a wake divider before every unattended scheduled turn", () => {
    const rows = collapseChatTranscriptEvents([
      env("2026-06-01T09:00:00.000Z", {
        type: "user_message",
        text: "Check PR CI and report the result.",
        turnId: "wake-turn-1",
        metadata: {
          scheduledWake: {
            scheduleId: "cron-ci",
            kind: "cron",
            firedAt: "2026-06-01T09:00:00.000Z",
            reason: "Check PR CI",
            late: true,
          },
        },
      }),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      key: "scheduled-wake:cron-ci:wake-turn-1",
      event: {
        type: "scheduled_wake_divider",
        scheduleId: "cron-ci",
        kind: "cron",
        reason: "Check PR CI",
        late: true,
        turnId: "wake-turn-1",
      },
    });
    expect(rows[1]?.event.type).toBe("user_message");
  });

  it("folds durable steer and diagnostic lifecycle snapshots into stable rows", () => {
    const rows = collapseChatTranscriptEvents([
      env("2026-06-01T09:00:00.000Z", {
        type: "user_message",
        text: "Check the release.",
        steerId: "steer-1",
        deliveryState: "accepted",
        turnId: "turn-1",
      }),
      env("2026-06-01T09:00:01.000Z", {
        type: "user_message",
        text: "Check the release.",
        steerId: "steer-1",
        deliveryState: "processed",
        processed: true,
        turnId: "turn-1",
      }),
      env("2026-06-01T09:00:02.000Z", {
        type: "turn_diagnostics",
        turnId: "turn-1",
        moderationChecks: 1,
      }),
      env("2026-06-01T09:00:03.000Z", {
        type: "turn_diagnostics",
        turnId: "turn-1",
        moderationChecks: 2,
        optionalIntegrationFailures: [{ integration: "unityMCP" }],
      }),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      event: {
        type: "user_message",
        steerId: "steer-1",
        deliveryState: "processed",
        processed: true,
      },
    });
    expect(rows[1]).toMatchObject({
      event: {
        type: "turn_diagnostics",
        moderationChecks: 2,
        optionalIntegrationFailures: [{ integration: "unityMCP" }],
      },
    });
  });

  it("keeps durable message resolution across out-of-order hydration and later metadata", () => {
    const rows = collapseChatTranscriptEvents([
      env("2026-06-01T09:00:00.000Z", {
        type: "user_message_resolution",
        steerId: "steer-early-resolution",
        action: "run_next",
        state: "completed",
        resolvedAt: "2026-06-01T09:00:00.000Z",
        replacementMessageId: "message-2",
      }),
      env("2026-06-01T09:00:01.000Z", {
        type: "user_message",
        text: "Run this next.",
        steerId: "steer-early-resolution",
        deliveryState: "unprocessed",
        processed: false,
        metadata: {
          scheduledWake: {
            scheduleId: "wake-1",
            kind: "wakeup",
            firedAt: "2026-06-01T09:00:01.000Z",
          },
        },
      }),
      env("2026-06-01T09:00:02.000Z", {
        type: "user_message",
        text: "Run this next.",
        steerId: "steer-early-resolution",
        deliveryState: "unprocessed",
        processed: false,
        metadata: {
          spawnCompletion: {
            childSessionId: "child-1",
            childTitle: "Child",
            spawnKind: "subagent",
            status: "completed",
          },
        },
      }),
    ]);

    const userMessage = rows.find((row) => row.event.type === "user_message");
    expect(userMessage?.event).toMatchObject({
      type: "user_message",
      metadata: {
        scheduledWake: { scheduleId: "wake-1" },
        spawnCompletion: { childSessionId: "child-1" },
        unprocessedMessageResolution: {
          action: "run_next",
          state: "completed",
          replacementMessageId: "message-2",
        },
      },
    });
  });

  it("preserves the actual provider-neutral recovery action", () => {
    const rows = collapseChatTranscriptEvents([
      env("2026-06-01T09:00:00.000Z", {
        type: "turn_recovery",
        provider: "claude",
        turnId: "turn-1",
        action: "nudge",
        state: "recovered",
        message: "The provider resumed.",
        automatic: false,
        at: "2026-06-01T09:00:00.000Z",
        recoveryCount: 1,
      }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.event).toMatchObject({
      type: "turn_recovery",
      action: "nudge",
      state: "recovered",
    });
  });

  it("preserves the child session when adapting provider-neutral turn health for recovery UI", () => {
    const rows = collapseChatTranscriptEvents([
      env("2026-06-01T09:00:00.000Z", {
        type: "turn_health",
        provider: "codex",
        turnId: "turn-child",
        state: "stalled",
        reason: "no_output",
        message: "The child turn accepted the request but has not produced output.",
        detectedAt: "2026-06-01T09:00:00.000Z",
        turnStartedAt: "2026-06-01T08:58:00.000Z",
        lastProgressAt: "2026-06-01T08:58:00.000Z",
        recoveryCount: 1,
        supportedActions: ["wait", "nudge", "retry_same_runtime", "restart_resume"],
        automaticRecoveryAttempted: true,
        sourceSessionId: "child-session",
      }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.event).toMatchObject({
      type: "codex_turn_stalled",
      turnId: "turn-child",
      sourceSessionId: "child-session",
      recoveryOptions: ["wait", "steer", "interrupt_retry_same_thread", "restart_resume_thread"],
    });
  });
});

describe("interrupt-stopped subagent grouping", () => {
  it("folds a run of 3 stopped-interrupted results into one group while a completed result stays individual", () => {
    const grouped = groupEvents([
      env("2026-07-11T10:00:00.000Z", { type: "subagent_started", taskId: "agent-a", agentType: "explorer", description: "Explore auth flow" }),
      env("2026-07-11T10:00:00.100Z", { type: "subagent_started", taskId: "agent-b", agentType: "explorer", description: "Explore sync flow" }),
      env("2026-07-11T10:00:00.200Z", { type: "subagent_started", taskId: "agent-c", agentType: "explorer", description: "Explore the UI" }),
      env("2026-07-11T10:00:00.300Z", { type: "subagent_started", taskId: "agent-d", agentType: "builder", description: "Build the widget" }),
      // agent-d finishes for real; then the user interrupts and the rest are swept to "stopped".
      env("2026-07-11T10:00:05.000Z", { type: "subagent_result", taskId: "agent-d", status: "completed", summary: "Widget built" }),
      env("2026-07-11T10:00:06.000Z", { type: "subagent_result", taskId: "agent-a", status: "stopped", summary: "Interrupted", finalSummary: "Interrupted" }),
      env("2026-07-11T10:00:06.001Z", { type: "subagent_result", taskId: "agent-b", status: "stopped", summary: "Interrupted", finalSummary: "Interrupted" }),
      env("2026-07-11T10:00:06.002Z", { type: "subagent_result", taskId: "agent-c", status: "stopped", summary: "Interrupted", finalSummary: "Interrupted" }),
    ]);

    // Exactly one folded group — never a wall of identical stopped cards.
    const groups = grouped.filter((row) => row.event.type === "subagent_stopped_group");
    expect(groups).toHaveLength(1);
    const group = groups[0]!;
    if (group.event.type !== "subagent_stopped_group") throw new Error("Expected stopped group");
    expect(group.key).toBe("subagent-stopped-group:agent-a");
    expect(group.event.count).toBe(3);
    expect(group.event.items).toEqual([
      { agentKey: "agent-a", title: "Explore auth flow", jumpToStartRowKey: "subagent-spawn:agent-a" },
      { agentKey: "agent-b", title: "Explore sync flow", jumpToStartRowKey: "subagent-spawn:agent-b" },
      { agentKey: "agent-c", title: "Explore the UI", jumpToStartRowKey: "subagent-spawn:agent-c" },
    ]);

    // The completed agent keeps its own result card (real summary the user wants to read).
    const resultCards = grouped.filter((row) => row.event.type === "subagent_result_card");
    expect(resultCards).toHaveLength(1);
    if (resultCards[0]!.event.type !== "subagent_result_card") throw new Error("Expected result card");
    expect(resultCards[0]!.event.status).toBe("completed");
    expect(resultCards[0]!.event.summaryPreview).toBe("Widget built");
  });

  it("keeps a single lone stopped result as a normal result card (no group of one)", () => {
    const grouped = groupEvents([
      env("2026-07-11T10:00:00.000Z", { type: "subagent_started", taskId: "agent-a", agentType: "explorer", description: "Explore auth flow" }),
      env("2026-07-11T10:00:06.000Z", { type: "subagent_result", taskId: "agent-a", status: "stopped", summary: "Interrupted", finalSummary: "Interrupted" }),
    ]);

    expect(grouped.some((row) => row.event.type === "subagent_stopped_group")).toBe(false);
    const resultCards = grouped.filter((row) => row.event.type === "subagent_result_card");
    expect(resultCards).toHaveLength(1);
    if (resultCards[0]!.event.type !== "subagent_result_card") throw new Error("Expected result card");
    expect(resultCards[0]!.event.status).toBe("stopped");
  });
});

describe("ade_card transcript rows", () => {
  const card = (over: Partial<Extract<AgentChatEventEnvelope["event"], { type: "ade_card" }>>) => ({
    type: "ade_card" as const,
    cardId: "run-42",
    variant: "proof_artifact",
    state: "live" as const,
    title: "Pulling cloud artifacts",
    fallbackText: "1 cloud artifact pulled into the lane",
    ...over,
  });

  it("merges repeat emits of one cardId into a single row, in place, under the same key", () => {
    const rows = collapseChatTranscriptEvents([
      env("2026-07-27T10:00:00.000Z", { type: "text", text: "before", messageId: "m-1" }),
      env("2026-07-27T10:00:01.000Z", card({ metrics: [{ label: "files", value: "1" }] })),
      env("2026-07-27T10:00:02.000Z", { type: "text", text: "after", messageId: "m-2" }),
      env("2026-07-27T10:00:03.000Z", card({
        state: "terminal",
        title: "Cloud artifacts pulled",
        metrics: [{ label: "files", value: "3" }],
      })),
    ]);

    // Still THREE rows: the card did not append a second time, and it stayed at
    // its original chronological position (index 1), ahead of "after".
    expect(rows.map((row) => row.event.type)).toEqual(["text", "ade_card", "text"]);
    expect(rows[1]!.key).toBe("ade-card:run-42");
    const merged = rows[1]!.event;
    if (merged.type !== "ade_card") throw new Error("Expected ade_card");
    expect(merged.state).toBe("terminal");
    expect(merged.title).toBe("Cloud artifacts pulled");
    expect(merged.metrics).toEqual([{ label: "files", value: "3" }]);
    // Row timestamp advances to the latest update.
    expect(rows[1]!.timestamp).toBe("2026-07-27T10:00:03.000Z");
  });

  it("merges partial updates rather than blanking omitted fields", () => {
    const rows = collapseChatTranscriptEvents([
      env("2026-07-27T10:00:00.000Z", card({
        rows: [{ icon: "file", text: "report.md" }],
        metrics: [{ label: "files", value: "1" }],
      })),
      // An update that only flips state must not erase rows/metrics.
      env("2026-07-27T10:00:01.000Z", card({ state: "terminal" })),
    ]);

    expect(rows).toHaveLength(1);
    const merged = rows[0]!.event;
    if (merged.type !== "ade_card") throw new Error("Expected ade_card");
    expect(merged.state).toBe("terminal");
    expect(merged.rows).toEqual([{ icon: "file", text: "report.md" }]);
    expect(merged.metrics).toEqual([{ label: "files", value: "1" }]);
  });

  // `buildPrCiCard` ALWAYS writes `rows` and `progress`, so the "omitted means
  // partial patch" comment was not enough on its own: a poll that came back
  // from a rate-limited GitHub used to overwrite a good card with `rows: []`
  // and an all-zero progress bar.
  it("preserves prior detail — and marks it stale — when a degraded re-emit lands", () => {
    const rows = collapseChatTranscriptEvents([
      env("2026-07-27T10:00:00.000Z", card({
        variant: "pr_ci",
        rows: [{ icon: "fail", text: "test-desktop" }],
        progress: { passed: 28, failed: 2, running: 0, queued: 0 },
        metrics: [{ label: "failed", value: "2" }],
      })),
      env("2026-07-27T10:00:01.000Z", card({
        variant: "pr_ci",
        rows: [],
        progress: { passed: 0, failed: 0, running: 0, queued: 0 },
        metrics: [],
        degradedReason: "HTTP 403: rate limited",
      })),
    ]);

    expect(rows).toHaveLength(1);
    const merged = rows[0]!.event;
    if (merged.type !== "ade_card") throw new Error("Expected ade_card");
    expect(merged.rows).toEqual([{ icon: "fail", text: "test-desktop" }]);
    expect(merged.progress).toEqual({ passed: 28, failed: 2, running: 0, queued: 0 });
    expect(merged.metrics).toEqual([{ label: "failed", value: "2" }]);
    expect(merged.stale).toBe(true);
    expect(merged.degradedReason).toBe("HTTP 403: rate limited");
  });

  it("clears the stale marker as soon as a healthy emit brings detail back", () => {
    const rows = collapseChatTranscriptEvents([
      env("2026-07-27T10:00:00.000Z", card({ rows: [{ icon: "fail", text: "lint" }] })),
      env("2026-07-27T10:00:01.000Z", card({ rows: [], degradedReason: "HTTP 403" })),
      env("2026-07-27T10:00:02.000Z", card({ rows: [{ icon: "pass", text: "lint" }], degradedReason: null })),
    ]);

    const merged = rows[0]!.event;
    if (merged.type !== "ade_card") throw new Error("Expected ade_card");
    expect(merged.stale).toBe(false);
    expect(merged.rows).toEqual([{ icon: "pass", text: "lint" }]);
  });

  it("keeps distinct cardIds as distinct rows", () => {
    const rows = collapseChatTranscriptEvents([
      env("2026-07-27T10:00:00.000Z", card({ cardId: "run-1" })),
      env("2026-07-27T10:00:01.000Z", card({ cardId: "run-2" })),
      env("2026-07-27T10:00:02.000Z", card({ cardId: "run-1", state: "terminal" })),
    ]);

    expect(rows.map((row) => row.key)).toEqual(["ade-card:run-1", "ade-card:run-2"]);
  });

  it("is a permanent chronological row — never folded into an activity phase", () => {
    const grouped = groupEvents([
      env("2026-07-27T10:00:00.000Z", { type: "reasoning", text: "thinking a", turnId: "turn-1", itemId: "r-1" }),
      env("2026-07-27T10:00:01.000Z", card({})),
      env("2026-07-27T10:00:02.000Z", { type: "reasoning", text: "thinking b", turnId: "turn-1", itemId: "r-2" }),
      env("2026-07-27T10:00:03.000Z", { type: "reasoning", text: "thinking c", turnId: "turn-1", itemId: "r-3" }),
    ]);

    const collapsed = collapseGroupedActivityPhaseRows(grouped);
    const cardIndex = collapsed.findIndex((row) => row.event.type === "ade_card");
    expect(cardIndex).toBeGreaterThanOrEqual(0);
    // The card breaks the phase: reasoning before it cannot merge with reasoning after.
    expect(collapsed[cardIndex - 1]?.event.type).toBe("reasoning");
    expect(collapsed[cardIndex + 1]?.event.type).toBe("reasoning");
  });

  it("keeps incremental and full-recompute output identical across card updates", () => {
    const stream: AgentChatEventEnvelope[] = [
      env("2026-07-27T10:00:00.000Z", { type: "text", text: "kick off", messageId: "m-1" }),
      env("2026-07-27T10:00:01.000Z", card({ metrics: [{ label: "files", value: "1" }] })),
      env("2026-07-27T10:00:02.000Z", card({ cardId: "run-99", title: "Other" })),
      env("2026-07-27T10:00:03.000Z", card({ metrics: [{ label: "files", value: "2" }] })),
      env("2026-07-27T10:00:04.000Z", { type: "text", text: "mid", messageId: "m-2" }),
      env("2026-07-27T10:00:05.000Z", card({ state: "terminal", metrics: [{ label: "files", value: "3" }] })),
    ];

    const full = collapseChatTranscriptEvents(stream);

    let prevEvents: AgentChatEventEnvelope[] = [];
    let prevRows = collapseChatTranscriptEventsWithContext(prevEvents).rows;
    let prevContext = collapseChatTranscriptEventsWithContext(prevEvents).context;
    for (let index = 1; index <= stream.length; index += 1) {
      const nextEvents = stream.slice(0, index);
      const result = collapseChatTranscriptEventsIncrementalWithContext(
        nextEvents,
        prevEvents,
        prevRows,
        prevContext,
      );
      prevEvents = nextEvents;
      prevRows = result.rows;
      prevContext = result.context;
    }

    expect(prevRows).toEqual(full);
    expect(prevRows.map((row) => row.key)).toEqual(full.map((row) => row.key));
  });

  it("repairs the card row position after an earlier text row is retracted", () => {
    const rows = collapseChatTranscriptEvents([
      env("2026-07-27T10:00:00.000Z", { type: "text", text: "retract me", messageId: "m-x" }),
      env("2026-07-27T10:00:01.000Z", card({ metrics: [{ label: "files", value: "1" }] })),
      env("2026-07-27T10:00:02.000Z", { type: "transcript_retraction", messageIds: ["m-x"] }),
      env("2026-07-27T10:00:03.000Z", card({ state: "terminal", metrics: [{ label: "files", value: "9" }] })),
    ]);

    expect(rows).toHaveLength(1);
    const merged = rows[0]!.event;
    if (merged.type !== "ade_card") throw new Error("Expected ade_card");
    expect(merged.metrics).toEqual([{ label: "files", value: "9" }]);
  });
});
