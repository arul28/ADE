import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
} from "react";
import type {
  AiPermissionMode,
  PrAiResolutionContext,
  PrAiResolutionSessionInfo,
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
  QueueRehearsalState,
  PrEventPayload,
  LaneSummary,
  AutoRebaseLaneStatus,
  AutoRebaseEventPayload,
} from "../../../../shared/types";
import { buildPrAiResolutionContextKey } from "../../../../shared/types";
import { getModelById } from "../../../../shared/modelRegistry";

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
  queueRehearsals: Record<string, QueueRehearsalState>;

  // Inline terminal
  inlineTerminal: InlineTerminalState;

  // Resolver preferences
  resolverModel: string;
  resolverReasoningLevel: string;
  resolverPermissionMode: AiPermissionMode;
  resolverSessionsByContextKey: Record<string, PrAiResolutionSessionInfo>;
};

type PrsContextValue = PrsState & {
  setActiveTab: (tab: PrTab) => void;
  setSelectedPrId: (id: string | null) => void;
  setSelectedQueueGroupId: (id: string | null) => void;
  setSelectedRebaseItemId: (id: string | null) => void;
  setMergeMethod: (method: MergeMethod) => void;
  setResolverModel: (model: string) => void;
  setResolverReasoningLevel: (level: string) => void;
  setResolverPermissionMode: (mode: AiPermissionMode, modelId?: string) => void;
  upsertResolverSession: (session: PrAiResolutionSessionInfo) => void;
  clearResolverSession: (context: PrAiResolutionContext) => void;
  setInlineTerminal: (terminal: InlineTerminalState) => void;
  refresh: () => Promise<void>;
};

const PrsContext = createContext<PrsContextValue | null>(null);

const LS_MODEL_KEY = "ade:prs:resolverModel";
const LS_PERMISSION_KEY = "ade:prs:resolverPermissions";

type ResolverPermissionPreferences = {
  claude: AiPermissionMode;
  codex: AiPermissionMode;
};

const DEFAULT_RESOLVER_PERMISSIONS: ResolverPermissionPreferences = {
  claude: "guarded_edit",
  codex: "full_edit",
};

function normalizeResolverPermissionMode(value: unknown): AiPermissionMode | null {
  if (value === "read_only" || value === "guarded_edit" || value === "full_edit") return value;
  return null;
}

function readPersistedResolverPermissions(): ResolverPermissionPreferences {
  try {
    const raw = localStorage.getItem(LS_PERMISSION_KEY);
    if (!raw) return DEFAULT_RESOLVER_PERMISSIONS;
    const parsed = JSON.parse(raw) as Partial<ResolverPermissionPreferences>;
    return {
      claude: normalizeResolverPermissionMode(parsed?.claude) ?? DEFAULT_RESOLVER_PERMISSIONS.claude,
      codex: normalizeResolverPermissionMode(parsed?.codex) ?? DEFAULT_RESOLVER_PERMISSIONS.codex,
    };
  } catch {
    return DEFAULT_RESOLVER_PERMISSIONS;
  }
}

