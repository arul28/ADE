import type { AgentChatEventEnvelope } from "../types/chat";

/**
 * Cross-client contract fixture for providers that mix explicit and omitted
 * turn ids, and for imported/interrupted history with no terminal event before
 * the next user turn.
 */
export function mixedIdToolActivityBoundaryEvents(): AgentChatEventEnvelope[] {
  return [
    {
      sessionId: "session-1",
      timestamp: "2026-03-17T10:00:00.000Z",
      sequence: 1,
      event: {
        type: "command",
        command: "stale-command",
        cwd: "/repo",
        output: "",
        itemId: "stale",
        status: "completed",
        exitCode: 0,
      },
    },
    {
      sessionId: "session-1",
      timestamp: "2026-03-17T10:01:00.000Z",
      sequence: 2,
      event: { type: "user_message", text: "start a clean turn", turnId: "turn-2" },
    },
    {
      sessionId: "session-1",
      timestamp: "2026-03-17T10:01:01.000Z",
      sequence: 3,
      event: {
        type: "command",
        command: "tagged-command",
        cwd: "/repo",
        output: "",
        itemId: "tagged",
        turnId: "turn-2",
        status: "completed",
        exitCode: 0,
      },
    },
    {
      sessionId: "session-1",
      timestamp: "2026-03-17T10:01:02.000Z",
      sequence: 4,
      event: {
        type: "command",
        command: "untagged-command",
        cwd: "/repo",
        output: "",
        itemId: "untagged",
        status: "completed",
        exitCode: 0,
      },
    },
    {
      sessionId: "session-1",
      timestamp: "2026-03-17T10:01:03.000Z",
      sequence: 5,
      event: { type: "done", turnId: "turn-2", status: "completed" },
    },
  ];
}
