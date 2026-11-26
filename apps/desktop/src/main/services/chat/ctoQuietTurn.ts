import {
  CHAT_REACTION_MEANINGS,
  assistantMessageReactionKey,
  userMessageReactionKey,
  type AgentChatEvent,
  type AgentChatProvider,
  type ChatReactionEmoji,
} from "../../../shared/types/chat";
import { isPersonAuthoredUserMessage } from "./crossMachineHandoffSource";

/**
 * The CTO chat's quiet-turn state: what `noReply` and `react` set, and what
 * each committed event does to it.
 */
export type CtoQuietTurnState = {
  /** Set by `noReply` or `react` (not 👀): this turn's later text is dropped. */
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

/** One reaction of the person's on a CTO message that the CTO has not been told about yet. */
export type CtoReactionFeedback = {
  targetKey: string;
  emoji: ChatReactionEmoji;
  /** The start of the message it is on, flattened to one line. */
  quote: string;
};

function quoteForFeedback(text: string): string {
  const chars = Array.from(text.split(/\s+/).filter(Boolean).join(" "));
  return chars.length > REACTION_QUOTE_CAP ? `${chars.slice(0, REACTION_QUOTE_CAP).join("")}…` : chars.join("");
}

/**
 * The CTO message a person's reaction names, read from the transcript: its
 * text (the fragments of one reply share a key) and the person's reaction on
 * it now. Null when no text has that key, or ADE took the message back.
 */
export function ctoReactableMessage(
  events: readonly AgentChatEvent[],
  targetKey: string,
): { quote: string; current: ChatReactionEmoji | null } | null {
  const retracted = new Set<string>();
  let text = "";
  let current: ChatReactionEmoji | null = null;
  for (const event of events) {
    if (event.type === "transcript_retraction") {
      for (const id of event.messageIds) retracted.add(`message:${id.trim()}`);
    } else if (event.type === "text" && assistantMessageReactionKey(event) === targetKey) {
      text += event.text;
    } else if (event.type === "assistant_message_reaction" && event.targetKey === targetKey) {
      current = event.emoji;
    }
  }
  if (!text.trim() || retracted.has(targetKey)) return null;
  return { quote: quoteForFeedback(text), current };
}

/**
 * Adds a reaction to the not-yet-told list, in place. A newer reaction on the
 * same message replaces the older one and moves to the end.
 */
export function addCtoReactionFeedback(list: CtoReactionFeedback[], item: CtoReactionFeedback): void {
  const index = list.findIndex((entry) => entry.targetKey === item.targetKey);
  if (index >= 0) list.splice(index, 1);
  list.push(item);
}

/**
 * The reactions the CTO has not been told about, rebuilt from the transcript
 * when the brain has no list in memory (after a restart): every reaction
 * logged after the CTO's last finished turn, the newest on each message.
 */
export function ctoReactionFeedbackSinceLastTurn(events: readonly AgentChatEvent[]): CtoReactionFeedback[] {
  let lastDone = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]!.type === "done") {
      lastDone = index;
      break;
    }
  }
  const list: CtoReactionFeedback[] = [];
  for (let index = lastDone + 1; index < events.length; index += 1) {
    const event = events[index]!;
    if (event.type !== "assistant_message_reaction") continue;
    const message = ctoReactableMessage(events, event.targetKey);
    if (message) addCtoReactionFeedback(list, { targetKey: event.targetKey, emoji: event.emoji, quote: message.quote });
  }
  return list;
}

/**
 * The turn-context lines that tell the CTO how the person reacted to its
 * messages since its last turn. A reaction costs no turn of its own; it is
 * feedback the CTO reads at the start of the next one.
 */
export function ctoReactionFeedbackSection(list: readonly CtoReactionFeedback[]): string {
  if (!list.length) return "";
  return [
    "Reactions since your last turn. The person reacted to your messages; take each as feedback, not as a new message:",
    ...list.map((item) => `- ${item.emoji} (${CHAT_REACTION_MEANINGS[item.emoji]}) on: "${item.quote}"`),
    "Most need nothing back. After a 👎, change what that message got wrong, and ask in a line if you cannot tell what it was.",
  ].join("\n");
}
