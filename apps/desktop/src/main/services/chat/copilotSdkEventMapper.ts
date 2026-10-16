import type { AgentChatContextUsage, AgentChatEvent } from "../../../shared/types";

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
}
function text(value: unknown): string | null { return typeof value === "string" && value.length ? value : null; }
function number(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }

export type CopilotSdkEventMapperState = {
  toolNames: Map<string, { name: string; args: unknown; mcp?: { server: string; tool: string } }>;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  contextTokens: number | null;
  contextWindow: number | null;
  servedModel: string | null;
  costUsd: number | null;
};
export function createCopilotSdkEventMapperState(): CopilotSdkEventMapperState {
  return { toolNames: new Map(), inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0, contextTokens: null, contextWindow: null, servedModel: null, costUsd: null };
}

export function mapCopilotSdkEvent(event: unknown, args: { turnId: string; state: CopilotSdkEventMapperState }): AgentChatEvent[] {
  const root = record(event);
  const data = record(root?.data) ?? {};
  if (!root) return [];
  const type = text(root.type);
  const turnId = args.turnId;
  const state = args.state;
  switch (type) {
    case "assistant.message_delta": {
      const chunk = text(data.deltaContent);
      return chunk ? [{ type: "text", text: chunk, turnId, itemId: text(data.messageId) ?? undefined }] : [];
    }
    case "assistant.message": {
      const content = text(data.content);
      return content ? [{ type: "text", text: content, turnId, itemId: text(data.messageId) ?? undefined }] : [];
    }
    case "assistant.reasoning_delta": {
      const chunk = text(data.deltaContent);
      return chunk ? [{ type: "reasoning", text: chunk, turnId, itemId: text(data.reasoningId) ?? undefined }] : [];
    }
    case "assistant.reasoning": {
      const content = text(data.content) ?? text(data.reasoning);
      return content ? [{ type: "reasoning", text: content, turnId, itemId: text(data.reasoningId) ?? undefined }] : [];
    }
    case "tool.execution_start": {
      const id = text(data.toolCallId);
      const name = text(data.toolName) ?? "tool";
      const server = text(data.mcpServerName);
      const tool = text(data.mcpToolName);
      if (!id) return [];
      state.toolNames.set(id, { name: server && tool ? `${server}:${tool}` : name, args: data.arguments ?? {}, ...(server && tool ? { mcp: { server, tool } } : {}) });
      return [{ type: "tool_call", tool: server && tool ? `${server}:${tool}` : name, args: data.arguments ?? {}, itemId: id, turnId, ...(server && tool ? { mcp: { server, tool } } : {}) }];
    }
    case "tool.execution_complete": {
      const id = text(data.toolCallId);
      if (!id) return [];
      const start = state.toolNames.get(id);
      state.toolNames.delete(id);
      const failed = data.success === false || text(data.status) === "failed";
      const result = data.result ?? data.error ?? data.textOutput ?? "";
      return [{ type: "tool_result", tool: start?.name ?? text(data.toolName) ?? "tool", result, itemId: id, turnId, status: failed ? "failed" : "completed", ...(start?.mcp ? { mcp: start.mcp } : {}) }];
    }
    case "assistant.usage": {
      const usage = record(data) ?? {};
      state.inputTokens += number(usage.inputTokens) ?? 0;
      state.outputTokens += number(usage.outputTokens) ?? 0;
      state.cacheReadTokens += number(usage.cacheReadTokens) ?? 0;
      state.cacheCreationTokens += number(usage.cacheWriteTokens) ?? 0;
      state.reasoningTokens += number(usage.reasoningTokens) ?? 0;
      state.contextTokens = number(usage.inputTokens) ?? state.contextTokens;
      state.servedModel = text(usage.model) ?? state.servedModel;
      state.costUsd = number(usage.cost) ?? state.costUsd;
      return [];
    }
    case "session.usage_info": {
      const current = number(data.currentTokens);
      const limit = number(data.tokenLimit);
      if (current == null || limit == null || limit <= 0) return [];
      state.contextTokens = current;
      state.contextWindow = limit;
      const usage: AgentChatContextUsage = { categories: [], totalTokens: current, maxTokens: limit, percentage: Math.min(100, Math.max(0, current / limit * 100)), ...(state.servedModel ? { model: state.servedModel } : {}) };
      return [{ type: "context_usage", usage, origin: "live", state: "measured", turnId }];
    }
    case "session.compaction_start":
      return [{ type: "context_compact", trigger: data.trigger === "manual" ? "manual" : "auto", preTokens: number(data.currentTokens) ?? undefined, provider: "copilot", state: "started", turnId }];
    case "session.compaction_complete":
      return [{ type: "context_compact", trigger: data.trigger === "manual" ? "manual" : "auto", preTokens: number(data.tokensBefore) ?? undefined, postTokens: number(data.tokensAfter) ?? undefined, provider: "copilot", state: data.success === false ? "failed" : "completed", failReason: data.success === false ? "provider_error" : undefined, turnId }];
    case "session.error":
    case "model.call_failure":
    case "session.warning": {
      const message = text(data.message) ?? text(data.error) ?? text(data.reason) ?? "Copilot reported a runtime error.";
      return [{ type: "error", message, errorInfo: { category: /auth|login|token/i.test(message) ? "auth" : /limit|quota|premium/i.test(message) ? "rate_limit" : /network|connect/i.test(message) ? "network" : "unknown", provider: "copilot", model: state.servedModel ?? undefined }, turnId }];
    }
    default:
      return [];
  }
}

export function copilotSdkDoneUsage(state: CopilotSdkEventMapperState): NonNullable<Extract<AgentChatEvent, { type: "done" }>['usage']> {
  return {
    inputTokens: state.inputTokens || undefined,
    outputTokens: state.outputTokens || undefined,
    cacheReadTokens: state.cacheReadTokens || undefined,
    cacheCreationTokens: state.cacheCreationTokens || undefined,
    reasoningTokens: state.reasoningTokens || undefined,
    contextTokens: state.contextTokens ?? undefined,
    contextWindow: state.contextWindow ?? undefined,
  };
}

