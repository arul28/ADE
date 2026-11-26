/**
 * Remote work held awake on an ADE Cloud computer (`runServe` wraps each
 * write another machine sends). The use noted when work arrives keeps the
 * computer awake for minutes, which covers a fast write such as a key typed
 * in a terminal. A push with a slow hook or a big copy outlasts that: the idle
 * step would ask the server to sleep the computer in its middle. So work
 * still running after `holdAfterMs` holds the computer awake until it answers.
 *
 * A disk grow restarts the computer and waits for held work first. A grow
 * asked from inside one held request (an Android start, a setup a remote
 * launch runs) reads `otherHeld()`, which skips the request it runs inside
 * and still counts every other held request.
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** The hold's reason, as the busy list shows it (`cloudBusyHolds`). */
export const REMOTE_WORK_HOLD_REASON = "remote_action";
const REMOTE_WORK_HOLD_AFTER_MS = 10_000;
const REMOTE_WORK_HOLD_TTL_MS = 30 * 60_000;

export type CloudWorkHolder = <T>(reason: string, ttlMs: number, run: () => Promise<T>) => Promise<T>;

export function createCloudRemoteWorkHold(deps: {
  /** Holds the computer awake while `run` runs (`holdCloudWork`); null on a computer with no keep-awake. */
  hold: () => CloudWorkHolder | null;
  holdAfterMs?: number;
}) {
  const holdAfterMs = deps.holdAfterMs ?? REMOTE_WORK_HOLD_AFTER_MS;
  const scope = new AsyncLocalStorage<{ held: boolean }>();
  let held = 0;
  return {
    async run<T>(work: () => Promise<T>): Promise<T> {
      const own = { held: false };
      const running = scope.run(own, work);
      const hold = deps.hold();
      if (!hold) return await running;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const slow = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), holdAfterMs);
        timer.unref?.();
      });
      try {
        const stillRunning = await Promise.race([running.then(() => false, () => false), slow]);
        if (!stillRunning) return await running;
        return await hold(REMOTE_WORK_HOLD_REASON, REMOTE_WORK_HOLD_TTL_MS, async () => {
          held += 1;
          own.held = true;
          try {
            return await running;
          } finally {
            own.held = false;
            held -= 1;
          }
        });
      } finally {
        clearTimeout(timer);
      }
    },
    /** A held remote request other than the one this call runs inside is running. */
    otherHeld(): boolean {
      return held > (scope.getStore()?.held ? 1 : 0);
    },
  };
}
