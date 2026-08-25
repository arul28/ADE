/**
 * The `settling` state: the window between deciding to settle a session and the
 * settle landing.
 *
 * The lifecycle revision (step 1) detects that the world moved. It does not say
 * what to do about work already stopped when it moves — that is R2, the one race
 * where both outcomes are bad. This registry is the other half: a short-lived,
 * visible, exclusive, abortable marker that teardown runs inside.
 *
 * Deliberately IN MEMORY. The design requires a `settling` row found at startup
 * to resolve to not-settled, because teardown is not resumable across a restart
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
  | "teardown_failed"
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
  /** The revision the settle decision was taken against. */
  startedAtRevision: number;
  abortedBy: SettleAbortReason | null;
  /**
   * Identifies THIS window. `end` refuses to close a window it did not open, so
   * an owner whose window was already torn down out from under it (a session
   * deleted mid-teardown) cannot close the one a newer settle has since opened
   * for the same id — which would leave two teardowns believing they own it.
   */
  token: number;
};

export type BeginSettlingResult =
  /** This caller owns the window and must end it, passing back its token. */
  | { kind: "started"; token: number }
  /**
   * Another settle for this session is already in flight. The caller JOINS it
   * rather than starting a second teardown — closing R4, where two teardowns
   * race one session and the second reports against a partially-drained roster.
   */
  | { kind: "joined" };

export class SettlingStateRegistry {
  private readonly entries = new Map<string, SettlingEntry>();
  private nextToken = 1;

  begin(sessionId: string, startedAtRevision: number): BeginSettlingResult {
    if (this.entries.has(sessionId)) return { kind: "joined" };
    const token = this.nextToken++;
    this.entries.set(sessionId, { startedAtRevision, abortedBy: null, token });
    return { kind: "started", token };
  }

  isSettling(sessionId: string): boolean {
    return this.entries.has(sessionId);
  }

  /** Every session currently mid-settle, for the "Settling…" projection. */
  settlingSessionIds(): string[] {
    return Array.from(this.entries.keys());
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
   * recreated a new settle opens a fresh window; a stale teardown consulting
   * `abortedBy` alone would read the replacement, see "not aborted", and keep
   * issuing provider stops against the new session's work.
   */
  abandoned(sessionId: string, token: number): boolean {
    const entry = this.entries.get(sessionId);
    return !entry || entry.token !== token || entry.abortedBy !== null;
  }

  startedAtRevision(sessionId: string): number | null {
    return this.entries.get(sessionId)?.startedAtRevision ?? null;
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
