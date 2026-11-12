import type { GitHubRateLimitState } from "./git";

/**
 * Direct GitHub reads with the ADE account's GitHub App sign-in: the contract
 * the desktop (`window.ade.githubDirect`), the web client and, later, the
 * iPhone share. See `shared/github/directClient.ts`.
 */

export type GithubDirectRepoRef = { owner: string; name: string };

/**
 * Why a direct read failed. The first five are the states the user sees
 * (spec section 5, L12); `githubDirectStateCopy.ts` holds their words.
 *
 * - `not_connected`: the ADE account has no GitHub sign-in (or this computer
 *   has no ADE account, or the directory cannot hold one yet).
 * - `sign_in_expired`: the sign-in ended and renewal failed; connect again.
 * - `app_not_installed`: no installation of the App on the repository's owner.
 * - `rights_not_accepted`: installed, but the owner has not approved the
 *   App's current rights. A read still works; this comes from a write or
 *   from `diagnoseRepository`.
 * - `repo_not_reachable`: installed, but this repository is not in the
 *   installation or the user cannot see it (`sso`: a SAML session is needed).
 * - `rate_limited`: GitHub's limit; `retryAt` says when reads start again.
 * - `github_unavailable`: GitHub or the network did not answer.
 * - `not_found`: the thing asked for does not exist on a reachable repository.
 * - `forbidden`: GitHub refused for another reason.
 * - `invalid_request`: the caller's arguments were not valid.
 */
export type GithubDirectErrorKind =
  | "not_connected"
  | "sign_in_expired"
  | "app_not_installed"
  | "rights_not_accepted"
  | "repo_not_reachable"
  | "rate_limited"
  | "github_unavailable"
  | "not_found"
  | "forbidden"
  | "invalid_request";

export type GithubDirectError = {
  kind: GithubDirectErrorKind;
  /** Technical detail for logs; the screen uses `githubDirectStateCopy`. */
  message: string;
  owner?: string | null;
  name?: string | null;
  installationId?: number | null;
  accountType?: "User" | "Organization" | null;
  /** The installation's settings page on GitHub, when known. */
  manageUrl?: string | null;
  missingPermissions?: string[];
  /** `repo_not_reachable` because the organization needs a SAML session. */
  sso?: boolean;
  /** Epoch ms: when a rate limit or an outage ends, when known. */
  retryAt?: number | null;
  /** `rate_limited` by GitHub's secondary (burst) limit. */
  secondary?: boolean;
  /** A short machine reason (for example `unsupported` under `not_connected`). */
  reason?: string | null;
};

export type GithubDirectMeta = {
  /** Pages read for this answer (a 304 counts as a page). */
  pagesRead: number;
  /** Pages GitHub answered `304 Not Modified` (free of rate limit). */
  notModified: number;
  /** More pages exist than the page cap allowed. */
  truncated: boolean;
  /** Epoch ms of the answer. */
  fetchedAt: number;
  /**
   * The ADE account the answer belongs to (opaque; "anonymous" with none).
   * A cache of answers drops another account's data on a switch.
   */
  scope?: string;
};

export type GithubDirectResult<T> =
  | { ok: true; data: T; meta: GithubDirectMeta }
  | { ok: false; error: GithubDirectError };

export type GithubDirectUser = { login: string; avatarUrl: string | null } | null;

export type GithubDirectRepository = {
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string | null;
  pushedAt: string | null;
  htmlUrl: string | null;
  permissions: { pull: boolean; push: boolean; admin: boolean } | null;
};

export type GithubDirectPull = {
  number: number;
  title: string;
  state: "open" | "closed";
  draft: boolean;
  merged: boolean;
  user: GithubDirectUser;
  headRef: string;
  headSha: string;
  /** `owner/name` of the head repository; differs from the base for a fork. */
  headRepoFullName: string | null;
  baseRef: string;
  labels: string[];
  createdAt: string | null;
  updatedAt: string | null;
  mergedAt: string | null;
  closedAt: string | null;
  htmlUrl: string | null;
};

export type GithubDirectPullDetail = GithubDirectPull & {
  body: string;
  mergeable: boolean | null;
  mergeableState: string | null;
  additions: number | null;
  deletions: number | null;
  changedFiles: number | null;
  commits: number | null;
  comments: number | null;
  reviewComments: number | null;
  requestedReviewers: string[];
};

