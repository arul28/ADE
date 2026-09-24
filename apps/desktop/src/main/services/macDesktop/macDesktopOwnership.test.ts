import { describe, expect, it } from "vitest";

import type { MacDesktopDisplay } from "../../../shared/types/macDesktop";
import {
  createMacDesktopOwnershipRegistry,
  MacDesktopOwnershipError,
} from "./macDesktopOwnership";

const display = (laneId: string): MacDesktopDisplay => ({
  laneId,
  displayId: 42,
  name: `ADE · ${laneId}`,
  mode: "virtual",
  width: 2560,
  height: 1440,
  scale: 2,
  origin: { x: 8000, y: 0 },
  createdAt: new Date(0).toISOString(),
  windowCount: 0,
  lastActivityAt: new Date(0).toISOString(),
});

describe("macDesktopOwnership", () => {
  it("tracks a lane's display and counts its windows", () => {
    const registry = createMacDesktopOwnershipRegistry();
    registry.setDisplay(display("lane-1"), "Login fix");
    registry.claimWindow({ laneId: "lane-1", windowId: 1, pid: 10, origin: "claimed" });
    registry.claimWindow({ laneId: "lane-1", windowId: 2, pid: 10, origin: "claimed" });
    expect(registry.getDisplay("lane-1")?.windowCount).toBe(2);
    expect(registry.laneForWindow(2)).toBe("lane-1");
  });

  it("refuses a second lane for a single-instance app and names the holder", () => {
    const registry = createMacDesktopOwnershipRegistry();
    registry.setDisplay(display("lane-1"));
    registry.setDisplay(display("lane-2"));
    registry.claimWindow({
      laneId: "lane-1",
      windowId: 1,
      pid: 10,
      bundleId: "com.apple.dt.Xcode",
      appName: "Xcode",
      origin: "claimed",
      singleInstance: true,
    });
    let thrown: unknown = null;
    try {
      registry.claimWindow({
        laneId: "lane-2",
        windowId: 2,
        pid: 10,
        bundleId: "com.apple.dt.Xcode",
        appName: "Xcode",
        origin: "claimed",
        singleInstance: true,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MacDesktopOwnershipError);
    const error = thrown as MacDesktopOwnershipError;
    expect(error.code).toBe("MAC_DESKTOP_APP_OWNED_BY_OTHER_LANE");
    expect(error.laneId).toBe("lane-1");
    expect(error.message).toContain("lane-1");
  });

  it("lets the holding lane claim more windows of the same app", () => {
    const registry = createMacDesktopOwnershipRegistry();
    registry.setDisplay(display("lane-1"));
    const claim = (windowId: number) => registry.claimWindow({
      laneId: "lane-1",
      windowId,
      pid: 10,
      bundleId: "com.apple.dt.Xcode",
      origin: "claimed",
      singleInstance: true,
    });
    claim(1);
    expect(() => claim(2)).not.toThrow();
    expect(registry.singleInstanceHolder("com.apple.dt.Xcode")).toBe("lane-1");
  });

  it("releases the app only when its last window leaves", () => {
    const registry = createMacDesktopOwnershipRegistry();
    registry.setDisplay(display("lane-1"));
    for (const windowId of [1, 2]) {
      registry.claimWindow({
        laneId: "lane-1",
        windowId,
        pid: 10,
        bundleId: "com.apple.dt.Xcode",
        origin: "claimed",
        singleInstance: true,
      });
    }
    registry.releaseWindow(1);
    expect(registry.singleInstanceHolder("com.apple.dt.Xcode")).toBe("lane-1");
    registry.releaseWindow(2);
    expect(registry.singleInstanceHolder("com.apple.dt.Xcode")).toBeNull();
  });

  it("forgets everything a removed lane held", () => {
    const registry = createMacDesktopOwnershipRegistry();
    registry.setDisplay(display("lane-1"));
    registry.claimWindow({
      laneId: "lane-1",
      windowId: 1,
      pid: 10,
      bundleId: "com.apple.dt.Xcode",
      origin: "ade_launched",
      singleInstance: true,
    });
    registry.watchLaunch({ laneId: "lane-1", pid: 10, target: "Xcode" });
    const removed = registry.removeDisplay("lane-1");
    expect(removed).toEqual({ removed: true, releasedWindows: 1 });
    expect(registry.getDisplay("lane-1")).toBeNull();
    expect(registry.singleInstanceHolder("com.apple.dt.Xcode")).toBeNull();
    expect(registry.watchedLaunch(10)).toBeNull();
  });

  it("drops claims for windows the driver no longer sees", () => {
    const registry = createMacDesktopOwnershipRegistry();
    registry.setDisplay(display("lane-1"));
    registry.claimWindow({ laneId: "lane-1", windowId: 1, pid: 10, origin: "claimed" });
    registry.claimWindow({ laneId: "lane-1", windowId: 2, pid: 10, origin: "claimed" });
    const result = registry.reconcileWindows("lane-1", [{
      id: 2,
      pid: 10,
      appName: "Preview",
      bundleId: null,
      title: null,
      frame: { x: 0, y: 0, width: 100, height: 100 },
      laneId: "lane-1",
      origin: "claimed",
      onDisplayId: 42,
      minimized: false,
      singleInstance: false,
    }]);
    expect(result.dropped).toBe(1);
    expect(registry.windowCount("lane-1")).toBe(1);
  });

  it("summarises every lane holding a display", () => {
    const registry = createMacDesktopOwnershipRegistry();
    registry.setDisplay(display("lane-1"), "Login fix");
    registry.setDisplay(display("lane-2"), null);
    const summaries = registry.laneSummaries((laneId) => laneId === "lane-1");
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toMatchObject({ laneId: "lane-1", laneName: "Login fix", streaming: true });
    expect(summaries[1]).toMatchObject({ laneId: "lane-2", laneName: null, streaming: false });
  });
});
