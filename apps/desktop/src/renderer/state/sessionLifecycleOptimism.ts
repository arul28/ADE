import { useMemo, useSyncExternalStore } from "react";
import type { TerminalSessionSummary } from "../../shared/types";
import { perfMark } from "../perf/markers";
import {
  OPTIMISTIC_TTL_MS,
  SessionLifecycleOverlay,
  type SessionLifecyclePatch,
} from "../lib/sessionLifecycleOverlay";

/**
 * Settle, un-settle, snooze, wake and keep-active show on the Work row the
 * moment they are pressed.
 *
 * Without this the row waited for the whole write: the owning machine's turn
 * check, the write, its change event, and then a full re-read of the session
 * list (another machine's rows re-read on a slower cadence still). So each
 * write paints its patch here first, the Work tab's readers decorate their
 * rows with it (`useLifecycleRowDecorator`, `useLifecycleDecoratedSlices`), and
 * the patch is retired when the owning machine's row agrees, when the write
 * fails or the machine answers that nothing changed (the row goes back, and
 * the caller shows the error), or when it runs out.
 *
 * Only the Work tab's readers subscribe: a surface that never shows lifecycle
 * state (the chat pane, the PR pane) must not re-render for a click on a row.
 *
 * The write itself is unchanged and still goes to the session's own machine
 * by its pin. ADE Web's adapter keeps its own overlay over its reads; the two
 * paint the same columns, so a row painted by both reads the same.
 */

/**
 * An acked patch paints this long while the owning machine's row comes back.
 * Longer than the union's foreign re-read so another machine's row lands
 * before the patch stops painting it, and no longer than an unacked write.
 */
const CONFIRM_GRACE_MS = OPTIMISTIC_TTL_MS;

export type LifecycleRowDecorator = {
  /** Rows with any pending patch painted on; the list keeps its identity when none matched. */
  rows: <T extends TerminalSessionSummary>(rows: readonly T[]) => T[];
  /** One row with its pending patch painted on. */
  row: <T extends TerminalSessionSummary>(row: T) => T;
};

const overlay = new SessionLifecycleOverlay({ confirmGraceMs: CONFIRM_GRACE_MS });
/**
 * The newest write started on each row, kept while it runs. A write whose row
 * names a newer token was superseded by a later action, whether or not that
 * later patch is still painting.
 */
const latestTokenBySession = new Map<string, number>();
const listeners = new Set<() => void>();
let expiryTimer: ReturnType<typeof setTimeout> | null = null;

function makeDecorator(): LifecycleRowDecorator {
  return {
    rows: (rows) => overlay.decorateAll(rows),
    row: (row) => overlay.decorate(row),
  };
}

/** Replaced whenever what is painted changes, so a memo that lists it re-derives. */
let decorator = makeDecorator();

/** What is painted changed: hand readers a new decorator and re-arm the expiry. */
function emit(): void {
  decorator = makeDecorator();
  for (const listener of listeners) listener();
  scheduleExpiry();
}

