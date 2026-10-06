import fs from "node:fs";
import path from "node:path";
import { hasTable, openReadOnlyDatabase } from "../../../../desktop/src/main/services/projects/readOnlySqlite";
import { pathsEqual } from "../../../../desktop/src/main/services/shared/pathCompare";
import { resolveMachineAdeDir } from "./machineLayout";

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

export function parseGitDirPointer(content: string, worktreeRoot: string): string | null {
  const match = content.trim().match(/^gitdir:\s*(.+)$/);
  return match?.[1] ? path.resolve(worktreeRoot, match[1]) : null;
}

/** The admin directory a checkout's `.git` file points at; null when `.git` is not a file. */
export function readGitDirPointer(worktreeRoot: string): string | null {
  try {
    const gitPath = path.join(worktreeRoot, ".git");
    if (!fs.statSync(gitPath).isFile()) return null;
    return parseGitDirPointer(fs.readFileSync(gitPath, "utf8"), worktreeRoot);
  } catch {
    return null;
  }
}

/**
 * Where a linked worktree's Git data lives, read from its `.git` pointer
 * without spawning git. Git writes the pointer both ways — `<checkout>/.git`
 * names `<common>/worktrees/<name>`, whose `gitdir` file names the checkout's
 * `.git` back — and both are required, so a `.git` file that merely has the
 * right shape cannot claim a repository. The shared directory comes from the
 * admin directory's `commondir` file when Git wrote one (it always does now),
 * which also covers a bare repository whose checkouts are all worktrees.
 */
function linkedWorktreeGit(worktreeRoot: string): { adminDir: string; commonGitDir: string } | null {
  const adminDir = readGitDirPointer(worktreeRoot);
  if (!adminDir || path.basename(path.dirname(adminDir)) !== "worktrees") return null;
  try {
    const back = fs.readFileSync(path.join(adminDir, "gitdir"), "utf8").trim();
    if (!back || !pathsEqual(
      realpathIfExists(path.resolve(adminDir, back)),
      realpathIfExists(path.join(worktreeRoot, ".git")),
    )) return null;
  } catch {
    return null;
  }
  let commonGitDir = path.dirname(path.dirname(adminDir));
  try {
    const common = fs.readFileSync(path.join(adminDir, "commondir"), "utf8").trim();
    if (common) commonGitDir = path.resolve(adminDir, common);
  } catch {
    // Older Git without `commondir`: the admin directory sits in `<common>/worktrees/`.
  }
  return { adminDir, commonGitDir };
}

/** The shared Git directory of any checkout: a main checkout's `.git`, or a linked worktree's common dir. */
export function gitCommonDirOf(checkoutRoot: string): string | null {
  try {
    const gitPath = path.join(checkoutRoot, ".git");
    if (fs.statSync(gitPath).isDirectory()) return gitPath;
  } catch {
    return null;
  }
  return linkedWorktreeGit(checkoutRoot)?.commonGitDir ?? null;
}

/**
 * The main checkout a linked worktree belongs to: the folder holding the
 * shared `.git` directory. Null for a bare repository, which has no checkout.
 */
export function linkedWorktreeParentRoot(worktreeRoot: string): string | null {
  const git = linkedWorktreeGit(worktreeRoot);
  if (!git || path.basename(git.commonGitDir) !== ".git") return null;
  return path.dirname(git.commonGitDir);
}

/**
 * The checkout root at or above `startDir` and its Git data. Null for a main
 * checkout (`.git` is a directory) or a folder outside any repository.
 */
function linkedWorktreeOf(startDir: string): { worktreeRoot: string; commonGitDir: string } | null {
  let cursor = startDir;
  while (true) {
    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(path.join(cursor, ".git"));
    } catch {
      stat = null;
    }
    if (stat?.isDirectory()) return null;
    if (stat?.isFile()) {
      const git = linkedWorktreeGit(cursor);
      return git ? { worktreeRoot: cursor, commonGitDir: git.commonGitDir } : null;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

function hasAdeDatabase(root: string): boolean {
  return fs.existsSync(path.join(root, ".ade", "ade.db"));
}

/** Whether the project database at `projectRoot` has a live lane rooted at `worktreeRoot`. */
function projectHasLaneAt(projectRoot: string, worktreeRoot: string): boolean {
  let db: ReturnType<typeof openReadOnlyDatabase> | null = null;
  try {
    db = openReadOnlyDatabase(path.join(projectRoot, ".ade", "ade.db"));
    if (!hasTable(db, "lanes")) return false;
    const rows = db.prepare(
      "select worktree_path, attached_root_path from lanes where archived_at is null",
    ).all<{ worktree_path?: string | null; attached_root_path?: string | null }>();
    return rows.some((row) => [row.worktree_path, row.attached_root_path].some(
      (candidate) => typeof candidate === "string"
        && candidate.trim()
        // Git and ADE can store `/var/...` while realpath resolves the same
        // macOS checkout as `/private/var/...`; compare both in realpath space.
        && pathsEqual(realpathIfExists(path.resolve(candidate)), worktreeRoot),
    ));
  } catch {
    return false;
  } finally {
    db?.close();
  }
}

/** Project roots this machine has registered with ADE. Unreadable means none. */
function registeredProjectRoots(): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(resolveMachineAdeDir(), "projects.json"), "utf8")) as unknown;
    const projects = (parsed as { projects?: unknown } | null)?.projects;
    if (!Array.isArray(projects)) return [];
    return projects
      .map((entry) => (entry && typeof entry === "object" ? (entry as { rootPath?: unknown }).rootPath : null))
      .filter((root): root is string => typeof root === "string" && root.trim().length > 0);
  } catch {
    return [];
  }
}

