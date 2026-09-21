/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppleDeviceColumn } from "./AppleDeviceColumn";
import {
  APPLE_COLUMN_HEADER_TOOLBAR_WIDTH,
  APPLE_COLUMN_QUICK_STRIP_WIDTH,
} from "./AppleDeviceToolbar";

/**
 * Column-level behaviour only: which state the column lands in, and which
 * chrome that state produces. The stage, the 3D view and the inspect panel are
 * mocked out — they have their own tests, and mounting a WebCodecs decoder in
 * jsdom proves nothing about the column.
 */

vi.mock("./AppleDeviceStage", () => ({
  AppleDeviceStage: ({ children }: { children?: React.ReactNode }) => (
    <div data-apple-stage="">{children}</div>
  ),
  isWebCodecsAvailable: () => true,
  flatDeviceToView: () => null,
}));

vi.mock("../chat/IosSimToolsColumn", () => ({
  IosSimToolsColumn: () => <div data-tools-column="" />,
}));

const SIMULATOR = {
  udid: "UDID-1",
  name: "iPhone 17",
  runtime: "iOS 26.0",
  state: "Shutdown",
  isAvailable: true,
  family: "iphone" as const,
  deviceTypeIdentifier: null,
};

const LANE_DEVICE = {
  laneId: "lane-1",
  udid: "UDID-1",
  name: "iPhone 17 — lane-1",
  origin: "clone" as const,
  family: "iphone" as const,
  runtime: "iOS 26.0",
  createdAt: "2026-09-21T10:00:00.000Z",
  templateUdid: "UDID-1",
};

type Options = {
  laneDevice?: typeof LANE_DEVICE | null;
  installed?: (typeof SIMULATOR)[];
  supported?: boolean;
  activeDeviceState?: string;
  deviceSession?: unknown;
};

function installApi(options: Options = {}) {
  const laneDevice = options.laneDevice === undefined ? null : options.laneDevice;
  const api = {
    getStatus: vi.fn().mockResolvedValue({
      platform: "darwin",
      supported: options.supported ?? true,
      tools: [],
      activeDevice: laneDevice
        ? { udid: laneDevice.udid, name: laneDevice.name, runtime: laneDevice.runtime, state: options.activeDeviceState ?? "Booted", isAvailable: true }
        : null,
      activeSession: null,
      deviceSession: "deviceSession" in options
        ? options.deviceSession
        : laneDevice
          ? { deviceUdid: laneDevice.udid, deviceName: laneDevice.name, chatSessionId: "chat-1", laneId: "lane-1", openedAt: "", bootedByAde: true }
          : null,
      laneDevice,
    }),
    deviceList: vi.fn().mockResolvedValue({
      installed: options.installed ?? [SIMULATOR],
      lane: laneDevice,
    }),
    deviceCreate: vi.fn().mockResolvedValue(LANE_DEVICE),
    deviceAttach: vi.fn().mockResolvedValue(LANE_DEVICE),
    deviceDelete: vi.fn().mockResolvedValue(undefined),
    openDevice: vi.fn().mockResolvedValue({}),
    closeDevice: vi.fn().mockResolvedValue({}),
    launch: vi.fn().mockResolvedValue({}),
    attachToChatSession: vi.fn().mockResolvedValue(null),
    screenshot: vi.fn().mockResolvedValue({ filePath: "/tmp/shot.png" }),
    tap: vi.fn().mockResolvedValue({ ok: true }),
    pressButton: vi.fn().mockResolvedValue({ ok: true }),
    rotate: vi.fn().mockResolvedValue({ applied: true }),
    getScreenSnapshot: vi.fn().mockResolvedValue({
      deviceUdid: "UDID-1",
      capturedAt: "",
      screenshot: { deviceUdid: "UDID-1", dataUrl: "", filePath: "", width: 1179, height: 2556, capturedAt: "" },
      screen: { width: 393, height: 852, scale: 3 },
      elements: [],
      hitElement: null,
      providers: [],
      inspectorSnapshot: null,
    }),
    startStream: vi.fn().mockResolvedValue({
      running: true,
      streamUrl: "http://127.0.0.1:1/x",
      transport: { url: "http://127.0.0.1:1/x", port: 1, token: "t", codec: null, width: null, height: null },
    }),
    stopStream: vi.fn().mockResolvedValue({}),
    getStreamStatus: vi.fn().mockResolvedValue({ running: true }),
    resolveStreamUrl: vi.fn().mockResolvedValue({ url: "http://127.0.0.1:1/x", forwarded: false, error: null }),
    recordList: vi.fn().mockResolvedValue([]),
    recordStart: vi.fn().mockResolvedValue({}),
    recordStop: vi.fn().mockResolvedValue(null),
    recordDelete: vi.fn().mockResolvedValue(undefined),
    captureProofBundle: vi.fn().mockResolvedValue({}),
    getDeviceSettings: vi.fn().mockResolvedValue(null),
    getEventLog: vi.fn().mockResolvedValue({ rows: [], cursor: 0, dropped: 0, running: false }),
    openSystemSettings: vi.fn().mockResolvedValue({ ok: true }),
    onEvent: vi.fn().mockReturnValue(() => {}),
  };
  (globalThis as unknown as { window: { ade: unknown } }).window.ade = { iosSimulator: api };
  return api;
}

