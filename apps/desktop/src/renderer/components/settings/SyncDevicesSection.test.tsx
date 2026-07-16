/* @vitest-environment jsdom */

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SyncDevicesSection } from "./SyncDevicesSection";
import { LOCAL_RELEASE_BUILD_OUTPUT_RUNTIME_MESSAGE } from "../../../shared/runtimeErrors";

const originalAde = (globalThis.window as any)?.ade;

function makeHostSnapshot(overrides: Record<string, unknown> = {}) {
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
    client: { state: "disconnected" },
    transferReadiness: { ready: true, blockers: [], survivableState: [] },
    survivableStateText: "",
    blockingStateText: "",
    ...overrides,
  };
}

function installAdeMock(snapshot: Record<string, unknown>) {
  const setPin = vi.fn(async (pin: string) => ({
    ...snapshot,
    pairingPin: pin,
    pairingPinConfigured: true,
  }));
  const writeClipboardText = vi.fn(async (_text: string) => undefined);
  (globalThis.window as any).ade = {
    app: { writeClipboardText },
    sync: {
      getStatus: vi.fn(async () => snapshot),
      listDevices: vi.fn(async () => []),
      getCloudRelayStatus: vi.fn(async () => null),
      onEvent: vi.fn(() => () => {}),
      setPin,
      generatePin: vi.fn(async () => snapshot),
      clearPin: vi.fn(async () => undefined),
      setCloudRelayEnabled: vi.fn(async () => null),
      setRuntimeName: vi.fn(async () => undefined),
      clearRuntimeName: vi.fn(async () => undefined),
      updateLocalDevice: vi.fn(async () => undefined),
      forgetDevice: vi.fn(async () => undefined),
      refreshDiscovery: vi.fn(async () => snapshot),
    },
  };
  return { setPin, writeClipboardText };
}

