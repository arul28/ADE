/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OpenProjectBinding } from "../../../shared/types";
import type {
  MacDesktopDisplay,
  MacDesktopEventPayload,
  MacDesktopStatus,
  MacDesktopStreamStatus,
} from "../../../shared/types/macDesktop";
import { useAppStore } from "../../state/appStore";
import { resetCrossMachineLaneSyncForTest } from "../../state/crossMachineLanes";
import { ChatMacDesktopPanel } from "./ChatMacDesktopPanel";
import { resetMacDesktopFrames } from "./macDesktopFrameStore";
import { resetMacDesktopLiveViewLeasesForTests } from "./macDesktopLiveViewLease";

/**
 * The pane's two contracts with a machine that is not this one:
 *
 *   * every call carries the focused chat's pin, and
 *   * a brain too old to have the `mac_desktop` domain says so in a sentence
 *     naming the machine and its version, not in an action-domain refusal.
 */

const STUDIO_PIN: OpenProjectBinding = {
  kind: "remote",
  key: "remote:target-studio:project-a",
  targetId: "target-studio",
  runtimeName: "Mac Studio",
  transport: "paired",
  projectId: "project-a",
  rootPath: "/repo",
  displayName: "ADE",
};

/** The controller id `macDesktopControllerId()` mints under the spy below. */
const CONTROLLER_ID = "ade-window:00000000-0000-4000-8000-000000000000";

const OLDER_ADE_ERROR = "Error invoking remote method 'ade.remoteRuntime.callAction': Error: "
  + "Remote ADE service method ade/actions/call failed (code -32602): "
  + "Domain 'mac_desktop' is unavailable in this runtime.";

function makeDisplay(): MacDesktopDisplay {
  return {
    laneId: "lane-1",
    displayId: 31,
    name: "ADE · docs-fix",
    mode: "virtual",
    width: 2560,
    height: 1440,
    scale: 1,
    origin: { x: 0, y: 0 },
    createdAt: "2026-09-18T19:00:00.000Z",
    windowCount: 0,
    lastActivityAt: "2026-09-18T19:00:00.000Z",
  };
}

function makeStatus(overrides: Partial<MacDesktopStatus> = {}): MacDesktopStatus {
  return {
    platform: "darwin",
    supported: true,
    unsupportedReason: null,
    display: makeDisplay(),
    windows: [],
    lease: null,
    stream: null,
    recording: null,
    hostIsLocal: false,
    permissions: { screenRecording: "granted", accessibility: "granted" },
    ...overrides,
  } as unknown as MacDesktopStatus;
}

function makeStreamStatus(): MacDesktopStreamStatus {
  return {
    laneId: "lane-1",
    running: false,
    idle: false,
    fps: 0,
    bitrateKbps: null,
    transport: null,
    lastError: null,
    clients: 0,
    viewerChatSessionIds: [],
  };
}

const macDesktop = {
  getStatus: vi.fn(),
  recheckPermissions: vi.fn(),
  requestPermission: vi.fn(),
  start: vi.fn(),
  onEvent: vi.fn((_cb: (event: MacDesktopEventPayload) => void, _pin?: OpenProjectBinding | null) => () => {}),
  startStream: vi.fn(async () => makeStreamStatus()),
  stopStream: vi.fn(async () => makeStreamStatus()),
  resolveStreamUrl: vi.fn(async () => ({ url: null, forwarded: false, error: "no address" })),
  takeControl: vi.fn(),
  returnControl: vi.fn(),
  renewLease: vi.fn(),
  startRecording: vi.fn(),
  stopRecording: vi.fn(),
  listWindows: vi.fn(async () => []),
  claimWindow: vi.fn(async () => undefined),
  releaseWindow: vi.fn(async () => undefined),
};

const getConnectionSnapshot = vi.fn(async () => ({
  connections: [{
    target: { id: "target-studio", name: "Mac Studio" },
    state: "connected",
    version: "1.2.74",
  }],
  updatedAt: 1,
}));
const onConnectionSnapshotChanged = vi.fn(() => () => {});

