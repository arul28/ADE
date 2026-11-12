import path from "node:path";

export type GitWorktreeInfo = {
  path: string;
  /** Branch the worktree has checked out, "" for a detached HEAD. */
  branch: string;
  isBare: boolean;
  /**
   * Git reported this worktree as removable (`prunable <reason>`) — its
   * directory or gitdir pointer is already gone. Adoption must skip these or
   * every `lanes.list` would resurrect a lane row for a worktree that the next
   * `git worktree prune` deletes.
   */
  isPrunable: boolean;
};

export function parseGitWorktreePorcelain(stdout: string): GitWorktreeInfo[] {
  // Blank-line separated records, and the separator has to tolerate CRLF for the
  // same reason the line split one line below does. Git for Windows emits LF
  // here today, but a `\r\n\r\n` stream would match nothing, collapse the whole
  // listing into a single block, and yield exactly one worktree — silently
  // disabling worktree reconcile rather than failing.
  const blocks = stdout.split(/(?:\r?\n){2,}/).filter(Boolean);
  const worktrees: GitWorktreeInfo[] = [];

  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    let wtPath = "";
    let branch = "";
    let isBare = false;
    let isPrunable = false;
    for (const line of lines) {
      if (line.startsWith("worktree ")) wtPath = line.slice("worktree ".length).trim();
      if (line.startsWith("branch ")) branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
      if (line === "bare") isBare = true;
      // Git emits a bare `prunable` or `prunable <reason>` attribute.
      if (line === "prunable" || line.startsWith("prunable ")) isPrunable = true;
    }
    if (!wtPath) continue;
    worktrees.push({ path: path.resolve(wtPath), branch, isBare, isPrunable });
  }

  return worktrees;
}
