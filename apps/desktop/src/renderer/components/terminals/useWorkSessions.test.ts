/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

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
  };
  routerLocation.pathname = "/work";
  routerLocation.search = "";
  routerLocation.hash = "";
}

// ---------------------------------------------------------------------------
// Module-level mocks (hoisted by vitest)
// ---------------------------------------------------------------------------

const { listSessionsCachedMock, useSearchParamsMock } = vi.hoisted(() => ({
  listSessionsCachedMock: vi.fn().mockResolvedValue([]),
  useSearchParamsMock: vi.fn(() => [new URLSearchParams(), vi.fn()]),
}));

vi.mock("../../lib/sessionListCache", () => ({
  listSessionsCached: (...args: unknown[]) => listSessionsCachedMock(...args),
  invalidateSessionListCache: vi.fn(),
}));

vi.mock("../../lib/chatSessionEvents", () => ({
  shouldRefreshSessionListForChatEvent: vi.fn(() => false),
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
  isRunOwnedSession: vi.fn(() => false),
  isChatToolType: vi.fn(() => false),
}));

vi.mock("react-router-dom", () => ({
  useNavigate: vi.fn(() => navigateSpy),
  useLocation: vi.fn(() => routerLocation),
  useSearchParams: useSearchParamsMock,
}));

