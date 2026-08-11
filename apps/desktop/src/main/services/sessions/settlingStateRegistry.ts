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

declare const settleTeardownCompletedBrand: unique symbol;

/**
 * Proof that a teardown finished synchronously.
 *
 * The settle path is synchronous in step 2, and a teardown that defers is not
 * merely unsupported — it is actively harmful: the settling window would close
 * while the unowned continuation kept stopping processes, so C4/C5 output from
 * those stops would no longer be swallowed and would clear the settle that just
 * landed. Losing the work AND the settle is the R2 shape.
 *
 * A runtime check cannot prevent this. `async (id) => {}` is caught by its
 * constructor, but the common adapter `id => asyncStop(id)` is an ordinary
 * `Function` and has already started the work by the time any check runs. So the
 * seam demands a value only a synchronous body can produce: an `async` function
 * or a promise-returning adapter returns `Promise<...>`, which is not assignable
 * to this brand, and fails to COMPILE.
 *
 * Step 3 replaces this with an awaited seam once the settle path itself is async.
 */
export type SettleTeardownCompleted = { readonly [settleTeardownCompletedBrand]: true };

/** The only way to produce a `SettleTeardownCompleted`. */
export function settleTeardownCompleted(): SettleTeardownCompleted {
  return {} as SettleTeardownCompleted;
}

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
