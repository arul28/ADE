/**
 * GitHub shows a repository's autolinks only to an account with admin rights
 * on it, through a token or app that has Administration read access, and
 * answers everyone else with a bare 404 "Not Found" (or a 403). Both GitHub
 * services turn that into one of the messages below, and Sentry treats each
 * as an answer.
 *
 * The service reads repository permissions before requesting links. A refusal
 * from the autolinks endpoint can then explain the level of access GitHub reported:
 *
 * - not an admin: only an admin can add the links (`GITHUB_AUTOLINKS_NOT_ADMIN`);
 * - an admin whose sign-in lacks Administration access (`GITHUB_AUTOLINKS_SIGN_IN_LACKS_ADMIN`);
 * - neither known: the old sentence (`GITHUB_AUTOLINKS_REFUSED`).
 */
export const GITHUB_AUTOLINKS_REFUSED = /^GitHub would not show the autolinks of \S+ \(HTTP 40[34]\)\./;
export const GITHUB_AUTOLINKS_NOT_ADMIN = /^Only admins of \S+ can see or add its GitHub links\./;
export const GITHUB_AUTOLINKS_SIGN_IN_LACKS_ADMIN = /^You're an admin of \S+, but (?:ADE|Daex)'s GitHub sign-in can't read its links\./;

/** Any of the refusals above: the page hides Add and offers the commands to send to an admin. */
export function isGithubAutolinksRefusal(text: string): boolean {
  return GITHUB_AUTOLINKS_REFUSED.test(text)
    || GITHUB_AUTOLINKS_NOT_ADMIN.test(text)
    || GITHUB_AUTOLINKS_SIGN_IN_LACKS_ADMIN.test(text);
}

/** Whether the refusal is because the person is not an admin of the repository. */
export function isGithubAutolinksNotAdmin(text: string): boolean {
  return GITHUB_AUTOLINKS_NOT_ADMIN.test(text);
}

/** The person's permission on one repository, from `GET /repos/{owner}/{name}`; null when unknown. */
export type GithubRepoAdminAccess = { admin: boolean } | null;

/** `permissions.admin` from a `GET /repos/{owner}/{name}` body, or null when it is not there. */
export function githubRepoAdminAccess(repo: unknown): GithubRepoAdminAccess {
  if (!repo || typeof repo !== "object") return null;
  const permissions = (repo as { permissions?: unknown }).permissions;
  if (!permissions || typeof permissions !== "object") return null;
  const admin = (permissions as { admin?: unknown }).admin;
  return typeof admin === "boolean" ? { admin } : null;
}

/**
 * The readable error for a refused autolinks read, or null when `status` is
 * another failure. `access` is the person's own permission, when it could be
 * read.
 */
export function githubAutolinksAccessError(
  owner: string,
  name: string,
  status: number | null,
  access: GithubRepoAdminAccess = null,
): Error | null {
  if (status !== 403 && status !== 404) return null;
  const repo = `${owner}/${name}`;
  if (access?.admin === false) {
    return new Error(
      `Only admins of ${repo} can see or add its GitHub links. Ask an admin to add them, or to make you one.`,
    );
  }
  if (access?.admin === true) {
    // Older clients match this text: a released desktop reads it from this
    // machine's brain (Settings is pinned to the machine) and only then hides
    // Add and shows the admin commands. Keep "ADE's" until those clients age out.
    return new Error(
      `You're an admin of ${repo}, but ADE's GitHub sign-in can't read its links. `
        + "It needs Administration read access: sign in with the GitHub CLI, or give the token that permission.",
    );
  }
  return new Error(
    `GitHub would not show the autolinks of ${repo} (HTTP ${status}). `
      + "Only repository admins can read them, using a token or app with Administration read access; "
      + "also check that the repository name is right.",
  );
}

/**
 * Checks repository permissions before listing its autolinks. Both GitHub services (desktop main's and the brain's)
 * call this with their own request functions; `statusOf` reads the HTTP status
 * from the error their request throws.
 */
export async function listGithubAutolinksOrExplain<T>(args: {
  owner: string;
  name: string;
  list: () => Promise<T>;
  readRepo: () => Promise<unknown>;
  statusOf: (error: unknown) => number | null;
}): Promise<T> {
  const access = await args.readRepo().then(githubRepoAdminAccess, () => null);
  if (access?.admin === false) throw githubAutolinksAccessError(args.owner, args.name, 403, access);
  try {
    return await args.list();
  } catch (error) {
    const status = args.statusOf(error);
    throw githubAutolinksAccessError(args.owner, args.name, status, access) ?? error;
  }
}
