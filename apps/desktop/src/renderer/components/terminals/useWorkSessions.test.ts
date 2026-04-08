/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Spies used across all tests
// ---------------------------------------------------------------------------
const focusSessionSpy = vi.fn();
const selectLaneSpy = vi.fn();
const setWorkViewStateSpy = vi.fn();

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
  useNavigate: vi.fn(() => vi.fn()),
  useSearchParams: vi.fn(() => [new URLSearchParams(), vi.fn()]),
}));

vi.mock("../../state/appStore", () => ({
  useAppStore: vi.fn((selector: (state: Record<string, unknown>) => unknown) => {
    const fakeState: Record<string, unknown> = {
      project: { rootPath: "/fake/project" },
      lanes: [{ id: "lane-1", name: "Lane 1" }],
      focusSession: focusSessionSpy,
      focusedSessionId: null,
      selectLane: selectLaneSpy,
      workViewByProject: {},
      setWorkViewState: setWorkViewStateSpy,
    };
    return selector(fakeState);
  }),
}));

// ---------------------------------------------------------------------------
// Import the hook under test (after mocks are declared)
// ---------------------------------------------------------------------------
import { buildWorkTabGroupModel, useWorkSessions } from "./useWorkSessions";

// ---------------------------------------------------------------------------
// window.ade stubs
// ---------------------------------------------------------------------------

function installWindowAde() {
  (window as any).ade = {
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
    installWindowAde();
    listSessionsCachedMock.mockResolvedValue([]);
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
});

describe("useWorkSessions — grouping defaults and derived tab order", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installWindowAde();
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
