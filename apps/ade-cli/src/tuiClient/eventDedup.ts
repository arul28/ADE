import type { AgentChatEventEnvelope } from "../../../desktop/src/shared/types/chat";

export function tuiEventDedupKey(envelope: AgentChatEventEnvelope): string {
  return [
    "event",
    envelope.sessionId,
    envelope.sequence != null ? `seq:${String(envelope.sequence)}` : "seq:none",
    envelope.timestamp,
    envelope.event.type,
    JSON.stringify(envelope.event),
  ].join(":");
}

export function syncTuiEventDedupKeys(
  keys: Set<string>,
  events: readonly AgentChatEventEnvelope[],
): void {
  keys.clear();
  for (const event of events) {
    keys.add(tuiEventDedupKey(event));
  }
}

export function reserveTuiEventDedupKey(
  envelope: AgentChatEventEnvelope,
  keys: Set<string>,
): string | null {
  const key = tuiEventDedupKey(envelope);
  if (keys.has(key)) return null;
  keys.add(key);
  return key;
}

export function appendReservedTuiEvent(
  previousEvents: readonly AgentChatEventEnvelope[],
  envelope: AgentChatEventEnvelope,
  keys: Set<string>,
  limit = 500,
): AgentChatEventEnvelope[] {
  const normalizedLimit = Math.max(1, limit);
  const trimmedCount = Math.max(0, previousEvents.length - normalizedLimit + 1);
  const nextEvents = trimmedCount > 0
    ? [...previousEvents.slice(trimmedCount), envelope]
    : [...previousEvents, envelope];

  for (const trimmedEvent of previousEvents.slice(0, trimmedCount)) {
    keys.delete(tuiEventDedupKey(trimmedEvent));
  }

  return nextEvents;
}
