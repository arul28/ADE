import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

/**
 * Ephemeral, renderer-only signal: which lanes currently have an AI auto-naming
 * pass in flight. Auto-created lanes are given a deterministic name immediately
 * and the AI name is applied later via `lanes.rename`; while that background pass
 * runs, session cards show an "Auto-naming…" status in place of the last-output
 * line. This store is the bridge between the draft-launch flow (which owns the
 * naming lifecycle) and the cards (which live in a separate component tree).
 */
type LaneNamingState = {
  naming: Record<string, true>;
  setNaming: (laneId: string, on: boolean) => void;
};

const laneNamingStore = createStore<LaneNamingState>((set) => ({
  naming: {},
  setNaming: (laneId, on) =>
    set((state) => {
      const active = Boolean(state.naming[laneId]);
      if (on === active) return state;
      const next = { ...state.naming };
      if (on) next[laneId] = true;
      else delete next[laneId];
      return { naming: next };
    }),
}));

/** Imperative setter for the draft-launch flow (no React context needed). */
export function setLaneNaming(laneId: string, on: boolean): void {
  laneNamingStore.getState().setNaming(laneId, on);
}

/** Subscribe a component to whether a given lane is mid auto-naming. */
export function useLaneNaming(laneId: string | null | undefined): boolean {
  return useStore(laneNamingStore, (state) => (laneId ? Boolean(state.naming[laneId]) : false));
}
