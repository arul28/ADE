/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AppleInstalledSimulator,
  AppleLaneDevice,
  AppleRotateResult,
  IosSimulatorStatus,
} from "../../../shared/types/iosSimulator";
import type { AppleStreamState } from "./useAppleDeviceStream";
import type * as AppleRecordingModule from "./appleRecording";

/* ── Stubs ────────────────────────────────────────────────────────────────── */

// The stage decodes H.264 into a canvas and mounts a Three scene. Neither
// survives jsdom, and neither is what these tests are about: the pane's job is
// to choose a viewport, wire the presenter, and say the right sentence over it.
// The stub keeps the last props so the wiring itself can be asserted, and
// renders the overlay render prop with an identity mapping.
const stage = vi.hoisted(() => ({
  props: null as null | Record<string, unknown>,
}));

vi.mock("./AppleDeviceStage", () => ({
  AppleDeviceStage: (props: Record<string, unknown> & {
    children?: React.ReactNode;
    renderScreenOverlay?: (map: (point: { x: number; y: number }) => { x: number; y: number }) => React.ReactNode;
  }) => {
    stage.props = props;
    return (
      <div data-testid="apple-stage" data-mode={String(props.mode)}>
        {props.renderScreenOverlay?.((point) => point)}
        {props.children}
      </div>
    );
  },
  isWebCodecsAvailable: () => true,
}));

// R2's drawer: mounted lazily by the pane, and irrelevant to state selection.
vi.mock("./drawer/AppleToolsDrawer", () => ({
  AppleToolsDrawer: () => <div data-testid="apple-drawer" />,
}));

const streamState = { value: "live" as AppleStreamState };
/** What the pane last asked the stream hook for. */
const streamReconnect = vi.hoisted(() => ({ fn: (() => {}) as () => void }));
const streamArgs = vi.hoisted(() => ({
  last: null as null | { deviceUdid: string | null; onError: (message: string | null) => void },
}));

vi.mock("./useAppleDeviceStream", () => ({
  useAppleDeviceStream: (args: { deviceUdid: string | null; onError: (message: string | null) => void }) => {
    streamArgs.last = args;
    return {
    state: streamState.value,
    url: streamState.value === "live" ? "http://127.0.0.1:1/stream" : null,
    token: "token",
    reconnectNonce: 0,
    width: 1_179,
    height: 2_556,
    error: null,
    chip: null,
    frameVersion: 1,
    streamStatus: null,
    handleReaderStatus: vi.fn(),
    handleDimensions: vi.fn(),
    noteFrame: vi.fn(),
    reconnect: () => streamReconnect.fn(),
    applyStreamEvent: vi.fn(),
    };
  },
}));

vi.mock("./appleRecording", async (importOriginal) => ({
  ...(await importOriginal<typeof AppleRecordingModule>()),
  useAppleRecordings: () => ({
    recordings: [],
    active: null,
    summary: { count: 0, totalBytes: 0, pinnedCount: 0 },
    busy: false,
    refresh: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    remove: vi.fn(),
    pinProof: vi.fn(),
  }),
}));

const { AppleDevicePane } = await import("./AppleDevicePane");
const { APPLE_LOADING_RECHECK_MS, APPLE_START_GIVE_UP_MS } = await import("./useAppleDeviceStartTracker");
const { expectNoHorizontalOverflow } = await import("./testLayout");

/* ── Fixtures ─────────────────────────────────────────────────────────────── */

const PRO: AppleInstalledSimulator = {
  udid: "pro",
  name: "iPhone 17 Pro",
  runtime: "iOS 26.2",
  state: "Booted",
  isAvailable: true,
  family: "iphone",
  deviceTypeIdentifier: null,
};

const MAX: AppleInstalledSimulator = { ...PRO, udid: "max", name: "iPhone 17 Pro Max", state: "Shutdown" };

const LANE_DEVICE: AppleLaneDevice = {
  laneId: "lane-1",
  udid: "pro",
  name: "iPhone 17 Pro",
  origin: "attached",
  family: "iphone",
  runtime: "iOS 26.2",
  createdAt: new Date(0).toISOString(),
  templateUdid: null,
};

function status(overrides: Partial<IosSimulatorStatus> = {}): IosSimulatorStatus {
  return {
    platform: "darwin",
    supported: true,
    tools: [{ name: "helper", available: true, detail: "ok", installHint: "" }],
    activeDevice: null,
    activeSession: null,
    deviceSession: null,
    ...overrides,
  } as IosSimulatorStatus;
}

