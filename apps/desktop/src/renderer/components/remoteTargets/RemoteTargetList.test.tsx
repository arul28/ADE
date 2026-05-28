// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
    Reflect.deleteProperty(window, "ade");
  });

  it("shows LAN-discovered machines and uses their route to prefill the SSH form", async () => {
    remoteRuntimeMock.listTargets.mockResolvedValue([]);
    remoteRuntimeMock.listDiscoveredMachines.mockResolvedValue({
      machines: [
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
      ],
      diagnostics: [],
    });
    installAdeMock();

    render(<RemoteTargetList />);

    await waitFor(() => expect(screen.getByText("Studio")).toBeTruthy());
    expect(screen.getByText("studio.tailnet.ts.net:8787")).toBeTruthy();
    expect(
      screen.getByText("Background ADE 0.0.0 | 2 projects advertised"),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Use host" }));

    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(
      "Studio",
    );
    expect((screen.getByLabelText("Host") as HTMLInputElement).value).toBe(
      "studio.tailnet.ts.net",
    );
    expect((screen.getByLabelText("Port") as HTMLInputElement).value).toBe("");

    const savedTarget = {
      id: "target-1",
      name: "Studio",
      hostname: "studio.tailnet.ts.net",
      sshUser: null,
      port: null,
      sshKeyPath: null,
      routes: [
        {
          hostname: "studio.tailnet.ts.net",
          port: null,
          source: "tailscale",
          lastSucceededAt: null,
        },
        {
          hostname: "192.168.1.42",
          port: null,
          source: "bonjour",
          lastSucceededAt: null,
        },
        {
          hostname: "studio.local",
          port: null,
          source: "bonjour",
          lastSucceededAt: null,
        },
      ],
      lastSeenArch: null,
      runtimeBinaryVersion: null,
      lastConnectedAt: null,
    };
    remoteRuntimeMock.saveTarget.mockResolvedValue(savedTarget);
    remoteRuntimeMock.connect.mockResolvedValue({
      target: savedTarget,
      arch: "darwin-arm64",
      version: "1.0.0",
      projects: [],
    });

    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() =>
      expect(remoteRuntimeMock.saveTarget).toHaveBeenCalledWith(
        expect.objectContaining({
          hostname: "studio.tailnet.ts.net",
          routes: savedTarget.routes,
        }),
      ),
    );
  });

  it("connects a saved machine without listing remote projects in the connection manager", async () => {
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
    remoteRuntimeMock.listDiscoveredMachines.mockResolvedValue({
      machines: [],
      diagnostics: [],
    });
    remoteRuntimeMock.connect.mockResolvedValue({
      target,
      arch: "darwin-arm64",
      version: "1.0.0",
      compatibilityWarnings: [
        "Remote ADE service reported 0.9.0; local ADE is 1.0.0. ADE will connect because the RPC capabilities are compatible.",
      ],
      projects: [project],
    });
    lanesMock.list.mockResolvedValue([]);
    installAdeMock();

    render(<RemoteTargetList />);

    await waitFor(() =>
      expect(screen.getAllByText("Mac Studio").length).toBeGreaterThan(0),
    );
    const connectButton = screen
      .getAllByRole("button", { name: "Connect" })
      .find((button) => !button.hasAttribute("disabled"));
    expect(connectButton).toBeTruthy();
    fireEvent.click(connectButton!);
    await waitFor(() =>
      expect(remoteRuntimeMock.connect).toHaveBeenCalledWith("target-1"),
    );
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getByText("ADE service 1.0.0 on darwin-arm64.")).toBeTruthy();
    expect(screen.getByText(/RPC capabilities are compatible/i)).toBeTruthy();
    expect(screen.queryByText("/remote/ADE")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open" })).toBeNull();
  });

  it("surfaces Tailscale discovery diagnostics separately from empty results", async () => {
    remoteRuntimeMock.listTargets.mockResolvedValue([]);
    remoteRuntimeMock.listDiscoveredMachines.mockResolvedValue({
      machines: [],
      diagnostics: [
        {
          source: "tailscale",
          severity: "warning",
          code: "tailscale-unavailable",
          message: "Tailscale CLI was not found; only LAN discovery ran.",
          detail: "ENOENT",
        },
      ],
    });
    installAdeMock();

    render(<RemoteTargetList />);

    await waitFor(() =>
      expect(
        screen.getByText("Tailscale CLI was not found; only LAN discovery ran."),
      ).toBeTruthy(),
    );
    expect(screen.getByText("No LAN ADE services or Tailscale peers found.")).toBeTruthy();
  });
});
