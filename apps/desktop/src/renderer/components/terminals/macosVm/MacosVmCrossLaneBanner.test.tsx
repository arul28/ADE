/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MacosVmRecord, MacosVmStatus } from "../../../../shared/types";
import { MacosVmCrossLaneBanner } from "./MacosVmCrossLaneBanner";

const mockStoreState = {
  lanes: [
    { id: "lane-active", name: "active-lane" },
    { id: "lane-sibling", name: "sibling-lane" },
  ] as Array<{ id: string; name: string }>,
  selectLane: vi.fn(),
};

vi.mock("../../../state/appStore", () => ({
  useAppStore: (selector: (state: typeof mockStoreState) => unknown) => selector(mockStoreState),
}));

function makeVm(overrides: Partial<MacosVmRecord> = {}): MacosVmRecord {
  return {
    id: "macos-vm:lane-sibling",
    provider: "apple-virtualization-helper",
    name: "lane-sibling-vm",
    laneId: "lane-sibling",
    laneName: "sibling-lane",
    laneRoot: "/lane/sibling",
    state: "running",
    cpuCores: 2,
    memory: "4GB",
    diskSize: "64GB",
    display: "1440x900",
    guestSharedPath: "/Volumes/My Shared Files",
    sharedDirectory: "/share/lane-sibling",
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

function makeStatus(vms: MacosVmRecord[]): MacosVmStatus {
  return {
    platform: "darwin",
    arch: "arm64",
    supported: true,
    checkedAt: "2026-05-07T00:00:00.000Z",
    activeProvider: {
      kind: "apple-virtualization-helper",
      available: true,
      version: null,
      detail: "ok",
      docsUrl: "",
    },
    tools: [],
    laneVm: null,
    vms,
    defaultBase: null,
    bases: [],
    docs: { appleVirtualization: "", appleSharedDirectories: "" },
  };
}

const focusWindow = vi.fn().mockResolvedValue({});
const stop = vi.fn().mockResolvedValue(null);

beforeEach(() => {
  mockStoreState.selectLane.mockReset();
  focusWindow.mockClear();
  stop.mockClear();
  (window as any).ade = {
    macosVm: {
      focusWindow,
      stop,
    },
  };
});

afterEach(() => {
  cleanup();
  delete (window as any).ade;
});

describe("MacosVmCrossLaneBanner", () => {
  it("renders nothing when no sibling VM exists", () => {
    const { container } = render(
      <MacosVmCrossLaneBanner status={makeStatus([])} activeLaneId="lane-active" />,
    );
    expect(container.querySelector('[data-testid="macos-vm-cross-lane-banner"]')).toBeNull();
  });

  it("renders when a sibling lane has a running VM", () => {
    const status = makeStatus([makeVm({ state: "running" })]);
    render(<MacosVmCrossLaneBanner status={status} activeLaneId="lane-active" />);
    expect(screen.getByTestId("macos-vm-cross-lane-banner")).toBeTruthy();
    expect(screen.getByText("sibling-lane")).toBeTruthy();
    expect(screen.getByText("running")).toBeTruthy();
  });

  it("ignores VMs in the active lane", () => {
    const status = makeStatus([makeVm({ laneId: "lane-active", state: "running" })]);
    const { container } = render(
      <MacosVmCrossLaneBanner status={status} activeLaneId="lane-active" />,
    );
    expect(container.querySelector('[data-testid="macos-vm-cross-lane-banner"]')).toBeNull();
  });

  it("ignores stopped sibling VMs", () => {
    const status = makeStatus([makeVm({ state: "stopped" })]);
    const { container } = render(
      <MacosVmCrossLaneBanner status={status} activeLaneId="lane-active" />,
    );
    expect(container.querySelector('[data-testid="macos-vm-cross-lane-banner"]')).toBeNull();
  });

  it("calls selectLane on Switch lane click", () => {
    const status = makeStatus([makeVm({ state: "running" })]);
    render(<MacosVmCrossLaneBanner status={status} activeLaneId="lane-active" />);
    fireEvent.click(screen.getByLabelText(/Switch to lane sibling-lane/));
    expect(mockStoreState.selectLane).toHaveBeenCalledWith("lane-sibling");
  });

  it("calls focusWindow on Focus click and stop on Stop click", () => {
    const status = makeStatus([makeVm({ state: "running" })]);
    render(<MacosVmCrossLaneBanner status={status} activeLaneId="lane-active" />);
    fireEvent.click(screen.getByLabelText("Bring VM window forward"));
    expect(focusWindow).toHaveBeenCalledWith({ laneId: "lane-sibling" });
    fireEvent.click(screen.getByLabelText(/Stop VM for lane sibling-lane/));
    expect(stop).toHaveBeenCalledWith({ laneId: "lane-sibling" });
  });

  it("dismisses for the session when × clicked", () => {
    const status = makeStatus([makeVm({ state: "running" })]);
    const { container } = render(
      <MacosVmCrossLaneBanner status={status} activeLaneId="lane-active" />,
    );
    expect(container.querySelector('[data-testid="macos-vm-cross-lane-banner"]')).toBeTruthy();
    fireEvent.click(screen.getByLabelText("Dismiss cross-lane banner"));
    expect(container.querySelector('[data-testid="macos-vm-cross-lane-banner"]')).toBeNull();
  });
});
