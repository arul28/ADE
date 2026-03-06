import { describe, expect, it } from "vitest";
import type { OrchestratorChatMessage } from "../../../shared/types";
import { adaptMissionThreadMessagesToAgentEvents } from "./missionThreadEventAdapter";

function message(overrides: Partial<OrchestratorChatMessage>): OrchestratorChatMessage {
  return {
    id: overrides.id ?? "msg-1",
    missionId: overrides.missionId ?? "mission-1",
    role: overrides.role ?? "worker",
    content: overrides.content ?? "",
    timestamp: overrides.timestamp ?? "2026-03-06T12:00:00.000Z",
    metadata: overrides.metadata ?? null,
    threadId: overrides.threadId ?? "worker:mission-1:attempt-1",
    attemptId: overrides.attemptId ?? "attempt-1",
    sourceSessionId: overrides.sourceSessionId ?? "session-1",
    runId: overrides.runId ?? "run-1",
    laneId: overrides.laneId ?? "lane-1",
    stepKey: overrides.stepKey ?? "implement-test-tab",
    target: overrides.target,
    visibility: overrides.visibility,
    deliveryState: overrides.deliveryState,
  };
}

describe("adaptMissionThreadMessagesToAgentEvents", () => {
  it("turns merged tool metadata into tool call and tool result events", () => {
    const events = adaptMissionThreadMessagesToAgentEvents([
      message({
        id: "tool-msg",
        content: "Tool call: Read",
        metadata: {
          structuredStream: {
            kind: "tool",
            sessionId: "planner-session",
            turnId: "turn-1",
            itemId: "tool-1",
            tool: "Read",
            args: { path: "apps/desktop/src/main.ts" },
            result: { ok: true },
            status: "completed",
          },
        },
      }),
    ]);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      sessionId: "planner-session",
      event: {
        type: "tool_call",
        tool: "Read",
        itemId: "tool-1",
        turnId: "turn-1",
        args: { path: "apps/desktop/src/main.ts" },
      },
    });
    expect(events[1]).toMatchObject({
      sessionId: "planner-session",
      event: {
        type: "tool_result",
        tool: "Read",
        itemId: "tool-1",
        turnId: "turn-1",
        result: { ok: true },
        status: "completed",
      },
    });
  });

  it("preserves structured reasoning, text, status, and done events", () => {
    const events = adaptMissionThreadMessagesToAgentEvents([
      message({
        id: "reasoning-msg",
        content: "Thinking through the plan.",
        metadata: {
          structuredStream: {
            kind: "reasoning",
            sessionId: "planner-session",
            turnId: "turn-9",
            itemId: "reasoning-1",
            summaryIndex: 2,
          },
        },
      }),
      message({
        id: "text-msg",
        content: "Plan is ready.",
        timestamp: "2026-03-06T12:00:01.000Z",
        metadata: {
          structuredStream: {
            kind: "text",
            sessionId: "planner-session",
            turnId: "turn-9",
            itemId: "text-1",
          },
        },
      }),
      message({
        id: "status-msg",
        content: "Turn completed.",
        timestamp: "2026-03-06T12:00:02.000Z",
        metadata: {
          structuredStream: {
            kind: "status",
            sessionId: "planner-session",
            turnId: "turn-9",
            status: "completed",
            message: "Worker finished planning",
          },
        },
      }),
      message({
        id: "done-msg",
        content: "done",
        timestamp: "2026-03-06T12:00:03.000Z",
        metadata: {
          structuredStream: {
            kind: "done",
            sessionId: "planner-session",
            turnId: "turn-9",
            status: "completed",
            modelId: "anthropic/claude-sonnet-4-6",
            usage: { inputTokens: 42, outputTokens: 13 },
          },
        },
      }),
    ]);

    expect(events.map((entry) => entry.event.type)).toEqual(["reasoning", "text", "status", "done"]);
    expect(events[0]?.event).toMatchObject({
      type: "reasoning",
      text: "Thinking through the plan.",
      turnId: "turn-9",
      itemId: "reasoning-1",
      summaryIndex: 2,
    });
    expect(events[1]?.event).toMatchObject({
      type: "text",
      text: "Plan is ready.",
      turnId: "turn-9",
      itemId: "text-1",
    });
    expect(events[2]?.event).toMatchObject({
      type: "status",
      turnStatus: "completed",
      turnId: "turn-9",
      message: "Worker finished planning",
    });
    expect(events[3]?.event).toMatchObject({
      type: "done",
      turnId: "turn-9",
      status: "completed",
      modelId: "anthropic/claude-sonnet-4-6",
      usage: { inputTokens: 42, outputTokens: 13 },
    });
  });

  it("falls back to user and text events for legacy thread messages", () => {
    const events = adaptMissionThreadMessagesToAgentEvents([
      message({
        id: "user-msg",
        role: "user",
        content: "What are you doing?",
        timestamp: "2026-03-06T12:00:00.000Z",
        metadata: null,
      }),
      message({
        id: "worker-msg",
        role: "worker",
        content: "I am reviewing the routing files.",
        timestamp: "2026-03-06T12:00:01.000Z",
        metadata: null,
      }),
    ]);

    expect(events).toHaveLength(2);
    expect(events[0]?.event).toMatchObject({
      type: "user_message",
      text: "What are you doing?",
    });
    expect(events[1]?.event).toMatchObject({
      type: "text",
      text: "I am reviewing the routing files.",
      itemId: "worker-msg:text",
    });
  });
});
