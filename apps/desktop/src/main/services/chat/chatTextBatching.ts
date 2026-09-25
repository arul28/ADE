import type { AgentChatEvent, AgentChatTextPhase } from "../../../shared/types";

export type BufferedAssistantText = {
  text: string;
  messageId?: string;
  originTimestamp?: string;
  turnId?: string;
  itemId?: string;
  phase?: AgentChatTextPhase;
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

/**
 * Can the live 100ms text buffer fold this delta into the pending event?
 *
 * Same stream as {@link canAppendBufferedAssistantText}, and the same Codex
 * `phase`. Consecutive Codex messages in one turn can share a message id, so a
 * commentary message and the final answer (or a labeled and an unlabeled one)
 * would otherwise flush as a single event under one label. Splitting only moves
 * the flush boundary; the text, and how clients merge it, is unchanged.
 */
export function canCoalesceBufferedAssistantText(
  buffered: BufferedAssistantText | null,
  event: Extract<AgentChatEvent, { type: "text" }>,
): boolean {
  return canAppendBufferedAssistantText(buffered, event)
    && (buffered?.phase ?? null) === (event.phase ?? null);
}

export function appendBufferedAssistantText(
  buffered: BufferedAssistantText | null,
  event: Extract<AgentChatEvent, { type: "text" }>,
): BufferedAssistantText {
  if (canCoalesceBufferedAssistantText(buffered, event)) {
    return {
      ...buffered!,
      text: `${buffered!.text}${event.text}`,
      ...(event.originTimestamp ? { originTimestamp: event.originTimestamp } : {}),
    };
  }

  return {
    text: event.text,
    ...(event.messageId ? { messageId: event.messageId } : {}),
    ...(event.originTimestamp ? { originTimestamp: event.originTimestamp } : {}),
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(event.itemId ? { itemId: event.itemId } : {}),
    ...(event.phase ? { phase: event.phase } : {}),
  };
}

export function shouldFlushBufferedAssistantTextForEvent(event: AgentChatEvent): boolean {
  switch (event.type) {
    case "text":
    case "reasoning":
    case "activity":
    case "subagent_started":
    case "subagent_progress":
    case "subagent_result":
    // Data-only citations for the message being streamed; they must not split it.
    case "sources":
      return false;
    case "plan":
      return event.streamingText === undefined;
    default:
      return true;
  }
}
