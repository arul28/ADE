import { randomUUID } from "node:crypto";
import type { AgentChatEvent } from "../../../shared/types/chat";

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
