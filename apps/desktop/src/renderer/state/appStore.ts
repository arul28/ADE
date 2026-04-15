import { create } from "zustand";
import type { KeybindingsSnapshot, LaneListSnapshot, LaneSummary, ProjectInfo, ProviderMode } from "../../shared/types";
import { MODEL_REGISTRY, type ModelDescriptor } from "../../shared/modelRegistry";
import { extractError } from "../lib/format";
import { getAiStatusCached, invalidateAiDiscoveryCache } from "../lib/aiDiscoveryCache";
import { getProjectConfigCached, invalidateProjectConfigCache } from "../lib/projectConfigCache";

export type ThemeId = "dark" | "light";
export const THEME_IDS: ThemeId[] = ["dark", "light"];
export const DEFAULT_TERMINAL_FONT_FAMILY = [
  "ui-monospace",
  "SFMono-Regular",
  "Menlo",
  "Monaco",
  "\"Cascadia Mono\"",
  "\"JetBrains Mono\"",
  "\"Geist Mono\"",
  "monospace",
].join(", ");
export type TerminalPreferences = {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  scrollback: number;
};
export const DEFAULT_TERMINAL_PREFERENCES: TerminalPreferences = {
  fontFamily: DEFAULT_TERMINAL_FONT_FAMILY,
  fontSize: 12.5,
  lineHeight: 1.25,
  scrollback: 10_000,
};
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
  /** Tab group ids collapsed in the Work tab strip. */
  workCollapsedTabGroupIds: string[];
  /** Section ids collapsed in status/time sidebar groupings (e.g. "status:running", "time:today"). */
  workCollapsedSectionIds: string[];
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

const WORK_VIEW_STORAGE_KEY = "ade.workViewState.v1";
const TERMINAL_PREFERENCES_STORAGE_KEY = "ade.terminalPreferences.v1";
const USER_PREFERENCES_STORAGE_KEY = "ade.userPreferences.v1";

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
    sessionListOrganization: "by-lane",
    workCollapsedLaneIds: [],
    workCollapsedTabGroupIds: [],
    workCollapsedSectionIds: [],
    workFocusSessionsHidden: false,
  };
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function normalizeOptionalString(value: unknown): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.length > 0 ? normalized : null;
}

function normalizeWorkProjectViewState(value: unknown): WorkProjectViewState {
  const candidate = value && typeof value === "object"
    ? value as Partial<WorkProjectViewState>
    : {};
  return {
    openItemIds: normalizeStringArray(candidate.openItemIds),
    activeItemId: normalizeOptionalString(candidate.activeItemId),
    selectedItemId: normalizeOptionalString(candidate.selectedItemId),
    viewMode: candidate.viewMode === "grid" ? "grid" : "tabs",
    draftKind:
      candidate.draftKind === "cli" || candidate.draftKind === "shell"
        ? candidate.draftKind
        : "chat",
    laneFilter: normalizeOptionalString(candidate.laneFilter) ?? "all",
    statusFilter:
      candidate.statusFilter === "running"
      || candidate.statusFilter === "awaiting-input"
      || candidate.statusFilter === "ended"
        ? candidate.statusFilter
        : "all",
    search: typeof candidate.search === "string" ? candidate.search : "",
    sessionListOrganization:
      candidate.sessionListOrganization === "all-lanes-by-status"
      || candidate.sessionListOrganization === "by-time"
        ? candidate.sessionListOrganization
        : "by-lane",
    workCollapsedLaneIds: normalizeStringArray(candidate.workCollapsedLaneIds),
    workCollapsedTabGroupIds: normalizeStringArray(candidate.workCollapsedTabGroupIds),
    workCollapsedSectionIds: normalizeStringArray(candidate.workCollapsedSectionIds),
    workFocusSessionsHidden: candidate.workFocusSessionsHidden === true,
  };
}

