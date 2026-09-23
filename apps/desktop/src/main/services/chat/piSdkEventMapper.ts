import { randomUUID } from "node:crypto";
import type { AgentChatApprovalDecision, AgentChatEvent, PendingInputRequest } from "../../../shared/types/chat";
import {
  classifyProviderRetryCause,
  formatProviderRetryActivityDetail,
} from "../../../shared/providerRetryPresentation";
import {
  isPiSdkAccount,
  type PiSdkAccount,
  type PiSdkExtensionInfo,
  type PiSdkUiNoticePayload,
  type PiSdkUiRequestPayload,
  type PiSdkUiResponsePayload,
} from "./piSdkProtocol";
import { finiteNumberOrNull, toOptionalString } from "../shared/utils";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function addUsageValue(
  usage: PiSdkEventMapperState["usage"],
  key: "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheCreationTokens" | "cacheWrite1hTokens" | "reasoningTokens" | "costUsd",
  value: number | null,
): void {
  if (value == null) return;
  usage[key] = (usage[key] ?? 0) + value;
}

function readAccount(value: unknown): PiSdkAccount | null {
  if (!isPiSdkAccount(value)) return null;
  const accountId = toOptionalString(value.accountId);
  return {
    kind: value.kind,
    upstream: value.upstream.trim(),
    ...(accountId ? { accountId } : {}),
  };
}

export type PiSdkTurnUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  cacheWrite1hTokens?: number;
  reasoningTokens?: number;
  contextTokens?: number;
  requestCount: number;
  costUsd?: number;
};

/** What one turn's events told the mapper; the done event reads it. */
export type PiSdkEventMapperState = {
  usage: PiSdkTurnUsage;
  servedModel?: string;
  provider?: string;
  account?: PiSdkAccount;
};

export function createPiSdkEventMapperState(): PiSdkEventMapperState {
  return { usage: { requestCount: 0 } };
}

/** Clears the state before the next prompt. */
export function resetPiSdkEventMapperTurn(state: PiSdkEventMapperState): void {
  state.usage = { requestCount: 0 };
  state.servedModel = undefined;
  state.provider = undefined;
  state.account = undefined;
}

function mapAssistantMessageEnd(
  message: Record<string, unknown>,
  turnId: string | undefined,
  state: PiSdkEventMapperState,
): AgentChatEvent[] {
  state.usage.requestCount += 1;
  const usage = asRecord(message.usage);
  const inputTokens = finiteNumberOrNull(usage?.input);
  const outputTokens = finiteNumberOrNull(usage?.output);
  const cacheReadTokens = finiteNumberOrNull(usage?.cacheRead);
  const cacheWriteTokens = finiteNumberOrNull(usage?.cacheWrite);
  const reasoningTokens = finiteNumberOrNull(usage?.reasoning);
  addUsageValue(state.usage, "inputTokens", inputTokens);
  addUsageValue(state.usage, "outputTokens", outputTokens);
  addUsageValue(state.usage, "cacheReadTokens", cacheReadTokens);
  addUsageValue(state.usage, "cacheCreationTokens", cacheWriteTokens);
  addUsageValue(state.usage, "cacheWrite1hTokens", finiteNumberOrNull(usage?.cacheWrite1h));
  addUsageValue(state.usage, "reasoningTokens", reasoningTokens);
  addUsageValue(state.usage, "costUsd", finiteNumberOrNull(asRecord(usage?.cost)?.total));
  state.usage.contextTokens = inputTokens != null || cacheReadTokens != null || cacheWriteTokens != null
    ? (inputTokens ?? 0) + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0)
    : undefined;
  const provider = toOptionalString(message.provider);
  const servedModel = toOptionalString(message.responseModel) ?? toOptionalString(message.model);
  if (provider) state.provider = provider;
  if (servedModel) state.servedModel = servedModel;
  const account = readAccount(message.account);
  if (account) state.account = account;
  if (!turnId) return [];

  return [{
    type: "tokens",
    turnId,
    ...(toOptionalString(message.responseId) ? { itemId: toOptionalString(message.responseId)! } : {}),
    ...(inputTokens != null ? { inputTokens } : {}),
    ...(outputTokens != null ? { outputTokens } : {}),
    ...(cacheReadTokens != null ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens != null ? { cacheWriteTokens } : {}),
    ...(reasoningTokens != null ? { reasoningTokens } : {}),
  }];
}

