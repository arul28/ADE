import { describe, expect, it } from "vitest";

import type {
  MacDesktopDisplay,
  MacDesktopEventPayload,
  MacDesktopStatus,
  MacDesktopWindow,
} from "../../../shared/types/macDesktop";
import {
  MAC_DESKTOP_NOT_PARKED_RETRY_GRACE_MS,
  macDesktopNotParkedPhrase,
  macDesktopVisibleNotParked,
  reduceMacDesktopNotParked,
} from "../../../shared/types/macDesktop";
import {
  macDesktopCursorFromEvent,
  reduceMacDesktopStatus,
} from "./useMacDesktopStatus";

const display = (laneId: string): MacDesktopDisplay => ({
  laneId,
  displayId: 7,
  width: 2560,
  height: 1440,
  scale: 2,
  origin: { x: 0, y: 0 },
  createdAt: "2026-01-01T00:00:00.000Z",
} as unknown as MacDesktopDisplay);

const window0 = (id: number): MacDesktopWindow => ({
  id,
  appName: "Safari",
  title: "ADE",
  onDisplayId: 7,
} as unknown as MacDesktopWindow);

const baseStatus = (): MacDesktopStatus => ({
  platform: "darwin",
  supported: true,
  unsupportedReason: null,
  driver: { running: true } as unknown as MacDesktopStatus["driver"],
  permissions: {
    screenRecording: "granted",
    accessibility: "granted",
  } as unknown as MacDesktopStatus["permissions"],
  displayMode: "virtual" as MacDesktopStatus["displayMode"],
  display: display("lane-1"),
  windows: [],
  lease: null,
  stream: null,
  recording: null,
  lanes: [],
  hostIsLocal: true,
  responsibleAppName: "ADE",
  signing: "identity",
});

describe("reduceMacDesktopStatus", () => {
  it("drops every event until the first status read has landed", () => {
    expect(reduceMacDesktopStatus(null, { type: "display-created", display: display("lane-1") }, "lane-1"))
      .toBeNull();
  });

  it("ignores another lane's events by identity, so nothing re-renders", () => {
    const status = baseStatus();
    const events: MacDesktopEventPayload[] = [
      { type: "display-created", display: display("lane-2") },
      { type: "display-destroyed", laneId: "lane-2", reason: "stopped" },
      { type: "windows-changed", laneId: "lane-2", windows: [window0(1)] },
      { type: "lease-changed", laneId: "lane-2", lease: null },
    ];
    for (const event of events) {
      expect(reduceMacDesktopStatus(status, event, "lane-1")).toBe(status);
    }
  });

  it("takes this lane's display, windows and lease", () => {
    const status = baseStatus();
    const created = reduceMacDesktopStatus(status, {
      type: "display-created",
      display: display("lane-1"),
    }, "lane-1");
    expect(created?.display?.laneId).toBe("lane-1");

    const windows = reduceMacDesktopStatus(status, {
      type: "windows-changed",
      laneId: "lane-1",
      windows: [window0(3)],
    }, "lane-1");
    expect(windows?.windows).toHaveLength(1);

    const lease = reduceMacDesktopStatus(status, {
      type: "lease-changed",
      laneId: "lane-1",
      lease: { holder: "user", holderId: "ade-window:1" } as never,
    }, "lane-1");
    expect(lease?.lease).toEqual({ holder: "user", holderId: "ade-window:1" });
  });

  it("clears the windows when this lane's display goes away", () => {
    const status = { ...baseStatus(), windows: [window0(1)] };
    const next = reduceMacDesktopStatus(status, {
      type: "display-destroyed",
      laneId: "lane-1",
      reason: "stopped",
    }, "lane-1");
    expect(next?.display).toBeNull();
    expect(next?.windows).toEqual([]);
  });

  it("flattens every stream event into the redacted summary", () => {
    const status = baseStatus();
    const next = reduceMacDesktopStatus(status, {
      type: "stream-error",
      status: {
        laneId: "lane-1",
        running: false,
        idle: true,
        fps: 3,
        bitrateKbps: 120,
        lastError: "encoder died",
      } as never,
    }, "lane-1");
    expect(next?.stream).toEqual({
      running: false,
      idle: true,
      fps: 3,
      bitrateKbps: 120,
      lastError: "encoder died",
    });
    // A stream event for another lane must not overwrite this one's.
    expect(reduceMacDesktopStatus(status, {
      type: "stream-status",
      status: { laneId: "lane-2", running: true } as never,
    }, "lane-1")).toBe(status);
  });

  it("takes host-wide permission and driver news whatever lane it came with", () => {
    const status = baseStatus();
    const denied = reduceMacDesktopStatus(status, {
      type: "permission-changed",
      permissions: { screenRecording: "denied", accessibility: "granted" } as never,
    }, "lane-1");
    expect(denied?.permissions.screenRecording).toBe("denied");

    const health = reduceMacDesktopStatus(status, {
      type: "driver-health",
      health: { running: false } as never,
    }, "lane-1");
    expect(health?.driver).toEqual({ running: false });
  });

  it("leaves the status alone for events it does not carry", () => {
    const status = baseStatus();
    expect(reduceMacDesktopStatus(status, {
      type: "window-not-parked",
      laneId: "lane-1",
      windowId: 2,
      reason: "denied",
    }, "lane-1")).toBe(status);
  });
});

