import { useEffect, useSyncExternalStore } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import { threadCommentQuoteText, threadCommentRevision, type ChatThreadComment, type ChatThreadCommentAnchor, type ChatThreadCommentSelection } from "../../../shared/threadComments";
import { withChatPin } from "./chatMachinePin";

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
  dropFailedCommentsTheHostHas(sessionId);
  publish(sessionId);
}

const LOCAL_ID_PREFIX = "local:";

/** True for a comment shown before its host has it; it has no host id to act on yet. */
export function isLocalThreadComment(commentId: string): boolean {
  return commentId.startsWith(LOCAL_ID_PREFIX);
}

/**
 * Local comments whose create call failed. They stay in the list (with Retry
 * and Discard) instead of vanishing, never ride a send, and keep what a retry
 * needs: the host ids that existed before the first attempt, so a save that
 * landed after all is found instead of made twice (create is not idempotent).
 */
type FailedLocalComment = { error: string; knownHostIds: ReadonlySet<string> };
const failedLocal = new Map<string, FailedLocalComment>();
/** Host ids present when each local comment was first created. */
const knownHostIdsByLocal = new Map<string, ReadonlySet<string>>();

/** The reason a local comment failed to save, or null while it is fine. */
export function threadCommentSaveError(commentId: string): string | null {
  return failedLocal.get(commentId)?.error ?? null;
}

/** A host comment that is this local comment, saved by an attempt whose answer never came back. */
function hostCopyOf(local: ChatThreadComment, host: readonly ChatThreadComment[], known: ReadonlySet<string>): ChatThreadComment | null {
  const quote = threadCommentQuoteText(local.anchor);
  return host.find((comment) => (
    !known.has(comment.id)
    && comment.messageKey === local.messageKey
    && comment.body.trim() === local.body.trim()
    && threadCommentQuoteText(comment.anchor) === quote
  )) ?? null;
}

function dropLocal(sessionId: string, localId: string): void {
  const remaining = (localBySession.get(sessionId) ?? EMPTY).filter((comment) => comment.id !== localId);
  if (remaining.length) localBySession.set(sessionId, remaining);
  else localBySession.delete(sessionId);
  failedLocal.delete(localId);
  knownHostIdsByLocal.delete(localId);
}

/** A failed comment the host's list now holds was saved after all: the host's copy replaces it. */
function dropFailedCommentsTheHostHas(sessionId: string): void {
  const host = bySession.get(sessionId) ?? EMPTY;
  for (const local of localBySession.get(sessionId) ?? EMPTY) {
    const failed = failedLocal.get(local.id);
    if (failed && hostCopyOf(local, host, failed.knownHostIds)) dropLocal(sessionId, local.id);
  }
}

/**
 * Shows a comment before the host has saved it. Returns `settle`: pass the
 * host's comment on success (it joins the list unless an update already
 * brought it). On failure pass null and the error: the comment stays, marked
 * failed (`threadCommentSaveError`), unless the host's list shows it landed
 * anyway. Null with no error drops it.
 */
export function addLocalThreadComment(
  sessionId: string,
  fields: Omit<ChatThreadComment, "id" | "sessionId" | "includeInNextSend" | "createdAt" | "updatedAt">,
): (saved?: ChatThreadComment | null, error?: string) => void {
  const at = new Date().toISOString();
  const local: ChatThreadComment = {
    ...fields,
    id: `${LOCAL_ID_PREFIX}${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`,
    sessionId,
    includeInNextSend: true,
    createdAt: at,
    updatedAt: at,
  };
  knownHostIdsByLocal.set(local.id, new Set((bySession.get(sessionId) ?? EMPTY).map((comment) => comment.id)));
  localBySession.set(sessionId, [...(localBySession.get(sessionId) ?? EMPTY), local]);
  publish(sessionId);
  return settleLocal(sessionId, local);
}

function settleLocal(sessionId: string, local: ChatThreadComment) {
  return (saved?: ChatThreadComment | null, error?: string) => {
    // Discarded while the call was out: nothing to settle.
    if (!(localBySession.get(sessionId) ?? EMPTY).some((comment) => comment.id === local.id)) return;
    const host = bySession.get(sessionId) ?? EMPTY;
    const known = knownHostIdsByLocal.get(local.id) ?? new Set<string>();
    if (!saved && error && !hostCopyOf(local, host, known)) {
      failedLocal.set(local.id, { error, knownHostIds: known });
      publish(sessionId);
      return;
    }
    dropLocal(sessionId, local.id);
    if (saved && !host.some((comment) => comment.id === saved.id)) {
      setThreadComments(sessionId, [...host, saved]);
      return;
    }
    publish(sessionId);
  };
}

