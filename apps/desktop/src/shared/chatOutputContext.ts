export const CHAT_OUTPUT_CONTEXT_CHIP_LABEL = "Chat context";
export const CHAT_OUTPUT_CONTEXT_OPEN = "<ade-chat-context>";
export const CHAT_OUTPUT_CONTEXT_CLOSE = "</ade-chat-context>";
export const CHAT_OUTPUT_CONTEXT_PREAMBLE =
  "The user highlighted the following text from your previous output and added it as context:";
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
  if (inner.startsWith(CHAT_OUTPUT_CONTEXT_PREAMBLE)) {
    return inner.slice(CHAT_OUTPUT_CONTEXT_PREAMBLE.length).replace(/^\n+/, "");
  }
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

export function formatChatOutputContextBlock(selectedText: string): string | null {
  const clipped = neutralizeChatOutputContextText(normalizeNewlines(selectedText).trim());
  if (!clipped) return null;
  const quote = clipChatOutputContextQuote(clipped);
  return `${CHAT_OUTPUT_CONTEXT_OPEN}\n${CHAT_OUTPUT_CONTEXT_PREAMBLE}\n\n${quote}\n${CHAT_OUTPUT_CONTEXT_CLOSE}`;
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
