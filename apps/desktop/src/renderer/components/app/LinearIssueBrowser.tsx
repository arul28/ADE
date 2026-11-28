import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Check,
  CircleNotch,
  Funnel,
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
  LinearIssueDisplayFields,
  LinearIssueOrdering,
  LinearIssueViewType,
  OpenProjectBinding,
  LinearIssueRef,
  NormalizedLinearIssue,
} from "../../../shared/types";
import { cn } from "../ui/cn";
import { Banner } from "../ui/notice/Banner";
import { confirmDialog } from "../ui/dialog/confirm";
import { showToast } from "./toast/toastStore";
import type { IssueConflict } from "../../lib/linearBatchLaunch";
import {
  CONTEXT_ROW_HEIGHT,
  GROUP_HEADER_HEIGHT,
  ISSUE_ROW_HEIGHT,
  SUBGROUP_HEADER_HEIGHT,
  LinearBrowserIssueRow,
  LinearContextRow,
  LinearGroupHeader,
  ProjectFilterButton,
  ScopeNavButton,
  type LinearRowLayout,
} from "./LinearIssueBrowserRows";
// The detail views (and the markdown they render) load with the first selection.
const LinearBatchActionView = React.lazy(() => import("./LinearIssueDetailPane").then((module) => ({ default: module.LinearBatchActionView })));
const LinearIssueDetails = React.lazy(() => import("./LinearIssueDetailPane").then((module) => ({ default: module.LinearIssueDetails })));
import { LinearInboxList } from "./LinearInboxList";
import { requestIssueCreate, subscribeIssueCreated } from "../../lib/issueCreateRequests";
import {
  applyIssueEdit,
  formatLinearCount,
  isNormalizedIssue,
  type BrowserIssue,
  type LinearIssueEdit,
} from "./linearIssueBrowserModel";
import { useActiveRepositoryReader } from "../../state/repositoryScope";
import {
  buildLinearListModel,
  groupPrefill,
  type LinearGroupPrefill,
  type LinearListCatalog,
  type LinearListContextRow,
  type LinearListGroupRow,
  type LinearListRow,
} from "./linear/linearListModel";
import { useLinearDisplayPreferences } from "./linear/linearDisplayPreferences";
import { LinearListToolbar } from "./linear/LinearListToolbar";
import { useLinearIssueAdeStatusIndex } from "./linear/adeStatus";
import { LinearRailSections } from "./linear/LinearRailSections";
import { LinearDocumentReader } from "./linear/LinearDocumentReader";
import { useEscapeLayer } from "./linear/LinearPopover";

export { linearBrowserIssueToLaneIssue } from "./linearIssueBrowserModel";
export type { BrowserIssue } from "./linearIssueBrowserModel";

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
 * viewer), "cycle" (team's active cycle), `view:<id>` (a Linear custom view),
 * or a rail section's `cycle:<id>` / `initiative:<id>` / `label:<id>`. A
 * project pick and a scope are mutually exclusive in the rail. The order of
 * the list is the Display menu's (Linear's own view preferences), not a filter.
 */
type LinearIssueBrowserFilters = {
  scope: string;
  projectId: string;
  statePreset: "active" | "all" | string;
  assigneeId: string;
  priority: string;
  query: string;
};

const STATE_TABS = [
  { value: "active", label: "Active" },
  { value: "backlog", label: "Backlog" },
  { value: "all", label: "All issues" },
] as const;

// Linear's "Active" tab: started and not-started work; Backlog has its own tab.
const ACTIVE_LINEAR_STATE_TYPES = ["unstarted", "started"];
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
const CYCLE_SCOPE_PREFIX = "cycle:";
const INITIATIVE_SCOPE_PREFIX = "initiative:";
const LABEL_SCOPE_PREFIX = "label:";
const PROJECT_SCOPE_PREFIX = "project:";
const DOCUMENT_SCOPE_PREFIX = "document:";
const DETAIL_PANE_STORAGE_KEY = "ade.linear.quickView.detailPane.v1";

const DEFAULT_FILTERS: LinearIssueBrowserFilters = {
  scope: SCOPE_ALL,
  projectId: "",
  statePreset: "all",
  assigneeId: "",
  priority: "",
  query: "",
};

const PRIORITY_OPTIONS = [
  { value: "", label: "Any priority" },
  { value: "1", label: "Urgent" },
  { value: "2", label: "High" },
  { value: "3", label: "Medium" },
  { value: "4", label: "Low" },
  { value: "0", label: "No priority" },
] as const;

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