/**
 * The ADE projects a worktree of this repository could belong to: the main
 * checkout, then every registered project that shares the repository's Git
 * data. The second group is what finds the owner when the project is itself
 * a linked worktree, or the repository is bare.
 */
function candidateOwnerProjects(commonGitDir: string, worktreeRoot: string): string[] {
  const candidates: string[] = [];
  const add = (root: string) => {
    const resolved = realpathIfExists(root);
    if (pathsEqual(resolved, worktreeRoot) || candidates.some((known) => pathsEqual(known, resolved))) return;
    candidates.push(resolved);
  };
  if (path.basename(commonGitDir) === ".git") add(path.dirname(commonGitDir));
  const common = realpathIfExists(commonGitDir);
  for (const root of registeredProjectRoots()) {
    const rootCommon = gitCommonDirOf(root);
    if (rootCommon && pathsEqual(realpathIfExists(rootCommon), common)) add(root);
  }
  return candidates;
}

/**
 * A lane ADE created or adopted outside `<project>/.ade/worktrees/` — a sibling
 * `repo-worktrees/feature` folder, say — is still a git linked worktree of the
 * project. Without this, a repository that commits `.ade/ade.yaml` gives every
 * such checkout its own `.ade` folder, and the walk up for `.ade` reads the
 * checkout as a separate project: the CLI then opens (and creates) a second
 * `ade.db` there and the brain registers it as a project of its own.
 *
 * The owner is the project whose database lists this checkout as a lane. With
 * no such project, a checkout with no ADE database of its own belongs to the
 * main checkout when that is an ADE project. A linked worktree someone opened
 * on purpose as a standalone project (its own `ade.db`, nobody's lane) stays
 * its own project.
 */
export function findLinkedLaneWorktreeRoot(startDir: string): ProjectRootResolution | null {
  const linked = linkedWorktreeOf(realpathIfExists(startDir));
  if (!linked) return null;
  const worktreeRoot = realpathIfExists(linked.worktreeRoot);
  const candidates = candidateOwnerProjects(linked.commonGitDir, worktreeRoot).filter(hasAdeDatabase);
  const registeredOwner = candidates.find((root) => projectHasLaneAt(root, worktreeRoot));
  if (registeredOwner) return { projectRoot: registeredOwner, workspaceRoot: worktreeRoot };
  if (hasAdeDatabase(worktreeRoot)) return null;
  const main = linkedWorktreeParentRoot(worktreeRoot);
  const mainProject = main ? candidates.find((root) => pathsEqual(root, realpathIfExists(main))) : undefined;
  return mainProject ? { projectRoot: mainProject, workspaceRoot: worktreeRoot } : null;
}

/**
 * Whether `startDir` is inside a git linked worktree that its parent ADE
 * project lists as a live lane, wherever that worktree lives on disk.
 */
export function isRegisteredLinkedLanePath(startDir: string): boolean {
  return registeredLinkedLaneOwner(startDir) !== null;
}

/** The project that lists the linked worktree at or above `startDir` as a live lane. */
function registeredLinkedLaneOwner(startDir: string): string | null {
  const linked = linkedWorktreeOf(realpathIfExists(startDir));
  if (!linked) return null;
  const worktreeRoot = realpathIfExists(linked.worktreeRoot);
  return candidateOwnerProjects(linked.commonGitDir, worktreeRoot)
    .find((root) => hasAdeDatabase(root) && projectHasLaneAt(root, worktreeRoot)) ?? null;
}

/**
 * The project a folder registers as. A lane folder is its project's, both
 * under `.ade/worktrees/` and anywhere else a project lists it as a lane, so
 * opening a lane does not register it as a second project. A linked worktree
 * no project lists keeps its own path: opening one standalone is allowed.
 */
export function normalizeProjectRootPath(rootPath: string): string {
  const managedWorktree = findAdeManagedWorktreeRoot(rootPath);
  if (managedWorktree) return managedWorktree.projectRoot;
  return registeredLinkedLaneOwner(rootPath) ?? realpathIfExists(rootPath);
}
