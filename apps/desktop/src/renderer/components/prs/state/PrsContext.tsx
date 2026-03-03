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
  PrMergeContext,
  PrCheck,
  PrComment,
  PrReview,
  PrStatus,
  MergeMethod,
  RebaseNeed,
  RebaseEventPayload,
  QueueLandingState,
  PrEventPayload,
  LaneSummary,
  AutoRebaseLaneStatus,
  AutoRebaseEventPayload,
} from "../../../../shared/types";

type PrTab = "normal" | "queue" | "integration" | "rebase";

type InlineTerminalState = {
  ptyId: string;
  sessionId: string;
  provider: string;
  startedAt: string;
  exitCode: number | null;
  minimized: boolean;
} | null;

type PrsState = {
  activeTab: PrTab;
  prs: PrWithConflicts[];
  lanes: LaneSummary[];
  mergeContextByPrId: Record<string, PrMergeContext>;
  selectedPrId: string | null;
  selectedQueueGroupId: string | null;
  selectedRebaseItemId: string | null;
  mergeMethod: MergeMethod;
  loading: boolean;
  error: string | null;

  // Detail state
  detailStatus: PrStatus | null;
  detailChecks: PrCheck[];
  detailReviews: PrReview[];
  detailComments: PrComment[];
  detailBusy: boolean;

  // Rebase state
  rebaseNeeds: RebaseNeed[];
  autoRebaseStatuses: AutoRebaseLaneStatus[];

  // Queue state
  queueStates: Record<string, QueueLandingState>;

  // Inline terminal
  inlineTerminal: InlineTerminalState;

  // Resolver preferences
  resolverModel: string;
  resolverReasoningLevel: string;
};

type PrsContextValue = PrsState & {
  setActiveTab: (tab: PrTab) => void;
  setSelectedPrId: (id: string | null) => void;
  setSelectedQueueGroupId: (id: string | null) => void;
  setSelectedRebaseItemId: (id: string | null) => void;
  setMergeMethod: (method: MergeMethod) => void;
  setResolverModel: (model: string) => void;
  setResolverReasoningLevel: (level: string) => void;
  setInlineTerminal: (terminal: InlineTerminalState) => void;
  refresh: () => Promise<void>;
};

const PrsContext = createContext<PrsContextValue | null>(null);

const LS_MODEL_KEY = "ade:prs:resolverModel";

function readPersistedModel(): string {
  try {
    const v = localStorage.getItem(LS_MODEL_KEY);
    if (v && v.trim().length) return v;
  } catch {
    /* ignore */
  }
  return "anthropic/claude-sonnet-4-6";
}

function readInitialTab(): PrTab {
  try {
    const params = new URLSearchParams(window.location.search);
    const tab = params.get("tab");
    if (tab === "normal" || tab === "queue" || tab === "integration" || tab === "rebase") return tab;
  } catch { /* ignore */ }
  return "normal";
}

