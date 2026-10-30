import type { SettleAbortedReason } from "./settlingStateRegistry";

/**
 * @file The check a settle runs inside its settling window.
 *
 * Settle is a classification, not a stop. A settled chat keeps its background
 * shells, subagents, cloud runs, scheduled wakes and crons running exactly as
 * before; any of them that starts a new turn takes the chat out of settled
 * again (`sessionService.unsettleOnTurnStart`).
 *
 * The one thing a settle refuses is a chat whose turn is running right now: a
 * working chat cannot be settled, and the settle would be undone the moment the
 * turn's next event landed. The UI hides Settle on those rows
 * (`sessionIsMidFlight`); this is the host-side rule for every other caller
 * (the CLI, the phone, the CTO operator, the PR-merge poller).
 */

export type SettleCheckOutcome = {
  /** Set when the settle must NOT land. Nothing was changed either way. */
  abortedBy?: SettleAbortedReason;
};

/**
 * Per-call ceiling for the turn read. Without it a hung chat service holds the
 * settling window open forever: the row can never be settled again for the
 * life of the process, and the IPC or remote-command caller hangs with it.
 */
const TURN_READ_TIMEOUT_MS = 10_000;

export type SettleTurnCheckDeps = {
  /**
   * Whether a turn is running right now. `null` for a session the chat service
   * does not own (a plain terminal), which has no turn to wait for.
   */
  readTurnRunning: (sessionId: string) => Promise<boolean | null>;
  logger?: { warn: (message: string, meta?: Record<string, unknown>) => void };
  /** Fires when the read has taken too long. Real timer by default. */
  expireRead?: () => Promise<void>;
};

export function createSettleTurnCheck(
  deps: SettleTurnCheckDeps,
): (sessionId: string) => Promise<SettleCheckOutcome> {
  const expireRead = deps.expireRead
    ?? (() => new Promise<void>((resolve) => { setTimeout(resolve, TURN_READ_TIMEOUT_MS).unref?.(); }));

  return async (sessionId) => {
    let read: { ok: true; running: boolean | null } | { ok: false };
    try {
      read = await Promise.race([
        deps.readTurnRunning(sessionId).then((running) => ({ ok: true, running }) as const),
        expireRead().then(() => ({ ok: false }) as const),
      ]);
    } catch (error) {
      deps.logger?.warn("settle_check.read_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      read = { ok: false };
    }
    // A read that never answered is not evidence the chat is at rest; settling
    // it could file a working chat. Refuse, and let the caller try again.
    if (!read.ok) return { abortedBy: "status_unknown" };
    if (read.running) return { abortedBy: "turn_running" };
    return {};
  };
}

/** A subagent and the parent that spawned it, for the settle cascade. */
export type SubagentLink = { sessionId: string; parentSessionId: string };
