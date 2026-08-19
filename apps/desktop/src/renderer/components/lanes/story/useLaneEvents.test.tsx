/* @vitest-environment jsdom */

/**
 * Two invariants the Lanes tab depends on:
 *
 * 1. A parked Lanes route must not touch `window.ade.laneEvents` at all — the
 *    page stays mounted behind other tabs, so an always-on hook would keep the
 *    daemon building stories nobody is looking at.
 * 2. The hosted web adapter has no per-lane push; it re-emits CRR lane
 *    invalidations under `LANES_INVALIDATED_LANE_ID`. Filtering that sentinel
 *    out by lane id would leave the web client permanently stale.
 */

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LANES_INVALIDATED_LANE_ID } from "../../../../shared/types/lanes";
import { emptyLaneEventsListResult } from "../../../../shared/types/laneEvents";

vi.mock("../../../state/appStore", () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector({ activeProjectRoot: "/tmp/project" }),
  selectActiveProjectRoot: () => "/tmp/project",
}));

import { useLaneEvents, useLaneEventsSummary } from "./useLaneEvents";

type ChangedHandler = (event: { laneId: string; kinds: []; at: string }) => void;

const handlers: ChangedHandler[] = [];
const list = vi.fn(async ({ laneId }: { laneId: string }) => emptyLaneEventsListResult(laneId));
const summary = vi.fn(async () => ({ summaries: [], generatedAt: "2026-08-18T00:00:00.000Z" }));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  handlers.length = 0;
  list.mockClear();
  summary.mockClear();
  (window as unknown as { ade: unknown }).ade = {
    laneEvents: {
      list,
      summary,
      onChanged: (cb: ChangedHandler) => {
        handlers.push(cb);
        return () => {
          const at = handlers.indexOf(cb);
          if (at >= 0) handlers.splice(at, 1);
        };
      },
    },
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function flushCoalesce() {
  await act(async () => {
    vi.advanceTimersByTime(400);
  });
}

describe("useLaneEvents", () => {
  it("stays completely idle while the route is parked, then loads once it goes active", async () => {
    const { rerender } = renderHook(
      ({ active }: { active: boolean }) => useLaneEvents("lane-1", active),
      { initialProps: { active: false } },
    );

    expect(list).not.toHaveBeenCalled();
    // No subscription and no focus listener either: a push or a focus while
    // parked must not schedule anything.
    expect(handlers).toHaveLength(0);
    window.dispatchEvent(new Event("focus"));
    await flushCoalesce();
    expect(list).not.toHaveBeenCalled();

    rerender({ active: true });
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    expect(handlers).toHaveLength(1);
  });

  it("treats the web wildcard lane id as a match", async () => {
    renderHook(() => useLaneEvents("lane-1", true));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));

    act(() => {
      handlers[0]?.({ laneId: "some-other-lane", kinds: [], at: "2026-08-18T00:00:00.000Z" });
    });
    await flushCoalesce();
    expect(list).toHaveBeenCalledTimes(1);

    act(() => {
      handlers[0]?.({ laneId: LANES_INVALIDATED_LANE_ID, kinds: [], at: "2026-08-18T00:00:01.000Z" });
    });
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });
});

describe("useLaneEventsSummary", () => {
  it("does not read summaries while parked", async () => {
    const laneIds = ["lane-1", "lane-2"];
    const { rerender } = renderHook(
      ({ active }: { active: boolean }) => useLaneEventsSummary(laneIds, active),
      { initialProps: { active: false } },
    );

    expect(summary).not.toHaveBeenCalled();
    expect(handlers).toHaveLength(0);

    rerender({ active: true });
    await waitFor(() => expect(summary).toHaveBeenCalledTimes(1));
    expect(summary).toHaveBeenCalledWith({ laneIds });
  });
});
