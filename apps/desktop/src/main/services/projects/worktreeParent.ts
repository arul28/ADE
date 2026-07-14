import fs from "node:fs";
import path from "node:path";
import type { WorktreeParentRef } from "../../../shared/types";
import { findAdeManagedWorktreeRoot, realpathIfExists } from "../../../../../ade-cli/src/services/projects/projectRoots";

export function parseGitDirPointer(content: string, worktreeRoot: string): string | null {
  const match = content.trim().match(/^gitdir:\s*(.+)$/);
  return match?.[1] ? path.resolve(worktreeRoot, match[1]) : null;
}

export function readGitDirPointer(worktreeRoot: string): string | null {
  try {
    const gitPath = path.join(worktreeRoot, ".git");
    if (!fs.statSync(gitPath).isFile()) return null;
    return parseGitDirPointer(fs.readFileSync(gitPath, "utf8"), worktreeRoot);
  } catch {
    return null;
  }
}

export function resolveGitMetadataDirectory(projectRoot: string): string | null {
  try {
    const gitPath = path.join(projectRoot, ".git");
    const stat = fs.statSync(gitPath);
    if (stat.isDirectory()) return gitPath;
    if (!stat.isFile()) return null;
    return readGitDirPointer(projectRoot);
  } catch {
    return null;
  }
}

export function resolveWorktreeParentRef(worktreeRoot: string): WorktreeParentRef | null {
  const managedWorktree = findAdeManagedWorktreeRoot(worktreeRoot);
  if (managedWorktree) {
    return {
      rootPath: managedWorktree.projectRoot,
      displayName: path.basename(managedWorktree.projectRoot),
    };
  }

  const pointerTarget = readGitDirPointer(worktreeRoot);
  if (!pointerTarget) return null;
  if (path.basename(path.dirname(pointerTarget)) !== "worktrees") return null;

  const commonGitDir = path.dirname(path.dirname(pointerTarget));
  if (path.basename(commonGitDir) !== ".git") return null;

  const parentRoot = path.dirname(commonGitDir);
  try {
    if (!fs.statSync(parentRoot).isDirectory()) return null;
  } catch {
    return null;
  }

  // Canonicalize the same way projectPathInspector's toParentInfo does, so a
  // repo under a symlinked directory resolves to the identical rootPath in both
  // paths — the badge label and the inspection-driven merge/open gate compare
  // these strings, and a mismatch produces wrong labels and broken equality.
  const resolvedParentRoot = realpathIfExists(parentRoot);
  return {
    rootPath: resolvedParentRoot,
    displayName: path.basename(resolvedParentRoot),
  };
}
