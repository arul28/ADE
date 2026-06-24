/**
 * In-memory map of absolute file path → unsaved editor text for workspace file UIs.
 * The main process reads this via `window.__ADE_GET_DIRTY_FILE_TEXT__` during provider file reads.
 */
import { isPathEqualOrDescendant, isWindowsAbsolutePath, normalizePath, normalizePathForComparison } from "./pathUtils";

const dirtyByAbsPath = new Map<string, string>();

function isAbsolutePath(value: string): boolean {
  const normalized = normalizePath(value);
  return normalized.startsWith("/") || isWindowsAbsolutePath(normalized);
}

function normalizeDirtyPath(value: string): string {
  return normalizePathForComparison(value);
}

function joinDirtyPath(rootPath: string, relativePath: string): string {
  const root = normalizePath(rootPath);
  const rel = normalizePath(relativePath).replace(/^\/+/g, "");
  return normalizeDirtyPath(root.length ? `${root}/${rel}` : rel);
}

function clearWorkspaceEntries(rootPath: string): void {
  const rootNorm = normalizePath(rootPath);
  if (!rootNorm.length) return;
  for (const key of [...dirtyByAbsPath.keys()]) {
    if (isPathEqualOrDescendant(key, rootNorm)) {
      dirtyByAbsPath.delete(key);
    }
  }
}

/**
 * Replace dirty entries for paths under `rootPath` using the current open tab set for that workspace.
 */
export function replaceDirtyBuffersForWorkspace(
  rootPath: string,
  tabs: ReadonlyArray<{ path: string; content: string; savedContent: string }>,
): void {
  replaceDirtyBufferValuesForWorkspace(
    rootPath,
    tabs.flatMap((tab) => (
      tab.content !== tab.savedContent ? [{ path: tab.path, content: tab.content }] : []
    )),
  );
}

export function replaceDirtyBufferValuesForWorkspace(
  rootPath: string,
  buffers: ReadonlyArray<{ path: string; content: string }>,
): void {
  const rootNorm = normalizeDirtyPath(rootPath);
  clearWorkspaceEntries(rootNorm);
  for (const buffer of buffers) {
    const abs = isAbsolutePath(buffer.path)
      ? normalizeDirtyPath(buffer.path)
      : joinDirtyPath(rootNorm, buffer.path);
    dirtyByAbsPath.set(abs, buffer.content);
  }
}

export function clearDirtyBuffersForWorkspace(rootPath: string): void {
  clearWorkspaceEntries(rootPath);
}

/** Called from main via executeJavaScript — must stay synchronous. */
export function getDirtyFileTextForWindow(absPath: string): string | undefined {
  const n = normalizeDirtyPath(absPath);
  return dirtyByAbsPath.get(n);
}
