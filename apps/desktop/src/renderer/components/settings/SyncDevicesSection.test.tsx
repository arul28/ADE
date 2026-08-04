/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { parsePairingQrUrl } from "../../../shared/pairingQr";
import type {
  SyncDeviceRuntimeState,
  SyncPeerConnectionState,
  SyncRoleSnapshot,
} from "../../../shared/types";
import {
  PhoneConnectionsTab,
  ThisMacCard,
  WebConnectionsTab,
  useSyncConnections,
  type SyncConnections,
} from "./SyncDevicesSection";
import { accountDirectorySummary } from "./accountDirectorySummary";

vi.mock("qrcode.react", () => ({
  QRCodeSVG: ({ value, title }: { value: string; title?: string }) => (
    <svg data-testid="pairing-qr" data-value={value} aria-label={title} />
  ),
}));

const originalAde = (globalThis.window as any)?.ade;

function makeStatus(overrides: Partial<SyncRoleSnapshot> = {}): SyncRoleSnapshot {
  return {
    mode: "brain",
    role: "brain",
    runtimeRole: "host",
    localDevice: {
      deviceId: "desktop-1",
      siteId: "site-1",
      name: "ADE Desktop",
      platform: "macOS",
      deviceType: "desktop",
      createdAt: "2026-04-22T00:00:00.000Z",
      updatedAt: "2026-04-22T00:00:00.000Z",
      lastSeenAt: "2026-04-22T00:00:00.000Z",
      lastHost: "192.168.1.20",
      lastPort: 8787,
      tailscaleIp: null,
      ipAddresses: ["192.168.1.20"],
      metadata: {},
    },
    currentBrain: null,
    clusterState: null,
    bootstrapToken: "bootstrap-token",
    pairingPin: null,
    pairingPinConfigured: true,
    runtimeName: "Studio",
    pairingConnectInfo: {
      hostIdentity: {
        deviceId: "desktop-1",
        siteId: "site-1",
        name: "ADE Desktop",
        platform: "macOS",
        deviceType: "desktop",
      },
      port: 8787,
      addressCandidates: [{ host: "192.168.1.20", kind: "lan" }],
    },
    connectedPeers: [],
    tailnetDiscovery: {
      state: "disabled",
      serviceName: "svc:ade-sync",
      servicePort: 8787,
      target: null,
      updatedAt: null,
      error: null,
      stderr: null,
    },
    routeHealth: {
      listener: { listenerBound: true, loopbackAdeValidated: true, port: 8787, lastFailureAt: null, reason: null, lastSuccessAt: null },
      tailscale: { enabled: false, tailscalePublished: false, tailscaleReachable: false, lastFailureAt: null, reason: null, lastSuccessAt: null },
      relay: { enabled: false, relayControlConnected: false, relayBridgeValidated: false, lastFailureAt: null, skipReason: null, lastControlError: null, lastControlOpenAt: null, lastBridgeValidationAt: null },
      accountDirectory: {
        state: "published",
        skipReason: null,
        directoryOrigin: "https://directory.example",
        lastAttemptAt: 1_752_600_000_000,
        lastSuccessAt: 1_752_600_000_000,
        lastHttpStatus: 200,
        lastHttpReason: null,
        reachableEndpointCount: 1,
      },
    },
    client: { state: "disconnected" } as SyncRoleSnapshot["client"],
    transferReadiness: { ready: true, blockers: [], survivableState: [] } as SyncRoleSnapshot["transferReadiness"],
    survivableStateText: "",
    blockingStateText: "",
    ...overrides,
  } as SyncRoleSnapshot;
}

function device(overrides: Partial<SyncDeviceRuntimeState> = {}): SyncDeviceRuntimeState {
  return {
    deviceId: "phone-1",
    name: "Arul iPhone",
    platform: "iOS",
    deviceType: "phone",
    connectionState: "connected",
    isLocal: false,
    latencyMs: 12,
    lastSeenAt: "2026-04-22T00:00:00.000Z",
    ...overrides,
  } as SyncDeviceRuntimeState;
}

