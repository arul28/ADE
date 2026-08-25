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
   * original startup failure must reach the caller unchanged. Draining twice is
   * safe; the second call has nothing left to run.
   */
  drain: () => void;
  /** The number of releases still registered. Intended for tests. */
  size: () => number;
}

export function createTeardownStack(
  onReleaseError?: (error: unknown) => void,
): TeardownStack {
  const releases: Array<() => void> = [];
  return {
    push(release: () => void): void {
      releases.push(release);
    },
    drain(): void {
      while (releases.length > 0) {
        const release = releases.pop();
        if (!release) continue;
        try {
          release();
        } catch (error) {
          try {
            onReleaseError?.(error);
          } catch {
            // A reporting failure must not mask the startup failure either.
          }
        }
      }
    },
    size(): number {
      return releases.length;
    },
  };
}
