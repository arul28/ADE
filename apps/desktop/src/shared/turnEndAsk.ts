/**
 * Did a finished turn's reply ask the user something?
 *
 * Only consulted when a chat's turn ends while it still owns live background
 * work. Canonical state promotes that chat to `running`, so a question in the
 * reply sits under Working where nobody looks. Agents are told to call
 * `ade chat ask` for any question, but with subagents still running they often
 * do not consider themselves blocked. This check raises the hand for them.
 *
 * The rules read only the end of the reply, where a turn-ending question lives,
 * and are deliberately cheap. `unsure` means a cheap model gets to decide, for
 * providers that have one.
 */

export type TurnEndAskVerdict = "ask" | "not_ask" | "unsure";

export type TurnEndAskClassification = {
  verdict: TurnEndAskVerdict;
  /** The question to show on the row. Set only for `ask`. */
  question: string | null;
};

/** A question mark, or a direct request for an answer or decision. */
const STRONG_ASK = new RegExp(
  [
    String.raw`\btell me\b`,
    String.raw`\byour call\b`,
    String.raw`\bwhich (one|ones|of these|of those|do you|would you)\b`,
    String.raw`\b(should|shall) i\b`,
    String.raw`\bdo you want\b`,
    String.raw`\bwould you (like|prefer|rather)\b`,
    String.raw`\bwant me to\b`,
    String.raw`\b(pick|choose) (one|between|either)\b`,
    String.raw`\byou (pick|choose|decide)\b`,
    String.raw`(^|[.!:;]\s+)(pick|choose|decide)\b`,
    String.raw`\bneed (a decision|your (go-ahead|ok|okay|approval|answer|input|call|decision))\b`,
  ].join("|"),
  "i",
);

/** A conditional hand-back: an offer the user may or may not take up. */
const SOFT_ASK = new RegExp(
  [
    String.raw`\blet me know\b`,
    String.raw`\bsay (so|the word)\b`,
    String.raw`\bif you('d| would)? (want|like|prefer)\b`,
    String.raw`\bup to you\b`,
    String.raw`\bonce you('ve| have)? (picked|chosen|decided|confirmed)\b`,
    String.raw`\b(if|when) you('re| are) happy\b`,
    String.raw`\bwaiting on you\b`,
  ].join("|"),
  "i",
);

/** The shapes of "work continues, I'll be back": no answer wanted. */
const PROGRESS_NOTE = new RegExp(
  [
    String.raw`\b(is|are|still) (running|working|going)\b`,
    String.raw`\bstill (waiting|in progress)\b`,
    String.raw`\bwaiting (on|for) (the|its|their|both|each|it|them)\b`,
    String.raw`\bi'll (report|review|get back|come back|let you know|ping you|follow up|update you|pull)[^.?]*\b(when|once|as|after)\b`,
    String.raw`\b(when|once|as soon as|after) (it|they|(both|each|all|the)( [\w-]+){0,3}) (reports?|finish(es)?|lands?|arrives?|comes? back|(is|are) (done|back))\b`,
    String.raw`\bbefore reporting\b`,
    String.raw`\breport(ing)? back\b`,
    String.raw`\bget back to you\b`,
  ].join("|"),
  "i",
);

const LIST_ITEM = /^\s*([-*•]|\d+[.)])\s+/;

/** Code, links and inline markup carry question marks and words nobody is asking. */
function stripNonProse(text: string): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_]{1,3}/g, "")
    .replace(/[‘’]/g, "'");
}

function paragraphs(text: string): string[] {
  return stripNonProse(text)
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0 && !/^[-=_*\s]+$/.test(block));
}

/** The last paragraph, plus its lead-in when it is a list under "…:". */
function closingBlock(blocks: string[]): { closing: string; before: string | null } {
  let end = blocks.length - 1;
  let closing = blocks[end] ?? "";
  if (end > 0 && LIST_ITEM.test(closing) && /:\s*$/.test(blocks[end - 1] ?? "")) {
    end -= 1;
    closing = `${blocks[end]}\n${closing}`;
  }
  return { closing, before: end > 0 ? blocks[end - 1] ?? null : null };
}

function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.replace(LIST_ITEM, "").trim())
    .filter(Boolean);
}

const MAX_QUESTION_CHARS = 280;

function clipQuestion(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_QUESTION_CHARS ? `${flat.slice(0, MAX_QUESTION_CHARS - 1).trimEnd()}…` : flat;
}

