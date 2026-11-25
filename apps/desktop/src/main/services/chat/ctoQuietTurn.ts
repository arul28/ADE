import { userMessageReactionKey, type AgentChatEvent, type AgentChatProvider } from "../../../shared/types/chat";
import { isPersonAuthoredUserMessage } from "./crossMachineHandoffSource";

/**
 * The CTO chat's quiet-turn state: what `noReply` and `react` set, and what
 * each committed event does to it.
 */
export type CtoQuietTurnState = {
  /** Set by `noReply` or `react`: this turn's later text is dropped. */
  quiet: { turnId: string | null } | null;
  /**
   * The `userMessageReactionKey` of the person's newest message the running
   * turn has read, for `react`. In memory only: after a brain restart `react`
   * refuses and the CTO replies instead.
   */
  reactTarget: string | null;
};

/**
 * Whether the running turn reads this message as the person's: they wrote it
 * (not a wake, a child's report or a resend ADE made), and it reached the turn
 * (not a steer still queued, one that never arrived, or one the turn ended
 * without). An `accepted` steer has reached the turn only on Codex; elsewhere
 * it still waits on the provider, and its `delivered` row comes later.
 */
export function ctoTurnReadsPersonMessage(
  event: Extract<AgentChatEvent, { type: "user_message" }>,
  provider: AgentChatProvider,
): boolean {
  return ctoTurnReadsNewMessage(event, provider) && isPersonAuthoredUserMessage(event.metadata);
}

/**
 * Whether the running turn read a new message from anyone: the person, or a
 * wake such as a child's report arriving while the turn still runs. Either
 * one is news the CTO may answer, so it reopens a turn `noReply` closed.
 */
function ctoTurnReadsNewMessage(
  event: Extract<AgentChatEvent, { type: "user_message" }>,
  provider: AgentChatProvider,
): boolean {
  return event.deliveryState !== "queued"
    && event.deliveryState !== "failed"
    && event.deliveryState !== "unprocessed"
    && (event.deliveryState !== "accepted" || provider === "codex")
    && !event.metadata?.boardMove
    && !event.metadata?.ctoResend;
}

/**
 * Applies one committed event to the state, in place. Returns true when the
 * event must be dropped: text the CTO wrote after ending its turn quietly.
 */
export function stepCtoQuietTurn(state: CtoQuietTurnState, event: AgentChatEvent, provider: AgentChatProvider): boolean {
  if (event.type === "done") {
    state.reactTarget = null;
    if (state.quiet && (!state.quiet.turnId || event.turnId === state.quiet.turnId)) state.quiet = null;
    return false;
  }
  if (event.type === "user_message") {
    const key = userMessageReactionKey(event);
    if (ctoTurnReadsPersonMessage(event, provider)) {
      state.reactTarget = key;
    } else if (key && key === state.reactTarget) {
      // The target steer turned out unread (the turn ended first, or it failed).
      state.reactTarget = null;
    }
    // The turn read something new (the person, or a child reporting with its
    // proof mid-turn): what comes next may answer it.
    if (ctoTurnReadsNewMessage(event, provider)) state.quiet = null;
    return false;
  }
  if (event.type === "text" && state.quiet) {
    const eventTurnId = event.turnId?.trim() || null;
    return !state.quiet.turnId || !eventTurnId || eventTurnId === state.quiet.turnId;
  }
  return false;
}
