import fs from "node:fs";
import path from "node:path";
import type { WorktreeParentRef } from "../../../shared/types";
import {
  findAdeManagedWorktreeRoot,
  findLinkedLaneWorktreeRoot,
  linkedWorktreeParentRoot,
  readGitDirPointer,
  realpathIfExists,
} from "../../../../../ade-cli/src/services/projects/projectRoots";
import { pathsEqual } from "../shared/pathCompare";

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

/**
 * The linked worktrees Git records for the repository at `projectRoot` that
 * belong to this ADE project, read from `<gitdir>/worktrees/<name>/gitdir` (the
 * path of that checkout's `.git` file) without spawning git. Lanes are not only
 * under `.ade/worktrees/`: a sibling `repo-worktrees/feature` checkout is a
 * lane too. Missing folders are left out, and so is a worktree opened as an ADE
 * project of its own — the same rule the CLI uses to pick a checkout's project.
 */
export function listLinkedLaneWorktreeRoots(projectRoot: string): string[] {
  const gitDir = resolveGitMetadataDirectory(projectRoot);
  if (!gitDir) return [];
  const adminRoot = path.join(gitDir, "worktrees");
  let names: string[];
  try {
    names = fs.readdirSync(adminRoot);
  } catch {
    return [];
  }
  const roots: string[] = [];
  for (const name of names) {
    try {
      const pointer = fs.readFileSync(path.join(adminRoot, name, "gitdir"), "utf8").trim();
      if (!pointer) continue;
      const worktreeRoot = path.dirname(path.resolve(adminRoot, name, pointer));
      if (!fs.statSync(worktreeRoot).isDirectory()) continue;
      const owner = findLinkedLaneWorktreeRoot(worktreeRoot);
      if (owner && pathsEqual(owner.projectRoot, realpathIfExists(projectRoot))) roots.push(worktreeRoot);
    } catch {
      // pruned or unreadable entry
    }
  }
  return roots;
}

export function resolveWorktreeParentRef(worktreeRoot: string): WorktreeParentRef | null {
  const managedWorktree = findAdeManagedWorktreeRoot(worktreeRoot);
  if (managedWorktree) {
    return {
      rootPath: managedWorktree.projectRoot,
      displayName: path.basename(managedWorktree.projectRoot),
    };
  }

  const parentRoot = linkedWorktreeParentRoot(worktreeRoot);
  if (!parentRoot) return null;
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
