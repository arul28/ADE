/**
 * One in-flight result, reused until it expires.
 *
 * The PROMISE is cached, not the value: concurrent callers must join the read
 * that is already running rather than start a second one, which is the whole
 * point on a path where a miss costs a refresh POST. A rejected read is evicted
 * so the next caller retries instead of inheriting the failure for the rest of
 * the window.
 *
 * `build` belongs to the cache rather than to each `read()`, because every read
 * of one cache has to run the same builder — a cache that took a different one
 * per call could serve a result nobody asked for.
 *
 * `revision` is opaque and optional. The desktop inventory passes a counter the
 * `gh` CLI bumps, so signing out of `gh` invalidates the window immediately;
 * the headless App lookup passes nothing and relies on the TTL alone.
 */
export function createExpiringPromiseCache<T>(args: {
  ttlMs: number;
  build: () => Promise<T>;
  now?: () => number;
}): {
  read(revision?: unknown): Promise<T>;
  clear(): void;
} {
  const now = args.now ?? (() => Date.now());
  let entry: { expiresAt: number; revision: unknown; promise: Promise<T> } | null = null;
  return {
    async read(revision) {
      const nowMs = now();
      if (entry && entry.expiresAt > nowMs && entry.revision === revision) {
        return await entry.promise;
      }
      const created = { expiresAt: nowMs + args.ttlMs, revision, promise: args.build() };
      entry = created;
      try {
        return await created.promise;
      } catch (error) {
        if (entry === created) entry = null;
        throw error;
      }
    },
    clear() {
      entry = null;
    },
  };
}
