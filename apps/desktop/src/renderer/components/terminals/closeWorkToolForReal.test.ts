/* @vitest-environment jsdom */

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../state/appStore";
import { closeWorkToolForReal } from "./closeWorkToolForReal";
import { useWorkSidebarTool } from "./useWorkSidebarTool";

const PROJECT_ROOT = "/repo";

function setProject(rootPath: string | null): void {
  useAppStore.setState({
    project: rootPath ? { rootPath, name: "Repo" } : null,
    projectBinding: null,
    workViewByProject: {},
    laneWorkViewByScope: {},
  } as never);
}

/** Dispatch is fire-and-forget; one macrotask drains the promise chain. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("closeWorkToolForReal", () => {
  beforeEach(() => {
    setProject(PROJECT_ROOT);
  });

  afterEach(() => {
    cleanup();
    setProject(null);
    delete (window as unknown as { ade?: unknown }).ade;
    vi.restoreAllMocks();
  });

  it("closing the browser tab closes its tabs", async () => {
    const closeTab = vi.fn(async () => ({}));
    const getStatus = vi.fn(async () => ({ tabs: [{ id: "tab-1" }, { id: "tab-2" }] }));
    (window as unknown as { ade: unknown }).ade = {
      builtInBrowser: { getStatus, closeTab },
    };

    closeWorkToolForReal("browser", { laneId: "lane-1", chatSessionId: "chat-1" });
    await flush();

    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(closeTab).toHaveBeenCalledTimes(2);
    expect(closeTab).toHaveBeenCalledWith({ tabId: "tab-1" }, undefined);
    expect(closeTab).toHaveBeenCalledWith({ tabId: "tab-2" }, undefined);
  });

  it("closing the mac-desktop tab stops the lane display", async () => {
    const stop = vi.fn(async () => ({ stopped: true, releasedWindows: 0 }));
    (window as unknown as { ade: unknown }).ade = { macDesktop: { stop } };

    closeWorkToolForReal("mac-desktop", { laneId: "lane-1", chatSessionId: "chat-1" });
    await flush();

    expect(stop).toHaveBeenCalledWith({ laneId: "lane-1", chatSessionId: "chat-1" }, undefined);
  });
});

describe("useWorkSidebarTool close-for-real failures", () => {
  beforeEach(() => {
    setProject(PROJECT_ROOT);
  });

  afterEach(() => {
    cleanup();
    setProject(null);
    delete (window as unknown as { ade?: unknown }).ade;
    vi.restoreAllMocks();
  });

  it("a failed close still removes the tab", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    (window as unknown as { ade: unknown }).ade = {
      appControl: { stop: vi.fn(() => Promise.reject(new Error("runtime refused"))) },
    };

    const { result, rerender } = renderHook(() => useWorkSidebarTool("lane-1", null, "chat-1"));
    act(() => result.current.setTool("app-control"));
    rerender();
    expect(result.current.openTools).toEqual(["app-control"]);

    act(() => result.current.closeTool("app-control"));
    rerender();

    // The strip is view state: the tab is gone before the runtime answers…
    expect(result.current.openTools).toEqual([]);
    expect(result.current.tool).toBe(null);
    await flush();
    // …and the rejected stop was logged, not thrown into the close path.
    expect(error).toHaveBeenCalled();
  });
});
