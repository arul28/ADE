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
  let host = bySession.get(sessionId) ?? EMPTY;
  const local = localBySession.get(sessionId) ?? EMPTY;
  // A comment whose Discard could not delete the host's copy shows once, as
  // the failed local comment, not also as that copy.
  const discarding = new Set<string>();
  for (const comment of local) {
    if (comment.clientId && failedLocal.get(comment.id)?.discard) discarding.add(comment.clientId);
  }
  if (discarding.size) host = host.filter((comment) => !comment.clientId || !discarding.has(comment.clientId));
  visibleBySession.set(sessionId, local.length ? [...host, ...local] : host);
  notify();
}

export function setThreadComments(sessionId: string, comments: ChatThreadComment[]): void {
  bySession.set(sessionId, comments);
  writeVersion.set(sessionId, (writeVersion.get(sessionId) ?? 0) + 1);
  if (comments.some((comment) => typeof comment.clientId === "string")) hostKeepsClientIds.add(sessionId);
  dropLocalCommentsTheHostHas(sessionId);
  publish(sessionId);
}

const LOCAL_ID_PREFIX = "local:";

/** True for a comment shown before its host has it; it has no host id to act on yet. */
export function isLocalThreadComment(commentId: string): boolean {
  return commentId.startsWith(LOCAL_ID_PREFIX);
}

/**
 * Local comments whose create (or discard) failed. They stay in the list
 * (with Retry and Discard) instead of vanishing, never ride a send, and keep
 * what an older host needs to find a save that landed after all: the host
 * ids that existed before the first attempt.
 */
type FailedLocalComment = { error: string; knownHostIds: ReadonlySet<string> | null; discard: boolean };
const failedLocal = new Map<string, FailedLocalComment>();
/**
 * Host ids present when each local comment was first created. Only an older
 * host (one that drops `clientId`) needs it. Null when the chat's host list
 * had not loaded yet: with no baseline, an older comment with the same text
 * would pass for this one's copy, so no host copy is matched by content.
 */
const knownHostIdsByLocal = new Map<string, ReadonlySet<string> | null>();
/** Chats whose host keeps `clientId` (a create answer or list carried one): no content matching there. */
const hostKeepsClientIds = new Set<string>();
/**
 * Host ids that already settled a local comment. On an older host two
 * comments with the same quote and body look alike; one host copy is never
 * handed to a second local comment.
 */
const claimedHostIds = new Set<string>();
const MAX_CLAIMED_HOST_IDS = 500;

function claimHostId(hostId: string): void {
  claimedHostIds.delete(hostId);
  claimedHostIds.add(hostId);
  for (const oldest of claimedHostIds) {
    if (claimedHostIds.size <= MAX_CLAIMED_HOST_IDS) break;
    claimedHostIds.delete(oldest);
  }
}

/** The reason a local comment failed to save (or to discard), or null while it is fine. */
export function threadCommentSaveError(commentId: string): string | null {
  return failedLocal.get(commentId)?.error ?? null;
}

/** True when the failure shown is a Discard that could not reach the host (Discard again retries it). */
export function threadCommentDiscardFailed(commentId: string): boolean {
  return failedLocal.get(commentId)?.discard === true;
}

/**
 * The host comment that is this local comment, saved by an attempt whose
 * answer never came back. Its `clientId` names it. Only on an older host,
 * which drops `clientId`, is it matched by content: a comment that was not
 * there before the first attempt, has no client id, and settled no other
 * local comment.
 */
