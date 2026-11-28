import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CircleNotch, SidebarSimple } from "@phosphor-icons/react";

import type {
  CtoLinearQuickView,
  CtoLinearQuickViewProject,
  LaneLinearIssue,
  LinearIssueRef,
} from "../../../shared/types";
import { cn } from "../ui/cn";
import { Banner } from "../ui/notice/Banner";
import { useEscapeLayer } from "../ui/useEscapeLayer";
import type { IssueConflict } from "../../lib/linearBatchLaunch";
import {
  LinearBrowserIssueRow,
  LinearContextRow,
  LinearGroupHeader,
  type LinearRowLayout,
} from "./LinearIssueBrowserRows";
// The detail views (and the markdown they render) load with the first selection.
const LinearBatchActionView = React.lazy(() => import("./LinearIssueDetailPane").then((module) => ({ default: module.LinearBatchActionView })));
const LinearIssueDetails = React.lazy(() => import("./LinearIssueDetailPane").then((module) => ({ default: module.LinearIssueDetails })));
import { LinearInboxList } from "./LinearInboxList";
import { requestIssueCreate } from "../../lib/issueCreateRequests";
import { formatLinearCount, isNormalizedIssue, type BrowserIssue } from "./linearIssueBrowserModel";
import { useActiveRepositoryReader } from "../../state/repositoryScope";
import {
  buildLinearListModel,
  groupCreatePrefill,
  LINEAR_PRIORITY_GROUP_ORDER,
  type LinearListCatalog,
  type LinearListContextRow,
  type LinearListGroupRow,
  type LinearListIssueRow,
  type LinearListRow,
} from "./linear/linearListModel";
import { useLinearDisplayPreferences } from "./linear/linearDisplayPreferences";
import { LinearListToolbar } from "./linear/LinearListToolbar";
import { useLinearIssueAdeStatusIndex } from "./linear/adeStatus";
import { useLinearRailData } from "./linear/LinearRailSections";
import { LinearDocumentReader } from "./linear/LinearDocumentReader";
import { LinearBrowserRail } from "./linear/LinearBrowserRail";
import { LinearSelectionBar, confirmIssueRelaunch } from "./linear/LinearSelectionBar";
import { LinearVirtualRows, useLinearVirtualList } from "./linear/LinearVirtualRows";
import { fieldsForWidth, paneColumns } from "./linear/linearPaneLayout";
import { useLinearListKeyboard } from "./linear/useLinearListKeyboard";
import { useLinearBrowserData } from "./linear/useLinearBrowserData";
import { useLinearCheckedIssues } from "./linear/useLinearCheckedIssues";
import { useLinearIssueDetails } from "./linear/useLinearIssueDetails";
import { useLinearRailScope } from "./linear/useLinearRailScope";
import {
  READY_STATE_TYPES,
  linearScopePrefill,
  linearScopeViewType,
} from "./linear/linearScope";
import {
  DEFAULT_FILTERS,
  activeLinearScope,
  browserCacheKey,
  getBrowserCacheEntry,
  hasActiveFilters,
  safeLoadDetailPane,
  safeLoadFilters,
  safeLoadSelection,
  safeSaveDetailPane,
  safeSaveFilters,
  stateTypesFor,
  useLinearBrowserCounts,
  type LinearIssueBrowserFilters,
  type ServerOrder,
} from "./linear/linearIssueBrowserData";

export { linearBrowserIssueToLaneIssue } from "./linearIssueBrowserModel";
export type { BrowserIssue } from "./linearIssueBrowserModel";
export { cachedLinearBrowserIssues, clearLinearQuickViewSelection } from "./linear/linearIssueBrowserData";

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

const STATE_TABS = [
  { value: "active", label: "Active" },
  { value: "backlog", label: "Backlog" },
  { value: "all", label: "All issues" },
] as const;

