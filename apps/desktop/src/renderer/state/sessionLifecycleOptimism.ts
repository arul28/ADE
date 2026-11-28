import { useMemo, useSyncExternalStore } from "react";
import type { TerminalSessionSummary } from "../../shared/types";
import { perfMark } from "../perf/markers";
import {
  OPTIMISTIC_TTL_MS,
  SessionLifecycleOverlay,
  type SessionLifecyclePatch,
} from "../webclient/adapter/sessionLifecycleOverlay";

/**
 * Settle, snooze and wake show on the Work row the moment they are pressed.
 *
 * Without this the row waited for the whole write: the owning machine's turn
 * check, the write, its change event, and then a full re-read of the session
 * list (another machine's rows re-read on a slower cadence still). So each
 * write paints its patch here first, every reader of the Work rows decorates
 * with it (`decorateLifecycleRows`), and the patch is retired when the owning
 * machine's row agrees, when the write fails (the row goes back, and the
 * caller shows the error), or when it runs out.
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

const overlay = new SessionLifecycleOverlay({ confirmGraceMs: CONFIRM_GRACE_MS });
const listeners = new Set<() => void>();
let version = 0;
let expiryTimer: ReturnType<typeof setTimeout> | null = null;

function emit(): void {
  version += 1;
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

function getVersion(): number {
  return version;
}

export type LifecycleRowDecorator = {
  /** Rows with any pending patch painted on; untouched rows keep their identity. */
  rows: <T extends TerminalSessionSummary>(rows: readonly T[]) => T[];
  /** One row with its pending patch painted on. */
  row: <T extends TerminalSessionSummary>(row: T) => T;
};

/**
 * The pending patches, as a decorator whose identity changes whenever a patch
 * starts, lands or rolls back, so a memo that lists it re-derives then.
 */
export function useLifecycleRowDecorator(): LifecycleRowDecorator {
  const current = useSyncExternalStore(subscribe, getVersion, getVersion);
  return useMemo(() => {
    void current;
    return {
      rows: (rows) => overlay.decorateAll(rows),
      row: (row) => overlay.decorate(row),
    };
  }, [current]);
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

export type LifecycleWriteOptions = {
  /** Which write this is, for the perf markers. */
  action: string;
  /**
   * The ids whose write took. Absent means every id. A write the owning machine
   * answered as a no-op for a row (already settled, aborted) leaves that row
   * as the machine has it.
   */
  applied?: (result: unknown) => readonly string[] | null;
};

/**
 * Paint `patch` on `sessionIds` now, run `write` (which still goes to the
 * session's own machine by its pin), and keep or drop the patch by its result.
 * Rethrows the write's failure after the row has gone back, so the caller's
 * error toast reports it as before.
 */
export async function withOptimisticLifecycle<T>(
  sessionIds: readonly string[],
  patch: SessionLifecyclePatch,
  write: () => Promise<T>,
  options: LifecycleWriteOptions,
): Promise<T> {
  const ids = sessionIds.filter((id) => Boolean(id));
  const tokens = ids.map((sessionId) => ({ sessionId, token: overlay.begin(sessionId, patch) }));
  const startedAt = performance.now();
  if (tokens.length) emit();
  // Click to feedback: the repaint React commits from the emit above.
  perfMark(`work.lifecycle.${options.action}.painted`, { count: ids.length });
  try {
    const result = await write();
    const took = options.applied ? new Set(options.applied(result) ?? []) : null;
    for (const { sessionId, token } of tokens) {
      if (took && !took.has(sessionId)) overlay.reject(sessionId, token);
      else overlay.confirm(sessionId, token);
    }
    if (tokens.length) emit();
    perfMark(`work.lifecycle.${options.action}.written`, {
      count: ids.length,
      durationMs: Math.round(performance.now() - startedAt),
    });
    return result;
  } catch (error) {
    for (const { sessionId, token } of tokens) overlay.reject(sessionId, token);
    if (tokens.length) emit();
    perfMark(`work.lifecycle.${options.action}.failed`, {
      count: ids.length,
      durationMs: Math.round(performance.now() - startedAt),
    });
    throw error;
  }
}

