/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  IosSimulatorDevice,
  IosSimulatorEventPayload,
  IosSimulatorStatus,
  IosSimulatorWindowSource,
} from "../../../../shared/types";
import { IosSimulatorEngineView } from "./IosSimulatorEngineView";

const device: IosSimulatorDevice = {
  udid: "device-1",
  name: "iPhone 17 Pro",
  runtime: "iOS 26.3",
  state: "Booted",
  isAvailable: true,
};

const activeStatus: IosSimulatorStatus = {
  platform: "darwin",
  supported: true,
  tools: [
    { name: "xcrun", available: true, detail: "ok", installHint: "" },
    { name: "simulator_window", available: true, detail: "ok", installHint: "" },
    { name: "idb", available: true, detail: "ok", installHint: "" },
  ],
  activeDevice: device,
  activeSession: {
    id: "session-1",
    deviceUdid: device.udid,
    deviceName: device.name,
    bundleId: "com.example.app",
    appName: "Example",
    appBundlePath: null,
    targetId: "target-1",
    projectRoot: "/tmp/project",
    laneId: "lane-1",
    chatSessionId: "chat-1",
    mode: "live",
    bridgeUrl: null,
    startedAt: "2026-04-29T00:00:00.000Z",
    claimedAt: "2026-04-29T00:00:01.000Z",
  },
};

const simulatorWindowSource: IosSimulatorWindowSource = {
  id: "window:simulator-1",
  name: "iPhone 17 Pro - Simulator",
  thumbnailDataUrl: null,
};

/**
 * The captured window is 800x600 and the device screenshot is 1179x2556, which
 * is what makes the numbers the tap and drag cases assert reproducible: the
 * heuristic screen rect inside that window is x=275.4577, y=49.2, 249.0845 wide
 * and 540 tall, and every expectation below is that rect's arithmetic.
 */
const VIDEO_WIDTH = 800;
const VIDEO_HEIGHT = 600;
/** The <video> as laid out on screen. `object-contain` letterboxes inside it. */
const RENDERED_WIDTH = 393;
const RENDERED_HEIGHT = 852;

function installIosSimulatorApi(options: {
  status?: IosSimulatorStatus;
  windowSources?: IosSimulatorWindowSource[];
  windowSourcesMessage?: string | null;
  getUserMedia?: (() => Promise<MediaStream>) | null;
} = {}) {
  const stream = { getTracks: () => [] } as unknown as MediaStream;
  const getUserMedia = vi.fn(options.getUserMedia ?? (() => Promise.resolve(stream)));
  if (options.getUserMedia === null) {
    Object.defineProperty(window.navigator, "mediaDevices", { configurable: true, value: undefined });
  } else {
    Object.defineProperty(window.navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
  }
  Object.defineProperty(HTMLMediaElement.prototype, "play", {
    configurable: true,
    value: vi.fn().mockResolvedValue(undefined),
  });
  // jsdom never decodes a frame, so the intrinsic size the coordinate map reads
  // has to be declared rather than played into existence.
  Object.defineProperty(HTMLVideoElement.prototype, "videoWidth", { configurable: true, value: VIDEO_WIDTH });
  Object.defineProperty(HTMLVideoElement.prototype, "videoHeight", { configurable: true, value: VIDEO_HEIGHT });
  Object.defineProperty(Element.prototype, "setPointerCapture", { configurable: true, value: vi.fn() });
  // jsdom ships no PointerEvent, and the fallback it builds instead drops
  // `clientX`/`clientY` on the way up — which silently turned every tap into a
  // drag from the press point to the origin.
  vi.stubGlobal("PointerEvent", MouseEvent);

  let eventListener: ((event: IosSimulatorEventPayload) => void) | null = null;
  const api = {
    getStatus: vi.fn().mockResolvedValue(options.status ?? activeStatus),
    startStream: vi.fn().mockResolvedValue({ running: true }),
    stopStream: vi.fn().mockResolvedValue({ running: false }),
    listSimulatorWindowSources: vi.fn().mockResolvedValue({
      sources: options.windowSources ?? [simulatorWindowSource],
      windowState: null,
      message: options.windowSourcesMessage ?? null,
    }),
    retainWindowParking: vi.fn().mockResolvedValue(true),
    releaseWindowParking: vi.fn().mockResolvedValue(undefined),
    getScreenSnapshot: vi.fn().mockResolvedValue({
      deviceUdid: device.udid,
      capturedAt: "2026-04-29T00:00:00.000Z",
      screen: { width: 393, height: 852, scale: 3 },
      screenshot: {
        deviceUdid: device.udid,
        dataUrl: "data:image/png;base64,abc",
        width: 1179,
        height: 2556,
        capturedAt: "2026-04-29T00:00:00.000Z",
      },
      inspectorSnapshot: null,
      elements: [],
      hitElement: null,
      providers: [],
    }),
    tap: vi.fn().mockResolvedValue({ ok: true }),
    drag: vi.fn().mockResolvedValue({ ok: true }),
    typeText: vi.fn().mockResolvedValue({ ok: true }),
    onEvent: vi.fn((listener: (event: IosSimulatorEventPayload) => void) => {
      eventListener = listener;
      return () => {
        eventListener = null;
      };
    }),
  };
  Object.defineProperty(window, "ade", {
    configurable: true,
    value: { iosSimulator: api },
  });
  return {
    api,
    getUserMedia,
    emit: (event: IosSimulatorEventPayload) => eventListener?.(event),
  };
}

/** Flush the promise chain the live-view effect and the snapshot read run on. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/**
 * The picture, with the layout jsdom will not compute. The parent's rect stays
 * at the origin, which is what the object-contain maths measures against.
 */
async function liveSurface(): Promise<HTMLDivElement> {
  await waitFor(() => expect(document.querySelector("video")).toBeTruthy());
  const video = document.querySelector("video") as HTMLVideoElement;
  video.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: RENDERED_WIDTH,
    bottom: RENDERED_HEIGHT,
    width: RENDERED_WIDTH,
    height: RENDERED_HEIGHT,
    toJSON: () => ({}),
  }) as DOMRect;
  return video.parentElement as HTMLDivElement;
}

