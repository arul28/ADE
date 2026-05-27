import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CaretDown,
  CaretRight,
  Check,
  CircleNotch,
  GitBranch,
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
  CtoLinearProject,
  CtoLinearQuickView,
  CtoLinearQuickViewProject,
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
import { LinearPriorityIcon, LinearStateIcon, LINEAR_BRAND } from "../lanes/linearBrand";
import { LinearProjectIcon } from "../lanes/linearProjectIcon";
import { LinearIssueOpenLink, type LinearIssueResolveModalKind } from "./LinearIssueResolveModals";

type BrowserIssue = NormalizedLinearIssue | LaneLinearIssue;
type IssueSort = "updated_desc" | "created_desc" | "priority" | "due_soon" | "identifier_asc";

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
  onIssueAction,
  onOpenLinearSettings,
  onConnectionVisibilityChange,
  onQuickViewChange,
  onLoadingChange,
  resolveActions,
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
  onIssueAction: (issue: BrowserIssue) => void | Promise<void>;
  onOpenLinearSettings?: () => void;
  onConnectionVisibilityChange?: (visible: boolean) => void;
  onQuickViewChange?: (quickView: CtoLinearQuickView | null) => void;
  onLoadingChange?: (loading: boolean) => void;
  resolveActions?: {
    onOpenModal: (kind: LinearIssueResolveModalKind, issue: BrowserIssue) => void;
    busyModal?: LinearIssueResolveModalKind | null;
    disabled?: boolean;
  };
  batchActions?: {
    onBatchCreateLanes: (issues: BrowserIssue[]) => void | Promise<void>;
    onBatchResolveNewLanes: (issues: BrowserIssue[], modelId: string) => void | Promise<void>;
    onBatchResolveExistingLane: (issues: BrowserIssue[], laneId: string, modelId: string) => void | Promise<void>;
    batchProgress: { completed: number; total: number; action: string } | null;
  };
}) {
  const [quickView, setQuickView] = useState<CtoLinearQuickView | null>(null);
  const quickViewRef = useRef<CtoLinearQuickView | null>(null);
  const [catalog, setCatalog] = useState<CtoGetLinearIssuePickerDataResult>({ projects: [], users: [], states: [] });
  const [filters, setFilters] = useState<LinearIssueBrowserFilters>(() => safeLoadFilters(projectRoot));
  const [issues, setIssues] = useState<NormalizedLinearIssue[]>([]);
  const [pageInfo, setPageInfo] = useState<{ hasNextPage: boolean; endCursor: string | null }>({ hasNextPage: false, endCursor: null });
  const pageInfoRef = useRef(pageInfo);
  const [loadingQuickView, setLoadingQuickView] = useState(false);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [loadingIssues, setLoadingIssues] = useState(false);
  const [localActionIssueId, setLocalActionIssueId] = useState<string | null>(null);
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(featuredIssue?.id ?? null);
  const [selectedIssueIds, setSelectedIssueIds] = useState<Set<string>>(new Set());
  const [lastCheckedId, setLastCheckedId] = useState<string | null>(null);
  const anyChecked = selectedIssueIds.size > 0;
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const quickViewRequestIdRef = useRef(0);
  const searchRequestIdRef = useRef(0);

  useEffect(() => {
    quickViewRef.current = quickView;
    onQuickViewChange?.(quickView);
  }, [onQuickViewChange, quickView]);

  useEffect(() => {
    pageInfoRef.current = pageInfo;
  }, [pageInfo]);

  useEffect(() => {
    setFilters(safeLoadFilters(projectRoot));
    setIssues([]);
    setPageInfo({ hasNextPage: false, endCursor: null });
  }, [projectRoot]);

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
    if (!window.ade.cto?.getLinearQuickView) return;
    if (!force && quickViewRef.current) return;
    const requestId = quickViewRequestIdRef.current + 1;
    quickViewRequestIdRef.current = requestId;
    setLoadingQuickView(true);
    setError(null);
    void window.ade.cto.getLinearQuickView()
      .then((data) => {
        if (quickViewRequestIdRef.current !== requestId) return;
        setQuickView(data);
        onConnectionVisibilityChange?.(data.connection.connected === true);
      })
      .catch((err) => {
        if (quickViewRequestIdRef.current !== requestId) return;
        setError(err instanceof Error ? err.message : "Unable to load Linear.");
      })
      .finally(() => {
        if (quickViewRequestIdRef.current === requestId) setLoadingQuickView(false);
      });
  }, [onConnectionVisibilityChange]);

  const loadCatalog = useCallback(() => {
    const cto = window.ade.cto;
    if (!cto?.getLinearIssuePickerData) {
      setError("Linear controls are not available in this ADE surface.");
      return;
    }
    setLoadingCatalog(true);
    setError(null);
    void cto.getLinearIssuePickerData()
      .then((data) => setCatalog(data))
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load Linear filters."))
      .finally(() => setLoadingCatalog(false));
  }, []);

  const searchIssues = useCallback((append: boolean) => {
    const cto = window.ade.cto;
    if (!cto?.searchLinearIssues) {
      setError("Linear issue search is not available in this ADE surface.");
      return;
    }
    const requestId = searchRequestIdRef.current + 1;
    searchRequestIdRef.current = requestId;
    setLoadingIssues(true);
    setError(null);
    void cto.searchLinearIssues({
      projectId: filters.projectId || null,
      stateTypes: stateTypesForPreset(filters.statePreset),
      assigneeId: filters.assigneeId || null,
      priority: filters.priority ? Number(filters.priority) : null,
      query: filters.query.trim() || null,
      first: 50,
      after: append ? pageInfoRef.current.endCursor : null,
      includeArchived: false,
    })
      .then((result) => {
        if (searchRequestIdRef.current !== requestId) return;
        setIssues((current) => append ? mergeIssuePages(current, result.issues) : result.issues);
        setPageInfo(result.pageInfo);
      })
      .catch((err) => {
        if (searchRequestIdRef.current !== requestId) return;
        setError(err instanceof Error ? err.message : "Unable to search Linear issues.");
      })
      .finally(() => {
        if (searchRequestIdRef.current === requestId) setLoadingIssues(false);
      });
  }, [filters]);

  useEffect(() => {
    loadQuickView(true);
    loadCatalog();
  }, [loadCatalog, loadQuickView, refreshKey]);

  useEffect(() => {
    const timer = window.setTimeout(() => searchIssues(false), 220);
    return () => window.clearTimeout(timer);
  }, [filters, searchIssues]);

  useEffect(() => {
    if (refreshKey === 0) return;
    searchIssues(false);
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
    if (selectedIssueId && displayIssues.some((issue) => issue.id === selectedIssueId)) return;
    setSelectedIssueId(displayIssues[0]?.id ?? null);
  }, [displayIssues, selectedIssueId]);

  const selectedIssue = displayIssues.find((issue) => issue.id === selectedIssueId) ?? displayIssues[0] ?? null;

  const handleToggleCheck = useCallback((issueId: string, event: React.MouseEvent) => {
    setSelectedIssueIds((prev) => {
      const next = new Set(prev);
      if (event.shiftKey && lastCheckedId) {
        const startIdx = displayIssues.findIndex((i) => i.id === lastCheckedId);
        const endIdx = displayIssues.findIndex((i) => i.id === issueId);
        if (startIdx !== -1 && endIdx !== -1) {
          const [lo, hi] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
          for (let i = lo; i <= hi; i++) next.add(displayIssues[i].id);
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

  // Clear selection when filters change
  useEffect(() => {
    setSelectedIssueIds(new Set());
    setLastCheckedId(null);
  }, [filters]);

  // Prune stale selections when issues change
  useEffect(() => {
    const validIds = new Set(displayIssues.map((i) => i.id));
    setSelectedIssueIds((prev) => {
      const pruned = new Set([...prev].filter((id) => validIds.has(id)));
      return pruned.size === prev.size ? prev : pruned;
    });
  }, [displayIssues]);

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

      <div className="grid min-h-0 flex-1 overflow-hidden md:grid-cols-[232px_minmax(0,1fr)_334px]">
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

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
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
                aria-checked={selectedIssueIds.size === displayIssues.length && displayIssues.length > 0}
                onClick={handleSelectAll}
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

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
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

        {selectedIssueIds.size > 1 && batchActions ? (
          <BatchActionView
            selectedIssues={displayIssues.filter((i) => selectedIssueIds.has(i.id))}
            onClearSelection={() => setSelectedIssueIds(new Set())}
            batchActions={batchActions}
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
            resolveActions={resolveActions}
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
  onToggleCheck,
  onClick,
}: {
  issue: BrowserIssue;
  active: boolean;
  eyebrow?: string;
  busy?: boolean;
  checked: boolean;
  anyChecked: boolean;
  onToggleCheck: (event: React.MouseEvent) => void;
  onClick: () => void;
}) {
  const listDate = linearIssueListDate(issue);

  return (
    <button
      type="button"
      className={cn(
        "group/row flex h-[34px] w-full items-center gap-3 border-b border-white/[0.04] px-3 text-left transition-colors disabled:opacity-50",
        active ? "bg-white/[0.06]" : "hover:bg-white/[0.03]",
      )}
      onClick={onClick}
      disabled={busy}
    >
      <span
        role="checkbox"
        aria-checked={checked}
        onClick={(e) => { e.stopPropagation(); onToggleCheck(e); }}
        className={cn(
          "flex h-[14px] w-[14px] shrink-0 items-center justify-center rounded-[3px] border transition-all cursor-pointer",
          checked
            ? "border-[color:var(--color-accent,#A78BFA)] bg-[color:var(--color-accent,#A78BFA)]"
            : "border-white/[0.15] bg-transparent hover:border-white/30",
          !anyRowChecked && !checked && "opacity-0 group-hover/row:opacity-100",
        )}
      >
        {checked ? <Check size={10} weight="bold" className="text-[#0F0D14]" /> : null}
      </span>
      <span className="w-[54px] shrink-0 truncate font-mono text-[11px] text-muted-fg/50">
        {issue.identifier}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-fg/90">
        {eyebrow ? (
          <span className="mr-1.5 text-[10px] uppercase tracking-wide text-muted-fg/45">{eyebrow}</span>
        ) : null}
        {issue.title}
      </span>
      {listDate ? (
        <span className="shrink-0 text-[11px] tabular-nums text-muted-fg/45">
          {listDate}
        </span>
      ) : null}
    </button>
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

const RESOLVE_ACTIONS: Array<{
  kind: LinearIssueResolveModalKind;
  label: string;
  description: string;
  icon: React.ReactNode;
}> = [
  {
    kind: "create-lane",
    label: "Create lane attached to issue",
    description: "New lane with this issue linked to the lane.",
    icon: <Plus size={14} weight="bold" />,
  },
  {
    kind: "resolve-new-lane",
    label: "Resolve issue in new chat in new lane",
    description: "New lane plus a Work chat with the issue linked to that chat.",
    icon: <Sparkle size={14} weight="fill" />,
  },
  {
    kind: "resolve-existing-lane",
    label: "Resolve issue in new chat in existing lane",
    description: "Pick a lane and start a chat with the issue linked to that chat only.",
    icon: <BranchIcon size={14} />,
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
  resolveActions,
}: {
  issue: BrowserIssue | null;
  actionLabel: string;
  actionBusyLabel?: string;
  actionIcon?: React.ReactNode;
  actionBusy: boolean;
  actionDisabled: boolean;
  showBranchPreview: boolean;
  onIssueAction: (issue: BrowserIssue) => void | Promise<void>;
  resolveActions?: {
    onOpenModal: (kind: LinearIssueResolveModalKind, issue: BrowserIssue) => void;
    busyModal?: LinearIssueResolveModalKind | null;
    disabled?: boolean;
  };
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
    <aside className="flex min-h-0 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <div className="flex items-center gap-2">
          <LinearPriorityIcon priority={issue.priority} size={12} />
          <LinearStateIcon stateType={issue.stateType} size={12} />
          {issue.url ? (
            <a
              href={issue.url}
              onClick={(e) => { e.preventDefault(); window.ade?.app?.openExternal?.(issue.url!); }}
              className="cursor-pointer rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-fg/80 hover:bg-white/[0.1] transition-colors"
              title="Open in Linear"
            >
              {issue.identifier}
            </a>
          ) : (
            <span className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-fg/80">
              {issue.identifier}
            </span>
          )}
        </div>
        <div className="mt-2 text-[14px] font-semibold leading-snug">{issue.title}</div>
        {showBranchPreview ? (
          <div className="mt-2 rounded-md bg-black/25 px-2 py-1.5 font-mono text-[10.5px] text-fg/80">
            <BranchIcon size={11} className="mr-1 inline" />
            {branchName}
          </div>
        ) : null}

        {description ? (
          <div className="mt-3 overflow-y-auto rounded-lg border border-white/[0.06] bg-white/[0.025] px-3 py-2 text-[12px] leading-relaxed text-muted-fg/80">
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
              {description}
            </ReactMarkdown>
          </div>
        ) : null}

        {(() => {
          const coloredLabels = normalizedIssue?.labelColors ?? issue.labels.map((l) => ({ name: l, color: null as string | null }));
          return coloredLabels.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {coloredLabels.map((label) => (
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
          ) : null;
        })()}

        <div className="mt-3 grid gap-1.5 text-[11px] text-muted-fg/65">
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

      <div className="shrink-0 max-h-[280px] overflow-y-auto border-t border-white/10 px-4 py-3">
        {resolveActions ? (
          <div className="space-y-2">
            <div className="space-y-1.5">
              {RESOLVE_ACTIONS.map((action) => {
                const busy = resolveActions.busyModal === action.kind;
                const disabled = resolveActions.disabled || Boolean(resolveActions.busyModal && !busy);
                return (
                  <button
                    key={action.kind}
                    type="button"
                    disabled={disabled}
                    className="flex w-full items-start gap-2.5 rounded-lg border border-white/[0.07] bg-white/[0.02] px-2.5 py-2 text-left transition-colors hover:border-white/[0.12] hover:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-45"
                    onClick={() => resolveActions.onOpenModal(action.kind, issue)}
                  >
                    <span
                      className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md text-[color:var(--color-accent,#A78BFA)]"
                      style={{ background: "rgba(167, 139, 250, 0.12)" }}
                    >
                      {busy ? <CircleNotch size={13} className="animate-spin" /> : action.icon}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[11.5px] font-medium leading-snug text-fg/90">{action.label}</span>
                      <span className="mt-0.5 block text-[10.5px] leading-relaxed text-muted-fg/55">{action.description}</span>
                    </span>
                  </button>
                );
              })}
            </div>
            <LinearIssueOpenLink url={issue.url} />
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
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

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-muted-fg/45">{label}</span>
      <span className="truncate text-right text-fg/80" title={value}>{value}</span>
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
  const [comments, setComments] = useState<Array<{ id: string; body: string; createdAt: string; userName: string; userDisplayName: string }> | null>(null);
  const [loading, setLoading] = useState(false);
  const prevIssueIdRef = useRef(issueId);

  if (prevIssueIdRef.current !== issueId) {
    prevIssueIdRef.current = issueId;
    setComments(null);
    setExpanded(false);
  }

  useEffect(() => {
    if (!expanded || comments) return;
    let cancelled = false;
    setLoading(true);
    const cto = window.ade?.cto as Record<string, unknown> | undefined;
    const fn = cto?.getLinearIssueComments as ((args: { issueId: string }) => Promise<Array<{ id: string; body: string; createdAt: string; userName: string; userDisplayName: string }>>) | undefined;
    if (!fn) { setLoading(false); setComments([]); return; }
    void fn({ issueId })
      .then((result) => { if (!cancelled) setComments(result ?? []); })
      .catch(() => { if (!cancelled) setComments([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [expanded, issueId, comments]);

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

function BatchActionView({
  selectedIssues,
  onClearSelection,
  batchActions,
}: {
  selectedIssues: BrowserIssue[];
  onClearSelection: () => void;
  batchActions: NonNullable<Parameters<typeof LinearIssueBrowser>[0]["batchActions"]>;
}) {
  return (
    <aside className="flex min-h-0 flex-col overflow-hidden">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <div className="flex items-center justify-between">
          <span className="text-[13px] font-semibold text-fg/90">{selectedIssues.length} issues selected</span>
          <button type="button" className="text-[10px] text-muted-fg/50 hover:text-fg/80 transition-colors" onClick={onClearSelection}>
            Clear
          </button>
        </div>
        <div className="mt-2 space-y-1">
          {selectedIssues.map((issue) => (
            <div key={issue.id} className="flex items-center gap-2 rounded-md bg-white/[0.03] px-2 py-1">
              <span className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-fg/80">{issue.identifier}</span>
              <span className="min-w-0 flex-1 truncate text-[11px] text-muted-fg/70">{issue.title}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="shrink-0 border-t border-white/10 px-4 py-3">
        <div className="space-y-1.5">
          <button
            type="button"
            disabled={Boolean(batchActions.batchProgress)}
            className="flex w-full items-start gap-2.5 rounded-lg border border-white/[0.07] bg-white/[0.02] px-2.5 py-2 text-left transition-colors hover:border-white/[0.12] hover:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-45"
            onClick={() => void batchActions.onBatchCreateLanes(selectedIssues)}
          >
            <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md text-[color:var(--color-accent,#A78BFA)]" style={{ background: "rgba(167, 139, 250, 0.12)" }}>
              <Plus size={13} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[11.5px] font-medium leading-snug text-fg/90">Create lanes for {selectedIssues.length} issues</span>
              <span className="mt-0.5 block text-[10.5px] leading-relaxed text-muted-fg/55">New lane per issue</span>
            </span>
          </button>
          <button
            type="button"
            disabled={Boolean(batchActions.batchProgress)}
            className="flex w-full items-start gap-2.5 rounded-lg border border-white/[0.07] bg-white/[0.02] px-2.5 py-2 text-left transition-colors hover:border-white/[0.12] hover:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-45"
            onClick={() => void batchActions.onBatchResolveNewLanes(selectedIssues, "")}
          >
            <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md text-[color:var(--color-accent,#A78BFA)]" style={{ background: "rgba(167, 139, 250, 0.12)" }}>
              <Sparkle size={13} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[11.5px] font-medium leading-snug text-fg/90">Resolve all in new lanes</span>
              <span className="mt-0.5 block text-[10.5px] leading-relaxed text-muted-fg/55">Lane + chat per issue</span>
            </span>
          </button>
          <button
            type="button"
            disabled={Boolean(batchActions.batchProgress)}
            className="flex w-full items-start gap-2.5 rounded-lg border border-white/[0.07] bg-white/[0.02] px-2.5 py-2 text-left transition-colors hover:border-white/[0.12] hover:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-45"
            onClick={() => void batchActions.onBatchResolveExistingLane(selectedIssues, "", "")}
          >
            <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md text-[color:var(--color-accent,#A78BFA)]" style={{ background: "rgba(167, 139, 250, 0.12)" }}>
              <GitBranch size={13} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[11.5px] font-medium leading-snug text-fg/90">Assign all to one lane</span>
              <span className="mt-0.5 block text-[10.5px] leading-relaxed text-muted-fg/55">Pick lane, chat per issue</span>
            </span>
          </button>
        </div>
        {batchActions.batchProgress && (
          <div className="mt-2">
            <div className="flex items-center justify-between text-[10px] text-muted-fg/55">
              <span>{batchActions.batchProgress.action}</span>
              <span>{batchActions.batchProgress.completed}/{batchActions.batchProgress.total}</span>
            </div>
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-white/[0.06]">
              <div
                className="h-full rounded-full bg-[color:var(--color-accent,#A78BFA)] transition-all"
                style={{ width: `${batchActions.batchProgress.total > 0 ? (batchActions.batchProgress.completed / batchActions.batchProgress.total) * 100 : 0}%` }}
              />
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
