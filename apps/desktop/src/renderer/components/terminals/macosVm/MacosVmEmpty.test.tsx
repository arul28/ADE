/* @vitest-environment jsdom */

import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MacosVmBaseRecord, MacosVmStatus } from "../../../../shared/types";
import { MacosVmEmpty } from "./MacosVmEmpty";

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

function buildMacosVmMock(initialStatus: MacosVmStatus) {
  return {
    getStatus: vi.fn(async () => initialStatus),
    createBase: vi.fn(),
    startBase: vi.fn(),
    stopBase: vi.fn(),
    markBaseReady: vi.fn(),
    deleteBase: vi.fn(),
    renameBase: vi.fn(),
    saveLaneVmAsSnapshot: vi.fn(),
    clearIpswCache: vi.fn(),
    provision: vi.fn(),
    start: vi.fn(async () => ({})),
    stop: vi.fn(),
    delete: vi.fn(),
    getAgentGuide: vi.fn(),
    focusWindow: vi.fn(),
    focusBaseWindow: vi.fn(),
    captureScreenshot: vi.fn(),
    selectPoint: vi.fn(),
    click: vi.fn(),
    typeText: vi.fn(),
    onEvent: vi.fn(() => () => {}),
  };
}

describe("MacosVmEmpty", () => {
  const originalAde = (globalThis.window as any).ade;
  let mockMacosVm: ReturnType<typeof buildMacosVmMock>;

  function installMock(status: MacosVmStatus) {
    mockMacosVm = buildMacosVmMock(status);
    (globalThis.window as any).ade = {
      macosVm: mockMacosVm,
      app: { openExternal: vi.fn(async () => undefined) },
    };
  }

  beforeEach(() => {
    installMock(buildStatus());
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

  it("renders the SnapshotPicker with all ready bases, default first", () => {
    const a = buildBase({ id: "base-a", name: "alpha", createdAt: "2026-04-01T00:00:00.000Z" });
    const b = buildBase({ id: "base-b", name: "beta-default", createdAt: "2026-04-02T00:00:00.000Z" });
    const c = buildBase({ id: "base-c", name: "gamma", createdAt: "2026-04-03T00:00:00.000Z" });
    const status = buildStatus({ defaultBase: b, bases: [a, b, c] });

    render(<MacosVmEmpty status={status} laneId="lane-1" bases={[a, b, c]} />);

    const select = screen.getByLabelText(/choose snapshot to clone/i) as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.value);
    expect(options[0]).toBe("beta-default");
    expect(options).toContain("alpha");
    expect(options).toContain("gamma");
  });

  it("disables the Start lane VM button when there are no snapshots", () => {
    render(<MacosVmEmpty status={buildStatus()} laneId="lane-1" bases={[]} />);
    const start = screen.getByRole("button", { name: /start lane vm/i }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
  });

  it("Start lane VM calls macosVm.start with the chosen baseName, fromBase, createIfMissing, openDisplay", async () => {
    const user = userEvent.setup();
    const a = buildBase({ id: "base-a", name: "alpha" });
    const b = buildBase({ id: "base-b", name: "beta-default" });
    const status = buildStatus({ defaultBase: b, bases: [a, b], vms: [] });
    installMock(status);

    render(<MacosVmEmpty status={status} laneId="lane-1" bases={[a, b]} />);

    const select = screen.getByLabelText(/choose snapshot to clone/i) as HTMLSelectElement;
    await user.selectOptions(select, "alpha");

    const start = screen.getByRole("button", { name: /start lane vm/i });
    await user.click(start);

    await waitFor(() => {
      expect(mockMacosVm.getStatus).toHaveBeenCalled();
      expect(mockMacosVm.start).toHaveBeenCalledWith(
        expect.objectContaining({
          laneId: "lane-1",
          fromBase: true,
          baseName: "alpha",
          createIfMissing: true,
          openDisplay: true,
        }),
      );
    });
  });

  it("Customize resources disclosure reveals the resource form", async () => {
    const user = userEvent.setup();
    const base = buildBase();
    const status = buildStatus({ defaultBase: base, bases: [base] });

    render(<MacosVmEmpty status={status} laneId="lane-1" bases={[base]} />);

    const toggle = screen.getByRole("button", { name: /customize cpu, memory/i });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    await user.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("CPU")).toBeTruthy();
    expect(screen.getByText("Memory")).toBeTruthy();
  });
});
