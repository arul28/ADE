/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatIosSimulatorPanel } from "./ChatIosSimulatorPanel";
import type {
  IosSimulatorDevice,
  IosSimulatorDeviceSettings,
  IosSimulatorEventLogArgs,
  IosSimulatorEventLogPage,
  IosSimulatorEventPayload,
  IosSimulatorLaunchTarget,
  IosSimulatorLogRow,
  IosSimulatorPreviewCapability,
  IosSimulatorPreviewMatch,
  IosSimulatorPreviewTarget,
  IosScreenElement,
  IosSimulatorSetAccessibilityArgs,
  IosSimulatorSetAppearanceArgs,
  IosSimulatorStartStreamArgs,
  IosSimulatorStatus,
  IosSimulatorStreamStatus,
  IosSimulatorWindowState,
  IosSimulatorWindowSource,
} from "../../../shared/types";
import type { ChatRuntimeScope } from "./ChatRuntimeScope";

/**
 * The chat's machine, as the panel sees it.
 *
 * `useChatRuntimeScopeForPin` reads the cross-machine lane store, which no test
 * here populates, so the remote live view would be unreachable without this
 * seam. Every other export of the module stays real.
 */
const LOCAL_SCOPE: ChatRuntimeScope = {
  pin: null,
  binding: null,
  laneId: null,
  lane: null,
  laneWorktreePath: null,
  rootPath: null,
  isRemote: false,
  machineName: "This computer",
  online: true,
};

let chatScopeOverride: Partial<ChatRuntimeScope> | null = null;

vi.mock("./ChatRuntimeScope", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("./ChatRuntimeScope");
  return {
    ...actual,
    useChatRuntimeScopeForPin: (pin: ChatRuntimeScope["pin"], laneId: string | null): ChatRuntimeScope => ({
      ...LOCAL_SCOPE,
      pin,
      laneId,
      ...chatScopeOverride,
    }),
  };
});

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

/**
 * "Open <device> without an app": a claimed, booted device and no app session.
 *
 * This is the shape the device hub added, and it is the one every live-view
 * consumer has to accept. A guard that asks for `activeSession` sees nothing
 * here, which is how the screen scale went missing and every tap landed short.
 */