describe("reduceMacDesktopNotParked", () => {
  const stranded = (windowId: number, reason = "not_ready"): MacDesktopEventPayload => ({
    type: "window-not-parked",
    laneId: "lane-1",
    windowId,
    reason,
  });
  const parkedWindow = (id: number, laneId: string | null): MacDesktopWindow => ({
    id,
    appName: "Safari",
    title: "ADE",
    laneId,
    onDisplayId: laneId ? 7 : null,
  } as unknown as MacDesktopWindow);

  it("keeps the three newest, newest first, one entry per window", () => {
    let list = reduceMacDesktopNotParked([], stranded(1), "lane-1", 1_000);
    list = reduceMacDesktopNotParked(list, stranded(2), "lane-1", 2_000);
    list = reduceMacDesktopNotParked(list, stranded(3), "lane-1", 3_000);
    list = reduceMacDesktopNotParked(list, stranded(4), "lane-1", 4_000);
    expect(list.map((entry) => entry.windowId)).toEqual([4, 3, 2]);
    expect(list[0]).toEqual({ windowId: 4, reason: "not_ready", at: 4_000, firstSeenAt: 4_000 });

    // A retry on a window already in the list replaces it with the newest
    // reason rather than filling the list with one window's history — and keeps
    // the streak's start, which is what the grace window is measured against.
    const retried = reduceMacDesktopNotParked(list, stranded(3, "denied"), "lane-1", 5_000);
    expect(retried.map((entry) => entry.windowId)).toEqual([3, 4, 2]);
    expect(retried[0]?.reason).toBe("denied");
    expect(retried[0]).toMatchObject({ at: 5_000, firstSeenAt: 3_000 });
  });

  it("drops a window a later windows-changed shows parked, and one it no longer lists", () => {
    let list = reduceMacDesktopNotParked([], stranded(1), "lane-1", 1_000);
    list = reduceMacDesktopNotParked(list, stranded(2), "lane-1", 2_000);
    list = reduceMacDesktopNotParked(list, stranded(3), "lane-1", 3_000);
    const after = reduceMacDesktopNotParked(list, {
      type: "windows-changed",
      laneId: "lane-1",
      // Window 2 landed. Window 1 came back in the list with no lane, which is
      // a window still loose on the human's own screen — it stays reported.
      // Window 3 is not in the list at all: it closed, and a warning about a
      // window that no longer exists is pure noise.
      windows: [parkedWindow(2, "lane-1"), parkedWindow(1, null)],
    }, "lane-1", 4_000);
    expect(after.map((entry) => entry.windowId)).toEqual([1]);
  });

  it("returns the same array when nothing changed, and clears with the display", () => {
    const list = reduceMacDesktopNotParked([], stranded(1), "lane-1", 1_000);
    // Another lane's news has to be identity-stable or the panel re-renders per
    // event.
    expect(reduceMacDesktopNotParked(list, stranded(9), "lane-2", 2_000)).toBe(list);
    expect(reduceMacDesktopNotParked(list, {
      type: "lease-changed",
      laneId: "lane-1",
      lease: null,
    }, "lane-1", 2_000)).toBe(list);
    expect(reduceMacDesktopNotParked(list, {
      type: "windows-changed",
      laneId: "lane-1",
      windows: [parkedWindow(1, null)],
    }, "lane-1", 2_000)).toBe(list);

    // The display is gone, so nothing is waiting to land on it.
    expect(reduceMacDesktopNotParked(list, {
      type: "display-destroyed",
      laneId: "lane-1",
      reason: "stopped",
    }, "lane-1", 2_000)).toEqual([]);
    expect(reduceMacDesktopNotParked([], {
      type: "display-destroyed",
      laneId: "lane-1",
      reason: "stopped",
    }, "lane-1", 2_000)).toEqual([]);
  });
});

