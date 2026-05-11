import fs from "node:fs";
import path from "node:path";

export type ProjectRootResolution = {
  projectRoot: string;
  workspaceRoot: string;
};

export function realpathIfExists(value: string): string {
  const resolved = path.resolve(value);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function findAdeManagedWorktreeRoot(startDir: string): ProjectRootResolution | null {
  const resolved = realpathIfExists(startDir);
  const segments = resolved.split(path.sep);
  for (let index = segments.length - 2; index >= 0; index -= 1) {
    if (segments[index] !== ".ade" || segments[index + 1] !== "worktrees") continue;
    const worktreeName = segments[index + 2];
    if (!worktreeName) continue;
    const projectRoot = segments.slice(0, index).join(path.sep) || path.sep;
    const workspaceRoot = segments.slice(0, index + 3).join(path.sep) || path.sep;
    if (!fs.existsSync(path.join(projectRoot, ".ade"))) continue;
    return {
      projectRoot: realpathIfExists(projectRoot),
      workspaceRoot: realpathIfExists(workspaceRoot),
    };
  }
  return null;
}

export function normalizeProjectRootPath(rootPath: string): string {
  const managedWorktree = findAdeManagedWorktreeRoot(rootPath);
  if (managedWorktree) return managedWorktree.projectRoot;
  return realpathIfExists(rootPath);
}
