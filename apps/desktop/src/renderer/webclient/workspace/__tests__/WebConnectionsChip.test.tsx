// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WebConnectionsChip,
  WEB_OPEN_CONNECTIONS_EVENT,
} from "../WebConnectionsChip";
import { WebWorkspaceProvider } from "../WebWorkspaceContext";

const RELAY = "wss://ade-tunnel-relay.arulsharma1028.workers.dev";

function machine(
  overrides: {
    machineKey: string;
    name: string;
    dialable?: boolean;
    online?: boolean;
    lastSeenAt?: number | null;
  },
) {
  const { machineKey, name, dialable = false, online = false, lastSeenAt = null } = overrides;
  return {
    machineKey,
    deviceId: machineKey,
    name,
    customName: null,
    platform: "darwin",
    deviceType: "desktop",
    pubkey: null,
    // A verified relay route is what makes a machine "Available" rather than
    // "Offline" (accountMachineConnectionState).
    reachableEndpoints: dialable
      ? [{ kind: "relay" as const, url: `${RELAY}/connect/${machineKey}` }]
      : [],
    lastSeenAt,
    online,
  };
}

/**
 * A browser pairing for the same Mac as `machine({ machineKey })` — they share
 * the `device:<id>` catalog key, so both fold into one row whose `envId` is
 * what a bound project tab names as its target.
 */
function pairing(hostDeviceId: string, machineName: string) {
  return {
    envId: `${hostDeviceId}-env`,
    machineName,
    hostDeviceId,
    addressCandidates: [],
    port: 0,
    pairedDeviceId: "browser",
    secret: "",
    dpopKeys: {} as any,
    siteId: "site",
    localDeviceId: "browser",
    localDeviceName: "Browser",
    createdAt: new Date().toISOString(),
  };
}

/** A held socket for that pairing — the only thing that makes a row connected. */
function liveSession(hostDeviceId: string, machineName: string, projects: number) {
  const environment = pairing(hostDeviceId, machineName);
  return {
    targetId: environment.envId,
    environment,
    status: { state: "connected" as const, readiness: "ready" as const },
    state: "live" as const,
    projects: Array.from({ length: projects }, (_, index) => ({
      projectId: `p${index}`,
      name: `Project ${index}`,
    })),
    lastUsedAt: Date.now(),
    activeProjectId: null,
    error: null,
  };
}

function renderChip(
  machines: ReturnType<typeof machine>[],
  overrides: Record<string, unknown> = {},
  snapshotOverrides: Record<string, unknown> = {},
) {
  const connectMachineEntry = vi.fn(async () => "target-1");
  const workspace = {
    account: {
      state: "signed_in",
      userId: "user_1",
      email: null,
      name: null,
      imageUrl: null,
      expiresAt: null,
      machines,
      relayBaseUrls: [],
      message: null,
    },
    snapshot: {
      sessions: [],
      environments: [],
      activeTargetId: null,
      catalogs: [],
      lastActiveMachineKey: null,
      updatedAt: 0,
      ...snapshotOverrides,
    },
    manager: {} as any,
    // The chip reads the focused tab's binding on every render; an adapter stub
    // without it only ever passed because the call site guarded a method the
    // type says is always there.
    adapter: { getActiveBinding: () => null } as any,
    connectingMachineKey: null,
    directoryLoading: false,
    notice: null,
    dismissNotice: vi.fn(),
    consumePendingProjectPath: () => null,
    signIn: vi.fn(),
    signOut: vi.fn(),
    retryDirectory: vi.fn(),
    connectAccountMachine: vi.fn(),
    connectEnvironment: vi.fn(),
    connectMachineEntry,
    forgetMachineCatalog: vi.fn(),
    renameMachine: vi.fn(),
    removeAccountMachine: vi.fn(),
    forgetEnvironment: vi.fn(),
    ...overrides,
  } as any;
  const result = render(
    <WebWorkspaceProvider value={workspace}>
      <WebConnectionsChip />
    </WebWorkspaceProvider>,
  );
  return { ...result, connectMachineEntry: workspace.connectMachineEntry };
}

function openPopover() {
  fireEvent.click(screen.getByLabelText(/^Machines,/));
}

