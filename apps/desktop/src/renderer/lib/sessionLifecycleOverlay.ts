import type { TerminalSessionSummary } from "../../shared/types";

/**
 * Optimistic overlay for session-lifecycle writes (settle, snooze, wake, …).
 *
 * A lifecycle write is a round trip to the machine that owns the session: its
 * turn check, the write, its change event, then a re-read of the session list.
 * ADE Web has no local database at all, and on the desktop another machine's
 * rows re-read on a slow cadence. Without an overlay the user taps "Snooze"
 * and the row sits in place for the whole round trip, then jumps.
 *
 * So each mutation records a patch here, the rows are decorated with it at
 * once (ADE Web's adapter decorates its reads; the desktop Work tab goes
 * through `state/sessionLifecycleOptimism.ts`), and the entry is retired in
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
    | "settledAt"
    | "settleOverride"
    | "snoozedUntil"
    | "snoozedAt"
    | "wokeAt"
    | "wokeReason"
    // Painted only, never reconciled: a settle that dismisses a needs-you row
    // clears these on the host, and the row must not read "Needs you" until
    // the host says so. Agreement is judged on `settledAt` alone.
    | "pendingInputItemId"
    | "attentionRequestedAt"
    | "attentionSource"
  >
>;

/**
 * Instant columns the HOST stamps. We optimistically stamp our own clock into
 * them, which will never equal the machine's, so reconciliation compares
 * presence (set vs cleared) — the only part of a timestamp the write actually
 * intended.
 */
const HOST_STAMPED_KEYS = ["settledAt", "snoozedAt", "wokeAt"] as const satisfies
  readonly (keyof SessionLifecyclePatch)[];

/**
 * Instants the CLIENT computes and sends, which the host echoes back verbatim
 * (`session.snoozeSession` normalizes the deadline and writes exactly that), so
 * these compare by value.
 *
 * Presence-matching a client-chosen deadline is wrong for the re-snooze case:
 * snoozing an already-snoozed row leaves the OLD deadline present on the host
 * row, so the very next list read would count that stale row as agreement, drop
 * the patch, and flash the previous deadline back into the UI until the real
 * changeset lands. Comparing the instant keeps the patch pending until the
 * machine actually reports the new deadline.
 */
const CLIENT_INSTANT_KEYS = ["snoozedUntil"] as const satisfies
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

/** One write's patch on a row. */
type PendingLayer = {
  token: number;
  patch: SessionLifecyclePatch;
};

/**
 * Every write still in flight (or awaiting its row) on one session, oldest
 * first, and what they paint together.
 */
type PendingEntry = {
  layers: PendingLayer[];
  /** The layers merged, newest key wins: what the row shows. */
  patch: SessionLifecyclePatch;
  expiresAtMs: number;
};

function mergeLayers(layers: readonly PendingLayer[]): SessionLifecyclePatch {
  return Object.assign({}, ...layers.map((layer) => layer.patch)) as SessionLifecyclePatch;
}

export type SessionLifecycleOverlayOptions = {
  now?: () => number;
  /**
   * How long an acked patch keeps painting while the authoritative row travels
   * back. Defaults to {@link RECONCILE_GRACE_MS}; the desktop passes longer,
   * because another machine's rows re-read on a slower cadence than that.
   */
  confirmGraceMs?: number;
};

export type SessionLifecycleReconcileReport = {
  /** Patches the machine's rows now agree with. */
  reconciled: string[];
  /** Patches dropped without agreement — the row visibly returns to host state. */
  rolledBack: string[];
};

export class SessionLifecycleOverlay {
  /**
   * One entry per session. A second action on a row LAYERS over the first
   * instead of replacing it: a wake and then the woke-marker clear, or a settle
   * and then its Undo, each write only their own columns, so replacing would
   * let the host's stale value of the first action's columns show through
   * (the woken row reads snoozed again). A write that fails drops only its own
   * layer; the row agrees with the machine only when every layer does.
   */
  private readonly pending = new Map<string, PendingEntry>();
  private nextToken = 1;
  private readonly now: () => number;
  private readonly confirmGraceMs: number;

  constructor(options: SessionLifecycleOverlayOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.confirmGraceMs = options.confirmGraceMs ?? RECONCILE_GRACE_MS;
  }

  /** Apply a patch immediately and return the token used to settle it later. */
  begin(sessionId: string, patch: SessionLifecyclePatch): number {
    const token = this.nextToken++;
    if (!sessionId) return token;
    const layers = [...(this.pending.get(sessionId)?.layers ?? []), { token, patch }];
    this.pending.set(sessionId, {
      layers,
      patch: mergeLayers(layers),
      expiresAtMs: this.now() + OPTIMISTIC_TTL_MS,
    });
    return token;
  }

  /**
   * Host accepted: keep painting until the authoritative row lands. Only the
   * newest write's ack moves the deadline; an older one still has a newer write
   * in flight behind it.
   */
  confirm(sessionId: string, token: number): void {
    const entry = this.pending.get(sessionId);
    if (!entry || entry.layers[entry.layers.length - 1]?.token !== token) return;
    entry.expiresAtMs = this.now() + this.confirmGraceMs;
  }

