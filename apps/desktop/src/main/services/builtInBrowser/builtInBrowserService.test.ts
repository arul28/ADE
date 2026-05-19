import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BuiltInBrowserEventPayload } from "../../../shared/types";
import { createBuiltInBrowserService } from "./builtInBrowserService";

const fakes = vi.hoisted(() => {
  type DebuggerHandler = (...args: unknown[]) => void;
  type WindowOpenHandlerResponse = {
    action: "allow" | "deny";
    createWindow?: (options: Record<string, unknown>) => FakeWebContents;
  };
  type WindowOpenHandler = (details: { url: string }) => WindowOpenHandlerResponse;
  type BeforeSendHeadersHandler = (
    details: { requestHeaders: Record<string, string | string[] | undefined> },
    callback: (response: { requestHeaders: Record<string, string | string[] | undefined> }) => void,
  ) => void;
  type PermissionCheckHandler = (
    webContents: FakeWebContents | null,
    permission: string,
    requestingOrigin: string,
    details: { requestingUrl?: string; embeddingOrigin?: string; securityOrigin?: string; isMainFrame: boolean },
  ) => boolean;
  type PermissionRequestHandler = (
    webContents: FakeWebContents,
    permission: string,
    callback: (granted: boolean) => void,
    details: { requestingUrl: string; isMainFrame: boolean; requestingOrigin?: string },
  ) => void;

  class FakeDebugger {
    attached = false;
    sendCommandImpl: (method: string, params?: Record<string, unknown>) => Promise<unknown> = async () => ({});
    sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown> {
      return this.sendCommandImpl(method, params);
    }
    private listeners: Record<string, DebuggerHandler[]> = {};
    attach = (): void => {
      this.attached = true;
    };
    detach = (): void => {
      this.attached = false;
    };
    isAttached = (): boolean => this.attached;
    on = (event: string, fn: DebuggerHandler): void => {
      (this.listeners[event] ??= []).push(fn);
    };
    off = (event: string, fn: DebuggerHandler): void => {
      const list = this.listeners[event];
      if (!list) return;
      const idx = list.indexOf(fn);
      if (idx >= 0) list.splice(idx, 1);
    };
  }

  class FakeWebContents {
    id = Math.floor(Math.random() * 1_000_000);
    debugger = new FakeDebugger();
    audioMutedCalls: boolean[] = [];
    userAgentCalls: string[] = [];
    currentUrl = "";
    private listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
    private windowOpenHandler: WindowOpenHandler | null = null;
    loadURL = async (url: string): Promise<void> => {
      const event = { preventDefault: vi.fn() };
      this.emit("will-navigate", event, url);
      if (event.preventDefault.mock.calls.length === 0) {
        this.currentUrl = url;
        this.emit("did-navigate", {}, url);
      }
    };
    reload = (): void => undefined;
    goBack = (): void => undefined;
    goForward = (): void => undefined;
    stop = (): void => undefined;
    isLoading = (): boolean => false;
    canGoBack = (): boolean => false;
    canGoForward = (): boolean => false;
    isDestroyed = (): boolean => false;
    getURL = (): string => this.currentUrl;
    getTitle = (): string => "";
    setAudioMuted = (muted: boolean): void => {
      this.audioMutedCalls.push(muted);
    };
    setUserAgent = (userAgent: string): void => {
      this.userAgentCalls.push(userAgent);
    };
    setWindowOpenHandler = (handler: WindowOpenHandler): void => {
      this.windowOpenHandler = handler;
    };
    openWindow = (url: string): WindowOpenHandlerResponse | null => this.windowOpenHandler?.({ url }) ?? null;
    on = (event: string, fn: (...args: unknown[]) => void): void => {
      (this.listeners[event] ??= []).push(fn);
    };
    emit = (event: string, ...args: unknown[]): void => {
      for (const listener of this.listeners[event] ?? []) {
        listener(...args);
      }
    };
  }

  class FakeWebContentsView {
    webContents = new FakeWebContents();
    setBackgroundColor = (_color: string): void => undefined;
    setBounds = (_rect: unknown): void => undefined;
    setVisible = (_visible: boolean): void => undefined;
  }

  // Track the most recently constructed FakeDebugger so tests can wire sendCommand impls.
  const debuggerInstances: FakeDebugger[] = [];
  const webContentsInstances: FakeWebContents[] = [];
  const beforeSendHeadersHandlers: BeforeSendHeadersHandler[] = [];
  let permissionCheckHandler: PermissionCheckHandler | null = null;
  let permissionRequestHandler: PermissionRequestHandler | null = null;
  const OriginalFakeDebugger = FakeDebugger;
  class TrackedFakeDebugger extends OriginalFakeDebugger {
    constructor() {
      super();
      debuggerInstances.push(this);
    }
  }
  // Replace FakeWebContents.debugger with the tracked variant.
  class TrackedFakeWebContents extends FakeWebContents {
    constructor() {
      super();
      this.debugger = new TrackedFakeDebugger();
      webContentsInstances.push(this);
    }
  }
  class TrackedFakeWebContentsView extends FakeWebContentsView {
    constructor() {
      super();
      this.webContents = new TrackedFakeWebContents();
    }
  }

  let activeImpl: (method: string, params?: Record<string, unknown>) => Promise<unknown> = async () => ({});
  // Override sendCommand on the prototype to delegate to the shared activeImpl, so future
  // instances pick it up automatically without per-instance patching races.
  OriginalFakeDebugger.prototype.sendCommand = function (method: string, params?: Record<string, unknown>) {
    return activeImpl(method, params);
  };

  return {
    WebContentsView: TrackedFakeWebContentsView,
    debuggerInstances,
    webContentsInstances,
    openExternal: vi.fn(async (_url: string) => undefined),
    beforeSendHeadersHandlers,
    dispatchBeforeSendHeaders: (
      requestHeaders: Record<string, string | string[] | undefined>,
    ): { requestHeaders: Record<string, string | string[] | undefined> } | null => {
      let response: { requestHeaders: Record<string, string | string[] | undefined> } | null = null;
      const handler = beforeSendHeadersHandlers.at(-1);
      handler?.({ requestHeaders }, (next) => {
        response = next;
      });
      return response as { requestHeaders: Record<string, string | string[] | undefined> } | null;
    },
    setSendCommand: (impl: (method: string, params?: Record<string, unknown>) => Promise<unknown>) => {
      activeImpl = impl;
    },
    resetSendCommand: () => {
      activeImpl = async () => ({});
    },
    clearDebuggerInstances: () => {
      debuggerInstances.length = 0;
    },
    clearWebContentsInstances: () => {
      webContentsInstances.length = 0;
    },
    clearBeforeSendHeadersHandlers: () => {
      beforeSendHeadersHandlers.length = 0;
    },
    setPermissionCheckHandler: (handler: PermissionCheckHandler | null) => {
      permissionCheckHandler = handler;
    },
    setPermissionRequestHandler: (handler: PermissionRequestHandler | null) => {
      permissionRequestHandler = handler;
    },
    dispatchPermissionCheck: (
      permission: string,
      requestingOrigin: string,
      details: { requestingUrl?: string; embeddingOrigin?: string; securityOrigin?: string; isMainFrame?: boolean } = {},
    ): boolean | null => {
      return permissionCheckHandler?.(webContentsInstances[0] ?? null, permission, requestingOrigin, {
        isMainFrame: details.isMainFrame ?? true,
        requestingUrl: details.requestingUrl,
        embeddingOrigin: details.embeddingOrigin,
        securityOrigin: details.securityOrigin,
      }) ?? null;
    },
    dispatchPermissionRequest: (
      permission: string,
      details: { requestingUrl: string; isMainFrame?: boolean; requestingOrigin?: string },
    ): boolean | null => {
      let granted: boolean | null = null;
      const wc = webContentsInstances[0];
      if (!wc || !permissionRequestHandler) return null;
      permissionRequestHandler(wc, permission, (nextGranted) => {
        granted = nextGranted;
      }, {
        requestingUrl: details.requestingUrl,
        isMainFrame: details.isMainFrame ?? true,
        requestingOrigin: details.requestingOrigin,
      });
      return granted;
    },
    clearPermissionHandlers: () => {
      permissionCheckHandler = null;
      permissionRequestHandler = null;
    },
  };
});

