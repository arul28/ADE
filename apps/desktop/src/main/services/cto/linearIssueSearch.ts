import type { Logger } from "../logging/logger";
import type {
  CtoCountLinearIssuesResult,
  CtoLinearCustomView,
  CtoLinearIssueCount,
  NormalizedLinearIssue,
} from "../../../shared/types";
import type {
  IssueTrackerIssueCountQuery,
  IssueTrackerIssueSearchQuery,
  IssueTrackerIssueSearchResult,
} from "./issueTracker";
import { isRecord, toOptionalString as asString, asArray, getErrorMessage } from "../shared/utils";
import {
  budgetIsLow,
  type IssueConnectionData,
  ISSUE_FIELDS_FRAGMENT,
  type LinearRateBudget,
  type LinearRequest,
  type LinearRequestMeter,
  normalizeIssueNodes,
  OPEN_ISSUE_STATE_TYPES,
  priorityIsValid,
} from "./linearClientShared";

export type LinearOpenIssueMatch = {
  id: string;
  identifier: string;
  title: string;
  url: string | null;
  stateName: string;
};

/**
 * Issue search, filters (including saved custom views), and counts. Counts are
 * cached for 60 s, share in-flight work, and are skipped when Linear's rate
 * budget runs low.
 */
export function createLinearIssueSearch(args: {
  request: LinearRequest;
  logger?: Logger | null;
  getRateBudget: () => LinearRateBudget | null;
}) {
  const { request } = args;

  const CUSTOM_VIEW_FILTER_TTL_MS = 60_000;
  const customViewFilterCache = new Map<string, { filter: Record<string, unknown>; fetchedAt: number }>();

  const fetchCustomViewFilter = async (viewId: string): Promise<Record<string, unknown>> => {
    const cached = customViewFilterCache.get(viewId);
    if (cached && Date.now() - cached.fetchedAt < CUSTOM_VIEW_FILTER_TTL_MS) return cached.filter;
    const data = await request<{ customView?: { filterData?: unknown; modelName?: string } }>({
      query: `
        query CustomViewFilter($id: String!) {
          customView(id: $id) { id modelName filterData }
        }
      `,
      variables: { id: viewId },
      maxRetries: 1,
    });
    const filter = data.customView?.filterData;
    if (!isRecord(filter)) throw new Error("This Linear view has no issue filter ADE can apply.");
    customViewFilterCache.set(viewId, { filter, fetchedAt: Date.now() });
    return filter;
  };

  // Every filter except the text query. The text query is either a full-text
  // `searchIssues` term or, as a fallback, a title/description clause.
  const buildIssueBaseFilter = (params: IssueTrackerIssueSearchQuery): Record<string, unknown> => {
    const filter: Record<string, unknown> = {};
    const projectId = params.projectId?.trim();
    const projectSlug = params.projectSlug?.trim();
    const teamKey = params.teamKey?.trim();
    const stateTypes = (params.stateTypes ?? []).map((entry) => entry.trim()).filter(Boolean);
    const stateIds = (params.stateIds ?? []).map((entry) => entry.trim()).filter(Boolean);
    const assigneeId = params.assigneeId?.trim();

    if (projectId) {
      filter.project = { id: { eq: projectId } };
    } else if (projectSlug) {
      filter.project = { slugId: { eq: projectSlug } };
    }
    if (teamKey) {
      filter.team = { key: { eq: teamKey } };
    }
    if (stateTypes.length > 0 || stateIds.length > 0) {
      filter.state = {
        ...(stateTypes.length > 0 ? { type: { in: stateTypes } } : {}),
        ...(stateIds.length > 0 ? { id: { in: stateIds } } : {}),
      };
    }
    if (assigneeId) {
      filter.assignee = { id: { eq: assigneeId } };
    } else if (params.assignedToViewer === true) {
      filter.assignee = { isMe: { eq: true } };
    }
    if (params.activeCycle === true) {
      filter.cycle = { isActive: { eq: true } };
    }
    if (priorityIsValid(params.priority)) {
      filter.priority = { eq: params.priority };
    }
    return filter;
  };

  const andFilters = (...filters: Array<Record<string, unknown> | null | undefined>): Record<string, unknown> => {
    const parts = filters.filter((entry): entry is Record<string, unknown> => entry != null && Object.keys(entry).length > 0);
    if (parts.length === 0) return {};
    if (parts.length === 1) return parts[0]!;
    return { and: parts };
  };

  const resolveIssueFilter = async (params: IssueTrackerIssueSearchQuery): Promise<Record<string, unknown>> => {
    const base = buildIssueBaseFilter(params);
    const viewId = params.customViewId?.trim();
    if (!viewId) return base;
    return andFilters(await fetchCustomViewFilter(viewId), base);
  };

  // Pre-full-text behavior, kept as the fallback when `searchIssues` errors.
  // Linear's IssueFilter has no `identifier` field, so a trailing number ("122"
  // or "VER-122") also matches on the issue number.
  const withLegacyTextFilter = (base: Record<string, unknown>, query: string): Record<string, unknown> => {
    const orClauses: Record<string, unknown>[] = [
      { title: { containsIgnoreCase: query } },
      { description: { containsIgnoreCase: query } },
    ];
    const numberMatch = query.match(/(\d+)\s*$/);
    if (numberMatch) {
      const parsedNumber = Number.parseInt(numberMatch[1]!, 10);
      if (Number.isFinite(parsedNumber)) orClauses.push({ number: { eq: parsedNumber } });
    }
    return "or" in base ? { and: [base, { or: orClauses }] } : { ...base, or: orClauses };
  };

  // "VER-404", "ver-404", "404", "#404" → a number (and team key) filter, so an
  // exact identifier always finds its issue even when full-text ranks it low.
  const identifierFilterForQuery = (query: string): Record<string, unknown> | null => {
    const keyed = query.match(/^([A-Za-z][A-Za-z0-9_]*)-(\d+)$/);
    const bare = query.match(/^#?(\d+)$/);
    const teamKey = keyed ? keyed[1]! : null;
    const numberText = keyed ? keyed[2]! : bare ? bare[1]! : null;
    if (!numberText) return null;
    const parsed = Number.parseInt(numberText, 10);
    if (!Number.isFinite(parsed)) return null;
    return {
      number: { eq: parsed },
      ...(teamKey ? { team: { key: { eqIgnoreCase: teamKey } } } : {}),
    };
  };
  const fetchIssuesWithFilter = async (params: {
    first: number;
    after: string | null;
    includeArchived: boolean;
    filter: Record<string, unknown>;
  }): Promise<IssueTrackerIssueSearchResult> => {
    const data = await request<{ issues?: IssueConnectionData }>({
      query: `
        query SearchIssues($first: Int!, $after: String, $includeArchived: Boolean!, $filter: IssueFilter) {
          issues(
            first: $first,
            after: $after,
            includeArchived: $includeArchived,
            orderBy: updatedAt,
            filter: $filter
          ) {
            pageInfo { hasNextPage endCursor }
            nodes {
              ${ISSUE_FIELDS_FRAGMENT}
            }
          }
        }
      `,
      variables: params,
      maxRetries: 2,
    });
    return {
      issues: normalizeIssueNodes(data.issues?.nodes),
      pageInfo: {
        hasNextPage: Boolean(data.issues?.pageInfo?.hasNextPage),
        endCursor: asString(data.issues?.pageInfo?.endCursor),
      },
    };
  };

  const fullTextSearchIssues = async (params: {
    term: string;
    first: number;
    after: string | null;
    includeArchived: boolean;
    filter: Record<string, unknown>;
  }): Promise<IssueTrackerIssueSearchResult> => {
    const identifierFilter = params.after ? null : identifierFilterForQuery(params.term);
    const [search, identifierMatches] = await Promise.all([
      request<{ searchIssues?: IssueConnectionData }>({
        query: `
          query SearchIssuesFullText($term: String!, $first: Int!, $after: String, $includeArchived: Boolean!, $filter: IssueFilter) {
            searchIssues(
              term: $term,
              first: $first,
              after: $after,
              includeArchived: $includeArchived,
              filter: $filter
            ) {
              totalCount
              pageInfo { hasNextPage endCursor }
              nodes {
                ${ISSUE_FIELDS_FRAGMENT}
              }
            }
          }
        `,
        variables: {
          term: params.term,
          first: params.first,
          after: params.after,
          includeArchived: params.includeArchived,
          filter: Object.keys(params.filter).length > 0 ? params.filter : null,
        },
        maxRetries: 1,
      }),
      identifierFilter
        ? fetchIssuesWithFilter({
          first: 10,
          after: null,
          includeArchived: params.includeArchived,
          filter: andFilters(params.filter, identifierFilter),
        }).then((result) => result.issues).catch(() => [] as NormalizedLinearIssue[])
        : Promise.resolve([] as NormalizedLinearIssue[]),
    ]);
    const searchIssuesFound = normalizeIssueNodes(search.searchIssues?.nodes);
    const seen = new Set<string>();
    const issues: NormalizedLinearIssue[] = [];
    for (const issue of [...identifierMatches, ...searchIssuesFound]) {
      if (seen.has(issue.id)) continue;
      seen.add(issue.id);
      issues.push(issue);
    }
    const totalCount = typeof search.searchIssues?.totalCount === "number" && Number.isFinite(search.searchIssues.totalCount)
      ? Math.max(search.searchIssues.totalCount, issues.length)
      : null;
    return {
      issues,
      pageInfo: {
        hasNextPage: Boolean(search.searchIssues?.pageInfo?.hasNextPage),
        endCursor: asString(search.searchIssues?.pageInfo?.endCursor),
      },
      totalCount,
    };
  };

  const searchIssues = async (params: IssueTrackerIssueSearchQuery): Promise<IssueTrackerIssueSearchResult> => {
    const first = Math.min(100, Math.max(1, Math.floor(params.first ?? 50)));
    const after = params.after?.trim() || null;
    const includeArchived = params.includeArchived === true;
    const baseFilter = await resolveIssueFilter(params);
    const term = params.query?.trim();
    if (term) {
      try {
        return await fullTextSearchIssues({ term, first, after, includeArchived, filter: baseFilter });
      } catch (error) {
        args.logger?.warn("linear.search_full_text_failed", { error: getErrorMessage(error) });
        // A cursor from `searchIssues` does not page `issues`; restart the fallback.
        return fetchIssuesWithFilter({
          first,
          after: null,
          includeArchived,
          filter: withLegacyTextFilter(baseFilter, term),
        });
      }
    }
    return fetchIssuesWithFilter({ first, after, includeArchived, filter: baseFilter });
  };

  const COUNT_PAGE_SIZE = 250;
  const COUNT_ALIAS_BATCH = 10;
  const DEFAULT_COUNT_CAP = 1000;
  const MAX_COUNT_CAP = 5000;
  const MAX_COUNT_KEYS = 100;

  type CountPage = { count: number; hasNextPage: boolean; endCursor: string | null };
  type PendingCount = { key: string; filter: Record<string, unknown>; after: string | null; count: number };

  const chunk = <T,>(items: T[], size: number): T[][] => {
    const out: T[][] = [];
    for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
    return out;
  };

  // One aliased request pages ids for up to COUNT_ALIAS_BATCH filters. If Linear
  // rejects the batch (one bad filter fails the whole document), retry each
  // filter alone so one bad key cannot blank every count.
  const fetchCountPages = async (
    items: PendingCount[],
    pageSize = COUNT_PAGE_SIZE,
    meter?: LinearRequestMeter,
  ): Promise<Map<string, CountPage | null>> => {
    const out = new Map<string, CountPage | null>();
    const variableDefs: string[] = [];
    const fields: string[] = [];
    const variables: Record<string, unknown> = {};
    items.forEach((item, index) => {
      variableDefs.push(`$f${index}: IssueFilter`, `$a${index}: String`);
      fields.push(`k${index}: issues(first: ${pageSize}, after: $a${index}, includeArchived: false, filter: $f${index}) { nodes { id } pageInfo { hasNextPage endCursor } }`);
      variables[`f${index}`] = Object.keys(item.filter).length > 0 ? item.filter : null;
      variables[`a${index}`] = item.after;
    });
    try {
      const data = await request<Record<string, IssueConnectionData | undefined>>({
        query: `query CountIssues(${variableDefs.join(", ")}) { ${fields.join("\n")} }`,
        variables,
        maxRetries: 2,
        meter,
      });
      items.forEach((item, index) => {
        const connection = data[`k${index}`];
        out.set(item.key, connection
          ? {
            count: asArray(connection.nodes).length,
            hasNextPage: Boolean(connection.pageInfo?.hasNextPage),
            endCursor: asString(connection.pageInfo?.endCursor),
          }
          : null);
      });
    } catch (error) {
      if (items.length === 1) {
        args.logger?.warn("linear.count_issues_failed", { key: items[0]!.key, error: getErrorMessage(error) });
        out.set(items[0]!.key, null);
        return out;
      }
      const singles = await Promise.all(items.map((item) => fetchCountPages([item], pageSize, meter)));
      for (const single of singles) for (const [key, value] of single) out.set(key, value);
    }
    return out;
  };

  const countSearchTerms = async (
    items: Array<{ key: string; term: string; filter: Record<string, unknown> }>,
    meter?: LinearRequestMeter,
  ): Promise<Map<string, number | null>> => {
    const out = new Map<string, number | null>();
    const variableDefs: string[] = [];
    const fields: string[] = [];
    const variables: Record<string, unknown> = {};
    items.forEach((item, index) => {
      variableDefs.push(`$t${index}: String!`, `$f${index}: IssueFilter`);
      fields.push(`k${index}: searchIssues(term: $t${index}, first: 1, includeArchived: false, filter: $f${index}) { totalCount }`);
      variables[`t${index}`] = item.term;
      variables[`f${index}`] = Object.keys(item.filter).length > 0 ? item.filter : null;
    });
    try {
      const data = await request<Record<string, { totalCount?: number } | undefined>>({
        query: `query CountSearchIssues(${variableDefs.join(", ")}) { ${fields.join("\n")} }`,
        variables,
        maxRetries: 1,
        meter,
      });
      items.forEach((item, index) => {
        const total = data[`k${index}`]?.totalCount;
        out.set(item.key, typeof total === "number" && Number.isFinite(total) ? total : null);
      });
    } catch (error) {
      if (items.length === 1) {
        out.set(items[0]!.key, null);
        return out;
      }
      const singles = await Promise.all(items.map((item) => countSearchTerms([item], meter)));
      for (const single of singles) for (const [key, value] of single) out.set(key, value);
    }
    return out;
  };

  // Counts change slowly and every pane open asks for the same ones, so each
  // (filter, cap) answer is reused for a short time, and a count already in
  // flight is shared instead of paged again.
  const COUNT_CACHE_TTL_MS = 60_000;
  const COUNT_CACHE_MAX = 500;
  const countCache = new Map<string, { value: CtoLinearIssueCount | null; at: number }>();
  const countInFlight = new Map<string, Promise<CtoLinearIssueCount | null>>();

  const countIssues = async (params: IssueTrackerIssueCountQuery): Promise<CtoCountLinearIssuesResult> => {
    const cap = Math.min(MAX_COUNT_CAP, Math.max(1, Math.floor(params.cap ?? DEFAULT_COUNT_CAP)));
    const entries = Object.entries(isRecord(params.queries) ? params.queries : {}).slice(0, MAX_COUNT_KEYS);
    const counts: CtoCountLinearIssuesResult["counts"] = {};
    const now = Date.now();
    const misses: Array<[string, IssueTrackerIssueSearchQuery, string]> = [];
    const waits: Array<Promise<void>> = [];
    for (const [key, query] of entries) {
      const cacheKey = JSON.stringify([query, cap]);
      const cached = countCache.get(cacheKey);
      if (cached && now - cached.at < COUNT_CACHE_TTL_MS) {
        counts[key] = cached.value;
        continue;
      }
      const inFlight = countInFlight.get(cacheKey);
      if (inFlight) {
        waits.push(inFlight.then((value) => { counts[key] = value; }, () => { counts[key] = null; }));
        continue;
      }
      misses.push([key, query, cacheKey]);
    }

    if (misses.length > 0 && budgetIsLow(args.getRateBudget())) {
      args.logger?.warn("linear.count_issues_skipped_low_budget", { keys: misses.length, budget: args.getRateBudget() });
      for (const [key] of misses) counts[key] = null;
      misses.length = 0;
    }

    if (misses.length > 0) {
      const meter: LinearRequestMeter = { requests: 0, complexity: 0 };
      const startedAt = Date.now();
      const run = countIssuesUncached(Object.fromEntries(misses.map(([key, query]) => [key, query])), cap, meter);
      for (const [key, , cacheKey] of misses) {
        const one = run.then((result) => result[key] ?? null);
        countInFlight.set(cacheKey, one);
        waits.push(one.then(
          (value) => {
            counts[key] = value;
            if (value) countCache.set(cacheKey, { value, at: Date.now() });
          },
          () => { counts[key] = null; },
        ).finally(() => countInFlight.delete(cacheKey)));
      }
      waits.push(run.then(() => {
        args.logger?.info("linear.count_issues", {
          keys: misses.length,
          cap,
          requests: meter.requests,
          complexity: meter.complexity,
          durationMs: Date.now() - startedAt,
          budget: args.getRateBudget(),
        });
      }, () => {}));
    }

    await Promise.all(waits);
    while (countCache.size > COUNT_CACHE_MAX) {
      const oldest = countCache.keys().next().value;
      if (oldest === undefined) break;
      countCache.delete(oldest);
    }
    return { counts };
  };

  const countIssuesUncached = async (
    queries: Record<string, IssueTrackerIssueSearchQuery>,
    cap: number,
    meter: LinearRequestMeter,
  ): Promise<CtoCountLinearIssuesResult["counts"]> => {
    const counts: CtoCountLinearIssuesResult["counts"] = {};
    const entries = Object.entries(queries);
    const termItems: Array<{ key: string; term: string; filter: Record<string, unknown> }> = [];
    const pending: PendingCount[] = [];

    await Promise.all(entries.map(async ([key, query]) => {
      try {
        const filter = await resolveIssueFilter(isRecord(query) ? query : {});
        const term = isRecord(query) ? query.query?.trim() : null;
        if (term) termItems.push({ key, term, filter });
        else pending.push({ key, filter, after: null, count: 0 });
      } catch (error) {
        args.logger?.warn("linear.count_issues_filter_failed", { key, error: getErrorMessage(error) });
        counts[key] = null;
      }
    }));

    // A search term is counted by Linear's search index (exact, one request).
    // When search is unavailable, count the fallback title/description filter.
    for (const batch of chunk(termItems, COUNT_ALIAS_BATCH)) {
      const totals = await countSearchTerms(batch, meter);
      for (const item of batch) {
        const total = totals.get(item.key);
        if (typeof total === "number") counts[item.key] = { count: total, capped: false };
        else pending.push({ key: item.key, filter: withLegacyTextFilter(item.filter, item.term), after: null, count: 0 });
      }
    }

    // Linear connections have no total, so page ids (250 per request, batched
    // across keys) until each key runs out or reaches the cap.
    let active = pending;
    while (active.length > 0) {
      const next: PendingCount[] = [];
      const pages = await Promise.all(chunk(active, COUNT_ALIAS_BATCH).map((batch) => fetchCountPages(batch, COUNT_PAGE_SIZE, meter)));
      const merged = new Map<string, CountPage | null>();
      for (const page of pages) for (const [key, value] of page) merged.set(key, value);
      for (const item of active) {
        const page = merged.get(item.key);
        if (!page) {
          counts[item.key] = null;
          continue;
        }
        item.count += page.count;
        if (page.hasNextPage && page.endCursor && item.count < cap) {
          item.after = page.endCursor;
          next.push(item);
        } else {
          counts[item.key] = { count: item.count, capped: page.hasNextPage };
        }
      }
      active = next;
    }
    return counts;
  };

  const listCustomViews = async (): Promise<CtoLinearCustomView[]> => {
    const data = await request<{ customViews?: { nodes?: Array<Record<string, unknown>> } }>({
      query: `
        query CustomViews {
          customViews(first: 50) {
            nodes {
              id
              name
              description
              icon
              color
              shared
              modelName
              filterData
              team { key }
            }
          }
        }
      `,
      maxRetries: 2,
    });
    const candidates = asArray(data.customViews?.nodes)
      .filter(isRecord)
      .filter((node) => asString(node.modelName) === "Issue" && isRecord(node.filterData) && Object.keys(node.filterData).length > 0)
      .map((node) => {
        const id = asString(node.id);
        const name = asString(node.name);
        if (!id || !name) return null;
        const team = isRecord(node.team) ? node.team : null;
        customViewFilterCache.set(id, { filter: node.filterData as Record<string, unknown>, fetchedAt: Date.now() });
        return {
          view: {
            id,
            name,
            description: asString(node.description),
            icon: asString(node.icon),
            color: asString(node.color),
            teamKey: team ? asString(team.key) : null,
            shared: node.shared === true,
          } satisfies CtoLinearCustomView,
          filter: node.filterData as Record<string, unknown>,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry != null);
    if (candidates.length === 0) return [];

    // Skip views whose saved filter the public API rejects (some view filters
    // use fields only Linear's own client understands). One probe per view,
    // batched; a rejected batch falls back to per-view probes.
    const probes = await fetchCountPages(candidates.map((entry) => ({
      key: entry.view.id,
      filter: entry.filter,
      after: null,
      count: 0,
    })).slice(0, COUNT_ALIAS_BATCH * 3), 1).catch(() => new Map<string, CountPage | null>());
    return candidates
      // Drop only views Linear rejected (probe = null); keep views not probed.
      .filter((entry) => !probes.has(entry.view.id) || probes.get(entry.view.id) != null)
      .map((entry) => entry.view)
      .sort((left, right) => left.name.localeCompare(right.name));
  };

  // A direct title filter, not full-text search: it sees issues filed seconds
  // ago, which the search index has not caught up with yet.
  const findOpenIssuesByTitle = async (title: string, teamKey: string): Promise<LinearOpenIssueMatch[]> => {
    const data = await request<{
      issues?: { nodes?: Array<{ id: string; identifier: string; title: string; url: string | null; state?: { name?: string } }> };
    }>({
      query: `query RecentSimilarIssues($title: String!, $team: String!, $states: [String!]) {
        issues(first: 10, filter: { title: { containsIgnoreCase: $title }, team: { key: { eqIgnoreCase: $team } }, state: { type: { in: $states } } }) {
          nodes { id identifier title url state { name } }
        }
      }`,
      variables: { title: title.trim().slice(0, 80), team: teamKey, states: OPEN_ISSUE_STATE_TYPES },
    });
    return (data.issues?.nodes ?? []).map((node) => ({
      id: node.id,
      identifier: node.identifier,
      title: node.title,
      url: node.url,
      stateName: node.state?.name ?? "",
    }));
  };

  return {
    searchIssues,
    countIssues,
    listCustomViews,
    findOpenIssuesByTitle,
  };
}
