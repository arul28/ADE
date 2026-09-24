// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WebConnectionsChip,
  WEB_OPEN_CONNECTIONS_EVENT,
} from "../WebConnectionsChip";
import { WebWorkspaceProvider } from "../WebWorkspaceContext";
import { confirmDialog } from "../../../components/ui/dialog/confirm";

vi.mock("../../../components/ui/dialog/confirm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../components/ui/dialog/confirm")>()),
  confirmDialog: vi.fn(async () => false),
}));

const RELAY = "wss://ade-tunnel-relay.arulsharma1028.workers.dev";

function machine(
  overrides: {
    machineKey: string;
    name: string;
    dialable?: boolean;
    online?: boolean;
    lastSeenAt?: number | null;
    channel?: "stable" | "beta" | "alpha" | null;
  },
) {
  const { machineKey, name, dialable = false, online = false, lastSeenAt = null, channel = null } = overrides;
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
    channel,
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

  it("tells two installs on one Mac apart and warns before removing a live one", async () => {
    const removeAccountMachine = vi.fn(async () => undefined);
    let resolveConfirm: (accepted: boolean) => void = () => {};
    const confirmation = new Promise<boolean>((resolve) => {
      resolveConfirm = resolve;
    });
    const confirm = vi.mocked(confirmDialog).mockClear().mockReturnValueOnce(confirmation);
    try {
      renderChip(
        [
          machine({ machineKey: "alpha", name: "MacBook Pro · Alpha", online: true, lastSeenAt: Date.now() - 60_000, channel: "alpha" }),
          machine({ machineKey: "stable", name: "MacBook Pro", online: true, channel: "stable" }),
        ],
        { removeAccountMachine },
      );

      openPopover();
      expect(screen.getByText("MacBook Pro · ADE Alpha")).toBeTruthy();
      expect(screen.getByText("MacBook Pro · ADE")).toBeTruthy();

      fireEvent.click(screen.getByLabelText("Manage MacBook Pro · Alpha"));
      fireEvent.click(screen.getByRole("menuitem", { name: "Remove from account" }));

      expect(confirm).toHaveBeenCalledTimes(1);
      const options = confirm.mock.calls[0]?.[0];
      expect(options?.title).toBe("Remove MacBook Pro · ADE Alpha from your ADE account?");
      expect(String(options?.message)).toContain("It was active 1 minute ago.");
      // Declined: nothing is removed.
      await act(async () => {
        resolveConfirm(false);
        await expect(confirmation).resolves.toBe(false);
      });
      expect(removeAccountMachine).not.toHaveBeenCalled();
    } finally {
      confirm.mockClear();
    }
  });

  it("confirms forgetting a browser pairing and only forgets it after acceptance", async () => {
    const environment = pairing("studio", "Mac Studio");
    const forgetEnvironment = vi.fn(async () => undefined);
    const confirm = vi.mocked(confirmDialog).mockClear().mockResolvedValue(false);
    renderChip(
      [machine({ machineKey: "studio", name: "Mac Studio", dialable: true, online: true })],
      { forgetEnvironment },
      { environments: [environment] },
    );

    openPopover();
    fireEvent.click(screen.getByLabelText("Manage Mac Studio"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Forget on this browser" }));

    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(confirm.mock.calls[0]?.[0]).toMatchObject({
      title: "Forget Mac Studio on this browser?",
      confirmLabel: "Forget",
      destructive: true,
    });
    expect(forgetEnvironment).not.toHaveBeenCalled();

    confirm.mockResolvedValueOnce(true);
    fireEvent.click(screen.getByLabelText("Manage Mac Studio"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Forget on this browser" }));

    await waitFor(() => expect(forgetEnvironment).toHaveBeenCalledWith(environment.envId));
  });

  it("stays open while the user works in a confirm raised from its machine menu", async () => {
    renderChip([
      machine({ machineKey: "studio", name: "Mac Studio", dialable: true, online: true }),
    ]);
    openPopover();
    const popover = await screen.findByRole("dialog");
    // The confirm renders in its own body portal, outside the popover.
    const confirm = document.createElement("div");
    confirm.setAttribute("role", "alertdialog");
    const button = document.createElement("button");
    confirm.appendChild(button);
    document.body.appendChild(confirm);
    try {
      fireEvent.pointerDown(button);
      fireEvent.keyDown(button, { key: "Escape" });
      expect(popover.isConnected).toBe(true);

      // Escape inside the popover itself (also a role="dialog") still closes it.
      fireEvent.keyDown(popover, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

      openPopover();
      await screen.findByRole("dialog");
      fireEvent.pointerDown(document.body);
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    } finally {
      confirm.remove();
    }
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

  it("portals the popover to document.body, out of the header's clipped strip", async () => {
    // Regression: the header's trailing strip is overflow-hidden so it clips
    // instead of sliding under the Windows caption buttons. Rendered inline,
    // the popover opened INSIDE that strip — present in the DOM, styled
    // visible, and completely clipped away, with nothing in the console. The
    // desktop Connections panel escapes through a body portal; the chip's
    // popover must do the same, and this is the one assertion jsdom can make
    // about it (it cannot see CSS clipping).
    renderChip([
      machine({ machineKey: "studio", name: "Mac Studio", dialable: true, online: true }),
    ]);

    openPopover();
    const popover = await screen.findByRole("dialog");
    const viewportHost = popover.parentElement;
    expect(viewportHost?.parentElement).toBe(document.body);
    expect(viewportHost?.style.position).toBe("fixed");
    expect(viewportHost?.style.pointerEvents).toBe("none");
    expect(viewportHost?.style.zIndex).toBe("100");
  });

  it("labels a leftover pairing as remembered in this browser", () => {
    const environment = pairing("alpha", "windows alpha");
    renderChip(
      [machine({ machineKey: "studio", name: "Mac Studio", dialable: true, online: true })],
      {},
      {
        environments: [environment],
        sessions: [{
          targetId: environment.envId,
          environment,
          status: { state: "reconnecting" },
          state: "reconnecting",
          projects: [],
          lastUsedAt: Date.now(),
          activeProjectId: null,
          error: null,
        }],
      },
    );

    openPopover();
    expect(screen.getByText("Remembered in this browser · Reconnecting…")).toBeTruthy();
    expect(screen.getByText("1 on this account · 1 remembered in this browser")).toBeTruthy();
    expect(screen.queryByText("All four browser machine sessions")).toBeNull();
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