vi.mock("electron", () => ({
  WebContentsView: fakes.WebContentsView,
  nativeImage: { createFromDataURL: () => ({ getSize: () => ({ width: 0, height: 0 }) }) },
  session: {
    fromPartition: () => ({
      webRequest: {
        onBeforeSendHeaders: (handler: unknown) => {
          fakes.beforeSendHeadersHandlers.push(handler as Parameters<typeof fakes.beforeSendHeadersHandlers.push>[0]);
        },
      },
      setPermissionCheckHandler: (handler: unknown) => {
        fakes.setPermissionCheckHandler(handler as Parameters<typeof fakes.setPermissionCheckHandler>[0]);
      },
      setPermissionRequestHandler: (handler: unknown) => {
        fakes.setPermissionRequestHandler(handler as Parameters<typeof fakes.setPermissionRequestHandler>[0]);
      },
    }),
  },
  shell: { openExternal: fakes.openExternal },
  webContents: { fromId: () => null },
}));

function captureStatusEvents(): {
  events: BuiltInBrowserEventPayload[];
  onEvent: (payload: BuiltInBrowserEventPayload) => void;
} {
  const events: BuiltInBrowserEventPayload[] = [];
  return {
    events,
    onEvent: (payload) => {
      events.push(payload);
    },
  };
}

