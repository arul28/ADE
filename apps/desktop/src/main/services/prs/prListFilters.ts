/**
 * GitHub tab filters and PR assignees.
 *
 * - `listFilterOptions`: the repository's labels, assignable users (assignee
 *   picker) or mentionable users (author picker), searched by GitHub so a repo
 *   with hundreds of labels or contributors is still reachable.
 * - `searchGitHubPrs`: the tab's list when a label / author / assignee filter
 *   is on. GraphQL `search(type: ISSUE)`, not REST `/search/issues`: the REST
 *   hit is an issue shape with no head/base branch (rows could not show their
 *   branch or open as a lane), and GraphQL returns every row field in one
 *   request at one point of the GraphQL budget instead of the 30/min search
 *   bucket.
 * - `setAssignees`: add/remove people through the issue assignees endpoints
 *   (a PR is an issue for assignees), serialized per PR.
 *
 * All three are user-initiated reads/writes: nothing here runs on a timer.
 * Reads are cached briefly and single-flight; failures are not cached.
 */
import type {
  GitHubPrFilterKind,
  GitHubPrFilterOption,
  GitHubPrListItem,
  GitHubRepoRef,
  ListGitHubPrFilterOptionsArgs,
  ListGitHubPrFilterOptionsResult,
  PrUser,
  SearchGitHubPrsArgs,
  SearchGitHubPrsResult,
  SetPrAssigneesArgs,
  SetPrAssigneesResult,
} from "../../../shared/types";
import {
  buildGitHubPrSearchQuery,
  normalizeGitHubLogin,
  normalizeGitHubPrListFilters,
} from "../../../shared/githubPrSearch";
import { githubAuthFailureKindOf, GitHubRateLimitError } from "../github/githubRateLimit";
import type { createGithubService } from "../github/githubService";
import type { Logger } from "../logging/logger";
import { createKeyedPromiseCache } from "../../../shared/expiringPromiseCache";
import { githubRepoKey } from "./prGithubReadCache";

const FILTER_OPTIONS_TTL_MS = 5 * 60_000;
const SEARCH_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 100;
const LABEL_PAGE = 100;
const PEOPLE_PAGE = 50;
const SEARCH_PAGE = 50;
/** GitHub accepts at most 10 assignees per request (and per issue). */
const MAX_ASSIGNEES = 10;

type GraphqlRequest = <T>(
  query: string,
  variables: Record<string, unknown>,
  options?: { repo?: GitHubRepoRef; capability?: "read" | "write" },
) => Promise<T>;

/** What the PR service resolves a PR id to; only the coordinates are read here. */
type PrTarget = { repo: GitHubRepoRef; prNumber: number };

export type PrListFilterDeps<TTarget extends PrTarget> = {
  githubService: Pick<ReturnType<typeof createGithubService>, "apiRequest" | "getStatus">;
  graphqlRequest: GraphqlRequest;
  logger: Logger;
  /** The same row builder the snapshot uses, so linked lane context still shows. */
  buildItems: (rawPulls: unknown[], repo: GitHubRepoRef) => Promise<GitHubPrListItem[]>;
  resolvePrTarget: (prId: string) => TTarget;
  refreshAfterMutation: (target: TTarget) => Promise<void>;
};

const asString = (value: unknown): string => (typeof value === "string" ? value : "");

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function httpStatusOf(error: unknown): number | null {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}

const SEARCH_PR_FIELDS = `
  __typename
  ... on PullRequest {
    id number title url state isDraft merged mergedAt createdAt updatedAt
    baseRefName headRefName
    headRepositoryOwner { login }
    headRepository { name }
    repository { name owner { login } }
    author { __typename login }
    labels(first: 20) { nodes { name color description } }
    comments { totalCount }
  }
`;

/**
 * GraphQL PR node -> the REST pull shape the snapshot's row builder reads.
 * Only fields that builder uses are filled.
 */
