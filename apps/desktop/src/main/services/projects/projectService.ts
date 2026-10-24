import path from "node:path";
import { randomUUID } from "node:crypto";
import { describeGitOwnershipProblem, formatGitExecutionError, GitUntrustedFolderError, runGit } from "../git/git";
import { isGitToolchainMissing } from "../git/gitToolchain";
import { markExpected } from "../../../shared/expectedError";
import type { AdeDb } from "../state/kvDb";
import type { ProjectInfo } from "../../../shared/types";
import {
  findAdeManagedWorktreeRoot,
  normalizeProjectRootPath,
} from "../../../../../ade-cli/src/services/projects/projectRoots";

export async function resolveRepoRoot(selectedPath: string): Promise<string> {
  const managedWorktree = findAdeManagedWorktreeRoot(selectedPath);
  if (managedWorktree) return managedWorktree.projectRoot;
  const res = await runGit(["rev-parse", "--show-toplevel"], { cwd: selectedPath, timeoutMs: 10_000 });
  if (res.exitCode !== 0) {
    const raw = res.stderr.trim() || res.stdout.trim() || "git rev-parse --show-toplevel failed";
    const ownership = describeGitOwnershipProblem(raw);
    if (ownership) throw new GitUntrustedFolderError(ownership);
    const error = new Error(formatGitExecutionError(raw));
    // Exit 128 from this probe is git's "not a repository" (in the user's own
    // language, so the text is never matched): the user picked a plain folder.
    // A Mac without developer tools is its environment. Anything else reports.
    if (res.exitCode === 128) throw markExpected(error, "user");
    if (isGitToolchainMissing(raw)) throw markExpected(error, "environment");
    throw error;
  }
  return normalizeProjectRootPath(res.stdout.trim());
}

export async function detectDefaultBaseRef(repoRoot: string): Promise<string> {
  // Prefer the remote default branch if available.
  const originHead = await runGit(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], { cwd: repoRoot, timeoutMs: 6_000 });
  if (originHead.exitCode === 0) {
    const ref = originHead.stdout.trim(); // e.g. refs/remotes/origin/main
    const m = ref.match(/refs\/remotes\/origin\/(.+)$/);
    if (m?.[1]) return m[1];
  }

  const head = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoRoot, timeoutMs: 6_000 });
  if (head.exitCode === 0) {
    const name = head.stdout.trim();
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
