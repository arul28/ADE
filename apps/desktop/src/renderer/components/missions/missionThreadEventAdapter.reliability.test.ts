import { describe, expect, it } from "vitest";
import { parseAgentChatTranscript } from "../../../shared/chatTranscript";
import { adaptMissionThreadMessagesToAgentEvents } from "./missionThreadEventAdapter";

describe("missionThreadEventAdapter reliability", () => {
  it("preserves tool events and provenance from persisted mission chat messages", () => {
    const events = adaptMissionThreadMessagesToAgentEvents([
      {
        id: "msg-1",
        missionId: "mission-1",
        role: "worker",
        content: "Using a tool",
        timestamp: "2026-03-09T12:00:00.000Z",
        threadId: "thread-1",
        stepKey: "step-alpha",
        attemptId: "attempt-1",
        laneId: "lane-1",
        runId: "run-1",
        sourceSessionId: "session-1",
        metadata: {
          structuredStream: {
            kind: "tool",
            itemId: "tool-item-1",
            parentItemId: "turn-1",
            tool: "read_file",
            args: { path: "src/index.ts" },
            result: { ok: true },
            status: "completed",
          },
        },
      },
    ] as any);

    expect(events).toHaveLength(2);
    expect(events[0]?.event.type).toBe("tool_call");
    expect(events[1]?.event.type).toBe("tool_result");
    expect(events[0]?.event).toMatchObject({
      type: "tool_call",
      tool: "read_file",
      itemId: "tool-item-1",
      parentItemId: "turn-1",
    });
    expect(events[1]?.provenance).toMatchObject({
      threadId: "thread-1",
      sourceSessionId: "session-1",
      attemptId: "attempt-1",
      stepKey: "step-alpha",
      laneId: "lane-1",
      runId: "run-1",
    });
  });

  it("round-trips transcript provenance", () => {
    const parsed = parseAgentChatTranscript([
      JSON.stringify({
        sessionId: "session-1",
        timestamp: "2026-03-09T12:00:00.000Z",
        provenance: {
          threadId: "thread-1",
          runId: "run-1",
          attemptId: "attempt-1",
        },
        event: {
          type: "text",
          text: "hello",
          itemId: "text-1",
        },
      }),
    ].join("\n"));

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.provenance).toMatchObject({
      threadId: "thread-1",
      runId: "run-1",
      attemptId: "attempt-1",
    });
  });

  it("preserves user delivery state and structured status/done metadata", () => {
    const events = adaptMissionThreadMessagesToAgentEvents([
      {
        id: "msg-user",
        missionId: "mission-1",
        role: "user",
        content: "What went wrong?",
        timestamp: "2026-03-09T12:00:00.000Z",
        threadId: "thread-1",
        runId: "run-1",
        deliveryState: "delivered",
        metadata: {
          structuredStream: {
            kind: "user_message",
            text: "What went wrong?",
          },
        },
      },
      {
        id: "msg-status",
        missionId: "mission-1",
        role: "orchestrator",
        content: "",
        timestamp: "2026-03-09T12:00:01.000Z",
        threadId: "thread-1",
        runId: "run-1",
        metadata: {
          structuredStream: {
            kind: "status",
            status: "interrupted",
            message: "Planner session started and then stopped almost immediately.",
            turnId: "turn-1",
          },
        },
      },
      {
        id: "msg-done",
        missionId: "mission-1",
        role: "orchestrator",
        content: "",
        timestamp: "2026-03-09T12:00:02.000Z",
        threadId: "thread-1",
        runId: "run-1",
        metadata: {
          structuredStream: {
            kind: "done",
            status: "failed",
            turnId: "turn-1",
            modelId: "anthropic/claude-sonnet-4-6",
            usage: {
              inputTokens: 42,
              outputTokens: 13,
            },
          },
        },
      },
    ] as any);

    expect(events[0]?.event).toMatchObject({
      type: "user_message",
      text: "What went wrong?",
      deliveryState: "delivered",
      processed: true,
    });
    expect(events[1]?.event).toMatchObject({
      type: "status",
      turnStatus: "interrupted",
      message: "Planner session started and then stopped almost immediately.",
    });
    expect(events[2]?.event).toMatchObject({
      type: "done",
      status: "failed",
      modelId: "anthropic/claude-sonnet-4-6",
      usage: {
        inputTokens: 42,
        outputTokens: 13,
      },
    });
  });
});
