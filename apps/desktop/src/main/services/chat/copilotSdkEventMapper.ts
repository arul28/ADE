import type { AgentChatContextUsage, AgentChatEvent } from "../../../shared/types";
import { asRecord as record, finiteNumberOrNull as number } from "../shared/utils";
import { copilotUpdateRequiredMessage } from "./copilotSdkPool";

function text(value: unknown): string | null {
  return typeof value === "string" && value.length ? value : null;
}

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
  premiumRequestCost: number;
  streamedMessages: Set<string>;
  compactionTokens: number | null;
  requestedModel: string | null;
  askedAuto: boolean;
  mismatchModels: Set<string>;
  /** The root agent's `session.error` this turn, which makes the turn fail. */
  turnError: string | null;
  /**
   * A rate-limit error Copilot follows with an auto-mode-switch prompt. It is
   * shown only if the user declines the switch (see onAutoModeSwitchRequest).
   */
  heldRateLimitError: Extract<AgentChatEvent, { type: "error" }> | null;
  /** MCP servers whose failure this chat already showed. Kept across turns. */
  failedMcpServers: Set<string>;
};
export function createCopilotSdkEventMapperState(): CopilotSdkEventMapperState {
  return {
    toolNames: new Map(),
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
    contextTokens: null,
    contextWindow: null,
    servedModel: null,
    premiumRequestCost: 0,
    streamedMessages: new Set(),
    compactionTokens: null,
    requestedModel: null,
    askedAuto: false,
    mismatchModels: new Set(),
    turnError: null,
    heldRateLimitError: null,
    failedMcpServers: new Set(),
  };
}

type CopilotErrorCategory = "auth" | "rate_limit" | "budget" | "network" | "unknown";

/**
 * ADE's error category from Copilot's typed `errorType` ("authentication",
 * "authorization", "policy", "quota", "rate_limit", "context_limit", "query",
 * …), its finer `errorCode` and the HTTP status. Only a rate limit arms the
 * usage-limit resume; an exhausted quota waits for a billing change, not a
 * timer. A 5xx or a timeout is the service's, so it reads as a connection
 * problem the person can retry, not as a fault in the chat.
 */
function classifyCopilotError(errorType: string | null, errorCode: string | null, statusCode: number | null): CopilotErrorCategory {
  switch (errorType) {
    case "authentication":
    case "authorization":
      return "auth";
    case "rate_limit":
      return "rate_limit";
    case "quota":
      return "budget";
    case "network":
    case "connection":
      return "network";
  }
  if (errorCode && /rate_limit/.test(errorCode)) return "rate_limit";
  if (errorCode && /quota|billing/.test(errorCode)) return "budget";
  if (statusCode === 401) return "auth";
  if (statusCode === 429) return "rate_limit";
  if (statusCode === 408 || (statusCode != null && statusCode >= 500)) return "network";
  return "unknown";
}

/**
 * The diagnostics a `session.error` carries beyond its message: the HTTP
 * status, the provider's error type, parameter and code, and the two request
 * ids GitHub traces a failure by (`x-github-request-id` and
 * `x-copilot-service-request-id`). Without them every failed request reads the
 * same, and nobody can tell a schema rejection from an overload or a policy.
 */
export function copilotErrorDiagnostics(data: Record<string, unknown>): string | null {
  const status = number(data.statusCode);
  const providerType = text(data.providerErrorType);
  const param = text(data.providerErrorParam);
  const code = text(data.errorCode);
  const parts = [
    status != null ? `HTTP ${status}` : null,
    providerType ? `${providerType}${param ? ` (${param})` : ""}` : null,
    code && code !== providerType ? `code ${code}` : null,
    text(data.errorType) && text(data.errorType) !== "query" ? `type ${text(data.errorType)}` : null,
  ].filter(Boolean);
  const ids = [
    text(data.providerCallId) ? `GitHub request ${text(data.providerCallId)}` : null,
    text(data.serviceRequestId) ? `Copilot request ${text(data.serviceRequestId)}` : null,
  ].filter(Boolean);
  const lines = [parts.join(" · "), ids.join(" · ")].filter(Boolean);
  return lines.length ? lines.join("\n") : null;
}

/**
 * The part of a tool's detailed result that is one file's unified diff.
 * Copilot keeps the edit tools' diffs in `result.detailedContent`; an edit
 * that touched several files carries one `diff --git` section per file.
 */
function fileEditDiff(detailed: string | null, filePath: string, editCount: number): string {
  if (!detailed || !/^@@ |^diff --git |^--- /m.test(detailed)) return "";
  if (editCount === 1) return detailed.replace(/^\n+/, "");
  const sections = detailed.split(/^(?=diff --git )/m);
  const normalized = filePath.replace(/\\/g, "/");
  return sections.find((section) => {
    const header = section.split("\n", 1)[0] ?? "";
    const target = header.match(/ b\/(.+)$/)?.[1];
    // Whole path segments only: `b/a.ts` must not take `b/src/a.ts`'s section.
    return Boolean(target && (normalized === target || normalized.endsWith(`/${target}`)));
  }) ?? "";
}

