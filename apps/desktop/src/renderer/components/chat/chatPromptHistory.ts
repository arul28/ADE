import type { AgentChatEvent, AgentChatEventEnvelope } from "../../../shared/types";

export type AgentChatPromptHistoryEntry = {
  text: string;
  eventKey: string;
};

/**
 * Stable identity shared by the composer and transcript rows for a sent user
 * message. Do not serialize the whole event here: transcript rendering may
 * add display-only metadata to a row (for example, a resolved steer receipt)
 * without changing the underlying prompt.
 */
export function promptHistoryEventKey(entry: {
  timestamp: string;
  event: Extract<AgentChatEvent, { type: "user_message" }>;
}): string {
  const messageId = entry.event.messageId?.trim();
  if (messageId) return `${entry.timestamp}#user_message#message:${messageId}`;
  const steerId = entry.event.steerId?.trim();
  if (steerId) return `${entry.timestamp}#user_message#steer:${steerId}`;
  const turnId = entry.event.turnId?.trim();
  if (turnId) return `${entry.timestamp}#user_message#turn:${turnId}#${entry.event.text}`;
  // Older transcripts may not have any runtime identity. The envelope
  // timestamp plus the canonical prompt text is the least lossy fallback and
  // remains unchanged when the renderer decorates the row.
  return `${entry.timestamp}#user_message#text:${entry.event.text}`;
}

/** Collect only visible, delivered prompts from the transcript passed in. */
export function collectAgentChatPromptHistory(
  events: readonly AgentChatEventEnvelope[],
): AgentChatPromptHistoryEntry[] {
  return events.flatMap((envelope) => {
    const event = envelope.event;
    if (event.type !== "user_message") return [];
    if (event.deliveryState === "queued" && event.steerId) return [];
    if (event.metadata?.hideFullPrompt === true && !event.displayText?.trim()) return [];
    const displayText = event.displayText?.trim();
    const text = displayText?.length ? displayText : event.text.trim();
    if (!text) return [];
    return [{ text, eventKey: promptHistoryEventKey({ timestamp: envelope.timestamp, event }) }];
  });
}
