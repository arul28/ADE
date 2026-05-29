/* @vitest-environment jsdom */

import React from "react";
import { act, render, cleanup, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const MOCK_TERMINAL_FONT_FAMILY = vi.hoisted(() => "monospace");

const mockState = vi.hoisted(() => ({
  terminalInstances: [] as Array<Record<string, unknown>>,
  nextFitDims: { cols: 120, rows: 40 },
  shouldThrowWebglAddon: false,
  lastContextLossHandler: null as (() => void) | null,
  ptyDataListeners: new Set<(event: { ptyId: string; sessionId?: string; projectRoot?: string; data: string }) => void>(),
  ptyExitListeners: new Set<(event: { ptyId: string; sessionId?: string; projectRoot?: string; exitCode: number | null }) => void>(),
  projectRoot: "/project/a",
  projectRevision: 0,
  theme: "dark" as const,
  terminalPreferences: {
    fontFamily: "monospace",
    fontSize: 12.5,
    lineHeight: 1.25,
    scrollback: 10_000,
  },
}));

const resizeObservers: MockResizeObserver[] = [];

class MockResizeObserver {
  callback: ResizeObserverCallback;
  observe = vi.fn();
  disconnect = vi.fn();

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    resizeObservers.push(this);
  }
}

class MockIntersectionObserver {
  observe = vi.fn();
  disconnect = vi.fn();

  constructor(_callback: IntersectionObserverCallback) {}
}

vi.mock("../../state/appStore", () => ({
  useAppStore: vi.fn((selector: (state: {
    theme: "dark";
    terminalPreferences: {
      fontFamily: string;
      fontSize: number;
      lineHeight: number;
      scrollback: number;
    };
    project: { rootPath: string; name: string } | null;
    projectRevision: number;
  }) => unknown) => selector({
    theme: mockState.theme,
    terminalPreferences: mockState.terminalPreferences,
    project: mockState.projectRoot
      ? { rootPath: mockState.projectRoot, name: "Project" }
      : null,
    projectRevision: mockState.projectRevision,
  })),
  DEFAULT_TERMINAL_FONT_FAMILY: MOCK_TERMINAL_FONT_FAMILY,
  DEFAULT_TERMINAL_PREFERENCES: {
    fontFamily: MOCK_TERMINAL_FONT_FAMILY,
    fontSize: 12.5,
    lineHeight: 1.25,
    scrollback: 10_000,
  },
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class MockTerminal {
    cols = 80;
    rows = 24;
    element: HTMLElement | null = null;
    options: Record<string, unknown>;
    focus = vi.fn();
    blur = vi.fn();
    write = vi.fn();
    refresh = vi.fn();
    scrollLines = vi.fn();
    resize = vi.fn((cols: number, rows: number) => {
      this.cols = cols;
      this.rows = rows;
    });
    scrollToBottom = vi.fn();
    buffer = {
      active: {
        baseY: 0,
        viewportY: 0,
      },
    };
    dispose = vi.fn();
    clearTextureAtlas = vi.fn();
    getSelection = vi.fn(() => "");
    attachCustomKeyEventHandler = vi.fn();
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    loadAddon = vi.fn((addon: { activate?: (term: unknown) => void }) => {
      addon.activate?.(this);
    });

    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
      mockState.terminalInstances.push(this as unknown as Record<string, unknown>);
    }

    open(host: HTMLElement) {
      this.element = host;
    }
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class MockFitAddon {
    private terminal: { cols: number; rows: number } | null = null;

    activate(term: { cols: number; rows: number }) {
      this.terminal = term;
    }

    fit() {
      if (!this.terminal) throw new Error("fit called before activate");
      this.terminal.cols = mockState.nextFitDims.cols;
      this.terminal.rows = mockState.nextFitDims.rows;
    }
  },
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class MockWebglAddon {
    dispose = vi.fn();

    constructor() {
      if (mockState.shouldThrowWebglAddon) {
        throw new Error("webgl unavailable");
      }
    }

    onContextLoss(cb: () => void) {
      mockState.lastContextLossHandler = cb;
    }
  },
}));

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

import {
  TerminalView,
  __resetTerminalRuntimesForTests,
  disposeTerminalRuntimesForProjectChange,
  getTerminalRuntimeSnapshot,
  stripFullScreenRedrawSequences,
} from "./TerminalView";
import { WORK_SURFACE_REVEALED_EVENT } from "./workSurfaceVisibility";

function installWindowAde() {
  (window as any).ade = {
    app: {
      hasClipboardImage: vi.fn().mockResolvedValue(false),
    },
    pty: {
      resize: vi.fn().mockResolvedValue(undefined),
      write: vi.fn().mockResolvedValue(undefined),
      onData: vi.fn((listener: (event: { ptyId: string; sessionId?: string; projectRoot?: string; data: string }) => void) => {
        mockState.ptyDataListeners.add(listener);
        return () => {
          mockState.ptyDataListeners.delete(listener);
        };
      }),
      onExit: vi.fn((listener: (event: { ptyId: string; sessionId?: string; projectRoot?: string; exitCode: number | null }) => void) => {
        mockState.ptyExitListeners.add(listener);
        return () => {
          mockState.ptyExitListeners.delete(listener);
        };
      }),
    },
    sessions: {
      readTranscriptTail: vi.fn().mockResolvedValue(""),
      get: vi.fn().mockResolvedValue(null),
    },
    terminal: {
      preview: vi.fn().mockResolvedValue({
        terminalId: "session",
        session: null,
        source: "empty",
        snapshot: null,
        transcript: null,
        capturedAt: new Date().toISOString(),
      }),
      read: vi.fn().mockResolvedValue({
        terminalId: "session",
        data: "",
        nextSince: 0,
      }),
    },
  };
}

async function flushAllTimers() {
  await act(async () => {
    await vi.runAllTimersAsync();
  });
}

async function flushAnimationFrame() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
  });
}

function createPasteEvent(text: string): Event {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    configurable: true,
    value: {
      files: [],
      items: [],
      getData: vi.fn((type: string) => (
        type === "text/plain" || type === "text" ? text : ""
      )),
    },
  });
  return event;
}

function triggerResizeObserver() {
  const latest = resizeObservers.at(-1);
  if (!latest) throw new Error("ResizeObserver not installed");
  latest.callback([], latest as unknown as ResizeObserver);
}

function terminalWidthFor(element: HTMLElement): number {
  if (element.getAttribute("data-ade-terminal-parking") === "true") return 0;
  if (element.classList.contains("ade-terminal-host")) return 640;
  if (element.parentElement?.classList.contains("ade-terminal-host")) return 640;
  return 320;
}

