// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../state/appStore";
import { RemoteTargetList } from "./RemoteTargetList";

const remoteRuntimeMock = {
  listTargets: vi.fn(),
  listDiscoveredMachines: vi.fn(),
  saveTarget: vi.fn(),
  removeTarget: vi.fn(),
  connect: vi.fn(),
  listProjects: vi.fn(),
  addProject: vi.fn(),
  openProject: vi.fn(),
  callAction: vi.fn(),
  streamEvents: vi.fn(),
  checkLocalWork: vi.fn(),
  disconnect: vi.fn(),
};

const lanesMock = {
  list: vi.fn(),
  listSnapshots: vi.fn(),
};

function installAdeMock(): void {
  Object.defineProperty(window, "ade", {
    configurable: true,
    value: {
      remoteRuntime: remoteRuntimeMock,
      lanes: lanesMock,
    },
  });
}

describe("RemoteTargetList", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    useAppStore.setState({
      project: null,
      projectBinding: null,
      projectTransition: null,
      projectTransitionError: null,
      showWelcome: true,
      lanes: [],
      selectedLaneId: null,
    });
    Reflect.deleteProperty(window, "ade");
  });

  it("shows LAN-discovered machines and uses their route to prefill the SSH form", async () => {
    remoteRuntimeMock.listTargets.mockResolvedValue([]);
    remoteRuntimeMock.listDiscoveredMachines.mockResolvedValue([
      {
        id: "device-1::service",
        serviceName: "ADE Sync Studio",
        machineName: "Studio",
        hostIdentity: "device-1",
        hostName: "studio.local",
        port: 8787,
        addresses: ["192.168.1.42"],
        primaryRoute: "192.168.1.42",
        tailscaleAddress: "studio.tailnet.ts.net",
        runtimeKind: "daemon",
        runtimeVersion: "0.0.0",
        projectIds: ["project-1", "project-2"],
        projectCount: 2,
        lastSeenAt: 1234,
      },
    ]);
    installAdeMock();

    render(<RemoteTargetList />);

    await waitFor(() => expect(screen.getByText("Studio")).toBeTruthy());
    expect(screen.getByText("192.168.1.42:8787")).toBeTruthy();
    expect(screen.getByText("Background ADE 0.0.0 | 2 projects advertised")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Use host" }));

    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Studio");
    expect((screen.getByLabelText("Host") as HTMLInputElement).value).toBe("192.168.1.42");
    expect((screen.getByLabelText("Port") as HTMLInputElement).value).toBe("");
  });

  it("warns in-app before opening a remote project when matching local work is dirty", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const target = {
      id: "target-1",
      name: "Mac Studio",
      hostname: "studio.local",
      sshUser: "ade",
      port: 22,
      sshKeyPath: null,
      lastSeenArch: "darwin-arm64",
      runtimeBinaryVersion: "1.0.0",
      lastConnectedAt: null,
    };
    const project = {
      projectId: "project-1",
      rootPath: "/remote/ADE",
      displayName: "ADE",
      addedAt: 1,
      lastOpenedAt: 2,
      gitOriginUrl: "git@github.com:example/ade.git",
    };
    remoteRuntimeMock.listTargets.mockResolvedValue([target]);
    remoteRuntimeMock.listDiscoveredMachines.mockResolvedValue([]);
    remoteRuntimeMock.connect.mockResolvedValue({
      target,
      arch: "darwin-arm64",
      version: "1.0.0",
      projects: [project],
    });
    remoteRuntimeMock.checkLocalWork.mockResolvedValue({
      remoteProjectId: "project-1",
      remoteDisplayName: "ADE",
      remoteGitOriginUrl: "git@github.com:example/ade.git",
      hasDirtyWork: true,
      matches: [
        {
          rootPath: "/Users/admin/Projects/ADE",
          displayName: "ADE",
          gitOriginUrl: "git@github.com:example/ade.git",
          dirtyCount: 3,
        },
      ],
    });
    remoteRuntimeMock.openProject.mockResolvedValue({
      kind: "remote",
      key: "remote:target-1:project-1",
      targetId: "target-1",
      runtimeName: "Mac Studio",
      projectId: "project-1",
      rootPath: "/remote/ADE",
      displayName: "ADE",
    });
    lanesMock.list.mockResolvedValue([]);
    installAdeMock();

    render(<RemoteTargetList />);

    await waitFor(() => expect(screen.getAllByText("Mac Studio").length).toBeGreaterThan(0));
    const connectButton = screen.getAllByRole("button", { name: "Connect" })
      .find((button) => !button.hasAttribute("disabled"));
    expect(connectButton).toBeTruthy();
    fireEvent.click(connectButton!);
    await waitFor(() => expect(screen.getByText("/remote/ADE")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    await waitFor(() => expect(screen.getByRole("dialog", { name: "Local work found" })).toBeTruthy());
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(screen.getByText("3 changed files")).toBeTruthy();
    expect(screen.getByText("/Users/admin/Projects/ADE")).toBeTruthy();
    expect(remoteRuntimeMock.openProject).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Local work found" })).toBeNull());
    expect(remoteRuntimeMock.openProject).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "Local work found" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    await waitFor(() => expect(remoteRuntimeMock.openProject).toHaveBeenCalledWith("target-1", "project-1"));
  });
});
