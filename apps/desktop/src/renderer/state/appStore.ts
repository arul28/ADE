import { create } from "zustand";
import type { LaneSummary, ProjectInfo } from "../../shared/types";

type ThemeMode = "dark" | "light";

function readInitialTheme(): ThemeMode {
  try {
    const raw = window.localStorage.getItem("ade.theme");
    if (raw === "dark" || raw === "light") return raw;
  } catch {
    // ignore
  }
  return "dark";
}

function persistTheme(theme: ThemeMode) {
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
  focusedSessionId: string | null;
  theme: ThemeMode;

  setProject: (project: ProjectInfo) => void;
  setLanes: (lanes: LaneSummary[]) => void;
  selectLane: (laneId: string | null) => void;
  focusSession: (sessionId: string | null) => void;
  setTheme: (theme: ThemeMode) => void;
  toggleTheme: () => void;

  refreshProject: () => Promise<void>;
  refreshLanes: () => Promise<void>;
  openRepo: () => Promise<void>;
};

export const useAppStore = create<AppState>((set, get) => ({
  project: null,
  lanes: [],
  selectedLaneId: null,
  focusedSessionId: null,
  theme: readInitialTheme(),

  setProject: (project) => set({ project }),
  setLanes: (lanes) => set({ lanes }),
  selectLane: (laneId) => set({ selectedLaneId: laneId }),
  focusSession: (sessionId) => set({ focusedSessionId: sessionId }),
  setTheme: (theme) => {
    persistTheme(theme);
    set({ theme });
  },
  toggleTheme: () =>
    set((state) => {
      const next = state.theme === "dark" ? "light" : "dark";
      persistTheme(next);
      return { theme: next };
    }),

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
