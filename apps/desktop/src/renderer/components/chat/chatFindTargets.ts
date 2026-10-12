/**
 * How the command palette reaches a chat's find bar.
 *
 * - "Find "…" in this chat": every mounted transcript registers a target; the
 *   palette asks for the chat the user was last in.
 * - Opening a chat from a palette result: the palette leaves the typed words
 *   for that session, and its transcript opens find with them once it mounts
 *   (or right away when it is already on screen). A hand-off that nothing picks
 *   up soon after it was left is dropped, not replayed later.
 */
import { isLiveFindScope } from "../../lib/findScope";

export type ChatFindTarget = {
  root: () => HTMLElement | null;
  /** Open the bar with `query` and go to the first match in or below the view. */
  open: (query: string) => void;
};

const targets = new Set<ChatFindTarget>();
let lastActive: ChatFindTarget | null = null;

export function registerChatFindTarget(target: ChatFindTarget): () => void {
  targets.add(target);
  return () => {
    targets.delete(target);
    if (lastActive === target) lastActive = null;
  };
}

/** The user pressed or focused something in this chat. */
export function markChatFindTargetActive(target: ChatFindTarget): void {
  lastActive = target;
}

function onScreen(target: ChatFindTarget): boolean {
  const root = target.root();
  if (!isLiveFindScope(root)) return false;
  const rect = root.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/** The chat a palette "Find in this chat" acts on, or null when none is on screen. */
export function preferredChatFindTarget(): ChatFindTarget | null {
  if (lastActive && targets.has(lastActive) && onScreen(lastActive)) return lastActive;
  for (const target of targets) if (onScreen(target)) return target;
  return null;
}

const PENDING_EVENT = "ade:chat-find:pending";
/** A hand-off older than this is stale: the chat it was left for has moved on. */
const PENDING_CHAT_FIND_TTL_MS = 10_000;
const pendingBySession = new Map<string, { query: string; at: number }>();

/** Leave `query` for `sessionId`'s find bar; it shows the matches without moving the view. */
export function setPendingChatFind(sessionId: string, query: string): void {
  if (!query.trim()) {
    pendingBySession.delete(sessionId);
    return;
  }
  pendingBySession.set(sessionId, { query, at: Date.now() });
  window.dispatchEvent(new CustomEvent(PENDING_EVENT, { detail: { sessionId } }));
}

export function takePendingChatFind(sessionId: string): string | null {
  const pending = pendingBySession.get(sessionId);
  pendingBySession.delete(sessionId);
  if (!pending || Date.now() - pending.at > PENDING_CHAT_FIND_TTL_MS) return null;
  return pending.query;
}

export function onPendingChatFind(listener: (sessionId: string) => void): () => void {
  const handler = (event: Event) => {
    const sessionId = (event as CustomEvent<{ sessionId?: string }>).detail?.sessionId;
    if (sessionId) listener(sessionId);
  };
  window.addEventListener(PENDING_EVENT, handler);
  return () => window.removeEventListener(PENDING_EVENT, handler);
}
