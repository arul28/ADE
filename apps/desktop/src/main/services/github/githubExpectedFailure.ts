// No electron (or other main-only) imports here: the brain bundles its own
// GitHub transport (`apps/ade-cli/src/headlessLinearServices.ts`) and marks
// its failures through this helper, so the desktop and the brain agree.
import { markExpected, type ExpectedErrorKind } from "../../../shared/expectedError";
import type { GitHubAuthFailure } from "../../../shared/types/git";

/**
 * Which GitHub refusals are an answer rather than a defect in ADE
 * (`shared/expectedError.ts`), or null for one that is not known to be.
 *
 * - A token GitHub refused or that cannot see the repository ("Resource not
 *   accessible by personal access token", "Could not resolve to a Repository
 *   with the name …") is the user's to fix in Settings or on GitHub.
 * - A 404 for a repository the credential is not known to see is the same
 *   answer: GitHub hides a repository a token cannot read behind "Not Found".
 * - A rate limit is the account's quota, and a 5xx is GitHub's own outage.
 *
 * Anything else (an `unknown` failure, a 404 under a repository the
 * credential does see) stays reported: it can be ADE asking for the wrong thing.
 */
export function githubFailureExpectedKind(
  authFailure: Pick<GitHubAuthFailure, "kind">,
  options: { repositoryNotFound?: boolean } = {},
): ExpectedErrorKind | null {
  switch (authFailure.kind) {
    case "permission_denied":
    case "invalid_token":
      return "user";
    case "rate_limited":
      return "environment";
    case "service_unavailable":
      return "network";
    default:
      return options.repositoryNotFound ? "user" : null;
  }
}

/** Mark `error` with {@link githubFailureExpectedKind}, when it has one. Returns the error. */
export function markExpectedGithubFailure<E extends Error>(
  error: E,
  authFailure: Pick<GitHubAuthFailure, "kind">,
  options: { repositoryNotFound?: boolean } = {},
): E {
  const kind = githubFailureExpectedKind(authFailure, options);
  return kind ? markExpected(error, kind) : error;
}
