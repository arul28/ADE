import path from "path-browserify";

/**
 * In-memory map of absolute file path → unsaved editor text for workspace file UIs.
 * The main process reads this via `window.__ADE_GET_DIRTY_FILE_TEXT__` during Cursor ACP reads.
 */
const dirtyByAbsPath = new Map<string, string>();

/**
 * Replace dirty entries for paths under `rootPath` using the current open tab set for that workspace.
 */
export function replaceDirtyBuffersForWorkspace(
  rootPath: string,
  tabs: ReadonlyArray<{ path: string; content: string; savedContent: string }>,
): void {
  const rootNorm = path.normalize(rootPath);
  const prefix = rootNorm.endsWith(path.sep) ? rootNorm : `${rootNorm}${path.sep}`;
  for (const key of [...dirtyByAbsPath.keys()]) {
    const kn = path.normalize(key);
    if (kn === rootNorm || kn.startsWith(prefix)) {
      dirtyByAbsPath.delete(key);
    }
  }
  for (const tab of tabs) {
    const abs = path.isAbsolute(tab.path)
      ? path.normalize(tab.path)
      : path.normalize(path.join(rootNorm, tab.path));
    if (tab.content !== tab.savedContent) {
      dirtyByAbsPath.set(abs, tab.content);
    }
  }
}

/** Called from main via executeJavaScript — must stay synchronous. */
export function getDirtyFileTextForWindow(absPath: string): string | undefined {
  const n = path.normalize(absPath.trim());
  return dirtyByAbsPath.get(n);
}
