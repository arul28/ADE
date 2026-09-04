/**
 * A scripted `window.adePlugin`, and a log of everything the page asked it.
 *
 * The seam test's whole point is that the plugin is two programs joined by a
 * named contract: a page that draws, and a child process that holds the
 * `ios_simulator` domain. This fake IS that contract, written out — every action
 * id the page may invoke, with the answer the child would give, plus the two
 * `hostEngine` verbs the host answers directly.
 *
 * A page that calls an id this file does not script THROWS BY NAME rather than
 * finding a helpful stub. That is the only way the test can prove the seam
 * instead of proving that the page renders.
 */

import type {
  AdePluginBridge,
  HostEngineRect,
  PluginWebviewChangeEvent,
  PluginWebviewConfirm,
  PluginWebviewContext,
  PluginWebviewThemeSnapshot,
  PluginWebviewToast,
} from "../src/bridge";
import type {
  IosScreenElement,
  IosSimulatorDevice,
  IosSimulatorLaunchTarget,
  IosSimulatorPreviewCapability,
  IosSimulatorPreviewMatch,
  IosSimulatorPreviewTarget,
  IosSimulatorSession,
  IosSimulatorStatus,
  IosSimulatorStreamStatus,
} from "../src/types";

/** One thing the page asked the host for. */
export type BridgeCall = { method: string; args: Record<string, unknown> };

export type FakeBridge = {
  bridge: AdePluginBridge;
  /** Every call, in order. `invoke` is logged as `invoke:<action>`. */
  calls: BridgeCall[];
  callsTo: (method: string) => BridgeCall[];
  lastCall: (method: string) => BridgeCall | undefined;
  /** Replace one action's answer mid-walk. */
  setAction: (action: string, handler: (args: Record<string, unknown>) => unknown) => void;
  /** The session the scripted child reports. Launch and shutdown move it. */
  session: IosSimulatorSession | null;
  /** Push a `changed` or `theme` event at the page. */
  emit: (event: "changed" | "theme", payload: unknown) => void;
  /** Every collection write, as `collection/key`. */
  collections: Map<string, unknown>;
  /** The rect the host was last told to paint, or null after a release. */
  placedRect: HostEngineRect | null;
};

export const FAKE_DEVICE: IosSimulatorDevice = {
  udid: "UDID-16",
  name: "iPhone 16",
  runtime: "iOS 18.2",
  state: "Booted",
  isAvailable: true,
};

export const FAKE_DEVICE_ALT: IosSimulatorDevice = {
  udid: "UDID-SE",
  name: "iPhone SE",
  runtime: "iOS 18.2",
  state: "Shutdown",
  isAvailable: true,
};

export const FAKE_TARGET: IosSimulatorLaunchTarget = {
  id: "target-app",
  kind: "project",
  name: "Ade",
  bundleId: "dev.ade.app",
  detail: "Ade.xcodeproj",
  projectPath: "/repo/Ade.xcodeproj",
  scheme: "Ade",
  productName: "Ade",
  appTargetId: "PBX-1",
  appBundlePath: null,
  installed: false,
  canBuild: true,
  canLaunch: true,
  source: "xcode-project",
};

export const FAKE_TARGET_ALT: IosSimulatorLaunchTarget = {
  ...FAKE_TARGET,
  id: "target-widget",
  name: "AdeWidget",
  bundleId: "dev.ade.app.widget",
  detail: "Ade.xcodeproj",
};

/** Healthy on all four chips, so the pane is never behind the unsupported card. */
const HEALTHY_TOOLS: IosSimulatorStatus["tools"] = [
  { name: "xcrun", available: true, detail: "", installHint: "" },
  { name: "xcodebuild", available: true, detail: "", installHint: "" },
  { name: "simulator_window", available: true, detail: "", installHint: "" },
  { name: "idb", available: true, detail: "", installHint: "" },
  { name: "idb_companion", available: true, detail: "", installHint: "" },
];

export function fakeSession(overrides: Partial<IosSimulatorSession> = {}): IosSimulatorSession {
  return {
    id: "sim-session-1",
    deviceUdid: FAKE_DEVICE.udid,
    deviceName: FAKE_DEVICE.name,
    bundleId: "dev.ade.app",
    appName: "Ade",
    appBundlePath: "/derived/Ade.app",
    targetId: FAKE_TARGET.id,
    projectRoot: "/repo",
    laneId: null,
    chatSessionId: "chat-1",
    mode: "live",
    bridgeUrl: null,
    startedAt: "2026-09-03T10:00:00.000Z",
    claimedAt: "2026-09-03T10:00:00.000Z",
    buildRoot: "/repo",
    usedInstalledBinary: false,
    ...overrides,
  };
}

