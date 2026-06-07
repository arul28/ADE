import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentChatSession, TerminalSessionSummary } from "../../../shared/types";
import { selectActiveProjectRoot, useAppStore, type WorkDraftKind, type WorkProjectViewState } from "../../state/appStore";
import { listSessionsCached, invalidateSessionListCache } from "../../lib/sessionListCache";
import { sessionStatusBucket } from "../../lib/terminalAttention";
import { shouldRefreshSessionListForChatEvent } from "../../lib/chatSessionEvents";
import { buildOptimisticChatSessionSummary, isRunOwnedSession } from "../../lib/sessions";
import {
  LAUNCH_PROFILE_TITLE,
  LAUNCH_PROFILE_TOOL_TYPE,
  resolveLaunchFields,
  type WorkPtyLaunchArgs,
  type WorkPtyLaunchResult,
} from "../terminals/cliLaunch";

const EMPTY_WORK_STATE: WorkProjectViewState = {
  openItemIds: [],
  activeItemId: null,
  selectedItemId: null,
  gridSets: [],
  activeGridSetId: null,
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

const laneSessionsCacheByScope = new Map<string, TerminalSessionSummary[]>();
const OPTIMISTIC_PTY_SESSION_TTL_MS = 2 * 60 * 1000;
const STOPPED_RUNTIME_GUARD_TTL_MS = 12_000;

export function __clearLaneWorkSessionCacheForTests(): void {
  laneSessionsCacheByScope.clear();
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

type StoppedRuntimeSession = {
  ptyId: string;
  endedAt: string;
  expiresAtMs: number;
};

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
  const projectRoot = useAppStore(selectActiveProjectRoot);
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
  const refreshQueuedRef = useRef<QueuedRefresh | null>(null);
  const backgroundRefreshTimerRef = useRef<number | null>(null);
  const pendingHiddenSessionRefreshRef = useRef(false);
  const hasActiveSessionsRef = useRef(false);
  const hasLoadedOnceRef = useRef(false);
  const hasFetchedOnceRef = useRef(false);
  const laneIdRef = useRef<string | null>(laneId);
  const projectRootRef = useRef<string | null>(projectRoot);
  const scopeKeyRef = useRef("");
  const sessionIdsRef = useRef<Set<string>>(new Set());
  const pendingOptimisticSessionsRef = useRef<Map<string, PendingOptimisticSession>>(new Map());
  const sessionsRef = useRef<TerminalSessionSummary[]>([]);
  const stoppedRuntimeSessionsRef = useRef<Map<string, StoppedRuntimeSession>>(new Map());

  const currentLane = useMemo(
    () => (laneId ? lanes.find((lane) => lane.id === laneId) ?? null : null),
    [laneId, lanes],
  );

  const scopeKey = useMemo(() => {
    const normalizedProjectRoot = projectRoot?.trim() ?? "";
    if (!normalizedProjectRoot || !laneId) return "";
    return `${normalizedProjectRoot}::${laneId}`;
  }, [projectRoot, laneId]);
  const pendingOptimisticScopeKeyRef = useRef(scopeKey);

  useEffect(() => {
    if (pendingOptimisticScopeKeyRef.current === scopeKey) return;
    pendingOptimisticSessionsRef.current.clear();
    pendingOptimisticScopeKeyRef.current = scopeKey;
  }, [scopeKey]);

  useEffect(() => {
    laneIdRef.current = laneId;
    projectRootRef.current = projectRoot;
    scopeKeyRef.current = scopeKey;
  }, [laneId, projectRoot, scopeKey]);

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
      const targetLaneId = laneIdRef.current;
      if (!targetLaneId) {
        setSessions([]);
        hasLoadedOnceRef.current = true;
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
        const requestedScopeKey = scopeKeyRef.current;
        const rows = (
          await listSessionsCached(
            { laneId: targetLaneId, limit: 200 },
            { force: Boolean(options.force) },
          )
        ).filter((session) => !isRunOwnedSession(session));
        if (scopeKeyRef.current !== requestedScopeKey) return;
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
        const stoppedRuntimeSessions = stoppedRuntimeSessionsRef.current;
        if (stoppedRuntimeSessions.size > 0) {
          const now = Date.now();
          for (const [sessionId, stopped] of [...stoppedRuntimeSessions.entries()]) {
            if (stopped.expiresAtMs <= now) stoppedRuntimeSessions.delete(sessionId);
          }
          if (stoppedRuntimeSessions.size > 0) {
            for (let index = 0; index < rows.length; index += 1) {
              const row = rows[index];
              if (!row) continue;
              const stopped = stoppedRuntimeSessions.get(row.id);
              if (!stopped) continue;
              if (row.status !== "running") {
                stoppedRuntimeSessions.delete(row.id);
                continue;
              }
              if (row.ptyId && row.ptyId !== stopped.ptyId) {
                stoppedRuntimeSessions.delete(row.id);
                continue;
              }
              rows[index] = {
                ...row,
                ptyId: null,
                status: "disposed",
                runtimeState: "killed",
                endedAt: row.endedAt ?? stopped.endedAt,
                exitCode: null,
              };
            }
          }
        }
        const nextSessions = rows;
        setSessions(nextSessions);
        if (requestedScopeKey) {
          laneSessionsCacheByScope.set(requestedScopeKey, nextSessions);
        }
        hasLoadedOnceRef.current = true;
        hasFetchedOnceRef.current = true;
      } catch (err) {
        console.warn("[useLaneWorkSessions] Failed to refresh sessions:", err);
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
    },
    [],
  );

  const scheduleBackgroundRefresh = useCallback((delayMs = 300) => {
    if (backgroundRefreshTimerRef.current != null) return;
    backgroundRefreshTimerRef.current = window.setTimeout(() => {
      backgroundRefreshTimerRef.current = null;
      if (document.visibilityState !== "visible") {
        pendingHiddenSessionRefreshRef.current = true;
        return;
      }
      void refresh({ showLoading: false });
    }, delayMs);
  }, [refresh]);

  const markSessionListDirtyOrRefresh = useCallback((delayMs: number) => {
    const targetLaneId = laneIdRef.current;
    if (!targetLaneId) return;
    invalidateSessionListCache({ projectRoot: projectRootRef.current, laneId: targetLaneId });
    if (document.visibilityState !== "visible") {
      pendingHiddenSessionRefreshRef.current = true;
      return;
    }
    scheduleBackgroundRefresh(delayMs);
  }, [scheduleBackgroundRefresh]);

  const upsertOptimisticChatSession = useCallback((session: AgentChatSession) => {
    if (!laneId || session.laneId !== laneId) return;
    const laneName = currentLane?.name ?? lanes.find((lane) => lane.id === session.laneId)?.name ?? session.laneId;
    const optimistic = buildOptimisticChatSessionSummary({
      session,
      laneName,
    });
    optimistic.startedAt = new Date().toISOString();
    pendingOptimisticSessionsRef.current.set(optimistic.id, {
      session: optimistic,
      createdAtMs: Date.now(),
    });
    hasLoadedOnceRef.current = true;
    setSessions((prev) => {
      const next = upsertSessionByStartedAt(prev, optimistic);
      if (scopeKey) {
        laneSessionsCacheByScope.set(scopeKey, next);
      }
      return next;
    });
  }, [currentLane?.name, laneId, lanes, scopeKey]);

  useEffect(() => {
    sessionIdsRef.current = new Set(sessions.map((session) => session.id));
    sessionsRef.current = sessions;
  }, [sessions]);

  const upsertSessionSnapshot = useCallback((session: TerminalSessionSummary) => {
    if (!laneId || session.laneId !== laneId) return;
    hasLoadedOnceRef.current = true;
    setSessions((prev) => {
      const next = upsertSessionByStartedAt(prev, session);
      if (scopeKey) {
        laneSessionsCacheByScope.set(scopeKey, next);
      }
      return next;
    });
  }, [laneId, scopeKey]);

  useEffect(() => {
    const cachedSessions = scopeKey ? laneSessionsCacheByScope.get(scopeKey) ?? null : null;
    setSessions(cachedSessions ?? []);
    hasLoadedOnceRef.current = Boolean(cachedSessions);
    hasFetchedOnceRef.current = false;
    pendingHiddenSessionRefreshRef.current = false;
    if (!laneId) return;
    void refresh({ showLoading: !cachedSessions, force: !cachedSessions });
  }, [laneId, refresh, scopeKey]);

  useEffect(() => {
    return () => {
      if (backgroundRefreshTimerRef.current != null) {
        window.clearTimeout(backgroundRefreshTimerRef.current);
        backgroundRefreshTimerRef.current = null;
      }
    };
  }, [laneId]);

  useEffect(() => {
    const unsubscribe = window.ade.pty.onExit((event) => {
      if (!laneId) return;
      if (event.projectRoot && event.projectRoot !== projectRoot) return;
      if (event.sessionId && !sessionIdsRef.current.has(event.sessionId)) return;
      markSessionListDirtyOrRefresh(120);
    });
    return () => {
      try {
        unsubscribe();
      } catch {
        // ignore
      }
    };
  }, [laneId, projectRoot, markSessionListDirtyOrRefresh]);

  useEffect(() => {
    const unsubscribe = window.ade.agentChat.onEvent((payload) => {
      if (!laneId) return;
      if (payload.provenance?.laneId && payload.provenance.laneId !== laneId) return;
      if (!shouldRefreshSessionListForChatEvent(payload)) return;
      markSessionListDirtyOrRefresh(180);
    });
    return unsubscribe;
  }, [laneId, markSessionListDirtyOrRefresh]);

  useEffect(() => {
    const unsubscribe = window.ade.sessions.onChanged((event) => {
      if (!laneId) return;
      if (!event) {
        markSessionListDirtyOrRefresh(80);
        return;
      }
      if (event.reason !== "created" && !sessionIdsRef.current.has(event.sessionId)) return;
      markSessionListDirtyOrRefresh(80);
    });
    return unsubscribe;
  }, [laneId, markSessionListDirtyOrRefresh]);

  useEffect(() => {
    if (!laneId) return;
    const refreshVisibleLaneWork = () => {
      if (document.visibilityState !== "visible") return;
      if (!pendingHiddenSessionRefreshRef.current) return;
      pendingHiddenSessionRefreshRef.current = false;
      invalidateSessionListCache({ projectRoot: projectRootRef.current, laneId: laneIdRef.current });
      scheduleBackgroundRefresh(40);
    };
    window.addEventListener("focus", refreshVisibleLaneWork);
    document.addEventListener("visibilitychange", refreshVisibleLaneWork);
    return () => {
      window.removeEventListener("focus", refreshVisibleLaneWork);
      document.removeEventListener("visibilitychange", refreshVisibleLaneWork);
    };
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
    () => `work:grid:tiling:v1:${projectRoot ?? "global"}::${laneId ?? "none"}`,
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

  const showDraftKind = useCallback((nextKind: WorkDraftKind) => {
    setViewState((prev) => ({
      ...prev,
      draftKind: nextKind,
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
        draftKind: prev.draftKind,
      };
    });
  }, [laneOpenItemIds, projectRoot, setWorkViewState, setViewState]);

  const launchPtySession = useCallback(
    async (args: WorkPtyLaunchArgs): Promise<WorkPtyLaunchResult> => {
      // resolveLaunchFields treats the caller's launch overrides as atomic:
      // if any of startupCommand/command/args is supplied we don't mix in
      // defaults from the other fields (which used to override the caller's
      // intent — e.g. a custom startupCommand silently displaced by default
      // command/args).
      const launchFields = resolveLaunchFields({
        profile: args.profile,
        ...(args.permissionMode !== undefined ? { permissionMode: args.permissionMode } : {}),
        ...(args.orchestrationRole !== undefined ? { orchestrationRole: args.orchestrationRole } : {}),
        ...(args.startupCommand !== undefined ? { startupCommand: args.startupCommand } : {}),
        ...(args.command !== undefined ? { command: args.command } : {}),
        ...(args.args !== undefined ? { args: args.args } : {}),
        ...(args.env !== undefined ? { env: args.env } : {}),
        ...(args.initialInput !== undefined ? { initialInput: args.initialInput } : {}),
        ...(args.initialInputDelayMs !== undefined ? { initialInputDelayMs: args.initialInputDelayMs } : {}),
      });
      const result = await window.ade.pty.create({
        laneId: args.laneId,
        cols: 100,
        rows: 30,
        title: args.title ?? LAUNCH_PROFILE_TITLE[args.profile],
        tracked: args.tracked ?? true,
        toolType: LAUNCH_PROFILE_TOOL_TYPE[args.profile],
        ...(args.startupDelayMs !== undefined ? { startupDelayMs: args.startupDelayMs } : {}),
        ...(launchFields.initialInput !== undefined ? { initialInput: launchFields.initialInput } : {}),
        ...(launchFields.initialInputDelayMs !== undefined ? { initialInputDelayMs: launchFields.initialInputDelayMs } : {}),
        ...(args.linearIssues?.length ? { linearIssues: args.linearIssues } : {}),
        ...launchFields,
      });
      const startedAt = new Date().toISOString();
      const optimisticSession: TerminalSessionSummary = {
        id: result.sessionId,
        laneId: args.laneId,
        laneName: currentLane?.name ?? lanes.find((lane) => lane.id === args.laneId)?.name ?? args.laneId,
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
        lastActivityAt: null,
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
      upsertSessionSnapshot(optimisticSession);
      // Invalidate all cache entries so other views (e.g. Work tab) pick up
      // the new session on their next refresh.
      invalidateSessionListCache();
      if (args.disposition !== "background") {
        selectLane(args.laneId);
        focusSession(result.sessionId);
        openSessionTab(result.sessionId);
      }
      void refresh({ showLoading: false, force: true }).catch(() => {});
      return result;
    },
    [currentLane?.name, focusSession, lanes, openSessionTab, refresh, selectLane, upsertSessionSnapshot],
  );

  const handleOpenChatSession = useCallback((session: AgentChatSession) => {
    // Invalidate the entire session list cache so other views (e.g. Work tab)
    // fetch fresh data on their next refresh instead of returning stale results.
    invalidateSessionListCache();
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

  const continueCliSession = useCallback(async (session: TerminalSessionSummary, text: string) => {
    const result = await window.ade.pty.sendToSession({
      sessionId: session.id,
      text,
      cols: 100,
      rows: 30,
    });
    invalidateSessionListCache();
    if (result.session) {
      upsertSessionSnapshot(result.session);
    }
    await refresh({ showLoading: false, force: true });
    selectLane(session.laneId);
    focusSession(result.sessionId);
    openSessionTab(result.sessionId);
  }, [focusSession, openSessionTab, refresh, selectLane, upsertSessionSnapshot]);

  const closePtySession = useCallback(async (ptyId: string) => {
    const matchedSession = sessionsRef.current.find((session) => session.ptyId === ptyId) ?? null;
    const sessionId = matchedSession?.id ?? null;
    const previousSessions = sessionsRef.current.filter((session) =>
      session.ptyId === ptyId || (sessionId != null && session.id === sessionId),
    );
    const restorePreviousSessions = () => {
      if (previousSessions.length === 0) return;
      const previousById = new Map(previousSessions.map((session) => [session.id, session] as const));
      setSessions((prev) => prev.map((session) => previousById.get(session.id) ?? session));
    };
    const endedAt = new Date().toISOString();
    setClosingPtyIds((prev) => {
      const next = new Set(prev);
      next.add(ptyId);
      return next;
    });
    invalidateSessionListCache();
    setSessions((prev) =>
      prev.map((session) =>
        session.ptyId === ptyId || (sessionId != null && session.id === sessionId)
          ? {
              ...session,
              ptyId: null,
              status: "disposed" as const,
              runtimeState: "killed" as const,
              endedAt,
              exitCode: null,
            }
          : session,
      ),
    );
    let disposeError: unknown = null;
    try {
      const result = await window.ade.pty.dispose({ ptyId, ...(sessionId ? { sessionId } : {}) });
      if (result?.disposed === false) {
        if (sessionId) stoppedRuntimeSessionsRef.current.delete(sessionId);
        restorePreviousSessions();
      } else if (sessionId) {
        stoppedRuntimeSessionsRef.current.set(sessionId, {
          ptyId,
          endedAt,
          expiresAtMs: Date.now() + STOPPED_RUNTIME_GUARD_TTL_MS,
        });
      }
    } catch (error) {
      disposeError = error;
      if (sessionId) stoppedRuntimeSessionsRef.current.delete(sessionId);
      restorePreviousSessions();
    } finally {
      setClosingPtyIds((prev) => {
        const next = new Set(prev);
        next.delete(ptyId);
        return next;
      });
      invalidateSessionListCache();
      await refresh({ showLoading: false, force: true });
    }
    if (disposeError) throw disposeError;
  }, [refresh]);

  return {
    lane: currentLane,
    loading,
    sessions,
    visibleSessions,
    gridLayoutId,
    activeItemId: laneViewState.activeItemId,
    draftKind: laneViewState.draftKind,
    showDraftKind,
    setActiveItemId,
    closeTab,
    launchPtySession,
    continueCliSession,
    handleOpenChatSession,
    closingPtyIds,
    closePtySession,
  };
}
