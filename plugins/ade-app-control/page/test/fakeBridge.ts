/**
 * A scripted `window.adePlugin`, and a log of everything the page asked it.
 *
 * The seam test's whole point is that the plugin and its page are now two
 * programs joined by a named contract. This fake IS that contract, written out:
 * every action id the page may invoke, with the answer the child would give. A
 * page that calls an id this file does not script fails the test rather than
 * finding a helpful stub — which is the only way the test can prove the seam,
 * instead of proving that the page renders.
 *
 * `hostEngine` is scripted the same way and for a sharper reason: the platform
 * half is landing in parallel, so nothing in the repo would catch a page that
 * called `place` with the wrong engine id or a rect in the wrong units. The
 * recorded calls are the only check there is until the host answers one.
 */

import type {
  AdePluginBridge,
  PluginWebviewChangeEvent,
  PluginWebviewConfirm,
  PluginWebviewContext,
  PluginWebviewEngineRect,
  PluginWebviewThemeSnapshot,
  PluginWebviewToast,
} from "../src/bridge";
import type {
  AppControlContextItem,
  AppControlElement,
  AppControlSession,
  AppControlSnapshot,
  AppControlStatus,
  AppControlTarget,
} from "../src/types";

/** One thing the page asked the host for. */
export type BridgeCall = { method: string; args: Record<string, unknown> };

export type FakeBridge = {
  bridge: AdePluginBridge;
  /** Every call, in order. `invoke` is logged as `invoke:<action>`. */
  calls: BridgeCall[];
  /** The calls for one method, in order. */
  callsTo: (method: string) => BridgeCall[];
  /** The last call to one method, or undefined. */
  lastCall: (method: string) => BridgeCall | undefined;
  /** Replace one action's answer mid-walk. */
  setAction: (action: string, handler: (args: Record<string, unknown>) => unknown) => void;
  /** The session the scripted child reports. Launch and connect flip it. */
  session: AppControlSession | null;
  /** Push a `changed` or `theme` event at the page. */
  emit: (event: "changed" | "theme", payload: unknown) => void;
  /** Every collection write, as `collection/key`. */
  collections: Map<string, unknown>;
};

export function fakeSession(overrides: Partial<AppControlSession> = {}): AppControlSession {
  return {
    id: "session-1",
    appKind: "electron",
    label: "pnpm dev",
    projectRoot: "/repo",
    laneId: null,
    cwd: "/repo",
    command: "pnpm dev",
    pid: 4242,
    terminalSessionId: "terminal-1",
    terminalPtyId: "pty-1",
    cdpPort: 9222,
    cdpEndpoint: null,
    cdpTargetId: null,
    provider: "cdp",
    chatSessionId: null,
    startedAt: "2026-09-03T10:00:00.000Z",
    connectedAt: null,
    status: "starting",
    lastError: null,
    ...overrides,
  };
}

export function fakeElement(overrides: Partial<AppControlElement> = {}): AppControlElement {
  return {
    id: "element-1",
    ref: "ref-1",
    provider: "cdp",
    tagName: "button",
    role: "button",
    label: "Save",
    value: null,
    selector: "#save",
    testId: "save-button",
    frame: { x: 10, y: 20, width: 80, height: 24 },
    pixelFrame: { x: 20, y: 40, width: 160, height: 48 },
    metadata: { sourceFile: "src/App.tsx", sourceLine: 42 },
    ...overrides,
  };
}

function fakeSnapshot(session: AppControlSession | null, elements: AppControlElement[]): AppControlSnapshot {
  return {
    session,
    capturedAt: "2026-09-03T10:01:00.000Z",
    screen: { width: 2560, height: 1600, scale: 2, viewportWidth: 1280, viewportHeight: 800, scaleX: 2, scaleY: 2 },
    elements,
    hitElement: elements[0] ?? null,
    providers: [{ provider: "cdp", available: true, elementCount: elements.length }],
    url: "http://localhost:5173/",
    title: "ADE dev",
  };
}

function fakeContextItem(): AppControlContextItem {
  return {
    kind: "app_control_element",
    id: "context-1",
    appKind: "electron",
    sessionId: "session-1",
    provider: "cdp",
    componentId: "App/Save",
    sourceFile: "src/App.tsx",
    sourceLine: 42,
    frame: { x: 10, y: 20, width: 80, height: 24 },
    metadata: {},
    selectedAt: "2026-09-03T10:02:00.000Z",
  };
}

/**
 * Build the fake and install it on `window`.
 *
 * The bridge starts with NO session, which is the state a fresh pane is in and
 * the first step of the walk. `engine: false` builds a host with no
 * `hostEngine` at all — the degradation case, which must draw a message and
 * never throw.
 */
