// A leaf module: pure ref helpers for callers that do not import the git runner.

/**
 * The branch name in the output of `git rev-parse --symbolic-full-name HEAD` or
 * `git symbolic-ref HEAD`. Read the full ref, never the short form: when a tag
 * has the branch's name, `--abbrev-ref` and `--short` print `heads/<name>`.
 * Any other value, such as `HEAD` for a detached HEAD, comes back as it is.
 */
export function branchNameFromHeadRef(stdout: string): string {
  const ref = stdout.trim();
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}
