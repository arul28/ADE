import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BuiltInBrowserEventPayload } from "../../../shared/types";
import { createBuiltInBrowserService } from "./builtInBrowserService";

/**
 * Service-level coverage for the tab capability surface added alongside the
 * agent actions: emulation, zoom, find, DevTools, the opt-in network log/HAR,
 * upload-root validation and the recording lifecycle.
 */

const fakes = vi.hoisted(() => {
  type Handler = (...args: unknown[]) => void;

  class FakeDebugger {
    attached = false;
    private listeners: Record<string, Handler[]> = {};
    attach = (): void => {
      this.attached = true;
    };
    detach = (): void => {
      this.attached = false;
    };
    isAttached = (): boolean => this.attached;
    on = (event: string, fn: Handler): void => {
      (this.listeners[event] ??= []).push(fn);
    };
    off = (event: string, fn: Handler): void => {
      const list = this.listeners[event];
      if (!list) return;
      const index = list.indexOf(fn);
      if (index >= 0) list.splice(index, 1);
    };
    emit = (event: string, ...args: unknown[]): void => {
      for (const listener of [...(this.listeners[event] ?? [])]) listener(...args);
    };
    sendCommand = (method: string, params?: Record<string, unknown>): Promise<unknown> =>
      sendCommandImpl(method, params);
  }

  const sentCommands: Array<{ method: string; params?: Record<string, unknown> }> = [];
  let sendCommandImpl: (method: string, params?: Record<string, unknown>) => Promise<unknown> =
    async (method, params) => {
      sentCommands.push({ method, params });
      return {};
    };

  class FakeWebContents {
    id = Math.floor(Math.random() * 1_000_000);
    debugger = new FakeDebugger();
    session: unknown = null;
    currentUrl = "";
    zoomFactors: number[] = [];
    devToolsOpenCalls: Array<Record<string, unknown> | undefined> = [];
    devToolsCloseCalls = 0;
    findCalls: Array<{ text: string; options?: Record<string, unknown> }> = [];
    stopFindCalls: string[] = [];
    private listeners: Record<string, Handler[]> = {};
    loadURL = async (url: string): Promise<void> => {
      this.currentUrl = url;
      this.emit("did-navigate", {}, url);
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
    getTitle = (): string => "Example";
    setAudioMuted = (): void => undefined;
    setUserAgent = (): void => undefined;
    setWindowOpenHandler = (): void => undefined;
    setZoomFactor = (factor: number): void => {
      this.zoomFactors.push(factor);
    };
    openDevTools = (options?: Record<string, unknown>): void => {
      this.devToolsOpenCalls.push(options);
    };
    closeDevTools = (): void => {
      this.devToolsCloseCalls += 1;
    };
    findInPage = (text: string, options?: Record<string, unknown>): number => {
      this.findCalls.push({ text, options });
      const requestId = this.findCalls.length;
      setTimeout(() => {
        this.emit("found-in-page", {}, {
          requestId,
          activeMatchOrdinal: 1,
          matches: 3,
          finalUpdate: true,
          selectionArea: {},
        });
      }, 0);
      return requestId;
    };
    stopFindInPage = (action: string): void => {
      this.stopFindCalls.push(action);
    };
    capturePage = async () => ({
      isEmpty: () => false,
      toDataURL: () => "data:image/png;base64,dGVzdA==",
      getSize: () => ({ width: 320, height: 180 }),
    });
    on = (event: string, fn: Handler): void => {
      (this.listeners[event] ??= []).push(fn);
    };
    once = (event: string, fn: Handler): void => {
      this.on(event, fn);
    };
    off = (event: string, fn: Handler): void => {
      const list = this.listeners[event];
      if (!list) return;
      const index = list.indexOf(fn);
      if (index >= 0) list.splice(index, 1);
    };
    removeListener = (event: string, fn: Handler): void => {
      this.off(event, fn);
    };
    emit = (event: string, ...args: unknown[]): void => {
      for (const listener of [...(this.listeners[event] ?? [])]) listener(...args);
    };
  }

  const webContentsInstances: FakeWebContents[] = [];

  class FakeWebContentsView {
    webContents: FakeWebContents;
    constructor(options?: { webPreferences?: { partition?: string } }) {
      this.webContents = new FakeWebContents();
      this.webContents.session = sessionForPartition(
        options?.webPreferences?.partition ?? "persist:ade-browser",
      );
      webContentsInstances.push(this.webContents);
    }
    setBackgroundColor = (): void => undefined;
    setBounds = (): void => undefined;
    setVisible = (): void => undefined;
  }

  const sessions = new Map<string, Record<string, unknown>>();
  const sessionForPartition = (partition: string): Record<string, unknown> => {
    const existing = sessions.get(partition);
    if (existing) return existing;
    const next: Record<string, unknown> = {
      cookies: { flushStore: async () => undefined, get: async () => [] },
      flushStorageData: () => undefined,
      getCacheSize: async () => 0,
      webRequest: {
        onBeforeSendHeaders: () => undefined,
        onBeforeRequest: () => undefined,
        onCompleted: () => undefined,
        onErrorOccurred: () => undefined,
      },
      on: () => undefined,
      off: () => undefined,
      removeListener: () => undefined,
      setPermissionCheckHandler: () => undefined,
      setPermissionRequestHandler: () => undefined,
      setDisplayMediaRequestHandler: () => undefined,
    };
    sessions.set(partition, next);
    return next;
  };

  let userDataPath = "/tmp";
  return {
    WebContentsView: FakeWebContentsView,
    webContentsInstances,
    sentCommands,
    sessionForPartition,
    appGetPath: (name: string) => (name === "downloads" ? "/tmp/downloads" : userDataPath),
    setUserDataPath: (next: string) => {
      userDataPath = next;
    },
    setSendCommand: (impl: (method: string, params?: Record<string, unknown>) => Promise<unknown>) => {
      sendCommandImpl = impl;
    },
    reset: () => {
      webContentsInstances.length = 0;
      sentCommands.length = 0;
      sessions.clear();
      sendCommandImpl = async (method, params) => {
        sentCommands.push({ method, params });
        return {};
      };
    },
  };
});

vi.mock("electron", () => ({
  WebContentsView: fakes.WebContentsView,
  app: {
    getPath: (name: string) => fakes.appGetPath(name),
    isReady: () => true,
    getVersion: () => "9.9.9",
  },
  dialog: { showMessageBox: async () => ({ response: 0, checkboxChecked: false }) },
  nativeImage: { createFromDataURL: () => ({ getSize: () => ({ width: 0, height: 0 }) }) },
  screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) },
  session: { fromPartition: (partition: string) => fakes.sessionForPartition(partition) },
  shell: { openExternal: async () => undefined },
  webContents: { fromId: () => null },
}));

