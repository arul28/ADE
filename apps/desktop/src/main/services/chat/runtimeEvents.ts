import type { AgentChatEvent } from "../../../shared/types";

export type RuntimeEventUsage = {
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheCreationTokens?: number | null;
  totalTokens?: number;
  toolUses?: number;
  durationMs?: number;
};

export type RuntimeEvent =
  | { type: "turn.started"; turnId: string }
  | { type: "content.delta"; turnId: string; text: string; agentId?: string; parentToolUseId?: string | null; itemId?: string }
  | { type: "tool.started"; toolUseId: string; toolName: string; input: unknown; agentId?: string; parentToolUseId?: string | null; turnId?: string }
  | { type: "tool.completed"; toolUseId: string; toolName?: string; output: unknown; durationMs?: number | null; turnId?: string }
  | { type: "tool.failed"; toolUseId: string; toolName?: string; error: string; turnId?: string }
  | { type: "subagent.started"; agentId: string; parentToolUseId?: string | null; agentType?: string; description?: string; background?: boolean; turnId?: string }
  | { type: "subagent.progress"; agentId: string; parentToolUseId?: string | null; agentType?: string; text?: string; tokens?: number; lastToolName?: string; turnId?: string }
  | { type: "subagent.completed"; agentId: string; parentToolUseId?: string | null; agentType?: string; summary: string; status?: "completed" | "failed" | "stopped"; usage?: RuntimeEventUsage; turnId?: string }
  | { type: "teammate.idle"; teamName: string; teammateName: string; turnId?: string }
  | { type: "task.completed"; taskId: string; subject: string; teammateName?: string; teamName?: string; turnId?: string }
  | { type: "turn.completed"; turnId: string; stopReason: string; usage?: RuntimeEventUsage }
  | { type: "compact.boundary"; uuid: string; trigger?: "manual" | "auto"; turnId?: string };

export const RUNTIME_EVENT_TYPES = [
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
] as const satisfies readonly RuntimeEvent["type"][];

function isCanonicalAgentChatRuntimeEvent(event: AgentChatEvent): boolean {
  return event.type === "subagent.started"
    || event.type === "subagent.progress"
    || event.type === "subagent.completed";
}

export function agentChatEventToRuntimeEvent(event: AgentChatEvent): RuntimeEvent | null {
  if (event.type === "status" && event.turnStatus === "started" && event.turnId) {
    return { type: "turn.started", turnId: event.turnId };
  }

  if (event.type === "text" && event.turnId && event.text.length > 0) {
    return {
      type: "content.delta",
      turnId: event.turnId,
      text: event.text,
      ...(event.itemId ? { itemId: event.itemId } : {}),
    };
  }

  if (event.type === "tool_call") {
    return {
      type: "tool.started",
      toolUseId: event.logicalItemId ?? event.itemId,
      toolName: event.tool,
      input: event.args,
      ...(event.parentItemId ? { parentToolUseId: event.parentItemId } : {}),
      ...(event.turnId ? { turnId: event.turnId } : {}),
    };
  }

  if (event.type === "tool_result") {
    if (event.status === "failed") {
      const error = typeof event.result === "string" ? event.result : JSON.stringify(event.result);
      return {
        type: "tool.failed",
        toolUseId: event.logicalItemId ?? event.itemId,
        toolName: event.tool,
        error,
        ...(event.turnId ? { turnId: event.turnId } : {}),
      };
    }
    return {
      type: "tool.completed",
      toolUseId: event.logicalItemId ?? event.itemId,
      toolName: event.tool,
      output: event.result,
      ...(event.turnId ? { turnId: event.turnId } : {}),
    };
  }

  if (event.type === "subagent_started") {
    return {
      type: "subagent.started",
      agentId: event.agentId ?? event.taskId,
      parentToolUseId: event.parentToolUseId ?? null,
      agentType: event.agentType,
      description: event.description,
      background: event.background,
      turnId: event.turnId,
    };
  }

  if (event.type === "subagent_progress") {
    return {
      type: "subagent.progress",
      agentId: event.agentId ?? event.taskId,
      parentToolUseId: event.parentToolUseId ?? null,
      agentType: event.agentType,
      text: event.summary,
      tokens: event.usage?.totalTokens,
      lastToolName: event.lastToolName,
      turnId: event.turnId,
    };
  }

  if (event.type === "subagent_result") {
    return {
      type: "subagent.completed",
      agentId: event.agentId ?? event.taskId,
      parentToolUseId: event.parentToolUseId ?? null,
      agentType: event.agentType,
      summary: event.finalSummary ?? event.summary,
      status: event.status,
      usage: event.usage,
      turnId: event.turnId,
    };
  }

  if (event.type === "subagent.started") return event;
  if (event.type === "subagent.progress") return event;
  if (event.type === "subagent.completed") return event;

  if (event.type === "done") {
    return {
      type: "turn.completed",
      turnId: event.turnId,
      stopReason: event.status,
      usage: event.usage,
    };
  }

  return null;
}