/**
 * One notice per served model that is not the one the chat picked (never for
 * Auto). `cause` is Copilot's reason for a switch it made itself; without one,
 * the likely reason is the plan.
 */
function servedModelNotice(state: CopilotSdkEventMapperState, served: string | null, turnId: string, cause?: string | null): AgentChatEvent[] {
  if (!served) return [];
  state.servedModel = served;
  if (state.askedAuto || !state.requestedModel || state.requestedModel === served || state.mismatchModels.has(served)) return [];
  state.mismatchModels.add(served);
  const why = cause === "rate_limit_auto_switch" ? "after a rate limit"
    : cause === "refusal_fallback" ? `because ${state.requestedModel} declined the request`
      : "(your plan may not include it)";
  const message = cause === "rate_limit_auto_switch" || cause === "refusal_fallback"
    ? `Copilot switched to ${served} ${why}`
    : `Copilot used ${served}, not ${state.requestedModel} ${why}`;
  // `model_switched` stays visible outside the turn fold: the composer names a
  // model that did not write this reply.
  return [{ type: "system_notice", noticeKind: "info", status: "model_switched", message, turnId }];
}

/** What to do about a `session.error`, by its `remediation`. */
const COPILOT_REMEDIATIONS: Record<string, string> = {
  sign_in: "Sign in again with `copilot login` or `gh auth login`, then retry.",
  switch_account: "Sign in with a GitHub account that has access to this, then retry.",
  show_account: "Check which GitHub account Copilot is signed in with.",
  review_sandbox_policy: "Review Copilot's sandbox policy for the blocked path or host.",
  allow_sandbox_outbound: "Allow outbound network access in Copilot's sandbox policy.",
  rewind_conversation: "Rewind the chat to before the blocked request, then continue.",
};

/** `session.info` kinds ADE does not show. */
const COPILOT_QUIET_INFO_TYPES = new Set(["cancellation", "timing", "snapshot", "mcp"]);

/** Events a sub-agent sends on the parent stream that only the root agent's state may see. */
const ROOT_ONLY_EVENTS = new Set([
  "assistant.message_delta",
  "assistant.message",
  "assistant.reasoning_delta",
  "assistant.reasoning",
  "session.model_change",
  "session.auto_mode_resolved",
  "session.usage_info",
  "session.error",
  "session.info",
  "abort",
]);