function resolvePermissionFamilyForModel(modelId: string): keyof ResolverPermissionPreferences {
  const descriptor = getModelById(modelId);
  return descriptor?.family === "anthropic" ? "claude" : "codex";
}

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
  const [queueRehearsals, setQueueRehearsals] = useState<Record<string, QueueRehearsalState>>({});

  // Inline terminal
  const [inlineTerminal, setInlineTerminal] = useState<InlineTerminalState>(null);

  // Resolver preferences
  const [resolverModel, setResolverModelRaw] = useState<string>(readPersistedModel);
  const [resolverReasoningLevel, setResolverReasoningLevel] = useState("medium");
  const [resolverPermissions, setResolverPermissions] = useState<ResolverPermissionPreferences>(readPersistedResolverPermissions);
  const [resolverSessionsByContextKey, setResolverSessionsByContextKey] = useState<Record<string, PrAiResolutionSessionInfo>>({});

  const setResolverModel = useCallback((model: string) => {
    setResolverModelRaw(model);
    try {
      localStorage.setItem(LS_MODEL_KEY, model);
    } catch {
      /* ignore */
    }
  }, []);

  const setResolverPermissionMode = useCallback((mode: AiPermissionMode, modelId = resolverModel) => {
    const family = resolvePermissionFamilyForModel(modelId);
    setResolverPermissions((prev) => {
      const next = { ...prev, [family]: mode };
      try {
        localStorage.setItem(LS_PERMISSION_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, [resolverModel]);

  const upsertResolverSession = useCallback((session: PrAiResolutionSessionInfo) => {
    setResolverSessionsByContextKey((prev) => ({ ...prev, [session.contextKey]: session }));
  }, []);

  const clearResolverSession = useCallback((context: PrAiResolutionContext) => {
    const key = buildPrAiResolutionContextKey(context);
    setResolverSessionsByContextKey((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  // Concurrency guard for refresh
  const refreshInFlight = React.useRef(false);
  const prsRefreshTimer = React.useRef<number | null>(null);
  const prsRef = React.useRef<PrWithConflicts[]>([]);
  prsRef.current = prs;

  // Refs for detail polling
  const selectedPrIdRef = React.useRef<string | null>(null);
  selectedPrIdRef.current = selectedPrId;
  const detailFetchInProgress = React.useRef(false);

  const refreshMergeContexts = useCallback(async (prIds: string[]) => {
    const uniquePrIds = [...new Set(prIds.map((id) => String(id ?? "").trim()).filter(Boolean))];
    if (uniquePrIds.length === 0) return;
    const contexts: Record<string, PrMergeContext> = {};
    await Promise.all(
      uniquePrIds.map(async (prId) => {
        try {
          const ctx = await window.ade.prs.getMergeContext(prId);
          contexts[prId] = ctx;
        } catch {
          /* skip failures */
        }
      }),
    );
    setMergeContextByPrId((prev) => {
      const allowed = new Set(prsRef.current.map((pr) => pr.id));
      const next = Object.fromEntries(
        Object.entries(prev).filter(([prId]) => allowed.has(prId))
      ) as Record<string, PrMergeContext>;
      for (const [prId, ctx] of Object.entries(contexts)) {
        next[prId] = ctx;
      }
      return jsonEqual(prev, next) ? prev : next;
    });
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
      const shouldLoadWorkflowState = activeTab !== "normal";
      const [prList, laneList, queueStateList, queueRehearsalList] = await Promise.all([
        window.ade.prs.listWithConflicts(),
        window.ade.lanes.list({ includeStatus: false }),
        shouldLoadWorkflowState
          ? window.ade.prs.listQueueStates({ includeCompleted: true, limit: 50 })
          : Promise.resolve([] as QueueLandingState[]),
        shouldLoadWorkflowState
          ? window.ade.prs.listQueueRehearsals({ includeCompleted: true, limit: 50 })
          : Promise.resolve([] as QueueRehearsalState[]),
      ]);
      const prsChanged = !jsonEqual(prsRef.current, prList);

      // Stable-reference updates: only replace state when data actually changed
      // to avoid unnecessary re-render cascades in child components.
      setPrs((prev) => (jsonEqual(prev, prList) ? prev : prList));
      setLanes((prev) => (jsonEqual(prev, laneList) ? prev : laneList));
      setQueueStates((prev) => {
        const next = Object.fromEntries(queueStateList.map((state) => [state.groupId, state] as const));
        return jsonEqual(prev, next) ? prev : next;
      });
      setQueueRehearsals((prev) => {
        const next = Object.fromEntries(queueRehearsalList.map((state) => [state.groupId, state] as const));
        return jsonEqual(prev, next) ? prev : next;
      });
      prsRef.current = prList;

      // Clear selectedPrId if the PR no longer exists
      setSelectedPrId((prev) => {
        if (prev && !prList.some((pr) => pr.id === prev)) return null;
        return prev;
      });

      if (prsChanged) {
        setMergeContextByPrId((prev) => {
          const allowed = new Set(prList.map((pr) => pr.id));
          const next = Object.fromEntries(
            Object.entries(prev).filter(([prId]) => allowed.has(prId))
          ) as Record<string, PrMergeContext>;
          return jsonEqual(prev, next) ? prev : next;
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      initialLoadDone.current = true;
      refreshInFlight.current = false;
    }
  }, [activeTab]);

  // Initial load
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Silently refresh detail data for the given PR (no loading state).
  // Returns early if a fetch is already in progress or the PR is no longer selected.
  const rateLimitedUntilRef = React.useRef(0);
  const refreshDetailSilently = useCallback((prId: string) => {
    if (detailFetchInProgress.current) return;
    // Bail if the PR we were asked to refresh is no longer the active one
    if (selectedPrIdRef.current !== prId) return;
    // Guard: don't fetch details for a PR that's not in the list
    if (!prsRef.current.some((p) => p.id === prId)) return;
    // Skip if we're rate-limited
    if (Date.now() < rateLimitedUntilRef.current) return;

    detailFetchInProgress.current = true;
    Promise.all([
      window.ade.prs.getStatus(prId),
      window.ade.prs.getChecks(prId),
      window.ade.prs.getReviews(prId),
      window.ade.prs.getComments(prId),
    ])
      .then(([status, checks, reviews, comments]) => {
        // Only apply if this PR is still selected
        if (selectedPrIdRef.current !== prId) return;
        setDetailStatus((prev) => (jsonEqual(prev, status) ? prev : status));
        setDetailChecks((prev) => (jsonEqual(prev, checks) ? prev : checks));
        setDetailReviews((prev) => (jsonEqual(prev, reviews) ? prev : reviews));
        setDetailComments((prev) => (jsonEqual(prev, comments) ? prev : comments));
      })
      .catch((err) => {
        const msg = String(err?.message ?? err);
        if (msg.includes("rate limit") || msg.includes("API rate")) {
          // Back off for 5 minutes on rate limit
          rateLimitedUntilRef.current = Date.now() + 5 * 60_000;
          console.warn("[PrsContext] GitHub rate limit hit — pausing detail polling for 5 min");
        } else {
          console.warn("[PrsContext] Failed to refresh PR detail data:", err);
        }
      })
      .finally(() => {
        detailFetchInProgress.current = false;
      });
  }, []);

  // Load detail data when selected PR changes, then poll every 8s
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
    const prId = selectedPrId;
    setDetailBusy(true);
    detailFetchInProgress.current = true;

    Promise.all([
      window.ade.prs.getStatus(prId),
      window.ade.prs.getChecks(prId),
      window.ade.prs.getReviews(prId),
      window.ade.prs.getComments(prId),
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
        detailFetchInProgress.current = false;
        if (!cancelled) setDetailBusy(false);
      });

    // After the initial fetch, poll every 60 seconds for fresh detail data.
    // GitHub rate limit is 5000/hour (~83/min) and each detail refresh uses ~10 API calls,
    // so polling faster than 60s risks exhausting the rate limit.
    const intervalId = window.setInterval(() => {
      refreshDetailSilently(prId);
    }, 60_000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [selectedPrId, refreshDetailSilently]);

  useEffect(() => {
    if (!selectedPrId) return;
    if (mergeContextByPrId[selectedPrId]) return;
    void refreshMergeContexts([selectedPrId]);
  }, [mergeContextByPrId, refreshMergeContexts, selectedPrId]);

  useEffect(() => {
    if (activeTab === "normal") return;
    const prIds = prsRef.current.map((pr) => pr.id);
    if (prIds.length === 0) return;
    void refreshMergeContexts(prIds);
  }, [activeTab, prs, refreshMergeContexts]);

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
        // Also refresh detail data for the actively viewed PR
        const activePrId = selectedPrIdRef.current;
        if (activePrId) {
          refreshDetailSilently(activePrId);
        }
      } else if (event.type === "queue-state" || event.type === "queue-step") {
        window.ade.prs.getQueueState(event.groupId).then((qs) => {
          if (qs) {
            setQueueStates((prev) => ({ ...prev, [event.groupId]: qs }));
          }
        }).catch((err) => {
          console.warn("[PrsContext] Failed to fetch queue state for group:", event.groupId, err);
        });
      } else if (event.type === "queue-rehearsal-state" || event.type === "queue-rehearsal-step") {
        window.ade.prs.getQueueRehearsalState(event.groupId).then((qs) => {
          if (qs) {
            setQueueRehearsals((prev) => ({ ...prev, [event.groupId]: qs }));
          }
        }).catch((err) => {
          console.warn("[PrsContext] Failed to fetch queue rehearsal state for group:", event.groupId, err);
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
  }, [refresh, refreshDetailSilently]);

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
      queueRehearsals,
      inlineTerminal,
      resolverModel,
      resolverReasoningLevel,
      resolverPermissionMode: resolverPermissions[resolvePermissionFamilyForModel(resolverModel)],
      resolverSessionsByContextKey,
      setActiveTab,
      setSelectedPrId,
      setSelectedQueueGroupId,
      setSelectedRebaseItemId,
      setMergeMethod,
      setResolverModel,
      setResolverReasoningLevel,
      setResolverPermissionMode,
      upsertResolverSession,
      clearResolverSession,
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
      queueRehearsals,
      inlineTerminal,
      resolverModel,
      resolverReasoningLevel,
      resolverPermissions,
      resolverSessionsByContextKey,
      setResolverModel,
      setResolverPermissionMode,
      upsertResolverSession,
      clearResolverSession,
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
