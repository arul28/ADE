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
): string[] {
  keys.clear();
  const orderedKeys: string[] = [];
  for (const event of events) {
    const key = tuiEventDedupKey(event);
    keys.add(key);
    orderedKeys.push(key);
  }
  return orderedKeys;
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
  previousEventKeys: readonly string[],
  reservedIncomingKey: string,
  limit = 500,
): { events: AgentChatEventEnvelope[]; eventKeys: string[] } {
  const normalizedLimit = Math.max(1, limit);
  const trimmedCount = Math.max(0, previousEvents.length - normalizedLimit + 1);
  const nextEvents = trimmedCount > 0
    ? [...previousEvents.slice(trimmedCount), envelope]
    : [...previousEvents, envelope];

  const retainedKeys = previousEventKeys.slice(trimmedCount);
  for (const evictedKey of previousEventKeys.slice(0, trimmedCount)) {
    keys.delete(evictedKey);
  }

  return {
    events: nextEvents,
    eventKeys: [...retainedKeys, reservedIncomingKey],
  };
}
