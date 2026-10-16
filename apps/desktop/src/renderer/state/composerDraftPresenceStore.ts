import { useSyncExternalStore } from "react";

/**
 * Which sessions hold an unsent composer draft.
 *
 * The draft itself lives in `localStorage` (see
 * `COMPOSER_DRAFT_STORAGE_KEY_PREFIX`), which no row can subscribe to and no
 * long list should parse per render. This store keeps a session-id set in
 * memory: `AgentChatPane` publishes a session's presence whenever its draft
 * changes, and a one-time scan of the persisted keys seeds the sessions whose
 * pane has not mounted this window (drafts from a previous session). Rows read
 * it through `useComposerDraftPresence`, which re-renders only when one row's
 * boolean actually flips.
 */

/** The draft-key prefix. One definition, shared with `AgentChatPane`. */
export const COMPOSER_DRAFT_STORAGE_KEY_PREFIX = "ade.chat.composerDraft.v1";

const draftPresence = new Set<string>();
let seeded = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Read one stored draft snapshot's presence without holding onto the object. */
function storedDraftHasContent(raw: string | null): boolean {
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== "object") return false;
    if (typeof parsed.text === "string" && parsed.text.trim().length > 0) return true;
    for (const key of [
      "attachments",
      "contextAttachments",
      "iosContextItems",
      "appControlContextItems",
      "builtInBrowserContextItems",
    ]) {
      const value = parsed[key];
      if (Array.isArray(value) && value.length > 0) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Seed from persisted drafts once. The key is
 * `<prefix>:<projectRoot>:<sessionId>:<surfaceProfile>:<workDraftKind>`, each
 * segment URI-encoded, so `:` only ever separates segments and segment 2 is the
 * session id.
 */
function seedFromStorage(): void {
  if (seeded) return;
  seeded = true;
  if (typeof window === "undefined") return;
  try {
    const storage = window.localStorage;
    const prefix = `${COMPOSER_DRAFT_STORAGE_KEY_PREFIX}:`;
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key || !key.startsWith(prefix)) continue;
      const sessionId = decodeURIComponent(key.split(":")[2] ?? "");
      if (!sessionId || draftPresence.has(sessionId)) continue;
      if (storedDraftHasContent(storage.getItem(key))) draftPresence.add(sessionId);
    }
  } catch {
    // A locked-down storage (private mode) simply yields no seeded drafts.
  }
}

/** True when `sessionId` has an unsent draft. Seeds persisted drafts once. */
export function composerDraftPresence(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  seedFromStorage();
  return draftPresence.has(sessionId);
}

/**
 * Publish a session's draft presence. Called on every draft change; a value
 * that did not flip is a no-op, so a keystroke never re-renders a list row.
 */
export function setComposerDraftPresence(sessionId: string | null | undefined, present: boolean): void {
  if (!sessionId) return;
  const had = draftPresence.has(sessionId);
  if (had === present) return;
  if (present) draftPresence.add(sessionId);
  else draftPresence.delete(sessionId);
  notify();
}

export function useComposerDraftPresence(sessionId: string | null | undefined): boolean {
  return useSyncExternalStore(
    subscribe,
    () => composerDraftPresence(sessionId),
    () => false,
  );
}