export const FAKE_ELEMENT: IosScreenElement = {
  id: "element-1",
  source: "ade-inspector",
  layer: "app",
  label: "Continue",
  value: null,
  role: "Button",
  elementType: "Button",
  identifier: "continue-button",
  frame: { x: 20, y: 400, width: 200, height: 44 },
  pixelFrame: { x: 60, y: 1200, width: 600, height: 132 },
  componentId: "ContinueButton",
  sourceFile: "Sources/ContentView.swift",
  sourceLine: 42,
};

const FAKE_PREVIEW_TARGET: IosSimulatorPreviewTarget = {
  id: "preview-1",
  title: "ContentView_Preview",
  sourceFile: "Sources/ContentView.swift",
  sourceFilePath: "Sources/ContentView.swift",
  absoluteSourceFile: "/repo/Sources/ContentView.swift",
  sourceLine: 88,
  previewDefinitionIndexInFile: 0,
  kind: "preview-macro",
  proximity: "selected-file",
};

const FAKE_PREVIEW_CAPABILITY: IosSimulatorPreviewCapability = {
  platform: "darwin",
  supported: true,
  docsUrl: "https://developer.apple.com/documentation/xcode/example",
  xcodeVersion: "16.2",
  mcpbridgeAvailable: true,
  xcodeRunning: true,
  selectedWindow: { tabIdentifier: "tab-1", title: "Ade", workspacePath: "/repo/Ade.xcodeproj" },
  setupSteps: [],
  error: null,
  checkedAt: "2026-09-03T10:00:00.000Z",
};

const FAKE_PREVIEW_MATCH: IosSimulatorPreviewMatch = {
  status: "matched",
  target: FAKE_PREVIEW_TARGET,
  confidence: "exact",
  reason: "The selected element's source file has a #Preview.",
  selectedSourceFile: "Sources/ContentView.swift",
  selectedSourceLine: 42,
  suggestedTitle: "ContentView_Preview",
  suggestedSourceFile: "Sources/ContentView.swift",
  suggestedSourceFilePath: "Sources/ContentView.swift",
};

const FAKE_STREAM: IosSimulatorStreamStatus = {
  deviceUdid: FAKE_DEVICE.udid,
  running: true,
  backend: "simulator-window-capture",
  fps: null,
  targetFps: 60,
  startedAt: "2026-09-03T10:00:01.000Z",
  lastFrameAt: null,
  lastError: null,
  streamUrl: null,
  message: null,
};

export type FakeBridgeOptions = {
  /** Start with a running session, for the tests that do not walk the launch. */
  live?: boolean;
  /** Start with the session owned by another chat, for the ownership card. */
  ownedByOtherChat?: boolean;
  /** Drop `hostEngine` entirely, for the degrade test. */
  withoutHostEngine?: boolean;
  /** Drop `ui.openPathInEditor`, so the guard in `host/ui.ts` is exercised. */
  withoutEditor?: boolean;
  /** Devices this machine reports. Empty is a real state the pane draws. */
  devices?: IosSimulatorDevice[];
  targets?: IosSimulatorLaunchTarget[];
};

/**
 * Build the fake and install it on `window`.
 *
 * Every id in `page/src/host/actions.ts` is scripted below. An id that is not
 * throws `No such plugin action: <id>` — the same shape the real child answers
 * an unknown id with, so a page reaching for a verb the plugin does not define
 * fails here rather than in the product.
 */
