/**
 * The bridge between a handoff entry point that lives outside the chat pane
 * (the session context menu) and the chat pane that owns the actual handoff
 * surfaces (the Handoff tab, the cross-machine modal, the auto-handoff modal).
 *
 * A context menu cannot open those surfaces directly: they are mounted and
 * stateful inside `AgentChatPane`, and right-clicking a session that is not yet
 * selected means the pane has not even rendered for that session when the click
 * lands. So the menu records the intent and asks for the session to be selected;
 * the pane picks the intent up either as a live delivery (session already
 * selected) or from the queue (pane mounts or re-selects a moment later).
 *
 * Deliberately module-local rather than a store slice: the payload is a
 * transient one-shot command, not application state anything should render.
 */

export type ChatHandoffIntent = "local" | "remote";

type ChatHandoffListener = (sessionId: string, intent: ChatHandoffIntent) => void;

type PendingChatHandoff = {
  sessionId: string;
  intent: ChatHandoffIntent;
  queuedAt: number;
};

const listeners = new Set<ChatHandoffListener>();
let pending: PendingChatHandoff | null = null;

/**
 * A queued intent is a transient command, not state. If the target pane never
 * mounts (the session failed to open, the user navigated away), consuming it an
 * arbitrary time later would open the handoff surface uninvited — the same
 * reason `agentChatDraftHandoff` bounds its queue. Kept local rather than shared
 * because that sibling keys a different payload by target and notifies through a
 * window event; the two diverge in housekeeping, not in intent.
 */
const MAX_PENDING_AGE_MS = 30_000;

/**
 * Queue a handoff and notify any pane already listening for that session. The
 * queue is what survives the common "select, then mount" ordering; the live
 * notification is what makes "same session, already open" feel instant.
 *
 * One slot, last write wins: a human picks a destination and the matching pane
 * consumes it within a render, so enqueuing for a second session before the
 * first is taken replaces the first rather than accumulating stale commands.
 */
export function openChatHandoff(sessionId: string, intent: ChatHandoffIntent): void {
  pending = { sessionId, intent, queuedAt: Date.now() };
  for (const listener of [...listeners]) listener(sessionId, intent);
}

export function subscribeChatHandoff(listener: ChatHandoffListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Return and clear the queued intent for this session, if any. A stale intent
 * (older than `MAX_PENDING_AGE_MS`) is discarded rather than consumed, so a
 * command whose pane never mounted cannot fire on a much later selection. An
 * intent queued for a different session is left in place, not returned.
 */
export function takeChatHandoff(sessionId: string): ChatHandoffIntent | null {
  if (!pending || pending.sessionId !== sessionId) return null;
  const intent = pending.intent;
  const stale = Date.now() - pending.queuedAt > MAX_PENDING_AGE_MS;
  pending = null;
  return stale ? null : intent;
}

/** Test hook; production code never needs to reset the module. */
export function resetChatHandoffIntentForTest(): void {
  pending = null;
  listeners.clear();
}
