import { create } from "zustand";
import type { KeybindingsSnapshot, LaneSummary, ProjectInfo, ProviderMode } from "../../shared/types";
import { MODEL_REGISTRY, type ModelDescriptor } from "../../shared/modelRegistry";

export type ThemeId = "dark" | "light";
export const THEME_IDS: ThemeId[] = ["dark", "light"];
export type TerminalAttentionIndicator = "none" | "running-active" | "running-needs-attention";
export type TerminalAttentionSnapshot = {
  runningCount: number;
  activeCount: number;
  needsAttentionCount: number;
  indicator: TerminalAttentionIndicator;
  byLaneId: Record<string, {
    runningCount: number;
    activeCount: number;
    needsAttentionCount: number;
    indicator: TerminalAttentionIndicator;
  }>;
};

const EMPTY_TERMINAL_ATTENTION: TerminalAttentionSnapshot = {
  runningCount: 0,
  activeCount: 0,
  needsAttentionCount: 0,
  indicator: "none",
  byLaneId: {}
};

function readInitialTheme(): ThemeId {
  try {
    const raw = window.localStorage.getItem("ade.theme");
    if (raw === "dark" || raw === "light") return raw as ThemeId;
    // Migrate old themes: dark-ish themes → dark, light-ish → light
    if (raw === "github" || raw === "bloomberg" || raw === "rainbow" || raw === "pats") return "dark";
    if (raw === "e-paper" || raw === "sky") return "light";
  } catch {
    // ignore
  }
  return "dark";
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
  availableModels: ModelDescriptor[];
  laneInspectorTabs: Record<string, LaneInspectorTab>;
  keybindings: KeybindingsSnapshot | null;
  terminalAttention: TerminalAttentionSnapshot;

  setProject: (project: ProjectInfo) => void;
  setLanes: (lanes: LaneSummary[]) => void;
  selectLane: (laneId: string | null) => void;
  setLaneInspectorTab: (laneId: string, tab: LaneInspectorTab) => void;
  selectRunLane: (laneId: string | null) => void;
  focusSession: (sessionId: string | null) => void;
  setTheme: (theme: ThemeId) => void;
  setTerminalAttention: (snapshot: TerminalAttentionSnapshot) => void;
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
  availableModels: [...MODEL_REGISTRY].filter((m) => !m.deprecated),
  laneInspectorTabs: {},
  keybindings: null,
  terminalAttention: EMPTY_TERMINAL_ATTENTION,

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
  setTerminalAttention: (terminalAttention) => set({ terminalAttention }),

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
    set({
      project,
      lanes: [],
      selectedLaneId: null,
      runLaneId: null,
      focusedSessionId: null,
      laneInspectorTabs: {},
      keybindings: null,
      terminalAttention: EMPTY_TERMINAL_ATTENTION
    });
    // Refresh lanes for the newly opened project.
    await get().refreshLanes();
    await get().refreshProviderMode().catch(() => { });
    await get().refreshKeybindings().catch(() => { });
  },

  switchProjectToPath: async (rootPath: string) => {
    const project = await window.ade.project.switchToPath(rootPath);
    set({
      project,
      lanes: [],
      selectedLaneId: null,
      runLaneId: null,
      focusedSessionId: null,
      laneInspectorTabs: {},
      keybindings: null,
      terminalAttention: EMPTY_TERMINAL_ATTENTION
    });
    await get().refreshLanes();
    await get().refreshProviderMode().catch(() => { });
    await get().refreshKeybindings().catch(() => { });
  }
}));
