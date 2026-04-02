import { create } from "zustand";
import type { KeybindingsSnapshot, LaneSummary, ProjectInfo, ProviderMode } from "../../shared/types";
import { MODEL_REGISTRY, type ModelDescriptor } from "../../shared/modelRegistry";

export type ThemeId = "dark" | "light";
export const THEME_IDS: ThemeId[] = ["dark", "light"];
export type TerminalAttentionIndicator = "none" | "running-active" | "running-needs-attention";
export type WorkViewMode = "tabs" | "grid";
export type WorkStatusFilter = "all" | "running" | "awaiting-input" | "ended";
export type WorkDraftKind = "chat" | "cli" | "shell";
/** How sessions are grouped in the Work sidebar list. */
export type WorkSessionListOrganization =
  | "all-lanes-by-status"
  | "by-lane"
  | "by-time";
export type WorkProjectViewState = {
  openItemIds: string[];
  activeItemId: string | null;
  selectedItemId: string | null;
  viewMode: WorkViewMode;
  draftKind: WorkDraftKind;
  laneFilter: string;
  statusFilter: WorkStatusFilter;
  search: string;
  /** Session list grouping mode. */
  sessionListOrganization: WorkSessionListOrganization;
  /** Lane ids collapsed in "by-lane" folder view (others expanded). */
  workCollapsedLaneIds: string[];
  /** When true, sessions sidebar is hidden for a full-width content area (persisted per project). */
  workFocusSessionsHidden: boolean;
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
    sessionListOrganization: "by-time",
    workCollapsedLaneIds: [],
    workFocusSessionsHidden: false,
  };
}

function normalizeProjectKey(projectRoot: string | null | undefined): string {
  return typeof projectRoot === "string" ? projectRoot.trim() : "";
}

function normalizeLaneWorkScopeKey(projectRoot: string | null | undefined, laneId: string | null | undefined): string {
  const projectKey = normalizeProjectKey(projectRoot);
  const normalizedLaneId = typeof laneId === "string" ? laneId.trim() : "";
  if (!projectKey || !normalizedLaneId) return "";
  return `${projectKey}::${normalizedLaneId}`;
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
  projectHydrated: boolean;
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
  laneWorkViewByScope: Record<string, WorkProjectViewState>;

  setProject: (project: ProjectInfo | null) => void;
  setProjectHydrated: (hydrated: boolean) => void;
  setShowWelcome: (show: boolean) => void;
  setLanes: (lanes: LaneSummary[]) => void;
  selectLane: (laneId: string | null) => void;
  setLaneInspectorTab: (laneId: string, tab: LaneInspectorTab) => void;
  clearLaneInspectorTab: (laneId: string) => void;
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
  getLaneWorkViewState: (projectRoot: string | null | undefined, laneId: string | null | undefined) => WorkProjectViewState;
  setLaneWorkViewState: (
    projectRoot: string | null | undefined,
    laneId: string | null | undefined,
    next:
      | Partial<WorkProjectViewState>
      | ((prev: WorkProjectViewState) => WorkProjectViewState)
  ) => void;
  refreshProviderMode: () => Promise<void>;
  refreshKeybindings: () => Promise<void>;

  refreshProject: () => Promise<void>;
  refreshLanes: (options?: { includeStatus?: boolean }) => Promise<void>;
  openRepo: () => Promise<ProjectInfo | null>;
  switchProjectToPath: (rootPath: string) => Promise<void>;
  closeProject: () => Promise<void>;
};

export type LaneInspectorTab = "terminals" | "context" | "stack" | "merge";

let warmLaneStatusTimer: number | null = null;
let warmProviderModeTimer: number | null = null;

function scheduleProjectHydration(get: () => AppState) {
  if (warmLaneStatusTimer != null) {
    window.clearTimeout(warmLaneStatusTimer);
  }
  if (warmProviderModeTimer != null) {
    window.clearTimeout(warmProviderModeTimer);
  }

  warmLaneStatusTimer = window.setTimeout(() => {
    warmLaneStatusTimer = null;
    void get().refreshLanes({ includeStatus: true });
  }, 1_200);

  warmProviderModeTimer = window.setTimeout(() => {
    warmProviderModeTimer = null;
    void get().refreshProviderMode();
  }, 1_800);
}

