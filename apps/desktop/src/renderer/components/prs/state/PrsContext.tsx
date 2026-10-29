import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
} from "react";
import type {
  PrWithConflicts,
  PrCheck,
  PrComment,
  PrReview,
  PrStatus,
  MergeMethod,
  PrEventPayload,
  LaneSummary,
  PrReviewThread,
  PrDeployment,
  PrSnapshotHydration,
} from "../../../../shared/types";
import { hasExplicitPrsRouteState, parsePrsRouteState, prRouteCoordinatesKey } from "../prsRouteState";
import { selectActiveProjectRoot, useAppStore } from "../../../state/appStore";
import { useDebouncedLaneLifecycleRefresh } from "../../../hooks/useLaneListInvalidation";
import { useGithubPollGovernor, type GithubPollGovernor } from "./useGithubPollGovernor";
import { notePrChangeFiles, prChangeSplitKey, setPrChangeSplitStandDown } from "../shared/prChangeSplitStore";

type PrRefreshArgs = { prId?: string; prIds?: string[] };

type RefreshCoreOptions = {
  skipFreshWarmCache?: boolean;
  /** Ask GitHub before reading the local rows. */
  awaitGithubRefresh?: boolean;
  githubRefreshArgs?: PrRefreshArgs;
};

const REFRESH_ERROR_RETRY_DELAYS_MS = [1_500, 3_000, 6_000] as const;
const PRS_LANE_LIFECYCLE_REFRESH_DEBOUNCE_MS = 180;

function normalizePrRefreshArgs(args?: PrRefreshArgs): PrRefreshArgs | undefined {
  const prIds = [
    ...(args?.prId ? [args.prId] : []),
    ...(args?.prIds ?? []),
  ].map((prId) => String(prId ?? "").trim()).filter(Boolean);
  const uniquePrIds = [...new Set(prIds)];
  if (uniquePrIds.length === 0) return undefined;
  return uniquePrIds.length === 1 ? { prId: uniquePrIds[0] } : { prIds: uniquePrIds };
}

function mergePrRefreshArgs(a?: PrRefreshArgs, b?: PrRefreshArgs): PrRefreshArgs | undefined {
  return normalizePrRefreshArgs({
    prIds: [
      ...(a?.prId ? [a.prId] : []),
      ...(a?.prIds ?? []),
      ...(b?.prId ? [b.prId] : []),
      ...(b?.prIds ?? []),
    ],
  });
}

function mergeRefreshCoreOptions(a: RefreshCoreOptions | null, b: RefreshCoreOptions): RefreshCoreOptions {
  return {
    skipFreshWarmCache: a
      ? Boolean(a.skipFreshWarmCache && b.skipFreshWarmCache)
      : Boolean(b.skipFreshWarmCache),
    awaitGithubRefresh: Boolean(a?.awaitGithubRefresh || b.awaitGithubRefresh),
    githubRefreshArgs: mergePrRefreshArgs(a?.githubRefreshArgs, b.githubRefreshArgs),
  };
}

/** A locally-confirmed terminal transition, awaiting the next GitHub read. */
export type OptimisticTerminalState = {
  state: "merged" | "closed";
  at: string;
};

type PrsState = {
  prs: PrWithConflicts[];
  lanes: LaneSummary[];
  selectedPrId: string | null;
  mergeMethod: MergeMethod;
  loading: boolean;
  error: string | null;

  // Detail state
  detailStatus: PrStatus | null;
  detailChecks: PrCheck[];
  detailReviews: PrReview[];
  detailComments: PrComment[];
  detailReviewThreads: PrReviewThread[];
  detailDeployments: PrDeployment[];
  detailSnapshot: PrSnapshotHydration | null;
  detailSnapshotsByPrId: Record<string, PrSnapshotHydration>;
  detailLiveDataPrId: string | null;
  detailBusy: boolean;

  viewerLogin: string | null;
  writeViewerLogin?: string | null;

  /**
   * PRs the user just merged or closed, keyed by GitHub coordinates.
   *
   * A merge or a close is confirmed by GitHub before it lands here, but the
   * list is painted from the GitHub snapshot and the local rows, and neither
   * updates for several seconds. Without this the PR sits in Open until a
   * refetch, which reads as "nothing happened". The snapshot overwrites it as
   * soon as it agrees.
   */
  optimisticTerminalStates: Record<string, OptimisticTerminalState>;
};

type PrsContextValue = PrsState & {
  setSelectedPrId: (id: string | null) => void;
  setMergeMethod: (method: MergeMethod) => void;
  refresh: (args?: { prId?: string; prIds?: string[] }) => Promise<void>;

  setViewerLogin: (login: string | null) => void;
  setWriteViewerLogin: (login: string | null) => void;
  /** Record a merge/close the moment GitHub confirms it, before any refetch. */
  markPrTerminalLocally: (
    coords: { repoOwner: string; repoName: string; githubPrNumber: number },
    state: "merged" | "closed",
  ) => void;
  /**
   * Drop a recorded merge/close. Reopening is the one action that undoes a
   * close, and without this the override would keep painting the PR as closed
   * until it expires — including in the detail pane, which reads the same
   * reconciled rows.
   */
  clearPrTerminalLocally: (
    coords: { repoOwner: string; repoName: string; githubPrNumber: number },
  ) => void;
} & GithubPollGovernor;

const PrsContext = createContext<PrsContextValue | null>(null);

const PRS_CONTEXT_CACHE_TTL_MS = 120_000;
const PRS_DETAIL_CACHE_TTL_MS = 60_000;
const PRS_CONTEXT_DEFAULT_CACHE_KEY = "__default_project__";
const PRS_CONTEXT_CACHE_DISABLED = import.meta.env.MODE === "test";

