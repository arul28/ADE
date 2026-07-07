/**
 * One-shot "position this session's content when it next mounts" queue.
 * Set by deeplink navigation (/work?sessionId=...&event=N / &offset=N) and by
 * ⌘K search-result activation; consumed by the chat message list (event
 * sequence anchor) or the terminal view (scrollback byte offset) for that
 * session. Mirrors the Files tab's pendingReveals idiom so no anchor prop has
 * to thread through the Work tab tree.
 */
export type SessionAnchor = {
  /** Chat anchor: event sequence number of the message to scroll to. */
  event?: number;
  /** Terminal anchor: byte offset into the session scrollback. */
  offset?: number;
};

const pending = new Map<string, SessionAnchor>();

export function setPendingSessionAnchor(sessionId: string, anchor: SessionAnchor): void {
  if (anchor.event == null && anchor.offset == null) return;
  pending.set(sessionId, anchor);
}

export function takePendingSessionAnchor(sessionId: string): SessionAnchor | null {
  const anchor = pending.get(sessionId);
  if (anchor == null) return null;
  pending.delete(sessionId);
  return anchor;
}

/** Non-consuming read, for callers that need to check before the surface mounts. */
export function peekPendingSessionAnchor(sessionId: string): SessionAnchor | null {
  return pending.get(sessionId) ?? null;
}
