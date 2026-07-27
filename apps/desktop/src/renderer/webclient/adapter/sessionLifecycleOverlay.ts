import type { TerminalSessionSummary } from "../../../shared/types";

/**
 * Optimistic overlay for session-lifecycle writes in the web client.
 *
 * Desktop and iOS both own a local database, so a settle/snooze lands in local
 * state the instant it is written and the UI repaints from that row. ADE Web
 * has NO local database: every lifecycle mutation is a sync round-trip to the
 * paired machine, and the only way the row changes is when a later
 * `work.listSessions` read comes back. Without an overlay the user taps
 * "Snooze" and the row sits in place for the whole round-trip, then jumps.
 *
 * So each mutation records a patch here, the UI is nudged to re-read straight
 * away (the read is decorated with the patch), and the entry is retired in
 * exactly one of three ways:
 *
 *   - reconciled — an authoritative row arrives that already satisfies the
 *     intent, so the overlay is redundant and is dropped,
 *   - rejected — the host refused or the transport failed, so the overlay is
 *     dropped immediately and the row visibly snaps back (the caller also
 *     surfaces the failure toast),
 *   - expired — a hard TTL so a lost ack can never wedge a row into showing a
 *     state the machine does not agree with.
 *
 * The overlay only ever writes the lifecycle columns. It never touches phase:
 * `canonicalSessionState` derives that, and snooze is a visibility overlay that
 * the canonical derivation deliberately does not read.
 */

export type SessionLifecyclePatch = Partial<
  Pick<
    TerminalSessionSummary,
    "settledAt" | "settleOverride" | "snoozedUntil" | "snoozedAt" | "wokeAt" | "wokeReason"
  >
>;

/**
 * Instant columns the HOST owns. We optimistically stamp our own clock into
 * them, which will never equal the machine's, so reconciliation compares
 * presence (set vs cleared) — the only part of a timestamp the write actually
 * intended.
 */
const TIMESTAMP_KEYS = ["settledAt", "snoozedUntil", "snoozedAt", "wokeAt"] as const satisfies
  readonly (keyof SessionLifecyclePatch)[];

/** Enum columns the client fully determines, so these compare exactly. */
const ENUM_KEYS = ["settleOverride", "wokeReason"] as const satisfies
  readonly (keyof SessionLifecyclePatch)[];

/**
 * Ceiling on an unconfirmed optimistic patch. Longer than the sync command
 * timeout so a slow-but-alive round-trip is not yanked out from under the user,
 * short enough that a dropped ack self-heals without a reload.
 */
export const OPTIMISTIC_TTL_MS = 20_000;

/**
 * Once the host has acked, the authoritative row still has to travel back
 * through the changeset pump. Hold the patch for this long so the row does not
 * flicker back to its old state in the gap, then trust the host.
 */
export const RECONCILE_GRACE_MS = 8_000;

type PendingEntry = {
  token: number;
  patch: SessionLifecyclePatch;
  expiresAtMs: number;
};

export type SessionLifecycleOverlayOptions = {
  now?: () => number;
};

export type SessionLifecycleReconcileReport = {
  /** Patches the machine's rows now agree with. */
  reconciled: string[];
  /** Patches dropped without agreement — the row visibly returns to host state. */
  rolledBack: string[];
};

export class SessionLifecycleOverlay {
  /**
   * One entry per session: lifecycle actions are per-row and last-write-wins,
   * so a second action on the same row supersedes the first rather than
   * stacking a patch history nobody could reconcile.
   */
  private readonly pending = new Map<string, PendingEntry>();
  private nextToken = 1;
  private readonly now: () => number;

  constructor(options: SessionLifecycleOverlayOptions = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  /** Apply a patch immediately and return the token used to settle it later. */
  begin(sessionId: string, patch: SessionLifecyclePatch): number {
    const token = this.nextToken++;
    if (!sessionId) return token;
    this.pending.set(sessionId, {
      token,
      patch,
      expiresAtMs: this.now() + OPTIMISTIC_TTL_MS,
    });
    return token;
  }

  /** Host accepted: keep painting the patch until the authoritative row lands. */
  confirm(sessionId: string, token: number): void {
    const entry = this.pending.get(sessionId);
    if (!entry || entry.token !== token) return;
    entry.expiresAtMs = this.now() + RECONCILE_GRACE_MS;
  }

  /** Host rejected (or the transport did): drop the patch so the row rolls back. */
  reject(sessionId: string, token: number): void {
    const entry = this.pending.get(sessionId);
    if (!entry || entry.token !== token) return;
    this.pending.delete(sessionId);
  }

  has(sessionId: string): boolean {
    return this.pending.has(sessionId);
  }

  get size(): number {
    return this.pending.size;
  }

  clear(): void {
    this.pending.clear();
  }

  /**
   * Retire entries the authoritative rows have caught up with (or that have
   * outlived their TTL). Call with the raw host rows BEFORE decorating them.
   *
   * `reconciled` entries agreed with the machine, so the painted row already
   * matches and nothing needs to move. `rolledBack` entries were dropped
   * without the machine ever agreeing, so the row is about to change back and
   * the caller must tell the UI.
   */
  reconcile(
    rows: readonly TerminalSessionSummary[],
    nowMs: number = this.now(),
  ): SessionLifecycleReconcileReport {
    const reconciled: string[] = [];
    const rolledBack: string[] = [];
    if (this.pending.size === 0) return { reconciled, rolledBack };
    for (const row of rows) {
      const entry = this.pending.get(row.id);
      if (!entry) continue;
      if (!patchSatisfiedBy(entry.patch, row)) continue;
      this.pending.delete(row.id);
      reconciled.push(row.id);
    }
    for (const [sessionId, entry] of this.pending) {
      if (entry.expiresAtMs > nowMs) continue;
      this.pending.delete(sessionId);
      rolledBack.push(sessionId);
    }
    return { reconciled, rolledBack };
  }

  /** Overlay any pending patch onto one authoritative row. */
  decorate<T extends TerminalSessionSummary>(row: T): T {
    const entry = this.pending.get(row.id);
    if (!entry) return row;
    return { ...row, ...entry.patch };
  }

  /** Overlay pending patches onto a list, leaving untouched rows referentially stable. */
  decorateAll<T extends TerminalSessionSummary>(rows: readonly T[]): T[] {
    if (this.pending.size === 0) return rows as T[];
    return rows.map((row) => this.decorate(row));
  }
}

/**
 * An authoritative row satisfies a patch when every field the patch wrote
 * already reads that way on the host row — presence for host-stamped instants,
 * exact value for the enums the client decides.
 */
export function patchSatisfiedBy(
  patch: SessionLifecyclePatch,
  row: TerminalSessionSummary,
): boolean {
  for (const key of TIMESTAMP_KEYS) {
    if (!(key in patch)) continue;
    if ((normalizeNullish(patch[key]) != null) !== (normalizeNullish(row[key]) != null)) return false;
  }
  for (const key of ENUM_KEYS) {
    if (!(key in patch)) continue;
    if (normalizeNullish(patch[key]) !== normalizeNullish(row[key])) return false;
  }
  return true;
}

function normalizeNullish<T>(value: T | null | undefined): T | null {
  return value ?? null;
}
