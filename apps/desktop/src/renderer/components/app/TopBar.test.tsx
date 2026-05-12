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
      github: {
        getStatus: vi.fn(async () => ({
          tokenStored: false,
          tokenDecryptionFailed: false,
          storageScope: "app",
          repo: { owner: "acme", name: "ade", url: "https://github.com/acme/ade" },
          hasOrigin: true,
          userLogin: null,
          scopes: [],
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

    expect(await screen.findByText("1 phone connected to ADE Desktop")).toBeTruthy();

    fireEvent.click(screen.getByTitle("Connect a phone to this machine"));

    expect(screen.getByText("Connect to the ADE mobile app")).toBeTruthy();
    expect(screen.getByTestId("sync-devices-section")).toBeTruthy();
    expect(screen.getByTitle("Connect a phone to this machine").getAttribute("aria-expanded")).toBe("true");

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

    expect(await screen.findByText("1 phone connected to ADE Desktop")).toBeTruthy();
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

    expect(await screen.findByText("1 phone connected to ADE Desktop")).toBeTruthy();
    expect(getStatus).toHaveBeenCalledTimes(2);
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

    fireEvent.click(await screen.findByRole("button", { name: /linear quick view/i }));

    await waitFor(() => {
      expect(screen.getAllByText("Add Linear quick view").length).toBeGreaterThan(0);
    });
    const quickViewDialog = screen.getByRole("dialog", { name: /linear quick view/i });
    expect(document.body.querySelector("[data-linear-quick-view-backdrop]")).toBeTruthy();
    expect(quickViewDialog.getAttribute("style")).toContain("rgba(123, 138, 240, 0.55)");

    fireEvent.click(screen.getByRole("button", { name: /create lane/i }));

    await waitFor(() => {
      expect(createLane).toHaveBeenCalledWith(expect.objectContaining({
        name: "ADE-123 Add Linear quick view",
        branchName: "ade-123-add-linear-quick-view",
        linearIssue: expect.objectContaining({
          identifier: "ADE-123",
          branchName: "ade-123-add-linear-quick-view",
        }),
      }));
    });
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

    await waitFor(() => {
      expect(getLinearConnectionStatus).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByRole("button", { name: /linear quick view/i })).toBeNull();

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });

    expect(await screen.findByRole("button", { name: /linear quick view/i })).toBeTruthy();
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
