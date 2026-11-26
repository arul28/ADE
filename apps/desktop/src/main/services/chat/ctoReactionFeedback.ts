import {
  CHAT_REACTION_MEANINGS,
  assistantMessageReactionKey,
  normalizeChatReactionEmoji,
  type AgentChatEvent,
  type ChatReactionEmoji,
} from "../../../shared/types/chat";

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

/**
 * The CTO chat's not-yet-told reactions: `pending` waits for a turn, and
 * `staged` is what the turn context being sent holds, so a send clears only
 * what it told.
 */
export type CtoReactionFeedbackQueue = {
  pending: CtoReactionFeedback[];
  staged: readonly CtoReactionFeedback[] | null;
};

/** Stages every pending reaction for the next send; returns its context lines. */
export function stageCtoReactionFeedback(queue: CtoReactionFeedbackQueue): string {
  const staged = queue.pending.slice();
  queue.staged = staged.length ? staged : null;
  return ctoReactionFeedbackSection(staged);
}

/**
 * Settles a send: when it delivered the reactions section, the staged
 * reactions leave the list. A reaction that came in after the context was
 * built waits for the next send. Returns the reactions it took off the list.
 */
export function settleCtoReactionFeedback(queue: CtoReactionFeedbackQueue, delivered: boolean): CtoReactionFeedback[] {
  const staged = delivered ? queue.staged : null;
  queue.staged = null;
  if (!staged) return [];
  const told = new Set(staged);
  queue.pending = queue.pending.filter((item) => !told.has(item));
  return staged.slice();
}

/**
 * Puts back the reactions a send took off the list when the provider then
 * refused the send. A newer reaction on the same message stays instead.
 */
export function restoreCtoReactionFeedback(queue: CtoReactionFeedbackQueue, told: readonly CtoReactionFeedback[]): void {
  const newer = new Set(queue.pending.map((item) => item.targetKey));
  queue.pending = [...told.filter((item) => !newer.has(item.targetKey)), ...queue.pending];
}

/** The pending list as the chat state saved it; entries that do not parse are dropped. */
export function parseCtoReactionFeedback(value: readonly unknown[]): CtoReactionFeedback[] {
  const list: CtoReactionFeedback[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const { targetKey, emoji, quote } = entry as Record<string, unknown>;
    const normalized = normalizeChatReactionEmoji(emoji);
    if (typeof targetKey === "string" && targetKey && normalized && typeof quote === "string") {
      list.push({ targetKey, emoji: normalized, quote });
    }
  }
  return list;
}
