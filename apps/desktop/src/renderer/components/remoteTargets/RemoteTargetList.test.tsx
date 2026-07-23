// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdeAccountMachine } from "../../../shared/types";
import { DEFAULT_ADE_TUNNEL_RELAY_URL } from "../../../shared/accountDirectory";
import { AccountMachineRow } from "./AccountMachineRow";
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
  setAutoConnect: vi.fn(),
  onConnectionSnapshotChanged: vi.fn(),
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

const accountMock = {
  pairMachine: vi.fn(),
  getLocalMachineIdentity: vi.fn(),
  onPairMachineProgress: vi.fn(),
};

function installAdeMock(): void {
  remoteRuntimeMock.onConnectionSnapshotChanged.mockReturnValue(() => {});
  remoteRuntimeMock.getSshHostKeyTrust.mockResolvedValue({ state: "trusted" });
  remoteRuntimeMock.getLocalPairingInfo.mockResolvedValue({
    url: "https://ade-app.dev/pair#payload",
    pin: "123456",
    machineName: "This Mac",
    relayAvailable: false,
  });
  remoteRuntimeMock.runDoctor.mockResolvedValue({ checks: [] });
  accountMock.getLocalMachineIdentity.mockResolvedValue({ machineKey: "local-mk", deviceId: "local-dev" });
  accountMock.onPairMachineProgress.mockReturnValue(() => {});
  Object.defineProperty(window, "ade", {
    configurable: true,
    value: {
      remoteRuntime: remoteRuntimeMock,
      lanes: lanesMock,
      app: appMock,
      account: accountMock,
    },
  });
}

function accountMachine(
  overrides: Partial<AdeAccountMachine> & Pick<AdeAccountMachine, "machineKey" | "name">,
): AdeAccountMachine {
  return {
    deviceId: `${overrides.machineKey}-device`,
    platform: "darwin",
    deviceType: "desktop",
    reachableEndpoints: [
      {
        kind: "relay",
        url: `${DEFAULT_ADE_TUNNEL_RELAY_URL.replace("https:", "wss:")}/connect/${overrides.machineKey}`,
      },
    ],
    lastSeenAt: Date.now(),
    online: true,
    ...overrides,
  };
}

function getAccountRow(name: string): HTMLElement {
  const row = screen.getByText(name).closest("[data-account-machine-key]");
  if (!(row instanceof HTMLElement)) {
    throw new Error(`Account row not found for ${name}`);
  }
  return row;
}

