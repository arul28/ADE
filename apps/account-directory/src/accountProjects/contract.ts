/**
 * The account's project list (migration 0028). Paths, request and response
 * shapes, and limits only: nothing here imports the Worker, so the desktop,
 * the brain, the web client and the phone can `import type` it or mirror it.
 * The client-side identity helpers are in `apps/desktop/src/shared/accountProject.ts`.
 *
 * A project is a GitHub repository on the account. Its key is the GitHub host
 * plus the repository's numeric id; the address (`repo:<host>/<owner>/<name>`,
 * what `accountRepoScopeKey` returns) is an alias. One project can have many
 * aliases, so a rename or a transfer keeps one project and the old address
 * still finds it. A copy is one folder of the project on one machine (the
 * machine's registry id, a hash of the path, is the copy's `checkoutId`).
 *
 * Every route takes the account token as a bearer. Errors are
 * `{ error: { code, message } }` and `message` is one plain sentence. A
 * project id of another account answers 404 `not_found`, exactly as an id
 * that does not exist.
 *
 *   GET    /account/projects?since=<cursor>   AccountProjectListResponse
 *   POST   /account/projects                  AccountProjectAddResponse   (body: AccountProjectAddRequest)
 *   POST   /account/projects/:id/remove       AccountProjectRemoveResponse
 *   PUT    /account/projects/copies           AccountProjectCopiesResponse (body: AccountProjectCopiesRequest)
 *
 * Browsers may call every route except `PUT /account/projects/copies` from the
 * hosted web client's exact origin (`WEB_CLIENT_ORIGIN`). Native callers send
 * no Origin. Any other Origin is refused before the token is read.
 *
 * A machine learns that the list changed from its heartbeat: the answer of
 * `POST /account/machines/register` carries `accountProjectsCursor`, and the
 * machine reads the list only when that differs from the cursor it holds.
 */

export const ACCOUNT_PROJECT_PATHS = {
  root: "/account/projects",
  copies: "/account/projects/copies",
} as const;

/** `/account/projects/:id/remove`. */
export const accountProjectRemovePath = (id: string): string =>
  `${ACCOUNT_PROJECT_PATHS.root}/${encodeURIComponent(id)}/remove`;

/** An account project id, made by the server: `ap_` and 32 hex characters. */
export const ACCOUNT_PROJECT_ID_PATTERN = /^ap_[0-9a-f]{32}$/;

/** The field of the heartbeat answer that carries the list's cursor. */
export const ACCOUNT_PROJECTS_CURSOR_FIELD = "accountProjectsCursor";

/** Projects that are on the account (not removed) at one time. */
export const ACCOUNT_PROJECT_MAX_LIVE = 500;
/** Project rows kept per account, removed ones included; the oldest removed rows go first. */
export const ACCOUNT_PROJECT_MAX_ROWS = 1_000;
/** Addresses kept for one project; the oldest that is not the current one goes first. */
export const ACCOUNT_PROJECT_MAX_ALIASES_PER_PROJECT = 20;
/** Copies one machine may publish in one request (and holds on the account). */
export const ACCOUNT_PROJECT_MAX_COPIES_PER_MACHINE = 200;
/** Copies on the account, all machines together. */
export const ACCOUNT_PROJECT_MAX_COPIES = 2_000;
/** Largest request body the routes read. */
export const ACCOUNT_PROJECT_MAX_BODY_BYTES = 256 * 1024;
export const ACCOUNT_PROJECT_MAX_ROOT_PATH = 1_024;
export const ACCOUNT_PROJECT_MAX_OWNER = 100;
export const ACCOUNT_PROJECT_MAX_NAME = 100;
export const ACCOUNT_PROJECT_MAX_BRANCH = 255;

/** One folder of a project on one machine. */
export type AccountProjectCopyView = {
  projectId: string;
  machineKey: string;
  /** The machine's registry id of the folder (a hash of its path). */
  checkoutId: string;
  /** The folder as that machine writes it (a Windows path on Windows). */
  rootPath: string;
  /** The machine's main location for the project: new lanes start there. One per machine and project. */
  isMain: boolean;
  /** When the machine last published this copy (it publishes only on change). Epoch ms. */
  lastSeenAt: number;
};

export type AccountProjectView = {
  id: string;
  /** Lowercase GitHub host: `github.com`, or a GitHub Enterprise host. */
  host: string;
  /** GitHub's numeric repository id, or null until a machine could read it. */
  repoId: number | null;
  /** The current address, `repo:<host>/<owner>/<name>`. */
  repoKey: string;
  owner: string;
  name: string;
  defaultBranch: string | null;
  addedAt: number;
  /** Set when the project was removed from the account. A removed project comes back only by an explicit add. */
  removedAt: number | null;
  /** Set when this row was found to be the same repository as another one: the other one is the project now. */
  mergedInto: string | null;
  /** Every address of the project, the current one included. */
  aliases: string[];
  copies: AccountProjectCopyView[];
};

export type AccountProjectListResponse = {
  /** Pass it as `since` next time. */
  cursor: number;
  /** True when this is the whole list (no `since`, or a `since` older than the server keeps changes for): replace the cache. */
  reset: boolean;
  /** Projects that changed after `since` (all of them when `reset`), removed and merged rows included. */
  projects: AccountProjectView[];
};

/** The identity a client knows for a repository. */
export type AccountProjectIdentityInput = {
  host: string;
  owner: string;
  name: string;
  /** The address the client's origin gives (`accountRepoScopeKey`). */
  repoKey: string;
  /** The address GitHub names now, when the client asked GitHub (`accountRepoScopeKey` of `https://<host>/<owner>/<name>`). */
  canonicalRepoKey?: string | null;
  repoId?: number | null;
  defaultBranch?: string | null;
};

export type AccountProjectAddRequest = AccountProjectIdentityInput;

export type AccountProjectAddResponse = {
  project: AccountProjectView;
  /** A new row was made. */
  created: boolean;
  /** The project had been removed and this add brought it back. */
  revived: boolean;
  cursor: number;
};

export type AccountProjectRemoveResponse = {
  project: AccountProjectView;
  cursor: number;
};

/**
 * How a copy may add its project to the account:
 * - `auto`: add it if the account has no such project; a project the person
 *   removed stays removed. A machine sends it only in its first fill (once
 *   per machine and account, projects opened in the last 90 days).
 * - `none`: only record the copy of a project already on the account. A
 *   person adds a project with `POST /account/projects`.
 */
export type AccountProjectCopyAddMode = "auto" | "none";

export type AccountProjectCopyInput = AccountProjectIdentityInput & {
  checkoutId: string;
  rootPath: string;
  isMain: boolean;
  add?: AccountProjectCopyAddMode;
};

export type AccountProjectCopiesRequest = {
  machineKey: string;
  /** Every copy on the machine. A copy the machine no longer sends is removed from the account. */
  copies: AccountProjectCopyInput[];
};

export type AccountProjectCopyStatus =
  /** Recorded under `projectId`. */
  | "linked"
  /** The account has no such project, and the copy did not ask to add one. */
  | "not_on_account"
  /** The project was removed from the account; the copy is not recorded. */
  | "removed"
  /** The account is at a limit; the copy is not recorded. */
  | "limit";

export type AccountProjectCopyResult = {
  checkoutId: string;
  status: AccountProjectCopyStatus;
  projectId: string | null;
  /** As stored: at most one main copy per machine and project. */
  isMain: boolean;
};

export type AccountProjectCopiesResponse = {
  copies: AccountProjectCopyResult[];
  cursor: number;
};
