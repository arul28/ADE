import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BuiltInBrowserEventPayload } from "../../../shared/types";
import {
  BUILT_IN_BROWSER_PARKED_PREVIEW_MARGIN,
  BUILT_IN_BROWSER_PARKED_PREVIEW_MIN_HEIGHT,
  BUILT_IN_BROWSER_PARKED_PREVIEW_MIN_WIDTH,
  BUILT_IN_BROWSER_PREVIEW_WARM_MS,
} from "../../../shared/types";
import {
  BuiltInBrowserNoTabError,
  createBuiltInBrowserService,
  isBuiltInBrowserCaptureUnavailableError,
  isBuiltInBrowserNoTabError,
} from "./builtInBrowserService";
import { createDevServerRegistry } from "../devServers/devServerRegistry";

const fakes = vi.hoisted(() => {
  type DebuggerHandler = (...args: unknown[]) => void;
  type WindowOpenHandlerResponse = {
    action: "allow" | "deny";
    createWindow?: (options: Record<string, unknown>) => FakeWebContents;
  };
  type WindowOpenDetails = {
    url: string;
    disposition?: "background-tab" | "foreground-tab" | "new-window";
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
    capturePageCalls: { stayHidden: boolean | undefined }[] = [];
    /** Set by the tests that model a view with no compositor surface at all. */
    captureAlwaysEmpty = false;
    capturePage = async (
      _rect?: unknown,
      opts?: { stayHidden?: boolean },
    ): Promise<{
      isEmpty: () => boolean;
      toDataURL: () => string;
      getSize: () => { width: number; height: number };
      resize: (options: { width: number }) => unknown;
      toJPEG: (quality: number) => Buffer;
    }> => {
      this.capturePageCalls.push({ stayHidden: opts?.stayHidden });
      // Models the rule the corner card was broken by: Chromium can only hand
      // back a frame for a view that HAS a compositor surface, and `stayHidden`
      // is a promise not to create one. A tab the panel has never shown — the
      // exact tab the card exists to picture — therefore answers an empty image
      // to every `stayHidden` capture, forever, without ever erroring.
      const empty = this.captureAlwaysEmpty || opts?.stayHidden === true;
      const image = {
        isEmpty: () => empty,
        toDataURL: () => "data:image/png;base64,dGVzdA==",
        getSize: () => ({ width: 320, height: 180 }),
        resize: (): unknown => image,
        toJPEG: (): Buffer => Buffer.from("jpeg-bytes"),
      };
      return image;
    };
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
    webContents: FakeWebContents;
    webPreferences: unknown;
    backgroundColor: string | null = null;
    constructor(options?: { webPreferences?: unknown; webContents?: FakeWebContents }) {
      this.webContents = options?.webContents ?? new FakeWebContents();
      this.webPreferences = options?.webPreferences;
    }
    setBackgroundColor = (color: string): void => {
      this.backgroundColor = color;
    };
    boundsCalls: { x: number; y: number; width: number; height: number }[] = [];
    visibleCalls: boolean[] = [];
    setBounds = (rect: { x: number; y: number; width: number; height: number }): void => {
      this.boundsCalls.push({ ...rect });
    };
    setVisible = (visible: boolean): void => {
      this.visibleCalls.push(visible);
    };
    borderRadiusCalls: number[] = [];
    setBorderRadius = (radius: number): void => {
      this.borderRadiusCalls.push(radius);
    };
  }

  // Track the most recently constructed FakeDebugger so tests can wire sendCommand impls.
  /**
   * A `screen` that a test can reshape and fire events from — the two things
   * the parked-preview geometry depends on and neither of which a static stub
   * can express.
   */
  const screenListeners: { event: string; handler: (...args: unknown[]) => void }[] = [];
  let displays: { bounds: { x: number; y: number; width: number; height: number } }[] = [
    { bounds: { x: 0, y: 0, width: 1280, height: 720 } },
  ];
  const fakeScreen = {
    getCursorScreenPoint: vi.fn(() => ({ x: 0, y: 0 })),
    getAllDisplays: () => displays,
    setDisplays: (next: { bounds: { x: number; y: number; width: number; height: number } }[]): void => {
      displays = next;
    },
    on: (event: string, handler: (...args: unknown[]) => void): void => {
      screenListeners.push({ event, handler });
    },
    removeListener: (event: string, handler: (...args: unknown[]) => void): void => {
      const index = screenListeners.findIndex((entry) => entry.event === event && entry.handler === handler);
      if (index >= 0) screenListeners.splice(index, 1);
    },
    emit: (event: string): void => {
      for (const entry of [...screenListeners]) {
        if (entry.event === event) entry.handler();
      }
    },
    listenerCount: (event: string): number => screenListeners.filter((entry) => entry.event === event).length,
    clearListeners: (): void => {
      screenListeners.length = 0;
    },
  };

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
    constructor(options?: { webPreferences?: unknown; webContents?: FakeWebContents }) {
      super(options);
      if (!options?.webContents) {
        this.webContents = new TrackedFakeWebContents();
        const partition = (options?.webPreferences as { partition?: string } | undefined)?.partition ?? "persist:ade-browser";
        this.webContents.session = sessionForPartition(partition);
      }
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
    fakeScreen,
    WebContentsView: TrackedFakeWebContentsView,
    WebContents: TrackedFakeWebContents,
    debuggerInstances,
    webContentsInstances,
    webContentsViewInstances,
    partitionCalls,
    openExternal: vi.fn(async (_url: string) => undefined),
    screen: fakeScreen,
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
  // Real listener bookkeeping, not `vi.fn()`: the service now registers window
  // geometry watchers whose whole job is to fire, and a spy cannot be fired.
  const listeners: { event: string; handler: (...args: unknown[]) => void }[] = [];
  const hostListeners: { event: string; handler: (...args: unknown[]) => void }[] = [];
  const webContents = {
    isDestroyed: () => false,
    focusCalls: 0,
    focus() {
      webContents.focusCalls += 1;
    },
    on: (event: string, handler: (...args: unknown[]) => void) => {
      hostListeners.push({ event, handler });
    },
    once: (event: string, handler: (...args: unknown[]) => void) => {
      hostListeners.push({ event, handler });
    },
    removeListener: (event: string, handler: (...args: unknown[]) => void) => {
      const index = hostListeners.findIndex((entry) => entry.event === event && entry.handler === handler);
      if (index >= 0) hostListeners.splice(index, 1);
    },
    emit: (event: string) => {
      for (const entry of [...hostListeners]) {
        if (entry.event === event) entry.handler();
      }
    },
    listenerCount: (event: string) => hostListeners.filter((entry) => entry.event === event).length,
  };
  let contentBounds = { x: 0, y: 0, width: 1280, height: 720 };
  let focused = true;
  let visibleOnScreen = false;
  return {
    id: fakeWindowId++,
    isDestroyed: () => false,
    // The preview loop pauses on a window nobody can see, which is what keeps
    // a stream a test forgot to stop from capturing against these stubs. The
    // preview tests opt in explicitly with `setVisibleOnScreen(true)`.
    isVisible: () => visibleOnScreen,
    setVisibleOnScreen: (next: boolean): void => {
      visibleOnScreen = next;
    },
    isMinimized: () => false,
    // Focused by default: handing the keyboard back is guarded on it, and the
    // sequences these tests drive are all ones the user just clicked through.
    isFocused: () => focused,
    setFocused: (next: boolean): void => {
      focused = next;
    },
    getContentBounds: () => contentBounds,
    setContentBounds: (next: { x: number; y: number; width: number; height: number }) => {
      contentBounds = next;
    },
    webContents,
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
    on: (event: string, handler: (...args: unknown[]) => void) => {
      listeners.push({ event, handler });
    },
    once: (event: string, handler: (...args: unknown[]) => void) => {
      listeners.push({ event, handler });
    },
    removeListener: (event: string, handler: (...args: unknown[]) => void) => {
      const index = listeners.findIndex((entry) => entry.event === event && entry.handler === handler);
      if (index >= 0) listeners.splice(index, 1);
    },
    emit: (event: string) => {
      for (const entry of [...listeners]) {
        if (entry.event === event) entry.handler();
      }
    },
    listenerCount: (event: string) => listeners.filter((entry) => entry.event === event).length,
  };
}

/** The `BrowserWindow` shape the service's public methods take. */
type ServiceBrowserWindow = Parameters<
  ReturnType<typeof createBuiltInBrowserService>["attachToWindow"]
>[0];

/**
 * A service wired for project-scoped routing, plus the two registries it reads.
 *
 * Six tests built this by hand, each repeating the same `as unknown as
 * Parameters<…>[0]` double cast — the kind of cast that quietly stops matching
 * the signature it names. One place to fix when the signature moves.
 */
function projectScopedService(onEvent?: Parameters<typeof createBuiltInBrowserService>[0]["onEvent"]) {
  const projectRootByWindow = new Map<number, string>();
  const windowsByProjectRoot = new Map<string, ReturnType<typeof fakeBrowserWindow>>();
  const service = createBuiltInBrowserService({
    onEvent,
    getProjectRootForWindow: (win) => projectRootByWindow.get(win.id) ?? null,
    getWindowForProjectRoot: (projectRoot) =>
      (windowsByProjectRoot.get(projectRoot) as unknown as ServiceBrowserWindow | undefined) ?? null,
  });
  /** Mints a window, registers it in both directions, and returns both shapes. */
  const openWindow = (projectRoot?: string | null) => {
    const win = fakeBrowserWindow();
    if (projectRoot) {
      projectRootByWindow.set(win.id, projectRoot);
      windowsByProjectRoot.set(projectRoot, win);
    }
    return { win, browserWin: win as unknown as ServiceBrowserWindow };
  };
  /** The window's own project changed (the human switched project tabs). */
  const setWindowProject = (
    win: ReturnType<typeof fakeBrowserWindow>,
    projectRoot: string,
  ): void => {
    projectRootByWindow.set(win.id, projectRoot);
  };
  /** A project the window merely has OPEN, without being its current one. */
  const serveProjectFromWindow = (
    projectRoot: string,
    win: ReturnType<typeof fakeBrowserWindow>,
  ): void => {
    windowsByProjectRoot.set(projectRoot, win);
  };
  return { service, projectRootByWindow, openWindow, setWindowProject, serveProjectFromWindow };
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
    fakes.fakeScreen.setDisplays([{ bounds: { x: 0, y: 0, width: 1280, height: 720 } }]);
    // `screen` is a process singleton, so a service from an earlier test that
    // was never detached leaves its watchers behind.
    fakes.fakeScreen.clearListeners();
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

  it("parks a previewed tab's view instead of detaching it when the panel hides", async () => {
    // The corner card's whole premise. A WebContentsView that has been removed
    // from the window has no compositor surface, so `capturePage()` comes back
    // empty and the preview stream emits nothing at all — the card sat on its
    // blank placeholder while cheerfully reporting "Live". A watched tab
    // therefore stays attached, parked outside the window's content rect.
    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });
    const win = fakeBrowserWindow();
    service.attachToWindow(win as unknown as Parameters<typeof service.attachToWindow>[0]);

    await service.createTab({ url: "https://example.test", activate: true });
    await service.setBounds({ x: 12, y: 24, width: 640, height: 360, visible: true });
    expect(win.contentView.children).toHaveLength(1);
    const tabId = service.getStatus().activeTabId;
    expect(tabId).toBeTruthy();

    service.startPreviewStream({ tabId });
    await service.setBounds({ x: 12, y: 24, width: 640, height: 360, visible: false });
    expect(win.contentView.children).toHaveLength(1);

    // Last watcher out: the view goes back to being detached, so a hidden panel
    // nobody is previewing costs nothing.
    service.stopPreviewStream({ tabId });
    expect(win.contentView.children).toHaveLength(0);
  });

  it("warms a never-attended view against the window before parking it off screen", async () => {
    /*
      The mechanism behind the black card, pinned as geometry.

      Parking preserves a compositor surface; it cannot create one. Measured
      live over CDP: a tab the panel had shown captured 469x739 frames while
      parked, and a tab created in the background captured `empty=true,
      size=0x0` forever — same code path, same park point, same watcher. One
      pixel of overlap with the window's content rect is what makes Chromium
      allocate the surface, so the view is placed there for two frames and only
      then moved past every display.
    */
    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });
    const win = fakeBrowserWindow();
    // On screen: the overlap only produces a surface if there is a window
    // being composited to overlap with.
    win.setVisibleOnScreen(true);
    win.setContentBounds({ x: 0, y: 0, width: 1280, height: 720 });
    fakes.fakeScreen.setDisplays([{ bounds: { x: 0, y: 0, width: 1280, height: 720 } }]);
    service.attachToWindow(win as unknown as ServiceBrowserWindow);

    // Never shown in the panel: no `setBounds(visible: true)` anywhere.
    await service.createTab({ url: "https://example.test", activate: true });
    const view = fakes.webContentsViewInstances.at(-1)!;
    const tabId = service.getStatus().activeTabId!;

    vi.useFakeTimers();
    try {
      service.startPreviewStream({ tabId });
      const warming = view.boundsCalls.at(-1)!;
      // Exactly one pixel inside, at the far corner — the least of the window
      // it is possible to cover while still being on it.
      expect(warming).toMatchObject({ x: 1279, y: 719 });
      // Full size while warming, so the page lays out once at the size it will
      // be captured at rather than resizing again on the way out.
      expect(warming.width).toBe(BUILT_IN_BROWSER_PARKED_PREVIEW_MIN_WIDTH);
      expect(warming.height).toBe(BUILT_IN_BROWSER_PARKED_PREVIEW_MIN_HEIGHT);

      vi.advanceTimersByTime(BUILT_IN_BROWSER_PREVIEW_WARM_MS + 5);
    } finally {
      vi.useRealTimers();
    }

    // …and then off every display, where nothing can reach it.
    const parked = view.boundsCalls.at(-1)!;
    expect(parked.x).toBe(1280 + BUILT_IN_BROWSER_PARKED_PREVIEW_MARGIN);
    expect(parked.y).toBe(720 + BUILT_IN_BROWSER_PARKED_PREVIEW_MARGIN);

    service.stopPreviewStream({ tabId });
    service.dispose();
  });

  it("clips the warming pixel and never holds it longer than the warm bound", async () => {
    // The overlap is a live web page composited over the ADE UI. Electron 41
    // exposes no hit-test opt-out for a `View` — `setBorderRadius` is a layer
    // mask — so the two things that keep it harmless are that the pixel is not
    // painted and that it does not last. Both are pinned here.
    expect(BUILT_IN_BROWSER_PREVIEW_WARM_MS).toBeLessThanOrEqual(120);

    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });
    const win = fakeBrowserWindow();
    win.setVisibleOnScreen(true);
    win.setContentBounds({ x: 0, y: 0, width: 1280, height: 720 });
    fakes.fakeScreen.setDisplays([{ bounds: { x: 0, y: 0, width: 1280, height: 720 } }]);
    service.attachToWindow(win as unknown as ServiceBrowserWindow);
    await service.createTab({ url: "https://example.test", activate: true });
    const view = fakes.webContentsViewInstances.at(-1)!;
    const tabId = service.getStatus().activeTabId!;

    vi.useFakeTimers();
    try {
      service.startPreviewStream({ tabId });
      // Rounded while the corner pixel is on the UI, so it is outside the
      // view's painted shape even on a window the OS does not round itself.
      expect(view.borderRadiusCalls.at(-1)).toBeGreaterThan(0);

      vi.advanceTimersByTime(BUILT_IN_BROWSER_PREVIEW_WARM_MS + 5);
      // Square again once parked: a preview frame with four transparent
      // notches in it is not what the corner card is asking for.
      expect(view.borderRadiusCalls.at(-1)).toBe(0);
    } finally {
      vi.useRealTimers();
    }

    service.stopPreviewStream({ tabId });
    service.dispose();
  });

  it("does not warm — or claim a surface — while the window is off screen", async () => {
    // A minimised or hidden window has no surface to lend. Marking the tab
    // surfaced on that evidence is how the black card comes back: nothing
    // re-warms it until the view next leaves the window. And warming against it
    // anyway would re-arm the 120 ms timer forever, because the warm can never
    // complete.
    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });
    const win = fakeBrowserWindow();
    win.setContentBounds({ x: 0, y: 0, width: 1280, height: 720 });
    fakes.fakeScreen.setDisplays([{ bounds: { x: 0, y: 0, width: 1280, height: 720 } }]);
    service.attachToWindow(win as unknown as ServiceBrowserWindow);
    await service.createTab({ url: "https://example.test", activate: true });
    const view = fakes.webContentsViewInstances.at(-1)!;
    const tabId = service.getStatus().activeTabId!;

    vi.useFakeTimers();
    try {
      service.startPreviewStream({ tabId });
      // Parked directly, never on the window's corner.
      expect(view.boundsCalls.at(-1)).toMatchObject({
        x: 1280 + BUILT_IN_BROWSER_PARKED_PREVIEW_MARGIN,
        y: 720 + BUILT_IN_BROWSER_PARKED_PREVIEW_MARGIN,
      });
      const parkedCalls = view.boundsCalls.length;
      vi.advanceTimersByTime(BUILT_IN_BROWSER_PREVIEW_WARM_MS * 5);
      // No armed timer means no re-park storm behind a hidden window.
      expect(view.boundsCalls.length).toBe(parkedCalls);

      // The window comes back: now the warm happens, because now it can.
      win.setVisibleOnScreen(true);
      await service.setBounds({ x: 12, y: 24, width: 640, height: 360, visible: false });
      expect(view.boundsCalls.at(-1)).toMatchObject({ x: 1279, y: 719 });
    } finally {
      vi.useRealTimers();
    }

    service.stopPreviewStream({ tabId });
    service.dispose();
  });

  it("drops the warming timer and surfaced entry when the tab is closed mid-warm", async () => {
    // `closeTab` removes the view itself instead of going through
    // `removeTabViewFromWindow`, so it has to drop the same warming state. An
    // armed timer fires after the tab is gone, re-adds a dead id to the
    // surfaced set and runs a pointless attach pass over every tab.
    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });
    const win = fakeBrowserWindow();
    win.setVisibleOnScreen(true);
    win.setContentBounds({ x: 0, y: 0, width: 1280, height: 720 });
    fakes.fakeScreen.setDisplays([{ bounds: { x: 0, y: 0, width: 1280, height: 720 } }]);
    service.attachToWindow(win as unknown as ServiceBrowserWindow);
    await service.createTab({ url: "https://example.test", activate: true });
    const view = fakes.webContentsViewInstances.at(-1)!;
    const tabId = service.getStatus().activeTabId!;

    vi.useFakeTimers();
    try {
      service.startPreviewStream({ tabId });
      expect(view.boundsCalls.at(-1)).toMatchObject({ x: 1279, y: 719 });

      await service.closeTab({ tabId });
      const afterClose = view.boundsCalls.length;
      vi.advanceTimersByTime(BUILT_IN_BROWSER_PREVIEW_WARM_MS * 3);
      // The timer that was armed for this tab is gone with it.
      expect(view.boundsCalls.length).toBe(afterClose);
    } finally {
      vi.useRealTimers();
    }

    service.dispose();
  });

  it("does not warm a view the panel has already shown", async () => {
    // A view that has been on screen already has the surface, and warming it
    // again would flash a pixel of the page for no reason on every tool switch.
    fakes.fakeScreen.setDisplays([{ bounds: { x: 0, y: 0, width: 1280, height: 720 } }]);
    const { service, view, tabId } = await parkedTabFixture(collector, { width: 640, height: 360 });
    const parked = view.boundsCalls.at(-1)!;
    expect(parked).toMatchObject({
      x: 1280 + BUILT_IN_BROWSER_PARKED_PREVIEW_MARGIN,
      y: 720 + BUILT_IN_BROWSER_PARKED_PREVIEW_MARGIN,
      width: 640,
      height: 360,
    });

    service.stopPreviewStream({ tabId });
  });

  it("tags a capture that has no surface to photograph instead of throwing a bare error", async () => {
    /*
      The other half of the same P0. Switching Browser -> Terminal printed
      `Error occurred in handler for 'ade.builtInBrowser.captureScreenshot':
      Page.enable timed out after 3000ms` three times, because the panel's
      underlay capture races the hide it belongs to: by the time it lands the
      view has no surface, `capturePage` answers an empty image, and the CDP
      fallback's `Page.enable` never returns against a surfaceless target.

      Nothing was actually wrong — the panel has a last frame to fall back on —
      so the failure is TAGGED here and softened to `{ ok: false }` at the
      trusted-renderer IPC boundary. Agents do not come through that boundary
      and still see a real failure.
    */
    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });
    const win = fakeBrowserWindow();
    service.attachToWindow(win as unknown as ServiceBrowserWindow);
    await service.createTab({ url: "https://example.test", activate: true });
    const wc = fakes.webContentsInstances.at(-1)!;
    wc.captureAlwaysEmpty = true;
    fakes.setSendCommand(async (method) => {
      if (method === "Page.enable") throw new Error("Page.enable timed out after 3000ms");
      return {};
    });

    const error = await service.captureScreenshot({}).then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(isBuiltInBrowserCaptureUnavailableError(error)).toBe(true);
    expect((error as Error).message).toContain("Page.enable timed out");
    // Not the no-tab shape: there IS a tab, and conflating the two would have
    // the renderer report "the browser closed" for a pane that is wide open.
    expect(isBuiltInBrowserNoTabError(error)).toBe(false);

    fakes.resetSendCommand();
    service.dispose();
  });

  it("paints preview frames in the order the corner card actually drives: hide, subscribe, frames", async () => {
    /*
      The P0 the round-4 review caught: the card was a 320x200 black rectangle
      with a live dot on it, every time.

      The ordering is the whole bug. The card only exists for the tool you are
      NOT looking at, so the tools pane hides the browser FIRST and the card
      subscribes AFTER — by which point the view has no compositor surface, and
      `capturePage({ stayHidden: true })` answers an empty image rather than an
      error. The loop ticked, `isEmpty()` swallowed every frame as "nothing to
      show right now", and nothing anywhere said a word.

      Parking preserves a surface Chromium already has; it does not create one.
      Raising the capturer count — which is what omitting `stayHidden` does — is
      what makes a parked or never-attended view answer at all.
    */
    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });
    const win = fakeBrowserWindow();
    win.setVisibleOnScreen(true);
    service.attachToWindow(win as unknown as ServiceBrowserWindow);

    await service.createTab({ url: "https://example.test", activate: true });
    const tabId = service.getStatus().activeTabId!;
    const wc = fakes.webContentsInstances.at(-1)!;

    // 1. The pane switches away from Browser. Nothing is watching yet, so the
    //    view is not even parked.
    await service.setBounds({ x: 12, y: 24, width: 0, height: 0, visible: false });
    expect(win.contentView.children).toHaveLength(0);

    // 2. The card mounts and subscribes, which is what parks the view.
    vi.useFakeTimers();
    try {
      service.startPreviewStream({ tabId, fps: 10 });
      expect(win.contentView.children).toHaveLength(1);
      // 3. Frames — the assertion that was false before this fix.
      await vi.advanceTimersByTimeAsync(450);
    } finally {
      vi.useRealTimers();
    }

    const frames = collector.events.filter((event) => event.type === "preview-frame");
    expect(frames.length).toBeGreaterThan(0);
    expect(frames[0]).toMatchObject({ tabId, width: 320, height: 180 });
    expect(frames[0]).toHaveProperty("dataUrl", expect.stringContaining("data:image/jpeg;base64,"));
    // The mechanism, pinned separately from the outcome, in both directions.
    //
    // Before the view has a surface, the capture must NOT ask to stay hidden —
    // forcing visibility is the only thing that makes a surfaceless view answer,
    // and a refactor that reintroduces the flag there brings the black card back
    // with it. After the warm the parked view is attached and visible, so the
    // page is already steadily visible for the whole watch: asking to stay
    // hidden changes nothing except that it stops toggling `visibilityState`
    // up to 24 times a second under the page.
    expect(wc.capturePageCalls.length).toBeGreaterThan(0);
    expect(wc.capturePageCalls.some((call) => call.stayHidden !== true)).toBe(true);
    expect(wc.capturePageCalls.at(-1)?.stayHidden).toBe(true);

    service.stopPreviewStream({ tabId });
    service.dispose();
  });

  /**
   * A helper for the parking tests: a service with one tab that has been shown
   * in the panel at `panel`, then hidden with a live preview watcher.
   */
  const parkedTabFixture = async (
    collectorArg: ReturnType<typeof captureStatusEvents>,
    panel: { width: number; height: number } | null,
  ) => {
    const service = createBuiltInBrowserService({ onEvent: collectorArg.onEvent });
    const win = fakeBrowserWindow();
    service.attachToWindow(win as unknown as Parameters<typeof service.attachToWindow>[0]);
    await service.createTab({ url: "https://example.test", activate: true });
    const view = fakes.webContentsViewInstances.at(-1)!;
    if (panel) {
      await service.setBounds({ x: 12, y: 24, width: panel.width, height: panel.height, visible: true });
    }
    const tabId = service.getStatus().activeTabId!;
    service.startPreviewStream({ tabId });
    await service.setBounds({ x: 12, y: 24, width: 0, height: 0, visible: false });
    return { service, win, view, tabId };
  };

  it("parks a previewed view past every display, not just past this window", async () => {
    // The blocker: the park point was `contentWidth + 64`, computed once. A
    // window that later widened past it painted a live page over the ADE UI.
    fakes.fakeScreen.setDisplays([
      { bounds: { x: 0, y: 0, width: 1280, height: 720 } },
      { bounds: { x: 1280, y: 0, width: 1920, height: 1080 } },
    ]);
    const { service, view, tabId } = await parkedTabFixture(collector, { width: 640, height: 360 });

    const parked = view.boundsCalls.at(-1)!;
    expect(parked.x).toBe(1280 + 1920 + 64);
    expect(parked.y).toBe(1080 + 64);

    service.stopPreviewStream({ tabId });
  });

  it("re-parks on window geometry events while a tab is parked", async () => {
    const { service, win, view, tabId } = await parkedTabFixture(collector, { width: 640, height: 360 });
    const beforeCalls = view.boundsCalls.length;

    // Maximise onto a display that did not exist when the park was computed.
    fakes.fakeScreen.setDisplays([{ bounds: { x: 0, y: 0, width: 3840, height: 2160 } }]);
    win.setContentBounds({ x: 0, y: 0, width: 3840, height: 2160 });
    vi.useFakeTimers();
    try {
      win.emit("maximize");
      vi.advanceTimersByTime(60);
    } finally {
      vi.useRealTimers();
    }

    expect(view.boundsCalls.length).toBeGreaterThan(beforeCalls);
    const reparked = view.boundsCalls.at(-1)!;
    // The whole point: outside the new content rect, in both axes.
    expect(reparked.x).toBeGreaterThanOrEqual(3840);
    expect(reparked.y).toBeGreaterThanOrEqual(2160);

    service.stopPreviewStream({ tabId });
  });

  it("re-parks when a display is added or its metrics change", async () => {
    const { service, view, tabId } = await parkedTabFixture(collector, { width: 640, height: 360 });
    const beforeCalls = view.boundsCalls.length;

    fakes.fakeScreen.setDisplays([
      { bounds: { x: 0, y: 0, width: 1280, height: 720 } },
      { bounds: { x: 1280, y: 0, width: 2560, height: 1440 } },
    ]);
    vi.useFakeTimers();
    try {
      fakes.fakeScreen.emit("display-added");
      vi.advanceTimersByTime(60);
    } finally {
      vi.useRealTimers();
    }

    expect(view.boundsCalls.length).toBeGreaterThan(beforeCalls);
    expect(view.boundsCalls.at(-1)!.x).toBeGreaterThanOrEqual(1280 + 2560);

    service.stopPreviewStream({ tabId });
  });

  it("drops its geometry watchers when it lets go of the window", async () => {
    const { service, view, win, tabId } = await parkedTabFixture(collector, { width: 640, height: 360 });
    expect(win.listenerCount("resize")).toBe(1);
    // One PROCESS-wide screen subscription, fanned out — not one per service.
    expect(fakes.fakeScreen.listenerCount("display-metrics-changed")).toBe(1);

    service.stopPreviewStream({ tabId });
    service.dispose();

    expect(win.listenerCount("resize")).toBe(0);
    expect(win.listenerCount("maximize")).toBe(0);
    // The shared listener may still be armed for another live service, so the
    // contract is behavioural: a disposed service takes no more rechecks.
    const afterDispose = view.boundsCalls.length;
    vi.useFakeTimers();
    try {
      fakes.fakeScreen.emit("display-metrics-changed");
      vi.advanceTimersByTime(60);
    } finally {
      vi.useRealTimers();
    }
    expect(view.boundsCalls).toHaveLength(afterDispose);
  });

  it("registers the screen listeners once per process, not once per window service", async () => {
    // `screen` is a singleton but services are keyed per (window, collection),
    // so three listeners each tripped Node's MaxListenersExceededWarning at
    // eleven live services — 33 registrations for one question.
    const services = Array.from({ length: 12 }, () => {
      const service = createBuiltInBrowserService({ onEvent: collector.onEvent });
      service.attachToWindow(fakeBrowserWindow() as unknown as Parameters<typeof service.attachToWindow>[0]);
      return service;
    });

    for (const event of ["display-metrics-changed", "display-added", "display-removed"]) {
      expect(fakes.fakeScreen.listenerCount(event)).toBe(1);
    }

    // Ref-counted, so a service letting go never leaves the others unwatched:
    // the count is still exactly one, not zero and not twelve.
    services[0].dispose();
    expect(fakes.fakeScreen.listenerCount("display-metrics-changed")).toBe(1);
    for (const service of services) service.dispose();
  });

  it("does not touch window focus on the ordering the product actually drives", async () => {
    // The corner card only previews the tool you are NOT looking at, so the
    // panel always hides FIRST and the stream starts after — there is no
    // attended tab to take the keyboard from. `parkedTabFixture` drives the
    // opposite order deliberately, to exercise the branch; this pins the real
    // one, which must never call `focus()` at all.
    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });
    const win = fakeBrowserWindow();
    service.attachToWindow(win as unknown as Parameters<typeof service.attachToWindow>[0]);
    await service.createTab({ url: "https://example.test", activate: true });
    await service.setBounds({ x: 12, y: 24, width: 480, height: 640, visible: true });
    const tabId = service.getStatus().activeTabId!;

    await service.setBounds({ x: 12, y: 24, width: 0, height: 0, visible: false });
    service.startPreviewStream({ tabId });

    expect(win.webContents.focusCalls).toBe(0);
    service.stopPreviewStream({ tabId });
    service.dispose();
  });

  it("hands the keyboard back to the window exactly once when an attended tab is parked", async () => {
    // The parked branch neither detaches nor hides the view, and those were the
    // two operations that used to release the page's keyboard focus. Reachable
    // only in the window between the panel hiding and the card's stop landing —
    // kept because the guard has to hold if a second `startPreviewStream`
    // caller (mobile, CLI, Mosaic) is ever added.
    const { service, win, tabId } = await parkedTabFixture(collector, { width: 640, height: 360 });
    expect(win.webContents.focusCalls).toBe(1);

    // Idempotent re-park passes must not keep stealing focus back.
    await service.setBounds({ x: 12, y: 24, width: 0, height: 0, visible: false });
    expect(win.webContents.focusCalls).toBe(1);

    service.stopPreviewStream({ tabId });
  });

  it("leaves a background window alone rather than raising it to return focus", async () => {
    // `WebContents.focus()` activates the owner window, so an unguarded call
    // would yank ADE to the front from behind whatever the user is using.
    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });
    const win = fakeBrowserWindow();
    service.attachToWindow(win as unknown as Parameters<typeof service.attachToWindow>[0]);
    await service.createTab({ url: "https://example.test", activate: true });
    await service.setBounds({ x: 12, y: 24, width: 480, height: 640, visible: true });
    const tabId = service.getStatus().activeTabId!;

    win.setFocused(false);
    service.startPreviewStream({ tabId });
    await service.setBounds({ x: 12, y: 24, width: 0, height: 0, visible: false });

    expect(win.webContents.focusCalls).toBe(0);
    service.stopPreviewStream({ tabId });
    service.dispose();
  });

  it("keeps the size the panel last showed a parked tab at", async () => {
    // Parking used to floor every hidden tab at 960x600, firing a real window
    // resize inside the page each way round.
    const { service, view, tabId } = await parkedTabFixture(collector, { width: 1100, height: 700 });
    expect(view.boundsCalls.at(-1)).toMatchObject({ width: 1100, height: 700 });
    service.stopPreviewStream({ tabId });

    // The case that matters: the Work pane is clamped to 26-55% of the window,
    // so EVERY realistic pane is narrower than the 960px floor. Flooring here
    // is what fired a real `window` resize inside the page each way round.
    const narrow = await parkedTabFixture(collector, { width: 480, height: 640 });
    expect(narrow.view.boundsCalls.at(-1)).toMatchObject({ width: 480, height: 640 });
    narrow.service.stopPreviewStream({ tabId: narrow.tabId });

    // A tab the panel never showed has no rect to reuse, so the floor applies.
    const fresh = await parkedTabFixture(collector, null);
    expect(fresh.view.boundsCalls.at(-1)).toMatchObject({ width: 960, height: 600 });
    fresh.service.stopPreviewStream({ tabId: fresh.tabId });
  });

  it("does not sweep every view for an unpaired preview stop", async () => {
    // `stop` reports zero subscribers both when the last watcher leaves and
    // when there was no stream at all; only the first is a state change.
    const { service, view, tabId } = await parkedTabFixture(collector, { width: 640, height: 360 });
    service.stopPreviewStream({ tabId });
    const afterUnpark = view.visibleCalls.length;

    service.stopPreviewStream({ tabId });
    service.stopPreviewStream({ tabId });

    expect(view.visibleCalls).toHaveLength(afterUnpark);
  });

  it("releases preview subscriptions when the host renderer goes away", async () => {
    // The preload's `pagehide` hook covers reloads and navigations but not a
    // crash, and a leaked subscriber now pins a composited page off-screen.
    const { win, view } = await parkedTabFixture(collector, { width: 640, height: 360 });
    expect(win.contentView.children).toHaveLength(1);

    win.webContents.emit("render-process-gone");

    expect(win.contentView.children).toHaveLength(0);
    expect(view.visibleCalls.at(-1)).toBe(false);
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

  it("routes project-scoped bridge calls to the matching project window", async () => {
    const scoped = projectScopedService(collector.onEvent);
    const service = scoped.service;
    const { browserWin: browserWinA } = scoped.openWindow("/Users/ade/project-alpha");
    const { browserWin: browserWinB } = scoped.openWindow("/Users/ade/project-beta");

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

  it("answers getStatusForProjectScope from the asking project, not the frontmost window", async () => {
    // The runtime daemon is project-scoped and the desktop bridge socket is
    // machine-wide, so an unscoped answer here showed project B's phone the
    // tabs of whichever window happened to be frontmost — hiding its own and
    // leaking another project's titles and URLs.
    const scoped = projectScopedService(collector.onEvent);
    const service = scoped.service;
    const { browserWin: browserWinA } = scoped.openWindow("/Users/ade/project-alpha");
    const { browserWin: browserWinB } = scoped.openWindow("/Users/ade/project-beta");

    service.attachToWindow(browserWinB);
    await service.createTab({ url: "https://beta.example.test", activate: true }, browserWinB);
    // Alpha is the frontmost window from here on.
    service.attachToWindow(browserWinA);
    await service.createTab({ url: "https://alpha.example.test", activate: true }, browserWinA);

    const beta = service.getStatusForProjectScope("/Users/ade/project-beta");
    expect(beta?.tabs.map((tab) => tab.url)).toEqual(["https://beta.example.test/"]);
    const alpha = service.getStatusForProjectScope("/Users/ade/project-alpha");
    expect(alpha?.tabs.map((tab) => tab.url)).toEqual(["https://alpha.example.test/"]);
    // Alpha is still the active window: a background status poll must not have
    // moved the pane the human is looking at.
    expect(service.getStatus().tabs.map((tab) => tab.url)).toEqual(["https://alpha.example.test/"]);
  });

  it("returns null from getStatusForProjectScope when no window serves the project", async () => {
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

    // `null`, not beta's tabs: the daemon renders its own "not open here" state
    // rather than another project's browsing.
    expect(service.getStatusForProjectScope("/Users/ade/project-alpha")).toBeNull();
    // A project-less daemon keeps the frontmost-window behaviour.
    expect(service.getStatusForProjectScope(null)?.tabs).toHaveLength(1);
  });

  it("does not materialize a project's browser collection to answer a status poll", async () => {
    // The Work-tools mirror polls this on a timer, once per project, for a phone
    // that may not be looking. Constructing the collection here would restore
    // and `loadURL` every persisted tab of a background project in the shared
    // authenticated profile — for a pane nobody opened.
    const scoped = projectScopedService(collector.onEvent);
    const service = scoped.service;
    const { browserWin } = scoped.openWindow("/Users/ade/project-alpha");
    const { win: betaWin } = scoped.openWindow("/Users/ade/project-beta");

    service.attachToWindow(browserWin);
    await service.createTab({ url: "https://alpha.example.test", activate: true }, browserWin);
    const viewsBefore = fakes.webContentsViewInstances.length;

    // Beta has a window open for it, but its Browser pane has never been used.
    expect(betaWin.contentView.children).toHaveLength(0);
    expect(service.getStatusForProjectScope("/Users/ade/project-beta")).toBeNull();
    // No collection was built, so no persisted tab was restored or loaded.
    expect(fakes.webContentsViewInstances).toHaveLength(viewsBefore);
    // And the frontmost project is untouched.
    expect(service.getStatus().collectionProjectRoot).toBe("/Users/ade/project-alpha");
  });

  it("tells a project with no window apart from one whose Browser pane was never opened", async () => {
    // Both read as a null status, and they are NOT the same state: the phone
    // words them differently (`desktop_not_attached_for_project` vs
    // `browser_pane_not_opened`), because "ADE Desktop doesn't have this
    // project open" sends a user whose project IS open — one click from the
    // tabs — to look for something already in front of them.
    const scoped = projectScopedService(collector.onEvent);
    const service = scoped.service;
    const { browserWin } = scoped.openWindow("/Users/ade/project-alpha");
    scoped.openWindow("/Users/ade/project-beta");

    service.attachToWindow(browserWin);
    await service.createTab({ url: "https://alpha.example.test", activate: true }, browserWin);

    // Beta: a window serves it, its pane has just never been used.
    expect(service.getStatusForProjectScope("/Users/ade/project-beta")).toBeNull();
    expect(service.hasWindowForProjectScope("/Users/ade/project-beta")).toBe(true);
    // Gamma: no window on this machine has it open at all.
    expect(service.getStatusForProjectScope("/Users/ade/project-gamma")).toBeNull();
    expect(service.hasWindowForProjectScope("/Users/ade/project-gamma")).toBe(false);
    // Asking never materialized anything, in either branch.
    expect(service.getStatus().collectionProjectRoot).toBe("/Users/ade/project-alpha");
  });

  it("stamps the dev-server chip with the lane's own collection, not the frontmost one", async () => {
    // Every surface filters `dev-server-detected` on `status.collectionProjectRoot`,
    // so a chip stamped with whichever collection happens to be frontmost is
    // dropped by the lane's own panel and merged into another project's launchpad.
    const registry = createDevServerRegistry();
    const scoped = projectScopedService(collector.onEvent);
    const service = scoped.service;
    const { browserWin: browserWinBeta } = scoped.openWindow("/Users/ade/project-beta");
    const { browserWin: browserWinAlpha } = scoped.openWindow("/Users/ade/project-alpha");
    service.stopDevServerWatch();
    const watched = createBuiltInBrowserService({
      onEvent: collector.onEvent,
      stateFilePath: null,
      permissionFilePath: null,
      devServers: registry,
      getProjectRootForWindow: (win) => scoped.projectRootByWindow.get(win.id) ?? null,
    });
    watched.attachToWindow(browserWinBeta);
    await watched.createTab({ url: "https://beta.example.test", activate: true, laneId: "lane-1" }, browserWinBeta);
    // Alpha is the frontmost collection from here on, and it is NOT the lane's.
    watched.attachToWindow(browserWinAlpha);
    await watched.createTab({ url: "https://alpha.example.test", activate: true }, browserWinAlpha);

    collector.events.length = 0;
    registry.record({ port: 5199, url: "http://localhost:5199/", laneId: "lane-1", sessionId: "sess-1" });
    await vi.waitFor(() =>
      expect(collector.events.some((entry) => entry.type === "dev-server-detected")).toBe(true));

    const chip = collector.events.find((entry) => entry.type === "dev-server-detected");
    expect(chip).toMatchObject({ autoOpened: false, tabId: null });
    expect(chip && "status" in chip ? chip.status.collectionProjectRoot : null)
      .toBe("/Users/ade/project-beta");
    watched.dispose();
  });

  it("stamps the chip with the detecting project's collection when the lane holds no tab", async () => {
    // The lane owns no browser tab, so there is nothing to resolve the chip's
    // collection from except the record's own project — and the frontmost
    // window is another project's, with tabs in it. Stamped with that one, the
    // lane's panel drops the chip and the other project's launchpad shows a
    // `localhost` URL that has nothing to do with it.
    const registry = createDevServerRegistry();
    const scoped = projectScopedService(collector.onEvent);
    const service = scoped.service;
    const { browserWin: browserWinAlpha } = scoped.openWindow("/Users/ade/project-alpha");
    const { browserWin: browserWinBeta } = scoped.openWindow("/Users/ade/project-beta");
    service.stopDevServerWatch();
    const watched = createBuiltInBrowserService({
      onEvent: collector.onEvent,
      stateFilePath: null,
      permissionFilePath: null,
      devServers: registry,
      getProjectRootForWindow: (win) => scoped.projectRootByWindow.get(win.id) ?? null,
      getWindowForProjectRoot: (projectRoot) =>
        projectRoot === "/Users/ade/project-alpha" ? browserWinAlpha : browserWinBeta,
    });
    // Alpha's pane exists (a human opened it) but holds no tab of this lane's.
    watched.attachToWindow(browserWinAlpha);
    await watched.createTab({ url: "https://alpha.example.test", activate: true }, browserWinAlpha);
    // Beta is frontmost and has tabs, so it is not an auto-open target either.
    watched.attachToWindow(browserWinBeta);
    await watched.createTab({ url: "https://beta.example.test", activate: true }, browserWinBeta);

    collector.events.length = 0;
    registry.record({
      port: 5288,
      url: "http://localhost:5288/",
      laneId: "lane-alpha",
      sessionId: "sess-alpha",
      projectRoot: "/Users/ade/project-alpha",
    });
    await vi.waitFor(() =>
      expect(collector.events.some((entry) => entry.type === "dev-server-detected")).toBe(true));

    const chip = collector.events.find((entry) => entry.type === "dev-server-detected");
    expect(chip).toMatchObject({ autoOpened: false, tabId: null });
    expect(chip && "status" in chip ? chip.status.collectionProjectRoot : null)
      .toBe("/Users/ade/project-alpha");
    watched.dispose();
  });

  it("emits no chip at all rather than filing it under another project's collection", async () => {
    // The lane's project has no Browser collection on this machine, and
    // building one to answer a chip would restore and load a background
    // project's persisted tabs for a pane nobody opened. The registry still
    // holds the record, so the pane lists the server the moment it is opened.
    const registry = createDevServerRegistry();
    const scoped = projectScopedService(collector.onEvent);
    const service = scoped.service;
    const { browserWin: browserWinBeta } = scoped.openWindow("/Users/ade/project-beta");
    scoped.openWindow("/Users/ade/project-alpha");
    service.stopDevServerWatch();
    const watched = createBuiltInBrowserService({
      onEvent: collector.onEvent,
      stateFilePath: null,
      permissionFilePath: null,
      devServers: registry,
      getProjectRootForWindow: (win) => scoped.projectRootByWindow.get(win.id) ?? null,
    });
    watched.attachToWindow(browserWinBeta);
    await watched.createTab({ url: "https://beta.example.test", activate: true }, browserWinBeta);

    collector.events.length = 0;
    const viewsBefore = fakes.webContentsViewInstances.length;
    registry.record({
      port: 5299,
      url: "http://localhost:5299/",
      laneId: "lane-alpha",
      sessionId: "sess-alpha",
      projectRoot: "/Users/ade/project-alpha",
    });
    await vi.waitFor(() => expect(registry.list({ laneId: "lane-alpha" })).toHaveLength(1));

    expect(collector.events.some((entry) => entry.type === "dev-server-detected")).toBe(false);
    expect(fakes.webContentsViewInstances).toHaveLength(viewsBefore);
    watched.dispose();
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
    const scoped = projectScopedService(collector.onEvent);
    const service = scoped.service;
    const { win, browserWin } = scoped.openWindow("/Users/ade/project-beta");
    // The window has alpha open as a tab too, without alpha being its current project.
    scoped.serveProjectFromWindow("/Users/ade/project-alpha", win);

    service.attachToWindow(browserWin);
    await service.createTab({ url: "https://beta.example.test", activate: true }, browserWin);
    await service.navigate({
      projectRoot: "/Users/ade/project-alpha",
      url: "https://alpha.example.test",
      newTab: true,
    });

    expect(scoped.projectRootByWindow.get(win.id)).toBe("/Users/ade/project-beta");
    expect(service.getStatus(browserWin).collectionProjectRoot).toBe("/Users/ade/project-beta");
    expect(service.getStatus(browserWin).url).toBe("https://beta.example.test/");
    expect(service.getStatus({ projectRoot: "/Users/ade/project-alpha" }).collectionProjectRoot).toBe("/Users/ade/project-alpha");
    expect(service.getStatus({ projectRoot: "/Users/ade/project-alpha" }).url).toBe("https://alpha.example.test/");
  });

  it("attaches project-scoped browser views without waiting for a window focus event", async () => {
    const scoped = projectScopedService(collector.onEvent);
    const service = scoped.service;
    const { win, browserWin } = scoped.openWindow();
    scoped.serveProjectFromWindow("/Users/ade/project-alpha", win);
    scoped.serveProjectFromWindow("/Users/ade/project-beta", win);

    service.attachToWindow(browserWin);
    scoped.setWindowProject(win, "/Users/ade/project-alpha");
    // Showing the pane no longer conjures a tab, so each collection opens one
    // explicitly; what is under test is which window the view attaches to.
    await service.createTab({ projectRoot: "/Users/ade/project-alpha", url: "https://alpha.test" });
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

    scoped.setWindowProject(win, "/Users/ade/project-beta");
    await service.createTab({ projectRoot: "/Users/ade/project-beta", url: "https://beta.test" });
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
    const scoped = projectScopedService(collector.onEvent);
    const service = scoped.service;
    const { win, browserWin } = scoped.openWindow("/Users/ade/project-alpha");

    service.attachToWindow(browserWin);
    await service.createTab({ projectRoot: "/Users/ade/project-alpha", url: "https://alpha.test" });
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
    const scoped = projectScopedService(collector.onEvent);
    const service = scoped.service;
    const { win: winA } = scoped.openWindow("/Users/ade/project-alpha");
    const { win: winB } = scoped.openWindow("/Users/ade/project-beta");

    await service.createTab({ projectRoot: "/Users/ade/project-alpha", url: "https://alpha.test" });
    await service.createTab({ projectRoot: "/Users/ade/project-beta", url: "https://beta.test" });
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
    expect(fakes.webContentsViewInstances.at(-1)?.backgroundColor).toBe("#ffffff");
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
    await service.startInspect();
    expect(service.getStatus().isInspecting).toBe(true);

    const response = firstWc?.openWindow("https://accounts.google.com/gsi/select", {
      referrer: { url: "https://example.test/sign-in", policy: "strict-origin-when-cross-origin" },
      postBody: {
        contentType: "application/x-www-form-urlencoded",
        data: postData,
      },
    });

    expect(response?.action).toBe("allow");
    expect(response?.createWindow).toEqual(expect.any(Function));
    const electronPopupWc = new fakes.WebContents();
    electronPopupWc.session = fakes.sessionForPartition(service.getStatus().partition);
    const popupWc = response?.createWindow?.({
      webContents: electronPopupWc,
      webPreferences: {
        additionalArguments: ["--popup"],
        javascript: false,
        nodeIntegration: true,
        partition: "persist:other",
        webviewTag: true,
      },
    });
    expect(popupWc).toBe(electronPopupWc);
    expect(fakes.webContentsViewInstances.at(-1)?.webContents).toBe(electronPopupWc);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(service.getStatus().isInspecting).toBe(false);
    expect(firstWc?.debugger.isAttached()).toBe(false);
    await popupWc?.loadURL("https://accounts.google.com/gsi/select");

    expect(service.getStatus().tabs).toHaveLength(2);
    expect(service.getStatus().activeTabId).not.toBe(firstTabId);
    expect(service.getStatus().tabs.at(-1)).toMatchObject({
      url: "https://accounts.google.com/gsi/select",
      ownerLaneId: null,
      ownerChatSessionId: null,
    });
    expect(fakes.webContentsViewInstances.at(-1)?.webPreferences).toBeUndefined();
    expect(fakes.webContentsViewInstances.at(-1)?.backgroundColor).toBe("#ffffff");

    const openEvent = collector.events.findLast((event) => event.type === "open-request");
    expect(openEvent).toMatchObject({
      type: "open-request",
      url: "https://accounts.google.com/gsi/select",
      tabId: service.getStatus().activeTabId,
    });
  });

  it("loads deferred background popups without stealing focus", async () => {
    fakes.setSendCommand(async (method) => {
      switch (method) {
        case "DOM.getNodeForLocation":
          return { backendNodeId: 42 };
        case "DOM.resolveNode":
          return { object: { objectId: "background-popup-selection" } };
        case "Runtime.callFunctionOn":
          return {
            result: {
              value: {
                tagName: "button",
                selector: "button#keep-selected",
                testId: null,
                frame: { x: 0, y: 0, width: 10, height: 10 },
                pixelRatio: 1,
                url: "https://example.test/",
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
    await service.createTab({
      url: "https://example.test",
      activate: true,
    });
    const firstTabId = service.getStatus().activeTabId;
    const firstWc = fakes.webContentsInstances[0];
    await service.selectPoint({ x: 5, y: 5, includeScreenshot: false });
    expect(service.getStatus().hasSelection).toBe(true);
    collector.events.length = 0;

    const response = firstWc?.openWindow("https://example.test/background", {
      disposition: "background-tab",
    });
    const popupWc = response?.createWindow?.({});

    expect(response?.action).toBe("allow");
    expect(popupWc).toBe(fakes.webContentsInstances.at(-1));
    expect(popupWc?.loadURLCalls).toEqual([{
      url: "https://example.test/background",
      options: undefined,
    }]);
    expect(service.getStatus()).toMatchObject({
      activeTabId: firstTabId,
      url: "https://example.test/",
      hasSelection: true,
    });
    expect(service.getStatus().tabs).toHaveLength(2);
    expect(service.getStatus().tabs.at(-1)?.url).toBe("https://example.test/background");
    expect(collector.events.some((event) => event.type === "open-request")).toBe(false);
    expect(collector.events.some((event) => event.type === "selection-cleared")).toBe(false);
    expect(fakes.webContentsViewInstances.at(-1)?.webPreferences).toMatchObject({
      partition: service.getStatus().partition,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
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

      // The tally is coalesced: three error signals above, one `diagnostics`
      // event once the window closes. A page in an error loop used to emit one
      // IPC event per error to every window, all moving the same red dot.
      const diagnosticsEvents = () =>
        collector.events.filter((event) => event.type === "diagnostics" && event.tabId === tabId);
      expect(diagnosticsEvents()).toHaveLength(0);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(diagnosticsEvents()).toHaveLength(1);
      expect(diagnosticsEvents().at(-1)).toMatchObject({
        consoleErrorCount: 1,
        failedRequestCount: 2,
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

  it("keeps a new popup inspect session intact while the opener finishes inspect cleanup", async () => {
    fakes.setSendCommand(async () => ({}));
    const service = createBuiltInBrowserService({ onEvent: collector.onEvent });
    await service.navigate({ url: "https://example.test", newTab: true });
    await service.startInspect();

    const openerWc = fakes.webContentsInstances[0];
    const cleanupDeferred = createDeferred<unknown>();
    let delayedCleanup = false;
    fakes.setSendCommand(async (method, params) => {
      const expression = typeof params?.expression === "string" ? params.expression : "";
      if (
        !delayedCleanup
        && method === "Runtime.evaluate"
        && expression.includes("const current = window.__adeBuiltInBrowserInspector")
      ) {
        delayedCleanup = true;
        return cleanupDeferred.promise;
      }
      return {};
    });

    const response = openerWc?.openWindow("https://accounts.google.com/signin", {
      disposition: "foreground-tab",
    });
    const popupWc = new fakes.WebContents();
    popupWc.session = fakes.sessionForPartition(service.getStatus().partition);
    response?.createWindow?.({ webContents: popupWc });

    await service.startInspect();
    expect(service.getStatus().isInspecting).toBe(true);
    expect(popupWc.debugger.isAttached()).toBe(true);

    cleanupDeferred.resolve({});
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(service.getStatus().isInspecting).toBe(true);
    expect(openerWc?.debugger.isAttached()).toBe(false);
    expect(popupWc.debugger.isAttached()).toBe(true);

    await service.stopInspect();
    expect(service.getStatus().isInspecting).toBe(false);
    expect(popupWc.debugger.isAttached()).toBe(false);
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

/**
 * The soft "no tab" result the IPC boundary returns instead of an error.
 *
 * `registerIpc` narrows with `isBuiltInBrowserNoTabError` and then reads
 * `error.tabId` for its debug line, so the predicate has to prove the field is
 * there — not just that the name matches. A name-only match would hand those
 * two readers `undefined` under a type that says `string | null`, which is the
 * shape a second copy of this module (or an error rehydrated across a process
 * boundary) actually produces.
 */
describe("BuiltInBrowserNoTabError", () => {
  it("keeps the named tab in the message so a raw log still says which one lost", () => {
    const named = new BuiltInBrowserNoTabError("No browser tab is open", "tab-7");
    expect(named.tabId).toBe("tab-7");
    expect(named.message).toBe("No browser tab is open: tab-7");
    expect(named.reason).toBe("no_tab");

    const anonymous = new BuiltInBrowserNoTabError("No browser tab is open");
    expect(anonymous.tabId).toBeNull();
    // Nothing to append, so the message is not decorated with an empty suffix.
    expect(anonymous.message).toBe("No browser tab is open");
  });

  it("accepts a foreign copy only when it can actually answer `tabId`", () => {
    expect(isBuiltInBrowserNoTabError(new BuiltInBrowserNoTabError("x", "tab-1"))).toBe(true);

    // A second module copy: not `instanceof`, but it carries the field the
    // readers dereference.
    const foreign = Object.assign(new Error("x"), { name: "BuiltInBrowserNoTabError", tabId: null });
    expect(isBuiltInBrowserNoTabError(foreign)).toBe(true);

    // Same name, no field — narrowing this would be the unsound branch.
    const nameOnly = Object.assign(new Error("x"), { name: "BuiltInBrowserNoTabError" });
    expect(isBuiltInBrowserNoTabError(nameOnly)).toBe(false);
    expect(isBuiltInBrowserNoTabError(new Error("No browser tab is open"))).toBe(false);
    expect(isBuiltInBrowserNoTabError({ name: "BuiltInBrowserNoTabError", tabId: "t" })).toBe(false);
    expect(isBuiltInBrowserNoTabError(null)).toBe(false);
  });
});
