import { describe, expect, it } from "vitest";
import type { AgentChatEventEnvelope } from "../../../shared/types";
import { buildMissionThreadEventMergeKey, mergeMissionThreadEvents } from "./MissionThreadMessageList";

describe("MissionThreadMessageList transcript merge", () => {
  it("merges persisted and live text events by turn instead of timestamp", () => {
    const fallbackEvents: AgentChatEventEnvelope[] = [
      {
        sessionId: "session-1",
        timestamp: "2026-03-10T12:00:00.000Z",
        provenance: {
          messageId: "msg-1",
          threadId: "thread-1",
        },
        event: {
          type: "text",
          turnId: "turn-1",
          itemId: "text-2",
          text: "Plan is ready",
        },
      },
    ];

    const sessionEvents: AgentChatEventEnvelope[] = [
      {
        sessionId: "session-1",
        timestamp: "2026-03-10T12:00:01.000Z",
        event: {
          type: "text",
          turnId: "turn-1",
          itemId: "text-1",
          text: "Plan",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-10T12:00:02.000Z",
        event: {
          type: "text",
          turnId: "turn-1",
          itemId: "text-3",
          text: "with tests",
        },
      },
    ];

    const merged = mergeMissionThreadEvents(fallbackEvents, sessionEvents);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.event).toMatchObject({
      type: "text",
      turnId: "turn-1",
      itemId: "text-3",
      text: "Plan is ready with tests",
    });
    expect(merged[0]?.provenance).toMatchObject({
      messageId: "msg-1",
      threadId: "thread-1",
    });
    expect(merged[0]?.timestamp).toBe("2026-03-10T12:00:02.000Z");
  });

  it("dedupes identical tool events even when transcript timestamps differ", () => {
    const fallbackEvent: AgentChatEventEnvelope = {
      sessionId: "session-1",
      timestamp: "2026-03-10T12:00:00.000Z",
      provenance: {
        messageId: "msg-tool",
      },
      event: {
        type: "tool_result",
        tool: "read_file",
        itemId: "tool-1",
        turnId: "turn-9",
        result: { ok: true },
        status: "completed",
      },
    };

    const sessionEvent: AgentChatEventEnvelope = {
      sessionId: "session-1",
      timestamp: "2026-03-10T12:00:05.000Z",
      event: {
        type: "tool_result",
        tool: "read_file",
        itemId: "tool-1",
        turnId: "turn-9",
        result: { ok: true },
        status: "completed",
      },
    };

    expect(buildMissionThreadEventMergeKey(fallbackEvent)).toBe(buildMissionThreadEventMergeKey(sessionEvent));

    const merged = mergeMissionThreadEvents([fallbackEvent], [sessionEvent]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.provenance).toMatchObject({ messageId: "msg-tool" });
    expect(merged[0]?.timestamp).toBe("2026-03-10T12:00:05.000Z");
  });

  it("drops session-only low-signal fragments that never persisted into mission chat", () => {
    const merged = mergeMissionThreadEvents([], [
      {
        sessionId: "session-1",
        timestamp: "2026-03-10T12:00:00.000Z",
        event: {
          type: "text",
          turnId: "turn-1",
          itemId: "text-1",
          text: "No",
        },
      },
    ]);

    expect(merged).toHaveLength(0);
  });
});