  /**
   * Host rejected (or the transport did): drop that write's layer, so its
   * columns go back while a later write on the row keeps painting.
   */
  reject(sessionId: string, token: number): void {
    const entry = this.pending.get(sessionId);
    if (!entry) return;
    const layers = entry.layers.filter((layer) => layer.token !== token);
    if (layers.length === entry.layers.length) return;
    if (layers.length === 0) {
      this.pending.delete(sessionId);
      return;
    }
    entry.layers = layers;
    entry.patch = mergeLayers(layers);
  }

  has(sessionId: string): boolean {
    return this.pending.has(sessionId);
  }

  get size(): number {
    return this.pending.size;
  }

  /** When the soonest pending patch runs out, or null with nothing pending. */
  nextExpiryMs(): number | null {
    let soonest: number | null = null;
    for (const entry of this.pending.values()) {
      if (soonest == null || entry.expiresAtMs < soonest) soonest = entry.expiresAtMs;
    }
    return soonest;
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

  /**
   * Overlay pending patches onto a list. Untouched rows keep their identity, and
   * so does the list itself when no row in it has a patch, so a reader memoized
   * on it does not re-derive for a patch that belongs to another list.
   */
  decorateAll<T extends TerminalSessionSummary>(rows: readonly T[]): T[] {
    if (this.pending.size === 0) return rows as T[];
    let painted = false;
    const decorated = rows.map((row) => {
      const next = this.decorate(row);
      if (next !== row) painted = true;
      return next;
    });
    return painted ? decorated : rows as T[];
  }
}

/**
 * An authoritative row satisfies a patch when every field the patch wrote
 * already reads that way on the host row — presence for host-stamped instants,
 * exact value for the enums and the deadline the client decides.
 */
export function patchSatisfiedBy(
  patch: SessionLifecyclePatch,
  row: TerminalSessionSummary,
): boolean {
  for (const key of HOST_STAMPED_KEYS) {
    if (!(key in patch)) continue;
    if ((normalizeNullish(patch[key]) != null) !== (normalizeNullish(row[key]) != null)) return false;
  }
  for (const key of CLIENT_INSTANT_KEYS) {
    if (!(key in patch)) continue;
    if (!sameInstant(patch[key], row[key])) return false;
  }
  for (const key of ENUM_KEYS) {
    if (!(key in patch)) continue;
    if (normalizeNullish(patch[key]) !== normalizeNullish(row[key])) return false;
  }
  return true;
}

/**
 * Two ISO strings agree when they name the same instant. String equality is the
 * common case (the host echoes the deadline we sent), but the host re-serializes
 * it, so `+00:00` vs `Z` or a dropped `.000` must not read as disagreement — a
 * false disagreement holds the patch until its grace window instead of retiring
 * it on the first authoritative row.
 */
function sameInstant(left: string | null | undefined, right: string | null | undefined): boolean {
  const a = normalizeNullish(left);
  const b = normalizeNullish(right);
  if (a === null || b === null) return a === b;
  if (a === b) return true;
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);
  return Number.isFinite(aMs) && Number.isFinite(bMs) && aMs === bMs;
}

function normalizeNullish<T>(value: T | null | undefined): T | null {
  return value ?? null;
}

/**
 * The optimistic column writes, mirroring exactly what the host's
 * `sessionService` does for each command. Instants the HOST stamps are filled in
 * with this client's clock and reconciled by PRESENCE, never by value — the
 * machine's instant is the real one. The snooze deadline is the exception: the
 * client computes it and the host echoes it back, so it reconciles by value.
 */

/** Host: `settled_at = coalesce(settled_at, now)`, `settle_override = null`. */
export function settleLifecyclePatch(options: { dismissPendingInput?: boolean } = {}): SessionLifecyclePatch {
  return {
    settledAt: new Date().toISOString(),
    settleOverride: null,
    // The host dismisses what the row was blocked on before it settles it.
    ...(options.dismissPendingInput
      ? { pendingInputItemId: null, attentionRequestedAt: null, attentionSource: null }
      : {}),
  };
}

/**
 * Host: `settled_at = null`, and it clears a `"settled"` override only (one set
 * from the operator tools or `ade`). An `"active"` pin survives, so without a
 * known `"settled"` override the patch leaves the column alone rather than
 * claiming a clear the machine may not make.
 */
export function unsettleLifecyclePatch(
  current?: TerminalSessionSummary["settleOverride"],
): SessionLifecyclePatch {
  return current === "settled" ? { settledAt: null, settleOverride: null } : { settledAt: null };
}

/** Host: writes `settle_override` and nothing else of the settle tuple. */
export function settleOverrideLifecyclePatch(
  override: TerminalSessionSummary["settleOverride"],
): SessionLifecyclePatch {
  return { settleOverride: override ?? null };
}

/** Host: drops the "woke" marker once the row has been looked at. */
export const CLEAR_WOKE_LIFECYCLE_PATCH: SessionLifecyclePatch = { wokeAt: null, wokeReason: null };

/** Host: sets both snooze columns and drops any previous woke marker. */
export function snoozeLifecyclePatch(untilIso: string): SessionLifecyclePatch {
  return {
    snoozedUntil: untilIso,
    snoozedAt: new Date().toISOString(),
    wokeAt: null,
    wokeReason: null,
  };
}

/** Host: clears both snooze columns and records why the row came back. */
export function wakeLifecyclePatch(reason: TerminalSessionSummary["wokeReason"]): SessionLifecyclePatch {
  return {
    snoozedUntil: null,
    snoozedAt: null,
    wokeAt: new Date().toISOString(),
    wokeReason: reason ?? null,
  };
}
