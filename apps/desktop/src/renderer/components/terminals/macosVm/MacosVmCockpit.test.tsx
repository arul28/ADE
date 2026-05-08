/* @vitest-environment jsdom */

import React from "react";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MacosVmBaseRecord,
  MacosVmRecord,
  MacosVmStatus,
} from "../../../../shared/types";
import { MacosVmCockpit } from "./MacosVmCockpit";

const NOW = "2026-05-07T12:00:00.000Z";

function buildStatus(overrides: Partial<MacosVmStatus> = {}): MacosVmStatus {
  return {
    platform: "darwin",
    arch: "arm64",
    supported: true,
    checkedAt: NOW,
    activeProvider: {
      kind: "apple-virtualization-helper",
      available: true,
      version: "15.1",
      detail: "OK",
      docsUrl: "https://developer.apple.com/documentation/virtualization",
    },
    tools: [],
    laneVm: null,
    vms: [],
    defaultBase: null,
    bases: [],
    docs: {
      appleVirtualization: "https://developer.apple.com/documentation/virtualization/virtualize-macos-on-a-mac",
      appleSharedDirectories: "https://developer.apple.com/documentation/virtualization/vzvirtiofilesystemdeviceconfiguration",
    },
    ...overrides,
  };
}

function buildBase(overrides: Partial<MacosVmBaseRecord> = {}): MacosVmBaseRecord {
  return {
    id: "base-1",
    provider: "apple-virtualization-helper",
    name: "clean macOS 26.3",
    state: "ready",
    cpuCores: 2,
    memory: "4GB",
    diskSize: "64GB",
    display: "1440x900",
    guestSharedPath: "/Volumes/My Shared Files",
    createdAt: NOW,
    updatedAt: NOW,
    lastStartedAt: null,
    lastStoppedAt: null,
    lastError: null,
    metadata: {},
    ...overrides,
  };
}

function buildVm(overrides: Partial<MacosVmRecord> = {}): MacosVmRecord {
  return {
    id: "vm-1",
    provider: "apple-virtualization-helper",
    name: "lane-1-vm",
    laneId: "lane-1",
    laneName: "lane-1",
    laneRoot: "/lanes/lane-1",
    state: "running",
    cpuCores: 2,
    memory: "4GB",
    diskSize: "64GB",
    display: "1440x900",
    guestSharedPath: "/Volumes/My Shared Files",
    sharedDirectory: "/lanes/lane-1",
    createdAt: NOW,
    updatedAt: NOW,
    lastStartedAt: NOW,
    lastStoppedAt: null,
    ipAddress: "192.168.65.10",
    sshCommand: "ssh user@192.168.65.10",
    vncUrl: null,
    lastError: null,
    metadata: { fromBaseName: "clean macOS 26.3", bundlePath: "/var/ade/vm-1" },
    ...overrides,
  };
}

function buildMacosVmMock() {
  return {
    getStatus: vi.fn(),
    createBase: vi.fn(),
    startBase: vi.fn(),
    stopBase: vi.fn(),
    markBaseReady: vi.fn(),
    deleteBase: vi.fn(async () => ({ deleted: true, previous: null })),
    renameBase: vi.fn(async () => buildBase({ name: "renamed" })),
    saveLaneVmAsSnapshot: vi.fn(async () => buildBase({ name: "saved" })),
    clearIpswCache: vi.fn(async () => ({ cleared: true, path: "/tmp/restore-images", bytesFreed: 0 })),
    provision: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    delete: vi.fn(),
    getAgentGuide: vi.fn(),
    focusWindow: vi.fn(async () => ({
      laneId: "lane-1",
      vmName: "lane-1-vm",
      windowTitleQuery: "lane-1-vm",
      processName: "macos-vm-helper",
      windowTitle: "lane-1-vm",
      frame: { x: 0, y: 0, width: 1280, height: 800 },
      focusedAt: NOW,
    })),
    focusBaseWindow: vi.fn(),
    captureScreenshot: vi.fn(),
    selectPoint: vi.fn(),
    click: vi.fn(),
    typeText: vi.fn(),
    onEvent: vi.fn(() => () => {}),
  };
}

