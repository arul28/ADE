import React from "react";
import { useNavigate } from "react-router-dom";
import type {
  CreateLaneFromPrBranchPreflightResult,
  GitHubPrListItem,
  GitHubPrSnapshot,
  LaneSummary,
  MergeMethod,
  PrEventPayload,
  PrSummary,
  PrWithConflicts,
} from "../../../../shared/types";
import { selectActiveProjectRoot, useAppStore, useAppStoreApi } from "../../../state/appStore";
import type { UnmappedAffordance } from "../detail/PrDetailPane";
import { usePrs } from "../state/PrsContext";
import type { PrDetailRouteTab } from "../prsRouteState";
import { getGitHubSnapshotCoalesced } from "../../../lib/prReadCache";
import {
  GITHUB_TAB_HISTORY_INITIAL_PAGE_LIMIT,
  GITHUB_TAB_HISTORY_MAX_PAGE_LIMIT,
  GITHUB_TAB_HISTORY_PAGE_INCREMENT,
  GITHUB_TAB_HOT_REFRESH_DELAY_MS,
  GITHUB_TAB_REVISIT_CACHE_TTL_MS,
  GITHUB_TAB_SNAPSHOT_FRESH_MS,
  LINKED_HYDRATION_LIMIT,
  buildSyntheticUnmappedPr,
  bucketForState,
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

export type GitHubTabProps = {
  lanes: LaneSummary[];
  mergeMethod: MergeMethod;
  selectedPrId: string | null;
  onSelectPr: (id: string | null) => void;
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
  const lastHandledSelectedRef = React.useRef<{ prId: string | null; bucket: GitHubFilter | null } | undefined>(undefined);
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
  const visibleLinkedHydrationKeyRef = React.useRef<string>("");
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
    const map = new Map<string, PrSummary>();
    for (const pr of prs) {
      map.set(pr.id, pr);
    }
    return map;
  }, [prs]);

  const loadSnapshot = React.useCallback(async (options?: {
    force?: boolean;
    silent?: boolean;
    includeExternalClosed?: boolean;
    historyPageLimit?: number;
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
      ...(includeExternalClosed ? { includeExternalClosed: true, historyPageLimit: currentHistoryPageLimit() } : {}),
    });
  }, [currentHistoryPageLimit, loadSnapshot, prs, prsContextLoading, startHotRefreshWindow]);

  const {
    displayedItems,
    filteredItems,
    hydrationItems,
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
  });
  const showListLoadingIndicator = loading || syncing || loadingFilter !== null;

  React.useEffect(() => {
    if (!snapshot) return;

    // Track the selected PR together with its current effective bucket, so a
    // state transition (open -> merged) is followed even though `selectedPrId`
    // is unchanged. A manual filter change leaves the selected PR's bucket
    // untouched, so it never re-triggers the follow below.
    const linkedItem = selectedPrId
      ? displayedItems.find((item) => item.linkedPrId === selectedPrId) ?? null
      : null;
    const currentBucket = linkedItem ? bucketForState(linkedItem.state) : null;
    const nextPrId = selectedPrId ?? null;

    const last = lastHandledSelectedRef.current;
    if (last && last.prId === nextPrId && last.bucket === currentBucket) return;
    const isNewSelection = !last || last.prId !== nextPrId;
    const bucketChanged = !isNewSelection && last!.bucket !== currentBucket;
    lastHandledSelectedRef.current = { prId: nextPrId, bucket: currentBucket };

    if (!selectedPrId || !linkedItem) {
      pendingSelectedItemIdRef.current = null;
      return;
    }

    pendingSelectedItemIdRef.current = linkedItem.id;
    const linkedFilter = bucketForState(linkedItem.state);
    setSelectedItemIdsByFilter((prev) => ({ ...prev, [linkedFilter]: linkedItem.id }));
    // Follow the selection into its bucket on a fresh selection, or when the
    // already-selected PR transitions to a new bucket (so a merge/close doesn't
    // strand the user on a now-empty list). Never on a manual filter switch.
    if ((isNewSelection || bucketChanged) && !matchesFilter(linkedItem, filter)) {
      setFilter(linkedFilter);
    }
    setSelectedItemId(linkedItem.id);
    hasInitializedSelectionRef.current = true;
  }, [displayedItems, snapshot, selectedPrId, filter]);

  React.useEffect(() => {
    if (!snapshot) return;
    if (pendingSelectedItemIdRef.current) {
      if (selectedItemId === pendingSelectedItemIdRef.current) {
        pendingSelectedItemIdRef.current = null;
      } else {
        return;
      }
    }

    if (selectedItemId && filteredItems.some((item) => item.id === selectedItemId)) return;
    if (!hasInitializedSelectionRef.current) {
      const next = filteredItems[0] ?? null;
      if (next) {
        hasInitializedSelectionRef.current = true;
        setSelectedItemId(next.id);
        setSelectedItemIdsByFilter((prev) => ({ ...prev, [filter]: next.id }));
        onSelectPr(next.linkedPrId ?? null);
      }
    }
  }, [snapshot, filter, filteredItems, selectedItemId, onSelectPr]);

  // The row backing the detail pane. Unlike the list highlight, it survives a
  // state transition that moves the row out of the active filter's bucket, so
  // the pane never blanks mid-transition. Cleared only when nothing is selected
  // (`selectedItemId` null) — which is what a manual filter switch to an empty
  // bucket produces. Falls back to the linked coordinate from PrsContext when
  // the row itself has momentarily dropped from the list.
  const selectedItem = React.useMemo((): GitHubPrListItem | null => {
    if (!selectedItemId) return null;
    const byId = displayedItems.find((candidate) => candidate.id === selectedItemId) ?? null;
    if (byId) return byId;
    if (selectedPrId) return displayedItems.find((candidate) => candidate.linkedPrId === selectedPrId) ?? null;
    return null;
  }, [displayedItems, selectedItemId, selectedPrId]);

  // Whether the selected PR still belongs in the active filter. When false the
  // detail pane shows a slim "now Merged/Closed" banner instead of blanking.
  const selectedBucketMismatch = Boolean(selectedItem && !matchesFilter(selectedItem, filter));

  React.useEffect(() => {
    const pending = pendingRestoredSelectedItemIdRef.current;
    if (!pending || !selectedItem || selectedItem.id !== pending) return;
    // Restore selection only once the item is actually in the active filter's
    // list — matching the original filter-scoped restore semantics.
    if (!matchesFilter(selectedItem, filter)) return;
    pendingRestoredSelectedItemIdRef.current = null;
    onSelectPr(selectedItem.linkedPrId ?? null);
  }, [filter, onSelectPr, selectedItem]);
  const missingLinkedPrId = selectedItem?.linkedPrId && !prsByIdMap.has(selectedItem.linkedPrId)
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

  React.useEffect(() => {
    const prIds = hydrationItems
      .slice(0, LINKED_HYDRATION_LIMIT)
      .map((item) => item.linkedPrId)
      .filter((prId): prId is string => Boolean(prId));
    if (prIds.length === 0) return undefined;
    const uniquePrIds = [...new Set(prIds)];
    const key = uniquePrIds.join(",");
    if (visibleLinkedHydrationKeyRef.current === key) return undefined;
    visibleLinkedHydrationKeyRef.current = key;
    const timer = window.setTimeout(() => {
      void onRefreshAll({ prIds: uniquePrIds }).catch(() => {});
    }, 250);
    return () => window.clearTimeout(timer);
  }, [hydrationItems, onRefreshAll]);

  const handleHydrationItemsChange = React.useCallback((items: GitHubPrListItem[]) => {
    setRenderedHydrationItems((prev) => {
      if (prev.length === items.length && prev.every((item, index) => item.id === items[index]?.id)) return prev;
      return items;
    });
  }, []);

  const selectedLinkedPr = React.useMemo(
    (): PrWithConflicts | null => {
      if (!selectedItem?.linkedPrId) return null;
      const linked = prs.find((pr) => pr.id === selectedItem.linkedPrId);
      if (linked) {
        return {
          ...linked,
          stack: selectedItem.stack ?? linked.stack ?? null,
        };
      }
      const fallbackProjectId = prs[0]?.projectId ?? "cached-github-snapshot";
      return {
        id: selectedItem.linkedPrId,
        laneId: selectedItem.linkedLaneId ?? "",
        projectId: fallbackProjectId,
        repoOwner: selectedItem.repoOwner,
        repoName: selectedItem.repoName,
        githubPrNumber: selectedItem.githubPrNumber,
        githubUrl: selectedItem.githubUrl,
        githubNodeId: null,
        title: selectedItem.title,
        state: selectedItem.state,
        baseBranch: selectedItem.baseBranch ?? "",
        headBranch: selectedItem.headBranch ?? "",
        checksStatus: "none",
        reviewStatus: "none",
        additions: 0,
        deletions: 0,
        lastSyncedAt: null,
        createdAt: selectedItem.createdAt,
        updatedAt: selectedItem.updatedAt,
        stack: selectedItem.stack ?? null,
        conflictAnalysis: null,
      };
    },
    [prs, selectedItem],
  );

  // For an unmapped selected PR (no linkedPrId) build a referentially-stable
  // synthetic PR so it can render through the full PrDetailPane. Memoized on the
  // stable synthetic id so the object identity (and React key) stays constant
  // across renders while the same PR is selected.
  const syntheticUnmappedId = selectedItem && !selectedItem.linkedPrId
    ? syntheticUnmappedPrId(selectedItem)
    : null;
  const selectedUnmappedPr = React.useMemo(
    (): PrWithConflicts | null => {
      if (!selectedItem || selectedItem.linkedPrId) return null;
      const fallbackProjectId = prs[0]?.projectId ?? "cached-github-snapshot";
      return buildSyntheticUnmappedPr(selectedItem, fallbackProjectId);
    },
    // syntheticUnmappedId keys identity; prs[0]?.projectId is captured at build time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [syntheticUnmappedId, selectedItem, prs],
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
    onSelectPr(item.linkedPrId ?? null);
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
    if (nextSelectedItemId && !nextSelectedItem) {
      pendingRestoredSelectedItemIdRef.current = nextSelectedItemId;
    } else {
      pendingRestoredSelectedItemIdRef.current = null;
      onSelectPr(nextSelectedItem?.linkedPrId ?? null);
    }
    setLinkLaneId("");
  }, [displayedItems, filter, onSelectPr, selectedItemId, selectedItemIdsByFilter]);

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
      onSelectPr(null);
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
        onSelectPr(mappedPrId);
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
    onUnmap: selectedItem.linkedPrId ? () => handleUnlink(selectedItem) : undefined,
    unmapBusy: Boolean(selectedItem.linkedPrId) && unlinkingPrId === selectedItem.linkedPrId,
    unmapped: !selectedItem.linkedPrId,
    githubCoords: selectedItem.linkedPrId ? null : selectedGithubCoords,
    unmappedAffordance: selectedItem.linkedPrId ? null : unmappedAffordance,
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
          onConnectGitHub: () => navigate("/settings?tab=general#github-connection"),
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
