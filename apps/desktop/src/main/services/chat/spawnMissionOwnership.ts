import type { AgentChatEvent, AgentChatEventEnvelope, AgentChatEventMetadata } from "../../../shared/types/chat";

/**
 * Who a spawned child chat is currently working for.
 *
 * A subagent completion wakes its parent when the parent still owns the child's
 * mission, not only when the parent started the turn that happened to finish.
 * Long missions are mostly driven by the child's own scheduled wakeups — an ADE
 * ship loop polling CI, say — so strict per-turn attribution left the parent
 * unnotified on the turn that actually delivered the result.
 *
 * Ownership is the most recent *directive* the child received. A directive is
 * someone assigning work: a human message, or a message the host stamped as
 * parent-dispatched. Everything else continues whatever mission is already in
 * flight and must not reassign it:
 *
 * - `scheduledWake` — the child's own durable scheduler firing.
 * - `spawnCompletion` — a result returning from the child's own grandchild.
 * - `agentRelay` — another bound agent talking to the child: its own grandchild
 *   reporting in (which ADE's spawn guidance tells children to do), a sibling
 *   coordinating, or the child messaging itself. None of them own the mission,
 *   so none of them may take it from the parent.
 * - `hostContinuation` — ADE prompting the child to resume/repair its own work.
 * - legacy `kind: "continuity_recovery"` — the same thing on transcripts
 *   written before `hostContinuation` existed.
 * - `deliveryState: "queued"` — not yet delivered, and the queued copy is
 *   lossy (the queue path strips `scheduledWake`). The delivered twin carries
 *   the authoritative metadata; a queued message that is never delivered was
 *   never acted on and should not take ownership.
 *
 * A handoff prompt (`kind: "handoff"` / `"cross_machine_handoff"`) *is* a
 * directive: it carries a human's continuation intent into the session.
 *
 * Every input here is persisted host-authored state. `spawnDispatch` is stamped
 * at the ADE RPC edge from the caller's bound session and the target's
 * persisted parent, with caller-supplied values deleted first, so a child
 * cannot manufacture ownership of itself.
 */
export const isMissionDirective = (
  event: Extract<AgentChatEvent, { type: "user_message" }>,
): boolean => {
  if (event.deliveryState === "queued") return false;
  const metadata: AgentChatEventMetadata | null | undefined = event.metadata;
  if (!metadata) return true;
  if (
    metadata.scheduledWake
    || metadata.spawnCompletion
    || metadata.agentRelay
    || metadata.hostContinuation
  ) {
    return false;
  }
  if (metadata.kind === "continuity_recovery") return false;
  return true;
};

/**
 * Provenance ADE authors itself and never accepts from a caller. Untrusted
 * entry points (the ADE RPC edge, the automation action bridge) delete these
 * before the message reaches the chat service, so mission ownership is always
 * derived from what the host observed rather than what a caller asserted.
 */
export const HOST_AUTHORED_MESSAGE_PROVENANCE_KEYS = [
  "spawnDispatch",
  "agentRelay",
  "hostContinuation",
  "scheduledWake",
  "spawnCompletion",
] as const;

export const stripHostAuthoredMessageProvenance = (
  metadata: Record<string, unknown>,
): Record<string, unknown> => {
  for (const key of HOST_AUTHORED_MESSAGE_PROVENANCE_KEYS) delete metadata[key];
  return metadata;
};

const findLastUserMessage = (
  history: readonly AgentChatEventEnvelope[],
  matches: (event: Extract<AgentChatEvent, { type: "user_message" }>) => boolean,
): Extract<AgentChatEvent, { type: "user_message" }> | null => {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const event = history[index]?.event;
    if (event?.type !== "user_message" || !matches(event)) continue;
    return event;
  }
  return null;
};

const stampedByParent = (
  event: Extract<AgentChatEvent, { type: "user_message" }> | null,
  parentSessionId: string,
): boolean => event?.metadata?.spawnDispatch?.parentSessionId === parentSessionId;

/**
 * Whether a finished child turn should wake `parentSessionId`.
 *
 * Two independent reasons, either of which is enough:
 * - the parent dispatched *this* turn (the original contract — kept so a turn
 *   the parent started still reports back even if a human messaged the child
 *   while it ran), or
 * - the parent owns the mission at completion time.
 *
 * Ownership is read at completion time; ADE keeps no per-schedule provenance.
 * "Who is waiting for this result now" is what the wake answers, so work the
 * child scheduled while a human owned the mission still wakes the parent if
 * the parent re-dispatched before it fired.
 */
export const parentShouldWakeForChildTurn = (args: {
  history: readonly AgentChatEventEnvelope[];
  parentSessionId: string;
  turnId: string;
}): boolean => {
  const { history, parentSessionId, turnId } = args;
  const dispatchedThisTurn = findLastUserMessage(history, (event) => event.turnId === turnId);
  if (stampedByParent(dispatchedThisTurn, parentSessionId)) return true;
  return stampedByParent(findLastUserMessage(history, isMissionDirective), parentSessionId);
};
