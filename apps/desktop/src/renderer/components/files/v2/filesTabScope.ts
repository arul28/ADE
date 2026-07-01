export type FilesTabScope = "all" | "lane";

const STORAGE_PREFIX = "ade.files.tabScope:";
const scopeByProject = new Map<string, FilesTabScope>();

function storageKey(projectRoot: string): string {
  return `${STORAGE_PREFIX}${projectRoot}`;
}

function readStoredScope(projectRoot: string): FilesTabScope | null {
  try {
    const raw = localStorage.getItem(storageKey(projectRoot));
    if (raw === "all" || raw === "lane") return raw;
  } catch {
    // ignore
  }
  return null;
}

export function getFilesTabScope(projectRoot: string): FilesTabScope {
  const cached = scopeByProject.get(projectRoot);
  if (cached) return cached;
  const stored = readStoredScope(projectRoot);
  const scope = stored ?? "all";
  scopeByProject.set(projectRoot, scope);
  return scope;
}

export function setFilesTabScope(projectRoot: string, scope: FilesTabScope): void {
  scopeByProject.set(projectRoot, scope);
  try {
    localStorage.setItem(storageKey(projectRoot), scope);
  } catch {
    // ignore
  }
}

export function toggleFilesTabScope(projectRoot: string): FilesTabScope {
  const next: FilesTabScope = getFilesTabScope(projectRoot) === "all" ? "lane" : "all";
  setFilesTabScope(projectRoot, next);
  return next;
}
