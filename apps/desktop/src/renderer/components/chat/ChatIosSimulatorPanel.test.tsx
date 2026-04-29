/* @vitest-environment jsdom */

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatIosSimulatorPanel } from "./ChatIosSimulatorPanel";
import type {
  IosSimulatorDevice,
  IosSimulatorEventPayload,
  IosSimulatorLaunchTarget,
  IosSimulatorStatus,
  IosSimulatorStreamStatus,
  IosSimulatorWindowState,
  IosSimulatorWindowSource,
} from "../../../shared/types";

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
    { name: "xcodebuild", available: true, detail: "ok", installHint: "" },
    { name: "simulator_window", available: true, detail: "ok", installHint: "" },
    { name: "idb", available: true, detail: "ok", installHint: "" },
    { name: "idb_companion", available: true, detail: "ok", installHint: "" },
    { name: "ffmpeg", available: true, detail: "ok", installHint: "" },
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
    chatSessionId: "chat-1",
    mode: "live",
    bridgeUrl: null,
    startedAt: "2026-04-29T00:00:00.000Z",
  },
};

const launchTarget: IosSimulatorLaunchTarget = {
  id: "target-1",
  kind: "project",
  name: "Example",
  bundleId: "com.example.app",
  detail: "Example",
  projectPath: "apps/ios/Example.xcodeproj",
  scheme: "Example",
  appBundlePath: null,
  installed: false,
  canBuild: true,
  canLaunch: true,
  source: "xcode-project",
};

function streamStatus(overrides: Partial<IosSimulatorStreamStatus> = {}): IosSimulatorStreamStatus {
  return {
    deviceUdid: device.udid,
    running: true,
    backend: "idb-h264-ffmpeg-mjpeg",
    fps: null,
    targetFps: 30,
    frameCount: 0,
    startedAt: "2026-04-29T00:00:00.000Z",
    lastFrameAt: "2026-04-29T00:00:00.000Z",
    lastError: null,
    streamUrl: "http://127.0.0.1:4567/ios-simulator/stream.mjpg",
    averageLatencyMs: null,
    ...overrides,
  };
}

const simulatorWindowSource: IosSimulatorWindowSource = {
  id: "window:simulator-1",
  name: "iPhone 17 Pro - Simulator",
  thumbnailDataUrl: null,
};

function installIosSimulatorApi(options: {
  windowSources?: IosSimulatorWindowSource[];
  windowState?: IosSimulatorWindowState;
  getUserMedia?: () => Promise<MediaStream>;
} = {}) {
  let eventListener: ((event: IosSimulatorEventPayload) => void) | null = null;
  const getUserMedia = vi.fn(options.getUserMedia ?? (() => Promise.resolve({
    getTracks: () => [],
  } as unknown as MediaStream)));
  Object.defineProperty(window.navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
  Object.defineProperty(HTMLMediaElement.prototype, "play", {
    configurable: true,
    value: vi.fn().mockResolvedValue(undefined),
  });
  const api = {
    getStatus: vi.fn().mockResolvedValue(activeStatus),
    listDevices: vi.fn().mockResolvedValue([device]),
    listLaunchTargets: vi.fn().mockResolvedValue([launchTarget]),
    startStream: vi.fn((args: { backend?: string | null } = {}) => Promise.resolve(streamStatus(args.backend === "simulator-window-capture"
      ? {
          backend: "simulator-window-capture",
          targetFps: 60,
          streamUrl: null,
        }
      : {}))),
    stopStream: vi.fn().mockResolvedValue(streamStatus({ running: false, backend: null, streamUrl: null })),
    getStreamStatus: vi.fn().mockResolvedValue(streamStatus()),
    getSimulatorWindowState: vi.fn().mockResolvedValue(options.windowState ?? {
      appRunning: true,
      visible: true,
      windowCount: 1,
      minimizedWindowCount: 0,
      capturable: true,
      issue: null,
      message: null,
    }),
    listSimulatorWindowSources: vi.fn().mockResolvedValue(options.windowSources ?? [simulatorWindowSource]),
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
      providers: [{ source: "screenshot", available: true, generatedAt: "2026-04-29T00:00:00.000Z" }],
    }),
    onEvent: vi.fn((listener: (event: IosSimulatorEventPayload) => void) => {
      eventListener = listener;
      return () => {
        eventListener = null;
      };
    }),
    launch: vi.fn(),
    shutdown: vi.fn(),
    screenshot: vi.fn(),
    getInspectorSnapshot: vi.fn(),
    inspectPoint: vi.fn(),
    getPreviewCapability: vi.fn(),
    listPreviewTargets: vi.fn(),
    renderPreview: vi.fn(),
    openPreviewWorkspace: vi.fn(),
    tap: vi.fn(),
    typeText: vi.fn(),
    drag: vi.fn(),
    swipe: vi.fn(),
    selectPoint: vi.fn(),
  };
  Object.defineProperty(window, "ade", {
    configurable: true,
    value: {
      iosSimulator: api,
      app: {
        writeClipboardText: vi.fn(),
      },
    },
  });
  return {
    api,
    getUserMedia,
    emit: (event: IosSimulatorEventPayload) => eventListener?.(event),
  };
}

