import type { GitHubRepoRef } from "./types/git";

export type GitHubRepositoryApiPath = GitHubRepoRef & {
  isRepositoryRoot: boolean;
};

export function classifyGitHubRepositoryApiPath(path: string): GitHubRepositoryApiPath | null {
  const pathname = path.split(/[?#]/, 1)[0] ?? "";
  const match = pathname.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
  if (!match) return null;
  try {
    const nestedPath = match[3] ?? "";
    return {
      owner: decodeURIComponent(match[1] ?? ""),
      name: decodeURIComponent(match[2] ?? ""),
      isRepositoryRoot: nestedPath === "" || nestedPath === "/",
    };
  } catch {
    return null;
  }
}

export function createGithubRepositoryRequestFallback<Candidate>(args: {
  path: GitHubRepositoryApiPath | null;
  readAccess: (candidate: Candidate, repo: GitHubRepoRef) => boolean | null;
  recordAccess: (
    candidate: Candidate,
    repo: GitHubRepoRef,
    accessible: boolean,
  ) => void;
}) {
  return {
    shouldSkip(candidate: Candidate): boolean {
      return args.path != null && args.readAccess(candidate, args.path) === false;
    },
    classifyFailure(candidate: Candidate, status: number): {
      repositoryNotFound: boolean;
      ambiguousRepositoryNotFound: boolean;
    } {
      if (status !== 404 || !args.path) {
        return { repositoryNotFound: false, ambiguousRepositoryNotFound: false };
      }
      const knownAccess = args.readAccess(candidate, args.path);
      if (args.path.isRepositoryRoot) {
        args.recordAccess(candidate, args.path, false);
      }
      return {
        repositoryNotFound: true,
        ambiguousRepositoryNotFound: !(
          knownAccess === true && args.path.isRepositoryRoot === false
        ),
      };
    },
    recordSuccess(candidate: Candidate): void {
      if (args.path) args.recordAccess(candidate, args.path, true);
    },
  };
}
