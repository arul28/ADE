import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BuiltInBrowserEventPayload } from "../../../shared/types";
import type { WebContents } from "electron";
import { createBuiltInBrowserService } from "./builtInBrowserService";
import { awaitFoundInPage, type BuiltInBrowserFindWaiters } from "./builtInBrowserFind";
import { createDevServerRegistry } from "../devServers/devServerRegistry";

/**
 * Service-level coverage for `builtInBrowserTabCapabilities.ts`: emulation,
 * zoom, find, DevTools, the opt-in network log/HAR, upload-root validation and
 * the recording lifecycle.
 *
 * Driven through `createBuiltInBrowserService` rather than
 * `createBuiltInBrowserTabCapabilities` directly, on purpose: the seam between
 * them is what a regression would break, and constructing the deps object by
 * hand would assert the mock instead of the wiring.
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

  it("sends the screen metrics, touch-from-mouse and UA metadata a preset needs to re-lay-out", async () => {
    const { service, tabId } = await serviceWithTab();
    await service.setEmulation({ tabId, preset: "pixel" });

    // Without screenWidth/screenHeight the page still reads the host window's
    // `screen.*`, so a responsive site keeps its desktop breakpoint.
    expect(fakes.sentCommands.find((call) => call.method === "Emulation.setDeviceMetricsOverride")?.params)
      .toMatchObject({ width: 412, height: 915, screenWidth: 412, screenHeight: 915, mobile: true });
    expect(fakes.sentCommands.find((call) => call.method === "Emulation.setEmitTouchEventsForMouse")?.params)
      .toMatchObject({ enabled: true, configuration: "mobile" });
    const ua = fakes.sentCommands.find((call) => call.method === "Emulation.setUserAgentOverride")?.params;
    expect(ua).toMatchObject({
      userAgentMetadata: expect.objectContaining({ platform: "Android", mobile: true }),
    });
  });

  it("keeps the debugger attached while emulating and releases it when cleared", async () => {
    const { service, tabId } = await serviceWithTab();
    const wc = fakes.webContentsInstances[0]!;

    await service.setEmulation({ tabId, preset: "ipad" });
    // Chromium reverts every Emulation.* override when the CDP session that set
    // it detaches, so the override has to hold the debugger open.
    expect(wc.debugger.isAttached()).toBe(true);

    await service.setEmulation({ tabId, preset: "off" });
    expect(wc.debugger.isAttached()).toBe(false);
  });

  it("re-applies the override after a navigation drops it", async () => {
    const { service, tabId } = await serviceWithTab();
    await service.setEmulation({ tabId, preset: "iphone-17" });
    const wc = fakes.webContentsInstances[0]!;
    fakes.sentCommands.length = 0;

    wc.emit("did-navigate", {}, "http://localhost:5173/next");
    // The re-apply is fire-and-forget; let its CDP round trips settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fakes.sentCommands.find((call) => call.method === "Emulation.setDeviceMetricsOverride")?.params)
      .toMatchObject({ width: 393, height: 852 });
    expect(service.getStatus().tabs[0]?.emulation).toMatchObject({ presetId: "iphone-17" });
  });

  it("refuses DevTools while a device preset owns the debugger", async () => {
    const { service, tabId } = await serviceWithTab();
    await service.setEmulation({ tabId, preset: "ipad" });
    await expect(service.setDevTools({ tabId, open: true }))
      .rejects.toThrow(/emulating a device/);
  });
});

describe("built-in browser launchpad tabs", () => {
  it("opens about:blank with no request when createTab gets no url", async () => {
    const collector = collectEvents();
    const service = createBuiltInBrowserService({
      onEvent: collector.onEvent,
      stateFilePath: null,
      permissionFilePath: null,
    });
    await service.createTab({});

    const tab = service.getStatus().tabs[0];
    expect(tab).toMatchObject({ isLaunchpad: true, title: "New tab" });
    // ADE never picks a home page: nothing was loaded at all.
    expect(fakes.webContentsInstances[0]?.currentUrl).toBe("");
  });

  it("stops being a launchpad once the tab navigates", async () => {
    const collector = collectEvents();
    const service = createBuiltInBrowserService({
      onEvent: collector.onEvent,
      stateFilePath: null,
      permissionFilePath: null,
    });
    await service.createTab({});
    await service.navigate({ url: LOCAL_URL });

    expect(service.getStatus().tabs[0]).toMatchObject({ isLaunchpad: false });
  });

  it("leaves zero tabs when the last tab is closed", async () => {
    const { service, tabId } = await serviceWithTab();
    const status = await service.closeTab({ tabId });
    expect(status.tabs).toEqual([]);
    expect(status.activeTabId).toBeNull();

    // Revealing the pane must not conjure a replacement tab.
    await service.setBounds({ x: 0, y: 0, width: 640, height: 360, visible: true });
    expect(service.getStatus().tabs).toEqual([]);
  });
});

describe("built-in browser favicons", () => {
  it("keeps the first http(s) icon and reports it in tab state", async () => {
    const { service, tabId } = await serviceWithTab();
    const wc = fakes.webContentsInstances[0]!;

    wc.emit("page-favicon-updated", {}, [
      "data:image/png;base64,AAAA",
      "http://localhost:5173/favicon.ico",
    ]);

    expect(service.getStatus().tabs.find((tab) => tab.id === tabId)?.faviconUrl)
      .toBe("http://localhost:5173/favicon.ico");
  });

  it("accepts a small inline icon but ignores an oversized one", async () => {
    const { service } = await serviceWithTab();
    const wc = fakes.webContentsInstances[0]!;

    wc.emit("page-favicon-updated", {}, [`data:image/png;base64,${"A".repeat(64 * 1024)}`]);
    expect(service.getStatus().tabs[0]?.faviconUrl).toBeNull();

    wc.emit("page-favicon-updated", {}, ["data:image/png;base64,AAAA"]);
    expect(service.getStatus().tabs[0]?.faviconUrl).toBe("data:image/png;base64,AAAA");
  });

  it("clears the icon when the tab navigates to a different origin", async () => {
    const { service } = await serviceWithTab();
    const wc = fakes.webContentsInstances[0]!;
    wc.emit("page-favicon-updated", {}, ["http://localhost:5173/favicon.ico"]);
    expect(service.getStatus().tabs[0]?.faviconUrl).toBe("http://localhost:5173/favicon.ico");

    wc.currentUrl = "http://localhost:4000/";
    wc.emit("did-navigate", {}, "http://localhost:4000/");
    expect(service.getStatus().tabs[0]?.faviconUrl).toBeNull();

    // A same-origin navigation keeps it: the page still has that icon.
    wc.emit("page-favicon-updated", {}, ["http://localhost:4000/favicon.ico"]);
    wc.emit("did-navigate", {}, "http://localhost:4000/about");
    expect(service.getStatus().tabs[0]?.faviconUrl).toBe("http://localhost:4000/favicon.ico");
  });
});

// Regression: the owner filter hid every unclaimed tab from an identity-scoped
// read, so `ade browser status` printed 0 tabs against a pane the human could
// see full — with no tab id to claim and no `--all`, so `browser open` silently
// started another tab.
describe("built-in browser claimable tabs", () => {
  it("shows unowned tabs as claimable and still hides another chat's tabs", async () => {
    const { service } = await serviceWithTab();
    const unowned = service.getStatus().activeTabId!;

    const mineStatus = await service.createTab({ url: LOCAL_URL, activate: false, laneId: "lane-1", chatSessionId: "chat-1" });
    const mine = mineStatus.tabs.at(-1)!.id;
    const theirsStatus = await service.createTab({ url: LOCAL_URL, activate: false, laneId: "lane-2", chatSessionId: "chat-2" });
    const theirs = theirsStatus.tabs.at(-1)!.id;

    const scoped = service.getStatus({ laneId: "lane-1", chatSessionId: "chat-1" });
    const byId = new Map(scoped.tabs.map((tab) => [tab.id, tab]));
    expect([...byId.keys()].sort()).toEqual([mine, unowned].sort());
    expect(byId.get(unowned)?.claimable).toBe(true);
    expect(byId.get(mine)?.claimable).toBeUndefined();
    expect(byId.has(theirs)).toBe(false);

    // An unscoped read (the renderer) is unchanged: no `claimable` anywhere.
    expect(service.getStatus().tabs.every((tab) => tab.claimable === undefined)).toBe(true);
  });
});

describe("built-in browser dev-server auto-open", () => {
  it("opens one background tab per (lane, port) and reports it as an event", async () => {
    const registry = createDevServerRegistry();
    const collector = collectEvents();
    const service = createBuiltInBrowserService({
      onEvent: collector.onEvent,
      stateFilePath: null,
      permissionFilePath: null,
      devServers: registry,
    });
    // A Browser tool with nothing open is the only pane safe to drop a tab in.
    registry.record({ port: 5173, url: "http://localhost:5173/", laneId: "lane-1", sessionId: "sess-1" });
    await vi.waitFor(() => expect(service.getStatus().tabs).toHaveLength(1));

    expect(service.getStatus().tabs[0]?.url).toBe("http://localhost:5173/");
    // Two events by design: the launchpad chip fires first and unconditionally
    // (the claim below it can block on a human), then the enriched one once the
    // tab is actually open. Consumers key on the port, so the second refines
    // the first rather than duplicating it.
    const chips = collector.events.filter((entry) => entry.type === "dev-server-detected");
    expect(chips[0]).toMatchObject({
      type: "dev-server-detected",
      autoOpened: false,
      tabId: null,
      server: { port: 5173, source: { laneId: "lane-1", sessionId: "sess-1" } },
    });
    expect(chips.at(-1)).toMatchObject({
      type: "dev-server-detected",
      autoOpened: true,
      server: { port: 5173, source: { laneId: "lane-1", sessionId: "sess-1" } },
    });

    // A watch run that restarts the server must not open a second tab.
    registry.record({ port: 5173, url: "http://localhost:5173/", laneId: "lane-1", sessionId: "sess-2" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(service.getStatus().tabs).toHaveLength(1);
  });

  it("reports the server without opening anything when auto-open is off", async () => {
    const registry = createDevServerRegistry();
    const collector = collectEvents();
    const service = createBuiltInBrowserService({
      onEvent: collector.onEvent,
      stateFilePath: null,
      permissionFilePath: null,
      devServers: registry,
      isDevServerAutoOpenEnabled: () => false,
    });
    registry.record({ port: 3000, url: "http://localhost:3000/", laneId: "lane-2" });
    await vi.waitFor(() =>
      expect(collector.events.some((entry) => entry.type === "dev-server-detected")).toBe(true));

    expect(service.getStatus().tabs).toEqual([]);
    expect(collector.events.find((entry) => entry.type === "dev-server-detected"))
      .toMatchObject({ autoOpened: false, tabId: null });
  });

  // The detection is triggered by whatever a terminal PRINTED, and an agent
  // controls its own terminal — so an unclaimed auto-open let a printed ready
  // line navigate the shared, globally-authenticated profile with no owner and
  // no origin grant. Every auto-open now goes through a lane claim.
  it("opens the tab claimed for the detecting lane", async () => {
    const registry = createDevServerRegistry();
    const service = createBuiltInBrowserService({
      onEvent: () => {},
      stateFilePath: null,
      permissionFilePath: null,
      devServers: registry,
    });
    registry.record({ port: 5174, url: "http://localhost:5174/", laneId: "lane-owner", sessionId: "sess-1" });
    await vi.waitFor(() => expect(service.getStatus().tabs).toHaveLength(1));
    expect(service.getStatus().tabs[0]?.ownerLaneId).toBe("lane-owner");
  });

  it("only chips a detection with no lane to claim for", async () => {
    const registry = createDevServerRegistry();
    const collector = collectEvents();
    const service = createBuiltInBrowserService({
      onEvent: collector.onEvent,
      stateFilePath: null,
      permissionFilePath: null,
      devServers: registry,
    });
    registry.record({ port: 5175, url: "http://localhost:5175/", laneId: null, sessionId: "sess-1" });
    await vi.waitFor(() =>
      expect(collector.events.some((entry) => entry.type === "dev-server-detected")).toBe(true));

    expect(service.getStatus().tabs).toEqual([]);
    expect(collector.events.find((entry) => entry.type === "dev-server-detected"))
      .toMatchObject({ autoOpened: false, tabId: null });
  });

  it("exposes discovered servers to the renderer, newest first and scoped by lane", async () => {
    const registry = createDevServerRegistry();
    const service = createBuiltInBrowserService({
      onEvent: () => {},
      stateFilePath: null,
      permissionFilePath: null,
      devServers: registry,
      isDevServerAutoOpenEnabled: () => false,
    });
    registry.record({ port: 3000, url: "http://localhost:3000/", laneId: "lane-a", detectedAt: "2026-01-01T00:00:00.000Z" });
    registry.record({ port: 5173, url: "http://localhost:5173/", laneId: "lane-b", detectedAt: "2026-01-02T00:00:00.000Z" });

    expect(service.getDevServers().servers.map((server) => server.port)).toEqual([5173, 3000]);
    expect(service.getDevServers({ laneId: "lane-a" }).servers.map((server) => server.port)).toEqual([3000]);
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
    // A new search clears any live session and is then issued as a
    // continuation: Chromium never answers a new-session find on a
    // WebContentsView in Electron 41, and a cleared session still reports the
    // first match and the whole-document count.
    expect(fakes.webContentsInstances[0]?.stopFindCalls).toEqual(["clearSelection"]);
    expect(fakes.webContentsInstances[0]?.findCalls[0]).toMatchObject({
      text: "checkout",
      options: { forward: true, matchCase: true, findNext: true },
    });
    const found = collector.events.find((event) => event.type === "found-in-page");
    expect(found).toMatchObject({ type: "found-in-page", tabId, matches: 3 });

    await service.stopFindInPage({ tabId });
    expect(fakes.webContentsInstances[0]?.stopFindCalls).toEqual([
      "clearSelection",
      "clearSelection",
    ]);
  });

  it("answers a new search on an Electron build that only replies to continuations", async () => {
    // Live behaviour on Electron 41 / Chromium 146: `findInPage` with
    // `findNext: false` returns a request id and then NOTHING is ever
    // emitted, which timed the caller out after 5s on a page whose counts
    // were already correct. Only a continuation find replies.
    const { service, tabId, collector } = await serviceWithTab();
    const wc = fakes.webContentsInstances[0]!;
    wc.findInPage = ((text: string, options?: Record<string, unknown>): number => {
      wc.findCalls.push({ text, options });
      const requestId = wc.findCalls.length;
      if (options?.findNext !== true) return requestId;
      // Real Electron returns the id synchronously AND may emit before the
      // caller has stored it, so emit on the same tick.
      wc.emit("found-in-page", {}, {
        requestId,
        activeMatchOrdinal: 1,
        matches: 4,
        finalUpdate: true,
        selectionArea: {},
      });
      return requestId;
    }) as typeof wc.findInPage;

    const result = await service.findInPage({ tabId, text: "checkout", timeoutMs: 400 });
    expect(result).toMatchObject({ matches: 4, activeMatchOrdinal: 1, finalUpdate: true });
    expect(wc.stopFindCalls).toEqual(["clearSelection"]);
    expect(wc.findCalls).toHaveLength(1);
    expect(collector.events.filter((event) => event.type === "found-in-page")).toHaveLength(1);
  });

  it("keeps a caller's findNext on its own session instead of restarting it", async () => {
    const { service, tabId } = await serviceWithTab();
    const wc = fakes.webContentsInstances[0]!;
    const result = await service.findInPage({ tabId, text: "checkout", findNext: true });
    expect(result).toMatchObject({ matches: 3 });
    // No clear: restarting the session would send the user back to match 1.
    expect(wc.stopFindCalls).toEqual([]);
    expect(wc.findCalls[0]?.options).toMatchObject({ findNext: true });
  });

  it("requires search text", async () => {
    const { service, tabId } = await serviceWithTab();
    await expect(service.findInPage({ tabId, text: "  " })).rejects.toThrow(/Find text is required/);
  });

  it("resolves on the first incremental result instead of waiting for finalUpdate", async () => {
    const { service, tabId, collector } = await serviceWithTab();
    const wc = fakes.webContentsInstances[0]!;
    // Chromium only sends `finalUpdate` once the whole document is walked, and
    // for a find superseded by the next keystroke it never sends one at all.
    // The old waiter timed out here while the counts were already on screen.
    wc.findInPage = ((text: string, options?: Record<string, unknown>): number => {
      wc.findCalls.push({ text, options });
      const requestId = wc.findCalls.length;
      setTimeout(() => {
        wc.emit("found-in-page", {}, {
          requestId,
          activeMatchOrdinal: 2,
          matches: 7,
          finalUpdate: false,
          selectionArea: {},
        });
      }, 0);
      return requestId;
    }) as typeof wc.findInPage;

    const result = await service.findInPage({ tabId, text: "checkout", timeoutMs: 250 });
    expect(result).toMatchObject({ matches: 7, activeMatchOrdinal: 2, finalUpdate: false });
    // Later updates keep streaming as events rather than being swallowed.
    wc.emit("found-in-page", {}, {
      requestId: 1,
      activeMatchOrdinal: 2,
      matches: 9,
      finalUpdate: true,
      selectionArea: {},
    });
    const streamed = collector.events.filter((event) => event.type === "found-in-page");
    expect(streamed.at(-1)).toMatchObject({ tabId, matches: 9, finalUpdate: true });
  });

  it("resolves when the result is emitted synchronously from findInPage", async () => {
    const { service, tabId } = await serviceWithTab();
    const wc = fakes.webContentsInstances[0]!;
    wc.findInPage = ((text: string, options?: Record<string, unknown>): number => {
      wc.findCalls.push({ text, options });
      // Emitted before the request id has been returned: the waiter has to
      // buffer this rather than discard it.
      wc.emit("found-in-page", {}, {
        requestId: 1,
        activeMatchOrdinal: 1,
        matches: 4,
        finalUpdate: false,
        selectionArea: {},
      });
      return 1;
    }) as typeof wc.findInPage;

    await expect(service.findInPage({ tabId, text: "checkout", timeoutMs: 250 }))
      .resolves.toMatchObject({ matches: 4, activeMatchOrdinal: 1 });
  });

  it("times out only when no result ever arrived", async () => {
    const { service, tabId } = await serviceWithTab();
    const wc = fakes.webContentsInstances[0]!;
    wc.findInPage = ((text: string, options?: Record<string, unknown>): number => {
      wc.findCalls.push({ text, options });
      return 1;
    }) as typeof wc.findInPage;

    await expect(service.findInPage({ tabId, text: "checkout", timeoutMs: 250 }))
      .rejects.toThrow(/Timed out waiting for browser find results/);
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

  // Regression: the log stored request URLs verbatim, so an IdP callback wrote
  // the authorization code into getNetworkLog and into the exported HAR.
  it("redacts credential query parameters in the recorded URL", async () => {
    const { service, tabId } = await serviceWithTab();
    await service.setNetworkLogging({ tabId, enabled: true });
    fakes.webContentsInstances[0]!.debugger.emit("message", {}, "Network.requestWillBeSent", {
      requestId: "req-oauth",
      type: "Document",
      request: {
        method: "GET",
        url: "http://localhost:5173/auth/callback?code=authz-code-123&state=nonce-abc&next=/home",
        headers: {},
      },
    });
    const entry = (await service.getNetworkLog({ tabId })).entries[0]!;
    expect(entry.url).not.toContain("authz-code-123");
    expect(entry.url).not.toContain("nonce-abc");
    expect(entry.url).toContain("next=%2Fhome");
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

// One tracing idiom for the whole capability surface. Before this the split was
// arbitrary — setEmulation traced and setZoom did not, findInPage traced and
// stopFindInPage did not — and the hand-traced ones landed entries with
// `sessionId: null` that never moved `session.lastTraceEntryId`, so `ade browser
// proof` and the corner card disagreed about where a session got to.
describe("built-in browser capability tracing", () => {
  it("traces every tab capability against the session and advances its cursor", async () => {
    const { service, tabId } = await serviceWithTab();
    const started = service.startSession({ tabId });
    const sessionId = started.session!.id;
    const target = { tabId, sessionId };

    await service.setEmulation({ ...target, preset: "off" });
    await service.setZoom({ ...target, factor: 1.5 });
    await service.findInPage({ ...target, text: "hello" }).catch(() => {});
    await service.stopFindInPage(target);
    await service.setNetworkLogging({ ...target, enabled: true });
    await service.setDevTools({ ...target, open: false });
    await service.exportHar(target);
    await service.setNetworkLogging({ ...target, enabled: false });

    const entries = service.getTrace(target).entries;
    expect(entries.map((entry) => entry.action)).toEqual([
      "setEmulation",
      "setZoom",
      "findInPage",
      "stopFindInPage",
      "setNetworkLogging",
      "setDevTools",
      "exportHar",
      "setNetworkLogging",
    ]);
    expect(entries.every((entry) => entry.sessionId === sessionId)).toBe(true);
    const sessions = service.listSessions({ tabId }).sessions;
    expect(sessions.find((entry) => entry.id === sessionId)?.lastTraceEntryId)
      .toBe(entries.at(-1)?.id);
  });

  // A pure read of a buffer the caller already owns must not pad the trace.
  it("leaves no trace entry for getNetworkLog", async () => {
    const { service, tabId } = await serviceWithTab();
    await service.setNetworkLogging({ tabId, enabled: true });
    const before = service.getTrace({ tabId }).entries.length;
    await service.getNetworkLog({ tabId });
    expect(service.getTrace({ tabId }).entries).toHaveLength(before);
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

  // Blocker regression: a handoff suspended ownership but not the agent's own
  // capture surfaces, so the human's sign-in was recorded and the IdP callback
  // (authorization code and all) stayed in the network log the agent read back.
  it("stops recording and network logging when a login handoff starts", async () => {
    const calls: string[] = [];
    const { service, tabId, collector } = await serviceWithTab({
      createTabRecorder: stubRecorderFactory(calls),
    });
    service.claim({ tabId, laneId: "lane-1", chatSessionId: "chat-1" });
    await service.setNetworkLogging({ tabId, enabled: true });
    fakes.webContentsInstances[0]!.debugger.emit("message", {}, "Network.requestWillBeSent", {
      requestId: "req-before",
      request: { method: "GET", url: "http://localhost:5173/before", headers: {} },
    });
    await service.startRecording({ tabId });

    service.startHandoff({ tabId, laneId: "lane-1", chatSessionId: "chat-1", reason: "sign in to Okta" });

    expect(calls).toEqual(["start", "abort"]);
    const tab = service.getStatus().tabs.find((entry) => entry.id === tabId)!;
    expect(tab.recording).toBeNull();
    expect(tab.networkLogging).toBe(false);
    expect(collector.events.some((event) =>
      event.type === "recording" && event.recording === null && event.endedBy === "handoff")).toBe(true);

    // Anything the human's sign-in does after this point must not be captured,
    // and the buffered log is dropped rather than handed back on return.
    fakes.webContentsInstances[0]!.debugger.emit("message", {}, "Network.requestWillBeSent", {
      requestId: "req-during-handoff",
      request: { method: "GET", url: "http://localhost:5173/callback?code=secret", headers: {} },
    });
    service.endHandoff({ tabId });

    const log = await service.getNetworkLog({ tabId, laneId: "lane-1", chatSessionId: "chat-1" });
    expect(log.enabled).toBe(false);
    expect(log.recordedCount).toBe(0);
    // Nothing re-arms on hand-back: the agent has to ask again.
    await expect(service.stopRecording({ tabId, laneId: "lane-1", chatSessionId: "chat-1" }))
      .rejects.toThrow(/is not recording/);
  });

  it("rejects an unsupported frame rate", async () => {
    const { service, tabId } = await serviceWithTab({ createTabRecorder: stubRecorderFactory() });
    await expect(service.startRecording({ tabId, fps: 24 })).rejects.toThrow(/must be 30 or 60/);
  });
});

/**
 * Stand-in for the `found-in-page` half of a `WebContents`. `findInPage`
 * returns ids from a queue and can emit synchronously — the race the waiter
 * exists to survive.
 */
