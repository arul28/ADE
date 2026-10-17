/**
 * Env for a git process ADE starts beside the user's own git commands. Without
 * it, a read such as `git status` takes `.git/index.lock` to save its refreshed
 * index, and a commit or checkout the user runs at that moment fails with
 * "Unable to create index.lock". It changes only the locks git calls optional;
 * a command that must write the index still locks it.
 *
 * A leaf module, so a caller that only spawns git itself does not import the
 * git runner.
 */
export const GIT_READ_ENV = { GIT_OPTIONAL_LOCKS: "0" } as const;
