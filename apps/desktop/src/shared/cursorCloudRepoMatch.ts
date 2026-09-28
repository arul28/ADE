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

/**
 * Devin reports a session's `repos` either as full URLs (sessions ADE
 * launched, which send repo URLs at create) or as a bare `owner/repo` slug
 * (sessions created on app.devin.ai). Normalize the slug form to the same
 * host-qualified key a lane remote produces, so fleet matching does not
 * silently miss rows whose repos arrive unqualified. Slugs are GitHub-scoped;
 * other hosts always arrive qualified.
 */
export function devinCloudRepoMatchKey(repo: string | null | undefined): string {
  const key = repoMatchKey(repo);
  if (!key) return "";
  const first = key.split("/")[0] ?? "";
  return first.includes(".") ? key : `github.com/${key}`;
}

/**
 * Extract the repository path (`owner/repo`, or `group/subgroup/repo` for
 * self-hosted SCMs) from any git remote spelling, without the host. Devin's
 * create `repos` field and list `repo_names` filter take repository
 * identifiers in this `owner/name` shape — clone URLs are for the prompt
 * binding, not the API field. `owner/repo` case is preserved because Devin's
 * integration is case-sensitive about the configured repository name.
 * Returns "" when the remote carries no usable repo path.
 */
export function gitRemoteRepoSlug(url: string | null | undefined): string {
  if (!url) return "";
  let s = url.trim();
  if (!s) return "";
  // SSH form: git@host:owner/repo(.git) — everything after `host:` is the path.
  const sshMatch = s.match(/^[^@]+@([^:]+):(.+)$/);
  if (sshMatch) {
    // `ssh://git@host:443/owner/repo` reaches here too; drop the explicit port.
    const portMatch = sshMatch[2].match(/^\d+\/(.+)$/);
    s = portMatch ? portMatch[1] : sshMatch[2];
  } else {
    s = s.replace(/^[a-z+]+:\/\//i, "");
    s = s.replace(/^[^/@]+@/, "");
    s = s.replace(/^([^/:]+):\d+\//, "$1/");
    // URL form: drop the host (first segment) and keep the repo path.
    const slash = s.indexOf("/");
    s = slash === -1 ? "" : s.slice(slash + 1);
  }
  s = s.replace(/\/+$/, "").replace(/\.git$/i, "");
  const parts = s.split("/").filter(Boolean);
  return parts.length >= 2 ? parts.join("/") : "";
}

/** The PR number in a GitHub pull-request URL (`…/pull/123`), if any. */
export function pullRequestNumber(url: string | null | undefined): number | null {
  const match = url ? /\/pull\/(\d+)/.exec(url) : null;
  return match ? Number(match[1]) : null;
}
