import { describe, expect, it } from "vitest";
import type { AgentChatEventEnvelope } from "../../../shared/types";
import { deriveChatSubagentSnapshots } from "./chatExecutionSummary";

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
