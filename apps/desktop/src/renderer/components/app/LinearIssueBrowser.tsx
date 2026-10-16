import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  CaretDown,
  CaretRight,
  Check,
  CircleNotch,
  Funnel,
  MagnifyingGlass,
  Minus,
  RocketLaunch,
  Stack,
  Timer,
  Tray,
  UserCircle,
  CheckCircle as ReadyIcon,
} from "@phosphor-icons/react";

import type {
  CtoCountLinearIssuesResult,
  CtoGetLinearIssuePickerDataResult,
  CtoLinearCustomView,
  CtoLinearQuickView,
  CtoLinearQuickViewProject,
  CtoSearchLinearIssuesArgs,
  CtoSearchLinearIssuesResult,
  LaneLinearIssue,
  LinearIssueRef,
  NormalizedLinearIssue,
} from "../../../shared/types";
import { cn } from "../ui/cn";
import { Banner } from "../ui/notice/Banner";
import { LinearStateIcon } from "../lanes/linearBrand";
import { confirmDialog } from "../ui/dialog/confirm";
import { showToast } from "./toast/toastStore";
import type { IssueConflict } from "../../lib/linearBatchLaunch";
import {
  GROUP_HEADER_HEIGHT,
  ISSUE_ROW_HEIGHT,
  LinearBrowserIssueRow,
  ProjectFilterButton,
  ScopeNavButton,
} from "./LinearIssueBrowserRows";
import { LinearBatchActionView, LinearIssueDetails } from "./LinearIssueDetailPane";
import { LinearInboxList } from "./LinearInboxList";
import { subscribeIssueCreated } from "../../lib/issueCreateRequests";
import {
  applyIssueEdit,
  formatLinearCount,
  isNormalizedIssue,
  stateGroupRank,
  type BrowserIssue,
  type LinearIssueEdit,
} from "./linearIssueBrowserModel";

export { linearBrowserIssueToLaneIssue } from "./linearIssueBrowserModel";
export type { BrowserIssue } from "./linearIssueBrowserModel";

type IssueSort = "updated_desc" | "created_desc" | "priority" | "due_soon" | "identifier_asc";

/**
 * Shape of the in-flight batch-launch progress the host passes down. Declared
 * locally (and kept permissive) so the browser stays decoupled from the launch
 * orchestration owned by the batch-launch surface; the host renders its own
 * detailed status toast, the browser only needs the headline counts.
 */
export type BatchProgress = {
  total: number;
  completed: number;
  failed?: number;
  running?: boolean;
};

/**
 * `scope` is the left rail's saved-view entry: "all", "mine" (assigned to the
 * viewer), "cycle" (team's active cycle), or `view:<id>` (a Linear custom
 * view). A project pick and a scope are mutually exclusive in the rail.
 */
type LinearIssueBrowserFilters = {
  scope: string;
  projectId: string;
  statePreset: "active" | "all" | string;
  assigneeId: string;
  priority: string;
  query: string;
  sort: IssueSort;
};

const STATE_TABS = [
  { value: "all", label: "All issues" },
  { value: "active", label: "Active" },
  { value: "backlog", label: "Backlog" },
] as const;

const ACTIVE_LINEAR_STATE_TYPES = ["backlog", "unstarted", "started"];
const FILTER_STORAGE_PREFIX = "ade.linear.quickView.filters.v1:";
const SELECTION_STORAGE_PREFIX = "ade.linear.quickView.selection.v1:";
const SELECTION_STORAGE_MAX = 100;
const LINEAR_BROWSER_CACHE_STALE_MS = 90_000;
const LINEAR_BROWSER_CACHE_MAX_SEARCHES = 16;
const LINEAR_BROWSER_CACHE_MAX_COUNTS = 12;
const LINEAR_BROWSER_CACHE_MAX_DETAILS = 60;
// 100 is the Linear API ceiling (linearClient clamps `first` to 100), so it is
// both the largest first page we can fetch and the chunk size each
// infinite-scroll page pulls.
const ISSUE_PAGE_SIZE = 100;
// The list is virtualized, so rows in memory are cheap; this only bounds how
// many pages a long scroll pulls before the user opts into more.
const AUTO_LOAD_MAX_ISSUES = 2000;
// Counts stop here and render as "500+"; enough to size a project or a view
// without paging thousands of ids.
const RAIL_COUNT_CAP = 500;
const LIST_COUNT_CAP = 2000;
const MAX_COUNTED_PROJECTS = 100;
const SCOPE_ALL = "all";
const SCOPE_MINE = "mine";
const SCOPE_READY = "ready";
const SCOPE_INBOX = "inbox";
const READY_STATE_TYPES = ["unstarted", "backlog"];
const SCOPE_CYCLE = "cycle";
const VIEW_SCOPE_PREFIX = "view:";

const DEFAULT_FILTERS: LinearIssueBrowserFilters = {
  scope: SCOPE_ALL,
  projectId: "",
  statePreset: "all",
  assigneeId: "",
  priority: "",
  query: "",
  sort: "updated_desc",
};

const PRIORITY_OPTIONS = [
  { value: "", label: "Any priority" },
  { value: "1", label: "Urgent" },
  { value: "2", label: "High" },
  { value: "3", label: "Medium" },
  { value: "4", label: "Low" },
  { value: "0", label: "No priority" },
] as const;

const SORT_OPTIONS: ReadonlyArray<{ value: IssueSort; label: string }> = [
  { value: "updated_desc", label: "Recently updated" },
  { value: "created_desc", label: "Recently created" },
  { value: "priority", label: "Priority" },
  { value: "due_soon", label: "Due soon" },
  { value: "identifier_asc", label: "Issue key" },
];

type TimedCacheEntry<T, P = T> = {
  result: T | null;
  fetchedAt: number;
  promise: Promise<P> | null;
};

type LinearIssueBrowserCacheEntry = {
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

function getCtoCacheScope(cto: unknown): string {
  if (!cto || (typeof cto !== "object" && typeof cto !== "function")) return "none";
  const target = cto as object;
  const current = ctoCacheScopes.get(target);
  if (current) return String(current);
  const next = nextCtoCacheScope++;
  ctoCacheScopes.set(target, next);
  return String(next);
}

function browserCacheKey(projectRoot: string | null | undefined): string {
  const root = projectRoot?.trim() || "__project__";
  const cto = typeof window === "undefined" ? null : window.ade?.cto;
  return `${root}::cto:${getCtoCacheScope(cto)}`;
}

function emptyCatalog(): CtoGetLinearIssuePickerDataResult {
  return { projects: [], users: [], states: [], labels: [] };
}

function emptyPageInfo(): CtoSearchLinearIssuesResult["pageInfo"] {
  return { hasNextPage: false, endCursor: null };
}

function getBrowserCacheEntry(key: string): LinearIssueBrowserCacheEntry {
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

function cacheIsFresh(fetchedAt: number): boolean {
  return fetchedAt > 0 && Date.now() - fetchedAt < LINEAR_BROWSER_CACHE_STALE_MS;
}

function trimMap<K, V>(map: Map<K, V>, max: number): void {
  while (map.size > max) {
    const oldestKey = map.keys().next().value as K | undefined;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
  }
}

function stateTypesForPreset(preset: string): string[] {
  if (preset === "all") return [];
  if (preset === "active") return ACTIVE_LINEAR_STATE_TYPES;
  return preset ? [preset] : [];
}

function scopeArgs(scope: string): Pick<CtoSearchLinearIssuesArgs, "assignedToViewer" | "activeCycle" | "customViewId" | "stateTypes"> {
  // Ready = not started yet. Issues whose blockers are still open are removed
  // in the pane (Linear's filter only knows whether a blocker relation exists).
  if (scope === SCOPE_READY) return { stateTypes: READY_STATE_TYPES };
  if (scope === SCOPE_MINE) return { assignedToViewer: true };
  if (scope === SCOPE_CYCLE) return { activeCycle: true };
  if (scope.startsWith(VIEW_SCOPE_PREFIX)) return { customViewId: scope.slice(VIEW_SCOPE_PREFIX.length) };
  return {};
}

function buildIssueSearchArgs(
  filters: LinearIssueBrowserFilters,
  after: string | null,
): CtoSearchLinearIssuesArgs {
  return {
    projectId: filters.projectId || null,
    stateTypes: stateTypesForPreset(filters.statePreset),
    assigneeId: filters.assigneeId || null,
    priority: filters.priority ? Number(filters.priority) : null,
    query: filters.query.trim() || null,
    first: ISSUE_PAGE_SIZE,
    after,
    includeArchived: false,
    ...(filters.projectId ? {} : scopeArgs(filters.scope)),
  };
}

function searchCacheKey(args: CtoSearchLinearIssuesArgs): string {
  return JSON.stringify({
    projectId: args.projectId ?? null,
    stateTypes: [...(args.stateTypes ?? [])].sort(),
    assigneeId: args.assigneeId ?? null,
    assignedToViewer: args.assignedToViewer ?? false,
    activeCycle: args.activeCycle ?? false,
    customViewId: args.customViewId ?? null,
    priority: args.priority ?? null,
    query: args.query ?? null,
    first: args.first ?? ISSUE_PAGE_SIZE,
    after: args.after ?? null,
    includeArchived: args.includeArchived ?? false,
  });
}

function readCachedSearch(
  key: string,
  filters: LinearIssueBrowserFilters,
): CtoSearchLinearIssuesResult | null {
  return getBrowserCacheEntry(key).searches.get(searchCacheKey(buildIssueSearchArgs(filters, null)))?.result ?? null;
}

function rememberSearchResult(
  entry: LinearIssueBrowserCacheEntry,
  key: string,
  result: CtoSearchLinearIssuesResult,
): void {
  entry.searches.set(key, { result, fetchedAt: Date.now(), promise: null });
  trimMap(entry.searches, LINEAR_BROWSER_CACHE_MAX_SEARCHES);
}

function storageKey(projectRoot: string | null | undefined): string | null {
  const root = projectRoot?.trim();
  return root ? `${FILTER_STORAGE_PREFIX}${root}` : null;
}

function safeLoadFilters(projectRoot: string | null | undefined): LinearIssueBrowserFilters {
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
      sort: SORT_OPTIONS.some((option) => option.value === parsed.sort) ? (parsed.sort as IssueSort) : DEFAULT_FILTERS.sort,
    };
  } catch {
    return DEFAULT_FILTERS;
  }
}