/**
 * The sentence that asks, for the row's hand-raise message: the last literal
 * question first, then a direct ask, then a conditional one.
 */
function questionFrom(...blocks: Array<string | null>): string {
  const all = blocks.flatMap((block) => (block ? sentences(block) : []));
  const latest = (test: (sentence: string) => boolean) => [...all].reverse().find(test);
  const asking = latest((sentence) => sentence.includes("?"))
    ?? latest((sentence) => STRONG_ASK.test(sentence))
    ?? latest((sentence) => SOFT_ASK.test(sentence));
  return clipQuestion(asking ?? all[all.length - 1] ?? "");
}

function hasStrongAsk(block: string): boolean {
  return block.includes("?") || STRONG_ASK.test(block);
}

export function classifyTurnEndAsk(replyText: string | null | undefined): TurnEndAskClassification {
  const blocks = paragraphs(String(replyText ?? ""));
  if (!blocks.length) return { verdict: "not_ask", question: null };
  const { closing, before } = closingBlock(blocks);
  const progress = PROGRESS_NOTE.test(closing);

  if (hasStrongAsk(closing)) return { verdict: "ask", question: questionFrom(closing) };
  if (SOFT_ASK.test(closing)) {
    // "If you're happy with this, I'll…" usually closes a question asked just above.
    return progress
      ? { verdict: "unsure", question: null }
      : { verdict: "ask", question: questionFrom(before, closing) };
  }
  // A question followed by a one-line status ("…, or a placeholder?\n\nBoth
  // agents are still working.") still ended the turn on that question.
  if (before && before.includes("?")) {
    return progress
      ? { verdict: "ask", question: questionFrom(before) }
      : { verdict: "unsure", question: null };
  }
  if (progress) return { verdict: "not_ask", question: null };
  return { verdict: "unsure", question: null };
}

// ── Cheap-model tiebreaker ──────────────────────────────────────────────────

export const TURN_END_ASK_USER_MESSAGE_CHARS = 600;
export const TURN_END_ASK_REPLY_TAIL_CHARS = 1_500;

export const TURN_END_ASK_SYSTEM_PROMPT = [
  "You read the end of an AI coding agent's reply to its user.",
  "Decide whether the reply ends by asking the user to answer, choose, approve, or decide something before the agent continues.",
  "A progress update (work is running, the agent will report back later) is not an ask, even if it mentions what comes next.",
  "An offer the user must accept or decline (\"want me to…\", \"if you want X, say so\") is an ask.",
  'Answer with JSON only: {"asksUser": true} or {"asksUser": false}.',
].join(" ");

export const TURN_END_ASK_JSON_SCHEMA = {
  type: "object",
  properties: { asksUser: { type: "boolean" } },
  required: ["asksUser"],
  additionalProperties: false,
} as const;

function tail(text: string, chars: number): string {
  const trimmed = text.trim();
  return trimmed.length > chars ? `…${trimmed.slice(trimmed.length - chars)}` : trimmed;
}

function head(text: string, chars: number): string {
  const trimmed = text.trim();
  return trimmed.length > chars ? `${trimmed.slice(0, chars)}…` : trimmed;
}

export function buildTurnEndAskPrompt(args: { userMessage: string | null; replyText: string }): string {
  const user = head(args.userMessage ?? "", TURN_END_ASK_USER_MESSAGE_CHARS) || "(none)";
  return [
    "The user's last message:",
    user,
    "",
    "The end of the agent's reply:",
    tail(args.replyText, TURN_END_ASK_REPLY_TAIL_CHARS),
  ].join("\n");
}

/** `null` when the model's answer is not a clear boolean: treat as no answer. */
export function parseTurnEndAskDecision(structured: unknown, text: string | null | undefined): boolean | null {
  const fromObject = (value: unknown): boolean | null => {
    if (!value || typeof value !== "object") return null;
    const asks = (value as { asksUser?: unknown }).asksUser;
    return typeof asks === "boolean" ? asks : null;
  };
  const direct = fromObject(structured);
  if (direct !== null) return direct;
  const match = String(text ?? "").match(/\{[^{}]*"asksUser"\s*:\s*(true|false)[^{}]*\}/);
  return match ? match[1] === "true" : null;
}

/** The hand-raise message for an ask the model found but the rules could not quote. */
export function fallbackTurnEndQuestion(replyText: string): string {
  const blocks = paragraphs(replyText);
  const { closing, before } = closingBlock(blocks);
  return questionFrom(before, closing || replyText);
}
