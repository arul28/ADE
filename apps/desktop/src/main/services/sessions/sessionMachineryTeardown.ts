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
 *   stops    live background work — background shells, subagent fleets,
 *            cursor cloud runs — via `agentChatService.stopBackgroundWork`
 *   keeps    the session itself, and its runtime, alive and resumable
 *   keeps    terminal panes open — a terminal is USER-owned. An agent's
 *            background shell is thread background work; the pane the user
 *            opened to watch a build is theirs, and closing it on settle would
 *            destroy scrollback they never asked to lose.
 *   keeps    an ACTIVE foreground turn running (see `stopBackgroundWork`).
 *
 * ── Scheduled work is deliberately NOT stopped ──────────────────────────────
 *
 * An earlier version of this paused the session's durable schedules. It was
 * removed, and the reason is worth keeping: the pause is persisted, so it needs
 * an exact undo on every route that clears a settle — and `settled_at` is
 * cleared from seven places, including `setLastOutputPreview` on the hot PTY
 * output path. Three review rounds each found another route that skipped the
 * resume and left a chat's monitors and crons disabled forever. A pause without
 * a complete undo is a slower deletion of the user's own schedules.
 *
 * It is also the smaller loss than it looks. ADE's scheduled work is already
 * visible and user-manageable (`scheduledWork` and `nextWakeAt` on the summary,
 * a per-session pause toggle), and `canonicalSessionState` already handles a
 * settled chat woken by scheduled work: it shows green while the turn streams,
 * then re-settles. The unmanaged, invisible thing settle needed to stop was
 * background work, and that is what it stops.
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
    "stopBackgroundWork"
  > | null;
  logger?: { warn: (message: string, meta?: Record<string, unknown>) => void } | null;
};

export type SessionMachineryTeardownResult = {
  /** Sessions whose machinery this pass touched. */
  sessionIds: string[];
  /**
   * Sessions whose foreground turn was still streaming. Their detached
   * background work is still stopped; only the turn's own subagents are spared.
   */
  skippedActiveTurns: number;
};

const EMPTY_RESULT: SessionMachineryTeardownResult = {
  sessionIds: [],
  skippedActiveTurns: 0,
};


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
        skippedActiveTurns: 0,
  };

  for (const sessionId of unique) {
    const row = deps.sessionService.get(sessionId);
    // Only chat-backed sessions own the machinery this tears down. A plain
    // terminal's process is the user's, and a tracked agent CLI's work lives in
    // its PTY — which settle keeps open on purpose.
    if (!row || !isChatToolType(row.toolType)) continue;
    result.sessionIds.push(sessionId);

    const service = deps.agentChatService;
    if (!service) continue;
    try {
      const stop = await service.stopBackgroundWork({ sessionId });
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

