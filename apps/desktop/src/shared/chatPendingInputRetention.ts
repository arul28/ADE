import type { AgentChatEventEnvelope } from "./types";

/**
 * The trimming carve-out for cards nobody has answered yet.
 *
 * Every history window in ADE keeps the NEWEST events and drops the rest, which
 * is right for prose and wrong for an `approval_request` with no
 * `pending_input_resolved`: that event is not a record of something that
 * happened, it is the control the user is supposed to click. Aging it out of
 * the window deletes the card from the screen while the backend goes on
 * counting the session as blocked — the composer refuses every send with
 * nothing on screen to answer.
 *
 * So the rule is one rule, applied in the two places that window a transcript:
 * the main process's `getChatEventHistory` and the renderer's
 * `trimChatEventHistory` (which the hosted web client shares). An unresolved
 * `approval_request` is re-admitted in its original chronological position
 * regardless of the count or byte budget. Resolved ones are ordinary history
 * and trim like everything else.
 */
export function unresolvedApprovalRequestEnvelopes(
  events: readonly AgentChatEventEnvelope[],
): AgentChatEventEnvelope[] {
  const unresolved = new Map<string, AgentChatEventEnvelope>();
  for (const envelope of events) {
    const event = envelope.event;
    if (event.type === "approval_request") {
      const itemId = typeof event.itemId === "string" ? event.itemId.trim() : "";
      if (itemId.length) unresolved.set(itemId, envelope);
      continue;
    }
    if (event.type === "pending_input_resolved") {
      const itemId = typeof event.itemId === "string" ? event.itemId.trim() : "";
      if (itemId.length) unresolved.delete(itemId);
      continue;
    }
    if (event.type === "auto_approval_review") {
      const itemId = typeof event.targetItemId === "string" ? event.targetItemId.trim() : "";
      if (itemId.length) unresolved.delete(itemId);
    }
  }
  return [...unresolved.values()];
}

/**
 * Re-admit into `windowed` every unresolved `approval_request` from `source`
 * that the window dropped, preserving `source` order.
 *
 * `source` must be the full (pre-trim) list and `windowed` a suffix-or-subset of
 * it; both are chronological. The result is chronological too, so a client that
 * replays it in order still sees the card raised before anything that followed
 * it.
 */
export function retainUnresolvedApprovalRequests(
  source: readonly AgentChatEventEnvelope[],
  windowed: readonly AgentChatEventEnvelope[],
): AgentChatEventEnvelope[] {
  if (windowed.length === source.length) return windowed.slice();
  const survivors = unresolvedApprovalRequestEnvelopes(source);
  if (!survivors.length) return windowed.slice();
  const present = new Set<AgentChatEventEnvelope>(windowed);
  const missing = survivors.filter((envelope) => !present.has(envelope));
  if (!missing.length) return windowed.slice();
  // Rebuilt from `source` rather than concatenated, so the re-admitted cards
  // land where they were raised instead of all bunching at the head.
  const keep = new Set<AgentChatEventEnvelope>([...windowed, ...missing]);
  return source.filter((envelope) => keep.has(envelope));
}
