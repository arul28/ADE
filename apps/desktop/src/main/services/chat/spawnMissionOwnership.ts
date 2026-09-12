import { HOST_ONLY_CHAT_METADATA_KEYS } from "../../../shared/chatAutoResume";
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
  // Stamped by `session.moveOnBoard` from the column the row was actually in
  // and the one it was dropped on. A caller-supplied `boardMove` would let a
  // rule (or an agent) forge "the user moved this card", which the renderer
  // renders as a user act and which clears the attention markers.
  "boardMove",
  ...NON_DIRECTIVE_METADATA_KEYS,
  // Host-only dispatch markers are host-authored provenance too, and they are
  // the load-bearing kind: each one exempts its message from the auto-resume
  // cancel sweep, so a caller that could assert one would leave a chat's
  // resume armed through real activity and have it fire unattended later.
  // Spread rather than listed, so this set can never drift from the one the
  // dispatch commit points honour. `scheduledWake` appears in both lists; the
  // strip is a delete loop, so the overlap costs nothing.
  ...HOST_ONLY_CHAT_METADATA_KEYS,
] as const;

export const stripHostAuthoredMessageProvenance = (metadata: Record<string, unknown>): void => {
  for (const key of HOST_AUTHORED_MESSAGE_PROVENANCE_KEYS) delete metadata[key];
};

/**
 * Metadata that marks a message as one the HOST wrote on the agent's behalf,
 * rather than one a person sent.
 *
 * Only a person engaging with a chat may clear its lifecycle markers (the
 * settle / attention / turn-failure columns). A host-authored delivery must
 * not: a subagent reporting in (`spawnCompletion`), a continuation or repair
 * prompt ADE composed itself (`hostContinuation`), or a durable scheduler
 * firing (`scheduledWake`) would otherwise wipe a real "Needs you" the user
 * has not seen — the child's report masks the parent's raised hand, and the
 * row goes quiet with a question still open.
 */
const HOST_AUTHORED_NON_USER_ACTIVITY_KEYS = [
  "scheduledWake",
  "spawnCompletion",
  "hostContinuation",
] as const;

/**
 * Whether delivering this message counts as the user engaging with the chat,
 * and so may clear the attention/settle markers.
 *
 * A board move is host-authored in provenance (ADE writes the text, and
 * `stripHostAuthoredMessageProvenance` refuses the marker from a caller) but
 * it is a human ACT: the user dragged the card. So it clears — except a move
 * INTO Needs you, whose entire point is the attention write it would
 * otherwise erase in the same breath.
 */
export const messageClearsAttentionMarkers = (
  metadata: AgentChatEventMetadata | null | undefined,
): boolean => {
  if (!metadata) return true;
  // A board move into Needs you is the user parking the chat for their input,
  // so it must not count as agent activity. Every other target does.
  if (metadata.boardMove) return metadata.boardMove.to !== "needs_you";
  return !HOST_AUTHORED_NON_USER_ACTIVITY_KEYS.some((key) => metadata[key]);
};
