import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Logger } from "../logging/logger";
import { writeFileAtomic } from "../state/durableFile";
import { parseMessageAuthor } from "../../../shared/messageAuthor";
import type { AdeMessageAuthor } from "../../../shared/types/chat";
import {
  MAX_THREAD_COMMENTS_PER_SESSION,
  MAX_THREAD_COMMENT_BODY_CHARS,
  MAX_THREAD_COMMENT_EXCERPT_CHARS,
  collapseWhitespace,
  formatThreadReviewBlock,
  normalizeThreadCommentAnchor,
  type ChatThreadComment,
  type ChatThreadCommentCreateArgs,
  type ChatThreadCommentDeleteArgs,
  type ChatThreadCommentUpdateArgs,
} from "../../../shared/threadComments";

/**
 * Pending thread comments, owned by the machine that hosts the chat.
 *
 * Kept in a per-session JSON file beside the chat's own state, not in a synced
 * table: every client of this chat (this desktop, a remote desktop, the phone)
 * already talks to this host, and a new CRR table would wedge replication for
 * any peer still on an older build. Changes reach clients as a
 * `session_meta_updated` event carrying the whole list.
 */
export type ThreadCommentService = ReturnType<typeof createThreadCommentService>;

type ThreadCommentFile = { version: 1; comments: ChatThreadComment[] };

/** The one rule for a chat id that may name a comment file. */
export function isThreadCommentSessionId(sessionId: string): boolean {
  return /^[A-Za-z0-9_.:-]{1,200}$/.test(sessionId) && !sessionId.includes("..");
}

/**
 * A comment read back from disk, with every field the send path relies on
 * checked and the anchor normalized; null for an entry that is not one.
 */
function normalizeStoredComment(entry: unknown, sessionId: string): ChatThreadComment | null {
  if (!entry || typeof entry !== "object") return null;
  const value = entry as Record<string, unknown>;
  const anchor = normalizeThreadCommentAnchor(value.anchor);
  if (!anchor || typeof value.id !== "string" || typeof value.messageKey !== "string" || typeof value.body !== "string") return null;
  const at = typeof value.createdAt === "string" ? value.createdAt : new Date(0).toISOString();
  return {
    id: value.id,
    sessionId,
    messageKey: value.messageKey,
    messageExcerpt: typeof value.messageExcerpt === "string" ? value.messageExcerpt : "",
    anchor,
    body: value.body,
    includeInNextSend: value.includeInNextSend !== false,
    createdAt: at,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : at,
    ...withStoredAuthor(value.author),
  };
}

/**
 * Old comments have no author and read as the host's own user. The stored
 * author is display data written by the host, not proof of authorship: the
 * chat's files sit in the owner's project, which the owner's own machines
 * can change, so nothing may grant or refuse a right because of it.
 */
function withStoredAuthor(value: unknown): { author?: AdeMessageAuthor } {
  const author = parseMessageAuthor(value);
  return author ? { author } : {};
}

