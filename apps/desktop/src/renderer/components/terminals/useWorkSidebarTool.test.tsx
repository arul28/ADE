/* @vitest-environment jsdom */

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenProjectBinding } from "../../../shared/types";
import type { ProductAnalyticsCapture } from "../../../shared/types/productAnalytics";
import { useAppStore } from "../../state/appStore";
import {
  closeWorkToolTab,
  openWorkToolTab,
  useWorkSidebarTool,
  WORK_TOOL_PUBLISH_DEBOUNCE_MS,
  workToolScopeKey,
} from "./useWorkSidebarTool";
import {
  askAppleShutdownConfirm,
  getAppleShutdownConfirmRequest,
  resetAppleShutdownConfirmForTests,
} from "../apple/AppleShutdownConfirm";
import {
  getMacDesktopStopConfirmRequest,
  resetMacDesktopStopConfirmForTests,
} from "../chat/MacDesktopStopConfirm";
import { resetMacDesktopStatusStoreForTests } from "../chat/macDesktopStatusStore";
import {
  clearPendingWorkToolRequest,
  requestWorkTool,
  resetWorkToolRequestsForTests,
  subscribeWorkToolRequests,
  takePendingWorkToolRequest,
} from "./workToolRequests";

const PROJECT_ROOT = "/repo";

function setProject(rootPath: string | null): void {
  useAppStore.setState({
    project: rootPath ? { rootPath, name: "Repo" } : null,
    projectBinding: null,
    workViewByProject: {},
    laneWorkViewByScope: {},
  } as never);
}

