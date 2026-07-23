import { parseGithubRemoteUrl } from "./githubRemote";

export type SyncMobileProjectRepositoryIdentity = {
  repoOwner: string | null;
  repoName: string | null;
};

/**
 * Return the canonical repository coordinates advertised to mobile clients.
 *
 * The two fields intentionally move together: callers can only verify a
 * repository-scoped link when both coordinates came from a recognized GitHub
 * origin. A missing or non-GitHub origin must not fall back to a folder or
 * display name because two owners can use the same repository name.
 */
export function mobileProjectRepositoryIdentityFromGitOrigin(
  gitOriginUrl: string | null | undefined,
): SyncMobileProjectRepositoryIdentity {
  const repo = parseGithubRemoteUrl(gitOriginUrl);
  return {
    repoOwner: repo?.owner ?? null,
    repoName: repo?.repo ?? null,
  };
}
