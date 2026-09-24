/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import type { AgentChatEventEnvelope } from "../../../shared/types";
import { sceneRowIdentity, sceneScopeKeyFor } from "../../../shared/chatScene";
import { prependOlderChatHistoryPage } from "./chatHistoryWindow";
import {
  applyChatTranscriptTurnFolds,
  buildTranscriptEventRowKeys,
  collapseChatTranscriptEvents,
  collapseChatTranscriptEventsIncremental,
  collapseChatTranscriptEventsIncrementalWithContext,
  collapseChatTranscriptEventsWithContext,
  collapseGroupedActivityPhaseRows,
  countRowsAppendedSince,
  countVisibleRowsAppendedSince,
  deriveChatTranscriptTurnFolds,
  deriveTurnDividerData,
  deriveWebSearchResultDisplay,
  extractLocalhostUrlsFromText,
  eventHasPayload,
  formatDoneTurnTokenLine,
  formatStructuredValue,
  groupChatTranscriptRows,
  mergeAdjacentActivityBundleRows,
  groupConsecutiveWorkLogRows,
  readRecord,
  readTurnEndSnapshots,
  sameTurnFolds,
  summarizeDiffStats,
  summarizeInlineText,
  summarizeTurnDetails,
  type ChatTranscriptGroupedEnvelope,
} from "./chatTranscriptRows";

function groupEvents(events: AgentChatEventEnvelope[]) {
  return groupChatTranscriptRows(collapseChatTranscriptEvents(events));
}

