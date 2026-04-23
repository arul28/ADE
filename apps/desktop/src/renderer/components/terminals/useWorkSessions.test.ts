/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Spies used across all tests
// ---------------------------------------------------------------------------
const focusSessionSpy = vi.fn();
const selectLaneSpy = vi.fn();
const setWorkViewStateSpy = vi.fn();
const navigateSpy = vi.fn();
let fakeAppStoreState: Record<string, unknown>;

function resetFakeAppStoreState() {
  fakeAppStoreState = {
    project: { rootPath: "/fake/project" },
    lanes: [{ id: "lane-1", name: "Lane 1" }],
    focusSession: focusSessionSpy,
    focusedSessionId: null,
    selectLane: selectLaneSpy,
    workViewByProject: {},
    setWorkViewState: setWorkViewStateSpy,
  };
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
  useSearchParams: useSearchParamsMock,
}));

vi.mock("../../state/appStore", () => ({
  useAppStore: vi.fn((selector: (state: Record<string, unknown>) => unknown) => {
    return selector(fakeAppStoreState);
  }),
}));

// ---------------------------------------------------------------------------
// Import the hook under test (after mocks are declared)
// ---------------------------------------------------------------------------
import { buildWorkTabGroupModel, useWorkSessions } from "./useWorkSessions";
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
  });

  afterEach(() => {
    delete (window as any).ade;
  });

  // -----------------------------------------------------------------------
  // launchPtySession: refresh() must complete before focusSession / openSessionTab
  // -----------------------------------------------------------------------
  it("launchPtySession: awaits refresh() before calling focusSession and openSessionTab", async () => {
    const callOrder: string[] = [];

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
    setWorkViewStateSpy.mockImplementation(() => {
      if (!callOrder.includes("openSessionTab")) {
        callOrder.push("openSessionTab");
      }
    });

    // Act: start launchPtySession
    let launchPromise!: Promise<unknown>;
    act(() => {
      launchPromise = result.current.launchPtySession({
        laneId: "lane-1",
        profile: "claude",
      });
    });

    // Give the async function a tick to reach the refresh await
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // refresh-start should be recorded but focusSession NOT yet
    expect(callOrder).toContain("refresh-start");
    expect(callOrder).not.toContain("focusSession");
    expect(callOrder).not.toContain("openSessionTab");

    // Resolve the refresh promise
    await act(async () => {
      expect(refreshResolve).not.toBeNull();
      refreshResolve!();
      await launchPromise;
    });

    // Verify ordering: refresh-done BEFORE focusSession and openSessionTab
    const refreshDoneIdx = callOrder.indexOf("refresh-done");
    const focusIdx = callOrder.indexOf("focusSession");
    const openTabIdx = callOrder.indexOf("openSessionTab");

    expect(refreshDoneIdx).toBeGreaterThanOrEqual(0);
    expect(focusIdx).toBeGreaterThanOrEqual(0);
    expect(openTabIdx).toBeGreaterThanOrEqual(0);
    expect(refreshDoneIdx).toBeLessThan(focusIdx);
    expect(refreshDoneIdx).toBeLessThan(openTabIdx);
  });

  it("showDraftKind: clears the active session and re-enters chat draft mode without closing tabs", () => {
    const previousState = {
      openItemIds: ["session-1", "session-2"],
      activeItemId: "session-2",
      selectedItemId: "session-2",
      viewMode: "grid",
      draftKind: "shell",
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

  it("resumeSession keeps the Work view active and reuses the existing tracked session id", async () => {
    const session = {
      id: "session-1",
      laneId: "lane-1",
      laneName: "Lane 1",
      ptyId: null,
      tracked: true,
      pinned: false,
      goal: "Resume codex",
      toolType: "codex" as const,
      title: "Codex",
      status: "completed" as const,
      startedAt: "2026-04-01T12:00:00.000Z",
      endedAt: "2026-04-01T12:30:00.000Z",
      exitCode: 0,
      transcriptPath: "/tmp/session-1.log",
      headShaStart: null,
      headShaEnd: null,
      lastOutputPreview: null,
      summary: null,
      runtimeState: "exited" as const,
      resumeCommand: "codex --no-alt-screen --dangerously-bypass-approvals-and-sandbox resume thread-1",
      resumeMetadata: {
        provider: "codex" as const,
        targetKind: "thread" as const,
        targetId: "thread-1",
        launch: { permissionMode: "full-auto" as const },
      },
    };
    listSessionsCachedMock.mockResolvedValue([session]);

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
    setWorkViewStateSpy.mockImplementation((_projectRoot: string, next: any) => {
      const resolved = typeof next === "function" ? next(workState) : { ...workState, ...next };
      Object.assign(workState, resolved);
    });
    (window as any).ade.pty.create.mockResolvedValue({ sessionId: "session-1", ptyId: "pty-2" });

    const { result } = renderHook(() => useWorkSessions());

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    await act(async () => {
      await result.current.resumeSession(session);
    });

    expect((window as any).ade.pty.create).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
      startupCommand: "codex --no-alt-screen --dangerously-bypass-approvals-and-sandbox resume thread-1",
    }));
    expect(focusSessionSpy).toHaveBeenCalledWith("session-1");
    expect(workState.activeItemId).toBe("session-1");
    expect(workState.selectedItemId).toBe("session-1");
    expect(navigateSpy).not.toHaveBeenCalled();
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
      { id: "lane-a", name: "Lane A", laneType: "worktree" as const, createdAt: isoDaysAgo(0) },
      { id: "lane-b", name: "Lane B", laneType: "worktree" as const, createdAt: isoDaysAgo(2) },
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
});
