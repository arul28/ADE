import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import type { AgentChatSession, LaneSummary, TerminalSessionSummary } from "../../../shared/types";
import {
  useAppStore,
  useAppStoreApi,
  type WorkDraftKind,
  type WorkProjectViewState,
  type WorkSidebarTab,
  type WorkSessionListOrganization,
  type WorkStatusFilter,
  type WorkViewMode,
} from "../../state/appStore";
import { listSessionsCached, invalidateSessionListCache } from "../../lib/sessionListCache";
import { sessionStatusBucket } from "../../lib/terminalAttention";
import { buildOptimisticChatSessionSummary, isRunOwnedSession } from "../../lib/sessions";
import { shouldRefreshSessionListForChatEvent } from "../../lib/chatSessionEvents";
import {
  resolveLaunchFields,
  LAUNCH_PROFILE_TITLE,
  LAUNCH_PROFILE_TOOL_TYPE,
  type LaunchProfile,
} from "./cliLaunch";
import { sortLanesForTabs } from "../lanes/laneUtils";

const DEFAULT_PROJECT_WORK_STATE: WorkProjectViewState = {
  openItemIds: [],
  activeItemId: null,
  selectedItemId: null,
  viewMode: "tabs",
  draftKind: "chat",
  draftLaneId: null,
  laneFilter: "all",
  statusFilter: "all",
  search: "",
  sessionListOrganization: "by-lane",
  workCollapsedLaneIds: [],
  workCollapsedSectionIds: [],
  workCollapsedTabGroupIds: [],
  workFocusSessionsHidden: false,
  workSidebarOpen: false,
  workSidebarTab: "git",
  workSidebarWidthPct: 36,
  laneSessionOrder: {},
  pinnedSessionIds: [],
};

const OPTIMISTIC_PTY_SESSION_TTL_MS = 2 * 60 * 1000;
const EMPTY_STRING_ARRAY: string[] = [];
const EMPTY_LANE_SESSION_ORDER: Record<string, string[]> = {};

type WorkTabGroupKind = "lane" | "status" | "time";
type WorkTabGroupLane = Pick<LaneSummary, "id" | "name" | "laneType" | "createdAt" | "color">;

function compareSessionsByStartedAtDesc(left: TerminalSessionSummary, right: TerminalSessionSummary): number {
  return new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime();
}

function upsertSessionByStartedAt(
  sessions: readonly TerminalSessionSummary[],
  session: TerminalSessionSummary,
): TerminalSessionSummary[] {
  return [session, ...sessions.filter((entry) => entry.id !== session.id)].sort(compareSessionsByStartedAtDesc);
}

function mergePendingOptimisticSession(
  persisted: TerminalSessionSummary,
  optimistic: TerminalSessionSummary,
): { session: TerminalSessionSummary; keepPending: boolean } {
  const optimisticPtyId = optimistic.ptyId?.trim() || null;
  if (!optimisticPtyId) return { session: persisted, keepPending: false };

  if (persisted.status !== "running") {
    return { session: persisted, keepPending: false };
  }

  const persistedPtyId = persisted.ptyId?.trim() || null;
  if (persistedPtyId === optimisticPtyId) {
    return { session: persisted, keepPending: false };
  }

  return {
    session: {
      ...persisted,
      ptyId: optimisticPtyId,
      toolType: persisted.toolType ?? optimistic.toolType,
      runtimeState: persisted.runtimeState ?? optimistic.runtimeState,
    },
    keepPending: true,
  };
}

export type WorkTabGroup = {
  id: string;
  label: string;
  kind: WorkTabGroupKind;
  collapsed: boolean;
  sessionIds: string[];
  sessions: TerminalSessionSummary[];
  /** From Lanes tab; only set for `kind === "lane"`. */
  laneColor: string | null;
};

export type WorkTabGroupModel = {
  groups: WorkTabGroup[];
  sessionIds: string[];
  visibleSessions: TerminalSessionSummary[];
};

function bucketByTime(session: TerminalSessionSummary): "today" | "yesterday" | "older" {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterdayStart = todayStart - 86400000;
  const startedAt = new Date(session.startedAt).getTime();
  if (startedAt >= todayStart) return "today";
  if (startedAt >= yesterdayStart) return "yesterday";
  return "older";
}

function getStatusBucketLabel(bucket: ReturnType<typeof sessionStatusBucket>): string {
  if (bucket === "running") return "Running";
  if (bucket === "awaiting-input") return "Awaiting";
  return "Ended";
}

