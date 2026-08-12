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
 * `isMissionDirective` is the narrower "someone assigned work" test used to
 * recognize parent dispatches and orchestration directives. A plain human
 * message is not a directive: it does not steal the report channel.
 *
 * Inputs that continue a mission already in flight, and never assign one:
 *
 * - `scheduledWake` — the child's own durable scheduler firing.
 * - `spawnCompletion` — a result returning from the child's own grandchild.
 * - `agentRelay` — another bound agent talking to the child.
 * - `orchestrationOrigin` with any `intent` other than `"directive"`.
 * - `hostContinuation` — ADE prompting the child to resume/repair its own work.
 * - `kind: "continuity_recovery"` — the same thing on older transcripts.
 * - `deliveryState: "queued"` — not yet delivered; the delivered twin is
 *   authoritative.
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
  if (!metadata) return false;
  if (NON_DIRECTIVE_METADATA_KEYS.some((key) => metadata[key])) return false;
  if (metadata.kind === "continuity_recovery") return false;
  const orchestrationIntent = (metadata.orchestrationOrigin as { intent?: unknown } | undefined)?.intent;
  if (orchestrationIntent != null && orchestrationIntent !== "directive") return false;
  if (metadata.spawnDispatch) return true;
  if (orchestrationIntent === "directive") return true;
  return false;
};

/**
 * A human-authored message on a child chat: counts toward the "user also sent
 * N messages" line on the next parent report. Parent dispatches, scheduled
 * wakes, relays, and host continuations are not human messages.
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

/** Host-authored markers that say "this message continues the mission" rather
 * than "this message assigns one". The single source for both the predicate
 * above and the untrusted-caller strip below. */
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
  // chat caller — its `intent` also feeds the directive test above.
  "orchestrationOrigin",
  ...NON_DIRECTIVE_METADATA_KEYS,
] as const;

export const stripHostAuthoredMessageProvenance = (metadata: Record<string, unknown>): void => {
  for (const key of HOST_AUTHORED_MESSAGE_PROVENANCE_KEYS) delete metadata[key];
};
