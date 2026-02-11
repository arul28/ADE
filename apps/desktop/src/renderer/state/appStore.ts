import { create } from "zustand";
import type { LaneSummary, ProjectInfo } from "../../shared/types";

type AppState = {
  project: ProjectInfo | null;
  lanes: LaneSummary[];
  selectedLaneId: string | null;
  focusedSessionId: string | null;

  setProject: (project: ProjectInfo) => void;
  setLanes: (lanes: LaneSummary[]) => void;
  selectLane: (laneId: string | null) => void;
  focusSession: (sessionId: string | null) => void;

  refreshProject: () => Promise<void>;
  refreshLanes: () => Promise<void>;
  openRepo: () => Promise<void>;
};

export const useAppStore = create<AppState>((set, get) => ({
  project: null,
  lanes: [],
  selectedLaneId: null,
  focusedSessionId: null,

  setProject: (project) => set({ project }),
  setLanes: (lanes) => set({ lanes }),
  selectLane: (laneId) => set({ selectedLaneId: laneId }),
  focusSession: (sessionId) => set({ focusedSessionId: sessionId }),

  refreshProject: async () => {
    const project = await window.ade.app.getProject();
    set({ project });
  },

  refreshLanes: async () => {
    const lanes = await window.ade.lanes.list({ includeArchived: false });
    const selected = get().selectedLaneId;
    const nextSelected = selected && lanes.some((l) => l.id === selected) ? selected : lanes[0]?.id ?? null;
    set({ lanes, selectedLaneId: nextSelected });
  },

  openRepo: async () => {
    const project = await window.ade.project.openRepo();
    set({ project, lanes: [], selectedLaneId: null, focusedSessionId: null });
    // Refresh lanes for the newly opened project.
    await get().refreshLanes();
  }
}));