describe("useWorkSidebarTool", () => {
  beforeEach(() => {
    setProject(PROJECT_ROOT);
  });

  afterEach(() => {
    cleanup();
    setProject(null);
  });

  it("defaults to the picker and remembers a tool per lane", () => {
    const laneOne = renderHook(() => useWorkSidebarTool("lane-1"));
    const laneTwo = renderHook(() => useWorkSidebarTool("lane-2"));

    expect(laneOne.result.current.tool).toBe(null);
    expect(laneTwo.result.current.tool).toBe(null);

    act(() => laneOne.result.current.setTool("browser"));
    laneOne.rerender();
    laneTwo.rerender();

    expect(laneOne.result.current.tool).toBe("browser");
    // The point of the whole feature: the other lane is untouched.
    expect(laneTwo.result.current.tool).toBe(null);

    act(() => laneTwo.result.current.setTool("git"));
    laneOne.rerender();
    laneTwo.rerender();
    expect(laneOne.result.current.tool).toBe("browser");
    expect(laneTwo.result.current.tool).toBe("git");
  });

  it("returns to the picker when the tool is cleared", () => {
    const { result, rerender } = renderHook(() => useWorkSidebarTool("lane-1"));
    act(() => result.current.setTool("files"));
    rerender();
    expect(result.current.tool).toBe("files");

    act(() => result.current.setTool(null));
    rerender();
    expect(result.current.tool).toBe(null);
  });

  it("falls back to the project scope when no lane is bound", () => {
    const laneless = renderHook(() => useWorkSidebarTool(null));

    act(() => laneless.result.current.setTool("terminal"));
    laneless.rerender();

    expect(laneless.result.current.tool).toBe("terminal");
    expect(useAppStore.getState().getWorkViewState(PROJECT_ROOT).workSidebarTool).toBe("terminal");

    // A lane that has never chosen inherits the project-scoped answer rather
    // than showing an empty picker for a pane that clearly has a tool open.
    const lane = renderHook(() => useWorkSidebarTool("lane-fresh"));
    expect(lane.result.current.tool).toBe("terminal");
  });

  it("keeps a lane's explicit picker choice from falling back to the project scope", () => {
    const laneless = renderHook(() => useWorkSidebarTool(null));
    act(() => laneless.result.current.setTool("terminal"));

    const lane = renderHook(() => useWorkSidebarTool("lane-1"));
    act(() => lane.result.current.setTool(null));
    lane.rerender();

    expect(lane.result.current.tool).toBe(null);
  });

  it("reveals the pane whenever a tool is picked", () => {
    expect(useAppStore.getState().getWorkViewState(PROJECT_ROOT).workSidebarOpen).toBe(false);

    const { result } = renderHook(() => useWorkSidebarTool("lane-1"));
    act(() => result.current.setTool("git"));

    expect(useAppStore.getState().getWorkViewState(PROJECT_ROOT).workSidebarOpen).toBe(true);
  });

  it("writes nothing when there is no project to scope to", () => {
    setProject(null);
    const { result } = renderHook(() => useWorkSidebarTool("lane-1"));
    act(() => result.current.setTool("git"));
    expect(result.current.tool).toBe(null);
    expect(useAppStore.getState().laneWorkViewByScope).toEqual({});
  });

  it("opens each picked tool as a tab and keeps the strip's order", () => {
    const { result, rerender } = renderHook(() => useWorkSidebarTool("lane-1"));

    act(() => result.current.setTool("terminal"));
    rerender();
    act(() => result.current.setTool("browser"));
    rerender();
    expect(result.current.openTools).toEqual(["terminal", "browser"]);

    // Re-picking an open tool activates its tab where it already is; a strip
    // that reshuffled would make the tabs jump every time you came back.
    act(() => result.current.setTool("terminal"));
    rerender();
    expect(result.current.openTools).toEqual(["terminal", "browser"]);
    expect(result.current.tool).toBe("terminal");
  });

  it("keeps the strip open when the picker page is shown", () => {
    const { result, rerender } = renderHook(() => useWorkSidebarTool("lane-1"));
    act(() => result.current.setTool("git"));
    rerender();

    act(() => result.current.setTool(null));
    rerender();
    expect(result.current.tool).toBe(null);
    expect(result.current.openTools).toEqual(["git"]);
  });

  it("activates the neighbour when the tab on screen is closed", () => {
    const { result, rerender } = renderHook(() => useWorkSidebarTool("lane-1"));
    for (const tool of ["terminal", "browser", "git"] as const) {
      act(() => result.current.setTool(tool));
      rerender();
    }

    act(() => result.current.setTool("browser"));
    rerender();
    act(() => result.current.closeTool("browser"));
    rerender();
    // The tab to the RIGHT inherits.
    expect(result.current.openTools).toEqual(["terminal", "git"]);
    expect(result.current.tool).toBe("git");

    // Closing the last one falls back to the left, then to the picker.
    act(() => result.current.closeTool("git"));
    rerender();
    expect(result.current.tool).toBe("terminal");
    act(() => result.current.closeTool("terminal"));
    rerender();
    expect(result.current.tool).toBe(null);
    expect(result.current.openTools).toEqual([]);
  });

  it("leaves the tool on screen alone when a background tab is closed", () => {
    const { result, rerender } = renderHook(() => useWorkSidebarTool("lane-1"));
    act(() => result.current.setTool("terminal"));
    rerender();
    act(() => result.current.setTool("git"));
    rerender();

    act(() => result.current.closeTool("terminal"));
    rerender();
    expect(result.current.tool).toBe("git");
    expect(result.current.openTools).toEqual(["git"]);
  });

  it("repairs an empty strip around the tool the lane is already showing", () => {
    // Not the persisted-state migration — `appStore.test.ts` owns that. This is
    // the same shape arriving at runtime: an active tool with an empty strip,
    // which the hook must not render as a pane with no tab for what is on it.
    useAppStore.getState().setLaneWorkViewState(PROJECT_ROOT, "lane-old", {
      workSidebarTool: "files",
      workSidebarOpenTools: [],
    });
    const { result } = renderHook(() => useWorkSidebarTool("lane-old"));
    expect(result.current.tool).toBe("files");
    expect(result.current.openTools).toEqual(["files"]);
  });

  /*
   * Round 4 §B3. Closing the Apple tab powers the simulator off, so the strip
   * write waits for an answer — and Cancel has to keep the TAB, not just the
   * device, which is why the gate is here and not in `closeWorkToolForReal`.
   */
  describe("closing the Apple tab", () => {
    const BOOTED = {
      lane: { udid: "UDID-1", name: "ADE Repro", runtime: "iOS 26.2", family: "iphone" },
      installed: [{ udid: "UDID-1", state: "Booted" }],
    };

    function installSimulator(listed: unknown) {
      // `deviceStop` is the verb that runs `simctl shutdown`; `shutdown` only
      // ends this chat's session and leaves the simulator running, which would
      // make the dialog's "powers off the simulator" a lie.
      const deviceStop = vi.fn(async () => undefined);
      const stopStream = vi.fn(async () => undefined);
      (window as unknown as { ade: unknown }).ade = {
        iosSimulator: {
          deviceList: vi.fn(async () => listed),
          deviceStop,
          stopStream,
        },
      };
      return { deviceStop, stopStream };
    }

    afterEach(() => {
      resetAppleShutdownConfirmForTests();
      (window as unknown as { ade?: unknown }).ade = undefined;
    });

    async function openIosTab() {
      const view = renderHook(() => useWorkSidebarTool("lane-1", null, "chat-1"));
      await act(async () => { view.result.current.setTool("ios"); });
      view.rerender();
      expect(view.result.current.openTools).toEqual(["ios"]);
      return view;
    }

    it("asks before it closes, and keeps the tab when the answer is Cancel", async () => {
      const { deviceStop } = installSimulator(BOOTED);
      const view = await openIosTab();

      await act(async () => { view.result.current.closeTool("ios"); });
      view.rerender();
      // Still open: the question is on screen and has not been answered.
      expect(view.result.current.openTools).toEqual(["ios"]);
      expect(getAppleShutdownConfirmRequest()?.deviceName).toBe("ADE Repro");
      expect(deviceStop).not.toHaveBeenCalled();

      await act(async () => { getAppleShutdownConfirmRequest()?.resolve(false); });
      view.rerender();
      expect(view.result.current.openTools).toEqual(["ios"]);
      expect(view.result.current.tool).toBe("ios");
      expect(deviceStop).not.toHaveBeenCalled();
    });

    it("drops the tab and powers the device off when the answer is Close and shut down", async () => {
      const { deviceStop, stopStream } = installSimulator(BOOTED);
      const view = await openIosTab();

      await act(async () => { view.result.current.closeTool("ios"); });
      await act(async () => { getAppleShutdownConfirmRequest()?.resolve(true); });
      view.rerender();
      expect(view.result.current.openTools).toEqual([]);
      expect(view.result.current.tool).toBe(null);
      // The lease goes back before the power does.
      await vi.waitFor(() => expect(stopStream).toHaveBeenCalled());
      await vi.waitFor(() => expect(deviceStop).toHaveBeenCalledWith(
        { laneId: "lane-1", chatSessionId: "chat-1", ignoreOwnership: true },
        undefined,
      ));
    });

    it("asks nothing at all when the lane's device is not booted", async () => {
      const { deviceStop } = installSimulator({ ...BOOTED, installed: [{ udid: "UDID-1", state: "Shutdown" }] });
      const view = await openIosTab();
      await act(async () => { view.result.current.closeTool("ios"); });
      view.rerender();
      expect(getAppleShutdownConfirmRequest()).toBeNull();
      expect(view.result.current.openTools).toEqual([]);
      await vi.waitFor(() => expect(deviceStop).toHaveBeenCalled());
    });

    it("never asks for any other tool", async () => {
      installSimulator(BOOTED);
      const view = renderHook(() => useWorkSidebarTool("lane-1", null, "chat-1"));
      await act(async () => { view.result.current.setTool("browser"); });
      view.rerender();
      act(() => { view.result.current.closeTool("browser"); });
      view.rerender();
      // Closed on the spot, with no question in flight.
      expect(view.result.current.openTools).toEqual([]);
      expect(getAppleShutdownConfirmRequest()).toBeNull();
    });

    it("does not stack a second question while one is unanswered", async () => {
      installSimulator(BOOTED);
      const view = await openIosTab();
      void askAppleShutdownConfirm("Someone else");
      await act(async () => { view.result.current.closeTool("ios"); });
      view.rerender();
      // Refused rather than queued, and the tab stays.
      expect(getAppleShutdownConfirmRequest()?.deviceName).toBe("Someone else");
      expect(view.result.current.openTools).toEqual(["ios"]);
    });
  });

  /*
   * Closing the Mac Desktop tab stops the lane's display, so it asks first
   * while one runs. "Keep running" closes the tab and leaves the display up;
   * Cancel keeps both.
   */
  describe("closing the Mac Desktop tab", () => {
    const LIVE = { display: { laneId: "lane-1", displayId: 31 }, windows: [] };

    function installMacDesktop(status: unknown) {
      const stop = vi.fn(async () => ({ stopped: true, releasedWindows: 0 }));
      const getStatus = vi.fn(async () => status);
      (window as unknown as { ade: unknown }).ade = { macDesktop: { getStatus, stop } };
      return { stop, getStatus };
    }

    afterEach(() => {
      resetMacDesktopStopConfirmForTests();
      resetMacDesktopStatusStoreForTests();
      (window as unknown as { ade?: unknown }).ade = undefined;
    });

    async function openMacDesktopTab() {
      const view = renderHook(() => useWorkSidebarTool("lane-1", null, "chat-1"));
      await act(async () => { view.result.current.setTool("mac-desktop"); });
      view.rerender();
      expect(view.result.current.openTools).toEqual(["mac-desktop"]);
      return view;
    }

    it("asks while a display runs, and Cancel keeps the tab and the display", async () => {
      const { stop } = installMacDesktop(LIVE);
      const view = await openMacDesktopTab();

      await act(async () => { view.result.current.closeTool("mac-desktop"); });
      view.rerender();
      expect(getMacDesktopStopConfirmRequest()).not.toBeNull();
      expect(view.result.current.openTools).toEqual(["mac-desktop"]);

      await act(async () => { getMacDesktopStopConfirmRequest()?.resolve("cancel"); });
      view.rerender();
      expect(view.result.current.openTools).toEqual(["mac-desktop"]);
      expect(stop).not.toHaveBeenCalled();
    });

    it("Stop closes the tab and stops the display", async () => {
      const { stop } = installMacDesktop(LIVE);
      const view = await openMacDesktopTab();

      await act(async () => { view.result.current.closeTool("mac-desktop"); });
      await act(async () => { getMacDesktopStopConfirmRequest()?.resolve("stop"); });
      view.rerender();
      expect(view.result.current.openTools).toEqual([]);
      await vi.waitFor(() => expect(stop).toHaveBeenCalledWith(
        { laneId: "lane-1", chatSessionId: "chat-1" },
        undefined,
      ));
    });

    it("Keep running closes the tab and leaves the display up", async () => {
      const { stop } = installMacDesktop(LIVE);
      const view = await openMacDesktopTab();

      await act(async () => { view.result.current.closeTool("mac-desktop"); });
      await act(async () => { getMacDesktopStopConfirmRequest()?.resolve("keep"); });
      view.rerender();
      expect(view.result.current.openTools).toEqual([]);
      expect(stop).not.toHaveBeenCalled();
    });

    it("asks nothing when the lane has no display", async () => {
      const { stop } = installMacDesktop({ display: null, windows: [] });
      const view = await openMacDesktopTab();

      await act(async () => { view.result.current.closeTool("mac-desktop"); });
      view.rerender();
      expect(getMacDesktopStopConfirmRequest()).toBeNull();
      expect(view.result.current.openTools).toEqual([]);
      await vi.waitFor(() => expect(stop).toHaveBeenCalled());
    });
  });

  it("builds a lane scope key only when both halves are present", () => {
    expect(workToolScopeKey(PROJECT_ROOT, "lane-1")).toBe("/repo::lane-1");
    expect(workToolScopeKey(PROJECT_ROOT, null)).toBe("");
    expect(workToolScopeKey(null, "lane-1")).toBe("");
    expect(workToolScopeKey("  ", " ")).toBe("");
  });
});

