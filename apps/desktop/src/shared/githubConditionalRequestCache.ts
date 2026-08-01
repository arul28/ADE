export type GithubConditionalRequestCacheEntry = {
  etag: string;
  data: unknown;
  linkHeader: string | null;
};

export function createGithubConditionalRequestCache(maxSize = 200) {
  const entries = new Map<string, GithubConditionalRequestCacheEntry>();
  const activeConditionalRequests = new Map<string, number>();

  const release = (key: string): void => {
    const count = activeConditionalRequests.get(key) ?? 0;
    if (count <= 1) activeConditionalRequests.delete(key);
    else activeConditionalRequests.set(key, count - 1);
  };

  const touch = (key: string): GithubConditionalRequestCacheEntry | null => {
    const entry = entries.get(key);
    if (!entry) return null;
    entries.delete(key);
    entries.set(key, entry);
    return entry;
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
      for (const key of entries.keys()) {
        if (predicate(key)) entries.delete(key);
      }
    },
    store(key: string, entry: GithubConditionalRequestCacheEntry): void {
      while (entries.size >= maxSize && !entries.has(key)) {
        let evictable: string | null = null;
        for (const candidate of entries.keys()) {
          if (activeConditionalRequests.has(candidate)) continue;
          evictable = candidate;
          break;
        }
        if (!evictable) break;
        entries.delete(evictable);
      }
      entries.delete(key);
      entries.set(key, entry);
    },
  };
}
