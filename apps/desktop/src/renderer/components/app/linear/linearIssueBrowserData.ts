import { useEffect, useMemo, useState } from "react";
import type {
  CtoCountLinearIssuesResult,
  CtoGetLinearIssuePickerDataResult,
  CtoLinearCustomView,
  CtoLinearQuickView,
  CtoSearchLinearIssuesArgs,
  CtoSearchLinearIssuesResult,
  LinearIssueOrdering,
  NormalizedLinearIssue,
  OpenProjectBinding,
} from "../../../../shared/types";
import { isClosedLinearStateType, LINEAR_STATE_TYPE_ORDER } from "../../../../shared/linearIssueNormalize";
import {
  LINEAR_SCOPE_ACTIVE_CYCLE,
  LINEAR_SCOPE_ALL,
  LINEAR_SCOPE_MINE,
  LINEAR_SCOPE_PREFIX,
  linearScopeSearchArgs,
  parseLinearScope,
  type LinearScope,
} from "./linearScope";

/**
 * The Linear window's data layer: the per-project module cache, the search
 * arguments and their cache keys, what the window remembers in localStorage,
 * and live counts. No React state of the browser lives here.
 */

/**
 * `scope` is the rail entry as a string (see `linearScope.ts`). A project pick
 * and a scope are mutually exclusive in the rail. The order of the list is the
 * Display menu's (Linear's own view preferences), not a filter.
 */
export type LinearIssueBrowserFilters = {
  scope: string;
  projectId: string;
  statePreset: "active" | "all" | string;
  assigneeId: string;
  priority: string;
  query: string;
};

export const DEFAULT_FILTERS: LinearIssueBrowserFilters = {
  scope: LINEAR_SCOPE_ALL,
  projectId: "",
  statePreset: "all",
  assigneeId: "",
  priority: "",
  query: "",
};

// Linear's "Active" tab: started and not-started work; Backlog has its own tab.
const ACTIVE_LINEAR_STATE_TYPES = ["unstarted", "started"];
const OPEN_LINEAR_STATE_TYPES: string[] = LINEAR_STATE_TYPE_ORDER.filter((type) => !isClosedLinearStateType(type));
const FILTER_STORAGE_PREFIX = "ade.linear.quickView.filters.v1:";
const SELECTION_STORAGE_PREFIX = "ade.linear.quickView.selection.v1:";
const SELECTION_STORAGE_MAX = 100;
const DETAIL_PANE_STORAGE_KEY = "ade.linear.quickView.detailPane.v1";
const LINEAR_BROWSER_CACHE_STALE_MS = 90_000;
const LINEAR_BROWSER_CACHE_MAX_SEARCHES = 16;
const LINEAR_BROWSER_CACHE_MAX_COUNTS = 12;
export const LINEAR_BROWSER_CACHE_MAX_DETAILS = 60;
// 100 is the Linear API ceiling (linearClient clamps `first` to 100), so it is
// both the largest first page we can fetch and the chunk size each
// infinite-scroll page pulls.
const ISSUE_PAGE_SIZE = 100;

type TimedCacheEntry<T, P = T> = {
  result: T | null;
  fetchedAt: number;
  promise: Promise<P> | null;
};

export type LinearIssueBrowserCacheEntry = {
  quickView: CtoLinearQuickView | null;
  quickViewFetchedAt: number;
  quickViewPromise: Promise<CtoLinearQuickView> | null;
  catalog: CtoGetLinearIssuePickerDataResult | null;
  catalogFetchedAt: number;
  catalogPromise: Promise<CtoGetLinearIssuePickerDataResult> | null;
  views: TimedCacheEntry<CtoLinearCustomView[]>;
  searches: Map<string, TimedCacheEntry<CtoSearchLinearIssuesResult>>;
  counts: Map<string, TimedCacheEntry<CtoCountLinearIssuesResult>>;
  details: Map<string, { issue: NormalizedLinearIssue; fetchedAt: number }>;
};

const linearIssueBrowserCache = new Map<string, LinearIssueBrowserCacheEntry>();

/**
 * Every issue this window already read in the browser, for the create form's
 * "similar issues" hint. Reads memory only; never a request.
 */
export function cachedLinearBrowserIssues(): NormalizedLinearIssue[] {
  const byId = new Map<string, NormalizedLinearIssue>();
  for (const entry of linearIssueBrowserCache.values()) {
    for (const search of entry.searches.values()) {
      for (const issue of search.result?.issues ?? []) byId.set(issue.id, issue);
    }
    for (const detail of entry.details.values()) byId.set(detail.issue.id, detail.issue);
  }
  return [...byId.values()];
}

