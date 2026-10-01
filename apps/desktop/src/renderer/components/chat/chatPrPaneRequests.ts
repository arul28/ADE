import { requestWorkTool } from "../terminals/workToolRequests";

/**
 * "Show this pull request in the chat's PR tool."
 *
 * A PR pill outside the PR pane (the chat header, a session card, a lane
 * divider) opens the PR where the chat already is, not on the PRs tab. The
 * pane may be closed, showing another tool, or about to switch chats, so the
 * choice is held per lane and taken by the pane that belongs to that chat —
 * on mount, or at once when it is already on screen.
 *
 * Only the PR lists in the hover menus still open the PRs tab.
 */
type ChatPrSelection = {
  prId: string;
  /** The chat whose pane should take it. Null: any chat in the lane. */
  sessionId: string | null;
};

const pendingByLaneId = new Map<string, ChatPrSelection>();
const listeners = new Set<(laneId: string) => void>();

/** Hold the selection for the lane's PR pane and tell a pane already on screen. */
export function requestChatPrSelection(args: { laneId: string; sessionId?: string | null; prId: string }): void {
  const laneId = args.laneId.trim();
  const prId = args.prId.trim();
  if (!laneId || !prId) return;
  pendingByLaneId.set(laneId, { prId, sessionId: args.sessionId?.trim() || null });
  for (const listener of [...listeners]) listener(laneId);
}

/** Select the PR in the chat's pane and bring the PR tool up on the Work page. */
export function openPrInChatToolsPane(args: { laneId: string; sessionId?: string | null; prId: string }): void {
  requestChatPrSelection(args);
  requestWorkTool("pr");
}

/**
 * Take the held PR for this pane. A selection meant for another chat in the
 * same lane stays held: the session switch that goes with it has not reached
 * this pane yet.
 */
export function takeChatPrSelection(laneId: string, sessionId: string | null): string | null {
  const pending = pendingByLaneId.get(laneId);
  if (!pending) return null;
  if (pending.sessionId && sessionId && pending.sessionId !== sessionId) return null;
  pendingByLaneId.delete(laneId);
  return pending.prId;
}

export function subscribeChatPrSelections(listener: (laneId: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