const LOCAL_URL = "http://localhost:5173/";
const scratchRoots: string[] = [];

function scratchRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-browser-caps-"));
  scratchRoots.push(dir);
  return dir;
}

function collectEvents(): {
  events: BuiltInBrowserEventPayload[];
  onEvent: (payload: BuiltInBrowserEventPayload) => void;
} {
  const events: BuiltInBrowserEventPayload[] = [];
  return { events, onEvent: (payload) => void events.push(payload) };
}

async function serviceWithTab(overrides: Parameters<typeof createBuiltInBrowserService>[0] = {}) {
  const collector = collectEvents();
  const service = createBuiltInBrowserService({
    onEvent: collector.onEvent,
    stateFilePath: null,
    permissionFilePath: null,
    ...overrides,
  });
  const status = await service.createTab({ url: LOCAL_URL, activate: true });
  const tabId = status.activeTabId!;
  return { service, tabId, collector };
}

beforeEach(() => {
  fakes.reset();
  // Observations, HAR files and recordings all live under the scratch root the
  // service derives from `app.getPath("userData")`.
  fakes.setUserDataPath(scratchRoot());
});

afterEach(() => {
  while (scratchRoots.length) {
    const dir = scratchRoots.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("built-in browser emulation", () => {
  it("applies device metrics, touch and user agent overrides for a preset", async () => {
    const { service, tabId } = await serviceWithTab();
    const result = await service.setEmulation({ tabId, preset: "iphone-17-pro" });

    expect(result.emulation).toMatchObject({ presetId: "iphone-17-pro", width: 402, mobile: true });
    expect(result.presets.map((preset) => preset.id)).toContain("ipad");

    const metrics = fakes.sentCommands.find((call) => call.method === "Emulation.setDeviceMetricsOverride");
    expect(metrics?.params).toMatchObject({
      width: 402,
      height: 874,
      deviceScaleFactor: 3,
      mobile: true,
    });
    expect(fakes.sentCommands.find((call) => call.method === "Emulation.setTouchEmulationEnabled")?.params)
      .toMatchObject({ enabled: true });
    expect(fakes.sentCommands.find((call) => call.method === "Emulation.setUserAgentOverride")?.params)
      .toMatchObject({ userAgent: expect.stringContaining("iPhone") });

    const tab = service.getStatus().tabs.find((entry) => entry.id === tabId);
    expect(tab?.emulation).toMatchObject({ presetId: "iphone-17-pro" });
  });

  it("clears the override for --off and reports it in tab state", async () => {
    const { service, tabId } = await serviceWithTab();
    await service.setEmulation({ tabId, preset: "ipad" });
    const cleared = await service.setEmulation({ tabId, preset: "off" });

    expect(cleared.emulation).toBeNull();
    expect(fakes.sentCommands.some((call) => call.method === "Emulation.clearDeviceMetricsOverride")).toBe(true);
    expect(service.getStatus().tabs[0]?.emulation).toBeNull();
  });

  it("rejects an unknown preset without touching the tab", async () => {
    const { service, tabId } = await serviceWithTab();
    await expect(service.setEmulation({ tabId, preset: "iphone-99" }))
      .rejects.toThrow(/Unknown browser device preset/);
    expect(service.getStatus().tabs[0]?.emulation).toBeNull();
  });
});

describe("built-in browser zoom", () => {
  it("clamps the factor, applies it to the tab, and reports it in status", async () => {
    const { service, tabId } = await serviceWithTab();
    const result = await service.setZoom({ tabId, factor: 12 });
    expect(result.zoomFactor).toBe(5);
    expect(fakes.webContentsInstances[0]?.zoomFactors).toEqual([5]);
    expect(service.getStatus().tabs[0]?.zoomFactor).toBe(5);

    const reset = await service.setZoom({ tabId, reset: true });
    expect(reset.zoomFactor).toBe(1);
    expect(service.getStatus().tabs[0]?.zoomFactor).toBe(1);
  });

  it("re-applies a non-default zoom after a navigation drops it", async () => {
    const { service, tabId } = await serviceWithTab();
    await service.setZoom({ tabId, factor: 1.5 });
    const wc = fakes.webContentsInstances[0]!;
    wc.zoomFactors.length = 0;
    wc.emit("did-navigate", {}, "http://localhost:5173/next");
    expect(wc.zoomFactors).toEqual([1.5]);
  });
});

describe("built-in browser find in page", () => {
  it("returns the final match counts and mirrors them onto the event stream", async () => {
    const { service, tabId, collector } = await serviceWithTab();
    const result = await service.findInPage({ tabId, text: "checkout", matchCase: true });

    expect(result).toMatchObject({ matches: 3, activeMatchOrdinal: 1, finalUpdate: true, text: "checkout" });
    expect(fakes.webContentsInstances[0]?.findCalls[0]).toMatchObject({
      text: "checkout",
      options: { forward: true, matchCase: true, findNext: false },
    });
    const found = collector.events.find((event) => event.type === "found-in-page");
    expect(found).toMatchObject({ type: "found-in-page", tabId, matches: 3 });

    await service.stopFindInPage({ tabId });
    expect(fakes.webContentsInstances[0]?.stopFindCalls).toEqual(["clearSelection"]);
  });

  it("requires search text", async () => {
    const { service, tabId } = await serviceWithTab();
    await expect(service.findInPage({ tabId, text: "  " })).rejects.toThrow(/Find text is required/);
  });
});

describe("built-in browser DevTools", () => {
  it("opens and closes DevTools and reports it in tab state", async () => {
    const { service, tabId } = await serviceWithTab();
    const opened = await service.setDevTools({ tabId, open: true, mode: "bottom" });
    expect(opened).toMatchObject({ devToolsOpen: true, mode: "bottom" });
    expect(fakes.webContentsInstances[0]?.devToolsOpenCalls[0]).toEqual({ mode: "bottom" });
    expect(service.getStatus().tabs[0]?.devToolsOpen).toBe(true);

    const closed = await service.setDevTools({ tabId, open: false });
    expect(closed).toMatchObject({ devToolsOpen: false, mode: null });
    expect(fakes.webContentsInstances[0]?.devToolsCloseCalls).toBe(1);
    expect(service.getStatus().tabs[0]?.devToolsOpen).toBe(false);
  });

  it("refuses to open DevTools while the debugger is held by network logging", async () => {
    const { service, tabId } = await serviceWithTab();
    await service.setNetworkLogging({ tabId, enabled: true });
    await expect(service.setDevTools({ tabId, open: true }))
      .rejects.toThrow(/network logging, which owns the debugger/);
  });
});

describe("built-in browser network log", () => {
  async function recordOneRequest(service: Awaited<ReturnType<typeof serviceWithTab>>["service"], tabId: string) {
    await service.setNetworkLogging({ tabId, enabled: true });
    const debug = fakes.webContentsInstances[0]!.debugger;
    debug.emit("message", {}, "Network.requestWillBeSent", {
      requestId: "req-1",
      type: "XHR",
      request: {
        method: "POST",
        url: "http://localhost:5173/api/login",
        headers: { Authorization: "Bearer secret-token", Accept: "application/json" },
        postData: "hello",
      },
    });
    debug.emit("message", {}, "Network.responseReceived", {
      requestId: "req-1",
      type: "XHR",
      response: {
        status: 401,
        statusText: "Unauthorized",
        mimeType: "application/json",
        protocol: "http/1.1",
        headers: { "Set-Cookie": "session=abc", "Content-Type": "application/json" },
        encodedDataLength: 90,
      },
    });
    debug.emit("message", {}, "Network.loadingFinished", {
      requestId: "req-1",
      encodedDataLength: 512,
    });
  }

  it("records full entries with redacted credential headers", async () => {
    const { service, tabId } = await serviceWithTab();
    await recordOneRequest(service, tabId);

    const log = await service.getNetworkLog({ tabId });
    expect(log.enabled).toBe(true);
    expect(log.recordedCount).toBe(1);
    const entry = log.entries[0]!;
    expect(entry).toMatchObject({
      method: "POST",
      url: "http://localhost:5173/api/login",
      status: 401,
      statusText: "Unauthorized",
      mimeType: "application/json",
      protocol: "http/1.1",
      resourceType: "XHR",
      responseBodySize: 512,
      requestBodySize: 5,
    });
    expect(entry.requestHeaders.find((header) => header.name === "Authorization"))
      .toMatchObject({ redacted: true });
    expect(entry.responseHeaders.find((header) => header.name === "Set-Cookie"))
      .toMatchObject({ redacted: true });
    expect(JSON.stringify(entry)).not.toContain("secret-token");
    expect(JSON.stringify(entry)).not.toContain("session=abc");
    expect(entry.timings.durationMs).toBeTypeOf("number");
  });

  it("supports failure and substring filters", async () => {
    const { service, tabId } = await serviceWithTab();
    await recordOneRequest(service, tabId);
    expect((await service.getNetworkLog({ tabId, failedOnly: true })).entries).toHaveLength(1);
    expect((await service.getNetworkLog({ tabId, filter: "nothing-here" })).entries).toHaveLength(0);
    expect((await service.getNetworkLog({ tabId, filter: "api/login" })).entries).toHaveLength(1);
  });

  it("stops recording once logging is turned off", async () => {
    const { service, tabId } = await serviceWithTab();
    await recordOneRequest(service, tabId);
    await service.setNetworkLogging({ tabId, enabled: false });
    fakes.webContentsInstances[0]!.debugger.emit("message", {}, "Network.requestWillBeSent", {
      requestId: "req-2",
      request: { method: "GET", url: "http://localhost:5173/late", headers: {} },
    });
    const log = await service.getNetworkLog({ tabId });
    expect(log.enabled).toBe(false);
    expect(log.recordedCount).toBe(1);
    expect(service.getStatus().tabs[0]?.networkLogging).toBe(false);
  });

  it("writes a HAR 1.2 file under the observation scratch root", async () => {
    const projectRoot = scratchRoot();
    const collector = collectEvents();
    const service = createBuiltInBrowserService({
      onEvent: collector.onEvent,
      stateFilePath: null,
      permissionFilePath: null,
      getProjectRootForWindow: () => projectRoot,
    });
    const status = await service.createTab({ projectRoot: undefined, url: LOCAL_URL, activate: true });
    const tabId = status.activeTabId!;
    await recordOneRequest(service, tabId);

    const exported = await service.exportHar({ tabId });
    expect(exported.entryCount).toBe(1);
    expect(exported.filePath.endsWith(".har")).toBe(true);
    const har = JSON.parse(fs.readFileSync(exported.filePath, "utf8"));
    expect(har.log.version).toBe("1.2");
    expect(har.log.entries).toHaveLength(1);
    expect(JSON.stringify(har)).not.toContain("secret-token");
  });

  it("refuses a HAR export when nothing was ever recorded", async () => {
    const { service, tabId } = await serviceWithTab();
    await expect(service.exportHar({ tabId })).rejects.toThrow(/no recorded requests/);
  });
});

describe("built-in browser uploads", () => {
  it("rejects a path outside the allowed roots before touching the page", async () => {
    const { service, tabId } = await serviceWithTab();
    await expect(service.uploadFile({
      tabId,
      selector: "input[type=file]",
      paths: ["/etc/passwd"],
      observe: false,
    })).rejects.toThrow(/outside the allowed roots/);
  });

  it("rejects an allowed-root path that is not a readable file", async () => {
    const { service, tabId } = await serviceWithTab();
    await expect(service.uploadFile({
      tabId,
      selector: "input[type=file]",
      paths: [path.join(os.tmpdir(), "ade-missing-upload-fixture.png")],
      observe: false,
    })).rejects.toThrow(/not a readable file/);
  });
});

describe("built-in browser recording", () => {
  function stubRecorderFactory(calls: string[] = []) {
    return async () => ({
      format: "webm" as const,
      mimeType: "video/webm",
      start: async () => {
        calls.push("start");
      },
      stop: async ({ durationMs }: { durationMs: number }) => {
        calls.push("stop");
        return { filePath: "/tmp/ade-rec.webm", frameCount: Math.round(durationMs / 33), manifestPath: null };
      },
      abort: () => {
        calls.push("abort");
      },
    });
  }

  it("surfaces the recording in tab state and events, and returns the file on stop", async () => {
    const calls: string[] = [];
    const { service, tabId, collector } = await serviceWithTab({
      createTabRecorder: stubRecorderFactory(calls),
    });

    const started = await service.startRecording({ tabId, fps: 60, caption: "Checkout" });
    expect(started.recording.fps).toBe(60);
    expect(service.getStatus().tabs[0]?.recording).toMatchObject({ fps: 60 });
    expect(collector.events.some((event) => event.type === "recording" && event.recording != null)).toBe(true);

    const stopped = await service.stopRecording({ tabId });
    expect(stopped).toMatchObject({
      tabId,
      path: "/tmp/ade-rec.webm",
      fps: 60,
      format: "webm",
      mimeType: "video/webm",
      caption: "Checkout",
      manifestPath: null,
    });
    expect(service.getStatus().tabs[0]?.recording).toBeNull();
    expect(calls).toEqual(["start", "stop"]);
  });

  it("keeps the caption null when none was given at start", async () => {
    const { service, tabId } = await serviceWithTab({ createTabRecorder: stubRecorderFactory() });
    await service.startRecording({ tabId });
    const stopped = await service.stopRecording({ tabId });
    expect(stopped.caption).toBeNull();
    expect(stopped.fps).toBe(30);
  });

  it("refuses a second concurrent recording and a stop with nothing running", async () => {
    const { service, tabId } = await serviceWithTab({ createTabRecorder: stubRecorderFactory() });
    await expect(service.stopRecording({ tabId })).rejects.toThrow(/is not recording/);
    await service.startRecording({ tabId });
    await expect(service.startRecording({ tabId })).rejects.toThrow(/already recording/);
    await service.stopRecording({ tabId });
  });

  it("rejects an unsupported frame rate", async () => {
    const { service, tabId } = await serviceWithTab({ createTabRecorder: stubRecorderFactory() });
    await expect(service.startRecording({ tabId, fps: 24 })).rejects.toThrow(/must be 30 or 60/);
  });
});
