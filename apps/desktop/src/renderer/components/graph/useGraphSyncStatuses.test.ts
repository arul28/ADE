/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { LaneSummary } from "../../../shared/types";
import { useGraphSyncStatuses } from "./useGraphSyncStatuses";

function makeLane(id: string, branchRef = `feature/${id}`): LaneSummary {
  return {
    id,
    name: id,
    baseRef: "main",
    branchRef,
    worktreePath: `/tmp/${id}`,
    worktreeAvailable: true,
    archivedAt: null,
  } as LaneSummary;
}

describe("useGraphSyncStatuses", () => {
  afterEach(() => {
    delete (window as any).ade;
  });

  it("refreshes only lanes whose branch or worktree inputs changed", async () => {
    const getSyncStatuses = vi.fn()
      .mockResolvedValueOnce({
        "lane-1": { hasUpstream: true, upstreamState: "tracking" },
        "lane-2": { hasUpstream: false, upstreamState: "missing" },
      })
      .mockResolvedValueOnce({
        "lane-2": { hasUpstream: true, upstreamState: "tracking" },
      });
    (window as any).ade = { git: { getSyncStatuses } };

    const firstLanes = [makeLane("lane-1"), makeLane("lane-2")];
    const lanesRef = { current: firstLanes };
    const { rerender } = renderHook(
      (props: { lanes: LaneSummary[] }) => useGraphSyncStatuses({
        active: true,
        lanes: props.lanes,
        lanesRef,
        projectRoot: "/repo",
      }),
      { initialProps: { lanes: firstLanes } },
    );

    await waitFor(() => expect(getSyncStatuses).toHaveBeenCalledTimes(1));
    expect(getSyncStatuses).toHaveBeenNthCalledWith(1, { laneIds: ["lane-1", "lane-2"] });

    const changedLanes = [makeLane("lane-1"), makeLane("lane-2", "feature/changed")];
    lanesRef.current = changedLanes;
    await act(async () => {
      rerender({ lanes: changedLanes });
    });

    await waitFor(() => expect(getSyncStatuses).toHaveBeenCalledTimes(2));
    expect(getSyncStatuses).toHaveBeenNthCalledWith(2, { laneIds: ["lane-2"] });
  });
});
