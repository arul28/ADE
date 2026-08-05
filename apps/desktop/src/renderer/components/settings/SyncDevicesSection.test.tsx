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
import { THIS_MACHINE_NAME } from "../../../shared/machineIdentity";
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

/**
 * Pairing controls live behind a disclosure that is closed on every mount, so
 * every test that touches them has to open it first.
 */
function openPairing() {
  fireEvent.click(screen.getByRole("button", { name: /^Pairing code/ }));
}

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
    expect(screen.getByText("Connected to your ADE account")).toBeTruthy();
  });

  it("says nothing about readiness or routes when this computer is healthy", () => {
    render(<ThisMacCard sync={makeSync()} accountSignedIn />);
    // A healthy host has no actionable status, so it gets no status line at all.
    expect(screen.queryByText("Ready to accept connections")).toBeNull();
    expect(screen.queryByText(/Reachable via/)).toBeNull();
  });

  it("treats an unset pairing code as ordinary, not a fault", () => {
    render(
      <ThisMacCard
        sync={makeSync({ status: makeStatus({ pairingPinConfigured: false }) })}
        accountSignedIn
      />,
    );
    // Connecting runs through the ADE account now; no code is a normal state.
    expect(screen.queryByText(/Set a pairing code/)).toBeNull();
    expect(screen.getByRole("button", { name: /^Pairing code/ }).textContent)
      .toContain("Not set");
  });

  it("renames this computer and mirrors the name into the account directory", async () => {
    const saveRuntimeName = vi.fn();
    const renameMachine = vi.fn(async () => {});
    (globalThis.window as any).ade = {
      account: {
        getLocalMachineIdentity: vi.fn(async () => ({ machineKey: "mk-1", deviceId: "dev-1" })),
        renameMachine,
      },
    };
    render(<ThisMacCard sync={makeSync({ saveRuntimeName })} accountSignedIn />);

    fireEvent.click(screen.getByRole("button", { name: "Rename Studio" }));
    fireEvent.change(screen.getByLabelText("Machine name"), { target: { value: "Workshop" } });
    fireEvent.click(screen.getByRole("button", { name: "Save machine name" }));

    // The runtime name is what this card renders, so it lands first…
    expect(saveRuntimeName).toHaveBeenCalledWith("Workshop");
    // …and the account directory catches up so other clients agree.
    await waitFor(() => expect(renameMachine).toHaveBeenCalledWith("mk-1", "Workshop"));
  });

  it("keeps the pencil visible but inert while signed out", () => {
    render(<ThisMacCard sync={makeSync()} accountSignedIn={false} />);
    const pencil = screen.getByRole("button", { name: "Rename Studio" });
    expect((pencil as HTMLButtonElement).disabled).toBe(true);
    expect(pencil.getAttribute("title")).toBe("Sign in to rename this computer");
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
      "Signed in, but this computer is not published · The ADE brain is signed out of the ADE account.",
    )).toBeTruthy();
  });

  it("surfaces a missing Windows CR-SQLite runtime before pairing is attempted", () => {
    const status = makeStatus({
      crdtSyncAvailable: false,
      blockingStateText: "Phone sync is unavailable in this ADE installation.",
    });

    render(<ThisMacCard sync={makeSync({ status })} accountSignedIn />);

    expect(screen.getByRole("alert").textContent).toContain(
      "Phone sync is unavailable in this ADE installation.",
    );
    // The alert above carries the runtime's full explanation; the status line
    // does not repeat a one-liner version of it.
    expect(screen.queryByRole("button", { name: /^Pairing code/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Generate code/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Remove/i })).toBeNull();
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

  it("generates a code from inside the pairing disclosure", () => {
    const generatePin = vi.fn();
    render(
      <ThisMacCard
        sync={makeSync({ status: makeStatus({ pairingPinConfigured: false }), generatePin })}
        accountSignedIn
      />,
    );
    // Closed on mount — nothing inside is reachable until it is opened.
    expect(screen.queryByRole("button", { name: "Generate code" })).toBeNull();
    openPairing();
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
    openPairing();
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
    openPairing();
    fireEvent.click(screen.getByRole("button", { name: "Generate new code" }));
    expect(generatePin).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(clearPin).toHaveBeenCalledTimes(1);
  });

  it("reopens the pairing disclosure closed every time, never remembering it", () => {
    const { unmount } = render(<ThisMacCard sync={makeSync()} accountSignedIn />);
    openPairing();
    expect(screen.getByRole("button", { name: /^Pairing code/ }).getAttribute("aria-expanded"))
      .toBe("true");
    unmount();

    render(<ThisMacCard sync={makeSync()} accountSignedIn />);
    expect(screen.getByRole("button", { name: /^Pairing code/ }).getAttribute("aria-expanded"))
      .toBe("false");
  });

  it.each([
    ["darwin", "macOS"],
    ["win32", "Windows"],
    ["linux", "Linux"],
  ])("marks the identity tile with the %s platform logo", async (platform, accessibleName) => {
    (globalThis.window as any).ade = {
      app: { getInfo: vi.fn(async () => ({ appVersion: "1.2.28", platform })) },
    };
    render(<ThisMacCard sync={makeSync()} accountSignedIn />);

    expect(await screen.findByRole("img", { name: accessibleName })).toBeTruthy();
    // The logo is the platform statement, so the version line never repeats it.
    expect(await screen.findByText("ADE 1.2.28")).toBeTruthy();
    expect(screen.queryByText(new RegExp(`ADE 1\\.2\\.28.*${accessibleName}`))).toBeNull();
  });

  it("labels this computer with a chip", () => {
    render(<ThisMacCard sync={makeSync()} accountSignedIn />);
    // Composed from THIS_MACHINE_NAME, never spelled out: this badge was
    // macOS-only copy ("This Mac") until ADE shipped on Windows, and pinning the
    // literal here is what let Settings and Account miss the rename.
    expect(screen.getByText(THIS_MACHINE_NAME)).toBeTruthy();
  });

  it("swaps the version line for the fault while the listener is down", async () => {
    (globalThis.window as any).ade = {
      app: { getInfo: vi.fn(async () => ({ appVersion: "1.2.28", platform: "win32" })) },
    };
    const status = makeStatus({ pairingConnectInfo: null });
    status.routeHealth.listener = {
      ...status.routeHealth.listener,
      listenerBound: false,
      reason: "Port 8787 is already in use.",
    };
    render(<ThisMacCard sync={makeSync({ status })} accountSignedIn />);

    expect(await screen.findByText("Port 8787 is already in use.")).toBeTruthy();
    // One slot, so the card never grows a line in the unhappy path.
    expect(screen.queryByText("ADE 1.2.28")).toBeNull();
  });

  it("no longer embeds a Connect-a-phone disclosure — the Phone tab owns pairing", () => {
    render(<ThisMacCard sync={makeSync()} accountSignedIn />);
    expect(screen.queryByText("Connect a phone")).toBeNull();
    expect(screen.queryByText("Scan to pair")).toBeNull();
  });

  it("shows this computer's own name even while the window is remote-bound", () => {
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
    openPairing();
    expect(screen.getByText(`${THIS_MACHINE_NAME}'s pairing code is 123456.`)).toBeTruthy();
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
      screen.getByText("Sign in to ADE on your iPhone — this computer appears automatically."),
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

  it("scopes the list to this computer and hides revoke when remote-bound", () => {
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
    // Labeled as this computer's phones — never the remote machine's.
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

  it("scopes connected browsers to this computer and hides revoke when remote-bound", () => {
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
        "Signed in, but this computer is not published · The ADE brain could not read the stored account session.",
      healthy: false,
    });

    // No reason from the brain: the state itself is spelled out, not snake_case.
    expect(withState("http_error", null).label).toBe(
      "Signed in, but this computer is not published · http error",
    );
  });
});
