export function openLaneInLanesTabPath(laneId: string): string {
  const params = new URLSearchParams({
    laneId,
    focus: "single",
  });
  return `/lanes?${params.toString()}`;
}

/**
 * Path that opens a specific agent session in the Work tab of its lane. The
 * Lanes page consumes the `sessionId` param via `focusSession` to select the
 * agent once the lane work view mounts.
 */
export function openAgentInWorkTabPath(laneId: string, sessionId: string): string {
  const params = new URLSearchParams({
    laneId,
    sessionId,
    focus: "single",
  });
  return `/lanes?${params.toString()}`;
}