function graphqlPullToRestShape(node: Record<string, any>): Record<string, unknown> {
  const owner = asString(node.repository?.owner?.login);
  const name = asString(node.repository?.name);
  const headOwner = asString(node.headRepositoryOwner?.login);
  const headName = asString(node.headRepository?.name);
  const authorLogin = asString(node.author?.login);
  const isBot = node.author?.__typename === "Bot";
  return {
    node_id: asString(node.id),
    number: Number(node.number) || 0,
    html_url: asString(node.url),
    title: asString(node.title),
    state: asString(node.state).toLowerCase() === "open" ? "open" : "closed",
    draft: node.isDraft === true,
    merged: node.merged === true,
    merged_at: node.mergedAt ?? null,
    created_at: asString(node.createdAt),
    updated_at: asString(node.updatedAt),
    base: { ref: asString(node.baseRefName), repo: { name, owner: { login: owner } } },
    head: {
      ref: asString(node.headRefName),
      // A deleted fork has no head repository; the row then shows no fork owner.
      repo: headOwner || headName ? { name: headName, owner: { login: headOwner } } : null,
    },
    // GraphQL prints an app as `dependabot`; REST (and the snapshot) as `dependabot[bot]`.
    user: authorLogin ? { login: isBot ? `${authorLogin}[bot]` : authorLogin, type: isBot ? "Bot" : "User" } : null,
    labels: Array.isArray(node.labels?.nodes) ? node.labels.nodes : [],
    comments: Number(node.comments?.totalCount) || 0,
  };
}

function toPrUser(raw: any): PrUser | null {
  const login = asString(raw?.login);
  if (!login) return null;
  return {
    login,
    avatarUrl: asString(raw?.avatar_url) || null,
    isBot: asString(raw?.type).toLowerCase() === "bot",
  };
}

/** A plain sentence for a refused assignee change. */
export function describeAssigneeFailure(error: unknown): string {
  const status = httpStatusOf(error);
  const kind = githubAuthFailureKindOf(error);
  if (kind === "rate_limited") return "GitHub is rate limiting this account. Try again in a few minutes.";
  if (status === 403 || kind === "permission_denied") {
    return "This GitHub account cannot assign people here. Assigning needs triage access to the repository.";
  }
  if (status === 404) return "GitHub could not find this pull request, or this account cannot see it.";
  if (status === 422) return "GitHub would not assign that person. They may not have access to this repository.";
  if (status != null && status >= 500) return "GitHub is having trouble right now. Try again in a moment.";
  return errorMessage(error) || "GitHub did not change the assignees.";
}

