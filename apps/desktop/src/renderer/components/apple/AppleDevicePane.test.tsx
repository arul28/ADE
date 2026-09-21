/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AppleInstalledSimulator,
  AppleLaneDevice,
  IosSimulatorStatus,
} from "../../../shared/types/iosSimulator";
import type { AppleStreamState } from "./useAppleDeviceStream";
import type * as AppleRecordingModule from "./appleRecording";

/* ── Stubs ────────────────────────────────────────────────────────────────── */

// The stage decodes H.264 into a canvas and mounts a Three scene. Neither
// survives jsdom, and neither is what these tests are about: the pane's job is
// to choose a viewport and say the right sentence over it.
vi.mock("./AppleDeviceStage", () => ({
  AppleDeviceStage: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="apple-stage">{children}</div>
  ),
  isWebCodecsAvailable: () => true,
}));

// R2's drawer: mounted lazily by the pane, and irrelevant to state selection.
vi.mock("./drawer/AppleToolsDrawer", () => ({
  AppleToolsDrawer: () => <div data-testid="apple-drawer" />,
}));

const streamState = { value: "live" as AppleStreamState };

vi.mock("./useAppleDeviceStream", () => ({
  useAppleDeviceStream: () => ({
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
    reconnect: vi.fn(),
    applyStreamEvent: vi.fn(),
  }),
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
    closeDevice: vi.fn(async () => ({})),
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
    rotate: vi.fn(async () => ({ applied: true })),
    tap: vi.fn(async () => ({ ok: true })),
    onEvent: vi.fn((listener: (event: unknown) => void) => {
      listeners.push(listener);
      return () => {
        listeners = listeners.filter((entry) => entry !== listener);
      };
    }),
  };
  (window as unknown as { ade: unknown }).ade = { iosSimulator };
  return { iosSimulator, deviceStart, settleStart: () => settleStart?.() };
}

function renderPane() {
  return render(
    <AppleDevicePane
      sessionId="chat-1"
      laneId="lane-1"
      projectRoot="/repo"
      runtimePin={null}
      ignoreChatOwnership
    />,
  );
}

const paneState = () =>
  document.querySelector("[data-apple-pane]")?.getAttribute("data-apple-device-state");

beforeEach(() => {
  listeners = [];
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
    expect(await screen.findByRole("heading", { name: "iOS Simulators" })).toBeTruthy();
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
    expect(await screen.findByText("Starting device…")).toBeTruthy();
    expect(paneState()).toBe("starting");
  });

  it("starting: advances to Connecting video… on the boot event", async () => {
    setup({ lane: null });
    renderPane();
    fireEvent.click(await screen.findByRole("button", { name: "Start iPhone 17 Pro Max" }));
    await screen.findByText("Starting device…");
    act(() => {
      for (const listener of listeners) {
        listener({ type: "apple.device.state", laneId: "lane-1", udid: "max", phase: "streaming" });
      }
    });
    expect(await screen.findByText("Connecting video…")).toBeTruthy();
  });

  it("starting: a failed boot keeps the card and offers Try again", async () => {
    setup({ lane: null });
    renderPane();
    fireEvent.click(await screen.findByRole("button", { name: "Start iPhone 17 Pro Max" }));
    await screen.findByText("Starting device…");
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

  it("never renders a raw IPC string, whatever the service says", async () => {
    const { iosSimulator } = setup({ lane: null });
    iosSimulator.deviceList = vi.fn(async () => {
      throw new Error("Error invoking remote method 'apple.deviceList': ECONNREFUSED");
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
