type CacheEntry = {
  expiresAt: number;
  promise: Promise<unknown>;
  evictionTimer: ReturnType<typeof setTimeout> | null;
};

type CacheWriteOptions<T> = {
  cacheResult?: (value: T) => boolean;
  ttlMs?: number;
};

export function createCoalescingReadCache(defaultTtlMs: number) {
  const entries = new Map<string, CacheEntry>();

  function clearEvictionTimer(entry: CacheEntry): void {
    if (entry.evictionTimer == null) return;
    clearTimeout(entry.evictionTimer);
    entry.evictionTimer = null;
  }

  function deleteEntry(key: string, entry: CacheEntry): void {
    if (entries.get(key) !== entry) return;
    entries.delete(key);
    clearEvictionTimer(entry);
  }

  function get<T>(key: string): Promise<T> | null {
    const cached = entries.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.promise as Promise<T>;
    }
    if (cached) deleteEntry(key, cached);
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
      evictionTimer: null,
    };
    const previous = entries.get(key);
    if (previous) clearEvictionTimer(previous);
    entries.set(key, entry);
    void promise.then(
      (value) => {
        if (entries.get(key) !== entry) return;
        if (options.cacheResult && !options.cacheResult(value)) {
          deleteEntry(key, entry);
          return;
        }
        const ttlMs = Math.max(0, options.ttlMs ?? defaultTtlMs);
        entry.expiresAt = Date.now() + ttlMs;
        entry.evictionTimer = setTimeout(() => deleteEntry(key, entry), ttlMs);
        (entry.evictionTimer as unknown as { unref?: () => void }).unref?.();
      },
      () => {
        deleteEntry(key, entry);
      },
    );
    return promise;
  }

  function clear(): void {
    for (const entry of entries.values()) clearEvictionTimer(entry);
    entries.clear();
  }

  function invalidate(predicate: (key: string) => boolean): void {
    for (const [key, entry] of entries) {
      if (predicate(key)) deleteEntry(key, entry);
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
