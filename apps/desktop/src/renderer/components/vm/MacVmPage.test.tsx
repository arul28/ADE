/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LaneSummary,
  MacosVmEventPayload,
  MacosVmRecord,
  MacosVmStatus,
} from "../../../shared/types";
import { useAppStore } from "../../state/appStore";
import { MacVmPage } from "./MacVmPage";

vi.mock("@novnc/novnc", () => ({
  default: vi.fn().mockImplementation(() => ({
    addEventListener: vi.fn(),
    sendCredentials: vi.fn(),
    disconnect: vi.fn(),
  })),
}));

const originalAde = globalThis.window.ade;
const originalConfirm = globalThis.window.confirm;

const baseLane: LaneSummary = {
  id: "lane-1",
  name: "VM lane",
  laneType: "worktree",
  baseRef: "main",
  branchRef: "ade/vm-lane",
  worktreePath: "/repo/.ade/worktrees/vm-lane",
  parentLaneId: null,
  childCount: 0,
  stackDepth: 0,
  parentStatus: null,
  isEditProtected: false,
  runtimePlacement: "macos-vm",
  status: {
    dirty: false,
    ahead: 0,
    behind: 0,
    remoteBehind: 0,
    rebaseInProgress: false,
  },
  createdAt: "2026-05-16T00:00:00.000Z",
  color: null,
  icon: null,
  tags: [],
} as LaneSummary;

const emptyStatus: MacosVmStatus = {
  platform: "darwin",
  arch: "arm64",
  supported: true,
  checkedAt: "2026-05-16T00:00:00.000Z",
  activeProvider: {
    kind: "lume",
    available: true,
    version: "0.3.9",
    detail: "Lume 0.3.9",
    docsUrl: "https://github.com/trycua/cua/tree/main/libs/lume",
  },
  tools: [],
  laneVm: null,
  vms: [],
  globalLease: null,
  docs: {
    appleVirtualization: "https://developer.apple.com/documentation/virtualization",
    appleSharedDirectories: "https://developer.apple.com/documentation/virtualization",
    lume: "https://github.com/trycua/cua/tree/main/libs/lume",
  },
};

function makeVm(overrides: Partial<MacosVmRecord> = {}): MacosVmRecord {
  return {
    id: "macos-vm:lane-1",
    provider: "lume",
    name: "ade-vm-lane",
    laneId: "lane-1",
    laneName: "VM lane",
    laneRoot: baseLane.worktreePath,
    laneState: "attached",
    state: "running",
    cpuCores: 4,
    memory: "8GB",
    diskSize: "80GB",
    display: "1440x900",
    guestSharedPath: "/Volumes/My Shared Files",
    sharedDirectory: baseLane.worktreePath,
    createdAt: "2026-05-16T00:00:00.000Z",
    updatedAt: "2026-05-16T00:00:00.000Z",
    lastStartedAt: "2026-05-16T00:00:00.000Z",
    lastStoppedAt: null,
    ipAddress: "192.168.64.9",
    sshCommand: null,
    vncUrl: "vnc://127.0.0.1:5901",
    lastError: null,
    metadata: {},
    ...overrides,
  } as MacosVmRecord;
}

type AdeMock = {
  emitVmEvent: (event: MacosVmEventPayload) => void;
  ade: Record<string, unknown>;
};