export function mapCopilotSdkEvent(event: unknown, args: { turnId: string; state: CopilotSdkEventMapperState }): AgentChatEvent[] {
  const root = record(event);
  const data = record(root?.data) ?? {};
  if (!root) return [];
  const type = text(root.type);
  const turnId = args.turnId;
  const state = args.state;
  // Sub-agent events share the parent stream and carry an envelope `agentId`;
  // root events omit it. A sub-agent's text, model and context are not the
  // reply's: its own card shows its start and result, and its tool calls
  // still render, but nothing else of it reaches the main turn.
  const subagentId = text(root.agentId);
  if (subagentId && type && ROOT_ONLY_EVENTS.has(type)) return [];
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
      // Each reply names the model that wrote it. Auto's own resolution event
      // can arrive while the session reopens, before any turn is listening.
      const notice = servedModelNotice(state, text(data.model), turnId);
      if (id && state.streamedMessages.has(id)) return notice;
      return content ? [...notice, { type: "text", text: content, turnId, itemId: id ?? undefined }] : notice;
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
      const edits = Array.isArray(data.fileEdits) ? data.fileEdits : [];
      for (const raw of edits) {
        const edit = record(raw); const filePath = text(edit?.path); if (!filePath) continue;
        const diff = fileEditDiff(text(result?.detailedContent), filePath, edits.length);
        out.push({ type: "file_change", path: filePath, kind: edit?.kind === "create" ? "create" : edit?.kind === "delete" ? "delete" : "modify", diff, itemId: id, turnId, status: "completed" });
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
      // Sub-agent calls cost tokens too, but their prompt is not the chat's
      // context and their model did not write the reply. Premium requests
      // come from the account metrics read around the turn.
      if (!subagentId) {
        state.contextTokens = number(usage.inputTokens) ?? state.contextTokens;
        state.servedModel = text(usage.model) ?? state.servedModel;
      }
      return [];
    }
    case "session.usage_info": {
      const current = number(data.currentTokens);
      const limit = number(data.tokenLimit);
      if (current == null || limit == null || limit <= 0) return [];
      state.contextTokens = current;
      state.contextWindow = limit;
      const percent = (tokens: number) => Math.min(100, Math.max(0, tokens / limit * 100));
      const categories = ([["System", data.systemTokens], ["Tools", data.toolDefinitionsTokens], ["Conversation", data.conversationTokens]] as const)
        .flatMap(([name, value]) => {
          const tokens = number(value);
          return tokens != null && tokens > 0 ? [{ name, tokens, percentage: percent(tokens) }] : [];
        });
      const usage: AgentChatContextUsage = { categories, totalTokens: current, maxTokens: limit, percentage: percent(current), ...(state.servedModel ? { model: state.servedModel } : {}) };
      return [{ type: "context_usage", usage, origin: "live", state: "measured", turnId }];
    }
    case "session.compaction_start":
      state.compactionTokens = number(data.currentTokens);
      return [{ type: "context_compact", trigger: data.trigger === "manual" ? "manual" : "auto", preTokens: state.compactionTokens ?? undefined, provider: "copilot", state: "started", turnId }];
    case "session.compaction_complete": {
      const preTokens = number(data.preCompactionTokens) ?? state.compactionTokens;
      const removed = number(data.tokensRemoved);
      const postTokens = number(data.postCompactionTokens) ?? (preTokens != null && removed != null ? Math.max(0, preTokens - removed) : null);
      state.compactionTokens = null;
      const failed = data.success === false;
      const compact: AgentChatEvent = { type: "context_compact", trigger: data.trigger === "manual" ? "manual" : "auto", preTokens: preTokens ?? undefined, postTokens: postTokens ?? undefined, provider: "copilot", state: failed ? "failed" : "completed", failReason: failed ? "provider_error" : undefined, turnId };
      const reason = failed ? text(data.error) : null;
      return reason ? [compact, { type: "system_notice", noticeKind: "warning", severity: "warning", message: `Copilot could not compact the conversation: ${reason}`, turnId }] : [compact];
    }
    case "session.mcp_server_status_changed": {
      // A server that fails to start shows once per chat, as the CLI's /env
      // does; otherwise its tools are just missing and nothing says why.
      const name = text(data.serverName);
      if (!name || text(data.status) !== "failed" || state.failedMcpServers.has(name)) return [];
      state.failedMcpServers.add(name);
      const reason = text(data.error)?.split("\n", 1)[0]?.slice(0, 240);
      return [{ type: "system_notice", noticeKind: "warning", severity: "warning", message: `Copilot could not start the MCP server ${name}${reason ? `: ${reason}` : "."}`, turnId }];
    }
    case "session.info": {
      // Copilot's own status lines (a retry, a model or sign-in note). A
      // cancellation is already the turn's interrupted state, MCP failures
      // come from their status event, and timing and snapshot lines are noise.
      const message = text(data.message);
      if (!message || COPILOT_QUIET_INFO_TYPES.has(text(data.infoType) ?? "")) return [];
      const tip = text(data.tip);
      return [{ type: "system_notice", noticeKind: "info", message: tip ? `${message} ${tip}` : message, turnId }];
    }
    case "session.warning": {
      const message = text(data.message) ?? text(data.reason) ?? "Copilot reported a warning.";
      return [{ type: "system_notice", noticeKind: "warning", severity: "warning", message, turnId }];
    }
    case "session.error": {
      // An organisation policy that needs a newer Copilot gets precise words.
      const message = copilotUpdateRequiredMessage(data) ?? text(data.message) ?? "Copilot reported a runtime error.";
      const remediation = COPILOT_REMEDIATIONS[text(data.remediation) ?? ""] ?? null;
      const detail = [remediation, text(data.url), copilotErrorDiagnostics(data)].filter(Boolean).join("\n");
      const error: Extract<AgentChatEvent, { type: "error" }> = {
        type: "error", message, ...(detail ? { detail } : {}),
        errorInfo: {
          category: classifyCopilotError(text(data.errorType), text(data.errorCode), number(data.statusCode)),
          provider: "copilot",
          model: state.servedModel ?? undefined,
        },
        turnId,
      };
      // Copilot follows an eligible rate limit with an offer to continue on
      // Auto; the error waits for that answer instead of arming a resume, and
      // fails the turn only if the user declines.
      if (data.eligibleForAutoSwitch === true) {
        state.heldRateLimitError = error;
        return [];
      }
      state.turnError = message;
      return [error];
    }
    // `model.call_failure` is per-attempt telemetry: it fires for retries that
    // recover and for sub-agent calls. A failure that ends the turn arrives as
    // `session.error`.
    case "session.model_change":
    case "session.auto_mode_resolved": {
      return servedModelNotice(state, type === "session.model_change" ? text(data.newModel) : text(data.chosenModel), turnId, type === "session.model_change" ? text(data.cause) : null);
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

