import type { AgentChatEvent } from "../../../shared/types";

export type BufferedAssistantText = {
  text: string;
  messageId?: string;
  turnId?: string;
  itemId?: string;
};

export function canAppendBufferedAssistantText(
  buffered: BufferedAssistantText | null,
  event: Extract<AgentChatEvent, { type: "text" }>,
): boolean {
  if (!buffered) return false;
  const bufferedMessageId = buffered.messageId?.trim() || null;
  const eventMessageId = event.messageId?.trim() || null;
  if (bufferedMessageId || eventMessageId) {
    if (bufferedMessageId && eventMessageId) {
      return bufferedMessageId === eventMessageId;
    }
    const bufferedTurnId = buffered.turnId ?? null;
    const eventTurnId = event.turnId ?? null;
    if (bufferedTurnId && eventTurnId && bufferedTurnId === eventTurnId) {
      const bufferedItemId = buffered.itemId ?? null;
      const eventItemId = event.itemId ?? null;
      return !bufferedItemId || !eventItemId || bufferedItemId === eventItemId;
    }
    return false;
  }
  // Coalesce anonymous chunks that lack any identity — these are consecutive
  // assistant text deltas from the same stream that simply have no IDs attached.
  if (!buffered.turnId && !buffered.itemId && !event.turnId && !event.itemId) return true;
  return (buffered.turnId ?? null) === (event.turnId ?? null)
    && (buffered.itemId ?? null) === (event.itemId ?? null);
}

export function appendBufferedAssistantText(
  buffered: BufferedAssistantText | null,
  event: Extract<AgentChatEvent, { type: "text" }>,
): BufferedAssistantText {
  if (canAppendBufferedAssistantText(buffered, event)) {
    return {
      ...buffered!,
      text: `${buffered!.text}${event.text}`,
    };
  }

  return {
    text: event.text,
    ...(event.messageId ? { messageId: event.messageId } : {}),
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(event.itemId ? { itemId: event.itemId } : {}),
  };
}

export function shouldFlushBufferedAssistantTextForEvent(event: AgentChatEvent): boolean {
  switch (event.type) {
    case "text":
    case "reasoning":
    case "activity":
    case "plan_text":
    case "subagent_started":
    case "subagent_progress":
    case "subagent_result":
      return false;
    default:
      return true;
  }
}
