import {
  MAX_THREAD_COMMENTS_PER_SESSION,
  MAX_THREAD_COMMENT_EXCERPT_CHARS,
  THREAD_COMMENT_MISSING_MESSAGE,
  cleanThreadCommentBody,
  collapseWhitespace,
  isLocalThreadComment,
  newThreadCommentClientId,
  normalizeThreadCommentAnchor,
  normalizeThreadCommentClientId,
  type ChatThreadComment,
} from "../../../shared/threadComments";

/*
 * Comments kept on this device while the chat's computer rests.
 *
 * A comment written while the chat's ADE Cloud computer rests stays on this
 * device: writing it to the computer would wake it, and a computer wakes only
 * when its agent works. It shows with the host's comments, can be edited,
 * held back and deleted here, and survives a reload (localStorage, the same on
 * the desktop and ADE Web). The send that carries it hands it to the computer
 * first, with its client id, so the host builds the review block from its own
 * list as for any comment (`handOverHeldThreadComments` in
 * `threadCommentsStore.ts`). So does an edit, a tick or a delete of a comment
 * the host already has (`holdChangeAgainst`): shown here at once,
 * applied at that send. Kept per chat id, not per pin: the same chat reads
 * under a saved copy's pin while it rests and under its connection's pin once
 * awake, and the send's own pin decides where it goes.
 *
 * This module knows nothing of the comment store: a hold that checks itself
 * against the host's list takes that list (`holdNewAgainst`,
 * `holdChangeAgainst`, `holdDeleteAgainst`), and the store shows each change
 * by subscribing (`subscribeHeld`). Those three are reached through the
 * store's wrappers (`holdThreadCommentOnDevice`, `holdThreadCommentChange`,
 * `holdThreadCommentDelete`), which pass the host's latest list. The rest
 * need no host list and are called directly: the edit and delete of a
 * comment held here, and the reads.
 */
const HELD_ID_PREFIX = "device:";
const HELD_STORAGE_KEY = "ade.threadComments.heldOnDevice.v1";

export type HeldChat = {
  /** In the order they were written; `id` is `device:<clientId>`. */
  comments: ChatThreadComment[];
  /** Client ids whose hand-over was tried: a lost answer may have left a copy on the host. */
  tried: string[];
  /** Client ids of tried comments deleted here: their host copy, if one landed, is deleted at the next hand-over. */
  gone: string[];
  /** Changes to comments the host has, made here while the computer rested, one per comment. */
  changes: HeldChange[];
};
/**
 * An edit, a tick or a delete of a host comment, by its host id: each key only
 * when changed here. A delete stands alone.
 */
export type HeldChange = { commentId: string; body?: string; includeInNextSend?: boolean; deleted?: true };
const EMPTY_HELD: HeldChat = { comments: [], tried: [], gone: [], changes: [] };
let heldBySession: Map<string, HeldChat> | null = null;

type HeldListener = (sessionIds: Iterable<string>) => void;
const heldListeners = new Set<HeldListener>();

/**
 * Calls `listener` with the chats whose held comments or changes changed: a
 * save here, or another window's (the storage event). Returns the unsubscribe.
 */
export function subscribeHeld(listener: HeldListener): () => void {
  heldListeners.add(listener);
  return () => heldListeners.delete(listener);
}

function heldChanged(sessionIds: Iterable<string>): void {
  for (const listener of heldListeners) listener(sessionIds);
}

/** True for a comment this device keeps until a send hands it to the chat's computer. */
export function isDeviceHeldThreadComment(commentId: string): boolean {
  return commentId.startsWith(HELD_ID_PREFIX);
}

/** A held comment as it is kept, with the host's caps; null for an entry that is not one. */
function normalizeHeldComment(entry: unknown, sessionId: string): ChatThreadComment | null {
  if (!entry || typeof entry !== "object") return null;
  const value = entry as Record<string, unknown>;
  const clientId = normalizeThreadCommentClientId(value.clientId);
  const anchor = normalizeThreadCommentAnchor(value.anchor);
  const body = cleanThreadCommentBody(value.body);
  const messageKey = typeof value.messageKey === "string" ? value.messageKey.trim() : "";
  if (!clientId || !anchor || !body || !messageKey) return null;
  const at = typeof value.createdAt === "string" ? value.createdAt : new Date(0).toISOString();
  return {
    id: `${HELD_ID_PREFIX}${clientId}`,
    sessionId,
    messageKey,
    messageExcerpt: collapseWhitespace(typeof value.messageExcerpt === "string" ? value.messageExcerpt : "")
      .slice(0, MAX_THREAD_COMMENT_EXCERPT_CHARS),
    anchor,
    body,
    includeInNextSend: value.includeInNextSend !== false,
    createdAt: at,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : at,
    clientId,
  };
}

function storedClientIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const ids = new Set<string>();
  for (const entry of raw.slice(-MAX_THREAD_COMMENTS_PER_SESSION)) {
    const clientId = normalizeThreadCommentClientId(entry);
    if (clientId) ids.add(clientId);
  }
  return [...ids];
}

/** Changes as they are kept: a host id each, at most one per comment and one per comment the chat can hold. */
function storedChanges(raw: unknown): HeldChange[] {
  if (!Array.isArray(raw)) return [];
  const byId = new Map<string, HeldChange>();
  for (const entry of raw.slice(-MAX_THREAD_COMMENTS_PER_SESSION)) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as Record<string, unknown>;
    const commentId = typeof value.commentId === "string" ? value.commentId.trim() : "";
    if (!commentId || commentId.length > 200 || isDeviceHeldThreadComment(commentId) || isLocalThreadComment(commentId)) continue;
    if (value.deleted === true) {
      byId.set(commentId, { commentId, deleted: true });
      continue;
    }
    const body = value.body === undefined ? null : cleanThreadCommentBody(value.body);
    const change: HeldChange = {
      commentId,
      ...(body ? { body } : {}),
      ...(typeof value.includeInNextSend === "boolean" ? { includeInNextSend: value.includeInNextSend } : {}),
    };
    if (change.body !== undefined || change.includeInNextSend !== undefined) byId.set(commentId, change);
  }
  return [...byId.values()];
}

function readHeldStorage(): Map<string, HeldChat> {
  const chats = new Map<string, HeldChat>();
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(HELD_STORAGE_KEY) ?? "{}");
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return chats;
    for (const [sessionId, raw] of Object.entries(stored as Record<string, unknown>)) {
      if (!sessionId || sessionId.length > 200 || !raw || typeof raw !== "object") continue;
      const value = raw as Record<string, unknown>;
      const seen = new Set<string>();
      const comments: ChatThreadComment[] = [];
      for (const entry of Array.isArray(value.comments) ? value.comments : []) {
        if (comments.length >= MAX_THREAD_COMMENTS_PER_SESSION) break;
        const comment = normalizeHeldComment(entry, sessionId);
        if (!comment || seen.has(comment.id)) continue;
        seen.add(comment.id);
        comments.push(comment);
      }
      const chat: HeldChat = {
        comments,
        tried: storedClientIds(value.tried),
        gone: storedClientIds(value.gone),
        changes: storedChanges(value.changes),
      };
      if (chat.comments.length || chat.gone.length || chat.changes.length) chats.set(sessionId, chat);
    }
  } catch {
    // No storage (a private window, blocked site data) or a torn value: nothing is held here.
  }
  return chats;
}

function heldChats(): Map<string, HeldChat> {
  if (heldBySession) return heldBySession;
  if (typeof window === "undefined") return (heldBySession = new Map());
  heldBySession = readHeldStorage();
  // Another window of this app (or tab of ADE Web) changed what this device holds.
  window.addEventListener("storage", (event) => {
    if (event.key !== HELD_STORAGE_KEY) return;
    const before = heldBySession ?? new Map<string, HeldChat>();
    heldBySession = readHeldStorage();
    heldChanged(new Set([...before.keys(), ...heldBySession.keys()]));
  });
  return heldBySession;
}

/** What this device holds for a chat. */
export function heldChat(sessionId: string): HeldChat {
  return heldChats().get(sessionId) ?? EMPTY_HELD;
}

export function heldComment(sessionId: string, commentId: string): ChatThreadComment | null {
  return heldChat(sessionId).comments.find((comment) => comment.id === commentId) ?? null;
}

/**
 * Applies and saves what this device holds for a chat. False when storage
 * refused it: the change still holds in this page, and is lost on a reload.
 */