function installAdeMock(initialStatus: MacosVmStatus, overrides: Partial<Record<string, unknown>> = {}): AdeMock {
  const listeners = new Set<(event: MacosVmEventPayload) => void>();
  const macosVm = {
    getStatus: vi.fn(async () => initialStatus),
    provision: vi.fn(),
    start: vi.fn(async () => ({ ok: true })),
    stop: vi.fn(async () => ({ ok: true })),
    delete: vi.fn(),
    getAgentGuide: vi.fn(),
    focusWindow: vi.fn(),
    getDisplaySession: vi.fn(async () => ({
      ok: true as const,
      laneId: "lane-1",
      vmName: "ade-vm-lane",
      websocketUrl: "ws://127.0.0.1:5901",
      password: "secret",
      width: 1440,
      height: 900,
      expiresAt: "2026-05-16T01:00:00.000Z",
    })),
    captureScreenshot: vi.fn(),
    selectPoint: vi.fn(),
    click: vi.fn(),
    typeText: vi.fn(),
    restart: vi.fn(async () => null),
    wipe: vi.fn(async () => ({ wiped: true, previousVm: null, unreachablePaths: [] })),
    getStorageInfo: vi.fn(async () => ({
      ipswCache: { path: "/", availableBytes: 500_000_000_000, totalBytes: 1_000_000_000_000, volumeId: 1 },
      vmDisk: { path: "/", availableBytes: 500_000_000_000, totalBytes: 1_000_000_000_000, volumeId: 1 },
      estimatedIpswBytes: 16_800_000_000,
      estimatedFullSetupBytes: 50_000_000_000,
      recommendedFreeBytes: 60_000_000_000,
      existingIpswBytes: 0,
    })),
    installRuntime: vi.fn(async () => ({
      state: "installed",
      detail: "ok",
      startedAt: null,
      completedAt: null,
      lastError: null,
    })),
    setCredentials: vi.fn(async () => ({ ok: true as const })),
    getCredentials: vi.fn(async () => ({
      vmName: "ade-vm-lane",
      username: "ade",
      hasPassword: false,
      savedAt: null,
    })),
    detachLane: vi.fn(async () => ({
      laneId: "lane-1",
      previousPlacement: "macos-vm" as const,
      newPlacement: "local" as const,
      mirrorRemoved: true,
      shareMarkedStale: false,
      noOp: false,
    })),
    onEvent: vi.fn((cb: (event: MacosVmEventPayload) => void) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    }),
    ...overrides,
  };
  const ade = {
    app: { openExternal: vi.fn() },
    lanes: {
      list: vi.fn(async () => []),
      delete: vi.fn(),
    },
    macosVm,
  };
  globalThis.window.ade = ade as never;
  return {
    ade,
    emitVmEvent(event) {
      listeners.forEach((listener) => listener(event));
    },
  };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <MacVmPage />
    </MemoryRouter>,
  );
}