function readPersistedWorkViewState(): {
  workViewByProject: Record<string, WorkProjectViewState>;
  laneWorkViewByScope: Record<string, WorkProjectViewState>;
} {
  try {
    const raw = window.localStorage.getItem(WORK_VIEW_STORAGE_KEY);
    if (!raw) {
      return { workViewByProject: {}, laneWorkViewByScope: {} };
    }
    const parsed = JSON.parse(raw) as {
      workViewByProject?: Record<string, unknown>;
      laneWorkViewByScope?: Record<string, unknown>;
    };
    const workViewByProject: Record<string, WorkProjectViewState> = {};
    const laneWorkViewByScope: Record<string, WorkProjectViewState> = {};
    for (const [projectRoot, viewState] of Object.entries(parsed.workViewByProject ?? {})) {
      const key = normalizeProjectKey(projectRoot);
      if (!key) continue;
      workViewByProject[key] = normalizeWorkProjectViewState(viewState);
    }
    for (const [scopeKey, viewState] of Object.entries(parsed.laneWorkViewByScope ?? {})) {
      const dividerIndex = scopeKey.indexOf("::");
      if (dividerIndex <= 0 || dividerIndex >= scopeKey.length - 2) continue;
      const projectRoot = normalizeProjectKey(scopeKey.slice(0, dividerIndex));
      const laneId = scopeKey.slice(dividerIndex + 2).trim();
      if (!projectRoot || !laneId) continue;
      laneWorkViewByScope[`${projectRoot}::${laneId}`] = normalizeWorkProjectViewState(viewState);
    }
    return { workViewByProject, laneWorkViewByScope };
  } catch {
    return { workViewByProject: {}, laneWorkViewByScope: {} };
  }
}

let _debouncePersistTimer: ReturnType<typeof setTimeout> | null = null;

function persistWorkViewState(args: {
  workViewByProject: Record<string, WorkProjectViewState>;
  laneWorkViewByScope: Record<string, WorkProjectViewState>;
}): void {
  if (_debouncePersistTimer != null) {
    clearTimeout(_debouncePersistTimer);
    _debouncePersistTimer = null;
  }
  try {
    window.localStorage.setItem(WORK_VIEW_STORAGE_KEY, JSON.stringify(args));
  } catch {
    // ignore
  }
}

/** Debounced persist: batches rapid setter calls into a single localStorage write. */
function debouncedPersistWorkViewState(args: {
  workViewByProject: Record<string, WorkProjectViewState>;
  laneWorkViewByScope: Record<string, WorkProjectViewState>;
}): void {
  if (_debouncePersistTimer != null) clearTimeout(_debouncePersistTimer);
  _debouncePersistTimer = setTimeout(() => {
    _debouncePersistTimer = null;
    persistWorkViewState(args);
  }, 300);
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

type PersistedUserPreferences = {
  theme: ThemeId;
  terminalPreferences: TerminalPreferences;
  smartTooltipsEnabled: boolean;
};

function coerceTheme(value: unknown): ThemeId | null {
  if (value === "dark" || value === "light") return value;
  if (value === "github" || value === "bloomberg" || value === "rainbow" || value === "pats") return "dark";
  if (value === "e-paper" || value === "sky") return "light";
  return null;
}

function readUnifiedUserPreferences(): PersistedUserPreferences | null {
  try {
    const raw = window.localStorage.getItem(USER_PREFERENCES_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<PersistedUserPreferences>;
    return {
      theme: coerceTheme(parsed.theme) ?? "dark",
      terminalPreferences: normalizeTerminalPreferences(parsed.terminalPreferences),
      smartTooltipsEnabled: parsed.smartTooltipsEnabled !== false,
    };
  } catch {
    return null;
  }
}

function readLegacyUserPreferences(): PersistedUserPreferences {
  let theme: ThemeId = "dark";
  try {
    theme = coerceTheme(window.localStorage.getItem("ade.theme")) ?? "dark";
  } catch {
    // ignore
  }
  let terminalPreferences: TerminalPreferences = { ...DEFAULT_TERMINAL_PREFERENCES };
  try {
    const raw = window.localStorage.getItem(TERMINAL_PREFERENCES_STORAGE_KEY);
    if (raw) terminalPreferences = normalizeTerminalPreferences(JSON.parse(raw));
  } catch {
    // ignore
  }
  let smartTooltipsEnabled = true;
  try {
    if (window.localStorage.getItem("ade.smartTooltips") === "false") smartTooltipsEnabled = false;
  } catch {
    // ignore
  }
  return { theme, terminalPreferences, smartTooltipsEnabled };
}

function persistUserPreferences(prefs: PersistedUserPreferences) {
  try {
    window.localStorage.setItem(USER_PREFERENCES_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // ignore
  }
}

function readInitialUserPreferences(): PersistedUserPreferences {
  const unified = readUnifiedUserPreferences();
  if (unified) return unified;
  const legacy = readLegacyUserPreferences();
  persistUserPreferences(legacy);
  return legacy;
}

const initialPersistedWorkViews = readPersistedWorkViewState();
const initialUserPreferences = readInitialUserPreferences();

function clampTerminalFontSize(value: unknown): number {
  const next = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(next)) return DEFAULT_TERMINAL_PREFERENCES.fontSize;
  return Math.max(10, Math.min(18, Math.round(next * 2) / 2));
}

function clampTerminalLineHeight(value: unknown): number {
  const next = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(next)) return DEFAULT_TERMINAL_PREFERENCES.lineHeight;
  return Math.max(1, Math.min(1.6, Math.round(next * 100) / 100));
}

function clampTerminalScrollback(value: unknown): number {
  const next = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(next)) return DEFAULT_TERMINAL_PREFERENCES.scrollback;
  return Math.max(2000, Math.min(30_000, Math.round(next / 1000) * 1000));
}

