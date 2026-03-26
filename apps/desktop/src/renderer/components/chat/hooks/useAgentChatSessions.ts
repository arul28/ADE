import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentChatSessionSummary } from "../../../../shared/types";
import {
  getModelById,
  isModelProviderGroup,
  resolveModelIdForProvider,
} from "../../../../shared/modelRegistry";
import { isChatToolType } from "../../../lib/sessions";
import { parseAgentChatTranscript } from "../../../../shared/chatTranscript";
import type { AgentChatEventEnvelope } from "../../../../shared/types";

// ── Helpers ─────────────────────────────────────────────────────────

export function byStartedDesc(a: AgentChatSessionSummary, b: AgentChatSessionSummary): number {
  return Date.parse(b.startedAt) - Date.parse(a.startedAt);
}

export function resolveNextSelectedSessionId(args: {
  rows: AgentChatSessionSummary[];
  current: string | null;
  pendingSelectedSessionId: string | null;
  optimisticSessionIds: Set<string>;
  draftSelectionLocked: boolean;
  forceDraft: boolean;
  preferDraftStart: boolean;
}): string | null {
  const {
    rows,
    current,
    pendingSelectedSessionId,
    optimisticSessionIds,
    draftSelectionLocked,
    forceDraft,
    preferDraftStart,
  } = args;

  if (pendingSelectedSessionId) {
    const pendingIsPersisted = rows.some((row) => row.sessionId === pendingSelectedSessionId);
    if (pendingIsPersisted) return pendingSelectedSessionId;
    if (current === pendingSelectedSessionId || optimisticSessionIds.has(pendingSelectedSessionId)) {
      return pendingSelectedSessionId;
    }
  }

  if (!current && (draftSelectionLocked || forceDraft || preferDraftStart)) {
    return null;
  }
  if (current && rows.some((row) => row.sessionId === current)) {
    return current;
  }
  if (current && optimisticSessionIds.has(current)) {
    return current;
  }
  return rows[0]?.sessionId ?? null;
}

function resolveRegistryModelId(
  value: string | null | undefined,
  provider?: "codex" | "claude" | "unified",
): string | null {
  return resolveModelIdForProvider(value, provider) ?? null;
}

// ── Hook ────────────────────────────────────────────────────────────

export interface UseAgentChatSessionsArgs {
  laneId: string | null;
  lockSessionId?: string | null;
  initialSessionId?: string | null;
  initialSessionSummary?: AgentChatSessionSummary | null;
  forceNewSession?: boolean;
  forceDraftMode?: boolean;
  lockedSingleSessionMode: boolean;
  /** Refs / setters for event state that loadHistory needs to update */
  eventsBySessionRef: React.MutableRefObject<Record<string, AgentChatEventEnvelope[]>>;
  updateSessionEvents: (sessionId: string, events: AgentChatEventEnvelope[]) => void;
}

export interface UseAgentChatSessionsReturn {
  sessions: AgentChatSessionSummary[];
  setSessions: React.Dispatch<React.SetStateAction<AgentChatSessionSummary[]>>;
  selectedSessionId: string | null;
  setSelectedSessionId: React.Dispatch<React.SetStateAction<string | null>>;
  selectedSession: AgentChatSessionSummary | null;
  selectedSessionModelId: string | null;
  refreshSessions: () => Promise<void>;
  loadHistory: (sessionId: string) => Promise<void>;
  optimisticSessionIdsRef: React.MutableRefObject<Set<string>>;
  pendingSelectedSessionIdRef: React.MutableRefObject<string | null>;
  draftSelectionLockedRef: React.MutableRefObject<boolean>;
  knownSessionIdsRef: React.MutableRefObject<Set<string>>;
  loadedHistoryRef: React.MutableRefObject<Set<string>>;
  refreshSessionsTimerRef: React.MutableRefObject<number | null>;
  scheduleSessionsRefresh: () => void;
}

