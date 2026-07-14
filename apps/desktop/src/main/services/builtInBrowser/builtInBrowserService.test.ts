import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BuiltInBrowserEventPayload } from "../../../shared/types";
import { createBuiltInBrowserService } from "./builtInBrowserService";

const fakes = vi.hoisted(() => {
  type DebuggerHandler = (...args: unknown[]) => void;
  type WindowOpenHandlerResponse = {
    action: "allow" | "deny";
    createWindow?: (options: Record<string, unknown>) => FakeWebContents;
  };
  type WindowOpenDetails = {
    url: string;
    referrer?: { url: string; policy: string };
    postBody?: {
      boundary?: string;
      contentType: string;
      data: Array<Record<string, unknown>>;
    };
  };
  type WindowOpenHandler = (details: WindowOpenDetails) => WindowOpenHandlerResponse;
  type BeforeSendHeadersHandler = (
    details: { requestHeaders: Record<string, string | string[] | undefined> },
    callback: (response: { requestHeaders: Record<string, string | string[] | undefined> }) => void,
  ) => void;
  type BeforeRequestHandler = (
    details: Record<string, unknown>,
    callback?: (response: { cancel?: boolean }) => void,
  ) => void;
  type RequestFinishedHandler = (details: Record<string, unknown>) => void;
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
  type DownloadDoneHandler = (_event: unknown, state: "completed" | "cancelled" | "interrupted") => void;
  type FakeDownloadItem = {
    getFilename: () => string;
    getURL: () => string;
    setSavePath: (path: string) => void;
    once: (event: "done", handler: DownloadDoneHandler) => void;
  };

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
    emit = (event: string, ...args: unknown[]): void => {
      for (const listener of this.listeners[event] ?? []) {
        listener(...args);
      }
    };
  }

  class FakeWebContents {
    id = Math.floor(Math.random() * 1_000_000);
    debugger = new FakeDebugger();
    session: unknown = null;
    audioMutedCalls: boolean[] = [];
    userAgentCalls: string[] = [];
    loadURLCalls: Array<{ url: string; options?: Record<string, unknown> }> = [];
    currentUrl = "";
    private listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
    private windowOpenHandler: WindowOpenHandler | null = null;
    loadURL = async (url: string, options?: Record<string, unknown>): Promise<void> => {
      this.loadURLCalls.push({ url, options });
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
    capturePage = async (): Promise<{
      isEmpty: () => boolean;
      toDataURL: () => string;
      getSize: () => { width: number; height: number };
    }> => ({
      isEmpty: () => false,
      toDataURL: () => "data:image/png;base64,dGVzdA==",
      getSize: () => ({ width: 320, height: 180 }),
    });
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
    openWindow = (url: string, details: Partial<WindowOpenDetails> = {}): WindowOpenHandlerResponse | null => this.windowOpenHandler?.({ ...details, url }) ?? null;
    on = (event: string, fn: (...args: unknown[]) => void): void => {
      (this.listeners[event] ??= []).push(fn);
    };
    once = (event: string, fn: (...args: unknown[]) => void): void => {
      this.on(event, fn);
    };
    emit = (event: string, ...args: unknown[]): void => {
      for (const listener of this.listeners[event] ?? []) {
        listener(...args);
      }
    };
  }

  class FakeWebContentsView {
    webContents = new FakeWebContents();
    webPreferences: unknown;
    constructor(options?: { webPreferences?: unknown }) {
      this.webPreferences = options?.webPreferences;
    }
    setBackgroundColor = (_color: string): void => undefined;
    setBounds = (_rect: unknown): void => undefined;
    setVisible = (_visible: boolean): void => undefined;
  }

  // Track the most recently constructed FakeDebugger so tests can wire sendCommand impls.
  const debuggerInstances: FakeDebugger[] = [];
  const webContentsInstances: FakeWebContents[] = [];
  const webContentsViewInstances: FakeWebContentsView[] = [];
  const partitionCalls: string[] = [];
  const beforeSendHeadersHandlers: BeforeSendHeadersHandler[] = [];
  const beforeRequestHandlers: BeforeRequestHandler[] = [];
  const requestCompletedHandlers: RequestFinishedHandler[] = [];
  const requestErrorHandlers: RequestFinishedHandler[] = [];
  const sessionEventHandlers: Array<{ session: FakeSession; event: string; handler: (...args: unknown[]) => void }> = [];
  const appGetPath = vi.fn((name: string): string => name === "downloads" ? "/Users/test/Downloads" : "/tmp");
  const appIsReady = vi.fn(() => false);
  const permissionPrompt = vi.fn(async () => ({ response: 1, checkboxChecked: false }));
  let permissionCheckHandler: PermissionCheckHandler | null = null;
  let permissionRequestHandler: PermissionRequestHandler | null = null;
  type FakeSession = {
    cookies: {
      flushStore: () => Promise<void>;
      get: () => Promise<Array<{ domain?: string; expirationDate?: number }>>;
    };
    flushStorageData: () => void;
    getCacheSize: () => Promise<number>;
    webRequest: {
      onBeforeSendHeaders: (handler: unknown) => void;
      onBeforeRequest: (handler: unknown) => void;
      onCompleted: (handler: unknown) => void;
      onErrorOccurred: (handler: unknown) => void;
    };
    on: (event: string, handler: (...args: unknown[]) => void) => void;
    off: (event: string, handler: (...args: unknown[]) => void) => void;
    removeListener: (event: string, handler: (...args: unknown[]) => void) => void;
    setPermissionCheckHandler: (handler: unknown) => void;
    setPermissionRequestHandler: (handler: unknown) => void;
  };
  const flushCookieStore = vi.fn(async (): Promise<void> => undefined);
  const getCookies = vi.fn(async (): Promise<Array<{ domain?: string; expirationDate?: number }>> => []);
  const getCacheSize = vi.fn(async (): Promise<number> => 0);
  const flushStorageData = vi.fn((): void => undefined);
  const sessionsByPartition = new Map<string, FakeSession>();
  const sessionForPartition = (partition: string): FakeSession => {
    const existing = sessionsByPartition.get(partition);
    if (existing) return existing;
    const nextSession: FakeSession = {
      cookies: {
        flushStore: flushCookieStore,
        get: getCookies,
      },
      flushStorageData,
      getCacheSize,
      webRequest: {
        onBeforeSendHeaders: (handler: unknown) => {
          beforeSendHeadersHandlers.push(handler as Parameters<typeof beforeSendHeadersHandlers.push>[0]);
        },
        onBeforeRequest: (handler: unknown) => {
          beforeRequestHandlers.push(handler as Parameters<typeof beforeRequestHandlers.push>[0]);
        },
        onCompleted: (handler: unknown) => {
          requestCompletedHandlers.push(handler as Parameters<typeof requestCompletedHandlers.push>[0]);
        },
        onErrorOccurred: (handler: unknown) => {
          requestErrorHandlers.push(handler as Parameters<typeof requestErrorHandlers.push>[0]);
        },
      },
      on: (event: string, handler: (...args: unknown[]) => void) => {
        sessionEventHandlers.push({ session: nextSession, event, handler });
      },
      off: (event: string, handler: (...args: unknown[]) => void) => {
        const index = sessionEventHandlers.findIndex((entry) => (
          entry.session === nextSession
          && entry.event === event
          && entry.handler === handler
        ));
        if (index >= 0) sessionEventHandlers.splice(index, 1);
      },
      removeListener: (event: string, handler: (...args: unknown[]) => void) => {
        const index = sessionEventHandlers.findIndex((entry) => (
          entry.session === nextSession
          && entry.event === event
          && entry.handler === handler
        ));
        if (index >= 0) sessionEventHandlers.splice(index, 1);
      },
      setPermissionCheckHandler: (handler: unknown) => {
        permissionCheckHandler = handler as PermissionCheckHandler;
      },
      setPermissionRequestHandler: (handler: unknown) => {
        permissionRequestHandler = handler as PermissionRequestHandler;
      },
    };
    sessionsByPartition.set(partition, nextSession);
    return nextSession;
  };
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
    constructor(options?: { webPreferences?: unknown }) {
      super(options);
      this.webContents = new TrackedFakeWebContents();
      const partition = (options?.webPreferences as { partition?: string } | undefined)?.partition ?? "persist:ade-browser";
      this.webContents.session = sessionForPartition(partition);
      webContentsViewInstances.push(this);
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
    webContentsViewInstances,
    partitionCalls,
    openExternal: vi.fn(async (_url: string) => undefined),
    screen: {
      getCursorScreenPoint: vi.fn(() => ({ x: 0, y: 0 })),
    },
    beforeSendHeadersHandlers,
    beforeRequestHandlers,
    requestCompletedHandlers,
    requestErrorHandlers,
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
    dispatchBeforeRequest: (details: Record<string, unknown>): { cancel?: boolean } | null => {
      let response: { cancel?: boolean } | null = null;
      const handler = beforeRequestHandlers.at(-1);
      handler?.(details, (next) => {
        response = next;
      });
      return response;
    },
    dispatchRequestCompleted: (details: Record<string, unknown>) => {
      requestCompletedHandlers.at(-1)?.(details);
    },
    dispatchRequestError: (details: Record<string, unknown>) => {
      requestErrorHandlers.at(-1)?.(details);
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
      webContentsViewInstances.length = 0;
      partitionCalls.length = 0;
      sessionsByPartition.clear();
    },
    clearBeforeSendHeadersHandlers: () => {
      beforeSendHeadersHandlers.length = 0;
      beforeRequestHandlers.length = 0;
      requestCompletedHandlers.length = 0;
      requestErrorHandlers.length = 0;
    },
    clearSessionEventHandlers: () => {
      sessionEventHandlers.length = 0;
    },
    flushCookieStore,
    getCookies,
    getCacheSize,
    flushStorageData,
    sessionEventHandlers,
    appGetPath,
    appIsReady,
    dispatchWillDownload: (
      item: FakeDownloadItem,
      downloadWebContents: FakeWebContents | null = webContentsInstances[0] ?? null,
    ): { preventDefault: ReturnType<typeof vi.fn> } => {
      const event = { preventDefault: vi.fn() };
      const downloadSession = downloadWebContents?.session as FakeSession | null | undefined;
      const handlers = sessionEventHandlers.filter((entry) => (
        entry.session === downloadSession
        && entry.event === "will-download"
      ));
      for (const { handler } of handlers) {
        handler(event, item, downloadWebContents);
      }
      return event;
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
    ): Promise<boolean | null> => {
      const wc = webContentsInstances[0];
      if (!wc || !permissionRequestHandler) return Promise.resolve(null);
      return new Promise((resolve) => {
        permissionRequestHandler?.(wc, permission, resolve, {
          requestingUrl: details.requestingUrl,
          isMainFrame: details.isMainFrame ?? true,
          requestingOrigin: details.requestingOrigin,
        });
      });
    },
    clearPermissionHandlers: () => {
      permissionCheckHandler = null;
      permissionRequestHandler = null;
    },
    sessionForPartition,
    permissionPrompt,
  };
});