describe("chatTranscriptRows", () => {
  /**
   * A scene's still is a FILE, named by the key derived here, looked up again
   * on every reopen.
   *
   * The render key used to carry the event's index in the events array, so
   * scrolling back one page — which prepends older events and shifts every
   * index — renamed the scene. The lookup missed, the generated code ran again,
   * and a second still was filed on disk. Render keys are position-independent
   * now, and the still's name stays on its own frozen identity.
   */
  it("names a scene by message identity, so a prepended older page cannot move it", () => {
    const base = { sessionId: "session-1", timestamp: "2026-09-17T10:00:00.000Z" };
    const source = "<p>lanes</p>";
    const sceneEvent = {
      type: "text" as const,
      text: "Here is the chart.",
      messageId: "msg-scene",
      turnId: "turn-2",
    };
    const windowed: AgentChatEventEnvelope[] = [
      { ...base, sequence: 4, event: { type: "user_message", text: "draw me the lanes" } },
      { ...base, sequence: 5, event: sceneEvent },
    ];
    const withOlderPage: AgentChatEventEnvelope[] = [
      { ...base, sequence: 1, event: { type: "user_message", text: "an earlier question" } },
      { ...base, sequence: 2, event: { type: "text", text: "an earlier answer", messageId: "msg-old" } },
      ...windowed,
    ];

    const sceneRowIn = (events: AgentChatEventEnvelope[]) => {
      const row = collapseChatTranscriptEvents(events)
        .find((candidate) => candidate.event.type === "text"
          && candidate.event.messageId === "msg-scene");
      if (!row || row.event.type !== "text") throw new Error("the scene row went missing");
      return { key: row.key, event: row.event };
    };

    const before = sceneRowIn(windowed);
    const after = sceneRowIn(withOlderPage);

    // The render key no longer moves with the window either.
    expect(after.key).toBe(before.key);
    // And the still's name, which must not move with it.
    expect(sceneScopeKeyFor(sceneRowIdentity(after.event, after.key), source))
      .toBe(sceneScopeKeyFor(sceneRowIdentity(before.event, before.key), source));
  });

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

  it("copies childSessionId and spawnKind onto the result card after dropping the spawn card", () => {
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
      {
        sessionId: "parent-session",
        timestamp: "2026-07-14T10:01:00.000Z",
        event: {
          type: "subagent_result",
          taskId: "chat:child-123",
          agentId: "child-123",
          status: "completed",
          summary: "Kickoff turn finished.",
        },
      },
    ]);

    expect(rows.map((row) => row.event.type)).toEqual(["subagent_result_card"]);
    const result = rows[0]!.event;
    if (result.type !== "subagent_result_card") throw new Error("Expected result card");
    expect(result.childSessionId).toBe("child-123");
    expect(result.spawnKind).toBe("peer");
    expect(rows.some((row) => row.event.type === "subagent_spawn_anchor")).toBe(false);
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

  it("concatenates consecutive reasoning deltas with the same turn/item/summaryIndex", () => {
    // Same identity means streamed deltas of one thought, so they rejoin
    // verbatim — not two `---`-separated blocks. A hidden context_usage row
    // between the deltas is removed before grouping, so this is the path that
    // used to turn "Hello " + "world" into separate Markdown blocks.
    const rows = [
      {
        key: "s1:0:t0",
        timestamp: "2026-04-08T12:00:00.000Z",
        event: { type: "reasoning" as const, text: "Hello ", turnId: "t1", itemId: "r1", summaryIndex: null },
      },
      {
        key: "s1:1:t1",
        timestamp: "2026-04-08T12:00:01.000Z",
        event: { type: "reasoning" as const, text: "world", turnId: "t1", itemId: "r1", summaryIndex: null },
      },
    ];

    const grouped = groupConsecutiveWorkLogRows(rows as any);
    const reasoning = grouped.filter((r) => r.event.type === "reasoning");
    expect(reasoning).toHaveLength(1);
    expect((reasoning[0]!.event as any).text).toBe("Hello world");
    // Should use the later timestamp
    expect(reasoning[0]!.timestamp).toBe("2026-04-08T12:00:01.000Z");
  });

  it("merges consecutive reasoning events with different itemIds in the same turn", () => {
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
    expect(reasoning).toHaveLength(1);
    const text = (reasoning[0]!.event as any).text as string;
    expect(text).toContain("Thought A.");
    expect(text).toContain("Thought B.");
  });

  it("drops both earlier blocks when a later reasoning event re-emits them cumulatively", () => {
    // The whole run is folded in one pass, so a re-emit covering two earlier
    // fragments leaves neither behind as a duplicate trailing block.
    const rows = [
      {
        key: "s1:0:t0",
        timestamp: "2026-04-08T12:00:00.000Z",
        event: { type: "reasoning" as const, text: "First part.", turnId: "t1", itemId: "r1" },
      },
      {
        key: "s1:1:t1",
        timestamp: "2026-04-08T12:00:01.000Z",
        event: { type: "reasoning" as const, text: "Second part.", turnId: "t1", itemId: "r2" },
      },
      {
        key: "s1:2:t2",
        timestamp: "2026-04-08T12:00:02.000Z",
        event: { type: "reasoning" as const, text: "First part. Second part.", turnId: "t1", itemId: "r3" },
      },
    ];

    const grouped = groupConsecutiveWorkLogRows(rows as any);
    const reasoning = grouped.filter((r) => r.event.type === "reasoning");
    expect(reasoning).toHaveLength(1);
    expect((reasoning[0]!.event as any).text).toBe("First part. Second part.");
  });

  it("collapses a provider-re-emitted reasoning block instead of repeating its text", () => {
    // Claude persists one thought twice: the stream reports content index 1,
    // the SDK snapshot reports block index 0. Both carry the full text.
    const text = "The 2,015,890-character replay text lines up with a budget derived from the 1M-token window at 4 chars/token.";
    const rows = [
      {
        key: "s1:0:t0",
        timestamp: "2026-04-08T12:00:00.000Z",
        event: { type: "reasoning" as const, text, turnId: "t1", itemId: "claude-thinking:t1:1" },
      },
      {
        key: "s1:1:t1",
        timestamp: "2026-04-08T12:00:01.000Z",
        event: { type: "reasoning" as const, text, turnId: "t1", itemId: "claude-thinking:t1:0" },
      },
    ];

    const grouped = groupConsecutiveWorkLogRows(rows as any);
    const reasoning = grouped.filter((r) => r.event.type === "reasoning");
    expect(reasoning).toHaveLength(1);
    expect((reasoning[0]!.event as any).text).toBe(text);
  });

  it("keeps reasoning from different turns as separate rows", () => {
    const rows = [
      {
        key: "s1:0:t0",
        timestamp: "2026-04-08T12:00:00.000Z",
        event: { type: "reasoning" as const, text: "First turn.", turnId: "t1", itemId: "r1" },
      },
      {
        key: "s1:1:t1",
        timestamp: "2026-04-08T12:00:01.000Z",
        event: { type: "reasoning" as const, text: "Second turn.", turnId: "t2", itemId: "r2" },
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

describe("countVisibleRowsAppendedSince", () => {
  // Logical rows: u, h1, h2, k, a, d. A fold hides h1 and h2 (k is kept).
  const logicalKeys = ["u", "h1", "h2", "k", "a", "d"];
  const fold = { foldId: "turn-fold:t1", spanStartIndex: 1 };
  const closed = ["u", "turn-fold:t1", "k", "a", "d"];
  const open = ["u", "turn-fold:t1", "h1", "h2", "k", "a", "d"];
  const count = (visibleKeys: string[], anchorKey: string | null) => countVisibleRowsAppendedSince({
    visibleKeys,
    logicalKeys,
    folds: [fold],
    anchorKey,
  });

  it("keeps counting when the anchor row was folded away", () => {
    // The reader detached on h1; the turn then folded h1 away.
    expect(count(closed, "h1")).toBe(3); // k, a, d — not the fold row, which sits before h1
    expect(count(closed, "h2")).toBe(3);
  });

  it("never counts rows hidden in a closed fold, and counts the fold row once when it is new", () => {
    expect(count(closed, "u")).toBe(4); // fold row, k, a, d
    expect(count(open, "u")).toBe(6);
    expect(count(open, "h1")).toBe(4);
  });

  it("is the plain count without folds and fails quiet for an unknown anchor", () => {
    expect(countVisibleRowsAppendedSince({ visibleKeys: ["a", "b", "c"], logicalKeys: ["a", "b", "c"], folds: [], anchorKey: "a" })).toBe(2);
    expect(count(closed, "gone")).toBe(0);
    expect(count(closed, null)).toBe(0);
    expect(count(closed, "d")).toBe(0);
    expect(count(closed, "turn-fold:t1")).toBe(3);
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

  it("does not treat a normal diff containing shortening notices as compacted", () => {
    // Editing the compactor (or this matcher) produces a real diff whose own
    // added lines quote both notice strings. An unanchored search called that
    // change compacted and reported it as zero additions and deletions.
    const diff = [
      "@@ -1,4 +1,6 @@",
      '+    `[ADE] Large ${label} was shortened to keep this chat fast.`,',
      '+    `[ADE] ${omittedBytes} bytes were left out.`,',
      "-  const old = true;",
    ].join("\n");

    expect(summarizeDiffStats(diff)).toEqual({ additions: 2, deletions: 1 });
  });

  /**
   * The notice became user-facing when phones started receiving the same
   * compacted events, so its wording changed. The case above pins the old text
   * that is already written into transcripts on disk; this one pins the new.
   */
  it("recognizes a compacted diff preview written with the current wording", () => {
    const diff = [
      "[ADE] Large file diff was shortened to keep this chat fast.",
      "Original size: 120000 bytes.",
      "",
      "----- BEGIN FIRST PREVIEW -----",
      "+ first preview line",
      "- first removed line",
      "----- END FIRST PREVIEW -----",
      "",
      "[ADE] 87000 bytes were left out.",
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

describe("formatDoneTurnTokenLine", () => {
  it("formats in/out/cached tokens like the Claude and Codex divider line", () => {
    expect(formatDoneTurnTokenLine({
      inputTokens: 1200,
      outputTokens: 80,
      cacheReadTokens: 400,
    })).toBe("in 1.2k · out 80 · cached 400 ✶");
  });

  it("omits empty buckets and never includes cost or dollar amounts", () => {
    const line = formatDoneTurnTokenLine({
      inputTokens: 12,
      outputTokens: 0,
      cacheReadTokens: null,
    });
    expect(line).toBe("in 12");
    expect(line).not.toMatch(/\$|usd|cost/i);
    expect(formatDoneTurnTokenLine({ inputTokens: 0, outputTokens: 0 })).toBeNull();
  });
});

describe("chatTranscriptRows edge cases", () => {
  it("filters out non-visual activity and token accounting events", () => {
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
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:02.000Z",
        event: { type: "tokens", turnId: "turn-1", inputTokens: 406_700, outputTokens: 1_200 },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:03.000Z",
        event: {
          type: "codex_token_usage",
          turnId: "turn-1",
          usage: { last: { inputTokens: 406_700 }, modelContextWindow: 1_000_000 },
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:04.000Z",
        event: {
          type: "codex_moderation_metadata",
          turnId: "turn-1",
          metadata: { turnId: "turn-1", metadata: { is_blocked: false } },
        },
      },
    ]);
    expect(rows).toHaveLength(0);
  });

  it("removes legacy retry notices while retaining non-retry provider health", () => {
    const rows = collapseChatTranscriptEvents([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "system_notice",
          noticeKind: "warning",
          message: "Claude API retry 2/10: unknown",
          detail: "retrying in 4s",
          turnId: "turn-1",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: {
          type: "system_notice",
          noticeKind: "provider_health",
          message: "Codex hit a provider error and is retrying automatically.",
          detail: "Temporary upstream failure.",
          turnId: "turn-1",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:02.000Z",
        event: {
          type: "system_notice",
          noticeKind: "provider_health",
          message: "Context limit reached — OpenCode will try to compact the conversation.",
          detail: "Context window exceeded.",
          turnId: "turn-1",
        },
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.event).toMatchObject({
      type: "system_notice",
      message: "Context limit reached — OpenCode will try to compact the conversation.",
    });
  });

  it("keeps a legacy Claude authentication failure visible during replay", () => {
    const event = {
      type: "system_notice" as const,
      noticeKind: "warning" as const,
      status: "authentication_failed",
      message: "Claude API retry 2/10: authentication failed",
      detail: "HTTP 401",
      turnId: "turn-1",
    };
    const rows = collapseChatTranscriptEvents([{
      sessionId: "session-1",
      timestamp: "2026-03-17T10:00:00.000Z",
      event,
    }]);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.event).toMatchObject(event);
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

  it("keeps one usage notice per turn even when other rows land between the copies", () => {
    // Regression: dedupe compared against the IMMEDIATELY previous row, so the
    // background job lines a fan-out pushes between two copies of the same
    // notice broke the adjacency and the card repeated all through the turn.
    const notice = {
      type: "system_notice" as const,
      noticeKind: "rate_limit" as const,
      message: "Approaching Claude plan limit",
      turnId: "turn-1",
    };
    const rows = collapseChatTranscriptEvents([
      env("2026-08-06T10:00:00.000Z", notice),
      env("2026-08-06T10:00:01.000Z", {
        type: "subagent_started",
        taskId: "bg-1",
        taskType: "background",
        description: "wait for desktop agents",
      }),
      env("2026-08-06T10:00:02.000Z", { ...notice }),
      env("2026-08-06T10:00:03.000Z", {
        type: "subagent_started",
        taskId: "bg-2",
        taskType: "background",
        description: "wait for desktop agents",
      }),
      env("2026-08-06T10:00:04.000Z", { ...notice }),
    ]);

    expect(rows.filter((row) => row.event.type === "system_notice")).toHaveLength(1);
    expect(rows.filter((row) => row.event.type === "background_job_line")).toHaveLength(2);
  });

  it("still renders distinct notice kinds and the same notice in a later turn", () => {
    const rows = collapseChatTranscriptEvents([
      env("2026-08-06T10:00:00.000Z", {
        type: "system_notice",
        noticeKind: "rate_limit",
        message: "Approaching Claude plan limit",
        turnId: "turn-1",
      }),
      env("2026-08-06T10:00:01.000Z", {
        type: "system_notice",
        noticeKind: "warning",
        message: "Approaching Claude plan limit",
        turnId: "turn-1",
      }),
      env("2026-08-06T10:00:02.000Z", {
        type: "system_notice",
        noticeKind: "rate_limit",
        message: "A different usage message",
        turnId: "turn-1",
      }),
      // Same notice, next turn — a fresh turn hitting the limit is news again.
      env("2026-08-06T10:05:00.000Z", {
        type: "system_notice",
        noticeKind: "rate_limit",
        message: "Approaching Claude plan limit",
        turnId: "turn-2",
      }),
    ]);

    expect(rows.filter((row) => row.event.type === "system_notice")).toHaveLength(4);
  });

  it("keeps a plan-mode proposal as its own plan card beside the task list of the same turn", () => {
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

    expect(rows.map((row) => [row.key, row.event.type])).toEqual([
      ["task-list:session-1", "task_list"],
      [expect.any(String), "plan"],
    ]);
    const taskList = rows[0]!.event;
    if (taskList.type !== "task_list") throw new Error("Expected the task list row");
    expect(taskList.list).toEqual({
      source: "plan",
      label: "Implementation plan",
      turnId: "turn-1",
      items: [{ id: "step-0", label: "Wire the command", status: "done" }],
    });
    const proposal = rows[1]!.event;
    if (proposal.type !== "plan") throw new Error("Expected the proposal card");
    expect(proposal.steps).toEqual([]);
    expect(proposal.streamingText).toBe("Streaming the next detail");
  });

  it("merges a proposal's deltas and completion into one plan card", () => {
    const rows = collapseChatTranscriptEvents([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: { type: "plan", turnId: "turn-1", itemId: "plan-1", state: "delta", streamingText: "Drafting", steps: [] },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:01.000Z",
        event: { type: "plan", turnId: "turn-1", itemId: "plan-1", state: "complete", streamingText: "Drafting the plan", steps: [] },
      },
    ]);

    expect(rows).toHaveLength(1);
    const plan = rows[0]!.event;
    if (plan.type !== "plan") throw new Error("Expected merged plan row");
    expect(plan.itemId).toBe("plan-1");
    expect(plan.state).toBe("complete");
    expect(plan.streamingText).toBe("Drafting the plan");
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

  it("keeps ONE task-list row, keyed per session, that moves to the turn of its latest update", () => {
    const env = (second: number, event: AgentChatEventEnvelope["event"]): AgentChatEventEnvelope => ({
      sessionId: "session-1",
      timestamp: `2026-03-17T10:00:${String(second).padStart(2, "0")}.000Z`,
      event,
    });
    const events = [
      env(0, { type: "user_message", text: "Plan it", turnId: "turn-1" }),
      env(1, { type: "todo_update", turnId: "turn-1", items: [{ id: "t-1", description: "Task 1", status: "in_progress" }] }),
      env(2, { type: "text", text: "Working on it.", turnId: "turn-1", itemId: "a-1" }),
      env(3, { type: "done", turnId: "turn-1", status: "completed" }),
      env(4, { type: "user_message", text: "Continue", turnId: "turn-2" }),
      env(5, {
        type: "todo_update",
        turnId: "turn-2",
        items: [
          { id: "t-1", description: "Task 1", status: "completed" },
          { id: "t-2", description: "Task 2", status: "in_progress" },
        ],
      }),
      env(6, { type: "text", text: "Next.", turnId: "turn-2", itemId: "a-2" }),
    ];
    const rows = collapseChatTranscriptEvents(events);
    const taskRows = rows.filter((row) => row.event.type === "task_list");
    expect(taskRows).toHaveLength(1);
    expect(rows.some((row) => row.event.type === "todo_update" || row.event.type === "plan")).toBe(false);
    // It sits where the latest update landed: after turn 2's user message.
    expect(rows.map((row) => row.event.type)).toEqual([
      "user_message", "text", "done", "user_message", "task_list", "text",
    ]);
    const row = taskRows[0]!;
    expect(row.key).toBe("task-list:session-1");
    expect(row.sceneScopeKey).toBeDefined();
    if (row.event.type !== "task_list") throw new Error("Expected task_list");
    expect(row.event.turnId).toBe("turn-2");
    expect(row.event.list.items.map((item) => [item.label, item.status])).toEqual([
      ["Task 1", "done"],
      ["Task 2", "running"],
    ]);
    // Before turn 2 the same key sat in turn 1.
    const before = collapseChatTranscriptEvents(events.slice(0, 4));
    expect(before.map((entry) => entry.key)).toContain("task-list:session-1");
    expect(before.map((entry) => entry.event.type)).toEqual(["user_message", "task_list", "text", "done"]);
  });

  it("removes the task-list row when the list is cleared, and leaves unrelated plans alone", () => {
    const env = (second: number, event: AgentChatEventEnvelope["event"]): AgentChatEventEnvelope => ({
      sessionId: "session-1",
      timestamp: `2026-03-17T10:00:0${second}.000Z`,
      event,
    });
    const rows = collapseChatTranscriptEvents([
      env(0, { type: "plan", turnId: "turn-1", steps: [{ text: "Step", status: "pending" }] }),
      // ACP plan_removed.
      env(1, { type: "plan", turnId: "turn-1", steps: [] }),
    ]);
    expect(rows).toEqual([]);
  });

  it("stays in parity between incremental and full collapse while the task list moves past keyed rows", () => {
    const env = (second: number, event: AgentChatEventEnvelope["event"]): AgentChatEventEnvelope => ({
      sessionId: "session-1",
      timestamp: `2026-06-01T10:00:${String(second).padStart(2, "0")}.000Z`,
      event,
    });
    const stream: AgentChatEventEnvelope[] = [
      env(0, { type: "user_message", text: "Go", turnId: "turn-1" }),
      env(1, { type: "plan", turnId: "turn-1", explanation: "Ship", steps: [{ text: "A", status: "in_progress" }] }),
      env(2, { type: "subagent_started", taskId: "agent-1", agentType: "Explore", description: "Look around", turnId: "turn-1" }),
      env(3, { type: "todo_update", turnId: "turn-1", items: [{ id: "1", description: "A", status: "completed" }] }),
      // Updates the spawn anchor through its stored index, which the move shifted.
      env(4, { type: "subagent_progress", taskId: "agent-1", summary: "reading files", turnId: "turn-1" }),
      env(5, { type: "subagent_result", taskId: "agent-1", status: "completed", summary: "done", turnId: "turn-1" }),
      env(6, { type: "plan", turnId: "turn-1", steps: [] }),
      env(7, { type: "todo_update", turnId: "turn-1", items: [{ id: "x", description: "New", status: "pending" }] }),
    ];
    const full = collapseChatTranscriptEvents(stream);
    let prevEvents: AgentChatEventEnvelope[] = [];
    let prev = collapseChatTranscriptEventsWithContext(prevEvents);
    for (let index = 1; index <= stream.length; index += 1) {
      const nextEvents = stream.slice(0, index);
      prev = collapseChatTranscriptEventsIncrementalWithContext(nextEvents, prevEvents, prev.rows, prev.context);
      prevEvents = nextEvents;
      expect(prev.rows).toEqual(collapseChatTranscriptEvents(nextEvents));
    }
    expect(prev.rows).toEqual(full);
    expect(full.map((row) => row.event.type)).toEqual(["user_message", "subagent_result_card", "task_list"]);
  });

  it("keeps the task list out of activity bundles and renders subagents as separate cards", () => {
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

    // The todo feeds the one task-list row; the cron bundles on its own.
    // Explore is still running (different taskId than the workflow result), so
    // its spawn card stays. The workflow is one result card.
    expect(rows.map((row) => row.event.type)).toEqual([
      "task_list",
      "activity_bundle",
      "subagent_spawn_anchor",
      "subagent_result_card",
    ]);
    if (rows[1]!.event.type !== "activity_bundle") throw new Error("Expected activity_bundle");
    expect(rows[1]!.event.items.map((item) => item.event.type)).toEqual([
      "scheduled_work_update",
    ]);
  });

  it("normalizes canonical dotted subagent lifecycle events into one result card", () => {
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
      "subagent_result_card",
    ]);
    if (rows[0]!.event.type !== "subagent_result_card") throw new Error("Expected result card");
    expect(rows[0]!.event.agentKey).toBe("agent-canonical");
    expect(rows[0]!.event.summaryPreview).toBe("Canonical lifecycle mapped.");
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
          type: "scheduled_work_update",
          id: "wake-1",
          kind: "wakeup",
          status: "scheduled",
          title: "First unknown turn wake-up",
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

  it("rejoins same-turn scheduled-work bundles after a hidden tool-only row is filtered", () => {
    const grouped = groupEvents([
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:00.000Z",
        event: {
          type: "scheduled_work_update",
          id: "cron-1",
          kind: "cron",
          status: "scheduled",
          title: "Nightly",
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
          type: "scheduled_work_update",
          id: "wake-1",
          kind: "wakeup",
          status: "scheduled",
          title: "Check back",
          turnId: "turn-1",
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
      "scheduled_work_update",
      "scheduled_work_update",
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

  it("draws no row for a data-only sources event and lists a web tool's sources as results", () => {
    const rows = collapseChatTranscriptEvents([
      {
        sessionId: "session-1",
        timestamp: "2026-09-23T10:00:00.000Z",
        event: { type: "tool_call", tool: "webSearch", args: { searchTerm: "ade" }, itemId: "t-1", turnId: "turn-1" },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-09-23T10:00:01.000Z",
        event: {
          type: "tool_result",
          tool: "webSearch",
          result: { status: "success" },
          sources: [
            { kind: "web_search_result", url: "https://ade-app.dev", title: "ADE" },
            { kind: "file", path: "/repo/notes.md" },
          ],
          itemId: "t-1",
          turnId: "turn-1",
          status: "completed",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-09-23T10:00:02.000Z",
        event: { type: "sources", sources: [{ kind: "citation", url: "https://ade-app.dev", cited: true }], itemId: "m-1", turnId: "turn-1" },
      },
    ]);
    expect(rows).toHaveLength(1);
    if (rows[0]!.event.type !== "work_log_entry") throw new Error("Expected work_log_entry");
    expect(rows[0]!.event.entry).toMatchObject({
      entryKind: "tool",
      results: [{ url: "https://ade-app.dev", title: "ADE" }],
      resultsTotal: 1,
    });
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

  it("keeps the resumed half when the paused half arrives after it", () => {
    // Last-wins alone would settle the row on "Paused" for a machine that is
    // demonstrably awake. Reachable two ways: a sequence inversion (this product
    // has shipped restarting eventSequence, and old transcripts replay that
    // numbering verbatim) and a host clock corrected across the wake. iOS
    // applies the same guard, so the two cannot disagree.
    const resumedThenPaused: AgentChatEventEnvelope[] = [
      {
        sessionId: "session-1",
        timestamp: "2026-01-01T12:04:01.000Z",
        event: {
          type: "system_notice",
          noticeKind: "info",
          status: "host_awake",
          message: "Resumed · paused 4m",
          detail: { hostSleep: { sleepId: "host-sleep-1", pausedMs: 240_000 } },
          turnId: "turn-1",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-01-01T12:00:01.000Z",
        event: {
          type: "system_notice",
          noticeKind: "info",
          status: "host_asleep",
          message: "Paused — computer asleep",
          detail: { hostSleep: { sleepId: "host-sleep-1" } },
          turnId: "turn-1",
        },
      },
    ];
    const rows = collapseChatTranscriptEvents(resumedThenPaused);
    const chips = rows.filter((row) => row.key.startsWith("host-sleep:"));
    expect(chips).toHaveLength(1);
    expect((chips[0]!.event as { status?: string }).status).toBe("host_awake");
    expect((chips[0]!.event as { message?: string }).message).toBe("Resumed · paused 4m");
  });

  it("resolves the host-sleep chip in place instead of appending a second artifact", () => {
    const pausedThenResumed: AgentChatEventEnvelope[] = [
      {
        sessionId: "session-1",
        timestamp: "2026-01-01T12:00:00.000Z",
        event: {
          type: "text",
          text: "Running tests…",
          turnId: "turn-1",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-01-01T12:00:01.000Z",
        event: {
          type: "system_notice",
          noticeKind: "info",
          status: "host_asleep",
          message: "Paused — computer asleep",
          detail: { hostSleep: { sleepId: "host-sleep-1" } },
          turnId: "turn-1",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-01-01T12:04:01.000Z",
        event: {
          type: "system_notice",
          noticeKind: "info",
          status: "host_awake",
          message: "Resumed · paused 4m",
          detail: { hostSleep: { sleepId: "host-sleep-1", pausedMs: 240_000 } },
          turnId: "turn-1",
        },
      },
    ];

    const rows = collapseChatTranscriptEvents(pausedThenResumed);
    const sleepRows = rows.filter((row) => row.key.startsWith("host-sleep:"));
    expect(sleepRows).toHaveLength(1);
    expect(sleepRows[0]?.event).toMatchObject({
      type: "system_notice",
      status: "host_awake",
      message: "Resumed · paused 4m",
    });

    // The incremental path must land on exactly the same single row, since it
    // is the one the live transcript actually runs.
    const incremental = collapseChatTranscriptEventsIncremental(
      pausedThenResumed,
      pausedThenResumed.slice(0, 2),
      collapseChatTranscriptEvents(pausedThenResumed.slice(0, 2)),
    );
    expect(incremental.filter((row) => row.key.startsWith("host-sleep:"))).toHaveLength(1);
    expect(incremental.map((row) => row.key)).toEqual(rows.map((row) => row.key));
  });

  it("gives a second sleep in the same turn its own chip", () => {
    const rows = collapseChatTranscriptEvents([
      {
        sessionId: "session-1",
        timestamp: "2026-01-01T12:00:01.000Z",
        event: {
          type: "system_notice",
          noticeKind: "info",
          status: "host_asleep",
          message: "Paused — computer asleep",
          detail: { hostSleep: { sleepId: "host-sleep-1" } },
          turnId: "turn-1",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-01-01T12:04:01.000Z",
        event: {
          type: "system_notice",
          noticeKind: "info",
          status: "host_awake",
          message: "Resumed · paused 4m",
          detail: { hostSleep: { sleepId: "host-sleep-1", pausedMs: 240_000 } },
          turnId: "turn-1",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-01-01T12:05:00.000Z",
        event: {
          type: "system_notice",
          noticeKind: "info",
          status: "host_asleep",
          message: "Paused — computer asleep",
          detail: { hostSleep: { sleepId: "host-sleep-2" } },
          turnId: "turn-1",
        },
      },
    ]);

    expect(rows.filter((row) => row.key.startsWith("host-sleep:"))).toHaveLength(2);
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

describe("spawn_completed notice folding", () => {
  // Each sibling TURN emits its own notice, distinguished by `childTurnId` —
  // that is why the byte-identical system-notice dedupe upstream never caught
  // these and a real transcript accrued 26 of them.
  let nextChildTurn = 0;
  const completion = (childSessionId: string, childTitle: string) =>
    ({
      type: "system_notice",
      noticeKind: "info",
      status: "spawn_completed",
      message: `Chat "${childTitle}" finished its turn`,
      detail: {
        spawnCompletion: {
          childSessionId,
          childTitle,
          spawnKind: "peer",
          childTurnId: `turn-${(nextChildTurn += 1)}`,
          status: "completed",
          summary: "Done.",
        },
      },
    }) satisfies AgentChatEventEnvelope["event"];

  const repeatCountOf = (row: { repeatCount?: number }): number | undefined => row.repeatCount;

  it("folds adjacent completions for the same child into one row that counts the repeats", () => {
    const rows = collapseChatTranscriptEvents([
      env("2026-06-01T10:00:00.000Z", completion("child-1", "Move/Regroup Engine and Undo")),
      env("2026-06-01T10:00:01.000Z", completion("child-1", "Move/Regroup Engine and Undo")),
      env("2026-06-01T10:00:02.000Z", completion("child-1", "Move/Regroup Engine and Undo")),
    ]);

    expect(rows).toHaveLength(1);
    // Latest timestamp wins so the row keeps sorting with the newest notice.
    expect(rows[0]!.timestamp).toBe("2026-06-01T10:00:02.000Z");
    expect(repeatCountOf(rows[0]!)).toBe(3);
  });

  it("does not fold across an intervening row, and never folds a different child", () => {
    const rows = collapseChatTranscriptEvents([
      env("2026-06-01T10:00:00.000Z", completion("child-1", "Engine")),
      env("2026-06-01T10:00:01.000Z", completion("child-2", "Docs")),
      env("2026-06-01T10:00:02.000Z", completion("child-1", "Engine")),
      env("2026-06-01T10:00:03.000Z", { type: "text", text: "Thanks.", messageId: "m-1" }),
      env("2026-06-01T10:00:04.000Z", completion("child-1", "Engine")),
    ]);

    const notices = rows.filter((row) => row.event.type === "system_notice");
    expect(notices).toHaveLength(4);
    expect(notices.map((row) => repeatCountOf(row))).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("keeps the incremental collapse byte-identical to a full recompute", () => {
    const stream: AgentChatEventEnvelope[] = [
      env("2026-06-01T10:00:00.000Z", completion("child-1", "Engine")),
      env("2026-06-01T10:00:01.000Z", completion("child-1", "Engine")),
      env("2026-06-01T10:00:02.000Z", completion("child-2", "Docs")),
      env("2026-06-01T10:00:03.000Z", completion("child-1", "Engine")),
      env("2026-06-01T10:00:04.000Z", completion("child-1", "Engine")),
      env("2026-06-01T10:00:05.000Z", { type: "text", text: "Thanks.", messageId: "m-1" }),
      env("2026-06-01T10:00:06.000Z", completion("child-1", "Engine")),
    ];

    const full = collapseChatTranscriptEvents(stream);
    let prevEvents: AgentChatEventEnvelope[] = [];
    const seed = collapseChatTranscriptEventsWithContext(prevEvents);
    let prevRows = seed.rows;
    let prevContext = seed.context;
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
});

describe("subagent one-card rendering", () => {
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

  it("collapses a double subagent_result into one card that settles in the spawn's row, richer summary wins", () => {
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
      "subagent_result_card",
    ]);
    const result = rows[0]!;
    if (result.event.type !== "subagent_result_card") throw new Error("Expected result card");
    // Richer summary wins over the "Status: …" placeholder.
    expect(result.event.summaryPreview).toBe(
      "Found the modal in src/components/UpdateModal.tsx and wired the trigger.",
    );
    expect(result.event.status).toBe("completed");
    // The spawn row settled in place: its key is unchanged.
    expect(result.key).toBe("subagent-spawn:agent-1");
  });

  it("reopens a resumed CLI child in the same card row and clears the prior result", () => {
    const startedAt = "2026-06-01T10:00:00.000Z";
    const resumedAt = "2026-06-01T10:05:00.000Z";
    const rows = collapseChatTranscriptEvents([
      env(startedAt, {
        type: "subagent_started",
        taskId: "chat:cli-child",
        agentId: "cli-child",
        provider: "codex",
        agentType: "codex",
        taskType: "subagent",
        spawnKind: "subagent",
        description: "Fix flaky tests",
      }),
      env("2026-06-01T10:01:00.000Z", {
        type: "subagent_result",
        taskId: "chat:cli-child",
        agentId: "cli-child",
        provider: "codex",
        agentType: "codex",
        status: "completed",
        summary: "All tests passed.",
      }),
      env(resumedAt, {
        type: "subagent_started",
        taskId: "chat:cli-child",
        agentId: "cli-child",
        provider: "codex",
        agentType: "codex",
        taskType: "subagent",
        spawnKind: "subagent",
        description: "Fix flaky tests",
        resumed: true,
      }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.key).toBe("subagent-spawn:chat:cli-child");
    expect(rows[0]?.event).toMatchObject({
      type: "subagent_spawn_anchor",
      provider: "codex",
      status: "running",
      startedAt: resumedAt,
      endedAt: null,
      resultSummary: null,
    });
  });

  it("settles the card in the spawn's position after many intervening rows", () => {
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

    expect(rows.map((row) => row.event.type)).toEqual(["subagent_result_card", "text", "text", "work_log_entry"]);
    expect(rows[0]!.key).toBe("subagent-spawn:agent-1");
    expect(rows.some((row) => row.event.type === "subagent_spawn_anchor")).toBe(false);
  });

  it("appends the result where it arrives when the spawn is not in the window", () => {
    const rows = collapseChatTranscriptEvents([
      env("2026-06-01T10:00:01.000Z", { type: "text", text: "one", messageId: "m-1" }),
      env("2026-06-01T10:00:04.000Z", {
        type: "subagent_result",
        taskId: "agent-1",
        status: "completed",
        summary: "done investigating",
      }),
      env("2026-06-01T10:00:05.000Z", {
        type: "subagent_result",
        taskId: "agent-1",
        status: "completed",
        summary: "done investigating, with a longer report",
      }),
    ]);
    expect(rows.map((row) => [row.event.type, row.key])).toEqual([
      ["text", expect.any(String)],
      ["subagent_result_card", "subagent-result:agent-1"],
    ]);
    // The richer re-emit updates that same appended card.
    expect(rows[1]!.event).toMatchObject({ summaryPreview: "done investigating, with a longer report" });
  });

  it("settles a late result (after the parent's done, during a later turn) in place", () => {
    const rows = collapseChatTranscriptEvents([
      env("2026-06-01T10:00:00.000Z", { type: "user_message", text: "go", turnId: "turn-1" }),
      env("2026-06-01T10:00:01.000Z", {
        type: "subagent_started",
        taskId: "agent-1",
        description: "Background scan",
        turnId: "turn-1",
      }),
      env("2026-06-01T10:00:02.000Z", { type: "text", text: "Scan running.", messageId: "m-1", turnId: "turn-1" }),
      env("2026-06-01T10:00:03.000Z", { type: "done", turnId: "turn-1", status: "completed" }),
      env("2026-06-01T10:00:04.000Z", { type: "user_message", text: "next", turnId: "turn-2" }),
      env("2026-06-01T10:00:05.000Z", {
        type: "subagent_result",
        taskId: "agent-1",
        status: "completed",
        summary: "Scan finished",
      }),
    ]);
    expect(rows.map((row) => row.event.type)).toEqual(["user_message", "subagent_result_card", "text", "done", "user_message"]);
    expect(rows[1]!.key).toBe("subagent-spawn:agent-1");
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

    // One result card — rebind must not create a second agent. The
    // render key stays bound to the original taskId (load-bearing for the virtualizer).
    expect(rows.map((row) => row.event.type)).toEqual([
      "subagent_result_card",
    ]);
    expect(rows[0]!.key).toBe("subagent-spawn:task-1");
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
      // Both background-job producers, so `background_job_line`'s context cache
      // (`backgroundJobRowIndexByKey`) and the `backgroundLineOpened` latch are
      // covered by the parity guarantee too — they are rebuilt from the event
      // stream on a full recompute and must not diverge from the incremental
      // path's carried state.
      env("2026-06-01T10:00:08.000Z", {
        type: "scheduled_work_update",
        id: "background:bg-live",
        kind: "background_task",
        status: "running",
        title: "cd /repo && npm run dev",
        sourceTaskId: "bg-live",
      }),
      env("2026-06-01T10:00:09.000Z", {
        type: "subagent_started",
        taskId: "bg-legacy",
        taskType: "background",
        description: "cd /repo && npm install",
      }),
      env("2026-06-01T10:00:10.000Z", {
        type: "scheduled_work_update",
        id: "background:bg-live",
        kind: "background_task",
        status: "completed",
        title: "cd /repo && npm run dev",
        sourceTaskId: "bg-live",
      }),
      env("2026-06-01T10:00:11.000Z", {
        type: "subagent_result",
        taskId: "bg-legacy",
        taskType: "background",
        status: "completed",
        summary: "exited 0",
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
      "subagent_result_card",
      "text",
    ]);
    const [result, remainingText] = full;
    expect(remainingText?.event).toMatchObject({
      type: "text",
      text: "Parent text that remains",
      messageId: "message-stays",
    });
    expect(result).toMatchObject({
      key: "subagent-spawn:agent-a",
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

  it("renders old-style background shell subagent events as one job line, no cards", () => {
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
    if (rows[0]!.event.type !== "background_job_line") throw new Error("Expected background job line");
    expect(rows[0]!.event.status).toBe("completed");
    expect(rows[0]!.event.label).toBe("npm run dev");
    expect(rows[0]!.key).toBe("background-chip:bg-1");
  });

  it("shows a background job in the thread while it is still running", () => {
    // Regression: the line used to be pushed only on the terminal event, so a
    // long background job left the thread completely silent while the sidebar
    // flipped to a duration-less "Working" — together they read as a hung turn.
    const rows = collapseChatTranscriptEvents([
      env("2026-06-01T10:00:00.000Z", {
        type: "subagent_started",
        taskId: "bg-1",
        taskType: "background",
        description: "cd /repo && npm install",
      }),
    ]);

    expect(rows).toHaveLength(1);
    if (rows[0]!.event.type !== "background_job_line") throw new Error("Expected background job line");
    expect(rows[0]!.event.status).toBe("running");
    expect(rows[0]!.event.label).toBe("npm install");
    expect(rows[0]!.event.taskId).toBe("bg-1");
    expect(rows[0]!.key).toBe("background-chip:bg-1");
  });

  it("mutates the running background line in place instead of adding a finish row", () => {
    const rows = collapseChatTranscriptEvents([
      env("2026-06-01T10:00:00.000Z", {
        type: "subagent_started",
        taskId: "bg-1",
        taskType: "background",
        description: "cd /repo && npm install",
      }),
      env("2026-06-01T10:00:01.000Z", {
        type: "subagent_progress",
        taskId: "bg-1",
        summary: "resolving packages",
      }),
      env("2026-06-01T10:00:30.000Z", {
        type: "subagent_result",
        taskId: "bg-1",
        taskType: "background",
        status: "completed",
        summary: "exited 0",
      }),
    ]);

    // One row for the job's whole life — spawn, progress, and finish all land
    // on the same key, so a turn that starts several jobs cannot stack rows.
    expect(rows).toHaveLength(1);
    const settled = rows[0]!.event;
    if (settled.type !== "background_job_line") throw new Error("Expected background job line");
    if (settled.status === "running") throw new Error("Expected a settled job line");
    expect(settled.status).toBe("completed");
    expect(settled.durationMs).toBe(30_000);
    expect(rows[0]!.key).toBe("background-chip:bg-1");
  });

  it("does not reopen a settled background line when a late progress tick arrives", () => {
    // Providers do emit a trailing progress notification after a job already
    // settled. Rewriting the row back to `running` would drop its exit code and
    // duration and restart a ticker that then never stops.
    const rows = collapseChatTranscriptEvents([
      env("2026-06-01T10:00:00.000Z", {
        type: "subagent_started",
        taskId: "bg-1",
        taskType: "background",
        description: "cd /repo && npm install",
      }),
      env("2026-06-01T10:00:30.000Z", {
        type: "subagent_result",
        taskId: "bg-1",
        taskType: "background",
        status: "completed",
        summary: "exited 0",
      }),
      env("2026-06-01T10:00:31.000Z", {
        type: "subagent_progress",
        taskId: "bg-1",
        summary: "late tick",
      }),
    ]);

    expect(rows).toHaveLength(1);
    const settled = rows[0]!.event;
    if (settled.type !== "background_job_line") throw new Error("Expected background job line");
    expect(settled.status).toBe("completed");
  });

  it("keeps a background job as one line when a late agentType would reclassify it", () => {
    // `preferredSubagentAgentType` upgrades "background" to a real agent type,
    // which used to flip the classification mid-flight: the running one-liner
    // was stranded forever AND a full subagent result card was pushed for the
    // same task.
    const rows = collapseChatTranscriptEvents([
      env("2026-06-01T10:00:00.000Z", {
        type: "subagent_started",
        taskId: "bg-1",
        taskType: "background",
        description: "cd /repo && npm install",
      }),
      env("2026-06-01T10:00:30.000Z", {
        type: "subagent_result",
        taskId: "bg-1",
        taskType: "background",
        agentType: "Explore",
        status: "completed",
        summary: "exited 0",
      }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.event.type).toBe("background_job_line");
  });

  it("dedupes a double background result into one job line", () => {
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
    if (rows[0]!.event.type !== "background_job_line") throw new Error("Expected background job line");
    expect(rows[0]!.event.status).toBe("failed");
  });

  it("renders the LIVE background_task scheduled_work stream as the job line", () => {
    // This is the only shape a running app actually emits for a backgrounded
    // shell: `emitClaudeBackgroundTaskUpdate` fires a background_task
    // scheduled_work_update on spawn and on exit, and deliberately emits NO
    // subagent lifecycle events for these tasks. It used to be dropped outright,
    // so the in-thread row existed only for legacy replayed transcripts and
    // never appeared for a job you actually started.
    const rows = collapseChatTranscriptEvents([
      env("2026-06-01T10:00:00.000Z", {
        type: "scheduled_work_update",
        id: "background:bg-task-1",
        kind: "background_task",
        status: "running",
        title: "cd /repo && npm run dev",
        sourceTaskId: "bg-task-1",
      }),
      env("2026-06-01T10:00:01.000Z", {
        type: "scheduled_work_update",
        id: "cron-1",
        kind: "cron",
        status: "scheduled",
        title: "Nightly",
      }),
    ]);

    expect(rows).toHaveLength(2);
    const job = rows[0]!.event;
    if (job.type !== "background_job_line") throw new Error("Expected background job line");
    expect(job.status).toBe("running");
    expect(job.label).toBe("npm run dev");
    // Same key space as the legacy subagent producer, so a transcript carrying
    // both shapes for one task still renders exactly one row.
    expect(rows[0]!.key).toBe("background-chip:bg-task-1");
    // Other scheduled kinds are untouched.
    if (rows[1]!.event.type !== "scheduled_work_update") throw new Error("Expected scheduled_work_update");
    expect(rows[1]!.event.kind).toBe("cron");
  });

  it("never renders a job line for a real subagent reported through the background stream", () => {
    // `applyClaudeBackgroundTasksLevel` gates only on task_type, so an agent
    // that reports none reaches the background emitter. Without the identity
    // guard the agent got its spawn/result cards AND a job line wedged between
    // them. Both orderings are covered — the stream is unspecified.
    const scheduledFirst = collapseChatTranscriptEvents([
      env("2026-06-01T10:00:00.000Z", {
        type: "scheduled_work_update",
        id: "background:agent-1",
        kind: "background_task",
        status: "running",
        title: "Investigate route tree",
        sourceTaskId: "agent-1",
      }),
      env("2026-06-01T10:00:01.000Z", {
        type: "subagent_started",
        taskId: "agent-1",
        agentType: "Explore",
        description: "Investigate route tree",
      }),
    ]);
    expect(scheduledFirst.map((row) => row.event.type)).toEqual(["subagent_spawn_anchor"]);

    const lifecycleFirst = collapseChatTranscriptEvents([
      env("2026-06-01T10:00:00.000Z", {
        type: "subagent_started",
        taskId: "agent-1",
        agentType: "Explore",
        description: "Investigate route tree",
      }),
      env("2026-06-01T10:00:01.000Z", {
        type: "scheduled_work_update",
        id: "background:agent-1",
        kind: "background_task",
        status: "running",
        title: "Investigate route tree",
        sourceTaskId: "agent-1",
      }),
    ]);
    expect(lifecycleFirst.map((row) => row.event.type)).toEqual(["subagent_spawn_anchor"]);
  });

  it("drops the job line when a real subagent's ONLY lifecycle event is its result", () => {
    // Reachable from a truncated or replayed transcript: history paging can
    // drop `subagent_started` while the scheduled-work update survives. The
    // guard used to live only on the spawn path, so this ordering left the job
    // line in the transcript beside the agent's card pair.
    const rows = collapseChatTranscriptEvents([
      env("2026-06-01T10:00:00.000Z", {
        type: "scheduled_work_update",
        id: "background:agent-1",
        kind: "background_task",
        status: "running",
        title: "Investigate route tree",
        sourceTaskId: "agent-1",
      }),
      env("2026-06-01T10:00:30.000Z", {
        type: "subagent_result",
        taskId: "agent-1",
        agentType: "Explore",
        status: "completed",
        summary: "found it",
      }),
    ]);

    expect(rows.map((row) => row.event.type)).not.toContain("background_job_line");
    expect(rows.map((row) => row.event.type)).toEqual(["subagent_result_card"]);
  });

  it("settles the live background job line in place with a measured duration", () => {
    const rows = collapseChatTranscriptEvents([
      env("2026-06-01T10:00:00.000Z", {
        type: "scheduled_work_update",
        id: "background:bg-task-1",
        kind: "background_task",
        status: "running",
        title: "cd /repo && npm test",
        sourceTaskId: "bg-task-1",
      }),
      env("2026-06-01T10:02:00.000Z", {
        type: "scheduled_work_update",
        id: "background:bg-task-1",
        kind: "background_task",
        status: "failed",
        title: "cd /repo && npm test",
        sourceTaskId: "bg-task-1",
      }),
    ]);

    expect(rows).toHaveLength(1);
    const settled = rows[0]!.event;
    if (settled.type !== "background_job_line") throw new Error("Expected background job line");
    if (settled.status === "running") throw new Error("Expected a settled job line");
    expect(settled.status).toBe("failed");
    // Measured from the row's own first sighting, not from the terminal event.
    expect(settled.durationMs).toBe(120_000);
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
      key: "turn-details:turn-1",
      event: {
        type: "turn_details",
        turnId: "turn-1",
        diagnostics: [{
          source: "turn-1",
          event: { moderationChecks: 2, optionalIntegrationFailures: [{ integration: "unityMCP" }] },
        }],
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
      type: "turn_details",
      turnId: "turn-1",
      recovery: { type: "turn_recovery", action: "nudge", state: "recovered" },
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
  it("folds a run of 4 stopped-interrupted results into one group while a completed result stays individual", () => {
    const grouped = groupEvents([
      env("2026-07-11T10:00:00.000Z", { type: "subagent_started", taskId: "agent-a", agentType: "explorer", description: "Explore auth flow" }),
      env("2026-07-11T10:00:00.100Z", { type: "subagent_started", taskId: "agent-b", agentType: "explorer", description: "Explore sync flow" }),
      env("2026-07-11T10:00:00.200Z", { type: "subagent_started", taskId: "agent-c", agentType: "explorer", description: "Explore the UI" }),
      env("2026-07-11T10:00:00.250Z", { type: "subagent_started", taskId: "agent-e", agentType: "explorer", description: "Explore the tests" }),
      env("2026-07-11T10:00:00.300Z", { type: "subagent_started", taskId: "agent-d", agentType: "builder", description: "Build the widget" }),
      // agent-d finishes for real; then the user interrupts and the rest are swept to "stopped".
      env("2026-07-11T10:00:05.000Z", { type: "subagent_result", taskId: "agent-d", status: "completed", summary: "Widget built" }),
      env("2026-07-11T10:00:06.000Z", { type: "subagent_result", taskId: "agent-a", status: "stopped", summary: "Interrupted", finalSummary: "Interrupted", stopSource: "user" }),
      env("2026-07-11T10:00:06.001Z", { type: "subagent_result", taskId: "agent-b", status: "stopped", summary: "Interrupted", finalSummary: "Interrupted", stopSource: "user" }),
      env("2026-07-11T10:00:06.002Z", { type: "subagent_result", taskId: "agent-c", status: "stopped", summary: "Interrupted", finalSummary: "Interrupted", stopSource: "user" }),
      env("2026-07-11T10:00:06.003Z", { type: "subagent_result", taskId: "agent-e", status: "stopped", summary: "Interrupted", finalSummary: "Interrupted", stopSource: "user" }),
    ]);

    // Exactly one folded group — never a wall of identical stopped cards.
    const groups = grouped.filter((row) => row.event.type === "subagent_stopped_group");
    expect(groups).toHaveLength(1);
    const group = groups[0]!;
    if (group.event.type !== "subagent_stopped_group") throw new Error("Expected stopped group");
    // Cause AND attribution are part of the key: an interrupt group, a
    // usage-limit group, and an ADE-restart group can all start at the same
    // agent, and sharing a key would make React reuse one card's state.
    expect(group.key).toBe("subagent-stopped-group:interrupt:user:unknown:agent-a");
    expect(group.event.cause).toBe("interrupt");
    expect(group.event.stopSource).toBe("user");
    expect(group.event.count).toBe(4);
    expect(group.event.items).toEqual([
      { agentKey: "agent-a", title: "Explore auth flow", lastActivity: null, resultLanded: false },
      { agentKey: "agent-b", title: "Explore sync flow", lastActivity: null, resultLanded: false },
      { agentKey: "agent-c", title: "Explore the UI", lastActivity: null, resultLanded: false },
      { agentKey: "agent-e", title: "Explore the tests", lastActivity: null, resultLanded: false },
    ]);
    // The folded cards' keys (they settled in place under their spawn keys),
    // so a jump to one of them lands on the group.
    expect(group.event.memberKeys).toEqual([
      "subagent-spawn:agent-a",
      "subagent-spawn:agent-b",
      "subagent-spawn:agent-c",
      "subagent-spawn:agent-e",
    ]);
    // agent-d settled in its own spawn slot, after the folded run.
    expect(grouped.map((row) => row.event.type)).toEqual(["subagent_stopped_group", "subagent_result_card"]);

    // The completed agent keeps its own result card (real summary the user wants to read).
    const resultCards = grouped.filter((row) => row.event.type === "subagent_result_card");
    expect(resultCards).toHaveLength(1);
    if (resultCards[0]!.event.type !== "subagent_result_card") throw new Error("Expected result card");
    expect(resultCards[0]!.event.status).toBe("completed");
    expect(resultCards[0]!.event.summaryPreview).toBe("Widget built");
  });

  it("keeps up to three stopped cards as cards so they sit beside their siblings", () => {
    const grouped = groupEvents([
      env("2026-07-11T10:00:00.000Z", { type: "subagent_started", taskId: "agent-a", agentType: "explorer", description: "Explore auth flow" }),
      env("2026-07-11T10:00:00.100Z", { type: "subagent_started", taskId: "agent-b", agentType: "explorer", description: "Explore sync flow" }),
      env("2026-07-11T10:00:00.200Z", { type: "subagent_started", taskId: "agent-c", agentType: "explorer", description: "Explore the UI" }),
      env("2026-07-11T10:00:06.000Z", { type: "subagent_result", taskId: "agent-a", status: "stopped", summary: "Interrupted", stopSource: "user" }),
      env("2026-07-11T10:00:06.001Z", { type: "subagent_result", taskId: "agent-b", status: "stopped", summary: "Interrupted", stopSource: "user" }),
      env("2026-07-11T10:00:06.002Z", { type: "subagent_result", taskId: "agent-c", status: "stopped", summary: "Interrupted", stopSource: "user" }),
    ]);
    expect(grouped.map((row) => row.event.type)).toEqual([
      "subagent_result_card",
      "subagent_result_card",
      "subagent_result_card",
    ]);
  });

  it("never folds a stopped card whose report landed or that says something of its own", () => {
    const ids = ["agent-a", "agent-b", "agent-c", "agent-d", "agent-e"];
    const grouped = groupEvents([
      ...ids.map((id, index) => env(`2026-07-11T10:00:0${index}.000Z`, { type: "subagent_started", taskId: id, description: `Explore ${id}` })),
      // agent-b's report lands before the stop; agent-c's stop carries a real summary.
      env("2026-07-11T10:00:05.000Z", { type: "subagent_result", taskId: "agent-b", status: "completed", summary: "Auth flow mapped" }),
      env("2026-07-11T10:00:06.000Z", { type: "subagent_result", taskId: "agent-a", status: "stopped", summary: "Interrupted", stopSource: "user" }),
      env("2026-07-11T10:00:06.001Z", { type: "subagent_result", taskId: "agent-b", status: "stopped", summary: "Interrupted", stopSource: "user" }),
      env("2026-07-11T10:00:06.002Z", { type: "subagent_result", taskId: "agent-c", status: "stopped", summary: "Found the stale cursor in syncHost.ts", stopSource: "user" }),
      env("2026-07-11T10:00:06.003Z", { type: "subagent_result", taskId: "agent-d", status: "stopped", summary: "Interrupted", stopSource: "user" }),
      env("2026-07-11T10:00:06.004Z", { type: "subagent_result", taskId: "agent-e", status: "stopped", summary: "Interrupted", stopSource: "user" }),
    ]);
    // Every card settles in its spawn slot. Only a/d/e are report-less, and b
    // and c split them: nothing folds.
    expect(grouped.some((row) => row.event.type === "subagent_stopped_group")).toBe(false);
    const cards = grouped.filter((row) => row.event.type === "subagent_result_card");
    expect(cards.map((row) => row.event.type === "subagent_result_card" ? row.event.agentKey : null))
      .toEqual(["agent-a", "agent-b", "agent-c", "agent-d", "agent-e"]);
    expect(cards.map((row) => row.event.type === "subagent_result_card" && row.event.resultLanded))
      .toEqual([false, true, false, false, false]);
  });

  it("steps over a hidden work-log row inside a run of stopped cards", () => {
    const ids = ["agent-a", "agent-b", "agent-c", "agent-d"];
    const stop = (id: string, at: string) => env(at, {
      type: "subagent_result",
      taskId: id,
      status: "stopped",
      summary: "Stopped: the ADE brain restarted",
      stopSource: "system",
      stopReason: "the ADE brain restarted",
      turnId: "turn-1",
    });
    const spawn = (id: string, at: string) => env(at, { type: "subagent_started", taskId: id, description: `Explore ${id}`, turnId: "turn-1" });
    // The parent ran a tool between its second and third spawn; the cards
    // settle in their spawn slots, so the tool row sits inside the run.
    const grouped = groupEvents([
      spawn("agent-a", "2026-07-11T10:00:00.000Z"),
      spawn("agent-b", "2026-07-11T10:00:01.000Z"),
      env("2026-07-11T10:00:01.500Z", {
        type: "tool_call",
        tool: "functions.exec_command",
        args: { cmd: "pwd" },
        itemId: "tool-1",
        turnId: "turn-1",
      }),
      spawn("agent-c", "2026-07-11T10:00:02.000Z"),
      spawn("agent-d", "2026-07-11T10:00:03.000Z"),
      ...ids.map((id, index) => stop(id, `2026-07-11T10:00:06.00${index}Z`)),
    ]);
    // The tool row draws nothing in the timeline, so it moves ahead of the one
    // group instead of splitting the mass stop into two pairs.
    expect(grouped.map((row) => row.event.type)).toEqual(["work_log_group", "subagent_stopped_group"]);
    const group = grouped[1]!;
    if (group.event.type !== "subagent_stopped_group") throw new Error("Expected stopped group");
    expect(group.event.count).toBe(4);
    expect(group.event.stopSource).toBe("system");
  });

  it.each(["system", "foreign-brain"] as const)("never lets a %s sweep stop replace a finished card", (stopSource) => {
    // The shape of the owner's transcript: the child's result lands, Codex
    // echoes "Agent active" after it, and a restart sweep later closes the
    // agent it thought was still open.
    const grouped = groupEvents([
      env("2026-09-23T18:56:00.000Z", { type: "subagent_started", taskId: "thread-1", agentId: "thread-1", agentType: "/root/desktop_scan", description: "/root/desktop_scan" }),
      env("2026-09-23T18:57:36.200Z", { type: "subagent_result", taskId: "thread-1", agentId: "thread-1", status: "completed", summary: "Found one IPC guard gap." }),
      env("2026-09-23T18:57:36.201Z", { type: "subagent_progress", taskId: "thread-1", agentId: "thread-1", description: "/root/desktop_scan", summary: "Agent active" }),
      env("2026-09-23T19:03:54.479Z", {
        type: "subagent_result",
        taskId: "thread-1",
        status: "stopped",
        summary: "Agent active",
        finalSummary: "Agent active",
        stopSource,
        stopReason: "the ADE brain restarted",
      }),
    ]);
    expect(grouped).toHaveLength(1);
    const card = grouped[0]!.event;
    if (card.type !== "subagent_result_card") throw new Error("Expected result card");
    expect(card.status).toBe("completed");
    expect(card.summaryPreview).toBe("Found one IPC guard gap.");
    // The duration ends where the agent ended, not at the sweep's clock.
    expect(card.durationMs).toBe(96_200);
    expect(card.stopSource).toBe("unknown");
  });

  it("still lets a user stop settle a running agent", () => {
    const grouped = groupEvents([
      env("2026-09-23T18:56:00.000Z", { type: "subagent_started", taskId: "task-1", description: "Explore auth flow" }),
      env("2026-09-23T18:56:10.000Z", { type: "subagent_result", taskId: "task-1", status: "stopped", summary: "Interrupted", stopSource: "user" }),
      env("2026-09-23T18:57:00.000Z", { type: "subagent_result", taskId: "task-1", status: "stopped", summary: "Stopped: the ADE brain restarted", stopSource: "system", stopReason: "the ADE brain restarted" }),
    ]);
    const card = grouped[0]!.event;
    if (card.type !== "subagent_result_card") throw new Error("Expected result card");
    // The later sweep neither re-attributes the user's stop nor stretches it.
    expect(card).toMatchObject({ status: "stopped", stopSource: "user", durationMs: 10_000 });
  });

  it("splits adjacent stopped groups when the stop reason changes", () => {
    const ids = ["a1", "a2", "a3", "a4", "b1", "b2", "b3", "b4"];
    const grouped = groupEvents([
      ...ids.map((id, index) => env(`2026-09-18T02:14:00.${index}00Z`, { type: "subagent_started", taskId: `agent-${id}`, agentType: "explorer", description: `Explore ${id}` })),
      ...ids.map((id, index) => env(`2026-09-18T02:14:07.00${index}Z`, {
        type: "subagent_result",
        taskId: `agent-${id}`,
        status: "stopped",
        summary: "Stopped",
        stopSource: "system",
        stopReason: id.startsWith("a") ? "reason-a" : "reason-b",
      })),
    ]);

    const groups = grouped.filter((row) => row.event.type === "subagent_stopped_group");
    expect(groups).toHaveLength(2);
    expect(groups.map((row) => row.key)).toEqual([
      "subagent-stopped-group:interrupt:system:reason-a:agent-a1",
      "subagent-stopped-group:interrupt:system:reason-b:agent-b1",
    ]);
    expect(groups.map((row) => row.event.type === "subagent_stopped_group" ? row.event.stopReason : null))
      .toEqual(["reason-a", "reason-b"]);
  });

  it("never folds an ADE-restart sweep into a user interrupt, and carries the reason", () => {
    const grouped = groupEvents([
      env("2026-09-18T02:14:00.000Z", { type: "subagent_started", taskId: "agent-a", agentType: "explorer", description: "Explore auth flow" }),
      env("2026-09-18T02:14:00.100Z", { type: "subagent_started", taskId: "agent-b", agentType: "explorer", description: "Explore sync flow" }),
      env("2026-09-18T02:14:07.000Z", { type: "subagent_result", taskId: "agent-a", status: "stopped", summary: "Interrupted", stopSource: "user" }),
      env("2026-09-18T02:14:08.000Z", { type: "subagent_result", taskId: "agent-b", status: "stopped", summary: "Stopped: lost on ADE restart", stopSource: "system", stopReason: "the ADE brain restarted" }),
    ]);
    // Two lone casualties with different attributions: neither folds into the
    // other, so no card can put the restart's victims under "you interrupted".
    expect(grouped.filter((row) => row.event.type === "subagent_stopped_group")).toHaveLength(0);
    const cards = grouped.filter((row) => row.event.type === "subagent_result_card");
    expect(cards).toHaveLength(2);
    if (cards[1]!.event.type !== "subagent_result_card") throw new Error("Expected result card");
    expect(cards[1]!.event.stopSource).toBe("system");
    expect(cards[1]!.event.stopReason).toBe("the ADE brain restarted");
  });

  it("folds a run of usage-limit failures into one group named for the cause", () => {
    // When the provider's limit lands, every live agent fails inside the same
    // second with the same sentence. N identical cards say nothing the count
    // does not — but the cause has to be named, or the row reads as an interrupt.
    const grouped = groupEvents([
      ...["a", "b", "c", "d"].map((id, index) => env(`2026-07-11T10:00:00.${index}00Z`, { type: "subagent_started", taskId: `agent-${id}`, agentType: "explorer", description: `Explore ${id}` })),
      ...["a", "b", "c", "d"].map((id, index) => env(`2026-07-11T10:00:06.00${index}Z`, { type: "subagent_result", taskId: `agent-${id}`, status: "failed", summary: "Usage limit reached", finalSummary: "Usage limit reached" })),
    ]);

    const groups = grouped.filter((row) => row.event.type === "subagent_stopped_group");
    expect(groups).toHaveLength(1);
    const group = groups[0]!;
    if (group.event.type !== "subagent_stopped_group") throw new Error("Expected stopped group");
    expect(group.event.cause).toBe("usage_limit");
    expect(group.event.count).toBe(4);
    expect(group.event.items.map((item) => item.agentKey)).toEqual(["agent-a", "agent-b", "agent-c", "agent-d"]);
  });

  it("never folds a real failure away, and never mixes causes in one group", () => {
    const grouped = groupEvents([
      ...["a", "b", "e", "f"].map((id, index) => env(`2026-07-11T10:00:00.0${index}0Z`, { type: "subagent_started", taskId: `agent-${id}`, agentType: "explorer", description: `Explore ${id}` })),
      env("2026-07-11T10:00:00.200Z", { type: "subagent_started", taskId: "agent-c", agentType: "builder", description: "Build the widget" }),
      env("2026-07-11T10:00:00.300Z", { type: "subagent_started", taskId: "agent-d", agentType: "builder", description: "Build the other widget" }),
      ...["a", "b", "e", "f"].map((id, index) => env(`2026-07-11T10:00:06.00${index}Z`, { type: "subagent_result", taskId: `agent-${id}`, status: "failed", summary: "Usage limit reached", finalSummary: "Usage limit reached" })),
      env("2026-07-11T10:00:06.012Z", { type: "subagent_result", taskId: "agent-c", status: "failed", summary: "TypeError: cannot read property of undefined", finalSummary: "TypeError: cannot read property of undefined" }),
      env("2026-07-11T10:00:06.013Z", { type: "subagent_result", taskId: "agent-d", status: "stopped", summary: "Interrupted", finalSummary: "Interrupted" }),
    ]);

    const groups = grouped.filter((row) => row.event.type === "subagent_stopped_group");
    expect(groups).toHaveLength(1);
    if (groups[0]!.event.type !== "subagent_stopped_group") throw new Error("Expected stopped group");
    expect(groups[0]!.event.cause).toBe("usage_limit");
    expect(groups[0]!.event.count).toBe(4);

    // The real error and the lone interrupt each keep their own card.
    const resultCards = grouped.filter((row) => row.event.type === "subagent_result_card");
    expect(resultCards).toHaveLength(2);
    expect(resultCards.map((row) => (
      row.event.type === "subagent_result_card" ? row.event.status : null
    ))).toEqual(["failed", "stopped"]);
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

  it.each([
    ["user", null],
    ["system", "the ADE brain restarted"],
    ["foreign-brain", "another ADE brain took over this chat"],
    ["provider", "the provider ended the turn"],
    ["unknown", null],
  ] as const)("keeps lone stopped-card attribution for %s", (stopSource, stopReason) => {
    const grouped = groupEvents([
      env("2026-09-18T02:14:00.000Z", { type: "subagent_started", taskId: "agent-a", agentType: "explorer", description: "Explore auth flow" }),
      env("2026-09-18T02:14:06.000Z", {
        type: "subagent_result",
        taskId: "agent-a",
        status: "stopped",
        summary: "Stopped",
        stopSource,
        ...(stopReason ? { stopReason } : {}),
      }),
    ]);

    expect(grouped).toHaveLength(1);
    expect(grouped[0]!.event).toMatchObject({
      type: "subagent_result_card",
      status: "stopped",
      stopSource,
      stopReason,
    });
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
        actions: [{ id: "retry", label: "Retry", kind: "primary" }],
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
    expect(merged.actions).toEqual([{ id: "retry", label: "Retry", kind: "primary" }]);
  });

  it("clears stale degradation state and retry actions as soon as healthy detail returns", () => {
    const rows = collapseChatTranscriptEvents([
      env("2026-07-27T10:00:00.000Z", card({ rows: [{ icon: "fail", text: "lint" }] })),
      env("2026-07-27T10:00:01.000Z", card({
        rows: [],
        degradedReason: "HTTP 403",
        actions: [{ id: "retry", label: "Retry", kind: "primary" }],
      })),
      env("2026-07-27T10:00:02.000Z", card({ rows: [{ icon: "pass", text: "lint" }] })),
    ]);

    const merged = rows[0]!.event;
    if (merged.type !== "ade_card") throw new Error("Expected ade_card");
    expect(merged.stale).toBe(false);
    expect(merged.rows).toEqual([{ icon: "pass", text: "lint" }]);
    expect(merged.degradedReason).toBeUndefined();
    expect(merged.actions).toEqual([]);
  });

  it("clears stale degradation state when a healthy detail refresh is genuinely empty", () => {
    const emptyProgress = { passed: 0, failed: 0, running: 0, queued: 0 };
    const rows = collapseChatTranscriptEvents([
      env("2026-07-27T10:00:00.000Z", card({
        variant: "pr_ci",
        rows: [{ icon: "fail", text: "lint" }],
        metrics: [{ label: "failed", value: "1" }],
        progress: { ...emptyProgress, failed: 1 },
      })),
      env("2026-07-27T10:00:01.000Z", card({
        variant: "pr_ci",
        rows: [],
        metrics: [],
        progress: emptyProgress,
        degradedReason: "HTTP 403",
        actions: [{ id: "retry", label: "Retry", kind: "primary" }],
      })),
      env("2026-07-27T10:00:02.000Z", card({
        variant: "pr_ci",
        rows: [],
        metrics: [],
        progress: emptyProgress,
      })),
    ]);

    const merged = rows[0]!.event;
    if (merged.type !== "ade_card") throw new Error("Expected ade_card");
    expect(merged.stale).toBe(false);
    expect(merged.rows).toEqual([]);
    expect(merged.metrics).toEqual([]);
    expect(merged.progress).toEqual(emptyProgress);
    expect(merged.degradedReason).toBeUndefined();
    expect(merged.actions).toEqual([]);
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

describe("text adjacency across an older-history prepend", () => {
  const textEvent = (text: string, index: number): AgentChatEventEnvelope => ({
    sessionId: "session-1",
    timestamp: `2026-03-17T10:00:0${index}.000Z`,
    event: { type: "text", text, turnId: "turn-1", itemId: "msg-1" },
  } as never);

  it("re-merges a message whose deltas straddle the page boundary", () => {
    // The row reducer merges into rows[rows.length - 1], so it is only correct
    // over a complete, in-order event list. A byte-cut page can split one
    // message's deltas across the seam: before the older page lands the reader
    // sees the tail alone, after it lands both halves must become ONE row.
    const older = [textEvent("Hello ", 1)];
    const resident = [textEvent("world", 2)];

    const before = collapseChatTranscriptEventsWithContext(resident);
    expect(before.rows).toHaveLength(1);

    const merged = prependOlderChatHistoryPage(older, resident);
    expect(merged.map((entry) => (entry.event as { text: string }).text)).toEqual(["Hello ", "world"]);

    // Incremental collapse must NOT be taken for a prepend: its fast path
    // assumes append-only growth, and reusing the cached rows here would leave
    // the message permanently split in two.
    const after = collapseChatTranscriptEventsIncrementalWithContext(
      merged,
      resident,
      before.rows,
      before.context,
    );
    expect(after.rows).toHaveLength(1);
    expect((after.rows[0]!.event as { text: string }).text).toBe("Hello world");
  });

  it("falls back to a full collapse whenever the leading events shift", () => {
    // The positional-identity guard is what detects a prepend. If it ever
    // regressed to a length comparison, a prepend would silently take the
    // append-only path.
    const resident = [textEvent("world", 2)];
    const previous = collapseChatTranscriptEventsWithContext(resident);
    const merged = prependOlderChatHistoryPage([textEvent("Hello ", 1)], resident);

    expect(merged.length).toBeGreaterThan(resident.length);
    expect(merged[resident.length - 1]).not.toBe(resident[resident.length - 1]);

    const after = collapseChatTranscriptEventsIncrementalWithContext(
      merged,
      resident,
      previous.rows,
      previous.context,
    );
    expect(after.rows).toEqual(collapseChatTranscriptEventsWithContext(merged).rows);
  });

  it("keeps an intervening non-text event between the halves of a message", () => {
    // Desktop only merges into the LAST row, so a tool call between two deltas
    // of one message keeps them as separate rows in original order.
    const events = [
      textEvent("A", 1),
      {
        sessionId: "session-1",
        timestamp: "2026-03-17T10:00:02.000Z",
        event: { type: "tool_call", tool: "Bash", itemId: "tool-1", turnId: "turn-1" },
      } as never as AgentChatEventEnvelope,
      textEvent("B", 3),
    ];
    const { rows } = collapseChatTranscriptEventsWithContext(events);
    const types = rows.map((row) => row.event.type);
    expect(types.indexOf("text")).toBeLessThan(types.lastIndexOf("text"));
    expect(types.filter((type) => type === "text")).toHaveLength(2);
  });
});

describe("voice call folding", () => {
  function voiceEvent(
    sequence: number,
    event: AgentChatEventEnvelope["event"],
    voiceCallId: string | null,
  ): AgentChatEventEnvelope {
    return {
      sessionId: "session-voice",
      timestamp: new Date(Date.UTC(2026, 8, 16, 12, 0, sequence)).toISOString(),
      sequence,
      event,
      ...(voiceCallId ? { provenance: { voiceCallId } } : {}),
    } as AgentChatEventEnvelope;
  }

  it("folds every row of one call into a single card", () => {
    const grouped = groupEvents([
      voiceEvent(1, { type: "user_message", text: "  what is failing on main?  " }, "call-1"),
      voiceEvent(2, { type: "text", text: "Two checks are red.", itemId: "a-1" }, "call-1"),
      voiceEvent(3, { type: "user_message", text: "fix the first one" }, "call-1"),
      voiceEvent(4, { type: "text", text: "On it.", itemId: "a-2" }, "call-1"),
    ]);

    expect(grouped).toHaveLength(1);
    const row = grouped[0]!;
    expect(row.key).toBe("voice-call:call-1");
    if (row.event.type !== "voice_call_group") throw new Error("expected a voice_call_group row");
    expect(row.event.callId).toBe("call-1");
    expect(row.event.exchanges).toBe(2);
    expect(row.event.openingLine).toBe("what is failing on main?");
    expect(row.event.hadApproval).toBe(false);
    expect(row.event.durationMs).toBe(3000);
    expect(row.event.rows).toHaveLength(4);
    expect(row.timestamp).toBe(row.event.rows[3]!.timestamp);
  });

  it("marks a call that raised an approval", () => {
    const grouped = groupEvents([
      voiceEvent(1, { type: "user_message", text: "delete the branch" }, "call-2"),
      voiceEvent(
        2,
        { type: "approval_request", itemId: "approval-1", kind: "command", description: "git branch -D x" },
        "call-2",
      ),
    ]);

    const card = grouped.find((row) => row.event.type === "voice_call_group");
    expect(card).toBeTruthy();
    if (card?.event.type !== "voice_call_group") throw new Error("expected a voice_call_group row");
    expect(card.event.hadApproval).toBe(true);
  });

  it("keeps two calls apart and leaves the typed message between them ungrouped", () => {
    const grouped = groupEvents([
      voiceEvent(1, { type: "user_message", text: "first call" }, "call-a"),
      voiceEvent(2, { type: "text", text: "sure", itemId: "a-1" }, "call-a"),
      voiceEvent(3, { type: "user_message", text: "typed by hand" }, null),
      voiceEvent(4, { type: "user_message", text: "second call" }, "call-b"),
      voiceEvent(5, { type: "text", text: "ok", itemId: "a-2" }, "call-b"),
    ]);

    expect(grouped.map((row) => row.event.type)).toEqual([
      "voice_call_group",
      "user_message",
      "voice_call_group",
    ]);
    expect(grouped.map((row) => row.key)).toEqual([
      "voice-call:call-a",
      grouped[1]!.key,
      "voice-call:call-b",
    ]);
    const typed = grouped[1]!;
    if (typed.event.type !== "user_message") throw new Error("expected the typed message to stay a user message");
    expect(typed.event.text).toBe("typed by hand");
  });

  it("produces no card at all when nothing carries a voice call id", () => {
    const events = [
      voiceEvent(1, { type: "user_message", text: "typed" }, null),
      voiceEvent(2, { type: "text", text: "answered", itemId: "a-1" }, null),
    ];
    const rows = collapseChatTranscriptEvents(events);
    const grouped = groupChatTranscriptRows(rows);

    expect(grouped.some((row) => row.event.type === "voice_call_group")).toBe(false);
    // The wrapper must be a no-op on a voice-free transcript: identical rows in
    // identical order, so today's transcript renders exactly as it did before.
    expect(grouped.map((row) => ({ key: row.key, timestamp: row.timestamp, type: row.event.type }))).toEqual(
      rows.map((row) => ({ key: row.key, timestamp: row.timestamp, type: row.event.type })),
    );
    expect(rows.every((row) => row.voiceCallId === undefined)).toBe(true);
  });

  it("stamps the call id onto every row a voice event produced", () => {
    const rows = collapseChatTranscriptEvents([
      voiceEvent(1, { type: "user_message", text: "hello" }, "call-3"),
    ]);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.voiceCallId === "call-3")).toBe(true);
  });

  // A subagent's card settles in place, so it keeps the voice call its spawn
  // row was stamped with (or none): it never moves into, or out of, a call. A
  // result whose spawn is not in the window is appended where it arrives and
  // claims the call its terminal event was spoken under, so an untagged row
  // never lands inside a tagged run (which would split one call into two cards
  // sharing the key `voice-call:${callId}`).
  it("keeps a settled subagent's card in the voice call its row belongs to, and untagged when there is none", () => {
    // 1. Spawned and settled inside the call — the tag comes off the spawn row.
    const spawnedInCall = collapseChatTranscriptEvents([
      voiceEvent(1, { type: "user_message", text: "look into the flake" }, "call-sub"),
      voiceEvent(
        2,
        { type: "subagent_started", taskId: "agent-voice", agentType: "Explore", description: "Find the flake" },
        "call-sub",
      ),
      voiceEvent(
        3,
        { type: "subagent_result", taskId: "agent-voice", status: "completed", summary: "It is a timing assumption." },
        "call-sub",
      ),
      voiceEvent(4, { type: "text", text: "Here is what it found.", itemId: "a-1" }, "call-sub"),
    ]);
    expect(spawnedInCall.some((row) => row.event.type === "subagent_spawn_anchor")).toBe(false);
    expect(spawnedInCall.find((row) => row.event.type === "subagent_result_card")!.voiceCallId).toBe("call-sub");

    // 2. Spawned BEFORE the call, settled inside it — the card stays in its
    //    place before the call, untagged, and the call stays one card.
    const settledInCall = collapseChatTranscriptEvents([
      voiceEvent(
        1,
        { type: "subagent_started", taskId: "agent-early", agentType: "Explore", description: "Find the flake" },
        null,
      ),
      voiceEvent(2, { type: "user_message", text: "anything from that agent?" }, "call-sub"),
      voiceEvent(
        3,
        { type: "subagent_result", taskId: "agent-early", status: "completed", summary: "It is a timing assumption." },
        "call-sub",
      ),
      voiceEvent(4, { type: "text", text: "Here is what it found.", itemId: "a-1" }, "call-sub"),
    ]);
    expect(settledInCall.find((row) => row.event.type === "subagent_result_card")!.voiceCallId).toBeUndefined();
    const grouped = groupChatTranscriptRows(settledInCall);
    expect(grouped.map((row) => row.event.type)).toEqual(["subagent_result_card", "voice_call_group"]);
    expect(grouped[1]!.key).toBe("voice-call:call-sub");

    // 2b. Settled inside the call with no spawn in the window — the appended
    //     card claims the terminal event's call and joins its one card.
    const orphanInCall = collapseChatTranscriptEvents([
      voiceEvent(1, { type: "user_message", text: "anything from that agent?" }, "call-sub"),
      voiceEvent(
        2,
        { type: "subagent_result", taskId: "agent-orphan", status: "completed", summary: "It is a timing assumption." },
        "call-sub",
      ),
      voiceEvent(3, { type: "text", text: "Here is what it found.", itemId: "a-1" }, "call-sub"),
    ]);
    expect(orphanInCall.find((row) => row.event.type === "subagent_result_card")!.voiceCallId).toBe("call-sub");
    const orphanGrouped = groupChatTranscriptRows(orphanInCall);
    expect(orphanGrouped).toHaveLength(1);
    expect(orphanGrouped[0]!.key).toBe("voice-call:call-sub");

    // 3. No call anywhere — the result card comes back untagged and renders inline.
    const plain = collapseChatTranscriptEvents([
      voiceEvent(1, { type: "user_message", text: "look into the flake" }, null),
      voiceEvent(
        2,
        { type: "subagent_started", taskId: "agent-plain", agentType: "Explore", description: "Find the flake" },
        null,
      ),
      voiceEvent(
        3,
        { type: "subagent_result", taskId: "agent-plain", status: "completed", summary: "It is a timing assumption." },
        null,
      ),
    ]);
    expect(plain.find((row) => row.event.type === "subagent_result_card")!.voiceCallId).toBeUndefined();
    expect(groupChatTranscriptRows(plain).some((row) => row.event.type === "voice_call_group")).toBe(false);
  });
});

describe("turn fold (desktop adapter)", () => {
  let clock = 0;
  const at = () => new Date(Date.UTC(2026, 8, 23, 10, 0, clock++)).toISOString();
  const ev = (event: AgentChatEventEnvelope["event"]): AgentChatEventEnvelope => ({
    sessionId: "session-1",
    timestamp: at(),
    event,
  });

  /** The same presentation filter the message list applies before folding. */
  function present(rows: ReturnType<typeof collapseChatTranscriptEventsWithContext>["rows"]) {
    return mergeAdjacentActivityBundleRows(
      groupChatTranscriptRows(rows).filter((row) => row.event.type !== "work_log_group"),
    );
  }

  function fold(events: AgentChatEventEnvelope[], open: ReadonlySet<string> = new Set()) {
    const { rows, context } = collapseChatTranscriptEventsWithContext(events);
    const presented = present(rows);
    const folds = deriveChatTranscriptTurnFolds(presented, readTurnEndSnapshots(context));
    const display = applyChatTranscriptTurnFolds(presented, folds, open);
    return { folds, presented, display, context };
  }

  const types = (rows: ChatTranscriptGroupedEnvelope[]) => rows.map((row) => row.event.type);

  it("reads user message → fold → answer → turn end once the turn is done", () => {
    const events = [
      ev({ type: "user_message", text: "fix it", turnId: "t1" }),
      ev({ type: "reasoning", text: "Looking.", turnId: "t1" }),
      ev({ type: "text", text: "I'll check the tests.", turnId: "t1", itemId: "m1" }),
      ev({ type: "command", command: "npm test", cwd: "/r", output: "", itemId: "c1", turnId: "t1", status: "completed" }),
      ev({ type: "text", text: "Fixed.", turnId: "t1", itemId: "m2" }),
    ];
    // Live: nothing folds.
    expect(fold(events).folds).toEqual([]);

    const { display, presented, folds } = fold([...events, ev({ type: "done", turnId: "t1", status: "completed" })]);
    expect(types(display)).toEqual(["user_message", "turn_fold", "text", "done"]);
    expect(display[1]!.key).toBe("turn-fold:t1");
    // Answer and turn-end rows keep their own envelopes (keys, measured heights).
    expect(display[2]).toBe(presented.find((row) => row.event.type === "text" && row.event.text === "Fixed."));
    expect(folds[0]!.hiddenKeys.size).toBe(2);
  });

  it("shows the whole span in original order under an open fold", () => {
    const events = [
      ev({ type: "user_message", text: "go", turnId: "t1" }),
      ev({ type: "reasoning", text: "Plan.", turnId: "t1" }),
      ev({ type: "error", message: "flaky", turnId: "t1" }),
      ev({ type: "text", text: "Interim.", turnId: "t1", itemId: "m1" }),
      ev({ type: "command", command: "ls", cwd: "/r", output: "", itemId: "c1", turnId: "t1", status: "completed" }),
      ev({ type: "text", text: "Answer.", turnId: "t1", itemId: "m2" }),
      ev({ type: "done", turnId: "t1", status: "completed" }),
    ];
    const closed = fold(events);
    expect(types(closed.display)).toEqual(["user_message", "turn_fold", "error", "text", "done"]);
    const open = fold(events, new Set(["turn-fold:t1"]));
    expect(types(open.display)).toEqual(["user_message", "turn_fold", "reasoning", "error", "text", "text", "done"]);
  });

  it("keeps rows that were live when the turn ended, even after they settle", () => {
    const beforeDone = [
      ev({ type: "user_message", text: "ship", turnId: "t1" }),
      ev({ type: "scheduled_work_update", id: "background:job-live", kind: "background_task", status: "running", title: "npm run dev", sourceTaskId: "job-live", turnId: "t1" }),
      ev({ type: "scheduled_work_update", id: "background:job-done", kind: "background_task", status: "running", title: "npm run build", sourceTaskId: "job-done", turnId: "t1" }),
      ev({ type: "scheduled_work_update", id: "background:job-done", kind: "background_task", status: "completed", title: "npm run build", sourceTaskId: "job-done", turnId: "t1" }),
      ev({ type: "ade_card", cardId: "setup-1", variant: "lane_setup", state: "live", title: "Setting up", fallbackText: "Setting up", turnId: "t1" }),
      ev({ type: "approval_request", itemId: "ask-open", kind: "tool_call", description: "Run it?", turnId: "t1" }),
      ev({ type: "approval_request", itemId: "ask-answered", kind: "tool_call", description: "Read it?", turnId: "t1" }),
      ev({ type: "pending_input_resolved", itemId: "ask-answered", resolution: "accepted", turnId: "t1" }),
      ev({ type: "reasoning", text: "Thinking.", turnId: "t1" }),
      ev({ type: "text", text: "Started the server.", turnId: "t1", itemId: "m1" }),
      ev({ type: "done", turnId: "t1", status: "completed" }),
    ];
    const afterSettle = [
      ...beforeDone,
      ev({ type: "scheduled_work_update", id: "background:job-live", kind: "background_task", status: "completed", title: "npm run dev", sourceTaskId: "job-live", turnId: "t1" }),
      ev({ type: "ade_card", cardId: "setup-1", variant: "lane_setup", state: "terminal", title: "Set up", fallbackText: "Set up", turnId: "t1" }),
      ev({ type: "pending_input_resolved", itemId: "ask-open", resolution: "accepted", turnId: "t1" }),
    ];

    for (const events of [beforeDone, afterSettle]) {
      const { display } = fold(events);
      const visible = display.map((row) => row.key);
      expect(visible).toContain("background-chip:job-live");
      expect(visible).not.toContain("background-chip:job-done");
      expect(display.some((row) => row.event.type === "ade_card" && row.event.cardId === "setup-1")).toBe(true);
      const approvals = display.filter((row) => row.event.type === "approval_request")
        .map((row) => (row.event as { itemId: string }).itemId);
      expect(approvals).toEqual(["ask-open"]);
      expect(display.some((row) => row.event.type === "reasoning")).toBe(false);
    }
  });

  it("keeps subagent results and proof visible, and never folds rows after the answer", () => {
    const { display } = fold([
      ev({ type: "user_message", text: "fan out", turnId: "t1" }),
      ev({ type: "subagent_started", taskId: "chat:child-1", agentId: "child-1", agentType: "claude", description: "Scout", spawnKind: "peer", taskType: "subagent" }),
      ev({ type: "subagent_result", taskId: "chat:child-1", agentId: "child-1", status: "completed", summary: "Found it." }),
      ev({ type: "ade_card", cardId: "proof-1", variant: "proof_artifact", state: "terminal", title: "Screenshot", fallbackText: "Screenshot", turnId: "t1" }),
      ev({ type: "reasoning", text: "Combining.", turnId: "t1" }),
      ev({ type: "text", text: "Here is the result.", turnId: "t1", itemId: "m1" }),
      ev({ type: "reasoning", text: "Late thought.", turnId: "t1" }),
      ev({ type: "done", turnId: "t1", status: "completed" }),
    ]);
    expect(types(display)).toEqual([
      "user_message",
      "turn_fold",
      "subagent_result_card",
      "ade_card",
      "text",
      "reasoning",
      "done",
    ]);
    const foldRow = display[1]!.event;
    if (foldRow.type !== "turn_fold") throw new Error("expected fold row");
    expect(foldRow.subagentCount).toBe(1);
  });

  it("reproduces the live session's folds on a full reload", () => {
    const events = [
      ev({ type: "user_message", text: "go", turnId: "t1" }),
      ev({ type: "scheduled_work_update", id: "background:j", kind: "background_task", status: "running", title: "npm run dev", sourceTaskId: "j", turnId: "t1" }),
      ev({ type: "reasoning", text: "Hmm.", turnId: "t1" }),
      ev({ type: "text", text: "Running.", turnId: "t1", itemId: "m1" }),
      ev({ type: "done", turnId: "t1", status: "completed" }),
      ev({ type: "scheduled_work_update", id: "background:j", kind: "background_task", status: "completed", title: "npm run dev", sourceTaskId: "j", turnId: "t1" }),
      ev({ type: "user_message", text: "again", turnId: "t2" }),
      ev({ type: "reasoning", text: "Again.", turnId: "t2" }),
      ev({ type: "text", text: "Done again.", turnId: "t2", itemId: "m2" }),
      ev({ type: "done", turnId: "t2", status: "interrupted" }),
    ];
    // Live: events arrive one at a time through the incremental collapse.
    let live = collapseChatTranscriptEventsWithContext(events.slice(0, 1));
    for (let count = 2; count <= events.length; count += 1) {
      live = collapseChatTranscriptEventsIncrementalWithContext(
        events.slice(0, count),
        events.slice(0, count - 1),
        live.rows,
        live.context,
      );
    }
    const reload = collapseChatTranscriptEventsWithContext(events);
    const summarize = (result: typeof live) => deriveChatTranscriptTurnFolds(
      present(result.rows),
      readTurnEndSnapshots(result.context),
    ).map((entry) => ({ ...entry, hiddenKeys: [...entry.hiddenKeys] }));
    expect(summarize(live)).toEqual(summarize(reload));
    expect(summarize(reload).map((entry) => [entry.turnId, entry.status, entry.keptKeys])).toEqual([
      ["t1", "completed", ["background-chip:j"]],
      ["t2", "interrupted", []],
    ]);
  });

  it("sameTurnFolds keeps the fold list identity across a streaming delta elsewhere", () => {
    const events = [
      ev({ type: "user_message", text: "go", turnId: "t1" }),
      ev({ type: "reasoning", text: "Hmm.", turnId: "t1" }),
      ev({ type: "text", text: "Answer.", turnId: "t1", itemId: "m1" }),
      ev({ type: "done", turnId: "t1", status: "completed" }),
      ev({ type: "user_message", text: "next", turnId: "t2" }),
      ev({ type: "text", text: "Stream", turnId: "t2", itemId: "m2" }),
    ];
    const before = fold(events).folds;
    const after = fold([...events, ev({ type: "text", text: "ing", turnId: "t2", itemId: "m2" })]).folds;
    expect(after).not.toBe(before);
    expect(sameTurnFolds(before, after)).toBe(true);
    const opened = fold([...events, ev({ type: "reasoning", text: "Late.", turnId: "t2" }), ev({ type: "text", text: "Two.", turnId: "t2", itemId: "m3" }), ev({ type: "done", turnId: "t2", status: "completed" })]).folds;
    expect(sameTurnFolds(before, opened)).toBe(false);
  });

  it("reuses an unchanged fold row envelope", () => {
    const events = [
      ev({ type: "user_message", text: "go", turnId: "t1" }),
      ev({ type: "reasoning", text: "Hmm.", turnId: "t1" }),
      ev({ type: "text", text: "Answer.", turnId: "t1", itemId: "m1" }),
      ev({ type: "done", turnId: "t1", status: "completed" }),
    ];
    const { presented, folds, display } = fold(events);
    const previous = new Map(display.filter((row) => row.event.type === "turn_fold").map((row) => [row.key, row]));
    const again = applyChatTranscriptTurnFolds(presented, folds, new Set(), previous);
    expect(again[1]).toBe(display[1]);
  });

  describe("turn details and warnings (Codex config-warning turn)", () => {
    // The owner's screenshot: the Codex config warning and the MCP-startup
    // diagnostics arrive before the turn has an id, the turn's own diagnostics
    // arrive with it, then the answer.
    const codexTurn = () => [
      ev({ type: "user_message", text: "how many days till christmas", turnId: "t1" }),
      ev({ type: "system_notice", noticeKind: "warning", message: "⚠ Codex is ignoring 1 unrecognized configuration setting." }),
      ev({ type: "turn_diagnostics", optionalIntegrationFailures: [{ integration: "unityMCP", message: "not configured" }] }),
      ev({ type: "command", command: "date", cwd: "/r", output: "", itemId: "c1", turnId: "t1", status: "completed" }),
      ev({ type: "turn_diagnostics", turnId: "t1", moderationChecks: 1, optionalIntegrationFailures: [{ integration: "unityMCP" }, { integration: "figma", message: "offline" }] }),
      ev({ type: "turn_recovery", provider: "codex", turnId: "t1", action: "nudge", state: "recovered", message: "The provider resumed.", automatic: true, at: at(), recoveryCount: 1 }),
      ev({ type: "turn_diagnostics", turnId: "t1", moderationChecks: 2, optionalIntegrationFailures: [{ integration: "unityMCP" }, { integration: "figma", message: "offline" }] }),
      ev({ type: "text", text: "93 days.", turnId: "t1", itemId: "m1" }),
      ev({ type: "done", turnId: "t1", status: "completed" }),
    ];

    it("merges every diagnostics snapshot and the recovery receipt of a turn into ONE turn_details row", () => {
      const events = codexTurn();
      const { presented } = fold(events);
      const details = presented.filter((row) => row.event.type === "turn_details");
      expect(details).toHaveLength(1);
      const event = details[0]!.event;
      if (event.type !== "turn_details") throw new Error("expected turn details");
      // The id-less startup snapshot opened the row; the turn's own snapshots joined it.
      expect(event.turnId).toBe("t1");
      expect(event.recovery).toMatchObject({ type: "turn_recovery", state: "recovered" });
      expect(summarizeTurnDetails(event)).toEqual({
        moderationChecks: 2,
        integrations: [
          { integration: "unityMCP", message: "not configured" },
          { integration: "figma", message: "offline" },
        ],
      });

      // Live (one event at a time) and reload agree on the row, its key, and its place.
      let live = collapseChatTranscriptEventsWithContext(events.slice(0, 1));
      for (let count = 2; count <= events.length; count += 1) {
        live = collapseChatTranscriptEventsIncrementalWithContext(events.slice(0, count), events.slice(0, count - 1), live.rows, live.context);
      }
      const reload = collapseChatTranscriptEventsWithContext(events);
      expect(live.rows.map((row) => [row.key, row.event.type])).toEqual(reload.rows.map((row) => [row.key, row.event.type]));
      expect(live.rows.find((row) => row.event.type === "turn_details")).toEqual(
        reload.rows.find((row) => row.event.type === "turn_details"),
      );
      // Contextless collapse lands on the same single row.
      expect(collapseChatTranscriptEvents(events).filter((row) => row.event.type === "turn_details")).toHaveLength(1);
    });

    it("starts a new turn_details row for the next turn, even for an id-less snapshot", () => {
      const events = [
        ...codexTurn(),
        ev({ type: "user_message", text: "and easter?", turnId: "t2" }),
        ev({ type: "turn_diagnostics", optionalIntegrationFailures: [{ integration: "linear" }] }),
        ev({ type: "text", text: "Soon.", turnId: "t2", itemId: "m2" }),
        ev({ type: "done", turnId: "t2", status: "completed" }),
      ];
      const details = collapseChatTranscriptEventsWithContext(events).rows.filter((row) => row.event.type === "turn_details");
      expect(details).toHaveLength(2);
      expect(new Set(details.map((row) => row.key)).size).toBe(2);
      const second = details[1]!.event;
      if (second.type !== "turn_details") throw new Error("expected turn details");
      expect(summarizeTurnDetails(second).integrations.map((entry) => entry.integration)).toEqual(["linear"]);
    });

    it("folds the warning and the turn details; open, they read in their original order", () => {
      const events = codexTurn();
      expect(types(fold(events).display)).toEqual(["user_message", "turn_fold", "text", "done"]);
      const open = fold(events, new Set(["turn-fold:t1"]));
      expect(types(open.display)).toEqual(["user_message", "turn_fold", "system_notice", "turn_details", "text", "done"]);
    });

    it("keeps a warning that arrives after the answer visible", () => {
      const events = codexTurn();
      events.splice(events.length - 1, 0, ev({ type: "system_notice", noticeKind: "warning", message: "Late warning.", turnId: "t1" }));
      expect(types(fold(events).display)).toEqual(["user_message", "turn_fold", "text", "system_notice", "done"]);
    });

    it("keeps an actionable row visible while folded, and in chronological place when open", () => {
      const events = [
        ev({ type: "user_message", text: "go", turnId: "t1" }),
        ev({ type: "reasoning", text: "Plan.", turnId: "t1" }),
        ev({ type: "system_notice", noticeKind: "warning", message: "⚠ heads up", turnId: "t1" }),
        ev({ type: "error", message: "flaky", turnId: "t1" }),
        ev({ type: "turn_diagnostics", turnId: "t1", moderationChecks: 1 }),
        ev({ type: "text", text: "Answer.", turnId: "t1", itemId: "m1" }),
        ev({ type: "done", turnId: "t1", status: "completed" }),
      ];
      expect(types(fold(events).display)).toEqual(["user_message", "turn_fold", "error", "text", "done"]);
      // Open: the kept error sits between the rows around it, not right under the fold row.
      expect(types(fold(events, new Set(["turn-fold:t1"])).display)).toEqual([
        "user_message", "turn_fold", "reasoning", "system_notice", "error", "turn_details", "text", "done",
      ]);
    });
  });

  describe("cancellation terminus keys off the parent turn", () => {
    const P = "parent-turn";
    const opening = () => [
      ev({ type: "user_message", text: "fan out", turnId: P }),
      ev({ type: "subagent_started", taskId: "task-1", agentId: "sub-1", agentType: "Explore", description: "Scout", turnId: P }),
      ev({ type: "scheduled_work_update", id: "background:job", kind: "background_task", status: "running", title: "npm run dev", sourceTaskId: "job", turnId: P }),
      ev({ type: "reasoning", text: "Planning.", turnId: P }),
      ev({ type: "text", text: "Starting the scout.", turnId: P, itemId: "m1" }),
      ev({ type: "text", text: "Partial answer.", turnId: P, itemId: "m2" }),
    ];
    const heavy = { inputTokens: 9_000, outputTokens: 4_000 };
    const light = { inputTokens: 100, outputTokens: 50 };
    const doneRows = (display: ChatTranscriptGroupedEnvelope[]) => display.filter((row) => row.event.type === "done");

    it("interrupt while subagents run: a heavier subagent done arriving first does not take the row", () => {
      const { display, folds } = fold([
        ...opening(),
        ev({ type: "done", turnId: "sub-turn-1", status: "interrupted", usage: heavy }),
        ev({ type: "status", turnStatus: "interrupted", turnId: P }),
        ev({ type: "done", turnId: P, status: "interrupted", usage: light }),
      ]);
      const [terminus] = doneRows(display);
      expect(terminus!.event).toMatchObject({ type: "done", turnId: P, status: "interrupted", subagentStoppedCount: 1 });
      expect(folds.map((entry) => [entry.turnId, entry.status, entry.turnEndKey])).toEqual([[P, "interrupted", terminus!.key]]);
      // The subagent's done did not cut the turn-end snapshot short: the job
      // that was still running when the parent stopped stays visible.
      expect(folds[0]!.keptKeys).toContain("background-chip:job");
      expect(types(display)).toEqual(["user_message", "turn_fold", "subagent_spawn_anchor", "background_job_line", "text", "done"]);
    });

    it("interrupt after subagents finished: the subagent's own done folds as history", () => {
      const events = [
        ev({ type: "user_message", text: "fan out", turnId: P }),
        ev({ type: "subagent_started", taskId: "task-1", agentId: "sub-1", agentType: "Explore", description: "Scout", turnId: P }),
        ev({ type: "subagent_result", taskId: "task-1", agentId: "sub-1", status: "completed", summary: "Found it.", turnId: P }),
        ev({ type: "done", turnId: "sub-turn-1", status: "completed", usage: heavy }),
        ev({ type: "reasoning", text: "Combining.", turnId: P }),
        ev({ type: "text", text: "Here is what it found.", turnId: P, itemId: "m1" }),
        ev({ type: "status", turnStatus: "interrupted", turnId: P }),
        ev({ type: "done", turnId: P, status: "interrupted" }),
      ];
      const { display, folds, presented } = fold(events);
      const subDone = presented.find((row) => row.event.type === "done" && row.event.turnId === "sub-turn-1");
      expect(folds.map((entry) => entry.turnId)).toEqual([P]);
      expect(folds[0]!.hiddenKeys.has(subDone!.key)).toBe(true);
      expect(doneRows(display).map((row) => (row.event as { turnId: string }).turnId)).toEqual([P]);
      expect(display.some((row) => row.event.type === "subagent_result_card")).toBe(true);
    });

    it("usage-limit stop: the merged row keeps the parent's id and its 429 terminal reason", () => {
      const { display, folds } = fold([
        ...opening(),
        ev({ type: "status", turnStatus: "failed", turnId: P }),
        ev({ type: "done", turnId: "sub-turn-1", status: "failed", usage: heavy }),
        ev({ type: "done", turnId: P, status: "failed", usage: light, terminalReason: "api_error", apiErrorStatus: 429 }),
      ]);
      const [terminus] = doneRows(display);
      expect(terminus!.event).toMatchObject({ turnId: P, status: "failed", terminalReason: "api_error", apiErrorStatus: 429 });
      expect(terminus!.event).toMatchObject({ usage: { inputTokens: 9_100, outputTokens: 4_050 } });
      expect(folds.map((entry) => [entry.turnId, entry.status])).toEqual([[P, "failed"]]);
    });

    it("failed turn: folds with a failed status and keeps the error visible", () => {
      const { display, folds } = fold([
        ...opening(),
        ev({ type: "error", message: "Provider exploded", turnId: P }),
        ev({ type: "status", turnStatus: "failed", turnId: P }),
        ev({ type: "done", turnId: P, status: "failed" }),
      ]);
      expect(folds.map((entry) => [entry.turnId, entry.status])).toEqual([[P, "failed"]]);
      expect(display.some((row) => row.event.type === "error")).toBe(true);
    });

    it("multiple consecutive interrupted status rows merge into one parent turn end", () => {
      const { display, folds } = fold([
        ...opening(),
        ev({ type: "status", turnStatus: "interrupted", turnId: P }),
        ev({ type: "status", turnStatus: "interrupted", turnId: P }),
        ev({ type: "done", turnId: "sub-turn-1", status: "interrupted", usage: heavy }),
        ev({ type: "status", turnStatus: "interrupted", turnId: "sub-turn-2" }),
        ev({ type: "done", turnId: "sub-turn-2", status: "interrupted", usage: heavy }),
        ev({ type: "done", turnId: P, status: "interrupted" }),
      ]);
      const terminus = doneRows(display);
      expect(terminus).toHaveLength(1);
      expect(terminus[0]!.event).toMatchObject({ turnId: P, subagentStoppedCount: 2 });
      expect(display.some((row) => row.event.type === "status")).toBe(false);
      expect(folds.map((entry) => entry.turnId)).toEqual([P]);
    });

    it("subagent done arriving after the parent's done", () => {
      const merged = fold([
        ...opening(),
        ev({ type: "status", turnStatus: "interrupted", turnId: P }),
        ev({ type: "done", turnId: P, status: "interrupted", usage: light }),
        ev({ type: "done", turnId: "sub-turn-1", status: "interrupted", usage: heavy }),
      ]);
      expect(doneRows(merged.display).map((row) => (row.event as { turnId: string }).turnId)).toEqual([P]);
      expect(merged.folds.map((entry) => entry.turnId)).toEqual([P]);
      expect(merged.folds[0]!.keptKeys).toContain("background-chip:job");

      // A completed subagent done after the parent's is not merged; it sits
      // after the answer, where nothing folds.
      const separate = fold([
        ...opening(),
        ev({ type: "done", turnId: P, status: "completed" }),
        ev({ type: "done", turnId: "sub-turn-1", status: "completed", usage: heavy }),
      ]);
      expect(separate.folds.map((entry) => entry.turnId)).toEqual([P]);
      expect(doneRows(separate.display).map((row) => (row.event as { turnId: string }).turnId)).toEqual([P, "sub-turn-1"]);
    });

    it("parent done missing its turn id: the merged row and the fold take the turn's id", () => {
      const { display, folds } = fold([
        ...opening(),
        ev({ type: "done", turnId: "sub-turn-1", status: "interrupted", usage: heavy }),
        ev({ type: "status", turnStatus: "interrupted" }),
        ev({ type: "done", turnId: "", status: "interrupted", usage: light }),
      ]);
      const [terminus] = doneRows(display);
      expect(terminus!.event).toMatchObject({ turnId: P, subagentStoppedCount: 1 });
      expect(folds.map((entry) => [entry.foldId, entry.turnEndKey])).toEqual([[`turn-fold:${P}`, terminus!.key]]);
      // The turn-end snapshot was filed under the inferred id too.
      expect(folds[0]!.keptKeys).toContain("background-chip:job");
    });

    it("an id-less done that is not merged still folds its turn", () => {
      const { folds, context } = fold([
        ...opening(),
        ev({ type: "done", turnId: "", status: "completed" }),
      ]);
      expect(folds.map((entry) => entry.turnId)).toEqual([P]);
      expect(readTurnEndSnapshots(context).has(P)).toBe(true);
      expect(folds[0]!.keptKeys).toContain("background-chip:job");
    });

    it("live collapse and reload agree whatever order the done events arrive in", () => {
      const events = [
        ...opening(),
        ev({ type: "done", turnId: "sub-turn-1", status: "interrupted", usage: heavy }),
        ev({ type: "status", turnStatus: "interrupted", turnId: P }),
        ev({ type: "done", turnId: P, status: "interrupted" }),
      ];
      let live = collapseChatTranscriptEventsWithContext(events.slice(0, 1));
      for (let count = 2; count <= events.length; count += 1) {
        live = collapseChatTranscriptEventsIncrementalWithContext(
          events.slice(0, count),
          events.slice(0, count - 1),
          live.rows,
          live.context,
        );
      }
      const reload = collapseChatTranscriptEventsWithContext(events);
      const summarize = (result: typeof live) => deriveChatTranscriptTurnFolds(
        present(result.rows),
        readTurnEndSnapshots(result.context),
      ).map((entry) => ({ ...entry, hiddenKeys: [...entry.hiddenKeys] }));
      expect(summarize(live)).toEqual(summarize(reload));
      expect(summarize(reload)).toHaveLength(1);
    });
  });

  describe("text phase", () => {
    it("keeps Codex commentary and final answer apart when they share a message id", () => {
      const { rows } = collapseChatTranscriptEventsWithContext([
        ev({ type: "user_message", text: "go", turnId: "t1" }),
        ev({ type: "text", text: "Looking around. ", turnId: "t1", messageId: "msg-1", phase: "commentary" }),
        ev({ type: "reasoning", text: "Thinking.", turnId: "t1" }),
        ev({ type: "text", text: "All ", turnId: "t1", messageId: "msg-1", phase: "final_answer" }),
        ev({ type: "text", text: "set.", turnId: "t1", messageId: "msg-1", phase: "final_answer" }),
      ]);
      const texts = rows.filter((row) => row.event.type === "text")
        .map((row) => [(row.event as { text: string }).text, (row.event as { phase?: string }).phase]);
      expect(texts).toEqual([["Looking around. ", "commentary"], ["All set.", "final_answer"]]);
    });

    it("picks the final answer even when commentary comes after it", () => {
      const { display } = fold([
        ev({ type: "user_message", text: "go", turnId: "t1" }),
        ev({ type: "reasoning", text: "Thinking.", turnId: "t1" }),
        ev({ type: "text", text: "The answer.", turnId: "t1", messageId: "a", phase: "final_answer" }),
        ev({ type: "command", command: "ls", cwd: "/r", output: "", itemId: "c1", turnId: "t1", status: "completed" }),
        ev({ type: "text", text: "One more note.", turnId: "t1", messageId: "b", phase: "commentary" }),
        ev({ type: "done", turnId: "t1", status: "completed" }),
      ]);
      expect(display.map((row) => row.event.type === "text" ? (row.event as { text: string }).text : row.event.type))
        .toEqual(["user_message", "turn_fold", "The answer.", "One more note.", "done"]);
    });

    it("merges unlabelled text exactly as before and adopts a later fragment's label", () => {
      const { rows } = collapseChatTranscriptEventsWithContext([
        ev({ type: "text", text: "Hello ", turnId: "t1", messageId: "m" }),
        ev({ type: "text", text: "world.", turnId: "t1", messageId: "m" }),
        ev({ type: "text", text: "Late ", turnId: "t1", messageId: "n" }),
        ev({ type: "text", text: "label.", turnId: "t1", messageId: "n", phase: "final_answer" }),
      ]);
      expect(rows.map((row) => [(row.event as { text: string }).text, (row.event as { phase?: string }).phase]))
        .toEqual([["Hello world.", undefined], ["Late label.", "final_answer"]]);
    });
  });
});

describe("row keys are position-independent", () => {
  const SESSION = "keys-session";
  let second = 0;
  const stamp = () => new Date(Date.UTC(2026, 8, 23, 9, 0, 0, 0) + (second++) * 1000).toISOString();
  const ev = (event: AgentChatEventEnvelope["event"], timestamp = stamp()): AgentChatEventEnvelope => ({
    sessionId: SESSION,
    timestamp,
    event,
  });

  /** One finished turn with every identity shape: message ids, item ids, logical ids, and none. */
  function turn(n: number): AgentChatEventEnvelope[] {
    const turnId = `turn-${n}`;
    const sameMs = stamp();
    return [
      ev({ type: "user_message", text: `question ${n}`, turnId }),
      ev({ type: "reasoning", text: `thinking ${n}`, turnId }),
      ev({ type: "text", text: `interim ${n}`, turnId, messageId: `m-${n}-a`, phase: "commentary" }),
      ev({ type: "tool_call", tool: "Read", args: { path: `f${n}` }, itemId: `tool-${n}`, logicalItemId: `logical-${n}`, turnId }),
      ev({ type: "tool_result", tool: "Read", result: "ok", itemId: `tool-${n}`, logicalItemId: `logical-${n}`, turnId, status: "completed" }),
      ev({ type: "command", command: `npm test ${n}`, cwd: "/r", output: "", itemId: `cmd-${n}`, turnId, status: "completed" }),
      // Two id-less events in the same millisecond: the ordinal separates them.
      ev({ type: "system_notice", noticeKind: "info", message: `notice ${n} a`, turnId }, sameMs),
      ev({ type: "system_notice", noticeKind: "info", message: `notice ${n} b`, turnId }, sameMs),
      ev({ type: "text", text: `answer ${n} `, turnId, messageId: `m-${n}-b`, phase: "final_answer" }),
      ev({ type: "text", text: "continued", turnId, messageId: `m-${n}-b`, phase: "final_answer" }),
      ev({ type: "text", text: `no-id note ${n}` }),
      ev({ type: "done", turnId, status: "completed" }),
    ];
  }

  function present(rows: ReturnType<typeof collapseChatTranscriptEventsWithContext>["rows"]) {
    return mergeAdjacentActivityBundleRows(
      groupChatTranscriptRows(rows).filter((row) => row.event.type !== "work_log_group"),
    );
  }

  /** Every key a surface can hold: collapsed, grouped, and folded (closed and open). */
  function keysOf(events: AgentChatEventEnvelope[]) {
    const { rows, context } = collapseChatTranscriptEventsWithContext(events);
    const presented = present(rows);
    const folds = deriveChatTranscriptTurnFolds(presented, readTurnEndSnapshots(context));
    const closed = applyChatTranscriptTurnFolds(presented, folds, new Set());
    const open = applyChatTranscriptTurnFolds(presented, folds, new Set(folds.map((fold) => fold.foldId)));
    return {
      rows: rows.map((row) => row.key),
      grouped: groupChatTranscriptRows(rows).map((row) => row.key),
      closed: closed.map((row) => row.key),
      open: open.map((row) => row.key),
      folds,
      snapshots: readTurnEndSnapshots(context),
    };
  }

  function expectUnique(keys: readonly string[]) {
    expect(new Set(keys).size).toBe(keys.length);
  }

  function expectContainsAll(superset: readonly string[], subset: readonly string[]) {
    const all = new Set(superset);
    expect(subset.filter((key) => !all.has(key))).toEqual([]);
  }

  const older = [...turn(1), ...turn(2), ...turn(3)];
  const tail = [...turn(4), ...turn(5)];

  it("keeps every tail key when an older page is prepended", () => {
    const before = keysOf(tail);
    const after = keysOf([...older, ...tail]);
    for (const surface of ["rows", "grouped", "closed", "open"] as const) {
      expectUnique(before[surface]);
      expectUnique(after[surface]);
      expectContainsAll(after[surface], before[surface]);
    }
    // The fold's own bookkeeping carries row keys too; it is unchanged by the prepend.
    for (const fold of before.folds) {
      const same = after.folds.find((candidate) => candidate.foldId === fold.foldId);
      expect(same?.turnEndKey).toBe(fold.turnEndKey);
      expect(same?.answerKey).toBe(fold.answerKey);
      expect([...(same?.hiddenKeys ?? [])]).toEqual([...fold.hiddenKeys]);
      expect(same?.keptKeys).toEqual(fold.keptKeys);
    }
    for (const [turnId, snapshot] of before.snapshots) {
      expect([...(after.snapshots.get(turnId)?.liveRowKeys ?? [])]).toEqual([...snapshot.liveRowKeys]);
    }
  });

  it("keeps every surviving key when the front is trimmed to the last N events", () => {
    const all = [...older, ...tail];
    const full = keysOf(all);
    // Trim at a turn boundary, as the background-chat window keeps whole events.
    const trimmed = keysOf(all.slice(turn(0).length * 2));
    for (const surface of ["rows", "grouped", "closed", "open"] as const) {
      expectUnique(trimmed[surface]);
      expectContainsAll(full[surface], trimmed[surface]);
    }
  });

  it("adds only the inserted row's key for a late mid-list insert", () => {
    const all = [...older, ...tail];
    const before = keysOf(all).rows;
    const late = ev({ type: "error", message: "late failure", turnId: "turn-2" }, "2026-09-23T09:00:20.500Z");
    const insertAt = turn(0).length + 5;
    const after = keysOf([...all.slice(0, insertAt), late, ...all.slice(insertAt)]).rows;
    expectUnique(after);
    expect(after.filter((key) => !before.includes(key))).toEqual([`${SESSION}:error@2026-09-23T09:00:20.500Z`]);
    expectContainsAll(after, before);
  });

  it("builds the same keys incrementally as a full recollapse", () => {
    const all = [...older, ...tail];
    let previousEvents: AgentChatEventEnvelope[] = [];
    let previous = collapseChatTranscriptEventsWithContext([]);
    for (let end = 1; end <= all.length; end += 1) {
      const events = all.slice(0, end);
      previous = collapseChatTranscriptEventsIncrementalWithContext(
        events,
        previousEvents,
        previous.rows,
        previousEvents.length ? previous.context : null,
      );
      previousEvents = events;
    }
    const full = collapseChatTranscriptEventsWithContext(all);
    expect(previous.rows.map((row) => row.key)).toEqual(full.rows.map((row) => row.key));
    expectUnique(full.rows.map((row) => row.key));
  });

  it("names rows by identity rather than position", () => {
    const keys = buildTranscriptEventRowKeys(turn(9));
    expect(keys[0]).toMatch(/^keys-session:user_message@/);
    expect(keys[2]).toBe("keys-session:text:m:m-9-a:commentary");
    expect(keys[3]).toBe("keys-session:tool_call:i:turn-9:logical-9");
    expect(keys[5]).toBe("keys-session:command:i:turn-9:cmd-9");
    expect(keys[7]).toBe(`${keys[6]}#1`);
    expect(keys[9]).toBe("keys-session:text:m:m-9-b:final_answer#1");
    // The collapse assigns exactly these keys to the rows the events open.
    const events = turn(10);
    const rowKeys = collapseChatTranscriptEvents(events).map((row) => row.key);
    expectContainsAll(buildTranscriptEventRowKeys(events), rowKeys);
  });
});
