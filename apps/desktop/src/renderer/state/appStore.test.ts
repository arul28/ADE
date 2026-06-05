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
    remoteRuntime: {
      openProject: vi.fn(async () => ({
        kind: "remote",
        key: "remote:target-1:project-1",
        targetId: "target-1",
        runtimeName: "Remote",
        projectId: "project-1",
        rootPath: "/remote/one",
        displayName: "Remote One",
      })),
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
    projectBinding: null,
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
    launchPromptClipboardEnabled: true,
    launchPromptClipboardNoticeEnabled: true,
    laneInspectorTabs: {},
    workViewByProject: {},
    laneWorkViewByScope: {},
    laneSelectionByProject: {},
    laneCacheByProject: {},
    sessionsCacheByProject: {},
    dismissedMissingAiBannerRoots: {},
    dismissedGithubBannerRoots: {},
    openProjectTabRoots: [],
    projectInfoByRoot: {},
  });
}

function makeLaneDeleteProgress(laneId: string) {
  return {
    laneId,
    steps: [],
    startedAt: "2026-05-14T00:00:00.000Z",
    overallStatus: "running",
    cancellable: false,
  } as any;
}

function laneCacheKey(projectRoot: string): string {
  return `ade.laneCache.v1:${encodeURIComponent(projectRoot)}`;
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

    it("persists the launch prompt clipboard toggles", () => {
      expect(useAppStore.getState().launchPromptClipboardEnabled).toBe(true);
      expect(useAppStore.getState().launchPromptClipboardNoticeEnabled).toBe(true);
      useAppStore.getState().setLaunchPromptClipboardEnabled(false);
      useAppStore.getState().setLaunchPromptClipboardNoticeEnabled(false);
      expect(useAppStore.getState().launchPromptClipboardEnabled).toBe(false);
      expect(useAppStore.getState().launchPromptClipboardNoticeEnabled).toBe(false);
      const calls = mockLocalStorage.setItem.mock.calls.filter(
        ([key]) => key === "ade.userPreferences.v1",
      );
      const latest = calls[calls.length - 1];
      expect(latest).toBeTruthy();
      expect(JSON.parse(latest![1])).toMatchObject({
        launchPromptClipboardEnabled: false,
        launchPromptClipboardNoticeEnabled: false,
      });
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

    it("setProject restores a persisted lane cache before the first refresh", () => {
      const project = { id: "p1", name: "Test", rootPath: "/tmp/test", gitRemoteUrl: null, gitDefaultBranch: "main", createdAt: "" } as any;
      const persistedLane = { id: "lane-cached", name: "Cached lane" } as any;
      mockStorage.set(laneCacheKey(project.rootPath), JSON.stringify({
        savedAt: Date.now(),
        lanes: [persistedLane],
      }));

      useAppStore.getState().setProject(project);

      expect(useAppStore.getState().lanes).toEqual([persistedLane]);
      expect(useAppStore.getState().laneSnapshots).toEqual([]);
      expect(useAppStore.getState().lanesLoading).toBe(false);
      expect(useAppStore.getState().laneCacheByProject[project.rootPath]?.lanes).toEqual([persistedLane]);
    });

    it("setProjectHydrated tracks whether startup project hydration finished", () => {
      useAppStore.getState().setProjectHydrated(true);
      expect(useAppStore.getState().projectHydrated).toBe(true);
      useAppStore.getState().setProjectHydrated(false);
      expect(useAppStore.getState().projectHydrated).toBe(false);
    });

    it("setProjectBinding removes a matching local tab root for remote projects", () => {
      const remoteBinding = {
        kind: "remote" as const,
        key: "remote:target-1:project-a",
        targetId: "target-1",
        runtimeName: "Mac Studio",
        projectId: "project-a",
        rootPath: "/Users/admin/Projects/perf pass",
        displayName: "perf pass",
      };

      useAppStore.setState({
        openProjectTabRoots: ["/Users/arul/ADE", remoteBinding.rootPath],
      } as any);

      useAppStore.getState().setProjectBinding(remoteBinding);

      expect(useAppStore.getState().projectBinding).toEqual(remoteBinding);
      expect(useAppStore.getState().openProjectTabRoots).toEqual([
        "/Users/arul/ADE",
      ]);
    });

    it("refreshProviderMode auto-elevates when runtime provider signals exist", async () => {
      useAppStore.setState({
        project: { rootPath: "/tmp/provider-mode", displayName: "Provider mode", baseRef: "main" } as any,
        providerMode: "guest",
      });
      (window.ade.projectConfig.get as any).mockResolvedValueOnce({ effective: { providerMode: "guest" } });
      (window.ade.ai.getStatus as any).mockResolvedValueOnce({
        mode: "guest",
        availableProviders: {
          claude: {
            binary: { present: false, source: "missing", path: null },
            auth: { ready: false, mode: "none", detail: null },
          },
          codex: false,
          cursor: false,
          droid: false,
        },
        models: { claude: [], codex: [], cursor: [], droid: [] },
        features: [],
        runtimeConnections: {
          openrouter: {
            provider: "openrouter",
            label: "OpenRouter",
            kind: "openrouter",
            configured: true,
            authAvailable: true,
            runtimeDetected: true,
            runtimeAvailable: true,
            health: "ready",
            blocker: null,
            lastCheckedAt: "2026-05-28T00:00:00.000Z",
          },
        },
      });

      await useAppStore.getState().refreshProviderMode();

      expect(useAppStore.getState().providerMode).toBe("subscription");
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
      const progress = makeLaneDeleteProgress("lane-1");

      useAppStore.getState().setLaneDeleteProgressByLaneId({ [progress.laneId]: progress });
      useAppStore.getState().setLaneDeleteProgressByLaneId((prev) => ({
        ...prev,
        "lane-2": makeLaneDeleteProgress("lane-2"),
      }));

      expect(Object.keys(useAppStore.getState().laneDeleteProgressByLaneId).sort()).toEqual(["lane-1", "lane-2"]);
    });

    it("clears lane delete progress only when the project root changes", () => {
      const progress = makeLaneDeleteProgress("lane-1");
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
        project: { rootPath: "/p/lite", displayName: "Lite", baseRef: "main" } as any,
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
      expect(JSON.parse(mockStorage.get(laneCacheKey("/p/lite")) ?? "{}").lanes[0]).toEqual(
        expect.objectContaining({ id: "lane-lite", color: "#7dd3fc" }),
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

    it("selectLane records the choice in laneSelectionByProject when a project is active", () => {
      useAppStore.setState({ project: { rootPath: "/p/a" } as any });
      useAppStore.getState().selectLane("lane-42");
      expect(useAppStore.getState().laneSelectionByProject["/p/a"]).toEqual({
        laneId: "lane-42",
        sessionId: null,
      });
    });

    it("selectLane does not write laneSelectionByProject when there is no project", () => {
      useAppStore.getState().selectLane("lane-42");
      expect(useAppStore.getState().laneSelectionByProject).toEqual({});
    });

    it("focusSession updates focusedSessionId", () => {
      useAppStore.getState().focusSession("session-abc");
      expect(useAppStore.getState().focusedSessionId).toBe("session-abc");
    });

    it("focusSession records the choice in laneSelectionByProject without clobbering laneId", () => {
      useAppStore.setState({ project: { rootPath: "/p/a" } as any });
      useAppStore.getState().selectLane("lane-7");
      useAppStore.getState().focusSession("session-abc");
      expect(useAppStore.getState().laneSelectionByProject["/p/a"]).toEqual({
        laneId: "lane-7",
        sessionId: "session-abc",
      });
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
        workSidebarTab: "browser",
        workSidebarWidthPct: 48,
      });
      const updated = useAppStore.getState().getWorkViewState("/project/sidebar");
      expect(updated.workSidebarOpen).toBe(true);
      expect(updated.workSidebarTab).toBe("browser");
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
      useAppStore.setState({
        projectBinding: {
          kind: "local",
          key: "local:/tmp/old",
          rootPath: "/tmp/old",
          displayName: "Old",
        },
      } as any);

      const pending = useAppStore.getState().switchProjectToPath("/tmp/next");
      expect(useAppStore.getState().projectTransition).toEqual(
        expect.objectContaining({
          kind: "switching",
          rootPath: "/tmp/next",
        }),
      );
      expect(useAppStore.getState().projectBinding).toBeNull();

      await pending;

      expect(useAppStore.getState().project).toEqual(nextProject);
      expect(useAppStore.getState().projectTransition).toBeNull();
      expect(useAppStore.getState().projectTransitionError).toBeNull();
    });

    it("stashes the outgoing project's lane/session selection and restores the incoming project's on switch", async () => {
      // Seed: user is on project A with lane-A1 and session-A1 selected.
      useAppStore.setState({
        project: { rootPath: "/p/a", displayName: "A", baseRef: "main" } as any,
        selectedLaneId: "lane-A1",
        focusedSessionId: "session-A1",
        // Project B has prior selection saved.
        laneSelectionByProject: {
          "/p/b": { laneId: "lane-B2", sessionId: "session-B2" },
        },
      });

      const projectB = { rootPath: "/p/b", displayName: "B", baseRef: "main" } as any;
      (window.ade.project.switchToPath as any).mockResolvedValueOnce(projectB);

      await useAppStore.getState().switchProjectToPath("/p/b");

      // Outgoing /p/a stashed.
      expect(useAppStore.getState().laneSelectionByProject["/p/a"]).toEqual({
        laneId: "lane-A1",
        sessionId: "session-A1",
      });
      // Incoming /p/b restored.
      expect(useAppStore.getState().selectedLaneId).toBe("lane-B2");
      expect(useAppStore.getState().focusedSessionId).toBe("session-B2");
    });

    it("restores null selection when switching to a project that has no saved selection", async () => {
      useAppStore.setState({
        project: { rootPath: "/p/a", displayName: "A", baseRef: "main" } as any,
        selectedLaneId: "lane-A1",
        focusedSessionId: "session-A1",
      });

      const projectFresh = { rootPath: "/p/fresh", displayName: "Fresh", baseRef: "main" } as any;
      (window.ade.project.switchToPath as any).mockResolvedValueOnce(projectFresh);

      await useAppStore.getState().switchProjectToPath("/p/fresh");

      expect(useAppStore.getState().selectedLaneId).toBeNull();
      expect(useAppStore.getState().focusedSessionId).toBeNull();
    });

    it("applies cached lanes immediately on switch back to a warm project (no loading flicker)", async () => {
      const cachedLanes = [{ id: "lane-A1", name: "Primary", status: "idle" }] as any[];
      const cachedSnapshots = [{ lane: cachedLanes[0] }] as any[];
      useAppStore.setState({
        project: { rootPath: "/p/a", displayName: "A", baseRef: "main" } as any,
        laneCacheByProject: {
          "/p/b": { lanes: cachedLanes, laneSnapshots: cachedSnapshots },
        },
      });

      const projectB = { rootPath: "/p/b", displayName: "B", baseRef: "main" } as any;
      (window.ade.project.switchToPath as any).mockResolvedValueOnce(projectB);

      await useAppStore.getState().switchProjectToPath("/p/b");

      // Cached lanes applied immediately — no empty state, no spinner.
      expect(useAppStore.getState().lanes).toBe(cachedLanes);
      expect(useAppStore.getState().laneSnapshots).toBe(cachedSnapshots);
      expect(useAppStore.getState().lanesLoading).toBe(false);
    });

    it("activates a warm project tab before the backend switch round trip finishes", async () => {
      const projectA = { rootPath: "/p/a", displayName: "A", baseRef: "main" } as any;
      const projectB = { rootPath: "/p/b", displayName: "B", baseRef: "main" } as any;
      const cachedLanesB = [{ id: "lane-B2", name: "Lane B2" }] as any[];
      const cachedSnapshotsB = [{ lane: cachedLanesB[0] }] as any[];
      let resolveSwitch!: (project: typeof projectB) => void;
      (window.ade.project.switchToPath as any).mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSwitch = resolve;
        }),
      );
      useAppStore.setState({
        project: projectA,
        selectedLaneId: "lane-A1",
        focusedSessionId: "session-A1",
        openProjectTabRoots: ["/p/a", "/p/b"],
        projectInfoByRoot: {
          "/p/a": projectA,
          "/p/b": projectB,
        },
        laneSelectionByProject: {
          "/p/b": { laneId: "lane-B2", sessionId: "session-B2" },
        },
        lanes: [{ id: "lane-A1", name: "Lane A1" }] as any[],
        laneCacheByProject: {
          "/p/b": { lanes: cachedLanesB, laneSnapshots: cachedSnapshotsB },
        },
      });

      const pending = useAppStore.getState().switchProjectToPath("/p/b");

      expect(useAppStore.getState().project).toEqual(projectB);
      expect(useAppStore.getState().projectTransition).toBeNull();
      expect(useAppStore.getState().projectBinding).toEqual(
        expect.objectContaining({ kind: "local", rootPath: "/p/b" }),
      );
      expect(useAppStore.getState().selectedLaneId).toBe("lane-B2");
      expect(useAppStore.getState().focusedSessionId).toBe("session-B2");
      expect(useAppStore.getState().lanes).toBe(cachedLanesB);
      expect(useAppStore.getState().laneSnapshots).toBe(cachedSnapshotsB);
      expect(useAppStore.getState().lanesLoading).toBe(false);
      expect(useAppStore.getState().laneSelectionByProject["/p/a"]).toEqual({
        laneId: "lane-A1",
        sessionId: "session-A1",
      });

      resolveSwitch(projectB);
      await pending;
    });

    it("shows the loading spinner only when switching to a cold project (no cache)", async () => {
      useAppStore.setState({
        project: { rootPath: "/p/a", displayName: "A", baseRef: "main" } as any,
        laneCacheByProject: {},
      });

      const projectFresh = { rootPath: "/p/fresh", displayName: "Fresh", baseRef: "main" } as any;
      (window.ade.project.switchToPath as any).mockResolvedValueOnce(projectFresh);

      await useAppStore.getState().switchProjectToPath("/p/fresh");

      expect(useAppStore.getState().lanes).toEqual([]);
      expect(useAppStore.getState().lanesLoading).toBe(true);
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

    it("retains project-scoped Work and lane caches for open project tabs even when they are absent from recents", async () => {
      const originalWindowSetTimeout = window.setTimeout;
      vi.useFakeTimers();
      window.setTimeout = globalThis.setTimeout as typeof window.setTimeout;
      try {
        const workState = useAppStore.getState().getWorkViewState("/p/c");
        useAppStore.setState({
          project: { rootPath: "/p/b", displayName: "B", baseRef: "main" } as any,
          openProjectTabRoots: ["/p/a", "/p/b", "/p/c"],
          workViewByProject: {
            "/p/c": { ...workState, openItemIds: ["session-c"], activeItemId: "session-c", selectedItemId: "session-c" },
            "/p/d": { ...workState, openItemIds: ["session-d"], activeItemId: "session-d", selectedItemId: "session-d" },
          },
          laneWorkViewByScope: {
            "/p/c::lane-c": { ...workState, openItemIds: ["session-c"] },
            "/p/d::lane-d": { ...workState, openItemIds: ["session-d"] },
          },
          laneSelectionByProject: {
            "/p/c": { laneId: "lane-c", sessionId: "session-c" },
            "/p/d": { laneId: "lane-d", sessionId: "session-d" },
          },
          laneCacheByProject: {
            "/p/c": { lanes: [{ id: "lane-c", name: "Lane C" }] as any[], laneSnapshots: [] },
            "/p/d": { lanes: [{ id: "lane-d", name: "Lane D" }] as any[], laneSnapshots: [] },
          },
          sessionsCacheByProject: {
            "/p/c": [{ id: "session-c" }],
            "/p/d": [{ id: "session-d" }],
          },
        } as any);

        const nextProject = { rootPath: "/p/a", displayName: "A", baseRef: "main" } as any;
        (window.ade.project.switchToPath as any).mockResolvedValueOnce(nextProject);
        (window.ade.project.listRecent as any).mockResolvedValueOnce([
          { rootPath: "/p/a" },
          { rootPath: "/p/b" },
        ]);

        await useAppStore.getState().switchProjectToPath("/p/a");
        await vi.advanceTimersByTimeAsync(750);

        expect(useAppStore.getState().workViewByProject["/p/c"]?.openItemIds).toEqual(["session-c"]);
        expect(useAppStore.getState().laneWorkViewByScope["/p/c::lane-c"]?.openItemIds).toEqual(["session-c"]);
        expect(useAppStore.getState().laneSelectionByProject["/p/c"]).toEqual({
          laneId: "lane-c",
          sessionId: "session-c",
        });
        expect(useAppStore.getState().laneCacheByProject["/p/c"]?.lanes[0]?.id).toBe("lane-c");
        expect(useAppStore.getState().sessionsCacheByProject["/p/c"]).toEqual([{ id: "session-c" }]);

        expect(useAppStore.getState().workViewByProject["/p/d"]).toBeUndefined();
        expect(useAppStore.getState().laneWorkViewByScope["/p/d::lane-d"]).toBeUndefined();
        expect(useAppStore.getState().laneSelectionByProject["/p/d"]).toBeUndefined();
        expect(useAppStore.getState().laneCacheByProject["/p/d"]).toBeUndefined();
        expect(useAppStore.getState().sessionsCacheByProject["/p/d"]).toBeUndefined();
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

    it("ignores stale switchRemoteProject completions when a newer switch starts", async () => {
      const bindingA = {
        kind: "remote" as const,
        key: "remote:target-1:project-a",
        targetId: "target-1",
        runtimeName: "Remote",
        projectId: "project-a",
        rootPath: "/remote/a",
        displayName: "Project A",
      };
      const bindingB = {
        kind: "remote" as const,
        key: "remote:target-1:project-b",
        targetId: "target-1",
        runtimeName: "Remote",
        projectId: "project-b",
        rootPath: "/remote/b",
        displayName: "Project B",
      };
      let resolveSlow: (value: typeof bindingA) => void = () => {};
      (window.ade.remoteRuntime.openProject as any).mockImplementation(
        async (_targetId: string, projectId: string) => {
          if (projectId === "project-a") {
            return await new Promise((resolve) => {
              resolveSlow = resolve as (value: typeof bindingA) => void;
            });
          }
          return bindingB;
        },
      );

      const slowSwitch = useAppStore.getState().switchRemoteProject("target-1", "project-a");
      await useAppStore.getState().switchRemoteProject("target-1", "project-b");

      expect(useAppStore.getState().project).toEqual({
        rootPath: "/remote/b",
        displayName: "Project B",
        baseRef: "main",
      });
      expect(useAppStore.getState().projectBinding).toEqual(bindingB);

      resolveSlow(bindingA);
      await slowSwitch;

      expect(useAppStore.getState().project?.rootPath).toBe("/remote/b");
      expect(useAppStore.getState().projectBinding).toEqual(bindingB);
    });

    it("drops stale project-scoped Work and lane caches when opening a remote project", async () => {
      const binding = {
        kind: "remote" as const,
        key: "remote:target-1:project-a",
        targetId: "target-1",
        runtimeName: "Remote",
        projectId: "project-a",
        rootPath: "/remote/a",
        displayName: "Project A",
      };
      const defaultWorkState = useAppStore.getState().getWorkViewState("/remote/a");
      (window.ade.remoteRuntime.openProject as any).mockResolvedValueOnce(binding);
      useAppStore.setState({
        project: { rootPath: "/local/project", displayName: "Local", baseRef: "main" } as any,
        selectedLaneId: "local-lane",
        focusedSessionId: "local-session",
        workViewByProject: {
          "/remote/a": {
            ...defaultWorkState,
            openItemIds: ["local-session"],
            activeItemId: "local-session",
            selectedItemId: "local-session",
          },
          "/local/project": {
            ...defaultWorkState,
            openItemIds: ["local-session"],
            activeItemId: "local-session",
          },
        },
        laneWorkViewByScope: {
          "/remote/a::local-lane": {
            ...defaultWorkState,
            openItemIds: ["local-session"],
          },
          "/local/project::local-lane": {
            ...defaultWorkState,
            openItemIds: ["local-session"],
          },
        },
        laneSelectionByProject: {
          "/remote/a": { laneId: "local-lane", sessionId: "local-session" },
          "/local/project": { laneId: "local-lane", sessionId: "local-session" },
        },
        laneCacheByProject: {
          "/remote/a": { lanes: [{ id: "local-lane", name: "Local lane" }] as any[], laneSnapshots: [] },
          "/local/project": { lanes: [{ id: "local-lane", name: "Local lane" }] as any[], laneSnapshots: [] },
        },
        sessionsCacheByProject: {
          "/remote/a": [{ id: "local-session", laneId: "local-lane" }],
          "/local/project": [{ id: "local-session", laneId: "local-lane" }],
        },
      } as any);

      await useAppStore.getState().switchRemoteProject("target-1", "project-a");

      const state = useAppStore.getState();
      expect(state.project).toEqual({
        rootPath: "/remote/a",
        displayName: "Project A",
        baseRef: "main",
      });
      expect(state.selectedLaneId).toBeNull();
      expect(state.focusedSessionId).toBeNull();
      expect(state.workViewByProject["/remote/a"]).toBeUndefined();
      expect(state.laneWorkViewByScope["/remote/a::local-lane"]).toBeUndefined();
      expect(state.laneSelectionByProject["/remote/a"]).toBeUndefined();
      expect(state.laneCacheByProject["/remote/a"]).toBeUndefined();
      expect(state.sessionsCacheByProject["/remote/a"]).toBeUndefined();
      expect(state.workViewByProject["/local/project"]?.openItemIds).toEqual(["local-session"]);
      expect(state.laneWorkViewByScope["/local/project::local-lane"]?.openItemIds).toEqual(["local-session"]);
      expect(state.laneSelectionByProject["/local/project"]).toEqual({
        laneId: "local-lane",
        sessionId: "local-session",
      });
      expect(state.laneCacheByProject["/local/project"]?.lanes[0]?.id).toBe("local-lane");
      expect(state.sessionsCacheByProject["/local/project"]).toEqual([
        { id: "local-session", laneId: "local-lane" },
      ]);
    });
  });
});
