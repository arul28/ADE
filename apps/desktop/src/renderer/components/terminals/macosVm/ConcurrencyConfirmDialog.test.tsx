/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => cleanup());
import type { MacosVmRecord } from "../../../../shared/types";
import {
  ConcurrencyConfirmDialog,
  summariseRunningResources,
} from "./ConcurrencyConfirmDialog";

function makeVm(overrides: Partial<MacosVmRecord> = {}): MacosVmRecord {
  return {
    id: "macos-vm:lane-a",
    provider: "apple-virtualization-helper",
    name: "lane-a-vm",
    laneId: "lane-a",
    laneName: "Lane A",
    laneRoot: "/lane/a",
    state: "running",
    cpuCores: 2,
    memory: "4GB",
    diskSize: "64GB",
    display: "1440x900",
    guestSharedPath: "/Volumes/My Shared Files",
    sharedDirectory: "/share/lane-a",
    createdAt: "2026-05-07T00:00:00.000Z",
    updatedAt: "2026-05-07T00:00:00.000Z",
    lastStartedAt: "2026-05-07T00:00:00.000Z",
    lastStoppedAt: null,
    ipAddress: null,
    sshCommand: null,
    vncUrl: null,
    lastError: null,
    metadata: {},
    ...overrides,
  };
}

describe("summariseRunningResources", () => {
  it("counts only VMs in running/starting/installing/creating states", () => {
    const vms = [
      makeVm({ state: "running", cpuCores: 2, memory: "4GB" }),
      makeVm({ id: "x", laneId: "x", state: "stopped", cpuCores: 4, memory: "8GB" }),
      makeVm({ id: "y", laneId: "y", state: "starting", cpuCores: 2, memory: "2GB" }),
      makeVm({ id: "z", laneId: "z", state: "installing", cpuCores: 1, memory: "1GB" }),
      makeVm({ id: "w", laneId: "w", state: "creating", cpuCores: 1, memory: "1GB" }),
    ];
    const summary = summariseRunningResources(vms);
    expect(summary.count).toBe(4);
    expect(summary.cpuCores).toBe(6);
    expect(summary.memoryGb).toBeCloseTo(8, 5);
  });
});

describe("ConcurrencyConfirmDialog", () => {
  it("shows the basic 1->2 warning copy", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <ConcurrencyConfirmDialog
        open
        laneName="virtualization"
        pendingCpuCores={2}
        pendingMemoryGb={4}
        runningVms={[makeVm()]}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );

    expect(screen.getByText(/Another macOS VM is already running/i)).toBeTruthy();
    expect(screen.getByText(/2 vCPU/)).toBeTruthy(); // running list line
    fireEvent.click(screen.getByText("Start anyway"));
    expect(onConfirm).toHaveBeenCalled();
  });

  it("escalates copy at 4+ VMs", () => {
    const running = [
      makeVm({ id: "a", laneId: "a" }),
      makeVm({ id: "b", laneId: "b" }),
      makeVm({ id: "c", laneId: "c" }),
    ];
    render(
      <ConcurrencyConfirmDialog
        open
        laneName="virtualization"
        pendingCpuCores={2}
        pendingMemoryGb={4}
        runningVms={running}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );

    expect(screen.getByText(/Your Mac will struggle/i)).toBeTruthy();
    expect(screen.getByText(/4 macOS VMs running at once/i)).toBeTruthy();
  });

  it("invokes onCancel when the cancel button is clicked", () => {
    const onCancel = vi.fn();
    render(
      <ConcurrencyConfirmDialog
        open
        laneName="virtualization"
        pendingCpuCores={2}
        pendingMemoryGb={4}
        runningVms={[makeVm()]}
        onCancel={onCancel}
        onConfirm={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("Cancel"));
    expect(onCancel).toHaveBeenCalled();
  });

  it("renders nothing when open=false", () => {
    const { container } = render(
      <ConcurrencyConfirmDialog
        open={false}
        laneName="virtualization"
        pendingCpuCores={2}
        pendingMemoryGb={4}
        runningVms={[]}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />,
    );
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
});
