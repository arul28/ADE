import fs from "node:fs";
import path from "node:path";
import { runGit } from "./git";
import { isWithinDir } from "../shared/utils";

/** The reason describeUnsavedWorktreeWork gives for an uncommitted or untracked file. */
export const UNCOMMITTED_CHANGES_REASON = "Lane has uncommitted changes.";

/**
 * Why removing the worktree would lose work, as a sentence for the user, or
 * null when nothing would be lost. Work is an uncommitted or untracked file, a
 * changed submodule, or a submodule commit that no remote-tracking branch has.
 * `--ignore-submodules=none` keeps a user's `diff.ignoreSubmodules` from hiding
 * a changed submodule. Git keeps a worktree's submodule repositories inside the
 * worktree's own git dir, so removing the worktree removes their commits too.
 */
export async function describeUnsavedWorktreeWork(worktreePath: string, timeoutMs = 8_000): Promise<string | null> {
  const result = await runGit(["status", "--porcelain=v1", "--ignore-submodules=none"], { cwd: worktreePath, timeoutMs });
  if (result.exitCode !== 0) {
    throw new Error("ADE could not verify whether the lane has uncommitted files.");
  }
  if (result.stdout.trim().length > 0) return UNCOMMITTED_CHANGES_REASON;
  return await describeUnsavedSubmoduleWork(worktreePath, timeoutMs);
}

/** True when removing the worktree would lose work; see describeUnsavedWorktreeWork. */
export async function readWorktreeDirty(worktreePath: string, timeoutMs = 8_000): Promise<boolean> {
  return (await describeUnsavedWorktreeWork(worktreePath, timeoutMs)) !== null;
}

const SUBMODULE_INSPECT_MAX_DEPTH = 4;

function realPathOrNull(target: string): string | null {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return null;
  }
}

/**
 * Why a submodule under `repoPath` holds work that removing the worktree would
 * lose, or null. A submodule ADE cannot inspect counts as holding work, so the
 * delete stops and says which one; a force delete still removes it.
 */
async function describeUnsavedSubmoduleWork(repoPath: string, timeoutMs: number, depth = 0): Promise<string | null> {
  if (!fs.existsSync(path.join(repoPath, ".gitmodules"))) return null;
  const listed = await runGit(
    ["config", "-z", "--file", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"],
    { cwd: repoPath, timeoutMs },
  );
  // Exit 1 means no submodule path is configured.
  if (listed.exitCode === 1) return null;
  if (listed.exitCode !== 0) {
    return `ADE could not read the submodule list in ${repoPath}: ${listed.stderr.trim() || `git exited ${listed.exitCode}`}`;
  }
  const realRepoPath = realPathOrNull(repoPath) ?? repoPath;
  for (const record of listed.stdout.split("\0")) {
    const newline = record.indexOf("\n");
    const relPath = newline >= 0 ? record.slice(newline + 1) : "";
    if (!relPath) continue;
    const submodulePath = path.resolve(repoPath, relPath);
    // `path = .` names the lane itself, and a path outside it is not a
    // submodule of this lane.
    if (submodulePath === repoPath || !isWithinDir(repoPath, submodulePath)) continue;
    // Git skips a path that is not a folder; it is not a submodule checkout.
    let stats: fs.Stats | undefined;
    try {
      stats = fs.statSync(submodulePath, { throwIfNoEntry: false });
    } catch (error) {
      return `ADE could not check submodule ${relPath}: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (!stats?.isDirectory()) continue;
    const realSubmodulePath = realPathOrNull(submodulePath);
    if (!realSubmodulePath || realSubmodulePath === realRepoPath || !isWithinDir(realRepoPath, realSubmodulePath)) {
      return `Submodule ${relPath} points outside the lane, so ADE cannot check it.`;
    }
    if (!fs.existsSync(path.join(submodulePath, ".git"))) {
      // Git skips the folder of an uninitialized submodule in its own checks,
      // and `worktree remove` deletes whatever is in it. An empty one holds
      // nothing; check the next submodule.
      let entries: string[];
      try {
        entries = fs.readdirSync(submodulePath);
      } catch (error) {
        return `ADE could not check submodule folder ${relPath}: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (entries.length > 0) return `Submodule folder ${relPath} holds files that are not in any repository.`;
      continue;
    }
    if (depth + 1 >= SUBMODULE_INSPECT_MAX_DEPTH) {
      return `Submodule ${relPath} is nested too deep for ADE to check.`;
    }
    const remotes = await runGit(["remote"], { cwd: submodulePath, timeoutMs });
    if (remotes.exitCode !== 0) {
      return `ADE could not check submodule ${relPath}: ${remotes.stderr.trim() || `git exited ${remotes.exitCode}`}`;
    }
    if (!remotes.stdout.trim()) {
      return `Submodule ${relPath} has no remote, so its commits may exist only in this lane.`;
    }
    // Only a remote-tracking ref proves a commit is saved. A tag cannot: it may
    // never have been pushed, and it lives in this worktree's own submodule
    // repository, which the removal deletes.
    const unpushed = await runGit(
      ["rev-list", "-n", "1", "HEAD", "--branches", "--not", "--remotes"],
      { cwd: submodulePath, timeoutMs },
    );
    if (unpushed.exitCode !== 0) {
      return `ADE could not check submodule ${relPath}: ${unpushed.stderr.trim() || `git exited ${unpushed.exitCode}`}`;
    }
    if (unpushed.stdout.trim().length > 0) {
      return `Submodule ${relPath} has commits that no remote has.`;
    }
    const nested = await describeUnsavedSubmoduleWork(submodulePath, timeoutMs, depth + 1);
    if (nested) return nested;
  }
  return null;
}
