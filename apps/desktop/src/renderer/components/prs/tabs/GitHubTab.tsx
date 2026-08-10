import React from "react";
import { useNavigate } from "react-router-dom";
import type {
  CreateLaneFromPrBranchPreflightResult,
  GitHubPrListItem,
  GitHubPrSnapshot,
  LaneSummary,
  MergeMethod,
  PrEventPayload,
  PrWithConflicts,
} from "../../../../shared/types";
import { selectActiveProjectRoot, useAppStore, useAppStoreApi } from "../../../state/appStore";
import type { UnmappedAffordance } from "../detail/PrDetailPane";
import { usePrs } from "../state/PrsContext";
import {
  type PrDetailRouteTab,
  type PrRouteSelectionTarget,
} from "../prsRouteState";
import { getGitHubSnapshotCoalesced } from "../../../lib/prReadCache";
import {
  GITHUB_TAB_HISTORY_INITIAL_PAGE_LIMIT,
  GITHUB_TAB_HISTORY_MAX_PAGE_LIMIT,
  GITHUB_TAB_HISTORY_PAGE_INCREMENT,
  GITHUB_TAB_HOT_REFRESH_DELAY_MS,
  GITHUB_TAB_REVISIT_CACHE_TTL_MS,
  GITHUB_TAB_SNAPSHOT_FRESH_MS,
  buildSyntheticUnmappedPr,
  githubCoordKey,
  selectionTargetForItem,
  formatGitHubSnapshotError,
  initialGitHubFilterSelections,
  matchesFilter,
  normalizeGitHubFilter,
  normalizeHistoryPageLimit,
  readGitHubTabWarmCache,
  snapshotRequestKey,
  snapshotRequestSatisfies,
  syntheticUnmappedPrId,
  writeGitHubTabWarmCache,
  type GitHubFilter,
  type GitHubFilterSelectionMap,
  type GitHubSnapshotRequestKey,
  type GitHubTabWarmCache,
} from "./githubTabModel";
import {
  CreateLaneFromPrBranchDialog,
  canCreateLaneFromPrBranch,
  createLaneFromPrBranchApi,
  createLaneFromPrBranchArgs,
  createLaneFromPrBranchRequestKey,
  createLaneMappedLaneId,
  createLaneMappedLaneName,
  createLaneMappedPrId,
  formatActionError,
  patchSnapshotWithMappedPr,
  upsertLaneSummary,
} from "./GitHubTabCreateLaneDialog";
import { GitHubTabView } from "./GitHubTabView";
import { branchNameFromRef } from "./githubPrBranch";
import { useGitHubTabListModel } from "./useGitHubTabListModel";
import { useGitHubTabSelection } from "./useGitHubTabSelection";
import { useGitHubTargetHistory } from "./useGitHubTargetHistory";
import { settingsRouteFor } from "../../settings/settingsManifest";

export type GitHubTabProps = {
  lanes: LaneSummary[];
  mergeMethod: MergeMethod;
  selectedPrId: string | null;
  /** Coordinate fallback for deep links whose ADE row is not local yet. */
  selectedPrTarget?: PrRouteSelectionTarget | null;
  onSelectPr: (id: string | null, target: PrRouteSelectionTarget | null) => void;
  selectedDetailTab?: PrDetailRouteTab | null;
  onDetailTabChange?: (tab: PrDetailRouteTab) => void;
  onRefreshAll: (args?: { prId?: string; prIds?: string[] }) => Promise<void>;
  onOpenRebaseTab?: (laneId?: string) => void;
  relocateHeaderChrome?: boolean;
  onHeaderChromeChange?: (state: GitHubHeaderChromeState | null) => void;
};

export type GitHubHeaderChromeState = {
  repoLabel: string;
  syncing: boolean;
  syncedAt: string | null;
  onSync: () => void;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
};

