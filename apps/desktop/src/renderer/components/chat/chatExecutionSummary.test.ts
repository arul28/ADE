import { describe, expect, it } from "vitest";
import type { AgentChatEventEnvelope } from "../../../shared/types";
import { deriveChatSubagentSnapshots, deriveTodoItems } from "./chatExecutionSummary";

describe("deriveChatSubagentSnapshots", () => {
  it("keeps running subagents ahead of completed ones and preserves descriptions", () => {
    const events: AgentChatEventEnvelope[] = [
      {
        sessionId: "session-1",
        timestamp: "2026-03-10T12:00:00.000Z",
        event: {
          type: "subagent_started",
          taskId: "task-complete",
          description: "Inspect resolver state",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-10T12:00:03.000Z",
        event: {
          type: "subagent_result",
          taskId: "task-complete",
          status: "completed",
          summary: "Found the adapter path",
          usage: {
            totalTokens: 1200,
            durationMs: 3200,
          },
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-10T12:00:04.000Z",
        event: {
          type: "subagent_started",
          taskId: "task-running",
          description: "Check mission transcript path",
        },
      },
    ];

    expect(deriveChatSubagentSnapshots(events)).toEqual([
      expect.objectContaining({
        taskId: "task-running",
        description: "Check mission transcript path",
        status: "running",
      }),
      expect.objectContaining({
        taskId: "task-complete",
        description: "Inspect resolver state",
        status: "completed",
        summary: "Found the adapter path",
        usage: expect.objectContaining({ totalTokens: 1200, durationMs: 3200 }),
      }),
    ]);
  });

  it("reuses prior description and summary when result payload is sparse", () => {
    const events: AgentChatEventEnvelope[] = [
      {
        sessionId: "session-1",
        timestamp: "2026-03-10T12:00:00.000Z",
        event: {
          type: "subagent_started",
          taskId: "task-1",
          description: "Research app-server capabilities",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-10T12:00:02.000Z",
        event: {
          type: "subagent_result",
          taskId: "task-1",
          status: "failed",
          summary: "Timed out on schema read",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-10T12:00:03.000Z",
        event: {
          type: "subagent_result",
          taskId: "task-1",
          status: "failed",
          summary: " ",
        },
      },
    ];

    expect(deriveChatSubagentSnapshots(events)).toEqual([
      expect.objectContaining({
        taskId: "task-1",
        description: "Research app-server capabilities",
        status: "failed",
        summary: "Timed out on schema read",
      }),
    ]);
  });

  it("updates running snapshots from progress events before the final result arrives", () => {
    const events: AgentChatEventEnvelope[] = [
      {
        sessionId: "session-1",
        timestamp: "2026-03-10T12:00:00.000Z",
        event: {
          type: "subagent_started",
          taskId: "task-1",
          description: "Inspect desktop IPC path",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-10T12:00:02.000Z",
        event: {
          type: "subagent_progress",
          taskId: "task-1",
          summary: "Traced the send handler and found the blocking await.",
          usage: {
            totalTokens: 800,
            toolUses: 2,
          },
          lastToolName: "functions.exec_command",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-10T12:00:04.000Z",
        event: {
          type: "subagent_result",
          taskId: "task-1",
          status: "completed",
          summary: "Switched the IPC path to dispatch immediately.",
        },
      },
    ];

    expect(deriveChatSubagentSnapshots(events)).toEqual([
      expect.objectContaining({
        taskId: "task-1",
        description: "Inspect desktop IPC path",
        status: "completed",
        summary: "Switched the IPC path to dispatch immediately.",
        lastToolName: "functions.exec_command",
        usage: expect.objectContaining({ totalTokens: 800, toolUses: 2 }),
      }),
    ]);
  });
});

describe("deriveTodoItems", () => {
  it("returns an empty array when there are no events", () => {
    expect(deriveTodoItems([])).toEqual([]);
  });

  it("returns an empty array when no todo_update events are present", () => {
    const events: AgentChatEventEnvelope[] = [
      {
        sessionId: "session-1",
        timestamp: "2026-03-10T12:00:00.000Z",
        event: { type: "text", text: "hello" },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-10T12:00:01.000Z",
        event: {
          type: "subagent_started",
          taskId: "task-1",
          description: "unrelated",
        },
      },
    ];

    expect(deriveTodoItems(events)).toEqual([]);
  });

  it("projects a single todo_update to {id, description, status} without leaking extra fields", () => {
    const events: AgentChatEventEnvelope[] = [
      {
        sessionId: "session-1",
        timestamp: "2026-03-10T12:00:00.000Z",
        event: {
          type: "todo_update",
          turnId: "turn-1",
          items: [
            {
              id: "todo-1",
              description: "Investigate flaky test",
              status: "in_progress",
              // extra field that must NOT leak through
              ...({ priority: "high" } as unknown as Record<string, never>),
            },
            {
              id: "todo-2",
              description: "Write fix",
              status: "pending",
            },
          ],
        },
      },
    ];

    const result = deriveTodoItems(events);

    expect(result).toEqual([
      { id: "todo-1", description: "Investigate flaky test", status: "in_progress" },
      { id: "todo-2", description: "Write fix", status: "pending" },
    ]);
    for (const item of result) {
      expect(Object.keys(item).sort()).toEqual(["description", "id", "status"]);
    }
  });

  it("returns only the last todo_update when multiple are present (each update fully replaces)", () => {
    const events: AgentChatEventEnvelope[] = [
      {
        sessionId: "session-1",
        timestamp: "2026-03-10T12:00:00.000Z",
        event: {
          type: "todo_update",
          items: [
            { id: "old-1", description: "Old item 1", status: "pending" },
            { id: "old-2", description: "Old item 2", status: "in_progress" },
            { id: "old-3", description: "Old item 3", status: "completed" },
          ],
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-10T12:00:01.000Z",
        event: { type: "text", text: "thinking..." },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-10T12:00:02.000Z",
        event: {
          type: "todo_update",
          items: [
            { id: "new-1", description: "New plan step", status: "in_progress" },
          ],
        },
      },
    ];

    expect(deriveTodoItems(events)).toEqual([
      { id: "new-1", description: "New plan step", status: "in_progress" },
    ]);
  });

  it("preserves item order within the latest todo_update", () => {
    const events: AgentChatEventEnvelope[] = [
      {
        sessionId: "session-1",
        timestamp: "2026-03-10T12:00:00.000Z",
        event: {
          type: "todo_update",
          items: [
            { id: "c", description: "Third", status: "pending" },
            { id: "a", description: "First", status: "completed" },
            { id: "b", description: "Second", status: "in_progress" },
          ],
        },
      },
    ];

    expect(deriveTodoItems(events).map((item) => item.id)).toEqual(["c", "a", "b"]);
  });

  it("preserves pending, in_progress, and completed status values", () => {
    const events: AgentChatEventEnvelope[] = [
      {
        sessionId: "session-1",
        timestamp: "2026-03-10T12:00:00.000Z",
        event: {
          type: "todo_update",
          items: [
            { id: "t1", description: "Pending item", status: "pending" },
            { id: "t2", description: "Active item", status: "in_progress" },
            { id: "t3", description: "Done item", status: "completed" },
          ],
        },
      },
    ];

    expect(deriveTodoItems(events).map((item) => item.status)).toEqual([
      "pending",
      "in_progress",
      "completed",
    ]);
  });
});
