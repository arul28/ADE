/**
 * The builder for "open this lane in the Lanes tab". `focus=single` frames the
 * Lanes tab on one lane; an optional `sessionId` selects a session in it.
 * Shared by the App-level lane deeplink, the create-lane-from-PR flow, and the
 * PR lane chips so those params cannot drift between entry points.
 */
export function openLaneInLanesTabPath(laneId: string, sessionId?: string | null): string {
  const params = new URLSearchParams({
    laneId,
    focus: "single",
  });
  if (sessionId) params.set("sessionId", sessionId);
  return `/lanes?${params.toString()}`;
}