describe("SyncDevicesSection", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (originalAde === undefined) {
      delete (globalThis.window as any).ade;
    } else {
      (globalThis.window as any).ade = originalAde;
    }
  });

  it("web variant shows the hidden-PIN generate control and calls setPin with a 6-digit PIN", async () => {
    const { setPin } = installAdeMock(makeHostSnapshot());
    vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation((array) => {
      (array as Uint32Array)[0] = 0;
      return array;
    });
    render(<SyncDevicesSection variant="web" />);

    const generate = await screen.findByRole("button", { name: "Generate new PIN" });
    expect(generate).toBeTruthy();
    expect(screen.getByText("Existing PIN still pairs if you know it.")).toBeTruthy();
    // Hidden PIN renders masked digits, never a real value.
    expect(screen.getByText("••••••")).toBeTruthy();

    fireEvent.click(generate);

    await waitFor(() => expect(setPin).toHaveBeenCalledTimes(1));
    const pinArg = setPin.mock.calls[0][0];
    expect(pinArg).toMatch(/^\d{6}$/);
    expect(pinArg).toBe("000000");
  });

  it("web variant renders the web clients list but not phone pairing", async () => {
    installAdeMock(makeHostSnapshot());
    render(<SyncDevicesSection variant="web" />);

    expect(await screen.findByText("Web client")).toBeTruthy();
    expect(screen.getByText("Web clients")).toBeTruthy();
    expect(screen.queryByText("Pair a phone")).toBeNull();
    expect(screen.queryByText("Phones")).toBeNull();
  });

  it("phone variant renders phone pairing but not the web client card", async () => {
    installAdeMock(makeHostSnapshot());
    render(<SyncDevicesSection variant="phone" />);

    expect(await screen.findByText("Connect a phone")).toBeTruthy();
    expect(screen.getByText("Phones")).toBeTruthy();
    expect(screen.queryByText("Web client")).toBeNull();
    expect(screen.queryByText("Web clients")).toBeNull();
  });

  it("shows Copied feedback after copying a visible pairing code", async () => {
    const { writeClipboardText } = installAdeMock(makeHostSnapshot({ pairingPin: "123456" }));
    render(
      <React.StrictMode>
        <SyncDevicesSection variant="web" />
      </React.StrictMode>,
    );

    const copy = await screen.findByRole("button", { name: "Copy code" });
    fireEvent.click(copy);

    await waitFor(() => expect(writeClipboardText).toHaveBeenCalledWith("123456"));
    expect(await screen.findByText("Copied")).toBeTruthy();
  });

  it("keeps web status scoped to browser peers", async () => {
    installAdeMock(makeHostSnapshot({
      connectedPeers: [
        { deviceId: "phone-1", deviceName: "Phone", platform: "iOS", deviceType: "phone" },
      ],
    }));
    render(<SyncDevicesSection variant="web" />);

    expect(await screen.findByText("Ready - no web clients connected")).toBeTruthy();
    expect(screen.queryByText("Connected")).toBeNull();
  });

  it("keeps the default all variant unchanged", async () => {
    installAdeMock(makeHostSnapshot());
    render(<SyncDevicesSection />);

    expect(await screen.findByText("Connect a phone")).toBeTruthy();
    expect(screen.getByText("Web client")).toBeTruthy();
    expect(screen.getByText("Phones")).toBeTruthy();
    expect(screen.getByText("Web clients")).toBeTruthy();
  });

  it("closes only the enlarged QR on Escape", async () => {
    const parentEscape = vi.fn();
    installAdeMock(makeHostSnapshot());
    render(
      <div onKeyDown={(event) => {
        if (event.key === "Escape") parentEscape();
      }}>
        <SyncDevicesSection variant="web" />
      </div>,
    );

    fireEvent.click(await screen.findByTitle("Click to enlarge"));
    const dialog = await screen.findByRole("dialog", { name: "Web client pairing QR code" });
    expect(dialog.closest("body")).toBe(document.body);

    fireEvent.keyDown(dialog, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Web client pairing QR code" })).toBeNull();
    });
    expect(parentEscape).not.toHaveBeenCalled();
    expect(screen.getByText("Web client")).toBeTruthy();
  });

  it("restarts copy feedback timers on repeated copies", async () => {
    installAdeMock(makeHostSnapshot({ pairingPin: "123456" }));
    render(<SyncDevicesSection variant="web" />);
    const copy = await screen.findByRole("button", { name: "Copy code" });

    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(copy);
      await Promise.resolve();
    });
    expect(screen.getByText("Copied")).toBeTruthy();

    act(() => vi.advanceTimersByTime(1_000));
    await act(async () => {
      fireEvent.click(copy);
      await Promise.resolve();
    });
    act(() => vi.advanceTimersByTime(600));

    expect(screen.getByText("Copied")).toBeTruthy();
  });

  it("explains how to recover when a local release build is not installed", async () => {
    installAdeMock(makeHostSnapshot());
    const getStatus = globalThis.window.ade.sync.getStatus as ReturnType<typeof vi.fn>;
    getStatus.mockRejectedValue(new Error(LOCAL_RELEASE_BUILD_OUTPUT_RUNTIME_MESSAGE));

    render(<SyncDevicesSection variant="web" />);

    expect(await screen.findByText("Couldn't load connection details")).toBeTruthy();
    expect(screen.getByText("Install this ADE build in Applications, reopen it, then try again.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("distinguishes a missing project from an unavailable sync service", async () => {
    installAdeMock(makeHostSnapshot());
    const getStatus = globalThis.window.ade.sync.getStatus as ReturnType<typeof vi.fn>;
    getStatus.mockRejectedValue(new Error("Sync service is not available."));

    const { rerender } = render(<SyncDevicesSection variant="web" />);

    expect(await screen.findByText("Restart ADE, then try again.")).toBeTruthy();
    expect(screen.queryByText("Open a project in ADE, then try again.")).toBeNull();

    getStatus.mockRejectedValue(new Error("Sync service is not available. Register a project first."));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    rerender(<SyncDevicesSection variant="web" />);

    expect(await screen.findByText("Open a project in ADE, then try again.")).toBeTruthy();
  });
});
