import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { AgentChatSession, LaneSummary, TerminalSessionSummary, TerminalToolType } from "../../../shared/types";
import {
  useAppStore,
  type WorkDraftKind,
  type WorkProjectViewState,
  type WorkSessionListOrganization,
  type WorkStatusFilter,
  type WorkViewMode,
} from "../../state/appStore";
import { listSessionsCached, invalidateSessionListCache } from "../../lib/sessionListCache";
import { sessionStatusBucket } from "../../lib/terminalAttention";
import { buildOptimisticChatSessionSummary, isChatToolType, isRunOwnedSession } from "../../lib/sessions";
import { shouldRefreshSessionListForChatEvent } from "../../lib/chatSessionEvents";
import {
  defaultTrackedCliStartupCommand,
  resolveTrackedCliResumeCommand,
  withCodexNoAltScreen,
} from "./cliLaunch";
import { sortLanesForTabs } from "../lanes/laneUtils";

const DEFAULT_PROJECT_WORK_STATE: WorkProjectViewState = {
  openItemIds: [],
  activeItemId: null,
  selectedItemId: null,
  viewMode: "tabs",
  draftKind: "chat",
  laneFilter: "all",
  statusFilter: "all",
  search: "",
  sessionListOrganization: "by-lane",
  workCollapsedLaneIds: [],
  workCollapsedSectionIds: [],
  workCollapsedTabGroupIds: [],
  workFocusSessionsHidden: false,
};

type WorkTabGroupKind = "lane" | "status" | "time";
type WorkTabGroupLane = Pick<LaneSummary, "id" | "name" | "laneType" | "createdAt">;

export type WorkTabGroup = {
  id: string;
  label: string;
  kind: WorkTabGroupKind;
  collapsed: boolean;
  sessionIds: string[];
  sessions: TerminalSessionSummary[];
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

function getTabGroupId(
  organization: WorkSessionListOrganization,
  session: TerminalSessionSummary,
  lanes: WorkTabGroupLane[],
): { id: string; label: string; kind: WorkTabGroupKind } {
  if (organization === "by-lane") {
    const lane = lanes.find((entry) => entry.id === session.laneId);
    return {
      id: `lane:${session.laneId}`,
      label: lane?.name ?? session.laneName,
      kind: "lane",
    };
  }
  if (organization === "by-time") {
    const bucket = bucketByTime(session);
    return {
      id: `time:${bucket}`,
      label: bucket === "today" ? "Today" : bucket === "yesterday" ? "Yesterday" : "Older",
      kind: "time",
    };
  }

  const bucket = sessionStatusBucket({
    status: session.status,
    lastOutputPreview: session.lastOutputPreview,
    runtimeState: session.runtimeState,
    toolType: session.toolType,
  });
  return {
    id: `status:${bucket}`,
    label: getStatusBucketLabel(bucket),
    kind: "status",
  };
}

export function buildWorkTabGroupModel(args: {
  sessions: TerminalSessionSummary[];
  lanes: WorkTabGroupLane[];
  organization: WorkSessionListOrganization;
  collapsedGroupIds: string[];
}): WorkTabGroupModel {
  const orderedSessions = [...args.sessions].sort((left, right) => (
    new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime()
  ));
  const collapseSet = new Set(args.collapsedGroupIds);

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
      const collapsed = collapseSet.has(group.id);
      if (!collapsed) visibleSessions.push(...group.sessions);
      return {
        id: group.id,
        label: group.label,
        kind: group.kind,
        collapsed,
        sessionIds: group.sessions.map((session) => session.id),
        sessions: group.sessions,
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
        collapsed,
        sessionIds: sessions.map((session) => session.id),
        sessions,
      } satisfies WorkTabGroup;
    });

  return { groups, sessionIds: visibleSessions.map((session) => session.id), visibleSessions };
}

