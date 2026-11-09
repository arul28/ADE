import path from "node:path";
import { gitWorktreeRootCached, runGit } from "./git";

/**
 * Whether `worktreePath` is the top of a git worktree of its own. A folder that
 * lost its `.git` answers for the repository above it, so a git command run
 * there acts on the wrong checkout.
 */
export async function isGitWorktreeRoot(worktreePath: string): Promise<boolean> {
  return await gitWorktreeRootCached(worktreePath, async () => {
    try {
      const topLevel = await runGit(
        ["rev-parse", "--path-format=absolute", "--show-toplevel"],
        { cwd: worktreePath, timeoutMs: 8_000 },
      );
      if (!topLevel || typeof topLevel.exitCode !== "number") return true;
      if (topLevel.exitCode !== 0) return false;
      const resolved = topLevel.stdout.trim();
      return !resolved || path.resolve(resolved) === path.resolve(worktreePath);
    } catch {
      return false;
    }
  });
}
