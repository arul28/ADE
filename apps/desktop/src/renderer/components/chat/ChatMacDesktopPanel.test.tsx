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
  screenshot: vi.fn(),
  listWindows: vi.fn(async () => []),
  claimWindow: vi.fn(async () => undefined),
  // Present so a test can prove Escape is NOT forwarded as a keystroke.
  press: vi.fn(async () => undefined),
  move: vi.fn(async () => undefined),
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
const openPath = vi.fn(async (_path: string) => undefined);

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
  openPath.mockClear();
  (window as unknown as { ade: unknown }).ade = {
    macDesktop,
    app: { openPath },
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

  it("carries the per-chat preview toggle on its chrome row", async () => {
    renderPanel();

    // Wait for the live chrome row (the display resolved), then the toggle.
    await screen.findByTestId("mac-desktop-record");
    const toggle = screen.getByTestId("work-tool-preview-toggle");
    expect(toggle.getAttribute("aria-label")).toBe("Show preview when minimized");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
  });

  it("starts a captioned recording on the focused chat's machine, so it files as proof", async () => {
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
      { laneId: "lane-1", chatSessionId: "chat-1", caption: "Mac Desktop recording · docs-fix" },
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

  /**
   * Escape is the way out when the pointer misbehaves, so it is tested as a
   * contract rather than left to the pane.
   *
   * It used to bind only while the pane was expanded, and only shrink it. In
   * the ordinary pane it did nothing, and worse: the surface's key handler
   * forwarded it to the lane's Mac, so the one key a person presses when the
   * mouse is stuck was delivered to the wrong computer.
   */
  describe("Escape", () => {
    const heldStatus = () => makeStatus({
      lease: {
        laneId: "lane-1",
        holder: "user",
        holderId: CONTROLLER_ID,
        holderLabel: "You",
        grantedAt: "2026-09-18T19:00:00.000Z",
        expiresAt: "2026-09-18T19:10:00.000Z",
      },
    });

    it("gives the lane back without the pane being expanded first", async () => {
      macDesktop.getStatus.mockResolvedValue(heldStatus());
      macDesktop.returnControl.mockResolvedValue(null);

      renderPanel();
      await screen.findByText("Return to agent");
      fireEvent.keyDown(window, { key: "Escape" });

      await waitFor(() => expect(macDesktop.returnControl).toHaveBeenCalledWith(
        { laneId: "lane-1", controllerId: CONTROLLER_ID },
        STUDIO_PIN,
      ));
    });

    it("never reaches the lane's Mac as a keystroke", async () => {
      macDesktop.getStatus.mockResolvedValue(heldStatus());
      macDesktop.returnControl.mockResolvedValue(null);

      renderPanel();
      await screen.findByText("Return to agent");
      fireEvent.keyDown(window, { key: "Escape" });

      await waitFor(() => expect(macDesktop.returnControl).toHaveBeenCalled());
      // The forwarder builds a `press` for Escape. If this ever fires, the
      // escape hatch is being typed into whatever app is focused over there.
      expect(macDesktop.press).not.toHaveBeenCalled();
    });

    it("leaves Escape alone when this pane holds nothing", async () => {
      macDesktop.getStatus.mockResolvedValue(makeStatus({ lease: null }));

      renderPanel();
      await screen.findByTestId("mac-desktop-takeover");
      const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true, bubbles: true });
      window.dispatchEvent(event);

      // A global capture listener that swallowed every Escape in the window
      // would close nothing and break every dialog in the app.
      expect(event.defaultPrevented).toBe(false);
      expect(macDesktop.returnControl).not.toHaveBeenCalled();
    });

    it("warns on this Mac and tracks the pointer from another computer", async () => {
      // jsdom has no PointerEvent, so testing-library would drop clientX.
      (window as unknown as { PointerEvent?: unknown }).PointerEvent = class PointerEvent extends MouseEvent {};
      const held = {
        laneId: "lane-1",
        holder: "user" as const,
        holderId: CONTROLLER_ID,
        holderLabel: "You",
        grantedAt: "2026-09-18T19:00:00.000Z",
        expiresAt: "2026-09-18T19:10:00.000Z",
      };
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
        left: 0,
        top: 0,
        width: 1000,
        height: 1000,
        right: 1000,
        bottom: 1000,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect);

      macDesktop.getStatus.mockResolvedValue(makeStatus({ lease: held, hostIsLocal: true }));
      renderLocalPanel();
      await screen.findByText("Return to agent");
      fireEvent.pointerMove(screen.getByTestId("mac-desktop-surface"), { clientX: 500, clientY: 500 });
      expect(macDesktop.move).not.toHaveBeenCalled();

      cleanup();
      macDesktop.move.mockClear();
      macDesktop.getStatus.mockResolvedValue(makeStatus({ lease: held, hostIsLocal: true }));
      renderPanel();
      await screen.findByText("Return to agent");
      // One hover is one event: the pane drops it when the surface has not
      // been measured yet, and nothing replays it. Move inside the wait so
      // the assertion tests the forwarding, not the order two effects ran in.
      await waitFor(() => {
        fireEvent.pointerMove(screen.getByTestId("mac-desktop-surface"), { clientX: 500, clientY: 500 });
        expect(macDesktop.move).toHaveBeenCalledWith(
          expect.objectContaining({ laneId: "lane-1", x: 1280, y: 720, silent: true }),
          STUDIO_PIN,
        );
      });
      delete (window as unknown as { PointerEvent?: unknown }).PointerEvent;
    });

    it("ignores a modified Escape, which belongs to macOS", async () => {
      macDesktop.getStatus.mockResolvedValue(heldStatus());

      renderPanel();
      await screen.findByText("Return to agent");
      fireEvent.keyDown(window, { key: "Escape", metaKey: true });

      expect(macDesktop.returnControl).not.toHaveBeenCalled();
    });
  });
});