function safeSaveFilters(projectRoot: string | null | undefined, filters: LinearIssueBrowserFilters): void {
  const key = storageKey(projectRoot);
  if (!key || typeof window === "undefined") return;
  try {
    if (!hasActiveFilters(filters)) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, JSON.stringify(filters));
  } catch {
    // Best effort only; losing this preference should never block browsing issues.
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
  } catch {
    // Best effort only; losing this selection should never block browsing issues.
  }
}

// Multi-select survives the temporary remount while the launch modal is open by
// mirroring ids to localStorage. The quick-view host clears this key on real
// pane close, so a fresh open starts unchecked.
function safeLoadSelection(projectRoot: string | null | undefined): Set<string> {
  const key = selectionStorageKey(projectRoot);
  if (!key || typeof window === "undefined") return new Set();
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? "null");
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === "string").slice(0, SELECTION_STORAGE_MAX));
  } catch {
    return new Set();
  }
}

function safeSaveSelection(projectRoot: string | null | undefined, ids: Set<string>): void {
  const key = selectionStorageKey(projectRoot);
  if (!key || typeof window === "undefined") return;
  try {
    if (ids.size === 0) {
      clearLinearQuickViewSelection(projectRoot);
      return;
    }
    window.localStorage.setItem(key, JSON.stringify([...ids].slice(0, SELECTION_STORAGE_MAX)));
  } catch {
    // Best effort only; losing this selection should never block browsing issues.
  }
}

function mergeIssuePages(current: NormalizedLinearIssue[], next: NormalizedLinearIssue[]): NormalizedLinearIssue[] {
  const map = new Map<string, NormalizedLinearIssue>();
  for (const issue of [...current, ...next]) map.set(issue.id, issue);
  return [...map.values()];
}

function toTimestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sortedIssues(issues: NormalizedLinearIssue[], sort: IssueSort): NormalizedLinearIssue[] {
  const out = [...issues];
  out.sort((left, right) => {
    if (sort === "created_desc") return toTimestamp(right.createdAt) - toTimestamp(left.createdAt);
    if (sort === "priority") {
      const leftRank = left.priority === 0 ? 99 : left.priority;
      const rightRank = right.priority === 0 ? 99 : right.priority;
      return leftRank - rightRank || toTimestamp(right.updatedAt) - toTimestamp(left.updatedAt);
    }
    if (sort === "due_soon") {
      const leftDue = left.dueDate ? toTimestamp(left.dueDate) : Number.POSITIVE_INFINITY;
      const rightDue = right.dueDate ? toTimestamp(right.dueDate) : Number.POSITIVE_INFINITY;
      return leftDue - rightDue || toTimestamp(right.updatedAt) - toTimestamp(left.updatedAt);
    }
    if (sort === "identifier_asc") return left.identifier.localeCompare(right.identifier, undefined, { numeric: true });
    return toTimestamp(right.updatedAt) - toTimestamp(left.updatedAt);
  });
  return out;
}

function hasActiveFilters(filters: LinearIssueBrowserFilters): boolean {
  return (
    filters.scope !== DEFAULT_FILTERS.scope
    || filters.projectId !== DEFAULT_FILTERS.projectId
    || filters.statePreset !== DEFAULT_FILTERS.statePreset
    || filters.assigneeId !== DEFAULT_FILTERS.assigneeId
    || filters.priority !== DEFAULT_FILTERS.priority
    || filters.query !== DEFAULT_FILTERS.query
    || filters.sort !== DEFAULT_FILTERS.sort
  );
}

type IssueGroup = {
  key: string;
  stateId: string | null;
  stateName: string;
  stateType: string;
  issues: BrowserIssue[];
};

function groupIssuesByState(issues: BrowserIssue[]): IssueGroup[] {
  const order: string[] = [];
  const groups = new Map<string, Omit<IssueGroup, "key">>();
  for (const issue of issues) {
    const key = issue.stateId || `${issue.stateType}:${issue.stateName}`;
    let group = groups.get(key);
    if (!group) {
      group = { stateId: issue.stateId || null, stateName: issue.stateName, stateType: issue.stateType, issues: [] };
      groups.set(key, group);
      order.push(key);
    }
    group.issues.push(issue);
  }
  return order
    .map((key) => ({ key, ...groups.get(key)! }))
    .sort((left, right) => (
      stateGroupRank(left.stateType) - stateGroupRank(right.stateType)
      || left.stateName.localeCompare(right.stateName)
    ));
}

type ListRow =
  | { kind: "header"; group: IssueGroup; collapsed: boolean }
  | { kind: "issue"; issue: BrowserIssue };

