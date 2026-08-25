/**
 * Normalize a git remote URL to a canonical "host/owner/repo" key so
 * lane remotes (`git@github.com:owner/repo.git`), project origins, and Cursor
 * Cloud repo URLs (`https://github.com/owner/repo`) all compare equal.
 *
 * Shared between the main process (fleet scoping, pull-into-lane) and the
 * renderer (cloud panel repo matching).
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
  s = s.replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();
  return s;
}