describe("ChatIosSimulatorPanel", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("starts the normal live view through the smooth simulator window capture stream", async () => {
    const { api } = installIosSimulatorApi();

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    await waitFor(() => expect(api.startStream).toHaveBeenCalled());

    expect(api.startStream).toHaveBeenCalledWith({ deviceUdid: device.udid, backend: "simulator-window-capture", fps: 60 });
    expect(api.listSimulatorWindowSources).toHaveBeenCalled();
  });

  it("falls back to the device-backed auto stream when window capture is unavailable", async () => {
    const { api } = installIosSimulatorApi({ windowSources: [] });

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    await waitFor(() => expect(api.startStream).toHaveBeenCalledTimes(2), { timeout: 3_000 });

    expect(api.startStream).toHaveBeenNthCalledWith(1, { deviceUdid: device.udid, backend: "simulator-window-capture", fps: 60 });
    expect(api.stopStream).toHaveBeenCalled();
    expect(api.startStream).toHaveBeenLastCalledWith({ deviceUdid: device.udid, backend: "auto", fps: 30 });
  });

  it("warns when macOS cannot capture the Simulator window", async () => {
    const { api } = installIosSimulatorApi({
      windowState: {
        appRunning: true,
        visible: true,
        windowCount: 1,
        minimizedWindowCount: 1,
        capturable: false,
        issue: "minimized",
        message: "Simulator.app is minimized. macOS stops updating minimized window capture.",
      },
    });

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    await screen.findByText(/Simulator\.app is minimized/);

    expect(api.getSimulatorWindowState).toHaveBeenCalled();
  });

  it("restarts the device-backed fallback stream after a stream error event", async () => {
    const { api, emit } = installIosSimulatorApi({ windowSources: [] });

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    await waitFor(() => expect(api.startStream).toHaveBeenCalledTimes(2), { timeout: 3_000 });
    await waitFor(() => expect(document.querySelector('canvas[aria-label="iOS Simulator live stream"]')).toBeTruthy());

    act(() => {
      emit({
        type: "stream-error",
        status: streamStatus({
          running: false,
          backend: null,
          streamUrl: null,
          lastError: "idb stream exited",
        }),
      });
    });

    await waitFor(() => expect(api.startStream).toHaveBeenCalledTimes(3));
    expect(api.startStream).toHaveBeenLastCalledWith({ deviceUdid: device.udid, backend: "auto", fps: 30 });
  });

  it("updates the canvas stream url when the service falls back to another backend", async () => {
    const { api, emit } = installIosSimulatorApi({ windowSources: [] });

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    await waitFor(() => expect(api.startStream).toHaveBeenCalledTimes(2), { timeout: 3_000 });

    act(() => {
      emit({
        type: "stream-started",
        status: streamStatus({
          backend: "simctl-screenshot-poll",
          streamUrl: "http://127.0.0.1:5678/ios-simulator/stream.mjpg",
        }),
      });
    });

    await waitFor(() => expect(document.querySelector('canvas[aria-label="iOS Simulator live stream"]')).toBeTruthy());
  });
});