function hostCopyOf(
  sessionId: string,
  local: ChatThreadComment,
  host: readonly ChatThreadComment[],
  known: ReadonlySet<string> | null,
): ChatThreadComment | null {
  const exact = local.clientId ? host.find((comment) => comment.clientId === local.clientId) : undefined;
  if (exact) return exact;
  if (!known || hostKeepsClientIds.has(sessionId)) return null;
  const quote = threadCommentQuoteText(local.anchor);
  return host.find((comment) => (
    !comment.clientId
    && !known.has(comment.id)
    && !claimedHostIds.has(comment.id)
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

/**
 * A local comment the host's list now holds was saved: the host's copy
 * replaces it. A copy named by its client id replaces any local comment; a
 * content match (older host) only a failed one.
 */
function dropLocalCommentsTheHostHas(sessionId: string): void {
  const host = bySession.get(sessionId) ?? EMPTY;
  for (const local of localBySession.get(sessionId) ?? EMPTY) {
    const failed = failedLocal.get(local.id);
    if (failed?.discard) continue;
    const copy = failed
      ? hostCopyOf(sessionId, local, host, failed.knownHostIds)
      : local.clientId ? host.find((comment) => comment.clientId === local.clientId) ?? null : null;
    if (!copy) continue;
    claimHostId(copy.id);
    dropLocal(sessionId, local.id);
  }
}

function newClientId(): string {
  const random = globalThis.crypto?.randomUUID?.();
  return random ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
}

/**
 * Shows a comment before the host has saved it. Returns `settle`: pass the
 * host's comment on success (it joins the list unless an update already
 * brought it). On failure pass null and the error: the comment stays, marked
 * failed (`threadCommentSaveError`), unless the host's list shows it landed
 * anyway. Null with no error drops it. `clientId` goes with the create, so a
 * retry or a discard can find a save whose answer was lost.
 */
export function addLocalThreadComment(
  sessionId: string,
  fields: Omit<ChatThreadComment, "id" | "sessionId" | "includeInNextSend" | "createdAt" | "updatedAt" | "clientId">,
): ((saved?: ChatThreadComment | null, error?: string) => void) & { localId: string; clientId: string } {
  const at = new Date().toISOString();
  const clientId = newClientId();
  const local: ChatThreadComment = {
    ...fields,
    id: `${LOCAL_ID_PREFIX}${clientId}`,
    sessionId,
    includeInNextSend: true,
    createdAt: at,
    updatedAt: at,
    clientId,
  };
  const hostList = bySession.get(sessionId);
  knownHostIdsByLocal.set(local.id, hostList ? new Set(hostList.map((comment) => comment.id)) : null);
  localBySession.set(sessionId, [...(localBySession.get(sessionId) ?? EMPTY), local]);
  publish(sessionId);
  return Object.assign(settleLocal(sessionId, local), { localId: local.id, clientId });
}

/** Whether the host's comment list for this chat has loaded at least once. */
export function threadCommentListLoaded(sessionId: string): boolean {
  return bySession.has(sessionId);
}

/**
 * A comment saved before the chat's list loaded has no known host ids, so on
 * an older host a lost answer could not be told from a real failure. Once the
 * list is read (before that comment's create is sent, so it cannot hold its
 * own copy), the comment takes it as its baseline.
 */
export function captureThreadCommentBaseline(sessionId: string, localId: string): void {
  if (knownHostIdsByLocal.get(localId) != null) return;
  const hostList = bySession.get(sessionId);
  if (hostList) knownHostIdsByLocal.set(localId, new Set(hostList.map((comment) => comment.id)));
}

function settleLocal(sessionId: string, local: ChatThreadComment) {
  return (saved?: ChatThreadComment | null, error?: string) => {
    // Gone while the call was out (the host's list brought it, or a discard): nothing to settle.
    if (!(localBySession.get(sessionId) ?? EMPTY).some((comment) => comment.id === local.id)) return;
    const host = bySession.get(sessionId) ?? EMPTY;
    const known = knownHostIdsByLocal.get(local.id) ?? null;
    const copy = saved ?? (error ? hostCopyOf(sessionId, local, host, known) : null);
    if (!copy && error) {
      failedLocal.set(local.id, { error, knownHostIds: known, discard: false });
      publish(sessionId);
      return;
    }
    if (saved?.clientId) hostKeepsClientIds.add(sessionId);
    if (copy) claimHostId(copy.id);
    dropLocal(sessionId, local.id);
    if (saved && !host.some((comment) => comment.id === saved.id)) {
      setThreadComments(sessionId, [...host, saved]);
      return;
    }
    publish(sessionId);
  };
}

/** The create call for a local comment, with its client id. */
function createArgsFor(sessionId: string, local: ChatThreadComment) {
  const { messageKey, messageExcerpt, anchor, body, clientId } = local;
  return { sessionId, messageKey, messageExcerpt, anchor, body, ...(clientId ? { clientId } : {}) };
}

/**
 * Saves (first create, retry, or a discard's delete) whose host call has not
 * answered, per chat. A send waits for them (`waitForThreadCommentSaves`), so
 * a comment saved just before the send reaches the host before the message
 * does, and one being discarded is gone before it.
 */
const savesInFlight = new Map<string, Set<Promise<void>>>();
const savingLocalIds = new Set<string>();

/** Runs one comment save and tracks it until it settles. `run` must not throw. */
export function trackThreadCommentSave(sessionId: string, localId: string, run: () => Promise<void>): Promise<void> {
  savingLocalIds.add(localId);
  const save = run().finally(() => {
    savingLocalIds.delete(localId);
    const set = savesInFlight.get(sessionId);
    set?.delete(save);
    if (set && !set.size) savesInFlight.delete(sessionId);
  });
  const set = savesInFlight.get(sessionId) ?? new Set<Promise<void>>();
  set.add(save);
  savesInFlight.set(sessionId, set);
  return save;
}

/** Whether a comment save in this chat is still waiting on its host. Cheap: a send checks it before waiting. */
export function threadCommentSavesInFlight(sessionId: string): boolean {
  return Boolean(savesInFlight.get(sessionId)?.size);
}

/**
 * Client ids of comments a discard is deleting from the host, per chat, until
 * that delete answers. The comment is gone from the list, but its host copy
 * may not be yet, so a send keeps excluding it.
 */
const discardingClientIds = new Map<string, Set<string>>();

/**
 * The client ids a send names in `excludeThreadCommentClientIds`: every
 * comment this client shows as not on the host (still saving, failed, or
 * failed to discard) and every one a discard is still deleting. A save whose
 * answer was lost may have landed after all; the host leaves a comment with
 * one of these ids where it is, so the send carries only what the person saw
 * going, and a later Retry or Discard still finds that copy. An older host
 * ignores the field and sends such a copy with the rest.
 */
export function threadCommentClientIdsToExclude(sessionId: string): string[] {
  const ids = new Set(discardingClientIds.get(sessionId) ?? []);
  for (const comment of localBySession.get(sessionId) ?? EMPTY) if (comment.clientId) ids.add(comment.clientId);
  return [...ids];
}

/**
 * Waits, up to `timeoutMs`, for this chat's comment saves to settle. True when
 * none is left; false when one still runs after the bound (it stays in the
 * list and rides a later send once the host has it).
 */
export async function waitForThreadCommentSaves(sessionId: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (threadCommentSavesInFlight(sessionId)) {
    const left = deadline - Date.now();
    if (left <= 0) {
      console.warn("[thread-comments] send-wait-timeout", { sessionId, pending: savesInFlight.get(sessionId)?.size ?? 0 });
      return false;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled([...(savesInFlight.get(sessionId) ?? [])]),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, left); }),
    ]);
    clearTimeout(timer);
  }
  return true;
}

