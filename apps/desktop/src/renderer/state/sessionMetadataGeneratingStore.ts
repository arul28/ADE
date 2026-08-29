import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import type { AgentChatSessionMetadataField } from "../../shared/types/chat";
import { useLaneNaming } from "./laneNamingStore";

/**
 * Ephemeral, renderer-only signal: which chat is mid explicit metadata
 * regeneration, and which of the three fields the user asked to refresh.
 * Session cards, the work-surface header, and lane labels mask those fields
 * with the same in-place naming animation auto-create uses.
 */
export type SessionMetadataGeneratingEntry = {
  fields: readonly AgentChatSessionMetadataField[];
  laneId: string;
};

type SessionMetadataGeneratingState = {
  bySession: Record<string, SessionMetadataGeneratingEntry>;
  setGenerating: (sessionId: string, entry: SessionMetadataGeneratingEntry | null) => void;
};

const sessionMetadataGeneratingStore = createStore<SessionMetadataGeneratingState>((set) => ({
  bySession: {},
  setGenerating: (sessionId, entry) =>
    set((state) => {
      const id = sessionId.trim();
      if (!id) return state;
      const current = state.bySession[id];
      if (!entry) {
        if (!current) return state;
        const next = { ...state.bySession };
        delete next[id];
        return { bySession: next };
      }
      if (
        current
        && current.laneId === entry.laneId
        && current.fields.length === entry.fields.length
        && current.fields.every((field, index) => field === entry.fields[index])
      ) {
        return state;
      }
      return {
        bySession: {
          ...state.bySession,
          [id]: { fields: [...entry.fields], laneId: entry.laneId },
        },
      };
    }),
}));

export function setSessionMetadataGenerating(
  sessionId: string,
  entry: SessionMetadataGeneratingEntry | null,
): void {
  sessionMetadataGeneratingStore.getState().setGenerating(sessionId, entry);
}

export function getSessionMetadataGenerating(
  sessionId: string,
): SessionMetadataGeneratingEntry | null {
  return sessionMetadataGeneratingStore.getState().bySession[sessionId] ?? null;
}

export function useSessionMetadataGenerating(
  sessionId: string | null | undefined,
): SessionMetadataGeneratingEntry | null {
  return useStore(
    sessionMetadataGeneratingStore,
    (state) => (sessionId ? state.bySession[sessionId] ?? null : null),
  );
}

export function useSessionFieldGenerating(
  sessionId: string | null | undefined,
  field: AgentChatSessionMetadataField,
): boolean {
  return useStore(sessionMetadataGeneratingStore, (state) => {
    if (!sessionId) return false;
    return state.bySession[sessionId]?.fields.includes(field) ?? false;
  });
}

/** True when any chat in this lane is regenerating the lane name. */
export function useLaneNameGenerating(laneId: string | null | undefined): boolean {
  return useStore(sessionMetadataGeneratingStore, (state) => {
    if (!laneId) return false;
    return Object.values(state.bySession).some(
      (entry) => entry.laneId === laneId && entry.fields.includes("laneName"),
    );
  });
}

/** True when auto-create or explicit regen is writing this lane's name. */
export function useLaneNamePending(laneId: string | null | undefined): boolean {
  const autoNaming = useLaneNaming(laneId);
  const regenerating = useLaneNameGenerating(laneId);
  return autoNaming || regenerating;
}