function saveHeld(sessionId: string, next: HeldChat): boolean {
  const chats = heldChats();
  const kept = new Set(next.comments.map((comment) => comment.clientId));
  const chat: HeldChat = {
    comments: next.comments,
    tried: next.tried.filter((clientId) => kept.has(clientId)),
    gone: next.gone.slice(-MAX_THREAD_COMMENTS_PER_SESSION),
    changes: next.changes.slice(-MAX_THREAD_COMMENTS_PER_SESSION),
  };
  if (chat.comments.length || chat.gone.length || chat.changes.length) chats.set(sessionId, chat);
  else chats.delete(sessionId);
  heldChanged([sessionId]);
  try {
    if (chats.size) window.localStorage.setItem(HELD_STORAGE_KEY, JSON.stringify(Object.fromEntries(chats)));
    else window.localStorage.removeItem(HELD_STORAGE_KEY);
    return true;
  } catch (error) {
    console.warn("[thread-comments] held-save-failed", { sessionId, error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

/**
 * Keeps a new comment on this device: the chat's computer rests, and the
 * comment reaches it with the next send that carries it. `host` is the host's
 * latest list for the chat. Throws a sentence when it can't be kept (the
 * chat's comment cap, nothing to keep, no room in this device's storage);
 * nothing is kept then.
 */
export function holdNewAgainst(
  sessionId: string,
  host: readonly ChatThreadComment[],
  fields: Pick<ChatThreadComment, "messageKey" | "messageExcerpt" | "anchor" | "body">,
): ChatThreadComment {
  const chat = heldChat(sessionId);
  if (host.length + chat.comments.length >= MAX_THREAD_COMMENTS_PER_SESSION) {
    throw new Error(`A chat can hold ${MAX_THREAD_COMMENTS_PER_SESSION} comments. Send or delete some first.`);
  }
  const at = new Date().toISOString();
  const comment = normalizeHeldComment(
    { ...fields, clientId: newThreadCommentClientId(), includeInNextSend: true, createdAt: at, updatedAt: at },
    sessionId,
  );
  if (!comment) throw new Error("Write a comment first.");
  if (!saveHeld(sessionId, { ...chat, comments: [...chat.comments, comment] })) {
    saveHeld(sessionId, chat);
    throw new Error("This device has no room to keep the comment. Send the comments you have, or free some storage.");
  }
  return comment;
}

/** Edits a comment this device holds; throws a sentence when it can't. Nothing is sent. */
export function updateHeldThreadComment(
  sessionId: string,
  commentId: string,
  patch: { body?: string; includeInNextSend?: boolean },
): ChatThreadComment {
  const chat = heldChat(sessionId);
  const index = chat.comments.findIndex((comment) => comment.id === commentId);
  if (index < 0) throw new Error(THREAD_COMMENT_MISSING_MESSAGE);
  const previous = chat.comments[index]!;
  const body = patch.body === undefined ? previous.body : cleanThreadCommentBody(patch.body);
  if (!body) throw new Error("A comment cannot be empty. Delete it instead.");
  const next: ChatThreadComment = {
    ...previous,
    body,
    includeInNextSend: typeof patch.includeInNextSend === "boolean" ? patch.includeInNextSend : previous.includeInNextSend,
    updatedAt: new Date().toISOString(),
  };
  const comments = [...chat.comments];
  comments[index] = next;
  saveHeld(sessionId, { ...chat, comments });
  return next;
}

/** Deletes a comment this device holds. One whose hand-over was tried is remembered, so its host copy goes too. */
export function deleteHeldThreadComment(sessionId: string, commentId: string): { deleted: boolean } {
  const chat = heldChat(sessionId);
  const comment = chat.comments.find((entry) => entry.id === commentId);
  if (!comment) return { deleted: false };
  const tried = comment.clientId != null && chat.tried.includes(comment.clientId);
  saveHeld(sessionId, {
    ...chat,
    comments: chat.comments.filter((entry) => entry.id !== commentId),
    gone: tried ? [...chat.gone, comment.clientId!] : chat.gone,
  });
  return { deleted: true };
}

/** The host comments as this device shows them: the changes kept here applied, the deletes left out. */
export function withHeldChanges(host: ChatThreadComment[], changes: readonly HeldChange[]): ChatThreadComment[] {
  const byId = new Map(changes.map((change) => [change.commentId, change]));
  const shown: ChatThreadComment[] = [];
  for (const comment of host) {
    const change = byId.get(comment.id);
    if (!change) shown.push(comment);
    else if (!change.deleted) shown.push(withChange(comment, change));
  }
  return shown;
}

function withChange(comment: ChatThreadComment, change: HeldChange): ChatThreadComment {
  return {
    ...comment,
    ...(change.body !== undefined ? { body: change.body } : {}),
    ...(change.includeInNextSend !== undefined ? { includeInNextSend: change.includeInNextSend } : {}),
  };
}

function sameHeldChange(a: HeldChange, b: HeldChange): boolean {
  return a.commentId === b.commentId && a.body === b.body && a.includeInNextSend === b.includeInNextSend && a.deleted === b.deleted;
}

/**
 * Whether a change to this host comment waits on this device for the next
 * send. Every later change to it waits too (`holdChangeAgainst`), so
 * the host gets them in the order they were made.
 */
export function threadCommentChangeHeldOnDevice(sessionId: string, commentId: string): boolean {
  return heldChat(sessionId).changes.some((change) => change.commentId === commentId);
}

/**
 * Keeps an edit or a tick of a comment the host has on this device, while the
 * chat's computer rests: writing it there would wake it. Shown at once; the
 * next send that carries comments applies it there first
 * (`handOverHeldThreadComments`), so the agent gets the same review block. A
 * change back to what the host has drops it. `hostComments` is the host's
 * latest list for the chat. Throws a sentence when it can't; nothing is sent.
 */
export function holdChangeAgainst(
  sessionId: string,
  hostComments: readonly ChatThreadComment[],
  commentId: string,
  patch: { body?: string; includeInNextSend?: boolean },
): ChatThreadComment {
  const host = hostComments.find((comment) => comment.id === commentId);
  const chat = heldChat(sessionId);
  const previous = chat.changes.find((change) => change.commentId === commentId);
  if (!host || previous?.deleted) throw new Error(THREAD_COMMENT_MISSING_MESSAGE);
  const body = patch.body === undefined ? previous?.body : cleanThreadCommentBody(patch.body);
  if (patch.body !== undefined && !body) throw new Error("A comment cannot be empty. Delete it instead.");
  // As the host does: a guest's comment with new text waits for a new tick.
  const guestTextChanged = host.author?.kind === "guest" && patch.body !== undefined && body !== (previous?.body ?? host.body);
  const includeInNextSend = typeof patch.includeInNextSend === "boolean"
    ? patch.includeInNextSend
    : guestTextChanged ? false : previous?.includeInNextSend;
  const change: HeldChange = {
    commentId,
    ...(body !== undefined && body !== host.body ? { body } : {}),
    ...(includeInNextSend !== undefined && includeInNextSend !== host.includeInNextSend ? { includeInNextSend } : {}),
  };
  const others = chat.changes.filter((entry) => entry.commentId !== commentId);
  const changed = change.body !== undefined || change.includeInNextSend !== undefined;
  saveHeld(sessionId, { ...chat, changes: changed ? [...others, change] : others });
  return withChange(host, change);
}

/**
 * Deletes a comment the host has, on this device, while the chat's computer
 * rests: gone from the list at once, deleted there at the next send that
 * carries comments. It rides no send meanwhile. `host` is the host's latest
 * list for the chat.
 */
export function holdDeleteAgainst(
  sessionId: string,
  host: readonly ChatThreadComment[],
  commentId: string,
): { deleted: boolean } {
  const chat = heldChat(sessionId);
  if (!host.some((comment) => comment.id === commentId)) return { deleted: false };
  saveHeld(sessionId, {
    ...chat,
    changes: [...chat.changes.filter((entry) => entry.commentId !== commentId), { commentId, deleted: true }],
  });
  return { deleted: true };
}

/** Whether a send that carries comments must hand some over first. Cheap: every such send asks. */
export function threadCommentsHeldOnDevice(sessionId: string): boolean {
  const chat = heldChat(sessionId);
  return chat.gone.length > 0 || chat.changes.length > 0 || chat.comments.some((comment) => comment.includeInNextSend);
}

// ── What a hand-over (`handOverHeldThreadComments`) records as it goes ──

/** A held comment's hand-over is being tried: a lost answer may leave a copy on the host. */
export function markHeldCommentTried(sessionId: string, clientId: string): void {
  const chat = heldChat(sessionId);
  if (!chat.tried.includes(clientId)) saveHeld(sessionId, { ...chat, tried: [...chat.tried, clientId] });
}

/** A held comment the host now has (or a send already took): this device holds it no more. */
export function dropHeldComment(sessionId: string, commentId: string): void {
  const chat = heldChat(sessionId);
  saveHeld(sessionId, { ...chat, comments: chat.comments.filter((comment) => comment.id !== commentId) });
}

/** A held change the host applied, unless it changed again while the call was out. */
export function dropAppliedHeldChange(sessionId: string, change: HeldChange): void {
  const chat = heldChat(sessionId);
  if (chat.changes.some((entry) => sameHeldChange(entry, change))) {
    saveHeld(sessionId, { ...chat, changes: chat.changes.filter((entry) => !sameHeldChange(entry, change)) });
  }
}

/** Host copies of comments deleted here that are now gone from the host too. */
export function forgetGoneHeldCopies(sessionId: string, clientIds: ReadonlySet<string>): void {
  const chat = heldChat(sessionId);
  saveHeld(sessionId, { ...chat, gone: chat.gone.filter((clientId) => !clientIds.has(clientId)) });
}
