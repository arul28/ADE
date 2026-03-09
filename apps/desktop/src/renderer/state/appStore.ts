import { create } from "zustand";
import type { KeybindingsSnapshot, LaneSummary, ProjectInfo, ProviderMode } from "../../shared/types";
import { MODEL_REGISTRY, type ModelDescriptor } from "../../shared/modelRegistry";

export type ThemeId = "dark" | "light";
export const THEME_IDS: ThemeId[] = ["dark", "light"];
export type TerminalAttentionIndicator = "none" | "running-active" | "running-needs-attention";
export type WorkViewMode = "tabs" | "grid";
export type WorkStatusFilter = "all" | "running" | "awaiting-input" | "ended";
export type WorkDraftKind = "chat" | "cli" | "shell";
export type WorkProjectViewState = {
  openItemIds: string[];
  activeItemId: string | null;
  selectedItemId: string | null;
  viewMode: WorkViewMode;
  draftKind: WorkDraftKind;
  laneFilter: string;
  statusFilter: WorkStatusFilter;
  search: string;
};
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

function createDefaultWorkProjectViewState(): WorkProjectViewState {
  return {
    openItemIds: [],
    activeItemId: null,
    selectedItemId: null,
    viewMode: "tabs",
    draftKind: "chat",
    laneFilter: "all",
    statusFilter: "all",
    search: "",
  };
}

function normalizeProjectKey(projectRoot: string | null | undefined): string {
  return typeof projectRoot === "string" ? projectRoot.trim() : "";
}

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
  /** True when the user removed all projects — forces welcome screen even though backend still has a project loaded. */
  showWelcome: boolean;
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
  workViewByProject: Record<string, WorkProjectViewState>;

  setProject: (project: ProjectInfo | null) => void;
  setShowWelcome: (show: boolean) => void;
  setLanes: (lanes: LaneSummary[]) => void;
  selectLane: (laneId: string | null) => void;
  setLaneInspectorTab: (laneId: string, tab: LaneInspectorTab) => void;
  selectRunLane: (laneId: string | null) => void;
  focusSession: (sessionId: string | null) => void;
  setTheme: (theme: ThemeId) => void;
  setTerminalAttention: (snapshot: TerminalAttentionSnapshot) => void;
  getWorkViewState: (projectRoot: string | null | undefined) => WorkProjectViewState;
  setWorkViewState: (
    projectRoot: string | null | undefined,
    next:
      | Partial<WorkProjectViewState>
      | ((prev: WorkProjectViewState) => WorkProjectViewState)
  ) => void;
  refreshProviderMode: () => Promise<void>;
  refreshKeybindings: () => Promise<void>;

  refreshProject: () => Promise<void>;
  refreshLanes: () => Promise<void>;
  openRepo: () => Promise<ProjectInfo | null>;
  switchProjectToPath: (rootPath: string) => Promise<void>;
  closeProject: () => Promise<void>;
};

export type LaneInspectorTab = "terminals" | "context" | "stack" | "merge";

export const useAppStore = create<AppState>((set, get) => ({
  project: null,
  showWelcome: true,
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
  workViewByProject: {},

  setProject: (project) => set({ project }),
  setShowWelcome: (showWelcome) => set({ showWelcome }),
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
  getWorkViewState: (projectRoot) => {
    const key = normalizeProjectKey(projectRoot);
    if (!key) return createDefaultWorkProjectViewState();
    return get().workViewByProject[key] ?? createDefaultWorkProjectViewState();
  },
  setWorkViewState: (projectRoot, next) => {
    const key = normalizeProjectKey(projectRoot);
    if (!key) return;
    set((prev) => {
      const current = prev.workViewByProject[key] ?? createDefaultWorkProjectViewState();
      const updated =
        typeof next === "function"
          ? next(current)
          : {
              ...current,
              ...next,
            };
      return {
        workViewByProject: {
          ...prev.workViewByProject,
          [key]: updated,
        },
      };
    });
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
    const [snapshot, aiStatus] = await Promise.all([
      window.ade.projectConfig.get(),
      window.ade.ai.getStatus().catch(() => null),
    ]);
    const configMode = snapshot.effective.providerMode ?? "guest";
    // Auto-elevate to subscription if any AI provider is configured
    const hasProvider =
      aiStatus != null &&
      (aiStatus.availableProviders.claude ||
        aiStatus.availableProviders.codex ||
        (aiStatus.detectedAuth != null && aiStatus.detectedAuth.length > 0));
    set({ providerMode: configMode === "subscription" || hasProvider ? "subscription" : "guest" });
  },

  refreshKeybindings: async () => {
    const keybindings = await window.ade.keybindings.get();
    set({ keybindings });
  },

  openRepo: async () => {
    const project = await window.ade.project.openRepo();
    if (!project) return null;
    set({
      project,
      showWelcome: false,
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
    return project;
  },

  switchProjectToPath: async (rootPath: string) => {
    const project = await window.ade.project.switchToPath(rootPath);
    set({
      project,
      showWelcome: false,
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
  },

  closeProject: async () => {
    await window.ade.project.closeCurrent();
    set({
      project: null,
      showWelcome: true,
      lanes: [],
      selectedLaneId: null,
      runLaneId: null,
      focusedSessionId: null,
      laneInspectorTabs: {},
      keybindings: null,
      terminalAttention: EMPTY_TERMINAL_ATTENTION
    });
  }
}));
