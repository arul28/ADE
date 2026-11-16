export type GithubConditionalRequestCacheEntry = {
  etag: string;
  data: unknown;
  linkHeader: string | null;
};

type StoredEntry = { entry: GithubConditionalRequestCacheEntry; bytes: number };

/**
 * Bodies the cache keeps, counted by the length of their response text. A
 * GitHub page holds at most 100 items, so a PR list is about 1.5 MB of text and
 * this keeps ten of them beside the small entries: the PR tab's lists stay
 * cached, and 200 large pages can no longer pin a few hundred MB.
 */
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Makes equal strings in a parsed body one string. A PR list repeats the same
 * `head.repo`, `base.repo` and owner objects in every item, each with dozens of
 * API URLs, and `JSON.parse` gives every copy its own string: one heap snapshot
 * held 576 copies of one owner's URLs. Each value is swapped for an equal
 * string at the same key, so the data reads the same to every caller.
 */
function shareEqualStrings(value: unknown, pool: Map<string, string>): unknown {
  if (typeof value === "string") {
    const shared = pool.get(value);
    if (shared !== undefined) return shared;
    pool.set(value, value);
    return value;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];
      if ((item !== null && typeof item === "object") || typeof item === "string") {
        value[index] = shareEqualStrings(item, pool);
      }
    }
    return value;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const field = record[key];
      if ((field !== null && typeof field === "object") || typeof field === "string") {
        record[key] = shareEqualStrings(field, pool);
      }
    }
  }
  return value;
}

export function createGithubConditionalRequestCache(maxSize = 200, maxBytes = DEFAULT_MAX_BYTES) {
  const entries = new Map<string, StoredEntry>();
  const activeConditionalRequests = new Map<string, number>();
  let totalBytes = 0;

  const release = (key: string): void => {
    const count = activeConditionalRequests.get(key) ?? 0;
    if (count <= 1) activeConditionalRequests.delete(key);
    else activeConditionalRequests.set(key, count - 1);
  };

  const remove = (key: string): void => {
    const stored = entries.get(key);
    if (!stored) return;
    entries.delete(key);
    totalBytes -= stored.bytes;
  };

  const touch = (key: string): GithubConditionalRequestCacheEntry | null => {
    const stored = entries.get(key);
    if (!stored) return null;
    entries.delete(key);
    entries.set(key, stored);
    return stored.entry;
  };

  /** The least recently used entry with no request waiting on its etag. */
  const evictable = (): string | null => {
    for (const candidate of entries.keys()) {
      if (!activeConditionalRequests.has(candidate)) return candidate;
    }
    return null;
  };

  return {
    begin(key: string): {
      entry: GithubConditionalRequestCacheEntry;
      release: () => void;
    } | null {
      const entry = touch(key);
      if (!entry) return null;
      activeConditionalRequests.set(key, (activeConditionalRequests.get(key) ?? 0) + 1);
      let released = false;
      return {
        entry,
        release: () => {
          if (released) return;
          released = true;
          release(key);
        },
      };
    },
    get(key: string): GithubConditionalRequestCacheEntry | null {
      return touch(key);
    },
    deleteWhere(predicate: (key: string) => boolean): void {
      for (const key of [...entries.keys()]) {
        if (predicate(key)) remove(key);
      }
    },
    /** `bytes` is the length of the response text the entry was parsed from. */
    store(key: string, entry: GithubConditionalRequestCacheEntry, bytes: number): void {
      remove(key);
      // A body larger than the whole budget would evict everything else and
      // still not fit; the request it came from simply runs without an etag.
      if (bytes > maxBytes) return;
      while ((entries.size >= maxSize || totalBytes + bytes > maxBytes) && entries.size > 0) {
        const victim = evictable();
        if (!victim) break;
        remove(victim);
      }
      shareEqualStrings(entry.data, new Map());
      entries.set(key, { entry, bytes });
      totalBytes += bytes;
    },
  };
}
