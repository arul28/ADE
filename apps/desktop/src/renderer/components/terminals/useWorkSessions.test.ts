/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { WorkChatSessionCreatedDetail } from "../../lib/chatSessionEvents";

// ---------------------------------------------------------------------------
// Spies used across all tests
// ---------------------------------------------------------------------------
const focusSessionSpy = vi.fn();
const selectLaneSpy = vi.fn();
const setWorkViewStateSpy = vi.fn();
const refreshLanesSpy = vi.fn();
const navigateSpy = vi.fn();
let fakeAppStoreState: Record<string, unknown>;
const routerLocation = {
  pathname: "/work",
  search: "",
  hash: "",
};

function resetFakeAppStoreState() {
  fakeAppStoreState = {
    project: { rootPath: "/fake/project" },
    lanes: [{ id: "lane-1", name: "Lane 1" }],
    focusSession: focusSessionSpy,
    focusedSessionId: null,
    selectLane: selectLaneSpy,
    refreshLanes: refreshLanesSpy.mockResolvedValue(undefined),
    workViewByProject: {},
    setWorkViewState: setWorkViewStateSpy,
    sessionsCacheByProject: {},
    crossMachineLanesByMachineId: {},
  };
  routerLocation.pathname = "/work";
  routerLocation.search = "";
  routerLocation.hash = "";
}

// ---------------------------------------------------------------------------
// Module-level mocks (hoisted by vitest)
// ---------------------------------------------------------------------------

const { listSessionsCachedMock, useSearchParamsMock, workChatSessionCreatedListeners } = vi.hoisted(() => ({
  listSessionsCachedMock: vi.fn().mockResolvedValue([]),
  useSearchParamsMock: vi.fn(() => [new URLSearchParams(), vi.fn()]),
  workChatSessionCreatedListeners: new Set<(detail: WorkChatSessionCreatedDetail) => void>(),
}));

vi.mock("../../lib/sessionListCache", () => ({
  listSessionsCached: (...args: unknown[]) => listSessionsCachedMock(...args),
  invalidateSessionListCache: vi.fn(),
}));

vi.mock("../../lib/chatSessionEvents", () => ({
  shouldRefreshSessionListForChatEvent: vi.fn(() => false),
  subscribeWorkChatSessionCreated: vi.fn((listener: (detail: WorkChatSessionCreatedDetail) => void) => {
    workChatSessionCreatedListeners.add(listener);
    return () => workChatSessionCreatedListeners.delete(listener);
  }),
}));

vi.mock("../../lib/terminalAttention", async () => {
  const actual = await vi.importActual<typeof import("../../lib/terminalAttention")>("../../lib/terminalAttention");
  return actual;
});

vi.mock("../../lib/sessions", () => ({
  buildOptimisticChatSessionSummary: vi.fn((args: { session: { id: string; laneId: string }; laneName?: string | null }) => ({
    id: args.session.id,
    laneId: args.session.laneId,
    laneName: args.laneName ?? args.session.laneId,
    ptyId: null,
    tracked: true,
    pinned: false,
    goal: null,
    toolType: "claude-chat",
    title: "Claude chat",
    status: "running",
    startedAt: "2026-04-01T12:00:00.000Z",
    endedAt: null,
    exitCode: null,
    transcriptPath: "",
    headShaStart: null,
    headShaEnd: null,
    lastOutputPreview: null,
    summary: null,
    runtimeState: "idle",
    resumeCommand: null,
  })),
  isChatToolType: vi.fn(() => false),
}));

vi.mock("react-router-dom", () => ({
  useNavigate: vi.fn(() => navigateSpy),
  useLocation: vi.fn(() => routerLocation),
  useSearchParams: useSearchParamsMock,
}));

vi.mock("../../state/appStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/appStore")>();
  const useAppStore = vi.fn((selector: (state: Record<string, unknown>) => unknown) => {
    return selector(fakeAppStoreState);
  }) as unknown as {
    (selector: (state: Record<string, unknown>) => unknown): unknown;
    getState: () => Record<string, unknown>;
    setState: (
      partial:
        | Record<string, unknown>
        | ((prev: Record<string, unknown>) => Record<string, unknown>),
    ) => void;
  };
  useAppStore.getState = () => fakeAppStoreState;
  useAppStore.setState = (partial) => {
    const next = typeof partial === "function" ? partial(fakeAppStoreState) : partial;
    Object.assign(fakeAppStoreState, next);
  };
  const appStoreApi = {
    getState: useAppStore.getState,
    setState: useAppStore.setState,
    subscribe: vi.fn(() => () => {}),
  };
  const useAppStoreApi = () => appStoreApi;
  const selectActiveProjectRoot = (state: Record<string, unknown>) => {
    const binding = state.projectBinding as { kind?: string; rootPath?: string | null } | null | undefined;
    if (binding?.kind === "remote") return binding.rootPath?.trim() || null;
    const project = state.project as { rootPath?: string | null } | null | undefined;
    return project?.rootPath?.trim() || null;
  };
  const selectActiveProjectStateKey = (state: Record<string, unknown>) => {
    const binding = state.projectBinding as { kind?: string; key?: string | null } | null | undefined;
    if (binding?.kind === "remote") return binding.key?.trim() || null;
    return selectActiveProjectRoot(state);
  };
  return {
    createDefaultWorkProjectViewState: actual.createDefaultWorkProjectViewState,
    selectActiveProjectRoot,
    selectActiveProjectStateKey,
    useAppStore,
    useAppStoreApi,
    useRootAppStore: useAppStore,
  };
});

// ---------------------------------------------------------------------------
// Import the hook under test (after mocks are declared)
// ---------------------------------------------------------------------------
import { buildWorkTabGroupModel, reorderLaneSessionIdsForDisplay, useWorkSessions } from "./useWorkSessions";
import { invalidateSessionListCache } from "../../lib/sessionListCache";
import { shouldRefreshSessionListForChatEvent } from "../../lib/chatSessionEvents";

// ---------------------------------------------------------------------------
// window.ade stubs
// ---------------------------------------------------------------------------

function installWindowAde() {
  (window as any).ade = {
    sessions: {
      onChanged: vi.fn(() => () => {}),
    },
    pty: {
      create: vi.fn().mockResolvedValue({ sessionId: "new-pty-session", ptyId: "pty-1" }),
      onExit: vi.fn(() => () => {}),
      dispose: vi.fn().mockResolvedValue(undefined),
    },
    agentChat: {
      onEvent: vi.fn(() => () => {}),
      resume: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
    },
  };
}

function makeSession(id: string, laneId: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    laneId,
    laneName: laneId,
    ptyId: null,
    tracked: true,
    pinned: false,
    goal: null,
    toolType: "claude-chat" as const,
    title: id,
    status: "running" as const,
    startedAt: "2026-04-01T12:00:00.000Z",
    endedAt: null,
    exitCode: null,
    transcriptPath: "",
    headShaStart: null,
    headShaEnd: null,
    lastOutputPreview: null,
    summary: null,
    runtimeState: "running" as const,
    resumeCommand: null,
    ...overrides,
  };
}

