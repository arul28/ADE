// @vitest-environment jsdom
import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { ProjectWelcomePage } from "./ProjectWelcomePage";
import { WebWorkspaceProvider } from "../../webclient/workspace/WebWorkspaceContext";
import type { BrowserAccountSnapshot } from "../../webclient/account/client";
import { useAppStore } from "../../state/appStore";
import type { ProjectPathInspection, RecentProjectSummary } from "../../../shared/types";
import {
  dismissToast,
  getToasts,
} from "../app/toast/toastStore";

const navigateSpy = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual<typeof import("react-router-dom")>(
    "react-router-dom",
  );
  return { ...actual, useNavigate: () => navigateSpy };
});

// The project-browser CommandPalette is heavy and irrelevant here.
vi.mock("../app/CommandPalette", () => ({
  CommandPalette: () => null,
}));

const listRecent = vi.fn();
const resolveIcon = vi.fn(async () => ({
  dataUrl: null,
  sourcePath: null,
  mimeType: null,
}));
const forgetRecent = vi.fn(async () => [] as RecentProjectSummary[]);
const inspectPath = vi.fn();
const listLanes = vi.fn();
const switchProjectToPath = vi.fn(async () => {});

const WORKTREE_ROOT = "/repos/app-feature";

const worktreeRecent: RecentProjectSummary = {
  rootPath: WORKTREE_ROOT,
  displayName: "app-feature",
  lastOpenedAt: "2026-05-08T00:00:00.000Z",
  exists: true,
  worktreeOf: { rootPath: "/repos/app", displayName: "app" },
  laneCount: 0,
};

function inspection(
  overrides: Partial<ProjectPathInspection> = {},
): ProjectPathInspection {
  return {
    inputPath: WORKTREE_ROOT,
    worktreeRoot: WORKTREE_ROOT,
    kind: "linked-worktree",
    branchRef: "feature/x",
    parent: {
      rootPath: "/repos/app",
      displayName: "app",
      isKnownAdeProject: true,
      existingLane: null,
    },
    standaloneState: { chatCount: 2, laneCount: 1 },
    ...overrides,
  };
}

/** What `inspectPath` reports once the owning project is open: the worktree
 *  is registered as a lane, so `openWorktreeAsLane` has somewhere to navigate. */
function mergedInspection(): ProjectPathInspection {
  return inspection({
    parent: {
      rootPath: "/repos/app",
      displayName: "app",
      isKnownAdeProject: true,
      existingLane: {
        id: "lane-merged",
        name: "feature/x",
        branchRef: "feature/x",
        color: null,
        laneType: "worktree",
      },
    },
  });
}

beforeEach(() => {
  for (const toast of getToasts()) dismissToast(toast.id);
  navigateSpy.mockReset();
  listRecent.mockReset();
  listRecent.mockResolvedValue([worktreeRecent]);
  forgetRecent.mockReset();
  forgetRecent.mockResolvedValue([]);
  inspectPath.mockReset();
  inspectPath.mockResolvedValue(inspection());
  listLanes.mockReset();
  listLanes.mockResolvedValue([]);
  switchProjectToPath.mockReset();
  switchProjectToPath.mockResolvedValue(undefined);

  (globalThis.window as any).ade = {
    project: { listRecent, resolveIcon, forgetRecent, inspectPath },
    lanes: {
      list: listLanes,
      onLifecycleEvent: vi.fn(() => vi.fn()),
      onProxyEvent: vi.fn(() => vi.fn()),
      onPortEvent: vi.fn(() => vi.fn()),
      onDiagnosticsEvent: vi.fn(() => vi.fn()),
    },
    app: { openExternal: vi.fn(), writeClipboardText: vi.fn() },
    remoteRuntime: {
      getConnectionSnapshot: vi.fn(async () => ({
        connections: [],
        connectedCount: 0,
        updatedAt: Date.now(),
      })),
      onConnectionSnapshotChanged: vi.fn(() => vi.fn()),
    },
  };

  useAppStore.setState({
    showWelcome: true,
    project: null,
    lanes: [],
    switchProjectToPath: switchProjectToPath as any,
  } as any);
});

