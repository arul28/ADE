import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BuiltInBrowserEventPayload } from "../../../shared/types";
import { createBuiltInBrowserService } from "./builtInBrowserService";

const fakes = vi.hoisted(() => {
  type DebuggerHandler = (...args: unknown[]) => void;

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
    loadURL = async (_url: string): Promise<void> => undefined;
    reload = (): void => undefined;
    goBack = (): void => undefined;
    goForward = (): void => undefined;
    stop = (): void => undefined;
    isLoading = (): boolean => false;
    canGoBack = (): boolean => false;
    canGoForward = (): boolean => false;
    isDestroyed = (): boolean => false;
    getURL = (): string => "";
    getTitle = (): string => "";
    setAudioMuted = (_muted: boolean): void => undefined;
    setWindowOpenHandler = (_handler: unknown): void => undefined;
    on = (_event: string, _fn: (...args: unknown[]) => void): void => undefined;
  }

  class FakeWebContentsView {
    webContents = new FakeWebContents();
    setBackgroundColor = (_color: string): void => undefined;
    setBounds = (_rect: unknown): void => undefined;
    setVisible = (_visible: boolean): void => undefined;
  }

  // Track the most recently constructed FakeDebugger so tests can wire sendCommand impls.
  const debuggerInstances: FakeDebugger[] = [];
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
    setSendCommand: (impl: (method: string, params?: Record<string, unknown>) => Promise<unknown>) => {
      activeImpl = impl;
    },
    resetSendCommand: () => {
      activeImpl = async () => ({});
    },
    clearDebuggerInstances: () => {
      debuggerInstances.length = 0;
    },
  };
});

vi.mock("electron", () => ({
  WebContentsView: fakes.WebContentsView,
  nativeImage: { createFromDataURL: () => ({ getSize: () => ({ width: 0, height: 0 }) }) },
  session: { fromPartition: () => ({ setPermissionCheckHandler: () => {}, setPermissionRequestHandler: () => {} }) },
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

describe("createBuiltInBrowserService — bounds and status dedupe", () => {
  let collector: ReturnType<typeof captureStatusEvents>;

  beforeEach(() => {
    collector = captureStatusEvents();
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
});

describe("createBuiltInBrowserService — switchTab and navigate inspect/selection invariants", () => {
  let collector: ReturnType<typeof captureStatusEvents>;

  beforeEach(() => {
    collector = captureStatusEvents();
    fakes.resetSendCommand();
    fakes.clearDebuggerInstances();
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
