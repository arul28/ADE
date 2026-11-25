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
  return event.deliveryState !== "queued"
    && event.deliveryState !== "failed"
    && event.deliveryState !== "unprocessed"
    && (event.deliveryState !== "accepted" || provider === "codex")
    && isPersonAuthoredUserMessage(event.metadata)
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
      // The person wrote and the turn read it: what comes next may answer them.
      state.quiet = null;
    } else if (key && key === state.reactTarget) {
      // The target steer turned out unread (the turn ended first, or it failed).
      state.reactTarget = null;
    }
    return false;
  }
  if (event.type === "text" && state.quiet) {
    const eventTurnId = event.turnId?.trim() || null;
    return !state.quiet.turnId || !eventTurnId || eventTurnId === state.quiet.turnId;
  }
  return false;
}

/**
 * The message a turn that read nothing from the person may still react to:
 * the person's newest message carrying the CTO's 👀, so the 👀 can become ✅
 * (or another reaction) once the look it promised is done, in a later turn or
 * after a restart. Null when no 👀 of the CTO's stands.
 */
export function ctoLookingReactTarget(events: readonly AgentChatEvent[], provider: AgentChatProvider): string | null {
  const reactionByKey = new Map<string, string>();
  const personKeys: string[] = [];
  for (const event of events) {
    if (event.type === "user_message_reaction") {
      reactionByKey.set(event.targetKey, event.emoji);
    } else if (event.type === "user_message" && ctoTurnReadsPersonMessage(event, provider)) {
      const key = userMessageReactionKey(event);
      if (key) personKeys.push(key);
    }
  }
  for (let index = personKeys.length - 1; index >= 0; index -= 1) {
    const key = personKeys[index]!;
    if (reactionByKey.get(key) === "👀") return key;
  }
  return null;
}

/** How much of a reacted-to message the CTO is shown, so it knows which one. */
const REACTION_QUOTE_CAP = 280;

/** The hidden prompt that tells the CTO the person reacted to one of its messages. */
export function ctoUserReactionPrompt(emoji: string, meaning: string, reacted: string): string {
  const flat = reacted.split(/\s+/).filter(Boolean).join(" ");
  const chars = Array.from(flat);
  const quote = chars.length > REACTION_QUOTE_CAP ? `${chars.slice(0, REACTION_QUOTE_CAP).join("")}…` : flat;
  return [
    `The person reacted ${emoji} (${meaning}) to your message:`,
    "",
    `> ${quote}`,
    "",
    "A reaction, not a typed message. Answer only what it calls for, as you would a short message. "
    + "Most reactions need nothing back: end with noReply. "
    + "A 👎 means that message missed: say in a line what you will change, or ask what they wanted.",
  ].join("\n");
}
