import type {
  GitHubRateLimitState,
  GithubDirectCheckRun,
  GithubDirectChecks,
  GithubDirectClientState,
  GithubDirectComment,
  GithubDirectData,
  GithubDirectError,
  GithubDirectErrorKind,
  GithubDirectIssue,
  GithubDirectIssueDetail,
  GithubDirectListState,
  GithubDirectMeta,
  GithubDirectOp,
  GithubDirectPull,
  GithubDirectPullDetail,
  GithubDirectRepoRef,
  GithubDirectRepository,
  GithubDirectRepositoryDiagnosis,
  GithubDirectRequest,
  GithubDirectRequestOptions,
  GithubDirectResult,
  GithubDirectReview,
  GithubDirectUser,
} from "../types";
import type { AccountAppTokenClient } from "./accountAppTokenClient";
import { appGrantMissingPermissions, appGrantNeedsApproval, appInstallationGrantForOwner } from "./githubAppGrant";

/**
 * Direct GitHub reads with the ADE account's GitHub App sign-in, with no ADE
 * machine in between. Isomorphic: `fetch` and the token are injected, so the
 * desktop main process, the web client and (as a Swift port) the iPhone run
 * the same contract.
 *
 * - Only the reads in `GithubDirectRequest`. `buildGithubDirectRequest` turns
 *   one into GitHub paths after it checks every argument, so a caller can
 *   never point the token at another path or host.
 * - ETag per URL, in memory (LRU, 200 pages): every GET sends
 *   `If-None-Match`, and a `304` reuses the stored page. GitHub does not
 *   count a `304` against the rate limit.
 * - Pagination by `Link: rel="next"` on the API origin only, at most 5 pages
 *   per list unless the caller asks for more (at most 10).
 * - Rate limit from `x-ratelimit-*`. Below 10 % remaining, background reads
 *   stop until the reset. A `403`/`429` rate limit (primary or secondary)
 *   blocks every read until it ends, with no request.
 * - One retry after a `401`, with the token the server answers for the
 *   rejected one (the server and this process ask GitHub at most once a
 *   minute per token).
 * - A `404` on a repository read is refined into the state the user sees
 *   (`app_not_installed`, `repo_not_reachable`) by `diagnoseRepository`.
 * - Six requests in flight at most, unless the host passes its own gate.
 *
 * Answers are envelopes (`GithubDirectResult`); nothing here throws to the
 * caller. No token is logged or put in an answer.
 */

export const GITHUB_DIRECT_API_BASE = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const ETAG_CACHE_MAX = 200;
const DEFAULT_LIST_MAX_PAGES = 5;
const LIST_MAX_PAGES_CEILING = 10;
const SUBLIST_MAX_PAGES = 3;
const MAX_IN_FLIGHT = 6;
const REQUEST_TIMEOUT_MS = 20_000;
const LOW_RATE_LIMIT_SHARE = 0.1;
const SECONDARY_LIMIT_DEFAULT_MS = 60_000;
const DIAGNOSIS_TTL_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Request builder (pure)
// ---------------------------------------------------------------------------

/** GitHub's rule for a user or organization login. */
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
/** GitHub's rule for a repository name ("." and ".." are not names). */
const NAME_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;
const SHA_PATTERN = /^[0-9a-fA-F]{7,40}$/;
const LIST_STATES: ReadonlySet<string> = new Set(["open", "closed", "all"]);

export type GithubDirectHttpStep = {
  /** API path (always starts with `/`). */
  path: string;
  query: Record<string, string>;
  /** Follow `Link: rel="next"` up to this many pages; 1 = one page. */
  maxPages: number;
};

export type GithubDirectBuiltRequest =
  | { ok: true; op: GithubDirectOp; repo: GithubDirectRepoRef | null; steps: GithubDirectHttpStep[] }
  | { ok: false; error: GithubDirectError };

const invalid = (message: string): { ok: false; error: GithubDirectError } => ({
  ok: false,
  error: { kind: "invalid_request", message },
});

function checkRepo(params: unknown): GithubDirectRepoRef | string {
  const record = isRecord(params) ? params : {};
  const owner = typeof record.owner === "string" ? record.owner.trim() : "";
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!OWNER_PATTERN.test(owner)) return "owner is not a GitHub login";
  if (!NAME_PATTERN.test(name) || name === "." || name === "..") return "name is not a repository name";
  return { owner, name };
}

function checkNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function checkMaxPages(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(LIST_MAX_PAGES_CEILING, Math.max(1, Math.trunc(value)));
}

function checkListState(value: unknown): GithubDirectListState | null {
  if (value === undefined || value === null) return "open";
  return typeof value === "string" && LIST_STATES.has(value) ? value as GithubDirectListState : null;
}

