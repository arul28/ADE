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
      switchToPath: vi.fn(async () => null),
      closeCurrent: vi.fn(async () => {}),
    },
  },
};

// Import after window is set up
import type { WorkProjectViewState } from "./appStore";
import { useAppStore, THEME_IDS } from "./appStore";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Reset store to initial state between tests */
function resetStore() {
  useAppStore.setState({
    project: null,
    projectHydrated: false,
    showWelcome: true,
    laneSnapshots: [],
    lanes: [],
    selectedLaneId: null,
    runLaneId: null,
    focusedSessionId: null,
    laneInspectorTabs: {},
    workViewByProject: {},
    laneWorkViewByScope: {},
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
      expect(mockLocalStorage.setItem).toHaveBeenCalledWith("ade.theme", "light");
    });

    it("persists dark theme", () => {
      useAppStore.getState().setTheme("dark");
      expect(useAppStore.getState().theme).toBe("dark");
      expect(mockLocalStorage.setItem).toHaveBeenCalledWith("ade.theme", "dark");
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
      });
      expect(useAppStore.getState().laneSnapshots).toEqual(snapshots);
      expect(useAppStore.getState().lanes).toEqual([snapshots[0].lane]);
    });

    it("refreshLanes can request the cheaper snapshot bootstrap path", async () => {
      await useAppStore.getState().refreshLanes({ includeStatus: false });

      expect(window.ade.lanes.listSnapshots).toHaveBeenCalledWith({
        includeArchived: false,
        includeStatus: false,
      });
    });

    it("selectLane updates selectedLaneId", () => {
      useAppStore.getState().selectLane("lane-42");
      expect(useAppStore.getState().selectedLaneId).toBe("lane-42");
    });

    it("selectRunLane updates runLaneId", () => {
      useAppStore.getState().selectRunLane("lane-99");
      expect(useAppStore.getState().runLaneId).toBe("lane-99");
    });

    it("focusSession updates focusedSessionId", () => {
      useAppStore.getState().focusSession("session-abc");
      expect(useAppStore.getState().focusedSessionId).toBe("session-abc");
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
});
