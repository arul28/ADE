/* @vitest-environment jsdom */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  MAC_DESKTOP_LOADING_RECHECK_MS,
  MAC_DESKTOP_REVALIDATE_MIN_MS,
  MAC_DESKTOP_START_GIVE_UP_MS,
  MAC_DESKTOP_START_TOO_LONG,
  macDesktopCursorFromEvent,
  reduceMacDesktopStatus,
  useMacDesktopStatus,
} from "./useMacDesktopStatus";
import {
  MAC_DESKTOP_NOT_ANSWERING,
  MAC_DESKTOP_READ_TIMEOUT_MS,
  resetMacDesktopStatusStoreForTests,
} from "./macDesktopStatusStore";

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

  it("says an unknown code in plain words, never the code", () => {
    expect(macDesktopNotParkedPhrase("window_not_movable")).toBe("couldn't move to the lane screen");
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

describe("useMacDesktopStatus", () => {
  let emit: (event: MacDesktopEventPayload) => void = () => {};
  const api = {
    getStatus: vi.fn(),
    start: vi.fn(),
    onEvent: vi.fn((cb: (event: MacDesktopEventPayload) => void) => {
      emit = cb;
      return () => {};
    }),
  };
  const off = (): MacDesktopStatus => ({ ...baseStatus(), display: null });

  /** A promise the test settles by hand, like a start whose reply is late. */
  function deferred<T>() {
    let resolve: (value: T) => void = () => {};
    const promise = new Promise<T>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  const mount = () => renderHook(() => useMacDesktopStatus({
    laneId: "lane-1",
    laneName: "docs-fix",
    sessionId: "chat-1",
    runtimePin: null,
  }));
  const flush = () => act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  const advance = (ms: number) => act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

  beforeEach(() => {
    vi.useFakeTimers();
    resetMacDesktopStatusStoreForTests();
    api.getStatus.mockReset();
    api.start.mockReset();
    api.onEvent.mockClear();
    (window as unknown as { ade: unknown }).ade = { macDesktop: api };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads on mount and never starts a display by itself", async () => {
    api.getStatus.mockResolvedValue(off());
    const { result } = mount();
    await flush();
    await advance(MAC_DESKTOP_LOADING_RECHECK_MS * 3);

    expect(result.current.status?.display).toBeNull();
    expect(result.current.starting).toBe(false);
    expect(api.start).not.toHaveBeenCalled();
    // The Off card waits for events, not a timer.
    expect(api.getStatus).toHaveBeenCalledTimes(1);
  });

  it("re-reads every 8 s while a start is out, and a re-read with the display ends it", async () => {
    api.getStatus.mockResolvedValue(off());
    const reply = deferred<MacDesktopStatus>();
    api.start.mockReturnValue(reply.promise);
    const { result } = mount();
    await flush();

    act(() => {
      void result.current.start();
    });
    expect(result.current.starting).toBe(true);
    expect(api.start).toHaveBeenCalledWith(
      { laneId: "lane-1", laneName: "docs-fix", chatSessionId: "chat-1" },
      null,
    );

    await advance(MAC_DESKTOP_LOADING_RECHECK_MS - 1);
    expect(api.getStatus).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(api.getStatus).toHaveBeenCalledTimes(2);
    expect(result.current.starting).toBe(true);

    // The start's reply never comes, but the display is there.
    api.getStatus.mockResolvedValue(baseStatus());
    await advance(MAC_DESKTOP_LOADING_RECHECK_MS);
    expect(result.current.status?.display?.laneId).toBe("lane-1");
    expect(result.current.starting).toBe(false);

    // No more re-reads once nothing is waiting.
    const reads = api.getStatus.mock.calls.length;
    await advance(MAC_DESKTOP_LOADING_RECHECK_MS * 2);
    expect(api.getStatus).toHaveBeenCalledTimes(reads);
  });

  it("gives up after 150 s with the Start sentence, and a late reply changes nothing", async () => {
    api.getStatus.mockResolvedValue(off());
    const reply = deferred<MacDesktopStatus>();
    api.start.mockReturnValue(reply.promise);
    const { result } = mount();
    await flush();
    act(() => {
      void result.current.start();
    });

    await advance(MAC_DESKTOP_START_GIVE_UP_MS - 1);
    expect(result.current.starting).toBe(true);
    expect(result.current.gaveUp).toBe(false);
    await advance(1);
    expect(result.current.starting).toBe(false);
    expect(result.current.gaveUp).toBe(true);
    expect(result.current.error).toBe(MAC_DESKTOP_START_TOO_LONG);

    // The replaced start's answer is not applied; the hook reads the truth.
    const reads = api.getStatus.mock.calls.length;
    await act(async () => {
      reply.resolve(baseStatus());
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(api.getStatus).toHaveBeenCalledTimes(reads + 1);
    expect(result.current.status?.display).toBeNull();
    expect(result.current.starting).toBe(false);
  });

  it("ends a start on display-created and goes to Off on display-destroyed at once", async () => {
    api.getStatus.mockResolvedValue(off());
    api.start.mockReturnValue(new Promise(() => {}));
    const { result } = mount();
    await flush();
    act(() => {
      void result.current.start();
    });
    expect(result.current.starting).toBe(true);

    act(() => emit({ type: "display-created", display: display("lane-1") }));
    expect(result.current.status?.display?.laneId).toBe("lane-1");
    expect(result.current.starting).toBe(false);

    // A failure about the display that was is stale once it closes.
    act(() => result.current.setError("Could not take control."));
    act(() => emit({ type: "display-destroyed", laneId: "lane-1", reason: "stopped" }));
    expect(result.current.status?.display).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.starting).toBe(false);
    expect(api.start).toHaveBeenCalledTimes(1);
  });

  it("reads again when a display event beats the first read", async () => {
    const first = deferred<MacDesktopStatus>();
    api.getStatus.mockReturnValueOnce(first.promise).mockResolvedValue(baseStatus());
    const { result } = mount();
    await flush();

    act(() => emit({ type: "display-created", display: display("lane-1") }));
    await flush();
    expect(api.getStatus).toHaveBeenCalledTimes(2);
    expect(result.current.status?.display?.laneId).toBe("lane-1");
  });

  it("turns a host that never answers into a read error, instead of Checking forever", async () => {
    api.getStatus.mockReturnValue(new Promise(() => {}));
    const { result } = mount();
    await flush();
    expect(result.current.readError).toBeNull();

    await advance(MAC_DESKTOP_READ_TIMEOUT_MS);
    expect(result.current.status).toBeNull();
    expect(result.current.readError).toBe(MAC_DESKTOP_NOT_ANSWERING);
    expect(result.current.unconfirmed).toBe(true);

    // The next good read clears it by itself.
    api.getStatus.mockResolvedValue(off());
    await act(async () => { await result.current.refresh(); });
    expect(result.current.readError).toBeNull();
    expect(result.current.unconfirmed).toBe(false);
    expect(result.current.status?.display).toBeNull();
  });

  it("does not let a slow read undo a display event that came after it was sent", async () => {
    api.getStatus.mockResolvedValue(baseStatus());
    const { result } = mount();
    await flush();
    expect(result.current.status?.display?.laneId).toBe("lane-1");

    const slow = deferred<MacDesktopStatus>();
    api.getStatus.mockReturnValueOnce(slow.promise);
    act(() => { void result.current.refresh(); });
    act(() => emit({ type: "display-destroyed", laneId: "lane-1", reason: "driver_lost" }));
    expect(result.current.status?.display).toBeNull();

    await act(async () => {
      slow.resolve(baseStatus());
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.status?.display).toBeNull();
  });

  it("re-reads when the window comes back into focus", async () => {
    api.getStatus.mockResolvedValue(baseStatus());
    const { result } = mount();
    await flush();
    await advance(MAC_DESKTOP_REVALIDATE_MIN_MS);

    api.getStatus.mockResolvedValue(off());
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.status?.display).toBeNull();
  });

  it("re-reads every 8 s while the first read has not answered", async () => {
    api.getStatus.mockReturnValueOnce(new Promise(() => {})).mockResolvedValue(off());
    const { result } = mount();
    await flush();
    expect(result.current.status).toBeNull();

    await advance(MAC_DESKTOP_LOADING_RECHECK_MS);
    expect(api.getStatus).toHaveBeenCalledTimes(2);
    expect(result.current.status?.display).toBeNull();
    expect(api.start).not.toHaveBeenCalled();
  });
});
