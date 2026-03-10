import fs from "node:fs";
import path from "node:path";

export type RecentProject = {
  rootPath: string;
  displayName: string;
  lastOpenedAt: string;
};

export type GlobalState = {
  lastProjectRoot?: string;
  recentProjects?: RecentProject[];
};

export function readGlobalState(filePath: string): GlobalState {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as GlobalState;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function writeGlobalState(filePath: string, state: GlobalState): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf8");
  } catch {
    // Non-fatal; global state is a convenience.
  }
}

type UpsertRecentProjectOptions = {
  recordLastProject?: boolean;
  recordRecent?: boolean;
};

export function upsertRecentProject(
  state: GlobalState,
  proj: { rootPath: string; displayName: string },
  options: UpsertRecentProjectOptions = {}
): GlobalState {
  const next: GlobalState = { ...state };
  const now = new Date().toISOString();
  if (options.recordLastProject ?? true) {
    next.lastProjectRoot = proj.rootPath;
  }
  if (options.recordRecent === false) {
    return next;
  }
  const prev = next.recentProjects ?? [];
  const filtered = prev.filter((p) => p.rootPath !== proj.rootPath);
  next.recentProjects = [{ rootPath: proj.rootPath, displayName: proj.displayName, lastOpenedAt: now }, ...filtered].slice(0, 12);
  return next;
}

export function reorderRecentProjects(
  state: GlobalState,
  orderedPaths: string[]
): GlobalState {
  const prev = state.recentProjects ?? [];
  const byPath = new Map(prev.map((p) => [p.rootPath, p]));
  const reordered: RecentProject[] = [];
  for (const rp of orderedPaths) {
    const entry = byPath.get(rp);
    if (entry) {
      reordered.push(entry);
      byPath.delete(rp);
    }
  }
  // Append any entries not in the new order (shouldn't happen, but be safe).
  for (const entry of byPath.values()) {
    reordered.push(entry);
  }
  return { ...state, recentProjects: reordered };
}