export function GitHubTab({
  lanes,
  mergeMethod,
  selectedPrId,
  selectedPrTarget = null,
  onSelectPr,
  selectedDetailTab,
  onDetailTabChange,
  onRefreshAll,
  onOpenRebaseTab,
  relocateHeaderChrome = false,
  onHeaderChromeChange,
}: GitHubTabProps) {
  const navigate = useNavigate();
  const appStore = useAppStoreApi();
  const {
    prs,
    detailStatus,
    detailChecks,
    detailReviews,
    detailComments,
    detailSnapshot,
    detailSnapshotsByPrId = {},
    detailLiveDataPrId,
    detailBusy,
    loading: prsContextLoading,
    setViewerLogin: setContextViewerLogin,
  } = usePrs();
  const projectRoot = useAppStore(selectActiveProjectRoot);
  const refreshLanes = useAppStore((s) => s.refreshLanes);
  const selectLane = useAppStore((s) => s.selectLane);

  const initialWarmCacheRef = React.useRef<GitHubTabWarmCache | null>(readGitHubTabWarmCache(projectRoot));
  const [snapshot, setSnapshot] = React.useState<GitHubPrSnapshot | null>(
    () => initialWarmCacheRef.current?.snapshot ?? null,
  );
  const [loading, setLoading] = React.useState(() => !initialWarmCacheRef.current?.snapshot);
  const [error, setError] = React.useState<string | null>(null);
  const [filter, setFilter] = React.useState<GitHubFilter>(() => normalizeGitHubFilter(initialWarmCacheRef.current?.filter));
  const [selectedItemId, setSelectedItemId] = React.useState<string | null>(
    () => initialWarmCacheRef.current?.selectedItemId ?? null,
  );
  const [selectedItemIdsByFilter, setSelectedItemIdsByFilter] = React.useState<GitHubFilterSelectionMap>(
    () => initialGitHubFilterSelections(initialWarmCacheRef.current),
  );
  const [linkLaneId, setLinkLaneId] = React.useState("");
  const [linkingItemId, setLinkingItemId] = React.useState<string | null>(null);
  const [unlinkingPrId, setUnlinkingPrId] = React.useState<string | null>(null);
  const [createLaneItem, setCreateLaneItem] = React.useState<GitHubPrListItem | null>(null);
  const [createLanePreflight, setCreateLanePreflight] = React.useState<CreateLaneFromPrBranchPreflightResult | null>(null);
  const [createLaneLoading, setCreateLaneLoading] = React.useState(false);
  const [createLaneBusy, setCreateLaneBusy] = React.useState(false);
  const [createLaneError, setCreateLaneError] = React.useState<string | null>(null);
  const [syncing, setSyncing] = React.useState(false);
  const [loadingOlderHistory, setLoadingOlderHistory] = React.useState(false);
  const [loadingFilter, setLoadingFilter] = React.useState<GitHubFilter | null>(null);
  const [renderedHydrationItems, setRenderedHydrationItems] = React.useState<GitHubPrListItem[]>([]);
  const [searchQuery, setSearchQuery] = React.useState(() => initialWarmCacheRef.current?.searchQuery ?? "");
  const [externalHistoryLoaded, setExternalHistoryLoaded] = React.useState(
    () => initialWarmCacheRef.current?.externalHistoryLoaded ?? false,
  );
  const createLanePreflightRequestIdRef = React.useRef(0);
  const createLanePreflightRequestRef = React.useRef<{ id: number; itemKey: string } | null>(null);
  const lastHandledSelectedRef = React.useRef<{ key: string | null; bucket: GitHubFilter | null } | undefined>(undefined);
  const lastSeenRowByCoordRef = React.useRef<Map<string, GitHubPrListItem>>(new Map());
  const pendingSelectedItemIdRef = React.useRef<string | null>(null);
  const pendingRestoredSelectedItemIdRef = React.useRef<string | null>(null);
  const snapshotRef = React.useRef<GitHubPrSnapshot | null>(null);
  const hasInitializedSelectionRef = React.useRef(Boolean(initialWarmCacheRef.current?.selectedItemId));
  const lastPrFingerprintRef = React.useRef<string>("");
  const hotRefreshUntilRef = React.useRef(0);
  const hotRefreshTimerRef = React.useRef<number | null>(null);
  const inFlightSnapshotRef = React.useRef<({ request: Promise<GitHubPrSnapshot> } & GitHubSnapshotRequestKey) | null>(null);
  const loadingSnapshotRequestCountRef = React.useRef(0);
  const lastSnapshotLoadedAtRef = React.useRef(initialWarmCacheRef.current?.cachedAt ?? 0);
  const missingLinkedPrHydrationRef = React.useRef<string | null>(null);
  const filterRef = React.useRef(filter);
  const externalHistoryLoadedRef = React.useRef(externalHistoryLoaded);
  const projectRootRef = React.useRef(projectRoot);
  const listRef = React.useRef<HTMLDivElement | null>(null);
  snapshotRef.current = snapshot;
  filterRef.current = filter;
  externalHistoryLoadedRef.current = externalHistoryLoaded;

  const currentHistoryPageLimit = React.useCallback(() => {
    const current = snapshotRef.current?.history?.pageLimit;
    return normalizeHistoryPageLimit(current);
  }, []);

  /* Build a lookup from linkedPrId -> PrSummary for CI/review indicators */
  const prsByIdMap = React.useMemo(() => {
    const map = new Map<string, PrWithConflicts>();
    for (const pr of prs) {
      map.set(pr.id, pr);
    }
    return map;
  }, [prs]);
  const prsByCoordinateMap = React.useMemo(() => {
    const map = new Map<string, PrWithConflicts>();
    for (const pr of prs) {
      map.set(githubCoordKey(pr), pr);
    }
    return map;
  }, [prs]);

  const loadSnapshot = React.useCallback(async (options?: {
    force?: boolean;
    silent?: boolean;
    includeExternalClosed?: boolean;
    historyPageLimit?: number;
    /** A timer or a `prs-updated` reaction, not a person pressing Refresh. */
    automaticRefresh?: boolean;
  }) => {
    const requestKey = snapshotRequestKey(options);
    const inFlightSnapshot = inFlightSnapshotRef.current;
    if (options?.force !== true && inFlightSnapshot && snapshotRequestSatisfies(inFlightSnapshot, requestKey)) {
      return inFlightSnapshot.request;
    }
    const shouldShowLoading = !options?.silent && (options?.force === true || snapshotRef.current == null);
    if (shouldShowLoading) {
      loadingSnapshotRequestCountRef.current += 1;
      setLoading(true);
    }
    setError(null);
    const requestProjectRoot = projectRootRef.current;
    let pending!: Promise<GitHubPrSnapshot>;
    const isCurrentSnapshotRequest = () =>
      inFlightSnapshotRef.current?.request === pending
      && inFlightSnapshotRef.current.includeExternalClosed === requestKey.includeExternalClosed
      && inFlightSnapshotRef.current.historyPageLimit === requestKey.historyPageLimit;
    pending = (async () => {
      return getGitHubSnapshotCoalesced(
        {
          force: options?.force === true,
          // Only sent when true: an automatic refresh is the exception, and the
          // healthy-path payload stays the shape every caller already expects.
          ...(options?.automaticRefresh === true ? { automaticRefresh: true } : {}),
          ...(requestKey.includeExternalClosed ? {
            includeExternalClosed: true,
            historyPageLimit: requestKey.historyPageLimit,
          } : {}),
        },
        { projectRoot: requestProjectRoot },
      );
    })()
      .then((next) => {
        if (!next) return next;
        if (projectRootRef.current !== requestProjectRoot) return next;
        if (!isCurrentSnapshotRequest()) return next;
        setSnapshot(next);
        setExternalHistoryLoaded((prev) => prev || requestKey.includeExternalClosed);
        lastSnapshotLoadedAtRef.current = Date.now();
        if (next.viewerLogin) {
          setContextViewerLogin?.(next.viewerLogin);
        }
        return next;
      })
      .catch((err) => {
        if (projectRootRef.current === requestProjectRoot && isCurrentSnapshotRequest()) {
          setError(formatGitHubSnapshotError(err));
        }
        // Stamp on failure too. The `prs-updated` effect gates on this ref, so
        // leaving it stale meant a failing GitHub never bought any quiet here:
        // every poll tick re-fired a forced snapshot plus a hot-refresh timer.
        lastSnapshotLoadedAtRef.current = Date.now();
        return snapshotRef.current as GitHubPrSnapshot;
      })
      .finally(() => {
        if (isCurrentSnapshotRequest()) {
          inFlightSnapshotRef.current = null;
        }
        if (shouldShowLoading) {
          loadingSnapshotRequestCountRef.current = Math.max(0, loadingSnapshotRequestCountRef.current - 1);
          if (loadingSnapshotRequestCountRef.current === 0 && projectRootRef.current === requestProjectRoot) {
            setLoading(false);
          }
        }
      });
    inFlightSnapshotRef.current = { request: pending, ...requestKey };
    return pending;
  }, [setContextViewerLogin]);

  React.useEffect(() => {
    if (projectRootRef.current === projectRoot) return;
    projectRootRef.current = projectRoot;
    inFlightSnapshotRef.current = null;
    loadingSnapshotRequestCountRef.current = 0;
    const warmCache = readGitHubTabWarmCache(projectRoot);
    initialWarmCacheRef.current = warmCache;
    setSnapshot(warmCache?.snapshot ?? null);
    setLoading(!warmCache?.snapshot);
    setError(null);
    setFilter(normalizeGitHubFilter(warmCache?.filter));
    setSelectedItemId(warmCache?.selectedItemId ?? null);
    setSelectedItemIdsByFilter(initialGitHubFilterSelections(warmCache));
    setSearchQuery(warmCache?.searchQuery ?? "");
    setExternalHistoryLoaded(warmCache?.externalHistoryLoaded ?? false);
    lastSnapshotLoadedAtRef.current = warmCache?.cachedAt ?? 0;
    if (!warmCache?.snapshot) {
      void loadSnapshot({ silent: false });
    }
  }, [loadSnapshot, projectRoot]);

  React.useEffect(() => {
    if (snapshot?.viewerLogin) {
      setContextViewerLogin?.(snapshot.viewerLogin);
    }
  }, [setContextViewerLogin, snapshot?.viewerLogin]);

  const startHotRefreshWindow = React.useCallback(() => {
    if (hotRefreshTimerRef.current != null) return;
    hotRefreshUntilRef.current = Date.now() + GITHUB_TAB_HOT_REFRESH_DELAY_MS;
    hotRefreshTimerRef.current = window.setTimeout(() => {
      hotRefreshTimerRef.current = null;
      hotRefreshUntilRef.current = 0;
      const includeExternalClosed =
        externalHistoryLoadedRef.current || filterRef.current !== "open";
      void loadSnapshot({
        force: true,
        silent: true,
        automaticRefresh: true,
        ...(includeExternalClosed ? { includeExternalClosed: true, historyPageLimit: currentHistoryPageLimit() } : {}),
      });
    }, GITHUB_TAB_HOT_REFRESH_DELAY_MS);
  }, [currentHistoryPageLimit, loadSnapshot]);

  React.useEffect(() => {
    const warmCache = initialWarmCacheRef.current;
    const hasFreshWarmSnapshot =
      Boolean(warmCache?.snapshot)
      && Date.now() - (warmCache?.cachedAt ?? 0) < GITHUB_TAB_REVISIT_CACHE_TTL_MS;
    if (!hasFreshWarmSnapshot) {
      void loadSnapshot({ silent: snapshotRef.current != null });
    }
    return () => {
      if (hotRefreshTimerRef.current != null) {
        window.clearTimeout(hotRefreshTimerRef.current);
        hotRefreshTimerRef.current = null;
      }
      hotRefreshUntilRef.current = 0;
    };
  }, [loadSnapshot]);

  React.useEffect(() => {
    if (!projectRoot) return;
    writeGitHubTabWarmCache({
      projectRoot,
      snapshot,
      filter,
      selectedItemId,
      selectedItemIdsByFilter,
      searchQuery,
      externalHistoryLoaded,
      cachedAt: Date.now(),
    });
  }, [externalHistoryLoaded, filter, projectRoot, searchQuery, selectedItemId, selectedItemIdsByFilter, snapshot]);

  React.useEffect(() => {
    if (filter === "open" || externalHistoryLoaded) return;
    const loadingFor = filter;
    setLoadingFilter(loadingFor);
    void loadSnapshot({
      includeExternalClosed: true,
      historyPageLimit: GITHUB_TAB_HISTORY_INITIAL_PAGE_LIMIT,
      silent: snapshotRef.current != null,
    }).finally(() => {
      setLoadingFilter((current) => current === loadingFor ? null : current);
    });
  }, [externalHistoryLoaded, filter, loadSnapshot]);

  React.useEffect(() => {
    const unsubscribe = window.ade.prs.onEvent((event: PrEventPayload) => {
      if (event.type !== "prs-updated" && event.type !== "pr-auto-linked") return;
      // Same freshness guard as the PR-fingerprint effect below: `prs-updated`
      // fires for any PR-domain write, and a snapshot loaded moments ago has
      // nothing new to show — reloading it costs a full GitHub snapshot fetch.
      if (Date.now() - lastSnapshotLoadedAtRef.current < GITHUB_TAB_SNAPSHOT_FRESH_MS) return;
      const includeExternalClosed =
        externalHistoryLoadedRef.current || filterRef.current !== "open";
      void loadSnapshot({
        silent: true,
        ...(includeExternalClosed ? { includeExternalClosed: true, historyPageLimit: currentHistoryPageLimit() } : {}),
      });
    });
    return unsubscribe;
  }, [currentHistoryPageLimit, loadSnapshot]);

  React.useEffect(() => {
    if (prsContextLoading && prs.length === 0) return;
    const nextFingerprint = JSON.stringify(
      prs
        .map((pr) => [
          pr.id,
          pr.state,
          pr.title,
          pr.githubPrNumber,
        ])
        .sort((left, right) => String(left[0]).localeCompare(String(right[0]))),
    );
    if (!lastPrFingerprintRef.current) {
      lastPrFingerprintRef.current = nextFingerprint;
      return;
    }
    if (lastPrFingerprintRef.current === nextFingerprint) return;
    lastPrFingerprintRef.current = nextFingerprint;
    if (Date.now() - lastSnapshotLoadedAtRef.current < GITHUB_TAB_SNAPSHOT_FRESH_MS) return;
    startHotRefreshWindow();
    const includeExternalClosed =
      externalHistoryLoadedRef.current || filterRef.current !== "open";
    void loadSnapshot({
      force: true,
      silent: true,
      automaticRefresh: true,
      ...(includeExternalClosed ? { includeExternalClosed: true, historyPageLimit: currentHistoryPageLimit() } : {}),
    });
  }, [currentHistoryPageLimit, loadSnapshot, prs, prsContextLoading, startHotRefreshWindow]);

  const {
    displayedItems,
    filteredItems,
    listRows,
    filterCounts,
    canLoadOlderHistory,
  } = useGitHubTabListModel({
    snapshot,
    searchQuery,
    prsByIdMap,
    filter,
    renderedHydrationItems,
    lastSeenRowByCoordRef,
    currentHistoryPageLimit,
    prsByCoordinateMap,
  });
  useGitHubTargetHistory({
    displayedItems,
    loadSnapshot,
    selectedPrId,
    selectedPrTarget,
    snapshot,
  });
  const showListLoadingIndicator = loading || syncing || loadingFilter !== null;

  const { selectedItem, selectedTargetResolved } = useGitHubTabSelection({
    displayedItems,
    filteredItems,
    filter,
    onSelectPr,
    selectedItemId,
    selectedPrId,
    selectedPrTarget,
    snapshot,
    setFilter,
    setSelectedItemId,
    setSelectedItemIdsByFilter,
    lastHandledSelectedRef,
    pendingSelectedItemIdRef,
    pendingRestoredSelectedItemIdRef,
    hasInitializedSelectionRef,
  });
  const selectedBucketMismatch = Boolean(
    selectedItem
    && selectedTargetResolved
    && !matchesFilter(selectedItem, filter),
  );

  const handleHydrationItemsChange = React.useCallback((items: GitHubPrListItem[]) => {
    setRenderedHydrationItems((prev) => {
      if (prev.length === items.length && prev.every((item, index) => item.id === items[index]?.id)) return prev;
      return items;
    });
  }, []);

  const selectedLocalPr = React.useMemo((): PrWithConflicts | null => {
    if (!selectedItem) return null;
    if (selectedItem.linkedPrId) {
      const linked = prsByIdMap.get(selectedItem.linkedPrId);
      if (linked) return linked;
    }
    // Prefer the local row by GitHub coordinates when a stale snapshot has lost
    // its link (or carries a foreign machine's link id).
    return prsByCoordinateMap.get(githubCoordKey(selectedItem)) ?? null;
  }, [prsByCoordinateMap, prsByIdMap, selectedItem]);

  const selectedLinkedPr = React.useMemo(
    (): PrWithConflicts | null => selectedLocalPr
      ? { ...selectedLocalPr, stack: selectedItem?.stack ?? selectedLocalPr.stack ?? null }
      : null,
    [selectedItem?.stack, selectedLocalPr],
  );

  // A GitHub row can carry a foreign or not-yet-hydrated linkedPrId. Until the
  // local row arrives, treat it as coordinate-backed rather than manufacturing
  // a row-backed PR id that cannot be read from this machine.
  const selectedIsUnmapped = Boolean(selectedItem && !selectedLocalPr);
  const selectedMappedPrId = selectedLocalPr?.id ?? selectedItem?.linkedPrId ?? null;
  const missingLinkedPrId = selectedItem?.linkedPrId && !selectedLocalPr
    ? selectedItem.linkedPrId
    : null;

  React.useEffect(() => {
    if (!missingLinkedPrId) {
      missingLinkedPrHydrationRef.current = null;
      return;
    }
    if (missingLinkedPrHydrationRef.current === missingLinkedPrId) return;
    missingLinkedPrHydrationRef.current = missingLinkedPrId;
    void onRefreshAll({ prId: missingLinkedPrId }).catch(() => {});
  }, [missingLinkedPrId, onRefreshAll]);

  const syntheticUnmappedId = selectedIsUnmapped && selectedItem
    ? syntheticUnmappedPrId(selectedItem)
    : null;
  const fallbackProjectId = prs[0]?.projectId ?? "cached-github-snapshot";
  const selectedUnmappedPr = React.useMemo(
    (): PrWithConflicts | null => {
      if (!selectedItem || !selectedIsUnmapped) return null;
      return buildSyntheticUnmappedPr(selectedItem, fallbackProjectId);
    },
    [fallbackProjectId, syntheticUnmappedId, selectedItem, selectedIsUnmapped],
  );
  const selectedDisplayPr = selectedLinkedPr ?? selectedUnmappedPr;

  const selectedGithubCoords = React.useMemo(
    (): { repoOwner: string; repoName: string; githubPrNumber: number } | null =>
      selectedItem
        ? {
            repoOwner: selectedItem.repoOwner,
            repoName: selectedItem.repoName,
            githubPrNumber: selectedItem.githubPrNumber,
          }
        : null,
    [selectedItem],
  );

  // Lanes whose branch matches the unmapped PR's head branch (the same gate the
  // legacy read-only pane used) — offered in the in-pane "Map to lane" select.
  const linkableLanesForSelected = React.useMemo(
    () => {
      if (!selectedItem) return [] as Array<{ id: string; name: string }>;
      const headBranch = branchNameFromRef(selectedItem.headBranch);
      return lanes
        .filter((lane) => {
          if (lane.archivedAt || lane.laneType === "primary") return false;
          if (!headBranch) return true;
          return branchNameFromRef(lane.branchRef) === headBranch;
        })
        .map((lane) => ({ id: lane.id, name: lane.name }));
    },
    [lanes, selectedItem],
  );

  const selectedStack = React.useMemo(() => {
    const membership = selectedItem?.stack;
    if (!membership) return null;
    return snapshot?.stacks?.find(
      (stack) => stack.id === membership.id || stack.number === membership.number,
    ) ?? null;
  }, [selectedItem?.stack, snapshot?.stacks]);

  const handleSync = React.useCallback(async (args: { prId?: string; prIds?: string[] } = {}) => {
    setSyncing(true);
    startHotRefreshWindow();
    try {
      const targeted = Boolean(args.prId || (args.prIds?.length ?? 0) > 0);
      const includeExternalClosed =
        externalHistoryLoadedRef.current || filterRef.current !== "open";
      if (targeted) {
        await onRefreshAll(args).catch(() => {});
      } else {
        await Promise.all([
          onRefreshAll().catch(() => {}),
          loadSnapshot({
            force: true,
            ...(includeExternalClosed ? { includeExternalClosed: true, historyPageLimit: currentHistoryPageLimit() } : {}),
          }),
        ]);
      }
    } finally {
      setSyncing(false);
    }
  }, [currentHistoryPageLimit, loadSnapshot, onRefreshAll, startHotRefreshWindow]);

  const handleAddStackPullRequests = React.useCallback(async (pullRequests: number[]) => {
    if (!selectedStack || !snapshot?.repo) return;
    await window.ade.prs.addGitHubStackPullRequests({
      repo: snapshot.repo,
      stackNumber: selectedStack.number,
      pullRequests,
    });
    await loadSnapshot({ silent: true });
  }, [loadSnapshot, selectedStack, snapshot?.repo]);

  const handleUnstack = React.useCallback(async () => {
    if (!selectedStack || !snapshot?.repo) return;
    await window.ade.prs.unstackGitHubStack({
      repo: snapshot.repo,
      stackNumber: selectedStack.number,
    });
    await loadSnapshot({ silent: true });
  }, [loadSnapshot, selectedStack, snapshot?.repo]);

  const handleLoadOlderHistory = React.useCallback(async () => {
    if (loadingOlderHistory) return;
    const nextLimit = Math.min(
      GITHUB_TAB_HISTORY_MAX_PAGE_LIMIT,
      currentHistoryPageLimit() + GITHUB_TAB_HISTORY_PAGE_INCREMENT,
    );
    setLoadingOlderHistory(true);
    setLoadingFilter(filter);
    try {
      await loadSnapshot({
        force: true,
        includeExternalClosed: true,
        historyPageLimit: nextLimit,
        silent: true,
      });
      setExternalHistoryLoaded(true);
    } finally {
      setLoadingOlderHistory(false);
      setLoadingFilter((current) => current === filter ? null : current);
    }
  }, [currentHistoryPageLimit, filter, loadSnapshot, loadingOlderHistory]);

  const repoLabel = snapshot?.repo ? `${snapshot.repo.owner}/${snapshot.repo.name}` : "";

  React.useEffect(() => {
    if (!relocateHeaderChrome || !onHeaderChromeChange) return;
    onHeaderChromeChange({
      repoLabel,
      syncing,
      syncedAt: snapshot?.syncedAt ?? null,
      onSync: () => {
        void handleSync();
      },
      searchQuery,
      onSearchQueryChange: setSearchQuery,
    });
  }, [handleSync, onHeaderChromeChange, relocateHeaderChrome, repoLabel, searchQuery, snapshot?.syncedAt, syncing]);

  React.useEffect(() => {
    if (!relocateHeaderChrome || !onHeaderChromeChange) return;
    return () => onHeaderChromeChange(null);
  }, [onHeaderChromeChange, relocateHeaderChrome]);

  const handleSelectItem = React.useCallback((item: GitHubPrListItem) => {
    hasInitializedSelectionRef.current = true;
    setSelectedItemId(item.id);
    setSelectedItemIdsByFilter((prev) => ({ ...prev, [filter]: item.id }));
    pendingRestoredSelectedItemIdRef.current = null;
    onSelectPr(item.linkedPrId ?? null, selectionTargetForItem(item));
    setLinkLaneId("");
  }, [filter, onSelectPr]);

  const handleFilterChange = React.useCallback((state: GitHubFilter) => {
    pendingSelectedItemIdRef.current = null;
    if (state !== filter && listRef.current) {
      if (typeof listRef.current.scrollTo === "function") {
        listRef.current.scrollTo({ top: 0, left: 0 });
      } else {
        listRef.current.scrollTop = 0;
      }
    }
    const cachedSelectedItemId = selectedItemIdsByFilter[state] ?? null;
    const cachedSelectedItem = cachedSelectedItemId
      ? displayedItems.find((item) => item.id === cachedSelectedItemId) ?? null
      : null;
    const nextSelectedItemId = cachedSelectedItem && !matchesFilter(cachedSelectedItem, state)
      ? null
      : cachedSelectedItemId;
    const nextSelectedItem = cachedSelectedItem && nextSelectedItemId
      ? cachedSelectedItem
      : null;
    setFilter(state);
    setSelectedItemIdsByFilter((prev) => ({ ...prev, [filter]: selectedItemId, [state]: nextSelectedItemId }));
    setSelectedItemId(nextSelectedItemId);
    // Clearing an explicit deep link via a filter switch is a deliberate
    // empty selection. Do not let the snapshot auto-initializer immediately
    // replace it with the first row in the new bucket.
    if (!nextSelectedItem && (selectedPrId || selectedPrTarget)) {
      hasInitializedSelectionRef.current = true;
    }
    if (nextSelectedItemId && !nextSelectedItem) {
      pendingRestoredSelectedItemIdRef.current = nextSelectedItemId;
    } else {
      pendingRestoredSelectedItemIdRef.current = null;
      if (nextSelectedItem) onSelectPr(nextSelectedItem.linkedPrId ?? null, selectionTargetForItem(nextSelectedItem));
      else onSelectPr(null, null);
    }
    setLinkLaneId("");
  }, [displayedItems, filter, onSelectPr, selectedItemId, selectedItemIdsByFilter, selectedPrId, selectedPrTarget]);

  const handleLink = React.useCallback(async () => {
    if (!selectedItem || !linkLaneId) return;
    setLinkingItemId(selectedItem.id);
    setError(null);
    try {
      await window.ade.prs.linkToLane({ laneId: linkLaneId, prUrlOrNumber: selectedItem.githubUrl });
      await handleSync();
      setLinkLaneId("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLinkingItemId(null);
    }
  }, [handleSync, linkLaneId, selectedItem]);

  const handleUnlink = React.useCallback(async (item: GitHubPrListItem | null = selectedItem) => {
    if (!item?.linkedPrId) return;
    const confirmed = typeof window.confirm !== "function"
      ? true
      : window.confirm(`Unmap PR #${item.githubPrNumber} from its ADE lane? ADE will keep the GitHub PR open and remember not to relink it automatically.`);
    if (!confirmed) return;
    setUnlinkingPrId(item.linkedPrId);
    setError(null);
    try {
      await window.ade.prs.delete({
        prId: item.linkedPrId,
        closeOnGitHub: false,
        archiveLane: false,
      });
      onSelectPr(null, selectionTargetForItem(item));
      setSelectedItemId(item.id);
      setSelectedItemIdsByFilter((prev) => ({ ...prev, [filterRef.current]: item.id }));
      await Promise.all([
        onRefreshAll().catch(() => {}),
        loadSnapshot({
          force: true,
          silent: true,
          ...(externalHistoryLoadedRef.current || filterRef.current !== "open" ? { includeExternalClosed: true } : {}),
        }).catch(() => null),
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setUnlinkingPrId(null);
    }
  }, [loadSnapshot, onRefreshAll, onSelectPr, selectedItem]);

  const handleOpenCreateLaneFromPrBranch = React.useCallback((item: GitHubPrListItem | null = selectedItem) => {
    if (!item) return;
    const requestId = createLanePreflightRequestIdRef.current + 1;
    const itemKey = createLaneFromPrBranchRequestKey(item);
    createLanePreflightRequestIdRef.current = requestId;
    createLanePreflightRequestRef.current = { id: requestId, itemKey };
    const isCurrentPreflightRequest = () => {
      const current = createLanePreflightRequestRef.current;
      return current?.id === requestId && current.itemKey === itemKey;
    };
    setCreateLaneItem(item);
    setCreateLanePreflight(null);
    setCreateLaneError(null);
    setCreateLaneLoading(true);
    void createLaneFromPrBranchApi()
      .preflightCreateLaneFromPrBranch(createLaneFromPrBranchArgs(item))
      .then((result) => {
        if (!isCurrentPreflightRequest()) return;
        setCreateLanePreflight(result);
      })
      .catch((err) => {
        if (!isCurrentPreflightRequest()) return;
        setCreateLaneError(formatActionError(err));
      })
      .finally(() => {
        if (!isCurrentPreflightRequest()) return;
        setCreateLaneLoading(false);
      });
  }, [selectedItem]);

  const handleCancelCreateLaneFromPrBranch = React.useCallback(() => {
    if (createLaneBusy) return;
    createLanePreflightRequestRef.current = null;
    setCreateLaneItem(null);
    setCreateLanePreflight(null);
    setCreateLaneError(null);
    setCreateLaneLoading(false);
  }, [createLaneBusy]);

  const handleConfirmCreateLaneFromPrBranch = React.useCallback(async () => {
    if (!createLaneItem) return;
    setCreateLaneBusy(true);
    setCreateLaneError(null);
    const createProjectRoot = projectRoot;
    try {
      const result = await createLaneFromPrBranchApi()
        .createLaneFromPrBranch(createLaneFromPrBranchArgs(createLaneItem));
      const mappedPrId = createLaneMappedPrId(result);
      const mappedLaneId = createLaneMappedLaneId(result);
      if (mappedPrId) {
        setSnapshot((current) => current
          ? patchSnapshotWithMappedPr(current, createLaneItem, {
              mappedPrId,
              laneId: mappedLaneId,
              laneName: createLaneMappedLaneName(result),
            })
          : current);
        setSelectedItemId(createLaneItem.id);
        setSelectedItemIdsByFilter((prev) => ({ ...prev, [filterRef.current]: createLaneItem.id }));
        onSelectPr(mappedPrId, {
          ...selectionTargetForItem(createLaneItem),
          prId: mappedPrId,
        });
      }
      setCreateLaneItem(null);
      setCreateLanePreflight(null);
      const syncCreatedLane = result.lane?.id
        ? refreshLanes({ includeStatus: false, includeSnapshots: false })
          .catch(() => {})
          .then(() => {
            const currentProjectRoot = selectActiveProjectRoot(appStore.getState());
            if (createProjectRoot && currentProjectRoot !== createProjectRoot) return;
            appStore.setState((prev) => ({
              lanes: upsertLaneSummary(prev.lanes, result.lane),
              laneSnapshots: prev.laneSnapshots.map((snapshot) =>
                snapshot.lane.id === result.lane.id ? { ...snapshot, lane: result.lane } : snapshot,
              ),
              lanesLoading: false,
            }));
            selectLane(result.lane.id);
          })
        : Promise.resolve();
      await Promise.all([
        mappedPrId ? onRefreshAll({ prId: mappedPrId }).catch(() => {}) : onRefreshAll().catch(() => {}),
        loadSnapshot({
          force: true,
          silent: true,
          ...(externalHistoryLoadedRef.current || filterRef.current !== "open" ? { includeExternalClosed: true } : {}),
        }).catch(() => null),
        syncCreatedLane,
      ]);
    } catch (err) {
      setCreateLaneError(formatActionError(err));
    } finally {
      setCreateLaneBusy(false);
    }
  }, [appStore, createLaneItem, loadSnapshot, onRefreshAll, onSelectPr, projectRoot, refreshLanes, selectLane]);

  // Create/map controls surfaced inside PrDetailPane for an unmapped selected PR.
  const unmappedAffordance = React.useMemo((): UnmappedAffordance | null => {
    if (!selectedItem || selectedItem.linkedPrId) return null;
    return {
      linkableLanes: linkableLanesForSelected,
      selectedLaneId: linkLaneId,
      onSelectLane: setLinkLaneId,
      onLink: () => { void handleLink(); },
      linkBusy: linkingItemId === selectedItem.id,
      canCreateLane: canCreateLaneFromPrBranch(selectedItem, lanes),
      onCreateLane: () => handleOpenCreateLaneFromPrBranch(selectedItem),
      scope: selectedItem.scope,
    };
  }, [
    handleLink,
    handleOpenCreateLaneFromPrBranch,
    lanes,
    linkLaneId,
    linkableLanesForSelected,
    linkingItemId,
    selectedItem,
  ]);

  const detailPaneProps = selectedItem && selectedDisplayPr ? {
    pr: selectedDisplayPr,
    status: selectedLinkedPr ? detailStatus : null,
    checks: selectedLinkedPr ? detailChecks : [],
    reviews: selectedLinkedPr ? detailReviews : [],
    comments: selectedLinkedPr ? detailComments : [],
    snapshotHydration: selectedLinkedPr
      ? (detailSnapshot?.prId === selectedDisplayPr.id
          ? detailSnapshot
          : detailSnapshotsByPrId[selectedDisplayPr.id] ?? null)
      : null,
    snapshotHydrationOwnedByContext: Boolean(selectedLinkedPr),
    liveDetailReady: Boolean(selectedLinkedPr) && detailLiveDataPrId === selectedDisplayPr.id,
    detailBusy,
    lanes,
    mergeMethod,
    onRefresh: handleSync,
    onNavigate: navigate,
    onOpenRebaseTab,
    initialDetailTab: selectedDetailTab,
    onDetailTabChange,
    onUnmap: !selectedIsUnmapped && selectedMappedPrId
      ? () => handleUnlink({ ...selectedItem, linkedPrId: selectedMappedPrId })
      : undefined,
    unmapBusy: !selectedIsUnmapped && Boolean(selectedMappedPrId) && unlinkingPrId === selectedMappedPrId,
    unmapped: selectedIsUnmapped,
    provisional: Boolean(selectedPrTarget && !selectedTargetResolved),
    githubCoords: selectedIsUnmapped ? selectedGithubCoords : null,
    unmappedAffordance: selectedIsUnmapped && selectedTargetResolved ? unmappedAffordance : null,
  } : null;

  return (
    <>
      <GitHubTabView
        chrome={{
          relocated: relocateHeaderChrome,
          searchQuery,
          onSearchQueryChange: setSearchQuery,
          repoLabel,
          syncing,
          syncedAt: snapshot?.syncedAt ?? null,
          onSync: () => { void handleSync(); },
          error,
          onConnectGitHub: () => navigate(settingsRouteFor("integrations.github")),
        }}
        list={{
          parentRef: listRef,
          filter,
          filterCounts,
          loading,
          loadingFilter,
          loadingOlderHistory,
          showLoadingIndicator: showListLoadingIndicator,
          hasSnapshot: Boolean(snapshot),
          filteredItems,
          rows: listRows,
          selectedItemId,
          prsByIdMap,
          canLoadOlderHistory,
          onFilterChange: handleFilterChange,
          onSelect: handleSelectItem,
          onHydrationItemsChange: handleHydrationItemsChange,
          onLoadOlderHistory: () => { void handleLoadOlderHistory(); },
        }}
        detail={{
          selectedItem,
          selectedBucketMismatch,
          selectedStack,
          displayedItems,
          paneProps: detailPaneProps,
          onSelect: handleSelectItem,
          onSync: () => { void handleSync(); },
          onAddStackPullRequests: handleAddStackPullRequests,
          onUnstack: handleUnstack,
          onFilterChange: handleFilterChange,
        }}
      />
      {createLaneItem ? (
        <CreateLaneFromPrBranchDialog
          item={createLaneItem}
          preflight={createLanePreflight?.preflight ?? null}
          loading={createLaneLoading}
          busy={createLaneBusy}
          error={createLaneError}
          onCancel={handleCancelCreateLaneFromPrBranch}
          onConfirm={handleConfirmCreateLaneFromPrBranch}
        />
      ) : null}
    </>
  );
}
