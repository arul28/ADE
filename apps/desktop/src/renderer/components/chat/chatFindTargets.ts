/**
 * How the command palette reaches a chat's find bar.
 *
 * - "Find "…" in this chat": every mounted transcript registers a target; the
 *   palette asks for the chat the user was last in.
 * - Opening a chat from a palette result: the palette leaves the typed words
 *   for that session, and its transcript opens find with them once it mounts
 *   (or right away when it is already on screen).
 */
import { isInParkedSurface } from "../../lib/parkedSurface";

export type ChatFindTarget = {
  sessionId: string | null;
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
  if (!root || !root.isConnected || isInParkedSurface(root)) return false;
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
const pendingBySession = new Map<string, string>();

/** Leave `query` for `sessionId`'s find bar; it shows the matches without moving the view. */
export function setPendingChatFind(sessionId: string, query: string): void {
  if (!query.trim()) {
    pendingBySession.delete(sessionId);
    return;
  }
  pendingBySession.set(sessionId, query);
  window.dispatchEvent(new CustomEvent(PENDING_EVENT, { detail: { sessionId } }));
}

export function takePendingChatFind(sessionId: string): string | null {
  const query = pendingBySession.get(sessionId) ?? null;
  pendingBySession.delete(sessionId);
  return query;
}

export function onPendingChatFind(listener: (sessionId: string) => void): () => void {
  const handler = (event: Event) => {
    const sessionId = (event as CustomEvent<{ sessionId?: string }>).detail?.sessionId;
    if (sessionId) listener(sessionId);
  };
  window.addEventListener(PENDING_EVENT, handler);
  return () => window.removeEventListener(PENDING_EVENT, handler);
}

/**
 * The words of a palette query, without its filters: `kind:chat lane:x "exact
 * phrase" retry` → `exact phrase retry`. Filter syntax is `key:value`.
 */
export function paletteQueryFreeText(query: string): string {
  const words: string[] = [];
  const pattern = /"([^"]*)"?|(\S+)/g;
  for (let match = pattern.exec(query); match; match = pattern.exec(query)) {
    if (match[1] !== undefined) {
      if (match[1].trim()) words.push(match[1].trim());
      continue;
    }
    const token = match[2]!;
    if (/^-?[a-z]+:/i.test(token)) continue;
    words.push(token);
  }
  return words.join(" ");
}
