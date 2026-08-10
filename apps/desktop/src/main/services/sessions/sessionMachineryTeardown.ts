import type { createAgentChatService } from "../chat/agentChatService";
import type { createSessionService } from "./sessionService";
import { isChatToolType } from "./chatSessionProjection";

/**
 * Stop the machinery a session owns when its lifecycle ends.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Settle used to be a pure column write. The row went quiet and everything the
 * session had started kept going: background shells held ports, subagent fleets
 * kept spending tokens, and scheduled work woke the thread hours after the user
 * had declared it done. "Settled" claimed a conclusion the process tree had not
 * reached.
 *
 * Archive had the mirror problem from the other end — it released the lane's
 * port lease and proxy route while the processes were still holding those
 * ports, so the lease could be handed to another lane that then could not bind.
 *
 * Both now converge here so the step list cannot drift into two versions.
 *
 * ── What settle stops, and what it deliberately does not ────────────────────
 *
 *   stops    scheduled work (monitors, crons, loops) for the session
 *   stops    live background work — background shells, subagent fleets,
 *            cursor cloud runs — via `agentChatService.stopBackgroundWork`
 *   keeps    the session itself, and its runtime, alive and resumable
 *   keeps    terminal panes open — a terminal is USER-owned. An agent's
 *            background shell is thread background work; the pane the user
 *            opened to watch a build is theirs, and closing it on settle would
 *            destroy scrollback they never asked to lose.
 *   keeps    an ACTIVE foreground turn running (see `stopBackgroundWork`).
 *
 * ── What escapes, stated plainly ────────────────────────────────────────────
 *
 * A process an agent detached with `nohup`, `setsid`, or `disown` leaves ADE's
 * tree entirely and nothing here can reach it. Codex background subagents are
 * reported but expose no stop control. Neither is silently pretended away:
 * `stopBackgroundWork` returns what it actually acted on.
 */
export type SessionMachineryTeardownDeps = {
  sessionService: Pick<ReturnType<typeof createSessionService>, "get">;
  agentChatService?: Pick<
    ReturnType<typeof createAgentChatService>,
    "stopBackgroundWork" | "setScheduledWorkPausedForSettle" | "listScheduledWork"
  > | null;
  logger?: { warn: (message: string, meta?: Record<string, unknown>) => void } | null;
};

export type SessionMachineryTeardownResult = {
  /** Sessions whose machinery this pass touched. */
  sessionIds: string[];
  /** Live background jobs stopped across those sessions. */
  stoppedBackgroundWork: number;
  /** Sessions whose scheduled work was paused. */
  pausedScheduledWork: number;
  /** Sessions skipped because a foreground turn was still streaming. */
  skippedActiveTurns: number;
};

const EMPTY_RESULT: SessionMachineryTeardownResult = {
  sessionIds: [],
  stoppedBackgroundWork: 0,
  pausedScheduledWork: 0,
  skippedActiveTurns: 0,
};

/**
 * Pause rather than cancel, and pause REVERSIBLY.
 *
 * Cancelling would be destructive and irreversible: a settle that turns out to
 * be premature would have silently deleted schedules the user set up by hand.
 *
 * The pause is durable, so it needs an exact undo or it is just a slower
 * deletion — a settled-then-unsettled chat would keep its monitors, crons, and
 * scheduled turns disabled forever. `setScheduledWorkPausedForSettle` claims
 * the pause only when the user had not already taken one, and
 * `resumeSettledSessionMachinery` puts back precisely what it claimed. See
 * `chatScheduledWorkScheduler`'s `settlePausedSessionIds`.
 */
async function setScheduledWorkPaused(
  deps: SessionMachineryTeardownDeps,
  sessionId: string,
  paused: boolean,
): Promise<boolean> {
  const service = deps.agentChatService;
  if (!service) return false;
  try {
    if (paused) {
      const schedules = await service.listScheduledWork({ sessionId });
      const armed = schedules.some(
        (schedule) => schedule.status !== "completed" && schedule.status !== "cancelled",
      );
      if (!armed) return false;
    }
    return await service.setScheduledWorkPausedForSettle({ sessionId, paused });
  } catch (error) {
    deps.logger?.warn("session_teardown.scheduled_work_pause_failed", {
      sessionId,
      paused,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Stop the background machinery for a set of sessions being settled.
 *
 * Best-effort by construction: a settle must not fail because a provider could
 * not be reached, so every step swallows its own error and the result reports
 * what actually happened.
 */
export async function stopSettledSessionMachinery(
  deps: SessionMachineryTeardownDeps,
  sessionIds: readonly string[],
): Promise<SessionMachineryTeardownResult> {
  const unique = [...new Set(sessionIds.map((id) => id.trim()).filter(Boolean))];
  if (unique.length === 0) return EMPTY_RESULT;

  const result: SessionMachineryTeardownResult = {
    sessionIds: [],
    stoppedBackgroundWork: 0,
    pausedScheduledWork: 0,
    skippedActiveTurns: 0,
  };

  for (const sessionId of unique) {
    const row = deps.sessionService.get(sessionId);
    // Only chat-backed sessions own the machinery this tears down. A plain
    // terminal's process is the user's, and a tracked agent CLI's work lives in
    // its PTY — which settle keeps open on purpose.
    if (!row || !isChatToolType(row.toolType)) continue;
    result.sessionIds.push(sessionId);

    if (await setScheduledWorkPaused(deps, sessionId, true)) result.pausedScheduledWork += 1;

    const service = deps.agentChatService;
    if (!service) continue;
    try {
      const stop = await service.stopBackgroundWork({ sessionId });
      result.stoppedBackgroundWork += stop.stopped;
      if (stop.skippedActiveTurn) result.skippedActiveTurns += 1;
    } catch (error) {
      deps.logger?.warn("session_teardown.stop_background_work_failed", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

/**
 * The undo half of settle teardown, run by every unsettle path.
 *
 * Only resumes schedules that settle itself paused — a pause the user took
 * deliberately survives an unsettle untouched. Background work is deliberately
 * NOT restarted: ADE cannot re-spawn a shell or a subagent fleet it stopped,
 * and pretending otherwise would be worse than leaving the session quiet.
 */
export async function resumeSettledSessionMachinery(
  deps: SessionMachineryTeardownDeps,
  sessionIds: readonly string[],
): Promise<{ sessionIds: string[]; resumedScheduledWork: number }> {
  const unique = [...new Set(sessionIds.map((id) => id.trim()).filter(Boolean))];
  const touched: string[] = [];
  let resumedScheduledWork = 0;
  for (const sessionId of unique) {
    const row = deps.sessionService.get(sessionId);
    if (!row || !isChatToolType(row.toolType)) continue;
    touched.push(sessionId);
    if (await setScheduledWorkPaused(deps, sessionId, false)) resumedScheduledWork += 1;
  }
  return { sessionIds: touched, resumedScheduledWork };
}