function normalizeTerminalFontFamily(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_TERMINAL_PREFERENCES.fontFamily;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : DEFAULT_TERMINAL_PREFERENCES.fontFamily;
}

function normalizeTerminalPreferences(value: unknown): TerminalPreferences {
  const candidate = value && typeof value === "object"
    ? value as Partial<TerminalPreferences>
    : {};
  return {
    fontFamily: normalizeTerminalFontFamily(candidate.fontFamily),
    fontSize: clampTerminalFontSize(candidate.fontSize),
    lineHeight: clampTerminalLineHeight(candidate.lineHeight),
    scrollback: clampTerminalScrollback(candidate.scrollback),
  };
}

type AppState = {
  project: ProjectInfo | null;
  projectHydrated: boolean;
  /** True when the user removed all projects — forces welcome screen even though backend still has a project loaded. */
  showWelcome: boolean;
  projectTransition:
    | {
        kind: "opening" | "switching" | "closing";
        rootPath: string | null;
        startedAtMs: number;
      }
    | null;
  projectTransitionError: string | null;
  isNewTabOpen: boolean;
  laneSnapshots: LaneListSnapshot[];
  lanes: LaneSummary[];
  selectedLaneId: string | null;
  runLaneId: string | null;
  focusedSessionId: string | null;
  projectRevision: number;
  theme: ThemeId;
  terminalPreferences: TerminalPreferences;
  providerMode: ProviderMode;
  availableModels: ModelDescriptor[];
  laneInspectorTabs: Record<string, LaneInspectorTab>;
  keybindings: KeybindingsSnapshot | null;
  terminalAttention: TerminalAttentionSnapshot;
  smartTooltipsEnabled: boolean;
  workViewByProject: Record<string, WorkProjectViewState>;
  laneWorkViewByScope: Record<string, WorkProjectViewState>;

  setProject: (project: ProjectInfo | null) => void;
  setProjectHydrated: (hydrated: boolean) => void;
  setShowWelcome: (show: boolean) => void;
  clearProjectTransitionError: () => void;
  setLanes: (lanes: LaneSummary[]) => void;
  selectLane: (laneId: string | null) => void;
  setLaneInspectorTab: (laneId: string, tab: LaneInspectorTab) => void;
  clearLaneInspectorTab: (laneId: string) => void;
  selectRunLane: (laneId: string | null) => void;
  focusSession: (sessionId: string | null) => void;
  setTheme: (theme: ThemeId) => void;
  setTerminalPreferences: (
    next:
      | Partial<TerminalPreferences>
      | ((prev: TerminalPreferences) => TerminalPreferences)
  ) => void;
  setTerminalAttention: (snapshot: TerminalAttentionSnapshot) => void;
  setSmartTooltipsEnabled: (enabled: boolean) => void;
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

  openNewTab: () => void;
  cancelNewTab: () => void;
  refreshProject: () => Promise<void>;
  refreshLanes: (options?: { includeStatus?: boolean }) => Promise<void>;
  openRepo: () => Promise<ProjectInfo | null>;
  switchProjectToPath: (rootPath: string) => Promise<void>;
  closeProject: () => Promise<void>;
};

export type LaneInspectorTab = "terminals" | "context" | "stack" | "merge";

type LaneRefreshRequest = {
  includeStatus: boolean;
};

