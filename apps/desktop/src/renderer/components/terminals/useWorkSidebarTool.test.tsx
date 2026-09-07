/* @vitest-environment jsdom */

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../../state/appStore";
import { useWorkSidebarTool, workToolScopeKey } from "./useWorkSidebarTool";
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

  it("builds a lane scope key only when both halves are present", () => {
    expect(workToolScopeKey(PROJECT_ROOT, "lane-1")).toBe("/repo::lane-1");
    expect(workToolScopeKey(PROJECT_ROOT, null)).toBe("");
    expect(workToolScopeKey(null, "lane-1")).toBe("");
    expect(workToolScopeKey("  ", " ")).toBe("");
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
