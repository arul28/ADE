import type { AgentChatEvent } from "../../../desktop/src/shared/types/chat";

function textField(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function workEventItemId(event: AgentChatEvent): string | null {
  if (event.type !== "tool_call" && event.type !== "tool_result" && event.type !== "command" && event.type !== "file_change") {
    return null;
  }
  return textField(event.itemId);
}

export function workEventParentItemId(event: AgentChatEvent): string | null {
  if (event.type !== "tool_call" && event.type !== "tool_result") {
    return null;
  }
  return textField(event.parentItemId);
}
