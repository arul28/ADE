import { describe, expect, it } from "vitest";
import {
  RUNTIME_EVENT_TYPES,
  agentChatEventToRuntimeEvent,
  buildCanonicalAgentChatRuntimeEvent,
  runtimeEventToAgentChatEvent,
} from "./runtimeEvents";

describe("runtimeEvents", () => {
  it("declares the canonical cross-runtime event vocabulary", () => {
    expect(RUNTIME_EVENT_TYPES).toEqual([
      "turn.started",
      "content.delta",
      "tool.started",
      "tool.completed",
      "tool.failed",
      "subagent.started",
      "subagent.progress",
      "subagent.completed",
      "teammate.idle",
      "task.completed",
      "turn.completed",
      "compact.boundary",
    ]);
  });

  it("translates legacy subagent events into the canonical envelope", () => {
    expect(buildCanonicalAgentChatRuntimeEvent({
      type: "subagent_started",
      taskId: "toolu-1",
      agentId: "agent-1",
      parentToolUseId: "parent-1",
      agentType: "explorer",
      description: "scan files",
      background: true,
      turnId: "turn-1",
    })).toEqual({
      type: "subagent.started",
      agentId: "agent-1",
      parentToolUseId: "parent-1",
      agentType: "explorer",
      description: "scan files",
      background: true,
      turnId: "turn-1",
    });
  });

  it("round-trips tool failure events through runtime shape", () => {
    const runtime = agentChatEventToRuntimeEvent({
      type: "tool_result",
      tool: "Bash",
      result: "exit 1",
      itemId: "toolu-2",
      status: "failed",
      turnId: "turn-1",
    });

    expect(runtime).toEqual({
      type: "tool.failed",
      toolUseId: "toolu-2",
      toolName: "Bash",
      error: "exit 1",
      turnId: "turn-1",
    });
    expect(runtimeEventToAgentChatEvent(runtime!)).toEqual({
      type: "tool_result",
      tool: "Bash",
      result: "exit 1",
      itemId: "toolu-2",
      status: "failed",
      turnId: "turn-1",
    });
  });
});
