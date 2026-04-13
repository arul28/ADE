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
  PrConvergenceState,
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
  PrEventPayload,
  LaneSummary,
  AutoRebaseLaneStatus,
  AutoRebaseEventPayload,
  PrConvergenceStatePatch,
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

  // Inline terminal
  inlineTerminal: InlineTerminalState;

  // Persisted convergence runtime cache
  convergenceStatesByPrId: Record<string, PrConvergenceState>;

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
  loadConvergenceState: (prId: string, options?: { force?: boolean }) => Promise<PrConvergenceState>;
  saveConvergenceState: (prId: string, state: PrConvergenceStatePatch) => Promise<PrConvergenceState>;
  resetConvergenceState: (prId: string) => Promise<void>;
  refresh: () => Promise<void>;
};

const PrsContext = createContext<PrsContextValue | null>(null);

const LS_MODEL_KEY = "ade:prs:resolverModel";
const LS_REASONING_KEY = "ade:prs:resolverReasoningLevel";
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

function readPersistedReasoningLevel(): string {
  try {
    const value = localStorage.getItem(LS_REASONING_KEY);
    if (value && value.trim().length > 0) return value.trim();
  } catch {
    /* ignore */
  }
  return "medium";
}

function readInitialTab(): PrTab {
  try {
    const params = new URLSearchParams(window.location.search);
    const tab = params.get("tab");
    if (tab === "normal" || tab === "queue" || tab === "integration" || tab === "rebase") return tab;
  } catch { /* ignore */ }
  return "normal";
}

function readInitialPrId(): string | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const prId = params.get("prId");
    if (prId && prId.trim().length > 0) return prId.trim();
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

