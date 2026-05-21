import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowSquareOut,
  CaretDown,
  CircleNotch,
  GitBranch,
  MagnifyingGlass,
  Plus,
  Warning,
} from "@phosphor-icons/react";

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
  LinearIssueRow,
  linearPriorityLabel,
  toLaneLinearIssue,
} from "../lanes/LinearIssuePicker";
import { LinearPriorityIcon, LinearStateIcon, LINEAR_BRAND } from "../lanes/linearBrand";

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

const ACTIVE_LINEAR_STATE_TYPES = ["backlog", "unstarted", "started"];
const FILTER_STORAGE_PREFIX = "ade.linear.quickView.filters.v1:";

const DEFAULT_FILTERS: LinearIssueBrowserFilters = {
  projectId: "",
  statePreset: "all",
  assigneeId: "",
  priority: "",
  query: "",
  sort: "updated_desc",
};

const STATE_LABELS: Record<string, string> = {
  active: "Active",
  all: "All states",
  backlog: "Backlog",
  unstarted: "Todo",
  started: "In progress",
  completed: "Done",
  canceled: "Canceled",
  triage: "Triage",
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
    if (
      filters.projectId === DEFAULT_FILTERS.projectId &&
      filters.statePreset === DEFAULT_FILTERS.statePreset &&
      filters.assigneeId === DEFAULT_FILTERS.assigneeId &&
      filters.priority === DEFAULT_FILTERS.priority &&
      filters.query === DEFAULT_FILTERS.query &&
      filters.sort === DEFAULT_FILTERS.sort
    ) {
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

function stateTypesForPreset(preset: string): string[] {
  if (preset === "all") return [];
  if (preset === "active") return ACTIVE_LINEAR_STATE_TYPES;
  return preset ? [preset] : [];
}

function openLinearUrl(url: string | null | undefined): void {
  if (!url) return;
  void window.ade.app.openExternal(url);
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

  const stateOptions = useMemo(() => {
    const seen = new Set<string>();
    const dynamic = catalog.states
      .filter((state) => {
        if (seen.has(state.type)) return false;
        seen.add(state.type);
        return true;
      })
      .sort((left, right) => left.type.localeCompare(right.type))
      .map((state) => ({ value: state.type, label: STATE_LABELS[state.type] ?? state.type }));
    const options = [
      { value: "all", label: "All states" },
      { value: "active", label: "Active" },
      ...dynamic,
    ];
    if (filters.statePreset && !options.some((option) => option.value === filters.statePreset)) {
      options.push({ value: filters.statePreset, label: STATE_LABELS[filters.statePreset] ?? filters.statePreset });
    }
    return options;
  }, [catalog.states, filters.statePreset]);

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

  return (
    <div className="min-h-[560px] overflow-hidden">
      {error ? (
        <div className="mx-4 mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-red-500/25 px-3 py-2 text-[12px] text-red-100" style={{ backgroundColor: "#321B20" }}>
          <Warning size={14} className="shrink-0" />
          <span className="min-w-0 flex-1">{error}</span>
          {showSettingsAction ? (
            <Button type="button" variant="danger" size="sm" onClick={onOpenLinearSettings}>
              Open Linear settings
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="grid min-h-0 md:grid-cols-[232px_minmax(0,1fr)_334px]">
        <aside className="min-h-0 border-r border-white/10 bg-black/10 px-3 py-3">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-fg/55">
              Projects
            </div>
            <button
              type="button"
              className="text-[11px] text-muted-fg/60 transition-colors hover:text-fg"
              onClick={resetFilters}
            >
              Clear
            </button>
          </div>

          <div className="space-y-2">
            <button
              type="button"
              className={cn(
                "flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-[12px] transition-colors",
                !filters.projectId ? "border-white/12 bg-white/[0.06] text-fg" : "border-white/[0.06] bg-white/[0.025] text-muted-fg/75 hover:bg-white/[0.05]",
              )}
              onClick={() => updateFilters({ projectId: "" })}
            >
              <span>All issues</span>
              <span className="text-[10px] text-muted-fg/50">
                {issues.length > 0 ? `${issues.length}${pageInfo.hasNextPage ? "+" : ""}` : ""}
              </span>
            </button>
          </div>

          <div className="mt-2 max-h-[350px] space-y-1.5 overflow-y-auto pr-1">
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
                  onClick={() => updateFilters({ projectId: projectEntry.id })}
                />
              ))
            ) : (
              <div className="rounded-lg border border-white/[0.06] px-3 py-6 text-center text-[12px] text-muted-fg/50">
                No visible projects.
              </div>
            )}
          </div>
        </aside>

        <section className="min-h-0 border-r border-white/10 px-4 py-3">
          <div className="mb-3 grid gap-2">
            <div className="relative">
              <MagnifyingGlass size={13} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-fg/45" />
              <input
                value={filters.query}
                onChange={(event) => updateFilters({ query: event.target.value })}
                placeholder="Search all Linear issues"
                className="h-9 w-full rounded-lg border border-white/[0.07] bg-black/20 pl-8 pr-3 text-[12px] text-fg outline-none transition-colors placeholder:text-muted-fg/40 focus:border-white/18"
              />
            </div>
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
              <FilterSelect
                label="State"
                value={filters.statePreset}
                options={stateOptions}
                onChange={(value) => updateFilters({ statePreset: value })}
              />
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

          <div className="mb-2 flex items-center justify-between">
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-fg/55">
              Issues
            </div>
            <div className="flex items-center gap-2 text-[11px] text-muted-fg/55">
              {filters.projectId
                ? projectFilters.find((projectEntry) => projectEntry.id === filters.projectId)?.name ?? "Project issues"
                : "All issues"}
              {loadingIssues ? <CircleNotch size={11} className="animate-spin" /> : null}
            </div>
          </div>

          <div className="max-h-[438px] overflow-y-auto rounded-lg border border-white/[0.06] bg-black/20">
            {loadingQuickView && !quickView && displayIssues.length === 0 ? (
              <div className="grid h-44 place-items-center text-[12px] text-muted-fg/55">
                <CircleNotch size={16} className="animate-spin" />
              </div>
            ) : displayIssues.length > 0 ? (
              <>
                {displayIssues.map((issue) => (
                  <LinearIssueRow
                    key={issueListKey(issue)}
                    issue={issue}
                    active={selectedIssue?.id === issue.id}
                    eyebrow={featuredIssue?.id === issue.id ? featuredIssueLabel : undefined}
                    busy={busyIssueId === issue.id}
                    onClick={() => setSelectedIssueId(issue.id)}
                  />
                ))}
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

        <IssueDetails
          issue={selectedIssue}
          actionLabel={actionLabel}
          actionBusyLabel={actionBusyLabel}
          actionIcon={actionIcon}
          actionBusy={selectedIssue ? busyIssueId === selectedIssue.id : false}
          actionDisabled={actionDisabled || Boolean(busyIssueId && busyIssueId !== selectedIssue?.id)}
          showBranchPreview={showBranchPreview}
          onIssueAction={handleIssueAction}
        />
      </div>
    </div>
  );
}

function ProjectFilterButton({
  project,
  active,
  onClick,
}: {
  project: CtoLinearProject & { quick: CtoLinearQuickViewProject | null };
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors",
        active ? "border-white/12 bg-white/[0.06]" : "border-white/[0.06] bg-white/[0.025] hover:bg-white/[0.05]",
      )}
      onClick={onClick}
    >
      <span
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ background: project.quick?.color ?? LINEAR_BRAND.primaryBright }}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] font-medium text-fg">{project.name}</span>
        <span className="block truncate text-[10.5px] text-muted-fg/50">
          {project.teamName}
          {project.quick?.statusName ? ` · ${project.quick.statusName}` : ""}
        </span>
      </span>
      <span className="shrink-0 text-[10px] text-muted-fg/50">
        {project.quick?.issueCount ?? ""}
      </span>
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

function IssueDetails({
  issue,
  actionLabel,
  actionBusyLabel,
  actionIcon,
  actionBusy,
  actionDisabled,
  showBranchPreview,
  onIssueAction,
}: {
  issue: BrowserIssue | null;
  actionLabel: string;
  actionBusyLabel?: string;
  actionIcon?: React.ReactNode;
  actionBusy: boolean;
  actionDisabled: boolean;
  showBranchPreview: boolean;
  onIssueAction: (issue: BrowserIssue) => void | Promise<void>;
}) {
  if (!issue) {
    return (
      <aside className="grid min-h-[420px] place-items-center px-4 py-8 text-center text-[12px] text-muted-fg/55">
        Select an issue to preview it.
      </aside>
    );
  }

  const laneIssue = linearBrowserIssueToLaneIssue(issue);
  const branchName = linearIssueBranchName(laneIssue);
  const normalizedIssue = "raw" in issue ? issue : null;
  const description = issue.description?.trim() ?? "";
  return (
    <aside className="flex min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <div className="flex items-center gap-2">
          <LinearPriorityIcon priority={issue.priority} size={12} />
          <LinearStateIcon stateType={issue.stateType} size={12} />
          <span className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-fg/80">
            {issue.identifier}
          </span>
        </div>
        <div className="mt-2 text-[14px] font-semibold leading-snug">{issue.title}</div>
        {showBranchPreview ? (
          <div className="mt-2 rounded-md bg-black/25 px-2 py-1.5 font-mono text-[10.5px] text-fg/80">
            <GitBranch size={11} className="mr-1 inline" />
            {branchName}
          </div>
        ) : null}

        {description ? (
          <div className="mt-3 max-h-28 overflow-y-auto rounded-lg border border-white/[0.06] bg-white/[0.025] px-3 py-2 text-[12px] leading-relaxed text-muted-fg/80 whitespace-pre-wrap">
            {description}
          </div>
        ) : null}

        {issue.labels.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {issue.labels.map((label) => (
              <span key={label} className="rounded-full border border-white/[0.07] bg-white/[0.035] px-2 py-0.5 text-[10px] text-muted-fg/75">
                {label}
              </span>
            ))}
          </div>
        ) : null}

        <div className="mt-3 grid gap-1.5 text-[11px] text-muted-fg/65">
          <InfoRow label="Project" value={issueProjectLabel(issue)} />
          <InfoRow label="Team" value={issue.teamName ?? issue.teamKey} />
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
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-white/10 px-4 py-3">
        <Button
          variant="primary"
          disabled={actionBusy || actionDisabled}
          onClick={() => void onIssueAction(issue)}
        >
          {actionBusy ? <CircleNotch size={14} className="animate-spin" /> : actionIcon ?? <Plus size={14} />}
          {actionBusy ? actionBusyLabel ?? actionLabel : actionLabel}
        </Button>
        {issue.url ? (
          <Button variant="outline" onClick={() => openLinearUrl(issue.url)}>
            <ArrowSquareOut size={13} />
            Open
          </Button>
        ) : null}
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
