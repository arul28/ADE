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
  premiumRequestCost: number;
  streamedMessages: Set<string>;
  compactionTokens: number | null;
  requestedModel: string | null;
  askedAuto: boolean;
  mismatchModels: Set<string>;
};
export function createCopilotSdkEventMapperState(): CopilotSdkEventMapperState {
  return { toolNames: new Map(), inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0, contextTokens: null, contextWindow: null, servedModel: null, costUsd: null, premiumRequestCost: 0, streamedMessages: new Set(), compactionTokens: null, requestedModel: null, askedAuto: false, mismatchModels: new Set() };
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
      const id = text(data.messageId);
      if (id) state.streamedMessages.add(id);
      return chunk ? [{ type: "text", text: chunk, turnId, itemId: id ?? undefined }] : [];
    }
    case "assistant.message": {
      const content = text(data.content);
      const id = text(data.messageId);
      if (id && state.streamedMessages.has(id)) return [];
      return content ? [{ type: "text", text: content, turnId, itemId: id ?? undefined }] : [];
    }
    case "assistant.reasoning_delta": {
      const chunk = text(data.deltaContent);
      const id = text(data.reasoningId);
      if (id) state.streamedMessages.add(`reasoning:${id}`);
      return chunk ? [{ type: "reasoning", text: chunk, turnId, itemId: id ?? undefined }] : [];
    }
    case "assistant.reasoning": {
      const content = text(data.content) ?? text(data.reasoning);
      const id = text(data.reasoningId);
      if (id && state.streamedMessages.has(`reasoning:${id}`)) return [];
      return content ? [{ type: "reasoning", text: content, turnId, itemId: id ?? undefined }] : [];
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
      const result = record(data.result);
      const error = record(data.error);
      const resultText = text(result?.detailedContent) ?? text(result?.content) ?? text(error?.message) ?? text(data.textOutput) ?? "";
      const out: AgentChatEvent[] = [{ type: "tool_result", tool: start?.name ?? text(data.toolName) ?? "tool", result: resultText, itemId: id, turnId, status: failed ? "failed" : "completed", ...(start?.mcp ? { mcp: start.mcp } : {}) }];
      if (Array.isArray(data.fileEdits)) for (const raw of data.fileEdits) {
        const edit = record(raw); const filePath = text(edit?.path); if (!filePath) continue;
        out.push({ type: "file_change", path: filePath, kind: edit?.kind === "create" ? "create" : edit?.kind === "delete" ? "delete" : "modify", diff: "", itemId: id, turnId, status: "completed" });
      }
      return out;
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
      const copilotUsage = record(usage.copilotUsage);
      const premiumCost = number(copilotUsage?.totalPremiumRequestCost) ?? number(copilotUsage?.premiumRequestCost);
      if (premiumCost != null) state.premiumRequestCost = Math.max(state.premiumRequestCost, premiumCost);
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
      state.compactionTokens = number(data.currentTokens);
      return [{ type: "context_compact", trigger: data.trigger === "manual" ? "manual" : "auto", preTokens: state.compactionTokens ?? undefined, provider: "copilot", state: "started", turnId }];
    case "session.compaction_complete": {
      const preTokens = state.compactionTokens;
      const removed = number(data.tokensRemoved);
      state.compactionTokens = null;
      return [{ type: "context_compact", trigger: data.trigger === "manual" ? "manual" : "auto", preTokens: preTokens ?? undefined, postTokens: preTokens != null && removed != null ? Math.max(0, preTokens - removed) : undefined, provider: "copilot", state: data.success === false ? "failed" : "completed", failReason: data.success === false ? "provider_error" : undefined, turnId }];
    }
    case "session.warning": {
      const message = text(data.message) ?? text(data.reason) ?? "Copilot reported a warning.";
      return [{ type: "system_notice", noticeKind: "warning", severity: "warning", message, turnId }];
    }
    case "session.error":
    case "model.call_failure": {
      const message = text(data.message) ?? text(data.error) ?? text(data.reason) ?? "Copilot reported a runtime error.";
      return [{ type: "error", message, errorInfo: { category: /auth|login|token/i.test(message) ? "auth" : /limit|quota|premium/i.test(message) ? "rate_limit" : /network|connect/i.test(message) ? "network" : "unknown", provider: "copilot", model: state.servedModel ?? undefined }, turnId }];
    }
    case "session.model_change":
    case "session.auto_mode_resolved": {
      const served = type === "session.model_change" ? text(data.newModel) : text(data.chosenModel);
      if (!served) return [];
      state.servedModel = served;
      if (!state.askedAuto && state.requestedModel && state.requestedModel !== served && !state.mismatchModels.has(served)) {
        state.mismatchModels.add(served);
        return [{ type: "system_notice", noticeKind: "warning", severity: "warning", message: `Copilot answered with ${served}, not ${state.requestedModel}.`, turnId }];
      }
      return [];
    }
    case "ade.todos": {
      const rows = record(data)?.rows;
      if (!Array.isArray(rows)) return [];
      return [{ type: "todo_update", items: rows.flatMap((raw, index) => {
        const item = record(raw); const description = text(item?.title) ?? text(item?.description) ?? text(item?.content) ?? text(item?.text);
        if (!description) return [];
        const status = text(item?.status);
        return [{ id: text(item?.id) ?? String(index), description, status: status === "inProgress" || status === "in_progress" ? "in_progress" as const : status === "completed" || status === "done" ? "completed" as const : "pending" as const }];
      }), turnId }];
    }
    case "tool.execution_progress": {
      const id = text(data.toolCallId); const start = id ? state.toolNames.get(id) : undefined;
      const progress = text(data.progressMessage);
      return id && progress ? [{ type: "tool_result", tool: start?.name ?? "tool", result: progress, itemId: id, turnId, status: "running", ...(start?.mcp ? { mcp: start.mcp } : {}) }] : [];
    }
    case "tool.shell_output":
    case "tool.execution_partial_result": {
      const id = text(data.toolCallId); const start = id ? state.toolNames.get(id) : undefined;
      const output = text(data.text) ?? text(data.partialOutput);
      return id && output ? [{ type: "tool_result", tool: start?.name ?? "shell", result: output, itemId: id, turnId, status: "running", ...(start?.mcp ? { mcp: start.mcp } : {}) }] : [];
    }
    case "subagent.started": {
      const id = text(root.agentId) ?? text(data.agentId) ?? text(data.toolCallId);
      if (!id) return [];
      return [{ type: "subagent_started", taskId: id, agentId: id, description: text(data.agentDescription) ?? text(data.agentDisplayName) ?? text(data.agentName) ?? "Copilot subagent", ...(text(data.agentType) ? { agentType: text(data.agentType)! } : {}), ...(text(data.agentDisplayName) ? { label: text(data.agentDisplayName)! } : {}), taskType: "subagent", ...(text(data.toolCallId) ? { parentToolUseId: text(data.toolCallId)! } : {}), turnId }];
    }
    case "subagent.completed":
    case "subagent.failed": {
      const id = text(root.agentId) ?? text(data.agentId) ?? text(data.toolCallId);
      if (!id) return [];
      const failed = type === "subagent.failed";
      return [{ type: "subagent_result", taskId: id, agentId: id, taskType: "subagent", status: failed ? "failed" : data.cancelled === true ? "stopped" : "completed", summary: text(data.error) ?? text(data.agentDisplayName) ?? "Copilot subagent finished.", turnId }];
    }
    case "abort":
      return [{ type: "system_notice", noticeKind: "info", severity: "info", message: "Copilot turn was interrupted.", turnId }];
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
    ...(state.premiumRequestCost > 0 ? { planUsage: [{ unit: "premium_request", amount: state.premiumRequestCost }] } : {}),
  };
}