afterEach(() => {
  cleanup();
  delete (globalThis.window as any).__adeWebClient;
});

function renderWelcome() {
  return render(
    <MemoryRouter>
      <ProjectWelcomePage />
    </MemoryRouter>,
  );
}

function accountSnapshot(
  overrides: Partial<BrowserAccountSnapshot> = {},
): BrowserAccountSnapshot {
  return {
    state: "signed_in",
    userId: "user_1",
    email: "dev@ade-app.dev",
    name: "Dev",
    imageUrl: null,
    expiresAt: null,
    machines: [],
    relayBaseUrls: [],
    message: null,
    ...overrides,
  };
}

function accountMachine(name = "Mac Studio") {
  return {
    machineKey: "machine-1",
    deviceId: "device-1",
    name,
    customName: null,
    platform: "darwin",
    deviceType: "desktop",
    pubkey: null,
    reachableEndpoints: [],
    lastSeenAt: Date.now(),
    online: true,
  };
}

function renderWebWelcome(
  account: BrowserAccountSnapshot,
  overrides: {
    directoryLoading?: boolean;
    catalogs?: unknown[];
    connectMachineEntry?: (...args: unknown[]) => unknown;
  } = {},
) {
  (globalThis.window as any).__adeWebClient = true;
  const retryDirectory = vi.fn(async () => {});
  const signIn = vi.fn();
  const workspace = {
    account,
    snapshot: {
      sessions: [],
      environments: [],
      activeTargetId: null,
      catalogs: overrides.catalogs ?? [],
      lastActiveMachineKey: null,
      updatedAt: 0,
    },
    manager: {} as any,
    adapter: {
      getActiveBinding: () => null,
      activateHub: vi.fn(),
    } as any,
    connectingMachineKey: null,
    directoryLoading: overrides.directoryLoading ?? false,
    notice: null,
    dismissNotice: vi.fn(),
    consumePendingProjectPath: () => null,
    signIn,
    signOut: vi.fn(async () => {}),
    retryDirectory,
    connectAccountMachine: vi.fn(),
    connectEnvironment: vi.fn(),
    connectMachineEntry: overrides.connectMachineEntry ?? vi.fn(),
    forgetMachineCatalog: vi.fn(),
    renameMachine: vi.fn(),
    removeAccountMachine: vi.fn(),
    forgetEnvironment: vi.fn(),
  } as any;
  const result = render(
    <MemoryRouter>
      <WebWorkspaceProvider value={workspace}>
        <ProjectWelcomePage />
      </WebWorkspaceProvider>
    </MemoryRouter>,
  );
  return { ...result, retryDirectory, signIn };
}

describe("ProjectWelcomePage worktree recents", () => {
  it("renders a worktree chip and a merge action for a worktree recent", async () => {
    renderWelcome();

    expect(await screen.findByText("app-feature")).toBeTruthy();
    expect(screen.getByText("worktree of app")).toBeTruthy();
    expect(
      screen.getByLabelText("Merge into app as a lane…"),
    ).toBeTruthy();
  });

  it("merge confirm forgets the recent and navigates to the auto-registered lane", async () => {
    inspectPath.mockResolvedValueOnce(inspection());
    inspectPath.mockResolvedValueOnce(mergedInspection());
    renderWelcome();

    await screen.findByText("app-feature");
    fireEvent.click(screen.getByLabelText("Merge into app as a lane…"));

    // Dialog fetches fresh inspection, then confirm.
    const confirm = await screen.findByText("Merge into app");
    await waitFor(() =>
      expect(inspectPath).toHaveBeenCalledWith(WORKTREE_ROOT, { fresh: true }),
    );
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(forgetRecent).toHaveBeenCalledWith(WORKTREE_ROOT),
    );
    await waitFor(() =>
      expect(navigateSpy).toHaveBeenCalledWith(
        "/lanes?laneId=lane-merged&focus=single",
      ),
    );
  });

  it("surfaces a post-switch merge failure through a persistent toast", async () => {
    inspectPath.mockResolvedValueOnce(inspection());
    inspectPath.mockRejectedValueOnce(new Error("merge broke"));
    renderWelcome();

    await screen.findByText("app-feature");
    fireEvent.click(screen.getByLabelText("Merge into app as a lane…"));
    const confirm = await screen.findByText("Merge into app");
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(getToasts().at(-1)).toMatchObject({
        title: "Merge failed",
        message: "merge broke",
        tone: "error",
        durationMs: 0,
      }),
    );
  });

  it("still lands on the lane when retiring the recents row fails after the merge", async () => {
    inspectPath.mockResolvedValueOnce(inspection());
    inspectPath.mockResolvedValueOnce(mergedInspection());
    forgetRecent.mockRejectedValueOnce(new Error("forget failed"));
    renderWelcome();

    await screen.findByText("app-feature");
    fireEvent.click(screen.getByLabelText("Merge into app as a lane…"));
    const confirm = await screen.findByText("Merge into app");
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(navigateSpy).toHaveBeenCalledWith(
        "/lanes?laneId=lane-merged&focus=single",
      ),
    );
    expect(getToasts().some((toast) => toast.title === "Merge failed")).toBe(false);
  });
});

