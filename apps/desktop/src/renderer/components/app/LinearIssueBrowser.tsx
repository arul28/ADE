import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CaretDown,
  CaretRight,
  Check,
  CircleNotch,
  MagnifyingGlass,
  Minus,
  Plus,
  Sparkle,
  Warning,
} from "@phosphor-icons/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { BranchIcon } from "../ui/vcsIcons";

import type {
  CtoGetLinearIssuePickerDataResult,
  CtoLinearIssueComment,
  CtoLinearProject,
  CtoLinearQuickView,
  CtoLinearQuickViewProject,
  CtoSearchLinearIssuesArgs,
  CtoSearchLinearIssuesResult,
  LaneLinearIssue,
  NormalizedLinearIssue,
} from "../../../shared/types";
import { linearIssueBranchName } from "../../../shared/linearIssueBranch";
import { cn } from "../ui/cn";
import { Button } from "../ui/Button";
import {
  issueProjectLabel,
  issueUpdatedLabel,
  linearPriorityLabel,
  toLaneLinearIssue,
} from "../lanes/LinearIssuePicker";
import { LinearPriorityIcon, LinearStateIcon } from "../lanes/linearBrand";
import { LinearProjectIcon } from "../lanes/linearProjectIcon";
import { LinearIssueOpenLink } from "./LinearIssueResolveModals";
import type { IssueConflict } from "../../lib/linearBatchLaunch";

type BrowserIssue = NormalizedLinearIssue | LaneLinearIssue;
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

type LinearIssueBrowserFilters = {
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
const STATE_GROUP_ORDER = ["started", "unstarted", "backlog", "triage", "completed", "canceled", "duplicate"] as const;
const FILTER_STORAGE_PREFIX = "ade.linear.quickView.filters.v1:";
const SELECTION_STORAGE_PREFIX = "ade.linear.quickView.selection.v1:";
const SELECTION_STORAGE_MAX = 100;
const LINEAR_BROWSER_CACHE_STALE_MS = 90_000;
const LINEAR_BROWSER_CACHE_MAX_SEARCHES = 16;

const DEFAULT_FILTERS: LinearIssueBrowserFilters = {
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

type LinearIssueSearchCacheEntry = {
  result: CtoSearchLinearIssuesResult | null;
  fetchedAt: number;
  promise: Promise<CtoSearchLinearIssuesResult> | null;
};

type LinearIssueBrowserCacheEntry = {
  quickView: CtoLinearQuickView | null;
  quickViewFetchedAt: number;
  quickViewPromise: Promise<CtoLinearQuickView> | null;
  catalog: CtoGetLinearIssuePickerDataResult | null;
  catalogFetchedAt: number;
  catalogPromise: Promise<CtoGetLinearIssuePickerDataResult> | null;
  searches: Map<string, LinearIssueSearchCacheEntry>;
};

const linearIssueBrowserCache = new Map<string, LinearIssueBrowserCacheEntry>();
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
  return { projects: [], users: [], states: [] };
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
    searches: new Map(),
  };
  linearIssueBrowserCache.set(key, next);
  return next;
}

function cacheIsFresh(fetchedAt: number): boolean {
  return fetchedAt > 0 && Date.now() - fetchedAt < LINEAR_BROWSER_CACHE_STALE_MS;
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
    first: 50,
    after,
    includeArchived: false,
  };
}