function fakeBrowserWindow() {
  const children: unknown[] = [];
  return {
    isDestroyed: () => false,
    contentView: {
      children,
      addChildView: (view: unknown) => {
        if (!children.includes(view)) children.push(view);
      },
      removeChildView: (view: unknown) => {
        const index = children.indexOf(view);
        if (index >= 0) children.splice(index, 1);
      },
    },
    once: vi.fn(),
    removeListener: vi.fn(),
  };
}

describe("createBuiltInBrowserService — bounds and status dedupe", () => {
  let collector: ReturnType<typeof captureStatusEvents>;

  beforeEach(() => {
    collector = captureStatusEvents();
    fakes.clearWebContentsInstances();
    fakes.clearBeforeSendHeadersHandlers();
    fakes.clearPermissionHandlers();
    fakes.openExternal.mockClear();
  });

  it("getStatus returns sane defaults before any window or tab is attached", () => {
    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });
    const status = service.getStatus();
    expect(status.partition).toBe("persist:ade-browser");
    expect(status.tabs).toEqual([]);
    expect(status.activeTabId).toBeNull();
    expect(status.attached).toBe(false);
    expect(status.visible).toBe(false);
    expect(status.bounds).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it("setBounds short-circuits and does not emit when args are unchanged", async () => {
    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });

    // First call with non-default invisible bounds — width=0 keeps visible=false so no tab is created.
    await service.setBounds({ x: 10, y: 10, width: 0, height: 0, visible: true });
    const firstEmitCount = collector.events.length;
    expect(firstEmitCount).toBe(1);

    // Identical args — must not produce another emit.
    await service.setBounds({ x: 10, y: 10, width: 0, height: 0, visible: true });
    await service.setBounds({ x: 10, y: 10, width: 0, height: 0, visible: true });
    expect(collector.events.length).toBe(firstEmitCount);
  });

  it("setBounds emits exactly one new status when args actually change", async () => {
    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });

    await service.setBounds({ x: 0, y: 0, width: 0, height: 0, visible: false });
    // visible=false with zero bounds matches the initial state — short-circuited (no emit).
    const initialEmits = collector.events.length;

    await service.setBounds({ x: 0, y: 0, width: 0, height: 100, visible: false });
    await service.setBounds({ x: 0, y: 0, width: 0, height: 200, visible: false });
    await service.setBounds({ x: 0, y: 0, width: 0, height: 200, visible: false });

    // Two genuine changes (height 0→100, 100→200), one duplicate that must be suppressed.
    expect(collector.events.length - initialEmits).toBe(2);
  });

  it("emitStatus dedupes when serialized status is identical across calls", async () => {
    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });

    // First navigation through setBounds emits once.
    await service.setBounds({ x: 5, y: 5, width: 0, height: 0, visible: false });
    const firstCount = collector.events.length;
    expect(firstCount).toBe(1);

    const firstPayload = collector.events[0];
    if (firstPayload.type !== "status") throw new Error(`Expected status event, got ${firstPayload.type}`);
    expect(firstPayload.status.bounds).toEqual({ x: 5, y: 5, width: 0, height: 0 });

    // Repeat — diff key matches, suppressed entirely.
    await service.setBounds({ x: 5, y: 5, width: 0, height: 0, visible: false });
    expect(collector.events.length).toBe(firstCount);
  });

  it("dispose clears emitted state and stops further events", () => {
    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });
    service.dispose();
    // dispose itself must not throw; subsequent getStatus reflects an empty service.
    const status = service.getStatus();
    expect(status.tabs).toEqual([]);
    expect(status.attached).toBe(false);
  });

  it("captureScreenshot rejects when no tab is active instead of silently spawning one", async () => {
    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });
    await expect(service.captureScreenshot()).rejects.toThrow(/no active browser tab/i);
    // No tab should have been created as a side effect.
    expect(service.getStatus().tabs).toEqual([]);
    expect(service.getStatus().activeTabId).toBeNull();
  });

  it("selectPoint rejects when no tab is active instead of silently spawning one", async () => {
    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });
    await expect(service.selectPoint({ x: 10, y: 10 })).rejects.toThrow(/no active browser tab/i);
    expect(service.getStatus().tabs).toEqual([]);
  });

  it("keeps owned tabs alive while hidden and mutes them until visible", async () => {
    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });
    service.attachToWindow(fakeBrowserWindow() as unknown as Parameters<typeof service.attachToWindow>[0]);

    await service.createTab({ url: "https://example.test", activate: true });
    expect(service.getStatus().tabs).toHaveLength(1);
    const wc = fakes.webContentsInstances[0];
    expect(wc?.audioMutedCalls.at(-1)).toBe(true);

    await service.setBounds({ x: 12, y: 24, width: 640, height: 360, visible: true });
    expect(service.getStatus().tabs).toHaveLength(1);
    expect(wc?.audioMutedCalls.at(-1)).toBe(false);

    await service.setBounds({ x: 12, y: 24, width: 640, height: 360, visible: false });
    expect(service.getStatus().tabs).toHaveLength(1);
    expect(wc?.audioMutedCalls.at(-1)).toBe(true);
  });

  it("keeps Google account sign-in inside ADE browser tabs", async () => {
    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });
    const googleAuthUrl = "https://accounts.google.com/o/oauth2/v2/auth?client_id=test";

    await service.navigate({ url: googleAuthUrl, newTab: true });

    expect(fakes.openExternal).not.toHaveBeenCalled();
    expect(service.getStatus().tabs).toHaveLength(1);
    expect(service.getStatus().url).toBe(googleAuthUrl);
  });

  it("allows in-page Google sign-in navigations", async () => {
    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });
    service.attachToWindow(fakeBrowserWindow() as unknown as Parameters<typeof service.attachToWindow>[0]);
    await service.createTab({ url: "https://example.test", activate: true });
    fakes.openExternal.mockClear();

    const googleSignInUrl = "https://accounts.google.com/v3/signin/identifier?continue=https%3A%2F%2Fexample.test";
    const event = { preventDefault: vi.fn() };
    const wc = fakes.webContentsInstances[0];
    wc?.emit("will-navigate", event, googleSignInUrl);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(fakes.openExternal).not.toHaveBeenCalled();
  });

  it("does not impersonate Chrome or rewrite browser request headers", async () => {
    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });
    await service.createTab({ url: "https://example.test", activate: true });

    const wc = fakes.webContentsInstances[0];
    expect(wc?.userAgentCalls).toEqual([]);
    expect(fakes.beforeSendHeadersHandlers).toHaveLength(0);
    expect(fakes.dispatchBeforeSendHeaders({
      "User-Agent": "Electron/41",
      "Sec-CH-UA": "\"Chromium\";v=\"140\", \"Electron\";v=\"41\"",
    })).toBeNull();
  });

  it("allows only narrow Google account auth permissions", async () => {
    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });
    await service.createTab({ url: "https://example.test", activate: true });

    expect(fakes.dispatchPermissionCheck("storage-access", "https://accounts.google.com")).toBe(true);
    expect(fakes.dispatchPermissionCheck("top-level-storage-access", "https://accounts.google.com")).toBe(true);
    expect(fakes.dispatchPermissionCheck("hid", "https://accounts.google.com")).toBe(true);
    expect(fakes.dispatchPermissionCheck("usb", "https://accounts.google.com")).toBe(true);
    expect(fakes.dispatchPermissionCheck("serial", "https://accounts.google.com")).toBe(true);

    expect(fakes.dispatchPermissionCheck("storage-access", "https://example.test")).toBe(false);
    expect(fakes.dispatchPermissionCheck("media", "https://accounts.google.com")).toBe(false);

    expect(fakes.dispatchPermissionRequest("storage-access", {
      requestingUrl: "https://accounts.google.com/v3/signin/identifier",
    })).toBe(true);
    expect(fakes.dispatchPermissionRequest("top-level-storage-access", {
      requestingUrl: "https://accounts.google.com/v3/signin/identifier",
    })).toBe(true);
    expect(fakes.dispatchPermissionRequest("media", {
      requestingUrl: "https://accounts.google.com/v3/signin/identifier",
    })).toBe(false);
    expect(fakes.dispatchPermissionRequest("storage-access", {
      requestingUrl: "https://example.test/login",
    })).toBe(false);
  });

  it("opens popup requests as real ADE browser tabs", async () => {
    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });
    await service.createTab({ url: "https://example.test", activate: true });
    const firstTabId = service.getStatus().activeTabId;
    const firstWc = fakes.webContentsInstances[0];

    const response = firstWc?.openWindow("https://accounts.google.com/gsi/select");

    expect(response?.action).toBe("allow");
    expect(service.getStatus().tabs).toHaveLength(2);
    expect(service.getStatus().activeTabId).not.toBe(firstTabId);
    expect(response?.createWindow?.({})).toBe(fakes.webContentsInstances[1]);

    const openEvent = collector.events.findLast((event) => event.type === "open-request");
    expect(openEvent).toMatchObject({
      type: "open-request",
      url: "https://accounts.google.com/gsi/select",
      tabId: service.getStatus().activeTabId,
    });
  });

  it("emits an open request so the Work sidebar can reveal the browser panel", async () => {
    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });
    await service.createTab({ url: "https://example.test", activate: true, openPanel: true });

    const openEvent = collector.events.find((event) => event.type === "open-request");
    expect(openEvent).toMatchObject({
      type: "open-request",
      url: "https://example.test/",
      tabId: service.getStatus().activeTabId,
    });
  });

  it("showPanel can navigate to a URL before opening the panel", async () => {
    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });

    await service.showPanel({ url: "localhost:5173" });

    expect(service.getStatus().tabs).toHaveLength(1);
    expect(service.getStatus().url).toBe("http://localhost:5173/");
    const openEvent = collector.events.findLast((event) => event.type === "open-request");
    expect(openEvent).toMatchObject({
      type: "open-request",
      url: "http://localhost:5173/",
      tabId: service.getStatus().activeTabId,
    });
  });

  it("showPanel can switch to a requested tab before opening the panel", async () => {
    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });
    await service.createTab({ url: "https://first.test", activate: true });
    const firstTabId = service.getStatus().activeTabId;
    await service.createTab({ url: "https://second.test", activate: true });
    expect(service.getStatus().activeTabId).not.toBe(firstTabId);

    await service.showPanel({ tabId: firstTabId });

    expect(service.getStatus().activeTabId).toBe(firstTabId);
    const openEvent = collector.events.findLast((event) => event.type === "open-request");
    expect(openEvent).toMatchObject({
      type: "open-request",
      tabId: firstTabId,
    });
  });
});

