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
  getSshHostKeyTrust: vi.fn(),
  trustSshHostKey: vi.fn(),
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
  remoteRuntimeMock.getSshHostKeyTrust.mockResolvedValue({ state: "trusted" });
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

  it("prompts to trust a new machine identity before connecting", async () => {
    const target = {
      id: "target-1",
      name: "Mac Studio",
      hostname: "studio.local",
      sshUser: "ade",
      port: 22,
      sshKeyPath: null,
      lastSeenArch: null,
      runtimeBinaryVersion: null,
      lastConnectedAt: null,
    };
    remoteRuntimeMock.listTargets.mockResolvedValue([target]);
    remoteRuntimeMock.listDiscoveredMachines.mockResolvedValue({
      machines: [],
      diagnostics: [],
    });
    remoteRuntimeMock.getSshHostKeyTrust.mockResolvedValueOnce({
      state: "needs_trust",
      targetId: "target-1",
      host: "studio.local",
      port: 22,
      route: {
        hostname: "studio.local",
        port: 22,
        source: "manual",
        lastSucceededAt: null,
      },
      keyType: "ssh-ed25519",
      fingerprintSha256: "SHA256:abc123",
      knownHostsPath: "/Users/test/.ssh/known_hosts",
    });
    remoteRuntimeMock.trustSshHostKey.mockResolvedValue({
      trusted: true,
      identity: {
        targetId: "target-1",
        host: "studio.local",
        port: 22,
        route: {
          hostname: "studio.local",
          port: 22,
          source: "manual",
          lastSucceededAt: null,
        },
        keyType: "ssh-ed25519",
        fingerprintSha256: "SHA256:abc123",
        knownHostsPath: "/Users/test/.ssh/known_hosts",
      },
    });
    remoteRuntimeMock.connect.mockResolvedValue({
      target,
      arch: "darwin-arm64",
      version: "1.0.0",
      projects: [],
    });
    installAdeMock();

    render(<RemoteTargetList />);

    await waitFor(() =>
      expect(screen.getAllByText("Mac Studio").length).toBeGreaterThan(0),
    );
    const connectButton = screen
      .getAllByRole("button", { name: "Connect" })
      .find((button) => !button.hasAttribute("disabled"));
    fireEvent.click(connectButton!);

    await waitFor(() =>
      expect(screen.getByText("Trust this machine")).toBeTruthy(),
    );
    expect(screen.getByText("SHA256:abc123")).toBeTruthy();
    expect(remoteRuntimeMock.connect).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Trust & connect" }));

    await waitFor(() =>
      expect(remoteRuntimeMock.trustSshHostKey).toHaveBeenCalledWith(
        "target-1",
        "SHA256:abc123",
      ),
    );
    await waitFor(() =>
      expect(remoteRuntimeMock.connect).toHaveBeenCalledWith("target-1"),
    );
    expect(screen.getByText("Connected")).toBeTruthy();
  });

  it("hides discovered machines that are already saved as SSH targets", async () => {
    const target = {
      id: "target-1",
      name: "Mac Studio",
      hostname: "aruls-mac-studio.tail7497a6.ts.net",
      sshUser: null,
      port: null,
      sshKeyPath: null,
      routes: [
        {
          hostname: "aruls-mac-studio.tail7497a6.ts.net",
          port: null,
          source: "tailscale",
          lastSucceededAt: null,
        },
      ],
      lastSeenArch: "darwin-arm64",
      runtimeBinaryVersion: "1.0.0",
      lastConnectedAt: null,
    };
    remoteRuntimeMock.listTargets.mockResolvedValue([target]);
    remoteRuntimeMock.listDiscoveredMachines.mockResolvedValue({
      machines: [
        {
          id: "tailscale::mac-studio",
          serviceName: "tailscale-ssh",
          machineName: "Arul's Mac Studio",
          hostIdentity: "mac-studio",
          hostName: "aruls-mac-studio.tail7497a6.ts.net",
          port: 22,
          addresses: [],
          primaryRoute: "aruls-mac-studio.tail7497a6.ts.net",
          tailscaleAddress: "aruls-mac-studio.tail7497a6.ts.net",
          runtimeKind: "tailscale-peer",
          runtimeVersion: null,
          projectIds: [],
          projectCount: 0,
          lastSeenAt: 1234,
        },
      ],
      diagnostics: [],
    });
    installAdeMock();

    render(<RemoteTargetList />);

    await waitFor(() =>
      expect(screen.getAllByText("Mac Studio").length).toBeGreaterThan(0),
    );
    expect(screen.queryByText("Arul's Mac Studio")).toBeNull();
    expect(screen.queryByRole("button", { name: "Use host" })).toBeNull();
    expect(screen.getByText("Nearby machines are already saved above.")).toBeTruthy();
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
