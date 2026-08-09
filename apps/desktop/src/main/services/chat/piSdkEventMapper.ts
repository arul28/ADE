import { randomUUID } from "node:crypto";
import type { AgentChatApprovalDecision, AgentChatEvent, PendingInputRequest } from "../../../shared/types/chat";
import type { PiSdkExtensionInfo, PiSdkUiNoticePayload, PiSdkUiRequestPayload, PiSdkUiResponsePayload } from "./piSdkProtocol";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Translate untrusted Pi SDK events into ADE's durable chat event contract. */
export function mapPiSdkEventToChatEvents(
  event: unknown,
  turnId?: string,
  compactionId?: string | null,
): AgentChatEvent[] {
  const record = asRecord(event);
  if (!record) return [];
  const type = typeof record.type === "string" ? record.type : "";
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
    return [{
      type: "context_compact",
      trigger: record.reason === "manual" ? "manual" : "auto",
      provider: "pi",
      state: type === "compaction_start" ? "started" : "completed",
      ...(compactionId ? { compactionId } : {}),
      ...(turnId ? { turnId } : {}),
    }];
  }
  if (type === "auto_retry_start") {
    return [{
      type: "activity",
      activity: "working",
      detail: typeof record.errorMessage === "string" ? record.errorMessage : "Pi is retrying the provider request.",
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