function setDocumentVisibility(value: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useWorkSessions — refresh-before-focus ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFakeAppStoreState();
    installWindowAde();
    listSessionsCachedMock.mockResolvedValue([]);
    useSearchParamsMock.mockReturnValue([new URLSearchParams(), vi.fn()]);
    setDocumentVisibility("visible");
  });

  afterEach(() => {
    cleanup();
    setDocumentVisibility("visible");
    delete (window as any).ade;
  });

  // -----------------------------------------------------------------------
  // launchPtySession: focus/open immediately; refresh reconciles in background.
  // -----------------------------------------------------------------------
  it("launchPtySession opens the optimistic terminal before the forced refresh completes", async () => {
    const callOrder: string[] = [];
    const workState = {
      openItemIds: [] as string[],
      activeItemId: null as string | null,
      selectedItemId: null as string | null,
      draftKind: "chat" as const,
      laneFilter: "all",
      search: "",
      sessionListOrganization: "by-lane" as const,
      workCollapsedLaneIds: [] as string[],
      workCollapsedTabGroupIds: [] as string[],
      workFocusSessionsHidden: false,
    };
    fakeAppStoreState = {
      ...fakeAppStoreState,
      workViewByProject: { "/fake/project": workState },
    };

    const { result } = renderHook(() => useWorkSessions());

    // Flush mount effects (initial refresh)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // Install ordering instrumentation for the refresh inside launchPtySession
    let refreshResolve: (() => void) | null = null;
    listSessionsCachedMock.mockImplementation(() => {
      callOrder.push("refresh-start");
      return new Promise<never[]>((resolve) => {
        refreshResolve = () => {
          callOrder.push("refresh-done");
          resolve([]);
        };
      });
    });

    focusSessionSpy.mockImplementation(() => {
      callOrder.push("focusSession");
    });
    // openSessionTab calls setWorkViewState (via setProjectViewState)
    setWorkViewStateSpy.mockImplementation((_projectRoot: string, next: any) => {
      const beforeHasLaunchedTab = workState.openItemIds.includes("new-pty-session");
      const resolved = typeof next === "function" ? next(workState) : { ...workState, ...next };
      Object.assign(workState, resolved);
      if (!beforeHasLaunchedTab && workState.openItemIds.includes("new-pty-session")) {
        callOrder.push("openSessionTab");
      }
    });

    await act(async () => {
      await result.current.launchPtySession({
        laneId: "lane-1",
        profile: "claude",
        initialInput: "queued prompt",
        initialInputDelayMs: 750,
      });
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(callOrder).toContain("focusSession");
    expect(callOrder).toContain("openSessionTab");
    expect(callOrder).toContain("refresh-start");
    expect(callOrder).not.toContain("refresh-done");
    expect((window as any).ade.pty.create).toHaveBeenCalledWith(
      expect.objectContaining({
        initialInput: "queued prompt",
        initialInputDelayMs: 750,
      }),
    );
    expect((window as any).ade.pty.create.mock.calls.at(-1)?.[0]).not.toHaveProperty("awaitInitialInput");

    // Resolve the refresh promise
    await act(async () => {
      expect(refreshResolve).not.toBeNull();
      refreshResolve!();
      await Promise.resolve();
    });

    // Verify ordering: focus/open happen before refresh completes.
    const refreshDoneIdx = callOrder.indexOf("refresh-done");
    const focusIdx = callOrder.indexOf("focusSession");
    const openTabIdx = callOrder.indexOf("openSessionTab");

    expect(refreshDoneIdx).toBeGreaterThanOrEqual(0);
    expect(focusIdx).toBeGreaterThanOrEqual(0);
    expect(openTabIdx).toBeGreaterThanOrEqual(0);
    expect(focusIdx).toBeLessThan(refreshDoneIdx);
    expect(openTabIdx).toBeLessThan(refreshDoneIdx);
  });

  it("lightly refreshes lanes when Work sessions load before lane state recovers", async () => {
    fakeAppStoreState = {
      ...fakeAppStoreState,
      lanes: [],
    };
    listSessionsCachedMock.mockResolvedValue([
      makeSession("session-1", "lane-1"),
    ]);

    renderHook(() => useWorkSessions());

    await waitFor(() => {
      expect(refreshLanesSpy).toHaveBeenCalledWith({
        includeStatus: false,
        includeSnapshots: false,
        includeConflictStatus: false,
        includeRebaseSuggestions: false,
        includeAutoRebaseStatus: false,
      });
    });
    expect(refreshLanesSpy).toHaveBeenCalledTimes(1);
  });

  it("lightly refreshes lanes when Work sessions reference a lane missing from cached lane state", async () => {
    fakeAppStoreState = {
      ...fakeAppStoreState,
      lanes: [{ id: "lane-primary", name: "Primary" }],
    };
    listSessionsCachedMock.mockResolvedValue([
      makeSession("session-1", "lane-mobile"),
    ]);

    renderHook(() => useWorkSessions());

    await waitFor(() => {
      expect(refreshLanesSpy).toHaveBeenCalledWith({
        includeStatus: false,
        includeSnapshots: false,
        includeConflictStatus: false,
        includeRebaseSuggestions: false,
        includeAutoRebaseStatus: false,
      });
    });
    expect(refreshLanesSpy).toHaveBeenCalledTimes(1);
  });

  it("passes permission mode through to tracked CLI launch fields", async () => {
    const { result } = renderHook(() => useWorkSessions());

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    await act(async () => {
      await result.current.launchPtySession({
        laneId: "lane-1",
        profile: "codex",
        permissionMode: "plan",
      });
    });

    expect((window as any).ade.pty.create).toHaveBeenCalledWith(expect.objectContaining({
      laneId: "lane-1",
      toolType: "codex",
      startupCommand: expect.stringContaining("codex --no-alt-screen --sandbox read-only --ask-for-approval on-request"),
    }));
  });

  it("does not retry lane recovery on every session refresh after a failure", async () => {
    fakeAppStoreState = {
      ...fakeAppStoreState,
      lanes: [],
    };
    refreshLanesSpy.mockRejectedValue(new Error("IPC unavailable"));
    listSessionsCachedMock.mockResolvedValue([
      makeSession("session-1", "lane-1"),
    ]);

    const { result } = renderHook(() => useWorkSessions());

    await waitFor(() => {
      expect(refreshLanesSpy).toHaveBeenCalledTimes(1);
    });

    listSessionsCachedMock.mockResolvedValue([
      makeSession("session-2", "lane-1"),
    ]);
    await act(async () => {
      await result.current.refresh({ force: true });
    });

    expect(refreshLanesSpy).toHaveBeenCalledTimes(1);
  });

  it("launchPtySession keeps the new terminal visible when the forced refresh is stale", async () => {
    const workState = {
      openItemIds: [] as string[],
      activeItemId: null as string | null,
      selectedItemId: null as string | null,
      draftKind: "cli" as const,
      laneFilter: "all",
      search: "",
      sessionListOrganization: "by-lane" as const,
      workCollapsedLaneIds: [] as string[],
      workCollapsedTabGroupIds: [] as string[],
      workFocusSessionsHidden: false,
    };
    fakeAppStoreState = {
      ...fakeAppStoreState,
      workViewByProject: { "/fake/project": workState },
    };
    setWorkViewStateSpy.mockImplementation((_projectRoot: string, next: any) => {
      const resolved = typeof next === "function" ? next(workState) : { ...workState, ...next };
      Object.assign(workState, resolved);
    });
    listSessionsCachedMock.mockResolvedValue([makeSession("existing-session", "lane-1")]);
    (window as any).ade.pty.create.mockResolvedValueOnce({
      sessionId: "new-pty-session",
      ptyId: "pty-1",
      pid: 1234,
    });

    const { result } = renderHook(() => useWorkSessions());

    await waitFor(() => {
      expect(result.current.sessions).toEqual([
        expect.objectContaining({ id: "existing-session" }),
      ]);
    });
    listSessionsCachedMock.mockClear();
    listSessionsCachedMock.mockResolvedValue([]);

    await act(async () => {
      await result.current.launchPtySession({
        laneId: "lane-1",
        profile: "codex",
        title: "Dina prompt",
      });
    });

    expect(listSessionsCachedMock).toHaveBeenCalledWith({ limit: 500 }, { force: true });
    expect(result.current.sessions).toEqual([
      expect.objectContaining({
        id: "new-pty-session",
        ptyId: "pty-1",
        title: "Dina prompt",
        toolType: "codex",
        status: "running",
      }),
    ]);
    expect(workState.openItemIds).toContain("new-pty-session");
    expect(workState.activeItemId).toBe("new-pty-session");
    expect(workState.selectedItemId).toBe("new-pty-session");
  });

  it("keeps a stopped runtime closed when a stale refresh returns the old running row", async () => {
    const staleRunningSession = makeSession("session-stop", "lane-1", {
      ptyId: "pty-stop",
      toolType: "codex",
      runtimeState: "running",
    });
    listSessionsCachedMock.mockResolvedValue([staleRunningSession]);

    const { result } = renderHook(() => useWorkSessions());

    await waitFor(() => {
      expect(result.current.sessions[0]?.id).toBe("session-stop");
    });

    listSessionsCachedMock.mockClear();
    listSessionsCachedMock.mockResolvedValue([staleRunningSession]);

    await act(async () => {
      await result.current.stopRuntime("pty-stop", "session-stop");
    });

    await waitFor(() => {
      expect(listSessionsCachedMock).toHaveBeenCalledWith({ limit: 500 }, { force: true });
    });
    expect((window as any).ade.pty.dispose).toHaveBeenCalledWith({
      ptyId: "pty-stop",
      sessionId: "session-stop",
    });
    expect(result.current.sessions[0]).toMatchObject({
      id: "session-stop",
      ptyId: null,
      status: "disposed",
      runtimeState: "killed",
      exitCode: null,
    });
  });

  it("restores a runtime row when dispose reports that a peer still owns it", async () => {
    const peerOwnedSession = makeSession("session-peer", "lane-1", {
      ptyId: "pty-peer",
      toolType: "codex",
      runtimeState: "running",
    });
    listSessionsCachedMock.mockResolvedValue([peerOwnedSession]);
    (window as any).ade.pty.dispose.mockResolvedValueOnce({
      disposed: false,
      reason: "owned-by-peer",
    });

    const { result } = renderHook(() => useWorkSessions());

    await waitFor(() => {
      expect(result.current.sessions[0]?.id).toBe("session-peer");
    });

    listSessionsCachedMock.mockClear();
    listSessionsCachedMock.mockRejectedValueOnce(new Error("refresh failed"));

    await act(async () => {
      await result.current.stopRuntime("pty-peer", "session-peer");
    });

    await waitFor(() => {
      expect(result.current.sessions[0]).toMatchObject({
        id: "session-peer",
        ptyId: "pty-peer",
        status: "running",
        runtimeState: "running",
      });
    });
    expect(listSessionsCachedMock).toHaveBeenCalledWith({ limit: 500 }, { force: true });
  });

  it("keeps a runtime row stopped when dispose reports the pty is already gone", async () => {
    const missingPtySession = makeSession("session-missing", "lane-1", {
      ptyId: "pty-missing",
      toolType: "codex",
      runtimeState: "running",
    });
    listSessionsCachedMock.mockResolvedValue([missingPtySession]);
    (window as any).ade.pty.dispose.mockResolvedValueOnce({
      disposed: false,
      reason: "missing",
    });

    const { result } = renderHook(() => useWorkSessions());

    await waitFor(() => {
      expect(result.current.sessions[0]?.id).toBe("session-missing");
    });

    listSessionsCachedMock.mockClear();
    listSessionsCachedMock.mockRejectedValueOnce(new Error("refresh failed"));

    await act(async () => {
      await result.current.stopRuntime("pty-missing", "session-missing");
    });

    await waitFor(() => {
      expect(result.current.sessions[0]).toMatchObject({
        id: "session-missing",
        ptyId: null,
        status: "disposed",
        runtimeState: "killed",
        exitCode: null,
      });
    });
    expect(listSessionsCachedMock).toHaveBeenCalledWith({ limit: 500 }, { force: true });
  });

  it("restores a runtime row when dispose reports a session mismatch", async () => {
    const stalePtySession = makeSession("session-mismatch", "lane-1", {
      ptyId: "pty-stale",
      toolType: "codex",
      runtimeState: "running",
    });
    listSessionsCachedMock.mockResolvedValue([stalePtySession]);
    (window as any).ade.pty.dispose.mockResolvedValueOnce({
      disposed: false,
      reason: "session-mismatch",
    });

    const { result } = renderHook(() => useWorkSessions());

    await waitFor(() => {
      expect(result.current.sessions[0]?.id).toBe("session-mismatch");
    });

    listSessionsCachedMock.mockClear();
    listSessionsCachedMock.mockRejectedValueOnce(new Error("refresh failed"));

    await act(async () => {
      await result.current.stopRuntime("pty-stale", "session-mismatch");
    });

    await waitFor(() => {
      expect(result.current.sessions[0]).toMatchObject({
        id: "session-mismatch",
        ptyId: "pty-stale",
        status: "running",
        runtimeState: "running",
      });
    });
    expect(listSessionsCachedMock).toHaveBeenCalledWith({ limit: 500 }, { force: true });
  });

  it("launchPtySession can start a terminal in the background without changing the active tab", async () => {
    const workState = {
      openItemIds: ["existing-session"] as string[],
      activeItemId: "existing-session" as string | null,
      selectedItemId: "existing-session" as string | null,
      draftKind: "cli" as const,
      laneFilter: "all",
      search: "",
      sessionListOrganization: "by-lane" as const,
      workCollapsedLaneIds: [] as string[],
      workCollapsedTabGroupIds: [] as string[],
      workFocusSessionsHidden: false,
    };
    fakeAppStoreState = {
      ...fakeAppStoreState,
      workViewByProject: { "/fake/project": workState },
    };
    setWorkViewStateSpy.mockImplementation((_projectRoot: string, next: any) => {
      const resolved = typeof next === "function" ? next(workState) : { ...workState, ...next };
      Object.assign(workState, resolved);
    });
    listSessionsCachedMock.mockResolvedValue([makeSession("existing-session", "lane-1")]);
    (window as any).ade.pty.create.mockResolvedValueOnce({
      sessionId: "background-pty-session",
      ptyId: "pty-bg",
      pid: 1234,
    });

    const { result } = renderHook(() => useWorkSessions());

    await waitFor(() => {
      expect(listSessionsCachedMock).toHaveBeenCalled();
    });
    listSessionsCachedMock.mockClear();
    listSessionsCachedMock.mockResolvedValue([makeSession("existing-session", "lane-1")]);

    await act(async () => {
      await result.current.launchPtySession({
        laneId: "lane-1",
        profile: "codex",
        title: "Background prompt",
        disposition: "background",
      });
    });

    expect(result.current.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "background-pty-session",
        ptyId: "pty-bg",
        title: "Background prompt",
        toolType: "codex",
        status: "running",
      }),
    ]));
    expect(workState.openItemIds).toEqual(["existing-session"]);
    expect(workState.activeItemId).toBe("existing-session");
    expect(workState.selectedItemId).toBe("existing-session");
    expect(focusSessionSpy).not.toHaveBeenCalledWith("background-pty-session");
  });

  it("applies optimistic UI for a session pinned to another open machine", async () => {
    // Regression: `canMutatePinnedProjectUi` used to require the pin to equal
    // the ACTIVE binding, which meant "stale detached launch". Under per-chat
    // runtime routing a pin that differs from the active binding is the normal
    // state for every chat whose lane lives on another machine — dropping those
    // updates would silently blank exactly the sessions that feature adds. The
    // question is now whether the pinned binding is still open.
    const otherMachine = {
      kind: "remote",
      key: "remote:target-b:project-b",
      targetId: "target-b",
      runtimeName: "MacBook Pro (97)",
      projectId: "project-b",
      rootPath: "/Users/admin/Projects/ADE",
      displayName: "ADE",
    } as const;
    const closedMachine = { ...otherMachine, key: "remote:target-z:project-z" } as const;

    fakeAppStoreState = {
      ...fakeAppStoreState,
      projectBinding: { kind: "local", key: "/fake/project", rootPath: "/fake/project", displayName: "Fake" },
      openRemoteProjectTabs: [otherMachine],
      openProjectTabRoots: ["/fake/project"],
    };

    (window as any).ade.pty.create
      .mockResolvedValueOnce({ sessionId: "foreign-open", ptyId: "pty-foreign", pid: 41 })
      .mockResolvedValueOnce({ sessionId: "foreign-closed", ptyId: "pty-closed", pid: 42 })
      .mockResolvedValueOnce({ sessionId: "local-background", ptyId: "pty-local", pid: 43 });

    const { result } = renderHook(() => useWorkSessions());
    await waitFor(() => {
      expect(listSessionsCachedMock).toHaveBeenCalled();
    });

    await act(async () => {
      await result.current.launchPtySession({
        laneId: "lane-1", profile: "codex", title: "On the other machine", pin: otherMachine as any,
      });
    });

    // The pinned binding is open but not active — its UI update must land.
    expect(result.current.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "foreign-open", ptyId: "pty-foreign" }),
    ]));

    await act(async () => {
      await result.current.launchPtySession({
        laneId: "lane-1", profile: "codex", title: "On a closed machine", pin: closedMachine as any,
      });
    });

    // A pin for a project that is no longer open is still discarded.
    expect(result.current.sessions).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "foreign-closed" }),
    ]));

    await act(async () => {
      await result.current.launchPtySession({
        laneId: "lane-1",
        profile: "codex",
        title: "Open background local tab",
        pin: {
          kind: "local",
          key: "local:/fake/project",
          rootPath: "/fake/project",
          displayName: "Fake",
        },
      });
    });
    expect(result.current.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "local-background", ptyId: "pty-local" }),
    ]));
  });

  it("opens a foreign union chat in the Work view without adding it to the local session list", async () => {
    const foreign = makeSession("foreign-chat", "foreign-lane");
    const workState = {
      openItemIds: ["foreign-chat"],
      activeItemId: "foreign-chat",
      selectedItemId: "foreign-chat",
      gridSets: [],
      activeGridSetId: null,
      draftKind: "chat" as const,
      orchestratorEnabled: false,
      draftLaneId: null,
      laneFilter: "all",
      search: "",
      sessionListOrganization: "by-lane" as const,
      workCollapsedLaneIds: [],
      workCollapsedSectionIds: [],
      workCollapsedTabGroupIds: [],
      workFocusSessionsHidden: false,
      workSidebarOpen: false,
      workSidebarTab: "git" as const,
      workSidebarWidthPct: 36,
      laneSessionOrder: {},
      pinnedSessionIds: [],
    };
    fakeAppStoreState = {
      ...fakeAppStoreState,
      workViewByProject: {
        "/fake/project": workState,
      },
      crossMachineLanesByMachineId: {
        "target-b": {
          machineId: "target-b",
          machineName: "MacBook Pro (97)",
          targetId: "target-b",
          projectId: "project-b",
          binding: {
            kind: "remote",
            key: "remote:target-b:project-b",
            targetId: "target-b",
            runtimeName: "MacBook Pro (97)",
            projectId: "project-b",
            rootPath: "/repo-b",
            displayName: "Repo B",
          },
          online: true,
          lanes: [],
          sessions: [foreign],
          lastSyncedAtMs: Date.now(),
          error: null,
        },
      },
    };

    const { result } = renderHook(() => useWorkSessions());
    await waitFor(() => expect(listSessionsCachedMock).toHaveBeenCalled());

    expect(result.current.sessions).not.toContainEqual(foreign);
    expect(result.current.visibleSessions).toContainEqual(foreign);
    expect(selectLaneSpy).not.toHaveBeenCalledWith("foreign-lane");
    const appliedStates = setWorkViewStateSpy.mock.calls.map(([, next]) => (
      typeof next === "function" ? next(workState) : { ...workState, ...next }
    ));
    expect(appliedStates).not.toContainEqual(expect.objectContaining({
      openItemIds: [],
      activeItemId: null,
      selectedItemId: null,
    }));
  });

  it("launchPtySession carries its project pin into stopRuntime", async () => {
    const pin = {
      kind: "local",
      key: "local:/origin/project",
      rootPath: "/origin/project",
      displayName: "Origin",
    } as const;
    fakeAppStoreState = {
      ...fakeAppStoreState,
      projectBinding: {
        kind: "local",
        key: "local:/fake/project",
        rootPath: "/fake/project",
        displayName: "Fake",
      },
      openProjectTabRoots: [pin.rootPath],
    };
    (window as any).ade.pty.create.mockResolvedValueOnce({
      sessionId: "pinned-pty-session",
      ptyId: "pinned-pty",
      pid: 1234,
    });
    listSessionsCachedMock.mockResolvedValue([]);

    const { result } = renderHook(() => useWorkSessions());

    await waitFor(() => {
      expect(listSessionsCachedMock).toHaveBeenCalled();
    });

    await act(async () => {
      await result.current.launchPtySession({
        laneId: "lane-1",
        profile: "codex",
        title: "Pinned prompt",
        pin,
      });
    });

    expect((window as any).ade.pty.create).toHaveBeenLastCalledWith(expect.objectContaining({
      laneId: "lane-1",
      title: "Pinned prompt",
    }), pin);

    await act(async () => {
      await result.current.stopRuntime("pinned-pty", "pinned-pty-session");
    });

    expect((window as any).ade.pty.dispose).toHaveBeenLastCalledWith({
      ptyId: "pinned-pty",
      sessionId: "pinned-pty-session",
    }, pin);
  });

  it("keeps a remembered foreign pin while the cross-machine lane map is cleared", async () => {
    const foreignBinding = {
      kind: "remote",
      key: "remote:target-b:project-b",
      targetId: "target-b",
      runtimeName: "Machine B",
      projectId: "project-b",
      rootPath: "/repo-b",
      displayName: "Repo B",
    } as const;
    const foreignSession = makeSession("pin-flap", "lane-b", {
      ptyId: "pty-pin-flap",
      toolType: "codex",
    });
    fakeAppStoreState = {
      ...fakeAppStoreState,
      projectBinding: {
        kind: "local",
        key: "local:/fake/project",
        rootPath: "/fake/project",
        displayName: "Fake",
      },
      crossMachineLanesByMachineId: {
        "target-b": {
          binding: foreignBinding,
          lanes: [{ id: "lane-b" }],
          sessions: [foreignSession],
        },
      },
    };

    const { result, rerender } = renderHook(() => useWorkSessions());
    await waitFor(() => expect(listSessionsCachedMock).toHaveBeenCalled());
    act(() => {
      result.current.machineRouter.rememberSessionPin(foreignSession, foreignBinding);
    });
    expect(result.current.resolveSessionRuntimePin(foreignSession)).toBe(foreignBinding);

    fakeAppStoreState = {
      ...fakeAppStoreState,
      crossMachineLanesByMachineId: {},
    };
    rerender();

    expect(result.current.machineRouter.isLivePin(foreignBinding)).toBe(false);
    expect(result.current.resolveSessionRuntimePin(foreignSession)).toBe(foreignBinding);
    act(() => {
      result.current.machineRouter.forgetSessionPin(foreignSession);
    });
  });

  it("collapses a remembered pin to null after the tab rebinds to that machine", async () => {
    const activeBinding = {
      kind: "remote",
      key: "remote:target-b:project-b",
      targetId: "target-b",
      runtimeName: "Machine B",
      projectId: "project-b",
      rootPath: "/repo-b",
      displayName: "Repo B",
    } as const;
    const session = makeSession("pin-now-active", "lane-b", {
      ptyId: "pty-pin-now-active",
      toolType: "codex",
    });
    fakeAppStoreState = {
      ...fakeAppStoreState,
      projectBinding: activeBinding,
      crossMachineLanesByMachineId: {},
    };

    const { result } = renderHook(() => useWorkSessions());
    await waitFor(() => expect(listSessionsCachedMock).toHaveBeenCalled());
    act(() => {
      result.current.machineRouter.rememberSessionPin(session, activeBinding);
    });

    expect(result.current.resolveSessionRuntimePin(session)).toBeNull();
    act(() => {
      result.current.machineRouter.forgetSessionPin(session);
    });
  });

  it("stops a restored foreign session on its owning binding without a launch-registry entry", async () => {
    const foreignBinding = {
      kind: "remote",
      key: "remote:target-b:project-b",
      targetId: "target-b",
      runtimeName: "Machine B",
      projectId: "project-b",
      rootPath: "/repo-b",
      displayName: "Repo B",
    } as const;
    const foreignSession = makeSession("restored-foreign", "lane-b", {
      ptyId: "pty-restored-foreign",
      toolType: "codex",
    });
    fakeAppStoreState = {
      ...fakeAppStoreState,
      projectBinding: {
        kind: "local",
        key: "local:/fake/project",
        rootPath: "/fake/project",
        displayName: "Fake",
      },
      openRemoteProjectTabs: [foreignBinding],
      crossMachineLanesByMachineId: {
        "target-b": {
          binding: foreignBinding,
          lanes: [{ id: "lane-b" }],
          sessions: [foreignSession],
        },
      },
    };

    const { result } = renderHook(() => useWorkSessions());
    await waitFor(() => expect(listSessionsCachedMock).toHaveBeenCalled());

    await act(async () => {
      await result.current.stopRuntime("pty-restored-foreign", "restored-foreign");
    });

    expect((window as any).ade.pty.dispose).toHaveBeenLastCalledWith({
      ptyId: "pty-restored-foreign",
      sessionId: "restored-foreign",
    }, foreignBinding);
  });

  it("keeps an active-binding session stop on the unpinned fast path", async () => {
    const localSession = makeSession("active-local", "lane-1", {
      ptyId: "pty-active-local",
      toolType: "codex",
    });
    fakeAppStoreState = {
      ...fakeAppStoreState,
      projectBinding: {
        kind: "local",
        key: "local:/fake/project",
        rootPath: "/fake/project",
        displayName: "Fake",
      },
    };
    listSessionsCachedMock.mockResolvedValue([localSession]);

    const { result } = renderHook(() => useWorkSessions());
    await waitFor(() => expect(result.current.sessions).toContainEqual(localSession));

    await act(async () => {
      await result.current.stopRuntime("pty-active-local", "active-local");
    });

    expect((window as any).ade.pty.dispose).toHaveBeenLastCalledWith({
      ptyId: "pty-active-local",
      sessionId: "active-local",
    });
  });

  it("stopAllRuntimes stops local and foreign PTYs, pinning only the foreign row", async () => {
    const foreignBinding = {
      kind: "remote",
      key: "remote:target-b:project-b",
      targetId: "target-b",
      runtimeName: "Machine B",
      projectId: "project-b",
      rootPath: "/repo-b",
      displayName: "Repo B",
    } as const;
    const localSession = makeSession("stop-all-local", "lane-1", {
      ptyId: "pty-stop-all-local",
      toolType: "codex",
    });
    const foreignSession = makeSession("stop-all-foreign", "lane-b", {
      ptyId: "pty-stop-all-foreign",
      toolType: "codex",
    });
    fakeAppStoreState = {
      ...fakeAppStoreState,
      projectBinding: {
        kind: "local",
        key: "local:/fake/project",
        rootPath: "/fake/project",
        displayName: "Fake",
      },
      openRemoteProjectTabs: [foreignBinding],
      crossMachineLanesByMachineId: {
        "target-b": {
          binding: foreignBinding,
          lanes: [{ id: "lane-b" }],
          sessions: [foreignSession],
        },
      },
    };
    listSessionsCachedMock.mockResolvedValue([localSession]);

    const { result } = renderHook(() => useWorkSessions());
    await waitFor(() => expect(result.current.runningSessions).toHaveLength(2));

    await act(async () => {
      await result.current.stopAllRuntimes();
    });

    expect((window as any).ade.pty.dispose).toHaveBeenCalledWith({
      ptyId: "pty-stop-all-local",
      sessionId: "stop-all-local",
    });
    expect((window as any).ade.pty.dispose).toHaveBeenCalledWith({
      ptyId: "pty-stop-all-foreign",
      sessionId: "stop-all-foreign",
    }, foreignBinding);
  });

  it("keeps routing and stop callback identities stable across session refreshes", async () => {
    const first = makeSession("identity-stable", "lane-1", {
      ptyId: "pty-identity-stable",
      toolType: "codex",
      lastOutputPreview: "before",
    });
    const refreshed = { ...first, lastOutputPreview: "after" };
    listSessionsCachedMock.mockResolvedValue([first]);

    const { result } = renderHook(() => useWorkSessions());
    await waitFor(() => expect(result.current.sessions).toContainEqual(first));
    const initialResolver = result.current.resolveSessionRuntimePin;
    const initialStopRuntime = result.current.stopRuntime;
    const initialStopAllRuntimes = result.current.stopAllRuntimes;

    listSessionsCachedMock.mockResolvedValue([refreshed]);
    await act(async () => {
      await result.current.refresh({ force: true });
    });
    await waitFor(() => expect(result.current.sessions).toContainEqual(refreshed));

    expect(result.current.resolveSessionRuntimePin).toBe(initialResolver);
    expect(result.current.stopRuntime).toBe(initialStopRuntime);
    expect(result.current.stopAllRuntimes).toBe(initialStopAllRuntimes);
  });

  it("launchPtySession skips Work UI mutations when a pinned launch resolves after project switch", async () => {
    const pin = {
      kind: "local",
      key: "local:/origin/project",
      rootPath: "/origin/project",
      displayName: "Origin",
    } as const;
    fakeAppStoreState = {
      ...fakeAppStoreState,
      projectBinding: {
        kind: "local",
        key: "local:/other/project",
        rootPath: "/other/project",
        displayName: "Other",
      },
    };
    (window as any).ade.pty.create.mockResolvedValueOnce({
      sessionId: "stale-pinned-session",
      ptyId: "stale-pinned-pty",
      pid: 1234,
    });
    listSessionsCachedMock.mockResolvedValue([]);

    const { result } = renderHook(() => useWorkSessions());

    await waitFor(() => {
      expect(listSessionsCachedMock).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(setWorkViewStateSpy).toHaveBeenCalled();
    });
    focusSessionSpy.mockClear();
    selectLaneSpy.mockClear();
    setWorkViewStateSpy.mockClear();
    listSessionsCachedMock.mockClear();

    await act(async () => {
      await expect(result.current.launchPtySession({
        laneId: "lane-1",
        profile: "codex",
        title: "Stale pinned prompt",
        pin,
      })).resolves.toEqual(expect.objectContaining({
        sessionId: "stale-pinned-session",
        ptyId: "stale-pinned-pty",
      }));
    });

    expect((window as any).ade.pty.create).toHaveBeenLastCalledWith(expect.objectContaining({
      laneId: "lane-1",
      title: "Stale pinned prompt",
    }), pin);
    expect(result.current.sessions.find((session) => session.id === "stale-pinned-session")).toBeUndefined();
    expect(selectLaneSpy).not.toHaveBeenCalledWith("lane-1");
    expect(focusSessionSpy).not.toHaveBeenCalledWith("stale-pinned-session");
    expect(setWorkViewStateSpy).not.toHaveBeenCalled();
    expect(listSessionsCachedMock).not.toHaveBeenCalled();
  });

  it("launchPtySession preserves the live optimistic pty id when a stale row has the same session id", async () => {
    const workState = {
      openItemIds: [] as string[],
      activeItemId: null as string | null,
      selectedItemId: null as string | null,
      draftKind: "cli" as const,
      laneFilter: "all",
      search: "",
      sessionListOrganization: "by-lane" as const,
      workCollapsedLaneIds: [] as string[],
      workCollapsedTabGroupIds: [] as string[],
      workFocusSessionsHidden: false,
    };
    fakeAppStoreState = {
      ...fakeAppStoreState,
      workViewByProject: { "/fake/project": workState },
    };
    setWorkViewStateSpy.mockImplementation((_projectRoot: string, next: any) => {
      const resolved = typeof next === "function" ? next(workState) : { ...workState, ...next };
      Object.assign(workState, resolved);
    });
    listSessionsCachedMock.mockResolvedValue([]);
    (window as any).ade.pty.create.mockResolvedValueOnce({
      sessionId: "new-pty-session",
      ptyId: "pty-1",
      pid: 1234,
    });

    const { result } = renderHook(() => useWorkSessions());

    await waitFor(() => {
      expect(listSessionsCachedMock).toHaveBeenCalled();
    });
    listSessionsCachedMock.mockClear();
    listSessionsCachedMock.mockResolvedValueOnce([
      makeSession("new-pty-session", "lane-1", {
        ptyId: null,
        title: "Persisted row before pty id backfill",
        toolType: null,
        runtimeState: null,
      }),
    ]);

    await act(async () => {
      await result.current.launchPtySession({
        laneId: "lane-1",
        profile: "codex",
        title: "Dina prompt",
      });
    });

    expect(result.current.sessions).toEqual([
      expect.objectContaining({
        id: "new-pty-session",
        ptyId: "pty-1",
        title: "Persisted row before pty id backfill",
        toolType: "codex",
        runtimeState: "running",
        status: "running",
      }),
    ]);
    expect(workState.openItemIds).toContain("new-pty-session");
    expect(workState.activeItemId).toBe("new-pty-session");
  });

  it("showDraftKind: clears the active session and re-enters chat draft mode without closing tabs", () => {
    const previousState = {
      openItemIds: ["session-1", "session-2"],
      activeItemId: "session-2",
      selectedItemId: "session-2",
      draftKind: "cli",
      laneFilter: "lane-1",
      search: "alpha",
      sessionListOrganization: "by-time",
      workCollapsedLaneIds: ["lane-1"],
      workCollapsedTabGroupIds: [],
      workFocusSessionsHidden: true,
    };
    let nextState: typeof previousState | null = null;

    setWorkViewStateSpy.mockImplementation(
      (_projectRoot: string, next: ((prev: typeof previousState) => typeof previousState) | Partial<typeof previousState>) => {
        nextState = typeof next === "function" ? next(previousState) : { ...previousState, ...next };
      },
    );

    const { result } = renderHook(() => useWorkSessions());

    act(() => {
      result.current.showDraftKind("chat");
    });

    expect(nextState).toEqual({
      ...previousState,
      activeItemId: null,
      selectedItemId: null,
      draftKind: "chat",
    });
  });

  it("setDraftLaneId remembers the new-session lane per project and selects it globally", () => {
    const { result } = renderHook(() => useWorkSessions());

    act(() => {
      result.current.setDraftLaneId("lane-2");
    });

    expect(setWorkViewStateSpy).toHaveBeenCalledWith("/fake/project", { draftLaneId: "lane-2" });
    expect(selectLaneSpy).toHaveBeenCalledWith("lane-2");
  });

  it("setDraftMachineId remembers the draft owner independently from its lane id", () => {
    const { result } = renderHook(() => useWorkSessions());

    act(() => {
      result.current.setDraftMachineId("studio");
    });

    expect(setWorkViewStateSpy).toHaveBeenCalledWith("/fake/project", {
      draftMachineId: "studio",
    });
  });

  it("setActiveItemId selects the active tab lane in tab mode", async () => {
    const sessionA = makeSession("session-a", "lane-a");
    const sessionB = makeSession("session-b", "lane-b");
    const workState = {
      openItemIds: ["session-a", "session-b"],
      activeItemId: "session-a",
      selectedItemId: "session-a",
      draftKind: "chat" as const,
      laneFilter: "all",
      search: "",
      sessionListOrganization: "by-lane" as const,
      workCollapsedLaneIds: [] as string[],
      workCollapsedTabGroupIds: [] as string[],
      workFocusSessionsHidden: false,
    };
    fakeAppStoreState = {
      ...fakeAppStoreState,
      lanes: [
        { id: "lane-a", name: "Lane A" },
        { id: "lane-b", name: "Lane B" },
      ],
      workViewByProject: { "/fake/project": workState },
    };
    listSessionsCachedMock.mockResolvedValue([sessionA, sessionB]);

    const { result } = renderHook(() => useWorkSessions());

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(2);
    });

    selectLaneSpy.mockClear();
    act(() => {
      result.current.setActiveItemId("session-b");
    });

    expect(selectLaneSpy).toHaveBeenCalledWith("lane-b");
  });

  it("syncs a restored active Work tab lane after sessions load", async () => {
    const sessionA = makeSession("session-a", "lane-a");
    const workState = {
      openItemIds: ["session-a"],
      activeItemId: "session-a",
      selectedItemId: "session-a",
      draftKind: "chat" as const,
      laneFilter: "all",
      search: "",
      sessionListOrganization: "by-lane" as const,
      workCollapsedLaneIds: [] as string[],
      workCollapsedTabGroupIds: [] as string[],
      workFocusSessionsHidden: false,
    };
    fakeAppStoreState = {
      ...fakeAppStoreState,
      lanes: [{ id: "lane-a", name: "Lane A" }],
      workViewByProject: { "/fake/project": workState },
    };
    listSessionsCachedMock.mockResolvedValue([sessionA]);

    const { result } = renderHook(() => useWorkSessions());

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
      expect(selectLaneSpy).toHaveBeenCalledWith("lane-a");
    });
  });

  it("re-enters the Work route without forcing a blocking session-list refresh after the first load", async () => {
    const session = makeSession("session-a", "lane-a");
    listSessionsCachedMock.mockResolvedValue([session]);

    const { rerender, result } = renderHook(
      ({ active }: { active: boolean }) => useWorkSessions({ active }),
      { initialProps: { active: true } },
    );

    await waitFor(() => {
      expect(result.current.sessions).toHaveLength(1);
    });

    listSessionsCachedMock.mockClear();
    rerender({ active: false });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    rerender({ active: true });

    await waitFor(() => {
      expect(listSessionsCachedMock).toHaveBeenCalled();
    });
    expect(listSessionsCachedMock).toHaveBeenLastCalledWith({ limit: 500 }, undefined);
  });

  it("preserves saved Work filters when a URL targets a specific session", async () => {
    const session = {
      id: "session-1",
      laneId: "lane-1",
      laneName: "Lane 1",
      ptyId: null,
      tracked: true,
      pinned: false,
      goal: null,
      toolType: "claude-chat" as const,
      title: "Claude Chat",
      status: "running" as const,
      startedAt: "2026-04-01T12:00:00.000Z",
      endedAt: null,
      exitCode: null,
      transcriptPath: "",
      headShaStart: null,
      headShaEnd: null,
      lastOutputPreview: null,
      summary: null,
      runtimeState: "idle" as const,
      resumeCommand: null,
    };
    listSessionsCachedMock.mockResolvedValue([session]);
    useSearchParamsMock.mockReturnValue([
      new URLSearchParams("laneId=lane-1&status=running&sessionId=session-1"),
      vi.fn(),
    ]);

    const workState = {
      openItemIds: [] as string[],
      activeItemId: null as string | null,
      selectedItemId: null as string | null,
      draftKind: "chat" as const,
      laneFilter: "lane-2",
      search: "",
      sessionListOrganization: "by-lane" as const,
      workCollapsedLaneIds: [] as string[],
      workCollapsedTabGroupIds: [] as string[],
      workFocusSessionsHidden: false,
    };
    fakeAppStoreState = {
      ...fakeAppStoreState,
      lanes: [
        { id: "lane-1", name: "Lane 1" },
        { id: "lane-2", name: "Lane 2" },
      ],
      workViewByProject: {
        "/fake/project": workState,
      },
    };
    setWorkViewStateSpy.mockImplementation((_projectRoot: string, next: any) => {
      const resolved = typeof next === "function" ? next(workState) : { ...workState, ...next };
      Object.assign(workState, resolved);
    });

    renderHook(() => useWorkSessions());

    await waitFor(() => {
      expect(focusSessionSpy).toHaveBeenCalledWith("session-1");
    });

    expect(selectLaneSpy).toHaveBeenCalledWith("lane-1");
    expect(workState.laneFilter).toBe("lane-2");
    expect(workState.openItemIds).toContain("session-1");
    expect(workState.activeItemId).toBe("session-1");
    expect(workState.selectedItemId).toBe("session-1");
  });

  it("falls back to URL lane/status filters when the requested sessionId is stale", async () => {
    // Only session-2 exists in the list — the URL's sessionId=missing-session
    // is stale (e.g. deleted). The laneId/status hints must still apply so
    // the user lands in the right filter context instead of nowhere.
    const session = {
      id: "session-2",
      laneId: "lane-1",
      laneName: "Lane 1",
      ptyId: null,
      tracked: true,
      pinned: false,
      goal: null,
      toolType: "claude-chat" as const,
      title: "Claude Chat",
      status: "running" as const,
      startedAt: "2026-04-01T12:00:00.000Z",
      endedAt: null,
      exitCode: null,
      transcriptPath: "",
      headShaStart: null,
      headShaEnd: null,
      lastOutputPreview: null,
      summary: null,
      runtimeState: "idle" as const,
      resumeCommand: null,
    };
    listSessionsCachedMock.mockResolvedValue([session]);
    useSearchParamsMock.mockReturnValue([
      new URLSearchParams("laneId=lane-1&status=running&sessionId=missing-session"),
      vi.fn(),
    ]);

    const workState = {
      openItemIds: [] as string[],
      activeItemId: null as string | null,
      selectedItemId: null as string | null,
      draftKind: "chat" as const,
      laneFilter: "all",
      search: "",
      sessionListOrganization: "by-lane" as const,
      workCollapsedLaneIds: [] as string[],
      workCollapsedTabGroupIds: [] as string[],
      workCollapsedSectionIds: ["status:running", "status:settled"],
      workFocusSessionsHidden: false,
    };
    fakeAppStoreState = {
      ...fakeAppStoreState,
      lanes: [
        { id: "lane-1", name: "Lane 1" },
        { id: "lane-2", name: "Lane 2" },
      ],
      workViewByProject: {
        "/fake/project": workState,
      },
    };
    setWorkViewStateSpy.mockImplementation((_projectRoot: string, next: any) => {
      const resolved = typeof next === "function" ? next(workState) : { ...workState, ...next };
      Object.assign(workState, resolved);
    });

    const { result } = renderHook(() => useWorkSessions());

    // The deeplink retargets the *view*, transiently. It must not be written to
    // the persisted project state, which now survives tab switches.
    await waitFor(() => {
      expect(result.current.filterLaneId).toBe("lane-1");
      expect(result.current.sessionListOrganization).toBe("all-lanes-by-status");
    });
    expect(workState.laneFilter).toBe("all");
    expect(workState.sessionListOrganization).toBe("by-lane");
    // The requested section reads as expanded, but the user's saved collapse set
    // is untouched, so it re-collapses once this navigation is over.
    expect(result.current.workCollapsedSectionIds).not.toContain("status:running");
    expect(workState.workCollapsedSectionIds).toEqual(["status:running", "status:settled"]);

    // The stale session never existed, so focusSession must not fire for it.
    expect(focusSessionSpy).not.toHaveBeenCalledWith("missing-session");
    expect(navigateSpy).toHaveBeenCalledWith("/work", { replace: true });
  });

  it("does not replay a previous project's URL session during project switch", async () => {
    const sessionA = makeSession("session-a", "lane-a");
    const sessionB = makeSession("session-b", "lane-b");
    listSessionsCachedMock
      .mockResolvedValueOnce([sessionA])
      .mockResolvedValue([sessionB]);

    let currentSearchParams = new URLSearchParams("sessionId=session-a");
    useSearchParamsMock.mockImplementation(() => [currentSearchParams, vi.fn()]);

    const projectBWorkState = {
      openItemIds: [] as string[],
      activeItemId: null as string | null,
      selectedItemId: null as string | null,
      viewMode: "tabs" as const,
      draftKind: "chat" as const,
      laneFilter: "all",
      search: "",
      sessionListOrganization: "by-lane" as const,
      workCollapsedLaneIds: [] as string[],
      workCollapsedTabGroupIds: [] as string[],
      workFocusSessionsHidden: false,
    };
    fakeAppStoreState = {
      ...fakeAppStoreState,
      project: { rootPath: "/project/a" },
      lanes: [{ id: "lane-a", name: "Lane A" }],
    };
    setWorkViewStateSpy.mockImplementation((projectRoot: string, next: any) => {
      if (projectRoot !== "/project/b") return;
      const resolved = typeof next === "function"
        ? next(projectBWorkState)
        : { ...projectBWorkState, ...next };
      Object.assign(projectBWorkState, resolved);
    });

    const { rerender } = renderHook(() => useWorkSessions());

    await waitFor(() => {
      expect(focusSessionSpy).toHaveBeenCalledWith("session-a");
    });

    focusSessionSpy.mockClear();
    selectLaneSpy.mockClear();
    setWorkViewStateSpy.mockClear();
    navigateSpy.mockClear();

    fakeAppStoreState = {
      ...fakeAppStoreState,
      project: { rootPath: "/project/b" },
      lanes: [{ id: "lane-b", name: "Lane B" }],
      workViewByProject: {
        "/project/b": projectBWorkState,
      },
      sessionsCacheByProject: {},
    };
    currentSearchParams = new URLSearchParams("sessionId=session-a");

    act(() => {
      rerender();
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(focusSessionSpy).not.toHaveBeenCalledWith("session-a");
    expect(selectLaneSpy).not.toHaveBeenCalledWith("lane-a");
    expect(projectBWorkState.openItemIds).not.toContain("session-a");
  });

  it("does not reapply the same URL filters after the Work route is parked on another ADE tab", async () => {
    const session = {
      id: "session-2",
      laneId: "lane-1",
      laneName: "Lane 1",
      ptyId: null,
      tracked: true,
      pinned: false,
      goal: null,
      toolType: "claude-chat" as const,
      title: "Claude Chat",
      status: "running" as const,
      startedAt: "2026-04-01T12:00:00.000Z",
      endedAt: null,
      exitCode: null,
      transcriptPath: "",
      headShaStart: null,
      headShaEnd: null,
      lastOutputPreview: null,
      summary: null,
      runtimeState: "idle" as const,
      resumeCommand: null,
    };
    const deepLinkParams = new URLSearchParams("laneId=lane-1&status=running&sessionId=missing-session");
    let currentSearchParams = deepLinkParams;
    useSearchParamsMock.mockImplementation(() => [currentSearchParams, vi.fn()]);
    listSessionsCachedMock.mockResolvedValue([session]);

    const workState = {
      openItemIds: [] as string[],
      activeItemId: null as string | null,
      selectedItemId: null as string | null,
      draftKind: "chat" as const,
      laneFilter: "all",
      search: "",
      sessionListOrganization: "by-lane" as const,
      workCollapsedLaneIds: [] as string[],
      workCollapsedTabGroupIds: [] as string[],
      workFocusSessionsHidden: false,
    };
    fakeAppStoreState = {
      ...fakeAppStoreState,
      lanes: [{ id: "lane-1", name: "Lane 1" }],
      workViewByProject: {
        "/fake/project": workState,
      },
    };
    setWorkViewStateSpy.mockImplementation((_projectRoot: string, next: any) => {
      const resolved = typeof next === "function" ? next(workState) : { ...workState, ...next };
      Object.assign(workState, resolved);
    });

    const { result, rerender } = renderHook(() => useWorkSessions());

    await waitFor(() => {
      expect(result.current.filterLaneId).toBe("lane-1");
      expect(result.current.sessionListOrganization).toBe("all-lanes-by-status");
    });

    (workState as { sessionListOrganization: string }).sessionListOrganization = "by-time";
    routerLocation.pathname = "/files";
    currentSearchParams = new URLSearchParams("tab=preview");
    act(() => {
      rerender();
    });

    routerLocation.pathname = "/work";
    currentSearchParams = deepLinkParams;
    act(() => {
      rerender();
    });

    // Back on Work with the same params: the deeplink does not re-fire, and the
    // user's own view state is what shows.
    expect(result.current.filterLaneId).toBe("all");
    expect(result.current.sessionListOrganization).toBe("by-time");
    expect(workState.laneFilter).toBe("all");
  });

  it("does not keep reapplying a partially applied URL status while lanes are loading", async () => {
    const session = {
      id: "session-2",
      laneId: "lane-1",
      laneName: "Lane 1",
      ptyId: null,
      tracked: true,
      pinned: false,
      goal: null,
      toolType: "claude-chat" as const,
      title: "Claude Chat",
      status: "running" as const,
      startedAt: "2026-04-01T12:00:00.000Z",
      endedAt: null,
      exitCode: null,
      transcriptPath: "",
      headShaStart: null,
      headShaEnd: null,
      lastOutputPreview: null,
      summary: null,
      runtimeState: "idle" as const,
      resumeCommand: null,
    };
    listSessionsCachedMock.mockResolvedValue([session]);
    useSearchParamsMock.mockReturnValue([
      new URLSearchParams("laneId=lane-1&status=running&sessionId=missing-session"),
      vi.fn(),
    ]);

    const workState = {
      openItemIds: [] as string[],
      activeItemId: null as string | null,
      selectedItemId: null as string | null,
      draftKind: "chat" as const,
      laneFilter: "all",
      search: "",
      sessionListOrganization: "by-lane" as const,
      workCollapsedLaneIds: [] as string[],
      workCollapsedTabGroupIds: [] as string[],
      workFocusSessionsHidden: false,
    };
    fakeAppStoreState = {
      ...fakeAppStoreState,
      lanes: [],
      workViewByProject: {
        "/fake/project": workState,
      },
    };
    setWorkViewStateSpy.mockImplementation((_projectRoot: string, next: any) => {
      const resolved = typeof next === "function" ? next(workState) : { ...workState, ...next };
      Object.assign(workState, resolved);
    });

    const { result, rerender } = renderHook(() => useWorkSessions());

    await waitFor(() => {
      expect(result.current.sessionListOrganization).toBe("all-lanes-by-status");
    });
    expect(result.current.filterLaneId).toBe("all");

    // The user picks their own grouping, which drops the deeplink's framing.
    act(() => {
      result.current.setSessionListOrganization("by-time");
    });
    listSessionsCachedMock.mockResolvedValue([{ ...session, id: "session-3" }]);

    await act(async () => {
      await result.current.refresh({ force: true });
    });

    expect(result.current.sessionListOrganization).toBe("by-time");
    expect(result.current.filterLaneId).toBe("all");

    fakeAppStoreState = {
      ...fakeAppStoreState,
      lanes: [{ id: "lane-1", name: "Lane 1" }],
    };

    act(() => {
      rerender();
    });

    // Lanes arriving completes the lane half of the deeplink without re-applying
    // the status half over the grouping the user just chose.
    await waitFor(() => {
      expect(result.current.filterLaneId).toBe("lane-1");
    });
    expect(result.current.sessionListOrganization).toBe("by-time");
  });

  it("keeps every status visible without an implicit status filter", async () => {
    const runningSession = {
      id: "session-running",
      laneId: "lane-1",
      laneName: "Lane 1",
      ptyId: null,
      tracked: true,
      pinned: false,
      goal: null,
      toolType: "shell" as const,
      title: "Running shell",
      status: "running" as const,
      startedAt: "2026-04-01T12:00:00.000Z",
      endedAt: null,
      exitCode: null,
      transcriptPath: "",
      headShaStart: null,
      headShaEnd: null,
      lastOutputPreview: null,
      summary: null,
      runtimeState: "running" as const,
      resumeCommand: null,
    };
    const endedSession = {
      ...runningSession,
      id: "session-ended",
      title: "Ended shell",
      status: "completed" as const,
      runtimeState: "exited" as const,
      endedAt: "2026-04-01T12:30:00.000Z",
      exitCode: 0,
    };
    listSessionsCachedMock.mockResolvedValue([runningSession, endedSession]);
    fakeAppStoreState = {
      ...fakeAppStoreState,
      workViewByProject: {
        "/fake/project": {
          openItemIds: [],
          activeItemId: null,
          selectedItemId: null,
          draftKind: "chat",
          laneFilter: "all",
          search: "",
          sessionListOrganization: "by-lane",
          workCollapsedLaneIds: [],
          workCollapsedTabGroupIds: [],
          workFocusSessionsHidden: false,
        },
      },
    };

    const { result } = renderHook(() => useWorkSessions());

    await waitFor(() => {
      expect(result.current.filtered.map((session) => session.id)).toEqual(["session-running", "session-ended"]);
    });
    expect(result.current.runningFiltered.map((s) => s.id)).toEqual(["session-running"]);
    expect(result.current.endedFiltered.map((s) => s.id)).toEqual(["session-ended"]);
    expect(result.current.settledFiltered.map((s) => s.id)).toEqual([]);
  });

  it("partitions snoozed rows out of the flat sidebar buckets and back once the snooze lapses", async () => {
    const nowMs = Date.now();
    const iso = (offsetMs: number) => new Date(nowMs + offsetMs).toISOString();
    // Snoozed while it is still running: snooze is a visibility overlay, so it
    // outranks the Running bucket rather than deferring to it.
    const snoozedRunning = makeSession("session-snoozed-running", "lane-1", {
      snoozedUntil: iso(2 * 3600_000),
      snoozedAt: iso(-60_000),
    });
    const snoozedRunningSoon = makeSession("session-snoozed-soon", "lane-1", {
      snoozedUntil: iso(30 * 60_000),
      snoozedAt: iso(-60_000),
    });
    // Expiry is DERIVED from `snoozedUntil` — a lapsed snooze is not snoozed.
    const lapsedSnooze = makeSession("session-lapsed", "lane-1", {
      snoozedUntil: iso(-60_000),
      snoozedAt: iso(-3600_000),
    });
    const plainRunning = makeSession("session-running", "lane-1");
    listSessionsCachedMock.mockResolvedValue([
      snoozedRunning,
      snoozedRunningSoon,
      lapsedSnooze,
      plainRunning,
    ]);

    const { result } = renderHook(() => useWorkSessions());

    await waitFor(() => {
      expect(result.current.filtered).toHaveLength(4);
    });

    // Soonest wake first.
    expect(result.current.snoozedFiltered.map((s) => s.id)).toEqual([
      "session-snoozed-soon",
      "session-snoozed-running",
    ]);
    expect(result.current.runningFiltered.map((s) => s.id)).toEqual([
      "session-lapsed",
      "session-running",
    ]);
    expect(result.current.awaitingInputFiltered.map((s) => s.id)).toEqual([]);
    expect(result.current.endedFiltered.map((s) => s.id)).toEqual([]);
    expect(result.current.settledFiltered.map((s) => s.id)).toEqual([]);
  });

  // Regression: "Until I'm asked" snooze hid an explicitly raised hand.
  it("does NOT file a snoozed needs-you row as snoozed in the flat sidebar buckets", async () => {
    const nowMs = Date.now();
    const iso = (offsetMs: number) => new Date(nowMs + offsetMs).toISOString();
    // A tracked CLI row blocked at a prompt, snoozed "until I'm asked" (~100y).
    const snoozedCliNeedsYou = makeSession("session-cli-needs-you", "lane-1", {
      toolType: "claude" as const,
      runtimeState: "waiting-input" as const,
      attentionRequestedAt: iso(-1_000),
      snoozedUntil: iso(100 * 365 * 24 * 3600_000),
      snoozedAt: iso(-60_000),
    });
    // A chat row escalated via `ade chat ask` while snoozed.
    const snoozedChatAsk = makeSession("session-chat-ask", "lane-1", {
      toolType: "claude-chat" as const,
      attentionRequestedAt: iso(-1_000),
      snoozedUntil: iso(2 * 3600_000),
      snoozedAt: iso(-60_000),
    });
    const snoozedQuiet = makeSession("session-snoozed-quiet", "lane-1", {
      snoozedUntil: iso(3600_000),
      snoozedAt: iso(-60_000),
    });
    listSessionsCachedMock.mockResolvedValue([snoozedCliNeedsYou, snoozedChatAsk, snoozedQuiet]);

    const { result } = renderHook(() => useWorkSessions());

    await waitFor(() => {
      expect(result.current.filtered).toHaveLength(3);
    });

    // Only the calm row is hidden; both hand-raises stay in "Your move", loud
    // rows first, so the user can actually see and unblock them.
    expect(result.current.snoozedFiltered.map((s) => s.id)).toEqual(["session-snoozed-quiet"]);
    expect(result.current.awaitingInputFiltered.map((s) => s.id)).toEqual([
      "session-cli-needs-you",
      "session-chat-ask",
    ]);
    expect(result.current.runningFiltered.map((s) => s.id)).toEqual([]);
  });

  it("includes Claude session tags in the Work sidebar search", async () => {
    const taggedSession = makeSession("session-tagged", "lane-1", {
      title: "Unrelated title",
      claudeTag: "customer-ready",
    });
    const untaggedSession = makeSession("session-untagged", "lane-1", {
      title: "Another title",
    });
    listSessionsCachedMock.mockResolvedValue([taggedSession, untaggedSession]);
    fakeAppStoreState = {
      ...fakeAppStoreState,
      workViewByProject: {
        "/fake/project": {
          openItemIds: [],
          activeItemId: null,
          selectedItemId: null,
          draftKind: "chat",
          laneFilter: "all",
          search: "customer-ready",
          sessionListOrganization: "by-lane",
          workCollapsedLaneIds: [],
          workCollapsedTabGroupIds: [],
          workFocusSessionsHidden: false,
        },
      },
    };

    const { result } = renderHook(() => useWorkSessions());

    await waitFor(() => {
      expect(result.current.filtered.map((session) => session.id)).toEqual(["session-tagged"]);
    });
  });

  it("reapplies the same stale-session URL filters after navigating to a valid session and back", async () => {
    const session = {
      id: "session-2",
      laneId: "lane-1",
      laneName: "Lane 1",
      ptyId: null,
      tracked: true,
      pinned: false,
      goal: null,
      toolType: "claude-chat" as const,
      title: "Claude Chat",
      status: "running" as const,
      startedAt: "2026-04-01T12:00:00.000Z",
      endedAt: null,
      exitCode: null,
      transcriptPath: "",
      headShaStart: null,
      headShaEnd: null,
      lastOutputPreview: null,
      summary: null,
      runtimeState: "idle" as const,
      resumeCommand: null,
    };
    listSessionsCachedMock.mockResolvedValue([session]);

    const deepLinkParams = new URLSearchParams("laneId=lane-1&status=running&sessionId=missing-session");
    let currentSearchParams = deepLinkParams;
    useSearchParamsMock.mockImplementation(() => [currentSearchParams, vi.fn()]);

    const workState = {
      openItemIds: [] as string[],
      activeItemId: null as string | null,
      selectedItemId: null as string | null,
      draftKind: "chat" as const,
      laneFilter: "all",
      search: "",
      sessionListOrganization: "by-lane" as const,
      workCollapsedLaneIds: [] as string[],
      workCollapsedTabGroupIds: [] as string[],
      workFocusSessionsHidden: false,
    };
    fakeAppStoreState = {
      ...fakeAppStoreState,
      lanes: [{ id: "lane-1", name: "Lane 1" }],
      workViewByProject: {
        "/fake/project": workState,
      },
    };
    setWorkViewStateSpy.mockImplementation((_projectRoot: string, next: any) => {
      const resolved = typeof next === "function" ? next(workState) : { ...workState, ...next };
      Object.assign(workState, resolved);
    });

    const { result, rerender } = renderHook(() => useWorkSessions());

    await waitFor(() => {
      expect(result.current.filterLaneId).toBe("lane-1");
      expect(result.current.sessionListOrganization).toBe("all-lanes-by-status");
    });

    currentSearchParams = new URLSearchParams("sessionId=session-2");
    act(() => {
      rerender();
    });

    act(() => {
      result.current.setSessionListOrganization("by-time");
    });
    currentSearchParams = deepLinkParams;
    act(() => {
      rerender();
    });

    await waitFor(() => {
      expect(result.current.filterLaneId).toBe("lane-1");
      expect(result.current.sessionListOrganization).toBe("all-lanes-by-status");
    });
    // Still transient — the user's saved grouping is untouched underneath.
    expect(workState.sessionListOrganization).toBe("by-time");
  });

  it("refreshes against the newly active project before pruning that project's saved tabs", async () => {
    const sessionA = {
      id: "session-a",
      laneId: "lane-1",
      laneName: "Lane 1",
      ptyId: null,
      tracked: true,
      pinned: false,
      goal: null,
      toolType: "shell" as const,
      title: "Session A",
      status: "running" as const,
      startedAt: "2026-04-01T12:00:00.000Z",
      endedAt: null,
      exitCode: null,
      transcriptPath: "",
      headShaStart: null,
      headShaEnd: null,
      lastOutputPreview: null,
      summary: null,
      runtimeState: "running" as const,
      resumeCommand: null,
    };
    const sessionB = {
      ...sessionA,
      id: "session-b",
      title: "Session B",
    };
    const persistedProjectBState = {
      openItemIds: ["session-b"],
      activeItemId: "session-b",
      selectedItemId: "session-b",
      draftKind: "chat" as const,
      laneFilter: "all",
      search: "",
      sessionListOrganization: "by-lane" as const,
      workCollapsedLaneIds: [],
      workCollapsedTabGroupIds: [],
      workFocusSessionsHidden: false,
    };

    listSessionsCachedMock
      .mockResolvedValueOnce([sessionA])
      .mockResolvedValueOnce([sessionB]);

    const { result, rerender } = renderHook(() => useWorkSessions());

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(result.current.sessions.map((session) => session.id)).toEqual(["session-a"]);

    fakeAppStoreState = {
      ...fakeAppStoreState,
      project: { rootPath: "/project/b" },
      workViewByProject: {
        "/project/b": persistedProjectBState,
      },
    };

    act(() => {
      rerender();
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(result.current.sessions.map((session) => session.id)).toEqual(["session-b"]);
    expect(listSessionsCachedMock).toHaveBeenCalledTimes(2);

    const projectBStates = setWorkViewStateSpy.mock.calls
      .filter(([projectRoot]) => projectRoot === "/project/b")
      .map(([, next]) => (
        typeof next === "function"
          ? next(persistedProjectBState)
          : { ...persistedProjectBState, ...next }
      ));

    expect(projectBStates).not.toContainEqual(
      expect.objectContaining({ openItemIds: [] }),
    );
  });

  it("does not prune warm-cached project tabs using the previous project's session list", async () => {
    const sessionA = {
      id: "session-a",
      laneId: "lane-1",
      laneName: "Lane 1",
      ptyId: null,
      tracked: true,
      pinned: false,
      goal: null,
      toolType: "shell" as const,
      title: "Session A",
      status: "running" as const,
      startedAt: "2026-04-01T12:00:00.000Z",
      endedAt: null,
      exitCode: null,
      transcriptPath: "",
      headShaStart: null,
      headShaEnd: null,
      lastOutputPreview: null,
      summary: null,
      runtimeState: "running" as const,
      resumeCommand: null,
    };
    const sessionB = {
      ...sessionA,
      id: "session-b",
      title: "Session B",
    };
    const persistedProjectBState = {
      openItemIds: ["session-b"],
      activeItemId: "session-b",
      selectedItemId: "session-b",
      draftKind: "chat" as const,
      laneFilter: "all",
      search: "",
      sessionListOrganization: "by-lane" as const,
      workCollapsedLaneIds: [],
      workCollapsedTabGroupIds: [],
      workFocusSessionsHidden: false,
    };

    listSessionsCachedMock
      .mockResolvedValueOnce([sessionA])
      .mockResolvedValueOnce([sessionB]);

    const { result, rerender } = renderHook(() => useWorkSessions());

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(result.current.sessions.map((session) => session.id)).toEqual(["session-a"]);

    fakeAppStoreState = {
      ...fakeAppStoreState,
      project: { rootPath: "/project/b" },
      sessionsCacheByProject: {
        "/project/b": [sessionB],
      },
      workViewByProject: {
        "/project/b": persistedProjectBState,
      },
    };

    act(() => {
      rerender();
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(result.current.sessions.map((session) => session.id)).toEqual(["session-b"]);

    const projectBStates = setWorkViewStateSpy.mock.calls
      .filter(([projectRoot]) => projectRoot === "/project/b")
      .map(([, next]) => (
        typeof next === "function"
          ? next(persistedProjectBState)
          : { ...persistedProjectBState, ...next }
      ));

    expect(projectBStates).not.toContainEqual(
      expect.objectContaining({ openItemIds: [] }),
    );
    expect((fakeAppStoreState.sessionsCacheByProject as Record<string, unknown>)["/project/b"]).toEqual([sessionB]);
  });

  it("refetches after a session metadata update arrives", async () => {
    let onChangedHandler: (() => void) | null = null;
    (window as any).ade.sessions.onChanged.mockImplementation((cb: () => void) => {
      onChangedHandler = cb;
      return () => {
        onChangedHandler = null;
      };
    });

    const session = {
      id: "session-1",
      laneId: "lane-1",
      laneName: "Lane 1",
      ptyId: null,
      tracked: true,
      pinned: false,
      goal: null,
      toolType: "claude-chat" as const,
      title: "Claude Chat",
      status: "completed" as const,
      startedAt: "2026-04-01T12:00:00.000Z",
      endedAt: "2026-04-01T12:10:00.000Z",
      exitCode: 0,
      transcriptPath: "",
      headShaStart: null,
      headShaEnd: null,
      lastOutputPreview: null,
      summary: null,
      runtimeState: "exited" as const,
      resumeCommand: null,
    };

    listSessionsCachedMock.mockResolvedValue([session]);

    renderHook(() => useWorkSessions());

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    listSessionsCachedMock.mockClear();
    expect(onChangedHandler).toBeTypeOf("function");

    await act(async () => {
      onChangedHandler?.();
      await new Promise((r) => setTimeout(r, 120));
    });

    expect(listSessionsCachedMock).toHaveBeenCalledWith({ limit: 500 }, undefined);
    expect(invalidateSessionListCache).toHaveBeenCalled();
  });

  it("defers hidden session-list changes and refreshes Work on reveal", async () => {
    let onChangedHandler: (() => void) | null = null;
    (window as any).ade.sessions.onChanged.mockImplementation((cb: () => void) => {
      onChangedHandler = cb;
      return () => {
        onChangedHandler = null;
      };
    });

    renderHook(() => useWorkSessions());

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    listSessionsCachedMock.mockClear();
    vi.mocked(invalidateSessionListCache).mockClear();
    listSessionsCachedMock.mockResolvedValue([makeSession("session-revealed", "lane-1")]);

    setDocumentVisibility("hidden");
    await act(async () => {
      onChangedHandler?.();
      await new Promise((r) => setTimeout(r, 120));
    });

    expect(invalidateSessionListCache).toHaveBeenCalled();
    expect(listSessionsCachedMock).not.toHaveBeenCalled();

    setDocumentVisibility("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await new Promise((r) => setTimeout(r, 60));
    });

    expect(listSessionsCachedMock).toHaveBeenCalledWith({ limit: 500 }, undefined);
  });

  it("refetches visible Work when the window regains focus", async () => {
    renderHook(() => useWorkSessions());

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    listSessionsCachedMock.mockClear();
    vi.mocked(invalidateSessionListCache).mockClear();

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await new Promise((r) => setTimeout(r, 140));
    });

    expect(invalidateSessionListCache).toHaveBeenCalled();
    expect(listSessionsCachedMock).toHaveBeenCalledWith({ limit: 500 }, undefined);
  });

  it("does not refetch remote Work on focus without hidden changes", async () => {
    fakeAppStoreState.projectBinding = {
      kind: "remote",
      key: "remote:target:project",
      targetId: "target",
      runtimeName: "Mac Studio",
      projectId: "project",
      rootPath: "/Users/admin/Projects/perf pass",
      displayName: "perf pass",
    };

    renderHook(() => useWorkSessions());

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    listSessionsCachedMock.mockClear();
    vi.mocked(invalidateSessionListCache).mockClear();

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await new Promise((r) => setTimeout(r, 140));
    });

    expect(invalidateSessionListCache).not.toHaveBeenCalled();
    expect(listSessionsCachedMock).not.toHaveBeenCalled();
  });

  it("does not subscribe or refresh while the kept-alive Work surface is inactive", async () => {
    const windowAddEventListenerSpy = vi.spyOn(window, "addEventListener");
    const documentAddEventListenerSpy = vi.spyOn(document, "addEventListener");

    renderHook(() => useWorkSessions({ active: false }));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(listSessionsCachedMock).not.toHaveBeenCalled();
    expect((window as any).ade.pty.onExit).not.toHaveBeenCalled();
    expect((window as any).ade.agentChat.onEvent).not.toHaveBeenCalled();
    expect((window as any).ade.sessions.onChanged).not.toHaveBeenCalled();
    expect(windowAddEventListenerSpy).not.toHaveBeenCalledWith("focus", expect.any(Function));
    expect(documentAddEventListenerSpy).not.toHaveBeenCalledWith("visibilitychange", expect.any(Function));

    windowAddEventListenerSpy.mockRestore();
    documentAddEventListenerSpy.mockRestore();
  });

  it("invalidates the session cache before refetching for chat activity", async () => {
    let chatEventHandler: ((payload: unknown) => void) | null = null;
    (window as any).ade.agentChat.onEvent.mockImplementation((cb: (payload: unknown) => void) => {
      chatEventHandler = cb;
      return () => {
        chatEventHandler = null;
      };
    });
    vi.mocked(shouldRefreshSessionListForChatEvent).mockReturnValue(true);

    renderHook(() => useWorkSessions());

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    listSessionsCachedMock.mockClear();
    vi.mocked(invalidateSessionListCache).mockClear();

    await act(async () => {
      chatEventHandler?.({ event: { type: "done" } });
      await new Promise((r) => setTimeout(r, 240));
    });

    expect(invalidateSessionListCache).toHaveBeenCalled();
    expect(listSessionsCachedMock).toHaveBeenCalledWith({ limit: 500 }, undefined);
  });

  it("shows an announced headless chat before session-list propagation completes", async () => {
    const { result } = renderHook(() => useWorkSessions());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    vi.mocked(invalidateSessionListCache).mockClear();

    act(() => {
      for (const listener of workChatSessionCreatedListeners) {
        listener({
          projectRoot: "/fake/project",
          session: {
            id: "new-chat",
            laneId: "lane-1",
            provider: "codex",
            model: "gpt-5.4",
            status: "idle",
            createdAt: "2026-07-10T12:00:00.000Z",
            lastActivityAt: "2026-07-10T12:00:00.000Z",
          },
        });
      }
    });

    expect(result.current.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "new-chat", laneId: "lane-1" }),
    ]));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 140));
    });
    expect(result.current.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "new-chat", laneId: "lane-1" }),
    ]));
  });

  it("does not leak unhandled rejections when a background session refresh fails", async () => {
    let onChangedHandler: (() => void) | null = null;
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);
    (window as any).ade.sessions.onChanged.mockImplementation((cb: () => void) => {
      onChangedHandler = cb;
      return () => {
        onChangedHandler = null;
      };
    });

    try {
      renderHook(() => useWorkSessions());

      await act(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });

      listSessionsCachedMock.mockClear();
      listSessionsCachedMock.mockRejectedValueOnce(new Error("Remote ADE service connection closed."));

      await act(async () => {
        onChangedHandler?.();
        await new Promise((r) => setTimeout(r, 520));
      });

      expect(invalidateSessionListCache).toHaveBeenCalled();
      expect(listSessionsCachedMock).toHaveBeenCalledWith({ limit: 500 }, undefined);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("unhandledrejection", unhandled);
    }
  });
});

