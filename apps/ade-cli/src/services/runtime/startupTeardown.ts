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
 * of two hand-maintained ones. `drain` releases in reverse order, so a service
 * is always stopped before the services it depends on.
 */
export interface TeardownStack {
  /** Register a release for a resource that has just been acquired. */
  push: (release: () => void) => void;
  /**
   * Run every registered release in reverse order and empty the stack.
   *
   * A release that throws does not stop the drain and does not propagate: the
   * original startup failure must reach the caller unchanged. A release that
   * returns a promise is not awaited, but its rejection is reported the same
   * way. Draining twice is safe; the second call has nothing left to run.
   */
  drain: () => void;
  /** The number of releases still registered. Intended for tests. */
  size: () => number;
}

export function createTeardownStack(
  onReleaseError?: (error: unknown) => void,
): TeardownStack {
  const releases: Array<() => void> = [];
  const report = (error: unknown): void => {
    try {
      onReleaseError?.(error);
    } catch {
      // A reporting failure must not mask the startup failure either.
    }
  };
  return {
    push(release: () => void): void {
      releases.push(release);
    },
    drain(): void {
      while (releases.length > 0) {
        const release = releases.pop();
        if (!release) continue;
        try {
          const result: unknown = release();
          // An async `dispose` keeps running after the drain returns, and the
          // database closes at the end of this same drain. Its rejection (often
          // a read of the closed database) has no other handler, so it would
          // reach the process as an unhandled rejection.
          if (isThenable(result)) result.then(undefined, report);
        } catch (error) {
          report(error);
        }
      }
    },
    size(): number {
      return releases.length;
    },
  };
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null)?.then === "function";
}
