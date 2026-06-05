/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TopBar } from "./TopBar";
import { useAppStore } from "../../state/appStore";
import { requestLinearIssueQuickView } from "../../lib/linearIssueQuickViewNavigation";
import {
  ADE_BROWSER_VIEW_OCCLUSION_END_EVENT,
  ADE_BROWSER_VIEW_OCCLUSION_START_EVENT,
} from "../../lib/workSidebarBrowserResize";

const PROJECT_TAB_ROOT_MIME = "application/x-ade-project-root";
const PROJECT_TAB_WINDOW_MIME = "application/x-ade-window-id";

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

vi.mock("../usage/HeaderUsageControl", () => ({
  HeaderUsageControl: () => null,
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
    projectHydrated: true,
    showWelcome: false,
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
    projectBinding: {
      kind: "local",
      key: "local:/Users/arul/ADE",
      rootPath: "/Users/arul/ADE",
      displayName: "ADE",
    },
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
    switchRemoteProject: vi.fn(async (targetId: string, projectId: string) => ({
      kind: "remote",
      key: `remote:${targetId}:${projectId}`,
      targetId,
      runtimeName: "Mac Studio",
      projectId,
      rootPath: "/srv/ade/remote-app",
      displayName: "Remote App",
    })),
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

function markHandledProjectTabDrop(rootPath: string, sourceWindowId = "1") {
  window.localStorage.setItem(
    `ade.projectTabDropHandled.v1:${sourceWindowId}:${encodeURIComponent(rootPath)}`,
    String(Date.now()),
  );
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

async function flushMicrotasks(count = 1) {
  for (let index = 0; index < count; index += 1) {
    await new Promise<void>((resolve) => queueMicrotask(resolve));
  }
}

async function advancePhoneSyncStartupDelay() {
  await act(async () => {
    vi.advanceTimersByTime(5_000);
    await flushMicrotasks(2);
  });
}

const resourceUsageMock = vi.fn();

describe("TopBar", () => {
  const originalAde = globalThis.window.ade;

  beforeEach(() => {
    resetStore();
    resourceUsageMock.mockReset();
    resourceUsageMock.mockResolvedValue({
      sampledAt: "2026-04-22T00:00:00.000Z",
      processCount: 2,
      cpuPercent: 1,
      mainCpuPercent: 0.5,
      rendererCpuPercent: 0.5,
      memoryMB: 240,
      mainMemoryMB: 80,
      rendererMemoryMB: 160,
      activePtyCount: 0,
      ptyProcessCount: 0,
      ptyCpuPercent: 0,
      ptyMemoryMB: 0,
      freeMemoryMB: 12_000,
      totalMemoryMB: 16_000,
    });
    globalThis.window.ade = {
      app: {
        getWindowSession: vi.fn(async () => ({ windowId: 1, project: useAppStore.getState().project, openProjectTabs: [] })),
        setWindowProjectTabs: vi.fn(async () => ({ openProjectTabs: [] })),
        newWindow: vi.fn(async () => ({ windowId: 2 })),
        openProjectInNewWindow: vi.fn(async (rootPath: string) => ({
          windowId: 2,
          project: { rootPath, name: rootPath.split("/").pop() ?? rootPath },
        })),
        closeWindow: vi.fn(async () => ({ closed: true })),
        getResourceUsage: resourceUsageMock,
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
      remoteRuntime: {
        getConnectionSnapshot: vi.fn(async () => ({
          connections: [],
          connectedCount: 0,
          updatedAt: Date.now(),
        })),
        onConnectionSnapshotChanged: vi.fn(() => () => {}),
        listTargets: vi.fn(async () => []),
        listDiscoveredMachines: vi.fn(async () => ({
          machines: [],
          diagnostics: [],
        })),
      },
      github: {
        getStatus: vi.fn(async () => ({
          tokenStored: false,
          patTokenStored: false,
          tokenDecryptionFailed: false,
          storageScope: "app",
          authSource: "none",
          repo: { owner: "acme", name: "ade", url: "https://github.com/acme/ade" },
          hasOrigin: true,
          userLogin: null,
          scopes: [],
          ghCliPath: null,
          ghAuthError: null,
          checkedAt: "2026-04-22T00:00:00.000Z",
          repoAccessOk: true,
          repoAccessError: null,
          connected: false,
        })),
        getRemoteStatus: vi.fn(async () => ({
          repo: { owner: "acme", name: "ade" },
          hasOrigin: true,
        })),
        onStatusChanged: vi.fn(() => () => {}),
      },
      zoom: {
        setLevel: vi.fn(),
      },
      lanes: { list: vi.fn(async () => []) },
      sessions: { list: vi.fn(async () => []) },
      agentChat: { list: vi.fn(async () => []) },
      processes: { listRuntime: vi.fn(async () => []) },
    } as any;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    globalThis.window.localStorage.clear();
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
    expect(screen.queryByText("1 phone connected to ADE Desktop")).toBeNull();
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

  it("renders a remote project tab without local sync polling", async () => {
    useAppStore.setState({
      project: { rootPath: "/srv/ade/remote-app", displayName: "Remote App", baseRef: "main" },
      projectBinding: {
        kind: "remote",
        key: "remote:studio:project-1",
        targetId: "studio",
        runtimeName: "Mac Studio",
        projectId: "project-1",
        rootPath: "/srv/ade/remote-app",
        displayName: "Remote App",
      },
      projectHydrated: true,
      showWelcome: false,
    } as any);

    render(<TopBar />);

    expect(await screen.findByTitle("Mac Studio: /srv/ade/remote-app")).toBeTruthy();
    expect(screen.getByText("Remote App")).toBeTruthy();
    expect(screen.getByLabelText("Remote: Mac Studio")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remote, connected" })).toBeTruthy();
    expect(globalThis.window.ade.sync.getStatus).not.toHaveBeenCalled();
    expect(screen.queryByTitle("Connect a phone to this machine")).toBeNull();
  });

  it("keeps local tabs visible when a remote project is active", async () => {
    render(<TopBar />);

    const localTab = await screen.findByTitle("/Users/arul/ADE");

    await act(async () => {
      useAppStore.setState({
        project: { rootPath: "/srv/ade/remote-app", displayName: "Remote App", baseRef: "main" },
        projectBinding: {
          kind: "remote",
          key: "remote:studio:project-1",
          targetId: "studio",
          runtimeName: "Mac Studio",
          projectId: "project-1",
          rootPath: "/srv/ade/remote-app",
          displayName: "Remote App",
        },
        projectHydrated: true,
        showWelcome: false,
      } as any);
    });

    expect(await screen.findByTitle("Mac Studio: /srv/ade/remote-app")).toBeTruthy();
    expect(screen.getByTitle("/Users/arul/ADE")).toBeTruthy();

    fireEvent.click(localTab);

    expect(useAppStore.getState().switchProjectToPath).toHaveBeenCalledWith("/Users/arul/ADE");
  });

  it("opens a blank ADE window from the top bar", async () => {
    render(<TopBar />);

    fireEvent.click(await screen.findByTitle("New window"));

    expect(globalThis.window.ade.app.newWindow).toHaveBeenCalledTimes(1);
  });

  it("does not load full GitHub auth status for the publish pill", async () => {
    useAppStore.setState({ projectHydrated: true, showWelcome: false } as any);

    render(<TopBar />);

    await waitFor(() => {
      expect(globalThis.window.ade.github.getRemoteStatus).toHaveBeenCalled();
    });
    expect(globalThis.window.ade.github.getStatus).not.toHaveBeenCalled();
  });

  it("shows a header warning when ADE-spawned terminals create resource pressure", async () => {
    useAppStore.setState({ projectHydrated: true, showWelcome: false } as any);
    resourceUsageMock.mockResolvedValue({
      sampledAt: "2026-04-22T00:00:00.000Z",
      processCount: 24,
      cpuPercent: 92,
      mainCpuPercent: 8,
      rendererCpuPercent: 14,
      memoryMB: 5_800,
      mainMemoryMB: 320,
      rendererMemoryMB: 640,
      activePtyCount: 12,
      ptyProcessCount: 19,
      ptyCpuPercent: 91,
      ptyMemoryMB: 4_900,
      freeMemoryMB: 900,
      totalMemoryMB: 16_000,
    });

    render(<TopBar />);

    const indicator = await screen.findByLabelText("ADE resource pressure level 4");
    expect(indicator.getAttribute("data-ade-resource-pressure-active-ptys")).toBe("12");
    expect(indicator.getAttribute("data-ade-resource-pressure-pty-cpu")).toBe("91");
    expect(indicator.getAttribute("title")).toContain("Background live refreshes are slowed");
    expect(indicator.getAttribute("title")).toContain("selected chats and terminals stay full speed");
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

  it("does not render the active remote project as a local project tab", async () => {
    const remoteBinding = {
      kind: "remote" as const,
      key: "remote:target-1:project-a",
      targetId: "target-1",
      runtimeName: "Mac Studio",
      projectId: "project-a",
      rootPath: "/Users/admin/Projects/perf pass",
      displayName: "perf pass",
    };
    useAppStore.setState({
      project: {
        rootPath: remoteBinding.rootPath,
        displayName: remoteBinding.displayName,
        baseRef: "main",
      } as any,
      projectBinding: remoteBinding,
      openProjectTabRoots: [remoteBinding.rootPath],
    } as any);
    (globalThis.window.ade.app.getWindowSession as any).mockResolvedValueOnce({
      windowId: 1,
      project: null,
      binding: remoteBinding,
      openProjectTabs: [],
    });

    render(<TopBar />);

    await waitFor(() => {
      expect(screen.getByTitle("Mac Studio: /Users/admin/Projects/perf pass")).toBeTruthy();
      expect(screen.queryByTitle("/Users/admin/Projects/perf pass")).toBeNull();
      expect(useAppStore.getState().openProjectTabRoots).toEqual([]);
    });
  });

  it("does not detach again after a project tab is dropped onto an ADE target", async () => {
    render(<TopBar />);

    const tab = await screen.findByTitle("/Users/arul/ADE");

    markHandledProjectTabDrop("/Users/arul/ADE");
    fireProjectTabDragEnd(
      tab,
      makeDataTransfer(
        {
          [PROJECT_TAB_ROOT_MIME]: "/Users/arul/ADE",
          [PROJECT_TAB_WINDOW_MIME]: "1",
        },
        "move",
      ),
    );

    expect(globalThis.window.ade.app.openProjectInNewWindow).not.toHaveBeenCalled();
  });

  it("detaches when a project tab is dragged over an ADE window but no ADE tab bar handles it", async () => {
    render(<TopBar />);

    const tab = await screen.findByTitle("/Users/arul/ADE");

    fireProjectTabDragEnd(
      tab,
      makeDataTransfer(
        {
          [PROJECT_TAB_ROOT_MIME]: "/Users/arul/ADE",
          [PROJECT_TAB_WINDOW_MIME]: "1",
        },
        "move",
      ),
    );

    expect(globalThis.window.ade.app.openProjectInNewWindow).toHaveBeenCalledWith("/Users/arul/ADE");
  });

  it("detaches a project tab when it is dragged outside without an ADE drop target", async () => {
    render(<TopBar />);

    const tab = await screen.findByTitle("/Users/arul/ADE");

    fireProjectTabDragEnd(tab, makeDataTransfer({}, "none"));

    expect(globalThis.window.ade.app.openProjectInNewWindow).toHaveBeenCalledWith("/Users/arul/ADE");
  });

  it("keeps the source project tab active until the detached window is bound", async () => {
    let resolveOpen!: (value: { windowId: number; project: { rootPath: string; name: string } }) => void;
    const openPromise = new Promise<{ windowId: number; project: { rootPath: string; name: string } }>((resolve) => {
      resolveOpen = resolve;
    });
    globalThis.window.ade.app.openProjectInNewWindow = vi.fn(() => openPromise) as any;
    const closeProject = useAppStore.getState().closeProject;
    render(<TopBar />);

    const tab = await screen.findByTitle("/Users/arul/ADE");
    fireProjectTabDragEnd(tab, makeDataTransfer({}, "none"));

    expect(globalThis.window.ade.app.openProjectInNewWindow).toHaveBeenCalledWith("/Users/arul/ADE");
    await act(async () => {
      await flushMicrotasks();
    });
    expect(closeProject).not.toHaveBeenCalled();

    await act(async () => {
      resolveOpen({
        windowId: 2,
        project: { rootPath: "/Users/arul/ADE", name: "ADE" },
      });
      await openPromise;
    });

    await waitFor(() => {
      expect(closeProject).toHaveBeenCalled();
    });
  });

  it("opens the phone sync drawer from the host status control", async () => {
    vi.useFakeTimers();
    try {
      render(<TopBar />);

      expect(screen.getByRole("button", { name: "Mobile, not connected" })).toBeTruthy();
      expect(globalThis.window.ade.sync.getStatus).not.toHaveBeenCalled();

      await advancePhoneSyncStartupDelay();
      expect(screen.getByRole("button", { name: "Mobile, connected" })).toBeTruthy();

      fireEvent.click(screen.getByTitle("Connect a phone to this machine"));

      expect(screen.getByText("Connect to the ADE mobile app")).toBeTruthy();
      expect(screen.getByTestId("sync-devices-section")).toBeTruthy();
      expect(screen.getByTitle("Connect a phone to this machine").getAttribute("aria-expanded")).toBe("true");

      fireEvent.click(screen.getByTitle("Close phone sync"));

      expect(screen.queryByTestId("sync-devices-section")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("occludes the native browser while the remote machines panel is open", async () => {
    const events: string[] = [];
    const onStart = () => events.push("start");
    const onEnd = () => events.push("end");
    window.addEventListener(ADE_BROWSER_VIEW_OCCLUSION_START_EVENT, onStart);
    window.addEventListener(ADE_BROWSER_VIEW_OCCLUSION_END_EVENT, onEnd);
    try {
      render(<TopBar />);

      fireEvent.click(await screen.findByTitle("Manage remote machines"));

      expect(
        await screen.findByRole("dialog", { name: "Remote machines" }),
      ).toBeTruthy();
      await waitFor(() => expect(events).toEqual(["start"]));

      fireEvent.click(screen.getByTitle("Close remote machines"));

      await waitFor(() =>
        expect(
          screen.queryByRole("dialog", { name: "Remote machines" }),
        ).toBeNull(),
      );
      expect(events).toEqual(["start", "end"]);
    } finally {
      window.removeEventListener(ADE_BROWSER_VIEW_OCCLUSION_START_EVENT, onStart);
      window.removeEventListener(ADE_BROWSER_VIEW_OCCLUSION_END_EVENT, onEnd);
    }
  });

  it("occludes the native browser while the mobile panel is open", async () => {
    const events: string[] = [];
    const onStart = () => events.push("start");
    const onEnd = () => events.push("end");
    window.addEventListener(ADE_BROWSER_VIEW_OCCLUSION_START_EVENT, onStart);
    window.addEventListener(ADE_BROWSER_VIEW_OCCLUSION_END_EVENT, onEnd);
    try {
      render(<TopBar />);

      fireEvent.click(await screen.findByTitle("Connect a phone to this machine"));

      expect(await screen.findByText("Connect to the ADE mobile app")).toBeTruthy();
      await waitFor(() => expect(events).toEqual(["start"]));

      fireEvent.click(screen.getByTitle("Close phone sync"));

      await waitFor(() => expect(screen.queryByText("Connect to the ADE mobile app")).toBeNull());
      expect(events).toEqual(["start", "end"]);
    } finally {
      window.removeEventListener(ADE_BROWSER_VIEW_OCCLUSION_START_EVENT, onStart);
      window.removeEventListener(ADE_BROWSER_VIEW_OCCLUSION_END_EVENT, onEnd);
    }
  });

  it("refreshes the phone sync label from global sync events", async () => {
    vi.useFakeTimers();
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

    try {
      render(<TopBar />);

      await advancePhoneSyncStartupDelay();
      expect(screen.getByRole("button", { name: "Mobile, not connected" })).toBeTruthy();

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

      expect(screen.getByRole("button", { name: "Mobile, connected" })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not refresh phone sync status on an idle interval", async () => {
    vi.useFakeTimers();
    try {
      const getStatus = vi.fn(async () => makeSyncSnapshot());
      globalThis.window.ade.sync.getStatus = getStatus as any;

      render(<TopBar />);

      await act(async () => {
        await flushMicrotasks();
      });

      expect(getStatus).not.toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersByTime(15_000);
        await flushMicrotasks();
      });

      expect(getStatus).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes phone sync status when the window regains focus", async () => {
    vi.useFakeTimers();
    const getStatus = vi.fn()
      .mockResolvedValueOnce(makeSyncSnapshot({ connectedPeers: [] }))
      .mockResolvedValueOnce(makeSyncSnapshot());
    globalThis.window.ade.sync.getStatus = getStatus as any;

    try {
      render(<TopBar />);

      await act(async () => {
        window.dispatchEvent(new Event("focus"));
        await flushMicrotasks(2);
      });

      expect(screen.getByRole("button", { name: "Mobile, not connected" })).toBeTruthy();

      await act(async () => {
        window.dispatchEvent(new Event("focus"));
        await flushMicrotasks(2);
      });

      expect(screen.getByRole("button", { name: "Mobile, connected" })).toBeTruthy();
      expect(getStatus).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens Linear quick view and creates a linked lane from an issue", async () => {
    const issue = {
      id: "issue-1",
      identifier: "ADE-123",
      title: "Add Linear quick view",
      description: "Show Linear in the app chrome.",
      url: "https://linear.app/ade/issue/ADE-123/add-linear-quick-view",
      projectId: "project-1",
      projectSlug: "desktop",
      projectName: "Desktop",
      teamId: "team-1",
      teamKey: "ADE",
      teamName: "ADE",
      stateId: "state-1",
      stateName: "In Progress",
      stateType: "started",
      priority: 2,
      priorityLabel: "high",
      labels: [],
      metadataTags: [],
      assigneeId: "user-1",
      assigneeName: "Arul",
      creatorId: "user-1",
      creatorName: "Arul",
      blockerIssueIds: [],
      hasOpenBlockers: false,
      dueDate: null,
      estimate: 3,
      archivedAt: null,
      completedAt: null,
      canceledAt: null,
      startedAt: null,
      createdAt: "2026-04-22T00:00:00.000Z",
      updatedAt: "2026-04-22T01:00:00.000Z",
      raw: {},
    };
    const createLane = vi.fn(async () => ({
      id: "lane-linear",
      name: "ADE-123 Add Linear quick view",
    }));
    globalThis.window.ade.cto = {
      getLinearConnectionStatus: vi.fn(async () => ({
        tokenStored: true,
        connected: true,
        viewerId: "user-1",
        viewerName: "Arul",
        checkedAt: "2026-04-22T01:00:00.000Z",
        authMode: "manual",
        oauthAvailable: true,
        tokenExpiresAt: null,
        message: null,
      })),
      getLinearQuickView: vi.fn(async () => ({
        connection: {
          tokenStored: true,
          connected: true,
          viewerId: "user-1",
          viewerName: "Arul",
          checkedAt: "2026-04-22T01:00:00.000Z",
          authMode: "manual",
          oauthAvailable: true,
          tokenExpiresAt: null,
          message: null,
        },
        organization: {
          id: "org-1",
          name: "ADE",
          urlKey: "ade",
          logoUrl: null,
          gitBranchFormat: null,
          createdIssueCount: 40,
          roadmapEnabled: true,
          customersEnabled: false,
          releasesEnabled: true,
        },
        viewer: null,
        projects: [],
        teams: [],
        assignedIssues: [issue],
        recentIssues: [],
        fetchedAt: "2026-04-22T01:00:00.000Z",
        sdk: { packageName: "@linear/sdk", surfaces: ["viewer", "issues"] },
      })),
      getLinearIssuePickerData: vi.fn(async () => ({
        projects: [{ id: "project-1", name: "Desktop", slug: "desktop", teamName: "ADE", teamKey: "ADE" }],
        users: [{ id: "user-1", name: "arul", displayName: "Arul", email: null, active: true }],
        states: [{ id: "state-1", name: "In Progress", type: "started", teamId: "team-1", teamKey: "ADE" }],
      })),
      searchLinearIssues: vi.fn(async () => ({
        issues: [issue],
        pageInfo: { hasNextPage: false, endCursor: null },
      })),
    } as any;
    globalThis.window.ade.lanes.create = createLane as any;

    render(<TopBar />);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await flushMicrotasks();
    });

    fireEvent.click(await screen.findByRole("button", { name: /linear quick view/i }));

    await waitFor(() => {
      expect(screen.getAllByText("Add Linear quick view").length).toBeGreaterThan(0);
    });
    const quickViewDialog = screen.getByRole("dialog", { name: /linear quick view/i });
    expect(document.body.querySelector("[data-linear-quick-view-backdrop]")).toBeTruthy();
    expect(quickViewDialog.getAttribute("style")).toContain("rgba(123, 138, 240, 0.55)");

    // Single-issue flow now routes through the unified launch dock: select the
    // issue row (a `div role="button"`), choose "Create lane only", then submit
    // the launch-config modal. Lane-only submit creates the lane without an
    // agent, so it still calls lanes.create directly.
    const issueRow = (await screen.findAllByText("ADE-123"))[0]!.closest('[role="button"]');
    expect(issueRow).toBeTruthy();
    fireEvent.click(issueRow!);
    fireEvent.click(await screen.findByRole("button", { name: /create lane only/i }));
    fireEvent.click(await screen.findByRole("button", { name: /^create 1 lane$/i }));

    await waitFor(() => {
      // Lane-only launch leaves the branch override blank, so createLane is
      // called without an explicit branchName — the branch is derived from the
      // attached issue (carried on linearIssue.branchName).
      expect(createLane).toHaveBeenCalledWith(expect.objectContaining({
        name: "ADE-123 Add Linear quick view",
        linearIssue: expect.objectContaining({
          identifier: "ADE-123",
          branchName: "ade-123-add-linear-quick-view",
        }),
      }));
    });
  });

  it("opens the Linear quick view directly from a Linear issue deeplink request", async () => {
    const issue = {
      id: "issue-2",
      identifier: "ADE-124",
      title: "Route issue deeplinks to Linear pane",
      description: "Open the Linear issue browser from ADE links.",
      url: "https://linear.app/ade/issue/ADE-124/route-issue-deeplinks",
      projectId: "project-1",
      projectSlug: "desktop",
      projectName: "Desktop",
      teamId: "team-1",
      teamKey: "ADE",
      teamName: "ADE",
      stateId: "state-1",
      stateName: "In Progress",
      stateType: "started",
      priority: 2,
      priorityLabel: "high",
      labels: [],
      metadataTags: [],
      assigneeId: "user-1",
      assigneeName: "Arul",
      creatorId: "user-1",
      creatorName: "Arul",
      blockerIssueIds: [],
      hasOpenBlockers: false,
      dueDate: null,
      estimate: 3,
      archivedAt: null,
      completedAt: null,
      canceledAt: null,
      startedAt: null,
      createdAt: "2026-04-22T00:00:00.000Z",
      updatedAt: "2026-04-22T01:00:00.000Z",
      raw: {},
    };
    const searchLinearIssues = vi.fn(async () => ({
      issues: [issue],
      pageInfo: { hasNextPage: false, endCursor: null },
    }));
    globalThis.window.ade.cto = {
      getLinearConnectionStatus: vi.fn(async () => ({
        tokenStored: true,
        connected: true,
        viewerId: "user-1",
        viewerName: "Arul",
        checkedAt: "2026-04-22T01:00:00.000Z",
        authMode: "manual",
        oauthAvailable: true,
        tokenExpiresAt: null,
        message: null,
      })),
      getLinearQuickView: vi.fn(async () => ({
        connection: {
          tokenStored: true,
          connected: true,
          viewerId: "user-1",
          viewerName: "Arul",
          checkedAt: "2026-04-22T01:00:00.000Z",
          authMode: "manual",
          oauthAvailable: true,
          tokenExpiresAt: null,
          message: null,
        },
        organization: null,
        viewer: null,
        projects: [],
        teams: [],
        assignedIssues: [],
        recentIssues: [],
        fetchedAt: "2026-04-22T01:00:00.000Z",
        sdk: { packageName: "@linear/sdk", surfaces: ["viewer", "issues"] },
      })),
      getLinearIssuePickerData: vi.fn(async () => ({
        projects: [],
        users: [],
        states: [],
      })),
      searchLinearIssues,
    } as any;

    render(<TopBar />);

    await act(async () => {
      requestLinearIssueQuickView({ issueIdentifier: "ADE-124", source: "deeplink" });
      await flushMicrotasks(2);
    });

    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: /linear quick view/i })).toBeTruthy();
    });
    await waitFor(() => {
      expect(searchLinearIssues).toHaveBeenCalledWith(expect.objectContaining({ query: "ADE-124" }));
    });
    await waitFor(() => {
      expect(screen.getAllByText("Route issue deeplinks to Linear pane").length).toBeGreaterThan(0);
    });
  });

  it("shows a setup state when a Linear issue deeplink is opened without a Linear connection", async () => {
    window.location.hash = "";
    globalThis.window.ade.cto = {
      getLinearConnectionStatus: vi.fn(async () => ({
        tokenStored: false,
        connected: false,
        viewerId: null,
        viewerName: null,
        checkedAt: "2026-04-22T01:00:00.000Z",
        authMode: "manual",
        oauthAvailable: true,
        tokenExpiresAt: null,
        message: "Connect Linear first.",
      })),
    } as any;

    render(<TopBar />);

    await act(async () => {
      requestLinearIssueQuickView({ issueIdentifier: "ADE-125", source: "deeplink" });
      await flushMicrotasks(2);
    });

    expect(await screen.findByText("Connect Linear to open ADE-125")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /open linear settings/i }));
    expect(window.location.hash).toBe("#/settings?tab=integrations&integration=linear");
  });

  it("offers the project picker when a Linear issue deeplink opens without an ADE project", async () => {
    window.location.hash = "";
    useAppStore.setState({ project: null, projectBinding: null } as any);

    render(<TopBar />);

    await act(async () => {
      requestLinearIssueQuickView({ issueIdentifier: "ADE-126", source: "deeplink" });
      await flushMicrotasks(2);
    });

    expect(await screen.findByText("Open the ADE project for ADE-126")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /open project picker/i }));
    expect(window.location.hash).toBe("#/project");
  });

  it("reveals Linear quick view after a later connection refresh", async () => {
    const disconnected = {
      tokenStored: true,
      connected: false,
      viewerId: null,
      viewerName: null,
      checkedAt: "2026-04-22T01:00:00.000Z",
      authMode: "manual",
      oauthAvailable: true,
      tokenExpiresAt: null,
      message: "Linear connection check is still starting.",
    };
    const connected = {
      ...disconnected,
      connected: true,
      viewerId: "user-1",
      viewerName: "Arul",
      message: null,
    };
    const getLinearConnectionStatus = vi.fn()
      .mockResolvedValueOnce(disconnected)
      .mockResolvedValueOnce(connected);
    globalThis.window.ade.cto = {
      getLinearConnectionStatus,
    } as any;

    render(<TopBar />);

    expect(getLinearConnectionStatus).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /linear quick view/i })).toBeNull();

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await flushMicrotasks();
    });
    await waitFor(() => {
      expect(getLinearConnectionStatus).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByRole("button", { name: /linear quick view/i })).toBeNull();

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await flushMicrotasks();
    });

    expect(await screen.findByRole("button", { name: /linear quick view/i })).toBeTruthy();
  });

  it("keeps button hidden while disconnected but retries on a 3s interval", async () => {
    vi.useFakeTimers();
    const getLinearConnectionStatus = vi.fn(async () => ({
      tokenStored: true,
      connected: false,
      viewerId: null,
      viewerName: null,
      checkedAt: "2026-04-22T01:00:00.000Z",
      authMode: "manual",
      oauthAvailable: true,
      tokenExpiresAt: null,
      message: "Linear connection check is still starting.",
    }));
    globalThis.window.ade.cto = {
      getLinearConnectionStatus,
    } as any;

    try {
      render(<TopBar />);

      await act(async () => {
        vi.advanceTimersByTime(8_000);
        await flushMicrotasks(2);
      });
      expect(getLinearConnectionStatus).toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: /linear quick view/i })).toBeNull();

      const callsBefore = getLinearConnectionStatus.mock.calls.length;
      await act(async () => {
        vi.advanceTimersByTime(6_000);
        await flushMicrotasks(2);
      });
      expect(getLinearConnectionStatus.mock.calls.length).toBeGreaterThan(callsBefore);
      expect(screen.queryByRole("button", { name: /linear quick view/i })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not run automatic hidden Linear checks on remote projects", async () => {
    vi.useFakeTimers();
    useAppStore.setState({
      project: null,
      projectBinding: {
        kind: "remote",
        key: "remote:target-1:project-1",
        targetId: "target-1",
        runtimeName: "Mac Studio",
        projectId: "project-1",
        rootPath: "/Users/admin/Projects/perf pass",
        displayName: "perf pass",
      },
    } as any);
    const getLinearConnectionStatus = vi.fn(async () => ({
      tokenStored: true,
      connected: false,
      viewerId: null,
      viewerName: null,
      checkedAt: "2026-04-22T01:00:00.000Z",
      authMode: "manual",
      oauthAvailable: true,
      tokenExpiresAt: null,
      message: "Linear connection check is still starting.",
    }));
    globalThis.window.ade.cto = {
      getLinearConnectionStatus,
    } as any;

    try {
      render(<TopBar />);

      await act(async () => {
        window.dispatchEvent(new Event("ade:runtime-bridge-ready"));
        window.dispatchEvent(new Event("focus"));
        vi.advanceTimersByTime(30_000);
        await flushMicrotasks(2);
      });
      expect(getLinearConnectionStatus).not.toHaveBeenCalled();
      expect(screen.queryByRole("button", { name: /linear quick view/i })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
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
