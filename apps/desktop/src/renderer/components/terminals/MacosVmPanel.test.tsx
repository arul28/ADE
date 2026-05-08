/* @vitest-environment jsdom */

import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MacosVmBaseRecord,
  MacosVmEventPayload,
  MacosVmRecord,
  MacosVmStatus,
} from "../../../shared/types";
import { MacosVmPanel } from "./MacosVmPanel";

const NOW = "2026-05-07T12:00:00.000Z";

vi.mock("./macosVm/MacosVmOnboarding", () => ({
  MacosVmOnboarding: ({
    laneId,
    initialStep,
    initialBaseName,
  }: {
    laneId: string;
    initialStep?: string;
    initialBaseName?: string | null;
  }) => (
    <div
      data-testid="route-onboarding"
      data-lane-id={laneId}
      data-initial-step={initialStep ?? ""}
      data-initial-base-name={initialBaseName ?? ""}
    />
  ),
}));

vi.mock("./macosVm/MacosVmEmpty", () => ({
  MacosVmEmpty: ({ laneId }: { laneId: string }) => (
    <div data-testid="route-empty" data-lane-id={laneId} />
  ),
}));

vi.mock("./macosVm/MacosVmCockpit", () => ({
  MacosVmCockpit: ({ vm }: { vm: MacosVmRecord }) => (
    <div data-testid="route-cockpit" data-vm-state={vm.state} />
  ),
}));

vi.mock("./macosVm/MacosVmSetupRequired", () => ({
  MacosVmSetupRequired: ({ laneId, onResumeWizard }: { laneId: string; onResumeWizard: () => void }) => (
    <div
      data-testid="route-setup-required"
      data-lane-id={laneId}
      onClick={onResumeWizard}
    />
  ),
}));

vi.mock("./macosVm/MacosVmProvisioning", () => ({
  MacosVmProvisioning: ({ vm }: { vm: MacosVmRecord }) => (
    <div data-testid="route-provisioning" data-vm-state={vm.state} />
  ),
}));

vi.mock("./macosVm/MacosVmTransient", () => ({
  MacosVmTransient: ({ variant }: { variant: string }) => (
    <div data-testid="route-transient" data-variant={variant} />
  ),
}));

vi.mock("./macosVm/MacosVmFailed", () => ({
  MacosVmFailed: ({ vm }: { vm: MacosVmRecord }) => (
    <div data-testid="route-failed" data-vm-state={vm.state} />
  ),
}));

vi.mock("./macosVm/UnsupportedHost", () => ({
  UnsupportedHost: () => <div data-testid="route-unsupported" />,
}));

vi.mock("./macosVm/ProviderUnavailable", () => ({
  ProviderUnavailable: () => <div data-testid="route-provider-unavailable" />,
}));

vi.mock("./macosVm/MacosVmCrossLaneBanner", () => ({
  MacosVmCrossLaneBanner: () => <div data-testid="overlay-cross-lane-banner" />,
}));

vi.mock("./macosVm/MacosVmRunningBar", () => ({
  MacosVmRunningBar: () => <div data-testid="overlay-running-bar" />,
}));

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
    metadata: {},
    ...overrides,
  };
}

type MacosVmEventListener = (event: MacosVmEventPayload) => void;
let eventListeners: MacosVmEventListener[] = [];

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
    start: vi.fn(),
    stop: vi.fn(),
    delete: vi.fn(),
    getAgentGuide: vi.fn(),
    focusWindow: vi.fn(),
    focusBaseWindow: vi.fn(),
    captureScreenshot: vi.fn(),
    selectPoint: vi.fn(),
    click: vi.fn(),
    typeText: vi.fn(),
    onEvent: vi.fn((cb: MacosVmEventListener) => {
      eventListeners.push(cb);
      return () => {
        eventListeners = eventListeners.filter((l) => l !== cb);
      };
    }),
  };
}

async function renderPanel(status: MacosVmStatus) {
  const mockMacosVm = buildMacosVmMock(status);
  (globalThis.window as any).ade = {
    macosVm: mockMacosVm,
    app: { openExternal: vi.fn(async () => undefined) },
  };
  const utils = render(<MacosVmPanel laneId="lane-1" laneRoot="/lanes/lane-1" />);
  await waitFor(() => {
    expect(mockMacosVm.getStatus).toHaveBeenCalled();
  });
  return { ...utils, mockMacosVm };
}