export function PrsProvider({ children }: { children: React.ReactNode }) {
  const [activeTab, setActiveTab] = useState<PrTab>(readInitialTab);
  const [prs, setPrs] = useState<PrWithConflicts[]>([]);
  const [lanes, setLanes] = useState<LaneSummary[]>([]);
  const [mergeContextByPrId, setMergeContextByPrId] = useState<Record<string, PrMergeContext>>({});
  const [selectedPrId, setSelectedPrId] = useState<string | null>(readInitialPrId);
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
  const rebaseNeedsRef = React.useRef<RebaseNeed[]>([]);
  const autoRebaseStatusesRef = React.useRef<AutoRebaseLaneStatus[]>([]);
  React.useEffect(() => { rebaseNeedsRef.current = rebaseNeeds; }, [rebaseNeeds]);
  React.useEffect(() => { autoRebaseStatusesRef.current = autoRebaseStatuses; }, [autoRebaseStatuses]);

  // Queue state
  const [queueStates, setQueueStates] = useState<Record<string, QueueLandingState>>({});

  // Inline terminal
  const [inlineTerminal, setInlineTerminal] = useState<InlineTerminalState>(null);

  // Persisted convergence runtime cache
  const [convergenceStatesByPrId, setConvergenceStatesByPrId] = useState<Record<string, PrConvergenceState>>({});
  const convergenceStatesByPrIdRef = React.useRef<Record<string, PrConvergenceState>>({});
  React.useEffect(() => {
    convergenceStatesByPrIdRef.current = convergenceStatesByPrId;
  }, [convergenceStatesByPrId]);

  // Resolver preferences
  const [resolverModel, setResolverModelRaw] = useState<string>(readPersistedModel);
  const [resolverReasoningLevel, setResolverReasoningLevelRaw] = useState<string>(readPersistedReasoningLevel);
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

  const setResolverReasoningLevel = useCallback((level: string) => {
    setResolverReasoningLevelRaw(level);
    try {
      localStorage.setItem(LS_REASONING_KEY, level);
    } catch {
      /* ignore */
    }
  }, []);

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

  const storeConvergenceState = useCallback((state: PrConvergenceState): PrConvergenceState => {
    // Guard against late IPC responses for PRs that have been pruned from the list.
    // Only apply the guard after the initial load has completed — before that the PR
    // list is empty and states should still be cached so explicit load/save calls work.
    // Using initialLoadDone (rather than prsRef.current.length > 0) ensures that once
    // the list is known, stale responses for unknown PR ids are always rejected — even
    // when the list becomes empty after pruning.
    if (initialLoadDone.current && !prsRef.current.some((pr) => pr.id === state.prId)) {
      return state;
    }
    setConvergenceStatesByPrId((prev) => {
      if (jsonEqual(prev[state.prId], state)) return prev;
      const next = { ...prev, [state.prId]: state };
      convergenceStatesByPrIdRef.current = next;
      return next;
    });
    return state;
  }, []);

  const loadConvergenceState = useCallback(async (prId: string, options?: { force?: boolean }): Promise<PrConvergenceState> => {
    const normalizedPrId = requirePrId(prId);
    if (!options?.force) {
      const cached = convergenceStatesByPrIdRef.current[normalizedPrId];
      if (cached) return cached;
    }
    const runtime = await window.ade.prs.convergenceStateGet(normalizedPrId);
    return storeConvergenceState(runtime);
  }, [storeConvergenceState]);

  const saveConvergenceState = useCallback(async (prId: string, state: PrConvergenceStatePatch): Promise<PrConvergenceState> => {
    const normalizedPrId = requirePrId(prId);
    const runtime = await window.ade.prs.convergenceStateSave(normalizedPrId, state);
    return storeConvergenceState(runtime);
  }, [storeConvergenceState]);

  const resetConvergenceState = useCallback(async (prId: string): Promise<void> => {
    const normalizedPrId = String(prId ?? "").trim();
    if (!normalizedPrId) return;
    await window.ade.prs.convergenceStateDelete(normalizedPrId);
    // Update the mutable ref synchronously so callers that read it
    // immediately after reset don't see stale data.
    const { [normalizedPrId]: _, ...rest } = convergenceStatesByPrIdRef.current;
    convergenceStatesByPrIdRef.current = rest;
    setConvergenceStatesByPrId((prev) => {
      if (!(normalizedPrId in prev)) return prev;
      const next = { ...prev };
      delete next[normalizedPrId];
      return next;
    });
  }, []);

  // Concurrency guard for refresh
  const refreshInFlight = React.useRef(false);
  const refreshPending = React.useRef(false);
  const prsRef = React.useRef<PrWithConflicts[]>([]);
  const mergeContextByPrIdRef = React.useRef<Record<string, PrMergeContext>>({});
  React.useEffect(() => { prsRef.current = prs; }, [prs]);
  React.useEffect(() => { mergeContextByPrIdRef.current = mergeContextByPrId; }, [mergeContextByPrId]);

  // Refs for detail polling
  const selectedPrIdRef = React.useRef<string | null>(null);
  React.useEffect(() => { selectedPrIdRef.current = selectedPrId; }, [selectedPrId]);
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

  const refreshQueueStates = useCallback(async (groupIds: string[]) => {
    const uniqueGroupIds = [...new Set(groupIds.map((groupId) => String(groupId ?? "").trim()).filter(Boolean))];
    if (uniqueGroupIds.length === 0) return;
    await Promise.all(uniqueGroupIds.map(async (groupId) => {
      try {
        const queueState = await window.ade.prs.getQueueState(groupId);
        if (!queueState) return;
        setQueueStates((prev) => {
          const next = { ...prev, [groupId]: queueState };
          return jsonEqual(prev, next) ? prev : next;
        });
      } catch (err) {
        console.warn("[PrsContext] Failed to refresh queue state for group:", groupId, err);
      }
    }));
  }, []);

  // Core refresh (guarded against concurrent calls).
  // If a refresh is requested while one is already in flight, we set a
  // pending flag so that once the current flight completes it immediately
  // kicks off another refresh instead of silently dropping the request.
  const refresh = useCallback(async () => {
    if (refreshInFlight.current) {
      refreshPending.current = true;
      return;
    }
    refreshInFlight.current = true;
    refreshPending.current = false;
    // Only show the loading indicator during the initial fetch —
    // background refreshes should NOT flash loading state.
    const isInitial = !initialLoadDone.current;
    if (isInitial) setLoading(true);
    setError(null);
    try {
      await window.ade.prs.refresh().catch(() => {});
      const shouldLoadWorkflowState = activeTab !== "normal";
      const [prList, laneList, queueStateList, refreshedRebaseNeeds, refreshedAutoRebaseStatuses] = await Promise.all([
        window.ade.prs.listWithConflicts(),
        window.ade.lanes.list({ includeStatus: true }),
        shouldLoadWorkflowState
          ? window.ade.prs.listQueueStates({ includeCompleted: true, limit: 50 })
          : Promise.resolve([] as QueueLandingState[]),
        window.ade.rebase.scanNeeds().catch((err) => {
          console.warn("[PrsContext] Failed to refresh rebase needs:", err);
          return rebaseNeedsRef.current;
        }),
        window.ade.lanes.listAutoRebaseStatuses().catch((err) => {
          console.warn("[PrsContext] Failed to refresh auto-rebase statuses:", err);
          return autoRebaseStatusesRef.current;
        }),
      ]);
      const changedPrIds = diffPrIds(prsRef.current, prList);

      // Stable-reference updates: only replace state when data actually changed
      // to avoid unnecessary re-render cascades in child components.
      setPrs((prev) => (jsonEqual(prev, prList) ? prev : prList));
      setLanes((prev) => (jsonEqual(prev, laneList) ? prev : laneList));
      setRebaseNeeds((prev) => (jsonEqual(prev, refreshedRebaseNeeds) ? prev : refreshedRebaseNeeds));
      setAutoRebaseStatuses((prev) => (jsonEqual(prev, refreshedAutoRebaseStatuses) ? prev : refreshedAutoRebaseStatuses));
      setQueueStates((prev) => {
        const next = Object.fromEntries(queueStateList.map((state) => [state.groupId, state] as const));
        return jsonEqual(prev, next) ? prev : next;
      });
      prsRef.current = prList;

      // Clear selectedPrId if the PR no longer exists
      setSelectedPrId((prev) => {
        if (prev && !prList.some((pr) => pr.id === prev)) return null;
        return prev;
      });

      const allowedPrIds = new Set(prList.map((pr) => pr.id));
      setMergeContextByPrId((prev) => pruneByAllowedIds(prev, allowedPrIds));
      setConvergenceStatesByPrId((prev) => pruneByAllowedIds(prev, allowedPrIds));

      if (changedPrIds.length > 0) {
        void refreshMergeContexts(changedPrIds);
        const affectedQueueGroupIds = new Set<string>();
        for (const prId of changedPrIds) {
          const context = mergeContextByPrIdRef.current[prId];
          if (context?.groupType === "queue" && context.groupId) {
            affectedQueueGroupIds.add(context.groupId);
          }
        }
        void refreshQueueStates([...affectedQueueGroupIds]);
      }

      // NOTE: Rebase needs and auto-rebase statuses are already fetched in the
      // Promise.all batch above (refreshedRebaseNeeds / refreshedAutoRebaseStatuses)
      // and applied via setRebaseNeeds / setAutoRebaseStatuses, so no additional
      // fire-and-forget fetch is needed here.
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
      initialLoadDone.current = true;
      refreshInFlight.current = false;

      // If another refresh was requested while we were in flight, run it now.
      if (refreshPending.current) {
        refreshPending.current = false;
        void refresh();
      }
    }
  }, [activeTab, refreshMergeContexts, refreshQueueStates]);

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
    Promise.allSettled([
      window.ade.prs.getStatus(prId),
      window.ade.prs.getChecks(prId),
      window.ade.prs.getReviews(prId),
      window.ade.prs.getComments(prId),
    ])
      .then(([statusResult, checksResult, reviewsResult, commentsResult]) => {
        // Only apply if this PR is still selected
        if (selectedPrIdRef.current !== prId) return;

        // Check for rate-limit errors in any rejected result
        for (const result of [statusResult, checksResult, reviewsResult, commentsResult]) {
          if (result.status === "rejected") {
            const msg = String(result.reason?.message ?? result.reason);
            if (msg.includes("rate limit") || msg.includes("API rate")) {
              rateLimitedUntilRef.current = Date.now() + 5 * 60_000;
              console.warn("[PrsContext] GitHub rate limit hit — pausing detail polling for 5 min");
              return; // Don't apply partial results during rate limiting
            }
          }
        }

        // Apply successful results; keep previous value for any that failed
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
      })
      .finally(() => {
        detailFetchInProgress.current = false;
      });
  }, []);

  // Load detail data when selected PR changes, then poll every 60s.
  // Reset rate-limit backoff on each mount / PR change so stale backoff
  // from a previous session doesn't block the first fetch.
  useEffect(() => {
    // Reset rate-limit backoff whenever the selected PR changes (including
    // on remount) so stale backoff from a previous session is cleared.
    rateLimitedUntilRef.current = 0;

    if (!selectedPrId) {
      setDetailStatus(null);
      setDetailChecks([]);
      setDetailReviews([]);
      setDetailComments([]);
      return;
    }

    // Guard: don't attempt to load details for a PR that's not in our list.
    // The PR was likely deleted or merged -- the empty state will show naturally.
    if (!prsRef.current.some((p) => p.id === selectedPrId)) {
      setDetailStatus(null);
      setDetailChecks([]);
      setDetailReviews([]);
      setDetailComments([]);
      setSelectedPrId(null);
      return;
    }

    let cancelled = false;
    const prId = selectedPrId;
    setDetailBusy(true);
    detailFetchInProgress.current = true;

    Promise.allSettled([
      window.ade.prs.getStatus(prId),
      window.ade.prs.getChecks(prId),
      window.ade.prs.getReviews(prId),
      window.ade.prs.getComments(prId),
    ])
      .then(([statusResult, checksResult, reviewsResult, commentsResult]) => {
        if (cancelled) return;

        // Check for rate-limit errors in any rejected result
        for (const result of [statusResult, checksResult, reviewsResult, commentsResult]) {
          if (result.status === "rejected") {
            const msg = String(result.reason?.message ?? result.reason);
            if (msg.includes("rate limit") || msg.includes("API rate")) {
              rateLimitedUntilRef.current = Date.now() + 5 * 60_000;
              console.warn("[PrsContext] GitHub rate limit hit — pausing detail polling for 5 min");
              // Clear stale data on rate limit
              setDetailStatus(null);
              setDetailChecks([]);
              setDetailReviews([]);
              setDetailComments([]);
              return;
            }
          }
        }

        if (statusResult.status === "fulfilled") {
          setDetailStatus(statusResult.value ?? null);
        } else {
          console.warn("[PrsContext] Failed to load PR status:", statusResult.reason);
          setDetailStatus(null);
        }
        if (checksResult.status === "fulfilled") {
          setDetailChecks(checksResult.value);
        } else {
          console.warn("[PrsContext] Failed to load PR checks:", checksResult.reason);
          setDetailChecks([]);
        }
        if (reviewsResult.status === "fulfilled") {
          setDetailReviews(reviewsResult.value);
        } else {
          console.warn("[PrsContext] Failed to load PR reviews:", reviewsResult.reason);
          setDetailReviews([]);
        }
        if (commentsResult.status === "fulfilled") {
          setDetailComments(commentsResult.value);
        } else {
          console.warn("[PrsContext] Failed to load PR comments:", commentsResult.reason);
          setDetailComments([]);
        }
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
      // Reset rate-limit backoff on cleanup so remounts start fresh
      rateLimitedUntilRef.current = 0;
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
        setConvergenceStatesByPrId((prev) => pruneByAllowedIds(prev, allowedPrIds));

        // Clear selection if the active PR was removed (mirrors refresh() guard).
        const activePrIdForPrune = selectedPrIdRef.current;
        if (activePrIdForPrune && !allowedPrIds.has(activePrIdForPrune)) {
          setDetailStatus(null);
          setDetailChecks([]);
          setDetailReviews([]);
          setDetailComments([]);
          setSelectedPrId(null);
        }

        if (changedPrIds.length > 0) {
          void refreshMergeContexts(changedPrIds);
          const affectedQueueGroupIds = new Set<string>();
          for (const prId of changedPrIds) {
            const context = mergeContextByPrIdRef.current[prId];
            if (context?.groupType === "queue" && context.groupId) {
              affectedQueueGroupIds.add(context.groupId);
            }
          }
          void refreshQueueStates([...affectedQueueGroupIds]);
        }

        // Also refresh detail data for the actively viewed PR only when it changed.
        const activePrId = selectedPrIdRef.current;
        if (activePrId && changedPrIds.includes(activePrId)) {
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
      }
    });
    return () => {
      unsub();
    };
  }, [refreshDetailSilently, refreshMergeContexts, refreshQueueStates]);

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
      convergenceStatesByPrId,
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
      loadConvergenceState,
      saveConvergenceState,
      resetConvergenceState,
      refresh,
    }),
    // Note: setActiveTab, setSelectedPrId, setSelectedQueueGroupId, setSelectedRebaseItemId,
    // setMergeMethod, and setInlineTerminal are intentionally excluded from this dependency
    // array because they are useState setters which are guaranteed to be referentially stable
    // across re-renders per the React useState contract. Resolver preference setters are
    // included because they are useCallback wrappers (not raw setters).
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
      convergenceStatesByPrId,
      resolverModel,
      resolverReasoningLevel,
      resolverPermissions,
      resolverSessionsByContextKey,
      setResolverModel,
      setResolverReasoningLevel,
      setResolverPermissionMode,
      upsertResolverSession,
      clearResolverSession,
      loadConvergenceState,
      saveConvergenceState,
      resetConvergenceState,
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
