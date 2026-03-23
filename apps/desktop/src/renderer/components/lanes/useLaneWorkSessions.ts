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
  const refreshInFlightRef = useRef(false);
  const refreshQueuedRef = useRef(false);
  const backgroundRefreshTimerRef = useRef<number | null>(null);
  const hasActiveSessionsRef = useRef(false);

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
        return;
      }
      const showLoading = options.showLoading ?? true;
      if (refreshInFlightRef.current) {
        refreshQueuedRef.current = true;
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
      } finally {
        if (showLoading) setLoading(false);
        refreshInFlightRef.current = false;
        if (refreshQueuedRef.current) {
          refreshQueuedRef.current = false;
          void refresh({ showLoading: false });
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
    if (!laneId) return;
    void refresh({ showLoading: true, force: true });
  }, [laneId, refresh]);

  useEffect(() => {
    return () => {
      if (backgroundRefreshTimerRef.current != null) {
        window.clearTimeout(backgroundRefreshTimerRef.current);
      }
    };
  }, []);

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

  const activeSessionsById = useMemo(() => {
    const map = new Map<string, TerminalSessionSummary>();
    for (const session of activeSessions) map.set(session.id, session);
    return map;
  }, [activeSessions]);

  const visibleSessions = useMemo(() => {
    return laneViewState.openItemIds
      .map((sessionId) => activeSessionsById.get(sessionId))
      .filter((session): session is TerminalSessionSummary => session != null);
  }, [activeSessionsById, laneViewState.openItemIds]);

  useEffect(() => {
    const validIds = new Set(activeSessions.map((session) => session.id));
    setViewState((prev) => {
      const nextOpen = prev.openItemIds.filter((sessionId) => validIds.has(sessionId));
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
  }, [activeSessions, setViewState]);

  useEffect(() => {
    if (!laneId || hasStoredState || activeSessions.length === 0) return;
    setViewState((prev) => {
      if (prev.openItemIds.length > 0 || prev.activeItemId != null || prev.selectedItemId != null) {
        return prev;
      }
      const nextOpen = activeSessions.map((session) => session.id);
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
  }, [activeSessions, focusedSessionId, hasStoredState, laneId, setViewState]);

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
    const session = activeSessionsById.get(focusedSessionId);
    if (!session) return;
    openSessionTab(session.id);
  }, [activeSessionsById, focusedSessionId, laneId, openSessionTab]);

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
  };
}