const deviceSessionStatus: IosSimulatorStatus = {
  ...activeStatus,
  activeSession: null,
  deviceSession: {
    deviceUdid: device.udid,
    deviceName: device.name,
    chatSessionId: "chat-1",
    laneId: "lane-1",
    openedAt: "2026-04-29T00:00:00.000Z",
    bootedByAde: false,
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

/**
 * The host-encoded stream's two addresses.
 *
 * The encoder answers on loopback on the machine that owns the simulator. A
 * desktop bound to a remote Mac reads it through a port forward, so the port it
 * opens is not the port the host reported — which is the whole reason
 * `resolveStreamUrl` exists. The two differ here so an assertion can tell them
 * apart.
 */
const H264_HOST_URL = "http://127.0.0.1:45301/stream?token=stream-token";
const H264_FORWARDED_URL = "http://127.0.0.1:59102/stream?token=stream-token";

const defaultDeviceSettings: IosSimulatorDeviceSettings = {
  deviceUdid: device.udid,
  appearance: "dark",
  contentSize: "large",
  accessibility: {
    "increase-contrast": false,
    "reduce-motion": true,
    "reduce-transparency": false,
    "bold-text": false,
    "invert-colors": false,
    grayscale: false,
    // The device answered nothing for this one, which the column shows as "n/a"
    // rather than guessing "off".
    "voice-over": null,
  },
  location: null,
  statusBarOverridden: false,
  readAt: "2026-04-29T00:00:00.000Z",
};

const defaultLogRows: IosSimulatorLogRow[] = [
  {
    id: 1,
    at: "2026-04-29T00:00:01.000Z",
    source: "ade",
    level: "action",
    process: null,
    subsystem: null,
    category: null,
    message: "Set the appearance to dark.",
    command: "ade ios-sim ui appearance dark",
  },
  {
    id: 2,
    at: "2026-04-29T00:00:02.000Z",
    source: "device",
    level: "error",
    process: "Example",
    subsystem: "com.example.app",
    category: "default",
    message: "Could not load the profile.",
  },
];

const defaultEventLogPage: IosSimulatorEventLogPage = {
  deviceUdid: device.udid,
  running: true,
  rows: defaultLogRows,
  cursor: 2,
  dropped: 0,
  lastError: null,
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
  revealResult?: { ok: boolean; message: string | null };
  deviceSettings?: IosSimulatorDeviceSettings;
  eventLog?: IosSimulatorEventLogPage;
  resolveStreamUrl?: { url: string | null; forwarded: boolean; error: string | null };
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
  const effectiveDeviceSettings = options.deviceSettings ?? defaultDeviceSettings;
  const effectiveEventLog = options.eventLog ?? defaultEventLogPage;
  const api = {
    getStatus: vi.fn().mockResolvedValue(options.status ?? activeStatus),
    listDevices: vi.fn().mockResolvedValue([device]),
    listLaunchTargets: vi.fn().mockResolvedValue(options.launchTargets ?? [launchTarget]),
    // The host answers with the backend it actually started, and only the
    // host-encoded one carries a transport — window capture has a window id,
    // not an address.
    startStream: vi.fn((args: IosSimulatorStartStreamArgs = {}) => Promise.resolve(
      args.backend === "idb-h264"
        ? streamStatus({
          backend: "idb-h264",
          targetFps: args.fps ?? 30,
          streamUrl: H264_HOST_URL,
          transport: {
            url: H264_HOST_URL,
            port: 45301,
            token: "stream-token",
            codec: "avc1.640032",
            width: 393,
            height: 852,
          },
        })
        : streamStatus({
          backend: "simulator-window-capture",
          targetFps: args.fps ?? 60,
          streamUrl: null,
        }),
    )),
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
    listSimulatorWindowSources: vi.fn().mockResolvedValue({
      sources: options.windowSources ?? [simulatorWindowSource],
      windowState: null,
      message: null,
    }),
    // The host answers with whether it actually counted the holder.
    retainWindowParking: vi.fn().mockResolvedValue(true),
    releaseWindowParking: vi.fn().mockResolvedValue(undefined),
    openSystemSettings: vi.fn().mockResolvedValue({ ok: true }),
    revealSimulator: vi.fn().mockResolvedValue(options.revealResult ?? { ok: true, message: null }),
    attachToChatSession: vi.fn().mockResolvedValue(null),
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
    // Device hub. The panel reads every one of these off `window.ade`, so a
    // method missing here is a TypeError inside a render, not a failed
    // assertion — which is why they all exist even where no test calls them.
    openDevice: vi.fn().mockResolvedValue({
      deviceUdid: device.udid,
      deviceName: device.name,
      chatSessionId: "chat-1",
      laneId: "lane-1",
      openedAt: "2026-04-29T00:00:00.000Z",
      bootedByAde: false,
    }),
    closeDevice: vi.fn().mockResolvedValue({
      released: true,
      shutdown: false,
      previousDeviceSession: null,
    }),
    getDeviceSettings: vi.fn().mockResolvedValue(effectiveDeviceSettings),
    // The panel re-reads the device from the write's own result instead of
    // assuming it landed, so these answer with the value they were asked for.
    setAppearance: vi.fn((args: IosSimulatorSetAppearanceArgs) => Promise.resolve({
      ...effectiveDeviceSettings,
      appearance: args.appearance,
    })),
    setContentSize: vi.fn().mockResolvedValue(effectiveDeviceSettings),
    setAccessibilityOption: vi.fn((args: IosSimulatorSetAccessibilityArgs) => Promise.resolve({
      ...effectiveDeviceSettings,
      accessibility: { ...effectiveDeviceSettings.accessibility, [args.option]: args.enabled },
    })),
    setLocation: vi.fn().mockResolvedValue(effectiveDeviceSettings),
    clearLocation: vi.fn().mockResolvedValue({ ...effectiveDeviceSettings, location: null }),
    setPermission: vi.fn().mockResolvedValue({ ok: true }),
    sendPushNotification: vi.fn().mockResolvedValue({ ok: true }),
    openUrl: vi.fn().mockResolvedValue({ ok: true }),
    terminateApp: vi.fn().mockResolvedValue({ ok: true }),
    uninstallApp: vi.fn().mockResolvedValue({ ok: true }),
    setStatusBar: vi.fn().mockResolvedValue({ ok: true }),
    clearStatusBar: vi.fn().mockResolvedValue({ ok: true }),
    getAppState: vi.fn().mockResolvedValue({
      bundleId: activeStatus.activeSession?.bundleId ?? "com.example.app",
      running: true,
      pid: 4242,
      checkedAt: "2026-04-29T00:00:00.000Z",
    }),
    startEventLog: vi.fn().mockResolvedValue(effectiveEventLog),
    stopEventLog: vi.fn().mockResolvedValue({ ...effectiveEventLog, running: false, rows: [] }),
    // Rows arrive by cursor. Answering with the same page on every poll would
    // append duplicates the real host never sends.
    getEventLog: vi.fn((args: IosSimulatorEventLogArgs = {}) => Promise.resolve(
      (args.sinceId ?? 0) >= effectiveEventLog.cursor
        ? { ...effectiveEventLog, rows: [] }
        : effectiveEventLog,
    )),
    findElement: vi.fn().mockResolvedValue({
      ok: true,
      action: "tap",
      match: null,
      matchCount: 1,
      message: null,
      waitedMs: null,
    }),
    tapElement: vi.fn().mockResolvedValue({
      ok: true,
      action: "tap",
      match: null,
      matchCount: 1,
      message: null,
      waitedMs: null,
    }),
    fillElement: vi.fn().mockResolvedValue({
      ok: true,
      action: "fill",
      match: null,
      matchCount: 1,
      message: null,
      waitedMs: null,
    }),
    waitForElement: vi.fn().mockResolvedValue({
      ok: true,
      action: "wait",
      match: null,
      matchCount: 1,
      message: null,
      waitedMs: 120,
    }),
    assertVisible: vi.fn().mockResolvedValue({
      ok: true,
      action: "assert",
      match: null,
      matchCount: 1,
      message: null,
      waitedMs: null,
    }),
    captureProofBundle: vi.fn().mockResolvedValue({
      dir: ".ade/artifacts/ios-proof",
      screenshotPath: ".ade/artifacts/ios-proof/screen.png",
      metadataPath: ".ade/artifacts/ios-proof/metadata.json",
      elementsPath: null,
      logPath: null,
      caption: null,
      capturedAt: "2026-04-29T00:00:00.000Z",
    }),
    resolveStreamUrl: vi.fn().mockResolvedValue(
      options.resolveStreamUrl ?? { url: H264_FORWARDED_URL, forwarded: true, error: null },
    ),
  };
  const app = {
    writeClipboardText: vi.fn(),
    openExternal: vi.fn(),
  };
  Object.defineProperty(window, "ade", {
    configurable: true,
    value: {
      iosSimulator: api,
      app,
      agentChat: {
        saveTempAttachment: vi.fn().mockResolvedValue({ path: ".ade/artifacts/ios-simulator-screen.png" }),
      },
    },
  });
  return {
    api,
    app,
    getUserMedia,
    emit: (event: IosSimulatorEventPayload) => eventListener?.(event),
  };
}

/** Radix opens menus on pointerdown, and jsdom has none of the pointer plumbing. */
function installRadixDomShims(): void {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture = vi.fn(() => false);
  proto.setPointerCapture = vi.fn();
  proto.releasePointerCapture = vi.fn();
}

/** Radix's popper measures its content, and jsdom ships no ResizeObserver. */
class MockMenuResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/**
 * Open a device-tool value menu by its trigger's accessible name.
 *
 * Keyboard rather than pointer: jsdom has no PointerEvent, so Radix's
 * `button === 0` guard on pointerdown never passes there.
 */
async function openToolMenu(label: string): Promise<void> {
  fireEvent.keyDown(await screen.findByLabelText(label), { key: "Enter" });
}

/**
 * Advance a fake clock and let everything it woke settle.
 *
 * The panel's timers all sit behind a promise chain, so a bare
 * `advanceTimersByTime` moves the clock and stops before the work lands. The
 * async form flushes microtasks between timers, and `act` commits what React
 * queued from them.
 */
async function settleFakeTimers(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("ChatIosSimulatorPanel", () => {
  beforeEach(() => {
    vi.useRealTimers();
    chatScopeOverride = null;
    installRadixDomShims();
  });

  afterEach(() => {
    cleanup();
    chatScopeOverride = null;
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

    expect(api.startStream).toHaveBeenCalledWith({ deviceUdid: device.udid, backend: "simulator-window-capture", fps: 60 }, null);
    expect(api.listSimulatorWindowSources).toHaveBeenCalled();
  });

  // The agent launches, the user opens the drawer afterwards. The panel never
  // saw the launch return, so the session is the only place the prebuilt flag
  // exists — and a stale binary silently passing for a verified change is the
  // exact failure this warning exists to prevent.
  it("warns that an agent-launched session is running a prebuilt binary", async () => {
    const { api } = installIosSimulatorApi({
      status: {
        ...activeStatus,
        activeSession: { ...activeStatus.activeSession!, usedInstalledBinary: true },
      },
    });

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    expect(await screen.findByText("prebuilt")).toBeTruthy();
    expect(api.launch).not.toHaveBeenCalled();
  });

  it("puts device, launch and stop on one chrome row", async () => {
    const { api } = installIosSimulatorApi();

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    const chrome = await screen.findByTestId("ios-pane-chrome");
    // One row, not three: the device is a chip whose menu is a real <select>,
    // and every verb on it is a glyph with a tooltip.
    expect(chrome.textContent).toContain("iPhone 17 Pro");
    expect(screen.getByLabelText("Simulator device")).toBeTruthy();

    fireEvent.click(await screen.findByTestId("ios-pane-launch"));
    await waitFor(() => expect(api.launch).toHaveBeenCalled());

    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(await screen.findByTestId("ios-pane-stop"));
    await waitFor(() => expect(api.shutdown).toHaveBeenCalled());
    confirm.mockRestore();
  });

  it("names the build root only when it is not this project's checkout", async () => {
    installIosSimulatorApi({
      status: {
        ...activeStatus,
        activeSession: {
          ...activeStatus.activeSession!,
          buildRoot: "/Users/me/.ade/worktrees/other-lane",
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

    expect(await screen.findByText("…/worktrees/other-lane")).toBeTruthy();
  });

  it("stays silent when the build root is this checkout under a /private alias", async () => {
    installIosSimulatorApi({
      status: {
        ...activeStatus,
        // macOS firmlinks: the same directory, spelled by a different resolver.
        activeSession: { ...activeStatus.activeSession!, buildRoot: "/private/tmp/project/" },
      },
    });

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    // The "Live" pill is gone from the row — a running session now shows as
    // the one control only a running session has.
    await screen.findByTestId("ios-pane-stop");
    expect(screen.queryByText("…/tmp/project")).toBeNull();
  });

  it("stays silent when a /private alias carries a doubled separator", async () => {
    installIosSimulatorApi({
      status: {
        ...activeStatus,
        // Stripping `/private` before normalizing left `//tmp/project`, which
        // reads as a UNC root and never matched the plain `/tmp/project`.
        activeSession: { ...activeStatus.activeSession!, buildRoot: "/private//tmp/project" },
      },
    });

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    // The "Live" pill is gone from the row — a running session now shows as
    // the one control only a running session has.
    await screen.findByTestId("ios-pane-stop");
    expect(screen.queryByText("…/tmp/project")).toBeNull();
  });

  it("stays silent when the build root differs only by Windows drive casing", async () => {
    installIosSimulatorApi({
      status: {
        ...activeStatus,
        // Windows paths are case-insensitive, so `C:\` and `c:\` are the same
        // checkout. A raw case-sensitive compare called this a foreign root.
        activeSession: { ...activeStatus.activeSession!, buildRoot: "c:\\Users\\Me\\Project\\" },
      },
    });

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="C:\\Users\\me\\project"
        onAddContext={vi.fn()}
      />,
    );

    // The "Live" pill is gone from the row — a running session now shows as
    // the one control only a running session has.
    await screen.findByTestId("ios-pane-stop");
    // The chip renders the abbreviated tail, so that — not the full root — is
    // the only text an assertion here can discriminate on.
    expect(screen.queryByText("…/Me/Project")).toBeNull();
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

  it("hides the type-into-simulator composer until something is booted", async () => {
    // Nothing is running, so the empty state's Launch is the one button on the
    // page. The composer used to sit under it with its own Send, which read as
    // a second primary next to the one action that page exists for.
    installIosSimulatorApi({ status: { ...activeStatus, activeSession: null } });
    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    expect(await screen.findByTestId("ios-empty-launch")).toBeTruthy();
    expect(screen.queryByTestId("ios-type-composer")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  });

  it("keeps the tool chips out of the way until something is actually missing", async () => {
    const { api } = installIosSimulatorApi();

    const healthy = render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    await waitFor(() => expect(api.getStatus).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /Controls/ })).toBeNull();
    healthy.unmount();

    installIosSimulatorApi({
      status: {
        ...activeStatus,
        tools: activeStatus.tools.map((tool) =>
          tool.name === "idb"
            ? { ...tool, available: false, detail: "missing", installHint: "brew install idb-companion" }
            : tool
        ),
      },
    });

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    // idb only blocks tap/type/drag, so it warns instead of blocking the panel.
    const controlsChip = await screen.findByRole("button", { name: /Controls/ });
    expect(screen.queryByText("Set up iOS prerequisites")).toBeNull();
    await userEvent.setup().click(controlsChip);
    expect(await screen.findByText("brew install idb-companion")).toBeTruthy();
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

    fireEvent.click(screen.getByRole("button", { name: "Previews" }));
    await waitFor(() => expect(api.listPreviewTargets).toHaveBeenCalled());
    expect(api.ensurePreviewWorkspace).toHaveBeenCalledWith({
      projectRoot: "/tmp/project",
      sourceFile: null,
      sourceLine: null,
      openIfNeeded: true,
    }, null);
    expect(api.resolvePreviewMatch).toHaveBeenCalledWith({
      projectRoot: "/tmp/project",
      sourceFile: null,
      sourceLine: null,
      elementLabel: null,
      componentId: null,
    }, null);

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
      }, null);
      expect(screen.queryByText(/Project root \/missing does not exist/)).toBeNull();
    });
  });

  it("copies a setup install command from the tool chips", async () => {
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

    // A missing required tool takes over the media area, and the chip row moves
    // into that card — so wait for the card before reaching for the chip.
    await screen.findByText("Simulator unavailable");
    const xcodeChip = screen.getAllByRole("button", { name: /Xcode/ })[0]!;
    await user.click(xcodeChip);
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

    fireEvent.click(screen.getByRole("button", { name: "Previews" }));
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

    fireEvent.click(screen.getByRole("button", { name: "Previews" }));

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

    // Already on the live surface: the row's one surface toggle would take us
    // to Previews, so there is nothing to click to stay here.
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

    const launchButton = await screen.findByTestId("ios-pane-launch") as HTMLButtonElement;
    expect(launchButton.disabled).toBe(true);
    expect(screen.queryByTestId("ios-pane-stop")).toBeNull();
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

    // Ownership now reads as a ribbon over the live view; the card only
    // renders where there is no live view to float over.
    expect(await screen.findByTestId("ios-watch-ribbon")).toBeTruthy();
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

    // Ownership now reads as a ribbon over the live view; the card only
    // renders where there is no live view to float over.
    expect(await screen.findByTestId("ios-watch-ribbon")).toBeTruthy();
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
      }, null);
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
    }, null);
    expect(api.renderPreview).not.toHaveBeenCalled();
  });

  it("keeps the inspect hover target live after attaching simulator context", async () => {
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
    const onAddContext = vi.fn();
    const { api } = installIosSimulatorApi({
      screenElements: [inspectElement, settingsElement],
      previewTargets: [previewTarget],
    });
    api.selectPoint.mockImplementation(async (args: { x: number; y: number }) => {
      const element = args.x >= settingsElement.pixelFrame.x
        ? settingsElement
        : inspectElement;
      return {
        item: {
          kind: "ios_simulator_target",
          id: `ios:${element.id}`,
          deviceUdid: device.udid,
          label: element.label,
          source: element.source,
          screenshotDataUrl: null,
          metadata: {},
        },
        source: element.source,
      };
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
    await screen.findByText(/Added selected UI context/);
    expect(onAddContext).toHaveBeenCalledWith(expect.objectContaining({ label: "Continue" }));

    fireEvent.pointerMove(image, { clientX: 210, clientY: 210 });
    expect(await screen.findByText("Settings")).toBeTruthy();

    fireEvent.pointerDown(image, { clientX: 210, clientY: 210 });

    await waitFor(() => {
      expect(api.selectPoint).toHaveBeenLastCalledWith({
        deviceUdid: device.udid,
        projectRoot: "/tmp/project",
        x: 660,
        y: 630,
      }, null);
      expect(onAddContext).toHaveBeenLastCalledWith(expect.objectContaining({ label: "Settings" }));
    });
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
      }, null);
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

    // Expanding hands the whole drawer to the picture: the chrome around it —
    // here the type-into-the-simulator row — is unmounted, not just restyled.
    expect(screen.getByPlaceholderText("Type into the active simulator app")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /expand simulator view/i }));

    expect(screen.queryByPlaceholderText("Type into the active simulator app")).toBeNull();
    expect(screen.getByRole("button", { name: /exit expanded simulator view/i })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /zoom in simulator view/i }));

    expect(screen.getByRole("button", { name: /reset simulator zoom/i }).textContent).toBe("125%");
  });

  // The picked window is the one whose name matches the active device, not
  // simply the first the host swept up — a machine with two simulator windows
  // open otherwise streamed the wrong phone.
  it("streams the discovered window that matches the active device", async () => {
    const { api, getUserMedia } = installIosSimulatorApi({
      windowSources: [
        { id: "window:other", name: "iPad Pro 13-inch — Simulator", thumbnailDataUrl: null },
        simulatorWindowSource,
      ],
    });

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    await waitFor(() => expect(getUserMedia).toHaveBeenCalled());

    expect(api.startStream).toHaveBeenCalledWith({ deviceUdid: device.udid, backend: "simulator-window-capture", fps: 60 }, null);
    const constraints = (getUserMedia.mock.calls as unknown as any[][])[0]?.[0];
    expect(constraints.video.mandatory.chromeMediaSourceId).toBe(simulatorWindowSource.id);
  });

  // The host's own discovery settles and re-attaches inside its 12s budget, so
  // a renderer-side retry loop only ever added spinner on top of it. One sweep,
  // and the give-up message says what actually happened — nothing timed out.
  it("gives up after a single empty sweep and says the window was not found", async () => {
    const { api } = installIosSimulatorApi();
    // An empty sweep with no verdict — the shape a blocked setup produces, and
    // the one the deleted loop used to keep re-asking on.
    api.listSimulatorWindowSources.mockResolvedValue({ sources: [], windowState: null, message: null });

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    await waitFor(
      () => expect(screen.getAllByText(/ADE could not find the .* window/).length).toBeGreaterThan(0),
      { timeout: 3_000 },
    );
    expect(screen.queryByText(/Timed out finding the simulator window/)).toBeNull();
    expect(api.listSimulatorWindowSources).toHaveBeenCalledTimes(1);
  });

  // A verdict from the host is the specific, actionable one — a permission
  // blocker, no session — so it has to survive to the drawer verbatim rather
  // than be replaced by the generic not-found line.
  it("passes the host's own discovery verdict through verbatim", async () => {
    const { api } = installIosSimulatorApi();
    api.listSimulatorWindowSources.mockResolvedValue({
      sources: [],
      windowState: null,
      message: "ADE needs Screen Recording permission to capture the simulator.",
    });

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    await waitFor(
      () => expect(screen.getAllByText(/needs Screen Recording permission/).length).toBeGreaterThan(0),
      { timeout: 3_000 },
    );
    expect(screen.queryByText(/ADE could not find the .* window/)).toBeNull();
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

    await screen.findByText("Simulator minimized");

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

  it("offers the matching System Settings pane when Screen Recording is denied", async () => {
    const user = userEvent.setup();
    const { api } = installIosSimulatorApi({
      windowState: {
        appRunning: true,
        visible: true,
        windowCount: 1,
        minimizedWindowCount: 0,
        capturable: false,
        issue: "screen-recording-permission",
        message: "Screen Recording is off for ADE. Turn it on to see the live view.",
      } as IosSimulatorWindowState,
    });

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    await screen.findByText("Screen recording");
    await user.click(screen.getByRole("button", { name: "Open settings" }));

    await waitFor(() => {
      expect(api.openSystemSettings).toHaveBeenCalledWith({ pane: "screen-recording" });
    });
  });

  it("says why a refused Reveal did nothing instead of reporting success", async () => {
    const user = userEvent.setup();
    const { api } = installIosSimulatorApi({
      windowState: {
        appRunning: true,
        visible: false,
        windowCount: 1,
        minimizedWindowCount: 0,
        capturable: false,
        issue: "hidden",
        message: "The simulator window is hidden.",
      },
      revealResult: { ok: false, message: "Automation is off for ADE." },
    });

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    await screen.findByText("Simulator hidden");
    await user.click(screen.getByRole("button", { name: "Reveal" }));

    await waitFor(() => expect(api.revealSimulator).toHaveBeenCalled());
    // The window never moved, so the overlay must not fall silent.
    expect(await screen.findByText("Automation is off for ADE.")).toBeTruthy();
  });

  it("keeps launch progress on screen after the launch call stops driving it", async () => {
    const { emit } = installIosSimulatorApi();

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    const progress = (step: string, status: string, message: string) => ({
      launchId: "launch-1",
      step,
      status,
      message,
      detail: null,
      updatedAt: new Date().toISOString(),
    });

    act(() => {
      emit({ type: "launch-progress", progress: progress("resolve-device", "complete", "Device ready") } as never);
      emit({ type: "launch-progress", progress: progress("build-app", "running", "Building") } as never);
    });

    // No launch() call is in flight here: this is the transport-timeout case,
    // where the host keeps reporting but the renderer's promise already settled.
    expect(await screen.findByText("Build")).toBeTruthy();

    act(() => {
      emit({ type: "session-released", session: null } as never);
    });

    // A release mid-launch used to wipe the only diagnosis available.
    expect(screen.getByText("Build")).toBeTruthy();
  });

  // Launch progress broadcasts project-wide. A second drawer used to render the
  // other chat's steps over its own live view — and keep rendering them once
  // that launch failed, because progress only clears when THIS panel launches.
  it("ignores launch progress stamped for another chat", async () => {
    const { emit } = installIosSimulatorApi();

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    const progress = (chatSessionId: string | null, message: string) => ({
      launchId: `launch-${chatSessionId ?? "none"}`,
      step: "build-app",
      status: "running",
      message,
      detail: null,
      chatSessionId,
      updatedAt: new Date().toISOString(),
    });

    act(() => {
      emit({ type: "launch-progress", progress: progress("chat-2", "Building someone else's app") } as never);
    });

    await waitFor(() => expect(screen.queryByText("Build")).toBeNull());

    // An older host stamps nothing; dropping that would leave the stepper blank.
    act(() => {
      emit({ type: "launch-progress", progress: progress(null, "Building") } as never);
    });

    expect(await screen.findByText("Build")).toBeTruthy();
  });

  // The Work sidebar's iOS tab is lane-scoped but still carries a sessionId to
  // route its own actions. Reading that id here left it with a blank stepper
  // for the whole of any launch another chat in the lane started.
  it("accepts another chat's launch progress when chat ownership is ignored", async () => {
    const { emit } = installIosSimulatorApi();

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        laneId="lane-1"
        projectRoot="/tmp/project"
        ignoreChatOwnership
        onAddContext={vi.fn()}
      />,
    );

    act(() => {
      emit({
        type: "launch-progress",
        progress: {
          launchId: "launch-chat-2",
          step: "build-app",
          status: "running",
          message: "Building the lane's app",
          detail: null,
          chatSessionId: "chat-2",
          laneId: "lane-1",
          updatedAt: new Date().toISOString(),
        },
      } as never);
    });

    expect(await screen.findByText("Build")).toBeTruthy();

    // Lane scoping is the only scoping this surface wants, and it still applies.
    act(() => {
      emit({
        type: "launch-progress",
        progress: {
          launchId: "launch-other-lane",
          step: "install-app",
          status: "running",
          message: "Installing another lane's app",
          detail: null,
          chatSessionId: "chat-3",
          laneId: "lane-2",
          updatedAt: new Date().toISOString(),
        },
      } as never);
    });

    await waitFor(() => expect(screen.queryByText("Install")).toBeNull());
  });

  // buildIosSimToolChips(null) reads "Xcode missing / Runtime missing", so an
  // unguarded row accused a healthy Mac on every drawer open.
  it("does not show tool chips before the first status lands", async () => {
    // Controls-only gap: a warn, not a missing, so the chip row stays in the
    // header instead of moving into the unsupported card.
    const controlsWarnStatus: IosSimulatorStatus = {
      ...activeStatus,
      tools: activeStatus.tools.map((tool) =>
        tool.name === "idb" ? { ...tool, available: false, detail: "missing", installHint: "brew install idb" } : tool
      ),
    };
    let resolveStatus: ((status: IosSimulatorStatus) => void) | null = null;
    const { api } = installIosSimulatorApi();
    api.getStatus.mockImplementation(() => new Promise<IosSimulatorStatus>((resolve) => {
      resolveStatus = resolve;
    }));

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    await waitFor(() => expect(api.getStatus).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /Xcode/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Runtime/ })).toBeNull();

    await act(async () => {
      resolveStatus?.(controlsWarnStatus);
      await Promise.resolve();
    });

    expect(await screen.findByRole("button", { name: /Controls/ })).toBeTruthy();
  });

  // Shutdown enforces the same single-owner rule as launch. A drawer that does
  // not name itself is an anonymous caller, so its own Stop button came back
  // refused as "owned by chat <itself>".
  it("names the owning chat when stopping so the drawer is not refused its own session", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { api } = installIosSimulatorApi();
    api.shutdown.mockResolvedValue({ ok: true });

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByTestId("ios-pane-stop"));

    await waitFor(() => expect(api.shutdown).toHaveBeenCalledWith({ chatSessionId: "chat-1", force: false }, null));
    confirmSpy.mockRestore();
  });

  // The lane-scoped surface hides the ownership card and keeps Stop live for a
  // session another chat owns, so identifying as itself would have it refused
  // by the very rule it is meant to bypass. It says so outright instead of
  // reading the owner's id off `getStatus` and wearing it: impersonation logged
  // the wrong caller, and made "read the owner id, replay it" look like the
  // supported way past the guard.
  it("asks the service to stand the ownership rule down on the lane-scoped surface", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { api } = installIosSimulatorApi();
    api.shutdown.mockResolvedValue({ ok: true });

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-2"
        ignoreChatOwnership
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByTestId("ios-pane-stop"));

    // activeStatus's session is owned by chat-1, not this drawer's chat-2: the
    // drawer names itself and asks for the bypass, rather than answering "I am
    // chat-1".
    await waitFor(() => expect(api.shutdown).toHaveBeenCalledWith({
      chatSessionId: "chat-2",
      force: false,
      ignoreOwnership: true,
    }, null));
    confirmSpy.mockRestore();
  });

  // Launch extras describe one binary. Untagged, the panel's own record of a
  // launch kept accusing every session that came after it — the amber chip sat
  // next to "No simulator running" long after the session it described was
  // gone, and a rebuild inherited the old launch's verdict.
  it("drops the prebuilt chip once the session it described is gone", async () => {
    const idleStatus: IosSimulatorStatus = { ...activeStatus, activeSession: null };
    const launched = { ...activeStatus.activeSession!, id: "session-2", usedInstalledBinary: true };
    const { api } = installIosSimulatorApi({ status: idleStatus });
    api.launch.mockResolvedValue(launched);
    api.shutdown.mockResolvedValue({ ok: true });
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    // The header carries one Launch, the empty body another; either one is the
    // user's own click.
    const launchButton = await screen.findByTestId("ios-pane-launch");
    api.getStatus.mockResolvedValue({ ...activeStatus, activeSession: launched });
    fireEvent.click(launchButton!);

    expect(await screen.findByText("prebuilt")).toBeTruthy();

    api.getStatus.mockResolvedValue(idleStatus);
    fireEvent.click(await screen.findByTestId("ios-pane-stop"));

    await waitFor(() => expect(screen.queryByText("prebuilt")).toBeNull());
    confirmSpy.mockRestore();
  });

  // A failed launch used to pin its stepper over every other mode with no way
  // out: it had no staleness bound, only a fresh launch cleared it, and the
  // Control/Inspect toggle that would leave it lives inside the branches this
  // one sits above.
  it("lets the user close a failed launch stepper and get back to the drawer", async () => {
    const { emit } = installIosSimulatorApi();

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    await waitFor(() => expect(document.querySelector("video")).toBeTruthy());

    act(() => {
      emit({
        type: "launch-progress",
        progress: {
          launchId: "launch-1",
          step: "build-app",
          status: "failed",
          message: "Build failed",
          detail: "error: no such module 'Foo'",
          updatedAt: new Date().toISOString(),
          buildRoot: "/tmp/project",
        },
      } as never);
    });

    expect(await screen.findByText("Build")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => expect(document.querySelector("video")).toBeTruthy());
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  });

  // The header reads the session straight off the status; the live visual only
  // exists three IPC round trips later. Mounting onto an already-running
  // simulator therefore showed the cyan Live chip beside a body claiming "No
  // simulator running" with Launch enabled.
  it("says it is connecting instead of claiming nothing is running", async () => {
    const { api } = installIosSimulatorApi();
    let releaseStartStream: (() => void) | null = null;
    const held = new Promise<void>((resolve) => {
      releaseStartStream = resolve;
    });
    const realStartStream = api.startStream.getMockImplementation()!;
    api.startStream.mockImplementation(async (args: any) => {
      await held;
      return realStartStream(args);
    });

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    // The header already believes there is a session.
    expect(await screen.findByTestId("ios-pane-stop")).toBeTruthy();
    expect(screen.queryByText("Boot a simulator")).toBeNull();
    expect(screen.getByText(/connecting to the simulator/i)).toBeTruthy();

    act(() => releaseStartStream?.());
    await waitFor(() => expect(document.querySelector("video")).toBeTruthy());
  });

  // "Runtime" used to be `simulator_window.available`, which is only "Xcode is
  // installed". A Mac with Xcode and zero iOS runtimes read healthy on all four
  // chips, hid the row entirely, and left Launch enabled with nothing to launch
  // on — while the chip's own "install a runtime" hint was unreachable.
  it("reports the Runtime chip as missing when the machine has no simulator devices", async () => {
    const { api } = installIosSimulatorApi();
    api.listDevices.mockResolvedValue([]);

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    const runtimeChip = await screen.findByRole("button", { name: /Runtime/ });
    await userEvent.setup().click(runtimeChip);

    expect(await screen.findByText(/install an ios runtime/i)).toBeTruthy();
  });

  it("stops the host capture stream when the drawer unmounts", async () => {
    const { api } = installIosSimulatorApi();

    const view = render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    await waitFor(() => expect(api.startStream).toHaveBeenCalled());
    const callsBeforeUnmount = api.stopStream.mock.calls.length;

    view.unmount();

    await waitFor(() => expect(api.stopStream.mock.calls.length).toBeGreaterThan(callsBeforeUnmount));
  });

  // Discovery arms the window-parking follow in Electron main. Nothing on the
  // path production takes released it, so every later ADE window move re-ran the
  // park — whose first act relaunches a Simulator the user had quit.
  it("releases the host window-parking follow when the drawer unmounts", async () => {
    const { api } = installIosSimulatorApi();

    const view = render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    await waitFor(() => expect(api.listSimulatorWindowSources).toHaveBeenCalled());
    expect(api.releaseWindowParking).not.toHaveBeenCalled();

    view.unmount();

    await waitFor(() => expect(api.releaseWindowParking).toHaveBeenCalled());
  });

  // Starting the stream arms the parking follow before discovery runs, and a
  // discovery that fails is terminal — recovery needs a live stream. Without a
  // release the follow kept re-parking Simulator.app on every ADE window move
  // while the drawer said the live view had failed.
  it("releases the host window-parking follow when the live view cannot start", async () => {
    const { api } = installIosSimulatorApi();
    api.listSimulatorWindowSources.mockResolvedValue({
      sources: [],
      windowState: null,
      message: "Screen recording is off for ADE.",
    });

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    await waitFor(() => expect(api.startStream).toHaveBeenCalled());
    await waitFor(() => expect(api.releaseWindowParking).toHaveBeenCalled());
    expect(await screen.findByText(/Could not start the live view/)).toBeTruthy();
  });

  // The host counts holders on a local-only channel, because `startStream`
  // itself is answered by the brain daemon whenever a project is bound and so
  // never reaches the Electron-main code that owns parking. If the panel stops
  // asking for the hold, the count sits at zero and the refcount that protects a
  // second open drawer stops protecting anything.
  it("takes one host parking hold when the live view starts", async () => {
    const { api } = installIosSimulatorApi();

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    await waitFor(() => expect(api.startStream).toHaveBeenCalled());
    await waitFor(() => expect(api.retainWindowParking).toHaveBeenCalledTimes(1));
  });

  // One hold, one release. The give-up path returns the hold but deliberately
  // keeps the stream flagged so unmount still stops it — and unmount used to
  // read that same flag as "you still hold parking" and release a second time.
  // With another drawer open in this window that second release decrements a
  // holder this panel does not own and tears down the other drawer's follow.
  it("releases the parking hold once when the live view fails and the drawer then unmounts", async () => {
    const { api } = installIosSimulatorApi();
    api.listSimulatorWindowSources.mockResolvedValue({
      sources: [],
      windowState: null,
      message: "Screen recording is off for ADE.",
    });

    const view = render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    await waitFor(() => expect(api.retainWindowParking).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(api.releaseWindowParking).toHaveBeenCalledTimes(1));
    const stopCallsBeforeUnmount = api.stopStream.mock.calls.length;

    view.unmount();

    // Unmount still has to stop the host stream — the stream did start — but it
    // must not hand back a hold the give-up path already returned.
    await waitFor(() => expect(api.stopStream.mock.calls.length).toBeGreaterThan(stopCallsBeforeUnmount));
    expect(api.releaseWindowParking).toHaveBeenCalledTimes(1);
  });

  // The host refuses a holder from a window that does not own the parking claim
  // — a second ADE window is capturing. The panel used to record the hold
  // *before* asking, so it believed it held one either way and its teardown
  // issued a real release: one that decrements the incumbent drawer's only
  // holder and tears down a follow still in use.
  it("does not hand back a parking hold the host refused", async () => {
    const { api } = installIosSimulatorApi();
    api.retainWindowParking.mockResolvedValue(false);

    const view = render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    await waitFor(() => expect(api.retainWindowParking).toHaveBeenCalled());
    const stopCallsBeforeUnmount = api.stopStream.mock.calls.length;

    view.unmount();

    await waitFor(() => expect(api.stopStream.mock.calls.length).toBeGreaterThan(stopCallsBeforeUnmount));
    expect(api.releaseWindowParking).not.toHaveBeenCalled();
  });

  // Discovery runs for as long as the host's budget plus the settling
  // AppleScript, so closing the drawer while it still says "Starting the live
  // view" lands React's cleanups first: they find no hold to release, and the
  // start then takes one for a panel that no longer exists. Nothing gave it
  // back, so every later move of that ADE window re-parked — and could reopen —
  // Simulator.app with no drawer open at all, and the leaked count meant no
  // later drawer could ever disarm the follow either.
  it("hands back a parking hold taken after the drawer already unmounted", async () => {
    const { api } = installIosSimulatorApi();
    let resolveSources: ((result: unknown) => void) | null = null;
    api.listSimulatorWindowSources.mockImplementation(() => new Promise((resolve) => {
      resolveSources = resolve;
    }));

    const view = render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    await waitFor(() => expect(api.listSimulatorWindowSources).toHaveBeenCalled());
    // The hold is taken after this sweep answers, which is exactly the window
    // the drawer closes in.
    expect(api.retainWindowParking).not.toHaveBeenCalled();

    view.unmount();

    await act(async () => {
      resolveSources?.({ sources: [simulatorWindowSource], windowState: null, message: null });
      await Promise.resolve();
    });

    await waitFor(() => expect(api.releaseWindowParking).toHaveBeenCalledTimes(1));
    expect(api.retainWindowParking).toHaveBeenCalledTimes(1);
  });

  // An agent runs `ade ios-sim shutdown` while the drawer is still starting the
  // live view. The effect sees the released session, stops the stream and
  // returns — it starts no replacement. The start in flight then resolves, and
  // the host's window capture relaunches Simulator.app and reports a running
  // stream to every other drawer and to the CLI, for a session that is gone.
  // Only the start itself can stop that stream, because nothing replaced it.
  it("stops the stream a superseded start brought up after the session was released", async () => {
    const { api, emit } = installIosSimulatorApi();
    let resolveStart: ((status: IosSimulatorStreamStatus) => void) | null = null;
    api.startStream.mockImplementation(() => new Promise<IosSimulatorStreamStatus>((resolve) => {
      resolveStart = resolve;
    }));

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    await waitFor(() => expect(api.startStream).toHaveBeenCalledTimes(1));
    api.getStatus.mockResolvedValue({ ...activeStatus, activeSession: null });

    await act(async () => {
      emit({ type: "session-released", previousSession: null } as never);
      await Promise.resolve();
    });

    // The drawer's own teardown for the released session.
    await waitFor(() => expect(api.stopStream.mock.calls.length).toBeGreaterThan(1));
    const stopCallsBeforeTheStartResolves = api.stopStream.mock.calls.length;

    await act(async () => {
      resolveStart?.(streamStatus());
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(api.stopStream.mock.calls.length).toBeGreaterThan(stopCallsBeforeTheStartResolves);
    });
    // And it stopped instead of carrying on into discovery.
    expect(api.listSimulatorWindowSources).not.toHaveBeenCalled();
  });

  // The no-frame recovery timer restarts the live view from a detached async
  // body that outlives the mode it was scheduled in. Switching to Inspect stops
  // the renderer view, stops the stream and hands back the parking hold — and
  // the recovery start used to run on regardless, taking a fresh hold and
  // opening a getUserMedia stream that nothing tears down until unmount.
  it("drops a recovery start that a switch to Inspect superseded", async () => {
    const { api, getUserMedia } = installIosSimulatorApi();

    const view = render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    await waitFor(() => expect(api.retainWindowParking).toHaveBeenCalledTimes(1));
    const video = await waitFor(() => {
      const element = document.querySelector("video");
      expect(element).toBeTruthy();
      return element as HTMLVideoElement;
    });

    // The recovery restart hangs on its `startStream`, which is where the drawer
    // leaves Interact.
    let resolveRecoveryStart: ((status: IosSimulatorStreamStatus) => void) | null = null;
    api.startStream.mockImplementation(() => new Promise<IosSimulatorStreamStatus>((resolve) => {
      resolveRecoveryStart = resolve;
    }));

    // Input that produces no frame is what arms recovery: 1.5s to notice the
    // frame never landed, then the 250ms the restart is scheduled behind. Real
    // timers, because faking them here would also fake `waitFor`'s own polling.
    fireEvent.keyDown(video, { key: "a" });
    await act(async () => {
      await new Promise((resolve) => { setTimeout(resolve, 1_900); });
    });
    await waitFor(() => expect(api.startStream).toHaveBeenCalledTimes(2));

    // Into Inspect while that start is still in flight. A restart blanks the
    // live view first, so the in-view Inspect button is gone by now — this is
    // the drawer-mode request every other surface switches modes with.
    view.rerender(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
        drawerModeRequest={{ mode: "inspect", nonce: 1 }}
      />,
    );
    await waitFor(() => expect(api.releaseWindowParking).toHaveBeenCalledTimes(1));

    await act(async () => {
      resolveRecoveryStart?.(streamStatus());
      await Promise.resolve();
    });

    // No second hold, no second capture stream, and nothing swept for a source
    // the drawer has no live view for.
    expect(api.retainWindowParking).toHaveBeenCalledTimes(1);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(api.listSimulatorWindowSources).toHaveBeenCalledTimes(1);
  });
  /* ------------------------------------------------------------------ *
   * Device hub: the tools column
   * ------------------------------------------------------------------ */

  // Preview Lab renders a SwiftUI preview, not the device, so device state has
  // nothing there to act on.
  it("offers the device tools on the simulator surface and not in Preview Lab", async () => {
    installIosSimulatorApi();

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    expect(await screen.findByTestId("ios-pane-tools")).toBeTruthy();

    fireEvent.click(screen.getByTestId("ios-pane-surface"));

    await waitFor(() => expect(screen.queryByTestId("ios-pane-tools")).toBeNull());
  });

  it("opens and closes the device tools column from the chrome", async () => {
    installIosSimulatorApi();

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    const toolsButton = await screen.findByTestId("ios-pane-tools");
    expect(screen.queryByTestId("ios-tools-column")).toBeNull();

    fireEvent.click(toolsButton);
    expect(await screen.findByTestId("ios-tools-column")).toBeTruthy();

    fireEvent.click(toolsButton);
    await waitFor(() => expect(screen.queryByTestId("ios-tools-column")).toBeNull());
  });

  // Reading the device costs nine `simctl` calls, so the read is bound to the
  // column opening rather than to the status poll.
  it("reads the device settings when the column opens and shows what came back", async () => {
    const { api } = installIosSimulatorApi();

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByTestId("ios-pane-tools"));
    await screen.findByTestId("ios-tools-column");

    const appearance = await screen.findByLabelText("Appearance");
    await waitFor(() => expect(appearance.textContent).toContain("Dark"));
    expect(screen.getByRole("switch", { name: "Reduce motion" }).getAttribute("aria-checked")).toBe("true");
    expect(api.getDeviceSettings).toHaveBeenCalledTimes(1);
    expect(api.getDeviceSettings).toHaveBeenCalledWith({ deviceUdid: device.udid }, null);
  });

  it("writes the chosen appearance to the active device", async () => {
    vi.stubGlobal("ResizeObserver", MockMenuResizeObserver);
    const { api } = installIosSimulatorApi();

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByTestId("ios-pane-tools"));
    const appearance = await screen.findByLabelText("Appearance");
    await waitFor(() => expect(appearance.textContent).toContain("Dark"));

    await openToolMenu("Appearance");
    fireEvent.click(await screen.findByText("Light"));

    await waitFor(() => expect(api.setAppearance).toHaveBeenCalledWith({
      deviceUdid: device.udid,
      appearance: "light",
    }, null));
  });

  it("locks every device tool while another chat owns the session", async () => {
    installIosSimulatorApi({
      status: {
        ...activeStatus,
        activeSession: { ...activeStatus.activeSession!, chatSessionId: "chat-2" },
      },
    });

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByTestId("ios-pane-tools"));
    await screen.findByTestId("ios-tools-column");

    expect((await screen.findByLabelText("Appearance") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("Text size") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("Location") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("switch", { name: "Reduce motion" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps the event log running when closing the column fails to stop it", async () => {
    // Closing the column stops the log on the host. The host checks ownership
    // first, so that call can be refused — and clearing the running state
    // anyway left the drawer offering "Start" for a `log stream` that was
    // still running, with no control left that could stop it.
    const { api } = installIosSimulatorApi();

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    const toolsToggle = await screen.findByTestId("ios-pane-tools");
    fireEvent.click(toolsToggle);
    const column = await screen.findByTestId("ios-tools-column");
    fireEvent.click(within(column).getByRole("button", { name: "Start" }));
    await within(column).findByRole("button", { name: "Stop" });

    api.stopEventLog.mockRejectedValue(new Error("Another chat owns the simulator."));
    fireEvent.click(toolsToggle);

    expect(await screen.findByText("Another chat owns the simulator.")).toBeTruthy();
    fireEvent.click(toolsToggle);
    const reopened = await screen.findByTestId("ios-tools-column");
    expect(within(reopened).getByRole("button", { name: "Stop" })).toBeTruthy();
  });

  it("does not let a slow stop turn off the log the reopened column started", async () => {
    // Closing the column stops the log, reopening starts a new one. The stop
    // from the close can still be in flight, and its completion used to clear
    // the running state of the log that had just started — leaving the drawer
    // offering "Start" while `log stream` ran with nothing to stop it.
    const { api } = installIosSimulatorApi();
    let releaseStop: (() => void) | null = null;
    api.stopEventLog.mockImplementation(() => new Promise((resolve) => {
      releaseStop = () => resolve({ ...defaultEventLogPage, running: false, rows: [] });
    }));

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    const toolsToggle = await screen.findByTestId("ios-pane-tools");
    fireEvent.click(toolsToggle);
    const column = await screen.findByTestId("ios-tools-column");
    fireEvent.click(within(column).getByRole("button", { name: "Start" }));
    await within(column).findByRole("button", { name: "Stop" });

    fireEvent.click(toolsToggle);
    fireEvent.click(toolsToggle);
    const reopened = await screen.findByTestId("ios-tools-column");
    await within(reopened).findByRole("button", { name: "Stop" });

    // The stop from the close lands now, after the reopen.
    await act(async () => {
      releaseStop?.();
      await Promise.resolve();
    });

    expect(within(reopened).getByRole("button", { name: "Stop" })).toBeTruthy();
  });

  it("passes the lane-scoped ownership bypass to the event log", async () => {
    // The lane surface drives a simulator it does not own on purpose, and
    // `shutdown` already takes the same bypass. Without it the event log was
    // the one control there that the host refused.
    const { api } = installIosSimulatorApi({
      status: {
        ...activeStatus,
        activeSession: { ...activeStatus.activeSession!, chatSessionId: "chat-2" },
      },
    });

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
        ignoreChatOwnership
      />,
    );

    fireEvent.click(await screen.findByTestId("ios-pane-tools"));
    const column = await screen.findByTestId("ios-tools-column");
    fireEvent.click(within(column).getByRole("button", { name: "Start" }));

    await waitFor(() => expect(api.startEventLog).toHaveBeenCalledWith(
      expect.objectContaining({ force: true }),
      null,
    ));
  });

  // An `ade` row carries the command that reproduces what ADE did, which is the
  // whole reason the log interleaves ADE's own actions with the device's.
  it("starts the event log and copies an ade row's command", async () => {
    const { api, app } = installIosSimulatorApi();

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByTestId("ios-pane-tools"));
    const column = await screen.findByTestId("ios-tools-column");

    fireEvent.click(within(column).getByRole("button", { name: "Start" }));

    // The chat names itself, because the host refuses an event-log start from a
    // chat that does not own the device session.
    await waitFor(() => expect(api.startEventLog).toHaveBeenCalledWith({
      deviceUdid: device.udid,
      bundleId: "com.example.app",
      chatSessionId: expect.any(String),
    }, null));
    expect(await screen.findByText("Event log (2)")).toBeTruthy();

    // Starting the log is a request to read it, so the rows unfold themselves.
    const log = await screen.findByTestId("ios-event-log");
    expect(log.textContent).toContain("Could not load the profile.");

    fireEvent.click(screen.getByTitle("Copy: ade ios-sim ui appearance dark"));

    expect(app.writeClipboardText).toHaveBeenCalledWith("ade ios-sim ui appearance dark");
  });

  /* ------------------------------------------------------------------ *
   * Device hub: the watch ribbon
   * ------------------------------------------------------------------ */

  // The card sits between the chrome and the video and pushes the video down to
  // repeat a sentence the ribbon already says where the eye is.
  it("names the owner on a ribbon over the live view instead of a card above it", async () => {
    const { api } = installIosSimulatorApi({
      status: {
        ...activeStatus,
        activeSession: { ...activeStatus.activeSession!, chatSessionId: "chat-2" },
      },
    });
    api.shutdown.mockResolvedValue({ ok: true });

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    const ribbon = await screen.findByTestId("ios-watch-ribbon");
    expect(ribbon.textContent).toContain("owned by");
    expect(screen.queryByText(/In use by/)).toBeNull();

    // Take over is the card's own path: force the session down, then relaunch
    // here.
    fireEvent.click(within(ribbon).getByRole("button", { name: "Take over" }));

    await waitFor(() => expect(api.shutdown).toHaveBeenCalledWith({
      chatSessionId: "chat-1",
      force: true,
    }, null));
  });

  it("keeps the watch ribbon off Preview Lab", async () => {
    installIosSimulatorApi({
      status: {
        ...activeStatus,
        activeSession: { ...activeStatus.activeSession!, chatSessionId: "chat-2" },
      },
    });

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    await screen.findByTestId("ios-watch-ribbon");

    fireEvent.click(screen.getByTestId("ios-pane-surface"));

    await waitFor(() => expect(screen.queryByTestId("ios-watch-ribbon")).toBeNull());
    // A preview is not the session, so the ribbon has nothing to float over and
    // the card says who owns the simulator instead.
    expect(await screen.findByText(/In use by/)).toBeTruthy();
  });

  /* ------------------------------------------------------------------ *
   * Device hub: the remote live view
   * ------------------------------------------------------------------ */

  // Window capture reads a Simulator window on THIS computer. A chat pinned to
  // another Mac has none, so it had a live view it could never show.
  it("encodes the live view on the host when the chat runs on another machine", async () => {
    chatScopeOverride = { isRemote: true, machineName: "MacBook Pro (97)" };
    const { api } = installIosSimulatorApi();

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    await waitFor(() => expect(api.startStream).toHaveBeenCalledWith({
      deviceUdid: device.udid,
      backend: "idb-h264",
      fps: 30,
    }, null));
    expect(api.listSimulatorWindowSources).not.toHaveBeenCalled();
    expect(screen.queryByText(/Simulator window on this computer/)).toBeNull();
  });

  // The encoder answers on loopback on the simulator's own machine. The desktop
  // reads it through a port forward, so the port it opens is not the port the
  // host reported.
  it("plays the address resolveStreamUrl returned, not the host's own", async () => {
    chatScopeOverride = { isRemote: true, machineName: "MacBook Pro (97)" };
    const { api } = installIosSimulatorApi();
    // The canvas only reaches for the stream when the platform decoder exists,
    // and jsdom has none. The smallest possible pair stands in; the assertion is
    // the address it opens, never a decoded frame.
    vi.stubGlobal("VideoDecoder", class {});
    vi.stubGlobal("EncodedVideoChunk", class {});
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    await waitFor(() => expect(api.resolveStreamUrl).toHaveBeenCalledWith(H264_HOST_URL, null));
    expect(await screen.findByTestId("ios-h264-canvas")).toBeTruthy();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]?.[0]).toBe(H264_FORWARDED_URL);
  });

  it("names the remote machine on the live chip", async () => {
    chatScopeOverride = { isRemote: true, machineName: "MacBook Pro (97)" };
    installIosSimulatorApi();

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    const chip = await screen.findByTestId("ios-live-chip");
    await waitFor(() => expect(chip.textContent).toContain("MacBook Pro (97)"));
  });

  // Local stays on window capture: it hands the compositor's own frames to a
  // video element, which no encode beats.
  it("keeps window capture and the video element for a local chat", async () => {
    const { api } = installIosSimulatorApi();

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    await waitFor(() => expect(document.querySelector("video")).toBeTruthy());

    expect(api.startStream).toHaveBeenCalledWith({
      deviceUdid: device.udid,
      backend: "simulator-window-capture",
      fps: 60,
    }, null);
    expect(api.resolveStreamUrl).not.toHaveBeenCalled();
    expect(screen.queryByTestId("ios-h264-canvas")).toBeNull();
  });

  /* ------------------------------------------------------------------ *
   * Device hub: a device session is a session
   * ------------------------------------------------------------------ */

  // The snapshot is fetched for exactly one number — `screen.scale` — and a tap
  // is divided by it. Without one, every tap on a 3x device lands at a third of
  // where the user clicked.
  it("reads the screen scale for a device session that has no app session", async () => {
    const { api } = installIosSimulatorApi({ status: deviceSessionStatus });

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    await waitFor(() => expect(api.startStream).toHaveBeenCalled());
    await waitFor(() => expect(api.getScreenSnapshot).toHaveBeenCalled());
  });

  it("captures an inspect snapshot for a device session that has no app session", async () => {
    const { api } = installIosSimulatorApi({ status: deviceSessionStatus });

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
        drawerModeRequest={{ mode: "inspect", nonce: 1 }}
      />,
    );

    await waitFor(() => expect(api.getScreenSnapshot).toHaveBeenCalled());
  });

  // Input that produces no frame is what arms recovery: 1.5s to notice the frame
  // never landed, then the 250ms the restart is scheduled behind. Real timers,
  // because faking them here would also fake `waitFor`'s own polling.
  it("restores a device session's live view after input produces no frame", async () => {
    const { api } = installIosSimulatorApi({ status: deviceSessionStatus });

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    const video = await waitFor(() => {
      const element = document.querySelector("video");
      expect(element).toBeTruthy();
      return element as HTMLVideoElement;
    });
    await waitFor(() => expect(api.startStream).toHaveBeenCalledTimes(1));

    fireEvent.keyDown(video, { key: "a" });
    await act(async () => {
      await new Promise((resolve) => { setTimeout(resolve, 1_900); });
    });

    await waitFor(() => expect(api.startStream).toHaveBeenCalledTimes(2));
  });

  /* ------------------------------------------------------------------ *
   * Device hub: restarting the right backend
   * ------------------------------------------------------------------ */

  // Both backends arm the same capture token, so the token cannot say which one
  // is running. A remote chat restarted on window capture reads a Simulator
  // window that is either absent or on the wrong machine.
  it("restarts a remote live view on the host encoder, not on window capture", async () => {
    chatScopeOverride = { isRemote: true, machineName: "MacBook Pro (97)" };
    const { api } = installIosSimulatorApi({
      resolveStreamUrl: { url: null, forwarded: false, error: "The runtime refused the port forward." },
    });

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Restart" }));

    await waitFor(() => expect(api.startStream).toHaveBeenCalledTimes(2));
    expect(api.startStream).toHaveBeenLastCalledWith({
      deviceUdid: device.udid,
      backend: "idb-h264",
      fps: 30,
    }, null);
    expect(api.listSimulatorWindowSources).not.toHaveBeenCalled();
  });

  /* ------------------------------------------------------------------ *
   * Device hub: the host-encoded retry
   * ------------------------------------------------------------------ */

  // A reconnect of the runtime closes the SSH forward, and rebuilding it can
  // take more than one attempt. The retry used to write no state when a
  // re-resolve came back empty, so its own effect never re-ran.
  it("keeps retrying a remote live view after a re-resolve returns no address", async () => {
    chatScopeOverride = { isRemote: true, machineName: "MacBook Pro (97)" };
    const { api } = installIosSimulatorApi({
      resolveStreamUrl: { url: null, forwarded: false, error: "The runtime refused the port forward." },
    });

    // Fake timers from before the render: the retry is a `setTimeout` armed
    // during mount, and a clock installed afterwards would never own it.
    vi.useFakeTimers();
    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    await settleFakeTimers();
    expect(api.resolveStreamUrl).toHaveBeenCalledTimes(1);

    await settleFakeTimers(4_200);
    expect(api.resolveStreamUrl).toHaveBeenCalledTimes(2);

    await settleFakeTimers(4_200);
    expect(api.resolveStreamUrl).toHaveBeenCalledTimes(3);
  });

  // The other half of the same rule: a forward that is refused for good must
  // not be asked forever.
  it("stops retrying a remote live view once the attempt budget is spent", async () => {
    chatScopeOverride = { isRemote: true, machineName: "MacBook Pro (97)" };
    const { api } = installIosSimulatorApi({
      resolveStreamUrl: { url: null, forwarded: false, error: "The runtime refused the port forward." },
    });

    vi.useFakeTimers();
    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    await settleFakeTimers();
    expect(api.resolveStreamUrl).toHaveBeenCalledTimes(1);

    // Eight retry windows for a budget of five. React commits the failed
    // attempt at the end of each `act`, so the next window is what arms the
    // retry after it — one long advance would only ever run the first.
    for (let window = 0; window < 8; window += 1) {
      await settleFakeTimers(4_200);
    }

    // One start plus five retries, and nothing after.
    expect(api.resolveStreamUrl).toHaveBeenCalledTimes(6);
  });

  /* ------------------------------------------------------------------ *
   * Device hub: the event log cursor
   * ------------------------------------------------------------------ */

  // `startEventLog` answers with a page that already holds rows. Leaving the
  // cursor at zero made the first poll ask for the whole log again and append
  // every row a second time.
  it("does not replay the event log's first page on the first poll", async () => {
    const { api } = installIosSimulatorApi();

    vi.useFakeTimers();
    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    await settleFakeTimers();
    fireEvent.click(screen.getByTestId("ios-pane-tools"));
    await settleFakeTimers();
    fireEvent.click(within(screen.getByTestId("ios-tools-column")).getByRole("button", { name: "Start" }));
    await settleFakeTimers();
    expect(screen.getByText("Event log (2)")).toBeTruthy();

    // One poll interval past the start page.
    await settleFakeTimers(1_800);

    expect(api.getEventLog).toHaveBeenCalled();
    expect(api.getEventLog.mock.calls[0]?.[0]).toMatchObject({ sinceId: 2 });
    expect(screen.getByText("Event log (2)")).toBeTruthy();
  });

  /* ------------------------------------------------------------------ *
   * Device hub: the tools column and Preview Lab
   * ------------------------------------------------------------------ */

  // The chrome hides the toggle in Preview Lab, so a column left open there had
  // no control that could close it and kept polling the device behind it.
  it("hides an open device tools column in Preview Lab and brings it back after", async () => {
    installIosSimulatorApi();

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByTestId("ios-pane-tools"));
    expect(await screen.findByTestId("ios-tools-column")).toBeTruthy();

    fireEvent.click(screen.getByTestId("ios-pane-surface"));
    await waitFor(() => expect(screen.queryByTestId("ios-tools-column")).toBeNull());

    fireEvent.click(screen.getByTestId("ios-pane-surface"));
    expect(await screen.findByTestId("ios-tools-column")).toBeTruthy();
  });

  it("says why a remote live view has no address instead of showing a blank frame", async () => {
    chatScopeOverride = { isRemote: true, machineName: "MacBook Pro (97)" };
    installIosSimulatorApi({
      resolveStreamUrl: { url: null, forwarded: false, error: "The runtime refused the port forward." },
    });

    render(
      <ChatIosSimulatorPanel
        sessionId="chat-1"
        projectRoot="/tmp/project"
        onAddContext={vi.fn()}
      />,
    );

    expect(await screen.findByText(/The runtime refused the port forward\./)).toBeTruthy();
    expect(screen.queryByTestId("ios-h264-canvas")).toBeNull();
  });

});
