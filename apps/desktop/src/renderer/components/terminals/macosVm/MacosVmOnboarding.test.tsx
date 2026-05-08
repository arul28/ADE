/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MacosVmBaseRecord,
  MacosVmEventPayload,
  MacosVmStatus,
} from "../../../../shared/types";
import { MacosVmOnboarding } from "./MacosVmOnboarding";

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
      detail: "Apple Virtualization helper available.",
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
    id: "base-test-1",
    provider: "apple-virtualization-helper",
    name: "macOS 26.3",
    state: "creating",
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
    metadata: {
      provisionMessage: "Starting provision…",
      provisionProgress: 0.05,
      provisionStage: "configure",
    },
    ...overrides,
  };
}

type MacosVmEventListener = (event: MacosVmEventPayload) => void;

let mockMacosVm: ReturnType<typeof buildMacosVmMock>;
let eventListeners: MacosVmEventListener[];

function buildMacosVmMock() {
  return {
    getStatus: vi.fn(async () => buildStatus()),
    getScreenRecordingStatus: vi.fn(async () => ({
      status: "granted",
      detail: "Screen Recording is allowed.",
    })),
    getHostCapabilities: vi.fn(async () => ({
      model: "Mac16,1",
      cpuCount: 12,
      memoryBytes: 32 * 1024 ** 3,
      freeMemoryBytes: 18 * 1024 ** 3,
      freeDiskBytes: 60 * 1024 ** 3,
      totalDiskBytes: 512 * 1024 ** 3,
      recommended: {
        cpuCores: 4,
        memory: "8GB",
        diskSize: "80GB",
      },
    })),
    createBase: vi.fn(async (args?: any) => buildBase({ name: args?.name ?? "macOS 26.3" })),
    startBase: vi.fn(async (args?: any) =>
      buildBase({ name: args?.name ?? "macOS 26.3", state: "starting" }),
    ),
    stopBase: vi.fn(async (args?: any) =>
      buildBase({ name: args?.name ?? "macOS 26.3", state: "stopped" }),
    ),
    markBaseReady: vi.fn(async (args?: any) =>
      buildBase({ name: args?.name ?? "macOS 26.3", state: "ready" }),
    ),
    deleteBase: vi.fn(async () => ({ deleted: true, previous: null })),
    renameBase: vi.fn(async (args: { from: string; to: string }) =>
      buildBase({ name: args.to, state: "stopped" }),
    ),
    saveLaneVmAsSnapshot: vi.fn(async (_args: any) => buildBase({ state: "ready" })),
    clearIpswCache: vi.fn(async () => ({ cleared: true, path: "/tmp/restore-images", bytesFreed: 0 })),
    provision: vi.fn(),
    start: vi.fn(async () => ({}) as any),
    stop: vi.fn(),
    delete: vi.fn(),
    getAgentGuide: vi.fn(),
    focusWindow: vi.fn(),
    focusBaseWindow: vi.fn(async () => ({
      laneId: "base:macOS 26.3",
      vmName: "macOS 26.3",
      windowTitleQuery: "macOS 26.3",
      processName: "macos-vm-helper",
      windowTitle: "macOS 26.3",
      frame: { x: 0, y: 0, width: 1280, height: 800 },
      focusedAt: NOW,
    })),
    captureScreenshot: vi.fn(async () => ({
      ok: true,
      laneId: "lane-test",
      vmName: "any",
      path: "/tmp/probe.png",
      capturedAt: NOW,
      captureMode: "window-region",
      window: {
        laneId: "lane-test",
        vmName: "any",
        windowTitleQuery: "any",
        processName: "macos-vm-helper",
        windowTitle: "any",
        frame: null,
        focusedAt: NOW,
      },
    })),
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

function emit(event: MacosVmEventPayload) {
  for (const listener of [...eventListeners]) {
    listener(event);
  }
}

async function passSystemCheck(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /get started/i }));
  const screenRow = await screen.findByTestId("wizard-check-screen-recording");
  await waitFor(() => {
    expect(screenRow.getAttribute("data-tone")).toBe("ok");
  });
  await user.click(screen.getByTestId("wizard-systemCheck-override"));
  const sysContinue = screen.getByTestId("wizard-systemCheck-continue") as HTMLButtonElement;
  await waitFor(() => {
    expect(sysContinue.disabled).toBe(false);
  });
  await user.click(sysContinue);
}

