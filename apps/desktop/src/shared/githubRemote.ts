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

export function parseGithubRemoteUrl(remoteUrl: string | null | undefined): GithubRepoSlug | null {
  const value = typeof remoteUrl === "string" ? remoteUrl.trim() : "";
  if (!value) return null;

  const scpLike = value.match(/^(?:[^@]+@)?github\.com:([^/]+)\/(.+?)\/?$/i);
  if (scpLike) {
    const owner = scpLike[1]?.trim() ?? "";
    const repo = stripGitSuffix(scpLike[2]?.trim() ?? "");
    return owner && repo && !repo.includes("/") ? { owner, repo } : null;
  }

  try {
    const url = new URL(value);
    if (url.hostname.toLowerCase() !== "github.com") return null;
    return parsePathParts(url.pathname);
  } catch {
    return null;
  }
}

export function githubRepoSlugsEqual(
  left: GithubRepoSlug | null | undefined,
  right: GithubRepoSlug | null | undefined,
): boolean {
  if (!left || !right) return false;
  return left.owner.toLowerCase() === right.owner.toLowerCase()
    && left.repo.toLowerCase() === right.repo.toLowerCase();
}