const PRIORITY_OPTIONS = [
  { value: "", label: "Any priority" },
  ...LINEAR_PRIORITY_GROUP_ORDER.map((entry) => ({ value: String(entry.value), label: entry.label })),
];

// The list is virtualized, so rows in memory are cheap; this only bounds how
// many pages a long scroll pulls before the user opts into more.
const AUTO_LOAD_MAX_ISSUES = 2000;

const RAIL_OPENER_CLASS =
  "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-fg outline-none transition-colors hover:bg-fg/[0.05] hover:text-fg focus-visible:ring-1 focus-visible:ring-fg/30";

function toTimestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isConnectionError(message: string): boolean {
  return /token|oauth|auth|connect|settings|linear/i.test(message);
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
  // Linear is the repository's (class A): read it from the reader copy. No
  // copy online: nothing is read, and the browser shows its empty state.
  const linearPin = useActiveRepositoryReader();
  const cacheKey = browserCacheKey(projectRoot, linearPin?.key ?? null);
  const [filters, setFilters] = useState<LinearIssueBrowserFilters>(() => safeLoadFilters(projectRoot));
  const activeScope = useMemo(() => activeLinearScope(filters), [filters]);

  // Display settings are Linear's own, per tab / custom view, read from the reader machine.
  const viewType = linearScopeViewType(activeScope, filters.statePreset);
  const customViewId = activeScope.kind === "view" ? activeScope.id : null;
  const display = useLinearDisplayPreferences({ pin: linearPin, viewType, customViewId });
  const prefs = display.prefs;
  const showCompletedIssues = prefs.showCompletedIssues;
  const serverOrder = useMemo<ServerOrder>(
    () => ({ ordering: prefs.ordering, direction: prefs.orderingDirection }),
    [prefs.ordering, prefs.orderingDirection],
  );

  const data = useLinearBrowserData({
    cacheKey,
    pin: linearPin,
    filters,
    serverOrder,
    showCompletedIssues,
    refreshKey,
    initialFilters: () => safeLoadFilters(projectRoot),
    onConnectionVisibilityChange,
  });
  const {
    quickView,
    catalog,
    catalogLoaded,
    customViews,
    issues,
    patchIssue,
    pageInfo,
    failedAppendCursor,
    searchTotalCount,
    loadingQuickView,
    loadingCatalog,
    loadingIssues,
    appendingMore,
    error,
    setError,
    searchIssues,
    resetToCache,
    clearIssues,
  } = data;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const issuesScrollRef = useRef<HTMLDivElement | null>(null);
  const [localActionIssueId, setLocalActionIssueId] = useState<string | null>(null);
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(featuredIssue?.id ?? null);
  // The row the keyboard sits on. An issue can show twice (label grouping), so
  // the cursor is a row key, not just the issue id.
  const [cursorRowKey, setCursorRowKey] = useState<string | null>(null);
  const multiSelectEnabled = !singleSelect;
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [countsNonce, setCountsNonce] = useState(0);
  const [detailPaneVisible, setDetailPaneVisible] = useState<boolean>(() => safeLoadDetailPane());
  const [narrowDetailOpen, setNarrowDetailOpen] = useState(false);
  const [narrowRailOpen, setNarrowRailOpen] = useState(false);
  const [openDocumentId, setOpenDocumentId] = useState<string | null>(null);
  const [rootWidth, setRootWidth] = useState(0);
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
    if (featuredIssue && !selectedIssueId) {
      setSelectedIssueId(featuredIssue.id);
    }
  }, [featuredIssue, selectedIssueId]);

  const loading = loadingQuickView || loadingCatalog || loadingIssues || Boolean(actionBusyIssueId ?? localActionIssueId);
  useEffect(() => {
    onLoadingChange?.(loading);
  }, [loading, onLoadingChange]);

  const updateFilters = useCallback((patch: Partial<LinearIssueBrowserFilters>) => {
    setFilters((current) => {
      const next = { ...current, ...patch };
      safeSaveFilters(projectRoot, next);
      return next;
    });
  }, [projectRoot]);

  const resetFilters = useCallback(() => {
    setFilters(DEFAULT_FILTERS);
    safeSaveFilters(projectRoot, DEFAULT_FILTERS);
    clearIssues();
  }, [clearIssues, projectRoot]);

  const readyScope = activeScope.kind === "ready";
  const inboxScope = activeScope.kind === "inbox";
  const [inboxUnread, setInboxUnread] = useState<number | null>(null);
  const inboxAvailable = typeof window !== "undefined" && typeof window.ade?.cto?.getLinearInbox === "function";
  // The rail shows the unread count before the inbox is opened.
  useEffect(() => {
    if (!inboxAvailable || !linearPin) return;
    let cancelled = false;
    void window.ade.cto!.getLinearInbox({ first: 50 }, linearPin)
      .then((items) => { if (!cancelled) setInboxUnread(items.length); })
      .catch((err: unknown) => console.warn("[linear] inbox count read failed", err));
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

  const openIssueInWindow = useCallback((issueId: string) => {
    setSelectedIssueId(issueId);
    setOpenDocumentId(null);
  }, []);
  const bumpCounts = useCallback(() => setCountsNonce((value) => value + 1), []);
  const details = useLinearIssueDetails({
    cacheKey,
    pin: linearPin,
    catalog,
    patchIssue,
    listedIssues: displayIssues,
    onOpened: openIssueInWindow,
    onEdited: bumpCounts,
  });
  const { externalIssue, detailIssues, openIssueById, fetchIssueDetail, resetDetails, refreshDetails } = details;

  // Breadcrumb and rail team: the team when the workspace has one.
  const teams = quickView?.teams ?? [];
  const singleTeam = teams.length === 1 ? teams[0]! : null;
  const scopeTeamKeys = useMemo<string[] | null>(() => {
    if (!filters.projectId) return null;
    const project = catalog.projects.find((entry) => entry.id === filters.projectId);
    return project?.teamKey ? [project.teamKey] : null;
  }, [catalog.projects, filters.projectId]);
  const railTeamKey = singleTeam?.key ?? scopeTeamKeys?.[0] ?? null;
  const railData = useLinearRailData(linearPin, railTeamKey);

  const listCatalog = useMemo<LinearListCatalog>(() => ({
    states: catalog.states,
    users: catalog.users,
    projects: catalog.projects,
    labels: catalog.labels ?? [],
    teams: (quickView?.teams ?? []).map((team) => ({ id: team.id, key: team.key, name: team.displayName || team.name, color: team.color })),
    cycles: railData?.cycles ?? [],
    viewerId: quickView?.viewer?.id ?? quickView?.connection.viewerId ?? null,
  }), [catalog, quickView?.connection.viewerId, quickView?.teams, quickView?.viewer?.id, railData?.cycles]);

  const allowedStateTypes = useMemo(
    () => (readyScope ? READY_STATE_TYPES : stateTypesFor(filters.statePreset, true)),
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
    () => listModel.navigable.flatMap((index) => {
      const row = listRows[index];
      return row?.kind === "issue" ? [row.issue] : [];
    }),
    [listModel.navigable, listRows],
  );
  // The issues the list shows (hidden groups and the completed filter applied), once each.
  const visibleIssues = useMemo(() => {
    const byId = new Map(displayIssues.map((issue) => [issue.id, issue]));
    return listModel.issueIds.flatMap((id) => {
      const issue = byId.get(id);
      return issue ? [issue] : [];
    });
  }, [displayIssues, listModel.issueIds]);

  const checked = useLinearCheckedIssues({
    projectRoot,
    enabled: multiSelectEnabled,
    rows: listRows,
    navigable: listModel.navigable,
    displayIssues,
    visibleIssues,
  });
  const { checkedIds, setCheckedIds, checkedIssues, allVisibleChecked, toggleChecked, toggleAllVisible } = checked;
  const anyChecked = multiSelectEnabled && checkedIds.size > 0;

  // Another project or reader machine: start from its cache, and let no search
  // still in flight for the old one land here.
  useEffect(() => {
    const nextFilters = safeLoadFilters(projectRoot);
    resetToCache(nextFilters);
    setFilters(nextFilters);
    setCheckedIds(safeLoadSelection(projectRoot));
    resetDetails();
    setOpenDocumentId(null);
  }, [projectRoot, resetDetails, resetToCache, setCheckedIds]);

  // Reload once per refresh press; a later project or machine switch with the
  // same refreshKey is not a refresh.
  const lastHandledRefreshRef = useRef(0);
  useEffect(() => {
    if (refreshKey === 0 || refreshKey === lastHandledRefreshRef.current) return;
    lastHandledRefreshRef.current = refreshKey;
    getBrowserCacheEntry(cacheKey).counts.clear();
    refreshDetails();
    bumpCounts();
    searchIssues(false, true);
    // Only a refresh press reloads; filter changes go through the debounce above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, refreshKey]);

  const virtualList = useLinearVirtualList(listRows, headerIndices, issuesScrollRef);
  const { virtualizer, lastRenderedIndex } = virtualList;

  // Infinite scroll: fetch the next page while Linear has more and the
  // rendered range nears the end. When Display hides every loaded row there
  // is no end to near, so keep paging (up to the cap) until something shows.
  // A page that failed is not retried on its own; "Load more" retries it.
  const appendFailed = failedAppendCursor != null && failedAppendCursor === pageInfo.endCursor;
  useEffect(() => {
    if (!canAutoLoadIssues || loadingIssues || appendFailed) return;
    if (!pageInfo.hasNextPage || issues.length >= AUTO_LOAD_MAX_ISSUES) return;
    if (listRows.length > 0 && (lastRenderedIndex < 0 || lastRenderedIndex < listRows.length - 15)) return;
    searchIssues(true);
  }, [appendFailed, canAutoLoadIssues, issues.length, lastRenderedIndex, listRows.length, loadingIssues, pageInfo.hasNextPage, searchIssues]);

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

  const selectedIssueKey = listSelectedIssue?.id ?? null;
  useEffect(() => {
    if (!selectedIssueKey || detailIssues.has(selectedIssueKey)) return;
    const timer = window.setTimeout(() => {
      void fetchIssueDetail(selectedIssueKey).catch((err: unknown) => {
        // The list copy still renders; relations beyond "blocked by" stay hidden.
        console.warn("[linear] issue detail read failed", err);
      });
    }, 120);
    return () => window.clearTimeout(timer);
  }, [detailIssues, fetchIssueDetail, selectedIssueKey]);

  const handleOpenRelatedIssue = useCallback(
    (ref: Pick<LinearIssueRef, "id" | "identifier">) => openIssueById(ref.id, ref.identifier),
    [openIssueById],
  );

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

  const listIsComplete = !pageInfo.hasNextPage;
  // Linear counts by status; other groupings show the loaded rows with a "+".
  const statusGroups = useMemo(
    () => (prefs.grouping === "workflowState"
      ? listModel.groups.map(({ group }) => [group.key, group.ids] as const).filter(([, ids]) => ids.length > 0)
      : []),
    [listModel.groups, prefs.grouping],
  );
  const counts = useLinearBrowserCounts({
    cacheKey,
    pin: linearPin,
    connected,
    filters,
    showCompletedIssues,
    cyclesAvailable,
    customViewIds: customViews.map((view) => view.id),
    projectIds: projectFilters.map((projectEntry) => projectEntry.id),
    listIsComplete,
    statusGroups,
    refreshNonce: countsNonce,
  });
  const listCounts = counts.listCounts;

  const featuredExtra = featuredIssue && !issues.some((issue) => issue.id === featuredIssue.id) ? 1 : 0;
  // When Linear answered but gave no count for a key (rejected filter, or
  // counts skipped to save rate-limit budget), show the loaded rows with a
  // "+" instead of a spinner that never ends.
  const loadedAtLeast = (loaded: number): string => `${loaded.toLocaleString()}+`;
  const totalLabel = listIsComplete
    ? String(listModel.issueCount)
    : formatLinearCount(listCounts?.total)
      ?? (searchTotalCount != null ? searchTotalCount.toLocaleString() : null)
      ?? (listCounts ? loadedAtLeast(listModel.issueCount) : null);
  const groupCountLabel = (row: LinearListGroupRow): string | null => {
    if (listIsComplete) return row.count.toLocaleString();
    if (row.depth === 0 && row.group.grouping === "workflowState" && row.group.ids.length > 0) {
      const counted = formatLinearCount(listCounts?.[`group:${row.group.key}`]);
      return counted ?? (listCounts ? loadedAtLeast(row.count) : null);
    }
    return loadedAtLeast(row.count);
  };

  const conflicts = batchActions?.conflicts;

  // Unified launch entry point. When any target issue is already attached to a
  // lane/session we surface a soft confirm first — re-attaching is allowed (the
  // data model supports the same issue on multiple lanes), the user just gets a
  // heads-up. Once confirmed (or when there is no conflict) we hand off to the
  // host's onBatchLaunch.
  const onBatchLaunch = batchActions?.onBatchLaunch;
  const laneLinkedIssueIds = useMemo(() => new Set(conflicts ? [...conflicts.keys()] : []), [conflicts]);
  // "Launch all ready" takes the issues the list shows and skips any that already have a lane or an agent.
  const readyToLaunch = useMemo(
    () => (readyScope ? visibleIssues.filter((issue) => !conflicts?.has(issue.id)) : []),
    [conflicts, readyScope, visibleIssues],
  );
  const handleBatchLaunch = useCallback(async (launchIssues: BrowserIssue[], options: { laneOnly?: boolean }) => {
    if (!onBatchLaunch || launchIssues.length === 0) return;
    if (!(await confirmIssueRelaunch(launchIssues, conflicts))) return;
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
  }, [actionBusyIssueId, actionDisabled, localActionIssueId, onIssueAction, setError]);

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
  const handleRowCheck = useCallback(
    (issueId: string, rowKey: string, event: React.MouseEvent) => toggleChecked(issueId, rowKey, event.shiftKey),
    [toggleChecked],
  );
  const handleRowSelect = useCallback((issueId: string, rowKey: string) => {
    setSelectedIssueId(issueId);
    setCursorRowKey(rowKey);
    setOpenDocumentId(null);
  }, []);
  const handleContextOpen = useCallback((ref: LinearListContextRow["ref"]) => {
    void handleOpenRelatedIssue(ref);
  }, [handleOpenRelatedIssue]);

  // A group's "+" opens ADE's create form with the group's (and scope's) fields filled in.
  const handleGroupCreate = useCallback((index: number) => {
    const prefill = groupCreatePrefill({
      rows: listRows,
      index,
      catalog: listCatalog,
      scopePrefill: linearScopePrefill(activeScope, listCatalog.viewerId),
      scopeTeamKeys,
    });
    if (prefill) requestIssueCreate({ provider: "linear", origin: "pane", prefill: { linear: prefill } });
  }, [activeScope, listCatalog, listRows, scopeTeamKeys]);

  useLinearListKeyboard({
    rootRef,
    searchInputRef,
    state: {
      listRows,
      navigable: listModel.navigable,
      cursorRowKey,
      selectedIssue,
      checkedCount: checkedIds.size,
      multiSelectEnabled,
      resolvedSelectedIssues: checkedIssues,
    },
    actions: {
      goToRow: (row: LinearListIssueRow, index: number) => {
        setSelectedIssueId(row.issue.id);
        setCursorRowKey(row.key);
        setOpenDocumentId(null);
        if (index >= 0) virtualizer.scrollToIndex(index, { align: "auto" });
      },
      toggleChecked,
      toggleCollapsed,
      clearChecked: () => setCheckedIds(new Set()),
      launch: onBatchLaunch ? (targets) => void handleBatchLaunch(targets, { laneOnly: false }) : null,
      runPrimaryAction: (issue) => void handleIssueAction(issue),
    },
  });

  const { handleRailScope, activeRailScope, currentCrumb } = useLinearRailScope({
    activeScope,
    openDocumentId,
    setOpenDocumentId,
    setNarrowRailOpen,
    setNarrowDetailOpen,
    updateFilters,
    railData,
    catalog,
    catalogLoaded,
    customViews,
    issues,
  });

  const showSettingsAction = Boolean(error && onOpenLinearSettings && isConnectionError(error));
  const busyIssueId = actionBusyIssueId ?? localActionIssueId;
  const filtersActive = hasActiveFilters(filters);

  const crumbRoot = singleTeam
    ? { label: singleTeam.displayName || singleTeam.name, color: singleTeam.color, initial: singleTeam.key.charAt(0) }
    : { label: quickView?.organization?.name ?? "Linear", color: null, initial: (quickView?.organization?.name ?? "L").charAt(0) };

  const columns = paneColumns(rootWidth);
  const showRail = !columns.narrow;
  const detailOpen = columns.narrow ? narrowDetailOpen : detailPaneVisible;
  // A multi-select always shows its launch panel, even with details hidden.
  const batchView = multiSelectEnabled && checkedIds.size > 1 && Boolean(onBatchLaunch);
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
  const openNarrowRail = columns.narrow ? () => setNarrowRailOpen(true) : undefined;

  const detailContent = (
    <React.Suspense fallback={null}>
      {openDocumentId ? (
        <LinearDocumentReader pin={linearPin} documentId={openDocumentId} onClose={() => setOpenDocumentId(null)} />
      ) : batchView && onBatchLaunch ? (
        <LinearBatchActionView
          selectedIssues={checkedIssues}
          onClearSelection={() => setCheckedIds(new Set())}
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
          onEdit={details.canEditIssues ? (issue, edit) => void details.editIssue(issue, edit) : undefined}
          editPending={selectedIssue ? details.pendingEditIds.has(selectedIssue.id) : false}
          onOpenIssue={(ref) => void handleOpenRelatedIssue(ref)}
          loadingIssueId={details.loadingRelationId}
        />
      )}
    </React.Suspense>
  );

  const railContent = (
    <LinearBrowserRail
      narrow={columns.narrow}
      activeScopeKey={activeRailScope}
      onSelectScope={handleRailScope}
      scopeCount={(scopeKey) => formatLinearCount(counts.scopeCount(scopeKey))}
      inbox={inboxAvailable ? { count: formatInboxCount(inboxUnread) } : null}
      readyCount={readyScope && listIsComplete ? String(listModel.issueCount) : null}
      cyclesAvailable={cyclesAvailable}
      customViews={customViews}
      projects={projectFilters}
      projectCount={(projectId) => formatLinearCount(counts.projectCount(projectId))}
      loadingProjects={loadingCatalog}
      filtersActive={filtersActive}
      onResetFilters={resetFilters}
      pin={linearPin}
      railTeamKey={railTeamKey}
      onOpenIssue={(idOrIdentifier) => void openIssueById(idOrIdentifier, idOrIdentifier)}
    />
  );

  const renderRow = (row: LinearListRow, index: number): React.ReactNode => (
    row.kind === "group" ? (
      <LinearGroupHeader
        row={row}
        countLabel={groupCountLabel(row)}
        onToggle={() => toggleCollapsed(`g:${row.path}`)}
        onCreate={() => handleGroupCreate(index)}
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
        checked={checkedIds.has(row.issue.id)}
        anyChecked={anyChecked}
        conflict={conflicts?.get(row.issue.id) ?? null}
        adeStatus={isNormalizedIssue(row.issue) ? adeStatusFor(row.issue) : null}
        onToggleCheck={handleRowCheck}
        onToggleChildren={toggleChildren}
        onSelect={handleRowSelect}
      />
    )
  );

  const loadMoreFooter = appendingMore ? (
    <div className="flex items-center justify-center gap-2 px-3 py-3 text-[12px] text-muted-fg/55">
      <CircleNotch size={13} className="animate-spin" />
      Loading more…
    </div>
  ) : pageInfo.hasNextPage && (!canAutoLoadIssues || appendFailed || issues.length >= AUTO_LOAD_MAX_ISSUES || listRows.length === 0) ? (
    <button
      type="button"
      disabled={loadingIssues}
      className="flex w-full items-center justify-center gap-2 px-3 py-2.5 text-[12px] text-muted-fg/70 transition-colors hover:bg-fg/[0.04] hover:text-fg"
      onClick={() => searchIssues(true)}
    >
      Load more
    </button>
  ) : null;

  const hiddenByDisplay = displayIssues.length > 0;
  const emptyTitle = hiddenByDisplay
    ? prefs.hiddenGroups.length > 0 ? "Every issue here is in a hidden group." : "Every issue here is hidden by the display settings."
    : "No issues match.";
  const emptyHint = hiddenByDisplay
    ? prefs.hiddenGroups.length > 0
      ? "Open Display and choose Show all next to the hidden groups."
      : "Turn on Show completed issues in Display."
    : filtersActive ? "Try another tab, or clear the search and filters." : "Issues you create in Linear show up here.";

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
            <div className={cn("flex h-11 shrink-0 items-center gap-2 border-b border-fg/[0.06] text-[13px] font-medium text-fg", openNarrowRail ? "pl-2 pr-4" : "px-4")}>
              {openNarrowRail ? (
                <button
                  type="button"
                  className={RAIL_OPENER_CLASS}
                  title="Show views and projects"
                  aria-label="Show views and projects"
                  onClick={openNarrowRail}
                >
                  <SidebarSimple size={15} />
                </button>
              ) : null}
              Inbox
            </div>
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
              onOpenRail={openNarrowRail}
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
            <LinearSelectionBar
              checkedCount={checkedIds.size}
              allVisibleChecked={allVisibleChecked}
              onSelectAll={toggleAllVisible}
              onClear={() => setCheckedIds(new Set())}
              countLabel={totalLabel
                ? `${totalLabel} ${totalLabel === "1" ? "issue" : "issues"}`
                : `${(issues.length + featuredExtra).toLocaleString()} loaded`}
              readyCount={readyToLaunch.length}
              onLaunchReady={() => void handleBatchLaunch(readyToLaunch, {})}
            />
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
            role="list"
            aria-label="Issues"
          >
            {loadingQuickView && !quickView && displayIssues.length === 0 ? (
              <div className="grid h-44 place-items-center text-[12px] text-muted-fg/55">
                <CircleNotch size={16} className="animate-spin" />
              </div>
            ) : listRows.length > 0 ? (
              <>
                <LinearVirtualRows list={virtualList} rows={listRows} renderRow={renderRow} />
                {loadMoreFooter}
              </>
            ) : loadingIssues || pageInfo.hasNextPage ? (
              // Nothing shows yet but Linear has more: the next page may hold rows.
              <div className="flex flex-col items-center gap-1 px-4 py-16 text-center">
                {loadingIssues && !appendingMore ? <CircleNotch size={16} className="animate-spin text-muted-fg/55" /> : loadMoreFooter}
              </div>
            ) : (
              <div className="flex flex-col items-center gap-1 px-4 py-16 text-center">
                <span className="text-[13px] text-fg/80">{emptyTitle}</span>
                <span className="text-[12px] text-muted-fg/70">{emptyHint}</span>
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