export function buildWorkTabGroupModel(args: {
  sessions: TerminalSessionSummary[];
  lanes: WorkTabGroupLane[];
  organization: WorkSessionListOrganization;
  collapsedGroupIds: string[];
  laneSessionOrder?: Record<string, string[]>;
  pinnedSessionIds?: string[];
}): WorkTabGroupModel {
  const orderedSessions = [...args.sessions].sort(compareSessionsByStartedAtDesc);
  const collapseSet = new Set(args.collapsedGroupIds);
  const pinnedSet = new Set(args.pinnedSessionIds ?? []);
  const laneOrderMap = args.laneSessionOrder ?? {};

  if (args.organization === "by-lane") {
    const laneOrder = new Map(sortLanesForTabs(args.lanes).map((lane, index) => [lane.id, index] as const));
    const laneGroups = new Map<string, { id: string; label: string; kind: WorkTabGroupKind; sessions: TerminalSessionSummary[] }>();

    for (const session of orderedSessions) {
      const lane = args.lanes.find((entry) => entry.id === session.laneId);
      const groupId = `lane:${session.laneId}`;
      const group = laneGroups.get(groupId) ?? {
        id: groupId,
        label: lane?.name ?? session.laneName,
        kind: "lane" as const,
        sessions: [],
      };
      group.sessions.push(session);
      laneGroups.set(groupId, group);
    }

    const groups = [...laneGroups.values()].sort((left, right) => {
      const leftIdx = laneOrder.get(left.id.slice("lane:".length)) ?? Number.MAX_SAFE_INTEGER;
      const rightIdx = laneOrder.get(right.id.slice("lane:".length)) ?? Number.MAX_SAFE_INTEGER;
      if (leftIdx !== rightIdx) return leftIdx - rightIdx;
      return left.label.localeCompare(right.label);
    });

    const visibleSessions: TerminalSessionSummary[] = [];
    const finalGroups = groups.map((group) => {
      const laneId = group.id.startsWith("lane:") ? group.id.slice("lane:".length) : null;
      const lane = laneId ? args.lanes.find((l) => l.id === laneId) : null;
      const collapsed = collapseSet.has(group.id);

      const customOrder = laneId ? laneOrderMap[laneId] : undefined;
      let arranged = group.sessions;
      if (customOrder && customOrder.length > 0) {
        const sessionById = new Map(group.sessions.map((s) => [s.id, s] as const));
        const used = new Set<string>();
        const ordered: TerminalSessionSummary[] = [];
        for (const id of customOrder) {
          const s = sessionById.get(id);
          if (s && !used.has(id)) {
            ordered.push(s);
            used.add(id);
          }
        }
        for (const s of group.sessions) {
          if (!used.has(s.id)) ordered.push(s);
        }
        arranged = ordered;
      }
      if (pinnedSet.size > 0) {
        const pinned: TerminalSessionSummary[] = [];
        const others: TerminalSessionSummary[] = [];
        for (const s of arranged) {
          if (pinnedSet.has(s.id)) pinned.push(s);
          else others.push(s);
        }
        arranged = [...pinned, ...others];
      }

      if (!collapsed) visibleSessions.push(...arranged);
      return {
        id: group.id,
        label: group.label,
        kind: group.kind,
        laneColor: group.kind === "lane" ? (lane?.color ?? null) : null,
        collapsed,
        sessionIds: arranged.map((session) => session.id),
        sessions: arranged,
      } satisfies WorkTabGroup;
    });
    return { groups: finalGroups, sessionIds: visibleSessions.map((session) => session.id), visibleSessions };
  }

  if (args.organization === "by-time") {
    const timeOrder: Array<"today" | "yesterday" | "older"> = ["today", "yesterday", "older"];
    const buckets = new Map<"today" | "yesterday" | "older", TerminalSessionSummary[]>();
    for (const session of orderedSessions) {
      const bucket = bucketByTime(session);
      const list = buckets.get(bucket) ?? [];
      list.push(session);
      buckets.set(bucket, list);
    }

    const visibleSessions: TerminalSessionSummary[] = [];
    const groups = timeOrder
      .filter((bucket) => (buckets.get(bucket)?.length ?? 0) > 0)
      .map((bucket) => {
        const sessions = buckets.get(bucket) ?? [];
        const groupId = `time:${bucket}`;
        const collapsed = collapseSet.has(groupId);
        if (!collapsed) visibleSessions.push(...sessions);
        return {
          id: groupId,
          label: bucket === "today" ? "Today" : bucket === "yesterday" ? "Yesterday" : "Older",
          kind: "time" as const,
          laneColor: null,
          collapsed,
          sessionIds: sessions.map((session) => session.id),
          sessions,
        } satisfies WorkTabGroup;
      });

    return { groups, sessionIds: visibleSessions.map((session) => session.id), visibleSessions };
  }

  const statusBuckets = new Map<"running" | "awaiting-input" | "ended", TerminalSessionSummary[]>();
  for (const session of orderedSessions) {
    const bucket = sessionStatusBucket({
      status: session.status,
      lastOutputPreview: session.lastOutputPreview,
      runtimeState: session.runtimeState,
      toolType: session.toolType,
    });
    const list = statusBuckets.get(bucket) ?? [];
    list.push(session);
    statusBuckets.set(bucket, list);
  }

  const statusOrder: Array<"running" | "awaiting-input" | "ended"> = ["running", "awaiting-input", "ended"];
  const visibleSessions: TerminalSessionSummary[] = [];
  const groups = statusOrder
    .filter((bucket) => (statusBuckets.get(bucket)?.length ?? 0) > 0)
    .map((bucket) => {
      const sessions = statusBuckets.get(bucket) ?? [];
      const groupId = `status:${bucket}`;
      const collapsed = collapseSet.has(groupId);
      if (!collapsed) visibleSessions.push(...sessions);
      return {
        id: groupId,
        label: getStatusBucketLabel(bucket),
        kind: "status" as const,
        laneColor: null,
        collapsed,
        sessionIds: sessions.map((session) => session.id),
        sessions,
      } satisfies WorkTabGroup;
    });

  return { groups, sessionIds: visibleSessions.map((session) => session.id), visibleSessions };
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function reorderLaneSessionIdsForDisplay(args: {
  baseOrder: string[];
  pinnedSessionIds: string[];
  movedSessionId: string;
  targetSessionId: string;
  edge: "before" | "after";
}): string[] | null {
  if (!args.movedSessionId || !args.targetSessionId || args.movedSessionId === args.targetSessionId) {
    return null;
  }
  const pinned = new Set(args.pinnedSessionIds);
  const displayedOrder = [
    ...args.baseOrder.filter((id) => pinned.has(id)),
    ...args.baseOrder.filter((id) => !pinned.has(id)),
  ];
  const fromIndex = displayedOrder.indexOf(args.movedSessionId);
  const targetIndex = displayedOrder.indexOf(args.targetSessionId);
  if (fromIndex < 0 || targetIndex < 0) return null;

  const next = [...displayedOrder];
  const [moved] = next.splice(fromIndex, 1);
  if (!moved) return null;
  const targetAfterRemoval = next.indexOf(args.targetSessionId);
  if (targetAfterRemoval < 0) return null;
  next.splice(args.edge === "after" ? targetAfterRemoval + 1 : targetAfterRemoval, 0, moved);
  return arraysEqual(args.baseOrder, next) ? null : next;
}

function mapUrlStatusFilter(statusParamRaw: string): WorkStatusFilter | null {
  const statusParam = statusParamRaw.trim().toLowerCase();
  if (!statusParam) return null;
  if (statusParam === "running") return "running";
  if (statusParam === "awaiting-input" || statusParam === "awaiting") return "awaiting-input";
  if (statusParam === "ended") return "ended";
  if (statusParam === "all") return "all";
  if (statusParam === "completed" || statusParam === "failed" || statusParam === "disposed") return "ended";
  return null;
}

type QueuedRefresh = {
  showLoading: boolean;
  force: boolean;
  deferred: {
    promise: Promise<void>;
    resolve: () => void;
    reject: (reason: unknown) => void;
  };
};

type PendingOptimisticSession = {
  session: TerminalSessionSummary;
  createdAtMs: number;
};

type UseWorkSessionsOptions = {
  active?: boolean;
};

export function useWorkSessions({ active = true }: UseWorkSessionsOptions = {}) {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const appStore = useAppStoreApi();
  const projectRoot = useAppStore((s) => s.project?.rootPath ?? null);
  const lanes = useAppStore((s) => s.lanes);
  const focusSession = useAppStore((s) => s.focusSession);
  const selectLane = useAppStore((s) => s.selectLane);
  const refreshLanes = useAppStore((s) => s.refreshLanes);
  const workViewByProject = useAppStore((s) => s.workViewByProject);
  const setWorkViewState = useAppStore((s) => s.setWorkViewState);

  const [sessions, setSessions] = useState<TerminalSessionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [closingPtyIds, setClosingPtyIds] = useState<Set<string>>(new Set());
  const refreshInFlightRef = useRef(false);
  const refreshQueuedRef = useRef<QueuedRefresh | null>(null);
  const pendingOptimisticSessionsRef = useRef<Map<string, PendingOptimisticSession>>(new Map());
  const hasRunningSessionsRef = useRef(false);
  const backgroundRefreshTimerRef = useRef<number | null>(null);
  const appliedQuerySessionIdRef = useRef<string | null>(null);
  const appliedUrlFilterKeyRef = useRef<string | null>(null);
  const partiallyAppliedUrlFilterKeyRef = useRef<string | null>(null);
  const hasLoadedOnceRef = useRef(false);
  const projectRootRef = useRef<string | null>(projectRoot);
  const laneRecoveryRefreshProjectRef = useRef<string | null>(null);
  const isWorkRoute = active && (location.pathname === "/work" || location.pathname.startsWith("/work/"));

  useEffect(() => {
    projectRootRef.current = projectRoot;
  }, [projectRoot]);

  const projectViewState = useMemo(() => {
    if (!projectRoot) return DEFAULT_PROJECT_WORK_STATE;
    return workViewByProject[projectRoot] ?? DEFAULT_PROJECT_WORK_STATE;
  }, [projectRoot, workViewByProject]);

  const setProjectViewState = useCallback(
    (
      next:
        | Partial<WorkProjectViewState>
        | ((prev: WorkProjectViewState) => WorkProjectViewState),
    ) => {
      if (!projectRoot) return;
      setWorkViewState(projectRoot, next);
    },
    [projectRoot, setWorkViewState],
  );

  const openItemIds = projectViewState.openItemIds;
  const activeItemId = projectViewState.activeItemId;
  const selectedSessionId = projectViewState.selectedItemId;
  const viewMode = projectViewState.viewMode;
  const draftKind = projectViewState.draftKind;
  const draftLaneId = projectViewState.draftLaneId;
  const filterLaneId = projectViewState.laneFilter;
  const filterStatus = projectViewState.statusFilter;
  const q = projectViewState.search;
  const sessionListOrganization: WorkSessionListOrganization =
    projectViewState.sessionListOrganization ?? "by-lane";
  const workCollapsedLaneIds = projectViewState.workCollapsedLaneIds ?? EMPTY_STRING_ARRAY;
  const workCollapsedTabGroupIds = projectViewState.workCollapsedTabGroupIds ?? EMPTY_STRING_ARRAY;
  const workCollapsedSectionIds = projectViewState.workCollapsedSectionIds ?? EMPTY_STRING_ARRAY;
  const workFocusSessionsHidden = projectViewState.workFocusSessionsHidden ?? false;
  const workSidebarOpen = projectViewState.workSidebarOpen ?? false;
  const workSidebarTab = projectViewState.workSidebarTab ?? "git";
  const workSidebarWidthPct = projectViewState.workSidebarWidthPct ?? 36;
  const laneSessionOrder = projectViewState.laneSessionOrder ?? EMPTY_LANE_SESSION_ORDER;
  const pinnedSessionIds = projectViewState.pinnedSessionIds ?? EMPTY_STRING_ARRAY;
  const sessionsById = useMemo(() => {
    const map = new Map<string, TerminalSessionSummary>();
    for (const session of sessions) map.set(session.id, session);
    return map;
  }, [sessions]);
  const hasLaneBackedSessions = useMemo(
    () => sessions.some((session) => Boolean(session.laneId)),
    [sessions],
  );

  const selectLaneForActiveTab = useCallback(
    (sessionId: string | null) => {
      if (!sessionId || viewMode === "grid") return;
      const session = sessionsById.get(sessionId);
      if (!session) return;
      selectLane(session.laneId);
    },
    [selectLane, sessionsById, viewMode],
  );

  const openSessions = useMemo(() => {
    return openItemIds
      .map((id) => sessionsById.get(id))
      .filter((session): session is TerminalSessionSummary => session != null);
  }, [openItemIds, sessionsById]);

  useEffect(() => {
    if (!isWorkRoute) return;
    selectLaneForActiveTab(activeItemId);
  }, [activeItemId, isWorkRoute, selectLaneForActiveTab]);

  const tabGroupModel = useMemo(
    () => buildWorkTabGroupModel({
      sessions: openSessions,
      lanes,
      organization: sessionListOrganization,
      collapsedGroupIds: workCollapsedTabGroupIds,
      laneSessionOrder,
      pinnedSessionIds,
    }),
    [lanes, openSessions, sessionListOrganization, workCollapsedTabGroupIds, laneSessionOrder, pinnedSessionIds],
  );

  const visibleSessions = openSessions;

  const tabVisibleSessionIds = tabGroupModel.sessionIds;

  const setViewMode = useCallback(
    (nextMode: WorkViewMode) => {
      setProjectViewState({ viewMode: nextMode });
    },
    [setProjectViewState],
  );

  const showDraftKind = useCallback(
    (nextKind: WorkDraftKind) => {
      setProjectViewState((prev) => ({
        ...prev,
        draftKind: nextKind,
        viewMode: "tabs",
        activeItemId: null,
        selectedItemId: null,
      }));
    },
    [setProjectViewState],
  );

  const setDraftLaneId = useCallback(
    (laneId: string) => {
      const normalizedLaneId = laneId.trim();
      setProjectViewState({ draftLaneId: normalizedLaneId || null });
      if (normalizedLaneId) selectLane(normalizedLaneId);
    },
    [selectLane, setProjectViewState],
  );

  const setFilterLaneId = useCallback(
    (laneId: string) => {
      setProjectViewState({ laneFilter: laneId || "all" });
    },
    [setProjectViewState],
  );

  const setFilterStatus = useCallback(
    (status: WorkStatusFilter) => {
      setProjectViewState({ statusFilter: status });
    },
    [setProjectViewState],
  );

  const setSessionListOrganization = useCallback(
    (org: WorkSessionListOrganization) => {
      setProjectViewState({ sessionListOrganization: org });
    },
    [setProjectViewState],
  );

  const makeCollapsedToggle = useCallback(
    (key: "workCollapsedLaneIds" | "workCollapsedTabGroupIds" | "workCollapsedSectionIds") =>
      (itemId: string) => {
        setProjectViewState((prev) => {
          const cur = prev[key] ?? [];
          const has = cur.includes(itemId);
          return { ...prev, [key]: has ? cur.filter((id) => id !== itemId) : [...cur, itemId] };
        });
      },
    [setProjectViewState],
  );

  const toggleWorkLaneCollapsed = useMemo(
    () => makeCollapsedToggle("workCollapsedLaneIds"),
    [makeCollapsedToggle],
  );
  const toggleWorkTabGroupCollapsed = useMemo(
    () => makeCollapsedToggle("workCollapsedTabGroupIds"),
    [makeCollapsedToggle],
  );
  const toggleWorkSectionCollapsed = useMemo(
    () => makeCollapsedToggle("workCollapsedSectionIds"),
    [makeCollapsedToggle],
  );

  const reorderLaneSessions = useCallback(
    (laneId: string, movedSessionId: string, targetSessionId: string, edge: "before" | "after") => {
      if (!laneId || !movedSessionId || !targetSessionId || movedSessionId === targetSessionId) return;
      setProjectViewState((prev) => {
        const sessionsInLane = prev.openItemIds
          .map((id) => sessionsById.get(id))
          .filter((s): s is TerminalSessionSummary => s != null && s.laneId === laneId);
        if (sessionsInLane.length === 0) return prev;

        const existing = prev.laneSessionOrder?.[laneId];
        const baseOrder = existing && existing.length > 0
          ? [
              ...existing.filter((id) => sessionsInLane.some((s) => s.id === id)),
              ...sessionsInLane.filter((s) => !existing.includes(s.id)).map((s) => s.id),
            ]
          : sessionsInLane.map((s) => s.id);

        const next = reorderLaneSessionIdsForDisplay({
          baseOrder,
          pinnedSessionIds: prev.pinnedSessionIds ?? [],
          movedSessionId,
          targetSessionId,
          edge,
        });
        if (!next) return prev;

        return {
          ...prev,
          laneSessionOrder: {
            ...(prev.laneSessionOrder ?? {}),
            [laneId]: next,
          },
        };
      });
    },
    [sessionsById, setProjectViewState],
  );

  const togglePinnedSession = useCallback(
    (sessionId: string) => {
      if (!sessionId) return;
      setProjectViewState((prev) => {
        const cur = prev.pinnedSessionIds ?? [];
        const has = cur.includes(sessionId);
        return {
          ...prev,
          pinnedSessionIds: has ? cur.filter((id) => id !== sessionId) : [...cur, sessionId],
        };
      });
    },
    [setProjectViewState],
  );

  const setWorkFocusSessionsHidden = useCallback(
    (hidden: boolean) => {
      setProjectViewState({ workFocusSessionsHidden: hidden });
    },
    [setProjectViewState],
  );

  const setWorkSidebarOpen = useCallback(
    (open: boolean) => {
      setProjectViewState({ workSidebarOpen: open });
    },
    [setProjectViewState],
  );

  const setWorkSidebarTab = useCallback(
    (tab: WorkSidebarTab) => {
      setProjectViewState({ workSidebarTab: tab, workSidebarOpen: true });
    },
    [setProjectViewState],
  );

  const setWorkSidebarWidthPct = useCallback(
    (widthPct: number) => {
      // Mirror normalizeWorkSidebarWidthPct: a non-finite drag value would otherwise poison
      // the persisted layout — fall back to the default rather than persisting NaN/Infinity.
      const safeWidth = Number.isFinite(widthPct) ? widthPct : 36;
      setProjectViewState({ workSidebarWidthPct: Math.max(26, Math.min(55, safeWidth)) });
    },
    [setProjectViewState],
  );

  const setQ = useCallback(
    (search: string) => {
      setProjectViewState({ search });
    },
    [setProjectViewState],
  );

  const stripUrlFilterParams = useCallback(() => {
    if (!isWorkRoute) return;
    const nextParams = new URLSearchParams(searchParams);
    for (const key of ["laneId", "lane", "status"]) {
      nextParams.delete(key);
    }
    // Use URLSearchParams.toString() as the stable comparison anchor: if stripping
    // the filter keys yields the same query string, no-op. This makes the effect
    // self-stabilizing — even if `searchParams` re-references on every render,
    // navigate() only fires when there's an actual URL change.
    const currentSearch = searchParams.toString();
    const nextSearch = nextParams.toString();
    if (currentSearch === nextSearch) return;
    navigate(
      `${location.pathname}${nextSearch ? `?${nextSearch}` : ""}${location.hash ?? ""}`,
      { replace: true },
    );
  }, [isWorkRoute, location.hash, location.pathname, navigate, searchParams]);

  const setSelectedSessionId = useCallback(
    (sessionId: string | null) => {
      selectLaneForActiveTab(sessionId);
      setProjectViewState((prev) => {
        const nextOpen =
          sessionId && !prev.openItemIds.includes(sessionId)
            ? [...prev.openItemIds, sessionId]
            : prev.openItemIds;
        return {
          ...prev,
          openItemIds: nextOpen,
          selectedItemId: sessionId,
          activeItemId: sessionId ?? prev.activeItemId,
        };
      });
    },
    [selectLaneForActiveTab, setProjectViewState],
  );

  const setActiveItemId = useCallback(
    (sessionId: string | null) => {
      selectLaneForActiveTab(sessionId);
      setProjectViewState((prev) => {
        if (!sessionId) {
          return {
            ...prev,
            activeItemId: null,
            selectedItemId: null,
          };
        }
        const nextOpen = prev.openItemIds.includes(sessionId)
          ? prev.openItemIds
          : [...prev.openItemIds, sessionId];
        return {
          ...prev,
          openItemIds: nextOpen,
          activeItemId: sessionId,
          selectedItemId: sessionId,
        };
      });
    },
    [selectLaneForActiveTab, setProjectViewState],
  );

  const openSessionTab = useCallback(
    (sessionId: string) => {
      selectLaneForActiveTab(sessionId);
      setProjectViewState((prev) => {
        const nextOpen = prev.openItemIds.includes(sessionId)
          ? prev.openItemIds
          : [...prev.openItemIds, sessionId];
        return {
          ...prev,
          openItemIds: nextOpen,
          activeItemId: sessionId,
          selectedItemId: sessionId,
        };
      });
    },
    [selectLaneForActiveTab, setProjectViewState],
  );

  const closeTab = useCallback(
    (sessionId: string) => {
      setProjectViewState((prev) => {
        const idx = tabVisibleSessionIds.indexOf(sessionId);
        if (idx < 0) return prev;
        const nextOpen = prev.openItemIds.filter((id) => id !== sessionId);
        const nextRendered = tabVisibleSessionIds.filter((id) => id !== sessionId);
        const fallbackActive = nextRendered.length > 0
          ? nextRendered[Math.min(idx, nextRendered.length - 1)] ?? nextRendered[0] ?? null
          : null;
        const nextActive = prev.activeItemId === sessionId ? fallbackActive : prev.activeItemId;
        const nextSelected = prev.selectedItemId === sessionId ? nextActive : prev.selectedItemId;
        return {
          ...prev,
          openItemIds: nextOpen,
          activeItemId: nextActive,
          selectedItemId: nextSelected,
          draftKind: prev.draftKind,
        };
      });
    },
    [setProjectViewState, tabVisibleSessionIds],
  );

  const refresh = useCallback(async (options: { showLoading?: boolean; force?: boolean } = {}) => {
    const requestedProjectRoot = projectRootRef.current;
    if (!requestedProjectRoot) {
      setSessions([]);
      hasLoadedOnceRef.current = false;
      return;
    }
    const showLoading = options.showLoading ?? true;
    if (refreshInFlightRef.current) {
      if (refreshQueuedRef.current) {
        refreshQueuedRef.current.showLoading = refreshQueuedRef.current.showLoading || showLoading;
        refreshQueuedRef.current.force = refreshQueuedRef.current.force || Boolean(options.force);
        return refreshQueuedRef.current.deferred.promise;
      }
      let resolve!: () => void;
      let reject!: (reason: unknown) => void;
      const promise = new Promise<void>((nextResolve, nextReject) => {
        resolve = nextResolve;
        reject = nextReject;
      });
      refreshQueuedRef.current = {
        showLoading,
        force: Boolean(options.force),
        deferred: { promise, resolve, reject },
      };
      return promise;
    }
    refreshInFlightRef.current = true;
    if (showLoading) setLoading(true);
    try {
      const rows = (
        await listSessionsCached(
          { limit: 500 },
          options.force
            ? { force: true, projectRoot: requestedProjectRoot }
            : { projectRoot: requestedProjectRoot },
        )
      ).filter((session) => !isRunOwnedSession(session));
      if (projectRootRef.current !== requestedProjectRoot) {
        return;
      }
      const pending = pendingOptimisticSessionsRef.current;
      if (pending.size > 0) {
        const now = Date.now();
        const rowIndexById = new Map(rows.map((session, index) => [session.id, index] as const));
        for (const [sessionId, entry] of [...pending.entries()]) {
          const expired = now - entry.createdAtMs > OPTIMISTIC_PTY_SESSION_TTL_MS;
          const existingIndex = rowIndexById.get(sessionId);
          if (existingIndex != null) {
            const persisted = rows[existingIndex];
            if (expired || !persisted) {
              pending.delete(sessionId);
              continue;
            }
            const merged = mergePendingOptimisticSession(persisted, entry.session);
            rows[existingIndex] = merged.session;
            if (!merged.keepPending) pending.delete(sessionId);
            continue;
          }
          if (expired) {
            pending.delete(sessionId);
            continue;
          }
          rows.push(entry.session);
          rowIndexById.set(sessionId, rows.length - 1);
        }
        rows.sort(compareSessionsByStartedAtDesc);
      }
      setSessions(rows);
      hasLoadedOnceRef.current = true;
    } finally {
      if (showLoading) setLoading(false);
      refreshInFlightRef.current = false;
      const queued = refreshQueuedRef.current;
      refreshQueuedRef.current = null;
      if (queued) {
        void refresh({ showLoading: queued.showLoading, force: queued.force })
          .then(queued.deferred.resolve, queued.deferred.reject);
      }
    }
  }, []);

  const upsertOptimisticChatSession = useCallback((session: AgentChatSession) => {
    const laneName = lanes.find((lane) => lane.id === session.laneId)?.name ?? session.laneId;
    const optimistic = buildOptimisticChatSessionSummary({
      session,
      laneName,
    });
    setSessions((prev) => upsertSessionByStartedAt(prev, optimistic));
  }, [lanes]);

  // Used by the CLI continuation flow to flip a stopped session straight to
  // the freshly-resumed snapshot returned by pty.sendToSession, so the Work
  // view swaps the closed snapshot for the live TerminalView without
  // waiting for the next list refresh.
  const upsertSessionSnapshot = useCallback((session: TerminalSessionSummary) => {
    setSessions((prev) => upsertSessionByStartedAt(prev, session));
  }, []);

  const scheduleBackgroundRefresh = useCallback((delayMs = 450) => {
    if (!isWorkRoute) return;
    if (backgroundRefreshTimerRef.current != null) return;
    backgroundRefreshTimerRef.current = window.setTimeout(() => {
      backgroundRefreshTimerRef.current = null;
      void refresh({ showLoading: false });
    }, delayMs);
  }, [isWorkRoute, refresh]);

  useEffect(() => {
    // Apply the per-project sessions cache immediately so switching back to a
    // warm project does NOT blank the chat tabs / terminal grid. Without this
    // we wipe `sessions` to `[]`, which unmounts every chat and terminal pane
    // until the IPC refresh returns — that's the "page goes blank for a
    // couple seconds" the user sees. The underlying IPC cache
    // (sessionListCache) is already keyed per project, so DON'T invalidate it
    // either — leave each project's hot cache alone.
    const cachedSessions =
      (projectRoot ? (appStore.getState().sessionsCacheByProject[projectRoot] as TerminalSessionSummary[] | undefined) : undefined) ?? null;
    setSessions(cachedSessions ?? []);
    setLoading(false);
    if (refreshQueuedRef.current) {
      refreshQueuedRef.current.deferred.reject(new Error("projectRoot changed"));
      refreshQueuedRef.current = null;
    }
    // If we already have cached sessions, treat this as a "loaded" state so the
    // upcoming refresh runs silently in the background (no spinner).
    hasLoadedOnceRef.current = Boolean(cachedSessions && cachedSessions.length >= 0);
    hasRunningSessionsRef.current = (cachedSessions ?? []).some((s) => s.status === "running");
    laneRecoveryRefreshProjectRef.current = null;
    appliedQuerySessionIdRef.current = null;
    appliedUrlFilterKeyRef.current = null;
    partiallyAppliedUrlFilterKeyRef.current = null;
    pendingOptimisticSessionsRef.current.clear();
  }, [appStore, projectRoot]);

  // Mirror the locally-fetched sessions into the per-project cache in the
  // global store. The next time the user switches BACK to this project the
  // effect above can render these sessions instantly instead of blanking.
  useEffect(() => {
    if (!projectRoot) return;
    appStore.setState((prev) => ({
      sessionsCacheByProject: {
        ...prev.sessionsCacheByProject,
        [projectRoot]: sessions,
      },
    }));
  }, [appStore, sessions, projectRoot]);

  useEffect(() => {
    if (!projectRoot || !isWorkRoute) return;
    if (lanes.length > 0) {
      laneRecoveryRefreshProjectRef.current = null;
      return;
    }
    if (!hasLaneBackedSessions) return;
    if (laneRecoveryRefreshProjectRef.current === projectRoot) return;
    laneRecoveryRefreshProjectRef.current = projectRoot;
    void refreshLanes({
      includeStatus: false,
      includeSnapshots: false,
      includeConflictStatus: false,
      includeRebaseSuggestions: false,
      includeAutoRebaseStatus: false,
    }).catch(() => {});
  }, [hasLaneBackedSessions, isWorkRoute, lanes.length, projectRoot, refreshLanes]);

  useEffect(() => {
    if (!projectRoot || !isWorkRoute) return;
    const isInitialLoad = !hasLoadedOnceRef.current;
    refresh({ showLoading: isInitialLoad, force: isInitialLoad }).catch(() => {});
  }, [isWorkRoute, projectRoot, refresh]);

  useEffect(() => {
    if (isWorkRoute) return;
    if (backgroundRefreshTimerRef.current == null) return;
    window.clearTimeout(backgroundRefreshTimerRef.current);
    backgroundRefreshTimerRef.current = null;
  }, [isWorkRoute]);

  useEffect(() => {
    hasRunningSessionsRef.current = sessions.some((s) => s.status === "running");
  }, [sessions]);

  useEffect(() => {
    if (!isWorkRoute) return;
    const sessionParam = (searchParams.get("sessionId") ?? "").trim();
    const laneParam = (searchParams.get("laneId") ?? searchParams.get("lane") ?? "").trim();
    const statusParam = (searchParams.get("status") ?? "").trim();
    // When a sessionId is requested, only skip the lane/status fallback if
    // that session actually exists. If it's stale/missing (after the first
    // load completes) we fall through so the URL's laneId/status hints still
    // narrow the view instead of dumping the user into an unrelated context.
    if (sessionParam) {
      const sessionExists = sessions.some((s) => s.id === sessionParam);
      if (sessionExists) {
        appliedUrlFilterKeyRef.current = `${sessionParam}|${laneParam}|${statusParam}`;
        partiallyAppliedUrlFilterKeyRef.current = null;
        stripUrlFilterParams();
        return;
      }
      if (!hasLoadedOnceRef.current) return;
    }
    // Apply URL-derived filters at most once per URL signature so later
    // session-list refreshes (which add sessions to our deps) don't stomp
    // on a user's manually-changed lane/status filters.
    const urlKey = `${sessionParam}|${laneParam}|${statusParam}`;
    if (appliedUrlFilterKeyRef.current === urlKey) {
      stripUrlFilterParams();
      return;
    }
    const laneExists = laneParam && lanes.some((lane) => lane.id === laneParam);
    const status = mapUrlStatusFilter(statusParam);
    if (!laneExists && !status) {
      appliedUrlFilterKeyRef.current = null;
      partiallyAppliedUrlFilterKeyRef.current = null;
      if (laneParam || statusParam) stripUrlFilterParams();
      return;
    }
    // When the URL specifies a laneId but lanes haven't populated yet (e.g. on
    // project open/switch the store resets lanes to [] then repopulates async),
    // we can't tell whether the lane is missing-for-good or just-not-yet-loaded.
    // In that case, apply any status hint but don't cache the URL signature —
    // come back once lanes populate so the lane portion can apply too. We only
    // mark the key applied when the lane portion was definitively applied, or
    // when lanes are loaded (non-empty) so "not found" is an authoritative
    // negative signal.
    const laneDeterminable = !laneParam || laneExists || lanes.length > 0;
    const wasPartiallyApplied = partiallyAppliedUrlFilterKeyRef.current === urlKey;
    if (!laneDeterminable && wasPartiallyApplied) return;
    if (laneDeterminable) {
      appliedUrlFilterKeyRef.current = urlKey;
      partiallyAppliedUrlFilterKeyRef.current = null;
    } else {
      partiallyAppliedUrlFilterKeyRef.current = urlKey;
    }
    setProjectViewState((prev) => ({
      ...prev,
      laneFilter: laneExists ? laneParam : prev.laneFilter,
      statusFilter: status && !wasPartiallyApplied ? status : prev.statusFilter,
    }));
    if (laneDeterminable) stripUrlFilterParams();
  }, [isWorkRoute, lanes, searchParams, sessions, setProjectViewState, stripUrlFilterParams]);

  // Migrate legacy org modes to supported modes
  useEffect(() => {
    if (
      sessionListOrganization !== "all-lanes-by-status" &&
      sessionListOrganization !== "by-lane" &&
      sessionListOrganization !== "by-time"
    ) {
      setProjectViewState({ sessionListOrganization: "by-lane" });
    }
  }, [sessionListOrganization, setProjectViewState]);

  // Reset stale lane filter when the selected lane no longer exists
  useEffect(() => {
    if (filterLaneId === "all" || lanes.length === 0) return;
    if (!lanes.some((l) => l.id === filterLaneId)) {
      setProjectViewState({ laneFilter: "all" });
    }
  }, [filterLaneId, lanes, setProjectViewState]);

  useEffect(() => {
    if (!isWorkRoute) return;
    const sessionParam = (searchParams.get("sessionId") ?? "").trim();
    if (!sessionParam) {
      appliedQuerySessionIdRef.current = null;
      return;
    }
    if (appliedQuerySessionIdRef.current === sessionParam) return;

    const session = sessions.find((entry) => entry.id === sessionParam);
    if (!session) return;

    appliedQuerySessionIdRef.current = sessionParam;
    selectLane(session.laneId);
    focusSession(session.id);
    setProjectViewState((prev) => {
      const nextOpen = prev.openItemIds.includes(session.id)
        ? prev.openItemIds
        : [...prev.openItemIds, session.id];
      if (
        arraysEqual(prev.openItemIds, nextOpen)
        && prev.activeItemId === session.id
        && prev.selectedItemId === session.id
      ) {
        return prev;
      }
      return {
        ...prev,
        openItemIds: nextOpen,
        activeItemId: session.id,
        selectedItemId: session.id,
      };
    });
  }, [focusSession, isWorkRoute, searchParams, selectLane, sessions, setProjectViewState]);

  useEffect(() => {
    if (!isWorkRoute) return;
    const unsubExit = window.ade.pty.onExit((event) => {
      const currentProjectRoot = projectRootRef.current;
      if (event.projectRoot && event.projectRoot !== currentProjectRoot) return;
      scheduleBackgroundRefresh(120);
    });
    const t = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (!hasRunningSessionsRef.current) return;
      scheduleBackgroundRefresh(180);
    }, 5_000);
    return () => {
      try {
        unsubExit();
      } catch {
        // ignore
      }
      clearInterval(t);
    };
  }, [isWorkRoute, scheduleBackgroundRefresh]);

  useEffect(() => {
    if (!isWorkRoute) return;
    const unsubscribe = window.ade.agentChat.onEvent((payload) => {
      if (document.visibilityState !== "visible") return;
      if (!shouldRefreshSessionListForChatEvent(payload)) return;
      invalidateSessionListCache();
      scheduleBackgroundRefresh(220);
    });
    return unsubscribe;
  }, [isWorkRoute, scheduleBackgroundRefresh]);

  useEffect(() => {
    if (!isWorkRoute) return;
    const unsubscribe = window.ade.sessions.onChanged(() => {
      if (document.visibilityState !== "visible") return;
      invalidateSessionListCache();
      scheduleBackgroundRefresh(80);
    });
    return unsubscribe;
  }, [isWorkRoute, scheduleBackgroundRefresh]);

  useEffect(() => {
    return () => {
      if (backgroundRefreshTimerRef.current != null) {
        window.clearTimeout(backgroundRefreshTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!isWorkRoute) return;
    const refreshVisibleWork = () => {
      if (document.visibilityState !== "visible") return;
      invalidateSessionListCache();
      scheduleBackgroundRefresh(120);
    };
    window.addEventListener("focus", refreshVisibleWork);
    document.addEventListener("visibilitychange", refreshVisibleWork);
    return () => {
      window.removeEventListener("focus", refreshVisibleWork);
      document.removeEventListener("visibilitychange", refreshVisibleWork);
    };
  }, [isWorkRoute, scheduleBackgroundRefresh]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return sessions.filter((session) => {
      if (filterLaneId !== "all" && session.laneId !== filterLaneId) return false;
      if (filterStatus !== "all") {
        const bucket = sessionStatusBucket({
          status: session.status,
          lastOutputPreview: session.lastOutputPreview,
          runtimeState: session.runtimeState,
          toolType: session.toolType,
        });
        if (bucket !== filterStatus) return false;
      }
      if (!needle) return true;

      if (needle.startsWith("lane:")) {
        const value = needle.slice(5).trim();
        return session.laneName.toLowerCase().includes(value);
      }
      if (needle.startsWith("type:")) {
        const value = needle.slice(5).trim();
        return (session.toolType ?? "").toLowerCase().includes(value);
      }
      if (needle.startsWith("tracked:")) {
        const value = needle.slice(8).trim();
        if (value === "yes" || value === "true") return session.tracked;
        if (value === "no" || value === "false") return !session.tracked;
        return true;
      }

      return (
        (session.goal ?? session.title).toLowerCase().includes(needle) ||
        session.laneName.toLowerCase().includes(needle) ||
        (session.toolType ?? "").toLowerCase().includes(needle) ||
        (session.lastOutputPreview ?? "").toLowerCase().includes(needle) ||
        (session.summary ?? "").toLowerCase().includes(needle) ||
        (session.resumeCommand ?? "").toLowerCase().includes(needle)
      );
    });
  }, [sessions, filterLaneId, filterStatus, q]);

  const { runningFiltered, awaitingInputFiltered, endedFiltered } = useMemo(() => {
    const running: TerminalSessionSummary[] = [];
    const awaiting: TerminalSessionSummary[] = [];
    const ended: TerminalSessionSummary[] = [];
    for (const session of filtered) {
      const bucket = sessionStatusBucket({
        status: session.status,
        lastOutputPreview: session.lastOutputPreview,
        runtimeState: session.runtimeState,
        toolType: session.toolType,
      });
      if (bucket === "running") running.push(session);
      else if (bucket === "awaiting-input") awaiting.push(session);
      else ended.push(session);
    }
    return { runningFiltered: running, awaitingInputFiltered: awaiting, endedFiltered: ended };
  }, [filtered]);

  const sessionsGroupedByLane = useMemo(() => {
    if (sessionListOrganization !== "by-lane") return null;
    const map = new Map<string, TerminalSessionSummary[]>();
    for (const s of filtered) {
      const list = map.get(s.laneId) ?? [];
      list.push(s);
      map.set(s.laneId, list);
    }
    return map;
  }, [sessionListOrganization, filtered]);

  const runningSessions = useMemo(
    () => sessions.filter((session) => session.status === "running"),
    [sessions],
  );

  const gridLayoutId = useMemo(
    () => `work:grid:tiling:v1:${projectRoot ?? "global"}`,
    [projectRoot],
  );

  const selectedSession = useMemo(
    () => (selectedSessionId ? sessions.find((session) => session.id === selectedSessionId) ?? null : null),
    [sessions, selectedSessionId],
  );

  useEffect(() => {
    if (!projectRoot) return;
    // Don't prune open tabs until sessions have been fetched at least once.
    // On remount, sessions starts as [] before the async fetch completes;
    // pruning against an empty set would wipe all persisted open tabs.
    if (!hasLoadedOnceRef.current) return;
    const validIds = new Set(sessions.map((session) => session.id));

    setProjectViewState((prev) => {
      const nextOpen = prev.openItemIds.filter((id) => validIds.has(id));
      const userIsViewingDraft = prev.activeItemId == null && prev.selectedItemId == null;
      const nextActive =
        userIsViewingDraft
          ? null
          : prev.activeItemId && validIds.has(prev.activeItemId) && nextOpen.includes(prev.activeItemId)
            ? prev.activeItemId
            : nextOpen[0] ?? null;
      const nextSelected =
        userIsViewingDraft
          ? null
          : prev.selectedItemId && validIds.has(prev.selectedItemId)
            ? prev.selectedItemId
            : nextActive;

      if (
        arraysEqual(prev.openItemIds, nextOpen) &&
        prev.activeItemId === nextActive &&
        prev.selectedItemId === nextSelected
      ) {
        return prev;
      }

      return {
        ...prev,
        openItemIds: nextOpen,
        activeItemId: nextActive,
        selectedItemId: nextSelected,
      };
    });
  }, [projectRoot, sessions, setProjectViewState]);

  const markPtyClosed = (ptyId: string) => {
    setSessions((prev) =>
      prev.map((session) =>
        session.ptyId === ptyId
          ? {
              ...session,
              ptyId: null,
              status: "disposed" as const,
              runtimeState: "killed" as const,
              endedAt: new Date().toISOString(),
              exitCode: null,
            }
          : session,
      ),
    );
  };

  const stopRuntime = useCallback(
    async (ptyId: string, sessionId?: string) => {
      setClosingPtyIds((prev) => {
        const next = new Set(prev);
        next.add(ptyId);
        return next;
      });
      markPtyClosed(ptyId);

      // Optimistically mark the session as disposed so the UI updates
      // immediately instead of waiting for a full session list refresh.
      if (sessionId) {
        setSessions((prev) =>
          prev.map((s) => (s.id === sessionId ? { ...s, status: "disposed" as const } : s)),
        );
      }

      try {
        await window.ade.pty.dispose({ ptyId, ...(sessionId ? { sessionId } : {}) });
      } finally {
        setClosingPtyIds((prev) => {
          const next = new Set(prev);
          next.delete(ptyId);
          return next;
        });
        // Reconcile with the real backend state in the background.
        scheduleBackgroundRefresh();
      }
    },
    [scheduleBackgroundRefresh],
  );

  const stopAllRuntimes = useCallback(async () => {
    const ptyIds = runningSessions.map((session) => session.ptyId).filter((id): id is string => Boolean(id));
    await Promise.allSettled([
      ...ptyIds.map((id) => stopRuntime(id)),
    ]);
  }, [runningSessions, stopRuntime]);

  const launchPtySession = useCallback(
    async (args: {
      laneId: string;
      profile: LaunchProfile;
      tracked?: boolean;
      title?: string;
      startupCommand?: string;
      startupDelayMs?: number;
      command?: string;
      args?: string[];
      env?: Record<string, string>;
    }) => {
      // resolveLaunchFields preserves caller intent: any caller-supplied
      // startupCommand/command/args is used as-is, never mixed with defaults
      // from the other fields. Only when the caller passes none of them do
      // we substitute the profile's default launch.
      const launchFields = resolveLaunchFields({
        profile: args.profile,
        ...(args.startupCommand !== undefined ? { startupCommand: args.startupCommand } : {}),
        ...(args.command !== undefined ? { command: args.command } : {}),
        ...(args.args !== undefined ? { args: args.args } : {}),
        ...(args.env !== undefined ? { env: args.env } : {}),
      });
      const result = await window.ade.pty.create({
        laneId: args.laneId,
        cols: 100,
        rows: 30,
        title: args.title ?? LAUNCH_PROFILE_TITLE[args.profile],
        tracked: args.tracked ?? true,
        toolType: LAUNCH_PROFILE_TOOL_TYPE[args.profile],
        ...(args.startupDelayMs !== undefined ? { startupDelayMs: args.startupDelayMs } : {}),
        ...launchFields,
      });
      const startedAt = new Date().toISOString();
      const optimisticSession: TerminalSessionSummary = {
        id: result.sessionId,
        laneId: args.laneId,
        laneName: lanes.find((lane) => lane.id === args.laneId)?.name ?? args.laneId,
        ptyId: result.ptyId,
        tracked: args.tracked ?? true,
        pinned: false,
        manuallyNamed: false,
        goal: null,
        toolType: LAUNCH_PROFILE_TOOL_TYPE[args.profile],
        title: args.title ?? LAUNCH_PROFILE_TITLE[args.profile],
        status: "running",
        startedAt,
        endedAt: null,
        archivedAt: null,
        exitCode: null,
        transcriptPath: "",
        headShaStart: null,
        headShaEnd: null,
        lastOutputPreview: null,
        summary: null,
        runtimeState: "running",
        resumeCommand: null,
        resumeMetadata: null,
        chatSessionId: null,
      };
      pendingOptimisticSessionsRef.current.set(result.sessionId, {
        session: optimisticSession,
        createdAtMs: Date.now(),
      });
      setSessions((prev) => upsertSessionByStartedAt(prev, optimisticSession));
      selectLane(args.laneId);
      // Invalidate all cache entries so other views (e.g. Lanes tab) pick up
      // the new session on their next refresh.
      invalidateSessionListCache();
      focusSession(result.sessionId);
      openSessionTab(result.sessionId);
      // Reconcile with persisted backend state in the background. The
      // optimistic row already has the returned pty/session ids, so opening it
      // immediately lets TerminalView subscribe before fast TUIs draw their
      // initial frame.
      void refresh({ showLoading: false, force: true }).catch(() => {});
      return result;
    },
    [focusSession, lanes, openSessionTab, refresh, selectLane],
  );

  const removeSessionFromList = useCallback((sessionId: string) => {
    setSessions((prev) => prev.filter((session) => session.id !== sessionId));
  }, []);

  return {
    sessions,
    lanes,
    filtered,
    runningFiltered,
    awaitingInputFiltered,
    endedFiltered,
    runningSessions,
    visibleSessions,
    gridLayoutId,
    selectedSession,
    loading,

    filterLaneId,
    setFilterLaneId,
    filterStatus,
    setFilterStatus,
    q,
    setQ,

    sessionListOrganization,
    setSessionListOrganization,
    workCollapsedLaneIds,
    toggleWorkLaneCollapsed,
    workCollapsedTabGroupIds,
    toggleWorkTabGroupCollapsed,
    workCollapsedSectionIds,
    toggleWorkSectionCollapsed,
    sessionsGroupedByLane,
    tabGroups: tabGroupModel.groups,
    tabVisibleSessionIds,
    laneSessionOrder,
    pinnedSessionIds,
    reorderLaneSessions,
    togglePinnedSession,

    workFocusSessionsHidden,
    setWorkFocusSessionsHidden,
    workSidebarOpen,
    setWorkSidebarOpen,
    workSidebarTab,
    setWorkSidebarTab,
    workSidebarWidthPct,
    setWorkSidebarWidthPct,

    selectedSessionId,
    setSelectedSessionId,

    openItemIds,
    activeItemId,
    setActiveItemId,
    viewMode,
    setViewMode,
    draftKind,
    draftLaneId,
    setDraftLaneId,
    showDraftKind,
    openSessionTab,
    closeTab,

    closingPtyIds,
    refresh,
    upsertOptimisticChatSession,
    upsertSessionSnapshot,
    removeSessionFromList,
    stopRuntime,
    stopAllRuntimes,
    launchPtySession,

    navigate,
    selectLane,
    focusSession,
  };
}