beforeEach(() => {
  resetMacDesktopFrames();
  resetMacDesktopLiveViewLeasesForTests();
  vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000000");
  for (const fn of Object.values(macDesktop)) {
    if (typeof fn === "function" && "mockClear" in fn) fn.mockClear();
  }
  macDesktop.startStream.mockResolvedValue(makeStreamStatus());
  macDesktop.resolveStreamUrl.mockResolvedValue({ url: null, forwarded: false, error: "no address" });
  macDesktop.recheckPermissions.mockResolvedValue({ screenRecording: "granted", accessibility: "granted" });
  macDesktop.requestPermission.mockResolvedValue({ screenRecording: "granted", accessibility: "granted" });
  getConnectionSnapshot.mockClear();
  onConnectionSnapshotChanged.mockClear();
  (window as unknown as { ade: unknown }).ade = {
    macDesktop,
    remoteRuntime: { getConnectionSnapshot, onConnectionSnapshotChanged },
  };
  // The retained union slices are a module singleton, so a machine seeded by
  // one test would answer the next one's `useMachineEntryForBinding`.
  resetCrossMachineLaneSyncForTest();
  useAppStore.setState({ crossMachineLanesByMachineId: {} });
});

afterEach(() => {
  cleanup();
  resetMacDesktopFrames();
  resetMacDesktopLiveViewLeasesForTests();
  vi.restoreAllMocks();
});

function renderPanel() {
  return render(
    <ChatMacDesktopPanel
      laneId="lane-1"
      laneName="docs-fix"
      sessionId="chat-1"
      runtimePin={STUDIO_PIN}
    />,
  );
}

/** A lane hosted on this computer, where a grant can actually be made. */
function renderLocalPanel() {
  return render(
    <ChatMacDesktopPanel
      laneId="lane-1"
      laneName="docs-fix"
      sessionId="chat-1"
      runtimePin={null}
    />,
  );
}

describe("ChatMacDesktopPanel against an older remote brain", () => {
  it("names the machine and its version instead of the missing action domain", async () => {
    // The machine's own name beats the binding's display name when the union
    // has a row for it.
    useAppStore.setState({
      crossMachineLanesByMachineId: {
        "target-studio": {
          machineId: "target-studio",
          machineName: "Arul's Mac Studio",
          targetId: "target-studio",
          projectId: "project-a",
          binding: STUDIO_PIN,
          online: true,
          lanes: [],
          sessions: [],
          prs: [],
          lastSyncedAtMs: null,
          lanesSyncedAtMs: null,
          error: null,
        },
      },
    });
    macDesktop.getStatus.mockRejectedValue(new Error(OLDER_ADE_ERROR));

    renderPanel();

    expect(await screen.findByText(
      "Arul's Mac Studio runs ADE 1.2.74, which has no Mac Desktop. Update ADE there.",
    )).toBeTruthy();
    // The read carried the focused chat's machine, not the project tab.
    expect(macDesktop.getStatus).toHaveBeenCalledWith(
      { laneId: "lane-1", chatSessionId: "chat-1" },
      STUDIO_PIN,
    );
  });

  it("falls back to the binding's machine name when the union has no row", async () => {
    macDesktop.getStatus.mockRejectedValue(new Error(OLDER_ADE_ERROR));

    renderPanel();

    expect(await screen.findByText(
      "Mac Studio runs ADE 1.2.74, which has no Mac Desktop. Update ADE there.",
    )).toBeTruthy();
  });
});

