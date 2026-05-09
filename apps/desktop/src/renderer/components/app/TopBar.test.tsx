/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function makeDataTransfer(data: Record<string, string>, dropEffect = "move") {
  return {
    dropEffect,
    effectAllowed: "move",
    types: Object.keys(data),
    getData: vi.fn((type: string) => data[type] ?? ""),
    setData: vi.fn(),
  };
}

function fireProjectTabDragEnd(
  element: HTMLElement,
  dataTransfer: ReturnType<typeof makeDataTransfer>,
) {
  const event = createEvent.dragEnd(element, { dataTransfer });
  Object.defineProperty(event, "clientX", { value: -1 });
  Object.defineProperty(event, "clientY", { value: 12 });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  fireEvent(element, event);
}

describe("TopBar", () => {
  const originalAde = globalThis.window.ade;

  beforeEach(() => {
    resetStore();
    globalThis.window.ade = {
      app: {
        getWindowSession: vi.fn(async () => ({ windowId: 1, project: useAppStore.getState().project })),
        newWindow: vi.fn(async () => ({ windowId: 2 })),
        openProjectInNewWindow: vi.fn(async (rootPath: string) => ({
          windowId: 2,
          project: { rootPath, name: rootPath.split("/").pop() ?? rootPath },
        })),
        closeWindow: vi.fn(async () => ({ closed: true })),
      },
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
        resolveIcon: vi.fn(async () => ({ dataUrl: null, sourcePath: null, mimeType: null })),
        chooseIcon: vi.fn(async () => null),
        removeIcon: vi.fn(async () => ({ dataUrl: null, sourcePath: null, mimeType: null })),
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
    vi.restoreAllMocks();
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
      expect(globalThis.window.ade.project.listRecent).toHaveBeenCalled();
    });
    expect(screen.queryByText("1 phone connected")).toBeNull();
    expect(globalThis.window.ade.sync.getStatus).not.toHaveBeenCalled();
  });

  it("does not render recent projects as tabs before a project is open", async () => {
    useAppStore.setState({ project: null } as any);

    render(<TopBar />);

    await waitFor(() => {
      expect(globalThis.window.ade.project.listRecent).toHaveBeenCalled();
    });
    expect(screen.queryByTitle("/Users/arul/ADE")).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 850));

    expect(globalThis.window.ade.project.resolveIcon).not.toHaveBeenCalled();
  });

  it("opens a blank ADE window from the top bar", async () => {
    render(<TopBar />);

    fireEvent.click(await screen.findByTitle("New window"));

    expect(globalThis.window.ade.app.newWindow).toHaveBeenCalledTimes(1);
  });

  it("consolidates a cross-window project tab dropped onto the same project", async () => {
    render(<TopBar />);

    const tab = await screen.findByTitle("/Users/arul/ADE");
    await waitFor(() => {
      expect(globalThis.window.ade.app.getWindowSession).toHaveBeenCalled();
    });

    fireEvent.drop(tab, {
      dataTransfer: makeDataTransfer({
        "application/x-ade-project-root": "/Users/arul/ADE",
        "application/x-ade-window-id": "2",
      }),
    });

    expect(globalThis.window.ade.app.closeWindow).toHaveBeenCalledWith(2);
    expect(useAppStore.getState().switchProjectToPath).not.toHaveBeenCalled();
  });

  it("does not detach again after a project tab is dropped onto an ADE target", async () => {
    render(<TopBar />);

    const tab = await screen.findByTitle("/Users/arul/ADE");

    fireProjectTabDragEnd(tab, makeDataTransfer({}, "move"));

    expect(globalThis.window.ade.app.openProjectInNewWindow).not.toHaveBeenCalled();
  });

  it("detaches a project tab when it is dragged outside without an ADE drop target", async () => {
    render(<TopBar />);

    const tab = await screen.findByTitle("/Users/arul/ADE");

    fireProjectTabDragEnd(tab, makeDataTransfer({}, "none"));

    expect(globalThis.window.ade.app.openProjectInNewWindow).toHaveBeenCalledWith("/Users/arul/ADE");
  });

  it("opens the phone sync drawer from the host status control", async () => {
    render(<TopBar />);

    expect(await screen.findByText("1 phone connected")).toBeTruthy();

    fireEvent.click(screen.getByTitle("Connect a phone to this computer"));

    expect(screen.getByText("Connect to the ADE mobile app")).toBeTruthy();
    expect(screen.getByTestId("sync-devices-section")).toBeTruthy();
    expect(screen.getByTitle("Connect a phone to this computer").getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(screen.getByTitle("Close phone sync"));

    await waitFor(() => {
      expect(screen.queryByTestId("sync-devices-section")).toBeNull();
    });
  });

  it("refreshes the phone sync label from global sync events", async () => {
    let syncEventHandler: ((event: any) => void) | null = null;
    const getStatus = vi.fn()
      .mockResolvedValueOnce(makeSyncSnapshot({ connectedPeers: [] }));
    globalThis.window.ade.sync.getStatus = getStatus as any;
    globalThis.window.ade.sync.onEvent = vi.fn((handler) => {
      syncEventHandler = handler;
      return () => {
        syncEventHandler = null;
      };
    }) as any;

    render(<TopBar />);

    expect(await screen.findByText("Phone sync ready")).toBeTruthy();

    await act(async () => {
      syncEventHandler?.({
        type: "sync-status",
        snapshot: makeSyncSnapshot({
          connectedPeers: [
            { deviceId: "phone-1", deviceName: "Arul iPhone", platform: "iOS", deviceType: "phone" },
          ],
        }),
      });
    });

    expect(await screen.findByText("1 phone connected")).toBeTruthy();
  });

  it("does not refresh phone sync status on an idle interval", async () => {
    vi.useFakeTimers();
    try {
      const getStatus = vi.fn(async () => makeSyncSnapshot());
      globalThis.window.ade.sync.getStatus = getStatus as any;

      render(<TopBar />);

      await act(async () => {
        await Promise.resolve();
      });

      expect(getStatus).toHaveBeenCalledTimes(1);

      await act(async () => {
        vi.advanceTimersByTime(15_000);
        await Promise.resolve();
      });

      expect(getStatus).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes phone sync status when the window regains focus", async () => {
    const getStatus = vi.fn()
      .mockResolvedValueOnce(makeSyncSnapshot({ connectedPeers: [] }))
      .mockResolvedValueOnce(makeSyncSnapshot());
    globalThis.window.ade.sync.getStatus = getStatus as any;

    render(<TopBar />);

    expect(await screen.findByText("Phone sync ready")).toBeTruthy();

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    expect(await screen.findByText("1 phone connected")).toBeTruthy();
    expect(getStatus).toHaveBeenCalledTimes(2);
  });

  it("shows project icon replacement errors", async () => {
    globalThis.window.ade.project.chooseIcon = vi.fn(async () => {
      throw new Error("Failed to set project icon: Project icon must be 10 MB or smaller.");
    }) as any;

    render(<TopBar />);

    fireEvent.click(await screen.findByLabelText("Project icon"));
    fireEvent.click(await screen.findByText("Replace"));

    expect((await screen.findByRole("alert")).textContent).toContain("Project icon must be 10 MB or smaller.");
  });

  it("confirms before closing a project tab", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    render(<TopBar />);

    await screen.findByText("ADE");
    fireEvent.click(screen.getByTitle("Remove project"));

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Close \"ADE\" project tab?"));
    expect(globalThis.window.ade.project.forgetRecent).not.toHaveBeenCalled();
    expect(useAppStore.getState().closeProject).not.toHaveBeenCalled();
  });

  it("closes the active project tab after confirmation without removing it from recents", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<TopBar />);

    await screen.findByText("ADE");
    fireEvent.click(screen.getByTitle("Remove project"));

    await waitFor(() => {
      expect(useAppStore.getState().closeProject).toHaveBeenCalledTimes(1);
    });
    expect(globalThis.window.ade.project.forgetRecent).not.toHaveBeenCalled();
  });
});
