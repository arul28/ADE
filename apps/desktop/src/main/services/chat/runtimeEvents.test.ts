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
      model: "gpt-5.1",
      reasoningEffort: "high",
      label: "Sagan",
      description: "scan files",
      background: true,
      turnId: "turn-1",
    })).toEqual({
      type: "subagent.started",
      agentId: "agent-1",
      parentToolUseId: "parent-1",
      agentType: "explorer",
      model: "gpt-5.1",
      reasoningEffort: "high",
      label: "Sagan",
      description: "scan files",
      background: true,
      turnId: "turn-1",
    });
  });

  it("round-trips subagent display metadata through the canonical runtime shape", () => {
    // The legacy `subagent.completed` shape still arrives from runtimes and
    // from old transcripts, so it must survive the round trip intact.
    const runtime = agentChatEventToRuntimeEvent({
      type: "subagent.completed",
      agentId: "agent-1",
      parentToolUseId: "parent-1",
      agentType: "reviewer",
      model: "claude-opus-4-7",
      reasoningEffort: "medium",
      label: "Beauvoir",
      status: "completed",
      summary: "Done",
      usage: { totalTokens: 42 },
      turnId: "turn-1",
    });

    expect(runtime).toEqual({
      type: "subagent.completed",
      agentId: "agent-1",
      parentToolUseId: "parent-1",
      agentType: "reviewer",
      model: "claude-opus-4-7",
      reasoningEffort: "medium",
      label: "Beauvoir",
      status: "completed",
      summary: "Done",
      usage: { totalTokens: 42 },
      turnId: "turn-1",
    });
    expect(runtimeEventToAgentChatEvent(runtime!)).toEqual({
      type: "subagent.completed",
      agentId: "agent-1",
      parentToolUseId: "parent-1",
      agentType: "reviewer",
      model: "claude-opus-4-7",
      reasoningEffort: "medium",
      label: "Beauvoir",
      status: "completed",
      summary: "Done",
      usage: { totalTokens: 42 },
      turnId: "turn-1",
    });
  });

  it("mints no second end event for a finished subagent", () => {
    // `subagent_result` is THE end event. Minting a canonical
    // `subagent.completed` beside it made every client count, group, and render
    // each finished subagent twice. It is not translated at all now, so there
    // is no second end event to filter back out.
    const endEvent = {
      type: "subagent_result",
      taskId: "task-1",
      agentId: "agent-1",
      status: "completed",
      summary: "Done",
      turnId: "turn-1",
    } as const;
    expect(agentChatEventToRuntimeEvent(endEvent)).toBeNull();
    expect(buildCanonicalAgentChatRuntimeEvent(endEvent)).toBeNull();
    // The start event still gets its canonical twin — only the END is single.
    expect(buildCanonicalAgentChatRuntimeEvent({
      type: "subagent_started",
      taskId: "task-1",
      agentId: "agent-1",
      description: "scan files",
      turnId: "turn-1",
    })).toMatchObject({ type: "subagent.started", agentId: "agent-1" });
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
