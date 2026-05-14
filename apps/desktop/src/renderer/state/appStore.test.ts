import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock window.localStorage and window.ade before importing the store
// ---------------------------------------------------------------------------
const mockStorage = new Map<string, string>();

const mockLocalStorage = {
  getItem: vi.fn((key: string) => mockStorage.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => { mockStorage.set(key, value); }),
  removeItem: vi.fn((key: string) => { mockStorage.delete(key); }),
  clear: vi.fn(() => { mockStorage.clear(); }),
  get length() { return mockStorage.size; },
  key: vi.fn(() => null),
};

// Must be set before the module is imported so readInitialTheme() works.
(globalThis as any).window = {
  localStorage: mockLocalStorage,
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  ade: {
    app: { getProject: vi.fn(async () => null) },
    lanes: { list: vi.fn(async () => []), listSnapshots: vi.fn(async () => []) },
    projectConfig: { get: vi.fn(async () => ({ effective: {} })) },
    ai: { getStatus: vi.fn(async () => null) },
    keybindings: { get: vi.fn(async () => null) },
    project: {
      openRepo: vi.fn(async () => null),
      listRecent: vi.fn(async () => []),
      switchToPath: vi.fn(async () => null),
      closeCurrent: vi.fn(async () => {}),
    },
  },
};

// Import after window is set up
import { useAppStore, THEME_IDS, DEFAULT_TERMINAL_PREFERENCES, DEFAULT_CHAT_FONT_SIZE_PX } from "./appStore";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reset store to initial state between tests */
function resetStore() {
  useAppStore.setState({
    project: null,
    projectHydrated: false,
    showWelcome: true,
    projectTransition: null,
    projectTransitionError: null,
    laneSnapshots: [],
    lanes: [],
    lanesLoading: false,
    laneDeleteProgressByLaneId: {},
    selectedLaneId: null,
    focusedSessionId: null,
    theme: "dark",
    terminalPreferences: { ...DEFAULT_TERMINAL_PREFERENCES },
    codeBlockCopyButtonPosition: "top" as const,
    agentTurnCompletionSound: "off" as const,
    chatFontSizePx: DEFAULT_CHAT_FONT_SIZE_PX,
    chatUserMinimapEnabled: true,
    chatTranscriptDensity: "comfortable",
    chatChromeTint: "colored",
    chatShellGeometry: "default",
    smartTooltipsEnabled: true,
    onboardingEnabled: true,
    didYouKnowEnabled: true,
    laneInspectorTabs: {},
    workViewByProject: {},
    laneWorkViewByScope: {},
    dismissedMissingAiBannerRoots: {},
    dismissedGithubBannerRoots: {},
  });
}