describe("ChatMacDesktopPanel actions on a pinned machine", () => {
  beforeEach(() => {
    macDesktop.getStatus.mockResolvedValue(makeStatus());
  });

  it("starts a recording on the focused chat's machine", async () => {
    macDesktop.startRecording.mockResolvedValue({
      laneId: "lane-1",
      running: true,
      startedAt: "2026-09-18T19:00:00.000Z",
      filePath: "/tmp/clip.mov",
      lastError: null,
    });

    renderPanel();
    fireEvent.click(await screen.findByTestId("mac-desktop-record"));

    await waitFor(() => expect(macDesktop.startRecording).toHaveBeenCalledWith(
      { laneId: "lane-1", chatSessionId: "chat-1" },
      STUDIO_PIN,
    ));
  });

  it("takes over the lease on the focused chat's machine", async () => {
    macDesktop.takeControl.mockResolvedValue({
      holder: "user",
      holderId: CONTROLLER_ID,
      expiresAt: "2026-09-18T19:10:00.000Z",
    });

    renderPanel();
    fireEvent.click(await screen.findByTestId("mac-desktop-takeover"));

    await waitFor(() => expect(macDesktop.takeControl).toHaveBeenCalledWith(
      { laneId: "lane-1", controllerId: CONTROLLER_ID, controllerLabel: "You" },
      STUDIO_PIN,
    ));
  });

  it("takes control on the first click on the picture, so the screen never looks dead", async () => {
    macDesktop.takeControl.mockResolvedValue({
      holder: "user",
      holderId: CONTROLLER_ID,
      expiresAt: "2026-09-18T19:10:00.000Z",
    });

    renderPanel();
    fireEvent.pointerDown(await screen.findByTestId("mac-desktop-surface"), { button: 0 });

    await waitFor(() => expect(macDesktop.takeControl).toHaveBeenCalledWith(
      { laneId: "lane-1", controllerId: CONTROLLER_ID, controllerLabel: "You" },
      STUDIO_PIN,
    ));
  });

  it("takes control from a click on the canvas slot inside the surface, not only the letterbox", async () => {
    macDesktop.takeControl.mockResolvedValue({
      holder: "user",
      holderId: CONTROLLER_ID,
      expiresAt: "2026-09-18T19:10:00.000Z",
    });

    renderPanel();
    const surface = await screen.findByTestId("mac-desktop-surface");
    // The decoder canvas lives in a portal parked in this child; a React
    // handler on the surface never heard its events, a DOM listener does.
    const slot = surface.firstElementChild as HTMLElement;
    fireEvent.pointerDown(slot, { button: 0 });

    await waitFor(() => expect(macDesktop.takeControl).toHaveBeenCalledTimes(1));
  });

  it("returns control on the focused chat's machine", async () => {
    macDesktop.getStatus.mockResolvedValue(makeStatus({
      lease: {
        laneId: "lane-1",
        holder: "user",
        holderId: CONTROLLER_ID,
        holderLabel: "You",
        grantedAt: "2026-09-18T19:00:00.000Z",
        expiresAt: "2026-09-18T19:10:00.000Z",
      },
    }));
    macDesktop.returnControl.mockResolvedValue(null);

    renderPanel();
    fireEvent.click(await screen.findByText("Return to agent"));

    await waitFor(() => expect(macDesktop.returnControl).toHaveBeenCalledWith(
      { laneId: "lane-1", controllerId: CONTROLLER_ID },
      STUDIO_PIN,
    ));
  });
});

describe("ChatMacDesktopPanel Apps section", () => {
  const parked = {
    id: 7,
    pid: 4242,
    appName: "Xcode",
    bundleId: "com.apple.dt.Xcode",
    title: "ADE.xcodeproj",
    frame: { x: 0, y: 0, width: 800, height: 600 },
    laneId: "lane-1",
    origin: "claimed" as const,
    onDisplayId: 31,
    minimized: false,
    singleInstance: false,
    iconPng: "AAAA",
  };

  beforeEach(() => {
    macDesktop.getStatus.mockResolvedValue(makeStatus({ windows: [parked] }));
  });

  it("renders the Apps section with icon, name and Release per parked window", async () => {
    renderPanel();

    const apps = await screen.findByTestId("mac-desktop-apps");
    expect(apps.textContent).toContain("Xcode");
    expect(apps.textContent).toContain("ADE.xcodeproj");
    expect(screen.getByTestId("mac-desktop-app-icon")).toBeTruthy();
    expect(screen.getByTestId("mac-desktop-window-release").textContent).toContain("Release");
  });

  it("Add app opens the picker inside the pane, not in a portal", async () => {
    renderPanel();

    fireEvent.click(await screen.findByTestId("mac-desktop-add-app"));

    const picker = await screen.findByTestId("mac-desktop-claim-picker");
    expect(screen.getByText("Add an app to this desktop")).toBeTruthy();
    expect(document.body.querySelector(':scope > [data-testid="mac-desktop-claim-picker"]')).toBeNull();
    expect(screen.getByTestId("mac-desktop-panel").contains(picker)).toBe(true);
  });

  it("strip shows no lane name or Windows dropdown", async () => {
    renderPanel();

    await screen.findByTestId("mac-desktop-surface");
    expect(screen.getByTestId("mac-desktop-live-dot")).toBeTruthy();
    expect(screen.queryByTestId("mac-desktop-windows-toggle")).toBeNull();
    expect(screen.queryByText(/ADE ·/)).toBeNull();
    expect(screen.queryByText("Windows")).toBeNull();
  });
});

