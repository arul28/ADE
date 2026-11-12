import { accountRepoScopeKey } from "./accountSettingsScope";
import type {
  AccountProjectCopyView,
  AccountProjectView,
} from "../../../account-directory/src/accountProjects/contract";

export {
  ACCOUNT_PROJECT_ID_PATTERN,
  ACCOUNT_PROJECT_MAX_LIVE,
  ACCOUNT_PROJECT_PATHS,
  ACCOUNT_PROJECTS_CURSOR_FIELD,
  accountProjectRemovePath,
} from "../../../account-directory/src/accountProjects/contract";
export type {
  AccountProjectAddRequest,
  AccountProjectAddResponse,
  AccountProjectCopiesRequest,
  AccountProjectCopiesResponse,
  AccountProjectCopyAddMode,
  AccountProjectCopyInput,
  AccountProjectCopyResult,
  AccountProjectCopyStatus,
  AccountProjectCopyView,
  AccountProjectIdentityInput,
  AccountProjectListResponse,
  AccountProjectRemoveResponse,
  AccountProjectView,
} from "../../../account-directory/src/accountProjects/contract";

/**
 * The account's projects, as every client names them (the account directory
 * keeps them, `apps/account-directory/src/accountProjects`).
 *
 * A project is a GitHub repository on the account. It is not a folder: a
 * folder is one copy of it on one machine, and a machine may hold several
 * copies (two clones, a moved checkout). The machine's registry id
 * (`project_` and a hash of the path) stays the copy's id; the account
 * project id (`ap_…`) names the repository on every machine.
 *
 * ADE has no subfolder projects: every open path resolves a folder to its git
 * root (`resolveRepoRoot`), so a project has no sub-path field.
 */

/** An account project id: `ap_` and 32 hex characters, made by the server. */
export type AccountProjectId = string;

/** A GitHub repository as ADE can tell from a folder's origin. */
export type GithubRepoIdentity = {
  /** Lowercase: `github.com`, or a GitHub Enterprise host. */
  host: string;
  /** GitHub's numeric id, once something could ask GitHub. */
  repoId: number | null;
  /** Lowercase, as the origin spells it. GitHub's own spelling comes with the id. */
  owner: string;
  name: string;
  /** `repo:<host>/<owner>/<name>`, the key `accountRepoScopeKey` gives. One of the project's aliases. */
  repoKey: string;
};

/** A project on the account (the server's view without its aliases and copies). */
export type AccountProject = Pick<
  AccountProjectView,
  "id" | "host" | "repoId" | "repoKey" | "owner" | "name" | "defaultBranch" | "addedAt" | "removedAt"
>;

/** One folder of an account project on one machine. */
export type AccountProjectCopy = AccountProjectCopyView;

/**
 * What kind of remote a folder's origin is:
 * - `github`: github.com (also its SSH host `ssh.github.com`).
 * - `github_enterprise`: a GitHub Enterprise Cloud host (`*.ghe.com`) or a
 *   GitHub Enterprise Server host whose first label is `github`
 *   (`github.example.com`). The second form is a guess from the name: ADE
 *   cannot tell a GHE Server from another git server without asking it.
 * - `local_only`: anything else, no origin included. The project stays on
 *   this computer only.
 */
export type ProjectOriginKind = "github" | "github_enterprise" | "local_only";

const GITHUB_DOT_COM_HOSTS = new Set(["github.com", "www.github.com", "ssh.github.com"]);
const REPO_PART = /^[a-z0-9_.-]+$/;

function originHostKind(host: string): Exclude<ProjectOriginKind, "local_only"> | null {
  const bare = host.replace(/:\d+$/, "");
  if (GITHUB_DOT_COM_HOSTS.has(bare)) return "github";
  if (/^[a-z0-9-]+\.ghe\.com$/.test(bare)) return "github_enterprise";
  if (/^github\.[a-z0-9.-]+\.[a-z]{2,}$/.test(bare)) return "github_enterprise";
  return null;
}

/**
 * The GitHub repository a folder's origin names, or null when the origin is
 * missing, is not GitHub, or is not exactly `<owner>/<name>` (GitLab-style
 * subgroups). Pass the canonical origin (the registry's `gitOriginUrl`), so
 * an SSH alias of GitHub already reads `github.com`. github.com's SSH host is
 * folded into `github.com`, so both spellings give one key.
 */
export function githubRepoIdentityFromOrigin(origin: string | null | undefined): GithubRepoIdentity | null {
  const key = accountRepoScopeKey(origin);
  if (!key) return null;
  const parts = key.slice("repo:".length).split("/");
  if (parts.length !== 3) return null;
  const [rawHost, owner, name] = parts as [string, string, string];
  const kind = originHostKind(rawHost);
  if (!kind || !REPO_PART.test(owner) || !REPO_PART.test(name) || name === "." || name === "..") return null;
  const host = kind === "github" ? "github.com" : rawHost;
  return { host, repoId: null, owner, name, repoKey: githubRepoKey(host, owner, name) };
}

/** Which kind of remote a folder's origin is (see `ProjectOriginKind`). */
export function projectOriginKind(origin: string | null | undefined): ProjectOriginKind {
  const identity = githubRepoIdentityFromOrigin(origin);
  if (!identity) return "local_only";
  return identity.host === "github.com" ? "github" : "github_enterprise";
}

/** The alias key of a repository by its parts (GitHub's spelling from the API, or the origin's). */
export function githubRepoKey(host: string, owner: string, name: string): string {
  return accountRepoScopeKey(`https://${host}/${owner}/${name}`) ?? `repo:${host}/${owner}/${name}`.toLowerCase();
}
