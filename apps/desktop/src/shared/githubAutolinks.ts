/**
 * GitHub shows a repository's autolinks only to an account with admin rights
 * on it, through a token or app that has Administration read access, and
 * answers everyone else with a bare 404 "Not Found" (or a 403). Both GitHub
 * services turn that into this message, and Sentry treats it as an answer.
 */
export const GITHUB_AUTOLINKS_REFUSED = /^GitHub would not show the autolinks of \S+ \(HTTP 40[34]\)\./;

/** The readable error for a refused autolinks read, or null when `status` is another failure. */
export function githubAutolinksAccessError(owner: string, name: string, status: number | null): Error | null {
  if (status !== 403 && status !== 404) return null;
  return new Error(
    `GitHub would not show the autolinks of ${owner}/${name} (HTTP ${status}). `
      + "Only repository admins can read them, using a token or app with Administration read access; "
      + "also check that the repository name is right.",
  );
}
