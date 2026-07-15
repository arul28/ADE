/**
 * Canonical navigation to a spawned child chat. Every spawn surface (inline
 * cards, completion chips, the lineage breadcrumb, the actions-pane row) routes
 * through this one helper so the `ade:work:select-session` contract — and its
 * try/catch guard — stays consistent. A no-op when `sessionId` is falsy.
 */
export function navigateToSpawnedChat(
  sessionId: string | null | undefined,
  laneId?: string | null,
): void {
  if (!sessionId) return;
  try {
    window.dispatchEvent(
      new CustomEvent("ade:work:select-session", {
        detail: { sessionId, laneId: laneId ?? null },
      }),
    );
  } catch {
    /* no-op */
  }
}