describe("MacosVmPanel router", () => {
  const originalAde = (globalThis.window as any).ade;

  beforeEach(() => {
    eventListeners = [];
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

  it("renders UnsupportedHost when status.supported is false", async () => {
    await renderPanel(buildStatus({ supported: false }));
    await waitFor(() => {
      expect(screen.getByTestId("route-unsupported")).toBeTruthy();
    });
  });

  it("renders ProviderUnavailable when activeProvider.available is false", async () => {
    await renderPanel(
      buildStatus({
        activeProvider: {
          kind: "apple-virtualization-helper",
          available: false,
          version: null,
          detail: "helper missing",
          docsUrl: "https://example.test/docs",
        },
      }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("route-provider-unavailable")).toBeTruthy();
    });
  });

  it("renders MacosVmOnboarding when no ready bases exist", async () => {
    await renderPanel(
      buildStatus({
        bases: [],
      }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("route-onboarding")).toBeTruthy();
    });
  });

  it("re-enters the wizard at install when no ready bases but a base is creating", async () => {
    await renderPanel(
      buildStatus({
        bases: [buildBase({ state: "creating", name: "installing-base" })],
      }),
    );
    await waitFor(() => {
      const node = screen.getByTestId("route-onboarding");
      expect(node.getAttribute("data-initial-step")).toBe("install");
      expect(node.getAttribute("data-initial-base-name")).toBe("installing-base");
    });
  });

  it("renders MacosVmEmpty when ready bases exist but laneVm is null", async () => {
    await renderPanel(
      buildStatus({
        defaultBase: buildBase(),
        bases: [buildBase()],
        laneVm: null,
      }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("route-empty")).toBeTruthy();
    });
  });

  it("renders MacosVmCockpit when laneVm.state is running", async () => {
    const vm = buildVm({ state: "running" });
    await renderPanel(
      buildStatus({
        defaultBase: buildBase(),
        bases: [buildBase()],
        laneVm: vm,
        vms: [vm],
      }),
    );
    await waitFor(() => {
      const node = screen.getByTestId("route-cockpit");
      expect(node.getAttribute("data-vm-state")).toBe("running");
    });
  });

  it("renders MacosVmCockpit when laneVm.state is stopped (no Stopped wrapper)", async () => {
    const vm = buildVm({ state: "stopped" });
    await renderPanel(
      buildStatus({
        defaultBase: buildBase(),
        bases: [buildBase()],
        laneVm: vm,
        vms: [vm],
      }),
    );
    await waitFor(() => {
      const node = screen.getByTestId("route-cockpit");
      expect(node.getAttribute("data-vm-state")).toBe("stopped");
    });
  });

  it("renders MacosVmCockpit when laneVm.state is paused", async () => {
    const vm = buildVm({ state: "paused" });
    await renderPanel(
      buildStatus({
        defaultBase: buildBase(),
        bases: [buildBase()],
        laneVm: vm,
        vms: [vm],
      }),
    );
    await waitFor(() => {
      const node = screen.getByTestId("route-cockpit");
      expect(node.getAttribute("data-vm-state")).toBe("paused");
    });
  });

  it("renders MacosVmSetupRequired when laneVm.state is setup_required", async () => {
    const vm = buildVm({ state: "setup_required" });
    await renderPanel(
      buildStatus({
        defaultBase: buildBase(),
        bases: [buildBase()],
        laneVm: vm,
        vms: [vm],
      }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("route-setup-required")).toBeTruthy();
    });
  });

  it("clicking Resume in wizard from MacosVmSetupRequired re-enters onboarding at firstBoot", async () => {
    const vm = buildVm({ state: "setup_required", name: "wip-vm" });
    await renderPanel(
      buildStatus({
        defaultBase: buildBase(),
        bases: [buildBase()],
        laneVm: vm,
        vms: [vm],
      }),
    );
    const setupNode = await screen.findByTestId("route-setup-required");
    setupNode.click();
    await waitFor(() => {
      const node = screen.getByTestId("route-onboarding");
      expect(node.getAttribute("data-initial-step")).toBe("firstBoot");
      expect(node.getAttribute("data-initial-base-name")).toBe("wip-vm");
    });
  });

  it("re-enters the wizard at firstBoot when no ready bases but a base is at setup_required", async () => {
    await renderPanel(
      buildStatus({
        bases: [buildBase({ state: "setup_required", name: "wip" })],
      }),
    );
    await waitFor(() => {
      const node = screen.getByTestId("route-onboarding");
      expect(node.getAttribute("data-initial-step")).toBe("firstBoot");
      expect(node.getAttribute("data-initial-base-name")).toBe("wip");
    });
  });

  it("renders MacosVmProvisioning during creating/installing", async () => {
    const vm = buildVm({ state: "installing" });
    await renderPanel(
      buildStatus({
        defaultBase: buildBase(),
        bases: [buildBase()],
        laneVm: vm,
        vms: [vm],
      }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("route-provisioning")).toBeTruthy();
    });
  });

  it("renders MacosVmTransient with variant=starting when state is starting", async () => {
    const vm = buildVm({ state: "starting" });
    await renderPanel(
      buildStatus({
        defaultBase: buildBase(),
        bases: [buildBase()],
        laneVm: vm,
        vms: [vm],
      }),
    );
    await waitFor(() => {
      const node = screen.getByTestId("route-transient");
      expect(node.getAttribute("data-variant")).toBe("starting");
    });
  });

  it("renders MacosVmTransient with variant=stopping when state is stopping", async () => {
    const vm = buildVm({ state: "stopping" });
    await renderPanel(
      buildStatus({
        defaultBase: buildBase(),
        bases: [buildBase()],
        laneVm: vm,
        vms: [vm],
      }),
    );
    await waitFor(() => {
      const node = screen.getByTestId("route-transient");
      expect(node.getAttribute("data-variant")).toBe("stopping");
    });
  });

  it("renders MacosVmFailed when state is failed", async () => {
    const vm = buildVm({ state: "failed", lastError: "boom" });
    await renderPanel(
      buildStatus({
        defaultBase: buildBase(),
        bases: [buildBase()],
        laneVm: vm,
        vms: [vm],
      }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("route-failed")).toBeTruthy();
    });
  });

  it("renders cross-lane banner and running bar overlays alongside the active screen", async () => {
    const vm = buildVm({ state: "running" });
    await renderPanel(
      buildStatus({
        defaultBase: buildBase(),
        bases: [buildBase()],
        laneVm: vm,
        vms: [vm],
      }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("route-cockpit")).toBeTruthy();
      expect(screen.getByTestId("overlay-cross-lane-banner")).toBeTruthy();
      expect(screen.getByTestId("overlay-running-bar")).toBeTruthy();
    });
  });
});
