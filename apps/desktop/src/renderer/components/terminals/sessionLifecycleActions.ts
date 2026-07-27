import type { SessionSettleOverride, TerminalSessionSummary } from "../../../shared/types";
import { showToast } from "../app/toast/toastStore";
import {
  snoozeConfirmationLabel,
  snoozeDeadlineIso,
  type SnoozeDurationKey,
} from "../../lib/sessionSnooze";

/**
 * One place for the Work tab's snooze/wake/keep-active writes, so the sidebar
 * row menu, the row context menu, and the chat header chips can never disagree
 * about what an action does (or about the copy it confirms with).
 */

const UNDO_TOAST_MS = 5_000;

function reportFailure(action: string, sessionId: string, error: unknown): void {
  console.error(`[sessionLifecycle] ${action} failed`, { sessionId, error });
  showToast({
    title: `${action} failed`,
    message: error instanceof Error ? error.message : String(error),
    tone: "error",
  });
}

/**
 * Snooze one session and offer a 5s undo. The deadline is computed here (client
 * side) and handed over as a concrete ISO instant — expiry is derived from it
 * everywhere, so no scheduler is involved.
 */
export async function snoozeSessionForDuration(
  session: Pick<TerminalSessionSummary, "id">,
  key: SnoozeDurationKey,
  nowMs: number = Date.now(),
): Promise<void> {
  const untilIso = snoozeDeadlineIso(key, nowMs);
  try {
    await window.ade.sessions.snoozeSession(session.id, untilIso);
  } catch (error) {
    reportFailure("Snooze", session.id, error);
    return;
  }
  showToast({
    id: `session-snooze:${session.id}`,
    title: `Snoozed ${snoozeConfirmationLabel(key)}`,
    durationMs: UNDO_TOAST_MS,
    action: {
      label: "Undo",
      onClick: () => {
        void window.ade.sessions
          .wakeSession(session.id, "manual")
          .catch((error: unknown) => reportFailure("Undo snooze", session.id, error));
      },
    },
  });
}

/** Wake a snoozed row right now (the user asked, so the reason is "manual"). */
export async function wakeSessionNow(session: Pick<TerminalSessionSummary, "id">): Promise<void> {
  try {
    await window.ade.sessions.wakeSession(session.id, "manual");
  } catch (error) {
    reportFailure("Wake", session.id, error);
  }
}

/**
 * Pin a session's lifecycle. `"active"` is the keep-active pin that also
 * unsettles a DERIVED settle (clean exit 0 with no `settledAt`), which is the
 * only lifecycle action such a row has.
 */
export async function setSessionSettleOverride(
  session: Pick<TerminalSessionSummary, "id">,
  override: SessionSettleOverride,
): Promise<void> {
  try {
    await window.ade.sessions.setSettleOverride(session.id, override);
  } catch (error) {
    reportFailure(override === "active" ? "Keep active" : "Settle", session.id, error);
  }
}

/** Drop a row's "woke" marker once the user has actually looked at it. */
export function clearSessionWokeMarker(sessionId: string): void {
  void window.ade.sessions
    ?.clearWokeMarker?.(sessionId)
    .catch((error: unknown) => {
      console.error("[sessionLifecycle] clearWokeMarker failed", { sessionId, error });
    });
}
