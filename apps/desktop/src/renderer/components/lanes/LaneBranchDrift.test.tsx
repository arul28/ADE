/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LaneLifecycleEvent, LaneSummary } from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { armLaneBranchDriftWarning, disarmLaneBranchDriftWarning, LaneBranchComposerChip } from "./LaneBranchDrift";

// The IPC boundary. One object for the whole file: the strip subscribes to
// lane lifecycle events once per app, the first time a strip mounts.
const lanesApi = {
  onLifecycleEvent: vi.fn(),
  switchBranch: vi.fn(),
  getBranchDrift: vi.fn(),
  resolveBranchDrift: vi.fn(),
};
const sessionsApi = { list: vi.fn(), onChanged: vi.fn(() => () => undefined) };
const agentChatApi = { interrupt: vi.fn() };
let emitLifecycle: (event: LaneLifecycleEvent) => void = () => undefined;

/** The tab's copy: its lanes' branches are read and switched there. */
const TAB_PIN = { kind: "local", key: "local:/repo", rootPath: "/repo", displayName: "repo" } as const;

function seedLane(overrides: Partial<LaneSummary>) {
  useAppStore.setState({
    projectBinding: TAB_PIN,
    lanes: [{ id: "lane-1", name: "cu md", branchRef: "ade/lane", branchDrift: null, ...overrides } as LaneSummary],
    refreshLanes: vi.fn(async () => undefined),
  } as Partial<ReturnType<typeof useAppStore.getState>>);
}

beforeAll(() => {
  lanesApi.onLifecycleEvent.mockImplementation((callback: (event: LaneLifecycleEvent) => void) => {
    emitLifecycle = callback;
    return () => undefined;
  });
  (window as unknown as { ade: unknown }).ade = { lanes: lanesApi, sessions: sessionsApi, agentChat: agentChatApi };
});

beforeEach(() => {
  lanesApi.switchBranch.mockReset().mockResolvedValue({});
  lanesApi.getBranchDrift.mockReset().mockResolvedValue(null);
  lanesApi.resolveBranchDrift.mockReset().mockResolvedValue({});
  sessionsApi.list.mockReset().mockResolvedValue([]);
  agentChatApi.interrupt.mockReset().mockResolvedValue({});
});

afterEach(() => {
  cleanup();
  disarmLaneBranchDriftWarning("lane-1");
});

describe("LaneBranchComposerChip", () => {
  it("switches back after stopping the background work from a settled chat", async () => {
    seedLane({ branchRef: "ade/follow-up" });
    lanesApi.switchBranch.mockRejectedValueOnce(new Error("This lane has active sessions. Confirm the branch switch to continue."));
    sessionsApi.list.mockResolvedValue([{
      id: "settled-chat",
      laneId: "lane-1",
      title: "Settled chat",
      toolType: "codex-chat",
      status: "running",
      runtimeState: "idle",
      settledAt: "2026-11-26T15:00:00Z",
      backgroundWork: { workingCount: 1, monitoringCount: 0 },
    }]);
    agentChatApi.interrupt.mockImplementation(async () => { sessionsApi.list.mockResolvedValue([]); });
    render(<LaneBranchComposerChip laneId="lane-1" />);
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
    }, TAB_PIN));
    const stop = await screen.findByRole("button", { name: "Stop and switch" });
    expect(lanesApi.switchBranch).toHaveBeenCalledTimes(1);
    fireEvent.click(stop);
    await waitFor(() => expect(agentChatApi.interrupt).toHaveBeenCalledWith({
      sessionId: "settled-chat",
      mode: "stop_and_clear_and_background",
    }, TAB_PIN));
    await waitFor(() => expect(lanesApi.switchBranch).toHaveBeenLastCalledWith({
      laneId: "lane-1",
      branchName: "ade/lane",
      mode: "existing",
      acknowledgeActiveWork: true,
    }, TAB_PIN));
    await waitFor(() => expect(screen.queryByTestId("lane-branch-adopted-chip")).toBeNull());
  });

  it("asks once something is about to act, reading HEAD fresh when the lane list is stale", async () => {
    // The lane list still says the lane is on its branch.
    seedLane({ branchRef: "ade/lane", branchDrift: null });
    lanesApi.getBranchDrift.mockResolvedValue({ expectedBranchRef: "ade/lane", headBranchRef: "ade/elsewhere" });
    render(<LaneBranchComposerChip laneId="lane-1" />);
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
    }, TAB_PIN));
  });
});
