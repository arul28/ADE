/* @vitest-environment jsdom */

import React from "react";
import { describe, expect, it, vi, beforeEach, afterEach, type Mock } from "vitest";
import { render, waitFor } from "@testing-library/react";
import type { AgentChatEventEnvelope } from "../../../shared/types";
import { AgentChatMessageList } from "../chat/AgentChatMessageList";
import { MissionThreadMessageList, mergeMissionThreadEvents, buildMissionThreadEventMergeKey } from "./MissionThreadMessageList";
import { useMissionPolling } from "./useMissionPolling";

const agentListLifecycle = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }));

vi.mock("../chat/AgentChatMessageList", async () => {
  const React = await import("react");
  return {
    AgentChatMessageList: vi.fn(() => {
      React.useEffect(() => {
        agentListLifecycle.mounts += 1;
        return () => {
          agentListLifecycle.unmounts += 1;
        };
      }, []);
      return null;
    }),
  };
});

vi.mock("./useMissionPolling", () => ({
  useMissionPolling: vi.fn(() => undefined),
}));

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

  it("keeps mission-thread text fragments merged even when structured events interleave", () => {
    const merged = mergeMissionThreadEvents([], [
      {
        sessionId: "session-1",
        timestamp: "2026-03-10T12:00:00.000Z",
        event: {
          type: "text",
          turnId: "turn-7",
          itemId: "text-1",
          text: "Grouped command cards",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-10T12:00:01.000Z",
        event: {
          type: "tool_result",
          tool: "read_file",
          itemId: "tool-1",
          turnId: "turn-7",
          status: "completed",
          result: { ok: true },
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-10T12:00:02.000Z",
        event: {
          type: "text",
          turnId: "turn-7",
          itemId: "text-1",
          text: " with quieter scrolling",
        },
      },
    ]);

    expect(
      merged.some((envelope) =>
        envelope.event.type === "text" && envelope.event.text === "Grouped command cards with quieter scrolling",
      ),
    ).toBe(true);
  });
});

describe("MissionThreadMessageList usage", () => {
  const agentListMock = AgentChatMessageList as unknown as Mock;
  const originalAde = globalThis.window.ade;

  beforeEach(() => {
    agentListMock.mockClear();
    agentListLifecycle.mounts = 0;
    agentListLifecycle.unmounts = 0;
    (useMissionPolling as unknown as Mock).mockClear();
    globalThis.window.ade = {
      sessions: {
        readTranscriptTail: vi.fn(() => Promise.resolve("")),
      },
    } as any;
  });

  afterEach(() => {
    globalThis.window.ade = originalAde;
  });

  it("passes mission-feed mode when no session is selected", () => {
    render(React.createElement(MissionThreadMessageList, { messages: [], className: "main-timeline" }));
    expect(agentListMock).toHaveBeenCalledWith(
      expect.objectContaining({ surfaceMode: "mission-feed", className: "main-timeline" }),
      expect.anything(),
    );
  });

  it("passes mission-thread mode when a session is provided", () => {
    render(React.createElement(MissionThreadMessageList, { messages: [], sessionId: "session-abc" }));
    expect(agentListMock).toHaveBeenCalledWith(
      expect.objectContaining({ surfaceMode: "mission-thread" }),
      expect.anything(),
    );
  });

  it("remounts the transcript list when the selected session changes", async () => {
    const { rerender } = render(React.createElement(MissionThreadMessageList, { messages: [], sessionId: "session-abc" }));

    await waitFor(() => {
      expect(agentListLifecycle.mounts).toBe(1);
      expect(agentListLifecycle.unmounts).toBe(0);
    });

    rerender(React.createElement(MissionThreadMessageList, { messages: [], sessionId: "session-def" }));

    await waitFor(() => {
      expect(agentListLifecycle.mounts).toBe(2);
      expect(agentListLifecycle.unmounts).toBe(1);
    });
  });
});
