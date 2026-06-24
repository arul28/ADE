/** Per-session recently-opened file paths (most-recent first), for the warm
 *  empty state. Bounded and persisted so the empty state is still useful after restart. */
const recentsBySession = new Map<string, string[]>();
const MAX_RECENTS = 8;
const STORAGE_PREFIX = "ade.files.recentFiles.";

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

function storageKey(sessionKey: string): string {
  return `${STORAGE_PREFIX}${sessionKey}`;
}

function readStoredRecents(sessionKey: string): string[] {
  const store = storage();
  if (!store) return [];
  try {
    const parsed = JSON.parse(store.getItem(storageKey(sessionKey)) ?? "[]") as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string" && entry.length > 0).slice(0, MAX_RECENTS)
      : [];
  } catch {
    return [];
  }
}

function writeSessionRecents(sessionKey: string, recents: string[]): void {
  const bounded = recents.slice(0, MAX_RECENTS);
  recentsBySession.set(sessionKey, bounded);
  const store = storage();
  if (!store) return;
  try {
    store.setItem(storageKey(sessionKey), JSON.stringify(bounded));
  } catch {
    // Best-effort warmth; localStorage quota/private-mode failures should not break Files.
  }
}

function readSessionRecents(sessionKey: string): string[] {
  const cached = recentsBySession.get(sessionKey);
  if (cached) return cached;
  const stored = readStoredRecents(sessionKey);
  if (stored.length > 0) recentsBySession.set(sessionKey, stored);
  return stored;
}

function isAtOrUnder(path: string, target: string): boolean {
  return path === target || path.startsWith(`${target}/`) || path.startsWith(`${target}\\`);
}

export function isNestedFilePath(path: string): boolean {
  return /[\\/]/.test(path);
}

export function recordRecentFile(sessionKey: string, path: string): void {
  const current = readSessionRecents(sessionKey);
  const next = [path, ...current.filter((p) => p !== path)].slice(0, MAX_RECENTS);
  writeSessionRecents(sessionKey, next);
}

export function getRecentFiles(sessionKey: string): string[] {
  return readSessionRecents(sessionKey);
}

export function forgetRecentFile(sessionKey: string, path: string): void {
  const current = readSessionRecents(sessionKey);
  if (!current.length) return;
  writeSessionRecents(sessionKey, current.filter((p) => p !== path));
}

export function forgetRecentFilesUnder(sessionKey: string, target: string): void {
  const current = readSessionRecents(sessionKey);
  if (!current.length) return;
  writeSessionRecents(
    sessionKey,
    current.filter((p) => !isAtOrUnder(p, target)),
  );
}

export function pruneMissingRootRecentFiles(sessionKey: string, knownRootPaths: ReadonlySet<string>): string[] {
  const current = readSessionRecents(sessionKey);
  const next = current.filter((path) => isNestedFilePath(path) || knownRootPaths.has(path));
  if (next.length !== current.length) writeSessionRecents(sessionKey, next);
  return next;
}
