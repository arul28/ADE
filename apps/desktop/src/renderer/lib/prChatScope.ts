import type { PrSummary } from "../../shared/types";

/**
 * Scope a lane's PR set to one chat without reviving the old lane-wide
 * cross-talk. Rows with no edge are legacy data and may use the lane fallback;
 * that fallback is decided per PR so one linked row does not hide every older
 * row in the same lane.
 */
export function selectPrsForChat(
  prs: readonly PrSummary[],
  sessionId?: string | null,
): PrSummary[] {
  if (!sessionId) return [...prs];
  return prs.filter((pr) => {
    const linkedSessionIds = pr.chatSessionIds?.filter(Boolean) ?? [];
    return linkedSessionIds.length === 0 || linkedSessionIds.includes(sessionId);
  });
}

/**
 * Every PR this chat should show: owned by the lane OR explicitly linked to
 * this chat session, never detached, then scoped to the session.
 *
 * One function because the rule was written three times with three different
 * answers — the chat toolbar accepted a cross-lane linked PR while the PR pane
 * still pre-filtered on lane id, so the pane's own multi-PR selector could not
 * show the very PR the toolbar was showing.
 */
export function selectPrsForChatInLane(
  prs: readonly PrSummary[],
  laneId: string,
  sessionId?: string | null,
): PrSummary[] {
  const owned = prs.filter((pr) => {
    if (pr.detached) return false;
    if (pr.laneId === laneId) return true;
    return Boolean(sessionId && pr.chatSessionIds?.includes(sessionId));
  });
  return selectPrsForChat(owned, sessionId);
}
