import { useEffect, useSyncExternalStore } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import {
  LOCAL_THREAD_COMMENT_ID_PREFIX,
  THREAD_COMMENT_GONE_MESSAGE,
  THREAD_COMMENT_MISSING_MESSAGE,
  newThreadCommentClientId,
  threadCommentQuoteText,
  threadCommentRevision,
  type ChatThreadComment,
  type ChatThreadCommentAnchor,
  type ChatThreadCommentSelection,
} from "../../../shared/threadComments";
import { withChatPin } from "./chatMachinePin";
import {
  dropAppliedHeldChange,
  dropHeldComment,
  forgetGoneHeldCopies,
  heldChat,
  heldComment,
  holdChangeAgainst,
  holdDeleteAgainst,
  holdNewAgainst,
  markHeldCommentTried,
  subscribeHeld,
  threadCommentsHeldOnDevice,
  withHeldChanges,
} from "./threadCommentsHeldOnDevice";

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
 *
 * Another keeps a resting ADE Cloud computer asleep: a comment written while
 * the chat's computer rests, and an edit, a tick or a delete of one the host
 * already has, stays on this device (`threadCommentsHeldOnDevice.ts`), shows
 * here at once, and is handed over by the next send that carries comments,
 * or by any send once the computer is awake (`handOverHeldThreadComments`,
 * `prepareDeviceHeldForSend`).
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

function rebuild(sessionId: string): void {
  let host = bySession.get(sessionId) ?? EMPTY;
  const local = localBySession.get(sessionId) ?? EMPTY;
  const held = heldChat(sessionId);
  // A comment whose Discard could not delete the host's copy shows once, as
  // the failed local comment, not also as that copy.
  const shadowed = new Set<string>();
  for (const comment of local) {
    if (comment.clientId && failedLocal.get(comment.id)?.discard) shadowed.add(comment.clientId);
  }
  // So does a copy a lost hand-over answer left on the host: once, as the
  // comment this device holds (its text is the newest), and not at all after
  // it was deleted here.
  for (const comment of held.comments) if (comment.clientId) shadowed.add(comment.clientId);
  for (const clientId of held.gone) shadowed.add(clientId);
  if (shadowed.size) host = host.filter((comment) => !comment.clientId || !shadowed.has(comment.clientId));
  // A host comment changed or deleted here while the computer rested shows as
  // changed; the next send applies the change there first.
  if (held.changes.length) host = withHeldChanges(host, held.changes);
  visibleBySession.set(sessionId, local.length || held.comments.length ? [...host, ...held.comments, ...local] : host);
}

function publish(sessionId: string): void {
  rebuild(sessionId);
  notify();
}

// What this device holds shows through this store's list: every change to it
// (a save here, or another window's) rebuilds the chats it touched.
subscribeHeld((sessionIds) => {
  for (const sessionId of sessionIds) rebuild(sessionId);
  notify();
});

/**
 * The holds of `threadCommentsHeldOnDevice.ts`, checked against the host's
 * latest list for the chat. Each shows through `subscribeHeld` above.
 */
export function holdThreadCommentOnDevice(
  sessionId: string,
  fields: Pick<ChatThreadComment, "messageKey" | "messageExcerpt" | "anchor" | "body">,
): ChatThreadComment {
  return holdNewAgainst(sessionId, bySession.get(sessionId) ?? EMPTY, fields);
}

export function holdThreadCommentChange(
  sessionId: string,
  commentId: string,
  patch: { body?: string; includeInNextSend?: boolean },
): ChatThreadComment {
  return holdChangeAgainst(sessionId, bySession.get(sessionId) ?? EMPTY, commentId, patch);
}

export function holdThreadCommentDelete(sessionId: string, commentId: string): { deleted: boolean } {
  return holdDeleteAgainst(sessionId, bySession.get(sessionId) ?? EMPTY, commentId);
}

