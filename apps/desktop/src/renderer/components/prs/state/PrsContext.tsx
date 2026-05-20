import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
} from "react";
import type {
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
  PrReviewThread,
  PrDeployment,
  PrAiSummary,
  PrSnapshotHydration,
  PrAgentPermissionMode,
} from "../../../../shared/types";
import type { PrTimelineFilters } from "../shared/PrTimeline";
import { buildPrAiResolutionContextKey } from "../../../../shared/types";
import { getModelById, resolveProviderGroupForModel, type ModelProviderGroup } from "../../../../shared/modelRegistry";
import { parsePrsRouteState, resolvePrsActiveTab } from "../prsRouteState";
import { resolveRouteRebaseSelection } from "../shared/rebaseNeedUtils";
import { useAppStore } from "../../../state/appStore";

type PrTab = "normal" | "queue" | "integration" | "rebase";

type PrRefreshArgs = { prId?: string; prIds?: string[] };

type RefreshCoreOptions = {
  skipFreshWarmCache?: boolean;
  githubRefreshMode?: "await" | "background";
  githubRefreshArgs?: PrRefreshArgs;
};

const REFRESH_ERROR_RETRY_DELAYS_MS = [1_500, 3_000, 6_000] as const;

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
  const githubRefreshMode = a?.githubRefreshMode === "await" || b.githubRefreshMode === "await"
    ? "await"
    : a?.githubRefreshMode ?? b.githubRefreshMode;
  return {
    skipFreshWarmCache: a
      ? Boolean(a.skipFreshWarmCache && b.skipFreshWarmCache)
      : Boolean(b.skipFreshWarmCache),
    githubRefreshMode,
    githubRefreshArgs: mergePrRefreshArgs(a?.githubRefreshArgs, b.githubRefreshArgs),
  };
}

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
  detailReviewThreads: PrReviewThread[];
  detailDeployments: PrDeployment[];
  detailAiSummary: PrAiSummary | null;
  detailSnapshot: PrSnapshotHydration | null;
  detailSnapshotsByPrId: Record<string, PrSnapshotHydration>;
  detailLiveDataPrId: string | null;
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
  resolverPermissionMode: PrAgentPermissionMode;
  resolverSessionsByContextKey: Record<string, PrAiResolutionSessionInfo>;

  // Timeline + rails (PRs tab redesign)
  prsTimelineRailsEnabled: boolean;
  dismissedAiSummaries: Record<string, boolean>;
  timelineFiltersByPrId: Record<string, PrTimelineFilters>;
  viewerLogin: string | null;
};

type PrsContextValue = PrsState & {
  setActiveTab: (tab: PrTab) => void;
  setSelectedPrId: (id: string | null) => void;
  setSelectedQueueGroupId: (id: string | null) => void;
  setSelectedRebaseItemId: (id: string | null) => void;
  setMergeMethod: (method: MergeMethod) => void;
  setResolverModel: (model: string) => void;
  setResolverReasoningLevel: (level: string) => void;
  setResolverPermissionMode: (mode: PrAgentPermissionMode, modelId?: string) => void;
  upsertResolverSession: (session: PrAiResolutionSessionInfo) => void;
  clearResolverSession: (context: PrAiResolutionContext) => void;
  setInlineTerminal: (terminal: InlineTerminalState) => void;
  loadConvergenceState: (prId: string, options?: { force?: boolean }) => Promise<PrConvergenceState>;
  saveConvergenceState: (prId: string, state: PrConvergenceStatePatch) => Promise<PrConvergenceState>;
  resetConvergenceState: (prId: string) => Promise<void>;
  refresh: (args?: { prId?: string; prIds?: string[] }) => Promise<void>;

  // Timeline + rails controls
  setPrsTimelineRailsEnabled: (enabled: boolean) => void;
  setTimelineFilters: (prId: string, filters: PrTimelineFilters) => void;
  setAiSummaryDismissed: (prId: string, dismissed: boolean) => void;
  regeneratePrAiSummary: (prId: string) => Promise<void>;
  setViewerLogin: (login: string | null) => void;
};

const PrsContext = createContext<PrsContextValue | null>(null);

const LS_MODEL_KEY = "ade:prs:resolverModel";
const LS_REASONING_KEY = "ade:prs:resolverReasoningLevel";
const LS_PERMISSION_KEY = "ade:prs:resolverPermissions";
const LS_TIMELINE_RAILS_KEY = "ade:prs:timelineRailsEnabled";
const LS_DISMISSED_SUMMARIES_KEY = "ade:prs:dismissedAiSummaries";
const LS_TIMELINE_FILTERS_KEY = "ade:prs:timelineFiltersByPrId";
const PRS_CONTEXT_CACHE_TTL_MS = 120_000;
const PRS_DETAIL_CACHE_TTL_MS = 60_000;
const PRS_CONTEXT_DEFAULT_CACHE_KEY = "__default_project__";
const PRS_CONTEXT_CACHE_DISABLED = import.meta.env.MODE === "test";

