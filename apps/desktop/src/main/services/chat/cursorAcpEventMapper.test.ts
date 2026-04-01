import { describe, expect, it } from "vitest";
import { mapAcpSessionNotificationToChatEvents } from "./cursorAcpEventMapper";

describe("mapAcpSessionNotificationToChatEvents", () => {
  it("suppresses duplicate current mode notices when ACP repeats the same mode", () => {
    const events = mapAcpSessionNotificationToChatEvents({
      sessionId: "cursor-session-1",
      update: {
        sessionUpdate: "current_mode_update",
        currentModeId: "plan",
      },
    } as any, {
      turnId: "turn-1",
      previousModeId: "plan",
    });

    expect(events).toEqual([]);
  });

  it("emits a notice when the current mode actually changes", () => {
    const events = mapAcpSessionNotificationToChatEvents({
      sessionId: "cursor-session-1",
      update: {
        sessionUpdate: "current_mode_update",
        currentModeId: "ask",
      },
    } as any, {
      turnId: "turn-1",
      previousModeId: "plan",
    });

    expect(events).toEqual([
      {
        type: "system_notice",
        noticeKind: "info",
        message: "Agent mode: ask",
        turnId: "turn-1",
      },
    ]);
  });

  it("emits a memory notice for completed memory_add MCP results", () => {
    const events = mapAcpSessionNotificationToChatEvents({
      sessionId: "cursor-session-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        title: "mcp__ade__memory_add",
        kind: "other",
        status: "completed",
        rawOutput: {
          saved: true,
          durability: "candidate",
          deduped: true,
          mergedIntoId: "memory-42",
          reason: "duplicate memory merged",
        },
      },
    } as any, {
      turnId: "turn-1",
    });

    expect(events).toContainEqual({
      type: "system_notice",
      noticeKind: "memory",
      message: "Saved to memory as candidate, not promoted",
      detail: "Durability: candidate\nMerged with existing memory.\nMerged into: memory-42\nReason: duplicate memory merged",
      turnId: "turn-1",
    });
  });

  it("emits a memory notice for rejected memory_add MCP results", () => {
    const events = mapAcpSessionNotificationToChatEvents({
      sessionId: "cursor-session-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        title: "mcp__ade__memory_add",
        kind: "other",
        status: "completed",
        rawOutput: {
          saved: false,
          reason: "memory write rejected",
        },
      },
    } as any, {
      turnId: "turn-1",
    });

    expect(events).toContainEqual({
      type: "system_notice",
      noticeKind: "memory",
      message: "Skipped memory write: memory write rejected",
      turnId: "turn-1",
    });
  });

  it("emits a memory notice for memory_pin MCP results", () => {
    const events = mapAcpSessionNotificationToChatEvents({
      sessionId: "cursor-session-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        title: "mcp__ade__memory_pin",
        kind: "other",
        status: "completed",
        rawOutput: {
          id: "memory-7",
          pinned: true,
        },
      },
    } as any, {
      turnId: "turn-1",
    });

    expect(events).toContainEqual({
      type: "system_notice",
      noticeKind: "memory",
      message: "Pinned memory entry: memory-7",
      turnId: "turn-1",
    });
  });

  it("maps initial tool_call notifications so MCP tools keep their names", () => {
    const events = mapAcpSessionNotificationToChatEvents({
      sessionId: "cursor-session-1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "mcp__ade__memory_search",
        kind: "other",
        rawInput: {
          query: "git stash",
        },
      },
    } as any, {
      turnId: "turn-1",
    });

    expect(events).toEqual([
      {
        type: "tool_call",
        tool: "mcp__ade__memory_search",
        args: {
          query: "git stash",
          title: "mcp__ade__memory_search",
          kind: "other",
        },
        itemId: "tool-1",
        turnId: "turn-1",
      },
    ]);
  });

  it("maps rich ACP plans into plan events", () => {
    const events = mapAcpSessionNotificationToChatEvents({
      sessionId: "cursor-session-1",
      update: {
        sessionUpdate: "plan",
        entries: [
          { content: "Inspect the stash source", status: "completed", priority: "high" },
          { content: "Trace the Git UI label", status: "in_progress", priority: "high" },
        ],
      },
    } as any, {
      turnId: "turn-1",
    });

    expect(events).toEqual([
      {
        type: "plan",
        steps: [
          { text: "Inspect the stash source", status: "completed" },
          { text: "Trace the Git UI label", status: "in_progress" },
        ],
        turnId: "turn-1",
      },
    ]);
  });

  it("suppresses trivial single-step ACP plans", () => {
    const events = mapAcpSessionNotificationToChatEvents({
      sessionId: "cursor-session-1",
      update: {
        sessionUpdate: "plan",
        entries: [
          { content: "Git stash WIP label", status: "pending", priority: "medium" },
        ],
      },
    } as any, {
      turnId: "turn-1",
    });

    expect(events).toEqual([]);
  });
});
