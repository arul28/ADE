/**
 * The `settling` state: the window between deciding to settle a session and the
 * settle landing.
 *
 * A settle reads whether the session's turn is running (`settleTurnCheck.ts`)
 * and only then writes, so a turn that starts during that await must win. The
 * lifecycle revision detects that the world moved; this registry is the other
 * half: a short-lived, exclusive, abortable marker the check runs inside, so a
 * turn start or a peer's decision abandons the settle instead of being
 * overwritten by it.
 *
 * Deliberately IN MEMORY. The design requires a `settling` row found at startup
 * to resolve to not-settled, because a settle is not resumable across a restart
 * and pretending otherwise would resurrect the "orphaned work is live work"
 * mistake the liveness half avoids. In-memory gives that for free: a restart has
 * no settling sessions, which is exactly the required answer. It also keeps the
 * marker off `terminal_sessions`, which is a CRR — a replicated "settling" flag
 * would be a lie on every other device the moment this host died.
 */

/** Why a settle was abandoned. Only ever set by a human-decision clearer. */
export type SettleAbortReason =
  | "turn_start"
  | "turn_failed"
  | "attention_requested"
  /** A peer changed the settle tuple; its decision outranks a settle in flight. */
  | "remote_lifecycle_changed";

/** Why a settle was abandoned, as reported to callers. */
export type SettleAbortedReason =
  | SettleAbortReason
  | "lifecycle_changed"
  /** A turn is running. A working chat cannot be settled. */
  | "turn_running"
  /** ADE could not tell whether a turn is running, so it did not settle. */
  | "status_unknown"
  /** Another settle owned the window; this caller filed nothing. */
  | "joined_in_flight";

export type SettleAbortedSession = {
  sessionId: string;
  reason: SettleAbortedReason;
};

export type SettleSessionsOutcome = {
  settled: string[];
  /** Explicitly abandoned — never silently absent. */
  aborted: SettleAbortedSession[];
};

export type SettlingEntry = {
  abortedBy: SettleAbortReason | null;
  /**
   * Identifies THIS window. `end` refuses to close a window it did not open, so
   * an owner whose window was already closed out from under it (a session
   * deleted mid-settle) cannot close the one a newer settle has since opened
   * for the same id — which would leave two settles believing they own it.
   */
  token: number;
};

export type BeginSettlingResult =
  /** This caller owns the window and must end it, passing back its token. */
  | { kind: "started"; token: number }
  /**
   * Another settle for this session is already in flight. The caller JOINS it
   * rather than starting a second settle — closing R4, where two settles race
   * one session and both report an outcome for it.
   */
  | { kind: "joined" };

export class SettlingStateRegistry {
  private readonly entries = new Map<string, SettlingEntry>();
  private nextToken = 1;

  begin(sessionId: string): BeginSettlingResult {
    if (this.entries.has(sessionId)) return { kind: "joined" };
    const token = this.nextToken++;
    this.entries.set(sessionId, { abortedBy: null, token });
    return { kind: "started", token };
  }

  isSettling(sessionId: string): boolean {
    return this.entries.has(sessionId);
  }

  /**
   * Trip the abort. Idempotent, and first-reason-wins so the surfaced cause is
   * the one that actually interrupted the settle.
   */
  abort(sessionId: string, reason: SettleAbortReason): void {
    const entry = this.entries.get(sessionId);
    if (!entry || entry.abortedBy) return;
    entry.abortedBy = reason;
  }

  abortedBy(sessionId: string): SettleAbortReason | null {
    return this.entries.get(sessionId)?.abortedBy ?? null;
  }

  /**
   * Has THIS window been abandoned — either aborted, or replaced?
   *
   * A settle that no longer owns the id must stop as surely as an aborted one.
   * `forget` (a deleted session) force-closes the entry, and if the id is then
   * recreated a new settle opens a fresh window; a stale settle consulting
   * `abortedBy` alone would read the replacement, see "not aborted", and file
   * the new session as settled.
   */
  abandoned(sessionId: string, token: number): boolean {
    const entry = this.entries.get(sessionId);
    return !entry || entry.token !== token || entry.abortedBy !== null;
  }

  /** Closes the window only if `token` still owns it. Omit to force-close. */
  end(sessionId: string, token?: number): void {
    if (token !== undefined && this.entries.get(sessionId)?.token !== token) return;
    this.entries.delete(sessionId);
  }

  /** Project or host teardown: nothing in flight survives it. */
  clear(): void {
    this.entries.clear();
  }
}