describe("work tool strip arithmetic", () => {
  it("appends on open and never moves a tab that is already there", () => {
    expect(openWorkToolTab([], "git")).toEqual(["git"]);
    expect(openWorkToolTab(["git", "files"], "browser")).toEqual(["git", "files", "browser"]);
    expect(openWorkToolTab(["git", "files"], "git")).toEqual(["git", "files"]);
  });

  it("hands the active tab to its right neighbour, then its left, then the picker", () => {
    expect(closeWorkToolTab(["git", "files", "ios"], "files", "files"))
      .toEqual({ openTools: ["git", "ios"], activeTool: "ios" });
    expect(closeWorkToolTab(["git", "files"], "files", "files"))
      .toEqual({ openTools: ["git"], activeTool: "git" });
    expect(closeWorkToolTab(["git"], "git", "git"))
      .toEqual({ openTools: [], activeTool: null });
  });

  it("is a no-op for a tab that is not in the strip", () => {
    expect(closeWorkToolTab(["git"], "git", "files"))
      .toEqual({ openTools: ["git"], activeTool: "git" });
  });
});

describe("workToolRequests", () => {
  afterEach(() => {
    resetWorkToolRequestsForTests();
  });

  it("delivers to a live listener and holds for one that mounts later", () => {
    const seen: Array<string | null> = [];
    const unsubscribe = subscribeWorkToolRequests((request) => seen.push(request.tool));

    requestWorkTool("browser");
    expect(seen).toEqual(["browser"]);

    // A listener that already handled the broadcast clears the hold, so the
    // next Work page to mount does not reopen a tool nobody asked for.
    clearPendingWorkToolRequest();
    expect(takePendingWorkToolRequest()).toBe(null);

    unsubscribe();
    requestWorkTool("git");
    expect(seen).toEqual(["browser"]);
    expect(takePendingWorkToolRequest()?.tool).toBe("git");
    expect(takePendingWorkToolRequest()).toBe(null);
  });

  it("carries a picker request", () => {
    requestWorkTool(null);
    const pending = takePendingWorkToolRequest();
    expect(pending?.tool).toBe(null);
    expect(pending?.nonce).toBeTruthy();
  });
});

