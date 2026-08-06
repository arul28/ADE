import type { PrSummary } from "../../shared/types";

/**
 * Scope a lane's PR set to one chat without reviving the old lane-wide
 * cross-talk. Rows with no edge are legacy data and may use the lane fallback;
 * once any row has an explicit edge, an unlinked chat must see no PRs rather
 * than another chat's work.
 */
export function selectPrsForChat(
  prs: readonly PrSummary[],
  sessionId?: string | null,
): PrSummary[] {
  if (!sessionId) return [...prs];
  const hasExplicitLinks = prs.some((pr) => (pr.chatSessionIds?.length ?? 0) > 0);
  if (!hasExplicitLinks) return [...prs];
  return prs.filter((pr) => pr.chatSessionIds?.includes(sessionId) === true);
}
