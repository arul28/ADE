import { describe, expect, it } from "vitest";

import type {
  MacDesktopDisplay,
  MacDesktopEventPayload,
  MacDesktopStatus,
  MacDesktopWindow,
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
