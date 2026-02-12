import { create } from "zustand";
import type { LaneSummary, ProjectInfo, ProviderMode } from "../../shared/types";

export type ThemeId = "e-paper" | "bloomberg" | "github" | "rainbow" | "sky" | "pats";
export const THEME_IDS: ThemeId[] = ["e-paper", "bloomberg", "github", "rainbow", "sky", "pats"];

function readInitialTheme(): ThemeId {
  try {
    const raw = window.localStorage.getItem("ade.theme") as ThemeId;
    if (THEME_IDS.includes(raw)) return raw;
  } catch {
    // ignore
  }
  return "e-paper";
}

function persistTheme(theme: ThemeId) {
  try {
    window.localStorage.setItem("ade.theme", theme);
  } catch {
    // ignore
  }
}

type AppState = {
  project: ProjectInfo | null;
  lanes: LaneSummary[];
  selectedLaneId: string | null;
  runLaneId: string | null;
  focusedSessionId: string | null;
  theme: ThemeId;
  providerMode: ProviderMode;

  setProject: (project: ProjectInfo) => void;
  setLanes: (lanes: LaneSummary[]) => void;
  selectLane: (laneId: string | null) => void;
  selectRunLane: (laneId: string | null) => void;
  focusSession: (sessionId: string | null) => void;
  setTheme: (theme: ThemeId) => void;
  refreshProviderMode: () => Promise<void>;

  refreshProject: () => Promise<void>;
  refreshLanes: () => Promise<void>;
  openRepo: () => Promise<void>;
};

export const useAppStore = create<AppState>((set, get) => ({
  project: null,
  lanes: [],
  selectedLaneId: null,
  runLaneId: null,
  focusedSessionId: null,
  theme: readInitialTheme(),
  providerMode: "guest",

  setProject: (project) => set({ project }),
  setLanes: (lanes) => set({ lanes }),
  selectLane: (laneId) => set({ selectedLaneId: laneId }),
  selectRunLane: (laneId) => set({ runLaneId: laneId }),
  focusSession: (sessionId) => set({ focusedSessionId: sessionId }),
  setTheme: (theme) => {
    persistTheme(theme);
    set({ theme });
  },

  refreshProject: async () => {
    const project = await window.ade.app.getProject();
    set({ project });
  },

  refreshLanes: async () => {
    const lanes = await window.ade.lanes.list({ includeArchived: false });
    const selected = get().selectedLaneId;
    const runLane = get().runLaneId;
    const nextSelected = selected && lanes.some((l) => l.id === selected) ? selected : lanes[0]?.id ?? null;
    const nextRunLane = runLane && lanes.some((l) => l.id === runLane) ? runLane : nextSelected;
    set({ lanes, selectedLaneId: nextSelected, runLaneId: nextRunLane });
  },

  refreshProviderMode: async () => {
    const snapshot = await window.ade.projectConfig.get();
    set({ providerMode: snapshot.effective.providerMode ?? "guest" });
  },

  openRepo: async () => {
    const project = await window.ade.project.openRepo();
    set({ project, lanes: [], selectedLaneId: null, runLaneId: null, focusedSessionId: null });
    // Refresh lanes for the newly opened project.
    await get().refreshLanes();
    await get().refreshProviderMode().catch(() => { });
  }
}));
