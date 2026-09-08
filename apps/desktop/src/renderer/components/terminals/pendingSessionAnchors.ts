import { createKeyedPendingStore } from "../../lib/pendingRequestChannel";

/**
 * One-shot "position this session's content when it next mounts" queue.
 * Set by deeplink navigation (/work?sessionId=...&event=N / &offset=N) and by
 * ⌘K search-result activation; consumed by the chat message list (event
 * sequence anchor) or the terminal view (scrollback byte offset) for that
 * session. Keyed by session id via `createKeyedPendingStore`, so no anchor prop
 * has to thread through the Work tab tree.
 */
export type SessionAnchor = {
  /** Chat anchor: event sequence number of the message to scroll to. */
  event?: number;
  /** Terminal anchor: byte offset into the session scrollback. */
  offset?: number;
};

const anchors = createKeyedPendingStore<SessionAnchor>();

export function setPendingSessionAnchor(sessionId: string, anchor: SessionAnchor): void {
  if (anchor.event == null && anchor.offset == null) return;
  anchors.set(sessionId, anchor);
}

export const takePendingSessionAnchor = anchors.take;

/** Non-consuming read, for callers that need to check before the surface mounts. */
export const peekPendingSessionAnchor = anchors.peek;
