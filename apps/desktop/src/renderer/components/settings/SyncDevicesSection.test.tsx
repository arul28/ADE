/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  readLocalSyncStatus,
  resetLocalSyncStatusReaderForTests,
} from "../../lib/localSyncStatusReader";
import { parsePairingQrUrl } from "../../../shared/pairingQr";
import { readThisMachineRefusal } from "../../../shared/accountMachineRefusal";
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
import { resetReconnectFlowForTests } from "../../lib/reconnectThisComputer";
import { __resetDialogRequestsForTests } from "../ui/dialog/confirm";
import { useAppStore } from "../../state/appStore";

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
    projectStatus: makeStatus(),
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
  fireEvent.click(screen.getByRole("button", { name: /^Manual pairing code/ }));
}

// The reconnect flow is one per window, so it outlives each test's render.
afterEach(() => {
  resetReconnectFlowForTests();
});

describe("ThisMacCard", () => {
  afterEach(() => {
    __resetDialogRequestsForTests();
    cleanup();
    vi.restoreAllMocks();
    if (originalAde === undefined) delete (globalThis.window as any).ade;
    else (globalThis.window as any).ade = originalAde;
  });

  it("shows the account state line for a signed-in Mac", () => {
    render(<ThisMacCard sync={makeSync()} sessionState="active" />);
    expect(screen.getByText("Studio")).toBeTruthy();
    expect(screen.getByText("Connected to your ADE account")).toBeTruthy();
  });

  it("says nothing about readiness or routes when this computer is healthy", () => {
    render(<ThisMacCard sync={makeSync()} sessionState="active" />);
    // A healthy host has no actionable status, so it gets no status line at all.
    expect(screen.queryByText("Ready to accept connections")).toBeNull();
    expect(screen.queryByText(/Reachable via/)).toBeNull();
  });

  it("treats an unset pairing code as ordinary, not a fault", () => {
    render(
      <ThisMacCard
        sync={makeSync({ status: makeStatus({ pairingPinConfigured: false }) })}
        sessionState="active"
      />,
    );
    // Connecting runs through the ADE account now; no code is a normal state.
    expect(screen.queryByText(/Set a pairing code/)).toBeNull();
    expect(screen.getByRole("button", { name: /^Manual pairing code/ })).toBeTruthy();
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
    render(<ThisMacCard sync={makeSync({ saveRuntimeName })} sessionState="active" />);

    fireEvent.click(screen.getByRole("button", { name: "Rename Studio" }));
    fireEvent.change(screen.getByLabelText("Machine name"), { target: { value: "Workshop" } });
    fireEvent.click(screen.getByRole("button", { name: "Save machine name" }));

    // The runtime name is what this card renders, so it lands first…
    expect(saveRuntimeName).toHaveBeenCalledWith("Workshop");
    // …and the account directory catches up so other clients agree.
    await waitFor(() => expect(renameMachine).toHaveBeenCalledWith("mk-1", "Workshop"));
  });

  it("keeps the pencil visible but inert while signed out", () => {
    render(<ThisMacCard sync={makeSync()} sessionState="signed_out" />);
    const pencil = screen.getByRole("button", { name: "Rename Studio" });
    expect((pencil as HTMLButtonElement).disabled).toBe(true);
    expect(pencil.getAttribute("title")).toBe("Sign in to rename this computer");
  });

  // The summary line and the Reconnect button read the refusal once, with one
  // guard, so the line can never say "removed" beside no button.
  it("names a refusal only where it also offers the button", () => {
    (globalThis.window as any).ade = { account: { repairMachinePairing: vi.fn() } };
    const refusedStatus = () => {
      const status = makeStatus();
      status.routeHealth.accountDirectory = {
        ...status.routeHealth.accountDirectory,
        state: "http_error",
        lastHttpStatus: 403,
        lastHttpReason: "machine_revoked",
        reachableEndpointCount: 0,
      };
      return status;
    };

    render(<ThisMacCard sync={makeSync({ status: refusedStatus() })} sessionState="active" />);
    expect(screen.getByText("This computer was removed from your account")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reconnect this computer" })).toBeTruthy();
    cleanup();

    render(<ThisMacCard sync={makeSync({ status: refusedStatus() })} sessionState="signed_out" />);
    expect(screen.queryByText(/removed from your account/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Reconnect this computer" })).toBeNull();
    cleanup();

    // A remote-bound pane shows another machine's snapshot.
    render(
      <ThisMacCard
        sync={makeSync({ status: refusedStatus(), isRemoteBound: true, boundMachineName: "Studio" })}
        sessionState="active"
      />,
    );
    expect(screen.queryByText(/removed from your account/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Reconnect this computer" })).toBeNull();
  });

  it("surfaces when desktop sign-in and brain publication disagree", () => {
    const status = makeStatus();
    status.routeHealth.accountDirectory = {
      ...status.routeHealth.accountDirectory,
      state: "account_signed_out",
      skipReason: "The ADE brain is signed out of the ADE account.",
      lastHttpStatus: null,
    };
    render(<ThisMacCard sync={makeSync({ status })} sessionState="active" />);

    // The brain's skipReason stays out of the card; the line says what is true.
    expect(screen.getByText(
      "Signed in — the ADE background service is signed out",
    )).toBeTruthy();
    expect(screen.queryByText(/The ADE brain is signed out of the ADE account\./)).toBeNull();
  });

  it("surfaces a missing Windows CR-SQLite runtime before pairing is attempted", () => {
    const status = makeStatus({
      crdtSyncAvailable: false,
      blockingStateText: "Phone sync is unavailable in this ADE installation.",
    });

    render(<ThisMacCard sync={makeSync({ status })} sessionState="active" />);

    expect(screen.getByRole("status").textContent).toContain(
      "Phone sync is unavailable in this ADE installation.",
    );
    // The alert above carries the runtime's full explanation; the status line
    // does not repeat a one-liner version of it.
    expect(screen.queryByRole("button", { name: /^Manual pairing code/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Generate code/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Remove/i })).toBeNull();
  });

  it("still offers Repair on a cold unreadable read while signed out", () => {
    (globalThis.window as any).ade = { app: { restartBackgroundService: vi.fn() } };
    render(
      <ThisMacCard
        sync={makeSync({ status: unreadableSessionStatus() })}
        sessionState="unreadable"
      />,
    );
    expect(screen.getByRole("button", { name: "Repair" })).toBeTruthy();
    expect(
      screen.getByText("Your session is still there — open your account to fix it"),
    ).toBeTruthy();
    expect(screen.queryByText(/Not signed in/)).toBeNull();
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
        sessionState="active"
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
    render(<ThisMacCard sync={makeSync({ status: unreadableSessionStatus() })} sessionState="active" />);

    fireEvent.click(screen.getByRole("button", { name: "Repair" }));
    // The reason the main process gave is the message, not a hidden tooltip:
    // "Repair failed" alone left people with an instruction and no reason.
    const failure = await screen.findByText("Repair didn't finish. launchctl load failed.");
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
    render(<ThisMacCard sync={makeSync({ status })} sessionState="active" />);
    expect(screen.queryByRole("button", { name: "Repair" })).toBeNull();
  });

  it("explains nearby fallback when signed out", () => {
    render(<ThisMacCard sync={makeSync()} sessionState="signed_out" />);
    expect(
      screen.getByText("Not signed in — you can still connect to other machines manually"),
    ).toBeTruthy();
  });

  it("generates a code from inside the pairing disclosure", () => {
    const generatePin = vi.fn();
    render(
      <ThisMacCard
        sync={makeSync({ status: makeStatus({ pairingPinConfigured: false }), generatePin })}
        sessionState="active"
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
        sessionState="active"
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
        sessionState="active"
      />,
    );
    openPairing();
    fireEvent.click(screen.getByRole("button", { name: "Generate new code" }));
    expect(generatePin).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(clearPin).toHaveBeenCalledTimes(1);
  });

  it("reopens the pairing disclosure closed every time, never remembering it", () => {
    const { unmount } = render(<ThisMacCard sync={makeSync()} sessionState="active" />);
    openPairing();
    expect(screen.getByRole("button", { name: /^Manual pairing code/ }).getAttribute("aria-expanded"))
      .toBe("true");
    unmount();

    render(<ThisMacCard sync={makeSync()} sessionState="active" />);
    expect(screen.getByRole("button", { name: /^Manual pairing code/ }).getAttribute("aria-expanded"))
      .toBe("false");
  });

  it.each([
    ["darwin", "Mac"],
    ["win32", "Windows"],
    ["linux", "Linux"],
  ])("marks the identity tile with the %s platform logo", async (platform, accessibleName) => {
    (globalThis.window as any).ade = {
      app: { getInfo: vi.fn(async () => ({ appVersion: "1.2.28", platform })) },
    };
    render(<ThisMacCard sync={makeSync()} sessionState="active" />);

    // The tile is the platform statement; the chip beside it carries the
    // version number alone, so the platform is never spelled out twice.
    expect(
      await screen.findByRole("button", { name: new RegExp(`${accessibleName} desktop`) }),
    ).toBeTruthy();
    expect(await screen.findByText("1.2.28")).toBeTruthy();
    expect(screen.queryByText(new RegExp(`1\\.2\\.28.*${accessibleName}`))).toBeNull();
  });

  it("labels this pane as this machine", () => {
    render(<ThisMacCard sync={makeSync()} sessionState="active" />);
    expect(screen.getByText("This computer")).toBeTruthy();
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
    render(<ThisMacCard sync={makeSync({ status })} sessionState="active" />);

    expect(await screen.findByText("Port 8787 is already in use.")).toBeTruthy();
    expect(screen.getByText("1.2.28")).toBeTruthy();
  });

  it("shows this computer's own name even while the window is remote-bound", () => {
    render(
      <ThisMacCard
        sync={makeSync({ isRemoteBound: true, boundMachineName: "Mac Studio", localMachineName: "Studio" })}
        sessionState="active"
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
        sessionState="active"
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

  describe("Stop following", () => {
    const followerButton = { name: "Stop following Mac Studio" };

    const acknowledgement = { name: /I understand this computer will host sync for Repo/ };

    // The button needs a project open in this window to act on.
    beforeEach(() => {
      useAppStore.setState({ project: { rootPath: "/repo", displayName: "Repo", baseRef: "main" } as any });
    });
    afterEach(() => {
      useAppStore.setState({ project: null });
    });

    function daysAgo(days: number): string {
      return new Date(Date.now() - days * 86_400_000).toISOString();
    }

    function followerStatus(client: Partial<SyncRoleSnapshot["client"]> = {}): SyncRoleSnapshot {
      return makeStatus({
        mode: "viewer",
        role: "viewer",
        runtimeRole: "viewer",
        viewerReason: "saved_connection",
        runtimeMode: "viewer",
        client: {
          state: "error",
          host: "192.168.1.89",
          port: 8788,
          hostName: "Mac Studio",
          ...client,
        } as SyncRoleSnapshot["client"],
      });
    }

    // The machine's status and the project's status are separate reads, and the
    // button follows the project's. Both directions of a mismatch are here: a
    // machine that hosts while its project follows a ghost (the button must
    // show, or the reader has no way out), and a machine that follows while its
    // project hosts (the button must not show, or it would disconnect a project
    // that does not follow anything).
    it.each([
      { case: "a host with no project read yet", status: makeStatus(), projectStatus: null, isRemoteBound: false, shown: false },
      { case: "a host whose project follows another machine", status: makeStatus(), projectStatus: followerStatus(), isRemoteBound: false, shown: true },
      { case: "a viewer whose project hosts", status: followerStatus(), projectStatus: makeStatus(), isRemoteBound: false, shown: false },
      { case: "a viewer whose project follows another machine", status: followerStatus(), projectStatus: followerStatus(), isRemoteBound: false, shown: true },
      { case: "a project that follows, bound to another machine", status: makeStatus(), projectStatus: followerStatus(), isRemoteBound: true, shown: false },
    ])("offers the button for $case only when it applies", ({ status, projectStatus, isRemoteBound, shown }) => {
      // canManageDevices is derived from the bound state exactly as the hook derives it.
      render(
        <ThisMacCard
          sync={makeSync({ status, projectStatus, isRemoteBound, canManageDevices: !isRemoteBound })}
          sessionState="active"
        />,
      );
      expect(screen.queryByRole("button", followerButton) !== null).toBe(shown);
    });

    it("names the machine from the project's status, not the machine's", () => {
      render(
        <ThisMacCard
          sync={makeSync({ status: makeStatus(), projectStatus: followerStatus({ hostName: "Office Mini" }) })}
          sessionState="active"
        />,
      );
      expect(screen.getByRole("button", { name: "Stop following Office Mini" })).toBeTruthy();
      expect(screen.queryByRole("button", followerButton)).toBeNull();
    });

    it("stops the project's follow even though the machine reports that it hosts", async () => {
      const disconnectFromBrain = vi.fn(async () => makeStatus());
      (globalThis.window as any).ade = { sync: { disconnectFromBrain, getStatus: async () => followerStatus() } };
      render(<ThisMacCard sync={makeSync({ status: makeStatus(), projectStatus: followerStatus() })} sessionState="active" />);

      fireEvent.click(screen.getByRole("button", followerButton));
      fireEvent.click(screen.getByRole("checkbox", acknowledgement));
      fireEvent.click(screen.getByRole("button", { name: "Stop following" }));

      await waitFor(() => expect(disconnectFromBrain).toHaveBeenCalledOnce());
    });

    it("shows the followed machine's standing from the project's status", () => {
      render(
        <ThisMacCard
          sync={makeSync({ status: makeStatus(), projectStatus: followerStatus({ state: "connected" }) })}
          sessionState="active"
        />,
      );
      fireEvent.click(screen.getByRole("button", followerButton));
      expect(screen.getByText("Mac Studio is reachable from this computer now.")).toBeTruthy();
    });

    it("is hidden when no project is open in this window", () => {
      useAppStore.setState({ project: null });
      render(<ThisMacCard sync={makeSync({ status: followerStatus(), projectStatus: followerStatus() })} sessionState="active" />);
      expect(screen.queryByRole("button", followerButton)).toBeNull();
    });

    it("says that this computer will host sync, and what is forgotten and kept", () => {
      render(<ThisMacCard sync={makeSync({ status: followerStatus(), projectStatus: followerStatus() })} sessionState="active" />);

      fireEvent.click(screen.getByRole("button", followerButton));
      expect(screen.getByText(/This computer will start hosting sync for Repo\./)).toBeTruthy();
      expect(screen.getByText(/ADE forgets the saved connection to Mac Studio/)).toBeTruthy();
      expect(screen.getByText(/No chats, lanes, or files are deleted\./)).toBeTruthy();
      expect(screen.getByText(/If Mac Studio is still running, the two will stay separate/)).toBeTruthy();
      expect(screen.getByRole("checkbox", acknowledgement)).toBeTruthy();
    });

    it.each<{ case: string; client: Partial<SyncRoleSnapshot["client"]>; line: string }>([
      { case: "it answers now", client: { state: "connected" }, line: "Mac Studio is reachable from this computer now." },
      { case: "it was last seen three days ago", client: { lastSeenAt: daysAgo(3) }, line: "Mac Studio isn't reachable from this computer right now. Last seen 3d ago." },
      { case: "nothing has seen it", client: {}, line: "Mac Studio isn't reachable from this computer right now, and ADE has no record of it being seen." },
    ])("shows how the followed machine stands when $case", ({ client, line }) => {
      render(<ThisMacCard sync={makeSync({ status: followerStatus(), projectStatus: followerStatus(client) })} sessionState="active" />);

      fireEvent.click(screen.getByRole("button", followerButton));
      expect(screen.getByText(line)).toBeTruthy();
    });

    it("keeps the confirmation disabled until the reader acknowledges what stopping does", async () => {
      const disconnectFromBrain = vi.fn(async () => makeStatus());
      (globalThis.window as any).ade = { sync: { disconnectFromBrain, getStatus: async () => followerStatus() } };
      render(<ThisMacCard sync={makeSync({ status: followerStatus(), projectStatus: followerStatus() })} sessionState="active" />);

      fireEvent.click(screen.getByRole("button", followerButton));
      expect((screen.getByRole("button", { name: "Stop following" }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "Stop following" }));
      expect(disconnectFromBrain).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("checkbox", acknowledgement));
      expect((screen.getByRole("button", { name: "Stop following" }) as HTMLButtonElement).disabled).toBe(false);
      fireEvent.click(screen.getByRole("button", { name: "Stop following" }));
      await waitFor(() => expect(disconnectFromBrain).toHaveBeenCalledOnce());
    });

    it("disconnects once after confirmation and refreshes the card", async () => {
      const disconnectFromBrain = vi.fn(async () => makeStatus());
      const refresh = vi.fn(async () => {});
      (globalThis.window as any).ade = { sync: { disconnectFromBrain, getStatus: async () => followerStatus() } };
      render(<ThisMacCard sync={makeSync({ status: followerStatus(), projectStatus: followerStatus(), refresh })} sessionState="active" />);

      fireEvent.click(screen.getByRole("button", followerButton));
      expect(disconnectFromBrain).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("checkbox", acknowledgement));
      fireEvent.click(screen.getByRole("button", { name: "Stop following" }));
      await waitFor(() => expect(disconnectFromBrain).toHaveBeenCalledOnce());
      await waitFor(() => expect(refresh).toHaveBeenCalledWith({ force: true }));
    });

    it("does not wait on Start sync before it disconnects", async () => {
      // Start sync is the activation that got stuck. It never settles here, and
      // the stop must not depend on it.
      const startSyncHost = vi.fn(() => new Promise<never>(() => {}));
      const disconnectFromBrain = vi.fn(async () => makeStatus());
      (globalThis.window as any).ade = { account: { startSyncHost }, sync: { disconnectFromBrain, getStatus: async () => followerStatus() } };
      const status = followerStatus();
      status.routeHealth.accountDirectory = { ...status.routeHealth.accountDirectory, state: "sync_not_started" };
      render(<ThisMacCard sync={makeSync({ status, projectStatus: status })} sessionState="active" />);

      fireEvent.click(screen.getByRole("button", followerButton));
      fireEvent.click(screen.getByRole("checkbox", acknowledgement));
      fireEvent.click(screen.getByRole("button", { name: "Stop following" }));

      await waitFor(() => expect(disconnectFromBrain).toHaveBeenCalledOnce());
      expect(startSyncHost).not.toHaveBeenCalled();
    });

    it("opens one confirmation and disconnects once when the button is clicked twice", async () => {
      const disconnectFromBrain = vi.fn(async () => makeStatus());
      (globalThis.window as any).ade = { sync: { disconnectFromBrain, getStatus: async () => followerStatus() } };
      render(<ThisMacCard sync={makeSync({ status: followerStatus(), projectStatus: followerStatus() })} sessionState="active" />);

      const button = screen.getByRole("button", followerButton);
      fireEvent.click(button);
      fireEvent.click(button);
      expect(screen.getAllByText("Stop following Mac Studio?")).toHaveLength(1);

      fireEvent.click(screen.getByRole("checkbox", acknowledgement));
      fireEvent.click(screen.getByRole("button", { name: "Stop following" }));
      await waitFor(() => expect(disconnectFromBrain).toHaveBeenCalledOnce());
      await waitFor(() => expect(screen.queryByText("Stop following Mac Studio?")).toBeNull());
      expect(disconnectFromBrain).toHaveBeenCalledOnce();
    });

    it("does not disconnect when the confirmation is cancelled, and asks again on the next click", async () => {
      const disconnectFromBrain = vi.fn(async () => makeStatus());
      (globalThis.window as any).ade = { sync: { disconnectFromBrain, getStatus: async () => followerStatus() } };
      render(<ThisMacCard sync={makeSync({ status: followerStatus(), projectStatus: followerStatus() })} sessionState="active" />);

      fireEvent.click(screen.getByRole("button", followerButton));
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByText("Stop following Mac Studio?")).toBeNull());
      expect(disconnectFromBrain).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole("button", followerButton));
      expect(await screen.findByText("Stop following Mac Studio?")).toBeTruthy();
    });

    it("stops nothing when the window changed projects while the question was open", async () => {
      const disconnectFromBrain = vi.fn(async () => makeStatus());
      (globalThis.window as any).ade = { sync: { disconnectFromBrain, getStatus: async () => followerStatus() } };
      render(<ThisMacCard sync={makeSync({ status: followerStatus(), projectStatus: followerStatus() })} sessionState="active" />);

      fireEvent.click(screen.getByRole("button", followerButton));
      act(() => {
        useAppStore.setState({ project: { rootPath: "/other", displayName: "Other", baseRef: "main" } as any });
      });
      fireEvent.click(screen.getByRole("checkbox", acknowledgement));
      fireEvent.click(screen.getByRole("button", { name: "Stop following" }));

      await waitFor(() => expect(screen.queryByText("Stop following Mac Studio?")).toBeNull());
      expect(disconnectFromBrain).not.toHaveBeenCalled();
    });

    it("sends nothing when the project's status cannot be read while the question was open", async () => {
      // The ghost can be reclaimed while the reader is still deciding. A disconnect
      // on a host would clear the devices it pairs, so it must not go out.
      const disconnectFromBrain = vi.fn(async () => makeStatus());
      const refresh = vi.fn(async () => {});
      const getStatus = async () => { throw new Error("The background service did not answer."); };
      (globalThis.window as any).ade = { sync: { disconnectFromBrain, getStatus } };
      render(<ThisMacCard sync={makeSync({ status: followerStatus(), projectStatus: followerStatus(), refresh })} sessionState="active" />);

      fireEvent.click(screen.getByRole("button", followerButton));
      fireEvent.click(screen.getByRole("checkbox", acknowledgement));
      fireEvent.click(screen.getByRole("button", { name: "Stop following" }));

      await waitFor(() => expect(refresh).toHaveBeenCalledWith({ force: true }));
      expect(disconnectFromBrain).not.toHaveBeenCalled();
    });

    it("says the computer already hosts when the project started hosting while the question was open", async () => {
      // The project can start hosting in the same window. Nothing is sent, and
      // the card says so rather than saying the project stopped following.
      const disconnectFromBrain = vi.fn(async () => makeStatus());
      const refresh = vi.fn(async () => {});
      (globalThis.window as any).ade = { sync: { disconnectFromBrain, getStatus: async () => makeStatus() } };
      render(<ThisMacCard sync={makeSync({ status: followerStatus(), projectStatus: followerStatus(), refresh })} sessionState="active" />);

      fireEvent.click(screen.getByRole("button", followerButton));
      fireEvent.click(screen.getByRole("checkbox", acknowledgement));
      fireEvent.click(screen.getByRole("button", { name: "Stop following" }));

      expect(await screen.findByText("This computer is already hosting sync for Repo. Nothing was stopped.")).toBeTruthy();
      expect(disconnectFromBrain).not.toHaveBeenCalled();
      expect(refresh).toHaveBeenCalledWith({ force: true });
    });

    it("shows that the computer already hosts when the brain refuses the disconnect, and keeps it after the refresh", async () => {
      // The project's status is read as a viewer, then starts hosting before the
      // disconnect reaches the brain. The brain refuses it with its own message
      // (ade-cli syncService.disconnectFromBrain), wrapped the way Electron wraps
      // an IPC error. The card names the state instead of showing that wording.
      const brainRefusal = "This project is the sync brain, so it has no brain to disconnect from. Its devices and cluster record are kept.";
      const disconnectFromBrain = vi.fn(async () => {
        throw new Error(`Error invoking remote method 'ade.sync.disconnectFromBrain': Error: ${brainRefusal}`);
      });
      const refresh = vi.fn(async () => {});
      (globalThis.window as any).ade = { sync: { disconnectFromBrain, getStatus: async () => followerStatus() } };
      const { rerender } = render(<ThisMacCard sync={makeSync({ status: followerStatus(), projectStatus: followerStatus(), refresh })} sessionState="active" />);

      fireEvent.click(screen.getByRole("button", followerButton));
      fireEvent.click(screen.getByRole("checkbox", acknowledgement));
      fireEvent.click(screen.getByRole("button", { name: "Stop following" }));

      expect(await screen.findByText("This computer is already hosting sync for Repo. Nothing was stopped.")).toBeTruthy();
      expect(screen.queryByText(/This project is the sync brain/)).toBeNull();
      expect(screen.queryByText(/Error invoking remote method/)).toBeNull();
      await waitFor(() => expect(refresh).toHaveBeenCalledWith({ force: true }));
      expect(disconnectFromBrain).toHaveBeenCalledOnce();

      // The refresh reads the project as hosting, so the stop button goes. The
      // notice is the only thing left to say why nothing was stopped.
      rerender(<ThisMacCard sync={makeSync({ status: makeStatus(), projectStatus: makeStatus(), refresh })} sessionState="active" />);
      expect(screen.queryByRole("button", followerButton)).toBeNull();
      expect(screen.getByText("This computer is already hosting sync for Repo. Nothing was stopped.")).toBeTruthy();
    });

    it("drops the notice when the window opens another project", async () => {
      const disconnectFromBrain = vi.fn(async () => {
        throw new Error("Error invoking remote method 'ade.sync.disconnectFromBrain': Error: This project is the sync brain, so it has no brain to disconnect from. Its devices and cluster record are kept.");
      });
      (globalThis.window as any).ade = { sync: { disconnectFromBrain, getStatus: async () => followerStatus() } };
      render(<ThisMacCard sync={makeSync({ status: followerStatus(), projectStatus: followerStatus() })} sessionState="active" />);

      fireEvent.click(screen.getByRole("button", followerButton));
      fireEvent.click(screen.getByRole("checkbox", acknowledgement));
      fireEvent.click(screen.getByRole("button", { name: "Stop following" }));
      expect(await screen.findByText("This computer is already hosting sync for Repo. Nothing was stopped.")).toBeTruthy();

      act(() => {
        useAppStore.setState({ project: { rootPath: "/other", displayName: "Other", baseRef: "main" } as any });
      });
      await waitFor(() => expect(screen.queryByText(/This computer is already hosting sync/)).toBeNull());
    });

    it("shows the reason when the disconnect fails and keeps the button for another try", async () => {
      const disconnectFromBrain = vi.fn(async () => {
        throw new Error("Project is switching. Wait for the current project to finish loading before stopping sync.");
      });
      (globalThis.window as any).ade = { sync: { disconnectFromBrain, getStatus: async () => followerStatus() } };
      render(<ThisMacCard sync={makeSync({ status: followerStatus(), projectStatus: followerStatus() })} sessionState="active" />);

      fireEvent.click(screen.getByRole("button", followerButton));
      fireEvent.click(screen.getByRole("checkbox", acknowledgement));
      fireEvent.click(screen.getByRole("button", { name: "Stop following" }));

      expect(await screen.findByText(/Project is switching/)).toBeTruthy();
      expect(screen.getByRole("button", followerButton)).toBeTruthy();
    });

    it("shows the project's own message, not the IPC wrapper around it", async () => {
      const disconnectFromBrain = vi.fn(async () => {
        throw new Error("Error invoking remote method 'ade.sync.disconnectFromBrain': Error: This project isn't loaded yet. Open it and try again.");
      });
      (globalThis.window as any).ade = { sync: { disconnectFromBrain, getStatus: async () => followerStatus() } };
      render(<ThisMacCard sync={makeSync({ status: followerStatus(), projectStatus: followerStatus() })} sessionState="active" />);

      fireEvent.click(screen.getByRole("button", followerButton));
      fireEvent.click(screen.getByRole("checkbox", acknowledgement));
      fireEvent.click(screen.getByRole("button", { name: "Stop following" }));

      expect(await screen.findByText("This project isn't loaded yet. Open it and try again.")).toBeTruthy();
      expect(screen.queryByText(/Error invoking remote method/)).toBeNull();
    });
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

  beforeEach(() => {
    // The local-status reader is a module singleton (coalescing + backoff);
    // each test needs it cold or a prior failure's backoff window suppresses
    // the next test's read.
    resetLocalSyncStatusReaderForTests();
  });

  afterEach(() => {
    resetLocalSyncStatusReaderForTests();
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

  it("keeps the project's routed status apart from the machine's", async () => {
    // The machine hosts, while the window's project follows another machine.
    const machine = makeStatus();
    const project = makeStatus({ mode: "viewer", role: "viewer", runtimeRole: "viewer", viewerReason: "saved_connection" });
    installSyncMock({
      getStatus: async () => project,
      getLocalStatus: async () => machine,
      listDevices: async () => [device()],
    });

    const { result } = renderHook(() => useSyncConnections());
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.status?.role).toBe("brain");
    expect(result.current.projectStatus?.role).toBe("viewer");
  });

  it("forces the initial load through an existing backoff window", async () => {
    const degraded = makeStatus({ degradedReason: "The ADE background service is not reachable." });
    const healthy = makeStatus();
    let localCalls = 0;
    installSyncMock({
      getStatus: async () => healthy,
      getLocalStatus: async () => {
        localCalls += 1;
        return localCalls === 1 ? degraded : healthy;
      },
      listDevices: async () => [device()],
    });
    // Someone else already read a degraded snapshot, so the shared reader is
    // backed off and would replay it to an unforced caller.
    await readLocalSyncStatus();

    const { result } = renderHook(() => useSyncConnections());
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Opening Connections is user intent: a real read, not the cached failure.
    expect(window.ade.sync.getLocalStatus).toHaveBeenCalledTimes(2);
    expect(result.current.status?.degradedReason).toBeUndefined();
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
    // The first refresh hangs on its ROUTED read; its local read has already
    // resolved. A second refresh then fails locally. When the first refresh
    // finally completes, its older local answer must not resurrect the card.
    let resolveOldRouted!: (status: SyncRoleSnapshot) => void;
    const oldRoutedResult = new Promise<SyncRoleSnapshot>((resolve) => {
      resolveOldRouted = resolve;
    });
    let statusCalls = 0;
    let localCalls = 0;
    installSyncMock({
      getStatus: async () => (++statusCalls === 1 ? await oldRoutedResult : remote),
      getLocalStatus: async () => {
        localCalls += 1;
        if (localCalls === 1) return oldLocal;
        throw new Error("local status unavailable");
      },
      listDevices: async () => [device({ deviceId: "remote-phone", name: "Remote iPhone" })],
    });

    const { result } = renderHook(() => useSyncConnections());
    await waitFor(() => expect(window.ade.sync.getLocalStatus).toHaveBeenCalledTimes(1));
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(result.current.error).toBe("local status unavailable"));

    await act(async () => {
      resolveOldRouted(oldLocal);
      await oldRoutedResult;
    });

    expect(result.current.status).toBeNull();
    expect(result.current.devices).toEqual([]);
    expect(result.current.canManageDevices).toBe(false);
  });
});

describe("accountDirectorySummary", () => {
  it("keeps an unreadable session distinct from signed out", () => {
    const status = { pairingPinConfigured: true } as SyncRoleSnapshot;
    expect(accountDirectorySummary(status, "unreadable", null)).toEqual({
      label: "Your session is still there — open your account to fix it",
      healthy: false,
    });
  });

  it("uses one signed-out line whether a pairing code is set or not", () => {
    const status = { pairingPinConfigured: false } as SyncRoleSnapshot;

    expect(accountDirectorySummary(status, "signed_out", null)).toEqual({
      label: "Not signed in — you can still connect to other machines manually",
      healthy: false,
    });

    status.pairingPinConfigured = true;
    expect(accountDirectorySummary(status, "signed_out", null)).toEqual({
      label: "Not signed in — you can still connect to other machines manually",
      healthy: false,
    });
  });

  const summaryForState = (
    state: SyncRoleSnapshot["routeHealth"]["accountDirectory"]["state"],
    skipReason: string | null,
  ) =>
    accountDirectorySummary(
      {
        routeHealth: {
          accountDirectory: { state, skipReason, reachableEndpointCount: 0 },
        },
      } as SyncRoleSnapshot,
      "active",
      null,
    );

  it("never leaks the publisher's internal skipReason into user copy", () => {
    // The regression: a real user was shown "Signed in, but this computer is
    // not published · No active sync scope is available." — a fault report with
    // no action in it.
    const summary = summaryForState(
      "no_active_sync_scope",
      "No active sync scope is available.",
    );
    expect(summary.healthy).toBe(false);
    expect(summary.label).not.toContain("No active sync scope is available.");
    // NOT "open a project". A brain with no project registered now publishes on
    // its own, so the only remaining way to reach this state is another ADE
    // process on this computer holding the machine-wide sync-host lease.
    expect(summary.label).toBe(
      "Signed in — another ADE app on this computer owns sync for this machine",
    );
    expect(summary.label).not.toContain("open a project");
  });

  it("names the owning ADE app and pid, and adds the one line that ends it", () => {
    // The second ADE on a Mac cannot host sync while the first is running. Naming
    // the owner is the whole point: "another ADE app" is not something a person
    // can act on, and the pid disambiguates two ADE builds with one name.
    const summary = summaryForState(
      "no_active_sync_scope",
      "Another ADE app on this computer owns sync for this machine (ADE Alpha, pid 9253).",
    );
    expect(summary).toEqual({
      label:
        "Signed in — another ADE app on this computer owns sync for this machine (ADE Alpha, pid 9253)",
      healthy: false,
      detail: "Quit that ADE to let this one host sync.",
    });
  });

  it("gives each actionable publish state its own instruction", () => {
    expect(summaryForState("account_signed_out", "The ADE brain is signed out.").label).toBe(
      "Signed in — the ADE background service is signed out",
    );
    expect(summaryForState("machine_key_unavailable", null).label).toBe(
      "Signed in — this computer isn't registered yet",
    );
    expect(summaryForState("http_error", null).label).toBe(
      "Signed in — can't reach your ADE account right now, retrying",
    );
  });

  it("names an answered refusal instead of claiming the directory is unreachable", () => {
    const summaryForRefusal = (lastHttpReason: string) => {
      const status = {
        routeHealth: {
          accountDirectory: {
            state: "http_error",
            skipReason: null,
            reachableEndpointCount: 0,
            lastHttpStatus: 403,
            lastHttpReason,
          },
        },
      } as SyncRoleSnapshot;
      return accountDirectorySummary(
        status,
        "active",
        readThisMachineRefusal(status.routeHealth?.accountDirectory),
      );
    };

    expect(summaryForRefusal("machine_revoked").label).toBe(
      "This computer was removed from your account",
    );
    expect(summaryForRefusal("pairing_authentication_required").label).toBe(
      "This computer needs you to confirm it's you before it can rejoin your account",
    );
  });

  it("names a refusal instead of calling it a retry, and only for this computer", () => {
    const status = {
      routeHealth: {
        accountDirectory: {
          state: "http_error",
          skipReason: null,
          reachableEndpointCount: 0,
          lastHttpStatus: 403,
          lastHttpReason: "machine_revoked",
          revokedAt: null,
        },
      },
    } as unknown as SyncRoleSnapshot;
    const refusal = readThisMachineRefusal(status.routeHealth?.accountDirectory);
    expect(refusal).not.toBeNull();
    expect(accountDirectorySummary(status, "active", refusal).label).toBe(
      "This computer was removed from your account",
    );
    // A remote-bound pane shows another machine's snapshot, so its caller
    // passes no refusal.
    expect(accountDirectorySummary(status, "active", null).label).toBe(
      "Signed in — can't reach your ADE account right now, retrying",
    );
  });

  it("never calls sync off while it is still trying to start", () => {
    // The regression: a brain whose sync host was failing and retrying reported
    // the same state as a brain with sync switched off, so the pane told the
    // user sync was off and sent them looking for a switch already on.
    const label = summaryForState("sync_not_started", "Account-directory publishing has not started.").label;
    expect(label).toBe("Signed in — other devices can't reach this computer yet");
    expect(label).not.toContain("off");
  });

  it("falls back without a raw state string or a claim of permanence", () => {
    const label = summaryForState("snapshot_failed", "Snapshot build failed: EPERM").label;
    expect(label).toBe("Signed in — this computer isn't published yet");
    expect(label).not.toContain("snapshot_failed");
    expect(label).not.toContain("snapshot failed");
    expect(label).not.toContain("EPERM");
  });

  it("survives a publish state this build's union does not carry", () => {
    // A brain newer than this window can name a state this build never heard
    // of. The shared advice table's switch is exhaustive over the union only,
    // so it returns undefined for anything else — and the destructure used to
    // throw a TypeError that blanked the whole Connections pane.
    const summary = summaryForState(
      "a_state_from_a_newer_brain" as SyncRoleSnapshot["routeHealth"]["accountDirectory"]["state"],
      null,
    );
    expect(summary.healthy).toBe(false);
    expect(summary.label).toBe("Signed in — sync state isn't available on this computer yet");
    expect(summary.label).not.toContain("a_state_from_a_newer_brain");
  });

  it("keeps every unpublished state free of underscores and skipReason text", () => {
    const states = [
      "sync_disabled",
      "sync_not_started",
      "no_active_sync_scope",
      "snapshot_failed",
      "machine_key_unavailable",
      "missing_pairing_connect_info",
      "not_host",
      "account_signed_out",
      "token_unreadable",
      "invalid_directory_url",
      "http_error",
      "token_timeout",
      "http_timeout",
      "timeout",
      "transport_error",
    ] as const;
    for (const state of states) {
      const { label, healthy } = summaryForState(state, "INTERNAL DIAGNOSTIC STRING");
      expect(healthy).toBe(false);
      expect(label).not.toContain("INTERNAL DIAGNOSTIC STRING");
      expect(label).not.toContain("_");
    }
  });
});