let warmupTimer: number | null = null;
/** Monotonic counter incremented before each lane refresh request.
 *  Slower responses whose token doesn't match the latest value are discarded. */
let laneRefreshVersion = 0;
let laneRefreshInFlight: Promise<void> | null = null;
let activeLaneRefreshRequest: LaneRefreshRequest | null = null;
let pendingLaneRefreshRequest: LaneRefreshRequest | null = null;

function normalizeLaneRefreshRequest(options?: { includeStatus?: boolean }): LaneRefreshRequest {
  return { includeStatus: options?.includeStatus ?? true };
}

function mergeLaneRefreshRequests(current: LaneRefreshRequest, next: LaneRefreshRequest): LaneRefreshRequest {
  return {
    includeStatus: current.includeStatus || next.includeStatus,
  };
}

function scheduleProjectHydration(get: () => AppState) {
  if (warmupTimer != null) {
    window.clearTimeout(warmupTimer);
  }
  const delay = Math.max(1_200, 1_800);
  warmupTimer = window.setTimeout(() => {
    warmupTimer = null;
    void get().refreshLanes({ includeStatus: true }).catch((err) => {
      console.debug("Scheduled lane refresh failed:", err);
    });
    void get().refreshProviderMode();
  }, delay);
}

function formatProjectTransitionError(
  kind: "opening" | "switching" | "closing",
  error: unknown,
): string {
  const raw = extractError(error).trim();
  if (/timed out after 30000ms/i.test(raw)) {
    if (kind === "opening") {
      return "Opening this project took longer than 30 seconds, so ADE stopped waiting.";
    }
    if (kind === "switching") {
      return "Switching projects took longer than 30 seconds, so ADE kept the current project active.";
    }
    return "Closing the current project took longer than 30 seconds.";
  }
  return raw.length > 0 ? raw : "Project action failed.";
}