describe("createBuiltInBrowserService — switchTab and navigate inspect/selection invariants", () => {
  let collector: ReturnType<typeof captureStatusEvents>;

  beforeEach(() => {
    collector = captureStatusEvents();
    fakes.resetSendCommand();
    fakes.clearDebuggerInstances();
    fakes.clearWebContentsInstances();
    fakes.clearBeforeSendHeadersHandlers();
    fakes.clearPermissionHandlers();
    fakes.openExternal.mockClear();
  });

  it("switchTab to the currently active tab does not clear an existing selection", async () => {
    fakes.setSendCommand(async (method) => {
      switch (method) {
        case "DOM.getNodeForLocation":
          return { backendNodeId: 42 };
        case "DOM.resolveNode":
          return { object: { objectId: "obj-1" } };
        case "Runtime.callFunctionOn":
          return {
            result: {
              value: {
                tagName: "div",
                selector: "div#root",
                testId: null,
                frame: { x: 0, y: 0, width: 10, height: 10 },
                pixelRatio: 1,
                url: "http://example.test/",
                title: "test",
                metadata: { viewport: { width: 100, height: 100 } },
              },
            },
          };
        default:
          return {};
      }
    });

    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });
    await service.navigate({ url: "https://example.test", newTab: true });
    const activeTabId = service.getStatus().activeTabId;
    expect(activeTabId).toBeTruthy();

    const result = await service.selectPoint({ x: 5, y: 5, includeScreenshot: false });
    expect(result.item).not.toBeNull();
    expect(service.getStatus().hasSelection).toBe(true);

    const eventsBefore = collector.events.length;
    if (!activeTabId) throw new Error("missing activeTabId");
    await service.switchTab({ tabId: activeTabId });

    expect(service.getStatus().hasSelection).toBe(true);
    const newClearEvents = collector.events
      .slice(eventsBefore)
      .filter((e) => e.type === "selection-cleared");
    expect(newClearEvents).toHaveLength(0);
  });

  it("navigate to a URL on the active tab stops inspect mode (CDP overlay desync fix)", async () => {
    fakes.setSendCommand(async () => ({}));

    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });
    await service.navigate({ url: "https://example.test", newTab: true });

    await service.startInspect();
    expect(service.getStatus().isInspecting).toBe(true);

    const activeTabId = service.getStatus().activeTabId;
    if (!activeTabId) throw new Error("missing activeTabId");

    await service.navigate({ url: "https://example.test/two", tabId: activeTabId });

    expect(service.getStatus().isInspecting).toBe(false);
  });
});