/** Drops a comment that failed to save. */
export function discardFailedThreadComment(sessionId: string, commentId: string): void {
  if (!failedLocal.has(commentId)) return;
  dropLocal(sessionId, commentId);
  publish(sessionId);
}

/**
 * Saves a failed comment again. The first attempt's answer was lost, not
 * necessarily its save: read the host's list first and keep its copy if one
 * is there, and only create when none is.
 */
export async function retryFailedThreadComment(
  sessionId: string,
  commentId: string,
  pin: OpenProjectBinding | null | undefined,
  describeError: (error: unknown) => string,
): Promise<void> {
  const failed = failedLocal.get(commentId);
  const local = (localBySession.get(sessionId) ?? EMPTY).find((comment) => comment.id === commentId);
  const api = threadCommentsApi();
  if (!failed || !local || !api) return;
  failedLocal.delete(commentId);
  publish(sessionId);
  const settle = settleLocal(sessionId, local);
  try {
    const list = await withChatPin(pin ?? null, (chatPin) => api.list({ sessionId }, chatPin));
    if (Array.isArray(list)) {
      setThreadComments(sessionId, list);
      const landed = hostCopyOf(local, list, failed.knownHostIds);
      if (landed) {
        settle(landed);
        return;
      }
    }
    const { messageKey, messageExcerpt, anchor, body } = local;
    settle(await withChatPin(pin ?? null, (chatPin) => api.create({ sessionId, messageKey, messageExcerpt, anchor, body }, chatPin)));
  } catch (error) {
    settle(null, describeError(error));
  }
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
  return withChatPin(pin ?? null, (chatPin) => api.list({ sessionId }, chatPin))
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

/**
 * The lane-sharing guest comments the owner ticked: a send names each one with
 * the body revision shown here (`includeGuestComments`).
 */
export function guestCommentsForNextSend(comments: readonly ChatThreadComment[]): ChatThreadCommentSelection[] {
  return comments
    .filter((comment) => comment.includeInNextSend && comment.author?.kind === "guest")
    .map((comment) => ({ id: comment.id, revision: threadCommentRevision(comment) }));
}

/** How many comments go with the next send. One that failed to save never does. */
export function countCommentsForNextSend(comments: readonly ChatThreadComment[]): number {
  let count = 0;
  for (const comment of comments) if (comment.includeInNextSend && !failedLocal.has(comment.id)) count += 1;
  return count;
}

/** How many comments failed to save (the composer's comments button marks them). */
export function countFailedThreadComments(comments: readonly ChatThreadComment[]): number {
  let count = 0;
  for (const comment of comments) if (failedLocal.has(comment.id)) count += 1;
  return count;
}

/** Asks the open thread to scroll to a comment and open it. */
export const THREAD_COMMENT_FOCUS_EVENT = "ade:thread-comment-focus";

export function requestThreadCommentFocus(comment: ChatThreadComment): void {
  window.dispatchEvent(new CustomEvent(THREAD_COMMENT_FOCUS_EVENT, { detail: { sessionId: comment.sessionId, commentId: comment.id } }));
}

/**
 * Text typed into a comment box that closed without saving because the user
 * left (another chat, project or tab). Opening a comment on the same text in
 * the same chat brings it back. In memory only, and capped.
 */
type UnsavedDraftTarget = { sessionId: string; messageKey: string; anchor: ChatThreadCommentAnchor };

const unsavedDraftBodies = new Map<string, string>();
const MAX_UNSAVED_DRAFTS = 50;

/** Identifies the text a comment box is open on; also a stable React key for the box. */
export function unsavedDraftKey(target: UnsavedDraftTarget): string {
  return JSON.stringify([target.sessionId, target.messageKey, target.anchor]);
}

export function keepUnsavedDraftBody(target: UnsavedDraftTarget, body: string): void {
  const key = unsavedDraftKey(target);
  unsavedDraftBodies.delete(key);
  if (!body.trim()) return;
  unsavedDraftBodies.set(key, body);
  // A Map iterates oldest first: drop from the front.
  for (const stale of unsavedDraftBodies.keys()) {
    if (unsavedDraftBodies.size <= MAX_UNSAVED_DRAFTS) break;
    unsavedDraftBodies.delete(stale);
  }
}

export function readUnsavedDraftBody(target: UnsavedDraftTarget): string | undefined {
  return unsavedDraftBodies.get(unsavedDraftKey(target));
}

export function discardUnsavedDraftBody(target: UnsavedDraftTarget): void {
  unsavedDraftBodies.delete(unsavedDraftKey(target));
}