describe("MacVmPage", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useAppStore.setState({
      lanes: [],
      laneSnapshots: [],
      selectedLaneId: null,
      project: { rootPath: "/repo", displayName: "Repo" } as never,
      macosVmTabIndicator: null,
    });
  });

  afterEach(() => {
    cleanup();
    globalThis.window.ade = originalAde;
    globalThis.window.confirm = originalConfirm;
  });

  it("shows the Mac-mini glyph and CTA in the empty state", async () => {
    installAdeMock(emptyStatus);
    renderPage();
    await waitFor(() => expect(globalThis.window.ade.macosVm.getStatus).toHaveBeenCalled());

    expect(await screen.findByRole("img", { name: /mac mini/i })).toBeTruthy();
    expect(
      screen.getByText(/no mac vm yet\. set it up once; lanes then run inside it\./i),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /set up your mac vm/i })).toBeTruthy();
  });

  it("renders bytes / percent / ETA from a download-progress event mid-download", async () => {
    const vm = makeVm({
      state: "installing",
      guestReadiness: {
        state: "provisioning",
        canControlGui: false,
        canRunCode: false,
        sshAvailable: null,
        setupAssistantLikely: false,
        detail: "Downloading restore image.",
        nextAction: "Wait for the download to finish.",
      },
      currentPhase: 2,
    });
    const { emitVmEvent } = installAdeMock({
      ...emptyStatus,
      vms: [vm],
      laneVm: vm,
    });
    renderPage();

    await waitFor(() => expect(globalThis.window.ade.macosVm.getStatus).toHaveBeenCalled());

    act(() => {
      emitVmEvent({
        type: "download-progress",
        vmName: vm.name,
        progress: {
          source: "ipsw",
          downloadedBytes: 7 * 1024 * 1024 * 1024,
          totalBytes: 16 * 1024 * 1024 * 1024,
          etaSeconds: 5 * 60,
          startedAt: "2026-05-16T00:00:00.000Z",
          updatedAt: "2026-05-16T00:01:00.000Z",
          resumable: true,
        },
      });
    });

    const bytes = await screen.findByTestId("download-bytes");
    expect(bytes.textContent).toBe("7.0 GB / 16.0 GB");
    expect(screen.getByTestId("download-percent").textContent).toMatch(/43\.\d%/);
    expect(screen.getByTestId("download-eta").textContent).toMatch(/ETA 5m/);
    expect(screen.getByText(/You can switch tabs\. Keep ADE open\./i)).toBeTruthy();
  });

  it("renders the FirstBootCard with all 6 steps and the Remote Login command", async () => {
    const vm = makeVm({
      state: "running",
      currentPhase: 6,
      guestReadiness: {
        state: "setup_required",
        canControlGui: true,
        canRunCode: false,
        sshAvailable: false,
        setupAssistantLikely: true,
        detail: "First-boot setup required.",
        nextAction: "Finish Setup Assistant.",
      },
    });
    installAdeMock({ ...emptyStatus, vms: [vm], laneVm: vm });
    renderPage();
    await waitFor(() => expect(globalThis.window.ade.macosVm.getStatus).toHaveBeenCalled());

    const dialog = await screen.findByRole("dialog", { name: /macos first-boot setup steps/i });
    expect(within(dialog).getByText(/step 1 of 6/i)).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: /all 6 steps/i }));
    expect(within(dialog).getAllByText(/Region/i).length).toBeGreaterThan(0);
    expect(within(dialog).getByText(/Transfer Your Data/i)).toBeTruthy();
    expect(within(dialog).getByText(/Sign In to Apple Account/i)).toBeTruthy();
    expect(within(dialog).getByText(/Create Mac account/i)).toBeTruthy();
    expect(within(dialog).getByText(/Reach desktop/i)).toBeTruthy();
    expect(within(dialog).getAllByText(/Enable Remote Login/i).length).toBeGreaterThan(0);

    // Advance to step 6 (zero-based 5) so the command is visible.
    const nextButton = within(dialog).getByRole("button", { name: /^next$/i });
    for (let i = 0; i < 5; i += 1) {
      fireEvent.click(nextButton);
    }
    expect(within(dialog).getByText(/sudo systemsetup -setremotelogin on/)).toBeTruthy();
    expect(within(dialog).getAllByRole("button", { name: /copy command/i }).length).toBeGreaterThan(0);
  });

  it("collapses the stepper in compact mode and toggles back", async () => {
    const vm = makeVm({
      state: "running",
      currentPhase: 10,
      guestReadiness: {
        state: "runtime_ready",
        canControlGui: true,
        canRunCode: true,
        sshAvailable: true,
        setupAssistantLikely: false,
        detail: "Ready",
        nextAction: "Create a VM lane via + New lane → Mac VM.",
      },
    });
    installAdeMock({ ...emptyStatus, vms: [vm], laneVm: vm });
    renderPage();
    await waitFor(() => expect(globalThis.window.ade.macosVm.getStatus).toHaveBeenCalled());

    // Compact mode auto-engages at phase 10 → shows the collapsed banner only.
    expect(await screen.findByText(/setup complete/i)).toBeTruthy();
    expect(screen.queryByText(/Download restore image/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /expand/i }));
    expect(await screen.findByText(/download restore image/i)).toBeTruthy();
  });

  it("warns about auto-detach when wiping with a VM lane attached", async () => {
    const vm = makeVm({
      state: "running",
      currentPhase: 10,
      guestReadiness: {
        state: "runtime_ready",
        canControlGui: true,
        canRunCode: true,
        sshAvailable: true,
        setupAssistantLikely: false,
        detail: "Ready",
        nextAction: "Create a VM lane.",
      },
    });
    installAdeMock({ ...emptyStatus, vms: [vm], laneVm: vm });
    const confirmSpy = vi.fn().mockReturnValue(false);
    globalThis.window.confirm = confirmSpy as never;
    renderPage();
    await waitFor(() => expect(globalThis.window.ade.macosVm.getStatus).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: /vm lifecycle menu/i }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /wipe & reinstall/i }));

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy.mock.calls[0]![0]).toMatch(/auto-detached/i);
    expect(confirmSpy.mock.calls[0]![0]).toMatch(/converted to local/i);
  });

  it("opens the credentials dialog from the Save credentials button at phase 8", async () => {
    const vm = makeVm({
      state: "running",
      currentPhase: 8,
      sshCommand: "ssh ade@192.168.64.9",
      guestReadiness: {
        state: "code_ready",
        canControlGui: true,
        canRunCode: true,
        sshAvailable: true,
        setupAssistantLikely: false,
        detail: "Remote Login is enabled.",
        nextAction: "Save credentials.",
      },
    });
    installAdeMock(
      { ...emptyStatus, vms: [vm], laneVm: vm },
      {
        getCredentials: vi.fn(async () => ({
          vmName: vm.name,
          username: "ade",
          hasPassword: false,
          savedAt: null,
        })),
      },
    );
    renderPage();
    await waitFor(() => expect(globalThis.window.ade.macosVm.getStatus).toHaveBeenCalled());
    await waitFor(() => expect(globalThis.window.ade.macosVm.getCredentials).toHaveBeenCalled());

    fireEvent.click(await screen.findByRole("button", { name: /^save credentials$/i }));

    expect(await screen.findByRole("dialog", { name: /save vm credentials/i })).toBeTruthy();
  });
});
