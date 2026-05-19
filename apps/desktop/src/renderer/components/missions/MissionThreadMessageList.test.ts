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

  it("keeps distinct reasoning blocks separated by item id", () => {
    const merged = mergeMissionThreadEvents([], [
      {
        sessionId: "session-1",
        timestamp: "2026-03-10T12:00:00.000Z",
        event: {
          type: "reasoning",
          turnId: "turn-1",
          itemId: "reasoning-1",
          text: "First thought.",
        },
      },
      {
        sessionId: "session-1",
        timestamp: "2026-03-10T12:00:01.000Z",
        event: {
          type: "reasoning",
          turnId: "turn-1",
          itemId: "reasoning-2",
          text: "Second thought.",
        },
      },
    ]);

    const reasoning = merged.filter((envelope) => envelope.event.type === "reasoning");
    expect(reasoning).toHaveLength(2);
    expect(reasoning.map((envelope) => envelope.event.type === "reasoning" ? envelope.event.text : "")).toEqual([
      "First thought.",
      "Second thought.",
    ]);
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

  it("drops synthetic coordinator prompts from mission threads", () => {
    const merged = mergeMissionThreadEvents([
      {
        sessionId: "coordinator-session",
        timestamp: "2026-03-10T12:00:00.000Z",
        provenance: {
          messageId: "msg-internal",
          role: "orchestrator",
          targetKind: "coordinator",
        },
        event: {
          type: "user_message",
          text: "## ADE Mission-Control Tool Transport\nInternal runtime prompt.",
          displayText: "Continue mission coordination.",
          turnId: "turn-1",
        },
      },
      {
        sessionId: "worker-session",
        timestamp: "2026-03-10T12:00:01.000Z",
        event: {
          type: "text",
          text: "Visible worker update.",
          turnId: "turn-2",
          itemId: "text-1",
        },
      },
    ], []);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.event).toMatchObject({
      type: "text",
      text: "Visible worker update.",
    });
  });

  it("drops coordinator mission-control replay plumbing", () => {
    const merged = mergeMissionThreadEvents([
      {
        sessionId: "coordinator:run-1",
        timestamp: "2026-03-10T12:00:00.000Z",
        provenance: {
          role: "orchestrator",
          targetKind: "coordinator",
        },
        event: {
          type: "status",
          turnStatus: "interrupted",
          message: "The coordinator wrote mission-control calls as text, so ADE is replaying those calls through the real mission-control tools.",
        },
      },
      {
        sessionId: "coordinator:run-1",
        timestamp: "2026-03-10T12:00:01.000Z",
        provenance: {
          role: "orchestrator",
          targetKind: "coordinator",
        },
        event: {
          type: "tool_call",
          tool: "spawn_worker",
          args: { name: "implementation" },
          itemId: "recovered:turn-1:0",
          turnId: "turn-1",
        },
      },
      {
        sessionId: "coordinator:run-1",
        timestamp: "2026-03-10T12:00:02.000Z",
        provenance: {
          role: "orchestrator",
          targetKind: "coordinator",
        },
        event: {
          type: "error",
          message: "Codex app-server exited (code=0, signal=null).",
        },
      },
      {
        sessionId: "coordinator-session",
        timestamp: "2026-03-10T12:00:02.500Z",
        provenance: {
          role: "orchestrator",
          targetKind: "coordinator",
        },
        event: {
          type: "text",
          text: "// spawn_worker\n{ malformed transport text that should stay internal }",
          itemId: "raw-transport",
        },
      },
      {
        sessionId: "coordinator:run-1",
        timestamp: "2026-03-10T12:00:03.000Z",
        event: {
          type: "text",
          text: "Visible coordinator note.",
          itemId: "visible",
        },
      },
    ], []);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.event).toMatchObject({
      type: "text",
      text: "Visible coordinator note.",
    });
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
    Object.defineProperty(globalThis.window, "ade", {
      configurable: true,
      writable: true,
      value: {
        sessions: {
          readTranscriptTail: vi.fn(() => Promise.resolve("")),
        },
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis.window, "ade", {
      configurable: true,
      writable: true,
      value: originalAde,
    });
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

  it("does not read raw transcript tails for closed mission history threads", async () => {
    const readTranscriptTail = vi.fn(() => Promise.resolve(""));
    Object.defineProperty(globalThis.window, "ade", {
      configurable: true,
      writable: true,
      value: {
        sessions: {
          readTranscriptTail,
        },
      },
    });

    render(React.createElement(MissionThreadMessageList, {
      messages: [],
      sessionId: "session-closed",
      transcriptPollingEnabled: false,
    }));

    await Promise.resolve();
    expect(readTranscriptTail).not.toHaveBeenCalled();
  });

  it("hides recovered mission-control transport blocks before rendering", () => {
    render(React.createElement(MissionThreadMessageList, {
      messages: [
        {
          id: "msg-tool-transport",
          missionId: "mission-1",
          role: "orchestrator",
          content: [
            "```json",
            "// spawn_worker",
            "{\"name\":\"implementation\",\"prompt\":\"Write the test\"}",
            "```",
          ].join("\n"),
          timestamp: "2026-03-10T12:00:00.000Z",
          threadId: "mission:mission-1",
          sourceSessionId: "coordinator-session",
          target: { kind: "coordinator", runId: "run-1" },
          metadata: {
            structuredStream: {
              kind: "text",
              sessionId: "coordinator-session",
              turnId: "turn-1",
              itemId: "text-1",
            },
          },
        },
        {
          id: "msg-visible",
          missionId: "mission-1",
          role: "orchestrator",
          content: "Visible mission update.",
          timestamp: "2026-03-10T12:00:01.000Z",
          threadId: "mission:mission-1",
          metadata: {
            structuredStream: {
              kind: "text",
              sessionId: "coordinator-session",
              turnId: "turn-2",
              itemId: "text-2",
            },
          },
        },
      ] as any,
    }));

    const events = agentListMock.mock.calls.at(-1)?.[0].events as AgentChatEventEnvelope[];
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toMatchObject({
      type: "text",
      text: "Visible mission update.",
    });
  });

  it("cleans worker result file JSON from rendered mission thread text", () => {
    render(React.createElement(MissionThreadMessageList, {
      messages: [
        {
          id: "msg-worker-result",
          missionId: "mission-1",
          role: "orchestrator",
          content: [
            "[worker] Finished - Created the helper. *Changed Files**",
            "```json",
            "{\"filesChanged\":[\"src/helper.ts\",\"src/helper.test.ts\"]}",
            "```",
          ].join("\n"),
          timestamp: "2026-03-10T12:00:00.000Z",
          threadId: "mission:mission-1",
          metadata: {
            structuredStream: {
              kind: "text",
              sessionId: "coordinator-session",
              turnId: "turn-1",
              itemId: "text-1",
            },
          },
        },
      ] as any,
    }));

    const events = agentListMock.mock.calls.at(-1)?.[0].events as AgentChatEventEnvelope[];
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toMatchObject({
      type: "text",
      text: "[worker] Finished - Created the helper.\n\nChanged files:\n- src/helper.ts\n- src/helper.test.ts",
    });
  });

  it("removes dangling worker result file fences from legacy transcript snippets", () => {
    render(React.createElement(MissionThreadMessageList, {
      messages: [
        {
          id: "msg-worker-result-truncated",
          missionId: "mission-1",
          role: "orchestrator",
          content: "[worker] Finished - Created the helper. *Changed Files** ```json",
          timestamp: "2026-03-10T12:00:00.000Z",
          threadId: "mission:mission-1",
        },
      ] as any,
    }));

    const events = agentListMock.mock.calls.at(-1)?.[0].events as AgentChatEventEnvelope[];
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toMatchObject({
      type: "text",
      text: "[worker] Finished - Created the helper.",
    });
  });

  it("removes malformed worker report payloads that were truncated mid-json", () => {
    render(React.createElement(MissionThreadMessageList, {
      messages: [
        {
          id: "msg-worker-result-truncated-json",
          missionId: "mission-1",
          role: "worker",
          content: "I finished this task and reported back: Created the helper. Targeted test passed. *Changed Files** ```json { \"filesChanged\": [ \"src/helper.ts\"",
          timestamp: "2026-03-10T12:00:00.000Z",
          threadId: "worker:mission-1:attempt-1",
          sourceSessionId: "session-worker",
        },
      ] as any,
    }));

    const events = agentListMock.mock.calls.at(-1)?.[0].events as AgentChatEventEnvelope[];
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toMatchObject({
      type: "text",
      text: "I finished this task and reported back: Created the helper. Targeted test passed.",
    });
  });

  it("hides completed done rows when they only repeat the model label", () => {
    render(React.createElement(MissionThreadMessageList, {
      messages: [
        {
          id: "msg-model-only-done",
          missionId: "mission-1",
          role: "worker",
          content: "Turn completed.",
          timestamp: "2026-03-10T12:00:00.000Z",
          threadId: "worker:mission-1:attempt-1",
          metadata: {
            structuredStream: {
              kind: "done",
              sessionId: "session-worker",
              turnId: "turn-1",
              status: "completed",
              model: "gpt-5.5",
              modelId: "openai/gpt-5.5",
            },
          },
        },
        {
          id: "msg-visible",
          missionId: "mission-1",
          role: "worker",
          content: "Finished the step.",
          timestamp: "2026-03-10T12:00:01.000Z",
          threadId: "worker:mission-1:attempt-1",
        },
      ] as any,
    }));

    const events = agentListMock.mock.calls.at(-1)?.[0].events as AgentChatEventEnvelope[];
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toMatchObject({
      type: "text",
      text: "Finished the step.",
    });
  });

  it("hides dangling persisted text fragments from closed worker histories", () => {
    render(React.createElement(MissionThreadMessageList, {
      messages: [
        {
          id: "msg-dangling-fragment",
          missionId: "mission-1",
          role: "worker",
          content: "looking at the",
          timestamp: "2026-03-10T12:00:00.000Z",
          threadId: "worker:mission-1:attempt-1",
          metadata: {
            structuredStream: {
              kind: "text",
              sessionId: "session-worker",
              turnId: "turn-1",
              itemId: "text-1",
            },
          },
        },
        {
          id: "msg-visible",
          missionId: "mission-1",
          role: "worker",
          content: "Plan is ready",
          timestamp: "2026-03-10T12:00:01.000Z",
          threadId: "worker:mission-1:attempt-1",
        },
      ] as any,
    }));

    const events = agentListMock.mock.calls.at(-1)?.[0].events as AgentChatEventEnvelope[];
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toMatchObject({
      type: "text",
      text: "Plan is ready",
    });
  });

  it("hides internal validation control chatter from mission transcripts", () => {
    render(React.createElement(MissionThreadMessageList, {
      messages: [
        {
          id: "msg-validation-missing",
          missionId: "mission-1",
          role: "orchestrator",
          content: "[test_step] Validation System: Required validation is missing for \"Run tests\". A validator pass is required before this step can be treated as complete.",
          timestamp: "2026-03-10T12:00:00.000Z",
          threadId: "mission:mission-1",
        },
        {
          id: "msg-plan-adjust",
          missionId: "mission-1",
          role: "orchestrator",
          content: "[test_step] Progress: 4/5 steps (80%) | next: \"Validate: Run tests\" — triggering plan adjustment",
          timestamp: "2026-03-10T12:00:01.000Z",
          threadId: "mission:mission-1",
        },
        {
          id: "msg-visible",
          missionId: "mission-1",
          role: "orchestrator",
          content: "[validate_test_step] Started worker \"Validate: Run tests\". It is now working on this step.",
          timestamp: "2026-03-10T12:00:02.000Z",
          threadId: "mission:mission-1",
        },
      ] as any,
    }));

    const events = agentListMock.mock.calls.at(-1)?.[0].events as AgentChatEventEnvelope[];
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toMatchObject({
      type: "text",
      text: "[validate_test_step] Started worker \"Validate: Run tests\". It is now working on this step.",
    });
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
