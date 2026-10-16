import type { AgentChatContextAttachment } from "../../shared/types";
import { normalizeChatContextAttachments } from "../../shared/chatContextAttachments";

/**
 * Dragging an issue onto the chat composer attaches it as context.
 *
 * The payload is the context attachment itself, so the composer adds exactly
 * what "Attach to chat" would have added and never has to look the issue up.
 */
export const ISSUE_CONTEXT_DND_MIME = "application/x-ade-issue-context";

export function writeIssueContextDrag(dataTransfer: DataTransfer, attachment: AgentChatContextAttachment, label: string): void {
  dataTransfer.effectAllowed = "copy";
  dataTransfer.setData(ISSUE_CONTEXT_DND_MIME, JSON.stringify(attachment));
  dataTransfer.setData("text/plain", label);
}

export function readIssueContextDrag(dataTransfer: DataTransfer): AgentChatContextAttachment | null {
  const raw = dataTransfer.getData(ISSUE_CONTEXT_DND_MIME);
  if (!raw) return null;
  try {
    return normalizeChatContextAttachments([JSON.parse(raw)])[0] ?? null;
  } catch {
    return null;
  }
}