type PrsContextWarmCache = {
  prs: PrWithConflicts[];
  lanes: LaneSummary[];
  selectedPrId: string | null;
  mergeMethod: MergeMethod;
  detailStatus: PrStatus | null;
  detailChecks: PrCheck[];
  detailReviews: PrReview[];
  detailComments: PrComment[];
  detailReviewThreads: PrReviewThread[];
  detailDeployments: PrDeployment[];
  detailSnapshotsByPrId: Record<string, PrSnapshotHydration>;
  viewerLogin: string | null;
  writeViewerLogin?: string | null;
  cachedAt: number;
  dataLoadedAt: number;
};

const prsContextWarmCacheByProject = new Map<string, PrsContextWarmCache>();

function prsContextCacheKey(projectRoot?: string | null): string {
  const normalized = projectRoot?.trim();
  return normalized || PRS_CONTEXT_DEFAULT_CACHE_KEY;
}

function readPrsContextWarmCache(projectRoot?: string | null): PrsContextWarmCache | null {
  if (PRS_CONTEXT_CACHE_DISABLED) return null;
  return prsContextWarmCacheByProject.get(prsContextCacheKey(projectRoot)) ?? null;
}

function readInitialSelectedPrId(fallback?: PrsContextWarmCache | null): string | null {
  try {
    const route = parsePrsRouteState({
      search: window.location.search,
      hash: window.location.hash,
    });
    if (!hasExplicitPrsRouteState(route) && fallback) return fallback.selectedPrId;
    return route.prId;
  } catch { /* ignore */ }
  return null;
}

function requirePrId(prId: string): string {
  const normalized = String(prId ?? "").trim();
  if (!normalized) throw new Error("PR id is required.");
  return normalized;
}

/** Remove entries from a keyed record whose key is not in the allowed set. */
function pruneByAllowedIds<T>(record: Record<string, T>, allowedIds: Set<string>): Record<string, T> {
  const next = Object.fromEntries(
    Object.entries(record).filter(([id]) => allowedIds.has(id)),
  ) as Record<string, T>;
  return jsonEqual(record, next) ? record : next;
}

/** Shallow-compare two JSON-serializable values to avoid unnecessary re-renders. */
function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function diffPrIds(prev: PrWithConflicts[], next: PrWithConflicts[]): string[] {
  const prevById = new Map(prev.map((pr) => [pr.id, pr] as const));
  const nextById = new Map(next.map((pr) => [pr.id, pr] as const));
  const changed: string[] = [];

  for (const pr of next) {
    const previous = prevById.get(pr.id);
    if (!previous || !jsonEqual(previous, pr)) {
      changed.push(pr.id);
    }
  }

  for (const pr of prev) {
    if (!nextById.has(pr.id)) {
      changed.push(pr.id);
    }
  }

  return [...new Set(changed)];
}

/** PR ids per snapshot warm-up request (keeps each sync reply small). */
const PR_SNAPSHOT_WARM_BATCH = 25;

