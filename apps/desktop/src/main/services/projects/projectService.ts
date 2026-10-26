import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { branchNameFromHeadRef, gitCommandError, runGit } from "../git/git";
import { expectedErrorKind, markExpected } from "../../../shared/expectedError";
import type { AdeDb } from "../state/kvDb";
import type { ProjectInfo } from "../../../shared/types";
import {
  findAdeManagedWorktreeRoot,
  normalizeProjectRootPath,
} from "../../../../../ade-cli/src/services/projects/projectRoots";

/**
 * The repository root containing `selectedPath`. `userChosen` is set only when
 * the user picked the folder (the open-project flow): then git's "not a
 * repository" is their choice, not a fault. Every other caller passes a path
 * ADE expects to be a repository, so the same failure still reports.
 */
export async function resolveRepoRoot(selectedPath: string, opts: { userChosen?: boolean } = {}): Promise<string> {
  const managedWorktree = findAdeManagedWorktreeRoot(selectedPath);
  if (managedWorktree) return managedWorktree.projectRoot;
  const res = await runGit(["rev-parse", "--show-toplevel"], { cwd: selectedPath, timeoutMs: 10_000 });
  if (res.exitCode !== 0) {
    const error = gitCommandError(res.stderr.trim() || res.stdout.trim() || "git rev-parse --show-toplevel failed");
    // Exit 128 with no `.git` anywhere above the folder is git's "not a
    // repository" (in the user's own language, so the text is never matched):
    // the user picked a plain folder. A `.git` that git still refuses is a
    // broken repository, which stays reportable.
    if (opts.userChosen && res.exitCode === 128 && !expectedErrorKind(error) && !hasGitEntryAbove(selectedPath)) {
      throw markExpected(error, "user");
    }
    throw error;
  }
  return normalizeProjectRootPath(res.stdout.trim());
}

/** Whether `start` or a folder above it holds a `.git` directory or file. */
function hasGitEntryAbove(start: string): boolean {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".git"))) return true;
    if (path.dirname(dir) === dir) return false;
  }
}

export async function detectDefaultBaseRef(repoRoot: string): Promise<string> {
  // Prefer the remote default branch if available.
  const originHead = await runGit(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], { cwd: repoRoot, timeoutMs: 6_000 });
  if (originHead.exitCode === 0) {
    const ref = originHead.stdout.trim(); // e.g. refs/remotes/origin/main
    const m = ref.match(/refs\/remotes\/origin\/(.+)$/);
    if (m?.[1]) return m[1];
  }

  const head = await runGit(["rev-parse", "--symbolic-full-name", "HEAD"], { cwd: repoRoot, timeoutMs: 6_000 });
  if (head.exitCode === 0) {
    const name = branchNameFromHeadRef(head.stdout);
    if (name && name !== "HEAD") return name;
  }

  return "main";
}

export function upsertProjectRow({
  db,
  repoRoot,
  displayName,
  baseRef
}: {
  db: AdeDb;
  repoRoot: string;
  displayName: string;
  baseRef: string;
}): { projectId: string } {
  const now = new Date().toISOString();
  const normalizedRepoRoot = normalizeProjectRootPath(repoRoot);
  const exactExisting = db.get<{ id: string }>("select id from projects where root_path = ? limit 1", [normalizedRepoRoot]);
  const aliasExisting = exactExisting ?? db
    .all<{ id: string; root_path: string }>("select id, root_path from projects")
    .find((row) => normalizeProjectRootPath(String(row.root_path)) === normalizedRepoRoot);
  const existing = aliasExisting ? { id: aliasExisting.id } : null;
  const id = existing?.id ?? randomUUID();
  if (existing?.id) {
    db.run("update projects set root_path = ?, display_name = ?, default_base_ref = ?, last_opened_at = ? where id = ?", [
      normalizedRepoRoot,
      displayName,
      baseRef,
      now,
      id
    ]);
  } else {
    db.run(
      "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
      [id, normalizedRepoRoot, displayName, baseRef, now, now]
    );
  }
  return { projectId: id };
}

export function toProjectInfo(repoRoot: string, baseRef: string): ProjectInfo {
  const normalizedRepoRoot = normalizeProjectRootPath(repoRoot);
  return { rootPath: normalizedRepoRoot, displayName: path.basename(normalizedRepoRoot), baseRef };
}
