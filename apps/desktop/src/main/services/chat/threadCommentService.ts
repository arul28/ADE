import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Logger } from "../logging/logger";
import { writeFileAtomic } from "../state/durableFile";
import {
  MAX_THREAD_COMMENTS_PER_SESSION,
  MAX_THREAD_COMMENT_BODY_CHARS,
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

const SESSION_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,200}$/;

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

  const fileFor = (sessionId: string): string => {
    if (!SESSION_ID_PATTERN.test(sessionId) || sessionId.includes("..")) {
      throw new Error("Invalid chat session id.");
    }
    return path.join(dir, `${sessionId.replace(/:/g, "_")}.json`);
  };

  const read = (sessionId: string): ChatThreadComment[] => {
    const cached = cache.get(sessionId);
    if (cached) return cached;
    let comments: ChatThreadComment[] = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(fileFor(sessionId), "utf8")) as Partial<ThreadCommentFile>;
      if (Array.isArray(parsed.comments)) {
        comments = parsed.comments.filter((comment): comment is ChatThreadComment => (
          Boolean(comment)
          && typeof comment.id === "string"
          && typeof comment.messageKey === "string"
          && normalizeThreadCommentAnchor(comment.anchor) !== null
        ));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        logger.warn("agent_chat.thread_comments_read_failed", {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    cache.set(sessionId, comments);
    return comments;
  };

  const write = (sessionId: string, comments: ChatThreadComment[]): void => {
    const filePath = fileFor(sessionId);
    if (comments.length === 0) {
      fs.rmSync(filePath, { force: true });
    } else {
      fs.mkdirSync(dir, { recursive: true });
      const file: ThreadCommentFile = { version: 1, comments };
      writeFileAtomic(filePath, JSON.stringify(file));
    }
    cache.set(sessionId, comments);
    onChanged(sessionId, comments);
  };

  const cleanBody = (body: unknown): string => {
    if (typeof body !== "string") return "";
    return body.replace(/\r\n?/g, "\n").trim().slice(0, MAX_THREAD_COMMENT_BODY_CHARS);
  };

  const list = ({ sessionId }: { sessionId: string }): ChatThreadComment[] => read(sessionId);

  const create = (args: ChatThreadCommentCreateArgs): ChatThreadComment => {
    const anchor = normalizeThreadCommentAnchor(args.anchor);
    if (!anchor) throw new Error("A comment needs the text or table row it is about.");
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
      messageExcerpt: collapseWhitespace(typeof args.messageExcerpt === "string" ? args.messageExcerpt : "").slice(0, 120),
      anchor,
      body,
      includeInNextSend: true,
      createdAt: at,
      updatedAt: at,
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
    const next: ChatThreadComment = {
      ...previous,
      body,
      includeInNextSend: typeof args.includeInNextSend === "boolean" ? args.includeInNextSend : previous.includeInNextSend,
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
  const takeForSend = (sessionId: string): { block: string | null; count: number; restore: () => void } => {
    const current = read(sessionId);
    const taken = current.filter((comment) => comment.includeInNextSend);
    if (!taken.length) return { block: null, count: 0, restore: () => {} };
    const block = formatThreadReviewBlock(taken);
    write(sessionId, current.filter((comment) => !comment.includeInNextSend));
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
          write(sessionId, [...taken.filter((comment) => !present.has(comment.id)), ...latest]);
        } catch (error) {
          logger.warn("agent_chat.thread_comments_restore_failed", {
            sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    };
  };

  /** Drops a deleted chat's comments without telling clients (the chat is gone). */
  const forgetSession = (sessionId: string): void => {
    cache.delete(sessionId);
    try {
      fs.rmSync(fileFor(sessionId), { force: true });
    } catch {
      // Best effort: an orphaned file is a few KB and never read again.
    }
  };

  return { list, create, update, delete: remove, takeForSend, forgetSession };
}
