/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LaneLifecycleEvent, LaneSummary } from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { armLaneBranchDriftWarning, disarmLaneBranchDriftWarning, LaneBranchDriftStrip } from "./LaneBranchDrift";

// The IPC boundary. One object for the whole file: the strip subscribes to
// lane lifecycle events once per app, the first time a strip mounts.
const lanesApi = {
  onLifecycleEvent: vi.fn(),
  switchBranch: vi.fn(),
  getBranchDrift: vi.fn(),
  resolveBranchDrift: vi.fn(),
};
let emitLifecycle: (event: LaneLifecycleEvent) => void = () => undefined;

function seedLane(overrides: Partial<LaneSummary>) {
  useAppStore.setState({
    lanes: [{ id: "lane-1", name: "cu md", branchRef: "ade/lane", branchDrift: null, ...overrides } as LaneSummary],
    refreshLanes: vi.fn(async () => undefined),
  } as Partial<ReturnType<typeof useAppStore.getState>>);
}

beforeAll(() => {
  lanesApi.onLifecycleEvent.mockImplementation((callback: (event: LaneLifecycleEvent) => void) => {
    emitLifecycle = callback;
    return () => undefined;
  });
  (window as unknown as { ade: unknown }).ade = { lanes: lanesApi };
});

beforeEach(() => {
  lanesApi.switchBranch.mockReset().mockResolvedValue({});
  lanesApi.getBranchDrift.mockReset().mockResolvedValue(null);
  lanesApi.resolveBranchDrift.mockReset().mockResolvedValue({});
});

afterEach(() => {
  cleanup();
  disarmLaneBranchDriftWarning("lane-1");
});

describe("LaneBranchDriftStrip", () => {
  it("shows where ADE moved the lane after its agent switched branches, and Switch back checks the old branch out", async () => {
    seedLane({ branchRef: "ade/follow-up" });
    render(<LaneBranchDriftStrip laneId="lane-1" />);
    expect(screen.queryByTestId("lane-branch-adopted-chip")).toBeNull();

    act(() => {
      emitLifecycle({
        type: "lane-branch-updated",
        laneId: "lane-1",
        laneName: "cu md",
        previousBranchRef: "ade/lane",
        branchRef: "ade/follow-up",
        adoptedByAgent: true,
      });
    });

    const chip = await screen.findByTestId("lane-branch-adopted-chip");
    expect(chip.textContent).toContain("ade/follow-up");
    fireEvent.click(screen.getByRole("button", { name: /Switch back/ }));
    await waitFor(() => expect(lanesApi.switchBranch).toHaveBeenCalledWith({
      laneId: "lane-1",
      branchName: "ade/lane",
      mode: "existing",
    }));
    await waitFor(() => expect(screen.queryByTestId("lane-branch-adopted-chip")).toBeNull());
  });

  it("asks once something is about to act, reading HEAD fresh when the lane list is stale", async () => {
    // The lane list still says the lane is on its branch.
    seedLane({ branchRef: "ade/lane", branchDrift: null });
    lanesApi.getBranchDrift.mockResolvedValue({ expectedBranchRef: "ade/lane", headBranchRef: "ade/elsewhere" });
    render(<LaneBranchDriftStrip laneId="lane-1" />);
    expect(screen.queryByTestId("lane-branch-drift-strip")).toBeNull();
    expect(lanesApi.getBranchDrift).not.toHaveBeenCalled();

    act(() => { armLaneBranchDriftWarning("lane-1"); });

    const chip = await screen.findByTestId("lane-branch-drift-strip");
    expect(chip.textContent).toContain("ade/elsewhere");
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    await waitFor(() => expect(lanesApi.resolveBranchDrift).toHaveBeenCalledWith({
      laneId: "lane-1",
      resolution: "keep-head",
      expectedHeadBranchRef: "ade/elsewhere",
    }));
  });
});