const ctoCacheScopes = new WeakMap<object, number>();
let nextCtoCacheScope = 1;

/** A different bridge object (tests, a reconnected web client) gets its own cache entries. */
export function getCtoCacheScope(cto: unknown): string {
  if (!cto || (typeof cto !== "object" && typeof cto !== "function")) return "none";
  const target = cto as object;
  const current = ctoCacheScopes.get(target);
  if (current) return String(current);
  const next = nextCtoCacheScope++;
  ctoCacheScopes.set(target, next);
  return String(next);
}

/** One cache per project, Linear reader machine and bridge object. */
export function browserCacheKey(projectRoot: string | null | undefined, readerKey: string | null): string {
  const root = projectRoot?.trim() || "__project__";
  const cto = typeof window === "undefined" ? null : window.ade?.cto;
  return `${root}::reader:${readerKey ?? "none"}::cto:${getCtoCacheScope(cto)}`;
}

export function emptyCatalog(): CtoGetLinearIssuePickerDataResult {
  return { projects: [], users: [], states: [], labels: [] };
}

export function emptyPageInfo(): CtoSearchLinearIssuesResult["pageInfo"] {
  return { hasNextPage: false, endCursor: null };
}

export function getBrowserCacheEntry(key: string): LinearIssueBrowserCacheEntry {
  const existing = linearIssueBrowserCache.get(key);
  if (existing) return existing;
  const next: LinearIssueBrowserCacheEntry = {
    quickView: null,
    quickViewFetchedAt: 0,
    quickViewPromise: null,
    catalog: null,
    catalogFetchedAt: 0,
    catalogPromise: null,
    views: { result: null, fetchedAt: 0, promise: null },
    searches: new Map(),
    counts: new Map(),
    details: new Map(),
  };
  linearIssueBrowserCache.set(key, next);
  return next;
}

export function cacheIsFresh(fetchedAt: number): boolean {
  return fetchedAt > 0 && Date.now() - fetchedAt < LINEAR_BROWSER_CACHE_STALE_MS;
}

export function trimMap<K, V>(map: Map<K, V>, max: number): void {
  while (map.size > max) {
    const oldestKey = map.keys().next().value as K | undefined;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
  }
}

/** The rail entry the filters point at: a project pick wins over the scope. */
export function activeLinearScope(filters: Pick<LinearIssueBrowserFilters, "scope" | "projectId">): LinearScope {
  return filters.projectId ? { kind: "project", id: filters.projectId } : parseLinearScope(filters.scope);
}

/**
 * State types to ask Linear for. With "Show completed issues" off, closed
 * types are left out on the server, so pages and counts hold open work only.
 */
export function stateTypesFor(preset: string, showCompletedIssues: boolean): string[] {
  const base = preset === "all" ? [] : preset === "active" ? ACTIVE_LINEAR_STATE_TYPES : preset ? [preset] : [];
  return applyCompletedFilter(base, showCompletedIssues);
}

function applyCompletedFilter(stateTypes: string[], showCompletedIssues: boolean): string[] {
  if (showCompletedIssues) return stateTypes;
  if (stateTypes.length === 0) return OPEN_LINEAR_STATE_TYPES;
  const open = stateTypes.filter((type) => !isClosedLinearStateType(type));
  // An empty list means "every state" to the brain. A scope that asks only for
  // closed types asked for them on purpose, so it keeps them.
  return open.length > 0 ? open : stateTypes;
}

export type ServerOrder = { ordering: LinearIssueOrdering; direction: "asc" | "desc" } | null;

export function buildIssueSearchArgs(
  filters: LinearIssueBrowserFilters,
  after: string | null,
  options: { order?: ServerOrder; showCompletedIssues?: boolean } = {},
): CtoSearchLinearIssuesArgs {
  const showCompletedIssues = options.showCompletedIssues ?? true;
  const order = options.order ?? null;
  const scopeArgs = linearScopeSearchArgs(activeLinearScope(filters));
  const stateTypes = applyCompletedFilter(scopeArgs.stateTypes ?? stateTypesFor(filters.statePreset, true), showCompletedIssues);
  return {
    // Pages arrive in the Display order, so the first page holds the top of the list.
    ...(order ? { ordering: order.ordering, orderingDirection: order.direction } : {}),
    projectId: null,
    assigneeId: filters.assigneeId || null,
    priority: filters.priority ? Number(filters.priority) : null,
    query: filters.query.trim() || null,
    first: ISSUE_PAGE_SIZE,
    after,
    includeArchived: false,
    ...scopeArgs,
    stateTypes,
  };
}