const repoPath = (repo: GithubDirectRepoRef): string =>
  `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;

/**
 * The GitHub GETs one direct read sends, or why the read is not valid.
 * Pure: the same input always builds the same paths.
 */
export function buildGithubDirectRequest(request: unknown): GithubDirectBuiltRequest {
  if (!isRecord(request) || typeof request.op !== "string") return invalid("a request needs an op");
  const params = request.params;
  switch (request.op as GithubDirectOp) {
    case "listRepositories": {
      const maxPages = checkMaxPages(isRecord(params) ? params.maxPages : undefined, DEFAULT_LIST_MAX_PAGES);
      return {
        ok: true,
        op: "listRepositories",
        repo: null,
        steps: [{ path: "/user/repos", query: { per_page: "100", sort: "pushed" }, maxPages }],
      };
    }
    case "listPulls":
    case "listIssues": {
      const repo = checkRepo(params);
      if (typeof repo === "string") return invalid(repo);
      const record = params as Record<string, unknown>;
      const state = checkListState(record.state);
      if (!state) return invalid("state is open, closed or all");
      const maxPages = checkMaxPages(record.maxPages, DEFAULT_LIST_MAX_PAGES);
      // The default sort (created, newest first) keeps pages stable while
      // PRs are updated; `per_page=50` matches the machine path.
      return {
        ok: true,
        op: request.op as "listPulls" | "listIssues",
        repo,
        steps: [{
          path: `${repoPath(repo)}/${request.op === "listPulls" ? "pulls" : "issues"}`,
          query: { state, per_page: "50" },
          maxPages,
        }],
      };
    }
    case "getIssue":
    case "listIssueComments": {
      const repo = checkRepo(params);
      if (typeof repo === "string") return invalid(repo);
      const number = checkNumber((params as Record<string, unknown>).number);
      if (number == null) return invalid("number is a positive whole number");
      const base = `${repoPath(repo)}/issues/${number}`;
      return request.op === "getIssue"
        ? { ok: true, op: "getIssue", repo, steps: [{ path: base, query: {}, maxPages: 1 }] }
        : { ok: true, op: "listIssueComments", repo, steps: [{ path: `${base}/comments`, query: { per_page: "100" }, maxPages: SUBLIST_MAX_PAGES }] };
    }
    case "getPull":
    case "listReviews":
    case "listComments": {
      const repo = checkRepo(params);
      if (typeof repo === "string") return invalid(repo);
      const number = checkNumber((params as Record<string, unknown>).number);
      if (number == null) return invalid("number is a positive whole number");
      const base = repoPath(repo);
      if (request.op === "getPull") {
        return { ok: true, op: "getPull", repo, steps: [{ path: `${base}/pulls/${number}`, query: {}, maxPages: 1 }] };
      }
      if (request.op === "listReviews") {
        return {
          ok: true,
          op: "listReviews",
          repo,
          steps: [{ path: `${base}/pulls/${number}/reviews`, query: { per_page: "100" }, maxPages: SUBLIST_MAX_PAGES }],
        };
      }
      return {
        ok: true,
        op: "listComments",
        repo,
        steps: [
          { path: `${base}/issues/${number}/comments`, query: { per_page: "100" }, maxPages: SUBLIST_MAX_PAGES },
          { path: `${base}/pulls/${number}/comments`, query: { per_page: "100" }, maxPages: SUBLIST_MAX_PAGES },
        ],
      };
    }
    case "listChecks": {
      const repo = checkRepo(params);
      if (typeof repo === "string") return invalid(repo);
      const sha = (params as Record<string, unknown>).sha;
      if (typeof sha !== "string" || !SHA_PATTERN.test(sha)) return invalid("sha is a commit SHA");
      const base = `${repoPath(repo)}/commits/${sha.toLowerCase()}`;
      return {
        ok: true,
        op: "listChecks",
        repo,
        steps: [
          { path: `${base}/check-runs`, query: { per_page: "100" }, maxPages: SUBLIST_MAX_PAGES },
          { path: `${base}/status`, query: { per_page: "100" }, maxPages: 1 },
        ],
      };
    }
    case "diagnoseRepository": {
      const repo = checkRepo(params);
      if (typeof repo === "string") return invalid(repo);
      return {
        ok: true,
        op: "diagnoseRepository",
        repo,
        steps: [
          { path: "/user/installations", query: { per_page: "100" }, maxPages: 1 },
          { path: repoPath(repo), query: {}, maxPages: 1 },
        ],
      };
    }
    default:
      return invalid("unknown op");
  }
}

// ---------------------------------------------------------------------------
// Error classifier (pure)
// ---------------------------------------------------------------------------

function headerInt(headers: Pick<Headers, "get">, name: string): number | null {
  const raw = headers.get(name);
  if (raw == null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : null;
}

function bodyMessage(body: unknown): string {
  return isRecord(body) && typeof body.message === "string" ? body.message.slice(0, 300) : "";
}

/**
 * What a GitHub answer means for a direct read, or null for a success
 * (2xx or 304). Pure. A `404` stays `not_found` here; the client refines it
 * with `diagnoseRepositoryAccess` for repository reads.
 */
export function classifyGithubDirectResponse(input: {
  status: number;
  headers: Pick<Headers, "get">;
  body: unknown;
  now: number;
  repo?: GithubDirectRepoRef | null;
}): GithubDirectError | null {
  const { status, headers, body, now } = input;
  if ((status >= 200 && status < 300) || status === 304) return null;
  const message = bodyMessage(body);
  const where = input.repo ? { owner: input.repo.owner, name: input.repo.name } : {};
  if (status === 401) return { kind: "sign_in_expired", message: message || "GitHub did not accept the sign-in." };
  if (status === 403 || status === 429) {
    const retryAfter = headerInt(headers, "retry-after");
    if (retryAfter != null) {
      return { kind: "rate_limited", message: message || "GitHub asked ADE to slow down.", retryAt: now + retryAfter * 1000, secondary: true };
    }
    if (headerInt(headers, "x-ratelimit-remaining") === 0) {
      const reset = headerInt(headers, "x-ratelimit-reset");
      return { kind: "rate_limited", message: message || "GitHub rate limit reached.", retryAt: reset != null ? reset * 1000 : null, secondary: false };
    }
    if (/secondary rate limit|abuse/i.test(message) || status === 429) {
      return { kind: "rate_limited", message: message || "GitHub asked ADE to slow down.", retryAt: now + SECONDARY_LIMIT_DEFAULT_MS, secondary: true };
    }
    if (headers.get("x-github-sso")) {
      return { kind: "repo_not_reachable", message: message || "This organization needs a single sign-on session.", sso: true, ...where };
    }
    if (/resource not accessible by integration/i.test(message)) {
      return { kind: "rights_not_accepted", message, ...where };
    }
    return { kind: "forbidden", message: message || "GitHub refused the request.", ...where };
  }
  if (status === 404 || status === 410) return { kind: "not_found", message: message || "Not found.", ...where };
  if (status === 400 || status === 422) return { kind: "invalid_request", message: message || "GitHub did not accept the request." };
  if (status >= 500) {
    const retryAfter = headerInt(headers, "retry-after");
    return { kind: "github_unavailable", message: message || "GitHub did not answer.", retryAt: retryAfter != null ? now + retryAfter * 1000 : null };
  }
  return { kind: "forbidden", message: message || `GitHub answered ${status}.`, ...where };
}

/**
 * Which state the user sees for a repository, from the user's App
 * installations and the repository's answer. Pure.
 *
 * Order (spec section 5): no installation on the owner (or a public
 * repository read without one), then a repository that does not answer, then
 * rights not accepted. A repository that does not answer comes before rights
 * not accepted, because reads fail there and only changes fail here.
 */
export function diagnoseRepositoryAccess(input: {
  repo: GithubDirectRepoRef;
  installations: unknown;
  repoAnswer: { status: number; private: boolean | null; sso: boolean };
}): GithubDirectRepositoryDiagnosis {
  const { repo } = input;
  const grant = appInstallationGrantForOwner(input.installations, repo.owner);
  const where = { owner: repo.owner, name: repo.name };
  const answered = input.repoAnswer.status >= 200 && input.repoAnswer.status < 300;
  if (!grant.installed) {
    if (answered && input.repoAnswer.private === false) {
      return { state: "read_only", error: { kind: "app_not_installed", message: "public repository, App not installed on its owner", reason: "read_only", ...where } };
    }
    return { state: "app_not_installed", error: { kind: "app_not_installed", message: "App not installed on the owner", ...where } };
  }
  const installation = {
    installationId: grant.installationId,
    accountType: grant.accountType,
    manageUrl: grant.manageUrl,
  };
  if (!answered) {
    return {
      state: "repo_not_reachable",
      error: { kind: "repo_not_reachable", message: "repository not in the installation or not visible", sso: input.repoAnswer.sso, ...where, ...installation },
    };
  }
  if (appGrantNeedsApproval(grant)) {
    return {
      state: "rights_not_accepted",
      error: {
        kind: "rights_not_accepted",
        message: "the owner has not approved the App's current rights",
        missingPermissions: appGrantMissingPermissions(grant),
        ...where,
        ...installation,
      },
    };
  }
  return { state: "ok", error: null };
}

/** The next page's URL from a `Link` header, only on `apiOrigin`. */
export function nextPageUrl(link: string | null, apiOrigin: string): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const match = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part.trim());
    if (!match) continue;
    try {
      const url = new URL(match[1]!);
      return url.origin === apiOrigin ? url.toString() : null;
    } catch {
      return null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Mapping GitHub JSON to the small shapes
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const bool = (value: unknown): boolean => value === true;

function user(value: unknown): GithubDirectUser {
  if (!isRecord(value) || typeof value.login !== "string") return null;
  return { login: value.login, avatarUrl: str(value.avatar_url) };
}

function labels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((label) => (isRecord(label) ? str(label.name) : str(label))).filter((name): name is string => Boolean(name));
}

function mapRepository(value: unknown): GithubDirectRepository | null {
  if (!isRecord(value)) return null;
  const owner = isRecord(value.owner) ? str(value.owner.login) : null;
  const name = str(value.name);
  if (!owner || !name) return null;
  const permissions = isRecord(value.permissions)
    ? { pull: bool(value.permissions.pull), push: bool(value.permissions.push), admin: bool(value.permissions.admin) }
    : null;
  return {
    owner,
    name,
    fullName: str(value.full_name) ?? `${owner}/${name}`,
    private: bool(value.private),
    defaultBranch: str(value.default_branch),
    pushedAt: str(value.pushed_at),
    htmlUrl: str(value.html_url),
    permissions,
  };
}

function mapPull(value: unknown): GithubDirectPull | null {
  if (!isRecord(value)) return null;
  const number = num(value.number);
  if (number == null) return null;
  const head = isRecord(value.head) ? value.head : {};
  const base = isRecord(value.base) ? value.base : {};
  const headRepo = isRecord(head.repo) ? head.repo : null;
  return {
    number,
    title: str(value.title) ?? "",
    state: value.state === "closed" ? "closed" : "open",
    draft: bool(value.draft),
    merged: bool(value.merged) || Boolean(str(value.merged_at)),
    user: user(value.user),
    headRef: str(head.ref) ?? "",
    headSha: str(head.sha) ?? "",
    headRepoFullName: headRepo ? str(headRepo.full_name) : null,
    baseRef: str(base.ref) ?? "",
    labels: labels(value.labels),
    createdAt: str(value.created_at),
    updatedAt: str(value.updated_at),
    mergedAt: str(value.merged_at),
    closedAt: str(value.closed_at),
    htmlUrl: str(value.html_url),
  };
}

function mapPullDetail(value: unknown): GithubDirectPullDetail | null {
  const pull = mapPull(value);
  if (!pull || !isRecord(value)) return null;
  const reviewers = Array.isArray(value.requested_reviewers) ? value.requested_reviewers : [];
  return {
    ...pull,
    body: str(value.body) ?? "",
    mergeable: typeof value.mergeable === "boolean" ? value.mergeable : null,
    mergeableState: str(value.mergeable_state),
    additions: num(value.additions),
    deletions: num(value.deletions),
    changedFiles: num(value.changed_files),
    commits: num(value.commits),
    comments: num(value.comments),
    reviewComments: num(value.review_comments),
    requestedReviewers: reviewers.map((reviewer) => user(reviewer)?.login ?? null).filter((login): login is string => Boolean(login)),
  };
}

function mapCheckRun(value: unknown): GithubDirectCheckRun | null {
  if (!isRecord(value)) return null;
  const name = str(value.name);
  if (!name) return null;
  return {
    name,
    status: str(value.status) ?? "unknown",
    conclusion: str(value.conclusion),
    appName: isRecord(value.app) ? str(value.app.name) : null,
    htmlUrl: str(value.html_url),
    startedAt: str(value.started_at),
    completedAt: str(value.completed_at),
  };
}

function mapReview(value: unknown): GithubDirectReview | null {
  if (!isRecord(value)) return null;
  const id = num(value.id);
  if (id == null) return null;
  return { id, user: user(value.user), state: str(value.state) ?? "", body: str(value.body) ?? "", submittedAt: str(value.submitted_at) };
}

function mapComment(kind: "issue" | "review") {
  return (value: unknown): GithubDirectComment | null => {
    if (!isRecord(value)) return null;
    const id = num(value.id);
    if (id == null) return null;
    return {
      id,
      kind,
      user: user(value.user),
      body: str(value.body) ?? "",
      createdAt: str(value.created_at),
      updatedAt: str(value.updated_at),
      path: kind === "review" ? str(value.path) : null,
      line: kind === "review" ? num(value.line) ?? num(value.original_line) : null,
      htmlUrl: str(value.html_url),
    };
  };
}

function mapIssue(value: unknown): GithubDirectIssue | null {
  if (!isRecord(value) || value.pull_request !== undefined) return null; // The issues list also returns PRs.
  const number = num(value.number);
  if (number == null) return null;
  return {
    number,
    title: str(value.title) ?? "",
    state: value.state === "closed" ? "closed" : "open",
    user: user(value.user),
    labels: labels(value.labels),
    comments: num(value.comments) ?? 0,
    createdAt: str(value.created_at),
    updatedAt: str(value.updated_at),
    htmlUrl: str(value.html_url),
  };
}

function mapIssueDetail(value: unknown): GithubDirectIssueDetail | null {
  const issue = mapIssue(value);
  if (!issue || !isRecord(value)) return null;
  const assignees = Array.isArray(value.assignees) ? value.assignees : [];
  return {
    ...issue,
    body: str(value.body) ?? "",
    assignees: assignees.map((assignee) => user(assignee)?.login ?? null).filter((login): login is string => Boolean(login)),
    milestone: isRecord(value.milestone) ? str(value.milestone.title) : null,
    closedAt: str(value.closed_at),
  };
}

const listOf = <T>(map: (value: unknown) => T | null) => (body: unknown): T[] =>
  (Array.isArray(body) ? body : []).map(map).filter((item): item is T => item !== null);

// ---------------------------------------------------------------------------
// Credential
// ---------------------------------------------------------------------------

export type GithubDirectCredential = {
  /** The account App token, or the state that stands in its way. */
  getToken: () => Promise<{ ok: true; token: string } | { ok: false; error: GithubDirectError }>;
  /** GitHub answered 401 to `token`: a different current token, or null. */
  onRejected: (token: string) => Promise<string | null>;
  /** Keys the ETag cache, so one account's pages never answer another's reads. */
  scopeKey: () => string | null;
};

/** The direct-read credential over the account App token client (desktop main, web). */
export function accountAppDirectCredential(
  client: Pick<AccountAppTokenClient, "getToken">,
  getAccountUserId: () => string | null,
): GithubDirectCredential {
  return {
    getToken: async () => {
      const result = await client.getToken();
      if (result.ok) return { ok: true, token: result.token };
      const retryAt = result.retryAtEpochMs ?? null;
      switch (result.state) {
        case "needs_reauth":
          return { ok: false, error: { kind: "sign_in_expired", message: "the account's GitHub sign-in ended", reason: result.reason } };
        case "unavailable":
          return { ok: false, error: { kind: "github_unavailable", message: "the GitHub sign-in could not be renewed right now", retryAt, reason: result.reason } };
        case "unsupported":
          return { ok: false, error: { kind: "not_connected", message: "the account directory has no GitHub sign-in yet", reason: "unsupported" } };
        case "signed_out":
          return { ok: false, error: { kind: "not_connected", message: "no ADE account on this device", reason: "signed_out" } };
        default:
          return { ok: false, error: { kind: "not_connected", message: "GitHub is not connected to the ADE account", reason: result.reason } };
      }
    },
    onRejected: async (token) => {
      const result = await client.getToken({ afterRejected: token });
      return result.ok && result.token !== token ? result.token : null;
    },
    scopeKey: () => getAccountUserId()?.trim() || null,
  };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

type CachedPage = { etag: string; data: unknown[] | unknown; next: string | null };

type StepAnswer =
  | { ok: true; items: unknown[]; single: unknown; pagesRead: number; notModified: number; truncated: boolean }
  | { ok: false; error: GithubDirectError; status: number; body: unknown };

class RejectedToken extends Error {
  constructor(readonly token: string) {
    super("rejected");
  }
}

export type GithubDirectClientOptions = {
  credential: GithubDirectCredential;
  fetchImpl?: typeof fetch;
  apiBaseUrl?: string;
  /** A host-wide request gate (the desktop's six-slot gate); else the client's own. */
  acquireSlot?: (signal?: AbortSignal | null) => Promise<() => void>;
  now?: () => number;
  etagCacheMax?: number;
  /** Browser-only fetch options (credentials, referrer). */
  browser?: boolean;
};

export function createGithubDirectClient(options: GithubDirectClientOptions) {
  const now = options.now ?? (() => Date.now());
  const fetchImpl = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const apiBase = (options.apiBaseUrl ?? GITHUB_DIRECT_API_BASE).replace(/\/+$/, "");
  const apiOrigin = new URL(apiBase).origin;
  const cacheMax = options.etagCacheMax ?? ETAG_CACHE_MAX;
  const pages = new Map<string, CachedPage>();
  const inFlight = new Map<string, Promise<PageAnswer>>();
  const diagnoses = new Map<string, { at: number; diagnosis: GithubDirectRepositoryDiagnosis }>();
  let rateLimit: GitHubRateLimitState | null = null;
  let blockedUntil: number | null = null;
  const counts: GithubDirectClientState["counts"] = { requests: 0, notModified: 0, counted: 0, blocked: 0, retriesAfter401: 0 };

  // The client's own gate when the host has none.
  let slotsInUse = 0;
  const slotWaiters: Array<() => void> = [];
  const ownSlot = async (): Promise<() => void> => {
    if (slotsInUse >= MAX_IN_FLIGHT) await new Promise<void>((resolve) => slotWaiters.push(resolve));
    slotsInUse += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      slotsInUse -= 1;
      slotWaiters.shift()?.();
    };
  };
  const acquireSlot = options.acquireSlot ?? ownSlot;

  const backgroundPaused = (): boolean => {
    if (!rateLimit || rateLimit.limit == null || rateLimit.remaining == null || rateLimit.limit <= 0) return false;
    const resetAt = rateLimit.resetAt ? Date.parse(rateLimit.resetAt) : NaN;
    if (Number.isFinite(resetAt) && resetAt <= now()) return false;
    return rateLimit.remaining < rateLimit.limit * LOW_RATE_LIMIT_SHARE;
  };

  const noteRateLimit = (headers: Pick<Headers, "get">): void => {
    const limit = headerInt(headers, "x-ratelimit-limit");
    const remaining = headerInt(headers, "x-ratelimit-remaining");
    if (limit == null && remaining == null) return;
    const reset = headerInt(headers, "x-ratelimit-reset");
    rateLimit = {
      limit,
      remaining,
      used: headerInt(headers, "x-ratelimit-used"),
      resetAt: reset != null ? new Date(reset * 1000).toISOString() : null,
      resource: headers.get("x-ratelimit-resource"),
    };
  };

  const remember = (key: string, page: CachedPage): void => {
    pages.delete(key);
    pages.set(key, page);
    while (pages.size > cacheMax) {
      const oldest = pages.keys().next().value;
      if (oldest === undefined) break;
      pages.delete(oldest);
    }
  };

  type PageAnswer =
    | { ok: true; body: unknown; next: string | null; notModified: boolean }
    | { ok: false; status: number; body: unknown; headers: Pick<Headers, "get"> | null; error: GithubDirectError | null };

  /** One GET. Never throws, except `RejectedToken` on a 401. */
  const getPage = async (url: string, token: string, scope: string): Promise<PageAnswer> => {
    const key = `${scope}\n${url}`;
    const joined = inFlight.get(key);
    if (joined) return joined;
    const work = (async (): Promise<PageAnswer> => {
      const cached = pages.get(key);
      const release = await acquireSlot();
      let response: Response;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        counts.requests += 1;
        response = await fetchImpl(url, {
          method: "GET",
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${token}`,
            "x-github-api-version": GITHUB_API_VERSION,
            ...(cached ? { "if-none-match": cached.etag } : {}),
          },
          signal: controller.signal,
          // ADE keeps its own ETags; the browser cache would turn a 304 into a 200.
          cache: "no-store",
          ...(options.browser ? { credentials: "omit" as const, referrerPolicy: "no-referrer" as const } : {}),
        });
      } catch {
        return { ok: false, status: 0, body: null, headers: null, error: { kind: "github_unavailable", message: "GitHub could not be reached." } };
      } finally {
        clearTimeout(timer);
        release();
      }
      noteRateLimit(response.headers);
      if (response.status === 304 && cached) {
        counts.notModified += 1;
        await response.body?.cancel().catch(() => undefined);
        remember(key, cached);
        return { ok: true, body: cached.data, next: cached.next, notModified: true };
      }
      counts.counted += 1;
      if (response.status === 401) {
        await response.body?.cancel().catch(() => undefined);
        throw new RejectedToken(token);
      }
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (response.ok) {
        const next = nextPageUrl(response.headers.get("link"), apiOrigin);
        const etag = response.headers.get("etag");
        if (etag) remember(key, { etag, data: body, next });
        return { ok: true, body, next, notModified: false };
      }
      return { ok: false, status: response.status, body, headers: response.headers, error: null };
    })();
    inFlight.set(key, work);
    try {
      return await work;
    } finally {
      if (inFlight.get(key) === work) inFlight.delete(key);
    }
  };

  const runStep = async (
    step: GithubDirectHttpStep,
    token: string,
    scope: string,
    repo: GithubDirectRepoRef | null,
  ): Promise<StepAnswer> => {
    const query = new URLSearchParams(step.query).toString();
    let url: string | null = `${apiBase}${step.path}${query ? `?${query}` : ""}`;
    const items: unknown[] = [];
    let single: unknown = null;
    let pagesRead = 0;
    let notModified = 0;
    while (url && pagesRead < step.maxPages) {
      const page = await getPage(url, token, scope);
      if (!page.ok) {
        const error = page.error ?? classifyGithubDirectResponse({
          status: page.status,
          headers: page.headers ?? new Headers(),
          body: page.body,
          now: now(),
          repo,
        }) ?? { kind: "forbidden" as const, message: `GitHub answered ${page.status}.` };
        return { ok: false, error, status: page.status, body: page.body };
      }
      pagesRead += 1;
      if (page.notModified) notModified += 1;
      if (Array.isArray(page.body)) items.push(...page.body);
      else if (isRecord(page.body) && Array.isArray(page.body.check_runs)) items.push(...page.body.check_runs);
      else single = page.body;
      url = page.next;
    }
    return { ok: true, items, single, pagesRead, notModified, truncated: Boolean(url) };
  };

  const blockedError = (): GithubDirectError | null => {
    if (blockedUntil != null && blockedUntil > now()) {
      return { kind: "rate_limited", message: "GitHub rate limit; waiting for it to end.", retryAt: blockedUntil };
    }
    blockedUntil = null;
    return null;
  };

  const fail = <T>(error: GithubDirectError): GithubDirectResult<T> => {
    if (error.kind === "rate_limited") {
      blockedUntil = Math.max(blockedUntil ?? 0, error.retryAt ?? now() + SECONDARY_LIMIT_DEFAULT_MS);
    }
    return { ok: false, error };
  };

  const diagnose = async (repo: GithubDirectRepoRef, token: string, scope: string): Promise<GithubDirectRepositoryDiagnosis | GithubDirectError> => {
    const key = `${scope}\n${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}`;
    const cached = diagnoses.get(key);
    if (cached && now() - cached.at < DIAGNOSIS_TTL_MS) return cached.diagnosis;
    const built = buildGithubDirectRequest({ op: "diagnoseRepository", params: repo });
    if (!built.ok) return built.error;
    const [installationsStep, repoStep] = built.steps;
    const installations = await runStep(installationsStep!, token, scope, null);
    if (!installations.ok) return installations.error;
    const repository = await runStep(repoStep!, token, scope, repo);
    if (!repository.ok && repository.error.kind !== "not_found" && repository.error.kind !== "repo_not_reachable" && repository.error.kind !== "forbidden") {
      return repository.error;
    }
    const diagnosis = diagnoseRepositoryAccess({
      repo,
      installations: installations.single,
      repoAnswer: repository.ok
        ? { status: 200, private: isRecord(repository.single) ? bool(repository.single.private) : null, sso: false }
        : { status: repository.status, private: null, sso: repository.error.sso === true },
    });
    diagnoses.set(key, { at: now(), diagnosis });
    return diagnosis;
  };

  const shape = (op: GithubDirectOp, answers: Array<Extract<StepAnswer, { ok: true }>>): unknown => {
    const [first, second] = answers;
    switch (op) {
      case "listRepositories":
        return listOf(mapRepository)(first!.items);
      case "listPulls":
        return listOf(mapPull)(first!.items);
      case "listIssues":
        return listOf(mapIssue)(first!.items);
      case "getIssue":
        return mapIssueDetail(first!.single);
      case "listIssueComments":
        return listOf(mapComment("issue"))(first!.items);
      case "getPull":
        return mapPullDetail(first!.single);
      case "listReviews":
        return listOf(mapReview)(first!.items);
      case "listComments":
        return [...listOf(mapComment("issue"))(first!.items), ...listOf(mapComment("review"))(second!.items)]
          .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
      case "listChecks": {
        const status = isRecord(second!.single) ? second!.single : {};
        const statuses = Array.isArray(status.statuses) ? status.statuses : [];
        const checks: Omit<GithubDirectChecks, "sha"> = {
          runs: listOf(mapCheckRun)(first!.items),
          combinedState: statuses.length > 0 ? str(status.state) : null,
          statuses: statuses.filter(isRecord).map((entry) => ({
            context: str(entry.context) ?? "",
            state: str(entry.state) ?? "",
            description: str(entry.description),
            targetUrl: str(entry.target_url),
          })),
        };
        return checks;
      }
      default:
        return null;
    }
  };

  /** One direct read. Never throws. */
  const request = async <O extends GithubDirectOp>(
    input: Extract<GithubDirectRequest, { op: O }> | GithubDirectRequest,
    requestOptions: GithubDirectRequestOptions = {},
  ): Promise<GithubDirectResult<GithubDirectData[O]>> => {
    const built = buildGithubDirectRequest(input);
    if (!built.ok) return { ok: false, error: built.error };
    const blocked = blockedError();
    if (blocked) {
      counts.blocked += 1;
      return { ok: false, error: blocked };
    }
    if (requestOptions.background && backgroundPaused()) {
      counts.blocked += 1;
      return {
        ok: false,
        error: {
          kind: "rate_limited",
          message: "GitHub rate limit is low; background reads wait for the reset.",
          retryAt: rateLimit?.resetAt ? Date.parse(rateLimit.resetAt) : null,
          reason: "background_paused",
        },
      };
    }
    // The ADE account this read belongs to, taken before the token. A switch
    // while the read runs drops its answer and its retry: neither the old
    // account's data nor the new account's token may cross over.
    const scope = options.credential.scopeKey() ?? "anonymous";
    const accountChanged = (): boolean => (options.credential.scopeKey() ?? "anonymous") !== scope;
    const changedAnswer = { ok: false as const, error: { kind: "github_unavailable" as const, message: "The ADE account changed during the read." } };
    const tokenAnswer = await options.credential.getToken().catch(() => null);
    if (accountChanged()) return changedAnswer;
    if (!tokenAnswer) return { ok: false, error: { kind: "github_unavailable", message: "The GitHub sign-in could not be read." } };
    if (!tokenAnswer.ok) return { ok: false, error: tokenAnswer.error };

    const attempt = async (token: string): Promise<GithubDirectResult<GithubDirectData[O]>> => {
      if (built.op === "diagnoseRepository") {
        const diagnosis = await diagnose(built.repo!, token, scope);
        if ("kind" in diagnosis) return fail(diagnosis);
        return { ok: true, data: diagnosis as GithubDirectData[O], meta: { pagesRead: 2, notModified: 0, truncated: false, fetchedAt: now() } };
      }
      const answers: Array<Extract<StepAnswer, { ok: true }>> = [];
      for (const step of built.steps) {
        const answer = await runStep(step, token, scope, built.repo);
        if (!answer.ok) {
          let error = answer.error;
          if (error.kind === "not_found" && built.repo) {
            // A missing repository and a hidden one look the same; ask which.
            const diagnosis = await diagnose(built.repo, token, scope);
            if ("kind" in diagnosis) error = diagnosis;
            else if (diagnosis.state === "app_not_installed" || diagnosis.state === "repo_not_reachable") error = diagnosis.error!;
          }
          return fail(error);
        }
        answers.push(answer);
      }
      const data = shape(built.op, answers);
      if (data === null) return { ok: false, error: { kind: "not_found", message: "GitHub's answer had no data." } };
      if (built.op === "listChecks") (data as GithubDirectChecks).sha = String((input.params as { sha: string }).sha).toLowerCase();
      const meta: GithubDirectMeta = {
        pagesRead: answers.reduce((sum, answer) => sum + answer.pagesRead, 0),
        notModified: answers.reduce((sum, answer) => sum + answer.notModified, 0),
        truncated: answers.some((answer) => answer.truncated),
        fetchedAt: now(),
      };
      return { ok: true, data: data as GithubDirectData[O], meta };
    };

    const forThisAccount = (result: GithubDirectResult<GithubDirectData[O]>) => (accountChanged() ? changedAnswer : result);
    try {
      return forThisAccount(await attempt(tokenAnswer.token));
    } catch (error) {
      if (accountChanged()) return changedAnswer;
      if (!(error instanceof RejectedToken)) {
        return { ok: false, error: { kind: "github_unavailable", message: "The GitHub read failed." } };
      }
      const replacement = await options.credential.onRejected(error.token).catch(() => null);
      if (accountChanged()) return changedAnswer;
      if (!replacement) return { ok: false, error: { kind: "sign_in_expired", message: "GitHub did not accept the sign-in." } };
      counts.retriesAfter401 += 1;
      try {
        return forThisAccount(await attempt(replacement));
      } catch (again) {
        if (accountChanged()) return changedAnswer;
        if (again instanceof RejectedToken) {
          return { ok: false, error: { kind: "sign_in_expired", message: "GitHub did not accept the renewed sign-in." } };
        }
        return { ok: false, error: { kind: "github_unavailable", message: "The GitHub read failed." } };
      }
    }
  };

  const state = (): GithubDirectClientState => ({
    rateLimit,
    backgroundPaused: backgroundPaused(),
    blockedUntil: blockedUntil != null && blockedUntil > now() ? blockedUntil : null,
    counts: { ...counts },
  });

  /** Drops every stored page and diagnosis (sign-out, account switch). */
  const clear = (): void => {
    pages.clear();
    diagnoses.clear();
    blockedUntil = null;
  };

  return { request, state, clear };
}

export type GithubDirectClient = ReturnType<typeof createGithubDirectClient>;

/** True for the error kinds a person fixes on GitHub or in ADE (the L12 states). */
export function isGithubDirectUserState(kind: GithubDirectErrorKind): boolean {
  return kind === "not_connected"
    || kind === "sign_in_expired"
    || kind === "app_not_installed"
    || kind === "rights_not_accepted"
    || kind === "repo_not_reachable";
}