/** Translate untrusted Pi SDK events into ADE's durable chat event contract. */
export function mapPiSdkEventToChatEvents(
  event: unknown,
  turnId: string | undefined,
  compactionId: string | null | undefined,
  state: PiSdkEventMapperState,
): AgentChatEvent[] {
  const record = asRecord(event);
  if (!record) return [];
  const type = typeof record.type === "string" ? record.type : "";
  if (type === "message_end") {
    const message = asRecord(record.message);
    return message?.role === "assistant" ? mapAssistantMessageEnd(message, turnId, state) : [];
  }
  if (type === "message_update") {
    const assistant = asRecord(record.assistantMessageEvent);
    if (!assistant) return [];
    if (assistant.type === "text_delta" && typeof assistant.delta === "string" && assistant.delta.length) {
      return [{ type: "text", text: assistant.delta, turnId }];
    }
    if (assistant.type === "thinking_delta" && typeof assistant.delta === "string" && assistant.delta.length) {
      return [{ type: "reasoning", text: assistant.delta, turnId }];
    }
    if (assistant.type === "error") {
      const message = typeof assistant.errorMessage === "string" && assistant.errorMessage.trim()
        ? assistant.errorMessage.trim()
        : "Pi reported an assistant error.";
      return [{ type: "error", message, turnId }];
    }
    return [];
  }
  if (type === "tool_execution_start") {
    return [{
      type: "tool_call",
      tool: typeof record.toolName === "string" ? record.toolName : "pi_tool",
      args: record.args ?? {},
      itemId: typeof record.toolCallId === "string" && record.toolCallId.length ? record.toolCallId : randomUUID(),
      turnId,
    }];
  }
  if (type === "tool_execution_end") {
    const toolId = typeof record.toolCallId === "string" && record.toolCallId.length ? record.toolCallId : randomUUID();
    const failed = record.isError === true;
    return [{
      type: "tool_result",
      tool: typeof record.toolName === "string" ? record.toolName : "pi_tool",
      result: record.result ?? (failed ? "Pi tool failed." : ""),
      itemId: toolId,
      status: failed ? "failed" : "completed",
      turnId,
    }];
  }
  if (type === "bash_execution_update" && typeof record.delta === "string" && record.delta.length) {
    return [{ type: "activity", activity: "running_command", detail: record.delta, turnId }];
  }
  if (type === "compaction_start" || type === "compaction_end") {
    // The session's compaction count is the shared emitter's to keep.
    const completed = type === "compaction_end";
    const result = asRecord(record.result);
    return [{
      type: "context_compact",
      trigger: record.reason === "manual" ? "manual" : "auto",
      provider: "pi",
      state: completed ? "completed" : "started",
      ...(compactionId ? { compactionId } : {}),
      ...(turnId ? { turnId } : {}),
      ...(completed && finiteNumberOrNull(result?.tokensBefore) != null ? { preTokens: finiteNumberOrNull(result?.tokensBefore)! } : {}),
      ...(completed && finiteNumberOrNull(result?.estimatedTokensAfter) != null ? { postTokens: finiteNumberOrNull(result?.estimatedTokensAfter)! } : {}),
    }];
  }
  if (type === "auto_retry_start") {
    const errorMessage = typeof record.errorMessage === "string" ? record.errorMessage : "Pi is retrying the provider request.";
    const attempt = typeof record.attempt === "number"
      ? record.attempt
      : typeof record.retryAttempt === "number" ? record.retryAttempt : null;
    const maxAttempts = typeof record.maxAttempts === "number"
      ? record.maxAttempts
      : typeof record.maxRetries === "number"
        ? record.maxRetries
        : typeof record.max_retries === "number" ? record.max_retries : null;
    const retryDelayMs = typeof record.retryDelayMs === "number"
      ? record.retryDelayMs
      : typeof record.retry_delay_ms === "number"
        ? record.retry_delay_ms
        : typeof record.delayMs === "number" ? record.delayMs : null;
    return [{
      type: "activity",
      activity: "working",
      providerRetry: true,
      detail: formatProviderRetryActivityDetail({
        provider: "pi",
        attempt,
        maxAttempts,
        retryDelayMs,
        cause: classifyProviderRetryCause(errorMessage),
      }),
      ...(turnId ? { turnId } : {}),
    }];
  }
  if (type === "session_info_changed") {
    const name = typeof record.name === "string" ? record.name.trim() : "";
    return name ? [{ type: "system_notice", noticeKind: "info", message: `Pi session renamed to ${name}.`, turnId }] : [];
  }
  return [];
}