export function searchCacheKey(args: CtoSearchLinearIssuesArgs): string {
  return JSON.stringify({
    projectId: args.projectId ?? null,
    stateTypes: [...(args.stateTypes ?? [])].sort(),
    assigneeId: args.assigneeId ?? null,
    assignedToViewer: args.assignedToViewer ?? false,
    activeCycle: args.activeCycle ?? false,
    customViewId: args.customViewId ?? null,
    cycleId: args.cycleId ?? null,
    initiativeId: args.initiativeId ?? null,
    labelId: args.labelId ?? null,
    ordering: args.ordering ?? null,
    orderingDirection: args.orderingDirection ?? null,
    priority: args.priority ?? null,
    query: args.query ?? null,
    first: args.first ?? ISSUE_PAGE_SIZE,
    after: args.after ?? null,
    includeArchived: args.includeArchived ?? false,
  });
}

export function readCachedSearch(
  key: string,
  filters: LinearIssueBrowserFilters,
  options: { order?: ServerOrder; showCompletedIssues?: boolean } = {},
): CtoSearchLinearIssuesResult | null {
  return getBrowserCacheEntry(key).searches.get(searchCacheKey(buildIssueSearchArgs(filters, null, options)))?.result ?? null;
}

export function rememberSearchResult(
  entry: LinearIssueBrowserCacheEntry,
  key: string,
  result: CtoSearchLinearIssuesResult,
): void {
  entry.searches.set(key, { result, fetchedAt: Date.now(), promise: null });
  trimMap(entry.searches, LINEAR_BROWSER_CACHE_MAX_SEARCHES);
}

export function mergeIssuePages(current: NormalizedLinearIssue[], next: NormalizedLinearIssue[]): NormalizedLinearIssue[] {
  const map = new Map<string, NormalizedLinearIssue>();
  for (const issue of [...current, ...next]) map.set(issue.id, issue);
  return [...map.values()];
}

export function hasActiveFilters(filters: LinearIssueBrowserFilters): boolean {
  return (
    filters.scope !== DEFAULT_FILTERS.scope
    || filters.projectId !== DEFAULT_FILTERS.projectId
    || filters.statePreset !== DEFAULT_FILTERS.statePreset
    || filters.assigneeId !== DEFAULT_FILTERS.assigneeId
    || filters.priority !== DEFAULT_FILTERS.priority
    || filters.query !== DEFAULT_FILTERS.query
  );
}

/* ------------------------------------------------------------------ */
/* What the window remembers                                           */
/* ------------------------------------------------------------------ */

function warnStorage(action: string, error: unknown): void {
  console.warn(`[linear] could not ${action} in localStorage`, error);
}

function storageKey(projectRoot: string | null | undefined): string | null {
  const root = projectRoot?.trim();
  return root ? `${FILTER_STORAGE_PREFIX}${root}` : null;
}

export function safeLoadFilters(projectRoot: string | null | undefined): LinearIssueBrowserFilters {
  const key = storageKey(projectRoot);
  if (!key || typeof window === "undefined") return DEFAULT_FILTERS;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? "null") as Partial<LinearIssueBrowserFilters> | null;
    if (!parsed || typeof parsed !== "object") return DEFAULT_FILTERS;
    return {
      ...DEFAULT_FILTERS,
      scope: typeof parsed.scope === "string" && parsed.scope ? parsed.scope : DEFAULT_FILTERS.scope,
      projectId: typeof parsed.projectId === "string" ? parsed.projectId : "",
      statePreset: typeof parsed.statePreset === "string" ? parsed.statePreset : DEFAULT_FILTERS.statePreset,
      assigneeId: typeof parsed.assigneeId === "string" ? parsed.assigneeId : "",
      priority: typeof parsed.priority === "string" ? parsed.priority : "",
      query: typeof parsed.query === "string" ? parsed.query : "",
    };
  } catch (error) {
    warnStorage("read the issue filters", error);
    return DEFAULT_FILTERS;
  }
}

export function safeSaveFilters(projectRoot: string | null | undefined, filters: LinearIssueBrowserFilters): void {
  const key = storageKey(projectRoot);
  if (!key || typeof window === "undefined") return;
  try {
    if (!hasActiveFilters(filters)) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, JSON.stringify(filters));
  } catch (error) {
    // Losing this preference should never block browsing issues.
    warnStorage("save the issue filters", error);
  }
}

