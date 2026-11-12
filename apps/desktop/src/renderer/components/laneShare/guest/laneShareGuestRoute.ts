/** The page of lanes other accounts share with me (`/shared`). No project needed. */
export const LANE_SHARE_GUEST_ROUTE = "/shared";

export function laneShareGuestPath(grantId: string, sessionId?: string | null): string {
  const params = new URLSearchParams({ grant: grantId });
  if (sessionId) params.set("session", sessionId);
  return `${LANE_SHARE_GUEST_ROUTE}?${params.toString()}`;
}