export const useAppStore = create<AppState>((set, get) => ({
  project: null,
  projectHydrated: false,
  showWelcome: true,
  projectTransition: null,
  projectTransitionError: null,
  isNewTabOpen: false,
  laneSnapshots: [],
  lanes: [],
  selectedLaneId: null,
  runLaneId: null,
  focusedSessionId: null,
  projectRevision: 0,
  theme: initialUserPreferences.theme,
  terminalPreferences: initialUserPreferences.terminalPreferences,
  providerMode: "guest",
  availableModels: [...MODEL_REGISTRY].filter((m) => !m.deprecated),
  laneInspectorTabs: {},
  keybindings: null,
  terminalAttention: EMPTY_TERMINAL_ATTENTION,
  smartTooltipsEnabled: initialUserPreferences.smartTooltipsEnabled,
  workViewByProject: initialPersistedWorkViews.workViewByProject,
  laneWorkViewByScope: initialPersistedWorkViews.laneWorkViewByScope,

  setProject: (project) =>
    set((prev) => {
      const previousProjectRoot = prev.project?.rootPath ?? null;
      const nextProjectRoot = project?.rootPath ?? null;
      return {
        project,
        projectRevision:
          previousProjectRoot !== nextProjectRoot ? prev.projectRevision + 1 : prev.projectRevision,
      };
    }),
  setProjectHydrated: (projectHydrated) => set({ projectHydrated }),
  setShowWelcome: (showWelcome) => set({ showWelcome }),
  clearProjectTransitionError: () => set({ projectTransitionError: null }),
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
  setTheme: (theme) =>
    set((prev) => {
      persistUserPreferences({
        theme,
        terminalPreferences: prev.terminalPreferences,
        smartTooltipsEnabled: prev.smartTooltipsEnabled,
      });
      return { theme };
    }),
  setTerminalPreferences: (next) =>
    set((prev) => {
      const updated = normalizeTerminalPreferences(
        typeof next === "function"
          ? next(prev.terminalPreferences)
          : { ...prev.terminalPreferences, ...next }
      );
      persistUserPreferences({
        theme: prev.theme,
        terminalPreferences: updated,
        smartTooltipsEnabled: prev.smartTooltipsEnabled,
      });
      return { terminalPreferences: updated };
    }),
  setTerminalAttention: (terminalAttention) => set({ terminalAttention }),
  setSmartTooltipsEnabled: (enabled) =>
    set((prev) => {
      persistUserPreferences({
        theme: prev.theme,
        terminalPreferences: prev.terminalPreferences,
        smartTooltipsEnabled: enabled,
      });
      return { smartTooltipsEnabled: enabled };
    }),
  openNewTab: () => set({ isNewTabOpen: true, showWelcome: true }),
  cancelNewTab: () => {
    const hasProject = get().project != null;
    set({ isNewTabOpen: false, showWelcome: !hasProject });
  },
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
      const nextWorkViews = {
        ...prev.workViewByProject,
        [key]: updated,
      };
      debouncedPersistWorkViewState({
        workViewByProject: nextWorkViews,
        laneWorkViewByScope: prev.laneWorkViewByScope,
      });
      return {
        workViewByProject: nextWorkViews,
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
      const nextLaneWorkViews = {
        ...prev.laneWorkViewByScope,
        [key]: updated,
      };
      debouncedPersistWorkViewState({
        workViewByProject: prev.workViewByProject,
        laneWorkViewByScope: nextLaneWorkViews,
      });
      return {
        laneWorkViewByScope: nextLaneWorkViews,
      };
    });
  },

  refreshProject: async () => {
    const project = await window.ade.app.getProject();
    get().setProject(project);
    set({ projectHydrated: true });
  },

  refreshLanes: async (options) => {
    const request = normalizeLaneRefreshRequest(options);
    const runRefresh = async (currentRequest: LaneRefreshRequest) => {
      const requestedProjectKey = normalizeProjectKey(get().project?.rootPath);
      const token = ++laneRefreshVersion;
      const laneSnapshots = currentRequest.includeStatus
        ? await window.ade.lanes.listSnapshots({
            includeArchived: false,
            includeStatus: true,
          })
        : null;
      const lanes = laneSnapshots != null
        ? laneSnapshots.map((snapshot) => snapshot.lane)
        : await window.ade.lanes.list({
            includeArchived: false,
            includeStatus: false,
          });
      // Discard stale response: a newer refresh was issued while this one was in-flight
      if (token !== laneRefreshVersion) {
        return;
      }
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
        const nextSnapshots: LaneListSnapshot[] =
          laneSnapshots ??
          prev.laneSnapshots.filter((snapshot) => allowed.has(snapshot.lane.id));
        persistWorkViewState({
          workViewByProject: prev.workViewByProject,
          laneWorkViewByScope: nextLaneWorkViews,
        });
        return {
          laneSnapshots: nextSnapshots,
          lanes,
          selectedLaneId: nextSelected,
          runLaneId: nextRunLane,
          laneInspectorTabs: nextTabs,
          laneWorkViewByScope: nextLaneWorkViews,
        };
      });
    };

    if (laneRefreshInFlight) {
      const activeRequest = activeLaneRefreshRequest;
      const activeSatisfies = activeRequest != null && (activeRequest.includeStatus || !request.includeStatus);
      if (!activeSatisfies) {
        pendingLaneRefreshRequest = pendingLaneRefreshRequest
          ? mergeLaneRefreshRequests(pendingLaneRefreshRequest, request)
          : request;
      }
      await laneRefreshInFlight;
      return;
    }

    laneRefreshInFlight = (async () => {
      let nextRequest: LaneRefreshRequest | null = request;
      while (nextRequest) {
        activeLaneRefreshRequest = nextRequest;
        pendingLaneRefreshRequest = null;
        await runRefresh(nextRequest);
        nextRequest = pendingLaneRefreshRequest;
      }
    })().finally(() => {
      laneRefreshInFlight = null;
      activeLaneRefreshRequest = null;
      pendingLaneRefreshRequest = null;
    });

    await laneRefreshInFlight;
  },

  refreshProviderMode: async () => {
    const projectRoot = get().project?.rootPath ?? null;
    const [snapshot, aiStatus] = await Promise.all([
      getProjectConfigCached({ projectRoot }),
      getAiStatusCached({ projectRoot }).catch(() => null),
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
    // Invalidate in-flight lane refreshes before the async open so stale
    // responses from the previous project are discarded immediately.
    ++laneRefreshVersion;
    set({
      projectTransition: {
        kind: "opening",
        rootPath: null,
        startedAtMs: Date.now(),
      },
      projectTransitionError: null,
    });
    try {
      const project = await window.ade.project.openRepo();
      if (!project) {
        set({ projectTransition: null });
        return null;
      }
      get().setProject(project);
      set({
        projectHydrated: true,
        showWelcome: false,
        projectTransition: null,
        projectTransitionError: null,
        isNewTabOpen: false,
        laneSnapshots: [],
        lanes: [],
        selectedLaneId: null,
        runLaneId: null,
        focusedSessionId: null,
        laneInspectorTabs: {},
        keybindings: null,
        terminalAttention: EMPTY_TERMINAL_ATTENTION
      });
      invalidateAiDiscoveryCache(project.rootPath);
      invalidateProjectConfigCache(project.rootPath);
      void Promise.allSettled([
        get().refreshLanes({ includeStatus: false }),
        get().refreshKeybindings()
      ]);
      scheduleProjectHydration(get);
      return project;
    } catch (error) {
      set({
        projectTransition: null,
        projectTransitionError: formatProjectTransitionError("opening", error),
      });
      throw error;
    }
  },

  switchProjectToPath: async (rootPath: string) => {
    // Invalidate in-flight lane refreshes before the async switch so stale
    // responses from the previous project are discarded immediately.
    ++laneRefreshVersion;
    set({
      projectTransition: {
        kind: "switching",
        rootPath,
        startedAtMs: Date.now(),
      },
      projectTransitionError: null,
    });
    try {
      const project = await window.ade.project.switchToPath(rootPath);
      get().setProject(project);
      set({
        projectHydrated: true,
        showWelcome: false,
        projectTransition: null,
        projectTransitionError: null,
        isNewTabOpen: false,
        laneSnapshots: [],
        lanes: [],
        selectedLaneId: null,
        runLaneId: null,
        focusedSessionId: null,
        laneInspectorTabs: {},
        keybindings: null,
        terminalAttention: EMPTY_TERMINAL_ATTENTION
      });
      invalidateAiDiscoveryCache(rootPath);
      invalidateProjectConfigCache(rootPath);
      void Promise.allSettled([
        get().refreshLanes({ includeStatus: false }),
        get().refreshKeybindings()
      ]);
      scheduleProjectHydration(get);

      // Prune stale view state for projects no longer in recent list
      const recentRoots = new Set(
        (await window.ade.project.listRecent().catch(() => [])).map((r: { rootPath: string }) => r.rootPath)
      );
      const activeRoot = get().project?.rootPath ?? null;
      set((prev) => {
        const nextWorkViews: Record<string, WorkProjectViewState> = {};
        const nextLaneWorkViews: Record<string, WorkProjectViewState> = {};
        for (const [key, value] of Object.entries(prev.workViewByProject)) {
          if (key === activeRoot || recentRoots.has(key)) nextWorkViews[key] = value;
        }
        for (const [scopeKey, value] of Object.entries(prev.laneWorkViewByScope)) {
          const projectKey = scopeKey.split("::")[0];
          if (projectKey === activeRoot || recentRoots.has(projectKey)) nextLaneWorkViews[scopeKey] = value;
        }
        persistWorkViewState({
          workViewByProject: nextWorkViews,
          laneWorkViewByScope: nextLaneWorkViews,
        });
        return {
          projectTransition: null,
          workViewByProject: nextWorkViews,
          laneWorkViewByScope: nextLaneWorkViews,
        };
      });
    } catch (error) {
      set({
        projectTransition: null,
        projectTransitionError: formatProjectTransitionError("switching", error),
      });
      throw error;
    }
  },

  closeProject: async () => {
    const closingProjectRoot = get().project?.rootPath ?? null;
    set({
      projectTransition: {
        kind: "closing",
        rootPath: closingProjectRoot,
        startedAtMs: Date.now(),
      },
      projectTransitionError: null,
    });
    try {
      await window.ade.project.closeCurrent();
      invalidateAiDiscoveryCache(closingProjectRoot);
      invalidateProjectConfigCache(closingProjectRoot);
      get().setProject(null);
      set({
        projectHydrated: true,
        showWelcome: true,
        projectTransition: null,
        projectTransitionError: null,
        isNewTabOpen: false,
        laneSnapshots: [],
        lanes: [],
        selectedLaneId: null,
        runLaneId: null,
        focusedSessionId: null,
        laneInspectorTabs: {},
        keybindings: null,
        terminalAttention: EMPTY_TERMINAL_ATTENTION
      });
    } catch (error) {
      set({
        projectTransition: null,
        projectTransitionError: formatProjectTransitionError("closing", error),
      });
      throw error;
    }
  }
}));
