/* @vitest-environment jsdom */

import React from "react";
import { act, render, cleanup } from "@testing-library/react";
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
    resize = vi.fn((cols: number, rows: number) => {
      this.cols = cols;
      this.rows = rows;
    });
    scrollToBottom = vi.fn();
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
  disposeTerminalRuntimesForProjectChange,
  getTerminalRuntimeSnapshot,
} from "./TerminalView";

function installWindowAde() {
  (window as any).ade = {
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
  });

  afterEach(() => {
    cleanup();
    delete (window as any).ade;
    vi.useRealTimers();
  });

  it("fits to the container and resizes the PTY when the fit result is valid", async () => {
    render(<TerminalView ptyId="pty-valid" sessionId="session-valid" isActive />);
    await flushAllTimers();

    const runtime = getTerminalRuntimeSnapshot("session-valid");
    expect(runtime?.renderer).toBe("webgl");
    expect(runtime?.health.fitRecoveries).toBe(0);
    expect((window as any).ade.pty.resize).toHaveBeenCalledWith({
      ptyId: "pty-valid",
      cols: 120,
      rows: 40,
    });
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

  it("falls back to the DOM renderer when webgl initialization fails", async () => {
    mockState.shouldThrowWebglAddon = true;
    const previousFallbacks = getTerminalRuntimeSnapshot("session-dom")?.health.rendererFallbacks ?? 0;

    render(<TerminalView ptyId="pty-dom" sessionId="session-dom" isActive />);
    // initRendererChain is fire-and-forget with a dynamic import inside.
    // Multiple flush cycles are needed for the microtask chain to fully settle:
    // 1) timer flush kicks off the render + initRendererChain
    // 2) microtask flush lets the dynamic import resolve
    // 3) second timer flush lets the post-import code run
    for (let i = 0; i < 200; i++) {
      await act(async () => {});
      await (vi as any).dynamicImportSettled?.();
      await flushAllTimers();
      const runtime = getTerminalRuntimeSnapshot("session-dom");
      if (runtime?.renderer === "dom" && runtime.health.rendererFallbacks > previousFallbacks) {
        break;
      }
    }

    const runtime = getTerminalRuntimeSnapshot("session-dom");
    expect(runtime?.renderer).toBe("dom");
    expect(runtime?.health.rendererFallbacks).toBeGreaterThan(previousFallbacks);
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
    expect(firstTerminal?.write).toHaveBeenCalledWith("still running in project a\n");
    expect(firstTerminal?.dispose).not.toHaveBeenCalled();

    mockState.projectRoot = "/project/a";
    mockState.projectRevision += 1;

    render(<TerminalView ptyId="pty-switch" sessionId="session-switch" isActive />);
    await flushAllTimers();

    const secondTerminal = mockState.terminalInstances.at(-1) as {
      dispose: ReturnType<typeof vi.fn>;
    } | undefined;
    expect(mockState.terminalInstances).toHaveLength(1);
    expect(secondTerminal).toBe(firstTerminal);
    expect(firstTerminal?.dispose).not.toHaveBeenCalled();
    expect(readTranscriptTailMock.mock.calls).toHaveLength(1);
    expect(getTerminalRuntimeSnapshot("session-switch")).not.toBeNull();
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

  it("writes PTY output into the parked runtime so the terminal state stays current", async () => {
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
    // xterm.write is safe on a parked runtime (host is detached but the
    // instance still owns a valid internal buffer). Writing through while
    // parked keeps the terminal state in sync so switching back shows the
    // latest output instead of a stale snapshot.
    expect(terminal?.write).toHaveBeenCalledWith("hello from background\n");

    terminal?.write.mockClear();
    render(<TerminalView ptyId="pty-buffered" sessionId="session-buffered" isActive />);
    await flushAnimationFrame();
    // Remount should not duplicate the write — the data was already applied
    // via the parked-runtime path, so no further synchronous flush is needed.
    expect(terminal?.write).not.toHaveBeenCalledWith("hello from background\n");
  });

  it("uses a timer flush for parked runtimes while the document is hidden", async () => {
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

    expect(terminal?.write).toHaveBeenCalledWith("buffered while hidden\n");
  });
});