/**
 * How many comments the host holds for the next send right now: like
 * `countCommentsForNextSend`, but a comment still saving is left out, since
 * the host does not have it yet.
 */
export function countThreadCommentsReadyToSend(sessionId: string): number {
  let count = 0;
  for (const comment of getThreadComments(sessionId)) {
    if (comment.includeInNextSend && !failedLocal.has(comment.id) && !savingLocalIds.has(comment.id)) count += 1;
  }
  return count;
}

/**
 * Drops a comment that failed to save. Its first attempt may have landed
 * with the answer lost, so the host's copy (found by its client id) is
 * deleted too, on the chat's own machine. The comment leaves the list at
 * once; a failure brings it back, marked, so Discard can run again. A send
 * made meanwhile waits for it.
 */
export async function discardFailedThreadComment(
  sessionId: string,
  commentId: string,
  pin: OpenProjectBinding | null | undefined,
  describeError: (error: unknown) => string,
): Promise<void> {
  const failed = failedLocal.get(commentId);
  const local = (localBySession.get(sessionId) ?? EMPTY).find((comment) => comment.id === commentId);
  if (!failed || !local || savingLocalIds.has(commentId)) return;
  const api = threadCommentsApi();
  dropLocal(sessionId, commentId);
  publish(sessionId);
  if (!api) return;
  const clientId = local.clientId;
  if (clientId) {
    const discarding = discardingClientIds.get(sessionId) ?? new Set<string>();
    discarding.add(clientId);
    discardingClientIds.set(sessionId, discarding);
  }
  await trackThreadCommentSave(sessionId, commentId, async () => {
    try {
      const list = await withChatPin(pin ?? null, (chatPin) => api.list({ sessionId }, chatPin));
      if (!Array.isArray(list)) return;
      const copy = hostCopyOf(sessionId, local, list, failed.knownHostIds);
      setThreadComments(sessionId, copy ? list.filter((comment) => comment.id !== copy.id) : list);
      if (!copy) return;
      claimHostId(copy.id);
      await withChatPin(pin ?? null, (chatPin) => api.delete({ sessionId, commentId: copy.id }, chatPin));
    } catch (error) {
      // Back in the list, marked, so Discard can run again; a send meanwhile
      // still excludes the host's copy (`threadCommentClientIdsToExclude`).
      localBySession.set(sessionId, [...(localBySession.get(sessionId) ?? EMPTY), local]);
      knownHostIdsByLocal.set(commentId, failed.knownHostIds);
      failedLocal.set(commentId, { error: describeError(error), knownHostIds: failed.knownHostIds, discard: true });
      publish(sessionId);
      void refreshThreadComments(sessionId, pin);
    } finally {
      const discarding = clientId ? discardingClientIds.get(sessionId) : undefined;
      discarding?.delete(clientId!);
      if (discarding && !discarding.size) discardingClientIds.delete(sessionId);
    }
  });
}

/**
 * Saves a failed comment again with the same client id: a host that keeps
 * client ids answers a repeat with the comment it already made. The host's
 * list is read first, so a copy that landed is kept (on an older host,
 * matched by content) and only a missing one is created.
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
  if (!failed || failed.discard || !local || !api || savingLocalIds.has(commentId)) return;
  failedLocal.delete(commentId);
  publish(sessionId);
  const settle = settleLocal(sessionId, local);
  await trackThreadCommentSave(sessionId, commentId, async () => {
    try {
      const list = await withChatPin(pin ?? null, (chatPin) => api.list({ sessionId }, chatPin));
      if (Array.isArray(list)) {
        const landed = hostCopyOf(sessionId, local, list, failed.knownHostIds);
        setThreadComments(sessionId, list);
        if (landed) {
          settle(landed);
          return;
        }
      }
      settle(await withChatPin(pin ?? null, (chatPin) => api.create(createArgsFor(sessionId, local), chatPin)));
    } catch (error) {
      settle(null, describeError(error));
    }
  });
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
