import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

/**
 * Ephemeral, renderer-only signal: which lanes currently have an AI auto-naming
 * pass in flight. Auto-created lanes are given a deterministic fallback name
 * immediately and the AI identity is applied later; while that background pass
 * runs, lane labels mask the fallback with an animated "Naming lane…" state.
 * This store bridges the draft-launch flow (which owns the naming lifecycle)
 * and lane labels elsewhere in the renderer.
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
