/* @vitest-environment jsdom */

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LaneDeleteEvent, LaneDeleteProgress, LaneLifecycleEvent, LaneSummary } from "../../../shared/types";
import { useAppStore, type AppState } from "../../state/appStore";
import { showToast } from "../app/toast/toastStore";
import { useWorkLaneDeleteProgress } from "./useWorkLaneDeleteProgress";

vi.mock("../app/toast/toastStore", () => ({
  showToast: vi.fn(),
}));

const lane: LaneSummary = {
  id: "lane-delete",
  name: "Delete me",
  laneType: "worktree",
  baseRef: "main",
  branchRef: "delete-me",
  worktreePath: "/tmp/delete-me",
  parentLaneId: null,
  childCount: 0,
  stackDepth: 0,
  parentStatus: null,
  isEditProtected: false,
  status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false },
  color: null,
  icon: null,
  tags: [],
  createdAt: "2026-07-16T12:00:00.000Z",
};

function progress(overallStatus: LaneDeleteProgress["overallStatus"]): LaneDeleteProgress {
  return {
    laneId: lane.id,
    steps: [],
    startedAt: "2026-07-16T12:00:00.000Z",
    ...(overallStatus === "completed" ? { completedAt: "2026-07-16T12:00:01.000Z" } : {}),
    overallStatus,
    cancellable: false,
  };
}

describe("useWorkLaneDeleteProgress", () => {
  let deleteListener: ((event: LaneDeleteEvent) => void) | null;
  let lifecycleListener: ((event: LaneLifecycleEvent) => void) | null;
  let refreshLanes: AppState["refreshLanes"];

  beforeEach(() => {
    deleteListener = null;
    lifecycleListener = null;
    refreshLanes = vi.fn<Parameters<AppState["refreshLanes"]>, ReturnType<AppState["refreshLanes"]>>(async () => undefined);
    useAppStore.setState({
      laneDeleteProgressByLaneId: {},
      refreshLanes,
    });
    (globalThis as typeof globalThis & { window: Window }).window.ade = {
      ...window.ade,
      lanes: {
        ...window.ade?.lanes,
        onDeleteEvent: vi.fn((listener: (event: LaneDeleteEvent) => void) => {
          deleteListener = listener;
          return vi.fn();
        }),
        onLifecycleEvent: vi.fn((listener: (event: LaneLifecycleEvent) => void) => {
          lifecycleListener = listener;
          return vi.fn();
        }),
        listDeleteProgress: vi.fn().mockResolvedValue([]),
      },
    } as typeof window.ade;
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.mocked(showToast).mockReset();
    useAppStore.setState({ laneDeleteProgressByLaneId: {} });
  });

  it("tracks running deletion and refreshes both lanes and sessions on completion", async () => {
    const refreshSessions = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useWorkLaneDeleteProgress({
      active: true,
      projectRoot: "/project",
      lanes: [lane],
      refreshSessions,
    }));

    expect(deleteListener).toBeTruthy();
    act(() => deleteListener?.({ type: "lane-delete", progress: progress("running") }));
    expect(useAppStore.getState().laneDeleteProgressByLaneId[lane.id]?.overallStatus).toBe("running");

    act(() => deleteListener?.({ type: "lane-delete", progress: progress("completed") }));
    await waitFor(() => expect(refreshLanes).toHaveBeenCalledTimes(1));
    expect(refreshSessions).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().laneDeleteProgressByLaneId[lane.id]).toBeUndefined();
  });

  it("bounds refresh retries and releases the disabled state after repeated failure", async () => {
    vi.useFakeTimers();
    vi.mocked(refreshLanes).mockRejectedValue(new Error("refresh failed"));
    const refreshSessions = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useWorkLaneDeleteProgress({
      active: true,
      projectRoot: "/project",
      lanes: [lane],
      refreshSessions,
    }));

    act(() => deleteListener?.({ type: "lane-delete", progress: progress("completed") }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });

    expect(refreshLanes).toHaveBeenCalledTimes(3);
    expect(useAppStore.getState().laneDeleteProgressByLaneId[lane.id]).toBeUndefined();
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(vi.mocked(showToast).mock.calls[0]?.[0]).toMatchObject({
      title: "Lane deleted, but Work did not refresh",
      tone: "error",
    });
  });
});