/**
 * What `done.servedModel` reports for a Pi turn: the route that answered, when
 * it is not the one ADE asked for, else undefined.
 *
 * A Pi route is provider + model. The same model id from two providers is two
 * different paid routes, so a provider change alone counts, and is reported
 * with its provider (`openrouter/gpt-5`). A model change within the requested
 * provider is reported as the model id, as before.
 */
function piServedRoute(args: {
  requestedProvider: string | null;
  requestedModel: string | null;
  servedProvider: string | null;
  servedModel: string | null;
}): string | undefined {
  const { requestedProvider, requestedModel, servedProvider, servedModel } = args;
  if (servedProvider && requestedProvider && servedProvider !== requestedProvider) {
    const model = servedModel ?? requestedModel;
    return model ? `${servedProvider}/${model}` : servedProvider;
  }
  return servedModel && requestedModel && servedModel !== requestedModel ? servedModel : undefined;
}

export function mapPiSdkRunResultToDoneEvent(meta: {
  turnId: string;
  model: string;
  modelId?: string;
  requestedModel?: string | null;
  provider?: string | null;
  account?: PiSdkAccount | null;
  state: PiSdkEventMapperState;
  status: "completed" | "interrupted" | "failed";
}): Extract<AgentChatEvent, { type: "done" }> {
  // A copy: the live state keeps accumulating until the next reset, and the
  // cost rides on `done.costUsd`, never inside `usage`.
  const { costUsd, ...usage } = meta.state.usage;
  const upstream = meta.state.provider ?? meta.provider ?? meta.account?.upstream ?? null;
  // The account the turn's own events named wins over the one the worker
  // reported at start; either counts only when it is for the upstream that ran.
  const matched = upstream
    ? [meta.state.account, meta.account].find((candidate) => candidate?.upstream === upstream)
    : undefined;
  const account = upstream
    ? {
        provider: "pi",
        kind: matched?.kind ?? "unknown" as const,
        upstream,
        ...(upstream === "openai-codex" && matched?.accountId ? { accountId: matched.accountId } : {}),
      }
    : undefined;
  const servedModel = piServedRoute({
    requestedProvider: meta.provider?.trim() || null,
    requestedModel: meta.requestedModel?.trim() || null,
    servedProvider: meta.state.provider ?? null,
    servedModel: meta.state.servedModel ?? null,
  });
  const hasUsage = usage.requestCount > 0 || Object.keys(usage).some((key) => key !== "requestCount");
  return {
    type: "done",
    turnId: meta.turnId,
    status: meta.status,
    model: meta.model,
    ...(meta.modelId ? { modelId: meta.modelId } : {}),
    ...(hasUsage ? { usage } : {}),
    ...(costUsd != null ? { costUsd, costSource: "list_price" as const } : {}),
    ...(servedModel ? { servedModel } : {}),
    ...(account ? { account } : {}),
  };
}

/**
 * Render a non-blocking message from a Pi tool or extension.
 *
 * Sign-in notices never arrive here: login runs on `piAuthService`'s own
 * worker and is rendered by Settings, not by a chat.
 */
export function piUiNoticeToChatEvents(
  payload: PiSdkUiNoticePayload,
  turnId?: string,
): AgentChatEvent[] {
  const message = payload.message.trim();
  if (!message) return [];

  if (payload.level === "progress") {
    return [{ type: "activity", activity: "working", detail: message, ...(turnId ? { turnId } : {}) }];
  }
  return [{
    type: "system_notice",
    noticeKind: payload.level === "info" ? "info" : "warning",
    message,
    ...(turnId ? { turnId } : {}),
  }];
}

/**
 * One-time summary of which Pi extensions loaded into this chat and what the
 * UI bridge cannot render, so a missing terminal widget reads as a known
 * limitation rather than a broken extension.
 */
