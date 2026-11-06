// No electron (or other main-only) imports here: the brain's publish
// (`apps/ade-cli/src/headlessLinearServices.ts`) shares this with the desktop's
// `githubService.ts`, so both pick the same destination the same way.
import { markExpected } from "../../../shared/expectedError";
import type { GitHubAuthFailure } from "../../../shared/types/git";
import { githubFailureExpectedKind } from "./githubExpectedFailure";

type CodedError = Error & { code?: string };

/**
 * Where a new repository is created, and with which credential.
 *
 * `/orgs/{owner}/repos` takes only an organization; a personal account (the
 * credential's own login) must use `/user/repos`, which creates under whoever
 * the credential is. So with an owner given, the route is only right for the
 * credential whose login was checked, and the request must go out on that
 * credential (`credentialToken`), not whichever one the request fallback
 * lands on.
 *
 * When the login cannot be checked (offline, rate limited, a refused token),
 * this stops with a retry error instead of guessing: `/user/repos` would put
 * an organization's repository under the user's personal account.
 *
 * With no owner the route is the personal one, on any write credential.
 */
export async function resolveGithubCreateRepositoryRoute(args: {
  owner: string | null | undefined;
  name: string;
  /** The write credential the creation will be sent with, or null when none. */
  token: string | null;
  readLogin: (token: string) => Promise<string | null>;
}): Promise<{ path: string; credentialToken: string | null }> {
  const owner = (args.owner ?? "").trim();
  if (!owner) return { path: "/user/repos", credentialToken: null };
  if (!args.token) {
    const err: CodedError = markExpected(
      new Error("GitHub is not connected. Run `gh auth login -h github.com -s repo -s workflow` or add a personal access token in Settings."),
      "user",
    );
    err.code = "github_not_connected";
    throw err;
  }
  let login: string | null = null;
  let cause: unknown = null;
  try {
    login = (await args.readLogin(args.token))?.trim() || null;
  } catch (error) {
    cause = error;
  }
  if (!login) throw ownerUnverifiedError(owner, args.name, cause);
  return {
    path: owner.toLowerCase() === login.toLowerCase()
      ? "/user/repos"
      : `/orgs/${encodeURIComponent(owner)}/repos`,
    credentialToken: args.token,
  };
}

function ownerUnverifiedError(owner: string, name: string, cause: unknown): CodedError {
  const detail = cause instanceof Error && cause.message.trim() ? ` (${cause.message.trim()})` : "";
  const err: CodedError = new Error(
    `ADE couldn't confirm which GitHub account is signed in, so it did not create ${owner}/${name}. Check your connection and try again${detail}.`,
  );
  err.code = "github_owner_unverified";
  const authFailure = (cause as { authFailure?: Pick<GitHubAuthFailure, "kind"> } | null)?.authFailure;
  return markExpected(err, (authFailure && githubFailureExpectedKind(authFailure)) || "network");
}

/**
 * Refuse a created (or reused) repository whose owner is not the one asked
 * for, before anything is pushed to it. With no owner asked for, any owner is
 * the credential's own account and is accepted.
 */
export function assertGithubRepositoryOwner(
  requestedOwner: string | null | undefined,
  repository: { owner: string; fullName: string },
): void {
  const requested = (requestedOwner ?? "").trim();
  if (!requested) return;
  if (repository.owner.trim().toLowerCase() === requested.toLowerCase()) return;
  const err: CodedError = new Error(
    `GitHub put the repository at ${repository.fullName || repository.owner}, not under ${requested}, so ADE did not push to it. Delete it on GitHub if you don't want it, then try again.`,
  );
  err.code = "repo_owner_mismatch";
  throw err;
}
