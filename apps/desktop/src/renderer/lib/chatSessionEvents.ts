import type { AgentChatEventEnvelope } from "../../shared/types";

export function shouldRefreshSessionListForChatEvent(envelope: AgentChatEventEnvelope): boolean {
  return envelope.event.type === "done" || envelope.event.type === "error";
}
