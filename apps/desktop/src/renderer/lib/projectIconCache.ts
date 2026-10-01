import type { ProjectIcon } from "../../shared/types";

// Bounded LRU so we don't accumulate icons for every project ever opened in
// long-lived sessions. 24 entries keeps the working set hot for typical usage
// (current project + a few recents in the tab list) without unbounded growth.
const PROJECT_ICON_CACHE_MAX = 24;
const projectIconCache = new Map<string, ProjectIcon>();

export function getProjectIconFromCache(rootPath: string): ProjectIcon | undefined {
  const cached = projectIconCache.get(rootPath);
  if (cached === undefined) return undefined;
  // Touch on read to mark as most-recently-used.
  projectIconCache.delete(rootPath);
  projectIconCache.set(rootPath, cached);
  return cached;
}

export function setProjectIconCache(rootPath: string, icon: ProjectIcon): void {
  if (projectIconCache.has(rootPath)) {
    projectIconCache.delete(rootPath);
  } else if (projectIconCache.size >= PROJECT_ICON_CACHE_MAX) {
    // Map iteration order is insertion order, so the first key is the LRU.
    const oldestKey = projectIconCache.keys().next().value;
    if (oldestKey !== undefined) {
      projectIconCache.delete(oldestKey);
    }
  }
  projectIconCache.set(rootPath, icon);
}

/**
 * Project icons read from this cache. When the icon dialog changes a
 * project's icon, it updates the cache and tells every subscriber for that
 * root to read it again.
 */
const projectIconListeners = new Set<(rootPath: string) => void>();

export function publishProjectIcon(rootPath: string, icon: ProjectIcon): void {
  setProjectIconCache(rootPath, icon);
  for (const listener of projectIconListeners) listener(rootPath);
}

/** Calls `onChange` whenever the icon of `rootPath` changes. Returns the unsubscribe. */
export function subscribeProjectIcon(rootPath: string, onChange: () => void): () => void {
  const listener = (changedRoot: string) => {
    if (changedRoot === rootPath) onChange();
  };
  projectIconListeners.add(listener);
  return () => {
    projectIconListeners.delete(listener);
  };
}