function isConnectionError(message: string): boolean {
  return /token|oauth|auth|connect|settings|linear/i.test(message);
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * Live counts from Linear for a set of keyed filters, cached per browser scope.
 * `null` until the first answer arrives (or when counts are unavailable).
 */
function useLinearIssueCounts(
  cacheKey: string,
  queries: Record<string, CtoSearchLinearIssuesArgs> | null,
  cap: number,
  refreshNonce: number,
): CtoCountLinearIssuesResult["counts"] | null {
  const requestKey = useMemo(() => (queries && Object.keys(queries).length > 0 ? JSON.stringify({ queries, cap }) : null), [cap, queries]);
  const [state, setState] = useState<{ key: string | null; counts: CtoCountLinearIssuesResult["counts"] | null }>({ key: null, counts: null });

  useEffect(() => {
    if (!requestKey) return;
    const cto = typeof window === "undefined" ? null : window.ade?.cto;
    if (!cto?.countLinearIssues) return;
    const entry = getBrowserCacheEntry(cacheKey);
    const cached = entry.counts.get(requestKey);
    if (cached?.result) setState({ key: requestKey, counts: cached.result.counts });
    if (cached?.result && cacheIsFresh(cached.fetchedAt)) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const request = JSON.parse(requestKey) as { queries: Record<string, CtoSearchLinearIssuesArgs>; cap: number };
      const promise = cached?.promise ?? cto.countLinearIssues(request);
      entry.counts.set(requestKey, { result: cached?.result ?? null, fetchedAt: cached?.fetchedAt ?? 0, promise });
      void promise
        .then((result) => {
          entry.counts.set(requestKey, { result, fetchedAt: Date.now(), promise: null });
          trimMap(entry.counts, LINEAR_BROWSER_CACHE_MAX_COUNTS);
          if (!cancelled) setState({ key: requestKey, counts: result.counts });
        })
        .catch(() => {
          entry.counts.set(requestKey, { result: cached?.result ?? null, fetchedAt: cached?.fetchedAt ?? 0, promise: null });
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [cacheKey, requestKey, refreshNonce]);

  return state.key === requestKey ? state.counts : null;
}

/** The inbox reads at most 50 items, so 50 means "50 or more". */
function formatInboxCount(unread: number | null): string | null {
  if (!unread) return null;
  return unread >= 50 ? "50+" : String(unread);
}

export function LinearIssueBrowser({
  projectRoot,
  featuredIssue,
  featuredIssueLabel = "Linked issue",
  actionLabel,
  actionBusyLabel,
  actionIcon,
  actionBusyIssueId,
  actionDisabled = false,
  showBranchPreview = true,
  singleSelect = false,
  refreshKey = 0,
  onIssueAction,
  onOpenLinearSettings,
  onConnectionVisibilityChange,
  onQuickViewChange,
  onLoadingChange,
  batchActions,
}: {
  projectRoot?: string | null;
  featuredIssue?: LaneLinearIssue | null;
  featuredIssueLabel?: string;
  actionLabel: string;
  actionBusyLabel?: string;
  actionIcon?: React.ReactNode;
  actionBusyIssueId?: string | null;
  actionDisabled?: boolean;
  showBranchPreview?: boolean;
  singleSelect?: boolean;
  refreshKey?: number;
  onIssueAction: (issue: BrowserIssue) => void | Promise<void>;
  onOpenLinearSettings?: () => void;
  onConnectionVisibilityChange?: (visible: boolean) => void;
  onQuickViewChange?: (quickView: CtoLinearQuickView | null) => void;
  onLoadingChange?: (loading: boolean) => void;
  batchActions?: {
    /**
     * Opens the unified launch config modal for 1..N issues. The single-issue
     * row dock and the multi-select dock both route here so there is one launch
     * path. `laneOnly` creates lanes without kicking off an agent.
     */
    onBatchLaunch: (issues: BrowserIssue[], options: { laneOnly?: boolean }) => void;
    /** In-flight batch progress, if a launch is currently running. */
    batchProgress?: BatchProgress | null;
    /**
     * Issues already attached to a lane/session, keyed by issue id. Drives the
     * per-row "Lane"/"Agent" chip and the re-attach confirm.
     */
    conflicts?: Map<string, IssueConflict>;
  };
}) {
  const cacheKey = browserCacheKey(projectRoot);
  const [quickView, setQuickView] = useState<CtoLinearQuickView | null>(() => getBrowserCacheEntry(cacheKey).quickView);
  const [catalog, setCatalog] = useState<CtoGetLinearIssuePickerDataResult>(() => getBrowserCacheEntry(cacheKey).catalog ?? emptyCatalog());
  const [customViews, setCustomViews] = useState<CtoLinearCustomView[]>(() => getBrowserCacheEntry(cacheKey).views.result ?? []);
  const [filters, setFilters] = useState<LinearIssueBrowserFilters>(() => safeLoadFilters(projectRoot));
  const [issues, setIssues] = useState<NormalizedLinearIssue[]>(() => readCachedSearch(cacheKey, safeLoadFilters(projectRoot))?.issues ?? []);
  const [pageInfo, setPageInfo] = useState<{ hasNextPage: boolean; endCursor: string | null }>(() => readCachedSearch(cacheKey, safeLoadFilters(projectRoot))?.pageInfo ?? emptyPageInfo());
  const [searchTotalCount, setSearchTotalCount] = useState<number | null>(() => readCachedSearch(cacheKey, safeLoadFilters(projectRoot))?.totalCount ?? null);
  const pageInfoRef = useRef(pageInfo);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const issuesScrollRef = useRef<HTMLDivElement | null>(null);
  const [loadingQuickView, setLoadingQuickView] = useState(false);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [loadingIssues, setLoadingIssues] = useState(false);
  // True only while an infinite-scroll "append" fetch is in flight, so the
  // bottom-of-list spinner doesn't appear during a filter-change reload.
  const [appendingMore, setAppendingMore] = useState(false);
  const [localActionIssueId, setLocalActionIssueId] = useState<string | null>(null);
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(featuredIssue?.id ?? null);
  const [selectedIssueIds, setSelectedIssueIds] = useState<Set<string>>(() => safeLoadSelection(projectRoot));
  const [lastCheckedId, setLastCheckedId] = useState<string | null>(null);
  const multiSelectEnabled = !singleSelect;
  const anyChecked = multiSelectEnabled && selectedIssueIds.size > 0;
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  // An issue opened from a relation that is not in the current list.
  const [externalIssue, setExternalIssue] = useState<NormalizedLinearIssue | null>(null);
  const [detailIssues, setDetailIssues] = useState<Map<string, NormalizedLinearIssue>>(() => new Map());
  const [loadingRelationId, setLoadingRelationId] = useState<string | null>(null);
  const [pendingEditIds, setPendingEditIds] = useState<Set<string>>(() => new Set());
  const [countsNonce, setCountsNonce] = useState(0);
  const quickViewRequestIdRef = useRef(0);
  const catalogRequestIdRef = useRef(0);
  const searchRequestIdRef = useRef(0);
  // Accumulated data for every issue displayed this session, so a selection
  // built across multiple searches stays resolvable when an earlier pick is no
  // longer on the current page. seenVersion forces a re-render when it grows.
  const seenIssuesRef = useRef<Map<string, BrowserIssue>>(new Map());
  const [seenVersion, setSeenVersion] = useState(0);

  useEffect(() => {
    onQuickViewChange?.(quickView);
  }, [onQuickViewChange, quickView]);

  useEffect(() => {
    pageInfoRef.current = pageInfo;
  }, [pageInfo]);

  // Persist the multi-select so it survives a remount/route change (proceed to
  // the launch modal → back). Cleared when the selection empties.
  useEffect(() => {
    if (!multiSelectEnabled) return;
    safeSaveSelection(projectRoot, selectedIssueIds);
  }, [multiSelectEnabled, projectRoot, selectedIssueIds]);

  useEffect(() => {
    const nextFilters = safeLoadFilters(projectRoot);
    const entry = getBrowserCacheEntry(cacheKey);
    const cachedSearch = readCachedSearch(cacheKey, nextFilters);
    setFilters(nextFilters);
    setQuickView(entry.quickView);
    setCatalog(entry.catalog ?? emptyCatalog());
    setCustomViews(entry.views.result ?? []);
    setIssues(cachedSearch?.issues ?? []);
    setPageInfo(cachedSearch?.pageInfo ?? emptyPageInfo());
    setSearchTotalCount(cachedSearch?.totalCount ?? null);
    setSelectedIssueIds(safeLoadSelection(projectRoot));
    setExternalIssue(null);
    setDetailIssues(new Map());
  }, [cacheKey, projectRoot]);

  useEffect(() => {
    if (featuredIssue && !selectedIssueId) {
      setSelectedIssueId(featuredIssue.id);
    }
  }, [featuredIssue, selectedIssueId]);

  const loading = loadingQuickView || loadingCatalog || loadingIssues || Boolean(actionBusyIssueId ?? localActionIssueId);
  useEffect(() => {
    onLoadingChange?.(loading);
  }, [loading, onLoadingChange]);

  const loadQuickView = useCallback((force = false) => {
    const entry = getBrowserCacheEntry(cacheKey);
    if (!window.ade.cto?.getLinearQuickView) return;
    if (!force && entry.quickView && cacheIsFresh(entry.quickViewFetchedAt)) {
      setQuickView(entry.quickView);
      onConnectionVisibilityChange?.(entry.quickView.connection.connected === true);
      return;
    }
    if (entry.quickView) {
      setQuickView(entry.quickView);
      onConnectionVisibilityChange?.(entry.quickView.connection.connected === true);
    }
    const requestId = quickViewRequestIdRef.current + 1;
    quickViewRequestIdRef.current = requestId;
    setLoadingQuickView(force || !entry.quickView);
    setError(null);
    const promise = entry.quickViewPromise ?? window.ade.cto.getLinearQuickView();
    entry.quickViewPromise = promise;
    void promise
      .then((data) => {
        entry.quickView = data;
        entry.quickViewFetchedAt = Date.now();
        entry.quickViewPromise = null;
        if (quickViewRequestIdRef.current !== requestId) return;
        setQuickView(data);
        onConnectionVisibilityChange?.(data.connection.connected === true);
      })
      .catch((err) => {
        entry.quickViewPromise = null;
        if (quickViewRequestIdRef.current !== requestId) return;
        if (!entry.quickView || force) {
          setError(err instanceof Error ? err.message : "Unable to load Linear.");
        }
      })
      .finally(() => {
        if (quickViewRequestIdRef.current === requestId) setLoadingQuickView(false);
      });
  }, [cacheKey, onConnectionVisibilityChange]);

  const loadCatalog = useCallback((force = false) => {
    const entry = getBrowserCacheEntry(cacheKey);
    const cto = window.ade.cto;
    if (!cto?.getLinearIssuePickerData) {
      setError("Linear controls are not available in this ADE surface.");
      return;
    }
    if (!force && entry.catalog && cacheIsFresh(entry.catalogFetchedAt)) {
      setCatalog(entry.catalog);
      return;
    }
    if (entry.catalog) setCatalog(entry.catalog);
    const requestId = catalogRequestIdRef.current + 1;
    catalogRequestIdRef.current = requestId;
    setLoadingCatalog(force || !entry.catalog);
    setError(null);
    const promise = entry.catalogPromise ?? cto.getLinearIssuePickerData();
    entry.catalogPromise = promise;
    void promise
      .then((data) => {
        entry.catalog = data;
        entry.catalogFetchedAt = Date.now();
        entry.catalogPromise = null;
        if (catalogRequestIdRef.current !== requestId) return;
        setCatalog(data);
      })
      .catch((err) => {
        entry.catalogPromise = null;
        if (catalogRequestIdRef.current !== requestId) return;
        if (!entry.catalog || force) {
          setError(err instanceof Error ? err.message : "Unable to load Linear filters.");
        }
      })
      .finally(() => {
        if (catalogRequestIdRef.current === requestId) setLoadingCatalog(false);
      });
  }, [cacheKey]);

  // Custom views are optional: a brain without them, or a failed read, just
  // leaves the rail with the built-in scopes.
  const loadCustomViews = useCallback((force = false) => {
    const entry = getBrowserCacheEntry(cacheKey);
    const cto = window.ade.cto;
    if (!cto?.getLinearCustomViews) return;
    if (!force && entry.views.result && cacheIsFresh(entry.views.fetchedAt)) {
      setCustomViews(entry.views.result);
      return;
    }
    const promise = entry.views.promise ?? cto.getLinearCustomViews();
    entry.views = { ...entry.views, promise };
    void promise
      .then((views) => {
        entry.views = { result: views, fetchedAt: Date.now(), promise: null };
        setCustomViews(views);
      })
      .catch(() => {
        entry.views = { ...entry.views, promise: null };
      });
  }, [cacheKey]);

  const searchIssues = useCallback((append: boolean, force = false) => {
    const cto = window.ade.cto;
    if (!cto?.searchLinearIssues) {
      setError("Linear issue search is not available in this ADE surface.");
      return;
    }
    const requestId = searchRequestIdRef.current + 1;
    searchRequestIdRef.current = requestId;
    const entry = getBrowserCacheEntry(cacheKey);
    const args = buildIssueSearchArgs(filters, append ? pageInfoRef.current.endCursor : null);
    const key = searchCacheKey(args);
    const cached = entry.searches.get(key);
    const cachedResult = cached?.result ?? null;
    const applyResult = (result: CtoSearchLinearIssuesResult) => {
      setIssues((current) => append ? mergeIssuePages(current, result.issues) : result.issues);
      setPageInfo(result.pageInfo);
      if (!append) setSearchTotalCount(result.totalCount ?? null);
    };
    if (cachedResult && !force && cacheIsFresh(cached?.fetchedAt ?? 0)) {
      applyResult(cachedResult);
      return;
    }
    if (cachedResult && !append) applyResult(cachedResult);
    setLoadingIssues(force || append || !cachedResult);
    setAppendingMore(append);
    setError(null);
    const promise = cached?.promise ?? cto.searchLinearIssues(args);
    entry.searches.set(key, {
      result: cachedResult,
      fetchedAt: cached?.fetchedAt ?? 0,
      promise,
    });
    void promise
      .then((result) => {
        rememberSearchResult(entry, key, result);
        if (searchRequestIdRef.current !== requestId) return;
        applyResult(result);
      })
      .catch((err) => {
        entry.searches.set(key, { result: cachedResult, fetchedAt: cached?.fetchedAt ?? 0, promise: null });
        if (searchRequestIdRef.current !== requestId) return;
        if (!cachedResult || force) {
          setError(err instanceof Error ? err.message : "Unable to search Linear issues.");
        }
      })
      .finally(() => {
        if (searchRequestIdRef.current === requestId) {
          setLoadingIssues(false);
          if (append) setAppendingMore(false);
        }
      });
  }, [cacheKey, filters]);

  useEffect(() => {
    const force = refreshKey > 0;
    loadQuickView(force);
    loadCatalog(force);
    loadCustomViews(force);
  }, [loadCatalog, loadCustomViews, loadQuickView, refreshKey]);

  useEffect(() => {
    const timer = window.setTimeout(() => searchIssues(false, false), 220);
    return () => window.clearTimeout(timer);
  }, [filters, searchIssues]);

  useEffect(() => {
    if (refreshKey === 0) return;
    const entry = getBrowserCacheEntry(cacheKey);
    entry.counts.clear();
    entry.details.clear();
    setDetailIssues(new Map());
    setCountsNonce((value) => value + 1);
    searchIssues(false, true);
  }, [cacheKey, refreshKey, searchIssues]);

  const updateFilters = useCallback((patch: Partial<LinearIssueBrowserFilters>) => {
    const next = { ...filters, ...patch };
    setFilters(next);
    safeSaveFilters(projectRoot, next);
  }, [filters, projectRoot]);

  const resetFilters = useCallback(() => {
    setFilters(DEFAULT_FILTERS);
    safeSaveFilters(projectRoot, DEFAULT_FILTERS);
    setIssues([]);
    setPageInfo({ hasNextPage: false, endCursor: null });
    setSearchTotalCount(null);
  }, [projectRoot]);

  const sorted = useMemo(() => sortedIssues(issues, filters.sort), [filters.sort, issues]);
  const readyScope = !filters.projectId && filters.scope === SCOPE_READY;
  const inboxScope = !filters.projectId && filters.scope === SCOPE_INBOX;
  const [inboxUnread, setInboxUnread] = useState<number | null>(null);
  const inboxAvailable = typeof window !== "undefined" && typeof window.ade?.cto?.getLinearInbox === "function";
  // The rail shows the unread count before the inbox is opened.
  useEffect(() => {
    if (!inboxAvailable) return;
    let cancelled = false;
    void window.ade.cto!.getLinearInbox({ first: 50 })
      .then((items) => { if (!cancelled) setInboxUnread(items.length); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [inboxAvailable]);
  const displayIssues = useMemo<BrowserIssue[]>(() => {
    const visible = readyScope
      ? sorted.filter((issue) => !("hasOpenBlockers" in issue && issue.hasOpenBlockers))
      : sorted;
    if (!featuredIssue) return visible;
    return [
      featuredIssue,
      ...visible.filter((issue) => issue.id !== featuredIssue.id),
    ];
  }, [featuredIssue, readyScope, sorted]);
  const canAutoLoadIssues = typeof IntersectionObserver !== "undefined";

  const issueGroups = useMemo(() => groupIssuesByState(displayIssues), [displayIssues]);
  const listRows = useMemo<ListRow[]>(() => {
    const rows: ListRow[] = [];
    for (const group of issueGroups) {
      const collapsed = collapsedGroups[group.key] === true;
      rows.push({ kind: "header", group, collapsed });
      if (!collapsed) for (const issue of group.issues) rows.push({ kind: "issue", issue });
    }
    return rows;
  }, [collapsedGroups, issueGroups]);
  const headerIndices = useMemo(
    () => listRows.flatMap((row, index) => (row.kind === "header" ? [index] : [])),
    [listRows],
  );
  // Keyboard order: what is on screen, top to bottom, skipping collapsed groups.
  const navigableIssues = useMemo(
    () => listRows.flatMap((row) => (row.kind === "issue" ? [row.issue] : [])),
    [listRows],
  );

  const virtualizer = useVirtualizer({
    count: listRows.length,
    getScrollElement: () => issuesScrollRef.current,
    estimateSize: (index) => (listRows[index]?.kind === "header" ? GROUP_HEADER_HEIGHT : ISSUE_ROW_HEIGHT),
    // A starting viewport so the first paint (and jsdom) renders rows before
    // the scroll element is measured.
    initialRect: { width: 0, height: 720 },
    overscan: 12,
    rangeExtractor: useCallback(
      (range: { startIndex: number; endIndex: number; overscan: number; count: number }) => {
        let pinned: number | null = null;
        for (const index of headerIndices) {
          if (index > range.startIndex) break;
          pinned = index;
        }
        const start = Math.max(0, range.startIndex - range.overscan);
        const end = Math.min(range.count - 1, range.endIndex + range.overscan);
        const indices = new Set<number>();
        if (pinned != null) indices.add(pinned);
        for (let index = start; index <= end; index += 1) indices.add(index);
        return [...indices].sort((a, b) => a - b);
      },
      [headerIndices],
    ),
  });
  const virtualItems = virtualizer.getVirtualItems();
  const activeHeaderIndex = useMemo(() => {
    const start = virtualizer.range?.startIndex ?? 0;
    let active: number | null = null;
    for (const index of headerIndices) {
      if (index > start) break;
      active = index;
    }
    return active;
  }, [headerIndices, virtualizer.range?.startIndex]);

  // Infinite scroll: fetch the next page when the rendered range nears the end.
  const lastRenderedIndex = virtualItems.length > 0 ? virtualItems[virtualItems.length - 1]!.index : -1;
  useEffect(() => {
    if (!canAutoLoadIssues || loadingIssues) return;
    if (!pageInfo.hasNextPage || issues.length >= AUTO_LOAD_MAX_ISSUES) return;
    if (lastRenderedIndex < 0 || lastRenderedIndex < listRows.length - 15) return;
    searchIssues(true);
  }, [canAutoLoadIssues, issues.length, lastRenderedIndex, listRows.length, loadingIssues, pageInfo.hasNextPage, searchIssues]);

  useEffect(() => {
    if (selectedIssueId && displayIssues.some((issue) => issue.id === selectedIssueId)) return;
    if (selectedIssueId && externalIssue?.id === selectedIssueId) return;
    setSelectedIssueId(displayIssues[0]?.id ?? null);
  }, [displayIssues, externalIssue, selectedIssueId]);

  const listSelectedIssue = displayIssues.find((issue) => issue.id === selectedIssueId)
    ?? (externalIssue && externalIssue.id === selectedIssueId ? externalIssue : null)
    ?? displayIssues[0]
    ?? null;

  // The detail read carries relations (blocks / related) the list omits. Use it
  // when it is at least as fresh as the list copy.
  const selectedIssue = useMemo<BrowserIssue | null>(() => {
    if (!listSelectedIssue) return null;
    const detail = detailIssues.get(listSelectedIssue.id);
    if (!detail) return listSelectedIssue;
    if (toTimestamp(detail.updatedAt) >= toTimestamp(listSelectedIssue.updatedAt)) return detail;
    return { ...listSelectedIssue, ...(isNormalizedIssue(listSelectedIssue) ? {
      blockingIssues: detail.blockingIssues,
      relatedIssues: detail.relatedIssues,
    } : {}) };
  }, [detailIssues, listSelectedIssue]);

  const rememberDetail = useCallback((issue: NormalizedLinearIssue) => {
    const entry = getBrowserCacheEntry(cacheKey);
    entry.details.set(issue.id, { issue, fetchedAt: Date.now() });
    trimMap(entry.details, LINEAR_BROWSER_CACHE_MAX_DETAILS);
    setDetailIssues((current) => {
      const next = new Map(current);
      next.set(issue.id, issue);
      return next;
    });
  }, [cacheKey]);

  const fetchIssueDetail = useCallback(async (issueId: string): Promise<NormalizedLinearIssue | null> => {
    const entry = getBrowserCacheEntry(cacheKey);
    const cached = entry.details.get(issueId);
    if (cached && cacheIsFresh(cached.fetchedAt)) return cached.issue;
    const fn = window.ade?.cto?.getLinearIssue;
    if (!fn) return null;
    const issue = await fn({ issueId });
    if (issue) rememberDetail(issue);
    return issue;
  }, [cacheKey, rememberDetail]);

  const selectedIssueKey = listSelectedIssue?.id ?? null;
  useEffect(() => {
    if (!selectedIssueKey || detailIssues.has(selectedIssueKey)) return;
    const timer = window.setTimeout(() => {
      void fetchIssueDetail(selectedIssueKey).catch(() => {
        // The list copy still renders; relations beyond "blocked by" stay hidden.
      });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [detailIssues, fetchIssueDetail, selectedIssueKey]);

  // An issue made from the pane's "New" is selected at once; the list gains it
  // at its next refresh.
  useEffect(() => subscribeIssueCreated((event) => {
    if (event.provider !== "linear") return;
    rememberDetail(event.issue);
    setExternalIssue(event.issue);
    setSelectedIssueId(event.issue.id);
  }), [rememberDetail]);

  const handleOpenRelatedIssue = useCallback(async (ref: LinearIssueRef) => {
    if (displayIssues.some((issue) => issue.id === ref.id)) {
      setSelectedIssueId(ref.id);
      return;
    }
    setLoadingRelationId(ref.id);
    try {
      const issue = await fetchIssueDetail(ref.id);
      if (!issue) {
        showToast({ tone: "warning", title: `Couldn't open ${ref.identifier}`, message: "Linear did not return that issue." });
        return;
      }
      setExternalIssue(issue);
      setSelectedIssueId(issue.id);
    } catch (err) {
      showToast({
        tone: "error",
        title: `Couldn't open ${ref.identifier}`,
        message: err instanceof Error ? err.message : "Linear request failed.",
      });
    } finally {
      setLoadingRelationId(null);
    }
  }, [displayIssues, fetchIssueDetail]);

  // Optimistic edit: patch every local copy, send one issueUpdate, then take
  // Linear's copy on success or restore the snapshot and toast on failure.
  const canEditIssues = typeof window !== "undefined" && typeof window.ade?.cto?.updateLinearIssue === "function";
  const editSequenceRef = useRef(new Map<string, number>());
  const handleEditIssue = useCallback(async (issue: BrowserIssue, edit: LinearIssueEdit) => {
    const update = window.ade?.cto?.updateLinearIssue;
    if (!update) return;
    const issueId = issue.id;
    // Two quick edits on one issue: only the newest one's result (or rollback) lands.
    const sequence = (editSequenceRef.current.get(issueId) ?? 0) + 1;
    editSequenceRef.current.set(issueId, sequence);
    const isLatest = () => editSequenceRef.current.get(issueId) === sequence;
    const snapshot = {
      list: issues.find((entry) => entry.id === issueId) ?? null,
      detail: detailIssues.get(issueId) ?? null,
      external: externalIssue?.id === issueId ? externalIssue : null,
    };
    const patchLocal = (apply: (current: NormalizedLinearIssue) => NormalizedLinearIssue) => {
      setIssues((current) => current.map((entry) => (entry.id === issueId ? apply(entry) : entry)));
      setDetailIssues((current) => {
        const existing = current.get(issueId);
        if (!existing) return current;
        const next = new Map(current);
        next.set(issueId, apply(existing));
        return next;
      });
      setExternalIssue((current) => (current && current.id === issueId ? apply(current) : current));
    };
    patchLocal((current) => applyIssueEdit(current, edit, catalog));
    setPendingEditIds((current) => new Set(current).add(issueId));
    const entry = getBrowserCacheEntry(cacheKey);
    try {
      const updated = await update({ issueId, ...edit });
      entry.searches.clear();
      entry.counts.clear();
      if (!isLatest()) return;
      if (updated) {
        rememberDetail(updated);
        patchLocal(() => updated);
      } else {
        entry.details.delete(issueId);
      }
      setCountsNonce((value) => value + 1);
    } catch (err) {
      showToast({
        tone: "error",
        title: `Couldn't update ${issue.identifier}`,
        message: err instanceof Error ? err.message : "Linear rejected the change.",
      });
      if (!isLatest()) return;
      setIssues((current) => current.map((entry) => (entry.id === issueId && snapshot.list ? snapshot.list : entry)));
      setDetailIssues((current) => {
        const next = new Map(current);
        if (snapshot.detail) next.set(issueId, snapshot.detail);
        else next.delete(issueId);
        return next;
      });
      setExternalIssue((current) => (current && current.id === issueId && snapshot.external ? snapshot.external : current));
    } finally {
      if (isLatest()) {
        editSequenceRef.current.delete(issueId);
        setPendingEditIds((current) => {
          const next = new Set(current);
          next.delete(issueId);
          return next;
        });
      }
    }
  }, [cacheKey, catalog, detailIssues, externalIssue, issues, rememberDetail]);

  // The full data for the current selection, resolved from issues seen across
  // any search/filter (not just the current page) so off-page picks still launch.
  const resolvedSelectedIssues = useMemo(() => {
    void seenVersion;
    const out: BrowserIssue[] = [];
    for (const id of selectedIssueIds) {
      const issue = seenIssuesRef.current.get(id) ?? displayIssues.find((i) => i.id === id);
      if (issue) out.push(issue);
    }
    return out;
  }, [selectedIssueIds, displayIssues, seenVersion]);

  const toggleChecked = useCallback((issueId: string, shiftKey: boolean) => {
    setSelectedIssueIds((prev) => {
      const next = new Set(prev);
      if (shiftKey && lastCheckedId) {
        const startIdx = navigableIssues.findIndex((i) => i.id === lastCheckedId);
        const endIdx = navigableIssues.findIndex((i) => i.id === issueId);
        if (startIdx !== -1 && endIdx !== -1) {
          const [lo, hi] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
          for (let i = lo; i <= hi; i++) next.add(navigableIssues[i]!.id);
          return next;
        }
      }
      if (next.has(issueId)) next.delete(issueId);
      else next.add(issueId);
      return next;
    });
    setLastCheckedId(issueId);
  }, [lastCheckedId, navigableIssues]);

  const handleSelectAll = useCallback(() => {
    setSelectedIssueIds((prev) => {
      if (prev.size === displayIssues.length) return new Set();
      return new Set(displayIssues.map((i) => i.id));
    });
  }, [displayIssues]);

  // Accumulate the data of every issue we have displayed, so a selection
  // built up across multiple searches/filters can still be resolved (and launched)
  // even when an earlier pick is no longer on the current filtered page.
  useEffect(() => {
    if (displayIssues.length === 0) return;
    const map = seenIssuesRef.current;
    let changed = false;
    for (const issue of displayIssues) {
      if (map.get(issue.id) !== issue) {
        map.set(issue.id, issue);
        changed = true;
      }
    }
    if (changed) setSeenVersion((v) => v + 1);
  }, [displayIssues]);

  // NOTE: selection deliberately persists across search/filter changes — the
  // user builds up a multi-issue selection by searching for each one. We only
  // drop selections via Clear / Escape, a project switch, or a deep-link request.

  const assigneeOptions = useMemo(
    () => [
      { value: "", label: "Anyone" },
      ...catalog.users.map((user) => ({ value: user.id, label: user.displayName ?? user.name })),
    ],
    [catalog.users],
  );

  const projectFilters = useMemo(() => {
    const quickProjects = new Map<string, CtoLinearQuickViewProject>();
    for (const projectEntry of quickView?.projects ?? []) quickProjects.set(projectEntry.id, projectEntry);
    return catalog.projects.map((projectEntry) => ({
      ...projectEntry,
      quick: quickProjects.get(projectEntry.id) ?? null,
    }));
  }, [catalog.projects, quickView?.projects]);

  const cyclesAvailable = (quickView?.teams ?? []).some((team) => team.cyclesEnabled === true);
  const connected = quickView?.connection.connected === true;

  // Rail counts: open issues for the active state preset, per scope/view and
  // per project. Filters in the list header do not change them.
  const railBase = useMemo<CtoSearchLinearIssuesArgs>(
    () => ({ stateTypes: stateTypesForPreset(filters.statePreset) }),
    [filters.statePreset],
  );
  const scopeCountQueries = useMemo<Record<string, CtoSearchLinearIssuesArgs> | null>(() => {
    if (!connected) return null;
    const queries: Record<string, CtoSearchLinearIssuesArgs> = {
      [`scope:${SCOPE_ALL}`]: railBase,
      [`scope:${SCOPE_MINE}`]: { ...railBase, assignedToViewer: true },
    };
    if (cyclesAvailable) queries[`scope:${SCOPE_CYCLE}`] = { ...railBase, activeCycle: true };
    for (const view of customViews) queries[`scope:${VIEW_SCOPE_PREFIX}${view.id}`] = { ...railBase, customViewId: view.id };
    return queries;
  }, [connected, customViews, cyclesAvailable, railBase]);
  const projectCountQueries = useMemo<Record<string, CtoSearchLinearIssuesArgs> | null>(() => {
    if (!connected || projectFilters.length === 0) return null;
    return Object.fromEntries(projectFilters.slice(0, MAX_COUNTED_PROJECTS).map((projectEntry) => [
      `project:${projectEntry.id}`,
      { ...railBase, projectId: projectEntry.id },
    ]));
  }, [connected, projectFilters, railBase]);
  const scopeCounts = useLinearIssueCounts(cacheKey, scopeCountQueries, RAIL_COUNT_CAP, countsNonce);
  const projectCounts = useLinearIssueCounts(cacheKey, projectCountQueries, RAIL_COUNT_CAP, countsNonce);

  // List counts: only needed while more pages exist; once everything is loaded
  // the loaded rows are the exact counts.
  const listIsComplete = !pageInfo.hasNextPage;
  const listCountQueries = useMemo<Record<string, CtoSearchLinearIssuesArgs> | null>(() => {
    if (listIsComplete || !connected) return null;
    const { first: _first, after: _after, ...base } = buildIssueSearchArgs(filters, null);
    const queries: Record<string, CtoSearchLinearIssuesArgs> = { total: base };
    for (const group of issueGroups) {
      if (group.stateId) queries[`state:${group.stateId}`] = { ...base, stateIds: [group.stateId] };
    }
    return queries;
  }, [connected, filters, issueGroups, listIsComplete]);
  const listCounts = useLinearIssueCounts(cacheKey, listCountQueries, LIST_COUNT_CAP, countsNonce);

  const featuredExtra = featuredIssue && !issues.some((issue) => issue.id === featuredIssue.id) ? 1 : 0;
  // When Linear answered but gave no count for a key (rejected filter, or
  // counts skipped to save rate-limit budget), show the loaded rows with a
  // "+" instead of a spinner that never ends.
  const loadedAtLeast = (loaded: number): string => `${loaded.toLocaleString()}+`;
  const totalLabel = listIsComplete
    ? String(displayIssues.length)
    : formatLinearCount(listCounts?.total)
      ?? (searchTotalCount != null ? searchTotalCount.toLocaleString() : null)
      ?? (listCounts ? loadedAtLeast(displayIssues.length) : null);
  const groupCountLabel = (group: IssueGroup): string | null => {
    if (listIsComplete) return String(group.issues.length);
    const counted = group.stateId ? formatLinearCount(listCounts?.[`state:${group.stateId}`]) : null;
    return counted ?? (listCounts || !group.stateId ? loadedAtLeast(group.issues.length) : null);
  };
  const railScopeCount = (scope: string): string | null => formatLinearCount(scopeCounts?.[`scope:${scope}`]);

  const conflicts = batchActions?.conflicts;

  // Unified launch entry point. When any target issue is already attached to a
  // lane/session we surface a soft confirm first — re-attaching is allowed (the
  // data model supports the same issue on multiple lanes), the user just gets a
  // heads-up. Once confirmed (or when there is no conflict) we hand off to the
  // host's onBatchLaunch.
  const onBatchLaunch = batchActions?.onBatchLaunch;
  const laneLinkedIssueIds = useMemo(() => new Set(conflicts ? [...conflicts.keys()] : []), [conflicts]);
  // "Launch all ready" skips issues that already have a lane or an agent.
  const readyToLaunch = useMemo(
    () => (readyScope ? displayIssues.filter((issue) => !conflicts?.has(issue.id)) : []),
    [conflicts, displayIssues, readyScope],
  );
  const handleBatchLaunch = useCallback(async (launchIssues: BrowserIssue[], options: { laneOnly?: boolean }) => {
    if (!onBatchLaunch || launchIssues.length === 0) return;
    const conflicting = conflicts
      ? launchIssues.map((issue) => conflicts.get(issue.id)).filter((c): c is IssueConflict => Boolean(c))
      : [];
    if (conflicting.length > 0) {
      const laneNames = [...new Set(conflicting.map((c) => c.laneName).filter((n): n is string => Boolean(n)))];
      const target = laneNames.length === 1
        ? `“${laneNames[0]}”`
        : laneNames.length > 1
          ? `${laneNames.length} lanes`
          : "another lane";
      const subject = conflicting.length === 1
        ? "This issue is already attached to"
        : `${conflicting.length} of these issues are already attached to`;
      const ok = typeof window !== "undefined"
        ? await confirmDialog({
          title: `${subject} ${target}.`,
          message: `You can attach ${conflicting.length === 1 ? "it" : "them"} again — proceed?`,
          confirmLabel: "Proceed",
          tone: "warning",
        })
        : true;
      if (!ok) return;
    }
    onBatchLaunch(launchIssues, options);
  }, [onBatchLaunch, conflicts]);

  const handleIssueAction = useCallback(async (issue: BrowserIssue) => {
    const busyIssueId = actionBusyIssueId ?? localActionIssueId;
    if (busyIssueId || actionDisabled) return;
    setLocalActionIssueId(issue.id);
    setError(null);
    try {
      await onIssueAction(issue);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update Linear issue selection.");
    } finally {
      setLocalActionIssueId(null);
    }
  }, [actionBusyIssueId, actionDisabled, localActionIssueId, onIssueAction]);

  const scrollIssueIntoView = useCallback((issueId: string) => {
    const index = listRows.findIndex((row) => row.kind === "issue" && row.issue.id === issueId);
    if (index >= 0) virtualizer.scrollToIndex(index, { align: "auto" });
  }, [listRows, virtualizer]);

  // Keyboard: j/k or arrows move, x checks, Enter runs the primary action,
  // "/" focuses search, Escape clears the checked set. Keys typed into a field
  // are left alone, and a dialog opened on top of the pane keeps its keys.
  const keyStateRef = useRef({
    navigableIssues,
    selectedIssue,
    selectedIssueIds,
    multiSelectEnabled,
    resolvedSelectedIssues,
  });
  keyStateRef.current = { navigableIssues, selectedIssue, selectedIssueIds, multiSelectEnabled, resolvedSelectedIssues };
  const keyActionsRef = useRef({ toggleChecked, handleBatchLaunch, handleIssueAction, scrollIssueIntoView, onBatchLaunch });
  keyActionsRef.current = { toggleChecked, handleBatchLaunch, handleIssueAction, scrollIssueIntoView, onBatchLaunch };

  useEffect(() => {
    const ownsKeyboard = (event: KeyboardEvent): boolean => {
      const root = rootRef.current;
      if (!root || !root.isConnected) return false;
      if (event.metaKey || event.ctrlKey || event.altKey) return false;
      if (isTypingTarget(event.target)) return false;
      const active = document.activeElement;
      if (!active || active === document.body || root.contains(active)) return true;
      const hostDialog = root.closest('[role="dialog"]');
      return Boolean(hostDialog && hostDialog.contains(active));
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !ownsKeyboard(event)) return;
      const state = keyStateRef.current;
      const actions = keyActionsRef.current;
      const move = (delta: number) => {
        const list = state.navigableIssues;
        if (list.length === 0) return;
        const currentIndex = state.selectedIssue ? list.findIndex((issue) => issue.id === state.selectedIssue!.id) : -1;
        const nextIndex = currentIndex < 0 ? 0 : Math.min(list.length - 1, Math.max(0, currentIndex + delta));
        const next = list[nextIndex]!;
        setSelectedIssueId(next.id);
        actions.scrollIssueIntoView(next.id);
        const escapedId = typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(next.id) : next.id.replace(/["\\]/g, "\\$&");
        const row = rootRef.current?.querySelector<HTMLElement>(`[data-linear-issue-row="${escapedId}"]`);
        if (row && rootRef.current?.contains(document.activeElement)) row.focus({ preventScroll: true });
      };
      switch (event.key) {
        case "j":
        case "ArrowDown":
          event.preventDefault();
          move(1);
          return;
        case "k":
        case "ArrowUp":
          event.preventDefault();
          move(-1);
          return;
        case "x":
          if (!state.multiSelectEnabled || !state.selectedIssue) return;
          event.preventDefault();
          actions.toggleChecked(state.selectedIssue.id, event.shiftKey);
          return;
        case "/":
          event.preventDefault();
          searchInputRef.current?.focus();
          searchInputRef.current?.select();
          return;
        case "Enter": {
          if (event.target instanceof HTMLButtonElement) return;
          const checked = state.multiSelectEnabled ? state.resolvedSelectedIssues : [];
          if (actions.onBatchLaunch) {
            const targets = checked.length > 1 ? checked : state.selectedIssue ? [state.selectedIssue] : [];
            if (targets.length === 0) return;
            event.preventDefault();
            void actions.handleBatchLaunch(targets, { laneOnly: false });
          } else if (state.selectedIssue) {
            event.preventDefault();
            void actions.handleIssueAction(state.selectedIssue);
          }
          return;
        }
        default:
      }
    };
    // Capture, so Escape can clear a checked set before the host dialog's own
    // Escape (Radix listens on the document in capture) closes the pane.
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !ownsKeyboard(event)) return;
      if (!keyStateRef.current.multiSelectEnabled || keyStateRef.current.selectedIssueIds.size === 0) return;
      event.preventDefault();
      event.stopPropagation();
      setSelectedIssueIds(new Set());
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keydown", onEscape, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keydown", onEscape, true);
    };
  }, []);

  const showSettingsAction = Boolean(error && onOpenLinearSettings && isConnectionError(error));
  const busyIssueId = actionBusyIssueId ?? localActionIssueId;
  const filtersActive = hasActiveFilters(filters);
  const scopeActive = (scope: string) => !filters.projectId && filters.scope === scope;
  const selectScope = (scope: string) => updateFilters({ scope, projectId: "" });

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col overflow-hidden">
      {error ? (
        <Banner
          model={{
            id: "linear-issue-browser-error",
            tone: "error",
            title: error,
            actions: showSettingsAction
              ? [{ label: "Open Linear settings", variant: "secondary", onClick: onOpenLinearSettings }]
              : undefined,
          }}
          layout="inline"
          style={{ margin: "12px 16px 0" }}
        />
      ) : null}

      <div className="grid min-h-0 flex-1 overflow-hidden md:grid-cols-[220px_minmax(0,1fr)_420px] lg:grid-cols-[240px_minmax(480px,1fr)_460px] 2xl:grid-cols-[280px_minmax(520px,1fr)_600px]">
        <aside className="flex min-h-0 flex-col overflow-hidden border-r border-fg/10 bg-black/10">
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2" data-linear-pane="projects">
            <div className="space-y-px" data-linear-rail="views">
              <ScopeNavButton
                active={scopeActive(SCOPE_ALL)}
                icon={<Stack size={14} />}
                title="All issues"
                count={railScopeCount(SCOPE_ALL)}
                onClick={() => selectScope(SCOPE_ALL)}
              />
              <ScopeNavButton
                active={scopeActive(SCOPE_MINE)}
                icon={<UserCircle size={14} />}
                title="My issues"
                count={railScopeCount(SCOPE_MINE)}
                onClick={() => selectScope(SCOPE_MINE)}
              />
              {inboxAvailable ? (
                <ScopeNavButton
                  active={scopeActive(SCOPE_INBOX)}
                  icon={<Tray size={14} />}
                  title="Inbox"
                  count={formatInboxCount(inboxUnread)}
                  onClick={() => selectScope(SCOPE_INBOX)}
                />
              ) : null}
              <ScopeNavButton
                active={scopeActive(SCOPE_READY)}
                icon={<ReadyIcon size={14} />}
                title="Ready"
                count={readyScope && listIsComplete ? String(displayIssues.length) : null}
                onClick={() => selectScope(SCOPE_READY)}
              />
              {cyclesAvailable ? (
                <ScopeNavButton
                  active={scopeActive(SCOPE_CYCLE)}
                  icon={<Timer size={14} />}
                  title="Current cycle"
                  count={railScopeCount(SCOPE_CYCLE)}
                  onClick={() => selectScope(SCOPE_CYCLE)}
                />
              ) : null}
            </div>

            {customViews.length > 0 ? (
              <>
                <div className="mb-1 mt-3 px-2 text-[11px] text-muted-fg/50">Views</div>
                <div className="space-y-px">
                  {customViews.map((view) => (
                    <ScopeNavButton
                      key={view.id}
                      active={scopeActive(`${VIEW_SCOPE_PREFIX}${view.id}`)}
                      icon={<Funnel size={13} style={view.color ? { color: view.color } : undefined} />}
                      title={view.name}
                      count={railScopeCount(`${VIEW_SCOPE_PREFIX}${view.id}`)}
                      onClick={() => selectScope(`${VIEW_SCOPE_PREFIX}${view.id}`)}
                    />
                  ))}
                </div>
              </>
            ) : null}

            <div className="mb-1 mt-3 flex items-center justify-between gap-2 px-2">
              <span className="text-[11px] text-muted-fg/50">Projects</span>
              {filtersActive ? (
                <button
                  type="button"
                  className="text-[11px] text-muted-fg/55 transition-colors hover:text-fg"
                  onClick={resetFilters}
                >
                  Reset filters
                </button>
              ) : null}
            </div>

            {loadingCatalog && projectFilters.length === 0 ? (
              <div className="rounded-lg border border-fg/[0.06] px-3 py-6 text-center text-[12px] text-muted-fg/50">
                Loading projects...
              </div>
            ) : projectFilters.length > 0 ? (
              <div className="space-y-px">
                {projectFilters.map((projectEntry) => (
                  <ProjectFilterButton
                    key={projectEntry.id}
                    project={projectEntry}
                    active={filters.projectId === projectEntry.id}
                    count={formatLinearCount(projectCounts?.[`project:${projectEntry.id}`])}
                    onClick={() => updateFilters({ projectId: projectEntry.id, scope: SCOPE_ALL })}
                  />
                ))}
              </div>
            ) : (
              <div className="rounded-lg border border-fg/[0.06] px-3 py-6 text-center text-[12px] text-muted-fg/50">
                No visible projects.
              </div>
            )}
          </div>
        </aside>

        <section className="flex min-h-0 flex-col overflow-hidden border-r border-fg/10">
          <div className={cn("shrink-0 space-y-2 border-b border-fg/[0.06] px-3 py-2.5", inboxScope && "hidden")}>
            <div className="relative">
              <MagnifyingGlass size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-fg/45" />
              <input
                ref={searchInputRef}
                value={filters.query}
                onChange={(event) => updateFilters({ query: event.target.value })}
                onKeyDown={(event) => {
                  // Hand the keyboard back to the list (j/k, Enter, x).
                  if (event.key === "ArrowDown" || event.key === "Enter") {
                    event.preventDefault();
                    event.currentTarget.blur();
                  }
                }}
                placeholder="Search issues…  /"
                aria-label="Search issues"
                className="h-8 w-full rounded-md border border-fg/[0.07] bg-black/20 pl-8 pr-3 text-[12px] text-fg outline-none transition-colors placeholder:text-muted-fg/40 focus:border-fg/18"
              />
            </div>

            <div className="flex items-center gap-1">
              {STATE_TABS.map((tab) => (
                <button
                  key={tab.value}
                  type="button"
                  className={cn(
                    "rounded-md px-2 py-1 text-[11px] transition-colors",
                    filters.statePreset === tab.value
                      ? "bg-fg/[0.08] text-fg"
                      : "text-muted-fg/60 hover:bg-fg/[0.04] hover:text-fg/85",
                  )}
                  onClick={() => updateFilters({ statePreset: tab.value })}
                >
                  {tab.label}
                </button>
              ))}
              {loadingIssues ? <CircleNotch size={11} className="ml-auto animate-spin text-muted-fg/50" /> : null}
            </div>

            <div className="grid grid-cols-3 gap-1.5">
              <FilterSelect
                label="Assignee"
                value={filters.assigneeId}
                options={assigneeOptions}
                onChange={(value) => updateFilters({ assigneeId: value })}
              />
              <FilterSelect
                label="Priority"
                value={filters.priority}
                options={PRIORITY_OPTIONS}
                onChange={(value) => updateFilters({ priority: value })}
              />
              <FilterSelect
                label="Sort"
                value={filters.sort}
                options={SORT_OPTIONS}
                onChange={(value) => updateFilters({ sort: value as IssueSort })}
              />
            </div>
          </div>

          {multiSelectEnabled && !inboxScope && displayIssues.length > 0 && (
            <div className="flex shrink-0 items-center gap-2 border-b border-fg/[0.05] px-3 py-1.5">
              <span
                role="checkbox"
                tabIndex={0}
                aria-checked={selectedIssueIds.size === 0 ? false : selectedIssueIds.size === displayIssues.length ? true : "mixed"}
                aria-label="Select all issues"
                onClick={handleSelectAll}
                onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); handleSelectAll(); } }}
                className={cn(
                  "flex h-[14px] w-[14px] shrink-0 cursor-pointer items-center justify-center rounded-[3px] border transition-all",
                  selectedIssueIds.size === displayIssues.length
                    ? "border-[color:var(--color-accent,#A78BFA)] bg-[color:var(--color-accent,#A78BFA)]"
                    : selectedIssueIds.size > 0
                      ? "border-[color:var(--color-accent,#A78BFA)] bg-[color:var(--color-accent,#A78BFA)]/50"
                      : "border-fg/[0.15] bg-transparent hover:border-white/30",
                )}
              >
                {selectedIssueIds.size === displayIssues.length && displayIssues.length > 0 ? (
                  <Check size={10} weight="bold" className="text-accent-fg" />
                ) : selectedIssueIds.size > 0 ? (
                  <Minus size={10} weight="bold" className="text-accent-fg" />
                ) : null}
              </span>
              <span className="text-[11px] tabular-nums text-muted-fg/55">
                {selectedIssueIds.size > 0
                  ? `${selectedIssueIds.size} selected`
                  : totalLabel
                    ? `${totalLabel} ${totalLabel === "1" ? "issue" : "issues"}${!listIsComplete ? ` · ${(issues.length + featuredExtra).toLocaleString()} loaded` : ""}`
                    : `${(issues.length + featuredExtra).toLocaleString()} loaded`}
              </span>
              {selectedIssueIds.size > 0 ? (
                <button
                  type="button"
                  className="ml-auto text-[10px] text-muted-fg/50 transition-colors hover:text-fg/80"
                  onClick={() => setSelectedIssueIds(new Set())}
                >
                  Clear
                </button>
              ) : readyScope && onBatchLaunch && readyToLaunch.length > 0 ? (
                <button
                  type="button"
                  className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-[color:var(--color-accent,#A78BFA)]/15 px-2 py-1 text-[11px] font-medium text-[color:var(--color-accent,#A78BFA)] transition-colors hover:bg-[color:var(--color-accent,#A78BFA)]/25"
                  title="Launch a lane and an agent for every ready issue that has no lane yet"
                  onClick={() => void handleBatchLaunch(readyToLaunch, {})}
                >
                  <RocketLaunch size={12} weight="fill" />
                  Launch all ready · {readyToLaunch.length}
                </button>
              ) : (
                <span className="ml-auto hidden text-[10px] text-muted-fg/35 lg:inline" aria-hidden>
                  j/k move · x select · ↵ launch
                </span>
              )}
            </div>
          )}

          {inboxScope ? (
            <LinearInboxList
              onOpenIssue={(ref) => void handleOpenRelatedIssue(ref)}
              laneIssueIds={laneLinkedIssueIds}
              onUnreadCountChange={setInboxUnread}
            />
          ) : null}
          <div
            ref={issuesScrollRef}
            className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain", inboxScope && "hidden")}
            data-linear-pane="issues"
          >
            {loadingQuickView && !quickView && displayIssues.length === 0 ? (
              <div className="grid h-44 place-items-center text-[12px] text-muted-fg/55">
                <CircleNotch size={16} className="animate-spin" />
              </div>
            ) : displayIssues.length > 0 ? (
              <>
                <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
                  {virtualItems.map((virtualRow) => {
                    const row = listRows[virtualRow.index];
                    if (!row) return null;
                    const pinned = row.kind === "header" && virtualRow.index === activeHeaderIndex;
                    return (
                      <div
                        key={row.kind === "header" ? `header:${row.group.key}` : `issue:${row.issue.id}`}
                        data-index={virtualRow.index}
                        style={{
                          position: pinned ? "sticky" : "absolute",
                          top: 0,
                          left: 0,
                          width: "100%",
                          height: virtualRow.size,
                          zIndex: pinned ? 2 : undefined,
                          ...(pinned ? {} : { transform: `translateY(${virtualRow.start}px)` }),
                        }}
                      >
                        {row.kind === "header" ? (
                          <button
                            type="button"
                            className="flex h-full w-full items-center gap-1.5 border-b border-fg/[0.05] bg-[color:var(--ade-shell-surface,#121019)] px-3 text-left text-[12px] text-muted-fg/70 transition-colors hover:text-fg/85"
                            onClick={() => setCollapsedGroups((current) => ({ ...current, [row.group.key]: !row.collapsed }))}
                          >
                            {row.collapsed ? <CaretRight size={11} className="shrink-0" /> : <CaretDown size={11} className="shrink-0" />}
                            <LinearStateIcon stateType={row.group.stateType} size={12} />
                            <span className="font-medium text-fg/85">{row.group.stateName}</span>
                            <span className="text-[11px] tabular-nums text-muted-fg/45">
                              {groupCountLabel(row.group) ?? "…"}
                            </span>
                          </button>
                        ) : (
                          <LinearBrowserIssueRow
                            issue={row.issue}
                            active={selectedIssue?.id === row.issue.id}
                            eyebrow={featuredIssue?.id === row.issue.id ? featuredIssueLabel : undefined}
                            busy={busyIssueId === row.issue.id}
                            checked={selectedIssueIds.has(row.issue.id)}
                            anyChecked={anyChecked}
                            showCheckbox={multiSelectEnabled}
                            conflict={conflicts?.get(row.issue.id) ?? null}
                            onToggleCheck={(e) => toggleChecked(row.issue.id, e.shiftKey)}
                            onClick={() => setSelectedIssueId(row.issue.id)}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
                {appendingMore ? (
                  <div className="flex items-center justify-center gap-2 px-3 py-3 text-[12px] text-muted-fg/55">
                    <CircleNotch size={13} className="animate-spin" />
                    Loading more…
                  </div>
                ) : pageInfo.hasNextPage && (!canAutoLoadIssues || issues.length >= AUTO_LOAD_MAX_ISSUES) ? (
                  <button
                    type="button"
                    disabled={loadingIssues}
                    className="flex w-full items-center justify-center gap-2 px-3 py-2.5 text-[12px] text-muted-fg/70 transition-colors hover:bg-fg/[0.04] hover:text-fg"
                    onClick={() => searchIssues(true)}
                  >
                    Load more
                  </button>
                ) : null}
              </>
            ) : (
              <div className="px-4 py-12 text-center text-[12px] text-muted-fg/55">
                {loadingIssues ? <CircleNotch size={16} className="mx-auto animate-spin" /> : "No issues match these filters."}
              </div>
            )}
          </div>
        </section>

        {multiSelectEnabled && selectedIssueIds.size > 1 && onBatchLaunch ? (
          <LinearBatchActionView
            selectedIssues={resolvedSelectedIssues}
            onClearSelection={() => setSelectedIssueIds(new Set())}
            conflicts={conflicts}
            onLaunch={handleBatchLaunch}
          />
        ) : (
          <LinearIssueDetails
            issue={selectedIssue}
            catalog={catalog}
            actionLabel={actionLabel}
            actionBusyLabel={actionBusyLabel}
            actionIcon={actionIcon}
            actionBusy={selectedIssue ? busyIssueId === selectedIssue.id : false}
            actionDisabled={actionDisabled || Boolean(busyIssueId && busyIssueId !== selectedIssue?.id)}
            showBranchPreview={showBranchPreview}
            onIssueAction={handleIssueAction}
            conflict={selectedIssue ? conflicts?.get(selectedIssue.id) ?? null : null}
            onLaunch={onBatchLaunch ? handleBatchLaunch : undefined}
            onEdit={canEditIssues ? (issue, edit) => void handleEditIssue(issue, edit) : undefined}
            editPending={selectedIssue ? pendingEditIds.has(selectedIssue.id) : false}
            onOpenIssue={(ref) => void handleOpenRelatedIssue(ref)}
            loadingIssueId={loadingRelationId}
          />
        )}
      </div>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <label className="relative block">
      <span className="sr-only">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 w-full appearance-none rounded-lg border border-fg/[0.07] bg-black/20 px-2.5 pr-7 text-[11px] text-fg outline-none transition-colors focus:border-fg/18"
        aria-label={label}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <CaretDown size={9} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-fg/50" />
    </label>
  );
}
