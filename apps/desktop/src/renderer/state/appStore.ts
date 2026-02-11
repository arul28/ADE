import { create } from "zustand";

export type Project = {
  rootPath: string;
  displayName: string;
  baseRef: string;
};

export type LaneSummary = {
  id: string;
  name: string;
  description?: string;
};

type AppState = {
  project: Project | null;
  lanes: LaneSummary[];
  selectedLaneId: string | null;

  setProject: (project: Project) => void;
  selectLane: (laneId: string) => void;
};

export const useAppStore = create<AppState>((set) => ({
  project: null,
  lanes: [
    { id: "lane-1", name: "lane/first", description: "Placeholder lane" },
    { id: "lane-2", name: "lane/second", description: "Placeholder lane" },
    { id: "lane-3", name: "lane/third", description: "Placeholder lane" }
  ],
  selectedLaneId: "lane-1",

  setProject: (project) => set({ project }),
  selectLane: (laneId) => set({ selectedLaneId: laneId })
}));

