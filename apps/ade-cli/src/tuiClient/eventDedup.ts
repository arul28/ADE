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