describe("ChatMacDesktopPanel captures", () => {
  const RUNNING = {
    laneId: "lane-1",
    running: true,
    startedAt: new Date(Date.now() - 12_000).toISOString(),
    filePath: null,
    durationMs: null,
    caption: "Mac Desktop recording · docs-fix",
    lastError: null,
  };

  beforeEach(() => {
    macDesktop.getStatus.mockResolvedValue(makeStatus());
  });

  it("shows a running recording as a pill, and its stop as a Saved to proof receipt", async () => {
    macDesktop.getStatus.mockResolvedValue(makeStatus({
      recording: { ...RUNNING, startedAt: new Date(Date.now() - 12_000).toISOString() },
    }));
    macDesktop.stopRecording.mockResolvedValue({
      ...RUNNING,
      running: false,
      filePath: "/Users/me/.ade/artifacts/clip.mp4",
      durationMs: 12_000,
      proofArtifactId: "artifact-1",
      bytes: 3 * 1024 * 1024,
    });

    renderPanel();
    const pill = await screen.findByTestId("mac-desktop-recording-pill");
    expect(pill.textContent).toMatch(/Recording 00:1\d/);

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    await waitFor(() => expect(macDesktop.stopRecording).toHaveBeenCalledWith(
      { laneId: "lane-1", chatSessionId: "chat-1" },
      STUDIO_PIN,
    ));
    const receipt = await screen.findByTestId("mac-desktop-saved-receipt");
    expect(receipt.textContent).toContain("Saved to proof · 00:12 · 3 MB");
    expect(screen.queryByTestId("mac-desktop-recording-pill")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByTestId("mac-desktop-saved-receipt")).toBeNull();
  });

  it("opens the proof row the receipt names when the proof panel is on screen", async () => {
    macDesktop.screenshot.mockResolvedValue({
      laneId: "lane-1",
      filePath: "/Users/me/shot.png",
      width: 2560,
      height: 1440,
      capturedAt: "2026-09-18T19:00:00.000Z",
      proofArtifactId: "artifact-9",
      bytes: 240 * 1024,
    });
    const row = document.createElement("div");
    row.dataset.chatProofArtifact = "artifact-9";
    row.scrollIntoView = vi.fn();
    document.body.appendChild(row);

    try {
      renderPanel();
      fireEvent.click(await screen.findByTestId("mac-desktop-screenshot"));

      await waitFor(() => expect(macDesktop.screenshot).toHaveBeenCalledWith(
        { laneId: "lane-1", chatSessionId: "chat-1", caption: "Mac Desktop screenshot · docs-fix" },
        STUDIO_PIN,
      ));
      const receipt = await screen.findByTestId("mac-desktop-saved-receipt");
      // A screenshot has no running time, so the receipt leaves it out.
      expect(receipt.textContent).toContain("Saved to proof · 240 KB");

      fireEvent.click(screen.getByRole("button", { name: "Open" }));
      expect(row.scrollIntoView).toHaveBeenCalled();
      expect(openPath).not.toHaveBeenCalled();
    } finally {
      row.remove();
    }
  });

  it("points a remote lane at the proof drawer when the row is not on screen", async () => {
    macDesktop.screenshot.mockResolvedValue({
      laneId: "lane-1",
      filePath: "/Users/studio/shot.png",
      width: 2560,
      height: 1440,
      capturedAt: "2026-09-18T19:00:00.000Z",
      proofArtifactId: "artifact-9",
      bytes: 1_000,
    });

    renderPanel();
    fireEvent.click(await screen.findByTestId("mac-desktop-screenshot"));
    fireEvent.click(await screen.findByRole("button", { name: "Open" }));

    // The file is on the Mac Studio; opening that path here would open nothing.
    expect(openPath).not.toHaveBeenCalled();
    expect((await screen.findByTestId("mac-desktop-capture-notice")).textContent)
      .toContain("It is in this chat's proof drawer.");
  });

  it("says so in the strip when a capture could not be filed as proof", async () => {
    macDesktop.screenshot.mockResolvedValue({
      laneId: "lane-1",
      filePath: "/tmp/shot.png",
      width: 2560,
      height: 1440,
      capturedAt: "2026-09-18T19:00:00.000Z",
      proofArtifactId: null,
    });

    renderPanel();
    fireEvent.click(await screen.findByTestId("mac-desktop-screenshot"));

    const strip = await screen.findByTestId("mac-desktop-capture-error");
    expect(strip.textContent).toContain("could not be filed as proof");
    expect(screen.queryByTestId("mac-desktop-saved-receipt")).toBeNull();
  });
});