function terminalHeightFor(element: HTMLElement): number {
  if (element.getAttribute("data-ade-terminal-parking") === "true") return 0;
  if (element.classList.contains("ade-terminal-host")) return 360;
  if (element.parentElement?.classList.contains("ade-terminal-host")) return 360;
  return 180;
}

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", MockResizeObserver);
  vi.stubGlobal("IntersectionObserver", MockIntersectionObserver);
  // xterm WebGL path needs a getContext("webgl") that succeeds in jsdom / headless CI.
  vi.stubGlobal(
    "HTMLCanvasElement",
    class extends (globalThis as any).HTMLCanvasElement {
      getContext(contextId: string) {
        if (contextId === "webgl" || contextId === "webgl2") {
          return {
            getParameter: () => 0,
            getExtension: () => null,
            isContextLost: () => false,
          };
        }
        return super.getContext(contextId as "2d");
      }
    },
  );
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(performance.now()), 0));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    matches: false,
    media: "",
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })));
  vi.stubGlobal("visualViewport", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });

  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get() {
      return terminalWidthFor(this);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      return terminalHeightFor(this);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get() {
      return terminalWidthFor(this);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      return terminalHeightFor(this);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value() {
      const width = terminalWidthFor(this as HTMLElement);
      const height = terminalHeightFor(this as HTMLElement);
      return {
        width,
        height,
        top: 0,
        left: 0,
        right: width,
        bottom: height,
        x: 0,
        y: 0,
        toJSON() {
          return {};
        },
      };
    },
  });
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("TerminalView", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    cleanup();
    installWindowAde();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    resizeObservers.length = 0;
    mockState.terminalInstances.length = 0;
    mockState.nextFitDims = { cols: 120, rows: 40 };
    mockState.shouldThrowWebglAddon = false;
    mockState.lastContextLossHandler = null;
    mockState.ptyDataListeners.clear();
    mockState.ptyExitListeners.clear();
    mockState.projectRoot = "/project/a";
    mockState.projectRevision = 0;
    mockState.theme = "dark";
    mockState.terminalPreferences = {
      fontFamily: MOCK_TERMINAL_FONT_FAMILY,
      fontSize: 12.5,
      lineHeight: 1.25,
      scrollback: 10_000,
    };
    window.localStorage.removeItem("ade.terminalRenderer");
  });

  afterEach(() => {
    cleanup();
    __resetTerminalRuntimesForTests();
    delete (window as any).ade;
    vi.useRealTimers();
  });

  it("fits to the container and resizes the PTY when the fit result is valid", async () => {
    vi.useRealTimers();
    try {
      window.localStorage.setItem("ade.terminalRenderer", "webgl");
      render(<TerminalView ptyId="pty-valid" sessionId="session-valid" isActive />);

      await waitFor(
        () => {
          const runtime = getTerminalRuntimeSnapshot("session-valid");
          expect(runtime?.renderer).toBe("webgl");
          expect(runtime?.health.fitRecoveries).toBe(0);
          expect((window as any).ade.pty.resize).toHaveBeenCalledWith({
            ptyId: "pty-valid",
            cols: 120,
            rows: 40,
          });
        },
        { timeout: 10_000 },
      );
    } finally {
      vi.useFakeTimers();
    }
  });

  it("uses the DOM renderer when explicitly opted out", async () => {
    vi.useRealTimers();
    try {
      window.localStorage.setItem("ade.terminalRenderer", "dom");
      render(<TerminalView ptyId="pty-dom-opt-out" sessionId="session-dom-opt-out" isActive />);

      await waitFor(
        () => {
          const runtime = getTerminalRuntimeSnapshot("session-dom-opt-out");
          expect(runtime?.renderer).toBe("dom");
        },
        { timeout: 10_000 },
      );
    } finally {
      vi.useFakeTimers();
    }
  });

  it("shares PTY event subscriptions across terminal runtimes", async () => {
    render(
      <>
        <TerminalView ptyId="pty-shared-a" sessionId="session-shared-a" isActive />
        <TerminalView ptyId="pty-shared-b" sessionId="session-shared-b" isActive />
      </>,
    );

    await flushAnimationFrame();

    expect((window as any).ade.pty.onData).toHaveBeenCalledTimes(1);
    expect((window as any).ade.pty.onExit).toHaveBeenCalledTimes(1);
    expect(mockState.ptyDataListeners.size).toBe(1);
    expect(mockState.ptyExitListeners.size).toBe(1);
  });

  it("uses the DOM renderer on Linux when localStorage is unavailable", async () => {
    vi.useRealTimers();
    const platformDescriptor = Object.getOwnPropertyDescriptor(window.navigator, "platform");
    const originalPlatform = window.navigator.platform;
    const getItemSpy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    try {
      Object.defineProperty(window.navigator, "platform", {
        configurable: true,
        value: "Linux x86_64",
      });
      render(<TerminalView ptyId="pty-linux-storage" sessionId="session-linux-storage" isActive />);

      await waitFor(
        () => {
          const runtime = getTerminalRuntimeSnapshot("session-linux-storage");
          expect(runtime?.renderer).toBe("dom");
        },
        { timeout: 10_000 },
      );
    } finally {
      getItemSpy.mockRestore();
      if (platformDescriptor) {
        Object.defineProperty(window.navigator, "platform", platformDescriptor);
      } else {
        Object.defineProperty(window.navigator, "platform", {
          configurable: true,
          value: originalPlatform,
        });
      }
      vi.useFakeTimers();
    }
  });

  it("rejects implausible fit results, restores the last good size, and skips PTY resize", async () => {
    render(<TerminalView ptyId="pty-recover" sessionId="session-recover" isActive />);
    await flushAllTimers();

    const resizeSpy = (window as any).ade.pty.resize as { mock: { calls: unknown[][] } };
    const resizeCallCount = resizeSpy.mock.calls.length;
    expect(resizeCallCount).toBeGreaterThan(0);

    mockState.nextFitDims = { cols: 1, rows: 1 };
    triggerResizeObserver();
    await flushAnimationFrame();

    const terminal = mockState.terminalInstances.at(-1) as {
      resize: ReturnType<typeof vi.fn>;
      cols: number;
      rows: number;
    } | undefined;
    const runtime = getTerminalRuntimeSnapshot("session-recover");
    expect(terminal?.resize).toHaveBeenLastCalledWith(120, 40);
    expect(terminal?.cols).toBe(120);
    expect(terminal?.rows).toBe(40);
    expect(resizeSpy.mock.calls).toHaveLength(resizeCallCount);
    expect(runtime?.health.fitRecoveries).toBe(1);
  });

  it("stays unfocused while inactive and only focuses once the terminal becomes active", async () => {
    const view = render(<TerminalView ptyId="pty-inactive" sessionId="session-inactive" isActive={false} />);
    await flushAllTimers();

    const terminal = mockState.terminalInstances.at(-1) as {
      focus: ReturnType<typeof vi.fn>;
    } | undefined;
    expect(terminal?.focus).not.toHaveBeenCalled();

    view.rerender(<TerminalView ptyId="pty-inactive" sessionId="session-inactive" isActive />);
    await flushAllTimers();

    expect(terminal?.focus).toHaveBeenCalled();
  });

  it("keeps fitting visible inactive terminals without focusing them", async () => {
    render(<TerminalView ptyId="pty-visible" sessionId="session-visible" isActive={false} isVisible />);
    await flushAllTimers();

    const resizeSpy = (window as any).ade.pty.resize as ReturnType<typeof vi.fn>;
    const terminal = mockState.terminalInstances.at(-1) as {
      focus: ReturnType<typeof vi.fn>;
    } | undefined;

    expect(resizeSpy).toHaveBeenCalledWith({
      ptyId: "pty-visible",
      cols: 120,
      rows: 40,
    });
    expect(terminal?.focus).not.toHaveBeenCalled();

    mockState.nextFitDims = { cols: 140, rows: 44 };
    triggerResizeObserver();
    await flushAnimationFrame();

    expect(resizeSpy).toHaveBeenLastCalledWith({
      ptyId: "pty-visible",
      cols: 140,
      rows: 44,
    });
    expect(terminal?.focus).not.toHaveBeenCalled();
  });

  it("coalesces PTY resize calls while a previous resize is still in flight", async () => {
    let resolveResize: (() => void) | null = null;
    const pendingResize = new Promise<void>((resolve) => {
      resolveResize = resolve;
    });
    const resizeSpy = vi.fn(() => pendingResize);
    (window as any).ade.pty.resize = resizeSpy;

    render(<TerminalView ptyId="pty-coalesce" sessionId="session-coalesce" isActive />);
    await flushAnimationFrame();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(resizeSpy).toHaveBeenCalledTimes(1);
    expect(resizeSpy).toHaveBeenLastCalledWith({
      ptyId: "pty-coalesce",
      cols: 120,
      rows: 40,
    });

    mockState.nextFitDims = { cols: 130, rows: 41 };
    triggerResizeObserver();
    await flushAnimationFrame();
    mockState.nextFitDims = { cols: 140, rows: 42 };
    triggerResizeObserver();
    await flushAnimationFrame();

    expect(resizeSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveResize?.();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(resizeSpy).toHaveBeenCalledTimes(2);
    expect(resizeSpy).toHaveBeenLastCalledWith({
      ptyId: "pty-coalesce",
      cols: 140,
      rows: 42,
    });
  });

  it("retries a forced PTY resize when the in-flight resize rejects", async () => {
    let rejectResize: ((reason?: unknown) => void) | null = null;
    const pendingResize = new Promise<void>((_resolve, reject) => {
      rejectResize = reject;
    });
    const resizeSpy = vi.fn()
      .mockReturnValueOnce(pendingResize)
      .mockResolvedValue(undefined);
    (window as any).ade.pty.resize = resizeSpy;

    render(<TerminalView ptyId="pty-retry-rejected" sessionId="session-retry-rejected" isActive />);
    await flushAnimationFrame();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(resizeSpy).toHaveBeenCalledTimes(1);
    expect(resizeSpy).toHaveBeenLastCalledWith({
      ptyId: "pty-retry-rejected",
      cols: 120,
      rows: 40,
    });

    window.dispatchEvent(new Event(WORK_SURFACE_REVEALED_EVENT));
    await flushAnimationFrame();
    await flushAnimationFrame();

    expect(resizeSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      rejectResize?.(new Error("resize failed"));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(resizeSpy).toHaveBeenCalledTimes(2);
    expect(resizeSpy).toHaveBeenLastCalledWith({
      ptyId: "pty-retry-rejected",
      cols: 120,
      rows: 40,
    });
  });

  it("falls back to the DOM renderer when webgl initialization fails", async () => {
    // `await import("@xterm/addon-webgl")` may not settle under Vi's fake timers on CI shards.
    vi.useRealTimers();
    try {
      window.localStorage.setItem("ade.terminalRenderer", "webgl");
      mockState.shouldThrowWebglAddon = true;
      const previousFallbacks = getTerminalRuntimeSnapshot("session-dom")?.health.rendererFallbacks ?? 0;

      render(<TerminalView ptyId="pty-dom" sessionId="session-dom" isActive />);

      // initRendererChain is fire-and-forget with a dynamic import inside; real
      // timers + waitFor let the microtask chain settle reliably across shards.
      await waitFor(
        () => {
          const runtime = getTerminalRuntimeSnapshot("session-dom");
          expect(runtime?.renderer).toBe("dom");
          expect(runtime?.health.rendererFallbacks).toBeGreaterThan(previousFallbacks);
        },
        { timeout: 10_000 },
      );

      cleanup();
    } finally {
      vi.useFakeTimers();
    }
  });

  it("applies updated terminal preferences to an existing runtime", async () => {
    const view = render(<TerminalView ptyId="pty-prefs" sessionId="session-prefs" isActive />);
    await flushAllTimers();

    const terminal = mockState.terminalInstances.at(-1) as {
      options: Record<string, unknown>;
    } | undefined;
    expect(terminal?.options.fontSize).toBe(12.5);
    expect(terminal?.options.lineHeight).toBe(1.25);
    expect(terminal?.options.scrollback).toBe(10_000);

    mockState.terminalPreferences = {
      fontFamily: MOCK_TERMINAL_FONT_FAMILY,
      fontSize: 14,
      lineHeight: 1.3,
      scrollback: 20_000,
    };
    view.rerender(<TerminalView ptyId="pty-prefs" sessionId="session-prefs" isActive />);
    await flushAllTimers();

    expect(terminal?.options.fontSize).toBe(14);
    expect(terminal?.options.lineHeight).toBe(1.3);
    expect(terminal?.options.scrollback).toBe(20_000);
  });

  it("writes text paste contents directly to the PTY", async () => {
    render(<TerminalView ptyId="pty-text-paste" sessionId="session-text-paste" isActive />);
    await flushAllTimers();

    const terminal = mockState.terminalInstances.at(-1) as {
      element: HTMLElement | null;
    } | undefined;
    expect(terminal?.element).toBeTruthy();

    const ptyWrite = window.ade.pty.write as unknown as ReturnType<typeof vi.fn>;
    const hasClipboardImage = window.ade.app.hasClipboardImage as unknown as ReturnType<typeof vi.fn>;
    ptyWrite.mockClear();
    hasClipboardImage.mockClear();

    const event = createPasteEvent("hello from clipboard");
    terminal!.element!.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(ptyWrite).toHaveBeenCalledWith({
      ptyId: "pty-text-paste",
      data: "hello from clipboard",
    });
    expect(hasClipboardImage).not.toHaveBeenCalled();
  });

  it("maps macOS Cmd+V with an image-only clipboard to Ctrl+V terminal input", async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(window.navigator, "platform");
    const originalPlatform = window.navigator.platform;
    try {
      Object.defineProperty(window.navigator, "platform", {
        configurable: true,
        value: "MacIntel",
      });
      (window.ade.app.hasClipboardImage as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      render(<TerminalView ptyId="pty-image-paste" sessionId="session-image-paste" isActive />);
      await flushAllTimers();

      const terminal = mockState.terminalInstances.at(-1) as {
        attachCustomKeyEventHandler: ReturnType<typeof vi.fn>;
        element: HTMLElement | null;
      } | undefined;
      expect(terminal?.element).toBeTruthy();
      const keyHandler = terminal?.attachCustomKeyEventHandler.mock.calls.at(-1)?.[0] as ((ev: KeyboardEvent) => boolean) | undefined;
      expect(keyHandler).toBeTruthy();

      const ptyWrite = window.ade.pty.write as unknown as ReturnType<typeof vi.fn>;
      ptyWrite.mockClear();

      const handled = keyHandler!({
        type: "keydown",
        key: "v",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        preventDefault: vi.fn(),
      } as unknown as KeyboardEvent);
      expect(handled).toBe(false);

      const event = createPasteEvent("");
      terminal!.element!.dispatchEvent(event);
      await flushPromises();

      expect(event.defaultPrevented).toBe(true);
      expect(window.ade.app.hasClipboardImage).toHaveBeenCalledTimes(1);
      expect(ptyWrite).toHaveBeenCalledWith({
        ptyId: "pty-image-paste",
        data: "\x16",
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(130);
      });
      expect(ptyWrite).toHaveBeenCalledTimes(1);
    } finally {
      if (platformDescriptor) {
        Object.defineProperty(window.navigator, "platform", platformDescriptor);
      } else {
        Object.defineProperty(window.navigator, "platform", {
          configurable: true,
          value: originalPlatform,
        });
      }
    }
  });

  it("maps macOS Cmd+C without an xterm selection to Ctrl+C terminal input", async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(window.navigator, "platform");
    const originalPlatform = window.navigator.platform;
    try {
      Object.defineProperty(window.navigator, "platform", {
        configurable: true,
        value: "MacIntel",
      });

      render(<TerminalView ptyId="pty-copy" sessionId="session-copy" isActive />);
      await flushAllTimers();

      const terminal = mockState.terminalInstances.at(-1) as {
        attachCustomKeyEventHandler: ReturnType<typeof vi.fn>;
      } | undefined;
      const keyHandler = terminal?.attachCustomKeyEventHandler.mock.calls.at(-1)?.[0] as ((ev: KeyboardEvent) => boolean) | undefined;
      expect(keyHandler).toBeTruthy();

      const ptyWrite = window.ade.pty.write as unknown as ReturnType<typeof vi.fn>;
      ptyWrite.mockClear();
      const preventDefault = vi.fn();

      const handled = keyHandler!({
        type: "keydown",
        key: "c",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        preventDefault,
      } as unknown as KeyboardEvent);

      expect(handled).toBe(false);
      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(ptyWrite).toHaveBeenCalledWith({
        ptyId: "pty-copy",
        data: "\x03",
      });
    } finally {
      if (platformDescriptor) {
        Object.defineProperty(window.navigator, "platform", platformDescriptor);
      } else {
        Object.defineProperty(window.navigator, "platform", {
          configurable: true,
          value: originalPlatform,
        });
      }
    }
  });

  it("forwards Shift+mouse selection gestures while terminal mouse tracking is active", async () => {
    render(<TerminalView ptyId="pty-shift-mouse" sessionId="session-shift-mouse" isActive />);
    await flushAllTimers();

    const terminal = mockState.terminalInstances.at(-1) as {
      element: HTMLElement | null;
    } | undefined;
    expect(terminal?.element).toBeTruthy();

    const ptyWrite = window.ade.pty.write as unknown as ReturnType<typeof vi.fn>;
    ptyWrite.mockClear();

    const ignoredDown = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      shiftKey: true,
      button: 0,
      buttons: 1,
      clientX: 0,
      clientY: 0,
    });
    terminal!.element!.dispatchEvent(ignoredDown);
    expect(ignoredDown.defaultPrevented).toBe(false);
    expect(ptyWrite).not.toHaveBeenCalled();

    for (const listener of mockState.ptyDataListeners) {
      listener({
        ptyId: "pty-shift-mouse",
        sessionId: "session-shift-mouse",
        projectRoot: "/project/a",
        data: "\x1b[?1000h\x1b[?1002h\x1b[?1006h",
      });
    }

    const down = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      shiftKey: true,
      button: 0,
      buttons: 1,
      clientX: 0,
      clientY: 0,
    });
    terminal!.element!.dispatchEvent(down);

    const move = new MouseEvent("mousemove", {
      bubbles: true,
      cancelable: true,
      shiftKey: true,
      buttons: 1,
      clientX: 64,
      clientY: 72,
    });
    document.dispatchEvent(move);

    const up = new MouseEvent("mouseup", {
      bubbles: true,
      cancelable: true,
      shiftKey: true,
      button: 0,
      buttons: 0,
      clientX: 64,
      clientY: 72,
    });
    document.dispatchEvent(up);

    expect(down.defaultPrevented).toBe(true);
    expect(move.defaultPrevented).toBe(true);
    expect(up.defaultPrevented).toBe(true);
    expect(ptyWrite).toHaveBeenNthCalledWith(1, {
      ptyId: "pty-shift-mouse",
      data: "\x1b[<4;1;1M",
    });
    expect(ptyWrite).toHaveBeenNthCalledWith(2, {
      ptyId: "pty-shift-mouse",
      data: "\x1b[<36;13;9M",
    });
    expect(ptyWrite).toHaveBeenNthCalledWith(3, {
      ptyId: "pty-shift-mouse",
      data: "\x1b[<4;13;9m",
    });
  });

  it("does not forward a Shift+mouse release after the runtime is disposed", async () => {
    render(<TerminalView ptyId="pty-shift-disposed" sessionId="session-shift-disposed" isActive />);
    await flushAllTimers();

    const terminal = mockState.terminalInstances.at(-1) as {
      element: HTMLElement | null;
    } | undefined;
    expect(terminal?.element).toBeTruthy();

    for (const listener of mockState.ptyDataListeners) {
      listener({
        ptyId: "pty-shift-disposed",
        sessionId: "session-shift-disposed",
        projectRoot: "/project/a",
        data: "\x1b[?1000h\x1b[?1002h\x1b[?1006h",
      });
    }

    const ptyWrite = window.ade.pty.write as unknown as ReturnType<typeof vi.fn>;
    ptyWrite.mockClear();
    terminal!.element!.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      shiftKey: true,
      button: 0,
      buttons: 1,
      clientX: 0,
      clientY: 0,
    }));
    expect(ptyWrite).toHaveBeenCalledTimes(1);

    __resetTerminalRuntimesForTests();
    terminal!.element!.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
      shiftKey: true,
      button: 0,
      buttons: 1,
      clientX: 0,
      clientY: 0,
    }));
    document.dispatchEvent(new MouseEvent("mouseup", {
      bubbles: true,
      cancelable: true,
      shiftKey: true,
      button: 0,
      buttons: 0,
      clientX: 64,
      clientY: 72,
    }));

    expect(ptyWrite).toHaveBeenCalledTimes(1);
  });

  it("falls back to native image paste when macOS Cmd+V does not fire a paste event", async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(window.navigator, "platform");
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(window.navigator, "clipboard");
    const originalPlatform = window.navigator.platform;
    try {
      Object.defineProperty(window.navigator, "platform", {
        configurable: true,
        value: "MacIntel",
      });
      Object.defineProperty(window.navigator, "clipboard", {
        configurable: true,
        value: {
          readText: vi.fn().mockResolvedValue(""),
          writeText: vi.fn().mockResolvedValue(undefined),
        },
      });
      (window.ade.app.hasClipboardImage as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(true);

      render(<TerminalView ptyId="pty-image-fallback" sessionId="session-image-fallback" isActive />);
      await flushAllTimers();

      const terminal = mockState.terminalInstances.at(-1) as {
        attachCustomKeyEventHandler: ReturnType<typeof vi.fn>;
      } | undefined;
      const keyHandler = terminal?.attachCustomKeyEventHandler.mock.calls.at(-1)?.[0] as ((ev: KeyboardEvent) => boolean) | undefined;
      expect(keyHandler).toBeTruthy();

      const ptyWrite = window.ade.pty.write as unknown as ReturnType<typeof vi.fn>;
      ptyWrite.mockClear();

      const handled = keyHandler!({
        type: "keydown",
        key: "v",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        preventDefault: vi.fn(),
      } as unknown as KeyboardEvent);
      expect(handled).toBe(false);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(130);
      });
      await flushPromises();

      expect(window.navigator.clipboard.readText).toHaveBeenCalledTimes(1);
      expect(window.ade.app.hasClipboardImage).toHaveBeenCalledTimes(1);
      expect(ptyWrite).toHaveBeenCalledWith({
        ptyId: "pty-image-fallback",
        data: "\x16",
      });
    } finally {
      if (platformDescriptor) {
        Object.defineProperty(window.navigator, "platform", platformDescriptor);
      } else {
        Object.defineProperty(window.navigator, "platform", {
          configurable: true,
          value: originalPlatform,
        });
      }
      if (clipboardDescriptor) {
        Object.defineProperty(window.navigator, "clipboard", clipboardDescriptor);
      } else {
        Reflect.deleteProperty(window.navigator, "clipboard");
      }
    }
  });

  it("keeps live parked runtimes available so switching away does not discard TUI state", async () => {
    const view = render(<TerminalView ptyId="pty-live" sessionId="session-live" isActive />);
    await flushAllTimers();

    const terminal = mockState.terminalInstances.at(-1) as {
      dispose: ReturnType<typeof vi.fn>;
    } | undefined;

    expect(getTerminalRuntimeSnapshot("session-live")).not.toBeNull();

    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(14_000);
    });
    expect(getTerminalRuntimeSnapshot("session-live")).not.toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_100);
    });
    expect(getTerminalRuntimeSnapshot("session-live")).not.toBeNull();
    expect(terminal?.dispose).not.toHaveBeenCalled();
  });

  it("keeps live parked runtimes current across project switches", async () => {
    const view = render(<TerminalView ptyId="pty-switch" sessionId="session-switch" isActive />);
    await flushAllTimers();

    const readTranscriptTailMock = window.ade.sessions.readTranscriptTail as unknown as { mock: { calls: unknown[][] } };
    const firstTerminal = mockState.terminalInstances.at(-1) as {
      dispose: ReturnType<typeof vi.fn>;
      write: ReturnType<typeof vi.fn>;
    } | undefined;
    expect(firstTerminal).toBeTruthy();
    expect(getTerminalRuntimeSnapshot("session-switch")).not.toBeNull();

    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(getTerminalRuntimeSnapshot("session-switch")).not.toBeNull();

    mockState.projectRoot = "/project/b";
    mockState.projectRevision += 1;
    disposeTerminalRuntimesForProjectChange(mockState.projectRoot, mockState.projectRevision);

    firstTerminal?.write.mockClear();
    for (const listener of mockState.ptyDataListeners) {
      listener({
        ptyId: "pty-switch",
        sessionId: "session-switch",
        projectRoot: "/project/a",
        data: "still running in project a\n",
      });
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16);
    });
    expect(firstTerminal?.write).not.toHaveBeenCalledWith("still running in project a\n");
    expect(firstTerminal?.dispose).not.toHaveBeenCalled();

    mockState.projectRoot = "/project/a";
    mockState.projectRevision += 1;

    render(<TerminalView ptyId="pty-switch" sessionId="session-switch" isActive />);
    await flushAllTimers();
    expect(firstTerminal?.write).toHaveBeenCalledWith("still running in project a\n");

    const secondTerminal = mockState.terminalInstances.at(-1) as {
      dispose: ReturnType<typeof vi.fn>;
    } | undefined;
    expect(mockState.terminalInstances).toHaveLength(1);
    expect(secondTerminal).toBe(firstTerminal);
    expect(firstTerminal?.dispose).not.toHaveBeenCalled();
    expect(readTranscriptTailMock.mock.calls).toHaveLength(1);
    expect(getTerminalRuntimeSnapshot("session-switch")).not.toBeNull();
  });

  it("hydrates live terminals from serialized snapshots when structured rows are unavailable", async () => {
    const previewMock = window.ade.terminal.preview as unknown as ReturnType<typeof vi.fn>;
    const readTranscriptTailMock = window.ade.sessions.readTranscriptTail as unknown as ReturnType<typeof vi.fn>;
    previewMock.mockResolvedValueOnce({
      terminalId: "session-snapshot",
      session: null,
      source: "snapshot",
      snapshot: {
        version: 1,
        terminalId: "session-snapshot",
        cols: 120,
        rows: 32,
        capturedAt: new Date().toISOString(),
        status: "running",
        runtimeState: "running",
        bufferType: "alternate",
        cursorX: 0,
        cursorY: 0,
        baseY: 0,
        viewportY: 0,
        serialized: "\x1b[?1049hClaude Code ready\n",
        visibleRows: [],
      },
      transcript: null,
      capturedAt: new Date().toISOString(),
    });

    render(<TerminalView ptyId="pty-snapshot" sessionId="session-snapshot" isActive />);
    await flushAllTimers();

    const terminal = mockState.terminalInstances.at(-1) as {
      write: ReturnType<typeof vi.fn>;
    } | undefined;
    expect(terminal?.write).toHaveBeenCalledWith("\x1b[?1049hClaude Code ready\n");
    expect(readTranscriptTailMock).not.toHaveBeenCalled();
  });

  it("preserves snapshot cell colors when hydrating live terminals", async () => {
    const previewMock = window.ade.terminal.preview as unknown as ReturnType<typeof vi.fn>;
    const readTranscriptTailMock = window.ade.sessions.readTranscriptTail as unknown as ReturnType<typeof vi.fn>;
    previewMock.mockResolvedValueOnce({
      terminalId: "session-colored-snapshot",
      session: null,
      source: "snapshot",
      snapshot: {
        version: 1,
        terminalId: "session-colored-snapshot",
        cols: 12,
        rows: 2,
        capturedAt: new Date().toISOString(),
        status: "running",
        runtimeState: "running",
        bufferType: "alternate",
        cursorX: 1,
        cursorY: 1,
        baseY: 0,
        viewportY: 0,
        serialized: "UNSTYLED SERIALIZED\n",
        visibleRows: [
          {
            text: "Claude",
            wrapped: false,
            cells: [
              { text: "C", fg: 0xd77757, bg: null, fgMode: "rgb", bgMode: "default", bold: true },
              { text: "l", fg: 0xd77757, bg: null, fgMode: "rgb", bgMode: "default", bold: true },
              { text: "a", fg: 0xd77757, bg: null, fgMode: "rgb", bgMode: "default", bold: true },
              { text: "u", fg: 0xd77757, bg: null, fgMode: "rgb", bgMode: "default", bold: true },
              { text: "d", fg: 0xd77757, bg: null, fgMode: "rgb", bgMode: "default", bold: true },
              { text: "e", fg: 0xd77757, bg: null, fgMode: "rgb", bgMode: "default", bold: true },
            ],
          },
          {
            text: "Ready",
            wrapped: false,
            cells: [
              { text: "R", fg: 34, bg: 18, fgMode: "palette", bgMode: "palette" },
              { text: "e", fg: 34, bg: 18, fgMode: "palette", bgMode: "palette" },
              { text: "a", fg: 34, bg: 18, fgMode: "palette", bgMode: "palette" },
              { text: "d", fg: 34, bg: 18, fgMode: "palette", bgMode: "palette" },
              { text: "y", fg: 34, bg: 18, fgMode: "palette", bgMode: "palette" },
            ],
          },
        ],
      },
      transcript: null,
      capturedAt: new Date().toISOString(),
    });

    render(<TerminalView ptyId="pty-colored-snapshot" sessionId="session-colored-snapshot" isActive />);
    await flushAllTimers();

    const terminal = mockState.terminalInstances.at(-1) as {
      write: ReturnType<typeof vi.fn>;
    } | undefined;
    const written = terminal?.write.mock.calls.find(([value]) => String(value).includes("Claude"))?.[0] as string | undefined;
    expect(written).toBeTruthy();
    expect(written).toContain("\x1b[?1049h");
    expect(written).toContain("\x1b[0;1;38;2;215;119;87mClaude");
    expect(written).toContain("\x1b[0;38;5;34;48;5;18mReady");
    expect(written).toContain("\x1b[2;2H");
    expect(written).not.toContain("UNSTYLED SERIALIZED");
    expect(readTranscriptTailMock).not.toHaveBeenCalled();
  });

  it("switches back to the main buffer before hydrating normal snapshots", async () => {
    const previewMock = window.ade.terminal.preview as unknown as ReturnType<typeof vi.fn>;
    previewMock.mockResolvedValueOnce({
      terminalId: "session-normal-snapshot",
      session: null,
      source: "snapshot",
      snapshot: {
        version: 1,
        terminalId: "session-normal-snapshot",
        cols: 12,
        rows: 2,
        capturedAt: new Date().toISOString(),
        status: "running",
        runtimeState: "running",
        bufferType: "normal",
        cursorX: 0,
        cursorY: 0,
        baseY: 0,
        viewportY: 0,
        serialized: "",
        visibleRows: [
          {
            text: "Main",
            wrapped: false,
            cells: "Main".split("").map((text) => ({
              text,
              fg: null,
              bg: null,
              fgMode: "default" as const,
              bgMode: "default" as const,
            })),
          },
        ],
      },
      transcript: null,
      capturedAt: new Date().toISOString(),
    });

    render(<TerminalView ptyId="pty-normal-snapshot" sessionId="session-normal-snapshot" isActive />);
    await flushAllTimers();

    const terminal = mockState.terminalInstances.at(-1) as {
      write: ReturnType<typeof vi.fn>;
    } | undefined;
    const written = terminal?.write.mock.calls.find(([value]) => String(value).includes("Main"))?.[0] as string | undefined;
    expect(written).toBeTruthy();
    expect(written).toContain("\x1b[?1049l");
    expect(written).not.toContain("\x1b[?1049h");
  });

  it("keeps a mounted live runtime bound to its original project while the active project changes", async () => {
    const view = render(<TerminalView ptyId="pty-mounted-switch" sessionId="session-mounted-switch" isActive />);
    await flushAllTimers();

    const terminal = mockState.terminalInstances.at(-1) as {
      dispose: ReturnType<typeof vi.fn>;
      write: ReturnType<typeof vi.fn>;
    } | undefined;
    expect(terminal).toBeTruthy();
    expect(getTerminalRuntimeSnapshot("session-mounted-switch")).not.toBeNull();

    terminal?.write.mockClear();
    mockState.projectRoot = "/project/b";
    mockState.projectRevision += 1;
    view.rerender(<TerminalView ptyId="pty-mounted-switch" sessionId="session-mounted-switch" isActive />);
    await flushAllTimers();

    expect(mockState.terminalInstances).toHaveLength(1);
    expect(terminal?.dispose).not.toHaveBeenCalled();

    for (const listener of mockState.ptyDataListeners) {
      listener({
        ptyId: "pty-mounted-switch",
        sessionId: "session-mounted-switch",
        projectRoot: "/project/b",
        data: "wrong project output\n",
      });
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16);
    });
    expect(terminal?.write).not.toHaveBeenCalledWith("wrong project output\n");

    for (const listener of mockState.ptyDataListeners) {
      listener({
        ptyId: "pty-mounted-switch",
        sessionId: "session-mounted-switch",
        projectRoot: "/project/a",
        data: "original project output\n",
      });
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16);
    });
    expect(terminal?.write).toHaveBeenCalledWith("original project output\n");
  });

  it("keeps parked live runtimes when the project changes without a mounted terminal view", async () => {
    const view = render(<TerminalView ptyId="pty-background" sessionId="session-background" isActive />);
    await flushAllTimers();

    const terminal = mockState.terminalInstances.at(-1) as {
      dispose: ReturnType<typeof vi.fn>;
    } | undefined;
    expect(terminal).toBeTruthy();
    expect(getTerminalRuntimeSnapshot("session-background")).not.toBeNull();

    view.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(getTerminalRuntimeSnapshot("session-background")).not.toBeNull();

    mockState.projectRoot = "/project/b";
    mockState.projectRevision += 1;
    disposeTerminalRuntimesForProjectChange(mockState.projectRoot, mockState.projectRevision);

    expect(terminal?.dispose).not.toHaveBeenCalled();
    expect(getTerminalRuntimeSnapshot("session-background")).not.toBeNull();

    for (const listener of mockState.ptyExitListeners) {
      listener({
        ptyId: "pty-background",
        sessionId: "session-background",
        projectRoot: "/project/a",
        exitCode: 0,
      });
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });

    expect(terminal?.dispose).toHaveBeenCalledTimes(1);
    expect(getTerminalRuntimeSnapshot("session-background")).toBeNull();
  });

  it("paints live PTY output before initial transcript hydration finishes", async () => {
    render(<TerminalView ptyId="pty-fast-live" sessionId="session-fast-live" isActive />);
    await flushAnimationFrame();

    const terminal = mockState.terminalInstances.at(-1) as {
      write: ReturnType<typeof vi.fn>;
      refresh: ReturnType<typeof vi.fn>;
      scrollToBottom: ReturnType<typeof vi.fn>;
    } | undefined;
    expect(terminal).toBeTruthy();

    terminal?.write.mockClear();
    terminal?.refresh.mockClear();
    terminal?.scrollToBottom.mockClear();
    for (const listener of mockState.ptyDataListeners) {
      listener({ ptyId: "pty-fast-live", sessionId: "session-fast-live", data: "codex initial frame\n" });
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16);
    });

    expect(terminal?.write).toHaveBeenCalledWith("codex initial frame\n");
    expect(terminal?.scrollToBottom).toHaveBeenCalled();
    expect(terminal?.refresh).toHaveBeenCalled();
    expect(window.ade.terminal.preview).not.toHaveBeenCalled();
  });

  it("does not force live PTY output back to the bottom after the user scrolls up", async () => {
    render(<TerminalView ptyId="pty-user-scrollback" sessionId="session-user-scrollback" isActive />);
    await flushAnimationFrame();

    const terminal = mockState.terminalInstances.at(-1) as {
      buffer: { active: { baseY: number; viewportY: number } };
      write: ReturnType<typeof vi.fn>;
      refresh: ReturnType<typeof vi.fn>;
      scrollToBottom: ReturnType<typeof vi.fn>;
    } | undefined;
    expect(terminal).toBeTruthy();

    terminal!.buffer.active.baseY = 120;
    terminal!.buffer.active.viewportY = 40;
    terminal?.write.mockClear();
    terminal?.refresh.mockClear();
    terminal?.scrollToBottom.mockClear();

    for (const listener of mockState.ptyDataListeners) {
      listener({ ptyId: "pty-user-scrollback", sessionId: "session-user-scrollback", data: "background output\n" });
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16);
    });

    expect(terminal?.write).toHaveBeenCalledWith("background output\n");
    expect(terminal?.refresh).toHaveBeenCalled();
    expect(terminal?.scrollToBottom).not.toHaveBeenCalled();
  });

  it("uses wheel gestures to scroll main-buffer history when mouse tracking is active", async () => {
    render(<TerminalView ptyId="pty-wheel-history" sessionId="session-wheel-history" isActive />);
    await flushAllTimers();

    const terminal = mockState.terminalInstances.at(-1) as {
      element: HTMLElement | null;
      buffer: { active: { baseY: number; viewportY: number } };
      scrollLines: ReturnType<typeof vi.fn>;
    } | undefined;
    expect(terminal?.element).toBeTruthy();

    const viewport = document.createElement("div");
    viewport.className = "xterm-viewport";
    Object.defineProperty(viewport, "scrollHeight", {
      configurable: true,
      value: 720,
    });
    Object.defineProperty(viewport, "clientHeight", {
      configurable: true,
      value: 360,
    });
    terminal!.element!.appendChild(viewport);
    terminal!.buffer.active.baseY = 200;
    terminal!.buffer.active.viewportY = 180;

    for (const listener of mockState.ptyDataListeners) {
      listener({
        ptyId: "pty-wheel-history",
        sessionId: "session-wheel-history",
        data: "\x1b[?1000h\x1b[?1002h\x1b[?1006h",
      });
    }

    const event = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: -96,
    });
    viewport.dispatchEvent(event);

    expect(terminal?.scrollLines).toHaveBeenCalledWith(-3);
    expect(event.defaultPrevented).toBe(true);
  });

  it("does not replay transcript hydration over live PTY output that already painted", async () => {
    const previewMock = window.ade.terminal.preview as unknown as ReturnType<typeof vi.fn>;
    previewMock.mockResolvedValueOnce({
      terminalId: "session-fast-transcript",
      session: null,
      source: "transcript",
      snapshot: null,
      transcript: "old transcript should not replay\n",
      capturedAt: new Date().toISOString(),
    });

    render(<TerminalView ptyId="pty-fast-transcript" sessionId="session-fast-transcript" isActive />);
    await flushAnimationFrame();

    const terminal = mockState.terminalInstances.at(-1) as {
      write: ReturnType<typeof vi.fn>;
    } | undefined;
    expect(terminal).toBeTruthy();

    terminal?.write.mockClear();
    for (const listener of mockState.ptyDataListeners) {
      listener({ ptyId: "pty-fast-transcript", sessionId: "session-fast-transcript", data: "live frame\n" });
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16);
    });
    await flushAllTimers();

    expect(terminal?.write).toHaveBeenCalledWith("live frame\n");
    expect(terminal?.write).not.toHaveBeenCalledWith("old transcript should not replay\n");
  });

  it("backfills a running terminal from preview when initial hydration was empty", async () => {
    const previewMock = window.ade.terminal.preview as unknown as ReturnType<typeof vi.fn>;
    previewMock
      .mockResolvedValueOnce({
        terminalId: "session-late-snapshot",
        session: null,
        source: "empty",
        snapshot: null,
        transcript: null,
        capturedAt: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        terminalId: "session-late-snapshot",
        session: null,
        source: "transcript",
        snapshot: null,
        transcript: "late codex frame\n",
        capturedAt: new Date().toISOString(),
      });

    render(<TerminalView ptyId="pty-late-snapshot" sessionId="session-late-snapshot" isActive />);
    await flushAllTimers();

    const terminal = mockState.terminalInstances.at(-1) as {
      write: ReturnType<typeof vi.fn>;
    } | undefined;
    expect(terminal).toBeTruthy();
    expect(terminal?.write).toHaveBeenCalledWith("late codex frame\n");
  });

  it("does not let startup-only control bytes block later snapshot backfill", async () => {
    const previewMock = window.ade.terminal.preview as unknown as ReturnType<typeof vi.fn>;
    previewMock
      .mockResolvedValueOnce({
        terminalId: "session-control-then-snapshot",
        session: null,
        source: "empty",
        snapshot: null,
        transcript: null,
        capturedAt: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        terminalId: "session-control-then-snapshot",
        session: null,
        source: "snapshot",
        snapshot: {
          version: 1,
          terminalId: "session-control-then-snapshot",
          cols: 120,
          rows: 2,
          capturedAt: new Date().toISOString(),
          status: "running",
          runtimeState: "running",
          bufferType: "normal",
          cursorX: 0,
          cursorY: 1,
          baseY: 0,
          viewportY: 0,
          serialized: "",
          visibleRows: [
            {
              text: "Codex ready",
              wrapped: false,
              cells: "Codex ready".split("").map((text) => ({
                text,
                fg: null,
                bg: null,
                fgMode: "default" as const,
                bgMode: "default" as const,
              })),
            },
          ],
        },
        transcript: null,
        capturedAt: new Date().toISOString(),
      });

    render(<TerminalView ptyId="pty-control-then-snapshot" sessionId="session-control-then-snapshot" isActive />);
    await flushAnimationFrame();

    const terminal = mockState.terminalInstances.at(-1) as {
      write: ReturnType<typeof vi.fn>;
    } | undefined;
    expect(terminal).toBeTruthy();
    terminal?.write.mockClear();

    for (const listener of mockState.ptyDataListeners) {
      listener({
        ptyId: "pty-control-then-snapshot",
        sessionId: "session-control-then-snapshot",
        data: "\x1b[?2004h\x1b[>7u\x1b[?1004h\x1b[6n\x1b[?u\x1b[c\x1b]10;?\x1b\\",
      });
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16);
    });
    await flushAllTimers();

    const writes = terminal?.write.mock.calls.map(([value]) => String(value)) ?? [];
    expect(writes.some((value) => value.includes("Codex ready"))).toBe(true);
  });

  it("does not let renderable cursor-diff chunks block snapshot backfill when the DOM stays blank", async () => {
    const previewMock = window.ade.terminal.preview as unknown as ReturnType<typeof vi.fn>;
    previewMock
      .mockResolvedValueOnce({
        terminalId: "session-diff-then-snapshot",
        session: null,
        source: "empty",
        snapshot: null,
        transcript: null,
        capturedAt: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        terminalId: "session-diff-then-snapshot",
        session: null,
        source: "snapshot",
        snapshot: {
          version: 1,
          terminalId: "session-diff-then-snapshot",
          cols: 120,
          rows: 2,
          capturedAt: new Date().toISOString(),
          status: "running",
          runtimeState: "running",
          bufferType: "normal",
          cursorX: 0,
          cursorY: 1,
          baseY: 0,
          viewportY: 0,
          serialized: "",
          visibleRows: [
            {
              text: "Codex snapshot ready",
              wrapped: false,
              cells: "Codex snapshot ready".split("").map((text) => ({
                text,
                fg: null,
                bg: null,
                fgMode: "default" as const,
                bgMode: "default" as const,
              })),
            },
          ],
        },
        transcript: null,
        capturedAt: new Date().toISOString(),
      });

    render(<TerminalView ptyId="pty-diff-then-snapshot" sessionId="session-diff-then-snapshot" isActive />);
    await flushAnimationFrame();

    const terminal = mockState.terminalInstances.at(-1) as {
      write: ReturnType<typeof vi.fn>;
    } | undefined;
    expect(terminal).toBeTruthy();
    terminal?.write.mockClear();

    for (const listener of mockState.ptyDataListeners) {
      listener({
        ptyId: "pty-diff-then-snapshot",
        sessionId: "session-diff-then-snapshot",
        data: "\x1b[29;3HStarting MCP server",
      });
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16);
    });
    await flushAllTimers();

    const writes = terminal?.write.mock.calls.map(([value]) => String(value)) ?? [];
    expect(writes.some((value) => value.includes("Codex snapshot ready"))).toBe(true);
  });

  it("polls the preview snapshot quickly when visible Codex cursor-diff output leaves the DOM blank", async () => {
    const previewMock = window.ade.terminal.preview as unknown as ReturnType<typeof vi.fn>;
    previewMock.mockResolvedValue({
      terminalId: "session-fast-blank-snapshot",
      session: null,
      source: "snapshot",
      snapshot: {
        version: 1,
        terminalId: "session-fast-blank-snapshot",
        cols: 120,
        rows: 2,
        capturedAt: new Date().toISOString(),
        status: "running",
        runtimeState: "running",
        bufferType: "normal",
        cursorX: 0,
        cursorY: 1,
        baseY: 0,
        viewportY: 0,
        serialized: "",
        visibleRows: [
          {
            text: "Fast snapshot paint",
            wrapped: false,
            cells: "Fast snapshot paint".split("").map((text) => ({
              text,
              fg: null,
              bg: null,
              fgMode: "default" as const,
              bgMode: "default" as const,
            })),
          },
        ],
      },
      transcript: null,
      capturedAt: new Date().toISOString(),
    });

    render(<TerminalView ptyId="pty-fast-blank-snapshot" sessionId="session-fast-blank-snapshot" isActive />);
    await flushAnimationFrame();

    const terminal = mockState.terminalInstances.at(-1) as {
      write: ReturnType<typeof vi.fn>;
    } | undefined;
    expect(terminal).toBeTruthy();
    terminal?.write.mockClear();

    for (const listener of mockState.ptyDataListeners) {
      listener({
        ptyId: "pty-fast-blank-snapshot",
        sessionId: "session-fast-blank-snapshot",
        data: "\x1b[29;3HStarting MCP server",
      });
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    const writes = terminal?.write.mock.calls.map(([value]) => String(value)) ?? [];
    expect(writes.some((value) => value.includes("Fast snapshot paint"))).toBe(true);
  });

  it("does not spend the backfill retry budget on replaced timers", async () => {
    const previewMock = window.ade.terminal.preview as unknown as ReturnType<typeof vi.fn>;
    previewMock
      .mockResolvedValueOnce({
        terminalId: "session-churn-blank-snapshot",
        session: null,
        source: "empty",
        snapshot: null,
        transcript: null,
        capturedAt: new Date().toISOString(),
      })
      .mockResolvedValueOnce({
        terminalId: "session-churn-blank-snapshot",
        session: null,
        source: "empty",
        snapshot: null,
        transcript: null,
        capturedAt: new Date().toISOString(),
      })
      .mockResolvedValue({
        terminalId: "session-churn-blank-snapshot",
        session: null,
        source: "snapshot",
        snapshot: {
          version: 1,
          terminalId: "session-churn-blank-snapshot",
          cols: 120,
          rows: 2,
          capturedAt: new Date().toISOString(),
          status: "running",
          runtimeState: "running",
          bufferType: "normal",
          cursorX: 0,
          cursorY: 1,
          baseY: 0,
          viewportY: 0,
          serialized: "",
          visibleRows: [
            {
              text: "Snapshot after timer churn",
              wrapped: false,
              cells: "Snapshot after timer churn".split("").map((text) => ({
                text,
                fg: null,
                bg: null,
                fgMode: "default" as const,
                bgMode: "default" as const,
              })),
            },
          ],
        },
        transcript: null,
        capturedAt: new Date().toISOString(),
      });

    render(<TerminalView ptyId="pty-churn-blank-snapshot" sessionId="session-churn-blank-snapshot" isActive />);
    await flushAnimationFrame();

    const terminal = mockState.terminalInstances.at(-1) as {
      write: ReturnType<typeof vi.fn>;
    } | undefined;
    expect(terminal).toBeTruthy();
    terminal?.write.mockClear();

    for (let index = 0; index < 130; index += 1) {
      for (const listener of mockState.ptyDataListeners) {
        listener({
          ptyId: "pty-churn-blank-snapshot",
          sessionId: "session-churn-blank-snapshot",
          data: `\x1b[29;3HStarting MCP server ${index}`,
        });
      }
    }

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    await flushAllTimers();

    const writes = terminal?.write.mock.calls.map(([value]) => String(value)) ?? [];
    expect(writes.some((value) => value.includes("Snapshot after timer churn"))).toBe(true);
  });

  it("does not mask the terminal while waiting for the first xterm text frame", async () => {
    const view = render(<TerminalView ptyId="pty-startup-loading" sessionId="session-startup-loading" isActive />);
    await flushAnimationFrame();

    expect(view.queryByTestId("terminal-startup-loading")).toBeNull();

    const terminal = mockState.terminalInstances.at(-1) as {
      element: HTMLElement | null;
    } | undefined;
    const rows = document.createElement("div");
    rows.className = "xterm-rows";
    rows.textContent = "Codex is ready";
    terminal?.element?.appendChild(rows);

    await act(async () => {
      await Promise.resolve();
    });

    expect(view.queryByTestId("terminal-startup-loading")).toBeNull();
  });

  it("buffers PTY output for parked runtimes and flushes it on remount", async () => {
    const firstView = render(<TerminalView ptyId="pty-buffered" sessionId="session-buffered" isActive />);
    await flushAllTimers();

    const terminal = mockState.terminalInstances.at(-1) as {
      write: ReturnType<typeof vi.fn>;
    } | undefined;
    expect(terminal).toBeTruthy();

    terminal?.write.mockClear();
    firstView.unmount();

    for (const listener of mockState.ptyDataListeners) {
      listener({ ptyId: "pty-buffered", sessionId: "session-buffered", data: "hello from background\n" });
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(16);
    });
    expect(terminal?.write).not.toHaveBeenCalledWith("hello from background\n");

    terminal?.write.mockClear();
    render(<TerminalView ptyId="pty-buffered" sessionId="session-buffered" isActive />);
    await flushAnimationFrame();
    expect(terminal?.write).toHaveBeenCalledWith("hello from background\n");
  });

  it("keeps parked runtime output buffered while the document is hidden", async () => {
    const rafSpy = vi.spyOn(globalThis, "requestAnimationFrame");
    const firstView = render(<TerminalView ptyId="pty-hidden" sessionId="session-hidden" isActive />);
    await flushAllTimers();

    const terminal = mockState.terminalInstances.at(-1) as {
      write: ReturnType<typeof vi.fn>;
    } | undefined;
    expect(terminal).toBeTruthy();

    firstView.unmount();
    terminal?.write.mockClear();
    rafSpy.mockClear();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });

    for (const listener of mockState.ptyDataListeners) {
      listener({ ptyId: "pty-hidden", sessionId: "session-hidden", data: "buffered while hidden\n" });
    }

    expect(rafSpy).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(16);
    });

    expect(terminal?.write).not.toHaveBeenCalledWith("buffered while hidden\n");
  });

  it("redraws and force-fits a visible terminal when the Work surface is revealed", async () => {
    render(<TerminalView ptyId="pty-revealed" sessionId="session-revealed" isActive />);
    await flushAllTimers();

    const terminal = mockState.terminalInstances.at(-1) as {
      clearTextureAtlas: ReturnType<typeof vi.fn>;
      refresh: ReturnType<typeof vi.fn>;
      focus: ReturnType<typeof vi.fn>;
      scrollToBottom: ReturnType<typeof vi.fn>;
    } | undefined;
    const resizeSpy = (window as any).ade.pty.resize as ReturnType<typeof vi.fn>;
    expect(terminal).toBeTruthy();

    terminal?.clearTextureAtlas.mockClear();
    terminal?.refresh.mockClear();
    terminal?.focus.mockClear();
    terminal?.scrollToBottom.mockClear();
    resizeSpy.mockClear();
    mockState.nextFitDims = { cols: 132, rows: 42 };

    window.dispatchEvent(new Event(WORK_SURFACE_REVEALED_EVENT));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2);
    });

    expect(terminal?.clearTextureAtlas).toHaveBeenCalled();
    expect(terminal?.refresh).toHaveBeenCalled();
    expect(terminal?.focus).toHaveBeenCalled();
    expect(terminal?.scrollToBottom).toHaveBeenCalled();
    expect(resizeSpy).toHaveBeenLastCalledWith({
      ptyId: "pty-revealed",
      cols: 132,
      rows: 42,
    });
  });

  it("replays the full transcript for disposed chat-CLI sessions with scrollback enlarged", async () => {
    const previewMock = window.ade.terminal.preview as unknown as ReturnType<typeof vi.fn>;
    const sessionsGetMock = window.ade.sessions.get as unknown as ReturnType<typeof vi.fn>;
    const readTranscriptTailMock = window.ade.sessions.readTranscriptTail as unknown as ReturnType<typeof vi.fn>;

    sessionsGetMock.mockResolvedValue({
      id: "session-replay",
      laneId: "lane",
      laneName: "Lane",
      ptyId: null,
      tracked: true,
      pinned: false,
      goal: null,
      toolType: "claude-chat",
      title: "claude",
      status: "disposed",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      exitCode: 0,
      transcriptPath: "/tmp/session-replay.log",
      headShaStart: null,
      headShaEnd: null,
      lastOutputPreview: null,
      summary: null,
      runtimeState: "killed",
      resumeCommand: null,
    });
    // terminal.preview must NOT be required for chat-CLI sessions (it throws in
    // production); the replay path should fire purely off sessions.get. Make
    // preview reject here so we'd fail loudly if the code regressed.
    previewMock.mockRejectedValue(new Error("agent chat session, not a terminal"));

    const transcript =
      "\x1b[?1049h\x1b[2J\x1b[31mHello\x1b[0m\nuser: hi\n\x1b[32massistant: hello!\x1b[0m\n\x1b[?1049l";
    readTranscriptTailMock.mockResolvedValue(transcript);

    render(<TerminalView ptyId="pty-replay" sessionId="session-replay" isActive />);
    await flushAllTimers();

    const terminal = mockState.terminalInstances.at(-1) as {
      write: ReturnType<typeof vi.fn>;
      options: Record<string, unknown>;
    } | undefined;
    expect(terminal).toBeTruthy();

    expect(readTranscriptTailMock).toHaveBeenCalledWith({
      sessionId: "session-replay",
      maxBytes: 3_000_000,
      raw: true,
    });
    const writes = terminal?.write.mock.calls.map(([value]) => String(value)) ?? [];
    const replayWrite = writes.find((value) => value.includes("assistant: hello!"));
    expect(replayWrite).toBeTruthy();
    // Alt-screen + clear-screen sequences are stripped; SGR colors and text
    // survive untouched so the replay matches the live ANSI render.
    expect(replayWrite).not.toContain("\x1b[?1049h");
    expect(replayWrite).not.toContain("\x1b[?1049l");
    expect(replayWrite).not.toContain("\x1b[2J");
    expect(replayWrite).toContain("\x1b[31mHello\x1b[0m");
    expect(replayWrite).toContain("\x1b[32massistant: hello!\x1b[0m");
    // Scrollback is enlarged so the entire conversation stays scrollable.
    expect(terminal?.options.scrollback).toBe(30_000);
  });

  it("falls back to snapshot hydration when transcript.read returns no data for a disposed session", async () => {
    const previewMock = window.ade.terminal.preview as unknown as ReturnType<typeof vi.fn>;
    const sessionsGetMock = window.ade.sessions.get as unknown as ReturnType<typeof vi.fn>;
    const readTranscriptTailMock = window.ade.sessions.readTranscriptTail as unknown as ReturnType<typeof vi.fn>;

    sessionsGetMock.mockResolvedValue({
      id: "session-replay-empty",
      laneId: "lane",
      laneName: "Lane",
      ptyId: null,
      tracked: true,
      pinned: false,
      goal: null,
      toolType: "claude",
      title: "claude",
      status: "disposed",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      exitCode: 1,
      transcriptPath: "/tmp/session-replay-empty.log",
      headShaStart: null,
      headShaEnd: null,
      lastOutputPreview: null,
      summary: null,
      runtimeState: "exited",
      resumeCommand: null,
    });
    previewMock.mockResolvedValue({
      terminalId: "session-replay-empty",
      session: {
        terminalId: "session-replay-empty",
        ptyId: null,
        chatSessionId: null,
        laneId: "lane",
        laneName: "Lane",
        title: "claude",
        toolType: "claude",
        goal: null,
        status: "disposed",
        runtimeState: "exited",
        active: false,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        exitCode: 1,
        pid: null,
        resumeCommand: null,
        resumeMetadata: null,
        lastOutputPreview: null,
        summary: null,
      },
      source: "snapshot",
      snapshot: {
        version: 1,
        terminalId: "session-replay-empty",
        cols: 12,
        rows: 1,
        capturedAt: new Date().toISOString(),
        status: "disposed",
        runtimeState: "exited",
        bufferType: "normal",
        cursorX: 0,
        cursorY: 0,
        baseY: 0,
        viewportY: 0,
        serialized: "",
        visibleRows: [
          {
            text: "Snapshot tail",
            wrapped: false,
            cells: "Snapshot tail".split("").map((text) => ({
              text,
              fg: null,
              bg: null,
              fgMode: "default" as const,
              bgMode: "default" as const,
            })),
          },
        ],
      },
      transcript: null,
      capturedAt: new Date().toISOString(),
    });
    // Empty transcript on the replay path forces the snapshot fallback.
    readTranscriptTailMock.mockResolvedValue("");

    render(<TerminalView ptyId="pty-replay-empty" sessionId="session-replay-empty" isActive />);
    await flushAllTimers();

    const terminal = mockState.terminalInstances.at(-1) as {
      write: ReturnType<typeof vi.fn>;
      options: Record<string, unknown>;
    } | undefined;
    const writes = terminal?.write.mock.calls.map(([value]) => String(value)) ?? [];
    expect(writes.some((value) => value.includes("Snapshot tail"))).toBe(true);
    // No transcript = no replay-mode scrollback bump.
    expect(terminal?.options.scrollback).toBe(10_000);
  });

  it("preserves live-session behavior and does not trigger replay transcript reads while the PTY is running", async () => {
    const previewMock = window.ade.terminal.preview as unknown as ReturnType<typeof vi.fn>;
    const sessionsGetMock = window.ade.sessions.get as unknown as ReturnType<typeof vi.fn>;
    const readTranscriptTailMock = window.ade.sessions.readTranscriptTail as unknown as ReturnType<typeof vi.fn>;

    sessionsGetMock.mockResolvedValue({
      id: "session-live-running",
      laneId: "lane",
      laneName: "Lane",
      ptyId: "pty-live-running",
      tracked: true,
      pinned: false,
      goal: null,
      toolType: "claude",
      title: "claude",
      status: "running",
      startedAt: new Date().toISOString(),
      endedAt: null,
      exitCode: null,
      transcriptPath: "/tmp/session-live-running.log",
      headShaStart: null,
      headShaEnd: null,
      lastOutputPreview: null,
      summary: null,
      runtimeState: "running",
      resumeCommand: null,
    });
    previewMock.mockResolvedValue({
      terminalId: "session-live-running",
      session: {
        terminalId: "session-live-running",
        ptyId: "pty-live-running",
        chatSessionId: null,
        laneId: "lane",
        laneName: "Lane",
        title: "claude",
        toolType: "claude",
        goal: null,
        status: "running",
        runtimeState: "running",
        active: true,
        startedAt: new Date().toISOString(),
        endedAt: null,
        exitCode: null,
        pid: 1234,
        resumeCommand: null,
        resumeMetadata: null,
        lastOutputPreview: null,
        summary: null,
      },
      source: "empty",
      snapshot: null,
      transcript: null,
      capturedAt: new Date().toISOString(),
    });

    render(<TerminalView ptyId="pty-live-running" sessionId="session-live-running" isActive />);
    await flushAllTimers();

    // No call to readTranscriptTail with the replay-sized cap (3 MB) means the
    // replay path stayed off. Hydration backfills may still call it with the
    // ordinary HYDRATE_TAIL_BYTES cap, so we assert by maxBytes.
    const replaySized = readTranscriptTailMock.mock.calls.some(
      ([call]) => (call as { maxBytes?: number })?.maxBytes === 3_000_000,
    );
    expect(replaySized).toBe(false);
  });
});

