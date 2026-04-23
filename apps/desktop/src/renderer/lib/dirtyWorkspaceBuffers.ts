/**
 * In-memory map of absolute file path → unsaved editor text for workspace file UIs.
 * The main process reads this via `window.__ADE_GET_DIRTY_FILE_TEXT__` during Cursor ACP reads.
 */
const dirtyByAbsPath = new Map<string, string>();

function isWindowsAbsolutePath(value: string): boolean {
  return /^\/?[a-z]:\//i.test(value) || value.startsWith("//");
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || isWindowsAbsolutePath(value);
}

function trimTrailingSlash(value: string): string {
  if (/^[a-z]:\/$/i.test(value) || value === "/" || value === "//") return value;
  return value.replace(/\/+$/g, "");
}

function normalizeDirtyPath(value: string): string {
  const slashNormalized = value.trim().replace(/\\/g, "/");
  const collapsed = slashNormalized.startsWith("//")
    ? `//${slashNormalized.slice(2).replace(/\/+/g, "/")}`
    : slashNormalized.replace(/\/+/g, "/");
  const drivePrefixNormalized = collapsed.replace(/^\/([a-z]:)(?=\/|$)/i, "$1");
  const trimmed = trimTrailingSlash(drivePrefixNormalized);
  return isWindowsAbsolutePath(trimmed) ? trimmed.toLowerCase() : trimmed;
}

function joinDirtyPath(rootPath: string, relativePath: string): string {
  const root = trimTrailingSlash(rootPath.replace(/\\/g, "/"));
  const rel = relativePath.replace(/\\/g, "/").replace(/^\/+/g, "");
  return normalizeDirtyPath(`${root}/${rel}`);
}

function clearWorkspaceEntries(rootPath: string): void {
  const rootNorm = normalizeDirtyPath(rootPath);
  const prefix = rootNorm.endsWith("/") ? rootNorm : `${rootNorm}/`;
  for (const key of [...dirtyByAbsPath.keys()]) {
    const kn = normalizeDirtyPath(key);
    if (kn === rootNorm || kn.startsWith(prefix)) {
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
  const rootNorm = normalizeDirtyPath(rootPath);
  clearWorkspaceEntries(rootNorm);
  for (const tab of tabs) {
    const abs = isAbsolutePath(tab.path)
      ? normalizeDirtyPath(tab.path)
      : joinDirtyPath(rootNorm, tab.path);
    if (tab.content !== tab.savedContent) {
      dirtyByAbsPath.set(abs, tab.content);
    }
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
