// Shared helpers for Cursor Cloud renderer components.

/**
 * Normalize a git remote URL to a canonical "host/owner/repo" key so we can
 * match a lane's `git@github.com:owner/repo.git` against Cursor Cloud's
 * `https://github.com/owner/repo` form.
 */
export function repoMatchKey(url: string | null | undefined): string {
  if (!url) return "";
  let s = url.trim();
  if (!s) return "";
  // SSH form: git@host:owner/repo(.git)
  const sshMatch = s.match(/^[^@]+@([^:]+):(.+)$/);
  if (sshMatch) {
    s = `${sshMatch[1]}/${sshMatch[2]}`;
  } else {
    s = s.replace(/^[a-z+]+:\/\//i, "");
    // Strip any leading user@ (e.g. https://user@host/...)
    s = s.replace(/^[^/@]+@/, "");
  }
  s = s.replace(/\.git$/i, "").replace(/\/+$/, "").toLowerCase();
  return s;
}
