/**
 * The Work page on one chat. For a chat ADE just started or opened, go
 * straight there, not through a chat link: a link first asks the chat's
 * computer for it, and a computer that just opened (or answers slowly) can
 * miss that check, so the link says the chat cannot be found.
 */
export function workChatPath(sessionId: string, laneId: string | null | undefined): string {
  const params = new URLSearchParams({ sessionId });
  if (laneId) params.set("laneId", laneId);
  return `/work?${params.toString()}`;
}
