/**
 * Thread comments: notes the user pins to parts of an agent's reply, held as
 * pending until a send carries them to the agent as one structured review.
 *
 * Everything here is pure so the host (which builds the block on send), the
 * renderer (which shows the sent card) and the tests share one format.
 */

/** The comment actions, in every list that must name them (policy, preload, RPC guard, mobile). */
export const THREAD_COMMENT_ACTION_NAMES = [
  "listThreadComments",
  "createThreadComment",
  "updateThreadComment",
  "deleteThreadComment",
] as const;

const THREAD_REVIEW_OPEN = "<ade-review>";
const THREAD_REVIEW_CLOSE = "</ade-review>";
// Every change sends the whole list to every client of the chat, so these
// bound one update: 50 x (2k quote + 4k note) stays well under a megabyte.
export const MAX_THREAD_COMMENT_QUOTE_CHARS = 2_000;
export const MAX_THREAD_COMMENT_BODY_CHARS = 4_000;
export const MAX_THREAD_COMMENT_EXCERPT_CHARS = 120;
export const MAX_THREAD_COMMENTS_PER_SESSION = 50;
const MAX_TABLE_ROW_CELLS = 16;
const MAX_TABLE_CELL_CHARS = 200;
/** Characters of text kept on each side of a quote to find it again. */
export const THREAD_COMMENT_CONTEXT_CHARS = 32;

export type ChatThreadCommentAnchor =
  | {
      kind: "text";
      /** The selected text, whitespace-collapsed. */
      quote: string;
      /** Up to {@link THREAD_COMMENT_CONTEXT_CHARS} chars before / after, to tell repeats apart. */
      prefix: string;
      suffix: string;
    }
  | {
      kind: "table_row";
      /** 0-based table index inside the message. */
      tableIndex: number;
      /** 0-based body-row index inside that table. */
      rowIndex: number;
      headers: string[];
      cells: string[];
    };