export type GithubDirectCheckRun = {
  name: string;
  status: string;
  conclusion: string | null;
  appName: string | null;
  htmlUrl: string | null;
  startedAt: string | null;
  completedAt: string | null;
};

export type GithubDirectChecks = {
  sha: string;
  runs: GithubDirectCheckRun[];
  /** The combined commit status (`success`, `pending`, `failure`, `error`), or null with no statuses. */
  combinedState: string | null;
  statuses: Array<{ context: string; state: string; description: string | null; targetUrl: string | null }>;
};

export type GithubDirectReview = {
  id: number;
  user: GithubDirectUser;
  state: string;
  body: string;
  submittedAt: string | null;
};

export type GithubDirectComment = {
  id: number;
  kind: "issue" | "review";
  user: GithubDirectUser;
  body: string;
  createdAt: string | null;
  updatedAt: string | null;
  path: string | null;
  line: number | null;
  htmlUrl: string | null;
};

export type GithubDirectIssue = {
  number: number;
  title: string;
  state: "open" | "closed";
  user: GithubDirectUser;
  labels: string[];
  comments: number;
  createdAt: string | null;
  updatedAt: string | null;
  htmlUrl: string | null;
};

/** One issue with its text, as the issue pane shows it. */
export type GithubDirectIssueDetail = GithubDirectIssue & {
  body: string;
  assignees: string[];
  milestone: string | null;
  closedAt: string | null;
};

/** What `diagnoseRepository` found, in the spec's detection order. */
export type GithubDirectRepositoryDiagnosis = {
  /**
   * - `ok`: installed with the current rights, and the repository answers.
   * - `read_only`: no installation on the owner, but the repository is
   *   public: reads work, changes do not.
   * - `rights_not_accepted`: reads work; the owner must approve the rights.
   * - the other states: the matching `GithubDirectErrorKind`.
   */
  state: "ok" | "read_only" | "rights_not_accepted" | "not_connected" | "sign_in_expired" | "app_not_installed" | "repo_not_reachable";
  /** Set for every state except `ok`. */
  error: GithubDirectError | null;
};

export type GithubDirectListState = "open" | "closed" | "all";

/** One direct read. The client builds the GitHub request from it and nothing else. */
export type GithubDirectRequest =
  | { op: "listRepositories"; params?: { maxPages?: number } }
  | { op: "listPulls"; params: GithubDirectRepoRef & { state?: GithubDirectListState; maxPages?: number } }
  | { op: "getPull"; params: GithubDirectRepoRef & { number: number } }
  | { op: "listChecks"; params: GithubDirectRepoRef & { sha: string } }
  | { op: "listReviews"; params: GithubDirectRepoRef & { number: number } }
  | { op: "listComments"; params: GithubDirectRepoRef & { number: number } }
  | { op: "listIssues"; params: GithubDirectRepoRef & { state?: GithubDirectListState; maxPages?: number } }
  | { op: "getIssue"; params: GithubDirectRepoRef & { number: number } }
  | { op: "listIssueComments"; params: GithubDirectRepoRef & { number: number } }
  | { op: "diagnoseRepository"; params: GithubDirectRepoRef };

export type GithubDirectOp = GithubDirectRequest["op"];

/** Answer type per op. */
export type GithubDirectData = {
  listRepositories: GithubDirectRepository[];
  listPulls: GithubDirectPull[];
  getPull: GithubDirectPullDetail;
  listChecks: GithubDirectChecks;
  listReviews: GithubDirectReview[];
  listComments: GithubDirectComment[];
  listIssues: GithubDirectIssue[];
  getIssue: GithubDirectIssueDetail;
  listIssueComments: GithubDirectComment[];
  diagnoseRepository: GithubDirectRepositoryDiagnosis;
};

export type GithubDirectRequestOptions = {
  /** A background refresh: skipped while the rate limit is low. */
  background?: boolean;
};

export type GithubDirectClientState = {
  rateLimit: GitHubRateLimitState | null;
  /** Background refreshes stop below 10 % of the limit, until it resets. */
  backgroundPaused: boolean;
  /** Epoch ms: no request is sent before this (a rate limit), or null. */
  blockedUntil: number | null;
  counts: {
    /** Requests sent to GitHub. */
    requests: number;
    /** Of those, answered `304 Not Modified`. */
    notModified: number;
    /** Requests that count against the rate limit (sent, not 304). */
    counted: number;
    /** Reads refused locally (rate limit) without a request. */
    blocked: number;
    /** Retries after a 401 with a new token. */
    retriesAfter401: number;
  };
};
