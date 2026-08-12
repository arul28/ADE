import type { AgentChatEvent, AgentChatEventEnvelope, AgentChatEventMetadata } from "../../../shared/types/chat";

/**
 * Who a spawned child chat is currently working for.
 *
 * Wake vs quiet is decided by the child's persisted `spawnKind`, not by the
 * latest human message. A subagent always wakes its parent; a peer never does.
 * Taking over (demote to peer) is an explicit user action. A human message
 * while the child stays a subagent does not close the report channel — the
 * next wake names how many human messages landed in that turn so the parent
 * can read the transcript before following up.
 *
 * `isHumanChildMessage` counts those human messages. Parent dispatches,
 * scheduled wakes, relays, host continuations, and any orchestration origin
 * are not human messages.
 *
 * Every host-authored marker is persisted host state. `spawnDispatch` is
 * stamped at the ADE RPC edge from the caller's bound session and the
 * target's persisted parent, with caller-supplied values deleted first, so a
 * child cannot manufacture ownership of itself.
 */
export const isHumanChildMessage = (
  event: Extract<AgentChatEvent, { type: "user_message" }>,
): boolean => {
  if (event.deliveryState === "queued") return false;
  const metadata: AgentChatEventMetadata | null | undefined = event.metadata;
  if (!metadata) return true;
  if (metadata.spawnDispatch) return false;
  if (NON_DIRECTIVE_METADATA_KEYS.some((key) => metadata[key])) return false;
  if (metadata.kind === "continuity_recovery") return false;
  if (metadata.orchestrationOrigin) return false;
  return true;
};

export const countHumanChildMessagesForTurn = (
  history: readonly AgentChatEventEnvelope[],
  turnId: string,
): number => {
  let count = 0;
  for (const envelope of history) {
    const event = envelope.event;
    if (event?.type !== "user_message") continue;
    if (event.turnId !== turnId) continue;
    if (!isHumanChildMessage(event)) continue;
    count += 1;
  }
  return count;
};

export const formatHumanChildMessageAnnotation = (count: number): string | null => {
  if (count <= 0) return null;
  if (count === 1) return "The user also sent 1 message to this chat.";
  return `The user also sent ${count} messages to this chat.`;
};

/** Host-authored markers that are not human messages. Shared with the
 * untrusted-caller strip below. */
const NON_DIRECTIVE_METADATA_KEYS = [
  "scheduledWake",
  "spawnCompletion",
  "agentRelay",
  "hostContinuation",
] as const;

/**
 * Provenance ADE authors itself and never accepts from a caller. Untrusted
 * entry points (the ADE RPC edge, the automation action bridge) delete these
 * before the message reaches the chat service, so mission ownership is always
 * derived from what the host observed rather than what a caller asserted.
 */
export const HOST_AUTHORED_MESSAGE_PROVENANCE_KEYS = [
  "spawnDispatch",
  // Written in-process by the orchestration service, never accepted from a
  // chat caller. Any orchestration origin is excluded from the human-message
  // count above.
  "orchestrationOrigin",
  ...NON_DIRECTIVE_METADATA_KEYS,
] as const;

export const stripHostAuthoredMessageProvenance = (metadata: Record<string, unknown>): void => {
  for (const key of HOST_AUTHORED_MESSAGE_PROVENANCE_KEYS) delete metadata[key];
};
