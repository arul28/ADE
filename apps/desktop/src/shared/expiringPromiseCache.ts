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

/**
 * The keyed form: one in-flight or settled read per key. A read in flight is
 * joined; a settled one is reused for `ttlMs` from when it settled; a
 * rejected one is evicted so the next caller retries. Past `maxEntries`, the
 * oldest settled entries go first; a read still in flight is never dropped,
 * so its callers keep sharing it.
 */
export function createKeyedPromiseCache<T>(args: {
  ttlMs: number;
  maxEntries: number;
  now?: () => number;
}): {
  read(key: string, load: () => Promise<T>): Promise<T>;
  delete(key: string): void;
  /** Drops every entry whose key matches. */
  forget(match: (key: string) => boolean): void;
  clear(): void;
} {
  const now = args.now ?? (() => Date.now());
  type Entry = { settledAt: number | null; promise: Promise<T> };
  const entries = new Map<string, Entry>();
  return {
    read(key, load) {
      const hit = entries.get(key);
      if (hit && (hit.settledAt == null || now() - hit.settledAt < args.ttlMs)) return hit.promise;
      const entry: Entry = { settledAt: null, promise: Promise.resolve() as Promise<T> };
      entry.promise = load().then(
        (value) => {
          entry.settledAt = now();
          return value;
        },
        (error: unknown) => {
          if (entries.get(key) === entry) entries.delete(key);
          throw error;
        },
      );
      entries.delete(key);
      entries.set(key, entry);
      if (entries.size > args.maxEntries) {
        for (const [staleKey, stale] of entries) {
          if (entries.size <= args.maxEntries) break;
          if (stale.settledAt != null) entries.delete(staleKey);
        }
      }
      return entry.promise;
    },
    delete(key) {
      entries.delete(key);
    },
    forget(match) {
      for (const key of Array.from(entries.keys())) {
        if (match(key)) entries.delete(key);
      }
    },
    clear() {
      entries.clear();
    },
  };
}
