function normalizeSeparators(value: string): string {
  return value.replace(/\\/g, "/");
}

function isWindowsDriveRoot(value: string): boolean {
  return /^[A-Za-z]:\/$/.test(value);
}

function isWindowsUncRoot(value: string): boolean {
  return /^\/\/[^/]+\/[^/]+$/.test(value);
}

function isRootPath(value: string): boolean {
  return value === "/" || isWindowsDriveRoot(value) || isWindowsUncRoot(value);
}

export function isWindowsDrivePath(value: string): boolean {
  const trimmed = value.trim();
  return /^\/?[A-Za-z]:[\\/]/.test(trimmed) || /^[A-Za-z]:$/.test(trimmed);
}

export function isWindowsUncPath(value: string): boolean {
  const trimmed = value.trim();
  return /^(?:\\\\|\/\/)[^/\\]/.test(trimmed);
}

export function isWindowsAbsolutePath(value: string): boolean {
  return isWindowsDrivePath(value) || isWindowsUncPath(value);
}

export function normalizePath(value: string): string {
  const trimmed = normalizeSeparators(value).trim();
  if (!trimmed.length) return "";

  const collapsed = trimmed.startsWith("//")
    ? `//${trimmed.slice(2).replace(/\/+/g, "/")}`
    : trimmed.replace(/\/+/g, "/");
  const normalizedDrivePrefix = collapsed.replace(/^\/([A-Za-z]:)(?=\/|$)/, "$1");

  if (/^[A-Za-z]:$/.test(normalizedDrivePrefix)) return `${normalizedDrivePrefix}/`;
  if (isRootPath(normalizedDrivePrefix)) return normalizedDrivePrefix;
  return normalizedDrivePrefix.replace(/\/+$/g, "");
}

export function normalizePathForComparison(value: string): string {
  const normalized = normalizePath(value);
  return isWindowsAbsolutePath(normalized) ? normalized.toLowerCase() : normalized;
}

export function isPathEqualOrDescendant(filePath: string, rootPath: string): boolean {
  const normalizedPath = normalizePathForComparison(filePath);
  const normalizedRoot = normalizePathForComparison(rootPath);
  if (!normalizedRoot) return normalizedPath.length === 0;
  if (normalizedPath === normalizedRoot) return true;
  return normalizedRoot.endsWith("/")
    ? normalizedPath.startsWith(normalizedRoot)
    : normalizedPath.startsWith(`${normalizedRoot}/`);
}

export function remapPathForRename(filePath: string, oldPath: string, newPath: string): string {
  const normalizedPath = normalizePath(filePath);
  const normalizedOld = normalizePath(oldPath);
  const normalizedNew = normalizePath(newPath);
  if (!normalizedOld || !normalizedNew) return normalizedPath;

  const normalizedPathComparable = normalizePathForComparison(normalizedPath);
  const normalizedOldComparable = normalizePathForComparison(normalizedOld);
  if (normalizedPathComparable === normalizedOldComparable) return normalizedNew;

  const prefix = normalizedOldComparable.endsWith("/")
    ? normalizedOldComparable
    : `${normalizedOldComparable}/`;
  if (!normalizedPathComparable.startsWith(prefix)) return normalizedPath;
  return `${normalizedNew}${normalizedPath.slice(normalizedOld.length)}`;
}