describe("stripFullScreenRedrawSequences", () => {
  it("strips alt-screen enter/leave sequences (1049 + the older 47 variant)", () => {
    expect(
      stripFullScreenRedrawSequences("before\x1b[?1049hmiddle\x1b[?1049lafter"),
    ).toBe("beforemiddleafter");
    expect(
      stripFullScreenRedrawSequences("\x1b[?47h<TUI body>\x1b[?47l"),
    ).toBe("<TUI body>");
  });

  it("strips clear-screen / hard-reset sequences that would erase prior content", () => {
    expect(stripFullScreenRedrawSequences("keep\x1b[2Jdrop")).toBe("keepdrop");
    expect(stripFullScreenRedrawSequences("keep\x1b[3Jdrop")).toBe("keepdrop");
    expect(stripFullScreenRedrawSequences("keep\x1bcdrop")).toBe("keepdrop");
    // The compound \x1b[H\x1b[2J ("home + erase") is stripped wholesale so a
    // bare cursor-home doesn't linger and snap subsequent output to row 1.
    expect(stripFullScreenRedrawSequences("keep\x1b[H\x1b[2Jdrop")).toBe(
      "keepdrop",
    );
    // A bare cursor-home outside the compound is preserved (general layout).
    expect(stripFullScreenRedrawSequences("keep\x1b[Hdrop")).toBe("keep\x1b[Hdrop");
  });

  it("preserves ordinary ANSI color (SGR) and OSC sequences verbatim", () => {
    const input = "\x1b[31mred\x1b[0m \x1b[1;38;2;200;100;50mtrue-color\x1b[0m";
    expect(stripFullScreenRedrawSequences(input)).toBe(input);

    const osc = "\x1b]0;title text\x07rest of line";
    expect(stripFullScreenRedrawSequences(osc)).toBe(osc);
  });

  it("preserves cursor-position sequences so per-line layout is unchanged", () => {
    const input = "\x1b[5;10HHello\x1b[7;1Hsecond line";
    expect(stripFullScreenRedrawSequences(input)).toBe(input);
  });

  it("returns the empty string unchanged", () => {
    expect(stripFullScreenRedrawSequences("")).toBe("");
  });
});
