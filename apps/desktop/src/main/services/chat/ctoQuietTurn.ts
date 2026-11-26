import { userMessageReactionKey, type AgentChatEvent, type AgentChatProvider } from "../../../shared/types/chat";
import { isPersonAuthoredUserMessage } from "./crossMachineHandoffSource";

/**
 * The CTO chat's quiet-turn state: what `noReply` and `react` set, and what
 * each committed event does to it.
 */
export type CtoQuietTurnState = {
  /**
   * Set by `noReply` or `react`: this turn's later text is dropped. `review`:
   * ADE's hidden review turn, whose reasoning is dropped too.
   */
  quiet: { turnId: string | null; review?: true } | null;
  /**
   * The `userMessageReactionKey` of the person's newest message the running
   * turn has read, for `react`. In memory only: after a brain restart `react`
   * refuses and the CTO replies instead.
   */
  reactTarget: string | null;
  /**
   * The newest correction the person wrote that a turn read (`ctoCorrectionExcerpt`).
   * The turn's end takes it: when the turn learned nothing, ADE starts a hidden
   * review turn (`CTO_REVIEW_REASON`).
   */
  correction: string | null;
  /** A review turn's message is in: that turn writes no text, whenever it starts. */
  reviewPending: boolean;
};

export function newCtoQuietTurnState(): CtoQuietTurnState {
  return { quiet: null, reactTarget: null, correction: null, reviewPending: false };
}

/** The host-continuation reason of the hidden review turn after a correction. */
export const CTO_REVIEW_REASON = "cto_review";

/** ADE's hidden review prompt: never part of the conversation anyone reads back (tails, copies, stories). */
export function isCtoReviewMessage(event: AgentChatEvent): boolean {
  return event.type === "user_message" && event.metadata?.hostContinuation?.reason === CTO_REVIEW_REASON;
}

const CORRECTION_EXCERPT_MAX_CHARS = 400;

/**
 * Words that read as the person correcting the CTO: a "no"/"don't" opening,
 * or "I told you", "you should have", "why did you", "next time", "from now on".
 * Deliberately narrow: a miss costs one unreviewed lesson, a false hit a
 * model turn.
 */
const CORRECTION_PATTERNS: readonly RegExp[] = [
  /^\s*(?:no|nope|wrong|stop|don'?t|do not|never|not like that|that'?s (?:not|wrong)|that is (?:not|wrong))\b/i,
  /\b(?:i (?:told|asked) you|i said (?:to|not)|you (?:should(?:n'?t| not)? have|were supposed to|forgot to|ignored)|why did you|next time|from now on|stop doing|please don'?t|please do not)\b/i,
];

/** The person's message, clipped, when it reads as a correction; else null. */
export function ctoCorrectionExcerpt(text: string | null | undefined): string | null {
  const trimmed = (text ?? "").trim();
  if (!trimmed || !CORRECTION_PATTERNS.some((pattern) => pattern.test(trimmed))) return null;
  const single = trimmed.replace(/\s+/g, " ");
  return single.length > CORRECTION_EXCERPT_MAX_CHARS ? `${single.slice(0, CORRECTION_EXCERPT_MAX_CHARS - 1)}…` : single;
}

/** What the hidden review turn asks. Its text is never shown; only a lesson it saves shows, as the Learned row. */
export function buildCtoReviewPrompt(correction: string): string {
  return [
    "Hidden review (the person does not see this message or any text you write in this turn).",
    `Earlier the person corrected you: "${correction}"`,
    "If that carries a lesson you have not saved yet, fix the cause now: a standing rule → addRule (or sharpen an existing one with replaces); how to do a kind of task → saveSkill; a fact → remember.",
    "Write the lesson as a rule plus one clause of why. If it is already saved, or nothing durable came of it, change nothing.",
    "Do not redo or continue the work, and do not message anyone. End the turn with noReply.",
  ].join("\n");
}

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

/** A CTO turn starts: a quiet ending never outlives its turn, unless this is the hidden review turn. */
export function startCtoQuietTurn(state: CtoQuietTurnState): void {
  state.quiet = state.reviewPending ? { turnId: null, review: true } : null;
  state.reviewPending = false;
}

/**
 * Applies one committed event to the state, in place. Returns true when the
 * event must be dropped: text the CTO wrote after ending its turn quietly, or
 * anything it wrote or thought in the hidden review turn.
 */
export function stepCtoQuietTurn(state: CtoQuietTurnState, event: AgentChatEvent, provider: AgentChatProvider): boolean {
  if (event.type === "done") {
    state.reactTarget = null;
    state.reviewPending = false;
    // A turn the person stopped starts no hidden review.
    if (event.status === "interrupted") state.correction = null;
    if (state.quiet && (!state.quiet.turnId || event.turnId === state.quiet.turnId)) state.quiet = null;
    return false;
  }
  if (event.type === "user_message") {
    const key = userMessageReactionKey(event);
    if (ctoTurnReadsPersonMessage(event, provider)) {
      state.reactTarget = key;
      state.reviewPending = false;
      const correction = ctoCorrectionExcerpt(event.text);
      if (correction) state.correction = correction;
    } else if (event.metadata?.hostContinuation?.reason === CTO_REVIEW_REASON) {
      // ADE's hidden review: the turn that reads it writes nothing visible.
      // It is a wake the turn reads, so it must not reopen itself below.
      state.quiet = { turnId: null, review: true };
      state.reviewPending = true;
      return false;
    } else if (key && key === state.reactTarget) {
      // The target steer turned out unread (the turn ended first, or it failed).
      state.reactTarget = null;
    }
    // The turn read something new (the person, or a child reporting with its
    // proof mid-turn): what comes next may answer it.
    if (ctoTurnReadsNewMessage(event, provider)) state.quiet = null;
    return false;
  }
  if ((event.type === "text" || (event.type === "reasoning" && state.quiet?.review)) && state.quiet) {
    const eventTurnId = event.turnId?.trim() || null;
    return !state.quiet.turnId || !eventTurnId || eventTurnId === state.quiet.turnId;
  }
  return false;
}
