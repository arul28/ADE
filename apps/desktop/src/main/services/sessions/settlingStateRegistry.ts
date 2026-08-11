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

/**
 * What a teardown could not confirm it stopped (§3d, option 3).
 *
 * The settle still lands — that is the signed-off decision — but it lands WITH
 * this attached, so "settled" never quietly means "and something is still
 * running". A label alone would just be a prettier way of losing the process,
 * so each item says what it was, why the stop did not confirm, and whether the
 * existing ppid-based orphan reaper can still reach it.
 */
export type SettleResidueItem = {
  /** Coarse and closed: this is also the analytics dimension. */
  kind: "background_tasks" | "active_turn" | "scheduled_work";
  /**
   * Why the stop did not confirm. `no_stop_control` is a provider that offers
   * no way to stop this work at all (a Codex chat's subagents); `timeout` and
   * `rejected` are a stop that was attempted and did not land.
   */
  reason: "no_stop_control" | "timeout" | "rejected";
  /**
   * Whether the orphan reaper can still reach it. Work that escaped the process
   * tree (`nohup`/`setsid`/`disown`) is unreachable and must be reported as
   * such rather than folded into the reapable count.
   */
  reapable: boolean;
  /** Human-readable, for the diagnostics surface. Never analytics. */
  detail: string;
};

/** Checked BETWEEN stop calls, per §3c. A turn start trips it. */
export type SettleTeardownContext = {
  isAborted: () => boolean;
};

/**
 * The result of a real teardown.
 *
 * `stopped` is what confirmed, in the order attempted; `residue` is §3d.
 *
 * This replaces step 2's synchronous `SettleTeardownCompleted` brand. That
 * brand existed to make an async teardown a COMPILE error while the settle path
 * was still synchronous — bolting a deferred teardown onto a synchronous write
 * was exactly the mistake that produced a P1 in each of #1059's six rounds. It
 * is safe to await now for one specific reason: the settling window (step 2) is
 * exclusive, abortable and crash-safe, so it can be HELD across the await. The
 * revision re-check and the abort flag after the await are what make the
 * suspension point survivable, and both are tested by the race matrix.
 */
export type SettleTeardownOutcome = {
  stopped: string[];
  residue: SettleResidueItem[];
};

/** Why a settle was abandoned. Only ever set by a human-decision clearer. */
export type SettleAbortReason = "turn_start" | "turn_failed" | "attention_requested";

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
};

export type BeginSettlingResult =
  /** This caller owns the window and must end it. */
  | { kind: "started" }
  /**
   * Another settle for this session is already in flight. The caller JOINS it
   * rather than starting a second teardown — closing R4, where two teardowns
   * race one session and the second reports against a partially-drained roster.
   */
  | { kind: "joined" };

export class SettlingStateRegistry {
  private readonly entries = new Map<string, SettlingEntry>();

  begin(sessionId: string, startedAtRevision: number): BeginSettlingResult {
    if (this.entries.has(sessionId)) return { kind: "joined" };
    this.entries.set(sessionId, { startedAtRevision, abortedBy: null });
    return { kind: "started" };
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

  startedAtRevision(sessionId: string): number | null {
    return this.entries.get(sessionId)?.startedAtRevision ?? null;
  }

  end(sessionId: string): void {
    this.entries.delete(sessionId);
  }

  /** Project or host teardown: nothing in flight survives it. */
  clear(): void {
    this.entries.clear();
  }
}