type Setup = {
  status?: IosSimulatorStatus;
  installed?: AppleInstalledSimulator[];
  lane?: AppleLaneDevice | null;
  stream?: AppleStreamState;
};

let listeners: ((event: unknown) => void)[] = [];

function setup(options: Setup = {}) {
  streamState.value = options.stream ?? "live";
  /*
    `deviceStart` resolves only once the stream is up — it awaits `bootstatus`
    and `startStream` — so the stub is a promise the test settles by hand. An
    instantly-resolving stub would snap the pane back to the picker before the
    loading card could be asserted, which is a property of the stub and not of
    the pane.
  */
  let settleStart: (() => void) | null = null;
  const deviceStart = vi.fn(() => new Promise<Record<string, never>>((resolve) => {
    settleStart = () => resolve({});
  }));
  const iosSimulator = {
    getStatus: vi.fn(async () => options.status ?? status()),
    deviceList: vi.fn(async () => ({
      installed: options.installed ?? [PRO, MAX],
      lane: options.lane ?? null,
    })),
    deviceStart,
    deviceDelete: vi.fn(async () => undefined),
    deviceDetach: vi.fn(async () => null),
    closeDevice: vi.fn(async () => ({})),
    deviceStop: vi.fn(async () => ({})),
    getStreamStatus: vi.fn(async () => ({ running: false })),
    screenshot: vi.fn(async () => ({ filePath: "/tmp/shot.png" })),
    getDeviceSettings: vi.fn(async () => ({
      deviceUdid: "pro",
      appearance: "light",
      contentSize: "medium",
      accessibility: {},
      location: null,
      statusBarOverridden: false,
      readAt: new Date(0).toISOString(),
    })),
    setAppearance: vi.fn(),
    setContentSize: vi.fn(),
    pressButton: vi.fn(async () => ({ ok: true })),
    // Typed against the real result so a test can hand back a refusal:
    // `applied` is now the framebuffer's answer, not the send's.
    rotate: vi.fn(async (): Promise<AppleRotateResult> => ({
      applied: true,
      orientation: "portrait",
      verification: "rotated",
      reason: null,
      detail: null,
      frameBefore: null,
      frameAfter: null,
    })),
    tap: vi.fn(async () => ({ ok: true })),
    getScreenSnapshot: vi.fn(async () => ({
      deviceUdid: "pro",
      elements: [
        {
          id: "sign-in",
          source: "accessibility",
          layer: "accessibility",
          label: "Sign in",
          value: null,
          role: "button",
          elementType: null,
          identifier: "signInButton",
          frame: { x: 100, y: 400, width: 120, height: 44 },
          pixelFrame: { x: 300, y: 1_200, width: 360, height: 132 },
          componentId: null,
          sourceFile: null,
          sourceLine: null,
          metadata: {},
        },
      ],
    })),
    onEvent: vi.fn((listener: (event: unknown) => void) => {
      listeners.push(listener);
      return () => {
        listeners = listeners.filter((entry) => entry !== listener);
      };
    }),
  };
  const app = { writeClipboardText: vi.fn(async () => undefined) };
  (window as unknown as { ade: unknown }).ade = { iosSimulator, app };
  return { iosSimulator, app, deviceStart, settleStart: () => settleStart?.() };
}

function renderPane(overrides: Partial<React.ComponentProps<typeof AppleDevicePane>> = {}) {
  return render(
    <AppleDevicePane
      sessionId="chat-1"
      laneId="lane-1"
      projectRoot="/repo"
      runtimePin={null}
      ignoreChatOwnership
      {...overrides}
    />,
  );
}

const paneState = () =>
  document.querySelector("[data-apple-pane]")?.getAttribute("data-apple-device-state");