describe("useWorkSessions — grouping defaults and derived tab order", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFakeAppStoreState();
    installWindowAde();
    listSessionsCachedMock.mockResolvedValue([]);
  });

  afterEach(() => {
    delete (window as any).ade;
  });

  it("defaults the work grouping to by-lane when no persisted work state exists", async () => {
    listSessionsCachedMock.mockResolvedValue([]);
    const { result } = renderHook(() => useWorkSessions());

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(result.current.sessionListOrganization).toBe("by-lane");
  });

  it("groups tabs in the same order as the selected sidebar organization", () => {
    const now = Date.now();
    const isoDaysAgo = (days: number, hours = 0) => new Date(now - (days * 86400000) - (hours * 3600000)).toISOString();

    const sessions = [
      {
        id: "session-a1",
        laneId: "lane-a",
        laneName: "Lane A",
        ptyId: null,
        tracked: true,
        pinned: false,
        goal: null,
        toolType: "claude-chat" as const,
        title: "Alpha",
        status: "running" as const,
        startedAt: isoDaysAgo(0),
        endedAt: null,
        exitCode: null,
        transcriptPath: "",
        headShaStart: null,
        headShaEnd: null,
        lastOutputPreview: null,
        summary: null,
        runtimeState: "running" as const,
        resumeCommand: null,
      },
      {
        id: "session-a2",
        laneId: "lane-a",
        laneName: "Lane A",
        ptyId: null,
        tracked: true,
        pinned: false,
        goal: null,
        toolType: "claude-chat" as const,
        title: "Bravo",
        status: "running" as const,
        startedAt: isoDaysAgo(1),
        endedAt: null,
        exitCode: null,
        transcriptPath: "",
        headShaStart: null,
        headShaEnd: null,
        lastOutputPreview: null,
        summary: null,
        runtimeState: "waiting-input" as const,
        resumeCommand: null,
      },
      {
        id: "session-b1",
        laneId: "lane-b",
        laneName: "Lane B",
        ptyId: null,
        tracked: true,
        pinned: false,
        goal: null,
        toolType: "shell" as const,
        title: "Charlie",
        status: "running" as const,
        startedAt: isoDaysAgo(2),
        endedAt: null,
        exitCode: null,
        transcriptPath: "",
        headShaStart: null,
        headShaEnd: null,
        lastOutputPreview: null,
        summary: null,
        runtimeState: "running" as const,
        resumeCommand: null,
      },
      {
        id: "session-c1",
        laneId: "lane-b",
        laneName: "Lane B",
        ptyId: null,
        tracked: true,
        pinned: false,
        goal: null,
        toolType: "shell" as const,
        title: "Delta",
        status: "completed" as const,
        startedAt: isoDaysAgo(3),
        endedAt: isoDaysAgo(3, -1),
        exitCode: 0,
        transcriptPath: "",
        headShaStart: null,
        headShaEnd: null,
        lastOutputPreview: null,
        summary: null,
        runtimeState: "exited" as const,
        resumeCommand: null,
      },
    ];

    const laneOrder = [
      { id: "lane-a", name: "Lane A", laneType: "worktree" as const, createdAt: isoDaysAgo(0), color: null as string | null },
      { id: "lane-b", name: "Lane B", laneType: "worktree" as const, createdAt: isoDaysAgo(2), color: null as string | null },
    ];

    const byLane = buildWorkTabGroupModel({
      sessions,
      lanes: laneOrder,
      organization: "by-lane",
      collapsedGroupIds: [],
    });
    expect(byLane.groups.map((group) => group.id)).toEqual(["lane:lane-a", "lane:lane-b"]);
    expect(byLane.sessionIds).toEqual(["session-a1", "session-a2", "session-b1", "session-c1"]);

    const byStatus = buildWorkTabGroupModel({
      sessions,
      lanes: laneOrder,
      organization: "all-lanes-by-status",
      collapsedGroupIds: ["status:running"],
    });
    expect(byStatus.groups.map((group) => group.id)).toEqual(["status:running", "status:ended"]);
    expect(byStatus.groups[0]!.collapsed).toBe(true);
    expect(byStatus.sessionIds).toEqual(["session-c1"]);

    const byTime = buildWorkTabGroupModel({
      sessions,
      lanes: laneOrder,
      organization: "by-time",
      collapsedGroupIds: [],
    });
    expect(byTime.groups.map((group) => group.id)).toEqual(["time:today", "time:yesterday", "time:older"]);
    expect(byTime.sessionIds).toEqual(["session-a1", "session-a2", "session-b1", "session-c1"]);
  });

  it("pulls snoozed rows out of their status bucket into a Snoozed group above Settled", () => {
    const nowMs = Date.parse("2026-04-01T12:00:00.000Z");
    const iso = (offsetMs: number) => new Date(nowMs + offsetMs).toISOString();

    const sessions = [
      makeSession("session-running", "lane-a"),
      // Snoozed but still RUNNING: snooze is a visibility overlay, so it must
      // leave the Running group even though its phase never changed.
      makeSession("session-snoozed-late", "lane-a", { snoozedUntil: iso(4 * 3600_000) }),
      makeSession("session-snoozed-soon", "lane-a", { snoozedUntil: iso(3600_000) }),
      // Snooze already lapsed — expiry is DERIVED, so this rejoins Running.
      makeSession("session-woken", "lane-a", { snoozedUntil: iso(-3600_000) }),
      makeSession("session-settled", "lane-a", {
        status: "completed" as const,
        runtimeState: "exited" as const,
        exitCode: 0,
        endedAt: iso(-60_000),
        settledAt: iso(-30_000),
      }),
    ];
    const lanes = [
      { id: "lane-a", name: "Lane A", laneType: "worktree" as const, createdAt: iso(-86400000), color: null as string | null },
    ];

    const model = buildWorkTabGroupModel({
      sessions,
      lanes,
      organization: "all-lanes-by-status",
      collapsedGroupIds: [],
      nowMs,
    });

    expect(model.groups.map((group) => group.id)).toEqual([
      "status:running",
      "status:snoozed",
      "status:settled",
    ]);
    expect(model.groups[0]!.sessionIds).toEqual(["session-running", "session-woken"]);
    // Snoozed rows rank by when they come back, soonest first.
    expect(model.groups[1]!.sessionIds).toEqual(["session-snoozed-soon", "session-snoozed-late"]);
    expect(model.groups[1]!.label).toBe("Snoozed");
    expect(model.groups[2]!.sessionIds).toEqual(["session-settled"]);
  });

  // Regression: "Until I'm asked" snooze hid an explicitly raised hand.
  it("does NOT file a snoozed needs-you row into the Snoozed group", () => {
    const nowMs = Date.parse("2026-04-01T12:00:00.000Z");
    const iso = (offsetMs: number) => new Date(nowMs + offsetMs).toISOString();

    const sessions = [
      // Tracked CLI row blocked at a prompt, snoozed "until I'm asked" (~100y).
      makeSession("session-cli-needs-you", "lane-a", {
        toolType: "claude" as const,
        runtimeState: "waiting-input" as const,
        attentionRequestedAt: iso(-1_000),
        snoozedUntil: iso(100 * 365 * 24 * 3600_000),
        snoozedAt: iso(-60_000),
      }),
      makeSession("session-snoozed-quiet", "lane-a", { snoozedUntil: iso(3600_000) }),
    ];
    const lanes = [
      { id: "lane-a", name: "Lane A", laneType: "worktree" as const, createdAt: iso(-86400000), color: null as string | null },
    ];

    const model = buildWorkTabGroupModel({
      sessions,
      lanes,
      organization: "all-lanes-by-status",
      collapsedGroupIds: [],
      nowMs,
    });

    expect(model.groups.map((group) => group.id)).toEqual([
      "status:awaiting-input",
      "status:snoozed",
    ]);
    expect(model.groups[0]!.sessionIds).toEqual(["session-cli-needs-you"]);
    expect(model.groups[1]!.sessionIds).toEqual(["session-snoozed-quiet"]);
  });

  it("reorders from the displayed pinned tab order", () => {
    expect(reorderLaneSessionIdsForDisplay({
      baseOrder: ["unpinned-a", "pinned-b", "unpinned-c"],
      pinnedSessionIds: ["pinned-b"],
      movedSessionId: "pinned-b",
      targetSessionId: "unpinned-c",
      edge: "after",
    })).toEqual(["unpinned-a", "unpinned-c", "pinned-b"]);
  });
});

