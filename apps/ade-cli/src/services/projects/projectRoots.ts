import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathsEqual } from "../../../../desktop/src/main/services/shared/pathCompare";

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

/**
 * The checkout root above `startDir` and the main repository it is a linked
 * worktree of, read from the `.git` pointer file without spawning git. Null for
 * a main checkout (`.git` is a directory) or a folder outside any repository.
 */
function linkedWorktreeOf(startDir: string): { worktreeRoot: string; parentRoot: string } | null {
  let cursor = startDir;
  while (true) {
    const gitPath = path.join(cursor, ".git");
    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(gitPath);
    } catch {
      stat = null;
    }
    if (stat?.isDirectory()) return null;
    if (stat?.isFile()) {
      let content: string;
      try {
        content = fs.readFileSync(gitPath, "utf8");
      } catch {
        return null;
      }
      const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(content)?.[1];
      if (!gitdir) return null;
      const adminDir = path.resolve(cursor, gitdir);
      if (path.basename(path.dirname(adminDir)) !== "worktrees") return null;
      const commonGitDir = path.dirname(path.dirname(adminDir));
      if (path.basename(commonGitDir) !== ".git") return null;
      return { worktreeRoot: cursor, parentRoot: path.dirname(commonGitDir) };
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

/** Whether the project database at `parentRoot` has a live lane rooted at `worktreeRoot`. */
function parentHasLaneAt(parentRoot: string, worktreeRoot: string): boolean {
  let db: { prepare: (sql: string) => { all: () => unknown[] }; close: () => void } | null = null;
  try {
    const require = createRequire(path.join(process.cwd(), "ade-runtime.cjs"));
    const { DatabaseSync } = require("node:sqlite") as {
      DatabaseSync: new (file: string, options: { readOnly: boolean }) => NonNullable<typeof db>;
    };
    db = new DatabaseSync(path.join(parentRoot, ".ade", "ade.db"), { readOnly: true });
    const rows = db.prepare(
      "select worktree_path, attached_root_path from lanes where archived_at is null",
    ).all() as Array<{ worktree_path?: string | null; attached_root_path?: string | null }>;
    return rows.some((row) => [row.worktree_path, row.attached_root_path].some(
      (candidate) => typeof candidate === "string" && candidate.trim() && pathsEqual(path.resolve(candidate), worktreeRoot),
    ));
  } catch {
    return false;
  } finally {
    try {
      db?.close();
    } catch {
      // already closed
    }
  }
}

/**
 * A lane ADE created or adopted outside `<project>/.ade/worktrees/` — a sibling
 * `repo-worktrees/feature` folder, say — is still a git linked worktree of the
 * project. Without this, a repository that commits `.ade/ade.yaml` gives every
 * such checkout its own `.ade` folder, and the walk up for `.ade` reads the
 * checkout as a separate project: the CLI then opens (and creates) a second
 * `ade.db` there and the brain registers it as a project of its own.
 *
 * The parent wins when its database lists this checkout as a lane, or when the
 * checkout has no ADE database of its own. A linked worktree someone opened on
 * purpose as a standalone project (its own `ade.db`, not a lane of the parent)
 * stays its own project.
 */
export function findLinkedLaneWorktreeRoot(startDir: string): ProjectRootResolution | null {
  const linked = linkedWorktreeOf(realpathIfExists(startDir));
  if (!linked) return null;
  const parentDb = path.join(linked.parentRoot, ".ade", "ade.db");
  if (!fs.existsSync(parentDb)) return null;
  const ownDb = path.join(linked.worktreeRoot, ".ade", "ade.db");
  if (fs.existsSync(ownDb) && !parentHasLaneAt(linked.parentRoot, linked.worktreeRoot)) return null;
  return {
    projectRoot: realpathIfExists(linked.parentRoot),
    workspaceRoot: realpathIfExists(linked.worktreeRoot),
  };
}

/**
 * Whether `startDir` is inside a git linked worktree that its parent ADE
 * project lists as a live lane, wherever that worktree lives on disk.
 */
export function isRegisteredLinkedLanePath(startDir: string): boolean {
  const linked = linkedWorktreeOf(realpathIfExists(startDir));
  if (!linked) return false;
  if (!fs.existsSync(path.join(linked.parentRoot, ".ade", "ade.db"))) return false;
  return parentHasLaneAt(linked.parentRoot, linked.worktreeRoot);
}

export function normalizeProjectRootPath(rootPath: string): string {
  const managedWorktree = findAdeManagedWorktreeRoot(rootPath);
  if (managedWorktree) return managedWorktree.projectRoot;
  return realpathIfExists(rootPath);
}
