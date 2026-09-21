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
    // `ssh://git@host:443/owner/repo` reaches here too; drop an explicit port.
    const portMatch = sshMatch[2].match(/^\d+\/(.+)$/);
    s = `${sshMatch[1]}/${portMatch ? portMatch[1] : sshMatch[2]}`;
  } else {
    s = s.replace(/^[a-z+]+:\/\//i, "");
    // Strip any leading user@ (e.g. https://user@host/...)
    s = s.replace(/^[^/@]+@/, "");
    // Drop an explicit port on the host (e.g. ssh://git@ssh.github.com:443/...)
    s = s.replace(/^([^/:]+):\d+\//, "$1/");
  }
  // GitHub's dedicated SSH host is the same repository as github.com.
  s = s.replace(/^ssh\.github\.com\//i, "github.com/");
  s = s.replace(/\/+$/, "").replace(/\.git$/i, "").toLowerCase();
  return s;
}
