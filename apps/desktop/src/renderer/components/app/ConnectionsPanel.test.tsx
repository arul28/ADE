/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ConnectionsPanel } from "./ConnectionsPanel";
import type {
  RemoteRuntimeConnectionSnapshot,
  SyncDeviceRuntimeState,
} from "../../../shared/types";

// The panel's per-tab dots derive from the sync device list and the remote
// runtime connection snapshot. We stub the heavy child surfaces and drive those
// two data sources directly.
const syncRef = { current: { devices: [] as SyncDeviceRuntimeState[] } };
const snapshotRef = { current: { connections: [], connectedCount: 0, updatedAt: 0 } as RemoteRuntimeConnectionSnapshot };

vi.mock("../settings/SyncDevicesSection", () => ({
  useSyncConnections: () => syncRef.current,
  ThisMacCard: () => null,
  PhoneConnectionsTab: () => null,
  WebConnectionsTab: () => null,
}));

vi.mock("../remoteTargets/RemoteTargetList", () => ({
  RemoteTargetList: () => null,
}));

vi.mock("../../lib/account", async () => {
  const actual = await vi.importActual<typeof import("../../lib/account")>("../../lib/account");
  return {
    ...actual,
    useAccountStatus: () => ({
      status: { ...actual.SIGNED_OUT_ACCOUNT, signedIn: true, email: "ada@example.com" },
      loading: false,
      refresh: vi.fn(),
    }),
  };
});

function device(overrides: Partial<SyncDeviceRuntimeState>): SyncDeviceRuntimeState {
  return {
    deviceId: "d1",
    name: "Device",
    platform: "iOS",
    deviceType: "phone",
    connectionState: "connected",
    isLocal: false,
    latencyMs: 10,
    lastSeenAt: null,
    ...overrides,
  } as SyncDeviceRuntimeState;
}

function renderPanel() {
  return render(
    <MemoryRouter>
      <ConnectionsPanel onClose={vi.fn()} />
    </MemoryRouter>,
  );
}

describe("ConnectionsPanel tab dots", () => {
  const originalAde = window.ade;

  beforeEach(() => {
    syncRef.current = { devices: [] };
    snapshotRef.current = { connections: [], connectedCount: 0, updatedAt: 0 };
    window.ade = {
      github: { getStatus: vi.fn(async () => ({ connected: false })) },
      remoteRuntime: {
        getConnectionSnapshot: vi.fn(async () => snapshotRef.current),
        onConnectionSnapshotChanged: vi.fn(() => () => {}),
      },
      account: {
        listMachines: vi.fn(async () => ({ state: "ok", machines: [], message: null })),
      },
    } as unknown as typeof window.ade;
  });

  afterEach(() => {
    cleanup();
    window.ade = originalAde;
  });

  it("shows no dots when nothing is connected", async () => {
    renderPanel();
    await waitFor(() => expect(window.ade.remoteRuntime.getConnectionSnapshot).toHaveBeenCalled());

    for (const label of ["Machines", "Phone", "Web"]) {
      const tab = screen.getByRole("tab", { name: new RegExp(label) });
      expect(within(tab).queryByTitle("Active connection")).toBeNull();
    }
  });

  it("dots each tab that has an active connection", async () => {
    syncRef.current = {
      devices: [
        device({ deviceId: "phone-1", deviceType: "phone", connectionState: "connected" }),
        device({ deviceId: "browser-1", deviceType: "browser", connectionState: "connected" }),
      ],
    };
    snapshotRef.current = { connections: [], connectedCount: 1, updatedAt: 0 };

    renderPanel();

    await waitFor(() => {
      const machines = screen.getByRole("tab", { name: /Machines/ });
      expect(within(machines).queryByTitle("Active connection")).toBeTruthy();
    });
    expect(within(screen.getByRole("tab", { name: /Phone/ })).getByTitle("Active connection")).toBeTruthy();
    expect(within(screen.getByRole("tab", { name: /Web/ })).getByTitle("Active connection")).toBeTruthy();
  });

  it("ignores disconnected or local peers when lighting the Phone dot", async () => {
    syncRef.current = {
      devices: [
        device({ deviceId: "phone-1", deviceType: "phone", connectionState: "disconnected" }),
        device({ deviceId: "phone-local", deviceType: "phone", connectionState: "connected", isLocal: true }),
      ],
    };
    renderPanel();
    await waitFor(() => expect(window.ade.remoteRuntime.getConnectionSnapshot).toHaveBeenCalled());

    expect(within(screen.getByRole("tab", { name: /Phone/ })).queryByTitle("Active connection")).toBeNull();
  });
});