export type ChatThreadComment = {
  id: string;
  sessionId: string;
  /** The message's stable row identity (`sceneRowIdentity`). */
  messageKey: string;
  /** The first words of the message, so the agent knows which reply. */
  messageExcerpt: string;
  anchor: ChatThreadCommentAnchor;
  body: string;
  /** False = held: stays in the thread, does not go with the next send. */
  includeInNextSend: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ChatThreadCommentCreateArgs = {
  sessionId: string;
  messageKey: string;
  messageExcerpt: string;
  anchor: ChatThreadCommentAnchor;
  body: string;
};

export type ChatThreadCommentUpdateArgs = {
  sessionId: string;
  commentId: string;
  body?: string;
  includeInNextSend?: boolean;
};

export type ChatThreadCommentDeleteArgs = {
  sessionId: string;
  commentId: string;
};

export type ChatThreadCommentListArgs = { sessionId: string };

export type ChatThreadCommentsChangedEvent = {
  sessionId: string;
  comments: ChatThreadComment[];
};

export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Cuts to `max` chars without splitting a surrogate pair. No ellipsis: a cut quote must still be found in the reply. */
function cut(value: string, max: number): string {
  if (value.length <= max) return value;
  let end = max;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${cut(value, max).trimEnd()}\u2026`;
}

/** Stop text from closing or opening the block early. */
function neutralize(value: string): string {
  return value.replace(/<(\/?)(ade-review|comment|quote|note)\b/gi, "<$1$2​");
}

function attr(value: string): string {
  return neutralize(value).replace(/"/g, "”").replace(/\s+/g, " ").trim();
}

export function threadCommentQuoteText(anchor: ChatThreadCommentAnchor): string {
  if (anchor.kind === "text") return anchor.quote;
  return anchor.cells
    .map((cell, index) => {
      const header = anchor.headers[index]?.trim();
      return header ? `${header}: ${cell}` : cell;
    })
    .join(" | ");
}

export function threadCommentSourceLabel(comment: Pick<ChatThreadComment, "messageExcerpt" | "anchor">): string {
  const excerpt = clip(collapseWhitespace(comment.messageExcerpt), 60);
  const base = excerpt ? `your reply that starts \u201c${excerpt}\u201d` : "one of your earlier replies";
  if (comment.anchor.kind === "table_row") {
    return `${base}, table ${comment.anchor.tableIndex + 1}, row ${comment.anchor.rowIndex + 1}`;
  }
  return base;
}

/**
 * The text the agent receives for a set of comments, or null for none.
 * Each quote and its note sit in one `<comment>`, so the agent cannot pair a
 * note with the wrong quote, and `n` lets it answer "On comment 2: ...".
 */
export function formatThreadReviewBlock(comments: readonly Pick<ChatThreadComment, "messageExcerpt" | "anchor" | "body">[]): string | null {
  const usable = comments.filter((comment) => comment.body.trim() || threadCommentQuoteText(comment.anchor).trim());
  if (!usable.length) return null;
  const count = usable.length;
  const lines = [
    THREAD_REVIEW_OPEN,
    `The user left ${count} comment${count === 1 ? "" : "s"} on your earlier output. Each comment quotes the part it refers to. Answer each comment.`,
  ];
  usable.forEach((comment, index) => {
    const quote = neutralize(clip(threadCommentQuoteText(comment.anchor).trim(), MAX_THREAD_COMMENT_QUOTE_CHARS));
    const note = neutralize(clip(comment.body.trim(), MAX_THREAD_COMMENT_BODY_CHARS));
    lines.push(
      "",
      `<comment n="${index + 1}" source="${attr(threadCommentSourceLabel(comment))}">`,
      `<quote>${quote}</quote>`,
      `<note>${note}</note>`,
      "</comment>",
    );
  });
  lines.push(THREAD_REVIEW_CLOSE);
  return lines.join("\n");
}

export type ParsedThreadReviewComment = {
  n: number;
  source: string;
  quote: string;
  note: string;
};

export type ParsedThreadReview = {
  comments: ParsedThreadReviewComment[];
  /** The message text with the block removed. */
  rest: string;
};

/** Reads a leading review block back for display; null when the text has none. */
export function parseThreadReviewBlock(text: string): ParsedThreadReview | null {
  const { block, rest } = splitLeadingThreadReview(text);
  if (!block) return null;
  const inner = block.slice(THREAD_REVIEW_OPEN.length, block.length - THREAD_REVIEW_CLOSE.length);
  const comments: ParsedThreadReviewComment[] = [];
  const pattern = /<comment n="(\d+)" source="([^"]*)">\n<quote>([\s\S]*?)<\/quote>\n<note>([\s\S]*?)<\/note>\n<\/comment>/g;
  // Undo `neutralize` for display: the guard is for the agent, not the user.
  const restore = (value: string) => value.replace(/<(\/?)(ade-review|comment|quote|note)\u200b/gi, "<$1$2");
  for (const match of inner.matchAll(pattern)) {
    comments.push({
      n: Number(match[1]),
      source: match[2] ?? "",
      quote: restore(match[3] ?? ""),
      note: restore(match[4] ?? ""),
    });
  }
  if (!comments.length) return null;
  return { comments, rest };
}

/** How a send that carried only comments reads: "1 comment", "3 comments". */
export function threadReviewCountLabel(count: number): string {
  return `${count} comment${count === 1 ? "" : "s"}`;
}

/** Splits a leading review block off a message: `{ block, rest }`, block null when there is none. */
export function splitLeadingThreadReview(text: string): { block: string | null; rest: string } {
  const start = text.indexOf(THREAD_REVIEW_OPEN);
  if (start < 0 || text.slice(0, start).trim()) return { block: null, rest: text };
  const end = text.indexOf(THREAD_REVIEW_CLOSE, start);
  if (end < 0) return { block: null, rest: text };
  const close = end + THREAD_REVIEW_CLOSE.length;
  return { block: text.slice(start, close), rest: text.slice(close).replace(/^\s+/, "") };
}

/** Prefixes the review block to what the user typed. */
export function prependThreadReview(text: string, block: string | null): string {
  if (!block) return text;
  return text.trim() ? `${block}\n\n${text}` : block;
}

/** Returns a normalized anchor, or null when it carries nothing to find. */
export function normalizeThreadCommentAnchor(anchor: unknown): ChatThreadCommentAnchor | null {
  if (!anchor || typeof anchor !== "object") return null;
  const value = anchor as Record<string, unknown>;
  if (value.kind === "text") {
    const quote = typeof value.quote === "string" ? cut(collapseWhitespace(value.quote), MAX_THREAD_COMMENT_QUOTE_CHARS) : "";
    if (!quote) return null;
    const side = (raw: unknown, fromEnd: boolean) => {
      if (typeof raw !== "string") return "";
      const flat = raw.replace(/\s+/g, " ");
      return fromEnd ? flat.slice(-THREAD_COMMENT_CONTEXT_CHARS) : flat.slice(0, THREAD_COMMENT_CONTEXT_CHARS);
    };
    return { kind: "text", quote, prefix: side(value.prefix, true), suffix: side(value.suffix, false) };
  }
  if (value.kind === "table_row") {
    const tableIndex = Number(value.tableIndex);
    const rowIndex = Number(value.rowIndex);
    if (!Number.isInteger(tableIndex) || tableIndex < 0 || !Number.isInteger(rowIndex) || rowIndex < 0) return null;
    const strings = (raw: unknown) => (Array.isArray(raw)
      ? raw.slice(0, MAX_TABLE_ROW_CELLS).map((cell) => cut(collapseWhitespace(String(cell ?? "")), MAX_TABLE_CELL_CHARS))
      : []);
    const cells = strings(value.cells);
    if (!cells.some(Boolean)) return null;
    return { kind: "table_row", tableIndex, rowIndex, headers: strings(value.headers), cells };
  }
  return null;
}

/**
 * True for a `session_meta_updated` event that only carries the comment list.
 * It is not chat activity: no recency bump, no session-list or roster refresh.
 */
export function isThreadCommentsOnlyMetaEvent(event: { type: string }): boolean {
  if (event.type !== "session_meta_updated" || (event as { threadComments?: unknown }).threadComments === undefined) return false;
  return Object.keys(event).every((key) => key === "type" || key === "threadComments" || key === "turnId");
}