export function useAgentChatSessions({
  laneId,
  lockSessionId,
  initialSessionId,
  initialSessionSummary,
  forceNewSession = false,
  forceDraftMode = false,
  lockedSingleSessionMode,
  eventsBySessionRef,
  updateSessionEvents,
}: UseAgentChatSessionsArgs): UseAgentChatSessionsReturn {
  const forceDraft = forceDraftMode || forceNewSession;
  const preferDraftStart = !lockSessionId && !initialSessionId && !forceNewSession;

  const [sessions, setSessions] = useState<AgentChatSessionSummary[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(lockSessionId ?? initialSessionId ?? null);

  const optimisticSessionIdsRef = useRef<Set<string>>(new Set());
  const pendingSelectedSessionIdRef = useRef<string | null>(null);
  const draftSelectionLockedRef = useRef(false);
  const knownSessionIdsRef = useRef<Set<string>>(new Set());
  const loadedHistoryRef = useRef<Set<string>>(new Set());
  const refreshSessionsTimerRef = useRef<number | null>(null);
  const appliedInitialSessionIdRef = useRef<string | null>(initialSessionId ?? null);
  const selectedSessionIdRef = useRef<string | null>(selectedSessionId);

  const selectedSession = useMemo(
    () => (selectedSessionId ? sessions.find((session) => session.sessionId === selectedSessionId) ?? null : null),
    [sessions, selectedSessionId],
  );

  const selectedSessionModelId = useMemo(() => {
    if (!selectedSession) return null;
    return selectedSession.modelId
      ?? resolveRegistryModelId(selectedSession.model, isModelProviderGroup(selectedSession.provider) ? selectedSession.provider : undefined);
  }, [selectedSession]);

  // ── refreshSessions ───────────────────────────────────────────────

  const refreshSessions = useCallback(async () => {
    if (!laneId) {
      setSessions([]);
      return;
    }

    const rows = await window.ade.agentChat.list({ laneId });
    rows.sort(byStartedDesc);
    setSessions(rows);
    for (const row of rows) {
      optimisticSessionIdsRef.current.delete(row.sessionId);
    }

    if (lockSessionId) {
      draftSelectionLockedRef.current = false;
      setSelectedSessionId(lockSessionId);
      return;
    }

    setSelectedSessionId((current) => {
      const pendingSelectedSessionId = pendingSelectedSessionIdRef.current;
      const nextSelectedSessionId = resolveNextSelectedSessionId({
        rows,
        current,
        pendingSelectedSessionId,
        optimisticSessionIds: optimisticSessionIdsRef.current,
        draftSelectionLocked: draftSelectionLockedRef.current,
        forceDraft,
        preferDraftStart,
      });
      if (pendingSelectedSessionId && rows.some((row) => row.sessionId === pendingSelectedSessionId)) {
        pendingSelectedSessionIdRef.current = null;
      }
      return nextSelectedSessionId;
    });
  }, [forceDraft, laneId, lockSessionId, preferDraftStart]);

  // ── scheduleSessionsRefresh ───────────────────────────────────────

  const scheduleSessionsRefresh = useCallback(() => {
    if (refreshSessionsTimerRef.current != null) return;
    refreshSessionsTimerRef.current = window.setTimeout(() => {
      refreshSessionsTimerRef.current = null;
      void refreshSessions().catch(() => {});
    }, 120);
  }, [refreshSessions]);

  // ── loadHistory ───────────────────────────────────────────────────

  const loadHistory = useCallback(async (sessionId: string) => {
    if (loadedHistoryRef.current.has(sessionId)) return;

    try {
      const summary = await window.ade.sessions.get(sessionId);
      if (!summary || !isChatToolType(summary.toolType)) return;
      const raw = await window.ade.sessions.readTranscriptTail({
        sessionId,
        maxBytes: 1_800_000,
        raw: true,
      });
      const parsed = parseAgentChatTranscript(raw).filter((entry) => entry.sessionId === sessionId);

      const existing = eventsBySessionRef.current[sessionId] ?? [];
      let merged: AgentChatEventEnvelope[];
      if (existing.length && parsed.length) {
        const lastParsedTs = parsed[parsed.length - 1]!.timestamp;
        const tail = existing.filter((e) => e.timestamp > lastParsedTs);
        merged = tail.length ? [...parsed, ...tail] : parsed;
      } else if (existing.length) {
        merged = existing;
      } else {
        merged = parsed;
      }

      updateSessionEvents(sessionId, merged);

      loadedHistoryRef.current.add(sessionId);
    } catch {
      // Ignore transcript history failures — don't mark as loaded so retries are allowed.
    }
  }, [eventsBySessionRef, updateSessionEvents]);

  // ── Side effects ──────────────────────────────────────────────────

  // Keep selectedSessionIdRef in sync
  useEffect(() => {
    selectedSessionIdRef.current = selectedSessionId;
  }, [selectedSessionId]);

  // Track known session IDs
  useEffect(() => {
    const next = new Set<string>();
    for (const session of sessions) next.add(session.sessionId);
    if (selectedSessionId) next.add(selectedSessionId);
    if (lockSessionId) next.add(lockSessionId);
    if (initialSessionId) next.add(initialSessionId);
    for (const sessionId of optimisticSessionIdsRef.current) next.add(sessionId);
    knownSessionIdsRef.current = next;
  }, [initialSessionId, lockSessionId, selectedSessionId, sessions]);

  // Lock session when lockSessionId changes
  useEffect(() => {
    if (lockSessionId) {
      pendingSelectedSessionIdRef.current = null;
      draftSelectionLockedRef.current = false;
      setSelectedSessionId(lockSessionId);
    }
  }, [lockSessionId]);

  // Locked single session mode initialization
  useEffect(() => {
    if (!lockedSingleSessionMode || !lockSessionId || !initialSessionSummary) return;
    setSessions([initialSessionSummary]);
    draftSelectionLockedRef.current = false;
    setSelectedSessionId(lockSessionId);
  }, [initialSessionSummary, lockSessionId, lockedSingleSessionMode]);

  // Apply new initialSessionId
  useEffect(() => {
    const nextInitialSessionId = initialSessionId ?? null;
    if (!nextInitialSessionId) {
      appliedInitialSessionIdRef.current = null;
      return;
    }
    if (lockSessionId) return;
    if (appliedInitialSessionIdRef.current === nextInitialSessionId) return;
    appliedInitialSessionIdRef.current = nextInitialSessionId;
    pendingSelectedSessionIdRef.current = null;
    draftSelectionLockedRef.current = false;
    setSelectedSessionId(nextInitialSessionId);
  }, [initialSessionId, lockSessionId]);

  // Reset on laneId / force changes
  useEffect(() => {
    draftSelectionLockedRef.current = false;
    optimisticSessionIdsRef.current.clear();
    pendingSelectedSessionIdRef.current = null;
    appliedInitialSessionIdRef.current = initialSessionId ?? null;
    if (forceDraft && !lockSessionId) {
      draftSelectionLockedRef.current = true;
      setSelectedSessionId(null);
    }
  }, [forceDraft, laneId, lockSessionId]);

  // Force draft mode
  useEffect(() => {
    if (!forceDraft || lockSessionId) return;
    pendingSelectedSessionIdRef.current = null;
    draftSelectionLockedRef.current = true;
    setSelectedSessionId(null);
  }, [forceDraft, lockSessionId]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (refreshSessionsTimerRef.current !== null) {
        window.clearTimeout(refreshSessionsTimerRef.current);
        refreshSessionsTimerRef.current = null;
      }
    };
  }, []);

  return {
    sessions,
    setSessions,
    selectedSessionId,
    setSelectedSessionId,
    selectedSession,
    selectedSessionModelId,
    refreshSessions,
    loadHistory,
    optimisticSessionIdsRef,
    pendingSelectedSessionIdRef,
    draftSelectionLockedRef,
    knownSessionIdsRef,
    loadedHistoryRef,
    refreshSessionsTimerRef,
    scheduleSessionsRefresh,
  };
}