describe("MacosVmOnboarding", () => {
  const originalAde = (globalThis.window as any).ade;

  beforeEach(() => {
    eventListeners = [];
    mockMacosVm = buildMacosVmMock();
    (globalThis.window as any).ade = {
      macosVm: mockMacosVm,
      app: {
        openExternal: vi.fn(async () => undefined),
      },
    };
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

  it("starts on the welcome step and advances on Get started", async () => {
    const user = userEvent.setup();
    render(<MacosVmOnboarding status={buildStatus()} laneId="lane-1" />);

    expect(screen.getByTestId("wizard-step-welcome")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /get started/i }));

    expect(screen.getByTestId("wizard-step-systemCheck")).toBeTruthy();
  });

  it("blocks System Check Continue when permission probe fails until override is acknowledged", async () => {
    (mockMacosVm.getScreenRecordingStatus as any).mockResolvedValue({
      status: "denied",
      detail: "Screen recording permission denied",
    });

    const user = userEvent.setup();
    render(<MacosVmOnboarding status={buildStatus()} laneId="lane-1" />);

    await user.click(screen.getByRole("button", { name: /get started/i }));

    const screenRow = await screen.findByTestId("wizard-check-screen-recording");
    await waitFor(() => {
      expect(screenRow.getAttribute("data-tone")).toBe("fail");
    });

    const continueBtn = screen.getByTestId("wizard-systemCheck-continue") as HTMLButtonElement;
    expect(continueBtn.disabled).toBe(true);

    // Override is shown (warnings exist), but required failure keeps Continue disabled.
    await user.click(screen.getByTestId("wizard-systemCheck-override"));
    expect(continueBtn.disabled).toBe(true);
  });

  it("allows continuing past System Check when permission is granted (warnings only)", async () => {
    const user = userEvent.setup();
    render(<MacosVmOnboarding status={buildStatus()} laneId="lane-1" />);
    await passSystemCheck(user);
    expect(screen.getByTestId("wizard-step-configure")).toBeTruthy();
  });

  it("Configure → Install calls createBase with the form values and lands on Install", async () => {
    const user = userEvent.setup();
    render(<MacosVmOnboarding status={buildStatus()} laneId="lane-1" />);
    await passSystemCheck(user);

    // Configure step — clear the name and verify Continue gates.
    const nameInput = screen.getByTestId("wizard-configure-name") as HTMLInputElement;
    expect(nameInput.value).toBe("macOS 26.3");
    const configureContinue = screen.getByTestId("wizard-configure-continue") as HTMLButtonElement;
    expect(configureContinue.disabled).toBe(false);

    await user.clear(nameInput);
    expect(configureContinue.disabled).toBe(true);

    await user.type(nameInput, "macOS dev");
    expect(configureContinue.disabled).toBe(false);

    await user.click(configureContinue);

    expect(mockMacosVm.createBase).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "macOS dev",
        cpuCores: 4,
        memory: "8GB",
        diskSize: "80GB",
        display: "1440x900",
      }),
    );

    expect(await screen.findByTestId("wizard-step-install")).toBeTruthy();
  });

  it("Install: Continue is gated until the base reaches a completed state, then advances to First boot", async () => {
    const user = userEvent.setup();
    render(<MacosVmOnboarding status={buildStatus()} laneId="lane-1" />);

    await passSystemCheck(user);
    await user.click(screen.getByTestId("wizard-configure-continue"));

    await screen.findByTestId("wizard-step-install");

    const installContinue = screen.getByTestId("wizard-install-continue") as HTMLButtonElement;
    expect(installContinue.disabled).toBe(true);

    // Push a base-updated event with state=setup_required (install finished, ready
    // for first boot).
    act(() => {
      emit({
        type: "base-updated",
        base: buildBase({
          state: "setup_required",
          metadata: {
            provisionMessage: "Install complete. Start the base to finish setup.",
            provisionProgress: 1,
            provisionStage: "install",
          },
        }),
      });
    });

    await waitFor(() => {
      expect((screen.getByTestId("wizard-install-continue") as HTMLButtonElement).disabled).toBe(false);
    });

    await user.click(screen.getByTestId("wizard-install-continue"));

    expect(mockMacosVm.startBase).toHaveBeenCalledWith({
      name: "macOS 26.3",
      openDisplay: true,
    });

    expect(await screen.findByTestId("wizard-step-firstBoot")).toBeTruthy();
  });

  it("Install cancel calls deleteBase and returns to Configure", async () => {
    const user = userEvent.setup();
    render(<MacosVmOnboarding status={buildStatus()} laneId="lane-1" />);

    await passSystemCheck(user);
    await user.click(screen.getByTestId("wizard-configure-continue"));
    await screen.findByTestId("wizard-step-install");

    await user.click(screen.getByTestId("wizard-install-cancel"));

    expect(mockMacosVm.deleteBase).toHaveBeenCalledWith({
      name: "macOS 26.3",
      force: true,
    });

    expect(await screen.findByTestId("wizard-step-configure")).toBeTruthy();
  });

  it("Install failure explains pending host updates and retries through the resolver", async () => {
    const user = userEvent.setup();
    const failedBase = buildBase({
      state: "failed",
      lastError: "A software update is required to complete the installation.",
      metadata: {
        provisionMessage: "A software update is required to complete the installation.",
        ipswHostState: {
          pendingBuild: "25E253",
          pendingProductVersion: "26.4.1",
          currentBuild: "25D125",
          model: "Mac16,1",
        },
        ipswAlternatives: [
          {
            build: "25E253",
            productVersion: "26.4.1",
            supportedDeviceModels: ["Mac16,1"],
            firmwareUrl: "https://updates.example/UniversalMac_26.4.1_25E253.ipsw",
            sizeBytes: 17_300_000_000,
          },
        ],
      },
    });
    render(
      <MacosVmOnboarding
        status={buildStatus({ bases: [failedBase] })}
        laneId="lane-1"
        initialStep="install"
        initialBaseName="macOS 26.3"
      />,
    );

    expect(screen.getByTestId("wizard-install-failure-card").textContent).toContain("macOS update waiting");
    expect(screen.getByTestId("wizard-install-failure-card").textContent).toContain("26.4.1");

    await user.click(screen.getByRole("button", { name: /retry/i }));

    await waitFor(() => {
      expect(mockMacosVm.createBase).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "macOS 26.3",
          ipsw: "latest",
          force: true,
        }),
      );
    });
  });

  it("First boot 'I finished setup' is gated on running state, focus button calls focusBaseWindow", async () => {
    const user = userEvent.setup();
    render(<MacosVmOnboarding status={buildStatus()} laneId="lane-1" />);

    await passSystemCheck(user);
    await user.click(screen.getByTestId("wizard-configure-continue"));
    await screen.findByTestId("wizard-step-install");
    act(() => {
      emit({
        type: "base-updated",
        base: buildBase({
          state: "setup_required",
          metadata: { provisionProgress: 1, provisionStage: "install" },
        }),
      });
    });
    await waitFor(() => {
      expect((screen.getByTestId("wizard-install-continue") as HTMLButtonElement).disabled).toBe(false);
    });
    await user.click(screen.getByTestId("wizard-install-continue"));

    await screen.findByTestId("wizard-step-firstBoot");

    const finishedBtn = screen.getByTestId("wizard-firstBoot-finished") as HTMLButtonElement;
    expect(finishedBtn.disabled).toBe(true);

    // Focus button click triggers focusBaseWindow with the active base name.
    await user.click(screen.getByTestId("wizard-firstBoot-focus"));
    expect(mockMacosVm.focusBaseWindow).toHaveBeenCalledWith({ name: "macOS 26.3" });

    // Once running, finished should enable.
    act(() => {
      emit({
        type: "base-updated",
        base: buildBase({ state: "running", metadata: {} }),
      });
    });
    await waitFor(() => {
      expect((screen.getByTestId("wizard-firstBoot-finished") as HTMLButtonElement).disabled).toBe(false);
    });

    await user.click(screen.getByTestId("wizard-firstBoot-finished"));
    expect(await screen.findByTestId("wizard-step-snapshot")).toBeTruthy();
  });

  it("Save snapshot stops + renames + marks ready, then Done CTA starts the lane VM", async () => {
    const user = userEvent.setup();
    render(<MacosVmOnboarding status={buildStatus()} laneId="lane-feature" />);

    await passSystemCheck(user);
    await user.click(screen.getByTestId("wizard-configure-continue"));
    await screen.findByTestId("wizard-step-install");
    act(() => {
      emit({
        type: "base-updated",
        base: buildBase({ state: "setup_required", metadata: { provisionProgress: 1 } }),
      });
    });
    await waitFor(() => {
      expect((screen.getByTestId("wizard-install-continue") as HTMLButtonElement).disabled).toBe(false);
    });
    await user.click(screen.getByTestId("wizard-install-continue"));
    await screen.findByTestId("wizard-step-firstBoot");
    act(() => {
      emit({ type: "base-updated", base: buildBase({ state: "running", metadata: {} }) });
    });
    await waitFor(() => {
      expect((screen.getByTestId("wizard-firstBoot-finished") as HTMLButtonElement).disabled).toBe(false);
    });
    await user.click(screen.getByTestId("wizard-firstBoot-finished"));
    await screen.findByTestId("wizard-step-snapshot");

    const nameInput = screen.getByTestId("wizard-snapshot-name") as HTMLInputElement;
    await user.clear(nameInput);
    await user.type(nameInput, "clean macOS dev");

    await user.click(screen.getByTestId("wizard-snapshot-save"));

    await waitFor(() => {
      expect(mockMacosVm.stopBase).toHaveBeenCalledWith({ name: "macOS 26.3" });
      expect(mockMacosVm.renameBase).toHaveBeenCalledWith({ from: "macOS 26.3", to: "clean macOS dev" });
      expect(mockMacosVm.markBaseReady).toHaveBeenCalledWith({ name: "clean macOS dev" });
    });

    expect(await screen.findByTestId("wizard-step-done")).toBeTruthy();

    await user.click(screen.getByTestId("wizard-done-open"));

    await waitFor(() => {
      expect(mockMacosVm.start).toHaveBeenCalledWith({
        laneId: "lane-feature",
        fromBase: true,
        baseName: "clean macOS dev",
        createIfMissing: true,
        openDisplay: true,
      });
    });
  });
});