describe("MacosVmCockpit", () => {
  const originalAde = (globalThis.window as any).ade;
  let mockMacosVm: ReturnType<typeof buildMacosVmMock>;

  beforeEach(() => {
    mockMacosVm = buildMacosVmMock();
    (globalThis.window as any).ade = {
      macosVm: mockMacosVm,
      app: { openExternal: vi.fn(async () => undefined) },
    };
    (globalThis.window as any).confirm = vi.fn(() => true);
    (globalThis.window as any).prompt = vi.fn(() => "renamed snapshot");
  });

  afterEach(() => {
    cleanup();
    if (originalAde === undefined) {
      delete (globalThis.window as any).ade;
    } else {
      (globalThis.window as any).ade = originalAde;
    }
    vi.restoreAllMocks();
  });

  it("Save snapshot is disabled while VM is running, enabled when stopped", async () => {
    const base = buildBase();
    const status = buildStatus({ defaultBase: base, bases: [base] });

    const { rerender } = render(
      <MacosVmCockpit status={status} vm={buildVm({ state: "running" })} laneId="lane-1" bases={[base]} />,
    );

    const headerSaveButton = screen.getAllByRole("button", { name: /save snapshot/i })[0] as HTMLButtonElement;
    expect(headerSaveButton.disabled).toBe(true);

    rerender(
      <MacosVmCockpit status={status} vm={buildVm({ state: "stopped" })} laneId="lane-1" bases={[base]} />,
    );

    const headerSaveButtonAfterStop = screen.getAllByRole("button", { name: /save snapshot/i })[0] as HTMLButtonElement;
    expect(headerSaveButtonAfterStop.disabled).toBe(false);
  });

  it("renders all four collapsed drawers (Snapshots, Resources, SSH/IP, Advanced)", () => {
    const base = buildBase();
    const status = buildStatus({ defaultBase: base, bases: [base] });
    render(
      <MacosVmCockpit status={status} vm={buildVm({ state: "running" })} laneId="lane-1" bases={[base]} />,
    );
    expect(screen.getByTestId("cockpit-drawer-snapshots")).toBeTruthy();
    expect(screen.getByTestId("cockpit-drawer-resources")).toBeTruthy();
    expect(screen.getByTestId("cockpit-drawer-ssh")).toBeTruthy();
    expect(screen.getByTestId("cockpit-drawer-advanced")).toBeTruthy();
  });

  it("Bring VM window forward calls focusWindow with the lane id", async () => {
    const user = userEvent.setup();
    const base = buildBase();
    const status = buildStatus({ defaultBase: base, bases: [base] });
    render(
      <MacosVmCockpit status={status} vm={buildVm({ state: "running" })} laneId="lane-1" bases={[base]} />,
    );

    const focusButton = screen.getByRole("button", { name: /bring vm window forward/i });
    await user.click(focusButton);

    await waitFor(() => {
      expect(mockMacosVm.focusWindow).toHaveBeenCalledWith({ laneId: "lane-1" });
    });
  });

  it("snapshots drawer rename invokes renameBase via window.prompt", async () => {
    const user = userEvent.setup();
    const base = buildBase({ name: "clean macOS 26.3" });
    const status = buildStatus({ defaultBase: base, bases: [base] });
    render(
      <MacosVmCockpit status={status} vm={buildVm({ state: "running" })} laneId="lane-1" bases={[base]} />,
    );

    await user.click(screen.getByRole("button", { name: /^snapshots/i }));
    await user.click(screen.getByRole("button", { name: /rename snapshot clean macos 26\.3/i }));

    await waitFor(() => {
      expect(mockMacosVm.renameBase).toHaveBeenCalledWith({ from: "clean macOS 26.3", to: "renamed snapshot" });
    });
  });

  it("snapshots drawer delete invokes deleteBase after confirm", async () => {
    const user = userEvent.setup();
    const base = buildBase({ name: "clean macOS 26.3" });
    const status = buildStatus({ defaultBase: base, bases: [base] });
    render(
      <MacosVmCockpit status={status} vm={buildVm({ state: "running" })} laneId="lane-1" bases={[base]} />,
    );

    await user.click(screen.getByRole("button", { name: /^snapshots/i }));
    await user.click(screen.getByRole("button", { name: /delete snapshot clean macos 26\.3/i }));

    await waitFor(() => {
      expect(mockMacosVm.deleteBase).toHaveBeenCalledWith({ name: "clean macOS 26.3", force: true });
    });
  });

  it("Save snapshot dialog calls saveLaneVmAsSnapshot with lane id and trimmed name", async () => {
    const user = userEvent.setup();
    const base = buildBase();
    const status = buildStatus({ defaultBase: base, bases: [base] });
    render(
      <MacosVmCockpit status={status} vm={buildVm({ state: "stopped" })} laneId="lane-1" bases={[base]} />,
    );

    // Open via header Save snapshot button
    const headerSaveButton = screen.getAllByRole("button", { name: /save snapshot/i })[0];
    await user.click(headerSaveButton);

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeTruthy();

    const nameInput = screen.getByLabelText(/snapshot name/i) as HTMLInputElement;
    await user.clear(nameInput);
    await user.type(nameInput, "manual snapshot");

    const dialogSave = await within(dialog).findByRole("button", { name: /save snapshot/i });
    await user.click(dialogSave);

    await waitFor(() => {
      expect(mockMacosVm.saveLaneVmAsSnapshot).toHaveBeenCalledWith({
        laneId: "lane-1",
        name: "manual snapshot",
        description: null,
      });
    });
  });
});