export function piExtensionLoadNotice(
  extensions: PiSdkExtensionInfo[] | undefined,
  extensionsError: string | null | undefined,
  ungateableTools: string[] = [],
): AgentChatEvent[] {
  const events: AgentChatEvent[] = [];
  if (ungateableTools.length) {
    const list = ungateableTools.join(", ");
    events.push({
      type: "system_notice",
      noticeKind: "warning",
      message: `This Pi build cannot ask before running ${list}, so ${ungateableTools.length === 1 ? "it is" : "they are"} unavailable in this chat.`,
    });
  }
  if (extensions?.length) {
    const names = extensions.map((extension) => extension.name?.trim() || extension.id);
    events.push({
      type: "system_notice",
      noticeKind: "info",
      // Extensions only load in modes that grant their tools outright, but an
      // extension's own tools are still outside this chat's allowlist, so say
      // so rather than implying they are bounded by it.
      message: `Pi extensions active: ${names.join(", ")}. Their own tools aren't limited to this chat's tool list.`,
    });
  }
  if (extensionsError?.trim()) {
    events.push({
      type: "system_notice",
      noticeKind: "warning",
      message: `Some Pi extensions did not load: ${extensionsError.trim()}`,
    });
  }
  return events;
}

/** The single question id every Pi card uses; answers come back keyed by it. */
export const PI_UI_ANSWER_ID = "answer";

/** Values `createPiApprovalGate` recognizes; shared so the two cannot drift. */
export const PI_APPROVAL_ALLOW = "allow";
export const PI_APPROVAL_ALLOW_SESSION = "allow_session";

/** Turn a blocking worker request into the ADE card that answers it. */
export function piUiRequestToPendingInput(
  requestId: string,
  payload: PiSdkUiRequestPayload,
  turnId: string | null,
): PendingInputRequest {
  const options = payload.options?.map((option) => ({
    label: option.label,
    value: option.value,
    ...(option.description ? { description: option.description } : {}),
  }));
  const hasOptions = Boolean(options?.length);
  return {
    requestId,
    itemId: requestId,
    source: "pi",
    kind: payload.origin === "approval"
      ? "approval"
      : hasOptions ? "structured_question" : "question",
    title: payload.title ?? null,
    description: payload.message,
    questions: [{
      id: PI_UI_ANSWER_ID,
      ...(payload.title ? { header: payload.title } : {}),
      question: payload.message,
      ...(hasOptions ? { options } : {}),
      // A choice must be answered by picking: free text would not match an
      // option id, which is what Pi expects back.
      allowsFreeform: !hasOptions,
      ...(payload.kind === "secret" ? { isSecret: true } : {}),
      ...(payload.defaultValue != null ? { defaultAssumption: payload.defaultValue } : {}),
    }],
    allowsFreeform: !hasOptions,
    blocking: true,
    canProceedWithoutAnswer: false,
    providerMetadata: {
      pi: true,
      origin: payload.origin,
      promptKind: payload.kind,
      ...(payload.sourceId ? { sourceId: payload.sourceId } : {}),
    },
    turnId,
  };
}

/** Translate the user's card answer into the reply the worker is waiting on. */
export function piUiResponseFromAnswer(
  payload: PiSdkUiRequestPayload,
  response: {
    decision?: AgentChatApprovalDecision;
    answers?: Record<string, string | string[]>;
    responseText?: string | null;
  },
): PiSdkUiResponsePayload {
  if (response.decision === "cancel" || response.decision === "decline") return { ok: false };
  const raw = response.answers?.[PI_UI_ANSWER_ID];
  const picked = Array.isArray(raw) ? raw[0] : raw;
  const value = typeof picked === "string" && picked.length
    ? picked
    : typeof response.responseText === "string" ? response.responseText : "";
  if (payload.origin !== "approval") return { ok: true, value };
  // An approval card carries its verdict in the decision, not in text — a
  // surface that attaches a comment to an accept must still read as an allow
  // rather than as an unrecognized value the gate would deny.
  if (response.decision === "accept_for_session") return { ok: true, value: PI_APPROVAL_ALLOW_SESSION };
  if (response.decision === "accept") return { ok: true, value: PI_APPROVAL_ALLOW };
  return value ? { ok: true, value } : { ok: false };
}
