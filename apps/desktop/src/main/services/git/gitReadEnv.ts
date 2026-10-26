// The env and leading options for every git process ADE starts, reads and
// writes alike. The git runner (git.ts) applies them; a caller that spawns git
// itself (the AI git tools) imports them from here. A leaf module, so such a
// caller does not import the git runner.

/**
 * Env for a git process ADE starts beside the user's own git commands. Without
 * it, a read such as `git status` takes `.git/index.lock` to save its refreshed
 * index, and a commit or checkout the user runs at that moment fails with
 * "Unable to create index.lock". It changes only the locks git calls optional;
 * a command that must write the index still locks it.
 */
export const GIT_READ_ENV = { GIT_OPTIONAL_LOCKS: "0" } as const;

/**
 * Git options ADE puts before every command so a personal git config cannot
 * change what ADE reads. `status.showUntrackedFiles=no` hides new files from
 * `git status` and from `git worktree remove`'s own dirty check, so a lane that
 * holds only new files reads clean and its delete erases them. `normal` is
 * git's default; a caller's explicit `--untracked-files` still wins.
 */
export const GIT_CONFIG_OVERRIDE_ARGS = [
  "-c", "status.showUntrackedFiles=normal",
  // Patch readers here expect `a/` and `b/` path prefixes, and `git apply`
  // strips exactly one, so a personal no-prefix setting breaks both.
  "-c", "diff.noprefix=false",
  "-c", "diff.mnemonicPrefix=false",
  "-c", "diff.srcPrefix=a/",
  "-c", "diff.dstPrefix=b/",
] as const;

/**
 * Git must never wait on a terminal prompt: ADE has no terminal to show it, so
 * a missing sign-in (a fetch, a push, or a Git LFS download during checkout)
 * would hang until the timeout. With this set, git fails at once and says
 * why. Git Credential Manager's own sign-in window still opens, because the
 * user can answer it. A caller's env still wins.
 */
export const GIT_NO_PROMPT_ENV = { GIT_TERMINAL_PROMPT: "0" } as const;