// ---------------------------------------------------------------------------
// Chip filters and lane ordering
// ---------------------------------------------------------------------------

describe("useWorkSessions — chip filters and lane ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFakeAppStoreState();
    installWindowAde();
    listSessionsCachedMock.mockResolvedValue([]);
    useSearchParamsMock.mockReturnValue([new URLSearchParams(), vi.fn()]);
    setDocumentVisibility("visible");
  });

  afterEach(() => {
    cleanup();
    delete (window as any).ade;
  });

  function seedViewState(patch: Record<string, unknown>) {
    // The store is mocked, so the persisted blob is handed to the hook as-is —
    // it has to carry the fields the hook dereferences, same as the other suites.
    fakeAppStoreState = {
      ...fakeAppStoreState,
      workViewByProject: {
        "/fake/project": {
          openItemIds: [] as string[],
          activeItemId: null,
          selectedItemId: null,
          gridSets: [],
          activeGridSetId: null,
          draftKind: "chat" as const,
          laneFilter: "all",
          search: "",
          sessionListOrganization: "by-lane" as const,
          workCollapsedLaneIds: [] as string[],
          workCollapsedTabGroupIds: [] as string[],
          workCollapsedSectionIds: [] as string[],
          workFocusSessionsHidden: false,
          ...patch,
        },
      },
    };
  }

  async function renderWithSessions(sessions: unknown[]) {
    listSessionsCachedMock.mockResolvedValue(sessions);
    const rendered = renderHook(() => useWorkSessions());
    await waitFor(() => {
      expect(rendered.result.current.sessions.length).toBe(sessions.length);
    });
    return rendered;
  }

  const runningSession = makeSession("session-running", "lane-1");
  const snoozedSession = makeSession("session-snoozed", "lane-1", {
    snoozedUntil: "2099-01-01T00:00:00.000Z",
  });

  it("narrows the buckets and the by-lane grouping but not the exported filtered list", async () => {
    seedViewState({ workSessionFilters: { status: ["snoozed"], tool: [], hasPr: false, dirtyLane: false } });
    const { result } = await renderWithSessions([runningSession, snoozedSession]);

    // The lane/search result is what pane counts describe, so it must stay whole.
    expect(result.current.filtered.map((s) => s.id))
      .toEqual(["session-running", "session-snoozed"]);
    expect(result.current.runningFiltered).toEqual([]);
    expect(result.current.snoozedFiltered.map((s) => s.id)).toEqual(["session-snoozed"]);
    expect(result.current.sessionsGroupedByLane?.get("lane-1")?.map((s) => s.id))
      .toEqual(["session-snoozed"]);
  });

  it("keeps a snoozed row's wake timer armed while a chip hides it", async () => {
    // The trap: if the snooze-deadline effect read the chip-filtered list, a
    // snoozed row hidden by a chip would stop scheduling its own wake and never
    // come back. `filtered` still holds it, so the timer still arms.
    seedViewState({ workSessionFilters: { status: ["running"], tool: [], hasPr: false, dirtyLane: false } });
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    const { result } = await renderWithSessions([runningSession, snoozedSession]);

    expect(result.current.snoozedFiltered).toEqual([]);
    expect(result.current.filtered.some((s) => s.id === "session-snoozed")).toBe(true);
    expect(setTimeoutSpy).toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
  });

  it("returns the unfiltered list by reference when no chip is set", async () => {
    const { result } = await renderWithSessions([runningSession, snoozedSession]);
    const first = result.current.filtered;
    // Referential stability is what keeps the feature free when unused: the
    // downstream memo chain must not see a new array every render.
    expect(result.current.sessionsGroupedByLane?.get("lane-1")?.length).toBe(2);
    expect(result.current.filtered).toBe(first);
  });

  it("toggling a lane pin writes only that key", async () => {
    const { result } = await renderWithSessions([runningSession]);
    act(() => {
      result.current.toggleWorkLanePinned("lane-1");
    });
    expect(setWorkViewStateSpy).toHaveBeenCalledWith("/fake/project", expect.any(Function));
    const updater = setWorkViewStateSpy.mock.calls.at(-1)![1] as (
      prev: Record<string, unknown>,
    ) => Record<string, unknown>;
    expect(updater({ workPinnedLaneIds: [] }).workPinnedLaneIds).toEqual(["lane-1"]);
    expect(updater({ workPinnedLaneIds: ["lane-1"] }).workPinnedLaneIds).toEqual([]);
  });

  it("a drag from a non-manual mode seeds the order from what is on screen and flips to manual", async () => {
    const { result } = await renderWithSessions([runningSession]);
    act(() => {
      result.current.reorderWorkLanes({
        movedLaneId: "lane-c",
        targetLaneId: "lane-a",
        edge: "before",
        renderedLaneIds: ["lane-a", "lane-b", "lane-c"],
      });
    });
    const updater = setWorkViewStateSpy.mock.calls.at(-1)![1] as (
      prev: Record<string, unknown>,
    ) => Record<string, unknown>;
    const next = updater({ workLaneSortMode: "created", workLaneOrder: [] });
    expect(next.workLaneSortMode).toBe("manual");
    expect(next.workLaneOrder).toEqual(["lane-c", "lane-a", "lane-b"]);
  });

  it("drops ids for lanes that no longer exist when writing a manual move", async () => {
    const { result } = await renderWithSessions([runningSession]);
    act(() => {
      result.current.reorderWorkLanes({
        movedLaneId: "lane-b",
        targetLaneId: "lane-a",
        edge: "before",
        renderedLaneIds: ["lane-a", "lane-b"],
      });
    });
    const updater = setWorkViewStateSpy.mock.calls.at(-1)![1] as (
      prev: Record<string, unknown>,
    ) => Record<string, unknown>;
    const next = updater({ workLaneSortMode: "manual", workLaneOrder: ["deleted", "lane-a", "lane-b"] });
    expect(next.workLaneOrder).toEqual(["lane-b", "lane-a"]);
  });
});