function openAddMode(label: "Find nearby Macs" | "Add over SSH"): void {
  fireEvent.click(screen.getByRole("button", { name: "Add machine" }));
  fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${label}`) }));
}

describe("RemoteTargetList", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    Reflect.deleteProperty(remoteRuntimeMock, "getConnectionSnapshot");
    Reflect.deleteProperty(window, "ade");
  });

  it("pairs a discovered ADE machine with its 6-digit code instead of creating an SSH target", async () => {
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
    remoteRuntimeMock.parsePairingInput.mockResolvedValue({
      hostIdentity: {
        deviceId: "device-1",
        siteId: "",
        name: "Studio",
        platform: "unknown",
        deviceType: "desktop",
      },
      machineName: "Studio",
      endpoints: [
        "wss://192.168.1.42:8787",
        "wss://studio.local:8787",
        "wss://studio.tailnet.ts.net:8787",
      ],
      requiresPin: true,
    });
    const pairedTarget = {
      id: "target-1",
      name: "Studio",
      hostname: "192.168.1.42",
      transport: "paired",
      sshUser: null,
      port: null,
      sshKeyPath: null,
      routes: [],
      lastSeenArch: null,
      runtimeBinaryVersion: null,
      lastConnectedAt: null,
    };
    remoteRuntimeMock.pairWithMachine.mockResolvedValue({ targetId: "target-1" });
    remoteRuntimeMock.connect.mockResolvedValue({
      target: pairedTarget,
      arch: "darwin-arm64",
      version: "1.0.0",
      projects: [],
    });
    installAdeMock();

    render(<RemoteTargetList />);

    openAddMode("Find nearby Macs");

    await waitFor(() => expect(screen.getByText("Studio")).toBeTruthy());
    expect(screen.getByText("Found nearby")).toBeTruthy();
    expect(screen.getByText("Ready to connect")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pair" }));
    await screen.findByText(/Studio ready to pair/);

    fireEvent.change(screen.getByLabelText("6-digit code"), {
      target: { value: "654321" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(remoteRuntimeMock.pairWithMachine).toHaveBeenCalledWith({
      input: expect.stringMatching(/^https:\/\/ade-app\.dev\/pair#/),
      pin: "654321",
      deviceName: "This Mac",
    }));
    await waitFor(() => expect(remoteRuntimeMock.connect).toHaveBeenCalledWith("target-1"));
    expect(remoteRuntimeMock.saveTarget).not.toHaveBeenCalled();
  });

  it("does not treat a raw Tailscale peer as an implicit SSH pairing", async () => {
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

    openAddMode("Find nearby Macs");

    await screen.findByText(/No Macs found/);
    expect(screen.queryByText("Linux box")).toBeNull();
    expect(screen.queryByText(/SSH/i)).toBeNull();
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

  it("does not let an older event overwrite a local connection-setting snapshot", async () => {
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
      autoConnect: false,
    };
    Object.defineProperty(remoteRuntimeMock, "getConnectionSnapshot", {
      configurable: true,
      value: vi.fn().mockResolvedValue({
        connections: [{
          target,
          state: "idle",
          arch: target.lastSeenArch,
          version: target.runtimeBinaryVersion,
          projects: [],
          lastError: null,
          lastAttemptedAt: null,
          connectedAt: null,
        }],
        connectedCount: 0,
        updatedAt: 10,
      }),
    });
    remoteRuntimeMock.listDiscoveredMachines.mockResolvedValue({
      machines: [],
      diagnostics: [],
    });
    installAdeMock();
    let emitSnapshot: ((snapshot: {
      connections: Array<{
        target: typeof target;
        state: "idle";
        arch: string;
        version: string;
        projects: never[];
        lastError: null;
        lastAttemptedAt: null;
        connectedAt: null;
      }>;
      connectedCount: number;
      updatedAt: number;
    }) => void) | undefined;
    remoteRuntimeMock.onConnectionSnapshotChanged.mockImplementation((listener) => {
      emitSnapshot = listener;
      return () => {};
    });
    const updatedTarget = { ...target, autoConnect: true };
    remoteRuntimeMock.setAutoConnect.mockResolvedValue(updatedTarget);
    vi.spyOn(Date, "now").mockReturnValue(20);

    render(<RemoteTargetList />);

    await screen.findByText("Mac Studio");
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const checkbox = screen.getByRole("checkbox", {
      name: /Reconnect automatically/,
    }) as HTMLInputElement;
    fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox.checked).toBe(true));

    act(() => {
      emitSnapshot?.({
        connections: [{
          target,
          state: "idle",
          arch: target.lastSeenArch,
          version: target.runtimeBinaryVersion,
          projects: [],
          lastError: null,
          lastAttemptedAt: null,
          connectedAt: null,
        }],
        connectedCount: 0,
        updatedAt: 15,
      });
    });

    expect(checkbox.checked).toBe(true);
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
    expect(screen.queryByText("Nearby machines are already saved.")).toBeNull();
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
    expect(screen.queryByText("Nearby machines are already saved.")).toBeNull();
  });

  it("keeps the saved connected state without surfacing raw tailnet peers as setup choices", async () => {
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
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();

    openAddMode("Find nearby Macs");
    expect(screen.getByText(/No Macs found/)).toBeTruthy();
    expect(screen.queryByText("Windows PC")).toBeNull();
    expect(screen.queryByText("Windows — not supported yet")).toBeNull();
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
    expect(screen.getByText("No Macs yet. Choose Add machine to connect one.")).toBeTruthy();
  });

  it("adopts a desktop account machine as paired-only instead of saving a broken SSH target", async () => {
    remoteRuntimeMock.listDiscoveredMachines.mockResolvedValue({
      machines: [],
      diagnostics: [],
    });
    const savedTarget = {
      id: "target-account",
      name: "Cloud Studio",
      hostname: "100.92.14.3",
      transport: "paired" as const,
      pairedMachine: { hostIdentity: "dev_cloud", machineKey: "mk_cloud" },
      sshUser: null,
      port: null,
      sshKeyPath: null,
      routes: null,
      lastSeenArch: null,
      runtimeBinaryVersion: null,
      lastConnectedAt: null,
    };
    remoteRuntimeMock.listTargets
      .mockResolvedValueOnce([])
      .mockResolvedValue([savedTarget]);
    accountMock.pairMachine.mockResolvedValue({
      targetId: savedTarget.id,
      machineKey: "mk_cloud",
      deviceId: "dev_cloud",
      name: "Cloud Studio",
    });
    remoteRuntimeMock.connect.mockResolvedValue({
      target: savedTarget,
      arch: "darwin-arm64",
      version: "1.0.0",
      projects: [],
    });
    installAdeMock();

    const accountMachines: AdeAccountMachine[] = [
      {
        machineKey: "mk_cloud",
        deviceId: "dev_cloud",
        name: "Cloud Studio",
        platform: "darwin",
        deviceType: "desktop",
        reachableEndpoints: [
          { kind: "tailnet", url: "http://100.92.14.3:8787" },
          {
            kind: "relay",
            url: `${DEFAULT_ADE_TUNNEL_RELAY_URL.replace("https:", "wss:")}/connect/mk_cloud`,
          },
        ],
        lastSeenAt: Date.now() - 30_000,
        online: true,
      },
    ];

    render(
      <RemoteTargetList
        accountMachines={accountMachines}
        accountMachinesState="ok"
        accountSignedIn
      />,
    );

    await waitFor(() =>
      expect(screen.getByText("Cloud Studio")).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() =>
      expect(accountMock.pairMachine).toHaveBeenCalledWith("mk_cloud"),
    );
    expect(remoteRuntimeMock.saveTarget).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(remoteRuntimeMock.connect).toHaveBeenCalledWith("target-account"),
    );
  });

  it("shows an account connect failure only on the machine that failed", async () => {
    remoteRuntimeMock.listTargets.mockResolvedValue([]);
    remoteRuntimeMock.listDiscoveredMachines.mockResolvedValue({
      machines: [],
      diagnostics: [],
    });
    accountMock.pairMachine.mockRejectedValue(
      new Error("Account relay adoption failed."),
    );
    installAdeMock();

    render(
      <RemoteTargetList
        accountMachines={[
          accountMachine({ machineKey: "mk-failing", name: "Failing Studio" }),
          accountMachine({ machineKey: "mk-other", name: "Other Studio" }),
        ]}
        accountMachinesState="ok"
        accountSignedIn
      />,
    );

    await screen.findByText("Failing Studio");
    const failingRow = getAccountRow("Failing Studio");
    const otherRow = getAccountRow("Other Studio");
    fireEvent.click(
      within(failingRow).getByRole("button", { name: "Connect" }),
    );

    await waitFor(() =>
      expect(
        within(failingRow).getByText("Account relay adoption failed."),
      ).toBeTruthy(),
    );
    expect(
      within(otherRow).queryByText("Account relay adoption failed."),
    ).toBeNull();
  });

  it("offers nearby pairing only for a failed account row with a matching discovered machine", async () => {
    remoteRuntimeMock.listTargets.mockResolvedValue([]);
    remoteRuntimeMock.listDiscoveredMachines.mockResolvedValue({
      machines: [
        {
          id: "nearby-studio",
          serviceName: "ADE Sync Nearby Studio",
          machineName: "Nearby Studio",
          hostIdentity: "nearby-device",
          hostName: "nearby-studio.local",
          port: 8787,
          addresses: ["192.168.1.55"],
          primaryRoute: "192.168.1.55",
          tailscaleAddress: null,
          runtimeKind: "daemon",
          runtimeVersion: "1.0.0",
          connectable: true,
          projectIds: [],
          projectCount: 0,
          lastSeenAt: Date.now(),
        },
      ],
      diagnostics: [],
    });
    remoteRuntimeMock.parsePairingInput.mockResolvedValue({
      hostIdentity: {
        deviceId: "nearby-device",
        siteId: "",
        name: "Nearby Studio",
        platform: "macOS",
        deviceType: "desktop",
      },
      machineName: "Nearby Studio",
      endpoints: ["wss://192.168.1.55:8787"],
      requiresPin: true,
    });
    accountMock.pairMachine.mockRejectedValue(
      new Error("ADE relay was unavailable."),
    );
    installAdeMock();

    render(
      <RemoteTargetList
        accountMachines={[
          accountMachine({
            machineKey: "mk-nearby",
            deviceId: "nearby-device",
            name: "Nearby Studio",
          }),
          accountMachine({
            machineKey: "mk-unmatched",
            deviceId: "unmatched-device",
            name: "No Nearby Match",
          }),
        ]}
        accountMachinesState="ok"
        accountSignedIn
      />,
    );

    await screen.findByText("Nearby Studio");
    const matchingRow = getAccountRow("Nearby Studio");
    const unmatchedRow = getAccountRow("No Nearby Match");

    fireEvent.click(
      within(matchingRow).getByRole("button", { name: "Connect" }),
    );
    await waitFor(() =>
      expect(
        within(matchingRow).getByRole("button", {
          name: "It's on your network — Pair nearby instead ›",
        }),
      ).toBeTruthy(),
    );

    fireEvent.click(
      within(unmatchedRow).getByRole("button", { name: "Connect" }),
    );
    await waitFor(() =>
      expect(
        within(unmatchedRow).getByText("ADE relay was unavailable."),
      ).toBeTruthy(),
    );
    expect(
      within(unmatchedRow).queryByRole("button", {
        name: "It's on your network — Pair nearby instead ›",
      }),
    ).toBeNull();

    fireEvent.click(
      within(matchingRow).getByRole("button", {
        name: "It's on your network — Pair nearby instead ›",
      }),
    );

    const pinInput = await screen.findByLabelText("6-digit code");
    await waitFor(() =>
      expect(remoteRuntimeMock.parsePairingInput).toHaveBeenCalledWith(
        expect.stringMatching(/^https:\/\/ade-app\.dev\/pair#/),
      ),
    );
    expect(document.activeElement).toBe(pinInput);
  });

  it("shows account pairing progress on the matching row while it is connecting", async () => {
    remoteRuntimeMock.listTargets.mockResolvedValue([]);
    remoteRuntimeMock.listDiscoveredMachines.mockResolvedValue({
      machines: [],
      diagnostics: [],
    });
    accountMock.pairMachine.mockReturnValue(new Promise(() => {}));
    installAdeMock();

    render(
      <RemoteTargetList
        accountMachines={[
          accountMachine({ machineKey: "mk-progress", name: "Progress Studio" }),
        ]}
        accountMachinesState="ok"
        accountSignedIn
      />,
    );

    await screen.findByText("Progress Studio");
    const row = getAccountRow("Progress Studio");
    fireEvent.click(within(row).getByRole("button", { name: "Connect" }));
    await waitFor(() =>
      expect(accountMock.pairMachine).toHaveBeenCalledWith("mk-progress"),
    );

    const progressListener = accountMock.onPairMachineProgress.mock.calls[0]?.[0] as
      | ((progress: {
          machineKey: string;
          stage: "relay";
          label: string;
        }) => void)
      | undefined;
    expect(progressListener).toBeTypeOf("function");
    act(() => {
      progressListener?.({
        machineKey: "mk-progress",
        stage: "relay",
        label: "Connecting through ADE relay…",
      });
    });

    expect(
      within(row).getByText("Connecting through ADE relay…"),
    ).toBeTruthy();
  });

  it("shows the winning account route briefly after connecting", async () => {
    remoteRuntimeMock.listDiscoveredMachines.mockResolvedValue({
      machines: [],
      diagnostics: [],
    });
    const savedTarget = {
      id: "target-toast",
      name: "Toast Studio",
      hostname: "100.92.14.3",
      transport: "paired" as const,
      pairedMachine: {
        hostIdentity: "toast-device",
        machineKey: "mk-toast",
      },
      sshUser: null,
      port: null,
      sshKeyPath: null,
      routes: null,
      lastSeenArch: null,
      runtimeBinaryVersion: null,
      lastConnectedAt: null,
    };
    remoteRuntimeMock.listTargets
      .mockResolvedValueOnce([])
      .mockResolvedValue([savedTarget]);
    accountMock.pairMachine.mockResolvedValue({
      targetId: savedTarget.id,
      machineKey: "mk-toast",
      deviceId: "toast-device",
      name: "Toast Studio",
    });
    remoteRuntimeMock.connect.mockResolvedValue({
      target: savedTarget,
      arch: "darwin-arm64",
      version: "1.0.0",
      route: {
        kind: "tailnet",
        endpoint: "100.92.14.3",
        latencyMs: 12,
      },
      projects: [],
    });
    installAdeMock();

    render(
      <RemoteTargetList
        accountMachines={[
          accountMachine({
            machineKey: "mk-toast",
            deviceId: "toast-device",
            name: "Toast Studio",
          }),
        ]}
        accountMachinesState="ok"
        accountSignedIn
      />,
    );

    await screen.findByText("Toast Studio");
    const row = getAccountRow("Toast Studio");
    vi.useFakeTimers();
    fireEvent.click(within(row).getByRole("button", { name: "Connect" }));
    await act(async () => {
      for (let index = 0; index < 12; index += 1) {
        await Promise.resolve();
      }
    });

    expect(screen.getByText("Connected via Tailscale · 12ms")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(4_000);
    });
    expect(screen.queryByText("Connected via Tailscale · 12ms")).toBeNull();
  });

  it("never lists this Mac as its own remote target (self-filter by machineKey or deviceId)", async () => {
    remoteRuntimeMock.listTargets.mockResolvedValue([]);
    remoteRuntimeMock.listDiscoveredMachines.mockResolvedValue({ machines: [], diagnostics: [] });
    installAdeMock();

    const machines: AdeAccountMachine[] = [
      {
        machineKey: "local-mk", // matches getLocalMachineIdentity().machineKey
        deviceId: "other-dev",
        name: "This Very Mac",
        platform: "darwin",
        deviceType: "desktop",
        reachableEndpoints: [],
        lastSeenAt: Date.now(),
        online: true,
      },
      {
        machineKey: "reinstalled-mk",
        deviceId: "local-dev", // matches getLocalMachineIdentity().deviceId (pre-reinstall row)
        name: "This Mac Before Reinstall",
        platform: "darwin",
        deviceType: "desktop",
        reachableEndpoints: [],
        lastSeenAt: Date.now() - 60_000,
        online: false,
      },
      {
        machineKey: "mk_other",
        deviceId: "dev_other",
        name: "Other Studio",
        platform: "darwin",
        deviceType: "desktop",
        reachableEndpoints: [],
        lastSeenAt: Date.now(),
        online: true,
      },
    ];

    render(
      <RemoteTargetList
        accountMachines={machines}
        accountMachinesState="ok"
        accountSignedIn
      />,
    );

    await waitFor(() => expect(screen.getByText("Other Studio")).toBeTruthy());
    expect(accountMock.getLocalMachineIdentity).toHaveBeenCalled();
    expect(screen.queryByText("This Very Mac")).toBeNull();
    expect(screen.queryByText("This Mac Before Reinstall")).toBeNull();
  });

  it("explains how to finish setup when an online account Mac has no ready route", () => {
    const machine: AdeAccountMachine = {
      machineKey: "studio",
      deviceId: "studio-device",
      name: "Studio",
      platform: "darwin",
      deviceType: "desktop",
      reachableEndpoints: [],
      lastSeenAt: Date.now(),
      online: true,
    };
    const onToggleDetail = vi.fn();
    const { rerender } = render(
      <AccountMachineRow
        row={{ kind: "account", id: "account:studio", machine, matchedTargetId: null }}
        section="available"
        busy={false}
        connecting={false}
        detailOpen={false}
        onToggleDetail={onToggleDetail}
        onConnect={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "How to connect" }));
    expect(onToggleDetail).toHaveBeenCalledWith("account:studio");

    rerender(
      <AccountMachineRow
        row={{ kind: "account", id: "account:studio", machine, matchedTargetId: null }}
        section="available"
        busy={false}
        connecting={false}
        detailOpen
        onToggleDetail={onToggleDetail}
        onConnect={vi.fn()}
      />,
    );
    expect(screen.getByText("Finish setup on the other Mac")).toBeTruthy();
    expect(screen.getByText(/it appears here automatically/i)).toBeTruthy();
  });
});
