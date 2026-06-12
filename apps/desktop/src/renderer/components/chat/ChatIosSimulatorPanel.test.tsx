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
  IosSimulatorPreviewMatch,
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
    { name: "simulator_window", available: true, detail: "ok", installHint: "" },
    { name: "idb", available: true, detail: "ok", installHint: "" },
    { name: "idb_companion", available: true, detail: "ok", installHint: "" },
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

const previewMatch: IosSimulatorPreviewMatch = {
  status: "matched",
  target: previewTarget,
  confidence: "exact",
  reason: "Matched a preview in the selected source file ContentView.swift.",
  selectedSourceFile: "ContentView.swift",
  selectedSourceLine: 12,
  suggestedTitle: "Continue Preview",
  suggestedSourceFile: "ContentPreviews.swift",
  suggestedSourceFilePath: "apps/ios/ContentPreviews.swift",
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
    backend: "simulator-window-capture",
    fps: null,
    targetFps: 60,
    frameCount: 0,
    startedAt: "2026-04-29T00:00:00.000Z",
    lastFrameAt: "2026-04-29T00:00:00.000Z",
    lastError: null,
    streamUrl: null,
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
  status?: IosSimulatorStatus;
  streamStatus?: IosSimulatorStreamStatus;
  windowSources?: IosSimulatorWindowSource[];
  windowState?: IosSimulatorWindowState;
  getUserMedia?: () => Promise<MediaStream>;
  launchTargets?: IosSimulatorLaunchTarget[];
  previewCapability?: IosSimulatorPreviewCapability;
  previewTargets?: IosSimulatorPreviewTarget[];
  previewMatch?: IosSimulatorPreviewMatch;
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
  const effectivePreviewTargets = options.previewTargets ?? [previewTarget];
  const effectivePreviewMatch = options.previewMatch ?? (effectivePreviewTargets.length
    ? previewMatch
    : {
        status: "missing-preview" as const,
        target: null,
        confidence: "none" as const,
        reason: "No #Preview or PreviewProvider was found near ContentView.swift.",
        selectedSourceFile: "ContentView.swift",
        selectedSourceLine: 12,
        suggestedTitle: "Continue Preview",
        suggestedSourceFile: "ContentPreviews.swift",
        suggestedSourceFilePath: "apps/ios/ContentPreviews.swift",
      });
  const renderPreviewResult = {
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
  };
  const api = {
    getStatus: vi.fn().mockResolvedValue(options.status ?? activeStatus),
    listDevices: vi.fn().mockResolvedValue([device]),
    listLaunchTargets: vi.fn().mockResolvedValue(options.launchTargets ?? [launchTarget]),
    startStream: vi.fn((args: { backend?: string | null; fps?: number | null } = {}) => Promise.resolve(streamStatus({
      backend: "simulator-window-capture",
      targetFps: args.fps ?? 60,
      streamUrl: null,
    }))),
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
    listPreviewTargets: vi.fn().mockResolvedValue(effectivePreviewTargets),
    resolvePreviewMatch: vi.fn().mockResolvedValue(effectivePreviewMatch),
    ensurePreviewWorkspace: vi.fn().mockResolvedValue({
      ok: (options.previewCapability ?? previewCapability).supported,
      opened: false,
      path: "/tmp/project/apps/ios/Example.xcodeproj",
      capability: options.previewCapability ?? previewCapability,
      error: null,
    }),
    renderCurrentPreview: vi.fn().mockResolvedValue({
      ok: Boolean(effectivePreviewMatch.target),
      match: effectivePreviewMatch,
      target: effectivePreviewMatch.target,
      render: effectivePreviewMatch.target ? renderPreviewResult : null,
      error: effectivePreviewMatch.target ? null : effectivePreviewMatch.reason,
    }),
    renderPreview: vi.fn().mockResolvedValue(renderPreviewResult),
    openPreviewWorkspace: vi.fn(),
    tap: vi.fn().mockResolvedValue(undefined),
    typeText: vi.fn().mockResolvedValue(undefined),
    drag: vi.fn().mockResolvedValue(undefined),
    swipe: vi.fn().mockResolvedValue(undefined),
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

  it("starts the live view through Simulator.app window capture", async () => {
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

  it("does not attach a live view without an active launch session", async () => {
    const { api } = installIosSimulatorApi({
      status: {
        ...activeStatus,
        activeSession: null,
      },
      streamStatus: streamStatus({
        backend: "simulator-window-capture",
        streamUrl: null,
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

    expect(api.startStream).not.toHaveBeenCalled();
    await waitFor(() => expect(api.stopStream).toHaveBeenCalled());
  });

  it("shows compact simulator readiness", async () => {
    installIosSimulatorApi();

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    await screen.findByText("Simulator readiness");
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
    expect(api.ensurePreviewWorkspace).toHaveBeenCalledWith({
      projectRoot: "/tmp/project",
      sourceFile: null,
      sourceLine: null,
      openIfNeeded: true,
    });
    expect(api.resolvePreviewMatch).toHaveBeenCalledWith({
      projectRoot: "/tmp/project",
      sourceFile: null,
      sourceLine: null,
      elementLabel: null,
      componentId: null,
    });

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

    fireEvent.click(await screen.findByRole("button", { name: "Create preview" }));

    await waitFor(() => {
      expect(onInsertDraft).toHaveBeenCalledWith(expect.stringContaining("No renderable #Preview was found"));
      expect(onInsertDraft).toHaveBeenCalledWith(expect.stringContaining("Suggested preview file: ContentPreviews.swift"));
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

    await waitFor(() => expect(document.querySelector("video")).toBeTruthy());

    const textInput = screen.getByPlaceholderText("Type into the active simulator app") as HTMLInputElement;
    fireEvent.change(textInput, { target: { value: "hello simulator" } });
    expect(textInput.value).toBe("hello simulator");
    expect(api.typeText).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Simulator" }));
    fireEvent.click(screen.getByRole("button", { name: "Simulator" }));
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

    await waitFor(() => expect(document.querySelector("video")).toBeTruthy());
    const video = document.querySelector("video") as HTMLVideoElement;
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
    video.getBoundingClientRect = () => mediaRect;
    const liveSurface = video.closest("[tabindex]") as HTMLDivElement;

    fireEvent.keyDown(liveSurface, { key: "a" });
    fireEvent.pointerDown(liveSurface, { clientX: 50, clientY: 40, pointerId: 1 });
    fireEvent.pointerUp(liveSurface, { clientX: 50, clientY: 40, pointerId: 1 });

    expect(await screen.findByText("Another chat is using the simulator")).toBeTruthy();
    expect(api.typeText).not.toHaveBeenCalled();
    expect(api.tap).not.toHaveBeenCalled();
    expect(api.drag).not.toHaveBeenCalled();
  });

  it("warns without renderer-blocking inspected context attachment when another chat owns the simulator", async () => {
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
      status: {
        ...activeStatus,
        activeSession: {
          ...activeStatus.activeSession!,
          chatSessionId: "chat-2",
        },
      },
      screenElements: [inspectElement],
    });

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={onAddContext}
      />,
    );

    expect(await screen.findByText("Another chat is using the simulator")).toBeTruthy();
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
      expect(api.selectPoint).toHaveBeenCalled();
      expect(onAddContext).toHaveBeenCalledWith(expect.objectContaining({
        label: "Continue",
        source: "ade-inspector",
      }));
    });
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

    await waitFor(() => expect(document.querySelector("video")).toBeTruthy());
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
    expect(await screen.findByText(/Added selected UI context/)).toBeTruthy();

    fireEvent.click(await screen.findByRole("button", { name: /Open in preview|Find preview|Create preview/ }));

    expect(await screen.findByText("ContentView.swift:12")).toBeTruthy();
    expect(api.renderCurrentPreview).toHaveBeenCalledWith({
      projectRoot: "/tmp/project",
      sourceFile: inspectElement.sourceFile,
      sourceLine: inspectElement.sourceLine,
      elementLabel: inspectElement.label,
      componentId: inspectElement.componentId,
      tabIdentifier: null,
      timeoutSec: 120,
    });
    expect(api.renderPreview).not.toHaveBeenCalled();
  });

  it("treats Swift #fileID source paths as the same Preview Lab match", async () => {
    vi.stubGlobal("PointerEvent", MouseEvent);
    vi.stubGlobal("Image", class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onerror?.());
      }
    });
    const fileIdElement: IosScreenElement = {
      ...inspectElement,
      sourceFile: "ADE/Views/ContentView.swift",
    };
    const repoRelativeTarget: IosSimulatorPreviewTarget = {
      ...previewTarget,
      sourceFile: "apps/ios/ADE/Views/ContentView.swift",
      sourceFilePath: "ADE/Views/ContentView.swift",
      absoluteSourceFile: "/tmp/project/apps/ios/ADE/Views/ContentView.swift",
    };
    const repoRelativeMatch: IosSimulatorPreviewMatch = {
      ...previewMatch,
      target: repoRelativeTarget,
      selectedSourceFile: "apps/ios/ADE/Views/ContentView.swift",
    };
    installIosSimulatorApi({
      screenElements: [fileIdElement],
      previewTargets: [repoRelativeTarget],
      previewMatch: repoRelativeMatch,
    });

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    await waitFor(() => expect(document.querySelector("video")).toBeTruthy());
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

    expect(await screen.findByRole("button", { name: "Open in preview" })).toBeTruthy();
  });

  it("keeps bridge preview prompts anchored to the selected inspect element", async () => {
    vi.stubGlobal("PointerEvent", MouseEvent);
    vi.stubGlobal("Image", class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onerror?.());
      }
    });
    const settingsElement: IosScreenElement = {
      ...inspectElement,
      id: "element-2",
      label: "Settings",
      identifier: "settingsButton",
      componentId: "SettingsView/SettingsButton",
      sourceFile: "SettingsView.swift",
      sourceLine: 24,
      frame: { x: 190, y: 190, width: 60, height: 40 },
      pixelFrame: { x: 570, y: 570, width: 180, height: 120 },
    };
    const settingsMatch: IosSimulatorPreviewMatch = {
      status: "missing-preview",
      target: null,
      confidence: "none",
      reason: "No #Preview or PreviewProvider was found near SettingsView.swift.",
      selectedSourceFile: "SettingsView.swift",
      selectedSourceLine: 24,
      suggestedTitle: "Settings Preview",
      suggestedSourceFile: "SettingsPreviews.swift",
      suggestedSourceFilePath: "apps/ios/SettingsPreviews.swift",
    };
    const onInsertDraft = vi.fn();
    const { api } = installIosSimulatorApi({
      screenElements: [inspectElement, settingsElement],
      previewTargets: [],
    });
    api.renderCurrentPreview.mockImplementation(async (args?: { sourceFile?: string | null }) => {
      const match = args?.sourceFile === "SettingsView.swift"
        ? settingsMatch
        : {
            status: "missing-preview",
            target: null,
            confidence: "none",
            reason: "No #Preview or PreviewProvider was found near ContentView.swift.",
            selectedSourceFile: "ContentView.swift",
            selectedSourceLine: 12,
            suggestedTitle: "Continue Preview",
            suggestedSourceFile: "ContentPreviews.swift",
            suggestedSourceFilePath: "apps/ios/ContentPreviews.swift",
          };
      return {
        ok: false,
        match,
        target: null,
        render: null,
        error: match.reason,
      };
    });

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
        onInsertDraft={onInsertDraft}
      />,
    );

    await waitFor(() => expect(document.querySelector("video")).toBeTruthy());
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
    await screen.findByText(/Added selected UI context/);
    fireEvent.pointerMove(image, { clientX: 210, clientY: 210 });
    fireEvent.click(await screen.findByRole("button", { name: "Create preview" }));

    await waitFor(() => {
      expect(api.renderCurrentPreview).toHaveBeenCalledWith({
        projectRoot: "/tmp/project",
        sourceFile: inspectElement.sourceFile,
        sourceLine: inspectElement.sourceLine,
        elementLabel: inspectElement.label,
        componentId: inspectElement.componentId,
        tabIdentifier: null,
        timeoutSec: 120,
      });
      expect(onInsertDraft).toHaveBeenCalledWith(expect.stringContaining("ContentView.swift:12"));
      expect(onInsertDraft).toHaveBeenCalledWith(expect.stringContaining("Continue Preview"));
      expect(onInsertDraft).not.toHaveBeenCalledWith(expect.stringContaining("SettingsView.swift:24"));
    });
  });

  it("drafts a create-preview task from an inspected simulator element when no preview exists", async () => {
    vi.stubGlobal("PointerEvent", MouseEvent);
    vi.stubGlobal("Image", class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onerror?.());
      }
    });
    const onAddContext = vi.fn();
    const onInsertDraft = vi.fn();
    const { api } = installIosSimulatorApi({
      screenElements: [inspectElement],
      previewTargets: [],
    });

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={onAddContext}
        onInsertDraft={onInsertDraft}
      />,
    );

    await waitFor(() => expect(document.querySelector("video")).toBeTruthy());
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

    await waitFor(() => expect(onAddContext).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: "Create preview" }));

    await waitFor(() => {
      expect(onInsertDraft).toHaveBeenCalledWith(expect.stringContaining("No renderable #Preview was found"));
      expect(onInsertDraft).toHaveBeenCalledWith(expect.stringContaining("ade --socket ios-sim preview-current"));
      expect(api.renderPreview).not.toHaveBeenCalled();
    });
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

    await waitFor(() => expect(document.querySelector("video")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /expand simulator view/i }));

    expect(screen.queryByText("Simulator readiness")).toBeNull();
    expect(screen.getByRole("button", { name: /exit expanded simulator view/i })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /zoom in simulator view/i }));

    expect(screen.getByRole("button", { name: /reset simulator zoom/i }).textContent).toBe("125%");
  });

  it("uses the window-capture visual without a stream-mode toggle", async () => {
    const { api } = installIosSimulatorApi();

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    await waitFor(() => expect(api.startStream).toHaveBeenCalledTimes(1), { timeout: 3_000 });

    expect(api.startStream).toHaveBeenCalledWith({ deviceUdid: device.udid, backend: "simulator-window-capture", fps: 60 });
    expect(api.listSimulatorWindowSources).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /show ios window/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /use ade stream/i })).toBeNull();
  });

  it("warns when ADE cannot refresh the simulator live view", async () => {
    const { api } = installIosSimulatorApi({
      windowState: {
        appRunning: true,
        visible: true,
        windowCount: 1,
        minimizedWindowCount: 1,
        capturable: false,
        issue: "minimized",
        message: "The simulator is minimized. Restore it to refresh the live view.",
      },
    });

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    await screen.findByText(/simulator is minimized/i);

    expect(api.getSimulatorWindowState).toHaveBeenCalled();
  });

  it("shows a window live-view error without switching stream backends", async () => {
    const { api, emit } = installIosSimulatorApi();

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    await waitFor(() => expect(api.startStream).toHaveBeenCalledTimes(1), { timeout: 3_000 });
    await waitFor(() => expect(document.querySelector("video")).toBeTruthy());

    act(() => {
      emit({
        type: "stream-error",
        status: streamStatus({
          running: false,
          backend: "simulator-window-capture",
          streamUrl: null,
          lastError: "Simulator window capture stopped",
        }),
      });
    });

    expect(api.startStream).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getAllByText("Live view stopped").length).toBeGreaterThan(0));
  });
});
