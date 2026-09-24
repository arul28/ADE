import type { AgentChatEvent, AgentChatEventEnvelope } from "./types/chat";

const TURN_WORK_EVENT_TYPES = new Set<AgentChatEvent["type"]>([
  "tool_call",
  "tool_result",
  "command",
  "file_change",
  "web_search",
]);

/**
 * Closes each imported turn that did tool work with a `done` event.
 *
 * ADE's transcript never shows finished tool calls as rows of their own: it
 * lists them in the turn's `done` summary. A provider transcript has no such
 * boundary, so without this every imported tool call was invisible — in the
 * import preview and in the imported chat alike. A turn with only text gets no
 * boundary, so plain conversations stay as they were. Input that already
 * carries `done` events is returned unchanged.
 */
export function withImportedTurnBoundaries(
  envelopes: AgentChatEventEnvelope[],
): AgentChatEventEnvelope[] {
  if (envelopes.some((envelope) => envelope.event.type === "done")) return envelopes;
  const out: AgentChatEventEnvelope[] = [];
  let lastContent: AgentChatEventEnvelope | null = null;
  let turnHasWork = false;
  const closeTurn = () => {
    if (lastContent && turnHasWork) {
      out.push({
        sessionId: lastContent.sessionId,
        timestamp: lastContent.timestamp,
        event: {
          type: "done",
          turnId: `imported-turn:${lastContent.timestamp}:${out.length}`,
          status: "completed",
        },
        ...(lastContent.provenance
          ? { provenance: { ...lastContent.provenance, messageId: undefined, role: null } }
          : {}),
      });
    }
    lastContent = null;
    turnHasWork = false;
  };
  for (const envelope of envelopes) {
    if (envelope.event.type === "user_message") closeTurn();
    out.push(envelope);
    if (envelope.event.type === "user_message" || envelope.event.type === "system_notice") continue;
    lastContent = envelope;
    if (TURN_WORK_EVENT_TYPES.has(envelope.event.type)) turnHasWork = true;
  }
  closeTurn();
  return out;
}
