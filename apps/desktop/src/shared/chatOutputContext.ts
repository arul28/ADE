export const CHAT_OUTPUT_CONTEXT_CHIP_LABEL = "Quote";
export const CHAT_OUTPUT_CONTEXT_OPEN = "<ade-chat-context>";
export const CHAT_OUTPUT_CONTEXT_CLOSE = "</ade-chat-context>";
/**
 * Tells the agent what the quote is AND that the prose after the block is the
 * user's reply to it. Without the second half, three quotes and three replies
 * read as one ramble, and the agent has to guess which reply goes with which.
 */
export const CHAT_OUTPUT_CONTEXT_PREAMBLE =
  "The user quoted this from your earlier output. The text that follows this block, up to the next quote, is their reply to it:";
const CHAT_CONTEXT_REPLY_CLAUSE = "The text that follows this block, up to the next quote, is their reply to it:";
/**
 * A quote from somewhere other than the agent's own output (a pull request's
 * description, a review thread) names where it is from in the same sentence.
 * One line, so it strips as one line when the message renders.
 */
const SOURCED_CHAT_CONTEXT_PREAMBLE = /^The user quoted this from [^\n]+\. The text that follows this block, up to the next quote, is their reply to it:(?=\n|$)/;

function sourcedChatContextPreamble(source: string): string {
  const where = source.replace(/\s+/g, " ").replace(/[.:]+$/, "").trim();
  return `The user quoted this from ${where}. ${CHAT_CONTEXT_REPLY_CLAUSE}`;
}

/** Preambles older messages were sent with. Still stripped when they render. */
const LEGACY_CHAT_OUTPUT_CONTEXT_PREAMBLES = [
  "The user highlighted the following text from your previous output and added it as context:",
];
export const MAX_CHAT_OUTPUT_CONTEXT_CHARS = 16_384;

export type ChatOutputContextMatch = {
  start: number;
  end: number;
  block: string;
  quote: string;
};

export type ChatOutputContextSegment =
  | { kind: "text"; text: string }
  | { kind: "context"; quote: string; block: string };

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function neutralizeChatOutputContextText(text: string): string {
  return text.replace(/<\/?ade-chat-context>/gi, (match) =>
    match.replace(/ade-chat-context/i, "ade-chat-context\u200b"),
  );
}

export function hasChatOutputContext(text: string): boolean {
  return text.includes(CHAT_OUTPUT_CONTEXT_OPEN);
}

export function extractChatOutputContextQuote(block: string): string {
  const open = block.indexOf(CHAT_OUTPUT_CONTEXT_OPEN);
  const close = block.lastIndexOf(CHAT_OUTPUT_CONTEXT_CLOSE);
  if (open < 0 || close < 0 || close <= open) return "";
  const inner = block
    .slice(open + CHAT_OUTPUT_CONTEXT_OPEN.length, close)
    .replace(/^\n/, "")
    .replace(/\n$/, "");
  for (const preamble of [CHAT_OUTPUT_CONTEXT_PREAMBLE, ...LEGACY_CHAT_OUTPUT_CONTEXT_PREAMBLES]) {
    if (inner.startsWith(preamble)) return inner.slice(preamble.length).replace(/^\n+/, "");
  }
  const sourced = SOURCED_CHAT_CONTEXT_PREAMBLE.exec(inner);
  if (sourced) return inner.slice(sourced[0].length).replace(/^\n+/, "");
  return inner;
}

function clipChatOutputContextQuote(text: string): string {
  if (text.length <= MAX_CHAT_OUTPUT_CONTEXT_CHARS) return text;
  let end = MAX_CHAT_OUTPUT_CONTEXT_CHARS;
  const last = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
    end -= 1;
  }
  return text.slice(0, end);
}

/**
 * The quote block a composer takes. `source` says where the text is from when
 * it is not the agent's own output: "the description of pull request #12".
 */
export function formatChatOutputContextBlock(selectedText: string, source?: string | null): string | null {
  const clipped = neutralizeChatOutputContextText(normalizeNewlines(selectedText).trim());
  if (!clipped) return null;
  const quote = clipChatOutputContextQuote(clipped);
  const preamble = source?.trim() ? sourcedChatContextPreamble(neutralizeChatOutputContextText(source)) : CHAT_OUTPUT_CONTEXT_PREAMBLE;
  return `${CHAT_OUTPUT_CONTEXT_OPEN}\n${preamble}\n\n${quote}\n${CHAT_OUTPUT_CONTEXT_CLOSE}`;
}

export function parseChatOutputContextBlocks(text: string): ChatOutputContextMatch[] {
  const matches: ChatOutputContextMatch[] = [];
  let from = 0;
  while (from < text.length) {
    const start = text.indexOf(CHAT_OUTPUT_CONTEXT_OPEN, from);
    if (start < 0) break;
    const closeAt = text.indexOf(CHAT_OUTPUT_CONTEXT_CLOSE, start + CHAT_OUTPUT_CONTEXT_OPEN.length);
    if (closeAt < 0) break;
    const end = closeAt + CHAT_OUTPUT_CONTEXT_CLOSE.length;
    const block = text.slice(start, end);
    matches.push({
      start,
      end,
      block,
      quote: extractChatOutputContextQuote(block),
    });
    from = end;
  }
  return matches;
}

export function splitChatOutputContextSegments(text: string): ChatOutputContextSegment[] {
  const matches = parseChatOutputContextBlocks(text);
  if (!matches.length) return [{ kind: "text", text }];
  const segments: ChatOutputContextSegment[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start > cursor) {
      segments.push({ kind: "text", text: text.slice(cursor, match.start) });
    }
    segments.push({ kind: "context", quote: match.quote, block: match.block });
    cursor = match.end;
  }
  if (cursor < text.length) {
    segments.push({ kind: "text", text: text.slice(cursor) });
  }
  return segments;
}