vi.mock("../../state/appStore", () => {
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
  return { useAppStore, useAppStoreApi };
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
      viewMode: "tabs" as const,
      draftKind: "chat" as const,
      laneFilter: "all",
      statusFilter: "all" as const,
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
      viewMode: "tabs" as const,
      draftKind: "cli" as const,
      laneFilter: "all",
      statusFilter: "all" as const,
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
      expect(listSessionsCachedMock).toHaveBeenCalled();
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

  it("launchPtySession can start a terminal in the background without changing the active tab", async () => {
    const workState = {
      openItemIds: ["existing-session"] as string[],
      activeItemId: "existing-session" as string | null,
      selectedItemId: "existing-session" as string | null,
      viewMode: "tabs" as const,
      draftKind: "cli" as const,
      laneFilter: "all",
      statusFilter: "all" as const,
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

  it("launchPtySession preserves the live optimistic pty id when a stale row has the same session id", async () => {
    const workState = {
      openItemIds: [] as string[],
      activeItemId: null as string | null,
      selectedItemId: null as string | null,
      viewMode: "tabs" as const,
      draftKind: "cli" as const,
      laneFilter: "all",
      statusFilter: "all" as const,
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
      viewMode: "grid",
      draftKind: "cli",
      laneFilter: "lane-1",
      statusFilter: "running",
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
      viewMode: "tabs",
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

  it("setActiveItemId selects the active tab lane in tab mode", async () => {
    const sessionA = makeSession("session-a", "lane-a");
    const sessionB = makeSession("session-b", "lane-b");
    const workState = {
      openItemIds: ["session-a", "session-b"],
      activeItemId: "session-a",
      selectedItemId: "session-a",
      viewMode: "tabs" as const,
      draftKind: "chat" as const,
      laneFilter: "all",
      statusFilter: "all" as const,
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
      viewMode: "tabs" as const,
      draftKind: "chat" as const,
      laneFilter: "all",
      statusFilter: "all" as const,
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

  it("setActiveItemId leaves the selected lane alone in grid mode", async () => {
    const sessionA = makeSession("session-a", "lane-a");
    const sessionB = makeSession("session-b", "lane-b");
    const workState = {
      openItemIds: ["session-a", "session-b"],
      activeItemId: "session-a",
      selectedItemId: "session-a",
      viewMode: "grid" as const,
      draftKind: "chat" as const,
      laneFilter: "all",
      statusFilter: "all" as const,
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

    expect(selectLaneSpy).not.toHaveBeenCalled();
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
      viewMode: "tabs" as const,
      draftKind: "chat" as const,
      laneFilter: "lane-2",
      statusFilter: "completed" as const,
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
    expect(workState.statusFilter).toBe("completed");
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
      viewMode: "tabs" as const,
      draftKind: "chat" as const,
      laneFilter: "all",
      statusFilter: "all" as const,
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
      expect(workState.laneFilter).toBe("lane-1");
      expect(workState.statusFilter).toBe("running");
    });

    // The stale session never existed, so focusSession must not fire for it.
    expect(focusSessionSpy).not.toHaveBeenCalledWith("missing-session");
    expect(navigateSpy).toHaveBeenCalledWith("/work?sessionId=missing-session", { replace: true });
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
      viewMode: "tabs" as const,
      draftKind: "chat" as const,
      laneFilter: "all",
      statusFilter: "all" as "all" | "running" | "ended",
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

    const { rerender } = renderHook(() => useWorkSessions());

    await waitFor(() => {
      expect(workState.laneFilter).toBe("lane-1");
      expect(workState.statusFilter).toBe("running");
    });

    workState.laneFilter = "all";
    workState.statusFilter = "ended";
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

    expect(workState.laneFilter).toBe("all");
    expect(workState.statusFilter).toBe("ended");
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
      viewMode: "tabs" as const,
      draftKind: "chat" as const,
      laneFilter: "all",
      statusFilter: "all" as "all" | "running" | "completed",
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
      expect(workState.statusFilter).toBe("running");
    });
    expect(workState.laneFilter).toBe("all");

    workState.statusFilter = "completed";
    listSessionsCachedMock.mockResolvedValue([{ ...session, id: "session-3" }]);

    await act(async () => {
      await result.current.refresh({ force: true });
    });

    expect(workState.statusFilter).toBe("completed");
    expect(workState.laneFilter).toBe("all");

    fakeAppStoreState = {
      ...fakeAppStoreState,
      lanes: [{ id: "lane-1", name: "Lane 1" }],
    };

    act(() => {
      rerender();
    });

    await waitFor(() => {
      expect(workState.laneFilter).toBe("lane-1");
    });
    expect(workState.statusFilter).toBe("completed");
  });

  it("filters the Work list by the stored status filter", async () => {
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
          viewMode: "tabs",
          draftKind: "chat",
          laneFilter: "all",
          statusFilter: "running",
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
      viewMode: "tabs" as const,
      draftKind: "chat" as const,
      laneFilter: "all",
      statusFilter: "all" as "all" | "running" | "completed",
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

    const { rerender } = renderHook(() => useWorkSessions());

    await waitFor(() => {
      expect(workState.laneFilter).toBe("lane-1");
      expect(workState.statusFilter).toBe("running");
    });

    currentSearchParams = new URLSearchParams("sessionId=session-2");
    act(() => {
      rerender();
    });

    workState.laneFilter = "all";
    workState.statusFilter = "completed";
    currentSearchParams = deepLinkParams;
    act(() => {
      rerender();
    });

    await waitFor(() => {
      expect(workState.laneFilter).toBe("lane-1");
      expect(workState.statusFilter).toBe("running");
    });
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
      viewMode: "grid" as const,
      draftKind: "chat" as const,
      laneFilter: "all",
      statusFilter: "all" as const,
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
      viewMode: "grid" as const,
      draftKind: "chat" as const,
      laneFilter: "all",
      statusFilter: "all" as const,
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
    expect(byStatus.groups.map((group) => group.id)).toEqual(["status:running", "status:awaiting-input", "status:ended"]);
    expect(byStatus.groups[0]!.collapsed).toBe(true);
    expect(byStatus.sessionIds).toEqual(["session-a2", "session-c1"]);

    const byTime = buildWorkTabGroupModel({
      sessions,
      lanes: laneOrder,
      organization: "by-time",
      collapsedGroupIds: [],
    });
    expect(byTime.groups.map((group) => group.id)).toEqual(["time:today", "time:yesterday", "time:older"]);
    expect(byTime.sessionIds).toEqual(["session-a1", "session-a2", "session-b1", "session-c1"]);
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