export const useAppStore = create<AppState>((set, get) => ({
  project: null,
  projectHydrated: false,
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
  laneWorkViewByScope: {},

  setProject: (project) => set({ project }),
  setProjectHydrated: (projectHydrated) => set({ projectHydrated }),
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
  clearLaneInspectorTab: (laneId) =>
    set((prev) => {
      const { [laneId]: _, ...rest } = prev.laneInspectorTabs;
      return { laneInspectorTabs: rest };
    }),
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
  getLaneWorkViewState: (projectRoot, laneId) => {
    const key = normalizeLaneWorkScopeKey(projectRoot, laneId);
    if (!key) return createDefaultWorkProjectViewState();
    return get().laneWorkViewByScope[key] ?? createDefaultWorkProjectViewState();
  },
  setLaneWorkViewState: (projectRoot, laneId, next) => {
    const key = normalizeLaneWorkScopeKey(projectRoot, laneId);
    if (!key) return;
    set((prev) => {
      const current = prev.laneWorkViewByScope[key] ?? createDefaultWorkProjectViewState();
      const updated =
        typeof next === "function"
          ? next(current)
          : {
              ...current,
              ...next,
            };
      return {
        laneWorkViewByScope: {
          ...prev.laneWorkViewByScope,
          [key]: updated,
        },
      };
    });
  },

  refreshProject: async () => {
    const project = await window.ade.app.getProject();
    set({ project, projectHydrated: true });
  },

  refreshLanes: async (options) => {
    const requestedProjectKey = normalizeProjectKey(get().project?.rootPath);
    const lanes = await window.ade.lanes.list({
      includeArchived: false,
      includeStatus: options?.includeStatus ?? true,
    });
    const projectKey = normalizeProjectKey(get().project?.rootPath);
    if (projectKey !== requestedProjectKey) {
      return;
    }
    const selected = get().selectedLaneId;
    const runLane = get().runLaneId;
    const nextSelected = selected && lanes.some((l) => l.id === selected) ? selected : lanes[0]?.id ?? null;
    const nextRunLane = runLane && lanes.some((l) => l.id === runLane) ? runLane : nextSelected;
    set((prev) => {
      const allowed = new Set(lanes.map((lane) => lane.id));
      const nextTabs: Record<string, LaneInspectorTab> = {};
      const nextLaneWorkViews: Record<string, WorkProjectViewState> = {};
      for (const [laneId, tab] of Object.entries(prev.laneInspectorTabs)) {
        if (allowed.has(laneId)) nextTabs[laneId] = tab as LaneInspectorTab;
      }
      for (const [scopeKey, viewState] of Object.entries(prev.laneWorkViewByScope)) {
        if (!projectKey || !scopeKey.startsWith(`${projectKey}::`)) {
          nextLaneWorkViews[scopeKey] = viewState;
          continue;
        }
        const laneId = scopeKey.slice(projectKey.length + 2);
        if (allowed.has(laneId)) {
          nextLaneWorkViews[scopeKey] = viewState;
        }
      }
      return {
        lanes,
        selectedLaneId: nextSelected,
        runLaneId: nextRunLane,
        laneInspectorTabs: nextTabs,
        laneWorkViewByScope: nextLaneWorkViews,
      };
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
      (aiStatus.providerConnections?.claude.authAvailable ||
        aiStatus.providerConnections?.codex.authAvailable ||
        aiStatus.providerConnections?.cursor.authAvailable ||
        aiStatus.availableProviders.claude ||
        aiStatus.availableProviders.codex ||
        aiStatus.availableProviders.cursor ||
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
      projectHydrated: true,
      showWelcome: false,
      lanes: [],
      selectedLaneId: null,
      runLaneId: null,
      focusedSessionId: null,
      laneInspectorTabs: {},
      keybindings: null,
      terminalAttention: EMPTY_TERMINAL_ATTENTION
    });
    void Promise.allSettled([
      get().refreshLanes({ includeStatus: false }),
      get().refreshKeybindings()
    ]);
    scheduleProjectHydration(get);
    return project;
  },

  switchProjectToPath: async (rootPath: string) => {
    const project = await window.ade.project.switchToPath(rootPath);
    set({
      project,
      projectHydrated: true,
      showWelcome: false,
      lanes: [],
      selectedLaneId: null,
      runLaneId: null,
      focusedSessionId: null,
      laneInspectorTabs: {},
      keybindings: null,
      terminalAttention: EMPTY_TERMINAL_ATTENTION
    });
    void Promise.allSettled([
      get().refreshLanes({ includeStatus: false }),
      get().refreshKeybindings()
    ]);
    scheduleProjectHydration(get);
  },

  closeProject: async () => {
    await window.ade.project.closeCurrent();
    set({
      project: null,
      projectHydrated: true,
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