describe("Work tool analytics", () => {
  // Typed with the real preload signature so `mock.calls[0][0]` is the
  // analytics payload rather than an untyped empty tuple.
  const capture = vi.fn(async (_input: Omit<ProductAnalyticsCapture, "surface">) => undefined);

  beforeEach(() => {
    capture.mockClear();
    setProject(PROJECT_ROOT);
    (window as unknown as { ade: unknown }).ade = { analytics: { capture } };
  });

  afterEach(() => {
    cleanup();
    setProject(null);
    delete (window as unknown as { ade?: unknown }).ade;
  });

  it("reports which tool was opened, coarsely and once a day per tool", () => {
    const { result } = renderHook(() => useWorkSidebarTool("lane-1"));

    act(() => result.current.setTool("app-control"));

    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith({
      event: "ade_feature_used",
      properties: {
        feature: "work",
        action: "tool_opened",
        // Hyphenated ids are normalized so the value stays inside the closed
        // `outcome` allowlist rather than arriving as a new spelling.
        outcome: "tool_app_control",
        source: "renderer_route",
      },
      dedupeKey: "work_tool_opened:app-control",
      minimumIntervalMs: 24 * 60 * 60_000,
    });
    // Nothing about WHAT was being worked on crosses the boundary.
    const sent = JSON.stringify(capture.mock.calls[0]![0]);
    expect(sent).not.toContain("lane-1");
    expect(sent).not.toContain(PROJECT_ROOT);
  });

  it("says nothing when the pane goes back to the picker", () => {
    const { result } = renderHook(() => useWorkSidebarTool("lane-1"));

    act(() => result.current.setTool("browser"));
    capture.mockClear();

    // Returning to the picker is not a tool: counting it would report closing
    // as engagement and would double every open/close pair.
    act(() => result.current.setTool(null));
    expect(capture).not.toHaveBeenCalled();
    expect(result.current.tool).toBe(null);

    // Re-opening the same tool still goes through the same dedupe key, so the
    // service — not this call site — is what bounds a flick through the picker.
    act(() => result.current.setTool("browser"));
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0]![0]).toMatchObject({ dedupeKey: "work_tool_opened:browser" });
  });
});