export function createThreadCommentService({
  chatSessionsDir,
  logger,
  onChanged,
  now = () => new Date().toISOString(),
}: {
  chatSessionsDir: string;
  logger: Pick<Logger, "warn">;
  /** Called with the full list after every change. */
  onChanged: (sessionId: string, comments: ChatThreadComment[]) => void;
  now?: () => string;
}) {
  const dir = path.join(chatSessionsDir, "thread-comments");
  const cache = new Map<string, ChatThreadComment[]>();
  /**
   * Sessions whose in-memory list is newer than the file: a restore whose write
   * failed keeps the comments visible here and retries persistence on the next
   * read or write, so a transient disk failure cannot lose them.
   */
  const pendingPersist = new Set<string>();

  /**
   * Whether a comment goes with the next send. A lane-sharing guest's
   * comment goes only when the owner names it (`guestIds`): its text would
   * otherwise reach the agent in the owner's turn, under the owner's
   * permission mode.
   */
  const goesWithSend = (comment: ChatThreadComment, guestIds: ReadonlySet<string>): boolean => {
    if (comment.author?.kind === "guest") return guestIds.has(comment.id);
    return comment.includeInNextSend;
  };

  const fileFor = (sessionId: string): string => {
    if (!isThreadCommentSessionId(sessionId)) {
      throw new Error("Invalid chat session id.");
    }
    // Reversible: `a:b` and `a_b` must never share a file. `encodeURIComponent`
    // maps every accepted id to a distinct, path-safe name (the charset check
    // above already rejects `..` and path separators).
    return path.join(dir, `${encodeURIComponent(sessionId)}.json`);
  };

  const read = (sessionId: string): ChatThreadComment[] => {
    const cached = cache.get(sessionId);
    if (cached) {
      flushPendingPersist(sessionId);
      return cache.get(sessionId) ?? cached;
    }
    let comments: ChatThreadComment[] = [];
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(fileFor(sessionId), "utf8"));
      const stored = parsed && typeof parsed === "object" ? (parsed as { comments?: unknown }).comments : null;
      if (Array.isArray(stored)) {
        comments = stored.flatMap((entry) => {
          const comment = normalizeStoredComment(entry, sessionId);
          return comment ? [comment] : [];
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        logger.warn("agent_chat.thread_comments_read_failed", {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        // A transient failure (EACCES, EBUSY, a torn file) must not be cached
        // as "no comments": a later create would then overwrite the file and
        // erase comments that were never read. Propagate instead.
        throw error;
      }
    }
    cache.set(sessionId, comments);
    return comments;
  };

  const persist = (sessionId: string, comments: ChatThreadComment[]): void => {
    const filePath = fileFor(sessionId);
    if (comments.length === 0) {
      fs.rmSync(filePath, { force: true });
    } else {
      fs.mkdirSync(dir, { recursive: true });
      const file: ThreadCommentFile = { version: 1, comments };
      writeFileAtomic(filePath, JSON.stringify(file));
    }
  };

  /** Retries a restore whose write failed, without overwriting newer disk state. */
  const flushPendingPersist = (sessionId: string): void => {
    if (!pendingPersist.has(sessionId)) return;
    const comments = cache.get(sessionId);
    if (!comments) {
      pendingPersist.delete(sessionId);
      return;
    }
    try {
      persist(sessionId, comments);
      pendingPersist.delete(sessionId);
    } catch {
      // Still down; the list stays in memory and is retried on the next call.
    }
  };

  const write = (sessionId: string, comments: ChatThreadComment[]): void => {
    persist(sessionId, comments);
    cache.set(sessionId, comments);
    pendingPersist.delete(sessionId);
    onChanged(sessionId, comments);
  };

  const cleanBody = (body: unknown): string => {
    if (typeof body !== "string") return "";
    return body.replace(/\r\n?/g, "\n").trim().slice(0, MAX_THREAD_COMMENT_BODY_CHARS);
  };

  const list = ({ sessionId }: { sessionId: string }): ChatThreadComment[] => read(sessionId);

  /**
   * `args` comes from a caller and its `author` is never read. The host
   * passes the author it verified in `options` (lane sharing).
   */
  const create = (
    args: ChatThreadCommentCreateArgs,
    options: { author?: AdeMessageAuthor | null } = {},
  ): ChatThreadComment => {
    const anchor = normalizeThreadCommentAnchor(args.anchor);
    if (!anchor) throw new Error("A comment needs the text, table row, image or video it is about.");
    const messageKey = typeof args.messageKey === "string" ? args.messageKey.trim() : "";
    if (!messageKey) throw new Error("A comment needs the message it is about.");
    const body = cleanBody(args.body);
    if (!body) throw new Error("Write a comment first.");
    const current = read(args.sessionId);
    if (current.length >= MAX_THREAD_COMMENTS_PER_SESSION) {
      throw new Error(`A chat can hold ${MAX_THREAD_COMMENTS_PER_SESSION} comments. Send or delete some first.`);
    }
    const at = now();
    const comment: ChatThreadComment = {
      id: randomUUID(),
      sessionId: args.sessionId,
      messageKey,
      messageExcerpt: collapseWhitespace(typeof args.messageExcerpt === "string" ? args.messageExcerpt : "").slice(0, MAX_THREAD_COMMENT_EXCERPT_CHARS),
      anchor,
      body,
      // A guest's comment waits until the owner ticks it (`goesWithSend`).
      includeInNextSend: options.author?.kind !== "guest",
      createdAt: at,
      updatedAt: at,
      ...withStoredAuthor(options.author),
    };
    write(args.sessionId, [...current, comment]);
    return comment;
  };

  const update = (args: ChatThreadCommentUpdateArgs): ChatThreadComment => {
    const current = read(args.sessionId);
    const index = current.findIndex((comment) => comment.id === args.commentId);
    if (index < 0) throw new Error("That comment no longer exists.");
    const previous = current[index]!;
    const body = args.body === undefined ? previous.body : cleanBody(args.body);
    if (!body) throw new Error("A comment cannot be empty. Delete it instead.");
    // The owner ticked a guest's comment for the text it had: new text waits for a new tick.
    const guestTextChanged = previous.author?.kind === "guest" && body !== previous.body;
    const next: ChatThreadComment = {
      ...previous,
      body,
      includeInNextSend: typeof args.includeInNextSend === "boolean"
        ? args.includeInNextSend
        : guestTextChanged ? false : previous.includeInNextSend,
      updatedAt: now(),
    };
    const comments = [...current];
    comments[index] = next;
    write(args.sessionId, comments);
    return next;
  };

  const remove = (args: ChatThreadCommentDeleteArgs): { deleted: boolean } => {
    const current = read(args.sessionId);
    const comments = current.filter((comment) => comment.id !== args.commentId);
    if (comments.length === current.length) return { deleted: false };
    write(args.sessionId, comments);
    return { deleted: true };
  };

  /**
   * Removes the comments marked for the next send and returns the block they
   * make. `restore` puts them back, for a send that fails before it delivers.
   * Held comments stay where they are.
   */
  const takeForSend = (
    sessionId: string,
    options: { guestCommentIds?: readonly string[] | null } = {},
  ): { block: string | null; count: number; restore: () => void } => {
    const current = read(sessionId);
    const guestIds = new Set(options.guestCommentIds ?? []);
    const goes = (comment: ChatThreadComment) => goesWithSend(comment, guestIds);
    const taken = current.filter(goes);
    if (!taken.length) return { block: null, count: 0, restore: () => {} };
    const block = formatThreadReviewBlock(taken);
    write(sessionId, current.filter((comment) => !goes(comment)));
    let restored = false;
    return {
      block,
      count: taken.length,
      restore: () => {
        if (restored) return;
        restored = true;
        try {
          const latest = read(sessionId);
          const present = new Set(latest.map((comment) => comment.id));
          const merged = [...taken.filter((comment) => !present.has(comment.id)), ...latest];
          try {
            write(sessionId, merged);
          } catch (error) {
            logger.warn("agent_chat.thread_comments_restore_failed", {
              sessionId,
              error: error instanceof Error ? error.message : String(error),
            });
            // A transient write failure must not lose the comments: keep them in
            // memory and retry persistence on the next read or write.
            cache.set(sessionId, merged);
            pendingPersist.add(sessionId);
          }
        } catch (error) {
          logger.warn("agent_chat.thread_comments_restore_failed", {
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    };
  };

  /** True when a send with `includeThreadComments` would carry at least one comment. */
  const hasCommentsForSend = (sessionId: string): boolean =>
    isThreadCommentSessionId(sessionId) && read(sessionId).some((comment) => goesWithSend(comment, new Set()));

  /** Drops a deleted chat's comments without telling clients (the chat is gone). */
  const forgetSession = (sessionId: string): void => {
    cache.delete(sessionId);
    try {
      fs.rmSync(fileFor(sessionId), { force: true });
    } catch {
      // Best effort: an orphaned file is a few KB and never read again.
    }
  };

  return { list, create, update, delete: remove, takeForSend, hasCommentsForSend, forgetSession };
}
