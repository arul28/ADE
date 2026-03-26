import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentChatEventEnvelope } from "../../../../shared/types";
import { deriveChatSubagentSnapshots } from "../chatExecutionSummary";
import { deriveRuntimeState } from "./useDeriveRuntimeState";
import type { DerivedPendingInput } from "../pendingInput";

// ── Hook ────────────────────────────────────────────────────────────

export interface UseAgentChatEventsArgs {
  selectedSessionId: string | null;
}

export interface UseAgentChatEventsReturn {
  selectedEvents: AgentChatEventEnvelope[];
  turnActive: boolean;
  pendingInput: DerivedPendingInput | null;
  selectedSubagentSnapshots: ReturnType<typeof deriveChatSubagentSnapshots>;
  eventsBySession: Record<string, AgentChatEventEnvelope[]>;
  turnActiveBySession: Record<string, boolean>;
  pendingInputsBySession: Record<string, DerivedPendingInput[]>;
  flushQueuedEvents: () => void;
  scheduleQueuedEventFlush: () => void;
  /** Atomically update events for a session, synchronizing the ref and derived state. */
  updateSessionEvents: (sessionId: string, events: AgentChatEventEnvelope[]) => void;
  /** Clear all events and derived state for a session atomically. */
  clearSessionEvents: (sessionId: string) => void;
  /** Remove a single pending input by itemId without touching events. */
  removePendingInput: (sessionId: string, itemId: string) => void;
  eventsBySessionRef: React.MutableRefObject<Record<string, AgentChatEventEnvelope[]>>;
  pendingEventQueueRef: React.MutableRefObject<AgentChatEventEnvelope[]>;
  eventFlushTimerRef: React.MutableRefObject<number | null>;
}

export function useAgentChatEvents({
  selectedSessionId,
}: UseAgentChatEventsArgs): UseAgentChatEventsReturn {
  const [eventsBySession, setEventsBySession] = useState<Record<string, AgentChatEventEnvelope[]>>({});
  const [turnActiveBySession, setTurnActiveBySession] = useState<Record<string, boolean>>({});
  const [pendingInputsBySession, setPendingInputsBySession] = useState<Record<string, DerivedPendingInput[]>>({});

  const eventsBySessionRef = useRef<Record<string, AgentChatEventEnvelope[]>>({});
  const pendingEventQueueRef = useRef<AgentChatEventEnvelope[]>([]);
  const eventFlushTimerRef = useRef<number | null>(null);

  // ── Derived values ────────────────────────────────────────────────

  const selectedEvents = selectedSessionId ? eventsBySession[selectedSessionId] ?? [] : [];
  const selectedSubagentSnapshots = useMemo(() => deriveChatSubagentSnapshots(selectedEvents), [selectedEvents]);
  const turnActive = selectedSessionId ? (turnActiveBySession[selectedSessionId] ?? false) : false;
  const pendingInput = selectedSessionId ? (pendingInputsBySession[selectedSessionId]?.[0] ?? null) : null;

  // ── Synchronized writers ────────────────────────────────────────────

  /** Atomically update events for a session, synchronizing the ref and all derived state. */
  const updateSessionEvents = useCallback((sessionId: string, events: AgentChatEventEnvelope[]) => {
    const derived = deriveRuntimeState(events);
    eventsBySessionRef.current = { ...eventsBySessionRef.current, [sessionId]: events };
    setEventsBySession((prev) => ({ ...prev, [sessionId]: events }));
    setTurnActiveBySession((prev) => ({ ...prev, [sessionId]: derived.turnActive }));
    setPendingInputsBySession((prev) => ({ ...prev, [sessionId]: derived.pendingInputs }));
  }, []);

  /** Clear all events and derived state for a session atomically. */
  const clearSessionEvents = useCallback((sessionId: string) => {
    eventsBySessionRef.current = { ...eventsBySessionRef.current, [sessionId]: [] };
    setEventsBySession((prev) => ({ ...prev, [sessionId]: [] }));
    setTurnActiveBySession((prev) => ({ ...prev, [sessionId]: false }));
    setPendingInputsBySession((prev) => ({ ...prev, [sessionId]: [] }));
  }, []);

  /** Remove a single pending input by itemId without touching events or turnActive. */
  const removePendingInput = useCallback((sessionId: string, itemId: string) => {
    setPendingInputsBySession((prev) => ({
      ...prev,
      [sessionId]: (prev[sessionId] ?? []).filter((e) => e.itemId !== itemId),
    }));
  }, []);

  // ── Flush queued events ───────────────────────────────────────────

  const flushQueuedEvents = useCallback(() => {
    const queued = pendingEventQueueRef.current;
    if (!queued.length) return;
    pendingEventQueueRef.current = [];

    let next = eventsBySessionRef.current;
    const touchedSessionIds = new Set<string>();

    for (const envelope of queued) {
      const sessionId = envelope.sessionId;
      const sessionEvents = next === eventsBySessionRef.current
        ? (eventsBySessionRef.current[sessionId] ?? [])
        : (next[sessionId] ?? []);
      const updated = [...sessionEvents, envelope];
      if (next === eventsBySessionRef.current) {
        next = { ...eventsBySessionRef.current };
      }
      next[sessionId] = updated;
      touchedSessionIds.add(sessionId);
    }

    if (!touchedSessionIds.size) return;

    eventsBySessionRef.current = next;

    const activePatch: Record<string, boolean> = {};
    const pendingInputPatch: Record<string, DerivedPendingInput[]> = {};
    for (const sessionId of touchedSessionIds) {
      const derived = deriveRuntimeState(next[sessionId] ?? []);
      activePatch[sessionId] = derived.turnActive;
      pendingInputPatch[sessionId] = derived.pendingInputs;
    }

    setEventsBySession(next);
    setTurnActiveBySession((activePrev) => ({ ...activePrev, ...activePatch }));
    setPendingInputsBySession((pendingPrev) => ({ ...pendingPrev, ...pendingInputPatch }));
  }, []);

  const scheduleQueuedEventFlush = useCallback(() => {
    if (eventFlushTimerRef.current != null) return;
    eventFlushTimerRef.current = window.setTimeout(() => {
      eventFlushTimerRef.current = null;
      flushQueuedEvents();
    }, 16);
  }, [flushQueuedEvents]);

  // ── Timer cleanup on unmount ──────────────────────────────────────

  useEffect(() => {
    return () => {
      if (eventFlushTimerRef.current !== null) {
        window.clearTimeout(eventFlushTimerRef.current);
        eventFlushTimerRef.current = null;
      }
      pendingEventQueueRef.current = [];
    };
  }, []);

  return {
    selectedEvents,
    turnActive,
    pendingInput,
    selectedSubagentSnapshots,
    eventsBySession,
    turnActiveBySession,
    pendingInputsBySession,
    flushQueuedEvents,
    scheduleQueuedEventFlush,
    updateSessionEvents,
    clearSessionEvents,
    removePendingInput,
    eventsBySessionRef,
    pendingEventQueueRef,
    eventFlushTimerRef,
  };
}