function searchCacheKey(args: CtoSearchLinearIssuesArgs): string {
  return JSON.stringify({
    projectId: args.projectId ?? null,
    stateTypes: [...(args.stateTypes ?? [])].sort(),
    assigneeId: args.assigneeId ?? null,
    priority: args.priority ?? null,
    query: args.query ?? null,
    first: args.first ?? 50,
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
  while (entry.searches.size > LINEAR_BROWSER_CACHE_MAX_SEARCHES) {
    const oldestKey = entry.searches.keys().next().value as string | undefined;
    if (!oldestKey) break;
    entry.searches.delete(oldestKey);
  }
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

function issueListKey(issue: BrowserIssue): string {
  return `${issue.id}:${issue.updatedAt}`;
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

function formatDate(value: string | null | undefined): string {
  if (!value) return "n/a";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date);
}

function hasActiveFilters(filters: LinearIssueBrowserFilters): boolean {
  return (
    filters.projectId !== DEFAULT_FILTERS.projectId
    || filters.statePreset !== DEFAULT_FILTERS.statePreset
    || filters.assigneeId !== DEFAULT_FILTERS.assigneeId
    || filters.priority !== DEFAULT_FILTERS.priority
    || filters.query !== DEFAULT_FILTERS.query
    || filters.sort !== DEFAULT_FILTERS.sort
  );
}

function formatLinearListDate(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function stateGroupRank(stateType: string): number {
  const index = STATE_GROUP_ORDER.indexOf(stateType as typeof STATE_GROUP_ORDER[number]);
  return index === -1 ? 99 : index;
}

function groupIssuesByState(issues: BrowserIssue[]): Array<{
  key: string;
  stateName: string;
  stateType: string;
  issues: BrowserIssue[];
}> {
  const order: string[] = [];
  const groups = new Map<string, { stateName: string; stateType: string; issues: BrowserIssue[] }>();
  for (const issue of issues) {
    const key = issue.stateId || `${issue.stateType}:${issue.stateName}`;
    let group = groups.get(key);
    if (!group) {
      group = { stateName: issue.stateName, stateType: issue.stateType, issues: [] };
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

function stateTypesForPreset(preset: string): string[] {
  if (preset === "all") return [];
  if (preset === "active") return ACTIVE_LINEAR_STATE_TYPES;
  return preset ? [preset] : [];
}

export function linearBrowserIssueToLaneIssue(issue: BrowserIssue): LaneLinearIssue {
  return "raw" in issue ? toLaneLinearIssue(issue) : issue;
}

function isConnectionError(message: string): boolean {
  return /token|oauth|auth|connect|settings|linear/i.test(message);
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
  refreshKey = 0,
  requestedIssueIdentifier,
  requestedIssueRequestKey,
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
  refreshKey?: number;
  requestedIssueIdentifier?: string | null;
  requestedIssueRequestKey?: string | number | null;
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
     * per-row "Has lane"/"Has agent" warning chip and the re-attach confirm.
     */
    conflicts?: Map<string, IssueConflict>;
  };
}) {
  const cacheKey = browserCacheKey(projectRoot);
  const [quickView, setQuickView] = useState<CtoLinearQuickView | null>(() => getBrowserCacheEntry(cacheKey).quickView);
  const [catalog, setCatalog] = useState<CtoGetLinearIssuePickerDataResult>(() => getBrowserCacheEntry(cacheKey).catalog ?? emptyCatalog());
  const [filters, setFilters] = useState<LinearIssueBrowserFilters>(() => safeLoadFilters(projectRoot));
  const [issues, setIssues] = useState<NormalizedLinearIssue[]>(() => readCachedSearch(cacheKey, safeLoadFilters(projectRoot))?.issues ?? []);
  const [pageInfo, setPageInfo] = useState<{ hasNextPage: boolean; endCursor: string | null }>(() => readCachedSearch(cacheKey, safeLoadFilters(projectRoot))?.pageInfo ?? emptyPageInfo());
  const pageInfoRef = useRef(pageInfo);
  const [loadingQuickView, setLoadingQuickView] = useState(false);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [loadingIssues, setLoadingIssues] = useState(false);
  const [localActionIssueId, setLocalActionIssueId] = useState<string | null>(null);
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(featuredIssue?.id ?? null);
  const [selectedIssueIds, setSelectedIssueIds] = useState<Set<string>>(() => safeLoadSelection(projectRoot));
  const [lastCheckedId, setLastCheckedId] = useState<string | null>(null);
  const anyChecked = selectedIssueIds.size > 0;
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const quickViewRequestIdRef = useRef(0);
  const catalogRequestIdRef = useRef(0);
  const searchRequestIdRef = useRef(0);
  const lastRequestedIssueKeyRef = useRef<string | null>(null);
  // Skips the filter-clear effect on the first filters value (mount and on each
  // project/scope switch) so a restored persisted selection is not wiped.
  const filtersInitializedRef = useRef(false);
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
  // the launch modal → back). Cleared automatically when the selection empties
  // (safeSaveSelection removes the key) and when filters change (effect below).
  useEffect(() => {
    safeSaveSelection(projectRoot, selectedIssueIds);
  }, [projectRoot, selectedIssueIds]);

  useEffect(() => {
    const nextFilters = safeLoadFilters(projectRoot);
    const entry = getBrowserCacheEntry(cacheKey);
    const cachedSearch = readCachedSearch(cacheKey, nextFilters);
    setFilters(nextFilters);
    setQuickView(entry.quickView);
    setCatalog(entry.catalog ?? emptyCatalog());
    setIssues(cachedSearch?.issues ?? []);
    setPageInfo(cachedSearch?.pageInfo ?? emptyPageInfo());
    setSelectedIssueIds(safeLoadSelection(projectRoot));
    // This is a project/scope switch, not a user filter change — treat the
    // resulting setFilters as an "initial" pass so the filter-clear effect does
    // not wipe the selection we just restored for the new project.
    filtersInitializedRef.current = false;
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
    if (cachedResult && !force && cacheIsFresh(cached?.fetchedAt ?? 0)) {
      setIssues((current) => append ? mergeIssuePages(current, cachedResult.issues) : cachedResult.issues);
      setPageInfo(cachedResult.pageInfo);
      return;
    }
    if (cachedResult && !append) {
      setIssues(cachedResult.issues);
      setPageInfo(cachedResult.pageInfo);
    }
    setLoadingIssues(force || append || !cachedResult);
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
        setIssues((current) => append ? mergeIssuePages(current, result.issues) : result.issues);
        setPageInfo(result.pageInfo);
      })
      .catch((err) => {
        entry.searches.set(key, { result: cachedResult, fetchedAt: cached?.fetchedAt ?? 0, promise: null });
        if (searchRequestIdRef.current !== requestId) return;
        if (!cachedResult || force) {
          setError(err instanceof Error ? err.message : "Unable to search Linear issues.");
        }
      })
      .finally(() => {
        if (searchRequestIdRef.current === requestId) setLoadingIssues(false);
      });
  }, [cacheKey, filters]);

  useEffect(() => {
    const force = refreshKey > 0;
    loadQuickView(force);
    loadCatalog(force);
  }, [loadCatalog, loadQuickView, refreshKey]);

  useEffect(() => {
    const timer = window.setTimeout(() => searchIssues(false, false), 220);
    return () => window.clearTimeout(timer);
  }, [filters, searchIssues]);

  useEffect(() => {
    if (refreshKey === 0) return;
    searchIssues(false, true);
  }, [refreshKey, searchIssues]);

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
  }, [projectRoot]);

  const sorted = useMemo(() => sortedIssues(issues, filters.sort), [filters.sort, issues]);
  const displayIssues = useMemo<BrowserIssue[]>(() => {
    if (!featuredIssue) return sorted;
    return [
      featuredIssue,
      ...sorted.filter((issue) => issue.id !== featuredIssue.id),
    ];
  }, [featuredIssue, sorted]);

  useEffect(() => {
    const normalized = requestedIssueIdentifier?.trim().toUpperCase() ?? "";
    const requestKey = `${normalized}:${requestedIssueRequestKey ?? ""}`;
    if (!normalized || lastRequestedIssueKeyRef.current === requestKey) return;
    lastRequestedIssueKeyRef.current = requestKey;
    const nextFilters: LinearIssueBrowserFilters = {
      ...DEFAULT_FILTERS,
      query: normalized,
      statePreset: "all",
    };
    setFilters(nextFilters);
    safeSaveFilters(projectRoot, nextFilters);
    setIssues([]);
    setPageInfo({ hasNextPage: false, endCursor: null });
    setSelectedIssueId(null);
    setSelectedIssueIds(new Set());
    safeSaveSelection(projectRoot, new Set());
    setCollapsedGroups({});
  }, [projectRoot, requestedIssueIdentifier, requestedIssueRequestKey]);

  useEffect(() => {
    if (selectedIssueId && displayIssues.some((issue) => issue.id === selectedIssueId)) return;
    setSelectedIssueId(displayIssues[0]?.id ?? null);
  }, [displayIssues, selectedIssueId]);

  useEffect(() => {
    const normalized = requestedIssueIdentifier?.trim().toUpperCase() ?? "";
    if (!normalized) return;
    const match = displayIssues.find((issue) =>
      issue.identifier.trim().toUpperCase() === normalized
      || issue.id.trim() === requestedIssueIdentifier?.trim()
    );
    if (!match || selectedIssueId === match.id) return;
    setSelectedIssueId(match.id);
  }, [displayIssues, requestedIssueIdentifier, selectedIssueId]);

  const selectedIssue = displayIssues.find((issue) => issue.id === selectedIssueId) ?? displayIssues[0] ?? null;

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

  const handleToggleCheck = useCallback((issueId: string, event: React.MouseEvent) => {
    setSelectedIssueIds((prev) => {
      const next = new Set(prev);
      if (event.shiftKey && lastCheckedId) {
        const startIdx = displayIssues.findIndex((i) => i.id === lastCheckedId);
        const endIdx = displayIssues.findIndex((i) => i.id === issueId);
        if (startIdx !== -1 && endIdx !== -1) {
          const [lo, hi] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
          for (let i = lo; i <= hi; i++) next.add(displayIssues[i].id);
        } else {
          // Anchor is stale (no longer in display list) — fall back to toggling clicked row
          if (next.has(issueId)) next.delete(issueId);
          else next.add(issueId);
        }
      } else {
        if (next.has(issueId)) next.delete(issueId);
        else next.add(issueId);
      }
      return next;
    });
    setLastCheckedId(issueId);
  }, [displayIssues, lastCheckedId]);

  const handleSelectAll = useCallback(() => {
    setSelectedIssueIds((prev) => {
      if (prev.size === displayIssues.length) return new Set();
      return new Set(displayIssues.map((i) => i.id));
    });
  }, [displayIssues]);

  // Accumulate the data of every issue we have displayed, so a selection built
  // up across multiple searches/filters can still be resolved (and launched)
  // even when an earlier pick is no longer on the current filtered page.
  useEffect(() => {
    if (displayIssues.length === 0) return;
    const map = seenIssuesRef.current;
    let changed = false;
    for (const issue of displayIssues) {
      if (!map.has(issue.id)) {
        map.set(issue.id, issue);
        changed = true;
      }
    }
    if (changed) setSeenVersion((v) => v + 1);
  }, [displayIssues]);

  // NOTE: selection deliberately persists across search/filter changes — the
  // user builds up a multi-issue selection by searching for each one. We only
  // drop selections via the explicit Clear control, a project switch, or a
  // deep-link request (handled above), never on a query change.

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

  const issueGroups = useMemo(() => groupIssuesByState(displayIssues), [displayIssues]);

  const conflicts = batchActions?.conflicts;

  // Unified launch entry point. When any target issue is already attached to a
  // lane/session we surface a soft confirm first — re-attaching is allowed (the
  // data model supports the same issue on multiple lanes), the user just gets a
  // heads-up. Once confirmed (or when there is no conflict) we hand off to the
  // host's onBatchLaunch.
  const onBatchLaunch = batchActions?.onBatchLaunch;
  const handleBatchLaunch = useCallback((issues: BrowserIssue[], options: { laneOnly?: boolean }) => {
    if (!onBatchLaunch || issues.length === 0) return;
    const conflicting = conflicts
      ? issues.map((issue) => conflicts.get(issue.id)).filter((c): c is IssueConflict => Boolean(c))
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
        ? window.confirm(`${subject} ${target}. You can attach ${conflicting.length === 1 ? "it" : "them"} again — proceed?`)
        : true;
      if (!ok) return;
    }
    onBatchLaunch(issues, options);
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

  const showSettingsAction = Boolean(error && onOpenLinearSettings && isConnectionError(error));
  const busyIssueId = actionBusyIssueId ?? localActionIssueId;
  const filtersActive = hasActiveFilters(filters);
  const issueCountLabel = issues.length > 0 ? `${issues.length}${pageInfo.hasNextPage ? "+" : ""}` : null;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {error ? (
        <div className="mx-4 mt-3 flex shrink-0 flex-wrap items-center gap-2 rounded-lg border border-red-500/25 px-3 py-2 text-[12px] text-red-100" style={{ backgroundColor: "#321B20" }}>
          <Warning size={14} className="shrink-0" />
          <span className="min-w-0 flex-1">{error}</span>
          {showSettingsAction ? (
            <Button type="button" variant="danger" size="sm" onClick={onOpenLinearSettings}>
              Open Linear settings
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1 overflow-hidden md:grid-cols-[220px_minmax(0,1fr)_360px] lg:grid-cols-[260px_minmax(360px,1fr)_420px]">
        <aside className="flex min-h-0 flex-col overflow-hidden border-r border-white/10 bg-black/10">
          <div className="shrink-0 border-b border-white/[0.06] px-3 py-2">
            <ScopeNavButton
              active={!filters.projectId}
              title="All issues"
              subtitle="Across your workspace"
              count={!filters.projectId ? issueCountLabel : null}
              onClick={() => updateFilters({ projectId: "" })}
            />
          </div>

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden px-2 py-2">
            <div className="mb-1.5 flex shrink-0 items-center justify-between gap-2 px-1">
              <span className="text-[11px] text-muted-fg/50">By project</span>
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

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-linear-pane="projects">
              {loadingCatalog && projectFilters.length === 0 ? (
                <div className="rounded-lg border border-white/[0.06] px-3 py-6 text-center text-[12px] text-muted-fg/50">
                  Loading projects...
                </div>
              ) : projectFilters.length > 0 ? (
                projectFilters.map((projectEntry) => (
                  <ProjectFilterButton
                    key={projectEntry.id}
                    project={projectEntry}
                    active={filters.projectId === projectEntry.id}
                    count={filters.projectId === projectEntry.id ? issueCountLabel : null}
                    onClick={() => updateFilters({ projectId: projectEntry.id })}
                  />
                ))
              ) : (
                <div className="rounded-lg border border-white/[0.06] px-3 py-6 text-center text-[12px] text-muted-fg/50">
                  No visible projects.
                </div>
              )}
            </div>
          </div>
        </aside>

        <section className="flex min-h-0 flex-col overflow-hidden border-r border-white/10">
          <div className="shrink-0 space-y-2 border-b border-white/[0.06] px-3 py-2.5">
            <div className="relative">
              <MagnifyingGlass size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-fg/45" />
              <input
                value={filters.query}
                onChange={(event) => updateFilters({ query: event.target.value })}
                placeholder="Search issues…"
                className="h-8 w-full rounded-md border border-white/[0.07] bg-black/20 pl-8 pr-3 text-[12px] text-fg outline-none transition-colors placeholder:text-muted-fg/40 focus:border-white/18"
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
                      ? "bg-white/[0.08] text-fg"
                      : "text-muted-fg/60 hover:bg-white/[0.04] hover:text-fg/85",
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

          {displayIssues.length > 0 && (
            <div className="flex shrink-0 items-center gap-2 border-b border-white/[0.05] px-3 py-1.5">
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
                      : "border-white/[0.15] bg-transparent hover:border-white/30",
                )}
              >
                {selectedIssueIds.size === displayIssues.length && displayIssues.length > 0 ? (
                  <Check size={10} weight="bold" className="text-[#0F0D14]" />
                ) : selectedIssueIds.size > 0 ? (
                  <Minus size={10} weight="bold" className="text-[#0F0D14]" />
                ) : null}
              </span>
              <span className="text-[11px] text-muted-fg/55">
                {selectedIssueIds.size > 0 ? `${selectedIssueIds.size} selected` : `${displayIssues.length} issues`}
              </span>
              {selectedIssueIds.size > 0 && (
                <button
                  type="button"
                  className="ml-auto text-[10px] text-muted-fg/50 hover:text-fg/80 transition-colors"
                  onClick={() => setSelectedIssueIds(new Set())}
                >
                  Clear
                </button>
              )}
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-linear-pane="issues">
            {loadingQuickView && !quickView && displayIssues.length === 0 ? (
              <div className="grid h-44 place-items-center text-[12px] text-muted-fg/55">
                <CircleNotch size={16} className="animate-spin" />
              </div>
            ) : displayIssues.length > 0 ? (
              <>
                {issueGroups.map((group) => {
                  const collapsed = collapsedGroups[group.key] === true;
                  return (
                    <div key={group.key}>
                      <button
                        type="button"
                        className="sticky top-0 z-[1] flex h-8 w-full items-center gap-1.5 border-b border-white/[0.05] bg-[color:var(--ade-shell-surface,#121019)] px-3 text-left text-[12px] text-muted-fg/70 transition-colors hover:text-fg/85"
                        onClick={() => setCollapsedGroups((current) => ({ ...current, [group.key]: !collapsed }))}
                      >
                        {collapsed ? <CaretRight size={11} className="shrink-0" /> : <CaretDown size={11} className="shrink-0" />}
                        <LinearStateIcon stateType={group.stateType} size={12} />
                        <span className="font-medium text-fg/85">{group.stateName}</span>
                        <span className="text-[11px] tabular-nums text-muted-fg/45">{group.issues.length}</span>
                      </button>
                      {!collapsed ? group.issues.map((issue) => (
                        <LinearBrowserIssueRow
                          key={issueListKey(issue)}
                          issue={issue}
                          active={selectedIssue?.id === issue.id}
                          eyebrow={featuredIssue?.id === issue.id ? featuredIssueLabel : undefined}
                          busy={busyIssueId === issue.id}
                          checked={selectedIssueIds.has(issue.id)}
                          anyChecked={anyChecked}
                          conflict={conflicts?.get(issue.id) ?? null}
                          onToggleCheck={(e) => handleToggleCheck(issue.id, e)}
                          onClick={() => setSelectedIssueId(issue.id)}
                        />
                      )) : null}
                    </div>
                  );
                })}
                {pageInfo.hasNextPage ? (
                  <button
                    type="button"
                    className="flex w-full items-center justify-center gap-2 px-3 py-2.5 text-[12px] text-muted-fg/70 transition-colors hover:bg-white/[0.04] hover:text-fg"
                    disabled={loadingIssues}
                    onClick={() => searchIssues(true)}
                  >
                    {loadingIssues ? <CircleNotch size={13} className="animate-spin" /> : null}
                    Load more
                  </button>
                ) : null}
              </>
            ) : (
              <div className="px-4 py-12 text-center text-[12px] text-muted-fg/55">
                No issues match these filters.
              </div>
            )}
          </div>
        </section>

        {selectedIssueIds.size > 1 && onBatchLaunch ? (
          <BatchActionView
            selectedIssues={resolvedSelectedIssues}
            onClearSelection={() => setSelectedIssueIds(new Set())}
            conflicts={conflicts}
            onLaunch={handleBatchLaunch}
          />
        ) : (
          <IssueDetails
            issue={selectedIssue}
            actionLabel={actionLabel}
            actionBusyLabel={actionBusyLabel}
            actionIcon={actionIcon}
            actionBusy={selectedIssue ? busyIssueId === selectedIssue.id : false}
            actionDisabled={actionDisabled || Boolean(busyIssueId && busyIssueId !== selectedIssue?.id)}
            showBranchPreview={showBranchPreview}
            onIssueAction={handleIssueAction}
            conflict={selectedIssue ? conflicts?.get(selectedIssue.id) ?? null : null}
            onLaunch={onBatchLaunch ? handleBatchLaunch : undefined}
          />
        )}
      </div>
    </div>
  );
}

function ScopeNavButton({
  active,
  title,
  subtitle,
  count,
  onClick,
}: {
  active: boolean;
  title: string;
  subtitle: string;
  count: string | null;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
        active
          ? "bg-white/[0.06] text-fg"
          : "text-muted-fg/75 hover:bg-white/[0.04]",
      )}
      onClick={onClick}
    >
      <span className="min-w-0 truncate text-[12px]">
        <span className="font-medium">{title}</span>
        <span className="text-muted-fg/45"> · </span>
        <span className="text-muted-fg/55">{subtitle}</span>
      </span>
      {count ? <span className="shrink-0 text-[10px] tabular-nums text-muted-fg/50">{count}</span> : null}
    </button>
  );
}

function ProjectFilterButton({
  project,
  active,
  count,
  onClick,
}: {
  project: CtoLinearProject & { quick: CtoLinearQuickViewProject | null };
  active: boolean;
  count: string | null;
  onClick: () => void;
}) {
  const quick = project.quick;

  return (
    <button
      type="button"
      className={cn(
        "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left transition-colors",
        active ? "bg-white/[0.06] text-fg" : "text-muted-fg/80 hover:bg-white/[0.04] hover:text-fg",
      )}
      onClick={onClick}
      title={project.name}
    >
      <LinearProjectIcon
        icon={project.icon ?? quick?.icon}
        color={project.color ?? quick?.color}
        name={project.name}
        size={15}
      />
      <span className="min-w-0 flex-1 truncate text-[12px]">{project.name}</span>
      <span className="shrink-0 text-[11px] tabular-nums text-muted-fg/45">
        {count ?? (quick?.issueCount != null ? String(quick.issueCount) : "0")}
      </span>
    </button>
  );
}

function linearIssueListDate(issue: BrowserIssue): string {
  return formatLinearListDate(issue.createdAt) || formatLinearListDate(issue.updatedAt);
}

function LinearBrowserIssueRow({
  issue,
  active,
  eyebrow,
  busy,
  checked,
  anyChecked: anyRowChecked,
  conflict,
  onToggleCheck,
  onClick,
}: {
  issue: BrowserIssue;
  active: boolean;
  eyebrow?: string;
  busy?: boolean;
  checked: boolean;
  anyChecked: boolean;
  conflict?: IssueConflict | null;
  onToggleCheck: (event: React.MouseEvent) => void;
  onClick: () => void;
}) {
  const listDate = linearIssueListDate(issue);

  // The row is a `div role="button"` rather than a real <button> so the
  // checkbox can be a sibling interactive control. A <button> nested inside a
  // <button> is invalid HTML and made checkbox clicks finnicky/missed (the row
  // and checkbox handlers raced), which is what produced the "bounce" on click.
  return (
    <div
      role="button"
      tabIndex={busy ? -1 : 0}
      aria-disabled={busy || undefined}
      aria-pressed={active}
      className={cn(
        "group/row flex h-[34px] w-full items-center gap-3 border-b border-white/[0.04] px-3 text-left transition-colors outline-none focus-visible:bg-white/[0.06]",
        busy && "pointer-events-none opacity-50",
        active ? "bg-white/[0.06]" : "hover:bg-white/[0.03]",
      )}
      onClick={() => { if (!busy) onClick(); }}
      onKeyDown={(e) => {
        if (busy) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
    >
      {/*
        The checkbox is a ≥24px hit target (the inner box stays 14px) so the
        click registers reliably across the whole left gutter — the old 14px
        target was easy to miss. Unselected boxes stay visible (dimmed via
        border/color, not an opacity-collapse) so there is no layout shift or
        "bounce" when the row toggles. stopPropagation keeps the toggle from
        also triggering the row's preview-select.
      */}
      <button
        type="button"
        role="checkbox"
        aria-checked={checked}
        aria-label={checked ? `Deselect ${issue.identifier}` : `Select ${issue.identifier}`}
        onClick={(e) => { e.stopPropagation(); onToggleCheck(e); }}
        className="-ml-1 grid h-6 w-6 shrink-0 cursor-pointer place-items-center rounded-md outline-none focus-visible:bg-white/[0.06]"
      >
        <span
          className={cn(
            "flex h-[14px] w-[14px] items-center justify-center rounded-[3px] border transition-colors",
            checked
              ? "border-[color:var(--color-accent,#A78BFA)] bg-[color:var(--color-accent,#A78BFA)]"
              : anyRowChecked
                ? "border-white/[0.18] bg-transparent group-hover/row:border-white/35"
                : "border-white/[0.12] bg-transparent group-hover/row:border-white/35",
          )}
        >
          {checked ? <Check size={10} weight="bold" className="text-[#0F0D14]" /> : null}
        </span>
      </button>
      <span className="w-[54px] shrink-0 truncate font-mono text-[11px] text-muted-fg/50">
        {issue.identifier}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-fg/90">
        {eyebrow ? (
          <span className="mr-1.5 text-[10px] uppercase tracking-wide text-muted-fg/45">{eyebrow}</span>
        ) : null}
        {issue.title}
      </span>
      {conflict ? <LinearConflictBadge conflict={conflict} /> : null}
      {listDate ? (
        <span className="shrink-0 text-[11px] tabular-nums text-muted-fg/45">
          {listDate}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Subtle Linear-brand warning chip for an issue that is already attached to a
 * lane or chat/CLI session. Intentionally low-key (accent-tinted, not red) — the
 * issue can still be launched again, this is just a heads-up. The lane name
 * rides in the tooltip so the row stays compact.
 */
function LinearConflictBadge({ conflict }: { conflict: IssueConflict }) {
  const label = conflict.reason === "lane" ? "Has lane" : "Has agent";
  const tooltip = conflict.laneName
    ? `Already attached to “${conflict.laneName}”`
    : "Already attached to another lane";
  return (
    <span
      className="shrink-0 rounded-full border px-1.5 py-0.5 text-[9.5px] font-medium leading-none"
      style={{
        borderColor: "rgba(167, 139, 250, 0.28)",
        backgroundColor: "rgba(167, 139, 250, 0.10)",
        color: "rgba(196, 181, 253, 0.95)",
      }}
      title={tooltip}
    >
      {label}
    </span>
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
        className="h-8 w-full appearance-none rounded-lg border border-white/[0.07] bg-black/20 px-2.5 pr-7 text-[11px] text-fg outline-none transition-colors focus:border-white/18"
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

// The single-issue dock mirrors the multi-select dock: one unified launch path
// (lane + agent, or lane only) that opens the same config modal via onLaunch.
// This replaces the old three-way resolve-modal menu.
const SINGLE_LAUNCH_ACTIONS: Array<{
  laneOnly: boolean;
  label: string;
  description: string;
  icon: React.ReactNode;
}> = [
  {
    laneOnly: false,
    label: "Launch lane + agent",
    description: "New lane with this issue linked, plus an agent kicked off on it.",
    icon: <Sparkle size={14} weight="fill" />,
  },
  {
    laneOnly: true,
    label: "Create lane only",
    description: "New lane with this issue linked. Start an agent later.",
    icon: <Plus size={14} weight="bold" />,
  },
];

function IssueDetails({
  issue,
  actionLabel,
  actionBusyLabel,
  actionIcon,
  actionBusy,
  actionDisabled,
  showBranchPreview,
  onIssueAction,
  conflict,
  onLaunch,
}: {
  issue: BrowserIssue | null;
  actionLabel: string;
  actionBusyLabel?: string;
  actionIcon?: React.ReactNode;
  actionBusy: boolean;
  actionDisabled: boolean;
  showBranchPreview: boolean;
  onIssueAction: (issue: BrowserIssue) => void | Promise<void>;
  conflict?: IssueConflict | null;
  onLaunch?: (issues: BrowserIssue[], options: { laneOnly?: boolean }) => void;
}) {
  if (!issue) {
    return (
      <aside className="grid min-h-0 place-items-center overflow-hidden px-4 py-8 text-center text-[12px] text-muted-fg/55">
        Select an issue to preview it.
      </aside>
    );
  }

  const laneIssue = linearBrowserIssueToLaneIssue(issue);
  const branchName = linearIssueBranchName(laneIssue);
  const normalizedIssue = "raw" in issue ? issue : null;
  const description = issue.description?.trim() ?? "";
  return (
    <aside className="flex min-h-0 flex-col overflow-hidden bg-black/[0.08]">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4" data-linear-pane="issue-details">
        <div className="rounded-xl border border-white/[0.07] bg-white/[0.03] p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <LinearPriorityIcon priority={issue.priority} size={12} />
                <LinearStateIcon stateType={issue.stateType} size={12} />
                {issue.url ? (
                  <a
                    href={issue.url}
                    onClick={(e) => { e.preventDefault(); window.ade?.app?.openExternal?.(issue.url!); }}
                    className="cursor-pointer rounded bg-white/[0.07] px-1.5 py-0.5 font-mono text-[10px] text-fg/82 transition-colors hover:bg-white/[0.12]"
                    title="Open in Linear"
                  >
                    {issue.identifier}
                  </a>
                ) : (
                  <span className="rounded bg-white/[0.07] px-1.5 py-0.5 font-mono text-[10px] text-fg/82">
                    {issue.identifier}
                  </span>
                )}
              </div>
              <div className="mt-2 text-[15px] font-semibold leading-snug text-fg/95">{issue.title}</div>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            <span className="rounded-full border border-white/[0.07] bg-white/[0.035] px-2 py-0.5 text-[10.5px] text-muted-fg/75">
              {issue.stateName}
            </span>
            <span className="rounded-full border border-white/[0.07] bg-white/[0.035] px-2 py-0.5 text-[10.5px] text-muted-fg/75">
              {linearPriorityLabel(issue)}
            </span>
            <span className="rounded-full border border-white/[0.07] bg-white/[0.035] px-2 py-0.5 text-[10.5px] text-muted-fg/75">
              {issue.assigneeName ?? "Unassigned"}
            </span>
          </div>
        </div>

        {showBranchPreview ? (
          <div className="mt-3 rounded-lg border border-white/[0.06] bg-black/25 px-3 py-2">
            <div className="text-[10px] font-medium uppercase tracking-[0.10em] text-muted-fg/45">Branch</div>
            <div className="mt-1 flex min-w-0 items-center gap-1.5 font-mono text-[10.5px] text-fg/82">
              <BranchIcon size={11} className="shrink-0" />
              <span className="truncate" title={branchName}>{branchName}</span>
            </div>
          </div>
        ) : null}

        {description ? (
          <div className="mt-3 rounded-xl border border-white/[0.06] bg-white/[0.025] px-3 py-2.5 text-[12px] leading-relaxed text-muted-fg/80">
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
              {description}
            </ReactMarkdown>
          </div>
        ) : null}

        <IssueLabels issue={issue} normalizedIssue={normalizedIssue} />

        <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] text-muted-fg/65">
          <InfoRow label="Project" value={issueProjectLabel(issue)} />
          <InfoRow label="Team" value={issue.teamName ?? issue.teamKey} />
          {normalizedIssue?.cycleName && (
            <InfoRow label="Cycle" value={normalizedIssue.cycleName} />
          )}
          <InfoRow label="Status" value={issue.stateName} />
          <InfoRow label="Priority" value={linearPriorityLabel(issue)} />
          <InfoRow label="Assignee" value={issue.assigneeName ?? "Unassigned"} />
          <InfoRow label="Creator" value={issue.creatorName ?? "Unknown"} />
          <InfoRow label="Estimate" value={issue.estimate != null ? String(issue.estimate) : "n/a"} />
          <InfoRow label="Due" value={formatDate(issue.dueDate)} />
          <InfoRow label="Created" value={formatDate(issue.createdAt)} />
          <InfoRow label="Updated" value={issueUpdatedLabel(issue)} />
          {normalizedIssue ? (
            <>
              <InfoRow label="Started" value={formatDate(normalizedIssue.startedAt)} />
              <InfoRow label="Completed" value={formatDate(normalizedIssue.completedAt)} />
              <InfoRow label="Canceled" value={formatDate(normalizedIssue.canceledAt)} />
              <InfoRow label="Open blockers" value={normalizedIssue.hasOpenBlockers ? `${normalizedIssue.blockerIssueIds.length}` : "None"} />
            </>
          ) : null}
        </div>

        {normalizedIssue?.childIssues && normalizedIssue.childIssues.length > 0 ? (
          <SubIssuesList issues={normalizedIssue.childIssues} />
        ) : null}

        <ActivitySection issueId={issue.id} />
      </div>

      <div
        className="shrink-0 max-h-[42%] overflow-y-auto overscroll-contain border-t border-white/10 bg-[color:color-mix(in_srgb,var(--ade-shell-surface,#121019)_92%,black_8%)] px-4 py-3 shadow-[0_-18px_36px_rgba(0,0,0,0.22)] backdrop-blur-md"
        data-linear-action-dock="true"
      >
        <div className="mb-2 flex min-w-0 items-center gap-2">
          <span className="shrink-0 rounded bg-white/[0.07] px-1.5 py-0.5 font-mono text-[10px] text-fg/80">
            {issue.identifier}
          </span>
          <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-fg/82" title={issue.title}>
            {issue.title}
          </span>
          {conflict ? <LinearConflictBadge conflict={conflict} /> : null}
        </div>
        {onLaunch ? (
          <div className="space-y-2">
            {conflict ? (
              <div className="flex items-start gap-1.5 rounded-lg border border-[color:rgba(167,139,250,0.22)] bg-[color:rgba(167,139,250,0.08)] px-2.5 py-1.5 text-[10.5px] leading-relaxed text-[color:rgba(196,181,253,0.95)]">
                <Warning size={12} className="mt-px shrink-0" />
                <span>
                  {conflict.reason === "lane" ? "Already has a lane" : "Already has an agent"}
                  {conflict.laneName ? ` (“${conflict.laneName}”)` : ""}. You can attach it again.
                </span>
              </div>
            ) : null}
            <div className="grid gap-1.5">
              {SINGLE_LAUNCH_ACTIONS.map((action) => (
                <button
                  key={action.label}
                  type="button"
                  className="grid w-full grid-cols-[28px_minmax(0,1fr)] items-start gap-2.5 rounded-lg border border-white/[0.075] bg-white/[0.025] px-2.5 py-2 text-left transition-colors hover:border-white/[0.16] hover:bg-white/[0.055]"
                  onClick={() => onLaunch([issue], { laneOnly: action.laneOnly })}
                >
                  <span
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-[color:var(--color-accent,#A78BFA)]"
                    style={{ background: "rgba(167, 139, 250, 0.12)" }}
                  >
                    {action.icon}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[11.5px] font-medium leading-snug text-fg/90">{action.label}</span>
                    <span className="mt-0.5 block text-[10.5px] leading-relaxed text-muted-fg/55">{action.description}</span>
                  </span>
                </button>
              ))}
            </div>
            <LinearIssueOpenLink url={issue.url} />
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button
              variant="primary"
              disabled={actionBusy || actionDisabled}
              onClick={() => void onIssueAction(issue)}
            >
              {actionBusy ? <CircleNotch size={14} className="animate-spin" /> : actionIcon ?? <Plus size={14} />}
              {actionBusy ? actionBusyLabel ?? actionLabel : actionLabel}
            </Button>
            <LinearIssueOpenLink url={issue.url} />
          </div>
        )}
      </div>
    </aside>
  );
}

function IssueLabels({ issue, normalizedIssue }: { issue: BrowserIssue; normalizedIssue: NormalizedLinearIssue | null }) {
  const labels = normalizedIssue?.labelColors ?? issue.labels.map((l) => ({ name: l, color: null as string | null }));
  if (labels.length === 0) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      {labels.map((label) => (
        <span
          key={label.name}
          className="rounded-full border px-2 py-0.5 text-[10px]"
          style={{
            borderColor: label.color ? `${label.color}44` : "rgba(255,255,255,0.07)",
            backgroundColor: label.color ? `${label.color}18` : "rgba(255,255,255,0.035)",
            color: label.color ?? "rgba(255,255,255,0.75)",
          }}
        >
          {label.name}
        </span>
      ))}
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-white/[0.05] bg-white/[0.025] px-2.5 py-2">
      <div className="text-[9.5px] font-medium uppercase tracking-[0.10em] text-muted-fg/40">{label}</div>
      <div className="mt-1 truncate text-[11.5px] text-fg/82" title={value}>{value}</div>
    </div>
  );
}

function SubIssuesList({ issues }: { issues: NonNullable<NormalizedLinearIssue["childIssues"]> }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="mt-3">
      <button
        type="button"
        className="flex items-center gap-1.5 text-[11px] font-medium text-muted-fg/65 hover:text-fg/80 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <CaretDown size={10} /> : <CaretRight size={10} />}
        Sub-issues ({issues.length})
      </button>
      {expanded && (
        <div className="mt-1.5 space-y-1 pl-1">
          {issues.map((child) => (
            <div key={child.id} className="flex items-center gap-2 py-0.5">
              <LinearStateIcon stateType={child.stateType} size={10} />
              <span className="font-mono text-[10px] text-fg/60">{child.identifier}</span>
              <span className="min-w-0 flex-1 truncate text-[11px] text-muted-fg/70">{child.title}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ActivitySection({ issueId }: { issueId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [comments, setComments] = useState<CtoLinearIssueComment[] | null>(null);
  const [commentError, setCommentError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const prevIssueIdRef = useRef(issueId);

  if (prevIssueIdRef.current !== issueId) {
    prevIssueIdRef.current = issueId;
    setComments(null);
    setCommentError(null);
    setExpanded(false);
  }

  useEffect(() => {
    if (!expanded || comments || commentError) return;
    let cancelled = false;
    setLoading(true);
    const cto = window.ade?.cto as Record<string, unknown> | undefined;
    const fn = cto?.getLinearIssueComments as ((args: { issueId: string }) => Promise<CtoLinearIssueComment[]>) | undefined;
    if (!fn) { setLoading(false); setComments([]); return; }
    void fn({ issueId })
      .then((result) => { if (!cancelled) setComments(result ?? []); })
      .catch(() => { if (!cancelled) setCommentError("Failed to load comments"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [expanded, issueId, comments, commentError]);

  return (
    <div className="mt-3">
      <button
        type="button"
        className="flex items-center gap-1.5 text-[11px] font-medium text-muted-fg/65 hover:text-fg/80 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <CaretDown size={10} /> : <CaretRight size={10} />}
        Activity
      </button>
      {expanded && (
        <div className="mt-1.5 space-y-2 pl-1">
          {loading ? (
            <div className="text-[10px] text-muted-fg/40">Loading...</div>
          ) : commentError ? (
            <div className="text-[10px] text-red-400/70">{commentError}</div>
          ) : comments && comments.length > 0 ? (
            comments.map((comment) => (
              <div key={comment.id} className="rounded-md border border-white/[0.05] bg-white/[0.02] px-2.5 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-medium text-fg/80">{comment.userDisplayName || comment.userName}</span>
                  <span className="text-[10px] text-muted-fg/40">{formatDate(comment.createdAt)}</span>
                </div>
                <div className="mt-1 text-[11px] leading-relaxed text-muted-fg/70 whitespace-pre-wrap">
                  {comment.body}
                </div>
              </div>
            ))
          ) : (
            <div className="text-[10px] text-muted-fg/40">No comments</div>
          )}
        </div>
      )}
    </div>
  );
}

const BATCH_ACTIONS_CONFIG = [
  { key: "launch", icon: <Sparkle size={13} />, label: "Launch lanes + agents", sublabel: "A lane and an agent kicked off per issue" },
  { key: "create", icon: <Plus size={13} />, label: "Create lanes only", sublabel: "A lane per issue, start agents later" },
] as const;

function BatchActionView({
  selectedIssues,
  onClearSelection,
  conflicts,
  onLaunch,
}: {
  selectedIssues: BrowserIssue[];
  onClearSelection: () => void;
  conflicts?: Map<string, IssueConflict>;
  onLaunch: (issues: BrowserIssue[], options: { laneOnly?: boolean }) => void;
}) {
  const conflictCount = conflicts
    ? selectedIssues.reduce((count, issue) => (conflicts.has(issue.id) ? count + 1 : count), 0)
    : 0;

  return (
    <aside className="flex min-h-0 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3" data-linear-pane="issue-details">
        <div className="flex items-center justify-between">
          <span className="text-[13px] font-semibold text-fg/90">{selectedIssues.length} issues selected</span>
          <button type="button" className="text-[10px] text-muted-fg/50 hover:text-fg/80 transition-colors" onClick={onClearSelection}>
            Clear
          </button>
        </div>
        {conflictCount > 0 ? (
          <div className="mt-2 flex items-start gap-1.5 rounded-lg border border-[color:rgba(167,139,250,0.22)] bg-[color:rgba(167,139,250,0.08)] px-2.5 py-1.5 text-[10.5px] leading-relaxed text-[color:rgba(196,181,253,0.95)]">
            <Warning size={12} className="mt-px shrink-0" />
            <span>
              {conflictCount === 1 ? "1 issue is" : `${conflictCount} issues are`} already attached to a lane. You can attach again — we&apos;ll confirm first.
            </span>
          </div>
        ) : null}
        <div className="mt-2 space-y-1">
          {selectedIssues.map((issue) => {
            const issueConflict = conflicts?.get(issue.id) ?? null;
            return (
              <div key={issue.id} className="flex items-center gap-2 rounded-md bg-white/[0.03] px-2 py-1">
                <span className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-fg/80">{issue.identifier}</span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-muted-fg/70">{issue.title}</span>
                {issueConflict ? <LinearConflictBadge conflict={issueConflict} /> : null}
              </div>
            );
          })}
        </div>
      </div>
      <div className="shrink-0 border-t border-white/10 px-4 py-3" data-linear-action-dock="true">
        <div className="space-y-1.5">
          {BATCH_ACTIONS_CONFIG.map((action) => (
            <button
              key={action.key}
              type="button"
              className="flex w-full items-start gap-2.5 rounded-lg border border-white/[0.07] bg-white/[0.02] px-2.5 py-2 text-left transition-colors hover:border-white/[0.12] hover:bg-white/[0.05]"
              onClick={() => onLaunch(selectedIssues, { laneOnly: action.key === "create" })}
            >
              <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md text-[color:var(--color-accent,#A78BFA)]" style={{ background: "rgba(167, 139, 250, 0.12)" }}>
                {action.icon}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[11.5px] font-medium leading-snug text-fg/90">
                  {`${action.label} · ${selectedIssues.length} ${selectedIssues.length === 1 ? "issue" : "issues"}`}
                </span>
                <span className="mt-0.5 block text-[10.5px] leading-relaxed text-muted-fg/55">{action.sublabel}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </aside>
  );
}