function setColumnWidth(width: number) {
  // jsdom reports 0 for every box, so the column's ResizeObserver never fires.
  // Feeding it one entry is enough to exercise the breakpoint branches.
  class StubResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe() {
      this.callback(
        [{ contentRect: { width, height: 800 } } as unknown as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    }
    unobserve() {}
    disconnect() {}
  }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = StubResizeObserver;
}

function renderColumn() {
  return render(
    <AppleDeviceColumn
      sessionId="chat-1"
      laneId="lane-1"
      laneName="lane-1"
      projectRoot="/repo"
      runtimePin={null}
    />,
  );
}

beforeEach(() => {
  setColumnWidth(900);
  (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver = class {
    observe() {}
    disconnect() {}
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("AppleDeviceColumn", () => {
  it("offers Create and Attach on a lane with no device, and no toolbar", async () => {
    installApi({ laneDevice: null });
    const { container } = renderColumn();
    await waitFor(() => {
      expect(container.querySelector("[data-apple-device-state]")?.getAttribute("data-apple-device-state"))
        .toBe("no-device");
    });
    expect(screen.getByText("No device yet")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create a device" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Attach…" })).toBeTruthy();
    // The toolbar is hidden with no device — every one of its buttons would act
    // on something that does not exist.
    expect(container.querySelector("[data-apple-toolbar]")).toBeNull();
  });

  it("opens the create dialog from the empty state and clones the chosen simulator", async () => {
    const api = installApi({ laneDevice: null });
    renderColumn();
    await waitFor(() => expect(api.deviceList).toHaveBeenCalled());
    await userEvent.click(screen.getByRole("button", { name: "Create a device" }));
    await userEvent.click(await screen.findByRole("button", { name: "Create" }));
    await waitFor(() => expect(api.deviceCreate).toHaveBeenCalled());
    expect(api.deviceCreate.mock.calls[0]?.[0]).toMatchObject({
      laneId: "lane-1",
      chatSessionId: "chat-1",
      from: "UDID-1",
    });
  });

  it("names the Mac requirement rather than offering a device on a non-Mac lane", async () => {
    installApi({ laneDevice: null, supported: false });
    const { container } = renderColumn();
    await waitFor(() => {
      expect(container.querySelector("[data-apple-device-state]")?.getAttribute("data-apple-device-state"))
        .toBe("error");
    });
    expect(screen.getByText("macOS only")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Bind to a Mac" })).toBeTruthy();
  });

  it("shows the rail above 420px and the header row below it", async () => {
    installApi({ laneDevice: LANE_DEVICE });
    const { container, unmount } = renderColumn();
    await waitFor(() => expect(container.querySelector("[data-apple-toolbar='rail']")).toBeTruthy());
    unmount();

    setColumnWidth(APPLE_COLUMN_HEADER_TOOLBAR_WIDTH - 1);
    installApi({ laneDevice: LANE_DEVICE });
    const narrow = renderColumn();
    await waitFor(() => {
      expect(narrow.container.querySelector("[data-apple-toolbar='header']")).toBeTruthy();
    });
    expect(narrow.container.querySelector("[data-apple-toolbar='rail']")).toBeNull();
  });

  it("hides the quick strip below 280px", async () => {
    setColumnWidth(APPLE_COLUMN_QUICK_STRIP_WIDTH - 1);
    installApi({ laneDevice: LANE_DEVICE });
    renderColumn();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Relaunch" })).toBeNull());
  });

  it("boots a powered-off device rather than reporting a dead stream", async () => {
    const api = installApi({
      laneDevice: LANE_DEVICE,
      activeDeviceState: "Shutdown",
      deviceSession: null,
    });
    const { container } = renderColumn();
    await waitFor(() => {
      expect(container.querySelector("[data-apple-device-state]")?.getAttribute("data-apple-device-state"))
        .toBe("powered-off");
    });
    // A powered-off device must never start a stream; the old drawer's stall
    // overlay on a shut-down simulator is exactly the lie this replaces.
    expect(api.startStream).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Boot" }));
    await waitFor(() => expect(api.openDevice).toHaveBeenCalled());
  });

  it("switches the drawer to the inspect panel and forces flat view", async () => {
    installApi({ laneDevice: LANE_DEVICE });
    const { container } = renderColumn();
    await waitFor(() => expect(container.querySelector("[data-apple-toolbar='rail']")).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: "Inspect" }));
    await waitFor(() => {
      expect(container.querySelector("[data-apple-drawer='inspect']")).toBeTruthy();
    });
    // 3D cannot map a device point to the overlay mid-orbit, so inspect owns
    // the presenter while it is on.
    const threeD = screen.getByRole("button", { name: "3D view" }) as HTMLButtonElement;
    expect(threeD.disabled).toBe(true);
  });

  it("presses Home through pressButton", async () => {
    const api = installApi({ laneDevice: LANE_DEVICE });
    const { container } = renderColumn();
    await waitFor(() => expect(container.querySelector("[data-apple-toolbar='rail']")).toBeTruthy());
    const home = container.querySelector("[data-apple-toolbar-action='home']") as HTMLButtonElement;
    expect(home).toBeTruthy();
    expect(home.disabled).toBe(false);
    await userEvent.click(home);
    await waitFor(() => expect(api.pressButton).toHaveBeenCalled());
    expect(api.pressButton.mock.calls[0]?.[0]).toMatchObject({
      name: "home",
      laneId: "lane-1",
      deviceUdid: "UDID-1",
    });
  });

  it("cycles Rotate through portrait → landscape-left → upside-down", async () => {
    const api = installApi({ laneDevice: LANE_DEVICE });
    const { container } = renderColumn();
    await waitFor(() => expect(container.querySelector("[data-apple-toolbar='rail']")).toBeTruthy());
    const rotate = container.querySelector("[data-apple-toolbar-action='rotate']") as HTMLButtonElement;
    expect(rotate.disabled).toBe(false);
    await userEvent.click(rotate);
    await waitFor(() => expect(api.rotate).toHaveBeenCalledTimes(1));
    expect(api.rotate.mock.calls[0]?.[0]).toMatchObject({
      orientation: "landscape-left",
      laneId: "lane-1",
    });
    await userEvent.click(rotate);
    await waitFor(() => expect(api.rotate).toHaveBeenCalledTimes(2));
    expect(api.rotate.mock.calls[1]?.[0]).toMatchObject({
      orientation: "portrait-upside-down",
    });
  });

  it("presses Shake through pressButton shake", async () => {
    const api = installApi({ laneDevice: LANE_DEVICE });
    const { container } = renderColumn();
    await waitFor(() => expect(container.querySelector("[data-apple-toolbar='rail']")).toBeTruthy());
    const shake = container.querySelector("[data-apple-toolbar-action='shake']") as HTMLButtonElement;
    expect(shake.disabled).toBe(false);
    await userEvent.click(shake);
    await waitFor(() => expect(api.pressButton).toHaveBeenCalled());
    expect(api.pressButton.mock.calls[0]?.[0]).toMatchObject({
      name: "shake",
      laneId: "lane-1",
      deviceUdid: "UDID-1",
    });
  });
});
