/**
 * A last-in-first-out stack of teardown callbacks for a runtime that is still
 * under construction.
 *
 * `createAdeRuntime` opens the project database and then starts roughly two
 * dozen services. Before this stack existed, a throw part-way through that
 * sequence left the native SQLite handle open and every already-started service
 * running: the sync-host startup loop retries forever, so each failed attempt
 * leaked a whole runtime. The stack gives every acquisition a matching release,
 * registered at the point of acquisition, so the failure path cannot drift out
 * of step with the construction path.
 *
 * The same stack backs `runtime.dispose`, which keeps one ordered list instead
 * of two hand-maintained ones. Both drains release in reverse order, so a
 * service is always stopped before the services it depends on.
 */

import type { RuntimeDisposeReason } from "../../../../desktop/src/shared/types/runtimeLifecycle";

/** Why a runtime is going away; owned by the shared types so the device services can name it. */
export type { RuntimeDisposeReason };

/** A release; it may read the dispose reason, and may return a promise. */
export type TeardownRelease = (reason?: RuntimeDisposeReason) => unknown;

/** How long one async release may hold the drain before it moves on. */
export const TEARDOWN_STEP_TIMEOUT_MS = 3_000;
/** How long a whole async drain may wait on its releases in total. */
export const TEARDOWN_TOTAL_TIMEOUT_MS = 5_000;

export class TeardownStepTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`A runtime teardown step did not finish within ${timeoutMs}ms; teardown moved on without it.`);
    this.name = "TeardownStepTimeoutError";
  }
}

export interface TeardownStack {
  /** Register a release for a resource that has just been acquired. */
  push: (release: TeardownRelease) => void;
  /**
   * Run every registered release in reverse order and empty the stack, without
   * waiting for any of them. This is the failed-boot path, which runs in a
   * synchronous `finally`.
   *
   * A release that throws does not stop the drain and does not propagate: the
   * original startup failure must reach the caller unchanged. A release that
   * returns a promise is not awaited, but its rejection is reported the same
   * way. Draining twice is safe; the second call has nothing left to run.
   */
  drain: () => void;
  /**
   * Run every registered release in reverse order, waiting for each one that
   * returns a promise before the next, and empty the stack. This is the
   * shutdown path: a device stop or a final write must finish before the
   * database below it closes.
   *
   * Each wait is capped (`TEARDOWN_STEP_TIMEOUT_MS`) and so is the whole
   * drain (`TEARDOWN_TOTAL_TIMEOUT_MS`): a stuck disposer must not hold a
   * brain exit. Once the overall cap is spent the remaining releases still
   * run, in order, but are no longer waited on, so the database still closes.
   * A release that throws, rejects or times out is reported and never stops
   * the drain; the returned promise never rejects. A second call while a drain runs joins it; if it
   * names a stronger reason (see {@link strongerDisposeReason}), the releases
   * that have not started yet get that reason instead.
   */
  drainAsync: (reason?: RuntimeDisposeReason) => Promise<void>;
  /** The number of releases still registered. Intended for tests. */
  size: () => number;
}

export function createTeardownStack(
  onReleaseError?: (error: unknown) => void,
): TeardownStack {
  const releases: TeardownRelease[] = [];
  const report = (error: unknown): void => {
    try {
      onReleaseError?.(error);
    } catch {
      // A reporting failure must not mask the startup failure either.
    }
  };
  /** Call one release; a thenable result gets a rejection handler. */
  const start = (release: TeardownRelease, reason: RuntimeDisposeReason | undefined): PromiseLike<unknown> | null => {
    try {
      const result: unknown = release(reason);
      if (!isThenable(result)) return null;
      // A release that is not waited on (or outlives its cap) keeps running
      // after the database closes at the end of the drain. Its rejection
      // (often a read of the closed database) has no other handler, so it
      // would reach the process as an unhandled rejection.
      result.then(undefined, report);
      return result;
    } catch (error) {
      report(error);
      return null;
    }
  };
  let asyncDrain: Promise<void> | null = null;
  /** The reason the running drain hands to the releases it has not started. */
  let drainReason: RuntimeDisposeReason | undefined;
  return {
    push(release: TeardownRelease): void {
      releases.push(release);
    },
    drain(): void {
      while (releases.length > 0) {
        const release = releases.pop();
        if (!release) continue;
        start(release, undefined);
      }
    },
    drainAsync(reason?: RuntimeDisposeReason): Promise<void> {
      if (asyncDrain) {
        // A project removed while a repair's "close" drains: the device
        // releases still to come must stop their devices, not hand them off.
        drainReason = strongerDisposeReason(drainReason, reason);
        return asyncDrain;
      }
      drainReason = reason;
      const deadline = Date.now() + TEARDOWN_TOTAL_TIMEOUT_MS;
      asyncDrain = (async () => {
        while (releases.length > 0) {
          const release = releases.pop();
          if (!release) continue;
          const pending = start(release, drainReason);
          if (!pending) continue;
          const waitMs = Math.min(TEARDOWN_STEP_TIMEOUT_MS, deadline - Date.now());
          // The overall cap is spent: run the rest without waiting.
          if (waitMs <= 0) continue;
          const settled = await settleWithin(pending, waitMs);
          if (!settled) report(new TeardownStepTimeoutError(waitMs));
        }
      })().finally(() => {
        asyncDrain = null;
      });
      return asyncDrain;
    },
    size(): number {
      return releases.length;
    },
  };
}

/**
 * The stronger of two dispose reasons: `"unregister"` (stop the devices) beats
 * `"close"`, which beats `"exit"` and `undefined` (equal: both keep a service's
 * hand-off). On a tie the first one stays.
 */
function strongerDisposeReason(
  current: RuntimeDisposeReason | undefined,
  next: RuntimeDisposeReason | undefined,
): RuntimeDisposeReason | undefined {
  const rank = (reason: RuntimeDisposeReason | undefined): number =>
    reason === "unregister" ? 2 : reason === "close" ? 1 : 0;
  return rank(next) > rank(current) ? next : current;
}

/** True when `pending` settled (either way) within `timeoutMs`. */
async function settleWithin(pending: PromiseLike<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<false>((resolve) => {
    // Deliberately not `unref`ed: a stuck disposer may hold no handle of its
    // own, and an empty event loop would end the process here, before the
    // releases below it (the database flush and close) ever ran.
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve(pending).then(() => true, () => true),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null)?.then === "function";
}
