import type { OpenProjectBinding } from "../../../shared/types";

/**
 * Canonical navigation to a spawned child chat. Every spawn surface (inline
 * cards, completion lines, the lineage breadcrumb, the actions-pane row) routes
 * through this one helper so the `ade:work:select-session` contract — and its
 * try/catch guard — stays consistent. A no-op when `sessionId` is falsy.
 *
 * `binding` pins the jump to the machine the chat lives on; leave it out (or
 * null) for this tab's own machine, or when only the Work list knows it.
 */
export function navigateToSpawnedChat(
  sessionId: string | null | undefined,
  laneId?: string | null,
  binding?: OpenProjectBinding | null,
): void {
  if (!sessionId) return;
  try {
    window.dispatchEvent(
      new CustomEvent("ade:work:select-session", {
        detail: { sessionId, laneId: laneId ?? null, ...(binding ? { binding } : {}) },
      }),
    );
  } catch {
    /* no-op */
  }
}
