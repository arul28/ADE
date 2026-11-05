/**
 * "Did this fail the same way last time?" for a poll or probe that logs its
 * failures.
 *
 * A loop that keeps failing on one cause (no GitHub auth, a repository that
 * answers 404, a paused project database) used to warn on every tick: hundreds
 * of identical Sentry Logs an hour, each saying the first one again. A caller
 * warns when the cause is new and logs the repeat at info, which stays in the
 * local log, then clears the key when the loop succeeds.
 */
export function createRepeatedFailureGate() {
  const lastCause = new Map<string, string>();
  return {
    /** True when `key` last failed with this same `cause`; records it either way. */
    repeated(cause: string, key = ""): boolean {
      const repeated = lastCause.get(key) === cause;
      lastCause.set(key, cause);
      return repeated;
    },
    /** The loop for `key` succeeded: its next failure is news again. */
    clear(key = ""): void {
      lastCause.delete(key);
    },
  };
}
