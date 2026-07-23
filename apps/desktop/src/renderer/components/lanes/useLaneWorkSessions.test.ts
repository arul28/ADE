/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Spies used across all tests — kept outside vi.mock so they're shared.
// ---------------------------------------------------------------------------
const focusSessionSpy = vi.fn();
const selectLaneSpy = vi.fn();
const setWorkViewStateSpy = vi.fn();
const setLaneWorkViewStateSpy = vi.fn();
let fakeProjectRoot = "/fake/project";
let fakeProjectBinding: Record<string, unknown> | null = null;

// ---------------------------------------------------------------------------
// Module-level mocks (hoisted by vitest)
// ---------------------------------------------------------------------------

const listSessionsCachedMock = vi.fn().mockResolvedValue([]);

vi.mock("../../lib/sessionListCache", () => ({
  listSessionsCached: (...args: unknown[]) => listSessionsCachedMock(...args),
  invalidateSessionListCache: vi.fn(),
}));

vi.mock("../../lib/chatSessionEvents", () => ({
  shouldRefreshSessionListForChatEvent: vi.fn(() => false),
  subscribeWorkChatSessionCreated: vi.fn(() => () => {}),
}));

vi.mock("../../lib/terminalAttention", () => ({
  sessionStatusBucket: vi.fn(() => "ended"),
  canonicalInputFromSummary: vi.fn((session: unknown) => session),
}));

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
}));

vi.mock("../../state/appStore", () => ({
  selectActiveProjectRoot: (state: Record<string, unknown>) => {
    const binding = state.projectBinding as { kind?: string; rootPath?: string | null } | null | undefined;
    if (binding?.kind === "remote") return binding.rootPath?.trim() || null;
    const project = state.project as { rootPath?: string | null } | null | undefined;
    return project?.rootPath?.trim() || null;
  },
  useAppStore: vi.fn((selector: (state: Record<string, unknown>) => unknown) => {
    const fakeState: Record<string, unknown> = {
      project: { rootPath: fakeProjectRoot },
      projectBinding: fakeProjectBinding,
      lanes: [{ id: "lane-1", name: "Lane 1" }],
      focusSession: focusSessionSpy,
      focusedSessionId: null,
      selectLane: selectLaneSpy,
      laneWorkViewByScope: {},
      setLaneWorkViewState: setLaneWorkViewStateSpy,
      workViewByProject: {},
      setWorkViewState: setWorkViewStateSpy,
    };
    return selector(fakeState);
  }),
  useAppStoreApi: vi.fn(() => ({
    getState: () => ({
      project: { rootPath: fakeProjectRoot },
      projectBinding: fakeProjectBinding,
    }),
    setState: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  })),
}));

// ---------------------------------------------------------------------------
// Import the hook under test (after mocks are declared)
// ---------------------------------------------------------------------------
import { __clearLaneWorkSessionCacheForTests, useLaneWorkSessions } from "./useLaneWorkSessions";
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
      sendToSession: vi.fn().mockResolvedValue({ sessionId: "resumed-session", ptyId: "pty-resumed", pid: 123, session: null }),
      onExit: vi.fn(() => () => {}),
      dispose: vi.fn().mockResolvedValue(undefined),
    },
    agentChat: {
      onEvent: vi.fn(() => () => {}),
    },
  };
}

