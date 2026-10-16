import type { OpenProjectBinding, TerminalSessionSummary } from "../../shared/types";

/**
 * Requests one pane makes of the Work surface: focus a session, or open its
 * context menu at a point. The chat actions pane uses both for a shell row —
 * the same handlers a right-click in the Work list runs, without threading the
 * list's whole prop surface (and its dialogs) into the pane.
 *
 * Events, not props, on purpose: the listeners live in `TerminalsPage`, which
 * already owns `focusSession` and the one `SessionContextMenu` for the whole
 * Work tab. A pane-mounted menu would be a second host with its own handlers,
 * which is exactly how two right-click menus drift apart.
 */

/**
 * Focus a session in the Work tab. The same contract `navigateToSpawnedChat`
 * uses, so a shell and a spawned chat cannot land in different places.
 */
export function focusWorkSession(
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

/**
 * Open the Work list's context menu for a session, at a viewport point. The
 * row travels with the request because the pane may be showing a session this
 * machine's list does not hold (a chat on another machine), and the menu needs
 * that row — not a lookup that would find nothing.
 */
export function openWorkSessionMenu(
  session: TerminalSessionSummary,
  point: { x: number; y: number },
  binding?: OpenProjectBinding | null,
): void {
  try {
    window.dispatchEvent(
      new CustomEvent("ade:work:open-session-menu", {
        detail: { session, x: point.x, y: point.y, ...(binding ? { binding } : {}) },
      }),
    );
  } catch {
    /* no-op */
  }
}
