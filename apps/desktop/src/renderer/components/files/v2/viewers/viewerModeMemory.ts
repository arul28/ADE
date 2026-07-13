/**
 * Remembers the last view mode a user picked per tab (markdown Preview↔Source,
 * CSV Table↔Source) so a viewer remount — e.g. the reload that follows saving,
 * when the file watcher echoes our own write back — does not flip the surface
 * out from under an editing session. Bounded LRU; entries are tiny strings.
 */
const MAX_ENTRIES = 200;

const modeByTabId = new Map<string, string>();

export function readViewerMode<T extends string>(tabId: string, fallback: T): T {
  const mode = modeByTabId.get(tabId) as T | undefined;
  if (mode == null) return fallback;
  // LRU touch so long sessions keep their active tabs' modes.
  modeByTabId.delete(tabId);
  modeByTabId.set(tabId, mode);
  return mode;
}

export function rememberViewerMode(tabId: string, mode: string): void {
  modeByTabId.delete(tabId);
  modeByTabId.set(tabId, mode);
  while (modeByTabId.size > MAX_ENTRIES) {
    const oldest = modeByTabId.keys().next().value;
    if (oldest == null) break;
    modeByTabId.delete(oldest);
  }
}