/** One timer, for the soonest patch to run out; none while nothing is pending. */
function scheduleExpiry(): void {
  if (expiryTimer != null) {
    clearTimeout(expiryTimer);
    expiryTimer = null;
  }
  const nextMs = overlay.nextExpiryMs();
  if (nextMs == null) return;
  expiryTimer = setTimeout(() => {
    expiryTimer = null;
    const { rolledBack } = overlay.reconcile([]);
    if (rolledBack.length) emit();
    else scheduleExpiry();
  }, Math.max(nextMs - Date.now(), 0) + 25);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getDecorator(): LifecycleRowDecorator {
  return decorator;
}

/** The pending patches, as a decorator that changes identity when they do. */
export function useLifecycleRowDecorator(): LifecycleRowDecorator {
  return useSyncExternalStore(subscribe, getDecorator, getDecorator);
}

/**
 * Machine slices with their sessions decorated. A slice with no pending patch,
 * and the list itself when no slice has one, keep their identity.
 */
export function decorateLifecycleSlices<S extends { sessions: readonly TerminalSessionSummary[] }>(
  slices: readonly S[],
  decorate: LifecycleRowDecorator,
): readonly S[] {
  let painted = false;
  const shown = slices.map((slice) => {
    const sessions = decorate.rows(slice.sessions);
    if (sessions === slice.sessions) return slice;
    painted = true;
    return { ...slice, sessions };
  });
  return painted ? shown : slices;
}

/** {@link decorateLifecycleSlices} for a Work reader, re-derived when a patch changes. */
export function useLifecycleDecoratedSlices<S extends { sessions: readonly TerminalSessionSummary[] }>(
  slices: readonly S[],
): readonly S[] {
  const decorate = useLifecycleRowDecorator();
  return useMemo(() => decorateLifecycleSlices(slices, decorate), [decorate, slices]);
}

/**
 * Retire patches the authoritative rows now agree with. Pass the raw rows a
 * machine reported, before decorating, after they are committed.
 */
export function reconcileLifecycleRows(rows: readonly TerminalSessionSummary[]): void {
  if (overlay.size === 0) return;
  const { reconciled, rolledBack } = overlay.reconcile(rows);
  if (reconciled.length || rolledBack.length) emit();
}

/**
 * A write that failed after a later action on the same row replaced its patch
 * (a settle aborted because the user pressed Un-settle while it ran). The row
 * already shows the later action, so the failure is not the user's to see.
 */
export class SupersededLifecycleWriteError extends Error {
  constructor(readonly cause: unknown) {
    super("A later action on this session replaced this one.");
    this.name = "SupersededLifecycleWriteError";
  }
}

export type LifecycleWriteAction =
  | "settle"
  | "unsettle"
  | "snooze"
  | "wake"
  | "settle_override"
  | "clear_woke";

export type LifecycleWriteOptions<T> = {
  /** Which write this is, for the perf markers. */
  action: LifecycleWriteAction;
  /**
   * The ids whose write took. Absent means every id that resolved. A row the
   * owning machine answered as a no-op (already settled, aborted, not snoozed)
   * goes back to how the machine has it.
   */
  applied?: (result: T) => readonly string[];
};

/**
 * Paint `patch` on `sessionIds` now, run `write` (which still goes to the
 * session's own machine by its pin), and keep or drop the patch by its result.
 * Rethrows the write's failure after the row has gone back, so the caller's
 * error toast reports it as before; a failure whose every row was taken over
 * by a later action rethrows as {@link SupersededLifecycleWriteError}.
 */
export async function withOptimisticLifecycle<T>(
  sessionIds: readonly string[],
  patch: SessionLifecyclePatch,
  write: () => Promise<T>,
  options: LifecycleWriteOptions<T>,
): Promise<T> {
  const ids = sessionIds.filter((id) => Boolean(id));
  const tokens = ids.map((sessionId) => {
    const token = overlay.begin(sessionId, patch);
    latestTokenBySession.set(sessionId, token);
    return { sessionId, token };
  });
  const isLatest = ({ sessionId, token }: { sessionId: string; token: number }) =>
    latestTokenBySession.get(sessionId) === token;
  const finish = () => {
    for (const entry of tokens) {
      if (isLatest(entry)) latestTokenBySession.delete(entry.sessionId);
    }
  };
  const startedAt = performance.now();
  if (tokens.length) emit();
  // Click to feedback: the repaint React commits from the emit above.
  perfMark(`work.lifecycle.${options.action}.painted`, { count: ids.length });
  try {
    const result = await write();
    const took = options.applied ? new Set(options.applied(result)) : null;
    let rolledBack = false;
    for (const entry of tokens) {
      if (took && !took.has(entry.sessionId)) {
        overlay.reject(entry.sessionId, entry.token);
        rolledBack = true;
      } else {
        overlay.confirm(entry.sessionId, entry.token);
      }
    }
    finish();
    // A confirm changes nothing that is painted, only how long it lasts.
    if (rolledBack) emit();
    else scheduleExpiry();
    perfMark(`work.lifecycle.${options.action}.written`, {
      count: ids.length,
      durationMs: Math.round(performance.now() - startedAt),
    });
    return result;
  } catch (error) {
    const superseded = tokens.length > 0 && !tokens.some(isLatest);
    // Only this write's layer goes: a later action on the row keeps painting.
    for (const { sessionId, token } of tokens) overlay.reject(sessionId, token);
    finish();
    if (tokens.length) emit();
    perfMark(`work.lifecycle.${options.action}.failed`, {
      count: ids.length,
      durationMs: Math.round(performance.now() - startedAt),
    });
    throw superseded ? new SupersededLifecycleWriteError(error) : error;
  }
}