export function setThreadComments(sessionId: string, comments: ChatThreadComment[]): void {
  bySession.set(sessionId, comments);
  writeVersion.set(sessionId, (writeVersion.get(sessionId) ?? 0) + 1);
  if (comments.some((comment) => typeof comment.clientId === "string")) hostKeepsClientIds.add(sessionId);
  dropLocalCommentsTheHostHas(sessionId);
  publish(sessionId);
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
  const clientId = newThreadCommentClientId();
  const local: ChatThreadComment = {
    ...fields,
    id: `${LOCAL_THREAD_COMMENT_ID_PREFIX}${clientId}`,
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
  // Read after `handOverHeldThreadComments`: what this device still holds then
  // (held back, or deleted here after a hand-over try) never rides the send,
  // even as a copy a lost answer left on the host.
  const held = heldChat(sessionId);
  for (const comment of held.comments) if (comment.clientId) ids.add(comment.clientId);
  for (const clientId of held.gone) ids.add(clientId);
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
  if (!sessionId) return EMPTY;
  const visible = visibleBySession.get(sessionId);
  if (visible) return visible;
  // After a reload, what this device holds shows before (or without) the host's list.
  if (!heldChat(sessionId).comments.length) return EMPTY;
  rebuild(sessionId);
  return visibleBySession.get(sessionId) ?? EMPTY;
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

// ── Handing over what this device holds (`threadCommentsHeldOnDevice.ts`) ──

/** The comments as this device shows them now, read past the last render (a send reads them after its hand-over). */
export function currentThreadComments(sessionId: string): ChatThreadComment[] {
  return getThreadComments(sessionId);
}

type ThreadCommentsApi = NonNullable<ReturnType<typeof threadCommentsApi>>;

/**
 * Runs one of a hand-over's writes on the machine the send goes to: for a
 * chat whose ADE Cloud computer rests, that computer reached the way the send
 * reaches it (`ChatSendReach`); for any other chat, the chat's pin as it is.
 */
export type ThreadCommentSendReach = <T>(write: (pin: OpenProjectBinding) => Promise<T>) => Promise<T>;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The host's answer for a comment that is not there anymore: a send took it, or it was deleted elsewhere. */
function commentGone(error: unknown): boolean {
  const text = errorText(error);
  return text.includes(THREAD_COMMENT_GONE_MESSAGE) || text.includes(THREAD_COMMENT_MISSING_MESSAGE);
}

/**
 * Applies the changes kept here to the host's comments, in the order they
 * were made. A comment the host no longer has has nothing left to change.
 * Throws on any other failure: the send must not go with the host's older
 * text or ticks, and each change not applied stays here.
 */
async function applyHeldChanges(
  sessionId: string,
  api: ThreadCommentsApi,
  reach: ThreadCommentSendReach,
): Promise<void> {
  // A change made while a call was out goes in the next pass.
  for (let pass = 0; pass < 3; pass += 1) {
    const pending = heldChat(sessionId).changes;
    if (!pending.length) return;
    for (const change of pending) {
      try {
        if (change.deleted) {
          await reach((callPin) => api.delete({ sessionId, commentId: change.commentId }, callPin));
          const host = bySession.get(sessionId) ?? EMPTY;
          if (host.some((comment) => comment.id === change.commentId)) {
            setThreadComments(sessionId, host.filter((comment) => comment.id !== change.commentId));
          }
        } else {
          const saved = await reach((callPin) => api.update({
            sessionId,
            commentId: change.commentId,
            ...(change.body !== undefined ? { body: change.body } : {}),
            ...(change.includeInNextSend !== undefined ? { includeInNextSend: change.includeInNextSend } : {}),
          }, callPin));
          const host = bySession.get(sessionId) ?? EMPTY;
          if (saved?.id && host.some((comment) => comment.id === saved.id)) {
            setThreadComments(sessionId, host.map((comment) => (comment.id === saved.id ? saved : comment)));
          }
        }
      } catch (error) {
        if (!commentGone(error)) throw error;
      }
      // Applied, unless it changed again while the call was out.
      dropAppliedHeldChange(sessionId, change);
    }
  }
}

/**
 * Hands the comments this device holds for the next send to the chat's
 * computer, in the order they were written, right before the send goes (the
 * send wakes the computer anyway). Each create carries the comment's client
 * id, so after a lost answer the host answers with the copy it made, never a
 * second one; a copy with other text or flag is brought up to date; one the
 * host says a send already took is dropped here. Copies of comments deleted
 * here after a try are deleted there (best effort: the send's exclusion list
 * keeps them out meanwhile). Edits, ticks and deletes of the host's own
 * comments made here go first (`applyHeldChanges`). Throws when a comment
 * could not be handed over: the send must not go without it, and each
 * comment not handed over stays here. Every write goes through `reach`, so
 * it reaches a resting chat's computer the way the send does; the one read
 * (the host's list, for the deleted copies) goes to `pin`.
 */
export async function handOverHeldThreadComments(
  sessionId: string,
  pin: OpenProjectBinding | null | undefined,
  api: ThreadCommentsApi | null | undefined,
  reach: ThreadCommentSendReach,
): Promise<void> {
  if (!threadCommentsHeldOnDevice(sessionId)) return;
  if (!api) throw new Error("This version of ADE can't hand your comments to the chat's computer.");
  await applyHeldChanges(sessionId, api, reach);
  for (const planned of heldChat(sessionId).comments.filter((comment) => comment.includeInNextSend)) {
    // Edited, held back or deleted while an earlier one was out: the latest word counts.
    const held = heldComment(sessionId, planned.id);
    const clientId = held?.clientId;
    if (!held || !clientId || !held.includeInNextSend) continue;
    markHeldCommentTried(sessionId, clientId);
    let saved: ChatThreadComment | null;
    try {
      saved = await reach((callPin) => api.create(createArgsFor(sessionId, held), callPin));
      // An edit made while a call was out, or an older copy, wins over nothing: the host copy follows this device's.
      for (let pass = 0; pass < 3 && saved; pass += 1) {
        const latest = heldComment(sessionId, held.id);
        // Deleted here meanwhile: it is in `gone`, and its copy goes below.
        if (!latest) {
          saved = null;
          break;
        }
        if (saved.body === latest.body && saved.includeInNextSend === latest.includeInNextSend) break;
        const hostId: string = saved.id;
        saved = await reach((callPin): Promise<ChatThreadComment> => api.update({
          sessionId,
          commentId: hostId,
          body: latest.body,
          includeInNextSend: latest.includeInNextSend,
        }, callPin));
      }
    } catch (error) {
      // A send already took this comment (its earlier hand-over landed): it left once, and never goes twice.
      if (!errorText(error).includes(THREAD_COMMENT_GONE_MESSAGE)) throw error;
      saved = null;
    }
    dropHeldComment(sessionId, held.id);
    const host = bySession.get(sessionId) ?? EMPTY;
    if (saved && !host.some((comment) => comment.id === saved!.id)) setThreadComments(sessionId, [...host, saved]);
  }
  await deleteGoneHostCopies(sessionId, pin, api, reach);
}

async function deleteGoneHostCopies(
  sessionId: string,
  pin: OpenProjectBinding | null | undefined,
  api: ThreadCommentsApi,
  reach: ThreadCommentSendReach,
): Promise<void> {
  const gone = new Set(heldChat(sessionId).gone);
  if (!gone.size) return;
  try {
    const list = await withChatPin(pin ?? null, (chatPin) => api.list({ sessionId }, chatPin));
    if (!Array.isArray(list)) return;
    for (const copy of list) {
      if (copy.clientId && gone.has(copy.clientId)) {
        await reach((callPin) => api.delete({ sessionId, commentId: copy.id }, callPin));
      }
    }
    forgetGoneHeldCopies(sessionId, gone);
  } catch (error) {
    // The send names these copies in its exclusion list, so none rides it; the next hand-over tries again.
    console.warn("[thread-comments] held-gone-cleanup-failed", { sessionId, error: errorText(error) });
  }
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
