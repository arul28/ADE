import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { TerminalSessionSummary, TerminalToolType } from "../../../shared/types";
import { useAppStore, type WorkDraftKind, type WorkProjectViewState, type WorkStatusFilter, type WorkViewMode } from "../../state/appStore";
import { listSessionsCached } from "../../lib/sessionListCache";
import { sessionMatchesStatusFilter, sessionStatusBucket } from "../../lib/terminalAttention";
import { isChatToolType } from "../../lib/sessions";

const DEFAULT_PROJECT_WORK_STATE: WorkProjectViewState = {
  openItemIds: [],
  activeItemId: null,
  selectedItemId: null,
  viewMode: "tabs",
  draftKind: "chat",
  laneFilter: "all",
  statusFilter: "all",
  search: "",
};

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
  const refreshQueuedRef = useRef(false);
  const hasRunningSessionsRef = useRef(false);
  const backgroundRefreshTimerRef = useRef<number | null>(null);
  const appliedQuerySessionIdRef = useRef<string | null>(null);
  const hasLoadedOnceRef = useRef(false);

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
        const idx = prev.openItemIds.indexOf(sessionId);
        if (idx < 0) return prev;
        const nextOpen = prev.openItemIds.filter((id) => id !== sessionId);
        const fallbackActive =
          nextOpen.length > 0
            ? nextOpen[Math.min(idx, nextOpen.length - 1)] ?? nextOpen[0] ?? null
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
    [setProjectViewState],
  );

  const refresh = useCallback(async (options: { showLoading?: boolean } = {}) => {
    const showLoading = options.showLoading ?? true;
    if (refreshInFlightRef.current) {
      refreshQueuedRef.current = true;
      return;
    }
    refreshInFlightRef.current = true;
    if (showLoading) setLoading(true);
    try {
      const rows = await listSessionsCached({ limit: 500 });
      setSessions(rows);
      hasLoadedOnceRef.current = true;
    } finally {
      if (showLoading) setLoading(false);
      refreshInFlightRef.current = false;
      if (refreshQueuedRef.current) {
        refreshQueuedRef.current = false;
        void refresh({ showLoading: false });
      }
    }
  }, []);

  const scheduleBackgroundRefresh = useCallback((delayMs = 450) => {
    if (backgroundRefreshTimerRef.current != null) return;
    backgroundRefreshTimerRef.current = window.setTimeout(() => {
      backgroundRefreshTimerRef.current = null;
      void refresh({ showLoading: false });
    }, delayMs);
  }, [refresh]);

  useEffect(() => {
    refresh({ showLoading: true }).catch(() => {});
  }, [refresh]);

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
    const unsubExit = window.ade.pty.onExit(() => {
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
      const event = payload.event;
      if (event.type === "done") scheduleBackgroundRefresh(200);
      if (event.type === "status" && event.turnStatus !== "started") scheduleBackgroundRefresh(200);
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

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return sessions.filter((session) => {
      if (filterLaneId !== "all" && session.laneId !== filterLaneId) return false;
      if (
        !sessionMatchesStatusFilter(
          {
            status: session.status,
            lastOutputPreview: session.lastOutputPreview,
            runtimeState: session.runtimeState,
          },
          filterStatus,
        )
      ) {
        return false;
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

  const runningFiltered = useMemo(
    () =>
      filtered.filter(
        (session) =>
          sessionStatusBucket({
            status: session.status,
            lastOutputPreview: session.lastOutputPreview,
            runtimeState: session.runtimeState,
          }) === "running",
      ),
    [filtered],
  );

  const awaitingInputFiltered = useMemo(
    () =>
      filtered.filter(
        (session) =>
          sessionStatusBucket({
            status: session.status,
            lastOutputPreview: session.lastOutputPreview,
            runtimeState: session.runtimeState,
          }) === "awaiting-input",
      ),
    [filtered],
  );

  const endedFiltered = useMemo(
    () =>
      filtered.filter(
        (session) =>
          sessionStatusBucket({
            status: session.status,
            lastOutputPreview: session.lastOutputPreview,
            runtimeState: session.runtimeState,
          }) === "ended",
      ),
    [filtered],
  );

  const runningSessions = useMemo(
    () => sessions.filter((session) => session.status === "running"),
    [sessions],
  );

  const sessionsById = useMemo(() => {
    const map = new Map<string, TerminalSessionSummary>();
    for (const session of sessions) map.set(session.id, session);
    return map;
  }, [sessions]);

  const visibleSessions = useMemo(() => {
    return openItemIds
      .map((id) => sessionsById.get(id))
      .filter((session): session is TerminalSessionSummary => session != null);
  }, [openItemIds, sessionsById]);

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
    async (ptyId: string) => {
      setClosingPtyIds((prev) => {
        const next = new Set(prev);
        next.add(ptyId);
        return next;
      });
      markPtyClosed(ptyId);
      try {
        await window.ade.pty.dispose({ ptyId });
      } finally {
        setClosingPtyIds((prev) => {
          const next = new Set(prev);
          next.delete(ptyId);
          return next;
        });
        await refresh();
      }
    },
    [refresh],
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
      const command = (session.resumeCommand ?? "").trim();
      if (!command || resumingSessionId) return;
      setResumingSessionId(session.id);
      try {
        const toolType = (session.toolType ?? inferToolFromResumeCommand(command) ?? null) as TerminalToolType | null;
        const started = await window.ade.pty.create({
          laneId: session.laneId,
          cols: 100,
          rows: 30,
          title: session.goal?.trim() || session.title || "Terminal",
          tracked: session.tracked,
          toolType,
          startupCommand: command,
        });
        selectLane(session.laneId);
        focusSession(started.sessionId);
        setActiveItemId(started.sessionId);
        navigate(`/lanes?laneId=${encodeURIComponent(session.laneId)}&sessionId=${encodeURIComponent(started.sessionId)}`);
      } finally {
        setResumingSessionId(null);
      }
    },
    [focusSession, navigate, refresh, resumingSessionId, selectLane, setActiveItemId],
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
      const commandMap = { claude: "claude", codex: "codex", shell: "" };
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
      focusSession(result.sessionId);
      openSessionTab(result.sessionId);
      await refresh();
      return result;
    },
    [focusSession, openSessionTab, refresh, selectLane],
  );

  return {
    sessions,
    lanes,
    filtered,
    runningFiltered,
    awaitingInputFiltered,
    endedFiltered,
    runningSessions,
    visibleSessions,
    selectedSession,
    loading,

    filterLaneId,
    setFilterLaneId,
    filterStatus,
    setFilterStatus,
    q,
    setQ,

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
