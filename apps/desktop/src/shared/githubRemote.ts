import type { GitHubRepoRef } from "./types/git";

export type GithubRepoSlug = {
  owner: string;
  repo: string;
};

function stripGitSuffix(value: string): string {
  return value.endsWith(".git") ? value.slice(0, -4) : value;
}

function parsePathParts(pathname: string): GithubRepoSlug | null {
  const parts = pathname
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .split("/")
    .filter(Boolean);
  if (parts.length !== 2) return null;
  const owner = parts[0]?.trim() ?? "";
  const repo = stripGitSuffix(parts[1]?.trim() ?? "");
  return owner && repo ? { owner, repo } : null;
}

// `ssh.github.com` is GitHub's SSH endpoint on port 443, for networks that
// block port 22. It serves the same repositories as github.com.
const GITHUB_REMOTE_HOSTS = new Set(["github.com", "ssh.github.com"]);

/** Whether a remote host name is GitHub's own (not an alias of it). */
export function isGithubRemoteHost(host: string): boolean {
  return GITHUB_REMOTE_HOSTS.has(host.toLowerCase());
}

export function parseGithubRemoteUrl(remoteUrl: string | null | undefined): GithubRepoSlug | null {
  const value = typeof remoteUrl === "string" ? remoteUrl.trim() : "";
  if (!value) return null;

  // A URL with a scheme (`ssh://git@github.com:22/…`) is not scp-like: its
  // colon starts a port, not the path.
  const scpLike = value.includes("://")
    ? null
    : value.match(/^(?:[^@]+@)?(?:ssh\.)?github\.com:([^/]+)\/(.+?)\/?$/i);
  if (scpLike) {
    const owner = scpLike[1]?.trim() ?? "";
    const repo = stripGitSuffix(scpLike[2]?.trim() ?? "");
    return owner && repo && !repo.includes("/") ? { owner, repo } : null;
  }

  try {
    const url = new URL(value);
    if (!isGithubRemoteHost(url.hostname)) return null;
    return parsePathParts(url.pathname);
  } catch {
    return null;
  }
}

/** `parseGithubRemoteUrl` in the `{ owner, name }` shape GitHub API code uses. */
export function githubRepoRefFromRemoteUrl(remoteUrl: string | null | undefined): GitHubRepoRef | null {
  return githubRepoRefFromSlug(parseGithubRemoteUrl(remoteUrl));
}

export function githubRepoRefFromSlug(slug: GithubRepoSlug | null): GitHubRepoRef | null {
  return slug ? { owner: slug.owner, name: slug.repo } : null;
}

export function githubRepoSlugsEqual(
  left: GithubRepoSlug | null | undefined,
  right: GithubRepoSlug | null | undefined,
): boolean {
  if (!left || !right) return false;
  return left.owner.toLowerCase() === right.owner.toLowerCase()
    && left.repo.toLowerCase() === right.repo.toLowerCase();
}