function makeSync(overrides: Partial<SyncConnections> = {}): SyncConnections {
  return {
    status: makeStatus(),
    devices: [],
    loading: false,
    busy: false,
    notice: null,
    error: null,
    isRemoteBound: false,
    boundMachineName: null,
    localMachineName: "Studio",
    canManageDevices: true,
    setPinValue: vi.fn(async () => {}),
    generatePin: vi.fn(),
    clearPin: vi.fn(),
    saveRuntimeName: vi.fn(),
    forgetDevice: vi.fn(),
    retryInitialLoad: vi.fn(),
    refresh: vi.fn(async () => {}),
    ...overrides,
  } as SyncConnections;
}

function unreadableSessionStatus(): SyncRoleSnapshot {
  const status = makeStatus();
  status.routeHealth.accountDirectory = {
    ...status.routeHealth.accountDirectory,
    state: "token_unreadable",
    skipReason: "The ADE brain could not read the stored account session.",
    reachableEndpointCount: 0,
  };
  return status;
}

const autoConfirm = async () => true;

describe("ThisMacCard", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    if (originalAde === undefined) delete (globalThis.window as any).ade;
    else (globalThis.window as any).ade = originalAde;
  });

  it("shows the account state line for a signed-in Mac", () => {
    render(<ThisMacCard sync={makeSync()} accountSignedIn />);
    expect(screen.getByText("Studio")).toBeTruthy();
    expect(screen.getByText("Connected to your ADE account · 1 route published")).toBeTruthy();
    expect(screen.getByText("Ready to accept connections")).toBeTruthy();
  });

  it("surfaces when desktop sign-in and brain publication disagree", () => {
    const status = makeStatus();
    status.routeHealth.accountDirectory = {
      ...status.routeHealth.accountDirectory,
      state: "account_signed_out",
      skipReason: "The ADE brain is signed out of the ADE account.",
      lastHttpStatus: null,
    };
    render(<ThisMacCard sync={makeSync({ status })} accountSignedIn />);

    expect(screen.getByText(
      "Signed in, but this Mac is not published · The ADE brain is signed out of the ADE account.",
    )).toBeTruthy();
  });

  it("restarts the brain and re-reads health when repairing an unreadable session", async () => {
    // The main process resolves only once the replacement brain answers, so the
    // hook re-reads health the moment the call settles — no renderer-side sleep.
    let releaseRestart = () => {};
    const restartBackgroundService = vi.fn(
      () => new Promise<void>((resolve) => {
        releaseRestart = resolve;
      }),
    );
    const refresh = vi.fn(async () => {});
    (globalThis.window as any).ade = { app: { restartBackgroundService } };
    render(
      <ThisMacCard
        sync={makeSync({ status: unreadableSessionStatus(), refresh })}
        accountSignedIn
      />,
    );

    const button = screen.getByRole("button", { name: "Repair" });
    fireEvent.click(button);
    // Re-entrancy: a second click while the restart is in flight is dropped.
    fireEvent.click(button);
    expect(screen.getByRole("button", { name: "Repairing…" })).toBeTruthy();
    await act(async () => {});
    expect(restartBackgroundService).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();

    await act(async () => {
      releaseRestart();
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    // Health still says unreadable, so the banner and its button stay put.
    expect(screen.getByRole("button", { name: "Repair" })).toBeTruthy();
  });

  it("shows a terse inline error and keeps Repair available when the restart fails", async () => {
    const restartBackgroundService = vi.fn(async () => {
      throw new Error("launchctl load failed.");
    });
    (globalThis.window as any).ade = { app: { restartBackgroundService } };
    render(<ThisMacCard sync={makeSync({ status: unreadableSessionStatus() })} accountSignedIn />);

    fireEvent.click(screen.getByRole("button", { name: "Repair" }));
    const failure = await screen.findByText("Repair failed — quit and reopen ADE.");
    // Terse copy on screen; the technical detail rides along as the tooltip.
    expect(failure.getAttribute("title")).toBe("launchctl load failed.");
    expect(screen.getByRole("button", { name: "Repair" })).toBeTruthy();
  });

  it("offers no repair for failures a brain restart cannot fix", () => {
    (globalThis.window as any).ade = { app: { restartBackgroundService: vi.fn() } };
    const status = makeStatus();
    status.routeHealth.accountDirectory = {
      ...status.routeHealth.accountDirectory,
      state: "http_error",
      skipReason: "The account directory rejected the publish.",
    };
    render(<ThisMacCard sync={makeSync({ status })} accountSignedIn />);
    expect(screen.queryByRole("button", { name: "Repair" })).toBeNull();
  });

  it("explains nearby fallback when signed out", () => {
    render(<ThisMacCard sync={makeSync()} accountSignedIn={false} />);
    expect(
      screen.getByText("Not signed in — nearby devices can still connect with the pairing code"),
    ).toBeTruthy();
  });

  it("prompts to set a pairing code and generates one", () => {
    const generatePin = vi.fn();
    render(
      <ThisMacCard
        sync={makeSync({ status: makeStatus({ pairingPinConfigured: false }), generatePin })}
        accountSignedIn
      />,
    );
    expect(screen.getByText("Set a pairing code below so new devices can connect")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Generate code" }));
    expect(generatePin).toHaveBeenCalledTimes(1);
  });

  it("shows a visible pairing code with a working copy button", async () => {
    const writeClipboardText = vi.fn(async () => {});
    (globalThis.window as any).ade = { app: { writeClipboardText } };
    render(
      <ThisMacCard
        sync={makeSync({ status: makeStatus({ pairingPin: "123456" }) })}
        accountSignedIn
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeClipboardText).toHaveBeenCalledWith("123456"));
  });

  it("offers regenerate + remove for a configured-but-hidden code", () => {
    const generatePin = vi.fn();
    const clearPin = vi.fn();
    render(
      <ThisMacCard
        sync={makeSync({ status: makeStatus({ pairingPin: null, pairingPinConfigured: true }), generatePin, clearPin })}
        accountSignedIn
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Generate new code" }));
    expect(generatePin).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(clearPin).toHaveBeenCalledTimes(1);
  });

  it("labels this Mac with a chip and lists reachable routes plus the build line", async () => {
    (globalThis.window as any).ade = {
      app: { getInfo: vi.fn(async () => ({ appVersion: "1.2.28", platform: "darwin" })) },
    };
    const status = makeStatus({
      routeHealth: {
        listener: { listenerBound: true, loopbackAdeValidated: true, port: 8787, lastFailureAt: null, reason: null, lastSuccessAt: null },
        tailscale: { enabled: true, tailscalePublished: true, tailscaleReachable: true, lastFailureAt: null, reason: null, lastSuccessAt: null },
        relay: { enabled: true, relayControlConnected: true, relayBridgeValidated: true, lastFailureAt: null, skipReason: null, lastControlError: null, lastControlOpenAt: null, lastBridgeValidationAt: null },
        accountDirectory: makeStatus().routeHealth.accountDirectory,
      },
    });
    render(<ThisMacCard sync={makeSync({ status })} accountSignedIn />);

    expect(screen.getByText("This Mac")).toBeTruthy();
    expect(screen.getByText("Reachable via Wi-Fi · Tailscale · Relay")).toBeTruthy();
    expect(await screen.findByText("ADE 1.2.28 · macOS")).toBeTruthy();
  });

  it("omits unknown routes and only advertises the ones that are up", () => {
    const status = makeStatus({
      routeHealth: {
        listener: { listenerBound: true, loopbackAdeValidated: true, port: 8787, lastFailureAt: null, reason: null, lastSuccessAt: null },
        tailscale: { enabled: false, tailscalePublished: false, tailscaleReachable: false, lastFailureAt: null, reason: "off", lastSuccessAt: null },
        // Relay control connected but bridge not yet validated → not reachable.
        relay: { enabled: true, relayControlConnected: true, relayBridgeValidated: false, lastFailureAt: null, skipReason: null, lastControlError: null, lastControlOpenAt: null, lastBridgeValidationAt: null },
        accountDirectory: makeStatus().routeHealth.accountDirectory,
      },
    });
    render(<ThisMacCard sync={makeSync({ status })} accountSignedIn />);

    expect(screen.getByText("Reachable via Wi-Fi")).toBeTruthy();
    expect(screen.queryByText(/Tailscale/)).toBeNull();
    expect(screen.queryByText(/Relay/)).toBeNull();
  });

  it("no longer embeds a Connect-a-phone disclosure — the Phone tab owns pairing", () => {
    render(<ThisMacCard sync={makeSync()} accountSignedIn />);
    expect(screen.queryByText("Connect a phone")).toBeNull();
    expect(screen.queryByText("Scan to pair")).toBeNull();
  });

  it("shows this Mac's own name even while the window is remote-bound", () => {
    render(
      <ThisMacCard
        sync={makeSync({ isRemoteBound: true, boundMachineName: "Mac Studio", localMachineName: "Studio" })}
        accountSignedIn
      />,
    );
    // The card names the local machine, never the machine it routes to.
    expect(screen.getByText("Studio")).toBeTruthy();
    expect(screen.queryByText("Mac Studio")).toBeNull();
  });

  it("replaces pairing-code controls with a read-only note when remote-bound", () => {
    const generatePin = vi.fn();
    render(
      <ThisMacCard
        sync={makeSync({
          status: makeStatus({ pairingPin: "123456" }),
          isRemoteBound: true,
          boundMachineName: "Mac Studio",
          generatePin,
        })}
        accountSignedIn
      />,
    );
    expect(screen.getByText("This Mac's pairing code is 123456.")).toBeTruthy();
    expect(
      screen.getByText(/Pairing changes aren.t available while this window is connected to/),
    ).toBeTruthy();
    // No mutation controls that would silently change the bound machine.
    expect(screen.queryByRole("button", { name: "Change" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Generate" })).toBeNull();
    expect(generatePin).not.toHaveBeenCalled();
  });
});

describe("PhoneConnectionsTab", () => {
  afterEach(() => cleanup());

  it.each([true, false])(
    "includes pinConfigured=%s in the desktop pairing QR",
    (pairingPinConfigured) => {
      const status = makeStatus({ pairingPinConfigured });
      render(
        <PhoneConnectionsTab
          sync={makeSync({ status })}
          confirmRevoke={vi.fn(autoConfirm)}
        />,
      );

      const qrValue = screen.getByTestId("pairing-qr").getAttribute("data-value") ?? "";
      expect(parsePairingQrUrl(qrValue)?.pinConfigured).toBe(pairingPinConfigured);
    },
  );

  it("lists paired phones and revokes after confirmation", async () => {
    const forgetDevice = vi.fn();
    const confirmRevoke = vi.fn(autoConfirm);
    render(
      <PhoneConnectionsTab
        sync={makeSync({ devices: [device()], forgetDevice })}
        confirmRevoke={confirmRevoke}
      />,
    );
    expect(screen.getByText("Arul iPhone")).toBeTruthy();
    expect(
      screen.getByText("Sign in to ADE on your iPhone — this Mac appears automatically."),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(confirmRevoke).toHaveBeenCalled());
    await waitFor(() => expect(forgetDevice).toHaveBeenCalled());
  });

  it("does not revoke when the confirmation is declined", async () => {
    const forgetDevice = vi.fn();
    render(
      <PhoneConnectionsTab
        sync={makeSync({ devices: [device()], forgetDevice })}
        confirmRevoke={vi.fn(async () => false)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() => {});
    expect(forgetDevice).not.toHaveBeenCalled();
  });

  it("scopes the list to this Mac and hides revoke when remote-bound", () => {
    render(
      <PhoneConnectionsTab
        sync={makeSync({
          devices: [device()],
          isRemoteBound: true,
          boundMachineName: "Mac Studio",
          localMachineName: "Studio",
          canManageDevices: false,
        })}
        confirmRevoke={vi.fn(autoConfirm)}
      />,
    );
    expect(screen.getByText("Arul iPhone")).toBeTruthy();
    // Labeled as this Mac's phones — never the remote machine's.
    expect(screen.getByText("on Studio")).toBeTruthy();
    // Revoke would route to the bound machine, so it is withheld.
    expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
  });
});

describe("WebConnectionsTab", () => {
  afterEach(() => cleanup());

  it("offers the browser launcher when signed in", () => {
    render(
      <WebConnectionsTab sync={makeSync()} accountSignedIn confirmRevoke={vi.fn(autoConfirm)} />,
    );
    expect(screen.getByRole("button", { name: /Open ADE in browser/ })).toBeTruthy();
    expect(screen.queryByText("Sign in to use the web client")).toBeNull();
  });

  it("prompts to sign in when signed out", () => {
    const onAccountRequested = vi.fn();
    render(
      <WebConnectionsTab
        sync={makeSync()}
        accountSignedIn={false}
        confirmRevoke={vi.fn(autoConfirm)}
        onAccountRequested={onAccountRequested}
      />,
    );
    const signIn = screen.getByRole("button", { name: "Sign in to use the web client" });
    fireEvent.click(signIn);
    expect(onAccountRequested).toHaveBeenCalledTimes(1);
  });

  it("lists connected browsers and revokes after confirmation", async () => {
    const forgetDevice = vi.fn();
    render(
      <WebConnectionsTab
        sync={makeSync({
          devices: [device({ deviceId: "browser-1", name: "Chrome", deviceType: "browser" })],
          forgetDevice,
        })}
        accountSignedIn
        confirmRevoke={vi.fn(autoConfirm)}
      />,
    );
    expect(screen.getByText("Chrome")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(forgetDevice).toHaveBeenCalled());
  });

  it("scopes connected browsers to this Mac and hides revoke when remote-bound", () => {
    render(
      <WebConnectionsTab
        sync={makeSync({
          devices: [device({ deviceId: "browser-1", name: "Chrome", deviceType: "browser" })],
          isRemoteBound: true,
          boundMachineName: "Mac Studio",
          localMachineName: "Studio",
          canManageDevices: false,
        })}
        accountSignedIn
        confirmRevoke={vi.fn(autoConfirm)}
      />,
    );
    expect(screen.getByText("Chrome")).toBeTruthy();
    expect(screen.getByText("on Studio")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Data hook — local vs remote-bound scoping
// ---------------------------------------------------------------------------

function peer(overrides: Partial<SyncPeerConnectionState> = {}): SyncPeerConnectionState {
  return {
    deviceId: "phone-local",
    deviceName: "Local iPhone",
    platform: "iOS",
    deviceType: "phone",
    siteId: "site-phone",
    dbVersion: 0,
    connectedAt: "2026-04-22T00:00:00.000Z",
    lastSeenAt: "2026-04-22T00:00:00.000Z",
    lastAppliedAt: null,
    remoteAddress: "192.168.1.30",
    remotePort: 55000,
    latencyMs: 8,
    syncLag: 0,
    isBrain: false,
    isAuthenticated: true,
    ...overrides,
  } as SyncPeerConnectionState;
}

describe("useSyncConnections local scoping", () => {
  const originalAde = (globalThis.window as any)?.ade;

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    if (originalAde === undefined) delete (globalThis.window as any).ade;
    else (globalThis.window as any).ade = originalAde;
  });

  function installSyncMock(mock: {
    getStatus: () => Promise<SyncRoleSnapshot>;
    getLocalStatus: () => Promise<SyncRoleSnapshot>;
    listDevices: () => Promise<SyncDeviceRuntimeState[]>;
  }) {
    (globalThis.window as any).ade = {
      sync: {
        getStatus: vi.fn(mock.getStatus),
        getLocalStatus: vi.fn(mock.getLocalStatus),
        listDevices: vi.fn(mock.listDevices),
        onEvent: vi.fn(() => () => {}),
      },
    };
  }

  it("reports local scope when the routed and local machines match", async () => {
    const local = makeStatus();
    installSyncMock({
      getStatus: async () => local,
      getLocalStatus: async () => local,
      listDevices: async () => [device()],
    });

    const { result } = renderHook(() => useSyncConnections());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(window.ade.sync.getLocalStatus).toHaveBeenCalled();
    expect(result.current.isRemoteBound).toBe(false);
    expect(result.current.boundMachineName).toBeNull();
    expect(result.current.canManageDevices).toBe(true);
    // Unbound: the routed device list is used as-is.
    expect(result.current.devices.map((d) => d.deviceId)).toEqual(["phone-1"]);
  });

  it("uses the local snapshot and its own peers when remote-bound", async () => {
    const localStatus = makeStatus({
      localDevice: { ...makeStatus().localDevice, deviceId: "macbook", name: "MacBook Pro" },
      runtimeName: "MacBook Pro",
      connectedPeers: [peer()],
    });
    const remoteStatus = makeStatus({
      localDevice: { ...makeStatus().localDevice, deviceId: "studio", name: "Mac Studio" },
      runtimeName: "Mac Studio",
    });
    installSyncMock({
      getStatus: async () => remoteStatus,
      getLocalStatus: async () => localStatus,
      // Routed list would describe the REMOTE machine's phones; the hook must not use it.
      listDevices: async () => [device({ deviceId: "remote-phone", name: "Remote iPhone" })],
    });

    const { result } = renderHook(() => useSyncConnections());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Card identity comes from the local machine.
    expect(result.current.status?.localDevice.deviceId).toBe("macbook");
    expect(result.current.isRemoteBound).toBe(true);
    expect(result.current.boundMachineName).toBe("Mac Studio");
    expect(result.current.localMachineName).toBe("MacBook Pro");
    expect(result.current.canManageDevices).toBe(false);
    // Devices are derived from the LOCAL machine's live peers, not the routed list.
    expect(result.current.devices.map((d) => d.deviceId)).toEqual(["phone-local"]);
    expect(result.current.devices.map((d) => d.name)).toEqual(["Local iPhone"]);
  });

  it("withholds routed data and mutations when local status fails while remote-bound", async () => {
    const routed = makeStatus({
      localDevice: { ...makeStatus().localDevice, deviceId: "studio", name: "Mac Studio" },
      runtimeName: "Mac Studio",
    });
    installSyncMock({
      getStatus: async () => routed,
      getLocalStatus: async () => {
        throw new Error("no local runtime");
      },
      listDevices: async () => [device({ deviceId: "remote-phone", name: "Remote iPhone" })],
    });

    const { result } = renderHook(() => useSyncConnections());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.status).toBeNull();
    expect(result.current.devices).toEqual([]);
    expect(result.current.error).toBe("no local runtime");
    expect(result.current.canManageDevices).toBe(false);
    expect(result.current.isRemoteBound).toBe(false);
  });

  it("does not let an older local refresh overwrite a newer degraded result", async () => {
    const oldLocal = makeStatus({
      localDevice: { ...makeStatus().localDevice, deviceId: "macbook", name: "MacBook Pro" },
      runtimeName: "MacBook Pro",
    });
    const remote = makeStatus({
      localDevice: { ...makeStatus().localDevice, deviceId: "studio", name: "Mac Studio" },
      runtimeName: "Mac Studio",
    });
    let resolveOldLocal!: (status: SyncRoleSnapshot) => void;
    const oldLocalResult = new Promise<SyncRoleSnapshot>((resolve) => {
      resolveOldLocal = resolve;
    });
    let statusCalls = 0;
    let localCalls = 0;
    installSyncMock({
      getStatus: async () => (++statusCalls === 1 ? oldLocal : remote),
      getLocalStatus: async () => {
        localCalls += 1;
        if (localCalls === 1) return await oldLocalResult;
        throw new Error("local status unavailable");
      },
      listDevices: async () => [device({ deviceId: "remote-phone", name: "Remote iPhone" })],
    });

    const { result } = renderHook(() => useSyncConnections());
    await waitFor(() => expect(window.ade.sync.getLocalStatus).toHaveBeenCalledTimes(1));
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(result.current.error).toBe("local status unavailable"));

    await act(async () => {
      resolveOldLocal(oldLocal);
      await oldLocalResult;
    });

    expect(result.current.status).toBeNull();
    expect(result.current.devices).toEqual([]);
    expect(result.current.canManageDevices).toBe(false);
  });
});

describe("accountDirectorySummary", () => {
  it("reflects whether signed-out nearby pairing has a configured code", () => {
    const status = { pairingPinConfigured: false } as SyncRoleSnapshot;

    expect(accountDirectorySummary(status, false)).toEqual({
      label: "Not signed in — set a pairing code so nearby devices can connect",
      healthy: false,
    });

    status.pairingPinConfigured = true;
    expect(accountDirectorySummary(status, false).label).toContain(
      "nearby devices can still connect with the pairing code",
    );
  });

  it("names the publish failure reason instead of a bare state", () => {
    const withState = (
      state: SyncRoleSnapshot["routeHealth"]["accountDirectory"]["state"],
      skipReason: string | null,
    ) =>
      accountDirectorySummary(
        {
          routeHealth: {
            accountDirectory: { state, skipReason, reachableEndpointCount: 0 },
          },
        } as SyncRoleSnapshot,
        true,
      );

    expect(
      withState("token_unreadable", "The ADE brain could not read the stored account session."),
    ).toEqual({
      label:
        "Signed in, but this Mac is not published · The ADE brain could not read the stored account session.",
      healthy: false,
    });

    // No reason from the brain: the state itself is spelled out, not snake_case.
    expect(withState("http_error", null).label).toBe(
      "Signed in, but this Mac is not published · http error",
    );
  });
});
