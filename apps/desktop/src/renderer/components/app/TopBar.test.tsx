/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TopBar } from "./TopBar";
import { useAppStore } from "../../state/appStore";

vi.mock("../settings/SyncDevicesSection", () => ({
  SyncDevicesSection: () => <section data-testid="sync-devices-section">Sync devices panel</section>,
}));

vi.mock("./AutoUpdateControl", () => ({
  AutoUpdateControl: () => null,
}));

vi.mock("./FeedbackReporterModal", () => ({
  FeedbackReporterModal: () => null,
}));

vi.mock("../onboarding/HelpMenu", () => ({
  HelpMenu: () => null,
}));

vi.mock("../executionTargets/TopBarExecutionTargetSelect", () => ({
  TopBarExecutionTargetSelect: () => null,
}));

vi.mock("../../lib/sessions", () => ({
  isRunOwnedSession: () => false,
}));

vi.mock("../../lib/zoom", () => ({
  ZOOM_LEVEL_KEY: "ade.zoomLevel",
  MIN_ZOOM_LEVEL: 50,
  MAX_ZOOM_LEVEL: 200,
  displayZoomToLevel: (value: number) => value,
  getStoredZoomLevel: () => 100,
}));

function makeSyncSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    mode: "standalone",
    role: "brain",
    localDevice: {
      deviceId: "desktop-1",
      siteId: "site-1",
      name: "ADE Desktop",
      platform: "macOS",
      deviceType: "desktop",
      createdAt: "2026-04-22T00:00:00.000Z",
      updatedAt: "2026-04-22T00:00:00.000Z",
      lastSeenAt: "2026-04-22T00:00:00.000Z",
      lastHost: null,
      lastPort: null,
      tailscaleIp: null,
      ipAddresses: [],
      metadata: {},
    },
    currentBrain: null,
    clusterState: null,
    bootstrapToken: "bootstrap-token",
    pairingPin: null,
    pairingPinConfigured: false,
    pairingConnectInfo: null,
    connectedPeers: [
      { deviceId: "phone-1", deviceName: "Arul iPhone", platform: "iOS", deviceType: "phone" },
    ],
    tailnetDiscovery: {
      state: "disabled",
      serviceName: "svc:ade-sync",
      servicePort: 8787,
      target: null,
      updatedAt: null,
      error: null,
      stderr: null,
    },
    client: { state: "disconnected" },
    transferReadiness: { ready: true, blockers: [], survivableState: [] },
    survivableStateText: "",
    blockingStateText: "",
    ...overrides,
  };
}

function resetStore() {
  useAppStore.setState({
    project: { rootPath: "/Users/arul/ADE", name: "ADE" } as any,
    terminalAttention: {
      runningCount: 0,
      activeCount: 0,
      needsAttentionCount: 0,
      indicator: "none",
      byLaneId: {},
    },
    closeProject: vi.fn(async () => undefined),
    openRepo: vi.fn(async () => ({ rootPath: "/Users/arul/ADE", name: "ADE" })),
    isNewTabOpen: false,
    openNewTab: vi.fn(),
    cancelNewTab: vi.fn(),
    projectTransition: null,
    projectTransitionError: null,
    clearProjectTransitionError: vi.fn(),
    switchProjectToPath: vi.fn(async () => undefined),
  } as any);
}

describe("TopBar", () => {
  const originalAde = globalThis.window.ade;

  beforeEach(() => {
    resetStore();
    globalThis.window.ade = {
      project: {
        listRecent: vi.fn(async () => [
          {
            rootPath: "/Users/arul/ADE",
            displayName: "ADE",
            exists: true,
            lastOpenedAt: "2026-04-22T00:00:00.000Z",
            laneCount: 3,
          },
        ]),
        onMissing: vi.fn(() => () => {}),
        forgetRecent: vi.fn(async () => []),
        reorderRecent: vi.fn(async () => undefined),
      },
      sync: {
        getStatus: vi.fn(async () => makeSyncSnapshot()),
        onEvent: vi.fn(() => () => {}),
      },
      zoom: {
        setLevel: vi.fn(),
      },
      lanes: { list: vi.fn(async () => []) },
      sessions: { list: vi.fn(async () => []) },
      agentChat: { list: vi.fn(async () => []) },
      missions: { list: vi.fn(async () => []) },
      processes: { listRuntime: vi.fn(async () => []) },
    } as any;
  });

  afterEach(() => {
    cleanup();
    if (originalAde === undefined) {
      delete (globalThis.window as any).ade;
    } else {
      globalThis.window.ade = originalAde;
    }
  });

  it("does not poll phone sync before a project is open", async () => {
    useAppStore.setState({ project: null } as any);

    render(<TopBar />);

    await waitFor(() => {
      expect(globalThis.window.ade.sync.getStatus).not.toHaveBeenCalled();
    });
  });

  it("opens the phone sync drawer from the host status control", async () => {
    render(<TopBar />);

    expect(await screen.findByText("1 phone connected")).toBeTruthy();

    fireEvent.click(screen.getByTitle("Connect a phone to this computer"));

    expect(screen.getByText("Phone sync")).toBeTruthy();
    expect(screen.getByTestId("sync-devices-section")).toBeTruthy();
    expect(screen.getByTitle("Connect a phone to this computer").getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(screen.getByTitle("Close phone sync"));

    await waitFor(() => {
      expect(screen.queryByTestId("sync-devices-section")).toBeNull();
    });
  });

  it("refreshes the phone sync label after switching projects", async () => {
    const getStatus = vi.fn()
      .mockResolvedValueOnce(makeSyncSnapshot({ connectedPeers: [] }))
      .mockResolvedValueOnce(makeSyncSnapshot({
        connectedPeers: [
          { deviceId: "phone-1", deviceName: "Arul iPhone", platform: "iOS", deviceType: "phone" },
        ],
      }));
    globalThis.window.ade.sync.getStatus = getStatus as any;

    render(<TopBar />);

    expect(await screen.findByText("Phone sync ready")).toBeTruthy();

    await act(async () => {
      useAppStore.setState({
        project: {
          rootPath: "/Users/arul/ADE/.ade/worktrees/mobile-lanes-tab-2d82c012",
          name: "mobile-lanes-tab-2d82c012",
        } as any,
      });
    });

    await waitFor(() => {
      expect(getStatus).toHaveBeenCalledTimes(2);
    });
    expect(await screen.findByText("1 phone connected")).toBeTruthy();
  });
});