function inferToolFromResumeCommand(command: string): string | null {
  const n = command.trim().toLowerCase();
  if (n.startsWith("claude ")) return "claude";
  if (n.startsWith("codex ")) return "codex";
  return null;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
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

export function useWorkSessions() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const projectRoot = useAppStore((s) => s.project?.rootPath ?? null);
  const lanes = useAppStore((s) => s.lanes);
  const focusSession = useAppStore((s) => s.focusSession);
  const selectLane = useAppStore((s) => s.selectLane);
  const workViewByProject = useAppStore((s) => s.workViewByProject);
  const setWorkViewState = useAppStore((s) => s.setWorkViewState);

  const [sessions, setSessions] = useState<TerminalSessionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [closingPtyIds, setClosingPtyIds] = useState<Set<string>>(new Set());
  const [closingChatSessionId, setClosingChatSessionId] = useState<string | null>(null);
  const [resumingSessionId, setResumingSessionId] = useState<string | null>(null);
  const refreshInFlightRef = useRef(false);
  const refreshQueuedRef = useRef<QueuedRefresh | null>(null);
  const hasRunningSessionsRef = useRef(false);
  const backgroundRefreshTimerRef = useRef<number | null>(null);
  const appliedQuerySessionIdRef = useRef<string | null>(null);
  const hasLoadedOnceRef = useRef(false);
  const projectRootRef = useRef<string | null>(projectRoot);

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
  const filterLaneId = projectViewState.laneFilter;
  const filterStatus = projectViewState.statusFilter;
  const q = projectViewState.search;
  const sessionListOrganization: WorkSessionListOrganization =
    projectViewState.sessionListOrganization ?? "by-lane";
  const workCollapsedLaneIds = projectViewState.workCollapsedLaneIds ?? [];
  const workCollapsedTabGroupIds = projectViewState.workCollapsedTabGroupIds ?? [];
  const workCollapsedSectionIds = projectViewState.workCollapsedSectionIds ?? [];
  const workFocusSessionsHidden = projectViewState.workFocusSessionsHidden ?? false;
  const sessionsById = useMemo(() => {
    const map = new Map<string, TerminalSessionSummary>();
    for (const session of sessions) map.set(session.id, session);
    return map;
  }, [sessions]);

  const openSessions = useMemo(() => {
    return openItemIds
      .map((id) => sessionsById.get(id))
      .filter((session): session is TerminalSessionSummary => session != null);
  }, [openItemIds, sessionsById]);

  const tabGroupModel = useMemo(
    () => buildWorkTabGroupModel({
      sessions: openSessions,
      lanes,
      organization: sessionListOrganization,
      collapsedGroupIds: workCollapsedTabGroupIds,
    }),
    [lanes, openSessions, sessionListOrganization, workCollapsedTabGroupIds],
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

  const setWorkFocusSessionsHidden = useCallback(
    (hidden: boolean) => {
      setProjectViewState({ workFocusSessionsHidden: hidden });
    },
    [setProjectViewState],
  );

  const setQ = useCallback(
    (search: string) => {
      setProjectViewState({ search });
    },
    [setProjectViewState],
  );

  const setSelectedSessionId = useCallback(
    (sessionId: string | null) => {
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
    [setProjectViewState],
  );

  const setActiveItemId = useCallback(
    (sessionId: string | null) => {
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
    [setProjectViewState],
  );

  const openSessionTab = useCallback(
    (sessionId: string) => {
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
    [setProjectViewState],
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
          draftKind: nextOpen.length === 0 ? "chat" : prev.draftKind,
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
          options.force ? { force: true } : undefined,
        )
      ).filter((session) => !isRunOwnedSession(session));
      if (projectRootRef.current !== requestedProjectRoot) {
        return;
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
    setSessions((prev) => {
      const next = [optimistic, ...prev.filter((entry) => entry.id !== session.id)];
      next.sort((left, right) => (
        new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime()
      ));
      return next;
    });
  }, [lanes]);

  const scheduleBackgroundRefresh = useCallback((delayMs = 450) => {
    if (backgroundRefreshTimerRef.current != null) return;
    backgroundRefreshTimerRef.current = window.setTimeout(() => {
      backgroundRefreshTimerRef.current = null;
      void refresh({ showLoading: false });
    }, delayMs);
  }, [refresh]);

  useEffect(() => {
    invalidateSessionListCache();
    setSessions([]);
    setLoading(false);
    if (refreshQueuedRef.current) {
      refreshQueuedRef.current.deferred.reject(new Error("projectRoot changed"));
      refreshQueuedRef.current = null;
    }
    hasLoadedOnceRef.current = false;
    hasRunningSessionsRef.current = false;
    appliedQuerySessionIdRef.current = null;
    if (!projectRoot) return;
    refresh({ showLoading: true, force: true }).catch(() => {});
  }, [projectRoot, refresh]);

  useEffect(() => {
    hasRunningSessionsRef.current = sessions.some((s) => s.status === "running");
  }, [sessions]);

  useEffect(() => {
    const laneParam = (searchParams.get("laneId") ?? searchParams.get("lane") ?? "").trim();
    const laneExists = laneParam && lanes.some((lane) => lane.id === laneParam);
    const status = mapUrlStatusFilter(searchParams.get("status") ?? "");
    if (!laneExists && !status) return;
    setProjectViewState((prev) => ({
      ...prev,
      laneFilter: laneExists ? laneParam : prev.laneFilter,
      statusFilter: status ?? prev.statusFilter,
    }));
  }, [lanes, searchParams, setProjectViewState]);

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
  }, [focusSession, searchParams, selectLane, sessions, setProjectViewState]);

  useEffect(() => {
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
  }, [scheduleBackgroundRefresh]);

  useEffect(() => {
    const unsubscribe = window.ade.agentChat.onEvent((payload) => {
      if (document.visibilityState !== "visible") return;
      if (!shouldRefreshSessionListForChatEvent(payload)) return;
      invalidateSessionListCache();
      scheduleBackgroundRefresh(220);
    });
    return unsubscribe;
  }, [scheduleBackgroundRefresh]);

  useEffect(() => {
    const unsubscribe = window.ade.sessions.onChanged(() => {
      if (document.visibilityState !== "visible") return;
      invalidateSessionListCache();
      scheduleBackgroundRefresh(80);
    });
    return unsubscribe;
  }, [scheduleBackgroundRefresh]);

  useEffect(() => {
    return () => {
      if (backgroundRefreshTimerRef.current != null) {
        window.clearTimeout(backgroundRefreshTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
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
  }, [scheduleBackgroundRefresh]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return sessions.filter((session) => {
      if (filterLaneId !== "all" && session.laneId !== filterLaneId) return false;
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
  }, [sessions, filterLaneId, q]);

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
    () => `work:grid:v2:${projectRoot ?? "global"}`,
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

  const closeSession = useCallback(
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

  const resumeSession = useCallback(
    async (session: TerminalSessionSummary) => {
      if (isChatToolType(session.toolType)) {
        if (resumingSessionId) return;
        setResumingSessionId(session.id);
        try {
          await window.ade.agentChat.resume({ sessionId: session.id });
          selectLane(session.laneId);
          focusSession(session.id);
          setActiveItemId(session.id);
          await refresh();
        } finally {
          setResumingSessionId(null);
        }
        return;
      }
      const command = resolveTrackedCliResumeCommand(session);
      if (!command || resumingSessionId) return;
      setResumingSessionId(session.id);
      try {
        const toolType = (session.toolType ?? inferToolFromResumeCommand(command) ?? null) as TerminalToolType | null;
        const resumed = await window.ade.pty.create({
          sessionId: session.id,
          laneId: session.laneId,
          cols: 100,
          rows: 30,
          title: session.goal?.trim() || session.title || "Terminal",
          tracked: session.tracked,
          toolType,
          startupCommand: toolType === "codex" || toolType === "codex-orchestrated"
            ? withCodexNoAltScreen(command)
            : command,
        });
        invalidateSessionListCache();
        try {
          await refresh({ showLoading: false, force: true });
        } catch { /* best-effort after reattach */ }
        selectLane(session.laneId);
        focusSession(resumed.sessionId);
        setActiveItemId(resumed.sessionId);
      } finally {
        setResumingSessionId(null);
      }
    },
    [focusSession, refresh, resumingSessionId, selectLane, setActiveItemId],
  );

  const closeChatSession = useCallback(
    async (sessionId: string) => {
      setClosingChatSessionId(sessionId);
      try {
        await window.ade.agentChat.dispose({ sessionId });
        await refresh();
      } finally {
        setClosingChatSessionId((current) => (current === sessionId ? null : current));
      }
    },
    [refresh],
  );

  const closeAllRunning = useCallback(async () => {
    const ptyIds = runningSessions.map((session) => session.ptyId).filter((id): id is string => Boolean(id));
    const chatSessionIds = runningSessions
      .filter((session) => isChatToolType(session.toolType))
      .map((session) => session.id);
    await Promise.allSettled([
      ...ptyIds.map((id) => closeSession(id)),
      ...chatSessionIds.map((id) => closeChatSession(id)),
    ]);
  }, [runningSessions, closeSession, closeChatSession]);

  const launchPtySession = useCallback(
    async (args: {
      laneId: string;
      profile: "claude" | "codex" | "shell";
      tracked?: boolean;
      title?: string;
      startupCommand?: string;
    }) => {
      const toolTypeMap = {
        claude: "claude" as const,
        codex: "codex" as const,
        shell: "shell" as const,
      };
      const titleMap = { claude: "Claude Code", codex: "Codex", shell: "Shell" };
      const commandMap = {
        claude: defaultTrackedCliStartupCommand("claude"),
        codex: defaultTrackedCliStartupCommand("codex"),
        shell: "",
      };
      const result = await window.ade.pty.create({
        laneId: args.laneId,
        cols: 100,
        rows: 30,
        title: args.title ?? titleMap[args.profile],
        tracked: args.tracked ?? true,
        toolType: toolTypeMap[args.profile],
        startupCommand: args.startupCommand ?? commandMap[args.profile] ?? undefined,
      });
      selectLane(args.laneId);
      // Invalidate all cache entries so other views (e.g. Lanes tab) pick up
      // the new session on their next refresh.
      invalidateSessionListCache();
      // Refresh the session list before activating the tab so the new
      // session is in sessionsById when the UI resolves activeSession.
      try {
        await refresh({ force: true });
      } catch {
        // Best-effort: if refresh fails the session was still created,
        // so proceed to focus/open it.
      }
      focusSession(result.sessionId);
      openSessionTab(result.sessionId);
      return result;
    },
    [focusSession, openSessionTab, refresh, selectLane],
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

    workFocusSessionsHidden,
    setWorkFocusSessionsHidden,

    selectedSessionId,
    setSelectedSessionId,

    openItemIds,
    activeItemId,
    setActiveItemId,
    viewMode,
    setViewMode,
    draftKind,
    showDraftKind,
    openSessionTab,
    closeTab,

    closingPtyIds,
    closingChatSessionId,
    resumingSessionId,

    refresh,
    upsertOptimisticChatSession,
    removeSessionFromList,
    closeSession,
    closeAllRunning,
    resumeSession,
    closeChatSession,
    launchPtySession,

    navigate,
    selectLane,
    focusSession,
  };
}
