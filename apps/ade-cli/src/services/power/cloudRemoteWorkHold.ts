/**
 * Remote work on an ADE Cloud computer (`runServe` wraps each write another
 * machine sends), for the two things that would cut it:
 *
 * - **Sleep.** The use noted when work arrives keeps the computer awake for
 *   minutes, which covers a fast write such as a key typed in a terminal. A
 *   push with a slow hook or a big copy outlasts that, so work still running
 *   after `holdAfterMs` holds the computer awake until it answers. A fast
 *   write writes no hold file.
 * - **A disk grow's restart.** `otherRunning()` is true from the first moment
 *   of each remote request, not only once its hold file is written. It skips
 *   the request it is called inside (an Android start that asks for a grow)
 *   while that request runs, so a grow never refuses itself.
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
  // A request's own scope reaches work it starts in the background too, so it
  // says whether that request still runs.
  const scope = new AsyncLocalStorage<{ running: boolean }>();
  let running = 0;
  return {
    async run<T>(work: () => Promise<T>): Promise<T> {
      const own = { running: true };
      running += 1;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const answer = scope.run(own, work);
        const hold = deps.hold();
        if (!hold) return await answer;
        const slow = new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), holdAfterMs);
          timer.unref?.();
        });
        const stillRunning = await Promise.race([answer.then(() => false, () => false), slow]);
        return stillRunning ? await hold(REMOTE_WORK_HOLD_REASON, REMOTE_WORK_HOLD_TTL_MS, () => answer) : await answer;
      } finally {
        clearTimeout(timer);
        own.running = false;
        running -= 1;
      }
    },
    /** Remote work other than the request this call runs inside is running now. */
    otherRunning(): boolean {
      return running > (scope.getStore()?.running ? 1 : 0);
    },
  };
}
