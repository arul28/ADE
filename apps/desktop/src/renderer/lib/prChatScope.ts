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
