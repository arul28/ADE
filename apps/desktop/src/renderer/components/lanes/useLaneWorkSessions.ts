import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentChatSession, TerminalSessionSummary } from "../../../shared/types";
import { useAppStore, type WorkDraftKind, type WorkProjectViewState, type WorkViewMode } from "../../state/appStore";
import { listSessionsCached } from "../../lib/sessionListCache";
import { sessionStatusBucket } from "../../lib/terminalAttention";
import { shouldRefreshSessionListForChatEvent } from "../../lib/chatSessionEvents";
import { buildOptimisticChatSessionSummary, isRunOwnedSession } from "../../lib/sessions";
import { defaultTrackedCliStartupCommand } from "../terminals/cliLaunch";

const EMPTY_WORK_STATE: WorkProjectViewState = {
  openItemIds: [],
  activeItemId: null,
  selectedItemId: null,
  viewMode: "tabs",
  draftKind: "chat",
  laneFilter: "all",
  statusFilter: "all",
  search: "",
  sessionListOrganization: "all-lanes-by-status",
  workCollapsedLaneIds: [],
  workFocusSessionsHidden: false,
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
    toolType: session.toolType,
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
  const workViewByProject = useAppStore((state) => state.workViewByProject);
  const setWorkViewState = useAppStore((state) => state.setWorkViewState);

  const [sessions, setSessions] = useState<TerminalSessionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [closingPtyIds, setClosingPtyIds] = useState<Set<string>>(new Set());
  const refreshInFlightRef = useRef(false);
  const refreshQueuedRef = useRef<{ showLoading: boolean; force: boolean } | null>(null);
  const refreshWaitersRef = useRef<Array<() => void>>([]);
  const backgroundRefreshTimerRef = useRef<number | null>(null);
  const hasActiveSessionsRef = useRef(false);
  const hasLoadedOnceRef = useRef(false);
  const hasFetchedOnceRef = useRef(false);

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
    ? laneWorkViewByScope[scopeKey] ?? EMPTY_WORK_STATE
    : EMPTY_WORK_STATE;

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
        // Return a promise that resolves when the in-flight refresh completes,
        // so callers who `await refresh()` get reliable timing.
        return new Promise<void>((resolve) => {
          refreshWaitersRef.current.push(resolve);
        });
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
        hasFetchedOnceRef.current = true;
      } catch (err) {
        console.warn("[useLaneWorkSessions] Failed to refresh sessions:", err);
      } finally {
        if (showLoading) setLoading(false);
        refreshInFlightRef.current = false;

        // Resolve all callers that were waiting on this in-flight refresh.
        const waiters = refreshWaitersRef.current;
        refreshWaitersRef.current = [];
        for (const resolve of waiters) resolve();

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

  const upsertOptimisticChatSession = useCallback((session: AgentChatSession) => {
    if (!laneId || session.laneId !== laneId) return;
    const laneName = currentLane?.name ?? lanes.find((lane) => lane.id === session.laneId)?.name ?? session.laneId;
    const optimistic = buildOptimisticChatSessionSummary({
      session,
      laneName,
    });
    hasLoadedOnceRef.current = true;
    setSessions((prev) => {
      const next = [optimistic, ...prev.filter((entry) => entry.id !== session.id)];
      next.sort((left, right) => (
        new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime()
      ));
      return next;
    });
  }, [currentLane?.name, laneId, lanes]);

  useEffect(() => {
    setSessions([]);
    hasLoadedOnceRef.current = false;
    hasFetchedOnceRef.current = false;
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

  // Derive open items from project-level state filtered to this lane's sessions.
  // This keeps open tabs in sync between the Work tab and the Lane work pane.
  const projectViewState = useMemo(() => {
    if (!projectRoot) return EMPTY_WORK_STATE;
    return workViewByProject[projectRoot] ?? EMPTY_WORK_STATE;
  }, [projectRoot, workViewByProject]);

  const laneOpenItemIds = useMemo(() => {
    const laneSessionIds = new Set(sessions.map((s) => s.id));
    return projectViewState.openItemIds.filter((id) => laneSessionIds.has(id));
  }, [projectViewState.openItemIds, sessions]);

  const visibleSessions = useMemo(() => {
    return laneOpenItemIds
      .map((sessionId) => sessionsById.get(sessionId))
      .filter((session): session is TerminalSessionSummary => session != null);
  }, [laneOpenItemIds, sessionsById]);

  const gridLayoutId = useMemo(
    () => `work:grid:v2:${projectRoot ?? "global"}::${laneId ?? "none"}`,
    [laneId, projectRoot],
  );

  // Validate lane-local activeItemId/selectedItemId against the derived open items.
  // openItemIds are managed at the project level, so we only fix up lane-local pointers here.
  // Use hasFetchedOnceRef (not hasLoadedOnceRef) so that optimistic inserts don't
  // trigger pruning before the first real fetch has established an authoritative list.
  useEffect(() => {
    if (!hasFetchedOnceRef.current) return;
    setViewState((prev) => {
      const userIsViewingDraft = prev.activeItemId == null && prev.selectedItemId == null;
      if (userIsViewingDraft) return prev;

      const nextActive = prev.activeItemId && laneOpenItemIds.includes(prev.activeItemId)
        ? prev.activeItemId
        : laneOpenItemIds[0] ?? null;

      const validIds = new Set(sessions.map((s) => s.id));
      const nextSelected = prev.selectedItemId && validIds.has(prev.selectedItemId)
        ? prev.selectedItemId
        : nextActive;

      if (prev.activeItemId === nextActive && prev.selectedItemId === nextSelected) {
        return prev;
      }

      return {
        ...prev,
        activeItemId: nextActive,
        selectedItemId: nextSelected,
      };
    });
  }, [laneOpenItemIds, sessions, setViewState]);

  useEffect(() => {
    if (!laneId || !projectRoot || !hasStoredState) return;
    if (laneOpenItemIds.length > 0) return;
    const migratedOpen = laneViewState.openItemIds.filter((id) => sessionsById.has(id));
    if (migratedOpen.length === 0) return;
    setWorkViewState(projectRoot, (prev) => {
      const nextOpen = [...prev.openItemIds];
      for (const sessionId of migratedOpen) {
        if (!nextOpen.includes(sessionId)) {
          nextOpen.push(sessionId);
        }
      }
      return arraysEqual(nextOpen, prev.openItemIds) ? prev : { ...prev, openItemIds: nextOpen };
    });
  }, [hasStoredState, laneId, laneOpenItemIds.length, laneViewState.openItemIds, projectRoot, sessionsById, setWorkViewState]);

  useEffect(() => {
    if (!laneId || hasStoredState || sessions.length === 0) return;
    // If lane already has open items derived from project-level, skip auto-init
    if (laneOpenItemIds.length > 0) return;

    const preferredSessions = activeSessions.length > 0 ? activeSessions : sessions.slice(0, 1);
    const nextOpen = preferredSessions.map((session) => session.id);

    // Add to project-level open items (single source of truth)
    setWorkViewState(projectRoot, (prev) => {
      const toAdd = nextOpen.filter((id) => !prev.openItemIds.includes(id));
      if (toAdd.length === 0) return prev;
      return { ...prev, openItemIds: [...prev.openItemIds, ...toAdd] };
    });

    // Set lane-local active/selected
    const preferredActive = focusedSessionId && nextOpen.includes(focusedSessionId)
      ? focusedSessionId
      : nextOpen[0] ?? null;
    setViewState((prev) => {
      if (prev.activeItemId != null) return prev;
      return { ...prev, activeItemId: preferredActive, selectedItemId: preferredActive };
    });
  }, [activeSessions, focusedSessionId, hasStoredState, laneId, laneOpenItemIds, projectRoot, sessions, setViewState, setWorkViewState]);

  const openSessionTab = useCallback((sessionId: string) => {
    // Add to project-level open items (single source of truth for open tabs)
    setWorkViewState(projectRoot, (prev) => {
      const nextOpen = prev.openItemIds.includes(sessionId)
        ? prev.openItemIds
        : [...prev.openItemIds, sessionId];
      return { ...prev, openItemIds: nextOpen };
    });
    // Set lane-local active/selected
    setViewState((prev) => ({
      ...prev,
      activeItemId: sessionId,
      selectedItemId: sessionId,
    }));
  }, [projectRoot, setWorkViewState, setViewState]);

  const prevFocusedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!laneId) {
      prevFocusedRef.current = null;
      return;
    }
    if (!focusedSessionId) {
      prevFocusedRef.current = null;
      return;
    }
    // Only react when focusedSessionId actually changes, not when sessionsById
    // refreshes due to background output. This prevents snapping the user away
    // from draft mode (new chat creation) every time a running session emits output.
    if (prevFocusedRef.current === focusedSessionId) return;
    const session = sessionsById.get(focusedSessionId);
    if (!session) return;
    prevFocusedRef.current = focusedSessionId;
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
    if (sessionId) {
      // Ensure the session is in project-level open items
      setWorkViewState(projectRoot, (prev) => {
        const nextOpen = prev.openItemIds.includes(sessionId)
          ? prev.openItemIds
          : [...prev.openItemIds, sessionId];
        return { ...prev, openItemIds: nextOpen };
      });
    }
    setViewState((prev) => ({
      ...prev,
      activeItemId: sessionId,
      selectedItemId: sessionId,
    }));
  }, [projectRoot, setWorkViewState, setViewState]);

  const closeTab = useCallback((sessionId: string) => {
    // Remove from project-level open items (single source of truth)
    setWorkViewState(projectRoot, (prev) => {
      const nextOpen = prev.openItemIds.filter((id) => id !== sessionId);
      if (nextOpen.length === prev.openItemIds.length) return prev;
      // Also update project-level active/selected if they pointed to this session
      const nextActive = prev.activeItemId === sessionId
        ? (nextOpen.length > 0 ? nextOpen[Math.min(prev.openItemIds.indexOf(sessionId), nextOpen.length - 1)] ?? null : null)
        : prev.activeItemId;
      const nextSelected = prev.selectedItemId === sessionId ? nextActive : prev.selectedItemId;
      return { ...prev, openItemIds: nextOpen, activeItemId: nextActive, selectedItemId: nextSelected };
    });
    // Update lane-local active/selected
    const nextLaneOpen = laneOpenItemIds.filter((id) => id !== sessionId);
    const currentIndex = laneOpenItemIds.indexOf(sessionId);
    const fallbackActive =
      nextLaneOpen.length > 0
        ? nextLaneOpen[Math.min(currentIndex, nextLaneOpen.length - 1)] ?? nextLaneOpen[0] ?? null
        : null;
    setViewState((prev) => {
      const nextActive = prev.activeItemId === sessionId ? fallbackActive : prev.activeItemId;
      const nextSelected = prev.selectedItemId === sessionId ? nextActive : prev.selectedItemId;
      return {
        ...prev,
        activeItemId: nextActive,
        selectedItemId: nextSelected,
        draftKind: nextLaneOpen.length === 0 ? "chat" : prev.draftKind,
      };
    });
  }, [laneOpenItemIds, projectRoot, setWorkViewState, setViewState]);

  const launchPtySession = useCallback(
    async (args: {
      laneId: string;
      profile: "claude" | "codex" | "shell";
      tracked?: boolean;
      title?: string;
      startupCommand?: string;
    }) => {
      const titleMap = { claude: "Claude Code", codex: "Codex", shell: "Shell" } as const;
      const commandMap = {
        claude: defaultTrackedCliStartupCommand("claude"),
        codex: defaultTrackedCliStartupCommand("codex"),
        shell: "",
      } as const;
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
      // Refresh the session list *before* activating the tab so the new
      // session exists in sessionsById when the UI resolves activeSession.
      // Without this, activeItemId points to an unknown ID and the view
      // falls back to the most recent session for several seconds.
      await refresh({ showLoading: false, force: true });
      focusSession(result.sessionId);
      openSessionTab(result.sessionId);
      return result;
    },
    [focusSession, openSessionTab, refresh, selectLane],
  );

  const handleOpenChatSession = useCallback((session: AgentChatSession) => {
    selectLane(session.laneId);
    if (!laneId || session.laneId !== laneId) {
      focusSession(session.id);
      return;
    }
    upsertOptimisticChatSession(session);
    focusSession(session.id);
    openSessionTab(session.id);
    void refresh({ showLoading: false, force: true });
  }, [focusSession, laneId, openSessionTab, refresh, selectLane, upsertOptimisticChatSession]);

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
    gridLayoutId,
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
