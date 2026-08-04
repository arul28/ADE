// Grammar + send-time expansion for composer @-mentions of ADE chats, lanes,
// and terminals. Pure and surface-agnostic on purpose: the desktop composer,
// the `ade code` TUI, and iOS all serialize the same chip tokens, and the chat
// service expands them in exactly one place (see `prepareChatMentionExpansion`
// callers in agentChatService).
//
// Design invariants:
//   - A mention is a pointer. We never inline a whole transcript; the preview
//     is hard-capped and the block tells the agent how to read more itself.
//   - Expansion is deterministic (no AI summarization) so the same draft always
//     produces the same prompt text.
//   - The user-visible transcript keeps the raw `@chat:<id>` chip; only the
//     provider-bound prompt text carries the expanded blocks.

import type { ChatMentionDetail, ChatMentionKind } from "./types/chatMentions";

/** Chip token prefix per kind. `term` is deliberately short for typing. */
const CHAT_MENTION_TOKEN_PREFIX: Record<ChatMentionKind, string> = {
  chat: "chat",
  lane: "lane",
  terminal: "term",
};

// Derived from the prefix table above so the grammar has exactly one source of
// truth: adding a kind cannot leave the parser or the chip matcher behind.
const PREFIX_TO_KIND: Record<string, ChatMentionKind> = Object.fromEntries(
  (Object.entries(CHAT_MENTION_TOKEN_PREFIX) as Array<[ChatMentionKind, string]>)
    .map(([kind, prefix]) => [prefix, kind]),
);

const TOKEN_PREFIX_ALTERNATION = Object.values(CHAT_MENTION_TOKEN_PREFIX).join("|");

/** Canonical kind order (menu sections, suggestion payloads, mocks). */
export const CHAT_MENTION_KINDS = Object.keys(CHAT_MENTION_TOKEN_PREFIX) as ChatMentionKind[];

/** Max rows the suggestion action will ever return for a single kind. */
export const CHAT_MENTION_MAX_PER_KIND = 8;

/** Hard cap on the preview body of a single expansion block, in characters. */
export const CHAT_MENTION_PREVIEW_MAX_CHARS = 1024;

/** Cap on how many distinct mentions one message will expand. */
export const CHAT_MENTION_MAX_PER_MESSAGE = 12;

// Ids are opaque (uuids, slugs). `:` is excluded so the prefix split is
// unambiguous, and the token must sit at a word boundary so emails and
// `foo@chat:bar` substrings never match.
const MENTION_TOKEN_SOURCE =
  `(?:^|[\\s(\\[{,])@(${TOKEN_PREFIX_ALTERNATION}):([A-Za-z0-9._-]+)`;

/** Serialize one mention into its chip/draft token form. */
export function formatChatMentionToken(kind: ChatMentionKind, id: string): string {
  return `@${CHAT_MENTION_TOKEN_PREFIX[kind]}:${id}`;
}

const MENTION_TOKEN_BODY_RE = new RegExp(
  `^(?:${TOKEN_PREFIX_ALTERNATION}):[A-Za-z0-9._-]+$`,
);

/**
 * True when a bare `@`-token body (the text after `@`) is a mention pointer.
 * Purely syntactic — used by the plain-textarea chip overlay, which has no
 * side table of confirmed mentions the way it has for file attachments.
 */
export function isChatMentionTokenBody(body: string): boolean {
  return MENTION_TOKEN_BODY_RE.test(body);
}

export type ParsedChatMention = {
  kind: ChatMentionKind;
  id: string;
  /** The matched token text, e.g. `@chat:abc123`. */
  token: string;
  /** Offset of the `@` within the source text. */
  start: number;
  end: number;
};

/**
 * Find every mention token in `text`, in document order. Overlapping/duplicate
 * ids are all returned; callers dedupe when they only want one block per id.
 */
