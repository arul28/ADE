/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LaneLifecycleEvent } from "../../shared/types";
import type { AppState } from "../state/appStore";
import {
  LANE_LIST_FOCUS_REFRESH_DEBOUNCE_MS,
  LANE_LIST_FOCUS_STALE_MS,
  LANE_LIST_LIFECYCLE_FOLLOWUP_REFRESH_DELAY_MS,
  LANE_LIST_LIFECYCLE_REFRESH_DEBOUNCE_MS,
  useLaneListInvalidation,
} from "./useLaneListInvalidation";
import { invalidateLaneReadCache } from "../lib/laneReadCache";

vi.mock("../lib/laneReadCache", () => ({
  invalidateLaneReadCache: vi.fn(),
}));

type RefreshLanes = AppState["refreshLanes"];

function createRefreshLanesMock() {
  return vi.fn<Parameters<RefreshLanes>, ReturnType<RefreshLanes>>(async () => undefined);
}

function setVisibilityState(value: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => value,
  });
}

function Harness({
  active = true,
  refreshLanes,
}: {
  active?: boolean;
  refreshLanes: RefreshLanes;
}) {
  useLaneListInvalidation({ active, refreshLanes });
  return null;
}

describe("useLaneListInvalidation", () => {
  let lifecycleListener: ((event: LaneLifecycleEvent) => void) | null = null;
  let unsubscribe: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-06T12:00:00.000Z"));
    lifecycleListener = null;
    unsubscribe = vi.fn();
    setVisibilityState("visible");
    (globalThis as any).window.ade = {
      lanes: {
        onLifecycleEvent: vi.fn((listener: (event: LaneLifecycleEvent) => void) => {
          lifecycleListener = listener;
          return unsubscribe;
        }),
      },
    };
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.mocked(invalidateLaneReadCache).mockClear();
  });

  it("invalidates and refreshes decorated lanes for daemon-origin lifecycle events", async () => {
    const refreshLanes = createRefreshLanesMock();
    render(<Harness refreshLanes={refreshLanes} />);

    expect(window.ade.lanes.onLifecycleEvent).toHaveBeenCalledTimes(1);
    expect(lifecycleListener).toBeTruthy();

    act(() => {
      lifecycleListener?.({
        type: "lane-created",
        laneId: "lane-new",
        laneName: "New lane",
      });
    });

    expect(invalidateLaneReadCache).toHaveBeenCalledTimes(1);
    expect(refreshLanes).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LANE_LIST_LIFECYCLE_REFRESH_DEBOUNCE_MS);
    });

    expect(refreshLanes).toHaveBeenCalledWith({
      includeStatus: true,
      includeSnapshots: true,
      includeConflictStatus: true,
      includeRebaseSuggestions: true,
      includeAutoRebaseStatus: true,
    });
  });

  it("runs one delayed follow-up refresh for lifecycle bursts", async () => {
    const refreshLanes = createRefreshLanesMock();
    render(<Harness refreshLanes={refreshLanes} />);

    act(() => {
      lifecycleListener?.({
        type: "lane-created",
        laneId: "lane-new",
        laneName: "New lane",
      });
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LANE_LIST_LIFECYCLE_REFRESH_DEBOUNCE_MS);
    });
    expect(refreshLanes).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LANE_LIST_LIFECYCLE_FOLLOWUP_REFRESH_DELAY_MS - 1);
    });
    expect(refreshLanes).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(refreshLanes).toHaveBeenCalledTimes(2);
    expect(refreshLanes).toHaveBeenLastCalledWith(expect.objectContaining({
      includeStatus: true,
      includeSnapshots: true,
    }));
  });

  it("defers hidden lifecycle refreshes until the Lanes tab becomes visible", async () => {
    const refreshLanes = createRefreshLanesMock();
    render(<Harness refreshLanes={refreshLanes} />);
    setVisibilityState("hidden");

    act(() => {
      lifecycleListener?.({
        type: "lane-renamed",
        laneId: "lane-1",
        laneName: "Renamed",
        previousLaneName: "Old",
      });
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LANE_LIST_LIFECYCLE_REFRESH_DEBOUNCE_MS);
    });
    expect(refreshLanes).not.toHaveBeenCalled();

    setVisibilityState("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(LANE_LIST_LIFECYCLE_REFRESH_DEBOUNCE_MS);
    });

    expect(refreshLanes).toHaveBeenCalledWith(expect.objectContaining({
      includeStatus: false,
      includeSnapshots: true,
    }));
  });

  it("keeps created-lane status refresh when lifecycle events are debounced together", async () => {
    const refreshLanes = createRefreshLanesMock();
    render(<Harness refreshLanes={refreshLanes} />);

    act(() => {
      lifecycleListener?.({
        type: "lane-created",
        laneId: "lane-new",
        laneName: "New",
      });
      lifecycleListener?.({
        type: "lane-renamed",
        laneId: "lane-new",
        laneName: "New name",
        previousLaneName: "New",
      });
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LANE_LIST_LIFECYCLE_REFRESH_DEBOUNCE_MS);
    });

    expect(refreshLanes).toHaveBeenCalledWith(expect.objectContaining({
      includeStatus: true,
      includeSnapshots: true,
    }));
  });

  it("self-heals on focus only after the lane list is stale", async () => {
    const refreshLanes = createRefreshLanesMock();
    render(<Harness refreshLanes={refreshLanes} />);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(LANE_LIST_FOCUS_REFRESH_DEBOUNCE_MS);
    });
    expect(refreshLanes).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(LANE_LIST_FOCUS_STALE_MS + 1);
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(LANE_LIST_FOCUS_REFRESH_DEBOUNCE_MS);
    });

    expect(refreshLanes).toHaveBeenCalledWith(expect.objectContaining({
      includeStatus: false,
      includeSnapshots: true,
    }));
  });
});
