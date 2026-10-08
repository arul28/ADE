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
 *
 * One exception keeps commenting instant: a comment this client is still
 * creating shows at once (`addLocalThreadComment`) and stays on top of
 * whatever list the host reports until its create call answers.
 */
const EMPTY: ChatThreadComment[] = [];
const bySession = new Map<string, ChatThreadComment[]>();
/** Comments this client created whose create call has not answered yet. */
const localBySession = new Map<string, ChatThreadComment[]>();
/** Host list plus local comments, rebuilt on every write so reads stay stable. */
const visibleBySession = new Map<string, ChatThreadComment[]>();
/** Bumped on every write, so a list that started before a live update cannot overwrite it. */
const writeVersion = new Map<string, number>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function publish(sessionId: string): void {
  const host = bySession.get(sessionId) ?? EMPTY;
  const local = localBySession.get(sessionId) ?? EMPTY;
  visibleBySession.set(sessionId, local.length ? [...host, ...local] : host);
  notify();
}

export function setThreadComments(sessionId: string, comments: ChatThreadComment[]): void {
  bySession.set(sessionId, comments);
  writeVersion.set(sessionId, (writeVersion.get(sessionId) ?? 0) + 1);
  publish(sessionId);
}

const LOCAL_ID_PREFIX = "local:";

/** True for a comment shown before its host has it; it has no host id to act on yet. */
export function isLocalThreadComment(comment: Pick<ChatThreadComment, "id">): boolean {
  return comment.id.startsWith(LOCAL_ID_PREFIX);
}

/**
 * Shows a comment before the host has saved it. Returns `settle`: pass the
 * host's comment on success (it joins the list unless an update already
 * brought it) or nothing on failure (it disappears).
 */
export function addLocalThreadComment(
  sessionId: string,
  fields: Omit<ChatThreadComment, "id" | "sessionId" | "includeInNextSend" | "createdAt" | "updatedAt">,
): (saved?: ChatThreadComment | null) => void {
  const at = new Date().toISOString();
  const local: ChatThreadComment = {
    ...fields,
    id: `${LOCAL_ID_PREFIX}${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`,
    sessionId,
    includeInNextSend: true,
    createdAt: at,
    updatedAt: at,
  };
  localBySession.set(sessionId, [...(localBySession.get(sessionId) ?? EMPTY), local]);
  publish(sessionId);
  return (saved) => {
    const remaining = (localBySession.get(sessionId) ?? EMPTY).filter((comment) => comment.id !== local.id);
    if (remaining.length) localBySession.set(sessionId, remaining);
    else localBySession.delete(sessionId);
    const host = bySession.get(sessionId) ?? EMPTY;
    if (saved && !host.some((comment) => comment.id === saved.id)) {
      setThreadComments(sessionId, [...host, saved]);
      return;
    }
    publish(sessionId);
  };
}

/** Removes a comment at once; the host's next list confirms or restores it. */
export function removeThreadCommentLocally(sessionId: string, commentId: string): void {
  const host = bySession.get(sessionId);
  if (!host?.some((comment) => comment.id === commentId)) return;
  setThreadComments(sessionId, host.filter((comment) => comment.id !== commentId));
}

/** Applies an edit at once; the host's next list confirms or replaces it. */
export function patchThreadComment(
  sessionId: string,
  commentId: string,
  patch: Partial<Pick<ChatThreadComment, "body" | "includeInNextSend">>,
): void {
  const host = bySession.get(sessionId);
  if (!host?.some((comment) => comment.id === commentId)) return;
  setThreadComments(sessionId, host.map((comment) => (comment.id === commentId ? { ...comment, ...patch } : comment)));
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
  return sessionId ? visibleBySession.get(sessionId) ?? EMPTY : EMPTY;
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