vi.mock("electron", () => ({
  WebContentsView: fakes.WebContentsView,
  app: { getPath: fakes.appGetPath, isReady: fakes.appIsReady },
  dialog: { showMessageBox: fakes.permissionPrompt },
  nativeImage: { createFromDataURL: () => ({ getSize: () => ({ width: 0, height: 0 }) }) },
  screen: fakes.screen,
  session: {
    fromPartition: (partition: string) => {
      fakes.partitionCalls.push(partition);
      return fakes.sessionForPartition(partition);
    },
  },
  shell: { openExternal: fakes.openExternal },
  webContents: {
    fromId: (id: number) => fakes.webContentsInstances.find((wc) => wc.id === id) ?? null,
  },
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

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

let fakeWindowId = 1;

function fakeBrowserWindow() {
  const children: unknown[] = [];
  const addChildViewCalls: unknown[] = [];
  const removeChildViewCalls: unknown[] = [];
  return {
    id: fakeWindowId++,
    isDestroyed: () => false,
    getContentBounds: () => ({ x: 0, y: 0, width: 1280, height: 720 }),
    addChildViewCalls,
    removeChildViewCalls,
    contentView: {
      children,
      addChildView: (view: unknown) => {
        addChildViewCalls.push(view);
        if (!children.includes(view)) children.push(view);
      },
      removeChildView: (view: unknown) => {
        removeChildViewCalls.push(view);
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
    fakeWindowId = 1;
    fakes.resetSendCommand();
    fakes.clearDebuggerInstances();
    fakes.clearWebContentsInstances();
    fakes.clearBeforeSendHeadersHandlers();
    fakes.clearSessionEventHandlers();
    fakes.clearPermissionHandlers();
    fakes.flushCookieStore.mockClear();
    fakes.getCookies.mockReset();
    fakes.getCookies.mockResolvedValue([]);
    fakes.getCacheSize.mockReset();
    fakes.getCacheSize.mockResolvedValue(0);
    fakes.flushStorageData.mockClear();
    fakes.openExternal.mockClear();
    fakes.appGetPath.mockClear();
    fakes.appIsReady.mockReset();
    fakes.appIsReady.mockReturnValue(false);
    fakes.permissionPrompt.mockClear();
    fakes.permissionPrompt.mockResolvedValue({ response: 0, checkboxChecked: false });
    fakes.appGetPath.mockImplementation((name: string) => name === "downloads" ? "/Users/test/Downloads" : "/tmp");
  });

  it("getStatus returns sane defaults before any window or tab is attached", () => {
    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });
    const status = service.getStatus();
    expect(status.partition).toBe("persist:ade-browser");
    expect(status.storageProfileKey).toBe("global");
    expect(status.tabs).toEqual([]);
    expect(status.activeTabId).toBeNull();
    expect(status.attached).toBe(false);
    expect(status.visible).toBe(false);
    expect(status.bounds).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it("keeps personal and window fallback collections independent before a window attaches", async () => {
    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });
    await service.createTab({ url: "https://window.example.test", activate: true });
    await service.createTab({
      tabCollection: "personal",
      url: "https://personal.example.test",
      activate: true,
    });

    expect(service.getStatus().url).toBe("https://window.example.test/");
    expect(service.getStatus({ tabCollection: "personal" }).url).toBe("https://personal.example.test/");
    expect(service.getStatus().partition).toBe(service.getStatus({ tabCollection: "personal" }).partition);
  });

  it("reports non-secret global profile diagnostics", async () => {
    fakes.getCookies.mockResolvedValue([
      { domain: ".github.com", expirationDate: 1_900_000_000 },
      { domain: "github.com" },
      { domain: ".console.aws.amazon.com", expirationDate: 1_900_000_000 },
    ]);
    fakes.getCacheSize.mockResolvedValue(12_345);
    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });

    await expect(service.getProfileDiagnostics()).resolves.toEqual({
      partition: "persist:ade-browser",
      storageProfileKey: "global",
      persistentProfile: true,
      cookieCount: 3,
      persistentCookieCount: 2,
      sessionCookieCount: 1,
      cookieDomains: ["console.aws.amazon.com", "github.com"],
      cacheSizeBytes: 12_345,
      persistedPermissionDecisionCount: 0,
      tabRestorationEnabled: false,
      lastStorageFlushAt: null,
    });

    await service.flushStorage();
    expect((await service.getProfileDiagnostics()).lastStorageFlushAt).toEqual(expect.any(String));
  });

  it("awaits cookie and DOM storage flushes for the global profile", async () => {
    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });

    await service.flushStorage();

    expect(fakes.flushCookieStore).toHaveBeenCalledTimes(1);
    expect(fakes.flushStorageData).toHaveBeenCalledTimes(1);
    expect(fakes.partitionCalls).toEqual(["persist:ade-browser"]);
  });

  it("still attempts the DOM storage flush when the cookie flush fails", async () => {
    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });
    fakes.flushCookieStore.mockRejectedValueOnce(new Error("cookie flush failed"));

    await expect(service.flushStorage()).rejects.toThrow("Failed to flush ADE browser storage");

    expect(fakes.flushCookieStore).toHaveBeenCalledTimes(1);
    expect(fakes.flushStorageData).toHaveBeenCalledTimes(1);
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
    const win = fakeBrowserWindow();
    service.attachToWindow(win as unknown as Parameters<typeof service.attachToWindow>[0]);

    await service.createTab({ url: "https://example.test", activate: true });
    expect(service.getStatus().tabs).toHaveLength(1);
    expect(win.contentView.children).toHaveLength(0);
    const wc = fakes.webContentsInstances[0];
    expect(wc?.audioMutedCalls.at(-1)).toBe(true);

    await service.setBounds({ x: 12, y: 24, width: 640, height: 360, visible: true });
    expect(service.getStatus().tabs).toHaveLength(1);
    expect(win.contentView.children).toHaveLength(1);
    expect(wc?.audioMutedCalls.at(-1)).toBe(false);

    await service.setBounds({ x: 12, y: 24, width: 640, height: 360, visible: false });
    expect(service.getStatus().tabs).toHaveLength(1);
    expect(win.contentView.children).toHaveLength(0);
    expect(wc?.audioMutedCalls.at(-1)).toBe(true);
  });

  it("keeps a visible browser view attached to its owner window when another ADE window focuses", async () => {
    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });
    const winA = fakeBrowserWindow();
    const winB = fakeBrowserWindow();
    const browserWinA = winA as unknown as Parameters<typeof service.attachToWindow>[0];
    const browserWinB = winB as unknown as Parameters<typeof service.attachToWindow>[0];

    service.attachToWindow(browserWinA);
    await service.createTab({ url: "https://a.example.test", activate: true }, browserWinA);
    await service.setBounds({ x: 12, y: 24, width: 640, height: 360, visible: true }, browserWinA);

    expect(winA.contentView.children).toHaveLength(1);
    expect(winB.contentView.children).toHaveLength(0);
    expect(service.getStatus(browserWinA).visible).toBe(true);

    service.attachToWindow(browserWinB);

    expect(winA.contentView.children).toHaveLength(1);
    expect(winB.contentView.children).toHaveLength(0);
    expect(service.getStatus(browserWinA).visible).toBe(true);
    expect(service.getStatus(browserWinB).visible).toBe(false);
    expect(service.getStatus(browserWinB).tabs).toEqual([]);
  });

  it("scopes browser tabs and commands to the sender window", async () => {
    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });
    const winA = fakeBrowserWindow();
    const winB = fakeBrowserWindow();
    const browserWinA = winA as unknown as Parameters<typeof service.attachToWindow>[0];
    const browserWinB = winB as unknown as Parameters<typeof service.attachToWindow>[0];

    service.attachToWindow(browserWinA);
    await service.createTab({ url: "https://a.example.test", activate: true }, browserWinA);
    service.attachToWindow(browserWinB);
    await service.createTab({ url: "https://b.example.test", activate: true }, browserWinB);

    expect(service.getStatus(browserWinA).tabs).toHaveLength(1);
    expect(service.getStatus(browserWinA).url).toBe("https://a.example.test/");
    expect(service.getStatus(browserWinB).tabs).toHaveLength(1);
    expect(service.getStatus(browserWinB).url).toBe("https://b.example.test/");

    await service.navigate({ url: "https://b-2.example.test" }, browserWinB);

    expect(service.getStatus(browserWinA).url).toBe("https://a.example.test/");
    expect(service.getStatus(browserWinB).url).toBe("https://b-2.example.test/");
  });

  it("uses one global persistent profile while keeping project and window tab collections independent", async () => {
    const projectRootByWindow = new Map<number, string>();
    const service = createBuiltInBrowserService({
      onEvent: collector.onEvent,
      getProjectRootForWindow: (win) => projectRootByWindow.get(win.id) ?? null,
    });
    const winA = fakeBrowserWindow();
    const winB = fakeBrowserWindow();
    const winC = fakeBrowserWindow();
    projectRootByWindow.set(winA.id, "/Users/ade/project-alpha");
    projectRootByWindow.set(winB.id, "/Users/ade/project-alpha");
    projectRootByWindow.set(winC.id, "/Users/ade/project-beta");
    const browserWinA = winA as unknown as Parameters<typeof service.attachToWindow>[0];
    const browserWinB = winB as unknown as Parameters<typeof service.attachToWindow>[0];
    const browserWinC = winC as unknown as Parameters<typeof service.attachToWindow>[0];

    await service.createTab({ url: "https://example.test", activate: true }, browserWinA);
    await service.createTab({ url: "https://example.test", activate: true }, browserWinB);
    await service.createTab({ url: "https://example.test", activate: true }, browserWinC);

    const partitionA = service.getStatus(browserWinA).partition;
    const partitionB = service.getStatus(browserWinB).partition;
    const partitionC = service.getStatus(browserWinC).partition;
    expect(partitionA).toBe("persist:ade-browser");
    expect(partitionB).toBe(partitionA);
    expect(partitionC).toBe(partitionA);
    expect(service.getStatus(browserWinA).collectionProjectRoot).toBe("/Users/ade/project-alpha");
    expect(service.getStatus(browserWinC).collectionProjectRoot).toBe("/Users/ade/project-beta");
    expect(service.getStatus(browserWinA).collectionKey).toBe(service.getStatus(browserWinB).collectionKey);
    expect(service.getStatus(browserWinC).collectionKey).not.toBe(service.getStatus(browserWinA).collectionKey);
    expect(service.getStatus(browserWinA).persistentProfile).toBe(true);

    const viewPartitions = fakes.webContentsViewInstances.map((view) => (
      view.webPreferences as { partition?: string } | undefined
    )?.partition);
    expect(viewPartitions).toEqual([partitionA, partitionA, partitionC]);
    expect(fakes.partitionCalls).toEqual([partitionA, partitionA, partitionC]);
  });

  it("keeps personal tabs separate from project tabs without partitioning authentication storage", async () => {
    const projectRootByWindow = new Map<number, string>();
    const service = createBuiltInBrowserService({
      onEvent: collector.onEvent,
      getProjectRootForWindow: (win) => projectRootByWindow.get(win.id) ?? null,
    });
    const win = fakeBrowserWindow();
    projectRootByWindow.set(win.id, "/Users/ade/project-alpha");
    const browserWin = win as unknown as Parameters<typeof service.attachToWindow>[0];

    service.attachToWindow(browserWin);
    await service.createTab({ url: "https://project.example.test", activate: true }, browserWin);
    await service.createTab({
      tabCollection: "personal",
      url: "https://personal.example.test",
      activate: true,
    }, browserWin);

    expect(service.getStatus({ projectRoot: "/Users/ade/project-alpha" }, browserWin)).toMatchObject({
      partition: "persist:ade-browser",
      collectionProjectRoot: "/Users/ade/project-alpha",
      url: "https://project.example.test/",
    });
    expect(service.getStatus({ tabCollection: "personal" }, browserWin)).toMatchObject({
      partition: "persist:ade-browser",
      storageProfileKey: "global",
      collectionKey: "personal",
      collectionProjectRoot: null,
      url: "https://personal.example.test/",
    });
    expect(service.getStatus({ tabCollection: "personal" }, browserWin).partition)
      .toBe(service.getStatus({ projectRoot: "/Users/ade/project-alpha" }, browserWin).partition);
    expect(service.getStatus({ tabCollection: "personal" }, browserWin).collectionKey)
      .not.toBe(service.getStatus({ projectRoot: "/Users/ade/project-alpha" }, browserWin).collectionKey);
  });

  it("restores project tab URLs and the active tab without restoring agent leases", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-browser-restore-"));
    const stateFilePath = path.join(tempDir, "browser-state.json");
    try {
      fakes.permissionPrompt.mockResolvedValue({ response: 0, checkboxChecked: false });
      const projectRootByWindow = new Map<number, string>();
      const win = fakeBrowserWindow();
      projectRootByWindow.set(win.id, "/Users/ade/project-alpha");
      const browserWin = win as unknown as Parameters<ReturnType<typeof createBuiltInBrowserService>["attachToWindow"]>[0];
      const firstService = createBuiltInBrowserService({
        stateFilePath,
        getProjectRootForWindow: (candidate) => projectRootByWindow.get(candidate.id) ?? null,
      });
      await firstService.createTab({
        url: "https://github.com/login",
        activate: true,
        laneId: "lane-1",
        chatSessionId: "chat-1",
      }, browserWin);
      await firstService.createTab({ url: "https://console.aws.amazon.com/", activate: true }, browserWin);
      await firstService.flushStorage();
      firstService.dispose();

      const restoredWin = fakeBrowserWindow();
      projectRootByWindow.set(restoredWin.id, "/Users/ade/project-alpha");
      const restoredBrowserWin = restoredWin as unknown as Parameters<ReturnType<typeof createBuiltInBrowserService>["attachToWindow"]>[0];
      const restoredService = createBuiltInBrowserService({
        stateFilePath,
        getProjectRootForWindow: (candidate) => projectRootByWindow.get(candidate.id) ?? null,
      });
      restoredService.attachToWindow(restoredBrowserWin);
      await vi.waitFor(() => {
        expect(restoredService.getStatus(restoredBrowserWin).tabs.map((tab) => tab.url)).toEqual([
          "https://github.com/login",
          "https://console.aws.amazon.com/",
        ]);
      });
      const status = restoredService.getStatus(restoredBrowserWin);
      expect(status.url).toBe("https://console.aws.amazon.com/");
      expect(status.tabs.every((tab) => (
        tab.ownerLaneId === null
        && tab.ownerChatSessionId === null
        && tab.ownerLeaseExpiresAt === null
      ))).toBe(true);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("waits for tab restoration before visible bounds can create a browser view", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-browser-restore-bounds-"));
    const stateFilePath = path.join(tempDir, "browser-state.json");
    try {
      fakes.appIsReady.mockReturnValue(true);
      fakes.appGetPath.mockImplementation((name: string) => (
        name === "downloads" ? "/Users/test/Downloads" : tempDir
      ));
      const projectRootByWindow = new Map<number, string>();
      const firstWin = fakeBrowserWindow();
      projectRootByWindow.set(firstWin.id, "/Users/ade/project-alpha");
      const firstBrowserWin = firstWin as unknown as Parameters<ReturnType<typeof createBuiltInBrowserService>["attachToWindow"]>[0];
      const firstService = createBuiltInBrowserService({
        stateFilePath,
        getProjectRootForWindow: (candidate) => projectRootByWindow.get(candidate.id) ?? null,
      });
      await firstService.createTab({ url: "https://restore-race.test", activate: true }, firstBrowserWin);
      await firstService.flushStorage();
      firstService.dispose();

      fakes.clearWebContentsInstances();
      fakes.getCookies.mockClear();
      const migrationCookies = createDeferred<Array<{ domain?: string; expirationDate?: number }>>();
      fakes.getCookies.mockReturnValue(migrationCookies.promise);
      const restoredWin = fakeBrowserWindow();
      projectRootByWindow.set(restoredWin.id, "/Users/ade/project-alpha");
      const restoredBrowserWin = restoredWin as unknown as Parameters<ReturnType<typeof createBuiltInBrowserService>["attachToWindow"]>[0];
      const restoredService = createBuiltInBrowserService({
        stateFilePath,
        getProjectRootForWindow: (candidate) => projectRootByWindow.get(candidate.id) ?? null,
      });
      restoredService.attachToWindow(restoredBrowserWin);
      let boundsSettled = false;
      const boundsPromise = restoredService.setBounds({
        x: 0,
        y: 0,
        width: 800,
        height: 600,
        visible: true,
      }, restoredBrowserWin).then((status) => {
        boundsSettled = true;
        return status;
      });

      await vi.waitFor(() => expect(fakes.getCookies).toHaveBeenCalled());
      expect(boundsSettled).toBe(false);
      expect(fakes.webContentsViewInstances).toHaveLength(0);

      migrationCookies.resolve([]);
      const status = await boundsPromise;
      expect(status.tabs.map((tab) => tab.url)).toEqual(["https://restore-race.test/"]);
      expect(fakes.webContentsViewInstances).toHaveLength(1);
      restoredService.dispose();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not resurrect restored browser views after the service is disposed", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-browser-disposed-restore-"));
    const stateFilePath = path.join(tempDir, "browser-state.json");
    try {
      fakes.appIsReady.mockReturnValue(true);
      fakes.appGetPath.mockImplementation((name: string) => (
        name === "downloads" ? "/Users/test/Downloads" : tempDir
      ));
      const projectRootByWindow = new Map<number, string>();
      const firstWin = fakeBrowserWindow();
      projectRootByWindow.set(firstWin.id, "/Users/ade/project-alpha");
      const firstBrowserWin = firstWin as unknown as Parameters<ReturnType<typeof createBuiltInBrowserService>["attachToWindow"]>[0];
      const firstService = createBuiltInBrowserService({
        stateFilePath,
        getProjectRootForWindow: (candidate) => projectRootByWindow.get(candidate.id) ?? null,
      });
      await firstService.createTab({ url: "https://disposed-restore.test", activate: true }, firstBrowserWin);
      await firstService.flushStorage();
      firstService.dispose();

      fakes.clearWebContentsInstances();
      fakes.getCookies.mockClear();
      const migrationCookies = createDeferred<Array<{ domain?: string; expirationDate?: number }>>();
      fakes.getCookies.mockReturnValue(migrationCookies.promise);
      const restoredWin = fakeBrowserWindow();
      projectRootByWindow.set(restoredWin.id, "/Users/ade/project-alpha");
      const restoredBrowserWin = restoredWin as unknown as Parameters<ReturnType<typeof createBuiltInBrowserService>["attachToWindow"]>[0];
      const restoredService = createBuiltInBrowserService({
        stateFilePath,
        getProjectRootForWindow: (candidate) => projectRootByWindow.get(candidate.id) ?? null,
      });
      restoredService.attachToWindow(restoredBrowserWin);
      const boundsPromise = restoredService.setBounds({
        x: 0,
        y: 0,
        width: 800,
        height: 600,
        visible: true,
      }, restoredBrowserWin);

      await vi.waitFor(() => expect(fakes.getCookies).toHaveBeenCalled());
      restoredService.dispose();
      migrationCookies.resolve([]);

      await expect(boundsPromise).resolves.toMatchObject({ tabs: [], activeTabId: null });
      expect(fakes.webContentsViewInstances).toHaveLength(0);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects attached webviews from outside the global browser profile", async () => {
    const projectRootByWindow = new Map<number, string>();
    const service = createBuiltInBrowserService({
      onEvent: collector.onEvent,
      getProjectRootForWindow: (win) => projectRootByWindow.get(win.id) ?? null,
    });
    const win = fakeBrowserWindow();
    projectRootByWindow.set(win.id, "/Users/ade/project-alpha");
    const browserWin = win as unknown as Parameters<typeof service.attachToWindow>[0];

    service.attachToWindow(browserWin);
    await service.createTab({ url: "https://example.test", activate: true }, browserWin);

    const status = service.getStatus(browserWin);
    const tabId = status.activeTabId;
    if (!tabId) throw new Error("Expected an active browser tab");

    const foreignView = new fakes.WebContentsView({
      webPreferences: { partition: "persist:foreign-browser" },
    });
    await expect(service.attachWebview({
      tabId,
      webContentsId: foreignView.webContents.id,
    }, browserWin)).rejects.toThrow(/partition does not match/);

    const matchingView = new fakes.WebContentsView({
      webPreferences: { partition: status.partition },
    });
    await expect(service.attachWebview({
      tabId,
      webContentsId: matchingView.webContents.id,
    }, browserWin)).resolves.toMatchObject({
      activeTabId: tabId,
    });
  });

  it("routes project-scoped bridge calls to the matching project window", async () => {
    const projectRootByWindow = new Map<number, string>();
    const windowsByProjectRoot = new Map<string, ReturnType<typeof fakeBrowserWindow>>();
    const service = createBuiltInBrowserService({
      onEvent: collector.onEvent,
      getProjectRootForWindow: (win) => projectRootByWindow.get(win.id) ?? null,
      getWindowForProjectRoot: (projectRoot) =>
        (
          windowsByProjectRoot.get(projectRoot) as unknown as
            Parameters<ReturnType<typeof createBuiltInBrowserService>["attachToWindow"]>[0] | undefined
        ) ?? null,
    });
    const winA = fakeBrowserWindow();
    const winB = fakeBrowserWindow();
    projectRootByWindow.set(winA.id, "/Users/ade/project-alpha");
    projectRootByWindow.set(winB.id, "/Users/ade/project-beta");
    windowsByProjectRoot.set("/Users/ade/project-alpha", winA);
    windowsByProjectRoot.set("/Users/ade/project-beta", winB);
    const browserWinA = winA as unknown as Parameters<typeof service.attachToWindow>[0];
    const browserWinB = winB as unknown as Parameters<typeof service.attachToWindow>[0];

    service.attachToWindow(browserWinA);
    await service.createTab({ url: "https://alpha.example.test", activate: true }, browserWinA);
    service.attachToWindow(browserWinB);
    await service.createTab({ url: "https://beta.example.test", activate: true }, browserWinB);

    await service.navigate({
      projectRoot: "/Users/ade/project-alpha",
      url: "https://alpha-two.example.test",
      newTab: true,
    });

    expect(service.getStatus({ projectRoot: "/Users/ade/project-alpha" }).tabs).toHaveLength(2);
    expect(service.getStatus({ projectRoot: "/Users/ade/project-alpha" }).url).toBe("https://alpha-two.example.test/");
    expect(service.getStatus({ projectRoot: "/Users/ade/project-beta" }).tabs).toHaveLength(1);
    expect(service.getStatus({ projectRoot: "/Users/ade/project-beta" }).url).toBe("https://beta.example.test/");
  });

  it("does not fall back to the active project for unmatched project-scoped bridge calls", async () => {
    const projectRootByWindow = new Map<number, string>();
    const service = createBuiltInBrowserService({
      onEvent: collector.onEvent,
      getProjectRootForWindow: (win) => projectRootByWindow.get(win.id) ?? null,
    });
    const win = fakeBrowserWindow();
    projectRootByWindow.set(win.id, "/Users/ade/project-beta");
    const browserWin = win as unknown as Parameters<typeof service.attachToWindow>[0];

    service.attachToWindow(browserWin);
    await service.createTab({ url: "https://beta.example.test", activate: true }, browserWin);

    expect(() => service.navigate({
      projectRoot: "/Users/ade/project-alpha",
      url: "https://alpha.example.test",
    })).toThrow(/No ADE browser window is open for project: \/Users\/ade\/project-alpha/);
    expect(service.getStatus(browserWin).tabs).toHaveLength(1);
    expect(service.getStatus(browserWin).url).toBe("https://beta.example.test/");
  });

  it("routes project-scoped calls to an inactive project tab without activating the window project", async () => {
    const projectRootByWindow = new Map<number, string>();
    const windowsByProjectRoot = new Map<string, ReturnType<typeof fakeBrowserWindow>>();
    const service = createBuiltInBrowserService({
      onEvent: collector.onEvent,
      getProjectRootForWindow: (win) => projectRootByWindow.get(win.id) ?? null,
      getWindowForProjectRoot: (projectRoot) =>
        (
          windowsByProjectRoot.get(projectRoot) as unknown as
            Parameters<ReturnType<typeof createBuiltInBrowserService>["attachToWindow"]>[0] | undefined
        ) ?? null,
    });
    const win = fakeBrowserWindow();
    projectRootByWindow.set(win.id, "/Users/ade/project-beta");
    windowsByProjectRoot.set("/Users/ade/project-alpha", win);
    windowsByProjectRoot.set("/Users/ade/project-beta", win);
    const browserWin = win as unknown as Parameters<typeof service.attachToWindow>[0];

    service.attachToWindow(browserWin);
    await service.createTab({ url: "https://beta.example.test", activate: true }, browserWin);
    await service.navigate({
      projectRoot: "/Users/ade/project-alpha",
      url: "https://alpha.example.test",
      newTab: true,
    });

    expect(projectRootByWindow.get(win.id)).toBe("/Users/ade/project-beta");
    expect(service.getStatus(browserWin).collectionProjectRoot).toBe("/Users/ade/project-beta");
    expect(service.getStatus(browserWin).url).toBe("https://beta.example.test/");
    expect(service.getStatus({ projectRoot: "/Users/ade/project-alpha" }).collectionProjectRoot).toBe("/Users/ade/project-alpha");
    expect(service.getStatus({ projectRoot: "/Users/ade/project-alpha" }).url).toBe("https://alpha.example.test/");
  });

  it("attaches project-scoped browser views without waiting for a window focus event", async () => {
    const projectRootByWindow = new Map<number, string>();
    const windowsByProjectRoot = new Map<string, ReturnType<typeof fakeBrowserWindow>>();
    const service = createBuiltInBrowserService({
      onEvent: collector.onEvent,
      getProjectRootForWindow: (win) => projectRootByWindow.get(win.id) ?? null,
      getWindowForProjectRoot: (projectRoot) =>
        (
          windowsByProjectRoot.get(projectRoot) as unknown as
            Parameters<ReturnType<typeof createBuiltInBrowserService>["attachToWindow"]>[0] | undefined
        ) ?? null,
    });
    const win = fakeBrowserWindow();
    const browserWin = win as unknown as Parameters<typeof service.attachToWindow>[0];
    windowsByProjectRoot.set("/Users/ade/project-alpha", win);
    windowsByProjectRoot.set("/Users/ade/project-beta", win);

    service.attachToWindow(browserWin);
    projectRootByWindow.set(win.id, "/Users/ade/project-alpha");
    await service.setBounds({
      projectRoot: "/Users/ade/project-alpha",
      x: 12,
      y: 24,
      width: 640,
      height: 360,
      visible: true,
    });

    expect(service.getStatus({ projectRoot: "/Users/ade/project-alpha" })).toMatchObject({
      attached: true,
      collectionProjectRoot: "/Users/ade/project-alpha",
      visible: true,
    });
    expect(win.contentView.children).toHaveLength(1);

    projectRootByWindow.set(win.id, "/Users/ade/project-beta");
    await service.setBounds({
      projectRoot: "/Users/ade/project-beta",
      x: 12,
      y: 24,
      width: 640,
      height: 360,
      visible: true,
    });

    expect(service.getStatus({ projectRoot: "/Users/ade/project-beta" })).toMatchObject({
      attached: true,
      collectionProjectRoot: "/Users/ade/project-beta",
      visible: true,
    });
    expect(win.contentView.children).toHaveLength(1);
    expect(service.getStatus({ projectRoot: "/Users/ade/project-alpha" })).toMatchObject({
      attached: false,
      visible: false,
    });
  });

  it("keeps same-project view attachment stable across repeated project-scoped calls", async () => {
    const projectRootByWindow = new Map<number, string>();
    const windowsByProjectRoot = new Map<string, ReturnType<typeof fakeBrowserWindow>>();
    const service = createBuiltInBrowserService({
      onEvent: collector.onEvent,
      getProjectRootForWindow: (win) => projectRootByWindow.get(win.id) ?? null,
      getWindowForProjectRoot: (projectRoot) =>
        (
          windowsByProjectRoot.get(projectRoot) as unknown as
            Parameters<ReturnType<typeof createBuiltInBrowserService>["attachToWindow"]>[0] | undefined
        ) ?? null,
    });
    const win = fakeBrowserWindow();
    const browserWin = win as unknown as Parameters<typeof service.attachToWindow>[0];
    projectRootByWindow.set(win.id, "/Users/ade/project-alpha");
    windowsByProjectRoot.set("/Users/ade/project-alpha", win);

    service.attachToWindow(browserWin);
    await service.setBounds({
      projectRoot: "/Users/ade/project-alpha",
      x: 12,
      y: 24,
      width: 640,
      height: 360,
      visible: true,
    });

    expect(win.contentView.children).toHaveLength(1);
    const attachedView = win.contentView.children[0];
    const addCalls = win.addChildViewCalls.length;
    const removeCalls = win.removeChildViewCalls.length;

    expect(service.getStatus({ projectRoot: "/Users/ade/project-alpha" })).toMatchObject({
      attached: true,
      visible: true,
    });
    await service.setBounds({
      projectRoot: "/Users/ade/project-alpha",
      x: 12,
      y: 24,
      width: 640,
      height: 360,
      visible: true,
    });

    expect(win.contentView.children).toEqual([attachedView]);
    expect(win.addChildViewCalls).toHaveLength(addCalls);
    expect(win.removeChildViewCalls).toHaveLength(removeCalls);
  });

  it("keeps project browser views attached independently in separate ADE windows", async () => {
    const projectRootByWindow = new Map<number, string>();
    const windowsByProjectRoot = new Map<string, ReturnType<typeof fakeBrowserWindow>>();
    const service = createBuiltInBrowserService({
      onEvent: collector.onEvent,
      getProjectRootForWindow: (win) => projectRootByWindow.get(win.id) ?? null,
      getWindowForProjectRoot: (projectRoot) =>
        (
          windowsByProjectRoot.get(projectRoot) as unknown as
            Parameters<ReturnType<typeof createBuiltInBrowserService>["attachToWindow"]>[0] | undefined
        ) ?? null,
    });
    const winA = fakeBrowserWindow();
    const winB = fakeBrowserWindow();
    projectRootByWindow.set(winA.id, "/Users/ade/project-alpha");
    projectRootByWindow.set(winB.id, "/Users/ade/project-beta");
    windowsByProjectRoot.set("/Users/ade/project-alpha", winA);
    windowsByProjectRoot.set("/Users/ade/project-beta", winB);

    await service.setBounds({
      projectRoot: "/Users/ade/project-alpha",
      x: 12,
      y: 24,
      width: 640,
      height: 360,
      visible: true,
    });
    await service.setBounds({
      projectRoot: "/Users/ade/project-beta",
      x: 20,
      y: 32,
      width: 800,
      height: 420,
      visible: true,
    });

    expect(service.getStatus({ projectRoot: "/Users/ade/project-alpha" })).toMatchObject({
      attached: true,
      collectionProjectRoot: "/Users/ade/project-alpha",
      visible: true,
    });
    expect(service.getStatus({ projectRoot: "/Users/ade/project-beta" })).toMatchObject({
      attached: true,
      collectionProjectRoot: "/Users/ade/project-beta",
      visible: true,
    });
    expect(winA.contentView.children).toHaveLength(1);
    expect(winB.contentView.children).toHaveLength(1);
    expect(winA.contentView.children[0]).not.toBe(winB.contentView.children[0]);
  });

  it("re-resolves the active window tab collection for bridge-style calls after project switches", async () => {
    const projectRootByWindow = new Map<number, string>();
    const service = createBuiltInBrowserService({
      onEvent: collector.onEvent,
      getProjectRootForWindow: (win) => projectRootByWindow.get(win.id) ?? null,
    });
    const win = fakeBrowserWindow();
    const browserWin = win as unknown as Parameters<typeof service.attachToWindow>[0];

    service.attachToWindow(browserWin);
    expect(service.getStatus().collectionKey).toBe("window");

    projectRootByWindow.set(win.id, "/Users/ade/project-after-startup");
    await service.createTab({ url: "https://example.test", activate: true });

    const status = service.getStatus();
    expect(status.collectionProjectRoot).toBe("/Users/ade/project-after-startup");
    expect(status.partition).toBe("persist:ade-browser");
    expect(status.tabs).toHaveLength(1);
    expect(fakes.webContentsViewInstances.at(-1)?.webPreferences).toMatchObject({
      partition: status.partition,
    });
  });

  it("targets browser events to the owning ADE window", async () => {
    const targetedEvents: Array<{ payload: BuiltInBrowserEventPayload; targetWindow: unknown }> = [];
    const service = createBuiltInBrowserService({
      onEvent: (payload, targetWindow) => targetedEvents.push({ payload, targetWindow }),
    });
    const winA = fakeBrowserWindow();
    const winB = fakeBrowserWindow();
    const browserWinA = winA as unknown as Parameters<typeof service.attachToWindow>[0];
    const browserWinB = winB as unknown as Parameters<typeof service.attachToWindow>[0];

    service.attachToWindow(browserWinA);
    targetedEvents.length = 0;
    await service.createTab({ url: "https://a.example.test", activate: true }, browserWinA);

    expect(targetedEvents.length).toBeGreaterThan(0);
    expect(targetedEvents.every((event) => event.targetWindow === browserWinA)).toBe(true);

    service.attachToWindow(browserWinB);
    targetedEvents.length = 0;
    await service.createTab({ url: "https://b.example.test", activate: true }, browserWinB);

    expect(targetedEvents.length).toBeGreaterThan(0);
    expect(targetedEvents.every((event) => event.targetWindow === browserWinB)).toBe(true);
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

  it("recovers crashed browser renderers to a blank tab with an error event", async () => {
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };
    let resolveRecovery: () => void = () => undefined;
    const recovered = new Promise<void>((resolve) => {
      resolveRecovery = resolve;
    });
    const service = createBuiltInBrowserService({
      getLogger: () => logger,
      onEvent: (event) => {
        collector.onEvent(event);
        if (
          event.type === "error"
          && event.message.includes("renderer exited (crashed, exit code 133)")
          && event.message.includes("Recovered the tab to a blank page")
        ) {
          resolveRecovery();
        }
      },
    });
    service.attachToWindow(fakeBrowserWindow() as unknown as Parameters<typeof service.attachToWindow>[0]);
    await service.createTab({ url: "https://linear.app/integrations/agents?code=secret", activate: true });
    collector.events.length = 0;

    const wc = fakes.webContentsInstances[0];
    expect(wc, "browser tab webContents exists").toBeTruthy();
    const originalLoadURL = wc.loadURL;
    wc.loadURL = vi.fn(async (url: string) => {
      await originalLoadURL(url);
    });

    wc.emit("render-process-gone", {}, {
      reason: "crashed",
      exitCode: 133,
    });
    await recovered;

    expect(service.getStatus().url).toBe("about:blank");
    expect(service.getStatus().tabs[0]).toMatchObject({
      url: "about:blank",
      isLoading: false,
    });
    expect(collector.events.some((event) => (
      event.type === "error"
      && event.message.includes("renderer exited (crashed, exit code 133)")
      && event.message.includes("Recovered the tab to a blank page")
    ))).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith("built_in_browser.render_process_gone", expect.objectContaining({
      reason: "crashed",
      exitCode: 133,
      url: "https://linear.app",
    }));
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
    expect(fakes.dispatchPermissionCheck("hid", "https://accounts.google.com")).toBe(false);
    expect(fakes.dispatchPermissionCheck("usb", "https://accounts.google.com")).toBe(false);
    expect(fakes.dispatchPermissionCheck("serial", "https://accounts.google.com")).toBe(false);

    expect(fakes.dispatchPermissionCheck("storage-access", "https://example.test")).toBe(false);
    expect(fakes.dispatchPermissionCheck("media", "https://accounts.google.com")).toBe(false);

    await expect(fakes.dispatchPermissionRequest("storage-access", {
      requestingUrl: "https://accounts.google.com/v3/signin/identifier",
    })).resolves.toBe(true);
    await expect(fakes.dispatchPermissionRequest("top-level-storage-access", {
      requestingUrl: "https://accounts.google.com/v3/signin/identifier",
    })).resolves.toBe(true);
    fakes.permissionPrompt.mockResolvedValue({ response: 1, checkboxChecked: false });
    await expect(fakes.dispatchPermissionRequest("media", {
      requestingUrl: "https://accounts.google.com/v3/signin/identifier",
    })).resolves.toBe(false);
    await expect(fakes.dispatchPermissionRequest("storage-access", {
      requestingUrl: "https://example.test/login",
    })).resolves.toBe(false);
  });

  it("lists and clears remembered browser permissions through the service", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-browser-permissions-service-"));
    const permissionFilePath = path.join(tempDir, "permissions.json");
    try {
      fakes.permissionPrompt.mockResolvedValue({ response: 0, checkboxChecked: true });
      const service = createBuiltInBrowserService({
        onEvent: collector.onEvent,
        permissionFilePath,
      });
      await service.createTab({ url: "https://example.test", activate: true });
      await expect(fakes.dispatchPermissionRequest("geolocation", {
        requestingUrl: "https://example.test/maps",
      })).resolves.toBe(true);

      expect(service.listPermissions()).toMatchObject({
        permissions: [{
          permission: "geolocation",
          origin: "https://example.test",
          decision: "allow",
        }],
      });
      await expect(service.clearPermissions({ origin: "https://example.test" })).resolves.toEqual({
        removed: 1,
        permissions: [],
      });
      await expect(service.clearPermissions({ origin: "not a URL" })).rejects.toThrow(/Invalid permission origin/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("revokes managed permission status when a browser tab closes", async () => {
    fakes.permissionPrompt.mockResolvedValue({ response: 0, checkboxChecked: true });
    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });
    await service.createTab({ url: "https://example.test", activate: true });
    const tabId = service.getStatus().activeTabId;
    await service.closeTab({ tabId: tabId ?? "" });

    await expect(fakes.dispatchPermissionRequest("notifications", {
      requestingUrl: "https://example.test/alerts",
    })).resolves.toBe(false);
    expect(fakes.permissionPrompt).not.toHaveBeenCalled();
  });

  it("intercepts popup requests as real ADE browser tabs", async () => {
    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });
    await service.createTab({
      url: "http://localhost:5173",
      activate: true,
    });
    const firstTabId = service.getStatus().activeTabId;
    const firstWc = fakes.webContentsInstances[0];
    const postData = [{ bytes: Buffer.from("token=abc"), type: "rawData" }];

    const response = firstWc?.openWindow("https://accounts.google.com/gsi/select", {
      referrer: { url: "https://example.test/sign-in", policy: "strict-origin-when-cross-origin" },
      postBody: {
        contentType: "application/x-www-form-urlencoded",
        data: postData,
      },
    });

    expect(response?.action).toBe("allow");
    expect(response?.createWindow).toEqual(expect.any(Function));
    const popupWc = response?.createWindow?.({
      webPreferences: {
        additionalArguments: ["--popup"],
        javascript: false,
        nodeIntegration: true,
        partition: "persist:other",
        webviewTag: true,
      },
    });
    expect(popupWc).toBe(fakes.webContentsInstances.at(-1));
    await popupWc?.loadURL("https://accounts.google.com/gsi/select");

    expect(service.getStatus().tabs).toHaveLength(2);
    expect(service.getStatus().activeTabId).not.toBe(firstTabId);
    expect(service.getStatus().tabs.at(-1)).toMatchObject({
      url: "https://accounts.google.com/gsi/select",
      ownerLaneId: null,
      ownerChatSessionId: null,
    });
    const popupWebPreferences = fakes.webContentsViewInstances.at(-1)?.webPreferences as Record<string, unknown>;
    expect(popupWebPreferences).toMatchObject({
      partition: service.getStatus().partition,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
    });
    expect(popupWebPreferences.additionalArguments).toBeUndefined();
    expect(popupWebPreferences.javascript).toBeUndefined();
    expect(popupWebPreferences.webviewTag).toBeUndefined();

    const openEvent = collector.events.findLast((event) => event.type === "open-request");
    expect(openEvent).toMatchObject({
      type: "open-request",
      url: "https://accounts.google.com/gsi/select",
      tabId: service.getStatus().activeTabId,
    });
  });

  it("blocks agent-triggered high-risk popups until the origin is human-approved", async () => {
    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });
    await service.createTab({
      url: "https://example.test",
      activate: true,
      laneId: "lane-1",
      chatSessionId: "chat-1",
    });

    const response = fakes.webContentsInstances[0]?.openWindow(
      "https://accounts.google.com/gsi/select",
    );

    expect(response?.action).toBe("deny");
    expect(collector.events.at(-1)).toMatchObject({
      type: "error",
      message: expect.stringContaining("Navigate to that origin explicitly"),
    });
  });

  it("requires chat-scoped human approval before agent navigation uses a high-risk origin", async () => {
    fakes.permissionPrompt.mockResolvedValue({ response: 0, checkboxChecked: false });
    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });

    await service.navigate({
      url: "https://github.com/settings/tokens",
      newTab: true,
      laneId: "lane-1",
      chatSessionId: "chat-1",
    });
    const tabId = service.getStatus().activeTabId ?? "";
    expect(fakes.permissionPrompt).toHaveBeenCalledTimes(1);
    expect(service.getStatus({ tabId, laneId: "lane-1", chatSessionId: "chat-1" }).url)
      .toBe("https://github.com/settings/tokens");
    expect(() => service.getStatus({ tabId, laneId: "lane-2", chatSessionId: "chat-2" }))
      .toThrow(/leased by chat chat-1/);
  });

  it("blocks a high-risk redirect triggered by an agent page action", async () => {
    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });
    await service.createTab({
      url: "http://localhost:5173",
      activate: true,
      laneId: "lane-1",
      chatSessionId: "chat-1",
    });
    fakes.permissionPrompt.mockResolvedValue({ response: 1, checkboxChecked: false });
    const tabId = service.getStatus().activeTabId ?? "";
    await service.click({
      tabId,
      x: 10,
      y: 20,
      laneId: "lane-1",
      chatSessionId: "chat-1",
      observe: false,
    });

    const wc = fakes.webContentsInstances[0];
    const loadCountBeforeRedirect = wc?.loadURLCalls.length ?? 0;
    const redirectEvent = { preventDefault: vi.fn() };
    wc?.emit("will-redirect", redirectEvent, "https://console.aws.amazon.com/");
    expect(redirectEvent.preventDefault).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(fakes.permissionPrompt).toHaveBeenCalledTimes(1));
    expect(wc?.getURL()).toBe("http://localhost:5173/");
    expect(wc?.loadURLCalls).toHaveLength(loadCountBeforeRedirect);
    await vi.waitFor(() => expect(collector.events.at(-1)).toMatchObject({
      type: "error",
      message: expect.stringContaining("Blocked agent-triggered redirect"),
    }));
  });

  it("keeps delayed agent redirects behind the human approval boundary", async () => {
    const realDateNow = Date.now.bind(Date);
    let dateNow: { mockRestore(): void } | null = null;
    try {
      const service = createBuiltInBrowserService({ onEvent: collector.onEvent });
      await service.createTab({
        url: "http://localhost:5173",
        activate: true,
        laneId: "lane-1",
        chatSessionId: "chat-1",
      });
      fakes.permissionPrompt.mockResolvedValue({ response: 1, checkboxChecked: false });
      const tabId = service.getStatus().activeTabId ?? "";
      await service.click({
        tabId,
        x: 10,
        y: 20,
        laneId: "lane-1",
        chatSessionId: "chat-1",
        observe: false,
      });
      dateNow = vi.spyOn(Date, "now").mockImplementation(() => realDateNow() + 60_000);

      const redirectEvent = { preventDefault: vi.fn() };
      fakes.webContentsInstances[0]?.emit(
        "will-redirect",
        redirectEvent,
        "https://console.aws.amazon.com/",
      );

      expect(redirectEvent.preventDefault).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(fakes.permissionPrompt).toHaveBeenCalledTimes(1));
    } finally {
      dateNow?.mockRestore();
    }
  });

  it("keeps delayed agent popups behind the human approval boundary", async () => {
    const realDateNow = Date.now.bind(Date);
    let dateNow: { mockRestore(): void } | null = null;
    try {
      const service = createBuiltInBrowserService({ onEvent: collector.onEvent });
      await service.createTab({
        url: "http://localhost:5173",
        activate: true,
        laneId: "lane-1",
        chatSessionId: "chat-1",
      });
      const tabId = service.getStatus().activeTabId ?? "";
      await service.click({
        tabId,
        x: 10,
        y: 20,
        laneId: "lane-1",
        chatSessionId: "chat-1",
        observe: false,
      });
      dateNow = vi.spyOn(Date, "now").mockImplementation(() => realDateNow() + 60_000);

      const response = fakes.webContentsInstances[0]?.openWindow(
        "https://accounts.google.com/gsi/select",
      );

      expect(response?.action).toBe("deny");
    } finally {
      dateNow?.mockRestore();
    }
  });

  it("clears the persistent agent navigation guard on explicit human navigation", async () => {
    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });
    const agentStatus = await service.createTab({
      url: "http://localhost:5173",
      activate: true,
      laneId: "lane-1",
      chatSessionId: "chat-1",
    });
    const tabId = agentStatus.activeTabId ?? "";
    await service.click({
      tabId,
      x: 10,
      y: 20,
      laneId: "lane-1",
      chatSessionId: "chat-1",
      observe: false,
    });

    await service.navigate({ tabId, url: "http://localhost:5174/human" });

    expect(service.getStatus()).toMatchObject({
      ownerLaneId: null,
      ownerChatSessionId: null,
      ownerLeaseExpiresAt: null,
    });
    const popup = fakes.webContentsInstances[0]?.openWindow("https://example.test/human-popup");
    expect(popup?.action).toBe("allow");
  });

  it("assigns ADE browser downloads to the user's Downloads folder", async () => {
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };
    const service = createBuiltInBrowserService({ getLogger: () => logger, onEvent: collector.onEvent });
    await service.createTab({ url: "https://example.test", activate: true });
    const doneHandlers: Array<(_event: unknown, state: "completed" | "cancelled" | "interrupted") => void> = [];
    const item = {
      getFilename: vi.fn(() => "report?:final.zip"),
      getURL: vi.fn(() => "https://example.test/report.zip?token=secret"),
      setSavePath: vi.fn(),
      once: vi.fn((event: "done", handler: (_event: unknown, state: "completed" | "cancelled" | "interrupted") => void) => {
        if (event === "done") doneHandlers.push(handler);
      }),
    };

    const event = fakes.dispatchWillDownload(item);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(item.setSavePath).toHaveBeenCalledWith(path.join("/Users/test/Downloads", "report__final.zip"));
    expect(item.once).toHaveBeenCalledWith("done", expect.any(Function));

    doneHandlers[0]?.({}, "completed");

    const tab = service.getStatus().tabs[0];
    expect(tab?.id).toEqual(expect.any(String));
    expect(collector.events.at(-1)).toMatchObject({ type: "status" });
    expect(logger.info).toHaveBeenCalledWith("built_in_browser.download_started", expect.objectContaining({
      fileName: "report__final.zip",
      tabId: tab?.id,
      urlOrigin: "https://example.test",
    }));
    const logPayload = JSON.stringify(logger.info.mock.calls);
    expect(logPayload).not.toContain("token=secret");
    expect(logPayload).not.toContain("/Users/test/Downloads");
  });

  it("uses a unique filename when a browser download would overwrite an existing file", async () => {
    const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-browser-download-"));
    try {
      fs.writeFileSync(path.join(downloadDir, "report.zip"), "");
      fs.writeFileSync(path.join(downloadDir, "report (1).zip"), "");
      fakes.appGetPath.mockImplementationOnce(() => downloadDir);
      const service = createBuiltInBrowserService({ onEvent: collector.onEvent });
      await service.createTab({ url: "https://example.test", activate: true });
      const doneHandlers: Array<(_event: unknown, state: "completed" | "cancelled" | "interrupted") => void> = [];
      const item = {
        getFilename: vi.fn(() => "report.zip"),
        getURL: vi.fn(() => "https://example.test/report.zip"),
        setSavePath: vi.fn(),
        once: vi.fn((event: "done", handler: (_event: unknown, state: "completed" | "cancelled" | "interrupted") => void) => {
          if (event === "done") doneHandlers.push(handler);
        }),
      };

      fakes.dispatchWillDownload(item);

      expect(item.setSavePath).toHaveBeenCalledWith(path.join(downloadDir, "report (2).zip"));
      doneHandlers[0]?.({}, "completed");
    } finally {
      fs.rmSync(downloadDir, { recursive: true, force: true });
    }
  });

  it("reserves in-flight browser download filenames until the download completes", async () => {
    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });
    await service.createTab({ url: "https://example.test", activate: true });
    const doneHandlers: Array<Array<(_event: unknown, state: "completed" | "cancelled" | "interrupted") => void>> = [];
    const itemFor = (index: number) => {
      doneHandlers[index] = [];
      return {
        getFilename: vi.fn(() => "report.zip"),
        getURL: vi.fn(() => "https://example.test/report.zip"),
        setSavePath: vi.fn(),
        once: vi.fn((event: "done", handler: (_event: unknown, state: "completed" | "cancelled" | "interrupted") => void) => {
          if (event === "done") doneHandlers[index]?.push(handler);
        }),
      };
    };

    const first = itemFor(0);
    const second = itemFor(1);
    const third = itemFor(2);

    fakes.dispatchWillDownload(first);
    fakes.dispatchWillDownload(second);

    expect(first.setSavePath).toHaveBeenCalledWith(path.join("/Users/test/Downloads", "report.zip"));
    expect(second.setSavePath).toHaveBeenCalledWith(path.join("/Users/test/Downloads", "report (1).zip"));

    doneHandlers[0]?.[0]?.({}, "completed");
    fakes.dispatchWillDownload(third);

    expect(third.setSavePath).toHaveBeenCalledWith(path.join("/Users/test/Downloads", "report.zip"));
    doneHandlers[1]?.[0]?.({}, "completed");
    doneHandlers[2]?.[0]?.({}, "completed");
  });

  it("reserves in-flight browser download filenames across project tab collections", async () => {
    const projectRootByWindow = new Map<number, string>();
    const service = createBuiltInBrowserService({
      getProjectRootForWindow: (win) => projectRootByWindow.get(win.id) ?? null,
      onEvent: collector.onEvent,
    });
    const winA = fakeBrowserWindow();
    const winB = fakeBrowserWindow();
    projectRootByWindow.set(winA.id, "/Users/ade/project-alpha");
    projectRootByWindow.set(winB.id, "/Users/ade/project-beta");
    const browserWinA = winA as unknown as Parameters<typeof service.attachToWindow>[0];
    const browserWinB = winB as unknown as Parameters<typeof service.attachToWindow>[0];
    service.attachToWindow(browserWinA);
    service.attachToWindow(browserWinB);
    await service.createTab({ url: "https://alpha.example.test", activate: true }, browserWinA);
    await service.createTab({ url: "https://beta.example.test", activate: true }, browserWinB);
    const doneHandlers: Array<Array<(_event: unknown, state: "completed" | "cancelled" | "interrupted") => void>> = [];
    const itemFor = (index: number) => {
      doneHandlers[index] = [];
      return {
        getFilename: vi.fn(() => "report.zip"),
        getURL: vi.fn(() => "https://example.test/report.zip"),
        setSavePath: vi.fn(),
        once: vi.fn((event: "done", handler: (_event: unknown, state: "completed" | "cancelled" | "interrupted") => void) => {
          if (event === "done") doneHandlers[index]?.push(handler);
        }),
      };
    };
    const first = itemFor(0);
    const second = itemFor(1);

    fakes.dispatchWillDownload(first, fakes.webContentsInstances[0] ?? null);
    fakes.dispatchWillDownload(second, fakes.webContentsInstances[1] ?? null);

    expect(first.setSavePath).toHaveBeenCalledWith(path.join("/Users/test/Downloads", "report.zip"));
    expect(second.setSavePath).toHaveBeenCalledWith(path.join("/Users/test/Downloads", "report (1).zip"));

    doneHandlers[0]?.[0]?.({}, "completed");
    doneHandlers[1]?.[0]?.({}, "completed");
  });

  it("treats in-flight download reservations as case-insensitive on case-insensitive platforms", async () => {
    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });
    await service.createTab({ url: "https://example.test", activate: true });
    const doneHandlers: Array<Array<(_event: unknown, state: "completed" | "cancelled" | "interrupted") => void>> = [];
    const itemFor = (index: number, filename: string) => {
      doneHandlers[index] = [];
      return {
        getFilename: vi.fn(() => filename),
        getURL: vi.fn(() => `https://example.test/${filename}`),
        setSavePath: vi.fn(),
        once: vi.fn((event: "done", handler: (_event: unknown, state: "completed" | "cancelled" | "interrupted") => void) => {
          if (event === "done") doneHandlers[index]?.push(handler);
        }),
      };
    };
    const first = itemFor(0, "Report.zip");
    const second = itemFor(1, "report.zip");

    fakes.dispatchWillDownload(first);
    fakes.dispatchWillDownload(second);

    expect(first.setSavePath).toHaveBeenCalledWith(path.join("/Users/test/Downloads", "Report.zip"));
    const expectedSecondPath = process.platform === "darwin" || process.platform === "win32"
      ? path.join("/Users/test/Downloads", "report (1).zip")
      : path.join("/Users/test/Downloads", "report.zip");
    expect(second.setSavePath).toHaveBeenCalledWith(expectedSecondPath);

    doneHandlers[0]?.[0]?.({}, "completed");
    doneHandlers[1]?.[0]?.({}, "completed");
  });

  it("blocks a download that cannot be mapped to a managed browser tab", async () => {
    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });
    await service.createTab({ url: "https://example.test", activate: true });
    const managedWebContents = fakes.webContentsInstances[0];
    const unmanagedWebContents = { session: managedWebContents?.session ?? null } as typeof managedWebContents;
    const item = {
      getFilename: vi.fn(() => "report.zip"),
      getURL: vi.fn(() => "https://example.test/report.zip"),
      setSavePath: vi.fn(),
      once: vi.fn(),
    };

    const event = fakes.dispatchWillDownload(item, unmanagedWebContents);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(item.setSavePath).not.toHaveBeenCalled();
    expect(collector.events.at(-1)).toMatchObject({
      type: "error",
      message: expect.stringContaining("unmanaged webContents"),
    });
  });

  it("cancels a download when no unique filename is available", async () => {
    const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-browser-download-full-"));
    try {
      fs.writeFileSync(path.join(downloadDir, "report.zip"), "");
      for (let index = 1; index < 1_000; index += 1) {
        fs.writeFileSync(path.join(downloadDir, `report (${index}).zip`), "");
      }
      fakes.appGetPath.mockImplementationOnce(() => downloadDir);
      const service = createBuiltInBrowserService({ onEvent: collector.onEvent });
      await service.createTab({ url: "https://example.test", activate: true });
      const item = {
        getFilename: vi.fn(() => "report.zip"),
        getURL: vi.fn(() => "https://example.test/report.zip"),
        setSavePath: vi.fn(),
        once: vi.fn(),
      };

      const event = fakes.dispatchWillDownload(item);

      expect(event.preventDefault).toHaveBeenCalled();
      expect(item.setSavePath).not.toHaveBeenCalled();
      expect(collector.events.at(-1)).toMatchObject({
        type: "error",
        message: expect.stringContaining("Could not find an unused download filename"),
      });
    } finally {
      fs.rmSync(downloadDir, { recursive: true, force: true });
    }
  });

  it("cancels a download instead of letting setup errors escape the session handler", async () => {
    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });
    await service.createTab({ url: "https://example.test", activate: true });
    fakes.appGetPath.mockImplementationOnce(() => {
      throw new Error("Downloads folder unavailable");
    });
    const item = {
      getFilename: vi.fn(() => "report.zip"),
      getURL: vi.fn(() => "https://example.test/report.zip"),
      setSavePath: vi.fn(),
      once: vi.fn(),
    };

    const event = fakes.dispatchWillDownload(item);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(item.setSavePath).not.toHaveBeenCalled();
    expect(collector.events.at(-1)).toMatchObject({
      type: "error",
      message: expect.stringContaining("Could not start ADE browser download"),
    });
  });

  it("removes the browser download listener when the window service is disposed", async () => {
    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });
    await service.createTab({ url: "https://example.test", activate: true });
    expect(fakes.sessionEventHandlers.some((entry) => entry.event === "will-download")).toBe(true);

    service.dispose();

    expect(fakes.sessionEventHandlers.some((entry) => entry.event === "will-download")).toBe(false);
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

  it("tracks explicit lane claims instead of inferring Browser ownership from the visible sidebar", async () => {
    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });

    expect(service.getStatus()).toMatchObject({
      ownerLaneId: null,
      ownerChatSessionId: null,
      ownerClaimedAt: null,
    });

    await service.createTab({
      url: "https://example.test",
      activate: true,
      openPanel: true,
      laneId: "lane-1",
      chatSessionId: "chat-1",
    });

    const status = service.getStatus();
    expect(status.ownerLaneId).toBe("lane-1");
    expect(status.ownerChatSessionId).toBe("chat-1");
    expect(status.ownerClaimedAt).toEqual(expect.any(String));
    expect(status.tabs[0]).toMatchObject({
      ownerLaneId: "lane-1",
      ownerChatSessionId: "chat-1",
      ownerClaimedAt: expect.any(String),
    });
    const openEvent = collector.events.findLast((event) => event.type === "open-request");
    expect(openEvent).toMatchObject({
      type: "open-request",
      status: {
        ownerLaneId: "lane-1",
        ownerChatSessionId: "chat-1",
      },
    });
  });

  it("tracks browser ownership per tab and keeps the active owner as a compatibility alias", async () => {
    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });

    await service.createTab({
      url: "http://localhost:4201/first",
      activate: true,
      laneId: "lane-1",
      chatSessionId: "chat-1",
    });
    const firstTabId = service.getStatus().activeTabId;

    await service.createTab({
      url: "http://localhost:4202/second",
      activate: true,
      laneId: "lane-2",
      chatSessionId: "chat-2",
    });
    const secondTabId = service.getStatus().activeTabId;

    expect(firstTabId).toEqual(expect.any(String));
    expect(secondTabId).toEqual(expect.any(String));
    expect(secondTabId).not.toBe(firstTabId);

    let status = service.getStatus();
    expect(status.ownerLaneId).toBe("lane-2");
    expect(status.tabs.find((tab) => tab.id === firstTabId)).toMatchObject({
      ownerLaneId: "lane-1",
      ownerChatSessionId: "chat-1",
    });
    expect(status.tabs.find((tab) => tab.id === secondTabId)).toMatchObject({
      ownerLaneId: "lane-2",
      ownerChatSessionId: "chat-2",
    });

    service.claim({ tabId: firstTabId, laneId: "lane-3", chatSessionId: "chat-3", force: true });
    status = service.getStatus();
    expect(status.activeTabId).toBe(secondTabId);
    expect(status.ownerLaneId).toBe("lane-2");
    expect(status.tabs.find((tab) => tab.id === firstTabId)).toMatchObject({
      ownerLaneId: "lane-3",
      ownerChatSessionId: "chat-3",
    });

    await service.switchTab({ tabId: firstTabId ?? "" });
    status = service.getStatus();
    expect(status.activeTabId).toBe(firstTabId);
    expect(status.ownerLaneId).toBe("lane-3");
    expect(status.ownerChatSessionId).toBe("chat-3");
  });

  it("reuses the current chat's owned tab for agent browser opens", async () => {
    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });

    await service.createTab({
      url: "https://first.test",
      activate: true,
      laneId: "lane-1",
      chatSessionId: "chat-1",
    });
    const firstTabId = service.getStatus().activeTabId;

    await service.createTab({
      url: "https://second.test",
      activate: true,
      laneId: "lane-2",
      chatSessionId: "chat-2",
    });
    const secondTabId = service.getStatus().activeTabId;

    let status = await service.navigate({
      url: "https://reused.test",
      laneId: "lane-1",
      chatSessionId: "chat-1",
      reuseOwnedTab: true,
      openPanel: true,
    });

    expect(status.tabs).toHaveLength(1);
    expect(status.activeTabId).toBe(firstTabId);
    expect(status.url).toBe("https://reused.test/");
    expect(status.tabs.find((tab) => tab.id === firstTabId)).toMatchObject({
      url: "https://reused.test/",
      ownerLaneId: "lane-1",
      ownerChatSessionId: "chat-1",
    });
    expect(status.tabs.find((tab) => tab.id === secondTabId)).toBeUndefined();

    status = await service.navigate({
      url: "https://fresh.test",
      laneId: "lane-3",
      chatSessionId: "chat-3",
      reuseOwnedTab: true,
    });

    expect(status.tabs).toHaveLength(1);
    expect(status.url).toBe("https://fresh.test/");
    expect(status.tabs.at(-1)).toMatchObject({
      url: "https://fresh.test/",
      ownerLaneId: "lane-3",
      ownerChatSessionId: "chat-3",
    });
    expect(service.getStatus().tabs).toHaveLength(3);
  });

  it("does not reuse a same-lane tab owned by another chat when chat identity is missing", async () => {
    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });

    await service.createTab({
      url: "https://chat-owned.test",
      activate: true,
      laneId: "lane-1",
      chatSessionId: "chat-1",
    });
    const firstTabId = service.getStatus().activeTabId;

    const status = await service.navigate({
      url: "https://lane-only.test",
      laneId: "lane-1",
      reuseOwnedTab: true,
    });

    expect(status.tabs).toHaveLength(1);
    expect(status.activeTabId).not.toBe(firstTabId);
    expect(status.tabs.find((tab) => tab.id === firstTabId)).toBeUndefined();
    expect(service.getStatus().tabs.find((tab) => tab.id === firstTabId)).toMatchObject({
      url: "https://chat-owned.test/",
      ownerChatSessionId: "chat-1",
    });
    expect(status.tabs.at(-1)).toMatchObject({
      url: "https://lane-only.test/",
      ownerLaneId: "lane-1",
      ownerChatSessionId: null,
    });
  });

  it("navigates and drives an owned browser tab in the background", async () => {
    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });

    await service.createTab({
      url: "https://owned.test",
      activate: true,
      laneId: "lane-1",
      chatSessionId: "chat-1",
    });
    const ownedTabId = service.getStatus().activeTabId;

    await service.createTab({
      url: "https://visible.test",
      activate: true,
      laneId: "lane-2",
      chatSessionId: "chat-2",
    });
    const visibleTabId = service.getStatus().activeTabId;

    let status = await service.navigate({
      url: "https://background.test",
      laneId: "lane-1",
      chatSessionId: "chat-1",
      reuseOwnedTab: true,
      activate: false,
      openPanel: false,
    });

    expect(status.tabs).toHaveLength(1);
    expect(status.activeTabId).toBeNull();
    expect(status.tabs.find((tab) => tab.id === ownedTabId)).toMatchObject({
      url: "https://background.test/",
      ownerLaneId: "lane-1",
      ownerChatSessionId: "chat-1",
    });

    const clickResult = await service.click({
      x: 10,
      y: 20,
      laneId: "lane-1",
      chatSessionId: "chat-1",
      observe: false,
    });
    const screenshot = await service.captureScreenshot({
      laneId: "lane-1",
      chatSessionId: "chat-1",
    });

    status = service.getStatus();
    expect(status.activeTabId).toBe(visibleTabId);
    expect(clickResult.trace).toMatchObject({
      tabId: ownedTabId,
      status: "ok",
    });
    expect(screenshot).toMatchObject({
      width: 320,
      height: 180,
    });
  });

  it("captures a non-active tab by id without switching the visible tab", async () => {
    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });

    await service.createTab({ url: "https://first.test", activate: true, laneId: "lane-1" });
    const firstTabId = service.getStatus().activeTabId;
    await service.createTab({ url: "https://second.test", activate: true, laneId: "lane-2" });
    const activeBeforeCapture = service.getStatus().activeTabId;

    const screenshot = await service.captureScreenshot({ tabId: firstTabId });

    expect(screenshot).toMatchObject({
      width: 320,
      height: 180,
      dataUrl: "data:image/png;base64,dGVzdA==",
    });
    expect(service.getStatus().activeTabId).toBe(activeBeforeCapture);
  });

  it("starts, lists, ends, and cleans up browser sessions", async () => {
    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });

    await service.createTab({ url: "https://session.test", activate: true, laneId: "lane-1", chatSessionId: "chat-1" });
    const tabId = service.getStatus().activeTabId ?? "";

    const started = service.startSession({ tabId, laneId: "lane-1", chatSessionId: "chat-1" });
    expect(started.session).toMatchObject({
      id: expect.stringMatching(/^bs-/),
      tabId,
      ownerLaneId: "lane-1",
      ownerChatSessionId: "chat-1",
      endedAt: null,
      lastObservationId: null,
      lastTraceEntryId: null,
    });
    expect(service.listSessions().sessions.map((entry) => entry.id)).toEqual([started.session.id]);

    const ended = service.endSession({ sessionId: started.session.id });
    expect(ended.session.endedAt).toEqual(expect.any(String));
    expect(service.listSessions().sessions).toEqual([]);
    expect(service.listSessions({ includeEnded: true }).sessions.map((entry) => entry.id)).toEqual([started.session.id]);

    const restarted = service.startSession({ tabId, laneId: "lane-1", chatSessionId: "chat-1" });
    await service.closeTab({ tabId, laneId: "lane-1", chatSessionId: "chat-1" });
    expect(service.listSessions({ includeEnded: true }).sessions.find((entry) => entry.id === restarted.session.id)?.endedAt).toEqual(expect.any(String));
  });

  it("writes scratch observations and prunes them to the requested keep count", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-browser-observe-"));
    try {
      const projectRootByWindow = new Map<number, string>();
      const service = createBuiltInBrowserService({
        onEvent: collector.onEvent,
        getProjectRootForWindow: (win) => projectRootByWindow.get(win.id) ?? null,
      });
      const win = fakeBrowserWindow();
      projectRootByWindow.set(win.id, projectRoot);
      const browserWin = win as unknown as Parameters<typeof service.attachToWindow>[0];
      await service.createTab({ url: "https://observe.test", activate: true, laneId: "lane-1" }, browserWin);

      let observation = await service.observe({ keepCount: 3 }, browserWin);
      for (let index = 0; index < 4; index += 1) {
        observation = await service.observe({ keepCount: 3 }, browserWin);
      }

      expect(fs.existsSync(observation.filePath)).toBe(true);
      expect(observation.relativePath).toMatch(/^\.ade\/cache\/browser-observations\//);
      expect(observation.cleanup.keepCount).toBe(3);
      expect(observation.cleanup.keptCount).toBe(3);
      expect(observation.cleanup.deletedCount).toBe(1);
      const observationDir = path.dirname(observation.filePath);
      expect(fs.readdirSync(observationDir).filter((entry) => entry.endsWith(".png"))).toHaveLength(3);
      expect(fs.readdirSync(observationDir).filter((entry) => entry.endsWith(".json"))).toHaveLength(3);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("stores default action observations for personal tabs in machine-local scratch space", async () => {
    const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "ade-browser-personal-observe-"));
    try {
      fakes.appIsReady.mockReturnValue(true);
      fakes.appGetPath.mockImplementation((name: string) => (
        name === "downloads" ? "/Users/test/Downloads" : userDataPath
      ));
      const projectRootByWindow = new Map<number, string>();
      const service = createBuiltInBrowserService({
        onEvent: collector.onEvent,
        getProjectRootForWindow: (win) => projectRootByWindow.get(win.id) ?? null,
      });
      const win = fakeBrowserWindow();
      projectRootByWindow.set(win.id, "/Users/ade/project-alpha");
      const browserWin = win as unknown as Parameters<typeof service.attachToWindow>[0];
      await service.createTab({
        tabCollection: "personal",
        url: "http://localhost:5173/personal",
        activate: true,
        chatSessionId: "chat-personal",
      }, browserWin);

      const result = await service.click({
        tabCollection: "personal",
        x: 10,
        y: 20,
        waitAfterMs: 0,
        chatSessionId: "chat-personal",
      }, browserWin);

      const observation = result.observation;
      expect(observation).not.toBeNull();
      expect(observation?.filePath.startsWith(path.join(userDataPath, "browser-observations", "personal")))
        .toBe(true);
      expect(observation?.relativePath).toMatch(/^personal\//);
      expect(fs.existsSync(observation?.filePath ?? "")).toBe(true);
      service.dispose();
    } finally {
      fs.rmSync(userDataPath, { recursive: true, force: true });
    }
  });

  it("targets a non-active tab through a browser session id", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-browser-session-"));
    try {
      const commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
      fakes.setSendCommand(async (method, params) => {
        commands.push({ method, params });
        return {};
      });
      const projectRootByWindow = new Map<number, string>();
      const service = createBuiltInBrowserService({
        onEvent: collector.onEvent,
        getProjectRootForWindow: (win) => projectRootByWindow.get(win.id) ?? null,
      });
      const win = fakeBrowserWindow();
      projectRootByWindow.set(win.id, projectRoot);
      const browserWin = win as unknown as Parameters<typeof service.attachToWindow>[0];
      await service.createTab({ url: "https://first-session.test", activate: true, laneId: "lane-1" }, browserWin);
      const firstTabId = service.getStatus(browserWin).activeTabId ?? "";
      const started = service.startSession({ tabId: firstTabId, laneId: "lane-1" }, browserWin);
      await service.createTab({ url: "https://second-session.test", activate: true, laneId: "lane-2" }, browserWin);
      const activeBeforeAction = service.getStatus(browserWin).activeTabId;

      const clickResult = await service.click({ sessionId: started.session.id, x: 10, y: 20, laneId: "lane-1", observe: false }, browserWin);
      const observation = await service.observe({ sessionId: started.session.id, includeDom: false }, browserWin);
      const session = service.listSessions().sessions.find((entry) => entry.id === started.session.id);

      expect(service.getStatus(browserWin).activeTabId).toBe(activeBeforeAction);
      expect(clickResult).toMatchObject({
        ok: true,
        session: {
          id: started.session.id,
          tabId: firstTabId,
          lastTraceEntryId: clickResult.trace?.id,
        },
        trace: {
          tabId: firstTabId,
          sessionId: started.session.id,
        },
      });
      expect(observation).toMatchObject({
        tabId: firstTabId,
        sessionId: started.session.id,
      });
      expect(session).toMatchObject({
        id: started.session.id,
        lastObservationId: observation.id,
        lastTraceEntryId: clickResult.trace?.id,
      });
      expect(service.getTrace({ sessionId: started.session.id })).toMatchObject({
        sessionId: started.session.id,
        entries: [
          expect.objectContaining({
            id: clickResult.trace?.id,
            sessionId: started.session.id,
          }),
        ],
      });
      expect(commands).toEqual(expect.arrayContaining([
        expect.objectContaining({
          method: "Input.dispatchMouseEvent",
          params: expect.objectContaining({ type: "mousePressed", x: 10, y: 20 }),
        }),
      ]));
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("adds a DOM element snapshot to observations and can click a located element", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-browser-dom-"));
    try {
      const commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
      fakes.setSendCommand(async (method, params) => {
        commands.push({ method, params });
        if (method === "Runtime.evaluate") {
          return {
            result: {
              value: {
                snapshot: {
                  url: "https://dom.test",
                  title: "DOM test",
                  capturedAt: "2026-01-01T00:00:00.000Z",
                  viewport: { x: 0, y: 0, width: 320, height: 180 },
                  scroll: { x: 0, y: 0 },
                  elementCount: 1,
                  elements: [
                    {
                      index: 1,
                      tagName: "button",
                      role: null,
                      label: "Save",
                      text: "Save",
                      value: null,
                      placeholder: null,
                      selector: "button#save",
                      testId: "save-button",
                      href: null,
                      disabled: false,
                      frame: { x: 40, y: 50, width: 80, height: 30 },
                      center: { x: 80, y: 65 },
                    },
                  ],
                },
                target: {
                  index: 0,
                  tagName: "button",
                  role: null,
                  label: "Save",
                  text: "Save",
                  value: null,
                  placeholder: null,
                  selector: "button#save",
                  testId: "save-button",
                  href: null,
                  disabled: false,
                  frame: { x: 40, y: 50, width: 80, height: 30 },
                  center: { x: 80, y: 65 },
                },
              },
            },
          };
        }
        return {};
      });
      const projectRootByWindow = new Map<number, string>();
      const service = createBuiltInBrowserService({
        onEvent: collector.onEvent,
        getProjectRootForWindow: (win) => projectRootByWindow.get(win.id) ?? null,
      });
      const win = fakeBrowserWindow();
      projectRootByWindow.set(win.id, projectRoot);
      const browserWin = win as unknown as Parameters<typeof service.attachToWindow>[0];
      await service.createTab({ url: "https://dom.test", activate: true }, browserWin);
      const tabId = service.getStatus(browserWin).activeTabId ?? "";

      const observation = await service.observe({ tabId, maxElements: 5, includeElementMap: true }, browserWin);
      await service.click({ tabId, selector: "button#save", observe: false }, browserWin);
      await service.click({ tabId, handle: observation.dom?.elements[0]?.handle ?? "", observe: false }, browserWin);
      await expect(service.click({
        tabId,
        handle: "obs-x/../../outside:e:1",
        observe: false,
      }, browserWin)).rejects.toThrow(/Browser element handle/);

      expect(observation.dom?.elements[0]).toMatchObject({
        index: 1,
        handle: expect.stringMatching(/^obs-.+:e:1$/),
        selector: "button#save",
        label: "Save",
        center: { x: 80, y: 65 },
      });
      expect(observation.diagnostics).toMatchObject({
        pendingRequestCount: 0,
        console: [],
        network: [],
      });
      expect(observation.elementMap?.filePath).toMatch(/\.map\.png$/);
      expect(fs.existsSync(observation.elementMap?.filePath ?? "")).toBe(true);
      expect(commands).toEqual(expect.arrayContaining([
        expect.objectContaining({
          method: "Runtime.evaluate",
          params: expect.objectContaining({
            expression: expect.stringContaining("\"selector\":\"button#save\""),
          }),
        }),
        expect.objectContaining({
          method: "Input.dispatchMouseEvent",
          params: expect.objectContaining({ type: "mousePressed", x: 80, y: 65 }),
        }),
      ]));
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("adds console and network diagnostics to observations", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-browser-diagnostics-"));
    try {
      const projectRootByWindow = new Map<number, string>();
      const service = createBuiltInBrowserService({
        onEvent: collector.onEvent,
        getProjectRootForWindow: (win) => projectRootByWindow.get(win.id) ?? null,
      });
      const win = fakeBrowserWindow();
      projectRootByWindow.set(win.id, projectRoot);
      const browserWin = win as unknown as Parameters<typeof service.attachToWindow>[0];
      await service.createTab({ url: "https://diagnostics.test", activate: true }, browserWin);
      const tabId = service.getStatus(browserWin).activeTabId ?? "";
      const wc = fakes.webContentsInstances[0];
      if (!wc) throw new Error("Expected browser web contents.");

      wc.emit("console-message", {}, 3, "Boom", 42, "app.js");
      fakes.dispatchBeforeRequest({
        id: "pending",
        webContentsId: wc.id,
        url: "https://diagnostics.test/pending",
        method: "GET",
        resourceType: "xhr",
      });
      fakes.dispatchBeforeRequest({
        id: "failed",
        webContentsId: wc.id,
        url: "https://diagnostics.test/api",
        method: "POST",
        resourceType: "xhr",
      });
      fakes.dispatchRequestError({
        id: "failed",
        webContentsId: wc.id,
        url: "https://diagnostics.test/api",
        method: "POST",
        resourceType: "xhr",
        error: "net::ERR_FAILED",
      });
      fakes.dispatchBeforeRequest({
        id: "server-error",
        webContentsId: wc.id,
        url: "https://diagnostics.test/500",
        method: "GET",
        resourceType: "xhr",
      });
      fakes.dispatchRequestCompleted({
        id: "server-error",
        webContentsId: wc.id,
        url: "https://diagnostics.test/500",
        method: "GET",
        resourceType: "xhr",
        statusCode: 500,
      });
      fakes.dispatchBeforeRequest({
        id: 42,
        webContentsId: wc.id,
        url: "https://diagnostics.test/ok",
        method: "GET",
        resourceType: "xhr",
      });
      fakes.dispatchRequestCompleted({
        id: 42,
        webContentsId: wc.id,
        url: "https://diagnostics.test/ok",
        method: "GET",
        resourceType: "xhr",
        statusCode: 200,
      });

      const observation = await service.observe({ tabId, includeDom: false }, browserWin);

      expect(observation.diagnostics).toMatchObject({
        pendingRequestCount: 1,
        console: [
          expect.objectContaining({
            level: "error",
            message: "Boom",
            sourceId: "app.js",
            line: 42,
          }),
        ],
        network: [
          expect.objectContaining({
            url: "https://diagnostics.test/api",
            method: "POST",
            error: "net::ERR_FAILED",
          }),
          expect.objectContaining({
            url: "https://diagnostics.test/500",
            statusCode: 500,
            error: null,
          }),
        ],
      });
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("routes global-session network diagnostics to the owning window collection", async () => {
    const projectA = fs.mkdtempSync(path.join(os.tmpdir(), "ade-browser-network-a-"));
    const projectB = fs.mkdtempSync(path.join(os.tmpdir(), "ade-browser-network-b-"));
    try {
      const projectRootByWindow = new Map<number, string>();
      const service = createBuiltInBrowserService({
        onEvent: collector.onEvent,
        getProjectRootForWindow: (win) => projectRootByWindow.get(win.id) ?? null,
      });
      const winA = fakeBrowserWindow();
      const winB = fakeBrowserWindow();
      projectRootByWindow.set(winA.id, projectA);
      projectRootByWindow.set(winB.id, projectB);
      const browserWinA = winA as unknown as Parameters<typeof service.attachToWindow>[0];
      const browserWinB = winB as unknown as Parameters<typeof service.attachToWindow>[0];
      await service.createTab({ url: "https://a.example.test", activate: true }, browserWinA);
      await service.createTab({ url: "https://b.example.test", activate: true }, browserWinB);
      const wcA = fakes.webContentsInstances[0];
      const wcB = fakes.webContentsInstances[1];
      if (!wcA || !wcB) throw new Error("Expected two browser web contents.");

      for (const [id, wc, url] of [
        ["a-failed", wcA, "https://a.example.test/api"],
        ["b-failed", wcB, "https://b.example.test/api"],
      ] as const) {
        fakes.dispatchBeforeRequest({ id, webContentsId: wc.id, url, method: "GET", resourceType: "xhr" });
        fakes.dispatchRequestError({ id, webContentsId: wc.id, url, method: "GET", resourceType: "xhr", error: "net::ERR_FAILED" });
      }

      const observedA = await service.observe({ includeDom: false }, browserWinA);
      const observedB = await service.observe({ includeDom: false }, browserWinB);
      expect(observedA.diagnostics?.network.map((entry) => entry.url)).toEqual(["https://a.example.test/api"]);
      expect(observedB.diagnostics?.network.map((entry) => entry.url)).toEqual(["https://b.example.test/api"]);
      expect(fakes.beforeRequestHandlers).toHaveLength(1);
      expect(fakes.requestErrorHandlers).toHaveLength(1);
    } finally {
      fs.rmSync(projectA, { recursive: true, force: true });
      fs.rmSync(projectB, { recursive: true, force: true });
    }
  });

  it("waits for pending requests before resolving network-idle", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-browser-network-idle-"));
    try {
      fakes.setSendCommand(async (method) => {
        if (method === "Runtime.evaluate") {
          return { result: { value: { readyState: "complete" } } };
        }
        return {};
      });
      const projectRootByWindow = new Map<number, string>();
      const service = createBuiltInBrowserService({
        onEvent: collector.onEvent,
        getProjectRootForWindow: (win) => projectRootByWindow.get(win.id) ?? null,
      });
      const win = fakeBrowserWindow();
      projectRootByWindow.set(win.id, projectRoot);
      const browserWin = win as unknown as Parameters<typeof service.attachToWindow>[0];
      await service.createTab({ url: "https://network-idle.test", activate: true }, browserWin);
      const tabId = service.getStatus(browserWin).activeTabId ?? "";
      const wc = fakes.webContentsInstances[0];
      if (!wc) throw new Error("Expected browser web contents.");

      fakes.dispatchBeforeRequest({
        id: "pending",
        webContentsId: wc.id,
        url: "https://network-idle.test/api",
        method: "GET",
        resourceType: "xhr",
      });

      let resolved = false;
      const waitPromise = service
        .wait({ tabId, loadState: "network-idle", networkIdleMs: 0, timeoutMs: 1_000, observe: false }, browserWin)
        .then((result) => {
          resolved = true;
          return result;
        });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(resolved).toBe(false);

      fakes.dispatchRequestCompleted({
        id: "pending",
        webContentsId: wc.id,
        url: "https://network-idle.test/api",
        method: "GET",
        resourceType: "xhr",
        statusCode: 200,
      });

      await expect(waitPromise).resolves.toMatchObject({
        ok: true,
        trace: {
          action: "wait",
          status: "ok",
          target: {
            loadState: "network-idle",
            networkIdleMs: 0,
          },
        },
      });
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("dispatches browser agent input through the tab debugger without requiring visible focus", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-browser-input-"));
    try {
      const commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
      fakes.setSendCommand(async (method, params) => {
        commands.push({ method, params });
        return {};
      });
      const projectRootByWindow = new Map<number, string>();
      const service = createBuiltInBrowserService({
        onEvent: collector.onEvent,
        getProjectRootForWindow: (win) => projectRootByWindow.get(win.id) ?? null,
      });
      const win = fakeBrowserWindow();
      projectRootByWindow.set(win.id, projectRoot);
      const browserWin = win as unknown as Parameters<typeof service.attachToWindow>[0];
      await service.createTab({ url: "https://input.test", activate: true }, browserWin);
      const tabId = service.getStatus(browserWin).activeTabId ?? "";

      const clickResult = await service.click({ tabId, x: 10, y: 20, observe: false }, browserWin);
      const typeResult = await service.typeText({ tabId, text: "hello", observe: false }, browserWin);
      await service.dispatchKey({ tabId, key: "Enter", observe: false }, browserWin);
      await service.scroll({ tabId, deltaY: 480, observe: false }, browserWin);

      expect(clickResult.trace).toMatchObject({
        action: "click",
        status: "ok",
        target: { x: 10, y: 20 },
      });
      expect(typeResult.trace).toMatchObject({
        action: "typeText",
        status: "ok",
        target: { textLength: 5 },
      });
      expect(typeResult.trace?.target).not.toHaveProperty("text");
      expect(service.getTrace({ tabId }).entries.map((entry) => entry.action)).toEqual([
        "click",
        "typeText",
        "dispatchKey",
        "scroll",
      ]);
      expect(commands).toEqual(expect.arrayContaining([
        expect.objectContaining({
          method: "Input.dispatchMouseEvent",
          params: expect.objectContaining({ type: "mousePressed", x: 10, y: 20, button: "left" }),
        }),
        expect.objectContaining({
          method: "Input.insertText",
          params: { text: "hello" },
        }),
        expect.objectContaining({
          method: "Input.dispatchKeyEvent",
          params: expect.objectContaining({ type: "keyDown", key: "Enter" }),
        }),
        expect.objectContaining({
          method: "Input.dispatchMouseEvent",
          params: expect.objectContaining({ type: "mouseWheel", deltaY: 480 }),
        }),
      ]));
      expect(service.getStatus(browserWin).activeTabId).toBe(tabId);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("fills, clears, presses, and waits through a located browser element", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-browser-actionable-"));
    try {
      const commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
      fakes.setSendCommand(async (method, params) => {
        commands.push({ method, params });
        if (method === "Runtime.evaluate") {
          return {
            result: {
              value: {
                readyState: "complete",
                snapshot: {
                  url: "https://actionable.test",
                  title: "Actionable",
                  capturedAt: "2026-01-01T00:00:00.000Z",
                  viewport: { x: 0, y: 0, width: 320, height: 180 },
                  scroll: { x: 0, y: 0 },
                  elementCount: 1,
                  elements: [],
                },
                target: {
                  index: 0,
                  tagName: "input",
                  role: null,
                  label: "Email",
                  text: null,
                  value: "",
                  placeholder: "Email",
                  selector: "input[name=email]",
                  testId: null,
                  href: null,
                  disabled: false,
                  frame: { x: 20, y: 30, width: 200, height: 28 },
                  center: { x: 120, y: 44 },
                },
              },
            },
          };
        }
        return {};
      });
      const projectRootByWindow = new Map<number, string>();
      const service = createBuiltInBrowserService({
        onEvent: collector.onEvent,
        getProjectRootForWindow: (win) => projectRootByWindow.get(win.id) ?? null,
      });
      const win = fakeBrowserWindow();
      projectRootByWindow.set(win.id, projectRoot);
      const browserWin = win as unknown as Parameters<typeof service.attachToWindow>[0];
      await service.createTab({ url: "https://actionable.test", activate: true, laneId: "lane-1" }, browserWin);
      const tabId = service.getStatus(browserWin).activeTabId ?? "";

      await service.fill({ tabId, selector: "input[name=email]", text: "me@example.com", laneId: "lane-1", observe: false }, browserWin);
      await service.clear({ tabId, selector: "input[name=email]", laneId: "lane-1", observe: false }, browserWin);
      await service.dispatchKey({ tabId, selector: "input[name=email]", key: "Enter", laneId: "lane-1", observe: false }, browserWin);
      await service.wait({ tabId, selector: "input[name=email]", loadState: "load", laneId: "lane-1", observe: false }, browserWin);

      expect(commands).toEqual(expect.arrayContaining([
        expect.objectContaining({
          method: "Runtime.evaluate",
          params: expect.objectContaining({
            expression: expect.stringContaining("\"focus\":true"),
          }),
        }),
        expect.objectContaining({
          method: "Runtime.evaluate",
          params: expect.objectContaining({
            expression: expect.stringContaining("\"clear\":true"),
          }),
        }),
        expect.objectContaining({
          method: "Input.insertText",
          params: { text: "me@example.com" },
        }),
        expect.objectContaining({
          method: "Input.dispatchKeyEvent",
          params: expect.objectContaining({ type: "keyDown", key: "Enter" }),
        }),
      ]));
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it("filters other agents' tab metadata from status and action results", async () => {
    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });
    const first = await service.createTab({
      url: "http://localhost:4101/private-one",
      activate: true,
      laneId: "lane-1",
      chatSessionId: "chat-1",
    });
    const firstTabId = first.activeTabId ?? "";
    const second = await service.createTab({
      url: "http://localhost:4102/private-two",
      activate: true,
      laneId: "lane-2",
      chatSessionId: "chat-2",
    });
    const secondTabId = second.activeTabId ?? "";

    const scoped = service.getStatus({
      tabId: firstTabId,
      laneId: "lane-1",
      chatSessionId: "chat-1",
    });
    expect(scoped.activeTabId).toBeNull();
    expect(scoped.url).toBeNull();
    expect(scoped.tabs).toEqual([
      expect.objectContaining({
        id: firstTabId,
        url: "http://localhost:4101/private-one",
        ownerChatSessionId: "chat-1",
      }),
    ]);
    expect(JSON.stringify(scoped)).not.toContain(secondTabId);
    expect(JSON.stringify(scoped)).not.toContain("private-two");
    expect(JSON.stringify(scoped)).not.toContain("chat-2");

    const implicitScoped = service.getStatus({
      laneId: "lane-1",
      chatSessionId: "chat-1",
    });
    expect(implicitScoped.tabs.map((tab) => tab.id)).toEqual([firstTabId]);
    expect(implicitScoped.activeTabId).toBeNull();

    const actionStatus = await service.reload({
      tabId: firstTabId,
      laneId: "lane-1",
      chatSessionId: "chat-1",
    });
    expect(actionStatus.tabs).toHaveLength(1);
    expect(JSON.stringify(actionStatus)).not.toContain("private-two");
  });

  it("blocks another lane from driving a leased tab unless forced", async () => {
    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });
    await service.createTab({ url: "https://lease.test", activate: true, laneId: "lane-1" });
    const tabId = service.getStatus().activeTabId ?? "";
    expect(service.getStatus().ownerLeaseExpiresAt).toEqual(expect.any(String));

    expect(() => service.startSession({ tabId, laneId: "lane-2" })).toThrow(/leased by lane lane-1/);

    await expect(
      service.click({ tabId, x: 10, y: 20, laneId: "lane-2", observe: false }),
    ).rejects.toThrow(/leased by lane lane-1/);
    expect(service.getTrace({ tabId }).entries.at(-1)).toMatchObject({
      action: "click",
      status: "error",
      error: expect.stringContaining("leased by lane lane-1"),
    });

    await expect(
      service.click({ tabId, x: 10, y: 20, laneId: "lane-2", force: true, observe: false }),
    ).resolves.toMatchObject({ ok: true });
    expect(service.getStatus().ownerLaneId).toBe("lane-2");
  });

  it("blocks another chat in the same lane from driving a leased tab unless forced", async () => {
    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });
    await service.createTab({
      url: "https://chat-lease.test",
      activate: true,
      laneId: "lane-1",
      chatSessionId: "chat-1",
    });
    const tabId = service.getStatus().activeTabId ?? "";

    expect(() => service.startSession({ tabId, laneId: "lane-1", chatSessionId: "chat-2" }))
      .toThrow(/leased by chat chat-1 in lane lane-1/);

    await expect(
      service.click({ tabId, x: 10, y: 20, laneId: "lane-1", chatSessionId: "chat-2", observe: false }),
    ).rejects.toThrow(/leased by chat chat-1 in lane lane-1/);
    expect(service.getTrace({ tabId }).entries.at(-1)).toMatchObject({
      action: "click",
      status: "error",
      error: expect.stringContaining("leased by chat chat-1 in lane lane-1"),
    });

    await expect(
      service.click({ tabId, x: 10, y: 20, laneId: "lane-1", chatSessionId: "chat-2", force: true, observe: false }),
    ).resolves.toMatchObject({ ok: true });
    expect(service.getStatus()).toMatchObject({
      ownerLaneId: "lane-1",
      ownerChatSessionId: "chat-2",
    });
  });

  it("enforces tab leases for browser reads, screenshots, traces, and navigation controls", async () => {
    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });
    await service.createTab({
      url: "https://sensitive-session.test",
      activate: true,
      laneId: "lane-1",
      chatSessionId: "chat-1",
    });
    const tabId = service.getStatus().activeTabId ?? "";
    const otherOwner = { tabId, laneId: "lane-1", chatSessionId: "chat-2" };
    const ownedSession = service.startSession({ tabId, laneId: "lane-1", chatSessionId: "chat-1" }).session;

    expect(() => service.getStatus(otherOwner)).toThrow(/leased by chat chat-1/);
    await expect(service.captureScreenshot(otherOwner)).rejects.toThrow(/leased by chat chat-1/);
    await expect(service.observe({ ...otherOwner, includeDom: false })).rejects.toThrow(/leased by chat chat-1/);
    expect(() => service.getTrace(otherOwner)).toThrow(/leased by chat chat-1/);
    await expect(service.reload(otherOwner)).rejects.toThrow(/leased by chat chat-1/);
    await expect(service.selectPoint({ ...otherOwner, x: 10, y: 20 })).rejects.toThrow(/leased by chat chat-1/);
    expect(service.listSessions({ laneId: "lane-1", chatSessionId: "chat-2" }).sessions).toEqual([]);
    expect(() => service.endSession({
      sessionId: ownedSession.id,
      laneId: "lane-1",
      chatSessionId: "chat-2",
    })).toThrow(/leased by chat chat-1/);

    await expect(service.captureScreenshot({ ...otherOwner, force: true })).resolves.toMatchObject({
      width: 320,
      height: 180,
    });
    expect(service.getStatus()).toMatchObject({
      ownerLaneId: "lane-1",
      ownerChatSessionId: "chat-2",
    });
  });

  it("authorizes selected browser context against the tab that created it", async () => {
    fakes.setSendCommand(async (method) => {
      switch (method) {
        case "DOM.getNodeForLocation":
          return { backendNodeId: 42 };
        case "DOM.resolveNode":
          return { object: { objectId: "selection-owner" } };
        case "Runtime.callFunctionOn":
          return {
            result: {
              value: {
                tagName: "button",
                selector: "button#private",
                testId: null,
                frame: { x: 0, y: 0, width: 10, height: 10 },
                pixelRatio: 1,
                url: "http://localhost/private",
                title: "private",
                metadata: { viewport: { width: 100, height: 100 } },
              },
            },
          };
        default:
          return {};
      }
    });

    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });
    await service.createTab({
      url: "http://localhost/first",
      activate: true,
      laneId: "lane-1",
      chatSessionId: "chat-1",
    });
    const selectionTabId = service.getStatus().activeTabId ?? "";
    await service.createTab({
      url: "http://localhost/second",
      activate: true,
      laneId: "lane-1",
      chatSessionId: "chat-2",
    });
    const activeTabId = service.getStatus().activeTabId ?? "";
    await service.selectPoint({
      tabId: selectionTabId,
      x: 10,
      y: 20,
      includeScreenshot: false,
      laneId: "lane-1",
      chatSessionId: "chat-1",
    });

    await expect(service.selectCurrent({
      tabId: activeTabId,
      laneId: "lane-1",
      chatSessionId: "chat-2",
    })).rejects.toThrow(/leased by chat chat-1/);
    await expect(service.clearSelection({
      tabId: activeTabId,
      laneId: "lane-1",
      chatSessionId: "chat-2",
    })).rejects.toThrow(/leased by chat chat-1/);
    expect(service.getStatus().hasSelection).toBe(true);

    await expect(service.selectCurrent({
      tabId: selectionTabId,
      laneId: "lane-1",
      chatSessionId: "chat-1",
    })).resolves.toMatchObject({ item: { componentId: "button#private" } });
    await service.clearSelection({
      tabId: selectionTabId,
      laneId: "lane-1",
      chatSessionId: "chat-1",
    });
    expect(service.getStatus().hasSelection).toBe(false);
  });

  it("rejects leased tab switching before mutating the active tab", async () => {
    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });
    await service.createTab({ url: "https://first-lease.test", activate: true, laneId: "lane-1" });
    const firstTabId = service.getStatus().activeTabId ?? "";
    await service.createTab({ url: "https://second-lease.test", activate: true, laneId: "lane-2" });
    const activeBefore = service.getStatus().activeTabId;

    await expect(
      service.switchTab({ tabId: firstTabId, laneId: "lane-2" }),
    ).rejects.toThrow(/leased by lane lane-1/);

    expect(service.getStatus().activeTabId).toBe(activeBefore);
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

  it("showPanel without a target does not claim another lane's active tab", async () => {
    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });
    await service.createTab({
      url: "https://owned-tab.test",
      activate: true,
      laneId: "lane-1",
      chatSessionId: "chat-1",
    });

    await service.showPanel({ laneId: "lane-2", chatSessionId: "chat-2" });

    const activeTab = service.getStatus().tabs.find((tab) => tab.id === service.getStatus().activeTabId);
    expect(activeTab).toMatchObject({
      ownerLaneId: "lane-1",
      ownerChatSessionId: "chat-1",
    });
    const openEvent = collector.events.findLast((event) => event.type === "open-request");
    expect(openEvent).toMatchObject({
      type: "open-request",
      tabId: service.getStatus().activeTabId,
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
    fakes.clearSessionEventHandlers();
    fakes.clearPermissionHandlers();
    fakes.openExternal.mockClear();
    fakes.appGetPath.mockClear();
    fakes.appGetPath.mockImplementation((name: string) => name === "downloads" ? "/Users/test/Downloads" : "/tmp");
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

  it("starts inspect with the ADE outline overlay instead of Chromium's DevTools inspect UI", async () => {
    const commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
    fakes.setSendCommand(async (method, params) => {
      commands.push({ method, params });
      return {};
    });

    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });
    await service.navigate({ url: "https://example.test", newTab: true });

    await service.startInspect();

    expect(service.getStatus().isInspecting).toBe(true);
    expect(commands.some((command) => command.method === "Overlay.setInspectMode")).toBe(false);
    expect(commands.some((command) => command.method === "Overlay.enable")).toBe(false);
    expect(commands).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: "Runtime.addBinding",
        params: { name: "__adeBuiltInBrowserInspectSelect" },
      }),
      expect.objectContaining({
        method: "Runtime.evaluate",
        params: expect.objectContaining({
          expression: expect.stringContaining("data-ade-browser-inspector"),
        }),
      }),
    ]));
  });

  it("selects inspect clicks from the ADE overlay binding", async () => {
    const commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
    fakes.setSendCommand(async (method, params) => {
      commands.push({ method, params });
      switch (method) {
        case "DOM.getNodeForLocation":
          return { backendNodeId: 42 };
        case "DOM.resolveNode":
          return { object: { objectId: "parent-object" } };
        case "Runtime.callFunctionOn":
          return {
            result: {
              value: {
                tagName: "button",
                selector: "section.card > button:nth-of-type(1)",
                testId: null,
                frame: { x: 40, y: 50, width: 90, height: 28 },
                pixelRatio: 1,
                url: "http://example.test/",
                title: "test",
                metadata: {
                  viewport: { width: 400, height: 300 },
                  hitTest: {
                    x: 84,
                    y: 61,
                    strategy: "smallest-visible-descendant",
                    originalTagName: "section",
                    selectedTagName: "button",
                  },
                },
              },
            },
          };
        default:
          return {};
      }
    });

    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });
    await service.navigate({ url: "https://example.test", newTab: true });
    await service.startInspect();

    const wc = fakes.webContentsInstances[0];
    if (!wc) throw new Error("missing web contents");
    wc.debugger.emit("message", {}, "Runtime.bindingCalled", {
      name: "__adeBuiltInBrowserInspectSelect",
      payload: JSON.stringify({ type: "select", x: 84, y: 61 }),
    }, "");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(service.getStatus()).toMatchObject({
      hasSelection: true,
      isInspecting: false,
    });
    expect(commands).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: "DOM.getNodeForLocation",
        params: expect.objectContaining({ x: 84, y: 61 }),
      }),
      expect.objectContaining({
        method: "Runtime.callFunctionOn",
        params: expect.objectContaining({
          arguments: [{ value: { x: 84, y: 61 } }],
        }),
      }),
      expect.objectContaining({
        method: "Runtime.evaluate",
        params: expect.objectContaining({
          expression: expect.stringContaining("__adeBuiltInBrowserInspector"),
        }),
      }),
    ]));
  });

  it("passes inspect coordinates into page metadata resolution so smaller descendants can win", async () => {
    const metadataCalls: Record<string, unknown>[] = [];
    fakes.setSendCommand(async (method, params) => {
      switch (method) {
        case "DOM.getNodeForLocation":
          return { backendNodeId: 42 };
        case "DOM.resolveNode":
          return { object: { objectId: "parent-object" } };
        case "Runtime.callFunctionOn":
          metadataCalls.push(params ?? {});
          return {
            result: {
              value: {
                tagName: "button",
                selector: "section.card > button:nth-of-type(1)",
                testId: null,
                frame: { x: 40, y: 50, width: 90, height: 28 },
                pixelRatio: 1,
                url: "http://example.test/",
                title: "test",
                metadata: {
                  viewport: { width: 400, height: 300 },
                  hitTest: {
                    x: 84,
                    y: 61,
                    strategy: "smallest-visible-descendant",
                    originalTagName: "section",
                    selectedTagName: "button",
                  },
                },
              },
            },
          };
        default:
          return {};
      }
    });

    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });
    await service.navigate({ url: "https://example.test", newTab: true });

    const result = await service.selectPoint({ x: 84, y: 61, includeScreenshot: false });

    expect(metadataCalls[0]).toMatchObject({
      objectId: "parent-object",
      arguments: [{ value: { x: 84, y: 61 } }],
    });
    expect(result.item?.componentId).toBe("section.card > button:nth-of-type(1)");
    expect(result.item?.metadata.hitTest).toMatchObject({
      strategy: "smallest-visible-descendant",
      originalTagName: "section",
      selectedTagName: "button",
    });
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
