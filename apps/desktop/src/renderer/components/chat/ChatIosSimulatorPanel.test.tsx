/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatIosSimulatorPanel } from "./ChatIosSimulatorPanel";
import type {
  IosSimulatorDevice,
  IosSimulatorEventPayload,
  IosSimulatorLaunchTarget,
  IosSimulatorPreviewCapability,
  IosSimulatorPreviewTarget,
  IosScreenElement,
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
    { name: "iosurface_indigo", available: true, detail: "ok", installHint: "" },
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
    laneId: "lane-1",
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
  productName: "Example",
  appTargetId: "target-1",
  appBundlePath: null,
  installed: false,
  canBuild: true,
  canLaunch: true,
  source: "xcode-project",
};

const secondLaunchTarget: IosSimulatorLaunchTarget = {
  ...launchTarget,
  id: "target-2",
  name: "Settings",
  bundleId: "com.example.settings",
  detail: "Settings",
  scheme: "Settings",
  productName: "Settings",
  appTargetId: "target-2",
};

const previewCapability: IosSimulatorPreviewCapability = {
  platform: "darwin",
  supported: true,
  docsUrl: "https://developer.apple.com/documentation/xcode/giving-external-agents-access-to-xcode",
  xcodeVersion: "Xcode 26.0",
  mcpbridgeAvailable: true,
  xcodeRunning: true,
  xcodeWindows: [{
    tabIdentifier: "tab-1",
    title: "Example",
    workspacePath: "/tmp/project/Example.xcodeproj",
    raw: "Example",
  }],
  selectedWindow: {
    tabIdentifier: "tab-1",
    title: "Example",
    workspacePath: "/tmp/project/Example.xcodeproj",
    raw: "Example",
  },
  setupSteps: [],
  error: null,
  checkedAt: "2026-04-29T00:00:00.000Z",
};

const previewTarget: IosSimulatorPreviewTarget = {
  id: "preview-1",
  title: "ContentView",
  sourceFile: "ContentView.swift",
  sourceFilePath: "apps/ios/ContentView.swift",
  absoluteSourceFile: "/tmp/project/apps/ios/ContentView.swift",
  sourceLine: 12,
  previewDefinitionIndexInFile: 0,
  kind: "preview-macro",
  proximity: "project",
};

const secondPreviewTarget: IosSimulatorPreviewTarget = {
  ...previewTarget,
  id: "preview-2",
  title: "SettingsView",
  sourceFile: "SettingsView.swift",
  sourceFilePath: "apps/ios/SettingsView.swift",
  absoluteSourceFile: "/tmp/project/apps/ios/SettingsView.swift",
  sourceLine: 20,
  previewDefinitionIndexInFile: 1,
};

