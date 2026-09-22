/* @vitest-environment jsdom */
// Mirror of lane mac-desktop (b18dd67ec) minus the mac-desktop tool; on merge, take theirs.

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

/** Dispatch is fire-and-forget; a couple of macrotasks drain the promise chain. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
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

  /*
   * `deviceStop`, not `shutdown`.
   *
   * `shutdown` ends this chat's SESSION — it releases the claim and stops the
   * stream, and leaves the simulator running. The tab-close dialog says
   * "Closing this tab powers off the simulator", so the verb has to be the one
   * that runs `simctl shutdown`. `deviceStop` releases the session on its way
   * past, so nothing is lost by calling it instead, and it is addressed by
   * LANE: the service resolves the lane's registered device first, which is
   * what makes a close arriving after the session was already released still
   * power off the right simulator.
   */
  it("closing the Apple tab stops this chat's stream, then powers the device off", async () => {
    const order: string[] = [];
    const stopStream = vi.fn(async () => {
      order.push("stopStream");
      return {} as never;
    });
    const deviceStop = vi.fn(async () => {
      order.push("deviceStop");
      return {} as never;
    });
    (window as unknown as { ade: unknown }).ade = { iosSimulator: { stopStream, deviceStop } };

    closeWorkToolForReal("ios", { laneId: "lane-1", chatSessionId: "chat-1" });
    await flush();

    expect(stopStream).toHaveBeenCalledWith(undefined, { laneId: "lane-1", chatSessionId: "chat-1" });
    expect(deviceStop).toHaveBeenCalledWith(
      { laneId: "lane-1", chatSessionId: "chat-1", ignoreOwnership: true },
      undefined,
    );
    // The encoder must stop before the device it is reading goes away.
    expect(order).toEqual(["stopStream", "deviceStop"]);
  });

  it("a stream stop that fails still powers the device off", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const deviceStop = vi.fn(async () => ({}) as never);
    (window as unknown as { ade: unknown }).ade = {
      iosSimulator: {
        stopStream: vi.fn(() => Promise.reject(new Error("no helper"))),
        deviceStop,
      },
    };

    closeWorkToolForReal("ios", { laneId: "lane-1", chatSessionId: "chat-1" });
    await flush();

    expect(deviceStop).toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
  });

  it("stands down entirely on a runtime with no power-off verb", async () => {
    // Older runtime, or a namespace stubbed by a surface that cannot reach the
    // device: the close must not half-run, stopping the stream and leaving the
    // simulator up with nothing on screen.
    const stopStream = vi.fn(async () => ({}) as never);
    (window as unknown as { ade: unknown }).ade = { iosSimulator: { stopStream } };
    closeWorkToolForReal("ios", { laneId: "lane-1", chatSessionId: "chat-1" });
    await flush();
    expect(stopStream).not.toHaveBeenCalled();
  });

  it("does nothing for a tool with nothing to stop", async () => {
    (window as unknown as { ade: unknown }).ade = { iosSimulator: { deviceStop: vi.fn() } };
    expect(() => closeWorkToolForReal("git", { laneId: "lane-1" })).not.toThrow();
    await flush();
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