describe("ChatMacDesktopPanel permission first screen", () => {
  const deniedStatus = (overrides: Partial<MacDesktopStatus> = {}) => makeStatus({
    display: null,
    hostIsLocal: true,
    permissions: { screenRecording: "denied", accessibility: "granted" },
    ...overrides,
  } as Partial<MacDesktopStatus>);

  beforeEach(() => {
    // The auto-start still fires and fails on the denied grant; the block is
    // what the user gets instead of the one-line retry.
    macDesktop.start.mockRejectedValue(new Error("ADE needs Screen Recording permission."));
  });

  it("shows the settings button, the steps, and the ad-hoc note only when signing is adhoc", async () => {
    macDesktop.getStatus.mockResolvedValue(deniedStatus({
      responsibleAppName: "ADE Alpha",
      signing: "adhoc",
    }));

    renderLocalPanel();

    expect(await screen.findByTestId("mac-desktop-permission-block")).toBeTruthy();
    expect(screen.getByTestId("mac-desktop-open-settings")).toBeTruthy();
    expect(screen.getByText("Let ADE see this screen")).toBeTruthy();
    expect(screen.getByText(/Turn on ADE Alpha under Screen Recording\./)).toBeTruthy();
    expect(screen.getByText("Find ADE Alpha in the list and turn it on.")).toBeTruthy();
    expect(screen.getByText("If macOS asks to quit and reopen, press Later.")).toBeTruthy();
    expect(screen.getByText(/Press Check again\. The screen updates by itself/)).toBeTruthy();
    expect(screen.getByTestId("mac-desktop-adhoc-note")).toBeTruthy();
    // The local explicit prompt is a third control on this host only.
    expect(screen.getByTestId("mac-desktop-ask-macos")).toBeTruthy();
  });

  it("hides the ad-hoc note for an identity-signed build", async () => {
    macDesktop.getStatus.mockResolvedValue(deniedStatus({
      responsibleAppName: "ADE",
      signing: "identity",
    }));

    renderLocalPanel();

    expect(await screen.findByTestId("mac-desktop-permission-block")).toBeTruthy();
    expect(screen.queryByTestId("mac-desktop-adhoc-note")).toBeNull();
  });

  it("sends a remote lane host to its own machine instead of this one", async () => {
    macDesktop.getStatus.mockResolvedValue(deniedStatus({
      hostIsLocal: true,
      responsibleAppName: "ADE",
      signing: "identity",
    }));

    // The pin, not `hostIsLocal`, is what says the lane's Mac is elsewhere.
    renderPanel();

    expect(await screen.findByTestId("mac-desktop-permission-block")).toBeTruthy();
    expect(screen.queryByTestId("mac-desktop-open-settings")).toBeNull();
    expect(screen.queryByTestId("mac-desktop-ask-macos")).toBeNull();
    expect(screen.getByText(
      "Grant it on Mac Studio: System Settings › Privacy & Security › Screen Recording, then press Check again.",
    )).toBeTruthy();
  });

  it("Check again calls recheck before start", async () => {
    macDesktop.getStatus.mockResolvedValue(deniedStatus({ signing: "identity" }));
    // The mount auto-start fails on the denied grant; the start that follows
    // the recheck succeeds and lands the display.
    macDesktop.start.mockResolvedValue(makeStatus());
    macDesktop.start.mockRejectedValueOnce(new Error("ADE needs Screen Recording permission."));

    renderLocalPanel();
    fireEvent.click(await screen.findByTestId("mac-desktop-check-again"));

    await waitFor(() => expect(macDesktop.recheckPermissions).toHaveBeenCalledWith(
      { restartDriver: true },
      null,
    ));
    // The start that follows the recheck is what proves the order; the mount
    // auto-start happened before it.
    const recheckOrder = macDesktop.recheckPermissions.mock.invocationCallOrder.at(-1) ?? 0;
    await waitFor(() => expect(
      macDesktop.start.mock.invocationCallOrder.some((order) => order > recheckOrder),
    ).toBe(true));
  });
});