export function installFakeBridge(options: FakeBridgeOptions = {}): FakeBridge {
  const calls: BridgeCall[] = [];
  const collections = new Map<string, unknown>();
  const listeners: Record<string, Set<(payload: unknown) => void>> = {
    changed: new Set(),
    theme: new Set(),
  };

  const state: {
    session: IosSimulatorSession | null;
    placedRect: HostEngineRect | null;
  } = {
    session: options.live || options.ownedByOtherChat
      ? fakeSession(options.ownedByOtherChat ? { chatSessionId: "chat-other", laneId: "lane-b" } : {})
      : null,
    placedRect: null,
  };

  const devices = options.devices ?? [FAKE_DEVICE, FAKE_DEVICE_ALT];
  const targets = options.targets ?? [FAKE_TARGET, FAKE_TARGET_ALT];

  function record(method: string, args: Record<string, unknown>): void {
    calls.push({ method, args });
  }

  function status(): IosSimulatorStatus {
    return {
      platform: "darwin",
      supported: true,
      tools: HEALTHY_TOOLS,
      activeDevice: devices[0] ?? null,
      activeSession: state.session,
    };
  }

  const actions: Record<string, (args: Record<string, unknown>) => unknown> = {
    /* Reads that degrade. */
    pageStatus: () => status(),
    pageDevices: () => devices,
    pageLaunchTargets: () => targets,
    pageStreamStatus: () => (state.session ? FAKE_STREAM : { ...FAKE_STREAM, running: false }),
    pagePreviewCapability: () => FAKE_PREVIEW_CAPABILITY,
    pagePreviewTargets: () => [FAKE_PREVIEW_TARGET],

    /* Reads that reject. */
    pageScreenSnapshot: () => ({
      deviceUdid: FAKE_DEVICE.udid,
      capturedAt: "2026-09-03T10:00:02.000Z",
      screen: { width: 393, height: 852, scale: 3 },
      elements: [FAKE_ELEMENT],
      hitElement: FAKE_ELEMENT,
    }),
    pageInspectorSnapshot: () => ({ elements: 1, generatedAt: "2026-09-03T10:00:02.000Z" }),
    pageScreenshot: () => ({
      deviceUdid: FAKE_DEVICE.udid,
      dataUrl: "data:image/png;base64,AAAA",
      filePath: "/repo/shot.png",
      width: 393,
      height: 852,
      capturedAt: "2026-09-03T10:00:02.000Z",
    }),
    pageResolvePreviewMatch: () => FAKE_PREVIEW_MATCH,

    /* The session. */
    pageLaunch: () => {
      state.session = fakeSession();
      return { ok: true, session: state.session, usedInstalledBinary: false, message: "Launched." };
    },
    pageShutdown: () => {
      state.session = null;
      return { ok: true, released: true, message: "Stopped." };
    },
    pageAttachChat: (args) => {
      if (args.takeOver === true) {
        state.session = fakeSession({ chatSessionId: "chat-1" });
        return { ok: true, session: state.session, message: "Took the session over." };
      }
      return { ok: true, session: state.session, message: "Attached." };
    },

    /* The stream. */
    pageStartStream: () => ({ ok: true, status: FAKE_STREAM, message: null }),
    pageStopStream: () => ({ ok: true, status: { ...FAKE_STREAM, running: false }, message: null }),

    /* Control. */
    pageTap: () => ({ ok: true, message: null }),
    pageTypeText: () => ({ ok: true, message: null }),
    pageDrag: () => ({ ok: true, message: null }),
    pageSwipe: () => ({ ok: true, message: null }),

    /* Inspect. */
    pageSelectPoint: () => ({ ok: true, element: FAKE_ELEMENT, source: "ade-inspector", message: null }),
    pageInspectPoint: () => ({
      ok: true,
      result: { element: FAKE_ELEMENT, source: "ade-inspector" },
      message: null,
    }),

    /* Preview Lab. */
    pageEnsurePreviewWorkspace: () => ({
      ok: true,
      capability: FAKE_PREVIEW_CAPABILITY,
      opened: false,
      path: "/repo/Ade.xcodeproj",
      message: null,
    }),
    pageRenderPreview: () => ({
      ok: true,
      preview: {
        ok: true,
        dataUrl: "data:image/png;base64,BBBB",
        width: 393,
        height: 852,
        renderedAt: "2026-09-03T10:00:03.000Z",
        error: null,
      },
      message: null,
    }),
    pageRenderCurrentPreview: () => ({
      ok: true,
      preview: {
        ok: true,
        dataUrl: "data:image/png;base64,CCCC",
        width: 393,
        height: 852,
        renderedAt: "2026-09-03T10:00:04.000Z",
        error: null,
      },
      message: null,
    }),
    pageOpenPreviewWorkspace: () => ({ ok: true, path: "/repo/Ade.xcodeproj", message: null }),
  };

  const bridge: AdePluginBridge = {
    version: 2,
    pluginId: "ade-ios-sim",
    context: null,
    collections: {
      async get(collection: string, key: string) {
        record("collections.get", { collection, key });
        return collections.get(`${collection}/${key}`) ?? null;
      },
      async put(collection: string, key: string, value: unknown) {
        record("collections.put", { collection, key, value });
        collections.set(`${collection}/${key}`, value);
      },
      async list(collection: string) {
        record("collections.list", { collection });
        return [];
      },
    },
    async invoke(action: string, args?: Record<string, unknown>) {
      record(`invoke:${action}`, args ?? {});
      const handler = actions[action];
      // The whole point of the fake. An unscripted id is a page reaching for a
      // verb the plugin does not define, and it must fail by name.
      if (!handler) throw new Error(`No such plugin action: ${action}`);
      return handler(args ?? {});
    },
    config: {
      async get() {
        record("config.get", {});
        return {};
      },
      async set() {
        record("config.set", {});
        return {};
      },
    },
    events: {
      on(event: string, listener: (payload: never) => void) {
        const set = listeners[event];
        if (!set) return () => {};
        set.add(listener as (payload: unknown) => void);
        return () => set.delete(listener as (payload: unknown) => void);
      },
    } as AdePluginBridge["events"],
    async openDeeplink(url: string) {
      record("openDeeplink", { url });
    },
    surface: {
      async close() {
        record("surface.close", {});
      },
    },
    ui: {
      async toast(next: PluginWebviewToast) {
        record("ui.toast", next as unknown as Record<string, unknown>);
        return { id: `toast-${calls.length}` };
      },
      async dismissToast(id: string) {
        record("ui.dismissToast", { id });
      },
      async confirm(request: PluginWebviewConfirm) {
        record("ui.confirm", request as unknown as Record<string, unknown>);
        // The reader always confirms here; a dismissal is its own test.
        return true;
      },
      // Synchronous and void, exactly as the bridge declares it.
      resize(size: { height: number }) {
        record("ui.resize", size as unknown as Record<string, unknown>);
      },
      ...(options.withoutEditor
        ? {}
        : {
          async openPathInEditor(request: {
            rootPath: string;
            relativePath?: string;
            target: string;
          }) {
            record("ui.openPathInEditor", request as unknown as Record<string, unknown>);
          },
        }),
    },
    clipboard: {
      async read() {
        record("clipboard.read", {});
        return "";
      },
      async write(text: string) {
        record("clipboard.write", { text });
      },
    },
    theme: {
      async get() {
        record("theme.get", {});
        return { scheme: "dark", tokens: {} } as PluginWebviewThemeSnapshot;
      },
    },
    // The stubbed platform contract. Dropped entirely under
    // `withoutHostEngine`, which is what a host with no engine actually looks
    // like — not a member that throws.
    ...(options.withoutHostEngine
      ? {}
      : {
        hostEngine: {
          async place(placement: { engineId: string; rect: HostEngineRect }) {
            record("hostEngine.place", placement as unknown as Record<string, unknown>);
            state.placedRect = placement.rect;
          },
          async release() {
            record("hostEngine.release", {});
            state.placedRect = null;
          },
        },
      }),
  };

  (window as unknown as { adePlugin?: AdePluginBridge }).adePlugin = bridge;

  return {
    bridge,
    calls,
    callsTo: (method) => calls.filter((call) => call.method === method),
    lastCall: (method) => [...calls].reverse().find((call) => call.method === method),
    setAction: (action, handler) => {
      actions[action] = handler;
    },
    get session() {
      return state.session;
    },
    get placedRect() {
      return state.placedRect;
    },
    emit: (event, payload) => {
      for (const listener of listeners[event] ?? []) {
        listener(payload as PluginWebviewChangeEvent & PluginWebviewThemeSnapshot);
      }
    },
    collections,
  };
}

export function uninstallFakeBridge(): void {
  delete (window as unknown as { adePlugin?: AdePluginBridge }).adePlugin;
}

/** A `pane` context, which is how both sockets open this page. */
export function paneContext(overrides: Partial<PluginWebviewContext> = {}): PluginWebviewContext {
  return {
    subject: { kind: "chat", id: "chat-1" },
    surfaceId: "sim",
    placement: "pane",
    project: { projectId: "project-1", root: "/repo", binding: "local" },
    ...overrides,
  };
}
