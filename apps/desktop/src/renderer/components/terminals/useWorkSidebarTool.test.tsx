/* @vitest-environment jsdom */

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProductAnalyticsCapture } from "../../../shared/types/productAnalytics";
import { useAppStore } from "../../state/appStore";
import {
  closeWorkToolTab,
  openWorkToolTab,
  useWorkSidebarTool,
  workToolScopeKey,
} from "./useWorkSidebarTool";
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

  it("migrates a lane that only ever stored one tool into a one-tab strip", () => {
    // Exactly the shape a pre-strip build persisted: an active tool and no
    // `workSidebarOpenTools` at all.
    useAppStore.getState().setLaneWorkViewState(PROJECT_ROOT, "lane-old", {
      workSidebarTool: "files",
      workSidebarOpenTools: [],
    } as never);
    const { result } = renderHook(() => useWorkSidebarTool("lane-old"));
    expect(result.current.tool).toBe("files");
    expect(result.current.openTools).toEqual(["files"]);
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