export function parseChatMentions(text: string): ParsedChatMention[] {
  if (!text || !text.includes("@")) return [];
  const re = new RegExp(MENTION_TOKEN_SOURCE, "g");
  const out: ParsedChatMention[] = [];
  for (const match of text.matchAll(re)) {
    const prefix = match[1]!;
    const id = match[2]!;
    const kind = PREFIX_TO_KIND[prefix];
    if (!kind) continue;
    const token = `@${prefix}:${id}`;
    // match[0] may include one leading boundary char; anchor on the `@`.
    const start = (match.index ?? 0) + match[0]!.length - token.length;
    out.push({ kind, id, token, start, end: start + token.length });
  }
  return out;
}

/**
 * Deduped, order-preserving mention list, capped so a pathological draft can
 * never fan out into an unbounded number of transcript reads at send time.
 */
export function collectChatMentionTargets(
  text: string,
  max = CHAT_MENTION_MAX_PER_MESSAGE,
): Array<{ kind: ChatMentionKind; id: string }> {
  const seen = new Set<string>();
  const out: Array<{ kind: ChatMentionKind; id: string }> = [];
  for (const mention of parseChatMentions(text)) {
    const key = `${mention.kind}:${mention.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: mention.kind, id: mention.id });
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Truncate to `max` characters on a line boundary when one is close enough,
 * appending an explicit marker so the agent knows content was elided (and can
 * decide to run the read command in the block).
 */
export function truncateMentionPreview(
  text: string,
  max = CHAT_MENTION_PREVIEW_MAX_CHARS,
): string {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd();
  if (normalized.length <= max) return normalized;
  const head = normalized.slice(0, max);
  const lastBreak = head.lastIndexOf("\n");
  const body = lastBreak > max * 0.5 ? head.slice(0, lastBreak) : head;
  return `${body.trimEnd()}\n… (truncated — read more with the command above)`;
}

/** Escape a value for use inside a double-quoted XML-ish attribute. */
function escapeAttributeValue(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // Attributes are single-line by contract; collapse any embedded breaks.
    .replace(/[\r\n\t]+/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();
}

/** Keep single-line metadata (titles, branches) short and predictable. */
function sanitizeMentionAttribute(value: string, max = 160): string {
  const escaped = escapeAttributeValue(value);
  return escaped.length <= max ? escaped : `${escaped.slice(0, max - 1)}…`;
}

const CHAT_MENTION_BLOCK_HEADER =
  "Referenced ADE entities (pointers, not attachments — read more with the commands below):";

/**
 * Defang a preview body before it is embedded in a block.
 *
 * Preview bodies are the only attacker-influenceable part of an expansion: a
 * terminal's scrollback or another chat's transcript can contain whatever text
 * a webpage, dependency, or remote collaborator put there. Left alone, such a
 * body could close the block early (`</ade-mention>`) and then forge a sibling
 * block or a second "Referenced ADE entities" section, making arbitrary text
 * look like ADE-authored metadata to the model.
 *
 * Runs AFTER truncation on purpose: truncating afterwards could split a marker
 * in half and let a partial `<ade-mention` survive at the cut point.
 */
function neutralizeMentionPreviewBody(body: string): string {
  return body
    .replace(/<\/ade-mention/gi, "‹/ade-mention")
    .replace(/<ade-mention/gi, "‹ade-mention")
    .split(CHAT_MENTION_BLOCK_HEADER)
    .join(`› ${CHAT_MENTION_BLOCK_HEADER}`);
}

/**
 * Render one `<ade-mention>` block. The closing tag is on its own line so a
 * multi-line preview can never be confused with the block boundary.
 */
export function renderChatMentionBlock(detail: ChatMentionDetail): string {
  const attrs = [
    ["kind", detail.kind],
    ["id", detail.id],
    ["title", detail.title],
    ...detail.attributes,
  ]
    .filter(([, value]) => typeof value === "string" && value.trim().length > 0)
    .map(([name, value]) => `${name}="${sanitizeMentionAttribute(String(value))}"`)
    .join(" ");

  const lines = [`<ade-mention ${attrs}>`, detail.hint.trim()];
  const preview = detail.preview?.trim();
  if (preview) {
    lines.push(detail.previewLabel?.trim() || "Preview (truncated):");
    lines.push(neutralizeMentionPreviewBody(truncateMentionPreview(preview)));
  }
  lines.push("</ade-mention>");
  return lines.join("\n");
}

/** Exact separator `appendChatMentionBlocks` writes before the block list. */
const CHAT_MENTION_BLOCK_MARKER = `\n\n${CHAT_MENTION_BLOCK_HEADER}\n`;

/**
 * Append the rendered mention blocks to the outgoing prompt text. The original
 * tokens stay inline so the agent can see *where* each entity was referenced;
 * the blocks are the resolution table for those tokens.
 */
export function appendChatMentionBlocks(text: string, blocks: string[]): string {
  if (!blocks.length) return text;
  return `${text.trimEnd()}${CHAT_MENTION_BLOCK_MARKER}${blocks.join("\n")}`;
}

/**
 * Move the expansion blocks from `source` onto `target`.
 *
 * Used when a later rewrite replaces the prompt body wholesale (a provider
 * slash command expands `/review @lane:x` into the command's markdown), which
 * would otherwise drop the blocks the send path already resolved. A no-op when
 * `source` carries no blocks, or when `target` already contains them — some
 * command templates interpolate `$ARGUMENTS` and thus keep them by themselves.
 */
export function carryChatMentionBlocks(source: string, target: string): string {
  const index = source.indexOf(CHAT_MENTION_BLOCK_MARKER);
  if (index < 0) return target;
  if (target.includes(CHAT_MENTION_BLOCK_HEADER)) return target;
  return `${target.trimEnd()}${source.slice(index)}`;
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/**
 * Match score for one candidate against a lowercased query. Lower is better;
 * `null` means "no match, drop the row". Mirrors the tiering the ⌘K palette
 * uses: exact > prefix > substring > subsequence.
 */
function scoreChatMentionMatch(
  haystack: string,
  loweredQuery: string,
): number | null {
  if (!loweredQuery.length) return 0;
  const target = haystack.toLowerCase();
  if (target === loweredQuery) return 0;
  if (target.startsWith(loweredQuery)) return 1;
  if (target.includes(loweredQuery)) return 2;
  // Subsequence fallback: every query char appears in order.
  let cursor = 0;
  for (const char of loweredQuery) {
    const found = target.indexOf(char, cursor);
    if (found < 0) return null;
    cursor = found + 1;
  }
  return 3;
}

/**
 * Rank suggestions for one kind: recency-first for an empty query, fuzzy match
 * tier + recency tie-break when typing. Deterministic (id asc) as a final
 * tie-break so repeated keystrokes never reshuffle equal rows.
 */
export function rankChatMentionSuggestions<
  T extends { id: string; title: string; subtitle?: string; lastActivityAt?: number | null },
>(candidates: T[], query: string, limit: number): T[] {
  const trimmed = query.trim().toLowerCase();
  const scored: Array<{ item: T; score: number }> = [];
  for (const item of candidates) {
    if (!trimmed.length) {
      scored.push({ item, score: 0 });
      continue;
    }
    const titleScore = scoreChatMentionMatch(item.title, trimmed);
    const subtitleScore = item.subtitle
      ? scoreChatMentionMatch(item.subtitle, trimmed)
      : null;
    // A subtitle hit is always weaker than any title hit.
    const score = titleScore ?? (subtitleScore === null ? null : subtitleScore + 4);
    if (score === null) continue;
    scored.push({ item, score });
  }
  scored.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    const aAt = a.item.lastActivityAt ?? 0;
    const bAt = b.item.lastActivityAt ?? 0;
    if (aAt !== bAt) return bAt - aAt;
    return a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0;
  });
  return scored.slice(0, Math.max(0, limit)).map((entry) => entry.item);
}

/**
 * Marker used when a mention token cannot be resolved (deleted chat, archived
 * lane, terminal from another machine). Kept explicit so the agent does not
 * silently ignore a token the user clearly meant.
 */
export function renderUnresolvedChatMentionBlock(
  kind: ChatMentionKind,
  id: string,
): string {
  return renderChatMentionBlock({
    kind,
    id,
    title: "(unresolved)",
    attributes: [["resolved", "false"]],
    hint:
      `No ${kind} with this id is available in the active project on this machine. ` +
      "It may have been archived, deleted, or it belongs to another project. Do not guess its contents.",
  });
}
