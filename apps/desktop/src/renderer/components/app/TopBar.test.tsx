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

  it("does not eagerly resolve icons for non-current recent projects", async () => {
    useAppStore.setState({ project: null } as any);

    render(<TopBar />);

    expect(await screen.findByText("ADE")).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 850));

    expect(globalThis.window.ade.project.resolveIcon).not.toHaveBeenCalled();
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

  it("shows project icon replacement errors", async () => {
    globalThis.window.ade.project.chooseIcon = vi.fn(async () => {
      throw new Error("Failed to set project icon: Project icon must be 10 MB or smaller.");
    }) as any;

    render(<TopBar />);

    fireEvent.click(await screen.findByLabelText("Project icon"));
    fireEvent.click(await screen.findByText("Replace"));

    expect((await screen.findByRole("alert")).textContent).toContain("Project icon must be 10 MB or smaller.");
  });

  it("confirms before removing a project tab", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    render(<TopBar />);

    await screen.findByText("ADE");
    fireEvent.click(screen.getByTitle("Remove project"));

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Close \"ADE\" and remove it from project tabs?"));
    expect(globalThis.window.ade.project.forgetRecent).not.toHaveBeenCalled();
  });

  it("removes the project tab after confirmation", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);

    render(<TopBar />);

    await screen.findByText("ADE");
    fireEvent.click(screen.getByTitle("Remove project"));

    await waitFor(() => {
      expect(globalThis.window.ade.project.forgetRecent).toHaveBeenCalledWith("/Users/arul/ADE");
    });
  });
});