function selectionStorageKey(projectRoot: string | null | undefined): string | null {
  const root = projectRoot?.trim();
  return root ? `${SELECTION_STORAGE_PREFIX}${root}` : null;
}

export function clearLinearQuickViewSelection(projectRoot: string | null | undefined): void {
  const key = selectionStorageKey(projectRoot);
  if (!key || typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch (error) {
    warnStorage("clear the issue selection", error);
  }
}

// Multi-select survives the temporary remount while the launch modal is open by
// mirroring ids to localStorage. The quick-view host clears this key on real
// pane close, so a fresh open starts unchecked.
export function safeLoadSelection(projectRoot: string | null | undefined): Set<string> {
  const key = selectionStorageKey(projectRoot);
  if (!key || typeof window === "undefined") return new Set();
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? "null");
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === "string").slice(0, SELECTION_STORAGE_MAX));
  } catch (error) {
    warnStorage("read the issue selection", error);
    return new Set();
  }
}

export function safeSaveSelection(projectRoot: string | null | undefined, ids: Set<string>): void {
  const key = selectionStorageKey(projectRoot);
  if (!key || typeof window === "undefined") return;
  try {
    if (ids.size === 0) {
      clearLinearQuickViewSelection(projectRoot);
      return;
    }
    window.localStorage.setItem(key, JSON.stringify([...ids].slice(0, SELECTION_STORAGE_MAX)));
  } catch (error) {
    warnStorage("save the issue selection", error);
  }
}

export function safeLoadDetailPane(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(DETAIL_PANE_STORAGE_KEY) !== "hidden";
  } catch (error) {
    warnStorage("read the details pane choice", error);
    return true;
  }
}

export function safeSaveDetailPane(visible: boolean): void {
  try {
    if (visible) window.localStorage.removeItem(DETAIL_PANE_STORAGE_KEY);
    else window.localStorage.setItem(DETAIL_PANE_STORAGE_KEY, "hidden");
  } catch (error) {
    warnStorage("save the details pane choice", error);
  }
}

/* ------------------------------------------------------------------ */
/* Counts                                                              */
/* ------------------------------------------------------------------ */

/**
 * Live counts from Linear for a set of keyed filters, cached per browser scope.
 * `null` until the first answer arrives (or when counts are unavailable).
 */