afterEach(() => cleanup());

describe("WebConnectionsChip", () => {
  it("connects the machine when its row is clicked, then closes the popover", async () => {
    const { connectMachineEntry } = renderChip([
      machine({ machineKey: "studio", name: "Mac Studio", dialable: true, online: true }),
      machine({ machineKey: "air", name: "MacBook Air", dialable: true, online: true }),
    ]);

    openPopover();
    fireEvent.click(screen.getByLabelText("Connect to MacBook Air"));

    await waitFor(() => expect(connectMachineEntry).toHaveBeenCalledTimes(1));
    expect(connectMachineEntry.mock.calls[0][0].name).toBe("MacBook Air");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps the popover open and shows why when connecting fails", async () => {
    const connectMachineEntry = vi.fn(async () => {
      throw new Error("relay refused the token");
    });
    renderChip(
      [machine({ machineKey: "studio", name: "Mac Studio", dialable: true, online: true })],
      { connectMachineEntry },
    );

    openPopover();
    fireEvent.click(screen.getByLabelText("Connect to Mac Studio"));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "relay refused the token",
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("says Connected — the desktop's word — for a machine holding a socket", () => {
    const session = liveSession("air", "MacBook Air", 3);
    renderChip(
      [
        machine({ machineKey: "studio", name: "Mac Studio", dialable: true, online: true }),
        machine({ machineKey: "air", name: "MacBook Air", dialable: true, online: true }),
      ],
      {},
      { environments: [session.environment], sessions: [session] },
    );

    openPopover();
    // Not "Live": the connections list borrows `connectionStateLabel`'s
    // vocabulary so both apps name the same state the same way.
    expect(screen.getByText("Connected · 3 projects")).toBeTruthy();
    expect(screen.queryByText(/^Live/)).toBeNull();
    expect(screen.getByLabelText("MacBook Air, connected")).toBeTruthy();
    expect(screen.getByLabelText("Connect to Mac Studio").title).toBe(
      "Available — connects when you open a project",
    );
  });

  it("shows a short status on the row and keeps the full sentence as its tooltip", () => {
    renderChip([
      machine({ machineKey: "studio", name: "Mac Studio", dialable: true, online: true }),
    ]);

    openPopover();
    // Not the truncating "Available — connects when you open a project".
    expect(screen.getByText("Available")).toBeTruthy();
    expect(screen.getByLabelText("Connect to Mac Studio").title).toBe(
      "Available — connects when you open a project",
    );
  });

  it("reports an offline machine's last-seen instead of a bare status", () => {
    renderChip([
      machine({
        machineKey: "air",
        name: "MacBook Air",
        lastSeenAt: Date.now() - 3 * 60 * 60 * 1000,
      }),
    ]);

    openPopover();
    expect(screen.getByText("Offline · last seen 3h ago")).toBeTruthy();
  });

  it("names no machine as the app's own — the list is status, not a switcher", () => {
    renderChip([
      machine({ machineKey: "studio", name: "Mac Studio", dialable: true, online: true }),
      machine({ machineKey: "air", name: "MacBook Air" }),
    ]);

    openPopover();
    expect(document.querySelector('[data-ade-web-machine-row][aria-current]')).toBeNull();
    expect(screen.queryByText("Active")).toBeNull();
  });

  it("opens on the ade-web:open-connections event, for the tab strip's entry point", async () => {
    renderChip([
      machine({ machineKey: "studio", name: "Mac Studio", dialable: true, online: true }),
    ]);

    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent(window, new CustomEvent(WEB_OPEN_CONNECTIONS_EVENT));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByLabelText("Connect to Mac Studio")).toBeTruthy();
  });

  it("reports the focused project tab's machine, not whichever one is live", () => {
    renderChip(
      [
        machine({ machineKey: "studio", name: "Mac Studio", dialable: true, online: true }),
        machine({ machineKey: "air", name: "MacBook Air", dialable: true, online: true }),
      ],
      { adapter: { getActiveBinding: () => ({ targetId: "air-env" }) } },
      { environments: [pairing("air", "MacBook Air")] },
    );

    expect(screen.getByLabelText(/^Machines,/).textContent).toContain("MacBook Air");
  });
});