export function PrsProvider({ active = true, children }: { active?: boolean; children: React.ReactNode }) {
  const projectRoot = useAppStore(selectActiveProjectRoot);
  const cacheKey = prsContextCacheKey(projectRoot);
  const warmCache = useMemo(() => readPrsContextWarmCache(projectRoot), [projectRoot]);
  const warmCacheHydratedAtRef = React.useRef(warmCache?.dataLoadedAt ?? warmCache?.cachedAt ?? 0);

  // Read the route's PR exactly once per provider mount. The warm-cache
  // dependency is stable for the mount and lets plain /prs restores resume the
  // last in-memory selection.
  const initialSelectedPrId = useMemo(() => readInitialSelectedPrId(warmCache), [warmCache]);
  const [prs, setPrs] = useState<PrWithConflicts[]>(() => warmCache?.prs ?? []);
  const [lanes, setLanes] = useState<LaneSummary[]>(() => warmCache?.lanes ?? []);
  const [selectedPrId, setSelectedPrId] = useState<string | null>(initialSelectedPrId);
  const [mergeMethod, setMergeMethod] = useState<MergeMethod>(() => warmCache?.mergeMethod ?? "squash");
  const [loading, setLoading] = useState(!warmCache);
  const [error, setError] = useState<string | null>(null);

  // Detail state
  const [detailStatus, setDetailStatus] = useState<PrStatus | null>(() => warmCache?.detailStatus ?? null);
  const [detailChecks, setDetailChecks] = useState<PrCheck[]>(() => warmCache?.detailChecks ?? []);
  const [detailReviews, setDetailReviews] = useState<PrReview[]>(() => warmCache?.detailReviews ?? []);
  const [detailComments, setDetailComments] = useState<PrComment[]>(() => warmCache?.detailComments ?? []);
  const [detailReviewThreads, setDetailReviewThreads] = useState<PrReviewThread[]>(
    () => warmCache?.detailReviewThreads ?? [],
  );
  const [detailDeployments, setDetailDeployments] = useState<PrDeployment[]>(() => warmCache?.detailDeployments ?? []);
  const [detailSnapshot, setDetailSnapshot] = useState<PrSnapshotHydration | null>(null);
  const [detailSnapshotsByPrId, setDetailSnapshotsByPrId] = useState<Record<string, PrSnapshotHydration>>(
    () => warmCache?.detailSnapshotsByPrId ?? {},
  );
  const [detailLiveDataPrId, setDetailLiveDataPrId] = useState<string | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [viewerLogin, setViewerLogin] = useState<string | null>(() => warmCache?.viewerLogin ?? null);
  const [writeViewerLogin, setWriteViewerLogin] = useState<string | null | undefined>(
    () => warmCache?.writeViewerLogin,
  );
  const [optimisticTerminalStates, setOptimisticTerminalStates] = useState<
    Record<string, OptimisticTerminalState>
  >({});
  const markPrTerminalLocally = useCallback(
    (
      coords: { repoOwner: string; repoName: string; githubPrNumber: number },
      state: "merged" | "closed",
    ) => {
      const key = prRouteCoordinatesKey({
        repoOwner: coords.repoOwner,
        repoName: coords.repoName,
        prNumber: Number(coords.githubPrNumber),
      });
      setOptimisticTerminalStates((prev) => (
        prev[key]?.state === state ? prev : { ...prev, [key]: { state, at: new Date().toISOString() } }
      ));
    },
    [],
  );
  const clearPrTerminalLocally = useCallback(
    (coords: { repoOwner: string; repoName: string; githubPrNumber: number }) => {
      const key = prRouteCoordinatesKey({
        repoOwner: coords.repoOwner,
        repoName: coords.repoName,
        prNumber: Number(coords.githubPrNumber),
      });
      setOptimisticTerminalStates((prev) => {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
    },
    [],
  );

  const detailCacheHasDataRef = React.useRef(false);
  const detailSnapshotLoadedAtByPrIdRef = React.useRef<Record<string, number>>({});
  const detailSnapshotStatePrIdRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    detailCacheHasDataRef.current =
      detailStatus !== null
      || detailChecks.length > 0
      || detailReviews.length > 0
      || detailComments.length > 0
      || detailReviewThreads.length > 0
      || detailDeployments.length > 0
      || detailSnapshot !== null;
  }, [
    detailChecks.length,
    detailComments.length,
    detailDeployments.length,
    detailReviewThreads.length,
    detailReviews.length,
    detailSnapshot,
    detailStatus,
  ]);

  // Concurrency guard for refresh
  const refreshInFlight = React.useRef(false);
  const refreshPending = React.useRef<RefreshCoreOptions | null>(null);
  const [refreshErrorRetryCount, setRefreshErrorRetryCount] = React.useState(0);
  const prsRef = React.useRef<PrWithConflicts[]>(warmCache?.prs ?? []);
  React.useEffect(() => { prsRef.current = prs; }, [prs]);

  // Refs for detail polling
  const selectedPrIdRef = React.useRef<string | null>(initialSelectedPrId);
  React.useEffect(() => { selectedPrIdRef.current = selectedPrId; }, [selectedPrId]);
  const detailFetchInProgress = React.useRef(false);
  const detailStatePrIdRef = React.useRef<string | null>(warmCache?.selectedPrId ?? null);
  const detailLoadedAtByPrIdRef = React.useRef<Record<string, number>>(
    warmCache?.selectedPrId ? { [warmCache.selectedPrId]: warmCache.cachedAt } : {},
  );
  const detailSnapshotsByPrIdRef = React.useRef<Record<string, PrSnapshotHydration>>({});
  React.useEffect(() => {
    detailSnapshotsByPrIdRef.current = detailSnapshotsByPrId;
  }, [detailSnapshotsByPrId]);

  const mergeDetailSnapshots = useCallback((snapshots: PrSnapshotHydration[]) => {
    const validSnapshots = snapshots.filter((snapshot) => snapshot?.prId);
    if (validSnapshots.length === 0) return;
    // List rows read their code / tests / docs split from these files rather
    // than asking GitHub. Stored unsummarized, so this is one Map write each.
    const prById = new Map(prsRef.current.map((pr) => [pr.id, pr] as const));
    for (const snapshot of validSnapshots) {
      const pr = prById.get(snapshot.prId);
      if (pr && snapshot.files?.length) notePrChangeFiles(prChangeSplitKey(pr), snapshot.files);
    }
    setDetailSnapshotsByPrId((prev) => {
      let changed = false;
      const next = { ...prev };
      const now = Date.now();
      for (const snapshot of validSnapshots) {
        if (!jsonEqual(next[snapshot.prId], snapshot)) {
          next[snapshot.prId] = snapshot;
          changed = true;
        }
        detailSnapshotLoadedAtByPrIdRef.current[snapshot.prId] = now;
      }
      return changed ? next : prev;
    });
  }, []);

  // Warm only the snapshots the list can show without a click: open and draft
  // PRs. A merged PR's snapshot (files, checks, comments) loads when it is
  // opened. Asking for every stored snapshot decoded ~17 MB on a large repo on
  // every list change, and over sync it exceeds the reply size limit.
  const prsSnapshotWarmIds = useMemo(
    () => prs.filter((pr) => pr.state === "open" || pr.state === "draft").map((pr) => pr.id).sort(),
    [prs],
  );
  const prsSnapshotWarmKey = prsSnapshotWarmIds.join("|");
  React.useEffect(() => {
    if (!active || prsSnapshotWarmIds.length === 0 || typeof window.ade.prs.listSnapshots !== "function") {
      return undefined;
    }
    let cancelled = false;
    const batches: string[][] = [];
    for (let index = 0; index < prsSnapshotWarmIds.length; index += PR_SNAPSHOT_WARM_BATCH) {
      batches.push(prsSnapshotWarmIds.slice(index, index + PR_SNAPSHOT_WARM_BATCH));
    }
    void (async () => {
      for (const prIds of batches) {
        if (cancelled) return;
        try {
          const snapshots = await window.ade.prs.listSnapshots({ prIds });
          if (cancelled) return;
          const linkedPrIds = new Set(prsRef.current.map((pr) => pr.id));
          mergeDetailSnapshots(snapshots.filter((snapshot) => linkedPrIds.has(snapshot.prId)));
        } catch {
          // A failed batch leaves those PRs to load on open.
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the id list's content
  }, [active, mergeDetailSnapshots, prsSnapshotWarmKey]);

  // Track whether the initial data load has completed
  const initialLoadDone = React.useRef(Boolean(warmCache));

  // Core refresh (guarded against concurrent calls).
  // If a refresh is requested while one is already in flight, we set a
  // pending flag so that once the current flight completes it immediately
  // kicks off another refresh instead of silently dropping the request.
  const applyLocalPrState = useCallback(async () => {
    if (!active) return;
    const [prList, laneList] = await Promise.all([
      window.ade.prs.listWithConflicts(),
      window.ade.lanes.list({ includeStatus: false }),
    ]);

    // Stable-reference updates: only replace state when data actually changed
    // to avoid unnecessary re-render cascades in child components.
    setPrs((prev) => (jsonEqual(prev, prList) ? prev : prList));
    setLanes((prev) => (jsonEqual(prev, laneList) ? prev : laneList));
    prsRef.current = prList;

    // Clear selectedPrId if the PR no longer exists
    setSelectedPrId((prev) => {
      if (prev && !prList.some((pr) => pr.id === prev)) return null;
      return prev;
    });

    const allowedPrIds = new Set(prList.map((pr) => pr.id));
    setDetailSnapshotsByPrId((prev) => pruneByAllowedIds(prev, allowedPrIds));
  }, [active]);

  const refreshCore = useCallback(async (options: RefreshCoreOptions = {}) => {
    if (!active) return;
    if (refreshInFlight.current) {
      refreshPending.current = mergeRefreshCoreOptions(refreshPending.current, options);
      return;
    }
    // The GitHub list has its own projected snapshot/read-through path and the
    // runtime poller already reconciles stale rows, so opening the list never
    // starts another GitHub fan-out refresh.
    const warmCacheAgeMs = Date.now() - warmCacheHydratedAtRef.current;
    const warmCacheUsable =
      warmCacheHydratedAtRef.current > 0
      && warmCacheAgeMs < PRS_CONTEXT_CACHE_TTL_MS
      && prsRef.current.length > 0;
    if (options.skipFreshWarmCache && warmCacheUsable) {
      // Cache is fresh — render what we have immediately and refresh silently
      // in the background. Avoids the visible cold-load freeze on tab return.
      setLoading(false);
      initialLoadDone.current = true;
      void applyLocalPrState()
        .then(() => {
          warmCacheHydratedAtRef.current = Date.now();
        })
        .catch((err) => {
          console.warn("[PrsContext] Silent background refresh failed:", err);
        });
      return;
    }
    refreshInFlight.current = true;
    refreshPending.current = null;
    // Only show the loading indicator during the initial fetch —
    // background refreshes should NOT flash loading state.
    const isInitial = !initialLoadDone.current;
    if (isInitial) setLoading(true);
    setError(null);
    try {
      if (options.awaitGithubRefresh) {
        await window.ade.prs.refresh(options.githubRefreshArgs).catch(() => {});
      }
      await applyLocalPrState();
      warmCacheHydratedAtRef.current = Date.now();
      setRefreshErrorRetryCount(0);
    } catch (err) {
      setRefreshErrorRetryCount((count) => count + 1);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      initialLoadDone.current = true;
      refreshInFlight.current = false;

      // If another refresh was requested while we were in flight, run it now.
      const pendingRefresh = refreshPending.current;
      if (pendingRefresh) {
        refreshPending.current = null;
        void refreshCore(pendingRefresh);
      }
    }
  }, [active, applyLocalPrState]);

  // Initial load
  useEffect(() => {
    if (!active) return;
    void refreshCore({ skipFreshWarmCache: true });
  }, [active, refreshCore]);

  const refreshForLaneLifecycle = useCallback(() => {
    void refreshCore();
  }, [refreshCore]);
  useDebouncedLaneLifecycleRefresh({
    active,
    debounceMs: PRS_LANE_LIFECYCLE_REFRESH_DEBOUNCE_MS,
    onRefresh: refreshForLaneLifecycle,
  });

  useEffect(() => {
    if (!active || !error) return;
    if (refreshErrorRetryCount === 0 || refreshErrorRetryCount > REFRESH_ERROR_RETRY_DELAYS_MS.length) return;
    const retryDelayMs = REFRESH_ERROR_RETRY_DELAYS_MS[refreshErrorRetryCount - 1] ?? REFRESH_ERROR_RETRY_DELAYS_MS[0];
    const retryTimer = window.setTimeout(() => {
      void refreshCore();
    }, retryDelayMs);
    return () => {
      window.clearTimeout(retryTimer);
    };
  }, [active, error, refreshCore, refreshErrorRetryCount]);

  // One brake for every automatic PR read on this surface.
  const {
    isGithubPollStoodDown,
    noteGithubReadFailure,
    noteGithubReadSuccess,
    githubPollPeriodFor,
    githubPollGeneration,
  } = useGithubPollGovernor(active);
  useEffect(() => setPrChangeSplitStandDown(isGithubPollStoodDown), [isGithubPollStoodDown]);

  // Silently refresh detail data for the given PR (no loading state).
  // Returns early if a fetch is already in progress or the PR is no longer selected.
  const refreshDetailSilently = useCallback((prId: string) => {
    if (detailFetchInProgress.current) return;
    // Bail if the PR we were asked to refresh is no longer the active one
    if (selectedPrIdRef.current !== prId) return;
    // Guard: don't fetch details for a PR that's not in the list
    if (!prsRef.current.some((p) => p.id === prId)) return;
    // Skip while the shared governor is standing down.
    if (isGithubPollStoodDown()) return;

    detailFetchInProgress.current = true;
    Promise.allSettled([
      window.ade.prs.getStatus(prId),
      window.ade.prs.getChecks(prId),
      window.ade.prs.getReviews(prId),
      window.ade.prs.getComments(prId),
    ])
      .then(([statusResult, checksResult, reviewsResult, commentsResult]) => {
        // Only apply if this PR is still selected
        if (selectedPrIdRef.current !== prId) return;

        const results = [statusResult, checksResult, reviewsResult, commentsResult];
        // ANY rejection arms the governor. Classifying by message here is what
        // let a whole-outage of 5xx responses poll at full speed; the kind and
        // the quota reserve come from the runtime's request budget instead.
        if (results.some((result) => result.status === "rejected")) {
          noteGithubReadFailure();
        } else {
          noteGithubReadSuccess();
        }
        if (!results.some((result) => result.status === "fulfilled")) {
          // Nothing new to apply. Whatever is on screen stays on screen.
          return;
        }

        // Apply successful results; keep previous value for any that failed.
        // Only mark the cache fresh after all primary pieces complete, otherwise
        // one successful section can mask stale checks/reviews/comments.
        if (statusResult.status === "fulfilled") {
          setDetailStatus((prev) => (jsonEqual(prev, statusResult.value) ? prev : statusResult.value));
        } else {
          console.warn("[PrsContext] Failed to refresh PR status:", statusResult.reason);
        }
        if (checksResult.status === "fulfilled") {
          setDetailChecks((prev) => (jsonEqual(prev, checksResult.value) ? prev : checksResult.value));
        } else {
          console.warn("[PrsContext] Failed to refresh PR checks:", checksResult.reason);
        }
        if (reviewsResult.status === "fulfilled") {
          setDetailReviews((prev) => (jsonEqual(prev, reviewsResult.value) ? prev : reviewsResult.value));
        } else {
          console.warn("[PrsContext] Failed to refresh PR reviews:", reviewsResult.reason);
        }
        if (commentsResult.status === "fulfilled") {
          setDetailComments((prev) => (jsonEqual(prev, commentsResult.value) ? prev : commentsResult.value));
        } else {
          console.warn("[PrsContext] Failed to refresh PR comments:", commentsResult.reason);
        }
        if ([statusResult, checksResult, reviewsResult, commentsResult].every((result) => result.status === "fulfilled")) {
          detailStatePrIdRef.current = prId;
          detailLoadedAtByPrIdRef.current[prId] = Date.now();
          setDetailLiveDataPrId(prId);
        } else {
          setDetailLiveDataPrId(null);
        }
      })
      .finally(() => {
        detailFetchInProgress.current = false;
      });
  }, [isGithubPollStoodDown, noteGithubReadFailure, noteGithubReadSuccess]);

  // Reached only from `refresh()`, which is user-driven (the Refresh button and
  // post-mutation re-reads). Deliberately NOT gated on the governor: the
  // 500-request reserve exists so an explicit user action still works while
  // automatic polling stands down, and a manual retry is the escape hatch from
  // a stale backoff. It still reports its outcome, so a success here clears the
  // ladder for the automatic loops too.
  const refreshSelectedPrDetail = useCallback(async (prId: string) => {
    if (selectedPrIdRef.current !== prId) return;
    if (!prsRef.current.some((p) => p.id === prId)) return;

    detailFetchInProgress.current = true;
    try {
      const [statusResult, checksResult, reviewsResult, commentsResult] = await Promise.allSettled([
        window.ade.prs.getStatus(prId),
        window.ade.prs.getChecks(prId),
        window.ade.prs.getReviews(prId),
        window.ade.prs.getComments(prId),
      ]);
      if (selectedPrIdRef.current !== prId) return;

      const results = [statusResult, checksResult, reviewsResult, commentsResult];
      if (results.some((result) => result.status === "rejected")) {
        noteGithubReadFailure();
      } else {
        noteGithubReadSuccess();
      }

      if (statusResult.status === "fulfilled") setDetailStatus((prev) => (jsonEqual(prev, statusResult.value) ? prev : statusResult.value));
      if (checksResult.status === "fulfilled") setDetailChecks((prev) => (jsonEqual(prev, checksResult.value) ? prev : checksResult.value));
      if (reviewsResult.status === "fulfilled") setDetailReviews((prev) => (jsonEqual(prev, reviewsResult.value) ? prev : reviewsResult.value));
      if (commentsResult.status === "fulfilled") setDetailComments((prev) => (jsonEqual(prev, commentsResult.value) ? prev : commentsResult.value));
      if ([statusResult, checksResult, reviewsResult, commentsResult].every((result) => result.status === "fulfilled")) {
        detailStatePrIdRef.current = prId;
        detailLoadedAtByPrIdRef.current[prId] = Date.now();
        setDetailLiveDataPrId(prId);
      } else {
        setDetailLiveDataPrId(null);
      }
    } finally {
      detailFetchInProgress.current = false;
    }
  }, [noteGithubReadFailure, noteGithubReadSuccess]);

  const refresh = useCallback(async (args: PrRefreshArgs = {}) => {
    const githubRefreshArgs = normalizePrRefreshArgs(args);
    await refreshCore({ awaitGithubRefresh: true, githubRefreshArgs });

    const selectedPrId = selectedPrIdRef.current;
    if (!selectedPrId) return;
    const targetedIds = new Set([
      ...(githubRefreshArgs?.prId ? [githubRefreshArgs.prId] : []),
      ...(githubRefreshArgs?.prIds ?? []),
    ]);
    if (targetedIds.size === 0 || targetedIds.has(selectedPrId)) {
      await refreshSelectedPrDetail(selectedPrId);
    }
  }, [refreshCore, refreshSelectedPrDetail]);

  // Load detail data when selected PR changes, then poll every 60s.
  //
  // The governor is deliberately NOT reset here. It used to be cleared on every
  // PR selection, which meant clicking between PRs — the natural thing to do
  // when the tab looks stuck — disarmed the one brake on GitHub polling. A
  // GitHub outage or an exhausted quota is account-wide, not per-PR, so the
  // stand-down has to survive selection. Opening a PR is still a user action
  // and its first load runs regardless of the governor; only the repeating
  // timers below stand down.
  //
  // The governor's state lives in the provider, so leaving the PRs tab or
  // switching project does still drop the failure ladder. The quota reserve
  // self-heals on the next mount (the governor reads the runtime's budget
  // immediately), and the ladder re-arms on the first failure, so the worst
  // case is one poll group spent re-learning what ADE already knew.
  useEffect(() => {
    if (!active) return;

    if (!selectedPrId) {
      detailStatePrIdRef.current = null;
      setDetailStatus(null);
      setDetailChecks([]);
      setDetailReviews([]);
      setDetailComments([]);
      setDetailReviewThreads([]);
      setDetailDeployments([]);
      setDetailSnapshot(null);
      setDetailLiveDataPrId(null);
      return;
    }

    // Guard: don't attempt to load details for a PR that's not in our list.
    // The PR was likely deleted or merged -- the empty state will show naturally.
    // Skip this validation until the initial PR list has finished loading so
    // URL-derived selections are not cleared before the first refresh completes.
    if (!initialLoadDone.current) return;
    if (!prsRef.current.some((p) => p.id === selectedPrId)) {
      detailStatePrIdRef.current = null;
      setDetailStatus(null);
      setDetailChecks([]);
      setDetailReviews([]);
      setDetailComments([]);
      setDetailReviewThreads([]);
      setDetailDeployments([]);
      setDetailSnapshot(null);
      setDetailLiveDataPrId(null);
      setSelectedPrId(null);
      return;
    }

    let cancelled = false;
    let liveDetailApplied = false;
    let snapshotForRequest: PrSnapshotHydration | null = null;
    const prId = selectedPrId;
    // A previous selection can leave long-running GitHub/detail calls pending.
    // Its cleanup marks that closure cancelled, so the new selection should be
    // allowed to start its own cache/live hydration immediately.
    detailFetchInProgress.current = false;
    const clearSecondaryDetail = () => {
      setDetailReviewThreads([]);
      setDetailDeployments([]);
    };
    const applySnapshotPrefill = (snapshot: PrSnapshotHydration) => {
      snapshotForRequest = snapshot;
      mergeDetailSnapshots([snapshot]);
      detailSnapshotStatePrIdRef.current = prId;
      detailSnapshotLoadedAtByPrIdRef.current[prId] = Date.now();
      detailCacheHasDataRef.current = true;
      setDetailSnapshot(snapshot);
      setDetailStatus(snapshot.status);
      setDetailChecks(snapshot.checks);
      setDetailReviews(snapshot.reviews);
      setDetailComments(snapshot.comments);
      setDetailBusy(false);
      clearSecondaryDetail();
    };
    const cachedDetailAgeMs = Date.now() - (detailLoadedAtByPrIdRef.current[prId] ?? 0);
    const hasFreshDetailCache =
      cachedDetailAgeMs >= 0
      && cachedDetailAgeMs < PRS_DETAIL_CACHE_TTL_MS
      && detailStatePrIdRef.current === prId
      && detailCacheHasDataRef.current;
    const warmedSnapshotForRequest = detailSnapshotsByPrIdRef.current[prId] ?? null;
    if (warmedSnapshotForRequest && detailSnapshotStatePrIdRef.current !== prId && !hasFreshDetailCache) {
      applySnapshotPrefill(warmedSnapshotForRequest);
    }
    const cachedSnapshotAgeMs = Date.now() - (detailSnapshotLoadedAtByPrIdRef.current[prId] ?? 0);
    const hasFreshSnapshotPrefill =
      cachedSnapshotAgeMs >= 0
      && cachedSnapshotAgeMs < PRS_DETAIL_CACHE_TTL_MS
      && detailSnapshotStatePrIdRef.current === prId
      && detailCacheHasDataRef.current;
    if (!hasFreshDetailCache && !hasFreshSnapshotPrefill) {
      detailStatePrIdRef.current = null;
      detailSnapshotStatePrIdRef.current = null;
      setDetailSnapshot(null);
      setDetailLiveDataPrId(null);
      setDetailStatus(null);
      setDetailChecks([]);
      setDetailReviews([]);
      setDetailComments([]);
      setDetailReviewThreads([]);
      setDetailDeployments([]);
    }
    const yieldToPaint = () =>
      new Promise<void>((resolve) => {
        const ric = (window as unknown as {
          requestIdleCallback?: (cb: () => void) => void;
        }).requestIdleCallback;
        if (typeof ric === "function") ric(() => resolve());
        else setTimeout(resolve, 0);
      });
    const startSecondaryDetailFetch = (options: { reset?: boolean } = {}) => {
      if (options.reset) {
        clearSecondaryDetail();
      }
      const api = window.ade?.prs;
      void (async () => {
        const steps: Array<[string, () => Promise<void>]> = [
          ["getDeployments", async () => {
            if (typeof api?.getDeployments !== "function") return;
            const deployments = await api.getDeployments(prId);
            if (!cancelled && selectedPrIdRef.current === prId) setDetailDeployments(deployments);
          }],
        ];
        for (const [name, step] of steps) {
          if (cancelled) return;
          await yieldToPaint();
          if (cancelled) return;
          try {
            await step();
          } catch (err) {
            console.warn(`[PrsContext] ${name} failed:`, err);
          }
        }
      })();
    };
    const startProgressivePrimaryFetch = (options: { background?: boolean } = {}) => {
      if (detailFetchInProgress.current) return;
      if (!options.background) setDetailBusy(true);
      detailFetchInProgress.current = true;

      let primarySettledCount = 0;
      let primaryFulfilledCount = 0;
      const primaryRequestCount = 4;
      const markPrimarySettled = (fulfilled: boolean) => {
        primarySettledCount += 1;
        if (fulfilled) primaryFulfilledCount += 1;
        if (selectedPrIdRef.current === prId && primarySettledCount === 1) {
          detailFetchInProgress.current = false;
        }
        if (selectedPrIdRef.current === prId && primarySettledCount === primaryRequestCount) {
          detailFetchInProgress.current = false;
          // Report the group's outcome once, not per piece. The four settle in
          // nondeterministic order, so a single piece resolving last (from the
          // host's conditional cache, say) would otherwise clear a stand-down
          // its three failing siblings had just armed. This matches the
          // aggregate rule the repeating loops already use.
          if (primaryFulfilledCount === primaryRequestCount) {
            noteGithubReadSuccess();
            detailStatePrIdRef.current = prId;
            detailLoadedAtByPrIdRef.current[prId] = Date.now();
            setDetailLiveDataPrId(prId);
          } else {
            noteGithubReadFailure();
            setDetailLiveDataPrId(null);
          }
        }
      };
      const loadPrimaryPiece = <T,>(
        name: string,
        promise: Promise<T>,
        apply: (value: T) => void,
      ) => {
        let fulfilled = false;
        promise
          .then((value) => {
            if (cancelled || selectedPrIdRef.current !== prId) return;
            fulfilled = true;
            if (value != null && (!Array.isArray(value) || value.length > 0)) {
              liveDetailApplied = true;
            }
            apply(value);
            setDetailBusy(false);
          })
          .catch((error: unknown) => {
            if (cancelled || selectedPrIdRef.current !== prId) return;
            console.warn(`[PrsContext] Failed to load PR ${name}:`, error);
            // Fall back to the cached snapshot for EVERY failure, not just a
            // recognised rate limit. A 5xx used to leave the pane empty and
            // then keep polling for more of the same; showing what ADE already
            // knows is the point of degrading the request rate instead of the
            // feature. Only while nothing live has landed yet, though — the
            // four pieces settle in any order, and rewinding all four to the
            // snapshot because the last one failed would discard fresher data
            // its siblings already applied.
            if (!liveDetailApplied && snapshotForRequest?.prId === prId) {
              setDetailStatus(snapshotForRequest.status);
              setDetailChecks(snapshotForRequest.checks);
              setDetailReviews(snapshotForRequest.reviews);
              setDetailComments(snapshotForRequest.comments);
            }
            setDetailLiveDataPrId(null);
            setDetailBusy(false);
          })
          .finally(() => {
            if (cancelled) return;
            markPrimarySettled(fulfilled);
          });
      };

      loadPrimaryPiece("status", window.ade.prs.getStatus(prId), (value) => {
        setDetailStatus(value ?? null);
      });
      loadPrimaryPiece("checks", window.ade.prs.getChecks(prId), (value) => {
        setDetailChecks(value);
      });
      loadPrimaryPiece("reviews", window.ade.prs.getReviews(prId), (value) => {
        setDetailReviews(value);
      });
      loadPrimaryPiece("comments", window.ade.prs.getComments(prId), (value) => {
        setDetailComments(value);
      });
    };
    // Every path below ends the same way: keep the detail live on a 60s tick.
    // This one skips its ticks while the governor is standing down rather than
    // lengthening its period — 60s is already at the safe end, so there is no
    // request volume to win, and the base cadence is what should resume the
    // moment GitHub does.
    const startDetailPolling = () => {
      const intervalId = window.setInterval(() => {
        // Nobody sees a hidden window; the next visible tick catches up.
        if (document.visibilityState === "hidden") return;
        refreshDetailSilently(prId);
      }, 60_000);
      return () => {
        cancelled = true;
        window.clearInterval(intervalId);
      };
    };
    if (hasFreshDetailCache) {
      setDetailLiveDataPrId(prId);
      setDetailBusy(false);
      startSecondaryDetailFetch();
      return startDetailPolling();
    }
    if (hasFreshSnapshotPrefill) {
      setDetailBusy(false);
      startProgressivePrimaryFetch({ background: true });
      startSecondaryDetailFetch();
      return startDetailPolling();
    }
    // A caller without `listSnapshots` (an older adapter or a partial test
    // stub) is treated as one that answered "no snapshots".
    setDetailBusy(true);
    const listSnapshots = window.ade.prs.listSnapshots;
    const snapshotsPromise = typeof listSnapshots === "function"
      ? listSnapshots({ prId })
      : Promise.resolve([]);
    void snapshotsPromise.then((snapshots) => {
      if (cancelled || selectedPrIdRef.current !== prId || liveDetailApplied) return;
      const snapshot = snapshots[0];
      if (snapshot) {
        applySnapshotPrefill(snapshot);
        startProgressivePrimaryFetch({ background: true });
        startSecondaryDetailFetch();
      } else {
        startProgressivePrimaryFetch();
        startSecondaryDetailFetch({ reset: true });
      }
    }).catch(() => {
      if (!cancelled) {
        startProgressivePrimaryFetch();
        startSecondaryDetailFetch({ reset: true });
      }
    });
    return startDetailPolling();
  }, [active, noteGithubReadFailure, noteGithubReadSuccess, refreshDetailSilently, selectedPrId]);

  // Subscribe to PR events
  useEffect(() => {
    if (!active) return;
    const unsub = window.ade.prs.onEvent((event: PrEventPayload) => {
      if (event.type === "prs-updated") {
        const previous = prsRef.current;
        const byId = new Map(previous.map((pr) => [pr.id, pr.conflictAnalysis] as const));
        const next: PrWithConflicts[] = event.prs.map((pr) => ({
          ...pr,
          conflictAnalysis: byId.get(pr.id) ?? null,
        }));
        const changedPrIds = diffPrIds(previous, next);

        prsRef.current = next;
        setPrs((prev) => (jsonEqual(prev, next) ? prev : next));
        const allowedPrIds = new Set(next.map((pr) => pr.id));
        setDetailSnapshotsByPrId((prev) => pruneByAllowedIds(prev, allowedPrIds));

        // Clear selection if the active PR was removed (mirrors refresh() guard).
        const activePrIdForPrune = selectedPrIdRef.current;
        if (activePrIdForPrune && !allowedPrIds.has(activePrIdForPrune)) {
          setDetailStatus(null);
          setDetailChecks([]);
          setDetailReviews([]);
          setDetailComments([]);
          setSelectedPrId(null);
        }

        // Also refresh detail data for the actively viewed PR only when it changed.
        const activePrId = selectedPrIdRef.current;
        if (activePrId && changedPrIds.includes(activePrId)) {
          refreshDetailSilently(activePrId);
        }
      }
    });
    return () => {
      unsub();
    };
  }, [active, refreshDetailSilently]);

  useEffect(() => {
    if (PRS_CONTEXT_CACHE_DISABLED) return;
    if (!initialLoadDone.current && prs.length === 0 && lanes.length === 0) return;
    const cachedAt = Date.now();
    prsContextWarmCacheByProject.set(cacheKey, {
      prs,
      lanes,
      selectedPrId,
      mergeMethod,
      detailStatus,
      detailChecks,
      detailReviews,
      detailComments,
      detailReviewThreads,
      detailDeployments,
      detailSnapshotsByPrId,
      viewerLogin,
      writeViewerLogin,
      cachedAt,
      dataLoadedAt: warmCacheHydratedAtRef.current,
    });
  }, [
    cacheKey,
    detailChecks,
    detailComments,
    detailDeployments,
    detailReviewThreads,
    detailReviews,
    detailStatus,
    detailSnapshotsByPrId,
    lanes,
    mergeMethod,
    prs,
    selectedPrId,
    viewerLogin,
    writeViewerLogin,
  ]);

  const value = useMemo<PrsContextValue>(
    () => ({
      prs,
      lanes,
      selectedPrId,
      mergeMethod,
      loading,
      error,
      detailStatus,
      detailChecks,
      detailReviews,
      detailComments,
      detailReviewThreads,
      detailDeployments,
      detailSnapshot,
      detailSnapshotsByPrId,
      detailLiveDataPrId,
      detailBusy,
      viewerLogin,
      writeViewerLogin,
      optimisticTerminalStates,
      markPrTerminalLocally,
      clearPrTerminalLocally,
      setSelectedPrId,
      setMergeMethod,
      refresh,
      setViewerLogin,
      setWriteViewerLogin,
      isGithubPollStoodDown,
      noteGithubReadFailure,
      noteGithubReadSuccess,
      githubPollPeriodFor,
      githubPollGeneration,
    }),
    // Note: setSelectedPrId, setMergeMethod, setViewerLogin, and setWriteViewerLogin are
    // intentionally excluded from this dependency array because they are useState setters
    // which are guaranteed to be referentially stable across re-renders per the React
    // useState contract.
    [
      prs,
      lanes,
      markPrTerminalLocally,
      clearPrTerminalLocally,
      optimisticTerminalStates,
      selectedPrId,
      mergeMethod,
      loading,
      error,
      detailStatus,
      detailChecks,
      detailReviews,
      detailComments,
      detailReviewThreads,
      detailDeployments,
      detailSnapshot,
      detailSnapshotsByPrId,
      detailLiveDataPrId,
      detailBusy,
      viewerLogin,
      writeViewerLogin,
      refresh,
      isGithubPollStoodDown,
      noteGithubReadFailure,
      noteGithubReadSuccess,
      githubPollPeriodFor,
      githubPollGeneration,
    ],
  );

  return <PrsContext.Provider value={value}>{children}</PrsContext.Provider>;
}

/** For controls that also render outside the PRs tab, where there is no provider. */
export function useOptionalPrs(): PrsContextValue | null {
  return useContext(PrsContext);
}

export function usePrs(): PrsContextValue {
  const ctx = useContext(PrsContext);
  if (!ctx) throw new Error("usePrs must be used within PrsProvider");
  return ctx;
}