/** Shallow-compare two JSON-serializable values to avoid unnecessary re-renders. */
function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function PrsProvider({ children }: { children: React.ReactNode }) {
  const [activeTab, setActiveTab] = useState<PrTab>(readInitialTab);
  const [prs, setPrs] = useState<PrWithConflicts[]>([]);
  const [lanes, setLanes] = useState<LaneSummary[]>([]);
  const [mergeContextByPrId, setMergeContextByPrId] = useState<Record<string, PrMergeContext>>({});
  const [selectedPrId, setSelectedPrId] = useState<string | null>(null);
  const [selectedQueueGroupId, setSelectedQueueGroupId] = useState<string | null>(null);
  const [selectedRebaseItemId, setSelectedRebaseItemId] = useState<string | null>(null);
  const [mergeMethod, setMergeMethod] = useState<MergeMethod>("squash");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Detail state
  const [detailStatus, setDetailStatus] = useState<PrStatus | null>(null);
  const [detailChecks, setDetailChecks] = useState<PrCheck[]>([]);
  const [detailReviews, setDetailReviews] = useState<PrReview[]>([]);
  const [detailComments, setDetailComments] = useState<PrComment[]>([]);
  const [detailBusy, setDetailBusy] = useState(false);

  // Rebase state
  const [rebaseNeeds, setRebaseNeeds] = useState<RebaseNeed[]>([]);
  const [autoRebaseStatuses, setAutoRebaseStatuses] = useState<AutoRebaseLaneStatus[]>([]);

  // Queue state
  const [queueStates, setQueueStates] = useState<Record<string, QueueLandingState>>({});

  // Inline terminal
  const [inlineTerminal, setInlineTerminal] = useState<InlineTerminalState>(null);

  // Resolver preferences
  const [resolverModel, setResolverModelRaw] = useState<string>(readPersistedModel);
  const [resolverReasoningLevel, setResolverReasoningLevel] = useState("medium");

  const setResolverModel = useCallback((model: string) => {
    setResolverModelRaw(model);
    try {
      localStorage.setItem(LS_MODEL_KEY, model);
    } catch {
      /* ignore */
    }
  }, []);

  // Concurrency guard for refresh
  const refreshInFlight = React.useRef(false);
  const prsRefreshTimer = React.useRef<number | null>(null);
  const prsRef = React.useRef<PrWithConflicts[]>([]);
  prsRef.current = prs;

  // Load merge contexts for all PRs
  const loadMergeContexts = useCallback(async (prList: PrWithConflicts[]) => {
    const contexts: Record<string, PrMergeContext> = {};
    await Promise.all(
      prList.map(async (pr) => {
        try {
          const ctx = await window.ade.prs.getMergeContext(pr.id);
          contexts[pr.id] = ctx;
        } catch {
          /* skip failures */
        }
      }),
    );
    setMergeContextByPrId((prev) => (jsonEqual(prev, contexts) ? prev : contexts));
  }, []);

  // Track whether the initial data load has completed
  const initialLoadDone = React.useRef(false);

  // Core refresh (guarded against concurrent calls)
  const refresh = useCallback(async () => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    // Only show the loading indicator during the initial fetch —
    // background refreshes should NOT flash loading state.
    const isInitial = !initialLoadDone.current;
    if (isInitial) setLoading(true);
    setError(null);
    try {
      const [prList, laneList] = await Promise.all([
        window.ade.prs.listWithConflicts(),
        window.ade.lanes.list({ includeStatus: false }),
      ]);
      const prsChanged = !jsonEqual(prsRef.current, prList);

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

      if (prsChanged) {
        await loadMergeContexts(prList);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      initialLoadDone.current = true;
      refreshInFlight.current = false;
    }
  }, [loadMergeContexts]);

  // Initial load
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Load detail data when selected PR changes
  useEffect(() => {
    if (!selectedPrId) {
      setDetailStatus(null);
      setDetailChecks([]);
      setDetailReviews([]);
      setDetailComments([]);
      return;
    }

    // Guard: don't attempt to load details for a PR that's not in our list
    if (!prsRef.current.some((p) => p.id === selectedPrId)) {
      setDetailStatus(null);
      setDetailChecks([]);
      setDetailReviews([]);
      setDetailComments([]);
      return;
    }

    let cancelled = false;
    setDetailBusy(true);

    Promise.all([
      window.ade.prs.getStatus(selectedPrId),
      window.ade.prs.getChecks(selectedPrId),
      window.ade.prs.getReviews(selectedPrId),
      window.ade.prs.getComments(selectedPrId),
    ])
      .then(([status, checks, reviews, comments]) => {
        if (cancelled) return;
        setDetailStatus(status);
        setDetailChecks(checks);
        setDetailReviews(reviews);
        setDetailComments(comments);
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn("[PrsContext] Failed to load PR detail data:", err);
        // Clear stale data on error so UI doesn't show outdated info
        setDetailStatus(null);
        setDetailChecks([]);
        setDetailReviews([]);
        setDetailComments([]);
      })
      .finally(() => {
        if (!cancelled) setDetailBusy(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedPrId]);

  // Subscribe to PR events
  useEffect(() => {
    const scheduleRefresh = () => {
      if (prsRefreshTimer.current != null) return;
      prsRefreshTimer.current = window.setTimeout(() => {
        prsRefreshTimer.current = null;
        void refresh();
      }, 300);
    };

    const unsub = window.ade.prs.onEvent((event: PrEventPayload) => {
      if (event.type === "prs-updated") {
        setPrs((prev) => {
          const byId = new Map(prev.map((pr) => [pr.id, pr.conflictAnalysis] as const));
          const next: PrWithConflicts[] = event.prs.map((pr) => ({
            ...pr,
            conflictAnalysis: byId.get(pr.id) ?? null,
          }));
          prsRef.current = next;
          return jsonEqual(prev, next) ? prev : next;
        });
        scheduleRefresh();
      } else if (event.type === "queue-state") {
        setQueueStates((prev) => {
          const existing = prev[event.groupId];
          if (!existing) return prev;
          return {
            ...prev,
            [event.groupId]: {
              ...existing,
              state: event.state,
              currentPosition: event.currentPosition,
            },
          };
        });
      } else if (event.type === "queue-step") {
        // Refresh queue state for the group
        window.ade.prs.getQueueState(event.groupId).then((qs) => {
          if (qs) {
            setQueueStates((prev) => ({ ...prev, [event.groupId]: qs }));
          }
        }).catch((err) => {
          console.warn("[PrsContext] Failed to fetch queue state for group:", event.groupId, err);
        });
      }
    });
    return () => {
      unsub();
      if (prsRefreshTimer.current != null) {
        window.clearTimeout(prsRefreshTimer.current);
        prsRefreshTimer.current = null;
      }
    };
  }, [refresh]);

  // Subscribe to rebase events
  useEffect(() => {
    const unsub = window.ade.rebase.onEvent((event: RebaseEventPayload) => {
      if (event.type === "rebase-needs-updated") {
        setRebaseNeeds(event.needs);
      }
    });
    return unsub;
  }, []);

  // Periodic rebase needs scan (cancelled flag guards against setState after unmount)
  useEffect(() => {
    let cancelled = false;
    const scan = () => {
      window.ade.rebase.scanNeeds().then((needs) => {
        if (!cancelled) setRebaseNeeds(needs);
      }).catch((err) => {
        console.warn("[PrsContext] Failed to scan rebase needs:", err);
      });
    };
    scan();
    const timer = setInterval(scan, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  // Subscribe to auto-rebase events
  useEffect(() => {
    window.ade.lanes.listAutoRebaseStatuses().then(setAutoRebaseStatuses).catch((err) => {
      console.warn("[PrsContext] Failed to list auto-rebase statuses:", err);
    });
    const unsub = window.ade.lanes.onAutoRebaseEvent((event: AutoRebaseEventPayload) => {
      if (event.type === "auto-rebase-updated") {
        setAutoRebaseStatuses(event.statuses);
      }
    });
    return unsub;
  }, []);

  const value = useMemo<PrsContextValue>(
    () => ({
      activeTab,
      prs,
      lanes,
      mergeContextByPrId,
      selectedPrId,
      selectedQueueGroupId,
      selectedRebaseItemId,
      mergeMethod,
      loading,
      error,
      detailStatus,
      detailChecks,
      detailReviews,
      detailComments,
      detailBusy,
      rebaseNeeds,
      autoRebaseStatuses,
      queueStates,
      inlineTerminal,
      resolverModel,
      resolverReasoningLevel,
      setActiveTab,
      setSelectedPrId,
      setSelectedQueueGroupId,
      setSelectedRebaseItemId,
      setMergeMethod,
      setResolverModel,
      setResolverReasoningLevel,
      setInlineTerminal,
      refresh,
    }),
    // Note: setActiveTab, setSelectedPrId, setSelectedQueueGroupId, setSelectedRebaseItemId,
    // setMergeMethod, setResolverReasoningLevel, and setInlineTerminal are intentionally
    // excluded from this dependency array because they are useState setters which are
    // guaranteed to be referentially stable across re-renders per the React useState contract.
    // setResolverModel is included because it's a useCallback wrapper (not a raw setter).
    [
      activeTab,
      prs,
      lanes,
      mergeContextByPrId,
      selectedPrId,
      selectedQueueGroupId,
      selectedRebaseItemId,
      mergeMethod,
      loading,
      error,
      detailStatus,
      detailChecks,
      detailReviews,
      detailComments,
      detailBusy,
      rebaseNeeds,
      autoRebaseStatuses,
      queueStates,
      inlineTerminal,
      resolverModel,
      resolverReasoningLevel,
      setResolverModel,
      refresh,
    ],
  );

  return <PrsContext.Provider value={value}>{children}</PrsContext.Provider>;
}

export function usePrs(): PrsContextValue {
  const ctx = useContext(PrsContext);
  if (!ctx) throw new Error("usePrs must be used within PrsProvider");
  return ctx;
}