function useLinearIssueCounts(
  cacheKey: string,
  pin: OpenProjectBinding | null,
  queries: Record<string, CtoSearchLinearIssuesArgs> | null,
  cap: number,
  refreshNonce: number,
): CtoCountLinearIssuesResult["counts"] | null {
  const requestKey = useMemo(() => (queries && Object.keys(queries).length > 0 ? JSON.stringify({ queries, cap }) : null), [cap, queries]);
  const [state, setState] = useState<{ key: string | null; counts: CtoCountLinearIssuesResult["counts"] | null }>({ key: null, counts: null });

  useEffect(() => {
    if (!requestKey || !pin) return;
    const cto = typeof window === "undefined" ? null : window.ade?.cto;
    if (!cto?.countLinearIssues) return;
    const entry = getBrowserCacheEntry(cacheKey);
    const cached = entry.counts.get(requestKey);
    if (cached?.result) setState({ key: requestKey, counts: cached.result.counts });
    if (cached?.result && cacheIsFresh(cached.fetchedAt)) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const request = JSON.parse(requestKey) as { queries: Record<string, CtoSearchLinearIssuesArgs>; cap: number };
      const promise = cached?.promise ?? cto.countLinearIssues(request, pin);
      entry.counts.set(requestKey, { result: cached?.result ?? null, fetchedAt: cached?.fetchedAt ?? 0, promise });
      void promise
        .then((result) => {
          entry.counts.set(requestKey, { result, fetchedAt: Date.now(), promise: null });
          trimMap(entry.counts, LINEAR_BROWSER_CACHE_MAX_COUNTS);
          if (!cancelled) setState({ key: requestKey, counts: result.counts });
        })
        .catch((error: unknown) => {
          // Counts are optional: the list shows loaded rows with a "+".
          console.warn("[linear] issue counts failed", error);
          entry.counts.set(requestKey, { result: cached?.result ?? null, fetchedAt: cached?.fetchedAt ?? 0, promise: null });
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // The cache key already holds the pin's key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, requestKey, refreshNonce]);

  return state.key === requestKey ? state.counts : null;
}

// Counts stop here and render as "500+"; enough to size a project or a view
// without paging thousands of ids.
const RAIL_COUNT_CAP = 500;
const LIST_COUNT_CAP = 2000;
const MAX_COUNTED_PROJECTS = 100;

/**
 * Every count the window shows. Rail: issues for the active state tab (open
 * ones only while completed issues are hidden), per built-in scope, custom
 * view and project; the header filters do not change them. List: the total
 * and each status group, asked only while Linear has more pages (after that
 * the loaded rows are exact).
 */
export function useLinearBrowserCounts({
  cacheKey,
  pin,
  connected,
  filters,
  showCompletedIssues,
  cyclesAvailable,
  customViewIds,
  projectIds,
  listIsComplete,
  statusGroups,
  refreshNonce,
}: {
  cacheKey: string;
  pin: OpenProjectBinding | null;
  connected: boolean;
  filters: LinearIssueBrowserFilters;
  showCompletedIssues: boolean;
  cyclesAvailable: boolean;
  customViewIds: string[];
  projectIds: string[];
  listIsComplete: boolean;
  /** Status groups with their workflow state ids, for per-group counts. */
  statusGroups: ReadonlyArray<readonly [string, readonly string[]]>;
  refreshNonce: number;
}): {
  scopeCount: (scopeKey: string) => CtoCountLinearIssuesResult["counts"][string] | null;
  projectCount: (projectId: string) => CtoCountLinearIssuesResult["counts"][string] | null;
  listCounts: CtoCountLinearIssuesResult["counts"] | null;
} {
  const railBase = useMemo<CtoSearchLinearIssuesArgs>(
    () => ({ stateTypes: stateTypesFor(filters.statePreset, showCompletedIssues) }),
    [filters.statePreset, showCompletedIssues],
  );
  const viewSignature = customViewIds.join(",");
  const scopeQueries = useMemo<Record<string, CtoSearchLinearIssuesArgs> | null>(() => {
    if (!connected) return null;
    const queries: Record<string, CtoSearchLinearIssuesArgs> = {
      [`scope:${LINEAR_SCOPE_ALL}`]: railBase,
      [`scope:${LINEAR_SCOPE_MINE}`]: { ...railBase, assignedToViewer: true },
    };
    if (cyclesAvailable) queries[`scope:${LINEAR_SCOPE_ACTIVE_CYCLE}`] = { ...railBase, activeCycle: true };
    for (const id of customViewIds) queries[`scope:${LINEAR_SCOPE_PREFIX.view}${id}`] = { ...railBase, customViewId: id };
    return queries;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, cyclesAvailable, railBase, viewSignature]);
  const projectSignature = projectIds.slice(0, MAX_COUNTED_PROJECTS).join(",");
  const projectQueries = useMemo<Record<string, CtoSearchLinearIssuesArgs> | null>(() => {
    if (!connected || projectIds.length === 0) return null;
    return Object.fromEntries(projectIds.slice(0, MAX_COUNTED_PROJECTS).map((id) => [`project:${id}`, { ...railBase, projectId: id }]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, projectSignature, railBase]);
  const statusSignature = statusGroups.map(([key, ids]) => `${key}=${ids.join(",")}`).join("|");
  const listQueries = useMemo<Record<string, CtoSearchLinearIssuesArgs> | null>(() => {
    if (listIsComplete || !connected) return null;
    const { first: _first, after: _after, ordering: _ordering, orderingDirection: _direction, ...base } = buildIssueSearchArgs(filters, null, { showCompletedIssues });
    const queries: Record<string, CtoSearchLinearIssuesArgs> = { total: base };
    for (const [key, ids] of statusGroups) queries[`group:${key}`] = { ...base, stateIds: [...ids] };
    return queries;
    // The signature stands for the group ids, so a regroup with the same ids does not re-ask.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, filters, listIsComplete, showCompletedIssues, statusSignature]);
  const scopeCounts = useLinearIssueCounts(cacheKey, pin, scopeQueries, RAIL_COUNT_CAP, refreshNonce);
  const projectCounts = useLinearIssueCounts(cacheKey, pin, projectQueries, RAIL_COUNT_CAP, refreshNonce);
  const listCounts = useLinearIssueCounts(cacheKey, pin, listQueries, LIST_COUNT_CAP, refreshNonce);
  return {
    scopeCount: (scopeKey) => scopeCounts?.[`scope:${scopeKey}`] ?? null,
    projectCount: (projectId) => projectCounts?.[`project:${projectId}`] ?? null,
    listCounts,
  };
}