describe("ChatMacDesktopPanel strip", () => {
  beforeEach(() => {
    macDesktop.getStatus.mockResolvedValue(makeStatus());
  });

  it("offers Reconnect when the video stops, and Reconnect asks for the stream again", async () => {
    // The default fakes hand back no stream address, so the live view fails.
    renderPanel();

    const strip = await screen.findByTestId("mac-desktop-video-stopped");
    expect(strip.textContent).toContain("Video stopped.");
    // The reason is folded behind Details rather than painted on the picture.
    expect(screen.queryByTestId("mac-desktop-surface-status")).toBeNull();
    expect(strip.textContent).not.toContain("returned no stream address");
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(strip.textContent).toContain("returned no stream address");

    const before = macDesktop.startStream.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(macDesktop.startStream.mock.calls.length).toBeGreaterThan(before));
  });

  it("puts a revoked grant in the same strip, ahead of the stopped video it causes", async () => {
    macDesktop.getStatus.mockResolvedValue(makeStatus({
      hostIsLocal: true,
      responsibleAppName: "ADE",
      permissions: { screenRecording: "granted", accessibility: "denied" },
    } as Partial<MacDesktopStatus>));

    renderLocalPanel();

    const strip = await screen.findByTestId("mac-desktop-permission");
    expect(strip.textContent).toContain("Accessibility is off for ADE.");
    expect(screen.getByRole("button", { name: "Open Accessibility settings" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(macDesktop.recheckPermissions).toHaveBeenCalled());
    expect(screen.queryByTestId("mac-desktop-video-stopped")).toBeNull();
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
    expect(screen.getByTestId("mac-desktop-app-icon")).toBeTruthy();
    expect(screen.getByTestId("mac-desktop-window-release").textContent).toContain("Release");
    // The window's own title is the card's tooltip, not text on its face: the
    // cards are fixed rectangles that wrap, so a long document name would
    // either blow the card out or be truncated to nothing readable.
    const card = screen.getByTestId("mac-desktop-window-card");
    expect(card.getAttribute("title")).toContain("ADE.xcodeproj");
  });

  it("wraps the cards left to right and puts Add app after the last one", async () => {
    renderPanel();

    const list = await screen.findByTestId("mac-desktop-apps-list");
    expect(list.className).toContain("flex-wrap");
    // The button is the last thing in the same run, not a control in the
    // heading: the heading carries the label and nothing else.
    expect(list.lastElementChild?.getAttribute("data-testid")).toBe("mac-desktop-add-app");
    const header = screen.getByTestId("mac-desktop-apps-header");
    expect(header.querySelector("button")).toBeNull();
  });

  it("Add app opens the picker inside the pane, not in a portal", async () => {
    renderPanel();

    fireEvent.click(await screen.findByTestId("mac-desktop-add-app"));

    const picker = await screen.findByTestId("mac-desktop-claim-picker");
    expect(screen.getByText("Add an app to this desktop")).toBeTruthy();
    expect(document.body.querySelector(':scope > [data-testid="mac-desktop-claim-picker"]')).toBeNull();
    expect(screen.getByTestId("mac-desktop-panel").contains(picker)).toBe(true);
    // Over the whole pane and opaque, with the Apps list still mounted behind
    // it: the picker used to replace the very list it adds to.
    const overlay = screen.getByTestId("mac-desktop-picker-overlay");
    expect(overlay.className).toContain("absolute inset-0");
    expect(overlay.className).toContain("bg-surface");
    expect(screen.getByTestId("mac-desktop-apps-list")).toBeTruthy();
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
    // A start with the grant denied fails; the block is what the user gets
    // instead of the one-line retry.
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
    // The start that follows the recheck succeeds and brings the display.
    macDesktop.start.mockResolvedValue(makeStatus());

    renderLocalPanel();
    fireEvent.click(await screen.findByTestId("mac-desktop-check-again"));

    await waitFor(() => expect(macDesktop.recheckPermissions).toHaveBeenCalledWith(
      { restartDriver: true },
      null,
    ));
    // Opening the pane started nothing; the one start follows the recheck.
    const recheckOrder = macDesktop.recheckPermissions.mock.invocationCallOrder.at(-1) ?? 0;
    await waitFor(() => expect(
      macDesktop.start.mock.invocationCallOrder.some((order) => order > recheckOrder),
    ).toBe(true));
    expect(macDesktop.start).toHaveBeenCalledTimes(1);
  });
});

describe("ChatMacDesktopPanel with no display", () => {
  it("shows the Off card instead of starting one, and Start is the one start", async () => {
    macDesktop.getStatus.mockResolvedValue(makeStatus({ display: null }));
    macDesktop.start.mockResolvedValue(makeStatus());

    renderPanel();

    expect(await screen.findByTestId("mac-desktop-off")).toBeTruthy();
    expect(macDesktop.start).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("mac-desktop-start"));
    await waitFor(() => expect(macDesktop.start).toHaveBeenCalledWith(
      { laneId: "lane-1", laneName: "docs-fix", chatSessionId: "chat-1" },
      STUDIO_PIN,
    ));
    expect(await screen.findByTestId("mac-desktop-surface")).toBeTruthy();
    expect(macDesktop.start).toHaveBeenCalledTimes(1);
  });
});
