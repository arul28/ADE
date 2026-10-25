/**
 * What a user-message row shows, decided once.
 *
 * The transcript renderer draws a user-message row from this, and find (⌘F)
 * searches the same text, so the two cannot drift: a branch added here is a
 * branch both of them take. Pure: no React, no components.
 */
import type { AgentChatEvent } from "../../../shared/types/chat";
import { splitChatOutputContextSegments, type ChatOutputContextSegment } from "../../../shared/chatOutputContext";
import { parseThreadReviewBlock, type ParsedThreadReviewComment } from "../../../shared/threadComments";

type UserMessageEvent = Extract<AgentChatEvent, { type: "user_message" }>;
type BoardMove = NonNullable<NonNullable<UserMessageEvent["metadata"]>["boardMove"]>;
type PrWatchWake = NonNullable<NonNullable<UserMessageEvent["metadata"]>["prWatchWake"]>;
type TerminalWatchWake = NonNullable<NonNullable<UserMessageEvent["metadata"]>["terminalWatchWake"]>;
/** A watch wake (PR or terminal): only its id and card are drawn. */
type WatchWake = { watchId: string; card: NonNullable<PrWatchWake["card"] | TerminalWatchWake["card"]> };

type UserMessageBody =
  /** A board move ADE sent on the user's behalf: one centred line, not a bubble. */
  | { kind: "board-move"; move: BoardMove; line: string }
  /** ADE woke the agent for a PR change or terminal output: a card, with the agent's text folded away. */
  | { kind: "wake-card"; wake: WatchWake }
  /** A hidden prompt (a brief, a handoff): only its short display line shows. */
  | { kind: "brief"; text: string }
  /** A send that carried thread comments: the review card, then what the user typed. */
  | { kind: "review"; comments: ParsedThreadReviewComment[]; typed: string }
  /** What the user typed, which may hold "Add to chat" quotes (`UserTypedText`). */
  | { kind: "typed"; text: string }
  /** Plain or markdown text. */
  | { kind: "text"; text: string; markdown: boolean }
  /** Leading context chips (iOS) and/or quote cards, then the rest as plain text. */
  | { kind: "chips"; chips: string[]; rest: string; segments: ChatOutputContextSegment[] | null };

const MARKDOWN_HEADING_LINE = /^#{1,6}\s+\S/m;
const MARKDOWN_FENCE_LINE = /^\s*(```|~~~)/m;
const MARKDOWN_LIST_LINE = /^\s*(?:[-*+]|\d+[.)])\s+\S/gm;

/**
 * True when a user message is a markdown DOCUMENT (a handoff brief, a pasted
 * spec), not a chat line that happens to contain an asterisk. Such a message
 * renders as formatted markdown; everything else keeps its exact text.
 */
export function userTextLooksLikeMarkdown(text: string): boolean {
  if (text.length < 80) return false;
  if (MARKDOWN_HEADING_LINE.test(text) || MARKDOWN_FENCE_LINE.test(text)) return true;
  return (text.match(MARKDOWN_LIST_LINE)?.length ?? 0) >= 3;
}

/** The send carried a pasted-text prompt file: `text` holds it, `displayText` is what was typed. */
export function userMessageHasPastedPrompt(event: UserMessageEvent): boolean {
  return event.attachments?.some(
    (attachment) => attachment.type === "file" && attachment.intent === "user_prompt",
  ) === true;
}

/**
 * Mirror the cyan chip pill the composer renders when an iOS-inspect packet is
 * staged. Sent user messages keep the same backtick-wrapped label tokens at the
 * front of `event.text`, so they are re-promoted to the same chip treatment.
 * Without this they render as inline-code-styled text and reviewers can't tell
 * the message actually carried packet context. Only when the closing backtick
 * is followed by a token boundary; adjacent text (`ctx`message) stays code.
 */
function parseLeadingIosContextChips(text: string): { chips: string[]; rest: string } {
  const chips: string[] = [];
  let i = 0;
  while (i < text.length && text[i] === "`") {
    const close = text.indexOf("`", i + 1);
    if (close === -1) break;
    const inner = text.slice(i + 1, close);
    if (!inner.length || inner.includes("`") || inner.includes("\n")) break;
    const next = text[close + 1];
    const atValidBoundary =
      next === undefined
      || next === " "
      || next === "\t"
      || next === "\n"
      || next === ","
      || next === "."
      || next === ":"
      || next === ";";
    if (!atValidBoundary) break;
    chips.push(inner);
    i = close + 1;
    if (next === " ") {
      i += 1;
      continue;
    }
    break;
  }
  return { chips, rest: text.slice(i) };
}

export function resolveUserMessageBody(event: UserMessageEvent): UserMessageBody {
  const boardMove = event.metadata?.boardMove;
  if (boardMove) return { kind: "board-move", move: boardMove, line: event.displayText?.trim() || event.text };
  const wake = event.metadata?.prWatchWake ?? event.metadata?.terminalWatchWake;
  if (wake?.card) return { kind: "wake-card", wake: { watchId: wake.watchId, card: wake.card } };
  const displayText = event.displayText?.trim() ?? "";
  if (event.metadata?.hideFullPrompt === true) return { kind: "brief", text: displayText };
  const pastedPrompt = userMessageHasPastedPrompt(event);
  const review = parseThreadReviewBlock(event.text);
  if (review) {
    return { kind: "review", comments: review.comments, typed: pastedPrompt ? displayText : displayText || review.rest.trim() };
  }
  // `text` is what the provider received (mention blocks expanded);
  // `displayText` is what the user typed. Show only what they typed.
  if (pastedPrompt) return { kind: "typed", text: displayText };
  if (displayText && displayText !== event.text.trim()) {
    return { kind: "text", text: displayText, markdown: userTextLooksLikeMarkdown(displayText) };
  }
  const parsed = parseLeadingIosContextChips(event.text);
  const segments = splitChatOutputContextSegments(parsed.rest);
  const hasOutputContext = segments.some((segment) => segment.kind === "context");
  if (!parsed.chips.length && !hasOutputContext) {
    return { kind: "text", text: event.text, markdown: userTextLooksLikeMarkdown(event.text) };
  }
  return { kind: "chips", chips: parsed.chips, rest: parsed.rest, segments: hasOutputContext ? segments : null };
}

/** Text of quote segments as the row draws them: quotes, then the typed runs. */
function segmentsText(segments: readonly ChatOutputContextSegment[]): string {
  return segments.map((segment) => (segment.kind === "context" ? segment.quote : segment.text)).join("\n");
}

/** The row's searchable text and whether it is drawn as markdown; null when it shows none. */
export function userMessageBodySearchText(body: UserMessageBody): { text: string; markdown: boolean } | null {
  switch (body.kind) {
    case "board-move":
      return body.line ? { text: body.line, markdown: false } : null;
    case "wake-card":
      // The card is ADE's chrome; the agent's text is folded away.
      return null;
    case "brief":
      return { text: body.text, markdown: false };
    case "review":
    case "typed": {
      const text = body.kind === "review" ? body.typed : body.text;
      const segments = splitChatOutputContextSegments(text);
      return segments.some((segment) => segment.kind === "context")
        ? { text: segmentsText(segments), markdown: false }
        : { text, markdown: userTextLooksLikeMarkdown(text) };
    }
    case "text":
      return { text: body.text, markdown: body.markdown };
    case "chips":
      return { text: [...body.chips, body.segments ? segmentsText(body.segments) : body.rest].join("\n"), markdown: false };
  }
}
