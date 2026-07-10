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
  getLocalPairingInfo: vi.fn(),
  parsePairingInput: vi.fn(),
  pairWithMachine: vi.fn(),
  runDoctor: vi.fn(),
};

const lanesMock = {
  list: vi.fn(),
  listSnapshots: vi.fn(),
};

const appMock = {
  writeClipboardText: vi.fn(),
};

function installAdeMock(): void {
  remoteRuntimeMock.getSshHostKeyTrust.mockResolvedValue({ state: "trusted" });
  remoteRuntimeMock.getLocalPairingInfo.mockResolvedValue({
    url: "https://ade-app.dev/pair#payload",
    pin: "123456",
    machineName: "This Mac",
    relayAvailable: false,
  });
  remoteRuntimeMock.runDoctor.mockResolvedValue({ checks: [] });
  Object.defineProperty(window, "ade", {
    configurable: true,
    value: {
      remoteRuntime: remoteRuntimeMock,
      lanes: lanesMock,
      app: appMock,
    },
  });
}

describe("RemoteTargetList", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    Reflect.deleteProperty(remoteRuntimeMock, "getConnectionSnapshot");
    Reflect.deleteProperty(window, "ade");
  });

  it("does not report copied pairing data when the clipboard bridge is unavailable", async () => {
    remoteRuntimeMock.listTargets.mockResolvedValue([]);
    remoteRuntimeMock.listDiscoveredMachines.mockResolvedValue({
      machines: [],
      diagnostics: [],
    });
    installAdeMock();
    Object.defineProperty(window.ade, "app", {
      configurable: true,
      value: {},
    });

    render(<RemoteTargetList />);

    fireEvent.click(await screen.findByRole("button", { name: "Share" }));
    const copyButton = await screen.findByRole("button", { name: "Copy code" });
    fireEvent.click(copyButton);

    expect(screen.getByRole("button", { name: "Copy code" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
  });

  it("lists a discovered ADE machine under Available and connects via its route", async () => {
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
          connectable: true,
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
    expect(screen.getByText("AVAILABLE")).toBeTruthy();
    expect(screen.getByText("studio.tailnet.ts.net:8787")).toBeTruthy();
    // ADE machines advertise their project count concisely.
    expect(screen.getByText("ADE · 2 projects")).toBeTruthy();

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
    await waitFor(() =>
      expect(remoteRuntimeMock.connect).toHaveBeenCalledWith("target-1"),
    );
  });

  it("shows an SSH-only Tailscale peer with its OS in the Available section", async () => {
    remoteRuntimeMock.listTargets.mockResolvedValue([]);
    remoteRuntimeMock.listDiscoveredMachines.mockResolvedValue({
      machines: [
        {
          id: "tailscale:peer-linux",
          serviceName: "Tailscale peer",
          machineName: "Linux box",
          hostIdentity: "peer-linux",
          hostName: "linux-box",
          port: 22,
          addresses: ["100.64.0.20"],
          primaryRoute: "100.64.0.20",
          tailscaleAddress: "100.64.0.20",
          runtimeKind: "tailscale-peer",
          runtimeVersion: null,
          os: "linux",
          connectable: true,
          projectIds: [],
          projectCount: null,
          lastSeenAt: 1234,
        },
      ],
      diagnostics: [],
    });
    installAdeMock();

    render(<RemoteTargetList />);

    await waitFor(() => expect(screen.getByText("Linux box")).toBeTruthy());
    expect(screen.getByText("SSH only · linux")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Test" })).toBeTruthy();
  });

  it("shows why an unsupported discovered machine cannot connect", async () => {
    remoteRuntimeMock.listTargets.mockResolvedValue([]);
    remoteRuntimeMock.listDiscoveredMachines.mockResolvedValue({
      machines: [
        {
          id: "tailscale:windows-pc",
          serviceName: "Tailscale peer",
          machineName: "Windows PC",
          hostIdentity: "windows-pc",
          hostName: "windows-pc",
          port: 22,
          addresses: ["100.64.0.12"],
          primaryRoute: "100.64.0.12",
          tailscaleAddress: "100.64.0.12",
          runtimeKind: "tailscale-peer",
          runtimeVersion: null,
          os: "windows",
          connectable: false,
          unsupportedReason:
            "Windows machines can't run the ADE remote runtime yet.",
          projectIds: [],
          projectCount: null,
          lastSeenAt: 1234,
        },
      ],
      diagnostics: [],
    });
    installAdeMock();

    render(<RemoteTargetList />);

    await waitFor(() => expect(screen.getByText("Windows PC")).toBeTruthy());
    expect(
      screen.getByText(/Windows machines can't run the ADE remote runtime yet/),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
  });

  it("prefers the structured connection error message without rewriting it", async () => {
    const target = {
      id: "target-1",
      name: "Mac Studio",
      hostname: "studio.local",
      sshUser: null,
      port: 22,
      sshKeyPath: null,
      lastSeenArch: null,
      runtimeBinaryVersion: null,
      lastConnectedAt: null,
    };
    Object.defineProperty(remoteRuntimeMock, "getConnectionSnapshot", {
      configurable: true,
      value: vi.fn().mockResolvedValue({
        connections: [
          {
            target,
            state: "error",
            arch: null,
            version: null,
            projects: [],
            lastError: "All configured authentication methods failed",
            lastErrorInfo: {
              kind: "ssh_auth",
              message:
                'SSH authentication failed for user(s) "ade" using key /Users/ade/.ssh/id_ed25519.',
            },
            lastAttemptedAt: 1234,
            connectedAt: null,
          },
        ],
        connectedCount: 0,
        updatedAt: 1234,
      }),
    });
    remoteRuntimeMock.listDiscoveredMachines.mockResolvedValue({
      machines: [],
      diagnostics: [],
    });
    installAdeMock();

    render(<RemoteTargetList />);

    expect(
      await screen.findByText(
        'SSH authentication failed for user(s) "ade" using key /Users/ade/.ssh/id_ed25519.',
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText(
        "SSH authentication failed. Check the SSH user, key path, and that this key is allowed on the remote machine.",
      ),
    ).toBeNull();
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
    expect(screen.getByText(/ADE 1\.0\.0 on darwin-arm64/)).toBeTruthy();
    expect(screen.getByText(/RPC capabilities are compatible/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
    expect(screen.queryByText("/remote/ADE")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    await waitFor(() =>
      expect(remoteRuntimeMock.disconnect).toHaveBeenCalledWith("target-1", {
        manual: true,
      }),
    );
    expect(screen.getByText("Not connected")).toBeTruthy();
  });

  it("does not disconnect when the disconnect confirmation callback rejects it", async () => {
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
    remoteRuntimeMock.listTargets.mockResolvedValue([target]);
    remoteRuntimeMock.listDiscoveredMachines.mockResolvedValue({
      machines: [],
      diagnostics: [],
    });
    remoteRuntimeMock.connect.mockResolvedValue({
      target,
      arch: "darwin-arm64",
      version: "1.0.0",
      projects: [],
    });
    const onDisconnectRequested = vi.fn(async () => false);
    installAdeMock();

    render(<RemoteTargetList onDisconnectRequested={onDisconnectRequested} />);

    await waitFor(() =>
      expect(screen.getAllByText("Mac Studio").length).toBeGreaterThan(0),
    );
    const connectButton = screen
      .getAllByRole("button", { name: "Connect" })
      .find((button) => !button.hasAttribute("disabled"));
    fireEvent.click(connectButton!);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));

    await waitFor(() =>
      expect(onDisconnectRequested).toHaveBeenCalledWith(target),
    );
    expect(remoteRuntimeMock.disconnect).not.toHaveBeenCalled();
    expect(screen.getByText("Connected")).toBeTruthy();
  });

  it("toggles the saved machine edit details from the Edit button", async () => {
    const target = {
      id: "target-1",
      name: "Mac Studio",
      hostname: "100.75.20.63",
      sshUser: "admin",
      port: 22,
      sshKeyPath: "/Users/arul/.ssh/id_ed25519",
      lastSeenArch: "darwin-arm64",
      runtimeBinaryVersion: "1.0.0",
      lastConnectedAt: null,
    };
    remoteRuntimeMock.listTargets.mockResolvedValue([target]);
    remoteRuntimeMock.listDiscoveredMachines.mockResolvedValue({
      machines: [],
      diagnostics: [],
    });
    installAdeMock();

    render(<RemoteTargetList />);

    await waitFor(() =>
      expect(screen.getAllByText("Mac Studio").length).toBeGreaterThan(0),
    );
    const editButton = screen.getByRole("button", { name: "Edit" });
    expect(editButton.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Edit Mac Studio")).toBeNull();

    fireEvent.click(editButton);

    expect(editButton.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Edit Mac Studio")).toBeTruthy();
    expect((screen.getByLabelText("Host") as HTMLInputElement).value).toBe(
      "100.75.20.63",
    );

    fireEvent.click(editButton);

    expect(editButton.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Edit Mac Studio")).toBeNull();
  });

  it("keeps a paired target and creates one manual SSH route when its host changes", async () => {
    const target = {
      id: "target-paired",
      name: "Paired Studio",
      hostname: "studio.local",
      transport: "paired" as const,
      pairedMachine: {
        hostIdentity: "host-device-1",
        machineKey: "machine-key-1",
      },
      sshUser: "admin",
      port: 22,
      sshKeyPath: "/Users/admin/.ssh/id_ed25519",
      routes: [
        {
          hostname: "studio.local",
          port: null,
          source: "bonjour" as const,
          lastSucceededAt: null,
        },
      ],
      lastSeenArch: "darwin-arm64",
      runtimeBinaryVersion: "1.0.0",
      lastConnectedAt: null,
    };
    const updatedTarget = {
      ...target,
      name: "Renamed Studio",
      hostname: "100.75.20.64",
    };
    remoteRuntimeMock.listTargets.mockResolvedValue([target]);
    remoteRuntimeMock.listDiscoveredMachines.mockResolvedValue({
      machines: [],
      diagnostics: [],
    });
    remoteRuntimeMock.saveTarget.mockResolvedValue(updatedTarget);
    remoteRuntimeMock.connect.mockResolvedValue({
      target: updatedTarget,
      arch: "darwin-arm64",
      version: "1.0.0",
      projects: [],
    });
    installAdeMock();

    render(<RemoteTargetList />);

    await screen.findByText("Paired Studio");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Renamed Studio" },
    });
    fireEvent.change(screen.getByLabelText("Host"), {
      target: { value: "100.75.20.64" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save and connect" }));

    await waitFor(() =>
      expect(remoteRuntimeMock.saveTarget).toHaveBeenCalled(),
    );
    const savedInput = remoteRuntimeMock.saveTarget.mock.calls[0]?.[0];
    expect(savedInput.transport).toBe("paired");
    expect(savedInput.pairedMachine).toEqual(target.pairedMachine);
    expect(savedInput.hostname).toBe("100.75.20.64");
    expect(savedInput.routes).toEqual([
      {
        hostname: "100.75.20.64",
        port: 22,
        source: "manual",
        lastSucceededAt: null,
      },
    ]);
    expect(remoteRuntimeMock.removeTarget).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(remoteRuntimeMock.connect).toHaveBeenCalledWith("target-paired"),
    );
  });

  it("shows an actionable message when the SSH host-key probe is reset", async () => {
    const target = {
      id: "target-1",
      name: "Mac Studio",
      hostname: "100.75.20.63",
      sshUser: "admin",
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
    installAdeMock();
    remoteRuntimeMock.getSshHostKeyTrust.mockRejectedValue(
      new Error(
        "Error invoking remote method 'ade.remoteRuntime.getSshHostKeyTrust': Error: read ECONNRESET",
      ),
    );

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
      expect(
        screen.getByText(
          /SSH server closed the connection before ADE could finish the SSH handshake/,
        ),
      ).toBeTruthy(),
    );
    expect(screen.queryByText(/Error invoking remote method/)).toBeNull();
    expect(screen.queryByText(/read ECONNRESET/)).toBeNull();
    expect(remoteRuntimeMock.connect).not.toHaveBeenCalled();
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

  it("surfaces SSH trust when a paired connection falls back after connect starts", async () => {
    const target = {
      id: "target-paired",
      name: "Paired Studio",
      hostname: "studio.local",
      transport: "paired" as const,
      pairedMachine: { hostIdentity: "host-device-1", machineKey: null },
      sshUser: "ade",
      port: 22,
      sshKeyPath: null,
      lastSeenArch: null,
      runtimeBinaryVersion: null,
      lastConnectedAt: null,
    };
    const trustRequired = {
      state: "needs_trust" as const,
      targetId: target.id,
      host: target.hostname,
      port: 22,
      route: {
        hostname: target.hostname,
        port: 22,
        source: "manual" as const,
        lastSucceededAt: null,
      },
      keyType: "ssh-ed25519",
      fingerprintSha256: "SHA256:fallback",
      knownHostsPath: "/Users/test/.ssh/known_hosts",
    };
    remoteRuntimeMock.listTargets.mockResolvedValue([target]);
    remoteRuntimeMock.listDiscoveredMachines.mockResolvedValue({
      machines: [],
      diagnostics: [],
    });
    remoteRuntimeMock.connect.mockRejectedValue(
      new Error("SSH host key verification failed during paired fallback."),
    );
    installAdeMock();
    remoteRuntimeMock.getSshHostKeyTrust
      .mockResolvedValueOnce({ state: "trusted" })
      .mockResolvedValueOnce(trustRequired);

    render(<RemoteTargetList />);

    await screen.findByText("Paired Studio");
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await screen.findByText("Trust this machine");
    expect(screen.getByText("SHA256:fallback")).toBeTruthy();
    expect(remoteRuntimeMock.connect).toHaveBeenCalledTimes(1);
    expect(remoteRuntimeMock.getSshHostKeyTrust).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/SSH host-key verification failed/)).toBeNull();
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
    expect(screen.getByText("Nearby machines are already saved.")).toBeTruthy();
  });

  it("matches saved Bonjour machines by SSH default port instead of the ADE service port", async () => {
    const target = {
      id: "target-1",
      name: "Studio",
      hostname: "studio.local",
      sshUser: null,
      port: null,
      sshKeyPath: null,
      routes: [
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
    remoteRuntimeMock.listTargets.mockResolvedValue([target]);
    remoteRuntimeMock.listDiscoveredMachines.mockResolvedValue({
      machines: [
        {
          id: "bonjour::studio",
          serviceName: "ADE Studio",
          machineName: "Studio",
          hostIdentity: "studio",
          hostName: "studio.local",
          port: 8787,
          addresses: [],
          primaryRoute: "studio.local",
          tailscaleAddress: null,
          runtimeKind: "daemon",
          runtimeVersion: "1.0.0",
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
      expect(screen.getAllByText("Studio").length).toBeGreaterThan(0),
    );
    expect(screen.queryByText("studio.local:8787")).toBeNull();
    expect(screen.queryByRole("button", { name: "Use host" })).toBeNull();
    expect(screen.getByText("Nearby machines are already saved.")).toBeTruthy();
  });

  it("splits saved and discovered machines into status sections with a route chip", async () => {
    const connectedTarget = {
      id: "target-c",
      name: "Connected Mac",
      hostname: "100.64.0.5",
      sshUser: "ade",
      port: 22,
      sshKeyPath: null,
      lastSeenArch: "darwin-arm64",
      runtimeBinaryVersion: "1.0.0",
      lastConnectedAt: 1,
    };
    Object.defineProperty(remoteRuntimeMock, "getConnectionSnapshot", {
      configurable: true,
      value: vi.fn().mockResolvedValue({
        connections: [
          {
            target: connectedTarget,
            state: "connected",
            arch: "darwin-arm64",
            version: "1.0.0",
            route: { kind: "tailnet", endpoint: "100.64.0.5", latencyMs: 4 },
            projects: [],
            lastError: null,
            lastAttemptedAt: 1,
            connectedAt: 1,
          },
        ],
        connectedCount: 1,
        updatedAt: 1,
      }),
    });
    remoteRuntimeMock.listDiscoveredMachines.mockResolvedValue({
      machines: [
        {
          id: "tailscale:windows-pc",
          serviceName: "Tailscale peer",
          machineName: "Windows PC",
          hostIdentity: "windows-pc",
          hostName: "windows-pc",
          port: 22,
          addresses: ["100.64.0.12"],
          primaryRoute: "100.64.0.12",
          tailscaleAddress: "100.64.0.12",
          runtimeKind: "tailscale-peer",
          runtimeVersion: null,
          os: "windows",
          connectable: false,
          unsupportedReason: "Windows — not supported yet",
          projectIds: [],
          projectCount: null,
          lastSeenAt: 1234,
        },
      ],
      diagnostics: [],
    });
    installAdeMock();

    render(<RemoteTargetList />);

    await waitFor(() =>
      expect(screen.getAllByText("Connected Mac").length).toBeGreaterThan(0),
    );
    expect(screen.getByText("CONNECTED")).toBeTruthy();
    expect(screen.getByText("UNAVAILABLE")).toBeTruthy();
    // Live route chip on the connected row, sourced from status.route.
    expect(screen.getByText("tailnet · 4 ms")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
    // The unsupported peer greys out with a concrete reason and no Connect.
    expect(screen.getByText("Windows — not supported yet")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
  });

  it("reveals capped technical detail behind the error card expander", async () => {
    const target = {
      id: "target-1",
      name: "Mac Studio",
      hostname: "studio.local",
      sshUser: null,
      port: 22,
      sshKeyPath: null,
      lastSeenArch: null,
      runtimeBinaryVersion: null,
      lastConnectedAt: null,
    };
    Object.defineProperty(remoteRuntimeMock, "getConnectionSnapshot", {
      configurable: true,
      value: vi.fn().mockResolvedValue({
        connections: [
          {
            target,
            state: "error",
            arch: null,
            version: null,
            projects: [],
            lastError: "ENOSPC",
            lastErrorInfo: {
              kind: "disk_full",
              message: "The remote machine is out of disk space.",
              detail: "df: /: 100% used (0 bytes free)\nextract aborted",
            },
            lastAttemptedAt: 1,
            connectedAt: null,
          },
        ],
        connectedCount: 0,
        updatedAt: 1,
      }),
    });
    remoteRuntimeMock.listDiscoveredMachines.mockResolvedValue({
      machines: [],
      diagnostics: [],
    });
    installAdeMock();

    render(<RemoteTargetList />);

    expect(
      await screen.findByText("The remote machine is out of disk space."),
    ).toBeTruthy();
    // Technical detail is hidden until the expander is opened.
    expect(screen.queryByText(/100% used/)).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: /Show technical details/ }),
    );

    expect(screen.getByText(/df: \/: 100% used \(0 bytes free\)/)).toBeTruthy();
  });

  it("validates a pairing link and pairs on the Pair tab", async () => {
    remoteRuntimeMock.listTargets.mockResolvedValue([]);
    remoteRuntimeMock.listDiscoveredMachines.mockResolvedValue({
      machines: [],
      diagnostics: [],
    });
    remoteRuntimeMock.parsePairingInput
      .mockRejectedValueOnce(
        new Error("That doesn't look like a pairing code."),
      )
      .mockResolvedValue({
        hostIdentity: {
          deviceId: "d1",
          siteId: "s1",
          name: "Studio",
          platform: "macOS",
          deviceType: "desktop",
        },
        machineName: "Studio",
        endpoints: ["wss://studio.example"],
        requiresPin: true,
      });
    const savedTarget = {
      id: "target-9",
      name: "Studio",
      hostname: "studio.example",
      transport: "paired",
      sshUser: null,
      port: null,
      sshKeyPath: null,
      lastSeenArch: null,
      runtimeBinaryVersion: null,
      lastConnectedAt: null,
    };
    remoteRuntimeMock.pairWithMachine.mockResolvedValue({
      targetId: "target-9",
    });
    remoteRuntimeMock.connect.mockResolvedValue({
      target: savedTarget,
      arch: "darwin-arm64",
      version: "1.0.0",
      projects: [],
    });
    installAdeMock();

    render(<RemoteTargetList />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Add machine" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add machine" }));

    const input = screen.getByLabelText("Pairing code or link");
    fireEvent.change(input, { target: { value: "nope" } });
    await waitFor(() =>
      expect(
        screen.getByText("That doesn't look like a pairing code."),
      ).toBeTruthy(),
    );

    fireEvent.change(input, {
      target: { value: "https://ade-app.dev/pair#ok" },
    });
    await waitFor(() =>
      expect(screen.getByText(/Studio ready to pair/)).toBeTruthy(),
    );

    // Device name is prefilled from this Mac's pairing info.
    expect(
      (screen.getByLabelText("This device's name") as HTMLInputElement).value,
    ).toBe("This Mac");

    fireEvent.change(screen.getByLabelText("PIN"), {
      target: { value: "654321" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() =>
      expect(remoteRuntimeMock.pairWithMachine).toHaveBeenCalledWith({
        input: "https://ade-app.dev/pair#ok",
        pin: "654321",
        deviceName: "This Mac",
      }),
    );
    await waitFor(() =>
      expect(remoteRuntimeMock.connect).toHaveBeenCalledWith("target-9"),
    );
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
        screen.getByText(
          "Tailscale CLI was not found; only LAN discovery ran.",
        ),
      ).toBeTruthy(),
    );
    expect(screen.getByText("No saved or detected machines yet.")).toBeTruthy();
  });
});
