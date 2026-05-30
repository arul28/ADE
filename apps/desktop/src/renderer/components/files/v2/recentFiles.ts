/** Per-session recently-opened file paths (most-recent first), for the warm
 *  empty state. In-memory only — bounded and reset implicitly per run. */
const recentsBySession = new Map<string, string[]>();
const MAX_RECENTS = 8;

export function recordRecentFile(sessionKey: string, path: string): void {
  const current = recentsBySession.get(sessionKey) ?? [];
  const next = [path, ...current.filter((p) => p !== path)].slice(0, MAX_RECENTS);
  recentsBySession.set(sessionKey, next);
}

export function getRecentFiles(sessionKey: string): string[] {
  return recentsBySession.get(sessionKey) ?? [];
}

export function forgetRecentFile(sessionKey: string, path: string): void {
  const current = recentsBySession.get(sessionKey);
  if (!current) return;
  recentsBySession.set(sessionKey, current.filter((p) => p !== path));
}
