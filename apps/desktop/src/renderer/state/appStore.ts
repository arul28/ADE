import { create } from "zustand";
import type { KeybindingsSnapshot, LaneSummary, ProjectInfo, ProviderMode } from "../../shared/types";

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
  laneInspectorTabs: Record<string, LaneInspectorTab>;
  keybindings: KeybindingsSnapshot | null;

  setProject: (project: ProjectInfo) => void;
  setLanes: (lanes: LaneSummary[]) => void;
  selectLane: (laneId: string | null) => void;
  setLaneInspectorTab: (laneId: string, tab: LaneInspectorTab) => void;
  selectRunLane: (laneId: string | null) => void;
  focusSession: (sessionId: string | null) => void;
  setTheme: (theme: ThemeId) => void;
  refreshProviderMode: () => Promise<void>;
  refreshKeybindings: () => Promise<void>;

  refreshProject: () => Promise<void>;
  refreshLanes: () => Promise<void>;
  openRepo: () => Promise<void>;
  switchProjectToPath: (rootPath: string) => Promise<void>;
};

export type LaneInspectorTab = "terminals" | "context" | "stack" | "merge";

export const useAppStore = create<AppState>((set, get) => ({
  project: null,
  lanes: [],
  selectedLaneId: null,
  runLaneId: null,
  focusedSessionId: null,
  theme: readInitialTheme(),
  providerMode: "guest",
  laneInspectorTabs: {},
  keybindings: null,

  setProject: (project) => set({ project }),
  setLanes: (lanes) => set({ lanes }),
  selectLane: (laneId) => set({ selectedLaneId: laneId }),
  setLaneInspectorTab: (laneId, tab) =>
    set((prev) => ({
      laneInspectorTabs: {
        ...prev.laneInspectorTabs,
        [laneId]: tab
      }
    })),
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
    set((prev) => {
      const allowed = new Set(lanes.map((lane) => lane.id));
      const nextTabs: Record<string, LaneInspectorTab> = {};
      for (const [laneId, tab] of Object.entries(prev.laneInspectorTabs)) {
        if (allowed.has(laneId)) nextTabs[laneId] = tab as LaneInspectorTab;
      }
      return { lanes, selectedLaneId: nextSelected, runLaneId: nextRunLane, laneInspectorTabs: nextTabs };
    });
  },

  refreshProviderMode: async () => {
    const snapshot = await window.ade.projectConfig.get();
    set({ providerMode: snapshot.effective.providerMode ?? "guest" });
  },

  refreshKeybindings: async () => {
    const keybindings = await window.ade.keybindings.get();
    set({ keybindings });
  },

  openRepo: async () => {
    const project = await window.ade.project.openRepo();
    set({ project, lanes: [], selectedLaneId: null, runLaneId: null, focusedSessionId: null, laneInspectorTabs: {}, keybindings: null });
    // Refresh lanes for the newly opened project.
    await get().refreshLanes();
    await get().refreshProviderMode().catch(() => { });
    await get().refreshKeybindings().catch(() => { });
  },

  switchProjectToPath: async (rootPath: string) => {
    const project = await window.ade.project.switchToPath(rootPath);
    set({ project, lanes: [], selectedLaneId: null, runLaneId: null, focusedSessionId: null, laneInspectorTabs: {}, keybindings: null });
    await get().refreshLanes();
    await get().refreshProviderMode().catch(() => { });
    await get().refreshKeybindings().catch(() => { });
  }
}));
