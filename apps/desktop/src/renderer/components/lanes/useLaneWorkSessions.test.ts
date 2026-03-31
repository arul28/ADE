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

// ---------------------------------------------------------------------------
// Module-level mocks (hoisted by vitest)
// ---------------------------------------------------------------------------

const listSessionsCachedMock = vi.fn().mockResolvedValue([]);

vi.mock("../../lib/sessionListCache", () => ({
  listSessionsCached: (...args: unknown[]) => listSessionsCachedMock(...args),
}));

vi.mock("../../lib/chatSessionEvents", () => ({
  shouldRefreshSessionListForChatEvent: vi.fn(() => false),
}));

vi.mock("../../lib/terminalAttention", () => ({
  sessionStatusBucket: vi.fn(() => "ended"),
}));

vi.mock("../../lib/sessions", () => ({
  isRunOwnedSession: vi.fn(() => false),
}));

vi.mock("../../state/appStore", () => ({
  useAppStore: vi.fn((selector: (state: Record<string, unknown>) => unknown) => {
    const fakeState: Record<string, unknown> = {
      project: { rootPath: "/fake/project" },
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
}));

// ---------------------------------------------------------------------------
// Import the hook under test (after mocks are declared)
// ---------------------------------------------------------------------------
import { useLaneWorkSessions } from "./useLaneWorkSessions";

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
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useLaneWorkSessions — refresh-before-focus ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installWindowAde();
    // Default: instant resolve for mount-time refresh calls
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

    // refresh-start should be recorded but NOT focusSession yet
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

  // -----------------------------------------------------------------------
  // handleOpenChatSession: refresh() must complete before focusSession / openSessionTab
  // -----------------------------------------------------------------------
  it("handleOpenChatSession: awaits refresh() before calling focusSession and openSessionTab", async () => {
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
    let handlePromise!: Promise<void>;
    act(() => {
      handlePromise = result.current.handleOpenChatSession("session-abc");
    });

    // Give the async function a tick
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    // refresh-start should be recorded, focusSession NOT yet
    expect(callOrder).toContain("refresh-start");
    expect(callOrder).not.toContain("focusSession");
    expect(callOrder).not.toContain("openSessionTab");

    // Resolve the refresh
    await act(async () => {
      expect(refreshResolve).not.toBeNull();
      refreshResolve!();
      await handlePromise;
    });

    // Verify ordering
    const refreshDoneIdx = callOrder.indexOf("refresh-done");
    const focusIdx = callOrder.indexOf("focusSession");
    const openTabIdx = callOrder.indexOf("openSessionTab");

    expect(refreshDoneIdx).toBeGreaterThanOrEqual(0);
    expect(focusIdx).toBeGreaterThanOrEqual(0);
    expect(openTabIdx).toBeGreaterThanOrEqual(0);
    expect(refreshDoneIdx).toBeLessThan(focusIdx);
    expect(refreshDoneIdx).toBeLessThan(openTabIdx);
  });
});
