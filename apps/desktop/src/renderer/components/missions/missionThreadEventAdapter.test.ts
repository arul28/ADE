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

  it("preserves approval, command, file, plan, activity, step, and structured user events", () => {
    const events = adaptMissionThreadMessagesToAgentEvents([
      message({
        id: "approval-msg",
        content: "Need approval",
        metadata: {
          structuredStream: {
            kind: "approval_request",
            sessionId: "worker-session",
            turnId: "turn-5",
            itemId: "approval-1",
            requestKind: "command",
            description: "Run npm test",
            detail: { command: "npm test" },
          },
        },
      }),
      message({
        id: "command-msg",
        content: "npm test",
        timestamp: "2026-03-06T12:00:01.000Z",
        metadata: {
          structuredStream: {
            kind: "command",
            sessionId: "worker-session",
            turnId: "turn-5",
            itemId: "cmd-1",
            command: "npm test",
            cwd: "/repo",
            output: "all green",
            status: "completed",
            exitCode: 0,
            durationMs: 1200,
          },
        },
      }),
      message({
        id: "file-msg",
        content: "Updated src/index.ts",
        timestamp: "2026-03-06T12:00:02.000Z",
        metadata: {
          structuredStream: {
            kind: "file_change",
            sessionId: "worker-session",
            turnId: "turn-5",
            itemId: "file-1",
            path: "src/index.ts",
            diff: "+hello",
            changeKind: "create",
            status: "completed",
          },
        },
      }),
      message({
        id: "plan-msg",
        content: "Plan ready",
        timestamp: "2026-03-06T12:00:03.000Z",
        metadata: {
          structuredStream: {
            kind: "plan",
            sessionId: "worker-session",
            turnId: "turn-5",
            explanation: "Two steps",
            steps: [
              { text: "Inspect files", status: "completed" },
              { text: "Apply patch", status: "in_progress" },
            ],
          },
        },
      }),
      message({
        id: "activity-msg",
        content: "Searching",
        timestamp: "2026-03-06T12:00:04.000Z",
        metadata: {
          structuredStream: {
            kind: "activity",
            sessionId: "worker-session",
            turnId: "turn-5",
            activity: "searching",
            detail: "grep",
          },
        },
      }),
      message({
        id: "step-msg",
        content: "Step 2",
        timestamp: "2026-03-06T12:00:05.000Z",
        metadata: {
          structuredStream: {
            kind: "step_boundary",
            sessionId: "worker-session",
            turnId: "turn-5",
            stepNumber: 2,
          },
        },
      }),
      message({
        id: "user-structured-msg",
        content: "Use the API model",
        timestamp: "2026-03-06T12:00:06.000Z",
        metadata: {
          structuredStream: {
            kind: "user_message",
            sessionId: "worker-session",
            turnId: "turn-5",
            text: "Use the API model",
            attachments: [{ path: "/tmp/spec.md", type: "file" }],
          },
        },
      }),
    ]);

    expect(events.map((entry) => entry.event.type)).toEqual([
      "approval_request",
      "command",
      "file_change",
      "plan",
      "activity",
      "step_boundary",
      "user_message",
    ]);
    expect(events[0]?.event).toMatchObject({
      type: "approval_request",
      itemId: "approval-1",
      kind: "command",
      description: "Run npm test",
      detail: { command: "npm test" },
    });
    expect(events[1]?.event).toMatchObject({
      type: "command",
      itemId: "cmd-1",
      command: "npm test",
      cwd: "/repo",
      output: "all green",
      status: "completed",
      exitCode: 0,
      durationMs: 1200,
    });
    expect(events[2]?.event).toMatchObject({
      type: "file_change",
      itemId: "file-1",
      path: "src/index.ts",
      diff: "+hello",
      kind: "create",
      status: "completed",
    });
    expect(events[3]?.event).toMatchObject({
      type: "plan",
      explanation: "Two steps",
      steps: [
        { text: "Inspect files", status: "completed" },
        { text: "Apply patch", status: "in_progress" },
      ],
    });
    expect(events[4]?.event).toMatchObject({
      type: "activity",
      activity: "searching",
      detail: "grep",
    });
    expect(events[5]?.event).toMatchObject({
      type: "step_boundary",
      stepNumber: 2,
    });
    expect(events[6]?.event).toMatchObject({
      type: "user_message",
      text: "Use the API model",
      attachments: [{ path: "/tmp/spec.md", type: "file" }],
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

  it("reconstructs approvals, commands, file changes, plans, activity, and user messages", () => {
    const events = adaptMissionThreadMessagesToAgentEvents([
      message({
        id: "approval-msg",
        content: "Which branch should I use?",
        metadata: {
          structuredStream: {
            kind: "approval_request",
            sessionId: "worker-session",
            turnId: "turn-2",
            itemId: "approval-1",
            requestKind: "tool_call",
            description: "Which branch should I use?",
            detail: { tool: "askUser", question: "Which branch should I use?" },
          },
        },
      }),
      message({
        id: "command-msg",
        content: "pnpm test",
        timestamp: "2026-03-06T12:00:01.000Z",
        metadata: {
          structuredStream: {
            kind: "command",
            sessionId: "worker-session",
            turnId: "turn-2",
            itemId: "command-1",
            command: "pnpm test",
            cwd: "/tmp/ade",
            output: "ok",
            status: "completed",
            exitCode: 0,
          },
        },
      }),
      message({
        id: "file-msg",
        content: "updated file",
        timestamp: "2026-03-06T12:00:02.000Z",
        metadata: {
          structuredStream: {
            kind: "file_change",
            sessionId: "worker-session",
            turnId: "turn-2",
            itemId: "file-1",
            path: "src/app.ts",
            diff: "+hello",
            changeKind: "modify",
            status: "completed",
          },
        },
      }),
      message({
        id: "plan-msg",
        content: "plan",
        timestamp: "2026-03-06T12:00:03.000Z",
        metadata: {
          structuredStream: {
            kind: "plan",
            sessionId: "worker-session",
            turnId: "turn-2",
            explanation: "Work through the stack.",
            steps: [{ text: "Inspect", status: "completed" }, { text: "Patch", status: "in_progress" }],
          },
        },
      }),
      message({
        id: "activity-msg",
        content: "Reading files",
        timestamp: "2026-03-06T12:00:04.000Z",
        metadata: {
          structuredStream: {
            kind: "activity",
            sessionId: "worker-session",
            turnId: "turn-2",
            activity: "reading",
            detail: "Reading src/app.ts",
          },
        },
      }),
      message({
        id: "user-structured-msg",
        role: "worker",
        content: "Use release/main",
        timestamp: "2026-03-06T12:00:05.000Z",
        metadata: {
          structuredStream: {
            kind: "user_message",
            sessionId: "worker-session",
            turnId: "turn-2",
            text: "Use release/main",
            attachments: [{ path: "docs/plan.md", type: "file" }],
          },
        },
      }),
    ]);

    expect(events.map((entry) => entry.event.type)).toEqual([
      "approval_request",
      "command",
      "file_change",
      "plan",
      "activity",
      "user_message",
    ]);
    expect(events[0]?.event).toMatchObject({
      type: "approval_request",
      itemId: "approval-1",
      detail: { tool: "askUser", question: "Which branch should I use?" },
    });
    expect(events[1]?.event).toMatchObject({
      type: "command",
      itemId: "command-1",
      command: "pnpm test",
      status: "completed",
      exitCode: 0,
    });
    expect(events[2]?.event).toMatchObject({
      type: "file_change",
      itemId: "file-1",
      path: "src/app.ts",
      diff: "+hello",
    });
    expect(events[3]?.event).toMatchObject({
      type: "plan",
      explanation: "Work through the stack.",
      steps: [{ text: "Inspect", status: "completed" }, { text: "Patch", status: "in_progress" }],
    });
    expect(events[4]?.event).toMatchObject({
      type: "activity",
      activity: "reading",
      detail: "Reading src/app.ts",
    });
    expect(events[5]?.event).toMatchObject({
      type: "user_message",
      text: "Use release/main",
      attachments: [{ path: "docs/plan.md", type: "file" }],
    });
  });
});