describe("ProjectWelcomePage web zero-machines state", () => {
  it("claims an empty account only when the directory read succeeded", async () => {
    renderWebWelcome(accountSnapshot({ state: "signed_in" }));

    expect(
      await screen.findByText(/No Macs on this account yet/),
    ).toBeTruthy();
    expect(screen.queryByText("Retry")).toBeNull();
  });

  it("says the machines could not be loaded, with the directory reason, when the read failed", async () => {
    const { retryDirectory } = renderWebWelcome(
      accountSnapshot({
        state: "directory_unavailable",
        message: "Machine directory returned 403.",
      }),
    );

    expect(await screen.findByText("Couldn't load your machines.")).toBeTruthy();
    expect(screen.getByText("Machine directory returned 403.")).toBeTruthy();
    expect(screen.queryByText(/No Macs on this account yet/)).toBeNull();

    fireEvent.click(screen.getByText("Retry"));
    await waitFor(() => expect(retryDirectory).toHaveBeenCalledTimes(1));
  });

  it("shows why a retry failed instead of leaving the stale reason up", async () => {
    const { retryDirectory } = renderWebWelcome(
      accountSnapshot({
        state: "directory_unavailable",
        message: "Machine directory returned 403.",
      }),
    );
    retryDirectory.mockRejectedValueOnce(new Error("relay refused the token"));

    fireEvent.click(await screen.findByText("Retry"));

    await waitFor(() =>
      expect(screen.getByText("relay refused the token")).toBeTruthy(),
    );
    expect(screen.queryByText("Machine directory returned 403.")).toBeNull();
  });

  it("offers sign-in instead of a retry when the session expired", async () => {
    const { signIn } = renderWebWelcome(
      accountSnapshot({
        state: "auth_expired",
        message: "Your ADE account session expired. Sign in again.",
      }),
    );

    expect(await screen.findByText("Couldn't load your machines.")).toBeTruthy();
    fireEvent.click(screen.getByText("Sign in again"));
    expect(signIn).toHaveBeenCalledTimes(1);
  });

  it("disables the retry while a directory reload is in flight", async () => {
    renderWebWelcome(
      accountSnapshot({ state: "directory_unavailable" }),
      { directoryLoading: true },
    );

    const button = await screen.findByText("Retrying…");
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("ProjectWelcomePage web Add project gating", () => {
  it("disables Add project when the account has no machine to add it on", async () => {
    renderWebWelcome(accountSnapshot({ state: "signed_in" }));

    const button = (await screen.findByText("ADD PROJECT")).closest("button");
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect((button as HTMLButtonElement).title).toContain("Connect a Mac first");
  });

  it("explains where projects are added instead of opening a flow that goes nowhere", async () => {
    renderWebWelcome(
      accountSnapshot({ state: "signed_in", machines: [accountMachine()] as any }),
    );

    const button = (await screen.findByText("ADD PROJECT")).closest("button");
    expect((button as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(button as HTMLButtonElement);

    expect(
      await screen.findByText("Projects are added on the Mac that hosts them."),
    ).toBeTruthy();
    expect(screen.getByText(/Open ADE on Mac Studio/)).toBeTruthy();

    fireEvent.click(screen.getByText("Got it"));
    await waitFor(() =>
      expect(
        screen.queryByText("Projects are added on the Mac that hosts them."),
      ).toBeNull(),
    );
  });

  it("leaves the desktop Add project flow alone", async () => {
    renderWelcome();

    const button = (await screen.findByText("ADD PROJECT")).closest("button");
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button as HTMLButtonElement);

    expect(
      screen.queryByText("Projects are added on the Mac that hosts them."),
    ).toBeNull();
  });
});

describe("ProjectWelcomePage multi-machine recents", () => {
  it("renders one card for the same Git repository on two machines", async () => {
    listRecent.mockResolvedValueOnce([
      {
        rootPath: "/Users/arul/ADE",
        displayName: "ADE",
        lastOpenedAt: "2026-07-28T12:00:00.000Z",
        exists: true,
        kind: "local",
        gitOriginUrl: "git@github.com:arul28/ADE.git",
      },
      {
        rootPath: "/Users/studio/ADE",
        displayName: "ADE",
        lastOpenedAt: "2026-07-28T11:00:00.000Z",
        exists: true,
        kind: "remote",
        gitOriginUrl: "https://github.com/arul28/ADE",
        remote: {
          targetId: "studio",
          projectId: "ade",
          runtimeName: "Mac Studio",
          hostname: "studio.local",
          gitOriginUrl: "https://github.com/arul28/ADE",
        },
      },
    ]);

    renderWelcome();

    await screen.findByText("Also on Mac Studio");
    expect(
      document.querySelectorAll('[data-tour="project.recentProject"]'),
    ).toHaveLength(1);
    expect(screen.getAllByText("ADE")).toHaveLength(1);
  });
});

/**
 * Every recents row on the hosted client belongs to some machine, and a machine
 * has one connection state. Reading the spinner off that state made one click
 * light up every card the machine owned.
 */
describe("ProjectWelcomePage web recents loading", () => {
  const catalog = {
    machineKey: "device:device-1",
    machineName: "Mac Studio",
    hostDeviceId: "device-1",
    envId: null,
    ownerUserId: "user_1",
    savedAt: Date.now(),
    projects: [
      {
        id: "ade",
        displayName: "ADE",
        rootPath: "/Users/studio/ADE",
        isAvailable: true,
        lastOpenedAt: "2026-07-28T12:00:00.000Z",
      },
      {
        id: "other",
        displayName: "Other Repo",
        rootPath: "/Users/studio/other",
        isAvailable: true,
        lastOpenedAt: "2026-07-28T11:00:00.000Z",
      },
    ],
  };

  it("spins only the card that was clicked, not every card on that machine", async () => {
    // Never resolves: the row stays mid-connect for the whole assertion.
    const connectMachineEntry = vi.fn(() => new Promise<string>(() => {}));
    renderWebWelcome(accountSnapshot({ machines: [accountMachine()] }), {
      catalogs: [catalog],
      connectMachineEntry,
    });

    const adeCard = await screen.findByText("ADE");
    fireEvent.click(adeCard);

    await waitFor(() => expect(connectMachineEntry).toHaveBeenCalledTimes(1));
    // One spinner, on one card — not one per project on Mac Studio.
    await waitFor(() => expect(screen.getAllByText("Dialing relay…")).toHaveLength(1));
    const rows = document.querySelectorAll('[data-tour="project.recentProject"]');
    expect(rows).toHaveLength(2);
    // The card that is not opening is disabled rather than spinner-labeled.
    const idle = [...rows].find((row) => !row.textContent?.includes("Dialing relay…"));
    expect(idle?.textContent).toContain("Other Repo");
    expect((idle as HTMLButtonElement).disabled).toBe(true);
  });
});
