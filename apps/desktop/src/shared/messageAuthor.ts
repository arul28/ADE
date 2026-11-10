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
