import { useEffect, useSyncExternalStore } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import type { ChatThreadComment } from "../../../shared/threadComments";

/**
 * Pending thread comments per chat, as last reported by the chat's host.
 *
 * The host is the only writer. This store holds its latest full list: a
 * `list` call on open fills it, and every `session_meta_updated` event that
 * carries `threadComments` replaces it, so every client of the chat sees
 * the same list without merging anything.
 */
const EMPTY: ChatThreadComment[] = [];
const bySession = new Map<string, ChatThreadComment[]>();
/** Bumped on every write, so a list that started before a live update cannot overwrite it. */
const writeVersion = new Map<string, number>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function setThreadComments(sessionId: string, comments: ChatThreadComment[]): void {
  bySession.set(sessionId, comments);
  writeVersion.set(sessionId, (writeVersion.get(sessionId) ?? 0) + 1);
  notify();
}

/** Loads the host's list, unless a live update lands while the call is out. */
export function refreshThreadComments(sessionId: string, pin: OpenProjectBinding | null | undefined): Promise<void> {
  const api = threadCommentsApi();
  if (!api) return Promise.resolve();
  const startedAt = writeVersion.get(sessionId) ?? 0;
  return api.list({ sessionId }, pin ?? null)
    .then((list) => {
      if (Array.isArray(list) && (writeVersion.get(sessionId) ?? 0) === startedAt) setThreadComments(sessionId, list);
    })
    .catch(() => {
      // An older host has no comment actions; the chat simply has none.
    });
}

function getThreadComments(sessionId: string | null | undefined): ChatThreadComment[] {
  return sessionId ? bySession.get(sessionId) ?? EMPTY : EMPTY;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The API, when this client has it (an older preload or a mock may not). */
export function threadCommentsApi() {
  return typeof window === "undefined" ? undefined : window.ade?.agentChat?.threadComments;
}

/**
 * Subscribes to one chat's comments and loads them when the chat opens.
 * Pass a null session to opt out (subagent views, drafts).
 */
export function useThreadComments(
  sessionId: string | null | undefined,
  pin: OpenProjectBinding | null | undefined,
): ChatThreadComment[] {
  const comments = useSyncExternalStore(subscribe, () => getThreadComments(sessionId), () => EMPTY);
  useEffect(() => {
    if (sessionId) void refreshThreadComments(sessionId, pin);
  }, [pin, sessionId]);
  return comments;
}

/** How many comments go with the next send. */
export function countCommentsForNextSend(comments: readonly ChatThreadComment[]): number {
  let count = 0;
  for (const comment of comments) if (comment.includeInNextSend) count += 1;
  return count;
}

/** Asks the open thread to scroll to a comment and open it. */
export const THREAD_COMMENT_FOCUS_EVENT = "ade:thread-comment-focus";

export function requestThreadCommentFocus(comment: ChatThreadComment): void {
  window.dispatchEvent(new CustomEvent(THREAD_COMMENT_FOCUS_EVENT, { detail: { sessionId: comment.sessionId, commentId: comment.id } }));
}
