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
  const nextEvents = previousEvents.length >= limit
    ? [...previousEvents.slice(previousEvents.length - limit + 1), envelope]
    : [...previousEvents, envelope];

  if (nextEvents.length !== previousEvents.length + 1) {
    syncTuiEventDedupKeys(keys, nextEvents);
  }

  return nextEvents;
}