function fakeFindWebContents(options: {
  ids?: number[];
  emitOnFind?: (emit: (result: Record<string, unknown>) => void, requestId: number) => void;
} = {}) {
  const emitter = new EventEmitter();
  const ids = [...(options.ids ?? [1])];
  const stopCalls: string[] = [];
  const findCalls: Array<{ text: string; findNext?: boolean; forward?: boolean; matchCase?: boolean }> = [];
  const emit = (result: Record<string, unknown>): void => {
    emitter.emit("found-in-page", {}, result);
  };
  const wc = {
    on: (event: string, fn: (...a: unknown[]) => void) => emitter.on(event, fn),
    removeListener: (event: string, fn: (...a: unknown[]) => void) => emitter.removeListener(event, fn),
    stopFindInPage: (action: string) => {
      stopCalls.push(action);
    },
    findInPage: (text: string, opts: Record<string, unknown>) => {
      const id = ids.shift() ?? 1;
      findCalls.push({ text, ...opts });
      options.emitOnFind?.(emit, id);
      return id;
    },
    listenerCount: (event: string) => emitter.listenerCount(event),
  };
  return { wc: wc as unknown as WebContents, emit, stopCalls, findCalls, raw: wc };
}

const findWaiters = (): BuiltInBrowserFindWaiters => new Set<(requestId: number) => void>();

