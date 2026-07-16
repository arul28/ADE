/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TopBar } from "./TopBar";
import { applyShellHeaderInset } from "../../lib/zoom";
import { openConnectionsPanel } from "../../lib/connectionsPanel";
import { useAppStore } from "../../state/appStore";
import { requestLinearIssueQuickView } from "../../lib/linearIssueQuickViewNavigation";
import {
  ADE_BROWSER_VIEW_OCCLUSION_END_EVENT,
  ADE_BROWSER_VIEW_OCCLUSION_START_EVENT,
} from "../../lib/workSidebarBrowserResize";

const PROJECT_TAB_ROOT_MIME = "application/x-ade-project-root";
const PROJECT_TAB_WINDOW_MIME = "application/x-ade-window-id";

vi.mock("../settings/SyncDevicesSection", () => ({
  useSyncConnections: () => ({ loading: false, status: null, devices: [], busy: false }),
  ThisMacCard: () => <div data-testid="this-mac-card">This Mac</div>,
  PhoneConnectionsTab: () => (
    <section data-testid="sync-devices-section" data-variant="phone">
      Phone connections
    </section>
  ),
  WebConnectionsTab: () => (
    <section data-testid="sync-devices-section" data-variant="web">
      Web connections
      <details>
        <summary>Web clients summary</summary>
        <button type="button">Hidden revoke</button>
      </details>
    </section>
  ),
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
  DEFAULT_ZOOM: 100,
  ZOOM_STEP: 10,
  displayZoomToLevel: (value: number) => value,
  getStoredZoomLevel: () => 100,
  applyShellHeaderInset: vi.fn(),
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

function makeRemoteConnectionSnapshot(
  targetId: string,
  name = "Mac Studio",
  overrides: Record<string, unknown> = {},
) {
  const state = overrides.state ?? "connected";
  return {
    connections: [
      {
        target: {
          id: targetId,
          name,
          hostname: "studio.local",
          sshUser: "admin",
          port: 22,
          sshKeyPath: null,
          routes: [],
          lastSeenArch: "darwin-arm64",
          runtimeBinaryVersion: "1.0.0-beta.1",
          lastConnectedAt: 1_700_000_000,
        },
        state,
        arch: "darwin-arm64",
        version: "1.0.0-beta.1",
        projects: [],
        lastError: overrides.lastError ?? null,
        lastAttemptedAt: overrides.lastAttemptedAt ?? null,
        connectedAt: state === "connected" ? 1_700_000_000 : null,
      },
    ],
    connectedCount: state === "connected" ? 1 : 0,
    updatedAt: 1_700_000_000,
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
    personalChatsTabOpen: false,
    setPersonalChatsTabOpen: vi.fn(),
    closePersonalChatsTab: vi.fn(),
    projectTransition: null,
    projectTransitionError: null,
    openProjectTabRoots: [],
    projectInfoByRoot: {},
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

function renderChatsTopBar({
  personalChatsRouteActive,
  storeOverrides = {},
}: {
  personalChatsRouteActive: boolean;
  storeOverrides?: Partial<ReturnType<typeof useAppStore.getState>>;
}) {
  useAppStore.setState({
    project: null,
    projectHydrated: true,
    showWelcome: true,
    personalChatsTabOpen: true,
    ...storeOverrides,
  } as any);
  const onNavigate = vi.fn();

  return {
    onNavigate,
    ...render(
      <TopBar
        personalChatsRouteActive={personalChatsRouteActive}
        onNavigate={onNavigate}
      />,
    ),
  };
}

function renderTopBarWithRouter() {
  return render(
    <MemoryRouter>
      <TopBar />
    </MemoryRouter>,
  );
}

function getConnectionsControl() {
  return screen.getByRole("button", {
    name: /^Connections, (?:not )?connected$/,
  });
}

describe("TopBar", () => {
  const originalAde = globalThis.window.ade;
  const originalWebClientMode = globalThis.window.__adeWebClient;

  beforeEach(() => {
    delete globalThis.window.__adeWebClient;
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
      storage: {
        getPressure: vi.fn(async () => ({
          state: "normal",
          freeBytes: 100 * 1024 ** 3,
          totalBytes: 500 * 1024 ** 3,
          freeFraction: 0.2,
          perRoot: [],
          sampledAt: "2026-04-22T00:00:00.000Z",
        })),
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
        onCommand: vi.fn(() => () => {}),
      },
      lanes: { list: vi.fn(async () => []) },
      sessions: { list: vi.fn(async () => []) },
      agentChat: {
        list: vi.fn(async () => []),
        onEvent: vi.fn(() => () => {}),
      },
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
    if (originalWebClientMode === undefined) {
      delete globalThis.window.__adeWebClient;
    } else {
      globalThis.window.__adeWebClient = originalWebClientMode;
    }
  });

  it("shows connections before a project is open without immediate polling", async () => {
    useAppStore.setState({ project: null, projectHydrated: true, showWelcome: true } as any);

    render(<TopBar />);

    expect(getConnectionsControl().getAttribute("aria-expanded")).toBe("false");
    expect(globalThis.window.ade.sync.getStatus).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(globalThis.window.ade.project.listRecent).toHaveBeenCalled();
    });
  });

  it("shows a closable Chats pseudo-tab when chats are open without a project", () => {
    const { onNavigate } = renderChatsTopBar({
      personalChatsRouteActive: true,
    });

    expect(screen.getByText("Chats")).toBeTruthy();
    const closeButton = screen.getByTitle("Close chats");
    expect(useAppStore.getState().closePersonalChatsTab).not.toHaveBeenCalled();
    fireEvent.click(closeButton);
    expect(useAppStore.getState().closePersonalChatsTab).toHaveBeenCalledOnce();
    expect(onNavigate).toHaveBeenCalledWith("/work", { replace: true });
  });

  it("opens and activates New Tab from projectless Chats without closing Chats", () => {
    const { onNavigate, rerender } = renderChatsTopBar({
      personalChatsRouteActive: true,
    });

    fireEvent.click(screen.getByTitle("Open another project"));

    expect(useAppStore.getState().openNewTab).toHaveBeenCalledOnce();
    expect(onNavigate).toHaveBeenCalledWith("/work");

    useAppStore.setState({ isNewTabOpen: true } as any);
    rerender(<TopBar personalChatsRouteActive={false} onNavigate={onNavigate} />);

    expect(screen.getByText("New Tab").parentElement?.getAttribute("data-state")).toBe("active");
    expect(screen.getByText("Chats").parentElement?.getAttribute("data-state")).toBeNull();
  });

  it("navigates to an inactive Chats tab", () => {
    const { onNavigate } = renderChatsTopBar({
      personalChatsRouteActive: false,
      storeOverrides: { isNewTabOpen: true },
    });

    fireEvent.click(screen.getByText("Chats").parentElement!);

    expect(onNavigate).toHaveBeenCalledOnce();
    expect(onNavigate).toHaveBeenCalledWith("/chats");
  });

  it("returns to Chats when the projectless New Tab is closed", () => {
    const { onNavigate } = renderChatsTopBar({
      personalChatsRouteActive: false,
      storeOverrides: { isNewTabOpen: true },
    });

    fireEvent.click(screen.getByTitle("Close new tab"));

    expect(useAppStore.getState().cancelNewTab).toHaveBeenCalledOnce();
    expect(onNavigate).toHaveBeenCalledOnce();
    expect(onNavigate).toHaveBeenCalledWith("/chats");
  });

  it("closes an inactive Chats tab without navigating away from New Tab", () => {
    const { onNavigate } = renderChatsTopBar({
      personalChatsRouteActive: false,
      storeOverrides: { isNewTabOpen: true },
    });

    fireEvent.click(screen.getByTitle("Close chats"));

    expect(useAppStore.getState().closePersonalChatsTab).toHaveBeenCalledOnce();
    expect(useAppStore.getState().cancelNewTab).not.toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("does not activate a tab when the close button is pressed via keyboard", () => {
    const { onNavigate } = renderChatsTopBar({
      personalChatsRouteActive: false,
      storeOverrides: { isNewTabOpen: true },
    });

    fireEvent.keyDown(screen.getByTitle("Close chats"), { key: "Enter" });

    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("routes back to the project when its tab is clicked while Chats is foreground", () => {
    const root = "/Users/arul/ADE";
    const { onNavigate } = renderChatsTopBar({
      personalChatsRouteActive: true,
      storeOverrides: {
        project: { rootPath: root, name: "ADE" },
        showWelcome: false,
        openProjectTabRoots: [root],
        projectInfoByRoot: { [root]: { rootPath: root, displayName: "ADE" } },
      } as any,
    });

    fireEvent.click(screen.getByText("ADE", { selector: "span" }).closest('[role="button"]')!);

    expect(onNavigate).toHaveBeenCalledWith("/work", { replace: true });
    expect(useAppStore.getState().switchProjectToPath).not.toHaveBeenCalled();
  });

  it("drops the project tab's active styling while the Chats tab is the foreground surface", () => {
    const root = "/Users/arul/ADE";
    renderChatsTopBar({
      personalChatsRouteActive: true,
      storeOverrides: {
        project: { rootPath: root, name: "ADE" },
        showWelcome: false,
        openProjectTabRoots: [root],
        projectInfoByRoot: { [root]: { rootPath: root, displayName: "ADE" } },
      } as any,
    });

    expect(screen.getByText("Chats").parentElement?.getAttribute("data-state")).toBe("active");
    const projectTab = screen.getByText("ADE", { selector: "span" }).closest('[role="button"]');
    expect(projectTab?.getAttribute("data-state")).toBeNull();
    expect(projectTab?.getAttribute("aria-current")).toBe("true");
  });

  it("keeps the mobile connections tab open before a project is open", async () => {
    useAppStore.setState({ project: null, projectHydrated: true, showWelcome: true } as any);

    renderTopBarWithRouter();

    const connectionsButton = getConnectionsControl();
    fireEvent.click(connectionsButton);
    const mobileTab = screen.getByRole("tab", { name: "Phone" });
    fireEvent.click(mobileTab);

    await act(async () => {
      await flushMicrotasks(2);
    });

    expect(screen.getByRole("dialog", { name: "Connections" })).toBeTruthy();
    expect(screen.getByText("Sign in to connect your devices")).toBeTruthy();
    expect(mobileTab.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("sync-devices-section").getAttribute("data-variant")).toBe("phone");
    expect(connectionsButton.getAttribute("aria-expanded")).toBe("true");
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

  it("uses local recent metadata for local tabs when a remote recent has the same path", async () => {
    const rootPath = "/Users/arul/ADE";
    (globalThis.window.ade.project.listRecent as any).mockResolvedValueOnce([
      {
        rootPath,
        displayName: "Remote ADE",
        exists: true,
        lastOpenedAt: "2026-04-23T00:00:00.000Z",
        kind: "remote",
        remote: {
          targetId: "studio",
          projectId: "remote-project",
          runtimeName: "Mac Studio",
          hostname: "studio.local",
        },
      },
      {
        rootPath,
        displayName: "Local ADE",
        exists: true,
        lastOpenedAt: "2026-04-22T00:00:00.000Z",
        kind: "local",
      },
    ]);

    render(<TopBar />);

    expect(await screen.findByText("Local ADE")).toBeTruthy();
    expect(screen.queryByText("Remote ADE")).toBeNull();
    expect(screen.getByTitle(rootPath)).toBeTruthy();
  });

  it("renders a remote project tab with the connections control without immediate polling", async () => {
    (globalThis.window.ade.remoteRuntime.getConnectionSnapshot as any)
      .mockResolvedValue(makeRemoteConnectionSnapshot("studio"));
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

    expect(await screen.findByTitle("Mac Studio: /srv/ade/remote-app (Connected)")).toBeTruthy();
    expect(screen.getByText("Remote App")).toBeTruthy();
    expect(screen.getByLabelText("Remote: Mac Studio")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Connections, connected" })).toBeTruthy();
    expect(globalThis.window.ade.sync.getStatus).not.toHaveBeenCalled();
  });

  it("opens mobile sync from a remote-bound project and reads the routed runtime status", async () => {
    vi.useFakeTimers();
    (globalThis.window.ade.remoteRuntime.getConnectionSnapshot as any)
      .mockResolvedValue(makeRemoteConnectionSnapshot("studio"));
    const getStatus = vi.fn(async () => makeSyncSnapshot());
    globalThis.window.ade.sync.getStatus = getStatus as any;
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

    try {
      renderTopBarWithRouter();

      expect(getConnectionsControl()).toBeTruthy();
      expect(getStatus).not.toHaveBeenCalled();

      act(() => openConnectionsPanel("mobile"));
      const mobileTab = screen.getByRole("tab", { name: "Phone" });
      await act(async () => {
        vi.advanceTimersByTime(0);
        await flushMicrotasks(2);
      });

      expect(getConnectionsControl().getAttribute("aria-expanded")).toBe("true");
      expect(mobileTab.getAttribute("aria-selected")).toBe("true");
      expect(screen.getByTestId("sync-devices-section").getAttribute("data-variant")).toBe("phone");
      expect(getStatus).toHaveBeenCalledWith({ includeTransferReadiness: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks a remote project tab disconnected when the target snapshot is errored", async () => {
    (globalThis.window.ade.remoteRuntime.getConnectionSnapshot as any)
      .mockResolvedValue(
        makeRemoteConnectionSnapshot("studio", "Mac Studio", {
          state: "error",
          lastError: "Remote ADE service connection was interrupted.",
          lastAttemptedAt: 1_700_000_001,
        }),
      );
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

    expect(await screen.findByTitle("Mac Studio: /srv/ade/remote-app (Disconnected)")).toBeTruthy();
    expect(screen.getByLabelText("Disconnected: Mac Studio")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connections, not connected" })).toBeTruthy();
  });

  it("keeps local tabs visible when a remote project is active", async () => {
    (globalThis.window.ade.remoteRuntime.getConnectionSnapshot as any)
      .mockResolvedValue(makeRemoteConnectionSnapshot("studio"));
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

    expect(await screen.findByTitle("Mac Studio: /srv/ade/remote-app (Connected)")).toBeTruthy();
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

  it("surfaces role attribution and staleness on the pressure indicator without mislabeling", async () => {
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
      ptyProcessCount: 0,
      ptyCpuPercent: null,
      ptyMemoryMB: null,
      freeMemoryMB: 900,
      totalMemoryMB: 16_000,
      processSample: { status: "unavailable", reason: "timeout", sampledAt: "2026-04-22T00:00:00.000Z", durationMs: 1_000 },
      roleUsage: null,
    });

    render(<TopBar />);

    const indicator = await screen.findByLabelText("ADE resource pressure level 4");
    expect(indicator.getAttribute("data-ade-resource-pressure-sample-status")).toBe("unavailable");
    expect(indicator.getAttribute("title")).toContain("Terminal process metrics are temporarily unavailable.");
    expect(indicator.getAttribute("title")).not.toContain("agent process");
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
    (globalThis.window.ade.remoteRuntime.getConnectionSnapshot as any)
      .mockResolvedValue(makeRemoteConnectionSnapshot("target-1"));
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
      expect(screen.getByTitle("Mac Studio: /Users/admin/Projects/perf pass (Connected)")).toBeTruthy();
      expect(screen.queryByTitle("/Users/admin/Projects/perf pass")).toBeNull();
      expect(useAppStore.getState().openProjectTabRoots).toEqual([]);
    });
  });

  it("keeps a known local tab when a remote project has the same root path", async () => {
    const remoteBinding = {
      kind: "remote" as const,
      key: "remote:target-1:project-a",
      targetId: "target-1",
      runtimeName: "Mac Studio",
      projectId: "project-a",
      rootPath: "/Users/arul/Projects/perf pass",
      displayName: "perf pass",
    };
    (globalThis.window.ade.remoteRuntime.getConnectionSnapshot as any)
      .mockResolvedValue(makeRemoteConnectionSnapshot("target-1"));
    useAppStore.setState({
      project: {
        rootPath: remoteBinding.rootPath,
        displayName: remoteBinding.displayName,
        baseRef: "main",
      } as any,
      projectBinding: remoteBinding,
      projectInfoByRoot: {
        [remoteBinding.rootPath]: {
          rootPath: remoteBinding.rootPath,
          displayName: "Local perf pass",
          baseRef: "main",
        },
      },
      openProjectTabRoots: [remoteBinding.rootPath],
    } as any);

    render(<TopBar />);

    expect(
      await screen.findByTitle("Mac Studio: /Users/arul/Projects/perf pass (Connected)"),
    ).toBeTruthy();
    expect(screen.getByTitle("/Users/arul/Projects/perf pass")).toBeTruthy();
    expect(useAppStore.getState().openProjectTabRoots).toEqual([
      remoteBinding.rootPath,
    ]);
  });

  it("keeps a different-path local tab when the project briefly goes null during a remote bind", async () => {
    // Repro of the disappearing-local-tab bug: binding a window to a remote
    // project emits projectChanged(null) and projectBindingChanged(remote) as
    // two separate IPC messages, so the renderer momentarily sees
    // project==null && !remoteBinding && showWelcome==true with no transition
    // in flight. That transient must NOT wipe the (different-path) local tab.
    (globalThis.window.ade.remoteRuntime.getConnectionSnapshot as any)
      .mockResolvedValue(makeRemoteConnectionSnapshot("target-1"));

    render(<TopBar />);

    // The active local project becomes a tab on mount.
    expect(await screen.findByTitle("/Users/arul/ADE")).toBeTruthy();
    expect(useAppStore.getState().openProjectTabRoots).toEqual(["/Users/arul/ADE"]);

    // Step 1: the transient projectChanged(null) lands (no transition).
    await act(async () => {
      useAppStore.setState({
        project: null,
        projectBinding: null,
        showWelcome: true,
        projectTransition: null,
      } as any);
    });
    expect(useAppStore.getState().openProjectTabRoots).toEqual(["/Users/arul/ADE"]);

    // Step 2: the remote binding (a DIFFERENT path) lands.
    const remoteBinding = {
      kind: "remote" as const,
      key: "remote:target-1:project-a",
      targetId: "target-1",
      runtimeName: "Mac Studio",
      projectId: "project-a",
      rootPath: "/srv/ade/remote-app",
      displayName: "Remote App",
    };
    await act(async () => {
      useAppStore.setState({
        project: {
          rootPath: remoteBinding.rootPath,
          displayName: remoteBinding.displayName,
          baseRef: "main",
        },
        projectBinding: remoteBinding,
        showWelcome: false,
      } as any);
    });

    // The different-path local tab survives, and the remote tab renders.
    expect(useAppStore.getState().openProjectTabRoots).toEqual(["/Users/arul/ADE"]);
    expect(screen.getByTitle("/Users/arul/ADE")).toBeTruthy();
    expect(
      await screen.findByTitle("Mac Studio: /srv/ade/remote-app (Connected)"),
    ).toBeTruthy();
  });

  it("keeps existing local tabs when a remote-bound window restores with an empty tab snapshot", async () => {
    // Reload variant: a remote-bound window's main-process tab snapshot can be
    // momentarily empty (projectsForWindowTabs drops idle/evicted roots). The
    // restore must merge, not wipe, so a different-path local tab is preserved.
    const remoteBinding = {
      kind: "remote" as const,
      key: "remote:target-1:project-a",
      targetId: "target-1",
      runtimeName: "Mac Studio",
      projectId: "project-a",
      rootPath: "/srv/ade/remote-app",
      displayName: "Remote App",
    };
    (globalThis.window.ade.remoteRuntime.getConnectionSnapshot as any)
      .mockResolvedValue(makeRemoteConnectionSnapshot("target-1"));
    useAppStore.setState({
      project: {
        rootPath: remoteBinding.rootPath,
        displayName: remoteBinding.displayName,
        baseRef: "main",
      } as any,
      projectBinding: remoteBinding,
      projectInfoByRoot: {
        "/Users/arul/ADE": {
          rootPath: "/Users/arul/ADE",
          displayName: "ADE",
          baseRef: "main",
        },
      },
      openProjectTabRoots: ["/Users/arul/ADE"],
    } as any);
    (globalThis.window.ade.app.getWindowSession as any).mockResolvedValueOnce({
      windowId: 1,
      project: null,
      binding: remoteBinding,
      openProjectTabs: [],
    });

    render(<TopBar />);

    await waitFor(() => {
      expect(useAppStore.getState().openProjectTabRoots).toEqual(["/Users/arul/ADE"]);
    });
    expect(screen.getByTitle("/Users/arul/ADE")).toBeTruthy();
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

  it("opens mobile sync from the connections control", async () => {
    vi.useFakeTimers();
    try {
      renderTopBarWithRouter();

      expect(getConnectionsControl()).toBeTruthy();
      expect(globalThis.window.ade.sync.getStatus).not.toHaveBeenCalled();

      await advancePhoneSyncStartupDelay();
      const connectionsButton = screen.getByRole("button", { name: "Connections, connected" });

      fireEvent.click(connectionsButton);
      const mobileTab = screen.getByRole("tab", { name: "Phone" });
      fireEvent.click(mobileTab);

      expect(screen.getByTestId("sync-devices-section").getAttribute("data-variant")).toBe("phone");
      expect(mobileTab.getAttribute("aria-selected")).toBe("true");
      expect(connectionsButton.getAttribute("aria-expanded")).toBe("true");

      fireEvent.click(screen.getByTitle("Close connections"));

      expect(screen.queryByTestId("sync-devices-section")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens web clients from the connections control", async () => {
    vi.useFakeTimers();
    try {
      renderTopBarWithRouter();

      const connectionsButton = getConnectionsControl();
      expect(connectionsButton.getAttribute("title")).toBe("Machines, mobile, and web clients");

      await advancePhoneSyncStartupDelay();

      fireEvent.click(screen.getByRole("button", { name: "Connections, connected" }));
      const webTab = screen.getByRole("tab", { name: "Web" });
      fireEvent.click(webTab);

      const section = screen.getByTestId("sync-devices-section");
      expect(section.getAttribute("data-variant")).toBe("web");
      expect(section.closest("header")).toBeNull();
      expect(webTab.getAttribute("aria-selected")).toBe("true");
      expect(screen.getByRole("dialog", { name: "Connections" })).toBeTruthy();

      fireEvent.click(screen.getByTitle("Close connections"));

      expect(screen.queryByTestId("sync-devices-section")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks the connections control connected when a browser peer is present", async () => {
    vi.useFakeTimers();
    const getStatus = vi.fn().mockResolvedValue(
      makeSyncSnapshot({
        connectedPeers: [
          { deviceId: "browser-1", deviceName: "Chrome on MacBook Pro", platform: "macOS", deviceType: "browser" },
        ],
      }),
    );
    globalThis.window.ade.sync.getStatus = getStatus as any;
    try {
      renderTopBarWithRouter();

      await advancePhoneSyncStartupDelay();

      const connectionsButton = screen.getByRole("button", { name: "Connections, connected" });
      expect(connectionsButton.getAttribute("title")).toBe("Machines, mobile, and web clients");
      fireEvent.click(connectionsButton);
      fireEvent.click(screen.getByRole("tab", { name: "Web" }));
      expect(screen.getByTestId("sync-devices-section").getAttribute("data-variant")).toBe("web");
    } finally {
      vi.useRealTimers();
    }
  });

  it("hides the host web-pairing control in hosted web-client mode", () => {
    globalThis.window.__adeWebClient = true;

    render(<TopBar />);

    expect(screen.queryByRole("button", { name: "Web, not connected" })).toBeNull();
  });

  it("switches between mobile and web within one connections panel", () => {
    renderTopBarWithRouter();

    fireEvent.click(getConnectionsControl());
    const mobileTab = screen.getByRole("tab", { name: "Phone" });
    const webTab = screen.getByRole("tab", { name: "Web" });
    fireEvent.click(mobileTab);
    expect(screen.getByTestId("sync-devices-section").getAttribute("data-variant")).toBe("phone");
    expect(mobileTab.getAttribute("aria-selected")).toBe("true");

    fireEvent.click(webTab);

    expect(mobileTab.getAttribute("aria-selected")).toBe("false");
    expect(webTab.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("sync-devices-section").getAttribute("data-variant")).toBe("web");
    expect(screen.getAllByTestId("sync-devices-section")).toHaveLength(1);
  });

  it("traps focus on the visible web clients summary", () => {
    renderTopBarWithRouter();
    fireEvent.click(getConnectionsControl());
    fireEvent.click(screen.getByRole("tab", { name: "Web" }));

    const first = screen.getByTitle("Close connections");
    const summary = screen.getByText("Web clients summary");
    summary.focus();
    fireEvent.keyDown(summary, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(summary);
  });

  it("closes the web tab on Escape without disturbing connection state", () => {
    renderTopBarWithRouter();

    const connectionsButton = getConnectionsControl();
    fireEvent.click(connectionsButton);
    fireEvent.click(screen.getByRole("tab", { name: "Web" }));
    const dialog = screen.getByRole("dialog", { name: "Connections" });

    fireEvent.keyDown(dialog, { key: "Escape" });

    expect(screen.queryByTestId("sync-devices-section")).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Connections" })).toBeNull();
    expect(connectionsButton.getAttribute("aria-expanded")).toBe("false");
    expect(connectionsButton.getAttribute("aria-label")).toBe("Connections, not connected");
  });

  it("occludes the native browser while the connections machines tab is open", async () => {
    const events: string[] = [];
    const onStart = () => events.push("start");
    const onEnd = () => events.push("end");
    window.addEventListener(ADE_BROWSER_VIEW_OCCLUSION_START_EVENT, onStart);
    window.addEventListener(ADE_BROWSER_VIEW_OCCLUSION_END_EVENT, onEnd);
    try {
      renderTopBarWithRouter();

      fireEvent.click(getConnectionsControl());

      expect(
        await screen.findByRole("dialog", { name: "Connections" }),
      ).toBeTruthy();
      expect(screen.getByRole("tab", { name: "Machines" }).getAttribute("aria-selected")).toBe("true");
      await waitFor(() => expect(events).toEqual(["start"]));

      fireEvent.click(screen.getByTitle("Close connections"));

      await waitFor(() =>
        expect(
          screen.queryByRole("dialog", { name: "Connections" }),
        ).toBeNull(),
      );
      expect(events).toEqual(["start", "end"]);
    } finally {
      window.removeEventListener(ADE_BROWSER_VIEW_OCCLUSION_START_EVENT, onStart);
      window.removeEventListener(ADE_BROWSER_VIEW_OCCLUSION_END_EVENT, onEnd);
    }
  });

  it("occludes the native browser while the connections mobile tab is open", async () => {
    const events: string[] = [];
    const onStart = () => events.push("start");
    const onEnd = () => events.push("end");
    window.addEventListener(ADE_BROWSER_VIEW_OCCLUSION_START_EVENT, onStart);
    window.addEventListener(ADE_BROWSER_VIEW_OCCLUSION_END_EVENT, onEnd);
    try {
      renderTopBarWithRouter();

      fireEvent.click(getConnectionsControl());
      fireEvent.click(screen.getByRole("tab", { name: "Phone" }));

      expect(
        (await screen.findByTestId("sync-devices-section")).getAttribute("data-variant"),
      ).toBe("phone");
      await waitFor(() => expect(events).toEqual(["start"]));

      fireEvent.click(screen.getByTitle("Close connections"));

      await waitFor(() => expect(screen.queryByTestId("sync-devices-section")).toBeNull());
      expect(events).toEqual(["start", "end"]);
    } finally {
      window.removeEventListener(ADE_BROWSER_VIEW_OCCLUSION_START_EVENT, onStart);
      window.removeEventListener(ADE_BROWSER_VIEW_OCCLUSION_END_EVENT, onEnd);
    }
  });

  it("refreshes the connections state from global sync events", async () => {
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
      expect(screen.getByRole("button", { name: "Connections, not connected" })).toBeTruthy();

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

      expect(screen.getByRole("button", { name: "Connections, connected" })).toBeTruthy();
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

  it("refreshes connection status when the window regains focus", async () => {
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

      expect(screen.getByRole("button", { name: "Connections, not connected" })).toBeTruthy();

      await act(async () => {
        window.dispatchEvent(new Event("focus"));
        await flushMicrotasks(2);
      });

      expect(screen.getByRole("button", { name: "Connections, connected" })).toBeTruthy();
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
    expect(window.location.hash).toBe("#/settings?tab=general#linear-connection");
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

  it("runs automatic Linear checks on remote projects but hides the button when the remote isn't connected", async () => {
    // A remote-bound project surfaces the REMOTE machine's Linear connection:
    // getLinearConnectionStatus routes to the remote daemon, so the auto-check
    // runs just like a local project. When that remote check reports the
    // workspace is not connected, the quick-view button stays hidden.
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
      expect(getLinearConnectionStatus).toHaveBeenCalled();
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

  // The native View-menu zoom items dispatch an appZoomCommand that the renderer
  // routes through the same applyZoom path as the in-app zoom counter, so the
  // applied level and persistence stay consistent. displayZoomToLevel is mocked
  // as identity, so setLevel receives the display percentage directly; the
  // stored level starts at 100 (getStoredZoomLevel mock).
  const getZoomCommandHandler = (): ((command: string) => void) => {
    const onCommand = globalThis.window.ade.zoom.onCommand as unknown as {
      mock: { calls: Array<[(command: string) => void]> };
    };
    const handler = onCommand.mock.calls[0]?.[0];
    expect(handler, "TopBar must subscribe to zoom.onCommand").toBeTruthy();
    return handler;
  };

  it("zooms in via the View-menu command, applying and persisting the new level", () => {
    render(<TopBar />);
    const handler = getZoomCommandHandler();

    act(() => handler("in"));

    expect(globalThis.window.ade.zoom.setLevel).toHaveBeenLastCalledWith(110);
    expect(globalThis.window.localStorage.getItem("ade.zoomLevel")).toBe("110");
    expect(vi.mocked(applyShellHeaderInset)).toHaveBeenLastCalledWith(110);
  });

  it("zooms out via the View-menu command, applying and persisting the new level", () => {
    render(<TopBar />);
    const handler = getZoomCommandHandler();

    act(() => handler("out"));

    expect(globalThis.window.ade.zoom.setLevel).toHaveBeenLastCalledWith(90);
    expect(globalThis.window.localStorage.getItem("ade.zoomLevel")).toBe("90");
    expect(vi.mocked(applyShellHeaderInset)).toHaveBeenLastCalledWith(90);
  });

  it("resets to the default level via the View-menu command regardless of current zoom", () => {
    render(<TopBar />);
    const handler = getZoomCommandHandler();

    act(() => handler("in"));
    act(() => handler("reset"));

    expect(globalThis.window.ade.zoom.setLevel).toHaveBeenLastCalledWith(100);
    expect(globalThis.window.localStorage.getItem("ade.zoomLevel")).toBe("100");
    expect(vi.mocked(applyShellHeaderInset)).toHaveBeenLastCalledWith(100);
  });

  it("compounds back-to-back menu zoom-in commands without a render in between", () => {
    render(<TopBar />);
    const handler = getZoomCommandHandler();

    // Two commands dispatched before React re-renders must each build on the
    // last applied level (110 → 120), not collapse onto a stale ref (both 110).
    act(() => {
      handler("in");
      handler("in");
    });

    expect(globalThis.window.ade.zoom.setLevel).toHaveBeenLastCalledWith(120);
    expect(globalThis.window.localStorage.getItem("ade.zoomLevel")).toBe("120");
  });
});
