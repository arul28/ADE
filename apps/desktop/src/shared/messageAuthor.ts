import type { AdeMessageAuthor } from "./types/chat";

/**
 * The author of a person-side message, draft or thread comment (lane
 * sharing). The rule is the one `AgentChatRuntimeActor` follows: the host
 * stamps it from what it verified, and any value a caller sends is removed
 * first. An absent author reads as the host's own user, which is how every
 * row written before lane sharing reads.
 */

const MAX_USER_ID_CHARS = 256;
const MAX_NAME_CHARS = 200;

/** A stored author, or null for a missing or malformed one (= the host's own user). */
export function parseMessageAuthor(value: unknown): AdeMessageAuthor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.kind !== "host" && record.kind !== "guest") return null;
  const userId = typeof record.userId === "string" ? record.userId.trim() : "";
  if (!userId || userId.length > MAX_USER_ID_CHARS) return null;
  const name = typeof record.name === "string" && record.name.trim()
    ? record.name.trim().slice(0, MAX_NAME_CHARS)
    : null;
  return { kind: record.kind, userId, name };
}

/** Whether the row was written by a guest. Missing or malformed authors are the host. */
export function isGuestAuthored(value: unknown): boolean {
  return parseMessageAuthor(value)?.kind === "guest";
}

/**
 * `args` with any caller-sent `metadata.author` removed, and the host's own
 * `author` set when it passes one. The only way an author reaches a message.
 */
export function withHostMessageAuthor<T extends { metadata?: Record<string, unknown> | null | undefined }>(
  args: T,
  author?: AdeMessageAuthor | null,
): T {
  const metadata = args.metadata;
  const hostAuthor = author ? parseMessageAuthor(author) : null;
  const hasClientAuthor = Boolean(metadata && Object.prototype.hasOwnProperty.call(metadata, "author"));
  if (!hasClientAuthor && !hostAuthor) return args;
  const { author: _clientAuthor, ...rest } = metadata ?? {};
  const nextMetadata = hostAuthor ? { ...rest, author: hostAuthor } : rest;
  return {
    ...args,
    metadata: Object.keys(nextMetadata).length > 0 ? nextMetadata : (metadata == null ? metadata : null),
  };
}

/**
 * The refusal code for a guest message that starts with a command character.
 * A guest's text is a plain prompt: the host interprets none of it.
 */
export const LANE_SHARE_PLAIN_TEXT_ONLY = "lane_share_plain_text_only" as const;

export const LANE_SHARE_PLAIN_TEXT_ONLY_MESSAGE =
  "On a shared lane, a message cannot start with / or !. Start it with a word.";

/** Characters that ADE or a provider reads as a command at the start of a message. */
const PROMPT_COMMAND_CHARACTERS = ["/", "!"] as const;

/**
 * The command character `text` starts with, or null. Leading white space and
 * invisible format characters are skipped, and the text is NFKC normalized
 * first, so a full-width or zero-width disguise reads as the plain form. Each
 * parser in the chat service (slash commands of every provider, `!` shell
 * drafts, `/side`, `/memory`, `/goal`, Muse skills) starts its match at the
 * first visible character, so this finds every text they would interpret.
 * `extra` adds characters for a surface that reads more of them (a CLI TUI).
 */
export function leadingPromptCommandCharacter(text: string, extra: readonly string[] = []): string | null {
  const visible = text.normalize("NFKC").replace(/^[\s\p{Cf}]+/u, "");
  const first = visible.charAt(0);
  if (!first) return null;
  return (PROMPT_COMMAND_CHARACTERS as readonly string[]).includes(first) || extra.includes(first) ? first : null;
}

/**
 * Whether a message is a plain prompt: written by a guest, so the host runs
 * no command, slash command, shell draft or mention expansion on its text.
 * The author is set only by the host (`withHostMessageAuthor`), never by a
 * caller, so a client cannot turn this off.
 */
export function isPlainPromptMessage(metadata: { author?: unknown } | null | undefined): boolean {
  return isGuestAuthored(metadata?.author);
}