beforeEach(() => {
  listeners = [];
  stage.props = null;
  window.localStorage.clear();
  // jsdom has neither, and the pane observes both for its container query and
  // its "stop the stream when nobody is looking" rule.
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
    observe() {}
    disconnect() {}
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/* ── One test per state, asserting the spec's exact copy ──────────────────── */

describe("AppleDevicePane states", () => {
  it("unsupported: says a Mac is needed and shows the host's reason", async () => {
    setup({
      status: status({
        supported: false,
        tools: [{ name: "xcrun", available: false, detail: "This runtime is Linux.", installHint: "" }],
      }),
    });
    renderPane();
    expect(await screen.findByText("Apple simulators need a Mac runtime.")).toBeTruthy();
    expect(screen.getByText("This runtime is Linux.")).toBeTruthy();
    expect(paneState()).toBe("unsupported");
  });

  it("helper-missing: names the install, not the binary", async () => {
    setup({
      status: status({
        tools: [{ name: "helper", available: false, detail: "missing", installHint: "" }],
      }),
    });
    renderPane();
    expect(await screen.findByText("ADE's simulator helper is missing from this install.")).toBeTruthy();
    expect(screen.getByText("Reinstall ADE to restore it.")).toBeTruthy();
    expect(paneState()).toBe("helper-missing");
  });

  it("no-device: shows the picker, with no header bar above it", async () => {
    setup({ lane: null });
    renderPane();
    // §B2: the picker's page is the tools-grid card language, grouped by
    // family — never a flat list under the heading "iOS Simulators".
    expect(await screen.findByRole("heading", { name: "iPhone" })).toBeTruthy();
    expect(screen.queryByText("iOS Simulators")).toBeNull();
    expect(paneState()).toBe("no-device");
    // §0: the Device / Preview Lab toggle and the "No device · Primary" header
    // row do not survive.
    expect(screen.queryByRole("button", { name: /preview lab/i })).toBeNull();
    expect(screen.queryByTestId("ios-surface-toggle")).toBeNull();
    expect(document.querySelector("[data-apple-pane] header")).toBeNull();
  });

  it("no-device: Start boots and streams in ONE click, with no dialog", async () => {
    const { deviceStart } = setup({ lane: null });
    renderPane();
    fireEvent.click(await screen.findByRole("button", { name: "Start iPhone 17 Pro Max" }));
    expect(deviceStart).toHaveBeenCalledWith(
      { laneId: "lane-1", chatSessionId: "chat-1", udid: "max" },
      null,
    );
    expect(document.querySelector("[role='dialog']")).toBeNull();
    // The loading card is what stands between the click and the device.
    expect(await screen.findByText("Booting device")).toBeTruthy();
    expect(paneState()).toBe("starting");
  });

  it("starting: advances to Connecting video on the boot event", async () => {
    // The service says `streaming` once its capture is open; the pane's own
    // reader is still connecting, which is the card's second step.
    const { iosSimulator } = setup({ lane: null, stream: "starting" });
    renderPane();
    fireEvent.click(await screen.findByRole("button", { name: "Start iPhone 17 Pro Max" }));
    await screen.findByText("Booting device");
    iosSimulator.deviceList = vi.fn(async () => ({
      installed: [PRO, { ...MAX, state: "Booted" }],
      lane: { ...LANE_DEVICE, udid: "max", name: "iPhone 17 Pro Max" },
    }));
    act(() => {
      for (const listener of listeners) {
        listener({ type: "apple.device.state", laneId: "lane-1", udid: "max", phase: "streaming" });
      }
    });
    expect(await screen.findByText("Connecting video")).toBeTruthy();
  });

  it("starting: a failed boot keeps the card and offers Try again", async () => {
    setup({ lane: null });
    renderPane();
    fireEvent.click(await screen.findByRole("button", { name: "Start iPhone 17 Pro Max" }));
    await screen.findByText("Booting device");
    act(() => {
      for (const listener of listeners) {
        listener({
          type: "apple.device.state",
          laneId: "lane-1",
          udid: "max",
          phase: "failed",
          detail: "Unable to boot device in current state: Shutdown",
        });
      }
    });
    expect(await screen.findByText("The device is off.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByText(/current state: Shutdown/)).toBeNull();
  });

  it("live: shows the device with a fully labelled rail and no strip", async () => {
    setup({ lane: LANE_DEVICE, stream: "live" });
    renderPane();
    await waitFor(() => expect(paneState()).toBe("live"));
    expect(screen.getByTestId("apple-stage")).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "Device controls" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("video-lost: keeps the last frame dimmed and says Video stopped.", async () => {
    setup({ lane: LANE_DEVICE, stream: "stalled" });
    renderPane();
    await waitFor(() => expect(paneState()).toBe("video-lost"));
    expect(screen.getByText("Video stopped.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeTruthy();
    // The rail stays: the device is alive, only the picture is not.
    expect(screen.getByRole("complementary", { name: "Device controls" })).toBeTruthy();
  });

  it("stopped: names the device that is off and offers Start", async () => {
    setup({
      lane: LANE_DEVICE,
      installed: [{ ...PRO, state: "Shutdown" }],
      stream: "idle",
    });
    renderPane();
    await waitFor(() => expect(paneState()).toBe("stopped"));
    expect(screen.getByText("iPhone 17 Pro is off.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start" })).toBeTruthy();
    // §3: no rail over a dead device.
    expect(screen.queryByRole("complementary", { name: "Device controls" })).toBeNull();
  });

  describe("stopped: an off device looks off and offers two ways on", () => {
    const off = () => setup({
      lane: LANE_DEVICE,
      installed: [{ ...PRO, state: "Shutdown" }],
      stream: "idle",
    });

    it("dims the body and labels it Off, with no boot-style Apple logo", async () => {
      off();
      renderPane();
      await waitFor(() => expect(paneState()).toBe("stopped"));
      const offScreen = document.querySelector("[data-apple-off-screen]");
      expect(offScreen?.textContent).toBe("Off");
      // The Apple mark is what a BOOTING device shows; none may be drawn
      // anywhere in the viewport of one that is off.
      expect(document.querySelector("[data-apple-pane] svg path[d^='M17.02']")).toBeNull();
      expect(String(stage.props?.className ?? "")).toContain("opacity-40");
    });

    it("Start boots the lane's device through the existing restart path", async () => {
      const { deviceStart } = off();
      renderPane();
      await waitFor(() => expect(paneState()).toBe("stopped"));
      fireEvent.click(screen.getByRole("button", { name: "Start" }));
      expect(deviceStart).toHaveBeenCalledWith(
        { laneId: "lane-1", chatSessionId: "chat-1", udid: "pro" },
        null,
      );
    });

    /*
     * The owner's 2026-09-23 report: after a shut down, a second "Give up this
     * device?" bar was a double confirmation. Regression (A2-2 / D2): the one
     * click must not delete an ADE-made simulator, since the device can be
     * off for reasons nobody chose here.
     */
    it("Choose another device on an off device releases it without deleting, in one click", async () => {
      const { iosSimulator } = off();
      renderPane();
      await waitFor(() => expect(paneState()).toBe("stopped"));
      iosSimulator.deviceList = vi.fn(async () => ({ installed: [{ ...PRO, state: "Shutdown" }, MAX], lane: null }));
      fireEvent.click(screen.getByRole("button", { name: "Choose another device" }));
      expect(screen.queryByText("Give up this device and pick another?")).toBeNull();
      expect(iosSimulator.deviceDetach).toHaveBeenCalledWith({ laneId: "lane-1", chatSessionId: "chat-1", ignoreOwnership: true }, null);
      expect(iosSimulator.deviceDelete).not.toHaveBeenCalled();
      await waitFor(() => expect(paneState()).toBe("no-device"));
    });

    it("a live device has neither the Off label nor the second choice", async () => {
      setup({ lane: LANE_DEVICE, stream: "live" });
      renderPane();
      await waitFor(() => expect(paneState()).toBe("live"));
      expect(document.querySelector("[data-apple-off-screen]")).toBeNull();
      expect(screen.queryByRole("button", { name: "Choose another device" })).toBeNull();
    });
  });

  it("never renders a raw IPC string, whatever the service says", async () => {
    const { iosSimulator } = setup({ lane: null });
    iosSimulator.deviceList = vi.fn(async () => {
      throw new Error("Error invoking remote method 'apple.deviceList': TypeError");
    });
    renderPane();
    expect(await screen.findByText("Something went wrong with the simulator.")).toBeTruthy();
    expect(screen.queryByText(/Error invoking remote method/)).toBeNull();
  });

  it("switching device asks inline, never in a modal", async () => {
    const { iosSimulator } = setup({ lane: LANE_DEVICE });
    renderPane();
    await waitFor(() => expect(paneState()).toBe("live"));
    fireEvent.keyDown(screen.getByRole("button", { name: "More device actions" }), { key: "Enter" });
    fireEvent.click(screen.getByRole("menuitem", { name: "Switch device…" }));
    expect(screen.getByText("Give up this device and pick another?")).toBeTruthy();
    expect(document.querySelector("[role='dialog']")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Switch device" }));
    expect(iosSimulator.deviceDelete).toHaveBeenCalledWith(
      { laneId: "lane-1", chatSessionId: "chat-1", force: true },
      null,
    );
  });
});

describe("AppleDevicePane surfaces (round 3 §B)", () => {
  it("puts the device on the tools grid's gradient, not on pure black", async () => {
    setup({ lane: LANE_DEVICE, stream: "live" });
    const { container } = renderPane();
    await waitFor(() => expect(paneState()).toBe("live"));
    expect(container.querySelector(".ade-tool-picker-static")).toBeTruthy();
    // The stage's own `bg-black` is overridden from here, so the picture's
    // letterbox is the page rather than a hole in it.
    expect(container.querySelector("[data-apple-stage]")?.className ?? "").not.toContain("bg-black");
  });

  it("has no translucent or blurred surface anywhere (rule zero)", async () => {
    setup({ lane: LANE_DEVICE, stream: "live" });
    const { container } = renderPane();
    await waitFor(() => expect(paneState()).toBe("live"));
    expect(container.querySelector("[class*='backdrop-blur']")).toBeNull();
    expect(container.querySelector("[class*='bg-bg/']")).toBeNull();
  });

  it.each([360, 900])("fits its container at %ipx", async (width) => {
    setup({ lane: null });
    const { container } = renderPane();
    await waitFor(() => expect(paneState()).toBe("no-device"));
    expectNoHorizontalOverflow(container, width);
  });
});

/* ── Round 4 §A1–§A4: the viewport the rail drives ───────────────────────── */

describe("AppleDevicePane viewport (round 4 §A1–§A4)", () => {
  const live = () => setup({ lane: LANE_DEVICE, stream: "live" });

  it("§A1: shows the real body in 3D, and never asks for a procedural one", async () => {
    live();
    renderPane();
    await waitFor(() => expect(paneState()).toBe("live"));
    expect(screen.getByTestId("apple-stage").getAttribute("data-mode")).toBe("3d");
    // The prop that pinned round 3 to the procedural slab is gone entirely.
    expect(stage.props && "realistic" in stage.props).toBe(false);
  });

  it("§A1: a body that cannot load falls back to FLAT and says so once", async () => {
    live();
    renderPane();
    await waitFor(() => expect(paneState()).toBe("live"));
    act(() => {
      (stage.props?.onThreeUnavailable as (reason: string) => void)(
        "The 3D body could not be loaded.",
      );
    });
    await waitFor(() =>
      expect(screen.getByTestId("apple-stage").getAttribute("data-mode")).toBe("flat"));
    expect(screen.getByText("The 3D body could not be loaded. Showing the flat view.")).toBeTruthy();
    // And a way back, rather than a pane stuck in flat forever.
    fireEvent.click(screen.getByRole("button", { name: "Try 3D again" }));
    await waitFor(() =>
      expect(screen.getByTestId("apple-stage").getAttribute("data-mode")).toBe("3d"));
  });

  it("§A2: the one view toggle switches the stage and is remembered per project", async () => {
    live();
    const first = renderPane();
    await waitFor(() => expect(paneState()).toBe("live"));
    fireEvent.click(screen.getByRole("button", { name: "View: 3D" }));
    await waitFor(() =>
      expect(screen.getByTestId("apple-stage").getAttribute("data-mode")).toBe("flat"));
    first.unmount();

    // Same project: the choice survives. A different project keeps the 3D default.
    renderPane();
    await waitFor(() => expect(paneState()).toBe("live"));
    expect(screen.getByTestId("apple-stage").getAttribute("data-mode")).toBe("flat");
    cleanup();

    renderPane({ projectRoot: "/other" });
    await waitFor(() => expect(paneState()).toBe("live"));
    expect(screen.getByTestId("apple-stage").getAttribute("data-mode")).toBe("3d");
  });

  it("§A4: Inspect is a rail toggle that reads the screen and draws frames", async () => {
    const { iosSimulator } = live();
    renderPane();
    await waitFor(() => expect(paneState()).toBe("live"));
    expect(screen.queryByTestId("apple-inspect-overlay")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Inspect elements" }));
    expect(await screen.findByTestId("apple-inspect-overlay")).toBeTruthy();
    expect(iosSimulator.getScreenSnapshot).toHaveBeenCalledWith(
      { deviceUdid: "pro", laneId: "lane-1", projectRoot: "/repo" },
      null,
    );
    // Inspect works in 3D too: the round-3 "Inspect is flat-view only" rule,
    // which silently forced the view, is gone.
    expect(screen.getByTestId("apple-stage").getAttribute("data-mode")).toBe("3d");

    // A second click on the toggle puts the picture back.
    fireEvent.click(screen.getByRole("button", { name: "Inspect elements" }));
    await waitFor(() => expect(screen.queryByTestId("apple-inspect-overlay")).toBeNull());
  });

  it("§A4: the card inserts into chat and copies the tap command", async () => {
    const { app } = live();
    const onAddContext = vi.fn();
    renderPane({ onAddContext });
    await waitFor(() => expect(paneState()).toBe("live"));
    fireEvent.click(screen.getByRole("button", { name: "Inspect elements" }));
    const overlay = await screen.findByTestId("apple-inspect-overlay");
    overlay.getBoundingClientRect = () => new DOMRect(0, 0, 390, 844);
    fireEvent.click(overlay, { clientX: 110, clientY: 410 });

    const card = await screen.findByTestId("apple-inspect-card");
    expect(card.textContent).toContain("Sign in");
    fireEvent.click(screen.getByTestId("apple-inspect-card-insert"));
    expect(onAddContext).toHaveBeenCalledWith(expect.objectContaining({
      kind: "ios_element",
      id: "sign-in",
      accessibilityIdentifier: "signInButton",
    }));
    fireEvent.click(screen.getByTestId("apple-inspect-card-copy"));
    expect(app.writeClipboardText).toHaveBeenCalledWith(
      "ade --socket apple tap-element --identifier signInButton",
    );

    // Escape closes the card wherever the focus is.
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("apple-inspect-card")).toBeNull());
  });

  it("§A5: the rail no longer carries Appearance or Text size", async () => {
    live();
    renderPane();
    await waitFor(() => expect(paneState()).toBe("live"));
    expect(screen.queryByRole("button", { name: /dark mode|light mode/i })).toBeNull();
    expect(screen.queryByRole("button", { name: "Device text size" })).toBeNull();
  });
});

/**
 * Orientation, which the service now verifies against the real framebuffer.
 *
 * The rule these two pin: the picture turns only on a rotation the DEVICE
 * confirmed, and a refusal says why in one sentence rather than doing nothing.
 * Both were live defects — `rotate` answered `applied: true` for a mach
 * message it had merely sent, and the pane's own excuse for a failure ("its
 * window has to be open") named a cause that was never real.
 */
describe("AppleDevicePane orientation honesty", () => {
  const live = () => setup({ lane: LANE_DEVICE, stream: "live" });

  const chooseOrientation = async (label: string) => {
    fireEvent.keyDown(
      screen.getByRole("button", { name: /^Orientation: / }),
      { key: "Enter" },
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: label }));
  };

  it("turns the picture only when the service confirms the screen moved", async () => {
    const { iosSimulator } = live();
    renderPane();
    await waitFor(() => expect(paneState()).toBe("live"));
    iosSimulator.rotate.mockResolvedValue({
      applied: true,
      orientation: "landscape-left",
      verification: "rotated",
      reason: null,
      detail: null,
      frameBefore: { width: 1179, height: 2556 },
      frameAfter: { width: 2556, height: 1179 },
    });

    await chooseOrientation("Landscape left");

    expect(iosSimulator.rotate).toHaveBeenCalledWith(
      { orientation: "landscape-left", laneId: "lane-1", deviceUdid: "pro" },
      null,
    );
    await waitFor(() => expect(
      screen.getByRole("button", { name: /^Orientation: / }).getAttribute("aria-label"),
    ).toBe("Orientation: Landscape left"));
  });

  it("says why a refused rotation did nothing, and leaves the picture alone", async () => {
    const { iosSimulator } = live();
    renderPane();
    await waitFor(() => expect(paneState()).toBe("live"));
    iosSimulator.rotate.mockResolvedValue({
      applied: false,
      orientation: "landscape-left",
      verification: "not-adopted",
      reason: "APPLE_ROTATE_NOT_ADOPTED",
      detail: "The device turned to landscape-left, and the app on screen stayed portrait.",
      frameBefore: { width: 1179, height: 2556 },
      frameAfter: { width: 1179, height: 2556 },
    });

    await chooseOrientation("Landscape left");

    // One sentence naming the cause — not "Something went wrong", and not the
    // wire text either.
    const strip = await screen.findByText("The app on screen does not support that orientation.");
    expect(strip).toBeTruthy();
    // And the control still reads portrait, because that is what is on screen.
    expect(
      screen.getByRole("button", { name: /^Orientation: / }).getAttribute("aria-label"),
    ).toBe("Orientation: Portrait");
  });
});

describe("AppleDevicePane when another lane takes the device (round 5 picker)", () => {
  it("re-lists on `released` and lands on the picker, not on 'Video stopped'", async () => {
    const { iosSimulator } = setup({ lane: LANE_DEVICE, stream: "live" });
    renderPane();
    await waitFor(() => expect(paneState()).toBe("live"));

    /*
     * The takeover has already happened on the runtime: the binding moved, so
     * the next list carries no lane device and names the new owner. Without
     * the `released` handling the pane would sit on its dead stream and say
     * "Video stopped" about a simulator that is running perfectly well for
     * somebody else.
     */
    iosSimulator.deviceList.mockImplementation(async () => ({
      installed: [PRO, MAX],
      lane: null,
      laneId: "lane-1",
      owners: [{ udid: "pro", laneId: "lane-2", laneName: "Repro fix", origin: "attached", mine: false }],
    }));

    act(() => {
      for (const listener of listeners) {
        listener({ type: "apple.device.state", laneId: "lane-1", udid: "pro", phase: "released" });
      }
    });

    await waitFor(() => expect(paneState()).toBe("no-device"));
    // And the picker tells the truth about who has it now. Round 6 says it in
    // one word on the card and names the lane in its tooltip, because the
    // owner asked for a device on hold elsewhere to be inert rather than
    // explained at length.
    const taken = await screen.findByText("Taken");
    expect(taken).toBeTruthy();
    expect(
      document.querySelector('[data-apple-owner-lane="lane-2"]'),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open iPhone 17 Pro" })).toBeNull();
  });
});

/* ── An off device stays off; a loading card always ends ─────────────────── */

function emit(event: unknown) {
  act(() => {
    for (const listener of listeners) listener(event);
  });
}

/** The pane's loading re-check, run by hand instead of waiting 8 seconds. */
function captureRecheck() {
  const ticks: Array<() => void> = [];
  const real = window.setInterval.bind(window);
  const spy = vi.spyOn(window, "setInterval").mockImplementation(((handler: () => void, ms?: number) => {
    if (ms === APPLE_LOADING_RECHECK_MS) ticks.push(handler);
    return real(handler, ms);
  }) as typeof window.setInterval);
  return {
    tick: async () => {
      await act(async () => {
        for (const handler of ticks) handler();
        await Promise.resolve();
      });
    },
    restore: () => spy.mockRestore(),
  };
}

describe("AppleDevicePane after a restart (owner's 2026-09-23 reports)", () => {
  it("regression: a device that is off is shown Off, and the pane never asks for its stream", async () => {
    // A device session outlives a power-off. The pane used to read it as
    // "booted", ask for the stream, and the service booted the device for it.
    setup({
      lane: LANE_DEVICE,
      installed: [{ ...PRO, state: "Shutdown" }],
      status: status({ deviceSession: { deviceUdid: "pro" } as IosSimulatorStatus["deviceSession"] }),
      stream: "idle",
    });
    renderPane();
    await waitFor(() => expect(paneState()).toBe("stopped"));
    expect(screen.getByText("iPhone 17 Pro is off.")).toBeTruthy();
    expect(streamArgs.last?.deviceUdid).toBeNull();
  });

  it("a stream refused with APPLE_DEVICE_OFF lands on the Off card, not an error", async () => {
    // The list still said Booted when the pane mounted; the service knows better.
    const { deviceStart, iosSimulator } = setup({ lane: LANE_DEVICE, stream: "starting" });
    renderPane();
    await waitFor(() => expect(streamArgs.last?.deviceUdid).toBe("pro"));
    // What a fresh `simctl list` says by the time the pane re-reads it.
    iosSimulator.deviceList = vi.fn(async () => ({ installed: [{ ...PRO, state: "Shutdown" }, MAX], lane: LANE_DEVICE }));
    act(() => {
      streamArgs.last?.onError("APPLE_DEVICE_OFF: iPhone 17 Pro is off. Watching a device never boots it.");
    });
    await waitFor(() => expect(paneState()).toBe("stopped"));
    expect(screen.getByText("iPhone 17 Pro is off.")).toBeTruthy();
    expect(screen.queryByText("Something went wrong with the simulator.")).toBeNull();
    // And it stays off: nothing asks for the stream again until Start.
    expect(streamArgs.last?.deviceUdid).toBeNull();
    expect(deviceStart).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(deviceStart).toHaveBeenCalledWith({ laneId: "lane-1", chatSessionId: "chat-1", udid: "pro" }, null);
  });

  it("regression: a start whose reply never arrives leaves the loading card on the streaming event", async () => {
    // "The booter was stuck; I went back to the tools pane and came back, and
    // it instantly reloaded." The device was streaming; the card waited on a
    // promise alone.
    const { iosSimulator } = setup({ lane: null });
    renderPane();
    fireEvent.click(await screen.findByRole("button", { name: "Start iPhone 17 Pro Max" }));
    await screen.findByText("Booting device");
    iosSimulator.deviceList = vi.fn(async () => ({
      installed: [PRO, { ...MAX, state: "Booted" }],
      lane: { ...LANE_DEVICE, udid: "max", name: "iPhone 17 Pro Max" },
    }));
    emit({ type: "apple.device.state", laneId: "lane-1", udid: "max", phase: "streaming" });
    // The deviceStart promise is still pending; the pane does not wait for it.
    await waitFor(() => expect(paneState()).toBe("live"));
  });

  it("regression: with no reply and no event, the re-check finds the lane streaming and ends the card", async () => {
    const recheck = captureRecheck();
    try {
      const { iosSimulator } = setup({ lane: null });
      renderPane();
      fireEvent.click(await screen.findByRole("button", { name: "Start iPhone 17 Pro Max" }));
      await screen.findByText("Booting device");
      iosSimulator.deviceList = vi.fn(async () => ({
        installed: [PRO, { ...MAX, state: "Booted" }],
        lane: { ...LANE_DEVICE, udid: "max", name: "iPhone 17 Pro Max" },
      }));
      iosSimulator.getStreamStatus = vi.fn(async () => ({ running: true }));
      await recheck.tick();
      await waitFor(() => expect(paneState()).toBe("live"));
      expect(iosSimulator.getStreamStatus).toHaveBeenCalledWith(null, { laneId: "lane-1", chatSessionId: "chat-1" });
    } finally {
      recheck.restore();
    }
  });

  it("a start that never finishes is given up with a sentence and Start, never an endless spinner", async () => {
    const recheck = captureRecheck();
    const realNow = Date.now;
    try {
      setup({ lane: null });
      renderPane();
      fireEvent.click(await screen.findByRole("button", { name: "Start iPhone 17 Pro Max" }));
      await screen.findByText("Booting device");
      const startedAt = realNow();
      vi.spyOn(Date, "now").mockImplementation(() => startedAt + APPLE_START_GIVE_UP_MS + 1_000);
      await recheck.tick();
      expect(await screen.findByText("The simulator is taking too long to start.")).toBeTruthy();
      expect(paneState()).not.toBe("starting");
    } finally {
      vi.mocked(Date.now).mockRestore?.();
      recheck.restore();
    }
  });

  it("regression: 'Connecting video' with no start in flight asks the stream again by itself", async () => {
    // The owner's 2026-09-23 report: the pane opened over a floating device
    // sat on "Connecting video" until a tab switch remounted it.
    const recheck = captureRecheck();
    const reconnect = vi.fn();
    streamReconnect.fn = reconnect;
    try {
      setup({ lane: LANE_DEVICE, stream: "starting" });
      renderPane();
      await waitFor(() => expect(paneState()).toBe("starting"));
      expect(screen.getByText("Connecting video")).toBeTruthy();
      await recheck.tick();
      expect(reconnect).toHaveBeenCalledTimes(1);
    } finally {
      streamReconnect.fn = () => {};
      recheck.restore();
    }
  });

  /* Regression (A2-9): a hidden pane's paused stream reads as "starting",
   * and the re-check used to poll `simctl list` and redial it every 8s. */
  it("does not re-check or redial while the pane is off screen", async () => {
    (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
      constructor(private readonly callback: (entries: { isIntersecting: boolean }[]) => void) {}
      observe() { this.callback([{ isIntersecting: false }]); }
      disconnect() {}
    };
    const recheck = captureRecheck();
    const reconnect = vi.fn();
    streamReconnect.fn = reconnect;
    try {
      const { iosSimulator } = setup({ lane: LANE_DEVICE, stream: "starting" });
      renderPane();
      await waitFor(() => expect(paneState()).toBe("starting"));
      const lists = iosSimulator.deviceList.mock.calls.length;
      await recheck.tick();
      expect(reconnect).not.toHaveBeenCalled();
      expect(iosSimulator.deviceList.mock.calls.length).toBe(lists);
    } finally {
      streamReconnect.fn = () => {};
      recheck.restore();
    }
  });

  it("the stopped event shows Off at once, and Power off really powers off", async () => {
    const { iosSimulator } = setup({ lane: LANE_DEVICE, stream: "live" });
    renderPane();
    await waitFor(() => expect(paneState()).toBe("live"));
    iosSimulator.deviceList = vi.fn(async () => ({ installed: [{ ...PRO, state: "Shutdown" }, MAX], lane: LANE_DEVICE }));
    emit({ type: "apple.device.state", laneId: "lane-1", udid: "pro", phase: "stopped" });
    await waitFor(() => expect(paneState()).toBe("stopped"));
  });
});
