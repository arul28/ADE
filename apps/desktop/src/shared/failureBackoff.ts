/**
 * Retry spacing for a background call that keeps failing.
 *
 * Each failure in a row doubles the wait, from `baseMs` up to `maxMs`; a
 * success or a change that may have fixed it (the user signed in, a setting
 * changed) calls `reset()`. A poll that retries a failing sign-in at a fixed
 * short interval forever is how a locked keychain turned into thousands of
 * stuck processes; this keeps the retries going, but rarely.
 */
export type FailureBackoff = {
  /** False while the last failure's wait has not run out. */
  canAttempt(): boolean;
  /** Records a failure and returns the wait before the next attempt. */
  recordFailure(): number;
  reset(): void;
};

export function createFailureBackoff(args: { baseMs: number; maxMs: number }): FailureBackoff {
  let failures = 0;
  let retryAt = 0;
  return {
    canAttempt: () => Date.now() >= retryAt,
    recordFailure() {
      failures += 1;
      const delay = Math.min(args.maxMs, args.baseMs * 2 ** Math.min(failures - 1, 30));
      retryAt = Date.now() + delay;
      return delay;
    },
    reset() {
      failures = 0;
      retryAt = 0;
    },
  };
}