/** One cache per project, Linear reader machine and bridge object. */
function browserCacheKey(projectRoot: string | null | undefined, readerKey: string | null): string {
  const root = projectRoot?.trim() || "__project__";
  const cto = typeof window === "undefined" ? null : window.ade?.cto;
  return `${root}::reader:${readerKey ?? "none"}::cto:${getCtoCacheScope(cto)}`;
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

function scopeArgs(scope: string): Pick<CtoSearchLinearIssuesArgs, "assignedToViewer" | "activeCycle" | "customViewId" | "stateTypes" | "cycleId" | "initiativeId" | "labelId"> {
  // Ready = not started yet. Issues whose blockers are still open are removed
  // in the pane (Linear's filter only knows whether a blocker relation exists).
  if (scope === SCOPE_READY) return { stateTypes: READY_STATE_TYPES };
  if (scope === SCOPE_MINE) return { assignedToViewer: true };
  if (scope === SCOPE_CYCLE) return { activeCycle: true };
  if (scope.startsWith(VIEW_SCOPE_PREFIX)) return { customViewId: scope.slice(VIEW_SCOPE_PREFIX.length) };
  if (scope.startsWith(CYCLE_SCOPE_PREFIX)) return { cycleId: scope.slice(CYCLE_SCOPE_PREFIX.length) };
  if (scope.startsWith(INITIATIVE_SCOPE_PREFIX)) return { initiativeId: scope.slice(INITIATIVE_SCOPE_PREFIX.length) };
  if (scope.startsWith(LABEL_SCOPE_PREFIX)) return { labelId: scope.slice(LABEL_SCOPE_PREFIX.length) };
  return {};
}

type ServerOrder = { ordering: LinearIssueOrdering; direction: "asc" | "desc" } | null;

function buildIssueSearchArgs(
  filters: LinearIssueBrowserFilters,
  after: string | null,
  order: ServerOrder = null,
): CtoSearchLinearIssuesArgs {
  return {
    // Pages arrive in the Display order, so the first page holds the top of the list.
    ...(order && order.ordering !== "manual" ? { ordering: order.ordering, orderingDirection: order.direction } : {}),
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

function readCachedSearch(
  key: string,
  filters: LinearIssueBrowserFilters,
  order: ServerOrder = null,
): CtoSearchLinearIssuesResult | null {
  return getBrowserCacheEntry(key).searches.get(searchCacheKey(buildIssueSearchArgs(filters, null, order)))?.result ?? null;
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

function hasActiveFilters(filters: LinearIssueBrowserFilters): boolean {
  return (
    filters.scope !== DEFAULT_FILTERS.scope
    || filters.projectId !== DEFAULT_FILTERS.projectId
    || filters.statePreset !== DEFAULT_FILTERS.statePreset
    || filters.assigneeId !== DEFAULT_FILTERS.assigneeId
    || filters.priority !== DEFAULT_FILTERS.priority
    || filters.query !== DEFAULT_FILTERS.query
  );
}

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
        .catch(() => {
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

/** The inbox reads at most 50 items, so 50 means "50 or more". */
function formatInboxCount(unread: number | null): string | null {
  if (!unread) return null;
  return unread >= 50 ? "50+" : String(unread);
}

/** Hides low-value chips first as the list column narrows; the title never wraps. */
function fieldsForWidth(fields: LinearIssueDisplayFields, width: number): LinearIssueDisplayFields {
  if (width <= 0 || width >= 980) return fields;
  const next = { ...fields };
  if (width < 980) next.estimate = false;
  if (width < 880) { next.milestone = false; next.cycle = false; }
  if (width < 820) next.project = false;
  if (width < 660) { next.labels = false; next.updatedAt = false; next.dueDate = false; }
  if (width < 560) next.createdAt = false;
  if (width < 480) { next.pullRequests = false; next.adeStatus = false; }
  return next;
}

/** Column widths for the window: rail, list, details. Narrow windows show the list alone. */
function paneColumns(width: number): { rail: number; detail: number; narrow: boolean } {
  if (width > 0 && width < 760) return { rail: 0, detail: 0, narrow: true };
  if (width < 1100) return { rail: 200, detail: 380, narrow: false };
  if (width < 1400) return { rail: 224, detail: 420, narrow: false };
  if (width < 1700) return { rail: 240, detail: 480, narrow: false };
  return { rail: 256, detail: 540, narrow: false };
}

function safeLoadDetailPane(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(DETAIL_PANE_STORAGE_KEY) !== "hidden";
  } catch {
    return true;
  }
}

function safeSaveDetailPane(visible: boolean): void {
  try {
    if (visible) window.localStorage.removeItem(DETAIL_PANE_STORAGE_KEY);
    else window.localStorage.setItem(DETAIL_PANE_STORAGE_KEY, "hidden");
  } catch {
    // Best effort only.
  }
}

function rowHeight(row: LinearListRow | undefined): number {
  if (!row) return ISSUE_ROW_HEIGHT;
  if (row.kind === "group") return row.depth === 0 ? GROUP_HEADER_HEIGHT : SUBGROUP_HEADER_HEIGHT;
  if (row.kind === "context") return CONTEXT_ROW_HEIGHT;
  return ISSUE_ROW_HEIGHT;
}

function viewTypeFor(filters: LinearIssueBrowserFilters): LinearIssueViewType {
  if (filters.projectId) return "project";
  if (filters.scope === SCOPE_MINE) return "myIssues";
  if (filters.scope === SCOPE_CYCLE || filters.scope.startsWith(CYCLE_SCOPE_PREFIX)) return "cycle";
  if (filters.statePreset === "active") return "activeIssues";
  if (filters.statePreset === "backlog") return "backlog";
  return "allIssues";
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
  // Linear is the repository's (class A): read it from the reader copy. No
  // copy online: nothing is read, and the browser shows its empty state.
  const linearPin = useActiveRepositoryReader();
  const linearPinRef = useRef(linearPin);
  linearPinRef.current = linearPin;
  const cacheKey = browserCacheKey(projectRoot, linearPin?.key ?? null);
  const [quickView, setQuickView] = useState<CtoLinearQuickView | null>(() => getBrowserCacheEntry(cacheKey).quickView);
  const [catalog, setCatalog] = useState<CtoGetLinearIssuePickerDataResult>(() => getBrowserCacheEntry(cacheKey).catalog ?? emptyCatalog());
  const [customViews, setCustomViews] = useState<CtoLinearCustomView[]>(() => getBrowserCacheEntry(cacheKey).views.result ?? []);
  const [filters, setFilters] = useState<LinearIssueBrowserFilters>(() => safeLoadFilters(projectRoot));

  // Display settings are Linear's own, per tab / custom view, read from the reader machine.
  const viewType = viewTypeFor(filters);
  const customViewId = !filters.projectId && filters.scope.startsWith(VIEW_SCOPE_PREFIX)
    ? filters.scope.slice(VIEW_SCOPE_PREFIX.length)
    : null;
  const display = useLinearDisplayPreferences({ pin: linearPin, viewType, customViewId });
  const prefs = display.prefs;
  const serverOrder = useMemo<ServerOrder>(
    () => ({ ordering: prefs.ordering, direction: prefs.orderingDirection }),
    [prefs.ordering, prefs.orderingDirection],
  );

  const [issues, setIssues] = useState<NormalizedLinearIssue[]>(() => readCachedSearch(cacheKey, safeLoadFilters(projectRoot))?.issues ?? []);
  const [pageInfo, setPageInfo] = useState<{ hasNextPage: boolean; endCursor: string | null }>(() => readCachedSearch(cacheKey, safeLoadFilters(projectRoot))?.pageInfo ?? emptyPageInfo());
  const [searchTotalCount, setSearchTotalCount] = useState<number | null>(() => readCachedSearch(cacheKey, safeLoadFilters(projectRoot))?.totalCount ?? null);
  const pageInfoRef = useRef(pageInfo);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const issuesScrollRef = useRef<HTMLDivElement | null>(null);
  const [loadingQuickView, setLoadingQuickView] = useState(false);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [loadingIssues, setLoadingIssues] = useState(false);
  // True only while an infinite-scroll "append" fetch is in flight, so the
  // bottom-of-list spinner doesn't appear during a filter-change reload.
  const [appendingMore, setAppendingMore] = useState(false);
  const [localActionIssueId, setLocalActionIssueId] = useState<string | null>(null);
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(featuredIssue?.id ?? null);
  // The row the keyboard sits on. An issue can show twice (label grouping), so
  // the cursor is a row key, not just the issue id.
  const [cursorRowKey, setCursorRowKey] = useState<string | null>(null);
  const [selectedIssueIds, setSelectedIssueIds] = useState<Set<string>>(() => safeLoadSelection(projectRoot));
  const [lastCheckedId, setLastCheckedId] = useState<string | null>(null);
  const multiSelectEnabled = !singleSelect;
  const anyChecked = multiSelectEnabled && selectedIssueIds.size > 0;
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  // An issue opened from a relation that is not in the current list.
  const [externalIssue, setExternalIssue] = useState<NormalizedLinearIssue | null>(null);
  const [detailIssues, setDetailIssues] = useState<Map<string, NormalizedLinearIssue>>(() => new Map());
  const [loadingRelationId, setLoadingRelationId] = useState<string | null>(null);
  const [pendingEditIds, setPendingEditIds] = useState<Set<string>>(() => new Set());
  const [countsNonce, setCountsNonce] = useState(0);
  const [detailPaneVisible, setDetailPaneVisible] = useState<boolean>(() => safeLoadDetailPane());
  const [narrowDetailOpen, setNarrowDetailOpen] = useState(false);
  const [narrowRailOpen, setNarrowRailOpen] = useState(false);
  const [openDocumentId, setOpenDocumentId] = useState<string | null>(null);
  const [rootWidth, setRootWidth] = useState(0);
  const quickViewRequestIdRef = useRef(0);
  const catalogRequestIdRef = useRef(0);
  const searchRequestIdRef = useRef(0);
  // Accumulated data for every issue displayed this session, so a selection
  // built across multiple searches stays resolvable when an earlier pick is no
  // longer on the current page. seenVersion forces a re-render when it grows.
  const seenIssuesRef = useRef<Map<string, BrowserIssue>>(new Map());
  const [seenVersion, setSeenVersion] = useState(0);
  const adeStatusFor = useLinearIssueAdeStatusIndex();

  // One observer for the whole window; rows read the width tier, never measure.
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = Math.round(entries[0]?.contentRect.width ?? 0);
      setRootWidth((current) => (Math.abs(current - width) >= 8 ? width : current));
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

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
    setOpenDocumentId(null);
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
    const pin = linearPinRef.current;
    if (!window.ade.cto?.getLinearQuickView || !pin) return;
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
    const promise = entry.quickViewPromise ?? window.ade.cto.getLinearQuickView(pin);
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
    const pin = linearPinRef.current;
    if (!cto?.getLinearIssuePickerData) {
      setError("Linear controls are not available in this ADE surface.");
      return;
    }
    if (!pin) return;
    if (!force && entry.catalog && cacheIsFresh(entry.catalogFetchedAt)) {
      setCatalog(entry.catalog);
      return;
    }
    if (entry.catalog) setCatalog(entry.catalog);
    const requestId = catalogRequestIdRef.current + 1;
    catalogRequestIdRef.current = requestId;
    setLoadingCatalog(force || !entry.catalog);
    setError(null);
    const promise = entry.catalogPromise ?? cto.getLinearIssuePickerData(pin);
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
    const pin = linearPinRef.current;
    if (!cto?.getLinearCustomViews || !pin) return;
    if (!force && entry.views.result && cacheIsFresh(entry.views.fetchedAt)) {
      setCustomViews(entry.views.result);
      return;
    }
    const promise = entry.views.promise ?? cto.getLinearCustomViews(pin);
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
    const pin = linearPinRef.current;
    if (!cto?.searchLinearIssues) {
      setError("Linear issue search is not available in this ADE surface.");
      return;
    }
    if (!pin) return;
    const requestId = searchRequestIdRef.current + 1;
    searchRequestIdRef.current = requestId;
    const entry = getBrowserCacheEntry(cacheKey);
    const args = buildIssueSearchArgs(filters, append ? pageInfoRef.current.endCursor : null, serverOrder);
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
    const promise = cached?.promise ?? cto.searchLinearIssues(args, pin);
    entry.searches.set(key, {
      result: cachedResult,
      fetchedAt: cached?.fetchedAt ?? 0,
      promise,
    });
    void promise
      .then((result) => {
        rememberSearchResult(entry, key, result);
        // A newer request (another filter, another machine) owns the list now.
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
  }, [cacheKey, filters, serverOrder]);

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
    // Only a refresh press reloads; filter changes go through the debounce above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, refreshKey]);

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

  const readyScope = !filters.projectId && filters.scope === SCOPE_READY;
  const inboxScope = !filters.projectId && filters.scope === SCOPE_INBOX;
  const [inboxUnread, setInboxUnread] = useState<number | null>(null);
  const inboxAvailable = typeof window !== "undefined" && typeof window.ade?.cto?.getLinearInbox === "function";
  // The rail shows the unread count before the inbox is opened.
  useEffect(() => {
    if (!inboxAvailable || !linearPin) return;
    let cancelled = false;
    void window.ade.cto!.getLinearInbox({ first: 50 }, linearPin)
      .then((items) => { if (!cancelled) setInboxUnread(items.length); })
      .catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inboxAvailable, linearPin?.key]);
  const displayIssues = useMemo<BrowserIssue[]>(() => {
    const visible = readyScope
      ? issues.filter((issue) => !issue.hasOpenBlockers)
      : issues;
    if (!featuredIssue) return visible;
    return [
      featuredIssue,
      ...visible.filter((issue) => issue.id !== featuredIssue.id),
    ];
  }, [featuredIssue, issues, readyScope]);
  const canAutoLoadIssues = typeof IntersectionObserver !== "undefined";

  const listCatalog = useMemo<LinearListCatalog>(() => ({
    states: catalog.states,
    users: catalog.users,
    projects: catalog.projects,
    labels: catalog.labels ?? [],
    teams: (quickView?.teams ?? []).map((team) => ({ id: team.id, key: team.key, name: team.displayName || team.name, color: team.color })),
    viewerId: quickView?.viewer?.id ?? quickView?.connection.viewerId ?? null,
  }), [catalog, quickView?.connection.viewerId, quickView?.teams, quickView?.viewer?.id]);

  const scopeTeamKeys = useMemo<string[] | null>(() => {
    if (filters.projectId) {
      const project = catalog.projects.find((entry) => entry.id === filters.projectId);
      return project?.teamKey ? [project.teamKey] : null;
    }
    return null;
  }, [catalog.projects, filters.projectId]);
  const allowedStateTypes = useMemo(
    () => (readyScope ? READY_STATE_TYPES : stateTypesForPreset(filters.statePreset)),
    [filters.statePreset, readyScope],
  );

  // One pass: group, sub-group, order, nest. Cheap enough to run on every change.
  const listModel = useMemo(() => buildLinearListModel({
    issues: displayIssues,
    prefs,
    catalog: listCatalog,
    collapsed,
    allowedStateTypes,
    teamKeys: scopeTeamKeys,
  }), [allowedStateTypes, collapsed, displayIssues, listCatalog, prefs, scopeTeamKeys]);
  const listRows = listModel.rows;
  const headerIndices = listModel.headerIndices;
  const cursorKeyShown = useMemo(
    () => cursorRowKey != null && listRows.some((row) => row.key === cursorRowKey),
    [cursorRowKey, listRows],
  );
  // Keyboard order: what is on screen, top to bottom, skipping collapsed groups and context rows.
  const navigableIssues = useMemo(
    () => listModel.navigable.map((index) => (listRows[index] as Extract<LinearListRow, { kind: "issue" }>).issue),
    [listModel.navigable, listRows],
  );

  const virtualizer = useVirtualizer({
    count: listRows.length,
    getScrollElement: () => issuesScrollRef.current,
    estimateSize: (index) => rowHeight(listRows[index]),
    getItemKey: (index) => listRows[index]?.key ?? index,
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
  // Row kinds have different heights; re-measure when the rows change shape.
  useEffect(() => {
    virtualizer.measure();
  }, [listRows, virtualizer]);
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
    setSelectedIssueId(navigableIssues[0]?.id ?? displayIssues[0]?.id ?? null);
  }, [displayIssues, externalIssue, navigableIssues, selectedIssueId]);

  const listSelectedIssue = displayIssues.find((issue) => issue.id === selectedIssueId)
    ?? (externalIssue && externalIssue.id === selectedIssueId ? externalIssue : null)
    ?? navigableIssues[0]
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
    const pin = linearPinRef.current;
    if (!fn || !pin) return null;
    const issue = await fn({ issueId }, pin);
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
    setOpenDocumentId(null);
  }), [rememberDetail]);

  const openIssueById = useCallback(async (idOrIdentifier: string, label: string) => {
    const listed = displayIssues.find((issue) => issue.id === idOrIdentifier || issue.identifier === idOrIdentifier);
    setOpenDocumentId(null);
    if (listed) {
      setSelectedIssueId(listed.id);
      return;
    }
    setLoadingRelationId(idOrIdentifier);
    try {
      const issue = await fetchIssueDetail(idOrIdentifier);
      if (!issue) {
        showToast({ tone: "warning", title: `Couldn't open ${label}`, message: "Linear did not return that issue." });
        return;
      }
      setExternalIssue(issue);
      setSelectedIssueId(issue.id);
    } catch (err) {
      showToast({
        tone: "error",
        title: `Couldn't open ${label}`,
        message: err instanceof Error ? err.message : "Linear request failed.",
      });
    } finally {
      setLoadingRelationId(null);
    }
  }, [displayIssues, fetchIssueDetail]);

  const handleOpenRelatedIssue = useCallback(
    (ref: Pick<LinearIssueRef, "id" | "identifier">) => openIssueById(ref.id, ref.identifier),
    [openIssueById],
  );

  // Optimistic edit: patch every local copy, send one issueUpdate, then take
  // Linear's copy on success or restore the snapshot and toast on failure.
  // The list model regroups at once, so a status edit moves the row.
  const canEditIssues = typeof window !== "undefined" && typeof window.ade?.cto?.updateLinearIssue === "function";
  const editSequenceRef = useRef(new Map<string, number>());
  const handleEditIssue = useCallback(async (issue: BrowserIssue, edit: LinearIssueEdit) => {
    const update = window.ade?.cto?.updateLinearIssue;
    const pin = linearPinRef.current;
    if (!update || !pin) return;
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
      const updated = await update({ issueId, ...edit }, pin);
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

  const projectLooks = useMemo(() => {
    const looks = new Map<string, { icon: string | null; color: string | null }>();
    for (const entry of projectFilters) {
      looks.set(entry.id, { icon: entry.icon ?? entry.quick?.icon ?? null, color: entry.color ?? entry.quick?.color ?? null });
    }
    return looks;
  }, [projectFilters]);

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
  const scopeCounts = useLinearIssueCounts(cacheKey, linearPin, scopeCountQueries, RAIL_COUNT_CAP, countsNonce);
  const projectCounts = useLinearIssueCounts(cacheKey, linearPin, projectCountQueries, RAIL_COUNT_CAP, countsNonce);

  // List counts: only needed while more pages exist; once everything is loaded
  // the loaded rows are the exact counts. Linear counts by status; other
  // groupings show the loaded rows with a "+".
  const listIsComplete = !pageInfo.hasNextPage;
  const statusGroupIds = useMemo(
    () => (prefs.grouping === "workflowState"
      ? listModel.groups.map(({ group }) => [group.key, group.ids] as const).filter(([, ids]) => ids.length > 0)
      : []),
    [listModel.groups, prefs.grouping],
  );
  const statusGroupSignature = statusGroupIds.map(([key, ids]) => `${key}=${ids.join(",")}`).join("|");
  const listCountQueries = useMemo<Record<string, CtoSearchLinearIssuesArgs> | null>(() => {
    if (listIsComplete || !connected) return null;
    const { first: _first, after: _after, ordering: _ordering, orderingDirection: _direction, ...base } = buildIssueSearchArgs(filters, null);
    const queries: Record<string, CtoSearchLinearIssuesArgs> = { total: base };
    for (const [key, ids] of statusGroupIds) queries[`group:${key}`] = { ...base, stateIds: [...ids] };
    return queries;
    // The signature stands for the group ids, so a regroup with the same ids does not re-ask.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, filters, listIsComplete, statusGroupSignature]);
  const listCounts = useLinearIssueCounts(cacheKey, linearPin, listCountQueries, LIST_COUNT_CAP, countsNonce);

  const featuredExtra = featuredIssue && !issues.some((issue) => issue.id === featuredIssue.id) ? 1 : 0;
  // When Linear answered but gave no count for a key (rejected filter, or
  // counts skipped to save rate-limit budget), show the loaded rows with a
  // "+" instead of a spinner that never ends.
  const loadedAtLeast = (loaded: number): string => `${loaded.toLocaleString()}+`;
  const totalLabel = listIsComplete
    ? String(listModel.issueCount)
    : formatLinearCount(listCounts?.total)
      ?? (searchTotalCount != null ? searchTotalCount.toLocaleString() : null)
      ?? (listCounts ? loadedAtLeast(displayIssues.length) : null);
  const groupCountLabel = (row: LinearListGroupRow): string | null => {
    if (listIsComplete) return row.count.toLocaleString();
    if (row.depth === 0 && row.group.grouping === "workflowState" && row.group.ids.length > 0) {
      const counted = formatLinearCount(listCounts?.[`group:${row.group.key}`]);
      return counted ?? (listCounts ? loadedAtLeast(row.count) : null);
    }
    return loadedAtLeast(row.count);
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

  const scrollRowIntoView = useCallback((index: number) => {
    if (index >= 0) virtualizer.scrollToIndex(index, { align: "auto" });
  }, [virtualizer]);

  const toggleCollapsed = useCallback((key: string, force?: boolean) => {
    setCollapsed((current) => {
      const has = current.has(key);
      const want = force ?? !has;
      if (want === has) return current;
      const next = new Set(current);
      if (want) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);
  const toggleChildren = useCallback((issueId: string) => toggleCollapsed(`p:${issueId}`), [toggleCollapsed]);
  const handleRowCheck = useCallback((issueId: string, event: React.MouseEvent) => toggleChecked(issueId, event.shiftKey), [toggleChecked]);
  const handleRowSelect = useCallback((issueId: string, rowKey: string) => {
    setSelectedIssueId(issueId);
    setCursorRowKey(rowKey);
    setOpenDocumentId(null);
  }, []);
  const handleContextOpen = useCallback((ref: LinearListContextRow["ref"]) => {
    void handleOpenRelatedIssue(ref);
  }, [handleOpenRelatedIssue]);

  // A group's "+" opens ADE's create form with the group's fields filled in.
  const handleGroupCreate = useCallback((index: number) => {
    const row = listRows[index];
    if (!row || row.kind !== "group") return;
    let parent: LinearListGroupRow | null = null;
    if (row.depth === 1) {
      for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
        const candidate = listRows[cursor];
        if (candidate?.kind === "group" && candidate.depth === 0) { parent = candidate; break; }
      }
    }
    // The scope fills what the group leaves open (a project, a cycle, a label, "mine").
    const scope = filters.projectId ? "" : filters.scope;
    const scopePrefill: LinearGroupPrefill = {
      ...(filters.projectId ? { projectId: filters.projectId } : {}),
      ...(scope.startsWith(CYCLE_SCOPE_PREFIX) ? { cycleId: scope.slice(CYCLE_SCOPE_PREFIX.length) } : {}),
      ...(scope.startsWith(LABEL_SCOPE_PREFIX) ? { labelIds: [scope.slice(LABEL_SCOPE_PREFIX.length)] } : {}),
      ...(scope === SCOPE_MINE && listCatalog.viewerId ? { assigneeId: listCatalog.viewerId } : {}),
    };
    const prefill: LinearGroupPrefill = { ...scopePrefill, ...groupPrefill(row.group, parent?.group ?? null) };
    if (!prefill.teamKey) {
      // A team the group's issues share, else the scope's only team.
      for (let cursor = index + 1; cursor < listRows.length; cursor += 1) {
        const candidate = listRows[cursor];
        if (!candidate || (candidate.kind === "group" && candidate.depth <= row.depth)) break;
        if (candidate.kind === "issue") { prefill.teamKey = candidate.issue.teamKey; break; }
      }
      if (!prefill.teamKey && scopeTeamKeys?.length === 1) prefill.teamKey = scopeTeamKeys[0];
      if (!prefill.teamKey && listCatalog.teams.length === 1) prefill.teamKey = listCatalog.teams[0]!.key;
    }
    requestIssueCreate({ provider: "linear", origin: "pane", prefill: { linear: prefill } });
  }, [filters.projectId, filters.scope, listCatalog.teams, listCatalog.viewerId, listRows, scopeTeamKeys]);

  // Keyboard: j/k or arrows move, left/right fold a parent or a group, x
  // checks, Enter runs the primary action, "/" focuses search, Escape clears
  // the checked set. Keys typed into a field are left alone, and a dialog or
  // popover opened on top of the pane keeps its keys.
  const keyStateRef = useRef({
    listRows,
    navigable: listModel.navigable,
    cursorRowKey,
    selectedIssue,
    selectedIssueIds,
    multiSelectEnabled,
    resolvedSelectedIssues,
  });
  keyStateRef.current = { listRows, navigable: listModel.navigable, cursorRowKey, selectedIssue, selectedIssueIds, multiSelectEnabled, resolvedSelectedIssues };
  const keyActionsRef = useRef({ toggleChecked, handleBatchLaunch, handleIssueAction, scrollRowIntoView, onBatchLaunch, toggleCollapsed });
  keyActionsRef.current = { toggleChecked, handleBatchLaunch, handleIssueAction, scrollRowIntoView, onBatchLaunch, toggleCollapsed };

  useEffect(() => {
    const ownsKeyboard = (event: KeyboardEvent): boolean => {
      const root = rootRef.current;
      if (!root || !root.isConnected) return false;
      if (event.metaKey || event.ctrlKey || event.altKey) return false;
      if (isTypingTarget(event.target)) return false;
      if (event.target instanceof Element && event.target.closest("[data-linear-popover]")) return false;
      const active = document.activeElement;
      if (active instanceof Element && active.closest("[data-linear-popover]")) return false;
      if (!active || active === document.body || root.contains(active)) return true;
      const hostDialog = root.closest('[role="dialog"]');
      return Boolean(hostDialog && hostDialog.contains(active));
    };
    const currentRowIndex = (): number => {
      const state = keyStateRef.current;
      const rows = state.listRows;
      if (state.cursorRowKey) {
        const byKey = state.navigable.find((index) => rows[index]?.key === state.cursorRowKey);
        if (byKey != null && (rows[byKey] as Extract<LinearListRow, { kind: "issue" }>).issue.id === state.selectedIssue?.id) return byKey;
      }
      const selectedId = state.selectedIssue?.id;
      if (!selectedId) return -1;
      return state.navigable.find((index) => {
        const row = rows[index];
        return row?.kind === "issue" && row.issue.id === selectedId;
      }) ?? -1;
    };
    const focusRow = (rowKey: string) => {
      const escaped = typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(rowKey) : rowKey.replace(/["\\]/g, "\\$&");
      const element = rootRef.current?.querySelector<HTMLElement>(`[data-linear-row-key="${escaped}"]`);
      if (element && rootRef.current?.contains(document.activeElement)) element.focus({ preventScroll: true });
    };
    const goToRow = (index: number) => {
      const row = keyStateRef.current.listRows[index];
      if (!row || row.kind !== "issue") return;
      setSelectedIssueId(row.issue.id);
      setCursorRowKey(row.key);
      setOpenDocumentId(null);
      keyActionsRef.current.scrollRowIntoView(index);
      // The row may mount a frame later when it scrolls into the window.
      window.requestAnimationFrame(() => focusRow(row.key));
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !ownsKeyboard(event)) return;
      const state = keyStateRef.current;
      const actions = keyActionsRef.current;
      const move = (delta: number) => {
        const list = state.navigable;
        if (list.length === 0) return;
        const current = currentRowIndex();
        const position = current < 0 ? -1 : list.indexOf(current);
        const nextPosition = position < 0 ? 0 : Math.min(list.length - 1, Math.max(0, position + delta));
        goToRow(list[nextPosition]!);
      };
      const headerPath = event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-linear-group-header]")?.dataset.linearGroupHeader ?? null
        : null;
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
        case "ArrowLeft":
        case "ArrowRight": {
          const collapse = event.key === "ArrowLeft";
          if (headerPath) {
            event.preventDefault();
            actions.toggleCollapsed(`g:${headerPath}`, collapse);
            return;
          }
          const index = currentRowIndex();
          const row = index >= 0 ? state.listRows[index] : null;
          if (!row || row.kind !== "issue") return;
          event.preventDefault();
          if (collapse && row.childCount > 0 && !row.childrenCollapsed) {
            actions.toggleCollapsed(`p:${row.issue.id}`, true);
          } else if (collapse && row.depth > 0) {
            // Already folded (or a leaf): step up to the parent row.
            for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
              const candidate = state.listRows[cursor];
              if (!candidate || candidate.kind === "group") break;
              if (candidate.kind === "issue" && candidate.depth < row.depth) { goToRow(cursor); break; }
              if (candidate.kind === "context") break;
            }
          } else if (!collapse && row.childCount > 0 && row.childrenCollapsed) {
            actions.toggleCollapsed(`p:${row.issue.id}`, false);
          }
          return;
        }
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
  const selectScope = (scope: string) => {
    setOpenDocumentId(null);
    setNarrowRailOpen(false);
    updateFilters({ scope, projectId: "" });
  };
  // Rail sections (cycles, initiatives, favorites, documents) speak in scope strings.
  const handleRailScope = useCallback((scope: string) => {
    setNarrowRailOpen(false);
    if (scope.startsWith(DOCUMENT_SCOPE_PREFIX)) {
      setOpenDocumentId(scope.slice(DOCUMENT_SCOPE_PREFIX.length));
      setNarrowDetailOpen(true);
      return;
    }
    setOpenDocumentId(null);
    if (scope.startsWith(PROJECT_SCOPE_PREFIX)) {
      updateFilters({ projectId: scope.slice(PROJECT_SCOPE_PREFIX.length), scope: SCOPE_ALL });
      return;
    }
    updateFilters({ scope, projectId: "" });
  }, [updateFilters]);
  const activeRailScope = openDocumentId
    ? `${DOCUMENT_SCOPE_PREFIX}${openDocumentId}`
    : filters.projectId ? `${PROJECT_SCOPE_PREFIX}${filters.projectId}` : filters.scope;

  // Breadcrumb: the team when the workspace has one, else the workspace.
  const teams = quickView?.teams ?? [];
  const singleTeam = teams.length === 1 ? teams[0]! : null;
  const railTeamKey = singleTeam?.key ?? scopeTeamKeys?.[0] ?? null;
  const crumbRoot = singleTeam
    ? { label: singleTeam.displayName || singleTeam.name, color: singleTeam.color, initial: singleTeam.key.charAt(0) }
    : { label: quickView?.organization?.name ?? "Linear", color: null, initial: (quickView?.organization?.name ?? "L").charAt(0) };
  const currentCrumb = (() => {
    if (filters.projectId) return catalog.projects.find((entry) => entry.id === filters.projectId)?.name ?? "Project";
    const scope = filters.scope;
    if (scope === SCOPE_MINE) return "My issues";
    if (scope === SCOPE_READY) return "Ready";
    if (scope === SCOPE_INBOX) return "Inbox";
    if (scope === SCOPE_CYCLE) return "Current cycle";
    if (scope.startsWith(VIEW_SCOPE_PREFIX)) return customViews.find((view) => view.id === customViewId)?.name ?? "View";
    if (scope.startsWith(LABEL_SCOPE_PREFIX)) return catalog.labels?.find((label) => label.id === scope.slice(LABEL_SCOPE_PREFIX.length))?.name ?? "Label";
    if (scope.startsWith(CYCLE_SCOPE_PREFIX)) {
      const id = scope.slice(CYCLE_SCOPE_PREFIX.length);
      return issues.find((issue) => issue.cycleId === id)?.cycleName ?? "Cycle";
    }
    if (scope.startsWith(INITIATIVE_SCOPE_PREFIX)) return "Initiative";
    return "Issues";
  })();

  const columns = paneColumns(rootWidth);
  const showRail = !columns.narrow;
  const detailOpen = columns.narrow ? narrowDetailOpen : detailPaneVisible;
  // A multi-select always shows its launch panel, even with details hidden.
  const batchView = multiSelectEnabled && selectedIssueIds.size > 1 && Boolean(onBatchLaunch);
  const showDetailColumn = !columns.narrow && (detailPaneVisible || batchView || openDocumentId != null);
  const listWidth = rootWidth > 0
    ? rootWidth - (showRail ? columns.rail : 0) - (showDetailColumn ? columns.detail : 0)
    : 0;
  const rowLayout = useMemo<LinearRowLayout>(() => ({
    fields: fieldsForWidth(prefs.fields, listWidth),
    identifierChars: listModel.identifierChars,
    showCheckbox: multiSelectEnabled,
    compactLabels: listWidth > 0 && listWidth < 900,
    projectLook: (projectId: string) => projectLooks.get(projectId) ?? null,
  }), [listModel.identifierChars, listWidth, multiSelectEnabled, prefs.fields, projectLooks]);
  const gridTemplateColumns = [
    showRail ? `${columns.rail}px` : null,
    "minmax(0,1fr)",
    showDetailColumn ? `${columns.detail}px` : null,
  ].filter(Boolean).join(" ");
  // Overlays on a narrow window close with Escape, not the whole pane.
  useEscapeLayer(columns.narrow && narrowRailOpen, () => setNarrowRailOpen(false));
  useEscapeLayer(columns.narrow && narrowDetailOpen && !narrowRailOpen, () => setNarrowDetailOpen(false));
  const toggleDetailPane = () => {
    if (columns.narrow) {
      setNarrowDetailOpen((value) => !value);
      return;
    }
    setDetailPaneVisible((value) => {
      safeSaveDetailPane(!value);
      return !value;
    });
  };

  const detailContent = (
    <React.Suspense fallback={null}>
      {openDocumentId ? (
        <LinearDocumentReader pin={linearPin} documentId={openDocumentId} onClose={() => setOpenDocumentId(null)} />
      ) : batchView && onBatchLaunch ? (
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
          adeStatus={selectedIssue && isNormalizedIssue(selectedIssue) ? adeStatusFor(selectedIssue) : null}
          onLaunch={onBatchLaunch ? handleBatchLaunch : undefined}
          onEdit={canEditIssues ? (issue, edit) => void handleEditIssue(issue, edit) : undefined}
          editPending={selectedIssue ? pendingEditIds.has(selectedIssue.id) : false}
          onOpenIssue={(ref) => void handleOpenRelatedIssue(ref)}
          loadingIssueId={loadingRelationId}
        />
      )}
    </React.Suspense>
  );

  const railContent = (
      <aside className={cn("flex min-h-0 flex-col overflow-hidden border-r border-fg/[0.07]", columns.narrow ? "h-full bg-[color:var(--ade-shell-surface,#121019)]" : "bg-fg/[0.015]")}>
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

          <LinearRailSections
            pin={linearPin}
            teamKey={railTeamKey}
            activeScope={activeRailScope}
            onSelectScope={handleRailScope}
            onOpenIssue={(idOrIdentifier) => void openIssueById(idOrIdentifier, idOrIdentifier)}
          />

          {customViews.length > 0 ? (
            <>
              <div className="mb-1 mt-4 px-2 text-[12px] text-muted-fg/70">Views</div>
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

          <div className="mb-1 mt-4 flex items-center justify-between gap-2 px-2">
            <span className="text-[12px] text-muted-fg/70">Projects</span>
            {filtersActive ? (
              <button
                type="button"
                className="text-[11.5px] text-muted-fg/70 transition-colors hover:text-fg"
                onClick={resetFilters}
              >
                Reset filters
              </button>
            ) : null}
          </div>

          {loadingCatalog && projectFilters.length === 0 ? (
            <div className="px-2 py-3 text-[12px] text-muted-fg/60">Loading projects…</div>
          ) : projectFilters.length > 0 ? (
            <div className="space-y-px">
              {projectFilters.map((projectEntry) => (
                <ProjectFilterButton
                  key={projectEntry.id}
                  project={projectEntry}
                  active={filters.projectId === projectEntry.id}
                  count={formatLinearCount(projectCounts?.[`project:${projectEntry.id}`])}
                  onClick={() => {
                    setOpenDocumentId(null);
                    updateFilters({ projectId: projectEntry.id, scope: SCOPE_ALL });
                  }}
                />
              ))}
            </div>
          ) : (
            <div className="px-2 py-3 text-[12px] text-muted-fg/60">No projects yet.</div>
          )}
        </div>
      </aside>
  );

  return (
    <div ref={rootRef} className="relative flex h-full min-h-0 flex-col overflow-hidden">
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

      <div className="grid min-h-0 flex-1 overflow-hidden" style={{ gridTemplateColumns }}>
        {showRail ? railContent : null}

        <section className={cn("flex min-h-0 flex-col overflow-hidden", showDetailColumn && "border-r border-fg/[0.07]")}>
          {inboxScope ? (
            <div className="flex h-11 shrink-0 items-center border-b border-fg/[0.06] px-4 text-[13px] font-medium text-fg">Inbox</div>
          ) : (
            <LinearListToolbar
              root={{
                label: crumbRoot.label,
                icon: (
                  <span
                    className="grid h-[18px] w-[18px] shrink-0 place-items-center rounded-[5px] text-[10px] font-semibold text-white"
                    style={{ background: crumbRoot.color ?? "#5E6AD2" }}
                    aria-hidden="true"
                  >
                    {crumbRoot.initial.toUpperCase()}
                  </span>
                ),
              }}
              current={currentCrumb}
              onOpenRail={columns.narrow ? () => setNarrowRailOpen(true) : undefined}
              tabs={STATE_TABS}
              activeTab={filters.statePreset}
              onTab={(statePreset) => updateFilters({ statePreset })}
              loading={loadingIssues && !appendingMore}
              query={filters.query}
              onQuery={(query) => updateFilters({ query })}
              searchInputRef={searchInputRef}
              filters={{
                assigneeId: filters.assigneeId,
                priority: filters.priority,
                assigneeOptions,
                priorityOptions: PRIORITY_OPTIONS,
                onChange: (patch) => updateFilters(patch),
              }}
              display={{
                prefs,
                onChange: display.update,
                savedToLinear: display.savedToLinear,
                reason: display.reason,
              }}
              pane={{ visible: columns.narrow ? narrowDetailOpen : detailPaneVisible || batchView, onToggle: toggleDetailPane }}
              width={listWidth}
            />
          )}

          {multiSelectEnabled && !inboxScope && (anyChecked || (readyScope && onBatchLaunch && readyToLaunch.length > 0)) ? (
            <div className="flex h-9 shrink-0 items-center gap-2.5 border-b border-fg/[0.06] bg-fg/[0.015] pl-[13px] pr-3">
              <span
                role="checkbox"
                tabIndex={0}
                aria-checked={selectedIssueIds.size === 0 ? false : selectedIssueIds.size === displayIssues.length ? true : "mixed"}
                aria-label="Select all issues"
                onClick={handleSelectAll}
                onKeyDown={(e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); handleSelectAll(); } }}
                className={cn(
                  "flex h-[14px] w-[14px] shrink-0 cursor-pointer items-center justify-center rounded-[4px] border transition-colors",
                  selectedIssueIds.size > 0 && selectedIssueIds.size === displayIssues.length
                    ? "border-accent bg-accent"
                    : selectedIssueIds.size > 0
                      ? "border-accent bg-accent/50"
                      : "border-fg/25 bg-transparent hover:border-fg/45",
                )}
              >
                {selectedIssueIds.size > 0 && selectedIssueIds.size === displayIssues.length ? (
                  <Check size={10} weight="bold" className="text-accent-fg" />
                ) : selectedIssueIds.size > 0 ? (
                  <Minus size={10} weight="bold" className="text-accent-fg" />
                ) : null}
              </span>
              <span className="text-[12.5px] tabular-nums text-fg/80">
                {selectedIssueIds.size > 0
                  ? `${selectedIssueIds.size} selected`
                  : totalLabel
                    ? `${totalLabel} ${totalLabel === "1" ? "issue" : "issues"}`
                    : `${(issues.length + featuredExtra).toLocaleString()} loaded`}
              </span>
              {selectedIssueIds.size > 0 ? (
                <>
                  <span className="hidden text-[11.5px] text-muted-fg/60 lg:inline" aria-hidden>
                    Enter launches · Esc clears
                  </span>
                  <button
                    type="button"
                    className="ml-auto text-[12px] text-muted-fg transition-colors hover:text-fg"
                    onClick={() => setSelectedIssueIds(new Set())}
                  >
                    Clear
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="ml-auto inline-flex h-7 items-center gap-1.5 rounded-md bg-accent/15 px-2.5 text-[12px] font-medium text-accent-text transition-colors hover:bg-accent/25"
                  title="Launch a lane and an agent for every ready issue that has no lane yet"
                  onClick={() => void handleBatchLaunch(readyToLaunch, {})}
                >
                  <RocketLaunch size={12} weight="fill" />
                  Launch all ready ({readyToLaunch.length})
                </button>
              )}
            </div>
          ) : null}

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
            role="tree"
            aria-label="Issues"
            aria-multiselectable={multiSelectEnabled || undefined}
          >
            {loadingQuickView && !quickView && displayIssues.length === 0 ? (
              <div className="grid h-44 place-items-center text-[12px] text-muted-fg/55">
                <CircleNotch size={16} className="animate-spin" />
              </div>
            ) : listRows.length > 0 ? (
              <>
                <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
                  {virtualItems.map((virtualRow) => {
                    const row = listRows[virtualRow.index];
                    if (!row) return null;
                    const pinned = row.kind === "group" && virtualRow.index === activeHeaderIndex;
                    return (
                      <div
                        key={row.key}
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
                        {row.kind === "group" ? (
                          <LinearGroupHeader
                            row={row}
                            countLabel={groupCountLabel(row)}
                            onToggle={() => toggleCollapsed(`g:${row.path}`)}
                            onCreate={() => handleGroupCreate(virtualRow.index)}
                          />
                        ) : row.kind === "context" ? (
                          <LinearContextRow
                            row={row}
                            layout={rowLayout}
                            onOpen={handleContextOpen}
                            onToggleChildren={toggleChildren}
                          />
                        ) : (
                          <LinearBrowserIssueRow
                            row={row}
                            layout={rowLayout}
                            active={selectedIssue?.id === row.issue.id && (!cursorKeyShown || cursorRowKey === row.key)}
                            eyebrow={featuredIssue?.id === row.issue.id ? featuredIssueLabel : undefined}
                            busy={busyIssueId === row.issue.id}
                            checked={selectedIssueIds.has(row.issue.id)}
                            anyChecked={anyChecked}
                            conflict={conflicts?.get(row.issue.id) ?? null}
                            adeStatus={isNormalizedIssue(row.issue) ? adeStatusFor(row.issue) : null}
                            onToggleCheck={handleRowCheck}
                            onToggleChildren={toggleChildren}
                            onSelect={handleRowSelect}
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
              <div className="flex flex-col items-center gap-1 px-4 py-16 text-center">
                {loadingIssues ? (
                  <CircleNotch size={16} className="animate-spin text-muted-fg/55" />
                ) : (
                  <>
                    <span className="text-[13px] text-fg/80">
                      {displayIssues.length > 0 ? "Every issue here is hidden by the display settings." : "No issues match."}
                    </span>
                    <span className="text-[12px] text-muted-fg/70">
                      {displayIssues.length > 0
                        ? "Turn on completed issues or show hidden groups in Display."
                        : filtersActive ? "Try another tab, or clear the search and filters." : "Issues you create in Linear show up here."}
                    </span>
                  </>
                )}
              </div>
            )}
          </div>
        </section>

        {showDetailColumn ? (
          <div className="flex min-h-0 flex-col overflow-hidden">{detailContent}</div>
        ) : null}
      </div>

      {columns.narrow && narrowRailOpen ? (
        <>
          <div className="absolute inset-0 z-20 bg-black/20" onClick={() => setNarrowRailOpen(false)} aria-hidden="true" />
          <div className="absolute inset-y-0 left-0 z-30 w-[260px] shadow-[16px_0_40px_-20px_rgba(0,0,0,0.6)]">{railContent}</div>
        </>
      ) : null}

      {columns.narrow && detailOpen ? (
        <div className="absolute inset-0 z-10 bg-black/20" onClick={() => setNarrowDetailOpen(false)} aria-hidden="true" />
      ) : null}
      {columns.narrow && detailOpen ? (
        <div className="absolute inset-y-0 right-0 z-20 flex w-[min(440px,92%)] flex-col overflow-hidden border-l border-fg/[0.08] bg-[color:var(--ade-shell-surface,#121019)] shadow-[-16px_0_40px_-20px_rgba(0,0,0,0.6)]">
          {detailContent}
        </div>
      ) : null}
    </div>
  );
}