describe("appStore", () => {
  beforeEach(() => {
    mockStorage.clear();
    vi.clearAllMocks();
    resetStore();
  });

  // ─────────────────────────────────────────────────────────────
  // Theme
  // ─────────────────────────────────────────────────────────────

  describe("THEME_IDS", () => {
    it("exposes exactly dark and light", () => {
      expect(THEME_IDS).toEqual(["dark", "light"]);
    });
  });

  describe("setTheme", () => {
    it("updates the theme in state and persists to localStorage", () => {
      useAppStore.getState().setTheme("light");
      expect(useAppStore.getState().theme).toBe("light");
      const calls = mockLocalStorage.setItem.mock.calls.filter(
        ([key]) => key === "ade.userPreferences.v1",
      );
      const latest = calls[calls.length - 1];
      expect(latest).toBeTruthy();
      expect(JSON.parse(latest![1])).toMatchObject({ theme: "light" });
    });

    it("persists dark theme", () => {
      useAppStore.getState().setTheme("dark");
      expect(useAppStore.getState().theme).toBe("dark");
      const calls = mockLocalStorage.setItem.mock.calls.filter(
        ([key]) => key === "ade.userPreferences.v1",
      );
      const latest = calls[calls.length - 1];
      expect(latest).toBeTruthy();
      expect(JSON.parse(latest![1])).toMatchObject({ theme: "dark" });
    });
  });

  describe("setTerminalPreferences", () => {
    it("updates terminal preferences in state and persists them to localStorage", () => {
      useAppStore.getState().setTerminalPreferences({
        fontSize: 14,
        lineHeight: 1.3,
        scrollback: 20_000,
      });

      expect(useAppStore.getState().terminalPreferences).toEqual({
        fontFamily: DEFAULT_TERMINAL_PREFERENCES.fontFamily,
        fontSize: 14,
        lineHeight: 1.3,
        scrollback: 20_000,
      });
      const calls = mockLocalStorage.setItem.mock.calls.filter(
        ([key]) => key === "ade.userPreferences.v1",
      );
      const latest = calls[calls.length - 1];
      expect(latest).toBeTruthy();
      expect(JSON.parse(latest![1]).terminalPreferences).toEqual({
        fontFamily: DEFAULT_TERMINAL_PREFERENCES.fontFamily,
        fontSize: 14,
        lineHeight: 1.3,
        scrollback: 20_000,
      });
    });

    it("clamps invalid terminal preferences to safe bounds", () => {
      useAppStore.getState().setTerminalPreferences({
        fontSize: 99,
        lineHeight: 0.2,
        scrollback: 10,
      });

      expect(useAppStore.getState().terminalPreferences).toEqual({
        fontFamily: DEFAULT_TERMINAL_PREFERENCES.fontFamily,
        fontSize: 18,
        lineHeight: 1,
        scrollback: 2000,
      });
    });

    it("caps scrollback at the renderer safety limit", () => {
      useAppStore.getState().setTerminalPreferences({
        scrollback: 250_000,
      });

      expect(useAppStore.getState().terminalPreferences.scrollback).toBe(30_000);
    });
  });

  describe("chat and notification preferences", () => {
    it("persists code block copy position and agent completion sound", () => {
      useAppStore.getState().setCodeBlockCopyButtonPosition("bottom");
      useAppStore.getState().setAgentTurnCompletionSound("chime");
      expect(useAppStore.getState().codeBlockCopyButtonPosition).toBe("bottom");
      expect(useAppStore.getState().agentTurnCompletionSound).toBe("chime");
      const calls = mockLocalStorage.setItem.mock.calls.filter(
        ([key]) => key === "ade.userPreferences.v1",
      );
      const latest = calls[calls.length - 1];
      expect(latest).toBeTruthy();
      expect(JSON.parse(latest![1])).toMatchObject({
        codeBlockCopyButtonPosition: "bottom",
        agentTurnCompletionSound: "chime",
      });
    });

    it("persists chat font size and clamps to range", () => {
      useAppStore.getState().setChatFontSizePx(20);
      expect(useAppStore.getState().chatFontSizePx).toBe(20);
      useAppStore.getState().setChatFontSizePx(99);
      expect(useAppStore.getState().chatFontSizePx).toBe(24);
      useAppStore.getState().setChatFontSizePx(8);
      expect(useAppStore.getState().chatFontSizePx).toBe(12);
    });

    it("persists chat user minimap toggle", () => {
      useAppStore.getState().setChatUserMinimapEnabled(false);
      expect(useAppStore.getState().chatUserMinimapEnabled).toBe(false);
      const calls = mockLocalStorage.setItem.mock.calls.filter(
        ([key]) => key === "ade.userPreferences.v1",
      );
      const latest = calls[calls.length - 1];
      expect(latest).toBeTruthy();
      expect(JSON.parse(latest![1])).toMatchObject({ chatUserMinimapEnabled: false });
      useAppStore.getState().setChatUserMinimapEnabled(true);
      expect(useAppStore.getState().chatUserMinimapEnabled).toBe(true);
    });

    it("persists transcript density and shell geometry prefs", () => {
      useAppStore.getState().setChatTranscriptDensity("compact");
      useAppStore.getState().setChatShellGeometry("sharp");
      expect(useAppStore.getState().chatTranscriptDensity).toBe("compact");
      expect(useAppStore.getState().chatShellGeometry).toBe("sharp");
    });

    it("resetThemeAndChatFontDefaults restores theme + font size only", () => {
      useAppStore.getState().setTheme("light");
      useAppStore.getState().setChatFontSizePx(20);
      useAppStore.getState().setChatTranscriptDensity("spacious");
      useAppStore.getState().resetThemeAndChatFontDefaults();
      expect(useAppStore.getState().theme).toBe("dark");
      expect(useAppStore.getState().chatFontSizePx).toBe(DEFAULT_CHAT_FONT_SIZE_PX);
      expect(useAppStore.getState().chatTranscriptDensity).toBe("spacious");
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Simple setters
  // ─────────────────────────────────────────────────────────────

  describe("simple state setters", () => {
    it("setProject sets the project", () => {
      const project = { id: "p1", name: "Test", rootPath: "/tmp/test", gitRemoteUrl: null, gitDefaultBranch: "main", createdAt: "" } as any;
      useAppStore.getState().setProject(project);
      expect(useAppStore.getState().project).toBe(project);
    });

    it("setProjectHydrated tracks whether startup project hydration finished", () => {
      useAppStore.getState().setProjectHydrated(true);
      expect(useAppStore.getState().projectHydrated).toBe(true);
      useAppStore.getState().setProjectHydrated(false);
      expect(useAppStore.getState().projectHydrated).toBe(false);
    });

    it("setShowWelcome toggles the welcome screen flag", () => {
      useAppStore.getState().setShowWelcome(false);
      expect(useAppStore.getState().showWelcome).toBe(false);
      useAppStore.getState().setShowWelcome(true);
      expect(useAppStore.getState().showWelcome).toBe(true);
    });

    it("setLanes updates the lanes array", () => {
      const lanes = [{ id: "lane-1", name: "test" }] as any[];
      useAppStore.getState().setLanes(lanes);
      expect(useAppStore.getState().lanes).toBe(lanes);
    });

    it("keeps lane delete progress in app state across local updates", () => {
      const progress = {
        laneId: "lane-1",
        steps: [],
        startedAt: "2026-05-14T00:00:00.000Z",
        overallStatus: "running",
        cancellable: false,
      } as any;

      useAppStore.getState().setLaneDeleteProgressByLaneId({ [progress.laneId]: progress });
      useAppStore.getState().setLaneDeleteProgressByLaneId((prev) => ({
        ...prev,
        "lane-2": { ...progress, laneId: "lane-2" },
      }));

      expect(Object.keys(useAppStore.getState().laneDeleteProgressByLaneId).sort()).toEqual(["lane-1", "lane-2"]);
    });

    it("clears lane delete progress only when the project root changes", () => {
      const progress = {
        laneId: "lane-1",
        steps: [],
        startedAt: "2026-05-14T00:00:00.000Z",
        overallStatus: "running",
        cancellable: false,
      } as any;
      const projectA = { rootPath: "/repo/a", displayName: "A", baseRef: "main" } as any;

      useAppStore.getState().setProject(projectA);
      useAppStore.getState().setLaneDeleteProgressByLaneId({ [progress.laneId]: progress });
      useAppStore.getState().setProject({ ...projectA, displayName: "A renamed" });
      expect(useAppStore.getState().laneDeleteProgressByLaneId).toEqual({ [progress.laneId]: progress });

      useAppStore.getState().setProject({ rootPath: "/repo/b", displayName: "B", baseRef: "main" } as any);
      expect(useAppStore.getState().laneDeleteProgressByLaneId).toEqual({});
    });

    it("refreshLanes hydrates lane snapshots and derives lanes", async () => {
      const snapshots = [
        {
          lane: { id: "lane-1", name: "Lane 1" },
          runtime: {
            bucket: "running",
            runningCount: 1,
            awaitingInputCount: 0,
            endedCount: 0,
            sessionCount: 1,
          },
          rebaseSuggestion: null,
          autoRebaseStatus: null,
          conflictStatus: null,
          stateSnapshot: null,
          adoptableAttached: false,
        },
      ] as any[];
      (window.ade.lanes.listSnapshots as any).mockResolvedValueOnce(snapshots);

      await useAppStore.getState().refreshLanes();

      expect(window.ade.lanes.listSnapshots).toHaveBeenCalledWith({
        includeArchived: false,
        includeStatus: true,
        includeConflictStatus: true,
        includeRebaseSuggestions: true,
        includeAutoRebaseStatus: true,
      });
      expect(useAppStore.getState().laneSnapshots).toEqual(snapshots);
      expect(useAppStore.getState().lanes).toEqual([snapshots[0].lane]);
    });

    it("refreshLanes can request the cheaper lane-list path while preserving prior git status", async () => {
      useAppStore.setState({
        lanes: [{ id: "lane-lite", name: "Lane lite", status: { dirty: true }, parentStatus: { ahead: 1 } }] as any[],
      });
      (window.ade.lanes.list as any).mockResolvedValueOnce([{ id: "lane-lite", name: "Lane lite", color: "#7dd3fc" }] as any[]);

      await useAppStore.getState().refreshLanes({ includeStatus: false });

      expect(window.ade.lanes.list).toHaveBeenCalledWith({
        includeArchived: false,
        includeStatus: false,
      });
      expect(window.ade.lanes.listSnapshots).not.toHaveBeenCalled();
      expect(useAppStore.getState().lanes[0]).toEqual(
        expect.objectContaining({
          id: "lane-lite",
          color: "#7dd3fc",
          status: { dirty: true },
          parentStatus: { ahead: 1 },
        }),
      );
    });

    it("refreshLanes can update lane git status without snapshot decorations", async () => {
      const lanes = [{ id: "lane-status", name: "Lane status", status: { dirty: true } }] as any[];
      (window.ade.lanes.list as any).mockResolvedValueOnce(lanes);

      await useAppStore.getState().refreshLanes({ includeStatus: true, includeSnapshots: false });

      expect(window.ade.lanes.list).toHaveBeenCalledWith({
        includeArchived: false,
        includeStatus: true,
      });
      expect(window.ade.lanes.listSnapshots).not.toHaveBeenCalled();
      expect(useAppStore.getState().lanes).toEqual(lanes);
    });

    it("refreshLanes tracks loading while lane state is pending", async () => {
      const lanes = [{ id: "lane-loading", name: "Lane loading" }] as any[];
      let resolveLanes: (value: any[]) => void = () => {};
      const pendingLanes = new Promise<any[]>((resolve) => {
        resolveLanes = resolve;
      });
      (window.ade.lanes.list as any).mockReturnValueOnce(pendingLanes);

      const refresh = useAppStore.getState().refreshLanes({ includeStatus: false });

      expect(useAppStore.getState().lanesLoading).toBe(true);

      resolveLanes(lanes);
      await refresh;

      expect(useAppStore.getState().lanes).toEqual(lanes);
      expect(useAppStore.getState().lanesLoading).toBe(false);
    });

    it("refreshLanes can update runtime snapshots without recomputing lane git status", async () => {
      useAppStore.setState({
        lanes: [{ id: "lane-1", name: "Lane 1", status: { dirty: true }, parentStatus: { dirty: false } }] as any[],
      });
      const snapshots = [
        {
          lane: { id: "lane-1", name: "Lane 1", status: { dirty: false }, parentStatus: null },
          runtime: {
            bucket: "running",
            runningCount: 1,
            awaitingInputCount: 0,
            endedCount: 0,
            sessionCount: 1,
          },
          rebaseSuggestion: null,
          autoRebaseStatus: null,
          conflictStatus: null,
          stateSnapshot: null,
          adoptableAttached: false,
        },
      ] as any[];
      (window.ade.lanes.listSnapshots as any).mockResolvedValueOnce(snapshots);

      await useAppStore.getState().refreshLanes({
        includeStatus: false,
        includeSnapshots: true,
        includeConflictStatus: false,
        includeRebaseSuggestions: false,
        includeAutoRebaseStatus: false,
      });

      expect(window.ade.lanes.listSnapshots).toHaveBeenCalledWith({
        includeArchived: false,
        includeStatus: false,
        includeConflictStatus: false,
        includeRebaseSuggestions: false,
        includeAutoRebaseStatus: false,
      });
      expect(useAppStore.getState().laneSnapshots[0].runtime.bucket).toBe("running");
      expect(useAppStore.getState().lanes[0].status).toEqual({ dirty: true });
      expect(useAppStore.getState().laneSnapshots[0].lane).toBe(useAppStore.getState().lanes[0]);
    });

    it("refreshLanes can skip conflict status for cheaper warmup snapshots", async () => {
      (window.ade.lanes.listSnapshots as any).mockResolvedValueOnce([]);

      await useAppStore.getState().refreshLanes({ includeStatus: true, includeConflictStatus: false });

      expect(window.ade.lanes.listSnapshots).toHaveBeenCalledWith({
        includeArchived: false,
        includeStatus: true,
        includeConflictStatus: false,
        includeRebaseSuggestions: true,
        includeAutoRebaseStatus: true,
      });
    });

    it("refreshLanes can skip rebase suggestions for cheaper warmup snapshots", async () => {
      (window.ade.lanes.listSnapshots as any).mockResolvedValueOnce([]);

      await useAppStore.getState().refreshLanes({ includeStatus: true, includeRebaseSuggestions: false });

      expect(window.ade.lanes.listSnapshots).toHaveBeenCalledWith({
        includeArchived: false,
        includeStatus: true,
        includeConflictStatus: true,
        includeRebaseSuggestions: false,
        includeAutoRebaseStatus: true,
      });
    });

    it("refreshLanes can skip auto-rebase status for cheaper warmup snapshots", async () => {
      (window.ade.lanes.listSnapshots as any).mockResolvedValueOnce([]);

      await useAppStore.getState().refreshLanes({ includeStatus: true, includeAutoRebaseStatus: false });

      expect(window.ade.lanes.listSnapshots).toHaveBeenCalledWith({
        includeArchived: false,
        includeStatus: true,
        includeConflictStatus: true,
        includeRebaseSuggestions: true,
        includeAutoRebaseStatus: false,
      });
    });

    it("refreshLanes syncs retained snapshots to statusless lane metadata during lightweight refresh", async () => {
      useAppStore.setState({
        laneSnapshots: [
          {
            lane: {
              id: "lane-1",
              name: "Lane 1",
              color: "#0f172a",
              status: { dirty: true },
              parentStatus: { ahead: 1 },
            },
            runtime: {
              bucket: "running",
              runningCount: 1,
              awaitingInputCount: 0,
              endedCount: 0,
              sessionCount: 1,
            },
            rebaseSuggestion: null,
            autoRebaseStatus: null,
            conflictStatus: null,
            stateSnapshot: null,
            adoptableAttached: false,
          },
          {
            lane: { id: "lane-2", name: "Lane 2" },
            runtime: {
              bucket: "none",
              runningCount: 0,
              awaitingInputCount: 0,
              endedCount: 0,
              sessionCount: 0,
            },
            rebaseSuggestion: null,
            autoRebaseStatus: null,
            conflictStatus: null,
            stateSnapshot: null,
            adoptableAttached: false,
          },
        ] as any[],
      });
      (window.ade.lanes.list as any).mockResolvedValueOnce([
        { id: "lane-1", name: "Lane 1", color: "#7dd3fc" },
      ] as any[]);

      await useAppStore.getState().refreshLanes({ includeStatus: false });

      expect(window.ade.lanes.listSnapshots).not.toHaveBeenCalled();
      expect(useAppStore.getState().laneSnapshots).toEqual([
        expect.objectContaining({
          lane: expect.objectContaining({
            id: "lane-1",
            color: "#7dd3fc",
            status: { dirty: true },
            parentStatus: { ahead: 1 },
          }),
          runtime: expect.objectContaining({ bucket: "running" }),
        }),
      ]);
    });

    it("selectLane updates selectedLaneId", () => {
      useAppStore.getState().selectLane("lane-42");
      expect(useAppStore.getState().selectedLaneId).toBe("lane-42");
    });

    it("focusSession updates focusedSessionId", () => {
      useAppStore.getState().focusSession("session-abc");
      expect(useAppStore.getState().focusedSessionId).toBe("session-abc");
    });

    it("clearProjectTransitionError clears project action errors", () => {
      useAppStore.setState({ projectTransitionError: "Switch failed" });
      useAppStore.getState().clearProjectTransitionError();
      expect(useAppStore.getState().projectTransitionError).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Lane inspector tabs
  // ─────────────────────────────────────────────────────────────

  describe("setLaneInspectorTab", () => {
    it("stores the tab choice per lane", () => {
      useAppStore.getState().setLaneInspectorTab("lane-1", "context");
      useAppStore.getState().setLaneInspectorTab("lane-2", "merge");
      expect(useAppStore.getState().laneInspectorTabs).toEqual({
        "lane-1": "context",
        "lane-2": "merge",
      });
    });

    it("overwrites a previous tab selection", () => {
      useAppStore.getState().setLaneInspectorTab("lane-1", "terminals");
      useAppStore.getState().setLaneInspectorTab("lane-1", "stack");
      expect(useAppStore.getState().laneInspectorTabs["lane-1"]).toBe("stack");
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Terminal attention
  // ─────────────────────────────────────────────────────────────

  describe("setTerminalAttention", () => {
    it("replaces the terminal attention snapshot", () => {
      const snapshot = {
        runningCount: 3,
        activeCount: 1,
        needsAttentionCount: 2,
        indicator: "running-needs-attention" as const,
        byLaneId: {},
      };
      useAppStore.getState().setTerminalAttention(snapshot);
      expect(useAppStore.getState().terminalAttention).toEqual(snapshot);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Work view state (project-level)
  // ─────────────────────────────────────────────────────────────

  describe("getWorkViewState / setWorkViewState", () => {
    it("returns default state when no project root is set", () => {
      const state = useAppStore.getState().getWorkViewState(null);
      expect(state.viewMode).toBe("tabs");
      expect(state.draftKind).toBe("chat");
      expect(state.statusFilter).toBe("all");
      expect(state.openItemIds).toEqual([]);
    });

    it("returns default state for empty string project root", () => {
      const state = useAppStore.getState().getWorkViewState("  ");
      expect(state.viewMode).toBe("tabs");
    });

    it("returns default state for undefined project root", () => {
      const state = useAppStore.getState().getWorkViewState(undefined);
      expect(state.viewMode).toBe("tabs");
    });

    it("stores and retrieves work view state by project root", () => {
      useAppStore.getState().setWorkViewState("/project/a", { viewMode: "grid" });
      const state = useAppStore.getState().getWorkViewState("/project/a");
      expect(state.viewMode).toBe("grid");
      expect(state.draftKind).toBe("chat"); // default preserved
    });

    it("ignores setWorkViewState for null project root", () => {
      useAppStore.getState().setWorkViewState(null, { viewMode: "grid" });
      expect(useAppStore.getState().workViewByProject).toEqual({});
    });

    it("supports function updater for setWorkViewState", () => {
      useAppStore.getState().setWorkViewState("/project/b", { statusFilter: "running" });
      useAppStore.getState().setWorkViewState("/project/b", (prev) => ({
        ...prev,
        search: "hello",
      }));
      const state = useAppStore.getState().getWorkViewState("/project/b");
      expect(state.statusFilter).toBe("running");
      expect(state.search).toBe("hello");
    });

    it("trims project root keys for normalization", () => {
      useAppStore.getState().setWorkViewState("  /project/c  ", { laneFilter: "my-lane" });
      const state = useAppStore.getState().getWorkViewState("/project/c");
      expect(state.laneFilter).toBe("my-lane");
    });

    it("defaults work sidebar state to closed/git/36% and persists overrides", () => {
      const fresh = useAppStore.getState().getWorkViewState("/project/sidebar");
      expect(fresh.workSidebarOpen).toBe(false);
      expect(fresh.workSidebarTab).toBe("git");
      expect(fresh.workSidebarWidthPct).toBe(36);

      useAppStore.getState().setWorkViewState("/project/sidebar", {
        workSidebarOpen: true,
        workSidebarTab: "macos-vm",
        workSidebarWidthPct: 48,
      });
      const updated = useAppStore.getState().getWorkViewState("/project/sidebar");
      expect(updated.workSidebarOpen).toBe(true);
      expect(updated.workSidebarTab).toBe("macos-vm");
      expect(updated.workSidebarWidthPct).toBe(48);
      expect(updated.viewMode).toBe("tabs");
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Lane work view state (project + lane scoped)
  // ─────────────────────────────────────────────────────────────

  describe("getLaneWorkViewState / setLaneWorkViewState", () => {
    it("returns default state when project root or laneId is missing", () => {
      expect(useAppStore.getState().getLaneWorkViewState(null, "lane-1").viewMode).toBe("tabs");
      expect(useAppStore.getState().getLaneWorkViewState("/proj", null).viewMode).toBe("tabs");
      expect(useAppStore.getState().getLaneWorkViewState(null, null).viewMode).toBe("tabs");
    });

    it("stores and retrieves lane-scoped work view state", () => {
      useAppStore.getState().setLaneWorkViewState("/proj", "lane-1", { viewMode: "grid" });
      const state = useAppStore.getState().getLaneWorkViewState("/proj", "lane-1");
      expect(state.viewMode).toBe("grid");
    });

    it("keeps separate state per lane", () => {
      useAppStore.getState().setLaneWorkViewState("/proj", "lane-1", { viewMode: "grid" });
      useAppStore.getState().setLaneWorkViewState("/proj", "lane-2", { statusFilter: "ended" });
      expect(useAppStore.getState().getLaneWorkViewState("/proj", "lane-1").viewMode).toBe("grid");
      expect(useAppStore.getState().getLaneWorkViewState("/proj", "lane-2").statusFilter).toBe("ended");
    });

    it("supports function updater", () => {
      useAppStore.getState().setLaneWorkViewState("/proj", "lane-1", { search: "abc" });
      useAppStore.getState().setLaneWorkViewState("/proj", "lane-1", (prev) => ({
        ...prev,
        search: prev.search + "def",
      }));
      expect(useAppStore.getState().getLaneWorkViewState("/proj", "lane-1").search).toBe("abcdef");
    });

    it("ignores set when keys are empty", () => {
      useAppStore.getState().setLaneWorkViewState("", "lane-1", { viewMode: "grid" });
      useAppStore.getState().setLaneWorkViewState("/proj", "", { viewMode: "grid" });
      expect(useAppStore.getState().laneWorkViewByScope).toEqual({});
    });
  });

  describe("onboarding preferences", () => {
    it("defaults onboardingEnabled and didYouKnowEnabled to true", () => {
      expect(useAppStore.getState().onboardingEnabled).toBe(true);
      expect(useAppStore.getState().didYouKnowEnabled).toBe(true);
    });

    it("persists onboardingEnabled independently of smartTooltipsEnabled", () => {
      useAppStore.getState().setOnboardingEnabled(false);
      expect(useAppStore.getState().onboardingEnabled).toBe(false);
      expect(useAppStore.getState().smartTooltipsEnabled).toBe(true);

      const calls = mockLocalStorage.setItem.mock.calls.filter(
        ([key]) => key === "ade.userPreferences.v1",
      );
      const latest = calls[calls.length - 1];
      expect(latest).toBeTruthy();
      const parsed = JSON.parse(latest![1]);
      expect(parsed.onboardingEnabled).toBe(false);
      expect(parsed.smartTooltipsEnabled).toBe(true);
    });

    it("persists didYouKnowEnabled independently of onboardingEnabled", () => {
      useAppStore.getState().setDidYouKnowEnabled(false);
      expect(useAppStore.getState().didYouKnowEnabled).toBe(false);
      expect(useAppStore.getState().onboardingEnabled).toBe(true);

      const calls = mockLocalStorage.setItem.mock.calls.filter(
        ([key]) => key === "ade.userPreferences.v1",
      );
      const latest = calls[calls.length - 1];
      expect(latest).toBeTruthy();
      const parsed = JSON.parse(latest![1]);
      expect(parsed.didYouKnowEnabled).toBe(false);
      expect(parsed.onboardingEnabled).toBe(true);
    });

    it("toggling smartTooltipsEnabled leaves onboardingEnabled alone", () => {
      useAppStore.getState().setSmartTooltipsEnabled(false);
      expect(useAppStore.getState().smartTooltipsEnabled).toBe(false);
      expect(useAppStore.getState().onboardingEnabled).toBe(true);
    });
  });

  describe("project transitions", () => {
    it("tracks project switching progress and clears it on success", async () => {
      const nextProject = { rootPath: "/tmp/next", displayName: "Next", baseRef: "main" } as any;
      (window.ade.project.switchToPath as any).mockResolvedValueOnce(nextProject);

      const pending = useAppStore.getState().switchProjectToPath("/tmp/next");
      expect(useAppStore.getState().projectTransition).toEqual(
        expect.objectContaining({
          kind: "switching",
          rootPath: "/tmp/next",
        }),
      );

      await pending;

      expect(useAppStore.getState().project).toEqual(nextProject);
      expect(useAppStore.getState().projectTransition).toBeNull();
      expect(useAppStore.getState().projectTransitionError).toBeNull();
    });

    it("stores a friendly timeout error when switching projects fails", async () => {
      (window.ade.project.switchToPath as any).mockRejectedValueOnce(
        new Error("IPC handler for 'ade.project.switchToPath' timed out after 30000ms (callId=51)"),
      );

      await expect(
        useAppStore.getState().switchProjectToPath("/tmp/slow-project"),
      ).rejects.toThrow("timed out after 30000ms");

      expect(useAppStore.getState().projectTransition).toBeNull();
      expect(useAppStore.getState().projectTransitionError).toBe(
        "Switching projects took longer than 30 seconds, so ADE kept the current project active.",
      );
    });

    it("prunes banner-dismiss maps to the new project after switch settles", async () => {
      const originalWindowSetTimeout = window.setTimeout;
      vi.useFakeTimers();
      window.setTimeout = globalThis.setTimeout as typeof window.setTimeout;
      // Seed dismissals for three projects, then switch to one of them with a
      // listRecent that only includes two. The third should be dropped.
      try {
        useAppStore.setState({
          dismissedMissingAiBannerRoots: { "/p/a": true, "/p/b": true, "/p/c": true },
          dismissedGithubBannerRoots: { "/p/a": true, "/p/b": true },
        } as any);

        const nextProject = { rootPath: "/p/a", displayName: "A", baseRef: "main" } as any;
        (window.ade.project.switchToPath as any).mockResolvedValueOnce(nextProject);
        (window.ade.project.listRecent as any).mockResolvedValueOnce([
          { rootPath: "/p/a" },
          { rootPath: "/p/b" },
        ]);

        await useAppStore.getState().switchProjectToPath("/p/a");

        expect(useAppStore.getState().dismissedMissingAiBannerRoots).toEqual({
          "/p/a": true,
          "/p/b": true,
          "/p/c": true,
        });

        await vi.advanceTimersByTimeAsync(750);

        // `/p/c` was neither active nor in recents → pruned from all banner maps.
        expect(useAppStore.getState().dismissedMissingAiBannerRoots).toEqual({
          "/p/a": true,
          "/p/b": true,
        });
        expect(useAppStore.getState().dismissedGithubBannerRoots).toEqual({
          "/p/a": true,
          "/p/b": true,
        });
      } finally {
        window.setTimeout = originalWindowSetTimeout;
        vi.useRealTimers();
      }
    });

    it("clears all banner-dismiss maps when the project is closed", async () => {
      useAppStore.setState({
        project: { rootPath: "/p/x" } as any,
        dismissedMissingAiBannerRoots: { "/p/x": true, "/p/y": true },
        dismissedGithubBannerRoots: { "/p/x": true },
      } as any);

      await useAppStore.getState().closeProject();

      expect(useAppStore.getState().dismissedMissingAiBannerRoots).toEqual({});
      expect(useAppStore.getState().dismissedGithubBannerRoots).toEqual({});
    });

    it("dismiss setters append to the session-scoped map without touching other keys", () => {
      useAppStore.setState({
        dismissedMissingAiBannerRoots: { "/p/existing": true },
      } as any);
      useAppStore.getState().dismissMissingAiBanner("/p/new");
      expect(useAppStore.getState().dismissedMissingAiBannerRoots).toEqual({
        "/p/existing": true,
        "/p/new": true,
      });
    });

    it("tracks project opening progress and clears it when the user cancels", async () => {
      let resolveOpen: (value: any) => void = () => {};
      (window.ade.project.openRepo as any).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOpen = resolve;
          }),
      );

      const pending = useAppStore.getState().openRepo();
      expect(useAppStore.getState().projectTransition).toEqual(
        expect.objectContaining({
          kind: "opening",
          rootPath: null,
        }),
      );

      resolveOpen(null);
      await pending;

      expect(useAppStore.getState().projectTransition).toBeNull();
      expect(useAppStore.getState().projectTransitionError).toBeNull();
    });
  });
});
