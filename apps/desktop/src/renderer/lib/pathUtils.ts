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

function splitNormalizedPath(value: string): { root: string; segments: string[] } {
  if (!value.length) return { root: "", segments: [] };

  if (value.startsWith("//")) {
    const match = value.match(/^\/\/([^/]+)\/([^/]+)(?:\/(.*))?$/);
    if (!match) return { root: value, segments: [] };
    const [, server, share, rest = ""] = match;
    return {
      root: `//${server}/${share}`,
      segments: rest.split("/").filter(Boolean),
    };
  }

  if (/^[A-Za-z]:\//.test(value)) {
    return {
      root: `${value.slice(0, 2)}/`,
      segments: value.slice(3).split("/").filter(Boolean),
    };
  }

  if (value.startsWith("/")) {
    return {
      root: "/",
      segments: value.slice(1).split("/").filter(Boolean),
    };
  }

  return {
    root: "",
    segments: value.split("/").filter(Boolean),
  };
}

function collapsePathSegments(root: string, segments: string[]): string[] {
  const collapsed: string[] = [];

  for (const segment of segments) {
    if (!segment.length || segment === ".") continue;

    if (segment === "..") {
      if (collapsed.length > 0 && collapsed[collapsed.length - 1] !== "..") {
        collapsed.pop();
        continue;
      }
      if (!root.length) {
        collapsed.push("..");
      }
      continue;
    }

    collapsed.push(segment);
  }

  return collapsed;
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

  const { root, segments } = splitNormalizedPath(normalizedDrivePrefix.replace(/\/+$/g, ""));
  const normalizedSegments = collapsePathSegments(root, segments);

  if (!root.length) return normalizedSegments.join("/");
  if (!normalizedSegments.length) return root;
  return root === "/" ? `/${normalizedSegments.join("/")}` : `${root}${root.endsWith("/") ? "" : "/"}${normalizedSegments.join("/")}`;
}

export function normalizePathForComparison(value: string): string {
  const normalized = normalizePath(value);
  return isWindowsAbsolutePath(normalized) ? normalized.toLowerCase() : normalized;
}

export function normalizePathForWorkspaceComparison(value: string, workspaceRoot?: string | null): string {
  const normalized = normalizePath(value);
  if (!normalized.length) return "";
  const normalizedWorkspaceRoot = normalizePath(workspaceRoot ?? "");
  return isWindowsAbsolutePath(normalizedWorkspaceRoot) || isWindowsAbsolutePath(normalized)
    ? normalized.toLowerCase()
    : normalized;
}

export function arePathsEqual(left: string, right: string, workspaceRoot?: string | null): boolean {
  return normalizePathForWorkspaceComparison(left, workspaceRoot) === normalizePathForWorkspaceComparison(right, workspaceRoot);
}

export function isPathEqualOrDescendant(filePath: string, rootPath: string, workspaceRoot?: string | null): boolean {
  const normalizedPath = normalizePathForWorkspaceComparison(filePath, workspaceRoot ?? rootPath);
  const normalizedRoot = normalizePathForWorkspaceComparison(rootPath, workspaceRoot ?? rootPath);
  if (!normalizedRoot) return normalizedPath.length === 0;
  if (normalizedPath === normalizedRoot) return true;
  return normalizedRoot.endsWith("/")
    ? normalizedPath.startsWith(normalizedRoot)
    : normalizedPath.startsWith(`${normalizedRoot}/`);
}

export function remapPathForRename(filePath: string, oldPath: string, newPath: string, workspaceRoot?: string | null): string {
  const normalizedPath = normalizePath(filePath);
  const normalizedOld = normalizePath(oldPath);
  const normalizedNew = normalizePath(newPath);
  if (!normalizedOld || !normalizedNew) return normalizedPath;

  const normalizedPathComparable = normalizePathForWorkspaceComparison(normalizedPath, workspaceRoot ?? oldPath);
  const normalizedOldComparable = normalizePathForWorkspaceComparison(normalizedOld, workspaceRoot ?? oldPath);
  if (normalizedPathComparable === normalizedOldComparable) return normalizedNew;

  const prefix = normalizedOldComparable.endsWith("/")
    ? normalizedOldComparable
    : `${normalizedOldComparable}/`;
  if (!normalizedPathComparable.startsWith(prefix)) return normalizedPath;
  return `${normalizedNew}${normalizedPath.slice(normalizedOld.length)}`;
}