export function runtimeEventToAgentChatEvent(event: RuntimeEvent): AgentChatEvent | null {
  switch (event.type) {
    case "turn.started":
      return { type: "status", turnStatus: "started", turnId: event.turnId };
    case "content.delta":
      return {
        type: "text",
        text: event.text,
        turnId: event.turnId,
        ...(event.itemId ? { itemId: event.itemId } : {}),
      };
    case "tool.started":
      return {
        type: "tool_call",
        tool: event.toolName,
        args: event.input,
        itemId: event.toolUseId,
        ...(event.parentToolUseId ? { parentItemId: event.parentToolUseId } : {}),
        ...(event.turnId ? { turnId: event.turnId } : {}),
      };
    case "tool.completed":
      return {
        type: "tool_result",
        tool: event.toolName ?? "tool",
        result: event.output,
        itemId: event.toolUseId,
        status: "completed",
        ...(event.turnId ? { turnId: event.turnId } : {}),
      };
    case "tool.failed":
      return {
        type: "tool_result",
        tool: event.toolName ?? "tool",
        result: event.error,
        itemId: event.toolUseId,
        status: "failed",
        ...(event.turnId ? { turnId: event.turnId } : {}),
      };
    case "subagent.started":
      return {
        type: "subagent.started",
        agentId: event.agentId,
        parentToolUseId: event.parentToolUseId ?? null,
        agentType: event.agentType,
        description: event.description,
        background: event.background,
        turnId: event.turnId,
      };
    case "subagent.progress":
      return {
        type: "subagent.progress",
        agentId: event.agentId,
        parentToolUseId: event.parentToolUseId ?? null,
        agentType: event.agentType,
        text: event.text,
        tokens: event.tokens,
        lastToolName: event.lastToolName,
        turnId: event.turnId,
      };
    case "subagent.completed":
      return {
        type: "subagent.completed",
        agentId: event.agentId,
        parentToolUseId: event.parentToolUseId ?? null,
        agentType: event.agentType,
        summary: event.summary,
        status: event.status,
        usage: event.usage,
        turnId: event.turnId,
      };
    case "turn.completed":
      return {
        type: "done",
        turnId: event.turnId,
        status: event.stopReason === "interrupted" || event.stopReason === "failed" ? event.stopReason : "completed",
        usage: event.usage,
      };
    case "compact.boundary":
      return {
        type: "context_compact",
        trigger: event.trigger ?? "auto",
        turnId: event.turnId,
      };
    case "teammate.idle":
    case "task.completed":
      return null;
  }
}

export function buildCanonicalAgentChatRuntimeEvent(event: AgentChatEvent): AgentChatEvent | null {
  if (isCanonicalAgentChatRuntimeEvent(event)) return null;
  const runtimeEvent = agentChatEventToRuntimeEvent(event);
  if (!runtimeEvent) return null;
  if (!runtimeEvent.type.startsWith("subagent.")) return null;
  const canonical = runtimeEventToAgentChatEvent(runtimeEvent);
  if (!canonical || canonical.type === event.type) return null;
  return canonical;
}
