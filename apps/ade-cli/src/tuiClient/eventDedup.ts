import type { AgentChatEventEnvelope } from "../../../desktop/src/shared/types/chat";

export function tuiEventDedupKey(envelope: AgentChatEventEnvelope): string {
  if (envelope.sequence != null) return `seq:${String(envelope.sequence)}`;
  return [
    "event",
    envelope.timestamp,
    envelope.event.type,
    JSON.stringify(envelope.event),
  ].join(":");
}