describe("macDesktopVisibleNotParked", () => {
  const stranded = (windowId: number, reason: string): MacDesktopEventPayload => ({
    type: "window-not-parked",
    laneId: "lane-1",
    windowId,
    reason,
  });

  it("hides a retry in progress and shows it once it outlives the grace window", () => {
    // The bug this fixes: a TextEdit service window reports `not_ready` once and
    // is gone a moment later. Showing it accused the user of a stranded window
    // they never had.
    const list = reduceMacDesktopNotParked([], stranded(33_976, "not_ready"), "lane-1", 1_000);
    expect(macDesktopVisibleNotParked(list, 1_100)).toEqual([]);
    expect(macDesktopVisibleNotParked(list, 1_000 + MAC_DESKTOP_NOT_PARKED_RETRY_GRACE_MS)).toEqual([]);
    expect(macDesktopVisibleNotParked(list, 1_000 + MAC_DESKTOP_NOT_PARKED_RETRY_GRACE_MS + 1))
      .toHaveLength(1);
  });

  it("keeps a retrying window's original start, so retries cannot postpone it forever", () => {
    let list = reduceMacDesktopNotParked([], stranded(7, "not_ready"), "lane-1", 1_000);
    list = reduceMacDesktopNotParked(list, stranded(7, "not_ready"), "lane-1", 5_000);
    list = reduceMacDesktopNotParked(list, stranded(7, "not_ready"), "lane-1", 8_000);
    expect(macDesktopVisibleNotParked(list, 8_000)).toHaveLength(1);
  });

  it("shows a final reason immediately", () => {
    const list = reduceMacDesktopNotParked([], stranded(7, "permission_required"), "lane-1", 1_000);
    expect(macDesktopVisibleNotParked(list, 1_001)).toHaveLength(1);
  });
});

describe("macDesktopNotParkedPhrase", () => {
  it("humanizes the codes a driver actually emits", () => {
    expect(macDesktopNotParkedPhrase("not_ready")).toBe("is still opening");
    expect(macDesktopNotParkedPhrase("window_not_ready")).toBe("is still opening");
    expect(macDesktopNotParkedPhrase("escaped")).toBe("keeps leaving the lane screen");
    expect(macDesktopNotParkedPhrase("gave_up")).toBe("keeps leaving the lane screen");
    expect(macDesktopNotParkedPhrase("MAC_DESKTOP_PERMISSION_REQUIRED"))
      .toBe("needs Accessibility permission");
    expect(macDesktopNotParkedPhrase("accessibility_denied")).toBe("needs Accessibility permission");
  });

  it("falls through to the raw reason, which beats a vague sentence", () => {
    expect(macDesktopNotParkedPhrase("something_new")).toBe("something_new");
  });
});

describe("macDesktopCursorFromEvent", () => {
  const observation = (elements: unknown[]) => ({
    type: "observation" as const,
    laneId: "lane-1",
    observation: { caption: "clicked Save", elements } as never,
  });

  it("prefers the focused element and carries the caption", () => {
    const cursor = macDesktopCursorFromEvent(
      observation([
        { center: { x: 1, y: 1 }, focused: false },
        { center: { x: 40, y: 50 }, focused: true },
      ]),
      "lane-1",
      1_000,
    );
    expect(cursor).toEqual({ x: 40, y: 50, at: 1_000, caption: "clicked Save" });
  });

  it("falls back to the first element, and reports nothing without one", () => {
    expect(macDesktopCursorFromEvent(observation([{ center: { x: 2, y: 3 } }]), "lane-1", 5))
      .toMatchObject({ x: 2, y: 3 });
    expect(macDesktopCursorFromEvent(observation([]), "lane-1", 5)).toBeNull();
  });

  it("ignores another lane and every other event type", () => {
    expect(macDesktopCursorFromEvent(observation([{ center: { x: 1, y: 1 } }]), "lane-2", 5)).toBeNull();
    expect(macDesktopCursorFromEvent(
      { type: "windows-changed", laneId: "lane-1", windows: [] },
      "lane-1",
      5,
    )).toBeNull();
  });
});
