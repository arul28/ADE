type CacheEntry = {
  expiresAt: number;
  promise: Promise<unknown>;
};

type CacheWriteOptions<T> = {
  cacheResult?: (value: T) => boolean;
  ttlMs?: number;
};

export function createCoalescingReadCache(defaultTtlMs: number) {
  const entries = new Map<string, CacheEntry>();

  function get<T>(key: string): Promise<T> | null {
    const cached = entries.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.promise as Promise<T>;
    }
    if (cached) entries.delete(key);
    return null;
  }

  function set<T>(
    key: string,
    promise: Promise<T>,
    options: CacheWriteOptions<T> = {},
  ): Promise<T> {
    const entry: CacheEntry = {
      // Keep concurrent callers joined even when the transport itself takes
      // longer than the TTL; start the freshness window after resolution.
      expiresAt: Number.POSITIVE_INFINITY,
      promise,
    };
    entries.set(key, entry);
    void promise.then(
      (value) => {
        if (entries.get(key) !== entry) return;
        if (options.cacheResult && !options.cacheResult(value)) {
          entries.delete(key);
          return;
        }
        entry.expiresAt = Date.now() + Math.max(0, options.ttlMs ?? defaultTtlMs);
      },
      () => {
        if (entries.get(key) === entry) entries.delete(key);
      },
    );
    return promise;
  }

  function clear(): void {
    entries.clear();
  }

  function invalidate(predicate: (key: string) => boolean): void {
    for (const key of entries.keys()) {
      if (predicate(key)) entries.delete(key);
    }
  }

  function coalesce<T>(
    key: string,
    fetcher: () => Promise<T>,
    options: CacheWriteOptions<T> = {},
  ): Promise<T> {
    const cached = get<T>(key);
    if (cached) return cached;
    return set(key, fetcher(), options);
  }

  return { get, set, clear, invalidate, coalesce };
}
