/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  SyncDeviceRuntimeState,
  SyncRoleSnapshot,
} from "../../../shared/types";
import {
  PhoneConnectionsTab,
  ThisMacCard,
  WebConnectionsTab,
  type SyncConnections,
} from "./SyncDevicesSection";

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
    routeHealth: {} as SyncRoleSnapshot["routeHealth"],
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
    setPinValue: vi.fn(async () => {}),
    generatePin: vi.fn(),
    clearPin: vi.fn(),
    saveRuntimeName: vi.fn(),
    forgetDevice: vi.fn(),
    retryInitialLoad: vi.fn(),
    ...overrides,
  } as SyncConnections;
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
    expect(screen.getByText("Connected to your ADE account")).toBeTruthy();
    expect(screen.getByText("Ready to accept connections")).toBeTruthy();
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
});

describe("PhoneConnectionsTab", () => {
  afterEach(() => cleanup());

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
});