export function installFakeBridge(options: {
  elements?: AppControlElement[];
  targets?: AppControlTarget[];
  context?: Partial<PluginWebviewContext>;
  /** Start with a connected session, for the tests that do not walk the launch. */
  connected?: boolean;
  /** Whether this host can paint a builtin engine. Default true. */
  engine?: boolean;
  /** What the child reports as blocking this machine. */
  disabledReason?: string | null;
} = {}): FakeBridge {
  const elements = options.elements ?? [fakeElement()];
  const targets = options.targets ?? [
    { id: "target-a", title: "ADE", url: "http://localhost:5173/", type: "page", active: true },
    { id: "target-b", title: "Devtools", url: "devtools://devtools/", type: "page", active: false },
  ];
  const calls: BridgeCall[] = [];
  const collections = new Map<string, unknown>();
  const listeners: Record<string, Set<(payload: unknown) => void>> = {
    changed: new Set(),
    theme: new Set(),
  };

  const state = {
    session: options.connected
      ? fakeSession({ status: "connected", cdpEndpoint: "ws://127.0.0.1:9222/x", cdpTargetId: "target-a", connectedAt: "2026-09-03T10:00:30.000Z" })
      : (null as AppControlSession | null),
  };

  function record(method: string, args: Record<string, unknown>): void {
    calls.push({ method, args });
  }

  const status = (): AppControlStatus => ({
    platform: "darwin",
    supported: true,
    activeSession: state.session,
    providers: [{ provider: "cdp", available: true }],
    disabledReason: options.disabledReason ?? null,
  });

  /**
   * Every id the page may invoke, and nothing else.
   *
   * The list is the contract. An id missing here is an id `pageActions.js` has
   * that the page does not use, or — the failure this catches — an id the page
   * uses that the child never grew.
   */
  const actions: Record<string, (args: Record<string, unknown>) => unknown> = {
    pageStatus: () => status(),
    pageTargets: () => (state.session?.status === "connected" ? targets : []),
    pageSnapshot: () => fakeSnapshot(state.session, elements),
    pageLaunch: () => {
      state.session = fakeSession({ status: "starting" });
      return { ok: true, session: state.session };
    },
    pageConnect: () => {
      state.session = fakeSession({
        status: "connected",
        cdpEndpoint: "ws://127.0.0.1:9222/x",
        cdpTargetId: "target-a",
        connectedAt: "2026-09-03T10:00:30.000Z",
      });
      return { ok: true, session: state.session };
    },
    pageStop: () => {
      state.session = null;
      return { ok: true };
    },
    pageAttachTarget: (args) => {
      state.session = fakeSession({
        status: "connected",
        cdpEndpoint: "ws://127.0.0.1:9222/x",
        cdpTargetId: String(args.targetId),
        connectedAt: "2026-09-03T10:00:30.000Z",
      });
      return { ok: true, session: state.session };
    },
    pageFocusWindow: () => ({ ok: true }),
    pageMinimizeWindow: () => ({ ok: true }),
    pageClick: () => ({ ok: true }),
    pageScroll: () => ({ ok: true }),
    pageTypeText: () => ({ ok: true }),
    pageInspectPoint: () => ({
      item: fakeContextItem(),
      source: "cdp" as const,
      snapshot: fakeSnapshot(state.session, elements),
    }),
    pageSelectPoint: () => ({
      item: fakeContextItem(),
      source: "cdp" as const,
      snapshot: fakeSnapshot(state.session, elements),
    }),
    pageAttachContext: () => ({ ok: true }),
  };

  const engineCalls = {
    async place(request: { engineId: string; rect: PluginWebviewEngineRect }) {
      record("hostEngine.place", request as unknown as Record<string, unknown>);
    },
    async release() {
      record("hostEngine.release", {});
    },
  };

  const bridge: AdePluginBridge = {
    version: 2,
    pluginId: "ade-app-control",
    context: {
      subject: null,
      surfaceId: "control",
      placement: "pane",
      project: { projectId: "project-1", root: "/repo", binding: "local" },
      ...options.context,
    } as PluginWebviewContext,
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
      // The rule that makes this a seam test: an unscripted id throws BY NAME
      // rather than resolving undefined, so a page reaching for an action the
      // child does not have fails here and not in production.
      if (!handler) throw new Error(`The scripted child has no action "${action}".`);
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
      on(event: "changed" | "theme", listener: (payload: never) => void) {
        record("events.on", { event });
        listeners[event]?.add(listener as (payload: unknown) => void);
        return () => listeners[event]?.delete(listener as (payload: unknown) => void);
      },
    } as AdePluginBridge["events"],
    async openDeeplink(url: string) {
      record("openDeeplink", { url });
    },
    ui: {
      async toast(toast: PluginWebviewToast) {
        record("ui.toast", toast as unknown as Record<string, unknown>);
        return { id: "toast-1" };
      },
      async dismissToast(id: string) {
        record("ui.dismissToast", { id });
      },
      async confirm(request: PluginWebviewConfirm) {
        record("ui.confirm", request as unknown as Record<string, unknown>);
        return true;
      },
      resize(size: { height: number }) {
        record("ui.resize", size as unknown as Record<string, unknown>);
      },
      async openPathInEditor(target: { rootPath: string; target: string }) {
        record("ui.openPathInEditor", target as unknown as Record<string, unknown>);
      },
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
    // Absent entirely when `engine: false`, which is what a host too old to
    // paint a builtin looks like. The page must degrade, not throw.
    ...(options.engine === false ? {} : { hostEngine: engineCalls }),
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
