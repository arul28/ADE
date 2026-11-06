/**
 * `-c core.longpaths=true` on Windows, nothing elsewhere.
 *
 * Git for Windows stops at 260 characters unless this is set, and a lane's
 * `node_modules` goes past that easily (`.ade\worktrees\<lane>\node_modules\
 * .pnpm\...`). A removal or listing that hits such a path fails partway, or
 * drops git's record of the worktree while its folder stays. Put these before
 * the subcommand: `runGit([...gitLongPathArgs(), "worktree", "prune"])`.
 */
export function gitLongPathArgs(platform: NodeJS.Platform = process.platform): string[] {
  return platform === "win32" ? ["-c", "core.longpaths=true"] : [];
}
