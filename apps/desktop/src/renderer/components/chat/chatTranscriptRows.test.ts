/* @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import type { AgentChatEventEnvelope } from "../../../shared/types";
import {
  collapseChatTranscriptEvents,
  groupConsecutiveWorkLogRows,
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
});