function makeSession(id: string, laneId: string, title = id) {
  return {
    id,
    laneId,
    laneName: laneId,
    ptyId: null,
    tracked: true,
    pinned: false,
    toolType: "claude-chat",
    title,
    status: "running",
    startedAt: "2026-05-01T12:00:00.000Z",
    endedAt: null,
    exitCode: null,
    transcriptPath: "",
    headShaStart: null,
    headShaEnd: null,
    lastOutputPreview: null,
    summary: null,
    runtimeState: "idle",
    resumeCommand: null,
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

describe("useLaneWorkSessions — refresh-before-focus ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __clearLaneWorkSessionCacheForTests();
    installWindowAde();
    // Default: instant resolve for mount-time refresh calls
    listSessionsCachedMock.mockResolvedValue([]);
    vi.mocked(shouldRefreshSessionListForChatEvent).mockReturnValue(false);
    fakeProjectRoot = "/fake/project";
    fakeProjectBinding = null;
    setDocumentVisibility("visible");
  });

  afterEach(() => {
    setDocumentVisibility("visible");
    delete (window as any).ade;
  });

  it("hydrates cached lane sessions immediately on remount while refreshing in the background", async () => {
    const cachedSession = {
      id: "session-cached",
      laneId: "lane-1",
      laneName: "Lane 1",
      ptyId: null,
      tracked: true,
      pinned: false,
      toolType: "claude-chat",
      title: "Cached chat",
      status: "running",
      startedAt: "2026-05-01T12:00:00.000Z",
      endedAt: null,
      exitCode: null,
      transcriptPath: "",
      headShaStart: null,
      headShaEnd: null,
      lastOutputPreview: null,
      summary: null,
      runtimeState: "idle",
      resumeCommand: null,
    } as any;
    const refreshedSession = {
      ...cachedSession,
      id: "session-refreshed",
      title: "Refreshed chat",
    };

    listSessionsCachedMock.mockResolvedValueOnce([cachedSession]);
    const first = renderHook(() => useLaneWorkSessions("lane-1"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(first.result.current.sessions.map((session) => session.id)).toEqual(["session-cached"]);
    first.unmount();

    let resolveRefresh: ((value: unknown[]) => void) | null = null;
    listSessionsCachedMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolveRefresh = resolve;
    }));
    const second = renderHook(() => useLaneWorkSessions("lane-1"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(second.result.current.loading).toBe(false);
    expect(second.result.current.sessions.map((session) => session.id)).toEqual(["session-cached"]);

    await act(async () => {
      expect(resolveRefresh).not.toBeNull();
      resolveRefresh!([refreshedSession]);
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(second.result.current.sessions.map((session) => session.id)).toEqual(["session-refreshed"]);
  });

  it("defers hidden session-list changes and refreshes the lane work pane on reveal", async () => {
    let onChangedHandler: (() => void) | null = null;
    (window as any).ade.sessions.onChanged.mockImplementation((cb: () => void) => {
      onChangedHandler = cb;
      return () => {
        onChangedHandler = null;
      };
    });

    renderHook(() => useLaneWorkSessions("lane-1"));

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
      await new Promise((r) => setTimeout(r, 80));
    });

    expect(listSessionsCachedMock).toHaveBeenCalledWith(
      { laneId: "lane-1", limit: 200 },
      { force: false },
    );
  });

  it("ignores pty exits for sessions outside the current lane", async () => {
    let onExitHandler: ((event: any) => void) | null = null;
    (window as any).ade.pty.onExit.mockImplementation((cb: (event: any) => void) => {
      onExitHandler = cb;
      return () => {
        onExitHandler = null;
      };
    });
    listSessionsCachedMock.mockResolvedValue([makeSession("session-current", "lane-1")]);

    renderHook(() => useLaneWorkSessions("lane-1"));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    listSessionsCachedMock.mockClear();
    vi.mocked(invalidateSessionListCache).mockClear();

    await act(async () => {
      onExitHandler?.({ sessionId: "session-other", ptyId: "pty-other", projectRoot: "/fake/project", exitCode: 0 });
      await new Promise((r) => setTimeout(r, 160));
    });

    expect(invalidateSessionListCache).not.toHaveBeenCalled();
    expect(listSessionsCachedMock).not.toHaveBeenCalled();

    await act(async () => {
      onExitHandler?.({ sessionId: "session-current", ptyId: "pty-current", projectRoot: "/fake/project", exitCode: 0 });
      await new Promise((r) => setTimeout(r, 160));
    });

    expect(invalidateSessionListCache).toHaveBeenCalledWith({ projectRoot: "/fake/project", laneId: "lane-1" });
    expect(listSessionsCachedMock).toHaveBeenCalledWith(
      { laneId: "lane-1", limit: 200 },
      { force: false },
    );
  });

  it("ignores chat activity provenanced to another lane", async () => {
    let chatEventHandler: ((event: any) => void) | null = null;
    (window as any).ade.agentChat.onEvent.mockImplementation((cb: (event: any) => void) => {
      chatEventHandler = cb;
      return () => {
        chatEventHandler = null;
      };
    });
    vi.mocked(shouldRefreshSessionListForChatEvent).mockReturnValue(true);

    renderHook(() => useLaneWorkSessions("lane-1"));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    listSessionsCachedMock.mockClear();
    vi.mocked(invalidateSessionListCache).mockClear();

    await act(async () => {
      chatEventHandler?.({ sessionId: "session-other", event: { type: "done" }, provenance: { laneId: "lane-2" } });
      await new Promise((r) => setTimeout(r, 240));
    });

    expect(invalidateSessionListCache).not.toHaveBeenCalled();
    expect(listSessionsCachedMock).not.toHaveBeenCalled();

    await act(async () => {
      chatEventHandler?.({ sessionId: "session-current", event: { type: "done" }, provenance: { laneId: "lane-1" } });
      await new Promise((r) => setTimeout(r, 240));
    });

    expect(invalidateSessionListCache).toHaveBeenCalledWith({ projectRoot: "/fake/project", laneId: "lane-1" });
    expect(listSessionsCachedMock).toHaveBeenCalledWith(
      { laneId: "lane-1", limit: 200 },
      { force: false },
    );
  });

  it("ignores metadata changes for sessions outside the current lane", async () => {
    let onChangedHandler: ((event: any) => void) | null = null;
    (window as any).ade.sessions.onChanged.mockImplementation((cb: (event: any) => void) => {
      onChangedHandler = cb;
      return () => {
        onChangedHandler = null;
      };
    });
    listSessionsCachedMock.mockResolvedValue([makeSession("session-current", "lane-1")]);

    renderHook(() => useLaneWorkSessions("lane-1"));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    listSessionsCachedMock.mockClear();
    vi.mocked(invalidateSessionListCache).mockClear();

    await act(async () => {
      onChangedHandler?.({ sessionId: "session-other", reason: "meta-updated" });
      await new Promise((r) => setTimeout(r, 120));
    });

    expect(invalidateSessionListCache).not.toHaveBeenCalled();
    expect(listSessionsCachedMock).not.toHaveBeenCalled();

    await act(async () => {
      onChangedHandler?.({ sessionId: "session-new", reason: "created" });
      await new Promise((r) => setTimeout(r, 120));
    });

    expect(invalidateSessionListCache).toHaveBeenCalledWith({ projectRoot: "/fake/project", laneId: "lane-1" });
    expect(listSessionsCachedMock).toHaveBeenCalledWith(
      { laneId: "lane-1", limit: 200 },
      { force: false },
    );
  });

  // -----------------------------------------------------------------------
  // launchPtySession: focus/open immediately; refresh reconciles in background.
  // -----------------------------------------------------------------------
  it("launchPtySession: opens the optimistic terminal before the forced refresh completes", async () => {
    const callOrder: string[] = [];

    const { result } = renderHook(() => useLaneWorkSessions("lane-1"));

    // Flush mount effects (initial refresh)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // Now install ordering instrumentation for the *next* call to listSessionsCached
    // (which will be the force-refresh inside launchPtySession).
    let refreshResolve: (() => void) | null = null;
    listSessionsCachedMock.mockImplementation(
      (_args: unknown, _opts?: unknown) => {
        callOrder.push("refresh-start");
        return new Promise<never[]>((resolve) => {
          refreshResolve = () => {
            callOrder.push("refresh-done");
            resolve([]);
          };
        });
      },
    );

    focusSessionSpy.mockImplementation(() => {
      callOrder.push("focusSession");
    });
    // openSessionTab calls setWorkViewState internally twice (project-level + lane-level)
    // We track calls via setWorkViewState since openSessionTab delegates there.
    setWorkViewStateSpy.mockImplementation(() => {
      if (!callOrder.includes("openSessionTab")) {
        callOrder.push("openSessionTab");
      }
    });

    await act(async () => {
      await result.current.launchPtySession({
        laneId: "lane-1",
        profile: "claude",
      });
    });

    await act(async () => {
      await Promise.resolve();
    });

    // The tab opens while the reconcile refresh is still pending.
    expect(callOrder).toContain("refresh-start");
    expect(callOrder).toContain("focusSession");
    expect(callOrder).toContain("openSessionTab");
    expect(callOrder).not.toContain("refresh-done");

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

  it("launchPtySession: keeps the optimistic terminal when the forced refresh is stale", async () => {
    const { result } = renderHook(() => useLaneWorkSessions("lane-1"));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    listSessionsCachedMock.mockResolvedValue([]);

    await act(async () => {
      await result.current.launchPtySession({
        laneId: "lane-1",
        profile: "shell",
      });
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(result.current.sessions.map((session) => session.id)).toContain("new-pty-session");
  });

  it("keeps a stopped lane runtime closed when a stale refresh returns the old running row", async () => {
    const runningSession = {
      ...makeSession("session-stop", "lane-1", "Running Codex"),
      ptyId: "pty-stop",
      toolType: "codex",
      runtimeState: "running",
    } as any;
    listSessionsCachedMock
      .mockResolvedValueOnce([runningSession])
      .mockResolvedValueOnce([runningSession]);

    const { result } = renderHook(() => useLaneWorkSessions("lane-1"));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(result.current.sessions[0]?.ptyId).toBe("pty-stop");

    await act(async () => {
      await result.current.closePtySession("pty-stop");
      await new Promise((r) => setTimeout(r, 0));
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

  it("launchPtySession carries its project pin into continue and close calls", async () => {
    const pin = {
      kind: "local",
      key: "local:/origin/project",
      rootPath: "/origin/project",
      displayName: "Origin",
    } as const;
    const resumedSession = {
      ...makeSession("new-pty-session", "lane-1", "Pinned Codex"),
      ptyId: "pty-resumed",
      toolType: "codex",
      runtimeState: "running",
    } as any;
    (window as any).ade.pty.sendToSession.mockResolvedValueOnce({
      sessionId: "new-pty-session",
      ptyId: "pty-resumed",
      pid: 123,
      session: resumedSession,
      resumed: true,
      reusedExistingRuntime: false,
    });
    listSessionsCachedMock.mockResolvedValue([resumedSession]);

    const { result } = renderHook(() => useLaneWorkSessions("lane-1"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    await act(async () => {
      await result.current.launchPtySession({
        laneId: "lane-1",
        profile: "codex",
        title: "Pinned Codex",
        pin,
      });
    });

    expect((window as any).ade.pty.create).toHaveBeenLastCalledWith(expect.objectContaining({
      laneId: "lane-1",
      title: "Pinned Codex",
    }), pin);

    await act(async () => {
      await result.current.continueCliSession({
        ...resumedSession,
        ptyId: null,
        status: "ended",
        runtimeState: "exited",
      }, "keep going");
    });

    expect((window as any).ade.pty.sendToSession).toHaveBeenLastCalledWith({
      sessionId: "new-pty-session",
      text: "keep going",
      cols: 100,
      rows: 30,
    }, pin);

    await act(async () => {
      await result.current.closePtySession("pty-resumed");
      await new Promise((r) => setTimeout(r, 0));
    });

    expect((window as any).ade.pty.dispose).toHaveBeenLastCalledWith({
      ptyId: "pty-resumed",
      sessionId: "new-pty-session",
    }, pin);
  });

  it("launchPtySession skips lane UI mutations when a pinned launch resolves after project switch", async () => {
    const pin = {
      kind: "local",
      key: "local:/origin/project",
      rootPath: "/origin/project",
      displayName: "Origin",
    } as const;
    fakeProjectBinding = {
      kind: "local",
      key: "local:/other/project",
      rootPath: "/other/project",
      displayName: "Other",
    };
    (window as any).ade.pty.create.mockResolvedValueOnce({
      sessionId: "stale-pinned-session",
      ptyId: "stale-pinned-pty",
      pid: 1234,
    });
    listSessionsCachedMock.mockResolvedValue([]);

    const { result } = renderHook(() => useLaneWorkSessions("lane-1"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    focusSessionSpy.mockClear();
    selectLaneSpy.mockClear();
    setWorkViewStateSpy.mockClear();
    setLaneWorkViewStateSpy.mockClear();
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
    expect(setLaneWorkViewStateSpy).not.toHaveBeenCalled();
    expect(listSessionsCachedMock).not.toHaveBeenCalled();
  });

  it("restores a lane runtime row when dispose reports that a peer still owns it", async () => {
    const runningSession = {
      ...makeSession("session-peer", "lane-1", "Running Codex"),
      ptyId: "pty-peer",
      toolType: "codex",
      runtimeState: "running",
    } as any;
    listSessionsCachedMock
      .mockResolvedValueOnce([runningSession])
      .mockRejectedValueOnce(new Error("refresh failed"));
    (window as any).ade.pty.dispose.mockResolvedValueOnce({
      disposed: false,
      reason: "owned-by-peer",
    });

    const { result } = renderHook(() => useLaneWorkSessions("lane-1"));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(result.current.sessions[0]?.ptyId).toBe("pty-peer");

    await act(async () => {
      await result.current.closePtySession("pty-peer");
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(result.current.sessions[0]).toMatchObject({
      id: "session-peer",
      ptyId: "pty-peer",
      status: "running",
      runtimeState: "running",
    });
  });

  it("keeps a lane runtime row stopped when dispose reports the pty is already gone", async () => {
    const runningSession = {
      ...makeSession("session-missing", "lane-1", "Running Codex"),
      ptyId: "pty-missing",
      toolType: "codex",
      runtimeState: "running",
    } as any;
    listSessionsCachedMock
      .mockResolvedValueOnce([runningSession])
      .mockRejectedValueOnce(new Error("refresh failed"));
    (window as any).ade.pty.dispose.mockResolvedValueOnce({
      disposed: false,
      reason: "missing",
    });

    const { result } = renderHook(() => useLaneWorkSessions("lane-1"));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(result.current.sessions[0]?.ptyId).toBe("pty-missing");

    await act(async () => {
      await result.current.closePtySession("pty-missing");
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(result.current.sessions[0]).toMatchObject({
      id: "session-missing",
      ptyId: null,
      status: "disposed",
      runtimeState: "killed",
      exitCode: null,
    });
  });

  it("restores a lane runtime row when dispose reports a session mismatch", async () => {
    const runningSession = {
      ...makeSession("session-mismatch", "lane-1", "Running Codex"),
      ptyId: "pty-stale",
      toolType: "codex",
      runtimeState: "running",
    } as any;
    listSessionsCachedMock
      .mockResolvedValueOnce([runningSession])
      .mockRejectedValueOnce(new Error("refresh failed"));
    (window as any).ade.pty.dispose.mockResolvedValueOnce({
      disposed: false,
      reason: "session-mismatch",
    });

    const { result } = renderHook(() => useLaneWorkSessions("lane-1"));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    await act(async () => {
      await result.current.closePtySession("pty-stale");
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(result.current.sessions[0]).toMatchObject({
      id: "session-mismatch",
      ptyId: "pty-stale",
      status: "running",
      runtimeState: "running",
    });
  });

  it("launchPtySession: opens immediately when another refresh is already running", async () => {
    const callOrder: string[] = [];
    let refreshCallCount = 0;
    let initialRefreshResolve: (() => void) | null = null;
    let queuedRefreshResolve: (() => void) | null = null;

    listSessionsCachedMock.mockImplementation(() => {
      refreshCallCount += 1;
      if (refreshCallCount === 1) {
        callOrder.push("initial-refresh-start");
        return new Promise<never[]>((resolve) => {
          initialRefreshResolve = () => {
            callOrder.push("initial-refresh-done");
            resolve([]);
          };
        });
      }
      callOrder.push("queued-refresh-start");
      return new Promise<never[]>((resolve) => {
        queuedRefreshResolve = () => {
          callOrder.push("queued-refresh-done");
          resolve([]);
        };
      });
    });

    focusSessionSpy.mockImplementation(() => {
      callOrder.push("focusSession");
    });
    setWorkViewStateSpy.mockImplementation(() => {
      if (!callOrder.includes("openSessionTab")) {
        callOrder.push("openSessionTab");
      }
    });

    const { result } = renderHook(() => useLaneWorkSessions("lane-1"));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(callOrder).toContain("initial-refresh-start");

    await act(async () => {
      await result.current.launchPtySession({
        laneId: "lane-1",
        profile: "shell",
      });
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(callOrder).toContain("focusSession");
    expect(callOrder).toContain("openSessionTab");
    expect(callOrder).not.toContain("initial-refresh-done");

    await act(async () => {
      expect(initialRefreshResolve).not.toBeNull();
      initialRefreshResolve!();
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(callOrder).toContain("queued-refresh-start");

    await act(async () => {
      expect(queuedRefreshResolve).not.toBeNull();
      queuedRefreshResolve!();
      await Promise.resolve();
    });

    const queuedDoneIdx = callOrder.indexOf("queued-refresh-done");
    const focusIdx = callOrder.indexOf("focusSession");
    const openTabIdx = callOrder.indexOf("openSessionTab");

    expect(queuedDoneIdx).toBeGreaterThanOrEqual(0);
    expect(focusIdx).toBeGreaterThanOrEqual(0);
    expect(openTabIdx).toBeGreaterThanOrEqual(0);
    expect(focusIdx).toBeLessThan(queuedDoneIdx);
    expect(openTabIdx).toBeLessThan(queuedDoneIdx);
  });

  it("replays a queued refresh against the latest lane after switching lanes mid-refresh", async () => {
    const fetchedLaneIds: string[] = [];
    let firstRefreshResolve: ((rows: unknown[]) => void) | null = null;
    let secondRefreshResolve: ((rows: unknown[]) => void) | null = null;

    listSessionsCachedMock.mockImplementation((args: { laneId: string }) => {
      fetchedLaneIds.push(args.laneId);
      if (fetchedLaneIds.length === 1) {
        return new Promise((resolve) => {
          firstRefreshResolve = resolve;
        });
      }
      if (fetchedLaneIds.length === 2) {
        return new Promise((resolve) => {
          secondRefreshResolve = resolve;
        });
      }
      return Promise.resolve([]);
    });

    const { result, rerender } = renderHook(
      ({ laneId }: { laneId: string }) => useLaneWorkSessions(laneId),
      { initialProps: { laneId: "lane-1" } },
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(fetchedLaneIds).toEqual(["lane-1"]);

    act(() => {
      rerender({ laneId: "lane-2" });
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(fetchedLaneIds).toEqual(["lane-1"]);

    await act(async () => {
      expect(firstRefreshResolve).not.toBeNull();
      firstRefreshResolve!([makeSession("session-old", "lane-1")]);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(fetchedLaneIds).toEqual(["lane-1", "lane-2"]);

    await act(async () => {
      expect(secondRefreshResolve).not.toBeNull();
      secondRefreshResolve!([makeSession("session-new", "lane-2")]);
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(result.current.sessions.map((session) => session.id)).toEqual(["session-new"]);
  });

  it("replays a queued refresh against the latest project after switching projects mid-refresh", async () => {
    const fetchOptions: Array<{ force?: boolean }> = [];
    let firstRefreshResolve: ((rows: unknown[]) => void) | null = null;
    let secondRefreshResolve: ((rows: unknown[]) => void) | null = null;

    listSessionsCachedMock.mockImplementation((_args: { laneId: string }, options?: { force?: boolean }) => {
      fetchOptions.push(options ?? {});
      if (fetchOptions.length === 1) {
        return new Promise((resolve) => {
          firstRefreshResolve = resolve;
        });
      }
      if (fetchOptions.length === 2) {
        return new Promise((resolve) => {
          secondRefreshResolve = resolve;
        });
      }
      return Promise.resolve([]);
    });

    const { result, rerender } = renderHook(() => useLaneWorkSessions("lane-1"));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(fetchOptions).toEqual([{ force: true }]);

    fakeProjectRoot = "/other/project";
    act(() => {
      rerender();
    });

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(fetchOptions).toEqual([{ force: true }]);

    await act(async () => {
      expect(firstRefreshResolve).not.toBeNull();
      firstRefreshResolve!([makeSession("session-old", "lane-1")]);
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(fetchOptions).toEqual([{ force: true }, { force: true }]);

    await act(async () => {
      expect(secondRefreshResolve).not.toBeNull();
      secondRefreshResolve!([makeSession("session-new", "lane-1")]);
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(result.current.sessions.map((session) => session.id)).toEqual(["session-new"]);
  });

  // -----------------------------------------------------------------------
  // handleOpenChatSession: opens immediately, then reconciles in background
  // -----------------------------------------------------------------------
  it("handleOpenChatSession: focuses and opens the tab before the refresh finishes", async () => {
    const callOrder: string[] = [];

    const { result } = renderHook(() => useLaneWorkSessions("lane-1"));

    // Flush mount effects
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // Install ordering instrumentation for the force-refresh inside handleOpenChatSession
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
    setWorkViewStateSpy.mockImplementation(() => {
      if (!callOrder.includes("openSessionTab")) {
        callOrder.push("openSessionTab");
      }
    });

    // Act: start handleOpenChatSession
    act(() => {
      result.current.handleOpenChatSession({
        id: "session-abc",
        laneId: "lane-1",
        provider: "claude",
        model: "claude-sonnet-5",
        modelId: "anthropic/claude-sonnet-5",
        status: "idle",
        createdAt: "2026-04-01T12:00:00.000Z",
        lastActivityAt: "2026-04-01T12:00:00.000Z",
      });
    });

    // Give the async function a tick
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // The tab should open immediately while the forced refresh is still pending.
    expect(callOrder).toContain("refresh-start");
    expect(callOrder).toContain("focusSession");
    expect(callOrder).toContain("openSessionTab");

    // Resolve the refresh
    await act(async () => {
      expect(refreshResolve).not.toBeNull();
      refreshResolve!();
      await new Promise((r) => setTimeout(r, 0));
    });

    // Verify ordering
    const refreshDoneIdx = callOrder.indexOf("refresh-done");
    const focusIdx = callOrder.indexOf("focusSession");
    const openTabIdx = callOrder.indexOf("openSessionTab");

    expect(refreshDoneIdx).toBeGreaterThanOrEqual(0);
    expect(focusIdx).toBeGreaterThanOrEqual(0);
    expect(openTabIdx).toBeGreaterThanOrEqual(0);
    expect(focusIdx).toBeLessThan(refreshDoneIdx);
    expect(openTabIdx).toBeLessThan(refreshDoneIdx);
  });

  it("showDraftKind: clears the active lane session and re-enters chat draft mode without closing lane tabs", () => {
    const previousState = {
      openItemIds: ["session-1", "session-2"],
      activeItemId: "session-2",
      selectedItemId: "session-2",
      draftKind: "cli",
      laneFilter: "all",
      search: "",
      sessionListOrganization: "by-lane",
      workCollapsedLaneIds: [],
      workCollapsedTabGroupIds: [],
      workFocusSessionsHidden: false,
    };
    let nextState: typeof previousState | null = null;

    setLaneWorkViewStateSpy.mockImplementation(
      (
        _projectRoot: string,
        _laneId: string,
        next: ((prev: typeof previousState) => typeof previousState) | Partial<typeof previousState>,
      ) => {
        nextState = typeof next === "function" ? next(previousState) : { ...previousState, ...next };
      },
    );

    const { result } = renderHook(() => useLaneWorkSessions("lane-1"));

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

  it("launchPtySession with disposition 'background' skips selectLane, focusSession, and openSessionTab", async () => {
    const callOrder: string[] = [];

    const { result } = renderHook(() => useLaneWorkSessions("lane-1"));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    listSessionsCachedMock.mockResolvedValue([]);

    focusSessionSpy.mockImplementation(() => {
      callOrder.push("focusSession");
    });
    selectLaneSpy.mockImplementation(() => {
      callOrder.push("selectLane");
    });
    setWorkViewStateSpy.mockImplementation(() => {
      callOrder.push("setWorkViewState");
    });

    await act(async () => {
      await result.current.launchPtySession({
        laneId: "lane-1",
        profile: "shell",
        disposition: "background",
      });
    });

    expect((window as any).ade.pty.create).toHaveBeenCalledWith(
      expect.objectContaining({ laneId: "lane-1", title: "Shell" }),
    );
    expect(callOrder).not.toContain("focusSession");
    expect(callOrder).not.toContain("selectLane");
  });

  it("launchPtySession forwards CLI initial input fields from lane work panes", async () => {
    const { result } = renderHook(() => useLaneWorkSessions("lane-1"));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    await act(async () => {
      await result.current.launchPtySession({
        laneId: "lane-1",
        profile: "codex",
        title: "Prompt launch",
        startupCommand: "codex --no-alt-screen --model gpt-5.4",
        initialInput: "Print EXACT_CUA_526 and stop",
        initialInputDelayMs: 750,
      });
    });

    expect((window as any).ade.pty.create).toHaveBeenCalledWith(
      expect.objectContaining({
        laneId: "lane-1",
        title: "Prompt launch",
        toolType: "codex",
        startupCommand: "codex --no-alt-screen --model gpt-5.4",
        initialInput: "Print EXACT_CUA_526 and stop",
        initialInputDelayMs: 750,
      }),
    );
    expect((window as any).ade.pty.create.mock.calls.at(-1)?.[0]).not.toHaveProperty("awaitInitialInput");
  });

  it("launchPtySession applies orchestration role policy in lane work panes", async () => {
    const { result } = renderHook(() => useLaneWorkSessions("lane-1"));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    await act(async () => {
      await result.current.launchPtySession({
        laneId: "lane-1",
        profile: "codex",
        permissionMode: "plan",
        orchestrationRole: "worker",
      });
    });

    expect((window as any).ade.pty.create).toHaveBeenCalledWith(
      expect.objectContaining({
        laneId: "lane-1",
        toolType: "codex",
        startupCommand: expect.stringContaining("--dangerously-bypass-approvals-and-sandbox"),
      }),
    );
  });

  it("continues an ended agent CLI session from lane work panes", async () => {
    const closedCliSession = {
      ...makeSession("session-ended", "lane-1", "Ended Codex"),
      toolType: "codex",
      status: "completed",
      runtimeState: "exited",
      resumeCommand: "codex --no-alt-screen resume thread-1",
      resumeMetadata: {
        provider: "codex",
        targetKind: "thread",
        targetId: "thread-1",
        launch: { permissionMode: "default" },
        permissionMode: "default",
      },
    } as any;
    const resumedSession = {
      ...closedCliSession,
      ptyId: "pty-resumed",
      status: "running",
      runtimeState: "running",
      startedAt: "2026-05-01T12:01:00.000Z",
    };
    (window as any).ade.pty.sendToSession.mockResolvedValueOnce({
      sessionId: "session-ended",
      ptyId: "pty-resumed",
      pid: 123,
      session: resumedSession,
      resumed: true,
      reusedExistingRuntime: false,
    });
    listSessionsCachedMock
      .mockResolvedValueOnce([closedCliSession])
      .mockResolvedValueOnce([resumedSession]);

    const { result } = renderHook(() => useLaneWorkSessions("lane-1"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    await act(async () => {
      await result.current.continueCliSession(closedCliSession, "Print EXACT_RESUME_526 and stop");
    });

    expect((window as any).ade.pty.sendToSession).toHaveBeenCalledWith({
      sessionId: "session-ended",
      text: "Print EXACT_RESUME_526 and stop",
      cols: 100,
      rows: 30,
    });
    expect(selectLaneSpy).toHaveBeenCalledWith("lane-1");
    expect(focusSessionSpy).toHaveBeenCalledWith("session-ended");
    expect(setWorkViewStateSpy).toHaveBeenCalledWith("/fake/project", expect.any(Function));
    expect(result.current.sessions[0]).toEqual(expect.objectContaining({
      id: "session-ended",
      ptyId: "pty-resumed",
      status: "running",
    }));
  });
});