const findArgs = (over: Partial<Parameters<typeof awaitFoundInPage>[2]> = {}) => ({
  text: "hello",
  forward: true,
  matchCase: false,
  findNext: false,
  timeoutMs: 1_000,
  ...over,
});

describe("built-in browser find waiter (awaitFoundInPage)", () => {
  it("resolves on the first result for its own request and drops other ids", async () => {
    const { wc, emit } = fakeFindWebContents({ ids: [7] });
    const pending = awaitFoundInPage(wc, findWaiters(), findArgs());
    emit({ requestId: 6, matches: 99, activeMatchOrdinal: 1 });
    emit({ requestId: 7, matches: 3, activeMatchOrdinal: 1, finalUpdate: false });
    await expect(pending).resolves.toMatchObject({ requestId: 7, matches: 3 });
  });

  // Chromium can emit synchronously from inside `findInPage`, before the caller
  // has an id to compare against.
  it("replays a result that arrived before the request id was known", async () => {
    const { wc } = fakeFindWebContents({
      ids: [11],
      emitOnFind: (emit) => emit({ requestId: 11, matches: 2, activeMatchOrdinal: 1 }),
    });
    await expect(awaitFoundInPage(wc, findWaiters(), findArgs()))
      .resolves.toMatchObject({ requestId: 11, matches: 2 });
  });

  // A find under 4 characters is delayed 400ms and the NEXT find resets the
  // delayed task, discarding the earlier id. The in-flight waiter follows.
  it("adopts the request id of a find that supersedes it", async () => {
    const shared = findWaiters();
    const { wc, emit } = fakeFindWebContents({ ids: [1, 2] });
    const first = awaitFoundInPage(wc, shared, findArgs({ text: "ab" }));
    const second = awaitFoundInPage(wc, shared, findArgs({ text: "abc" }));
    emit({ requestId: 2, matches: 5, activeMatchOrdinal: 1 });
    await expect(first).resolves.toMatchObject({ requestId: 2, matches: 5 });
    await expect(second).resolves.toMatchObject({ requestId: 2, matches: 5 });
  });

  it("clears the selection for a new search and keeps it for find-next", async () => {
    const fresh = fakeFindWebContents({ ids: [1], emitOnFind: (emit, id) => emit({ requestId: id, matches: 1 }) });
    await awaitFoundInPage(fresh.wc, findWaiters(), findArgs({ findNext: false }));
    expect(fresh.stopCalls).toEqual(["clearSelection"]);

    const next = fakeFindWebContents({ ids: [1], emitOnFind: (emit, id) => emit({ requestId: id, matches: 1 }) });
    await awaitFoundInPage(next.wc, findWaiters(), findArgs({ findNext: true }));
    expect(next.stopCalls).toEqual([]);
    // Every find we issue starts a Chromium session; `findNext` selects whether
    // the selection was cleared first, not what is sent.
    expect(next.findCalls[0]).toMatchObject({ findNext: true, forward: true, matchCase: false });
  });

  it("returns the last result it saw rather than a timeout error", async () => {
    vi.useFakeTimers();
    try {
      const { wc, emit } = fakeFindWebContents({ ids: [4] });
      const pending = awaitFoundInPage(wc, findWaiters(), findArgs({ timeoutMs: 500 }));
      emit({ requestId: 4, matches: 8, activeMatchOrdinal: 2, finalUpdate: false });
      await expect(pending).resolves.toMatchObject({ matches: 8 });

      const silent = fakeFindWebContents({ ids: [5] });
      const timingOut = awaitFoundInPage(silent.wc, findWaiters(), findArgs({ timeoutMs: 500 }));
      const assertion = expect(timingOut).rejects.toThrow(/Timed out waiting for browser find results/);
      await vi.advanceTimersByTimeAsync(500);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("detaches its listener however it settles", async () => {
    const settled = fakeFindWebContents({ ids: [1], emitOnFind: (emit, id) => emit({ requestId: id, matches: 1 }) });
    await awaitFoundInPage(settled.wc, findWaiters(), findArgs());
    expect(settled.raw.listenerCount("found-in-page")).toBe(0);

    const throwing = fakeFindWebContents({ ids: [1] });
    throwing.raw.findInPage = () => {
      throw new Error("tab is gone");
    };
    await expect(awaitFoundInPage(throwing.wc, findWaiters(), findArgs())).rejects.toThrow(/tab is gone/);
    expect(throwing.raw.listenerCount("found-in-page")).toBe(0);
  });
});