type PrsContextWarmCache = {
  activeTab: PrTab;
  prs: PrWithConflicts[];
  lanes: LaneSummary[];
  mergeContextByPrId: Record<string, PrMergeContext>;
  selectedPrId: string | null;
  selectedQueueGroupId: string | null;
  selectedRebaseItemId: string | null;
  mergeMethod: MergeMethod;
  detailStatus: PrStatus | null;
  detailChecks: PrCheck[];
  detailReviews: PrReview[];
  detailComments: PrComment[];
  detailReviewThreads: PrReviewThread[];
  detailDeployments: PrDeployment[];
  detailAiSummary: PrAiSummary | null;
  detailSnapshotsByPrId: Record<string, PrSnapshotHydration>;
  rebaseNeeds: RebaseNeed[];
  autoRebaseStatuses: AutoRebaseLaneStatus[];
  queueStates: Record<string, QueueLandingState>;
  inlineTerminal: InlineTerminalState;
  convergenceStatesByPrId: Record<string, PrConvergenceState>;
  resolverSessionsByContextKey: Record<string, PrAiResolutionSessionInfo>;
  viewerLogin: string | null;
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

function readBoolLs(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === "true") return true;
    if (raw === "false") return false;
  } catch {
    /* ignore */
  }
  return fallback;
}

function readJsonLs<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJsonLs(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

type ResolverPermissionFamily = Extract<ModelProviderGroup, "claude" | "codex" | "opencode" | "cursor" | "droid">;
type ResolverPermissionPreferences = Record<ResolverPermissionFamily, PrAgentPermissionMode>;

const DEFAULT_RESOLVER_PERMISSIONS: ResolverPermissionPreferences = {
  claude: "default",
  codex: "default",
  opencode: "edit",
  cursor: "default",
  droid: "edit",
};

function normalizeResolverPermissionMode(value: unknown): PrAgentPermissionMode | null {
  if (
    value === "read_only" ||
    value === "guarded_edit" ||
    value === "full_edit" ||
    value === "default" ||
    value === "plan" ||
    value === "edit" ||
    value === "full-auto" ||
    value === "config-toml"
  ) return value;
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
      opencode: normalizeResolverPermissionMode(parsed?.opencode) ?? DEFAULT_RESOLVER_PERMISSIONS.opencode,
      cursor: normalizeResolverPermissionMode(parsed?.cursor) ?? DEFAULT_RESOLVER_PERMISSIONS.cursor,
      droid: normalizeResolverPermissionMode(parsed?.droid) ?? DEFAULT_RESOLVER_PERMISSIONS.droid,
    };
  } catch {
    return DEFAULT_RESOLVER_PERMISSIONS;
  }
}