const inspectElement: IosScreenElement = {
  id: "element-1",
  source: "ade-inspector",
  layer: "app",
  label: "Continue",
  value: null,
  role: "Button",
  elementType: "Button",
  identifier: "continueButton",
  frame: { x: 10, y: 20, width: 80, height: 40 },
  pixelFrame: { x: 30, y: 60, width: 240, height: 120 },
  componentId: "ContentView/ContinueButton",
  sourceFile: "ContentView.swift",
  sourceLine: 12,
  metadata: {},
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
  autoBackend?: IosSimulatorStreamStatus["backend"];
  status?: IosSimulatorStatus;
  streamStatus?: IosSimulatorStreamStatus;
  windowSources?: IosSimulatorWindowSource[];
  windowState?: IosSimulatorWindowState;
  getUserMedia?: () => Promise<MediaStream>;
  launchTargets?: IosSimulatorLaunchTarget[];
  previewCapability?: IosSimulatorPreviewCapability;
  previewTargets?: IosSimulatorPreviewTarget[];
  screenElements?: IosScreenElement[];
  hitElement?: IosScreenElement | null;
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
    getStatus: vi.fn().mockResolvedValue(options.status ?? activeStatus),
    listDevices: vi.fn().mockResolvedValue([device]),
    listLaunchTargets: vi.fn().mockResolvedValue(options.launchTargets ?? [launchTarget]),
    startStream: vi.fn((args: { backend?: string | null } = {}) => {
      const resolvedBackend = args.backend === "auto"
        ? options.autoBackend ?? "idb-mjpeg"
        : args.backend;
      return Promise.resolve(streamStatus(resolvedBackend === "simulator-window-capture"
        ? {
            backend: "simulator-window-capture",
            targetFps: 60,
            streamUrl: null,
          }
        : {
            backend: resolvedBackend === "iosurface-indigo" || resolvedBackend === "idb-mjpeg" || resolvedBackend === "simctl-screenshot-poll"
              ? resolvedBackend
              : "idb-mjpeg",
            targetFps: 30,
          }));
    }),
    stopStream: vi.fn().mockResolvedValue(streamStatus({ running: false, backend: null, streamUrl: null })),
    getStreamStatus: vi.fn().mockResolvedValue(options.streamStatus ?? streamStatus({
      deviceUdid: null,
      running: false,
      backend: null,
      streamUrl: null,
      startedAt: null,
      lastFrameAt: null,
    })),
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
      elements: options.screenElements ?? [],
      hitElement: options.hitElement ?? null,
      providers: [
        { source: "screenshot", available: true, generatedAt: "2026-04-29T00:00:00.000Z" },
        ...(options.screenElements?.length
          ? [{ source: "ade-inspector" as const, available: true, elementCount: options.screenElements.length, generatedAt: "2026-04-29T00:00:00.000Z" }]
          : []),
      ],
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
    getPreviewCapability: vi.fn().mockResolvedValue(options.previewCapability ?? previewCapability),
    listPreviewTargets: vi.fn().mockResolvedValue(options.previewTargets ?? [previewTarget]),
    renderPreview: vi.fn().mockResolvedValue({
      ok: true,
      target: {
        sourceFilePath: previewTarget.sourceFilePath,
        previewDefinitionIndexInFile: previewTarget.previewDefinitionIndexInFile,
        tabIdentifier: previewCapability.selectedWindow?.tabIdentifier ?? null,
      },
      previewSnapshotPath: ".ade/artifacts/preview.png",
      dataUrl: "data:image/png;base64,preview",
      width: 390,
      height: 844,
      renderedAt: "2026-04-29T00:00:00.000Z",
      capability: options.previewCapability ?? previewCapability,
      error: null,
    }),
    openPreviewWorkspace: vi.fn(),
    tap: vi.fn(),
    typeText: vi.fn(),
    drag: vi.fn(),
    swipe: vi.fn(),
    selectPoint: vi.fn().mockResolvedValue({
      item: {
        kind: "ios_simulator_target",
        id: "ios:element-1",
        deviceUdid: device.udid,
        label: "Continue",
        source: "ade-inspector",
        screenshotDataUrl: null,
        metadata: {},
      },
      source: "ade-inspector",
    }),
  };
  Object.defineProperty(window, "ade", {
    configurable: true,
    value: {
      iosSimulator: api,
      app: {
        writeClipboardText: vi.fn(),
        openExternal: vi.fn(),
      },
      agentChat: {
        saveTempAttachment: vi.fn().mockResolvedValue({ path: ".ade/artifacts/ios-simulator-screen.png" }),
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
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("starts the normal live view through the service auto stream", async () => {
    const { api } = installIosSimulatorApi();

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    await waitFor(() => expect(api.startStream).toHaveBeenCalled());

    expect(api.startStream).toHaveBeenCalledWith({ deviceUdid: device.udid, backend: "auto" });
    expect(api.listSimulatorWindowSources).not.toHaveBeenCalled();
  });

  it("attaches to a CLI-started stream when the drawer opens without an active launch session", async () => {
    const { api } = installIosSimulatorApi({
      status: {
        ...activeStatus,
        activeSession: null,
      },
      streamStatus: streamStatus({
        backend: "iosurface-indigo",
        streamUrl: "http://127.0.0.1:5678/ios-simulator/stream.mjpg",
        lastFrameAt: null,
      }),
    });

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    await waitFor(() => expect(api.getStreamStatus).toHaveBeenCalled());
    await waitFor(() => expect(document.querySelector('canvas[aria-label="iOS Simulator live stream"]')).toBeTruthy());

    expect(api.startStream).not.toHaveBeenCalled();
    expect(api.stopStream).not.toHaveBeenCalled();
  });

  it("shows compact readiness for the best performance simulator path", async () => {
    installIosSimulatorApi();

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    await screen.findByText("Best simulator performance");
    expect(screen.getByText("Ready")).toBeTruthy();
  });

  it("selects launch and preview targets without launching", async () => {
    const { api } = installIosSimulatorApi({
      launchTargets: [launchTarget, secondLaunchTarget],
      previewTargets: [previewTarget, secondPreviewTarget],
    });

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    await waitFor(() => expect(api.listLaunchTargets).toHaveBeenCalled());

    const launchTargetSelect = screen.getAllByRole("combobox").find((select) =>
      Array.from((select as HTMLSelectElement).options).some((option) => option.value === secondLaunchTarget.id)
    ) as HTMLSelectElement | undefined;
    expect(launchTargetSelect).toBeTruthy();

    fireEvent.change(launchTargetSelect!, { target: { value: secondLaunchTarget.id } });
    expect(launchTargetSelect!.value).toBe(secondLaunchTarget.id);
    expect(api.launch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => expect(api.listPreviewTargets).toHaveBeenCalled());

    const previewTargetSelect = screen.getAllByRole("combobox").find((select) =>
      Array.from((select as HTMLSelectElement).options).some((option) => option.value === secondPreviewTarget.id)
    ) as HTMLSelectElement | undefined;
    expect(previewTargetSelect).toBeTruthy();

    fireEvent.change(previewTargetSelect!, { target: { value: secondPreviewTarget.id } });
    expect(previewTargetSelect!.value).toBe(secondPreviewTarget.id);
    expect(api.renderPreview).not.toHaveBeenCalled();
  });

  it("clears stale launch-target errors after the project root changes and refresh succeeds", async () => {
    const { api } = installIosSimulatorApi();
    api.listLaunchTargets.mockRejectedValueOnce(new Error("Project root /missing does not exist."));
    const onAddContext = vi.fn();
    const view = render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/missing"
        onAddContext={onAddContext}
      />,
    );

    expect(await screen.findByText(/Project root \/missing does not exist/)).toBeTruthy();

    view.rerender(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={onAddContext}
      />,
    );

    await waitFor(() => {
      expect(api.listLaunchTargets).toHaveBeenLastCalledWith({
        deviceUdid: device.udid,
        projectRoot: "/tmp/project",
      });
      expect(screen.queryByText(/Project root \/missing does not exist/)).toBeNull();
    });
  });

  it("copies a setup install command from the simulator checklist", async () => {
    const user = userEvent.setup();
    const originalClipboard = navigator.clipboard;
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const missingXcodeStatus: IosSimulatorStatus = {
      ...activeStatus,
      tools: activeStatus.tools.map((tool) =>
        tool.name === "xcodebuild"
          ? { ...tool, available: false, detail: "missing", installHint: "xcode-select --install" }
          : tool
      ),
    };
    installIosSimulatorApi({ status: missingXcodeStatus });

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    expect(await screen.findByText("Set up iOS prerequisites")).toBeTruthy();
    const installHint = await screen.findByText("xcode-select --install");
    const copyButton = installHint.parentElement?.querySelector("button");
    expect(copyButton).toBeTruthy();
    await user.click(copyButton!);

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("xcode-select --install");
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: originalClipboard,
    });
  });

  it("drafts preview help prompts through the composer", async () => {
    const onInsertDraft = vi.fn();
    installIosSimulatorApi({ previewTargets: [previewTarget] });

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
        onInsertDraft={onInsertDraft}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await screen.findByText("ContentView.swift:12");

    fireEvent.click(screen.getByRole("button", { name: "Ask agent" }));

    await waitFor(() => {
      expect(onInsertDraft).toHaveBeenCalledWith(expect.stringContaining("Make this iOS SwiftUI surface work well"));
    });
  });

  it("drafts an add-preview prompt when Preview Lab finds no targets", async () => {
    const onInsertDraft = vi.fn();
    installIosSimulatorApi({ previewTargets: [] });

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
        onInsertDraft={onInsertDraft}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    fireEvent.click(await screen.findByRole("button", { name: "Ask agent to add a #Preview" }));

    await waitFor(() => {
      expect(onInsertDraft).toHaveBeenCalledWith(expect.stringContaining("No renderable #Preview was found"));
    });
  });

  it("switches live simulator modes and starts screenshot capture without sending input", async () => {
    const { api } = installIosSimulatorApi();

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    await waitFor(() => expect(document.querySelector('canvas[aria-label="iOS Simulator live stream"]')).toBeTruthy());

    const textInput = screen.getByPlaceholderText("Type into the active simulator app") as HTMLInputElement;
    fireEvent.change(textInput, { target: { value: "hello simulator" } });
    expect(textInput.value).toBe("hello simulator");
    expect(api.typeText).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Inspect" }));
    expect(await screen.findByAltText("iOS Simulator snapshot")).toBeTruthy();

    const snapshotCalls = api.getScreenSnapshot.mock.calls.length;
    fireEvent.click(screen.getByTitle("Refresh inspector snapshot"));
    await waitFor(() => {
      expect(api.getScreenSnapshot.mock.calls.length).toBeGreaterThan(snapshotCalls);
    });

    const screenshotButton = screen.getByRole("button", { name: "Screenshot" });
    fireEvent.click(screenshotButton);
    await waitFor(() => {
      expect(screenshotButton.className).toContain("ring-amber-300/30");
    });
    expect(document.querySelector(".cursor-crosshair")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Control" }));
    expect(screen.getByPlaceholderText("Type into the active simulator app")).toBeTruthy();
  });

  it("keeps another-lane simulator sessions read-only", async () => {
    const { api } = installIosSimulatorApi();

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        laneId="lane-2"
        projectRoot="/tmp/project"
        controlDisabledReason="This iOS Simulator view is attached to Lane 1, not Lane 2."
        onAddContext={vi.fn()}
      />,
    );

    const launchButton = await screen.findByRole("button", { name: "Launch" }) as HTMLButtonElement;
    expect(launchButton.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.queryByPlaceholderText("Type into the active simulator app")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Inspect" }));
    const refreshButton = await screen.findByTitle("Refresh inspector snapshot") as HTMLButtonElement;
    expect(refreshButton.disabled).toBe(true);

    expect(api.launch).not.toHaveBeenCalled();
    expect(api.shutdown).not.toHaveBeenCalled();
    expect(api.typeText).not.toHaveBeenCalled();
    expect(api.tap).not.toHaveBeenCalled();
  });

  it("blocks live simulator input when another chat owns the controls", async () => {
    const { api } = installIosSimulatorApi({
      status: {
        ...activeStatus,
        activeSession: {
          ...activeStatus.activeSession!,
          chatSessionId: "chat-2",
        },
      },
    });

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    const canvas = await screen.findByLabelText("iOS Simulator live stream") as HTMLCanvasElement;
    const mediaRect = {
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 393,
      bottom: 852,
      width: 393,
      height: 852,
      toJSON: () => ({}),
    } as DOMRect;
    canvas.getBoundingClientRect = () => mediaRect;
    const liveSurface = canvas.closest("[tabindex]") as HTMLDivElement;

    fireEvent.keyDown(liveSurface, { key: "a" });
    fireEvent.pointerDown(liveSurface, { clientX: 50, clientY: 40, pointerId: 1 });
    fireEvent.pointerUp(liveSurface, { clientX: 50, clientY: 40, pointerId: 1 });

    expect(await screen.findByText("Another chat is already connected to the simulator. Use Take over to claim it.")).toBeTruthy();
    expect(api.typeText).not.toHaveBeenCalled();
    expect(api.tap).not.toHaveBeenCalled();
    expect(api.drag).not.toHaveBeenCalled();
  });

  it("selects an inspected simulator element and opens Preview Lab for its matching target", async () => {
    vi.stubGlobal("PointerEvent", MouseEvent);
    vi.stubGlobal("Image", class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onerror?.());
      }
    });
    const onAddContext = vi.fn();
    const { api } = installIosSimulatorApi({
      screenElements: [inspectElement],
      previewTargets: [previewTarget],
    });

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={onAddContext}
      />,
    );

    await waitFor(() => expect(document.querySelector('canvas[aria-label="iOS Simulator live stream"]')).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Inspect" }));
    const image = await screen.findByAltText("iOS Simulator snapshot") as HTMLImageElement;
    const imageRect = {
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 393,
      bottom: 852,
      width: 393,
      height: 852,
      toJSON: () => ({}),
    } as DOMRect;
    image.getBoundingClientRect = () => imageRect;
    if (image.parentElement) {
      image.parentElement.getBoundingClientRect = () => imageRect;
    }

    fireEvent.pointerDown(image, { clientX: 50, clientY: 40 });

    await waitFor(() => {
      expect(api.selectPoint).toHaveBeenCalledWith({
        deviceUdid: device.udid,
        projectRoot: "/tmp/project",
        x: 150,
        y: 120,
      });
    });
    expect(onAddContext).toHaveBeenCalledWith(expect.objectContaining({
      label: "Continue",
      source: "ade-inspector",
    }));
    expect(await screen.findByText(/Added ade-inspector element context/)).toBeTruthy();

    fireEvent.click(await screen.findByTitle("Open the source file for the selected element in Preview Lab"));

    await waitFor(() => {
      expect(api.listPreviewTargets).toHaveBeenCalledWith({
        projectRoot: "/tmp/project",
        sourceFile: inspectElement.sourceFile,
        sourceLine: inspectElement.sourceLine,
      });
    });
    expect(await screen.findByText("ContentView.swift:12")).toBeTruthy();
    expect(api.renderPreview).not.toHaveBeenCalled();
  });

  it("expands and zooms the live simulator view", async () => {
    installIosSimulatorApi();

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    await waitFor(() => expect(document.querySelector('canvas[aria-label="iOS Simulator live stream"]')).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /expand simulator view/i }));

    expect(screen.queryByText("Best simulator performance")).toBeNull();
    expect(screen.getByRole("button", { name: /exit expanded simulator view/i })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /zoom in simulator view/i }));

    expect(screen.getByRole("button", { name: /reset simulator zoom/i }).textContent).toBe("125%");
  });

  it("uses the window-capture visual when auto resolves to simulator-window-capture", async () => {
    const { api } = installIosSimulatorApi({ autoBackend: "simulator-window-capture" });

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    await waitFor(() => expect(api.startStream).toHaveBeenCalledTimes(2), { timeout: 3_000 });

    expect(api.startStream).toHaveBeenNthCalledWith(1, { deviceUdid: device.udid, backend: "auto" });
    expect(api.startStream).toHaveBeenNthCalledWith(2, { deviceUdid: device.udid, backend: "simulator-window-capture", fps: 60 });
    expect(api.listSimulatorWindowSources).toHaveBeenCalled();
  });

  it("switches the current session to Simulator.app window capture on request", async () => {
    const { api } = installIosSimulatorApi({ autoBackend: "iosurface-indigo" });

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    await waitFor(() => expect(api.startStream).toHaveBeenCalledTimes(1), { timeout: 3_000 });

    fireEvent.click(await screen.findByRole("button", { name: /show ios window/i }));

    await waitFor(() => expect(api.startStream).toHaveBeenCalledWith({
      deviceUdid: device.udid,
      backend: "simulator-window-capture",
      fps: 60,
    }), { timeout: 3_000 });
    expect(api.stopStream).toHaveBeenCalled();
    expect(api.listSimulatorWindowSources).toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: /use ade stream/i })).toBeTruthy();
  });

  it("warns when macOS cannot capture the Simulator window", async () => {
    const { api } = installIosSimulatorApi({
      autoBackend: "simulator-window-capture",
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
    const { api, emit } = installIosSimulatorApi();

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    await waitFor(() => expect(api.startStream).toHaveBeenCalledTimes(1), { timeout: 3_000 });
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

    await waitFor(() => expect(api.startStream).toHaveBeenCalledTimes(2));
    expect(api.startStream).toHaveBeenLastCalledWith({ deviceUdid: device.udid, backend: "auto" });
  });

  it("does not stop a service-managed fallback while it is switching backends", async () => {
    const { api, emit } = installIosSimulatorApi();

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    await waitFor(() => expect(api.startStream).toHaveBeenCalledTimes(1), { timeout: 3_000 });
    const stopCallsBeforeFallback = api.stopStream.mock.calls.length;

    act(() => {
      emit({
        type: "stream-error",
        status: streamStatus({
          running: false,
          backend: "idb-mjpeg",
          streamUrl: null,
          lastError: "idb MJPEG produced no frames; falling back to simulator screenshots.",
          fallbackReason: "Using simctl-screenshot-poll fallback because idb MJPEG produced no frames.",
          degradationReason: "idb MJPEG produced no frames; falling back to simulator screenshots.",
        }),
      });
    });

    await new Promise((resolve) => setTimeout(resolve, 700));

    expect(api.stopStream).toHaveBeenCalledTimes(stopCallsBeforeFallback);
    expect(api.startStream).toHaveBeenCalledTimes(1);

    act(() => {
      emit({
        type: "stream-started",
        status: streamStatus({
          backend: "simctl-screenshot-poll",
          streamUrl: "http://127.0.0.1:5678/ios-simulator/stream.mjpg",
          fallbackReason: "Using simctl-screenshot-poll fallback because idb MJPEG produced no frames.",
          degradationReason: "idb MJPEG produced no frames; falling back to simulator screenshots.",
        }),
      });
    });

    await waitFor(() => expect(api.startStream).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/Live stream failed/)).toBeNull();
  });

  it("restarts a service-managed fallback when it stays stuck reconnecting", async () => {
    const { api, emit } = installIosSimulatorApi();

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    await waitFor(() => expect(api.startStream).toHaveBeenCalledTimes(1), { timeout: 3_000 });

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-29T00:00:10.000Z"));

    act(() => {
      emit({
        type: "stream-error",
        status: streamStatus({
          running: false,
          backend: "idb-mjpeg",
          streamUrl: null,
          lastError: "idb fallback stalled",
          fallbackReason: "Using simctl-screenshot-poll fallback because idb MJPEG produced no frames.",
          degradationReason: "idb fallback stalled",
        }),
      });
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_200);
    });

    expect(api.startStream).toHaveBeenCalledTimes(2);
    expect(api.startStream).toHaveBeenLastCalledWith({ deviceUdid: device.udid, backend: "simctl-screenshot-poll" });
  });

  it("forces the idb fallback after repeated native stream failures", async () => {
    const { api, emit } = installIosSimulatorApi({ autoBackend: "iosurface-indigo" });

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    await waitFor(() => expect(api.startStream).toHaveBeenCalledTimes(1), { timeout: 3_000 });

    act(() => {
      emit({
        type: "stream-error",
        status: streamStatus({
          running: false,
          backend: "iosurface-indigo",
          streamUrl: null,
          lastError: "iosurface stream exited",
        }),
      });
    });

    await waitFor(() => expect(api.startStream).toHaveBeenCalledTimes(2), { timeout: 3_000 });
    expect(api.startStream).toHaveBeenLastCalledWith({ deviceUdid: device.udid, backend: "auto" });

    await new Promise((resolve) => setTimeout(resolve, 1_600));

    act(() => {
      emit({
        type: "stream-error",
        status: streamStatus({
          running: false,
          backend: "iosurface-indigo",
          streamUrl: null,
          lastError: "iosurface stream exited again",
        }),
      });
    });

    await waitFor(() => expect(api.startStream).toHaveBeenCalledTimes(3), { timeout: 3_000 });
    expect(api.startStream).toHaveBeenLastCalledWith({ deviceUdid: device.udid, backend: "idb-mjpeg" });
    await screen.findByText("Live stream had trouble reconnecting. Switching to a fallback view...");
  });

  it("does not restart an idle native stream after it has produced a frame", async () => {
    const { api } = installIosSimulatorApi({ autoBackend: "iosurface-indigo" });

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    await waitFor(() => expect(api.startStream).toHaveBeenCalledTimes(1), { timeout: 3_000 });

    await new Promise((resolve) => setTimeout(resolve, 2_500));

    expect(api.startStream).toHaveBeenCalledTimes(1);
  });

  it("updates the canvas stream url when the service falls back to another backend", async () => {
    const { api, emit } = installIosSimulatorApi();

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    await waitFor(() => expect(api.startStream).toHaveBeenCalledTimes(1), { timeout: 3_000 });

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
