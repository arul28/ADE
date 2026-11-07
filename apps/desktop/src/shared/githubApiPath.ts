import { AdeExpectedError } from "./expectedError";
import type { GitHubRepoRef } from "./types/git";

export type GitHubRepositoryApiPath = GitHubRepoRef & {
  isRepositoryRoot: boolean;
};

export function isGithubRepositorySpecificAccessDenial(
  status: number,
  message: string,
): boolean {
  return status === 404
    || /repository (?:is )?not accessible|cannot access (?:this )?repository|does not have access to (?:this )?repository/i.test(message);
}

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

export type GithubCreateRepositoryRoute = { path: string; organization: string | null };

/**
 * Where to POST a new repository. `/orgs/{owner}/repos` takes only
 * organizations; GitHub answers a personal login there with 404, and
 * `/user/repos` always creates under the signed-in account. So:
 * - no owner, or the owner is the signed-in login: `/user/repos`;
 * - a known login that is not the owner: the org route (a 404 there means the
 *   account can't create under that owner, which the caller reports);
 * - an unknown login (`GET /user` failed, or no write token): ask GitHub what
 *   the owner is. An organization takes the org route. A user can't be
 *   confirmed as the signed-in account, and `/user/repos` would create under
 *   whoever that is, so it fails instead of guessing. `readAccountType` throws
 *   when it can't tell.
 */
export async function resolveGithubCreateRepositoryRoute(
  owner: string,
  deps: {
    readAuthenticatedLogin: () => Promise<string | null>;
    readAccountType: (account: string) => Promise<string | null>;
    onLoginLookupFailed: (error: unknown) => void;
  },
): Promise<GithubCreateRepositoryRoute> {
  const account = owner.trim();
  const userRoute: GithubCreateRepositoryRoute = { path: "/user/repos", organization: null };
  if (!account) return userRoute;
  const orgRoute: GithubCreateRepositoryRoute = {
    path: `/orgs/${encodeURIComponent(account)}/repos`,
    organization: account,
  };
  let login: string | null = null;
  let loginError: unknown = null;
  try {
    login = (await deps.readAuthenticatedLogin())?.trim() || null;
  } catch (error) {
    loginError = error;
    deps.onLoginLookupFailed(error);
  }
  if (login) return account.toLowerCase() === login.toLowerCase() ? userRoute : orgRoute;
  if ((await deps.readAccountType(account)) === "Organization") return orgRoute;
  const reason = loginError instanceof Error ? loginError.message : null;
  throw new AdeExpectedError(
    `ADE couldn't confirm which GitHub account is signed in, so it didn't create ${account}'s repository. Try again.${reason ? ` (${reason})` : ""}`,
    "network",
    { cause: loginError },
  );
}

/** The owner doesn't exist, or the account can't make repositories under it. */
export const GITHUB_OWNER_NOT_FOUND_CODE = "github_owner_not_found";

export function githubOwnerNotFoundMessage(owner: string): string {
  return `GitHub couldn't make a repository under ${owner}. Use your own account or an organization you can create repositories in.`;
}

/**
 * A failed REST call's message, in two forms. `message` is GitHub's top-level
 * text, which auth-failure classification reads. `detailed` adds the
 * `errors[].message` reasons: a 422 says only "Repository creation failed."
 * at the top, and the reason ("name already exists on this account") that
 * callers match on is in `errors`.
 */
export function githubApiErrorMessage(body: unknown, fallback: string): { message: string; detailed: string } {
  const record = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : null;
  // The async merge API puts its reason in `details.message`.
  const details = record?.details && typeof record.details === "object" && !Array.isArray(record.details)
    ? record.details as Record<string, unknown>
    : null;
  const message = (typeof record?.message === "string" ? record.message : "")
    || (typeof details?.message === "string" ? details.message : "")
    || fallback;
  const reasons = Array.isArray(record?.errors)
    ? record.errors
        .map((entry) => entry && typeof entry === "object" && typeof (entry as { message?: unknown }).message === "string"
          ? (entry as { message: string }).message
          : "")
        .filter(Boolean)
    : [];
  return {
    message,
    // "Repository creation failed." + reasons reads "…failed: reason", not "…failed.: reason".
    detailed: reasons.length > 0 ? `${message.replace(/\.\s*$/, "")}: ${reasons.join("; ")}` : message,
  };
}
