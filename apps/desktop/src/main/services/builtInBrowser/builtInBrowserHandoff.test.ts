import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BuiltInBrowserEventPayload } from "../../../shared/types";
import {
  createBuiltInBrowserService,
  type BuiltInBrowserHandoffLifecycleEvent,
} from "./builtInBrowserService";
import { BUILT_IN_BROWSER_HANDOFF_ACTIVE_CODE } from "../../../shared/types/builtInBrowser";

/**
 * Login handoff — the one state where the built-in browser is deliberately the
 * human's and not the agent's.
 *
 * These tests pin the properties that make that safe rather than the wording of
 * the bar: the lease is suspended and restored to the SAME owner, agent traffic
 * is refused with a typed code while the person is signing in, the person's own
 * navigation is not, and every way a handoff can end closes it exactly once.
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

const LOCAL_URL = "https://login.example.test/";

function collectEvents(): {
  events: BuiltInBrowserEventPayload[];
  onEvent: (payload: BuiltInBrowserEventPayload) => void;
} {
  const events: BuiltInBrowserEventPayload[] = [];
  return { events, onEvent: (payload) => void events.push(payload) };
}

async function serviceWithOwnedTab(
  overrides: Parameters<typeof createBuiltInBrowserService>[0] = {},
) {
  const collector = collectEvents();
  const lifecycle: BuiltInBrowserHandoffLifecycleEvent[] = [];
  const service = createBuiltInBrowserService({
    onEvent: collector.onEvent,
    stateFilePath: null,
    permissionFilePath: null,
    onHandoff: (event) => void lifecycle.push(event),
    ...overrides,
  });
  const status = await service.createTab({
    url: LOCAL_URL,
    activate: true,
    laneId: "lane-1",
    chatSessionId: "chat-1",
  });
  const tabId = status.activeTabId!;
  return { service, tabId, collector, lifecycle };
}

function tabOf(service: ReturnType<typeof createBuiltInBrowserService>, tabId: string) {
  return service.getStatus().tabs.find((tab) => tab.id === tabId) ?? null;
}

beforeEach(() => {
  fakes.reset();
  fakes.setUserDataPath("/tmp");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("built-in browser login handoff — ownership flip", () => {
  it("suspends the agent lease, records the previous owner, and reveals the pane", async () => {
    const { service, tabId, collector, lifecycle } = await serviceWithOwnedTab();
    expect(tabOf(service, tabId)?.ownerChatSessionId).toBe("chat-1");

    const result = service.startHandoff({
      tabId,
      laneId: "lane-1",
      chatSessionId: "chat-1",
      reason: "sign in to staging",
    });

    expect(result.handoff).toMatchObject({
      reason: "sign in to staging",
      requestedByChatSessionId: "chat-1",
      startedAtOrigin: "https://login.example.test",
      previousOwner: { laneId: "lane-1", chatSessionId: "chat-1" },
    });
    const tab = tabOf(service, tabId);
    expect(tab?.handoff?.reason).toBe("sign in to staging");
    // The lease is suspended, not reassigned: nothing may claim it meanwhile.
    expect(tab?.ownerChatSessionId).toBeNull();
    expect(tab?.ownerLaneId).toBeNull();
    expect(tab?.ownerLeaseExpiresAt).toBeNull();

    expect(collector.events.some((event) => event.type === "handoff-started")).toBe(true);
    expect(collector.events.some((event) => event.type === "open-request")).toBe(true);
    expect(lifecycle.map((event) => event.kind)).toEqual(["started"]);
  });

  it("restores the same lease with a fresh TTL on hand back", async () => {
    const { service, tabId, collector, lifecycle } = await serviceWithOwnedTab();
    service.startHandoff({ tabId, laneId: "lane-1", chatSessionId: "chat-1", reason: "sign in" });

    const ended = service.endHandoff({ tabId });

    expect(ended.handoff?.reason).toBe("sign in");
    const tab = tabOf(service, tabId);
    expect(tab?.handoff).toBeNull();
    expect(tab?.ownerLaneId).toBe("lane-1");
    expect(tab?.ownerChatSessionId).toBe("chat-1");
    expect(Date.parse(tab!.ownerLeaseExpiresAt!)).toBeGreaterThan(Date.now());
    const endedEvent = collector.events.find((event) => event.type === "handoff-ended");
    expect(endedEvent).toMatchObject({ endedBy: "human" });
    expect(lifecycle.map((event) => event.kind)).toEqual(["started", "ended"]);
  });

  it("requires a reason so the person is never asked to sign in to nothing", async () => {
    const { service, tabId } = await serviceWithOwnedTab();
    expect(() => service.startHandoff({ tabId, chatSessionId: "chat-1", reason: "   " }))
      .toThrow(/--reason/);
  });
});

describe("built-in browser login handoff — agent access", () => {
  it("refuses agent actions on the handed-off tab with a typed code", async () => {
    const { service, tabId } = await serviceWithOwnedTab();
    service.startHandoff({ tabId, laneId: "lane-1", chatSessionId: "chat-1", reason: "sign in" });

    await expect(
      service.reload({ tabId, laneId: "lane-1", chatSessionId: "chat-1" }),
    ).rejects.toThrow(new RegExp(BUILT_IN_BROWSER_HANDOFF_ACTIVE_CODE));
    await expect(
      service.navigate({ tabId, url: "https://elsewhere.test/", chatSessionId: "chat-1" }),
    ).rejects.toThrow(new RegExp(BUILT_IN_BROWSER_HANDOFF_ACTIVE_CODE));
  });

  it("still lets the agent read status so it can tell when the handoff ended", async () => {
    const { service, tabId } = await serviceWithOwnedTab();
    service.startHandoff({ tabId, laneId: "lane-1", chatSessionId: "chat-1", reason: "sign in" });

    const status = service.getStatus({ tabId, laneId: "lane-1", chatSessionId: "chat-1" });
    expect(status.tabs.find((tab) => tab.id === tabId)?.handoff?.reason).toBe("sign in");
    // Reading must not quietly re-issue the lease the handoff suspended.
    expect(tabOf(service, tabId)?.ownerChatSessionId).toBeNull();
  });

  it("refuses a different agent's claim, force included", async () => {
    const { service, tabId } = await serviceWithOwnedTab();
    service.startHandoff({ tabId, laneId: "lane-1", chatSessionId: "chat-1", reason: "sign in" });

    expect(() => service.claim({ tabId, laneId: "lane-2", chatSessionId: "chat-2", force: true }))
      .toThrow(new RegExp(BUILT_IN_BROWSER_HANDOFF_ACTIVE_CODE));
  });

  it("leaves the human's own navigation alone", async () => {
    const { service, tabId } = await serviceWithOwnedTab();
    service.startHandoff({ tabId, laneId: "lane-1", chatSessionId: "chat-1", reason: "sign in" });

    const status = await service.navigate({ tabId, url: "https://idp.example.test/mfa" });
    expect(status.url).toBe("https://idp.example.test/mfa");
    expect(tabOf(service, tabId)?.handoff?.reason).toBe("sign in");
  });
});

describe("built-in browser login handoff — endings", () => {
  it("ends the handoff when the tab closes", async () => {
    const { service, tabId, collector, lifecycle } = await serviceWithOwnedTab();
    service.startHandoff({ tabId, laneId: "lane-1", chatSessionId: "chat-1", reason: "sign in" });

    await service.closeTab({ tabId });

    expect(collector.events.find((event) => event.type === "handoff-ended")).toMatchObject({
      endedBy: "tab-closed",
    });
    expect(lifecycle.at(-1)).toMatchObject({ kind: "ended", endedBy: "tab-closed" });
  });

  it("hands the tab back on its own when nobody signs in before the timeout", async () => {
    vi.useFakeTimers();
    const { service, tabId, collector } = await serviceWithOwnedTab();
    service.startHandoff({
      tabId,
      laneId: "lane-1",
      chatSessionId: "chat-1",
      reason: "sign in",
      timeoutMs: 60_000,
    });

    await vi.advanceTimersByTimeAsync(61_000);

    expect(collector.events.find((event) => event.type === "handoff-ended")).toMatchObject({
      endedBy: "timeout",
    });
    const tab = tabOf(service, tabId);
    expect(tab?.handoff).toBeNull();
    expect(tab?.ownerChatSessionId).toBe("chat-1");
  });

  it("unblocks waitForHandoff with the outcome", async () => {
    const { service, tabId } = await serviceWithOwnedTab();
    service.startHandoff({ tabId, laneId: "lane-1", chatSessionId: "chat-1", reason: "sign in" });

    const waiting = service.waitForHandoff({ tabId, chatSessionId: "chat-1" });
    service.endHandoff({ tabId, endedBy: "auto-offer" });

    await expect(waiting).resolves.toMatchObject({ ended: true, endedBy: "auto-offer" });
    // A wait with nothing open returns immediately rather than hanging.
    await expect(service.waitForHandoff({ tabId, chatSessionId: "chat-1" }))
      .resolves.toMatchObject({ ended: true, endedBy: null });
  });
});

describe("built-in browser login handoff — trace", () => {
  it("writes start and end entries that explain the gap", async () => {
    const { service, tabId } = await serviceWithOwnedTab();
    service.startHandoff({ tabId, laneId: "lane-1", chatSessionId: "chat-1", reason: "sign in to staging" });
    service.endHandoff({ tabId });

    const entries = service.getTrace({ tabId }).entries;
    const start = entries.find((entry) => entry.action === "handoff-start");
    const end = entries.find((entry) => entry.action === "handoff-end");
    expect(start?.target).toMatchObject({ reason: "sign in to staging" });
    expect(end?.target).toMatchObject({ endedBy: "human" });
    expect(typeof end?.target?.durationMs).toBe("number");
  });
});