function resolvePermissionFamilyForModel(modelId: string): ResolverPermissionFamily {
  const descriptor = getModelById(modelId);
  return descriptor ? resolveProviderGroupForModel(descriptor) : "opencode";
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

function readInitialRouteState(fallback?: PrsContextWarmCache | null): {
  activeTab: PrTab;
  selectedPrId: string | null;
  selectedQueueGroupId: string | null;
  selectedRebaseItemId: string | null;
} {
  try {
    const route = parsePrsRouteState({
      search: window.location.search,
      hash: window.location.hash,
    });
    const hasExplicitRouteState = Boolean(
      route.tab
      || route.workflowTab
      || route.prId
      || route.queueGroupId
      || route.laneId
      || route.detailTab
    );
    if (!hasExplicitRouteState && fallback) {
      return {
        activeTab: fallback.activeTab,
        selectedPrId: fallback.selectedPrId,
        selectedQueueGroupId: fallback.selectedQueueGroupId,
        selectedRebaseItemId: fallback.selectedRebaseItemId,
      };
    }
    const resolved = resolvePrsActiveTab(route);
    const activeTab: PrTab = resolved.isWorkflowRoute
      ? (resolved.effectiveWorkflow ?? "integration")
      : "normal";
    return {
      activeTab,
      selectedPrId: !resolved.isWorkflowRoute ? route.prId : null,
      selectedQueueGroupId: resolved.effectiveWorkflow === "queue" ? route.queueGroupId : null,
      // Mirror PRsPage's resolver so the shape of this id matches what the
      // rebase UI later expects. rebaseNeeds are empty at provider mount, so
      // this returns the bare lane id; PRsPage's syncFromLocation effect runs
      // the same resolver again once needs load and upgrades it to the
      // canonical need-item key.
      selectedRebaseItemId: resolved.effectiveWorkflow === "rebase"
        ? resolveRouteRebaseSelection({ rebaseNeeds: [], routeItemId: route.laneId })
        : null,
    };
  } catch { /* ignore */ }
  return {
    activeTab: "normal",
    selectedPrId: null,
    selectedQueueGroupId: null,
    selectedRebaseItemId: null,
  };
}

function currentRouteRequestsPrDiagnostics(): boolean {
  try {
    const route = parsePrsRouteState({
      search: window.location.search,
      hash: window.location.hash,
    });
    return resolvePrsActiveTab(route).isWorkflowRoute || route.prId !== null;
  } catch {
    return false;
  }
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

export function PrsProvider({ active = true, children }: { active?: boolean; children: React.ReactNode }) {
  const projectRoot = useAppStore((state) => state.project?.rootPath ?? null);
  const cacheKey = prsContextCacheKey(projectRoot);
  const warmCache = useMemo(() => readPrsContextWarmCache(projectRoot), [projectRoot]);
  const warmCacheHydratedAtRef = React.useRef(warmCache?.dataLoadedAt ?? warmCache?.cachedAt ?? 0);

  // Compute initial route state exactly once per provider mount. Reading
  // window.location + running parsePrsRouteState/resolvePrsActiveTab on every
  // render would be wasteful; the warm-cache dependency is stable for the mount
  // and lets plain /prs restores resume the last in-memory PR surface.
  const initialRouteState = useMemo(() => readInitialRouteState(warmCache), [warmCache]);
  const [activeTab, setActiveTab] = useState<PrTab>(initialRouteState.activeTab);
  const activeTabRef = React.useRef<PrTab>(initialRouteState.activeTab);
  React.useEffect(() => {
    activeTabRef.current = activeTab;
  }, [activeTab]);
  const [prs, setPrs] = useState<PrWithConflicts[]>(() => warmCache?.prs ?? []);
  const [lanes, setLanes] = useState<LaneSummary[]>(() => warmCache?.lanes ?? []);
  const [mergeContextByPrId, setMergeContextByPrId] = useState<Record<string, PrMergeContext>>(
    () => warmCache?.mergeContextByPrId ?? {},
  );
  const [selectedPrId, setSelectedPrId] = useState<string | null>(initialRouteState.selectedPrId);
  const [selectedQueueGroupId, setSelectedQueueGroupId] = useState<string | null>(initialRouteState.selectedQueueGroupId);
  const [selectedRebaseItemId, setSelectedRebaseItemId] = useState<string | null>(initialRouteState.selectedRebaseItemId);
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
  const [detailAiSummary, setDetailAiSummary] = useState<PrAiSummary | null>(() => warmCache?.detailAiSummary ?? null);
  const [detailSnapshot, setDetailSnapshot] = useState<PrSnapshotHydration | null>(null);
  const [detailSnapshotsByPrId, setDetailSnapshotsByPrId] = useState<Record<string, PrSnapshotHydration>>(
    () => warmCache?.detailSnapshotsByPrId ?? {},
  );
  const [detailLiveDataPrId, setDetailLiveDataPrId] = useState<string | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [viewerLogin, setViewerLogin] = useState<string | null>(() => warmCache?.viewerLogin ?? null);
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
      || detailAiSummary !== null
      || detailSnapshot !== null;
  }, [
    detailAiSummary,
    detailChecks.length,
    detailComments.length,
    detailDeployments.length,
    detailReviewThreads.length,
    detailReviews.length,
    detailSnapshot,
    detailStatus,
  ]);

  // Timeline + rails (new)
  const [prsTimelineRailsEnabled, setPrsTimelineRailsEnabledRaw] = useState<boolean>(
    () => readBoolLs(LS_TIMELINE_RAILS_KEY, true),
  );
  const [dismissedAiSummaries, setDismissedAiSummaries] = useState<Record<string, boolean>>(
    () => readJsonLs<Record<string, boolean>>(LS_DISMISSED_SUMMARIES_KEY, {}),
  );
  const [timelineFiltersByPrId, setTimelineFiltersByPrId] = useState<Record<string, PrTimelineFilters>>(
    () => readJsonLs<Record<string, PrTimelineFilters>>(LS_TIMELINE_FILTERS_KEY, {}),
  );

  const setPrsTimelineRailsEnabled = useCallback((enabled: boolean) => {
    setPrsTimelineRailsEnabledRaw(enabled);
    try {
      localStorage.setItem(LS_TIMELINE_RAILS_KEY, enabled ? "true" : "false");
    } catch {
      /* ignore */
    }
  }, []);

  const setTimelineFilters = useCallback((prId: string, filters: PrTimelineFilters) => {
    setTimelineFiltersByPrId((prev) => {
      const next = { ...prev, [prId]: filters };
      writeJsonLs(LS_TIMELINE_FILTERS_KEY, next);
      return next;
    });
  }, []);

  const setAiSummaryDismissed = useCallback((prId: string, dismissed: boolean) => {
    setDismissedAiSummaries((prev) => {
      if (Boolean(prev[prId]) === dismissed) return prev;
      const next = { ...prev };
      if (dismissed) next[prId] = true;
      else delete next[prId];
      writeJsonLs(LS_DISMISSED_SUMMARIES_KEY, next);
      return next;
    });
  }, []);

  const regeneratePrAiSummary = useCallback(async (prId: string) => {
    const fn = window.ade?.prs?.regenerateAiSummary;
    if (typeof fn !== "function") return;
    try {
      const summary = await fn(prId);
      if (selectedPrIdRef.current !== prId) return;
      setDetailAiSummary(summary);
    } catch (err) {
      console.warn("[PrsContext] regenerateAiSummary failed:", err);
    }
  }, []);

  // Rebase state
  const [rebaseNeeds, setRebaseNeeds] = useState<RebaseNeed[]>(() => warmCache?.rebaseNeeds ?? []);
  const [autoRebaseStatuses, setAutoRebaseStatuses] = useState<AutoRebaseLaneStatus[]>(
    () => warmCache?.autoRebaseStatuses ?? [],
  );
  const rebaseNeedsRef = React.useRef<RebaseNeed[]>([]);
  const autoRebaseStatusesRef = React.useRef<AutoRebaseLaneStatus[]>([]);
  React.useEffect(() => { rebaseNeedsRef.current = rebaseNeeds; }, [rebaseNeeds]);
  React.useEffect(() => { autoRebaseStatusesRef.current = autoRebaseStatuses; }, [autoRebaseStatuses]);

  // Queue state
  const [queueStates, setQueueStates] = useState<Record<string, QueueLandingState>>(
    () => warmCache?.queueStates ?? {},
  );

  // Inline terminal
  const [inlineTerminal, setInlineTerminal] = useState<InlineTerminalState>(() => warmCache?.inlineTerminal ?? null);

  // Persisted convergence runtime cache
  const [convergenceStatesByPrId, setConvergenceStatesByPrId] = useState<Record<string, PrConvergenceState>>(
    () => warmCache?.convergenceStatesByPrId ?? {},
  );
  const convergenceStatesByPrIdRef = React.useRef<Record<string, PrConvergenceState>>(
    warmCache?.convergenceStatesByPrId ?? {},
  );
  React.useEffect(() => {
    convergenceStatesByPrIdRef.current = convergenceStatesByPrId;
  }, [convergenceStatesByPrId]);

  // Resolver preferences
  const [resolverModel, setResolverModelRaw] = useState<string>(readPersistedModel);
  const [resolverReasoningLevel, setResolverReasoningLevelRaw] = useState<string>(readPersistedReasoningLevel);
  const [resolverPermissions, setResolverPermissions] = useState<ResolverPermissionPreferences>(readPersistedResolverPermissions);
  const [resolverSessionsByContextKey, setResolverSessionsByContextKey] = useState<Record<string, PrAiResolutionSessionInfo>>(
    () => warmCache?.resolverSessionsByContextKey ?? {},
  );

  const setResolverModel = useCallback((model: string) => {
    setResolverModelRaw(model);
    try {
      localStorage.setItem(LS_MODEL_KEY, model);
    } catch {
      /* ignore */
    }
  }, []);

  const setResolverPermissionMode = useCallback((mode: PrAgentPermissionMode, modelId = resolverModel) => {
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
  const refreshPending = React.useRef<RefreshCoreOptions | null>(null);
  const [refreshErrorRetryCount, setRefreshErrorRetryCount] = React.useState(0);
  const prsRef = React.useRef<PrWithConflicts[]>(warmCache?.prs ?? []);
  const mergeContextByPrIdRef = React.useRef<Record<string, PrMergeContext>>(warmCache?.mergeContextByPrId ?? {});
  React.useEffect(() => { prsRef.current = prs; }, [prs]);
  React.useEffect(() => { mergeContextByPrIdRef.current = mergeContextByPrId; }, [mergeContextByPrId]);

  // Refs for detail polling
  const selectedPrIdRef = React.useRef<string | null>(initialRouteState.selectedPrId);
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

  const prsSnapshotWarmKey = useMemo(() => prs.map((pr) => pr.id).sort().join("|"), [prs]);
  React.useEffect(() => {
    if (!active || prsSnapshotWarmKey.length === 0 || typeof window.ade.prs.listSnapshots !== "function") {
      return undefined;
    }
    let cancelled = false;
    void window.ade.prs.listSnapshots({}).then((snapshots) => {
      if (cancelled) return;
      const linkedPrIds = new Set(prsRef.current.map((pr) => pr.id));
      mergeDetailSnapshots(snapshots.filter((snapshot) => linkedPrIds.has(snapshot.prId)));
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [active, mergeDetailSnapshots, prsSnapshotWarmKey]);

  const refreshMergeContexts = useCallback(async (prIds: string[]) => {
    const uniquePrIds = [...new Set(prIds.map((id) => String(id ?? "").trim()).filter(Boolean))];
    if (uniquePrIds.length === 0) return;
    const contexts: Record<string, PrMergeContext> = {};
    if (typeof window.ade.prs.getMergeContexts === "function") {
      try {
        Object.assign(contexts, await window.ade.prs.getMergeContexts(uniquePrIds));
      } catch {
        /* fall back to single-context hydration below */
      }
    }
    const missingPrIds = uniquePrIds.filter((prId) => contexts[prId] == null);
    if (missingPrIds.length > 0) {
      await Promise.all(
        missingPrIds.map(async (prId) => {
          try {
            const ctx = await window.ade.prs.getMergeContext(prId);
            contexts[prId] = ctx;
          } catch {
            /* skip failures */
          }
        }),
      );
    }
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
  const initialLoadDone = React.useRef(Boolean(warmCache));

  const refreshQueueStates = useCallback(async (groupIds: string[]) => {
    if (!active) return;
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
  }, [active]);

  // Core refresh (guarded against concurrent calls).
  // If a refresh is requested while one is already in flight, we set a
  // pending flag so that once the current flight completes it immediately
  // kicks off another refresh instead of silently dropping the request.
  const applyLocalPrState = useCallback(async (options: {
    includeWorkflowDiagnostics?: boolean;
    forceRebaseDiagnostics?: boolean;
  } = {}) => {
    if (!active) return;
    const shouldLoadWorkflowState = activeTabRef.current !== "normal";
    const shouldLoadRebaseState = (options.includeWorkflowDiagnostics ?? true)
      && (options.forceRebaseDiagnostics === true || shouldLoadWorkflowState || selectedPrIdRef.current !== null);
    // Block only on the fast DB reads (PR list, lanes, queue states). Rebase
    // scanning is git work on disk — let it populate in the background so the
    // PR list renders immediately when the user opens the tab.
    const [prList, laneList, queueStateList] = await Promise.all([
      window.ade.prs.listWithConflicts({ includeConflictAnalysis: shouldLoadWorkflowState }),
      window.ade.lanes.list({ includeStatus: false }),
      shouldLoadWorkflowState
        ? window.ade.prs.listQueueStates({ includeCompleted: true, limit: 50 })
        : Promise.resolve([] as QueueLandingState[]),
    ]);
    const changedPrIds = diffPrIds(prsRef.current, prList);

    // Stable-reference updates: only replace state when data actually changed
    // to avoid unnecessary re-render cascades in child components.
    setPrs((prev) => (jsonEqual(prev, prList) ? prev : prList));
    setLanes((prev) => (jsonEqual(prev, laneList) ? prev : laneList));
    if (shouldLoadWorkflowState) {
      setQueueStates((prev) => {
        const next = Object.fromEntries(queueStateList.map((state) => [state.groupId, state] as const));
        return jsonEqual(prev, next) ? prev : next;
      });
    }
    prsRef.current = prList;

    // Fire-and-forget rebase scans — these were the long pole on PRs-tab cold
    // open. The header/list doesn't depend on them, so let them stream in.
    if (shouldLoadRebaseState) {
      void window.ade.rebase.scanNeeds()
        .then((next) => setRebaseNeeds((prev) => (jsonEqual(prev, next) ? prev : next)))
        .catch((err) => console.warn("[PrsContext] Failed to refresh rebase needs:", err));
      void window.ade.lanes.listAutoRebaseStatuses()
        .then((next) => setAutoRebaseStatuses((prev) => (jsonEqual(prev, next) ? prev : next)))
        .catch((err) => console.warn("[PrsContext] Failed to refresh auto-rebase statuses:", err));
    }

    // Clear selectedPrId if the PR no longer exists
    setSelectedPrId((prev) => {
      if (prev && !prList.some((pr) => pr.id === prev)) return null;
      return prev;
    });

    const allowedPrIds = new Set(prList.map((pr) => pr.id));
    setMergeContextByPrId((prev) => pruneByAllowedIds(prev, allowedPrIds));
    setConvergenceStatesByPrId((prev) => pruneByAllowedIds(prev, allowedPrIds));
    setDetailSnapshotsByPrId((prev) => pruneByAllowedIds(prev, allowedPrIds));

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
  }, [active, refreshMergeContexts, refreshQueueStates]);

  const refreshCore = useCallback(async (options: RefreshCoreOptions = {}) => {
    if (!active) return;
    if (refreshInFlight.current) {
      refreshPending.current = mergeRefreshCoreOptions(refreshPending.current, options);
      return;
    }
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
      const shouldLoadWorkflowDiagnostics =
        activeTabRef.current !== "normal" || selectedPrIdRef.current !== null || currentRouteRequestsPrDiagnostics();
      void applyLocalPrState({ forceRebaseDiagnostics: shouldLoadWorkflowDiagnostics })
        .then(() => options.githubRefreshMode === "background"
          ? window.ade.prs.refresh(options.githubRefreshArgs).catch(() => null)
          : null)
        .then(() => {
          if (options.githubRefreshMode === "background") {
            return applyLocalPrState({ forceRebaseDiagnostics: shouldLoadWorkflowDiagnostics });
          }
          return null;
        })
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
      if (options.githubRefreshMode === "await") {
        await window.ade.prs.refresh(options.githubRefreshArgs).catch(() => {});
      }
      const shouldLoadWorkflowDiagnostics =
        activeTabRef.current !== "normal" || selectedPrIdRef.current !== null || currentRouteRequestsPrDiagnostics();
      await applyLocalPrState({ forceRebaseDiagnostics: shouldLoadWorkflowDiagnostics });
      warmCacheHydratedAtRef.current = Date.now();
      setRefreshErrorRetryCount(0);
      if (options.githubRefreshMode === "background") {
        void window.ade.prs.refresh(options.githubRefreshArgs)
          .then(() => applyLocalPrState({ forceRebaseDiagnostics: shouldLoadWorkflowDiagnostics }))
          .then(() => {
            warmCacheHydratedAtRef.current = Date.now();
          })
          .catch((err) => {
            console.warn("[PrsContext] Background PR refresh failed:", err);
          });
      }
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
    const shouldRefreshFromGithub =
      activeTabRef.current !== "normal" || selectedPrIdRef.current !== null;
    void refreshCore({
      skipFreshWarmCache: true,
      githubRefreshMode: shouldRefreshFromGithub ? "background" : undefined,
    });
  }, [active, refreshCore]);

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
        if (![statusResult, checksResult, reviewsResult, commentsResult].some((result) => result.status === "fulfilled")) {
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
  }, []);

  const refreshSelectedPrDetail = useCallback(async (prId: string) => {
    if (selectedPrIdRef.current !== prId) return;
    if (!prsRef.current.some((p) => p.id === prId)) return;
    if (Date.now() < rateLimitedUntilRef.current) return;

    detailFetchInProgress.current = true;
    try {
      const [statusResult, checksResult, reviewsResult, commentsResult] = await Promise.allSettled([
        window.ade.prs.getStatus(prId),
        window.ade.prs.getChecks(prId),
        window.ade.prs.getReviews(prId),
        window.ade.prs.getComments(prId),
      ]);
      if (selectedPrIdRef.current !== prId) return;

      for (const result of [statusResult, checksResult, reviewsResult, commentsResult]) {
        if (result.status === "rejected") {
          const msg = String(result.reason?.message ?? result.reason);
          if (msg.includes("rate limit") || msg.includes("API rate")) {
            rateLimitedUntilRef.current = Date.now() + 5 * 60_000;
            console.warn("[PrsContext] GitHub rate limit hit — pausing detail polling for 5 min");
            return;
          }
        }
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
  }, []);

  const refresh = useCallback(async (args: PrRefreshArgs = {}) => {
    const githubRefreshArgs = normalizePrRefreshArgs(args);
    await refreshCore({ githubRefreshMode: "await", githubRefreshArgs });

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
  // Reset rate-limit backoff on each mount / PR change so stale backoff
  // from a previous session doesn't block the first fetch.
  useEffect(() => {
    if (!active) return;
    // Reset rate-limit backoff whenever the selected PR changes (including
    // on remount) so stale backoff from a previous session is cleared.
    rateLimitedUntilRef.current = 0;

    if (!selectedPrId) {
      detailStatePrIdRef.current = null;
      setDetailStatus(null);
      setDetailChecks([]);
      setDetailReviews([]);
      setDetailComments([]);
      setDetailReviewThreads([]);
      setDetailDeployments([]);
      setDetailAiSummary(null);
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
      setDetailAiSummary(null);
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
      setDetailAiSummary(null);
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
      setDetailAiSummary(null);
    }
    const isPrRateLimitError = (error: unknown): boolean => {
      const msg = String((error as { message?: unknown } | null)?.message ?? error);
      return msg.includes("rate limit") || msg.includes("API rate");
    };
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
          ["getAiSummary", async () => {
            if (typeof api?.getAiSummary !== "function") return;
            const summary = await api.getAiSummary(prId);
            if (!cancelled && selectedPrIdRef.current === prId) setDetailAiSummary(summary);
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
      let rateLimited = false;
      const primaryRequestCount = 4;
      const markPrimarySettled = (fulfilled: boolean) => {
        primarySettledCount += 1;
        if (fulfilled) primaryFulfilledCount += 1;
        if (selectedPrIdRef.current === prId && primarySettledCount === 1) {
          detailFetchInProgress.current = false;
        }
        if (selectedPrIdRef.current === prId && primarySettledCount === primaryRequestCount) {
          detailFetchInProgress.current = false;
          if (!rateLimited && primaryFulfilledCount === primaryRequestCount) {
            detailStatePrIdRef.current = prId;
            detailLoadedAtByPrIdRef.current[prId] = Date.now();
            setDetailLiveDataPrId(prId);
          } else {
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
            if (rateLimited) return;
            fulfilled = true;
            if (value != null && (!Array.isArray(value) || value.length > 0)) {
              liveDetailApplied = true;
            }
            apply(value);
            setDetailBusy(false);
          })
          .catch((error: unknown) => {
            if (cancelled || selectedPrIdRef.current !== prId) return;
            if (isPrRateLimitError(error)) {
              rateLimited = true;
              rateLimitedUntilRef.current = Date.now() + 5 * 60_000;
              console.warn("[PrsContext] GitHub rate limit hit - pausing detail polling for 5 min");
              if (snapshotForRequest?.prId === prId) {
                setDetailStatus(snapshotForRequest.status);
                setDetailChecks(snapshotForRequest.checks);
                setDetailReviews(snapshotForRequest.reviews);
                setDetailComments(snapshotForRequest.comments);
              }
              setDetailLiveDataPrId(null);
            } else {
              console.warn(`[PrsContext] Failed to load PR ${name}:`, error);
            }
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
    if (hasFreshDetailCache) {
      setDetailLiveDataPrId(prId);
      setDetailBusy(false);
      startSecondaryDetailFetch();
      const intervalId = window.setInterval(() => {
        refreshDetailSilently(prId);
      }, 60_000);
      return () => {
        cancelled = true;
        window.clearInterval(intervalId);
        rateLimitedUntilRef.current = 0;
      };
    }
    if (hasFreshSnapshotPrefill) {
      setDetailBusy(false);
      startProgressivePrimaryFetch({ background: true });
      startSecondaryDetailFetch();
      const intervalId = window.setInterval(() => {
        refreshDetailSilently(prId);
      }, 60_000);
      return () => {
        cancelled = true;
        window.clearInterval(intervalId);
        rateLimitedUntilRef.current = 0;
      };
    }
    if (!hasFreshDetailCache && !hasFreshSnapshotPrefill && typeof window.ade.prs.listSnapshots === "function") {
      setDetailBusy(true);
      void window.ade.prs.listSnapshots({ prId }).then((snapshots) => {
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
      const intervalId = window.setInterval(() => {
        refreshDetailSilently(prId);
      }, 60_000);
      return () => {
        cancelled = true;
        window.clearInterval(intervalId);
        rateLimitedUntilRef.current = 0;
      };
    }

    setDetailBusy(true);
    detailFetchInProgress.current = true;

    let primarySettledCount = 0;
    let primaryFulfilledCount = 0;
    let rateLimited = false;
    const primaryRequestCount = 4;
    const markPrimarySettled = (fulfilled: boolean) => {
      primarySettledCount += 1;
      if (fulfilled) primaryFulfilledCount += 1;
      if (selectedPrIdRef.current === prId && primarySettledCount === 1) {
        detailFetchInProgress.current = false;
      }
      if (selectedPrIdRef.current === prId && primarySettledCount === primaryRequestCount) {
        detailFetchInProgress.current = false;
        setDetailLiveDataPrId(!rateLimited && primaryFulfilledCount > 0 ? prId : null);
      }
    };
    const isRateLimitError = (error: unknown): boolean => {
      const msg = String((error as { message?: unknown } | null)?.message ?? error);
      return msg.includes("rate limit") || msg.includes("API rate");
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
          if (rateLimited) return;
          fulfilled = true;
          if (value != null && (!Array.isArray(value) || value.length > 0)) {
            liveDetailApplied = true;
          }
          detailStatePrIdRef.current = prId;
          detailLoadedAtByPrIdRef.current[prId] = Date.now();
          apply(value);
          setDetailLiveDataPrId(prId);
          setDetailBusy(false);
        })
        .catch((error: unknown) => {
          if (cancelled || selectedPrIdRef.current !== prId) return;
          if (isRateLimitError(error)) {
            rateLimited = true;
            rateLimitedUntilRef.current = Date.now() + 5 * 60_000;
            console.warn("[PrsContext] GitHub rate limit hit — pausing detail polling for 5 min");
            if (snapshotForRequest?.prId === prId) {
              setDetailStatus(snapshotForRequest.status);
              setDetailChecks(snapshotForRequest.checks);
              setDetailReviews(snapshotForRequest.reviews);
              setDetailComments(snapshotForRequest.comments);
            }
            setDetailLiveDataPrId(null);
          } else {
            console.warn(`[PrsContext] Failed to load PR ${name}:`, error);
          }
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

    // Progressive secondary fetch (deployments, AI summary) — yields
    // to the main paint so the primary header + checks render first.
    startSecondaryDetailFetch({ reset: true });

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
  }, [active, selectedPrId, refreshDetailSilently]);

  useEffect(() => {
    if (!active || !selectedPrId) return;
    if (mergeContextByPrId[selectedPrId]) return;
    void refreshMergeContexts([selectedPrId]);
  }, [active, mergeContextByPrId, refreshMergeContexts, selectedPrId]);

  useEffect(() => {
    if (!active || activeTab === "normal") return;
    const prIds = prsRef.current.map((pr) => pr.id);
    if (prIds.length === 0) return;
    void refreshMergeContexts(prIds);
  }, [active, activeTab, prs, refreshMergeContexts]);

  useEffect(() => {
    if (!active || activeTab === "normal") return;
    let cancelled = false;
    window.ade.prs.listQueueStates({ includeCompleted: true, limit: 50 })
      .then((states) => {
        if (cancelled) return;
        setQueueStates((prev) => {
          const next = Object.fromEntries(states.map((state) => [state.groupId, state] as const));
          return jsonEqual(prev, next) ? prev : next;
        });
      })
      .catch((err) => {
        console.warn("[PrsContext] Failed to load workflow queue states:", err);
      });
    return () => {
      cancelled = true;
    };
  }, [active, activeTab]);

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
        setConvergenceStatesByPrId((prev) => pruneByAllowedIds(prev, allowedPrIds));
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
  }, [active, refreshDetailSilently, refreshMergeContexts, refreshQueueStates]);

  // Subscribe to rebase events
  useEffect(() => {
    if (!active) return;
    const unsub = window.ade.rebase.onEvent((event: RebaseEventPayload) => {
      if (event.type === "rebase-needs-updated") {
        setRebaseNeeds(event.needs);
      }
    });
    return unsub;
  }, [active]);

  // Periodic rebase needs scan (cancelled flag guards against setState after unmount).
  // The plain PR browser only needs workflow rebase state when a PR detail is selected.
  useEffect(() => {
    let cancelled = false;
    if (!active || (activeTab === "normal" && selectedPrId == null)) {
      return () => {
        cancelled = true;
      };
    }
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
  }, [active, activeTab, selectedPrId]);

  // Subscribe to auto-rebase events
  useEffect(() => {
    if (!active) return;
    const unsub = window.ade.lanes.onAutoRebaseEvent((event: AutoRebaseEventPayload) => {
      if (event.type === "auto-rebase-updated") {
        setAutoRebaseStatuses(event.statuses);
      }
    });
    return unsub;
  }, [active]);

  useEffect(() => {
    if (!active || (activeTab === "normal" && selectedPrId == null)) return;
    let cancelled = false;
    window.ade.lanes.listAutoRebaseStatuses().then((statuses) => {
      if (!cancelled) setAutoRebaseStatuses(statuses);
    }).catch((err) => {
      console.warn("[PrsContext] Failed to list auto-rebase statuses:", err);
    });
    return () => {
      cancelled = true;
    };
  }, [active, activeTab, selectedPrId]);

  useEffect(() => {
    if (PRS_CONTEXT_CACHE_DISABLED) return;
    if (!initialLoadDone.current && prs.length === 0 && lanes.length === 0) return;
    const cachedAt = Date.now();
    prsContextWarmCacheByProject.set(cacheKey, {
      activeTab,
      prs,
      lanes,
      mergeContextByPrId,
      selectedPrId,
      selectedQueueGroupId,
      selectedRebaseItemId,
      mergeMethod,
      detailStatus,
      detailChecks,
      detailReviews,
      detailComments,
      detailReviewThreads,
      detailDeployments,
      detailAiSummary,
      detailSnapshotsByPrId,
      rebaseNeeds,
      autoRebaseStatuses,
      queueStates,
      inlineTerminal,
      convergenceStatesByPrId,
      resolverSessionsByContextKey,
      viewerLogin,
      cachedAt,
      dataLoadedAt: warmCacheHydratedAtRef.current,
    });
  }, [
    activeTab,
    autoRebaseStatuses,
    cacheKey,
    convergenceStatesByPrId,
    detailAiSummary,
    detailChecks,
    detailComments,
    detailDeployments,
    detailReviewThreads,
    detailReviews,
    detailStatus,
    detailSnapshotsByPrId,
    inlineTerminal,
    lanes,
    mergeContextByPrId,
    mergeMethod,
    prs,
    queueStates,
    rebaseNeeds,
    resolverSessionsByContextKey,
    selectedPrId,
    selectedQueueGroupId,
    selectedRebaseItemId,
    viewerLogin,
  ]);

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
      detailReviewThreads,
      detailDeployments,
      detailAiSummary,
      detailSnapshot,
      detailSnapshotsByPrId,
      detailLiveDataPrId,
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
      prsTimelineRailsEnabled,
      dismissedAiSummaries,
      timelineFiltersByPrId,
      viewerLogin,
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
      setPrsTimelineRailsEnabled,
      setTimelineFilters,
      setAiSummaryDismissed,
      regeneratePrAiSummary,
      setViewerLogin,
    }),
    // Note: setActiveTab, setSelectedPrId, setSelectedQueueGroupId, setSelectedRebaseItemId,
    // setMergeMethod, setInlineTerminal, and setViewerLogin are intentionally excluded from this dependency
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
      detailReviewThreads,
      detailDeployments,
      detailAiSummary,
      detailSnapshot,
      detailSnapshotsByPrId,
      detailLiveDataPrId,
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
      prsTimelineRailsEnabled,
      dismissedAiSummaries,
      timelineFiltersByPrId,
      viewerLogin,
      setResolverModel,
      setResolverReasoningLevel,
      setResolverPermissionMode,
      upsertResolverSession,
      clearResolverSession,
      loadConvergenceState,
      saveConvergenceState,
      resetConvergenceState,
      refresh,
      setPrsTimelineRailsEnabled,
      setTimelineFilters,
      setAiSummaryDismissed,
      regeneratePrAiSummary,
    ],
  );

  return <PrsContext.Provider value={value}>{children}</PrsContext.Provider>;
}

export function usePrs(): PrsContextValue {
  const ctx = useContext(PrsContext);
  if (!ctx) throw new Error("usePrs must be used within PrsProvider");
  return ctx;
}