export function createPrListFilterOps<TTarget extends PrTarget>(deps: PrListFilterDeps<TTarget>) {
  const { githubService, graphqlRequest, logger } = deps;
  const optionsCache = createKeyedPromiseCache<ListGitHubPrFilterOptionsResult>({ ttlMs: FILTER_OPTIONS_TTL_MS, maxEntries: CACHE_MAX_ENTRIES });
  const searchCache = createKeyedPromiseCache<{ raw: unknown[]; totalCount: number; nextCursor: string | null }>({ ttlMs: SEARCH_TTL_MS, maxEntries: CACHE_MAX_ENTRIES });
  /** One assignee change at a time per PR, so two quick clicks cannot interleave. */
  const assigneeChains = new Map<string, Promise<unknown>>();

  const resolveRepo = async (args: { repoOwner?: string | null; repoName?: string | null }): Promise<GitHubRepoRef> => {
    const owner = asString(args.repoOwner).trim();
    const name = asString(args.repoName).trim();
    if (owner && name) return { owner, name };
    const status = await githubService.getStatus();
    if (!status.repo) throw new Error("No GitHub repository is configured for this project.");
    return status.repo;
  };

  const fetchFilterOptions = async (
    repo: GitHubRepoRef,
    kind: GitHubPrFilterKind,
    query: string,
  ): Promise<ListGitHubPrFilterOptionsResult> => {
    const variables = { owner: repo.owner, name: repo.name, q: query || null };
    if (kind === "label") {
      const data = await graphqlRequest<{ repository?: { labels?: { pageInfo?: { hasNextPage?: boolean }; nodes?: any[] } } | null }>(
        `query($owner:String!,$name:String!,$q:String){ repository(owner:$owner,name:$name){ labels(first:${LABEL_PAGE},query:$q,orderBy:{field:NAME,direction:ASC}){ pageInfo{ hasNextPage } nodes{ name color description } } } }`,
        variables,
        { repo },
      );
      const connection = data.repository?.labels;
      const options: GitHubPrFilterOption[] = (connection?.nodes ?? [])
        .filter((node) => asString(node?.name))
        .map((node) => ({
          value: asString(node.name),
          color: asString(node.color) || null,
          description: asString(node.description) || null,
        }));
      return { kind, query, options, complete: connection?.pageInfo?.hasNextPage !== true };
    }
    // Assignee: only people GitHub will accept. Author: anyone who took part in
    // the repo, because fork contributors author PRs but are not assignable.
    const field = kind === "assignee" ? "assignableUsers" : "mentionableUsers";
    const data = await graphqlRequest<{ repository?: Record<string, { pageInfo?: { hasNextPage?: boolean }; nodes?: any[] }> | null }>(
      `query($owner:String!,$name:String!,$q:String){ repository(owner:$owner,name:$name){ ${field}(first:${PEOPLE_PAGE},query:$q){ pageInfo{ hasNextPage } nodes{ login avatarUrl name } } } }`,
      variables,
      { repo },
    );
    const connection = data.repository?.[field];
    const options: GitHubPrFilterOption[] = (connection?.nodes ?? [])
      .filter((node) => asString(node?.login))
      .map((node) => ({
        value: asString(node.login),
        avatarUrl: asString(node.avatarUrl) || null,
        name: asString(node.name) || null,
      }));
    return { kind, query, options, complete: connection?.pageInfo?.hasNextPage !== true };
  };

  const listFilterOptions = async (args: ListGitHubPrFilterOptionsArgs): Promise<ListGitHubPrFilterOptionsResult> => {
    const kind: GitHubPrFilterKind = args?.kind === "author" || args?.kind === "assignee" ? args.kind : "label";
    const query = asString(args?.query).trim().slice(0, 100);
    const repo = await resolveRepo(args ?? {});
    return optionsCache.read(
      `${githubRepoKey(repo)}|${kind}|${query.toLowerCase()}`,
      () => fetchFilterOptions(repo, kind, query),
    );
  };

  const runSearch = async (q: string, cursor: string | null, repo: GitHubRepoRef) => {
    const data = await graphqlRequest<{
      search?: { issueCount?: number; pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }; nodes?: any[] };
    }>(
      `query($q:String!,$first:Int!,$after:String){ search(query:$q,type:ISSUE,first:$first,after:$after){ issueCount pageInfo{ hasNextPage endCursor } nodes{ ${SEARCH_PR_FIELDS} } } }`,
      { q, first: SEARCH_PAGE, after: cursor },
      { repo },
    );
    const nodes = (data.search?.nodes ?? []).filter((node) => node?.__typename === "PullRequest");
    return {
      raw: nodes.map(graphqlPullToRestShape),
      totalCount: Number(data.search?.issueCount) || 0,
      nextCursor: data.search?.pageInfo?.hasNextPage ? asString(data.search.pageInfo.endCursor) || null : null,
    };
  };

  const searchGitHubPrs = async (args: SearchGitHubPrsArgs): Promise<SearchGitHubPrsResult> => {
    const state = args?.state === "closed" || args?.state === "merged" || args?.state === "all" ? args.state : "open";
    const filters = normalizeGitHubPrListFilters(args?.filters);
    const cursor = asString(args?.cursor).trim() || null;
    let repo: GitHubRepoRef;
    try {
      repo = await resolveRepo(args ?? {});
    } catch (error) {
      return { items: [], totalCount: 0, nextCursor: null, query: "", error: { kind: "failed", message: errorMessage(error) } };
    }
    const { q, unquotableLabels } = buildGitHubPrSearchQuery({
      repoOwner: repo.owner,
      repoName: repo.name,
      state,
      filters,
      text: args?.text,
    });
    const cacheKey = `${q}|${cursor ?? ""}`;
    if (args?.force === true) searchCache.delete(cacheKey);
    try {
      const page = await searchCache.read(cacheKey, () => runSearch(q, cursor, repo));
      const ownRepo = githubRepoKey(repo);
      const items = (await deps.buildItems(page.raw, repo))
        // Defence in depth: the query is scoped to this repo, and so is the list.
        .filter((item) => `${item.repoOwner.toLowerCase()}/${item.repoName.toLowerCase()}` === ownRepo)
        .filter((item) => unquotableLabels.every((label) => item.labels.some((entry) => entry.name === label)));
      return { items, totalCount: page.totalCount, nextCursor: page.nextCursor, query: q, error: null };
    } catch (error) {
      const rateLimited = githubAuthFailureKindOf(error) === "rate_limited";
      const resetAtMs = error instanceof GitHubRateLimitError ? error.rateLimitResetAtMs : null;
      logger.warn("prs.github_search_failed", { query: q, rateLimited, error: errorMessage(error) });
      return {
        items: [],
        totalCount: 0,
        nextCursor: null,
        query: q,
        error: {
          kind: rateLimited ? "rate_limited" : "failed",
          message: rateLimited ? "GitHub search is rate limited right now." : errorMessage(error),
          retryAt: resetAtMs != null ? new Date(resetAtMs).toISOString() : null,
        },
      };
    }
  };

  const normalizeLogins = (values: unknown): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const value of Array.isArray(values) ? values : []) {
      const login = normalizeGitHubLogin(value);
      if (!login || seen.has(login.toLowerCase())) continue;
      seen.add(login.toLowerCase());
      out.push(login);
    }
    return out.slice(0, MAX_ASSIGNEES);
  };

  const applyAssignees = async (args: SetPrAssigneesArgs): Promise<SetPrAssigneesResult> => {
    const target = deps.resolvePrTarget(args.prId);
    const add = normalizeLogins(args.add);
    const addKeys = new Set(add.map((login) => login.toLowerCase()));
    // Adding wins over removing the same person in one call.
    const remove = normalizeLogins(args.remove).filter((login) => !addKeys.has(login.toLowerCase()));
    if (add.length === 0 && remove.length === 0) throw new Error("Choose at least one person to assign or unassign.");
    const path = `/repos/${encodeURIComponent(target.repo.owner)}/${encodeURIComponent(target.repo.name)}/issues/${target.prNumber}/assignees`;
    let latest: any = null;
    try {
      if (remove.length > 0) {
        ({ data: latest } = await githubService.apiRequest<any>({ method: "DELETE", path, body: { assignees: remove }, repo: target.repo }));
      }
      if (add.length > 0) {
        ({ data: latest } = await githubService.apiRequest<any>({ method: "POST", path, body: { assignees: add }, repo: target.repo }));
      }
    } catch (error) {
      logger.warn("prs.set_assignees_failed", {
        repo: githubRepoKey(target.repo),
        prNumber: target.prNumber,
        status: httpStatusOf(error),
        error: errorMessage(error),
      });
      throw new Error(describeAssigneeFailure(error));
    }
    const assignees = (Array.isArray(latest?.assignees) ? latest.assignees : [])
      .map(toPrUser)
      .filter((user: PrUser | null): user is PrUser => user !== null);
    const assigned = new Set(assignees.map((user: PrUser) => user.login.toLowerCase()));
    // GitHub answers 201 and quietly drops a person it cannot assign.
    const notAssigned = add.filter((login) => !assigned.has(login.toLowerCase()));
    searchCache.clear();
    await deps.refreshAfterMutation(target).catch((error) => {
      logger.warn("prs.set_assignees_refresh_failed", { error: errorMessage(error) });
    });
    return { assignees, notAssigned };
  };

  const setAssignees = (args: SetPrAssigneesArgs): Promise<SetPrAssigneesResult> => {
    let key: string;
    try {
      const target = deps.resolvePrTarget(args?.prId);
      key = `${githubRepoKey(target.repo)}#${target.prNumber}`;
    } catch (error) {
      return Promise.reject(error);
    }
    const previous = assigneeChains.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => applyAssignees(args));
    assigneeChains.set(key, next);
    void next.catch(() => undefined).then(() => {
      if (assigneeChains.get(key) === next) assigneeChains.delete(key);
    });
    return next;
  };

  return {
    listFilterOptions,
    searchGitHubPrs,
    setAssignees,
    /** Drop cached search pages (a PR mutation changed what they would show). */
    invalidateSearchCache: () => searchCache.clear(),
  };
}
