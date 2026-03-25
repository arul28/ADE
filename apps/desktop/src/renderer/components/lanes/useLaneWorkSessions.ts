import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TerminalSessionSummary } from "../../../shared/types";
import { useAppStore, type WorkDraftKind, type WorkProjectViewState, type WorkViewMode } from "../../state/appStore";
import { listSessionsCached } from "../../lib/sessionListCache";
import { sessionStatusBucket } from "../../lib/terminalAttention";
import { shouldRefreshSessionListForChatEvent } from "../../lib/chatSessionEvents";
import { isRunOwnedSession } from "../../lib/sessions";

const DEFAULT_LANE_WORK_STATE: WorkProjectViewState = {
  openItemIds: [],
  activeItemId: null,
  selectedItemId: null,
  viewMode: "tabs",
  draftKind: "chat",
  laneFilter: "all",
  statusFilter: "all",
  search: "",
};

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function isActiveSession(session: TerminalSessionSummary): boolean {
  return sessionStatusBucket({
    status: session.status,
    lastOutputPreview: session.lastOutputPreview,
    runtimeState: session.runtimeState,
  }) !== "ended";
}

export function useLaneWorkSessions(laneId: string | null) {
  const projectRoot = useAppStore((state) => state.project?.rootPath ?? null);
  const lanes = useAppStore((state) => state.lanes);
  const focusSession = useAppStore((state) => state.focusSession);
  const focusedSessionId = useAppStore((state) => state.focusedSessionId);
  const selectLane = useAppStore((state) => state.selectLane);
  const laneWorkViewByScope = useAppStore((state) => state.laneWorkViewByScope);
  const setLaneWorkViewState = useAppStore((state) => state.setLaneWorkViewState);

  const [sessions, setSessions] = useState<TerminalSessionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [closingPtyIds, setClosingPtyIds] = useState<Set<string>>(new Set());
  const refreshInFlightRef = useRef(false);
  const refreshQueuedRef = useRef<{ showLoading: boolean; force: boolean } | null>(null);
  const backgroundRefreshTimerRef = useRef<number | null>(null);
  const hasActiveSessionsRef = useRef(false);
  const hasLoadedOnceRef = useRef(false);

  const currentLane = useMemo(
    () => (laneId ? lanes.find((lane) => lane.id === laneId) ?? null : null),
    [laneId, lanes],
  );

  const scopeKey = useMemo(() => {
    const normalizedProjectRoot = projectRoot?.trim() ?? "";
    if (!normalizedProjectRoot || !laneId) return "";
    return `${normalizedProjectRoot}::${laneId}`;
  }, [projectRoot, laneId]);

  const hasStoredState = scopeKey.length > 0 && scopeKey in laneWorkViewByScope;
  const laneViewState = scopeKey
    ? laneWorkViewByScope[scopeKey] ?? DEFAULT_LANE_WORK_STATE
    : DEFAULT_LANE_WORK_STATE;

  const setViewState = useCallback(
    (
      next:
        | Partial<WorkProjectViewState>
        | ((prev: WorkProjectViewState) => WorkProjectViewState),
    ) => {
      if (!laneId) return;
      setLaneWorkViewState(projectRoot, laneId, next);
    },
    [laneId, projectRoot, setLaneWorkViewState],
  );

  const refresh = useCallback(
    async (options: { showLoading?: boolean; force?: boolean } = {}) => {
      if (!laneId) {
        setSessions([]);
        hasLoadedOnceRef.current = true;
        return;
      }
      const showLoading = options.showLoading ?? true;
      if (refreshInFlightRef.current) {
        refreshQueuedRef.current = {
          showLoading: (refreshQueuedRef.current?.showLoading ?? false) || showLoading,
          force: (refreshQueuedRef.current?.force ?? false) || Boolean(options.force),
        };
        return;
      }
      refreshInFlightRef.current = true;
      if (showLoading) setLoading(true);
      try {
        const rows = await listSessionsCached(
          { laneId, limit: 200 },
          options.force ? { force: true } : undefined,
        );
        setSessions(rows.filter((session) => !isRunOwnedSession(session)));
        hasLoadedOnceRef.current = true;
      } catch (err) {
        console.warn("[useLaneWorkSessions] Failed to refresh sessions:", err);
      } finally {
        if (showLoading) setLoading(false);
        refreshInFlightRef.current = false;
        const queued = refreshQueuedRef.current;
        refreshQueuedRef.current = null;
        if (queued) {
          void refresh(queued);
        }
      }
    },
    [laneId],
  );

  const scheduleBackgroundRefresh = useCallback((delayMs = 300) => {
    if (backgroundRefreshTimerRef.current != null) return;
    backgroundRefreshTimerRef.current = window.setTimeout(() => {
      backgroundRefreshTimerRef.current = null;
      void refresh({ showLoading: false });
    }, delayMs);
  }, [refresh]);

  useEffect(() => {
    setSessions([]);
    hasLoadedOnceRef.current = false;
    if (!laneId) return;
    void refresh({ showLoading: true, force: true });
  }, [laneId, refresh]);

  useEffect(() => {
    return () => {
      if (backgroundRefreshTimerRef.current != null) {
        window.clearTimeout(backgroundRefreshTimerRef.current);
        backgroundRefreshTimerRef.current = null;
      }
    };
  }, [laneId]);

  useEffect(() => {
    const unsubscribe = window.ade.pty.onExit(() => {
      if (!laneId) return;
      scheduleBackgroundRefresh(120);
    });
    return () => {
      try {
        unsubscribe();
      } catch {
        // ignore
      }
    };
  }, [laneId, scheduleBackgroundRefresh]);

  useEffect(() => {
    const unsubscribe = window.ade.agentChat.onEvent((payload) => {
      if (!laneId) return;
      if (!shouldRefreshSessionListForChatEvent(payload)) return;
      scheduleBackgroundRefresh(180);
    });
    return unsubscribe;
  }, [laneId, scheduleBackgroundRefresh]);

  const activeSessions = useMemo(
    () => sessions.filter((session) => isActiveSession(session)),
    [sessions],
  );

  useEffect(() => {
    hasActiveSessionsRef.current = activeSessions.length > 0;
  }, [activeSessions.length]);

  useEffect(() => {
    if (!laneId) return;
    const intervalId = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (!hasActiveSessionsRef.current) return;
      scheduleBackgroundRefresh(160);
    }, 5_000);
    return () => window.clearInterval(intervalId);
  }, [laneId, scheduleBackgroundRefresh]);

  const sessionsById = useMemo(() => {
    const map = new Map<string, TerminalSessionSummary>();
    for (const session of sessions) map.set(session.id, session);
    return map;
  }, [sessions]);

  const visibleSessions = useMemo(() => {
    return laneViewState.openItemIds
      .map((sessionId) => sessionsById.get(sessionId))
      .filter((session): session is TerminalSessionSummary => session != null);
  }, [laneViewState.openItemIds, sessionsById]);

  useEffect(() => {
    if (!hasLoadedOnceRef.current) return;
    const validIds = new Set(sessions.map((session) => session.id));
    setViewState((prev) => {
      const nextOpen = prev.openItemIds.filter((sessionId) => validIds.has(sessionId));
      const userIsViewingDraft = prev.activeItemId == null && prev.selectedItemId == null;

      let nextActive: string | null = null;
      if (!userIsViewingDraft) {
        const activeStillValid = prev.activeItemId && validIds.has(prev.activeItemId) && nextOpen.includes(prev.activeItemId);
        nextActive = activeStillValid ? prev.activeItemId : nextOpen[0] ?? null;
      }

      let nextSelected: string | null = null;
      if (!userIsViewingDraft) {
        const selectedStillValid = prev.selectedItemId && validIds.has(prev.selectedItemId);
        nextSelected = selectedStillValid ? prev.selectedItemId : nextActive;
      }

      if (
        arraysEqual(prev.openItemIds, nextOpen)
        && prev.activeItemId === nextActive
        && prev.selectedItemId === nextSelected
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
  }, [sessions, setViewState]);

  useEffect(() => {
    if (!laneId || hasStoredState || sessions.length === 0) return;
    setViewState((prev) => {
      if (prev.openItemIds.length > 0 || prev.activeItemId != null || prev.selectedItemId != null) {
        return prev;
      }
      const preferredSessions = activeSessions.length > 0 ? activeSessions : sessions.slice(0, 1);
      const nextOpen = preferredSessions.map((session) => session.id);
      const preferredActive = focusedSessionId && nextOpen.includes(focusedSessionId)
        ? focusedSessionId
        : nextOpen[0] ?? null;
      return {
        ...prev,
        openItemIds: nextOpen,
        activeItemId: preferredActive,
        selectedItemId: preferredActive,
      };
    });
  }, [activeSessions, focusedSessionId, hasStoredState, laneId, sessions, setViewState]);

  const openSessionTab = useCallback((sessionId: string) => {
    setViewState((prev) => {
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
  }, [setViewState]);

  useEffect(() => {
    if (!laneId || !focusedSessionId) return;
    const session = sessionsById.get(focusedSessionId);
    if (!session) return;
    openSessionTab(session.id);
  }, [focusedSessionId, laneId, openSessionTab, sessionsById]);

  const setViewMode = useCallback((nextMode: WorkViewMode) => {
    setViewState({ viewMode: nextMode });
  }, [setViewState]);

  const showDraftKind = useCallback((nextKind: WorkDraftKind) => {
    setViewState((prev) => ({
      ...prev,
      draftKind: nextKind,
      viewMode: "tabs",
      activeItemId: null,
      selectedItemId: null,
    }));
  }, [setViewState]);

  const setActiveItemId = useCallback((sessionId: string | null) => {
    setViewState((prev) => {
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
  }, [setViewState]);

  const closeTab = useCallback((sessionId: string) => {
    setViewState((prev) => {
      const currentIndex = prev.openItemIds.indexOf(sessionId);
      if (currentIndex < 0) return prev;
      const nextOpen = prev.openItemIds.filter((id) => id !== sessionId);
      const fallbackActive =
        nextOpen.length > 0
          ? nextOpen[Math.min(currentIndex, nextOpen.length - 1)] ?? nextOpen[0] ?? null
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
  }, [setViewState]);

  const launchPtySession = useCallback(
    async (args: {
      laneId: string;
      profile: "claude" | "codex" | "shell";
      tracked?: boolean;
      title?: string;
      startupCommand?: string;
    }) => {
      const titleMap = { claude: "Claude Code", codex: "Codex", shell: "Shell" } as const;
      const commandMap = { claude: "claude", codex: "codex", shell: "" } as const;
      const result = await window.ade.pty.create({
        laneId: args.laneId,
        cols: 100,
        rows: 30,
        title: args.title ?? titleMap[args.profile],
        tracked: args.tracked ?? true,
        toolType: args.profile,
        startupCommand: args.startupCommand ?? commandMap[args.profile] ?? undefined,
      });
      selectLane(args.laneId);
      focusSession(result.sessionId);
      openSessionTab(result.sessionId);
      await refresh({ showLoading: false, force: true });
      return result;
    },
    [focusSession, openSessionTab, refresh, selectLane],
  );

  const handleOpenChatSession = useCallback(async (sessionId: string) => {
    if (!laneId) return;
    selectLane(laneId);
    focusSession(sessionId);
    openSessionTab(sessionId);
    await refresh({ showLoading: false, force: true });
  }, [focusSession, laneId, openSessionTab, refresh, selectLane]);

  const closePtySession = useCallback(async (ptyId: string) => {
    setClosingPtyIds((prev) => {
      const next = new Set(prev);
      next.add(ptyId);
      return next;
    });
    try {
      await window.ade.pty.dispose({ ptyId });
    } finally {
      setClosingPtyIds((prev) => {
        const next = new Set(prev);
        next.delete(ptyId);
        return next;
      });
      await refresh({ showLoading: false, force: true });
    }
  }, [refresh]);

  return {
    lane: currentLane,
    loading,
    sessions,
    visibleSessions,
    activeItemId: laneViewState.activeItemId,
    viewMode: laneViewState.viewMode,
    draftKind: laneViewState.draftKind,
    setViewMode,
    showDraftKind,
    setActiveItemId,
    closeTab,
    launchPtySession,
    handleOpenChatSession,
    closingPtyIds,
    closePtySession,
  };
}