/** A point in the captured window's own pixels, as a client coordinate. */
function clientFor(mediaX: number, mediaY: number): { clientX: number; clientY: number } {
  const scale = Math.min(RENDERED_WIDTH / VIDEO_WIDTH, RENDERED_HEIGHT / VIDEO_HEIGHT);
  const letterboxTop = (RENDERED_HEIGHT - (VIDEO_HEIGHT * scale)) / 2;
  return { clientX: mediaX * scale, clientY: (mediaY * scale) + letterboxTop };
}

describe("IosSimulatorEngineView", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("taps in device pixels divided by the control scale", async () => {
    const { api } = installIosSimulatorApi();

    render(<IosSimulatorEngineView laneId="lane-1" projectRoot={null} runtimePin={null} sessionId="chat-1" />);

    const surface = await liveSurface();
    await waitFor(() => expect(api.getScreenSnapshot).toHaveBeenCalled());
    await settle();

    const point = clientFor(400, 300);
    fireEvent.pointerDown(surface, { ...point, pointerId: 1 });
    fireEvent.pointerUp(surface, { ...point, pointerId: 1 });

    await waitFor(() => expect(api.tap).toHaveBeenCalled());
    // (400 - 275.4577) / 249.0845 * 1179 / 3, and (300 - 49.2) / 540 * 2556 / 3.
    const [tapArgs, tapPin] = api.tap.mock.calls[0] as [{ deviceUdid: string | null; x: number; y: number }, unknown];
    expect(tapArgs.deviceUdid).toBe(device.udid);
    expect(tapArgs.x).toBeCloseTo(196.5, 1);
    expect(tapArgs.y).toBeCloseTo(395.71, 1);
    expect(tapPin).toBeNull();
    expect(api.drag).not.toHaveBeenCalled();
  });

  it("drags when the pointer travels past the tap limit", async () => {
    const { api } = installIosSimulatorApi();

    render(<IosSimulatorEngineView laneId="lane-1" projectRoot={null} runtimePin={null} sessionId="chat-1" />);

    const surface = await liveSurface();
    await waitFor(() => expect(api.getScreenSnapshot).toHaveBeenCalled());
    await settle();

    const start = clientFor(400, 300);
    const end = clientFor(450, 300);
    // 24.6 rendered pixels of travel, comfortably past the 8px tap limit.
    expect(end.clientX - start.clientX).toBeGreaterThan(8);
    fireEvent.pointerDown(surface, { ...start, pointerId: 1 });
    fireEvent.pointerUp(surface, { ...end, pointerId: 1 });

    await waitFor(() => expect(api.drag).toHaveBeenCalled());
    const [dragArgs, dragPin] = api.drag.mock.calls[0] as [
      { deviceUdid: string | null; startX: number; startY: number; endX: number; endY: number },
      unknown,
    ];
    expect(dragArgs.deviceUdid).toBe(device.udid);
    expect(dragArgs.startX).toBeCloseTo(196.5, 1);
    expect(dragArgs.startY).toBeCloseTo(395.71, 1);
    expect(dragArgs.endX).toBeCloseTo(275.39, 1);
    expect(dragArgs.endY).toBeCloseTo(395.71, 1);
    expect(dragPin).toBeNull();
    expect(api.tap).not.toHaveBeenCalled();
  });

  // A leaked parking hold re-parks — and reopens — Simulator.app on every later
  // ADE window move, for a view nobody is looking at.
  it("stops the tracks, the host stream and the parking hold on unmount", async () => {
    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    const { api } = installIosSimulatorApi({ getUserMedia: () => Promise.resolve(stream) });

    const view = render(<IosSimulatorEngineView laneId="lane-1" projectRoot={null} runtimePin={null} sessionId="chat-1" />);

    await liveSurface();
    await waitFor(() => expect(api.retainWindowParking).toHaveBeenCalledTimes(1));
    const stopCallsBeforeUnmount = api.stopStream.mock.calls.length;

    view.unmount();

    await waitFor(() => expect(api.releaseWindowParking).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(api.stopStream.mock.calls.length).toBeGreaterThan(stopCallsBeforeUnmount));
    expect(track.stop).toHaveBeenCalled();
  });

  // Discovery runs for a whole host budget, so the view can be gone by the time
  // the hold is taken. React's cleanups already ran and found nothing to give
  // back, so the start has to hand back what it took after them.
  it("hands back a parking hold a superseded start took after unmount", async () => {
    const { api } = installIosSimulatorApi();
    let resolveSources: ((result: unknown) => void) | null = null;
    api.listSimulatorWindowSources.mockImplementation(() => new Promise((resolve) => {
      resolveSources = resolve;
    }));

    const view = render(<IosSimulatorEngineView laneId="lane-1" projectRoot={null} runtimePin={null} sessionId="chat-1" />);

    await waitFor(() => expect(api.listSimulatorWindowSources).toHaveBeenCalled());
    expect(api.retainWindowParking).not.toHaveBeenCalled();

    view.unmount();

    await act(async () => {
      resolveSources?.({ sources: [simulatorWindowSource], windowState: null, message: null });
      await Promise.resolve();
    });

    await waitFor(() => expect(api.releaseWindowParking).toHaveBeenCalledTimes(1));
    expect(api.retainWindowParking).toHaveBeenCalledTimes(1);
  });

  // A click that silently does nothing is the worst of the three outcomes.
  it("refuses a tap and says why when control is disabled", async () => {
    const { api } = installIosSimulatorApi();

    render(
      <IosSimulatorEngineView
        laneId="lane-1"
        projectRoot={null}
        runtimePin={null}
        sessionId="chat-1"
        controlDisabledReason="Read-only from this lane."
      />,
    );

    const surface = await liveSurface();
    await waitFor(() => expect(api.getScreenSnapshot).toHaveBeenCalled());
    await settle();

    const point = clientFor(400, 300);
    fireEvent.pointerDown(surface, { ...point, pointerId: 1 });
    fireEvent.pointerUp(surface, { ...point, pointerId: 1 });

    expect(await screen.findByText("Read-only from this lane.")).toBeTruthy();
    expect(api.tap).not.toHaveBeenCalled();
    expect(api.drag).not.toHaveBeenCalled();
  });

  it("draws a sentence instead of the picture when this window cannot capture", async () => {
    installIosSimulatorApi({ getUserMedia: null });

    render(<IosSimulatorEngineView laneId="lane-1" projectRoot={null} runtimePin={null} sessionId="chat-1" />);

    expect(await screen.findByText(/ADE cannot show the simulator in this window/)).toBeTruthy();
    expect(document.querySelector("video")).toBeNull();
  });

  it("draws the host's own wording when discovery finds no simulator window", async () => {
    installIosSimulatorApi({ windowSources: [], windowSourcesMessage: "Screen recording is off for ADE." });

    render(<IosSimulatorEngineView laneId="lane-1" projectRoot={null} runtimePin={null} sessionId="chat-1" />);

    expect(await screen.findByText(/Screen recording is off for ADE/)).toBeTruthy();
  });

  it("says so plainly when nothing is running on the device", async () => {
    installIosSimulatorApi({ status: { ...activeStatus, activeSession: null } });

    render(<IosSimulatorEngineView laneId="lane-1" projectRoot={null} runtimePin={null} sessionId="chat-1" />);

    expect(await screen.findByText(/Nothing is running on iPhone 17 Pro yet/)).toBeTruthy();
  });
});