describe("work tool runtime publish", () => {
  const setActiveTool = vi.fn(async () => undefined);
  const studioPin: OpenProjectBinding = {
    kind: "remote",
    key: "remote:target-studio:project-a",
    targetId: "target-studio",
    projectId: "project-a",
    rootPath: "/remote/repo",
    displayName: "repo",
    runtimeName: "Mac Studio",
  };

  beforeEach(() => {
    vi.useFakeTimers();
    setActiveTool.mockClear();
    setProject(PROJECT_ROOT);
    (window as unknown as { ade: unknown }).ade = { workTools: { setActiveTool } };
  });

  afterEach(() => {
    cleanup();
    setProject(null);
    delete (window as unknown as { ade?: unknown }).ade;
    vi.useRealTimers();
  });

  it("publishes the focused chat's pin so the phone mirrors that machine", () => {
    const { result } = renderHook(() => useWorkSidebarTool("lane-studio", studioPin));
    act(() => result.current.setTool("git"));
    act(() => {
      vi.advanceTimersByTime(WORK_TOOL_PUBLISH_DEBOUNCE_MS);
    });
    expect(setActiveTool).toHaveBeenCalledWith("lane-studio", "git", ["git"], studioPin);
  });

  it("retries once without the active tool when an older runtime rejects it", async () => {
    setActiveTool.mockImplementationOnce(async () => {
      throw new Error('work_tools.setActiveTool got an unknown tool "pr".');
    });
    const { result } = renderHook(() => useWorkSidebarTool("lane-studio", studioPin));
    act(() => result.current.setTool("git"));
    act(() => result.current.setTool("pr"));
    await act(async () => {
      vi.advanceTimersByTime(WORK_TOOL_PUBLISH_DEBOUNCE_MS);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(setActiveTool.mock.calls).toEqual([
      ["lane-studio", "pr", ["git", "pr"], studioPin],
      ["lane-studio", null, ["git", "pr"], studioPin],
    ]);
  });

  it("does not retry without the tool when the publish fails for another reason", async () => {
    setActiveTool.mockImplementationOnce(async () => {
      throw new Error("runtime unavailable");
    });
    const { result } = renderHook(() => useWorkSidebarTool("lane-studio", studioPin));
    act(() => result.current.setTool("git"));
    await act(async () => {
      vi.advanceTimersByTime(WORK_TOOL_PUBLISH_DEBOUNCE_MS);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(setActiveTool.mock.calls).toEqual([["lane-studio", "git", ["git"], studioPin]]);
  });

  it("does not retry a rejected publish that already had no active tool", async () => {
    setActiveTool.mockImplementation(async () => {
      throw new Error("runtime unavailable");
    });
    try {
      renderHook(() => useWorkSidebarTool("lane-studio", studioPin));
      await act(async () => {
        vi.advanceTimersByTime(WORK_TOOL_PUBLISH_DEBOUNCE_MS);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(setActiveTool).toHaveBeenCalledTimes(1);
      expect((setActiveTool.mock.calls[0] as unknown[] | undefined)?.[1]).toBeNull();
    } finally {
      setActiveTool.mockImplementation(async () => undefined);
    }
  });

  it("stores lane tool tabs on the session machine after the tab dropdown moves", () => {
    useAppStore.setState({
      project: { rootPath: PROJECT_ROOT, name: "Repo" },
      projectBinding: {
        kind: "local",
        key: "local:/repo",
        rootPath: PROJECT_ROOT,
        displayName: "MacBook",
      },
    } as never);
    const { result, rerender } = renderHook(() => useWorkSidebarTool("lane-studio", studioPin));
    act(() => result.current.setTool("git"));
    rerender();

    const studioScope = workToolScopeKey(studioPin.key, "lane-studio");
    const tabScope = workToolScopeKey(PROJECT_ROOT, "lane-studio");
    expect(useAppStore.getState().laneWorkViewByScope[studioScope]?.workSidebarTool).toBe("git");
    expect(useAppStore.getState().laneWorkViewByScope[tabScope]).toBeUndefined();

    useAppStore.setState({
      projectBinding: {
        kind: "local",
        key: "local:/repo",
        rootPath: PROJECT_ROOT,
        displayName: "MacBook",
      },
    } as never);
    act(() => result.current.setTool("terminal"));
    rerender();
    expect(result.current.tool).toBe("terminal");
    expect(result.current.openTools).toEqual(["git", "terminal"]);
    expect(useAppStore.getState().laneWorkViewByScope[studioScope]?.workSidebarOpenTools)
      .toEqual(["git", "terminal"]);
    expect(useAppStore.getState().laneWorkViewByScope[tabScope]).toBeUndefined();
  });
});
